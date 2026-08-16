// The board card: one bounded message body listing every open plan across this host's configured
// project roots, grouped by project.
//
// Pure rendering, the fleet usage card's shape. Everything it draws arrives as arguments, the
// current time included, so the same inputs always compose the same body: the thread this card
// lives in is edited only when its text changes, and a clock read inside the renderer would be a
// difference on every refresh.
//
// Membership is every non-terminal plan, with a status other than the ordinary in-progress one
// drawn as its own text where the bar would be. Only `Status: Complete` is hidden. So a Draft is
// visible, and a status spelled some other way surfaces as that spelling rather than vanishing into
// a filter it did not match.
//
// Every string it draws is untrusted. A plan's filename, its `Status:` value and its `Next:` prose
// are model-written text out of another program's files, and an event's fields are that program's
// own. All of them go through `../discord/render.ts`'s escaping, and which escape depends on where
// the field lands: a project label sits in the bold line above its fence, which is live markdown, so
// it takes `inertField`, and everything inside a fence takes `inertBlockField`, the escape that
// reaches the one character a fence still gives meaning to. Every fenced line is held inside
// `MAX_BLOCK_WIDTH` code points, which is a bound on the line's length rather than on its width: a
// field of emoji draws wider than the code points it is measured in, and the cost of that is a
// wrapped row rather than a line a reader has to drag sideways to finish.
//
// The work one render costs is bounded by the plans it is handed and not by the bytes any one of
// them carries: one pass to index the events, one pass to group the plans, and one map lookup per
// plan. Every untrusted field is bounded before it arrives, each by whichever reader took it in:
// the two free-form plan values by `./plans.ts`'s intake caps, an event's fields by `./events.ts`'s,
// and a filename by the name limit the filesystem itself enforces. So the escaping and padding here
// walk a bounded string per field, and nothing walks a product of two quantities that both come from
// another program's files.
import {
  BAR_GLYPH,
  FENCE_COST,
  MAX_BLOCK_WIDTH,
  MAX_CARD_LENGTH,
  fenced,
  fit,
  heartbeat,
  inertBlockField,
  inertField,
  span,
  wrapped,
} from "../discord/render.ts";
import { eventKey } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import type { PlanFailure, PlanFailureReason, PlanReading, PlanTruncation } from "./plans.ts";

/**
 * One plan as the card draws it: the parse to draw, and when that parse was last read off the file.
 *
 * `heldSince` is null for a plan read this tick. A number is the instant the parse was last known
 * good, which the card draws as a marker whose age climbs: a plan doc mid-write by a live session is
 * unparseable for a tick, the caller redraws the last parse it held, and the marker is what keeps a
 * redrawn row from reading as a freshly read one.
 */
export type BoardPlan = {
  reading: PlanReading;
  heldSince: number | null;
};

/**
 * How many cells a plan's section bar is drawn in, and the knob this card's geometry is tuned by:
 * every other column on the row is derived from it and from `MAX_BLOCK_WIDTH`.
 *
 * Nine because a status is drawn in these same columns whenever a plan is not in progress, and nine
 * is what `Abandoned` takes. Every column this region grows by is one the filename stem loses, and
 * the stem is the handle the operator mentions in the channel, so it is the field with the stronger
 * claim on the row. A status wider than this is cut with the mark `fit` leaves.
 */
export const BAR_CELLS = 9;

/** The columns the bar or the status text is drawn in, which are the same columns. */
const MEASURE_WIDTH = BAR_CELLS;

/**
 * The largest section count the card draws. The counts come out of a plan doc's own headings, so a
 * file full of them is bounded here rather than allowed to render a figure that takes the row.
 */
export const MAX_DRAWN_SECTIONS = 999;

/** The widest a `completed/sections` count can be, which is what the column can never exceed. */
const MAX_COUNT_WIDTH = `${MAX_DRAWN_SECTIONS}/${MAX_DRAWN_SECTIONS}`.length;

/** What holds the count off the bar before it. Two columns, as the usage card's clauses take. */
const COUNT_GAP = "  ";

/** What a plan's second line is indented by, so a row reads as one plan rather than as two. */
const ROW_INDENT = "  ";

const SEPARATOR = "·";

/**
 * Room for the untrusted fields, cut before the body is assembled the way every card field is.
 *
 * The `Next:` value is free-form prose a Chapter carries, and it is the one field with no natural
 * length: this is what a phrase naming the next section runs to, and past it the line says it was
 * cut.
 */
