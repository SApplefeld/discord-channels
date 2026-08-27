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
import { MAX_BACKGROUND_TASKS, MAX_BACKGROUND_TASK_ID_LENGTH } from "./registry.ts";
import type {
  BackgroundTask,
  BackgroundTaskKind,
  ModelFallback,
  ModelFallbackCause,
  SessionRecord,
  SessionState,
} from "./registry.ts";
import { MAX_PEER_NAME_LENGTH, boundedTitle, clean, cleanWellFormed } from "./sanitize.ts";

const FORMAT_VERSION = 1;

/**
 * A record as the file carries it: every field but the goal, which is operator prose off a
 * transcript that only the card reads and that a load never restores anyway. Writing it would put
 * it on disk for the record's whole retention life for nothing.
 */
type PersistedRecord = Omit<SessionRecord, "goal">;

type Snapshot = {
  version: number;
  sessions: PersistedRecord[];
};

const STATES: readonly SessionState[] = ["live", "stale", "ended"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * For a field a snapshot on disk may predate: absent is accepted alongside null and a string, and
 * `cleanRecord` below is what turns absent into null.
 *
 * A strict check here would be a whole-snapshot rejection, because one malformed record empties the
 * registry, and every session in it would lose the Discord thread its record is what binds it to.
 * The cost of the tolerance is bounded to this one field, which every surface already renders as
 * "nothing to say".
 */
function absentOrString(value: unknown): boolean {
  return value === undefined || optionalString(value);
}

function optionalNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

/** `absentOrString`'s numeric pair, for a number field a snapshot on disk may predate. */
function absentOrNumber(value: unknown): boolean {
  return value === undefined || optionalNumber(value);
}

const FALLBACK_CAUSES: readonly ModelFallbackCause[] = ["refusal", "consent"];

/**
 * A persisted downgrade record, reduced to null whenever the file cannot vouch for its whole
 * shape. Field-level tolerance rather than a clause in the record validator, on `absentOrString`'s
 * own reasoning taken one step further: a strict check would be a whole-snapshot rejection, so one
 * malformed record would empty the registry and cost every session on the host the Discord thread
 * its record binds it to. Nulling the field costs a missing marker, which every surface already
 * renders. The strings are cleaned like every other string read back from this file, because the
 * state file is an ordinary file anything running as this user can rewrite.
 */
function fallbackOrNull(value: unknown): ModelFallback | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.cause !== "string" ||
    !FALLBACK_CAUSES.includes(value.cause as ModelFallbackCause) ||
    typeof value.originalModel !== "string" ||
    typeof value.fallbackModel !== "string" ||
    !optionalString(value.category) ||
    !optionalString(value.choice)
  ) {
    return null;
  }
  return {
    cause: value.cause as ModelFallbackCause,
    originalModel: clean(value.originalModel),
    fallbackModel: clean(value.fallbackModel),
    category: typeof value.category === "string" ? clean(value.category) : null,
    choice: typeof value.choice === "string" ? clean(value.choice) : null,
  };
}

const TASK_KINDS: readonly BackgroundTaskKind[] = ["subagent", "shell"];

/**
 * A persisted roster, kept entry by entry: an entry the file cannot vouch for whole contributes
 * nothing, while the rest of the table still lands, and a field that is not an array at all is an
 * empty roster. Field-level tolerance rather than a clause in the record validator, on
 * `fallbackOrNull`'s reasoning: any clause there is a whole-snapshot rejection.
 *
 * The roster is restored, first-sighting stamps included, where the context size beside it is
 * dropped, because the two age differently. The table is authoritative and replaced wholesale by
 * the session's next `Stop`, so a restored roster is bounded rather than accumulating: a stale one
 * shows visibly old ages and corrects itself the moment the session reports again, and one whose
 * session never comes back is bounded by the surfaces' own death backstop. Dropping it instead
 * would read a session as idle for the whole remaining fan-out after a mid-fan-out restart, which
 * is exactly the blindness the roster exists to remove. The bounds are the wire intake's own,
 * imported so the two readers cannot drift: the state file is an ordinary file anything running as
 * this user can rewrite.
 */
function tasksOrEmpty(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: BackgroundTask[] = [];
  for (const entry of value) {
    if (tasks.length >= MAX_BACKGROUND_TASKS) break;
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || entry.id.length > MAX_BACKGROUND_TASK_ID_LENGTH) continue;
    if (typeof entry.kind !== "string" || !TASK_KINDS.includes(entry.kind as BackgroundTaskKind)) {
      continue;
    }
    if (!optionalString(entry.description) || !optionalString(entry.agentType)) continue;
    if (!isFiniteNumber(entry.since)) continue;
    const id = clean(entry.id);
    if (id === "") continue;
    // A string that cleans to nothing lands as null, the same answer the wire's own reader gives.
    const description = typeof entry.description === "string" ? clean(entry.description) : "";
    const agentType = typeof entry.agentType === "string" ? clean(entry.agentType) : "";
    tasks.push({
      id,
      kind: entry.kind as BackgroundTaskKind,
      description: description === "" ? null : description,
      agentType: agentType === "" ? null : agentType,
      since: entry.since as number,
    });
  }
  return tasks;
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
    absentOrString(value.lastToolInput) &&
    isFiniteNumber(value.toolCount) &&
    isFiniteNumber(value.turnCount) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.lastHookAt) &&
    absentOrNumber(value.lastEngagementAt) &&
    optionalNumber(value.lastRelayAt) &&
    optionalNumber(value.endedAt) &&
    absentOrString(value.openingModel) &&
    absentOrString(value.model) &&
    absentOrNumber(value.contextTokens) &&
    absentOrString(value.title)
    // `downgrade` and `backgroundTasks` are deliberately unvalidated here: they are the nested
    // fields, and cleanRecord reduces a malformed one at field level (to null and to the readable
    // entries) rather than letting it reject the snapshot whole.
  );
}

