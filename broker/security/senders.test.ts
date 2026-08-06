// The gate itself, in both directions. A silent bypass here is the expensive failure: anyone who
// gets through can put text in front of a running session and approve its tool calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSenderGate, loadSenderGate } from "./senders.ts";

const OPERATOR = "700000000000000002";
const STRANGER = "700000000000000003";

test("the allowed sender is admitted and everyone else is refused", () => {
  const gate = createSenderGate(OPERATOR);
  assert.equal(gate.allows(OPERATOR), true);
  assert.equal(gate.allows(STRANGER), false);
  assert.equal(gate.allows(""), false, "a message with no author is not the operator");
  assert.equal(gate.allows(`${OPERATOR} `), true, "surrounding space is not a different user");
  assert.equal(
    gate.allows(OPERATOR.slice(0, -1)),
    false,
    "a prefix of the allowed id is a different user",
  );
  assert.equal(
    gate.allows(`${OPERATOR}0`),
    false,
    "an id the allowed one is a prefix of is a different user",
  );
});

test("an empty allowlist admits nobody rather than everybody", () => {
  // The value cannot be empty by the time it reaches here. The check is what makes an unset gate
  // fail closed instead of reading as a permissive one.
  const gate = createSenderGate("   ");
  assert.equal(gate.allows(""), false);
  assert.equal(gate.allows(OPERATOR), false);
});

test("a broker with a channel and no allowlist refuses to start", () => {
  // Matched on the absent-value message rather than on the variable's name, which both refusals
  // carry: a gate that fell through to the shape check would otherwise look like this one passing.
  assert.throws(() => loadSenderGate({}), /must name the Discord user/);
  assert.throws(() => loadSenderGate({ CHANNEL_ALLOWED_USER_ID: "  " }), /must name the Discord user/);
});

test("an allowlist that is not a snowflake is refused rather than matched literally", () => {
  // A username, a display name, or a mention pasted out of Discord all look plausible and would
  // never match an author id, which is a gate that silently admits nobody and looks like a broker
  // that simply stopped answering.
  assert.throws(() => loadSenderGate({ CHANNEL_ALLOWED_USER_ID: "sapplefeld" }), /snowflake/);
  assert.throws(
    () => loadSenderGate({ CHANNEL_ALLOWED_USER_ID: `<@${OPERATOR}>` }),
    /snowflake/,
  );
  assert.throws(() => loadSenderGate({ CHANNEL_ALLOWED_USER_ID: "*" }), /snowflake/);
});

test("a configured allowlist yields a gate over exactly that user", () => {
  const gate = loadSenderGate({ CHANNEL_ALLOWED_USER_ID: ` ${OPERATOR} ` });
  assert.equal(gate.operatorId, OPERATOR);
  assert.equal(gate.allows(OPERATOR), true);
  assert.equal(gate.allows(STRANGER), false);
});
