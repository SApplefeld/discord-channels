import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurface } from "./surface.ts";
import type { SurfaceOptions } from "./surface.ts";
import type { SessionView } from "./state.ts";
import type { CallOutcome, DiscordTransport, RateLimitObservation } from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

const START = 1_000_000;
const DWELL_MS = 60_000;
const IDLE_AFTER_MS = 30_000;
const EXITED_AFTER_MS = 4 * 60 * 60 * 1000;

// A clock the tests advance by hand. Dwell is a timeout, and a test that waited out a real one
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

type Recorder = {
  transport: DiscordTransport;
  posts: string[];
  opens: { messageId: string; name: string }[];
  cards: string[];
  renames: { threadId: string; name: string }[];
  archived: string[];
  /** Scripted results for the next call of each kind. Anything unscripted succeeds. */
  nextPost: CallOutcome<{ messageId: string }> | null;
  nextOpen: CallOutcome<{ threadId: string }> | null;
  nextRename: CallOutcome<null> | null;
  nextEdit: CallOutcome<null> | null;
};

function recorder(threadId = "thread-1"): Recorder {
  const state: Recorder = {
    posts: [],
    opens: [],
    cards: [],
    renames: [],
    archived: [],
    nextPost: null,
    nextOpen: null,
    nextRename: null,
    nextEdit: null,
    transport: {
      postCard: async ({ card }) => {
        state.posts.push(card);
        const scripted = state.nextPost;
        state.nextPost = null;
        return scripted ?? ok({ messageId: `message-${state.posts.length}` });
      },
      openThread: async ({ messageId, name }) => {
        state.opens.push({ messageId, name });
        const scripted = state.nextOpen;
        state.nextOpen = null;
        return scripted ?? ok({ threadId });
      },
      editCard: async ({ card }) => {
        state.cards.push(card);
        const scripted = state.nextEdit;
        state.nextEdit = null;
        return scripted ?? ok(null);
      },
      renameThread: async ({ threadId: id, name }) => {
        state.renames.push({ threadId: id, name });
        const scripted = state.nextRename;
        state.nextRename = null;
        return scripted ?? ok(null);
      },
      archiveThread: async ({ threadId: id }) => {
        state.archived.push(id);
        return ok(null);
      },
    },
  };
  return state;
}

function names(calls: Recorder): string[] {
  return calls.renames.map((rename) => rename.name);
}

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
    goal: null,
    turnCount: 1,
    lastHookAt: START,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

function surfaceWith(
  time: ReturnType<typeof clock>,
  calls: Recorder,
  overrides: Partial<SurfaceOptions> = {},
) {
  return createSurface({
    transport: calls.transport,
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
    ...overrides,
  });
}

test("a new session gets one thread, opened on the broker's own starter message", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  await surface.tick([view()]);

  assert.equal(calls.posts.length, 1, "the starter message is posted once");
  assert.match(calls.posts[0], /^State {5}working$/m);
  assert.deepEqual(calls.opens, [{ messageId: "message-1", name: "⚙ neo-intake · working" }]);
  assert.equal(surface.threadFor("session-a"), "thread-1");
  assert.equal(surface.threadFor("session-b"), null);
});

test("a thread that could not be opened is retried on the message already posted", async () => {
  // The two calls fail independently. Reposting the card whenever the second one failed would put
  // an orphaned starter message into the channel on every refresh.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  calls.nextOpen = { status: "failed", error: "HTTP 403", rate: NO_RATE_INFO };
  await surface.tick([view()]);
  await surface.tick([view()]);

  assert.equal(calls.posts.length, 1, "the card is never posted twice");
  assert.equal(calls.opens.length, 2, "the thread is re-opened on the message that exists");
  assert.deepEqual(calls.opens[1], { messageId: "message-1", name: "⚙ neo-intake · working" });
  assert.equal(surface.threadFor("session-a"), "thread-1");
});

