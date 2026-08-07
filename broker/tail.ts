// The transcript tailer: mid-turn narration for a thread whose session is deep in a long turn.
//
// The assistant text written between tool calls is carried by no hook payload, so the only place
// it exists is the transcript file Claude Code appends beside the session. This module polls that
// file for the sessions the registry holds live, reads what grew since the last pass, and hands
// each new assistant text block to the routing layer as one interim chunk. Everything it needs
// from the broker arrives as injected callbacks; what it owns is a map of session ID to tail
// position and nothing else about the world.
//
// The gate fails closed. The mirror routes only ever carry content a hook chose to post, so
// there an absent signal meant absent content; the tailer reads content itself, so here an
// absent signal would mean publish. A session's transcript is therefore read only after an
// explicit mirror-on verdict has been seen for it under the current process, and a -NoMirror
// session stays silent under every restart and revive ordering, because no ordering can conjure
// an allow that was never sent.
//
// Transcript content is untrusted text of the same class as a mirrored reply. It reaches Discord
// only through renderMirror, and it never appears in the broker log at any level: every log line
// here carries a static message, a session ID, a count, or a byte offset, and a caught error from
// a read or a parse is discarded unread, because a thrown error can quote the text that produced
// it (V8's JSON.parse message embeds an excerpt of its source, and a filesystem error carries the
// path).
//
// The transcript path itself is learned from hook posts, held only in this module's in-memory
// map, and never persisted or published: it is stored, never trusted as content, and used only as
// an argument to a read. After a broker restart the next hook post from a live session re-teaches
// it, which costs at most one poll interval of narration.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { ReplyResult } from "./routing/outbound.ts";
import { withoutInvisible } from "./sanitize.ts";

/**
 * Ceiling on what one pass reads from one session's transcript. Past it the offset jumps to the
 * file's current end and the skip is logged by count, never by content: a session that outran the
 * tailer is better served by current narration than by a backlog read out minutes late.
 */
export const MAX_TAIL_READ_BYTES = 256 * 1024;

/**
 * The per-session echo memory the tailer and the Stop mirror consult from both sides.
 *
 * A turn's final reply arrives twice: the /mirror Stop hook posts it within milliseconds of turn
 * end, and the tailer reads the same text off the transcript up to a poll interval later.
 * Whichever side handles the text records a digest of it here, and the other side skips a match.
 * Digests rather than the strings themselves, so no conversation text is held in broker memory
 * past the moment it is posted.
 *
 * A match consumes the digest it matched. The race produces exactly one duplicate, so the memory
 * answers for exactly one: left standing, the digest would be an indefinite blocklist, and a turn
 * ending "Done." would silence every later turn's own "Done." forever.
 *
 * Comparison is on the normalized pre-render text, `withoutInvisible(text).trim()`, before any
 * escaping, exactly as the channel-envelope check in routing/outbound.ts compares: escaping must
 * be able to neither hide a match nor manufacture one.
 */
export type EchoMemory = {
  /** Records the last interim chunk posted for this session; the tailer's half. */
  noteInterim: (sessionId: string, text: string) => void;
  /** Records the last final reply the Stop mirror posted for this session; the mirror's half. */
  noteReply: (sessionId: string, text: string) => void;
  /** True when the text matches either remembered digest, consuming what it matched. */
  isEcho: (sessionId: string, text: string) => boolean;
  /** True when the text matches the last interim chunk, consuming it on a match. */
  isInterimEcho: (sessionId: string, text: string) => boolean;
  forget: (sessionId: string) => void;
  /** Drops every session outside the live set, so the map holds the sessions still running. */
  sweep: (live: ReadonlySet<string>) => void;
};

export function createEchoMemory(): EchoMemory {
  const state = new Map<string, { interim: string | null; reply: string | null }>();

  function digest(text: string): string {
    return createHash("sha256").update(withoutInvisible(text).trim(), "utf8").digest("hex");
  }

  function entry(sessionId: string): { interim: string | null; reply: string | null } {
    let held = state.get(sessionId);
    if (held === undefined) {
      held = { interim: null, reply: null };
      state.set(sessionId, held);
    }
    return held;
  }

  return {
    noteInterim(sessionId, text) {
      entry(sessionId).interim = digest(text);
    },
    noteReply(sessionId, text) {
      entry(sessionId).reply = digest(text);
    },
    isEcho(sessionId, text) {
      const held = state.get(sessionId);
      if (held === undefined) return false;
      const mark = digest(text);
      let matched = false;
      if (held.interim !== null && mark === held.interim) {
        held.interim = null;
        matched = true;
      }
      if (held.reply !== null && mark === held.reply) {
        held.reply = null;
        matched = true;
      }
      return matched;
    },
    isInterimEcho(sessionId, text) {
      const held = state.get(sessionId);
      if (held === undefined || held.interim === null || digest(text) !== held.interim) return false;
      held.interim = null;
      return true;
    },
    forget(sessionId) {
      state.delete(sessionId);
    },
    sweep(live) {
      for (const sessionId of state.keys()) {
        if (!live.has(sessionId)) state.delete(sessionId);
      }
    },
  };
}

