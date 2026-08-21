// Broker configuration, resolved entirely from the environment so an installed service can be
// pointed at a different port or state file without editing source.
import os from "node:os";
import path from "node:path";
import { comparablePath, defaultEventsPath } from "./board/events.ts";

export type BrokerConfig = {
  /** Bound on 127.0.0.1 only. The listener is never exposed off-box. */
  port: number;
  /** Human label for the machine, carried on every session record for the Discord surfaces. */
  host: string;
  /** Absolute path to the persisted registry snapshot. */
  stateFile: string;
  /** A session with no hook traffic and no relay liveness for this long is marked stale. */
  staleAfterMs: number;
  /** How often the staleness sweep runs. */
  sweepIntervalMs: number;
  /**
   * Hard cap on a body posted to the /hook liveness route. That route is nearly content-free: of
   * the payload it is posted, it keeps the session's identity, its tool's name, one bounded
   * preview of that tool's input, and the Stop payload's task table, which the status card
   * renders. Anything larger is drained and dropped with a 202 rather than refused, since a
   * refusal is a visible error inside the session whose hook posted it; nothing over the cap is
   * ever assembled or parsed. The wiring floors the /hook ceiling at `mirrorMaxBytes` below,
   * because both routes receive the same Stop payload and only the /hook copy carries the roster;
   * this knob on its own governs the relay routes.
   */
  maxBodyBytes: number;
  /**
   * How often each attached relay is pinged. It is also the bound on the acceptance criterion that
   * a closed relay marks its session ended: a socket that closes cleanly is noticed at once, and
   * this is the backstop for a pipe that is gone without having said so.
   */
  relayHeartbeatMs: number;
  /** How long an ended or stale record is kept before the sweep prunes it. */
  retainTerminalMs: number;
  /** Ceiling on total records. Terminal records are evicted oldest first to hold it. */
  maxSessions: number;
  /** Absolute path to the rotating log file. Logging falls through to the console when null. */
  logFile: string | null;
  /** Rotate the log file once it reaches this size. */
  logMaxBytes: number;
  /** Total log files kept on disk, the active one plus its rotated predecessors. */
  logMaxFiles: number;
  /**
   * Whether the mirror intake posts console prompts and turn replies to the session's thread. Off,
   * the mirror route still answers 202 and drops everything, because the installed hooks post to it
   * from every session on the machine and a refused post is a visible error inside that session.
   */
  mirror: boolean;
  /**
   * Body ceiling for the mirror route alone. Separate from maxBodyBytes, which keeps governing the
   * /hook liveness route: a mirror body carries a whole turn's reply, and a reply past this
   * ceiling is drained and dropped with a 202 rather than refused, since a 413 surfaces as a visible
   * error inside the session at the end of exactly the longest turns.
   */
  mirrorMaxBytes: number;
  /**
   * Whether the transcript tailer mirrors mid-turn assistant text to a session's thread. Gated
   * by `mirror` as well, at the wiring rather than here: interim mirroring is mirroring, so the
   * host-wide off switch takes both down together.
   */
  interimMirror: boolean;
  /** How often the tailer polls live sessions' transcripts for new mid-turn text. */
  interimPollMs: number;
  /**
   * How long the question desk holds a credited AskUserQuestion hook response open for a thread
   * answer before releasing it to the console picker with a no-decision `{}`.
   */
  questionHoldMs: number;
  /**
   * How a background task's wake prompt reaches a session's thread. When a subagent finishes while
   * its parent session is idle, the harness wakes the session by injecting a prompt that carries
   * the subagent's entire final report, and the mirror would post the whole report into the thread
   * as if the operator had typed it. `brief` compresses that wake-up to a one-line notice, `full`
   * mirrors the whole report exactly as an ordinary prompt, and `off` posts nothing at all.
   */
  taskNotifications: "brief" | "full" | "off";
  /**
   * Whether a session's model change posts on the alert tier, with the mention that reaches the
   * operator's phone, rather than on the notice tier. Off by default: a model change is worth
   * reading rather than worth waking someone for, and whether the quiet tier is loud enough on a
   * phone is a question only live use answers, so the louder setting is an env change rather than a
   * code round.
   */
  modelChangeAlert: boolean;
  /**
   * Whether the broker owns a fleet usage card: one thread in the configured channel carrying every
   * account's usage windows and every live session on this host. Off by default, and off is the
   * absence of the machinery rather than a check inside it: no thread is created, no refresh timer
   * runs, and claude-swap's files are never opened.
   */
  usageCard: boolean;
  /** How often the fleet card is re-read and re-rendered. An edit is spent only when it changed. */
  usageCardRefreshMs: number;
  /**
   * claude-swap's backup directory, for an install that does not keep it under the user profile.
   * Null leaves the reader on its own default.
   */
  usageCacheRoot: string | null;
  /**
   * Whether the broker owns a fleet board card: one thread in the configured channel carrying every
   * open plan under the configured project roots. Off by default, and off is the absence of the
   * machinery rather than a check inside it: no thread is created, no refresh timer runs, and no plan
   * doc or event stream is ever opened.
   */
  boardCard: boolean;
  /**
   * The project roots the board card sweeps. The card draws them newest touch first rather than in
   * this order, and this order is what settles every project the touch order leaves unsettled: two
   * roots whose newest plan moved at the same instant, two with no plan the card can date at all,
   * and where a root that is not on this list sits among the ones that are. Configuration and never
   * derived: the card reads `docs/plans` directly under each of these and nothing else, and no value
   * out of any file it reads is ever used as a path. Empty leaves the card unbuilt even with the knob
   * on, since there is nothing to sweep.
   */
  boardProjects: readonly string[];
  /** How often the fleet is re-swept and re-rendered. An edit is spent only when it changed. */
  boardCardRefreshMs: number;
  /** The kit's goal event stream, resolved from `CHANNEL_BOARD_EVENTS_PATH` or from the home
   * directory, and absolute either way. One stream, two readers: the board card's per-plan fold and
   * the session surface's blocked fold both read this path, so redirecting the knob redirects the
   * whole stream rather than splitting the two folds onto two files. Absent on disk is the ordinary
   * case, not an error: the card then draws no blocked markers and no session stands blocked. */
  boardEventsPath: string;
};