test("creates come out of a budget, so a refused post is not retried inside its wait", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  calls.nextPost = refused(30_000);
  await surface.tick([view()]);
  assert.equal(calls.posts.length, 1);

  time.advance(10_000);
  await surface.tick([view()]);
  assert.equal(calls.posts.length, 1, "still inside the reported wait");

  time.advance(20_000);
  await surface.tick([view()]);
  assert.equal(calls.posts.length, 2);
});

test("one pass writes no more than its cap, and the rest waits for the next", async () => {
  // Anything on this machine can announce a session over the loopback listener, so the number of
  // threads wanted at once is not something this broker controls.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, { maxCallsPerTick: 3 });

  const many = ["a", "b", "c", "d"].map((id) => view({ sessionId: `session-${id}` }));
  await surface.tick(many);

  assert.equal(calls.posts.length + calls.opens.length, 3, "the cap counts every call");

  await surface.tick(many);
  assert.ok(calls.posts.length > 2, "the deferred work is picked up by the next pass");
});

test("a rename the budget refuses is dropped, and the next state still renders", async () => {
  // A queued rename lands minutes late painting a state that stopped being true, which is the
  // failure this design rejects outright. What replaces the queue is recomputing from live state.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  assert.deepEqual(names(calls), []);

  // The session falls quiet and reads as idle, then idle holds past the dwell window and earns a
  // rename, which the budget refuses.
  time.advance(IDLE_AFTER_MS + 1);
  await surface.tick([view()]);
  time.advance(DWELL_MS);
  calls.nextRename = refused(30_000);
  await surface.tick([view()]);
  assert.deepEqual(names(calls), ["✅ neo-intake · idle"], "the refused attempt was made once");

  // Still inside the reported wait: nothing is retried and nothing is held.
  time.advance(10_000);
  await surface.tick([view()]);
  assert.equal(calls.renames.length, 1, "a refused rename is not retried inside the wait");

  // The session ends while the budget is still blocked, then the wait expires.
  time.advance(25_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  await surface.tick([ended]);

  assert.deepEqual(
    names(calls),
    ["✅ neo-intake · idle", "⚠ neo-intake · exited"],
    "the dropped idle rename never lands after the state moved on",
  );
});

test("flapping between working and idle inside the dwell window spends at most one rename", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  const started = time.now();
  await surface.tick([view({ lastHookAt: started })]);

  // Quiet long enough to read as idle, but not long enough for idle to settle.
  time.advance(IDLE_AFTER_MS + 1);
  await surface.tick([view({ lastHookAt: started })]);
  assert.deepEqual(names(calls), [], "an unsettled state is not worth a rename");

  // A hook arrives and it is working again, still inside the dwell window.
  time.advance(1_000);
  const resumed = time.now();
  await surface.tick([view({ lastHookAt: resumed })]);

  // And quiet again.
  time.advance(IDLE_AFTER_MS + 1);
  await surface.tick([view({ lastHookAt: resumed })]);
  assert.deepEqual(names(calls), [], "the flap cost nothing");

  // This time idle holds past the dwell window, which is what earns the one rename.
  time.advance(DWELL_MS);
  await surface.tick([view({ lastHookAt: resumed })]);
  assert.deepEqual(names(calls), ["✅ neo-intake · idle"]);

  time.advance(DWELL_MS);
  await surface.tick([view({ lastHookAt: resumed })]);
  assert.equal(calls.renames.length, 1, "a state already painted is not repainted");
});

