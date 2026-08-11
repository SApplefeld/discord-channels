// The inbound path, which is the one place a message from outside this machine can reach Claude.
// The sender gate is the first thing it does, and several of these lock that ordering rather than
// only its outcome: a refusal that happens after the verdict pattern has already run is a bypass
// that no assertion about the final state can see.
//
// Every control character in this file is built with String.fromCharCode. A literal one makes git
// classify the file as binary, and a test nobody can ever read a diff of is a test nobody reviews.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { MAX_LINE_BYTES } from "../../relay/broker.ts";
import type { AskedQuestion } from "../discord/render.ts";
import { createQuestionDesk } from "../question-desk.ts";
import { questionDigest } from "../tail.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { createSenderGate } from "../security/senders.ts";
import type { PermissionDesk, Verdict } from "../security/permission.ts";
import { createRelayHub } from "./relays.ts";
import type { RelayEvent } from "./relays.ts";
import { createThreadWriter } from "./writer.ts";
import {
  ENDED_NOTICE,
  MAX_INBOUND_PER_WINDOW,
  MAX_INBOUND_TEXT_LENGTH,
  TRUNCATED_NOTICE,
  UNREACHABLE_NOTICE,
  createInboundRouter,
} from "./inbound.ts";
import type { InboundMessage } from "./inbound.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";
const OPERATOR = "700000000000000002";
const STRANGER = "700000000000000003";

/**
 * A desk that records what it was asked, rather than one that decides. The gate's ordering is only
 * observable from here: whether a stranger's verdict was refused before the pattern ran, or merely
 * refused, is the difference between a call recorded and no call at all.
 *
 * `resolves` is whether the desk holds an open request under the id a verdict names. True by
 * default, the state a verdict is written against; false is a real desk that found nothing open,
 * which is what leaves the message in play for the paths below the verdict branch.
 */
function watchedDesk(options: { resolves?: boolean } = {}) {
  const resolved: Array<{ threadId: string; verdict: Verdict }> = [];
  const unknown: Array<{ threadId: string; verdict: Verdict }> = [];
  const requested: string[] = [];
  const desk: PermissionDesk = {
    request: async (processToken) => {
      requested.push(processToken);
      return true;
    },
    resolve: (threadId, verdict) => {
      resolved.push({ threadId, verdict });
      return options.resolves ?? true;
    },
    reportUnknownVerdict: async (threadId, verdict) => {
      unknown.push({ threadId, verdict });
    },
    turnEnded: () => {},
    sweepEnded: () => {},
    settled: () => Promise.resolve(),
    waiting: () => new Set<string>(),
  };
  return { desk, resolved, unknown, requested };
}

function announce(registry: Registry, sessionId: string, processToken = TOKEN): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    sessionId,
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
}

/**
 * The real desk behind one held ask for `session-a`, so a typed answer is asserted on the JSON the
 * hook response actually carries rather than on a call the router made. The wire shape is the whole
 * point of the path, and a hand-built stub cannot catch a change to it.
 */
function heldQuestion() {
  const questions: AskedQuestion[] = [
    {
      question: "Which beverage?",
      header: "Beverage",
      multiSelect: false,
      options: [{ label: "Coffee", description: null }],
    },
  ];
  const questionsInput = [
    { question: "Which beverage?", header: "Beverage", options: [{ label: "Coffee" }] },
  ];
  const writes: unknown[] = [];
  let ended = false;
  const response = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead: () => response,
    end: (text: string) => {
      ended = true;
      writes.push(JSON.parse(text));
    },
    once: () => response,
  };
  // Hand-driven timers, and never fired here: a real four-hour expiry timer would hold the test
  // runner's event loop open for as long as it is pending.
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    setTimer: () => ({}) as unknown as NodeJS.Timeout,
    clearTimer: () => {},
  });
  return {
    desk,
    writes,
    /** Puts one ask in the desk, alerted, which is the state a typed answer is read against. */
    hold: (sessionId = "session-a"): void => {
      desk.hold(sessionId, questions, questionsInput, response as unknown as ServerResponse, true);
      desk.noteAlert(sessionId, questionDigest(questions), {
        threadId: THREAD,
        messageId: "920000000000000001",
      });
    },
    questionsInput,
    answered: (): boolean => ended,
  };
}

