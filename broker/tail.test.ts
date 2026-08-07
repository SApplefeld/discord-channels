// The transcript tailer, driven against real files in a real temp directory: the contract this
// module is most exposed to is the shape Claude Code actually writes, and a hand-built object
// handed to a parser cannot catch a mismatch between the two. Fixture lines carry the real line
// shapes (the keys, the nesting, the types) with synthetic content.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TAIL_READ_BYTES, createEchoMemory, createTranscriptTailer } from "./tail.ts";
import type { TranscriptTailerOptions } from "./tail.ts";
import { renderMirror } from "./discord/render.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { ThreadMessenger } from "./discord/transport.ts";
import { createRegistry } from "./registry.ts";
import { createOutboundRouter } from "./routing/outbound.ts";
import type { ReplyResult } from "./routing/outbound.ts";
import { createThreadWriter } from "./routing/writer.ts";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SESSION = "bbbbbbbb-2222-4222-8222-222222222222";
const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";

function transcriptDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function transcriptFile(t: TestContext, sessionId: string = SESSION): string {
  const file = path.join(transcriptDir(t), `${sessionId}.jsonl`);
  writeFileSync(file, "", "utf8");
  return file;
}

/** One transcript line: one JSON object, newline-terminated, as Claude Code writes them. */
function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/** An assistant text line in the real shape: exactly one content block, of type text. */
function assistantText(
  text: string,
  sessionId: string = SESSION,
  extra: Record<string, unknown> = {},
): string {
  return line({
    parentUuid: "00000000-0000-4000-8000-000000000000",
    isSidechain: false,
    message: {
      model: "claude-fixture",
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: null,
    },
    requestId: "req_fixture",
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-08-07T00:00:00.000Z",
    sessionId,
    version: "fixture",
    gitBranch: "main",
    ...extra,
  });
}

function harness(overrides: Partial<TranscriptTailerOptions> = {}) {
  const posts: string[] = [];
  const logs: string[] = [];
  const live = new Set<string>([SESSION]);
  const echo = createEchoMemory();
  const tailer = createTranscriptTailer({
    liveSessions: () => [...live],
    deliver: async (_sessionId, text) => {
      posts.push(text);
      return { status: "sent" };
    },
    echo,
    log: (message) => logs.push(message),
    now: () => 1_000,
    ...overrides,
  });
  return { tailer, posts, logs, live, echo };
}

