// Persistence for the session-to-thread bindings, so a broker restart reattaches to the threads it
// already owns instead of opening a second one for every session in the registry.
//
// Written the same way the registry snapshot is: to a sibling temp file and renamed over the
// target, and a file that is unreadable or the wrong shape degrades to no bindings rather than
// refusing to start. The failure that costs is a duplicate thread, not a dead broker.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_PEER_NAME_LENGTH, boundedTitle, clean, cleanWellFormed } from "../sanitize.ts";

const FORMAT_VERSION = 1;

export type ThreadBinding = {
  sessionId: string;
  /** The starter message. Posted before the thread exists, and never posted twice. */
  messageId: string;
  /** Null while the card is posted but the thread has not been opened on it yet. */
  threadId: string | null;
  archived: boolean;
  /**
   * The session's human name. Carried here because a restart can outlive the registry record: a
   * thread whose session is already gone still has to be titled with the name the operator knows
   * it by rather than a fragment of its session ID.
   */
  name: string | null;
  /** The title the thread carries, so a restart does not spend a rename repainting it. */
  title: string | null;
  /**
   * The session's own title, as a `custom-title` transcript line last set it. Carried here for the
   * same reason `name` is: a restart can outlive the registry record, and rebuilding a placeholder
   * view with no title would compose the launch name and repaint the thread back to it, spending a
   * rename to undo a rename the operator asked for. Not called `title`, which already names the
   * fully composed thread title (glyph, name, state suffix) this field is one input to.
   */
  sessionTitle: string | null;
};

type Snapshot = {
  version: number;
  bindings: ThreadBinding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Both identifiers are interpolated into token-bearing request paths, the way the channel is. */
const SNOWFLAKE = /^\d{17,20}$/;

function optionalString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * For a field a snapshot on disk may predate: absent is accepted alongside null and a string, and
 * `cleanBinding` below is what turns absent into null. A strict check here would be a
 * whole-snapshot rejection, and a bindings file already on disk when `sessionTitle` shipped has no
 * such key at all: rejecting it would drop every binding on the first restart after deploy and open
 * a second thread for every live session.
 */
function absentOrString(value: unknown): boolean {
  return value === undefined || optionalString(value);
}

function isBinding(value: unknown): value is ThreadBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.messageId === "string" &&
    (value.threadId === null || typeof value.threadId === "string") &&
    typeof value.archived === "boolean" &&
    optionalString(value.name) &&
    optionalString(value.title) &&
    absentOrString(value.sessionTitle)
  );
}

// The same normalization the wire applies. These identifiers are interpolated into request paths,
// and the file is an ordinary one that anything running as this user can rewrite.
function cleanBinding(binding: ThreadBinding): ThreadBinding {
  // Widened because a snapshot predating this field carries no value for it, which the validator
  // above accepts; it lands as null here, the same as an explicit null, so nothing downstream ever
  // meets an undefined.
  const sessionTitle: string | null | undefined = binding.sessionTitle;
  return {
    sessionId: clean(binding.sessionId),
    messageId: clean(binding.messageId),
    threadId: binding.threadId === null ? null : clean(binding.threadId),
    archived: binding.archived,
    name: binding.name === null ? null : cleanWellFormed(binding.name),
    title: binding.title === null ? null : clean(binding.title),
    // Routed through `boundedTitle`, the same composition the transcript reader applies
    // (`broker/tail.ts`'s `customTitle`), rather than through `clean` alone: this file is one
    // anything running as this user can rewrite, and a restore that only cleaned would carry an
    // unnormalized, wrongly-bounded value all the way to the render site and a rename.
    sessionTitle:
      sessionTitle === undefined || sessionTitle === null
        ? null
        : boundedTitle(sessionTitle, MAX_PEER_NAME_LENGTH),
  };
}

export type LoadOptions = {
  log?: (message: string) => void;
};

export function loadBindings(file: string, options: LoadOptions = {}): ThreadBinding[] {
  const log = options.log ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No file is the normal first boot, and is not worth a word.
    if (isRecord(error) && error.code === "ENOENT") return [];
    log(`broker: cannot read the thread bindings at ${file}, starting with none: ${String(error)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parse error is deliberately unread. Its message embeds an excerpt of the offending
    // text, and this file now persists a session title, which is transcript content that reaches
    // the broker log at no level. The tailer discards its own parse errors for the same reason.
    log(`broker: the thread bindings at ${file} are not valid JSON, starting with none`);
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.bindings) || parsed.version !== FORMAT_VERSION) {
    log(`broker: the thread bindings at ${file} are not a snapshot of this format, starting with none`);
    return [];
  }

  if (!parsed.bindings.every(isBinding)) {
    log(`broker: the thread bindings at ${file} are malformed, starting with none`);
    return [];
  }

  // Normalized first, then checked: a padded identifier on disk is exactly what the normalization
  // is for, and what is checked has to be the value that will actually reach a request path.
  const cleaned = parsed.bindings.map(cleanBinding);
  const identified = (binding: ThreadBinding): boolean =>
    SNOWFLAKE.test(binding.messageId) &&
    (binding.threadId === null || SNOWFLAKE.test(binding.threadId));
  if (!cleaned.every(identified)) {
    log(
      `broker: the thread bindings at ${file} name something that is not a Discord identifier, ` +
        `starting with none`,
    );
    return [];
  }

  // One session owns one thread. A duplicate would silently orphan whichever thread lost, so the
  // first is kept and the loss is reported rather than made quietly.
  const kept = new Map<string, ThreadBinding>();
  for (const binding of cleaned) {
    const existing = kept.get(binding.sessionId);
    if (existing === undefined) {
      kept.set(binding.sessionId, binding);
      continue;
    }
    log(
      `broker: the thread bindings at ${file} name session ${binding.sessionId} twice, ` +
        `keeping thread ${String(existing.threadId)} and orphaning ${String(binding.threadId)}`,
    );
  }
  return [...kept.values()];
}

export function saveBindings(file: string, bindings: ThreadBinding[]): void {
  const snapshot: Snapshot = { version: FORMAT_VERSION, bindings };
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
