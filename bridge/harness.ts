// The DSH side of the bridge: one runtime child, the sessions it serves, and the turn state machine
// that turns a stream of notifications into one channel event per finished turn.
//
// Two properties of the runtime shape everything here. The `initialize` handshake is process-wide
// and carries the workspace, and the sandbox policy's root is the runtime process's own working
// directory, so one runtime serves exactly one workspace and the first prompt is what binds it. And
// there is no cancel on the wire: `dsh_kill` is the whole of cancellation, which is why a killed
// turn has to be reported rather than merely stopped.
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness, RequestTimeoutError, TransportClosedError } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessNotification, NotificationSubscription } from "@deepseek-ai/dsh-sdk-client";
import { REQUEST_TIMEOUT_MS, RUNTIME_BIN, RUNTIME_PATCH, childEnv, requireRuntimeBin } from "./env.ts";
import { DEFAULT_TAIL_COUNT, isSessionId, isTurnNumber, readSessionCounts, readSessionLog, sessionLogFile } from "./log.ts";
import type { LogReading } from "./log.ts";
import { MAX_META_FILES, MAX_SESSION_NAME, MAX_STORED_PATH_LENGTH, channelNotification, isHidden, isRecord, metaValue, untrustedLine } from "./protocol.ts";
import type { ChannelNotification, TurnKind } from "./protocol.ts";

/**
 * The most of a session name one diagnostic line or refusal spends on it, in code points.
 *
 * A name reaches these lines through a tool argument, where `prompt` has already bounded it at
 * {@link MAX_SESSION_NAME}, or through the state file on disk, where it is a key anything running as
 * this user can write at any length. Claude Code captures this stream into its debug log, so a name
 * carrying a newline would write a line of its own author's choosing there. `metaValue` is the
 * neutralizer the channel event's attributes already go through, and it is the same class of
 * problem: text somebody else wrote entering a record a person reads as structure. The two bounds
 * are one number, so a name the bridge admitted is never cut when it is quoted back.
 */
const MAX_LOGGED_NAME = MAX_SESSION_NAME;

/**
 * The most distinct lines about records the state file's reader says in one bridge process.
 *
 * The reader names each record it refuses, and the file is one anything running as this user can
 * fill with records to refuse; past the bound the reader goes quiet about records, as the
 * unhandled-notification seam in `index.ts` does past its own. A line about the file itself, that it
 * cannot be read or does not parse, is outside the bound: it is said once whatever the count of
 * records before it, so a file filled with refused records cannot mute the reader about what happened
 * to the file next.
 */
export const MAX_STATE_DIAGNOSTICS = 64;

/** How every line about one record begins, which is what the bound above counts. */
const RECORD_LINE = "dsh-bridge: the record for '";

/**
 * A sink that says each distinct line once per process.
 *
 * The state file is read at construction, twice at every prompt, at every status and tail, and
 * under every write, and a record the reader refuses is carried through every write exactly as it
 * was, so the record never leaves the file and a sink that repeated the refusal would say the same
 * line on every tool call for the life of the process. The line is the key: it names the record and
 * the reason, and both are bounded where the line is built, so the set holds bounded strings and is
 * bounded in count on top. `unhandledNotifications` in `index.ts` is the same shape over the other
 * seam that would otherwise restate what its first line established.
 */
function saidOnce(write: (line: string) => void): (line: string) => void {
  const said = new Set<string>();
  let records = 0;
  return (line) => {
    if (said.has(line)) return;
    const record = line.startsWith(RECORD_LINE);
    if (record && records >= MAX_STATE_DIAGNOSTICS) return;
    if (record) records += 1;
    said.add(line);
    write(line);
  };
}

/**
 * One error as a diagnostic line carries it: on one line, with the harness's own tags disarmed.
 *
 * An error's text is somebody else's: the SDK's, the runtime's, or the filesystem's, and any of them
 * can carry a path, a newline or a fragment of worker output. The line it lands on is one Claude Code
 * captures into its debug log, so the same neutralizer every other line of foreign text takes is
 * applied here, and a newline inside the message cannot write a second line of its author's choosing.
 */
function diagnostic(error: unknown): string {
  return untrustedLine(String(error));
}

/**
 * A filesystem failure, said by the code the caller can act on and nothing else.
 *
 * The state file's path runs through the local application data directory, which carries the
 * operator's user name, and a Node filesystem error embeds the path it was raised on; a parse
 * failure carries the file's own bytes instead, which are session names and workspace paths. A
 * record's path is the caller's own choice and can run through the operator's home the same way.
 * All of it lands in a debug log. So these failures are reported through one helper rather than
 * through a rule each site keeps for itself, since a site written by hand carries the protections
 * its author could see and drops the ones it could not. A read the map's own reader refused carries
 * no filesystem code for three of its four reasons, so that type is said by its reason instead.
 */
export function stateFault(error: unknown): string {
  if (error instanceof StateUnreadError) return error.code ?? error.reason;
  return isRecord(error) && typeof error.code === "string" ? untrustedLine(error.code) : "no code";
}

/** The line said for a write of the session map that raised, wherever the write was made from. */
function unwritten(error: unknown): string {
  return `dsh-bridge: the session map could not be written, so a restart may not resume (${stateFault(error)})`;
}

/**
 * Which exit the session map's reader took when the file was present and was not read: grown past
 * {@link MAX_STATE_BYTES}, refused by the filesystem, not JSON, or JSON that is not a session map.
 */
export type UnreadReason = "oversized" | "unreadable" | "not-json" | "misshapen";

/**
 * A write of the session map refused because the map on disk was not read under this version's rules.
 *
 * A write is two acts, a read and a publication, and its callers decide differently on each: a read
 * that failed means the entry under the name was never compared and nothing was published, for as
 * long as the file stays so, while a publication that failed after a clean read lost the publication
 * alone. A plain error would hand the caller the two as one, so the read's failure is this type and
 * carries which exit the reader took, under `stateFault`'s rule: the reason and a filesystem code,
 * never the message, which is the path, and never the bytes, which are the file.
 */
export class StateUnreadError extends Error {
  readonly reason: UnreadReason;
  /** The filesystem error's code where the reason is `unreadable`, and absent otherwise. */
  readonly code: string | undefined;

  constructor(reason: UnreadReason, code?: string) {
    super("The session map on disk cannot be read under this bridge's rules, so it is left as it is rather than replaced by this scope alone.");
    this.name = "StateUnreadError";
    this.reason = reason;
    this.code = code;
  }
}

/** The operator's harness home, shared with the web session, which admits a second runtime. */
export const DSH_HOME = path.join(os.homedir(), ".dsh");

/** How the runtime subprocess is launched, held apart so a test can point it at a stand-in. */
export interface RuntimeSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The bound on every request, the `initialize` handshake among them. */
  readonly requestTimeoutMs?: number;
  /**
   * The bound on `session/prompt` alone, when it is to differ from the bound on every request. The
   * handshake includes a process spawn and a boot and the prompt does not, so the two are not one
   * number; absent, the prompt takes the request bound.
   */
  readonly promptTimeoutMs?: number;
  /**
   * A precondition of spawning, read at the spawn and not before it, throwing what the caller is to
   * be told. A spec with none is one whose command needs nothing checked.
   */
  readonly check?: () => void;
}

/**
 * The launch spec for a real DSH runtime.
 *
 * The child environment is built by `childEnv`, the same function the SDK spike spawns through,
 * rather than assembled here: `HarnessClientOptions.env` replaces the child environment outright,
 * so the base is the vendor's own `scrubbedParentEnv` with this session's `CLAUDE*` and `CHANNEL_*`
 * names dropped on top of it, and the harness home set after the scrub that would otherwise remove
 * it.
 *
 * Building the spec touches no filesystem and refuses nothing. The launcher's presence is a
 * precondition of the spawn instead, because this function is called while the server is being
 * wired: a refusal here would take the process down before `server.connect`, the channel would
 * never register, and the sentence saying how to install the runtime would land on a plugin child's
 * stderr where no model reads it. Carried as `check`, it reaches the model as a failed tool call
 * saying what to run.
 *
 * `parent` is the environment this spec reads its own values from, so a caller that injects one
 * reaches every value the bridge itself reads. The scrubbed base the child starts from is the
 * vendor's own read of the process environment, which takes no injection.
 */
export function dshRuntimeSpec(home: string = DSH_HOME, parent: NodeJS.ProcessEnv = process.env): RuntimeSpec {
  return {
    command: process.execPath,
    args: [RUNTIME_BIN, "--profile", "sdk", "--patch", RUNTIME_PATCH],
    env: childEnv(home, parent.OLLAMA_API_KEY),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    check: () => {
      requireRuntimeBin();
    },
  };
}

/**
 * The most of a filesystem path this bridge accepts, in code points.
 *
 * Past the classic Windows MAX_PATH, so a deep checkout fits; what it bounds is the length of a
 * string that reaches a system call and a refusal message, not any real workspace.
 */
export const MAX_PATH_LENGTH = MAX_STORED_PATH_LENGTH;

/** The prefixes that name a host rather than a place on this machine, in both slash spellings. */
const REMOTE_PREFIX = /^[\\/][\\/]/;

/** A Windows path that names the same place from every process, whatever drive it was launched on. */
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;

/** A Windows path against a drive's current directory: a drive letter and a colon with no separator after them. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

/**
 * A workspace or file path as this bridge will use it, or undefined for one it refuses.
 *
 * Every path here is untrusted input twice over: the tool argument is whatever the calling model
 * wrote, and the stored one was read back out of a JSON file on disk that anything running as this
 * user can rewrite. Both are joined into system calls and one of them becomes an unsandboxed
 * child's working directory.
 *
 * `path.isAbsolute` is not that check on Windows. `\\host\share\x` is absolute, and the first
 * filesystem call on it opens an outbound SMB connection to a host the caller named, carrying the
 * operator's credentials, before any refusal could run; `\\?\` and `\\.\` device paths begin the
 * same way. `\one` is absolute too and resolves against whichever drive this process was launched
 * from, which is no drive the caller chose. So the remote prefixes are refused on both platforms,
 * a drive root is required on Windows, and the length is bounded.
 *
 * The same shape guards the broker's transcript path, whose refusal `docs/security-model.md`
 * records; that one is private to `broker/intake.ts` and reads its value straight off a payload,
 * so this is the bridge's own rather than a call into it.
 */
export function workspacePath(value: string): string | undefined {
  const trimmed = value.trim();
  const points = [...trimmed];
  if (trimmed === "" || points.length > MAX_PATH_LENGTH) return undefined;
  // The hidden class is refused rather than stripped, and it is `protocol.ts`'s one definition
  // rather than a control-character range of this file's own: a C1 control, a bidirectional
  // override or a zero-width point in a path reaches `statSync`, the spawn's working directory and
  // the refusal quoted back to the model exactly as a C0 control does. Refused because a path is an
  // instruction to open something, and one repaired into a shape it did not have opens a place the
  // caller never named.
  if (points.some((point) => isHidden(point.codePointAt(0) ?? 0))) return undefined;
  if (REMOTE_PREFIX.test(trimmed)) return undefined;
  if (process.platform === "win32" ? !WINDOWS_ROOT.test(trimmed) : !path.isAbsolute(trimmed)) return undefined;
  return trimmed;
}

/**
 * A path this bridge will open as a file, or undefined for one it refuses: `workspacePath`'s own
 * shape guard, plus a refusal of a path naming a directory that already exists, and of one the
 * filesystem cannot place at all (a drive that is not there).
 *
 * The record file `dsh_prompt`'s `record` argument names, and `dsh_record_rotate`'s `archive_path`,
 * are both this shape: a file this bridge appends to, renames, or creates, never a directory a
 * runtime is spawned inside, which is what `workspacePath` alone admits. Defined here rather than in
 * `record.ts`, which already imports `samePath` from this file: the reverse import would be
 * circular. Every caller that persists or opens one of these paths calls this directly (`prompt`
 * here, and `index.ts`'s dispatch for a stored `record` and for `archive_path`), and `record.ts`
 * runs it and `refusedRecordTarget` once more at the open itself, so the guard is a property of the
 * file rather than of the callers that remembered to check.
 */
export function recordFilePath(value: string): string | undefined {
  const admitted = workspacePath(value);
  if (admitted === undefined || isDirectory(admitted)) return undefined;
  return placedPath(admitted) === undefined ? undefined : admitted;
}

/**
 * `candidate` as the filesystem places it, or undefined for one it cannot place at all.
 *
 * The deepest ancestor that exists is resolved through the filesystem's own real path, which
 * expands an 8.3 short name, a junction and a symbolic link into the one spelling the object has;
 * the tail that does not exist yet is appended unchanged, since a path with no object behind it has
 * no spelling but its own; and the whole is folded as `canonicalPath` folds. Every comparison of a
 * caller's path against a place this bridge protects goes through this, because a comparison of
 * spellings admits every other spelling of the same object, and Windows publishes a short name for
 * a long directory name by default, with nothing to set up. Undefined where no ancestor exists (a
 * drive that is not there) or where the filesystem refuses to say (a permission it will not grant),
 * and every guard here refuses such a path rather than comparing it by its spelling.
 *
 * `realpathSync.native` rather than `realpathSync`: the JavaScript walk keeps a short name as it was
 * written, and only the native call asks the filesystem for the object's final name.
 */
export function placedPath(candidate: string): string | undefined {
  let existing = path.resolve(candidate);
  const tail: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = realpathSync.native(existing);
    } catch (error) {
      if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return undefined;
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      tail.unshift(path.basename(existing));
      existing = parent;
      continue;
    }
    return canonicalPath(tail.length === 0 ? real : path.join(real, ...tail));
  }
}

