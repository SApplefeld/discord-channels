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
//   on an idle session, also a pickup credit, and a new turn that closes an open episode unannounced.
// - While an episode is open, an `assistant` line, read for its type and its `isApiErrorMessage`
//   flag alone: unflagged, the session is producing output again, which closes the episode.
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
  /**
   * The session ids the registry has not ended, stale ones included; each pass reads these and
   * drops every other entry. A session waiting out a long retry fires no hooks and goes stale, and
   * its episode has to outlive that so its recovery is still read and announced.
   */
  currentSessions: () => string[];
  /**
   * Posts one fixed-wording line to the session's own thread. A session's posts run one at a time
   * in the order they were made, each starting once the one before it settles. The result is not
   * consulted, and a rejection is caught and logged without its detail.
   */
  notice: (sessionId: string, text: string) => Promise<unknown>;
  /** Credits the session's pickup at the line's own instant; the broker's `pickupFor`. */
  notePickup: (sessionId: string, at: number) => void;
  /**
   * Told when an episode opens, with the notice it posts; again while it stays open, whenever a later
   * error line renders different text, such as a later retry time; and with null when it closes. The
   * broker feeds the card line and the ⚠️ receipt swap from it. Only the opening call posts.
   */
  episode: (sessionId: string, open: { text: string } | null) => void;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter, and caps a pickup instant so a future stamp credits nothing early. */
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
   * The session submitted a prompt at `at`: a new turn, or a queued message injected mid-turn, which
   * lands only at a tool boundary, after output has closed any episode. An episode still open is the
   * last turn's, which can end with no output line when it is interrupted or abandoned, so it closes
   * without a "Resumed." post.
   * `at` also becomes the session's floor: an error line stamped before it belongs to an earlier turn
   * and is ignored, since a pass after this call can still read the old turn's last lines.
   */
  turnOpened: (sessionId: string, at: number) => void;
  /**
   * One pass over every current session with a learned path. A call while a pass is running answers
   * with that pass. Never rejects in normal operation.
   */
  poll: () => Promise<void>;
  /**
   * Settles once every notice already handed to a session's post chain has settled. Shutdown awaits
   * it after the pass, so a notice in flight is not cut off by the teardown that follows.
   */
  drain: () => Promise<void>;
};

