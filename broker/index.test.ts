// Behavioral cover for startBroker's own failure paths: a bind failure and the top-level
// entry point's own listening line, both of which must reach the rotating log file, not just the
// console, because a scheduled task (S7) has no console to catch either one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBroker } from "./index.ts";
import type { BrokerConfig } from "./config.ts";

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

test("startBroker exposes the logger it started with", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-bind-logger-"));
  const logFile = path.join(dir, "broker.log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const broker = await startBroker(config({ stateFile: path.join(dir, "state.json"), logFile, port: 0 }));
  t.after(() => broker.stop());

  broker.logger.info("probe line from the test");
  assert.match(readFileSync(logFile, "utf8"), /probe line from the test/);
});
