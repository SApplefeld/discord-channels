import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSurfaceState, toView } from "./state.ts";
import type { SessionView } from "./state.ts";
import type { SessionRecord } from "../registry.ts";

const NOW = 1_000_000;
const IDLE_AFTER_MS = 120_000;
const EXITED_AFTER_MS = 4 * 60 * 60 * 1000;
const WINDOWS = { idleAfterMs: IDLE_AFTER_MS, exitedAfterMs: EXITED_AFTER_MS };

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "session-a",
    name: "neo-intake",
    host: "NEO",
    lastTool: null,
    lastToolInput: null,
    model: null,
    openingModel: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
    turnCount: 0,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    blocked: false,
    lifecycle: "live",
    ...overrides,
  };
}

const AGENT = {
  id: "abca61cde3386c2e7",
  kind: "subagent" as const,
  description: "Sleep 90s then reply DONE",
  agentType: "general-purpose",
  since: NOW - 35 * 60_000,
};

test("a live session splits on how recently a hook arrived", () => {
  assert.equal(deriveSurfaceState(view(), NOW, WINDOWS), "working");
  assert.equal(
    deriveSurfaceState(view({ lastHookAt: NOW - IDLE_AFTER_MS }), NOW, WINDOWS),
    "working",
  );
  assert.equal(
    deriveSurfaceState(view({ lastHookAt: NOW - IDLE_AFTER_MS - 1 }), NOW, WINDOWS),
    "idle",
  );
});

test("a stale session renders idle, because nothing observed it die", () => {
  assert.equal(deriveSurfaceState(view({ lifecycle: "stale" }), NOW, WINDOWS), "idle");
});

test("an ended session renders exited whatever else is true of it", () => {
  const ended = view({ lifecycle: "ended", endedAt: NOW, needsAttention: true });

  assert.equal(deriveSurfaceState(ended, NOW, WINDOWS), "exited");
});

test("a session silent past the backstop is presumed dead", () => {
  // Until the relay exists nothing but a /clear ever marks a record ended, and a hard kill fires
  // no hook, so without this a killed session reads idle forever.
  const silent = view({ lifecycle: "stale", lastHookAt: NOW - EXITED_AFTER_MS });

  assert.equal(deriveSurfaceState(silent, NOW, WINDOWS), "exited");
  assert.equal(
    deriveSurfaceState({ ...silent, lastHookAt: NOW - EXITED_AFTER_MS + 1 }, NOW, WINDOWS),
    "idle",
    "and one that is merely quiet is not",
  );
});

test("only a stale record can reach the backstop", () => {
  // A record the registry still calls live is one something has heard from, which after Section 5
  // includes relay liveness with no hook traffic behind it.
  const quiet = view({ lifecycle: "live", lastHookAt: NOW - 10 * EXITED_AFTER_MS });

  assert.equal(deriveSurfaceState(quiet, NOW, WINDOWS), "idle");
});

test("a session that stopped answering is exited rather than waiting on a person", () => {
  const silent = view({
    lifecycle: "stale",
    needsAttention: true,
    lastHookAt: NOW - EXITED_AFTER_MS,
  });

  assert.equal(deriveSurfaceState(silent, NOW, WINDOWS), "exited");
});

test("attention outranks working and idle", () => {
  // Nothing sets this yet; the permission relay is what feeds it. The mapping is in place so that
  // feeding it is the whole change.
  const waiting = view({ needsAttention: true, lastHookAt: NOW - 10 * IDLE_AFTER_MS });

  assert.equal(deriveSurfaceState(waiting, NOW, WINDOWS), "needs you");
  assert.equal(
    deriveSurfaceState(view({ needsAttention: true, lifecycle: "stale" }), NOW, WINDOWS),
    "needs you",
  );
});

test("a session waiting on agents is working, however long its hooks have been silent", () => {
  // The defect this case exists for: a main thread blocked on dispatched agents fires no hooks, so
  // hook recency alone calls the session idle at the moment it is most heavily worked.
  const waiting = view({ backgroundTasks: [AGENT], lastHookAt: NOW - 10 * IDLE_AFTER_MS });

  assert.equal(deriveSurfaceState(waiting, NOW, WINDOWS), "working");
  assert.equal(
    deriveSurfaceState({ ...waiting, lifecycle: "stale" }, NOW, WINDOWS),
    "working",
    "and a roster outranks the staleness sweep, which measures the same silence",
  );
  assert.equal(
    deriveSurfaceState({ ...waiting, backgroundTasks: [] }, NOW, WINDOWS),
    "idle",
    "while the same session waiting on nothing is idle exactly as before",
  );
});

