import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallOutcome, MessageReactions, RateLimitObservation } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import { PACE_MARGIN_MS, STAGE_EMOJI, createReceiptTracker } from "./receipts.ts";

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

  tracker.answered("thread-1", now());
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

  tracker.answered("thread-1", now());
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
    waits.every((ms) => ms <= 250 + PACE_MARGIN_MS),
    "each wait is bounded by the reported reset plus discord.js's own margin, not the pace ceiling",
  );
});

test("a paced write wakes past discord.js's own reset offset, not just the bucket's reported reset", async () => {
  // discord.js's own REST client (node_modules/@discordjs/rest 2.6.3) stamps every rate-limit reset
  // it records with a 50ms offset (dist/index.js:140 the default, :1113 the fold into the bucket's
  // own `reset`) and refuses a call made before that instant locally (:975, `localLimited`), never
  // reaching the wire, because this broker's client is built with `rejectOnRateLimit: () => true`
  // (broker/discord/rest.ts:70). A wait that lands exactly on the bucket's own reported reset, with
  // no margin, still wakes inside discord.js's wider window. The fake below refuses a call made
  // before that same window closes, the way discord.js's own client would.
  const { now, advance } = clock();
  let localResetAt = 0;
  const calls: Call[] = [];
  const answer = async (call: Call): Promise<CallOutcome<null>> => {
    if (now() < localResetAt) throw new Error("discord.js refused this call locally: still paced");
    calls.push(call);
    // discord.js's own offset, folded into the client's internal reset atop the reported one.
    localResetAt = now() + 250 + 50;
    return ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null });
  };
  const reactions: MessageReactions = {
    addReaction: async (input) => answer({ kind: "add", ...input }),
    removeReaction: async (input) => answer({ kind: "remove", ...input }),
  };
  const log: string[] = [];
  const sleep = async (ms: number): Promise<void> => {
    advance(ms);
  };
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.pickedUp("thread-1", now());
  await settle();

  assert.deepEqual(
    currentEmoji(calls, "msg-1"),
    new Set([STAGE_EMOJI.pickedUp]),
    "both the add and the remove must clear discord.js's own local window, not just the budget's",
  );
  assert.deepEqual(log, [], "a margin that clears discord.js's window means nothing here is refused");
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

test("a drained queue's next write still waits out the prior block, not a fresh budget", async () => {
  // A thread's queue drains once nothing is chained behind its last task, but Discord's own bucket
  // for that channel does not reset just because this tracker stopped watching it: the idle-session
  // pickup that follows a delivered message by a couple hundred milliseconds is exactly this shape,
  // and a fresh budget on that next write would try it immediately instead of pacing against a
  // bucket discord.js still reports exhausted.
  const { calls, reactions } = reactionsWith(() => ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null }));
  const { now, advance } = clock();
  const log: string[] = [];
  const { waits, sleep } = fastSleep();
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  await settle(); // the queue fully drains: nothing is chained behind the delivered write

  advance(200); // short of the reported 250ms reset: the bucket is still exhausted
  tracker.pickedUp("thread-1", now());
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.pickedUp]));
  assert.deepEqual(log, []);
  // The picked-up transition always paces its own remove behind its add, so one wait is not proof
  // by itself; a fresh budget would still show exactly that one wait, from the remove alone, while
  // the add landed immediately on an unblocked budget. Two waits is what only a budget that
  // survived the drain produces: the add itself had to pace too, against the block the delivered
  // write left standing.
  assert.equal(waits.length, 2, "both the add and the remove had to pace against the surviving block");
  assert.ok(waits.every((ms) => ms > 0));
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
  tracker.answered("thread-1", now());
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

test("a failed 👀 add followed by answered ends with ✅ alone, never 📨 beside it", async () => {
  // Before this fix, the remove that follows an add was always the prior stage's own emoji: here,
  // 📨. The pickedUp add fails here, so 📨 never leaves and the entry's in-memory stage still
  // advances to "pickedUp" regardless (a message's turn state must not wait on a reaction landing).
  // answered() then sees stage "pickedUp" and would remove 👀, a reaction that was never actually
  // painted, leaving 📨 standing beside a freshly added ✅ forever. The fix removes whatever the
  // entry's own record says is painted, which is still 📨 here, not the emoji the stage machine
  // assumed.
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
  tracker.answered("thread-1", now());
  await settle();

  assert.deepEqual(
    calls.map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.pickedUp],
      ["add", STAGE_EMOJI.answered],
      ["remove", STAGE_EMOJI.delivered],
    ],
    "the answered transition must remove 📨, what is actually painted, never 👀, which never landed",
  );
});

