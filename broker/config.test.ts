// Configuration bounds that nothing at runtime would report as wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_READ_TIMEOUT_MS, loadConfig } from "./config.ts";

test("the relay heartbeat is refused outside the window the relay can survive", () => {
  // The relay's read timeout lives in another process and cannot see this value. A heartbeat slower
  // than that timeout means every quiet relay drops and reconnects forever, and nothing at runtime
  // reports it as anything but a working session.
  assert.ok(RELAY_READ_TIMEOUT_MS > 0);
  assert.throws(
    () => loadConfig({ CHANNEL_RELAY_HEARTBEAT_MS: String(RELAY_READ_TIMEOUT_MS) }),
    /between/,
    "a heartbeat at or past the relay's read timeout must be refused, not clamped silently",
  );
  assert.throws(() => loadConfig({ CHANNEL_RELAY_HEARTBEAT_MS: "1" }), /between/);
  assert.equal(
    loadConfig({ CHANNEL_RELAY_HEARTBEAT_MS: "5000" }).relayHeartbeatMs,
    5_000,
    "a value inside the window is honored",
  );
  assert.ok(
    loadConfig({}).relayHeartbeatMs * 2 < RELAY_READ_TIMEOUT_MS,
    "the default must leave room for a missed heartbeat inside the relay's timeout",
  );
});