/**
 * Whether `candidate`, as the filesystem places it, is `root` or a path inside it. True for a
 * candidate or a root the filesystem cannot place, since a comparison against nothing proves nothing
 * and every caller here refuses on true.
 */
function placedWithin(candidate: string, root: string): boolean {
  const target = placedPath(candidate);
  const dir = placedPath(root);
  if (target === undefined || dir === undefined) return true;
  return target === dir || target.startsWith(`${dir}${path.sep}`);
}

/**
 * Whether `candidate` names the bridge's own state directory, `stateFile`'s parent, or a path inside
 * it.
 *
 * `writeState` stages its temporary file in that directory before renaming it over the map (see
 * `writeState`'s own `${file}.${pid}.tmp` and the rename that follows it), so a record or an archive
 * path anywhere in that directory, not only the map file's own path, can be renamed over the map by a
 * concurrent state write. This is directory-scoped rather than file-scoped for that reason: a guard
 * that compared only against `stateFile` itself would admit exactly the sibling path that write
 * exposes. Compared through `placedPath`, so a short name, a junction or a link to the directory is
 * the directory, and a sibling whose name merely begins with the directory's own is not.
 */
export function insideStateDirectory(stateFile: string, candidate: string): boolean {
  return placedWithin(candidate, path.dirname(stateFile));
}

/** This checkout's root, from this file's own location, exactly as `env.ts` derives it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The places this machine executes or reads as instructions, on this product's account: the trees
 * `install/Install-Host.ps1` hardens (`hooks/`, `relay/`, `wrapper/`, `install/`, `broker/`, and
 * the channels state root under the local application data directory, which holds the broker's
 * configuration and token), `bridge/` itself with the runtime's permission patch inside it, the
 * Claude Code home, and the harness home the worker runtime reads its own configuration from.
 *
 * A record is appended to, never replaced, and `appendSection` creates the file and its directory
 * when neither exists, so a record path naming a place in this list plants a worker's text where a
 * shell, a hook, the runtime or the session reads it, with nothing destroyed and nothing to restore.
 * The list is these places and nothing else: an ordinary document anywhere on the machine is a
 * legitimate record, and a rule about where a caller's file may live would refuse the operator's own
 * documents, which is why the refusal is of the machine's instruction chain rather than of a location.
 */
export function executionSurface(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = os.homedir();
  return [
    ...["bridge", "hooks", "relay", "wrapper", "install", "broker"].map((tree) => path.join(REPO_ROOT, tree)),
    path.join(home, ".claude"),
    DSH_HOME,
    path.join(env.LOCALAPPDATA ?? home, "sapplefeld-channels"),
  ];
}

/**
 * Whether `candidate`, as the filesystem places it, names one of the places in {@link executionSurface}
 * or a path inside one. `surface` is the list itself, taken by a test that drives the comparison
 * against roots of its own; every caller in the bridge takes the machine's.
 */
export function insideExecutionSurface(candidate: string, surface: readonly string[] = executionSurface()): boolean {
  return surface.some((root) => placedWithin(candidate, root));
}

/** The clause a refusal says for a record or archive target inside this bridge's own state directory. */
export const STATE_DIRECTORY_REFUSAL = "names this bridge's own state directory";

/** The clause a refusal says for a record or archive target inside {@link executionSurface}. */
export const EXECUTION_SURFACE_REFUSAL = "names a place this machine executes or reads as instructions";

/**
 * Why `candidate` is refused as a record or an archive target, as the clause the refusal says, or
 * undefined for a path this bridge will write to.
 *
 * The one rule under every caller that opens, renames or persists such a path: the state directory
 * first, since it sits inside the channels state root and the more specific clause is the one an
 * operator can act on, then the rest of the execution surface. A path `recordFilePath` refuses never
 * reaches here from a caller in the bridge, and one it would refuse is refused here too, since
 * `placedWithin` treats a path the filesystem cannot place as inside everything.
 */
export function refusedRecordTarget(stateFile: string, candidate: string): string | undefined {
  if (insideStateDirectory(stateFile, candidate)) return STATE_DIRECTORY_REFUSAL;
  if (insideExecutionSurface(candidate)) return EXECUTION_SURFACE_REFUSAL;
  return undefined;
}

/**
 * As much of an untrusted string as a refusal quotes back, neutralized so the message is theirs to
 * read without being theirs to forge.
 *
 * A refusal is a tool result the model reads, and the string quoted into it is a caller's `cwd` or a
 * workspace read back from a state file anything running as this user can write. Routed through
 * `untrustedLine`, which disarms a forged harness tag and replaces the hidden class, and bounded to
 * the refusal's own length: the guard is a property of this boundary, so the same one every tool
 * result crosses is reused here rather than restated.
 */
function quoted(value: string): string {
  return untrustedLine(value, 120);
}

/**
 * As much of a session name as a refusal or a diagnostic quotes, neutralized and bounded.
 *
 * A name is the calling model's to choose, and a refusal is a tool result that model reads through
 * one bounded line: quoted whole, a long name spends the line on itself and cuts off the sentence
 * after it that says what to do next. The same neutralizer and bound wherever a name is quoted, so
 * it reads the same in a refusal and in a log line.
 */
function named(name: string): string {
  return metaValue(name, MAX_LOGGED_NAME);
}

/**
 * The largest state file this bridge reads, in bytes.
 *
 * The file is read whole at construction, at each prompt and under each write, and it is a file on
 * disk that anything running as this user can grow. A record is a few hundred bytes and a machine holds a few
 * dozen of them, so this is three orders of magnitude of room; past it the file is reported and
 * treated as unreadable, exactly as one that does not parse is.
 */
export const MAX_STATE_BYTES = 1024 * 1024;

/** The state file, beside the relay's registration, so a restart resumes the same conversations. */
export function defaultStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? os.homedir();
  return path.join(base, "sapplefeld-channels", "dsh-bridge", "sessions.json");
}

/**
 * Which sessions in the shared state file are this bridge's, for a bridge Claude Code started.
 *
 * The directory the process was started in. That a channel plugin's server is started in the
 * directory the Claude session runs in is inferred rather than observed: no run has been observed
 * either way, and Section 5 is where the host is observed. If it holds, one project is one scope, and
 * the same one again after a restart, which is what a resume needs; if it does not, every bridge on
 * the machine lands in one scope and two projects naming one worker read one record. One bridge per
 * scope and session name is the operator's arrangement, and the bridge guards nothing about a second
 * one. Folded as `samePath` folds a workspace, because on Windows one directory is named by every
 * casing of its path: keyed on the spelling, two sessions launched with the project's path in two
 * cases would land in two scopes, and a restart under the other casing would not find its records.
 */
export function defaultScope(cwd: string = process.cwd()): string {
  return canonicalPath(cwd);
}

/** What the bridge remembers about one session name across a kill and across a restart. */
export interface SessionRecord {
  /** The DSH session id, minted by the SDK and never invented here. */
  sessionId: string;
  /** The workspace this session runs in, fixed at its first prompt. */
  cwd: string;
  /** The record file this session's rounds are written to, when the caller named one. */
  record?: string;
  /** The last turn number this session ran, so a receipt names the next one. */
  turn: number;
}

/**
 * The refusal for a name whose entry on disk names a different conversation from the one this
 * process is running under it, as the prompt raises it when its write is refused.
 *
 * Nothing is named as holding the name, because nothing is known to: the write compared two
 * conversation identifiers and found them different, and that is the whole of what it knows. The
 * refusal drops this process's claim to the name as it is raised, so the advice it gives is true: the
 * next prompt reads the name off the file and resumes the conversation the file carries.
 */
function supersededRefusal(name: string): Error {
  return new Error(
    `Session '${named(name)}' was not prompted: the name now names a different DSH conversation in the session map than the one ` +
      "this bridge was running under it, so nothing was written over it. Prompt the name again to resume the conversation the map names, " +
      "or use a different session name to start a new one.",
  );
}

/**
 * The refusal for a prompt whose read of the session map failed, as the prompt raises it.
 *
 * The write compared nothing and published nothing, and the file is present and unreadable for
 * every bridge in the project. What clears it depends on the fault: a filesystem refusal can be a
 * neighbour or a scanner holding the file for a moment, which clears on its own, while a file past
 * the ceiling, not JSON or not a session map stays so until somebody changes it. So the refusal
 * names which fault it was and the remedy that fits it, and names the file by its role, never by its
 * path, which runs through the operator's user name; a filesystem code is carried, a parse failure's
 * message, which quotes the file's bytes, is not.
 */
function unreadRefusal(name: string, error: StateUnreadError): Error {
  const fault = {
    oversized: `is past the ${String(MAX_STATE_BYTES)} bytes this bridge reads`,
    unreadable: `cannot be read (${error.code ?? "no code"})`,
    "not-json": "does not parse as JSON",
    misshapen: "is not a session map",
  }[error.reason];
  const remedy =
    error.reason === "unreadable"
      ? "A filesystem refusal is often a neighbour or a scanner holding the file for a moment, so prompt again first; if it persists, " +
        "the file is the operator's to repair or remove, and the bridge's log names the failure."
      : "The condition does not clear by itself: the file is the operator's to repair or remove; the bridge's log names the failure, " +
        "and the next dsh_prompt reads the file again.";
  return new Error(
    `Session '${named(name)}' was not prompted: the session map on disk ${fault}, so the record for the name was not read and nothing ` +
      `was written. Every prompt in this project is refused while the file stays so. ${remedy}`,
  );
}

/**
 * What the runtime has been observed doing since the most recent splice boundary.
 *
 * Every field here describes the session's activity, and none of it is known to be this turn's own
 * until the runtime confirms which queued message it is running. So the record is replaced whole at
 * each boundary by {@link disown}, and built by {@link observed} in the one shape a fresh turn and a
 * disowned one both take. A field that records what the session did belongs here and nowhere else
 * in {@link LiveTurn}: adding it here is what puts it under the boundary.
 */
interface Observed {
  /** The runtime's own turn number once a `turn/start` names it, and this bridge's count until then. */
  turn: number;
  /** Files the worker wrote: the ones the receipt can name, and a count of the rest. */
  touched: TouchedFiles;
  commands: number;
  /** The last assistant text committed, which is the answer the channel event carries. */
  text: string;
  /** The turn-end reason, when a `turn/end` arrived before the status did. */
  finishReason: string;
  /**
   * An idle that arrived before the runtime confirmed whose turn it closed, held until the prompt
   * request returns the id that settles it. It closed the stretch this record describes, so it
   * lives and dies with the record: a splice after it opens a stretch the idle said nothing about.
   */
  end?: { kind: TurnKind; finishReason: string };
}

/** The observed record as a turn starts and as it stands again after a boundary. */
function observed(counted: number): Observed {
  return { turn: counted, touched: { named: new Set(), extra: 0 }, commands: 0, text: "", finishReason: "" };
}

/**
 * One turn from the moment the runtime accepted it until its status goes idle.
 *
 * Two kinds of state, kept apart because a splice boundary treats them differently. The fields on
 * this record describe this bridge's own prompt: its count of the session's turns, the id the
 * runtime answered the request with, the receipts waiting to be compared against that id, and
 * whether the request was answered and the turn confirmed. No notification changes what any of them
 * means, and {@link disown} never touches them. `observed` describes what the runtime has been seen
 * doing and belongs to whatever message was spliced last, so it is replaced whole at every boundary.
 */
interface LiveTurn {
  /** This bridge's own count for the turn, which the runtime's number replaces once it arrives. */
  readonly counted: number;
  /** The queued message id the runtime answered the prompt with, once the request has returned. */
  messageId?: string;
  /** Inbox receipts seen before the message id was known, which is a race the wire allows. */
  receipts: Set<string>;
  /** Whether the runtime has confirmed that this turn's own message is the one it is running. */
  received: boolean;
  /** Whether the runtime answered the prompt request with a queued message id. */
  accepted: boolean;
  /**
   * Whether the session record is written down when this turn ends. Set with `accepted`, and set on
   * its own when the request times out unanswered, since the runtime may then be running the prompt
   * under this session id and a record that forgot the id would have the next prompt start a second
   * worker beside it. Left unset for a turn a kill or a loss ended while its request was still
   * outstanding, whose record `prompt` takes back.
   */
  kept: boolean;
  /** The session's activity since the last splice boundary, this turn's own once confirmed. */
  observed: Observed;
}

export interface PromptArgs {
  readonly session: string;
  readonly text: string;
  readonly cwd?: string;
  /**
   * The record file this turn's sections are appended to, remembered per session once given.
   *
   * A prompt naming one replaces what the session remembered; a prompt naming none keeps it, so a
   * caller names the record once rather than again on every later prompt or after a restart. The
   * bridge itself never appends to this file: `record.ts` does, reading the resolved path back off
   * the state file this write persists it to.
   */
  readonly record?: string;
}

export interface PromptReceipt {
  readonly sessionId: string;
  readonly turn: number;
}

