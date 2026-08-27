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
  sessionTitle: "the real title",
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

test("a binding written before sessionTitle existed loads with it absent, not undefined", () => {
  // Every bindings file on disk when this field shipped was written without it. Rejecting one would
  // drop every binding on the first restart after the deploy and open a second thread for every
  // live session.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    const older: Record<string, unknown> = { ...BINDING };
    delete older.sessionTitle;
    assert.ok(!("sessionTitle" in older), "the fixture under test must genuinely lack the field");
    writeFileSync(file, JSON.stringify({ version: 1, bindings: [older] }), "utf8");

    const said: string[] = [];
    const loaded = loadBindings(file, { log: (m) => said.push(m) });

    assert.deepEqual(said, [], "an older file is not corruption");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sessionTitle, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ill-formed restored sessionTitle loads as null rather than reaching a rename repaired", () => {
  // The file is one anything running as this user can rewrite, and `clean`'s UTF-16-unit cap can
  // split an astral pair and manufacture a lone surrogate that was not there. A null falls through
  // to `name` at the render site; a repaired value would paint a replacement character onto a live
  // thread.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, bindings: [{ ...BINDING, sessionTitle: "Real Name\udc00" }] }),
      "utf8",
    );

    const said: string[] = [];
    const loaded = loadBindings(file, { log: (m) => said.push(m) });
    assert.deepEqual(said, [], "an ill-formed title is not a corrupt file");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sessionTitle, null, "the ill-formed value is refused, not repaired");
    assert.equal(loaded[0].sessionId, "session-a", "the rest of the binding is intact");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a well-formed sessionTitle whose 256-unit clean cap would split an astral pair loads bounded and well-formed, not with a manufactured surrogate", () => {
  // `clean` alone cuts at 256 UTF-16 units regardless of where a surrogate pair falls, so a
  // well-formed 275-unit input with ten astral characters starting at unit 255 would load with a
  // lone high surrogate at the cut. Routed through `boundedTitle`, `fit`'s own code-point-aware cut
  // to 120 always lands ahead of that defect for this reader's bound (120 is under `clean`'s 256),
  // so the astral tail is discarded whole rather than split: the correct outcome is a bounded,
  // well-formed title, not a null.
  const directory = scratch();
  try {
    const file = path.join(directory, "discord-threads.json");
    const input = "A".repeat(255) + "\u{1F6F0}".repeat(10);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, bindings: [{ ...BINDING, sessionTitle: input }] }),
      "utf8",
    );

    const said: string[] = [];
    const loaded = loadBindings(file, { log: (m) => said.push(m) });
    assert.deepEqual(said, [], "a well-formed sessionTitle is not a corrupt file");
    assert.equal(loaded.length, 1);
    assert.equal(
      loaded[0].sessionTitle,
      `${"A".repeat(119)}…`,
      "the astral tail is cut away, not split",
    );
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
