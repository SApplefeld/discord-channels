import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageCard, USAGE_THREAD_NAME } from "./thread.ts";
import type { UsageCardOptions } from "./thread.ts";
import { loadUsageBinding, saveUsageBinding } from "./binding.ts";
import type { UsageReading } from "./cache.ts";
import type { SessionView } from "../discord/state.ts";
import type { CallOutcome, DiscordTransport, RateLimitObservation } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";

const START = 1_000_000;
const MESSAGE_ID = "111111111111111111";
const THREAD_ID = "222222222222222222";
const THRESHOLDS = { idleAfterMs: 30_000, exitedAfterMs: 4 * 60 * 60 * 1000 };

// A clock the tests advance by hand. A budget block is a wait, and a test that waited out a real
// one would be a slow flake.
function clock(start = START) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

function ok<T>(value: T, rate: RateLimitObservation = HEALTHY): CallOutcome<T> {
  return { status: "ok", value, rate };
}

function refused(retryAfterMs: number): CallOutcome<never> {
  return { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs } };
}

/** A refusal Discord will repeat: a permission the bot does not hold, or a shape it will not take. */
function permanent(): CallOutcome<never> {
  return { status: "failed", error: "HTTP 403", rate: NO_RATE_INFO, permanent: true };
}

/** The message this card aims at is gone, which is what an operator deleting it looks like. */
function missing(): CallOutcome<never> {
  return { status: "failed", error: "HTTP 404", rate: NO_RATE_INFO, missing: true };
}

type Recorder = {
  transport: DiscordTransport;
  posts: string[];
  opens: { messageId: string; name: string }[];
  edits: { messageId: string; card: string }[];
  /** Scripted results for the next call of each kind. Anything unscripted succeeds. */
  nextPost: CallOutcome<{ messageId: string }> | null;
  nextOpen: CallOutcome<{ threadId: string }> | null;
  nextEdit: CallOutcome<null> | null;
};

function recorder(): Recorder {
  const state: Recorder = {
    posts: [],
    opens: [],
    edits: [],
    nextPost: null,
    nextOpen: null,
    nextEdit: null,
    transport: {
      postCard: async ({ card }) => {
        state.posts.push(card);
        const scripted = state.nextPost;
        state.nextPost = null;
        return scripted ?? ok({ messageId: MESSAGE_ID });
      },
      openThread: async ({ messageId, name }) => {
        state.opens.push({ messageId, name });
        const scripted = state.nextOpen;
        state.nextOpen = null;
        return scripted ?? ok({ threadId: THREAD_ID });
      },
      editCard: async ({ messageId, card }) => {
        state.edits.push({ messageId, card });
        const scripted = state.nextEdit;
        state.nextEdit = null;
        return scripted ?? ok(null);
      },
      renameThread: async () => ok(null),
      archiveThread: async () => ok(null),
    },
  };
  return state;
}

/** One account's reading, whose percentage is what a test varies to change the rendered card. */
function reading(pct: number): UsageReading {
  return {
    available: true,
    accounts: [
      {
        number: 1,
        email: "fleet@example.com",
        organizationName: null,
        active: true,
        fiveHour: { pct, resetsAt: START + 3 * 60 * 60 * 1000 },
        sevenDay: null,
        spend: null,
        scoped: [],
        fetchedAt: START,
        consecutiveFailures: 0,
        failing: false,
        backoffUntil: null,
      },
    ],
  };
}

const UNREADABLE: UsageReading = { available: false, reason: "unreadable" };

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "session-a",
    name: "neo-intake",
    host: "NEO",
    lastTool: "Bash",
    lastToolInput: null,
    model: null,
    openingModel: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    turnCount: 1,
    lastHookAt: START,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

function card(overrides: Partial<UsageCardOptions> = {}) {
  const calls = recorder();
  const time = clock();
  const logged: string[] = [];
  const built = createUsageCard({
    enabled: true,
    channel: { transport: calls.transport, thresholds: THRESHOLDS },
    sessions: () => [],
    interimMirror: true,
    cacheRoot: null,
    binding: () => null,
    refreshMs: 60_000,
    now: time.now,
    log: (message) => logged.push(message),
    read: () => reading(40),
    ...overrides,
  });
  assert.ok(built !== null, "the card was expected to be built under these options");
  return { calls, time, logged, usage: built };
}

test("the first tick posts the card and opens its thread on it, under a fixed name", async () => {
  const bindings: unknown[] = [];
  const { calls, usage } = card({ onBind: (binding) => bindings.push(binding) });

  await usage.tick();

  assert.equal(calls.posts.length, 1);
  assert.match(calls.posts[0] ?? "", /Fleet: Usage/);
  assert.deepEqual(calls.opens, [{ messageId: MESSAGE_ID, name: USAGE_THREAD_NAME }]);
  assert.equal(calls.edits.length, 0, "the card it just posted needs no edit");
  // The message first, then the thread on it: a crash between the two must not lose the card.
  assert.deepEqual(bindings, [
    { messageId: MESSAGE_ID, threadId: null },
    { messageId: MESSAGE_ID, threadId: THREAD_ID },
  ]);
});

