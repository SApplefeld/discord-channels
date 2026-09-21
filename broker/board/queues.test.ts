import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPlanFile } from "./plans.ts";
import type { PlanReading } from "./plans.ts";
import {
  HEARTBEAT_FILE_NAME,
  MAX_INTAKE_REASON_LENGTH,
  MAX_INTAKE_TITLE_LENGTH,
  MAX_INTAKE_WORD_LENGTH,
  MAX_QUEUE_ENTRIES,
  MAX_STORE_FILE_BYTES,
  STORE_FILE_NAME,
  createQueueReader,
} from "./queues.ts";
import type { PlanStat, QueuePlanReading, QueueReaderOptions } from "./queues.ts";
import type { RosterPersona } from "./roster.ts";

// Everything a persona's store holds is written by that persona, so the join from a queue entry to a
// plan document is a boundary rather than a lookup: the tests below pin which paths it tries, not
// only what it returns. An assertion that a crafted name yielded no reading passes just as well when
// the reading it failed to get came from a file outside the working folder.

const PERSONA = "dev-plugin";

/** A scratch working folder per test, so no two tests share a path or a store. */
type Workdir = {
  dir: string;
  persona: RosterPersona;
  /** The parent of the working folder, which is where a traversal would land. */
  outside: string;
  store: (value: unknown) => void;
  storeText: (text: string) => void;
  heartbeat: (value: unknown) => void;
  /** Writes a file under the working folder and returns its absolute path. */
  file: (relative: readonly string[], name: string, text: string) => string;
  cleanup: () => void;
};

function workdir(): Workdir {
  const outside = mkdtempSync(path.join(os.tmpdir(), "channels-queues-"));
  const dir = path.join(outside, "worker");
  mkdirSync(dir, { recursive: true });
  const write = (file: string, text: string): string => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    return file;
  };
  return {
    dir,
    outside,
    persona: { name: PERSONA, workdir: dir },
    store: (value) => write(path.join(dir, STORE_FILE_NAME), JSON.stringify(value)),
    storeText: (text) => write(path.join(dir, STORE_FILE_NAME), text),
    heartbeat: (value) => write(path.join(dir, HEARTBEAT_FILE_NAME), JSON.stringify(value)),
    file: (relative, name, text) => write(path.join(dir, ...relative, name), text),
    cleanup: () => rmSync(outside, { recursive: true, force: true }),
  };
}

/** A plan doc with a `Status:` header and two sections, one of them closed by a Chapter. */
function planDoc(status = "In Progress"): string {
  return [
    "# A plan",
    "",
    `Status: ${status}`,
    "",
    "## Sections of Work",
    "",
    "### 1. The reader",
    "",
    "### 2. The renderer",
    "",
    "## Chapters",
    "",
    "### Chapter 1",
    "Completed: 1. The reader",
    "Next: 2. The renderer",
    "",
  ].join("\n");
}

/** One goal as the plugin's store writes it: only `id` is required of it here. */
function goal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "goal-1", kind: "plan", title: "A queued plan", createdAt: 1_000, ...overrides };
}

/** A store file's contents for one persona. */
function store(goals: readonly unknown[], own: Record<string, unknown> = {}): unknown {
  return { [PERSONA]: { goals, activeGoalId: null, ...own } };
}

/**
 * The join's two file seams, recording every path they are handed and then doing the real thing.
 * Recording is the point: the only way to tell a refusal from a miss is to read the paths tried.
 */
function seams(): {
  statted: string[];
  opened: string[];
  options: QueueReaderOptions;
} {
  const statted: string[] = [];
  const opened: string[] = [];
  return {
    statted,
    opened,
    options: {
      statPlan: (file: string): PlanStat | null => {
        statted.push(file);
        try {
          const stat = statSync(file);
          return stat.isFile() ? { mtimeMs: stat.mtimeMs, sizeBytes: stat.size } : null;
        } catch {
          return null;
        }
      },
      readPlan: (file: string) => {
        opened.push(file);
        return readPlanFile(file);
      },
    },
  };
}

/** One entry's reading, asserted to be a live plan rather than an archived marker, so the contract
 * fields the tests below read are the ones a live reading carries. */
function live(reading: QueuePlanReading | undefined): PlanReading {
  assert.ok(reading !== undefined && !reading.archived, "the entry must join to a live plan");
  return reading;
}

/** The four places a name is looked for, in order, under one working folder. */
function places(dir: string, name: string): string[] {
  return [
    path.join(dir, "docs", "plans", name),
    path.join(dir, "docs", "archive", "plans", name),
    path.join(dir, "docs", "archive", name),
    path.join(dir, "docs", "plans", "archive", name),
  ];
}