/**
 * Exported because it is a shared literal, not a private default: hooks/settings-fragment.json
 * hardcodes this port into every http hook URL and hooks/session-start.ps1 falls back to it, and a
 * hook pointed at a port nothing listens on fails silently. settings-fragment.test.ts pins the
 * fragment against this value so the three cannot drift apart.
 */
export const DEFAULT_PORT = 8787;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
// 256KB. The measured ceiling it must clear is a real turn's final reply, observed whole at ~35K
// characters; the headroom above that is for a reply several times longer, not for arbitrary data.
const DEFAULT_MIRROR_MAX_BYTES = 256 * 1024;
// The floor is the operational hazard: the mirror route answers 202 whether or not the body fit,
// so a ceiling small enough to drop every post is indistinguishable from nobody typing. 64KB keeps
// every ordinarily-sized turn deliverable; the 4MB ceiling bounds what one post can make the
// broker buffer.
const MIN_MIRROR_MAX_BYTES = 64 * 1024;
const MAX_MIRROR_MAX_BYTES = 4 * 1024 * 1024;
// The latency bar for mid-turn narration is tens of seconds: it exists so a long turn is not
// silence, not so the thread streams. Each pass costs a stat and a bounded read per live session.
const DEFAULT_INTERIM_POLL_MS = 20 * 1000;
// The floor keeps a typo like "100" from turning the poll into a near-busy loop over every live
// session's transcript. The ceiling exists because Node clamps a setInterval delay past 2^31-1
// down to 1ms, which would turn an over-large value into exactly that busy loop; five minutes is
// where narration stops answering anything an operator is still asking, and past it
// CHANNEL_INTERIM_MIRROR=off is the honest spelling.
const MIN_INTERIM_POLL_MS = 1_000;
const MAX_INTERIM_POLL_MS = 5 * 60 * 1000;

