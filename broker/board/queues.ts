// The persona queue reader: what each worker persona on this machine has queued, taken from the
// persona plugin's own store and heartbeat under that worker's working folder, plus the plan
// document each queue entry names.
//
// The store is written whole, with no rename and no lock, so a read can land mid-write. A store or
// heartbeat that fails to read or fails to parse keeps whatever the last good tick returned rather
// than going blank, and the instant that hold began rides out beside the reading so the card can say
// the group is stale. Both files are held on modification time and size as well, so a file that has
// not moved is not read or parsed again. A file whose open the machine refused is the exception:
// that refusal says nothing about the bytes at that stat, so the next tick opens the file again.
//
// Everything a persona's store holds is untrusted text. The persona writes that file, and this
// module runs in the broker's process under the operator's account, so a value taken out of it never
// becomes a path. The join below takes a file name and nothing else: a name that fails one fixed
// pattern yields no plan reading at all, and a name that passes it is looked for in exactly four
// places under that persona's own `workdir`, which came from the operator's roster rather than from
// the store. `path.join` is fed a name the pattern has already proved holds no separator and no
// parent segment, so no reading can reach outside `workdir` whatever the store says.
//
// That text is bounded here as well as distrusted. Every free-text field a queue entry carries on
// is held to an intake cap on the way out of this module, because everything downstream of it walks
// those values in full on every refresh tick while this module parses them only when the file moves.
// Without the caps one store's oversized value costs the status rule several folds and the renderer
// a spread of the whole value, on the broker's only event loop, for as long as the file stays as
// written. Two fields carry no such cap: `id` leaves as the store wrote it, since a prefix cut would
// fold two distinct ids into one identity, and `planSegment` is a reduction rather than a cut, so a
// separator-free `planPath` reaches it uncut. `textPlanName` is bounded by the pattern that finds it
// rather than by an intake cap, to about 254 code points. The join's search for a plan name runs at
// intake over the uncut text, so no cap narrows the search and no tick repeats it. Neutralizing the
// same values stays the renderer's job, as it is for a plan document's own prose: nothing is escaped
// here.
//
// Nothing here is logged but a static failure-class word. A `workdir`, a store path and a plan path
// all embed the operator's OS account name, and the log is a lower-trust surface than the card.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { parsePlan, readPlanFile } from "./plans.ts";
import type { PlanParse, PlanRead, PlanReading } from "./plans.ts";
import type { RosterPersona } from "./roster.ts";

/** The persona plugin's store, under a persona's own working folder. Keyed by persona name. */
export const STORE_FILE_NAME = ".agentic-personas.json";

/** The persona plugin's heartbeat file, under that same folder. Keyed by persona name too. */
export const HEARTBEAT_FILE_NAME = ".agentic-heartbeat.json";

/**
 * Ceiling on the store and on the heartbeat. The store carries a persona's whole working memory
 * beside its queue, so it is the largest file this module opens by a wide margin: the fleet's
 * largest today runs to tens of kilobytes, and this is headroom against one that has grown a problem
 * rather than a bound anyone should expect to approach. Past it the file is refused whole rather
 * than parsed as the prefix that fit.
 */
export const MAX_STORE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The most queue entries one persona contributes, in queue order. The card draws a handful of
 * entries and folds the rest into one line, and the join costs a stat per entry, so a store whose
 * queue has run away is cut here rather than walked in full on every refresh tick.
 */
export const MAX_QUEUE_ENTRIES = 200;

/**
 * What the free-text values one queue entry carries are held to before they leave this reader.
 *
 * Each is a single value out of a file this module reads whole, so any of them can arrive as the
 * whole of what `MAX_STORE_FILE_BYTES` allows. They sit far below what a consumer could afford to
 * hold: a store reading is kept across ticks and folded back into every refresh, so a cap-sized
 * value reaching one is re-walked on every tick by everything downstream of here. The status rule
 * trims and case-folds `status`, `kind` and `lead.state` several times per entry per tick, and the
 * card measures `title` and a block reason in full before it cuts either.
 *
 * Every cap is a multiple of the bound the card draws that value at, so a value a worker really
 * wrote arrives here whole and is cut by the card alone. The plan name an entry's text carries is
 * taken before any cap applies, so a cap never decides whether an entry joins to its plan.
 */
export const MAX_INTAKE_TITLE_LENGTH = 240;
export const MAX_INTAKE_REASON_LENGTH = 480;

/**
 * What the identifier-shaped values are held to: a store status, an entry kind and a lead state.
 *
 * Each is compared on its trimmed, case-folded value against a short word and is never drawn, so a
 * prefix cut here cannot change any comparison's answer: a value longer than this cap differed from
 * every word it is compared against before the cut and still does after it.
 */
export const MAX_INTAKE_WORD_LENGTH = 60;

