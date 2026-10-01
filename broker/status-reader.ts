// The status reader: a narrow read of every learned transcript for the few harness lines that
// change what a session's thread should show, mirror-on or mirror-off.
//
// The transcript tailer reads content and therefore reads only sessions whose mirror verdict is on.
// This module reads every session whose transcript path the broker has learned, including every
// mirror-off session, and so it is held to a much narrower contract: it acts on four line shapes and
// nothing else, uses only their structured fields, and never reads, posts or logs a field that holds
// text a model, a person or an upstream service wrote. What it publishes is fixed wording composed by
// `renderHarnessNotice` from numbers and a lookup key, and the receipt and card state that follows
// from it. The mirror-off gate governs what is published, not what the broker may read to derive a
// status, and nothing this module publishes carries text from any transcript line.
//
// The four shapes:
//
// - A `system` line with subtype `api_error`: a harness rate limit or API error, opening or
//   continuing an error episode.
// - An `attachment` line recording a queued channel message injected mid-turn: a pickup credit.
// - A root `user` line whose `origin` names this relay's channel: a Discord message opening a turn
//   on an idle session, also a pickup credit.
// - While an episode is open, an `assistant` line, read for its type alone: the session is producing
//   output again, which closes the episode.
//
// A line that fails to parse, names another session, is a sidechain, or matches none of these is
// skipped, and a caught error is discarded unread, because a parse or read error can quote the line
// or the path. Every log line carries a static message, a session id or a byte count.
import { renderHarnessNotice, HARNESS_RESUMED } from "./discord/render.ts";
import type { HarnessErrorFields } from "./discord/render.ts";
import { createRepeatLog } from "./repeat-log.ts";
import type { RepeatLogSurface } from "./repeat-log.ts";
import {
  CHANNEL_RELAY_SERVER_NAMES,
  MAX_TAIL_READ_BYTES,
  lineInstant,
  readSlice,
  taughtStem,
} from "./tail.ts";
import type { TranscriptSlice } from "./tail.ts";

export type StatusReaderOptions = {
  /** The session ids the registry holds live; each pass reads these and drops every other entry. */
  liveSessions: () => string[];
  /**
   * Posts one fixed-wording line to the session's own thread. The result is not consulted, and a
   * rejection is caught and logged without its detail.
   */
  notice: (sessionId: string, text: string) => Promise<unknown>;
  /** Credits the session's pickup at the line's own instant; the broker's `pickupFor`. */
  notePickup: (sessionId: string, at: number) => void;
  /**
   * Told when an episode opens or moves to a new request, with the notice it posted, and with null
   * when it closes. The broker feeds the card line and the ⚠️ receipt swap from it.
   */
  episode: (sessionId: string, open: { text: string } | null) => void;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. */
  now?: () => number;
  /** The one read this module performs. Injected so a test can count reads or fail them. */
  readFile?: (path: string, offset: number, maxBytes: number) => Promise<TranscriptSlice>;
  /** The zone notice times are drawn in. Absent, the broker host's own local zone. */
  timeZone?: string;
};

export type StatusReader = {
  /**
   * Teaches the reader where a credited session's transcript lives. A path whose filename stem is
   * not the session id is refused whole, the tailer's own rule. The first learn of a path baselines
   * at the file's current end, so nothing already in the transcript is ever acted on.
   */
  learn: (sessionId: string, path: string) => void;
  /**
   * One pass over every live session with a learned path. A call while a pass is running answers
   * with that pass. Never rejects in normal operation.
   */
  poll: () => Promise<void>;
};

/**
 * The episode key of an `api_error` line that carried no request id. A line with no id while an
 * episode is open folds into that episode; with none open it opens one under this key.
 */
const NO_REQUEST_ID = Symbol("no request id");

type Entry = {
  path: string;
  /** Where the next read starts, in bytes; null until the baseline probe resolves. */
  offset: number | null;
  /** The baseline probe `learn` started, awaited by a pass that lands before it resolves. */
  probe: Promise<void> | null;
  /** The open episode's request id, or null while no episode is open. */
  episode: string | typeof NO_REQUEST_ID | null;
};

const REPEAT_WINDOW_MS = 60_000;

/**
 * How many log keys are held before the closed ones are swept. A key carries a session id, so the
 * sweep is what keeps the map bounded by the sessions logging right now.
 */
const MAX_REPEAT_KEYS = 64;

const STATUS_REPEAT_LOG: RepeatLogSurface<[detail: string]> = {
  windowMs: REPEAT_WINDOW_MS,
  maxKeys: MAX_REPEAT_KEYS,
  firstLine: (reason, detail) => `status: ${reason} (${detail})`,
  countLine: (reason, suppressed) =>
    `status: ${reason} occurred ${suppressed} more time(s) in the last ${REPEAT_WINDOW_MS}ms`,
};

/** A plain object, the only shape any field this reader descends into may take. */
function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, and null for anything else. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The structured fields of an `api_error` line and its request id, validated. The error's own
 * message, its formatted text and every field not named here are never read.
 */
