// The event reader both surfaces share: what the kit's goal release stream says about blocked and
// completed plans, tailed rather than re-read whole. Two folds of the same stream live here, each
// with its own offset and its own kept state: the board card's per-plan fold, keyed by (root, plan),
// and the session surface's per-session fold, keyed by session id. The offsets are independent
// because the board fold runs only when the board card is configured while the session fold runs
// whenever Discord does, and a fold that consumed the other's bytes would starve it.
//
// `~/.claude/kit-events.jsonl` is append-only under the kit's own contract: one JSON object per
// line, and past 1 MB the kit rotates it to `kit-events.jsonl.old` and starts the main path over.
// This module remembers a byte offset and reads only what was appended since the last tick, bounded
// by a per-tick cap so a burst of events costs one bounded read rather than an unbounded one. A
// tick that hits the cap mid-line leaves those trailing bytes for the next tick: the offset
// advances past complete, newline-terminated lines. The one exception is a line longer than the cap
// itself, which no single window can ever complete; that window is counted malformed and stepped
// over, because waiting for a newline that cannot arrive would wedge the reader on it for good. The
// step leaves the offset inside that line, so the reader carries a flag saying so and discards the
// bytes ahead of the next newline before it parses anything: the tail of a stepped-over line is a
// fragment of a record, and a fragment that happened to be valid JSON of the right shape would
// otherwise be kept as an event its own line never carried.
//
// A rotation shows up either as the file's identity changing or as its size falling below the
// offset, and either one restarts the read at the top. Events appended between the last consumed
// offset and the moment of rotation are lost, because `kit-events.jsonl.old` is never read. That
// loss is a residual this design accepts rather than a gap in it.
//
// The file belongs to the kit, not this broker, so every field is taken by allowlist, re-bounded to
// this reader's own length caps even though the kit already caps them, and a line that fails to
// parse into the expected shape is skipped and counted rather than thrown. Intake bounds length
// only. The kit's contract calls these fields printable ASCII and this reader does not check that,
// so control characters, newlines and bidirectional overrides survive intake untouched, and
// neutralizing them belongs to whatever renders them. `project` is the one field this reader is
// strictest about: it typically embeds the operator's OS username, so it is never logged, and it is
// matched against the configured project roots by normalized path equality alone, never opened and
// never joined to anything. In the board fold an event whose project matches no configured root is
// dropped before it ever reaches the kept state. The session fold does no root matching at all: its
// events are joined by session id against the registry downstream, so it stands on a strictly
// weaker gate than the board fold's, which holds that join plus the root match. Either way this
// feed is lower-privilege than the broker's token-gated surfaces: writing a line takes append
// access to a file in the operator's home directory and no process token at all.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clean } from "../sanitize.ts";

/** The two release kinds this card draws. Every other value the kit's contract allows is dropped,
 * not treated as malformed: the event stream may carry kinds this card simply does not track. */
export type BoardEventKind = "goal-blocked" | "goal-complete";

/**
 * One release event, already matched to a configured project root and bounded at intake.
 *
 * `root` is the configured root string as it was passed in, not the raw `project` text the kit
 * wrote: once a match is found there is no reason to keep carrying the operator's own path around,
 * and storing the canonical root makes a renderer's lookup by (root, plan) a direct one.
 */
export type BoardEvent = {
  root: string;
  plan: string;
  event: BoardEventKind;
  ts: string;
  session: string | null;
  detail: string | null;
};

/** Field caps the kit's own contract already enforces; re-applied here because another program's
 * promise is not this broker's control. `project` carries no cap because it is matched against the
 * configured roots and then discarded, so nothing of it enters the kept state. */
export const MAX_DETAIL_CHARS = 40;
export const MAX_PLAN_CHARS = 120;
export const MAX_SESSION_CHARS = 120;

