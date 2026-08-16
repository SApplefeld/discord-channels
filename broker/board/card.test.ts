import { test } from "node:test";
import assert from "node:assert/strict";
import { BAR_GLYPH, MAX_BLOCK_WIDTH, MAX_CARD_LENGTH } from "../discord/render.ts";
import { eventKey, initialEventState } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import type { PlanFailure, PlanParse, PlanReading, PlanTruncation } from "./plans.ts";
import { MAX_INTAKE_NEXT_LENGTH, MAX_PLAN_FILE_BYTES, parsePlan } from "./plans.ts";
import { BAR_CELLS, MAX_DRAWN_SECTIONS, fieldUnitsNeutralized, renderBoardCard } from "./card.ts";
import type { BoardPlan } from "./card.ts";

const NOW = 1_786_300_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const CHANNELS = "D:\\sapplefeld-channels";
const AI_OS = "D:\\sapplefeld-ai-os";

function reading(overrides: Partial<PlanReading> = {}): PlanReading {
  const root = overrides.root ?? CHANNELS;
  const stem = overrides.stem ?? "channels_board-card_spec_v1";
  return {
    status: "In Progress",
    terminal: false,
    sections: 5,
    completed: 3,
    next: "the renderer and its tests",
    root,
    path: `${root}\\docs\\plans\\${stem}.md`,
    stem,
    mtimeMs: NOW - 2 * HOUR,
    sizeBytes: 4_096,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanReading> = {}, heldSince: number | null = null): BoardPlan {
  return { reading: reading(overrides), heldSince };
}

function events(...held: readonly BoardEvent[]): EventReaderState {
  const state = initialEventState();
  for (const event of held) state.latest.set(eventKey(event.root, event.plan), event);
  return state;
}

function event(overrides: Partial<BoardEvent> = {}): BoardEvent {
  return {
    root: CHANNELS,
    plan: "docs/plans/channels_board-card_spec_v1.md",
    event: "goal-blocked",
    ts: new Date(NOW - 3 * HOUR).toISOString(),
    session: null,
    detail: null,
    ...overrides,
  };
}

function card(input: {
  roots?: readonly string[];
  plans?: readonly BoardPlan[];
  failures?: readonly PlanFailure[];
  truncated?: readonly PlanTruncation[];
  events?: EventReaderState;
  now?: number;
}): string {
  return renderBoardCard({
    // Empty unless a test names the configured list, which leaves every root on the inputs drawn in
    // the order it first appears.
    roots: input.roots ?? [],
    plans: input.plans ?? [],
    failures: input.failures ?? [],
    truncated: input.truncated ?? [],
    events: input.events ?? initialEventState(),
    now: input.now ?? NOW,
  });
}

/** Every line inside a fence, whichever block it came from, split by position rather than by text. */
function fencedLines(rendered: string): string[] {
  const inside: string[] = [];
  let open = false;
  for (const line of rendered.split("\n")) {
    if (line === "```") open = !open;
    else if (open) inside.push(line);
  }
  return inside;
}

/** Every line outside every fence: the preview, the title, the project labels, and the footer. */
function plainLines(rendered: string): string[] {
  const outside: string[] = [];
  let open = false;
  for (const line of rendered.split("\n")) {
    if (line === "```") open = !open;
    else if (!open) outside.push(line);
  }
  return outside;
}

/** The two lines a plan draws, found by the stem that leads the first of them. */
function row(rendered: string, stem: string): string[] {
  const lines = fencedLines(rendered);
  const at = lines.findIndex((line) => line.startsWith(stem));
  assert.notEqual(at, -1, `no row leads with ${stem}: ${rendered}`);
  return lines.slice(at, at + 2);
}

test("a project draws a bold label outside its fence and two lines per open plan", () => {
  const body = card({ plans: [plan()] });

  assert.match(body, /^\*\*sapplefeld-channels\*\*$/m);
  assert.deepEqual(row(body, "channels_board-card_spec_v1"), [
    `channels_board-card_spec_v1     ${BAR_GLYPH.repeat(5)}      3/5`,
    "  2h 0m · next: the renderer and its tests",
  ]);
  assert.match(body, /^card as of just now$/m);
});

test("the same inputs compose the same bytes, so an unchanged fleet spends no edit", () => {
  const input = { plans: [plan()], events: events(event()) };
  assert.equal(card(input), card(input));
});

test("a Complete plan is hidden and every other status is drawn as its own text", () => {
  const body = card({
    plans: [
      plan({ stem: "open_spec_v1" }),
      plan({ stem: "draft_spec_v1", status: "Draft", completed: 0 }),
      plan({ stem: "odd_spec_v1", status: "Paused", completed: 1 }),
      plan({ stem: "wordy_spec_v1", status: "Waiting on the operator", completed: 1 }),
      plan({ stem: "done_spec_v1", status: "Complete", terminal: true, completed: 5 }),
    ],
  });

  assert.match(row(body, "draft_spec_v1")[0] ?? "", /Draft\s+0\/5$/);
  assert.match(
    row(body, "odd_spec_v1")[0] ?? "",
    /Paused\s+1\/5$/,
    "a status outside the contract's vocabulary surfaces rather than vanishing into a filter",
  );
  assert.match(
    row(body, "wordy_spec_v1")[0] ?? "",
    /Waiting …\s+1\/5$/,
    "a status wider than its columns is cut with a mark rather than dropped",
  );
  assert.match(row(body, "open_spec_v1")[0] ?? "", new RegExp(`${BAR_GLYPH}+\\s+3/5$`));
  assert.doesNotMatch(body, /done_spec_v1/);
});

test("a status made of the bar's own glyph is not drawn as a bar", () => {
  const forged = card({ plans: [plan({ status: BAR_GLYPH.repeat(BAR_CELLS), completed: 0 })] });
  const finished = card({ plans: [plan({ sections: 5, completed: 5 })] });

  const line = row(forged, "channels_board-card_spec_v1")[0] ?? "";
  assert.doesNotMatch(
    line,
    new RegExp(BAR_GLYPH),
    `a status is drawn in the bar's own columns, so it may carry no bar cell: ${line}`,
  );
  assert.match(
    row(finished, "channels_board-card_spec_v1")[0] ?? "",
    new RegExp(`${BAR_GLYPH}{${BAR_CELLS}}`),
    "a plan that really is finished still draws the full bar",
  );
});

test("a card with nothing at all to draw says so in one line", () => {
  const body = card({ plans: [plan({ status: "Complete", terminal: true })] });

  assert.match(body, /^No open plans in the configured projects\.$/m);
  assert.equal(fencedLines(body).length, 0, `no block is drawn: ${body}`);
});

test("a configured root whose plans are all terminal draws nothing at all", () => {
  const body = card({
    plans: [
      plan({ root: CHANNELS, stem: "open_spec_v1" }),
      plan({ root: AI_OS, stem: "closed_spec_v1", status: "Complete", terminal: true }),
    ],
  });

  assert.match(body, /^\*\*sapplefeld-channels\*\*$/m);
  assert.doesNotMatch(body, /sapplefeld-ai-os/);
  assert.equal(plainLines(body).filter((line) => line.startsWith("**")).length, 1);
});

test("a project whose configured root has no last segment is named by its position", () => {
  const body = card({ plans: [plan({ root: "\\\\" })] });

  assert.match(body, /^\*\*project 1\*\*$/m);
});

test("the section bar fills with progress and never reads as empty above zero", () => {
  const cases: [number, number, number][] = [
    [0, 5, 0],
    [1, 12, 1],
    [1, 2, 5],
    [3, 5, 5],
    [5, 5, 9],
    [9, 5, 9],
    [-2, 5, 0],
  ];

  for (const [completed, sections, cells] of cases) {
    const body = card({ plans: [plan({ completed, sections })] });
    const line = row(body, "channels_board-card_spec_v1")[0] ?? "";
    const drawn = [...line].filter((character) => character === BAR_GLYPH).length;
    assert.equal(drawn, cells, `${completed}/${sections} draws ${cells} cells: ${line}`);
  }
});

test("a plan declaring no sections draws no bar and the count that explains it", () => {
  const body = card({ plans: [plan({ sections: 0, completed: 0 })] });

  assert.match(row(body, "channels_board-card_spec_v1")[0] ?? "", /^\S+\s+0\/0$/);
});

test("counts out of a plan doc's own headings are bounded before they take the row", () => {
  const body = card({ plans: [plan({ sections: 1e9, completed: 1e9 })] });

  assert.match(
    row(body, "channels_board-card_spec_v1")[0] ?? "",
    new RegExp(`${MAX_DRAWN_SECTIONS}/${MAX_DRAWN_SECTIONS}$`),
  );
});

test("the blocked marker is drawn while the latest event for the pair is goal-blocked", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ ts: new Date(NOW - 3 * HOUR).toISOString() })),
  });

  assert.match(row(body, "channels_board-card_spec_v1")[1] ?? "", /^ {2}\(blocked 3h 0m\) · 5h 0m/);
});

