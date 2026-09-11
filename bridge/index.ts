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
import {
  Bridge,
  DSH_HOME,
  defaultScope,
  defaultStateFile,
  dshRuntimeSpec,
  insideStateDirectory,
  recordFilePath,
  stateFault,
  stateReadFault,
} from "./harness.ts";
import type { StatusReport } from "./harness.ts";
import { DEFAULT_COUNTERPARTY, DEFAULT_PARTY, ROTATE_FRESH_FILE_FAILED_CODE, RecordWriter, partyName, rotateRecord } from "./record.ts";
import {
  BUSY_TOOL_NAME,
  INSTRUCTIONS,
  KILL_TOOL_NAME,
  MAX_PARTY_NAME,
  MAX_REFUSAL_LENGTH,
  MAX_TAIL_COUNT,
  PROMPT_TOOL_NAME,
  RECORD_ROTATE_TOOL_NAME,
  STATUS_TOOL_NAME,
  TAIL_TOOL_NAME,
  TOOLS,
  isRecord,
  untrustedLine,
} from "./protocol.ts";
import type { TurnKind } from "./protocol.ts";

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

/**
 * What `callTool` needs to keep the record file: where this bridge's session map lives, and the one
 * writer every dsh_prompt and every turn-end append through.
 *
 * Optional on `callTool` itself, so a caller with nothing to record (every existing test among them)
 * calls it exactly as before; `startBridge` is the one caller that always supplies it.
 */
export interface RecordContext {
  readonly stateFile: string;
  readonly writer: RecordWriter;
  readonly log: (line: string) => void;
}

/** The real clock, as an ISO 8601 UTC string: what a record section's header names. */
function now(): string {
  return new Date().toISOString();
}

/**
 * What a finished turn does to the record: append the counterparty's section through the writer the
 * turn's own party section, if any, was registered on.
 *
 * The one line `startBridge` wires `Bridge`'s `onTurnEnd` to, pulled out so a test can drive the real
 * wiring between the two without also standing up the MCP server that wire sits inside: a test that
 * instead rebuilt this line by hand would still pass were `startBridge`'s own copy to drop back to
 * carrying `text` alone, since it would never touch the code the drop happened in.
 */
export function recordTurnEnd(
  records: RecordContext,
  turn: { readonly session: string; readonly text: string; readonly kind: TurnKind; readonly finishReason: string; readonly accepted: boolean },
): void {
  records.writer.noteTurnEnd(turn.session, turn.text, now, turn.kind, turn.finishReason, turn.accepted);
}

/**
 * The system error code alone, or the message when there is none, never the whole of an unknown
 * error's detail.
 *
 * A Node filesystem error's message quotes the path it was raised on, and a record path can run
 * through the operator's own home directory; `harness.ts`'s own diagnostics take the same narrowing
 * for the same reason. This is the one line the model reads about a failed append, so it is held to
 * the same rule as the lines nobody but a log reads.
 */
function faultCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

