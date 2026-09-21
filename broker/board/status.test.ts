import { test } from "node:test";
import assert from "node:assert/strict";
import { eventKey, initialEventState } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import type { PersonaQueue, QueueEntry, QueuePlanReading } from "./queues.ts";
import { personaStatus } from "./status.ts";
import type { EntryStatus, PersonaStatus } from "./status.ts";

// The words this module answers with are the card's own, and the strings it must never answer with
// are the persona plugin's: a worker in normal service records `blocked` with the reason `Max rounds
// reached` and writes `paused` for "not now". So the cases below pin the word each rule gives, and
// the sweep at the foot of the file pins that nothing the plugin wrote about an entry's state rides
// out of any of them.

const NOW = 1_786_300_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The roster's spelling of one persona's working folder, as the live roster writes it. */
const WORKDIR = "D:/personas/dev";

/** The same folder as a configured project root spells it, which is the spelling the event reader
 * keeps when that root was handed to it first.
 *
 * Used by the root-spelling test alone, which is guarded to Windows. `comparablePath` folds
 * separators only there, so an event built under this spelling matches the roster's `WORKDIR` on
 * Windows and nowhere else. Every other case here builds its event under `WORKDIR`, which is what
 * keeps the rules those cases pin readable on any platform. */
const EVENT_ROOT = "D:\\personas\\dev";

const PLAN_STEM = "dev_a-plan_v1";

/** Every result this suite produces, swept at the foot of the file for the plugin's own words. */
const produced: PersonaStatus[] = [];

function goal(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return { id: "goal-1", kind: "plan", title: "A queued plan", createdAt: 1_000, ...overrides };
}

/** The arm of the join's union that carries a parse: a document found under a live plans folder. */
type ParsedReading = Extract<QueuePlanReading, { archived: false }>;

/** A plan reading as the join returns one it parsed. */
function reading(overrides: Partial<ParsedReading> = {}): ParsedReading {
  const stem = overrides.stem ?? PLAN_STEM;
  return {
    archived: false,
    status: "In Progress",
    terminal: false,
    sections: 3,
    completed: 1,
    next: "2. The renderer",
    root: WORKDIR,
    path: `${WORKDIR}/docs/plans/${stem}.md`,
    stem,
    mtimeMs: NOW - 2 * HOUR,
    sizeBytes: 2_048,
    ...overrides,
  };
}

/** A plan the join found only in an archive folder, which carries no parse at all. */
function archived(stem = PLAN_STEM): QueuePlanReading {
  return { archived: true, root: WORKDIR, path: `${WORKDIR}/docs/archive/${stem}.md`, stem };
}

function events(...held: readonly BoardEvent[]): EventReaderState {
  const state = initialEventState();
  for (const event of held) state.latest.set(eventKey(event.root, event.plan), event);
  return state;
}

function event(overrides: Partial<BoardEvent> = {}): BoardEvent {
  return {
    root: WORKDIR,
    plan: `docs/plans/${PLAN_STEM}.md`,
    event: "goal-blocked",
    ts: new Date(NOW - 3 * HOUR).toISOString(),
    session: null,
    detail: null,
    ...overrides,
  };
}

/**
 * One persona's judged queue. Everything the rules read has a default here, so each case below names
 * only the fields its own rule turns on.
 *
 * The readings are given by entry id, the way the reader files them, and `now` is fixed so a span is
 * a stable string rather than a clock read.
 */
function judge(input: {
  entries?: readonly QueueEntry[];
  readings?: readonly (readonly [string, QueuePlanReading])[];
  activeGoalId?: string | null;
  turnStartedAt?: number | null;
  lastTurnComplete?: number | null;
  workdir?: string;
  events?: EventReaderState;
  now?: number;
}): PersonaStatus {
  const queue: PersonaQueue = {
    name: "dev",
    workdir: input.workdir ?? WORKDIR,
    entries: input.entries ?? [goal()],
    activeGoalId: input.activeGoalId ?? null,
    lastTurnComplete: input.lastTurnComplete ?? null,
    turnStartedAt: input.turnStartedAt ?? null,
    readings: new Map(input.readings ?? []),
    heldSince: null,
  };
  const result = personaStatus(queue, input.events ?? initialEventState(), input.now ?? NOW);
  produced.push(result);
  return result;
}

