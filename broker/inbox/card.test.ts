import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInboxCard } from "./card.ts";
import type { InboxCardSession } from "./card.ts";
import type { InboxItem } from "./store.ts";

const NOW = 1_000_000;
const GUILD_ID = "666666666666666666";
const MESSAGE_ID = "777777777777777777";

function marked(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: "session-a",
    openedAt: NOW - 60_000,
    refreshedAt: NOW - 60_000,
    source: "marked",
    excerpt: "please review the migration",
    stewardAsk: false,
    scores: null,
    winner: null,
    count: 1,
    messageId: null,
    ...overrides,
  };
}

function judged(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: "session-b",
    openedAt: NOW - 60_000,
    refreshedAt: NOW - 60_000,
    source: "judged",
    excerpt: null,
    stewardAsk: false,
    scores: { needsReply: 0.9, needsAct: 0.2 },
    winner: "needs_reply",
    count: 1,
    messageId: null,
    ...overrides,
  };
}

const SESSION_A: InboxCardSession = { title: "alpha worker", threadId: "222222222222222222", ended: false };
const SESSION_B: InboxCardSession = { title: "bravo worker", threadId: "333333333333333333", ended: false };

function sessionsOf(entries: Record<string, InboxCardSession>): (id: string) => InboxCardSession | undefined {
  return (id) => entries[id];
}

