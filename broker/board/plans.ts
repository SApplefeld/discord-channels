// The plan reader: what the board card knows about the fleet's open work, taken from the plan docs
// on this host's disk and from nothing else.
//
// A plan doc's header and structure are a frozen v1 machine contract shared with an external engine
// (the AI OS Spine) that drives its own fleet from the same files. This reader implements that
// contract exactly, sharp edges included: a foreign `##` heading inside `## Sections of Work` ends
// the block early and silently drops every later section, and a Chapter's `Completed:` value
// registers a section only under three forms. A phrasing outside those forms leaves its section
// open here because it leaves the section open in the engine, and a card that disagreed with the
// engine about the same file would be the dishonest one. Loosening either rule is a coordinated
// versioned change across the kit and the engine, never a fix made here.
//
// Paths come only from the configured roots plus the directory listing under each. No value parsed
// out of any file is ever opened, joined, or resolved.
//
// The listing keeps regular files only, so a symlink or a FIFO standing at a name when the
// directory is read is never opened. A FIFO swapped in at a listed name between the listing and the
// open would block the open until a writer arrived, which is a write inside the operator's own
// project tree by the operator's own account, the boundary this reader already stands inside.
//
// Reads are byte-capped and refused whole: a file over the cap yields a failure rather than its
// first megabyte, because a recognizer running on a cut copy can manufacture a match the full text
// does not contain. Failure is a returned value per path, never a throw and never a silent drop, so
// a caller holding a last-good parse can tell "this plan failed to read this tick" from "this plan
// is gone". Nothing read here is logged: a failure carries a static reason, and the errors
// themselves are discarded unread because each carries a path under the operator's own profile.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Ceiling on one plan doc. A long plan with a dozen Chapters runs tens of kilobytes, so this is
 * room for far more than a plan the card can render, and past it the file is refused without being
 * parsed at all.
 */
export const MAX_PLAN_FILE_BYTES = 1024 * 1024;

/**
 * The most plan files one root contributes to a sweep, by name order.
 *
 * A curated `docs/plans` holds a handful of open plans, so this is generous headroom. It exists
 * because the sweep runs on a refresh timer: without it, one directory holding thousands of `.md`
 * files would cost a stat and a megabyte-capped read each, every tick.
 */
export const MAX_PLANS_PER_ROOT = 64;

/**
 * What the two free-form values a plan doc carries are held to before they leave a parse.
 *
 * Both are single lines of a file this module reads whole, so either can arrive as the entire
 * megabyte the read cap allows. These caps sit generously above anything a renderer draws (the board
 * card cuts a status to nine columns and a `Next:` to a hundred and twenty), so presentation stays
 * the renderer's, and far below what a caller could afford to hold: a held parse is kept in memory
 * across ticks and folded back into every sweep, so a megabyte reaching it is a megabyte re-walked
 * by every consumer on every tick.
 */
export const MAX_INTAKE_STATUS_LENGTH = 120;
export const MAX_INTAKE_NEXT_LENGTH = 400;

/** The parsed contract values of one plan doc, with no knowledge of where the text came from. */
export type PlanParse = {
  /**
   * The `Status:` value, whitespace-collapsed and held to `MAX_INTAKE_STATUS_LENGTH`. The renderer
   * draws a non-terminal status as its own text, so the string rides out beside the flag rather than
   * being reduced to it.
   */
  status: string;
  /** True only when the status equals `Complete` as the whole string, case-insensitive. */
  terminal: boolean;
  /** `### N.` headings inside the `## Sections of Work` block, counting only what the block bounds. */
  sections: number;
  /** How many of those sections some Chapter's first `Completed:` line registers. */
  completed: number;
  /**
   * The highest-numbered Chapter's first `Next:` value: free-form prose, whitespace-collapsed and
   * held to `MAX_INTAKE_NEXT_LENGTH`. Neutralizing it stays the renderer's job, because this value
   * is model-written text.
   */
  next: string | null;
};

/** One swept plan doc: its contract values, where it lives, and when it last moved. */
export type PlanReading = PlanParse & {
  /** The configured root this plan was found under, as configured. */
  root: string;
  /**
   * The absolute path the text was read from. It sits under a configured root, which typically
   * embeds the operator's OS username, so `stem` is this plan's loggable identity and this is not.
   */
  path: string;
  /** The filename without its `.md` suffix, which is the handle the operator mentions. */
  stem: string;
  /** The file's modification time in epoch milliseconds, from the stat that preceded the read. */
  mtimeMs: number;
  /** The file's size in bytes, from that same stat. */
  sizeBytes: number;
};