test("the blocked marker clears when the plan doc's mtime moves past the event", () => {
  const blocked = event({ ts: new Date(NOW - 3 * HOUR).toISOString() });

  const standing = card({ plans: [plan({ mtimeMs: NOW - 5 * HOUR })], events: events(blocked) });
  const resumed = card({ plans: [plan({ mtimeMs: NOW - 1 * HOUR })], events: events(blocked) });

  assert.match(standing, /\(blocked /);
  assert.doesNotMatch(resumed, /\(blocked /, `a Chapter landing after the block means it resumed`);
  assert.match(row(resumed, "channels_board-card_spec_v1")[1] ?? "", /^ {2}1h 0m ·/);
});

test("the blocked marker clears on a goal-complete for the pair", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ event: "goal-complete" })),
  });

  assert.doesNotMatch(body, /\(blocked /);
});

test("a block stamped ahead of the clock is taken as now, so a moved doc still clears it", () => {
  const ahead = event({ ts: new Date(NOW + 3 * HOUR).toISOString() });

  const standing = card({ plans: [plan({ mtimeMs: NOW - 5 * HOUR })], events: events(ahead) });
  const moved = card({ plans: [plan({ mtimeMs: NOW + 1 * HOUR })], events: events(ahead) });

  assert.match(
    row(standing, "channels_board-card_spec_v1")[1] ?? "",
    /^ {2}\(blocked 0m\) · 5h 0m/,
    "a block cannot have started later than the card is drawn",
  );
  assert.doesNotMatch(
    moved,
    /\(blocked /,
    "a doc that moved after the card's own clock is movement the clear rule reads",
  );
});

test("an event naming a plan the sweep does not have draws no marker anywhere", () => {
  const body = card({
    plans: [plan({ stem: "channels_other_spec_v1", mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ plan: "docs/plans/channels_gone_spec_v1.md" })),
  });

  assert.doesNotMatch(body, /\(blocked /);
  assert.doesNotMatch(body, /channels_gone_spec_v1/);
});

test("two roots holding a plan of the same name are never given each other's marker", () => {
  const body = card({
    plans: [
      plan({ root: CHANNELS, stem: "shared_spec_v1", mtimeMs: NOW - 5 * HOUR }),
      plan({ root: AI_OS, stem: "shared_spec_v1", mtimeMs: NOW - 5 * HOUR }),
    ],
    events: events(event({ root: AI_OS, plan: "docs/plans/shared_spec_v1.md" })),
  });

  const [first, second] = fencedLines(body);
  assert.match(body, /\(blocked /);
  assert.doesNotMatch(second ?? "", /\(blocked /, `the channels row is unmarked: ${body}`);
  assert.match(first ?? "", /^shared_spec_v1/);
  assert.match(fencedLines(body)[3] ?? "", /\(blocked /, `the ai-os row carries it: ${body}`);
});

test("an event names its plan by a path and a reading by a stem, joined as one name", () => {
  const forms = [
    "docs/plans/channels_board-card_spec_v1.md",
    "docs\\plans\\channels_board-card_spec_v1.md",
    "channels_board-card_spec_v1.md",
    "docs/plans/CHANNELS_BOARD-CARD_SPEC_V1.MD",
  ];

  for (const named of forms) {
    const body = card({
      plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
      events: events(event({ plan: named })),
    });
    assert.match(body, /\(blocked /, `${named} names the swept plan`);
  }
});

test("a plan whose filename carries the suffix twice is joined to its own event alone", () => {
  // The reader takes one `.md` off a filename, so the file `twice_spec_v1.md.md` is swept under the
  // stem `twice_spec_v1.md` and sits beside a real sibling named `twice_spec_v1.md`. The two names
  // stay two names on both sides of the join.
  const both = [
    plan({ stem: "twice_spec_v1.md", mtimeMs: NOW - 5 * HOUR }),
    plan({ stem: "twice_spec_v1", mtimeMs: NOW - 5 * HOUR }),
  ];

  const doubled = card({
    plans: both,
    events: events(event({ plan: "docs/plans/twice_spec_v1.md.md" })),
  });
  const single = card({ plans: both, events: events(event({ plan: "docs/plans/twice_spec_v1.md" })) });

  assert.match(fencedLines(doubled)[1] ?? "", /\(blocked /, `the doubled name carries it: ${doubled}`);
  assert.doesNotMatch(fencedLines(doubled)[3] ?? "", /\(blocked /, `the sibling does not: ${doubled}`);
  assert.doesNotMatch(fencedLines(single)[1] ?? "", /\(blocked /, `the doubled name does not: ${single}`);
  assert.match(fencedLines(single)[3] ?? "", /\(blocked /, `the sibling carries it: ${single}`);
});

test("an event whose timestamp names no instant draws no marker that could never clear", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ ts: "whenever" })),
  });

  assert.doesNotMatch(body, /\(blocked /);
});

test("a held parse redraws its last good row under a marker whose age climbs", () => {
  const fresh = card({ plans: [plan({}, null)] });
  const recent = card({ plans: [plan({}, NOW - 4 * MINUTE)] });
  const stale = card({ plans: [plan({}, NOW - 70 * MINUTE)] });

  assert.doesNotMatch(fresh, /\(held /);
  assert.match(row(recent, "channels_board-card_spec_v1")[1] ?? "", /^ {2}\(held 4m\) · 2h 0m/);
  assert.match(row(stale, "channels_board-card_spec_v1")[1] ?? "", /^ {2}\(held 1h 10m\) · 2h 0m/);
  assert.match(fresh, /^card as of just now$/m);
  assert.match(stale, /^card as of 1h ago$/m, "the footer is as old as the oldest thing drawn");
});

test("the footer is anchored to the plans the card draws and to nothing it hides", () => {
  const hidden = card({
    plans: [
      plan({ stem: "open_spec_v1" }, null),
      plan({ stem: "done_spec_v1", status: "Complete", terminal: true }, NOW - 3 * HOUR),
    ],
  });
  const held = card({ plans: [plan({ stem: "open_spec_v1" }, NOW - 3 * HOUR)] });

  assert.match(hidden, /^card as of just now$/m, "a hidden plan's held parse ages no row on the card");
  assert.match(held, /^card as of 3h ago$/m, "a drawn plan's held parse is what the footer reports");
});

test("a plan the card holds no parse for draws one line saying why", () => {
  const body = card({
    failures: [
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\torn.md`, stem: "torn", reason: "malformed" },
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\huge.md`, stem: "huge", reason: "oversized" },
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\gone.md`, stem: "gone", reason: "unreadable" },
    ],
  });

  assert.deepEqual(fencedLines(body), [
    "torn (does not parse)",
    "huge (too large to read)",
    "gone (cannot be read)",
  ]);
});

test("a failure for a plan already redrawn from a held parse draws no second line", () => {
  const body = card({
    plans: [plan({ stem: "torn_spec_v1" }, NOW - 4 * MINUTE)],
    failures: [
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\torn_spec_v1.md`, stem: "torn_spec_v1", reason: "malformed" },
    ],
  });

  assert.equal(fencedLines(body).length, 2, `the held row and nothing else: ${body}`);
  assert.doesNotMatch(body, /does not parse/);
});

test("a root whose listing was cut says so, so it never reads as a root with only its drawn plans", () => {
  const body = card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 12 }] });

  assert.match(body, /^\+12 more plans in this project not shown$/m);
  assert.doesNotMatch(
    card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 0 }] }),
    /not shown/,
  );
  assert.match(
    card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 1 }] }),
    /^\+1 more plan in this project not shown$/m,
  );
});

