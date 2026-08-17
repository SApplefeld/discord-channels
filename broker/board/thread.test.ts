import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_THREAD_NAME, createBoardCard } from "./thread.ts";
import type { BoardCardOptions } from "./thread.ts";
import { loadBoardBinding, saveBoardBinding } from "./binding.ts";
import { sweepPlans } from "./plans.ts";
import type { PlanFailure, PlanRead, PlanReading, PlanSweep } from "./plans.ts";
import { initialEventState } from "./events.ts";
import type { EventReaderState, ReadEventsResult } from "./events.ts";
import type { CallOutcome, DiscordTransport, RateLimitObservation } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";

const START = 1_000_000;
const MESSAGE_ID = "111111111111111111";
const THREAD_ID = "222222222222222222";
const ROOT = path.join(os.tmpdir(), "channels-board-project");

// A clock the tests advance by hand. A budget block is a wait, and a test that waited out a real one
// would be a slow flake.
function clock(start = START) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

function ok<T>(value: T, rate: RateLimitObservation = HEALTHY): CallOutcome<T> {
  return { status: "ok", value, rate };
}

function refused(retryAfterMs: number): CallOutcome<never> {
  return { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs } };
}

/** A refusal Discord will repeat: a permission the bot does not hold, or a shape it will not take. */
function permanent(): CallOutcome<never> {
  return { status: "failed", error: "HTTP 403", rate: NO_RATE_INFO, permanent: true };
}

/** The message this card aims at is gone, which is what an operator deleting it looks like. */
function missing(): CallOutcome<never> {
  return { status: "failed", error: "HTTP 404", rate: NO_RATE_INFO, missing: true };
}

type Recorder = {
  transport: DiscordTransport;
  posts: string[];
  opens: { messageId: string; name: string }[];
  edits: { messageId: string; card: string }[];
  /** Every thread this card asked Discord to close. The board thread is permanent, so it is empty. */
  archived: string[];
  /** Scripted results for the next call of each kind. Anything unscripted succeeds. */
  nextPost: CallOutcome<{ messageId: string }> | null;
  nextOpen: CallOutcome<{ threadId: string }> | null;
  nextEdit: CallOutcome<null> | null;
};

function recorder(): Recorder {
  const state: Recorder = {
    posts: [],
    opens: [],
    edits: [],
    archived: [],
    nextPost: null,
    nextOpen: null,
    nextEdit: null,
    transport: {
      postCard: async ({ card }) => {
        state.posts.push(card);
        const scripted = state.nextPost;
        state.nextPost = null;
        return scripted ?? ok({ messageId: MESSAGE_ID });
      },
      openThread: async ({ messageId, name }) => {
        state.opens.push({ messageId, name });
        const scripted = state.nextOpen;
        state.nextOpen = null;
        return scripted ?? ok({ threadId: THREAD_ID });
      },
      editCard: async ({ messageId, card }) => {
        state.edits.push({ messageId, card });
        const scripted = state.nextEdit;
        state.nextEdit = null;
        return scripted ?? ok(null);
      },
      renameThread: async () => ok(null),
      archiveThread: async ({ threadId }) => {
        state.archived.push(threadId);
        return ok(null);
      },
    },
  };
  return state;
}

function planFile(stem: string): string {
  return path.join(ROOT, "docs", "plans", `${stem}.md`);
}

/**
 * A filename stem as the card draws it.
 *
 * The card's body is live markdown, so every underscore in a plan's name carries the escape that
 * keeps the name from composing emphasis around the text beside it. Discord draws the character
 * rather than the backslash, so the operator reads the name as it was written.
 */
function drawn(stem: string): string {
  return stem.replaceAll("_", "\\_");
}

/** One plan as the sweep hands it over: in progress, one of three sections done. */
function reading(overrides: Partial<PlanReading> = {}): PlanReading {
  const stem = overrides.stem ?? "alpha_spec_v1";
  return {
    status: "In Progress",
    terminal: false,
    sections: 3,
    completed: 1,
    next: "the renderer",
    root: ROOT,
    path: planFile(stem),
    stem,
    mtimeMs: START,
    sizeBytes: 400,
    ...overrides,
  };
}

function swept(readings: PlanReading[], failures: PlanFailure[] = []): PlanSweep {
  return { readings, failures, truncated: [], listings: [] };
}

const NO_EVENTS = (previous: EventReaderState): ReadEventsResult => ({
  state: previous,
  unreadable: false,
});