test("a pickup instant at or before the thread's last answer goes straight to answered, never parking at 👀", async () => {
  // The tailer polls a live transcript every `interimPollMs` (20s by default), so a mid-turn
  // injected message's own queued-command line can be read well after the turn that already
  // answered it. `pickedUp` is told that line's own instant; when it is at or before the thread's
  // last `answered` call, nothing will ever call `answered` for this message again, so it must
  // finish the job itself rather than parking at 👀 forever. The control is the ordinary order: a
  // pickup that arrives before the answer still moves through 👀 exactly as it always has.
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  const ordinaryAt = now();
  tracker.delivered("thread-1", "msg-ordinary", ordinaryAt);
  await settle();
  tracker.pickedUp("thread-1", ordinaryAt);
  await settle();

  advance(1_000);
  const staleAt = now();
  tracker.delivered("thread-1", "msg-stale", staleAt);
  await settle();

  advance(1_000);
  tracker.answered("thread-1", now()); // answers msg-ordinary; msg-stale is still at 📨, untouched
  await settle();

  advance(1_000);
  // The queued line's own instant sits before the answer just posted: a stale pickup signal.
  tracker.pickedUp("thread-1", staleAt);
  await settle();

  assert.deepEqual(
    calls.filter((call) => call.messageId === "msg-ordinary").map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.pickedUp],
      ["remove", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.answered],
      ["remove", STAGE_EMOJI.pickedUp],
    ],
    "the ordinary order still moves through 👀 exactly as it always has",
  );
  assert.deepEqual(
    calls.filter((call) => call.messageId === "msg-stale").map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.answered],
      ["remove", STAGE_EMOJI.delivered],
    ],
    "a stale pickup instant goes straight to answered, never through 👀",
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

test("a reply that lands after the next turn opened answers only what the turn that produced it picked up", async () => {
  // The signals the tracker infers turns from run on different clocks: a pickup is the turn's own
  // open, and an answer is the reply's arrival at the broker, read before its Discord post is
  // awaited. The Stop mirror answers its hook before delivery, so turn N's final reply can land
  // on the wire after turn N+1 has already opened and credited pickup for the message it carries.
  // That late landing must not mark N+1's message answered: `answered` is told the reply's own
  // arrival instant and moves only the messages picked up at or before it.
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.pickedUp("thread-1", now()); // turn N opens with msg-1
  await settle();

  advance(1_000);
  tracker.delivered("thread-1", "msg-2", now()); // arrives as turn N ends
  advance(1_000);
  const replyArrivedAt = now(); // turn N's reply reaches the broker, its post not yet landed
  advance(1_000);
  tracker.pickedUp("thread-1", now()); // turn N+1 opens with msg-2
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.pickedUp]));

  advance(1_000);
  tracker.answered("thread-1", replyArrivedAt); // turn N's post lands, late
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.answered]));
  assert.deepEqual(
    currentEmoji(calls, "msg-2"),
    new Set([STAGE_EMOJI.pickedUp]),
    "turn N's reply arrived before turn N+1 picked msg-2 up, so it cannot be the answer to msg-2",
  );

  advance(1_000);
  tracker.answered("thread-1", now()); // turn N+1's own reply
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.answered]));
});

test("the control: the same two turns with turn N's reply landing before turn N+1 opens", async () => {
  // The other ordering of the same signals: turn N's reply lands promptly, then turn N+1 opens.
  // msg-2 moves through 👀 and is answered by N+1's reply alone, exactly as in the late case.
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.pickedUp("thread-1", now());
  await settle();

  advance(1_000);
  tracker.delivered("thread-1", "msg-2", now());
  advance(1_000);
  tracker.answered("thread-1", now()); // turn N's reply arrives and lands at once
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.answered]));
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.delivered]));

  advance(1_000);
  tracker.pickedUp("thread-1", now()); // turn N+1 opens with msg-2
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.pickedUp]));

  advance(1_000);
  tracker.answered("thread-1", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.answered]));
});

