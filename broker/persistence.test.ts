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
    toolCount: 3,
    turnCount: 1,
    startedAt: 1_000,
    lastHookAt: 2_000,
    lastRelayAt: null,
    endedAt: null,
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
    });
    first.apply({
      event: "PostToolUse",
      processToken: "token-1",
      sessionName: null,
      sessionId: null,
      source: null,
      toolName: "Bash",
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

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.sessions.length, 1, "the snapshot on disk holds the one session");
  } finally {
    cleanup();
  }
});