test("a card that runs out of room names what it left out rather than ending mid-fleet", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      root: index < 30 ? CHANNELS : AI_OS,
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill the second line of every row it is drawn on",
    }),
  );
  const body = card({ plans });

  assert.ok(body.length <= MAX_CARD_LENGTH, `${body.length} units`);
  const tail = plainLines(body).find((line) => line.includes("not shown")) ?? "";
  assert.match(tail, /^\(\+\d+ plans(, \+\d+ projects?)? not shown\)$/, body);
  const left = Number(/\+(\d+) plans/.exec(tail)?.[1]);
  const drawn = fencedLines(body).filter((line) => line.startsWith("plan_")).length;
  assert.equal(drawn + left, 60, `every plan is either drawn or counted in the tail: ${body}`);
  assert.match(body, /^card as of just now$/m, "the footer survives a card that ran out of room");
});

test("a card that runs out of room before a project counts that whole project as missing", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      root: index < 59 ? CHANNELS : AI_OS,
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill the second line of every row it is drawn on",
    }),
  );
  const body = card({ plans });

  assert.ok(body.length <= MAX_CARD_LENGTH, `${body.length} units`);
  assert.match(
    plainLines(body).find((line) => line.includes("not shown")) ?? "",
    /, \+1 project not shown\)$/,
  );
  assert.doesNotMatch(body, /sapplefeld-ai-os/);
});

