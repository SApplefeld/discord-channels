import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDiscordConfig } from "./config.ts";
import { loadConfig } from "../config.ts";

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
    assert.equal(fromFile?.archiveOnEnd, true, "an exited thread archives itself by default");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archiving is on unless the setting spells one of the recognized ways to say off", () => {
  // A host that configures nothing archives, which is what makes the behavior reachable on every
  // host rather than only on one whose operator found the knob.
  // A fresh environment per call, since loadDiscordConfig takes the token out of the one it reads.
  const archives = (raw?: string): boolean | undefined =>
    load({
      CHANNEL_DISCORD_TOKEN: "t",
      CHANNEL_DISCORD_CHANNEL: CHANNEL,
      ...(raw === undefined ? {} : { CHANNEL_DISCORD_ARCHIVE_ON_END: raw }),
    })?.archiveOnEnd;

  assert.equal(archives(), true, "absent means archive");
  assert.equal(archives(""), true);
  assert.equal(archives("true"), true);
  assert.equal(archives("1"), true);
  assert.equal(archives("no"), false);
  assert.equal(archives("off"), false);
  assert.equal(archives(" OFF "), false);
  assert.equal(archives("0"), false);
  assert.equal(archives("false"), false);
});

test("this knob and the mirror switch admit exactly the same spellings", () => {
  // The seam the two parsers used to disagree at: one read `1`, `true` and `yes`, the other also
  // read `on` and `off`, so a host writing `on` here got a silent false while the same word turned
  // the mirror on. Both read one vocabulary now, and a spelling neither recognizes is refused
  // rather than guessed at, so a typo cannot silently mean the opposite of what was written.
  const archives = (raw: string): boolean | undefined =>
    load({
      CHANNEL_DISCORD_TOKEN: "t",
      CHANNEL_DISCORD_CHANNEL: CHANNEL,
      CHANNEL_DISCORD_ARCHIVE_ON_END: raw,
    })?.archiveOnEnd;

  for (const raw of ["1", "true", "yes", "on", " TRUE "]) {
    assert.equal(archives(raw), true, raw);
    assert.equal(loadConfig({ CHANNEL_MIRROR: raw }).mirror, true, raw);
  }
  for (const raw of ["0", "false", "no", "off", " OFF "]) {
    assert.equal(archives(raw), false, raw);
    assert.equal(loadConfig({ CHANNEL_MIRROR: raw }).mirror, false, raw);
  }
  assert.throws(() => archives("offf"), /expected one of/, "an unrecognized spelling is refused here");
  assert.throws(() => loadConfig({ CHANNEL_MIRROR: "offf" }), /expected one of/);
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

test("a half-configured Discord says so, while an unconfigured one stays quiet", () => {
  // The shape this catches is a typo, and it is the one misconfiguration that looks exactly like a
  // working broker from every other signal: it starts, the registry fills, and the surfaces are
  // simply never there. A broker with nothing Discord-related set is a deliberate state and must
  // stay silent, or the warning is noise on every local run and nobody reads it.
  const said: string[] = [];
  const context = { staleAfterMs: STALE_AFTER_MS, warn: (m: string) => said.push(m) };

  assert.equal(loadDiscordConfig({}, context), null);
  assert.deepEqual(said, [], "a broker that wants no Discord is not misconfigured");

  assert.equal(loadDiscordConfig({ CHANNEL_DISCORD_TOKEN: "t" }, context), null);
  assert.equal(said.length, 1, "a token with no channel is a typo worth naming");
  assert.match(said[0], /CHANNEL_DISCORD_CHANNEL is not/);

  assert.equal(loadDiscordConfig({ CHANNEL_DISCORD_CHANNEL: CHANNEL }, context), null);
  assert.equal(said.length, 2, "a channel with no token is the same typo the other way round");
  assert.match(said[1], /no bot token/);
});