test("an agent count change is damped like any other rename, so a drain coalesces", async () => {
  // The dwell keys on the composed title, not on the derived state: the agent count rides the
  // title, so a fan-out draining a step per Stop would otherwise spend a rename per step out of
  // the same budget an urgent needs-you rename has to come out of.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  const agents = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `agent-${index}`,
      kind: "subagent" as const,
      description: null,
      agentType: null,
      since: START,
    }));

  // The thread opens working and stays settled well past the dwell window.
  await surface.tick([view({ lastHookAt: time.now() })]);
  time.advance(DWELL_MS + 1_000);
  let seen = time.now();
  await surface.tick([view({ lastHookAt: seen })]);
  assert.deepEqual(names(calls), [], "the opened title already says working");

  // A fan-out lands: the derived state is unchanged, the composed title is not.
  await surface.tick([view({ lastHookAt: seen, backgroundTasks: agents(3) })]);
  assert.equal(calls.renames.length, 0, "a count that just appeared has not settled");

  // The fan-out drains a step inside the dwell window.
  time.advance(DWELL_MS / 2);
  seen = time.now();
  await surface.tick([view({ lastHookAt: seen, backgroundTasks: agents(2) })]);
  assert.equal(calls.renames.length, 0, "each step re-stamps the dwell rather than renaming");

  // The remaining pair holds past the dwell window, which is what earns the one rename.
  time.advance(DWELL_MS);
  seen = time.now();
  await surface.tick([view({ lastHookAt: seen, backgroundTasks: agents(2) })]);
  assert.deepEqual(names(calls), ["⚙ neo-intake · working · 2 tasks"]);
});

test("one thread's exhausted rename budget does not hold up another thread", async () => {
  // Discord buckets a channel modification per channel, and a thread is a channel. A global budget
  // would let a flapping session spend the wait that an urgent rename elsewhere needed.
  const time = clock();
  const calls = recorder();
  let opened = 0;
  const surface = createSurface({
    transport: {
      ...calls.transport,
      openThread: async (input) => {
        opened += 1;
        calls.opens.push(input);
        return ok({ threadId: `thread-${opened}` });
      },
    },
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
  });

  const first = view({ sessionId: "session-a" });
  const second = view({ sessionId: "session-b", name: "neo-migrate" });
  await surface.tick([first, second]);

  time.advance(1_000);
  calls.nextRename = refused(60_000);
  await surface.tick([{ ...first, lifecycle: "ended", endedAt: time.now() }, second]);
  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"], "the first thread's rename is refused");

  await surface.tick([
    { ...first, lifecycle: "ended", endedAt: time.now() },
    { ...second, needsAttention: true },
  ]);

  assert.deepEqual(calls.renames[1], {
    threadId: "thread-2",
    name: "⏸ neo-migrate · needs you",
  });
});

test("a session that ends is renamed without waiting out the dwell window", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  await surface.tick([view({ lifecycle: "ended", endedAt: time.now() })]);

  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"]);
});

test("a session waiting on a person is renamed without waiting out the dwell window", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  await surface.tick([view({ needsAttention: true })]);

  assert.deepEqual(names(calls), ["⏸ neo-intake · needs you"]);
});

test("a startup pass archives a restored thread whose session already exited, exactly once", async () => {
  // Hosts carry sessions that exited before archiving became the default, and their threads sit in
  // the active list with nothing left to drive them: the registry has long since let the record go,
  // so the session arrives in no view set. The retire path is what reaches them, and it paints the
  // final card and title before it closes the thread, so nothing is archived still claiming to work.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    archiveOnEnd: true,
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
  });

  await surface.tick([]);
  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"], "the final title lands first");
  assert.deepEqual(calls.archived, ["thread-9"]);

  time.advance(1_000);
  await surface.tick([]);
  assert.deepEqual(calls.archived, ["thread-9"], "the pass that reached it is the only one");
});

test("a restored thread whose record is still retained as ended is archived too", async () => {
  // The other startup shape: the registry retains a dead record for its retention window, so the
  // session does arrive in the view set and is driven through reconcile rather than retire. Both
  // paths reach the same close, or an exited session's thread would stay in the active list for as
  // long as its record is retained.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    archiveOnEnd: true,
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
  });

  await surface.tick([view({ lifecycle: "ended", endedAt: time.now() })]);

  assert.deepEqual(calls.archived, ["thread-9"]);
});

test("an archived thread is never renamed, whatever the session goes on to report", async () => {
  // Discord refuses a rename on an archived thread, so the archive is the last write a session's
  // thread takes. A later title change would be a doomed call on every pass for the life of the
  // broker, and the record's own name is what a title is composed from, so it can still move.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, { archiveOnEnd: true });

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  await surface.tick([ended]);
  assert.deepEqual(calls.archived, ["thread-1"]);
  const spent = calls.renames.length;

  time.advance(DWELL_MS * 2);
  await surface.tick([{ ...ended, name: "neo-renamed" }]);
  await surface.tick([{ ...ended, name: "neo-renamed-again", needsAttention: true }]);

  assert.equal(calls.renames.length, spent, "nothing is attempted against the archived thread");
});