// The same normalization the wire applies. A state file is an ordinary file that anything running
// as this user can rewrite, so a string read back from it is no more trusted than one posted in.
function cleanRecord(record: SessionRecord): SessionRecord {
  // Widened because a snapshot predating this field carries no value for it, which the validator
  // above accepts. It lands as null here, so nothing downstream ever meets an undefined.
  const lastToolInput: string | null | undefined = record.lastToolInput;
  // Widened for the same reason, and read through one local each so a snapshot predating the model
  // fields lands as null rather than as undefined on a record every surface reads.
  const openingModel: string | null | undefined = record.openingModel;
  const model: string | null | undefined = record.model;
  // Widened for the same reason, and defaulted to `lastHookAt` because that is the closest thing a
  // snapshot predating the field carries: the conservative direction, since it may read a session
  // that stands blocked as freshly engaged (a blocked stop stamps `lastHookAt`) and so clear its
  // marker early, across the one restart that upgrades the file, rather than pinning a blocked
  // state onto a session nobody is waiting on.
  const lastEngagementAt: number | null | undefined = record.lastEngagementAt;
  // Widened for the same reason: a snapshot written before this field existed carries no value for
  // it, and it lands as null here rather than as undefined on a record every surface reads.
  const title: string | null | undefined = record.title;
  return {
    ...record,
    sessionId: clean(record.sessionId),
    processToken: clean(record.processToken),
    name: record.name === null ? null : cleanWellFormed(record.name),
    host: clean(record.host),
    source: record.source === null ? null : clean(record.source),
    lastTool: record.lastTool === null ? null : clean(record.lastTool),
    lastToolInput:
      lastToolInput === undefined || lastToolInput === null ? null : clean(lastToolInput),
    openingModel: openingModel === undefined || openingModel === null ? null : clean(openingModel),
    model: model === undefined || model === null ? null : clean(model),
    lastEngagementAt:
      lastEngagementAt === undefined || lastEngagementAt === null
        ? record.lastHookAt
        : lastEngagementAt,
    // Dropped rather than restored: the context size is a live figure, and one written hours ago
    // would render as the size the session is running at right now. The next transcript line
    // reports the real one, and until it does the card carries the model without a figure beside it.
    contextTokens: null,
    // Dropped for the same reason, and one the card is built around: whether a goal is still being
    // worked toward is not observable, so a goal restored from a snapshot would draw as current on
    // a card indefinitely, which reads worse than no goal line at all.
    goal: null,
    // Restored, unlike the goal: the title is the session's own identity, set by a launch `--name`
    // or an in-session `/rename`, rather than transient intent, so a restart should draw the name
    // the operator knows it by.
    //
    // Routed through `boundedTitle`, the same composition the transcript reader applies
    // (`broker/tail.ts`'s `customTitle`), rather than through `clean` alone: this file is one
    // anything running as this user can rewrite, and a restore that only cleaned would carry an
    // unnormalized, wrongly-bounded value all the way to `GET /sessions` and a rename.
    title: title === undefined || title === null ? null : boundedTitle(title, MAX_PEER_NAME_LENGTH),
    // Absent, null, and malformed all land as null: the validator above vouches for every other
    // field of the record, and this one answers for itself.
    downgrade: fallbackOrNull(record.downgrade),
    // Restored entry by entry, stamps included; tasksOrEmpty above says why, and answering for
    // itself here is what keeps it out of the validator above, where any clause is a
    // whole-snapshot rejection that would cost every session on the host its thread binding.
    backgroundTasks: tasksOrEmpty(record.backgroundTasks),
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

/**
 * One record reduced to what the file holds, field by field rather than by deleting from a copy, on
 * `redact`'s discipline at the publishing seam: a field added to SessionRecord has to be written to
 * disk deliberately instead of arriving here on its own.
 *
 * What it keeps and what that route withholds differ because the reasons do: the process token is
 * the join key a hook post is authenticated by, and a restart that lost it would orphan every live
 * session, so it is written here and never published. The goal is read by one card and by nothing
 * else, restored by nothing, so it is written nowhere.
 */
function persisted(record: SessionRecord): PersistedRecord {
  return {
    sessionId: record.sessionId,
    processToken: record.processToken,
    name: record.name,
    host: record.host,
    source: record.source,
    state: record.state,
    lastTool: record.lastTool,
    lastToolInput: record.lastToolInput,
    toolCount: record.toolCount,
    turnCount: record.turnCount,
    startedAt: record.startedAt,
    lastHookAt: record.lastHookAt,
    lastEngagementAt: record.lastEngagementAt,
    lastRelayAt: record.lastRelayAt,
    endedAt: record.endedAt,
    openingModel: record.openingModel,
    model: record.model,
    // Written, and dropped on load rather than here: the snapshot is written whole on every
    // mutation, so what a restart must not read back is settled by the load path alone.
    contextTokens: record.contextTokens,
    downgrade: record.downgrade,
    backgroundTasks: record.backgroundTasks,
    title: record.title,
  };
}

export function saveSessions(file: string, sessions: SessionRecord[]): void {
  const snapshot: Snapshot = { version: FORMAT_VERSION, sessions: sessions.map(persisted) };
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
