import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBoardBinding, saveBoardBinding } from "./binding.ts";
import type { BoardCardBinding } from "./binding.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-board-binding-"));
}

const BINDING: BoardCardBinding = {
  messageId: "111111111111111111",
  threadId: "222222222222222222",
};

test("the board binding survives a round trip through the file", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "board-card.json");
    saveBoardBinding(file, BINDING);
    assert.deepEqual(loadBoardBinding(file), BINDING);

    // The card posted but not yet opened as a thread, which is a state a crash can leave behind.
    saveBoardBinding(file, { ...BINDING, threadId: null });
    assert.deepEqual(loadBoardBinding(file), { ...BINDING, threadId: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing board binding is the first boot and says nothing", () => {
  const directory = scratch();
  try {
    const said: string[] = [];
    assert.equal(
      loadBoardBinding(path.join(directory, "nothing.json"), { log: (m) => said.push(m) }),
      null,
    );
    assert.deepEqual(said, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt or foreign board binding degrades to none rather than refusing to start", () => {
  // A duplicate thread is recoverable. A broker that will not start is not.
  const directory = scratch();
  try {
    const file = path.join(directory, "board-card.json");
    const said: string[] = [];
    const load = (): BoardCardBinding | null => loadBoardBinding(file, { log: (m) => said.push(m) });

    writeFileSync(file, "{not json", "utf8");
    assert.equal(load(), null);

    writeFileSync(file, JSON.stringify({ version: 99, binding: BINDING }), "utf8");
    assert.equal(load(), null);

    writeFileSync(file, JSON.stringify({ version: 1, binding: { messageId: 7 } }), "utf8");
    assert.equal(load(), null);

    assert.equal(said.length, 3, "each refusal says why, so the operator can find the file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a board identifier that is not a snowflake is refused, not interpolated into a path", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "board-card.json");
    const said: string[] = [];

    writeFileSync(
      file,
      JSON.stringify({ version: 1, binding: { messageId: "../../channels/9", threadId: null } }),
      "utf8",
    );
    assert.equal(loadBoardBinding(file, { log: (m) => said.push(m) }), null);
    assert.equal(said.length, 1);

    writeFileSync(
      file,
      JSON.stringify({ version: 1, binding: { messageId: BINDING.messageId, threadId: "nope" } }),
      "utf8",
    );
    assert.equal(loadBoardBinding(file, { log: () => {} }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a padded board identifier is normalized before it is checked", () => {
  const directory = scratch();
  try {
    const file = path.join(directory, "board-card.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        binding: { messageId: ` ${BINDING.messageId} `, threadId: BINDING.threadId },
      }),
      "utf8",
    );
    assert.deepEqual(loadBoardBinding(file, { log: () => {} }), BINDING);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a board binding write leaves one file rather than a temp file beside it", () => {
  // The temp file is named for a fresh UUID on every write, so one left behind accumulates: the
  // directory listing is the only assertion that can see it, since the target itself reads
  // correctly either way.
  const directory = scratch();
  try {
    const nested = path.join(directory, "nested");
    const file = path.join(nested, "board-card.json");
    saveBoardBinding(file, BINDING);
    saveBoardBinding(file, { ...BINDING, threadId: null });

    assert.deepEqual(readdirSync(nested), ["board-card.json"]);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(parsed, { version: 1, binding: { ...BINDING, threadId: null } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a board binding write that fails leaves no temp file behind either", () => {
  // The rename is what cannot be reached: the target path is a directory, so the write lands and
  // the rename over it refuses, which is the one ordering that can strand a temp file.
  const directory = scratch();
  try {
    const file = path.join(directory, "board-card.json");
    mkdirSync(file);

    assert.throws(() => saveBoardBinding(file, BINDING));
    assert.deepEqual(readdirSync(directory), ["board-card.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