test("a thread revived by a post is not archived again until its session exits again", async () => {
  // Posting into an archived thread revives it on Discord's side, which is the whole reason
  // archiving is not deletion. The session behind it can then go back to working, and a surface
  // that re-derived the close from the live state would shut the thread on the operator mid-read.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, { archiveOnEnd: true });

  await surface.tick([view()]);
  time.advance(1_000);
  await surface.tick([view({ lifecycle: "ended", endedAt: time.now() })]);
  assert.deepEqual(calls.archived, ["thread-1"]);

  const painted = calls.cards.length;
  // A pass per dwell, so the rename back to a live title is settled by the time it is asked for.
  for (let pass = 0; pass < 3; pass += 1) {
    time.advance(DWELL_MS);
    await surface.tick([view({ lastHookAt: time.now(), turnCount: pass + 2 })]);
  }

  assert.deepEqual(calls.archived, ["thread-1"], "the revived thread is left where the operator put it");
  assert.ok(calls.cards.length > painted, "and its card is maintained again rather than left frozen");
  assert.equal(names(calls).at(-1), "⚙ neo-intake · working", "and its title follows it back");

  // The real exit, which is what the archive is for: it closes again rather than staying open
  // because an earlier presumption already spent the one archive the thread was ever going to get.
  time.advance(1_000);
  await surface.tick([view({ lifecycle: "ended", endedAt: time.now() })]);
  assert.deepEqual(calls.archived, ["thread-1", "thread-1"]);
});

test("an exited thread is left open unless archiving is turned on", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  await surface.tick([ended]);
  await surface.tick([ended]);

  assert.deepEqual(calls.archived, [], "archiving is off by default");
});

test("archiving, when configured, happens only after the exited name has landed", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, { archiveOnEnd: true });

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });

  // The rename is refused, so the thread still claims to be working and must not be closed on it.
  calls.nextRename = refused(1_000);
  await surface.tick([ended]);
  assert.deepEqual(calls.archived, [], "a thread is never archived still painted working");

  time.advance(2_000);
  await surface.tick([ended]);
  assert.deepEqual(calls.archived, ["thread-1"]);

  await surface.tick([ended]);
  assert.equal(calls.archived.length, 1, "and it is archived once");
});

test("the card is edited in place, and only when its text changed", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  await surface.tick([view()]);
  assert.deepEqual(calls.cards, [], "an unchanged card costs nothing");

  await surface.tick([view({ lastTool: "Read", turnCount: 2 })]);

  assert.equal(calls.posts.length, 1, "the starter message is never re-posted");
  assert.equal(calls.cards.length, 1);
  assert.match(calls.cards[0], /^### Tool\n```\nRead\n```$/m, calls.cards[0]);
});

test("an in-flight pass is not overtaken by the next tick", async () => {
  // The refresh runs on a timer. Without this guard a slow post would be issued again by the next
  // tick, and one session would own two starter messages.
  const time = clock();
  const calls = recorder();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const surface = createSurface({
    transport: {
      ...calls.transport,
      postCard: async (input) => {
        await blocked;
        return calls.transport.postCard(input);
      },
    },
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
  });

  const first = surface.tick([view()]);
  await surface.tick([view()]);
  release();
  await first;

  assert.equal(calls.posts.length, 1);
});

test("a rename that fails outright is retried on the next pass", async () => {
  // A dropped rename and a failed one differ: the budget has nothing to say about a network error,
  // so the difference is simply still there to be reconciled.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  calls.nextRename = { status: "failed", error: "socket hang up", rate: NO_RATE_INFO };
  await surface.tick([ended]);
  await surface.tick([ended]);

  assert.deepEqual(names(calls), ["⚠ neo-intake · exited", "⚠ neo-intake · exited"]);
});