function board(overrides: Partial<BoardCardOptions> = {}) {
  const calls = recorder();
  const time = clock();
  const logged: string[] = [];
  const built = createBoardCard({
    enabled: true,
    transport: calls.transport,
    roots: [ROOT],
    eventsPath: path.join(ROOT, "kit-events.jsonl"),
    binding: () => null,
    refreshMs: 60_000,
    now: time.now,
    log: (message) => logged.push(message),
    sweep: () => swept([reading()]),
    readEvents: NO_EVENTS,
    ...overrides,
  });
  assert.ok(built !== null, "the card was expected to be built under these options");
  return { calls, time, logged, card: built };
}

test("the first tick posts the card and opens its thread on it, under a fixed name", async () => {
  const bindings: unknown[] = [];
  const { calls, card } = board({ onBind: (binding) => bindings.push(binding) });

  await card.tick();

  assert.equal(calls.posts.length, 1);
  assert.match(calls.posts[0] ?? "", /Fleet: Board/);
  assert.ok((calls.posts[0] ?? "").includes(drawn("alpha_spec_v1")));
  assert.deepEqual(calls.opens, [{ messageId: MESSAGE_ID, name: BOARD_THREAD_NAME }]);
  assert.equal(calls.edits.length, 0, "the card it just posted needs no edit");
  // The message first, then the thread on it: a crash between the two must not lose the card.
  assert.deepEqual(bindings, [
    { messageId: MESSAGE_ID, threadId: null },
    { messageId: MESSAGE_ID, threadId: THREAD_ID },
  ]);
  assert.deepEqual(calls.archived, [], "the board thread is permanent");
});

test("a restart rebinds to the persisted thread instead of opening a second one", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "board-card.json");

  const first = board({ onBind: (binding) => saveBoardBinding(file, binding) });
  await first.card.tick();

  const restarted = board({
    binding: () => loadBoardBinding(file, { log: () => {} }),
    sweep: () => swept([reading({ completed: 2 })]),
  });
  await restarted.card.tick();

  assert.equal(restarted.calls.posts.length, 0, "the card must not be posted a second time");
  assert.equal(restarted.calls.opens.length, 0, "the thread must not be opened a second time");
  assert.equal(restarted.calls.edits.length, 1);
  assert.equal(restarted.calls.edits[0]?.messageId, MESSAGE_ID);
});

test("an unchanged fleet spends no edit", async () => {
  const { calls, card } = board({ binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }) });

  await card.tick();
  await card.tick();

  assert.equal(calls.posts.length, 0);
  assert.equal(
    calls.edits.length,
    1,
    "the first tick re-establishes the card and the second must cost nothing",
  );
});

test("a plan that moved spends one edit", async () => {
  let completed = 1;
  const { calls, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => swept([reading({ completed })]),
  });

  await card.tick();
  completed = 3;
  await card.tick();

  assert.equal(calls.edits.length, 2);
  assert.match(calls.edits[1]?.card ?? "", /3\/3/);
});

test("a plan that could not be read redraws its last parse under a climbing marker", async () => {
  // A plan doc mid-write by a live session is unparseable for a tick. Blanking its row would read as
  // the plan having closed, so the last good parse is drawn again and marked as held.
  let failing = false;
  const { calls, time, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () =>
      failing
        ? swept(
            [],
            [{ root: ROOT, path: planFile("alpha_spec_v1"), stem: "alpha_spec_v1", reason: "malformed" }],
          )
        : swept([reading()]),
  });

  await card.tick();
  assert.ok((calls.edits[0]?.card ?? "").includes(drawn("alpha_spec_v1")));

  failing = true;
  time.advance(60_000);
  await card.tick();
  const held = calls.edits[1]?.card ?? "";
  assert.ok(held.includes(drawn("alpha_spec_v1")), "the last parse taken is still on the card");
  assert.match(held, /^ {2}- held 1m · /m, "marked as held rather than as a freshly read plan");
  assert.doesNotMatch(held, /does not parse/, "and not drawn as a plan the card has nothing for");

  time.advance(60_000);
  await card.tick();
  assert.match(calls.edits[2]?.card ?? "", /^ {2}- held 2m · /m, "the marker's age climbs each pass");

  failing = false;
  time.advance(60_000);
  await card.tick();
  assert.doesNotMatch(calls.edits[3]?.card ?? "", /held \d/, "and it goes with the failure");
});

test("a plan this broker has never parsed draws as unread rather than as a held row", async () => {
  const { calls, card } = board({
    sweep: () =>
      swept(
        [],
        [{ root: ROOT, path: planFile("beta_spec_v1"), stem: "beta_spec_v1", reason: "unreadable" }],
      ),
  });

  await card.tick();

  assert.ok((calls.posts[0] ?? "").includes(`- ${drawn("beta_spec_v1")} (cannot be read)`));
});