test("live-shaped objective text joins to the named plan, trailing punctuation left outside", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(
    store([
      goal({
        id: "comma",
        objective: "Finish docs/plans/a_b_v1.md, which lives on a branch",
      }),
      goal({ id: "stop", createdAt: 2_000, objective: "See docs/plans/a_b_v1.md." }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  assert.ok(queue !== undefined);
  for (const id of ["comma", "stop"]) {
    const reading = queue.readings.get(id);
    assert.ok(reading !== undefined, `${id} must join to a plan`);
    assert.equal(reading.archived, false);
    assert.equal(reading.path, file);
    assert.equal(reading.root, work.dir);
    assert.equal(reading.stem, "a_b_v1");
    assert.ok(!reading.archived);
    assert.equal(reading.status, "In Progress");
    assert.equal(reading.sections, 2);
    assert.equal(reading.completed, 1);
    assert.equal(reading.next, "2. The renderer");
  }
});

test("a plan found only in an archive folder is reported archived and is never opened", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const archived = work.file(["docs", "archive"], "a_b_v1.md", planDoc());
  work.store(store([goal({ objective: "Finish docs/plans/a_b_v1.md, which is done" })]));

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  const reading = queue?.readings.get("goal-1");
  assert.ok(reading !== undefined);
  assert.equal(reading.archived, true);
  assert.equal(reading.path, archived);
  assert.equal(reading.stem, "a_b_v1");
  assert.deepEqual(seam.opened, [], "an archived plan's contents change nothing, so it is not read");
  assert.deepEqual(seam.statted, places(work.dir, "a_b_v1.md").slice(0, 3));
});

test("planPath wins over the entry's own text", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.file(["docs", "plans"], "from_field_v1.md", planDoc("Ready"));
  work.file(["docs", "plans"], "from_text_v1.md", planDoc("Complete"));
  work.store(
    store([
      goal({
        planPath: "D:\\elsewhere\\docs\\plans\\from_field_v1.md",
        objective: "Finish docs/plans/from_text_v1.md, which is the wrong one",
      }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  const reading = queue?.readings.get("goal-1");
  assert.ok(reading !== undefined && !reading.archived);
  assert.equal(reading.stem, "from_field_v1");
  assert.equal(reading.status, "Ready");
});

test("a name that fails the pattern, a README, and an entry naming no plan open and stat nothing", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // Each of these files exists, so the three refusals below cannot pass by the file being absent.
  work.file(["docs", "plans"], "README.md", planDoc());
  work.file(["docs", "plans"], "readme.MD", planDoc());
  work.store(
    store([
      // Refused by PLAN_NAME: a leading hyphen is not the alphanumeric the pattern's first
      // character class requires.
      goal({ id: "bad-name", planPath: "-secret.md" }),
      // Refused by PLAN_NAME: a space is outside the name character class.
      goal({ id: "spaced", planPath: "two words.md" }),
      // Refused by PLAN_NAME: the suffix is anchored, so an extension-shaped middle is not one.
      goal({ id: "suffixed", planPath: "plan.md.exe" }),
      // Refused by the README rule, on the whole case-folded stem. The name pattern admits both
      // spellings, its suffix folding case the way the stem does, so each reaches that rule.
      goal({ id: "readme-upper", planPath: "README.md" }),
      goal({ id: "readme-mixed", planPath: "readme.MD" }),
      // Refused for naming nothing: the text carries no `docs/plans/<name>.md` at all.
      goal({ id: "no-plan", objective: "Work out what the fleet is doing\nwith no plan named" }),
      // Refused by the text pattern: a name past its length bound is no name.
      goal({ id: "overlong", objective: `docs/plans/${"x".repeat(260)}.md` }),
    ]),
  );

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  assert.ok(queue !== undefined);
  assert.equal(queue.entries.length, 7);
  assert.equal(queue.readings.size, 0, "no entry above names a plan this module will act on");
  assert.deepEqual(seam.statted, [], "a refused name is refused before any path is built");
  assert.deepEqual(seam.opened, []);
});

test("a crafted planPath is reduced to its last segment and looked for inside the workdir only", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // The real target of every traversal below, planted where the crafted value points. Nothing may
  // stat or open it: if the guard were the file simply being absent, this fixture would defeat it.
  const target = path.join(work.outside, "secret.md");
  writeFileSync(target, planDoc("Complete"), "utf8");

  const crafted = [
    "..\\..\\secret.md",
    "../../secret.md",
    // Withheld members, matched on the class's shape rather than on a spelling the reduction was
    // written against: a mixed separator pair, a deeper climb, and an absolute path on this drive.
    "..\\../secret.md",
    "..\\..\\..\\..\\..\\secret.md",
    path.join(work.outside, "secret.md"),
    "D:\\secret.md",
  ];

  for (const planPath of crafted) {
    const seam = seams();
    work.store(store([goal({ planPath })]));
    const [queue] = createQueueReader(seam.options).read([work.persona]);

    assert.equal(queue?.readings.size, 0, `${planPath} must yield no reading`);
    assert.deepEqual(
      seam.statted,
      places(work.dir, "secret.md"),
      `${planPath} must be tried in the four places under the workdir and nowhere else`,
    );
    assert.deepEqual(seam.opened, [], `${planPath} must open nothing`);
    for (const tried of seam.statted) {
      assert.ok(
        tried.startsWith(work.dir + path.sep),
        `${tried} must sit under the working folder`,
      );
    }
  }

  // Control: the same basename inside the working folder is found and read, so the refusals above
  // are the reduction to a basename rather than this module failing to find anything at all.
  const inside = work.file(["docs", "plans"], "secret.md", planDoc());
  const seam = seams();
  work.store(store([goal({ planPath: "..\\..\\secret.md" })]));
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  const reading = queue?.readings.get("goal-1");
  assert.ok(reading !== undefined && !reading.archived);
  assert.equal(reading.path, inside);
  assert.deepEqual(seam.opened, [inside]);
  assert.equal(statSync(target).size, planDoc("Complete").length, "the planted target is untouched");
});

test("a directory standing at a plan's name is not a plan and is never opened", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // A directory carrying the name the entry asks for, and the module's own `statFile` deciding what
  // to make of it. The stat seam the other join tests inject applies this rule itself, so a suite
  // that only ever stats through that seam says nothing about the guard inside the module.
  const named = path.join(work.dir, "docs", "plans", "a_b_v1.md");
  mkdirSync(named, { recursive: true });
  work.store(store([goal({ planPath: "a_b_v1.md" })]));

  const opened: string[] = [];
  const options: QueueReaderOptions = {
    readPlan: (target) => {
      opened.push(target);
      return readPlanFile(target);
    },
  };
  const [queue] = createQueueReader(options).read([work.persona]);
  assert.equal(queue?.readings.size, 0, "a directory at a plan's name yields no reading");
  assert.deepEqual(opened, [], "a name that is not a regular file is refused before the open");

  // Control: that same name, as a regular file, in that same place. The refusal above is the stat's
  // own rule rather than the name being looked for somewhere this fixture never wrote to.
  rmSync(named, { recursive: true, force: true });
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  const [control] = createQueueReader(options).read([work.persona]);
  assert.equal(live(control?.readings.get("goal-1")).path, file);
  assert.deepEqual(opened, [file]);
});

test("a store that fails to parse yields last tick's entries and the instant the hold began", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(store([goal({ title: "First" })]));

  let clock = 1_000;
  const reader = createQueueReader({ now: () => clock });
  const [first] = reader.read([work.persona]);
  assert.equal(first?.entries.length, 1);
  assert.equal(first.heldSince, null);

  // A write caught mid-save: truncated JSON, the shape a store written whole with no rename leaves
  // on disk for the instant between the open and the last byte.
  clock = 5_000;
  work.storeText('{"dev-plugin": {"goals": [{"id": "goal-1", "titl');
  const [torn] = reader.read([work.persona]);
  assert.deepEqual(torn?.entries, first.entries, "the held entries survive a torn write");
  assert.equal(torn.heldSince, 5_000);

  clock = 9_000;
  const [stillTorn] = reader.read([work.persona]);
  assert.equal(stillTorn?.heldSince, 5_000, "the hold instant is when it began, not when it was read");

  clock = 11_000;
  work.store(store([goal({ title: "Second" })]));
  const [recovered] = reader.read([work.persona]);
  assert.equal(recovered?.entries[0]?.title, "Second");
  assert.equal(recovered.heldSince, null, "a good read clears the hold");
});

test("a store with no key for the persona yields no entries, no hold and no failure", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store({ "another-worker": { goals: [goal()] } });

  const lines: string[] = [];
  const [queue] = createQueueReader({ log: (line) => lines.push(line) }).read([work.persona]);
  assert.deepEqual(queue?.entries, []);
  assert.equal(queue.activeGoalId, null);
  assert.equal(queue.lastTurnComplete, null);
  assert.equal(queue.heldSince, null);
  assert.deepEqual(lines.filter((line) => line.includes("persona store")), []);
});