test("a restored binding reattaches instead of opening a second thread", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
  });

  await surface.tick([view()]);

  assert.deepEqual(calls.posts, [], "the starter message is already posted");
  assert.deepEqual(calls.opens, [], "the thread already exists");
  assert.equal(surface.threadFor("session-a"), "thread-9");
  assert.equal(calls.cards.length, 1, "the card is refreshed onto the message it owns");
});

test("a session first seen already ended gets no thread at all", async () => {
  // A restart against a state file finds up to a day of retained dead records. Announcing them
  // would fill the channel with threads for sessions that ended while the broker was down.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view({ lifecycle: "ended", endedAt: START })]);
  await surface.tick([view({ lifecycle: "ended", endedAt: START })]);

  assert.deepEqual(calls.posts, []);
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(names(calls), []);
});

test("a binding is reported for persistence as it is created and dropped", async () => {
  const time = clock();
  const calls = recorder();
  const seen: string[] = [];
  const surface = surfaceWith(time, calls, {
    onBind: (bindings) => seen.push(JSON.stringify(bindings)),
  });

  await surface.tick([view()]);
  await surface.tick([]);

  assert.equal(
    seen[0],
    JSON.stringify([
      {
        sessionId: "session-a",
        messageId: "message-1",
        threadId: null,
        archived: false,
        name: "neo-intake",
        title: null,
      },
    ]),
    "the posted message is recorded before the thread exists",
  );
  assert.equal(
    seen[1],
    JSON.stringify([
      {
        sessionId: "session-a",
        messageId: "message-1",
        threadId: "thread-1",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ]),
    "and the title it carries is recorded with it",
  );
  assert.equal(seen.at(-1), "[]", "and the binding is dropped when the session is retired");
});

test("a session that vanishes from the registry is driven to exited before it is forgotten", async () => {
  // Retention pruning and cap eviction both remove a record with no further event. Forgetting the
  // thread at that moment would leave it claiming working forever.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  await surface.tick([]);

  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"]);
  assert.equal(surface.threadFor("session-a"), null, "and then it is forgotten");
});

test("a vanished session whose final rename is refused is retried, not abandoned", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  calls.nextRename = refused(5_000);
  await surface.tick([]);
  assert.equal(surface.threadFor("session-a"), "thread-1", "the entry is kept until it converges");

  time.advance(5_000);
  await surface.tick([]);

  assert.deepEqual(names(calls), ["⚠ neo-intake · exited", "⚠ neo-intake · exited"]);
  assert.equal(surface.threadFor("session-a"), null);
});

test("a retiring session has its card driven to exited, not just its title", async () => {
  // A thread titled exited over a card that still says working with a frozen heartbeat is a
  // thread contradicting itself.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  await surface.tick([]);

  assert.equal(calls.cards.length, 1, "the card is rewritten before the entry is let go");
  assert.match(calls.cards[0], /^State {5}exited$/m);
  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"]);
  assert.equal(surface.threadFor("session-a"), null);
});

test("a retiring session whose rename is permanently refused is let go, not retried forever", async () => {
  // A rate limit lifts and a 403 does not. Keeping the entry would fire one doomed rename and one
  // log line every tick for the life of the broker, and across every restart after it.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  calls.nextRename = {
    status: "failed",
    error: "HTTP 403",
    rate: NO_RATE_INFO,
    permanent: true,
  };
  await surface.tick([]);
  const spentOnce = calls.renames.length;
  await surface.tick([]);

  assert.equal(surface.threadFor("session-a"), null, "the entry is let go");
  assert.equal(calls.renames.length, spentOnce, "and nothing is attempted after that");
});

test("a retiring session that never converges is let go after a bounded number of passes", async () => {
  const time = clock();
  const calls = recorder();
  const surface = createSurface({
    transport: {
      ...calls.transport,
      renameThread: async (input) => {
        calls.renames.push(input);
        return { status: "failed", error: "socket hang up", rate: NO_RATE_INFO };
      },
    },
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
  });

  await surface.tick([view()]);
  for (let pass = 0; pass < 8; pass += 1) {
    time.advance(1_000);
    await surface.tick([]);
  }

  assert.equal(surface.threadFor("session-a"), null);
  assert.ok(calls.renames.length <= 5, `${calls.renames.length} doomed renames`);
});