test("what a transcript held before it was learned is never republished", async (t) => {
  // The first pass over a learned path takes the file's end without consuming anything: after a
  // broker restart the next hook post re-teaches the path, and reading from zero there would
  // replay the whole conversation into the operator's thread.
  const file = transcriptFile(t);
  writeFileSync(file, assistantText("conversation already had") + assistantText("more of it"), "utf8");
  const { tailer, posts } = harness();

  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();
  assert.deepEqual(posts, [], "the first pass consumes nothing");

  appendFileSync(file, assistantText("narration after the tailer arrived"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["narration after the tailer arrived"]);
});

test("a session with no mirror verdict seen at all never narrates", async (t) => {
  // The gate fails closed. The tailer reads content itself, so an absent signal must mean absent
  // narration, not narration by default: the -NoMirror escape only ever reaches the broker as a
  // header on /mirror posts, and any path that loses that signal (a restart, a revive) must land
  // on silence rather than on publishing an opted-out session's prose.
  const file = transcriptFile(t);
  const { tailer, posts } = harness();

  tailer.learn(SESSION, file);
  await tailer.poll();
  appendFileSync(file, assistantText("grown before any verdict"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, [], "a learned path and a growing file are not permission");

  // The allow arrives later, as it does at the first UserPromptSubmit of a turn. What grew
  // before it stays unpublished; narration starts from the file's end at the first allowed pass.
  tailer.allow(SESSION);
  await tailer.poll();
  assert.deepEqual(posts, [], "pre-allow content must not post once the allow lands");
  appendFileSync(file, assistantText("narration after the allow"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["narration after the allow"]);
});

test("a -NoMirror session stays silent across a broker restart", async (t) => {
  // The restart ordering that would fail open under an opt-out default: the suppressed set is
  // in-memory, the registry snapshot and the thread bindings survive on disk, and the next
  // PostToolUse re-teaches the path. A fresh tailer that read by default would publish the
  // opted-out session's prose. Fail-closed, the fresh tailer has seen no allow for this session
  // and reads nothing.
  const file = transcriptFile(t);
  writeFileSync(file, assistantText("mid-turn prose of an opted-out session"), "utf8");
  const restarted = harness();

  restarted.tailer.learn(SESSION, file);
  await restarted.tailer.poll();
  appendFileSync(file, assistantText("more prose after the restart"), "utf8");
  await restarted.tailer.poll();
  assert.deepEqual(restarted.posts, [], "a restart must not turn -NoMirror into narration");
});

test("chunks post in transcript order, one per text block", async (t) => {
  const file = transcriptFile(t);
  const { tailer, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("first") + assistantText("second"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["first", "second"]);
});

test("every other line type posts nothing, including one this build has never seen", async (t) => {
  // The allowlist criterion. The fixture is built out of the real line shapes, and the sharpest
  // case is the invented type carrying an otherwise-valid text block: a denylist of known
  // non-assistant types would publish it, an allowlist keyed on type === "assistant" cannot.
  const file = transcriptFile(t);
  const { tailer, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("SECRET-thinking-block", SESSION, {
      message: {
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: "SECRET-thinking-block", signature: "sig" }],
      },
    }) +
      assistantText("unused", SESSION, {
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }],
        },
      }) +
      line({ type: "user", message: { role: "user", content: "SECRET-typed-prompt" }, sessionId: SESSION }) +
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "SECRET-tool-result" }],
        },
        sessionId: SESSION,
      }) +
      line({ type: "attachment", attachment: { type: "diagnostics" }, sessionId: SESSION }) +
      line({ type: "system", content: "SECRET-system-line", sessionId: SESSION }) +
      line({ type: "custom-title", customTitle: "SECRET-title", sessionId: SESSION }) +
      line({ type: "queue-operation", operation: "add", sessionId: SESSION }) +
      line({
        type: "wormhole",
        isSidechain: false,
        sessionId: SESSION,
        message: { role: "assistant", content: [{ type: "text", text: "SECRET-unknown-type" }] },
      }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(posts, [], "no non-assistant line may post");

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, assistantText("a real narration line"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["a real narration line"]);
});

