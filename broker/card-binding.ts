// The one binding module every standing card (board, usage, inbox) persists its own thread
// through, so a broker restart edits the card it already owns instead of opening a second
// "Fleet: <card>" thread beside the first one.
//
// A versioned snapshot goes to a sibling temp file, renamed over the target; a file that is
// unreadable or the wrong shape degrades to no binding rather than refusing to start. The failure
// that costs is a duplicate thread, not a dead broker.
//
// Each card keeps its own file rather than a record inside another surface's, because every
// standing card is independent: each is built under its own knob, and a broker running one of
// them writes and reads nothing on another's account. The label composes every log line, so an
// operator grepping for "the board card binding" or "the usage card binding" finds it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clean } from "./sanitize.ts";
import { SNOWFLAKE } from "./security/senders.ts";

const FORMAT_VERSION = 1;

export type CardBinding = {
  /** The card itself: posted to the channel once, opened as a thread, and edited in place after. */
  messageId: string;
  /** Null while the card is posted but the thread has not been opened on it yet. */
  threadId: string | null;
};

type Snapshot = {
  version: number;
  binding: CardBinding;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LoadCardBindingOptions = {
  log?: (message: string) => void;
};

/** The thread this broker already owns, or null when there is none to rebind to. */
export function loadCardBinding(
  file: string,
  label: string,
  options: LoadCardBindingOptions = {},
): CardBinding | null {
  const log = options.log ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No file is the normal first boot, and is not worth a word.
    if (isRecord(error) && error.code === "ENOENT") return null;
    log(
      `broker: cannot read the ${label} card binding at ${file}, starting with none: ${String(error)}`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(
      `broker: the ${label} card binding at ${file} is not valid JSON, starting with none: ` +
        String(error),
    );
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !isRecord(parsed.binding)) {
    log(
      `broker: the ${label} card binding at ${file} is not a snapshot of this format, ` +
        `starting with none`,
    );
    return null;
  }

  const held = parsed.binding;
  if (
    typeof held.messageId !== "string" ||
    !(held.threadId === null || typeof held.threadId === "string")
  ) {
    log(`broker: the ${label} card binding at ${file} is malformed, starting with none`);
    return null;
  }

  // Normalized first, then checked: a padded identifier on disk is exactly what the normalization
  // is for, and what is checked has to be the value that will actually reach a request path.
  const binding: CardBinding = {
    messageId: clean(held.messageId),
    threadId: held.threadId === null ? null : clean(held.threadId),
  };
  // Both identifiers are interpolated into token-bearing request paths, the way the channel is.
  const threadIdValid = binding.threadId === null || SNOWFLAKE.test(binding.threadId);
  if (!SNOWFLAKE.test(binding.messageId) || !threadIdValid) {
    log(
      `broker: the ${label} card binding at ${file} names something that is not a Discord ` +
        `identifier, starting with none`,
    );
    return null;
  }
  return binding;
}

export function saveCardBinding(file: string, binding: CardBinding): void {
  const snapshot: Snapshot = { version: FORMAT_VERSION, binding };
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
