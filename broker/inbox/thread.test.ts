import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInboxCard, INBOX_THREAD_NAME } from "./thread.ts";
import type { InboxCardOptions } from "./thread.ts";
import { loadInboxBinding, saveInboxBinding } from "./binding.ts";
import type { InboxItem } from "./store.ts";
import type { CallOutcome, DiscordTransport, RateLimitObservation } from "../discord/transport.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";

const START = 1_000_000;
const MESSAGE_ID = "111111111111111111";
const THREAD_ID = "222222222222222222";
const GUILD_ID = "666666666666666666";
const SESSION_ID = "session-alpha";

// A clock the tests advance by hand. A budget block is a wait, and a test that waited out a real one
// would be a slow flake.
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

function marked(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: SESSION_ID,
    openedAt: START,
    refreshedAt: START,
    source: "marked",
    excerpt: "please review the migration",
    scores: null,
    winner: null,
    count: 1,
    messageId: null,
    ...overrides,
  };
}

function card(overrides: Partial<InboxCardOptions> = {}) {
  const calls = recorder();
  const time = clock();
  const logged: string[] = [];
  let items: readonly InboxItem[] = [marked()];
  const built = createInboxCard({
    transport: calls.transport,
    items: () => items,
    session: () => ({ title: "alpha", threadId: THREAD_ID, ended: false }),
    guildId: () => GUILD_ID,
    binding: () => null,
    refreshMs: 60_000,
    now: time.now,
    log: (message) => logged.push(message),
    ...overrides,
  });
  return {
    calls,
    time,
    logged,
    card: built,
    setItems: (next: readonly InboxItem[]) => {
      items = next;
    },
  };
}

test("the first tick posts the card and opens its thread on it, under a fixed name", async () => {
  const bindings: unknown[] = [];
  const { calls, card: built } = card({ onBind: (binding) => bindings.push(binding) });

  await built.tick();

  assert.equal(calls.posts.length, 1);
  assert.match(calls.posts[0] ?? "", /Fleet: Inbox/);
  assert.ok((calls.posts[0] ?? "").includes("alpha"));
  assert.deepEqual(calls.opens, [{ messageId: MESSAGE_ID, name: INBOX_THREAD_NAME }]);
  assert.equal(calls.edits.length, 0, "the card it just posted needs no edit");
  assert.deepEqual(bindings, [
    { messageId: MESSAGE_ID, threadId: null },
    { messageId: MESSAGE_ID, threadId: THREAD_ID },
  ]);
});

test("a restart rebinds to the persisted thread instead of opening a second one", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-inbox-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "inbox-card.json");

  const first = card({ onBind: (binding) => saveInboxBinding(file, binding) });
  await first.card.tick();

  const restarted = card({
    binding: () => loadInboxBinding(file, { log: () => {} }),
  });
  restarted.setItems([marked({ excerpt: "a different ask" })]);
  await restarted.card.tick();

  assert.equal(restarted.calls.posts.length, 0, "the card must not be posted a second time");
  assert.equal(restarted.calls.opens.length, 0, "the thread must not be opened a second time");
  assert.equal(restarted.calls.edits.length, 1);
  assert.equal(restarted.calls.edits[0]?.messageId, MESSAGE_ID);
});

test("an unchanged inbox spends no edit", async () => {
  const { calls, card: built } = card({ binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }) });

  await built.tick();
  await built.tick();

  assert.equal(calls.posts.length, 0);
  assert.equal(
    calls.edits.length,
    1,
    "the first tick re-establishes the card and the second must cost nothing",
  );
});

test("an item that changed spends one edit", async () => {
  const { calls, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  await built.tick();
  setItems([marked({ excerpt: "a new excerpt" })]);
  await built.tick();

  assert.equal(calls.edits.length, 2);
  assert.match(calls.edits[1]?.card ?? "", /a new excerpt/);
});

test("the guild is read fresh on every tick, not latched once at construction", async () => {
  // The item already carries a message ID, so a resolved guild is the only thing standing between
  // the chip fallback and a jump link: the edit body is the tell that this tick's own read, not a
  // value captured once when the card was built, decided which one drew.
  let guild: string | null = null;
  const { calls, card: built } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    guildId: () => guild,
    items: () => [marked({ messageId: MESSAGE_ID })],
  });

  await built.tick();
  assert.doesNotMatch(
    calls.edits[0]?.card ?? "",
    /discord\.com\/channels\//,
    "no guild is known yet, so the chip fallback draws",
  );

  guild = GUILD_ID;
  await built.tick();
  assert.match(
    calls.edits[1]?.card ?? "",
    /discord\.com\/channels\//,
    "the guild this tick's own read found draws the jump link",
  );
});

