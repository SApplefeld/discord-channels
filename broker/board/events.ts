// The board card's event reader: what the kit's goal release stream says about blocked and
// completed plans, tailed rather than re-read whole.
//
// `~/.claude/kit-events.jsonl` is append-only under the kit's own contract: one JSON object per
// line, and past 1 MB the kit rotates it to `kit-events.jsonl.old` and starts the main path over.
// This module remembers a byte offset and reads only what was appended since the last tick, bounded
// by a per-tick cap so a burst of events costs one bounded read rather than an unbounded one. A
// tick that hits the cap mid-line leaves those trailing bytes for the next tick: the offset
// advances past complete, newline-terminated lines. The one exception is a line longer than the cap
// itself, which no single window can ever complete; that window is counted malformed and stepped
// over, because waiting for a newline that cannot arrive would wedge the reader on it for good.
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
// never joined to anything. An event whose project matches no configured root is dropped before it
// ever reaches the kept state.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
 * The most (root, plan) pairs the kept state carries, oldest insertion evicted to make room.
 *
 * `plan` comes from another program's file and its distinct values are unbounded, so without this
 * the map grows for as long as the broker runs and every tick's copy of it grows with it. The
 * ceiling is far above what the card can draw: it renders the plans found on this host's disk, and
 * a fleet of that size would overflow one Discord message many times over.
 */
export const MAX_TRACKED_PLANS = 200;

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
  return { offset: 0, identity: null, malformed: 0, latest: new Map() };
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

  const result = read(file, { offset: previous.offset, identity: previous.identity }, maxBytes);
  if ("failed" in result) {
    if (result.failed === "absent") {
      // Nothing has been written yet, or the kit's rotation briefly removed the path before
      // recreating it. Either way the next successful read should start from the top of whatever
      // file appears there.
      return {
        state: { offset: 0, identity: null, malformed: previous.malformed, latest: previous.latest },
        unreadable: false,
      };
    }
    return { state: previous, unreadable: true };
  }

  const bytes = result.bytes;
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    if (bytes.length >= maxBytes) {
      // A full window with no newline in it is one line longer than the cap. No later tick can
      // complete it either, so this window is counted and stepped over; holding here would park the
      // offset on it and freeze every event behind it for good.
      return {
        state: {
          offset: result.start + bytes.length,
          identity: result.identity,
          malformed: previous.malformed + 1,
          latest: previous.latest,
        },
        unreadable: false,
      };
    }
    // The writer's last append is still in flight. Hold at the read's own start so the next tick
    // re-reads these bytes rather than skipping past an unfinished line.
    return {
      state: {
        offset: result.start,
        identity: result.identity,
        malformed: previous.malformed,
        latest: previous.latest,
      },
      unreadable: false,
    };
  }

  const index = comparableRoots(roots);
  const complete = bytes.subarray(0, lastNewline).toString("utf8");
  let latest = previous.latest;
  let malformed = previous.malformed;

  for (const line of complete.split("\n")) {
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
    const key = eventKey(root, parsed.plan);
    if (!latest.has(key) && latest.size >= MAX_TRACKED_PLANS) {
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

  return {
    state: { offset: result.start + lastNewline + 1, identity: result.identity, malformed, latest },
    unreadable: false,
  };
}
