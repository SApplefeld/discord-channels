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
  /** Hard cap on an inbound request body. Anything larger is refused unread. */
  maxBodyBytes: number;
  /** How long an ended or stale record is kept before the sweep prunes it. */
  retainTerminalMs: number;
  /** Ceiling on total records. Terminal records are evicted oldest first to hold it. */
  maxSessions: number;
};

/**
 * Exported because it is a shared literal, not a private default: hooks/settings-fragment.json
 * hardcodes this port into two hook URLs and hooks/session-start.ps1 falls back to it, and a hook
 * pointed at a port nothing listens on fails silently. settings-fragment.test.ts pins the fragment
 * against this value so the three cannot drift apart.
 */
export const DEFAULT_PORT = 8787;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RETAIN_TERMINAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;

function integerAtLeast(raw: string | undefined, minimum: number, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`expected an integer of at least ${minimum}, got ${JSON.stringify(raw)}`);
  }
  return value;
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
    retainTerminalMs: integerAtLeast(env.CHANNEL_RETAIN_TERMINAL_MS, 1, DEFAULT_RETAIN_TERMINAL_MS),
    maxSessions: integerAtLeast(env.CHANNEL_MAX_SESSIONS, 1, DEFAULT_MAX_SESSIONS),
  };
}