export const MAX_NEXT_LENGTH = 120;
export const MAX_PROJECT_LABEL_LENGTH = 60;

/**
 * The status value that draws a bar instead of its own text, compared case-insensitively on the
 * trimmed value. Every other non-terminal status is drawn as written.
 */
const IN_PROGRESS = "in progress";

/** The card's name where Discord draws a message's first line, inline beside the bot's own name.
 * That position reads as chrome rather than as the card's heading, which is why the title below
 * repeats it, and it is the line a channel list and a phone notification show. */
const PREVIEW = "📋 **Fleet: Board**";

/** The card's top edge, at the largest heading Discord draws, so a channel of cards has something
 * to pick this one out of the run by. Drawn beneath `PREVIEW` and saying the same thing, the way
 * both sibling cards draw their own name twice and for the same two reasons. */
const TITLE = "# 📋 Fleet: Board";

/** What a card with nothing at all to draw says, rather than being absent. An absent card and a
 * fleet with no open work look identical to a reader, and only one of them is good news. */
const NOTHING_OPEN = "No open plans in the configured projects.";

/** What a plan the card has no parse for says instead of a row, one static phrase per reason. The
 * reasons are this reader's own words, never anything read out of the file.
 *
 * A map rather than an object literal because the lookup key is data: a map's keys are its own and
 * nothing else's, where a literal answers `constructor` and `toString` with members no one here
 * wrote. `NO_PARSE_FALLBACK` is what a reason from outside the union draws. */
const NO_PARSE = new Map<PlanFailureReason, string>([
  ["unreadable", "cannot be read"],
  ["oversized", "too large to read"],
  ["malformed", "does not parse"],
]);

/** What a plan whose failure names a reason this card has no phrase for says. */
const NO_PARSE_FALLBACK = "cannot be drawn";

/** What a project is called when the last segment of its configured root neutralizes to nothing. */
function unnamedProject(index: number): string {
  return `project ${index + 1}`;
}

// A path is split on either separator, because the configured roots and the plan paths the kit
// writes are Windows and POSIX text in the same body. This is a string operation: nothing here
// opens, resolves, or asks the filesystem anything about a value another program wrote.
const PATH_SEPARATOR = /[\\/]/;
const MARKDOWN_SUFFIX = /\.md$/i;

/** The last segment of a path, as text. Empty for a value that is nothing but separators. */
function lastSegment(value: string): string {
  const segments = value.split(PATH_SEPARATOR);
  return segments[segments.length - 1] ?? "";
}

/**
 * The name a swept plan is joined on: its filename stem, case-folded and otherwise as the reader
 * read it.
 *
 * The suffix is not touched here, because the reader already took one `.md` off the filename. A
 * second cut would fold the file `foo.md.md`, swept as the stem `foo.md`, onto the different file
 * `foo.md` standing beside it in the same directory: the two rows would answer to one name, so an
 * event for either would mark both.
 *
 * Case is folded whatever the platform, matching the plan reader's own case-insensitive reading of
 * the `.md` suffix. Two plans in one directory whose names differ only in case are the same plan on
 * the filesystems this runs on, and on the one where they are not, the cost is a marker attributed
 * to the first of the two rather than a marker that never draws at all.
 */
function planName(stem: string): string {
  return stem.toLowerCase();
}

/**
 * The same name, taken from the way an event names a plan: the last segment of the path the kit
 * wrote (`docs/plans/foo_spec_v1.md`), without one `.md` suffix, case-folded.
 *
 * The one suffix this drops is the one the plan reader drops off the filename, so a stem and an
 * event path naming the same file reduce to the same name and no two files reduce to one. It is a
 * name rather than a path on purpose: a plan lives directly under one root's `docs/plans`, so within
 * a root the name identifies it, and building a path out of an event's text to compare against is
 * the one thing this card's readers never do.
 */
function eventPlanName(value: string): string {
  return planName(lastSegment(value).replace(MARKDOWN_SUFFIX, ""));
}

/**
 * The latest event per (root, plan name), which is the key the card can actually look a plan up by.
 *
 * The reader keys its state by the plan path the kit wrote, and several of those can reduce to one
 * name, so the later timestamp wins rather than the later insertion: the card draws the latest event
 * for a plan, and insertion order is the order lines happened to be appended in.
 *
 * A timestamp that does not parse loses to every one that does, so an event the card can place on a
 * timeline is never displaced by one it cannot.
 */