function harness(
  options: {
    attachRelay?: boolean;
    now?: () => number;
    questions?: { answerTyped: (sessionId: string, response: string) => boolean };
    /** Whether the permission desk has an open request for the id a verdict names. */
    verdictResolves?: boolean;
  } = {},
) {
  const now = options.now ?? ((): number => 1_000);
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: 10_000, now });
  const sent: RelayEvent[] = [];
  if (options.attachRelay !== false) {
    relays.attach(TOKEN, {
      send: (event) => {
        // The hello line is the hub's own handshake, not traffic this router produced.
        if (event.type !== "hello") sent.push(event);
        return true;
      },
      close: () => {},
    });
  }
  const notices: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      notices.push({ threadId: input.threadId, text: input.text });
      return { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const permissions = watchedDesk({ resolves: options.verdictResolves });
  const typed: string[] = [];
  const router = createInboundRouter({
    registry,
    relays,
    gate: createSenderGate(OPERATOR),
    permissions: permissions.desk,
    // Nothing held, unless a test wires a desk that holds something: the default is a broker whose
    // sessions have no question parked, which is every test above.
    questions: options.questions ?? {
      answerTyped: (_sessionId, response) => {
        typed.push(response);
        return false;
      },
    },
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    writer: createThreadWriter({ messenger, now }),
    now,
  });
  return {
    registry,
    relays,
    router,
    sent,
    notices,
    typed,
    verdicts: permissions.resolved,
    unknownVerdicts: permissions.unknown,
  };
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    threadId: THREAD,
    messageId: "910000000000000001",
    senderId: OPERATOR,
    fromBot: false,
    text: "please run the migration",
    ...overrides,
  };
}

test("a message in a session's thread reaches that session, carrying the thread as chat_id", async () => {
  const { router, sent } = harness();
  await router.deliver(message());
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "please run the migration" },
  ]);
});

test("the broker's own messages are not routed back into the session that prompted them", async () => {
  // Every card, reply, and notice this broker writes arrives back over the same gateway.
  const { router, sent, notices } = harness();
  await router.deliver(message({ fromBot: true, text: "Sent to the operator's thread." }));
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, []);
});

test("a message in a thread this broker does not own is ignored in silence", async () => {
  const { router, sent, notices } = harness();
  await router.deliver(message({ threadId: "900000000000000099" }));
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, [], "a thread of the operator's own earns no notice");
});

test("a message addressed to an ended session is rejected in-thread", async () => {
  const { registry, router, sent, notices } = harness();
  registry.relayClosed(TOKEN, "session-a");

  await router.deliver(message());
  assert.deepEqual(sent, [], "nothing is queued for a session that has ended");
  assert.deepEqual(notices, [{ threadId: THREAD, text: ENDED_NOTICE }]);
});

test("a message to a live session with no relay attached is rejected in-thread", async () => {
  const { router, notices } = harness({ attachRelay: false });
  await router.deliver(message());
  assert.deepEqual(notices, [{ threadId: THREAD, text: UNREACHABLE_NOTICE }]);
});

test("the text is stripped of escape sequences and is otherwise untouched", async () => {
  const escape = String.fromCharCode(0x1b);
  const nul = String.fromCharCode(0x00);
  const { router, sent } = harness();
  await router.deliver(
    message({ text: `  ${escape}[31mred${nul}\r\nand **markdown** @everyone  ` }),
  );
  assert.deepEqual(sent, [
    // The escape and the NUL are gone; the markdown, the mention text, and the newline are not.
    // Neutralizing display syntax belongs at the render site, and Claude Code owns the envelope
    // this content lands in.
    { type: "message", chatId: THREAD, text: "[31mred\nand **markdown** @everyone" },
  ]);
});

test("the text is stripped of the characters that would show the operator a different message", async () => {
  // The operator reads the original in Discord and the model reads this. A bidi override or a
  // zero-width joiner makes those two different texts, and the whole control this design rests on
  // is a person judging what is safe to send.
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const zeroWidth = String.fromCharCode(0x200b);
  const bom = String.fromCharCode(0xfeff);
  const { router, sent } = harness();
  await router.deliver(
    message({ text: `delete${zeroWidth} nothing${rightToLeftOverride}${bom}` }),
  );
  assert.deepEqual(sent, [{ type: "message", chatId: THREAD, text: "delete nothing" }]);
});