export interface StatusReport {
  readonly session: string;
  /** `live` while this bridge holds a running child for it, `stored` once only the log remains. */
  readonly state: "live" | "stored";
  readonly sessionId: string;
  readonly cwd: string;
  readonly inFlight: boolean;
  readonly turn: number;
  /** When the runtime last said anything about this session, or undefined if it never has. */
  readonly lastNotification?: string;
  /**
   * Why the log on disk was not read, when there is one and it was not; `log` is then absent.
   *
   * The counts are the one part of a status that needs the log, and the log is a file the worker's
   * own runtime writes and rotates while this bridge reads it: it can be past the ceiling a status
   * reads at, held unshared, or a generation behind the directory listing. None of that is a reason
   * to withhold the state, the in-flight bit and the count, which come from the child and answer
   * the question a status is asked, so the report carries them and says why the counts are missing.
   */
  readonly logUnread?: string;
  /** What the log on disk records, or undefined when the session has no log yet or it was not read. */
  readonly log?: {
    readonly events: number;
    readonly turns: number;
    readonly steps: number;
    readonly compactions: number;
    readonly lastEventType: string;
    readonly permission: Record<string, string>;
    /** Bytes of the log the reader could not read as frames; the counts cover the rest. */
    readonly unreadBytes: number;
  };
}

export interface BridgeOptions {
  readonly stateFile: string;
  /**
   * Whose sessions these are, inside a state file every bridge on the machine shares.
   *
   * Session names are the calling model's to choose and one of them is `builder`, so two Claude
   * sessions working on two different projects name the same worker. Keyed by name alone they
   * overwrite each other's records, and a restarted bridge then resumes a stranger's DSH
   * conversation in a stranger's workspace, or refuses the operator's own name as belonging to a
   * workspace they never used. The scope is what keeps those two apart; `defaultScope` is what
   * every bridge Claude Code starts uses.
   */
  readonly scope: string;
  readonly home: string;
  readonly runtime: RuntimeSpec;
  readonly provider: string;
  readonly model: string;
  /** Where a finished turn goes. Called synchronously; the caller owns the delivery and its failure. */
  readonly push: (notification: ChannelNotification) => void;
  /**
   * The same finished turn, carrying the worker's answer in full.
   *
   * `push` receives that answer cut at the channel content cap, because a channel event is read by a
   * model and a whole tool result would crowd the session out of its own window. A record of the
   * conversation is read by a person and is where the whole answer belongs, so the text arrives here
   * uncut rather than being recovered from a copy something already cut. Optional, since a bridge
   * with no record to write needs no listener, and synchronous and guarded exactly as `push` is: a
   * throw out of a turn-end listener would leave every other turn a lost runtime was running in
   * flight forever.
   *
   * What a listener may rely on. It is called once per turn, synchronously, from wherever the turn
   * ends: from the notification pump on the session's idle, from `dsh_kill`'s sweep, from a runtime
   * loss, and from inside `prompt` itself, before that call has returned its receipt or rejected,
   * when the runtime finished the whole turn before answering the prompt request or when that
   * request timed out. So a listener can run before `prompt` returns. One session name has at most
   * one turn in flight, since a second prompt for a name is refused while one is, so a turn end for
   * a name belongs to the one prompt in flight for it. `accepted` says whether the runtime answered
   * the prompt request: true, and the receipt `prompt` returns, or has already returned, names this
   * turn; false, and `prompt` rejects for it, so nothing was ever promised a turn. `turn` is the
   * runtime's own number where a `turn/start` named one and this bridge's count otherwise, while the
   * receipt's is the count alone; the two agree unless the session ran a turn this bridge did not
   * send.
   *
   * Every field arrives raw, `session` and `finishReason` included, where the channel event carries
   * both neutralized: the record writer appends this text verbatim by design, since a record is a
   * file a person reads rather than a tool result a model does, so nothing here runs it through the
   * neutralizer the channel event's own fields take.
   */
  readonly onTurnEnd?: (turn: {
    readonly session: string;
    readonly kind: TurnKind;
    readonly turn: number;
    readonly finishReason: string;
    readonly text: string;
    /** Whether the runtime answered the prompt request this turn was sent with. */
    readonly accepted: boolean;
  }) => void;
  /** Diagnostics, one line at a time. */
  readonly log: (line: string) => void;
}

/**
 * The tools whose calls name a file the worker wrote, and the argument keys that name it.
 *
 * The runtime's file-writing tools and no others: `write` and `edit` are `@deepseek-ai/dsh-tool-fs`
 * and `str_replace_editor` is its own package. A file a shell command wrote is written by a tool
 * whose argument is a script rather than a path, so it is not here and is not in the receipt, which
 * is what the server's instructions tell the model the receipt covers.
 */
const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);
const PATH_KEYS = ["file_path", "filePath", "path"];

/**
 * The tools whose calls run a shell command. Nothing else counts as a command run.
 *
 * The runtime mounts one shell tool per platform, `pwsh` on Windows and `bash` elsewhere, so both
 * names are here and exactly one of them can arrive from any one runtime. The `job_*` tools are not
 * among them: they list, read and cancel background jobs that a shell tool call already started, so
 * counting one would count the same command twice.
 */
const COMMAND_TOOLS = new Set(["bash", "pwsh"]);

/**
 * The most inbox receipts held across notifications while the prompt request is still in flight.
 *
 * The window is one request long and the runtime splices once per prompt, so the bound is not
 * reached by a runtime behaving as this one does; it is here because the ids are the runtime's to
 * choose and the set would otherwise be a collection with nothing to empty it. The bound holds
 * between notifications rather than inside one: when a splice arrives, room for its whole run of
 * ids is made from earlier notifications' ids, oldest first, and never from the run itself, so one
 * notification can carry the set past the bound by the length of its own run, which the wire bounds
 * at one message. The id the request returns is the last one spliced, in the last run, and is held
 * whatever came before it and however long that run is.
 */
const MAX_PENDING_RECEIPTS = 64;

/**
 * The most paths one turn holds: every path the receipt can name, and one more.
 *
 * The one more is what makes the remainder honest at the boundary, since a list of exactly
 * {@link MAX_META_FILES} that is all there was and one that had more behind it render differently.
 */
export const MAX_RETAINED_FILES = MAX_META_FILES + 1;

/**
 * What one turn remembers of the files it wrote: the paths it can still name, and how many more.
 *
 * A worker looping over a large tree is the ordinary case here rather than an attack, and every
 * path is worker-chosen text held for the length of the turn. Kept whole, the list is unbounded
 * memory; scanned for duplicates, it is quadratic in the size of the loop. The receipt renders
 * twenty paths and a remainder either way, so what is past the bound is counted rather than held.
 */
export interface TouchedFiles {
  /** The retained paths in arrival order, at most {@link MAX_RETAINED_FILES} of them. */
  readonly named: Set<string>;
  /**
   * Paths the receipt does not spell, counted as they arrived: those that reached a full retained
   * set, and those with no spelling relative to the workspace at all.
   *
   * Deduplicated against the retained paths and not against each other: telling a repeat from a new
   * path past the bound would mean remembering every path, which is the cost the bound exists to
   * refuse. So a worker rewriting one unretained file in a loop is counted once per write.
   */
  extra: number;
}

/**
 * A written path as the receipt spells it, relative to the workspace, or undefined for one it cannot.
 *
 * Every path is resolved against the workspace and made relative to it again, which is the shape the
 * instructions promise, so a relative spelling and the absolute spelling of one place meet one rule.
 * Three shapes have no such spelling: a path on another drive, which `path.relative` hands back
 * unchanged; on Windows a path rooted at no drive, which `path.isAbsolute` accepts and `path.relative`
 * resolves against whichever drive this process runs from, into a `..\` chain naming a place the
 * worker never wrote; and a path outside the workspace on its own drive, whose relative spelling
 * begins by leaving the workspace and then names the rest of this machine, an account's home
 * directory among the places it can name. Each would put this machine's shape into an attribute that
 * promises the workspace's, so each is counted rather than spelled, and a relative path that begins by
 * leaving the workspace is that third shape spelled by the worker's own hand, counted by resolving it
 * first. So is a Windows drive-relative path, a drive letter and a colon with no separator after them:
 * `path.isAbsolute` rejects it, but it names a place against that drive's current directory rather
 * than against the workspace, so carried as written it would be spelled as a workspace path it is not.
 * What an absolute path may look like at all is the workspace guard's own rule, applied here to the
 * worker's path exactly as to a caller's. With no workspace to resolve against there is no spelling
 * relative to one, so the path is counted.
 */
function workspaceRelative(cwd: string | undefined, raw: string): string | undefined {
  if (process.platform === "win32" && DRIVE_RELATIVE.test(raw)) return undefined;
  if (cwd === undefined) return undefined;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  if (workspacePath(absolute) === undefined) return undefined;
  const relative = path.relative(cwd, absolute);
  // A write whose path resolves to the workspace directory itself spells relative as the empty
  // string, which is no file name: counted rather than named, so it does not render as a leading
  // empty entry in `files_touched`.
  if (relative === "") return undefined;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative;
}

/** Whether `target` is a directory this process can open; a path that cannot be statted is not one. */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Record one path against a turn, retaining it or counting it. */
export function noteFile(touched: TouchedFiles, file: string): void {
  if (touched.named.has(file)) return;
  if (touched.named.size < MAX_RETAINED_FILES) {
    touched.named.add(file);
    return;
  }
  touched.extra += 1;
}

/**
 * Drop everything the runtime has been seen doing before this boundary.
 *
 * The invariant: after a splice of a message not seen before, nothing this turn holds about the
 * session's activity predates that splice. The turn is marked in flight before the prompt is sent,
 * so every notification for the session lands on it from that moment, and what arrives before this
 * turn's own splice belongs to whatever the session was already doing: a resumed session replaying
 * its loaded state, or a message queued ahead of this one, whose idle may be sitting in the record
 * as a held end. Kept, any of it would answer this turn with somebody else's text, count their files
 * and commands as this worker's, or close this turn on their idle with an empty body while the
 * worker's real answer arrived to find no turn left.
 *
 * The whole of `observed` is replaced rather than its fields reset one at a time, which is what
 * makes the invariant hold for a field added later: it is covered by having been added to
 * {@link Observed} at all. Nothing of this turn's own is lost to it, because this turn's own work
 * sits after its own splice and no boundary is crossed again after that one: once the id is known a
 * splice of any other id is ignored, and once the turn is confirmed no splice is read at all. The
 * one window in which a further boundary could take this turn's own work is a splice of a message
 * this bridge did not send, landing between this turn's splice and the answer to its request; this
 * bridge is the runtime's only client and sends one prompt per session at a time, so it does not
 * open that window itself.
 *
 * The turn number goes back to this bridge's own count rather than to zero, because a `turn/start`
 * seen in that window numbered the turn before this one.
 */
function disown(turn: LiveTurn): void {
  turn.observed = observed(turn.counted);
}

/**
 * Why a session log was not read, as a status or a tail carries it to the model.
 *
 * A filesystem error names the path it failed on, and the path runs through the harness home, which
 * carries the operator's user name, so what is carried is the error's code alone, which is the
 * system's own word for what went wrong and names nothing. An error with no code is the reader's own
 * sentence, the counts-only ceiling among them, written for the model and carried whole. The one
 * rendering under both tools that read the log, so a rule kept at one and dropped at the other cannot
 * put the path into the other's answer.
 *
 * `next` is the caller's own sentence for the model's next move, since a code names a state the file
 * is in, held unshared, rotated, or not a file, and says nothing about the turn.
 */