test("a restart rebinds to the persisted thread instead of opening a second one", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-usage-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-card.json");

  const first = card({ onBind: (binding) => saveUsageBinding(file, binding) });
  await first.usage.tick();

  const restarted = card({
    binding: () => loadUsageBinding(file, { log: () => {} }),
    read: () => reading(55),
  });
  await restarted.usage.tick();

  assert.equal(restarted.calls.posts.length, 0, "the card must not be posted a second time");
  assert.equal(restarted.calls.opens.length, 0, "the thread must not be opened a second time");
  assert.equal(restarted.calls.edits.length, 1);
  assert.equal(restarted.calls.edits[0]?.messageId, MESSAGE_ID);
});

test("an unchanged reading spends no edit", async () => {
  const { calls, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => reading(40),
  });

  await usage.tick();
  await usage.tick();

  assert.equal(calls.posts.length, 0);
  assert.equal(
    calls.edits.length,
    1,
    "the first tick re-establishes the card and the second must cost nothing",
  );
});

test("a changed reading spends one edit", async () => {
  let pct = 40;
  const { calls, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => reading(pct),
  });

  await usage.tick();
  pct = 91;
  await usage.tick();

  assert.equal(calls.edits.length, 2);
  assert.match(calls.edits[1]?.card ?? "", /91%/);
});

test("a session that changed state spends an edit even when the usage numbers did not", async () => {
  let sessions: SessionView[] = [];
  const { calls, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    sessions: () => sessions,
  });

  await usage.tick();
  sessions = [view()];
  await usage.tick();

  assert.equal(calls.edits.length, 2);
  assert.match(calls.edits[1]?.card ?? "", /neo-intake/);
});

test("a refused edit is skipped rather than queued, and retried on the next tick", async () => {
  let pct = 40;
  const { calls, time, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => reading(pct),
  });
  await usage.tick();
  assert.equal(calls.edits.length, 1);

  pct = 77;
  calls.nextEdit = refused(30_000);
  await usage.tick();
  assert.equal(calls.edits.length, 2, "the refusal was one attempt, not a retry loop");

  // Still blocked: the budget holds the bucket closed for as long as Discord asked.
  await usage.tick();
  assert.equal(calls.edits.length, 2, "nothing is attempted while the bucket is empty");

  time.advance(30_001);
  await usage.tick();
  assert.equal(calls.edits.length, 3, "the next tick past the block writes the current card");
  assert.match(calls.edits[2]?.card ?? "", /77%/);
});

test("a failed read redraws the last good numbers under a marker rather than blanking them", async () => {
  // The numbers stand because they are the best answer available, and the card keeps being written
  // so their age climbs honestly and the session lines beside them stay live.
  let current: UsageReading = reading(40);
  const { calls, time, logged, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => current,
  });

  await usage.tick();
  assert.equal(calls.edits.length, 1);
  assert.match(calls.edits[0]?.card ?? "", /40%/);

  current = UNREADABLE;
  time.advance(60_000);
  await usage.tick();
  assert.equal(calls.edits.length, 2, "the outage is drawn, not suppressed");
  const held = calls.edits[1]?.card ?? "";
  assert.match(held, /40%/, "the last numbers that could be read are still on the card");
  assert.match(held, /last numbers it held/, "marked as held rather than as a live reading");
  assert.match(held, /card as of 1m ago/, "under an age that keeps climbing through the outage");

  time.advance(60_000);
  await usage.tick();
  assert.equal(calls.edits.length, 3, "and it keeps climbing on every pass");
  assert.match(calls.edits[2]?.card ?? "", /card as of 2m ago/);
  assert.equal(
    logged.filter((line) => line.includes("could not be read")).length,
    1,
    "the reason is logged once per window, not once per tick",
  );

  current = reading(41);
  time.advance(60_000);
  await usage.tick();
  assert.equal(calls.edits.length, 4, "the read is tried again on every tick");
  const back = calls.edits[3]?.card ?? "";
  assert.match(back, /41%/);
  assert.doesNotMatch(back, /last numbers it held/, "and the marker goes with the outage");
});

test("a suppressed repeat reports its window in minutes", async () => {
  const { logged, time, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => UNREADABLE,
  });

  await usage.tick();
  time.advance(60_000);
  await usage.tick();
  time.advance(5 * 60_000);
  await usage.tick();

  assert.ok(
    logged.some((line) => line.includes("occurred 1 more time(s) in the last 5 minutes")),
    "the window reads the way every line beside it does, not as a millisecond count",
  );
});