test("a message longer than the cap is cut on code points, never mid-character", async () => {
  // A slice by UTF-16 unit can end between the halves of an astral-plane character, and a lone
  // surrogate is not valid UTF-8 for the JSON-RPC frame this text rides in.
  const astral = String.fromCodePoint(0x1f600);
  const { router, sent } = harness();
  await router.deliver(message({ text: astral.repeat(MAX_INBOUND_TEXT_LENGTH + 100) }));

  const text = (sent[0] as { text: string }).text;
  assert.equal([...text].length, MAX_INBOUND_TEXT_LENGTH);
  assert.equal(text, astral.repeat(MAX_INBOUND_TEXT_LENGTH), "no half character survived the cut");
});

test("a message of exactly the cap is delivered whole, with no cut and no notice", async () => {
  // The cap matches Discord's own maximum message length, so this is the longest message any
  // client can send, and it must land untouched: the slice is a backstop, not a working path.
  const astral = String.fromCodePoint(0x1f600);
  const { router, sent, notices } = harness();
  await router.deliver(message({ text: astral.repeat(MAX_INBOUND_TEXT_LENGTH) }));
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: astral.repeat(MAX_INBOUND_TEXT_LENGTH) },
  ]);
  assert.deepEqual(notices, [], "a message delivered whole earns no notice");
});

test("a delivered cut is announced in the thread, never suffered in silence", async () => {
  // The expensive failure is the tail of a dictation vanishing with no signal on either end: the
  // operator resumes the conversation believing the session heard all of it.
  const { router, sent, notices } = harness();
  await router.deliver(message({ text: "a".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }));
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "a".repeat(MAX_INBOUND_TEXT_LENGTH) },
  ]);
  assert.deepEqual(notices, [{ threadId: THREAD, text: TRUNCATED_NOTICE }]);
});

test("a cut on a message that reached no session posts no notice", async () => {
  // The truncation notice belongs to a delivery: announcing a cut on text nobody received would be
  // noise in a thread this broker does not even own.
  const { router, sent, notices } = harness();
  await router.deliver(
    message({ threadId: "900000000000000099", text: "a".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }),
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, []);
});

test("two delivered cuts in immediate succession are both announced", async () => {
  // The announcement is unfloored: a per-thread notice floor here would let the first cut swallow
  // the second's announcement, recreating the silent loss the announcement exists to kill.
  const { router, sent, notices } = harness();
  await router.deliver(message({ text: "a".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }));
  await router.deliver(message({ text: "b".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }));
  assert.equal(sent.length, 2);
  assert.deepEqual(notices, [
    { threadId: THREAD, text: TRUNCATED_NOTICE },
    { threadId: THREAD, text: TRUNCATED_NOTICE },
  ]);
});

test("a truncation announcement does not spend the floor the failure notices need", async () => {
  // The ended and unreachable notices share a per-thread floor in the writer. The announcement
  // posts outside it, so a delivered cut followed straight away by a message into the session's
  // corpse still earns the ended notice.
  const { registry, router, notices } = harness();
  await router.deliver(message({ text: "a".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }));
  registry.relayClosed(TOKEN, "session-a");
  await router.deliver(message());
  assert.deepEqual(notices, [
    { threadId: THREAD, text: TRUNCATED_NOTICE },
    { threadId: THREAD, text: ENDED_NOTICE },
  ]);
});

test("an over-ceiling message whose cut lands on a verdict shape is chat, never a verdict", async () => {
  // The verdict pattern tolerates a run of interior whitespace, so an over-ceiling message can be
  // cut into an exact verdict match. The message the operator actually sent was not a verdict, and
  // resolving one from the cut would approve a tool call on words the full text never said, so a
  // truncated message is never parsed as one: it flows to the session as chat, announced.
  const prefix = `y${" ".repeat(MAX_INBOUND_TEXT_LENGTH - 6)}abcde`;
  const { router, verdicts, sent, notices } = harness();
  await router.deliver(message({ text: `${prefix} and then the tail Discord accepted` }));
  assert.deepEqual(verdicts, [], "a cut resolved a permission request the full message never stated");
  assert.deepEqual(sent, [{ type: "message", chatId: THREAD, text: prefix }]);
  assert.deepEqual(notices, [{ threadId: THREAD, text: TRUNCATED_NOTICE }]);
});

