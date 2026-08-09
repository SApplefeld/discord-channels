import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CARD_LENGTH } from "../discord/render.ts";
import type { SessionView, StateThresholds } from "../discord/state.ts";
import type { UsageAccount, UsageReading } from "./cache.ts";
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
): string {
  return renderUsageCard({ reading, sessions, thresholds: THRESHOLDS, interimMirror, now: NOW });
}

test("an account renders a line per window, with reset times derived from now", () => {
  const body = card({ available: true, accounts: [account({ active: true })] });

  assert.match(body, /^▶ \*\*one@example\.test\*\* · as of 14m ago$/m);
  assert.match(body, /^5h 46% · resets 3h44m$/m);
  assert.match(body, /^7d 56% · resets 4d6h · ahead of pace$/m);
  assert.match(body, /^Fable 12%$/m, "a window with no reset time renders without the clause");
  assert.match(body, /^spend 6% · 95\.4 of 1500 USD$/m);
});

test("a window whose reset time has passed says so rather than counting backwards", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 46, resetsAt: NOW - MINUTE }, sevenDay: null, scoped: [] })],
  });

  assert.match(body, /^5h 46% · resets due$/m);
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

  assert.match(body, /^⚠ usage checks failing · backing off · 3 consecutive$/m);
  assert.match(body, /^5h 46% · resets 3h44m$/m, "the numbers still render, under an honest age");
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

  assert.match(body, /^⚠ usage checks backing off$/m);
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

  assert.match(below, /^5h 89%$/m);
  assert.match(at, /^⚠ 5h 90%$/m);
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

  assert.match(under, /^⚠ 5h 90%$/m);
  assert.match(over, /^⚠ 5h 90%$/m);
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

  assert.match(body, /^7d 50% · resets 4d6h$/m, "10.9 points over schedule is inside the margin");
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

  assert.match(body, /^5h 56% · resets 4d6h$/m, "a 5h window resets too fast for pace to mean anything");
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
  assert.match(body, /^7d 0% · resets 6d23h$/m);
  assert.doesNotMatch(body, /99%/);
  assert.doesNotMatch(body, /ahead of pace/, "a period with no measured spend is not ahead of anything");
});

test("a reset several periods back rolls to the next future boundary, not to the first one missed", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: { pct: 66, resetsAt: NOW - 15 * 24 * HOUR }, scoped: [] })],
  });

  assert.match(body, /^7d 0% · resets 6d0h$/m, "three whole weeks past a boundary fifteen days old");
});

test("a per-model window rolls the same way and drops its maxed warning with the period", () => {
  const body = card({
    available: true,
    accounts: [account({ sevenDay: null, scoped: [{ name: "Fable", pct: 100, resetsAt: NOW - MINUTE }] })],
  });

  assert.match(body, /^Fable 0% · resets 6d23h$/m);
  assert.doesNotMatch(body, /⚠ Fable/);
});

test("the five-hour window is never rolled, whatever its reset instant says", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 46, resetsAt: NOW - MINUTE }, sevenDay: null, scoped: [] })],
  });

  assert.match(body, /^5h 46% · resets due$/m, "a 5h window does not reset on the weekly cadence");
});

test("a fetch time the card will not believe rolls nothing", () => {
  const body = card({
    available: true,
    accounts: [
      account({ fetchedAt: NOW + 10 * MINUTE, sevenDay: { pct: 66, resetsAt: NOW - MINUTE }, scoped: [] }),
    ],
  });

  assert.match(body, /as of unknown/);
  assert.match(body, /^7d 66% · resets due$/m, "no trustworthy measurement time is no ground for a fresh period");
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

  assert.match(ahead, /^Fable 56% · resets 4d6h · ahead of pace$/m);
  assert.match(maxed, /^⚠ Fable 100% · resets 4d6h$/m);
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

  assert.match(body, /^⚠ spend 90% · 1344 of 1500 USD$/m, "the same rounding, so the same threshold");
});

test("spend amounts render as money rather than as the double behind it", () => {
  const body = card({
    available: true,
    accounts: [account({ spend: { pct: 1, used: 0.1 + 0.2, limit: 1500, currency: "USD" } })],
  });

  assert.match(body, /^spend 1% · 0\.3 of 1500 USD$/m);
});

test("a nonsense percentage is bounded rather than drawn in full", () => {
  const body = card({
    available: true,
    accounts: [account({ fiveHour: { pct: 1e20, resetsAt: null }, sevenDay: null, scoped: [] })],
  });

  assert.match(body, /^⚠ 5h 999%$/m);
});

test("a scoped row whose name neutralizes to nothing keeps a label", () => {
  const body = card({
    available: true,
    accounts: [account({ scoped: [{ name: "​​", pct: 12, resetsAt: null }] })],
  });

  assert.match(body, /^per-model 12%$/m, "zero-width characters survive a trim and are stripped later");
});

test("the footer ages the card off the oldest reading on it", () => {
  const body = card({
    available: true,
    accounts: [account({ number: 1, fetchedAt: NOW - 2 * MINUTE }), account({ number: 2, fetchedAt: NOW - 3 * HOUR })],
  });

  assert.equal(body.split("\n").at(-1), "card as of 3h ago");
});

test("the footer names interim mirroring only while it is off", () => {
  const on = card({ available: true, accounts: [account()] }, [], true);
  const off = card({ available: true, accounts: [account()] }, [], false);

  assert.doesNotMatch(on, /interim mirroring/);
  assert.match(
    off.split("\n").at(-1) ?? "",
    /^card as of 14m ago · interim mirroring off, so threads carry no narration or question alerts$/,
  );
});

test("hostile strings in an account label or a session name render inert", () => {
  const body = card(
    {
      available: true,
      accounts: [
        account({ email: "<@1234567890> **admin**", scoped: [{ name: "<#999>", pct: 1, resetsAt: null }] }),
      ],
    },
    [view({ name: "`code` <@everyone>" })],
  );

  assert.doesNotMatch(body, /<@1234567890>/);
  assert.doesNotMatch(body, /<#999>/);
  assert.doesNotMatch(body, /<@everyone>/);
  assert.match(body, /\\<@1234567890\\> \\\*\\\*admin\\\*\\\*/);
});

test("live sessions render one row each and ended ones are omitted", () => {
  const body = card({ available: true, accounts: [] }, [
    view({ sessionId: "a", name: "CHNL: Answering" }),
    view({ sessionId: "b", name: "CHNL: Usage card", lastHookAt: NOW - 30 * MINUTE }),
    view({ sessionId: "c", name: "CHNL: Finished", lifecycle: "ended", endedAt: NOW - MINUTE }),
  ]);

  assert.match(body, /^⚙ CHNL: Answering · working · 2m$/m);
  assert.match(body, /^✅ CHNL: Usage card · idle · 30m$/m);
  assert.doesNotMatch(body, /Finished/);
});

test("a reading that parsed but holds no accounts says so rather than titling an empty card", () => {
  const body = card({ available: true, accounts: [] });

  assert.match(body, /no accounts/);
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
  const rendered = body.split("\n");
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
  assert.match(body, /^· \*\*one@example\.test\*\* · as of 14m ago$/m, "the account heading survives whole");
  assert.match(body, /^5h 46% · resets 3h44m$/m, "and so do its windows");
  assert.match(
    body.split("\n").at(-2) ?? "",
    /^\(\+\d+ sessions not shown\)$/,
    "no account was dropped, so the tail names sessions alone",
  );
});
