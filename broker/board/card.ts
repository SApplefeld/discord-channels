// The board card: one bounded message body listing every open plan across this host's configured
// project roots, grouped by project.
//
// Pure rendering, the fleet usage card's shape. Everything it draws arrives as arguments, the
// current time included, so the same inputs always compose the same body: the thread this card
// lives in is edited only when its text changes, and a clock read inside the renderer would be a
// difference on every refresh.
//
// Membership is every non-terminal plan. Only `Status: Complete` is hidden, so a Draft is visible,
// and a status spelled some other way surfaces as that spelling rather than vanishing into a filter
// it did not match. The one status drawn as no clause at all is the ordinary in-progress one, which
// is what most of a fleet carries: a word spent on every plan tells two of them apart from nothing.
//
// The body is a markdown list rather than a table: a fenced label per project, a bullet per plan,
// and the plan's facts on sub-bullets under it. Discord wraps a list item at its own word
// boundaries and indents the wrap under the bullet, so a sentence-length status or a whole `Next:`
// phrase costs a wrapped line here. A column of fixed width could only cut one, and it would cut it
// exactly where the information is. So no field on this card is held to a display width, and there
// is no grid for a field of emoji or of wide CJK to break.
//
// Every string it draws is untrusted. A plan's filename, its `Status:` value and its `Next:` prose
// are model-written text out of another program's files, and an event's fields are that program's
// own. All of them land on live markdown, so all of them take `../discord/render.ts`'s `inertField`,
// the full escape, which reaches every metacharacter including the angle brackets Discord's chip
// syntax lives inside: this is the neutralization the question messages and the permission prompt
// already render untrusted text under. An `@everyone` surviving as text pings nobody, because the
// transport names an empty `allowed_mentions` parse list, and that is the half of the job this
// renderer does not do.
//
// The work one render costs is bounded by the plans it is handed and not by the bytes any one of
// them carries: one pass to index the events, one pass to group the plans, and one map lookup per
// plan. Every untrusted field is bounded before it arrives, each by whichever reader took it in:
// the two free-form plan values by `./plans.ts`'s intake caps, an event's fields by `./events.ts`'s,
// and a filename by the name limit the filesystem itself enforces. So the escaping here walks a
// bounded string per field, and nothing walks a product of two quantities that both come from
// another program's files.
import {
  MAX_CARD_LENGTH,
  fenced,
  fit,
  heartbeat,
  inertBlockField,
  inertField,
  span,
} from "../discord/render.ts";
import { eventKey } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import { MAX_INTAKE_STATUS_LENGTH } from "./plans.ts";
import type { PlanFailure, PlanFailureReason, PlanReading, PlanTruncation } from "./plans.ts";

/**
 * One plan as the card draws it: the parse to draw, and when that parse was last read off the file.
 *
 * `heldSince` is null for a plan read this tick. A number is the instant the parse was last known
 * good, which the card draws as a marker whose age climbs: a plan doc mid-write by a live session is
 * unparseable for a tick, the caller redraws the last parse it held, and the marker is what keeps a
 * redrawn plan from reading as a freshly read one.
 */
export type BoardPlan = {
  reading: PlanReading;
  heldSince: number | null;
};

/**
 * The largest section count the card draws. The counts come out of a plan doc's own headings, so a
 * file full of them is bounded here rather than allowed to render a figure that takes the line.
 */
export const MAX_DRAWN_SECTIONS = 999;

const SEPARATOR = "·";

/**
 * The list this card's body is: a one-line fence naming each project, a bullet per plan, and the
 * plan's facts on sub-bullets indented under it.
 *
 * A fence draws as a full-width shaded box in every Discord client, which is what makes one
 * project's list stop and the next start at a glance: a reader scrolls the card by that boundary.
 * Two spaces is what Discord reads as one level of nesting, so the facts hang under their plan's
 * bullet rather than beside it.
 */
const BULLET = "-";
const SUB_BULLET = "  -";

/**
 * What sits between one project's list and the next project's label, and between the last list and
 * the footer.
 *
 * A blank line ends a markdown list, which is exactly what is wanted between two projects and
 * exactly what must never appear inside one: a blank line between two plans would restart the list
 * and draw the rest of the project as a second one.
 */