/** Room for an ISO 8601 timestamp with fractional seconds and an offset, which runs to 29
 * characters. A longer value is not a timestamp; it is cut to this length, and the checks below
 * then refuse whatever the cut leaves unless that still ends in an offset and names an instant. */
export const MAX_TS_CHARS = 40;

/** Ceiling on one tick's read, well under the kit's own 1 MB rotation point so a burst of events
 * costs a bounded amount of work per tick rather than draining the whole backlog in one pass. */
export const MAX_EVENTS_READ_BYTES = 128 * 1024;

/**
 * The most (root, plan) pairs the kept state carries, the pair whose latest event landed longest ago
 * evicted to make room.
 *
 * `plan` comes from another program's file and its distinct values are unbounded, so without this
 * the map grows for as long as the broker runs and every tick's copy of it grows with it. The
 * ceiling is far above what the card can draw: it renders the plans found on this host's disk, and
 * a fleet of that size would overflow one Discord message many times over.
 */
export const MAX_TRACKED_PLANS = 200;

/**
 * The most sessions the session fold's kept state carries, the session whose latest event landed
 * longest ago evicted to make room. The reasoning is `MAX_TRACKED_PLANS`': session ids come from
 * another program's file and their distinct values are unbounded, so without a ceiling the map grows
 * for as long as the broker runs and every tick's copy of it grows with it.
 *
 * What the ceiling counts is distinct session ids seen across the events file's whole rotation
 * window, on every project on the host, not sessions running at once. A host that starts many short
 * runs reaches it far sooner than its concurrency suggests.
 *
 * Reaching it has a visible cost: an evicted session's standing block is forgotten, so a session
 * that was drawn blocked stops being drawn blocked while it is still waiting on a person. That is
 * the accepted trade for a bounded map, and the bound sits far above what a host holds in one
 * rotation window.
 */
export const MAX_TRACKED_SESSIONS = 200;

/**
 * The reader's persisted state: the byte offset already consumed, the identity of the file that
 * offset counts bytes of, a tally of the intake this reader stepped over, and the latest kept event
 * per (root, plan) pair.
 *
 * `identity` is what makes a rotation visible when the replacement file has already regrown past
 * the old offset, which a size check alone cannot see. It is null when the platform reports no
 * usable inode, and then a shrink is the only rotation signal left.
 *
 * `latest` is never mutated in place, and a read that keeps nothing returns the previous instance
 * rather than a copy of it, so a caller holding the previous state can compare by reference to
 * decide whether anything it draws moved.
 */
export type EventReaderState = {
  offset: number;
  identity: string | null;
  /**
   * True when `offset` sits inside a line whose beginning was stepped over, which happens only for a
   * line longer than the whole read cap. The next read discards its bytes up to the first newline, so
   * the tail of that line is never parsed as a record of its own.
   */
  midLine: boolean;
  /**
   * The running count of skipped intake: one per complete line that failed to parse into the
   * expected shape, and one per full window stepped over for a line longer than the read cap. A
   * line that long raises the count once for every window it spans, because a window that holds no
   * newline cannot tell how much more of the same line lies ahead of it.
   */
  malformed: number;
  latest: Map<string, BoardEvent>;
};

/** A fresh reader with nothing consumed yet, the correct starting point for a file never read
 * before and equally correct for one that does not exist. */
export function initialEventState(): EventReaderState {
  return { offset: 0, identity: null, midLine: false, malformed: 0, latest: new Map() };
}

/** Where a tick's read resumes from: the bytes already consumed and the file identity they were
 * consumed from. */
export type EventReadPosition = { offset: number; identity: string | null };

/**
 * What one capped, positional read of the events file yields.
 *
 * The bytes come back raw rather than decoded, because the offset is measured in them: decoding
 * first and re-encoding to find the last newline would move the offset by three bytes for every
 * invalid byte in the file, which hands the file's writer control of where the next read begins.
 *
 * `start` is the byte offset the read actually began at, which differs from the requested offset
 * exactly when a rotation was detected. `identity` names the file those bytes came from.
 */
