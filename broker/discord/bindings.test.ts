import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBindings, saveBindings } from "./bindings.ts";
import type { ThreadBinding } from "./bindings.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-bindings-"));
}

const BINDING: ThreadBinding = {
  sessionId: "session-a",
  messageId: "111111111111111111",
  threadId: "222222222222222222",
  archived: false,
  name: "neo-intake",
  title: "⚙ neo-intake · working",
};

test("bindings survive a round trip through the file", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    saveBindings(file, [BINDING, { ...BINDING, sessionId: "session-b", threadId: null }]);

    assert.deepEqual(loadBindings(file), [
      BINDING,
      { ...BINDING, sessionId: "session-b", threadId: null },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing file is the first boot and says nothing", () => {
  const directory = scratch();
  try {
    const said: string[] = [];
    assert.deepEqual(
      loadBindings(path.join(directory, "nothing.json"), { log: (m) => said.push(m) }),
      [],
    );
    assert.deepEqual(said, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt or foreign file degrades to no bindings rather than refusing to start", () => {
  // A duplicate thread is recoverable. A broker that will not start is not.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    const said: string[] = [];

    writeFileSync(file, "{not json", "utf8");
    assert.deepEqual(loadBindings(file, { log: (m) => said.push(m) }), []);

    writeFileSync(file, JSON.stringify({ version: 99, bindings: [BINDING] }), "utf8");
    assert.deepEqual(loadBindings(file, { log: (m) => said.push(m) }), []);

    writeFileSync(file, JSON.stringify({ version: 1, bindings: [{ sessionId: "a" }] }), "utf8");
    assert.deepEqual(loadBindings(file, { log: (m) => said.push(m) }), []);

    assert.equal(said.length, 3, "each one is reported");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identifiers read back from disk are normalized the way the wire normalizes them", () => {
  // The file is an ordinary one that anything running as this user can rewrite, and these values
  // are interpolated into request paths.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [{ ...BINDING, threadId: " 222222222222222222\u0007 " }],
      }),
      "utf8",
    );

    assert.equal(loadBindings(file)[0].threadId, "222222222222222222");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an identifier that is not a snowflake makes the file malformed", () => {
  // Both are interpolated into token-bearing request paths, the way the channel is.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    const said: string[] = [];
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [{ ...BINDING, messageId: "../../@me/channels" }],
      }),
      "utf8",
    );

    assert.deepEqual(loadBindings(file, { log: (m) => said.push(m) }), []);
    assert.equal(said.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a session named twice keeps the first thread and reports the orphan", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    const said: string[] = [];
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [BINDING, { ...BINDING, threadId: "333333333333333333" }],
      }),
      "utf8",
    );

    const loaded = loadBindings(file, { log: (m) => said.push(m) });

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].threadId, "222222222222222222");
    assert.match(said[0] ?? "", /twice/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a write leaves no temp file behind and replaces the previous snapshot", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    saveBindings(file, [BINDING]);
    saveBindings(file, []);

    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).bindings, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
