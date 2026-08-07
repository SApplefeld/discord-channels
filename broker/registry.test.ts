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

function sessionStart(sessionId: string, source: string | null, name = "neo-intake"): HookIntake {
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

test("a changed session ID supersedes under every source but startup", () => {
  // The fallback for a SessionStart that does not report source clear: the session ID changing is
  // itself the signal, so no other code path is needed for it.
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(sessionStart("session-b", "resume"));

  assert.equal(byId(sessions.list(), "session-a").state, "ended");
  assert.equal(sessions.current(TOKEN)?.sessionId, "session-b");
});

test("a source startup SessionStart under a relayed session is a subprocess and registers nothing", () => {
  // CHANNEL_PROCESS_TOKEN is inherited by every process a wrapped session spawns, so a claude run
  // as a subprocess announces its own new session ID under its parent's token. The relay is what
  // marks the parent as a real launch: the wrapper starts one with every session it launches.
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("parent", "startup"));
  sessions.relaySeen(TOKEN);
  sessions.apply(postToolUse("Bash"));
  const announcedAt = time.now();
  time.advance(5_000);

  const child = sessions.apply(sessionStart("child", "startup", "subprocess"));

  assert.equal(child, null, "the arrival is dropped the way any unroutable post is");
  assert.equal(sessions.list().length, 1, "no record is created for the subprocess");
  const parent = byId(sessions.list(), "parent");
  assert.equal(parent.state, "live", "the parent keeps running");
  assert.equal(parent.endedAt, null);
  assert.equal(parent.name, "neo-intake", "the subprocess does not rename the parent");
  assert.equal(parent.toolCount, 1);
  assert.equal(
    parent.lastHookAt,
    announcedAt,
    "a subprocess announcement is not the parent's own liveness",
  );
  assert.equal(sessions.current(TOKEN)?.sessionId, "parent", "the parent keeps the token");
});

test("an unrecognized source and an absent one both still supersede", () => {
  // The protection the source check has to preserve: only the one value known to mean "a new
  // process started" is read as a subprocess. Anything else is a replacement, including a trigger
  // this broker has never seen and a payload carrying no source at all, because a /clear whose new
  // session never registered would be a session with no thread and no mirror.
  const time = clock();

  const unknown = registry(time.now);
  unknown.apply(sessionStart("session-a", "startup"));
  unknown.relaySeen(TOKEN);
  unknown.apply(sessionStart("session-b", "teleport"));
  assert.equal(byId(unknown.list(), "session-a").state, "ended");
  assert.equal(unknown.current(TOKEN)?.sessionId, "session-b");

  const absent = registry(time.now);
  absent.apply(sessionStart("session-a", "startup"));
  absent.relaySeen(TOKEN);
  absent.apply(sessionStart("session-b", null));
  assert.equal(byId(absent.list(), "session-a").state, "ended");
  assert.equal(absent.current(TOKEN)?.sessionId, "session-b");
});

test("a startup SessionStart supersedes a live record that no relay ever attached to", () => {
  // The recovery path that keeps the decline from being a denial of service. A live record is
  // creatable with one hook post by any process that read the token out of its environment, and a
  // live record is never pruned and never evicted, so a squat that could decline a real session's
  // announcement would hold the token for the life of the broker. The relay is what a real launch
  // has and a hook-only announcement does not, so the real session takes the token back.
  const time = clock();
  const sessions = registry(time.now);

  sessions.apply(sessionStart("squat", "startup", "not-the-operator"));
  assert.equal(sessions.list()[0].lastRelayAt, null, "a hook-only announcement gets no relay");
  time.advance(1_000);

  const real = sessions.apply(sessionStart("real", "startup", "neo-warden"));

  assert.equal(real?.sessionId, "real", "the real session registers");
  assert.equal(byId(sessions.list(), "squat").state, "ended");
  assert.equal(sessions.current(TOKEN)?.sessionId, "real", "and takes the token");

  // With its pipe attached, the real session's own subprocesses are declined as they should be.
  sessions.relaySeen(TOKEN);
  assert.equal(sessions.apply(sessionStart("child", "startup")), null);
  assert.equal(sessions.current(TOKEN)?.sessionId, "real");
});

test("subprocessStart names only the arrival start declines as a subprocess", () => {
  // The signal a caller reports the drop from. apply answers null for everything it ignores, so
  // this has to be true of the subprocess and false of every other arrival that shares that null,
  // or an expected drop and a session that failed to register read the same in the log.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("parent", "startup"));

  assert.equal(
    sessions.subprocessStart(sessionStart("child", "startup")),
    false,
    "no relay has attached to the incumbent, so nothing is protected yet",
  );
  sessions.relaySeen(TOKEN);

  assert.equal(sessions.subprocessStart(sessionStart("child", "startup")), true);
  assert.equal(sessions.subprocessStart(sessionStart("replacement", "clear")), false, "a /clear");
  assert.equal(sessions.subprocessStart(sessionStart("parent", "startup")), false, "a refresh");
  assert.equal(sessions.subprocessStart(postToolUse("Bash")), false, "not a SessionStart at all");
  assert.equal(
    sessions.subprocessStart({ ...sessionStart("child", "startup"), processToken: "other-token" }),
    false,
    "a first announcement under a token no session holds",
  );
  assert.equal(
    sessions.subprocessStart({ ...sessionStart("parent", "startup"), processToken: "other-token" }),
    false,
    "an arrival the impostor guard refuses is refused for that reason",
  );
});