test("a project holds its configured place with no parsed plan in it at all", async () => {
  // A project whose one plan has never parsed has nothing but a failure line to draw, and a card that
  // ordered its blocks by whatever it managed to parse would sink that project below every other one
  // and then jump it back up the tick its plan first parses.
  const OTHER = path.join(os.tmpdir(), "channels-board-second-project");
  let parses = false;
  const { calls, card } = board({
    roots: [ROOT, OTHER],
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () =>
      parses
        ? swept([reading({ stem: "alpha_spec_v1" }), reading({ stem: "beta_spec_v1", root: OTHER })])
        : swept(
            [reading({ stem: "beta_spec_v1", root: OTHER })],
            [{ root: ROOT, path: planFile("alpha_spec_v1"), stem: "alpha_spec_v1", reason: "malformed" }],
          ),
  });

  const projects = (body: string): string[] =>
    body
      .split("\n")
      .filter((line) => line.startsWith("### "))
      .map((line) => line.slice(4).replaceAll("\\", ""));

  await card.tick();
  assert.deepEqual(projects(calls.edits[0]?.card ?? ""), [
    path.basename(ROOT),
    path.basename(OTHER),
  ], "the project with only a failure to draw is still the first one configured");

  parses = true;
  await card.tick();
  assert.deepEqual(projects(calls.edits[1]?.card ?? ""), [
    path.basename(ROOT),
    path.basename(OTHER),
  ], "and it does not move the tick its plan starts parsing");
});

test("a held parse is handed back only while the file has not moved", async (t) => {
  // The staleness rule is this caller's to enforce: the sweep takes whatever parse it is handed for a
  // path, so a hold returned for a file that has been rewritten would draw the old plan forever.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plans = path.join(dir, "docs", "plans");
  mkdirSync(plans, { recursive: true });
  const file = path.join(plans, "gamma_spec_v1.md");
  const doc = (sections: string): string =>
    `Status: In Progress\n\n## Sections of Work\n${sections}\n\n## Chapters\n### Chapter 1\nNext: onward\n`;
  writeFileSync(file, doc("### 1. One\n### 2. Two"), "utf8");

  const read: string[] = [];
  const { calls, card } = board({
    roots: [dir],
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: (options) =>
      sweepPlans([dir], {
        ...options,
        readPlan: (opened) => {
          read.push(opened);
          return { text: doc("### 1. One\n### 2. Two\n### 3. Three") };
        },
      }),
  });

  await card.tick();
  assert.deepEqual(read, [file], "the first pass has no hold and reads the file");

  await card.tick();
  assert.deepEqual(read, [file], "a file whose stat has not moved is not read again");
  assert.equal(calls.edits.length, 1, "and the card it composes is the same one, so no edit is spent");

  // The file rewritten under the same size, which is the case a size check alone misses.
  writeFileSync(file, doc("### 1. One\n### 2. Two\n### 3. Ten"), "utf8");
  const later = new Date(Date.now() + 10_000);
  utimesSync(file, later, later);
  await card.tick();
  assert.deepEqual(read, [file, file], "a file that moved is read again rather than drawn from a hold");
});

test("a plan that failed is not opened again until it moves, whatever it failed on", async (t) => {
  // A failing file has no parse to match a later tick's stat, so without a hold on the failure the
  // sweep opens and reads it in full on every tick for as long as it sits there. At the per-root cap
  // that is a synchronous stall on the broker's only event loop, once a refresh, forever.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-failed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plans = path.join(dir, "docs", "plans");
  mkdirSync(plans, { recursive: true });
  const doc = "Status: In Progress\n\n## Sections of Work\n### 1. One\n\n## Chapters\n### Chapter 1\nNext: onward\n";
  const files = ["torn_spec_v1", "huge_spec_v1", "shut_spec_v1", "good_spec_v1"];
  for (const stem of files) writeFileSync(path.join(plans, `${stem}.md`), doc, "utf8");

  // Each file fails a different way, and the fourth parses until it is made to fail.
  let goodParses = true;
  const reads: string[] = [];
  const readPlan = (opened: string): PlanRead => {
    reads.push(path.basename(opened));
    if (opened.endsWith("huge_spec_v1.md")) return { failed: "oversized" };
    if (opened.endsWith("shut_spec_v1.md")) return { failed: "unreadable" };
    if (opened.endsWith("torn_spec_v1.md")) return { text: "a file with no Status header at all\n" };
    return goodParses ? { text: doc } : { text: "mid-write, no header yet\n" };
  };

  const { calls, card } = board({
    roots: [dir],
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: (options) => sweepPlans([dir], { ...options, readPlan }),
  });

  await card.tick();
  assert.deepEqual(
    reads.sort(),
    files.map((stem) => `${stem}.md`).sort(),
    "the first tick has nothing held and opens every file once",
  );
  const body = calls.edits[0]?.card ?? "";
  assert.ok(body.includes(`- ${drawn("torn_spec_v1")} (does not parse)`), body);
  assert.ok(body.includes(`- ${drawn("huge_spec_v1")} (too large to read)`), body);
  assert.ok(body.includes(`- ${drawn("shut_spec_v1")} (cannot be read)`), body);

  reads.length = 0;
  await card.tick();
  assert.deepEqual(reads, [], "an unmoved fleet opens nothing, the three failing files included");
  assert.equal(calls.edits.length, 1, "and it draws the same card, so no edit is spent");

  // A failing file that moves is read again: the hold is on that file's stat, not on the file.
  const later = new Date(Date.now() + 10_000);
  writeFileSync(path.join(plans, "huge_spec_v1.md"), `${doc}\n`, "utf8");
  utimesSync(path.join(plans, "huge_spec_v1.md"), later, later);
  await card.tick();
  assert.deepEqual(reads, ["huge_spec_v1.md"], "the file that moved is the only one opened");

  // The parsed-then-went-bad transition: the file is read once on the move, then held on both
  // counts, its last good parse drawn under the held marker and its failure keeping it shut.
  reads.length = 0;
  goodParses = false;
  writeFileSync(path.join(plans, "good_spec_v1.md"), `${doc}\n\n`, "utf8");
  utimesSync(path.join(plans, "good_spec_v1.md"), later, later);
  await card.tick();
  assert.deepEqual(reads, ["good_spec_v1.md"]);
  assert.ok(
    (calls.edits[calls.edits.length - 1]?.card ?? "").includes(drawn("good_spec_v1")),
    "the last good parse is drawn while the file that went bad is held shut",
  );

  reads.length = 0;
  await card.tick();
  assert.deepEqual(reads, [], "a plan that went bad and has not moved since is not read again");
});

