import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.ts";
import type { HookIntake, Registry, SessionRecord } from "./registry.ts";

const TOKEN = "5f0c2e4a-0000-4000-8000-000000000001";

// A clock the tests advance by hand. Staleness is a timeout, and a test that waited for a real one
// would be a slow flake.
function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function sessionStart(sessionId: string, source: string, name = "neo-intake"): HookIntake {
  return {
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: name,
    sessionId,
    source,
    toolName: null,
  };
}

function postToolUse(
  toolName: string,
  processToken = TOKEN,
  sessionId: string | null = null,
): HookIntake {
  return {
    event: "PostToolUse",
    processToken,
    sessionName: null,
    sessionId,
    source: null,
    toolName,
  };
}

function stop(processToken = TOKEN): HookIntake {
  return {
    event: "Stop",
    processToken,
    sessionName: null,
    sessionId: null,
    source: null,
    toolName: null,
  };
}

function registry(now: () => number, staleAfterMs = 60_000): Registry {
  return createRegistry({ host: "NEO", staleAfterMs, now });
}

function byId(records: SessionRecord[], sessionId: string): SessionRecord {
  const found = records.find((record) => record.sessionId === sessionId);
  assert.ok(found, `no record for ${sessionId}`);
  return found;
}

test("a SessionStart from an unknown process token creates the session", () => {
  const time = clock();
  const sessions = registry(time.now);

  const record = sessions.apply(sessionStart("session-a", "startup"));

  assert.ok(record);
  assert.equal(record.sessionId, "session-a");
  assert.equal(record.name, "neo-intake");
  assert.equal(record.host, "NEO");
  assert.equal(record.source, "startup");
  assert.equal(record.state, "live");
  assert.equal(record.lastHookAt, time.now());
});

test("a source clear SessionStart creates a second record and ends the first", () => {
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Bash"));
  time.advance(5_000);
  sessions.apply(sessionStart("session-b", "clear"));

  const all = sessions.list();
  assert.equal(all.length, 2, "the superseded record is retained, not overwritten");

  const first = byId(all, "session-a");
  assert.equal(first.state, "ended");
  assert.equal(first.endedAt, time.now());
  assert.equal(first.toolCount, 1, "the ended record keeps the counts it accumulated");

  const second = byId(all, "session-b");
  assert.equal(second.state, "live");
  assert.equal(second.source, "clear");
  assert.equal(second.toolCount, 0);
  assert.equal(sessions.current(TOKEN)?.sessionId, "session-b");
});

test("a changed session ID supersedes whatever the source says", () => {
  // The fallback for a SessionStart that does not report source clear: the session ID changing is
  // itself the signal, so no other code path is needed for it.
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "resume"));

  assert.equal(byId(sessions.list(), "session-a").state, "ended");
  assert.equal(sessions.current(TOKEN)?.sessionId, "session-b");
});

test("a repeated SessionStart for the same session refreshes rather than replaces it", () => {
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Read"));
  time.advance(1_000);
  sessions.apply(sessionStart("session-a", "startup"));

  assert.equal(sessions.list().length, 1);
  assert.equal(sessions.list()[0].toolCount, 1);
  assert.equal(sessions.list()[0].lastHookAt, time.now());
});

test("a tool or stop event from an unannounced process token is ignored", () => {
  const time = clock();
  const sessions = registry(time.now);

  assert.equal(sessions.apply(postToolUse("Bash", "unknown-token")), null);
  assert.equal(sessions.apply(stop("unknown-token")), null);
  assert.deepEqual(sessions.list(), [], "a stray post must not conjure a session");
});

test("a tool or stop event after the session ended is ignored", () => {
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "clear"));

  sessions.apply(postToolUse("Bash"));

  assert.equal(byId(sessions.list(), "session-a").toolCount, 0);
  assert.equal(byId(sessions.list(), "session-b").toolCount, 1);
});

test("tool and turn accounting tracks the hook stream", () => {
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Bash"));
  sessions.apply(postToolUse("Read"));
  sessions.apply(stop());

  const record = sessions.list()[0];
  assert.equal(record.toolCount, 2);
  assert.equal(record.lastTool, "Read");
  assert.equal(record.turnCount, 1);
});

test("a silent session goes stale on the sweep with no inbound event", () => {
  const time = clock();
  const sessions = registry(time.now, 60_000);
  sessions.apply(sessionStart("session-a", "startup"));

  time.advance(59_999);
  assert.deepEqual(sessions.sweep(), [], "not yet overdue");
  assert.equal(sessions.list()[0].state, "live");

  time.advance(1);
  const changed = sessions.sweep();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].sessionId, "session-a");
  assert.equal(sessions.list()[0].state, "stale");

  assert.deepEqual(sessions.sweep(), [], "a sweep reports only what it changed");
});

test("hook traffic revives a stale session and an ended one stays ended", () => {
  const time = clock();
  const sessions = registry(time.now, 60_000);
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "clear"));

  time.advance(60_000);
  sessions.sweep();
  assert.equal(byId(sessions.list(), "session-b").state, "stale");
  assert.equal(byId(sessions.list(), "session-a").state, "ended", "the sweep leaves ended alone");

  sessions.apply(postToolUse("Bash"));
  assert.equal(byId(sessions.list(), "session-b").state, "live");
});