/**
 * One queue entry as the store holds it, with every field validated on its own.
 *
 * Only `id` is required: it is the handle `activeGoalId` names and the key a plan reading is filed
 * under, and an entry the controller wrote always carries one. Every other field is absent from real
 * stores today except `title`, `status`, `kind` and `createdAt`, so each is read as optional and a
 * value of the wrong type is dropped rather than carried on as itself.
 *
 * `title` is free text a harness seeded, not an operator-written label: it carries newlines and
 * markup, and neutralizing it is the renderer's job, as it already is for a plan doc's own `Next:`
 * value. The store's `objective` is free text too, and it is read at intake for the plan name it
 * may carry and not carried on at all. `kind`, `title`, `status`, `blockedReason` and both `lead`
 * strings arrive whitespace-collapsed and held to their own caps above, which is a bound on what
 * this reader hands on and not a claim about what the store holds. `id` arrives as the store wrote
 * it, and `planSegment` and `textPlanName` are names reduced out of the store's values rather than
 * cut from them.
 */
export type QueueEntry = {
  readonly id: string;
  readonly kind?: string;
  readonly title: string;
  readonly status?: string;
  readonly blockedReason?: string;
  readonly pausedByNudgeCap?: boolean;
  readonly sortKey?: number;
  readonly createdAt?: number;
  /**
   * What the store's `planPath` reduced to: its final path segment, a string. Null when the store
   * wrote a value that names no final segment, and absent when it wrote none, wrote something other
   * than a string, or wrote one that is empty or nothing but whitespace. The join reads all three
   * and takes `textPlanName` under the absent state alone.
   */
  readonly planSegment?: string | null;
  /**
   * The first plan name the store's `title` names, else the first its `objective` names, searched
   * in the values as the store wrote them before either is cut. Absent when neither is a string
   * naming one. The join reads it only when `planSegment` is absent.
   */
  readonly textPlanName?: string;
  readonly lead?: { readonly state?: string; readonly reason?: string };
};

/**
 * What the join found for one queue entry.
 *
 * A plan found under a live plans folder yields the existing `PlanReading`, with `root` set to the
 * persona's `workdir` rather than to a configured project root. One found only in an archive folder
 * yields the archived flag and no parse at all: the card draws such an entry as done, so the file's
 * contents would change nothing and reading them would cost the whole file.
 *
 * `heldSince` is null for a parse taken this tick, and for one whose document this tick confirmed
 * unmoved, which is as current as one read this tick. It is the instant the parse was last known to
 * describe the file when the reading is a hold handed back over a document that failed to read or
 * parse this tick, so the card can say how old what it draws from that entry is.
 */
export type QueuePlanReading =
  | ({ readonly archived: false; readonly heldSince: number | null } & PlanReading)
  | {
      readonly archived: true;
      readonly root: string;
      readonly path: string;
      readonly stem: string;
    };

/** One persona's reading for one tick. */
export type PersonaQueue = {
  readonly name: string;
  readonly workdir: string;
  /** The entries the store holds for this persona, in queue order, capped at `MAX_QUEUE_ENTRIES`. */
  readonly entries: readonly QueueEntry[];
  /** The entry the plugin's controller counts as active, or null. Names an entry that may not be in
   * `entries` at all, since the cap and the entry rules both bound what comes back. */
  readonly activeGoalId: string | null;
  /** `monitor.lastTurnComplete` from the store: when the worker last finished a turn. */
  readonly lastTurnComplete: number | null;
  /** The heartbeat's `turnStartedAt`: a number while the worker is inside a turn, null otherwise. */
  readonly turnStartedAt: number | null;
  /** The plan reading for each entry that named one, by entry id. An entry naming no plan, or one
   * whose plan is in none of the four places, has no key here. */
  readonly readings: ReadonlyMap<string, QueuePlanReading>;
  /** When the store reading in hand began to be held, or null when it is this tick's own. Null as
   * well for a persona whose store has never once been read, since there is nothing being held. */
  readonly heldSince: number | null;
};

export type QueueReaderOptions = {
  /** Injected so a test can pin what this module logs. Never carries a path or a `workdir`. */
  log?: (message: string) => void;
  /** The clock the hold instant is stamped from. Injected so a test can pin that instant. */
  now?: () => number;
  /** The one stat the join performs. Injected so a test can pin exactly which paths are tried. */
  statPlan?: (file: string) => PlanStat | null;
  /** The one read the join performs. Injected so a test can pin exactly which files are opened. */
  readPlan?: (file: string) => PlanRead;
  /** The one read the store and the heartbeat take. Injected so a test can pin what each failure
   * class costs the ticks after it, an open the operating system refuses among them. */
  readStore?: (file: string, maxBytes: number) => CappedRead;
};

export type QueueReader = {
  read: (personas: readonly RosterPersona[]) => readonly PersonaQueue[];
};