const PROJECT_GAP = "";

/**
 * Room for the two fields this card caps itself.
 *
 * The `Next:` value is free-form prose a Chapter carries, and it is the one field with no natural
 * length: this is what a phrase naming the next section runs to, and past it the line says it was
 * cut. A project label is the last segment of a configured root, which is a directory name and not
 * a field this card has a reason to draw a paragraph of.
 *
 * The label sits above `../discord/render.ts`'s `MAX_BLOCK_WIDTH`, which is the width the grid cards
 * hold their columns to. That width exists to keep a grid's columns aligned, and this label is free
 * text in a fenced box with no grid to break: a fenced block wraps to the reader's own window width
 * and never scrolls sideways, so a long label costs a wrapped line inside the shaded box. A cut
 * directory name is the worse failure, because that name is what the operator recognizes the project
 * by.
 *
 * Each binds in code points and in UTF-16 units alike, whichever runs out first, since that is what
 * `fit` holds a string to. So prose written in astral characters is cut at half this many of them,
 * and the mark `fit` leaves says so.
 */
export const MAX_NEXT_LENGTH = 120;
export const MAX_PROJECT_LABEL_LENGTH = 60;

/**
 * The bound a filename stem is escaped under, in code points.
 *
 * Above the longest name component any filesystem this runs on accepts, so it never shortens a stem
 * a sweep really found. That is the point of it: the stem is the handle the operator mentions in the
 * channel and feeds to `/kit-goal`, and a shortened one addresses a different plan. It is here so
 * that the one drawn field no cap of this broker's covers still has a bound.
 */
const MAX_STEM_LENGTH = 255;

/**
 * The status value that draws no clause of its own, compared case-insensitively on the trimmed
 * value. Every other non-terminal status is drawn as written.
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

/** What a plan the card has no parse for says instead of its facts, one static phrase per reason.
 * The reasons are this reader's own words, never anything read out of the file.
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

/** What a plan is called when its filename stem neutralizes to nothing, which a file named `.md` is
 * swept under. A bullet with no name on it says less than one saying the name is unusable. */
const UNNAMED_PLAN = "(unnamed plan)";

/** What a plan's status is called when it carries text that neutralizes to nothing, which a status
 * written entirely in invisible characters is drawn under. The ordinary in-progress value is the one
 * status this card draws as an absence, so a second value drawing as one would make that absence
 * ambiguous: this says the status is there and unusable rather than letting it pass for ordinary. */
const UNREADABLE_STATUS = "(unreadable status)";

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
 * `foo.md` standing beside it in the same directory: the two plans would answer to one name, so an
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

/** A count as the card draws it: whole, and inside a range a line can carry. */
function drawnCount(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), MAX_DRAWN_SECTIONS);
}

