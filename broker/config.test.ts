// Configuration bounds that nothing at runtime would report as wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_QUESTION_HOLD_MS,
  RELAY_MAX_RECONNECT_DELAY_MS,
  RELAY_READ_TIMEOUT_MS,
  RELAY_RESTART_GRACE_MS,
  RELAY_REPLY_IDLE_MS,
  REPLY_HEARTBEAT_MS,
  loadConfig,
  readInboxJudgeKey,
} from "./config.ts";

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

test("a reply's heartbeat leaves room for a missed beat inside the relay's idle window", () => {
  // The arithmetic half of the relation, against the day someone replaces the derivation with a
  // literal: the two values live in different processes, and a heartbeat at or past the idle window
  // reports every long reply as failed while its messages are still going up, which is what makes a
  // model send the whole answer again over the top of what landed. The mechanism half is in
  // relay/broker.test.ts, where a real relay waits out a run held open past several of its own idle
  // windows and still reports the reply as sent.
  assert.ok(REPLY_HEARTBEAT_MS > 0);
  assert.ok(
    REPLY_HEARTBEAT_MS * 2 < RELAY_REPLY_IDLE_MS,
    `a beat every ${REPLY_HEARTBEAT_MS}ms against a ${RELAY_REPLY_IDLE_MS}ms window`,
  );
});

test("the restart window spans at least two of the relay's reconnect ceilings", () => {
  // After a broker outage the relay's backoff has doubled to its ceiling, so its next attempt can
  // land a full ceiling after the broker answers again. A window shorter than two ceilings leaves
  // no room for one attempt that fails, and a living session ended by it stays ended.
  assert.ok(RELAY_MAX_RECONNECT_DELAY_MS > 0);
  assert.ok(
    RELAY_RESTART_GRACE_MS >= 2 * RELAY_MAX_RECONNECT_DELAY_MS,
    `a ${RELAY_RESTART_GRACE_MS}ms window against a ${RELAY_MAX_RECONNECT_DELAY_MS}ms ceiling`,
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

test("the interim mirror knobs default on and sane, and refuse a typo", () => {
  // The operator reported the mid-turn silence, so the feature ships on; the host-wide
  // CHANNEL_MIRROR gate is applied at the wiring, not here.
  const defaults = loadConfig({});
  assert.equal(defaults.interimMirror, true, "interim mirroring is on unless the operator turns it off");
  assert.equal(defaults.interimPollMs, 20_000);
  assert.equal(loadConfig({ CHANNEL_INTERIM_MIRROR: "" }).interimMirror, true);
  assert.equal(loadConfig({ CHANNEL_INTERIM_MIRROR: "off" }).interimMirror, false);
  assert.equal(loadConfig({ CHANNEL_INTERIM_MIRROR: "0" }).interimMirror, false);

  // A boolean knob read permissively turns a typo into a silent default; refused like the rest.
  for (const raw of ["fasle", "2", "enabled"]) {
    assert.throws(() => loadConfig({ CHANNEL_INTERIM_MIRROR: raw }), /expected one of/, raw);
  }

  assert.equal(loadConfig({ CHANNEL_INTERIM_POLL_MS: "1000" }).interimPollMs, 1_000);
  assert.equal(loadConfig({ CHANNEL_INTERIM_POLL_MS: "300000" }).interimPollMs, 300_000);
  // Bounded above as well as below: Node clamps a setInterval delay past 2^31-1 to 1ms, which
  // would turn an over-large value into exactly the busy loop the floor exists to prevent.
  for (const raw of ["999", "0", "-5", "2.5", "soon", "300001", "2147483648"]) {
    assert.throws(() => loadConfig({ CHANNEL_INTERIM_POLL_MS: raw }), /expected an integer/, raw);
  }
});

test("the question hold may be shortened by an override, never lengthened past the fragment's margin", () => {
  // The runtime half of a cross-component contract: the installed PreToolUse timeout exceeds the
  // default hold by a margin, which is what makes the release always the broker's clean `{}`
  // rather than a CLI-side timeout error, and the fragment pin holds that margin against the
  // default alone. An override above the default would carry the hold past the installed timeout
  // with nothing at runtime reporting it, so the loader refuses one.
  assert.equal(loadConfig({}).questionHoldMs, DEFAULT_QUESTION_HOLD_MS);
  assert.equal(loadConfig({ CHANNEL_QUESTION_HOLD_MS: "" }).questionHoldMs, DEFAULT_QUESTION_HOLD_MS);
  assert.equal(
    loadConfig({ CHANNEL_QUESTION_HOLD_MS: String(DEFAULT_QUESTION_HOLD_MS) }).questionHoldMs,
    DEFAULT_QUESTION_HOLD_MS,
    "the default is the ceiling, and naming it exactly is allowed",
  );
  assert.equal(loadConfig({ CHANNEL_QUESTION_HOLD_MS: "60000" }).questionHoldMs, 60_000);
  assert.equal(loadConfig({ CHANNEL_QUESTION_HOLD_MS: "1000" }).questionHoldMs, 1_000);

  assert.throws(
    () => loadConfig({ CHANNEL_QUESTION_HOLD_MS: String(DEFAULT_QUESTION_HOLD_MS + 1) }),
    /expected an integer/,
    "one millisecond past the default is one millisecond of margin the fragment does not carry",
  );
  // The floor and the shapes every numeric knob refuses: below a second the release would race the
  // alert that makes the hold worth keeping.
  for (const raw of ["999", "0", "-5", "2.5", "soon"]) {
    assert.throws(() => loadConfig({ CHANNEL_QUESTION_HOLD_MS: raw }), /expected an integer/, raw);
  }
});

test("the task notification knob defaults to brief, honors its three modes, and refuses a typo", () => {
  // The default is the compression: the console renders a wake-up compactly, and a thread louder
  // than the terminal it mirrors is the reported failure the knob exists to fix.
  assert.equal(loadConfig({}).taskNotifications, "brief");
  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: "" }).taskNotifications, "brief");
  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: "   " }).taskNotifications, "brief");

  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: "brief" }).taskNotifications, "brief");
  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: "full" }).taskNotifications, "full");
  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: "off" }).taskNotifications, "off");
  assert.equal(loadConfig({ CHANNEL_TASK_NOTIFICATION: " FULL " }).taskNotifications, "full");

  // A three-way knob read permissively turns a typo into a silent default, the same hazard the
  // boolean knobs refuse; the refusal names the vocabulary and the value it got.
  for (const raw of ["breif", "on", "1", "none", "true"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_TASK_NOTIFICATION: raw }),
      new RegExp(`expected one of brief, full, off, got ${JSON.stringify(raw)}`),
      raw,
    );
  }
});