export type CappedRead =
  | { bytes: Buffer; start: number; identity: string | null }
  | { failed: "absent" | "unreadable" };

export type ReadEventsOptions = {
  /** Overrides the resolved default path. */
  path?: string;
  /** Overrides the per-tick read cap. */
  maxBytes?: number;
  /** The one read this module performs. Injected so a test can pin what bytes come back without a
   * real file, mirroring `broker/usage/cache.ts`'s `readFile` seam. */
  readFile?: (file: string, from: EventReadPosition, maxBytes: number) => CappedRead;
};

export type ReadEventsResult = {
  state: EventReaderState;
  /** True when this tick's read failed for a reason other than the file being absent (a permission
   * refusal, a read that failed after the open succeeded). The state is carried through unchanged;
   * the caller may draw or log the failure without treating it as a crash. */
  unreadable: boolean;
};

/**
 * Where the events file lives when nothing overrides it: `~/.claude/kit-events.jsonl`. Resolved the
 * way `broker/usage/cache.ts`'s `defaultUsageRoot` resolves its root, with `env` a parameter
 * throughout so a test never reads the operator's real home.
 *
 * The `CHANNEL_BOARD_EVENTS_PATH` override is read in `broker/config.ts` and applied there, beside
 * every other knob, because the installer's allowlist is pinned against the knobs that file reads: a
 * knob read anywhere else can be dropped from the allowlist without a test noticing, and a dropped
 * entry is a knob an installed broker can never receive.
 */
export function defaultEventsPath(env: NodeJS.ProcessEnv = process.env): string {
  // A blank `USERPROFILE` is treated as absent: taking it would build a relative path, which
  // resolves against whatever directory the broker was launched from rather than against a home
  // directory.
  const profile = env.USERPROFILE;
  const home = profile !== undefined && profile.trim() !== "" ? profile : os.homedir();
  return path.join(home, ".claude", "kit-events.jsonl");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-blank string, or null. Blank counts as absent: a field the kit's contract requires that
 * arrives empty is not a value this reader can use. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The first `max` UTF-16 units of a value, less one when that cut would land between the halves of
 * a surrogate pair. A lone surrogate is not a character: it renders as a replacement glyph or
 * throws at whatever encodes it next, so one dropped astral character is the cheaper end.
 */
function bound(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The explicit UTC offset a kept timestamp has to end with, in either the separated or the compact
 * form. `Date.parse` reads a date-time carrying none as the host's local time, so the same event
 * line would name instants hours apart on two machines and the blocked marker, which clears by
 * comparing a plan doc's modification time against this stamp, would clear by that much early or
 * late. The kit writes these stamps with `toISOString`, so requiring the offset costs an honest
 * line nothing and refuses only shapes this reader cannot place on a timeline, loose non-ISO prose
 * that `Date.parse` accepts included. This mirrors `broker/usage/cache.ts`'s `OFFSET`.
 */
const TS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

type ParsedLine = {
  ts: string;
  event: BoardEventKind;
  project: string;
  plan: string;
  session: string | null;
  detail: string | null;
};

/**
 * One line parsed against the kit's contract. `"malformed"` is a line this reader cannot place at
 * all (bad JSON, not an object, a required field missing, the wrong type, or a `ts` that carries no
 * explicit offset or names no instant). `null` is a line that parses cleanly but names an event kind this card does not track,
 * which is not malformed: the kit's contract allows kinds beyond the two this reader keys on.
 *
 * `project` comes back exactly as written. It is matched against the configured roots and then
 * dropped, so bounding it would only make a real project path past the bound fail to match the root
 * it names.
 */
function parseLine(line: string): ParsedLine | "malformed" | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "malformed";
  }
  if (!isRecord(value)) return "malformed";

  const ts = text(value["ts"]);
  const kind = text(value["event"]);
  const project = text(value["project"]);
  const plan = text(value["plan"]);
  const rawSession = value["session"];
  if (ts === null || kind === null || project === null || plan === null) return "malformed";
  if (rawSession !== null && typeof rawSession !== "string") return "malformed";

  // The timestamp is the one intake value read as more than text: the blocked marker clears when a
  // plan doc's modification time passes it, and a value that names no instant compares false
  // against every time there is, which would leave a marker standing for as long as the broker
  // runs. A line carrying one is malformed rather than kept with a timestamp nothing can use.
  const stamp = bound(ts, MAX_TS_CHARS);
  if (!TS_OFFSET.test(stamp) || Number.isNaN(Date.parse(stamp))) return "malformed";

  if (kind !== "goal-blocked" && kind !== "goal-complete") return null;

  const rawDetail = value["detail"];
  if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") return "malformed";

  return {
    ts: stamp,
    event: kind,
    project,
    plan: bound(plan, MAX_PLAN_CHARS),
    session: typeof rawSession === "string" ? bound(rawSession, MAX_SESSION_CHARS) : null,
    detail: typeof rawDetail === "string" ? bound(rawDetail, MAX_DETAIL_CHARS) : null,
  };
}