test("a message Discord says is gone takes its binding with it and is rebuilt", async () => {
  // An operator deleting the starter message would otherwise leave the broker editing a message
  // that does not exist, once per tick, forever, with the 4xx's own headers clearing any block.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  calls.nextEdit = {
    status: "failed",
    error: "HTTP 404",
    rate: { remaining: 5, resetAfterMs: 1_000, retryAfterMs: null },
    permanent: true,
    missing: true,
  };
  await surface.tick([view({ lastTool: "Read" })]);

  assert.equal(calls.posts.length, 2, "the dead binding is dropped and a fresh card is posted");
  assert.equal(calls.opens.length, 2, "with a thread opened on the new message");
  assert.equal(calls.opens[1].messageId, "message-2");

  await surface.tick([view({ lastTool: "Read" })]);
  assert.equal(calls.posts.length, 2, "and the rebuild happens once, not once per pass");
});

const GONE: CallOutcome<never> = {
  status: "failed",
  error: "HTTP 404",
  rate: { remaining: 5, resetAfterMs: 1_000, retryAfterMs: null },
  permanent: true,
  missing: true,
};

test("a deleted card for an exited session is not posted again", async () => {
  // The operator deleting a dead session's card is the operator saying they are done with it.
  // Rebuilding it would put a fresh card and a fresh empty thread back in the channel, once per
  // dead session, for as long as the registry retains the record.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  calls.nextEdit = GONE;
  await surface.tick([ended]);
  await surface.tick([ended]);
  await surface.tick([ended]);

  assert.equal(calls.posts.length, 1, "no card is posted for a session that already exited");
  assert.equal(calls.opens.length, 1, "and no thread is opened on one");
  assert.deepEqual(names(calls), [], "the surface is given up on rather than repainted");
  assert.equal(calls.cards.length, 1, "and the dead message is not edited again");
});

test("a deleted card for a session waiting on a person is rebuilt", async () => {
  // The live cases are the reason the rebuild exists: a permission prompt lands in the thread, so
  // a session still running needs one.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  calls.nextEdit = GONE;
  await surface.tick([view({ needsAttention: true })]);

  assert.equal(calls.posts.length, 2, "a fresh card is posted");
  assert.equal(calls.opens.length, 2, "with a thread opened on it");
  assert.equal(calls.opens[1].messageId, "message-2");
});

test("a deleted card for an idle session is rebuilt", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(IDLE_AFTER_MS + 1);
  calls.nextEdit = GONE;
  await surface.tick([view()]);

  assert.equal(calls.posts.length, 2, "a fresh card is posted");
  assert.equal(calls.opens.length, 2, "with a thread opened on it");
});

test("a restored binding whose message is gone and whose session exited is not reposted", async () => {
  // The restart shape: bindings come back believing their sessions are working, and the first pass
  // learns from a 404 that the message the operator deleted while the broker was down is gone.
  const time = clock();
  const calls = recorder();
  const seen: string[] = [];
  const surface = surfaceWith(time, calls, {
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
    onBind: (bindings) => seen.push(JSON.stringify(bindings)),
  });

  const ended = view({ lifecycle: "ended", endedAt: START });
  calls.nextEdit = GONE;
  await surface.tick([ended]);
  await surface.tick([ended]);

  assert.deepEqual(calls.posts, [], "the surface the operator deleted stays deleted");
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(names(calls), []);
  assert.equal(seen.at(-1), "[]", "and the binding for it is dropped from what is persisted");
});

