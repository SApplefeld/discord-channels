// The relay hub against the real registry, because the two halves that matter here are exactly the
// join between them: which session a pipe belongs to, and what its closing means.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_RESTART_GRACE_MS, loadConfig } from "../config.ts";
import { createRegistry } from "../registry.ts";
import type { Registry, SessionRecord } from "../registry.ts";
import { createRelayHub } from "./relays.ts";
import type { AttachResult, RelayConnection, RelayEvent } from "./relays.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const GRACE_MS = 10_000;

// The source matters to the registry: a startup arriving under a token a live session already
// holds is a subprocess of that session and registers nothing, so a test that means to replace the
// session under a token announces the replacement the way a /clear does.
function announce(
  registry: Registry,
  sessionId: string,
  processToken = TOKEN,
  source = "startup",
): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    lineage: null,
    sessionId,
    source,
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
}

type FakeConnection = RelayConnection & {
  sent: RelayEvent[];
  closed: boolean;
  dead: boolean;
  /** Stands in for the close event a real socket emits, which can arrive inside close() itself. */
  onClose: (() => void) | null;
};

function fakeConnection(): FakeConnection {
  const connection: FakeConnection = {
    sent: [],
    closed: false,
    dead: false,
    onClose: null,
    send(event: RelayEvent): boolean {
      if (connection.dead) return false;
      connection.sent.push(event);
      return true;
    },
    close(): void {
      connection.closed = true;
      connection.onClose?.();
    },
  };
  return connection;
}

/** Asserts the attach was accepted and hands back its detach. */
function accepted(result: AttachResult): () => void {
  assert.equal(result.attached, true, "the hub refused a pipe this test expected it to take");
  return (result as { attached: true; detach: () => void }).detach;
}

function harness(options: { now?: () => number } = {}) {
  const now = options.now ?? ((): number => 1_000);
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: GRACE_MS, now });
  return { registry, relays };
}

test("a pipe that closes and stays closed marks its session ended, on the heartbeat", () => {
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const detach = accepted(relays.attach(TOKEN, fakeConnection()));
  assert.equal(registry.current(TOKEN)?.state, "live");

  detach();
  // Not immediately: the relay reconnects by design, and `ended` is terminal.
  assert.equal(registry.list()[0].state, "live", "a closed pipe is given its grace window first");

  now += GRACE_MS - 1;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "still inside the window");

  now += 2;
  relays.heartbeat();
  assert.equal(registry.current(TOKEN), null, "an ended session is no longer current");
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(typeof registry.list()[0].endedAt, "number");
});

test("a relay that reconnects inside the grace window keeps its session alive", () => {
  // The relay reconnects after a broker restart, after its own read timeout drops a wedged stream,
  // and after the machine sleeps. Ending the session on the close would tombstone a working session
  // permanently: `ended` is terminal, and every later lookup skips it, so the operator would get
  // the ended notice while a healthy pipe sat attached.
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const detach = accepted(relays.attach(TOKEN, fakeConnection()));

  detach();
  now += GRACE_MS - 1;
  accepted(relays.attach(TOKEN, fakeConnection()));

  now += GRACE_MS * 10;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "the session was never dead");
  assert.equal(relays.attached(TOKEN), true);
});

test("a second pipe for a token that already holds one is refused, not promoted", () => {
  // Every shell subprocess a session spawns inherits CHANNEL_PROCESS_TOKEN. Promoting a newcomer
  // would hand a malicious postinstall the operator's steering messages and let it answer as
  // Claude, which is a man in the middle of the one channel this design exists to provide.
  const { relays } = harness();
  const first = fakeConnection();
  accepted(relays.attach(TOKEN, first));

  const second = fakeConnection();
  const result = relays.attach(TOKEN, second);
  assert.deepEqual(result, { attached: false, reason: "already attached" });
  assert.equal(first.closed, false, "the pipe already serving the session is left alone");

  relays.deliver(TOKEN, { type: "message", chatId: "9", text: "steer" });
  assert.deepEqual(
    second.sent,
    [],
    "the impostor receives nothing, not even after the refusal",
  );
  assert.ok(first.sent.some((event) => event.type === "message"));
});