test("the rendered card for a fixed item set is byte-stable", () => {
  const items = [marked(), judged()];
  const session = sessionsOf({ "session-a": SESSION_A, "session-b": SESSION_B });

  const first = renderInboxCard({ items, session, guildId: GUILD_ID, now: NOW });
  const second = renderInboxCard({ items: [...items], session, guildId: GUILD_ID, now: NOW });

  assert.equal(first, second);
  assert.match(first, /^📥 \*\*Fleet: Inbox\*\*\n# 📥 Fleet: Inbox\n/);
});

test("an empty inbox draws the fixed line", () => {
  const drawn = renderInboxCard({ items: [], session: () => undefined, guildId: GUILD_ID, now: NOW });
  assert.match(drawn, /No open asks\.$/);
  assert.doesNotMatch(drawn, /-/, "no bullet is drawn with nothing to draw one for");
});

test("an excerpt carrying a mention, a masked link, a heading marker and a backtick fence draws inert", () => {
  const hostile = "<@999999999999999999> [click](https://evil.example) # heading `code` ```fenced```";
  const drawn = renderInboxCard({
    items: [marked({ excerpt: hostile })],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: GUILD_ID,
    now: NOW,
  });

  assert.doesNotMatch(drawn, /<@999999999999999999>/, "the mention chip does not survive live");
  assert.doesNotMatch(drawn, /\[click\]\(https:\/\/evil\.example\)/, "the masked link is not live");
  assert.ok(
    !drawn
      .split("\n")
      .slice(2)
      .some((line) => line.trimStart().startsWith("#")),
    "the heading marker does not open a line",
  );
  assert.ok(drawn.includes("heading"), "the underlying word still reads, just inert");
  assert.doesNotMatch(drawn, /```/, "the backtick fence does not survive live");
  assert.ok(drawn.includes("click"), "the underlying words still read, just inert");

  // The withheld control: the same excerpt, run through no escape at all, does draw live syntax,
  // which is what proves the assertions above are testing the escape and not an accident of the text.
  assert.match(hostile, /<@999999999999999999>/);
  assert.match(hostile, /\[click\]\(https:\/\/evil\.example\)/);
  assert.match(hostile, /```fenced```/);
});

test("a newline actually ahead of a heading marker still opens no line with one", () => {
  // `visible()` collapses every whitespace run, the newline included, to one space before the escape
  // ever runs, so even a raw newline immediately ahead of a `#` cannot open a line with it. This is
  // the escape's own defense, independent of the excerpt already arriving single-line off the store.
  const drawn = renderInboxCard({
    items: [marked({ excerpt: "line one\n# heading two" })],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: GUILD_ID,
    now: NOW,
  });
  const itemLines = drawn.split("\n").slice(2);
  assert.ok(
    !itemLines.some((line) => line.trimStart().startsWith("#")),
    drawn,
  );
});

test("a judge-opened item shows no excerpt", () => {
  const drawn = renderInboxCard({
    items: [judged()],
    session: sessionsOf({ "session-b": SESSION_B }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.equal(drawn.split("\n").filter((line) => line.startsWith("  -")).length, 0);
});

test("a marked item's own word draws its glyph, and a judged item draws by the winning question", () => {
  const reply = judged({ sessionId: "session-b", winner: "needs_reply" });
  const act = judged({ sessionId: "session-c", winner: "needs_act" });
  const session = sessionsOf({
    "session-a": SESSION_A,
    "session-b": SESSION_B,
    "session-c": { title: "charlie worker", threadId: "444444444444444444", ended: false },
  });

  const drawn = renderInboxCard({ items: [marked(), reply, act], session, guildId: GUILD_ID, now: NOW });
  const lines = drawn.split("\n");
  assert.ok(lines.some((line) => line.includes("📝") && line.includes("alpha worker")));
  assert.ok(lines.some((line) => line.includes("💬") && line.includes("bravo worker")));
  assert.ok(lines.some((line) => line.includes("⚡") && line.includes("charlie worker")));
});

test("an item's age is drawn from when it opened, not when it was last refreshed", () => {
  // A restated ask refreshes an item without moving it on the card, which still draws oldest opened
  // first. An age keyed to the refresh would read "just now" above a younger, never-restated item.
  const restated = marked({ sessionId: "session-a", openedAt: NOW - 3 * 60_000, refreshedAt: NOW - 1_000 });
  const younger = judged({ sessionId: "session-b", openedAt: NOW - 60_000, refreshedAt: NOW - 60_000 });
  const drawn = renderInboxCard({
    items: [restated, younger],
    session: sessionsOf({ "session-a": SESSION_A, "session-b": SESSION_B }),
    guildId: GUILD_ID,
    now: NOW,
  });
  const lines = drawn.split("\n");
  const restatedLine = lines.find((line) => line.includes("alpha worker")) ?? "";
  const youngerLine = lines.find((line) => line.includes("bravo worker")) ?? "";
  assert.match(restatedLine, /3m/, restatedLine);
  assert.match(youngerLine, /1m/, youngerLine);
});

test("an ended session's item draws an ended marker", () => {
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": { ...SESSION_A, ended: true } }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.match(drawn, /ended/);
});

test("a steward-flagged item draws the marker between its link and its ended marker, and only there", () => {
  const flagged = marked({ sessionId: "session-a", stewardAsk: true, messageId: MESSAGE_ID });
  const unflagged = marked({ sessionId: "session-b", stewardAsk: false });
  // A judged item's flag is always false, a rule the store enforces on the way in; drawn here to pin
  // that the card draws no marker for it, the same as any other item with the flag down.
  const plainJudged = judged({ sessionId: "session-c" });
  const flaggedEnded = marked({ sessionId: "session-d", stewardAsk: true });
  const session = sessionsOf({
    "session-a": SESSION_A,
    "session-b": SESSION_B,
    "session-c": { title: "charlie worker", threadId: "444444444444444444", ended: false },
    "session-d": { title: "delta worker", threadId: "555555555555555555", ended: true },
  });

  const drawn = renderInboxCard({
    items: [flagged, unflagged, plainJudged, flaggedEnded],
    session,
    guildId: GUILD_ID,
    now: NOW,
  });
  const lines = drawn.split("\n");
  const flaggedLine = lines.find((line) => line.includes("alpha worker")) ?? "";
  const unflaggedLine = lines.find((line) => line.includes("bravo worker")) ?? "";
  const judgedLine = lines.find((line) => line.includes("charlie worker")) ?? "";
  const endedLine = lines.find((line) => line.includes("delta worker")) ?? "";

  assert.match(flaggedLine, /supervisor ask/, flaggedLine);
  assert.doesNotMatch(unflaggedLine, /supervisor ask/, "an unflagged marked item draws no marker");
  assert.doesNotMatch(judgedLine, /supervisor ask/, "a judged item's flag, always false, draws no marker");
  assert.ok(endedLine.includes("supervisor ask") && endedLine.includes("ended"), endedLine);
  assert.ok(
    flaggedLine.indexOf(`https://discord.com/channels/${GUILD_ID}/${SESSION_A.threadId}/${MESSAGE_ID}`) <
      flaggedLine.indexOf("supervisor ask"),
    "the marker follows the link",
  );
  assert.ok(
    endedLine.indexOf("supervisor ask") < endedLine.indexOf("ended"),
    "the marker precedes the ended marker",
  );
});

test("a session the lookup cannot resolve still draws a line, under a name built from its ID", () => {
  const drawn = renderInboxCard({
    items: [marked({ sessionId: "unresolvable-session-id" })],
    session: () => undefined,
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.ok(drawn.includes("session unresol"), drawn);
  assert.doesNotMatch(drawn, /<#/, "no thread chip is drawn with no thread to link to");
});

test("a session whose title neutralizes to nothing falls through to the name built from its ID", () => {
  // The invisible class strips to an empty title, the same failure a resolved-but-unusable name
  // needs to be told apart from a session the lookup could not find at all.
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": { ...SESSION_A, title: "​​​" } }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.ok(drawn.includes("session session-"), drawn);
  assert.doesNotMatch(drawn, /\*\*\*\*/, "an empty title never draws as bare, empty emphasis");
});

test("a title carrying markdown or a chip draws inert too, the same as the excerpt", () => {
  const hostile = "**bold** <@999999999999999999> # heading";
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": { ...SESSION_A, title: hostile } }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.doesNotMatch(drawn, /<@999999999999999999>/, "the mention chip does not survive live");
  assert.ok(
    !drawn
      .split("\n")
      .slice(2)
      .some((line) => line.trimStart().startsWith("#")),
    "the heading marker does not open a line",
  );
  assert.ok(drawn.includes("heading"), "the underlying word still reads, just inert");

  // The withheld control.
  assert.match(hostile, /<@999999999999999999>/);
});

test("a resolved session's thread draws as a channel chip when no message ID is held", () => {
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.ok(drawn.includes(`in <#${SESSION_A.threadId}>`));
  assert.doesNotMatch(drawn, /discord\.com/, "no jump link is drawn with no message ID to point at");
});

test("a flagged message draws a jump link once the guild and the message ID are both known", () => {
  const drawn = renderInboxCard({
    items: [marked({ messageId: MESSAGE_ID })],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.ok(
    drawn.includes(`https://discord.com/channels/${GUILD_ID}/${SESSION_A.threadId}/${MESSAGE_ID}`),
    drawn,
  );
  assert.doesNotMatch(drawn, /in <#/, "the jump link replaces the chip, it does not sit beside it");
});

test("a flagged message falls back to the thread chip while the guild is not yet known", () => {
  const drawn = renderInboxCard({
    items: [marked({ messageId: MESSAGE_ID })],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: null,
    now: NOW,
  });
  assert.ok(drawn.includes(`in <#${SESSION_A.threadId}>`));
  assert.doesNotMatch(drawn, /discord\.com/);
});

test("a guild or message ID that is not a Discord snowflake is refused, not interpolated into a link", () => {
  const drawn = renderInboxCard({
    items: [marked({ messageId: "../../not-a-snowflake" })],
    session: sessionsOf({ "session-a": SESSION_A }),
    guildId: "also not a snowflake",
    now: NOW,
  });
  assert.doesNotMatch(drawn, /discord\.com/);
  assert.doesNotMatch(drawn, /not-a-snowflake/);
  assert.ok(drawn.includes(`in <#${SESSION_A.threadId}>`), "the thread chip is still drawn");
});

test("items draw oldest first, the order the caller hands them in", () => {
  const older = marked({ sessionId: "session-a", refreshedAt: NOW - 120_000 });
  const newer = judged({ sessionId: "session-b", refreshedAt: NOW - 10_000 });
  const drawn = renderInboxCard({
    items: [older, newer],
    session: sessionsOf({ "session-a": SESSION_A, "session-b": SESSION_B }),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.ok(drawn.indexOf("alpha worker") < drawn.indexOf("bravo worker"));
});

test("a card with more items than fit ends with a tail naming how many were left out", () => {
  const many: InboxItem[] = [];
  const session: Record<string, InboxCardSession> = {};
  for (let at = 0; at < 200; at += 1) {
    const id = `session-${String(at)}`;
    many.push(marked({ sessionId: id, excerpt: `ask number ${String(at)} repeated to spend room` }));
    session[id] = { title: `worker ${String(at)}`, threadId: "555555555555555555", ended: false };
  }

  const drawn = renderInboxCard({ items: many, session: sessionsOf(session), guildId: GUILD_ID, now: NOW });
  assert.match(drawn, /\(\+\d+ more asks? not shown\)$/);
  assert.ok(drawn.length <= 1_900, `card ran ${String(drawn.length)} over the message ceiling`);

  const fewer = many.slice(0, 3);
  const small = renderInboxCard({
    items: fewer,
    session: sessionsOf(session),
    guildId: GUILD_ID,
    now: NOW,
  });
  assert.doesNotMatch(small, /not shown/, "a card with room to spare draws no tail at all");
});