test("a deleted thread for an exited session is not opened again", async () => {
  // The card half of the same rule is above; this is the thread half. A rename that 404s drops
  // only the thread ID, and the rebuild path would otherwise put a fresh empty thread on the
  // surviving card of a session that is over.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  calls.nextRename = GONE;
  await surface.tick([ended]);
  await surface.tick([ended]);
  await surface.tick([ended]);

  assert.equal(calls.opens.length, 1, "no thread is opened for a session that already exited");
  assert.equal(calls.posts.length, 1, "and the surviving card is not reposted");
});

test("a presumed-dead session's deleted card waits, and its revival rebuilds it", async () => {
  // The backstop's exited is a presumption: a stale record silent past the window can still wake
  // on a hook or a relay. Abandoning on it would leave the revived session with no card, no
  // thread, and no message routing for the life of the broker, so the deleted surface is declined
  // without being given up on. Declining spends nothing: no call is made on any pass it holds.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(EXITED_AFTER_MS + 1_000);
  const presumed = view({ lifecycle: "stale" });
  calls.nextEdit = GONE;
  await surface.tick([presumed]);
  await surface.tick([presumed]);
  assert.equal(calls.posts.length, 1, "nothing is rebuilt while the session is presumed dead");
  assert.equal(calls.opens.length, 1);

  await surface.tick([view({ lastHookAt: time.now() })]);
  assert.equal(calls.posts.length, 2, "the session waking rebuilds its card");
  assert.equal(calls.opens.length, 2, "and its thread");
});

test("a dead session's surviving card is painted before its surface is let go", async () => {
  // The abandonment wait mirrors archive()'s: give up only once the card carries the final state,
  // or a busy tick's rate limit would freeze a dead session's card saying working forever.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  time.advance(1_000);
  const ended = view({ lifecycle: "ended", endedAt: time.now() });
  // The exit tick: the final card edit is rate-limited and the thread turns out deleted.
  calls.nextEdit = refused(5_000);
  calls.nextRename = GONE;
  await surface.tick([ended]);
  // The edit budget is still blocked, so the paint cannot land; the entry must not be abandoned.
  await surface.tick([ended]);
  assert.equal(calls.opens.length, 1, "no thread is rebuilt for the dead session meanwhile");

  time.advance(6_000);
  await surface.tick([ended]);
  const finalCard = calls.cards.at(-1);
  assert.ok(finalCard !== undefined && finalCard.includes("exited"), "the final paint lands");

  time.advance(60_000);
  await surface.tick([ended]);
  assert.equal(calls.opens.length, 1, "and only then is the surface given up on");
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.cards.length, 2, "an abandoned card stops earning heartbeat edits");
});

test("a surface Discord keeps refusing is given up on", async () => {
  const time = clock();
  const calls = recorder();
  const surface = createSurface({
    transport: {
      ...calls.transport,
      postCard: async ({ card }) => {
        calls.posts.push(card);
        return { status: "failed", error: "HTTP 403", rate: NO_RATE_INFO, permanent: true };
      },
    },
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
  });

  for (let pass = 0; pass < 6; pass += 1) {
    time.advance(1_000);
    await surface.tick([view()]);
  }

  assert.equal(calls.posts.length, 3, "three refusals are enough to stop trying");
});

test("a restored binding keeps the session name and the title the thread carries", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚠ neo-intake · exited",
      },
    ],
  });

  // The session is gone from the registry, so this binding is retired on the first pass.
  await surface.tick([]);

  assert.deepEqual(names(calls), [], "a thread already titled exited is not repainted");
  assert.equal(surface.threadFor("session-a"), null);
});

test("a restored binding whose session is gone is titled with the name, not the session ID", async () => {
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    bindings: [
      {
        sessionId: "session-a",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
  });

  await surface.tick([]);

  assert.deepEqual(names(calls), ["⚠ neo-intake · exited"]);
});