function unreadLog(error: unknown, next: string): string {
  if (isRecord(error) && typeof error.code === "string") {
    return `the log could not be read (${error.code}); ${next}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * One path as the filesystem names its place: resolved, and on Windows folded to one case.
 *
 * The one rule under both the workspace comparison and the scope key, so the two cannot come to
 * disagree about which spellings name one directory.
 */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Two paths naming one place, as the filesystem compares them.
 *
 * The one rule for that comparison, built on `canonicalPath`, so a second caller of it (`record.ts`'s
 * own path-identity checks among them) imports this rather than re-deriving the comparison by hand.
 */
export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/**
 * The concatenated text of one assistant message, empty when it carried none.
 *
 * A message whose only content is a tool call has no text, which is the ordinary shape of every
 * step but the last: taking the last message's text regardless would answer a finished turn with an
 * empty string whenever the worker's final act was a tool call.
 */
function assistantText(data: Record<string, unknown>): string {
  const message = isRecord(data.message) ? data.message : undefined;
  const content = message === undefined ? undefined : message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Anything with the SDK client's shutdown, so the closing rule below can be driven by test. */
interface Closeable {
  close: () => Promise<unknown>;
}

/**
 * Close every handle, and say what happened, whatever any one of them does.
 *
 * Every handle is closed, rather than the first failure ending the round: a handle left unclosed
 * here is a live runtime process this bridge has already dropped its last reference to, and nothing
 * will ever reap it. Their failures are then raised as one, so a caller that wanted the runtime gone
 * is told it is not.
 *
 * A handle is closed once and never again. `HarnessClient.close()` memoizes its own task and returns
 * it to every later caller, so a shutdown that failed yields the identical rejection for the life of
 * the process; a retry of one is not a second attempt but the same answer again, and a bridge built
 * to retry would refuse every later `dsh_kill` over a runtime that stopped weeks ago.
 */
export async function closeAll(handles: readonly Closeable[], log: (line: string) => void): Promise<void> {
  // Each close is called inside its own async function, so a close that throws before it returns a
  // promise settles as a rejection beside the others rather than ending this round before the handles
  // after it are closed and without the line below.
  const settled = await Promise.allSettled(handles.map(async (handle) => handle.close()));
  const failures = settled.filter((one) => one.status === "rejected").map((one) => String(one.reason));
  if (failures.length === 0) return;
  for (const failure of failures) {
    // The handle is dropped here whatever this says: it cannot be closed again, so what is left is
    // to name it. A process that outlives the bridge is the operator's to end.
    log(`dsh-bridge: the worker did not shut down, so it may still be running: ${diagnostic(failure)}`);
  }
  throw new Error(`The worker did not shut down: ${failures.join("; ")}`);
}

/**
 * The bridge's DSH side: one runtime, the sessions it serves, and one channel event per turn.
 *
 * Constructed without touching the runtime. The child is spawned on the first `dsh_prompt`, because
 * a channel server is a child of every session that names the plugin and most of them will never
 * prompt a worker.
 */
export class Bridge {
  private readonly options: BridgeOptions;
  /**
   * Name to what is remembered about it, held as a map so a name off the wire is only ever a key.
   *
   * This bridge's copy of its scope: loaded from the file at construction and, for every name this
   * process has not prompted, replaced from the file each time `recall` reads one. A name this
   * process has prompted is never replaced from the file, since every write of it came from here and
   * the file can only be as new as this copy or older. The file is the shared record, and a status
   * or a tail of a name this process never prompted reports the file.
   */
  private readonly sessions: Map<string, SessionRecord>;
  /**
   * The names this process has prompted, which is what tells a record this bridge is running from a
   * record it merely loaded, since `sessions` holds both in one shape.
   *
   * Purely this process's own memory: it carries no process id and no construction time, reads
   * nothing about any other process, and reaches the file in no form. A name enters when a prompt
   * registers its record and leaves when that prompt is taken back, or when a write finds the file
   * naming a different conversation under it, so that the next prompt adopts what the file says.
   */
  private readonly prompted = new Set<string>();
  /** DSH session id to session name, for routing a notification to the turn it belongs to. */
  private readonly names = new Map<string, string>();
  private readonly live = new Map<string, LiveTurn>();
  private readonly lastNotification = new Map<string, number>();
  private harness?: DeepSeekHarness;
  private subscription?: NotificationSubscription;
  /** The spawn in progress, so two prompts arriving together start one runtime rather than two. */
  private starting?: Promise<DeepSeekHarness>;
  /** The stop in progress, so nothing spawns a runtime beside one that is still going down. */
  private stopping?: Promise<void>;
  /** The workspace the runtime was initialized with; every later prompt must name the same one. */
  private boundCwd?: string;
  /**
   * Where the state file's reader and writer say what they refused, once per distinct line.
   *
   * The file is read on every tool call and a record it refuses stays in the file, so said through
   * the plain sink the same refusal would be a line per call for the life of the process.
   */
  private readonly stateLog: (line: string) => void;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.stateLog = saidOnce(options.log);
    this.sessions = readState(options.stateFile, options.scope, this.stateLog);
  }

  /**
   * Hand one prompt to the worker and return as soon as the runtime accepts it.
   *
   * The turn is marked in flight before the prompt is sent rather than after it is accepted. The
   * runtime can finish a whole turn between the request going out and its response coming back, and
   * a turn marked in flight after that has already missed the idle that ends it: the worker's answer
   * would then reach nobody, which is this section's expensive failure.
   */
  async prompt(args: PromptArgs): Promise<PromptReceipt> {
    const name = args.session.trim();
    if (name === "") throw new Error("dsh_prompt needs a session name.");
    // Bounded here, where the value enters, and nowhere else: from this line the name is a key in
    // this bridge's maps and in the state file every bridge on the machine shares, which is refused
    // whole past its own ceiling, so an unbounded name is one prompt away from wedging persistence
    // for every bridge in every scope. Every later use of the name is bounded by this one check.
    const length = [...name].length;
    if (length > MAX_SESSION_NAME) {
      throw new Error(
        `The session name is ${String(length)} code points long, past the ${String(MAX_SESSION_NAME)} this bridge accepts. Choose a shorter name.`,
      );
    }
    if (args.text.trim() === "") throw new Error("dsh_prompt needs a non-empty text.");
    // A session map that cannot be read refuses the prompt here, before the name is recalled and
    // before the runtime is started. Recalled first, a name whose record is on the unreadable file
    // would read as new and the caller would be sent for a cwd that helps nothing, since the write
    // refuses the same map; refused only at the write, every attempt would spend a spawn and leave a
    // live child bound to the workspace that is never prompted. The write's own reading stays the
    // authoritative one, since the file can turn unreadable between this read and it; `status` and
    // `tail` keep reading the map best effort, as a report has no spawn to save.
    const fault = unreadFault(parseStateFile(this.options.stateFile, this.stateLog));
    if (fault !== undefined) throw unreadRefusal(name, fault);
    const known = this.recall(name);
    // A `cwd` that is present is read as a path, blank or not. Trimmed to nothing it would fall
    // through to the remembered workspace, and a caller that wrote one would be answered by the place
    // the worker was already running; the guard refuses the empty string, so a blank one is refused
    // by the same rule as a relative one.
    const cwd = args.cwd === undefined ? "" : workspacePath(args.cwd);
    if (cwd === undefined) {
      throw new Error(
        `cwd '${quoted(args.cwd ?? "")}' does not name a directory on this machine. It must be an absolute local path: ` +
          "a relative one, a network path, a device path and a blank are all refused.",
      );
    }
    const workspace = cwd !== "" ? cwd : known?.cwd;
    if (workspace === undefined) throw new Error(`Session '${named(name)}' is new, so dsh_prompt needs its cwd.`);
    // Checked here because the runtime is spawned with the workspace as its own working directory,
    // and a path that is not a directory fails that spawn with an error naming the node binary,
    // which reads as a broken installation rather than as a mistyped path. One stat inside a guard:
    // a directory that goes away under the check is not a directory either, and the raw error
    // would otherwise name the path to the model through the catch-all.
    if (!isDirectory(workspace)) {
      throw new Error(`Workspace '${quoted(workspace)}' is not a directory.`);
    }
    // A `record` that is present is read as a path, exactly as `cwd` is, and refused before any
    // runtime is spawned for it: `recordFilePath` is the fuller guard `record.ts`'s own append and
    // rotate hold every record path to, so the value this write is about to persist is checked no
    // less than the value this bridge will later open as a file.
    const validatedRecord = args.record === undefined ? undefined : recordFilePath(args.record);
    if (args.record !== undefined && validatedRecord === undefined) {
      throw new Error(
        `record '${quoted(args.record)}' does not name a file on this machine. It must be an absolute local path that ` +
          "does not name an existing directory: a relative one, a network path, a device path, a blank, an " +
          "existing directory and a drive that is not there are all refused.",
      );
    }
    // A shape-valid record path is still refused when it names this bridge's own state directory,
    // where `writeState` stages and renames its temporary file, or a place this machine executes or
    // reads as instructions, where an append plants text. Distinct from the shape refusal above,
    // since such a path is otherwise an ordinary absolute file `recordFilePath` admits.
    const targetRefusal = args.record !== undefined && validatedRecord !== undefined ? refusedRecordTarget(this.options.stateFile, validatedRecord) : undefined;
    if (args.record !== undefined && targetRefusal !== undefined) {
      throw new Error(`record '${quoted(args.record)}' ${targetRefusal}, so it is refused rather than being kept as a record.`);
    }
    this.refuseWrongWorkspace(name, known, workspace);
    if (this.live.has(name)) {
      throw new Error(`Session '${named(name)}' has a turn in flight. Wait for its channel event, or end it with dsh_kill.`);
    }

    const harness = await this.started(workspace);
    // Checked again on this side of the spawn, against the file as it is now. The check above reads
    // state that another prompt can change while this one waits: two prompts naming two workspaces
    // both pass the first check, because nothing is bound until one of them has started the runtime.
    const remembered = this.recall(name);
    this.refuseWrongWorkspace(name, remembered, workspace);
    if (this.boundCwd !== undefined && !samePath(this.boundCwd, workspace)) {
      throw new Error(
        `This bridge's worker is running in '${quoted(this.boundCwd)}' and one worker serves one workspace. ` +
          "Run dsh_kill first to move it.",
      );
    }
    if (this.live.has(name)) {
      throw new Error(`Session '${named(name)}' has a turn in flight. Wait for its channel event, or end it with dsh_kill.`);
    }

    const sessionId = remembered?.sessionId ?? harness.session().id;
    // The stored id was held to this shape when the file was read; the fresh one is held to it here,
    // so the two take one guard before either is written down, joined into a log path or rendered.
    if (!isSessionId(sessionId)) {
      throw new Error(`The SDK minted a session id this bridge cannot use, so no turn was started. Prompt again.`);
    }
    const turn = (remembered?.turn ?? 0) + 1;
    const live: LiveTurn = { counted: turn, receipts: new Set(), received: false, accepted: false, kept: false, observed: observed(turn) };
    const routed = this.names.get(sessionId);
    this.names.set(sessionId, name);
    this.live.set(name, live);
    // The session is remembered before the prompt goes out, because the notifications it produces
    // arrive while this call is still waiting on its own response: a `tool/call` reaching a session
    // with no `cwd` yet would report an absolute path where the receipt promises one relative to
    // the workspace, and an absolute path is this machine's shape rather than the worker's work.
    // The turn number stays as it was; the turn that is starting is counted when it finishes. The
    // name is this process's from here on: `recall` answers it from this copy rather than the file
    // until the prompt is taken back or a write finds the file naming another conversation under it.
    // The record follows the same rule the class doc states: a prompt naming one replaces what was
    // remembered, and a prompt naming none keeps it. The guard's own return is stored, exactly as
    // `workspace` stores `cwd`'s, rather than the raw argument: trimmed the same way, so a padded
    // value does not come back untrimmed on the next read.
    const record = args.record === undefined ? remembered?.record : validatedRecord;
    const written: SessionRecord = {
      sessionId,
      cwd: workspace,
      ...(record === undefined ? {} : { record }),
      turn: remembered?.turn ?? 0,
    };
    const claimed = this.prompted.has(name);
    this.prompted.add(name);
    this.sessions.set(name, written);
    // Written before the prompt goes out, so the record reaches disk while the request is out and a
    // bridge that dies inside the request leaves the id it may be running the prompt under. The count
    // is not advanced by this write; the turn that is starting reaches the count in `finish`, once it
    // is kept, and what a failed request leaves on disk is taken back by `revert` below.
    //
    // The write is a compare-and-set on the conversation identifier against the file as the write
    // itself parses it: an entry under the name carrying a different DSH session id is left as it is
    // and the name comes back as superseded, refused below. The identifier is the runtime's, never
    // this bridge's, so a name this process resumed off the file compares equal to itself, and a name
    // this process held from an earlier prompt compares unequal where the file has since been given
    // another conversation under it. What this does not do is guard a second bridge: one with no
    // record of the name adopts the file's record exactly as a restart does, which the plan requires.
    //
    // The write is two acts, a read and a publication, and a failure of each is decided on its own.
    // The read fails when the file is present and does not read under this version's rules: past the
    // ceiling, not JSON, not a session map, or refused by the filesystem. Then nothing was compared
    // and nothing was published, every bridge in the project meets the same file, and that failure
    // refuses the prompt. The publication fails after a clean read, when the sibling cannot be written
    // or the rename over the map is refused while a neighbour holds it, which clears in milliseconds.
    // That failure is said and the prompt goes on, since refusing every prompt over a file a neighbour
    // holds would cost the model its worker for as long as the neighbour keeps it, and what is lost is
    // this record's publication alone, until the write at the turn's end.
    //
    // Undo what this call registered, and only that. The routing entry may have been set by an
    // earlier turn of a remembered session whose runtime is still live, so removing it would report
    // that session as stored while its worker runs and drop every later notification for its id;
    // and the record may have been replaced while this request was out, in which case the newer one
    // is not this call's to overwrite. `release` is whether the record is also taken back from disk;
    // the one caller passing false is the read that failed, whose record never reached the file.
    const revert = (release = true): void => {
      // The routing is left alone while the name has a turn in flight, because that turn is not this
      // one: this call's turn is over by the time anything reverts it, so a live turn under the name
      // is a successor's, registered on the same id, and taking its routing would drop every
      // notification for it and leave it a turn nothing can end. Reachable only if this request's
      // rejection lands after the successor registered, which the SDK's delivery makes unlikely; the
      // guard costs nothing where it does not.
      if (!this.live.has(name) && this.names.get(sessionId) === name) {
        if (routed === undefined) this.names.delete(sessionId);
        else this.names.set(sessionId, routed);
      }
      // The record is restored only for a turn whose record was never kept. Once a concurrent kill or
      // loss has ended and counted this turn through `finish`, which counts only a kept turn, the
      // record it wrote is the current count; restoring the pre-prompt record here would undo that
      // count and the next turn would reuse its number.
      if (!live.kept && this.sessions.get(name) === written) {
        if (remembered === undefined) this.sessions.delete(name);
        else this.sessions.set(name, remembered);
        // A name this call was the first to prompt goes back to being one this process never did, so
        // its next prompt reads the file rather than this copy.
        if (!claimed) this.prompted.delete(name);
        // The same on disk, where the file still carries the id this call wrote: the record as it was
        // before this call, or no record where there was none. An entry naming another conversation
        // is somebody else's and is left as it is. Not attempted over a record that never reached the
        // file: the release would read the same unreadable map and raise the same fault again.
        if (release) this.releaseStateSafely(name, written, remembered);
      }
    };

    let superseded: ReadonlySet<string>;
    try {
      superseded = writeState(this.options.stateFile, this.options.scope, new Map([[name, written]]), this.stateLog);
    } catch (error) {
      if (error instanceof StateUnreadError) {
        this.live.delete(name);
        revert(false);
        throw unreadRefusal(name, error);
      }
      this.options.log(unwritten(error));
      superseded = new Set();
    }

    // The file names a different conversation under the name than the one this call would run, so
    // nothing was written. The claim is dropped along with the refusal, which is what makes the
    // refusal's advice true: the next prompt for the name reads the file and resumes what it names.
    // The release inside the revert finds that other conversation's entry and leaves the file as it is.
    if (superseded.has(name)) {
      this.live.delete(name);
      this.prompted.delete(name);
      revert();
      throw supersededRefusal(name);
    }

    let messageId: string;
    try {
      messageId = await this.promptRuntime(harness, sessionId, args.text);
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        // A timed-out request is one the SDK stopped waiting for, and nothing more: the client's
        // timeout ends its own wait and sends nothing, the wire has no cancel, and the SDK's
        // documentation says nothing about what the runtime does with the request. So the runtime
        // may be running the prompt, may be about to, or may have hung before it read the message,
        // and which it is cannot be known from here. What the bridge will never have is the queued
        // message id, and without it nothing the session does from here can be attributed to this
        // turn: the runtime confirms a turn by splicing its message, and a splice with no id to
        // compare against is as much somebody else's as this turn's own. So the turn is ended here
        // as an error, with the bridge's own word for why and an empty body, rather than left in
        // flight waiting on an idle it could never attribute. A held idle, one that closed the only
        // stretch seen since the prompt went out, is the same case: it may have been this turn's
        // only end, and left live the turn would sit until `dsh_kill` while the model was told to
        // wait for an event that was never coming.
        //
        // Nothing observed rides in the event, since none of it is known to be this turn's; the
        // whole of what the session said is in its log, which `dsh_tail` reads.
        //
        // The record is kept, on a first turn as on any other, and the turn is counted. A first
        // turn's id was minted by the SDK a moment ago and the runtime may or may not have opened a
        // session for it, which cannot be known from here. Whether the runtime, prompted again under
        // an id it never opened, refuses the id or opens the session then is unmeasured: the SDK's
        // own documentation says an unknown id creates the session
        // (`@deepseek-ai/dsh-sdk-client/lib/index.js:335` and `lib/types/client.d.ts:92`), no run
        // has been observed either way, and Section 5 is where the runtime is observed. The two
        // branches are not symmetric under that uncertainty. Kept, a record whose id the runtime
        // refuses costs one name its conversation, recovered by prompting under a different name.
        // Forgotten, a record whose id the runtime is running the prompt under has the next prompt
        // for the name minting a second id, and two unsandboxed workers then write one workspace at
        // once. So the record is kept.
        this.options.log(`dsh-bridge: the prompt for '${named(name)}' was not answered within its bound, so its turn ends unattributed`);
        if (this.live.get(name) === live) {
          live.kept = true;
          disown(live);
          this.finish(name, "error", "unattributed");
          // Said in the bridge's own words rather than the SDK's. The runtime's timeout text names a
          // request and nothing about the turn. The turn is said to be over rather than delivered,
          // since `finish` logs a push that fails rather than raising it, and the model's next move
          // is to read or to prompt rather than to wait, because no event for this turn is coming
          // after the one just pushed.
          throw new Error(
            `The runtime did not answer the prompt request within its bound, so turn ${String(turn)} of '${named(name)}' ` +
              "is over, ended as kind error with finish_reason unattributed; nothing is in flight. " +
              "The worker may still be running the prompt: read dsh_tail for what it does, which has no log yet if the " +
              "runtime never opened the session, and prompt again when it is quiet.",
          );
        }
        // A kill or a loss ended and reported this turn while the request was outstanding, and did
        // not count it, since the runtime had not accepted it when the sweep ran; the record set
        // before the prompt went out is taken back here as the failures below take it.
        revert();
        throw new Error(
          `The runtime did not answer within its request bound, and turn ${String(turn)} of '${named(name)}' was already ` +
            "ended by a kill or a loss of the worker; nothing is in flight. Prompt again to start a new turn.",
        );
      }
      // A kill that landed while the runtime was taking this prompt, or a runtime that died under
      // it, has already ended and reported this turn, and the request then fails because the
      // transport it was sent over is gone. The SDK's own sentence names a closed transport, which
      // reads as a broken bridge; what happened is that the worker went away, and the answer to it
      // is to prompt again. Which of the two it was is not knowable from here, and the model's next
      // move is the same either way, so the sentence names both rather than asserting the kill.
      //
      // The transport can also close under the request before the stream's end has reached `lost`,
      // in which case this turn is still the live one and nothing has reported it. The same sentence
      // is owed there: the worker is gone whichever of the two learns it first, and the turn is
      // removed here so the sweep that follows has nothing to report twice.
      const stopped = this.live.get(name) !== live;
      if (!stopped) this.live.delete(name);
      revert();
      if (stopped || error instanceof TransportClosedError) {
        throw new Error(
          `The worker was stopped or lost while it was taking this prompt for '${named(name)}'. Prompt again to start a new turn.`,
        );
      }
      throw error;
    }

    // A kill that landed while the runtime was taking this prompt, or a runtime lost under it, has
    // already reported the turn, so there is no turn left for this receipt to name and the runtime
    // it was sent to is going down. Told as a refusal, because the alternative is a receipt
    // promising a channel event that nothing will ever push.
    if (this.live.get(name) !== live) {
      // The same revert the failed request performs, for the same reason: the record was written
      // before the prompt went out and the turn it was written for is over, ended by a kill that
      // took the runtime down, so a name that had none before this call is left holding a session
      // id no live runtime is running and which the runtime that is gone may never have opened.
      revert();
      throw new Error(
        `The worker was stopped or lost while it was taking this prompt for '${named(name)}'. Prompt again to start a new turn.`,
      );
    }

    // Outside the request's own `try`: `receive` can end the turn and push its event, and a push
    // that throws is not a prompt that failed. Treated as one it would revert the state of a turn
    // that ran and was delivered, and the next prompt would then mint a second DSH session.
    this.receive(name, live, messageId);
    return { sessionId, turn };
  }

  /**
   * What is remembered about `name`: this process's own copy for a name it has prompted, and the
   * state file's record for one it has not.
   *
   * A name this process has prompted is answered from this copy and never replaced from the file.
   * Every write of that record came from here, so the file is as new as the copy or older, and
   * replacing the copy would drop the count of a turn in flight with nothing said; where the file has
   * since been given another conversation under the name, the write is what finds that out and drops
   * the claim, after which the name takes the other path. A name this process has not prompted is
   * what the file says now, since a record loaded at construction is only as current as that moment:
   * a status or a tail of it reports the file, and a prompt of it resumes the conversation the file
   * names, which is what a restart and a `dsh_kill` both rely on. A name the file does not carry
   * falls back to the copy.
   */
  private recall(name: string): SessionRecord | undefined {
    const held = this.sessions.get(name);
    if (this.prompted.has(name)) return held;
    const stored = readState(this.options.stateFile, this.options.scope, this.stateLog).get(name);
    if (stored === undefined) return held;
    this.sessions.set(name, stored);
    return stored;
  }

  /**
   * Refuse a workspace that is not the one this session name was created in.
   *
   * A DSH session belongs to the workspace it was created in: its log is filed under that workspace,
   * which is observed, and reusing its id anywhere else is inferred to be refused by the runtime,
   * which is not. No run has been observed either way, and Section 5 is where the runtime is
   * observed. The refusal does not rest on that premise. Pointing a known name at a new workspace
   * would have to abandon the conversation the state file exists to preserve, which is reason enough
   * on its own, and it holds whichever way the runtime answers: a runtime that refuses the id leaves
   * the name with a conversation it cannot reach, and one that opens a second session under it
   * leaves two workers on one name. So it is refused either way and a different workspace takes a
   * different name.
   */
  private refuseWrongWorkspace(name: string, known: SessionRecord | undefined, workspace: string): void {
    if (known === undefined || samePath(known.cwd, workspace)) return;
    throw new Error(
      `Session '${named(name)}' belongs to '${quoted(known.cwd)}' and a session's workspace is fixed for the life ` +
        "of its conversation. Use a different session name to work somewhere else.",
    );
  }

  /**
   * Note the queued message id the runtime answered with, and release an idle that arrived first.
   *
   * The runtime confirms which queued message it is running by splicing it into the session's
   * inbox, and until that confirmation an idle status belongs to whatever the session was doing
   * before this prompt: a resumed session reporting its loaded state, or a turn queued ahead of
   * this one. Ending this turn on that idle would push an empty answer and leave the real one with
   * no turn to reach. Called only with an id the runtime answered; a request that returns no id is
   * ended where it fails, since a turn with no id can never be confirmed.
   */
  private receive(name: string, live: LiveTurn, messageId: string): void {
    live.accepted = true;
    live.kept = true;
    live.messageId = messageId;
    const confirmed = live.receipts.has(messageId);
    live.received = confirmed;
    live.receipts.clear();
    // Nothing is disowned here. The splice is the boundary and `observeReceipt` disowned at it,
    // which is the only place that can: by the time this runs the runtime may have spliced the
    // message, run the whole turn and gone idle, so what the turn is holding is its own answer and
    // dropping it here would push an empty `turn_end` and leave the worker's words with no route.
    //
    // A held end that survived to this point closed the stretch the record describes, since a later
    // splice would have replaced the record and the end with it. Confirmed, that stretch is this
    // turn's and the end is delivered; unconfirmed, it was somebody else's and the end is dropped,
    // and this turn's own splice and idle are still to come. Delivered only to a live entry still
    // this one, since a kill can replace it while the request is out.
    const end = live.observed.end;
    live.observed.end = undefined;
    if (confirmed && end !== undefined && this.live.get(name) === live) this.finish(name, end.kind, end.finishReason);
  }

  /**
   * Send the prompt and return the queued message id, under the prompt's own bound.
   *
   * Through the client's `request` rather than its `prompt`, which takes no per-call bound: the
   * spec's `requestTimeoutMs` applies to every request, the `initialize` handshake among them, and a
   * prompt bound tighter than a spawn and a boot need has to be its own number. The result's shape is
   * checked here because the result is read here.
   */
  private async promptRuntime(harness: DeepSeekHarness, sessionId: string, text: string): Promise<string> {
    const result = await harness.client.request(
      "session/prompt",
      { sessionId, contentBlocks: [{ type: "text", text }] },
      this.options.runtime.promptTimeoutMs,
    );
    if (!isRecord(result) || typeof result.messageId !== "string") {
      throw new Error(`session/prompt returned no message id: ${JSON.stringify(result)}`);
    }
    return result.messageId;
  }

  /**
   * Note the runtime confirming which queued message it is running.
   *
   * The confirmation is the message being spliced into the session's inbox, which is the same
   * receipt the SDK's own `run()` waits for before it honours any notification. It can arrive
   * before the prompt request has returned the id to compare it against, so ids seen in that window
   * are held, bounded, until there is something to compare them to.
   *
   * Every splice of a message not seen before is a boundary and disowns what came before it,
   * whether or not the id can be compared yet. That is the only moment at which it can be done: a
   * runtime that splices, runs the turn and goes idle before answering the prompt request leaves
   * the whole of this turn's own work sitting behind the confirmation, and disowning at the
   * confirmation instead would throw the answer away. What sits before a splice is never this
   * turn's, whichever message the splice named, because this turn's message has not been spliced
   * yet if that one was somebody else's.
   */
  private observeReceipt(turn: LiveTurn, data: Record<string, unknown>): void {
    if (turn.received || !Array.isArray(data.inserted)) return;
    const ids = data.inserted.flatMap((message) => (isRecord(message) && typeof message.id === "string" ? [message.id] : []));
    if (turn.messageId !== undefined) {
      if (!ids.includes(turn.messageId)) return;
      // Confirmed at the splice itself, so there is no held end to release: an idle before this
      // splice closed somebody else's stretch, and `end` said so when it arrived.
      turn.received = true;
      disown(turn);
      return;
    }
    const fresh = [...new Set(ids)].filter((id) => !turn.receipts.has(id));
    if (fresh.length === 0) return;
    // Room for this notification's whole run is made from earlier notifications' ids, oldest first,
    // and never from the run itself. This bridge sends one prompt per session at a time, so its own
    // message is in the last run spliced before the request returns; a bound applied inside that run
    // would evict its first ids for its last, and when the run is longer than the bound the one id
    // the request is compared against could be among the evicted, after which the splice that would
    // confirm the turn has already come and gone and the turn is in flight for the life of the
    // process. So the set may hold this run whole, past the bound by the run's own length, and the
    // bound is restored from older ids at the next run.
    const room = Math.max(0, MAX_PENDING_RECEIPTS - fresh.length);
    for (const oldest of turn.receipts) {
      if (turn.receipts.size <= room) break;
      turn.receipts.delete(oldest);
    }
    for (const id of fresh) turn.receipts.add(id);
    // A splice of any message not seen before is a boundary and disowns what came before it.
    disown(turn);
  }

  /**
   * End a turn on an idle status, once the runtime has confirmed the turn is this bridge's own.
   *
   * An idle arriving before that confirmation belongs to whatever the session was doing when the
   * prompt reached it: a resumed session reporting its loaded state, or a turn already queued ahead
   * of this one. Ending on it would push an empty answer, delete the live entry, and leave the real
   * answer with no turn to reach. The one exception is the window where the confirmation has been
   * seen and the prompt request has not yet returned the id that matches it, where the idle is held
   * until the id arrives and settles which it was.
   */
  private end(name: string, turn: LiveTurn, kind: TurnKind, finishReason: string): void {
    if (turn.received) {
      this.finish(name, kind, finishReason);
      return;
    }
    if (turn.messageId === undefined && turn.receipts.size > 0) {
      turn.observed.end = { kind, finishReason };
      return;
    }
    // Two states reach here and the line tells them apart. With no message id and no receipt, the
    // runtime has neither answered the prompt request nor spliced anything, so the idle is the
    // session's state before the prompt reached it. With a message id and no confirmation, the
    // runtime did answer the request, and what has not happened is the splice of that message: the
    // idle closed a stretch that was not this turn's, and this turn's own splice is still to come.
    this.options.log(
      turn.messageId === undefined
        ? `dsh-bridge: an idle reached '${named(name)}' before the runtime answered its prompt request or spliced any message, so it ends no turn`
        : `dsh-bridge: an idle reached '${named(name)}' after the runtime answered its prompt request and before it spliced that message, so it ends no turn`,
    );
  }

  /** Whether any session has a turn in flight, and which. */
  busy(): { busy: boolean; sessions: string[] } {
    const sessions = [...this.live.keys()];
    return { busy: sessions.length > 0, sessions };
  }

  /**
   * What this bridge remembers about `name` right now: the same lookup `prompt` itself makes before
   * deciding what a turn without its own `record` argument writes to.
   *
   * `recall` reads this process's own copy for a name it has prompted rather than the file, and a
   * state-file write that failed is logged and never raised: `this.sessions` still carries what
   * `prompt` intended in that case, while a fresh read of the file would not. A caller resolving
   * "what record does this session write to" from a separate disk read can therefore disagree with
   * what `prompt` is about to use; this is the same lookup, so it cannot.
   */
  remembered(name: string): SessionRecord | undefined {
    // A shallow copy: `recall` can return this bridge's own live entry, the same object `finish`
    // mutates when the turn it describes ends, and a caller holding the live object would see it
    // change under it rather than reading the record as it stood at the call.
    const record = this.recall(name.trim());
    return record === undefined ? undefined : { ...record };
  }

  /**
   * What is known about one session: the record as the state file has it now, and this bridge's own
   * view of whether it holds a runtime and a turn for it.
   *
   * The record is read through `recall` rather than off this bridge's copy, because for a name this
   * process never prompted the count and the session id are the shared file's: another bridge that
   * took the name after this one loaded the file has advanced both, and a status answered from the
   * copy would report a count that is no longer the session's. `state` and `inFlight` are this
   * bridge's alone, since they describe its own runtime.
   */
  status(session: string): StatusReport {
    const name = session.trim();
    const known = this.recall(name);
    if (known === undefined) throw new Error(`No session named '${named(name)}'.`);
    // The log is read under a guard and every other field is not. What the guard covers is the
    // whole of the read: finding the file, which lists directories the runtime is writing to, and
    // opening it, which is refused past the counts-only ceiling by design and fails when the runtime
    // holds the file unshared or has rotated to a new generation since the listing. Each of those is
    // a state the log is in and not a state the session is in, and the fields above the log are what
    // tell the model whether a turn is in flight at all. `tail` keeps raising on the same read,
    // since the log is that tool's whole subject. The one thing this method still raises for is a
    // name it does not know, because a report with no subject has nothing to degrade to.
    let reading: LogReading | undefined;
    let logUnread: string | undefined;
    try {
      const file = sessionLogFile(this.options.home, known.sessionId);
      if (file !== undefined) reading = readSessionCounts(file);
    } catch (error) {
      // The fields above the log answer whether to wait, and the log is read again on the next call.
      logUnread = unreadLog(error, "the fields above are current, so retry dsh_status after the turn ends, or read dsh_tail");
    }
    const at = this.lastNotification.get(name);
    return {
      session: name,
      state: this.names.has(known.sessionId) && this.harness !== undefined ? "live" : "stored",
      sessionId: known.sessionId,
      cwd: known.cwd,
      inFlight: this.live.has(name),
      turn: this.live.get(name)?.observed.turn ?? known.turn,
      ...(at === undefined ? {} : { lastNotification: new Date(at).toISOString() }),
      ...(logUnread === undefined ? {} : { logUnread }),
      ...(reading === undefined
        ? {}
        : {
            log: {
              events: reading.events,
              turns: reading.turns,
              steps: reading.steps,
              compactions: reading.compactions,
              lastEventType: reading.lastEventType,
              permission: reading.permission,
              unreadBytes: reading.unreadBytes,
            },
          }),
    };
  }

  /** The last events of a session's log on disk, oldest first, for the session id the state file names now. */
  tail(session: string, count = DEFAULT_TAIL_COUNT, kinds?: readonly string[]): string[] {
    const name = session.trim();
    const known = this.recall(name);
    if (known === undefined) throw new Error(`No session named '${named(name)}'.`);
    let file: string | undefined;
    try {
      // Finding the file is inside the guard with reading it: the search lists directories under the
      // harness home, and a listing that fails raises an error naming that path.
      file = sessionLogFile(this.options.home, known.sessionId);
      if (file !== undefined) return readSessionLog(file, { count, kinds }).lines;
    } catch (error) {
      // Raised rather than degraded, since the log is this tool's whole subject, and rendered by the
      // rule `status` renders the same failure under: the raw error names the log's path, which runs
      // through the harness home under the operator's user name, and the tool's catch-all neutralizes
      // tags, not paths. The states behind a code are the runtime holding the file unshared or having
      // rotated it, so the next move is the status, which reads no log, and the log again after that.
      throw new Error(
        `Session '${named(name)}': ${unreadLog(error, "dsh_status reports the turn's state without the log, and the log is read again on the next dsh_tail")}`,
      );
    }
    throw new Error(`Session '${named(name)}' has no log on disk yet.`);
  }

  /**
   * Terminate the worker.
   *
   * One runtime serves every session this bridge owns, so a kill ends them all, and every turn in
   * flight is reported as killed before the child goes: a turn that stopped without a word is the
   * friction this whole plan exists to remove. What survives is the session log on disk and the
   * name-to-id map, which is what lets the next prompt resume the same conversation.
   */
  async kill(session: string): Promise<{ killed: string[] }> {
    const name = session.trim();
    // A running worker is reachable by any name the caller offers, and an unknown name is refused
    // only when there is no worker to stop. The two can part company: a first prompt for a new name
    // binds the runtime to a workspace and then meets a refusal from the runtime, whose revert
    // takes the record for a name that had none before. A kill that answered from the session map
    // alone would refuse there, leaving an unsandboxed child bound to a workspace, every prompt for
    // another one refused until the Claude session exits, and nothing the model can call to end it.
    const running = this.harness !== undefined || this.starting !== undefined;
    if (!this.sessions.has(name) && !running) throw new Error(`No session named '${named(name)}'.`);
    return { killed: await this.stop("report") };
  }

  /**
   * Shut the runtime down without reporting anything.
   *
   * The bridge dies with the Claude session that started it, so at that moment there is no session
   * left to push a channel event into; a turn in flight is lost as a turn and kept as a log.
   */
  async close(): Promise<void> {
    await this.stop("discard");
  }

  /**
   * Take the runtime down, waiting for a spawn still in flight before doing it, and report or
   * discard the turns that were running under it.
   *
   * A stop that ran while a spawn was in progress would clear the handles the spawn is about to
   * set, and the child would finish starting into a bridge that has forgotten it: a live worker
   * nothing will ever close. Waiting for it is what closes that hole and is what opens the other
   * one: a prompt that was itself waiting on that spawn runs its own continuation first, registers
   * a turn, and sends it to the runtime this stop is about to take down. So the turns are swept
   * twice, once before the wait and once after it, and a turn found in the second sweep is as
   * killed as one found in the first. Left in place it would be a turn `dsh_busy` reports as in
   * flight for the life of the process and no notification can ever end.
   *
   * `report` pushes a killed event per swept turn, which is `dsh_kill`. `discard` pushes nothing,
   * which is the bridge's own shutdown: the Claude session that would receive the event is the one
   * going away.
   */
  private async stop(live: "report" | "discard"): Promise<string[]> {
    // Held for the whole of the stop, so a prompt arriving inside it waits for the runtime to be
    // gone rather than starting a second one beside the one still working through its shutdown
    // ladder. Two stops in flight at once wait on each other for the same reason.
    while (this.stopping !== undefined) await this.stopping;
    let done = (): void => undefined;
    this.stopping = new Promise<void>((resolve) => {
      done = resolve;
    });
    const ended: string[] = [];
    const sweep = (): void => {
      for (const name of [...this.live.keys()]) {
        if (live === "discard") {
          this.live.delete(name);
          continue;
        }
        ended.push(name);
        this.finish(name, "killed", "killed");
      }
    };

    try {
      sweep();
      if (this.starting !== undefined) {
        // A start that failed leaves nothing to close, and its own caller is the one that reports it.
        await this.starting.catch(() => undefined);
      }
      sweep();
      const harness = this.harness;
      this.subscription?.close();
      this.subscription = undefined;
      this.harness = undefined;
      this.boundCwd = undefined;
      this.names.clear();
      if (harness !== undefined) await closeAll([harness], this.options.log);
    } finally {
      // The last sweep, past the close and run whatever the close did. A prompt that was already
      // waiting on the spawn this stop took down runs its own continuation somewhere inside the
      // awaits above, and where it lands relative to the sweep before them is a microtask race
      // nothing here can win reliably. A turn it registered and this stop did not sweep is one no
      // notification can ever end: the runtime it was sent to is gone and its stream is one this
      // bridge has already replaced, so `dsh_busy` would report it in flight for the life of the
      // process and every later prompt for that name would be refused. A close the runtime refused
      // is the case that needs this most: the refusal is raised to the caller, the handles are
      // already dropped, and a turn left behind would sit around a runtime this bridge no longer
      // holds while `stopping` has cleared and a fresh one can be spawned beside it.
      sweep();
      this.stopping = undefined;
      done();
    }
    return ended;
  }

  /**
   * The runtime, spawned and handshaken on first use and bound to `workspace` from then on.
   *
   * The spawn in flight is held, so two prompts arriving together wait on one runtime rather than
   * starting two, of which the second would overwrite the first and leave a child nobody closes and
   * whose notifications reach no one. What the waiting caller must not take from this is that its
   * own workspace was the one bound: that is the caller's to check on the far side of the wait.
   */
  private async started(workspace: string): Promise<DeepSeekHarness> {
    // A stop clears the handles and then waits for the child to go, and a prompt that read those
    // cleared handles inside that wait would spawn a second runtime beside a first still in its
    // shutdown ladder: two unsandboxed workers, and the one-workspace rule the design rests on
    // applying to neither.
    while (this.stopping !== undefined) await this.stopping;
    if (this.harness !== undefined) return this.harness;
    if (this.starting !== undefined) return this.starting;
    const starting = this.spawn(workspace);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async spawn(workspace: string): Promise<DeepSeekHarness> {
    // Read here rather than when the spec was built, so a missing runtime install reaches the model
    // as a failed dsh_prompt saying what to install, instead of taking the server down before the
    // channel ever registers.
    this.options.runtime.check?.();
    const harness = new DeepSeekHarness({
      launch: {
        command: this.options.runtime.command,
        args: [...this.options.runtime.args],
        // The runtime's own working directory is the workspace, because the sandbox policy's root is
        // that directory: a runtime booted elsewhere confines the worker to a place no prompt names.
        cwd: workspace,
        env: this.options.runtime.env,
        ...(this.options.runtime.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.runtime.requestTimeoutMs }),
      },
      cwd: workspace,
      provider: this.options.provider,
      model: this.options.model,
    });
    await harness.start();
    this.harness = harness;
    this.boundCwd = workspace;
    // Read after the handshake: a failed one reaps its client and swaps in a fresh instance, so a
    // subscription taken from the old one would be attached to a process that no longer exists.
    const subscription = harness.client.subscribe();
    this.subscription = subscription;
    // Detached from any caller, so a throw out of the pump or the loss handler it runs, a log sink
    // among the things that can raise one, would be an unhandled rejection that takes the process
    // down. Contained here, with a last-resort log that cannot itself do the same.
    void this.pump(subscription).catch((error: unknown) => {
      try {
        this.options.log(`dsh-bridge: the notification pump ended abnormally: ${diagnostic(error)}`);
      } catch {
        // A log sink that throws is not worth the process; there is nowhere left to report to.
      }
    });
    return harness;
  }

  /**
   * Read the runtime's notifications until it stops speaking.
   *
   * One subscription over every notification, routed by exact session id, rather than one session
   * tree per session: a session tree also delivers the statuses of the subagents the worker spawns,
   * and a subagent going idle is not the parent's turn ending. Exact-id routing is the same rule the
   * SDK's own `run()` applies to decide a turn is over.
   */
  private async pump(subscription: NotificationSubscription): Promise<void> {
    let ended: unknown;
    try {
      for await (const notification of subscription) {
        try {
          this.observe(notification);
        } catch (error) {
          // One unreadable notification is one notification. Letting it out of the loop would end
          // the stream, and the bridge would report every turn in flight as lost while the runtime
          // was still running them and still speaking. The log call is guarded on its own for the
          // same reason: a sink that throws would otherwise leave the loop from inside the catch
          // that exists to keep it, and the subscription would stay open on a runtime nothing reads.
          try {
            this.options.log(`dsh-bridge: a notification could not be read: ${diagnostic(error)}`);
          } catch {
            // Nowhere left to report to, and the stream is worth more than the line.
          }
        }
      }
    } catch (error) {
      ended = error;
    }
    // A stream this bridge replaced or closed is one whose end this bridge caused. Compared by
    // identity rather than by a flag, because the end arrives on its own turn of the event loop and
    // a flag set across a teardown's await is already false by the time it is read here.
    if (this.subscription !== subscription) return;
    await this.lost(subscription, ended);
  }

  /**
   * Take a runtime whose stream ended out of service, under the same hold a stop runs under.
   *
   * The runtime stopped speaking. Every turn it was running is lost, and the model is waiting on
   * each of them: silence here is the one failure the channel exists to prevent, so the turns are
   * ended first and the reaping waits. The next prompt spawns a fresh runtime, which may bind a
   * different workspace, so the binding goes too.
   *
   * The close is held in `stopping` for as long as it runs, which is what `started` waits on. A
   * prompt arriving while the lost runtime is still being reaped would otherwise pass that gate on
   * cleared handles and spawn a second runtime beside one still inside its shutdown ladder, which is
   * the state the stop and start pairing exists to prevent. A stop already holding the gate is
   * taking this runtime down itself, so the identity check is read again on the far side of the
   * wait.
   */
  private async lost(subscription: NotificationSubscription, ended: unknown): Promise<void> {
    while (this.stopping !== undefined) await this.stopping;
    if (this.subscription !== subscription) return;
    let done = (): void => undefined;
    this.stopping = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      // Guarded on its own, as the pump's own catch guards its line, and for a heavier reason than
      // the line is worth. Everything this method exists to do runs after it: every turn in flight
      // is ended below, and the child is reaped below that. A sink that throws here would leave the
      // model waiting on turns nothing will ever end, and leave an unsandboxed worker running with
      // no handle left to reap it by.
      try {
        this.options.log(`dsh-bridge: the runtime's notification stream ended: ${diagnostic(ended)}`);
      } catch {
        // Nowhere left to report to, and the turns and the child are worth more than the line.
      }
      const harness = this.harness;
      this.harness = undefined;
      this.subscription = undefined;
      this.boundCwd = undefined;
      this.names.clear();
      for (const name of [...this.live.keys()]) this.finish(name, "error", "runtime-lost");
      // A stream can end while the child is alive, so the child is reaped rather than assumed gone.
      // `closeAll` names a refusal itself, and nobody is waiting on this to raise one to.
      if (harness !== undefined) await closeAll([harness], this.options.log).catch(() => undefined);
    } finally {
      this.stopping = undefined;
      done();
    }
  }

  private observe(notification: HarnessNotification): void {
    const sessionId = notification.params.sessionId;
    if (typeof sessionId !== "string") return;
    const name = this.names.get(sessionId);
    if (name === undefined) return;
    this.lastNotification.set(name, Date.now());
    const turn = this.live.get(name);

    if (notification.method === "session.status") {
      // Only a turn this bridge started ends here. An idle for a session sitting idle already, or
      // one that was never prompted through this bridge, is a status and not a turn end.
      if (notification.params.status !== "idle" || turn === undefined) return;
      // `turn_end` belongs to a turn that ran to completion and to nothing else. The reason is a sum
      // type of six variants, four of which are neither a completion nor an error the runtime
      // reports as one, and `blocked` is reachable under the approval policy this bridge presets. An
      // unknown word lands here too, so a variant added upstream reads as a failure rather than as
      // an answer with an empty body.
      const kind: TurnKind = turn.observed.finishReason === "completed" ? "turn_end" : "error";
      this.end(name, turn, kind, turn.observed.finishReason || "unknown");
      return;
    }
    if (notification.method !== "session.event" || turn === undefined) return;
    const event = notification.params.event;
    if (!isRecord(event) || typeof event.type !== "string") return;
    const data = isRecord(event.data) ? event.data : {};

    if (event.type === "agent/inbox/spliced") {
      this.observeReceipt(turn, data);
      return;
    }
    if (event.type === "turn/start" && isTurnNumber(data.turn)) {
      // The runtime's own numbering, which is authoritative: the receipt's number was this bridge's
      // count, and the two part company whenever the session ran a turn this bridge did not send.
      // Held to the same shape as the stored count, since it reaches the model's `turn` attribute.
      turn.observed.turn = data.turn;
      return;
    }
    if (event.type === "turn/end") {
      turn.observed.finishReason = isRecord(data.reason) && typeof data.reason.kind === "string" ? data.reason.kind : "unknown";
      return;
    }
    if (event.type === "assistant/message") {
      const text = assistantText(data);
      if (text !== "") turn.observed.text = text;
      return;
    }
    if (event.type === "tool/call") this.observeToolCall(turn, name, data);
  }

  private observeToolCall(turn: LiveTurn, name: string, data: Record<string, unknown>): void {
    const tool = typeof data.name === "string" ? data.name : "";
    if (COMMAND_TOOLS.has(tool)) {
      turn.observed.commands += 1;
      return;
    }
    if (!WRITE_TOOLS.has(tool) || typeof data.arguments !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.arguments);
    } catch {
      // The arguments are the model's own JSON and may be anything at all. A call whose arguments do
      // not parse still ran; it just names no file this receipt can report.
      return;
    }
    if (!isRecord(parsed)) return;
    const args = parsed;
    // Own properties only. The keys are wire strings, so a plain lookup would resolve `constructor`
    // through the prototype chain and put a function where a path belongs.
    const key = PATH_KEYS.find((candidate) => Object.hasOwn(args, candidate));
    const raw = key === undefined ? undefined : args[key];
    if (typeof raw !== "string" || raw === "") return;
    const file = workspaceRelative(this.sessions.get(name)?.cwd, raw);
    if (file === undefined) {
      turn.observed.touched.extra += 1;
      return;
    }
    // Retained as the worker wrote it and neutralized once, by the event builder, at the render.
    // Deduplicated on the raw string, because two distinct paths that share their first hundred and
    // twenty code points are two paths, and a set of their cut forms would hold one of them and
    // count the other short.
    noteFile(turn.observed.touched, file);
  }

  /**
   * Close one turn and push its event, exactly once.
   *
   * The live entry is removed before the push rather than after it, so a second idle, a kill racing
   * a turn end, or a runtime loss arriving behind either one finds no turn to end and says nothing.
   * The push then happens before anything else can fail, and the turn count is reconciled in a
   * `finally`: the event is the one thing this whole channel exists to deliver, and a state file
   * that will not open is not a reason for the model never to hear the answer.
   */
  private finish(name: string, kind: TurnKind, finishReason: string): void {
    const turn = this.live.get(name);
    if (turn === undefined) return;
    this.live.delete(name);
    try {
      try {
        this.options.push(
          channelNotification({
            session: name,
            kind,
            turn: turn.observed.turn,
            finishReason,
            filesTouched: [...turn.observed.touched.named],
            filesTotal: turn.observed.touched.named.size + turn.observed.touched.extra,
            commandsRun: turn.observed.commands,
            content: turn.observed.text,
          }),
        );
      } catch (error) {
        // One delivery is one turn. This runs inside two loops that end every turn a lost runtime
        // or a kill was running, and a throw out of here would leave the rest of them in flight
        // forever, `stop` short of the close that reaps the child, and `pump`'s loop rejecting a
        // promise nobody holds, which takes the process down. The caller's own contract says a push
        // is fire and forget; this is what makes that true of a caller that does not honour it.
        this.options.log(`dsh-bridge: a finished turn for '${named(name)}' could not be delivered: ${diagnostic(error)}`);
      }
      // Guarded on its own rather than inside the push's guard, and called after it. The two are
      // different deliveries to different readers, so a channel event that could not be sent must
      // not also cost the record the answer it was going to keep, and a record that could not be
      // appended must not swallow the event the model is waiting on. The push goes first because it
      // is what tells the model the turn is over.
      try {
        this.options.onTurnEnd?.({
          session: name,
          kind,
          turn: turn.observed.turn,
          finishReason,
          text: turn.observed.text,
          accepted: turn.accepted,
        });
      } catch (error) {
        // The code alone, as `index.ts` says the party section's failure: a record write's error
        // names the record path, which is the caller's and can run through the operator's home.
        this.options.log(`dsh-bridge: a finished turn for '${named(name)}' could not be recorded (${stateFault(error)})`);
      }
    } finally {
      // The runtime's own numbering, which is authoritative and is written only here: a turn is
      // counted when it has finished, and a session that ran turns this bridge did not send is
      // ahead of anything this bridge could have counted. The stored count can also be ahead of the
      // runtime, since a turn ended unattributed is counted for a runtime that may never have run it,
      // so the runtime's number is taken in either direction: held only upward, the count would sit
      // where the unattributed turn left it and a receipt would name that turn again.
      //
      // Nothing is written for a turn whose record was not kept, which is what a kill or a loss
      // landing inside the prompt request leaves behind: the runtime that might have opened its
      // session is gone, and `prompt` takes the record back when its request fails.
      //
      // The write is the same compare-and-set as the prompt's: a name whose entry on disk now names
      // another conversation is skipped rather than refused, since this turn is over and a count
      // against a conversation this bridge is not running is not this bridge's to write. The count is
      // lost with it, `writeState` says so when it happens, and the claim to the name is dropped, so
      // the next prompt reads the file and resumes the conversation it names.
      //
      // Best effort in every case, a map that cannot be read included: the turn is over and its event
      // is pushed, a lost count harms nobody, and the prompt's write is where an unreadable map refuses.
      const known = this.sessions.get(name);
      if (turn.kept && known !== undefined && turn.observed.turn !== known.turn) {
        known.turn = turn.observed.turn;
        if (this.writeStateSafely(name, known).has(name)) this.prompted.delete(name);
      }
    }
  }

  /**
   * Write one name's record to the session map, reporting a failure rather than raising it.
   *
   * The turn's end is the caller, and its real work is delivering the turn: a file that will not
   * open, which on this platform is an ordinary consequence of another process holding it, and a file
   * that cannot be read alike must not cost it that. The write in `prompt` is not a caller, since it
   * refuses on a read that failed and takes the write under its own guard.
   *
   * One record per write, since each write is an act on one name: the file already carries every
   * other record this process wrote, from the write that wrote it. Returns the names the write
   * refused as superseded; empty after a failed write, which laid nothing down and compared nothing.
   */
  private writeStateSafely(name: string, record: SessionRecord): ReadonlySet<string> {
    try {
      return writeState(this.options.stateFile, this.options.scope, new Map([[name, record]]), this.stateLog);
    } catch (error) {
      this.options.log(unwritten(error));
      return new Set();
    }
  }

  /**
   * Take the record a prompt wrote for `name` back from the file, reporting a failure rather than
   * raising it. Called from a prompt's revert, whose real work is telling the caller why the prompt
   * failed; a record left behind is a session id the runtime may never have opened, said as such.
   */
  private releaseStateSafely(name: string, claimed: SessionRecord, previous: SessionRecord | undefined): void {
    try {
      releaseState(this.options.stateFile, this.options.scope, name, claimed, previous, this.stateLog);
    } catch (error) {
      this.options.log(
        `dsh-bridge: the record for '${named(name)}' could not be taken back from the session map, so the name may remember a session the runtime never opened (${stateFault(error)})`,
      );
    }
  }
}