test("a persona whose store has never been read holds nothing and reports no hold instant", (t) => {
  const work = workdir();
  t.after(work.cleanup);

  const reader = createQueueReader({ now: () => 7_000 });
  const [queue] = reader.read([work.persona]);
  assert.deepEqual(queue?.entries, []);
  assert.equal(
    queue.heldSince,
    null,
    "a folder that has never had a store is not a stale reading, it is an empty one",
  );
});

test("a store over the byte cap yields the held reading rather than its prefix", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(store([goal({ title: "held" })]));

  const reader = createQueueReader();
  const [first] = reader.read([work.persona]);
  assert.equal(first?.entries[0]?.title, "held");

  // The padded store is valid JSON carrying a second entry, so an unenforced cap would return two
  // entries here: the assertion below only speaks because the two readings actually differ.
  work.store(
    store([goal({ title: "held" }), goal({ id: "goal-2", title: "x".repeat(MAX_STORE_FILE_BYTES) })]),
  );
  const [capped] = reader.read([work.persona]);
  assert.deepEqual(capped?.entries, first.entries);
});

test("a store that has not moved is not read again", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = path.join(work.dir, STORE_FILE_NAME);
  // A whole-millisecond stamp the fixture sets itself, rather than one read back off the file: a
  // filesystem timestamp carries finer-grained ticks than a Date can restore, so a stamp taken from
  // the file and written back is not the stamp that was there.
  const frozen = new Date(Date.now() - 60_000);
  work.store(store([goal({ title: "AAAA" })]));
  utimesSync(file, frozen, frozen);
  const size = statSync(file).size;

  const reader = createQueueReader();
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");

  // Same byte count, same modification time, different content: a reader that opened the file again
  // would return the new title. The hold is keyed on the stat, so it returns the old one.
  work.store(store([goal({ title: "BBBB" })]));
  utimesSync(file, frozen, frozen);
  assert.equal(statSync(file).size, size, "the fixture must not change the file's size");
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");

  // Moving the file is what makes it read again.
  const moved = new Date(frozen.getTime() + 2_000);
  utimesSync(file, moved, moved);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "BBBB");
});

test("a plan document that has not moved is not opened again", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(store([goal({ planPath: "a_b_v1.md" })]));

  const seam = seams();
  const reader = createQueueReader(seam.options);
  reader.read([work.persona]);
  assert.deepEqual(seam.opened, [file]);

  // The store is rewritten so its own hold does not decide this, and the plan doc is left alone.
  work.store(store([goal({ planPath: "a_b_v1.md", title: "Moved on" })]));
  const [second] = reader.read([work.persona]);
  assert.deepEqual(seam.opened, [file], "an unmoved plan doc costs a stat, not a read");
  assert.equal(second?.readings.get("goal-1")?.archived, false);
});

test("a store that is not an object clears the held entries rather than keeping them", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(store([goal({ title: "held" })]));

  const lines: string[] = [];
  const reader = createQueueReader({ log: (line) => lines.push(line) });
  assert.equal(reader.read([work.persona])[0]?.entries.length, 1);

  // A torn write of a JSON object cannot land as a valid JSON array, so this is a mistake in what
  // wrote the store rather than a write in progress.
  work.storeText(JSON.stringify([{ goals: [] }]));
  const [queue] = reader.read([work.persona]);
  assert.deepEqual(queue?.entries, []);
  assert.equal(queue.heldSince, null);
  assert.ok(lines.some((line) => line.includes("not an object")));
});

test("the heartbeat's turn state rides out, and an absent heartbeat is outside a turn", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(store([goal()], { activeGoalId: "goal-1", monitor: { lastTurnComplete: 42 } }));

  const reader = createQueueReader();
  const [none] = reader.read([work.persona]);
  assert.equal(none?.turnStartedAt, null);
  assert.equal(none.activeGoalId, "goal-1");
  assert.equal(none.lastTurnComplete, 42);

  work.heartbeat({ [PERSONA]: { sessionId: "s", epoch: 6, lastSeen: 9, turnStartedAt: null } });
  assert.equal(reader.read([work.persona])[0]?.turnStartedAt, null);

  // The turn's start is written at a byte count the null above does not share, because the file is
  // held on its size as well as its modification time and a filesystem timestamp is granular enough
  // that two writes a test apart can carry the same one.
  work.heartbeat({ [PERSONA]: { sessionId: "s", epoch: 6, lastSeen: 9, turnStartedAt: 1_234_567 } });
  assert.equal(reader.read([work.persona])[0]?.turnStartedAt, 1_234_567);
});