test("a truncation note lost to the overflow is counted in the tail rather than dropped", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill the second line of every row it is drawn on",
    }),
  );
  const body = card({ plans, truncated: [{ root: CHANNELS, dropped: 7 }] });

  const tail = plainLines(body).find((line) => line.includes("not shown)")) ?? "";
  const left = Number(/\+(\d+) plans/.exec(tail)?.[1]);
  const drawn = fencedLines(body).filter((line) => line.startsWith("plan_")).length;
  assert.doesNotMatch(body, /more plans in this project/);
  assert.equal(drawn + left, 67, `the 7 dropped by the cap are still counted: ${body}`);
});

// Filenames, statuses and `Next:` prose are model-written text out of another program's files, and
// an event's fields are that program's own. The card renders them into the one channel the operator
// answers permission prompts in, so the properties below are asserted over the whole composed body
// rather than over the field each string was fed to.
const ADVERSARIAL = [
  "```js\nconsole.log(1)\n```",
  "`inline` and ``double`` and ````quad````",
  "**bold** _under_ ~~strike~~ ||spoiler|| # heading",
  "<@1234567890> <#98765> <t:1786300000:R> <:evil:1>",
  "[link](https://example.test) \\escaped\\ |table|",
  "> quoted\n>>> block quoted\n@everyone @here",
  "\u202ereversed\u202c\u200b\u200d\u2066bidi\u2069",
  "\u{1d518}\u{1d52b}\u{1d526}\u{1d520}\u{1d52c}\u{1d521}\u{1d522} \u{1f600}\u{1f9e0}\u{1f4a5}",
  "a".repeat(400),
  "\u{1f600}".repeat(200),
  "🄲 ".repeat(60),
  "z".repeat(MAX_INTAKE_NEXT_LENGTH),
  "\u{1f4a5}".repeat(MAX_INTAKE_NEXT_LENGTH),
];

