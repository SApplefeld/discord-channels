// The inbound path, which is the one place a message from outside this machine can reach Claude.
// The sender gate is the first thing it does, and several of these lock that ordering rather than
// only its outcome: a refusal that happens after the verdict pattern has already run is a bypass
// that no assertion about the final state can see.
//
// Every control character in this file is built with String.fromCharCode. A literal one makes git
// classify the file as binary, and a test nobody can ever read a diff of is a test nobody reviews.
import { test } from "node:test";
import assert from "node:assert/strict";
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
 */
function watchedDesk() {
  const resolved: Array<{ threadId: string; verdict: Verdict }> = [];
  const requested: string[] = [];
  const desk: PermissionDesk = {
    request: async (processToken) => {
      requested.push(processToken);
      return true;
    },
    resolve: async (threadId, verdict) => {
      resolved.push({ threadId, verdict });
    },
    waiting: () => new Set<string>(),
  };
  return { desk, resolved, requested };
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
  });
}

function harness(options: { attachRelay?: boolean; now?: () => number } = {}) {
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
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const permissions = watchedDesk();
  const router = createInboundRouter({
    registry,
    relays,
    gate: createSenderGate(OPERATOR),
    permissions: permissions.desk,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    writer: createThreadWriter({ messenger, now }),
    now,
  });
  return { registry, relays, router, sent, notices, verdicts: permissions.resolved };
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    threadId: THREAD,
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

test("a failed notice does not propagate out of the router", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: 10_000 });
  const router = createInboundRouter({
    registry,
    relays,
    gate: createSenderGate(OPERATOR),
    permissions: watchedDesk().desk,
    threadFor: () => THREAD,
    writer: createThreadWriter({
      messenger: {
        postToThread: async () => {
          throw new Error("discord refused");
        },
      },
      now: Date.now,
    }),
  });
  await assert.doesNotReject(() => router.deliver(message()));
});
