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

/** A reader that delegates to the real `readSync` but returns at most `most` bytes per call. */
function shortReader(most: number): CappedReader {
  return (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, Math.min(length, most), position);
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
  // the real one but hands back at most five bytes per call, so the ten-byte file arrives in two
  // chunks and the loop must take a second pass to read it whole.
  const read = readCappedFile(held.file, 64, shortReader(5));
  assert.deepEqual(read, { text: "0123456789" });
});

test("a file of exactly the cap reads whole, and one byte more is oversized", (t) => {
  const exact = scratchFile("01234");
  t.after(exact.cleanup);
  const over = scratchFile("012345");
  t.after(over.cleanup);

  assert.deepEqual(readCappedFile(exact.file, 5), { text: "01234" });
  assert.deepEqual(readCappedFile(over.file, 5), { failed: "oversized" });
});

test("a file over the cap is refused as oversized when it arrives in short reads", (t) => {
  const held = scratchFile("0123456789");
  t.after(held.cleanup);

  assert.deepEqual(readCappedFile(held.file, 5, shortReader(2)), { failed: "oversized" });
});

test("an unopenable file reads as unreadable", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-capped-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, "does-not-exist.txt");

  const read = readCappedFile(missing, 64);
  assert.deepEqual(read, { failed: "unreadable" });
});
