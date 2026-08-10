import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSessions, saveSessions } from "./persistence.ts";
import type { SessionRecord } from "./registry.ts";
import { createRegistry } from "./registry.ts";

function scratchFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-persistence-"));
  return {
    file: path.join(dir, "broker-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function record(sessionId: string): SessionRecord {
  return {
    sessionId,
    processToken: "token-1",
    name: "neo-intake",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    lastToolInput: "npm test",
    toolCount: 3,
    turnCount: 1,
    startedAt: 1_000,
    lastHookAt: 2_000,
    lastRelayAt: null,
    endedAt: null,
    openingModel: null,
    model: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
  };
}

test("a snapshot round-trips, including over an existing file", () => {
  const { file, cleanup } = scratchFile();
  try {
    saveSessions(file, [record("session-a")]);
    // The second save is the one that exercises renaming over an existing target.
    saveSessions(file, [record("session-a"), record("session-b")]);

    const loaded = loadSessions(file, { log: () => {} });
    assert.deepEqual(loaded, [record("session-a"), record("session-b")]);
  } finally {
    cleanup();
  }
});

test("a missing state file is a silent empty registry", () => {
  const { file, cleanup } = scratchFile();
  try {
    const logged: string[] = [];
    assert.deepEqual(loadSessions(file, { log: (message) => logged.push(message) }), []);
    assert.deepEqual(logged, [], "a first boot has nothing to report");
  } finally {
    cleanup();
  }
});

test("unparseable bytes degrade to an empty registry and log", () => {
  const { file, cleanup } = scratchFile();
  try {
    writeFileSync(file, "{ this is not json", "utf8");
    const logged: string[] = [];
    assert.deepEqual(loadSessions(file, { log: (message) => logged.push(message) }), []);
    assert.equal(logged.length, 1);
  } finally {
    cleanup();
  }
});

test("valid JSON of the wrong shape degrades to an empty registry", () => {
  // The failure that a JSON.parse guard alone misses: the file parses and then crashes whatever
  // reads it.
  for (const contents of ["null", "[]", '"a string"', '{"sessions":"not an array"}']) {
    const { file, cleanup } = scratchFile();
    try {
      writeFileSync(file, contents, "utf8");
      const logged: string[] = [];
      assert.deepEqual(
        loadSessions(file, { log: (message) => logged.push(message) }),
        [],
        `contents: ${contents}`,
      );
      assert.equal(logged.length, 1, `contents: ${contents}`);
    } finally {
      cleanup();
    }
  }
});

test("a snapshot from an unknown format version degrades to empty", () => {
  const { file, cleanup } = scratchFile();
  try {
    const snapshot = { version: 2, sessions: [record("session-a")] };
    writeFileSync(file, JSON.stringify(snapshot), "utf8");
    const logged: string[] = [];
    assert.deepEqual(loadSessions(file, { log: (message) => logged.push(message) }), []);
    assert.equal(logged.length, 1);
  } finally {
    cleanup();
  }
});

test("a non-finite number in a record is rejected", () => {
  // JSON.parse turns 1e999 into Infinity, and an infinite lastHookAt would survive every sweep.
  const { file, cleanup } = scratchFile();
  try {
    writeFileSync(
      file,
      '{"version":1,"sessions":[' +
        JSON.stringify(record("session-a")).replace('"lastHookAt":2000', '"lastHookAt":1e999') +
        "]}",
      "utf8",
    );
    const logged: string[] = [];
    assert.deepEqual(loadSessions(file, { log: (message) => logged.push(message) }), []);
    assert.equal(logged.length, 1);
  } finally {
    cleanup();
  }
});

test("strings read back from the state file are normalized like wire input", () => {
  // The state file is an ordinary file, so a tampered one must not re-admit what the wire refuses.
  const { file, cleanup } = scratchFile();
  try {
    const tampered = {
      ...record("session-a"),
      name: "neo\u001b[31m-intake",
      lastTool: "B".repeat(400),
    };
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [tampered] }), "utf8");

    const loaded = loadSessions(file, { log: () => {} });

    assert.equal(loaded[0].name, "neo[31m-intake");
    assert.equal(loaded[0].lastTool?.length, 256);
  } finally {
    cleanup();
  }
});

