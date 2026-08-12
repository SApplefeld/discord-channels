import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BLOCK_WIDTH, MAX_CARD_LENGTH } from "../discord/render.ts";
import type { SessionView, StateThresholds } from "../discord/state.ts";
import type { UsageAccount, UsageReading, UsageUnavailableReason } from "./cache.ts";
import {
  BAR_CELLS,
  BAR_GLYPH,
  MAX_ACCOUNT_LABEL_LENGTH,
  PCT_WIDTH,
  WARNING_PCT,
  renderUsageCard,
} from "./card.ts";

const NOW = 1_786_300_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const THRESHOLDS: StateThresholds = { idleAfterMs: 5 * MINUTE, exitedAfterMs: 4 * HOUR };

function account(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    number: 1,
    email: "one@example.test",
    organizationName: "Org 1",
    active: false,
    fiveHour: { pct: 46, resetsAt: NOW + 3 * HOUR + 44 * MINUTE },
    sevenDay: { pct: 56, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR },
    spend: { pct: 6.36, used: 95.4, limit: 1500, currency: "USD" },
    scoped: [{ name: "Fable", pct: 12, resetsAt: null }],
    fetchedAt: NOW - 14 * MINUTE,
    consecutiveFailures: 0,
    failing: false,
    backoffUntil: null,
    ...overrides,
  };
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "0f3c9d21-1111-4000-8000-000000000001",
    name: "CHNL: Answering",
    host: "SCOTT",
    lastTool: "Bash",
    lastToolInput: null,
    model: null,
    openingModel: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
    turnCount: 4,
    lastHookAt: NOW - 2 * MINUTE,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

function card(
  reading: UsageReading,
  sessions: readonly SessionView[] = [],
  interimMirror = true,
  unreadable: UsageUnavailableReason | null = null,
): string {
  return renderUsageCard({
    reading,
    sessions,
    thresholds: THRESHOLDS,
    interimMirror,
    unreadable,
    now: NOW,
  });
}

/**
 * The card's fenced blocks, each as the lines inside it.
 *
 * Read by delimiter, and a delimiter is a whole line of exactly three backticks, which is
 * unambiguous here because no backtick at all reaches a fenced body. Every fence the card opens has
 * to be closed, so a card that stopped fencing a section, or fenced only part of one, fails here
 * rather than in whichever assertion happened to notice.
 */
function blocksOf(rendered: string): string[][] {
  const blocks: string[][] = [];
  let open: string[] | null = null;
  for (const line of rendered.split("\n")) {
    if (line !== "```") {
      if (open !== null) open.push(line);
      continue;
    }
    if (open === null) open = [];
    else {
      blocks.push(open);
      open = null;
    }
  }
  assert.equal(open, null, `every fence this card opens is closed again: ${rendered}`);
  return blocks;
}

/** Every line inside a fence, whichever block it came from. */
function fencedLines(rendered: string): string[] {
  return blocksOf(rendered).flat();
}

/**
 * Every line outside every fence: the title, the section headers, the legend, and the footer. Split
 * by position rather than by matching text, so a plain line that happens to read the same as a
 * fenced one is still returned.
 */
function plainLines(rendered: string): string[] {
  const plain: string[] = [];
  let inside = false;
  for (const line of rendered.split("\n")) {
    if (line === "```") inside = !inside;
    else if (!inside) plain.push(line);
  }
  return plain;
}

/**
 * The card's closing lines: everything after the last fence, which is where the overflow tail, the
 * marker legend, and the footer live now that each is a plain line rather than a fenced one.
 */
function closingOf(rendered: string): string[] {
  const lines = rendered.split("\n");
  return lines.slice(lines.lastIndexOf("```") + 1);
}

/**
 * The column every value on a card starts in, read off a row whose bar has at least one cell.
 *
 * Read rather than trimmed, because a bar of no cells is a run of spaces and trimming it away would
 * leave a zero row's assertions unable to tell an empty bar from the padding that aligns the labels,
 * which is the one thing those assertions are for.
 */
function valueColumn(rendered: string): number {
  const drawn = fencedLines(rendered).find((line) => line.includes(BAR_GLYPH)) ?? "";
  const column = drawn.indexOf(BAR_GLYPH);
  assert.notEqual(column, -1, `some row on this card draws a bar to read the column off: ${rendered}`);
  return column;
}

/** The value drawn beside a label, bar included, without the padding that aligns the label column. */
function value(rendered: string, label: string): string {
  const line = fencedLines(rendered).find((text) => text.startsWith(`${label} `)) ?? "";
  return line.slice(valueColumn(rendered));
}

/**
 * A row's value as the card composes one: a bar filled to this many cells and blank to the right of
 * them, the percentage right-aligned under every other row's, and whatever the row carries after it.
 */
function rowValue(cells: number, pct: string, tail = ""): string {
  return `${BAR_GLYPH.repeat(cells)}${" ".repeat(BAR_CELLS - cells)}${pct.padStart(PCT_WIDTH)}${tail}`;
}

/** How many cells of a row's bar are filled. */
function filledCells(rendered: string, label: string): number {
  return [...value(rendered, label)].filter((character) => character === BAR_GLYPH).length;
}

/**
 * The fenced rows carrying a marker. Scoped to the rows rather than read off the whole card,
 * because the legend at the foot names both markers whenever either one is drawn.
 */
