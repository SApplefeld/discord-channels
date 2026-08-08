// The similarity sketch, driven on realistic prose rather than toy strings.
//
// The threshold is the feature, so what these tests pin hardest is where it falls on text of the
// shape it will actually see: a paragraph of a session's close-out, its lightly reworded twin as
// the Stop mirror would phrase it, and a short summary of it. Toy fixtures ("cat sat on the mat"
// against "cat sat on a mat") would pass under any threshold at all and prove nothing about the
// one chosen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEAR_MATCH_THRESHOLD,
  SHINGLE_WORDS,
  SKETCH_SIZE,
  normalizeForSketch,
  sketchOf,
  similarity,
} from "./similarity.ts";

/** A close-out paragraph of the length and register a real reply and a real mirror carry. */
const PARAGRAPH = [
  "The installer now writes the broker's environment file before it registers the scheduled task,",
  "so a task that starts immediately finds the port and the token already in place. Previously the",
  "registration ran first and the very first start raced the file write, which showed up as a",
  "broker that came up once with no host name and had to be restarted by hand. The readiness wait",
  "polls the sessions endpoint rather than sleeping for a fixed interval, so a slow machine is",
  "waited out instead of being called a failure, and a genuinely broken start is reported within",
  "thirty seconds rather than after an arbitrary pause. The repair script itself kills only what it",
  "can prove is this repo's broker: a command line naming the entry point, or a process holding the",
  "configured port in LISTEN, and never a process merely named node.",
].join(" ");

/** The same paragraph as the mirror phrases it: two dropped words, one word swapped. */
const LIGHT_REWORDING = PARAGRAPH.replace(
  "finds the port and the token already in place",
  "finds the port and token already in place",
).replace("never a process merely named node", "never a process just named node");

/** The same paragraph rewritten clause by clause, saying the same things in different words. */
const HEAVY_REWORDING = PARAGRAPH.replace(
  "before it registers the scheduled task",
  "before registering the scheduled task",
)
  .replace("Previously the registration ran first", "Previously registration ran first")
  .replace("came up once with no host name", "came up once without a host name")
  .replace("a genuinely broken start is reported", "a genuinely broken start gets reported")
  .replace("kills only what it can prove is", "kills only what it proves to be");

/** Two lines saying what the paragraph said, in the reply tool's shorter register. */
const SUMMARY = [
  "The environment file is written before the task registers, so the first start no longer races.",
  "Readiness is polled, and the repair pass kills only processes it can prove are ours.",
].join(" ");

/** Same subject matter, different content: what a mirror carrying new material looks like. */
const DIFFERENT_TEXT = [
  "Discord rejects a message over two thousand characters, so a long reply is cut into parts on",
  "paragraph boundaries where it can be and mid-word where it cannot. Each part carries its own",
  "index in the header, and the parts post in order behind one await per thread so a slow first",
  "part cannot arrive after the second.",
].join(" ");

test("identical text is a full match", () => {
  assert.equal(similarity(sketchOf(PARAGRAPH), sketchOf(PARAGRAPH)), 1);
});

test("a light rewording of a paragraph is at or above the near-match threshold", () => {
  const score = similarity(sketchOf(PARAGRAPH), sketchOf(LIGHT_REWORDING));
  assert.ok(
    score >= NEAR_MATCH_THRESHOLD,
    `a light rewording scored ${score}, under the ${NEAR_MATCH_THRESHOLD} threshold`,
  );
  assert.ok(score < 1, `a light rewording scored ${score}, which cannot be an exact match`);
});

test("a rewrite touching every sentence falls below the near-match threshold", () => {
  // Where 0.85 actually sits, and the test that will speak up if the constant moves: five reworded
  // clauses across nine sentences is already too much change to call one text. The threshold buys
  // the mirror's usual few-word drift and no more, which is the conservative side of the trade
  // (the cost of missing a match is a second copy in the thread, the cost of a false match is a
  // message the operator never sees).
  const score = similarity(sketchOf(PARAGRAPH), sketchOf(HEAVY_REWORDING));
  assert.ok(score > 0.5, `a heavy rewording scored ${score}, lower than its shared prose warrants`);
  assert.ok(score < NEAR_MATCH_THRESHOLD, `a heavy rewording scored ${score}, at or above the threshold`);
});