test("a refused edit is skipped rather than queued, and retried on the next tick", async () => {
  const { calls, time, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });
  await built.tick();
  assert.equal(calls.edits.length, 1);

  setItems([marked({ excerpt: "second" })]);
  calls.nextEdit = refused(30_000);
  await built.tick();
  assert.equal(calls.edits.length, 2, "the refusal was one attempt, not a retry loop");

  await built.tick();
  assert.equal(calls.edits.length, 2, "nothing is attempted while the bucket is empty");

  time.advance(30_001);
  await built.tick();
  assert.equal(calls.edits.length, 3, "the next tick past the block writes the current card");
  assert.match(calls.edits[2]?.card ?? "", /second/);
});

test("a card that could not be posted is retried rather than left thread-less", async () => {
  const { calls, time, card: built } = card();
  calls.nextPost = refused(10_000);

  await built.tick();
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.opens.length, 0, "there is no message to open a thread on");

  await built.tick();
  assert.equal(calls.posts.length, 1, "nothing is attempted while the bucket is empty");

  time.advance(10_001);
  await built.tick();
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.opens.length, 1, "the thread is opened on the card that landed");
});

test("a card reported gone while its thread is opened is not then edited", async () => {
  const { calls, card: built } = card({ binding: () => ({ messageId: MESSAGE_ID, threadId: null }) });
  calls.nextOpen = missing();

  await built.tick();

  assert.equal(calls.opens.length, 1);
  assert.equal(calls.edits.length, 0);

  await built.tick();
  assert.equal(calls.posts.length, 1, "the next tick builds a new card instead");
});

test("the card names the message it is drawn on, and names none while it has none", async () => {
  const { calls, card: built, setItems } = card();
  assert.equal(built.cardMessage(), null, "nothing is pinned before the card exists");

  await built.tick();
  assert.equal(built.cardMessage(), MESSAGE_ID);

  setItems([marked({ excerpt: "second" })]);
  calls.nextEdit = missing();
  await built.tick();
  assert.equal(built.cardMessage(), null, "a card Discord reports gone names no message");

  await built.tick();
  assert.equal(built.cardMessage(), MESSAGE_ID, "the rebuilt card names the message it is drawn on");
});

test("a card that keeps going missing is rebuilt a bounded number of times", async () => {
  let step = 0;
  const { calls, logged, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    calls.nextEdit = missing();
    step += 1;
    setItems([marked({ excerpt: `step ${String(step)}` })]);
    await built.tick();
  }

  assert.equal(calls.edits.length, 3, "the third disappearance is the last one answered");
  assert.equal(calls.posts.length, 2, "and only the first two bought a replacement card");
  assert.equal(calls.opens.length, 2);
  assert.ok(logged.some((line) => line.includes("went missing 3 times in a row")));
});

test("a card Discord keeps refusing permanently is given up on", async () => {
  const { calls, logged, card: built } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextEdit = permanent();
    await built.tick();
  }

  assert.equal(calls.edits.length, 3, "three refusals in a row end the card's writes");
  assert.ok(logged.some((line) => line.includes("refused 3 times in a row")));
});

test("a route refused past the ceiling stops alone, and the rest of the card keeps working", async () => {
  let step = 0;
  const { calls, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    calls.nextOpen = permanent();
    step += 1;
    setItems([marked({ excerpt: `step ${String(step)}` })]);
    await built.tick();
  }

  assert.equal(calls.opens.length, 3, "three refusals in a row end the thread open");
  assert.equal(calls.edits.length, 5, "and the card is still written on every pass");
});

test("refusals far enough apart never add up to a route being given up on", async () => {
  let step = 0;
  const { calls, time, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextEdit = permanent();
    step += 1;
    setItems([marked({ excerpt: `step ${String(step)}` })]);
    await built.tick();
    // Past the decay window, which is three refresh intervals wide.
    time.advance(3 * 60_000 + 1);
  }

  assert.equal(calls.edits.length, 6, "each refusal opens a fresh run rather than extending one");
});