/** The file's current size, and at most `maxBytes` of it starting at `offset`. */
export type TranscriptSlice = { size: number; bytes: Buffer };

export type TranscriptTailerOptions = {
  /** The session IDs the registry currently holds live. Only these are ever read. */
  liveSessions: () => string[];
  /**
   * Posts one interim chunk to the session's own thread; the outbound router's `interim`. The
   * status is read so a chunk that did not land is not remembered as posted; nothing else about
   * the result is consulted, because nothing here queues or retries. The router's own result
   * type, imported type-only so the two modules share one status vocabulary without a runtime
   * cycle: a typo'd status string here would otherwise compile and silently never match.
   */
  deliver: (sessionId: string, text: string) => Promise<ReplyResult>;
  echo: EchoMemory;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
  /** The one read this module performs. Injected so a test can count reads or fail them. */
  readFile?: (path: string, offset: number, maxBytes: number) => Promise<TranscriptSlice>;
};

export type TranscriptTailer = {
  /** Teaches the tailer where a session's transcript lives, from a credited hook post. */
  learn: (sessionId: string, path: string) => void;
  /** Permits a session's transcript to be read, on the session's mirror-on verdict. */
  allow: (sessionId: string) => void;
  /** Stops a session's transcript being read at all, on the session's own mirror-off switch. */
  suppress: (sessionId: string) => void;
  /**
   * One pass over every live, allowed session with a learned path. A call while a pass is
   * running answers with that same pass, so shutdown awaits the read actually in flight. Never
   * rejects in normal operation, but the caller still catches: a rejection reaching the timer
   * would end the daemon.
   */
  poll: () => Promise<void>;
  /** Drops the session's tail position and its echo digests. */
  forget: (sessionId: string) => void;
};

/** How long a run of the same log reason is aggregated before its next flush. */
const REPEAT_WINDOW_MS = 60_000;

/**
 * How many log reasons are held before the closed ones are swept. A reason carries a session ID,
 * so without the sweep the map would grow by one entry per session this tailer ever logged about.
 */
const MAX_REPEAT_KEYS = 64;

/**
 * Rate-limits a repeating log line by its reason, which carries the session and the cause and
 * nothing that varies per repeat; the varying detail (a byte count, an offset) rides beside it.
 *
 * An unreadable transcript is not a one-off: a session whose file cannot be opened logs on every
 * poll for as long as that lasts, and one line each would push earlier evidence out through
 * rotation. The first of a reason is written at once; a repeat inside the window is counted and
 * the count rides on the next line that window admits. Local rather than shared with the intake's
 * refusal limiter or the router's drop limiter, because each layer holds a different log seam.
 */
function createRepeatLog(
  log: (message: string) => void,
  now: () => number,
): (reason: string, detail: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (reason, detail) => {
    const at = now();
    const held = state.get(reason);
    if (held !== undefined && at - held.windowStart < REPEAT_WINDOW_MS) {
      held.suppressed += 1;
      return;
    }
    if (held !== undefined && held.suppressed > 0) {
      log(`tail: ${reason} occurred ${held.suppressed} more time(s) in the last ${REPEAT_WINDOW_MS}ms`);
    }
    log(`tail: ${reason} (${detail})`);
    state.set(reason, { windowStart: at, suppressed: 0 });
    if (state.size <= MAX_REPEAT_KEYS) return;
    for (const [key, kept] of state) {
      // Only a closed window with nothing counted against it: an entry still owing a repeat count
      // is what the next line of its reason reports, and dropping it would lose that count.
      if (kept.suppressed === 0 && at - kept.windowStart >= REPEAT_WINDOW_MS) state.delete(key);
    }
  };
}

