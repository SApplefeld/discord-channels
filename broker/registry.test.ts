import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.ts";
import type {
  BackgroundTaskReading,
  HookIntake,
  ModelFallback,
  Registry,
  SessionRecord,
} from "./registry.ts";

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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  };
}

function postToolUse(
  toolName: string,
  processToken = TOKEN,
  sessionId: string | null = null,
  toolInput: string | null = null,
): HookIntake {
  return {
    event: "PostToolUse",
    processToken,
    sessionName: null,
    sessionId,
    source: null,
    toolName,
    toolInput,
    transcriptPath: null,
    backgroundTasks: null,
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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
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

test("a tool event sets the name and the preview together", () => {
  // The preview describes the call the card is naming. A tool whose input carried nothing
  // previewable has to clear the last one's preview, or the card shows a new tool name beside the
  // previous tool's arguments, which reads as the current call's input and is simply false.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("session-a", "startup"));

  sessions.apply(postToolUse("Bash", TOKEN, null, "npm test"));
  assert.equal(sessions.list()[0].lastTool, "Bash");
  assert.equal(sessions.list()[0].lastToolInput, "npm test");

  sessions.apply(postToolUse("TodoWrite", TOKEN, null, null));
  assert.equal(sessions.list()[0].lastTool, "TodoWrite");
  assert.equal(sessions.list()[0].lastToolInput, null, "the previous tool's preview is cleared");
});

test("a tool event carrying an input but no name moves neither", () => {
  // The card renders the name and the preview as one line about one call. A payload with an input
  // and no usable name is not a call this can describe, and taking the input alone would leave the
  // previous call's name beside it, asserting a pairing that never happened. `tool_name` is absent,
  // not a string, or empty once cleaned: broker/intake.ts answers null for all three.
  const time = clock();
  const sessions = registry(time.now);
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Read", TOKEN, null, "D:\\x\\y.ts"));

  sessions.apply({
    event: "PostToolUse",
    processToken: TOKEN,
    sessionName: null,
    sessionId: null,
    source: null,
    toolName: null,
    toolInput: "rm -rf /",
    transcriptPath: null,
    backgroundTasks: null,
  });

  assert.equal(sessions.list()[0].lastTool, "Read");
  assert.equal(sessions.list()[0].lastToolInput, "D:\\x\\y.ts", "the nameless input is not adopted");
  // The event is still a tool event and still counts, which is what holds the session out of the
  // staleness sweep; only the pair the card renders is left alone.
  assert.equal(sessions.list()[0].toolCount, 2);
});

test("a new session starts with no tool and no preview", () => {
  const time = clock();
  const sessions = registry(time.now);

  const record = sessions.apply(sessionStart("session-a", "startup"));

  assert.ok(record);
  assert.equal(record.lastTool, null);
  assert.equal(record.lastToolInput, null);
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

test("a PreToolUse event is liveness alone: it stamps and revives, and moves no counter", () => {
  // PreToolUse fires at the moment AskUserQuestion opens its picker, before the call completes;
  // the completion's own PostToolUse still arrives at answer time and does the tool accounting.
  // Counting the emission too would count every question twice, and a question is not a turn.
  const time = clock();
  const sessions = registry(time.now, 60_000);
  sessions.apply(sessionStart("session-a", "startup"));
  sessions.apply(postToolUse("Bash", TOKEN, null, "npm test"));

  time.advance(60_000);
  assert.equal(sessions.sweep().length, 1, "the session goes stale first, so the revive below is real");

  time.advance(1_000);
  const record = sessions.apply({
    event: "PreToolUse",
    processToken: TOKEN,
    sessionName: null,
    sessionId: "session-a",
    source: null,
    toolName: "AskUserQuestion",
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });

  assert.ok(record);
  assert.equal(record.state, "live", "a PreToolUse revives a stale session as any hook event does");
  assert.equal(record.lastHookAt, time.now());
  assert.equal(record.toolCount, 1, "the emission is not a completed tool call");
  assert.equal(record.turnCount, 0, "the emission is not a turn boundary");
  assert.equal(record.lastTool, "Bash", "the card keeps describing the last completed call");
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
      toolInput: null,
      transcriptPath: null,
      backgroundTasks: null,
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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });

  const stolen = registry.apply({
    event: "SessionStart",
    processToken: attacker,
    sessionName: "neo-warden",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
  registry.relayClosed(first, "session-a");

  const reused = registry.apply({
    event: "SessionStart",
    processToken: second,
    sessionName: "two",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });

  assert.equal(registry.relayClosed("another-token", "session-a"), null, "not this token's to end");
  assert.equal(registry.list()[0].state, "live");
  assert.equal(registry.relayClosed(token, "session-missing"), null, "no such session");
  assert.equal(registry.list()[0].state, "live");

  assert.notEqual(registry.relayClosed(token, "session-a"), null);
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(registry.relayClosed(token, "session-a"), null, "a repeated close is a no-op");
});

/** A registry holding one live session, with the mutation count the persistence seam would spend. */
function withSession(): { registry: Registry; sessionId: string; writes: () => number } {
  let writes = 0;
  const registry = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    onMutate: () => {
      writes += 1;
    },
  });
  registry.apply(sessionStart("session-a", "startup"));
  return { registry, sessionId: "session-a", writes: () => writes };
}

test("a model change is reported once, not once per poll", () => {
  const { registry, sessionId, writes } = withSession();
  const opening = writes();

  assert.deepEqual(
    registry.noteModel(sessionId, { model: "claude-opus-4-8", contextTokens: 1_000 }),
    [],
    "the first sighting names the model the session opened with, which is not a change",
  );
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-opus-4-8", contextTokens: 2_000 }), []);
  // Upward is the operator's own switch: announced at once, with nothing attached and no hold.
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 3_000 }), [
    {
      sessionId,
      from: "claude-opus-4-8",
      to: "claude-fable-5",
      downgrade: null,
    },
  ]);
  // The polls that follow the change, which arrive every interval for as long as the session runs.
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 4_000 }), []);
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 5_000 }), []);

  const record = registry.list()[0];
  assert.equal(record.openingModel, "claude-opus-4-8", "the opening model survives every later reading");
  assert.equal(record.model, "claude-fable-5");
  assert.equal(record.contextTokens, 5_000);
  assert.equal(
    writes() - opening,
    2,
    "the context alone is not persisted; only the two model transitions are",
  );
});