/**
 * Four hours. Exported because it is a shared contract, not a private default: the installed
 * fragment's PreToolUse `timeout` must exceed every legal hold so the release is always the
 * broker's clean `{}` rather than a CLI-side timeout error, and settings-fragment.test.ts pins the
 * fragment against this value so the two cannot drift apart.
 */
export const DEFAULT_QUESTION_HOLD_MS = 4 * 60 * 60 * 1000;
// A near-zero hold is today's behavior with extra steps; below a second the release would race the
// alert that makes the hold worth keeping.
const MIN_QUESTION_HOLD_MS = 1_000;
// The ceiling is the default on purpose: the fragment pin only holds the default under the
// installed PreToolUse timeout, so an env override may shorten the hold but never push it past the
// margin the pin guarantees. Raising this ceiling means raising the fragment timeout with it.
const MAX_QUESTION_HOLD_MS = DEFAULT_QUESTION_HOLD_MS;

/**
 * How long the relay waits on a silent stream before it presumes the pipe is dead and reconnects.
 *
 * Exported because it lives in the other process: relay/broker.ts is the only reader, and the two
 * cannot see each other's configuration. The heartbeat below is clamped against it here, because a
 * heartbeat slower than this timeout means every quiet relay drops and reconnects forever, and
 * nothing at runtime would report that as anything but a working session.
 */
export const RELAY_READ_TIMEOUT_MS = 60 * 1000;

/**
 * How long the relay waits with no byte at all on a reply's response before it presumes the broker
 * has stopped answering and reports the reply as failed.
 *
 * Exported for the reason the read timeout above is: the value is read in relay/broker.ts, in the
 * other process, and the two cannot see each other's constants.
 *
 * It measures silence rather than elapsed time, which is what makes one number cover every reply.
 * A reply waits on its thread's ordering chain and nothing bounds what is queued ahead of it, so no
 * arithmetic over one run's own cost can bound the wait; what can be bounded is how long the broker
 * may go without saying anything, and the reply route writes a heartbeat while a run is in flight
 * precisely so this timer measures the broker's liveness.
 */
export const RELAY_REPLY_IDLE_MS = 30 * 1000;

/**
 * How often the reply route writes a heartbeat byte into a response whose run is still going.
 *
 * Derived rather than chosen, because the two numbers live in different processes and nothing at
 * runtime would report them as crossed: a heartbeat slower than the relay's idle window means every
 * reply that outlasts one window is reported failed while its messages are still going up, and what
 * a model does with a bare failure is send the answer again over the top of what landed. A third of
 * the window leaves room for one heartbeat lost to scheduling before the reply pays for it.
 */
export const REPLY_HEARTBEAT_MS = Math.floor(RELAY_REPLY_IDLE_MS / 3);

/** Room for two missed heartbeats inside the relay's read timeout before it gives up on the pipe. */
const MAX_RELAY_HEARTBEAT_MS = Math.floor(RELAY_READ_TIMEOUT_MS / 3);
const MIN_RELAY_HEARTBEAT_MS = 1_000;
const DEFAULT_RELAY_HEARTBEAT_MS = 15 * 1000;
// A minute between reads of two small local files, which is the cadence the card's own contents
// move at: claude-swap polls on its own schedule and a session's age line is drawn in minutes.
const DEFAULT_USAGE_CARD_REFRESH_MS = 60 * 1000;
// The floor keeps a typo from turning the refresh into a stream of Discord edits on a fleet that is
// changing every few seconds. The ceiling is the point past which the card stops being a live
// surface, and it also holds the value inside what setInterval accepts, since Node clamps a delay
// past 2^31-1 down to 1ms, which would turn an over-large value into a busy loop.
const MIN_USAGE_CARD_REFRESH_MS = 5 * 1000;
const MAX_USAGE_CARD_REFRESH_MS = 60 * 60 * 1000;
// A minute, which is the resolution every age the board card draws is rounded to: a faster refresh
// buys nothing the operator can see. Its bounds are the fleet card's, and for the same two reasons:
// the floor keeps a typo from turning the refresh into a stream of Discord edits, and the ceiling
// both holds the card a live surface and keeps the value inside what setInterval accepts, since Node
// clamps a delay past 2^31-1 down to 1ms.
const DEFAULT_BOARD_CARD_REFRESH_MS = 60 * 1000;
const MIN_BOARD_CARD_REFRESH_MS = 5 * 1000;
const MAX_BOARD_CARD_REFRESH_MS = 60 * 60 * 1000;
// One list, one entry per project root. A semicolon rather than a colon or a comma because a Windows
// path carries a drive letter and a colon with it, and a comma is a legal character in a directory
// name.
const PROJECT_SEPARATOR = ";";
const DEFAULT_RETAIN_TERMINAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_MAX_FILES = 5;

