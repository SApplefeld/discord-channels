// Behavioral cover for startBroker's own failure paths: a bind failure and the top-level
// entry point's own listening line, both of which must reach the rotating log file, not just the
// console, because a scheduled task (S7) has no console to catch either one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import {
  CONTINUATION_POST_PACE_MS,
  continuationPosts,
  createPromptEdits,
  modelChangeNotice,
  questionCloseOut,
  questionDelivery,
  questionRefresh,
  questionUpgrade,
  startBroker,
  usageCardWiring,
} from "./index.ts";
import type { BrokerConfig } from "./config.ts";
import type { AskedQuestion } from "./discord/render.ts";
import type { SessionRecord } from "./registry.ts";
import { createQuestionDesk } from "./question-desk.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { CallOutcome, DiscordTransport } from "./discord/transport.ts";
import {
  MAX_CONTINUATION_MESSAGES,
  renderQuestionPrompt,
} from "./discord/question-message.ts";
import {
  ALERT_WINDOW_MS,
  MAX_QUESTION_ALERTS_PER_WINDOW,
  MAX_QUESTION_CONTINUATIONS_PER_WINDOW,
  MAX_QUESTION_PINGS_PER_WINDOW,
  createAlertVolume,
} from "./security/permission.ts";
import { questionDigest } from "./tail.ts";
import { createUsageCard } from "./usage/thread.ts";
import { loadUsageBinding } from "./usage/binding.ts";

function config(overrides: Partial<BrokerConfig> & { stateFile: string; logFile: string | null }): BrokerConfig {
  return {
    port: 0,
    host: "NEO",
    staleAfterMs: 60_000,
    sweepIntervalMs: 60_000,
    maxBodyBytes: 64 * 1024,
    relayHeartbeatMs: 60_000,
    retainTerminalMs: 24 * 60 * 60 * 1000,
    maxSessions: 500,
    logMaxBytes: 5 * 1024 * 1024,
    logMaxFiles: 5,
    mirror: true,
    mirrorMaxBytes: 256 * 1024,
    interimMirror: true,
    interimPollMs: 20_000,
    questionHoldMs: 14_400_000,
    taskNotifications: "brief",
    usageCard: false,
    usageCardRefreshMs: 60_000,
    modelChangeAlert: false,
    usageCacheRoot: null,
    ...overrides,
  };
}

test("a bind failure is written to the log file, not just rejected silently", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-bind-"));
  const logFile = path.join(dir, "broker.log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await startBroker(
    config({ stateFile: path.join(dir, "a.json"), logFile: null, port: 0 }),
  );
  t.after(() => first.stop());

  await assert.rejects(() =>
    startBroker(config({ stateFile: path.join(dir, "b.json"), logFile, port: first.port })),
  );

  const logged = readFileSync(logFile, "utf8");
  assert.match(logged, /failed to bind/);
  assert.match(logged, new RegExp(String(first.port)));
});

test("a Stop past the /hook knob still lands its roster, at the mirror route's own bound", async (t) => {
  // Only a Stop carries the roster, and the Stop payload also carries the turn's whole final
  // assistant message, so the longest turns are the ones that would drop their table on the /hook
  // ceiling and leave a waiting-on line standing over a session that has gone idle. The wiring
  // floors the /hook ceiling at the mirror route's, which already accepts this same payload.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-hook-ceiling-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broker = await startBroker(
    config({
      stateFile: path.join(dir, "state.json"),
      logFile: null,
      maxBodyBytes: 1024,
      mirrorMaxBytes: 64 * 1024,
    }),
  );
  t.after(() => broker.stop());

  const headers = (event: string) => ({
    "content-type": "application/json",
    "x-channel-hook-event": event,
    "x-channel-process-token": "5f0c2e4a-0000-4000-8000-00000000cafe",
  });
  const announced = await fetch(`http://127.0.0.1:${broker.port}/hook`, {
    method: "POST",
    headers: headers("SessionStart"),
    body: JSON.stringify({ session_id: "session-ceiling", source: "startup" }),
  });
  assert.equal(announced.status, 200);

  const stopped = await fetch(`http://127.0.0.1:${broker.port}/hook`, {
    method: "POST",
    headers: headers("Stop"),
    body: JSON.stringify({
      session_id: "session-ceiling",
      last_assistant_message: "x".repeat(8_000),
      background_tasks: [
        { id: "agent-1", type: "subagent", description: "one live agent", agent_type: "general-purpose" },
      ],
    }),
  });
  assert.equal(stopped.status, 200, "the post fits the floored ceiling and is credited");

  const listed = await fetch(`http://127.0.0.1:${broker.port}/sessions`);
  const { sessions } = (await listed.json()) as {
    sessions: Array<{ sessionId: string; backgroundTasks: Array<{ id: string }> }>;
  };
  const held = sessions.find((session) => session.sessionId === "session-ceiling");
  assert.ok(held);
  assert.deepEqual(
    held.backgroundTasks.map((task) => task.id),
    ["agent-1"],
  );
});

/**
 * Drives one broker with the given switches: announces a session whose transcript_path names a
 * file that does not exist, then watches the log for the tailer's own `tail:` line, which is the
 * one observable trace a poll pass leaves without Discord. `waitMs` bounds the watch; the
 * positive case returns as soon as the line lands, the negative cases wait the whole window.
 */
async function tailLineAppeared(
  dir: string,
  name: string,
  overrides: Partial<BrokerConfig>,
  waitMs: number,
): Promise<boolean> {
  const logFile = path.join(dir, `${name}.log`);
  const broker = await startBroker(
    config({ stateFile: path.join(dir, `${name}.json`), logFile, interimPollMs: 1_000, ...overrides }),
  );
  try {
    const announced = await fetch(`http://127.0.0.1:${broker.port}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-hook-event": "SessionStart",
        "x-channel-process-token": "5f0c2e4a-0000-4000-8000-000000000002",
      },
      body: JSON.stringify({
        session_id: `session-${name}`,
        source: "startup",
        transcript_path: path.join(dir, `${name}-no-such-transcript.jsonl`),
      }),
    });
    assert.equal(announced.status, 200);
    // The tailer fails closed, so a learned path alone is never read: the mirror-on verdict rides
    // an ordinary /mirror post, the way UserPromptSubmit posts one at the start of every turn.
    await fetch(`http://127.0.0.1:${broker.port}/mirror`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-hook-event": "UserPromptSubmit",
        "x-channel-process-token": "5f0c2e4a-0000-4000-8000-000000000002",
      },
      body: JSON.stringify({ session_id: `session-${name}`, prompt: "start of a turn" }),
    });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const logged = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      if (logged.includes("tail:")) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await broker.stop();
  }
}

