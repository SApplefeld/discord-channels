import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CARD_LENGTH } from "../discord/render.ts";
import { eventKey, initialEventState } from "./events.ts";
import type { BoardEvent, EventReaderState } from "./events.ts";
import type { PlanFailure, PlanParse, PlanReading, PlanTruncation } from "./plans.ts";
import {
  MAX_INTAKE_NEXT_LENGTH,
  MAX_INTAKE_STATUS_LENGTH,
  MAX_PLAN_FILE_BYTES,
  parsePlan,
} from "./plans.ts";
import {
  MAX_DRAWN_SECTIONS,
  MAX_NEXT_LENGTH,
  fieldUnitsNeutralized,
  renderBoardCard,
} from "./card.ts";
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

/**
 * A filename stem as the card draws it.
 *
 * The body is live markdown, so every underscore in a plan's name carries the escape that keeps the
 * name from composing emphasis around the text beside it. Discord draws the character rather than
 * the backslash, so what the operator reads is the name as it was written.
 */
function drawn(stem: string): string {
  return stem.replaceAll("_", "\\_");
}

/** The lines one plan draws: its own bullet, and the sub-bullets indented under it. */
function item(rendered: string, stem: string): string[] {
  const all = rendered.split("\n");
  const at = all.indexOf(`- **${drawn(stem)}**`);
  assert.notEqual(at, -1, `no bullet names ${stem}: ${rendered}`);
  let end = at + 1;
  while ((all[end] ?? "").startsWith("  - ")) end += 1;
  return all.slice(at, end);
}

/** The facts sub-bullet of every plan on the card, in the order the card draws them. */
function facts(rendered: string): string[] {
  const all = rendered.split("\n");
  return all.flatMap((line, at) => (line.startsWith("- **") ? [all[at + 1] ?? ""] : []));
}

/** Every project heading on the card, in the order the card draws them. */
function projects(rendered: string): string[] {
  return rendered
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4));
}

/** Every bullet the card draws, plans, no-parse lines and truncation notes alike. */
function bullets(rendered: string): string[] {
  return rendered.split("\n").filter((line) => line.startsWith("- "));
}

test("a project draws a heading, a bullet per open plan, and that plan's facts under it", () => {
  const body = card({ plans: [plan()] });

  assert.equal(
    body,
    [
      "📋 **Fleet: Board**",
      "# 📋 Fleet: Board",
      "",
      "### sapplefeld-channels",
      "- **channels\\_board-card\\_spec\\_v1**",
      "  - 3/5 · 2h 0m",
      "  - next: the renderer and its tests",
      "",
      "card as of just now",
    ].join("\n"),
  );
});

test("the same inputs compose the same bytes, so an unchanged fleet spends no edit", () => {
  const input = { plans: [plan()], events: events(event()) };
  assert.equal(card(input), card(input));
});

test("a name full of underscores is drawn as the name that was written", () => {
  const body = card({ plans: [plan({ stem: "_".repeat(30) })] });

  assert.ok(
    body.includes(`- **${"\\_".repeat(30)}**`),
    `every underscore is escaped and none is emphasis: ${body}`,
  );
});

test("a stem is drawn whole, since it is the handle the operator mentions in the channel", () => {
  const stem = "channels_a-very-long-plan-name-that-no-column-would-have-held_spec_v1";
  const body = card({ plans: [plan({ stem })] });

  assert.ok(body.includes(`- **${drawn(stem)}**`), body);
  assert.doesNotMatch(body, /…/, "nothing on the card is cut to a display width");
});

