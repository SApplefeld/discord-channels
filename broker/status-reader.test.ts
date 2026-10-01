// The status reader. These tests drive real files in a real temp directory, as the tailer's do: the
// contract this module is most exposed to is the line shape Claude Code actually writes. Fixture
// lines carry the real keys, nesting and types, with synthetic content, and every transcript is
// named `<session-id>.jsonl`, because the reader refuses any other filename stem.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusReader } from "./status-reader.ts";
import type { StatusReader } from "./status-reader.ts";
import { HARNESS_RESUMED, renderCard, renderHarnessNotice } from "./discord/render.ts";
import { toView } from "./discord/state.ts";
import { createRegistry } from "./registry.ts";
import { createReceiptTracker, STAGE_EMOJI } from "./routing/receipts.ts";
import type { MessageReactions } from "./discord/transport.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import { MAX_TAIL_READ_BYTES } from "./tail.ts";

const SESSION = "0f3c9d21-2222-4000-8000-000000000003";
const OTHER = "0f3c9d21-2222-4000-8000-000000000004";
const RELAY = "plugin:relay:channel-relay";
const STAMP = "2026-09-30T13:15:30.000Z";
const STAMP_MS = Date.parse(STAMP);

type ErrorLine = {
  requestId?: string | null;
  status?: unknown;
  rateLimits?: unknown;
  retryInMs?: unknown;
  timestamp?: unknown;
  message?: string;
  formatted?: string;
  sessionId?: string;
};

/** A harness `api_error` line in the shape the harness writes, with each field overridable. */
function apiError(options: ErrorLine = {}): string {
  const error: Record<string, unknown> = {
    status: options.status ?? 429,
    connection: null,
    isNetworkDown: false,
    rateLimits:
      options.rateLimits === undefined
        ? { rateLimitType: "five_hour", resetsAt: Math.floor(Date.UTC(2026, 9, 1, 3, 0) / 1000) }
        : options.rateLimits,
    noResponse: null,
    message: options.message ?? "You've hit your limit",
    formatted: options.formatted ?? "You've hit your limit",
  };
  if (options.requestId !== null) error["requestId"] = options.requestId ?? "req_alpha";
  return (
    JSON.stringify({
      parentUuid: "p",
      isSidechain: false,
      type: "system",
      subtype: "api_error",
      level: "error",
      error,
      retryInMs: options.retryInMs ?? 30_000,
      retryAttempt: 3,
      maxRetries: 10,
      source: "request_retry",
      timestamp: options.timestamp ?? STAMP,
      uuid: "u",
      sessionId: options.sessionId ?? SESSION,
    }) + "\n"
  );
}

function assistantText(text: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: SESSION,
      timestamp: STAMP,
      message: { model: "claude-x", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

/** The assistant line a failed request ends with: flagged at the root, written in place of output. */
function apiErrorMessage(): string {
  return (
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: SESSION,
      timestamp: STAMP,
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 429" }] },
    }) + "\n"
  );
}

function consolePrompt(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      isSidechain: false,
      sessionId: SESSION,
      timestamp: STAMP,
      message: { role: "user", content: text },
    }) + "\n"
  );
}

/** The line a Discord message injected mid-turn writes. */
function queuedChannel(timestamp: string, server = RELAY, sessionId = SESSION): string {
  return (
    JSON.stringify({
      type: "attachment",
      isSidechain: false,
      sessionId,
      timestamp,
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        prompt: "<channel source=\"relay\">please look</channel>",
        origin: { kind: "channel", server },
      },
    }) + "\n"
  );
}

/** The line a Discord message writes when it opens a turn on an idle session. */
function channelTurnOpen(timestamp: string, content: unknown = "<channel>please look</channel>"): string {
  return (
    JSON.stringify({
      type: "user",
      isSidechain: false,
      sessionId: SESSION,
      timestamp,
      promptSource: "system",
      isMeta: true,
      origin: { kind: "channel", server: RELAY },
      message: { role: "user", content },
    }) + "\n"
  );
}

/** Lets the reader's fire-and-forget posts settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

type Harness = {
  file: string;
  reader: StatusReader;
  notices: string[];
  episodes: Array<string | null>;
  pickups: Array<{ sessionId: string; at: number }>;
  logs: string[];
  live: Set<string>;
  /** Appends lines, runs one pass and lets its posts settle. */
  feed: (...lines: string[]) => Promise<void>;
};