// Windows filesystems do not distinguish a path's case, and the drive letter a path arrives with
// depends on which shell launched the session that wrote it, so a case-sensitive comparison there
// would drop every event of a project over a letter.
const FOLD_PATH_CASE = process.platform === "win32";
const TRAILING_SEPARATORS = /[\\/]+$/;

/**
 * One path in the form every comparison of two roots is made in: separators normalized, a
 * trailing separator dropped so a root configured with one still names the same directory, and case
 * folded where the platform does not distinguish it.
 *
 * A path that is nothing but separators keeps them, because the alternative is comparing the empty
 * string against the empty string and matching everything that reduces to it.
 *
 * This is a string operation throughout. Nothing here opens, resolves, or asks the filesystem
 * anything about a value another program wrote.
 *
 * Exported because the configured list is deduplicated through this same form in
 * `broker/config.ts`. Two spellings of one directory have to collapse there exactly as they match
 * here, and a second normalizer that could disagree with this one is how a root ends up drawn twice
 * with the events landing on only one of the two.
 */
export function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  const trimmed = normalized.replace(TRAILING_SEPARATORS, "") || normalized;
  return FOLD_PATH_CASE ? trimmed.toLowerCase() : trimmed;
}

/** The configured roots keyed by their comparable form, built once per tick so a line's cost is one
 * lookup rather than a pass over the whole list. The first root to claim a key keeps it. */
function comparableRoots(roots: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    const key = comparablePath(root);
    if (!index.has(key)) index.set(key, root);
  }
  return index;
}

/** The configured root `project` names by normalized path equality, or null when it names none. */
function matchRoot(project: string, roots: Map<string, string>): string | null {
  return roots.get(comparablePath(project)) ?? null;
}

/**
 * The kept state's key for one (root, plan) pair.
 *
 * The separator is a NUL because both halves are free-form text that can hold anything a filesystem
 * or a plan filename allows, spaces included. Any separator either half could contain would let two
 * different pairs produce one key, and the card would then attribute one project's plan to another.
 */
export function eventKey(root: string, plan: string): string {
  return `${root}\u0000${plan}`;
}

/**
 * How a file is told apart from the file that replaces it at the same path: its device and inode.
 * Null where the platform reports no inode, which leaves the size check as the only rotation signal
 * rather than pinning every file to one identity that never changes.
 *
 * Both halves are BigInts because a Windows file id fills 64 bits, and at that magnitude a double
 * spaces its values 1024 apart: read as numbers, two files whose ids differ by less than that round
 * to one identity, and the rotation this identity exists to catch becomes invisible.
 *
 * Exported for the test that pins that precision, which no pair of real files can be built to
 * demonstrate on demand.
 */