function harnessError(record: Record<string, unknown>): {
  fields: HarnessErrorFields;
  requestId: string | null;
} {
  const error = objectOf(record["error"]);
  const rawStatus = error === null ? null : finite(error["status"]);
  const status =
    rawStatus !== null && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  // An equality key only: compared against the open episode's and never rendered or logged.
  const rawId = error === null ? undefined : error["requestId"];
  const requestId = typeof rawId === "string" && rawId !== "" ? rawId : null;
  const limits = error === null ? null : objectOf(error["rateLimits"]);
  const limitType = limits === null ? undefined : limits["rateLimitType"];
  const resetsAtSeconds = limits === null ? null : finite(limits["resetsAt"]);
  const at = lineInstant(record);
  const retryInMs = finite(record["retryInMs"]);
  return {
    fields: {
      rateLimited: limits !== null,
      rateLimitType: typeof limitType === "string" ? limitType : null,
      status,
      retryAt: at !== null && retryInMs !== null && retryInMs >= 0 ? at + retryInMs : null,
      resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    },
    requestId,
  };
}

/** True when an `origin` object names this repo's own relay channel. */
function relayChannelOrigin(value: unknown): boolean {
  const origin = objectOf(value);
  if (origin === null || origin["kind"] !== "channel") return false;
  const server = origin["server"];
  return typeof server === "string" && CHANNEL_RELAY_SERVER_NAMES.includes(server);
}

/**
 * True when a `user` line's content is an array holding a `tool_result` block: tool output, which
 * can quote another session's channel message, never a delivery. A structural check on the blocks'
 * types; no text is read.
 */
function carriesToolResult(message: unknown): boolean {
  const content = objectOf(message)?.["content"];
  if (!Array.isArray(content)) return false;
  return content.some((block) => objectOf(block)?.["type"] === "tool_result");
}

/** What one line asks of the reader. */
type StatusItem =
  | { kind: "error"; fields: HarnessErrorFields; requestId: string | null }
  | { kind: "pickup"; at: number }
  | { kind: "output" };

/**
 * The cheap prefilter run before any parse. A line is parsed only when it contains `"api_error"`,
 * `"queued_command"` or `"channel"`, or, while an episode is open for the session, when it starts
 * with `{"type":"assistant"` or contains `"type":"assistant"`. Every shape this reader acts on
 * carries one of those substrings in its own serialized form, so the filter only ever skips lines
 * the parse below would also skip, and it keeps a busy transcript from costing a parse per line.
 */
function worthParsing(line: string, episodeOpen: boolean): boolean {
  if (line.includes('"api_error"') || line.includes('"queued_command"') || line.includes('"channel"')) {
    return true;
  }
  return episodeOpen && (line.startsWith('{"type":"assistant"') || line.includes('"type":"assistant"'));
}

/** The one thing a line asks of the reader, or null for a line it does not act on. */
function statusItem(line: string, sessionId: string, episodeOpen: boolean): StatusItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = objectOf(parsed);
  if (record === null) return null;
  if (record["isSidechain"] === true) return null;
  if (record["sessionId"] !== sessionId) return null;
  const type = record["type"];
  if (type === "system" && record["subtype"] === "api_error") {
    return { kind: "error", ...harnessError(record) };
  }
  if (type === "assistant") return episodeOpen ? { kind: "output" } : null;
  if (type === "attachment") {
    const attachment = objectOf(record["attachment"]);
    if (attachment === null || attachment["type"] !== "queued_command") return null;
    if (attachment["commandMode"] !== "prompt") return null;
    if (!relayChannelOrigin(attachment["origin"])) return null;
    const at = lineInstant(record);
    return at === null ? null : { kind: "pickup", at };
  }
  if (type === "user") {
    // `isMeta` is deliberately not consulted: every real channel turn-opener carries it as true.
    if (!relayChannelOrigin(record["origin"])) return null;
    if (carriesToolResult(record["message"])) return null;
    const at = lineInstant(record);
    return at === null ? null : { kind: "pickup", at };
  }
  return null;
}