test("the worst-case inbound line fits under the relay's stream buffer cap", () => {
  // The broker writes a stream line the relay reads, and the relay silently drops any line past
  // its buffer cap. The widest per-code-point encoding a message can reach on that wire is a lone
  // surrogate: it survives the invisible strip and the code-point cut as one code point, and
  // JSON.stringify escapes it as six bytes. The relay's guard compares the UTF-16 length of its
  // accumulated decoded buffer, and a string's UTF-8 byte length is always at least its UTF-16
  // unit count, so the byte-length bound here is the conservative one. Both constants are imported
  // real: neither can move without this relation being re-proven.
  const loneSurrogate = String.fromCharCode(0xd800);
  const event = {
    type: "message",
    // Snowflakes reach twenty digits.
    chatId: "90000000000000000001",
    text: loneSurrogate.repeat(MAX_INBOUND_TEXT_LENGTH),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < MAX_LINE_BYTES);
});

test("a message with no text at all is dropped without a notice", async () => {
  const { router, sent, notices } = harness();
  await router.deliver(message({ text: "      " }));
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, [], "an attachment-only message is not a delivery failure");
});

test("a flood into one session's thread is cut off at the rate ceiling", async () => {
  // The gate narrows this to one account, and the ceiling is what keeps that one account's stuck
  // client or fat-fingered paste from flooding a running session's context.
  let now = 1_000;
  const { router, sent } = harness({ now: () => now });
  for (let index = 0; index < MAX_INBOUND_PER_WINDOW + 10; index += 1) {
    now += 100;
    await router.deliver(message({ text: `message ${String(index)}` }));
  }
  assert.equal(sent.length, MAX_INBOUND_PER_WINDOW);

  now += 60_000;
  await router.deliver(message({ text: "after the window" }));
  assert.equal(sent.length, MAX_INBOUND_PER_WINDOW + 1, "the window reopens");
});

test("the rate ceiling is spent only by the session a message was actually addressed to", async () => {
  let now = 1_000;
  const { router, sent } = harness({ now: () => now });
  for (let index = 0; index < MAX_INBOUND_PER_WINDOW + 10; index += 1) {
    now += 10;
    await router.deliver(message({ threadId: "900000000000000099" }));
  }
  await router.deliver(message());
  assert.equal(sent.length, 1, "traffic in someone else's thread cost this session nothing");
});

test("a message from anyone but the allowed sender never reaches the session", async () => {
  // Gating on the thread instead of the author would make access to the room the credential, and
  // every member of the channel could steer a session.
  const { router, sent, notices } = harness();
  await router.deliver(message({ senderId: STRANGER, text: "rm -rf the repository" }));
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, [], "a refusal is not answered in-thread, which would confirm the gate");

  await router.deliver(message());
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "please run the migration" },
  ]);
});

test("a verdict-shaped message from a stranger is refused before the pattern is even read", async () => {
  // Outcome-equal is not enough here, and the permission desk is what makes this more than that.
  // The router gates, then reads the pattern, then resolves a verdict against the desk. Move the
  // gate below that block and a stranger's "y abcde" parses and reaches `resolve`, so `verdicts`
  // stops being empty and this reddens. The desk is the witness precisely because it sits on the
  // far side of the pattern.
  const { router, verdicts, sent } = harness();
  await router.deliver(message({ senderId: STRANGER, text: "y abcde" }));
  assert.deepEqual(verdicts, [], "the pattern ran on a message the gate should have refused first");
  assert.deepEqual(sent, []);
});

test("a verdict from the operator is consumed as a verdict and not also as chat", async () => {
  const { router, verdicts, sent } = harness();
  await router.deliver(message({ text: " Y ABCDE " }));
  assert.deepEqual(verdicts, [
    { threadId: THREAD, verdict: { behavior: "allow", requestId: "abcde" } },
  ]);
  assert.deepEqual(sent, [], "the model is not handed a message the operator wrote for the broker");
});

test("a message that is not a verdict is chat, and reaches the session unchanged", async () => {
  const { router, verdicts, sent } = harness();
  await router.deliver(message({ text: "y abcde and then stop" }));
  assert.deepEqual(verdicts, []);
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "y abcde and then stop" },
  ]);
});

