// The usage cache reader: what the fleet card knows about account limits, taken from claude-swap's
// own local state and from nothing else.
//
// claude-swap (a separate tool that rotates the machine's Claude accounts) keeps its poll results
// in two files under its backup directory. This module opens exactly those two, read-only:
// `cache/usage.json` for the per-account windows and freshness, and `sequence.json` for the display
// identity and which account is active. It never invokes claude-swap, never touches the network,
// and never opens anything else under that root, which matters because the credentials directory
// beside them holds base64-encoded plaintext OAuth material. The allowlist of two paths is the
// whole of that guarantee.
//
// Mirroring rather than polling is the design: the numbers are whatever claude-swap last wrote, and
// `fetchedAt` rides out with them so the card can age them honestly. A cache nobody is refreshing
// goes stale, and a stale reading is still a reading.
//
// The files belong to another program and can grow, shrink, or change shape without notice, so
// every field is taken by allowlist and every one of them is optional: absence is the observed
// normal case (one live account's `five_hour` carries `pct` alone, another carries no `spend` block
// at all), not an error. Nothing is re-serialized wholesale, reads are byte-capped, and a file that
// is unreadable, oversized, malformed, or the wrong shape yields an unavailable reading rather than
// a throw. Nothing read here is logged: the reading carries a static reason instead, so the caller
// owns the log line and its rate limiting, and a parse error, which embeds an excerpt of its own
// source, is discarded unread.
import { closeSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ceiling on either file. The live cache runs about three kilobytes for three accounts, so this is
 * room for roughly twenty times that before a file this reader will not read. Past it the read
 * reports oversized without parsing: an unbounded read of another program's file is what a cap
 * exists to refuse, and a card cannot render a fleet that size anyway.
 */
export const MAX_USAGE_FILE_BYTES = 64 * 1024;

/** The most accounts one reading carries, ordered by account number. */
export const MAX_USAGE_ACCOUNTS = 16;

/** The most per-model rows one account contributes. */
export const MAX_SCOPED_WINDOWS = 8;

/**
 * One usage window: how much of it is spent, and when it resets.
 *
 * `resetsAt` is epoch milliseconds parsed from the cache's ISO `resets_at`, and null when the cache
 * carried none, which happens per window in practice. The cache's own `countdown` and `clock`
 * strings are deliberately not read: both were computed when claude-swap fetched, so they drift as
 * the cache ages, and a countdown rendered beside an honest "as of" age has to be derived from the
 * reset instant and the current time rather than repeated from the file.
 */
export type UsageWindow = { pct: number; resetsAt: number | null };

/** A per-model window, named by the model family the upstream limit is scoped to. */
export type ScopedWindow = UsageWindow & { name: string };

/** The spend block, present only for an account whose plan carries a credit limit. */
export type UsageSpend = {
  pct: number;
  used: number | null;
  limit: number | null;
  currency: string | null;
};

/**
 * One account's reading. Every window is nullable because the cache really does omit them, and the
 * display identity is nullable because it comes from the other file, which can be absent on its
 * own.
 */
export type UsageAccount = {
  /** The account's slot number, which is the key claude-swap holds it under in both files. */
  number: number;
  /** From `sequence.json`, never from the cache's own copy: one file owns display identity. */
  email: string | null;
  organizationName: string | null;
  active: boolean;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  spend: UsageSpend | null;
  scoped: ScopedWindow[];
  /** When claude-swap last fetched these numbers, in epoch milliseconds. */
  fetchedAt: number | null;
  /** How many polls in a row failed, floored at zero and whole: the cache's own field is untrusted. */
  consecutiveFailures: number;
  /**
   * True when the cache holds a `lastError` for this account. Presence only, because claude-swap
   * clears the field on a success, so its being set is exactly "the last poll failed". Its content
   * is another program's error text and this reading feeds a Discord message, so none of it is
   * carried.
   */
  failing: boolean;
  /**
   * When claude-swap will next attempt this account, in epoch milliseconds, and null when it is
   * attempting freely. An instant rather than a flag, because claude-swap leaves the field set after
   * the pause it describes has elapsed: backing off is `now < backoffUntil` (claude-swap's own
   * `UsageEntry.in_backoff`), so a reader holding a boolean warns forever after one slow poll.
   */
  backoffUntil: number | null;
};

/**
 * Why a reading carries no accounts. Static words, safe to log and safe to render.
 *
 * `unreadable` is deliberately coarse: an absent file, a permission refusal, and a sharing violation
 * against claude-swap's own atomic replace of the cache are one reason here, because this reader
 * cannot tell them apart from the outside and a card that names a cause it guessed at is worse than
 * one that names the effect.
 */
export type UsageUnavailableReason = "unreadable" | "oversized" | "malformed";

export type UsageReading =
  | { available: true; accounts: UsageAccount[] }
  | { available: false; reason: UsageUnavailableReason };

/** What one capped read yields: the file's text, or why there is none. */
export type CappedRead = { text: string } | { failed: "unreadable" | "oversized" };

export type ReadUsageOptions = {
  /** claude-swap's backup directory. Defaults to the one under the operator's profile. */
  root?: string;
  /** The one read this module performs. Injected so a test can pin which files are opened. */
  readFile?: (file: string, maxBytes: number) => CappedRead;
};

/**
 * Where claude-swap keeps its state: `.claude-swap-backup` under the user profile. A parameter
 * everywhere it is used, so a non-standard install is a configuration change and a test never
 * reads the operator's real cache.
 */
export function defaultUsageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.USERPROFILE ?? os.homedir(), ".claude-swap-backup");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Finiteness rather than merely a number: JSON.parse turns 1e999 into Infinity, and an infinite
// percentage or timestamp renders as garbage on the card and compares wrongly against every bound.
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// claude-swap writes its timestamps as fractional epoch seconds. Every other clock in this broker
// is epoch milliseconds, so the conversion happens here, at the boundary, rather than in the
// renderer that would otherwise have to know one surface counts differently from the rest. The
// result is re-checked because the multiply is its own way back to infinity: a finite 1e308 seconds
// is an infinite millisecond count.
function epochMs(value: unknown): number | null {
  const seconds = finite(value);
  if (seconds === null) return null;
  const ms = Math.round(seconds * 1000);
  return Number.isFinite(ms) ? ms : null;
}