export function createStatusReader(options: StatusReaderOptions): StatusReader {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(STATUS_REPEAT_LOG, log, now);
  const read = options.readFile ?? readSlice;
  const sessions = new Map<string, Entry>();
  // One pass at a time, the tailer's own hold: a second pass over the same offsets would act on the
  // same lines twice, and the promise a busy poll answers with is what shutdown awaits.
  let running: Promise<void> | null = null;

  function startProbe(sessionId: string, held: Entry): void {
    const stillValid = (): boolean =>
      sessions.get(sessionId) === held && held.offset === null && held.probe === pending;
    const pending: Promise<void> = Promise.resolve()
      .then(() => (stillValid() ? read(held.path, 0, 0) : null))
      .then((probe) => {
        if (probe !== null && stillValid()) held.offset = probe.size;
      })
      .catch(() => {
        // Discarded unread: a filesystem error quotes the path. The next pass probes again.
      })
      .finally(() => {
        if (held.probe === pending) held.probe = null;
      });
    held.probe = pending;
  }

  function learn(sessionId: string, path: string): void {
    if (taughtStem(path) !== sessionId) {
      repeats(
        `session ${sessionId} was taught a transcript path whose filename is not its own session id`,
        "the path is refused; the entry keeps its prior path",
      );
      return;
    }
    const held = sessions.get(sessionId);
    // Every credited hook post re-teaches the same path, and the held offset must survive that.
    if (held !== undefined && held.path === path) return;
    // A new path baselines fresh. An episode open on the old file stays open: it is the session's,
    // and the next line on the new file either continues or closes it.
    const entry: Entry = { path, offset: null, probe: null, episode: held?.episode ?? null };
    sessions.set(sessionId, entry);
    startProbe(sessionId, entry);
  }

  /** Closes a session's episode, posting `Resumed.` only when `announce` is set. */
  function closeEpisode(sessionId: string, held: Entry, announce: boolean): void {
    held.episode = null;
    try {
      options.episode(sessionId, null);
    } catch {
      repeats(`session ${sessionId}'s episode close could not be recorded`, "the error detail is withheld");
    }
    if (announce) post(sessionId, HARNESS_RESUMED);
  }

  function post(sessionId: string, text: string): void {
    // Not awaited: a slow Discord write must not hold the pass, and nothing here depends on it.
    void Promise.resolve()
      .then(() => options.notice(sessionId, text))
      .catch(() => {
        repeats(`session ${sessionId}'s harness notice could not be posted`, "the error detail is withheld");
      });
  }

  function act(sessionId: string, held: Entry, item: StatusItem): void {
    if (item.kind === "pickup") {
      try {
        options.notePickup(sessionId, item.at);
      } catch {
        repeats(`session ${sessionId}'s pickup could not be recorded`, "the error detail is withheld");
      }
      return;
    }
    if (item.kind === "output") {
      if (held.episode !== null) closeEpisode(sessionId, held, true);
      return;
    }
    // One notice per episode, never per retry. A line with no request id folds into whatever
    // episode is open; a line with an id opens a new episode only when it differs from the open one.
    const key = item.requestId ?? NO_REQUEST_ID;
    if (held.episode !== null && (item.requestId === null || held.episode === key)) return;
    held.episode = key;
    const text = renderHarnessNotice(item.fields, options.timeZone);
    try {
      options.episode(sessionId, { text });
    } catch {
      repeats(`session ${sessionId}'s episode could not be recorded`, "the error detail is withheld");
    }
    post(sessionId, text);
  }

  async function pollOne(sessionId: string, held: Entry): Promise<void> {
    if (held.probe !== null) await held.probe;
    if (sessions.get(sessionId) !== held) return;
    if (held.offset === null) {
      const probe = await read(held.path, 0, 0);
      if (sessions.get(sessionId) !== held) return;
      if (held.offset === null) held.offset = probe.size;
      return;
    }
    const slice = await read(held.path, held.offset, MAX_TAIL_READ_BYTES);
    if (sessions.get(sessionId) !== held) return;
    if (slice.size < held.offset) {
      // A replaced or truncated file: resume from its current end rather than re-reading it.
      held.offset = slice.size;
      repeats(`session ${sessionId}'s transcript shrank below the held offset`, `resuming at ${slice.size} bytes`);
      return;
    }
    if (slice.size - held.offset > MAX_TAIL_READ_BYTES) {
      const skipped = slice.size - held.offset;
      held.offset = slice.size;
      repeats(`session ${sessionId}'s transcript outgrew one status pass`, `${skipped} bytes skipped to its end`);
      return;
    }
    // Only whole lines are consumed: a trailing partial line stays behind the offset and is read
    // whole by the next pass.
    const lastNewline = slice.bytes.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const consumed = slice.bytes.subarray(0, lastNewline + 1).toString("utf8");
    held.offset += lastNewline + 1;
    for (const raw of consumed.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") continue;
      const episodeOpen = held.episode !== null;
      if (!worthParsing(line, episodeOpen)) continue;
      const item = statusItem(line, sessionId, episodeOpen);
      if (item !== null) act(sessionId, held, item);
    }
  }

  async function pass(): Promise<void> {
    const live = new Set(options.liveSessions());
    for (const [sessionId, held] of [...sessions]) {
      if (live.has(sessionId)) continue;
      sessions.delete(sessionId);
      // Closed without a post: the session is gone, so there is nothing to say resumed, but the card
      // line and the ⚠️ reactions must not outlive it.
      if (held.episode !== null) closeEpisode(sessionId, held, false);
    }
    await Promise.all(
      [...live].map(async (sessionId) => {
        const held = sessions.get(sessionId);
        if (held === undefined) return;
        try {
          await pollOne(sessionId, held);
        } catch {
          // Discarded unread: a filesystem error quotes the path.
          repeats(`session ${sessionId}'s status pass failed`, "the error detail is withheld; it can carry content");
        }
      }),
    );
  }

  function poll(): Promise<void> {
    if (running !== null) return running;
    running = pass()
      .catch(() => {
        repeats("a status pass failed", "the error detail is withheld; it can carry content");
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return { learn, poll };
}
