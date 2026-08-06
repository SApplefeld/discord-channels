// Rotating file logger for the broker.
//
// Under a scheduled task there is no console attached to the process, so a diagnostic written only
// via console.log or console.error is lost the moment the task's stdout leaves the desk (S7). This
// gives the same severities a durable destination that rotates by size instead of growing without
// bound. Logging is opt-in: with no file configured, callers fall through to the console output the
// broker already had, and every test and local debugging run keeps working unconfigured.
//
// A logging failure must never take the daemon down. Every write here is wrapped so a bad path, a
// full disk, a permission error, or a rotation that races another process degrades to a dropped log
// line, never an uncaught throw on the sweep or refresh interval that would end the process.
//
// This is also where two kinds of deliberately-silent failure elsewhere in the project become
// visible: the SessionStart hook swallows every error so a twelve-hour session is never slowed or
// blocked by a broker that is down, and the intake layer answers a misrouted or forged hook post
// with a plain HTTP status and nothing else. Neither surface can afford to be loud; the log is where
// an operator looks when a session that should be reporting is not. Because a session name or a
// tool name is attacker-influenceable (any local process can announce a session with any name it
// likes), every logged message is neutralized with the same `inertName` helper the Discord surfaces
// use before it is written: a log file is a render site like any other. Callers never pass a
// `processToken` into a log message; it is the forgery key for hook posts and this module has no
// way to strip it back out once it is in a line.
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { inertName } from "./discord/render.ts";

/**
 * The subset of BrokerConfig this module needs. broker/config.ts owns loading these from the
 * environment (CHANNEL_BROKER_LOG_FILE, CHANNEL_BROKER_LOG_MAX_BYTES, CHANNEL_BROKER_LOG_MAX_FILES)
 * alongside every other broker knob, rather than this module keeping a second copy of that pattern.
 */
export type LogConfig = {
  /** Absolute path to the active log file. Logging is off (falls through to console) when null. */
  file: string | null;
  /** Rotate the active file once it reaches this size. */
  maxBytes: number;
  /** Total files kept on disk, the active file plus its rotated predecessors. */
  maxFiles: number;
};

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Shifts `file.1..file.(maxFiles-2)` one slot older, drops whatever already sits in the oldest
 * slot, and moves the active file into `file.1`. The caller creates a fresh active file on its next
 * write, since appendFileSync creates a missing file.
 *
 * With maxFiles at 1 there is no room for a rotated copy at all, so the active file is simply
 * cleared and logging starts over.
 */
function rotate(file: string, maxFiles: number): void {
  if (maxFiles <= 1) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }

  const oldest = `${file}.${maxFiles - 1}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    const to = `${file}.${index}`;
    if (existsSync(from)) renameSync(from, to);
  }
}

function write(config: LogConfig, level: string, message: string): void {
  if (config.file === null) return;
  try {
    // inertName strips control characters (including the newline that would otherwise let an
    // attacker-controlled name forge a second log line) and the bidi/zero-width characters that
    // could make a logged name read as something other than what it is. It is applied to the
    // caller's message only, after the trusted timestamp and level are already fixed in place.
    const line = `${new Date().toISOString()} [${level}] ${inertName(message)}\n`;
    appendFileSync(config.file, line, "utf8");
    if (statSync(config.file).size >= config.maxBytes) rotate(config.file, config.maxFiles);
  } catch {
    // A log write that fails is a dropped line, not a broker that stops. Nothing upstream treats
    // logging as load-bearing, so there is nothing further to escalate this to.
  }
}

/** A logger that writes to `config.file`, or does nothing when no file is configured. */
export function createLogger(config: LogConfig): Logger {
  return {
    info: (message) => write(config, "info", message),
    warn: (message) => write(config, "warn", message),
    error: (message) => write(config, "error", message),
  };
}