test("a Complete plan is hidden and every other status is drawn as its own clause", () => {
  const body = card({
    plans: [
      plan({ stem: "open_spec_v1" }),
      plan({ stem: "draft_spec_v1", status: "Draft", completed: 0 }),
      plan({ stem: "wordy_spec_v1", status: "Parked (until pilot data lands)", completed: 1 }),
      plan({ stem: "done_spec_v1", status: "Complete", terminal: true, completed: 5 }),
    ],
  });

  assert.equal(item(body, "draft_spec_v1")[1], "  - 0/5 · 2h 0m · Draft");
  assert.equal(
    item(body, "wordy_spec_v1")[1],
    "  - 1/5 · 2h 0m · Parked \\(until pilot data lands\\)",
    "a sentence-length status is drawn whole rather than cut where the information is",
  );
  assert.equal(
    item(body, "open_spec_v1")[1],
    "  - 3/5 · 2h 0m",
    "the ordinary in-progress status draws no clause at all",
  );
  assert.doesNotMatch(body, /done_spec_v1/);
});

test("a status one word from the ordinary one is drawn, since that word is the difference", () => {
  const body = card({ plans: [plan({ status: "In Progress (auto)" })] });

  assert.equal(item(body, "channels_board-card_spec_v1")[1], "  - 3/5 · 2h 0m · In Progress \\(auto\\)");
});

test("a status at the intake cap is drawn whole however far the escape expands it", () => {
  // The escape writes a backslash in front of every character it touches, so a status of the
  // most-expanding character it knows doubles in length. A render limit set at the cap the plan
  // reader bounded the value by would cut that status in half while reporting nothing.
  const status = "_".repeat(MAX_INTAKE_STATUS_LENGTH);
  const body = card({ plans: [plan({ status })] });

  assert.equal(
    item(body, "channels_board-card_spec_v1")[1],
    `  - 3/5 · 2h 0m · ${"\\_".repeat(MAX_INTAKE_STATUS_LENGTH)}`,
  );
  assert.doesNotMatch(body, /…/, "a field the reader already bounded is never cut again here");
});

test("a status that neutralizes to nothing is named rather than passing for the ordinary one", () => {
  // A zero-width space is not whitespace to `trim`, so a status made of them is not the ordinary
  // value and reaches the escape, which strips it to nothing. Drawn as an absence it would be
  // indistinguishable from the in-progress state, which is the one absence this card gives meaning.
  const body = card({ plans: [plan({ status: "​​" })] });

  assert.equal(item(body, "channels_board-card_spec_v1")[1], "  - 3/5 · 2h 0m · (unreadable status)");
});

test("a status that was blank to begin with draws nothing, since there is no text to report", () => {
  const body = card({ plans: [plan({ status: "   " })] });

  assert.equal(item(body, "channels_board-card_spec_v1")[1], "  - 3/5 · 2h 0m");
});

test("a card with nothing at all to draw says so in one line", () => {
  const body = card({ plans: [plan({ status: "Complete", terminal: true })] });

  assert.match(body, /^No open plans in the configured projects\.$/m);
  assert.deepEqual(projects(body), []);
  assert.deepEqual(bullets(body), []);
});

test("a configured root whose plans are all terminal draws nothing at all", () => {
  const body = card({
    plans: [
      plan({ root: CHANNELS, stem: "open_spec_v1" }),
      plan({ root: AI_OS, stem: "closed_spec_v1", status: "Complete", terminal: true }),
    ],
  });

  assert.deepEqual(projects(body), ["sapplefeld-channels"]);
});

test("a project whose configured root has no last segment is named by its position", () => {
  const body = card({ plans: [plan({ root: "\\\\" })] });

  assert.deepEqual(projects(body), ["project 1"]);
});

test("a plan declaring no sections draws no count, since a fraction of nothing measures nothing", () => {
  const body = card({ plans: [plan({ sections: 0, completed: 0, next: null })] });

  assert.deepEqual(item(body, "channels_board-card_spec_v1"), [
    "- **channels\\_board-card\\_spec\\_v1**",
    "  - 2h 0m",
  ]);
});

test("counts out of a plan doc's own headings are bounded before they take the line", () => {
  const body = card({ plans: [plan({ sections: 1e9, completed: 1e9 })] });

  assert.equal(
    item(body, "channels_board-card_spec_v1")[1],
    `  - ${MAX_DRAWN_SECTIONS}/${MAX_DRAWN_SECTIONS} · 2h 0m`,
  );
});

