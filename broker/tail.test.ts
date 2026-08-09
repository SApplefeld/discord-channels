// The transcript tailer. Most of these tests drive real files in a real temp directory: the
// contract this module is most exposed to is the shape Claude Code actually writes, and a
// hand-built object handed to a parser cannot catch a mismatch between the two. Fixture lines
// carry the real line shapes (the keys, the nesting, the types) with synthetic content. A minority
// of tests, the ones pinning an exact interleaving of a probe or a poll against allow/suppress/
// learn, drive the injected `readFile` seam directly instead: a real file's read latency cannot be
// held open at a chosen microtask, and these tests need that control to land a write mid-flight
// rather than merely resemble one.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  MAX_TAIL_READ_BYTES,
  askedQuestions,
  createEchoMemory,
  createTranscriptTailer,
  questionDigest,
} from "./tail.ts";
import type { TranscriptSlice, TranscriptTailerOptions } from "./tail.ts";
import { createQuestionDesk } from "./question-desk.ts";
import type { QuestionTerminalState } from "./question-desk.ts";
import { renderAnswer, renderMirror } from "./discord/render.ts";
import type { AskedQuestion } from "./discord/render.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { ThreadMessenger } from "./discord/transport.ts";
import { createRegistry } from "./registry.ts";
import type { ModelFallback, ModelReading } from "./registry.ts";
import { renderCard } from "./discord/render.ts";
import { toView } from "./discord/state.ts";
import { createOutboundRouter } from "./routing/outbound.ts";
import type { ReplyResult } from "./routing/outbound.ts";
import { createThreadWriter } from "./routing/writer.ts";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SESSION = "bbbbbbbb-2222-4222-8222-222222222222";
const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";

// Synthetic taught paths for the tests that drive the injected readFile seam and never open a
// real file. The filename stem is the session id, the measured invariant learn()'s stem-pin
// holds every taught path to, so these paths are accepted exactly as a real hook-taught one is.
const FIXTURE_PATH = `${SESSION}.jsonl`;
const OTHER_FIXTURE_PATH = `${OTHER_SESSION}.jsonl`;

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

/**
 * A queued mid-turn prompt in the real shape: the line Claude Code writes when the operator types
 * at the console while the model is working, carrying the top-level keys those lines carry.
 * `extra` replaces whole fields, `attachment` included, so a deviation is expressed as the one
 * field it deviates in.
 */
function queuedPrompt(
  text: string,
  sessionId: string = SESSION,
  extra: Record<string, unknown> = {},
): string {
  return line({
    parentUuid: "00000000-0000-4000-8000-000000000000",
    isSidechain: false,
    type: "attachment",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      origin: { kind: "human" },
      prompt: text,
    },
    uuid: "00000000-0000-4000-8000-000000000002",
    timestamp: "2026-08-08T00:00:00.000Z",
    sessionId,
    session_id: sessionId,
    cwd: "/repo",
    userType: "external",
    version: "fixture",
    gitBranch: "main",
    entrypoint: "cli",
    ...extra,
  });
}

/**
 * An `AskUserQuestion` call in the real shape: an assistant line whose content block is the
 * `tool_use` the console answers with a picker. `input` is passed through whole, so a malformed
 * shape is expressed as exactly the input that carries it; the well-formed case passes
 * `{ questions: [...] }`. An `input` of `undefined` produces a block with no input key at all,
 * because JSON.stringify drops the undefined field.
 */
function askUserQuestion(
  input: unknown,
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
      content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input }],
      stop_reason: null,
    },
    requestId: "req_fixture",
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000003",
    timestamp: "2026-08-08T00:00:00.000Z",
    sessionId,
    version: "fixture",
    gitBranch: "main",
    ...extra,
  });
}

/**
 * An assistant line carrying the two facts the session card reads: the model that produced the
 * turn, and the usage block whose three input figures sum to the live context size. The real shape,
 * with the sibling counters and the nested objects a live line carries, so a reader that summed the
 * wrong keys would be caught here.
 */
function assistantTurn(
  model: string,
  usage: Record<string, unknown>,
  text = "narration beside the reading",
  sessionId: string = SESSION,
): string {
  return line({
    parentUuid: "00000000-0000-4000-8000-000000000000",
    isSidechain: false,
    message: {
      model,
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: {
        output_tokens: 4_253,
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        ...usage,
      },
    },
    requestId: "req_fixture",
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000004",
    timestamp: "2026-08-09T00:00:00.000Z",
    sessionId,
    version: "fixture",
    gitBranch: "main",
  });
}

/**
 * The system line a forced downgrade writes, in the shape the two captured specimens carry.
 * `fields` replaces whole fields, so a record deviating in one of them is expressed as that one
 * field; the entitlement specimen carries no `scope` and no category at all, which is why the base
 * here is the refusal record and the consent case passes its own fields.
 */
function modelFallback(
  subtype: string,
  fields: Record<string, unknown> = {},
  sessionId: string = SESSION,
): string {
  return line({
    parentUuid: "00000000-0000-4000-8000-000000000000",
    isSidechain: false,
    type: "system",
    subtype,
    content: "Fable 5's safeguards flagged this message. Switched to Opus 4.8.",
    level: "warning",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    requestId: "req_fixture",
    apiRefusalCategory: "cyber",
    apiRefusalExplanation: null,
    retractedMessageUuids: ["00000000-0000-4000-8000-000000000009"],
    isMeta: false,
    uuid: "00000000-0000-4000-8000-000000000005",
    timestamp: "2026-08-09T00:00:00.000Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "/repo",
    sessionId,
    version: "fixture",
    gitBranch: "main",
    ...fields,
  });
}

function harness(overrides: Partial<TranscriptTailerOptions> = {}) {
  const posts: string[] = [];
  const prompts: string[] = [];
  const questions: (readonly AskedQuestion[])[] = [];
  /** The asks reported as answered at the console, in the order their resolution lines landed. */
  const consoleAnswers: (readonly AskedQuestion[])[] = [];
  /** All kinds in the order the tailer delivered them, which is transcript order. */
  const delivered: string[] = [];
  const logs: string[] = [];
  /** The card readings the tailer took, in transcript order, as the registry would be given them. */
  const readings: { sessionId: string; reading: ModelReading }[] = [];
  const fallbacks: { sessionId: string; fallback: ModelFallback }[] = [];
  const live = new Set<string>([SESSION]);
  const echo = createEchoMemory();
  const tailer = createTranscriptTailer({
    liveSessions: () => [...live],
    deliver: async (_sessionId, text) => {
      posts.push(text);
      delivered.push(`interim:${text}`);
      return { status: "sent" };
    },
    deliverPrompt: async (_sessionId, text) => {
      prompts.push(text);
      delivered.push(`prompt:${text}`);
      return { status: "sent" };
    },
    deliverQuestion: async (_sessionId, asked) => {
      questions.push(asked);
      delivered.push(`question:${asked.map((entry) => entry.question).join("|")}`);
      return { status: "sent" };
    },
    answeredAtConsole: (_sessionId, asked) => {
      consoleAnswers.push(asked);
      // Flipped nothing, the shape of a desk holding no record for this ask: the pass goes on to
      // the alert behind it.
      return false;
    },
    noteModel: (sessionId, reading) => {
      readings.push({ sessionId, reading });
    },
    noteFallback: (sessionId, fallback) => {
      fallbacks.push({ sessionId, fallback });
    },
    echo,
    log: (message) => logs.push(message),
    now: () => 1_000,
    ...overrides,
  });
  return {
    tailer,
    posts,
    prompts,
    questions,
    consoleAnswers,
    delivered,
    logs,
    readings,
    fallbacks,
    live,
    echo,
  };
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

test("text written after the allow verdict but before the first poll still posts", async () => {
  // A poll's own baseline lands past the model's first text most of the time: the poll ticks
  // every 20 seconds and the model's first text lands a few seconds after the prompt. Content is
  // set here strictly between allow() and the first poll, exactly that gap, and the read seam is
  // driven directly so the probe's own timing is exact rather than resting on real disk latency.
  const openingText = "the turn's opening narration";
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  // A macrotask boundary drains every microtask the probe's promise chain needs, so it observes
  // the file's empty state deterministically, before content changes, without depending on real
  // disk timing.
  await new Promise((resolve) => setImmediate(resolve));
  content = assistantText(openingText);
  await tailer.poll();
  assert.deepEqual(posts, [openingText], "the opening chunk must survive the baseline");
});

test("an allow arriving before the matching learn still baselines once the path is known", async () => {
  // /mirror (which allows) and /hook (which teaches the path) are independent routes with no
  // ordering guarantee between them, and after a restart mid-session the map starts empty, so
  // this ordering is live. The probe that closes the opening-narration gap has to fire from
  // whichever of the two completes the pair, not only from allow().
  const openingText = "narration after the path was learned";
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.allow(SESSION); // the mirror-on verdict, with no learned path yet: starts nothing
  tailer.learn(SESSION, FIXTURE_PATH); // the hook post that teaches it, moments later
  await new Promise((resolve) => setImmediate(resolve)); // lets the probe learn() starts settle
  content = assistantText(openingText);
  await tailer.poll();
  assert.deepEqual(posts, [openingText], "the path becoming known must still fire the probe");
});

test("an allow after the baseline is already set starts no new probe and does not move it", async () => {
  // A normal session is re-allowed at the top of every turn, for the life of the session. If a
  // later allow moved the baseline forward to the file's size at that moment, every turn after
  // the first would silently discard whatever narration had already accumulated since the last
  // poll.
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the still-empty file

  content = assistantText("narration written before the next turn's allow");
  tailer.allow(SESSION); // the routine re-allow at the top of the next turn
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration written before the next turn's allow"],
    "a second allow while already baselined must not re-baseline past content already appended",
  );
});