async function harness(
  t: TestContext,
  existing = "",
  overrides: {
    notePickup?: (sessionId: string, at: number) => void;
    notice?: (sessionId: string, text: string) => Promise<unknown>;
    now?: () => number;
    timeZone?: string;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, existing, "utf8");
  const notices: string[] = [];
  const episodes: Array<string | null> = [];
  const pickups: Array<{ sessionId: string; at: number }> = [];
  const logs: string[] = [];
  const live = new Set([SESSION]);
  const reader = createStatusReader({
    currentSessions: () => [...live],
    notice:
      overrides.notice ??
      (async (_sessionId, text) => {
        notices.push(text);
      }),
    notePickup: overrides.notePickup ?? ((sessionId, at) => pickups.push({ sessionId, at })),
    episode: (_sessionId, open) => episodes.push(open === null ? null : open.text),
    log: (message) => logs.push(message),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    timeZone: overrides.timeZone ?? "UTC",
  });
  reader.learn(SESSION, file);
  // The baseline: the first pass waits for the probe `learn` started and acts on nothing before it.
  await reader.poll();
  const feed = async (...lines: string[]): Promise<void> => {
    appendFileSync(file, lines.join(""), "utf8");
    await reader.poll();
    await settle();
  };
  return { file, reader, notices, episodes, pickups, logs, live, feed };
}

const FIVE_HOUR_NOTICE = renderHarnessNotice(
  {
    rateLimited: true,
    rateLimitType: "five_hour",
    status: 429,
    retryAt: STAMP_MS + 30_000,
    resetsAt: Date.UTC(2026, 9, 1, 3, 0),
  },
  "UTC",
);

test("twenty retries under one request id post one notice, and the next assistant line posts one Resumed", async (t) => {
  const h = await harness(t);
  await h.feed(...Array.from({ length: 20 }, () => apiError()));
  await h.feed(assistantText("back to work"));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED]);
  assert.equal(FIVE_HOUR_NOTICE, "Rate-limited (five-hour limit). Retrying at 1:16 PM, limit resets 3:00 AM.");
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null], "the card line opens once and closes once");
});

test("while an episode is open every error line folds into it, whatever its request id or none", async (t) => {
  const h = await harness(t);
  // Each retry attempt is a new request with a new id, so a second id is the same episode retrying.
  await h.feed(apiError({ requestId: "req_a" }), apiError({ requestId: "req_a" }), apiError({ requestId: null }));
  await h.feed(apiError({ requestId: "req_b", status: 529, rateLimits: null }));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "a second id while the episode is open posts nothing");
  assert.deepEqual(
    h.episodes,
    [FIVE_HOUR_NOTICE, "API error (status 529). Retrying at 1:16 PM."],
    "only the card line moves, to what the latest line renders",
  );
  await h.feed(assistantText("ok"));
  // With none open, a line with no id opens an episode, and an id after it folds in.
  await h.feed(apiError({ requestId: null, status: 529, rateLimits: null }), apiError({ requestId: "req_c" }));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED, "API error (status 529). Retrying at 1:16 PM."]);
});

test("two episodes separated by output post two notices and two Resumed lines", async (t) => {
  const h = await harness(t);
  await h.feed(apiError({ requestId: "req_a" }), apiError({ requestId: "req_b" }));
  await h.feed(assistantText("back"));
  await h.feed(apiError({ requestId: "req_c" }), apiError({ requestId: "req_d" }), assistantText("back again"));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED, FIVE_HOUR_NOTICE, HARNESS_RESUMED]);
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null, FIVE_HOUR_NOTICE, null]);
});

test("the card line follows the latest retry time without a second post, and an identical line changes nothing", async (t) => {
  const h = await harness(t);
  const later = renderHarnessNotice(
    {
      rateLimited: true,
      rateLimitType: "five_hour",
      status: 429,
      retryAt: STAMP_MS + 90_000,
      resetsAt: Date.UTC(2026, 9, 1, 3, 0),
    },
    "UTC",
  );
  assert.notEqual(later, FIVE_HOUR_NOTICE, "the precondition: the later retry renders differently");
  await h.feed(apiError({ requestId: "req_a", retryInMs: 30_000 }), apiError({ requestId: "req_b", retryInMs: 90_000 }));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "the thread notice stays one per episode");
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, later], "the card line moves to the later retry time");
  await h.feed(apiError({ requestId: "req_b", retryInMs: 90_000 }));
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, later], "a line rendering the same text reports nothing");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE]);
});

test("a new turn closes an open episode without posting Resumed", async (t) => {
  const h = await harness(t);
  await h.feed(apiError());
  h.reader.turnOpened(SESSION, STAMP_MS + 60_000);
  await settle();
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null], "the card line and the ⚠️ swap are cleared");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "and nothing says resumed");
  await h.feed(assistantText("the new turn's output"));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "output after the close finds no episode to resume");
});

