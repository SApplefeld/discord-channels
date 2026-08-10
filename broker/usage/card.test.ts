import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BLOCK_WIDTH, MAX_CARD_LENGTH } from "../discord/render.ts";
import type { SessionView, StateThresholds } from "../discord/state.ts";
import type { UsageAccount, UsageReading, UsageUnavailableReason } from "./cache.ts";
import { WARNING_PCT, renderUsageCard } from "./card.ts";

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
 * The card's body: the lines inside the fence. Everything below the heading is inside one, so a
 * card that stopped fencing its body, or fenced only part of it, fails here rather than in the one
 * assertion that happened to notice.
 */
function bodyOf(rendered: string): string[] {
  const lines = rendered.split("\n");
  assert.equal(lines[1], "```", rendered);
  assert.equal(lines.at(-1), "```", rendered);
  return lines.slice(2, -1);
}

/** The body read as one string, which is how a sentence wrapped across lines is read back whole. */
function flat(rendered: string): string {
  return bodyOf(rendered).join(" ");
}

/** The value drawn beside a label, without the padding that aligns it. */
function value(rendered: string, label: string): string {
  const line = bodyOf(rendered).find((text) => text.startsWith(`${label} `)) ?? "";
  return line.slice(label.length).trimStart();
}

test("an account renders a line per window, with reset times derived from now", () => {
  const body = card({ available: true, accounts: [account({ active: true })] });

  assert.match(body, /^▶ one@example\.test · as of 14m ago$/m);
  assert.equal(value(body, "5h"), "46% · resets 3h 44m");
  assert.equal(value(body, "7d"), "56% · resets 4d 6h · ahead of pace");
  assert.equal(value(body, "Fable"), "12%", "a window with no reset time renders without the clause");
  assert.equal(value(body, "spend"), "6% · $95.40 of $1,500");
});

test("the heading is outside the fence and the body inside it, in one aligned column", () => {
  // The split is what the two halves need: the heading is the line a channel list and a
  // notification show, where Discord draws bold, and the body is a table, which only a block keeps
  // in columns. Every value starts in the same place, whatever its label is called.
  const body = card(
    { available: true, accounts: [account({ active: true, scoped: [{ name: "Fable", pct: 12, resetsAt: null }] })] },
    [view()],
  );

  assert.equal(body.split("\n")[0], "📊 **Fleet: Usage**");
  const labelled = bodyOf(body).filter((line) => /^(5h|7d|Fable|spend) /.test(line));
  assert.equal(labelled.length, 4);
  const columns = new Set(labelled.map((line) => line.length - line.replace(/^\S+ +/, "").length));
  assert.equal(columns.size, 1, `every value starts in one column: ${labelled.join(" | ")}`);
  assert.match(bodyOf(body).join("\n"), /^Sessions$/m, "the sessions heading loses its bold too");
});

test("a field inside the body reads as its characters, and none composes markdown of its own", () => {
  // Inside a block Discord draws no markdown at all, so a label carrying asterisks reaches the
  // operator as those characters with no escape in front of them, and nothing this renderer
  // composes into the body relies on emphasis rendering.
  const body = card(
    { available: true, accounts: [account({ email: "**boss**" })] },
    [view({ name: "**loud**" })],
  );

  assert.ok(flat(body).includes("**boss**"), flat(body));
  assert.doesNotMatch(flat(body), /\\\*/, "no visible backslash in front of an asterisk");
});