/** The word each entry drew, by entry id, which is how every case below reads a result. */
function words(result: PersonaStatus): Record<string, string> {
  const drawn: Record<string, string> = {};
  for (const entry of result.entries) drawn[entry.id] = entry.word;
  return drawn;
}

function found(result: PersonaStatus, id: string): EntryStatus {
  const entry = result.entries.find((held) => held.id === id);
  assert.ok(entry !== undefined, `no entry drew for ${id}`);
  return entry;
}

test("rule 1 removes a root entry and an abandoned one before any other rule sees them", () => {
  const only = judge({
    entries: [goal({ id: "trunk", kind: "root", status: "complete" })],
  });
  assert.deepEqual(only.entries, [], "a root entry draws no word of its own");
  assert.equal(only.total, 0, "and is counted toward nothing");
  assert.equal(only.done, 0, "including the done count its store status would otherwise feed");

  const dropped = judge({
    entries: [goal({ id: "given-up", status: "abandoned" }), goal({ id: "live", createdAt: 2 })],
    readings: [["given-up", archived("dev_abandoned_v1")]],
  });
  assert.deepEqual(Object.keys(words(dropped)), ["live"], "an abandoned entry draws nothing");
  assert.equal(dropped.done, 0, "an abandoned entry whose plan is archived is not counted as done");
  assert.equal(dropped.total, 1, "nor counted at all");
});

test("rule 2 draws done for a completed store entry, a terminal plan, and an archived one", () => {
  const result = judge({
    entries: [
      goal({ id: "by-store", status: "complete", createdAt: 1 }),
      goal({ id: "by-plan", createdAt: 2 }),
      goal({ id: "by-archive", createdAt: 3 }),
      goal({ id: "open", createdAt: 4 }),
    ],
    readings: [
      ["by-plan", reading({ status: "Complete", terminal: true, stem: "dev_b_v1" })],
      ["by-archive", archived("dev_c_v1")],
      ["open", reading({ status: "Ready", stem: "dev_d_v1" })],
    ],
  });
  assert.deepEqual(words(result), {
    "by-store": "done",
    "by-plan": "done",
    "by-archive": "done",
    open: "up next",
  });
  assert.equal(result.done, 3, "the done count is the number of done entries");
  assert.equal(result.total, 4, "and the total is every entry rule 1 kept");
});

test("rule 3 draws blocked for an outstanding event, a blocked lead, and a store block", () => {
  const result = judge({
    entries: [
      // Carrying a store reason from an older block, which is not this entry's reason: nothing but
      // the block that is actually standing draws one.
      goal({ id: "by-event", createdAt: 1, blockedReason: "An older stop" }),
      goal({ id: "by-lead", createdAt: 2, lead: { state: "blocked", reason: "The lead's word" } }),
      goal({ id: "by-store", createdAt: 3, status: "blocked", blockedReason: "Two open forks" }),
    ],
    readings: [
      // Older than the event: a document that moved after a block is a block already cleared.
      ["by-event", reading({ status: "Ready", mtimeMs: NOW - 5 * HOUR })],
      ["by-lead", reading({ status: "Ready", stem: "dev_b_v1" })],
      ["by-store", reading({ status: "Ready", stem: "dev_c_v1" })],
    ],
    events: events(event()),
  });
  assert.deepEqual(words(result), {
    "by-event": "blocked",
    "by-lead": "blocked",
    "by-store": "blocked",
  });
  assert.equal(found(result, "by-event").reason, null, "a block by event alone draws no reason");
  assert.equal(found(result, "by-lead").reason, "The lead's word", "a blocked lead's reason draws");
  assert.equal(found(result, "by-store").reason, "Two open forks", "so does a store block's");
});

