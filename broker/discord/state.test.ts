import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSurfaceState, toView } from "./state.ts";
import type { SessionView } from "./state.ts";

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
    turnCount: 0,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    lifecycle: "live",
    ...overrides,
  };
}

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
  // no hook, so without this a killed session shows the success glyph forever.
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

test("a view starts without attention until something reports it", () => {
  const narrowed = toView({
    sessionId: "session-a",
    processToken: "token",
    name: "neo-intake",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    toolCount: 1,
    turnCount: 0,
    startedAt: NOW,
    lastHookAt: NOW,
    lastRelayAt: null,
    endedAt: null,
  });

  assert.equal(narrowed.needsAttention, false);
  assert.equal(narrowed.lifecycle, "live");
  assert.equal(narrowed.lastTool, "Bash");
});
