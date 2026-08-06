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

test("the mirror flag defaults on, honors both spellings, and refuses anything else", () => {
  assert.equal(loadConfig({}).mirror, true, "mirroring is on unless the operator turns it off");
  assert.equal(loadConfig({ CHANNEL_MIRROR: "" }).mirror, true);

  for (const raw of ["1", "true", "yes", "on", " TRUE "]) {
    assert.equal(loadConfig({ CHANNEL_MIRROR: raw }).mirror, true, raw);
  }
  for (const raw of ["0", "false", "no", "off", " OFF "]) {
    assert.equal(loadConfig({ CHANNEL_MIRROR: raw }).mirror, false, raw);
  }

  // A boolean knob read permissively turns a typo into a silent default. The numeric knobs refuse
  // a bad value for that reason, and this one holds the same line.
  for (const raw of ["fasle", "2", "enabled", "null"]) {
    assert.throws(() => loadConfig({ CHANNEL_MIRROR: raw }), /expected one of/, raw);
  }
});

test("the mirror body ceiling is its own knob, wider than the hook cap by default", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.mirrorMaxBytes, 256 * 1024);
  assert.ok(
    defaults.mirrorMaxBytes > defaults.maxBodyBytes,
    "a whole turn's reply must fit where a liveness tick's payload is the ceiling otherwise",
  );

  // Independent knobs: raising the mirror ceiling must not widen what /hook accepts.
  const raised = loadConfig({ CHANNEL_MIRROR_MAX_BYTES: "1048576" });
  assert.equal(raised.mirrorMaxBytes, 1_048_576);
  assert.equal(raised.maxBodyBytes, defaults.maxBodyBytes);

  // Bounded, and the floor is the operational half: the route answers 202 whether or not the body
  // fit, so a tiny ceiling would drop every mirror post while looking exactly like nobody typing.
  assert.equal(loadConfig({ CHANNEL_MIRROR_MAX_BYTES: "65536" }).mirrorMaxBytes, 65_536);
  assert.equal(loadConfig({ CHANNEL_MIRROR_MAX_BYTES: "4194304" }).mirrorMaxBytes, 4_194_304);
  for (const raw of ["not-a-number", "0", "1", "65535", "4194305"]) {
    assert.throws(() => loadConfig({ CHANNEL_MIRROR_MAX_BYTES: raw }), /expected an integer/, raw);
  }
});