test("the tailer polls only when both mirror switches are on", async (t) => {
  // With interim mirroring off, or mirroring off host-wide, no transcript is read at all: the
  // tailer is never constructed, so "off" is the absence of the machinery. The positive case is
  // the control that proves this observation window can produce the signal; the negative cases
  // then wait more than two poll intervals for a line that must never come.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-tail-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(
    await tailLineAppeared(dir, "both-on", {}, 10_000),
    true,
    "with both switches on, the poll must reach the learned path and log its content-free failure",
  );
  assert.equal(
    await tailLineAppeared(dir, "interim-off", { interimMirror: false }, 2_500),
    false,
    "with CHANNEL_INTERIM_MIRROR off, no transcript is read at all",
  );
  assert.equal(
    await tailLineAppeared(dir, "mirror-off", { mirror: false }, 2_500),
    false,
    "with CHANNEL_MIRROR off, interim mirroring is off with it",
  );
});

test("a PreToolUse question post rides the /hook route end to end, and its text stays out of the log", async (t) => {
  // The emission-time question path over a really-bound broker: announced session, mirror-on
  // verdict, then the captured PreToolUse shape. Without Discord the alert lands nowhere, which
  // is the routing layer's quiet no-thread outcome; what this pins is that the event is accepted
  // on the wire as a credited liveness post and that no fragment of the question reaches the log.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-pretooluse-"));
  const logFile = path.join(dir, "broker.log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const broker = await startBroker(config({ stateFile: path.join(dir, "state.json"), logFile }));
  t.after(() => broker.stop());

  const headers = {
    "content-type": "application/json",
    "x-channel-process-token": "5f0c2e4a-0000-4000-8000-000000000003",
  };
  const announced = await fetch(`http://127.0.0.1:${broker.port}/hook`, {
    method: "POST",
    headers: { ...headers, "x-channel-hook-event": "SessionStart" },
    body: JSON.stringify({ session_id: "session-ptu", source: "startup" }),
  });
  assert.equal(announced.status, 200);
  await fetch(`http://127.0.0.1:${broker.port}/mirror`, {
    method: "POST",
    headers: { ...headers, "x-channel-hook-event": "UserPromptSubmit" },
    body: JSON.stringify({ session_id: "session-ptu", prompt: "start of a turn" }),
  });

  const asked = await fetch(`http://127.0.0.1:${broker.port}/hook`, {
    method: "POST",
    headers: { ...headers, "x-channel-hook-event": "PreToolUse" },
    body: JSON.stringify({
      session_id: "session-ptu",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "SECRET-live-question: which beverage?",
            header: "Beverage",
            options: [{ label: "SECRET-option-coffee", description: "SECRET-description" }],
            multiSelect: false,
          },
        ],
      },
      tool_use_id: "toolu_fixture",
    }),
  });
  assert.equal(asked.status, 200, "PreToolUse must be a credited liveness event on /hook");

  // The alert's delivery is asynchronous; one settled macrotask is enough for the no-thread drop.
  await new Promise((resolve) => setImmediate(resolve));
  const logged = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  assert.ok(!logged.includes("SECRET"), `question content must never reach the broker log: ${logged}`);
});

/** One ask, in the bounded shape both the desk and the delivery wrapper digest. */
function ask(question: string): AskedQuestion[] {
  return [
    {
      question,
      header: "Ship",
      multiSelect: false,
      options: [
        { label: "Yes", description: null },
        { label: "No", description: null },
      ],
    },
  ];
}

/** The payload's own questions array, which an answered hold passes back verbatim. */
function askInput(question: string): unknown[] {
  return [{ question, header: "Ship", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }];
}

/** A response the desk can hold: writes captured, socket events accepted, nothing else needed. */
function heldResponse(): { response: ServerResponse; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const response = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead() {
      return this;
    },
    end(text: string) {
      this.writableEnded = true;
      this.writableFinished = true;
      bodies.push(JSON.parse(text));
    },
    once() {
      return this;
    },
  };
  return { response: response as unknown as ServerResponse, bodies };
}

/** A desk with hand-driven timers, so a hold left standing cannot outlive the test run. */
function deskUnderTest(): ReturnType<typeof createQuestionDesk> {
  return createQuestionDesk({ holdMs: 14_400_000, setTimer: () => ({}) as NodeJS.Timeout });
}

test("a question delivery releases the hold for its own ask, and leaves another ask's alone", async () => {
  // Both question paths, the hook's emission-time alert and the tailer's resolution-time yield,
  // share one delivery closure, so a failed delivery carries a session id and nothing more. Keyed
  // on the session alone, one ask's dropped alert would release a different ask's live hold, whose
  // own alert is up and answerable from the thread.
  const desk = deskUnderTest();
  const held = heldResponse();
  assert.equal(desk.hold("session-a", ask("Ship it?"), askInput("Ship it?"), held.response, true), true);

  const deliver = questionDelivery({
    deliver: async () => ({ status: "failed", error: "the alert was not written" }),
    desk,
  });

  assert.deepEqual(await deliver("session-a", ask("A different question?")), {
    status: "failed",
    error: "the alert was not written",
  });
  assert.equal(held.bodies.length, 0, "the standing hold is for a different ask, and stands");

  assert.deepEqual(await deliver("session-a", ask("Ship it?")), {
    status: "failed",
    error: "the alert was not written",
  });
  assert.deepEqual(
    held.bodies,
    [{}],
    "its own ask's dropped alert releases it to the console picker",
  );
});

