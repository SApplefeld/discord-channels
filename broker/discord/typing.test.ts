import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MAX_THREAD_REFUSALS, TYPING_PERIOD_MS, createTypingKeeper } from "./typing.ts";
import type { CallOutcome, RateLimitObservation, ThreadTyping } from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

/** Flushes the whole chain an async `fire()` runs through, not just one microtask of it. */
function flush(): Promise<void> {
  return setImmediate();
}

const START = 1_000_000;
const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

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
  // Pins the spec's acceptance: "a unit test with a fake clock shows calls every 8 seconds while
  // `working`." The period is read off the exported constant rather than a literal, so a change to
  // it moves this test's expectation along with the real schedule.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(["thread-1"]);
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
  // "One timer per thread, never two," per the brief: a session surface pass that reconciles on
  // every tick with no state change must not pile up timers for a thread that was already working.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(["thread-1"]);
  keeper.reconcile(["thread-1"]);
  keeper.reconcile(["thread-1"]);
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

  keeper.reconcile(["thread-1"]);
  await flush();
  const handle = timer.timers[0]?.id;

  keeper.reconcile([]);

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
  // Pins the broker-shutdown half of the same acceptance line: "cleared ... on session end," which
  // for the keeper as a whole is every thread still kept when the broker goes down. Also pins the
  // critical fix: a surface pass already in flight when stop() runs still resolves and still calls
  // reconcile, and the latch is what keeps that call from restarting what stop() just cleared.
  const time = clock();
  const timer = fakeTimer();
  const typing = typingWith();
  const keeper = createTypingKeeper({
    typing: typing.typing,
    now: time.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  keeper.reconcile(["thread-1", "thread-2"]);
  await flush();
  assert.equal(timer.timers.length, 2);

  keeper.stop();

  assert.equal(timer.cleared.length, 2, "both threads' timers are cleared");

  keeper.reconcile(["thread-1", "thread-2"]);
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
  keeper.reconcile(["thread-1"]);
  await flush();

  assert.equal(timer.timers.length, 0, "no timer is started once the keeper is stopped");
  assert.deepEqual(typing.calls, [], "no call is sent once the keeper is stopped");
});

test("a fatal typing outcome halts the keeper and reports through onFatal", async () => {
  // Pins finding 2: discord.js discards the token after a 401, so this keeper, driven by its own
  // timers rather than by the surface pass, is as likely as the surface to be the first caller to
  // notice. It must say so and stop every timer, not just the thread that saw the 401.
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

  keeper.reconcile(["thread-1", "thread-2"]);
  await flush();

  assert.equal(fatal.length, 1, fatal.join(" / "));
  assert.match(fatal[0] ?? "", /token was rejected/);
  assert.equal(timer.cleared.length, 2, "every kept timer is cleared, not just the one that saw the 401");

  keeper.reconcile(["thread-1"]);
  await flush();
  assert.equal(timer.timers.length, 2, "the latch stops reconcile from starting a new timer after a fatal outcome");
});

test("two threads hitting a fatal outcome in the same pass report onFatal once", async () => {
  // Regression for the fix alongside finding 2: `halt()` is idempotent, but a second thread's fire()
  // resuming after the first already halted must not report a second time, the same way the
  // surface's own fatal handling reports a rejected token once, not once per call a pass happened
  // to have in flight against it.
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

  keeper.reconcile(["thread-1", "thread-2"]);
  await flush();

  assert.deepEqual(calls.sort(), ["thread-1", "thread-2"], "both threads' immediate calls land");
  assert.equal(fatal.length, 1, fatal.join(" / "));
});

test("a thread refused permanently is dropped after a small cap, and only that thread", async () => {
  // Pins finding 2's drop-after-cap behavior: a session whose thread Discord keeps refusing must
  // not be retried forever, and a thread kept beside it must be unaffected.
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

  keeper.reconcile(["thread-1", "thread-2"]);
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
  keeper.reconcile(["thread-1", "thread-2"]);
  await flush();
  assert.equal(timer.timers.length, 2, "the dropped thread gets no new timer while still working");
  assert.ok(typing.calls.includes("thread-2"), "the healthy thread beside it keeps being called throughout");

  // Leaving and re-entering the working set is what lets the dropped thread restart.
  keeper.reconcile(["thread-2"]);
  keeper.reconcile(["thread-1", "thread-2"]);
  await flush();
  assert.equal(timer.timers.length, 3, "the thread restarts once it has left and rejoined the set");
});

test("a thread's standing rate-limit block survives leaving and rejoining the working set", async () => {
  // Pins the minor fix at typing.ts: a thread's Budget persists across clear/start, so a session
  // that flaps out of and back into working inside a 429's own window stays blocked rather than
  // getting a fresh budget that reads as affordable at once.
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

  keeper.reconcile(["thread-1"]);
  await flush();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call lands and reports the 429's block");

  keeper.reconcile([]);
  keeper.reconcile(["thread-1"]);
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
    // Pins the spec's "a failed call does not throw and does not stop the timer." The timer firing a
    // second time, successfully, after a scripted failure is what proves the loop survived it.
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
      keeper.reconcile(["thread-1"]);
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

  keeper.reconcile(["thread-1"]);
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