test("a verdict costs a session nothing from its inbound rate ceiling", async () => {
  // A verdict is not text handed to the model, so spending the message allowance on one would let
  // a run of approvals lock the operator out of talking to the session they are approving for.
  let now = 1_000;
  const { router, verdicts, sent } = harness({ now: () => now });
  for (let index = 0; index < MAX_INBOUND_PER_WINDOW + 5; index += 1) {
    now += 10;
    await router.deliver(message({ text: "n abcde" }));
  }
  assert.equal(verdicts.length, MAX_INBOUND_PER_WINDOW + 5);
  await router.deliver(message());
  assert.equal(sent.length, 1, "the session can still be spoken to");
});

test("a typed message answers the session's held question, and is not also steering", async () => {
  // The hold's own answer channel. The session is parked inside the tool call this answers, so the
  // same text delivered as chat would reach the model as a second, contextless copy of an answer it
  // is already being handed.
  const question = heldQuestion();
  const { router, sent } = harness({ questions: { answerTyped: question.desk.answerTyped } });
  question.hold();

  await router.deliver(message({ text: "whichever one you have already opened" }));

  assert.deepEqual(sent, [], "an answer is spent on the question, never delivered as steering");
  assert.deepEqual(question.writes, [
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        // The measured vocabulary: `response` is a sibling of `answers` that replaces the
        // per-question answers for the whole ask, and the payload's own questions array rides back
        // verbatim because the session re-reads its whole tool input from this body.
        updatedInput: {
          questions: question.questionsInput,
          response: "whichever one you have already opened",
        },
      },
    },
  ]);
  const body = question.writes[0] as { hookSpecificOutput: { updatedInput: object } };
  assert.equal(
    Object.hasOwn(body.hookSpecificOutput.updatedInput, "answers"),
    false,
    "a free-form answer carries no answers map: the two spellings are alternatives",
  );
});

test("with no question held, the same message steers exactly as it does today", async () => {
  const question = heldQuestion();
  const { router, sent } = harness({ questions: { answerTyped: question.desk.answerTyped } });

  await router.deliver(message({ text: "whichever one you have already opened" }));
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "whichever one you have already opened" },
  ]);
  assert.equal(question.answered(), false, "nothing was held, so nothing was answered");
});

test("a second message during the same hold steers: one ask takes one answer", async () => {
  // The answer resolves the entry, so the desk holds nothing by the time the next message lands
  // and the session is no longer parked. Whatever the operator says next is steering again.
  const question = heldQuestion();
  const { router, sent } = harness({ questions: { answerTyped: question.desk.answerTyped } });
  question.hold();

  await router.deliver(message({ text: "the first one" }));
  await router.deliver(message({ text: "and get on with it" }));
  assert.equal(question.writes.length, 1);
  assert.deepEqual(sent, [{ type: "message", chatId: THREAD, text: "and get on with it" }]);
});

test("a verdict is a verdict even while a question is held, never that question's answer", async () => {
  // Pipeline order, in the one direction it can be got wrong: the verdict pattern runs first, so a
  // permission approval typed during a hold approves the tool call it names instead of being eaten
  // as prose the session asked for.
  const question = heldQuestion();
  const { router, sent, verdicts, unknownVerdicts } = harness({
    questions: { answerTyped: question.desk.answerTyped },
  });
  question.hold();

  await router.deliver(message({ text: "y abcde" }));
  assert.deepEqual(verdicts, [
    { threadId: THREAD, verdict: { behavior: "allow", requestId: "abcde" } },
  ]);
  assert.equal(question.answered(), false, "the hold is untouched and still answerable");
  assert.deepEqual(sent, []);
  assert.deepEqual(unknownVerdicts, [], "a verdict the desk consumed is not also reported unknown");

  // And the hold is still there to answer, which is what makes the ordering safe rather than lossy.
  await router.deliver(message({ text: "now the beverage" }));
  assert.equal(question.writes.length, 1);
});

test("a verdict shape the desk had nothing open for answers the held question instead", async () => {
  // The shape collision this ordering exists for: five letters after a yes or a no is an ordinary
  // English reply, and "yes merge" typed at a parked question would otherwise be eaten by the
  // verdict pattern, draw a notice naming a request the operator never typed, and leave the session
  // parked for the rest of a four-hour hold.
  const question = heldQuestion();
  const { router, sent, notices, verdicts, unknownVerdicts } = harness({
    verdictResolves: false,
    questions: { answerTyped: question.desk.answerTyped },
  });
  question.hold();

  await router.deliver(message({ text: "yes merge" }));

  assert.equal(question.writes.length, 1, "the operator's words reached the question they answered");
  const body = question.writes[0] as {
    hookSpecificOutput: { updatedInput: { response: string } };
  };
  assert.equal(body.hookSpecificOutput.updatedInput.response, "yes merge");
  assert.deepEqual(
    verdicts,
    [{ threadId: THREAD, verdict: { behavior: "allow", requestId: "merge" } }],
    "the desk was still offered it first, which is what keeps a real verdict winning",
  );
  assert.deepEqual(unknownVerdicts, [], "nothing named a request the operator never typed");
  assert.deepEqual(notices, []);
  assert.deepEqual(sent, [], "an answer is spent on the question, never delivered as steering");
});