test("a downgrade record stands until the session returns to the model it opened with", () => {
  const { registry, sessionId } = withSession();
  registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 1_000 });
  registry.noteFallback(sessionId, {
    cause: "refusal",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    category: "cyber",
    choice: null,
  });
  const changes = registry.noteModel(sessionId, { model: "claude-opus-4-8", contextTokens: 2_000 });

  assert.equal(changes.length, 1, "the record-first order announces at the transition");
  assert.equal(changes[0].downgrade?.category, "cyber", "the change names what upstream flagged");
  assert.equal(registry.list()[0].downgrade?.cause, "refusal");

  const back = registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 3_000 });
  assert.deepEqual(back, [
    {
      sessionId,
      from: "claude-opus-4-8",
      to: "claude-fable-5",
      downgrade: null,
    },
  ]);
  assert.equal(registry.list()[0].downgrade, null, "the switch-back clears what the marker read");
});

test("a downgrade arriving before any reading names the model the session opened with", () => {
  // The entitlement record fires at the top of the session, before a line has named a model: without
  // its own `originalModel` the next assistant line would seed the opening model from the fallback,
  // and a session running degraded would render as one that opened that way.
  const { registry, sessionId } = withSession();
  const consent: ModelFallback = {
    cause: "consent",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-5[1m]",
    category: null,
    choice: "cancelled",
  };
  registry.noteFallback(sessionId, consent);
  assert.equal(registry.list()[0].openingModel, "claude-fable-5");

  assert.deepEqual(
    registry.noteModel(sessionId, { model: "claude-opus-5[1m]", contextTokens: 1_000 }),
    [{ sessionId, from: "claude-fable-5", to: "claude-opus-5[1m]", downgrade: consent }],
    "the first reading reports the change the record already made, from the opening model",
  );
  const record = registry.list()[0];
  assert.equal(record.openingModel, "claude-fable-5");
  assert.equal(record.model, "claude-opus-5[1m]");
});