test("the peer message knob defaults to full, honors its three modes, and refuses a typo", () => {
  // Full is the default, where the wake-up notice's knob compresses: peer traffic is the content of
  // an exchange the operator is watching from the thread, not a notice about one.
  assert.equal(loadConfig({}).peerMessages, "full");
  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: "" }).peerMessages, "full");
  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: "   " }).peerMessages, "full");

  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: "full" }).peerMessages, "full");
  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: "brief" }).peerMessages, "brief");
  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: "off" }).peerMessages, "off");
  assert.equal(loadConfig({ CHANNEL_PEER_MESSAGES: " BRIEF " }).peerMessages, "brief");

  // A three-way knob read permissively turns a typo into a silent default, the same hazard every
  // other knob here refuses; the refusal names the vocabulary and the value it got.
  for (const raw of ["fully", "on", "1", "none", "true", "quiet"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_PEER_MESSAGES: raw }),
      new RegExp(`expected one of full, brief, off, got ${JSON.stringify(raw)}`),
      raw,
    );
  }
});

test("the usage card is off unless it is asked for, and a typo is refused rather than read", () => {
  // Off by default: the card reads another program's files and opens a thread of its own in the
  // operator's channel, and neither belongs on a host that never asked for it.
  assert.equal(loadConfig({}).usageCard, false);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD: "" }).usageCard, false);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD: "on" }).usageCard, true);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD: "TRUE" }).usageCard, true);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD: "off" }).usageCard, false);

  for (const raw of ["ture", "enabled", "2"]) {
    assert.throws(() => loadConfig({ CHANNEL_USAGE_CARD: raw }), /expected one of/, raw);
  }
});

