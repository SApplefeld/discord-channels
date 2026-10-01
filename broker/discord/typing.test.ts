import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPING_PERIOD_MS, createTypingKeeper } from "./typing.ts";
import type { CallOutcome, RateLimitObservation, ThreadTyping } from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

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
  await Promise.resolve();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call fires at once, not on the first tick");
  assert.equal(timer.timers.length, 1, "one timer for the one working thread");
  assert.equal(timer.timers[0]?.ms, TYPING_PERIOD_MS);

  timer.timers[0]?.callback();
  await Promise.resolve();
  timer.timers[0]?.callback();
  await Promise.resolve();
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
  await Promise.resolve();

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
  await Promise.resolve();
  const handle = timer.timers[0]?.id;

  keeper.reconcile([]);

  assert.deepEqual(timer.cleared, [handle], "the one timer this thread held is cleared");
});

test("stop() clears every kept timer", async () => {
  // Pins the broker-shutdown half of the same acceptance line: "cleared ... on session end," which
  // for the keeper as a whole is every thread still kept when the broker goes down.
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
  await Promise.resolve();
  assert.equal(timer.timers.length, 2);

  keeper.stop();

  assert.equal(timer.cleared.length, 2, "both threads' timers are cleared");
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
    // budget test above pins; past that wait, the timer that kept running makes the call again.
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
    await Promise.resolve();

    assert.equal(log.length, 1, "exactly one refusal line, not one per call");
    assert.match(log[0] ?? "", /^discord typing: a typing call (failed|was skipped)/);
    assert.deepEqual(timer.cleared, [], "the refusal does not clear the thread's timer");

    failure.afterFirst(time);
    timer.timers[0]?.callback();
    await Promise.resolve();
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
  await Promise.resolve();
  assert.deepEqual(typing.calls, ["thread-1"], "the first call lands, and reports the block");

  timer.timers[0]?.callback();
  await Promise.resolve();

  assert.deepEqual(typing.calls, ["thread-1"], "the still-blocked budget skips the second call");
  assert.equal(
    log.length,
    1,
    "the second refusal falls inside the same key's window as the first and is counted, not logged again",
  );
});