test("the blocked marker leads the facts while the latest event for the pair is goal-blocked", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ ts: new Date(NOW - 3 * HOUR).toISOString() })),
  });

  assert.equal(item(body, "channels_board-card_spec_v1")[1], "  - blocked 3h 0m · 3/5 · 5h 0m");
});

test("the blocked marker clears when the plan doc's mtime moves past the event", () => {
  const blocked = event({ ts: new Date(NOW - 3 * HOUR).toISOString() });

  const standing = card({ plans: [plan({ mtimeMs: NOW - 5 * HOUR })], events: events(blocked) });
  const resumed = card({ plans: [plan({ mtimeMs: NOW - 1 * HOUR })], events: events(blocked) });

  assert.match(standing, /blocked 3h 0m/);
  assert.doesNotMatch(resumed, /blocked /, `a Chapter landing after the block means it resumed`);
  assert.equal(item(resumed, "channels_board-card_spec_v1")[1], "  - 3/5 · 1h 0m");
});

test("the blocked marker clears on a goal-complete for the pair", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ event: "goal-complete" })),
  });

  assert.doesNotMatch(body, /blocked /);
});

test("a block stamped ahead of the clock is taken as now, so a moved doc still clears it", () => {
  const ahead = event({ ts: new Date(NOW + 3 * HOUR).toISOString() });

  const standing = card({ plans: [plan({ mtimeMs: NOW - 5 * HOUR })], events: events(ahead) });
  const moved = card({ plans: [plan({ mtimeMs: NOW + 1 * HOUR })], events: events(ahead) });

  assert.equal(
    item(standing, "channels_board-card_spec_v1")[1],
    "  - blocked 0m · 3/5 · 5h 0m",
    "a block cannot have started later than the card is drawn",
  );
  assert.doesNotMatch(
    moved,
    /blocked /,
    "a doc that moved after the card's own clock is movement the clear rule reads",
  );
});

test("an event naming a plan the sweep does not have draws no marker anywhere", () => {
  const body = card({
    plans: [plan({ stem: "channels_other_spec_v1", mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ plan: "docs/plans/channels_gone_spec_v1.md" })),
  });

  assert.doesNotMatch(body, /blocked /);
  assert.doesNotMatch(body, /channels_gone/);
});

test("two roots holding a plan of the same name are never given each other's marker", () => {
  const body = card({
    plans: [
      plan({ root: CHANNELS, stem: "shared_spec_v1", mtimeMs: NOW - 5 * HOUR }),
      plan({ root: AI_OS, stem: "shared_spec_v1", mtimeMs: NOW - 5 * HOUR }),
    ],
    events: events(event({ root: AI_OS, plan: "docs/plans/shared_spec_v1.md" })),
  });

  const [channels, aiOs] = facts(body);
  assert.equal(channels, "  - 3/5 · 5h 0m", `the channels plan is unmarked: ${body}`);
  assert.equal(aiOs, "  - blocked 3h 0m · 3/5 · 5h 0m", `the ai-os plan carries it: ${body}`);
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
    assert.match(body, /blocked 3h 0m/, `${named} names the swept plan`);
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

  assert.match(facts(doubled)[0] ?? "", /^ {2}- blocked /, `the doubled name carries it: ${doubled}`);
  assert.doesNotMatch(facts(doubled)[1] ?? "", /blocked /, `the sibling does not: ${doubled}`);
  assert.doesNotMatch(facts(single)[0] ?? "", /blocked /, `the doubled name does not: ${single}`);
  assert.match(facts(single)[1] ?? "", /^ {2}- blocked /, `the sibling carries it: ${single}`);
});

test("an event whose timestamp names no instant draws no marker that could never clear", () => {
  const body = card({
    plans: [plan({ mtimeMs: NOW - 5 * HOUR })],
    events: events(event({ ts: "whenever" })),
  });

  assert.doesNotMatch(body, /blocked /);
});