test("a reading for a session the registry does not hold unended changes nothing", () => {
  const { registry, sessionId } = withSession();
  registry.relayClosed(TOKEN, sessionId);

  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 1 }), []);
  registry.noteFallback(sessionId, {
    cause: "refusal",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    category: "cyber",
    choice: null,
  });
  registry.noteModel("no-such-session", { model: "claude-fable-5", contextTokens: 1 });

  const record = registry.list()[0];
  assert.equal(record.model, null, "an ended record is a tombstone a late line cannot move");
  assert.equal(record.downgrade, null);
  assert.equal(registry.list().length, 1, "no record is conjured for a session that never announced");
});

/** The refusal record's fields as the reader reduces them, the captured specimen's values. */
const REFUSAL: ModelFallback = {
  cause: "refusal",
  originalModel: "claude-fable-5",
  fallbackModel: "claude-opus-4-8",
  category: "cyber",
  choice: null,
};

test("both downgrade orders produce the same change and the same card state", () => {
  // Measured against the captured specimen: on the refusal path the assistant line carrying the
  // new model lands first and the system record follows about twelve seconds later, while on the
  // consent path the record leads. The operator must not be able to tell the orders apart from
  // the thread, so the transition-first order holds its announcement for the record that trails
  // it, and the record's arrival releases the same change the record-first order reports.
  const recordFirst = withSession();
  recordFirst.registry.noteModel(recordFirst.sessionId, { model: "claude-fable-5", contextTokens: 1 });
  assert.equal(recordFirst.registry.noteFallback(recordFirst.sessionId, REFUSAL), null);
  const led = recordFirst.registry.noteModel(recordFirst.sessionId, {
    model: "claude-opus-4-8",
    contextTokens: 2,
  });

  const transitionFirst = withSession();
  transitionFirst.registry.noteModel(transitionFirst.sessionId, {
    model: "claude-fable-5",
    contextTokens: 1,
  });
  assert.deepEqual(
    transitionFirst.registry.noteModel(transitionFirst.sessionId, {
      model: "claude-opus-4-8",
      contextTokens: 2,
    }),
    [],
    "a downward move with no record holds its announcement for the record that trails it",
  );
  const trailed = transitionFirst.registry.noteFallback(transitionFirst.sessionId, REFUSAL);

  assert.deepEqual(led, [
    {
      sessionId: recordFirst.sessionId,
      from: "claude-fable-5",
      to: "claude-opus-4-8",
      downgrade: REFUSAL,
    },
  ]);
  assert.deepEqual([trailed], led, "the two orders post one identical message");
  const [ledRecord] = recordFirst.registry.list();
  const [trailedRecord] = transitionFirst.registry.list();
  assert.equal(trailedRecord.openingModel, ledRecord.openingModel);
  assert.equal(trailedRecord.model, ledRecord.model);
  assert.deepEqual(trailedRecord.downgrade, ledRecord.downgrade);
});

test("a session that starts downgraded posts its change, from the opening model", () => {
  // The consent record fires before any assistant line, so the first reading has no previous model
  // to diff against. The opening model the record seeded is the honest `from`: without it the one
  // downgrade an operator away from the keyboard can act on posts no message at all.
  const { registry, sessionId } = withSession();
  const consent: ModelFallback = {
    cause: "consent",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-5[1m]",
    category: null,
    choice: "cancelled",
  };
  assert.equal(registry.noteFallback(sessionId, consent), null);
  assert.deepEqual(
    registry.noteModel(sessionId, { model: "claude-opus-5[1m]", contextTokens: 1_000 }),
    [
      {
        sessionId,
        from: "claude-fable-5",
        to: "claude-opus-5[1m]",
        downgrade: consent,
      },
    ],
    "the change is reported from the opening model the record seeded",
  );
});