/** A parse of a plan doc whose `Status:` and `Next:` each carry `size` characters on one line. */
function wideParse(size: number): PlanParse {
  const wide = "w".repeat(size);
  const parsed = parsePlan(
    [
      "# A plan",
      "",
      `Status: ${wide}`,
      "",
      "## Sections of Work",
      "",
      "### 1. The reader",
      "",
      "## Chapters",
      "",
      "### Chapter 1",
      `Next: ${wide}`,
      "",
    ].join("\n"),
  );
  assert.ok(parsed, "the fixture parses");
  return parsed;
}

/**
 * One card per adversarial string, with that string in every untrusted field at once, plus one card
 * whose fields came out of a plan doc the size of the reader's whole read cap.
 *
 * That last card is drawn through the real parse rather than from a hand-built reading, because what
 * holds the card's cost down on a file that size is the reader's intake bound and nothing of the
 * card's own. A card assembled around a field the parse never touched would assert the properties
 * below against a shape the broker never renders.
 */
function adversarialCards(): string[] {
  return [
    ...ADVERSARIAL.map((hostile, index) =>
      card({
        plans: [
          plan({ root: hostile, stem: hostile, status: hostile, next: hostile }),
          plan({ root: CHANNELS, stem: `plan_${index}`, status: "Draft", next: hostile }),
        ],
        failures: [{ root: hostile, path: hostile, stem: hostile, reason: "malformed" }],
        truncated: [{ root: hostile, dropped: 3 }],
        events: events(event({ root: hostile, plan: hostile })),
      }),
    ),
    card({ plans: [plan({ ...wideParse(MAX_PLAN_FILE_BYTES), stem: "megabyte_spec_v1" })] }),
  ];
}

