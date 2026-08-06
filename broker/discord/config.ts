// Configuration for the Discord surfaces. Absent configuration is a supported state, not an
// error: the broker runs its registry and its hook intake with no Discord connection at all, which
// is what every test and every local debugging run does.
import { readFileSync } from "node:fs";
import { SNOWFLAKE } from "../security/senders.ts";
import { assertTokenFileIsProtected } from "./credentials.ts";

export type DiscordConfig = {
  /** The bot token. Never logged, never persisted, never included in an error message. */
  token: string;
  /** The channel this host's threads are opened in. */
  channelId: string;
  /** How often the surfaces are reconciled against the registry. */
  refreshIntervalMs: number;
  /** How long working or idle has to hold before it earns a rename. */
  dwellMs: number;
  /** A live session with no hook traffic for this long renders idle rather than working. */
  idleAfterMs: number;
  /** A session silent for this long is presumed dead and renders exited. */
  exitedAfterMs: number;
  /** Off by default: an exited thread stays open so its final state stays readable in the list. */
  archiveOnEnd: boolean;
};

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_DWELL_MS = 60_000;
const DEFAULT_IDLE_AFTER_MS = 120_000;
// Four hours. The backstop exists to catch a hard kill, which fires no hook, so it is set well
// past any pause a working session takes: a long tool call, a compaction, or a session parked at
// a prompt are all silences that must not be reported as a death.
const DEFAULT_EXITED_AFTER_MS = 4 * 60 * 60 * 1000;

function integerAtLeast(raw: string | undefined, minimum: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`expected an integer of at least ${minimum}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function flag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes";
}

/**
 * The token, from the environment or from a file named by the environment. A file is the shape an
 * installed service wants, since a scheduled task's environment is visible to anything that can
 * read the task definition, and a file can be locked to one account.
 */
function readToken(env: NodeJS.ProcessEnv, direct: string | undefined): string | null {
  if (direct) return direct;

  const file = env.CHANNEL_DISCORD_TOKEN_FILE?.trim();
  if (!file) return null;
  // Refused rather than read when anything but the owner can reach it: readable means the bot can
  // be impersonated, writable means the broker can be pointed at someone else's server.
  assertTokenFileIsProtected(file);
  // The path is reported on failure; the contents never are.
  const token = readFileSync(file, "utf8").trim();
  if (token === "") throw new Error(`the token file ${file} is empty`);
  return token;
}

export type DiscordConfigContext = {
  /** The registry's staleness window, which bounds how long the idle threshold may be. */
  staleAfterMs: number;
};

/** Returns null when no token or no channel is configured, which turns the surfaces off. */
export function loadDiscordConfig(
  env: NodeJS.ProcessEnv,
  context: DiscordConfigContext,
): DiscordConfig | null {
  // Taken and dropped from the environment before anything can return early, whatever else is or
  // is not configured. Every subprocess inherits this environment, and a bearer credential sitting
  // in it is one child process away from being read.
  const direct = env.CHANNEL_DISCORD_TOKEN?.trim();
  delete env.CHANNEL_DISCORD_TOKEN;

  // The channel is checked next, and its absence returns before a token file is read: a stale
  // path left in the environment must not stop a broker that is not configured for Discord at all
  // from starting.
  const channelId = env.CHANNEL_DISCORD_CHANNEL?.trim();
  if (!channelId) return null;
  // The channel ID is interpolated into a token-bearing request path, so its shape is checked
  // rather than trusted.
  if (!SNOWFLAKE.test(channelId)) {
    throw new Error(
      `CHANNEL_DISCORD_CHANNEL must be a Discord snowflake, got ${JSON.stringify(channelId)}`,
    );
  }

  const token = readToken(env, direct);
  if (!token) return null;

  const idleAfterMs = integerAtLeast(
    env.CHANNEL_DISCORD_IDLE_AFTER_MS,
    1,
    DEFAULT_IDLE_AFTER_MS,
  );
  // Above the staleness window the idle state is unreachable: the registry would mark a quiet
  // session stale, which already renders idle, before this threshold ever expired.
  if (idleAfterMs >= context.staleAfterMs) {
    throw new Error(
      `the idle threshold (${idleAfterMs}ms) must be below the staleness window ` +
        `(${context.staleAfterMs}ms), or a session can never render idle while it is live`,
    );
  }

  const exitedAfterMs = integerAtLeast(
    env.CHANNEL_DISCORD_EXITED_AFTER_MS,
    1,
    DEFAULT_EXITED_AFTER_MS,
  );
  // At or below the staleness window, every session that goes quiet is immediately called dead,
  // which is the claim the stale state exists to avoid making.
  if (exitedAfterMs <= context.staleAfterMs) {
    throw new Error(
      `the presumed-dead horizon (${exitedAfterMs}ms) must be above the staleness window ` +
        `(${context.staleAfterMs}ms), or a merely quiet session is reported as exited`,
    );
  }

  return {
    token,
    channelId,
    refreshIntervalMs: integerAtLeast(
      env.CHANNEL_DISCORD_REFRESH_MS,
      1,
      DEFAULT_REFRESH_INTERVAL_MS,
    ),
    dwellMs: integerAtLeast(env.CHANNEL_DISCORD_DWELL_MS, 0, DEFAULT_DWELL_MS),
    idleAfterMs,
    exitedAfterMs,
    archiveOnEnd: flag(env.CHANNEL_DISCORD_ARCHIVE_ON_END),
  };
}
