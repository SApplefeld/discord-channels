// The interaction route: the second way something outside this machine reaches a running session.
//
// Two properties carry the weight. Only the operator's presses do anything at all, and what a press
// can say is bounded by the ask the desk holds: positions cross the wire, labels come off the
// entry, and the answers that reach the session are keyed by the question text the payload itself
// carried.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { AskedQuestion } from "../discord/render.ts";
import { CLOSED_NOTICE, incompleteNotice } from "../discord/question-message.ts";
import { createQuestionDesk } from "../question-desk.ts";
import type { QuestionEntryView } from "../question-desk.ts";
import type { RateLimitObservation } from "../discord/transport.ts";
import { createSenderGate } from "../security/senders.ts";
import { questionDigest } from "../tail.ts";
import { createInteractionRouter } from "./interactions.ts";
import type { InboundInteraction } from "./interactions.ts";

const OPERATOR = "700000000000000002";
const INTRUDER = "700000000000000003";
const SESSION = "session-a";
const THREAD = "thread-1";

/** The two-question ask the mock draws: one single-select, one multi-select. */
function questions(): AskedQuestion[] {
  return [
    {
      question: "Commit model for this effort?",
      header: "Commit model",
      multiSelect: false,
      options: [
        { label: "Commit-and-Push", description: "land on main as sections complete" },
        { label: "Review-Only", description: null },
      ],
    },
    {
      question: "Which sections ship first?",
      header: "Sections",
      multiSelect: true,
      options: [
        { label: "Desk", description: null },
        { label: "Message", description: null },
        { label: "Docs", description: null },
      ],
    },
  ];
}

/** The payload's own questions array, which an answered hold passes back verbatim. */
function questionsInput(): unknown[] {
  return [
    { question: "Commit model for this effort?", options: [{ label: "Commit-and-Push" }] },
    { question: "Which sections ship first?", multiSelect: true, options: [{ label: "Desk" }] },
  ];
}

/** One single-select question with two options: the fast path, answered by one tap. */
function oneQuestion(): AskedQuestion[] {
  return [
    {
      question: "Ship the migration now?",
      header: "Timing",
      multiSelect: false,
      options: [
        { label: "Now", description: null },
        { label: "After the backup", description: null },
      ],
    },
  ];
}

function heldResponse(): { response: ServerResponse; writes: unknown[] } {
  const writes: unknown[] = [];
  const response = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead() {
      return this;
    },
    end(text: string) {
      this.writableEnded = true;
      this.writableFinished = true;
      writes.push(JSON.parse(text));
    },
    once() {
      return this;
    },
  };
  return { response: response as unknown as ServerResponse, writes };
}

type Callback = { kind: "acknowledge" | "ephemeral"; text: string | null };

function harness(asked: AskedQuestion[] = questions(), rate = NO_RATE) {
  const callbacks: Callback[] = [];
  const refreshed: QuestionEntryView[] = [];
  const logged: string[] = [];
  const held = heldResponse();
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    log: (message) => logged.push(message),
    // Unref'd: a hold still standing when a test ends must not keep the runner alive.
    setTimer: (callback, ms) => setTimeout(callback, ms).unref(),
  });
  assert.equal(desk.hold(SESSION, asked, questionsInput(), held.response, true), true);
  const entryId = desk.noteAlert(SESSION, questionDigest(asked), {
    threadId: THREAD,
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);

  const router = createInteractionRouter({
    gate: createSenderGate(OPERATOR),
    desk,
    responder: {
      acknowledge: async () => {
        callbacks.push({ kind: "acknowledge", text: null });
        return { status: "ok", value: null, rate };
      },
      ephemeral: async ({ text }) => {
        callbacks.push({ kind: "ephemeral", text });
        return { status: "ok", value: null, rate };
      },
    },
    refresh: async (entry) => {
      refreshed.push(entry);
    },
    log: (message) => logged.push(message),
  });

  return { router, desk, entryId, writes: held.writes, callbacks, refreshed, logged };
}

const NO_RATE: RateLimitObservation = {
  remaining: null,
  resetAfterMs: null,
  retryAfterMs: null,
};

function press(overrides: Partial<InboundInteraction> = {}): InboundInteraction {
  return {
    interactionId: "interaction-1",
    token: "SECRET-interaction-token",
    threadId: THREAD,
    senderId: OPERATOR,
    customId: "qd:unset:0",
    values: [],
    ...overrides,
  };
}

/** The answers an answered hold injected, off the very response the desk held. */
function submitted(writes: readonly unknown[]): Record<string, unknown> {
  assert.equal(writes.length, 1, "the hold is answered exactly once");
  const body = writes[0] as {
    hookSpecificOutput: { updatedInput: { questions: unknown; answers: Record<string, unknown> } };
  };
  assert.deepEqual(
    body.hookSpecificOutput.updatedInput.questions,
    questionsInput(),
    "the payload's own questions array rides back verbatim",
  );
  return body.hookSpecificOutput.updatedInput.answers;
}