test("only the pipe holding the token can reply", () => {
  const { relays } = harness();
  const connection = fakeConnection();
  accepted(relays.attach(TOKEN, connection));

  const hello = connection.sent[0];
  assert.equal(hello.type, "hello", "the first line of a stream carries the reply key");
  const key = (hello as { type: "hello"; replyKey: string }).replyKey;

  assert.equal(relays.holdsPipe(TOKEN, key), true);
  assert.equal(relays.holdsPipe(TOKEN, "guessed"), false, "knowing the token is not enough");
  assert.equal(relays.holdsPipe("another-token", key), false);
});

test("a reply key stops working the moment its pipe goes", () => {
  const { relays } = harness();
  const connection = fakeConnection();
  const detach = accepted(relays.attach(TOKEN, connection));
  const key = (connection.sent[0] as { replyKey: string }).replyKey;

  detach();
  assert.equal(relays.holdsPipe(TOKEN, key), false);

  const replacement = fakeConnection();
  accepted(relays.attach(TOKEN, replacement));
  const reissued = (replacement.sent[0] as { replyKey: string }).replyKey;
  assert.notEqual(reissued, key, "each attachment gets its own key");
  assert.equal(relays.holdsPipe(TOKEN, key), false, "the old key is not honored after a reconnect");
});

test("the hub refuses to hold more pipes than its ceiling", () => {
  const { relays } = harness();
  let refusals = 0;
  for (let index = 0; index < 200; index += 1) {
    const result = relays.attach(`token-${String(index)}`, fakeConnection());
    if (!result.attached) refusals += 1;
  }
  assert.ok(refusals > 0, "an unbounded map of pipes is a local process away from a leak");
});

test("a message is delivered to the pipe holding the session's process token", () => {
  const { relays } = harness();
  const connection = fakeConnection();
  accepted(relays.attach(TOKEN, connection));

  assert.equal(relays.deliver(TOKEN, { type: "message", chatId: "9", text: "hello" }), true);
  assert.deepEqual(connection.sent.slice(1), [{ type: "message", chatId: "9", text: "hello" }]);
  assert.equal(relays.deliver("some-other-token", { type: "ping" }), false);
});

test("a pipe that will not take a write is treated as closed", () => {
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const connection = fakeConnection();
  accepted(relays.attach(TOKEN, connection));

  connection.dead = true;
  assert.equal(relays.deliver(TOKEN, { type: "ping" }), false);
  assert.equal(relays.attached(TOKEN), false);

  now += GRACE_MS + 1;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "ended");
});

test("the heartbeat holds a live session out of the staleness sweep", () => {
  let now = 1_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 5_000, now: () => now });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: GRACE_MS, now: () => now });
  accepted(relays.attach(TOKEN, fakeConnection()));

  // Well past the staleness window with no hook traffic at all: only the relay says it is alive.
  now = 100_000;
  relays.heartbeat();
  assert.deepEqual(registry.sweep(), [], "a session with a live relay is not stale");
  assert.equal(registry.list()[0].state, "live");
});

test("the heartbeat persists a revival and nothing else", () => {
  // The registry snapshot is rewritten whole and synchronously on every mutation, and this runs for
  // every attached relay on every heartbeat. Persisting a timestamp each time would be thousands of
  // full rewrites a day recording something a restart invalidates anyway; a revival is a real state
  // change and has to survive one.
  let now = 1_000;
  let writes = 0;
  const registry = createRegistry({
    host: "NEO",
    staleAfterMs: 5_000,
    now: () => now,
    onMutate: () => {
      writes += 1;
    },
  });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: GRACE_MS, now: () => now });
  accepted(relays.attach(TOKEN, fakeConnection()));

  now = 100_000;
  assert.equal(registry.sweep()[0].state, "stale");
  writes = 0;

  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live");
  assert.equal(writes, 1, "a session brought back from stale must reach the snapshot");

  now = 101_000;
  relays.heartbeat();
  assert.equal(writes, 1, "a heartbeat against an already-live session writes nothing");
  assert.equal(registry.list()[0].lastRelayAt, 101_000, "liveness is still tracked in memory");
});