test("no crafted cache string can break out of the usage card's fence", () => {
  // The body carries no backtick at all, which is the only bound a crafted field cannot compose
  // around: Discord processes a backslash escape inside a fence, so an escaped backtick arrives as
  // a real one and three of those close the block. The backslash is escaped rather than replaced,
  // because that same processing is what draws a path readably. The newline dies in the invisible
  // strip, so no field composes a body line of its own.
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

  const delimiters = body.split("\n").filter((line) => line.includes("`"));
  assert.deepEqual(
    delimiters,
    ["```", "```"],
    "exactly the two fence delimiters, and no other line carries a backtick",
  );
  for (const line of bodyOf(body)) {
    assert.doesNotMatch(line, /`/, `no backtick inside the body: ${line}`);
  }
  assert.match(body, /twolines/, "the newline is stripped, never a line break");
});

test("the body stays inside the width bound at a worst case of accounts and per-model windows", () => {
  // A phone scrolls a code block sideways rather than wrapping it, so one line past the bound costs
  // a drag across the whole card. Driven at the widest inputs the cache can hand over: the longest
  // account labels, per-model rows named at their own cap, and the longest session names.
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

  for (const line of bodyOf(body)) {
    assert.ok(
      [...line].length <= MAX_BLOCK_WIDTH,
      `${[...line].length} characters is past the ${MAX_BLOCK_WIDTH} bound: ${line}`,
    );
  }
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

  assert.equal(value(body, "5h"), "46% · resets due");
});

test("an account with no spend renders no spend line", () => {
  const body = card({ available: true, accounts: [account({ spend: null })] });

  assert.doesNotMatch(body, /spend/);
});

test("a stale cache ages honestly instead of reading as fresh", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW - 3 * HOUR })] });

  assert.match(body, /as of 3h ago/);
});

test("an account whose usage checks are failing carries a warning line beside its numbers", () => {
  const body = card({
    available: true,
    accounts: [
      account({ failing: true, backoffUntil: NOW + 15 * MINUTE, consecutiveFailures: 3 }),
    ],
  });

  assert.ok(flat(body).includes("⚠ usage checks failing · backing off · 3 consecutive"), flat(body));
  assert.equal(value(body, "5h"), "46% · resets 3h 44m", "the numbers still render, under an honest age");
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

  assert.ok(flat(body).includes("⚠ usage checks backing off"), flat(body));
  assert.doesNotMatch(body, /0 consecutive/);
});

test("the warning glyph appears at the threshold and not below it", () => {
  const below = card({
    available: true,
    accounts: [account({ fiveHour: { pct: WARNING_PCT - 1, resetsAt: null }, sevenDay: null, scoped: [] })],
  });
  const at = card({
    available: true,
    accounts: [account({ fiveHour: { pct: WARNING_PCT, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(below, "5h"), "89%");
  assert.equal(value(at, "5h"), "⚠ 90%", "the glyph leads the value, never the aligning column");
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

  assert.equal(value(under, "5h"), "⚠ 90%");
  assert.equal(value(over, "5h"), "⚠ 90%");
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

  assert.equal(value(body, "7d"), "50% · resets 4d 6h", "10.9 points over schedule is inside the margin");
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

  assert.equal(value(body, "5h"), "56% · resets 4d 6h", "a 5h window resets too fast for pace to mean anything");
});

test("a weekly window in its first day after a reset carries no marker", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 99, resetsAt: NOW + 6 * 24 * HOUR + 22 * HOUR } })],
  });

  assert.doesNotMatch(body, /ahead of pace/, "two hours in, almost any usage reads as far ahead");
});

test("a weekly window whose reset has passed is drawn for the period it is in now", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 99, resetsAt: NOW - MINUTE }, scoped: [] })],
  });

  // The last-written 99% belongs to a window that no longer exists. Drawn against a boundary that is
  // gone, it would report no headroom at the moment a full week of it opened up.
  assert.equal(value(body, "7d"), "0% · resets 6d 23h");
  assert.doesNotMatch(body, /99%/);
  assert.doesNotMatch(body, /ahead of pace/, "a period with no measured spend is not ahead of anything");
});

test("a reset several periods back rolls to the next future boundary, not to the first one missed", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 66, resetsAt: NOW - 15 * 24 * HOUR }, scoped: [] })],
  });

  assert.equal(value(body, "7d"), "0% · resets 6d 0h", "three whole weeks past a boundary fifteen days old");
});

test("a per-model window rolls the same way and drops its maxed warning with the period", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: null, scoped: [{ name: "Fable", pct: 100, resetsAt: NOW - MINUTE }] })],
  });

  assert.equal(value(body, "Fable"), "0% · resets 6d 23h");
  assert.doesNotMatch(body, /⚠/, "the glyph leads the value, so a dropped warning leaves none on the card");
});

test("the five-hour window is never rolled, whatever its reset instant says", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 46, resetsAt: NOW - MINUTE }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(body, "5h"), "46% · resets due", "a 5h window does not reset on the weekly cadence");
});

test("a fetch time the card will not believe rolls nothing", () => {
  const body = card({
    available: true,
    accounts: [
      account({ fetchedAt: NOW + 10 * MINUTE, sevenDay: { pct: 66, resetsAt: NOW - MINUTE }, scoped: [] }),
    ],
  });

  assert.match(body, /as of unknown/);
  assert.equal(value(body, "7d"), "66% · resets due", "no trustworthy measurement time is no ground for a fresh period");
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

  assert.equal(value(ahead, "Fable"), "56% · resets 4d 6h · ahead of pace");
  assert.equal(value(maxed, "Fable"), "⚠ 100% · resets 4d 6h");
});

test("a fetch time the card will not believe takes the pace marker down with the age", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW + 10 * MINUTE })] });

  assert.doesNotMatch(body, /ahead of pace/, "pace is measured from the fetch time or not at all");
});

test("a spend at the threshold carries the warning glyph the windows use", () => {
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 89.6, used: 1344, limit: 1500, currency: "USD" } })],
  });

  assert.equal(value(body, "spend"), "⚠ 90% · $1,344 of $1,500", "the same rounding, so the same threshold");
});

test("spend amounts render as money rather than as the double behind it", () => {
  // The live cache's own record: a fractional used amount and a whole limit, drawn with grouped
  // thousands, two decimal places, and a trailing .00 dropped, under the symbol for a currency
  // code this renderer knows.
  const live = card({
    available: true,
    accounts: [account({ spend: { pct: 6.36, used: 95.4, limit: 1500, currency: "USD" } })],
  });
  assert.equal(value(live, "spend"), "6% · $95.40 of $1,500");

  // A float sum's noise is rounded to the cent, and a fractional limit keeps its cents too.
  const noisy = card({
    available: true,
    accounts: [account({ spend: { pct: 1, used: 0.1 + 0.2, limit: 1500.5, currency: "USD" } })],
  });
  assert.equal(value(noisy, "spend"), "1% · $0.30 of $1,500.50");

  // Grouping recurs every three digits, not only once.
  const large = card({
    available: true,
    accounts: [account({ spend: { pct: 50, used: 1234567.89, limit: 2500000, currency: "USD" } })],
  });
  assert.equal(value(large, "spend"), "50% · $1,234,567.89 of $2,500,000");
});

test("an unknown currency code keeps its shape after the amount rather than guessing a symbol", () => {
  // A symbol is substituted only on an exact match against the renderer's own tiny map, never
  // composed from the cache's string, which stays bounded and neutralized like every other field.
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 6, used: 95.4, limit: 1500, currency: "EUR" } })],
  });

  assert.equal(value(body, "spend"), "6% · 95.40 of 1,500 EUR");
});

test("a nonsense percentage is bounded rather than drawn in full", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 1e20, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.equal(value(body, "5h"), "⚠ 999%");
});

test("a scoped row whose name neutralizes to nothing keeps a label", () => {
  const body = card({
    available: true,
    accounts: [account({ scoped: [{ name: "​​", pct: 12, resetsAt: null }] })],
  });

  assert.equal(value(body, "per-model"), "12%", "zero-width characters survive a trim and are stripped later");
});

test("the footer ages the card off the oldest reading on it", () => {
  const body = card({
    available: true,
    accounts: [account({ number: 1, fetchedAt: NOW - 2 * MINUTE }), account({ number: 2, fetchedAt: NOW - 3 * HOUR })],
  });

  assert.ok(flat(body).endsWith("card as of 3h ago"), flat(body));
});

test("a held reading keeps its numbers and says the cache behind them is down", () => {
  // The numbers stand because they are the best answer available, and the marker is what keeps
  // them from reading as a cache that is still answering.
  const body = card({ available: true, accounts: [account()] }, [], true, "unreadable");

  assert.equal(value(body, "5h"), "46% · resets 3h 44m");
  assert.ok(
    flat(body).endsWith(
      "⚠ the usage cache cannot be read on this host, so these are the last numbers it held · " +
        "card as of 14m ago",
    ),
    flat(body),
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
    flat(off).endsWith(
      "card as of 14m ago · interim mirroring off, so threads carry no narration or question alerts",
    ),
    flat(off),
  );
});

test("hostile strings in an account label or a session name render inert", () => {
  // Every one of these fields is drawn inside the fence, where Discord resolves no chip and draws
  // no pill, so the syntax reaches the operator as the characters it is. What a crafted string
  // still cannot do is close the block: no backtick survives into the body, so the fence around it
  // holds and nothing a label carries can reach a surface where a chip renders.
  const body = card(
    {
      available: true,
      accounts: [
        account({ email: "<@1234567890> **admin**", scoped: [{ name: "<#999>", pct: 1, resetsAt: null }] }),
      ],
    },
    [view({ name: "`code` <@everyone>" })],
  );

  const delimiters = body.split("\n").filter((line) => line.includes("`"));
  assert.deepEqual(delimiters, ["```", "```"], "the fence holds around every hostile field");
  assert.match(body, /<@1234567890> \*\*admin/, "the characters, with no visible backslash");
  assert.match(body, /'code' <@everyone>/, "a backtick is replaced by the character nearest it");
});

test("live sessions render one row each and ended ones are omitted", () => {
  const body = card({ available: true, accounts: [] }, [
    view({ sessionId: "a", name: "CHNL: Answering" }),
    view({ sessionId: "b", name: "CHNL: Usage card", lastHookAt: NOW - 30 * MINUTE }),
    view({ sessionId: "c", name: "CHNL: Finished", lifecycle: "ended", endedAt: NOW - MINUTE }),
  ]);

  assert.match(body, /^⚙ CHNL: Answering · working · 2m$/m);
  assert.match(body, /^✅ CHNL: Usage card · idle · 30m$/m);
  assert.match(body, /^Sessions$/m, "the section heading loses the bold a fence would show literally");
  assert.doesNotMatch(body, /Finished/);
});

test("a reading that parsed but holds no accounts says so rather than titling an empty card", () => {
  const body = card({ available: true, accounts: [] });

  assert.ok(flat(body).includes("no accounts"), flat(body));
});

test("a fetch time in the future reads as unknown rather than as fresh", () => {
  const body = card({ available: true, accounts: [account({ fetchedAt: NOW + 10 * MINUTE })] });

  assert.match(body, /as of unknown/);
  assert.doesNotMatch(body, /as of just now/);
});

test("an unavailable reading says so and still carries the session section", () => {
  const body = card({ available: false, reason: "malformed" }, [view()]);

  assert.match(body, /usage unavailable/);
  assert.match(body, /CHNL: Answering/);
});

test("a full fleet stays inside the card ceiling and says what it left out", () => {
  const accounts = Array.from({ length: 16 }, (_unused, index) =>
    account({
      number: index + 1,
      email: `account-with-a-long-address-${index}@example.test`,
      organizationName: `Organization number ${index}`,
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
  const rendered = bodyOf(body);
  assert.match(
    rendered.at(-2) ?? "",
    /^\(\+\d+ accounts, \+40 sessions not shown\)$/,
    "the accounts run out of room first, and the tail names both of what it dropped",
  );
  assert.equal(rendered.at(-1), "card as of 14m ago", "the footer's room is reserved, so it survives");
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
  assert.match(body, /^· one@example\.test · as of 14m ago$/m, "the account heading survives whole");
  assert.equal(value(body, "5h"), "46% · resets 3h 44m", "and so do its windows");
  assert.match(
    bodyOf(body).at(-2) ?? "",
    /^\(\+\d+ sessions not shown\)$/,
    "no account was dropped, so the tail names sessions alone",
  );
});