// A whole count, floored at zero: the cache's own number can be fractional or negative, and both
// render as nonsense beside a warning. Anything unreadable counts as none.
function counter(value: unknown): number {
  const count = finite(value);
  return count === null ? 0 : Math.max(0, Math.floor(count));
}

// An explicit offset is required. `Date.parse` reads a date-time with none as local time, so the
// same cache read on two machines would place a reset hours apart and every countdown derived from
// it would be silently wrong by the host's offset. claude-swap writes the offset, so demanding it
// costs nothing and refuses only shapes this reader cannot place on a timeline.
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function instant(value: unknown): number | null {
  const iso = text(value);
  if (iso === null || !OFFSET.test(iso.trim())) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

/** A window is its percentage; a window without a readable one is no window at all. */
function usageWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null;
  const pct = finite(value["pct"]);
  return pct === null ? null : { pct, resetsAt: instant(value["resets_at"]) };
}

function usageSpend(value: unknown): UsageSpend | null {
  if (!isRecord(value)) return null;
  const pct = finite(value["pct"]);
  if (pct === null) return null;
  return {
    pct,
    used: finite(value["used"]),
    limit: finite(value["limit"]),
    currency: text(value["currency"]),
  };
}

/**
 * The per-model rows, bounded in count, each needing both a name and a readable percentage.
 *
 * The cap applies to the rows that survive the check, not to the raw entries: capping first would
 * let a run of unusable entries spend the whole allowance and drop readable rows behind them.
 */
function scopedWindows(value: unknown): ScopedWindow[] {
  if (!Array.isArray(value)) return [];
  const rows: ScopedWindow[] = [];
  for (const entry of value) {
    if (rows.length >= MAX_SCOPED_WINDOWS) break;
    if (!isRecord(entry)) continue;
    const name = text(entry["name"]);
    const held = usageWindow(entry);
    if (name === null || held === null) continue;
    rows.push({ ...held, name });
  }
  return rows;
}

/**
 * The accounts to read, ascending and bounded, each with the key it was found under: the cap counts
 * accounts this reader can actually render, so an unusable entry never spends a slot a later
 * readable one needed.
 *
 * A key is kept only when it survives the round trip through a number, which is the same key the
 * identity file is looked up under. `"01"`, `"007"`, and a key past the precision of a double all
 * read back as some other account's key or as no key at all, so each of them would render one
 * account twice or read a neighbour's numbers under the wrong label.
 *
 * Ascending numeric order is how both files key their accounts and how the operator's console lists
 * them; `sequence.json`'s `sequence` array is claude-swap's rotation order, a different fact, and it
 * is not read here.
 */
function accountEntries(accounts: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const keys = Object.keys(accounts)
    .filter((key) => /^\d+$/.test(key) && String(Number(key)) === key)
    .sort((left, right) => Number(left) - Number(right));
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const key of keys) {
    if (entries.length >= MAX_USAGE_ACCOUNTS) break;
    const entry = accounts[key];
    if (isRecord(entry)) entries.push([key, entry]);
  }
  return entries;
}