test("one card's held listing is its own, and a second card does not take it away", async (t) => {
  // The listing hold is the caller's: handed to the sweep and rebuilt from what the sweep returns.
  // Held inside the sweep instead, it would be one map for every card in the process, and each card's
  // pass would discard the other's entry. Every card but the last to run would then list its plans
  // directory again on every tick, which is the pass over an unbounded directory the hold exists to
  // spend once.
  const roots = ["one", "two"].map((name) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `channels-board-listing-${name}-`));
    mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
    return dir;
  });
  t.after(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });
  const doc = "Status: In Progress\n\n## Sections of Work\n### 1. One\n\n## Chapters\n### Chapter 1\nNext: onward\n";
  const plans = (dir: string): string => path.join(dir, "docs", "plans");
  // A directory that has been still for longer than the settle window is one whose listing is held,
  // and one time for all of them, since the directory's own time is what a hold is keyed on.
  const still = new Date(Date.now() - 60_000);
  const settled = (dir: string): void => {
    utimesSync(plans(dir), still, still);
  };
  for (const dir of roots) {
    writeFileSync(path.join(plans(dir), "alpha_spec_v1.md"), doc, "utf8");
    settled(dir);
  }

  const cards = roots.map((dir) =>
    board({
      roots: [dir],
      eventsPath: path.join(dir, "kit-events.jsonl"),
      binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
      sweep: (options) => sweepPlans([dir], options),
    }),
  );

  await cards[0]?.card.tick();
  // The second card runs between the first card's two passes, which is what two cards in one process
  // do on a shared refresh timer.
  await cards[1]?.card.tick();

  // A name added to the first card's directory, with the directory's own time put back where it was,
  // which is the whole of what a held listing is keyed on. A card that listed again would find it.
  writeFileSync(path.join(plans(roots[0] ?? ""), "beta_spec_v1.md"), doc, "utf8");
  settled(roots[0] ?? "");
  await cards[0]?.card.tick();

  const body = cards[0]?.calls.edits[(cards[0]?.calls.edits.length ?? 1) - 1]?.card ?? "";
  assert.ok(body.includes(drawn("alpha_spec_v1")), body);
  assert.ok(
    !body.includes(drawn("beta_spec_v1")),
    "the first card still holds its own listing, so it did not list the directory again",
  );
});

test("a plan that is gone from the disk is gone from the held parses too", async () => {
  // The holds are rebuilt from each sweep rather than added to, so nothing this card keeps grows past
  // what one sweep returns.
  let present = true;
  const { calls, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => (present ? swept([reading()]) : swept([])),
  });

  await card.tick();
  present = false;
  await card.tick();
  assert.ok(
    !(calls.edits[1]?.card ?? "").includes(drawn("alpha_spec_v1")),
    "the plan's bullets go with the file",
  );

  // A broker that never parsed the plan has no hold behind it, so the same failure draws as a plan
  // the card has nothing for.
  const { calls: after, card: rebuilt } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () =>
      swept(
        [],
        [{ root: ROOT, path: planFile("alpha_spec_v1"), stem: "alpha_spec_v1", reason: "malformed" }],
      ),
  });
  await rebuilt.tick();
  assert.ok((after.edits[0]?.card ?? "").includes(`- ${drawn("alpha_spec_v1")} (does not parse)`));
});