test("queue order is sortKey then createdAt, and the entry cap keeps the first in that order", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const goals = [
    goal({ id: "late", createdAt: 900 }),
    // Its own createdAt would place it second; its sortKey places it third, which is the only
    // ordering that says the sortKey was read at all.
    goal({ id: "keyed", createdAt: 100, sortKey: 1_000 }),
    goal({ id: "early", createdAt: 3 }),
    goal({ id: "keyless", createdAt: undefined }),
  ];
  work.store(store(goals));

  const [queue] = createQueueReader().read([work.persona]);
  assert.deepEqual(
    queue?.entries.map((entry) => entry.id),
    ["early", "late", "keyed", "keyless"],
    "a sortKey stands in for createdAt, and an entry with neither sorts last",
  );

  const many = Array.from({ length: MAX_QUEUE_ENTRIES + 5 }, (_, index) =>
    goal({ id: `g-${String(index)}`, createdAt: index }),
  );
  work.store(store(many.slice().reverse()));
  const [capped] = createQueueReader().read([work.persona]);
  assert.equal(capped?.entries.length, MAX_QUEUE_ENTRIES);
  assert.deepEqual(
    capped.entries.map((entry) => entry.id),
    many.slice(0, MAX_QUEUE_ENTRIES).map((entry) => entry.id),
  );
});

test("a field of the wrong type draws as absent, and an entry with no id is no entry", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(
    store([
      goal({
        id: "typed",
        title: 7,
        status: ["blocked"],
        pausedByNudgeCap: "true",
        sortKey: "3",
        lead: { state: "blocked", reason: 9 },
      }),
      { kind: "plan", title: "no id at all" },
      "not an object",
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  assert.equal(queue?.entries.length, 1);
  const entry = queue.entries[0];
  assert.equal(entry?.id, "typed");
  assert.equal(entry.title, "");
  assert.equal(entry.status, undefined);
  assert.equal(entry.pausedByNudgeCap, undefined);
  assert.equal(entry.sortKey, undefined);
  assert.deepEqual(entry.lead, { state: "blocked", reason: undefined });
});

// The intake caps. A store field can arrive as the whole of what the file cap allows, and everything
// downstream of this reader walks those values on every refresh tick while this reader parses them
// only when the file moves. The two tests below pin the bound at the one place it is applied.

test("a store field arrives collapsed, trimmed and cut at its own intake cap", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const over = 500;
  work.store(
    store([
      goal({
        id: "wide",
        title: "t".repeat(MAX_INTAKE_TITLE_LENGTH + over),
        kind: "k".repeat(MAX_INTAKE_WORD_LENGTH + over),
        status: "s".repeat(MAX_INTAKE_WORD_LENGTH + over),
        blockedReason: "r".repeat(MAX_INTAKE_REASON_LENGTH + over),
        lead: { state: "blocked", reason: "l".repeat(MAX_INTAKE_REASON_LENGTH + over) },
      }),
      goal({
        id: "ordinary",
        title: "  Reviewer\n\tre-ranking  ",
        blockedReason: "Waiting on  two operator forks",
      }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  const wide = queue?.entries.find((entry) => entry.id === "wide");
  assert.equal(wide?.title, "t".repeat(MAX_INTAKE_TITLE_LENGTH));
  assert.equal(wide.kind, "k".repeat(MAX_INTAKE_WORD_LENGTH));
  assert.equal(wide.status, "s".repeat(MAX_INTAKE_WORD_LENGTH));
  assert.equal(wide.blockedReason, "r".repeat(MAX_INTAKE_REASON_LENGTH));
  assert.equal(wide.lead?.reason, "l".repeat(MAX_INTAKE_REASON_LENGTH));

  const ordinary = queue?.entries.find((entry) => entry.id === "ordinary");
  assert.equal(
    ordinary?.title,
    "Reviewer re-ranking",
    "a run of whitespace collapses to one space and the ends are trimmed",
  );
  assert.equal(
    ordinary.blockedReason,
    "Waiting on two operator forks",
    "a value inside its cap is otherwise the value the store wrote",
  );
});

test("an oversized field is cut on code points, and a field the store left out stays out", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(
    store([
      // An astral character takes two UTF-16 units, so a cut made on units would leave the last one
      // as half of itself and hand the card a lone surrogate.
      goal({ id: "astral", title: "\u{1f4a5}".repeat(MAX_INTAKE_TITLE_LENGTH + 100) }),
      goal({ id: "sparse", title: "", status: "   " }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  const astral = queue?.entries.find((entry) => entry.id === "astral");
  assert.equal(astral?.title, "\u{1f4a5}".repeat(MAX_INTAKE_TITLE_LENGTH));
  assert.doesNotMatch(astral.title, /[\ud800-\udfff]/u, "no character is left as half of itself");

  const sparse = queue?.entries.find((entry) => entry.id === "sparse");
  assert.equal(sparse?.title, "", "a field the store wrote empty is present and empty still");
  assert.equal(sparse.status, "", "a field of nothing but whitespace says nothing and is there");
  assert.equal(sparse.blockedReason, undefined, "a field the store never wrote stays absent");
});

test("two goals sharing an id take one reading between them, and it is the first goal's", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // Both documents exist, so the second entry going without a reading is the duplicate rule rather
  // than its own document being absent.
  const first = work.file(["docs", "plans"], "first_v1.md", planDoc());
  work.file(["docs", "plans"], "second_v1.md", planDoc("Ready"));
  work.store(
    store([
      goal({ id: "shared", createdAt: 1_000, planPath: "first_v1.md" }),
      goal({ id: "shared", createdAt: 2_000, planPath: "second_v1.md" }),
    ]),
  );

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  assert.equal(queue?.entries.length, 2, "both goals are entries, and only the id is shared");
  assert.equal(queue.readings.size, 1, "one id carries one reading");
  assert.equal(
    live(queue.readings.get("shared")).path,
    first,
    "the later entry does not lend its document to the earlier one",
  );
  assert.deepEqual(seam.opened, [first], "the duplicate's own document is not opened at all");
});

test("a read failure logs its class once per change, and no logged line is path-shaped", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  work.store(store([goal()]));

  const lines: string[] = [];
  const reader = createQueueReader({ log: (line) => lines.push(line) });
  reader.read([work.persona]);
  const before = lines.length;

  rmSync(path.join(work.dir, STORE_FILE_NAME));
  reader.read([work.persona]);
  reader.read([work.persona]);
  assert.equal(lines.length, before + 1, "the same failure class is not logged again while it lasts");
  assert.ok(lines[before]?.includes("unreadable"));

  // An absence check over the class rather than over this fixture's own literals: no logged line may
  // carry a path separator, since a workdir, a store path and a plan path each carry one of the two
  // slash spellings whatever the operator named them.
  for (const line of lines) {
    assert.ok(!/[\\/]/.test(line), `a logged line must never be path-shaped: ${line}`);
  }
});

test("a plan document that fails to parse keeps its held parse, whole, and is not opened again", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(store([goal({ planPath: "a_b_v1.md" })]));

  const seam = seams();
  const reader = createQueueReader(seam.options);
  const good = reader.read([work.persona])[0]?.readings.get("goal-1");
  assert.ok(good !== undefined && !good.archived);
  assert.equal(good.sections, 2);
  const parsedAt = statSync(file);

  // The document caught mid-write: no `Status:` header above its first `##` heading, which is the
  // one shape `parsePlan` gives no reading for at all.
  work.file(["docs", "plans"], "a_b_v1.md", "## Sections of Work\n\n### 1. The reader\n");
  const torn = statSync(file);
  assert.notEqual(torn.size, parsedAt.size, "the document has really moved off the parsed stat");
  const reading = reader.read([work.persona])[0]?.readings.get("goal-1");
  assert.ok(reading !== undefined && !reading.archived, "a torn document keeps its last good parse");
  assert.equal(reading.sections, 2, "the contract fields come from the hold");
  assert.equal(reading.completed, 1);
  assert.equal(reading.next, "2. The renderer");
  // The stat fields come from the hold as well. A held parse's status describes the bytes it was
  // read from, so under the current document's modification time it would outrank a genuinely
  // newer document in the card's in-flight rule and draw the wrong entry as running.
  assert.equal(reading.mtimeMs, parsedAt.mtimeMs, "the stat is the one the parse was taken at");
  assert.equal(reading.sizeBytes, parsedAt.size);
  assert.deepEqual(seam.opened, [file, file]);

  // Nothing has moved since the failure, so the document is not opened again: a document that
  // failed to parse at a stat fails to parse at that stat every time, and learning that by reading
  // it costs the whole file on every refresh tick and once per entry that names it.
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).sections, 2);
  assert.deepEqual(seam.opened, [file, file], "a failure that has not moved costs a stat, not a read");

  work.file(["docs", "plans"], "a_b_v1.md", planDoc("Complete"));
  const fresh = reader.read([work.persona])[0]?.readings.get("goal-1");
  assert.ok(fresh !== undefined && !fresh.archived);
  assert.equal(fresh.status, "Complete", "a document that parses again replaces the hold");
  assert.deepEqual(seam.opened, [file, file, file], "a document that moves is read again");
});

test("a plan document that fails to read keeps its held parse too", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(store([goal({ planPath: "a_b_v1.md" })]));

  let refuse = false;
  const opened: string[] = [];
  const reader = createQueueReader({
    readPlan: (target) => {
      opened.push(target);
      return refuse ? { failed: "unreadable" } : readPlanFile(target);
    },
  });
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).sections, 2);
  const parsedAt = statSync(file);

  // The document moves, so the hold's stat no longer matches and the read is attempted, and the
  // read is what fails: a permission refusal, or the file taken away between the stat and the open.
  refuse = true;
  work.file(["docs", "plans"], "a_b_v1.md", planDoc("Ready"));
  assert.notEqual(statSync(file).size, parsedAt.size, "the document has really moved");
  const reading = reader.read([work.persona])[0]?.readings.get("goal-1");
  assert.ok(reading !== undefined && !reading.archived);
  assert.equal(reading.status, "In Progress", "the last good parse rides out the failed read");
  // The held parse's own stat, not the document's current one, so the stale status cannot wear a
  // fresh modification time and outrank a document that really is newer.
  assert.equal(reading.mtimeMs, parsedAt.mtimeMs);
  assert.equal(reading.sizeBytes, parsedAt.size);
  assert.deepEqual(opened, [file, file]);

  // An open the environment refused says nothing about the bytes at that stat, so the document is
  // opened again on the next tick although nothing about it has moved.
  refuse = false;
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).status, "Ready");
  assert.deepEqual(opened, [file, file, file], "a refused open is retried, not held on its stat");
});

