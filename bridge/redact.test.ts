// The fixture redaction, driven at the shape that defeated it.
//
// The defect this locks was live in a committed fixture: the worker streamed a `write` tool call's
// arguments as about thirty `tool-call-delta` chunks, so the absolute path it was writing to existed
// in the stream only as `"D"`, `":\\"`, `"discord"`, `"-ch"`, `"annels"` and so on. Redaction ran
// per string leaf, no leaf ever held enough of the path to match, and the file shipped to a public
// repository carrying the operator's directory layout while the assembled `tool/call` event a few
// records later correctly read `<WORKSPACE>`.
//
// So the assertions here are on the reassembled value rather than on any single record, and every
// one of them is paired with a control run against the same stream unredacted, because a redaction
// test that passes because the predicate reads nothing is exactly the failure that shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import {
  assembledBlocks,
  leakMatches,
  redactStream,
  redactValue,
  redactionRules,
  resplit,
} from "./tools/sdk-smoke.ts";

/** A workspace inside a repository root inside a home, the nesting the real three rules have. */
const HOME = "C:\\Users\\Someone";
const REPO = "D:\\a-checkout";
const WORKSPACE = "D:\\a-checkout\\.kit\\spike-workspace";
const RULES = redactionRules(WORKSPACE, REPO, HOME);

/** Any drive-letter absolute path, which is what must never survive into a fixture. */
const ABSOLUTE = /[A-Za-z]:[\\/]/;

/** One `assistant/chunk` notification, in the shape the runtime emits it. */
function chunk(chunkBody: Record<string, unknown>, turn = 1, step = 1): HarnessNotification {
  return {
    method: "session.event",
    params: {
      sessionId: "session-test",
      event: { type: "assistant/chunk", seq: 1, time: 0, data: { turn, step, chunk: chunkBody } },
    },
  };
}

/**
 * A tool call streamed the way the model streams one: a block start, the arguments cut into small
 * pieces that fall wherever the tokenizer put them, and a block end carrying the assembled value.
 */
function toolCallStream(callId: string, argumentsJson: string, pieces: readonly number[]): HarnessNotification[] {
  const stream: HarnessNotification[] = [chunk({ type: "block-start", index: 0, blockType: "tool-call" })];
  let at = 0;
  for (const size of pieces) {
    stream.push(
      chunk({
        type: "tool-call-delta",
        index: 0,
        id: callId,
        name: "write",
        argumentsDelta: argumentsJson.slice(at, at + size),
      }),
    );
    at += size;
  }
  if (at < argumentsJson.length) {
    stream.push({ ...chunk({ type: "tool-call-delta", index: 0, id: callId, name: "write", argumentsDelta: argumentsJson.slice(at) }) });
  }
  stream.push(
    chunk({
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: callId, name: "write", arguments: argumentsJson },
    }),
  );
  return stream;
}

/** The write the defect was found in: the workspace path, split the way the model split it. */
function workspaceWriteStream(root = WORKSPACE): HarnessNotification[] {
  const args = JSON.stringify({ file_path: `${root}\\hello-from-qwen.txt`, content: "hello from qwen\n" });
  // Deliberately ragged and mostly shorter than any path segment, so no piece holds enough of the
  // path to match on its own. That is the whole condition the defect needed.
  return toolCallStream("call-1", args, [1, 1, 2, 7, 3, 6, 3, 4, 3, 5, 2, 4, 5, 1, 2, 6]);
}

test("a path streamed across chunks is gone from the reassembled arguments", () => {
  const redacted = redactStream(workspaceWriteStream(), RULES);

  const assembled = assembledBlocks(redacted).get("tool-call:call-1");
  assert.ok(assembled !== undefined, "the tool call's fragments must still form one block");
  assert.doesNotMatch(assembled, ABSOLUTE, "the reassembled arguments carry no absolute path");
  assert.ok(assembled.includes("<WORKSPACE>"), "and carry the placeholder in its place");

  // Still the arguments of a `write` call, not just a string with no path in it. A redaction that
  // broke the JSON would be caught by section 2's replay rather than here, and much later.
  const parsed = JSON.parse(assembled) as { file_path: string; content: string };
  assert.equal(parsed.file_path, "<WORKSPACE>\\hello-from-qwen.txt");
  assert.equal(parsed.content, "hello from qwen\n");
});

test("the control: the predicate speaks against an unredacted stream", () => {
  const reported = leakMatches(workspaceWriteStream(), RULES);
  assert.ok(reported.length > 0, "the predicate must speak against a stream that does carry the path");
  assert.ok(
    reported.some((entry) => entry.startsWith("streamed block tool-call:call-1")),
    `the streamed block must be one of the places named, got: ${reported.join("; ")}`,
  );
});