test("plans keep their place when one flips between read and held", async () => {
  // Two lists come back from one sweep, and a plan moving from one to the other must not move on the
  // card: a plan that jumps to the bottom of its project for the tick it could not be read is a card
  // the operator cannot read at a glance.
  let failing = false;
  const { calls, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () =>
      failing
        ? swept(
            [reading({ stem: "b_spec_v1" }), reading({ stem: "c_spec_v1" })],
            [{ root: ROOT, path: planFile("a_spec_v1"), stem: "a_spec_v1", reason: "malformed" }],
          )
        : swept([
            reading({ stem: "a_spec_v1" }),
            reading({ stem: "b_spec_v1" }),
            reading({ stem: "c_spec_v1" }),
          ]),
  });

  await card.tick();
  failing = true;
  await card.tick();

  // Every plan the card names, read back off its bullet in the order the card draws them. A plan the
  // sweep could not read this tick is drawn from its held parse and keeps its bullet, so the names
  // and their order are what this compares.
  const named = (body: string): string[] =>
    body.split("\n").flatMap((line) => {
      const bullet = /^- \*\*(.+)\*\*$/.exec(line);
      return bullet === null ? [] : [(bullet[1] ?? "").replaceAll("\\", "")];
    });
  assert.deepEqual(named(calls.edits[0]?.card ?? ""), ["a_spec_v1", "b_spec_v1", "c_spec_v1"]);
  assert.deepEqual(named(calls.edits[1]?.card ?? ""), ["a_spec_v1", "b_spec_v1", "c_spec_v1"]);
});

test("an event stream that cannot be read is drawn around and logged once per window", async () => {
  const { calls, time, logged, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    readEvents: (previous) => ({ state: previous, unreadable: true }),
  });

  await card.tick();
  time.advance(60_000);
  await card.tick();
  time.advance(5 * 60_000);
  await card.tick();

  assert.ok(calls.edits.length >= 1, "the plans are still drawn without the markers");
  assert.equal(
    logged.filter((line) => line.includes("the markers it feeds are not drawn")).length,
    2,
    "one line per window rather than one per tick",
  );
  assert.ok(logged.some((line) => line.includes("occurred 1 more time(s) in the last 5 minutes")));
});

test("the event reader's state carries from one pass to the next", async () => {
  // The reader tails by byte offset: handing it a fresh state every pass would re-read the whole file
  // on every tick and re-key every event in it.
  const seen: EventReaderState[] = [];
  const { card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    readEvents: (previous) => {
      seen.push(previous);
      return { state: { ...previous, offset: previous.offset + 100 }, unreadable: false };
    },
  });

  await card.tick();
  await card.tick();

  assert.deepEqual(
    seen.map((state) => state.offset),
    [0, 100],
    "the second pass resumes where the first one stopped",
  );
  assert.deepEqual(seen[0], initialEventState(), "and the first starts from nothing consumed");
});

test("a refused edit is skipped rather than queued, and retried on the next tick", async () => {
  let completed = 1;
  const { calls, time, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => swept([reading({ completed })]),
  });
  await card.tick();
  assert.equal(calls.edits.length, 1);

  completed = 2;
  calls.nextEdit = refused(30_000);
  await card.tick();
  assert.equal(calls.edits.length, 2, "the refusal was one attempt, not a retry loop");

  await card.tick();
  assert.equal(calls.edits.length, 2, "nothing is attempted while the bucket is empty");

  time.advance(30_001);
  await card.tick();
  assert.equal(calls.edits.length, 3, "the next tick past the block writes the current card");
  assert.match(calls.edits[2]?.card ?? "", /2\/3/);
});

test("a card that could not be posted is retried rather than left thread-less", async () => {
  const { calls, time, card } = board();
  calls.nextPost = refused(10_000);

  await card.tick();
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.opens.length, 0, "there is no message to open a thread on");

  await card.tick();
  assert.equal(calls.posts.length, 1, "nothing is attempted while the bucket is empty");

  time.advance(10_001);
  await card.tick();
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.opens.length, 1, "the thread is opened on the card that landed");
});

test("a card reported gone while its thread is opened is not then edited", async () => {
  // The pass is holding the identifier the open just invalidated: one more call against it buys a
  // second 404 and nothing else.
  const { calls, card } = board({ binding: () => ({ messageId: MESSAGE_ID, threadId: null }) });
  calls.nextOpen = missing();

  await card.tick();

  assert.equal(calls.opens.length, 1);
  assert.equal(calls.edits.length, 0);

  await card.tick();
  assert.equal(calls.posts.length, 1, "the next tick builds a new card instead");
});