/**
 * A live-markdown line with every escape pair removed, which is what is left to read as syntax.
 *
 * The escape is a backslash and the one character after it, and the neutralizer escapes the
 * backslash itself too, so removing the pairs left to right leaves exactly the characters Discord
 * still gives meaning to.
 */
function syntaxOf(line: string): string {
  return line.replace(/\\[\s\S]/g, "");
}

test("no backtick reaches a fenced body, whatever a plan doc or an event carries", () => {
  for (const body of adversarialCards()) {
    for (const line of fencedLines(body)) {
      assert.doesNotMatch(line, /`/, `a fenced line carries no backtick: ${JSON.stringify(line)}`);
    }
    // Every fence delimiter on the card is one this renderer wrote, so they come in pairs.
    const delimiters = body.split("\n").filter((line) => line === "```").length;
    assert.equal(delimiters % 2, 0, `every block closes: ${body}`);
    for (const line of plainLines(body)) {
      assert.doesNotMatch(
        syntaxOf(line),
        /`/,
        `no live backtick outside a fence, so no field can open one: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("no fenced line exceeds the block's width bound, whatever a plan doc or an event carries", () => {
  for (const body of adversarialCards()) {
    for (const line of fencedLines(body)) {
      assert.ok(
        [...line].length <= MAX_BLOCK_WIDTH,
        `${[...line].length} code points: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("no untrusted text composes a line of its own, inside a fence or outside one", () => {
  for (const body of adversarialCards()) {
    const opening = body.split("\n");
    assert.equal(opening[0], "📋 **Fleet: Board**");
    assert.equal(opening[1], "# 📋 Fleet: Board");
    // The two lines above are this renderer's own; every other plain line is composed around
    // untrusted fields and may open neither a quote bar nor a heading.
    for (const line of plainLines(body).slice(2)) {
      assert.doesNotMatch(syntaxOf(line), /^[>#]/, JSON.stringify(line));
    }
    // A label sits inside the emphasis this renderer composes, so it may carry no mark that could
    // close that emphasis early, and no chip syntax at all.
    for (const label of plainLines(body).filter((line) => line.startsWith("**"))) {
      const named = syntaxOf(label);
      assert.ok(named.startsWith("**") && named.endsWith("**"), JSON.stringify(label));
      assert.doesNotMatch(named.slice(2, -2), /[*_~|<>#[\]()`\\]/, JSON.stringify(label));
    }
  }
});

test("a card stays inside one message however hostile its fields are", () => {
  for (const body of adversarialCards()) {
    assert.ok(body.length <= MAX_CARD_LENGTH, `${body.length} units: ${body}`);
  }
});

test("what one render neutralizes is bounded by the intake caps, not by a plan file's size", () => {
  // The card runs on a refresh timer on the broker's one event loop, and a plan doc's `Status:` and
  // `Next:` are single lines that can each carry the whole megabyte the reader's cap allows. A
  // render whose cost followed those bytes would stall hook intake, heartbeats and the permission
  // prompts behind them on every tick, since a held parse folds the same value back in unchanged.
  // The gate is a unit count rather than the clock, on the same reasoning as the table transform's
  // counters in ../discord/render.ts: a loaded machine moves wall time by an order of magnitude and
  // would make this flaky, where the count is the same number everywhere. Sixteen times the file
  // bytes is a wide enough margin that a cost following them could not read as equal.
  const units = (size: number): number => {
    const parsed = wideParse(size);
    fieldUnitsNeutralized.count = 0;
    card({ plans: [plan({ ...parsed })] });
    return fieldUnitsNeutralized.count;
  };

  const small = units(64 * 1024);
  const large = units(MAX_PLAN_FILE_BYTES);

  assert.ok(small > 0, "the counter has to be reached at all, or this passes on nothing");
  assert.equal(large, small, `${small} units at 64 KiB, ${large} at a megabyte`);
});

test("a stem too long for its column is cut with a mark rather than silently shortened", () => {
  const body = card({ plans: [plan({ stem: "channels_a-very-long-plan-name_spec_v1" })] });

  assert.match(fencedLines(body)[0] ?? "", /^channels_a-very-long-plan-name… /);
});

test("a Next: value too long for its line is cut with a mark rather than silently shortened", () => {
  const body = card({
    plans: [plan({ next: "rewire the attention loop and then everything downstream of it" })],
  });

  assert.match(fencedLines(body)[1] ?? "", /…$/);
});