/** `3/5`, with the completed half never drawn above the total it is counted out of. */
function sectionCount(reading: PlanReading): string {
  const sections = drawnCount(reading.sections);
  return `${Math.min(drawnCount(reading.completed), sections)}/${sections}`;
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
 * How much longer than its input the live-markdown escape can make a field, as a multiple of the
 * input's length in code points. The bound holds in both measures `fit` binds a string in, code
 * points and UTF-16 units, because the two cases cannot land on one character.
 *
 * Every character the escape touches is ASCII, so an escaped code point leaves as two code points
 * and two units. An astral code point is one the escape never touches, so it leaves as the one code
 * point and the two units it arrived as. Either way a code point yields at most two of each, and
 * the invisible-stripping and whitespace collapse that run first only ever remove characters.
 *
 * This is what makes the limit each field is escaped under a guard rather than a second cut: a field
 * already held to N code points renders whole under N times this, whatever characters it carries.
 * Escaping under the cap itself would cut a status of underscores in half, because the cap counts
 * what was written and the limit counts what the escape wrote. A limit is still passed, so a field
 * that somehow arrives under no cap at all is shortened rather than able to take the whole card,
 * and the tighter this multiple is the less of the card such a field can take.
 */
const MAX_ESCAPE_EXPANSION = 2;

/**
 * One untrusted field the card draws whole: escaped for live markdown, guarded, and measured for
 * what neutralizing it costs.
 *
 * `cap` is the bound the value already carries from the reader that took it in, so the guard above
 * it can never fire on a field that reader bounded.
 *
 * The measure is the string's own length rather than a count taken over it, so counting a field
 * costs nothing that scales with the field.
 */
function field(value: string, cap: number): string {
  fieldUnitsNeutralized.count += value.length;
  return inertField(value, cap * MAX_ESCAPE_EXPANSION);
}

/**
 * One untrusted field this card holds to a cap of its own: measured, cut, then escaped.
 *
 * The measure is taken on the value as it arrived, before the cut, because the cut is itself a walk
 * over the whole value: `fit` spreads what it is given to count code points. A measure read off the
 * cut string would report the cap while the render had just walked whatever the field carried, which
 * is exactly the cost `fieldUnitsNeutralized` exists to make visible.
 *
 * Cutting before escaping is the same rule the other way round: the escape runs on the shortened
 * value, so nothing here walks the field twice as text it is about to throw away. The cut leaves
 * `fit`'s mark, so a shortened field never reads as a whole one.
 */
function cutField(value: string, cap: number): string {
  fieldUnitsNeutralized.count += value.length;
  return inertField(fit(value, cap), cap * MAX_ESCAPE_EXPANSION);
}

/**
 * The `cutField` pairing for a field bound for a fenced line: measured, cut, then block-inert.
 *
 * The order mirrors `cutField` exactly, for the same reason: the cut is a walk over the value that
 * would otherwise run twice were the neutralizer applied first. The guard `inertBlockField` takes is
 * `cap` itself rather than `cap * MAX_ESCAPE_EXPANSION`, because block-inert substitutes one
 * character for one and strips the rest, so it never grows a value already held to `cap`; that
 * multiple exists for the markdown escape's expansion alone.
 */
function cutBlockField(value: string, cap: number): string {
  fieldUnitsNeutralized.count += value.length;
  return inertBlockField(fit(value, cap), cap);
}

/** A plan's filename stem as the card draws it, escaped whole and never shortened. */
function planStem(stem: string): string {
  const named = field(stem, MAX_STEM_LENGTH);
  return named === "" ? UNNAMED_PLAN : named;
}

/**
 * A plan's status as its own clause, or nothing at all for the ordinary in-progress value.
 *
 * That value is what most of a fleet carries, and with nothing else occupying the spot its absence
 * is unambiguous. Every other non-terminal status is drawn as it was written, whole to the cap the
 * plan reader took it in under: the status is where a plan says what it is waiting on, and a value
 * near the ordinary one (`In Progress (auto)`) differs from it in exactly the words a shortened one
 * would lose.
 *
 * A status carrying text that neutralizes to nothing is named rather than dropped, since dropping it
 * would draw it as the one absence this card gives a meaning to. A status that was already blank is
 * a different case and draws nothing: there is no text there to report unusable.
 */
function statusClause(reading: PlanReading): string {
  if (reading.status.trim().toLowerCase() === IN_PROGRESS) return "";
  const drawn = field(reading.status, MAX_INTAKE_STATUS_LENGTH);
  if (drawn !== "") return drawn;
  return reading.status.trim() === "" ? "" : UNREADABLE_STATUS;
}

/**
 * A plan's facts, on one sub-bullet under its name: the markers that change what the plan means, how
 * far through its sections it is, how long since the doc last moved, and its status.
 *
 * The markers lead, because a plan whose parse is held or whose run is blocked says something
 * different from the same plan without them. They are worded rather than legended, since a legend
 * for two self-describing markers spends a line of the card saying what the markers say.
 *
 * A plan whose doc declares no sections draws no count: `0/0` is what a doc with no `## Sections of
 * Work` block yields, and a fraction of nothing measures nothing. The age is the one clause always
 * drawn, so this line is never empty whatever the plan carries.
 */
function factsLine(plan: BoardPlan, blocked: number | null, now: number): string {
  const parts: string[] = [];
  if (blocked !== null) parts.push(`blocked ${span(Math.max(now - blocked, 0))}`);
  if (plan.heldSince !== null) parts.push(`held ${span(Math.max(now - plan.heldSince, 0))}`);
  if (drawnCount(plan.reading.sections) > 0) parts.push(sectionCount(plan.reading));
  parts.push(span(Math.max(now - plan.reading.mtimeMs, 0)));
  const status = statusClause(plan.reading);
  if (status !== "") parts.push(status);
  return `${SUB_BULLET} ${parts.join(` ${SEPARATOR} `)}`;
}

/**
 * One plan's lines: its filename stem in bold on a bullet of its own, its facts under that, and what
 * the latest Chapter says comes next under those.
 *
 * The stem is the whole of the bullet because it is the handle, the string the operator mentions in
 * the channel, and a line carrying nothing else is the line a reader scans the list by. Bold rather
 * than a heading of its own rank: Discord puts a margin around every heading, and at one per plan
 * that margin is most of what a card read on a phone would be.
 *
 * `Next:` takes a sub-bullet rather than a clause beside the facts, because it is a sentence and
 * they are figures: on one line the figures would be what wraps away. It is the one plan field this
 * card caps itself, so it goes through the cutting neutralizer rather than the whole-field one.
 */
function planLines(plan: BoardPlan, blocked: number | null, now: number): string[] {
  const lines = [
    `${BULLET} **${planStem(plan.reading.stem)}**`,
    factsLine(plan, blocked, now),
  ];
  const next =
    plan.reading.next === null ? "" : cutField(plan.reading.next, MAX_NEXT_LENGTH);
  if (next !== "") lines.push(`${SUB_BULLET} next: ${next}`);
  return lines;
}

/** The one bullet a plan the card holds no parse for draws: its name, and why there are no facts
 * under it. Unemphasized, which is what tells it apart at a glance from the plans that parsed. */
function failureLine(failure: PlanFailure): string {
  return `${BULLET} ${planStem(failure.stem)} (${NO_PARSE.get(failure.reason) ?? NO_PARSE_FALLBACK})`;
}

/**
 * The one bullet a root whose listing was cut draws.
 *
 * A root that dropped plans past the reader's per-root cap must not read as a root that has only the
 * plans it drew: the files past the cap are never opened, so there is no name to give for any of
 * them, and the count is the whole of what can honestly be said.
 */
function truncationLine(dropped: number): string {
  const plural = dropped === 1 ? "" : "s";
  return `${BULLET} +${dropped} more plan${plural} in this project not shown`;
}

/** What a card that ran out of room ends with, naming what it left out rather than cutting silently. */
function overflowTail(plans: number, projects: number): string {
  const parts: string[] = [];
  if (plans > 0) parts.push(`+${plans} plan${plans === 1 ? "" : "s"}`);
  if (projects > 0) parts.push(`+${projects} project${projects === 1 ? "" : "s"}`);
  return `(${parts.join(", ")} not shown)`;
}

/** What a run of lines costs the card: each line's own text and the newline that joins it on. */
function spent(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + 1 + line.length, 0);
}