test("the card names the message it is drawn on, and names none while it has none", async () => {
  // What the channel's pin list is driven from at this end. A card Discord reported gone names no
  // message until it has been rebuilt, so the pin the dead identifier held is dropped rather than
  // kept against a message that is not there.
  let completed = 1;
  const { calls, card } = board({ sweep: () => swept([reading({ completed })]) });
  assert.equal(card.cardMessage(), null, "nothing is pinned before the card exists");

  await card.tick();
  assert.equal(card.cardMessage(), MESSAGE_ID);

  completed = 2;
  calls.nextEdit = missing();
  await card.tick();
  assert.equal(card.cardMessage(), null, "a card Discord reports gone names no message");

  await card.tick();
  assert.equal(card.cardMessage(), MESSAGE_ID, "the rebuilt card names the message it is drawn on");
});

test("a card that keeps going missing is rebuilt a bounded number of times", async () => {
  // Anything deleting the card on a cadence would otherwise get a post and a thread open back at
  // every refresh forever: a rebuild is not a refusal, so no refusal count ever sees one.
  let step = 0;
  const { calls, logged, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    // Every pass moves a field the card draws, since a card whose text matches the one that landed
    // spends no call at all: what is under test here is the ceiling, not the edit-on-change rule.
    sweep: () => swept([reading({ next: `step ${String(step)}` })]),
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    calls.nextEdit = missing();
    step += 1;
    await card.tick();
  }

  assert.equal(calls.edits.length, 3, "the third disappearance is the last one answered");
  assert.equal(calls.posts.length, 2, "and only the first two bought a replacement card");
  assert.equal(calls.opens.length, 2);
  assert.ok(logged.some((line) => line.includes("went missing 3 times in a row")));
});

test("a card Discord keeps refusing permanently is given up on", async () => {
  const { calls, logged, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextEdit = permanent();
    await card.tick();
  }

  assert.equal(calls.edits.length, 3, "three refusals in a row end the card's writes");
  assert.ok(logged.some((line) => line.includes("refused 3 times in a row")));
});

test("a route refused past the ceiling stops alone, and the rest of the card keeps working", async () => {
  // A bot without thread-create permission is refused on the open for as long as it runs, while its
  // edits land. One counter for all three routes takes the working ones down with it.
  let step = 0;
  const { calls, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
    // Moved on every pass, so the edit under test is one the card actually has to spend.
    sweep: () => swept([reading({ next: `step ${String(step)}` })]),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextOpen = permanent();
    step += 1;
    await card.tick();
  }

  assert.equal(calls.opens.length, 3, "three refusals in a row end the thread open");
  assert.equal(calls.edits.length, 5, "and the card is still written on every pass");
});

test("refusals far enough apart never add up to a route being given up on", async () => {
  // A route that fails once an afternoon is not a standing block, and treating it as one abandons a
  // card that was working between the failures.
  let completed = 0;
  const { calls, time, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => swept([reading({ completed })]),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextEdit = permanent();
    completed += 1;
    await card.tick();
    // Past the decay window, which is three refresh intervals wide.
    time.advance(3 * 60_000 + 1);
  }

  assert.equal(calls.edits.length, 6, "each refusal opens a fresh run rather than extending one");
});

test("a route's own success clears its refusals without clearing another route's", async () => {
  // The mirror of the split: an open that is refused forever must not be handed a fresh run of three
  // attempts every time an edit lands.
  let step = 0;
  const { calls, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
    // Moved on every pass, so each of the six edits is one the card actually has to spend.
    sweep: () => swept([reading({ next: `step ${String(step)}` })]),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextOpen = permanent();
    step += 1;
    await card.tick();
  }

  assert.equal(calls.edits.length, 6, "every edit landed");
  assert.equal(calls.opens.length, 3, "and none of them bought the open another run");
});

test("a rejected token stops the card rather than being retried on every pass", async () => {
  const { calls, logged, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });
  calls.nextEdit = {
    status: "failed",
    error: "the bot token was rejected",
    rate: NO_RATE_INFO,
    fatal: true,
    permanent: true,
  };

  await card.tick();
  await card.tick();

  assert.equal(calls.edits.length, 1, "the card makes no further call of any kind");
  assert.ok(logged.some((line) => line.includes("the bot token was rejected")));
});

