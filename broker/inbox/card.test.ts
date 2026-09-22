import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInboxCard } from "./card.ts";
import type { InboxCardSession } from "./card.ts";
import type { InboxItem } from "./store.ts";

const NOW = 1_000_000;

function marked(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: "session-a",
    openedAt: NOW - 60_000,
    refreshedAt: NOW - 60_000,
    source: "marked",
    excerpt: "please review the migration",
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

  const first = renderInboxCard({ items, session, now: NOW });
  const second = renderInboxCard({ items: [...items], session, now: NOW });

  assert.equal(first, second);
  assert.match(first, /^📥 \*\*Fleet: Inbox\*\*\n# 📥 Fleet: Inbox\n/);
});

test("an empty inbox draws the fixed line", () => {
  const drawn = renderInboxCard({ items: [], session: () => undefined, now: NOW });
  assert.match(drawn, /No open asks\.$/);
  assert.doesNotMatch(drawn, /-/, "no bullet is drawn with nothing to draw one for");
});

test("an excerpt carrying a mention, a masked link, a heading marker and a backtick fence draws inert", () => {
  const hostile = "<@999999999999999999> [click](https://evil.example) # heading `code`";
  const drawn = renderInboxCard({
    items: [marked({ excerpt: hostile })],
    session: sessionsOf({ "session-a": SESSION_A }),
    now: NOW,
  });

  assert.doesNotMatch(drawn, /<@999999999999999999>/, "the mention chip does not survive live");
  assert.doesNotMatch(drawn, /\[click\]\(https:\/\/evil\.example\)/, "the masked link is not live");
  assert.doesNotMatch(drawn, /\n# heading/, "the heading marker does not open a heading");
  assert.doesNotMatch(drawn, /`code`/, "the backtick fence is not live");
  assert.ok(drawn.includes("click"), "the underlying words still read, just inert");

  // The withheld control: the same excerpt, run through no escape at all, does draw live syntax,
  // which is what proves the assertions above are testing the escape and not an accident of the text.
  assert.match(hostile, /<@999999999999999999>/);
  assert.match(hostile, /\[click\]\(https:\/\/evil\.example\)/);
  assert.match(hostile, /`code`/);
});

test("a judge-opened item shows no excerpt", () => {
  const drawn = renderInboxCard({
    items: [judged()],
    session: sessionsOf({ "session-b": SESSION_B }),
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

  const drawn = renderInboxCard({ items: [marked(), reply, act], session, now: NOW });
  const lines = drawn.split("\n");
  assert.ok(lines.some((line) => line.includes("📝") && line.includes("alpha worker")));
  assert.ok(lines.some((line) => line.includes("💬") && line.includes("bravo worker")));
  assert.ok(lines.some((line) => line.includes("⚡") && line.includes("charlie worker")));
});

test("an ended session's item draws an ended marker", () => {
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": { ...SESSION_A, ended: true } }),
    now: NOW,
  });
  assert.match(drawn, /ended/);
});

test("a session the lookup cannot resolve still draws a line, under a name built from its ID", () => {
  const drawn = renderInboxCard({
    items: [marked({ sessionId: "unresolvable-session-id" })],
    session: () => undefined,
    now: NOW,
  });
  assert.ok(drawn.includes("session unresol"), drawn);
  assert.doesNotMatch(drawn, /<#/, "no thread chip is drawn with no thread to link to");
});

test("a title carrying markdown or a chip draws inert too, the same as the excerpt", () => {
  const hostile = "**bold** <@999999999999999999> # heading";
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": { ...SESSION_A, title: hostile } }),
    now: NOW,
  });
  assert.doesNotMatch(drawn, /<@999999999999999999>/, "the mention chip does not survive live");
  assert.doesNotMatch(drawn, /\n# heading/, "the heading marker does not open a heading");

  // The withheld control.
  assert.match(hostile, /<@999999999999999999>/);
});

test("a resolved session's thread draws as a channel chip", () => {
  const drawn = renderInboxCard({
    items: [marked()],
    session: sessionsOf({ "session-a": SESSION_A }),
    now: NOW,
  });
  assert.ok(drawn.includes(`<#${SESSION_A.threadId}>`));
});

test("items draw oldest first, the order the caller hands them in", () => {
  const older = marked({ sessionId: "session-a", refreshedAt: NOW - 120_000 });
  const newer = judged({ sessionId: "session-b", refreshedAt: NOW - 10_000 });
  const drawn = renderInboxCard({
    items: [older, newer],
    session: sessionsOf({ "session-a": SESSION_A, "session-b": SESSION_B }),
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

  const drawn = renderInboxCard({ items: many, session: sessionsOf(session), now: NOW });
  assert.match(drawn, /\(\+\d+ more asks? not shown\)$/);
  assert.ok(drawn.length <= 1_900, `card ran ${String(drawn.length)} over the message ceiling`);

  const fewer = many.slice(0, 3);
  const small = renderInboxCard({ items: fewer, session: sessionsOf(session), now: NOW });
  assert.doesNotMatch(small, /not shown/, "a card with room to spare draws no tail at all");
});