/**
 * One thing a project's list draws: the lines it takes, and how many plans drawing it accounts for.
 *
 * A plan's bullets and a no-parse line each account for the one plan they name; a truncation note
 * accounts for every plan the cap dropped, because the note is the only place those plans are
 * represented at all. That count is what the overflow tail spends, so a card that ran out of room
 * before an item reports exactly the plans it left unmentioned.
 */
type BlockItem = { lines: string[]; plans: number };

/** One project's section: the fenced label naming it, and the items its list draws. */
type ProjectSection = { label: string; items: BlockItem[]; plans: number };

/**
 * The card's projects in the order they were configured, each carrying only what it has to draw.
 *
 * A project holds that place whatever kind of entry it has in it, plans or a plan that would not
 * parse or a note that its listing was cut. Ordering by what the sweep managed to parse would sink a
 * project whose one plan has never parsed below every project with a readable plan, and lift it back
 * up the tick that plan first parses.
 *
 * Roots are grouped by their configured string rather than by a normalized form, because every root
 * on every input here came from the one configured list the sweep and the event reader were both
 * handed. A root on those inputs the configured list does not name is drawn after the ones it does
 * rather than dropped. A project with nothing to draw gets no entry at all, which is what leaves a
 * configured root with no open plans drawing nothing rather than a label over an empty list.
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
      lines: planLines(plan, blockedAt(plan, events, now), now),
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
      // A directory name is held to this card's own cap, which is a cut rather than a guard, so it
      // is marked where it shortens one.
      const named = cutBlockField(lastSegment(root), MAX_PROJECT_LABEL_LENGTH);
      const items = byRoot.get(root) ?? [];
      // `fenced` joins its lines and the two delimiters into one string carrying two internal
      // newlines, so this label is one element wherever it is pushed onto a run of lines. `spent()`
      // charges each element its own length plus one newline, so pushing this single element already
      // charges exactly the fence's three lines: no separate arithmetic accounts for the fence.
      return {
        label: fenced([named === "" ? unnamedProject(index) : named]),
        items,
        plans: items.reduce((sum, item) => sum + item.plans, 0),
      };
    });
}

/**
 * The card's closing line: how old the information on it is.
 *
 * Anchored to the oldest parse behind the card's plans rather than to the current time, which is the
 * sibling card's discipline and load-bearing for the same reason: this card is edited only when its
 * text changes, and a footer carrying a clock would rewrite the message on every refresh. A card
 * whose plans were all read this tick is as of just now, and one redrawing a held parse says how old
 * that parse is, which is the whole of what a reader cannot see from the list.
 *
 * The plans counted are the non-terminal ones, which is the set the list is composed from. A
 * terminal plan draws nothing, so a held parse of one is information no reader is looking at, and
 * letting it age the footer would put an hours-old stamp under a card every visible line of which
 * was read this tick.
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
 * The whole card, bounded to one message: a title heading, then a fenced label and a list of plans
 * per project, then the footer.
 *
 * Composed project by project against a running budget rather than assembled whole and cut, because
 * a card truncated at the end would drop the last projects silently and read as a fleet with fewer
 * of them. The title and the footer are taken out of the budget before the first list is measured,
 * so both survive a card that ran out of room, and every stop draws the tail naming how many plans
 * and how many whole projects are missing. A project's label, and the blank line that closes the
 * list above it, are spent together with its first item: a label standing over an empty list is what
 * a budget spent line by line would leave behind. Every blank line the shape requires is charged the
 * same way, because a line the card emits costs its newline whether or not it carries text.
 *
 * `events` is read for its `latest` map alone; the offset and the malformed tally are the reader's
 * own bookkeeping and nothing on the card is drawn from them.
 *
 * Nothing here reads a clock or anything else the inputs do not carry, so two renders of the same
 * inputs compose the same bytes.
 */
