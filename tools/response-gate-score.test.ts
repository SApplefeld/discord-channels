// The scoring tool over its fixture, counted by hand below, and one real run of the entry point,
// since the type-stripped `node tools/...` invocation is the boundary an operator drives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THRESHOLDS, readJournal, readLabels, render, score } from "./response-gate-score.ts";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TOOLS, "fixtures", "response-gate");
const JOURNAL = path.join(FIXTURES, "journal.jsonl");
const LABELS = path.join(FIXTURES, "labels.tsv");

// The hand count over tools/fixtures/response-gate. The journal's judged rows that carry a label:
//
//   id  probability  label      notes
//   1   0.95         yes
//   2   0.80         yes
//   3   0.65         no
//   4   0.60         yes
//   5   0.45         no
//   6   0.40         yes
//   7   0.20         no
//   8   0.30         no         judged twice (0.90, then 0.30); the last row wins
//
// Skipped: id 9 (a mention, no probability), id 10 (judged, unlabelled), id 11 (labelled, never
// judged), and a torn line. So 8 cases, 4 of them yes (1, 2, 4, 6).
//
//   threshold  predicted (p >= t)     hits       precision  recall
//   0.40       1 2 3 4 5 6 (6)        1 2 4 6    4/6        4/4
//   0.45       1 2 3 4 5   (5)        1 2 4      3/5        3/4
//   0.50       1 2 3 4     (4)        1 2 4      3/4        3/4
//   0.55       1 2 3 4     (4)        1 2 4      3/4        3/4
//   0.60       1 2 3 4     (4)        1 2 4      3/4        3/4
//   0.65       1 2 3       (3)        1 2        2/3        2/4
//   0.70       1 2         (2)        1 2        2/2        2/4
//   0.75       1 2         (2)        1 2        2/2        2/4
//   0.80       1 2         (2)        1 2        2/2        2/4
//   0.85       1           (1)        1          1/1        1/4
//   0.90       1           (1)        1          1/1        1/4
//   0.95       1           (1)        1          1/1        1/4
const HAND_COUNT: ReadonlyArray<[number, number, number]> = [
  [0.4, 4 / 6, 1],
  [0.45, 3 / 5, 3 / 4],
  [0.5, 3 / 4, 3 / 4],
  [0.55, 3 / 4, 3 / 4],
  [0.6, 3 / 4, 3 / 4],
  [0.65, 2 / 3, 2 / 4],
  [0.7, 1, 2 / 4],
  [0.75, 1, 2 / 4],
  [0.8, 1, 2 / 4],
  [0.85, 1, 1 / 4],
  [0.9, 1, 1 / 4],
  [0.95, 1, 1 / 4],
];

test("the thresholds run from 0.40 to 0.95 in steps of 0.05, the last one included", () => {
  assert.deepEqual(THRESHOLDS, [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);
});

test("the journal reader keeps the last judged row per id and skips rows with no probability and torn lines", () => {
  const journal = readJournal(readFileSync(JOURNAL, "utf8"));
  assert.deepEqual(
    [...journal].sort(([a], [b]) => Number(a) - Number(b)),
    [["1", 0.95], ["2", 0.8], ["3", 0.65], ["4", 0.6], ["5", 0.45], ["6", 0.4], ["7", 0.2], ["8", 0.3], ["10", 0.7]],
  );
});

test("the labels reader takes <id><tab><yes|no> lines, skips blank ones, and refuses any other by its line number", () => {
  const labels = readLabels(readFileSync(LABELS, "utf8"));
  assert.equal(labels.size, 10);
  assert.equal(labels.get("1"), true);
  assert.equal(labels.get("8"), false);
  assert.equal(readLabels("42\tYES\n").get("42"), true, "case does not matter");
  assert.deepEqual([...readLabels("1\tyes\r\n2\tno\r\n")], [["1", true], ["2", false]], "a CRLF file reads the same");
  assert.throws(() => readLabels("1\tyes\n2 no\n"), /labels line 2/);
  assert.throws(() => readLabels("1\tmaybe\n"), /labels line 1/);
});

test("the table over the fixture is the hand count", () => {
  const scores = score(readJournal(readFileSync(JOURNAL, "utf8")), readLabels(readFileSync(LABELS, "utf8")));
  assert.deepEqual(
    scores.map((row) => [row.threshold, row.precision, row.recall]),
    HAND_COUNT,
  );
});

test("a threshold predicting no positives prints n/a for precision, and labels with no yes print n/a for recall", () => {
  const low = new Map([["1", 0.3], ["2", 0.2]]);
  const noYes = score(low, new Map([["1", false], ["2", false]]));
  for (const row of noYes) {
    assert.equal(row.precision, null, String(row.threshold));
    assert.equal(row.recall, null, String(row.threshold));
  }
  const oneYes = score(new Map([["1", 0.5]]), new Map([["1", true]]));
  assert.deepEqual(oneYes[0], { threshold: 0.4, precision: 1, recall: 1 });
  assert.deepEqual(oneYes[3], { threshold: 0.55, precision: null, recall: 0 });
  assert.match(render(low, new Map([["1", false]])), /0\.40\s+n\/a\s+n\/a/);
});

/** One run of the tool as an operator runs it. */
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(TOOLS, "response-gate-score.ts"), ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.signal, null, "the run ended on its own, not on the timeout");
  return result;
}

test("run directly under the type stripping, the tool prints the table for the fixture", () => {
  const result = run(JOURNAL, LABELS);
  assert.equal(result.status, 0, result.stderr);
  const expected = render(readJournal(readFileSync(JOURNAL, "utf8")), readLabels(readFileSync(LABELS, "utf8")));
  assert.equal(result.stdout, expected);
  assert.match(result.stdout, /^labelled judged rows: 8 \(yes 4, no 4\)\n/);
  assert.match(result.stdout, /\n0\.40\s+0\.667\s+1\.000\n/);
  assert.match(result.stdout, /\n0\.95\s+1\.000\s+0\.250\n$/);
});

test("a missing journal or labels file, or a malformed labels line, is one line on stderr and a non-zero exit, never a stack", () => {
  const missing = path.join(FIXTURES, "absent.jsonl");
  const result = run(missing, LABELS);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
  assert.ok(result.stderr.includes("cannot read") && result.stderr.includes("absent.jsonl"), result.stderr);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "no stack frame");

  const bad = run(JOURNAL, path.join(TOOLS, "response-gate-score.ts"));
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim().split("\n").length, 1, bad.stderr);
  assert.match(bad.stderr, /labels line 1/);
});