test("a session that is learned but never allowed gets no reads at all, probe included", async () => {
  let reads = 0;
  const { tailer, posts } = harness({
    readFile: async () => {
      reads += 1;
      return { size: 0, bytes: Buffer.alloc(0) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  await tailer.poll();
  await tailer.poll();

  assert.equal(reads, 0, "an unallowed session must never be probed or polled");
  assert.deepEqual(posts, []);
});

test("a path relearned while a probe is pending discards the stale probe's size", async () => {
  // allow() fires a probe against the first path; a relearn onto a second path arrives before
  // that probe answers. The stale size must not baseline the second path: adopting it would move
  // the baseline into a range the second path never actually had at that size, and a later poll
  // reading from that phantom offset would see the file as having shrunk and skip everything.
  let releaseStale: (slice: TranscriptSlice) => void = () => {};
  const staleGate = new Promise<TranscriptSlice>((resolve) => {
    releaseStale = resolve;
  });
  let calls = 0;
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      calls += 1;
      if (calls === 1) return staleGate;
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, `one/${FIXTURE_PATH}`);
  tailer.allow(SESSION); // fires the probe against the first path, held pending by staleGate
  // A macrotask boundary drains the microtask that actually dispatches the read, so the relearn
  // below lands while the probe is genuinely in flight, matching the real gap a hook post's own
  // round trip leaves.
  await new Promise((resolve) => setImmediate(resolve));

  tailer.learn(SESSION, `two/${FIXTURE_PATH}`); // relearns before the probe answers; offset resets
  // to null, and this itself starts the second path's own fresh probe, since the session is
  // already allowed.

  // The stale probe for the first path answers now, with a size that would, if adopted for the
  // second path, move the baseline into a range the second path never actually had at that size.
  releaseStale({ size: 999_999, bytes: Buffer.alloc(0) });
  await tailer.poll(); // settles the second path's own fresh probe; the stale one must not win
  assert.deepEqual(posts, [], "the fresh baseline itself consumes nothing");

  content = assistantText("narration after path-two was correctly baselined");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration after path-two was correctly baselined"],
    "a stale 999999-byte offset would have made this content unreachable",
  );
});

test("a probe rejection falls back to the poll-time baseline, republishing nothing older", async () => {
  let calls = 0;
  let content = "";
  const { tailer, posts, logs } = harness({
    readFile: async (_path, offset, maxBytes) => {
      calls += 1;
      if (calls === 1) throw new Error("probe exploded: SECRET-probe-failure");
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // the probe rejects; swallowed

  content = assistantText("already there before the fallback baseline runs");
  await tailer.poll(); // the fallback baseline captures this as already-had, at its own moment
  assert.deepEqual(posts, [], "the fallback baselines to what already exists, publishing none of it");

  content += assistantText("narration after the fallback baseline");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration after the fallback baseline"],
    "only what grew after the fallback's own baseline posts",
  );
  assert.ok(!logs.some((l) => l.includes("SECRET")), "the swallowed probe error must not reach the log");
});

test("a second allow while a probe is pending does not start a second probe", async () => {
  let probeCalls = 0;
  const { tailer } = harness({
    readFile: async (_path, _offset, maxBytes) => {
      if (maxBytes === 0) probeCalls += 1;
      return { size: 0, bytes: Buffer.alloc(0) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  tailer.allow(SESSION); // a probe is already pending; must not fire a second read
  // Asserted before any poll(): pollOne's own fallback baseline read is also a zero-byte read, so
  // counting past a poll would no longer isolate what the two allows alone did.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 1, "two allows before the probe resolved must fire only one probe read");
});

test("a probe resolving after forget dropped its session writes nothing, and a re-created session baselines fresh", async () => {
  // forget() deletes the entry from the tailer's map, so the pending probe's stale write targets
  // an object nothing reaches, harmlessly, but a session re-created under the same ID afterward is
  // a *different* object at that key, and must not inherit the dropped probe's size.
  let releaseStale: (slice: TranscriptSlice) => void = () => {};
  const staleGate = new Promise<TranscriptSlice>((resolve) => {
    releaseStale = resolve;
  });
  let calls = 0;
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      calls += 1;
      if (calls === 1) return staleGate;
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // fires the probe, held pending by staleGate
  // A macrotask boundary drains the microtask that actually dispatches the read, so the forget
  // below lands while the probe is genuinely in flight.
  await new Promise((resolve) => setImmediate(resolve));

  tailer.forget(SESSION); // drops the entry the pending probe targets

  // The stale probe answers now, well after its session was forgotten.
  releaseStale({ size: 999_999, bytes: Buffer.alloc(0) });

  // The session is re-created under the same ID, as a fresh SessionStart and hook post would.
  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // fires this entry's own, fresh probe

  await tailer.poll(); // lets the fresh probe settle, against still-empty content
  assert.deepEqual(posts, [], "the fresh baseline for the re-created session consumes nothing yet");

  content = assistantText("narration under the re-created session");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration under the re-created session"],
    "the re-created session must baseline fresh, not inherit the dropped probe's stale size",
  );
});

test("content written while suppressed is never published by the re-allow that follows", async () => {
  // suppress() drops the held offset, so a re-allow rebaselines instead of resuming into the
  // suppressed stretch: resuming from the old offset would publish everything the transcript grew
  // while the session was opted out, which is exactly what the mirror-off signal exists to hide.
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the empty file

  content = assistantText("narration before the mirror-off");
  await tailer.poll();
  assert.deepEqual(posts, ["narration before the mirror-off"]);

  tailer.suppress(SESSION);
  content += assistantText("narration written entirely during the suppressed window");
  await tailer.poll();
  await tailer.poll();
  assert.deepEqual(posts, ["narration before the mirror-off"], "nothing posts while suppressed");

  tailer.allow(SESSION);
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration before the mirror-off"],
    "the re-allow must not publish what grew during the suppressed window",
  );

  content += assistantText("narration after the re-allow");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration before the mirror-off", "narration after the re-allow"],
    "only content written after the re-allow's fresh baseline posts",
  );
});

test("a probe resolving after suppress arrived mid-flight writes no offset for the mirror-off session", async () => {
  // The interleaving is real, not theoretical: allow() and suppress() land on independent HTTP
  // requests, and the probe's own read is a real open, stat, and close, milliseconds wide rather
  // than a microtask. A probe whose read is already dispatched when suppress() arrives must not
  // still baseline the session it targets: writing an offset there, even one suppress() itself
  // would otherwise clear, would let a later re-allow's own probe find the field already occupied
  // and skip starting a fresh one, resuming instead from a point that predates the suppressed
  // window.
  let releaseProbe: (slice: TranscriptSlice) => void = () => {};
  const gate = new Promise<TranscriptSlice>((resolve) => {
    releaseProbe = resolve;
  });
  let dispatched = false;
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      if (!dispatched) {
        dispatched = true;
        return gate;
      }
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // dispatches the probe; its read is now genuinely in flight
  await new Promise((resolve) => setImmediate(resolve)); // lets the dispatch actually fire

  tailer.suppress(SESSION); // arrives while that same read is still outstanding

  content = assistantText("written entirely during the suppressed window");
  releaseProbe({ size: 0, bytes: Buffer.alloc(0) }); // the in-flight probe answers now, still suppressed
  // Lets the probe's resolution fully settle while the session is still suppressed, so the write
  // this test locks down is judged purely against the suppressed state, not raced by a re-allow
  // that would start its own, separate probe.
  await new Promise((resolve) => setImmediate(resolve));

  tailer.allow(SESSION); // mirroring resumes only now, after the stale probe already resolved
  await tailer.poll();
  assert.deepEqual(
    posts,
    [],
    "a probe settling while suppressed must not baseline the session for a mirror-off stretch",
  );
});

test("a probe resolving after suppress and an immediate re-allow, with no macrotask boundary between them, still writes no offset for the mirror-off session", async () => {
  // The un-serialized sibling of the test above: there the re-allow lands only after a setImmediate
  // gives the stale probe a chance to settle first, stepping around the tightest version of the
  // interleaving. Here suppress() and the re-allow land back to back in the same tick, and the
  // stale probe only answers afterward. Without the epoch, `allowed` alone reads as true again by
  // the time the stale probe checks it, and a corrupted, pre-suppression offset can leave the
  // fresh probe the re-allow starts finding the field already occupied and never dispatching its
  // own read at all.
  let releaseStale: (slice: TranscriptSlice) => void = () => {};
  const staleGate = new Promise<TranscriptSlice>((resolve) => {
    releaseStale = resolve;
  });
  let dispatched = false;
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      if (!dispatched) {
        dispatched = true;
        return staleGate;
      }
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // dispatches the stale probe; its read is now genuinely in flight
  await new Promise((resolve) => setImmediate(resolve)); // lets the dispatch actually fire

  tailer.suppress(SESSION); // arrives while that read is still outstanding
  content = assistantText("written entirely during the suppressed window");
  tailer.allow(SESSION); // re-allowed in the very same tick, with no macrotask boundary in between

  releaseStale({ size: 0, bytes: Buffer.alloc(0) }); // the stale probe answers only now
  await tailer.poll();
  assert.deepEqual(
    posts,
    [],
    "content written during the suppressed window must not post regardless of how tightly suppress and the re-allow interleave",
  );
});

test("a poll-time fallback baseline does not clobber a probe that raced it to a write", async () => {
  // pollOne's own fallback read fires only when nothing was pending on the entry at the moment it
  // checked; a probe an allow() starts while that fallback read is still in flight is not the one
  // pollOne awaited, since the fallback does not register itself on the entry the way a probe
  // does. The two reads race, and the fallback's own resolution must not overwrite whatever the
  // racing probe already wrote.
  let calls = 0;
  let releaseFallback: (slice: TranscriptSlice) => void = () => {};
  const fallbackGate = new Promise<TranscriptSlice>((resolve) => {
    releaseFallback = resolve;
  });
  let content = "";
  const { tailer, posts, logs } = harness({
    readFile: async (_path, offset, maxBytes) => {
      calls += 1;
      if (calls === 1) throw new Error("probe exploded: SECRET-probe-failure"); // the initial probe
      if (calls === 2) return fallbackGate; // pollOne's own fallback, held open
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // the initial probe
  // Lets the initial probe fully dispatch and reject before anything else happens, so what
  // pollOne finds pending on the entry, below, is genuinely nothing.
  await new Promise((resolve) => setImmediate(resolve));

  // poll() finds the entry unbaselined with nothing pending, and dispatches its own fallback
  // read, held open by fallbackGate.
  const firstPass = tailer.poll();

  content = assistantText("what the racing probe correctly observes");
  tailer.allow(SESSION); // a redundant re-allow while the fallback is still in flight
  // Lets the racing probe's own deferred dispatch and resolution settle, writing the offset
  // before the stale fallback answers.
  await new Promise((resolve) => setImmediate(resolve));

  releaseFallback({ size: 0, bytes: Buffer.alloc(0) }); // the stale fallback answers last
  await firstPass;

  await tailer.poll();
  assert.deepEqual(
    posts,
    [],
    "the stale fallback's write must not undo the racing probe's already-correct baseline",
  );
  assert.ok(!logs.some((l) => l.includes("SECRET")), "the swallowed probe error must not reach the log");
});

test("suppress landing during pollOne's own content read must not leave a slice-relative offset", async () => {
  // Before the epoch fix, `held.offset += lastNewline + 1` ran unconditionally after the content
  // read. If suppress() nulled `offset` while that read was still in flight, `null + n` evaluates
  // to `n`, silently turning an absolute file offset into a slice-relative one far smaller than
  // reality, and the next allowed poll would read from that phantom small offset and republish
  // most of the transcript's earlier history along with it.
  let releaseSecond: () => void = () => {};
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let tailReads = 0;
  let content = "";
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      if (maxBytes > 0) {
        tailReads += 1;
        // Read #1 is the empty-file baseline poll, #2 is the successful first-chunk read; #3 is
        // the one this test gates, so it lands mid-flight when suppress() arrives.
        if (tailReads === 3) await secondGate;
      }
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the empty file

  content = assistantText("the first chunk, already delivered before the gated read");
  await tailer.poll(); // the first real tail read; posts and moves the offset past this chunk
  assert.deepEqual(posts, ["the first chunk, already delivered before the gated read"]);

  content += assistantText("the second chunk, mid-flight when suppress lands");
  const pass = tailer.poll(); // dispatches the second tail read against the real held offset, gated

  tailer.suppress(SESSION); // nulls held.offset while that read is still outstanding
  releaseSecond(); // the gated read resolves now, still suppressed
  await pass;

  tailer.allow(SESSION); // re-allows; must rebaseline fresh, not resume from a corrupted small offset
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["the first chunk, already delivered before the gated read"],
    "the re-allow's own fresh baseline must consume the second chunk too, written while suppressed",
  );

  content += assistantText("narration after the re-allow's own baseline");
  await tailer.poll();
  assert.deepEqual(
    posts,
    [
      "the first chunk, already delivered before the gated read",
      "narration after the re-allow's own baseline",
    ],
    "a slice-relative offset would have republished the second chunk, and likely the first, again here",
  );
});

test("a learn onto a new path landing during pollOne's await of a stale probe must not baseline the new path with the old file's size", async () => {
  // pollOne captures its `path` argument once, from the moment pass() read `held.path`, and awaits
  // `held.probe` before anything else. A learn() onto a different path can land in that await:
  // pollOne's own fallback-baseline branch, reached once the stale probe settles, otherwise still
  // reads and writes against the path it captured, which is now the file this session left behind,
  // and would baseline the new path's entry with the old file's size instead of the new file's own.
  // Both probes are gated here, and released in a controlled order, so the old probe's resolution
  // (and whatever pollOne's own fallback does with it) is forced to land before the new path's own
  // probe gets a chance to establish the correct baseline first and mask the bug by winning a race.
  const oldPath = `old/${FIXTURE_PATH}`;
  const newPath = `new/${FIXTURE_PATH}`;
  let releaseOldProbe: (slice: TranscriptSlice) => void = () => {};
  const oldProbeGate = new Promise<TranscriptSlice>((resolve) => {
    releaseOldProbe = resolve;
  });
  let releaseNewProbe: (slice: TranscriptSlice) => void = () => {};
  const newProbeGate = new Promise<TranscriptSlice>((resolve) => {
    releaseNewProbe = resolve;
  });
  let oldDispatched = false;
  let newDispatched = false;
  const files: Record<string, string> = { [oldPath]: "x".repeat(9_999), [newPath]: "" };
  const { tailer, posts } = harness({
    readFile: async (path, offset, maxBytes) => {
      if (path === oldPath && !oldDispatched) {
        oldDispatched = true;
        return oldProbeGate;
      }
      if (path === newPath && !newDispatched) {
        newDispatched = true;
        return newProbeGate;
      }
      const bytes = Buffer.from(files[path] ?? "", "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, oldPath);
  tailer.allow(SESSION); // dispatches the baseline probe against oldPath, held open by oldProbeGate
  await new Promise((resolve) => setImmediate(resolve)); // lets that dispatch actually fire

  const pass = tailer.poll(); // pollOne captures path = oldPath and awaits the still-pending old probe

  tailer.learn(SESSION, newPath); // relearns; its own fresh probe dispatches too, held by newProbeGate
  await new Promise((resolve) => setImmediate(resolve)); // lets that dispatch actually fire as well

  releaseOldProbe({ size: files[oldPath].length, bytes: Buffer.alloc(0) }); // the stale probe answers
  // Lets pollOne's own resumption, and whatever it does once the stale probe settles, run to
  // completion before the new path's own probe is allowed to answer.
  await new Promise((resolve) => setImmediate(resolve));

  releaseNewProbe({ size: files[newPath].length, bytes: Buffer.alloc(0) }); // the new path's own probe answers only now
  await pass;

  files[newPath] = assistantText("the new path's own opening narration");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["the new path's own opening narration"],
    "the new path's own baseline must not have already skipped this past the old file's size",
  );
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
  const { tailer, posts, prompts } = harness();
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
      // An attachment of another type carrying an otherwise-valid queued-prompt payload: the
      // sharpest case for the second kind's allowlist, which keys on the attachment type.
      queuedPrompt("unused", SESSION, {
        attachment: {
          type: "selected_lines_in_ide",
          commandMode: "prompt",
          origin: { kind: "human" },
          prompt: "SECRET-other-attachment-type",
        },
      }) +
      line({ type: "system", content: "SECRET-system-line", sessionId: SESSION }) +
      line({ type: "custom-title", customTitle: "SECRET-title", sessionId: SESSION }) +
      // A withdrawn queue entry was never part of the conversation, whatever it carried.
      line({
        type: "queue-operation",
        operation: "remove",
        prompt: "SECRET-withdrawn-queue-entry",
        sessionId: SESSION,
      }) +
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
  assert.deepEqual(prompts, [], "no line outside the queued-prompt shape may post");

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

test("a mid-turn typed message is delivered as a queued prompt", async (t) => {
  // A message typed while the model is working fires no UserPromptSubmit and writes no user line,
  // so this attachment line is the only place it exists. The fixture is the shape Claude Code
  // writes for it.
  const file = transcriptFile(t);
  const { tailer, posts, prompts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, queuedPrompt("also check the migration order"), "utf8");
  await tailer.poll();

  assert.deepEqual(prompts, ["also check the migration order"]);
  assert.deepEqual(posts, [], "a queued prompt is not narration");
});

test("a queued prompt is matched on sessionId, whatever session_id says or omits", async (t) => {
  // Some of these lines carry a top-level session_id and some carry none, so `sessionId` is the
  // field the match reads. JSON.stringify drops the undefined key, which is the line with none.
  const file = transcriptFile(t);
  const { tailer, prompts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    queuedPrompt("a line carrying no session_id", SESSION, { session_id: undefined }) +
      queuedPrompt("a line whose session_id disagrees", SESSION, { session_id: OTHER_SESSION }),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(prompts, [
    "a line carrying no session_id",
    "a line whose session_id disagrees",
  ]);
});

test("a queued command deviating from the typed-prompt shape delivers nothing", async (t) => {
  // The allowlist criterion for the second line kind, driven one field per case. Three of these
  // are the live population rather than hypotheticals: the background-task notice is the dominant
  // queued_command line by an order of magnitude, the channel-origin line is the operator's own
  // Discord message the relay injected, and the object prompt rides with pasted images.
  const file = transcriptFile(t);
  const { tailer, posts, prompts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    queuedPrompt("unused", SESSION, {
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: "SECRET-background-task-notice",
      },
    }) +
      queuedPrompt("unused", SESSION, {
        isMeta: true,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "channel", server: "channel-relay" },
          prompt: "SECRET-channel-message",
        },
      }) +
      queuedPrompt("unused", SESSION, {
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "human" },
          prompt: { text: "SECRET-image-paste", imagePasteIds: ["paste_1"] },
        },
      }) +
      queuedPrompt("unused", SESSION, {
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "human" },
          prompt: "",
        },
      }) +
      // The foreign line's own session_id names this session, so a match reading that field
      // instead would publish another conversation's typed message into this thread.
      queuedPrompt("SECRET-foreign-session", OTHER_SESSION, { session_id: SESSION }) +
      queuedPrompt("SECRET-sidechain", SESSION, { isSidechain: true }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(prompts, [], "only the human-typed prompt shape may reach the thread");
  assert.deepEqual(posts, []);

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, queuedPrompt("a real typed message"), "utf8");
  await tailer.poll();
  assert.deepEqual(prompts, ["a real typed message"]);
});

test("a queued command missing the origin field entirely delivers nothing", async (t) => {
  // The only other deviant fixture missing `origin` (the task-notification one above) also fails
  // the earlier commandMode check, so it cannot alone prove the origin-object guard does anything.
  // This fixture is otherwise the full typed-prompt shape, commandMode "prompt" included, with
  // `origin` dropped rather than merely mismatched, so it reaches the origin guard and nothing
  // before it.
  const file = transcriptFile(t);
  const { tailer, posts, prompts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    queuedPrompt("unused", SESSION, {
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        prompt: "SECRET-no-origin-field",
      },
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(prompts, [], "a queued command with no origin field is not the human-typed shape");
  assert.deepEqual(posts, []);
  // A refusal, not a crash: reading `origin.kind` off a missing origin without first checking it is
  // an object would throw instead, which pollOne's own catch would report as a failed pass rather
  // than as the allowlist quietly yielding nothing.
  assert.ok(
    !logs.some((entry) => entry.includes("transcript pass failed")),
    `the line must be refused, not thrown past the allowlist: ${logs.join("\n")}`,
  );

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, queuedPrompt("a real typed message"), "utf8");
  await tailer.poll();
  assert.deepEqual(prompts, ["a real typed message"]);
});

test("an attachment line missing the attachment field entirely posts nothing", async (t) => {
  // No fixture elsewhere in this suite gives a `type: "attachment"` line a missing or non-object
  // `attachment` field while everything else about the line still matches (sessionId, isSidechain):
  // the closest deviation, the diagnostics-type attachment, still carries an attachment object.
  // Reading `attachment.type` off a missing attachment without first checking it is an object would
  // throw rather than refuse.
  const file = transcriptFile(t);
  const { tailer, posts, prompts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    line({
      parentUuid: "00000000-0000-4000-8000-000000000000",
      isSidechain: false,
      type: "attachment",
      uuid: "00000000-0000-4000-8000-000000000002",
      timestamp: "2026-08-08T00:00:00.000Z",
      sessionId: SESSION,
      version: "fixture",
      gitBranch: "main",
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(prompts, []);
  assert.deepEqual(posts, []);
  assert.ok(
    !logs.some((entry) => entry.includes("transcript pass failed")),
    `the line must be refused, not thrown past the allowlist: ${logs.join("\n")}`,
  );

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, queuedPrompt("a real typed message"), "utf8");
  await tailer.poll();
  assert.deepEqual(prompts, ["a real typed message"]);
});

test("an assistant line missing the message field entirely posts nothing", async (t) => {
  // No fixture elsewhere in this suite gives a `type: "assistant"` line a missing or non-object
  // `message` field: every assistant fixture, including the deviant-content-block ones, still
  // carries a message object. Reading `message.content` off a missing message without first
  // checking it is an object would throw rather than refuse.
  const file = transcriptFile(t);
  const { tailer, posts, prompts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    line({
      parentUuid: "00000000-0000-4000-8000-000000000000",
      isSidechain: false,
      type: "assistant",
      requestId: "req_fixture",
      uuid: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-08-07T00:00:00.000Z",
      sessionId: SESSION,
      version: "fixture",
      gitBranch: "main",
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(posts, []);
  assert.deepEqual(prompts, []);
  assert.ok(
    !logs.some((entry) => entry.includes("transcript pass failed")),
    `the line must be refused, not thrown past the allowlist: ${logs.join("\n")}`,
  );

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, assistantText("a real narration line"), "utf8");
  await tailer.poll();
  assert.deepEqual(posts, ["a real narration line"]);
});

test("a queued prompt between two assistant texts is delivered between them", async (t) => {
  // Transcript order across both kinds, from one pass: the operator's typed message belongs
  // between the narration it interrupted and the narration that followed it.
  const file = transcriptFile(t);
  const { tailer, delivered } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("reading the failing test") +
      queuedPrompt("check the migration order too") +
      assistantText("found the off-by-one"),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(delivered, [
    "interim:reading the failing test",
    "prompt:check the migration order too",
    "interim:found the off-by-one",
  ]);
});

test("a queued prompt that could not be delivered is dropped, not retried", async (t) => {
  // The rule the whole routing layer follows: a message that lands minutes late answers a
  // question the operator stopped asking. No digest is recorded either, because no other path
  // posts this text.
  const file = transcriptFile(t);
  const attempts: string[] = [];
  const { tailer } = harness({
    deliverPrompt: async (_sessionId, text) => {
      attempts.push(text);
      return { status: "no-thread" };
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, queuedPrompt("a message nobody saw"), "utf8");
  await tailer.poll();
  await tailer.poll();

  assert.deepEqual(attempts, ["a message nobody saw"], "the refused prompt is attempted once");
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

test("an AskUserQuestion call yields its questions, bounded and parsed, descriptions and all", async (t) => {
  // The real measured shape: 1 to 4 questions, each with a header, a multiSelect flag, and 2 to 4
  // options carrying a label and a description. The description rides along bounded, an absent one
  // reads as null, the header of the second entry is genuinely absent, and the parse is structured
  // data rather than text.
  const file = transcriptFile(t);
  const { tailer, questions, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({
      questions: [
        {
          question: "Ship the migration now or wait for the backup window?",
          header: "Timing",
          multiSelect: false,
          options: [
            { label: "Ship now (Recommended)", description: "the backup is an hour out" },
            { label: "Wait for the window", description: "d".repeat(400) },
          ],
        },
        {
          question: "Which hosts get the change?",
          multiSelect: true,
          options: [{ label: "NEO" }, { label: "TRINITY", description: "  " }],
        },
      ],
    }),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(questions, [
    [
      {
        question: "Ship the migration now or wait for the backup window?",
        header: "Timing",
        multiSelect: false,
        options: [
          { label: "Ship now (Recommended)", description: "the backup is an hour out" },
          // Bounded at the reader, at Discord's own ceiling on the field it renders in: nothing
          // reads a description but a display surface, and the whole message is refused when one
          // field is over its limit.
          { label: "Wait for the window", description: "d".repeat(100) },
        ],
      },
      {
        question: "Which hosts get the change?",
        header: null,
        multiSelect: true,
        options: [
          // Absent, and present-but-blank, both read as absent: a description that renders as
          // nothing is a description the call did not carry.
          { label: "NEO", description: null },
          { label: "TRINITY", description: null },
        ],
      },
    ],
  ]);
  assert.deepEqual(posts, [], "a question item is not narration");
});

test("a question line from a foreign session or a sidechain yields nothing", async (t) => {
  // The same two gates every yield sits behind: the question item must not widen what the
  // allowlist accepts.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "SECRET-foreign-question" }] }, OTHER_SESSION) +
      askUserQuestion({ questions: [{ question: "SECRET-sidechain-question" }] }, SESSION, {
        isSidechain: true,
      }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(questions, []);

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, askUserQuestion({ questions: [{ question: "the real question" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 1);
});

test("a tool_use of any other name is silent, even one carrying a valid questions input", async (t) => {
  // The sharpest near-miss is a name that contains the real one: an MCP-wrapped tool could call
  // itself anything, and a substring or prefix match would alert on input this build has never
  // modeled. The match is exact or it is nothing.
  const file = transcriptFile(t);
  const { tailer, questions, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    line({
      isSidechain: false,
      type: "assistant",
      sessionId: SESSION,
      message: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__helper__AskUserQuestion",
            input: { questions: [{ question: "SECRET-mcp-question" }] },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { questions: [{ question: "SECRET-bash-question" }] },
          },
        ],
      },
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(questions, []);
  assert.deepEqual(posts, []);
});

test("a malformed AskUserQuestion input yields silence, never a throw and never a guess", async (t) => {
  // The input is another program's tool-call format, driven one deviation per line: the block
  // with no input key at all, an input that is not an object, a missing and a non-array
  // `questions`, entries that are not objects, and entries without a readable `question` string.
  // Every one must be refused by the allowlist rather than thrown past it, which pollOne's own
  // catch would report as a failed pass.
  const file = transcriptFile(t);
  const { tailer, questions, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion(undefined) +
      askUserQuestion("SECRET-string-input") +
      askUserQuestion({}) +
      askUserQuestion({ questions: "SECRET-not-an-array" }) +
      askUserQuestion({ questions: ["SECRET-entry", 42, null, ["SECRET-array-entry"]] }) +
      askUserQuestion({
        questions: [
          { header: "a header with no question" },
          { question: "" },
          { question: "   " },
          { question: 42 },
          { question: null },
        ],
      }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(questions, [], "zero readable questions is allowlist silence");
  assert.ok(
    !logs.some((entry) => entry.includes("transcript pass failed")),
    `the lines must be refused, not thrown past the allowlist: ${logs.join("\n")}`,
  );
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));

  // The positive control: the pass over this same file is demonstrably live.
  appendFileSync(file, askUserQuestion({ questions: [{ question: "the real question" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 1);
});

test("questions past the first four are dropped, and a skipped entry spends its slot", async (t) => {
  // The bound reads the first four entries and then validates each, matching the tool's own
  // ceiling of four: a fifth entry is outside the read whether or not an earlier one was skipped,
  // so a malformed second entry costs its own slot rather than promoting the fifth in.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({
      questions: [
        { question: "first" },
        { header: "skipped: no question" },
        { question: "third" },
        { question: "fourth" },
        { question: "fifth, past the bound" },
        { question: "sixth, past the bound" },
      ],
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(
    questions.map((asked) => asked.map((entry) => entry.question)),
    [["first", "third", "fourth"]],
  );
});

test("option labels are bounded to the first four entries, unreadable ones skipped", async (t) => {
  // The same first-four-then-validate rule the questions bound follows: an option without a
  // readable label spends its slot, and a fifth option is outside the read either way.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({
      questions: [
        {
          question: "with deviant options",
          options: [
            { label: "one" },
            { label: "" },
            { label: 42 },
            { label: "two" },
            { label: "past the bound" },
          ],
        },
        {
          question: "with five readable options",
          options: [
            { label: "a" },
            { label: "b" },
            { label: "c" },
            { label: "d" },
            { label: "e, past the bound" },
          ],
        },
        { question: "with no options at all" },
        { question: "with options that are not an array", options: "SECRET-not-an-array" },
      ],
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(
    questions.map((asked) => asked.map((entry) => entry.options.map((option) => option.label))),
    [[["one", "two"], ["a", "b", "c", "d"], [], []]],
  );
});

test("a question of nothing but invisible characters is skipped, not delivered blank", async (t) => {
  // The renderer neutralizes by the invisible-stripped reading, so an entry that trims to nothing
  // under it would draw a blank Q line; the parse gates on the same reading, and a bare trim()
  // cannot, because the zero-width class is not whitespace. The invisibles ride in by code point,
  // never as raw bytes a reader cannot see in the source, and the readable entry beside them is
  // the positive control on the same line.
  const invisible = String.fromCharCode(0x200b, 0x202e, 0x200b);
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({
      questions: [{ question: invisible }, { question: "the readable question" }],
    }),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(
    questions.map((asked) => asked.map((entry) => entry.question)),
    [["the readable question"]],
  );
});

test("a refused question alert logs one bounded line; a no-thread drop logs nothing", async (t) => {
  // A `failed` result is the volume ceiling or a write Discord refused, and this alert is the
  // only signal a parked question sends anywhere, so the refusal must reach the log, bounded and
  // content-free. `no-thread` is the steady state of a broker running without Discord, and
  // logging it would write a line per question forever.
  const file = transcriptFile(t);
  let outcome: ReplyResult = { status: "no-thread" };
  let attempts = 0;
  const { tailer, posts, logs } = harness({
    deliverQuestion: async () => {
      attempts += 1;
      return outcome;
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "SECRET-unposted-question" }] }) +
      assistantText("narration after the no-thread drop"),
    "utf8",
  );
  await tailer.poll();
  assert.equal(attempts, 1);
  assert.deepEqual(posts, ["narration after the no-thread drop"], "the batch continues past the drop");
  assert.ok(
    !logs.some((entry) => entry.includes("question")),
    `a no-thread drop is not a log line: ${logs.join("\n")}`,
  );

  outcome = { status: "failed", error: "question alerts are over their window" };
  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "SECRET-refused-question" }] }) +
      assistantText("narration after the refusal"),
    "utf8",
  );
  await tailer.poll();
  assert.equal(attempts, 2);
  assert.deepEqual(posts, [
    "narration after the no-thread drop",
    "narration after the refusal",
  ]);
  assert.ok(logs.some((entry) => entry.includes("question alert was refused")), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));

  await tailer.poll();
  assert.equal(attempts, 2, "a refusal is dropped, never retried");
});

test("a question between two chunks is delivered between them, in transcript order", async (t) => {
  // The one-await-per-item rule across all three kinds: the alert lands where the transcript puts
  // it, between the narration that led to the question and whatever follows the answer.
  const file = transcriptFile(t);
  const { tailer, delivered } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("weighing the two options") +
      askUserQuestion({ questions: [{ question: "Proceed with the riskier one?" }] }) +
      assistantText("proceeding with the answer"),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(delivered, [
    "interim:weighing the two options",
    "question:Proceed with the riskier one?",
    "interim:proceeding with the answer",
  ]);
});

test("a question alert that throws is dropped unretried, logged bounded, and the batch continues", async (t) => {
  // The prompt branch's discipline: the failure is held to its own item, because the consumed
  // bytes are already behind the offset and a throw that escaped the loop would lose every later
  // item in the batch. The error is discarded unread; it can quote the question.
  const file = transcriptFile(t);
  let attempts = 0;
  const { tailer, posts, logs } = harness({
    deliverQuestion: async () => {
      attempts += 1;
      throw new Error("alert exploded while posting: SECRET-question-content");
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "SECRET-question-content" }] }) +
      assistantText("narration after the failed alert"),
    "utf8",
  );
  await tailer.poll();
  assert.equal(attempts, 1);
  assert.deepEqual(posts, ["narration after the failed alert"], "the rest of the batch still delivers");
  assert.ok(logs.some((entry) => entry.includes("question alert failed")), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));

  await tailer.poll();
  assert.equal(attempts, 1, "nothing is queued and nothing is retried");
});

test("a suppress landing during a question alert's delivery stops the batch behind it", async () => {
  // The mirror-off switch reaches every kind the batch carries, the question item included.
  // Driven through the injected `readFile` seam so the suppress lands inside the alert's own
  // gated delivery rather than merely near it.
  let content = "";
  const delivered: string[] = [];
  let releaseQuestion: () => void = () => {};
  const questionGate = new Promise<void>((resolve) => {
    releaseQuestion = resolve;
  });
  const { tailer } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
    deliver: async (_sessionId, text) => {
      delivered.push(`interim:${text}`);
      return { status: "sent" };
    },
    deliverQuestion: async (_sessionId, asked) => {
      await questionGate;
      delivered.push(`question:${asked.map((entry) => entry.question).join("|")}`);
      return { status: "sent" };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the still-empty content

  content =
    askUserQuestion({ questions: [{ question: "the open question" }] }) +
    assistantText("narration after it");
  const pass = tailer.poll(); // starts delivering the alert, gated by questionGate

  await new Promise((resolve) => setImmediate(resolve)); // lets the pass reach the gated call
  tailer.suppress(SESSION); // lands while the alert's own delivery is still in flight

  releaseQuestion();
  await pass;

  assert.deepEqual(
    delivered,
    ["question:the open question"],
    "a suppress landing mid-delivery must stop the batch after the item already in flight",
  );
});

test("question() posts through the same delivery seam, gated on the session's mirror verdict", async () => {
  // The hook intake hands an emission-time question here rather than wiring a delivery of its
  // own: the tailer holds the mirror verdict and the deliverQuestion seam, so the hook path rides
  // both, and a session with no verdict seen, or a suppressed one, contributes silence.
  const { tailer, questions } = harness();
  const asked: AskedQuestion[] = [
    {
      question: "Which beverage?",
      header: "Beverage",
      multiSelect: false,
      options: [
        { label: "Coffee", description: null },
        { label: "Tea", description: null },
      ],
    },
  ];

  // Each gate reports its silence, because the hold seam holds a question only where an alert
  // went out: a hold behind a dropped alert is a session parked on a question nobody was shown.
  assert.equal(tailer.question(SESSION, asked), false); // no verdict seen at all
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(questions, [], "a verdict-unseen session alerts nothing from the hook path");

  tailer.allow(SESSION);
  tailer.suppress(SESSION);
  assert.equal(tailer.question(SESSION, asked), false); // an explicit mirror-off
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(questions, [], "a suppressed session alerts nothing from the hook path");

  tailer.allow(SESSION);
  // Malformed input parses to nothing, and nothing is delivered.
  assert.equal(tailer.question(SESSION, []), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(questions, []);

  // The positive control: mirror-on, readable questions, a delivery dispatched.
  assert.equal(tailer.question(SESSION, asked), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(questions, [asked]);
});

test("a question the hook path already alerted is skipped exactly once by the transcript yield", async (t) => {
  // The double path: the hook alerts at emission, and the same question lands on the transcript
  // at answer time, up to hours later. The digest the hook path records answers for exactly that
  // one duplicate, on the echo memory's consume-on-match rule: left standing it would silence a
  // later turn genuinely asking the same question again.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "Ship it?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 1, "the emission-time alert posts once");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Ship it?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 1, "the resolution-time duplicate is consumed, not re-alerted");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Ship it?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 2, "the digest is one-shot: a later identical ask still alerts");
});

test("a question's resolution line reports the console answered it, once per line", async (t) => {
  // Claude Code writes this line when the picker closes, so the line is the console's answer
  // arriving. The desk holds the thread message that has been telling the operator to walk to that
  // console, and this is what lets it stop saying so.
  const file = transcriptFile(t);
  const { tailer, consoleAnswers } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "Ship it?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(consoleAnswers, [], "an ask still parked has not been answered anywhere");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Ship it?" }] }), "utf8");
  await tailer.poll();
  assert.deepEqual(
    consoleAnswers,
    [[{ question: "Ship it?", header: null, multiSelect: false, options: [] }]],
    "the resolution line reports the ask it names, in the bounded parse the desk digests",
  );

  // A poll over a file that has grown by nothing re-reads nothing, so the report is not repeated
  // and the message it flipped is not edited again.
  await tailer.poll();
  assert.equal(consoleAnswers.length, 1);
});

test("the console-answer report does not depend on the alert dedupe having a digest to consume", async (t) => {
  // The outstanding set is bounded and evicts, and the report is the desk's only signal that a
  // question stopped waiting: tying it to a digest that may have been pushed out would leave the
  // operator's phone showing a question the console answered an hour ago. A tailer-only question,
  // which is the same shape, reports too.
  const file = transcriptFile(t);
  const { tailer, consoleAnswers, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Never alerted?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 1, "with no digest outstanding the yield still alerts");
  assert.equal(consoleAnswers.length, 1, "and still reports the answer that closed the picker");
});

test("a flipped ask is not also alerted as one still waiting at the console", async (t) => {
  // The flip rewrites the ask's own message to say the console answered it. An alert behind that
  // flip posts the same ask into the same thread as a question still waiting there, contradicting
  // the message a line above it, and the record the flip consumed is gone so nothing corrects it.
  // The other direction is the test above: a report that flipped nothing still alerts.
  const file = transcriptFile(t);
  const { tailer, questions } = harness({ answeredAtConsole: () => true });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Ship it?" }] }), "utf8");
  await tailer.poll();
  assert.deepEqual(questions, [], "the flipped message is the report; a fresh alert would undo it");
});

test("the real desk flips a real released ask when its resolution line lands", async (t) => {
  // The cross-component pin over the digest, which is the only thing naming an ask across these two
  // modules. The desk digests the parse the hook handed it and the tailer digests the parse it read
  // off the transcript, so each side tested against its own literal would leave a mismatch between
  // the two invisible: here one real desk and one real tailer meet over the same ask, and the flip
  // happens or it does not.
  const file = transcriptFile(t);
  const terminals: Array<{ sessionId: string; state: QuestionTerminalState }> = [];
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    onTerminal: (sessionId, state) => terminals.push({ sessionId, state }),
    setTimer: () => ({}) as unknown as NodeJS.Timeout,
    clearTimer: () => {},
  });
  const { tailer } = harness({
    answeredAtConsole: (sessionId, questions) =>
      desk.answeredAtConsole(sessionId, questionDigest(questions)),
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  // The ask as the hook path delivers it, held and alerted, then released to the console.
  const payload = { questions: [{ question: "Ship it?", options: [{ label: "Now" }] }] };
  const parsed = askedQuestions(payload);
  const response = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead: () => response,
    end: () => {},
    once: () => response,
  };
  desk.hold(SESSION, parsed, payload.questions, response as unknown as ServerResponse, true);
  desk.noteAlert(SESSION, questionDigest(parsed), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  desk.release(SESSION);

  appendFileSync(file, askUserQuestion(payload), "utf8");
  await tailer.poll();
  assert.deepEqual(terminals, [
    { sessionId: SESSION, state: "released" },
    { sessionId: SESSION, state: "answered-at-console" },
  ]);
});

test("a throwing console-answer report costs the line, not the batch behind it", async (t) => {
  // Every seam this module calls out to is treated the same way: an injected failure is bounded to
  // a rate-limited line and the items after it still publish.
  const file = transcriptFile(t);
  const { tailer, posts, logs } = harness({
    answeredAtConsole: () => {
      throw new Error("the desk exploded");
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "Ship it?" }] }) + assistantText("and on we go"),
    "utf8",
  );
  await tailer.poll();
  assert.deepEqual(posts, ["and on we go"], "the batch continued past the failed report");
  assert.ok(
    logs.some((entry) => entry.includes("console-answer report failed")),
    logs.join("\n"),
  );
  assert.ok(
    logs.every((entry) => !entry.includes("Ship it?") && !entry.includes("exploded")),
    "no question text and no error detail reaches the log",
  );
});

test("a non-matching transcript question neither consumes the digest nor goes silent", async (t) => {
  // Consume-on-match only: a different question delivered while a hook digest stands must post,
  // and must leave the digest in place for the duplicate it actually answers for.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "First?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 1);

  appendFileSync(file, askUserQuestion({ questions: [{ question: "A different one?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 2, "a tailer-only question still alerts exactly as before");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "First?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 2, "the standing digest still answers for its own duplicate");
});

test("a hook alert that did not land records no digest, leaving the transcript yield armed", async (t) => {
  // Drop-not-retry on the hook path must not also disarm the fallback: a refused or thrown alert
  // never reached the operator, so the resolution-time yield is still the question's one signal.
  const file = transcriptFile(t);
  let outcome: ReplyResult = { status: "failed", error: "question alerts are over their window" };
  let attempts = 0;
  const { tailer, logs } = harness({
    deliverQuestion: async () => {
      attempts += 1;
      return outcome;
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "Parked?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.ok(logs.some((entry) => entry.includes("question alert was refused")), logs.join("\n"));

  outcome = { status: "sent" };
  appendFileSync(file, askUserQuestion({ questions: [{ question: "Parked?" }] }), "utf8");
  await tailer.poll();
  assert.equal(attempts, 2, "the failed hook alert must not have consumed the tailer's fallback");
});

test("each outstanding question dedupes independently: a second ask does not evict the first", async (t) => {
  // The reachable duplicate a one-slot digest produces: Q1 alerts at emission, the operator
  // answers it, and before the next poll consumes Q1's resolution line the model asks Q2. Both
  // resolution lines must find their own digests waiting, and each match consumes exactly the
  // digest it matched.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "First?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  tailer.question(SESSION, [{ question: "Second?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 2, "two distinct questions alert once each at emission");

  appendFileSync(
    file,
    askUserQuestion({ questions: [{ question: "First?" }] }) +
      askUserQuestion({ questions: [{ question: "Second?" }] }),
    "utf8",
  );
  await tailer.poll();
  assert.equal(questions.length, 2, "both resolution lines are duplicates of their own emission alerts");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "First?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 3, "each digest is one-shot: a later identical ask still alerts");
});

test("a re-posted identical question is not alerted twice by the hook path", async (t) => {
  // The CLI retries a hook post it could not land, for hours when it comes to that, so the same
  // PreToolUse payload can arrive again while its first alert's digest is still outstanding. A
  // digest already in the set means this exact question already reached the operator.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  const asked: AskedQuestion[] = [{ question: "Still there?", header: null, multiSelect: false, options: [] }];
  assert.equal(tailer.question(SESSION, asked), true, "the first post dispatches a delivery");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    tailer.question(SESSION, asked), // the retry of the same post
    false,
    "and the retry reports that it dispatched none, which is what keeps a hold off it",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 1, "a re-posted identical question is the same question, not a new alert");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Still there?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 1, "the resolution line is still the one duplicate the digest answers for");

  tailer.question(SESSION, asked); // a genuinely new identical ask, after the digest was consumed
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 2);
});

test("two identical asks racing inside one delivery flight record one digest, not two", async (t) => {
  // The pre-dispatch skip reads the set before the awaited delivery writes it, so two identical
  // question() calls landing while the first alert is still in flight both pass it and both
  // deliver: that duplicate ping is the accepted window. What must not happen is a duplicate
  // record: the resolution line consumes exactly one copy, and a stale survivor would silence a
  // later identical question's only alert, a lost question rather than a duplicate ping.
  const file = transcriptFile(t);
  const alerts: string[] = [];
  let release: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tailer } = harness({
    deliverQuestion: async (_sessionId, asked) => {
      await inFlight;
      alerts.push(asked.map((entry) => entry.question).join("|"));
      return { status: "sent" };
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  const asked: AskedQuestion[] = [{ question: "Race?", header: null, multiSelect: false, options: [] }];
  tailer.question(SESSION, asked);
  tailer.question(SESSION, asked); // lands before the first delivery resolves: no digest exists yet
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 2, "the in-flight race is the accepted duplicate-ping window");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Race?" }] }), "utf8");
  await tailer.poll();
  assert.equal(alerts.length, 2, "the resolution line is consumed against the one recorded digest");

  tailer.question(SESSION, asked); // a genuinely new identical ask, after the resolution consumed
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 3, "no stale second copy survives to swallow the new ask's alert");
});

test("suppress drops the outstanding digests with the offset: no stale digest outlives its window", async (t) => {
  // A suppressed window swallows the resolution lines the digests were waiting for, so a digest
  // kept across it would mis-consume a later identical question's only alert: the same
  // silence-over-stale-state direction suppress already takes with the offset.
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "Again?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 1);

  tailer.suppress(SESSION); // the window that would have swallowed the resolution line
  tailer.allow(SESSION);
  await tailer.poll(); // rebaselines at the file's current end

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Again?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 2, "the later identical ask is a new question, not the old one's echo");
});

test("a path change through learn drops the outstanding digests with the offset", async (t) => {
  // A new path is a new transcript, and the resolution lines the outstanding digests were
  // waiting for belong to the file being left behind: a digest kept across the change would
  // mis-consume a later identical question's only alert, the direction suppress() documents.
  // Both paths carry the session's own stem, so the stem-pin accepts the change.
  const fileA = transcriptFile(t);
  const fileB = transcriptFile(t); // its own temp directory, same <session-id>.jsonl filename
  const { tailer, questions } = harness();
  tailer.learn(SESSION, fileA);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.question(SESSION, [{ question: "Moved?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 1);

  tailer.learn(SESSION, fileB); // the path change: the old file's resolution lines are unreachable now
  await tailer.poll(); // rebaselines against the new file

  tailer.question(SESSION, [{ question: "Moved?", header: null, multiSelect: false, options: [] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(questions.length, 2, "the identical ask after the change is a new question, not the old one's echo");
});

test("the outstanding set is bounded: past the cap the oldest is evicted, costing a duplicate, never a lost question", async (t) => {
  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  for (let index = 0; index < 9; index += 1) {
    tailer.question(SESSION, [{ question: `Q${index}?`, header: null, multiSelect: false, options: [] }]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(questions.length, 9, "nine distinct questions alert once each");

  // Q0's digest was evicted by the ninth ask, so its resolution line alerts again: eviction's
  // cost is one duplicate ping. Q1's digest survived and is consumed by its own line.
  appendFileSync(file, askUserQuestion({ questions: [{ question: "Q0?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 10, "the evicted digest's line is the duplicate the cap trades for boundedness");

  appendFileSync(file, askUserQuestion({ questions: [{ question: "Q1?" }] }), "utf8");
  await tailer.poll();
  assert.equal(questions.length, 10, "a digest inside the cap still consumes its own duplicate");
});

test("the hook payload and the transcript line parse to the same bounded questions", async (t) => {
  // Single-sourcing pin: the intake reads tool_input through the same exported reader the tailer
  // reads a tool_use block's input through, so the two surfaces cannot drift. The input here is
  // the captured live PreToolUse payload's shape: four options with descriptions, one question.
  const input = {
    questions: [
      {
        question: "Test question: which beverage should power this morning's session?",
        header: "Beverage",
        options: [
          { label: "Coffee (Recommended)", description: "The classic." },
          { label: "Tea", description: "Gentler ramp-up." },
          { label: "Water", description: "Hydration-first strategy." },
          { label: "Energy drink", description: "Maximum throughput now." },
        ],
        multiSelect: false,
      },
    ],
  };
  const viaHook = askedQuestions(input);
  assert.equal(viaHook.length, 1, "the captured shape must be readable");

  const file = transcriptFile(t);
  const { tailer, questions } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();
  appendFileSync(file, askUserQuestion(input), "utf8");
  await tailer.poll();
  assert.deepEqual(questions, [viaHook], "one reader, one reading, on both paths");
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
    backgroundTasks: null,
  });
  const posts: string[] = [];
  const edits: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      return { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async (input) => {
      edits.push(input.text);
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
    deliverPrompt: (sessionId, text) => outbound.interimPrompt(sessionId, text),
    // The router carries no question path; index.ts wires this seam to the steering writer
    // instead, so a stub keeps this helper about the dedup seam the two halves really share.
    deliverQuestion: async () => ({ status: "sent" }),
    answeredAtConsole: () => false,
    echo,
    now: () => 1_000,
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  return { file, tailer, outbound, posts, edits };
}

test("a queued prompt takes its place on the thread between the chunks it interrupted", async (t) => {
  // End to end over the seam index.ts wires: the tailer's second item kind reaches the thread
  // through the router's queued-prompt path, rendered as the operator's own words, in the order
  // the transcript recorded.
  const { file, tailer, posts } = integration(t);
  await tailer.poll();

  appendFileSync(
    file,
    assistantText("reading the failing test") +
      queuedPrompt("check the migration order too") +
      assistantText("found the off-by-one"),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(posts, [
    renderMirror("interim", "reading the failing test")[0],
    renderMirror("prompt", "check the migration order too")[0],
    renderMirror("interim", "found the off-by-one")[0],
  ]);
});

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
  // untouched: only the text both paths carry is suppressed. The two chunks coalesce into one
  // narration message, the first by post and the second by edit, so both are on the thread.
  const { file, tailer, outbound, posts, edits } = integration(t);
  await tailer.poll();

  const final = "The build is green.";
  appendFileSync(file, assistantText("Running the suite now.") + assistantText(final), "utf8");
  await tailer.poll();
  assert.equal(posts.length, 1, posts.join("\n---\n"));
  assert.equal(edits.length, 1, "the second chunk grows the first's message in place");
  assert.ok(edits[0].includes(final), edits[0]);

  await outbound.mirror(TOKEN, "reply", final, SESSION);
  assert.equal(posts.length, 1, "the final text arrived once by each path and landed once in total");
  assert.equal(edits.length, 1);
});

test("after a mirror suppressed as the answer's echo, the tailer does not re-post the text", async (t) => {
  // The three-way interplay on a turn that closes with the reply tool: the answer posts, the
  // Stop mirror carrying the same text is suppressed against it, and the suppression still
  // records the reply digest so the tailer reading that text off the transcript skips it too.
  // Without that record, the suppressed mirror's text would come back as narration a poll later.
  const { file, tailer, outbound, posts } = integration(t);
  await tailer.poll();

  const final = "Done: the migration is green and pushed.";
  appendFileSync(file, assistantText(final), "utf8");
  assert.deepEqual(await outbound.reply(TOKEN, final), { status: "sent" });
  assert.deepEqual(posts, [renderAnswer(final)[0]]);

  assert.deepEqual(await outbound.mirror(TOKEN, "reply", final, SESSION), { status: "sent" });
  assert.equal(posts.length, 1, "the mirror matching the answer is the suppressible copy");

  await tailer.poll();
  assert.equal(posts.length, 1, `the reply must post exactly once: ${posts.join("\n---\n")}`);
});

test("a poll landing between the answer and the Stop mirror still nets one copy", async (t) => {
  // The tailer-first ordering: the turn's closing text reaches the transcript before the Stop
  // mirror posts it, and a poll in that window finds neither the interim nor the reply digest.
  // The answer record is what catches it: the chunk is skipped (the reply-tool message already
  // carries the text), the skip records the interim digest, and the Stop mirror that follows is
  // suppressed through the interim-echo path. Ordinary narration around it is untouched. The
  // edits are watched beside the posts, because a chunk that slipped through here would land by
  // append into the narration block rather than as a fresh message.
  const { file, tailer, outbound, posts, edits } = integration(t);
  await tailer.poll();

  const final = "Done: the migration is green and pushed.";
  assert.deepEqual(await outbound.reply(TOKEN, final), { status: "sent" });
  assert.deepEqual(posts, [renderAnswer(final)[0]]);

  // A non-matching mid-turn chunk still narrates: the record only answers for the closing text.
  appendFileSync(file, assistantText("Running the last check now."), "utf8");
  await tailer.poll();
  assert.equal(posts.length, 2, posts.join("\n---\n"));

  appendFileSync(file, assistantText(final), "utf8");
  await tailer.poll();
  assert.equal(posts.length, 2, "the closing text is already on the thread as the answer");
  assert.deepEqual(edits, [], "the closing text must not grow the narration block either");

  assert.deepEqual(await outbound.mirror(TOKEN, "reply", final, SESSION), { status: "sent" });
  assert.equal(posts.length, 2, `one copy of the closing text in total: ${posts.join("\n---\n")}`);
  assert.deepEqual(edits, []);
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

/** A close-out message of the register a reply-tool answer carries; the answer record's fixture. */
const CLOSEOUT = [
  "Shipped: the dedup wiring is in, the echo memory carries the answer record beside its two",
  "digests, and the mirror consults it after the tailer check. Both gates ran clean on the first",
  "try, and the only surprise was the renderer escaping a fence marker mid-paragraph, which the",
  "existing tests already pinned.",
].join(" ");

/** The same close-out with one word swapped: near enough that the sketch must call it a match. */
const REWORDED_CLOSEOUT = CLOSEOUT.replace("Both gates ran clean", "The gates ran clean");

test("the answer record matches exactly or nearly, consumes on match, and holds one answer", () => {
  const echo = createEchoMemory();
  echo.noteAnswer(SESSION, CLOSEOUT);
  assert.equal(
    echo.isAnswerEcho(SESSION, "a wholly different sentence about nothing shared"),
    false,
    "a miss answers false and must not consume the record",
  );
  assert.equal(echo.isAnswerEcho(SESSION, REWORDED_CLOSEOUT), true, "a light rewording matches");
  assert.equal(echo.isAnswerEcho(SESSION, REWORDED_CLOSEOUT), false, "the answer record answers once");

  // A text too short for word shingles compares exactly, by digest, and the next answer replaces
  // the record rather than standing beside it: one record per session, never a blocklist.
  echo.noteAnswer(SESSION, "first answer");
  echo.noteAnswer(SESSION, "second answer");
  assert.equal(echo.isAnswerEcho(SESSION, "first answer"), false, "a replaced answer is gone");
  assert.equal(echo.isAnswerEcho(SESSION, "second answer"), true);
});

test("forget and sweep drop the answer record with the session", () => {
  const echo = createEchoMemory();
  echo.noteAnswer(SESSION, "the answer");
  echo.forget(SESSION);
  assert.equal(echo.isAnswerEcho(SESSION, "the answer"), false);

  echo.noteAnswer(SESSION, "the answer");
  echo.sweep(new Set());
  assert.equal(echo.isAnswerEcho(SESSION, "the answer"), false);
});

test("an answer grown past the length allowance is refused without spending the record", () => {
  // The close-out plus one new sentence: measured at similarity 0.862 against the answer, above
  // the 0.85 threshold, and at 1.166 times its normalized length, past the 1.1 allowance. The
  // sketch alone would call it a match; the length guard is the only thing refusing it, and the
  // refusal must not consume the record, because no suppression happened.
  const amended = `${CLOSEOUT} Also: the token file needs rotating before Friday.`;
  const echo = createEchoMemory();
  echo.noteAnswer(SESSION, CLOSEOUT);
  assert.equal(echo.isAnswerEcho(SESSION, amended), false, "the added sentence must reach the operator");
  assert.equal(echo.isAnswerEcho(SESSION, CLOSEOUT), true, "the refusal left the record standing");
});

test("clearAnswer drops the record unread, and clearing an absent one is a no-op", () => {
  const echo = createEchoMemory();
  echo.noteAnswer(SESSION, CLOSEOUT);
  echo.clearAnswer(SESSION);
  assert.equal(echo.isAnswerEcho(SESSION, CLOSEOUT), false);
  echo.clearAnswer("never-seen-session");
});

test("a suppress landing in the same tick as the allow that preceded it means the file is never opened", async (t) => {
  // The -NoMirror escape covers mid-turn text too, and it is honored before the read rather than
  // after: a session that opted out of mirroring must not have its file opened at all, even when
  // an earlier post had allowed it. `allow`, `suppress`, and both `poll()` calls below run back to
  // back with no macrotask boundary between them, so this pins the same-tick ordering; the
  // deferred-probe tests elsewhere in this file cover a suppress landing after the probe's read
  // has already been dispatched.
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

test("a tail read reachable only through a corrupted offset must never surface bytes written during the suppressed window", async () => {
  // Pinned on the bytes the injected readFile actually returned, not on `posts`: the content
  // grown here belongs to a foreign session, which the lineItems allowlist filters from
  // `posts` regardless of whether the file was ever touched for it. Asserting `posts` stays empty
  // alone would pass identically whether the suppressed-window bytes were read and then filtered,
  // or never read at all; only counting bytes actually read off the transcript proves the latter.
  let releaseStale: (slice: TranscriptSlice) => void = () => {};
  const staleGate = new Promise<TranscriptSlice>((resolve) => {
    releaseStale = resolve;
  });
  let dispatched = false;
  let content = "";
  let tailBytesRead = 0;
  const { tailer, posts } = harness({
    readFile: async (_path, offset, maxBytes) => {
      if (!dispatched) {
        dispatched = true;
        return staleGate;
      }
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      if (maxBytes > 0) tailBytesRead += length;
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION); // dispatches the stale probe; its read is now genuinely in flight
  await new Promise((resolve) => setImmediate(resolve));

  tailer.suppress(SESSION);
  // A foreign session's line: lineItems filters it out by sessionId either way, so a `posts`
  // assertion alone cannot tell a read that touched these bytes from one that never started.
  content = assistantText("SECRET-foreign-session-content-written-while-suppressed", OTHER_SESSION);
  tailer.allow(SESSION); // re-allowed in the same tick, before the stale probe has any chance to settle

  releaseStale({ size: 0, bytes: Buffer.alloc(0) }); // the stale probe answers now, after the re-allow
  await tailer.poll();

  assert.equal(
    tailBytesRead,
    0,
    "the re-allow's own fresh baseline must never read the bytes written while suppressed, filtered or not",
  );
  assert.deepEqual(posts, [], "the foreign session's line is filtered by the allowlist either way");
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
  const missingDir = transcriptDir(t);
  const missing = path.join(missingDir, FIXTURE_PATH); // never created on disk
  const { tailer, posts, logs } = harness();
  tailer.learn(SESSION, missing);
  tailer.allow(SESSION);
  await tailer.poll();
  assert.deepEqual(posts, []);
  assert.ok(logs.length > 0, "an unreadable transcript must be visible in the log");
  assert.ok(!logs.join("\n").includes(missingDir), `the path is content-adjacent and stays out: ${logs.join("\n")}`);

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

test("learn() refuses a path whose filename stem is not the session id, keeping the prior path", async (t) => {
  // The measured invariant: a session's transcript is <session-id>.jsonl, and every credited hook
  // payload teaches the parent's own path. A path that breaks the invariant (an agent-*.jsonl
  // sidechain file, or any upstream shape change) must not re-aim the tailer: the entry keeps
  // reading the file it already trusts, and the refusal leaves one bounded line naming the
  // session and never the path.
  const file = transcriptFile(t);
  const agentPath = path.join(path.dirname(file), "agent-0a1b2c3d.jsonl");
  writeFileSync(agentPath, assistantText("SECRET-sidechain-content"), "utf8");
  const { tailer, posts, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  tailer.learn(SESSION, agentPath); // refused: the stem is not the session id
  appendFileSync(file, assistantText("narration on the session's own transcript"), "utf8");
  await tailer.poll();
  assert.deepEqual(
    posts,
    ["narration on the session's own transcript"],
    "the entry must keep its prior path; an accepted relearn would have reset the offset and read the wrong file",
  );
  assert.ok(
    logs.some((entry) => entry.includes("filename is not its own session id")),
    `the refusal must be visible in the log: ${logs.join("\n")}`,
  );
  assert.ok(!logs.join("\n").includes("agent-0a1b2c3d"), `the refused path never reaches the log: ${logs.join("\n")}`);
  assert.ok(!logs.join("\n").includes("SECRET"), logs.join("\n"));
});

test("a stem-refused path for a session with no path yet teaches nothing and reads nothing", async () => {
  let reads = 0;
  const { tailer, logs } = harness({
    readFile: async () => {
      reads += 1;
      return { size: 0, bytes: Buffer.alloc(0) };
    },
  });
  tailer.allow(SESSION);
  tailer.learn(SESSION, "agent-0a1b2c3d.jsonl");
  await tailer.poll();
  assert.equal(reads, 0, "a refused path must never be probed or polled");
  assert.ok(logs.some((entry) => entry.includes("filename is not its own session id")), logs.join("\n"));
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

test("a pass held open past the watchdog threshold logs one rate-limited line; a normal pass logs nothing", async (t) => {
  // The visibility line a wedged pass owes the log: a pass legitimately outlasts one interval
  // when Discord is slow, so the threshold sits at several intervals, and past it each poll tick
  // reports the pass still running, through the repeat limiter so a long wedge is one line a
  // window rather than a line a tick.
  const file = transcriptFile(t);
  let at = 0;
  let gated = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tailer, logs } = harness({
    now: () => at,
    passWatchdogMs: 5_000,
    deliver: async (_sessionId, _text) => {
      if (gated) await gate;
      return { status: "sent" };
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll(); // the baseline pass, quick and quiet

  appendFileSync(file, assistantText("a quick chunk"), "utf8");
  await tailer.poll(); // a normal pass: starts and settles with nothing logged
  assert.equal(logs.length, 0, "a pass inside the threshold owes the log nothing");

  gated = true;
  appendFileSync(file, assistantText("the chunk whose delivery wedges"), "utf8");
  const wedged = tailer.poll();
  await new Promise((resolve) => setImmediate(resolve));

  at += 4_000;
  void tailer.poll(); // still inside the threshold: no line yet
  assert.equal(logs.length, 0);

  at += 2_000; // 6s into a 5s threshold
  void tailer.poll();
  assert.equal(
    logs.filter((entry) => entry.includes("running past the watchdog threshold")).length,
    1,
    `the wedged pass must be visible: ${logs.join("\n")}`,
  );

  at += 1_000; // a repeat inside the limiter's window is counted, not written
  void tailer.poll();
  assert.equal(logs.filter((entry) => entry.includes("running past the watchdog threshold")).length, 1);

  release();
  await wedged;
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

test("poll() does not settle while a probe an allow() started from inside the same pass, after its own session's closure already returned, is still reading", async () => {
  // The pass's own per-session closures only await the probe a session already held when the
  // closure ran. Here OTHER_SESSION's probe is started from inside SESSION's own `deliver` call,
  // mid-pass, well after SESSION's per-session closure has already returned from `pollOne`.
  // Nothing in the pass itself ever awaits that probe; only poll()'s drain of `pendingProbes`
  // does. Deleting the drain entirely would leave this poll() settling before the probe's read
  // resolves.
  let releaseProbe: (slice: TranscriptSlice) => void = () => {};
  const probeGate = new Promise<TranscriptSlice>((resolve) => {
    releaseProbe = resolve;
  });
  let probeStarted = false;
  let content = "";
  const deliveries: string[] = [];
  const { tailer } = harness({
    readFile: async (readPath, offset, maxBytes) => {
      if (readPath === OTHER_FIXTURE_PATH) {
        probeStarted = true;
        return probeGate;
      }
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
    deliver: async (sessionId, text) => {
      deliveries.push(text);
      if (sessionId === SESSION) {
        tailer.learn(OTHER_SESSION, OTHER_FIXTURE_PATH);
        tailer.allow(OTHER_SESSION); // starts the late probe this test pins
      }
      return { status: "sent" };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines SESSION against the still-empty content

  content = assistantText("the chunk whose delivery starts the late probe");
  const pass = tailer.poll();

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["the chunk whose delivery starts the late probe"]);
  assert.equal(probeStarted, true, "the late-started probe must have dispatched its read");

  let settled = false;
  void pass.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "poll() must not settle while the late-started probe still holds a file handle");

  releaseProbe({ size: 0, bytes: Buffer.alloc(0) });
  await pass;
  assert.equal(settled, true);
});

test("a suppress landing during chunk 1's delivery stops the batch: chunk 2 and later never post", async () => {
  // Neither the `if (!stillValid()) return` check nor the epoch it reads has any other test that
  // fails without it: deleting the check leaves the suite green, because every other test either
  // suppresses before delivery starts or never delivers a multi-chunk batch at all. This drives a
  // three-chunk batch, driving the injected `readFile` seam directly so the content read settles
  // on a microtask rather than real disk latency, and lands the suppress mid-flight of the first
  // chunk's own gated `deliver` call.
  let content = "";
  const deliveries: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { tailer } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
    deliver: async (_sessionId, text) => {
      if (deliveries.length === 0) await firstGate;
      deliveries.push(text);
      return { status: "sent" };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the still-empty content

  content = assistantText("chunk one") + assistantText("chunk two") + assistantText("chunk three");
  const pass = tailer.poll(); // starts delivering chunk one, gated by firstGate

  await new Promise((resolve) => setImmediate(resolve)); // lets the pass reach the gated deliver call
  tailer.suppress(SESSION); // lands while chunk one's own deliver call is still in flight

  releaseFirst();
  await pass;

  assert.deepEqual(
    deliveries,
    ["chunk one"],
    "a suppress landing mid-delivery must stop the batch after the chunk already in flight",
  );
});

test("a suppress landing during a queued prompt's delivery stops the batch behind it", async () => {
  // The mirror-off switch reaches every kind the batch carries. Driven through the injected
  // `readFile` seam so the suppress lands inside the prompt's own gated delivery rather than
  // merely near it.
  let content = "";
  const delivered: string[] = [];
  let releasePrompt: () => void = () => {};
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const { tailer } = harness({
    readFile: async (_path, offset, maxBytes) => {
      const bytes = Buffer.from(content, "utf8");
      const length = Math.max(Math.min(bytes.length - offset, maxBytes), 0);
      return { size: bytes.length, bytes: bytes.subarray(offset, offset + length) };
    },
    deliver: async (_sessionId, text) => {
      delivered.push(`interim:${text}`);
      return { status: "sent" };
    },
    deliverPrompt: async (_sessionId, text) => {
      await promptGate;
      delivered.push(`prompt:${text}`);
      return { status: "sent" };
    },
  });

  tailer.learn(SESSION, FIXTURE_PATH);
  tailer.allow(SESSION);
  await tailer.poll(); // baselines against the still-empty content

  content = queuedPrompt("the typed message") + assistantText("narration after it");
  const pass = tailer.poll(); // starts delivering the prompt, gated by promptGate

  await new Promise((resolve) => setImmediate(resolve)); // lets the pass reach the gated call
  tailer.suppress(SESSION); // lands while the prompt's own delivery is still in flight

  releasePrompt();
  await pass;

  assert.deepEqual(
    delivered,
    ["prompt:the typed message"],
    "a suppress landing mid-delivery must stop the batch after the item already in flight",
  );
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
    deliverPrompt: async (_sessionId, text) => {
      if (explode) throw new Error(`prompt delivery exploded while posting: ${text}`);
      return { status: "sent" };
    },
    deliverQuestion: async (_sessionId, asked) => {
      if (explode) throw new Error(`question alert exploded while posting: ${asked[0]?.question}`);
      return { status: "sent" };
    },
    answeredAtConsole: (_sessionId, asked) => {
      if (explode) throw new Error(`the console-answer report exploded on: ${asked[0]?.question}`);
      return false;
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
  appendFileSync(
    file,
    assistantText("SECRET-exploding-chunk") +
      queuedPrompt("SECRET-exploding-prompt") +
      askUserQuestion({ questions: [{ question: "SECRET-exploding-question" }] }),
    "utf8",
  );
  await tailer.poll();
  // A shrink whose replacement content is itself a secret.
  writeFileSync(file, "SECRET-shrunk-away\n", "utf8");
  await tailer.poll();

  const captured = logs.join("\n");
  assert.ok(!captured.includes("SECRET"), `transcript content leaked into the log: ${captured}`);
  assert.ok(logs.length > 0, "expected content-free lines to prove the logger was live");
});

test("an assistant line reports the model that ran it and the context its usage adds up to", async (t) => {
  const file = transcriptFile(t);
  const { tailer, readings } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    assistantTurn("claude-fable-5", {
      input_tokens: 2,
      cache_creation_input_tokens: 61_378,
      cache_read_input_tokens: 120_000,
    }),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(readings, [
    { sessionId: SESSION, reading: { model: "claude-fable-5", contextTokens: 181_380 } },
  ]);
});

test("a line missing the model or any one usage figure reports nothing at all", async (t) => {
  const file = transcriptFile(t);
  const { tailer, readings, posts } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    // The line every existing fixture writes: a model and no usage block at all.
    assistantText("narration with no usage block") +
      assistantTurn("claude-fable-5", { cache_read_input_tokens: undefined }, "a missing figure") +
      assistantTurn(
        "",
        { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
        "no model at all",
      ) +
      assistantTurn(
        "claude-fable-5",
        { input_tokens: "2", cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
        "a figure that is not a number",
      ) +
      // 1e999 is what JSON.parse reads as Infinity, which would render as a context of Infinity
      // tokens and never age out of the card.
      assistantTurn(
        "claude-fable-5",
        { input_tokens: 1e999, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
        "a figure that is not finite",
      ),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(readings, [], "the allowlist yields on the whole shape or on nothing");
  assert.equal(posts.length, 5, "the narration on those lines still reaches the thread");
});

test("both forced-downgrade subtypes are read, the entitlement one included", async (t) => {
  // The entitlement record is the one an operator can act on, and it carries no `scope` and no
  // category at all: a reader keyed to the refusal record's fields misses it entirely.
  const file = transcriptFile(t);
  const { tailer, fallbacks } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    modelFallback("model_refusal_fallback") +
      modelFallback("model_consent_fallback", {
        content: "Switched to Opus 5 (1M context) for this session · Fable 5 requires usage credits",
        trigger: undefined,
        direction: undefined,
        scope: undefined,
        apiRefusalCategory: undefined,
        apiRefusalExplanation: undefined,
        retractedMessageUuids: undefined,
        choice: "cancelled",
        fallbackModel: "claude-opus-5[1m]",
        persistedAsDefault: false,
      }),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(fallbacks, [
    {
      sessionId: SESSION,
      fallback: {
        cause: "refusal",
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        category: "cyber",
        choice: null,
      },
    },
    {
      sessionId: SESSION,
      fallback: {
        cause: "consent",
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-5[1m]",
        category: null,
        choice: "cancelled",
      },
    },
  ]);
});

test("an entitlement downgrade carries the marker onto the card, category or no category", async (t) => {
  // End to end over the seam index.ts wires: the entitlement record names the model the session
  // opened with, the assistant line behind it names the decorated fallback, and the card says the
  // session is running below what it opened with for as long as it stays there.
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
    backgroundTasks: null,
  });
  const { tailer } = harness({
    noteModel: (sessionId, reading) => {
      registry.noteModel(sessionId, reading);
    },
    noteFallback: (sessionId, fallback) => registry.noteFallback(sessionId, fallback),
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    modelFallback("model_consent_fallback", {
      trigger: undefined,
      direction: undefined,
      scope: undefined,
      apiRefusalCategory: undefined,
      apiRefusalExplanation: undefined,
      retractedMessageUuids: undefined,
      choice: "cancelled",
      fallbackModel: "claude-opus-5[1m]",
      persistedAsDefault: false,
    }) +
      assistantTurn("claude-opus-5[1m]", {
        input_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 61_376,
      }),
    "utf8",
  );
  await tailer.poll();

  const record = registry.list()[0];
  assert.equal(record.openingModel, "claude-fable-5");
  assert.equal(record.model, "claude-opus-5[1m]");
  assert.equal(record.contextTokens, 61_380);
  const card = renderCard(toView(record), "working", 1_000);
  // The decoration reaches the card as its own characters: the row is inside the fence, where
  // Discord renders no markdown, so the brackets need no escape and get none.
  assert.match(card, /^Model {5}⚠ claude-opus-5\[1m\] · ctx 61k$/m);
  assert.match(card, /^Down from claude-fable-5$/m, "and what it came down from is its own row");
});

test("a malformed downgrade record contributes nothing and never throws", async (t) => {
  const file = transcriptFile(t);
  const { tailer, fallbacks, readings, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    // A subtype this build has never seen, each half of the model pair missing on its own, a record
    // whose models are not strings, one whose name is too long to be a name, and a line that is not
    // JSON at all: the shape is upstream's and can move without notice.
    modelFallback("model_something_new") +
      modelFallback("model_refusal_fallback", { originalModel: undefined }) +
      modelFallback("model_refusal_fallback", { fallbackModel: undefined }) +
      modelFallback("model_refusal_fallback", { originalModel: { name: "claude-fable-5" } }) +
      modelFallback("model_consent_fallback", { fallbackModel: "m".repeat(200) }) +
      modelFallback("model_refusal_fallback", { sessionId: OTHER_SESSION }) +
      modelFallback("model_refusal_fallback", { isSidechain: true }) +
      "{not json at all\n",
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(fallbacks, []);
  assert.deepEqual(readings, []);
  assert.deepEqual(logs, [], "a shape this reader does not admit is silence, not a report");
});

test("a prototype key is not a downgrade subtype", async (t) => {
  // The subtype allowlist is a plain object, and a bare index into one answers prototype keys:
  // `FALLBACK_CAUSES["constructor"]` is a function, not undefined, so without an own-key check a
  // line naming one of these subtypes would store a ModelFallback whose cause is a function or
  // Object.prototype, and that value would ride into the registry and the state file.
  const file = transcriptFile(t);
  const { tailer, fallbacks, logs } = harness();
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    modelFallback("constructor") +
      modelFallback("__proto__") +
      modelFallback("toString") +
      modelFallback("valueOf") +
      modelFallback("hasOwnProperty"),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(fallbacks, [], "a prototype key must read as a subtype this build does not know");
  assert.deepEqual(logs, []);
});

test("a note that throws costs its own reading and not the narration behind it", async (t) => {
  // The bytes a pass consumed are already past the offset, so a throw escaping the item loop would
  // lose every chunk behind it with no way to read them again.
  const file = transcriptFile(t);
  const { tailer, posts, logs } = harness({
    noteModel: () => {
      throw new Error("the registry exploded on claude-fable-5");
    },
    noteFallback: () => {
      throw new Error("the registry exploded on the downgrade record");
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  appendFileSync(
    file,
    modelFallback("model_refusal_fallback") +
      assistantTurn(
        "claude-fable-5",
        { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
        "narration on the line that carried the reading",
      ) +
      assistantText("narration behind the reading"),
    "utf8",
  );
  await tailer.poll();

  assert.deepEqual(posts, [
    "narration on the line that carried the reading",
    "narration behind the reading",
  ]);
  assert.equal(logs.length, 2, logs.join("\n"));
  assert.ok(!logs.join("\n").includes("claude-fable-5"), logs.join("\n"));
});

test("the marker stands across the polls that follow the change, not only the one it landed on", async (t) => {
  // The acceptance is duration: a session below the model it opened with carries the marker for as
  // long as it stays there, so the passes after the change are where a marker that only fired at the
  // transition would be seen to have gone.
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
    backgroundTasks: null,
  });
  const changes: string[] = [];
  const { tailer } = harness({
    noteModel: (sessionId, reading) => {
      for (const change of registry.noteModel(sessionId, reading)) {
        changes.push(`${change.from}->${change.to}`);
      }
    },
    // Both seams announce, as the broker wires them: the record-first order releases its change
    // from noteModel, the transition-first order from noteFallback.
    noteFallback: (sessionId, fallback) => {
      const change = registry.noteFallback(sessionId, fallback);
      if (change !== null) changes.push(`${change.from}->${change.to}`);
    },
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  await tailer.poll();

  const turn = (model: string, text: string): string =>
    assistantTurn(
      model,
      { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 61_376 },
      text,
    );
  const marked = (rendered: string): void => {
    assert.match(rendered, /^Model {5}⚠ claude-opus-4-8/m);
    assert.match(rendered, /^Down from claude-fable-5 · flagged cyber$/m);
  };

  appendFileSync(file, turn("claude-fable-5", "before the downgrade"), "utf8");
  await tailer.poll();
  assert.ok(!renderCard(toView(registry.list()[0]), "working", 1_000).includes("Down from"));

  appendFileSync(
    file,
    modelFallback("model_refusal_fallback") + turn("claude-opus-4-8", "the turn that was retried"),
    "utf8",
  );
  await tailer.poll();
  marked(renderCard(toView(registry.list()[0]), "working", 1_000));

  // The polls that follow, each reading the same model off the lines the session keeps writing.
  for (const text of ["an hour later", "and later still"]) {
    appendFileSync(file, turn("claude-opus-4-8", text), "utf8");
    await tailer.poll();
    marked(renderCard(toView(registry.list()[0]), "working", 1_000));
  }

  assert.deepEqual(changes, ["claude-fable-5->claude-opus-4-8"], "one change, however many polls");
});
