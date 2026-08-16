import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_INTAKE_NEXT_LENGTH,
  MAX_INTAKE_STATUS_LENGTH,
  MAX_PLANS_PER_ROOT,
  MAX_PLAN_FILE_BYTES,
  parsePlan,
  sweepPlans,
} from "./plans.ts";
import type { PlanDirectoryListing, PlanSweep } from "./plans.ts";

// Every fixture here is a synthetic plan doc. The rules under test are the kit's frozen v1 machine
// contract, which an external engine parses from the same files, so a test that let a value close a
// section the engine leaves open would be locking in a card that lies.

/** A plan doc with one two-section block and one Chapter, as the pieces each test varies. */
function plan(parts: { status?: string; sections?: string; chapters?: string } = {}): string {
  return [
    "# A plan",
    "",
    `Status: ${parts.status ?? "In Progress"}`,
    "Commit Model: Commit-and-Push",
    "",
    "## Sections of Work",
    "",
    parts.sections ?? ["### 1. The reader", "Model: opus", "", "### 2. The renderer", "Model: opus"].join("\n"),
    "",
    "## Chapters",
    "",
    parts.chapters ?? "",
    "",
  ].join("\n");
}

type Scratch = {
  root: string;
  write: (name: string, text: string) => string;
  cleanup: () => void;
};