test("a question delivery that throws releases the hold before the throw leaves the wrapper", async () => {
  // The tailer catches a throw out of the delivery and drops the alert. Without the release on
  // this path the throw would carry the hold with it: a question alerted nowhere, parked until the
  // four-hour expiry, with the console showing a tool call that never resolves.
  const desk = deskUnderTest();
  const held = heldResponse();
  desk.hold("session-a", ask("Ship it?"), askInput("Ship it?"), held.response, true);

  const deliver = questionDelivery({
    deliver: () => Promise.reject(new Error("discord threw mid-write")),
    desk,
  });

  await assert.rejects(
    () => deliver("session-a", ask("Ship it?")),
    /discord threw mid-write/,
    "the throw still reaches the tailer, which reports it",
  );
  assert.deepEqual(held.bodies, [{}], "and the hold is released on the way out");
});

test("startBroker exposes the logger it started with", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-bind-logger-"));
  const logFile = path.join(dir, "broker.log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const broker = await startBroker(config({ stateFile: path.join(dir, "state.json"), logFile, port: 0 }));
  t.after(() => broker.stop());

  broker.logger.info("probe line from the test");
  assert.match(readFileSync(logFile, "utf8"), /probe line from the test/);
});

test("the usage card knob builds nothing on a broker with no discord configured", async (t) => {
  // Both conditions have to hold, and this is the half a unit test cannot reach: with no channel
  // there is nowhere to draw a card, so the knob alone must open no thread and start no refresh.
  //
  // The state file beside the registry's is deliberately corrupt. Reading it would report itself in
  // the log, so a card wired to load its binding before it decides whether it exists leaves a trace
  // here that a broker leaving that file alone cannot produce.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-usage-wiring-"));
  const logFile = path.join(dir, "broker.log");
  const bindingFile = path.join(dir, "usage-card.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(bindingFile, "{not json", "utf8");

  const broker = await startBroker(
    config({ stateFile: path.join(dir, "state.json"), logFile, usageCard: true }),
  );
  await broker.stop();

  // A broker with no Discord writes nothing at startup, so the log file need not exist at all.
  const logged = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  assert.doesNotMatch(logged, /usage card/);
  assert.equal(readFileSync(bindingFile, "utf8"), "{not json", "the file is not touched either");
});

test("the usage card's wiring draws this broker's own sessions, cache, and binding file", async (t) => {
  // The seam a unit test of the card cannot reach: the closure it calls for its session lines, the
  // permission desk's waiting set joined onto them, the cache root it reads, the footer's coupling
  // note, and the path from a bind back to a snapshot on disk. A stub transport is what puts all of
  // it in reach without a Discord connection.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-usage-wired-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "cache"));
  writeFileSync(
    path.join(dir, "cache", "usage.json"),
    JSON.stringify({
      accounts: { "1": { lastGood: { five_hour: { pct: 46 } }, fetchedAt: Date.now() / 1000 } },
    }),
    "utf8",
  );

  const record: SessionRecord = {
    sessionId: "0f3c9d21-4444-4000-8000-000000000004",
    processToken: "0f3c9d21-4444-4000-8000-00000000000b",
    name: "wired-session",
    host: "NEO",
    source: "startup",
    state: "live",
    lastTool: "Bash",
    lastToolInput: null,
    toolCount: 1,
    turnCount: 1,
    startedAt: Date.now(),
    lastHookAt: Date.now(),
    lastRelayAt: null,
    endedAt: null,
    openingModel: null,
    model: null,
    contextTokens: null,
    downgrade: null,
    backgroundTasks: [],
    goal: null,
  };

  const posts: string[] = [];
  const transport: DiscordTransport = {
    postCard: async ({ card }) => {
      posts.push(card);
      return { status: "ok", value: { messageId: "111111111111111111" }, rate: NO_RATE_INFO };
    },
    openThread: async () => ({
      status: "ok",
      value: { threadId: "222222222222222222" },
      rate: NO_RATE_INFO,
    }),
    editCard: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    renameThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    archiveThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };

  const card = createUsageCard(
    usageCardWiring({
      config: {
        stateFile: path.join(dir, "state.json"),
        usageCacheRoot: dir,
        usageCard: true,
        usageCardRefreshMs: 60_000,
      },
      channel: { transport, thresholds: { idleAfterMs: 30_000, exitedAfterMs: 4 * 60 * 60 * 1000 } },
      registry: { list: () => [record] },
      waiting: () => new Set([record.sessionId]),
      interimMirror: false,
      log: () => {},
      onError: () => {},
    }),
  );
  assert.ok(card !== null, "the knob is on and a channel is configured");
  await card.tick();

  const body = posts[0] ?? "";
  assert.equal(posts.length, 1);
  assert.match(body, /^5 Hr .* 46%$/m, "the cache under the configured root is what the card reads");
  assert.match(body, /^wired-session · needs you · 0m$/m, "and the registry is what it lists");
  assert.match(body, /interim mirroring off/, "with the tailer's own state in the footer");
  assert.deepEqual(
    loadUsageBinding(path.join(dir, "usage-card.json")),
    { messageId: "111111111111111111", threadId: "222222222222222222" },
    "and the thread it opened is persisted beside the registry snapshot",
  );
});

test("a terminal hold rewrites its own message and strips the components that answered it", async () => {
  // The message-edit half of the seam the desk's notifier is. Buttons left on a message whose hold
  // has ended are a tap that reports a failure and changes nothing, so every state edits and every
  // edit sends the empty component list that takes them off.
  const edits: Array<{
    threadId: string;
    messageId: string;
    text: string;
    components: readonly unknown[];
  }> = [];
  const logged: string[] = [];
  const closeOut = questionCloseOut({
    edit: async (threadId, messageId, text, components) => {
      edits.push({ threadId, messageId, text, components });
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
    drawing: createPromptEdits(),
    log: (message) => logged.push(message),
  });

  closeOut("session-a", "answered", {
    entryId: "a1b2c3d4e5f6",
    alert: { threadId: "thread-1", messageId: "msg-1" },
    questions: ask("Ship it?"),
    answers: { kind: "answers", answers: { "Ship it?": "Yes" } },
  });
  closeOut("session-a", "expired", {
    entryId: "a1b2c3d4e5f6",
    alert: { threadId: "thread-1", messageId: "msg-2" },
    questions: ask("Ship it?"),
    answers: null,
  });
  // An entry whose alert never landed has no message to aim at, and aiming at anything else would
  // rewrite some other message in the thread.
  closeOut("session-a", "released", {
    entryId: "a1b2c3d4e5f6",
    alert: null,
    questions: ask("Ship it?"),
    answers: null,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(edits.length, 2);
  assert.deepEqual(
    edits.map((edit) => edit.components),
    [[], []],
    "every terminal edit strips the components",
  );
  assert.deepEqual(edits[0].text.split("\n"), [
    "✅ **Answered from the thread**",
    "**Ship** · Yes",
  ]);
  assert.match(edits[1].text, /^❓ \*\*Question closed\*\* · the hold expired/);
  assert.deepEqual(logged, [], "an edit that landed says nothing");
});

const OPERATOR = "700000000000000002";

/** One landed Discord edit, as the upgrade and close-out tests read them back. */
type Edit = { messageId: string; text: string; components: readonly unknown[] };

/**
 * The alert-then-upgrade sequence over a real desk, with the close-out wired to the same barrier
 * the broker wires it to, so the two edits race here exactly as they race in production.
 *
 * `wire` is the one log both seams write to, in the order Discord would have seen them: an ordering
 * claim read off two separate arrays is two length claims and no ordering at all.
 */
function upgradeUnderTest(input: {
  questions: AskedQuestion[];
  questionsInput: unknown[];
  edit?: (components: readonly unknown[]) => Promise<CallOutcome<null>>;
  post?: (text: string) => Promise<CallOutcome<{ messageId: string | null }>>;
}) {
  const landed: Edit[] = [];
  const posted: string[] = [];
  const paced: number[] = [];
  const wire: string[] = [];
  const logged: string[] = [];
  const drawing = createPromptEdits();
  const write = async (
    _threadId: string,
    messageId: string,
    text: string,
    components: readonly unknown[],
  ): Promise<CallOutcome<null>> => {
    const outcome = await (input.edit ?? (async () => OK))(components);
    landed.push({ messageId, text, components });
    wire.push(components.length > 0 ? "prompt edit" : "stripped edit");
    return outcome;
  };
  const post = async (
    _threadId: string,
    text: string,
  ): Promise<CallOutcome<{ messageId: string | null }>> => {
    const outcome = await (input.post ?? (async () => POSTED))(text);
    if (outcome.status !== "ok") return outcome;
    posted.push(text);
    wire.push("continuation post");
    return outcome;
  };
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    setTimer: () => ({}) as NodeJS.Timeout,
    onTerminal: questionCloseOut({ edit: write, drawing, log: (line) => logged.push(line) }),
  });
  const held = heldResponse();
  assert.equal(
    desk.hold("session-a", input.questions, input.questionsInput, held.response, true),
    true,
  );
  const upgrade = questionUpgrade({
    desk,
    edit: write,
    post,
    // Recorded rather than slept: what the pace is worth is that it is asked for before every post,
    // which a test reads off the record without spending the seconds a real one would.
    wait: async (ms) => {
      paced.push(ms);
    },
    drawing,
    operatorId: OPERATOR,
    log: (line) => logged.push(line),
  });
  return { desk, upgrade, landed, posted, paced, wire, logged, bodies: held.bodies, drawing, write };
}

const OK: CallOutcome<null> = { status: "ok", value: null, rate: NO_RATE_INFO };

const POSTED: CallOutcome<{ messageId: string | null }> = {
  status: "ok",
  value: { messageId: "msg-continuation" },
  rate: NO_RATE_INFO,
};

/**
 * An ask no single message can carry: four questions, each with four options whose glosses run to
 * the reading cap, which is what makes the render yield continuations at all. The tests below assert
 * the count they got against what the renderer composed, because an ask that turned out to fit would
 * pass every ordering claim here on zero posts.
 */
function longAsk(): AskedQuestion[] {
  return [0, 1, 2, 3].map((at) => ({
    question: `Question ${String(at)}: ${"which way should this one go, and why ".repeat(12)}`,
    header: `Q${String(at)}`,
    multiSelect: false,
    options: [0, 1, 2, 3].map((option) => ({
      label: `Option ${String(at)}-${String(option)}`,
      description: `${"a gloss that runs on past what one message can hold ".repeat(10)}`,
    })),
  }));
}

/** The payload's own array for `longAsk`, which the answerable check reads the option counts off. */
function longAskInput(): unknown[] {
  return longAsk().map((asked) => ({
    question: asked.question,
    header: asked.header,
    multiSelect: false,
    options: asked.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }));
}

test("a landed notice becomes the interactive prompt the hold is answered through", async () => {
  const questions = ask("Ship it?");
  const { upgrade, landed, posted, wire, bodies, desk } = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });

  assert.equal(landed.length, 1);
  assert.equal(landed[0].messageId, "msg-1");
  assert.ok(landed[0].components.length > 0, "the components are what the upgrade is for");
  assert.deepEqual(posted, [], "an ask one message carries whole posts nothing beside it");
  assert.deepEqual(wire, ["prompt edit"], "and the thread sees exactly the one write it saw before");
  assert.deepEqual(bodies, [], "and the hold still stands, waiting on a tap");
  assert.equal(desk.entry("not-an-entry"), null, "and only its own opaque id reaches it");
});

test("a second notice for an ask already drawn is left as the notice it was posted as", async () => {
  // Both question paths can alert one ask: the hook's own emission-time post and the tailer's
  // resolution-time yield inside the digest window. Drawing the second would leave the first
  // message's components live over a hold whose terminal state rewrites a different message.
  const questions = ask("Ship it?");
  const { upgrade, landed, bodies } = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });
  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-2", questions });

  assert.deepEqual(
    landed.map((edit) => edit.messageId),
    ["msg-1"],
    "the ask keeps the one message its components live on",
  );
  assert.deepEqual(bodies, [], "and the hold stands: a second notice is not a reason to release");
});