test("an entry blocked by an event while its store reads the round limit draws no reason", () => {
  // The two rules meet here. The round limit is not a block, so it cannot be the reason for the
  // block the event found, and drawing it would put the plugin's bookkeeping on the card under the
  // one word that makes it look like the cause.
  const result = judge({
    entries: [
      goal({ id: "held", status: "blocked", blockedReason: "Max rounds reached" }),
    ],
    readings: [["held", reading({ mtimeMs: NOW - 5 * HOUR })]],
    events: events(event()),
  });
  assert.equal(found(result, "held").word, "blocked", "the event is the block");
  assert.equal(found(result, "held").reason, null, "and it has nothing to say about it");
});

test("a reason draws only on a blocked entry, and a lead's wins over the store's", () => {
  const result = judge({
    entries: [
      goal({
        id: "both",
        createdAt: 1,
        status: "blocked",
        blockedReason: "The store's word",
        lead: { state: "blocked", reason: "The lead's word" },
      }),
      goal({
        id: "quiet-lead",
        createdAt: 2,
        status: "blocked",
        blockedReason: "The store's word",
        lead: { state: "blocked", reason: "   " },
      }),
      goal({ id: "running", createdAt: 3, blockedReason: "written while it was blocked" }),
    ],
    readings: [["running", reading()]],
  });
  assert.equal(found(result, "both").reason, "The lead's word");
  assert.equal(found(result, "quiet-lead").reason, null, "a lead with nothing to say draws none");
  assert.equal(found(result, "running").word, "in flight");
  assert.equal(found(result, "running").reason, null, "an unblocked entry draws no reason at all");
});

test("rule 4 draws stalled for a paused entry the nudge cap stopped", () => {
  const result = judge({
    entries: [
      goal({ id: "capped", createdAt: 1, status: "paused", pausedByNudgeCap: true }),
      goal({ id: "merely-rested", createdAt: 2, status: "paused", pausedByNudgeCap: false }),
    ],
  });
  assert.deepEqual(words(result), { capped: "stalled", "merely-rested": "up next" });
});

test("rule 5 draws in flight for the newest started document, and rule 6 parks the rest", () => {
  const result = judge({
    entries: [
      goal({ id: "older", createdAt: 1 }),
      goal({ id: "newer", createdAt: 2 }),
      goal({ id: "unstarted", createdAt: 3 }),
    ],
    readings: [
      ["older", reading({ mtimeMs: NOW - 5 * HOUR, stem: "dev_older_v1" })],
      ["newer", reading({ mtimeMs: NOW - 1 * HOUR, stem: "dev_newer_v1" })],
      ["unstarted", reading({ status: "Ready", stem: "dev_ready_v1" })],
    ],
  });
  assert.deepEqual(words(result), {
    older: "started, parked",
    newer: "in flight",
    unstarted: "up next",
  });
});

test("two entries joined to one document tie, and the earlier in queue order is in flight", () => {
  const one = reading({ mtimeMs: NOW - 5 * HOUR });
  // The reader stats each entry rather than each file, so a document saved between two of those
  // stats hands one file two modification times. The later stat must not move the word.
  const same = reading({ mtimeMs: NOW - 1 * MINUTE });
  assert.equal(one.path, same.path, "the fixture is one document read twice");

  const result = judge({
    entries: [goal({ id: "first", createdAt: 1 }), goal({ id: "second", createdAt: 2 })],
    readings: [
      ["first", one],
      ["second", same],
    ],
  });
  assert.deepEqual(words(result), { first: "in flight", second: "started, parked" });

  // A genuinely different document at that same newer instant does take the word, which is what
  // says the tie above came from the shared path and not from the comparison being inert.
  const rival = judge({
    entries: [goal({ id: "first", createdAt: 1 }), goal({ id: "second", createdAt: 2 })],
    readings: [
      ["first", one],
      ["second", reading({ mtimeMs: NOW - 1 * MINUTE, stem: "dev_rival_v1" })],
    ],
  });
  assert.deepEqual(words(rival), { first: "started, parked", second: "in flight" });
});