test("two entries naming one document read and parse it once for the tick", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(
    store([
      goal({ id: "one", planPath: "a_b_v1.md" }),
      goal({ id: "two", createdAt: 2_000, planPath: "docs/plans/a_b_v1.md" }),
    ]),
  );

  const seam = seams();
  const reader = createQueueReader(seam.options);
  const [queue] = reader.read([work.persona]);
  assert.equal(queue?.readings.size, 2, "both entries join to the one document");
  assert.deepEqual(seam.opened, [file], "the second entry folds in the first entry's own parse");

  // The same again on a tick where the document has moved since the last one, which is the case the
  // previous tick's hold cannot answer and the in-tick one must.
  work.file(["docs", "plans"], "a_b_v1.md", planDoc("Ready"));
  const [second] = reader.read([work.persona]);
  assert.equal(live(second?.readings.get("two")).status, "Ready");
  assert.deepEqual(seam.opened, [file, file]);
});

test("three entries naming one failing document open it once for the tick", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  // Three, not two: a fold that covers only the first repeat passes a two-entry version of this.
  work.store(
    store([
      goal({ id: "one", planPath: "a_b_v1.md" }),
      goal({ id: "two", createdAt: 2_000, planPath: "a_b_v1.md" }),
      goal({ id: "three", createdAt: 3_000, objective: "Finish docs/plans/a_b_v1.md, then stop" }),
    ]),
  );

  let refuse = false;
  const opened: string[] = [];
  const reader = createQueueReader({
    readPlan: (target) => {
      opened.push(target);
      return refuse ? { failed: "unreadable" } : readPlanFile(target);
    },
  });
  const [first] = reader.read([work.persona]);
  assert.equal(first?.readings.size, 3, "all three entries join to the one document");
  assert.deepEqual(opened, [file]);

  // The document has moved since that tick, so no hold answers for its stat, and the read is what
  // fails. Every entry after the first must fold in on the failure the way it folds in on a parse.
  refuse = true;
  work.file(["docs", "plans"], "a_b_v1.md", planDoc("Ready"));
  const [second] = reader.read([work.persona]);
  for (const id of ["one", "two", "three"]) {
    assert.equal(live(second?.readings.get(id)).sections, 2, `${id} draws the held parse`);
  }
  assert.deepEqual(opened, [file, file], "the failing document is opened once for the whole tick");
});