test("a notice with no message id to edit releases the hold instead of parking it", async () => {
  const questions = ask("Ship it?");
  const { upgrade, landed, bodies } = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: null, questions });

  assert.deepEqual(landed, [], "there is no message to draw on, and no alert is noted on the entry");
  assert.deepEqual(bodies, [{}], "the no-decision body, which renders the console picker");
});

test("an ask the reader did not carry whole releases the hold rather than answering for it", async () => {
  // The answers map is built over the bounded parse and the session reads it against the input it
  // wrote, so an ask the reader cut is one the thread cannot answer faithfully.
  const questions = ask("Ship it?");
  const { upgrade, landed, bodies } = upgradeUnderTest({
    questions,
    questionsInput: [...askInput("Ship it?"), { question: "and then?", options: [{ label: "Yes" }] }],
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });

  assert.deepEqual(landed, [], "the plain notice stands, and it already says the console has it");
  assert.deepEqual(bodies, [{}]);
});

test("an upgrade Discord refuses releases the hold and reports it once", async () => {
  const questions = ask("Ship it?");
  const { upgrade, landed, logged, bodies } = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
    edit: async (components) =>
      components.length > 0
        ? { status: "failed", error: "HTTP 400", rate: NO_RATE_INFO }
        : OK,
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(bodies, [{}], "a readable message with no controls over a four-hour hold is worse");
  assert.deepEqual(logged, [
    "broker: session session-a's question kept the plain notice and released its hold: HTTP 400",
  ]);
  assert.equal(landed.length, 2, "the refused upgrade, then the close-out the release fires");
  assert.deepEqual(landed[1].components, [], "which rewrites the notice and carries no components");
});