/** One file's modification time and size, which is the whole of what a hold is keyed on. */
export type PlanStat = { mtimeMs: number; sizeBytes: number };

/** What one capped read yields: the file's text, or why there is none. */
export type CappedRead = { text: string } | { failed: "unreadable" | "oversized" };

/**
 * One read of at most `maxBytes`, into a buffer one byte larger so an oversized file is recognized
 * by the read itself rather than by a stat the file could have outgrown in between. The buffer is
 * uninitialized because only the bytes the read actually returned are ever decoded.
 *
 * The read repeats until the buffer fills or a read returns nothing, because one `readSync` is
 * allowed to return fewer bytes than asked for and a network filesystem does. Stopping at the first
 * short read would hand the parser a prefix of the file under the name of the whole.
 *
 * A failure at any stage reports "unreadable", which covers an absent file, a permission refusal,
 * and a read that failed after the open succeeded. The distinction changes nothing the caller does,
 * and the errors themselves are discarded unread because each carries the path.
 *
 * The close carries its own guard rather than riding a bare `finally`: a close that throws there
 * replaces whatever the read produced.
 */
function readCappedFile(file: string, maxBytes: number): CappedRead {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return { failed: "unreadable" };
  }
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(handle, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    if (filled > maxBytes) return { failed: "oversized" };
    return { text: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { failed: "unreadable" };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that will not close is the operating system's problem, not the card's: the reading
      // in hand, good or bad, is already decided.
    }
  }
}

/**
 * The modification time and size of one file, or null when it cannot be stat'd or is not a regular
 * file. A directory, a symbolic link to one, or a FIFO standing at a plan's name is not a plan and
 * is never opened. The stat follows a symbolic link, so a link to a regular file is a regular file
 * here, where the sweep's own listing reads a dirent and refuses every link whatever it points at.
 *
 * This runs before the read, the direction `statPlanFile` in `plans.ts` takes and for the same
 * reason: a write landing between the two leaves the stat older than the bytes parsed, so the next
 * tick sees a newer stat than the one it recorded and reads again.
 */
function statFile(file: string): PlanStat | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

// The name kept from a queue entry, whatever it was taken from. Anchored whole: one leading
// alphanumeric, then name characters alone, then the `.md` suffix. No separator of either spelling
// and no bare parent segment can satisfy it, which is what makes the join's `path.join` safe.
//
// The flag reaches the suffix alone, both character classes already holding either case. It folds
// there because the sweep's own listing in `plans.ts` lists `SPEC_V1.MD` as a plan: a name the
// folder view draws and the join refuses would be two answers to what a plan file is called.
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$/i;

// The name a queue entry's free text names, matched non-greedily and stopped before a trailing name
// character, so `docs/plans/a_b_v1.md, which lives on a branch` and `... a_b_v1.md.` both keep
// `a_b_v1.md` and leave the punctuation outside the name.
const PLAN_IN_TEXT = /docs\/plans\/([A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-])/;

// Either separator spelling, because a store written on this platform carries both.
const PATH_SEPARATOR = /[\\/]/;

// The `.md` suffix, matched without regard to case, as `plans.ts` matches it.
const MARKDOWN_SUFFIX = /\.md$/i;

// A file whose whole stem case-folds to this is a directory index rather than a plan, the rule the
// sweep applies to `README.md` under `docs/plans`.
const EXCLUDED_README_STEM = "readme";

/**
 * The closed list of places a named plan is looked for, under that persona's own `workdir`, in this
 * order. The three archive shapes are all in use across the fleet today, and a name found under one
 * of them marks its entry done rather than being read: an archived plan's contents change nothing
 * the card draws.
 */
