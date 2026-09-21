// The operator inbox's state: at most one open item per session, each one a session whose reply
// needs something from the operator, held until the operator answers that session.
//
// An item opens from a flagged reply, either one the session marked with an `ASK:` line or one the
// external judge scored at or above its threshold, and every later flagged reply from the same
// session refreshes that item rather than opening a second: a close-out recap restating a standing
// wait attaches to the ask it restates. A marked flag upgrades a judged item and never the reverse,
// since the session's own word outranks a classifier's reading of it.
//
// What clears an item is an operator prompt to its session carrying an instant later than the item's
// last refresh, and never the operator having read it, because reading is how asks get missed. The
// store also keeps each session's latest prompt instant and drops a flag posted at or before it, so a
// judge verdict that returns after the operator has already answered opens nothing. Every instant is
// the one the reply was posted at, supplied by the caller, and never the instant this module runs.
//
// Synchronous and free of I/O apart from the snapshot's load and save, so each call site threads it
// the way it threads any other in-memory desk. Nothing here logs an excerpt, which is session text.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clean } from "../sanitize.ts";
import { SNOWFLAKE } from "../security/senders.ts";
import { MAX_EXCERPT_CODE_POINTS } from "./ask.ts";

const FORMAT_VERSION = 1;

export type InboxSource = "marked" | "judged";

/** The judge's two probabilities, each from 0 to 1. */
export type JudgeScores = { needsReply: number; needsAct: number };

/** Which of the judge's two questions carried the larger score. */
export type JudgeWinner = "needs_reply" | "needs_act";

/**
 * One flagged reply. `postedAt` is the epoch-millisecond instant the reply was posted, and it is what
 * an open or a refresh records. `messageId` is the Discord message the reply landed as, where the
 * writer returned one.
 */
export type InboxFlag =
  | { source: "marked"; postedAt: number; excerpt: string; messageId?: string }
  | {
      source: "judged";
      postedAt: number;
      scores: JudgeScores;
      winner: JudgeWinner;
      messageId?: string;
    };

export type InboxItem = {
  sessionId: string;
  openedAt: number;
  refreshedAt: number;
  source: InboxSource;
  /** The first `ASK:` line of the latest marked reply. Null while the item is judged. */
  excerpt: string | null;
  /** The latest judge reading, kept across an upgrade to marked. Null where no judge flag landed. */
  scores: JudgeScores | null;
  winner: JudgeWinner | null;
  /** Flagged replies since the item opened, starting at 1. */
  count: number;
  /** The most recent flagged post that carried a message ID. Null where none has. */
  messageId: string | null;
};

export type InboxStoreOptions = {
  /** Items to start from, the output of `loadInboxSnapshot`. */
  items?: readonly InboxItem[];
  /** Called after every change to the item set, never for a change that leaves it as it was. */
  onChange?: () => void;
};

export type InboxStore = {
  /** Opens or refreshes the session's item. False where the flag was dropped as late. */
  flag: (sessionId: string, flag: InboxFlag) => boolean;
  /**
   * Records an operator prompt to the session and removes its item where the prompt is later than
   * the item's last refresh. True where an item left.
   */
  clear: (sessionId: string, promptAt: number) => boolean;
  /**
   * Removes the session's item unconditionally and records nothing else: the operator posted in an
   * ended session's thread, where no prompt reaches a session and so no prompt instant exists.
   */
  clearEnded: (sessionId: string) => boolean;
  /** Drops every item, and every prompt instant, whose session is no longer in the registry. */
  reconcile: (liveSessionIds: ReadonlySet<string>) => boolean;
  /** Every item, oldest opened first and ties by session ID, as copies the caller may keep. */
  items: () => InboxItem[];
};

function copy(item: InboxItem): InboxItem {
  return { ...item, scores: item.scores === null ? null : { ...item.scores } };
}