test("a snapshot written without lastToolInput loads with every record intact", () => {
  // Every snapshot on disk when this field shipped was written without it. Rejecting one would
  // empty the registry on the first restart after the upgrade, and every live session would lose
  // the Discord thread it is bound to.
  const { file, cleanup } = scratchFile();
  try {
    const older: Record<string, unknown> = { ...record("session-a") };
    delete older.lastToolInput;
    assert.ok(!("lastToolInput" in older), "the snapshot under test must genuinely lack the field");
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [older] }), "utf8");

    const logged: string[] = [];
    const loaded = loadSessions(file, { log: (message) => logged.push(message) });

    assert.deepEqual(logged, [], "an older snapshot is not corruption");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sessionId, "session-a");
    assert.equal(loaded[0].lastTool, "Bash");
    assert.equal(loaded[0].lastToolInput, null);
  } finally {
    cleanup();
  }
});

test("a malformed record inside a well-formed snapshot degrades to empty", () => {
  const { file, cleanup } = scratchFile();
  try {
    const snapshot = { version: 1, sessions: [record("session-a"), { sessionId: 7 }] };
    writeFileSync(file, JSON.stringify(snapshot), "utf8");
    const logged: string[] = [];
    assert.deepEqual(loadSessions(file, { log: (message) => logged.push(message) }), []);
    assert.equal(logged.length, 1);
  } finally {
    cleanup();
  }
});

test("the registry survives a restart", () => {
  const { file, cleanup } = scratchFile();
  try {
    const first = createRegistry({
      host: "NEO",
      staleAfterMs: 60_000,
      onMutate: (sessions) => saveSessions(file, sessions),
    });
    first.apply({
      event: "SessionStart",
      processToken: "token-1",
      sessionName: "neo-intake",
      sessionId: "session-a",
      source: "startup",
      toolName: null,
      toolInput: null,
      transcriptPath: null,
      backgroundTasks: null,
    });
    first.apply({
      event: "PostToolUse",
      processToken: "token-1",
      sessionName: null,
      sessionId: null,
      source: null,
      toolName: "Bash",
      toolInput: "npm test",
      transcriptPath: null,
      backgroundTasks: null,
    });

    // A fresh process reading the file the previous one left behind.
    const second = createRegistry({
      host: "NEO",
      staleAfterMs: 60_000,
      sessions: loadSessions(file, { log: () => {} }),
    });

    const restored = second.current("token-1");
    assert.ok(restored);
    assert.equal(restored.sessionId, "session-a");
    assert.equal(restored.toolCount, 1);
    assert.equal(restored.lastTool, "Bash");
    assert.equal(restored.lastToolInput, "npm test");

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.sessions.length, 1, "the snapshot on disk holds the one session");
  } finally {
    cleanup();
  }
});

test("a snapshot written before the model fields existed loads with them absent, not undefined", () => {
  // The tolerance `lastToolInput` established: a strict check would empty the whole registry over a
  // field an older build never wrote, and every session in it would lose the thread its record binds.
  const { file, cleanup } = scratchFile();
  try {
    const older = record("session-a") as Partial<SessionRecord>;
    delete older.openingModel;
    delete older.model;
    delete older.contextTokens;
    delete older.downgrade;
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [older] }), "utf8");

    const logged: string[] = [];
    const loaded = loadSessions(file, { log: (message) => logged.push(message) });
    assert.deepEqual(logged, []);
    assert.deepEqual(loaded, [record("session-a")], "absent lands as null, never as undefined");
  } finally {
    cleanup();
  }
});

test("a persisted downgrade survives a restart, and neither the context size nor the goal does", () => {
  // A downgrade is a state that outlives the process: the tailer rebaselines to the transcript's end
  // after a restart and never sees that record again, so an unpersisted opening model would be
  // re-seeded from the fallback and the standing marker would vanish. The context size and the goal
  // are the opposite case, since a figure or a sentence written hours ago would render as what a
  // session is running at right now.
  const { file, cleanup } = scratchFile();
  try {
    const downgraded: SessionRecord = {
      ...record("session-a"),
      openingModel: "claude-fable-5",
      model: "claude-opus-4-8",
      contextTokens: 61_380,
      // Dropped on the same reasoning the context size is, and one the card is built around:
      // whether a goal is still being worked toward is not observable, so one restored from a
      // snapshot would draw as current indefinitely.
      goal: "ship the fidelity round",
      downgrade: {
        cause: "refusal",
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        category: "cyber",
        choice: null,
      },
    };
    saveSessions(file, [downgraded]);

    const loaded = loadSessions(file, { log: () => {} });
    assert.deepEqual(loaded, [{ ...downgraded, contextTokens: null, goal: null }]);
  } finally {
    cleanup();
  }
});