test("a hold that ends under the upgrade edit is closed out after it, never beneath it", async () => {
  // Both edits aim at the one message, and the close-out is fire-and-forget, so nothing but the
  // ordering keeps the upgrade from landing last and putting live components back over a hold that
  // has already answered its session.
  const questions = ask("Ship it?");
  const harness = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
    edit: async (components) => {
      if (components.length === 0) return OK;
      // The hold ends while this edit is on the wire, which is the whole of the race.
      await new Promise((resolve) => setImmediate(resolve));
      harness.desk.release("session-a");
      await new Promise((resolve) => setImmediate(resolve));
      return OK;
    },
  });

  await harness.upgrade({
    sessionId: "session-a",
    threadId: "thread-1",
    messageId: "msg-1",
    questions,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.landed.map((edit) => edit.components.length > 0),
    [true, false],
    "the prompt lands, and the close-out that strips it lands after",
  );
});

test("an ask past one message posts its continuations before the prompt that names them", async () => {
  // The interactive message's markers say the rest is continued below, so the order is the whole
  // guarantee: a prompt drawn first is a marker pointing at messages not yet in the thread, and one
  // whose posts then fail points at messages that never arrive.
  const questions = longAsk();
  const composed = renderQuestionPrompt({
    operatorId: OPERATOR,
    entryId: "a1b2c3d4e5f6",
    questions,
    selections: questions.map(() => []),
  }).continuations;
  assert.ok(composed.length >= 2, "the ask under test has to actually spill for any of this to hold");
  let issued = 0;
  const { upgrade, posted, paced, wire, bodies } = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    // The first post answers a turn of the event loop later than the rest. Posts awaited one at a
    // time are unaffected; a dispatch that started them together would have the others answer
    // first, so the order below is the sequence and not an artefact of every mock resolving in call
    // order on the microtask queue.
    post: async () => {
      issued += 1;
      if (issued === 1) await new Promise((resolve) => setImmediate(resolve));
      return POSTED;
    },
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });

  assert.deepEqual(posted, composed, "every continuation the render composed, in the order it did");
  assert.deepEqual(
    wire,
    [...composed.map(() => "continuation post"), "prompt edit"],
    "and the prompt is the last thing on the wire, never the first",
  );
  assert.deepEqual(
    paced,
    composed.map(() => CONTINUATION_POST_PACE_MS),
    "each post waits out the pace first, so the burst one ask makes is spread",
  );
  assert.deepEqual(bodies, [], "the hold stands: the ask is now readable whole and answerable");
});

test("a continuation the thread refused releases the hold instead of marking absent text", async () => {
  const questions = longAsk();
  const composed = renderQuestionPrompt({
    operatorId: OPERATOR,
    entryId: "a1b2c3d4e5f6",
    questions,
    selections: questions.map(() => []),
  }).continuations;
  assert.ok(composed.length >= 3, "the refusal has to leave continuations behind it to be dropped");
  let issued = 0;
  const { upgrade, landed, posted, wire, logged, bodies } = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: async () => {
      issued += 1;
      return issued === 2 ? { status: "failed", error: "HTTP 400", rate: NO_RATE_INFO } : POSTED;
    },
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    posted,
    composed.slice(0, 1),
    "the continuation before the refused one stands, and nothing behind it was posted anyway",
  );
  assert.deepEqual(bodies, [{}], "the no-decision body, which renders the console picker");
  assert.ok(
    landed.every((edit) => edit.components.length === 0),
    "no marker-bearing prompt was ever drawn, so no marker points at text that is not there",
  );
  assert.deepEqual(wire[wire.length - 1], "stripped edit", "the close-out is the last write");
  assert.equal(logged.length, 1);
  assert.match(
    logged[0],
    /^broker: session session-a's question could not post continuation 2 of \d+ and released its hold: HTTP 400$/,
  );
  assert.ok(!logged[0].includes("which way should this one go"), logged[0]);
});

test("a hold that ends while its continuations post stops posting and draws nothing", async () => {
  // The posts are round trips, and the hold can expire or be answered at the console across any one
  // of them. The message is rewritten to its terminal state when that happens, so a prompt edit
  // landing afterwards would put a row of taps back over an ask nothing holds any more, and every
  // further post spends the create-message budget and a window slot a later ask needs, to write
  // "continued from above" under a message that now says the question is closed.
  const questions = longAsk();
  const composed = renderQuestionPrompt({
    operatorId: OPERATOR,
    entryId: "a1b2c3d4e5f6",
    questions,
    selections: questions.map(() => []),
  }).continuations;
  assert.ok(composed.length >= 4, "there have to be posts left for the ended hold to stop");
  let issued = 0;
  const harness = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: async () => {
      issued += 1;
      if (issued === 2) {
        // The hold ends while this post is on the wire, which is the whole of the race.
        harness.desk.release("session-a");
        await new Promise((resolve) => setImmediate(resolve));
      }
      return POSTED;
    },
  });

  await harness.upgrade({
    sessionId: "session-a",
    threadId: "thread-1",
    messageId: "msg-1",
    questions,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.bodies, [{}], "the release answered the session with the console picker");
  assert.deepEqual(
    harness.posted,
    composed.slice(0, 2),
    "the post the hold ended under is the last one: nothing is written for an ask nobody holds",
  );
  assert.ok(
    harness.landed.every((edit) => edit.components.length === 0),
    "the close-out stripped the message and nothing drew components back onto it",
  );
  assert.deepEqual(harness.logged, [], "an ask that ended has nothing left to release or report");
});