export function fileIdentity(stat: { dev: bigint; ino: bigint }): string | null {
  return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
}

/**
 * One capped, positional read starting at `from.offset`, at most `maxBytes` long.
 *
 * A rotation restarts the read at the top of the file rather than at the stale offset, and it is
 * recognized two ways: the file at the path is a different file than the offset was counted in, or
 * the file is smaller than the offset. The identity check is what catches a replacement that has
 * already been written past the old offset by the time this reader looks, where the size check
 * alone would resume in the middle of the new file's stream. The caller learns a restart happened
 * from the returned `start`, which is 0 in that case.
 *
 * An absent file is reported distinctly from an unreadable one so the caller can treat "nothing
 * written yet" as the ordinary case it is, rather than as a failure.
 *
 * The close carries its own guard rather than a bare `finally`, the same discipline as the usage
 * cache's capped read: a close that throws there must not replace the read already in hand.
 */
function readAppended(file: string, from: EventReadPosition, maxBytes: number): CappedRead {
  let size: number;
  let identity: string | null;
  try {
    // The stat is taken in BigInt form for the file id alone. The size crosses back to a number
    // here, at the one place it is converted, because every other term of the positional read (the
    // offset, the cap, the read length) is a number, and the kit rotates this file at 1 MB, far
    // below where a number stops counting bytes exactly.
    const stat = statSync(file, { bigint: true });
    size = Number(stat.size);
    identity = fileIdentity(stat);
  } catch (err) {
    return isRecord(err) && err["code"] === "ENOENT" ? { failed: "absent" } : { failed: "unreadable" };
  }

  const rotated =
    identity !== null && from.identity !== null && identity !== from.identity ? true : size < from.offset;
  const start = rotated ? 0 : from.offset;
  const length = Math.max(0, Math.min(maxBytes, size - start));
  if (length === 0) return { bytes: Buffer.alloc(0), start, identity };

  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return { failed: "unreadable" };
  }
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, start);
    return { bytes: buffer.subarray(0, read), start, identity };
  } catch {
    return { failed: "unreadable" };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that will not close is the operating system's problem, not the reader's: the bytes
      // already in hand are still good and there is nothing left here to do about the descriptor.
    }
  }
}

/**
 * Where a fold's reader stands: the bytes consumed, the file those bytes were counted in, whether
 * the offset sits inside a stepped-over line, and the running malformed tally. It is every field of
 * a fold's state except the kept map, which is the one thing the two folds do not share.
 */
type ReaderPosition = { offset: number; identity: string | null; midLine: boolean; malformed: number };

/**
 * What one tick's window yields a fold: either the complete, newline-terminated lines it holds and
 * the position to resume from, or a halt that keeps whatever the fold already had.
 *
 * A halt covers every case where a tick has no complete line to fold: the file is absent, the read
 * failed, the window held a line longer than the cap and stepped over it, or the writer's last
 * append is still in flight. `unreadable` rides the halt because it is the caller's to report.
 */
type EventWindow =
  | { lines: string; position: ReaderPosition }
  | { halted: ReaderPosition; unreadable: boolean };

/**
 * The read-and-split half of a tick, which both folds run identically: the capped positional read,
 * the rotation restart, the discard of a stepped-over line's tail, and the extraction of the
 * complete lines from the window.
 *
 * The two folds differ only in what they do with those lines, so the machinery that decides which
 * bytes are a record at all lives here once. A change to the mid-line discipline or the rotation
 * rule that reached only one fold would leave the two reading the same file by different rules.
 */