test("a held parse redraws its last good facts under a marker whose age climbs", () => {
  const fresh = card({ plans: [plan({}, null)] });
  const recent = card({ plans: [plan({}, NOW - 4 * MINUTE)] });
  const stale = card({ plans: [plan({}, NOW - 70 * MINUTE)] });

  assert.doesNotMatch(fresh, /held /);
  assert.equal(item(recent, "channels_board-card_spec_v1")[1], "  - held 4m · 3/5 · 2h 0m");
  assert.equal(item(stale, "channels_board-card_spec_v1")[1], "  - held 1h 10m · 3/5 · 2h 0m");
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

test("a plan the card holds no parse for draws one bullet saying why", () => {
  const body = card({
    failures: [
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\torn.md`, stem: "torn", reason: "malformed" },
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\huge.md`, stem: "huge", reason: "oversized" },
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\gone.md`, stem: "gone", reason: "unreadable" },
    ],
  });

  assert.deepEqual(bullets(body), [
    "- torn (does not parse)",
    "- huge (too large to read)",
    "- gone (cannot be read)",
  ]);
});

test("a failure for a plan already redrawn from a held parse draws no second bullet", () => {
  const body = card({
    plans: [plan({ stem: "torn_spec_v1" }, NOW - 4 * MINUTE)],
    failures: [
      { root: CHANNELS, path: `${CHANNELS}\\docs\\plans\\torn_spec_v1.md`, stem: "torn_spec_v1", reason: "malformed" },
    ],
  });

  assert.deepEqual(bullets(body), ["- **torn\\_spec\\_v1**"], `the held plan and nothing else: ${body}`);
  assert.doesNotMatch(body, /does not parse/);
});

test("a root whose listing was cut says so, so it never reads as a root with only its drawn plans", () => {
  const body = card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 12 }] });

  assert.match(body, /^- \+12 more plans in this project not shown$/m);
  assert.doesNotMatch(
    card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 0 }] }),
    /not shown/,
  );
  assert.match(
    card({ plans: [plan()], truncated: [{ root: CHANNELS, dropped: 1 }] }),
    /^- \+1 more plan in this project not shown$/m,
  );
});

test("a card that runs out of room names what it left out rather than ending mid-fleet", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      root: index < 30 ? CHANNELS : AI_OS,
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill a sub-bullet of every plan it is drawn on",
    }),
  );
  const body = card({ plans });

  assert.ok(body.length <= MAX_CARD_LENGTH, `${body.length} units`);
  const tail = body.split("\n").find((line) => line.includes("not shown")) ?? "";
  assert.match(tail, /^\(\+\d+ plans(, \+\d+ projects?)? not shown\)$/, body);
  const left = Number(/\+(\d+) plans/.exec(tail)?.[1]);
  const shown = bullets(body).filter((line) => line.startsWith("- **plan")).length;
  assert.equal(shown + left, 60, `every plan is either drawn or counted in the tail: ${body}`);
  assert.match(body, /^card as of just now$/m, "the footer survives a card that ran out of room");
});

test("a card that runs out of room before a project counts that whole project as missing", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      root: index < 59 ? CHANNELS : AI_OS,
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill a sub-bullet of every plan it is drawn on",
    }),
  );
  const body = card({ plans });

  assert.ok(body.length <= MAX_CARD_LENGTH, `${body.length} units`);
  assert.match(
    body.split("\n").find((line) => line.includes("not shown")) ?? "",
    /, \+1 project not shown\)$/,
  );
  assert.doesNotMatch(body, /sapplefeld-ai-os/);
});

test("a truncation note lost to the overflow is counted in the tail rather than dropped", () => {
  const plans = Array.from({ length: 60 }, (_, index) =>
    plan({
      stem: `plan_${String(index).padStart(3, "0")}_spec_v1`,
      next: "a next value long enough to fill a sub-bullet of every plan it is drawn on",
    }),
  );
  const body = card({ plans, truncated: [{ root: CHANNELS, dropped: 7 }] });

  const tail = body.split("\n").find((line) => line.includes("not shown)")) ?? "";
  const left = Number(/\+(\d+) plans/.exec(tail)?.[1]);
  const shown = bullets(body).filter((line) => line.startsWith("- **plan")).length;
  assert.doesNotMatch(body, /more plans in this project/);
  assert.equal(shown + left, 67, `the 7 dropped by the cap are still counted: ${body}`);
});

test("the blank lines the list shape needs are charged against the budget like any other line", () => {
  // A project costs a blank line and a heading before its first plan, and the card closes on a blank
  // line before its footer. Budget arithmetic that measured only the lines carrying text would run
  // the card past the message ceiling at exactly the fill where it matters, so every count of
  // projects up to a card that overflows is walked here rather than one chosen fill.
  // Every project the card draws is a heading over at least one bullet; no blank line falls inside a
  // project's list, where it would end the list and restart it; and every line that follows a list,
  // the overflow tail included, is held off it by a blank line of its own. Answers whether this card
  // is one that ran out of room, so the walk can be held to covering that shape too.
  const walk = (body: string, what: string): boolean => {
    assert.ok(body.length <= MAX_CARD_LENGTH, `${what} composes ${body.length} units`);
    const lines = body.split("\n");
    for (const [at, line] of lines.entries()) {
      if (line.startsWith("### ")) {
        assert.equal(lines[at - 1], "", `a heading closes the list above it: ${body}`);
        assert.match(lines[at + 1] ?? "", /^- /, `no heading stands over an empty list: ${body}`);
      }
      if (line === "") {
        assert.match(
          lines[at + 1] ?? "",
          /^(### |card as of |\(\+)/,
          `a blank line only ever closes a list, never falls inside one: ${body}`,
        );
      }
      if (line.startsWith("(+")) {
        assert.equal(
          lines[at - 1],
          "",
          `the tail closes the list above it rather than reading as one plan's own: ${body}`,
        );
      }
    }
    return lines.some((line) => line.startsWith("(+"));
  };

  let overflowed = false;
  for (let count = 1; count <= 40; count += 1) {
    const plans = Array.from({ length: count }, (_, index) =>
      plan({
        root: `D:\\project_${String(index).padStart(2, "0")}`,
        stem: `plan_${String(index).padStart(2, "0")}_spec_v1`,
        status: "Parked (until the pilot data lands)",
        next: "a next value long enough to fill a sub-bullet of every plan it is drawn on",
      }),
    );
    // The second fill is the cheapest project a card can carry, which is where an uncharged blank
    // line adds up fastest: one line per project against a budget spent per item.
    const thin = card({
      failures: Array.from({ length: count * 8 }, (_, index) => ({
        root: `D:\\project_${String(index).padStart(3, "0")}`,
        path: `D:\\project\\docs\\plans\\plan_${String(index)}.md`,
        stem: `plan_${String(index)}`,
        reason: "malformed" as const,
      })),
    });
    overflowed = walk(card({ plans }), `${count} projects`) || overflowed;
    overflowed = walk(thin, `${count * 8} one-bullet projects`) || overflowed;
  }
  assert.ok(
    overflowed,
    "a card that ran out of room has to be among them, or the tail's own blank line is unpinned",
  );
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

test("no untrusted field draws syntax of its own on the card's live markdown", () => {
  for (const body of adversarialCards()) {
    const lines = body.split("\n");
    assert.equal(lines[0], "📋 **Fleet: Board**");
    assert.equal(lines[1], "# 📋 Fleet: Board");
    // The two lines above are this renderer's own. Every other line is composed around untrusted
    // fields, and none of them may carry a backtick that could open a fence, a bracket Discord
    // resolves a chip inside, a quote bar, or a heading this renderer did not write.
    for (const line of lines.slice(2)) {
      const syntax = syntaxOf(line);
      assert.doesNotMatch(syntax, /[`<>]/, `no live fence or chip syntax: ${JSON.stringify(line)}`);
      assert.doesNotMatch(
        syntax.replace(/^### /, ""),
        /^[>#]/,
        `no line of untrusted text opens a quote or a heading: ${JSON.stringify(line)}`,
      );
    }
    // A stem sits inside the emphasis this renderer composes around it, so it may carry no mark that
    // could close that emphasis early and nothing that reads as syntax at all.
    for (const bullet of lines.filter((line) => line.startsWith("- **"))) {
      const named = syntaxOf(bullet);
      assert.ok(named.startsWith("- **") && named.endsWith("**"), JSON.stringify(bullet));
      const stem = named.slice(4, -2);
      if (stem === "(unnamed plan)") continue;
      assert.doesNotMatch(stem, /[*_~|<>#[\]()`\\]/, JSON.stringify(bullet));
    }
    // A project label sits inside a heading this renderer composes, and carries no syntax either.
    for (const heading of projects(body)) {
      assert.doesNotMatch(syntaxOf(heading), /[*_~|<>#[\]()`\\]/, JSON.stringify(heading));
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
  // `Next:` are single lines that can each carry the whole 256 KiB the reader's read cap allows. A
  // render whose cost followed those bytes would stall hook intake, heartbeats and the permission
  // prompts behind them on every tick, since a held parse folds the same value back in unchanged.
  // The gate is a unit count rather than the clock, on the same reasoning as the table transform's
  // counters in ../discord/render.ts: a loaded machine moves wall time by an order of magnitude and
  // would make this flaky, where the count is the same number everywhere. The two fixtures are 64
  // KiB and the read cap itself, four times as large, which is a wide enough spread that a cost
  // following the file's bytes could not read as equal.
  const units = (size: number): number => {
    const parsed = wideParse(size);
    fieldUnitsNeutralized.count = 0;
    card({ plans: [plan({ ...parsed })] });
    return fieldUnitsNeutralized.count;
  };

  const small = units(64 * 1024);
  const large = units(MAX_PLAN_FILE_BYTES);

  assert.ok(small > 0, "the counter has to be reached at all, or this passes on nothing");
  assert.equal(large, small, `${small} units at 64 KiB, ${large} at the read cap`);

  // The count has to be what the render walks, and on the `Next:` path that is the value as it
  // arrived: this card cuts that field itself, and the cut spreads the whole of it before the escape
  // sees any of it. Measured after the cut, the counter would report the cap back on any input at
  // all, and the equality above would stay green through an intake bound that had eroded to nothing.
  // A `Next:` past the reader's own cap is what that erosion looks like, and the count follows it
  // exactly.
  const uncut = (size: number): number => {
    fieldUnitsNeutralized.count = 0;
    card({ plans: [plan({ next: "n".repeat(size) })] });
    return fieldUnitsNeutralized.count;
  };

  assert.equal(
    uncut(64 * 1024) - uncut(1_024),
    63 * 1_024,
    "what the cut walks is measured before the cut, so the gate above can see it",
  );
});

test("a Next: value past the card's own cap is cut with a mark rather than silently shortened", () => {
  const body = card({ plans: [plan({ next: "z".repeat(MAX_INTAKE_NEXT_LENGTH) })] });
  const next = item(body, "channels_board-card_spec_v1")[2] ?? "";

  assert.equal(next, `  - next: ${"z".repeat(MAX_NEXT_LENGTH - 1)}…`);
});

test("a Next: value inside that cap is drawn whole, wrapped by the reader rather than cut", () => {
  const prose = "push the branch, open the PR against develop, and hand the review to the operator";
  const body = card({ plans: [plan({ next: prose })] });

  assert.equal(item(body, "channels_board-card_spec_v1")[2], `  - next: ${prose}`);
});
