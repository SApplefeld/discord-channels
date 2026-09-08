// The DSH bridge: the MCP channel server that runs as a stdio child of one Claude Code process and
// drives a DeepSeek Harness worker on its behalf.
//
// Toward Claude it is two things at once: a tool server, and a channel that pushes
// `notifications/claude/channel` events into the session unprompted. Toward DSH it is an SDK client
// owning one runtime child. The session it belongs to is never named to it, exactly as for the
// relay: a channel is a child of the *process*, and a `/clear` mints a new session underneath it
// without its knowing, which is why nothing here holds a session identity of Claude's.
//
// Nothing is written to stdout: stdout is the protocol pipe. Diagnostics go to stderr.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runDirectly } from "../broker/entrypoint.ts";
import { MODEL, PROVIDER } from "./env.ts";
import { Bridge, DSH_HOME, defaultScope, defaultStateFile, dshRuntimeSpec } from "./harness.ts";
import type { StatusReport } from "./harness.ts";
import {
  BUSY_TOOL_NAME,
  INSTRUCTIONS,
  KILL_TOOL_NAME,
  MAX_REFUSAL_LENGTH,
  MAX_TAIL_COUNT,
  PROMPT_TOOL_NAME,
  STATUS_TOOL_NAME,
  TAIL_TOOL_NAME,
  TOOLS,
  untrustedLine,
} from "./protocol.ts";

/**
 * The most of a notification's method name that is written, in code points, and the most distinct
 * names one bridge process names at all.
 *
 * A line's length is never someone else's to choose, which is why the name is cut. The count bound
 * is what keeps the set below from being a map with nothing to remove it: past it the seam goes
 * quiet.
 */
export const MAX_METHOD_LENGTH = 120;
export const MAX_NAMED_METHODS = 32;

/**
 * Names every notification Claude Code sends that no registered handler claims, once each.
 *
 * What this channel carries is decided by Claude Code, not by this file, so a method arriving here
 * is one this bridge does not implement, and this line is the only place a capability it could be
 * answering and is not would ever show up.
 *
 * The method name is the whole record. A notification's params carry conversation content and this
 * line is written to a log, so nothing here reads them. Once per distinct name, because a
 * notification that repeats every turn would otherwise restate what its first line established.
 */
