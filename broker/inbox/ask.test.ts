import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EXCERPT_CODE_POINTS, findAsk, hasStewardAsk } from "./ask.ts";

test("an ASK: line outside a fence marks the reply, with the rest of the line as the excerpt", () => {
  const reply = ["Merged the refactor.", "", "ASK: ship it   tonight\tor wait?", "Carrying on."].join(
    "\n",
  );
  assert.equal(findAsk(reply), "ship it tonight or wait?");
  // Leading indentation is not the marker, so it does not refuse the line.
  assert.equal(findAsk("  \tASK: indented"), "indented");
  assert.equal(findAsk("first\r\nASK: after a CRLF"), "after a CRLF");
});

test("an ASK: line inside a fence marks nothing", () => {
  // A reply quoting code is the case the fence rule exists for: every review would otherwise ask.
  for (const reply of [
    "```\nASK: quoted\n```",
    "~~~ts\nASK: quoted\n~~~",
    "  ````\nASK: quoted\n```\nstill inside the longer fence\n````",
    "```\nnever closed\nASK: quoted",
    "```\nASK: quoted\n``` not a closer\n",
  ]) {
    assert.equal(findAsk(reply), null, reply);
  }
});

test("a fence that closes gives the lines after it back to the parser", () => {
  // The control for the refusal above: the same quoted line marks nothing, and the line after the
  // closer marks, so the refusal comes from the fence and not from a parser that sees nothing.
  assert.equal(findAsk("```\nASK: quoted\n```\nASK: real"), "real");
  assert.equal(findAsk("~~~~\nASK: quoted\n~~~~~   \nASK: real"), "real");
  assert.equal(findAsk("```\nASK: quoted\n~~~\nASK: quoted too\n```\nASK: real"), "real");
});

test("a backtick run whose info string carries a backtick is inline code and opens no fence", () => {
  assert.equal(findAsk("```x```\nASK: real"), "real");
  // The same run with a backtick-free info string does open one, which is what the line above is
  // measured against.
  assert.equal(findAsk("```x\nASK: quoted"), null);
});

test("a lowercase ask:, a mid-line ASK:, a quoted and a bulleted ASK: mark nothing", () => {
  assert.equal(findAsk("ask: lowercase"), null);
  assert.equal(findAsk("Ask: mixed case"), null);
  assert.equal(findAsk("The session said ASK: in the middle"), null);
  assert.equal(findAsk("> ASK: blockquoted"), null);
  assert.equal(findAsk("- ASK: bulleted"), null);
  assert.equal(findAsk("ASK without the colon"), null);
  assert.equal(findAsk(""), null);
});

test("the first of several ASK: lines is the excerpt", () => {
  assert.equal(findAsk("ASK: first\nASK: second"), "first");
});

test("a bare ASK: still marks, with an empty excerpt", () => {
  assert.equal(findAsk("ASK:"), "");
  assert.equal(findAsk("ASK:    "), "");
});

test("the persona plugin's ask line is admitted whole", () => {
  assert.equal(
    findAsk("ASK: Rebase onto main first? Recommend: yes"),
    "Rebase onto main first? Recommend: yes",
  );
});

test("the excerpt is cut on code points and never splits an astral pair", () => {
  const astral = "\u{1F600}".repeat(MAX_EXCERPT_CODE_POINTS + 50);
  const excerpt = findAsk(`ASK: ${astral}`);
  assert.notEqual(excerpt, null);
  assert.equal([...(excerpt ?? "")].length, MAX_EXCERPT_CODE_POINTS);
  assert.equal(excerpt, "\u{1F600}".repeat(MAX_EXCERPT_CODE_POINTS));
});

test("a steward-shaped line is found on the persona plugin's own pattern", () => {
  assert.equal(hasStewardAsk("ASK: Ship it? Recommend: yes"), true);
  assert.equal(hasStewardAsk("Done with the sweep.\nASK: Ship it? Recommend: yes\nMore."), true);
  // Case-insensitive, like the sibling's matcher.
  assert.equal(hasStewardAsk("ask: x? recommend: y"), true);
  // A plain ask of the operator is not steward-shaped, and it is still a mark.
  assert.equal(hasStewardAsk("ASK: Should I merge?"), false);
  assert.equal(findAsk("ASK: Should I merge?"), "Should I merge?");
  // Anchored at the line's first character, like the sibling's matcher.
  assert.equal(hasStewardAsk(" ASK: x? Recommend: y"), false);
});