test("a verdict shape with nothing open and no question held is still reported unknown", async () => {
  // The path a mistyped or post-restart verdict takes. Silence here reads, from a phone, exactly
  // like an approval that worked, so the report is what the fall-through above must not cost.
  const { router, sent, unknownVerdicts } = harness({ verdictResolves: false });

  await router.deliver(message({ text: "no there" }));
  assert.deepEqual(unknownVerdicts, [
    { threadId: THREAD, verdict: { behavior: "deny", requestId: "there" } },
  ]);
  assert.deepEqual(sent, [], "a verdict shape is never handed to the model as chat");

  // And in a thread with no session behind it at all, where there is no question path to try.
  await router.deliver(message({ threadId: "900000000000000099", text: "no there" }));
  assert.equal(unknownVerdicts.length, 2);
});

test("a cut message is never a partial answer, and flows on as the announced chat it is", async () => {
  // The rule the verdict pattern already follows: what a message is, is decided from the whole
  // message. Injecting the beginning of a cut one would answer the session's question with a
  // sentence that stops mid-thought, and the operator would have no way to see that it did.
  const question = heldQuestion();
  const { router, sent, notices } = harness({
    questions: { answerTyped: question.desk.answerTyped },
  });
  question.hold();

  await router.deliver(message({ text: "a".repeat(MAX_INBOUND_TEXT_LENGTH + 1) }));
  assert.equal(question.answered(), false, "the question is still held, and still answerable");
  assert.deepEqual(sent, [
    { type: "message", chatId: THREAD, text: "a".repeat(MAX_INBOUND_TEXT_LENGTH) },
  ]);
  assert.deepEqual(notices, [{ threadId: THREAD, text: TRUNCATED_NOTICE }]);
});

test("an answer is taken from a session whose relay has dropped, not refused as undeliverable", async () => {
  // The held response is an HTTP socket the desk owns, independent of the relay pipe: a session
  // that lost its relay can still be parked on a question, and the ended notice would leave that
  // question to expire while telling the operator their answer went nowhere.
  const question = heldQuestion();
  const { registry, router, notices } = harness({
    questions: { answerTyped: question.desk.answerTyped },
  });
  question.hold();
  registry.relayClosed(TOKEN, "session-a");

  await router.deliver(message({ text: "the second option" }));
  assert.equal(question.writes.length, 1, "the desk answered it");
  assert.deepEqual(notices, [], "and nothing told the operator it was not delivered");
});

test("the rate ceiling never eats an answer to a held question", async () => {
  // A verdict is exempt for the same reason: the ceiling bounds what a flood puts into a session's
  // context, and a hold takes exactly one message.
  let now = 1_000;
  const question = heldQuestion();
  const { router } = harness({
    now: () => now,
    questions: { answerTyped: question.desk.answerTyped },
  });
  for (let index = 0; index < MAX_INBOUND_PER_WINDOW + 5; index += 1) {
    now += 10;
    await router.deliver(message({ text: `message ${String(index)}` }));
  }

  // The window is spent, and only now does the session park on a question.
  question.hold();
  await router.deliver(message({ text: "the second option" }));
  assert.equal(question.writes.length, 1, "the answer landed on a session over its ceiling");
});

test("a failed notice does not propagate out of the router", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: 10_000 });
  const router = createInboundRouter({
    registry,
    relays,
    gate: createSenderGate(OPERATOR),
    permissions: watchedDesk().desk,
    questions: { answerTyped: () => false },
    threadFor: () => THREAD,
    writer: createThreadWriter({
      messenger: {
        postToThread: async () => {
          throw new Error("discord refused");
        },
        editInThread: async () => {
          throw new Error("discord refused");
        },
      },
      now: Date.now,
    }),
  });
  await assert.doesNotReject(() => router.deliver(message()));
});