test("with no started document the entry activeGoalId names is in flight", () => {
  const result = judge({
    entries: [
      goal({ id: "first", createdAt: 1 }),
      goal({ id: "named", createdAt: 2 }),
      goal({ id: "third", createdAt: 3 }),
    ],
    readings: [["first", reading({ status: "Ready" })]],
    activeGoalId: "named",
  });
  assert.deepEqual(words(result), { first: "up next", named: "in flight", third: "queued" });
  assert.equal(result.worker, "idle", "an entry is in flight, so the idle form stands");
});

test("activeGoalId loses to a started document, and never revives a root or a done entry", () => {
  const beaten = judge({
    entries: [goal({ id: "started", createdAt: 1 }), goal({ id: "named", createdAt: 2 })],
    readings: [["started", reading()]],
    activeGoalId: "named",
  });
  assert.deepEqual(words(beaten), { started: "in flight", named: "up next" });

  const root = judge({
    entries: [goal({ id: "trunk", kind: "root" }), goal({ id: "waiting", createdAt: 2 })],
    activeGoalId: "trunk",
  });
  assert.deepEqual(words(root), { waiting: "up next" }, "a root it names is not drawn at all");
  assert.equal(root.worker, "nothing started", "so nothing is in flight");

  const finished = judge({
    entries: [goal({ id: "shipped", status: "complete" }), goal({ id: "waiting", createdAt: 2 })],
    activeGoalId: "shipped",
  });
  assert.deepEqual(words(finished), { shipped: "done", waiting: "up next" });
  assert.equal(finished.worker, "nothing started", "a done entry it names is still done");

  const inside = judge({
    entries: [goal({ id: "shipped", status: "complete" }), goal({ id: "waiting", createdAt: 2 })],
    activeGoalId: "shipped",
    turnStartedAt: NOW - MINUTE,
  });
  assert.equal(inside.worker, "running now", "the heartbeat is read first whatever the queue says");
});

test("rule 7 draws up next for the first unmatched entry, wherever the in-flight entry sorts", () => {
  const result = judge({
    entries: [
      goal({ id: "waiting", createdAt: 1 }),
      goal({ id: "running", createdAt: 2 }),
      goal({ id: "later", createdAt: 3 }),
      goal({ id: "last", createdAt: 4 }),
    ],
    readings: [["running", reading()]],
  });
  assert.deepEqual(words(result), {
    waiting: "up next",
    running: "in flight",
    later: "queued",
    last: "queued",
  });
});