/**
 * One read of at most `maxBytes`, into a buffer one byte larger so an oversized file is recognized
 * by the read itself rather than by a separate stat the file could have outgrown in between. A
 * failure at any stage reports "unreadable", which covers an absent file, a permission refusal, and
 * a read that failed after the open succeeded. The distinction changes nothing the caller does, and
 * the errors themselves are discarded unread because each carries the path, which holds the
 * operator's own username.
 *
 * The close carries its own guard rather than riding a bare `finally`: a close that throws there
 * replaces whatever the read produced, so a healthy read would surface as a failure and a failed one
 * would surface with the wrong reason.
 */
function readCapped(file: string, maxBytes: number): CappedRead {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return { failed: "unreadable" };
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    if (read > maxBytes) return { failed: "oversized" };
    return { text: buffer.subarray(0, read).toString("utf8") };
  } catch {
    return { failed: "unreadable" };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A handle that will not close is the operating system's problem, not the card's: the reading
      // in hand is still good and there is nothing here left to do about the descriptor.
    }
  }
}

/**
 * The parsed contents of one capped read, or the reason there are none. The parse error is
 * discarded unread: V8 embeds an excerpt of the source in its message, so the one thing that must
 * not escape this function is the very thing the error carries.
 */
function parsed(read: CappedRead): { value: unknown } | { failed: UsageUnavailableReason } {
  if ("failed" in read) return { failed: read.failed };
  try {
    return { value: JSON.parse(read.text) };
  } catch {
    return { failed: "malformed" };
  }
}

/**
 * The current reading of claude-swap's cache.
 *
 * The two files fail independently, and they are not equally load-bearing. `usage.json` is the
 * numbers, so anything wrong with it is an unavailable reading. `sequence.json` is display identity
 * alone, so a missing or malformed one leaves every account's label and active marker empty and the
 * numbers standing: a card that says "account 2, 46% of the five-hour window" is worth far more
 * than no card. The cache's own `email` field is not the fallback, because it is not on this
 * reader's allowlist for that file.
 *
 * It does not throw, and that is structural rather than audited: the whole body runs inside one
 * guard, so the guarantee holds for the calls whose failure modes are not this module's to enumerate
 * (`os.homedir()` on a profile-less account, a descriptor that will not close, an injected reader)
 * as well as for the ones it parses by hand. A caller on a refresh timer treats a throw as a crashed
 * timer, so the one thing this reader must never do is raise.
 */
export function readUsage(options: ReadUsageOptions = {}): UsageReading {
  try {
    return reading(options);
  } catch {
    return { available: false, reason: "unreadable" };
  }
}

function reading(options: ReadUsageOptions): UsageReading {
  const root = options.root ?? defaultUsageRoot();
  const read = options.readFile ?? readCapped;

  const usage = parsed(read(path.join(root, "cache", "usage.json"), MAX_USAGE_FILE_BYTES));
  if ("failed" in usage) return { available: false, reason: usage.failed };
  if (!isRecord(usage.value) || !isRecord(usage.value["accounts"])) {
    return { available: false, reason: "malformed" };
  }
  const cached = usage.value["accounts"];

  const identity = parsed(read(path.join(root, "sequence.json"), MAX_USAGE_FILE_BYTES));
  const sequence = "failed" in identity || !isRecord(identity.value) ? {} : identity.value;
  const identities = isRecord(sequence["accounts"]) ? sequence["accounts"] : {};
  const activeNumber = finite(sequence["activeAccountNumber"]);

  const accounts: UsageAccount[] = [];
  for (const [key, entry] of accountEntries(cached)) {
    const named = identities[key];
    const lastGood = isRecord(entry["lastGood"]) ? entry["lastGood"] : {};
    accounts.push({
      number: Number(key),
      email: isRecord(named) ? text(named["email"]) : null,
      organizationName: isRecord(named) ? text(named["organizationName"]) : null,
      active: activeNumber === Number(key),
      fiveHour: usageWindow(lastGood["five_hour"]),
      sevenDay: usageWindow(lastGood["seven_day"]),
      spend: usageSpend(lastGood["spend"]),
      scoped: scopedWindows(lastGood["scoped"]),
      fetchedAt: epochMs(entry["fetchedAt"]),
      consecutiveFailures: counter(entry["consecutiveFailures"]),
      // Presence, never content: claude-swap clears this field on a success, so its being set at
      // all is the whole of what the card needs and the error text itself stays in the file.
      failing: entry["lastError"] !== null && entry["lastError"] !== undefined,
      backoffUntil: epochMs(entry["backoffUntil"]),
    });
  }
  return { available: true, accounts };
}
