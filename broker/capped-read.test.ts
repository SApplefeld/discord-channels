import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCappedFile } from "./capped-read.ts";
import type { CappedReader } from "./capped-read.ts";

/** A scratch file under a fresh temp directory per test, so no two tests share a path. */
function scratchFile(text: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-capped-read-"));
  const file = path.join(dir, "content.txt");
  writeFileSync(file, text, "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a file under the cap reads whole", (t) => {
  const held = scratchFile("hello world");
  t.after(held.cleanup);

  const read = readCappedFile(held.file, 64);
  assert.deepEqual(read, { text: "hello world" });
});

test("a file over the cap is refused as oversized", (t) => {
  const held = scratchFile("0123456789");
  t.after(held.cleanup);

  const read = readCappedFile(held.file, 5);
  assert.deepEqual(read, { failed: "oversized" });
});

test("a file delivered in two short reads reads whole", (t) => {
  const held = scratchFile("0123456789");
  t.after(held.cleanup);

  // A real `readSync` short read cannot be provoked on disk on demand, so this reader delegates to
  // the real one but hands back at most three bytes per call, forcing the loop to take more than
  // one pass to fill a ten-byte file.
  const twoChunkReader: CappedReader = (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, Math.min(length, 3), position);

  const read = readCappedFile(held.file, 64, twoChunkReader);
  assert.deepEqual(read, { text: "0123456789" });
});

test("an unopenable file reads as unreadable", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-capped-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, "does-not-exist.txt");

  const read = readCappedFile(missing, 64);
  assert.deepEqual(read, { failed: "unreadable" });
});