test("a transition landing first at session start does not seed the opening model from the fallback", () => {
  // The measured refusal order at the top of a session: the assistant line naming the fallback
  // model is the session's first reading, so without the record's own correction the opening model
  // seeds from the fallback itself and the marker is suppressed for a session that is genuinely
  // degraded.
  const { registry, sessionId } = withSession();
  assert.deepEqual(
    registry.noteModel(sessionId, { model: "claude-opus-4-8", contextTokens: 1_000 }),
    [],
    "the first reading is not a change",
  );
  const change = registry.noteFallback(sessionId, REFUSAL);
  const record = registry.list()[0];
  assert.equal(record.openingModel, "claude-fable-5", "the record reseeds the mis-seeded opening");
  assert.equal(record.model, "claude-opus-4-8");
  assert.deepEqual(
    change,
    { sessionId, from: "claude-fable-5", to: "claude-opus-4-8", downgrade: REFUSAL },
    "the record's arrival is what posts the change the reading could not report",
  );
});

test("a stale downgrade record neither rides an unrelated change nor survives a decorated switch-back", () => {
  const time = clock();
  const registry = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    now: time.now,
    fallbackAttachMs: 30_000,
  });
  registry.apply(sessionStart("session-a", "startup"));
  registry.noteModel("session-a", { model: "claude-fable-5", contextTokens: 1 });
  registry.noteFallback("session-a", REFUSAL);
  registry.noteModel("session-a", { model: "claude-opus-4-8", contextTokens: 2 });

  // A manual switch to a third model. The standing refusal record describes the move to opus, not
  // this one, so the change must post plain rather than blaming a safeguard for the operator's own
  // hand. Downward with no record of its own, it is held for the attach window and released plain.
  assert.deepEqual(registry.noteModel("session-a", { model: "claude-haiku-4", contextTokens: 3 }), []);
  time.advance(30_000);
  assert.deepEqual(registry.dueModelChanges(), [
    { sessionId: "session-a", from: "claude-opus-4-8", to: "claude-haiku-4", downgrade: null },
  ]);
  assert.deepEqual(registry.dueModelChanges(), [], "a released change is not released twice");

  // A switch-back that arrives decorated reaches the opening family without matching its exact
  // string, and reaching the opening family is what ends the downgrade.
  const back = registry.noteModel("session-a", { model: "claude-fable-5[1m]", contextTokens: 4 });
  assert.deepEqual(back, [
    { sessionId: "session-a", from: "claude-haiku-4", to: "claude-fable-5[1m]", downgrade: null },
  ]);
  assert.equal(registry.list()[0].downgrade, null, "reaching the opening family clears the record");
});

test("a held change is released ahead of the next change, in order", () => {
  // A model that moves again inside the attach window supersedes the hold: two changes, two
  // messages, posted in the order they happened rather than the held one silently dropped.
  const { registry, sessionId } = withSession();
  registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 1 });
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-opus-4-8", contextTokens: 2 }), []);
  assert.deepEqual(registry.noteModel(sessionId, { model: "claude-fable-5", contextTokens: 3 }), [
    { sessionId, from: "claude-fable-5", to: "claude-opus-4-8", downgrade: null },
    { sessionId, from: "claude-opus-4-8", to: "claude-fable-5", downgrade: null },
  ]);
});

test("a session that ends takes its model state with it when the sweep prunes the record", () => {
  const time = clock();
  const registry = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    retainTerminalMs: 1_000,
    now: time.now,
  });
  registry.apply(sessionStart("session-a", "startup"));
  registry.noteModel("session-a", { model: "claude-fable-5", contextTokens: 1_000 });
  registry.relayClosed(TOKEN, "session-a");

  time.advance(2_000);
  registry.sweep();
  assert.deepEqual(registry.list(), [], "nothing accumulates for a session that ended");
});