test("a malformed downgrade nulls that field, never the snapshot around it", () => {
  // The tolerance is `lastToolInput`'s, applied at field level: a strict check here would be a
  // whole-snapshot rejection, and one malformed record would empty the registry, costing every
  // session on the host the Discord thread its record binds it to. A downgrade the file cannot
  // vouch for renders as no marker, which every surface already draws.
  const { file, cleanup } = scratchFile();
  try {
    const shapes: unknown[] = [
      { cause: "made-up", originalModel: 4 },
      {},
      "refusal",
      7,
      { cause: "refusal", originalModel: "claude-fable-5" },
    ];
    const records = shapes.map((downgrade, index) => ({
      ...record(`session-${index}`),
      downgrade,
    }));
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [...records, record("session-good")] }),
      "utf8",
    );

    const logged: string[] = [];
    const loaded = loadSessions(file, { log: (message) => logged.push(message) });
    assert.deepEqual(logged, []);
    assert.equal(loaded.length, shapes.length + 1, "every record survives its neighbor's bad field");
    for (const held of loaded) assert.equal(held.downgrade, null);
    assert.deepEqual(loaded[shapes.length], record("session-good"));
  } finally {
    cleanup();
  }
});

test("a roster survives a restart with its first-sighting stamps", () => {
  // The table is authoritative and replaced wholesale at the next Stop, so a persisted roster is
  // bounded rather than accumulating: a stale one shows visibly old ages and self-corrects the
  // moment the session reports again, while dropping it would read a session as idle for the whole
  // remaining fan-out after a mid-fan-out restart, which is the defect the roster exists to fix. A
  // roster whose session never comes back is bounded by the surfaces' own death backstop.
  const { file, cleanup } = scratchFile();
  try {
    const tasks = [
      {
        id: "one",
        kind: "subagent" as const,
        description: "Grooming S6 implementation",
        agentType: "implementer-fable",
        since: 1_000,
      },
      { id: "build", kind: "shell" as const, description: null, agentType: null, since: 2_000 },
    ];
    saveSessions(file, [{ ...record("session-a"), backgroundTasks: tasks }]);

    const loaded = loadSessions(file, { log: () => {} });
    assert.deepEqual(loaded, [{ ...record("session-a"), backgroundTasks: tasks }]);
  } finally {
    cleanup();
  }
});

test("a malformed roster is dropped at field level, and costs its neighbours nothing", () => {
  // The roster answers for itself here rather than in the record validator, where any clause is a
  // whole-snapshot rejection that would cost every session on the host its thread binding.
  const { file, cleanup } = scratchFile();
  try {
    const good = { id: "kept", kind: "subagent", description: null, agentType: null, since: 1_000 };
    const shapes: Array<{ held: unknown; expected: unknown[] }> = [
      { held: "one agent", expected: [] },
      { held: 7, expected: [] },
      { held: null, expected: [] },
      { held: [{ nothing: "recognizable" }], expected: [] },
      // A readable entry survives its malformed neighbours inside the one array.
      {
        held: [
          good,
          { id: "no-stamp", kind: "subagent", description: null, agentType: null, since: "soon" },
          { id: "bad-kind", kind: "process", description: null, agentType: null, since: 1_000 },
          { id: 7, kind: "shell", description: null, agentType: null, since: 1_000 },
        ],
        expected: [good],
      },
    ];
    const records = shapes.map((shape, index) => ({
      ...record(`session-${index}`),
      backgroundTasks: shape.held,
    }));
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [...records, record("session-good")] }),
      "utf8",
    );

    const logged: string[] = [];
    const loaded = loadSessions(file, { log: (message) => logged.push(message) });

    assert.deepEqual(logged, []);
    assert.equal(loaded.length, shapes.length + 1);
    for (const [index, shape] of shapes.entries()) {
      assert.deepEqual(loaded[index].backgroundTasks, shape.expected, `shape ${index}`);
    }
    assert.deepEqual(loaded[shapes.length], record("session-good"));
  } finally {
    cleanup();
  }
});

test("a restored roster is capped at the intake's own entry ceiling", () => {
  // The state file is an ordinary file anything running as this user can rewrite, so a table read
  // back from it is held to the same entry cap the wire is.
  const { file, cleanup } = scratchFile();
  try {
    const oversized = Array.from({ length: 40 }, (_, index) => ({
      id: `task-${index}`,
      kind: "subagent",
      description: null,
      agentType: null,
      since: 1_000,
    }));
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [{ ...record("session-a"), backgroundTasks: oversized }],
      }),
      "utf8",
    );

    const loaded = loadSessions(file, { log: () => {} });
    assert.equal(loaded[0].backgroundTasks.length, 32);
  } finally {
    cleanup();
  }
});
