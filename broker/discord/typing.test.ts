import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MAX_THREAD_REFUSALS, TYPING_PERIOD_MS, createTypingKeeper } from "./typing.ts";
import type { TypingThread } from "./typing.ts";
import type { CallOutcome, RateLimitObservation, ThreadTyping } from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

/** Flushes the whole chain an async `fire()` runs through, not just one microtask of it. */
function flush(): Promise<void> {
  return setImmediate();
}

const START = 1_000_000;
const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

/** A deadline no test here reaches, for the tests whose subject is not the deadline. */
const FAR = START + 60 * 60 * 1000;

/** The typing set for `ids`, every thread holding the far deadline. */
function threads(...ids: string[]): TypingThread[] {
  return ids.map((threadId) => ({ threadId, until: FAR }));
}

function ok(): CallOutcome<null> {
  return { status: "ok", value: null, rate: HEALTHY };
}

function clock() {
  let value = START;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

/** The fake scheduler board/thread.test.ts's own card tests drive: records every requested timer,
 * and fires one only when a test calls its stored callback by hand. */
function fakeTimer() {
  const timers: { id: number; ms: number; callback: () => void }[] = [];
  const cleared: number[] = [];
  return {
    timers,
    cleared,
    setTimer: (callback: () => void, ms: number): NodeJS.Timeout => {
      const id = timers.length + 1;
      timers.push({ id, ms, callback });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer: NodeJS.Timeout): void => {
      cleared.push(timer as unknown as number);
    },
  };
}

type Typing = {
  typing: ThreadTyping;
  calls: string[];
  /** Scripted result for the next call; anything unscripted succeeds. */
  next: CallOutcome<null> | null;
  nextThrow: unknown;
};

function typingWith(): Typing {
  const state: Typing = {
    calls: [],
    next: null,
    nextThrow: undefined,
    typing: {
      sendTyping: async ({ threadId }) => {
        state.calls.push(threadId);
        if (state.nextThrow !== undefined) {
          const thrown = state.nextThrow;
          state.nextThrow = undefined;
          throw thrown;
        }
        const scripted = state.next;
        state.next = null;
        return scripted ?? ok();
      },
    },
  };
  return state;
}

test("a thread newly working gets one call at once, then one every TYPING_PERIOD_MS", async () => {
  // A working thread is typed on at once and then once per period, on a fake clock. The period is
  // read off the exported constant rather than a literal, so a change to it moves this test's
  // expectation along with the real schedule.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call fires at once, not on the first tick");
  assert.equal(timer.timers.length, 1, "one timer for the one working thread");
  assert.equal(timer.timers[0]?.ms, TYPING_PERIOD_MS);

  timer.timers[0]?.callback();
  await flush();
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-1", "thread-1"], "one call per tick, three ticks in");
});

test("reconciling the same working set again starts no second timer", async () => {
  // One timer per thread, never two: a surface pass that reconciles on every tick with no state
  // change must not pile up timers for a thread that was already working.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  keeper.reconcile(threads("thread-1"));
  keeper.reconcile(threads("thread-1"));
  await flush();

  assert.equal(timer.timers.length, 1, "still one timer for the one thread");
});

test("a thread leaving the working set has its timer cleared at once", async () => {
  // Pins: "cleared on state change ... so no timer outlives its session."
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  const handle = timer.timers[0]?.id;

  keeper.reconcile(threads());

  assert.deepEqual(timer.cleared, [handle], "the one timer this thread held is cleared");

  // Pins: "none after a state change," not just a cleared handle. The old timer's own stored
  // callback, called by hand the way a straggling real timer firing between `clearInterval` and
  // the event loop's next turn would, must find nothing left to call through.
  const callsBeforeClearedCallback = [...typing.calls];
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(
    typing.calls,
    callsBeforeClearedCallback,
    "the cleared thread's stored callback sends no further call",
  );
});

test("stop() clears every kept timer and latches against a later reconcile", async () => {
  // Broker shutdown clears every thread still kept, so no timer outlives the broker. A surface pass
  // already in flight when stop() runs still resolves and still calls reconcile, and the latch is
  // what keeps that call from restarting what stop() just cleared.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  assert.equal(timer.timers.length, 2);

  keeper.stop();

  assert.equal(timer.cleared.length, 2, "both threads' timers are cleared");

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  assert.equal(timer.timers.length, 2, "stop() latches the keeper: no later reconcile starts a new timer");
  assert.deepEqual(typing.calls, ["thread-1", "thread-2"], "and no later reconcile sends a new call either");
});

test("reconcile after stop() starts no timer and sends no call", async () => {
  // The simpler half of the same latch, with nothing ever kept: a stop() that lands before the
  // first reconcile must still hold.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.stop();
  keeper.reconcile(threads("thread-1"));
  await flush();

  assert.equal(timer.timers.length, 0, "no timer is started once the keeper is stopped");
  assert.deepEqual(typing.calls, [], "no call is sent once the keeper is stopped");
});

test("a fatal typing outcome halts the keeper and reports through onFatal", async () => {
  // discord.js discards the token after a 401, so this keeper, driven by its own timers rather than
  // by the surface pass, is as likely as the surface to be the first caller to notice. It must say
  // so and stop every timer, not just the thread that saw the 401.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const fatal: string[] = [];
  typing.next = { status: "failed", error: "401 unauthorized", rate: NO_RATE_INFO, fatal: true };
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onFatal: (message) => fatal.push(message),
  });

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();

  assert.equal(fatal.length, 1, fatal.join(" / "));
  assert.match(fatal[0] ?? "", /token was rejected/);
  assert.equal(timer.cleared.length, 2, "every kept timer is cleared, not just the one that saw the 401");

  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.equal(timer.timers.length, 2, "the latch stops reconcile from starting a new timer after a fatal outcome");
});

