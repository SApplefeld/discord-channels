import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallOutcome, MessageReactions, RateLimitObservation } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import { STAGE_EMOJI, createReceiptTracker } from "./receipts.ts";

const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

function ok(rate: RateLimitObservation = HEALTHY): CallOutcome<null> {
  return { status: "ok", value: null, rate };
}

type Call = { kind: "add" | "remove"; threadId: string; messageId: string; emoji: string };

/** A fake reaction transport, and the current stage emoji it holds per message, folded from the
 * add/remove calls it has answered in order. */
function reactionsWith(reply: (call: Call) => CallOutcome<null> = () => ok()) {
  const calls: Call[] = [];
  const reactions: MessageReactions = {
    addReaction: async (input) => {
      const call: Call = { kind: "add", ...input };
      calls.push(call);
      return reply(call);
    },
    removeReaction: async (input) => {
      const call: Call = { kind: "remove", ...input };
      calls.push(call);
      return reply(call);
    },
  };
  return { calls, reactions };
}

/** The set of emoji still on a message, folded from the add/remove calls recorded against it. */
function currentEmoji(calls: readonly Call[], messageId: string): Set<string> {
  const set = new Set<string>();
  for (const call of calls) {
    if (call.messageId !== messageId) continue;
    if (call.kind === "add") set.add(call.emoji);
    else set.delete(call.emoji);
  }
  return set;
}

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** Lets every chained reaction write settle. Bounded on the wall clock, never on a counted turn
 * count: this repo's own async work (thread-pool reads elsewhere) races a turn-counted wait. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("one message moves delivered -> picked up -> answered, one emoji on the wire at a time", async () => {
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const log: string[] = [];
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.delivered]));

  advance(1_000);
  tracker.pickedUp("thread-1", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.pickedUp]));

  tracker.answered("thread-1");
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.answered]));

  assert.deepEqual(log, [], "nothing was refused, so nothing is logged");
});

test("a message delivered after the pickup instant stays queued through that pickup and an answer", async () => {
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  const pickupAt = now();
  tracker.pickedUp("thread-1", pickupAt);
  await settle();

  advance(1_000);
  tracker.delivered("thread-1", "msg-2", now());
  await settle();
  assert.deepEqual(
    currentEmoji(calls, "msg-2"),
    new Set([STAGE_EMOJI.delivered]),
    "msg-2 arrived after the turn that just started, so it is still queued and unread",
  );

  tracker.answered("thread-1");
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.answered]));
  assert.deepEqual(
    currentEmoji(calls, "msg-2"),
    new Set([STAGE_EMOJI.delivered]),
    "a reply to msg-1 must not mark msg-2 as answered: it was never picked up",
  );

  advance(1_000);
  tracker.pickedUp("thread-1", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.pickedUp]));
});

for (const failure of [
  { name: "a failed outcome", reply: (): CallOutcome<null> => ({ status: "failed", error: "HTTP 400", rate: NO_RATE_INFO }) },
  {
    name: "a rate-limited outcome",
    reply: (): CallOutcome<null> => ({ status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 2_000 } }),
  },
  {
    name: "a thrown error",
    reply: (): CallOutcome<null> => {
      throw new Error("socket reset");
    },
  },
]) {
  test(`${failure.name} from the reaction transport is logged and never thrown at the caller`, async () => {
    const { reactions } = reactionsWith(failure.reply);
    const { now } = clock();
    const log: string[] = [];
    const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now });

    assert.doesNotThrow(() => {
      tracker.delivered("thread-1", "msg-1", now());
    });
    await settle();

    assert.equal(log.length, 1, "exactly one refusal line, not one per call");
    assert.match(log[0], /^receipts: a reaction call was refused: /);
  });
}
