// The relay: the MCP channel server that runs as a stdio child of one Claude Code process.
//
// A channel server is never told what session it belongs to. The protocol hands it `content` and a
// `meta` bag it authors itself, and nothing anywhere in it carries a session ID or a name; a
// channel is a child of the *process*, so a `/clear` mints a new session underneath it without its
// knowing. That is the whole reason identity travels over hooks instead, and the reason this
// process joins the broker by the CHANNEL_PROCESS_TOKEN it inherited from the launch wrapper.
//
// Nothing is written to stdout: stdout is the protocol pipe. Diagnostics go to stderr.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_PORT } from "../broker/config.ts";
import { runDirectly } from "../broker/entrypoint.ts";
import { createBrokerClient } from "./broker.ts";
import { INSTRUCTIONS, REPLY_TOOL, REPLY_TOOL_NAME, channelNotification } from "./protocol.ts";

/** What the model is told when a reply had nowhere to land. */
const REPLY_FAILURES: Record<string, string> = {
  // Either the SessionStart hook has not announced this process yet, or the session it announced
  // has already ended. Both mean the broker holds no session for this relay to speak for.
  "no-session": "Not sent: the broker holds no live session for this process, so there is no thread.",
  "no-thread": "Not sent: this session's Discord thread has not been opened yet.",
  failed: "Not sent: the broker could not post the message.",
};

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.CHANNEL_BROKER_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

export async function startRelay(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const processToken = env.CHANNEL_PROCESS_TOKEN?.trim();
  if (!processToken) {
    // A session started without the launch wrapper is not being watched. The server still runs, so
    // the reply tool exists and reports honestly rather than the session failing to start.
    process.stderr.write("relay: no CHANNEL_PROCESS_TOKEN, this session is not being watched\n");
  }

  const server = new Server(
    { name: "channel-relay", version: "0.1.0" },
    {
      // `claude/channel` alone. The permission capability is declared with its handler, in Section
      // 6: Claude Code routes a permission request only at a server declaring both, so declaring it
      // early would aim prompts at a server that drops them, and a dropped prompt parks the session.
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const broker = createBrokerClient({
    port: port(env),
    processToken: processToken ?? "",
    onMessage: (text, chatId) => {
      // Fire and forget: an inbound message is not something the broker waits on, and a failed
      // write must not take the pipe down.
      void server.notification(channelNotification(text, chatId)).catch((error: unknown) => {
        process.stderr.write(`relay: could not deliver a channel message: ${String(error)}\n`);
      });
    },
    log: (message) => process.stderr.write(`${message}\n`),
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [REPLY_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== REPLY_TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool ${request.params.name}.` }], isError: true };
    }
    const message = request.params.arguments?.message;
    if (typeof message !== "string" || message.trim() === "") {
      return { content: [{ type: "text", text: "reply needs a non-empty message." }], isError: true };
    }
    if (!processToken) {
      // Answered here rather than by opening a socket the broker would have nothing to match: this
      // session was started without the launch wrapper, so no thread exists anywhere for it.
      return {
        content: [
          {
            type: "text",
            text: "Not sent: this session was not started through the launch wrapper, so it has no Discord thread.",
          },
        ],
        isError: true,
      };
    }
    // Whatever chat_id was passed is left where it is. The broker routes by session, which is what
    // lets an unprompted reply, sent with no chat_id at all, still reach the right thread.
    const result = await broker.reply(message);
    if (result.status === "sent") {
      return { content: [{ type: "text", text: "Sent to the operator's thread." }] };
    }
    const text = REPLY_FAILURES[result.status] ?? REPLY_FAILURES.failed;
    return { content: [{ type: "text", text }], isError: true };
  });

  // The stream is opened only once the connection is initialized. Claude Code probes a stdio
  // server's protocol revision by starting it, closing it, and respawning it pinned to the legacy
  // one; the probed process never gets this far, so it never registers a pipe whose closing the
  // broker would read as the session dying.
  server.oninitialized = (): void => {
    if (processToken) broker.start();
  };
  server.onclose = (): void => {
    broker.stop();
  };

  await server.connect(new StdioServerTransport());
}

// Claude Code starts this as a child process. The guard is what lets a test import the module
// without it seizing stdio, which is the MCP pipe.
if (runDirectly(import.meta.url)) {
  await startRelay();
}