test("the usage card refresh is a minute by default and refuses a value outside its bounds", () => {
  assert.equal(loadConfig({}).usageCardRefreshMs, 60_000);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD_REFRESH_MS: "5000" }).usageCardRefreshMs, 5_000);
  assert.equal(loadConfig({ CHANNEL_USAGE_CARD_REFRESH_MS: "3600000" }).usageCardRefreshMs, 3_600_000);

  // The floor keeps a typo from turning the refresh into a stream of Discord edits; the ceiling
  // keeps the value inside what setInterval accepts, since Node clamps a delay past 2^31-1 down to
  // one millisecond, which is the busy loop an over-large value would otherwise buy.
  for (const raw of ["4999", "3600001", "0", "-1", "1.5", "soon"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_USAGE_CARD_REFRESH_MS: raw }),
      /expected an integer/,
      raw,
    );
  }
});

test("the usage cache root is unset unless an install keeps it somewhere else", () => {
  assert.equal(loadConfig({}).usageCacheRoot, null);
  assert.equal(loadConfig({ CHANNEL_USAGE_CACHE_ROOT: "   " }).usageCacheRoot, null);
  assert.equal(
    loadConfig({ CHANNEL_USAGE_CACHE_ROOT: " D:\\swap " }).usageCacheRoot,
    "D:\\swap",
  );
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

test("the model-change tier knob is off by default and refuses a value it cannot read", () => {
  // Off is the notice tier, which floors per thread; on is the alert tier, which carries the mention
  // that reaches a phone. Whether the quiet tier is loud enough is a question live use answers, so
  // the louder setting has to be an env change rather than a code round.
  assert.equal(loadConfig({}).modelChangeAlert, false);
  assert.equal(loadConfig({ CHANNEL_MODEL_CHANGE_ALERT: "on" }).modelChangeAlert, true);
  assert.equal(loadConfig({ CHANNEL_MODEL_CHANGE_ALERT: "off" }).modelChangeAlert, false);
  assert.throws(() => loadConfig({ CHANNEL_MODEL_CHANGE_ALERT: "yse" }), /expected one of/);
});

test("the board card knob is off by default and refuses a spelling it cannot read", () => {
  // The card sweeps the plan docs of every configured project and opens a thread of its own in the
  // operator's channel. Neither belongs on a host that never asked for it.
  assert.equal(loadConfig({}).boardCard, false);
  assert.equal(loadConfig({ CHANNEL_BOARD_CARD: "on" }).boardCard, true);
  assert.equal(loadConfig({ CHANNEL_BOARD_CARD: "off" }).boardCard, false);
  for (const raw of ["ture", "enabled", "2"]) {
    assert.throws(() => loadConfig({ CHANNEL_BOARD_CARD: raw }), /expected one of/, raw);
  }
});

test("the board's project list is semicolon-separated, absolute, and never derived", () => {
  assert.deepEqual(loadConfig({}).boardProjects, [], "no list is an empty list, not a default root");
  assert.deepEqual(loadConfig({ CHANNEL_BOARD_PROJECTS: "   " }).boardProjects, []);
  assert.deepEqual(
    loadConfig({ CHANNEL_BOARD_PROJECTS: "D:\\one; D:\\two ;" }).boardProjects,
    ["D:\\one", "D:\\two"],
    "entries are trimmed and a trailing separator means what it looks like",
  );
  assert.deepEqual(
    loadConfig({ CHANNEL_BOARD_PROJECTS: "D:\\one;D:\\one" }).boardProjects,
    ["D:\\one"],
    "a root written twice is one root, not two passes over the same plans",
  );

  // Two spellings of one directory are one root, compared the way the event reader compares one: a
  // survivor here draws a second project block whose rows never take a blocked marker, because the
  // reader folds the spellings together and keys its events to the first.
  for (const [raw, kept] of [
    ["D:\\one;d:\\one", "D:\\one"],
    ["d:\\one;D:\\one", "d:\\one"],
    ["D:\\one;D:\\one\\", "D:\\one"],
    ["D:\\one\\;D:\\one", "D:\\one\\"],
    ["D:\\one;D:/one", "D:\\one"],
    ["D:/one;D:\\one", "D:/one"],
  ] as const) {
    assert.deepEqual(
      loadConfig({ CHANNEL_BOARD_PROJECTS: raw }).boardProjects,
      [kept],
      `${raw} names one directory, and the first spelling of it is the one drawn`,
    );
  }

  // A relative root resolves against whatever directory the broker was launched from, and a
  // drive-relative one against whatever drive it was launched from. Under a scheduled task neither
  // is of the operator's choosing.
  for (const raw of ["projects", "D:\\one;..\\two", "./one", "\\one", "/one"]) {
    assert.throws(() => loadConfig({ CHANNEL_BOARD_PROJECTS: raw }), /absolute project roots/, raw);
  }
  // The refusal names the entry's position and never its text: a project root typically embeds the
  // operator's OS username, and this message reaches the log file.
  assert.throws(
    () => loadConfig({ CHANNEL_BOARD_PROJECTS: "D:\\one;..\\secret-user-path" }),
    (error: Error) => /entry 2 of 2/.test(error.message) && !/secret-user-path/.test(error.message),
  );
});

test("the board card refresh is a minute by default and refuses a value outside its bounds", () => {
  assert.equal(loadConfig({}).boardCardRefreshMs, 60_000);
  assert.equal(loadConfig({ CHANNEL_BOARD_CARD_REFRESH_MS: "5000" }).boardCardRefreshMs, 5_000);
  assert.equal(
    loadConfig({ CHANNEL_BOARD_CARD_REFRESH_MS: "3600000" }).boardCardRefreshMs,
    3_600_000,
  );
  for (const raw of ["4999", "3600001", "0", "-1", "1.5", "soon"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_BOARD_CARD_REFRESH_MS: raw }),
      /expected an integer/,
      raw,
    );
  }
});

