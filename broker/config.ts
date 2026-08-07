// Broker configuration, resolved entirely from the environment so an installed service can be
// pointed at a different port or state file without editing source.
import os from "node:os";
import path from "node:path";

export type BrokerConfig = {
  /** Bound on 127.0.0.1 only. The listener is never exposed off-box. */
  port: number;
  /** Human label for the machine, carried on every session record for the Discord surfaces. */
  host: string;
  /** Absolute path to the persisted registry snapshot. */
  stateFile: string;
  /** A session with no hook traffic and no relay liveness for this long is marked stale. */
  staleAfterMs: number;
  /** How often the staleness sweep runs. */
  sweepIntervalMs: number;
  /**
   * Hard cap on a body posted to the /hook liveness route. That route is nearly content-free: of
   * the payload it is posted, it keeps the session's identity, its tool's name, and one bounded
   * preview of that tool's input, which the status card renders. Anything larger is drained and
   * dropped with a 202 rather than refused, since a refusal is a visible error inside the session
   * whose hook posted it; nothing over the cap is ever assembled or parsed.
   */
  maxBodyBytes: number;
  /**
   * How often each attached relay is pinged. It is also the bound on the acceptance criterion that
   * a closed relay marks its session ended: a socket that closes cleanly is noticed at once, and
   * this is the backstop for a pipe that is gone without having said so.
   */
  relayHeartbeatMs: number;
  /** How long an ended or stale record is kept before the sweep prunes it. */
  retainTerminalMs: number;
  /** Ceiling on total records. Terminal records are evicted oldest first to hold it. */
  maxSessions: number;
  /** Absolute path to the rotating log file. Logging falls through to the console when null. */
  logFile: string | null;
  /** Rotate the log file once it reaches this size. */
  logMaxBytes: number;
  /** Total log files kept on disk, the active one plus its rotated predecessors. */
  logMaxFiles: number;
  /**
   * Whether the mirror intake posts console prompts and turn replies to the session's thread. Off,
   * the mirror route still answers 202 and drops everything, because the installed hooks post to it
   * from every session on the machine and a refused post is a visible error inside that session.
   */
  mirror: boolean;
  /**
   * Body ceiling for the mirror route alone. Separate from maxBodyBytes, which keeps governing the
   * /hook liveness route: a mirror body carries a whole turn's reply, and a reply past this
   * ceiling is drained and dropped with a 202 rather than refused, since a 413 surfaces as a visible
   * error inside the session at the end of exactly the longest turns.
   */
  mirrorMaxBytes: number;
};

/**
 * Exported because it is a shared literal, not a private default: hooks/settings-fragment.json
 * hardcodes this port into every http hook URL and hooks/session-start.ps1 falls back to it, and a
 * hook pointed at a port nothing listens on fails silently. settings-fragment.test.ts pins the
 * fragment against this value so the three cannot drift apart.
 */
export const DEFAULT_PORT = 8787;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
// 256KB. The measured ceiling it must clear is a real turn's final reply, observed whole at ~35K
// characters; the headroom above that is for a reply several times longer, not for arbitrary data.
const DEFAULT_MIRROR_MAX_BYTES = 256 * 1024;
// The floor is the operational hazard: the mirror route answers 202 whether or not the body fit,
// so a ceiling small enough to drop every post is indistinguishable from nobody typing. 64KB keeps
// every ordinarily-sized turn deliverable; the 4MB ceiling bounds what one post can make the
// broker buffer.
const MIN_MIRROR_MAX_BYTES = 64 * 1024;
const MAX_MIRROR_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long the relay waits on a silent stream before it presumes the pipe is dead and reconnects.
 *
 * Exported because it lives in the other process: relay/broker.ts is the only reader, and the two
 * cannot see each other's configuration. The heartbeat below is clamped against it here, because a
 * heartbeat slower than this timeout means every quiet relay drops and reconnects forever, and
 * nothing at runtime would report that as anything but a working session.
 */
export const RELAY_READ_TIMEOUT_MS = 60 * 1000;

/** Room for two missed heartbeats inside the relay's read timeout before it gives up on the pipe. */
const MAX_RELAY_HEARTBEAT_MS = Math.floor(RELAY_READ_TIMEOUT_MS / 3);
const MIN_RELAY_HEARTBEAT_MS = 1_000;
const DEFAULT_RELAY_HEARTBEAT_MS = 15 * 1000;
const DEFAULT_RETAIN_TERMINAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_MAX_FILES = 5;