test("a failed read still posts the first card, so the thread exists to say why", async () => {
  const { calls, usage } = card({ read: () => UNREADABLE });

  await usage.tick();

  assert.equal(calls.posts.length, 1);
  assert.match(calls.posts[0] ?? "", /usage unavailable/);
  assert.equal(calls.opens.length, 1, "the thread is opened whatever the cache said");
});

test("a card that could not be posted is retried rather than left thread-less", async () => {
  const { calls, time, usage } = card();
  calls.nextPost = refused(10_000);

  await usage.tick();
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.opens.length, 0, "there is no message to open a thread on");

  await usage.tick();
  assert.equal(calls.posts.length, 1, "nothing is attempted while the bucket is empty");

  time.advance(10_001);
  await usage.tick();
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.opens.length, 1, "the thread is opened on the card that landed");
});

test("a card reported gone while its thread is opened is not then edited", async () => {
  // The pass is holding the identifier the open just invalidated: one more call against it buys a
  // second 404 and nothing else.
  const { calls, usage } = card({ binding: () => ({ messageId: MESSAGE_ID, threadId: null }) });
  calls.nextOpen = missing();

  await usage.tick();

  assert.equal(calls.opens.length, 1);
  assert.equal(calls.edits.length, 0);

  await usage.tick();
  assert.equal(calls.posts.length, 1, "the next tick builds a new card instead");
});

test("a message Discord reports as gone is rebuilt rather than called forever", async () => {
  const { calls, usage } = card({ binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }) });
  calls.nextEdit = missing();

  await usage.tick();
  assert.equal(calls.edits.length, 1);

  await usage.tick();
  assert.equal(calls.posts.length, 1, "the next tick builds a new card");
  assert.equal(calls.opens.length, 1);
});

test("a card that keeps going missing is rebuilt a bounded number of times", async () => {
  // Anything deleting the card on a cadence would otherwise get a post and a thread open back at
  // every refresh forever: a rebuild is not a refusal, so no refusal count ever sees one.
  let pct = 40;
  const { calls, logged, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => reading(pct),
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    calls.nextEdit = missing();
    pct += 1;
    await usage.tick();
  }

  assert.equal(calls.edits.length, 3, "the third disappearance is the last one answered");
  assert.equal(calls.posts.length, 2, "and only the first two bought a replacement card");
  assert.equal(calls.opens.length, 2);
  assert.ok(logged.some((line) => line.includes("went missing 3 times in a row")));
});

test("a card Discord keeps refusing permanently is given up on", async () => {
  const { calls, logged, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextEdit = permanent();
    await usage.tick();
  }

  assert.equal(calls.edits.length, 3, "three refusals in a row end the card's writes");
  assert.ok(logged.some((line) => line.includes("refused 3 times in a row")));
});

test("a route refused past the ceiling stops alone, and the rest of the card keeps working", async () => {
  // A bot without thread-create permission is refused on the open for as long as it runs, while
  // its edits land. One counter for all three routes takes the working ones down with it.
  let pct = 40;
  const { calls, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
    read: () => reading(pct),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextOpen = permanent();
    pct += 1;
    await usage.tick();
  }

  assert.equal(calls.opens.length, 3, "three refusals in a row end the thread open");
  assert.equal(calls.edits.length, 5, "and the card is still written on every pass");
});

test("refusals far enough apart never add up to a route being given up on", async () => {
  // A route that fails once an afternoon is not a standing block, and treating it as one abandons
  // a card that was working between the failures.
  let pct = 40;
  const { calls, time, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    read: () => reading(pct),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextEdit = permanent();
    pct += 1;
    await usage.tick();
    // Past the decay window, which is three refresh intervals wide.
    time.advance(3 * 60_000 + 1);
  }

  assert.equal(calls.edits.length, 6, "each refusal opens a fresh run rather than extending one");
});

test("a route's own success clears its refusals without clearing another route's", async () => {
  // The mirror of the split: an open that is refused forever must not be handed a fresh run of
  // three attempts every time an edit lands.
  let pct = 40;
  const { calls, usage } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
    read: () => reading(pct),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextOpen = permanent();
    pct += 1;
    await usage.tick();
  }

  assert.equal(calls.edits.length, 6, "every edit landed");
  assert.equal(calls.opens.length, 3, "and none of them bought the open another run");
});