test("the control: leaf-only redaction still leaks, and only the block join sees it", () => {
  // The state the defective fixture actually shipped in, reproduced: every string leaf redacted on
  // its own, which cleans the assembled `arguments` value because that is one leaf, and cleans no
  // fragment because no fragment holds enough of the path to match.
  const leafOnly = workspaceWriteStream().map((notification) => redactValue(notification, RULES) as HarnessNotification);

  const reported = leakMatches(leafOnly, RULES);
  assert.ok(
    reported.some((entry) => entry.startsWith("streamed block tool-call:call-1")),
    `the block join must report it, got: ${reported.join("; ") || "(nothing)"}`,
  );

  // And the fact that makes the block join load-bearing rather than belt-and-braces: the guard a
  // reviewer would reach for first, joining every string leaf in the stream, is silent here. Each
  // fragment arrives in its own notification behind that notification's method name, session id and
  // chunk type, so the join interleaves those between the fragments and the path is never
  // contiguous in the result. Held against the day someone simplifies the guard down to one join.
  assert.ok(
    reported.every((entry) => !entry.startsWith("every string leaf joined")),
    "the whole-stream leaf join does not see this defect, which is why the block join exists",
  );
  const leaves: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") leaves.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(leafOnly);
  assert.doesNotMatch(leaves.join(""), new RegExp(RULES[0].source, "i"));
});

test("the control speaks for a spelling it was never handed", () => {
  // The rules were built from `D:\a-checkout\.kit\spike-workspace`. This stream spells the same
  // path with forward slashes and a different case, which no literal in the pattern contains, so a
  // pass here is evidence about the pattern's reach rather than about the instrument working.
  const withheld = "d:/A-Checkout/.KIT/Spike-Workspace";
  assert.ok(leakMatches(workspaceWriteStream(withheld), RULES).length > 0, "an alternate spelling is still reported");

  const redacted = redactStream(workspaceWriteStream(withheld), RULES);
  assert.equal(leakMatches(redacted, RULES).length, 0);
  const assembled = assembledBlocks(redacted).get("tool-call:call-1");
  assert.ok(assembled !== undefined);
  assert.doesNotMatch(assembled, ABSOLUTE);
});

test("a home path streamed as text deltas is redacted too", () => {
  // Text blocks group by turn, step and block index rather than by a call id, and a path can reach
  // one through an error the worker quotes back rather than through a tool call.
  const sentence = `I could not read ${HOME}\\.dsh\\.credentials.yaml`;
  const stream: HarnessNotification[] = [chunk({ type: "block-start", index: 0, blockType: "text" })];
  for (let at = 0; at < sentence.length; at += 3) {
    stream.push(chunk({ type: "text-delta", index: 0, text: sentence.slice(at, at + 3) }));
  }

  assert.ok(leakMatches(stream, RULES).length > 0, "the control: unredacted, the home path is reported");
  const redacted = redactStream(stream, RULES);
  assert.equal(leakMatches(redacted, RULES).length, 0);
  const assembled = assembledBlocks(redacted).get("text:1/1/0");
  assert.ok(assembled !== undefined, "the text block must still group by turn, step and index");
  assert.equal(assembled, "I could not read <HOME>\\.dsh\\.credentials.yaml");
});

test("the more specific path wins, so a nested one is not left half-named", () => {
  // The workspace sits inside the repository root. Redacted in the wrong order the repository rule
  // eats the prefix and leaves `<REPO>\.kit\spike-workspace`, which still publishes the layout.
  const redacted = redactStream(workspaceWriteStream(), RULES);
  const assembled = assembledBlocks(redacted).get("tool-call:call-1") ?? "";
  assert.ok(!assembled.includes("<REPO>"), "the workspace is not redacted as the repository plus a tail");
  assert.ok(!assembled.includes("spike-workspace"), "no segment of the workspace path survives");
});

test("redaction changes no record's count, order, or shape", () => {
  // The fixtures are replayed by the bridge's own tests as wire truth. A fixture that dropped or
  // reshaped a record would be worse than no fixture, because it would be trusted.
  const raw = workspaceWriteStream();
  const redacted = redactStream(raw, RULES);
  assert.equal(redacted.length, raw.length);

  const shapeOf = (stream: readonly HarnessNotification[]): string[] =>
    stream.map((notification) => {
      const event = notification.params.event as { type: string; data: { chunk: Record<string, unknown> } };
      return `${notification.method}/${event.type}/${String(event.data.chunk.type)}/${Object.keys(event.data.chunk).join(",")}`;
    });
  assert.deepEqual(shapeOf(redacted), shapeOf(raw));
});

test("resplit keeps the fragment count and concatenates to exactly the text", () => {
  // The one place the record count could quietly change. A replacement is a different length from
  // what it replaced, so the boundaries move; the count and the joined value must not.
  const lengths = [3, 3, 3];
  assert.deepEqual(resplit("abcdefghi", lengths), ["abc", "def", "ghi"]);
  assert.deepEqual(resplit("ab", lengths), ["ab", "", ""]);
  assert.deepEqual(resplit("abcdefghijkl", lengths), ["abc", "def", "ghijkl"]);
  for (const text of ["", "abc", "abcdefghijklmnop"]) {
    const parts = resplit(text, lengths);
    assert.equal(parts.length, lengths.length);
    assert.equal(parts.join(""), text);
  }
});
