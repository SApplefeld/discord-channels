// Behavioral cover for startBroker's own failure paths: a bind failure and the top-level
// entry point's own listening line, both of which must reach the rotating log file, not just the
// console, because a scheduled task (S7) has no console to catch either one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("startBroker exposes the logger it started with", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-bind-logger-"));
  const logFile = path.join(dir, "broker.log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const broker = await startBroker(config({ stateFile: path.join(dir, "state.json"), logFile, port: 0 }));
  t.after(() => broker.stop());

  broker.logger.info("probe line from the test");
  assert.match(readFileSync(logFile, "utf8"), /probe line from the test/);
});