test("the knob off constructs nothing: no thread, no timer, and no read of any kind", () => {
  const calls = recorder();
  let reads = 0;
  let bindingReads = 0;
  let timers = 0;
  const built = createUsageCard({
    enabled: false,
    channel: { transport: calls.transport, thresholds: THRESHOLDS },
    sessions: () => [],
    interimMirror: true,
    cacheRoot: null,
    binding: () => {
      bindingReads += 1;
      return { messageId: MESSAGE_ID, threadId: THREAD_ID };
    },
    refreshMs: 60_000,
    now: () => START,
    read: () => {
      reads += 1;
      return reading(40);
    },
    setTimer: () => {
      timers += 1;
      return 1 as unknown as NodeJS.Timeout;
    },
  });

  assert.equal(built, null);
  assert.equal(reads, 0, "claude-swap's files are never opened");
  assert.equal(bindingReads, 0, "no state file is read on a card's account either");
  assert.equal(timers, 0);
  assert.equal(calls.posts.length + calls.opens.length + calls.edits.length, 0);
});

test("no Discord configured constructs nothing even with the knob on", () => {
  let reads = 0;
  let bindingReads = 0;
  let timers = 0;
  const built = createUsageCard({
    enabled: true,
    channel: null,
    sessions: () => [],
    interimMirror: true,
    cacheRoot: null,
    binding: () => {
      bindingReads += 1;
      return { messageId: MESSAGE_ID, threadId: THREAD_ID };
    },
    refreshMs: 60_000,
    now: () => START,
    read: () => {
      reads += 1;
      return reading(40);
    },
    setTimer: () => {
      timers += 1;
      return 1 as unknown as NodeJS.Timeout;
    },
  });

  assert.equal(built, null);
  assert.equal(reads, 0);
  assert.equal(bindingReads, 0);
  assert.equal(timers, 0);
});

test("the knob on with a channel builds a card that reads and writes", async () => {
  const { calls, usage } = card();

  await usage.tick();

  assert.equal(calls.posts.length, 1);
});

test("start runs its first pass at once rather than one interval later", async () => {
  // Creating or rebinding the thread is what starting is for. Waiting on the interval leaves the
  // card absent from the channel for a whole refresh, which at the configured ceiling is an hour.
  const scheduled: number[] = [];
  const { calls, usage } = card({
    refreshMs: 60 * 60 * 1000,
    setTimer: (_callback, ms) => {
      scheduled.push(ms);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  usage.start();
  await usage.stop();

  assert.deepEqual(scheduled, [60 * 60 * 1000]);
  assert.equal(calls.posts.length, 1, "the card is up without waiting on the interval");
  assert.equal(calls.opens.length, 1);
});

test("stop clears the refresh timer without awaiting anything first", async () => {
  // The broker takes this timer down in the same synchronous block as its own and awaits the drain
  // afterwards. A timer surviving those awaits starts a pass that writes to Discord and to the
  // binding file for a broker that has already dropped its gateway.
  const cleared: number[] = [];
  const { usage } = card({
    setTimer: () => 7 as unknown as NodeJS.Timeout,
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  usage.start();
  const drain = usage.stop();

  assert.deepEqual(cleared, [7], "cleared by the time stop returns, before anything is awaited");
  await drain;
});

test("shutdown waits for the live pass, not for a fire that landed on top of it", async () => {
  // A timer fire arriving while a post is on the wire must be answered with that pass, not with a
  // promise of nothing. Answered wrongly, shutdown returns with the post still unsent: its binding
  // is never saved, and the next start posts a second card into the operator's channel.
  const timers: { id: number; ms: number; callback: () => void }[] = [];
  const cleared: number[] = [];
  const bindings: unknown[] = [];
  let released: (() => void) | null = null;
  const calls = recorder();
  calls.transport = {
    ...calls.transport,
    postCard: async ({ card: body }) => {
      calls.posts.push(body);
      await new Promise<void>((resolve) => {
        released = resolve;
      });
      return ok({ messageId: MESSAGE_ID });
    },
  };
  const { usage } = card({
    channel: { transport: calls.transport, thresholds: THRESHOLDS },
    onBind: (binding) => bindings.push(binding),
    setTimer: (callback, ms) => {
      const id = timers.length + 1;
      timers.push({ id, ms, callback });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  usage.start();
  usage.start();
  assert.equal(timers.length, 1, "starting twice runs one timer, not two");
  assert.equal(timers[0]?.ms, 60_000);
  assert.equal(calls.posts.length, 1, "and the first pass is already on the wire");

  timers[0]?.callback();
  assert.equal(calls.posts.length, 1, "a fire landing on that pass starts no second one");

  let stopped = false;
  const shutdown = usage.stop().then(() => {
    stopped = true;
  });
  assert.deepEqual(cleared, [1]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown waits for the call already on the wire");

  (released as unknown as () => void)();
  await shutdown;
  assert.equal(stopped, true);
  assert.deepEqual(
    bindings,
    [
      { messageId: MESSAGE_ID, threadId: null },
      { messageId: MESSAGE_ID, threadId: THREAD_ID },
    ],
    "the card that post created was persisted before shutdown returned",
  );
  // The timer is gone, so no further pass is scheduled and the recorded one is the only post.
  assert.equal(calls.posts.length, 1);
});