function integerAtLeast(raw: string | undefined, minimum: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`expected an integer of at least ${minimum}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Refuses rather than clamps, the same way `integerAtLeast` does. A knob silently moved to a value
 * the operator did not ask for is a knob whose behavior nobody can reason about later.
 */
function bounded(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `expected an integer between ${minimum} and ${maximum}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

const FLAG_TRUE: readonly string[] = ["1", "true", "yes", "on"];
/**
 * Exported because broker/intake.ts's per-request `X-Channel-Mirror` header reads the same off
 * vocabulary this config knob does. A second literal would let the two drift: a header spelling
 * accepted here but not there would flip a session's mirror state depending on which of the two
 * paths reads it.
 */
export const FLAG_FALSE: readonly string[] = ["0", "false", "no", "off"];

/**
 * Refuses rather than guesses, holding the same line the numeric knobs hold: a boolean knob read
 * permissively turns a typo like `CHANNEL_MIRROR=fasle` into whichever default the parser leans
 * toward, and a knob silently moved is a knob whose behavior nobody can reason about later.
 *
 * Exported for the same reason `FLAG_FALSE` is: broker/discord/config.ts's own knobs read this one
 * vocabulary rather than a second literal. Two parsers that admit different spellings mean a host
 * writing `on` for one knob gets true and for another gets a silent false, which is a
 * configuration the operator cannot reason about from the file they wrote.
 */
export function strictFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (FLAG_TRUE.includes(value)) return true;
  if (FLAG_FALSE.includes(value)) return false;
  throw new Error(
    `expected one of ${[...FLAG_TRUE, ...FLAG_FALSE].join(", ")}, got ${JSON.stringify(raw)}`,
  );
}

const TASK_NOTIFICATION_MODES: ReadonlyArray<"brief" | "full" | "off"> = ["brief", "full", "off"];

/**
 * Refuses rather than guesses, holding the line `strictFlag` holds: the value is a three-way
 * choice rather than a flag, so a typo like `CHANNEL_TASK_NOTIFICATION=freif` read permissively
 * would silently land on whichever mode the parser leaned toward, and a knob silently moved is a
 * knob whose behavior nobody can reason about later.
 */
function taskNotificationMode(raw: string | undefined): "brief" | "full" | "off" {
  if (raw === undefined || raw.trim() === "") return "brief";
  const value = raw.trim().toLowerCase();
  const mode = TASK_NOTIFICATION_MODES.find((candidate) => candidate === value);
  if (mode !== undefined) return mode;
  throw new Error(
    `expected one of ${TASK_NOTIFICATION_MODES.join(", ")}, got ${JSON.stringify(raw)}`,
  );
}

// A Windows path names the same place from every process only when it leads with a drive letter or a
// UNC root. `path.isAbsolute` takes a leading separator as well, and `\one` resolves against
// whichever drive the broker was launched from, which under a scheduled task is no drive the
// operator chose.
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|[\\/][\\/])/;

/** True only for a value that names one file or directory whatever the process's launch state was. */
function namesOneDirectory(root: string): boolean {
  if (!path.isAbsolute(root)) return false;
  return process.platform === "win32" ? WINDOWS_ROOT.test(root) : true;
}