test("a hold that ends inside the last continuation's round trip is never drawn on afterwards", async () => {
  // The window only the read inside the drawing queue closes. Every continuation lands, so the
  // loop's own check before each post has run for the last time before the hold ends, and the
  // close-out registers while that final post is still on the wire. A prompt edit does not queue
  // behind a close-out already registered for the entry: it runs its callback where it stands. So
  // the read inside that callback is the whole of what keeps a row of live components off a message
  // the close-out has just rewritten to say the question is closed.
  const questions = longAsk();
  const composed = renderQuestionPrompt({
    operatorId: OPERATOR,
    entryId: "a1b2c3d4e5f6",
    questions,
    selections: questions.map(() => []),
  }).continuations;
  assert.ok(composed.length >= 2, "the ask under test has to spill for the last post to be a race");
  let issued = 0;
  const harness = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: async () => {
      issued += 1;
      if (issued === composed.length) {
        // The hold ends under the last post, which is past every check but the one inside the draw.
        harness.desk.release("session-a");
        await new Promise((resolve) => setImmediate(resolve));
      }
      return POSTED;
    },
  });

  await harness.upgrade({
    sessionId: "session-a",
    threadId: "thread-1",
    messageId: "msg-1",
    questions,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    harness.posted,
    composed,
    "every continuation landed: the release fell inside the last one's round trip, not before it",
  );
  assert.deepEqual(harness.bodies, [{}], "the release answered the session with the console picker");
  assert.ok(
    harness.landed.every((edit) => edit.components.length === 0),
    "and nothing drew components onto the message the close-out had already rewritten",
  );
  assert.ok(
    !harness.wire.includes("prompt edit") && harness.wire.includes("stripped edit"),
    `the close-out is the only edit this ask ever gets: ${harness.wire.join(", ")}`,
  );
  assert.deepEqual(harness.logged, [], "an ask that ended has nothing left to release or report");
});

test("a refused continuation whose hold ended under it reports what the release found", async () => {
  // Two failures in the same window: the post came back refused and the hold ended while it was on
  // the wire. The line says which one it was, because the release it names returns an answer and a
  // log that asserts a release it never made is a log that reads wrong at the one moment it matters.
  const questions = longAsk();
  let issued = 0;
  const harness = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: async () => {
      issued += 1;
      if (issued < 2) return POSTED;
      harness.desk.release("session-a");
      await new Promise((resolve) => setImmediate(resolve));
      return { status: "rate-limited", rate: NO_RATE_INFO };
    },
  });

  await harness.upgrade({
    sessionId: "session-a",
    threadId: "thread-1",
    messageId: "msg-1",
    questions,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.bodies, [{}], "the hold that ended is what answered the session");
  assert.equal(harness.logged.length, 1);
  assert.match(
    harness.logged[0],
    /^broker: session session-a's question could not post continuation 2 of \d+ and found its hold already ended: rate limited$/,
  );
});

test("a refused continuation ends its own entry, never the successor holding the same ask", async () => {
  // The posts hold this call open for several round trips, and a session whose hold ends inside that
  // window re-asks: the same questions produce the same digest, so a release named by session and
  // digest would end the new hold, whose own alert is up and answerable, on the strength of the old
  // one's failure.
  const questions = longAsk();
  const successor = heldResponse();
  let issued = 0;
  const harness = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: async () => {
      issued += 1;
      if (issued < 2) return POSTED;
      harness.desk.release("session-a");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        harness.desk.hold("session-a", questions, longAskInput(), successor.response, true),
        true,
        "the session re-asks the same question while this post is on the wire",
      );
      return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
    },
  });

  await harness.upgrade({
    sessionId: "session-a",
    threadId: "thread-1",
    messageId: "msg-1",
    questions,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.bodies, [{}], "the ask this call was upgrading is the one that ended");
  assert.deepEqual(successor.bodies, [], "and the ask asked after it is still held, still answerable");
});

