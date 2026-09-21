// The status word: what each entry in one worker persona's queue is doing, one plain word per entry.
//
// Pure, the board card's own shape. The entries, the plan readings, the heartbeat's turn state, the
// event reader's state and the current time all arrive as arguments, so the same inputs always
// answer the same words. Nothing here opens a file, reads a clock, or writes anything.
//
// The words are the card's own vocabulary and never the persona plugin's. A store's status is
// bookkeeping the plugin's controller keeps for itself: a worker working normally records `blocked`
// with the reason `Max rounds reached` when its round budget rolls over, and `paused` there means
// "not now" rather than "will not run". Both read on a card as a fleet in trouble. So no store
// status, no store block reason and no lead state leaves this module, and the one string that does
// is the reason a blocked entry draws, which is the text saying what the block is waiting on.
//
// What is blocked reaches the card by four routes and no others: an outstanding kit `goal-blocked`
// event, a lead whose own state says blocked, a store block that is not the round limit, and a stall
// the plugin's nudge cap set. A worker's free-text pause reason is not one of them, because nothing
// here judges prose.
//
// Every field read here is another program's text and may be absent, of the wrong type or absurd.
// Each is dropped and fallen through rather than thrown on, which is the rule `./queues.ts` already
// reads the store under.
import { span } from "../discord/render.ts";
import { blockedAt, eventIndex } from "./card.ts";
import { comparablePath } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import { queueKey } from "./queues.ts";
import type { PersonaQueue, QueueEntry, QueuePlanReading } from "./queues.ts";

/**
 * What one queue entry is doing, in the word the card draws it by.
 *
 * The rules that pick one are ordered and the first to match wins, so this union is read top to
 * bottom: a done entry is never blocked, and a blocked one is never in flight.
 *
 * `in flight` is the word for the entry the worker is on. The renderer draws it as `in progress`,
 * which is the layout's wording rather than this rule's.
 */
export type StatusWord =
  | "done"
  | "blocked"
  | "stalled"
  | "in flight"
  | "started, parked"
  | "up next"
  | "queued";

/**
 * One entry's answer: which entry it is about, its word, and the reason where it has one.
 *
 * `id` is the store's own goal id, which is the handle the reading map is keyed by and the value
 * `activeGoalId` names. It carries no text the store wrote about the entry's state.
 *
 * `reason` is null on every word but `blocked`, and null on a blocked entry whose block is an event
 * or a lead with nothing to say: there is no such thing here as a reason for being queued.
 */
export type EntryStatus = {
  readonly id: string;
  readonly word: StatusWord;
  readonly reason: string | null;
};

/**
 * One persona's whole answer: a word per drawn entry in queue order, the counts the group's label
 * carries, and what the worker itself is doing.
 *
 * `entries` holds only the entries the first rule draws at all, so its length is `total` and the
 * caller reads it as the queue: a root entry and an abandoned one are absent rather than present
 * with a word that says they are not drawn.
 */
export type PersonaStatus = {
  readonly entries: readonly EntryStatus[];
  readonly done: number;
  readonly total: number;
  readonly worker: string;
};

/**
 * The entry kind the card never draws.
 *
 * A root is the goal tree's own trunk rather than a plan in the queue, so drawing one would put a
 * line on the card that no plan document stands behind and count it against the group's total.
 */
const ROOT_KIND = "root";

/** The store statuses this module reads, each compared on the trimmed and case-folded value. The
 * plugin writes them lower case; folding costs nothing and keeps a store written by hand from
 * falling through every rule into `queued`. */
const ABANDONED = "abandoned";
const COMPLETE = "complete";
const BLOCKED = "blocked";
const PAUSED = "paused";

/**
 * The one block reason that is not a block.
 *
 * The plugin's controller writes this on an entry whose worker has used its round budget for the
 * moment, which is ordinary running and not a stop. Both live workers carried it while working
 * normally on the day this card was designed. An entry wearing it falls through the blocked rule and
 * is judged by the later rules like any other, and the string itself never leaves this module: it is
 * the plugin's bookkeeping, and on a card it reads as a worker that has hit a wall.
 *
 * Compared on the trimmed and case-folded value, the way every store string here is compared,
 * because a reason differing from this one by a trailing space or a capital is the same bookkeeping
 * and drawing it as a block is the misreading this whole module exists to remove.
 *
 * The comparison is on the whole value rather than a prefix, which is the spec's word. So a reason
 * that merely opens with this string, one carrying a round count after it, is a block by that rule.
 * `reason` below is what keeps the string itself off the card in that case.
 */