test("a held reading carries the stat it parsed at, so a newer document still reads as newer", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const held = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  const rival = work.file(["docs", "plans"], "c_d_v1.md", planDoc());
  work.store(
    store([
      goal({ id: "held", planPath: "a_b_v1.md" }),
      goal({ id: "rival", createdAt: 2_000, planPath: "c_d_v1.md" }),
    ]),
  );

  // Whole-millisecond stamps the fixture sets itself, a second apart, so which document is newer is
  // the fixture's choice rather than the order two writes happened to land in.
  const base = Date.now() - 60_000;
  const parsedAt = new Date(base);
  const rivalAt = new Date(base + 1_000);
  const tornAt = new Date(base + 2_000);
  utimesSync(held, parsedAt, parsedAt);
  utimesSync(rival, rivalAt, rivalAt);
  const parsedSize = statSync(held).size;

  const seam = seams();
  const reader = createQueueReader(seam.options);
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("held")).mtimeMs, base);

  // The held document is torn, and its torn write is now the newest file on disk. The card's
  // in-flight rule picks the newest document among the entries reading `In Progress`, so a held
  // parse wearing this modification time would take that place from the document that earned it.
  work.file(["docs", "plans"], "a_b_v1.md", "## Sections of Work\n\n### 1. The reader\n");
  utimesSync(held, tornAt, tornAt);
  const [second] = reader.read([work.persona]);
  const stale = live(second?.readings.get("held"));
  const fresh = live(second?.readings.get("rival"));
  assert.equal(stale.status, "In Progress", "the entry is drawn from the held parse");
  assert.equal(stale.mtimeMs, parsedAt.getTime(), "under the stat that parse was taken at");
  assert.equal(stale.sizeBytes, parsedSize);
  assert.equal(statSync(held).mtimeMs, tornAt.getTime(), "the document itself is the newest on disk");
  assert.ok(fresh.mtimeMs > stale.mtimeMs, "the document that really is newer ranks newer");
});

test("a plan document that parses again clears the stat its failure was held at", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(store([goal({ planPath: "a_b_v1.md" })]));

  // Three texts of one byte length, and whole-millisecond stamps the fixture sets itself, so the
  // stat is the modification time alone and a reader honouring it cannot see the content change.
  const sized = planDoc("Ready");
  const torn = "## Sections of Work\n\n### 1. The reader\n".padEnd(sized.length, "\n");
  const repaired = sized.replaceAll("renderer", "reviewer");
  assert.equal(torn.length, sized.length);
  assert.equal(repaired.length, sized.length);
  const failedAt = new Date(Date.now() - 60_000);
  const later = new Date(failedAt.getTime() + 2_000);

  const seam = seams();
  const reader = createQueueReader(seam.options);
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).status, "In Progress");

  work.file(["docs", "plans"], "a_b_v1.md", torn);
  utimesSync(file, failedAt, failedAt);
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).status, "In Progress");
  assert.equal(seam.opened.length, 2);

  // The document moves and parses, which is what clears the stat the failure was recorded at.
  work.file(["docs", "plans"], "a_b_v1.md", sized);
  utimesSync(file, later, later);
  assert.equal(live(reader.read([work.persona])[0]?.readings.get("goal-1")).status, "Ready");
  assert.equal(seam.opened.length, 3);

  // Back on that exact stat, with content that parses. A failure stat left standing through the
  // success above would refuse this read and redraw the parse the tick before it.
  work.file(["docs", "plans"], "a_b_v1.md", repaired);
  utimesSync(file, failedAt, failedAt);
  const reading = live(reader.read([work.persona])[0]?.readings.get("goal-1"));
  assert.equal(reading.next, "2. The reviewer", "a repaired document at that stat is read again");
  assert.equal(seam.opened.length, 4);
});

test("a store whose open was refused is opened again, one its own bytes failed is not", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = path.join(work.dir, STORE_FILE_NAME);
  const valid = (title: string): string => JSON.stringify(store([goal({ title })]));
  work.storeText(valid("AAAA"));

  // The read seam, because an open the machine refuses cannot be staged on disk: a sharing
  // violation while a scanner holds the file, or a process out of descriptors. Neither moves the
  // file and neither says anything about the bytes at its stat.
  let outcome: { failed: "unreadable" } | { text: string } | null = null;
  const opened: string[] = [];
  const reader = createQueueReader({
    readStore: (target) => {
      opened.push(target);
      return outcome ?? { text: readFileSync(target, "utf8") };
    },
  });

  // Whole-millisecond stamps the fixture sets itself, so every move below is one the reader sees.
  const stamps = [0, 1, 2, 3].map((step) => new Date(Date.now() - 60_000 + step * 1_000));
  const move = (step: number): void => utimesSync(file, stamps[step]!, stamps[step]!);
  move(0);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");
  assert.deepEqual(opened, [file]);

  outcome = { failed: "unreadable" };
  move(1);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA", "the held reading stands");
  assert.equal(opened.length, 2);

  // Nothing has moved since that refusal, and the file is opened again anyway: holding it on its
  // stat would freeze the whole group's reading for as long as the broker ran, since the file that
  // was never the problem need never move again.
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");
  assert.equal(opened.length, 3, "an open the machine refused is retried on the next tick");

  // The other class at the same seam: a body that does not parse is a fact about the bytes at that
  // stat, so the tick after it spends a stat rather than the whole file learning it again.
  outcome = { text: valid("BBBB").slice(0, -1) };
  move(2);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");
  assert.equal(opened.length, 4);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");
  assert.equal(opened.length, 4, "a file that has not moved since its bytes failed is not opened");

  // It is read again once it moves, which is what keeps that hold from being permanent.
  outcome = null;
  work.storeText(valid("CCCC"));
  move(3);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "CCCC");
  assert.equal(opened.length, 5);
});