function eventIndex(latest: ReadonlyMap<string, BoardEvent>): Map<string, BoardEvent> {
  const index = new Map<string, BoardEvent>();
  for (const event of latest.values()) {
    const key = eventKey(event.root, eventPlanName(event.plan));
    const held = index.get(key);
    if (held !== undefined && instant(held) >= instant(event)) continue;
    index.set(key, event);
  }
  return index;
}

/** An event's timestamp as an instant, or negative infinity when it names none. */
function instant(event: BoardEvent): number {
  const at = Date.parse(event.ts);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * When the run on this plan stopped needing the operator, or null when it is not stopped.
 *
 * The marker draws while the latest event for the pair is `goal-blocked`, and it clears on either of
 * two observations. A `goal-complete` for the pair is one: the reader keeps only the latest event
 * per pair, so a completion having landed is the map no longer holding a block. The plan doc's own
 * modification time moving past the event's timestamp is the other, because a Chapter landing after
 * the block means the run resumed, and that clear needs no event at all.
 *
 * An event whose timestamp names no instant clears too. A comparison against one yields false
 * forever, which would leave the marker standing for as long as the broker runs.
 *
 * A timestamp ahead of the card's own clock is read as that clock: a block cannot have started
 * later than the card is drawn, and taking one at its word would put the block's start past every
 * modification time the doc has, which is the mtime rule answering false about a doc that has
 * already moved.
 */
function blockedAt(
  plan: BoardPlan,
  events: ReadonlyMap<string, BoardEvent>,
  now: number,
): number | null {
  const event = events.get(eventKey(plan.reading.root, planName(plan.reading.stem)));
  if (event === undefined || event.event !== "goal-blocked") return null;
  const stamped = Date.parse(event.ts);
  if (Number.isNaN(stamped)) return null;
  const at = Math.min(stamped, now);
  return plan.reading.mtimeMs > at ? null : at;
}

/** A count as the card draws it: whole, and inside a range a row can carry. */
function drawnCount(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), MAX_DRAWN_SECTIONS);
}

/** `3/5`, with the completed half never drawn above the total it is counted out of. */
function sectionCount(reading: PlanReading): string {
  const sections = drawnCount(reading.sections);
  return `${Math.min(drawnCount(reading.completed), sections)}/${sections}`;
}

/**
 * The bar for a plan's progress: filled left to right, one cell per section's share of the width,
 * rounded to nearest, and blank-padded to the full width so the count after it never moves.
 *
 * Any progress at all draws a cell, so a plan one section into twelve is told apart from one that
 * has not started. A plan whose doc declares no sections has nothing to measure and draws no bar,
 * which is the blank the count `0/0` beside it explains.
 */
function bar(reading: PlanReading): string {
  const sections = drawnCount(reading.sections);
  const completed = Math.min(drawnCount(reading.completed), sections);
  const scaled = sections === 0 ? 0 : Math.round((completed * BAR_CELLS) / sections);
  const cells = completed === 0 ? 0 : Math.min(Math.max(scaled, 1), BAR_CELLS);
  return `${BAR_GLYPH.repeat(cells)}${" ".repeat(BAR_CELLS - cells)}`;
}

/**
 * Text padded to a width in code points, which is the measure every fenced line is held in.
 *
 * Code points are not display columns: a field of emoji or of wide CJK draws wider than the count
 * this pads to, so the grid a padded column composes is a grid for text of one column per code
 * point and is locally broken by text that is not. A fenced block on this surface wraps to the
 * reader's window and never scrolls sideways, so what that costs is a wrapped row rather than a
 * line a reader cannot reach the end of.
 */
