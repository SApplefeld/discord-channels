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

test("one message moves delivered -> picked up -> answered, settling on one stage emoji at a time", async () => {
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

/** A `sleep` that never really waits, recording every requested wait in order. */
function fastSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

test("a stage change lands both its add and its remove against a bucket that empties on every call", async () => {
  // Discord's reaction route commonly answers a call with remaining: 0 and a reset on the order of
  // a quarter second: not a 429, just a bucket that is empty again the instant it is spent. The
  // thread's queue must wait that out rather than drop the second half of the pair.
  const { calls, reactions } = reactionsWith(() => ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null }));
  const { now } = clock();
  const log: string[] = [];
  const { waits, sleep } = fastSleep();
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.pickedUp("thread-1", now());
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.pickedUp]));
  assert.deepEqual(log, [], "an empty-but-usable bucket is not a refusal");
  assert.ok(waits.length > 0, "the pace paid a wait rather than dropping a write");
  assert.ok(
    waits.every((ms) => ms <= 250),
    "each wait is bounded by the reported reset, not the pace ceiling",
  );
});

test("a burst of several messages in one thread each get their own reaction despite one shared bucket", async () => {
  // Before the per-thread queue and budget, several messages' independent chains raced one global
  // budget and only the first of a burst landed. One thread's messages now pace against the same
  // budget in order, so all of them land instead of N-1 of them being silently dropped.
  const { calls, reactions } = reactionsWith(() => ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null }));
  const { now } = clock();
  const log: string[] = [];
  const { sleep } = fastSleep();
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  for (const messageId of ["msg-1", "msg-2", "msg-3", "msg-4"]) {
    tracker.delivered("thread-1", messageId, now());
  }
  await settle();

  for (const messageId of ["msg-1", "msg-2", "msg-3", "msg-4"]) {
    assert.deepEqual(currentEmoji(calls, messageId), new Set([STAGE_EMOJI.delivered]), messageId);
  }
  assert.deepEqual(log, []);
});

test("a write past the pace bound is skipped and reported, not delayed further", async () => {
  // A reset longer than the pace ceiling is either a genuinely stalled bucket or the budget's own
  // blind backoff standing in for a response that named no reset at all; either way, this write is
  // skipped rather than parking the whole thread's queue behind a multi-second wait.
  const { calls, reactions } = reactionsWith(() => ok({ remaining: 0, resetAfterMs: 10_000, retryAfterMs: null }));
  const { now } = clock();
  const log: string[] = [];
  const { waits, sleep } = fastSleep();
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.delivered("thread-1", "msg-2", now());
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.delivered]), "the first write spends the budget");
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set(), "the second is skipped rather than waited out");
  assert.deepEqual(waits, [], "past the bound, the write never reaches the wait at all");
  assert.equal(log.length, 1);
  assert.match(log[0], /paced past the wait bound/);
});

test("an add that fails leaves the picked-up transition's old emoji in place", async () => {
  // Requirement: the remove of a stage's old emoji must never run when the add of the new one did
  // not land, or a message the header promises never shows with no stage at all briefly shows one
  // exactly that way instead: neither the old nor the new emoji, since the old one was removed on
  // the strength of an add that never happened.
  const { calls, reactions } = reactionsWith((call) =>
    call.kind === "add" && call.emoji === STAGE_EMOJI.pickedUp
      ? { status: "failed", error: "HTTP 400", rate: NO_RATE_INFO }
      : ok(),
  );
  const { now } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  tracker.pickedUp("thread-1", now());
  await settle();

  // currentEmoji folds every attempted call, landed or not, so a failed add still shows as
  // "present" by that fold; what proves the guard is that the remove was never attempted at all.
  assert.deepEqual(
    calls.map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.pickedUp],
    ],
    "the failed add must never be followed by a remove of the emoji still standing",
  );
});

test("an add that fails leaves the answered transition's old emoji in place", async () => {
  const { calls, reactions } = reactionsWith((call) =>
    call.kind === "add" && call.emoji === STAGE_EMOJI.answered
      ? { status: "failed", error: "HTTP 400", rate: NO_RATE_INFO }
      : ok(),
  );
  const { now } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  tracker.pickedUp("thread-1", now());
  await settle();
  tracker.answered("thread-1");
  await settle();

  assert.deepEqual(
    calls.map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.pickedUp],
      ["remove", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.answered],
    ],
    "the failed add must never be followed by a remove of the emoji still standing",
  );
});

test("a thrown internal error (options.now, here) does not wedge the thread's queue for the next message", async () => {
  // Before this fix, a throw out of anything write() calls outside its own try (options.now,
  // options.log, budget.observe) rejected the chain permanently: a later `.then` chained onto a
  // rejected promise never runs its callback, so every later write for that thread was silently
  // dropped forever, not just the one that hit the throw.
  const { calls, reactions } = reactionsWith();
  const log: string[] = [];
  let calledNow = 0;
  const throwyNow = (): number => {
    calledNow += 1;
    if (calledNow === 1) throw new Error("clock exploded");
    return 1_000;
  };
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now: throwyNow });

  tracker.delivered("thread-1", "msg-1", 1_000);
  tracker.delivered("thread-1", "msg-2", 1_000);
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set(), "the write that hit the throw never called out");
  assert.deepEqual(
    currentEmoji(calls, "msg-2"),
    new Set([STAGE_EMOJI.delivered]),
    "the next message's write still ran, on the same thread's queue",
  );
  assert.equal(log.length, 1);
  assert.match(log[0], /an internal error interrupted a reaction write/);
});