/**
 * The board card's project roots, in the order they were written.
 *
 * Refuses an entry that does not name one fixed directory rather than resolving one, holding the line
 * the flag and numeric knobs hold: such a root resolves against whatever directory or drive the
 * broker was launched from, which under a scheduled task is neither of the operator's choosing, and a
 * card silently sweeping the wrong tree is a card nobody can reason about from the file they wrote. A
 * blank entry is not an error, so a list written with a trailing separator means what it looks like.
 *
 * The refusal names the entry's position and never its text: a project root typically embeds the
 * operator's OS username, and this message reaches the log file.
 *
 * Two entries naming one directory collapse to the first spelling of it, compared in the form the
 * board card's event reader compares a root in: separators normalized, a trailing separator dropped,
 * and case folded on Windows. That is the same form on purpose. A duplicate surviving here is drawn
 * as a second project block whose rows never take a blocked marker, because the reader folds the two
 * spellings together and keys its events to the first.
 */
function projectRoots(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  const written = raw.split(PROJECT_SEPARATOR);
  for (const [index, entry] of written.entries()) {
    const root = entry.trim();
    if (root === "") continue;
    if (!namesOneDirectory(root)) {
      throw new Error(
        `expected absolute project roots separated by "${PROJECT_SEPARATOR}", ` +
          `entry ${String(index + 1)} of ${String(written.length)} names no fixed directory`,
      );
    }
    const key = comparablePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

/**
 * The kit's goal event stream: the configured path, or the one under the home directory when nothing
 * names another.
 *
 * A configured path is held to the same rule a project root is, and for the same reason: a relative
 * or drive-relative path resolves against whatever directory or drive the broker was launched from,
 * which under a scheduled task is neither of the operator's choosing, and a card reading the wrong
 * file (or reading nothing and drawing no blocked markers at all) is a card nobody can reason about
 * from the value they wrote. The computed default is absolute already.
 *
 * The refusal never echoes the value: this path typically sits under the operator's own profile, and
 * this message reaches the log file.
 */
function eventsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.CHANNEL_BOARD_EVENTS_PATH?.trim();
  if (configured === undefined || configured === "") return defaultEventsPath(env);
  if (!namesOneDirectory(configured)) {
    throw new Error("expected an absolute path, the value names no fixed file");
  }
  return configured;
}

/**
 * The state file lives outside the repository by default: the broker is installed as a service
 * and its runtime state is not source.
 */
function defaultStateFile(env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA ?? os.homedir();
  return path.join(base, "sapplefeld-channels", "broker-state.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return {
    // Zero is legal only here, where it means "any free port" and is what the tests bind. Every
    // other knob would be degenerate at zero: a zero sweep interval is a busy loop, a zero stale
    // timeout marks every session stale, and a zero body cap refuses every post.
    port: integerAtLeast(env.CHANNEL_BROKER_PORT, 0, DEFAULT_PORT),
    host: env.CHANNEL_HOST_NAME?.trim() || os.hostname(),
    stateFile: env.CHANNEL_BROKER_STATE?.trim() || defaultStateFile(env),
    staleAfterMs: integerAtLeast(env.CHANNEL_STALE_AFTER_MS, 1, DEFAULT_STALE_AFTER_MS),
    sweepIntervalMs: integerAtLeast(env.CHANNEL_SWEEP_INTERVAL_MS, 1, DEFAULT_SWEEP_INTERVAL_MS),
    maxBodyBytes: integerAtLeast(env.CHANNEL_MAX_BODY_BYTES, 1, DEFAULT_MAX_BODY_BYTES),
    relayHeartbeatMs: bounded(
      env.CHANNEL_RELAY_HEARTBEAT_MS,
      MIN_RELAY_HEARTBEAT_MS,
      MAX_RELAY_HEARTBEAT_MS,
      DEFAULT_RELAY_HEARTBEAT_MS,
    ),
    retainTerminalMs: integerAtLeast(env.CHANNEL_RETAIN_TERMINAL_MS, 1, DEFAULT_RETAIN_TERMINAL_MS),
    maxSessions: integerAtLeast(env.CHANNEL_MAX_SESSIONS, 1, DEFAULT_MAX_SESSIONS),
    // Unset by default: a broker run at a terminal (every test, every local debugging session)
    // keeps using the console output it always had. An installed service (S7) sets this to a path
    // outside the repository, the same way the state file above resolves outside it, because under
    // a scheduled task there is no console attached to catch what console.log and console.error
    // write.
    logFile: env.CHANNEL_BROKER_LOG_FILE?.trim() || null,
    logMaxBytes: integerAtLeast(env.CHANNEL_BROKER_LOG_MAX_BYTES, 1024, DEFAULT_LOG_MAX_BYTES),
    logMaxFiles: integerAtLeast(env.CHANNEL_BROKER_LOG_MAX_FILES, 1, DEFAULT_LOG_MAX_FILES),
    mirror: strictFlag(env.CHANNEL_MIRROR, true),
    mirrorMaxBytes: bounded(
      env.CHANNEL_MIRROR_MAX_BYTES,
      MIN_MIRROR_MAX_BYTES,
      MAX_MIRROR_MAX_BYTES,
      DEFAULT_MIRROR_MAX_BYTES,
    ),
    // On by default: the operator reported the mid-turn silence, and a feature that ships off
    // answers nothing. The host-wide CHANNEL_MIRROR gate is applied where the tailer is wired.
    interimMirror: strictFlag(env.CHANNEL_INTERIM_MIRROR, true),
    interimPollMs: bounded(
      env.CHANNEL_INTERIM_POLL_MS,
      MIN_INTERIM_POLL_MS,
      MAX_INTERIM_POLL_MS,
      DEFAULT_INTERIM_POLL_MS,
    ),
    questionHoldMs: bounded(
      env.CHANNEL_QUESTION_HOLD_MS,
      MIN_QUESTION_HOLD_MS,
      MAX_QUESTION_HOLD_MS,
      DEFAULT_QUESTION_HOLD_MS,
    ),
    // Brief by default: the console renders these wake-ups compactly, and a thread louder than
    // the terminal it mirrors is the reported failure. `full` is the escape hatch for an operator
    // who wants the whole report in the thread.
    taskNotifications: taskNotificationMode(env.CHANNEL_TASK_NOTIFICATION),
    modelChangeAlert: strictFlag(env.CHANNEL_MODEL_CHANGE_ALERT, false),
    // Off by default: the card reads another program's files and opens a thread of its own in the
    // operator's channel, and neither belongs on a host that never asked for it.
    usageCard: strictFlag(env.CHANNEL_USAGE_CARD, false),
    usageCardRefreshMs: bounded(
      env.CHANNEL_USAGE_CARD_REFRESH_MS,
      MIN_USAGE_CARD_REFRESH_MS,
      MAX_USAGE_CARD_REFRESH_MS,
      DEFAULT_USAGE_CARD_REFRESH_MS,
    ),
    usageCacheRoot: env.CHANNEL_USAGE_CACHE_ROOT?.trim() || null,
    // Off by default for the reason the fleet card is: the card reads the plan docs of every
    // configured project and opens a thread of its own in the operator's channel, and neither
    // belongs on a host that never asked for it.
    boardCard: strictFlag(env.CHANNEL_BOARD_CARD, false),
    boardProjects: projectRoots(env.CHANNEL_BOARD_PROJECTS),
    boardCardRefreshMs: bounded(
      env.CHANNEL_BOARD_CARD_REFRESH_MS,
      MIN_BOARD_CARD_REFRESH_MS,
      MAX_BOARD_CARD_REFRESH_MS,
      DEFAULT_BOARD_CARD_REFRESH_MS,
    ),
    // Read here rather than where the file is opened, so the installer's env allowlist pin, which
    // scans this file for the knobs it must carry, sees this one too.
    boardEventsPath: eventsPath(env),
  };
}