/** The state file's shape: every scope on the machine, each holding its own names. */
type StoredScopes = Map<string, Map<string, SessionRecord>>;

/**
 * Every scope the state file holds, with each scope's records validated.
 *
 * A missing or unreadable file is an empty map rather than a failure: the file is this bridge's own
 * memory and a session it cannot remember is one the caller names again, while refusing to start
 * would take the channel down over a file nothing else reads. A file that exists and does not parse
 * is said out loud, because it is every session name this machine remembers and the caller would
 * otherwise meet a bridge that had quietly forgotten all of them.
 *
 * A record whose session id is not one a DSH runtime mints is dropped rather than kept, because
 * that id is joined into a filesystem path to find the session's log: the file is this bridge's own
 * and is still a file on disk that anything running as this user can write.
 */
function readScopes(parsed: unknown, log: (line: string) => void): StoredScopes {
  const scopes: StoredScopes = new Map();
  if (parsed === undefined) return scopes;
  if (!isRecord(parsed) || !isRecord(parsed.scopes)) {
    log(`dsh-bridge: the session map is not a session map, so no session is remembered while it stays so`);
    return scopes;
  }
  for (const [scope, entries] of Object.entries(parsed.scopes)) {
    if (!isRecord(entries)) continue;
    const sessions = new Map<string, SessionRecord>();
    for (const [name, value] of Object.entries(entries)) {
      const record = admittedRecord(name, value, log);
      if (record !== undefined) sessions.set(name, record);
    }
    scopes.set(scope, sessions);
  }
  return scopes;
}