test("subprocessStart answers the same before and after the apply it explains", () => {
  // The classification is read after apply has run, so it is only honest if the declined arrival
  // changed nothing that the answer depends on. Asserted rather than reasoned about, because a
  // future mutation on that path would make every subprocess drop log the wrong cause.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("parent", "startup"));
  sessions.relaySeen(TOKEN);

  const arrival = sessionStart("child", "startup");
  assert.equal(sessions.subprocessStart(arrival), true);
  assert.equal(sessions.apply(arrival), null);
  assert.equal(sessions.subprocessStart(arrival), true, "the declined arrival mutated nothing");
});

test("impostorStart names the takeover the registry refuses, and nothing else", () => {
  // The other refusal that shares apply's null, and the one that is a security event rather than
  // routine traffic. It is reported under its own cause, so it needs its own signal.
  const time = clock();
  const sessions = registry(time.now);
  const attacker = "22222222-2222-2222-2222-222222222222";
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.relaySeen(TOKEN);

  const takeover = { ...sessionStart("session-a", "startup"), processToken: attacker };
  assert.equal(sessions.impostorStart(takeover), true);
  assert.equal(sessions.apply(takeover), null, "and it is refused");
  assert.equal(sessions.impostorStart(sessionStart("child", "startup")), false, "a subprocess");
  assert.equal(sessions.impostorStart(sessionStart("session-a", "startup")), false, "a refresh");
  assert.equal(
    sessions.impostorStart({ ...postToolUse("Bash"), processToken: attacker }),
    false,
    "not a SessionStart at all",
  );

  sessions.relayClosed(TOKEN, "session-a");
  assert.equal(
    sessions.impostorStart(takeover),
    false,
    "an ended record is a tombstone, not a claim on the identifier",
  );
});

test("a startup SessionStart supersedes a stale record and follows an ended one", () => {
  // The subprocess reading rests on the parent being demonstrably alive. A record the sweep has
  // given up on is not, and an ended one is a tombstone, so a startup arriving on either replaces
  // it rather than being turned away.
  const time = clock();
  const stale = registry(time.now, 60_000);
  stale.apply(sessionStart("session-a", "startup"));
  stale.relaySeen(TOKEN);
  time.advance(60_000);
  stale.sweep();
  assert.equal(byId(stale.list(), "session-a").state, "stale");

  stale.apply(sessionStart("session-b", "startup"));
  assert.equal(byId(stale.list(), "session-a").state, "ended");
  assert.equal(stale.current(TOKEN)?.sessionId, "session-b");

  const ended = registry(time.now, 60_000);
  ended.apply(sessionStart("session-a", "startup"));
  ended.relayClosed(TOKEN, "session-a");
  ended.apply(sessionStart("session-b", "startup"));
  assert.equal(ended.current(TOKEN)?.sessionId, "session-b");
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

test("a SessionStart cannot take over a session another process token holds", () => {
  // A session ID is not a secret: GET /sessions publishes every one of them. Without this refusal a
  // local process could mint a token, announce a SessionStart carrying a running session's ID, and
  // overwrite that record in place with one holding its own token. Thread bindings key on session
  // ID and persist, so the operator's messages would route to the impostor and its replies would
  // land in the real thread as that session, while the real one went dark.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const victim = "11111111-1111-1111-1111-111111111111";
  const attacker = "22222222-2222-2222-2222-222222222222";

  registry.apply({
    event: "SessionStart",
    processToken: victim,
    sessionName: "neo-warden",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });

  const stolen = registry.apply({
    event: "SessionStart",
    processToken: attacker,
    sessionName: "neo-warden",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });

  assert.equal(stolen, null, "the takeover is refused, not merged");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].processToken, victim, "the record still belongs to the real session");
  assert.equal(registry.current(attacker), null, "the attacker holds nothing");
  assert.equal(registry.current(victim)?.sessionId, "session-a");
});

test("a session ID left behind by an ended session can be announced again", () => {
  // Only a record still holding the ID is protected. A tombstone is not a claim on the identifier,
  // and refusing there would make a genuine reuse look like an attack.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";

  registry.apply({
    event: "SessionStart",
    processToken: first,
    sessionName: "one",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });
  registry.relayClosed(first, "session-a");

  const reused = registry.apply({
    event: "SessionStart",
    processToken: second,
    sessionName: "two",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });
  assert.notEqual(reused, null);
  assert.equal(registry.current(second)?.processToken, second);
});

test("relayClosed ends only the session it names, held by the token that names it", () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const token = "11111111-1111-1111-1111-111111111111";
  registry.apply({
    event: "SessionStart",
    processToken: token,
    sessionName: "one",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });

  assert.equal(registry.relayClosed("another-token", "session-a"), null, "not this token's to end");
  assert.equal(registry.list()[0].state, "live");
  assert.equal(registry.relayClosed(token, "session-missing"), null, "no such session");
  assert.equal(registry.list()[0].state, "live");

  assert.notEqual(registry.relayClosed(token, "session-a"), null);
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(registry.relayClosed(token, "session-a"), null, "a repeated close is a no-op");
});
