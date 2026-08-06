import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARD_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_THREAD_NAME_LENGTH,
  heartbeat,
  inertMessage,
  inertText,
  renderCard,
  threadName,
} from "./render.ts";
import { toView } from "./state.ts";
import type { SessionView } from "./state.ts";
import type { SessionRecord } from "../registry.ts";

const NOW = 1_000_000;

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "0f3c9d21-1111-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    lastTool: "Bash",
    turnCount: 14,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

test("a thread name puts the glyph first and the state last", () => {
  assert.equal(threadName(view(), "working"), "⚙ neo-intake · working");
  assert.equal(threadName(view(), "needs you"), "⏸ neo-intake · needs you");
  assert.equal(threadName(view(), "idle"), "✅ neo-intake · idle");
  assert.equal(threadName(view(), "exited"), "⚠ neo-intake · exited");
});

test("an over-long name is truncated without eating the glyph or the state", () => {
  const name = threadName(view({ name: "x".repeat(400) }), "needs you");

  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} characters`);
  assert.ok(name.startsWith("⏸ "), name);
  assert.ok(name.endsWith(" · needs you"), name);
});

test("a session with no name is still distinguishable in the list", () => {
  assert.equal(threadName(view({ name: null }), "idle"), "✅ session 0f3c9d21 · idle");
});

test("a name of invisible characters falls back rather than rendering an empty title", () => {
  // A local process can announce itself as anything, including a name that renders as nothing at
  // all, and Discord refuses an empty thread name.
  assert.equal(
    threadName(view({ name: "\u200b\u202e\u0000" }), "idle"),
    "✅ session 0f3c9d21 · idle",
  );
});

test("a thread name carries no bidi override or zero-width character", () => {
  const name = threadName(view({ name: "neo\u202eelbisrever\u200b" }), "working");

  assert.equal(name, "⚙ neoelbisrever · working");
});

test("the session ID fallback is neutralized before it is cut", () => {
  // The session ID comes from the same untrusted payload as the name, and a slice taken from raw
  // text can end in the middle of a bidi override.
  const name = threadName(view({ name: null, sessionId: "\u202e0f3c9d21-1111" }), "idle");

  assert.equal(name, "✅ session 0f3c9d21 · idle");
});

test("untrusted text in the card is inert", () => {
  const card = renderCard(
    view({ name: "@everyone **boss**", lastTool: "Bash\u202e`rm -rf`" }),
    "working",
    NOW,
  );

  // The mention survives as text, which allowed_mentions is what neutralizes, but nothing in it
  // can restructure the card around it.
  assert.ok(card.includes("@everyone"), card);
  assert.ok(!card.includes("**boss**"), card);
  assert.ok(!card.includes("\u202e"), card);
  assert.ok(!/`rm -rf`/.test(card), card);
  assert.equal(inertText("a*b_c~d|e`f"), "a\\*b\\_c\\~d\\|e\\`f");
});

test("Discord's chip syntax cannot survive into the card", () => {
  // `<t:...:R>` renders as a live relative timestamp, which would spoof the heartbeat the card
  // exists to carry, and the same brackets carry mentions, channel links, and custom emoji.
  const card = renderCard(
    view({ name: "<t:2000000000:R>", lastTool: "<@123456789012345678>" }),
    "working",
    NOW,
  );

  assert.ok(!/<t:\d+:R>/.test(card), card);
  assert.ok(!/<@\d+>/.test(card), card);
  assert.equal(inertText("<#123>"), "\\<\\#123\\>");
});

test("a card is held below Discord's message limit", () => {
  const card = renderCard(view({ name: "n".repeat(4_000), lastTool: "t".repeat(4_000) }), "idle", NOW);

  assert.ok([...card].length <= MAX_CARD_LENGTH, `${[...card].length} characters`);
});

test("a name is cut on code points, never mid-character", () => {
  // A lone surrogate is not valid UTF-8, and the request body carrying it would be rejected.
  const name = threadName(view({ name: "🛰".repeat(200) }), "working");

  // A lone surrogate does not survive a UTF-8 round trip: it comes back as a replacement character.
  assert.equal(Buffer.from(name, "utf8").toString("utf8"), name);
  assert.ok(name.length <= MAX_THREAD_NAME_LENGTH, `${name.length} units`);
  assert.ok(name.endsWith(" · working"));
});

test("the card carries the six named fields and the state", () => {
  const card = renderCard(view({ lastHookAt: NOW - 840_000 }), "working", NOW);

  assert.match(card, /^⚙ \*\*neo-intake\*\* · working$/m);
  assert.match(card, /^Session: 0f3c9d21-1111-4000-8000-000000000001$/m);
  assert.match(card, /^Host: NEO$/m);
  assert.match(card, /^State: working$/m);
  assert.match(card, /^Last tool: Bash$/m);
  assert.match(card, /^Turns: 14$/m);
  assert.match(card, /^Heartbeat: 14m ago$/m);
});

test("an exited card measures its heartbeat from when the session ended", () => {
  const card = renderCard(
    view({ lifecycle: "ended", endedAt: NOW - 7_200_000, lastHookAt: NOW - 9_000_000 }),
    "exited",
    NOW,
  );

  assert.match(card, /^Heartbeat: 2h ago$/m);
});

test("the heartbeat is bucketed so an unchanged session does not spend an edit", () => {
  assert.equal(heartbeat(0), "just now");
  assert.equal(heartbeat(59_999), "just now");
  assert.equal(heartbeat(60_000), "1m ago");
  assert.equal(heartbeat(3_599_000), "59m ago");
  assert.equal(heartbeat(3_600_000), "1h ago");
  assert.equal(heartbeat(24 * 3_600_000), "1d ago");
});

test("neither the view nor the card can carry the process token", () => {
  // processToken is the forgery key for hook posts. A surface that serialized a whole record would
  // publish it into a Discord channel, so the view is built field by field and this is the pin.
  const record: SessionRecord = {
    sessionId: "session-a",
    processToken: "5f0c2e4a-0000-4000-8000-000000000001",
    name: "neo-intake",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    toolCount: 3,
    turnCount: 1,
    startedAt: NOW,
    lastHookAt: NOW,
    lastRelayAt: null,
    endedAt: null,
  };

  const narrowed = toView(record);

  assert.ok(!("processToken" in narrowed), Object.keys(narrowed).join(", "));
  assert.ok(!JSON.stringify(narrowed).includes(record.processToken));
  assert.ok(!renderCard(narrowed, "working", NOW).includes(record.processToken));
});

test("a message keeps its markdown and its line structure", () => {
  // A reply is prose the operator reads. Escaping it the way a card is escaped would put
  // backslashes through every code fence and list marker for no gain: mentions are already inert,
  // because the transport sends allowed_mentions with an empty parse list on every write.
  const reply = "Done:\n\n- **two** files changed\n- `npm test` is green";
  assert.equal(inertMessage(reply), reply);
});

test("a message is stripped of the characters that reorder or hide text", () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const bom = String.fromCharCode(0xfeff);
  assert.equal(
    inertMessage(`a${zeroWidth}b${rightToLeftOverride}c${bom}`),
    "abc",
    "the invisible class has no use in a reply and can hide what one says",
  );
});

test("a message is cut to a length Discord will accept", () => {
  const long = inertMessage("x".repeat(MAX_MESSAGE_LENGTH + 500));
  assert.equal(long.length, MAX_MESSAGE_LENGTH);
  assert.ok(long.endsWith("…"), "a cut message says it was cut");
});