test("error lines stamped before a new turn's floor open nothing, and a line after it opens a fresh episode", async (t) => {
  const h = await harness(t);
  const floor = STAMP_MS + 60_000;
  await h.feed(apiError());
  // The old turn's last error lines reach the file before the turn closes, and a later pass reads them.
  appendFileSync(h.file, apiError({ retryInMs: 40_000 }) + apiError({ retryInMs: 50_000 }), "utf8");
  h.reader.turnOpened(SESSION, floor);
  await h.feed();
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null], "the stale lines neither reopen nor fold");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE]);

  const fresh = new Date(floor + 1_000).toISOString();
  await h.feed(apiError({ timestamp: fresh }));
  const freshNotice = renderHarnessNotice(
    {
      rateLimited: true,
      rateLimitType: "five_hour",
      status: 429,
      retryAt: floor + 1_000 + 30_000,
      resetsAt: Date.UTC(2026, 9, 1, 3, 0),
    },
    "UTC",
  );
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, freshNotice], "a line after the floor opens a fresh episode");
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null, freshNotice]);

  // A line with no readable instant cannot be placed against the floor, and is acted on as before.
  await h.feed(assistantText("back"));
  await h.feed(apiError({ timestamp: 12 }));
  assert.equal(h.notices.length, 4, h.notices.join("\n"));
});

test("a channel turn-opening line closes the open episode silently, and a queued channel message does not", async (t) => {
  const h = await harness(t);
  await h.feed(apiError());
  await h.feed(queuedChannel("2026-09-30T13:16:00.000Z"));
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE], "a message injected mid-turn is no new turn");
  const opening = "2026-09-30T13:20:00.000Z";
  await h.feed(channelTurnOpen(opening));
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null], "a channel message opening a turn closes the episode");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "with no Resumed");
  assert.deepEqual(
    h.pickups.map((pickup) => pickup.at),
    [Date.parse("2026-09-30T13:16:00.000Z"), Date.parse(opening)],
    "both lines still credit pickup",
  );
  // The turn-opening line's own instant is the floor.
  await h.feed(apiError({ timestamp: "2026-09-30T13:19:00.000Z" }));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE]);
});

test("a session's posts start in order, each after the one before it settles", async (t) => {
  const started: string[] = [];
  let releaseFirst = (): void => {};
  const h = await harness(t, "", {
    notice: (_sessionId, text) => {
      started.push(text);
      // The first post is held open; any later one resolves at once.
      return started.length === 1 ? new Promise<void>((resolve) => (releaseFirst = resolve)) : Promise.resolve();
    },
  });
  // The episode opens and closes inside one slice, so both posts are made in one pass.
  await h.feed(apiError(), assistantText("back"));
  assert.deepEqual(started, [FIVE_HOUR_NOTICE], "the Resumed line waits for the notice to settle");
  let drained = false;
  const drain = h.reader.drain().then(() => (drained = true));
  await settle();
  assert.equal(drained, false, "drain waits on the held post");
  releaseFirst();
  await drain;
  assert.deepEqual(started, [FIVE_HOUR_NOTICE, HARNESS_RESUMED]);
});

test("a failed request's own isApiErrorMessage assistant line is not output and closes nothing", async (t) => {
  const h = await harness(t);
  await h.feed(apiError(), apiErrorMessage());
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "no Resumed for the error's own terminal record");
  await h.feed(assistantText("real output"));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED]);
});

test("a render that throws leaves no episode open, so no Resumed follows a notice that was never posted", async (t) => {
  // An unknown zone makes Intl.DateTimeFormat throw inside the render.
  const h = await harness(t, "", { timeZone: "Not/AZone" });
  await h.feed(apiError());
  await h.feed(assistantText("back"));
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.episodes, [], "no episode was recorded open, and none is closed");
});

test("a pickup line stamped ahead of the host clock credits pickup at now, not at its stamp", async (t) => {
  const NOW = STAMP_MS + 60_000;
  const h = await harness(t, "", { now: () => NOW });
  await h.feed(queuedChannel(new Date(NOW + 3_600_000).toISOString()), channelTurnOpen(STAMP));
  assert.deepEqual(h.pickups, [
    { sessionId: SESSION, at: NOW },
    { sessionId: SESSION, at: STAMP_MS },
  ], "a past stamp passes through unchanged");
});