/**
 * Why one plan doc yielded no reading this tick.
 *
 * `unreadable` is deliberately coarse: an absent file, a permission refusal, and a read that failed
 * after the open succeeded are one reason here, because the caller does the same thing with each.
 * `malformed` is a doc with no `Status:` header above its first `##` heading, which is what a doc
 * caught mid-write looks like and is also the one shape the contract gives no plan reading for.
 */
export type PlanFailureReason = "unreadable" | "oversized" | "malformed";

/**
 * One swept plan doc that yielded no reading. The `reason` is a static word, safe to log and safe
 * to render; `path` carries the same operator profile the reading's does, so `stem` is the
 * loggable identity here too.
 */
export type PlanFailure = {
  root: string;
  path: string;
  stem: string;
  reason: PlanFailureReason;
};

/** What one capped read yields: the file's text, or why there is none. */
export type PlanRead = { text: string } | { failed: "unreadable" | "oversized" };

export type SweepPlansOptions = {
  /**
   * The parse this caller already holds for `file` at exactly this modification time and size, or
   * undefined when it holds none. Returning one skips the read entirely and folds the held parse
   * into the sweep's readings under the fresh stat, which is what a refresh timer wants: every
   * present plan comes back every tick, and only the files that moved are opened.
   */
  heldParse?: (file: string, mtimeMs: number, sizeBytes: number) => PlanParse | undefined;
  /** The one read this module performs. Injected so a test can pin which files are opened. */
  readPlan?: (file: string) => PlanRead;
};

/**
 * One root whose `docs/plans` held more files than `MAX_PLANS_PER_ROOT`, and how many of them the
 * listing left out. Only the count is carried: the files past the cap are never stat'd or opened,
 * so there is no reading, no failure and no name to give for any of them, and a renderer draws the
 * cut as the one line it is.
 */
export type PlanTruncation = { root: string; dropped: number };

export type PlanSweep = {
  readings: PlanReading[];
  failures: PlanFailure[];
  /** The roots whose listing was cut by the cap, in the order they were configured. Empty when
   * every root's plans fit, which is the ordinary case. */
  truncated: PlanTruncation[];
};

// The contract's readers are anchored to the start of the line and case-sensitive, so these are
// too: a reasonable-looking rewording parses as absent rather than as a variant, in the engine and
// here alike.
const STATUS = /^Status:(.*)$/;
const SECTIONS_HEADING = /^##\s+Sections of Work\s*$/;
const CHAPTERS_HEADING = /^##\s+Chapters\s*$/;
const SECTION = /^###\s+(\d+)\.\s+(.*)$/;
const CHAPTER = /^###\s+Chapter\s+(\d+)/;
const COMPLETED = /^Completed:(.*)$/;
const NEXT = /^Next:(.*)$/;

// The engine's own H2 pattern, which takes `##` only when whitespace and then text follow it. That
// requirement is what excludes `###` and `####` lines, whose next character is a hash: a section or
// Chapter heading lives inside a block rather than ending one. A line like `##foo`, with no space,
// is not a heading to the engine and is not one here.
const BLOCK_HEADING = /^##\s+.+$/;

function isBlockHeading(line: string): boolean {
  return BLOCK_HEADING.test(line);
}

/**
 * The lines a `##` block bounds: everything after its heading up to the next `##` heading.
 *
 * This is where the contract's sharpest edge lives. Any other `##` heading inside `## Sections of
 * Work` ends the block, so every `### N.` section below it is dropped from the count. That is the
 * engine's behavior, reproduced rather than corrected.
 */
function blockLines(lines: string[], heading: RegExp): string[] {
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const body = lines.slice(start + 1);
  const end = body.findIndex(isBlockHeading);
  return end < 0 ? body : body.slice(0, end);
}

