// Registry persistence, so a broker restart does not lose the fleet.
//
// Writes go to a sibling temp file and are renamed over the target, which is atomic enough that a
// crash mid-write leaves the previous snapshot intact rather than a truncated one. A file that is
// unreadable or the wrong shape degrades to an empty registry and logs: the broker coming up blind
// is recoverable (the next SessionStart re-announces), the broker refusing to come up is not.
//
// The file holds every live process token, which is what a hook post is authenticated by, so it is
// written for the owning user only.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionRecord, SessionState } from "./registry.ts";
import { clean } from "./sanitize.ts";

const FORMAT_VERSION = 1;

type Snapshot = {
  version: number;
  sessions: SessionRecord[];
};

const STATES: readonly SessionState[] = ["live", "stale", "ended"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

// Every numeric field is checked for finiteness, not merely for being a number: JSON.parse turns
// 1e999 into Infinity, and an infinite lastHookAt would hold a record out of every staleness sweep.
function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

// A persisted record is parsed, never trusted: the file is on disk where anything could have
// written it, and a wrong-shaped field would otherwise surface as a crash somewhere downstream.
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.processToken === "string" &&
    optionalString(value.name) &&
    typeof value.host === "string" &&
    optionalString(value.source) &&
    typeof value.state === "string" &&
    STATES.includes(value.state as SessionState) &&
    optionalString(value.lastTool) &&
    isFiniteNumber(value.toolCount) &&
    isFiniteNumber(value.turnCount) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.lastHookAt) &&
    optionalNumber(value.lastRelayAt) &&
    optionalNumber(value.endedAt)
  );
}

// The same normalization the wire applies. A state file is an ordinary file that anything running
// as this user can rewrite, so a string read back from it is no more trusted than one posted in.
function cleanRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    sessionId: clean(record.sessionId),
    processToken: clean(record.processToken),
    name: record.name === null ? null : clean(record.name),
    host: clean(record.host),
    source: record.source === null ? null : clean(record.source),
    lastTool: record.lastTool === null ? null : clean(record.lastTool),
  };
}

export type LoadOptions = {
  /** Corruption is reported here rather than to the console so a test can assert on it. */
  log?: (message: string) => void;
};

export function loadSessions(file: string, options: LoadOptions = {}): SessionRecord[] {
  const log = options.log ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No state file is the normal first boot, and is not worth a word.
    if (isRecord(error) && error.code === "ENOENT") return [];
    log(`broker: cannot read the registry state at ${file}, starting empty: ${String(error)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(`broker: the registry state at ${file} is not valid JSON, starting empty: ${String(error)}`);
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    log(`broker: the registry state at ${file} is not a snapshot, starting empty`);
    return [];
  }

  if (parsed.version !== FORMAT_VERSION) {
    // A snapshot from a format this build does not know is treated exactly like a corrupt one:
    // guessing at unknown fields is how a wrong-shaped record gets in.
    log(
      `broker: the registry state at ${file} is format ${String(parsed.version)}, not ` +
        `${FORMAT_VERSION}, starting empty`,
    );
    return [];
  }

  if (!parsed.sessions.every(isSessionRecord)) {
    log(`broker: the registry state at ${file} holds malformed records, starting empty`);
    return [];
  }

  return parsed.sessions.map(cleanRecord);
}

export function saveSessions(file: string, sessions: SessionRecord[]): void {
  const snapshot: Snapshot = { version: FORMAT_VERSION, sessions };
  // A unique temp name, so two writers cannot land on each other's half-written file.
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    // A temp file left behind would never be cleaned up by anything else.
    rmSync(temp, { force: true });
    throw error;
  }
}