test("no text from an error line reaches a notice, the card or the log, and the same check catches a planted leak", async (t) => {
  const planted = ["PLANTEDBOLD", "424242", "everyone", "planted.example", "PLANTEDFORMAT", "PLANTEDTYPE"];
  const h = await harness(t);
  await h.feed(
    apiError({
      requestId: "req_planted_424242",
      message: "**PLANTEDBOLD** <@424242> @everyone see https://planted.example/x [link](https://planted.example)",
      formatted: "PLANTEDFORMAT <@&424242>",
      rateLimits: { rateLimitType: "PLANTEDTYPE <@424242>", resetsAt: 1_790_000_000 },
    }),
  );
  // The card the notice reaches, rendered from a registry record fed the way the broker feeds it.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  registry.apply({
    event: "SessionStart",
    processToken: "5f0c2e4a-0000-4000-8000-0000000000ab",
    sessionName: "persona",
    lineage: null,
    sessionId: SESSION,
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
  registry.noteHarnessNotice(SESSION, h.episodes[0] ?? null);
  const card = renderCard(toView(registry.list()[0]), "working", Date.now());
  const surfaces = [...h.notices, card, ...h.logs];
  const leaks = (texts: readonly string[]): string[] =>
    planted.filter((fragment) => texts.some((text) => text.includes(fragment)));

  assert.equal(h.notices.length, 1, "the error still posted its notice");
  assert.ok(card.includes("⚠️"), "and the card carries it");
  assert.deepEqual(leaks(surfaces), [], "predicate: any planted fragment in any notice, card or log line");
  // The control: the same predicate over the same set, with one leaked fragment planted, speaks.
  assert.deepEqual(leaks([...surfaces, "a line quoting <@424242>"]), ["424242"]);
});

test("a mirror-off transcript holding assistant text, a typed prompt and an error line yields only the fixed-wording notice", async (t) => {
  const h = await harness(t);
  await h.feed(
    assistantText("PLANTED assistant prose that must stay private"),
    consolePrompt("PLANTED operator prompt that must stay private"),
    apiError(),
  );
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE]);
  assert.deepEqual(h.pickups, [], "a console prompt is no channel pickup");
  assert.ok(!h.logs.some((line) => line.includes("PLANTED")));
});

