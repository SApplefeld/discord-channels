import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSurfaceState, toView, typingWanted } from "./state.ts";
import type { SessionView } from "./state.ts";
import { createRegistry } from "../registry.ts";
import type { HookIntake, SessionRecord } from "../registry.ts";

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
    turnActiveAt: null,
    title: null,
    lineage: null,
    turnCount: 0,
    lastHookAt: NOW,
    endedAt: null,
    needsAttention: false,
    blocked: false,
    lifecycle: "live",
    startedAt: NOW,
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

test("a block does not outrank a person or a real end, and is exempt from the backstop", () => {
  const halted = view({ blocked: true });

  assert.equal(
    deriveSurfaceState({ ...halted, needsAttention: true }, NOW, WINDOWS),
    "needs you",
    "the ordering is nominal, since a stopped run holds no permission prompt open",
  );
  assert.equal(
    deriveSurfaceState({ ...halted, lifecycle: "ended", endedAt: NOW }, NOW, WINDOWS),
    "exited",
    "a real end is a real end whatever the run last said",
  );
  assert.equal(
    deriveSurfaceState(
      { ...halted, lifecycle: "stale", lastHookAt: NOW - EXITED_AFTER_MS },
      NOW,
      WINDOWS,
    ),
    "blocked",
    "the silence backstop does not reach it: silence is what blocked looks like, and a run " +
      "blocked overnight must not read as exited (the operator's call, 2026-08-21)",
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
  lineage: null,
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
  turnActiveAt: null,
  title: null,
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

test("a record's title reaches the view unchanged", () => {
  const narrowed = toView({ ...RECORD, title: "renamed by /rename" });
  assert.equal(narrowed.title, "renamed by /rename");
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

/** A registry holding one session announced at `start`, on a clock the test moves by hand. */
function liveRegistry(start: number) {
  let clock = start;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 10 * 60 * 1000, now: () => clock });
  const hook = (event: HookIntake["event"], extra: Partial<HookIntake> = {}): void => {
    registry.apply({
      event,
      processToken: "token",
      sessionName: null,
      lineage: null,
      sessionId: "session-a",
      source: event === "SessionStart" ? "startup" : null,
      toolName: event === "PostToolUse" ? "Bash" : null,
      toolInput: null,
      transcriptPath: null,
      backgroundTasks: null,
      ...extra,
    });
  };
  hook("SessionStart");
  return {
    registry,
    hook,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    wanted: (): boolean => {
      const shown = toView(registry.list()[0] as SessionRecord);
      return typingWanted(shown, deriveSurfaceState(shown, clock, WINDOWS), clock, IDLE_AFTER_MS);
    },
  };
}

test("a credited prompt to a session idle past idleAfterMs wants typing at once", () => {
  // Pins the acceptance line "a message to a session idle past `idleAfterMs` shows typing from its
  // credited prompt": the prompt moves no liveness field, so the session still derives idle, and the
  // gate must not require `working`.
  const session = liveRegistry(NOW);
  session.advance(IDLE_AFTER_MS * 5);
  const before = toView(session.registry.list()[0] as SessionRecord);
  assert.equal(deriveSurfaceState(before, session.now(), WINDOWS), "idle", "the precondition: idle");
  assert.equal(session.wanted(), false);

  session.registry.noteTurnOpened("session-a");

  const after = toView(session.registry.list()[0] as SessionRecord);
  assert.equal(deriveSurfaceState(after, session.now(), WINDOWS), "idle", "still idle by the hook clock");
  assert.equal(session.wanted(), true, "and typing is wanted from the prompt alone");
});

test("a turn that stalls with a roster outstanding stops wanting typing past idleAfterMs", () => {
  // Pins the acceptance line "a turn that stalls or ends without a `Stop` stops typing within
  // `idleAfterMs` of its last activity", in its worst case: a roster outstanding holds the derived
  // state at working for as long as it stands, so only the activity window can end the indicator.
  const session = liveRegistry(NOW);
  session.hook("Stop", {
    backgroundTasks: [{ id: "task-a", kind: "subagent", description: null, agentType: null }],
  });
  session.hook("PostToolUse");
  assert.equal(session.wanted(), true, "a main-thread tool call opens a turn");

  session.advance(IDLE_AFTER_MS);
  assert.equal(session.wanted(), true, "still wanted at exactly idleAfterMs since the last activity");

  session.advance(1);
  const shown = toView(session.registry.list()[0] as SessionRecord);
  assert.equal(deriveSurfaceState(shown, session.now(), WINDOWS), "working", "the roster holds working");
  assert.equal(session.wanted(), false, "but the stalled turn no longer wants typing");
});

test("after a Stop, background agents' tool calls want no typing though the card reads working", () => {
  // Pins the acceptance lines "after a `Stop`, no typing call is sent for that thread, though the
  // card still reads working" and "a session with an outstanding background roster and no open
  // turn shows no typing, including while its background agents make tool calls".
  const session = liveRegistry(NOW);
  session.hook("PostToolUse");
  session.hook("Stop", {
    backgroundTasks: [{ id: "task-a", kind: "subagent", description: null, agentType: null }],
  });
  session.advance(1_000);
  session.hook("PostToolUse", { fromSubagent: true });

  const shown = toView(session.registry.list()[0] as SessionRecord);
  assert.equal(deriveSurfaceState(shown, session.now(), WINDOWS), "working", "the card reads working");
  assert.equal(session.wanted(), false, "no typing is wanted");
});

test("typingWanted excludes a session waiting on a person, blocked, or exited, whatever its turn", () => {
  for (const state of ["needs you", "blocked", "exited"] as const) {
    assert.equal(typingWanted(view({ turnActiveAt: NOW }), state, NOW, IDLE_AFTER_MS), false, state);
  }
  for (const state of ["working", "idle"] as const) {
    assert.equal(typingWanted(view({ turnActiveAt: NOW }), state, NOW, IDLE_AFTER_MS), true, state);
  }
  assert.equal(typingWanted(view({ turnActiveAt: null }), "working", NOW, IDLE_AFTER_MS), false, "no open turn");
});