test("a press from anyone but the operator does nothing and is not even answered", async () => {
  // The gate is the first thing deliver does, exactly as it is for an inbound message: a press
  // answers a question inside a running session. Silence rather than a refusal, because an
  // interaction from an account this broker does not act for is owed no reply, and one would
  // confirm the message it named is live.
  const { router, entryId, desk, writes, callbacks } = harness();

  await router.deliver(
    press({ senderId: INTRUDER, customId: `qd:${entryId}:0`, values: ["0"] }),
  );
  await router.deliver(press({ senderId: INTRUDER, customId: `qd:${entryId}:send` }));
  await router.deliver(press({ senderId: INTRUDER, customId: `qd:${entryId}:console` }));

  assert.deepEqual(callbacks, [], "nothing is said back to them");
  assert.deepEqual(writes, [], "and the session's hold is untouched");
  const entry = desk.entry(entryId);
  assert.deepEqual(entry?.selections, [[], []], "no selection was recorded either");
});

test("the operator's presses accumulate and Send submits the measured answers shape", async () => {
  // The wire shape the whole design rests on: a map keyed by the exact question text the payload
  // carried, a single-select answering with one label string and a multi-select with an array.
  const { router, entryId, writes, callbacks, refreshed } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["1"] }));
  await router.deliver(press({ customId: `qd:${entryId}:1`, values: ["0", "2"] }));
  assert.deepEqual(writes, [], "an ask carrying a multi-select waits for Send");
  assert.deepEqual(
    callbacks.map((call) => call.kind),
    ["acknowledge", "acknowledge"],
  );
  assert.deepEqual(
    refreshed.map((entry) => entry.selections),
    [
      [["Review-Only"], []],
      [["Review-Only"], ["Desk", "Docs"]],
    ],
    "each selection redraws the message, so the menu shows what is chosen",
  );

  await router.deliver(press({ customId: `qd:${entryId}:send` }));
  assert.deepEqual(submitted(writes), {
    "Commit model for this effort?": "Review-Only",
    "Which sections ship first?": ["Desk", "Docs"],
  });
  assert.equal(callbacks[2].kind, "acknowledge", "a submit that landed says nothing extra");
});

test("Send with a question still unanswered submits nothing and names that question", async () => {
  const { router, entryId, writes, callbacks } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:send` }));

  assert.deepEqual(writes, [], "a partial answer would commit the session to picks nobody made");
  assert.deepEqual(callbacks[1], { kind: "ephemeral", text: incompleteNotice(2) });

  await router.deliver(press({ customId: `qd:${entryId}:1`, values: ["1"] }));
  await router.deliver(press({ customId: `qd:${entryId}:send` }));
  assert.deepEqual(submitted(writes), {
    "Commit model for this effort?": "Commit-and-Push",
    "Which sections ship first?": ["Message"],
  });
});

test("the fast path's button answers the whole ask on one tap", async () => {
  // A single-select-only ask is complete the moment its last question has a value, so the tap that
  // chooses is the tap that submits and no Send is drawn at all.
  const { router, entryId, writes, callbacks, refreshed } = harness(oneQuestion());

  await router.deliver(press({ customId: `qd:${entryId}:0:0` }));

  assert.deepEqual(submitted(writes), { "Ship the migration now?": "Now" });
  assert.deepEqual(callbacks, [{ kind: "acknowledge", text: null }]);
  assert.deepEqual(refreshed, [], "nothing is redrawn: the terminal edit closes the message out");
});

test("Answer at console releases the hold to the picker", async () => {
  const { router, entryId, writes, callbacks, desk } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:console` }));

  assert.deepEqual(writes, [{}], "the no-decision body, which renders the console picker");
  assert.deepEqual(callbacks, [{ kind: "acknowledge", text: null }]);
  assert.equal(desk.entry(entryId), null, "and nothing is held any longer");
});

