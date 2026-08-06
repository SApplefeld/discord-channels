// The relay's client for the broker, over the same loopback listener the hooks post to.
//
// Held apart from the MCP wiring so it can be driven against a real HTTP server in a test: nothing
// here knows what a channel notification is, and nothing in the server wiring knows what the broker
// speaks.
import http from "node:http";
import { RELAY_READ_TIMEOUT_MS } from "../broker/config.ts";
import type { PermissionVerdict } from "./permission.ts";

export type InboundHandler = (text: string, chatId: string) => void;

/** The operator's answer to one tool prompt, as it arrives down the stream. */
export type VerdictHandler = (verdict: PermissionVerdict) => void;

/** What the broker reports about one reply. `sent` is the only success. */
export type ReplyStatus = "sent" | "no-session" | "no-thread" | "failed";

export type BrokerClientOptions = {
  port: number;
  /** Identifies which Claude Code process this pipe belongs to. It authorizes nothing. */
  processToken: string;
  onMessage: InboundHandler;
  /** Left unset by a relay that declares no permission capability, which then hears no verdicts. */
  onVerdict?: VerdictHandler;
  log?: (message: string) => void;
  /** How long to wait before reconnecting a dropped stream. Doubles up to the ceiling. */
  reconnectDelayMs?: number;
  /**
   * A stream that has not delivered so much as a heartbeat for this long is presumed dead and
   * reconnected. The default is shared with the broker, which clamps its heartbeat below it: the
   * two run in different processes and cannot otherwise see each other.
   */
  readTimeoutMs?: number;
  /** How long a reply may take before it is reported as failed rather than awaited forever. */
  replyTimeoutMs?: number;
};

export type BrokerClient = {
  start: () => void;
  stop: () => void;
  reply: (text: string) => Promise<{ status: ReplyStatus; error?: string }>;
  /**
   * Hands the broker one permission prompt to put in front of the operator. It resolves when the
   * broker has taken the prompt, not when the operator answers: the answer arrives whenever they
   * give it, down the stream, and holding a socket open for it would outlast the read timeout.
   */
  permissionRequest: (request: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }) => Promise<boolean>;
};

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_REPLY_TIMEOUT_MS = 15_000;

/** Bounded so a broker that never sends a newline cannot grow this without limit. */
const MAX_LINE_BYTES = 64 * 1024;