export function createInboxStore(options: InboxStoreOptions = {}): InboxStore {
  const held = new Map<string, InboxItem>();
  for (const item of options.items ?? []) held.set(item.sessionId, copy(item));
  /** Each session's latest operator-prompt instant, the maximum seen. Not persisted. */
  const prompts = new Map<string, number>();
  const changed = options.onChange ?? (() => {});

  function flag(sessionId: string, incoming: InboxFlag): boolean {
    const promptAt = prompts.get(sessionId);
    if (promptAt !== undefined && incoming.postedAt <= promptAt) return false;

    const item = held.get(sessionId);
    if (item === undefined) {
      held.set(sessionId, {
        sessionId,
        openedAt: incoming.postedAt,
        refreshedAt: incoming.postedAt,
        source: incoming.source,
        excerpt: incoming.source === "marked" ? incoming.excerpt : null,
        scores: incoming.source === "judged" ? { ...incoming.scores } : null,
        winner: incoming.source === "judged" ? incoming.winner : null,
        count: 1,
        messageId: incoming.messageId ?? null,
      });
    } else {
      item.refreshedAt = Math.max(item.refreshedAt, incoming.postedAt);
      item.count += 1;
      if (incoming.messageId !== undefined) item.messageId = incoming.messageId;
      if (incoming.source === "marked") {
        item.source = "marked";
        item.excerpt = incoming.excerpt;
      } else {
        // The scores follow the latest judge reading on either source. The source and the excerpt
        // do not: a judged flag never takes a marked item back to judged.
        item.scores = { ...incoming.scores };
        item.winner = incoming.winner;
      }
    }
    changed();
    return true;
  }

  function clear(sessionId: string, promptAt: number): boolean {
    prompts.set(sessionId, Math.max(prompts.get(sessionId) ?? promptAt, promptAt));
    const item = held.get(sessionId);
    // Strictly later: a prompt at or before the last flagged reply was written before the operator
    // could have seen that reply, so it answers an older state of the session, not this ask.
    if (item === undefined || promptAt <= item.refreshedAt) return false;
    held.delete(sessionId);
    changed();
    return true;
  }

  function clearEnded(sessionId: string): boolean {
    if (!held.delete(sessionId)) return false;
    changed();
    return true;
  }

  function reconcile(liveSessionIds: ReadonlySet<string>): boolean {
    for (const sessionId of prompts.keys()) {
      if (!liveSessionIds.has(sessionId)) prompts.delete(sessionId);
    }
    let removed = false;
    for (const sessionId of held.keys()) {
      if (liveSessionIds.has(sessionId)) continue;
      held.delete(sessionId);
      removed = true;
    }
    if (removed) changed();
    return removed;
  }

  function items(): InboxItem[] {
    return [...held.values()]
      .map(copy)
      .sort((a, b) =>
        a.openedAt !== b.openedAt
          ? a.openedAt - b.openedAt
          : a.sessionId < b.sessionId
            ? -1
            : a.sessionId > b.sessionId
              ? 1
              : 0,
      );
  }

  return { flag, clear, clearEnded, reconcile, items };
}

type Snapshot = {
  version: number;
  items: InboxItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScore(value: unknown): value is number {
  return isInstant(value) && value >= 0 && value <= 1;
}

/**
 * One restored item, checked field by field, or null where any field is not what this module
 * writes. The message ID is normalized before it is checked, the way the card bindings treat theirs,
 * because it is interpolated into a link and what is checked has to be what will be used.
 */
function restoreItem(value: unknown): InboxItem | null {
  if (!isRecord(value)) return null;
  const { sessionId, openedAt, refreshedAt, source, excerpt, scores, winner, count, messageId } =
    value;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (!isInstant(openedAt) || !isInstant(refreshedAt) || openedAt > refreshedAt) return null;
  if (source !== "marked" && source !== "judged") return null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return null;

  let restoredScores: JudgeScores | null = null;
  if (scores !== null) {
    if (!isRecord(scores) || !isScore(scores.needsReply) || !isScore(scores.needsAct)) return null;
    restoredScores = { needsReply: scores.needsReply, needsAct: scores.needsAct };
  }
  if (winner !== null && winner !== "needs_reply" && winner !== "needs_act") return null;
  // A reading is its scores and its winner together, never one without the other.
  if ((restoredScores === null) !== (winner === null)) return null;

  if (source === "marked") {
    if (typeof excerpt !== "string" || [...excerpt].length > MAX_EXCERPT_CODE_POINTS) return null;
  } else if (excerpt !== null || restoredScores === null) {
    return null;
  }

  let restoredMessageId: string | null = null;
  if (messageId !== null) {
    if (typeof messageId !== "string") return null;
    restoredMessageId = clean(messageId);
    if (!SNOWFLAKE.test(restoredMessageId)) return null;
  }

  return {
    sessionId,
    openedAt,
    refreshedAt,
    source,
    excerpt: source === "marked" ? (excerpt as string) : null,
    scores: restoredScores,
    winner: winner as JudgeWinner | null,
    count,
    messageId: restoredMessageId,
  };
}

export type LoadInboxSnapshotOptions = {
  /** The sessions whose records restored. An item for any other session is dropped. */
  liveSessionIds: ReadonlySet<string>;
  log?: (message: string) => void;
};

/**
 * The items a previous broker held, or none where there is nothing sound to restore. Never throws:
 * a lost inbox costs the operator the asks already on it, and a broker that will not start costs
 * every session.
 *
 * A single malformed item refuses the whole snapshot rather than just that item, since a file that
 * is wrong in one place is not one whose other entries can be trusted.
 */
export function loadInboxSnapshot(file: string, options: LoadInboxSnapshotOptions): InboxItem[] {
  const log = options.log ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No file is the normal first boot, and is not worth a word.
    if (isRecord(error) && error.code === "ENOENT") return [];
    log(`broker: cannot read the inbox snapshot at ${file}, starting empty: ${String(error)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's own message quotes the text around the fault, which can be an excerpt, so the
    // detail is withheld.
    log(`broker: the inbox snapshot at ${file} is not valid JSON, starting empty`);
    return [];
  }

  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.items)) {
    log(`broker: the inbox snapshot at ${file} is not a snapshot of this format, starting empty`);
    return [];
  }

  const restored: InboxItem[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.items) {
    const item = restoreItem(entry);
    if (item === null || seen.has(item.sessionId)) {
      log(`broker: the inbox snapshot at ${file} is malformed, starting empty`);
      return [];
    }
    seen.add(item.sessionId);
    if (options.liveSessionIds.has(item.sessionId)) restored.push(item);
  }
  return restored;
}

export function saveInboxSnapshot(file: string, items: readonly InboxItem[]): void {
  const snapshot: Snapshot = { version: FORMAT_VERSION, items: [...items] };
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