test("two threads hitting a fatal outcome in the same pass report onFatal once", async () => {
  // `halt()` is idempotent, and a second thread's fire() resuming after the first already halted
  // must not report a second time either, the same way the surface's own fatal handling reports a
  // rejected token once, not once per call a pass happened to have in flight against it.
  const time = clock();
  const timer = fakeTimer();
  const calls: string[] = [];
  const typing: ThreadTyping = {
    sendTyping: async ({ threadId }) => {
      calls.push(threadId);
      return { status: "failed", error: "401 unauthorized", rate: NO_RATE_INFO, fatal: true };
    },
  };
  const fatal: string[] = [];
  const keeper = createTypingKeeper({
    typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onFatal: (message) => fatal.push(message),
  });

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();

  assert.deepEqual(calls.sort(), ["thread-1", "thread-2"], "both threads' immediate calls land");
  assert.equal(fatal.length, 1, fatal.join(" / "));
});

test("a thread refused permanently is dropped after a small cap, and only that thread", async () => {
  // A session whose thread Discord keeps refusing is not retried forever, and a thread kept beside
  // it is unaffected.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const log: string[] = [];
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: (message) => log.push(message),
  });

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();

  for (let i = 0; i < MAX_THREAD_REFUSALS; i += 1) {
    typing.next = { status: "failed", error: "403 forbidden", rate: NO_RATE_INFO, permanent: true };
    timer.timers[0]?.callback();
    await flush();
  }
  typing.next = null;

  assert.equal(timer.cleared.length, 1, "only the refused thread's timer is cleared");
  assert.match(
    log[log.length - 1] ?? "",
    /refused \d+ times in a row/,
    "the drop is logged once the cap is reached",
  );

  // The thread stays dropped while it is still in the working set: a later reconcile with the
  // same set must not restart a timer the cap just took away.
  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  assert.equal(timer.timers.length, 2, "the dropped thread gets no new timer while still working");
  assert.ok(typing.calls.includes("thread-2"), "the healthy thread beside it keeps being called throughout");

  // Leaving and re-entering the working set is what lets the dropped thread restart.
  keeper.reconcile(threads("thread-2"));
  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  assert.equal(timer.timers.length, 3, "the thread restarts once it has left and rejoined the set");
});

test("a thread's standing rate-limit block survives leaving and rejoining the working set", async () => {
  // A thread's Budget persists across clear/start, so a session that flaps out of and back into
  // working inside a 429's own window stays blocked rather than getting a fresh budget that reads
  // as affordable at once.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  typing.next = { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 60_000 } };
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call lands and reports the 429's block");

  keeper.reconcile(threads());
  keeper.reconcile(threads("thread-1"));
  await flush();

  assert.deepEqual(
    typing.calls,
    ["thread-1"],
    "the rejoining thread's immediate call is skipped: its budget is still blocked from before",
  );
});