test("the pin list reads the cards of the sessions that are running, and only after a pass", async () => {
  // What the channel's pin list is driven from. A binding restored from the previous run carries no
  // state until a pass has derived one, and a session the registry has dropped is driven to exited
  // inside that pass, so the read belongs after the tick rather than beside it.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls, {
    bindings: [
      {
        sessionId: "session-gone",
        messageId: "message-9",
        threadId: "thread-9",
        archived: false,
        name: "neo-intake",
        title: "⚙ neo-intake · working",
      },
    ],
  });

  await surface.tick([view()]);
  assert.deepEqual(
    [...surface.livePins()].sort(),
    ["message-1"],
    "the restored binding's session is gone, so its card is not in the roster",
  );

  // The live session exits, which is what the card itself now says.
  time.advance(EXITED_AFTER_MS + 1);
  await surface.tick([view({ lifecycle: "ended", endedAt: time.now() })]);
  assert.deepEqual(surface.livePins(), [], "an exited session's card drops out of the roster");

  // The sweep's own set is wider than the roster, and this is the difference the pin narrowing
  // rests on: the exited session's card is out of the roster and still in the sweep's reach, which
  // is the one case the sweep exists for. What is not in it is the binding this surface has already
  // let go of, which is exactly what the narrowing costs: a pin left over from a pruned binding is
  // the operator's to remove by hand.
  assert.deepEqual(
    [...surface.knownPins()].sort(),
    ["message-1"],
    "the exited session's own card, and no card whose binding is gone",
  );
});

test("a card is kept current even while its thread cannot be opened", async () => {
  const time = clock();
  const calls = recorder();
  const surface = createSurface({
    transport: {
      ...calls.transport,
      openThread: async (input) => {
        calls.opens.push(input);
        return { status: "failed", error: "socket hang up", rate: NO_RATE_INFO };
      },
    },
    now: time.now,
    dwellMs: DWELL_MS,
    idleAfterMs: IDLE_AFTER_MS,
    exitedAfterMs: EXITED_AFTER_MS,
    archiveOnEnd: false,
  });

  await surface.tick([view()]);
  await surface.tick([view({ lastTool: "Read", turnCount: 4 })]);

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.cards.length, 1, "the posted message does not freeze at its first text");
  assert.match(calls.cards[0], /^Read$/m, calls.cards[0]);
});

test("a failed call is not evidence about the bucket it failed in", async () => {
  // A 4xx or a 5xx carries rate-limit headers like any other response, and folding them in would
  // let a refusal both block a bucket that has room and clear one that does not.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  await surface.tick([view()]);
  calls.nextEdit = {
    status: "failed",
    error: "HTTP 502",
    rate: { remaining: 0, resetAfterMs: 60_000, retryAfterMs: null },
  };
  await surface.tick([view({ lastTool: "Read" })]);
  assert.equal(calls.cards.length, 1);

  time.advance(1_000);
  await surface.tick([view({ lastTool: "Read" })]);

  assert.equal(calls.cards.length, 2, "the transient failure is retried, not waited out");
});

test("a thread creation refused for rate does not stop another session's card being posted", async () => {
  // Posting a message and starting a thread are different routes in different buckets, and one
  // route's headers say nothing about the other's.
  const time = clock();
  const calls = recorder();
  const surface = surfaceWith(time, calls);

  calls.nextOpen = refused(60_000);
  await surface.tick([view({ sessionId: "session-a" })]);
  assert.equal(calls.posts.length, 1);

  await surface.tick([
    view({ sessionId: "session-a" }),
    view({ sessionId: "session-b", name: "neo-migrate" }),
  ]);

  assert.equal(calls.posts.length, 2, "the second session's card is posted");
  assert.equal(calls.opens.length, 1, "while thread creation is still waiting out its bucket");
});

test("a rejected token stops the surfaces once, loudly", async () => {
  const time = clock();
  const calls = recorder();
  const fatal: string[] = [];
  const surface = surfaceWith(time, calls, { onFatal: (message) => fatal.push(message) });

  calls.nextPost = {
    status: "failed",
    error: "the bot token was rejected",
    rate: NO_RATE_INFO,
    fatal: true,
  };
  await surface.tick([view()]);
  await surface.tick([view()]);

  assert.equal(fatal.length, 1, fatal.join(" / "));
  assert.match(fatal[0], /token was rejected/);
  assert.equal(calls.posts.length, 1, "no further call is made against a rejected credential");
});