function padded(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(width - [...value].length, 0))}`;
}

/**
 * How many units of untrusted field text this card has handed to the escape, counted so a test can
 * hold one render to a cost bounded by what the readers' intake caps allow rather than by what a
 * plan file carries.
 *
 * The broker runs on one event loop and this card runs on a timer, so a render whose cost grew with
 * a field's own size would stall hook intake, heartbeats and the permission prompts behind them for
 * as long as it took. Wall clock cannot express that bound in a test: a loaded machine moves it by
 * an order of magnitude, where this count is the same number on any machine.
 */
export const fieldUnitsNeutralized = { count: 0 };

/**
 * One untrusted field, block-inert and bounded, measured for what neutralizing it costs.
 *
 * The measure is the string's own length rather than a count taken over it, so counting a field
 * costs nothing that scales with the field.
 */
function blockField(value: string, limit: number): string {
  fieldUnitsNeutralized.count += value.length;
  return inertBlockField(value, limit);
}

/**
 * What the bar's own glyph becomes in a status drawn where the bar goes.
 *
 * A status takes exactly the columns the bar takes, and nothing in the escape a fenced field gets
 * touches a drawing glyph, so a `Status:` value made of bar cells would compose a row identical to
 * a finished plan's and be told from one only by the count beside it, which is the part a glance
 * skips. The tilde is ASCII, so it draws in every font a fence is set in, and nothing about it reads
 * as a bar cell.
 */
const STATUS_BAR_SUBSTITUTE = "~";

/**
 * What is drawn where the bar goes: the bar for a plan in progress, and the status as its own text
 * for every other non-terminal value.
 *
 * The status is bounded before it is padded, so a crafted one takes its columns and no others, and
 * the substitution is made on the bounded text for the same reason.
 */
function measure(reading: PlanReading): string {
  if (reading.status.trim().toLowerCase() === IN_PROGRESS) return bar(reading);
  const status = blockField(reading.status, MEASURE_WIDTH).replaceAll(
    BAR_GLYPH,
    STATUS_BAR_SUBSTITUTE,
  );
  return padded(status, MEASURE_WIDTH);
}

/**
 * A plan's first line: the filename stem, then the bar or the status, then the count.
 *
 * The stem leads because it is the handle, the string the operator mentions in the channel and feeds
 * to `/kit-goal`. It takes the room the fixed columns to its right leave, so every bar on the card
 * stands in one column, and a stem past that room is cut with the mark `fit` leaves rather than
 * quietly shortened into a name that addresses a different plan.
 */
function planLine(reading: PlanReading, countWidth: number): string {
  const room = Math.max(MAX_BLOCK_WIDTH - 1 - MEASURE_WIDTH - COUNT_GAP.length - countWidth, 0);
  const stem = padded(blockField(reading.stem, room), room);
  const count = sectionCount(reading).padStart(countWidth);
  return `${stem} ${measure(reading)}${COUNT_GAP}${count}`;
}

/**
 * A plan's second line: the markers that change what the row means, how long since the doc last
 * moved, and what the latest Chapter says comes next.
 *
 * The markers lead, because a row whose state is held or whose run is blocked says something
 * different from the same row without them. They are ASCII rather than glyphs, and each therefore
 * costs exactly the columns it occupies, where an emoji is wider than the one character a monospace
 * grid counts it as. They are worded rather than legended, since a legend for two self-describing
 * markers spends a line of the card saying what the markers say.
 *
 * The prose is bounded to its own field cap first and then held to whatever the line has left, and
 * each cut that shortens it leaves `fit`'s mark, so a shortened `Next:` never reads as a whole one.
 */
function detailLine(plan: BoardPlan, blocked: number | null, now: number): string {
  const parts: string[] = [];
  if (blocked !== null) parts.push(`(blocked ${span(Math.max(now - blocked, 0))})`);
  if (plan.heldSince !== null) {
    parts.push(`(held ${span(Math.max(now - plan.heldSince, 0))})`);
  }
  parts.push(span(Math.max(now - plan.reading.mtimeMs, 0)));
  const head = `${ROW_INDENT}${parts.join(` ${SEPARATOR} `)}`;
  const next = plan.reading.next === null ? "" : blockField(plan.reading.next, MAX_NEXT_LENGTH);
  if (next === "") return fit(head, MAX_BLOCK_WIDTH);
  return fit(`${head} ${SEPARATOR} next: ${next}`, MAX_BLOCK_WIDTH);
}

/** The one line a plan the card holds no parse for draws: its name, and why there is no row. */
function failureLine(failure: PlanFailure): string {
  const said = ` (${NO_PARSE.get(failure.reason) ?? NO_PARSE_FALLBACK})`;
  const stem = blockField(failure.stem, Math.max(MAX_BLOCK_WIDTH - said.length, 0));
  return fit(`${stem}${said}`, MAX_BLOCK_WIDTH);
}

/**
 * The one line a root whose listing was cut draws.
 *
 * A root that dropped plans past the reader's per-root cap must not read as a root that has only the
 * plans it drew: the files past the cap are never opened, so there is no name to give for any of
 * them, and the count is the whole of what can honestly be said.
 */
function truncationLine(dropped: number): string {
  const plural = dropped === 1 ? "" : "s";
  return fit(`+${dropped} more plan${plural} in this project not shown`, MAX_BLOCK_WIDTH);
}

/** What a card that ran out of room ends with, naming what it left out rather than cutting silently. */
function overflowTail(plans: number, projects: number): string {
  const parts: string[] = [];
  if (plans > 0) parts.push(`+${plans} plan${plans === 1 ? "" : "s"}`);
  if (projects > 0) parts.push(`+${projects} project${projects === 1 ? "" : "s"}`);
  return `(${parts.join(", ")} not shown)`;
}

/**
 * One thing a project's block draws: the lines it takes, and how many plans drawing it accounts
 * for.
 *
 * A row and a no-parse line each account for the one plan they name; a truncation note accounts for
 * every plan the cap dropped, because the note is the only place those plans are represented at all.
 * That count is what the overflow tail spends, so a card that ran out of room before an item reports
 * exactly the plans it left unmentioned.
 */
type BlockItem = { lines: string[]; plans: number };

/** One project's section: the bold line naming it, and the items its fenced block draws. */
type ProjectSection = { label: string; items: BlockItem[]; plans: number };

/**
 * The card's projects in the order they were configured, each carrying only what it has to draw.
 *
 * A project holds that place whatever kind of entry it has in it, rows or a plan that would not
 * parse or a note that its listing was cut. Ordering by what the sweep managed to parse would sink a
 * project whose one plan has never parsed below every project with a readable plan, and lift it back
 * up the tick that plan first parses.
 *
 * Roots are grouped by their configured string rather than by a normalized form, because every root
 * on every input here came from the one configured list the sweep and the event reader were both
 * handed. A root on those inputs the configured list does not name is drawn after the ones it does
 * rather than dropped. A project with nothing to draw gets no entry at all, which is what leaves a
 * configured root with no open plans drawing nothing rather than an empty block.
 *
 * A project is labelled by the last segment of its configured root, so a root configured at or one
 * level under a home directory draws the operator's OS username into a channel.
 */
function sections(
  roots: readonly string[],
  plans: readonly BoardPlan[],
  failures: readonly PlanFailure[],
  truncated: readonly PlanTruncation[],
  events: ReadonlyMap<string, BoardEvent>,
  now: number,
): ProjectSection[] {
  const open = plans.filter((plan) => !plan.reading.terminal);
  // The column is measured across every project's plans in one pass, so a count on one project
  // stands in the same column as a count on the next and the bars above them line up down the whole
  // card, which is what lets two projects be read at one glance.
  const countWidth = open.reduce(
    (width, plan) => Math.min(Math.max(width, sectionCount(plan.reading).length), MAX_COUNT_WIDTH),
    0,
  );

  const order: string[] = [...new Set(roots)];
  const configured = new Set(order);
  const byRoot = new Map<string, BlockItem[]>();
  const place = (root: string): BlockItem[] => {
    const held = byRoot.get(root);
    if (held !== undefined) return held;
    if (!configured.has(root)) order.push(root);
    const fresh: BlockItem[] = [];
    byRoot.set(root, fresh);
    return fresh;
  };

  const drawn = new Set<string>();
  for (const plan of open) {
    drawn.add(eventKey(plan.reading.root, planName(plan.reading.stem)));
    place(plan.reading.root).push({
      lines: [
        planLine(plan.reading, countWidth),
        detailLine(plan, blockedAt(plan, events, now), now),
      ],
      plans: 1,
    });
  }
  for (const failure of failures) {
    // A plan the caller redrew from a held parse is already on the card, so its failure this tick
    // draws no second line saying the card has nothing for it.
    if (drawn.has(eventKey(failure.root, planName(failure.stem)))) continue;
    place(failure.root).push({ lines: [failureLine(failure)], plans: 1 });
  }
  for (const cut of truncated) {
    const dropped = Math.max(Math.trunc(cut.dropped), 0);
    if (dropped > 0) place(cut.root).push({ lines: [truncationLine(dropped)], plans: dropped });
  }

  return order
    .filter((root) => (byRoot.get(root)?.length ?? 0) > 0)
    .map((root, index) => {
      const named = inertField(lastSegment(root), MAX_PROJECT_LABEL_LENGTH);
      const items = byRoot.get(root) ?? [];
      return {
        label: `**${named === "" ? unnamedProject(index) : named}**`,
        items,
        plans: items.reduce((sum, item) => sum + item.plans, 0),
      };
    });
}

/**
 * The card's closing line: how old the information on it is.
 *
 * Anchored to the oldest parse behind the card's rows rather than to the current time, which is the
 * sibling card's discipline and load-bearing for the same reason: this card is edited only when its
 * text changes, and a footer carrying a clock would rewrite the message on every refresh. A card
 * whose plans were all read this tick is as of just now, and one redrawing a held parse says how old
 * that parse is, which is the whole of what a reader cannot see from the rows.
 *
 * The plans counted are the non-terminal ones, which is the set the rows are composed from. A
 * terminal plan draws nothing, so a held parse of one is information no reader is looking at, and
 * letting it age the footer would put an hours-old stamp under a card every visible row of which was
 * read this tick.
 */
function footerLine(plans: readonly BoardPlan[], now: number): string {
  const oldest = plans.reduce(
    (at, plan) =>
      plan.heldSince === null || plan.reading.terminal ? at : Math.min(at, plan.heldSince),
    now,
  );
  return `card as of ${heartbeat(Math.max(now - oldest, 0))}`;
}

/**
 * The whole card, bounded to one message: a title heading, then a bold project label and a fenced
 * block per project, then the footer.
 *
 * Composed project by project against a running budget rather than assembled whole and cut, because
 * a card truncated at the end would drop the last projects silently and read as a fleet with fewer
 * of them. The title and the footer are taken out of the budget before the first block is measured,
 * so both survive a card that ran out of room, and every stop draws the tail naming how many plans
 * and how many whole projects are missing. A project's label and the two delimiter lines of its
 * fence are spent together with its first item: a label over an empty block, or a fence with nothing
 * between its delimiters, is what a budget spent line by line would leave behind.
 *
 * `events` is read for its `latest` map alone; the offset and the malformed tally are the reader's
 * own bookkeeping and nothing on the card is drawn from them.
 *
 * Nothing here reads a clock or anything else the inputs do not carry, so two renders of the same
 * inputs compose the same bytes.
 */
export function renderBoardCard(input: {
  /** The configured project roots, in the order the card draws their blocks. A root with nothing to
   * draw takes no block, and a root on any other input here that this list does not name is drawn
   * after the ones it does. */
  roots: readonly string[];
  plans: readonly BoardPlan[];
  /** The plans this tick could not read and the caller holds no parse for. One the caller does hold
   * a parse for belongs in `plans` marked held, where it draws its last good row. */
  failures: readonly PlanFailure[];
  truncated: readonly PlanTruncation[];
  events: EventReaderState;
  now: number;
}): string {
  const footerLines = wrapped(footerLine(input.plans, input.now));
  const lines: string[] = [PREVIEW, TITLE];
  let used =
    PREVIEW.length +
    1 +
    TITLE.length +
    1 +
    footerLines.reduce((sum, line) => sum + 1 + line.length, 0);
  const finish = (): string => {
    lines.push(...footerLines);
    return lines.join("\n");
  };

  const projects = sections(
    input.roots,
    input.plans,
    input.failures,
    input.truncated,
    eventIndex(input.events.latest),
    input.now,
  );
  if (projects.length === 0) {
    lines.push(NOTHING_OPEN);
    return finish();
  }

  let plansLeft = projects.reduce((sum, project) => sum + project.plans, 0);
  for (const [index, project] of projects.entries()) {
    const shown: string[] = [];
    let stopped = false;
    for (const item of project.items) {
      const cost =
        (shown.length === 0 ? 1 + project.label.length + FENCE_COST : 0) +
        item.lines.reduce((sum, line) => sum + 1 + line.length, 0);
      // The tail's room is reserved against every item, the last included: one rule with no branch
      // to get wrong, at the price of at most one tail's width of unused room on a full card.
      const tail = overflowTail(plansLeft, projects.length - index - (shown.length === 0 ? 0 : 1));
      if (used + cost + 1 + tail.length > MAX_CARD_LENGTH) {
        stopped = true;
        break;
      }
      shown.push(...item.lines);
      used += cost;
      plansLeft -= item.plans;
    }
    if (shown.length > 0) lines.push(project.label, fenced(shown));
    if (stopped) {
      const missing = projects.length - index - (shown.length === 0 ? 0 : 1);
      lines.push(...wrapped(overflowTail(plansLeft, missing)));
      return finish();
    }
  }
  return finish();
}