function markedRows(rendered: string, marker: string): string[] {
  return fencedLines(rendered).filter((line) => line.includes(marker));
}

/** The one bold line naming an account, which is the surface the label renders on. */
function accountHeader(rendered: string): string {
  return rendered.split("\n").find((line) => line.startsWith("**") && line !== "**Sessions**") ?? "";
}

/** What an account's bold line carries between its emphasis marks. */
function headerText(rendered: string): string {
  return accountHeader(rendered).slice("**".length, -"**".length);
}

test("an account renders a bold label and a row per window, with reset times derived from now", () => {
  const body = card({ available: true, accounts: [account({ active: true })] });

  assert.match(body, /^\*\*▶ one@example\.test · 14m ago\*\*$/m);
  assert.equal(value(body, "5 Hr"), rowValue(7, "46%", "  3h 44m"));
  assert.equal(value(body, "7 Day"), rowValue(8, "56%", "  4d 6h (^)"));
  assert.equal(
    value(body, "Fable"),
    rowValue(2, "12%"),
    "a window with no reset time draws its percentage and stops",
  );
  assert.equal(value(body, "Spend"), rowValue(1, "6%", "  $95.40"));
});

test("a window's bar is its percentage rounded to nearest fifteenth, and never empty above zero", () => {
  // Hand-checked against the 100/15 of a point one cell stands for: 46% is 6.9 cells and draws 7,
  // 50% is 7.5 and draws 8, 96% is 14.4 and draws 14. The bottom of the table is the floor rather
  // than the rounding, and the floor reads the raw percentage: 0.4% draws a cell beside a rounded
  // 0%, because a bar identical to zero's is what leaves a trace and a true zero looking the same,
  // which is the reading the bar is on the card to give. The top of the scale carries no matching
  // ceiling, so 97% upwards fills every cell.
  const cases: [number, number][] = [
    [-5, 0],
    [0, 0],
    [0.4, 1],
    [0.6, 1],
    [3, 1],
    [10, 2],
    [46, 7],
    [50, 8],
    [96, 14],
    [97, 15],
    [100, 15],
    [1e20, 15],
  ];

  for (const [pct, cells] of cases) {
    const body = card({
      available: true,
      accounts: [
        account({
          fiveHour: { pct, resetsAt: null },
          sevenDay: null,
          scoped: [],
          // A row with a bar of its own, so the column every value starts in can be read off the
          // card even when the window under test draws no cell at all.
          spend: { pct: 50, used: null, limit: null, currency: null },
        }),
      ],
    });

    assert.equal(filledCells(body, "5 Hr"), cells, `${pct}% draws ${cells} cells`);
    assert.equal(
      value(body, "5 Hr").slice(0, BAR_CELLS),
      `${BAR_GLYPH.repeat(cells)}${" ".repeat(BAR_CELLS - cells)}`,
      "filled from the left and blank to the right, so the columns after the bar never move",
    );
  }
});

test("a trace of usage draws a cell beside the zero it rounds to, and a true zero draws none", () => {
  // The two rows the floor exists to separate. Both read `0%`, and the bar is the only thing on the
  // card that tells the operator one window has been touched and the other has not.
  const anchor = { pct: 50, used: null, limit: null, currency: null };
  const trace = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 0.4, resetsAt: null }, sevenDay: null, scoped: [], spend: anchor })],
  });
  const none = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 0, resetsAt: null }, sevenDay: null, scoped: [], spend: anchor })],
  });

  assert.equal(value(trace, "5 Hr"), rowValue(1, "0%"));
  assert.equal(value(none, "5 Hr"), rowValue(0, "0%"));
});