test("queue order is ascending by key, sortKey standing in for createdAt", () => {
  // Handed to the function out of key order, so the order it answers in is its own doing.
  const result = judge({
    entries: [
      goal({ id: "keyless", createdAt: undefined, sortKey: undefined }),
      goal({ id: "keyed", createdAt: 100, sortKey: 3_000 }),
      goal({ id: "early", createdAt: 5 }),
      goal({ id: "middle", createdAt: 900 }),
    ],
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["early", "middle", "keyed", "keyless"],
    "a sortKey stands in for createdAt, and an entry with neither sorts last",
  );
  assert.equal(found(result, "early").word, "up next", "so up next is the first by key");
});

test("keys compare as numbers rather than as text", () => {
  const result = judge({
    entries: [goal({ id: "nine", createdAt: 9 }), goal({ id: "eighty", createdAt: 80 })],
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["nine", "eighty"],
    "80 sorts after 9, which it would not as text",
  );
});

test("a plan reads as started only when its status is those two words as the whole value", () => {
  const result = judge({
    entries: [
      goal({ id: "spaced", createdAt: 1 }),
      goal({ id: "qualified", createdAt: 2 }),
      goal({ id: "other", createdAt: 3 }),
    ],
    readings: [
      ["spaced", reading({ status: "  in PROGRESS " })],
      ["qualified", reading({ status: "In Progress (auto)", stem: "dev_b_v1" })],
      ["other", reading({ status: "Ready", stem: "dev_c_v1" })],
    ],
  });
  assert.deepEqual(words(result), {
    spaced: "in flight",
    qualified: "up next",
    other: "queued",
  });
});

test("a store block reading Max rounds reached is not a block, and an In Progress plan runs", () => {
  const result = judge({
    entries: [
      goal({ id: "rolling", createdAt: 1, status: "blocked", blockedReason: "Max rounds reached" }),
      goal({ id: "next-up", createdAt: 2 }),
    ],
    readings: [["rolling", reading()]],
  });
  assert.equal(found(result, "rolling").word, "in flight", "the round limit is ordinary running");
  assert.equal(found(result, "rolling").reason, null, "and the plugin's bookkeeping draws no reason");
  assert.equal(found(result, "next-up").word, "up next");

  // Trailing whitespace is the same bookkeeping, and a genuinely different reason is a genuine
  // block: the refusal is the reason's own value rather than the status word beside it.
  const padded = judge({
    entries: [goal({ id: "rolling", status: "blocked", blockedReason: "Max rounds reached  " })],
    readings: [["rolling", reading()]],
  });
  assert.equal(found(padded, "rolling").word, "in flight");

  const genuine = judge({
    entries: [goal({ id: "held", status: "blocked", blockedReason: "Waiting on the operator" })],
    readings: [["held", reading()]],
  });
  assert.equal(found(genuine, "held").word, "blocked", "another reason blocks as it always did");
});

test("a paused entry the nudge cap did not stop is up next or queued, and its reason is not returned", () => {
  const result = judge({
    entries: [
      goal({
        id: "resting",
        createdAt: 1,
        status: "paused",
        pausedByNudgeCap: false,
        blockedReason: "Waiting on the operator to answer the fork",
      }),
      goal({ id: "behind", createdAt: 2, status: "paused" }),
    ],
  });
  assert.deepEqual(words(result), { resting: "up next", behind: "queued" });
  assert.equal(found(result, "resting").reason, null, "a pause reason is the worker's, not the card's");
  assert.equal(found(result, "behind").reason, null);
});

test("an event under the root spelling the reader kept marks an entry of the same folder", {
  // `comparablePath` folds separators and case on Windows alone, and this is where the roster's
  // forward slashes and a configured root's backslashes have to meet.
  skip: process.platform !== "win32",
}, () => {
  const result = judge({
    entries: [goal({ id: "blocked-entry" })],
    readings: [["blocked-entry", reading({ status: "Ready", mtimeMs: NOW - 5 * HOUR })]],
    events: events(event({ root: EVENT_ROOT })),
    workdir: WORKDIR,
  });
  assert.equal(found(result, "blocked-entry").word, "blocked", "one folder, two spellings");

  // A genuinely different folder still matches nothing, which is what says the match above is a
  // comparison rather than the first root the state happens to hold.
  const elsewhere = judge({
    entries: [goal({ id: "blocked-entry" })],
    readings: [["blocked-entry", reading({ status: "Ready", mtimeMs: NOW - 5 * HOUR })]],
    events: events(event({ root: "D:\\personas\\other" })),
    workdir: WORKDIR,
  });
  assert.equal(found(elsewhere, "blocked-entry").word, "up next", "another persona's root is not this one");
});

test("an entry with no parsed plan reading takes no event", () => {
  const none = judge({
    entries: [goal({ id: "unjoined" })],
    events: events(event()),
  });
  assert.equal(found(none, "unjoined").word, "up next", "no reading, no event");

  const stored = judge({
    entries: [goal({ id: "filed" })],
    readings: [["filed", archived()]],
    events: events(event()),
  });
  // Rule 2 takes this entry before any block is looked for, so what it pins is that precedence
  // rather than the event refusal: done outranks blocked, whatever the event state holds.
  assert.equal(found(stored, "filed").word, "done", "an archived reading is done before it is judged");
});

test("an event cleared by a document that moved past it leaves the entry unblocked", () => {
  const standing = judge({
    entries: [goal({ id: "held" })],
    readings: [["held", reading({ status: "Ready", mtimeMs: NOW - 5 * HOUR })]],
    events: events(event()),
  });
  assert.equal(found(standing, "held").word, "blocked");

  const resumed = judge({
    entries: [goal({ id: "held" })],
    readings: [["held", reading({ status: "Ready", mtimeMs: NOW - 1 * MINUTE })]],
    events: events(event()),
  });
  assert.equal(found(resumed, "held").word, "up next", "a Chapter landing after the block clears it");
});

test("the worker's state is the heartbeat first, then the idle span, then nothing started", () => {
  const running = judge({
    entries: [goal({ id: "one" })],
    turnStartedAt: NOW - MINUTE,
    lastTurnComplete: NOW - 12 * MINUTE,
  });
  assert.equal(running.worker, "running now", "inside a turn wins over everything");

  const idle = judge({
    entries: [goal({ id: "one" })],
    readings: [["one", reading()]],
    lastTurnComplete: NOW - 12 * MINUTE,
  });
  assert.equal(idle.worker, "idle 12m", "measured from the last turn the store recorded");

  const undated = judge({
    entries: [goal({ id: "one" })],
    readings: [["one", reading()]],
  });
  assert.equal(undated.worker, "idle", "with no stamp there is no age to give");

  const quiet = judge({
    entries: [goal({ id: "one", status: "paused", pausedByNudgeCap: true })],
    lastTurnComplete: NOW - 12 * MINUTE,
  });
  assert.equal(quiet.worker, "nothing started", "nothing in flight replaces the idle form");
});

test("nothing throws on values another program wrote absurdly", () => {
  const result = judge({
    entries: [
      goal({ id: "nan-key", createdAt: Number.NaN, sortKey: Number.NaN }),
      goal({ id: "undated", createdAt: 1 }),
      goal({ id: "other", createdAt: 2 }),
    ],
    readings: [
      ["undated", reading({ mtimeMs: Number.NaN })],
      ["other", reading({ mtimeMs: NOW - 3 * HOUR, stem: "dev_other_v1" })],
    ],
    lastTurnComplete: Number.NaN,
    turnStartedAt: Number.NaN,
  });
  assert.equal(found(result, "other").word, "in flight", "a document with no instant never wins");
  assert.equal(found(result, "undated").word, "started, parked");
  assert.equal(result.entries.length, 3, "and an entry with no usable key still draws");
  assert.equal(result.worker, "idle", "a heartbeat stamp that is not an instant is not a turn");
  // Where the non-finite key sorts is deliberately not pinned, and is genuinely unspecified rather
  // than merely unasserted: the comparator answers NaN for it, so the position depends on the input
  // length and the engine's sort. The reader's own field parser is what keeps every key the product
  // can produce a finite number.
});

test("a round-limit reason is bookkeeping in any case or padding the plugin writes it in", () => {
  const result = judge({
    entries: [
      goal({ id: "lower", createdAt: 1, status: "blocked", blockedReason: "max rounds reached" }),
      goal({ id: "padded", createdAt: 2, status: "blocked", blockedReason: "  Max rounds reached " }),
    ],
    readings: [["lower", reading()], ["padded", reading({ stem: "dev_b_v1" })]],
  });
  assert.deepEqual(words(result), { lower: "in flight", padded: "started, parked" });
  assert.equal(found(result, "lower").reason, null, "and neither draws the plugin's own string");
  assert.equal(found(result, "padded").reason, null);
});

test("a block reason that carries the round limit and more is blocked, and draws nothing", () => {
  // The block rule matches the round limit whole, which is the spec's word, so a store writing a
  // count after it is a block by that rule. What must not happen is the string reaching the card:
  // the operator reopens this work if `Max rounds` appears on it at all.
  const result = judge({
    entries: [
      goal({ id: "counted", status: "blocked", blockedReason: "Max rounds reached (3/3)" }),
    ],
  });
  assert.equal(found(result, "counted").word, "blocked", "a whole-value match, so this is a block");
  assert.equal(found(result, "counted").reason, null, "but its text never reaches the card");
});

/**
 * Every string the answer carries, whatever field or nesting it sits in.
 *
 * Structural rather than a read of `word` and `reason` by name: the rule is that nothing the plugin
 * wrote about an entry's state leaves this module, and a check naming today's two fields would go
 * quiet the moment a third one is added.
 */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  // A `Map` and a `Set` are walked by their own entries. `Object.values` returns nothing for either,
  // so a future field of that shape would be swept as empty and the check would go quiet for the
  // wrong reason, which is the failure this walk exists to avoid.
  else if (value instanceof Map) for (const [key, item] of value) strings([key, item], into);
  else if (value instanceof Set) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

const PLUGIN_WORDS = /paused|pending|max rounds/i;

test("no word and no reason this suite produced carries the plugin's own bookkeeping", () => {
  // The store the acceptance names: all three of the plugin's words in one queue, each on an entry
  // whose rule the card has its own word for.
  const all = judge({
    entries: [
      goal({ id: "resting", createdAt: 1, status: "paused", blockedReason: "paused by the worker" }),
      goal({ id: "capped", createdAt: 2, status: "paused", pausedByNudgeCap: true }),
      goal({ id: "waiting", createdAt: 3, status: "pending" }),
      goal({ id: "rolling", createdAt: 4, status: "blocked", blockedReason: "Max rounds reached" }),
    ],
    readings: [["rolling", reading()]],
  });
  assert.deepEqual(words(all), {
    resting: "up next",
    capped: "stalled",
    waiting: "queued",
    rolling: "in flight",
  });

  // Two controls, because the walk and the predicate are separate things to witness.
  //
  // The first is the one case in this file whose drawn reason legitimately carries a banned word: a
  // real block whose own text names a pending review. An operator's free text is not the plugin's
  // bookkeeping, and passing it through is the behaviour the Approach asks for, so this case is the
  // acceptance bullet's one carve-out rather than a violation of it. It is judged before the sweep
  // runs and sits in the same `produced` collection, so the sweep would speak on it and is removed
  // by identity alone. What it proves is reach: the walk arrives at `reason`, the one field of a
  // judged result that can carry store text. What it does not prove is the predicate's coverage,
  // since `pending` is one of the three literals `PLUGIN_WORDS` was handed. The swept class is those
  // three words rather than the plugin's whole vocabulary, and nothing here claims otherwise.
  const control = judge({
    entries: [goal({ id: "held", status: "blocked", blockedReason: "Waiting on a pending review" })],
  });
  assert.equal(found(control, "held").word, "blocked");
  assert.ok(
    strings(control).some((value) => PLUGIN_WORDS.test(value)),
    "the sweep's predicate reaches the fields the answer carries",
  );

  // The second control witnesses the two arms no judged result can reach. `PersonaStatus` carries
  // no `Map` and no `Set` today, so those arms sit in the walk against a field a later change adds.
  // An arm nothing exercises is exactly the silence this walk exists to prevent, so each is driven
  // here directly rather than left to read correct on inspection.
  assert.deepEqual(strings(new Map([["key", "paused"]])), ["key", "paused"], "a Map is walked");
  assert.deepEqual(strings(new Set(["pending"])), ["pending"], "and so is a Set");

  const swept = produced.filter((result) => result !== control);
  assert.ok(swept.length > 20, `the sweep ran over ${String(swept.length)} results`);
  for (const result of swept) {
    for (const value of strings(result)) {
      assert.doesNotMatch(value, PLUGIN_WORDS, `a result carried ${value}`);
    }
  }
});