export function createBrokerClient(options: BrokerClientOptions): BrokerClient {
  const log = options.log ?? ((): void => {});
  const baseDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const readTimeoutMs = options.readTimeoutMs ?? RELAY_READ_TIMEOUT_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  let stopped = false;
  let delay = baseDelay;
  let request: http.ClientRequest | null = null;
  let retry: NodeJS.Timeout | null = null;
  /**
   * Issued by the broker on the stream this relay holds, and required on every reply. A process
   * token is inherited by every subprocess a session spawns, so it is not standing to write into
   * the operator's thread; holding the pipe is, and this is the proof of that.
   */
  let replyKey: string | null = null;

  function handle(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // A broker speaking something this does not understand is not a reason to drop the pipe.
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const fields = event as Record<string, unknown>;
    if (fields.type === "hello") {
      if (typeof fields.replyKey === "string") replyKey = fields.replyKey;
      // The backoff resets here and nowhere else. A refused stream is a 200 that ends immediately,
      // so resetting on the status code alone would make a relay that lost the pipe race retry
      // every second for the life of the session, writing a broker log line each time.
      delay = baseDelay;
      return;
    }
    if (fields.type === "refused") {
      // Another pipe already holds this process token. Refusing rather than promoting is what stops
      // a subprocess of this session from taking over the operator's channel, so the honest thing
      // is to stay quiet rather than to keep racing for it.
      log(`relay: the broker refused the stream (${String(fields.reason ?? "no reason given")})`);
      return;
    }
    if (fields.type === "permission") {
      // The verdict rides the stream rather than a response, and the stream is the one thing only
      // the holder of this pipe can read. A subprocess that scraped the process token out of its
      // environment has no way onto it, so it cannot answer a prompt on the operator's behalf.
      if (typeof fields.requestId !== "string") return;
      if (fields.behavior !== "allow" && fields.behavior !== "deny") return;
      options.onVerdict?.({ requestId: fields.requestId, behavior: fields.behavior });
      return;
    }
    if (fields.type !== "message") return;
    if (typeof fields.text !== "string" || typeof fields.chatId !== "string") return;
    options.onMessage(fields.text, fields.chatId);
  }

  function reconnect(): void {
    if (stopped || retry !== null) return;
    replyKey = null;
    // The broker is restarted at logon and can be down for any part of a twelve-hour session. A
    // relay that gave up would leave the session running and permanently unreachable, with its
    // status card still ticking, which is the exact failure the card exists to make visible.
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function connect(): void {
    if (stopped) return;
    let buffer = "";
    const pending = http.get(
      {
        host: "127.0.0.1",
        port: options.port,
        path: "/relay/stream",
        headers: { "x-channel-process-token": options.processToken },
      },
      (response) => {
        if (response.statusCode !== 200) {
          // Drained so the socket can be reused, and with a listener attached: an error on a
          // response nobody is listening to is an unhandled 'error' event, which is fatal.
          response.on("error", () => {});
          response.resume();
          log(`relay: the broker refused the stream with HTTP ${String(response.statusCode)}`);
          reconnect();
          return;
        }
        // Any byte from the broker, a heartbeat included, proves the pipe: the timer is reset on
        // data rather than on a parsed message, so a quiet session does not look like a dead one.
        response.setTimeout(readTimeoutMs, () => response.destroy());
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let cut = buffer.indexOf("\n");
          while (cut !== -1) {
            handle(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
          }
          if (buffer.length > MAX_LINE_BYTES) buffer = "";
        });
        response.on("end", reconnect);
        response.on("close", reconnect);
        response.on("error", reconnect);
      },
    );
    request = pending;
    pending.on("error", () => {
      // The broker is not listening. Silent by design: it is optional, and a relay that logged on
      // every retry would fill a session's stderr for the life of the process.
      reconnect();
    });
  }

  /**
   * One POST to the broker, carrying the pipe's reply key. Both routes speak this shape and share
   * it, so a settle path proved on one is the settle path on the other.
   *
   * The bodies differ only in their fields. Neither carries a chat_id: the broker routes by
   * session, and a field that does not exist on the wire cannot be honored by accident later.
   */
  function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: string; error?: string }> {
    if (replyKey === null) {
      // No pipe, so no standing to write. Reported locally rather than attempted, because the
      // broker would refuse it and the model is waiting on the answer either way.
      return Promise.resolve({ status: "failed", error: "this relay holds no channel stream" });
    }
    const key = replyKey;

    return new Promise((resolve) => {
      // Settled at most once. Node reports a peer that dies mid-body through 'aborted', 'error',
      // or 'close' and never through 'end', so a promise resolved only on 'end' would leave the
      // tool call awaiting it forever, and the turn parked with it.
      let settled = false;
      const finish = (result: { status: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const pending = http.request(
        {
          host: "127.0.0.1",
          port: options.port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": payload.length,
            "x-channel-process-token": options.processToken,
            "x-channel-reply-key": key,
          },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            raw += chunk;
          });
          response.on("error", (error) => finish({ status: "failed", error: error.message }));
          response.on("aborted", () => finish({ status: "failed", error: "the broker hung up" }));
          response.on("close", () =>
            finish({ status: "failed", error: "the broker closed the connection" }),
          );
          response.on("end", () => {
            try {
              const parsed = JSON.parse(raw) as { status?: unknown; error?: unknown };
              finish({
                status: typeof parsed.status === "string" ? parsed.status : "failed",
                error: typeof parsed.error === "string" ? parsed.error : undefined,
              });
            } catch {
              finish({ status: "failed", error: "the broker's answer was not JSON" });
            }
          });
        },
      );
      // Covers the case none of the events above reach: a peer that accepted the connection and
      // then went silent forever without closing it.
      pending.setTimeout(replyTimeoutMs, () => pending.destroy());
      pending.on("error", (error) => finish({ status: "failed", error: error.message }));
      pending.on("close", () => finish({ status: "failed", error: "the request was not answered" }));
      pending.end(payload);
    });
  }

  return {
    start: connect,

    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      replyKey = null;
      request?.destroy();
      request = null;
    },

    async reply(text) {
      const answer = await post("/relay/reply", { text });
      return { status: answer.status as ReplyStatus, error: answer.error };
    },

    async permissionRequest(request) {
      const answer = await post("/relay/permission", {
        request_id: request.requestId,
        tool_name: request.toolName,
        description: request.description,
        input_preview: request.inputPreview,
      });
      return answer.status === "received";
    },
  };
}