test("an empty or blank planPath is no planPath, and the entry's text is searched", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(
    store([
      goal({ id: "empty", planPath: "", objective: "Finish docs/plans/a_b_v1.md, which is open" }),
      goal({
        id: "blank",
        createdAt: 2_000,
        planPath: "   ",
        objective: "Finish docs/plans/a_b_v1.md, which is open",
      }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  for (const id of ["empty", "blank"]) {
    const reading = queue?.readings.get(id);
    assert.ok(reading !== undefined && !reading.archived, `${id} must fall back to its own text`);
    assert.equal(reading.path, file);
  }
});

test("a planPath padded with space is trimmed to the name it holds", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  // The document the text names exists too, so the reading below is the padded field being used
  // rather than the fallback running: a field that names something is the answer on its own.
  work.file(["docs", "plans"], "from_text_v1.md", planDoc("Ready"));
  work.store(
    store([
      goal({
        planPath: " a_b_v1.md ",
        objective: "See docs/plans/from_text_v1.md for the background",
      }),
    ]),
  );

  const reading = live(createQueueReader().read([work.persona])[0]?.readings.get("goal-1"));
  assert.equal(reading.path, file);
  assert.equal(reading.status, "In Progress", "the text's document is the Ready one");
});

test("the title is searched before the objective, with both documents on disk", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // Both documents exist, which is the whole point: with only one on disk this passes under either
  // search order, because the other name finds nothing wherever it is looked for.
  const fromTitle = work.file(["docs", "plans"], "from_title_v1.md", planDoc("Ready"));
  work.file(["docs", "plans"], "from_objective_v1.md", planDoc("Complete"));
  work.store(
    store([
      goal({
        title: "Ship docs/plans/from_title_v1.md, then stop",
        objective: "See docs/plans/from_objective_v1.md for the background",
      }),
    ]),
  );

  const reading = createQueueReader().read([work.persona])[0]?.readings.get("goal-1");
  assert.ok(reading !== undefined && !reading.archived);
  assert.equal(reading.path, fromTitle);
  assert.equal(reading.status, "Ready", "the objective's document is the Complete one");
});

test("a plan path past where the title's intake cap cuts still joins", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  const title = `${"t".repeat(MAX_INTAKE_TITLE_LENGTH + 10)} docs/plans/a_b_v1.md, then stop`;
  work.store(store([goal({ title })]));

  const [queue] = createQueueReader().read([work.persona]);
  const reading = live(queue?.readings.get("goal-1"));
  assert.equal(reading.path, file, "the name is searched for before the title is cut");
  assert.equal(queue?.entries[0]?.title, "t".repeat(MAX_INTAKE_TITLE_LENGTH), "the card's copy is cut");
});

test("a plan path deep in a long objective still joins", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  // Live stores carry objectives of several hundred characters with the plan path near the end and
  // no planPath at all, so the text search is the only join such an entry has.
  const objective = `${"Work through the queue. ".repeat(40)}Finish docs/plans/a_b_v1.md, then stop.`;
  work.store(store([goal({ objective })]));

  const reading = live(createQueueReader().read([work.persona])[0]?.readings.get("goal-1"));
  assert.equal(reading.path, file);
});

test("a title or objective of the wrong type names no plan, and the other is still searched", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(
    store([
      goal({ id: "numeric-title", title: 7, objective: "Finish docs/plans/a_b_v1.md, then stop" }),
      goal({
        id: "listed-objective",
        createdAt: 2_000,
        title: "Ship docs/plans/a_b_v1.md, then stop",
        objective: ["docs/plans/other_v1.md"],
      }),
      goal({ id: "neither", createdAt: 3_000, title: 7, objective: { path: "docs/plans/a_b_v1.md" } }),
    ]),
  );

  const [queue] = createQueueReader().read([work.persona]);
  assert.equal(live(queue?.readings.get("numeric-title")).path, file);
  assert.equal(live(queue?.readings.get("listed-objective")).path, file);
  assert.equal(queue?.readings.has("neither"), false, "a value that is not a string is not text");
  assert.equal(queue?.entries.length, 3, "a field of the wrong type drops the field, not the entry");
});

test("a planPath whose last segment fails the pattern falls back to nothing at all", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // The document the text names exists, so the refusal below is the no-fallback rule rather than
  // the fallback running and finding nothing.
  work.file(["docs", "plans"], "a_b_v1.md", planDoc());
  work.store(
    store([goal({ planPath: "notes/design.txt", title: "Ship docs/plans/a_b_v1.md, then stop" })]),
  );

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  assert.equal(queue?.readings.size, 0, "one field is the answer, and it is not a usable name");
  assert.deepEqual(seam.statted, []);
  assert.deepEqual(seam.opened, []);
});

test("a planPath that names no last segment falls back to nothing at all", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // The document the text names exists, so a reading appearing below is the text search running
  // for an entry that carries the field, which is the state this case exists to refuse. A value
  // that reduces to no segment is a field that is there and names nothing, which is not the same
  // as a field that is absent, and only the absent one is searched for a second name.
  work.file(["docs", "plans"], "a_b_v1.md", planDoc());

  const unreducible = [
    "..\\..\\",
    // Withheld members, matched on the class's shape rather than on a spelling the reduction was
    // written against: the other separator, a single climb, a bare root, and a real folder path.
    "../../",
    "..\\",
    "/",
    "docs/plans/",
  ];

  for (const planPath of unreducible) {
    const seam = seams();
    work.store(store([goal({ planPath, title: "Ship docs/plans/a_b_v1.md, then stop" })]));
    const [queue] = createQueueReader(seam.options).read([work.persona]);

    assert.equal(queue?.readings.size, 0, `${planPath} must yield no reading and search no text`);
    assert.deepEqual(seam.statted, [], `${planPath} must build no path`);
    assert.deepEqual(seam.opened, [], `${planPath} must open nothing`);
  }

  // Control: the same entry with no field at all does search its text and finds that document, so
  // the refusals above are the field being present and naming nothing rather than the text search
  // being broken for every entry in this fixture.
  const seam = seams();
  work.store(store([goal({ title: "Ship docs/plans/a_b_v1.md, then stop" })]));
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  assert.equal(live(queue?.readings.get("goal-1")).stem, "a_b_v1");
});