test("closing every pipe for a broker shutdown ends no session", () => {
  // The broker is restarted by its scheduled task. A restart that ended every session it was
  // watching would
  // report a fleet of deaths that did not happen.
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const connection = fakeConnection();
  const detach = accepted(relays.attach(TOKEN, connection));
  // A socket can report its own close from inside the call that closes it, so this drives the case
  // the hub has to survive: the close handler running while closeAll is still in its loop.
  connection.onClose = detach;

  relays.closeAll();
  assert.equal(connection.closed, true);

  detach();
  now += GRACE_MS * 10;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "a broker shutdown is not a session death");
});

test("a clear moves the session under the same pipe", () => {
  // A channel is a child of the process, not the session, so a /clear leaves the pipe untouched.
  // The hub must therefore never be keyed by session.
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const connection = fakeConnection();
  const detach = accepted(relays.attach(TOKEN, connection));

  announce(registry, "session-b", TOKEN, "clear");
  assert.equal(registry.current(TOKEN)?.sessionId, "session-b");
  assert.equal(relays.deliver(TOKEN, { type: "message", chatId: "9", text: "hi" }), true);

  detach();
  now += GRACE_MS + 1;
  relays.heartbeat();
  const [first, second] = registry.list();
  assert.equal(first.state, "ended", "the superseded session was already ended");
  assert.equal(second.state, "ended", "the pipe closing ended the current session");
});

test("a pending end names the session it was watching, not whatever the token holds later", () => {
  // A /clear inside the grace window moves the token to a new session. Ending "whatever this token
  // holds now" would kill the replacement on the strength of the predecessor's pipe closing.
  let now = 1_000;
  const { registry, relays } = harness({ now: () => now });
  const detach = accepted(relays.attach(TOKEN, fakeConnection()));

  detach();
  announce(registry, "session-b", TOKEN, "clear");
  now += GRACE_MS + 1;
  relays.heartbeat();

  const [first, second] = registry.list();
  assert.equal(first.sessionId, "session-a");
  assert.equal(first.state, "ended", "supersession had already ended the first session");
  assert.equal(second.sessionId, "session-b");
  assert.equal(second.state, "live", "the replacement outlived its predecessor's pipe");
});

/**
 * A broker that has just restarted: its registry restored from a snapshot holding one record for
 * session-a under TOKEN, and a hub built over it that holds no pipe, since none survives a restart.
 */
function restarted(options: {
  now: () => number;
  state?: SessionRecord["state"];
  lastRelayAt?: number | null;
  endedAt?: number | null;
  graceMs?: number;
  log?: (message: string) => void;
}) {
  const saved = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: options.now });
  announce(saved, "session-a");
  const record: SessionRecord = {
    ...saved.list()[0],
    state: options.state ?? "live",
    lastRelayAt: options.lastRelayAt === undefined ? 500 : options.lastRelayAt,
    endedAt: options.endedAt ?? null,
  };
  const registry = createRegistry({
    host: "NEO",
    staleAfterMs: 60_000,
    now: options.now,
    sessions: [record],
  });
  const relays = createRelayHub({
    registry,
    graceMs: options.graceMs ?? GRACE_MS,
    now: options.now,
    log: options.log,
  });
  return { registry, relays };
}

test("a relay that returns inside the restart window keeps its session, past the ordinary one", () => {
  // The expensive direction. A relay that was backing off against a down broker retries on its
  // reconnect ceiling, which is longer than one heartbeat, and a living session ended here is
  // ended for good: `ended` is terminal and a re-attach skips ended records.
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  now += GRACE_MS + 1;
  relays.heartbeat();
  assert.equal(
    registry.list()[0].state,
    "live",
    "past the ordinary window and inside the restart one, the session is still owed its relay",
  );

  accepted(relays.attach(TOKEN, fakeConnection()));
  assert.equal(registry.list()[0].state, "live");

  now += RELAY_RESTART_GRACE_MS * 10;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "the relay came back, so nothing died");
  assert.equal(registry.list()[0].endedAt, null);
});

test("a session whose relay does not return after a restart is ended when the window closes", () => {
  let now = 1_000;
  const lines: string[] = [];
  const { registry, relays } = restarted({ now: () => now, log: (line) => lines.push(line) });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);
  assert.ok(
    lines.some((line) => line.includes("session-a")),
    "the seeded window is logged by session ID",
  );

  now += RELAY_RESTART_GRACE_MS - 1;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "still inside the restart window");

  now += 2;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(registry.list()[0].endedAt, now);
});