export function unhandledNotifications(
  write: (line: string) => void,
): (notification: { method: string }) => Promise<void> {
  const named = new Set<string>();
  return (notification) => {
    // Neutralized as every other foreign line in this tree is, and not only cut: the name is
    // Claude Code's to choose and this line lands in its debug log, where a newline inside the name
    // would write a second line of its author's composition.
    const method = untrustedLine(notification.method, MAX_METHOD_LENGTH);
    if (named.has(method) || named.size >= MAX_NAMED_METHODS) return Promise.resolve();
    named.add(method);
    write(`dsh-bridge: unhandled notification ${method}\n`);
    return Promise.resolve();
  };
}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/** One session's status as lines, which is the whole of what the model reads of it. */
export function statusLines(report: StatusReport): string[] {
  // `session` and `cwd` are neutralized where they reach the model: the name is the caller's own and
  // the workspace was read back from a state file anything running as this user can write, so a
  // forged harness tag in either would otherwise reach the session inside this tool result. The
  // session id is validated against the runtime's shape when the record is read, and the state, the
  // flags and the log counts are this bridge's own, so none of those is a route for the worker's text.
  const lines = [
    `session: ${untrustedLine(report.session)}`,
    `state: ${report.state}`,
    `dsh_session: ${report.sessionId}`,
    `cwd: ${untrustedLine(report.cwd)}`,
    `in_flight: ${String(report.inFlight)}`,
    `turn: ${String(report.turn)}`,
    `last_notification: ${report.lastNotification ?? "(none)"}`,
  ];
  if (report.log === undefined) {
    // Two reasons the counts are missing, told apart because the model's next move differs: with no
    // log yet there is nothing to read, and with a log that was not read there is dsh_tail. The
    // reason is the reader's own sentence or a system error code, and is neutralized at this exit as
    // every refusal is, at the refusal's bound rather than a tail line's.
    lines.push(
      report.logUnread === undefined
        ? "log: (no session log on disk yet)"
        : `log: (on disk, not read for counts: ${untrustedLine(report.logUnread, MAX_REFUSAL_LENGTH)})`,
    );
    return lines;
  }
  lines.push(
    `log_events: ${String(report.log.events)}`,
    `log_turns: ${String(report.log.turns)}`,
    `log_steps: ${String(report.log.steps)}`,
    `log_compactions: ${String(report.log.compactions)}`,
    `log_last_event: ${report.log.lastEventType}`,
    // The three permission knobs are written before the runtime's first notification interval, so
    // they never reach a subscriber and the log is the only place they can be read at all. What the
    // log records is the worker's own runtime's account of its confinement, written by that
    // unsandboxed runtime, rather than an authority over it; the operator can change the knobs in
    // the web UI at any time.
    `permission_preset: ${report.log.permission.preset ?? "(unrecorded)"}`,
    `sandbox_mode: ${report.log.permission.sandbox ?? "(unrecorded)"}`,
    `approval_policy: ${report.log.permission.approval ?? "(unrecorded)"}`,
  );
  // Said only when there is something to say: the counts above are of the whole log unless the
  // reader stopped short, and a reader that stopped short is reporting a prefix, which is a number
  // that is short rather than one that is wrong only if the model is told so.
  if (report.log.unreadBytes > 0) {
    lines.push(`log_unread_bytes: ${String(report.log.unreadBytes)} (the log's tail could not be read as frames, so the counts above cover the readable part)`);
  }
  return lines;
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = Object.hasOwn(args, key) ? args[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** One tool call, answered from the bridge. Held apart from the wiring so it can be driven by test. */
export async function callTool(
  bridge: Bridge,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const session = stringArgument(args, "session");
  try {
    if (name === PROMPT_TOOL_NAME) {
      const body = stringArgument(args, "text");
      if (session === undefined || body === undefined) return failure("dsh_prompt needs a session and a text.");
      const cwd = stringArgument(args, "cwd");
      // A present `cwd` that is not a string is a mistake rather than an absence. Passed on as
      // undefined it would fall through to the remembered workspace, so a caller that meant to
      // move the worker would be answered by the place it was already running.
      if (Object.hasOwn(args, "cwd") && args.cwd !== undefined && cwd === undefined) {
        return failure("dsh_prompt's cwd must be a string naming an absolute local path.");
      }
      const receipt = await bridge.prompt({ session, text: body, ...(cwd === undefined ? {} : { cwd }) });
      // The name is the caller's own and is neutralized where it reaches the model, as every other
      // tool result that carries one does.
      return text(
        [
          "accepted, the worker has the task and its answer arrives as a channel event",
          `session: ${untrustedLine(session)}`,
          `dsh_session: ${receipt.sessionId}`,
          `turn: ${String(receipt.turn)}`,
        ].join("\n"),
      );
    }
    if (name === STATUS_TOOL_NAME) {
      if (session === undefined) return failure("dsh_status needs a session.");
      return text(statusLines(bridge.status(session)).join("\n"));
    }
    if (name === BUSY_TOOL_NAME) {
      const busy = bridge.busy();
      // Session names are the caller's own, so they are neutralized where they reach the model.
      return text(`busy: ${String(busy.busy)}\nsessions: ${busy.sessions.map((name) => untrustedLine(name)).join(", ") || "(none)"}`);
    }
    if (name === TAIL_TOOL_NAME) {
      if (session === undefined) return failure("dsh_tail needs a session.");
      // `count` is a number off the wire, refused at zero and below, floored to one and clamped
      // above the ceiling. Zero and a negative are refused rather than defaulted, because a model
      // that asked for none and got forty was answered with a number it never named. An infinite
      // one passes every check that
      // asks whether it is a positive number, survives `Math.floor`, and would return the whole log
      // into the model's context in place of the tail it asked for; a fraction below one floors to
      // zero, which is the reader's counts-only mode, and the model would be told that no event
      // matched a log full of events. So the floor is one and the ceiling is the constant.
      const given = Object.hasOwn(args, "count") ? args.count : undefined;
      if (given !== undefined && (typeof given !== "number" || Number.isNaN(given) || given <= 0)) {
        return failure(`dsh_tail's count must be a number from 1 to ${String(MAX_TAIL_COUNT)}; a larger one is clamped to ${String(MAX_TAIL_COUNT)}.`);
      }
      const count = given === undefined ? undefined : Math.min(Math.max(Math.floor(given), 1), MAX_TAIL_COUNT);
      // A present `kinds` that is not an array is a mistake rather than an absence. Read as absent
      // it would apply the default filter, and a caller that wrote a list would be answered with
      // events it asked not to see; refused, like a `cwd` that is not a string.
      const givenKinds = Object.hasOwn(args, "kinds") ? args.kinds : undefined;
      if (givenKinds !== undefined && !Array.isArray(givenKinds)) {
        return failure("dsh_tail's kinds must be an array of event types; omit it for the default filter.");
      }
      // An allow-list with nothing on it admits nothing, so every event would be dropped and the
      // model told that nothing matched a log full of events. Refused rather than read as absent:
      // a list the caller wrote and this bridge quietly replaced would answer with events the caller
      // asked not to see.
      const kinds = Array.isArray(givenKinds)
        ? givenKinds.filter((kind): kind is string => typeof kind === "string")
        : undefined;
      if (kinds !== undefined && kinds.length === 0) {
        return failure("dsh_tail's kinds must name at least one event type; omit it for the default filter.");
      }
      const lines = bridge.tail(session, count, kinds);
      return text(lines.length === 0 ? "(no events matched)" : lines.join("\n"));
    }
    if (name === KILL_TOOL_NAME) {
      if (session === undefined) return failure("dsh_kill needs a session.");
      const killed = await bridge.kill(session);
      return text(
        killed.killed.length === 0
          ? "The worker is stopped. Its conversation survives on disk; the next dsh_prompt resumes it."
          : `The worker is stopped and ${String(killed.killed.length)} turn(s) in flight were reported as killed: ${killed.killed.map((name) => untrustedLine(name)).join(", ")}.`,
      );
    }
    // The one exit in this dispatch that returns rather than throws, so it does not pass the
    // catch-all below and neutralizes the wire's tool name itself, at the same bound.
    return failure(untrustedLine(`Unknown tool ${name}.`, MAX_REFUSAL_LENGTH));
  } catch (error) {
    // The catch-all under every tool. A message built from stored or caller-chosen text reaches the
    // model as a tool result, so it is neutralized here even though each refusal already quotes its
    // own untrusted parts: this is the one exit that does not know what it is carrying. The bound
    // is the refusal's own rather than a tail line's, since the sentences are the bridge's and the
    // longest of them would lose the words saying what to do next at the line bound.
    return failure(untrustedLine(error instanceof Error ? error.message : String(error), MAX_REFUSAL_LENGTH));
  }
}

export async function startBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = new Server(
    { name: "dsh-bridge", version: "0.1.0" },
    {
      // No `claude/channel/permission`: the events this channel carries are a machine's output, and
      // a permission relay on it would let the worker's text approve Claude's tool calls.
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const bridge = new Bridge({
    stateFile: defaultStateFile(env),
    // The state file is one path per machine and session names are the model's to choose, so the
    // scope is what keeps this project's `builder` from being another project's.
    scope: defaultScope(),
    home: DSH_HOME,
    runtime: dshRuntimeSpec(DSH_HOME, env),
    provider: PROVIDER,
    model: MODEL,
    push: (notification) => {
      // Fire and forget: a finished turn is not something the worker waits on, and a failed write
      // must not take the pipe down.
      // The error's text is the SDK's or the pipe's and lands in Claude Code's debug log, so it is
      // held to one line as every other foreign line is.
      void server.notification(notification).catch((error: unknown) => {
        process.stderr.write(`dsh-bridge: could not deliver a turn: ${untrustedLine(String(error))}\n`);
      });
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });

  // Claude Code probes a stdio server's protocol revision by starting it, closing it, and respawning
  // it pinned to the legacy one. The probed process never initializes, so this flag is what keeps a
  // probe from ever spawning a DSH runtime it would then abandon.
  let initialized = false;
  server.oninitialized = (): void => {
    initialized = true;
  };
  server.onclose = (): void => {
    // The worker dies with the session that asked for it. A turn in flight is lost as a turn and
    // kept as a log: there is no session left to push its event into.
    void bridge.close().catch((error: unknown) => {
      process.stderr.write(`dsh-bridge: the worker did not shut down cleanly: ${untrustedLine(String(error))}\n`);
    });
  };

  server.fallbackNotificationHandler = unhandledNotifications((line) => process.stderr.write(line));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!initialized) return failure("This connection is not initialized.");
    return callTool(bridge, request.params.name, request.params.arguments ?? {});
  });

  await server.connect(new StdioServerTransport());
}

// Claude Code starts this as a child process. The guard is what lets a test import the module
// without it seizing stdio, which is the MCP pipe.
if (runDirectly(import.meta.url)) {
  await startBridge();
}