function readWindow(
  file: string,
  previous: ReaderPosition,
  maxBytes: number,
  read: (file: string, from: EventReadPosition, maxBytes: number) => CappedRead,
): EventWindow {
  const result = read(file, { offset: previous.offset, identity: previous.identity }, maxBytes);
  if ("failed" in result) {
    if (result.failed === "absent") {
      // Nothing has been written yet, or the kit's rotation briefly removed the path before
      // recreating it. Either way the next successful read should start from the top of whatever
      // file appears there.
      return {
        halted: { offset: 0, identity: null, midLine: false, malformed: previous.malformed },
        unreadable: false,
      };
    }
    return { halted: previous, unreadable: true };
  }

  // The flag rides the offset, so a read that restarted at the top of a rotated file drops it: those
  // bytes are the beginning of a line, whatever the old offset stood in the middle of.
  const midLine = previous.midLine && result.start === previous.offset;
  const bytes = result.bytes;
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    if (bytes.length >= maxBytes) {
      // A full window with no newline in it is one line longer than the cap. No later tick can
      // complete it either, so this window is counted and stepped over; holding here would park the
      // offset on it and freeze every event behind it for good.
      return {
        halted: {
          offset: result.start + bytes.length,
          identity: result.identity,
          midLine: true,
          malformed: previous.malformed + 1,
        },
        unreadable: false,
      };
    }
    // The writer's last append is still in flight. Hold at the read's own start so the next tick
    // re-reads these bytes rather than skipping past an unfinished line.
    return {
      halted: { offset: result.start, identity: result.identity, midLine, malformed: previous.malformed },
      unreadable: false,
    };
  }

  // What the tail of a stepped-over line ends at, and where a whole line therefore begins.
  const from = midLine ? bytes.indexOf(0x0a) + 1 : 0;
  return {
    lines: bytes.subarray(from, lastNewline).toString("utf8"),
    position: {
      offset: result.start + lastNewline + 1,
      identity: result.identity,
      midLine: false,
      malformed: previous.malformed,
    },
  };
}

/**
 * Advances the reader by one tick: reads whatever was appended since `previous.offset`, folds each
 * complete line into the kept state keyed by (root, plan), and returns that state. `previous` is
 * never mutated, and a tick that keeps nothing hands back its very map.
 *
 * `roots` is the configured project list for this tick; an event whose `project` matches none of
 * them is dropped before it is ever kept, so a plan from an unconfigured project can never surface
 * on the card. Only the newest event per pair survives a tick and across ticks, because the map
 * assignment for a key always overwrites: a `goal-blocked` that re-emits at every blocked stop
 * collapses to its latest occurrence, and a `goal-complete` for the same pair, however it lands
 * relative to those blocks, is exactly the value a card wants to end up showing.
 */
export function readEvents(
  previous: EventReaderState,
  roots: readonly string[],
  options: ReadEventsOptions = {},
): ReadEventsResult {
  const file = options.path ?? defaultEventsPath();
  const maxBytes = options.maxBytes ?? MAX_EVENTS_READ_BYTES;
  const read = options.readFile ?? readAppended;

  const window = readWindow(file, previous, maxBytes, read);
  if ("halted" in window) {
    // A read that failed hands back the caller's own state object, not a copy of it: a caller that
    // compares state by identity to decide whether anything moved must see nothing move.
    if (window.unreadable) return { state: previous, unreadable: true };
    return { state: { ...window.halted, latest: previous.latest }, unreadable: false };
  }

  const index = comparableRoots(roots);
  let latest = previous.latest;
  let malformed = window.position.malformed;

  for (const line of window.lines.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseLine(line);
    if (parsed === "malformed") {
      malformed += 1;
      continue;
    }
    if (parsed === null) continue;
    const root = matchRoot(parsed.project, index);
    if (root === null) continue;

    // The copy is made on the first event actually kept, so a tick that keeps none returns the
    // previous map itself and a caller comparing by reference sees nothing moved.
    if (latest === previous.latest) latest = new Map(previous.latest);
    // Deleted before it is set, because a map keeps a key in the slot it was first inserted at: a
    // pair kept fresh by a run that blocks over and over would otherwise stand at the old end of the
    // map and give way ahead of pairs nothing has said anything about for days.
    const key = eventKey(root, parsed.plan);
    latest.delete(key);
    if (latest.size >= MAX_TRACKED_PLANS) {
      const oldest = latest.keys().next();
      if (oldest.done !== true) latest.delete(oldest.value);
    }
    latest.set(key, {
      root,
      plan: parsed.plan,
      event: parsed.event,
      ts: parsed.ts,
      session: parsed.session,
      detail: parsed.detail,
    });
  }

  return { state: { ...window.position, malformed, latest }, unreadable: false };
}