for (const failure of [
  {
    name: "a failed outcome",
    script: (typing: Typing): void => {
      typing.next = { status: "failed", error: "HTTP 400", rate: NO_RATE_INFO };
    },
    afterFirst: (): void => {},
  },
  {
    name: "a rate-limited outcome",
    script: (typing: Typing): void => {
      typing.next = { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 2_000 } };
    },
    // A 429's own reported wait blocks the thread's budget, which is the separate skip path the
    // budget test below pins; past that wait, the timer that kept running makes the call again.
    afterFirst: (time: ReturnType<typeof clock>): void => {
      time.advance(2_000);
    },
  },
  {
    name: "a thrown error",
    script: (typing: Typing): void => {
      typing.nextThrow = new Error("socket reset");
    },
    afterFirst: (): void => {},
  },
]) {
  test(`${failure.name} is logged and dropped, and never stops the timer`, async () => {
    // A failed call does not throw and does not stop the timer. The timer firing a second time,
    // successfully, after a scripted failure is what proves the loop survived it.
    const time = clock();
    const timer = fakeTimer();
    const typing = typingWith();
    const log: string[] = [];
    const keeper = createTypingKeeper({
      typing: typing.typing,
      now: time.now,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (message) => log.push(message),
    });
    failure.script(typing);

    assert.doesNotThrow(() => {
      keeper.reconcile(threads("thread-1"));
    });
    await flush();

    assert.equal(log.length, 1, "one refusal line for the one call that has failed so far");
    assert.match(log[0] ?? "", /^discord typing: a typing call (failed|was skipped)/);
    assert.deepEqual(timer.cleared, [], "the refusal does not clear the thread's timer");

    failure.afterFirst(time);
    timer.timers[0]?.callback();
    await flush();
    assert.deepEqual(typing.calls, ["thread-1", "thread-1"], "the next tick still calls, unaffected");
  });
}

test("a call the thread's own budget cannot afford is skipped and logged, not sent", async () => {
  // Pins: "An unaffordable call is skipped (the next tick is 8 s away) and counted into the refusal
  // log." A 429 on the first call blocks the budget past the next tick, which this proves by seeing
  // no second call reach the transport while the clock has not moved.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const log: string[] = [];
  typing.next = { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 60_000 } };
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: (message) => log.push(message),
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call lands, and reports the block");

  timer.timers[0]?.callback();
  await flush();

  assert.deepEqual(typing.calls, ["thread-1"], "the still-blocked budget skips the second call");
  assert.equal(
    log.length,
    1,
    "the second refusal falls inside the same key's window as the first and is counted, not logged again",
  );
});

test("release clears a thread's timer at once, and no call follows it", async () => {
  // After a Stop, no typing call is sent for that thread: a credited Stop releases the thread
  // before any refresh runs, and the released timer's own stored callback, fired late the way a
  // real interval can between `clearInterval` and the next turn, sends nothing.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  keeper.release("thread-1");
  assert.deepEqual(timer.cleared, [timer.timers[0]?.id], "only the released thread's timer is cleared");

  time.advance(TYPING_PERIOD_MS);
  timer.timers[0]?.callback();
  timer.timers[1]?.callback();
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-2", "thread-2"], "the released thread is sent nothing more");

  // Not latched: a new turn reaching the next reconcile starts the thread again.
  keeper.reconcile(threads("thread-1", "thread-2"));
  await flush();
  assert.equal(timer.timers.length, 3, "a released thread restarts when its session opens a new turn");
});