test("continuation posts past their per-thread window are refused, and release the hold", async () => {
  // The refusal is a delivery failure like any other here: the continuations it would have written
  // are named by markers in the prompt, so the fail direction is the console, never a prompt drawn
  // over text the window dropped.
  const questions = longAsk();
  const posts = continuationPosts({ reply: async () => POSTED, now: () => 1_000 });
  const spent = MAX_QUESTION_CONTINUATIONS_PER_WINDOW - 2;
  for (let at = 0; at < spent; at += 1) {
    assert.equal((await posts("thread-1", "an earlier ask's continuation")).status, "ok");
  }
  const { upgrade, landed, posted, logged, bodies } = upgradeUnderTest({
    questions,
    questionsInput: longAskInput(),
    post: (text) => posts("thread-1", text),
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posted.length, 2, "what was left of the window, and no more");
  assert.deepEqual(bodies, [{}], "and the ask goes to the console rather than to a partial reading");
  assert.ok(
    landed.every((edit) => edit.components.length === 0),
    "the prompt naming the dropped continuations is never drawn",
  );
  assert.equal(logged.length, 1);
  assert.match(
    logged[0],
    /^broker: session session-a's question could not post continuation 3 of \d+ and released its hold: the question continuations are over their window$/,
  );
});

test("the continuation window holds per thread and admits again a window later", async () => {
  let at = 1_000;
  const posts = continuationPosts({ reply: async () => POSTED, now: () => at });
  for (let spent = 0; spent < MAX_QUESTION_CONTINUATIONS_PER_WINDOW; spent += 1) {
    assert.equal((await posts("thread-1", "a continuation")).status, "ok");
  }
  assert.equal((await posts("thread-1", "one past the ceiling")).status, "failed");
  assert.equal(
    (await posts("thread-2", "another thread's ask")).status,
    "ok",
    "one thread's flood buys no silence in another's",
  );

  at += ALERT_WINDOW_MS;
  assert.equal(
    (await posts("thread-1", "the next window's ask")).status,
    "ok",
    "and a flood locks a thread out for a window, never for good",
  );
});

test("the continuation window spends no slot of the question alert's, and none of it spends theirs", async () => {
  // What keeps these two apart is structural: `continuationPosts` builds its window inside itself,
  // so no caller can hand it the alert's. What this pins is the pair of ceilings each stops at, so a
  // ceiling moved onto the wrong constant is caught here. Sharing stamps would let a spilling ask's
  // continuations push real question alerts into drop, and the alert route is the one permission
  // prompts ride.
  const alerts = createAlertVolume({
    now: () => 1_000,
    pingCeiling: MAX_QUESTION_PINGS_PER_WINDOW,
    postCeiling: MAX_QUESTION_ALERTS_PER_WINDOW,
    windowMs: ALERT_WINDOW_MS,
  });
  const posts = continuationPosts({ reply: async () => POSTED, now: () => 1_000 });

  for (let spent = 0; spent < MAX_QUESTION_CONTINUATIONS_PER_WINDOW; spent += 1) {
    assert.equal((await posts("thread-1", "a continuation")).status, "ok");
  }
  assert.equal((await posts("thread-1", "one past the ceiling")).status, "failed");
  assert.equal(alerts("thread-1"), "ping", "the alert window never saw those posts");
  for (let spent = 1; spent < MAX_QUESTION_ALERTS_PER_WINDOW; spent += 1) alerts("thread-1");
  assert.equal(alerts("thread-1"), "drop", "and its own ceiling is where it stops");
});

test("one ask's paced posts stay inside the create-message allowance the pace is sized against", () => {
  // The assumed allowance the pace is set from: five create-message posts per five seconds in one
  // channel. Discord publishes no number for this bucket, so this is the conservative floor the
  // constant is argued against rather than a measured limit, and it is written here so moving the
  // pace without re-arguing the burst goes red. The ask's own alert is the post at zero, and each
  // continuation follows one pace behind the last, so the densest five seconds hold the alert plus
  // however many paces fit under it.
  const assumedPosts = 5;
  const assumedWindowMs = 5_000;
  const densest = 1 + Math.floor(assumedWindowMs / CONTINUATION_POST_PACE_MS);

  assert.ok(
    densest <= assumedPosts,
    `a pace of ${String(CONTINUATION_POST_PACE_MS)}ms puts ${String(densest)} posts in ` +
      `${String(assumedWindowMs)}ms, past the ${String(assumedPosts)} it is sized for`,
  );
  assert.ok(
    CONTINUATION_POST_PACE_MS * MAX_CONTINUATION_MESSAGES <= 10_000,
    "and the longest ask still reaches its prompt in seconds, which is what the operator waits out",
  );
});

test("the continuation window admits one whole ask's worth of continuations", () => {
  // A bound that is only correct relative to another: the window has to be wide enough for the most
  // continuations one ask can compose, or the feature breaks on exactly the long asks it exists for,
  // with every such ask refused partway and released to the console.
  assert.ok(
    MAX_QUESTION_CONTINUATIONS_PER_WINDOW >= MAX_CONTINUATION_MESSAGES,
    `${String(MAX_QUESTION_CONTINUATIONS_PER_WINDOW)} continuation posts a window cannot carry an ` +
      `ask composing ${String(MAX_CONTINUATION_MESSAGES)}`,
  );
});

test("two close-outs for one message land in the order their triggers fired", async () => {
  // A release and the console answer that follows it both rewrite the one message, both
  // fire-and-forget off the response path. Under a first edit Discord is pacing, the second would
  // otherwise land first and the message would be left telling the operator to answer at a console
  // that has already answered, with nothing behind it to correct that.
  const landed: string[] = [];
  const drawing = createPromptEdits();
  let admit = (): void => {};
  const paced = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let issued = 0;
  const closeOut = questionCloseOut({
    edit: async (_threadId, _messageId, text) => {
      issued += 1;
      if (issued === 1) await paced;
      landed.push(text.split("\n")[0]);
      return OK;
    },
    drawing,
    log: () => {},
  });
  const detail = {
    entryId: "a1b2c3d4e5f6",
    alert: { threadId: "thread-1", messageId: "msg-1" },
    questions: ask("Ship it?"),
    answers: null,
  };

  closeOut("session-a", "released", detail);
  closeOut("session-a", "answered-at-console", detail);
  admit();
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(landed, [
    "❓ **Question closed** · released to the console, answer it at the console",
    "✅ **Answered at the console**",
  ]);
});

test("a redraw for an entry the desk no longer holds is never issued", async () => {
  // The view a redraw draws from was read before the callback was answered, so the hold can end
  // under it: the message would go back to a live prompt over a session that has already moved on.
  const questions = ask("Ship it?");
  const desk = deskUnderTest();
  const held = heldResponse();
  desk.hold("session-a", questions, askInput("Ship it?"), held.response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(questions), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);
  const view = desk.entry(entryId);
  assert.ok(view !== null);

  const landed: Edit[] = [];
  const logged: string[] = [];
  const refresh = questionRefresh({
    desk,
    drawing: createPromptEdits(),
    edit: async (_threadId, messageId, text, components) => {
      landed.push({ messageId, text, components });
      return OK;
    },
    operatorId: OPERATOR,
    log: (line) => logged.push(line),
  });

  await refresh(view);
  assert.equal(landed.length, 1, "the entry is live, so the redraw goes out");

  desk.release("session-a");
  await refresh(view);
  assert.equal(landed.length, 1, "and the stale view redraws nothing at all");
});

test("a redraw Discord refuses is one bounded line and never the question that failed to draw", async () => {
  const questions = ask("SECRET-ship it?");
  const desk = deskUnderTest();
  desk.hold("session-a", questions, askInput("SECRET-ship it?"), heldResponse().response, true);
  const entryId = desk.noteAlert("session-a", questionDigest(questions), {
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.ok(entryId !== null);
  const view = desk.entry(entryId);
  assert.ok(view !== null);

  const logged: string[] = [];
  const refresh = questionRefresh({
    desk,
    drawing: createPromptEdits(),
    edit: async () => ({ status: "rate-limited", rate: NO_RATE_INFO }),
    operatorId: OPERATOR,
    log: (line) => logged.push(line),
  });

  await refresh(view);

  assert.deepEqual(logged, [
    "broker: could not redraw session session-a's question message: rate limited",
  ]);
  assert.ok(!logged.join("\n").includes("SECRET"), logged.join("\n"));
});

test("a refused close-out is one bounded line and never the question that failed to render", async () => {
  const logged: string[] = [];
  const closeOut = questionCloseOut({
    edit: async () => ({ status: "failed", error: "HTTP 404", rate: NO_RATE_INFO }),
    drawing: createPromptEdits(),
    log: (message) => logged.push(message),
  });

  closeOut("session-a", "expired", {
    entryId: "a1b2c3d4e5f6",
    alert: { threadId: "thread-1", messageId: "msg-1" },
    questions: ask("SECRET-ship it?"),
    answers: null,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(logged, [
    "broker: could not close out session session-a's question message: HTTP 404",
  ]);
  assert.ok(!logged.join("\n").includes("SECRET"), logged.join("\n"));
});

/** The writer seam the model-change message spends, recording which tier each message took. */
function tiers() {
  const notices: { threadId: string; text: string }[] = [];
  const alerts: { threadId: string; text: string; mentionUserId: string | null }[] = [];
  return {
    notices,
    alerts,
    writer: {
      notice: async (threadId: string, text: string) => {
        notices.push({ threadId, text });
        return true;
      },
      alert: async (threadId: string, text: string, mentionUserId: string | null) => {
        alerts.push({ threadId, text, mentionUserId });
        return { status: "ok" as const, value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
      },
    },
  };
}

const MODEL_CHANGE = {
  sessionId: "session-a",
  from: "claude-fable-5",
  to: "claude-opus-4-8",
  downgrade: {
    cause: "refusal" as const,
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    category: "cyber",
    choice: null,
  },
};

test("a model change posts one message on the notice tier by default", async () => {
  const { notices, alerts, writer } = tiers();
  const announce = modelChangeNotice({
    threadFor: () => "thread-1",
    writer,
    operatorId: "222222222222222222",
    alertTier: false,
    volume: () => "ping" as const,
    log: () => {},
  });

  announce(MODEL_CHANGE);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notices.length, 1, "one message per change");
  assert.equal(notices[0].threadId, "thread-1");
  assert.ok(notices[0].text.includes("flagged cyber"), notices[0].text);
  assert.ok(!notices[0].text.includes("<@"), "the quiet tier mentions nobody");
  assert.deepEqual(alerts, []);
});

test("the knob moves the same change onto the alert tier, with the mention that reaches a phone", async () => {
  const { notices, alerts, writer } = tiers();
  const announce = modelChangeNotice({
    threadFor: () => "thread-1",
    writer,
    operatorId: "222222222222222222",
    alertTier: true,
    volume: () => "ping" as const,
    log: () => {},
  });

  announce(MODEL_CHANGE);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].mentionUserId, "222222222222222222");
  assert.ok(alerts[0].text.startsWith("<@222222222222222222> "), alerts[0].text);
  assert.deepEqual(notices, []);
});

test("a change in a session with no thread posts nothing at all", async () => {
  const { notices, alerts, writer } = tiers();
  const announce = modelChangeNotice({
    threadFor: () => null,
    writer,
    operatorId: "222222222222222222",
    alertTier: false,
    volume: () => "ping" as const,
    log: () => {},
  });

  announce(MODEL_CHANGE);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notices, []);
  assert.deepEqual(alerts, []);
});

test("the alert tier rides its own per-thread window", async () => {
  // A transcript is another program's file, so a model string alternating in it can report one
  // change per poll, and with the knob on each change is a mention-bearing write. The security
  // model's rule for that class is a window of the write's own: bounded only by the shared post
  // budget, a token holder could park every session on the host.
  const { notices, alerts, writer } = tiers();
  const logs: string[] = [];
  const volume = createAlertVolume({ now: () => 0, pingCeiling: 1, postCeiling: 2, windowMs: 60_000 });
  const announce = modelChangeNotice({
    threadFor: () => "thread-1",
    writer,
    operatorId: "222222222222222222",
    alertTier: true,
    volume,
    log: (message) => logs.push(message),
  });

  announce(MODEL_CHANGE);
  announce(MODEL_CHANGE);
  announce(MODEL_CHANGE);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(alerts.length, 2, "past the post ceiling nothing is written");
  assert.equal(alerts[0].mentionUserId, "222222222222222222");
  assert.equal(alerts[1].mentionUserId, null, "past the ping ceiling the alert goes quiet");
  assert.ok(!alerts[1].text.includes("<@"), alerts[1].text);
  assert.deepEqual(notices, []);
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.ok(!logs[0].includes("claude"), "the dropped write's log line carries no model string");
});

test("a floored or refused model-change write leaves a content-free log line", async () => {
  // The writer reports failure by value, not only by throw, and this message is the change's only
  // push signal: a false or non-ok outcome eaten in silence would leave nothing saying it never
  // went.
  const logs: string[] = [];
  const floored = modelChangeNotice({
    threadFor: () => "thread-1",
    writer: {
      notice: async () => false,
      alert: async () => {
        throw new Error("unused");
      },
    },
    operatorId: "222222222222222222",
    alertTier: false,
    volume: () => "ping" as const,
    log: (message) => logs.push(message),
  });
  const refused = modelChangeNotice({
    threadFor: () => "thread-1",
    writer: {
      notice: async () => {
        throw new Error("unused");
      },
      alert: async () => ({ status: "failed" as const, error: "over budget", rate: NO_RATE_INFO }),
    },
    operatorId: "222222222222222222",
    alertTier: true,
    volume: () => "quiet" as const,
    log: (message) => logs.push(message),
  });

  floored(MODEL_CHANGE);
  refused(MODEL_CHANGE);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logs.length, 2, logs.join("\n"));
  assert.ok(!logs.join("\n").includes("claude"), "the log lines carry no model string");
});

test("a write that throws costs the message and nothing else", async () => {
  const logs: string[] = [];
  const announce = modelChangeNotice({
    threadFor: () => "thread-1",
    writer: {
      notice: async () => {
        throw new Error("the thread is gone, and this error quotes claude-fable-5");
      },
      alert: async () => {
        throw new Error("unused");
      },
    },
    operatorId: "222222222222222222",
    alertTier: false,
    volume: () => "ping" as const,
    log: (message) => logs.push(message),
  });

  assert.doesNotThrow(() => announce(MODEL_CHANGE));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logs.length, 1, logs.join("\n"));
  assert.ok(!logs[0].includes("claude-fable-5"), logs[0]);
});