/** One tool call, answered from the bridge. Held apart from the wiring so it can be driven by test. */
export async function callTool(
  bridge: Bridge,
  name: string,
  args: Record<string, unknown>,
  records?: RecordContext,
): Promise<CallToolResult> {
  // Trimmed once, here, and used for every lookup below: `Bridge.prompt` trims its own `session`
  // argument before it becomes a key in the state file or in a turn-end payload, and a dispatch that
  // kept the raw, padded spelling would append a party section under one key and find the matching
  // turn end filed under the trimmed one, so the counterparty section would never be found.
  const session = stringArgument(args, "session")?.trim();
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
      const recordArg = stringArgument(args, "record");
      if (Object.hasOwn(args, "record") && args.record !== undefined && recordArg === undefined) {
        return failure("dsh_prompt's record must be a string naming an absolute local path.");
      }
      const partyArg = stringArgument(args, "party");
      if (Object.hasOwn(args, "party") && args.party !== undefined && partyArg === undefined) {
        return failure("dsh_prompt's party must be a string.");
      }
      const counterpartyArg = stringArgument(args, "counterparty");
      if (Object.hasOwn(args, "counterparty") && args.counterparty !== undefined && counterpartyArg === undefined) {
        return failure("dsh_prompt's counterparty must be a string.");
      }
      // A record path present on this call is refused up front, before any runtime is spawned for
      // it: `recordFilePath` is the fuller check (a directory is refused too, not only a relative
      // path) that `record.ts`'s own append and rotate hold every record path to. Omitted, the path
      // this turn writes to is whatever `bridge.remembered` says, which is the same lookup `prompt`
      // itself is about to make: this process's own copy for a name it has prompted, the file for one
      // it has not. A separate read of the state file here could disagree with that, since a state
      // write `prompt` makes is logged and never raised on failure, so the file can lag what this
      // process's own copy, and `prompt`'s own fallback, already carry. That value is re-checked
      // through the same guard a wire path takes, since a directory can appear at that path after it
      // was stored and before it is opened.
      let recordPath: string | undefined;
      // Said in the receipt, through `recordWarning` below, and not only in the log: a caller reading
      // only the receipt cannot otherwise tell a turn that kept no record apart from an ordinary one,
      // which is the same gap a registration refusal below is closed for.
      let unresolvedReason: string | undefined;
      if (recordArg !== undefined) {
        recordPath = recordFilePath(recordArg);
        if (recordPath === undefined) {
          return failure(
            `dsh_prompt's record '${untrustedLine(recordArg, 120)}' must be an absolute local path that does not name an existing directory.`,
          );
        }
        // Shape-valid but still refused when it names this bridge's own state directory: nothing
        // below this point writes to `recordPath` unless `records` is given, so a caller with no
        // `records` context (every test that does not stand one up) has nothing here to guard.
        if (records !== undefined && insideStateDirectory(records.stateFile, recordPath)) {
          return failure(
            `dsh_prompt's record '${untrustedLine(recordArg, 120)}' names this bridge's own state directory, so it is refused rather than being kept as a record.`,
          );
        }
      } else if (records !== undefined) {
        const remembered = bridge.remembered(session)?.record;
        if (remembered !== undefined) {
          recordPath = recordFilePath(remembered);
          if (recordPath === undefined) {
            unresolvedReason = "the record remembered for this session no longer names a file this bridge will open";
            records.log(`dsh-bridge: ${unresolvedReason} ('${untrustedLine(session)}'), so this turn appends nothing to it`);
          } else if (insideStateDirectory(records.stateFile, recordPath)) {
            recordPath = undefined;
            unresolvedReason = "the record remembered for this session names this bridge's own state directory, so it will not be opened";
            records.log(`dsh-bridge: ${unresolvedReason} ('${untrustedLine(session)}'), so this turn appends nothing to it`);
          }
        }
      }
      let party = DEFAULT_PARTY;
      if (partyArg !== undefined) {
        const validated = partyName(partyArg);
        if (validated === undefined) {
          return failure(`dsh_prompt's party must be a non-blank string of at most ${String(MAX_PARTY_NAME)} code points, with no line break.`);
        }
        party = validated;
      }
      let counterparty = DEFAULT_COUNTERPARTY;
      if (counterpartyArg !== undefined) {
        const validated = partyName(counterpartyArg);
        if (validated === undefined) {
          return failure(`dsh_prompt's counterparty must be a non-blank string of at most ${String(MAX_PARTY_NAME)} code points, with no line break.`);
        }
        counterparty = validated;
      }
      // Registered before the prompt is sent, since the turn's end can arrive and ask for its
      // counterparty section before this call gets its own receipt back: `Bridge`'s `onTurnEnd` can
      // run from inside a still-pending prompt request, and the writer holds that section until its
      // party's has landed rather than losing track of which record and which names this turn was
      // for. The token this returns, never the session name, is what every later call below names
      // this turn by: a second prompt for a name that already has one pending is refused this token
      // (undefined) rather than being let to replace the first turn's still-live registration.
      const token = records?.writer.registerTurn(session, recordPath, party, counterparty, now);
      let receipt: Awaited<ReturnType<Bridge["prompt"]>>;
      try {
        receipt = await bridge.prompt({
          session,
          text: body,
          ...(cwd === undefined ? {} : { cwd }),
          ...(recordArg === undefined ? {} : { record: recordArg }),
        });
      } catch (error) {
        records?.writer.discardTurn(token);
        throw error;
      }
      // The party's section is appended here, once the runtime has accepted the prompt and before
      // this call's own receipt returns, and never before: a prompt the bridge refused or the
      // runtime rejected threw out of the block above and never reaches this line. Reported in the
      // receipt rather than raised, since the task has already been accepted and a failure to keep
      // its transcript must not read to the model as a prompt that failed, while still being
      // something the model is told about rather than only a line in a diagnostics stream it never
      // reads.
      let recordWarning: string | undefined;
      if (recordPath === undefined && unresolvedReason !== undefined) {
        recordWarning = `record: NOT appended this turn (${unresolvedReason})`;
      } else if (recordPath !== undefined && token === undefined) {
        // `registerTurn` refuses silently for a record path it was given: a name that already holds
        // a pending turn, or this writer already at its bound of turns held pending at once. Either
        // way nothing will ever be appended for this turn, and the model told only that the prompt
        // was accepted would have no way to know its transcript was not kept.
        recordWarning = "record: NOT appended this turn (no turn was registered for its record; one may already be pending on it, or this bridge already holds as many pending as it allows)";
      }
      try {
        records?.writer.appendParty(token, body);
      } catch (error) {
        // `faultCode` already narrows an unknown error to its system code where it has one, but a
        // code-less message still carries whatever a filesystem error names, so the model-facing copy
        // is bounded and neutralized exactly as the rotate's own failure receipt is, below.
        const code = faultCode(error);
        const bounded = untrustedLine(code, MAX_REFUSAL_LENGTH);
        // `partyAppended` distinguishes the one failure where half the turn is already on disk: the
        // party section landed and only a counterparty section flushed alongside it failed. Saying
        // "NOT appended this turn" there would be false, since a record on disk now carries the
        // party's own words with nobody told.
        recordWarning =
          isRecord(error) && error.partyAppended === true
            ? `record: the party section was appended, but its counterparty could not be (${bounded})`
            : `record: NOT appended this turn (${bounded})`;
        records?.log(`dsh-bridge: the party section for '${untrustedLine(session)}' could not be appended to its record (${code})`);
      }
      // The name is the caller's own and is neutralized where it reaches the model, as every other
      // tool result that carries one does.
      return text(
        [
          "accepted, the worker has the task and its answer arrives as a channel event",
          `session: ${untrustedLine(session)}`,
          `dsh_session: ${receipt.sessionId}`,
          `turn: ${String(receipt.turn)}`,
          ...(recordWarning === undefined ? [] : [recordWarning]),
        ].join("\n"),
      );
    }
    if (name === RECORD_ROTATE_TOOL_NAME) {
      const archiveArg = stringArgument(args, "archive_path");
      if (session === undefined || archiveArg === undefined) return failure("dsh_record_rotate needs a session and an archive_path.");
      if (records === undefined) return failure("dsh_record_rotate is not available on this connection.");
      // Checked before anything is resolved from the map, so a file that is present and unreadable is
      // told apart from a name with no record: `bridge.remembered` falls through to `held` (nothing)
      // for either, and the two need different words, exactly as `prompt`'s own pre-spawn check does.
      const fault = stateReadFault(records.stateFile, records.log);
      if (fault !== undefined) {
        return failure(
          `Session '${untrustedLine(session)}'s record could not be checked: the session map cannot be read right now (${stateFault(fault)}), so the rotate is refused rather than guessed at.`,
        );
      }
      // The same lookup `dsh_prompt` itself makes before deciding what a turn without its own
      // `record` argument writes to: this bridge's own copy for a name it has prompted, and the file
      // for one it has not. A separate read of the state file here could disagree with it, since a
      // state write `prompt` makes is logged and never raised on failure.
      const remembered = bridge.remembered(session)?.record;
      if (remembered === undefined) return failure(`Session '${untrustedLine(session)}' has no record file to rotate.`);
      const recordPath = recordFilePath(remembered);
      if (recordPath === undefined) {
        return failure(`Session '${untrustedLine(session)}'s remembered record no longer names a file this bridge will open, so there is nothing to rotate.`);
      }
      if (insideStateDirectory(records.stateFile, recordPath)) {
        return failure(
          `Session '${untrustedLine(session)}'s remembered record names this bridge's own state directory, so it is refused rather than rotated.`,
        );
      }
      const archivePath = recordFilePath(archiveArg);
      if (archivePath === undefined) {
        return failure(
          `dsh_record_rotate's archive_path '${untrustedLine(archiveArg, 120)}' must be an absolute local path that does not name an existing directory.`,
        );
      }
      if (insideStateDirectory(records.stateFile, archivePath)) {
        return failure(
          `dsh_record_rotate's archive_path '${untrustedLine(archiveArg, 120)}' names this bridge's own state directory, so it is refused rather than being written to.`,
        );
      }
      // This bridge's own registered turns alone: a sibling bridge's turn on the same file is
      // invisible to this check, exactly as the tool's own description says, and no lock or marker
      // file widens it to see one, per the operator's ruling that a second bridge is not a case this
      // bridge guards. Read from the writer's own bookkeeping rather than from `bridge.busy()`: a
      // turn's live entry clears before its counterparty section is flushed, so a holder list built
      // from busy sessions can go empty while this writer still has a section queued for the same
      // file, mid-`await` in a concurrent `dsh_prompt`.
      const holders = records.writer.holdersOf(recordPath);
      if (holders.length > 0) {
        return failure(
          `Session '${untrustedLine(session)}'s record was not rotated: ${holders.map((name) => untrustedLine(name)).join(", ")} still has a turn in flight on the same file, in this bridge.`,
        );
      }
      let archived: boolean;
      try {
        archived = rotateRecord(recordPath, archivePath);
      } catch (error) {
        // The one rotate failure whose raw message would carry `recordPath`, this session's remembered
        // record and not an argument of this call, through to the model: reported instead from this
        // call's own `archivePath`, exactly as the success text below does.
        if (isRecord(error) && error.code === ROTATE_FRESH_FILE_FAILED_CODE) {
          return failure(
            `Session '${untrustedLine(session)}'s record was moved to ${untrustedLine(archivePath, 120)}, but a fresh file could not be started at the same path; the previous record is intact there.`,
          );
        }
        return failure(untrustedLine(faultCode(error), MAX_REFUSAL_LENGTH));
      }
      return text(
        archived
          ? `Rotated. The record continues at the same path with a fresh body; the previous one is at ${untrustedLine(archivePath, 120)}.`
          : "There was no record on disk yet, so a fresh, empty one was started at the same path; nothing was archived.",
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

  const recordLog = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const records: RecordContext = {
    stateFile: defaultStateFile(env),
    writer: new RecordWriter(recordLog),
    log: recordLog,
  };

  const bridge = new Bridge({
    stateFile: records.stateFile,
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
    onTurnEnd: (turn) => {
      recordTurnEnd(records, turn);
    },
    log: recordLog,
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
    return callTool(bridge, request.params.name, request.params.arguments ?? {}, records);
  });

  await server.connect(new StdioServerTransport());
}

// Claude Code starts this as a child process. The guard is what lets a test import the module
// without it seizing stdio, which is the MCP pipe.
if (runDirectly(import.meta.url)) {
  await startBridge();
}