test("a press against an ask that is no longer open tells the presser and nothing else", async () => {
  const { router, entryId, desk, callbacks, writes } = harness();
  assert.equal(desk.release(SESSION), true);

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:send` }));

  assert.deepEqual(callbacks, [
    { kind: "ephemeral", text: CLOSED_NOTICE },
    { kind: "ephemeral", text: CLOSED_NOTICE },
  ]);
  assert.deepEqual(writes, [{}], "the release is the one answer that response ever got");
});

test("a component this module did not write resolves to nothing at all", async () => {
  const { router, entryId, callbacks, writes } = harness();

  for (const customId of ["", "other:x:0", `qd:${entryId}`, `qd:${entryId}:x`]) {
    await router.deliver(press({ customId }));
  }
  // A well-formed id naming an entry nothing holds is a different case: it is answered, because a
  // real message whose hold has ended is exactly what produces one.
  await router.deliver(press({ customId: "qd:deadbeefdead:0", values: ["0"] }));

  assert.deepEqual(callbacks, [{ kind: "ephemeral", text: CLOSED_NOTICE }]);
  assert.deepEqual(writes, []);
});

test("a selection naming an option the ask never offered selects nothing", async () => {
  // Positions cross the wire and labels come off the entry, so a stale or forged value cannot
  // submit an answer the picker never showed.
  const { router, entryId, desk, writes } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:1`, values: ["9", "0"] }));
  assert.deepEqual(desk.entry(entryId)?.selections, [[], ["Desk"]]);

  await router.deliver(press({ customId: `qd:${entryId}:9`, values: ["0"] }));
  assert.deepEqual(
    desk.entry(entryId)?.selections,
    [[], ["Desk"]],
    "a question position outside the ask records nothing",
  );

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:send` }));
  assert.deepEqual(submitted(writes), {
    "Commit model for this effort?": "Commit-and-Push",
    "Which sections ship first?": ["Desk"],
  });
});

test("a single-select reports one label however many values arrive with the press", async () => {
  // Discord's own max_values holds a single-select to one, but the value that reaches this layer
  // is the client's report, not this broker's constraint.
  const { router, entryId, desk } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["1", "0"] }));
  assert.deepEqual(desk.entry(entryId)?.selections, [["Review-Only"], []]);
});

test("a press the bucket cannot answer is dropped before the desk resolves anything", async () => {
  // A press that resolves on the desk and is then left unanswered is the worst of both: the session
  // proceeds on an answer nobody sees land, while the operator's client reports the tap as failed
  // and sends them to a console picker the hold is still blinding. So the budget is spent or the
  // press is dropped whole.
  const { router, entryId, desk, writes, callbacks } = harness(questions(), {
    remaining: 0,
    resetAfterMs: null,
    retryAfterMs: 60_000,
  });

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["1"] }));
  await router.deliver(press({ customId: `qd:${entryId}:1`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:send` }));

  assert.equal(callbacks.length, 1, "the first press blocked the bucket, and nothing else was answered");
  assert.deepEqual(
    desk.entry(entryId)?.selections,
    [["Review-Only"], []],
    "the dropped presses recorded nothing",
  );
  assert.deepEqual(writes, [], "and the hold is untouched, still answerable at the console");
});

test("a refused press is one log line however many times it is pressed", async () => {
  // A press is one tap by anybody who can see the thread, so an account outside the allowlist can
  // write one line per tap for as long as it cares to, rotating every other line out of the log.
  const { router, entryId, logged } = harness();

  for (let index = 0; index < 5; index += 1) {
    await router.deliver(press({ senderId: INTRUDER, customId: `qd:${entryId}:0`, values: ["0"] }));
  }

  assert.equal(
    logged.filter((line) => line.includes("is not the allowed sender")).length,
    1,
    "the first is written at once and the rest of the window is counted",
  );
});

test("a press from a thread the ask's message does not live in resolves nothing", async () => {
  // A custom_id is opaque, but it is still a string that travels: nothing else in the reference ties
  // it to the one thread its message was drawn in. Defence behind the allowlist, and one comparison.
  const { router, entryId, desk, writes, callbacks } = harness();

  await router.deliver(press({ threadId: "thread-9", customId: `qd:${entryId}:console` }));
  await router.deliver(press({ threadId: "thread-9", customId: `qd:${entryId}:0`, values: ["0"] }));

  assert.deepEqual(callbacks, [
    { kind: "ephemeral", text: CLOSED_NOTICE },
    { kind: "ephemeral", text: CLOSED_NOTICE },
  ]);
  assert.deepEqual(writes, [], "the hold stands");
  assert.deepEqual(desk.entry(entryId)?.selections, [[], []]);
});

test("a select reporting nothing chosen clears that question rather than keeping the last pick", async () => {
  // The menu takes a minimum of zero, so a choice made by accident can be taken back. What holds
  // the submit guarantee is the desk: a question with nothing in it is named, and nothing is sent.
  const { router, entryId, desk, writes, callbacks } = harness();

  await router.deliver(press({ customId: `qd:${entryId}:0`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:1`, values: ["0", "1"] }));
  assert.deepEqual(desk.entry(entryId)?.selections, [["Commit-and-Push"], ["Desk", "Message"]]);

  await router.deliver(press({ customId: `qd:${entryId}:1`, values: [] }));
  assert.deepEqual(desk.entry(entryId)?.selections, [["Commit-and-Push"], []]);

  await router.deliver(press({ customId: `qd:${entryId}:send` }));
  assert.deepEqual(writes, [], "a cleared question is an unanswered one");
  assert.deepEqual(callbacks.at(-1), { kind: "ephemeral", text: incompleteNotice(2) });
});

test("no log line carries a question, an option, or an interaction token", async () => {
  const { router, entryId, logged } = harness();

  await router.deliver(press({ senderId: INTRUDER, customId: `qd:${entryId}:0`, values: ["0"] }));
  await router.deliver(press({ customId: `qd:${entryId}:console` }));

  assert.ok(logged.length > 0, "the presses above are logged at all");
  const text = logged.join("\n");
  assert.ok(!text.includes("SECRET"), text);
  assert.ok(!text.includes("Commit"), text);
  assert.ok(!text.includes("Review-Only"), text);
});