/**
 * The text blocks one transcript line contributes, decided by an allowlist and never a denylist.
 *
 * A line yields text only when all of these hold: its `type` is `assistant`, it is not a
 * sidechain, its `sessionId` names the session this transcript was learned for, its
 * `message.content` is an array, and a block in that array is a `text` block carrying a non-empty
 * string. Everything else yields nothing: thinking blocks, tool calls, tool results, attachments,
 * system lines, user lines, and every line type this build has never seen. The transcript is
 * another program's file format that can grow new line types without notice, so the safe default
 * for the unrecognized is silence, never publication.
 *
 * The `sessionId` match is what carries the weight, because it is the one field verifiable
 * against live data; `isSidechain` is defense against a build that starts interleaving subagent
 * traffic into the main session's file.
 *
 * A parse failure yields nothing and the error is discarded unread: the file is written by
 * another process, so a half-flushed line is not an error, and the parse error's message embeds
 * an excerpt of the line's own text, which must never reach a log.
 */
function assistantTexts(line: string, sessionId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return [];
  if (record["isSidechain"] === true) return [];
  if (record["sessionId"] !== sessionId) return [];
  const message = record["message"];
  if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    const fields = block as Record<string, unknown>;
    if (fields["type"] !== "text") continue;
    const text = fields["text"];
    if (typeof text === "string" && text !== "") texts.push(text);
  }
  return texts;
}

/**
 * The real read: one open per session per pass, closed whatever happens. The size comes back
 * beside the bytes so the caller can decide what the bytes mean (a shrink, an overrun) from the
 * same observation it read them under, rather than from a second stat the file may have outgrown.
 */
