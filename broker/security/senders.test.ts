// The gate itself, in both directions. A silent bypass here is the expensive failure: anyone who
// gets through can put text in front of a running session and approve its tool calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSenderGate, loadSenderGate } from "./senders.ts";

const OPERATOR = "700000000000000002";
const STRANGER = "700000000000000003";
const PARTICIPANT = "700000000000000004";
const SECOND_OPERATOR = "700000000000000005";

test("the allowed sender is admitted and everyone else is refused", () => {
  const gate = createSenderGate([{ id: OPERATOR, class: "operator" }]);
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
  const gate = createSenderGate([{ id: "   ", class: "operator" }]);
  assert.equal(gate.allows(""), false);
  assert.equal(gate.allows(OPERATOR), false);
  assert.equal(gate.classOf(""), null);
  assert.deepEqual(gate.operatorIds, []);
});

test("each admitted id carries its own class and a stranger carries none", () => {
  const gate = createSenderGate([
    { id: OPERATOR, class: "operator" },
    { id: PARTICIPANT, class: "participant" },
  ]);
  assert.equal(gate.classOf(OPERATOR), "operator");
  assert.equal(gate.classOf(` ${PARTICIPANT} `), "participant");
  assert.equal(gate.classOf(STRANGER), null);
  assert.equal(gate.allows(PARTICIPANT), true, "a participant is admitted");
  assert.deepEqual(gate.operatorIds, [OPERATOR]);
  assert.deepEqual(gate.participantIds, [PARTICIPANT]);
  assert.equal(gate.operatorId, OPERATOR);
});

test("an id listed twice with one class is one entry, and with two classes is refused", () => {
  const gate = createSenderGate([
    { id: OPERATOR, class: "operator" },
    { id: OPERATOR, class: "operator" },
  ]);
  assert.deepEqual(gate.operatorIds, [OPERATOR]);
  // Neither class may win silently: a participant promoted by list order approves tool calls, and
  // an operator demoted by it loses the only account that can.
  assert.throws(
    () =>
      createSenderGate([
        { id: OPERATOR, class: "operator" },
        { id: OPERATOR, class: "participant" },
      ]),
    new RegExp(`${OPERATOR}.*both`),
  );
});

test("a broker with a channel and no allowlist refuses to start", () => {
  // Matched on the absent-value message rather than on the variable's name, which both refusals
  // carry: a gate that fell through to the shape check would otherwise look like this one passing.
  assert.throws(() => loadSenderGate({}), /must name the Discord user/);
  assert.throws(() => loadSenderGate({ CHANNEL_ALLOWED_USER_ID: "  " }), /must name the Discord user/);
  assert.throws(() => loadSenderGate({ CHANNEL_SENDERS: "  " }), /must name the Discord user/);
});

test("a senders list with no operator refuses to start with the same reason", () => {
  // Participants alone would be a room nobody can approve anything in, and the refusal is the one
  // an unset allowlist gives, so an operator reading the log sees the same remedy either way.
  assert.throws(
    () => loadSenderGate({ CHANNEL_SENDERS: `${PARTICIPANT}:participant` }),
    /must name the Discord user/,
  );
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

test("a senders entry with a malformed id or an unknown class is refused, naming the entry", () => {
  // Each refusal names the entry text, which is an id and a word and never a secret, so the log
  // line points at the one entry to fix. A valid operator rides beside each bad entry, so a
  // refusal here is the entry's own and not the no-operator one.
  const cases: Array<[string, RegExp]> = [
    [`sapplefeld:operator`, /snowflake/],
    [`<@${PARTICIPANT}>:participant`, /snowflake/],
    [`${PARTICIPANT}`, /operator or :participant/],
    [`${PARTICIPANT}:admin`, /operator or :participant/],
    [`${PARTICIPANT}:Operator`, /operator or :participant/],
    [`${PARTICIPANT}:operator:extra`, /operator or :participant/],
    [``, /snowflake/],
  ];
  for (const [entry, reason] of cases) {
    const listed = `${OPERATOR}:operator,${entry}`;
    assert.throws(
      () => loadSenderGate({ CHANNEL_SENDERS: listed }),
      (error: Error) => {
        assert.match(error.message, reason, `entry ${JSON.stringify(entry)}`);
        assert.ok(
          error.message.includes(JSON.stringify(entry)),
          `the refusal must name the entry ${JSON.stringify(entry)}: ${error.message}`,
        );
        return true;
      },
    );
  }
});

test("a roster refusal never carries a secret value set beside it", () => {
  // Built at run time so no token-formatted literal sits in the tree for a secret scanner to flag.
  const token = ["not", "a", "real", "token"].join("-") + "-".padEnd(48, "x");
  const env = { CHANNEL_DISCORD_TOKEN: token, CHANNEL_SENDERS: `${OPERATOR}:operator,${PARTICIPANT}:admin` };
  assert.throws(
    () => loadSenderGate(env),
    (error: Error) => !error.message.includes(token) && error.message.includes(`${PARTICIPANT}:admin`),
  );
});

test("an id given two classes across the list or across both variables is refused", () => {
  assert.throws(
    () =>
      loadSenderGate({
        CHANNEL_SENDERS: `${OPERATOR}:operator,${PARTICIPANT}:participant,${PARTICIPANT}:operator`,
      }),
    new RegExp(`${PARTICIPANT}.*both`),
  );
  assert.throws(
    () =>
      loadSenderGate({
        CHANNEL_ALLOWED_USER_ID: OPERATOR,
        CHANNEL_SENDERS: `${OPERATOR}:participant`,
      }),
    new RegExp(`${OPERATOR}.*both`),
  );
});

test("a configured allowlist yields a gate over exactly that user", () => {
  const gate = loadSenderGate({ CHANNEL_ALLOWED_USER_ID: ` ${OPERATOR} ` });
  assert.equal(gate.operatorId, OPERATOR);
  assert.equal(gate.classOf(OPERATOR), "operator");
  assert.deepEqual(gate.operatorIds, [OPERATOR]);
  assert.equal(gate.allows(OPERATOR), true);
  assert.equal(gate.allows(STRANGER), false);
});

test("a classed senders list admits each id under its class", () => {
  const gate = loadSenderGate({
    CHANNEL_SENDERS: "111111111111111111:operator, 222222222222222222:participant",
  });
  assert.equal(gate.classOf("111111111111111111"), "operator");
  assert.equal(gate.classOf("222222222222222222"), "participant");
  assert.equal(gate.allows(STRANGER), false);
  assert.deepEqual(gate.operatorIds, ["111111111111111111"]);
  assert.equal(gate.operatorId, "111111111111111111");
});

test("both variables union, with the legacy id an operator listed first", () => {
  const gate = loadSenderGate({
    CHANNEL_ALLOWED_USER_ID: OPERATOR,
    CHANNEL_SENDERS: [
      `${PARTICIPANT}:participant`,
      `${SECOND_OPERATOR}:operator`,
      // The legacy id listed again as an operator agrees with it and is not an error.
      `${OPERATOR}:operator`,
    ].join(","),
  });
  assert.equal(gate.classOf(OPERATOR), "operator");
  assert.equal(gate.classOf(PARTICIPANT), "participant");
  assert.deepEqual(gate.operatorIds, [OPERATOR, SECOND_OPERATOR]);
  assert.deepEqual(gate.participantIds, [PARTICIPANT]);
  assert.equal(gate.operatorId, OPERATOR, "the first operator is the one every caller still reads");
});