/** A transport whose calls stay pending until the test resolves them, in order. */
function pendingTyping() {
  const calls: string[] = [];
  const waiting: ((outcome: CallOutcome<null>) => void)[] = [];
  const typing: ThreadTyping = {
    sendTyping: ({ threadId }) => {
      calls.push(threadId);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
  return { typing, calls, settle: (outcome: CallOutcome<null>) => waiting.shift()?.(outcome) };
}

test("a tick while the thread's previous call is still in flight sends nothing", async () => {
  const time = clock();
  const timer = fakeTimer();
  const pending = pendingTyping();
  const keeper = createTypingKeeper({
    typing: pending.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(pending.calls, ["thread-1"], "the second tick finds the first call unanswered and skips");

  pending.settle(ok());
  await flush();
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(pending.calls, ["thread-1", "thread-1"], "once answered, the next tick calls again");
});

test("a refusal answered after its thread restarted never drops the new entry", async () => {
  // An entry one refusal short of the cap makes a call, is released, and its thread restarts as a
  // new entry before that call comes back permanent. The late refusal belongs to the old entry, so
  // it must not drop the thread out from under the new one.
  const time = clock();
  const timer = fakeTimer();
  const pending = pendingTyping();
  const log: string[] = [];
  const keeper = createTypingKeeper({
    typing: pending.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: (message) => log.push(message),
  });
  const forbidden: CallOutcome<null> = { status: "failed", error: "403 forbidden", rate: NO_RATE_INFO, permanent: true };

  keeper.reconcile(threads("thread-1"));
  await flush();
  for (let i = 1; i < MAX_THREAD_REFUSALS; i += 1) {
    pending.settle(forbidden);
    await flush();
    timer.timers[0]?.callback();
    await flush();
  }
  // The old entry now holds a cap-minus-one run and one call in flight.
  keeper.release("thread-1");
  keeper.reconcile(threads("thread-1"));
  await flush();
  const restarted = timer.timers[1]?.id;
  assert.ok(restarted !== undefined, "the thread restarted as a new entry");

  pending.settle(forbidden);
  await flush();

  assert.ok(!timer.cleared.includes(restarted), "the new entry's timer is not cleared by the old entry's refusal");
  assert.ok(!log.some((line) => /refused \d+ times in a row/.test(line)), log.join(" / "));
});

test("an accepted call resets the thread's run of refusals, so the cap counts consecutive ones", async () => {
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const log: string[] = [];
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: (message) => log.push(message),
  });

  typing.next = { status: "failed", error: "403 forbidden", rate: NO_RATE_INFO, permanent: true };
  keeper.reconcile(threads("thread-1"));
  await flush();
  // Refusals separated by an accepted call, up to the cap's worth in total but never consecutive.
  for (let i = 1; i < MAX_THREAD_REFUSALS * 2; i += 1) {
    if (i % 2 === 0) typing.next = { status: "failed", error: "403 forbidden", rate: NO_RATE_INFO, permanent: true };
    timer.timers[0]?.callback();
    await flush();
  }

  assert.deepEqual(timer.cleared, [], "interleaved refusals never reach the cap");
  assert.ok(!log.some((line) => /refused \d+ times in a row/.test(line)), log.join(" / "));
});

test("forget clears a retired thread's timer and its budget", async () => {
  // A retired thread's standing 429 block is forgotten with it: the same id coming back later gets
  // a fresh bucket rather than one still blocked, which shows the budget map no longer holds it.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  typing.next = { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 60_000 } };
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  keeper.forget("thread-1");
  assert.deepEqual(timer.cleared, [timer.timers[0]?.id], "the timer is cleared");

  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-1"], "a fresh budget affords the call at once");
});

test("a tick due past the thread's deadline sends nothing, with no reconcile in between", async () => {
  // A turn gone quiet for `idleAfterMs` stops typing at its deadline, not
  // at the next reconcile, which can be a whole refresh interval later. A later reconcile handing in
  // a fresh deadline extends it.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile([{ threadId: "thread-1", until: START + TYPING_PERIOD_MS }]);
  await flush();
  time.advance(TYPING_PERIOD_MS);
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-1"], "a tick at exactly the deadline still sends");

  time.advance(1);
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-1"], "a tick past the deadline sends nothing");
  assert.deepEqual(timer.cleared, [], "and no reconcile has run to clear the timer");

  keeper.reconcile([{ threadId: "thread-1", until: time.now() + TYPING_PERIOD_MS }]);
  timer.timers[0]?.callback();
  await flush();
  assert.deepEqual(typing.calls, ["thread-1", "thread-1", "thread-1"], "a fresh deadline resumes the same timer");
  assert.equal(timer.timers.length, 1, "on the one timer the thread already held");
});

test("a thread released and restarted while its call is in flight sends nothing on top of it", async () => {
  // In-flight is a fact about the thread, not the entry: the restarted entry's immediate call must
  // wait out the old entry's call still awaiting Discord.
  const time = clock();
  const timer = fakeTimer();
  const pending = pendingTyping();
  const keeper = createTypingKeeper({
    typing: pending.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(threads("thread-1"));
  await flush();
  keeper.release("thread-1");
  keeper.reconcile(threads("thread-1"));
  await flush();
  assert.equal(timer.timers.length, 2, "the thread restarted as a new entry");
  assert.deepEqual(pending.calls, ["thread-1"], "the restart's immediate call is held off by the call in flight");

  pending.settle(ok());
  await flush();
  timer.timers[1]?.callback();
  await flush();
  assert.deepEqual(pending.calls, ["thread-1", "thread-1"], "once answered, the new entry's tick calls");
});