test("the inbox card is off unless asked for, and its refresh takes the board card's bounds", () => {
  assert.equal(loadConfig({}).inboxCard, false);
  assert.equal(loadConfig({ CHANNEL_INBOX_CARD: "on" }).inboxCard, true);
  assert.equal(loadConfig({ CHANNEL_INBOX_CARD: "off" }).inboxCard, false);
  assert.throws(() => loadConfig({ CHANNEL_INBOX_CARD: "yse" }), /expected one of/);

  assert.equal(loadConfig({}).inboxCardRefreshMs, loadConfig({}).boardCardRefreshMs);
  assert.equal(loadConfig({ CHANNEL_INBOX_CARD_REFRESH_MS: "5000" }).inboxCardRefreshMs, 5_000);
  assert.equal(
    loadConfig({ CHANNEL_INBOX_CARD_REFRESH_MS: "3600000" }).inboxCardRefreshMs,
    3_600_000,
  );
  for (const raw of ["4999", "3600001", "0", "-1", "1.5", "soon"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_INBOX_CARD_REFRESH_MS: raw }),
      /expected an integer/,
      raw,
    );
  }
});

test("the inbox threshold is 0.7 by default and refuses a value outside 0.4 to 0.95", () => {
  assert.equal(loadConfig({}).inboxThreshold, 0.7);
  assert.equal(loadConfig({ CHANNEL_INBOX_THRESHOLD: "0.4" }).inboxThreshold, 0.4);
  assert.equal(loadConfig({ CHANNEL_INBOX_THRESHOLD: "0.95" }).inboxThreshold, 0.95);
  assert.equal(loadConfig({ CHANNEL_INBOX_THRESHOLD: " .85 " }).inboxThreshold, 0.85);
  for (const raw of ["0.39", "0.951", "1", "0", "-0.5", "NaN", "Infinity", "high"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_INBOX_THRESHOLD: raw }),
      /expected a number between 0.4 and 0.95/,
      raw,
    );
  }
});

test("the judge key file is a path alone, never read at load, and the key has no knob", () => {
  // Read where the inbox is built, so a broker with the card off never opens it, and a stale path
  // left in the environment cannot stop a broker from starting.
  assert.equal(loadConfig({}).inboxJudgeKeyFile, null);
  assert.equal(loadConfig({ CHANNEL_INBOX_JUDGE_KEY_FILE: "  " }).inboxJudgeKeyFile, null);
  assert.equal(
    loadConfig({ CHANNEL_INBOX_JUDGE_KEY_FILE: " Z:/nothing/here.key " }).inboxJudgeKeyFile,
    "Z:/nothing/here.key",
  );
  const source = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.ok(
    !/CHANNEL_INBOX_JUDGE_KEY\b/.test(source.replace(/CHANNEL_INBOX_JUDGE_KEY_FILE/g, "")),
    "the key itself is never read from the environment",
  );
});