test("a session restored stale is ended the same way when its relay does not return", () => {
  // A second restart soon after the first restores the same dead session as stale, and it held a
  // pipe exactly as a live one did.
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now, state: "stale" });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  now += RELAY_RESTART_GRACE_MS + 1;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(registry.list()[0].endedAt, now);
});

test("no restart window runs before the listener binds", () => {
  // The hub is built and its heartbeat started long before the broker binds its port, with a
  // Discord login in between. A window running down then would end sessions no relay could reach.
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now });

  for (const at of [GRACE_MS + 1, RELAY_RESTART_GRACE_MS + 1, RELAY_RESTART_GRACE_MS * 100]) {
    now = 1_000 + at;
    relays.heartbeat();
    assert.equal(registry.list()[0].state, "live", `a heartbeat ${String(at)}ms in ends nothing`);
  }
});

test("a restored session no relay ever attached to is left to the sweep", () => {
  // A null `lastRelayAt` means the record never held a pipe, so no window is opened for it.
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now, lastRelayAt: null });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  for (const at of [RELAY_RESTART_GRACE_MS + 1, RELAY_RESTART_GRACE_MS * 100]) {
    now = 1_000 + at;
    relays.heartbeat();
    assert.equal(registry.list()[0].state, "live");
    assert.equal(registry.list()[0].endedAt, null);
  }
});

test("a restored ended session is left exactly as it was", () => {
  let now = 1_000;
  const lines: string[] = [];
  const { registry, relays } = restarted({
    now: () => now,
    state: "ended",
    endedAt: 700,
    log: (line) => lines.push(line),
  });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);
  assert.deepEqual(lines, [], "an ended session is given no window to report");

  now += RELAY_RESTART_GRACE_MS * 100;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "ended");
  assert.equal(registry.list()[0].endedAt, 700, "ending it again would move its timestamp");
});

test("closing every pipe for a shutdown clears the restart windows too", () => {
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  relays.closeAll();
  now += RELAY_RESTART_GRACE_MS * 10;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live", "a broker shutdown is not a session death");
});

test("a second call does not reopen the restart windows later", () => {
  let now = 1_000;
  const { registry, relays } = restarted({ now: () => now });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  now += RELAY_RESTART_GRACE_MS / 2;
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  // Measured from the first call. A window reopened by the second would still be running here.
  now = 1_000 + RELAY_RESTART_GRACE_MS;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "ended");
});

test("a token already holding a pipe when the windows open gets no window", () => {
  let now = 1_000;
  const lines: string[] = [];
  const { registry, relays } = restarted({ now: () => now, log: (line) => lines.push(line) });
  accepted(relays.attach(TOKEN, fakeConnection()));
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);
  assert.deepEqual(
    lines.filter((line) => line.includes("session-a")),
    [],
    "a relay already back is not reported as missing",
  );

  now += RELAY_RESTART_GRACE_MS * 10;
  relays.heartbeat();
  assert.equal(registry.list()[0].state, "live");
});

test("a relay that never returns after a restart is ended inside the two minute bound", () => {
  // The Goal's bound, measured from the listener binding: the restart window plus the one heartbeat
  // the reap waits for, which is 105 seconds at the defaults and inside two minutes.
  const heartbeatMs = loadConfig({}).relayHeartbeatMs;
  const bindAt = 1_000;
  let now = bindAt;
  const { registry, relays } = restarted({ now: () => now, graceMs: heartbeatMs });
  relays.openRestartWindows(RELAY_RESTART_GRACE_MS);

  let endedAfter: number | null = null;
  while (now - bindAt < 120_000 && endedAfter === null) {
    now += heartbeatMs;
    relays.heartbeat();
    if (registry.list()[0].state === "ended") endedAfter = now - bindAt;
  }
  assert.notEqual(endedAfter, null, "the session was never ended");
  assert.ok(
    (endedAfter ?? Infinity) <= 105_000,
    `ended ${String(endedAfter)}ms after the bind, past the 105000ms bound`,
  );
  assert.ok(
    (endedAfter ?? 0) >= RELAY_RESTART_GRACE_MS,
    `ended ${String(endedAfter)}ms after the bind, before the restart window closed`,
  );
});