const MAX_ROUNDS_REACHED = "Max rounds reached";

/** The plan status that means a document has been started, compared case-insensitively on the
 * trimmed value. It is the one status the in-flight and parked rules read, and `./plans.ts` holds
 * the value itself to its own intake cap. */
const IN_PROGRESS = "in progress";

/** The lead state that says the worker's own lead judged this entry blocked. */
const LEAD_BLOCKED = "blocked";

/** What the group's label says the worker is doing. `running now` is what the heartbeat says on its
 * own; `nothing started` is what an idle worker with no entry in flight is, which is the one state a
 * span of idleness cannot express. */
const RUNNING_NOW = "running now";
const NOTHING_STARTED = "nothing started";
const IDLE = "idle";

/** A store string as the rules compare it: trimmed, case-folded, and empty for anything absent. */
function plain(value: string | undefined): string {
  return value === undefined ? "" : value.trim().toLowerCase();
}

/**
 * A modification time as the in-flight rule orders by it: the value itself, or negative infinity for
 * anything that is not a finite number.
 *
 * The same guard `./card.ts` puts on the mtime it sorts projects by, and here for the same reason: a
 * comparator handed a value that is neither above, below nor equal to another orders nothing, and
 * the word `in flight` would land on whichever entry the comparison happened to leave standing.
 */
