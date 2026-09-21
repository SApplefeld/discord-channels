import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_THREAD_NAME, createBoardCard, EVENT_DRAIN_WINDOWS } from "./thread.ts";
import type { BoardCardOptions } from "./thread.ts";
import { loadBoardBinding, saveBoardBinding } from "./binding.ts";
import { sweepPlans } from "./plans.ts";
import type { PlanFailure, PlanRead, PlanReading, PlanSweep } from "./plans.ts";
import { initialEventState, MAX_EVENTS_READ_BYTES } from "./events.ts";
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
    rosterPath: "",
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

test("a project with no parsed plan in it draws last, and takes its place the tick one parses", async () => {
  // A project whose one plan has never parsed has nothing but a failure line to draw, so it carries
  // no modification time for the card to order it by and it sits after every project that does. The
  // tick its plan first parses it takes the place that plan's own age earns it. Only a plan that has
  // never parsed is here: one the caller holds a parse for is redrawn from that parse, which carries
  // its mtime, so a doc caught mid-write does not move its project at all.
  //
  // This project is configured first and its plan is the older of the two, so neither order the card
  // draws here is the configured one: the second pass reads the age rather than the list.
  const OTHER = path.join(os.tmpdir(), "channels-board-second-project");
  const other = reading({ stem: "beta_spec_v1", root: OTHER });
  let parses = false;
  const { calls, card } = board({
    roots: [ROOT, OTHER],
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () =>
      parses
        ? swept([reading({ stem: "alpha_spec_v1", mtimeMs: START - 60 * 60_000 }), other])
        : swept(
            [other],
            [{ root: ROOT, path: planFile("alpha_spec_v1"), stem: "alpha_spec_v1", reason: "malformed" }],
          ),
  });

  // A project's label is a one-line fence: its content sits between two "```" delimiters.
  const projects = (body: string): string[] => {
    const lines = body.split("\n");
    const names: string[] = [];
    for (const [at, line] of lines.entries()) {
      if (line === "```" && lines[at + 2] === "```") names.push((lines[at + 1] ?? "").replaceAll("\\", ""));
    }
    return names;
  };

  await card.tick();
  assert.deepEqual(projects(calls.edits[0]?.card ?? ""), [
    path.basename(OTHER),
    path.basename(ROOT),
  ], "the project with only a failure to draw has no mtime, so it draws after the one that has");

  parses = true;
  await card.tick();
  assert.deepEqual(projects(calls.edits[1]?.card ?? ""), [
    path.basename(OTHER),
    path.basename(ROOT),
  ], "the tick its plan parses, that plan's own age places it, and this one is the older of the two");
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
  // on every tick and re-key every event in it. The mock converges after one advance, the shape a
  // real window takes once nothing more is on disk, so the first tick's own reset drains in two calls
  // rather than spinning to its cap.
  const seen: EventReaderState[] = [];
  const { card } = board({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    readEvents: (previous) => {
      seen.push(previous);
      const next = previous.offset < 100 ? previous.offset + 100 : previous.offset;
      return { state: { ...previous, offset: next }, unreadable: false };
    },
  });

  await card.tick();
  await card.tick();

  assert.deepEqual(
    seen.map((state) => state.offset),
    [0, 100, 100],
    "the first tick's reset drains to convergence, and the second pass resumes where it left off",
  );
  assert.deepEqual(seen[0], initialEventState(), "and the first call starts from nothing consumed");
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
  let rosterReads = 0;
  let queueReads = 0;
  const built = createBoardCard({
    enabled: false,
    transport: calls.transport,
    roots: [ROOT],
    rosterPath: "D:\\personas\\fleet.json",
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
    readRoster: () => {
      rosterReads += 1;
      return [];
    },
    readQueues: (personas) => {
      queueReads += 1;
      return personas.map(() => ({
        name: "",
        workdir: "",
        entries: [],
        activeGoalId: null,
        lastTurnComplete: null,
        turnStartedAt: null,
        readings: new Map(),
        heldSince: null,
      }));
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
  assert.equal(rosterReads, 0, "and the roster is not read either");
  assert.equal(queueReads, 0, "nor is any persona's store or heartbeat");
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
    rosterPath: "",
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
    rosterPath: "",
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

test("the knob on with neither project roots nor a roster builds nothing and says why, once", () => {
  const calls = recorder();
  const logged: string[] = [];
  let sweeps = 0;
  let bindingReads = 0;
  let rosterReads = 0;
  const built = createBoardCard({
    enabled: true,
    transport: calls.transport,
    roots: [],
    rosterPath: "",
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
    readRoster: () => {
      rosterReads += 1;
      return [];
    },
    readEvents: NO_EVENTS,
  });

  assert.equal(built, null);
  assert.equal(sweeps, 0, "there is nothing to sweep and nothing is opened looking for it");
  assert.equal(bindingReads, 0);
  assert.equal(rosterReads, 0, "and the roster is not read either, since neither source is set");
  assert.deepEqual(logged, [
    "board card: neither project roots nor a roster is configured, the card is not built",
  ]);
});

test("the roster alone, with no project roots, builds the card and draws persona groups only", async () => {
  const { calls, card } = board({
    roots: [],
    rosterPath: "D:\\personas\\fleet.json",
    sweep: () => swept([]),
    readRoster: () => [{ name: "worker-one", workdir: path.join(ROOT, "worker-one") }],
    readQueues: (personas) =>
      personas.map((persona) => ({
        name: persona.name,
        workdir: persona.workdir,
        entries: [{ id: "g1", title: "First plan", status: "paused" }],
        activeGoalId: null,
        lastTurnComplete: null,
        turnStartedAt: null,
        readings: new Map([
          [
            "g1",
            {
              archived: false,
              status: "Ready",
              terminal: false,
              sections: 2,
              completed: 0,
              next: null,
              root: persona.workdir,
              path: path.join(persona.workdir, "docs", "plans", "first_spec_v1.md"),
              stem: "first_spec_v1",
              mtimeMs: START - 60 * 60_000,
              sizeBytes: 1_024,
              heldSince: START - 3 * 60 * 60_000,
            },
          ],
        ]),
        heldSince: null,
      })),
  });

  await card.tick();

  const body = calls.posts[0] ?? "";
  assert.match(body, /worker-one/);
  assert.match(body, /First plan/);
  assert.doesNotMatch(body, /No open plans in the configured projects/);
  assert.match(body, /^card as of 3h ago$/m, "the entry's held parse instant reaches the footer");
});

test("a queue holding two entries under one id draws the first entry's title", async () => {
  // The queue reader keeps the first entry's reading for a repeated id, so the title beside it has to
  // agree: a last-write-wins title would name one entry with the reading of another.
  const { calls, card } = board({
    roots: [],
    rosterPath: "D:\\personas\\fleet.json",
    sweep: () => swept([]),
    readRoster: () => [{ name: "worker-one", workdir: path.join(ROOT, "worker-one") }],
    readQueues: (personas) =>
      personas.map((persona) => ({
        name: persona.name,
        workdir: persona.workdir,
        entries: [
          { id: "g1", title: "First title", status: "paused" },
          { id: "g1", title: "Second title", status: "paused" },
        ],
        activeGoalId: null,
        lastTurnComplete: null,
        turnStartedAt: null,
        readings: new Map(),
        heldSince: null,
      })),
  });

  await card.tick();

  const body = calls.posts[0] ?? "";
  assert.match(body, /First title/);
  assert.doesNotMatch(body, /Second title/);
});

test("a persona enabled since the last tick widens the event roots and resets the reader", async () => {
  // The event reader drops a line whose project matches no root it was handed at the moment that
  // line was read, so a persona enabled after that moment needs the stream read again from its
  // start under the wider list, or its own events are gone for good.
  //
  // What is recorded is the offset each tick's own first call opens with, not every call a reset
  // tick's drain makes: a reset now spends more than one call when the stream keeps advancing, and
  // this test's own subject is the reset rather than the drain, which the tests beside it cover.
  const starts: number[] = [];
  let firstCallThisTick = true;
  let personas: { name: string; workdir: string }[] = [];
  const { card } = board({
    readRoster: () => personas,
    readQueues: (ps) =>
      ps.map((persona) => ({
        name: persona.name,
        workdir: persona.workdir,
        entries: [],
        activeGoalId: null,
        lastTurnComplete: null,
        turnStartedAt: null,
        readings: new Map(),
        heldSince: null,
      })),
    readEvents: (previous) => {
      if (firstCallThisTick) {
        starts.push(previous.offset);
        firstCallThisTick = false;
      }
      // Converges after one advance, so a reset tick's own drain halts here rather than spinning to
      // its cap.
      const next = previous.offset < 1 ? previous.offset + 1 : previous.offset;
      return { state: { ...previous, offset: next }, unreadable: false };
    },
  });

  firstCallThisTick = true;
  await card.tick();
  firstCallThisTick = true;
  await card.tick();
  personas = [{ name: "worker-one", workdir: path.join(ROOT, "worker-one") }];
  firstCallThisTick = true;
  await card.tick();

  assert.deepEqual(starts, [0, 1, 0], "the third tick opens its reset at offset 0, not 2");
});

test("a goal-blocked event read on a tick before a persona was enabled marks that persona's entry on the first tick after it is enabled", async (t) => {
  // The offsets test above proves the reset only through an injected reader's counters. This one
  // drives the real reader end to end, so the reset is shown actually surfacing a dropped event.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workdir = path.join(dir, "worker-one");
  const eventsPath = path.join(dir, "kit-events.jsonl");
  writeFileSync(
    eventsPath,
    // Stamped between the reading's mtime and the clock, the ordinary past-stamped path rather than
    // the future-stamp clamp: `blockedAt` draws blocked either way, and this is the path a real event
    // actually takes.
    `${JSON.stringify({
      ts: new Date(START - 30 * 60_000).toISOString(),
      event: "goal-blocked",
      project: workdir,
      plan: "docs/plans/first_spec_v1.md",
      session: null,
    })}\n`,
    "utf8",
  );

  const worker = { name: "worker-one", workdir };
  const queueFor = (persona: { name: string; workdir: string }) => ({
    name: persona.name,
    workdir: persona.workdir,
    entries: [{ id: "g1", title: "First plan", status: "paused" }],
    activeGoalId: null,
    lastTurnComplete: null,
    turnStartedAt: null,
    readings: new Map([
      [
        "g1",
        {
          archived: false as const,
          status: "Ready",
          terminal: false,
          sections: 2,
          completed: 0,
          next: null,
          root: persona.workdir,
          path: path.join(persona.workdir, "docs", "plans", "first_spec_v1.md"),
          stem: "first_spec_v1",
          mtimeMs: START - 60 * 60_000,
          sizeBytes: 1_024,
          heldSince: null,
        },
      ],
    ]),
    heldSince: null,
  });

  let personas: { name: string; workdir: string }[] = [];
  const { calls, card } = board({
    roots: [],
    rosterPath: "D:\\personas\\fleet.json",
    sweep: () => swept([]),
    readEvents: undefined,
    eventsPath,
    readRoster: () => personas,
    readQueues: (ps) => ps.map(queueFor),
  });

  await card.tick();
  const firstBody = calls.posts[0] ?? "";
  assert.doesNotMatch(
    firstBody,
    /blocked/,
    "no persona is enabled on the first tick, so nothing the card drew can carry the word",
  );

  personas = [worker];
  await card.tick();
  const secondBody = calls.edits.at(-1)?.card ?? "";
  assert.match(secondBody, /worker-one/);
  assert.match(secondBody, /First plan/);
  assert.match(
    secondBody,
    /blocked/,
    "the widened roots reset the reader, so the event dropped on tick one is read again and lands on this entry",
  );

  // The withheld control: the same file and the same persona enabled from the first tick draws
  // `blocked` on tick one too. That is what proves the fixture itself can produce the word, so the
  // assertion above is not green for a reason unrelated to the reset.
  const control = board({
    roots: [],
    rosterPath: "D:\\personas\\fleet.json",
    sweep: () => swept([]),
    readEvents: undefined,
    eventsPath,
    readRoster: () => [worker],
    readQueues: (ps) => ps.map(queueFor),
  });
  await control.card.tick();
  const controlBody = control.calls.posts[0] ?? "";
  assert.match(
    controlBody,
    /blocked/,
    "the control: enabled from the first tick, the same event marks the entry with no reset needed",
  );
});

test("a goal-blocked line past the first read window still marks the entry once the roots widen", async (t) => {
  // The stream is larger than one read window, so a reset that spends only one call never reaches
  // the last line. This drives the real reader end to end, the same idiom the reset test above uses,
  // over a stream too big for a single window to cross.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-drain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workdir = path.join(dir, "worker-one");
  const eventsPath = path.join(dir, "kit-events.jsonl");

  // A line the reader accepts and drops: it parses cleanly but names a project that matches no
  // configured root or persona folder, so it costs read bytes without ever being kept.
  const filler = `${JSON.stringify({
    ts: "2024-01-01T00:00:00.000Z",
    event: "goal-complete",
    project: path.join(dir, "unrelated-project"),
    plan: "docs/plans/other_spec_v1.md",
    session: null,
  })}\n`;
  const repeats = Math.ceil((MAX_EVENTS_READ_BYTES * 1.5) / filler.length);
  const blockedLine = `${JSON.stringify({
    ts: new Date(START - 30 * 60_000).toISOString(),
    event: "goal-blocked",
    project: workdir,
    plan: "docs/plans/first_spec_v1.md",
    session: null,
  })}\n`;
  const fixture = filler.repeat(repeats) + blockedLine;
  assert.ok(
    fixture.length > MAX_EVENTS_READ_BYTES,
    "the fixture has to outgrow one read window for this test to mean anything",
  );
  writeFileSync(eventsPath, fixture, "utf8");

  const worker = { name: "worker-one", workdir };
  const queueFor = (persona: { name: string; workdir: string }) => ({
    name: persona.name,
    workdir: persona.workdir,
    entries: [{ id: "g1", title: "First plan", status: "paused" }],
    activeGoalId: null,
    lastTurnComplete: null,
    turnStartedAt: null,
    readings: new Map([
      [
        "g1",
        {
          archived: false as const,
          status: "Ready",
          terminal: false,
          sections: 2,
          completed: 0,
          next: null,
          root: persona.workdir,
          path: path.join(persona.workdir, "docs", "plans", "first_spec_v1.md"),
          stem: "first_spec_v1",
          mtimeMs: START - 60 * 60_000,
          sizeBytes: 1_024,
          heldSince: null,
        },
      ],
    ]),
    heldSince: null,
  });

  let personas: { name: string; workdir: string }[] = [];
  const { calls, card } = board({
    roots: [],
    rosterPath: "D:\\personas\\fleet.json",
    sweep: () => swept([]),
    readEvents: undefined,
    eventsPath,
    readRoster: () => personas,
    readQueues: (ps) => ps.map(queueFor),
  });

  await card.tick();
  assert.doesNotMatch(
    calls.posts[0] ?? "",
    /blocked/,
    "no persona is enabled on the first tick, so the line drops for want of a matching root",
  );

  personas = [worker];
  await card.tick();
  const secondBody = calls.edits.at(-1)?.card ?? "";
  assert.match(secondBody, /worker-one/);
  assert.match(
    secondBody,
    /blocked/,
    "the reset drains past the first window in the same tick, so the last line lands on this entry",
  );
});

test("a project's blocked marker survives a reset even though the reset's own drain does not reach the line again", async (t) => {
  // The line sits past the reset drain's own nine-window budget, established there before this test
  // starts widening the roots. Once found by the ordinary steady reads that follow, only a carried
  // map keeps the marker when enabling the persona forces a fresh reset over the same stream.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-carry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "kit-events.jsonl");

  const filler = `${JSON.stringify({
    ts: "2024-01-01T00:00:00.000Z",
    event: "goal-complete",
    project: path.join(dir, "unrelated-project"),
    plan: "docs/plans/other_spec_v1.md",
    session: null,
  })}\n`;
  const beyondDrainBudget = MAX_EVENTS_READ_BYTES * EVENT_DRAIN_WINDOWS + 40_000;
  const repeats = Math.ceil(beyondDrainBudget / filler.length);
  const blockedLine = `${JSON.stringify({
    ts: new Date(START - 30 * 60_000).toISOString(),
    event: "goal-blocked",
    project: ROOT,
    plan: "docs/plans/gamma_spec_v1.md",
    session: null,
  })}\n`;
  const filled = filler.repeat(repeats);
  assert.ok(
    filled.length > MAX_EVENTS_READ_BYTES * EVENT_DRAIN_WINDOWS,
    "the line has to sit past what one reset's own drain can reach for this test to mean anything",
  );
  assert.ok(
    filled.length - MAX_EVENTS_READ_BYTES * EVENT_DRAIN_WINDOWS < MAX_EVENTS_READ_BYTES,
    "and within reach of the single steady window that follows",
  );
  writeFileSync(eventsPath, filled + blockedLine, "utf8");

  let personas: { name: string; workdir: string }[] = [];
  const { calls, card } = board({
    eventsPath,
    readEvents: undefined,
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sweep: () => swept([reading({ stem: "gamma_spec_v1", mtimeMs: START - 60 * 60_000 })]),
    readRoster: () => personas,
    readQueues: (ps) =>
      ps.map((persona) => ({
        name: persona.name,
        workdir: persona.workdir,
        entries: [],
        activeGoalId: null,
        lastTurnComplete: null,
        turnStartedAt: null,
        readings: new Map(),
        heldSince: null,
      })),
  });

  // The first tick's own reset drains up to the window cap, which the filler alone already exceeds:
  // the line is not reached yet.
  await card.tick();
  assert.doesNotMatch(calls.edits.at(-1)?.card ?? "", /blocked/);

  // A steady tick, roots unchanged, spends its one window on the bytes the first tick's drain left
  // off at, which is exactly where the line sits.
  await card.tick();
  assert.match(
    calls.edits.at(-1)?.card ?? "",
    /blocked/,
    "the steady window that follows the drain reaches the line",
  );

  // The persona widens the roots and forces a fresh reset. Its own drain again stops at the window
  // cap, short of the line. The persona has no queue entries of its own, so nothing else about the
  // card changes and no further edit is spent; the last edit on record is still the one that has to
  // carry the marker, and only the carried map keeps it there.
  personas = [{ name: "worker-one", workdir: path.join(dir, "worker-one") }];
  await card.tick();
  assert.match(
    calls.edits.at(-1)?.card ?? "",
    /blocked/,
    "the carried map keeps the marker even though this reset's own drain does not reach the line again",
  );
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

test("the default readers, driven from real files, join a roster and a store without the store's raw words reaching the card", async (t) => {
  // Every other test in this file injects `readRoster` and `readQueues`. This one leaves both out, so
  // the roster file and the persona plugin's own store are read the way the wiring actually reads
  // them, and the words the card must never draw are the real store's words rather than a test double's.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-board-wiring-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const workdir = path.join(dir, "worker-one");
  mkdirSync(path.join(workdir, "docs", "plans"), { recursive: true });
  writeFileSync(
    path.join(workdir, "docs", "plans", "first_spec_v1.md"),
    "Status: In Progress\n\n## Sections of Work\n### 1. One\n\n## Chapters\n### Chapter 1\nNext: onward\n",
    "utf8",
  );

  writeFileSync(
    path.join(dir, "roster.json"),
    JSON.stringify([{ name: "worker-one", workdir, enabled: true }]),
    "utf8",
  );

  writeFileSync(
    path.join(workdir, ".agentic-personas.json"),
    JSON.stringify({
      "worker-one": {
        goals: [
          {
            id: "g1",
            kind: "plan",
            title: "Finish the fleet board plan",
            status: "paused",
            planPath: "docs/plans/first_spec_v1.md",
            sortKey: 1,
            createdAt: 1,
          },
          { id: "g2", kind: "plan", title: "Next up", status: "pending", sortKey: 2, createdAt: 2 },
          {
            // The round-limit reason: bookkeeping the plugin writes while working normally, never a
            // block on this card. The plan's own Intent rules this store status out as the truth.
            id: "g3",
            kind: "plan",
            title: "Stuck",
            status: "blocked",
            blockedReason: "Max rounds reached",
            sortKey: 3,
            createdAt: 3,
          },
        ],
        activeGoalId: null,
        monitor: { lastTurnComplete: null },
      },
    }),
    "utf8",
  );

  // The absence check this test rests on: none of the store's own words reaches the posted body.
  const assertNoBannedWords = (body: string): void => {
    for (const word of ["paused", "pending", "Max rounds"]) {
      assert.doesNotMatch(body, new RegExp(word, "i"), `the store's own word "${word}" must not reach the card`);
    }
  };

  const { calls, card } = board({
    roots: [],
    rosterPath: path.join(dir, "roster.json"),
    eventsPath: path.join(dir, "kit-events.jsonl"),
    sweep: () => swept([]),
    readEvents: NO_EVENTS,
  });

  await card.tick();

  const body = calls.posts[0] ?? "";
  assert.match(body, /worker-one/, "the persona's name reaches the card");
  assert.match(body, /Finish the fleet board plan/, "the plan title reaches the card");
  assertNoBannedWords(body);

  // The withheld control: the same helper must refuse a body that does carry a banned word, which is
  // what proves the silence over the real body above means the words are absent rather than that the
  // check never ran. The capitalised form is the second control, since the card draws its own text
  // in sentence case and a check that read only the lower-case word would let that spelling through.
  assert.throws(() => assertNoBannedWords("a body that carries paused right here"));
  assert.throws(() => assertNoBannedWords("A body that carries Paused right here"));
});
