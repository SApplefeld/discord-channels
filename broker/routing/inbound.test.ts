// The inbound path, which is the one place a message from outside this machine can reach Claude.
// Section 6's sender gate attaches to the top of createInboundRouter's `deliver`, so these lock the
// behavior it will sit in front of.
//
// Every control character in this file is built with String.fromCharCode. A literal one makes git
// classify the file as binary, and a test nobody can ever read a diff of is a test nobody reviews.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
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

function announce(registry: Registry, sessionId: string, processToken = TOKEN): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    sessionId,
    source: "startup",
    toolName: null,
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
  const router = createInboundRouter({
    registry,
    relays,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    writer: createThreadWriter({ messenger, now }),
    now,
  });
  return { registry, relays, router, sent, notices };
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    threadId: THREAD,
    senderId: "700000000000000002",
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
  // There is no sender gate in front of this yet, so anyone who can post in the channel can push
  // text into a running session's context as fast as they can type.
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

test("a failed notice does not propagate out of the router", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: 10_000 });
  const router = createInboundRouter({
    registry,
    relays,
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