test("a late-landing reply does not send a message injected after its arrival straight to answered", async () => {
  // The thread's last-answered instant is the reply's arrival, never the instant its post landed.
  // A message injected mid-turn after that arrival, whose queued line the tailer reads only after
  // the late post landed, belongs to the next turn: it moves to 👀 and waits for that turn's reply.
  const { calls, reactions } = reactionsWith();
  const { now, advance } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  tracker.pickedUp("thread-1", now()); // turn N
  await settle();

  advance(1_000);
  const replyArrivedAt = now(); // turn N's reply reaches the broker
  advance(1_000);
  const injectedAt = now();
  tracker.delivered("thread-1", "msg-3", injectedAt); // injected into turn N+1
  advance(1_000);
  tracker.answered("thread-1", replyArrivedAt); // turn N's post lands only now
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.answered]));

  tracker.pickedUp("thread-1", injectedAt); // the tailer reads msg-3's queued line
  await settle();
  assert.deepEqual(
    currentEmoji(calls, "msg-3"),
    new Set([STAGE_EMOJI.pickedUp]),
    "msg-3 was injected after turn N's reply arrived, so that reply cannot have answered it",
  );

  advance(1_000);
  tracker.answered("thread-1", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-3"), new Set([STAGE_EMOJI.answered]));
});

test("the thread's last-answered instant never moves backwards when an earlier reply lands later", async () => {
  // Two replies' posts can land in the opposite order to their arrivals. The later arrival is the
  // one a stale pickup is measured against: a pickup instant between the two must still read as
  // already answered once the later reply has been recorded, whichever post landed last.
  const { calls, reactions } = reactionsWith();
  const { now } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", 4_000);
  await settle();
  tracker.answered("thread-1", 5_000); // the later arrival lands first
  tracker.answered("thread-1", 4_500); // the earlier arrival lands last
  tracker.pickedUp("thread-1", 4_800); // injected before the 5_000 reply, read late
  await settle();

  assert.deepEqual(
    currentEmoji(calls, "msg-1"),
    new Set([STAGE_EMOJI.answered]),
    "the 5_000 reply already answered msg-1, whatever landed after it",
  );
});

test("a write arriving inside the margin past the bucket's reset still waits out discord.js's own window", async () => {
  // The margin is owed on every write that falls inside discord.js's offset window, not only on
  // one that arrives before the bucket's own reset. A write 20ms past the reported reset is still
  // 30ms inside the client's local window, and is refused there unless it waits the rest out.
  const { now, advance } = clock();
  let localResetAt = 0;
  const calls: Call[] = [];
  const answer = async (call: Call): Promise<CallOutcome<null>> => {
    if (now() < localResetAt) throw new Error("discord.js refused this call locally: still paced");
    calls.push(call);
    localResetAt = now() + 250 + 50;
    return ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null });
  };
  const reactions: MessageReactions = {
    addReaction: async (input) => answer({ kind: "add", ...input }),
    removeReaction: async (input) => answer({ kind: "remove", ...input }),
  };
  const log: string[] = [];
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
    advance(ms);
  };
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  advance(250 + 20); // past the bucket's own reset, inside discord.js's offset window
  tracker.pickedUp("thread-1", now());
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set([STAGE_EMOJI.pickedUp]));
  assert.deepEqual(log, [], "nothing is refused once the write clears the client's window");
  assert.equal(waits[0], PACE_MARGIN_MS - 20, "the write waited exactly the rest of the margin");
});