function integerAtLeast(raw: string | undefined, minimum: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`expected an integer of at least ${minimum}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Refuses rather than clamps, the same way `integerAtLeast` does. A knob silently moved to a value
 * the operator did not ask for is a knob whose behavior nobody can reason about later.
 */
function bounded(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `expected an integer between ${minimum} and ${maximum}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

const FLAG_TRUE: readonly string[] = ["1", "true", "yes", "on"];
/**
 * Exported because broker/intake.ts's per-request `X-Channel-Mirror` header reads the same off
 * vocabulary this config knob does. A second literal would let the two drift: a header spelling
 * accepted here but not there would flip a session's mirror state depending on which of the two
 * paths reads it.
 */
export const FLAG_FALSE: readonly string[] = ["0", "false", "no", "off"];

/**
 * Refuses rather than guesses, holding the same line the numeric knobs hold: a boolean knob read
 * permissively turns a typo like `CHANNEL_MIRROR=fasle` into whichever default the parser leans
 * toward, and a knob silently moved is a knob whose behavior nobody can reason about later.
 */
function strictFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (FLAG_TRUE.includes(value)) return true;
  if (FLAG_FALSE.includes(value)) return false;
  throw new Error(
    `expected one of ${[...FLAG_TRUE, ...FLAG_FALSE].join(", ")}, got ${JSON.stringify(raw)}`,
  );
}

/**
 * The state file lives outside the repository by default: the broker is installed as a service
 * and its runtime state is not source.
 */
function defaultStateFile(env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA ?? os.homedir();
  return path.join(base, "sapplefeld-channels", "broker-state.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return {
    // Zero is legal only here, where it means "any free port" and is what the tests bind. Every
    // other knob would be degenerate at zero: a zero sweep interval is a busy loop, a zero stale
    // timeout marks every session stale, and a zero body cap refuses every post.
    port: integerAtLeast(env.CHANNEL_BROKER_PORT, 0, DEFAULT_PORT),
    host: env.CHANNEL_HOST_NAME?.trim() || os.hostname(),
    stateFile: env.CHANNEL_BROKER_STATE?.trim() || defaultStateFile(env),
    staleAfterMs: integerAtLeast(env.CHANNEL_STALE_AFTER_MS, 1, DEFAULT_STALE_AFTER_MS),
    sweepIntervalMs: integerAtLeast(env.CHANNEL_SWEEP_INTERVAL_MS, 1, DEFAULT_SWEEP_INTERVAL_MS),
    maxBodyBytes: integerAtLeast(env.CHANNEL_MAX_BODY_BYTES, 1, DEFAULT_MAX_BODY_BYTES),
    relayHeartbeatMs: bounded(
      env.CHANNEL_RELAY_HEARTBEAT_MS,
      MIN_RELAY_HEARTBEAT_MS,
      MAX_RELAY_HEARTBEAT_MS,
      DEFAULT_RELAY_HEARTBEAT_MS,
    ),
    retainTerminalMs: integerAtLeast(env.CHANNEL_RETAIN_TERMINAL_MS, 1, DEFAULT_RETAIN_TERMINAL_MS),
    maxSessions: integerAtLeast(env.CHANNEL_MAX_SESSIONS, 1, DEFAULT_MAX_SESSIONS),
    // Unset by default: a broker run at a terminal (every test, every local debugging session)
    // keeps using the console output it always had. An installed service (S7) sets this to a path
    // outside the repository, the same way the state file above resolves outside it, because under
    // a scheduled task there is no console attached to catch what console.log and console.error
    // write.
    logFile: env.CHANNEL_BROKER_LOG_FILE?.trim() || null,
    logMaxBytes: integerAtLeast(env.CHANNEL_BROKER_LOG_MAX_BYTES, 1024, DEFAULT_LOG_MAX_BYTES),
    logMaxFiles: integerAtLeast(env.CHANNEL_BROKER_LOG_MAX_FILES, 1, DEFAULT_LOG_MAX_FILES),
    mirror: strictFlag(env.CHANNEL_MIRROR, true),
    mirrorMaxBytes: bounded(
      env.CHANNEL_MIRROR_MAX_BYTES,
      MIN_MIRROR_MAX_BYTES,
      MAX_MIRROR_MAX_BYTES,
      DEFAULT_MIRROR_MAX_BYTES,
    ),
  };
}