test("the knob off constructs nothing: no thread, no timer, and no file read of any kind", () => {
  const calls = recorder();
  let sweeps = 0;
  let eventReads = 0;
  let bindingReads = 0;
  let timers = 0;
  const built = createBoardCard({
    enabled: false,
    transport: calls.transport,
    roots: [ROOT],
    eventsPath: path.join(ROOT, "kit-events.jsonl"),
    binding: () => {
      bindingReads += 1;
      return { messageId: MESSAGE_ID, threadId: THREAD_ID };
    },
    refreshMs: 60_000,
    now: () => START,
    sweep: () => {
      sweeps += 1;
      return swept([reading()]);
    },
    readEvents: (previous) => {
      eventReads += 1;
      return { state: previous, unreadable: false };
    },
    setTimer: () => {
      timers += 1;
      return 1 as unknown as NodeJS.Timeout;
    },
  });

  assert.equal(built, null);
  assert.equal(sweeps, 0, "no plan doc is opened");
  assert.equal(eventReads, 0, "and the goal event stream is not opened either");
  assert.equal(bindingReads, 0, "no state file is read on a card's account");
  assert.equal(timers, 0);
  assert.equal(calls.posts.length + calls.opens.length + calls.edits.length, 0);
});

test("no Discord configured constructs nothing even with the knob on, and says why once", () => {
  const logged: string[] = [];
  let sweeps = 0;
  let bindingReads = 0;
  let timers = 0;
  const built = createBoardCard({
    enabled: true,
    transport: null,
    log: (message) => logged.push(message),
    roots: [ROOT],
    eventsPath: path.join(ROOT, "kit-events.jsonl"),
    binding: () => {
      bindingReads += 1;
      return { messageId: MESSAGE_ID, threadId: THREAD_ID };
    },
    refreshMs: 60_000,
    now: () => START,
    sweep: () => {
      sweeps += 1;
      return swept([reading()]);
    },
    readEvents: NO_EVENTS,
    setTimer: () => {
      timers += 1;
      return 1 as unknown as NodeJS.Timeout;
    },
  });

  assert.equal(built, null);
  assert.equal(sweeps, 0);
  assert.equal(bindingReads, 0);
  assert.equal(timers, 0);
  // An operator who switched the card on where Discord is misconfigured gets the condition named
  // rather than a silently missing card. Nothing of the configuration itself is written.
  assert.deepEqual(logged, ["board card: Discord is not configured, the card is not built"]);
});

test("the knob off says nothing at all, since nothing was asked for", () => {
  const logged: string[] = [];
  const built = createBoardCard({
    enabled: false,
    transport: null,
    roots: [],
    eventsPath: path.join(ROOT, "kit-events.jsonl"),
    binding: () => null,
    refreshMs: 60_000,
    now: () => START,
    log: (message) => logged.push(message),
    readEvents: NO_EVENTS,
  });

  assert.equal(built, null);
  assert.deepEqual(logged, []);
});

test("the knob on with no project roots builds nothing and says why, once", () => {
  const calls = recorder();
  const logged: string[] = [];
  let sweeps = 0;
  let bindingReads = 0;
  const built = createBoardCard({
    enabled: true,
    transport: calls.transport,
    roots: [],
    eventsPath: path.join(ROOT, "kit-events.jsonl"),
    binding: () => {
      bindingReads += 1;
      return null;
    },
    refreshMs: 60_000,
    now: () => START,
    log: (message) => logged.push(message),
    sweep: () => {
      sweeps += 1;
      return swept([]);
    },
    readEvents: NO_EVENTS,
  });

  assert.equal(built, null);
  assert.equal(sweeps, 0, "there is nothing to sweep and nothing is opened looking for it");
  assert.equal(bindingReads, 0);
  assert.deepEqual(logged, ["board card: no project roots are configured, the card is not built"]);
});

