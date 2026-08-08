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
import os from "node:os";
import path from "node:path";
import { MAX_TAIL_READ_BYTES, createEchoMemory, createTranscriptTailer } from "./tail.ts";
import type { TranscriptSlice, TranscriptTailerOptions } from "./tail.ts";
import { renderAnswer, renderMirror } from "./discord/render.ts";
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

  tailer.learn(SESSION, "fixture-path");
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
  tailer.learn(SESSION, "fixture-path"); // the hook post that teaches it, moments later
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "path-one");
  tailer.allow(SESSION); // fires the probe against path-one, held pending by staleGate
  // A macrotask boundary drains the microtask that actually dispatches the read, so the relearn
  // below lands while the probe is genuinely in flight, matching the real gap a hook post's own
  // round trip leaves.
  await new Promise((resolve) => setImmediate(resolve));

  tailer.learn(SESSION, "path-two"); // relearns before the probe answers; offset resets to null,
  // and this itself starts path-two's own fresh probe, since the session is already allowed.

  // The stale probe for path-one answers now, with a size that would, if adopted for path-two,
  // move the baseline into a range path-two never actually had at that size.
  releaseStale({ size: 999_999, bytes: Buffer.alloc(0) });
  await tailer.poll(); // settles path-two's own fresh probe; the stale one must not win the write
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
  tailer.allow(SESSION); // fires the probe, held pending by staleGate
  // A macrotask boundary drains the microtask that actually dispatches the read, so the forget
  // below lands while the probe is genuinely in flight.
  await new Promise((resolve) => setImmediate(resolve));

  tailer.forget(SESSION); // drops the entry the pending probe targets

  // The stale probe answers now, well after its session was forgotten.
  releaseStale({ size: 999_999, bytes: Buffer.alloc(0) });

  // The session is re-created under the same ID, as a fresh SessionStart and hook post would.
  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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
  const oldPath = "old-path";
  const newPath = "new-path";
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
    echo,
    now: () => 1_000,
  });
  tailer.learn(SESSION, file);
  tailer.allow(SESSION);
  return { file, tailer, outbound, posts, edits };
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
  // grown here belongs to a foreign session, which the assistantTexts allowlist filters from
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

  tailer.learn(SESSION, "fixture-path");
  tailer.allow(SESSION); // dispatches the stale probe; its read is now genuinely in flight
  await new Promise((resolve) => setImmediate(resolve));

  tailer.suppress(SESSION);
  // A foreign session's line: assistantTexts filters it out by sessionId either way, so a `posts`
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
      if (readPath === "other-path") {
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
        tailer.learn(OTHER_SESSION, "other-path");
        tailer.allow(OTHER_SESSION); // starts the late probe this test pins
      }
      return { status: "sent" };
    },
  });

  tailer.learn(SESSION, "fixture-path");
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

  tailer.learn(SESSION, "fixture-path");
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