test("a README name is refused in every case the name pattern admits", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  // Both spellings exist on disk. On a filesystem that folds case they are one file answering to
  // both names, which is all this needs: neither refusal below can be the document being absent.
  work.file(["docs", "plans"], "readme.md", planDoc());
  work.file(["docs", "plans"], "Readme.md", planDoc());
  work.store(
    store([
      // `PLAN_NAME` admits all three, so each one reaches the README rule and is refused there on
      // the case-folded stem.
      goal({ id: "lower", planPath: "readme.md" }),
      goal({ id: "capital", createdAt: 2_000, planPath: "Readme.md" }),
      goal({ id: "from-text", createdAt: 3_000, objective: "See docs/plans/readme.md for the list" }),
    ]),
  );

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  assert.equal(queue?.entries.length, 3);
  assert.equal(queue.readings.size, 0, "a directory index is not a piece of open work");
  assert.deepEqual(seam.statted, [], "a refused name is refused before any path is built");
  assert.deepEqual(seam.opened, []);

  // Control, withheld from the rule's own literal: a name the README rule must not reach, matched
  // on the class's shape rather than on the spelling the rule was written against.
  const plan = work.file(["docs", "plans"], "readme-rework_v1.md", planDoc());
  work.store(store([goal({ id: "rework", planPath: "readme-rework_v1.md" })]));
  const control = seams();
  const [again] = createQueueReader(control.options).read([work.persona]);
  assert.equal(again?.readings.get("rework")?.archived, false);
  assert.deepEqual(control.opened, [plan]);
});

test("a plan name whose `.md` suffix is upper case is a plan name, as it is to the sweep", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = work.file(["docs", "plans"], "a_b_v1.MD", planDoc());
  // Through `planPath`, because the text search matches the suffix in lower case alone: an
  // upper-case suffix reaches the name pattern from that field only.
  work.store(store([goal({ planPath: "a_b_v1.MD" })]));

  const seam = seams();
  const [queue] = createQueueReader(seam.options).read([work.persona]);
  const reading = live(queue?.readings.get("goal-1"));
  assert.equal(reading.path, file);
  assert.equal(reading.stem, "a_b_v1", "the stem is what is left once the suffix folds case");
  assert.equal(reading.status, "In Progress");
  assert.deepEqual(seam.opened, [file]);
});

test("a store that failed at a stat it still carries is not opened again", (t) => {
  const work = workdir();
  t.after(work.cleanup);
  const file = path.join(work.dir, STORE_FILE_NAME);
  // Whole-millisecond stamps the fixture sets itself, since a filesystem timestamp carries finer
  // ticks than a Date can restore. Every text below is written to one byte length, so the stat is
  // the modification time alone and content changes are invisible to a reader that honours it.
  const frozen = new Date(Date.now() - 60_000);
  const moved = new Date(frozen.getTime() + 2_000);
  const valid = (title: string): string => JSON.stringify(store([goal({ title })]));
  const torn = `${valid("BBBB").slice(0, -1)} `;

  let clock = 1_000;
  const lines: string[] = [];
  const reader = createQueueReader({ now: () => clock, log: (line) => lines.push(line) });
  work.storeText(valid("AAAA"));
  utimesSync(file, frozen, frozen);
  assert.equal(reader.read([work.persona])[0]?.entries[0]?.title, "AAAA");

  // A write caught mid-save, at a modification time of its own.
  clock = 5_000;
  work.storeText(torn);
  utimesSync(file, moved, moved);
  const [failed] = reader.read([work.persona]);
  assert.equal(failed?.entries[0]?.title, "AAAA", "the held entries survive the torn write");
  assert.equal(failed.heldSince, 5_000);
  assert.equal(lines.filter((line) => line.includes("unparseable")).length, 1);

  // Valid content of that same byte length, at that same modification time: a reader that opened
  // the file again would return "CCCC". The failure is held on its stat, so it does not.
  clock = 9_000;
  work.storeText(valid("CCCC"));
  utimesSync(file, moved, moved);
  const [again] = reader.read([work.persona]);
  assert.equal(again?.entries[0]?.title, "AAAA", "a file that has not moved since it failed is not read");
  assert.equal(again.heldSince, 5_000, "the hold is still a hold, and it began when the failure did");
  assert.equal(
    lines.filter((line) => line.includes("unparseable")).length,
    1,
    "one failure logged once, not once per tick",
  );

  // The file moves, so it is read: the failure's stat is not the hold's stat, and a stale reading
  // never looks current to the hold's own short-circuit.
  const later = new Date(moved.getTime() + 2_000);
  utimesSync(file, later, later);
  const [recovered] = reader.read([work.persona]);
  assert.equal(recovered?.entries[0]?.title, "CCCC");
  assert.equal(recovered.heldSince, null);

  // Back to the exact stat the failure was recorded at, with content that parses. A failure stat
  // left standing through the success above would refuse this read and redraw "CCCC".
  work.storeText(valid("DDDD"));
  utimesSync(file, moved, moved);
  assert.equal(
    reader.read([work.persona])[0]?.entries[0]?.title,
    "DDDD",
    "a success clears the failure's stat, so a repaired file is read",
  );
});

test("two personas hold their readings apart, and a persona leaving the roster drops its hold", (t) => {
  const first = workdir();
  const second = workdir();
  t.after(first.cleanup);
  t.after(second.cleanup);
  const other: RosterPersona = { name: PERSONA, workdir: second.dir };
  first.store(store([goal({ title: "first" })]));
  second.store(store([goal({ title: "second" })]));

  const reader = createQueueReader();
  const queues = reader.read([first.persona, other]);
  assert.deepEqual(
    queues.map((queue) => queue.entries[0]?.title),
    ["first", "second"],
  );

  // The second persona leaves the roster, then returns with its store torn: a reader still holding
  // its old reading would redraw the old entries, which is what a dropped hold prevents.
  reader.read([first.persona]);
  second.storeText('{"dev-plugin": {"goals": [{"id": "goal-1", "titl');
  const [, returned] = reader.read([first.persona, other]);
  assert.deepEqual(returned?.entries, []);
  assert.equal(returned.heldSince, null);
});