test("start runs its first pass at once rather than one interval later", async () => {
  // Creating or rebinding the thread is what starting is for. Waiting on the interval leaves the card
  // absent from the channel for a whole refresh, which at the configured ceiling is an hour.
  const scheduled: number[] = [];
  const { calls, card } = board({
    refreshMs: 60 * 60 * 1000,
    setTimer: (_callback, ms) => {
      scheduled.push(ms);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  card.start();
  await card.stop();

  assert.deepEqual(scheduled, [60 * 60 * 1000]);
  assert.equal(calls.posts.length, 1, "the card is up without waiting on the interval");
  assert.equal(calls.opens.length, 1);
});

test("stop clears the refresh timer without awaiting anything first", async () => {
  // The broker takes this timer down in the same synchronous block as its own and awaits the drain
  // afterwards. A timer surviving those awaits starts a pass that writes to Discord and to the
  // binding file for a broker that has already dropped its gateway.
  const cleared: number[] = [];
  const { card } = board({
    setTimer: () => 7 as unknown as NodeJS.Timeout,
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  card.start();
  const drain = card.stop();

  assert.deepEqual(cleared, [7], "cleared by the time stop returns, before anything is awaited");
  await drain;
});

test("shutdown waits for the live pass, not for a fire that landed on top of it", async () => {
  // A timer fire arriving while a post is on the wire must be answered with that pass, not with a
  // promise of nothing. Answered wrongly, shutdown returns with the post still unsent: its binding is
  // never saved, and the next start posts a second card into the operator's channel.
  const timers: { id: number; ms: number; callback: () => void }[] = [];
  const cleared: number[] = [];
  const bindings: unknown[] = [];
  let released: (() => void) | null = null;
  const calls = recorder();
  calls.transport = {
    ...calls.transport,
    postCard: async ({ card: body }) => {
      calls.posts.push(body);
      await new Promise<void>((resolve) => {
        released = resolve;
      });
      return ok({ messageId: MESSAGE_ID });
    },
  };
  const { card } = board({
    transport: calls.transport,
    onBind: (binding) => bindings.push(binding),
    setTimer: (callback, ms) => {
      const id = timers.length + 1;
      timers.push({ id, ms, callback });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  card.start();
  card.start();
  assert.equal(timers.length, 1, "starting twice runs one timer, not two");
  assert.equal(timers[0]?.ms, 60_000);
  assert.equal(calls.posts.length, 1, "and the first pass is already on the wire");

  timers[0]?.callback();
  assert.equal(calls.posts.length, 1, "a fire landing on that pass starts no second one");

  let stopped = false;
  const shutdown = card.stop().then(() => {
    stopped = true;
  });
  assert.deepEqual(cleared, [1]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown waits for the call already on the wire");

  (released as unknown as () => void)();
  await shutdown;
  assert.equal(stopped, true);
  assert.deepEqual(
    bindings,
    [
      { messageId: MESSAGE_ID, threadId: null },
      { messageId: MESSAGE_ID, threadId: THREAD_ID },
    ],
    "the card that post created was persisted before shutdown returned",
  );
  // The timer is gone, so no further pass is scheduled and the recorded one is the only post.
  assert.equal(calls.posts.length, 1);
});

test("a pass that throws is caught, reported through the limiter, and followed by another", async () => {
  // An unhandled rejection out of a refresh pass is fatal to the process under Node 24, which would
  // take the hook intake down with the card.
  let failing = true;
  const timers: (() => void)[] = [];
  const { calls, logged, card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => {
      if (failing) throw new Error("the plans directory carries a path");
      return swept([reading()]);
    },
    setTimer: (callback) => {
      timers.push(callback);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  card.start();
  await card.stop();
  assert.equal(calls.edits.length, 0);
  const reported = logged.filter((line) => line.includes("a refresh pass failed"));
  assert.equal(reported.length, 1);
  assert.doesNotMatch(reported[0] ?? "", /carries a path/, "the error itself is discarded unread");

  failing = false;
  timers[0]?.();
  await card.stop();
  assert.equal(calls.edits.length, 1, "the next pass runs as if nothing had happened");
});

test("one failing pass is one failure however many timer fires joined it", async () => {
  // A fire landing on a pass already running is answered with that pass. Reported once per observer
  // instead of once per pass, a single failure is counted three times, and the count rides out on
  // the next line the limiter's window admits as repeats that never happened.
  const timers: (() => void)[] = [];
  let release: ((value: never) => void) | null = null;
  const calls = recorder();
  calls.transport = {
    ...calls.transport,
    editCard: async ({ messageId, card }) => {
      calls.edits.push({ messageId, card });
      return new Promise<never>((_resolve, reject) => {
        release = reject as (value: never) => void;
      });
    },
  };
  let step = 0;
  const { time, logged, card } = board({
    transport: calls.transport,
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    // Moved on every pass, so each pass reaches the edit that fails.
    sweep: () => swept([reading({ next: `step ${String(step)}` })]),
    setTimer: (callback) => {
      timers.push(callback);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  card.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.edits.length, 1, "the first pass is on the wire");
  timers[0]?.();
  timers[0]?.();
  assert.equal(calls.edits.length, 1, "and the two fires that landed on it started no second pass");
  (release as unknown as (error: Error) => void)(new Error("the edit carries the card body"));
  await card.stop();

  // Past the limiter's window, so the next failure's line is one the limiter admits and carries
  // whatever the first window counted.
  time.advance(5 * 60_000 + 1);
  step += 1;
  timers[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  (release as unknown as (error: Error) => void)(new Error("the edit carries the card body"));
  await card.stop();

  const reported = logged.filter((line) => line.includes("a refresh pass failed"));
  assert.equal(reported.length, 2, "one line per failing pass, not one per fire that observed it");
  assert.deepEqual(
    logged.filter((line) => line.includes("more time(s)")),
    [],
    "and no window reports repeats that never happened",
  );
});