/**
 * One goal event kept for a session, with the instant its stamp names already resolved.
 *
 * `tsMs` is `Date.parse` of `ts`, computed once at intake rather than at every comparison a caller
 * makes. It is a number by construction: `parseLine` refuses a stamp that carries no explicit UTC
 * offset or names no instant, so the value reaching here has already parsed once. A line whose
 * instant is later than the read's own clock never reaches this state at all: `readSessionEvents`
 * drops it, so every kept instant is one that can be compared honestly against an engagement.
 *
 * `plan` rides along because the surface that draws a blocked session names the plan the run stopped
 * on, and the session fold keeps no project of its own.
 */
export type SessionGoalEvent = {
  event: BoardEventKind;
  ts: string;
  tsMs: number;
  plan: string;
};

/**
 * The session fold's persisted state: its own byte offset, the identity of the file that offset
 * counts bytes of, its own mid-line flag and malformed tally, and the latest kept goal event per
 * session id.
 *
 * Every field means what its `EventReaderState` counterpart means. They are held separately rather
 * than shared because the two folds advance on different schedules, and one offset serving both
 * would let whichever fold ticked first consume the bytes the other never saw.
 *
 * `latest` is never mutated in place, and a read that keeps nothing returns the previous instance
 * rather than a copy of it, so a caller holding the previous state can compare by reference.
 */
export type SessionEventReaderState = {
  offset: number;
  identity: string | null;
  midLine: boolean;
  malformed: number;
  latest: Map<string, SessionGoalEvent>;
};

/** A fresh session fold with nothing consumed yet, the correct starting point for a file never read
 * before and equally correct for one that does not exist. */
export function initialSessionEventState(): SessionEventReaderState {
  return { offset: 0, identity: null, midLine: false, malformed: 0, latest: new Map() };
}

export type ReadSessionEventsOptions = ReadEventsOptions & {
  /** The clock a stamp is admitted against: a line naming an instant later than it is dropped.
   * Injected so a test can pin the gate without waiting on real time; the board fold takes no such
   * knob, because its far-future defense lives at its render site. */
  now?: () => number;
};

export type ReadSessionEventsResult = {
  state: SessionEventReaderState;
  /** True when this tick's read failed for a reason other than the file being absent. The state is
   * carried through unchanged; the caller may draw or log the failure without treating it as a
   * crash. */
  unreadable: boolean;
};

/**
 * Advances the session fold by one tick: reads whatever was appended since `previous.offset` and
 * folds each complete line into the kept state keyed by session id. `previous` is never mutated, and
 * a tick that keeps nothing hands back its very map.
 *
 * There is no root filtering here: a session is matched by session id against the registry
 * downstream, so an event from a project this broker was never configured with reaches nothing.
 * That makes this feed a lower-privilege one than the token-gated surfaces the broker otherwise
 * takes input from. Anything with append access to the operator's home directory can write a line
 * here, no process token is involved, and no project root narrows what is kept. What bounds it is
 * the join: a line surfaces only when its session id, normalized the way the registry normalizes
 * the ids it stores, names a session this broker is already tracking. The `plan` it carries is
 * attacker-shaped text on that path, bounded here and neutralized where it is rendered. The kit's
 * own writer normalizes `plan` to a repo-relative path, which is what the surfaces expect, but that
 * is an expectation of an honest writer rather than a guarantee of this reader; the render site's
 * escaping is what holds when it does not.
 *
 * The session key is normalized through `clean`, the same sanitizer every id the registry stores
 * passes through, so the two sides of that join cannot miss over whitespace or a control character
 * one of them strips and the other keeps. A value that is blank after cleaning names no session. A
 * value that reaches the intake bound is dropped rather than kept, because `parseLine` truncates at
 * that bound and a truncated id cannot be told from a whole one of exactly that length: a truncated
 * id matches no session at best, and at worst collides with another and attributes one session's
 * block to it. A line whose instant is later than the read's clock is dropped too, for the reason
 * at the gate below. None of these drops is malformed; the kit's contract allows the line.
 *
 * Only the newest event per session survives, because the map assignment for a key always
 * overwrites. A `goal-complete` landing after a `goal-blocked` is what clears a run that finished,
 * and a `goal-blocked` landing after a `goal-complete` stands again, which is a run that reopened.
 */