test("relay liveness holds a session out of staleness", () => {
  // The relay does not exist until Section 5. This locks the seam it will feed.
  const time = clock();
  const sessions = registry(time.now, 60_000);
  const record = sessions.apply(sessionStart("session-a", "startup"));
  assert.ok(record);

  time.advance(59_000);
  record.lastRelayAt = time.now();
  time.advance(59_000);

  assert.deepEqual(sessions.sweep(), []);
  assert.equal(sessions.list()[0].state, "live");
});

test("a late event carrying its session ID is not credited to the session that replaced it", () => {
  // Hook posts are independent requests with no ordering guarantee, so an event from the session a
  // /clear just replaced can arrive after the new session announced itself.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "clear"));

  const applied = sessions.apply(postToolUse("Bash", TOKEN, "session-a"));

  assert.equal(applied?.sessionId, "session-a");
  assert.equal(byId(sessions.list(), "session-b").toolCount, 0, "the new session is untouched");
  assert.equal(byId(sessions.list(), "session-a").toolCount, 1);
});

test("a late event cannot revive the session it belonged to", () => {
  const time = clock();
  const sessions = registry(time.now, 60_000);
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "clear"));

  time.advance(5_000);
  sessions.apply(postToolUse("Bash", TOKEN, "session-a"));

  const ended = byId(sessions.list(), "session-a");
  assert.equal(ended.state, "ended", "an ended record stays ended");
  assert.notEqual(ended.lastHookAt, time.now(), "and does not refresh its staleness clock");
});

test("an event naming an unknown or mismatched session is dropped", () => {
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("session-a", "startup"));

  assert.equal(sessions.apply(postToolUse("Bash", TOKEN, "never-existed")), null);
  // The session ID is honored, but the process token must still own it, so an event cannot be
  // aimed at a session belonging to another process.
  assert.equal(sessions.apply(postToolUse("Bash", "other-token", "session-a")), null);
  assert.equal(byId(sessions.list(), "session-a").toolCount, 0);
});

test("an event with no session ID still routes by process token", () => {
  // Whether session_id rides on a PostToolUse payload is unconfirmed, so the guard above has to be
  // opportunistic and this path has to keep working untouched.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("session-a", "startup"));

  const applied = sessions.apply(postToolUse("Bash"));

  assert.equal(applied?.sessionId, "session-a");
  assert.equal(byId(sessions.list(), "session-a").toolCount, 1);
});

test("terminal records are pruned once past the retention horizon", () => {
  const time = clock();
  const sessions = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    retainTerminalMs: 3_600_000,
    now: time.now,
  });
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "clear"));

  time.advance(3_599_000);
  sessions.sweep();
  assert.equal(sessions.list().length, 2, "still inside the horizon");

  time.advance(3_600_000);
  sessions.sweep();
  assert.deepEqual(sessions.list(), [], "both terminal records are gone");
});

test("a live session is never evicted to hold the cap", () => {
  const time = clock();
  const sessions = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    // Long enough that age never prunes here, so this test measures eviction alone.
    retainTerminalMs: 24 * 60 * 60 * 1000,
    maxSessions: 3,
    now: time.now,
  });

  // One session per process token, so none of them supersedes another.
  function announce(index: number): void {
    sessions.apply({
      event: "SessionStart",
      processToken: `token-${index}`,
      sessionName: `session-${index}`,
      sessionId: `session-${index}`,
      source: "startup",
      toolName: null,
    });
  }

  for (let index = 0; index < 10; index += 1) {
    announce(index);
    time.advance(10);
  }

  // Everything ages out of liveness except the one that just reported in.
  time.advance(60_000);
  announce(9);

  sessions.sweep();

  const survivors = sessions.list();
  assert.equal(survivors.length, 3, "the cap is held");
  const live = survivors.filter((record) => record.state === "live");
  assert.deepEqual(
    live.map((record) => record.sessionId),
    ["session-9"],
    "the live session survives a full cap",
  );
});

test("eviction takes the oldest terminal record first when the cap is exceeded", () => {
  const time = clock();
  const sessions = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    retainTerminalMs: 24 * 60 * 60 * 1000,
    maxSessions: 2,
    now: time.now,
  });

  for (const id of ["session-a", "session-b", "session-c"]) {
    sessions.apply(sessionStart(id, "clear"));
    time.advance(1_000);
  }

  sessions.sweep();

  const remaining = sessions.list().map((record) => record.sessionId);
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.includes("session-a"), `oldest evicted first: ${remaining.join(", ")}`);
  assert.ok(remaining.includes("session-c"));
});

test("every mutation notifies the persistence hook", () => {
  const time = clock();
  const snapshots: number[] = [];
  const sessions = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    now: time.now,
    onMutate: (records) => snapshots.push(records.length),
  });

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Bash"));
  sessions.apply(postToolUse("Bash", "unknown-token"));
  time.advance(60_000);
  sessions.sweep();
  sessions.sweep();

  assert.deepEqual(snapshots, [1, 1, 1], "ignored events and empty sweeps do not write");
});