test("a foreign session's line and a sidechain line post nothing", async (t) => {
  // The sessionId match is the load-bearing check: a transcript is learned for one session, and
  // text naming any other belongs to a conversation this thread does not carry. isSidechain is
  // defense against a build that starts interleaving subagent traffic into the same file.
  const file = transcriptFile(t);
  const { tailer, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("SECRET-foreign-session", OTHER_SESSION) +
      assistantText("SECRET-sidechain", SESSION, { isSidechain: true }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(posts, []);

  appendFileSync(file, assistantText("the main session's own line"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["the main session's own line"]);
});

test("a trailing partial line waits for its newline and then posts exactly once", async (t) => {
  // The classic tailer bug: a line the writer is midway through flushing, read as if whole, fails
  // silently as a dropped chunk. Only what ends in a newline is consumed; the offset stops before
  // the partial tail, and the next pass reads the completed line from its start.
  const file = transcriptFile(t);
  const { tailer, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  const whole = assistantText("the second thought, flushed in two writes");
  appendFileSync(file, assistantText("a complete line") + whole.slice(0, 40), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["a complete line"], "the partial line must not post half-read");

  appendFileSync(file, whole.slice(40), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["a complete line", "the second thought, flushed in two writes"]);

  await tailer.poll();
  assert.equal(posts.length, 2, "the completed line posts exactly once");
});

/**
 * The tailer wired to the real outbound router, the way index.ts wires them, so the dedup is
 * proved across the seam the two halves actually share rather than against a hand-built stub.
 */
function integration(t: TestContext) {
  const file = transcriptFile(t);
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-tail",
    sessionId: SESSION,
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
  });
  const posts: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const echo = createEchoMemory();
  const outbound = createOutboundRouter({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    echo,
  });
  const tailer = createTranscriptTailer({
    liveSessions: () => [SESSION],
    deliver: (sessionId, text) => outbound.interim(sessionId, text),
    echo,
    now: () => 1_000,
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  return { file, tailer, outbound, posts };
}

test("a final reply mirrored first is not posted again by the tailer", async (t) => {
  // The common order: the Stop hook posts the turn's final reply within milliseconds of turn end,
  // and the tailer reads the same text off the transcript up to a poll interval later.
  const { file, tailer, outbound, posts } = integration(t);
  await tailer.poll();

  const final = "Done: the migration is green and pushed.";
  appendFileSync(file, assistantText(final), "utf8");
  assert.deepEqual(await outbound.mirror(TOKEN, "reply", final, SESSION), { status: "sent" });
  assert.deepEqual(posts, [renderMirror("reply", final)[0]]);

  await tailer.poll();
  assert.equal(posts.length, 1, `the reply must post exactly once: ${posts.join("\n---\n")}`);
});

test("a final reply the tailer posted first is not posted again by the Stop mirror", async (t) => {
  // The rare order: a poll lands inside the turn's last moment and reads the final text before
  // the Stop mirror delivers it.
  const { file, tailer, outbound, posts } = integration(t);
  await tailer.poll();

  const final = "Done: the migration is green and pushed.";
  appendFileSync(file, assistantText(final), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, [renderMirror("interim", final)[0]]);

  assert.deepEqual(await outbound.mirror(TOKEN, "reply", final, SESSION), { status: "sent" });
  assert.equal(posts.length, 1, `the reply must post exactly once: ${posts.join("\n---\n")}`);

  // A later, different reply still mirrors: the memory holds the last chunk, not a blocklist.
  assert.deepEqual(await outbound.mirror(TOKEN, "reply", "a different turn's reply", SESSION), {
    status: "sent",
  });
  assert.equal(posts.length, 2);
});

test("interim text between the final reply and the turn's earlier narration still posts", async (t) => {
  // The dedup holds one digest per side, so ordinary narration around the deduplicated reply is
  // untouched: only the text both paths carry is suppressed.
  const { file, tailer, outbound, posts } = integration(t);
  await tailer.poll();

  const final = "The build is green.";
  appendFileSync(file, assistantText("Running the suite now.") + assistantText(final), "utf8");
  await tailer.poll();
  assert.equal(posts.length, 2, posts.join("\n---\n"));

  await outbound.mirror(TOKEN, "reply", final, SESSION);
  assert.equal(posts.length, 2, "the final text arrived once by each path and posted once in total");
});

test("an echo match answers once: text a later turn repeats still posts", async (t) => {
  // A digest that matched without being consumed would be an indefinite blocklist: a turn ending
  // "Done." would silence every later turn's "Done." forever. A match spends the digest, which
  // answers for exactly the one duplicate the race can produce.
  const { file, tailer, outbound, posts } = integration(t);
  await tailer.poll();

  const repeated = "Done.";
  appendFileSync(file, assistantText(repeated), "utf8");
  await outbound.mirror(TOKEN, "reply", repeated, SESSION);
  assert.equal(posts.length, 1);
  await tailer.poll();
  assert.equal(posts.length, 1, "the duplicate off the transcript is skipped");

  // The next turn genuinely says the same thing mid-turn; nothing else will carry it.
  appendFileSync(file, assistantText(repeated), "utf8");
  await tailer.poll();
  assert.equal(posts.length, 2, `a repeat in a later turn must post: ${posts.join("\n---\n")}`);
});

test("an echo digest is consumed by the match, on both lookups", () => {
  const echo = createEchoMemory();
  echo.noteReply(SESSION, "Done.");
  assert.equal(echo.isEcho(SESSION, "Done."), true);
  assert.equal(echo.isEcho(SESSION, "Done."), false, "the reply digest answers once");

  echo.noteInterim(SESSION, "working on it");
  assert.equal(echo.isInterimEcho(SESSION, "working on it"), true);
  assert.equal(echo.isInterimEcho(SESSION, "working on it"), false, "the interim digest answers once");
});

test("a suppressed session's transcript is not even opened", async (t) => {
  // The -NoMirror escape covers mid-turn text too, and it is honored before the read rather than
  // after: a session that opted out of mirroring must not have its file opened at all, even when
  // an earlier post had allowed it.
  const file = transcriptFile(t);
  appendFileSync(file, assistantText("SECRET-suppressed"), "utf8");
  let reads = 0;
  const { tailer, posts } = harness({
    readFile: async () => {
      reads += 1;
      return { size: 0, bytes: Buffer.alloc(0) };
    },
  });

  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  tailer.suppress(SESSION);
  await tailer.poll();
  await tailer.poll();

  assert.equal(reads, 0, "a suppressed session's file must never be opened");
  assert.deepEqual(posts, []);
});

test("suppression recorded before the path is learned still holds", async (t) => {
  // The suppress signal rides the mirror route and the path rides the hook route, two independent
  // requests with no ordering guarantee between them.
  const file = transcriptFile(t);
  let reads = 0;
  const { tailer, posts } = harness({
    readFile: async () => {
      reads += 1;
      return { size: 0, bytes: Buffer.alloc(0) };
    },
  });

  tailer.suppress(SESSION);
  tailer.learn(SESSION, file);
  await tailer.poll();

  assert.equal(reads, 0);
  assert.deepEqual(posts, []);
});

test("an absent, unreadable, or non-JSON transcript posts nothing, throws nothing, logs no bytes", async (t) => {
  const missing = path.join(transcriptDir(t), "missing.jsonl");
  const { tailer, posts, logs } = harness();
  tailer.learn(SESSION, missing);
  tailer.allow(SESSION);
  await tailer.poll();
  assert.deepEqual(posts, []);
  assert.ok(logs.length > 0, "an unreadable transcript must be visible in the log");
  assert.ok(!logs.join("\n").includes("missing.jsonl"), `the path is content-adjacent and stays out: ${logs.join("\n")}`);

  // Garbage that never parses: written by another process, a half-flushed line is not an error,
  // and V8's parse error would quote the line's own text if anything caught and logged it.
  const file = transcriptFile(t);
  const garbage = harness();
  garbage.tailer.learn(SESSION, file);
  garbage.tailer.allow(SESSION);
  await garbage.tailer.poll();
  appendFileSync(file, 'SECRET-not-json at all\n{"type": "assistant", "SECRET-broken\n', "utf8");
  await garbage.tailer.poll();
  assert.deepEqual(garbage.posts, []);
  assert.ok(!garbage.logs.join("\n").includes("SECRET"), garbage.logs.join("\n"));

  // A read that rejects quoting content: the error object is discarded unread.
  const failing = harness({
    readFile: async () => {
      throw new Error("read exploded while carrying: SECRET-io-error");
    },
  });
  failing.tailer.learn(SESSION, file);
  failing.tailer.allow(SESSION);
  await failing.tailer.poll();
  assert.deepEqual(failing.posts, []);
  assert.ok(failing.logs.length > 0);
  assert.ok(!failing.logs.join("\n").includes("SECRET-io-error"), failing.logs.join("\n"));
});

test("a file that shrank below the held offset resumes from its new end, never from zero", async (t) => {
  // A session ID maps to one transcript that only grows, so a shrink is something the tailer does
  // not model, and the one wrong answer is re-scanning: that would republish the whole
  // conversation into the operator's thread.
  const file = transcriptFile(t);
  writeFileSync(file, assistantText("old one") + assistantText("old two") + assistantText("old three"), "utf8");
  const { tailer, posts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("posted before the shrink"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["posted before the shrink"]);

  writeFileSync(file, assistantText("SECRET-replacement-history"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["posted before the shrink"], "a shrink must republish nothing");
  assert.ok(logs.some((entry) => entry.includes("shrank")), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));

  appendFileSync(file, assistantText("narration after the shrink"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["posted before the shrink", "narration after the shrink"]);
});

test("growth past the per-pass bound is skipped by count and narration resumes at the end", async (t) => {
  const file = transcriptFile(t);
  const { tailer, posts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("x".repeat(MAX_TAIL_READ_BYTES)), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, [], "a backlog past the bound is skipped, not read out");
  const captured = logs.join("\n");
  assert.ok(/\d+ bytes/.test(captured), captured);
  assert.ok(!captured.includes("xxx"), `the skipped bytes stay out of the log: ${captured.slice(0, 200)}`);

  appendFileSync(file, assistantText("current narration"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["current narration"]);
});

test("a chunk that could not be posted is dropped, not retried, and not remembered as posted", async (t) => {
  const file = transcriptFile(t);
  let outcome: ReplyResult = { status: "no-thread" };
  const deliveries: string[] = [];
  const { tailer, echo } = harness({
    deliver: async (_sessionId, text) => {
      deliveries.push(text);
      return outcome;
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("narration nobody could receive"), "utf8");
  await tailer.poll();
  assert.deepEqual(deliveries, ["narration nobody could receive"]);
  assert.equal(
    echo.isEcho(SESSION, "narration nobody could receive"),
    false,
    "an unposted chunk must not suppress the Stop mirror carrying the same text",
  );

  outcome = { status: "sent" };
  await tailer.poll();
  assert.equal(deliveries.length, 1, "nothing is queued and nothing is retried");
});

test("a delivery that throws drops that chunk alone, not the rest of the batch", async (t) => {
  // The consumed bytes are already behind the offset when the posting loop runs, so a throw that
  // escaped the loop would lose every later chunk in the batch with no way to re-read them. The
  // error itself is discarded unread; it can quote the text it failed to post.
  const file = transcriptFile(t);
  const posts: string[] = [];
  const logs: string[] = [];
  const { tailer } = harness({
    deliver: async (_sessionId, text) => {
      if (text.includes("SECRET-exploding")) throw new Error(`delivery exploded while posting: ${text}`);
      posts.push(text);
      return { status: "sent" };
    },
    log: (message) => logs.push(message),
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("SECRET-exploding first chunk") + assistantText("second chunk") + assistantText("third chunk"),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(posts, ["second chunk", "third chunk"], "the rest of the batch still belongs to the operator");
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));
});

test("re-learning the same path keeps the position; every credited hook post re-teaches it", async (t) => {
  // learn() is called on every credited /hook post, and PostToolUse fires constantly mid-turn. A
  // learn that reset the offset would skip to the file's end each time and drop the narration in
  // between.
  const file = transcriptFile(t);
  const { tailer, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("between two hook posts"), "utf8");
  tailer.learn(SESSION, file);
  await tailer.poll();
  assert.deepEqual(posts, ["between two hook posts"]);
});

test("a session that left the live set stops being read and is forgotten whole", async (t) => {
  const file = transcriptFile(t);
  const { tailer, posts, live, echo } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  echo.noteInterim(SESSION, "a remembered chunk");
  await tailer.poll();

  live.delete(SESSION);
  appendFileSync(file, assistantText("written after the session ended"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, []);
  assert.equal(echo.isEcho(SESSION, "a remembered chunk"), false, "the digests leave with the session");

  // Back in the live set without a re-learn: the path and the allow went with the entry, so
  // nothing is read until a hook post teaches the path again and a mirror post allows it again.
  live.add(SESSION);
  await tailer.poll();
  assert.deepEqual(posts, []);
});

test("a pass that outlasts the poll interval is not overlapped, and the next poll awaits it", async (t) => {
  // Two properties on one gate. A second pass over the same offsets would post the same chunks
  // twice, and the promise a busy poll returns is what shutdown awaits: a resolved stand-in
  // would let stop() return while the real pass still holds a file handle and is posting.
  const file = transcriptFile(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliveries: string[] = [];
  const { tailer } = harness({
    deliver: async (_sessionId, text) => {
      deliveries.push(text);
      await gate;
      return { status: "sent" };
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, assistantText("a slow post"), "utf8");
  const first = tailer.poll();
  const second = tailer.poll();
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "the overlapped poll must expose the pass still running");

  release();
  await Promise.all([first, second]);
  assert.deepEqual(deliveries, ["a slow post"], "an overlapping pass must not re-read the same offsets");
});

test("one session's slow delivery does not hold another session's narration", async (t) => {
  // Sessions are independent surfaces, so the pass runs them concurrently; only one session's own
  // chunks are ordered against each other. Serialized, a session mid-way through a long split
  // reply would hold every other thread's narration behind it.
  const dir = transcriptDir(t);
  const slowFile = path.join(dir, `${SESSION}.jsonl`);
  const fastFile = path.join(dir, `${OTHER_SESSION}.jsonl`);
  writeFileSync(slowFile, "", "utf8");
  writeFileSync(fastFile, "", "utf8");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fastDelivered: () => void = () => {};
  const fastLanded = new Promise<void>((resolve) => {
    fastDelivered = resolve;
  });
  const { tailer, live } = harness({
    deliver: async (sessionId, _text) => {
      if (sessionId === SESSION) await gate;
      else fastDelivered();
      return { status: "sent" };
    },
  });
  live.add(OTHER_SESSION);
  tailer.learn(SESSION, slowFile);
  tailer.allow(SESSION);
  tailer.learn(OTHER_SESSION, fastFile);
  tailer.allow(OTHER_SESSION);
  await tailer.poll();

  appendFileSync(slowFile, assistantText("the slow session's chunk", SESSION), "utf8");
  appendFileSync(fastFile, assistantText("the fast session's chunk", OTHER_SESSION), "utf8");
  const pass = tailer.poll();

  const raced = await Promise.race([
    fastLanded.then(() => "fast-first"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  assert.equal(raced, "fast-first", "another session must not wait behind a busy one");

  release();
  await pass;
});

test("no log line produced by the tailer carries transcript text", async (t) => {
  // Asserted, not eyeballed: every path that touches content is driven with its own secret, and
  // the assertion is that no secret reaches the captured log, while the log is demonstrably live.
  const file = transcriptFile(t);
  const logs: string[] = [];
  const live = new Set([SESSION]);
  const echo = createEchoMemory();
  let explode = false;
  const tailer = createTranscriptTailer({
    liveSessions: () => [...live],
    deliver: async (_sessionId, text) => {
      if (explode) throw new Error(`delivery exploded while posting: ${text}`);
      return { status: "sent" };
    },
    echo,
    log: (message) => logs.push(message),
    now: () => 1_000,
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  // A posted chunk, a parse failure, and a delivery that throws an error quoting the text: the
  // one place content could legitimately reach a catch block.
  appendFileSync(file, assistantText("SECRET-posted-chunk") + "SECRET-garbage-line{\n", "utf8");
  await tailer.poll();
  explode = true;
  appendFileSync(file, assistantText("SECRET-exploding-chunk"), "utf8");
  await tailer.poll();
  // A shrink whose replacement content is itself a secret.
  writeFileSync(file, "SECRET-shrunk-away\n", "utf8");
  await tailer.poll();

  const captured = logs.join("\n");
  assert.ok(!captured.includes("SECRET"), `transcript content leaked into the log: ${captured}`);
  assert.ok(logs.length > 0, "expected content-free lines to prove the logger was live");
});
