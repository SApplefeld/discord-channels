// Persistence for the board card's own thread, so a broker restart edits the card it already owns
// instead of opening a second "Fleet: Board" thread beside the first one.
//
// Written the way the usage card's binding beside it is: a versioned snapshot to a sibling temp file
// renamed over the target, and a file that is unreadable or the wrong shape degrades to no binding
// rather than refusing to start. The failure that costs is a duplicate thread, not a dead broker.
//
// Its own file rather than a record inside another surface's: the two cards are independent, each is
// built under its own knob, and a broker running one of them writes and reads nothing on the other's
// account.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clean } from "../sanitize.ts";

const FORMAT_VERSION = 1;

/** Both identifiers are interpolated into token-bearing request paths, the way the channel is. */
const SNOWFLAKE = /^\d{17,20}$/;

export type BoardCardBinding = {
  /** The card itself: posted to the channel once, opened as a thread, and edited in place after. */
  messageId: string;
  /** Null while the card is posted but the thread has not been opened on it yet. */
  threadId: string | null;
};

type Snapshot = {
  version: number;
  binding: BoardCardBinding;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LoadBoardBindingOptions = {
  log?: (message: string) => void;
};

/** The thread this broker already owns, or null when there is none to rebind to. */
export function loadBoardBinding(
  file: string,
  options: LoadBoardBindingOptions = {},
): BoardCardBinding | null {
  const log = options.log ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No file is the normal first boot, and is not worth a word.
    if (isRecord(error) && error.code === "ENOENT") return null;
    log(
      `broker: cannot read the board card binding at ${file}, starting with none: ${String(error)}`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(
      `broker: the board card binding at ${file} is not valid JSON, starting with none: ` +
        String(error),
    );
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !isRecord(parsed.binding)) {
    log(
      `broker: the board card binding at ${file} is not a snapshot of this format, ` +
        `starting with none`,
    );
    return null;
  }

  const held = parsed.binding;
  if (
    typeof held.messageId !== "string" ||
    !(held.threadId === null || typeof held.threadId === "string")
  ) {
    log(`broker: the board card binding at ${file} is malformed, starting with none`);
    return null;
  }

  // Normalized first, then checked: a padded identifier on disk is exactly what the normalization
  // is for, and what is checked has to be the value that will actually reach a request path.
  const binding: BoardCardBinding = {
    messageId: clean(held.messageId),
    threadId: held.threadId === null ? null : clean(held.threadId),
  };
  const threadIdValid = binding.threadId === null || SNOWFLAKE.test(binding.threadId);
  if (!SNOWFLAKE.test(binding.messageId) || !threadIdValid) {
    log(
      `broker: the board card binding at ${file} names something that is not a Discord ` +
        `identifier, starting with none`,
    );
    return null;
  }
  return binding;
}

export function saveBoardBinding(file: string, binding: BoardCardBinding): void {
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
