import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDiscordConfig } from "./config.ts";

const STALE_AFTER_MS = 300_000;
const CHANNEL = "123456789012345678";

function load(env: NodeJS.ProcessEnv) {
  return loadDiscordConfig(env, { staleAfterMs: STALE_AFTER_MS });
}

test("no token or no channel turns the surfaces off rather than failing", () => {
  assert.equal(load({}), null);
  assert.equal(load({ CHANNEL_DISCORD_TOKEN: "t" }), null);
  assert.equal(load({ CHANNEL_DISCORD_CHANNEL: CHANNEL }), null);
});

test("with no channel configured, a stale token file path is never touched", () => {
  // The token file is read only once Discord is configured at all. Otherwise a path left behind
  // from an old install would stop a broker that wants no Discord connection from starting.
  assert.equal(load({ CHANNEL_DISCORD_TOKEN_FILE: "Z:/nothing/here.token" }), null);
});

test("the channel must be a snowflake, since it is interpolated into a request path", () => {
  assert.throws(
    () => load({ CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: "../@me/channels" }),
    /must be a Discord snowflake/,
  );
  assert.throws(
    () => load({ CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: "12345" }),
    /must be a Discord snowflake/,
  );
});

test("a token read from the environment is removed from it", () => {
  // The whole environment is inherited by every subprocess, and a bearer credential sitting in it
  // is one child process away from being read.
  const env = { CHANNEL_DISCORD_TOKEN: "secret-token", CHANNEL_DISCORD_CHANNEL: CHANNEL };

  const config = load(env);

  assert.equal(config?.token, "secret-token");
  assert.equal(env.CHANNEL_DISCORD_TOKEN, undefined);
});

test("the token comes from the environment or from a file, and the defaults are the safe ones", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "channels-token-"));
  try {
    const file = path.join(directory, "bot.token");
    writeFileSync(file, "  from-a-file\n", "utf8");

    const fromEnv = load({ CHANNEL_DISCORD_TOKEN: " from-env ", CHANNEL_DISCORD_CHANNEL: CHANNEL });
    const fromFile = load({ CHANNEL_DISCORD_TOKEN_FILE: file, CHANNEL_DISCORD_CHANNEL: CHANNEL });

    assert.equal(fromEnv?.token, "from-env");
    assert.equal(fromFile?.token, "from-a-file");
    assert.equal(fromFile?.archiveOnEnd, false, "an exited thread is left open by default");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archiving is turned on only by an explicit affirmative", () => {
  const base = { CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: CHANNEL };

  assert.equal(load({ ...base, CHANNEL_DISCORD_ARCHIVE_ON_END: "true" })?.archiveOnEnd, true);
  assert.equal(load({ ...base, CHANNEL_DISCORD_ARCHIVE_ON_END: "1" })?.archiveOnEnd, true);
  assert.equal(load({ ...base, CHANNEL_DISCORD_ARCHIVE_ON_END: "no" })?.archiveOnEnd, false);
  assert.equal(load({ ...base, CHANNEL_DISCORD_ARCHIVE_ON_END: "" })?.archiveOnEnd, false);
});

test("an idle threshold at or above the staleness window is refused", () => {
  // Above it, a quiet session is marked stale (which already renders idle) before the threshold
  // could ever fire, so the configuration silently means something other than what it says.
  const base = { CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: CHANNEL };

  assert.throws(
    () => load({ ...base, CHANNEL_DISCORD_IDLE_AFTER_MS: String(STALE_AFTER_MS) }),
    /must be below the staleness window/,
  );
  assert.equal(
    load({ ...base, CHANNEL_DISCORD_IDLE_AFTER_MS: String(STALE_AFTER_MS - 1) })?.idleAfterMs,
    STALE_AFTER_MS - 1,
  );
});

test("the presumed-dead horizon must sit above the staleness window", () => {
  // At or below it, every session that goes quiet is immediately called dead, which is the claim
  // the stale state exists to avoid making.
  const base = { CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: CHANNEL };

  assert.throws(
    () => load({ ...base, CHANNEL_DISCORD_EXITED_AFTER_MS: String(STALE_AFTER_MS) }),
    /must be above the staleness window/,
  );
  assert.equal(
    load({ ...base, CHANNEL_DISCORD_EXITED_AFTER_MS: String(STALE_AFTER_MS + 1) })?.exitedAfterMs,
    STALE_AFTER_MS + 1,
  );
  assert.equal(load(base)?.exitedAfterMs, 4 * 60 * 60 * 1000, "four hours by default");
});

test("a non-integer interval is refused rather than silently defaulted", () => {
  const base = { CHANNEL_DISCORD_TOKEN: "t", CHANNEL_DISCORD_CHANNEL: CHANNEL };

  assert.throws(() => load({ ...base, CHANNEL_DISCORD_DWELL_MS: "soon" }), /expected an integer/);
  assert.throws(() => load({ ...base, CHANNEL_DISCORD_REFRESH_MS: "0" }), /expected an integer/);
  assert.equal(load({ ...base, CHANNEL_DISCORD_DWELL_MS: "0" })?.dwellMs, 0);
});