type Entry = {
  path: string;
  /** Where the next read starts, in bytes; null until the baseline probe resolves. */
  offset: number | null;
  /** The baseline probe `learn` started, awaited by a pass that lands before it resolves. */
  probe: Promise<void> | null;
  /**
   * The notice text the open error episode last reported, and null while none is open. Not keyed on
   * the request id: each retry attempt is a new request with a new id, and the lines under one id
   * are countdown rewrites of a single attempt, so one episode spans every id the harness tries
   * until output resumes.
   */
  episode: string | null;
  /**
   * The instant the session's latest turn opened, and null before any. An error line stamped before
   * it belongs to an earlier turn and is ignored.
   */
  floor: number | null;
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
 * The structured fields of an `api_error` line, validated. The error's own message, its formatted
 * text, its request id and every field not named here are never read.
 */
function harnessError(record: Record<string, unknown>): HarnessErrorFields {
  const error = objectOf(record["error"]);
  const rawStatus = error === null ? null : finite(error["status"]);
  const status =
    rawStatus !== null && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  const limits = error === null ? null : objectOf(error["rateLimits"]);
  const limitType = limits === null ? undefined : limits["rateLimitType"];
  const resetsAtSeconds = limits === null ? null : finite(limits["resetsAt"]);
  const at = lineInstant(record);
  const retryInMs = finite(record["retryInMs"]);
  return {
    rateLimited: limits !== null,
    rateLimitType: typeof limitType === "string" ? limitType : null,
    status,
    retryAt: at !== null && retryInMs !== null && retryInMs >= 0 ? at + retryInMs : null,
    resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
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
  | { kind: "error"; fields: HarnessErrorFields; at: number | null }
  | { kind: "pickup"; at: number; opensTurn: boolean }
  | { kind: "output" };

/**
 * The cheap prefilter run before any parse. A line is parsed only when it contains `"api_error"`,
 * `"queued_command"` or `"kind":"channel"`, or, while an episode is open for the session, when it
 * starts with `{"type":"assistant"` or contains `"type":"assistant"`. Every shape this reader acts
 * on carries one of those substrings in its own serialized form, because the harness writes a
 * channel origin compactly as `"origin":{"kind":"channel",...}`. So the filter only ever skips
 * lines the parse below would also skip. What it buys: outside an episode only error lines, queued
 * commands and channel-origin lines are parsed, so a line whose text merely says `channel` and
 * every assistant line pass without a parse.
 */
function worthParsing(line: string, episodeOpen: boolean): boolean {
  if (line.includes('"api_error"') || line.includes('"queued_command"') || line.includes('"kind":"channel"')) {
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
    return { kind: "error", fields: harnessError(record), at: lineInstant(record) };
  }
  if (type === "assistant") {
    // A failed request's terminal record is an assistant line flagged `isApiErrorMessage`. It is the
    // error's last word, not output, so it closes nothing.
    if (record["isApiErrorMessage"] === true) return null;
    return episodeOpen ? { kind: "output" } : null;
  }
  if (type === "attachment") {
    const attachment = objectOf(record["attachment"]);
    if (attachment === null || attachment["type"] !== "queued_command") return null;
    if (attachment["commandMode"] !== "prompt") return null;
    if (!relayChannelOrigin(attachment["origin"])) return null;
    const at = lineInstant(record);
    // Injected into a running turn, so it opens none.
    return at === null ? null : { kind: "pickup", at, opensTurn: false };
  }
  if (type === "user") {
    // `isMeta` is deliberately not consulted: every real channel turn-opener carries it as true.
    if (!relayChannelOrigin(record["origin"])) return null;
    if (carriesToolResult(record["message"])) return null;
    const at = lineInstant(record);
    return at === null ? null : { kind: "pickup", at, opensTurn: true };
  }
  return null;
}

export function createStatusReader(options: StatusReaderOptions): StatusReader {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(STATUS_REPEAT_LOG, log, now);
  const read = options.readFile ?? readSlice;
  const sessions = new Map<string, Entry>();
  // Each session's post chain, holding only the posts still pending. A session's posts run one at a
  // time, so a notice and the "Resumed." that follows it in the same pass land in that order. Kept
  // apart from `sessions` so a session dropped mid-post still finishes its chain, and deleted once
  // nothing is chained behind the last post.
  const chains = new Map<string, Promise<void>>();
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
    // A new path baselines fresh. An episode open on the old file stays open, and the turn floor
    // stands: both are the session's, and the next line on the new file continues or closes it.
    const entry: Entry = {
      path,
      offset: null,
      probe: null,
      episode: held?.episode ?? null,
      floor: held?.floor ?? null,
    };
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

  function turnOpened(sessionId: string, at: number): void {
    const held = sessions.get(sessionId);
    // A session with no entry has no episode to close, and its first learn baselines at the file's
    // end, which already puts the old turn's lines behind it.
    if (held === undefined) return;
    held.floor = held.floor === null ? at : Math.max(held.floor, at);
    if (held.episode !== null) closeEpisode(sessionId, held, false);
  }

  function post(sessionId: string, text: string): void {
    // Not awaited by the pass, since a slow Discord write must not hold it. Chained behind the
    // session's previous post instead, with a rejection caught inside the link so the chain never
    // breaks.
    const prior = chains.get(sessionId) ?? Promise.resolve();
    const link = prior
      .then(() => options.notice(sessionId, text))
      .then(
        () => {},
        () => {
          repeats(`session ${sessionId}'s harness notice could not be posted`, "the error detail is withheld");
        },
      )
      .catch(() => {
        // Reached only by a throwing log; the chain stays resolved for the next post.
      });
    chains.set(sessionId, link);
    void link.then(() => {
      if (chains.get(sessionId) === link) chains.delete(sessionId);
    });
  }

  function act(sessionId: string, held: Entry, item: StatusItem): void {
    if (item.kind === "pickup") {
      // A line stamped ahead of this host's clock must not credit a message delivered after this
      // read, so the instant is capped at now. The same cap keeps a future stamp from raising the
      // turn floor past errors that have not happened yet.
      const at = Math.min(item.at, now());
      try {
        options.notePickup(sessionId, at);
      } catch {
        repeats(`session ${sessionId}'s pickup could not be recorded`, "the error detail is withheld");
      }
      // A channel message opening a turn on an idle session is a new turn, the same as a credited
      // prompt the broker hears about directly.
      if (item.opensTurn) turnOpened(sessionId, at);
      return;
    }
    if (item.kind === "output") {
      if (held.episode !== null) closeEpisode(sessionId, held, true);
      return;
    }
    // An error stamped before the latest turn opened is the old turn's, read late by this pass. A
    // line with no readable instant cannot be placed, so it is acted on.
    if (item.at !== null && held.floor !== null && item.at < held.floor) return;
    // Rendered before the episode is recorded, so a render that throws leaves no episode open
    // without its notice.
    const text = renderHarnessNotice(item.fields, options.timeZone);
    // One notice per episode, never per retry: while an episode is open every error line folds into
    // it, whatever its request id, and only output or a new turn closes it. A folded line still
    // moves the card line when it renders differently, so the retry time shown is the latest one.
    if (held.episode !== null) {
      if (text === held.episode) return;
      held.episode = text;
      try {
        options.episode(sessionId, { text });
      } catch {
        repeats(`session ${sessionId}'s episode could not be recorded`, "the error detail is withheld");
      }
      return;
    }
    held.episode = text;
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
    let slice = await read(held.path, held.offset, MAX_TAIL_READ_BYTES);
    if (sessions.get(sessionId) !== held) return;
    if (slice.size < held.offset) {
      // A replaced or truncated file: resume from its current end rather than re-reading it.
      held.offset = slice.size;
      repeats(`session ${sessionId}'s transcript shrank below the held offset`, `resuming at ${slice.size} bytes`);
      return;
    }
    // Where the bytes in `slice` start in the file, and whether the text before their first newline
    // is the tail of a line the read cut, to be dropped.
    let start = held.offset;
    let cut = false;
    if (slice.size - held.offset > MAX_TAIL_READ_BYTES) {
      // A backlog past one pass's bound is read from its newest bound's worth, and the rest is
      // skipped: the newest lines decide what the thread shows now, and an assistant line closing an
      // episode can sit anywhere in the window. The read starts one byte early, so a line starting
      // exactly at the cut keeps its preceding newline and is read whole.
      start = slice.size - MAX_TAIL_READ_BYTES - 1;
      cut = true;
      repeats(
        `session ${sessionId}'s transcript outgrew one status pass`,
        `${start + 1 - held.offset} bytes skipped, the newest ${MAX_TAIL_READ_BYTES} read`,
      );
      slice = await read(held.path, start, MAX_TAIL_READ_BYTES + 1);
      if (sessions.get(sessionId) !== held) return;
    }
    // Only whole lines are consumed: a trailing partial line stays behind the offset and is read
    // whole by the next pass. A cut window holding no complete line consumes nothing, and the next
    // pass reads the file's newest window again.
    const firstByte = cut ? slice.bytes.indexOf(0x0a) + 1 : 0;
    const lastNewline = slice.bytes.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const consumed = slice.bytes.subarray(firstByte, lastNewline + 1).toString("utf8");
    held.offset = start + lastNewline + 1;
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
    const current = new Set(options.currentSessions());
    for (const [sessionId, held] of [...sessions]) {
      if (current.has(sessionId)) continue;
      sessions.delete(sessionId);
      // Closed without a post: the session is gone, so there is nothing to say resumed, but the card
      // line and the ⚠️ reactions must not outlive it.
      if (held.episode !== null) closeEpisode(sessionId, held, false);
    }
    await Promise.all(
      [...current].map(async (sessionId) => {
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

  async function drain(): Promise<void> {
    await Promise.all([...chains.values()]);
  }

  return { learn, turnOpened, poll, drain };
}