async function readSlice(path: string, offset: number, maxBytes: number): Promise<TranscriptSlice> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.max(Math.min(size - offset, maxBytes), 0);
    if (length === 0) return { size, bytes: Buffer.alloc(0) };
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    return { size, bytes: bytes.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

type TailEntry = {
  /** Learned from hook posts. Null for a session only ever seen through a mirror verdict. */
  path: string | null;
  /**
   * Where the next read starts, in bytes. Null until the first pass over a learned path, which
   * takes the file's current end without consuming anything: what a transcript held before this
   * tailer learned it is conversation already had, and reading it out would republish it whole
   * into the operator's thread.
   */
  offset: number | null;
  /**
   * The session's mirror verdict, and the gate every read is behind. False until an explicit
   * mirror-on signal arrives for this session under the current process, because the tailer
   * reads content itself and so an absent signal has to mean absent narration: any ordering
   * that loses the -NoMirror signal (a broker restart mid-turn, a session going stale and
   * reviving) must land on silence, never on publishing an opted-out session's prose. The
   * verdict rides every /mirror post a live session makes, so a normal session is re-allowed at
   * the top of every turn and dropping this with the entry costs at most one turn's opening
   * moments of narration.
   */
  allowed: boolean;
};

export function createTranscriptTailer(options: TranscriptTailerOptions): TranscriptTailer {
  const log = options.log ?? ((): void => {});
  const repeats = createRepeatLog(log, options.now ?? Date.now);
  const read = options.readFile ?? readSlice;
  const sessions = new Map<string, TailEntry>();
  // One pass at a time: a pass can outlast the poll interval when Discord is slow, and a second
  // pass over the same offsets would read and post the same chunks twice. The pass itself is
  // held, not a flag, because the promise a busy poll answers with is what shutdown awaits.
  let running: Promise<void> | null = null;

  function entry(sessionId: string): TailEntry {
    let held = sessions.get(sessionId);
    if (held === undefined) {
      held = { path: null, offset: null, allowed: false };
      sessions.set(sessionId, held);
    }
    return held;
  }

  function learn(sessionId: string, path: string): void {
    const held = entry(sessionId);
    // Every credited hook post re-teaches the same path, and the held offset must survive that:
    // resetting it here would skip to the file's end on every PostToolUse and drop the narration
    // in between. Only a path this tailer has never read starts over, with the offset unset so
    // the first pass takes the new file's end rather than a position from a file it no longer
    // describes.
    if (held.path === path) return;
    held.path = path;
    held.offset = null;
  }

  function allow(sessionId: string): void {
    entry(sessionId).allowed = true;
  }

  function suppress(sessionId: string): void {
    entry(sessionId).allowed = false;
  }

  function forget(sessionId: string): void {
    sessions.delete(sessionId);
    options.echo.forget(sessionId);
  }

  async function pollOne(sessionId: string, held: TailEntry, path: string): Promise<void> {
    if (held.offset === null) {
      const probe = await read(path, 0, 0);
      held.offset = probe.size;
      return;
    }

    const slice = await read(path, held.offset, MAX_TAIL_READ_BYTES);
    if (slice.size < held.offset) {
      // A session ID maps to one transcript file that only grows, so a shrink means something
      // this tailer does not model: the file was replaced or truncated. Resuming from zero would
      // republish the whole conversation into the operator's thread, so the offset moves to the
      // file's current end instead and narration picks up from there.
      held.offset = slice.size;
      repeats(
        `session ${sessionId}'s transcript shrank below the held offset`,
        `resuming from its current end at ${slice.size} bytes`,
      );
      return;
    }
    if (slice.size - held.offset > MAX_TAIL_READ_BYTES) {
      const skipped = slice.size - held.offset;
      held.offset = slice.size;
      repeats(
        `session ${sessionId}'s transcript outgrew one pass`,
        `${skipped} bytes skipped to its current end`,
      );
      return;
    }

    // Only whole lines are consumed. The classic tailer bug is reading a line the writer is
    // midway through flushing, which fails silently as a dropped or mangled chunk: the trailing
    // partial line stays unconsumed, the offset stops before it, and the next pass reads it
    // whole. The cut is on bytes rather than characters for the same reason, so a multi-byte
    // character split at the read boundary lands in the unconsumed tail instead of being decoded
    // in half.
    const lastNewline = slice.bytes.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const consumed = slice.bytes.subarray(0, lastNewline + 1).toString("utf8");
    held.offset += lastNewline + 1;

    for (const line of consumed.split("\n")) {
      if (line === "") continue;
      for (const text of assistantTexts(line, sessionId)) {
        // The Stop mirror may already have posted this exact text as the turn's final reply, and
        // an earlier pass may have posted it as the last interim chunk. Either match is an echo,
        // skipped rather than shown to the operator twice.
        if (options.echo.isEcho(sessionId, text)) continue;
        // One await per chunk, so a session's chunks post in transcript order. A chunk that
        // could not be posted is dropped and never retried, the rule the whole routing layer
        // follows, and its digest is not recorded: the Stop mirror carrying the same text must
        // still post it, because nothing else will. The catch holds each failure to its own
        // chunk: the consumed bytes are already behind the offset, so a throw that escaped this
        // loop would lose every later chunk in the batch with no way to re-read them. The error
        // is discarded unread; it can quote the text it failed to post.
        try {
          const outcome = await options.deliver(sessionId, text);
          if (outcome.status === "sent") options.echo.noteInterim(sessionId, text);
        } catch {
          repeats(
            `session ${sessionId}'s interim delivery failed`,
            "the chunk is dropped; the error detail is withheld, it can carry content",
          );
        }
      }
    }
  }

  function poll(): Promise<void> {
    // A call while a pass is running answers with that pass rather than starting a second one: a
    // second pass over the same offsets would post the same chunks twice, and the promise handed
    // back is what shutdown awaits, so it has to be the pass actually holding file handles.
    if (running !== null) return running;
    running = pass().finally(() => {
      running = null;
    });
    return running;
  }

  async function pass(): Promise<void> {
    const live = new Set(options.liveSessions());
    // A session that left the live set stops being read the same pass, and its tail position
    // and echo digests go with it: both maps must hold the sessions still running, never every
    // session this broker has ever watched.
    for (const sessionId of [...sessions.keys()]) {
      if (!live.has(sessionId)) forget(sessionId);
    }
    options.echo.sweep(live);

    // Sessions run concurrently: they are independent surfaces, and serialized, one session
    // mid-way through a long split reply would hold every other session's narration behind it.
    // Only a session's own chunks are ordered, by the per-chunk await inside pollOne, the same
    // per-thread rather than global rule the routing layer keeps its ordering chains by.
    await Promise.all(
      [...live].map(async (sessionId) => {
        const held = sessions.get(sessionId);
        if (held === undefined || !held.allowed || held.path === null) return;
        try {
          await pollOne(sessionId, held, held.path);
        } catch {
          // Discarded unread: a filesystem error quotes the path, and nothing content-adjacent
          // belongs in the log. An unreadable transcript is also not a fault to escalate; the
          // file belongs to another process, and the next pass simply tries again.
          repeats(
            `session ${sessionId}'s transcript pass failed`,
            "the error detail is withheld; it can carry content",
          );
        }
      }),
    );
  }

  return { learn, allow, suppress, poll, forget };
}