function scratch(): Scratch {
  const root = mkdtempSync(path.join(os.tmpdir(), "channels-board-"));
  const plans = path.join(root, "docs", "plans");
  mkdirSync(plans, { recursive: true });
  return {
    root,
    write: (name, text) => {
      const file = path.join(plans, name);
      writeFileSync(file, text, "utf8");
      return file;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * One caller of the sweep that holds its directory listings the way the board card does: handed to
 * each sweep and rebuilt from what that sweep returned, so the hold belongs to this sweeper alone.
 */
function sweeping(roots: readonly string[]): { sweep: () => PlanSweep } {
  let listings = new Map<string, PlanDirectoryListing>();
  return {
    sweep: () => {
      const previous = listings;
      const swept = sweepPlans(roots, {
        heldListing: (dir, mtimeMs) => {
          const listed = previous.get(dir);
          return listed === undefined || listed.mtimeMs !== mtimeMs ? undefined : listed;
        },
      });
      listings = new Map(swept.listings.map((listed) => [listed.dir, listed]));
      return swept;
    },
  };
}

/**
 * The stat a failure comes back carrying, which is the file's own. A caller holds it to tell whether
 * a file has moved since it failed, and skips the read of one that has not.
 */
function statOf(file: string): { mtimeMs: number; sizeBytes: number } {
  const stat = statSync(file);
  return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
}

test("Complete terminates only as the whole string, and the raw status always rides out", () => {
  for (const [status, terminal] of [
    ["Complete", true],
    ["complete", true],
    ["  Complete  ", true],
    ["Complete (archived)", false],
    ["Completed", false],
    ["In Progress", false],
    ["Draft", false],
  ] as const) {
    const parsed = parsePlan(plan({ status }));
    assert.ok(parsed, `parsed ${status}`);
    assert.equal(parsed.terminal, terminal, `terminal for ${status}`);
    assert.equal(parsed.status, status.trim(), `raw status for ${status}`);
  }
});

test("the status read is the first one above the first ## heading", () => {
  const parsed = parsePlan(
    ["# A plan", "", "Status: Draft", "Status: Complete", "", "## Sections of Work", ""].join("\n"),
  );
  assert.ok(parsed);
  assert.equal(parsed.status, "Draft");
  assert.equal(parsed.terminal, false);
});

test("a doc whose only Status line sits below a ## heading parses as nothing", () => {
  const parsed = parsePlan(["# A plan", "", "## Sections of Work", "", "Status: Complete", ""].join("\n"));
  assert.equal(parsed, null);
});

test("a foreign ## inside Sections of Work drops every later section", () => {
  const parsed = parsePlan(
    plan({
      sections: [
        "### 1. The reader",
        "### 2. The renderer",
        "",
        "## Out of Scope",
        "",
        "### 3. The thread",
        "### 4. Documentation",
      ].join("\n"),
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.sections, 2);
});

test("a ## line ends the block only when whitespace and text follow the hashes", () => {
  // The engine's H2 pattern requires that whitespace, so a line of prose opening with bare `##`
  // is not a heading to it. A reader that ended the block there would count fewer sections than
  // the engine counts in the same file.
  const inside = (line: string): number => {
    const parsed = parsePlan(
      plan({ sections: ["### 1. The reader", line, "### 2. The renderer"].join("\n") }),
    );
    assert.ok(parsed, line);
    return parsed.sections;
  };

  assert.equal(inside("##foo"), 2, "no whitespace after the hashes, so not a heading");
  assert.equal(inside("##"), 2, "nothing after the hashes at all");
  assert.equal(inside("## "), 2, "whitespace but no text");
  assert.equal(inside("#### Deeper"), 2, "deeper headings live inside a block");
  assert.equal(inside("## Foo"), 1, "a real H2 ends the block and drops what follows");
  assert.equal(inside("##\tFoo"), 1, "a tab is whitespace to the engine's pattern too");
});

test("only ### N. headings inside the block count as sections", () => {
  const parsed = parsePlan(
    [
      "# A plan",
      "",
      "Status: In Progress",
      "",
      "### 9. Not in the block",
      "",
      "## Sections of Work",
      "",
      "### 1. The reader",
      "### 2 The renderer",
      "###3. No space after the hashes",
      "### The thread",
      "",
    ].join("\n"),
  );
  assert.ok(parsed);
  assert.equal(parsed.sections, 1);
});

test("each of the three Completed forms closes its section", () => {
  for (const completed of ["1. The reader", "1 whatever the chapter called it", "The reader"]) {
    const parsed = parsePlan(
      plan({ chapters: ["### Chapter 1", `Completed: ${completed}`, "Next: the renderer"].join("\n") }),
    );
    assert.ok(parsed, completed);
    assert.equal(parsed.sections, 2, completed);
    assert.equal(parsed.completed, 1, `closed by ${completed}`);
  }
});

test("a Completed value outside the three forms leaves its section open", () => {
  for (const completed of [
    "Section 1, The reader",
    "the reader",
    "The reader and its tests",
    "#1. The reader",
    "1",
  ]) {
    const parsed = parsePlan(
      plan({ chapters: ["### Chapter 1", `Completed: ${completed}`].join("\n") }),
    );
    assert.ok(parsed, completed);
    assert.equal(parsed.completed, 0, `left open by ${completed}`);
  }
});

test("what closes a section is exactly what a pairwise scan of the three forms closes", () => {
  // The reader indexes the Completed values rather than comparing every section against every
  // value, so this pins the index against the contract's three forms written out literally, pair by
  // pair. The values are chosen to sit on the edges the index could have moved: a number that is a
  // prefix of another, a leading zero, a value that is itself a section title, and a value whose
  // digits are followed by neither a period nor a space.
  const sections = [
    { number: "1", title: "The reader" },
    { number: "2", title: "The renderer" },
    { number: "12", title: "1. The reader" },
    { number: "01", title: "Nothing" },
    { number: "123", title: "12 The renderer" },
  ];
  const values = [
    "1. The reader",
    "1 whatever the chapter called it",
    "The reader",
    "12",
    "12.",
    "123. The last one",
    "01. The reader",
    "1. The reader and its tests",
    "the reader",
    "#1. The reader",
    "1",
    "",
  ];

  const closes = (section: { number: string; title: string }, completed: string): boolean =>
    completed.startsWith(`${section.number}.`) ||
    completed.startsWith(`${section.number} `) ||
    completed === section.title;

  for (const section of sections) {
    for (const completed of values) {
      const parsed = parsePlan(
        plan({
          sections: `### ${section.number}. ${section.title}`,
          chapters: ["### Chapter 1", `Completed: ${completed}`].join("\n"),
        }),
      );
      assert.ok(parsed, `${section.number} against ${completed}`);
      assert.equal(parsed.sections, 1, `${section.number} parsed as one section`);
      assert.equal(
        parsed.completed,
        closes(section, completed) ? 1 : 0,
        `section ${section.number}. ${section.title} against Completed: ${completed}`,
      );
    }
  }
});

test("a section number is matched whole, so 1 never closes on section 12", () => {
  const parsed = parsePlan(
    plan({
      sections: ["### 1. The reader", "### 12. The last one"].join("\n"),
      chapters: ["### Chapter 1", "Completed: 12. The last one"].join("\n"),
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.sections, 2);
  assert.equal(parsed.completed, 1);
});

test("only the first Completed line of a Chapter is read", () => {
  const parsed = parsePlan(
    plan({
      chapters: [
        "### Chapter 1",
        "Completed: Section 1, The reader",
        "Completed: 1. The reader",
      ].join("\n"),
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.completed, 0);
});

test("the highest-numbered Chapter owns the Next line, whatever order they appear in", () => {
  const parsed = parsePlan(
    plan({
      chapters: [
        "### Chapter 3 - 2026-08-16",
        "Completed: 1. The reader",
        "Next: the thread and the wiring",
        "",
        "### Chapter 2",
        "Completed: 2. The renderer",
        "Next: the renderer",
      ].join("\n"),
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.next, "the thread and the wiring");
  assert.equal(parsed.completed, 2);
});

test("a plan with no Chapters has no Next and no closed sections", () => {
  const parsed = parsePlan(plan());
  assert.ok(parsed);
  assert.equal(parsed.next, null);
  assert.equal(parsed.completed, 0);
  assert.equal(parsed.sections, 2);
});

test("a megabyte-sized Status and Next are bounded before they leave the parse", () => {
  // A plan file is capped at a megabyte and one line of it can be the whole of that, so these two
  // free-form values are the two fields that can arrive enormous. Bounding them here is what keeps a
  // megabyte out of a caller's held parse and out of every renderer downstream of it.
  const huge = "a".repeat(2 * MAX_PLAN_FILE_BYTES);
  const parsed = parsePlan(
    plan({ status: huge, chapters: ["### Chapter 1", `Next: ${huge}`].join("\n") }),
  );

  assert.ok(parsed);
  assert.equal(parsed.status.length, MAX_INTAKE_STATUS_LENGTH);
  assert.equal(parsed.next?.length, MAX_INTAKE_NEXT_LENGTH);
  assert.equal(parsed.terminal, false);
});

test("a value's whitespace is collapsed before it is bounded, so the prefix kept is meaningful", () => {
  const spaced = `head${" ".repeat(4 * MAX_INTAKE_NEXT_LENGTH)}tail`;
  const parsed = parsePlan(
    plan({ status: `  ${spaced}`, chapters: ["### Chapter 1", `Next:   ${spaced}`].join("\n") }),
  );

  assert.ok(parsed);
  assert.equal(parsed.status, "head tail");
  assert.equal(parsed.next, "head tail");
});

test("the sweep reads docs/plans only, one level deep, carrying stem and mtime", () => {
  const held = scratch();
  try {
    const file = held.write(
      "channels_board-card_spec_v1.md",
      plan({ chapters: ["### Chapter 1", "Completed: 1. The reader", "Next: the renderer"].join("\n") }),
    );
    held.write("notes.txt", plan());
    mkdirSync(path.join(held.root, "docs", "plans", "old"), { recursive: true });
    writeFileSync(path.join(held.root, "docs", "plans", "old", "nested_spec_v1.md"), plan(), "utf8");
    mkdirSync(path.join(held.root, "docs", "archive", "plans"), { recursive: true });
    writeFileSync(
      path.join(held.root, "docs", "archive", "plans", "archived_spec_v1.md"),
      plan({ status: "Complete" }),
      "utf8",
    );

    const swept = sweepPlans([held.root]);
    assert.deepEqual(swept.failures, []);
    assert.equal(swept.readings.length, 1);
    assert.deepEqual(swept.readings[0], {
      root: held.root,
      path: file,
      stem: "channels_board-card_spec_v1",
      status: "In Progress",
      terminal: false,
      sections: 2,
      completed: 1,
      next: "the renderer",
      mtimeMs: statSync(file).mtimeMs,
      sizeBytes: statSync(file).size,
    });
  } finally {
    held.cleanup();
  }
});

test("terminal plans come back too, flagged, so the caller owns the membership rule", () => {
  const held = scratch();
  try {
    held.write("done_spec_v1.md", plan({ status: "Complete" }));
    held.write("open_spec_v1.md", plan({ status: "Draft" }));

    const swept = sweepPlans([held.root]);
    assert.deepEqual(
      swept.readings.map((reading) => [reading.stem, reading.status, reading.terminal]),
      [
        ["done_spec_v1", "Complete", true],
        ["open_spec_v1", "Draft", false],
      ],
    );
  } finally {
    held.cleanup();
  }
});

test("a root with no docs/plans directory sweeps to nothing rather than to a failure", () => {
  const held = scratch();
  try {
    rmSync(path.join(held.root, "docs"), { recursive: true, force: true });
    const swept = sweepPlans([held.root, path.join(held.root, "absent")]);
    assert.deepEqual(swept, { readings: [], failures: [], truncated: [], listings: [] });
  } finally {
    held.cleanup();
  }
});

test("an over-cap file is refused whole, never parsed as a prefix", () => {
  const held = scratch();
  try {
    const body = plan({ chapters: ["### Chapter 1", "Completed: 1. The reader", "Next: the renderer"].join("\n") });
    const text = body + "\n" + "x".repeat(MAX_PLAN_FILE_BYTES + 1 - body.length - 1);
    assert.ok(Buffer.byteLength(text, "utf8") > MAX_PLAN_FILE_BYTES);
    // The prefix parses into a perfectly plausible reading, which is exactly why the refusal has to
    // happen on the whole file rather than on what fits.
    assert.ok(parsePlan(text.slice(0, MAX_PLAN_FILE_BYTES)));
    const file = held.write("huge_spec_v1.md", text);

    const swept = sweepPlans([held.root]);
    assert.deepEqual(swept.readings, []);
    assert.deepEqual(swept.failures, [
      { root: held.root, path: file, stem: "huge_spec_v1", reason: "oversized", stat: statOf(file) },
    ]);
  } finally {
    held.cleanup();
  }
});

test("a file at the cap is still read", () => {
  const held = scratch();
  try {
    const body = plan();
    const text = body + "x".repeat(MAX_PLAN_FILE_BYTES - Buffer.byteLength(body, "utf8"));
    assert.equal(Buffer.byteLength(text, "utf8"), MAX_PLAN_FILE_BYTES);
    held.write("exact_spec_v1.md", text);

    const swept = sweepPlans([held.root]);
    assert.deepEqual(swept.failures, []);
    assert.equal(swept.readings.length, 1);
  } finally {
    held.cleanup();
  }
});

test("an unreadable file is a named failure and the plans beside it still read", () => {
  const held = scratch();
  try {
    const bad = held.write("torn_spec_v1.md", plan());
    held.write("well_spec_v1.md", plan());

    const swept = sweepPlans([held.root], {
      readPlan: (file) => (file === bad ? { failed: "unreadable" } : { text: plan() }),
    });
    assert.deepEqual(
      swept.readings.map((reading) => reading.stem),
      ["well_spec_v1"],
    );
    assert.deepEqual(swept.failures, [
      { root: held.root, path: bad, stem: "torn_spec_v1", reason: "unreadable", stat: statOf(bad) },
    ]);
  } finally {
    held.cleanup();
  }
});

test("a plan the caller already holds at this mtime and size is folded in without a read", () => {
  const held = scratch();
  try {
    const file = held.write("open_spec_v1.md", plan());
    const stat = statSync(file);
    const opened: string[] = [];
    const readPlan = (target: string) => {
      opened.push(target);
      return { text: plan() };
    };

    // The stat the sweep takes matches what the caller holds, so the file is never opened and the
    // held parse comes back under the fresh stat.
    const gated = sweepPlans([held.root], {
      readPlan,
      heldParse: (target, mtimeMs, sizeBytes) =>
        target === file && mtimeMs === stat.mtimeMs && sizeBytes === stat.size
          ? { status: "Draft", terminal: false, sections: 9, completed: 4, next: "held" }
          : undefined,
    });
    assert.deepEqual(opened, [], "nothing was opened for a plan the caller already holds");
    assert.deepEqual(gated.readings, [
      {
        root: held.root,
        path: file,
        stem: "open_spec_v1",
        status: "Draft",
        terminal: false,
        sections: 9,
        completed: 4,
        next: "held",
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      },
    ]);

    // A caller holding nothing for that stat gets the file read instead.
    const fresh = sweepPlans([held.root], { readPlan, heldParse: () => undefined });
    assert.deepEqual(opened, [file], "the file is opened once the hold no longer matches");
    assert.equal(fresh.readings[0]?.status, "In Progress");
  } finally {
    held.cleanup();
  }
});

test("a plan the caller already saw fail at this mtime and size is not opened either", () => {
  // A failing file has no parse to match a later stat with, so nothing but this gate stops the sweep
  // from reading it in full on every tick for as long as it sits under a configured root.
  const held = scratch();
  try {
    const file = held.write("torn_spec_v1.md", plan());
    const stat = statSync(file);
    const opened: string[] = [];
    const readPlan = (target: string) => {
      opened.push(target);
      return { text: plan() };
    };

    const gated = sweepPlans([held.root], {
      readPlan,
      heldFailure: (target, mtimeMs, sizeBytes) =>
        target === file && mtimeMs === stat.mtimeMs && sizeBytes === stat.size
          ? ("malformed" as const)
          : undefined,
    });
    assert.deepEqual(opened, [], "nothing was opened for a plan the caller already saw fail");
    assert.deepEqual(gated.readings, []);
    assert.deepEqual(gated.failures, [
      {
        root: held.root,
        path: file,
        stem: "torn_spec_v1",
        reason: "malformed",
        stat: { mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
      },
    ]);

    // A caller holding nothing for that stat gets the file read instead.
    const fresh = sweepPlans([held.root], { readPlan, heldFailure: () => undefined });
    assert.deepEqual(opened, [file], "the file is opened once the hold no longer matches");
    assert.equal(fresh.readings[0]?.status, "In Progress");
  } finally {
    held.cleanup();
  }
});

test("the extension test ignores case, and one root contributes at most MAX_PLANS_PER_ROOT files", () => {
  const held = scratch();
  try {
    held.write("SHOUTED_SPEC_V1.MD", plan());
    held.write("quiet_spec_v1.md", plan());
    const swept = sweepPlans([held.root]);
    assert.deepEqual(
      swept.readings.map((reading) => reading.stem).sort(),
      ["SHOUTED_SPEC_V1", "quiet_spec_v1"],
      "a plan named in capitals is a plan",
    );
    assert.deepEqual(swept.truncated, [], "a root under the cap reports no cut");

    const many = scratch();
    try {
      for (let i = 0; i < MAX_PLANS_PER_ROOT + 5; i += 1) {
        many.write(`plan-${String(i).padStart(3, "0")}_spec_v1.md`, plan());
      }
      const capped = sweepPlans([many.root]);
      assert.equal(capped.readings.length, MAX_PLANS_PER_ROOT);
      assert.deepEqual(capped.failures, []);
      assert.equal(capped.readings[0]?.stem, "plan-000_spec_v1", "the cap takes the first names");
      assert.deepEqual(
        capped.truncated,
        [{ root: many.root, dropped: 5 }],
        "the plans past the cap are named as a count, not dropped in silence",
      );
    } finally {
      many.cleanup();
    }
  } finally {
    held.cleanup();
  }
});

test("a plans directory that has not moved is not listed again, and one that has is", () => {
  const held = scratch();
  const sweeper = sweeping([held.root]);
  try {
    const plans = path.join(held.root, "docs", "plans");
    held.write("alpha_spec_v1.md", plan());
    // A directory listed while it is still is one whose listing can be held: a listing of one that
    // just changed is taken again next tick, since the clock granule it was stamped in could hide a
    // name added a moment later.
    const still = new Date(Date.now() - 60_000);
    utimesSync(plans, still, still);

    const first = sweeper.sweep();
    assert.deepEqual(first.readings.map((reading) => reading.stem), ["alpha_spec_v1"]);

    // A name added and the directory's own time put back where it was, which is the whole of what a
    // held listing is keyed on. A sweep that listed the directory again would find the second plan.
    held.write("beta_spec_v1.md", plan());
    utimesSync(plans, still, still);
    const second = sweeper.sweep();
    assert.deepEqual(
      second.readings.map((reading) => reading.stem),
      ["alpha_spec_v1"],
      "the unmoved directory was not read again, so the sweep is the held listing",
    );

    // The ordinary case: a plan written into the directory moves it, and the next sweep sees both.
    held.write("gamma_spec_v1.md", plan());
    const third = sweeper.sweep();
    assert.deepEqual(
      third.readings.map((reading) => reading.stem).sort(),
      ["alpha_spec_v1", "beta_spec_v1", "gamma_spec_v1"],
      "a directory that moved is listed again, so a new plan is picked up",
    );
  } finally {
    held.cleanup();
  }
});

test("two sweepers hold their listings apart, and neither takes the other's", () => {
  // The hold is the caller's, which is what lets two of them run in one process. Kept inside the
  // sweep instead, it would be one map for both, and each sweeper's pass would discard the other's
  // entry: every sweeper but the last to run would list its directory again on every tick.
  const one = scratch();
  const two = scratch();
  const sweepers = [sweeping([one.root]), sweeping([two.root])];
  try {
    const still = new Date(Date.now() - 60_000);
    for (const held of [one, two]) {
      held.write("alpha_spec_v1.md", plan());
      utimesSync(path.join(held.root, "docs", "plans"), still, still);
    }

    sweepers[0]?.sweep();
    sweepers[1]?.sweep();

    // A name added to the first sweeper's directory with that directory's time put back, so only a
    // sweeper that listed it again finds the second plan.
    one.write("beta_spec_v1.md", plan());
    utimesSync(path.join(one.root, "docs", "plans"), still, still);
    assert.deepEqual(
      sweepers[0]?.sweep().readings.map((reading) => reading.stem),
      ["alpha_spec_v1"],
      "the second sweeper's pass left the first sweeper's held listing where it was",
    );
  } finally {
    one.cleanup();
    two.cleanup();
  }
});

test("a file with no Status header is a failure, not a plan with an empty status", () => {
  const held = scratch();
  try {
    const file = held.write("torn_spec_v1.md", "# A plan\n\n## Sections of Work\n\n### 1. The reader\n");

    const swept = sweepPlans([held.root]);
    assert.deepEqual(swept.readings, []);
    assert.deepEqual(swept.failures, [
      { root: held.root, path: file, stem: "torn_spec_v1", reason: "malformed", stat: statOf(file) },
    ]);
  } finally {
    held.cleanup();
  }
});