function touchedAt(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** A reading the join parsed, which is the arm of the union that carries a status and a modification
 * time. The other arm is a document found in an archive folder and never opened. */
type ParsedReading = Extract<QueuePlanReading, { archived: false }>;

/** A plan document whose own `Status:` says it has been started. An archived reading carries no
 * parse at all, so it is never one: the card has already called such an entry done. */
function started(reading: QueuePlanReading | undefined): reading is ParsedReading {
  return reading !== undefined && !reading.archived && plain(reading.status) === IN_PROGRESS;
}

/**
 * The spelling of this persona's working folder that the event state holds, or null when it holds
 * none.
 *
 * The event reader is handed the configured project roots first and the personas' working folders
 * after them, and it keeps the first spelling that claims a folder. So an event for this persona can
 * sit under a root the operator configured, spelled as that setting spells it, while the roster
 * writes the same folder with forward slashes. The events are keyed by the spelling the reader kept,
 * so the lookup has to ask for that one: a key built from the roster's spelling would miss every
 * event for a persona whose folder is also a configured project.
 *
 * `comparablePath` is the comparison the event reader itself matched those roots under, reused here
 * rather than restated, so a folder that claimed a root there resolves to that root here.
 *
 * The scan is over the kept events, which the reader holds to its own pair cap, and it runs once per
 * persona per tick.
 */
function heldRoot(latest: ReadonlyMap<string, BoardEvent>, workdir: string): string | null {
  const wanted = comparablePath(workdir);
  for (const event of latest.values()) {
    if (comparablePath(event.root) === wanted) return event.root;
  }
  return null;
}

/**
 * Whether a kit `goal-blocked` event is outstanding for this entry's plan.
 *
 * The rule itself is the card's, `blockedAt` in `./card.ts`, applied to a reading standing in the
 * root spelling the events are keyed under. An entry with no parsed plan reading takes no event,
 * because the rule reads the document's own modification time to decide whether a block has since
 * cleared and an archived entry carries none. Such an entry is already done anyway.
 */
function eventBlocked(
  reading: QueuePlanReading | undefined,
  root: string | null,
  events: ReadonlyMap<string, BoardEvent>,
  now: number,
): boolean {
  if (root === null || reading === undefined || reading.archived) return false;
  return blockedAt({ reading: { ...reading, root }, heldSince: null }, events, now) !== null;
}

/**
 * Why this entry is blocked, or null when it is not blocked at all. A blocked entry with nothing to
 * say about it answers with a null reason rather than with no block.
 *
 * The three routes are read in the order the reason rule needs them. A lead that says blocked speaks
 * for the run itself, so its own reason wins. A store block that is not the round limit draws the
 * reason the store wrote, and only there: the round-limit reason is not a block at all, and drawing
 * it as the reason for a block found by another route would put the plugin's bookkeeping on the card
 * under a word that makes it look like the cause. An event knows nothing but that the run stopped
 * needing a person, so it draws no reason.
 *
 * A reason that is nothing but whitespace is no reason. The renderer holds the text it draws to its
 * own width, so no cut is taken here.
 */
function blockOf(
  entry: QueueEntry,
  reading: QueuePlanReading | undefined,
  root: string | null,
  events: ReadonlyMap<string, BoardEvent>,
  now: number,
): { reason: string | null } | null {
  const lead = plain(entry.lead?.state) === LEAD_BLOCKED;
  const stored =
    plain(entry.status) === BLOCKED && plain(entry.blockedReason) !== plain(MAX_ROUNDS_REACHED);
  if (lead) return { reason: reason(entry.lead?.reason) };
  if (stored) return { reason: reason(entry.blockedReason) };
  return eventBlocked(reading, root, events, now) ? { reason: null } : null;
}

/**
 * A reason as it rides out: the text as written, or null where there is no text in it.
 *
 * Text carrying the round limit's own string draws nothing, whatever else it says. The block rule
 * above matches that string whole, so a store writing a round count after it, `Max rounds reached
 * (3/3)`, is a block by that rule and would otherwise hand the card the one phrase the operator
 * reopens this work over. Withholding the text costs a real reason nothing: the entry still draws
 * blocked, with no reason under it, which is what an event-found block already draws.
 */
function reason(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return plain(value).includes(plain(MAX_ROUNDS_REACHED)) ? null : value;
}

/**
 * The entry that draws as running, as an index into the drawn entries, or -1 when none does.
 *
 * The document decides it, not the store: the entry whose plan document says `In Progress` and moved
 * last is the one a worker is on, and a plan document moves when its Chapter or its status is
 * written. Two entries joined to one document are one document, whatever the two stats behind them
 * read, so they tie and the earlier entry in queue order takes the word. Within one tick the reader
 * stats each entry rather than each file, so a document saved between two of those stats would
 * otherwise hand one file two modification times and let the later entry outrank the earlier one for
 * the same work.
 *
 * A document is identified by the path it was read from, which the join builds under the persona's
 * own working folder, so two entries naming one file carry one path. Its instant is the newest any
 * entry read it at, which is the freshest observation of the same file.
 *
 * With no such document anywhere in the queue, the plugin's own `activeGoalId` is the only thing
 * left that says which entry is being worked, and it draws only when the entry it names is still
 * unmatched: a root it names is not drawn at all, and a done or blocked entry it names has already
 * been decided by a rule that outranks this one.
 */
function inFlight(
  drawn: readonly QueueEntry[],
  words: readonly (StatusWord | null)[],
  readings: ReadonlyMap<string, QueuePlanReading>,
  activeGoalId: string | null,
): number {
  const open: { at: number; index: number; path: string }[] = [];
  const newest = new Map<string, number>();
  for (const [index, entry] of drawn.entries()) {
    if (words[index] !== null) continue;
    const reading = readings.get(entry.id);
    if (!started(reading)) continue;
    const at = touchedAt(reading.mtimeMs);
    open.push({ at, index, path: reading.path });
    const held = newest.get(reading.path);
    if (held === undefined || at > held) newest.set(reading.path, at);
  }

  if (open.length === 0) {
    if (activeGoalId === null) return -1;
    return drawn.findIndex((entry, index) => words[index] === null && entry.id === activeGoalId);
  }

  // Strictly newer wins, so a document that ties, one entry against another on the same file
  // included, leaves the earlier entry in queue order holding the word.
  let chosen = -1;
  let held = Number.NEGATIVE_INFINITY;
  for (const candidate of open) {
    const at = newest.get(candidate.path) ?? candidate.at;
    if (chosen < 0 || at > held) {
      chosen = candidate.index;
      held = at;
    }
  }
  return chosen;
}

/**
 * What the worker itself is doing, for the group's label.
 *
 * The heartbeat is read first and wins outright: a worker inside a turn is running whatever its
 * queue looks like, and that file is the only thing here that knows it. Otherwise the worker is
 * idle, and how long it has been idle is the whole of what the label can say, measured from the last
 * turn the store recorded finishing. A stamp that names no instant leaves the bare word, which says
 * the worker is idle without inventing an age for it.
 *
 * `nothing started` replaces the two idle forms alone, and only where no entry is in flight. It is
 * the state where a worker is idle and the card can point at nothing it is between turns on, which
 * is what an idle span by itself reads as either way.
 */
function workerState(queue: PersonaQueue, running: boolean, now: number): string {
  if (queue.turnStartedAt !== null && Number.isFinite(queue.turnStartedAt)) return RUNNING_NOW;
  if (!running) return NOTHING_STARTED;
  const completed = queue.lastTurnComplete;
  if (completed === null || !Number.isFinite(completed)) return IDLE;
  return `${IDLE} ${span(Math.max(now - completed, 0))}`;
}

/**
 * One persona's queue, judged: a word for every entry the card draws, the counts under its label,
 * and what the worker is doing.
 *
 * The rules run in a fixed order and the first to match an entry wins it. A root entry and an
 * abandoned one are removed before any other rule sees them, so they take no word and count toward
 * nothing: a root is the goal tree's trunk rather than a plan, and an abandoned entry is one the
 * operator has already decided against. Everything left is counted in `total`, whether it draws a
 * full entry on the card or folds into the closing line.
 *
 * The done, blocked and stalled rules read one entry each. The three that follow read the queue as a
 * whole, because exactly one entry can be in flight and exactly one can be up next, and which one
 * depends on what the rules above have already taken.
 */
export function personaStatus(
  queue: PersonaQueue,
  events: EventReaderState,
  now: number,
): PersonaStatus {
  // The reader hands its entries over in queue order already. They are ordered again here, under the
  // reader's own key rule rather than a second copy of it, because this function is exported and two
  // of the rules below are about position: the in-flight tie goes to the earlier entry, and the
  // up-next word goes to the first unmatched one.
  //
  // The order is total for every key the reader can produce, its field parser dropping a key that is
  // not a finite number. An entry built by hand with a non-finite key makes the comparator answer
  // NaN, and where such an entry lands is unspecified.
  const drawn = [...queue.entries]
    .sort((left, right) => queueKey(left) - queueKey(right))
    .filter((entry) => plain(entry.kind) !== ROOT_KIND && plain(entry.status) !== ABANDONED);

  const index = eventIndex(events.latest);
  const root = heldRoot(events.latest, queue.workdir);
  const words: (StatusWord | null)[] = drawn.map(() => null);
  const reasons: (string | null)[] = drawn.map(() => null);

  for (const [at, entry] of drawn.entries()) {
    const reading = queue.readings.get(entry.id);
    // Done is every way a plan can be finished: the store says so, the document's own status is
    // terminal, or the join found the document in an archive folder and never opened it.
    if (
      plain(entry.status) === COMPLETE ||
      (reading !== undefined && (reading.archived || reading.terminal))
    ) {
      words[at] = "done";
      continue;
    }
    const block = blockOf(entry, reading, root, index, now);
    if (block !== null) {
      words[at] = "blocked";
      reasons[at] = block.reason;
      continue;
    }
    // The nudge cap is the plugin's own stop, and it is the one `paused` that means the worker will
    // not pick this entry up again on its own.
    if (plain(entry.status) === PAUSED && entry.pausedByNudgeCap === true) words[at] = "stalled";
  }

  const running = inFlight(drawn, words, queue.readings, queue.activeGoalId);
  if (running >= 0) words[running] = "in flight";
  for (const [at, entry] of drawn.entries()) {
    if (words[at] === null && started(queue.readings.get(entry.id))) words[at] = "started, parked";
  }
  const next = words.indexOf(null);
  if (next >= 0) words[next] = "up next";

  const entries = drawn.map((entry, at) => ({
    id: entry.id,
    word: words[at] ?? "queued",
    reason: reasons[at] ?? null,
  }));
  return {
    entries,
    done: entries.filter((entry) => entry.word === "done").length,
    total: entries.length,
    worker: workerState(queue, running >= 0, now),
  };
}