test("a mid-turn channel injection moves its message from 📨 to 👀 and posts nothing", async (t) => {
  const THREAD = "thread-status";
  const calls: Array<{ kind: "add" | "remove"; emoji: string }> = [];
  const reactions: MessageReactions = {
    addReaction: async (input) => {
      calls.push({ kind: "add", emoji: input.emoji });
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
    removeReaction: async (input) => {
      calls.push({ kind: "remove", emoji: input.emoji });
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const tracker = createReceiptTracker({ reactions, log: () => {}, now: Date.now });
  const deliveredAt = STAMP_MS - 5_000;
  tracker.delivered(THREAD, "msg-1", deliveredAt);
  const h = await harness(t, "", { notePickup: (_sessionId, at) => tracker.pickedUp(THREAD, at) });
  await settle();
  assert.deepEqual(calls, [{ kind: "add", emoji: STAGE_EMOJI.delivered }]);

  await h.feed(queuedChannel(STAMP));
  await settle();
  assert.deepEqual(calls, [
    { kind: "add", emoji: STAGE_EMOJI.delivered },
    { kind: "add", emoji: STAGE_EMOJI.pickedUp },
    { kind: "remove", emoji: STAGE_EMOJI.delivered },
  ]);
  assert.deepEqual(h.notices, [], "nothing is posted to the thread");
});

test("a channel turn-opening line credits pickup at its own timestamp, and lookalikes credit nothing", async (t) => {
  const h = await harness(t);
  const opening = "2026-09-30T13:20:00.000Z";
  await h.feed(
    // Refused: tool output quoting a channel message, checked by block type alone.
    channelTurnOpen("2026-09-30T13:19:00.000Z", [{ type: "tool_result", tool_use_id: "t", content: "x" }]),
    // Refused: another session's line, and a foreign server's channel line.
    queuedChannel("2026-09-30T13:19:10.000Z", RELAY, OTHER),
    queuedChannel("2026-09-30T13:19:20.000Z", "some-other-server"),
    channelTurnOpen(opening),
  );
  assert.deepEqual(h.pickups, [{ sessionId: SESSION, at: Date.parse(opening) }]);
  assert.deepEqual(h.notices, []);
});

test("an unparseable line, an unknown type and an error line with no usable fields neither throw nor post past what they support", async (t) => {
  const h = await harness(t);
  await h.feed(
    '{"type":"system","subtype":"api_error", truncated\n',
    JSON.stringify({ type: "mystery", sessionId: SESSION, origin: { kind: "channel" } }) + "\n",
    JSON.stringify({ type: "system", subtype: "api_error", sessionId: SESSION }) + "\n",
  );
  assert.deepEqual(h.notices, ["API error."], "only the bare form the missing fields leave");
  // Fields of the wrong type are dropped rather than drawn.
  await h.feed(assistantText("ok"));
  await h.feed(
    apiError({ requestId: "req_bad", status: "429", retryInMs: "soon", timestamp: 12, rateLimits: { resetsAt: "later" } }),
  );
  assert.deepEqual(h.notices, ["API error.", HARNESS_RESUMED, "Rate-limited (usage limit)."]);
});

test("a path whose stem is not the session id is refused, and history before the baseline is never acted on", async (t) => {
  const h = await harness(t, apiError() + queuedChannel(STAMP));
  await h.feed();
  assert.deepEqual(h.notices, [], "lines already in the file when it was learned are behind the baseline");
  assert.deepEqual(h.pickups, []);

  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const foreign = path.join(dir, "not-the-session.jsonl");
  writeFileSync(foreign, "", "utf8");
  h.reader.learn(SESSION, foreign);
  appendFileSync(foreign, apiError(), "utf8");
  await h.feed(assistantText("still the learned file"));
  assert.deepEqual(h.notices, [], "the refused path is never read");
  assert.ok(h.logs.some((line) => line.includes("filename is not its own session id")), "the refusal is logged");
  assert.ok(!h.logs.some((line) => line.includes(dir)), "without the path");
});

test("a partial trailing line waits for its end, and a backlog past the bound reads its newest window with a contentless log line", async (t) => {
  const h = await harness(t);
  const line = apiError();
  await h.feed(line.slice(0, 40));
  assert.deepEqual(h.notices, []);
  await h.feed(line.slice(40));
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "the line is acted on once it is whole");

  // A pickup at the head of the backlog falls outside the newest window; the output line closing
  // the open episode sits at its end and must still be read.
  const filler = consolePrompt("x".repeat(1_000)).repeat(Math.ceil(MAX_TAIL_READ_BYTES / 1_000) + 10);
  await h.feed(queuedChannel(STAMP) + filler + assistantText("back"));
  assert.deepEqual(h.pickups, [], "the skipped head is not acted on");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED], "the newest lines are");
  assert.ok(h.logs.some((entry) => /outgrew one status pass/.test(entry)));
  assert.ok(!h.logs.some((entry) => entry.includes("xxxx")));
  // The offset now sits at the file's end, so the next line is read normally.
  await h.feed(apiError({ requestId: "req_after" }));
  assert.equal(h.notices.length, 3);
});

test("a backlog whose newest window starts exactly on a line keeps that line whole", async (t) => {
  const h = await harness(t);
  await h.feed(apiError());
  // The closing line is sized so the window of the newest MAX_TAIL_READ_BYTES starts on its first byte.
  const head = consolePrompt("x".repeat(1_000)).repeat(20);
  const closing = assistantText("y".repeat(MAX_TAIL_READ_BYTES - assistantText("").length));
  assert.equal(closing.length, MAX_TAIL_READ_BYTES);
  await h.feed(head + closing);
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE, HARNESS_RESUMED]);
});

test("a session leaving the current set (ended) closes its open episode without posting Resumed", async (t) => {
  const h = await harness(t);
  await h.feed(apiError());
  h.live.delete(SESSION);
  await h.feed();
  assert.deepEqual(h.episodes, [FIVE_HOUR_NOTICE, null], "the card line and the ⚠️ swap are cleared");
  assert.deepEqual(h.notices, [FIVE_HOUR_NOTICE], "and nothing says resumed");
});

test("a failing notice, pickup or episode callback is logged without detail and stops nothing", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, "", "utf8");
  const logs: string[] = [];
  const reader = createStatusReader({
    currentSessions: () => [SESSION],
    notice: async () => {
      throw new Error("PLANTED discord detail");
    },
    notePickup: () => {
      throw new Error("PLANTED pickup detail");
    },
    episode: () => {
      throw new Error("PLANTED episode detail");
    },
    log: (message) => logs.push(message),
  });
  reader.learn(SESSION, file);
  await reader.poll();
  appendFileSync(file, apiError() + queuedChannel(STAMP), "utf8");
  await reader.poll();
  await settle();
  assert.equal(logs.length, 3, logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("PLANTED")));
});