test("a route's own success clears its refusals without clearing another route's", async () => {
  let step = 0;
  const { calls, card: built, setItems } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: null }),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    calls.nextOpen = permanent();
    step += 1;
    setItems([marked({ excerpt: `step ${String(step)}` })]);
    await built.tick();
  }

  assert.equal(calls.edits.length, 6, "every edit landed");
  assert.equal(calls.opens.length, 3, "and none of them bought the open another run");
});

test("a rejected token stops the card rather than being retried on every pass", async () => {
  const { calls, logged, card: built } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
  });
  calls.nextEdit = {
    status: "failed",
    error: "the bot token was rejected",
    rate: NO_RATE_INFO,
    fatal: true,
    permanent: true,
  };

  await built.tick();
  await built.tick();

  assert.equal(calls.edits.length, 1, "the card makes no further call of any kind");
  assert.ok(logged.some((line) => line.includes("the bot token was rejected")));
});

test("start runs its first pass at once rather than one interval later", async () => {
  const scheduled: number[] = [];
  const { calls, card: built } = card({
    refreshMs: 60 * 60 * 1000,
    setTimer: (_callback, ms) => {
      scheduled.push(ms);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  built.start();
  await built.stop();

  assert.deepEqual(scheduled, [60 * 60 * 1000]);
  assert.equal(calls.posts.length, 1, "the card is up without waiting on the interval");
  assert.equal(calls.opens.length, 1);
});

test("stop clears the refresh timer without awaiting anything first", async () => {
  const cleared: number[] = [];
  const { card: built } = card({
    setTimer: () => 7 as unknown as NodeJS.Timeout,
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  built.start();
  const drain = built.stop();

  assert.deepEqual(cleared, [7], "cleared by the time stop returns, before anything is awaited");
  await drain;
});

test("shutdown waits for the live pass, not for a fire that landed on top of it", async () => {
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
  const { card: built } = card({
    transport: calls.transport,
    onBind: (binding) => bindings.push(binding),
    setTimer: (callback, ms) => {
      const id = timers.length + 1;
      timers.push({ id, ms, callback });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => cleared.push(timer as unknown as number),
  });

  built.start();
  built.start();
  assert.equal(timers.length, 1, "starting twice runs one timer, not two");
  assert.equal(timers[0]?.ms, 60_000);
  assert.equal(calls.posts.length, 1, "and the first pass is already on the wire");

  timers[0]?.callback();
  assert.equal(calls.posts.length, 1, "a fire landing on that pass starts no second one");

  let stopped = false;
  const shutdown = built.stop().then(() => {
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
  assert.equal(calls.posts.length, 1);
});

test("a pass that throws is caught, reported through the limiter, and followed by another", async () => {
  let failing = true;
  const timers: (() => void)[] = [];
  const { calls, logged, card: built } = card({
    binding: () => ({ messageId: MESSAGE_ID, threadId: THREAD_ID }),
    items: () => {
      if (failing) throw new Error("the store carries a session's reply text");
      return [marked()];
    },
    setTimer: (callback) => {
      timers.push(callback);
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  built.start();
  await built.stop();
  assert.equal(calls.edits.length, 0);
  const reported = logged.filter((line) => line.includes("a refresh pass failed"));
  assert.equal(reported.length, 1);
  assert.doesNotMatch(reported[0] ?? "", /reply text/, "the error itself is discarded unread");

  failing = false;
  timers[0]?.();
  await built.stop();
  assert.equal(calls.edits.length, 1, "the next pass runs as if nothing had happened");
});

test("one failing pass is one failure however many timer fires joined it", async () => {
  const timers: (() => void)[] = [];
  let release: ((value: never) => void) | null = null;
  const calls = recorder();
  calls.transport = {
    ...calls.transport,
    postCard: async () =>
      new Promise((_resolve, reject) => {
        release = reject as unknown as (value: never) => void;
      }),
  };
  const { logged, card: built } = card({
    transport: calls.transport,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  built.start();
  timers[0]?.();
  timers[0]?.();

  (release as unknown as (error: Error) => void)(new Error("the request object"));
  await built.stop();

  const reported = logged.filter((line) => line.includes("a refresh pass failed"));
  assert.equal(reported.length, 1, "three fires on one pass is one reported failure");
});