/** A `Stop` carrying the harness's own task table, as the payload reports it. */
function stopWithTasks(tasks: readonly BackgroundTaskReading[] | null): HookIntake {
  return { ...stop(), backgroundTasks: tasks };
}

function task(id: string, overrides: Partial<BackgroundTaskReading> = {}): BackgroundTaskReading {
  return {
    id,
    kind: "subagent",
    description: `work ${id}`,
    agentType: "general-purpose",
    ...overrides,
  };
}

test("each report replaces the roster whole, and a table that empties clears it", () => {
  const time = clock();
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: time.now });
  registry.apply(sessionStart("session-a", "startup"));

  registry.apply(stopWithTasks([task("one"), task("two")]));
  assert.deepEqual(
    byId(registry.list(), "session-a").backgroundTasks.map((held) => held.id),
    ["one", "two"],
  );

  registry.apply(stopWithTasks([task("two")]));
  assert.deepEqual(
    byId(registry.list(), "session-a").backgroundTasks.map((held) => held.id),
    ["two"],
    "a task that left the table is gone rather than merged forward",
  );

  registry.apply(stopWithTasks([]));
  assert.deepEqual(
    byId(registry.list(), "session-a").backgroundTasks,
    [],
    "and a session reporting no tasks at all is waiting on nothing",
  );
});

test("a task keeps the moment it was first seen for as long as it is reported", () => {
  const time = clock();
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: time.now });
  registry.apply(sessionStart("session-a", "startup"));
  registry.apply(stopWithTasks([task("one")]));
  const first = byId(registry.list(), "session-a").backgroundTasks[0].since;

  time.advance(40 * 60_000);
  registry.apply(stopWithTasks([task("one"), task("two")]));

  const held = byId(registry.list(), "session-a").backgroundTasks;
  assert.equal(held[0].since, first, "an agent running forty minutes is not forty minutes younger");
  assert.equal(held[1].since, time.now(), "and one first seen now is stamped now");
});

test("an id reused by the other kind is a new task, not the dead one's age", () => {
  // The carry-forward keys on id and kind together: ids are the harness's to mint, so a shell
  // task arriving under an id a finished subagent once held is different work, and inheriting the
  // subagent's first-sighting stamp would render it as having run since before it existed.
  const time = clock();
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: time.now });
  registry.apply(sessionStart("session-a", "startup"));
  registry.apply(stopWithTasks([task("one")]));

  time.advance(40 * 60_000);
  registry.apply(stopWithTasks([task("one", { kind: "shell", agentType: null })]));

  const held = byId(registry.list(), "session-a").backgroundTasks;
  assert.equal(held[0].since, time.now(), "the reused id is stamped at its own first sighting");
});

test("a payload that says nothing about the table leaves the roster standing", () => {
  const time = clock();
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: time.now });
  registry.apply(sessionStart("session-a", "startup"));
  registry.apply(stopWithTasks([task("one")]));

  // What a malformed `background_tasks` reduces to at the intake, and what every event but Stop
  // carries. Clearing on it would erase a live roster on an unreadable field.
  registry.apply(stopWithTasks(null));
  registry.apply(postToolUse("Bash"));

  assert.deepEqual(
    byId(registry.list(), "session-a").backgroundTasks.map((held) => held.id),
    ["one"],
  );
});

test("a restored session starts with no roster, since nothing here saw its tasks start", () => {
  const time = clock();
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: time.now });
  registry.apply(sessionStart("session-a", "startup"));
  registry.apply(stopWithTasks([task("one")]));

  // A /clear replaces the session under the same token, and the replacement is a session no table
  // has reported anything about yet.
  registry.apply(sessionStart("session-b", "clear"));

  assert.deepEqual(byId(registry.list(), "session-b").backgroundTasks, []);
});