test("each account is its own bold label and its own fence, and the sessions are one more pair", () => {
  // The shape the card is read by: a label names a section and the fence under it holds that
  // section's columns, so three accounts are three visual boundaries rather than twelve near
  // identical lines the operator has to count rows through.
  const body = card(
    {
      available: true,
      accounts: [account({ number: 1 }), account({ number: 2 }), account({ number: 3 })],
    },
    [view()],
  );

  // The name twice, the way the status card draws its own: the first line is what Discord puts
  // inline beside the bot's name and into a phone notification, and the heading under it is the
  // card's own top edge in a channel that scrolls.
  assert.deepEqual(body.split("\n").slice(0, 2), ["📊 **Fleet: Usage**", "# 📊 Fleet: Usage"]);
  assert.equal(blocksOf(body).length, 4, "three accounts and the sessions");
  assert.equal(body.split("\n").filter((line) => line === "```").length, 8, "two delimiters a block");
  assert.equal(
    body.split("\n").filter((line) => line.startsWith("**") && line.endsWith("**")).length,
    4,
    "one label a block, each outside the fence it heads",
  );
  assert.match(body, /^\*\*Sessions\*\*$/m);
  // Bold rather than a heading of any rank: Discord puts a margin above a heading and around a
  // fenced block, and at one section per account that margin is paid down the whole card.
  assert.doesNotMatch(body, /^#{2,}/m, "no heading below the title's own");
});

test("the percentages stack in one column across every block, whatever a block's labels are", () => {
  // The property that lets two accounts be compared by eye: the column is measured over the whole
  // card rather than per block, so a per-model window one account carries and another does not
  // cannot step the numbers sideways between them.
  const body = card({
    available: true,
    accounts: [
      account({ number: 1, scoped: [] }),
      account({ number: 2, scoped: [{ name: "a-long-model-name", pct: 7, resetsAt: null }] }),
      account({ number: 3, spend: null }),
    ],
  });

  const rows = fencedLines(body).filter((line) => line.includes("%"));
  assert.equal(rows.length, 10, "three windows on the first, four on the second, three on the third");
  assert.equal(
    new Set(rows.map((line) => line.indexOf("%"))).size,
    1,
    `every percentage ends in one column: ${rows.join(" | ")}`,
  );
  assert.equal(
    new Set(rows.filter((line) => /% {2}\S/.test(line)).map((line) => line.indexOf("%") + 3)).size,
    1,
    "and every clause starts in one column",
  );
});

test("no row carries trailing whitespace, since a marker is not padded to a column of its own", () => {
  const body = card({
    available: true,
    accounts: [
      account({ number: 1, fiveHour: { pct: 0, resetsAt: null }, spend: null }),
      account({ number: 2, scoped: [{ name: "Fable", pct: 96, resetsAt: NOW + 2 * 24 * HOUR }] }),
    ],
  });

  for (const line of fencedLines(body)) {
    assert.equal(line, line.trimEnd(), `no trailing whitespace: ${JSON.stringify(line)}`);
  }
});

test("a hostile account label manufactures nothing in the bold line it occupies", () => {
  // The label sits outside its fence, which is the one way this shape can be less safe than a fenced
  // one: a fence renders no markdown and draws no pill, and a bold paragraph line renders both. So
  // the label takes the neutralization the session card's title takes, and what a crafted address
  // reaches the operator as is the characters it contains.
  // Held inside the label's own cap, so what the assertions read is the whole neutralized label
  // rather than the head of one: this is the escaping under test, not the cut.
  const body = card({
    available: true,
    accounts: [account({ active: true, email: "<@1>#```*b*_u_~s~|p|[l](r)\nsecond line" })],
  });
  const header = accountHeader(body);
  const label = headerText(body).slice("▶ ".length);

  assert.match(header, /^\*\*▶ /, "the renderer's own marker, inside the emphasis it opens");
  assert.match(header, /\*\*$/, "and the emphasis closed at the end of the line");
  assert.match(label, /\\<@1\\>/, "no mention pill: the chip syntax is escaped");
  assert.match(label, /\\\*b\\\*/, "the asterisks are escaped, so the label cannot close the span");
  assert.doesNotMatch(
    label,
    /(?<!\\)[<>#*_~|`[\]()]/,
    `every character Discord builds syntax from is escaped: ${label}`,
  );
  assert.match(label, /second line/, "the newline collapses to a space rather than breaking the line");
  assert.deepEqual(
    body.split("\n").filter((line) => line.startsWith("#")),
    ["# 📊 Fleet: Usage"],
    "the label composes no heading of its own, and the card's own title is the only one on it",
  );
  for (const line of plainLines(body)) {
    assert.doesNotMatch(line, /(?<!\\)`/, `every backtick outside a fence is escaped: ${line}`);
  }
});

test("a label made of nothing but syntax still draws one inert bold line", () => {
  const body = card({
    available: true,
    accounts: [account({ email: "```#*_~|[]()<>", organizationName: null })],
  });

  assert.equal(blocksOf(body).length, 1, "the label neither opens nor closes a fence");
  assert.equal(body.split("\n").filter((line) => line.startsWith("**")).length, 1);
  assert.doesNotMatch(headerText(body).slice("· ".length), /(?<!\\)[<>#*_~|`[\]()]/);
});

test("an account label is bounded, and one that neutralizes to nothing falls back to the slot", () => {
  const long = card({
    available: true,
    accounts: [account({ email: `${"a".repeat(200)}@accounts.example.test` })],
  });
  const empty = card({
    available: true,
    accounts: [account({ number: 4, email: "​​", organizationName: null })],
  });

  const label = headerText(long).slice("· ".length).replace(/ · 14m ago$/, "");
  assert.equal([...label].length, MAX_ACCOUNT_LABEL_LENGTH);
  assert.match(
    empty,
    /^\*\*· account 4 · 14m ago\*\*$/m,
    "the slot number is the one part this broker owns",
  );
});

test("no crafted cache string can break out of a fenced block", () => {
  // A fenced body carries no backtick at all, which is the only bound a crafted field cannot compose
  // around. Escaping one would not do it: a fenced block honors no backslash escape, so an escaped
  // backtick arrives as a backslash and a live backtick, and three of those close the block. This is
  // narrower than a card-wide ban because a bold line is not a fence: a backtick there is escaped and
  // inert, which the label tests pin.
  const body = card(
    {
      available: true,
      accounts: [
        account({
          email: "``` fenced",
          organizationName: null,
          scoped: [{ name: "`".repeat(200), pct: 1, resetsAt: null }],
        }),
      ],
    },
    [view({ name: "two\nlines \\`" })],
  );

  for (const line of fencedLines(body)) {
    assert.doesNotMatch(line, /`/, `no backtick inside a fenced body: ${line}`);
  }
  assert.match(body, /twolines/, "the newline is stripped, never a line break");
});

test("every fenced line stays inside the width bound at a worst case of accounts and windows", () => {
  // A phone scrolls a code block sideways rather than wrapping it, so one line past the bound costs
  // a drag across the whole card. Driven at the widest inputs the cache can hand over: the longest
  // account labels, per-model rows named at their own cap, and the longest session names. The bound
  // is a property of the fenced lines alone; a bold line outside a fence wraps rather than scrolls.
  const accounts = Array.from({ length: 4 }, (_unused, index) =>
    account({
      number: index + 1,
      email: `a-very-long-account-address-${index}@accounts.example.test`,
      active: index === 0,
      failing: true,
      backoffUntil: NOW + 15 * MINUTE,
      consecutiveFailures: 12,
      spend: { pct: 99.6, used: 1499.99, limit: 1500, currency: "USDOLLAR" },
      scoped: [
        { name: "a-per-model-window-named-long", pct: 99, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR },
        { name: "Opus", pct: 56, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR },
      ],
    }),
  );
  const sessions = Array.from({ length: 6 }, (_unused, index) =>
    view({ sessionId: `session-${index}`, name: `CHNL: a session with a fairly long name ${index}` }),
  );

  const body = card({ available: true, accounts }, sessions, false, "unreadable");

  for (const line of fencedLines(body)) {
    assert.ok(
      [...line].length <= MAX_BLOCK_WIDTH,
      `${[...line].length} characters is past the ${MAX_BLOCK_WIDTH} bound: ${line}`,
    );
  }
});

test("a row at its worst case stands inside the width bound with nothing cut off it", () => {
  // The widest a row gets: the label column at the cap a per-model name pushes it to, a bar at every
  // cell, the longest countdown a weekly window can carry, and a marker after it. Measured off the
  // rendered line against the geometry's own parts rather than against a typed transcript of it, so
  // what fails here is a column that moved rather than a string that was retyped.
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: null,
        sevenDay: null,
        spend: null,
        scoped: [{ name: "long-model", pct: 100, resetsAt: NOW + 6 * 24 * HOUR + 23 * HOUR }],
      }),
    ],
  });

  const row = fencedLines(body).find((line) => line.includes("(!)")) ?? "";
  const geometry = valueColumn(body) + BAR_CELLS + PCT_WIDTH + "  6d 23h".length + " (!)".length;

  assert.equal(valueColumn(body), 12, "a ten-character label and the two spaces after it");
  assert.equal([...row].length, geometry, `the row is its parts and nothing else: ${row}`);
  assert.ok(
    [...row].length <= MAX_BLOCK_WIDTH,
    `${[...row].length} characters is past the ${MAX_BLOCK_WIDTH} bound: ${row}`,
  );
  assert.doesNotMatch(row, /…/, "and it reaches the bound whole rather than by being cut to it");
});

test("a marked spend row keeps its money and its marker under the widest label column", () => {
  // The other worst case, and the one a live cache reaches: a four-figure balance at the warning
  // threshold, in the same block as a per-model name that pushes the label column to its cap. The
  // cents are what the amount drops there, and dropping them is what leaves the marker room to stand
  // on the line rather than being cut off the end of it.
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: null,
        sevenDay: null,
        scoped: [{ name: "long-model", pct: 12, resetsAt: null }],
        spend: { pct: 95, used: 13440.5, limit: 15000, currency: "USD" },
      }),
    ],
  });

  const row = fencedLines(body).find((line) => line.startsWith("Spend")) ?? "";

  assert.equal(valueColumn(body), 12, "a ten-character label and the two spaces after it");
  assert.equal(value(body, "Spend"), rowValue(14, "95%", "  $13,440 (!)"));
  assert.ok(
    [...row].length <= MAX_BLOCK_WIDTH,
    `${[...row].length} characters is past the ${MAX_BLOCK_WIDTH} bound: ${row}`,
  );
  assert.doesNotMatch(row, /…/, "nothing was cut to make it fit");
  assert.equal(closingOf(body)[0], "(^) ahead of pace   (!) at or above 90%", "and the legend keys it");
});

test("a row whose value is cut takes the legend down with the marker it lost", () => {
  // A value too wide for the block is cut from the end, which is where the marker sits, so a card
  // can compose a marker and draw none. The legend is keyed off the drawn lines for exactly that
  // case: a key to a symbol nowhere on the card is a puzzle rather than a legend.
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: null,
        sevenDay: null,
        scoped: [{ name: "long-model", pct: 12, resetsAt: null }],
        spend: { pct: 95, used: 12345678901234, limit: null, currency: "USD" },
      }),
    ],
  });

  const row = fencedLines(body).find((line) => line.startsWith("Spend")) ?? "";

  assert.match(row, /…$/, "the amount ran past the block and was cut to it");
  assert.doesNotMatch(body, /\(!\)/, "so no marker reached the card");
  assert.doesNotMatch(body, /at or above/, "and no legend keys one that is not there");
});

test("a cache string that reads as a marker cannot summon the legend on its own", () => {
  // The drawn-line check is read together with the markers the rows earned, never on its own: a
  // per-model name sits in the label column where no line ends, and a currency code can end one.
  // Neither is a marker, and neither may draw the key to the two that are.
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: { pct: 12, resetsAt: null },
        sevenDay: null,
        scoped: [{ name: "(!) Fable", pct: 12, resetsAt: null }],
        spend: { pct: 12, used: 95.4, limit: null, currency: "(!)" },
      }),
    ],
  });

  assert.ok(
    fencedLines(body).some((line) => line.startsWith("(!) Fable")),
    "the name is drawn, in the label column where a value follows it",
  );
  assert.equal(value(body, "Spend"), rowValue(2, "12%", "  95.40 (!)"), "and the code trails the amount");
  assert.doesNotMatch(body, /at or above/, "no row earned a marker, so nothing keys the legend");
});

test("the same reading renders the same bytes, so a quiet fleet spends no edit", () => {
  // The card is edited only when its text changes. Anything that varied between two renders of one
  // reading, a clock read inside the renderer or a width measured off something outside the inputs,
  // would spend an edit a minute on a fleet where nothing happened.
  const reading: UsageReading = {
    available: true,
    accounts: [account({ number: 1, active: true }), account({ number: 2, scoped: [] })],
  };
  const sessions = [view(), view({ sessionId: "b", name: "CHNL: Usage card" })];

  assert.equal(card(reading, sessions), card(reading, sessions));
});

test("a window whose reset time has passed says so rather than counting backwards", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 46, resetsAt: NOW - MINUTE }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(body, "5 Hr"), rowValue(7, "46%", "  due"));
});

test("an account with no spend renders no spend line", () => {
  const body = card({ available: true, accounts: [account({ spend: null })] });

  assert.doesNotMatch(body, /Spend/);
});

test("a stale cache ages honestly instead of reading as fresh", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW - 3 * HOUR })] });

  assert.match(body, /^\*\*· one@example\.test · 3h ago\*\*$/m);
});

test("an account whose usage checks are failing carries a warning line beside its numbers", () => {
  const body = card({
    available: true,
    accounts: [
      account({ failing: true, backoffUntil: NOW + 15 * MINUTE, consecutiveFailures: 3 }),
    ],
  });

  assert.ok(
    fencedLines(body).join(" ").includes("⚠ usage checks failing · backing off · 3 consecutive"),
    fencedLines(body).join(" "),
  );
  assert.equal(
    value(body, "5 Hr"),
    rowValue(7, "46%", "  3h 44m"),
    "the numbers still render, under an honest age",
  );
});

test("a backoff instant that has passed renders no warning at all", () => {
  const body = card({
    available: true,
    accounts: [account({ backoffUntil: NOW - MINUTE })],
  });

  assert.doesNotMatch(body, /usage checks/, "claude-swap leaves the field set once the pause ends");
});

test("a warning with no failures behind it states the trouble without a count", () => {
  const body = card({
    available: true,
    accounts: [account({ backoffUntil: NOW + 15 * MINUTE, consecutiveFailures: 0 })],
  });

  assert.ok(fencedLines(body).join(" ").includes("⚠ usage checks backing off"), fencedLines(body).join(" "));
  assert.doesNotMatch(body, /0 consecutive/);
});

test("the warning marker appears at the threshold and not below it", () => {
  const below = card({
    available: true,
    accounts: [account({ fiveHour: { pct: WARNING_PCT - 1, resetsAt: null }, sevenDay: null, scoped: [] })],
  });
  const at = card({
    available: true,
    accounts: [account({ fiveHour: { pct: WARNING_PCT, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(below, "5 Hr"), rowValue(13, "89%"));
  assert.equal(
    value(at, "5 Hr"),
    rowValue(14, "90%", " (!)"),
    "the marker ends the row, where it moves no column",
  );
});

test("the warning follows the percentage as drawn, not the one behind it", () => {
  // Both of these render as 90%. A threshold read off the raw value would warn on one and not the
  // other, leaving two identical-looking rows marked differently.
  const under = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 89.6, resetsAt: null }, sevenDay: null, scoped: [] })],
  });
  const over = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 90.4, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(under, "5 Hr"), rowValue(14, "90%", " (!)"));
  assert.equal(value(over, "5 Hr"), rowValue(14, "90%", " (!)"));
});

test("a window at the threshold draws the warning alone, never the pace marker too", () => {
  // At or past the threshold a window is almost always ahead of pace as well, so a row that could
  // carry two markers would carry them on the common case, and its end column would move.
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: null,
        sevenDay: { pct: 95, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR },
        scoped: [],
        spend: null,
      }),
    ],
  });

  assert.equal(value(body, "7 Day"), rowValue(14, "95%", "  4d 6h (!)"));
  assert.deepEqual(markedRows(body, "(^)"), []);
});

test("the legend appears only when a marker is on the card", () => {
  const marked = card({
    available: true,
    accounts: [account({ scoped: [{ name: "Fable", pct: 96, resetsAt: NOW + 2 * 24 * HOUR }] })],
  });
  const quiet = card({
    available: true,
    accounts: [
      account({
        fiveHour: { pct: 2, resetsAt: NOW + HOUR },
        sevenDay: null,
        scoped: [],
        spend: { pct: 6.36, used: 95.4, limit: 1500, currency: "USD" },
      }),
    ],
  });

  assert.equal(closingOf(marked)[0], "(^) ahead of pace   (!) at or above 90%");
  assert.doesNotMatch(quiet, /ahead of pace/, "no key to symbols that are not on the card");
  assert.doesNotMatch(quiet, /at or above/);
});

// The pace marker mirrors claude-swap's own rule (its `pace.py`): a 7-day period, elapsed measured
// from the reading's fetch time, nothing inside the first day of a window, and a 15-point gap. The
// fixture above is an ahead case by that arithmetic: 65.8 hours into the week puts 39% on schedule
// against 56% spent.
test("a weekly window inside the pace margin carries no marker", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 50, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR } })],
  });

  assert.equal(
    value(body, "7 Day"),
    rowValue(8, "50%", "  4d 6h"),
    "10.9 points over schedule is inside the margin",
  );
});

test("the five-hour window carries no pace marker on numbers that would mark a weekly one", () => {
  const body = card({
    available: true,
    accounts: [
      account({
        fiveHour: { pct: 56, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR },
        sevenDay: null,
        scoped: [],
      }),
    ],
  });

  assert.equal(
    value(body, "5 Hr"),
    rowValue(8, "56%", "  4d 6h"),
    "a 5h window resets too fast for pace to mean anything",
  );
});

test("a weekly window in its first day after a reset carries no marker", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 99, resetsAt: NOW + 6 * 24 * HOUR + 22 * HOUR } })],
  });

  assert.deepEqual(markedRows(body, "(^)"), [], "two hours in, almost any usage reads as far ahead");
});

test("a weekly window whose reset has passed is drawn for the period it is in now", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 99, resetsAt: NOW - MINUTE }, scoped: [] })],
  });

  // The last-written 99% belongs to a window that no longer exists. Drawn against a boundary that is
  // gone, it would report no headroom at the moment a full week of it opened up.
  assert.equal(value(body, "7 Day"), rowValue(0, "0%", "  6d 23h"), "a bar with no cell at all");
  assert.doesNotMatch(body, /99%/);
  assert.deepEqual(markedRows(body, "(^)"), [], "a period with no measured spend is not ahead of anything");
});

test("a reset several periods back rolls to the next future boundary, not to the first one missed", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 66, resetsAt: NOW - 15 * 24 * HOUR }, scoped: [] })],
  });

  assert.equal(
    value(body, "7 Day"),
    rowValue(0, "0%", "  6d 0h"),
    "three whole weeks past a boundary fifteen days old",
  );
});

test("a per-model window rolls the same way and drops its maxed warning with the period", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: null, scoped: [{ name: "Fable", pct: 100, resetsAt: NOW - MINUTE }] })],
  });

  assert.equal(value(body, "Fable"), rowValue(0, "0%", "  6d 23h"));
  assert.deepEqual(markedRows(body, "(!)"), [], "a dropped warning leaves no marker on the card");
  assert.doesNotMatch(body, /at or above/, "and no legend either, since nothing keys it");
});

test("the five-hour window is never rolled, whatever its reset instant says", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 46, resetsAt: NOW - MINUTE }, sevenDay: null, scoped: [] })],
  });

  assert.equal(
    value(body, "5 Hr"),
    rowValue(7, "46%", "  due"),
    "a 5h window does not reset on the weekly cadence",
  );
});

test("a fetch time the card will not believe rolls nothing", () => {
  const body = card({
    available: true,
    accounts: [
      account({ fetchedAt: NOW + 10 * MINUTE, sevenDay: { pct: 66, resetsAt: NOW - MINUTE }, scoped: [] }),
    ],
  });

  assert.match(body, /^\*\*· one@example\.test · age unknown\*\*$/m);
  assert.equal(
    value(body, "7 Day"),
    rowValue(10, "66%", "  due"),
    "no trustworthy measurement time is no ground for a fresh period",
  );
});

test("a scoped window carries the marker, and a maxed one carries the warning alone", () => {
  const ahead = card({
    available: true,
    accounts: [account({ scoped: [{ name: "Fable", pct: 56, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR }] })],
  });
  const maxed = card({
    available: true,
    accounts: [account({ scoped: [{ name: "Fable", pct: 100, resetsAt: NOW + 4 * 24 * HOUR + 6 * HOUR }] })],
  });

  assert.equal(value(ahead, "Fable"), rowValue(8, "56%", "  4d 6h (^)"));
  assert.equal(value(maxed, "Fable"), rowValue(15, "100%", "  4d 6h (!)"));
});

test("a fetch time the card will not believe takes the pace marker down with the age", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW + 10 * MINUTE })] });

  assert.deepEqual(markedRows(body, "(^)"), [], "pace is measured from the fetch time or not at all");
});

test("a spend at the threshold carries the warning marker the windows use", () => {
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 89.6, used: 1344, limit: 1500, currency: "USD" } })],
  });

  assert.equal(
    value(body, "Spend"),
    rowValue(14, "90%", "  $1,344 (!)"),
    "the same rounding, so the same threshold",
  );
});

test("spend amounts render as money rather than as the double behind it", () => {
  // The live cache's own record: a fractional used amount, drawn with grouped thousands, two decimal
  // places, and a trailing .00 dropped, under the symbol for a currency code this renderer knows.
  const live = card({
    available: true,
    accounts: [account({ spend: { pct: 6.36, used: 95.4, limit: 1500, currency: "USD" } })],
  });
  assert.equal(value(live, "Spend"), rowValue(1, "6%", "  $95.40"));

  // A float sum's noise is rounded to the cent.
  const noisy = card({
    available: true,
    accounts: [account({ spend: { pct: 1, used: 0.1 + 0.2, limit: 1500.5, currency: "USD" } })],
  });
  assert.equal(value(noisy, "Spend"), rowValue(1, "1%", "  $0.30"));

  // Grouping recurs every three digits, not only once.
  const large = card({
    available: true,
    accounts: [account({ spend: { pct: 50, used: 1234567.89, limit: 2500000, currency: "USD" } })],
  });
  assert.equal(value(large, "Spend"), rowValue(8, "50%", "  $1,234,567"));
});

test("an amount of a thousand and up is drawn whole, and one below it keeps its cents", () => {
  // Three characters of cents on a four-figure balance are what pushes a row past the block's width
  // beside a bar of fifteen cells, and they are the digits worth least: what a four-figure spend is
  // read for is its scale. The line sits at a thousand, so the mock's own $95.40 is untouched.
  const spent = (used: number): string => {
    const body = card({
      available: true,
      accounts: [account({ spend: { pct: 50, used, limit: null, currency: "USD" } })],
    });
    return value(body, "Spend").slice(BAR_CELLS + PCT_WIDTH + "  ".length);
  };

  assert.equal(spent(999.99), "$999.99", "the last amount that keeps its cents");
  assert.equal(spent(1000), "$1,000");
  assert.equal(spent(1500), "$1,500");
  assert.equal(spent(13440.5), "$13,440", "the cents are dropped, not rounded up into the dollars");
  assert.equal(spent(-13440.5), "$-13,440", "the magnitude decides, so a negative drops them too");
  assert.equal(spent(-95.4), "$-95.40");
});

test("a spend row carries what was spent and never the limit beside it", () => {
  // The percentage says how much of the budget is gone and the bar says it again at a glance, so the
  // ceiling is a third telling of one fact in columns the bar is drawn in instead.
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 6.36, used: 95.4, limit: 1500, currency: "USD" } })],
  });

  // Read off the rows rather than the whole card, since the legend's own key to the pace marker
  // reads "ahead of pace".
  for (const line of fencedLines(body)) {
    assert.doesNotMatch(line, / of /, `no ratio on a row: ${line}`);
  }
  assert.doesNotMatch(body, /1,500/, "and no ceiling anywhere on the card");
});

test("a spend the cache gave no amount for draws its percentage and stops", () => {
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 6.36, used: null, limit: 1500, currency: "USD" } })],
  });

  assert.equal(value(body, "Spend"), rowValue(1, "6%"), "a limit alone is nothing the row will draw");
});

test("a spend with an amount and no limit behind it still draws the amount", () => {
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 6.36, used: 95.4, limit: null, currency: "USD" } })],
  });

  assert.equal(value(body, "Spend"), rowValue(1, "6%", "  $95.40"));
});

test("no row on the card carries the word the bar beside it replaced", () => {
  const body = card({
    available: true,
    accounts: [account({ active: true }), account({ number: 2, spend: null })],
  });

  assert.doesNotMatch(body, /resets/, "the bar is what says how far through a window an account is");
});

test("an unknown currency code keeps its shape after the amount rather than guessing a symbol", () => {
  // A symbol is substituted only on an exact match against the renderer's own tiny map, never
  // composed from the cache's string, which stays bounded and neutralized like every other field.
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 6, used: 95.4, limit: 1500, currency: "EUR" } })],
  });

  assert.equal(value(body, "Spend"), rowValue(1, "6%", "  95.40 EUR"));
});

test("a nonsense percentage is bounded rather than drawn in full", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 1e20, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(body, "5 Hr"), rowValue(15, "999%", " (!)"));
});

test("a scoped row whose name neutralizes to nothing keeps a label", () => {
  const body = card({
    available: true,
    accounts: [account({ scoped: [{ name: "​​", pct: 12, resetsAt: null }] })],
  });

  assert.equal(
    value(body, "per-model"),
    rowValue(2, "12%"),
    "zero-width characters survive a trim and are stripped later",
  );
});

test("the footer ages the card off the oldest reading on it", () => {
  const body = card({
    available: true,
    accounts: [account({ number: 1, fetchedAt: NOW - 2 * MINUTE }), account({ number: 2, fetchedAt: NOW - 3 * HOUR })],
  });

  assert.ok(closingOf(body).join(" ").endsWith("card as of 3h ago"), closingOf(body).join(" "));
});

test("a held reading keeps its numbers and says the cache behind them is down", () => {
  // The numbers stand because they are the best answer available, and the marker is what keeps
  // them from reading as a cache that is still answering.
  const body = card({ available: true, accounts: [account()] }, [], true, "unreadable");

  assert.equal(value(body, "5 Hr"), rowValue(7, "46%", "  3h 44m"));
  assert.ok(
    closingOf(body)
      .join(" ")
      .endsWith(
        "⚠ the usage cache cannot be read on this host, so these are the last numbers it held · " +
          "card as of 14m ago",
      ),
    closingOf(body).join(" "),
  );
});

test("a card drawn from a live reading carries no held marker", () => {
  const body = card({ available: true, accounts: [account()] });

  assert.doesNotMatch(body, /last numbers it held/);
});

test("the footer names interim mirroring only while it is off", () => {
  const on = card({ available: true, accounts: [account()] }, [], true);
  const off = card({ available: true, accounts: [account()] }, [], false);

  assert.doesNotMatch(on, /interim mirroring/);
  assert.ok(
    closingOf(off)
      .join(" ")
      .endsWith(
        "card as of 14m ago · interim mirroring off, so threads carry no narration or question alerts",
      ),
    closingOf(off).join(" "),
  );
});

test("hostile strings inside a fenced block render as their characters", () => {
  // Inside a block Discord resolves no chip and draws no pill, so the syntax reaches the operator
  // as the characters it is, with no escape in front of it. What a crafted string still cannot do
  // is close the block: no backtick survives into a fenced body.
  const body = card(
    {
      available: true,
      accounts: [account({ scoped: [{ name: "<#999>", pct: 1, resetsAt: null }] })],
    },
    [view({ name: "`code` <@everyone>" })],
  );

  assert.equal(value(body, "<#999>"), rowValue(1, "1%"), "the characters, with no visible backslash");
  assert.ok(
    fencedLines(body).some((line) => line.includes("'code' <@everyone>")),
    fencedLines(body).join(" | "),
  );
});

test("live sessions render one row each and ended ones are omitted", () => {
  const body = card({ available: true, accounts: [] }, [
    view({ sessionId: "a", name: "CHNL: Answering" }),
    view({ sessionId: "b", name: "CHNL: Usage card", lastHookAt: NOW - 30 * MINUTE }),
    view({ sessionId: "c", name: "CHNL: Finished", lifecycle: "ended", endedAt: NOW - MINUTE }),
  ]);

  assert.match(body, /^CHNL: Answering · working · 2m$/m);
  assert.match(body, /^CHNL: Usage card · idle · 30m$/m);
  assert.match(body, /^\*\*Sessions\*\*$/m);
  assert.doesNotMatch(body, /Finished/);
});

test("a fleet with no live session draws no sessions section at all", () => {
  const body = card({ available: true, accounts: [account()] });

  assert.doesNotMatch(body, /Sessions/, "a section with nothing to show is left out, not drawn empty");
  assert.equal(blocksOf(body).length, 1);
});

test("a reading that parsed but holds no accounts says so rather than titling an empty card", () => {
  const body = card({ available: true, accounts: [] });

  assert.ok(fencedLines(body).join(" ").includes("no accounts"), fencedLines(body).join(" "));
});

test("a fetch time in the future reads as unknown rather than as fresh", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW + 10 * MINUTE })] });

  assert.match(body, /· age unknown\*\*$/m);
  assert.doesNotMatch(body, /just now/);
});

test("an unavailable reading says so and still carries the session section", () => {
  const body = card({ available: false, reason: "malformed" }, [view()]);

  assert.match(body, /usage unavailable/);
  assert.match(body, /CHNL: Answering/);
});

test("a full fleet stays inside the card ceiling and says what it left out", () => {
  // The spend is over the threshold on every account, so the legend is on this card too: its room
  // is reserved before the first block is measured, exactly as the footer's is, which is what keeps
  // a card that ran out of room from dropping the key to the markers it is drawing.
  const accounts = Array.from({ length: 16 }, (_unused, index) =>
    account({
      number: index + 1,
      email: `account-with-a-long-address-${index}@example.test`,
      organizationName: `Organization number ${index}`,
      spend: { pct: 95, used: 1425, limit: 1500, currency: "USD" },
    }),
  );
  const sessions = Array.from({ length: 40 }, (_unused, index) =>
    view({ sessionId: `session-${index}`, name: `CHNL: a session with a fairly long name ${index}` }),
  );

  const body = card({ available: true, accounts }, sessions);

  assert.ok(
    body.length <= MAX_CARD_LENGTH,
    `the card must stay inside ${MAX_CARD_LENGTH}, rendered ${body.length}`,
  );
  assert.deepEqual(closingOf(body).slice(1), [
    "(^) ahead of pace   (!) at or above 90%",
    "card as of 14m ago",
  ]);
  assert.match(
    closingOf(body)[0] ?? "",
    /^\(\+\d+ accounts, \+40 sessions not shown\)$/,
    "the accounts run out of room first, and the tail names both of what it dropped",
  );
});

test("a host with few accounts and many sessions overflows on the sessions alone", () => {
  const sessions = Array.from({ length: 60 }, (_unused, index) =>
    view({ sessionId: `session-${index}`, name: `CHNL: a session with a fairly long name ${index}` }),
  );

  const body = card({ available: true, accounts: [account()] }, sessions);

  assert.ok(
    body.length <= MAX_CARD_LENGTH,
    `the card must stay inside ${MAX_CARD_LENGTH}, rendered ${body.length}`,
  );
  assert.match(
    body,
    /^\*\*· one@example\.test · 14m ago\*\*$/m,
    "the account's label line survives whole",
  );
  assert.equal(value(body, "5 Hr"), rowValue(7, "46%", "  3h 44m"), "and so do its windows");
  assert.match(
    closingOf(body)[0] ?? "",
    /^\(\+\d+ sessions not shown\)$/,
    "no account was dropped, so the tail names sessions alone",
  );
  assert.equal(closingOf(body).at(-1), "card as of 14m ago", "the footer's room is reserved, so it survives");
});