/**
 * The entry under a name as a session record, or `undefined` where this bridge will not use it.
 *
 * One predicate for both readers of an entry, the reader that remembers sessions and the write that
 * compares conversation identifiers, so that what one admits the other admits. An entry the reader
 * would drop is one the write treats as free: treated as another conversation it could never be
 * replaced, since the reader would drop it, the next prompt would mint a fresh id, and the write
 * would refuse that id for as long as the entry stood. Every refusal is said through `log`, naming
 * the record and the reason and never the entry's values, which are paths.
 */
export function admittedRecord(name: string, value: unknown, log: (line: string) => void): SessionRecord | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.cwd !== "string") {
    log(`dsh-bridge: the record for '${named(name)}' is not a session record, so that session is not remembered`);
    return undefined;
  }
  if (!isSessionId(value.sessionId)) {
    log(`dsh-bridge: the record for '${named(name)}' names no DSH session id, so that session is not remembered`);
    return undefined;
  }
  // The workspace becomes an unsandboxed child's working directory and is statted before that, so
  // it is checked here exactly as a caller's own `cwd` is. A record whose workspace this bridge will
  // not open is dropped whole rather than kept with a path nothing may use: what it costs is one
  // name prompted with its `cwd` again.
  const cwd = workspacePath(value.cwd);
  if (cwd === undefined) {
    log(`dsh-bridge: the record for '${named(name)}' names no local workspace, so that session is not remembered`);
    return undefined;
  }
  // The record file is section 3's to write and is a path this file never opens. Held to the same
  // shape as the workspace so a value that cannot be used is dropped where it is read rather than at
  // the first call that joins it, and a record carrying one keeps its session. Said out loud when
  // dropped, because the next write persists the session without it and the path is then gone from
  // disk for good.
  let record: string | undefined;
  if (typeof value.record === "string") {
    record = workspacePath(value.record);
    if (record === undefined) {
      log(`dsh-bridge: the record for '${named(name)}' names a record file this bridge will not open, so the session is remembered without it`);
    }
  }
  return {
    sessionId: value.sessionId,
    cwd,
    ...(record === undefined ? {} : { record }),
    // A count off a file on disk reaches arithmetic and the model's `turn` attribute, so it is held
    // to the one shape every reader of the field applies.
    turn: isTurnNumber(value.turn) ? value.turn : 0,
  };
}