test("a blocked run outranks the roster and both live states", () => {
  // A run stopped on the operator is waiting on a person, and hook recency measures nothing about
  // a session that has deliberately stopped.
  const halted = view({ blocked: true });

  assert.equal(deriveSurfaceState(halted, NOW, WINDOWS), "blocked");
  assert.equal(
    deriveSurfaceState({ ...halted, backgroundTasks: [AGENT] }, NOW, WINDOWS),
    "blocked",
    "and an outstanding roster does not talk it out of it",
  );
  assert.equal(
    deriveSurfaceState({ ...halted, lastHookAt: NOW - 10 * IDLE_AFTER_MS }, NOW, WINDOWS),
    "blocked",
    "nor does the silence that would otherwise read idle",
  );
  assert.equal(
    deriveSurfaceState({ ...halted, lifecycle: "stale" }, NOW, WINDOWS),
    "blocked",
    "nor the staleness sweep, which measures the same silence",
  );
});

test("a block does not outrank a person or a death", () => {
  const halted = view({ blocked: true });

  assert.equal(
    deriveSurfaceState({ ...halted, needsAttention: true }, NOW, WINDOWS),
    "needs you",
    "the ordering is nominal, since a stopped run holds no permission prompt open",
  );
  assert.equal(
    deriveSurfaceState({ ...halted, lifecycle: "ended", endedAt: NOW }, NOW, WINDOWS),
    "exited",
  );
  assert.equal(
    deriveSurfaceState(
      { ...halted, lifecycle: "stale", lastHookAt: NOW - EXITED_AFTER_MS },
      NOW,
      WINDOWS,
    ),
    "exited",
    "and the silence backstop reaches it too: a session that stopped answering stopped waiting",
  );
});

test("a roster does not outrank a person or a death", () => {
  const waiting = view({ backgroundTasks: [AGENT], lastHookAt: NOW - EXITED_AFTER_MS });

  assert.equal(
    deriveSurfaceState({ ...waiting, needsAttention: true, lifecycle: "live" }, NOW, WINDOWS),
    "needs you",
  );
  assert.equal(deriveSurfaceState({ ...waiting, lifecycle: "ended" }, NOW, WINDOWS), "exited");
  assert.equal(deriveSurfaceState({ ...waiting, lifecycle: "stale" }, NOW, WINDOWS), "exited");
});

const RECORD: SessionRecord = {
  sessionId: "session-a",
  processToken: "token",
  name: "neo-intake",
  host: "NEO",
  source: "startup",
  state: "live",
  lastTool: "Bash",
  lastToolInput: "npm test",
  toolCount: 1,
  turnCount: 0,
  startedAt: NOW,
  lastHookAt: NOW,
  lastEngagementAt: NOW,
  lastRelayAt: null,
  endedAt: null,
  openingModel: null,
  model: null,
  contextTokens: null,
  downgrade: null,
  backgroundTasks: [],
  goal: null,
};

test("a view starts without attention or a block until something reports one", () => {
  const narrowed = toView(RECORD);

  assert.equal(narrowed.needsAttention, false);
  assert.equal(narrowed.blocked, false);
  assert.equal(narrowed.lifecycle, "live");
  assert.equal(narrowed.lastTool, "Bash");
  // The tool line's two halves are surfaced together, so a preview cannot arrive at the card
  // without the tool name it belongs to.
  assert.equal(narrowed.lastToolInput, "npm test");
});

test("the two signals waiting on a person are threaded onto the view independently", () => {
  // Both arrive from outside the record: attention from the permission relay, the block from the
  // kit event stream, so each is passed rather than read off the session.
  const attending = toView(RECORD, { needsAttention: true });
  const halted = toView(RECORD, { blocked: true });

  assert.deepEqual(
    { attention: attending.needsAttention, blocked: attending.blocked },
    { attention: true, blocked: false },
  );
  assert.deepEqual(
    { attention: halted.needsAttention, blocked: halted.blocked },
    { attention: false, blocked: true },
  );
});