export function readSessionEvents(
  previous: SessionEventReaderState,
  options: ReadSessionEventsOptions = {},
): ReadSessionEventsResult {
  const file = options.path ?? defaultEventsPath();
  const maxBytes = options.maxBytes ?? MAX_EVENTS_READ_BYTES;
  const read = options.readFile ?? readAppended;
  const now = options.now ?? Date.now;

  const window = readWindow(file, previous, maxBytes, read);
  if ("halted" in window) {
    // A read that failed hands back the caller's own state object, not a copy of it: a caller that
    // compares state by identity to decide whether anything moved must see nothing move.
    if (window.unreadable) return { state: previous, unreadable: true };
    return { state: { ...window.halted, latest: previous.latest }, unreadable: false };
  }

  let latest = previous.latest;
  let malformed = window.position.malformed;
  // One clock reading for the whole window: the lines below were all on disk before this read
  // began, so a single ceiling holds for every one of them.
  const readAt = now();

  for (const line of window.lines.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseLine(line);
    if (parsed === "malformed") {
      malformed += 1;
      continue;
    }
    if (parsed === null) continue;
    if (parsed.session === null) continue;
    // A stamp naming a moment after this read is dropped whole. On one machine's clock an honest
    // line is always written before it is read, so a future instant is either crafted or a clock
    // this reader cannot reason about, and no stamp it admits should outrank engagements that have
    // not happened yet. Dropped rather than clamped, because a clamped line read forever-fresh:
    // the fold re-reads from byte 0 after every restart, and a far-future line clamped to each
    // restart's own clock would ping again every time. Not malformed either; the shape is legal,
    // the instant is not usable.
    const tsMs = Date.parse(parsed.ts);
    if (tsMs > readAt) continue;
    // The over-bound drop is measured on the value as parsed, before cleaning: parseLine cuts a
    // long id to exactly the bound, and cleaning can shrink a cut one back below it, so a
    // post-clean measurement would keep an id indistinguishable from a truncated one.
    if (parsed.session.length >= MAX_SESSION_CHARS) continue;
    // The key the downstream join is made on, in the registry's own form for it.
    const session = clean(parsed.session);
    if (session === "") continue;

    // The copy is made on the first event actually kept, so a tick that keeps none returns the
    // previous map itself and a caller comparing by reference sees nothing moved.
    if (latest === previous.latest) latest = new Map(previous.latest);
    // Deleted before it is set, because a map keeps a key in the slot it was first inserted at: a
    // session kept fresh by a run that blocks over and over would otherwise stand at the old end of
    // the map and give way ahead of sessions nothing has said anything about for days.
    latest.delete(session);
    if (latest.size >= MAX_TRACKED_SESSIONS) {
      const oldest = latest.keys().next();
      if (oldest.done !== true) latest.delete(oldest.value);
    }
    latest.set(session, {
      event: parsed.event,
      ts: parsed.ts,
      tsMs,
      plan: parsed.plan,
    });
  }

  return { state: { ...window.position, malformed, latest }, unreadable: false };
}