const PLAN_PLACES: readonly { segments: readonly string[]; archived: boolean }[] = [
  { segments: ["docs", "plans"], archived: false },
  { segments: ["docs", "archive", "plans"], archived: true },
  { segments: ["docs", "archive"], archived: true },
  { segments: ["docs", "plans", "archive"], archived: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const WHITESPACE_RUN = /\s+/g;

/**
 * One store string held to a cap: whitespace runs collapsed to single spaces, trimmed, then cut to
 * `limit` code points.
 *
 * That order is the whole of it, and it is `bounded` in `./plans.ts` by the same reasoning. A reader
 * of this value collapses whitespace before it draws or compares, so cutting the raw text first
 * would keep a prefix that is whitespace and hand on a value whose meaningful text was dropped for
 * spaces. Collapsing first makes what is kept a prefix of what a reader would have seen.
 *
 * The collapse walks the whole value once, which is `MAX_STORE_FILE_BYTES` at worst. That cost is
 * paid here rather than downstream because this runs behind the store's own hold: a file that has
 * not moved is never read or parsed again, where the join and the renderer run on every refresh tick
 * over whatever the last parse held.
 */
function bounded(value: string, limit: number): string {
  const collapsed = value.replace(WHITESPACE_RUN, " ").trim();
  // A code point takes at most two UTF-16 units, so this prefix holds at least `limit` of them and
  // the array the cut is made on stays small whatever the value's size. Cutting on code points is
  // what keeps an astral character from being left as half of itself.
  return [...collapsed.slice(0, limit * 2)].slice(0, limit).join("");
}

/**
 * One store field held to a cap, or `undefined` when the store wrote something other than a string.
 *
 * A field that is absent stays absent and a field that is present stays present: a value of nothing
 * but whitespace bounds to the empty string, which is the field still being there and saying
 * nothing, and is what a reader testing it for blankness already treated it as.
 */
function boundedField(value: unknown, limit: number): string | undefined {
  const text = stringField(value);
  return text === undefined ? undefined : bounded(text, limit);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The stem of a plan file's name: everything before the `.md` suffix, case preserved. */
function planStem(name: string): string {
  return name.replace(MARKDOWN_SUFFIX, "");
}

/**
 * The plan file name one queue entry names, or null when it names none this module will act on.
 *
 * `planSegment` wins outright when the entry carries one: it is what the persona plugin's own record
 * of the plan reduced to, so an entry that has one does not take the name found in its prose, which
 * intake already searched for regardless. A segment that fails the pattern therefore yields no name
 * at all rather than falling back to the text, which is what keeps one field the answer.
 *
 * The field's three states are all read here. A segment is the record naming something. Null is the
 * record naming nothing, which a value of `..\..\` or one ending in a separator leaves behind, and
 * it yields no name and does not take the name found in its prose: the entry has a record either
 * way. Absent is no record at all, and only that state takes the name intake found in the entry's
 * text, `textPlanName`.
 *
 * The reduction to a segment is belt to the pattern's braces: the pattern below refuses a separator
 * and a bare parent segment outright, so neither route can produce a name that leaves `workdir`.
 */
function planNameFor(entry: QueueEntry): string | null {
  const segment = entry.planSegment;
  if (segment === null) return null;
  const candidate = segment === undefined ? entry.textPlanName : segment;
  if (candidate === undefined || !PLAN_NAME.test(candidate)) return null;
  if (planStem(candidate).toLowerCase() === EXCLUDED_README_STEM) return null;
  return candidate;
}

function lastSegment(value: string): string | null {
  const segments = value.split(PATH_SEPARATOR);
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? null : last;
}

/**
 * One store `planPath` reduced to its final path segment, in the three states `QueueEntry` carries.
 *
 * Both spellings of the separator are cut, because a store written on this platform carries both,
 * so a value like `..\..\secret.md` reduces to `secret.md` here and nothing downstream sees the
 * rest of it. The reduction sits beside the other intake bounds for the same reason they do: it
 * runs once per store read, behind the store's own hold, where the join runs over every entry on
 * every refresh tick.
 *
 * A value that is not a string, and one that is empty or nothing but whitespace, are all the absent
 * state: a field that names nothing is not the record that displaces the text search. A value that
 * is there and reduces to no segment is null rather than absent, because collapsing those two
 * states would send an entry carrying the field off to find a plan named in its prose.
 */
function planSegmentField(value: unknown): string | null | undefined {
  const text = stringField(value)?.trim();
  if (text === undefined || text.length === 0) return undefined;
  return lastSegment(text);
}

/**
 * The plan name one store value names in its prose, or undefined when the value is not a string or
 * names none.
 *
 * This runs over the value as the store wrote it, before its intake cap cuts it, because a cap
 * sized for display would otherwise decide which entries join: live objectives run to several
 * hundred characters and name their plan near the end. The search sits beside the other intake
 * reductions for the reason `planSegmentField` gives, once per store read behind the store's hold
 * rather than on every refresh tick. Whitespace is left uncollapsed because the name holds no
 * whitespace and the lookahead treats whitespace and end of value alike, so collapsing first could
 * not change what matches.
 */
function textPlanNameField(value: unknown): string | undefined {
  const text = stringField(value);
  return text === undefined ? undefined : PLAN_IN_TEXT.exec(text)?.[1];
}

/**
 * One queue entry, or null when the value is not one this module can file a reading under. Every
 * field is taken only when it holds the type the card reads it at, so a store that writes a number
 * where a string belongs draws as a missing field rather than as itself. Every free-text string but
 * three is held to its own intake cap here, which is the only place any of those is bounded: past
 * this point a value is walked by the status rule and by the renderer on every refresh tick.
 *
 * `id` is the one string that leaves here as the store wrote it. A prefix cut is the wrong shape
 * for it: two distinct ids sharing a cut's worth of prefix would become one identity. `planSegment`
 * carries no cap either: it is `planPath`'s last segment, reduced rather than cut, so a
 * separator-free path reaches it whole however long it runs. `textPlanName` is bounded by the
 * pattern that finds it rather than by a cap here, to about 254 code points. `title` and
 * `objective` are searched for a plan name before `title` is cut, the title first, and `objective`
 * is read for nothing else and so goes no further than this function.
 */
function entryOf(value: unknown): QueueEntry | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  if (id === undefined || id.length === 0) return null;

  const lead = isRecord(value.lead)
    ? {
        state: boundedField(value.lead.state, MAX_INTAKE_WORD_LENGTH),
        reason: boundedField(value.lead.reason, MAX_INTAKE_REASON_LENGTH),
      }
    : undefined;

  return {
    id,
    kind: boundedField(value.kind, MAX_INTAKE_WORD_LENGTH),
    title: boundedField(value.title, MAX_INTAKE_TITLE_LENGTH) ?? "",
    status: boundedField(value.status, MAX_INTAKE_WORD_LENGTH),
    blockedReason: boundedField(value.blockedReason, MAX_INTAKE_REASON_LENGTH),
    pausedByNudgeCap:
      typeof value.pausedByNudgeCap === "boolean" ? value.pausedByNudgeCap : undefined,
    sortKey: numberField(value.sortKey),
    createdAt: numberField(value.createdAt),
    planSegment: planSegmentField(value.planPath),
    textPlanName: textPlanNameField(value.title) ?? textPlanNameField(value.objective),
    lead,
  };
}

/**
 * An entry's place in the queue: its own `sortKey` when it has one, else its own `createdAt`. An
 * entry with neither sorts last rather than first, so a store missing both keys never lets an entry
 * take the up-next place from one the operator can actually order. The sort is stable, so entries
 * sharing a key keep the order the store wrote them in.
 *
 * The standing-in key is the largest safe integer rather than an infinity, because two infinities
 * subtract to a comparator result of `NaN` and a comparator that returns one orders nothing.
 */
export function queueKey(entry: QueueEntry): number {
  return entry.sortKey ?? entry.createdAt ?? Number.MAX_SAFE_INTEGER;
}

/** One persona's slice of the store: everything the card reads out of it. */
type StoreReading = {
  entries: readonly QueueEntry[];
  activeGoalId: string | null;
  lastTurnComplete: number | null;
};

/**
 * One persona's reading of the whole store file, or null when the file is not a JSON object at all.
 *
 * A store holding no key for this persona is an ordinary reading with no entries, not a failure:
 * most of the fleet has never had a store written for it. Null is reserved for a file that read and
 * parsed to something other than an object, which a torn write of a JSON object cannot produce, so
 * it is an operator's or a plugin's mistake rather than a write in progress.
 */
function storeReading(value: unknown, persona: string): StoreReading | null {
  if (!isRecord(value)) return null;
  const own = value[persona];
  if (!isRecord(own)) return { entries: [], activeGoalId: null, lastTurnComplete: null };

  const goals = Array.isArray(own.goals) ? own.goals : [];
  const entries: QueueEntry[] = [];
  for (const goal of goals) {
    const entry = entryOf(goal);
    if (entry !== null) entries.push(entry);
  }
  entries.sort((left, right) => queueKey(left) - queueKey(right));

  const monitor = isRecord(own.monitor) ? own.monitor : {};
  return {
    entries: entries.slice(0, MAX_QUEUE_ENTRIES),
    activeGoalId: stringField(own.activeGoalId) ?? null,
    lastTurnComplete: numberField(monitor.lastTurnComplete) ?? null,
  };
}

/** The heartbeat's reading for one persona: a file with no key for it is inside no turn. */
function heartbeatReading(value: unknown, persona: string): { turnStartedAt: number | null } | null {
  if (!isRecord(value)) return null;
  const own = value[persona];
  if (!isRecord(own)) return { turnStartedAt: null };
  return { turnStartedAt: numberField(own.turnStartedAt) ?? null };
}

/** The four ways a tick's reading of one file can fail, or null on a tick that read and parsed. */
type FailureClass = "unreadable" | "oversized" | "unparseable" | "not an object" | null;

/** What one held file's state is between ticks: the last good reading with the stat it was read at,
 * the stat one failed tick observed, when the hold began, and the last line logged about it. */
type HeldFile<T> = {
  held: { stat: PlanStat; value: T } | null;
  /**
   * The modification time and size a tick failed at, with the class it failed as and whether that
   * class clears the hold. Null when the last tick to open the file got a reading out of it, and
   * null as well after an open the machine refused, which says nothing about the bytes at that
   * stat. A file that has not moved since its own bytes failed fails the same way again, and
   * learning that by reading it costs the whole file on every refresh tick, which is what
   * `heldFailure` spares the sweep in `plans.ts`.
   *
   * It is kept apart from `held.stat` rather than written into it. `held.stat` is the stat a good
   * reading was taken at, and the short-circuit above it hands that reading back as this tick's
   * own; a failure's stat standing there would make a stale reading look current and clear the
   * hold instant the card draws the group as stale from.
   */
  failedAt: { stat: PlanStat; cls: NonNullable<FailureClass>; clears: boolean } | null;
  heldSince: number | null;
  loggedLine: string | null;
};

/**
 * One plan document the join opened and got no parse out of, with the stat it failed at.
 *
 * This is the failure hold the join runs on, pointed the same way as `HeldFile.failedAt` is for the
 * store: a document that has not moved since it failed fails the same way again, so the join is told
 * that by a stat rather than by opening the file. Without it every failing document in the fleet
 * costs a full read on every refresh tick for as long as it stays that way, and once per entry that
 * names it, because no parse of it matches the stat and nothing else stops the read.
 *
 * `durable` is false for a failure that is a condition of the environment rather than of the bytes:
 * a document that could not be opened at all may open on the next tick with nothing about the file
 * having changed. Such a failure still bars a second read inside this tick, where the stat and the
 * environment are the same instant, and it is dropped rather than carried to the next one.
 */
type PlanFailureHold = { stat: PlanStat; durable: boolean };

/**
 * One plan document's last good parse, with the stat it was read at and when that parse was last
 * known to describe the file.
 *
 * `stat` is what a later tick's stat is compared against, and a difference in either field sends
 * the document back to the reader. `readAt` is the instant a hold handed back over that document
 * is stamped with, and it moves on every tick the document is confirmed unmoved, because an unmoved
 * file's parse is as current as one read this tick.
 */
type PlanParseHold = { stat: PlanStat; parse: PlanParse; readAt: number };

/** One persona's state across ticks: both held files, the plan parses the join already has, and the
 * stats the join's failures were reached at. */
type PersonaState = {
  store: HeldFile<StoreReading>;
  heartbeat: HeldFile<{ turnStartedAt: number | null }>;
  parses: Map<string, PlanParseHold>;
  failures: Map<string, PlanFailureHold>;
};

function freshHeld<T>(): HeldFile<T> {
  return { held: null, failedAt: null, heldSince: null, loggedLine: null };
}

function freshState(): PersonaState {
  return { store: freshHeld(), heartbeat: freshHeld(), parses: new Map(), failures: new Map() };
}

/**
 * One tick's reading of a held file: this tick's own when the file moved and read and parsed, the
 * last good one when it did not, and null when there has never been a good one.
 *
 * A file whose modification time and size both match the stat the held reading was taken at is not
 * opened at all, which is what keeps a store nobody has written from being parsed on every refresh.
 * That is a current reading rather than a held one, so it clears the hold instant.
 *
 * A file that has not moved since its own bytes failed a tick is not opened either, and fails as it
 * failed before. Without that, a store over the cap, not valid JSON, or parsed to something other
 * than an object costs a full open and read of up to `MAX_STORE_FILE_BYTES` on every refresh tick
 * for as long as it stays that way, which is exactly the cost the hold on a good reading exists to
 * avoid. An open the machine refused is not one of those classes and is retried, for the reason the
 * read below carries.
 *
 * Only the class of a failure is logged, and only when the line changes, so a broker pointed at a
 * folder with no store does not write that line on every tick for as long as it runs.
 */
function readHeldFile<T>(
  file: string,
  slot: HeldFile<T>,
  subject: string,
  parse: (value: unknown) => T | null,
  now: () => number,
  log: (message: string) => void,
  readFile: (file: string, maxBytes: number) => CappedRead,
): T | null {
  const note = (cls: FailureClass, keepsHeld: boolean): void => {
    const line =
      cls === null
        ? null
        : `fleet queue: ${subject} ${cls}, ` +
          (keepsHeld ? "keeping the last good reading" : "nothing read this tick");
    if (line !== slot.loggedLine) {
      if (line !== null) log(line);
      slot.loggedLine = line;
    }
  };

  const fail = (cls: FailureClass): T | null => {
    note(cls, slot.held !== null);
    if (slot.held === null) return null;
    slot.heldSince ??= now();
    return slot.held.value;
  };

  const clear = (cls: FailureClass): null => {
    note(cls, false);
    slot.held = null;
    slot.heldSince = null;
    return null;
  };

  const succeed = (stat: PlanStat, value: T): T => {
    note(null, false);
    slot.held = { stat, value };
    slot.failedAt = null;
    slot.heldSince = null;
    return value;
  };

  // The terminal failures the bytes at that stat decide, each recording the stat it was reached at
  // so the tick after it spends a stat rather than the whole file learning the same thing. A failure
  // the bytes do not decide never comes here: see the read below.
  const failAt = (stat: PlanStat, cls: NonNullable<FailureClass>): T | null => {
    slot.failedAt = { stat, cls, clears: false };
    return fail(cls);
  };

  const clearAt = (stat: PlanStat, cls: NonNullable<FailureClass>): null => {
    slot.failedAt = { stat, cls, clears: true };
    return clear(cls);
  };

  const stat = statFile(file);
  // A file that cannot be stat'd at all is not opened either, so there is nothing here to spare and
  // no stat to record the failure under.
  if (stat === null) return fail("unreadable");
  if (
    slot.held !== null &&
    slot.held.stat.mtimeMs === stat.mtimeMs &&
    slot.held.stat.sizeBytes === stat.sizeBytes
  ) {
    return succeed(stat, slot.held.value);
  }
  const failed = slot.failedAt;
  if (
    failed !== null &&
    failed.stat.mtimeMs === stat.mtimeMs &&
    failed.stat.sizeBytes === stat.sizeBytes
  ) {
    return failed.clears ? clear(failed.cls) : fail(failed.cls);
  }

  const read = readFile(file, MAX_STORE_FILE_BYTES);
  // A file over the cap is refused by its own bytes, so the stat it was refused at is worth
  // recording. A file that would not open is not: an open refused while another process holds the
  // file, or while the broker is out of descriptors, is a condition of the machine at that instant
  // and the file itself need never move again. Recording that stat would stop this file ever being
  // opened again, and the whole group would hold its previous reading for as long as the broker ran.
  if ("failed" in read) {
    if (read.failed === "oversized") return failAt(stat, read.failed);
    // The stat any earlier failure was recorded at is gone, since the file has moved off it to reach
    // this read, so it is dropped rather than left to refuse a later tick that lands back on it.
    slot.failedAt = null;
    return fail(read.failed);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return failAt(stat, "unparseable");
  }

  const value = parse(parsed);
  if (value === null) return clearAt(stat, "not an object");
  return succeed(stat, value);
}

/**
 * The plan reading for one name under one persona's `workdir`, or null when the name is in none of
 * the four places or its document cannot be read or parsed this tick and no earlier parse of it is
 * held.
 *
 * `name` has already passed `PLAN_NAME`, so it carries no separator and no parent segment and every
 * path below stays under `workdir` by construction. Nothing outside those four paths is stat'd or
 * opened, whatever the store that supplied the name says.
 *
 * A document the join already parsed at exactly this modification time and size is folded in from
 * the persona's own hold rather than opened again, so a queue sitting still costs one stat per
 * entry and no reads at all. This tick's own parses are consulted ahead of the last tick's, so a
 * document two hundred entries name is opened once for the tick however many of them moved it.
 *
 * A document that fails to read or fails to parse keeps its last good parse, which is what a plan
 * doc caught mid-write by a live session needs. That parse is handed back whole, under the stat it
 * was read at as well as its contract fields, because a held parse's status describes those bytes
 * and no others: wearing the current document's modification time it would outrank a genuinely
 * newer document in the card's in-flight rule and draw the wrong entry as running. It carries the
 * instant it was last known good as well, which is `at` on the last tick that parsed the document
 * or confirmed it unmoved, so the card can age itself by a reading it redraws.
 *
 * The stat a failure was reached at is held too, so a document that has not moved since it failed is
 * not opened again, whether that is a second entry naming it inside this tick or the tick after.
 */
function joinPlan(
  workdir: string,
  name: string,
  state: PersonaState,
  parses: Map<string, PlanParseHold>,
  failures: Map<string, PlanFailureHold>,
  at: number,
  stat: (file: string) => PlanStat | null,
  read: (file: string) => PlanRead,
): QueuePlanReading | null {
  const stem = planStem(name);
  for (const place of PLAN_PLACES) {
    const file = path.join(workdir, ...place.segments, name);
    const moved = stat(file);
    if (moved === null) continue;
    if (place.archived) return { archived: true, root: workdir, path: file, stem };

    const where = {
      root: workdir,
      path: file,
      stem,
      mtimeMs: moved.mtimeMs,
      sizeBytes: moved.sizeBytes,
    };

    // An unmoved document's parse is as current as one read this tick, so the hold's instant moves
    // up to this tick and the reading is handed back as this tick's own.
    const holding = parses.get(file) ?? state.parses.get(file);
    if (
      holding !== undefined &&
      holding.stat.mtimeMs === moved.mtimeMs &&
      holding.stat.sizeBytes === moved.sizeBytes
    ) {
      parses.set(file, { ...holding, readAt: at });
      return { archived: false, heldSince: null, ...holding.parse, ...where };
    }

    // The hold, kept and handed back at the stat it was parsed at and stamped with the instant it
    // was last known good, or nothing at all when this document has never parsed.
    const held = (): QueuePlanReading | null => {
      if (holding === undefined) return null;
      parses.set(file, holding);
      return {
        archived: false,
        heldSince: holding.readAt,
        ...holding.parse,
        root: workdir,
        path: file,
        stem,
        mtimeMs: holding.stat.mtimeMs,
        sizeBytes: holding.stat.sizeBytes,
      };
    };

    // A document that has not moved since it failed fails the same way again, so the hold, or
    // nothing, is the answer and the file is not opened. The in-tick record is consulted ahead of
    // the last tick's, so a document two hundred entries name is opened once for the tick whether
    // it parsed or failed.
    const failed = failures.get(file) ?? state.failures.get(file);
    if (
      failed !== undefined &&
      failed.stat.mtimeMs === moved.mtimeMs &&
      failed.stat.sizeBytes === moved.sizeBytes
    ) {
      failures.set(file, failed);
      return held();
    }

    // A failure the bytes at this stat decide is held past this tick. One the environment decided,
    // a document that would not open, is held for this tick alone: it bars the entries after this
    // one from opening the same file at the same instant, and the next tick tries it again.
    const failAt = (durable: boolean): QueuePlanReading | null => {
      failures.set(file, { stat: moved, durable });
      return held();
    };

    const text = read(file);
    if ("failed" in text) return failAt(text.failed === "oversized");
    const parsed = parsePlan(text.text);
    if (parsed === null) return failAt(true);
    parses.set(file, { stat: moved, parse: parsed, readAt: at });
    return { archived: false, heldSince: null, ...parsed, ...where };
  }
  return null;
}

/**
 * A reader over one fleet's personas, holding each persona's store and heartbeat reading between
 * ticks so a torn write never blanks a group, and holding each plan document's parse so a queue that
 * has not moved costs no reads at all.
 *
 * State is filed per persona and rebuilt from the roster on every tick, so a persona the operator
 * disables stops costing memory on the tick after it leaves the roster, and two readers in one
 * process never see each other's holds.
 */
export function createQueueReader(options: QueueReaderOptions = {}): QueueReader {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const stat = options.statPlan ?? statFile;
  const read = options.readPlan ?? readPlanFile;
  const readFile = options.readStore ?? readCappedFile;
  let states = new Map<string, PersonaState>();

  return {
    read: (personas) => {
      // One instant for the tick, which every parse taken or confirmed unmoved this tick is stamped
      // with, so two entries naming one document agree on when it was last known good.
      const at = now();
      const next = new Map<string, PersonaState>();
      const queues: PersonaQueue[] = [];

      for (const persona of personas) {
        // Both the name and the folder are part of the key: the name is what the store is keyed by
        // inside the file, and the folder is which file that is.
        const key = `${persona.name}\u0000${persona.workdir}`;
        const state = states.get(key) ?? freshState();

        const store = readHeldFile(
          path.join(persona.workdir, STORE_FILE_NAME),
          state.store,
          "persona store",
          (value) => storeReading(value, persona.name),
          now,
          log,
          readFile,
        );
        const heartbeat = readHeldFile(
          path.join(persona.workdir, HEARTBEAT_FILE_NAME),
          state.heartbeat,
          "worker heartbeat",
          (value) => heartbeatReading(value, persona.name),
          now,
          log,
          readFile,
        );

        const entries = store?.entries ?? [];
        const readings = new Map<string, QueuePlanReading>();
        const parses = new Map<string, PlanParseHold>();
        const failures = new Map<string, PlanFailureHold>();
        const joined = new Set<string>();
        for (const entry of entries) {
          // A store that wrote two goals under one id gets one reading between them, and it is the
          // first goal's. The readings are keyed by id, so a second write under that key would hand
          // the later entry's document to the earlier one as well, and a borrowed reading is worse
          // on the card than none: it draws one plan's progress against another plan's title.
          if (joined.has(entry.id)) continue;
          joined.add(entry.id);
          const name = planNameFor(entry);
          if (name === null) continue;
          const reading = joinPlan(persona.workdir, name, state, parses, failures, at, stat, read);
          if (reading !== null) readings.set(entry.id, reading);
        }
        // Only the documents this tick actually joined to are held, so a queue that drops an entry
        // drops its parse with it rather than keeping it for as long as the broker runs. A failure
        // the environment decided is dropped here as well, so the next tick opens that file again.
        state.parses = parses;
        state.failures = new Map([...failures].filter(([, failure]) => failure.durable));

        next.set(key, state);
        queues.push({
          name: persona.name,
          workdir: persona.workdir,
          entries,
          activeGoalId: store?.activeGoalId ?? null,
          lastTurnComplete: store?.lastTurnComplete ?? null,
          turnStartedAt: heartbeat?.turnStartedAt ?? null,
          readings,
          heldSince: state.store.heldSince,
        });
      }

      states = next;
      return queues;
    },
  };
}