// The first `Status:` line above the first `##` heading, which is the one the contract reads. A
// later occurrence, such as one quoted inside a Chapter, is not it.
function statusValue(lines: string[]): string | null {
  for (const line of lines) {
    if (isBlockHeading(line)) return null;
    const match = STATUS.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

type Section = { number: string; title: string };

function sectionHeadings(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (const line of blockLines(lines, SECTIONS_HEADING)) {
    const match = SECTION.exec(line);
    if (match) sections.push({ number: match[1], title: match[2].trim() });
  }
  return sections;
}

type Chapter = { number: number; completed: string | null; next: string | null };

/**
 * The Chapters in the `## Chapters` block, each carrying the first `Completed:` and first `Next:`
 * line that follows its heading. Only the first of each counts: a Chapter's prose can quote either
 * key again, and the contract reads the first.
 */
function chapterEntries(lines: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of blockLines(lines, CHAPTERS_HEADING)) {
    const heading = CHAPTER.exec(line);
    if (heading) {
      chapters.push({ number: Number(heading[1]), completed: null, next: null });
      continue;
    }
    const chapter = chapters[chapters.length - 1];
    if (chapter === undefined) continue;
    const completed = COMPLETED.exec(line);
    if (completed && chapter.completed === null) chapter.completed = completed[1].trim();
    const next = NEXT.exec(line);
    if (next && chapter.next === null) chapter.next = next[1].trim();
  }
  return chapters;
}

// The section number a `Completed:` value leads with, under the two numeric forms: the number then
// a period, or the number then a space. The digits are taken as written, so `01` registers section
// `01` and no other.
const LEADING_SECTION = /^(\d+)[. ]/;

type Completions = { numbers: Set<string>; titles: Set<string> };

/**
 * The `Completed:` values indexed by what they can register, under the contract's three forms and
 * no others: the section number then a period, the section number then a space, or the title
 * exactly.
 *
 * Indexed rather than compared pairwise because both sides come from the file: sections and
 * Chapters each scale with the document, and a pass over their product would cost seconds of a
 * single-threaded refresh tick on a large one.
 *
 * The title comparison is case-sensitive and whole-string on purpose. A substring or a fuzzy match
 * would close sections the engine leaves open, which is the one disagreement this reader must never
 * produce.
 */
function completionIndex(completions: readonly string[]): Completions {
  const numbers = new Set<string>();
  const titles = new Set<string>();
  for (const value of completions) {
    const leading = LEADING_SECTION.exec(value);
    if (leading) numbers.add(leading[1]);
    titles.add(value);
  }
  return { numbers, titles };
}

function registers(section: Section, completions: Completions): boolean {
  return completions.numbers.has(section.number) || completions.titles.has(section.title);
}

// Every run of whitespace in a value, which is what stands between a bound on its length and a bound
// on the text a reader gets out of it.
const WHITESPACE_RUN = /\s+/g;

/**
 * A free-form value as it leaves the parse: whitespace collapsed to single spaces, then cut to a
 * length in code points.
 *
 * That order is the whole of it. A renderer collapses whitespace before it draws, so cutting the raw
 * text first would keep a prefix that is whitespace and hand on a value whose meaningful text was
 * dropped for spaces. Collapsing first makes what is kept a prefix of what a reader would have seen.
 *
 * The collapse walks the whole value once, which is a megabyte at worst. That cost is paid here
 * rather than by the renderer because a parse is mtime-gated: a file that has not moved is never
 * read or parsed again, where a renderer runs on every refresh tick over whatever the last parse
 * held.
 */
function bounded(value: string, limit: number): string {
  const collapsed = value.replace(WHITESPACE_RUN, " ").trim();
  // A code point takes at most two UTF-16 units, so this prefix holds at least `limit` of them and
  // the array the cut is made on stays small whatever the value's size. Cutting on code points is
  // what keeps an astral character from being left as half of itself.
  return [...collapsed.slice(0, limit * 2)].slice(0, limit).join("");
}

/**
 * The contract values of one plan doc, or null when the text carries no `Status:` header above its
 * first `##` heading. Null rather than a default status, because a doc without that header is
 * either mid-write or not a plan doc, and inventing "no status" for it would draw a plan onto the
 * card that the engine does not see at all.
 */
export function parsePlan(text: string): PlanParse | null {
  // A byte-order mark ahead of the first line would otherwise defeat the line-start anchor on
  // whatever key happens to be written first. Stripping it matches the engine, which reads these
  // files through a decoder that strips it too.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  const header = statusValue(lines);
  if (header === null) return null;
  const status = bounded(header, MAX_INTAKE_STATUS_LENGTH);

  const sections = sectionHeadings(lines);
  const chapters = chapterEntries(lines);
  const completions = completionIndex(
    chapters.map((chapter) => chapter.completed).filter((value): value is string => value !== null),
  );

  // The highest-numbered Chapter, not the last one written: Chapters are appended in order by
  // convention only, and a number is what the contract parses. A repeated number resolves to the
  // later of the two, which is the more recently appended account of that Chapter.
  let latest: Chapter | null = null;
  for (const chapter of chapters) {
    if (latest === null || chapter.number >= latest.number) latest = chapter;
  }

  return {
    status,
    terminal: status.toLowerCase() === "complete",
    sections: sections.length,
    completed: sections.filter((section) => registers(section, completions)).length,
    next:
      latest === null || latest.next === null
        ? null
        : bounded(latest.next, MAX_INTAKE_NEXT_LENGTH),
  };
}

/**
 * The modification time and size of one plan file, or null when it cannot be stat'd at all.
 *
 * This runs before the read, so a write landing between the two leaves the stat older than the
 * bytes parsed. That is the direction a caller gating on movement needs: the next tick sees a newer
 * stat than the one it recorded and re-reads, where a stat taken after the read could record the
 * write's own time against the bytes from before it and skip the re-read forever.
 *
 * The size cap is not enforced here for the same reason: a file can grow between the stat and the
 * read, so refusing an over-cap file stays the read's own job.
 */
function statPlanFile(file: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * One read of at most `MAX_PLAN_FILE_BYTES`, into a buffer one byte larger so an oversized file is
 * recognized by the read itself rather than by a stat the file could have outgrown in between. The
 * buffer is uninitialized because only the bytes the read actually returned are ever decoded, so
 * nothing beyond them can escape.
 *
 * The read repeats until the buffer fills or a read returns nothing, because one `readSync` is
 * allowed to return fewer bytes than asked for and a network filesystem does. Stopping at the first
 * short read would hand the parser a prefix of the file under the name of the whole, which is the
 * cut copy this module refuses to recognize anything from.
 *
 * A failure at any stage reports "unreadable", which covers an absent file, a permission refusal,
 * and a read that failed after the open succeeded. The distinction changes nothing the caller does,
 * and the errors themselves are discarded unread because each carries the path.
 *
 * The close carries its own guard rather than riding a bare `finally`: a close that throws there
 * replaces whatever the read produced, so a healthy read would surface as a failure and a failed
 * one would surface with the wrong reason.
 */
function readPlanFile(file: string): PlanRead {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return { failed: "unreadable" };
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_PLAN_FILE_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(handle, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    if (filled > MAX_PLAN_FILE_BYTES) return { failed: "oversized" };
    return { text: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { failed: "unreadable" };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that will not close is the operating system's problem, not the card's: the reading
      // in hand is still good and there is nothing here left to do about the descriptor.
    }
  }
}

// The `.md` suffix, matched without regard to case because the filesystems this runs on do not
// distinguish `spec_v1.md` from `SPEC_V1.MD` and neither does the operator naming a plan.
const MARKDOWN_SUFFIX = /\.md$/i;

/**
 * The plan files directly under one root's `docs/plans`, by name, in a stable order and bounded by
 * `MAX_PLANS_PER_ROOT`, alongside how many names the bound left out.
 *
 * A root whose directory is missing or unreadable lists nothing, and that is not a failure: a
 * project with no plans directory has no open plans. The listing is one level deep and files only,
 * so `docs/archive/` and any nested directory are outside it by construction.
 */
function planFiles(root: string): { names: string[]; dropped: number } {
  try {
    const named = readdirSync(path.join(root, "docs", "plans"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && MARKDOWN_SUFFIX.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return {
      names: named.slice(0, MAX_PLANS_PER_ROOT),
      dropped: Math.max(0, named.length - MAX_PLANS_PER_ROOT),
    };
  } catch {
    return { names: [], dropped: 0 };
  }
}

/**
 * The current reading of every plan doc under the configured roots, terminal plans included: the
 * membership rule is the renderer's, which draws every non-terminal plan with its status as text.
 *
 * Every listed file is stat'd; a file the caller already holds a parse for at that exact
 * modification time and size is folded in from the caller's hold rather than opened, so a refresh
 * tick over an unchanged fleet costs one stat per plan and no reads at all.
 *
 * It does not throw for one bad file, and it does not drop one either. Each failed path comes back
 * named so the caller can redraw whatever it last parsed for that path under an aging marker, which
 * is what a plan doc mid-write by a live session needs, and a root holding more plans than the
 * per-root cap allows comes back with the count the cap left out.
 */
export function sweepPlans(roots: readonly string[], options: SweepPlansOptions = {}): PlanSweep {
  const read = options.readPlan ?? readPlanFile;
  const readings: PlanReading[] = [];
  const failures: PlanFailure[] = [];
  const truncated: PlanTruncation[] = [];

  for (const root of roots) {
    const listing = planFiles(root);
    if (listing.dropped > 0) truncated.push({ root, dropped: listing.dropped });
    for (const name of listing.names) {
      const file = path.join(root, "docs", "plans", name);
      const stem = name.replace(MARKDOWN_SUFFIX, "");
      const moved = statPlanFile(file);
      if (moved === null) {
        failures.push({ root, path: file, stem, reason: "unreadable" });
        continue;
      }
      const where = { root, path: file, stem, mtimeMs: moved.mtimeMs, sizeBytes: moved.sizeBytes };

      const holding = options.heldParse?.(file, moved.mtimeMs, moved.sizeBytes);
      if (holding !== undefined) {
        readings.push({ ...holding, ...where });
        continue;
      }

      const held = read(file);
      if ("failed" in held) {
        failures.push({ root, path: file, stem, reason: held.failed });
        continue;
      }
      const parsed = parsePlan(held.text);
      if (parsed === null) {
        failures.push({ root, path: file, stem, reason: "malformed" });
        continue;
      }
      readings.push({ ...parsed, ...where });
    }
  }
  return { readings, failures, truncated };
}