test("a leftover emoji whose remove failed is removed by the next transition that lands", async () => {
  // Each transition removes every emoji believed painted other than the new stage, and an emoji
  // leaves that set only when its own remove lands. A 📨 whose remove was refused during the 👀
  // transition is still believed painted, so the ✅ transition removes it alongside 👀 rather than
  // leaving it on the message forever.
  const landed: Call[] = [];
  let refusedOnce = false;
  const { calls, reactions } = reactionsWith((call) => {
    if (call.kind === "remove" && call.emoji === STAGE_EMOJI.delivered && !refusedOnce) {
      refusedOnce = true;
      return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
    }
    landed.push(call);
    return ok();
  });
  const { now } = clock();
  const tracker = createReceiptTracker({ reactions, log: () => {}, now });

  tracker.delivered("thread-1", "msg-1", now());
  await settle();
  tracker.pickedUp("thread-1", now());
  await settle();
  assert.deepEqual(
    currentEmoji(landed, "msg-1"),
    new Set([STAGE_EMOJI.delivered, STAGE_EMOJI.pickedUp]),
    "the refused remove left 📨 standing beside 👀",
  );

  tracker.answered("thread-1", now());
  await settle();
  assert.deepEqual(
    currentEmoji(landed, "msg-1"),
    new Set([STAGE_EMOJI.answered]),
    "the answered transition cleared both leftovers, not only the stage it expected",
  );
  assert.deepEqual(
    calls.slice(0, 4).map((call) => [call.kind, call.emoji]),
    [
      ["add", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.pickedUp],
      ["remove", STAGE_EMOJI.delivered],
      ["add", STAGE_EMOJI.answered],
    ],
  );
});

test("a throw while a refusal is being reported still leaves the queue running for the next write", async () => {
  // The queue's own catch reports the refusal through `options.log` and `options.now`, either of
  // which can throw in turn. A second throw there has nothing behind it to catch it: it would
  // reject the chain itself, surface as an unhandled rejection, and leave every later write for the
  // thread chained behind a rejected promise. Here the clock throws on the write and again on the
  // report, and the next message's write must still run.
  const { calls, reactions } = reactionsWith();
  let calledNow = 0;
  const throwyNow = (): number => {
    calledNow += 1;
    if (calledNow <= 2) throw new Error("clock exploded");
    return 1_000;
  };
  const tracker = createReceiptTracker({ reactions, log: () => {}, now: throwyNow });

  tracker.delivered("thread-1", "msg-1", 1_000);
  tracker.delivered("thread-1", "msg-2", 1_000);
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-1"), new Set(), "the write that hit the throw never called out");
  assert.deepEqual(
    currentEmoji(calls, "msg-2"),
    new Set([STAGE_EMOJI.delivered]),
    "the next message's write still ran, though reporting the first one's refusal threw too",
  );
});

test("forget keeps a thread's budget while its queue is still running, and drops it once that queue drains", async () => {
  // A chain still in flight when the thread is forgotten holds the budget it was enqueued with. A
  // write under the same thread id arriving before that chain drains must pace against the block
  // the in-flight call is about to record, not start on a fresh budget the old chain never sees.
  // Once the queue drains with the thread still forgotten, the budget goes with it, so a thread
  // nobody tracks anymore holds no budget.
  const { now } = clock();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Call[] = [];
  const reactions: MessageReactions = {
    addReaction: async (input) => {
      calls.push({ kind: "add", ...input });
      if (calls.length === 1) await held;
      return ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null });
    },
    removeReaction: async (input) => {
      calls.push({ kind: "remove", ...input });
      return ok({ remaining: 0, resetAfterMs: 250, retryAfterMs: null });
    },
  };
  const log: string[] = [];
  const { waits, sleep } = fastSleep();
  const tracker = createReceiptTracker({ reactions, log: (message) => log.push(message), now, sleep });

  tracker.delivered("thread-1", "msg-1", now());
  await settle(); // msg-1's add is in flight, held
  assert.equal(calls.length, 1);
  tracker.forget("thread-1");
  tracker.delivered("thread-1", "msg-2", now()); // the same id, back in use before the chain drained
  release();
  await settle();

  assert.deepEqual(currentEmoji(calls, "msg-2"), new Set([STAGE_EMOJI.delivered]));
  assert.deepEqual(waits, [250 + PACE_MARGIN_MS], "msg-2 paced against the block msg-1's call recorded");
  assert.deepEqual(log, []);

  // The thread forgotten again with nothing in flight behind the drain: the next write starts fresh.
  tracker.forget("thread-1");
  await settle();
  tracker.delivered("thread-1", "msg-3", now());
  await settle();
  assert.deepEqual(currentEmoji(calls, "msg-3"), new Set([STAGE_EMOJI.delivered]));
  assert.deepEqual(waits, [250 + PACE_MARGIN_MS], "a forgotten thread's drained queue took its budget with it");
});
