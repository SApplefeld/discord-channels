// Behavioral cover for startBroker's own failure paths: a bind failure and the top-level
// entry point's own listening line, both of which must reach the rotating log file, not just the
// console, because a scheduled task (S7) has no console to catch either one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import {
  createPromptEdits,
  questionCloseOut,
  questionDelivery,
  questionRefresh,
  questionUpgrade,
  startBroker,
} from "./index.ts";
import type { BrokerConfig } from "./config.ts";
import type { AskedQuestion } from "./discord/render.ts";
import { createQuestionDesk } from "./question-desk.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { CallOutcome } from "./discord/transport.ts";
import { questionDigest } from "./tail.ts";

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
    settled: createPromptEdits().settled,
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
 */
function upgradeUnderTest(input: {
  questions: AskedQuestion[];
  questionsInput: unknown[];
  edit?: (components: readonly unknown[]) => Promise<CallOutcome<null>>;
}) {
  const landed: Edit[] = [];
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
    return outcome;
  };
  const desk = createQuestionDesk({
    holdMs: 14_400_000,
    setTimer: () => ({}) as NodeJS.Timeout,
    onTerminal: questionCloseOut({ edit: write, settled: drawing.settled, log: (line) => logged.push(line) }),
  });
  const held = heldResponse();
  assert.equal(
    desk.hold("session-a", input.questions, input.questionsInput, held.response, true),
    true,
  );
  const upgrade = questionUpgrade({
    desk,
    edit: write,
    drawing,
    operatorId: OPERATOR,
    log: (line) => logged.push(line),
  });
  return { desk, upgrade, landed, logged, bodies: held.bodies, drawing, write };
}

const OK: CallOutcome<null> = { status: "ok", value: null, rate: NO_RATE_INFO };

test("a landed notice becomes the interactive prompt the hold is answered through", async () => {
  const questions = ask("Ship it?");
  const { upgrade, landed, bodies, desk } = upgradeUnderTest({
    questions,
    questionsInput: askInput("Ship it?"),
  });

  await upgrade({ sessionId: "session-a", threadId: "thread-1", messageId: "msg-1", questions });

  assert.equal(landed.length, 1);
  assert.equal(landed[0].messageId, "msg-1");
  assert.ok(landed[0].components.length > 0, "the components are what the upgrade is for");
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
    settled: createPromptEdits().settled,
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
