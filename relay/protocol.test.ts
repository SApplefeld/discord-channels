// The channel protocol shapes. Every one of these fails silently if it drifts: Claude Code drops a
// meta key it does not recognize with nothing but a debug line, refuses to register a channel whose
// connection negotiated too new a protocol revision, and a session that never receives an event
// looks exactly like a session that received one and ignored it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  CHANNEL_NOTIFICATION_METHOD,
  INSTRUCTIONS,
  META_KEY_PATTERN,
  REPLY_TOOL,
  REPLY_TOOL_NAME,
  channelNotification,
} from "./protocol.ts";

test("an inbound message becomes a channel notification carrying chat_id in meta", () => {
  const notification = channelNotification("run the migration", "900000000000000001");
  assert.equal(notification.method, CHANNEL_NOTIFICATION_METHOD);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.deepEqual(notification.params, {
    content: "run the migration",
    meta: { chat_id: "900000000000000001" },
  });
});

test("every meta key is one Claude Code keeps, and every meta value is a string", () => {
  // Claude Code validates params.meta as Record<string, string> and then drops any key that is not
  // a plain identifier. A number-valued or oddly-named entry is discarded before the model ever
  // sees it, which would cost the event its chat_id with no error anywhere.
  const notification = channelNotification("hello", "900000000000000001");
  for (const [key, value] of Object.entries(notification.params.meta)) {
    assert.match(key, META_KEY_PATTERN, `meta key ${key} would be dropped`);
    assert.equal(typeof value, "string", `meta value for ${key} must be a string`);
  }
});

test("the message text is carried verbatim, neither escaped nor annotated", () => {
  // Claude Code wraps the content in an envelope of its own and escapes it there. Anything added
  // here is double-escaped, and anything said about the message is the relay editorializing data.
  const text = "<script>@everyone `rm -rf /`";
  assert.equal(channelNotification(text, "1").params.content, text);
});

test("the reply tool takes a message and tolerates a chat_id it ignores", () => {
  assert.equal(REPLY_TOOL.name, REPLY_TOOL_NAME);
  assert.deepEqual([...REPLY_TOOL.inputSchema.required], ["message"]);
  // Declared so the first reply of every conversation does not fail on an argument Claude will have
  // seen on an inbound event and will pass back.
  assert.ok("chat_id" in REPLY_TOOL.inputSchema.properties);
  assert.match(REPLY_TOOL.description, /ignored/);
});

test("the instructions are a static literal with nothing interpolated into them", () => {
  // The one string here the model is meant to read as instruction, so it is the one string
  // untrusted text must never be able to reach.
  assert.doesNotMatch(INSTRUCTIONS, /\$\{/);
  for (const value of Object.values(process.env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    assert.ok(!INSTRUCTIONS.includes(value), "no environment value appears in the instructions");
  }
  assert.match(INSTRUCTIONS, /reply/);
  assert.match(INSTRUCTIONS, /operator/);
});

test("the instructions describe the sender gate as the system's control, not verification by the relay", () => {
  // No event carries who wrote it, and the broker's sender gate is a fact about the broker, not
  // something this transport can establish at runtime. The text this test previously pinned refused
  // to attribute on that ground. That refusal was itself an end-to-end provenance claim, and a
  // false one: "an unattributed message from a person with access to the thread" describes a system
  // the code refutes, because a broker connected to Discord refuses to start without the allowlist
  // and the only production writer of a message stream event sits below the gate. So the text now
  // describes that control as a property of the system, states what it establishes (the account,
  // not the person), and keeps the confirm-before-irreversible discipline, without asserting
  // per-message verification by this layer and without commanding trust.
  assert.match(
    INSTRUCTIONS,
    /allowlist/,
    "the instructions must name the broker's allowlist control",
  );
  assert.match(
    INSTRUCTIONS,
    /broker has checked its author's Discord account/,
    "the instructions must describe the broker checking the author",
  );
  assert.match(
    INSTRUCTIONS,
    /controls the operator's Discord account/,
    "the instructions must state that the check establishes the account, not the person",
  );
  // The whole clause rather than the two words, so a rewording that guts the discipline while
  // keeping the words cannot pass; any edit to the sentence has to come through this test.
  assert.match(
    INSTRUCTIONS,
    /For an action that is irreversible or outward-facing, confirm first/,
    "the instructions must keep the confirm-before-irreversible discipline",
  );
  assert.doesNotMatch(
    INSTRUCTIONS,
    /verified at this layer/,
    "the instructions must not claim per-message verification by the relay",
  );
  assert.doesNotMatch(
    INSTRUCTIONS,
    /always trust|trust unconditionally|unconditional trust/,
    "the instructions must describe the control, not command trust",
  );
});

test("the MCP SDK still negotiates a protocol revision Claude Code will register a channel on", () => {
  // Claude Code refuses to register a channel whose connection negotiated a "modern" revision,
  // which it defines as 2026-07-28 or later, because that revision has no unsolicited notification
  // path. The refusal is a skipped registration with a debug line and nothing else: the server
  // connects, its tools work, and messages simply never arrive. An SDK upgrade is what would cross
  // that line, so the bound is asserted here rather than discovered in production.
  assert.ok(
    LATEST_PROTOCOL_VERSION < "2026-07-28",
    `the SDK now negotiates ${LATEST_PROTOCOL_VERSION}, at or past the revision on which Claude ` +
      "Code stops registering channel servers",
  );
});