/**
 * What one read of the state file found: no file, a file present and not read, or the parsed JSON.
 *
 * Three states rather than a value or nothing, because the write decides differently on each: an
 * absent file is created, a present one that was not read is refused, and only the third is written
 * over. A reader that folded the first two into one silence would hand the write a file that is
 * simply gone as damage, and damage as a file that is simply gone.
 */
type StateReading =
  | { readonly state: "absent" }
  | { readonly state: "unread"; readonly reason: UnreadReason; readonly code?: string }
  | { readonly state: "parsed"; readonly value: unknown };

/**
 * The state file read once, as {@link StateReading} tells it.
 *
 * The size is read before the bytes are, because the file is read whole: a file grown past
 * {@link MAX_STATE_BYTES} is one this bridge did not write, and reading it into memory on every
 * `dsh_status` would be the cost its writer chose. Each failure is said once, through `log`, in the
 * words of what went wrong; a caller that wants silence passes a `log` that says nothing.
 *
 * Whether the file is there is answered by the stat and the read alone, never by an existence check
 * beside them: absent is `ENOENT` from one of those two, a positive observation, and every other
 * failure is a file present and unreadable. An existence check would answer false to any error, so a
 * present file this process cannot open would read as absent, and absent is the one reading that
 * licenses the write to create the file from this scope alone.
 */