test("the judge key is read from a protected file, and every failure turns the judge off with one warning", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "channels-inbox-key-"));
  try {
    const file = path.join(directory, "jev.key");
    writeFileSync(file, "  sk-jev-0123456789abcdefghij\n", "utf8");
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    const protectedPaths: string[] = [];
    const accept = (checked: string): void => {
      protectedPaths.push(checked);
    };

    assert.equal(readInboxJudgeKey(null, warn, accept), null, "no file named is the off state");
    assert.equal(warnings.length, 0, "and warns nothing");
    assert.deepEqual(protectedPaths, [], "nothing is checked where nothing is named");

    assert.equal(readInboxJudgeKey(file, warn, accept), "sk-jev-0123456789abcdefghij");
    assert.deepEqual(protectedPaths, [file], "the protection check runs on the named file");
    assert.equal(warnings.length, 0);

    // The real check, on a file under the operator's own temp directory, is what the default runs.
    assert.equal(readInboxJudgeKey(file, warn), "sk-jev-0123456789abcdefghij");
    assert.equal(warnings.length, 0);

    const refuse = (checked: string): void => {
      throw new Error(`${checked} grants access to WD`);
    };
    assert.equal(readInboxJudgeKey(file, warn, refuse), null, "unprotected turns the judge off");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /inbox judge is off/);
    assert.match(warnings[0], /grants access to WD/);
    assert.ok(!warnings[0].includes("sk-jev"), "the contents never ride a warning");

    writeFileSync(file, " \n", "utf8");
    assert.equal(readInboxJudgeKey(file, warn, accept), null, "an empty file turns the judge off");
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /is empty/);

    const missing = path.join(directory, "absent.key");
    assert.equal(readInboxJudgeKey(missing, warn), null, "a missing file turns the judge off");
    assert.equal(warnings.length, 3);
    assert.match(warnings[2], /inbox judge is off/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the board's event stream is the kit's own file unless an override names another", () => {
  const resolved = loadConfig({ USERPROFILE: "D:\\home\\op" }).boardEventsPath;
  assert.equal(resolved, path.join("D:\\home\\op", ".claude", "kit-events.jsonl"));
  assert.equal(
    loadConfig({ CHANNEL_BOARD_EVENTS_PATH: "D:\\feeds\\events.jsonl" }).boardEventsPath,
    "D:\\feeds\\events.jsonl",
    "the override is taken as written, since it is the operator's own path",
  );

  // The same rule the project roots are held to, for the same reason: a relative path resolves
  // against whatever directory the broker was launched from, and a drive-relative one against
  // whatever drive, neither of which a scheduled task lets the operator choose.
  for (const raw of ["events.jsonl", ".\\events.jsonl", "..\\feeds\\events.jsonl", "\\feeds\\events.jsonl", "/feeds/events.jsonl"]) {
    assert.throws(() => loadConfig({ CHANNEL_BOARD_EVENTS_PATH: raw }), /absolute path/, raw);
  }
  // And the refusal never echoes the value: this path sits under the operator's own profile.
  assert.throws(
    () => loadConfig({ CHANNEL_BOARD_EVENTS_PATH: "..\\secret-user-path\\events.jsonl" }),
    (error: Error) => !/secret-user-path/.test(error.message),
  );
});

test("the fleet roster has no default location and refuses a non-absolute path", () => {
  assert.equal(loadConfig({}).boardRosterPath, "", "unset is empty, not a guessed-at file");
  assert.equal(loadConfig({ CHANNEL_BOARD_ROSTER: "   " }).boardRosterPath, "");
  assert.equal(
    loadConfig({ CHANNEL_BOARD_ROSTER: "D:\\personas\\fleet.json" }).boardRosterPath,
    "D:\\personas\\fleet.json",
  );

  // The same rule the project roots and the events path are held to, for the same reason: a
  // relative path resolves against whatever directory the broker was launched from, and a
  // drive-relative one against whatever drive, neither of which a scheduled task lets the operator
  // choose.
  for (const raw of ["fleet.json", "relative\\path", "..\\fleet.json", "\\fleet.json", "/fleet.json"]) {
    assert.throws(
      () => loadConfig({ CHANNEL_BOARD_ROSTER: raw }),
      /CHANNEL_BOARD_ROSTER expects an absolute path/,
      raw,
    );
  }
  // And the refusal never echoes the value: a roster path typically embeds the operator's OS
  // username, and this message reaches the log file.
  assert.throws(
    () => loadConfig({ CHANNEL_BOARD_ROSTER: "..\\secret-user-path\\fleet.json" }),
    (error: Error) => !/secret-user-path/.test(error.message),
  );
});