export function renderBoardCard(input: {
  /** The configured project roots, in the order the card draws their lists. A root with nothing to
   * draw takes no label, and a root on any other input here that this list does not name is drawn
   * after the ones it does. */
  roots: readonly string[];
  plans: readonly BoardPlan[];
  /** The plans this tick could not read and the caller holds no parse for. One the caller does hold
   * a parse for belongs in `plans` marked held, where it draws its last good bullets. */
  failures: readonly PlanFailure[];
  truncated: readonly PlanTruncation[];
  events: EventReaderState;
  now: number;
}): string {
  const footer = footerLine(input.plans, input.now);
  const lines: string[] = [PREVIEW, TITLE];
  let used = spent([PREVIEW, TITLE, PROJECT_GAP, footer]);
  const finish = (): string => {
    lines.push(PROJECT_GAP, footer);
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
      const opening = shown.length === 0 ? [PROJECT_GAP, project.label] : [];
      const cost = spent([...opening, ...item.lines]);
      // The tail's room is reserved against every item, the last included: one rule with no branch
      // to get wrong, at the price of at most one tail's width of unused room on a full card. Its
      // own blank line is reserved with it, because the tail closes the list above it the way the
      // footer and every project label do.
      const tail = overflowTail(plansLeft, projects.length - index - (shown.length === 0 ? 0 : 1));
      if (used + cost + spent([PROJECT_GAP, tail]) > MAX_CARD_LENGTH) {
        stopped = true;
        break;
      }
      shown.push(...opening, ...item.lines);
      used += cost;
      plansLeft -= item.plans;
    }
    if (shown.length > 0) lines.push(...shown);
    if (stopped) {
      const missing = projects.length - index - (shown.length === 0 ? 0 : 1);
      lines.push(PROJECT_GAP, overflowTail(plansLeft, missing));
      return finish();
    }
  }
  return finish();
}