test("a two-line summary of a paragraph is well below the near-match threshold", () => {
  const score = similarity(sketchOf(PARAGRAPH), sketchOf(SUMMARY));
  assert.ok(
    score < NEAR_MATCH_THRESHOLD / 2,
    `a summary scored ${score}, near enough the ${NEAR_MATCH_THRESHOLD} threshold to be at risk`,
  );
});

test("prose on the same subject with different content scores near zero", () => {
  const score = similarity(sketchOf(PARAGRAPH), sketchOf(DIFFERENT_TEXT));
  assert.ok(score < 0.05, `unrelated prose scored ${score}`);
});

test("disjoint texts score zero", () => {
  const score = similarity(sketchOf("alpha beta gamma delta epsilon"), sketchOf("one two three four five"));
  assert.equal(score, 0);
});

test("a long text containing a short one whole still scores them apart", () => {
  // The property that keeps a short summary from suppressing a long mirror. The naive estimate,
  // shared hashes over the smaller sketch's size, would call this containment a full match.
  const contained = similarity(sketchOf(SUMMARY), sketchOf(`${SUMMARY} ${PARAGRAPH} ${DIFFERENT_TEXT}`));
  assert.ok(
    contained < NEAR_MATCH_THRESHOLD / 2,
    `a wholly contained short text scored ${contained} against its container`,
  );
  assert.ok(contained > 0, "a wholly contained short text shares shingles with its container");
});

test("the estimate does not depend on argument order", () => {
  const short = sketchOf(SUMMARY);
  const long = sketchOf(`${SUMMARY} ${PARAGRAPH}`);
  assert.equal(similarity(short, long), similarity(long, short));
});

test("case, whitespace, and an invisible character do not break a match", () => {
  // U+200B, a zero-width space, mid-word: the class withoutInvisible strips, and the shape a
  // copy-paste through a rendering surface actually acquires.
  const disguised = `​  ${PARAGRAPH.toUpperCase().replace(/ /g, "\n  ")}​\n`;
  assert.equal(similarity(sketchOf(PARAGRAPH), sketchOf(disguised)), 1);
});

test("normalizeForSketch trims, collapses whitespace, folds case, and drops invisibles", () => {
  assert.equal(normalizeForSketch("  The​  CAT \n\n sat\tdown  "), "the cat sat down");
  // A tab and a newline are themselves in the invisible class, so a stripped separator must not
  // weld its neighbours together: "sat\tdown" is two words, never the word "satdown".
  assert.equal(normalizeForSketch("sat\tdown"), "sat down");
  assert.equal(normalizeForSketch("one\ntwo"), "one two");
  // A zero-width character between two spaces leaves one space behind it, not two.
  assert.equal(normalizeForSketch("one ​ two"), "one two");
});

test("a sketch of a very long text holds at most the sketch size", () => {
  const long = Array.from({ length: 5000 }, (_, index) => `distinct phrase number ${index}`).join(" ");
  assert.equal(sketchOf(long).length, SKETCH_SIZE);
});

test("a sketch is ascending and free of duplicates", () => {
  // A repeated paragraph adds no new shingles beyond the seam between its copies.
  const sketch = sketchOf(`${PARAGRAPH} ${PARAGRAPH}`);
  assert.equal(new Set(sketch).size, sketch.length);
  for (let index = 1; index < sketch.length; index += 1) {
    assert.ok((sketch[index - 1] ?? 0n) < (sketch[index] ?? 0n), "sketch hashes are ascending");
  }
});

test("a text shorter than one shingle sketches to a single hash of itself", () => {
  const short = "shipped and green";
  assert.equal(short.split(" ").length, SHINGLE_WORDS);
  const shorter = sketchOf("shipped and");
  assert.equal(shorter.length, 1);
  // Exact rather than near is all a two-word text supports: it matches itself, in any casing, and
  // nothing else.
  assert.equal(similarity(shorter, sketchOf("Shipped  and")), 1);
  assert.equal(similarity(shorter, sketchOf("shipped or")), 0);
  assert.equal(similarity(shorter, sketchOf(short)), 0);
});

test("an empty sketch matches nothing, including another empty sketch", () => {
  const empty = sketchOf("   ​ \n ");
  assert.deepEqual(empty, []);
  assert.equal(sketchOf("").length, 0);
  assert.equal(similarity(empty, sketchOf(PARAGRAPH)), 0);
  assert.equal(similarity(sketchOf(PARAGRAPH), empty), 0);
  // Two blanks are equal and still not a match: "nothing said twice" is not one thing said twice.
  assert.equal(similarity(empty, sketchOf("")), 0);
});