function parseStateFile(file: string, log: (line: string) => void): StateReading {
  // The file is named by its role in every line here. Its path runs through the local application
  // data directory, which carries the operator's user name, and these lines land in a debug log.
  let text: string;
  try {
    const size = statSync(file).size;
    if (size > MAX_STATE_BYTES) {
      log(`dsh-bridge: the session map is ${String(size)} bytes, past the ${String(MAX_STATE_BYTES)} this bridge reads, so no session is remembered while it stays so`);
      return { state: "unread", reason: "oversized" };
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = stateFault(error);
    if (code === "ENOENT") return { state: "absent" };
    // The code alone, never the message, per `stateFault`. The prompt's write refuses on this state.
    log(`dsh-bridge: the session map cannot be read (${code}), so no session is remembered while it stays so`);
    return { state: "unread", reason: "unreadable", code };
  }
  try {
    return { state: "parsed", value: JSON.parse(text) };
  } catch {
    // The error is not carried: a parse failure's message quotes the bytes it choked on, which in
    // this file are session names and workspace paths, so it is the one failure here whose detail is
    // the disclosure rather than the path around it. What the operator can act on is that the file
    // does not parse, and the file is theirs to repair or remove.
    log("dsh-bridge: the session map does not parse, so no session is remembered while it stays so");
    return { state: "unread", reason: "not-json" };
  }
}

/**
 * The fault that keeps a reading from being written over, or `undefined` where the write proceeds on
 * it: an absent file, or a parsed one whose top level is an object carrying a `scopes` object. A
 * parsed file of any other shape is as unread as one that did not parse, since nothing in it can be
 * compared with or carried through. The prompt's pre-spawn check and the write itself both decide by
 * this one function, so a shape the write refuses is refused before a runtime is spent on it.
 */
function unreadFault(reading: StateReading): StateUnreadError | undefined {
  if (reading.state === "unread") return new StateUnreadError(reading.reason, reading.code);
  if (reading.state === "parsed" && (!isRecord(reading.value) || !isRecord(reading.value.scopes))) return new StateUnreadError("misshapen");
  return undefined;
}

/**
 * Every scope in the file as it was parsed, with nothing checked beyond being an object.
 *
 * What a write needs of every entry it did not author: its bytes, so it survives the write. Reading
 * the file through the validator instead would silently drop whatever this version's rules refuse,
 * which is another bridge's memory rather than this one's to discard, in this bridge's own scope as
 * much as in another. A file that cannot be read at all is one the write refuses to replace, so what
 * reaches here is a session map or nothing.
 */
function rawScopes(parsed: unknown): Record<string, unknown> {
  // Null-prototyped, as is the map the write builds from it: a scope key is a directory path off
  // disk, and on an ordinary object one spelled `__proto__` would set the prototype rather than an
  // own property, so that scope would vanish from the file on the next write with nothing said.
  const scopes: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (!isRecord(parsed) || !isRecord(parsed.scopes)) return scopes;
  for (const [scope, entries] of Object.entries(parsed.scopes)) {
    if (isRecord(entries)) scopes[scope] = entries;
  }
  return scopes;
}

/**
 * The fault that keeps the session map from being read right now, or undefined where it can be.
 *
 * `readState` turns any of these into an empty map, which is right for a report that would rather
 * show nothing than fail, and wrong for a caller that needs to tell "nothing is remembered" from
 * "nothing could be read": `prompt` itself raises this fault rather than treating it as an absence,
 * and a caller resolving a record outside `prompt` is held to the same distinction.
 */
export function stateReadFault(file: string, log: (line: string) => void = () => undefined): StateUnreadError | undefined {
  return unreadFault(parseStateFile(file, log));
}

/** One scope's session map as it sits on disk. */
export function readState(file: string, scope: string, log: (line: string) => void = () => undefined): Map<string, SessionRecord> {
  const reading = parseStateFile(file, log);
  return readScopes(reading.state === "parsed" ? reading.value : undefined, log).get(scope) ?? new Map<string, SessionRecord>();
}

/**
 * Write one scope's session map, keeping what another bridge put there.
 *
 * The file is one path per machine and a bridge is a child of every Claude session that names the
 * plugin, so several of them hold this file at once and each knows only its own sessions. Writing
 * this bridge's map over the file would delete every name another one created, which reads to that
 * session as a session that has simply forgotten itself. So the file is re-read under the write and
 * this bridge's scope is laid over what is there.
 *
 * That re-read is also what makes each name's write a compare-and-set on the conversation
 * identifier. For a record under a name against the entry the file carries for it, in this order: no
 * entry, or one the reader would not admit as a session, is written over, since it names no
 * conversation to keep; an entry naming the same DSH session id is written over, since that is the
 * same conversation and this copy is as new or newer; any other entry is left exactly as it is and
 * the name is returned as superseded, said through `log`, since the count the caller meant to write
 * is lost with it. An entry the reader would drop is treated as free rather than as another
 * conversation, because treated as another it could never be replaced: the reader would drop it, the
 * next prompt would mint a fresh id, and this write would refuse it again.
 *
 * What this buys is that this bridge never lays a different identifier over a name it is running,
 * and never writes a count against a conversation it is not running; where two bridges both read the
 * file as absent and both mint, the exclusive create refuses the loser's write and its caller is told.
 * Where the file is present the write takes no lock, so a write whose read lands inside another
 * write's parse-to-rename interval lays over it, with neither caller told; two bridges writing the one
 * file is the case that interval belongs to. It is a property of this file's contents and not a guard
 * against a second bridge, which the bridge does not guard.
 *
 * The write goes to a sibling and is renamed over the file, which is atomic, so a bridge that dies
 * mid-write leaves the previous map whole rather than a truncated one nothing can parse.
 *
 * A file that is there and does not read as a session map under this version's rules is not written
 * over at all. What it holds is every other bridge's memory, readable by a person and refused here
 * by the ceiling or by damage, and the rename would replace all of it with this one scope, in a
 * process other than the one that said anything about the file at its own start. The refusal is
 * raised to the caller, whose own failure is the one worth surfacing, and said through `log` where
 * the parse has a reason to give; the file is the operator's to repair or remove.
 */
export function writeState(
  file: string,
  scope: string,
  sessions: Map<string, SessionRecord>,
  log: (line: string) => void = () => undefined,
): ReadonlySet<string> {
  const superseded = new Set<string>();
  rewriteState(file, scope, log, (own) => {
    // Rebuilt on each pass, since the edit can run twice under one write.
    superseded.clear();
    let changed = false;
    for (const [name, record] of sessions) {
      // Admitted by the reader's own predicate, so an entry the reader would drop is free here too.
      const entry = own[name] === undefined ? undefined : admittedRecord(name, own[name], log);
      if (entry !== undefined && entry.sessionId !== record.sessionId) {
        superseded.add(name);
        log(`dsh-bridge: the record for '${named(name)}' was not written, since the name now names a different conversation; the count this bridge had for it is lost`);
        continue;
      }
      own[name] = record;
      changed = true;
    }
    return changed;
  });
  return superseded;
}

/**
 * Take the record a prompt wrote for `name` back from the file: put `previous` where it is, or
 * remove the entry when there was no record before the prompt.
 *
 * The write side of a prompt's revert. The record is written before the prompt it is for goes out,
 * so a prompt that fails after that has left a record on disk that the revert of this bridge's own
 * map cannot reach by itself. Applied only where the file still carries the session id the prompt
 * wrote: an entry naming another conversation is not this prompt's to change, and a record that
 * never reached disk leaves nothing to take back, in which case the file is not rewritten at all.
 * `previous` is the record as this bridge read it before the prompt, so what goes back is what was
 * there.
 */
export function releaseState(
  file: string,
  scope: string,
  name: string,
  claimed: SessionRecord,
  previous: SessionRecord | undefined,
  log: (line: string) => void = () => undefined,
): void {
  rewriteState(file, scope, log, (own) => {
    const current = own[name];
    if (!isRecord(current) || current.sessionId !== claimed.sessionId) return false;
    if (previous === undefined) delete own[name];
    else own[name] = previous;
    return true;
  });
}

/**
 * Re-read the file, let `edit` change this scope's entries, and publish the result when `edit` says
 * it changed something. The one mechanism under every write of the session map.
 *
 * How the result is published depends on what the read found. A parsed file is replaced by writing
 * a sibling and renaming it over the file, which is atomic, and the parse carried every other scope
 * through. An absent file is created with an exclusive create, which refuses if a file is there by
 * the time of the write: absent is the one reading under which this scope alone becomes the whole
 * file, so a reading that was wrong, or a neighbour creating the file between the read and the
 * write, must not replace what is there. On that refusal the whole edit runs once more from a fresh
 * read; a second absent reading refused the same way is reported as a read that failed with code
 * `EEXIST`, so the caller refuses rather than proceeds.
 */
function rewriteState(file: string, scope: string, log: (line: string) => void, edit: (own: Record<string, unknown>) => boolean): void {
  for (let pass = 0; ; pass += 1) {
    // Every entry the file holds is carried through exactly as it was parsed, never through this
    // version's shape rules, and the caller's records are laid over the entries of its own scope by
    // name. A record another bridge wrote in a shape this one refuses is still that bridge's memory
    // of a live conversation; validated here it would be deleted from the file with nothing said to
    // anybody. What this bridge refuses to *use* is decided where it reads. Parsed once per pass, so
    // whether the file is there at all is the same read's answer as what it holds.
    const reading = parseStateFile(file, log);
    const fault = unreadFault(reading);
    if (fault !== undefined) throw fault;
    const parsed = reading.state === "parsed" ? reading.value : undefined;
    const shaped = rawScopes(parsed);
    // Null-prototyped like the scope map, since a session name is a wire string laid onto an object.
    const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const own = shaped[scope];
    if (isRecord(own)) {
      for (const [name, entry] of Object.entries(own)) merged[name] = entry;
    }
    if (!edit(merged)) return;
    shaped[scope] = merged;
    const bytes = `${JSON.stringify({ version: 2, scopes: shaped }, undefined, 2)}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    if (reading.state === "absent") {
      try {
        writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
        return;
      } catch (error) {
        if (stateFault(error) !== "EEXIST") throw error;
        if (pass > 0) throw new StateUnreadError("unreadable", "EEXIST");
        continue;
      }
    }
    const temporary = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, bytes, "utf8");
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      // A rename over an open file is refused on this platform, which is the ordinary way this fails
      // while another bridge holds the map. The sibling is this function's own litter and would
      // otherwise sit beside the map for the life of the machine, one per process that ever failed.
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing left to do about a file that will neither be renamed nor removed, and the caller's
        // own failure is the one worth raising.
      }
      throw error;
    }
  }
}
