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
import { NEAR_MATCH_THRESHOLD, normalizeForSketch, similarity, sketchOf } from "./similarity.ts";
import type { Sketch } from "./similarity.ts";

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
 * The answer record is the third digest, for the other duplicate pair: on a long turn the model
 * often calls the reply tool with its closing summary and the turn's closing text arrives moments
 * later as the Stop mirror, or off the transcript by a tailer poll that lands first, carrying the
 * same words or a light rewording, so both of those paths consult what the reply tool just
 * posted. "Nearly the same" needs more than an exact digest, so the answer record carries a
 * bounded similarity sketch and a normalized length beside it: derived hashes and one number
 * under a hard size bound, never text, so the no-retained-content rule survives. The same
 * one-record, consumed-on-match discipline applies, and the record is bounded to its own turn:
 * the reply-kind mirror clears it whether or not it matched, because the reply tool always posts
 * before the Stop mirror, so a record standing past that boundary could only suppress a
 * coincidental near-match in some later turn.
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
  /** Records the last reply-tool answer posted for this session, replacing the previous one. */
  noteAnswer: (sessionId: string, text: string) => void;
  /** True when the text matches either remembered digest, consuming what it matched. */
  isEcho: (sessionId: string, text: string) => boolean;
  /** True when the text matches the last interim chunk, consuming it on a match. */
  isInterimEcho: (sessionId: string, text: string) => boolean;
  /** True when the text matches the last answer, exactly or nearly, consuming it on a match. */
  isAnswerEcho: (sessionId: string, text: string) => boolean;
  /** Drops the session's answer record unread; the reply-kind mirror's turn boundary. */
  clearAnswer: (sessionId: string) => void;
  forget: (sessionId: string) => void;
  /** Drops every session outside the live set, so the map holds the sessions still running. */
  sweep: (live: ReadonlySet<string>) => void;
};

/**
 * How much longer than the recorded answer a candidate may be and still count as its echo, as a
 * ratio of normalized text lengths. A true duplicate or a light rewording preserves length, while
 * a candidate that grew past this carries an addendum the answer never showed the operator; the
 * sketch alone would call "the answer plus one new closing sentence" a near-match, and the fail
 * direction here must be a duplicate message, never lost words.
 */
export const ANSWER_LENGTH_ALLOWANCE = 1.1;

export function createEchoMemory(): EchoMemory {
  type Entry = {
    interim: string | null;
    reply: string | null;
    /**
     * The digest answers an exact repeat; the sketch answers a light rewording of it; the
     * normalized length is what refuses a candidate that grew past the allowance above.
     */
    answer: { digest: string; sketch: Sketch; length: number } | null;
  };
  const state = new Map<string, Entry>();

  function digest(text: string): string {
    return createHash("sha256").update(withoutInvisible(text).trim(), "utf8").digest("hex");
  }

  function entry(sessionId: string): Entry {
    let held = state.get(sessionId);
    if (held === undefined) {
      held = { interim: null, reply: null, answer: null };
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
    noteAnswer(sessionId, text) {
      entry(sessionId).answer = {
        digest: digest(text),
        sketch: sketchOf(text),
        length: normalizeForSketch(text).length,
      };
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
    isAnswerEcho(sessionId, text) {
      const held = state.get(sessionId);
      if (held === undefined || held.answer === null) return false;
      // The length guard runs before any similarity: a candidate materially longer than the
      // answer carries words the answer did not, whatever the sketches say, and those words
      // must reach the operator.
      if (normalizeForSketch(text).length > held.answer.length * ANSWER_LENGTH_ALLOWANCE) {
        return false;
      }
      // The digest catches what the sketch cannot: a text short enough to sketch as a single
      // hash of itself compares exactly there, but two empty-adjacent texts sketch to nothing
      // and similarity refuses a pair of blanks by design, while their digests still agree.
      const matched =
        digest(text) === held.answer.digest ||
        similarity(sketchOf(text), held.answer.sketch) >= NEAR_MATCH_THRESHOLD;
      if (!matched) return false;
      held.answer = null;
      return true;
    },
    clearAnswer(sessionId) {
      const held = state.get(sessionId);
      if (held !== undefined) held.answer = null;
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
  /**
   * The session IDs the registry currently holds live; what `pass()` iterates on each poll. A
   * zero-byte baseline probe started from `allow` or `learn` is dispatched off the poll cycle, one
   * microtask after the call, and does not consult this set, so a session credited with an allow
   * or a learned path but not (yet, or any longer) in this list can still see one such read before
   * the next pass sweeps it out.
   */
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
  /**
   * Permits a session's transcript to be read, on the session's mirror-on verdict. When the
   * session already has a learned path and no held offset, this is also the moment the baseline
   * probe fires: a zero-byte read of the transcript's current size, taken now instead of left to
   * the next poll tick, so the file's size is captured before the model's first text can land
   * rather than after it already has. A session already baselined, or one whose path is not yet
   * known, starts no probe here; the latter starts one from `learn` instead, once the path
   * arrives, because a mirror-on verdict and its matching hook post carry no ordering guarantee
   * between them.
   */
  allow: (sessionId: string) => void;
  /**
   * Stops a session's transcript from being read further, on the session's own mirror-off switch.
   * No new read starts for a suppressed session, and a read already in flight when this lands
   * writes nothing back: it bumps the entry's epoch, and every write-back point re-checks its read
   * against the epoch it captured at dispatch. Also drops the held offset, so a later re-allow
   * rebaselines rather than resuming from before the suppressed window: the transcript keeps
   * growing while mirroring is off, and resuming from the old offset would publish everything
   * written during it.
   */
  suppress: (sessionId: string) => void;
  /**
   * One pass over every live, allowed session with a learned path, plus a drain of every baseline
   * probe started during that pass, including one an allow() or learn() started too late for its
   * own per-session closure to have awaited: the promise this hands back does not settle while
   * one of those still holds a file handle. A probe started between poll ticks, outside any pass,
   * is drained only by a pass that is running or subsequently starts. A call while a pass is
   * running answers with that same pass. Never rejects in normal operation, but the caller still
   * catches: a rejection reaching the timer would end the daemon.
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
   * Where the next read starts, in bytes. Null until baselined, which happens as soon as the
   * session is allowed and its path is known (whichever of `allow` or `learn` completes that
   * pair fires the probe below), or, failing that, at the first poll pass that still finds it
   * unbaselined. Either way the position taken is the file's size at that moment, consuming
   * nothing: what a transcript held before this tailer baselined it is conversation already had,
   * and reading it out would republish it whole into the operator's thread. `suppress` unsets it
   * again, so a later re-allow baselines fresh rather than resuming into a suppressed window.
   */
  offset: number | null;
  /**
   * The in-flight baseline probe `allow` or `learn` started, so a poll landing before it resolves
   * can wait for it instead of racing it with a second read. Null whenever nothing is outstanding:
   * no probe was ever needed, one already settled, `suppress` cleared it, or `forget` dropped this
   * entry out from under it. The probe's own resolution writes `offset` only if the map still
   * holds this exact entry under its session ID, the entry's epoch still equals the one captured
   * at dispatch, the session is still allowed, and it still names the path it was probed for with
   * no offset yet set. Every one of those is checked again at resolution, not just at dispatch,
   * because the read in between is a real open, stat, and close, milliseconds wide rather than a
   * microtask. The guard does not depend on how `allow` and `suppress` interleave, which is why it
   * holds regardless of the order they arrive in. Map identity, current path, and current
   * `allowed` are not sufficient by themselves: a `suppress` immediately followed by a same-tick
   * `allow`, with no macrotask boundary between them for the stale read to resolve in, restores
   * `allowed` to true and leaves `path` unchanged, so both would read as if nothing happened even
   * though a mirror-off window genuinely elapsed. The epoch is what that interleaving cannot fake:
   * `suppress`, and `learn` on a path change, bump it, and a probe dispatched before the bump
   * carries the old value forever. Map identity is what covers a re-created entry: `forget`
   * deletes the entry from the map, so a later `learn` for the same session ID installs a
   * different object at that key, whose fresh epoch could otherwise collide with a stale probe's
   * captured value.
   */
  probe: Promise<void> | null;
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
  /**
   * Bumped by `suppress`, by `forget`, and by `learn` on a path change, never by `allow`. Every
   * in-flight probe and every `pollOne` pass captures this value the moment it starts, and every
   * point where either would write back to the entry checks the capture against the live value
   * again. A mismatch means a suppression, or a relearn onto a different path, happened since that
   * read began, regardless of what `allowed` or `path` read as by the time the write-back is
   * attempted: `allowed` alone cannot carry this signal, because a re-allow arriving before a
   * stale read resolves restores it to true and leaves the rest of the entry looking untouched.
   */
  epoch: number;
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
  // Every baseline probe outstanding right now, across every session, independent of whether the
  // entry it targets still references it. A pass only awaits the probe of a session whose own
  // per-session closure read `allowed` as true when the closure ran; a probe that `allow` or
  // `learn` starts later in the same pass, after that closure already returned, is not covered by
  // that await. This set is what `poll` drains on top of the pass itself, so the promise it hands
  // back does not settle while any probe still holds an open file handle.
  const pendingProbes = new Set<Promise<void>>();

  function entry(sessionId: string): TailEntry {
    let held = sessions.get(sessionId);
    if (held === undefined) {
      held = { path: null, offset: null, probe: null, allowed: false, epoch: 0 };
      sessions.set(sessionId, held);
    }
    return held;
  }

  /**
   * Starts the zero-byte baseline probe for an entry that is allowed, has a learned path, and
   * holds neither an offset nor a probe already; a no-op otherwise. Called from both `allow` and
   * `learn`, because the mirror-on verdict and the hook-taught path arrive on independent routes
   * with no ordering guarantee between them, so whichever of the two completes the pair is the
   * one that must fire it.
   */
  function startProbe(sessionId: string, held: TailEntry): void {
    if (!held.allowed || held.path === null || held.offset !== null || held.probe !== null) return;
    const path = held.path;
    const epoch = held.epoch;
    // The entry must still be this one, in this map, at the same epoch it was dispatched under,
    // still allowed, still naming this path, and still unbaselined. Checked identically at
    // dispatch and at resolution: the read in between is a real open, stat, and close,
    // milliseconds wide rather than a microtask, and `allow` and `suppress` arrive on independent
    // HTTP requests, so a suppress landing inside that window must stop the probe from baselining
    // a session no longer allowed as surely as one landing before the read starts. The epoch
    // clause is what `allowed` alone cannot cover: a suppress immediately followed by a same-tick
    // re-allow restores `allowed` to true before this probe ever resolves, but it still bumped the
    // epoch, so the stale probe's capture no longer matches.
    const stillValid = (): boolean =>
      sessions.get(sessionId) === held &&
      held.epoch === epoch &&
      held.allowed &&
      held.path === path &&
      held.offset === null &&
      held.probe === pending;
    const pending: Promise<void> = Promise.resolve()
      .then(() => {
        // Deferred one tick so a suppress() issued right after the call that started this probe,
        // with no read in between, still finds the transcript never opened: this is the last
        // point the read itself can still be skipped.
        if (!stillValid()) return null;
        return read(path, 0, 0);
      })
      .then((probe) => {
        if (probe === null || !stillValid()) return;
        held.offset = probe.size;
      })
      .catch(() => {
        // Swallowed unread; the poll-time null-offset branch in pollOne is the fallback for a
        // probe that never resolved usefully, so nothing here needs the error's detail.
      })
      .finally(() => {
        if (held.probe === pending) held.probe = null;
        pendingProbes.delete(pending);
      });
    held.probe = pending;
    pendingProbes.add(pending);
  }

  function learn(sessionId: string, path: string): void {
    const held = entry(sessionId);
    // Every credited hook post re-teaches the same path, and the held offset must survive that:
    // resetting it here would skip to the file's end on every PostToolUse and drop the narration
    // in between. Only a path this tailer has never read starts over: the offset unsets, any
    // probe still pending for the path being left behind is dropped from the entry (its own
    // guards already refuse to write once the path no longer matches, but leaving it referenced
    // here would block a probe for the new path from starting at all), and a fresh probe starts
    // at once when the session is already allowed. That last part is what closes the ordering
    // where a mirror-on verdict reaches this session before the hook post that teaches it its
    // path: the two routes carry no guarantee about which arrives first.
    if (held.path === path) return;
    held.epoch += 1;
    held.path = path;
    held.offset = null;
    held.probe = null;
    startProbe(sessionId, held);
  }

  function allow(sessionId: string): void {
    const held = entry(sessionId);
    held.allowed = true;
    startProbe(sessionId, held);
  }

  function suppress(sessionId: string): void {
    const held = entry(sessionId);
    held.allowed = false;
    // The transcript keeps growing while mirroring is off, and the held offset is this tailer's
    // only memory of where the next read may resume: leaving it in place would let a later
    // re-allow resume from before the suppressed window and publish everything written during
    // it, exactly the content the mirror-off signal exists to hide. Dropping it here, so a
    // re-allow rebaselines from scratch, costs at most one poll interval of narration at the
    // moment mirroring resumes; that is the correct direction, silence over republishing an
    // opted-out stretch. The pending probe reference is dropped alongside it, freeing the field
    // for a fresh probe on the next allow; what actually stops the dropped probe (or a pollOne
    // pass already reading) from writing back is the epoch bump below, not this field clearing or
    // the `allowed` flag, because a same-tick re-allow with no macrotask boundary between it and
    // suppress restores `allowed` to true before a read in flight resolves. A read dispatched
    // before this bump carries the pre-suppress epoch forever, so its write-back is refused no
    // matter what `allowed` or `offset` read as by the time it resolves.
    held.epoch += 1;
    held.offset = null;
    held.probe = null;
  }

  function forget(sessionId: string): void {
    // Bumped before the delete, on the entry object itself rather than on the map. Every
    // `stillValid` closure checks map identity first, and the delete below already fails that
    // check for any reader still holding this object, so the bump is defence in depth rather than
    // a guard this function relies on: a later change to the check order must not rediscover
    // `forget` as the reason removing it seemed safe.
    const held = sessions.get(sessionId);
    if (held !== undefined) held.epoch += 1;
    sessions.delete(sessionId);
    options.echo.forget(sessionId);
  }

  async function pollOne(sessionId: string, held: TailEntry, path: string): Promise<void> {
    // The pass's own per-session closure read `allowed`, `path`, and `epoch` before calling this,
    // but every await below is a real gap: `suppress`, `learn` onto a different path, and
    // `forget` all arrive on independent HTTP requests and can land in it. The epoch captured here
    // is what every write-back below is checked against, alongside map identity, `allowed`, and
    // `path`, because `allowed` and `path` alone can read as unchanged even when a suppress (or a
    // relearn and a re-allow) genuinely happened in between: a re-allow restores `allowed`, and a
    // relearn back onto the same path restores `path`, but neither restores the epoch a
    // suppression or a path change bumped.
    const epoch = held.epoch;
    const stillValid = (): boolean =>
      sessions.get(sessionId) === held && held.epoch === epoch && held.allowed && held.path === path;

    // A baseline probe from allow() or learn() may still be on its way to the filesystem;
    // awaiting it here rather than racing it with a second read is what keeps a first pass from
    // double-probing.
    if (held.probe !== null) await held.probe;
    if (!stillValid()) return;
    if (held.offset === null) {
      const probe = await read(path, 0, 0);
      if (!stillValid()) return;
      // The awaited probe above can have set the offset while this fallback read of its own was
      // in flight (nothing was pending when this function checked, so a probe starting after that
      // check races this read); only write when the field is still unset, so this fallback never
      // clobbers a baseline the real probe already established.
      if (held.offset === null) held.offset = probe.size;
      return;
    }

    const slice = await read(path, held.offset, MAX_TAIL_READ_BYTES);
    if (!stillValid()) return;
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
        // A poll can also land between the reply tool's answer and the Stop mirror, where the
        // turn's closing text is on the transcript but neither digest exists yet. The answer is
        // already on the thread as the reply-tool message, so the chunk is skipped, and the skip
        // records this side's digest so the Stop mirror that follows is suppressed through the
        // interim-echo path: both orderings of the poll and the mirror collapse to one copy.
        if (options.echo.isAnswerEcho(sessionId, text)) {
          options.echo.noteInterim(sessionId, text);
          continue;
        }
        // One await per chunk, so a session's chunks post in transcript order. A chunk that
        // could not be posted is dropped and never retried, the rule the whole routing layer
        // follows, and its digest is not recorded: the Stop mirror carrying the same text must
        // still post it, because nothing else will. The catch holds each failure to its own
        // chunk: the consumed bytes are already behind the offset, so a throw that escaped this
        // loop would lose every later chunk in the batch with no way to re-read them. The error
        // is discarded unread; it can quote the text it failed to post.
        try {
          const outcome = await options.deliver(sessionId, text);
          // A suppress() landing during this very await must not record the echo digest: the
          // deliver call itself already happened and cannot be undone, but recording the digest
          // is its own write-back, and every write-back this loop makes is checked against the
          // epoch it started under, the same rule pollOne's other reads and writes follow.
          if (!stillValid()) return;
          if (outcome.status === "sent") options.echo.noteInterim(sessionId, text);
        } catch {
          repeats(
            `session ${sessionId}'s interim delivery failed`,
            "the chunk is dropped; the error detail is withheld, it can carry content",
          );
          // A suppress() landing mid-loop must not keep publishing the rest of the batch: the
          // consumed bytes are already behind the offset either way, so what stops here is only
          // further delivery, not a write this loop was ever going to make.
          if (!stillValid()) return;
        }
      }
    }
  }

  function poll(): Promise<void> {
    // A call while a pass is running answers with that pass rather than starting a second one: a
    // second pass over the same offsets would post the same chunks twice, and the promise handed
    // back is what shutdown awaits, so it has to be the pass actually holding file handles.
    if (running !== null) return running;
    running = (async () => {
      try {
        await pass();
      } finally {
        // Drained in `finally`, not chained off a successful pass, so a pass() that rejects still
        // drains: `pollOne`'s own per-session try/catch means a rejection here is not the normal
        // case, but a drain that only ran on success would otherwise leave every probe an
        // unanticipated failure skipped holding its file handle open indefinitely.
        //
        // A pass's own per-session closures only await the probe a session already held when
        // that closure ran; a probe allow() or learn() starts later in the same pass, for a
        // session whose closure already returned, is not covered by that await. Two bounded
        // rounds against a snapshot of the set, rather than looping while it is non-empty, catch
        // that probe without letting a probe that keeps re-arming (a hung read, or a session
        // cycling allow/suppress across this exact drain) hold every later poll() hostage: a
        // probe still outstanding after both rounds is left running, and pollOne's own await of
        // held.probe catches up with it on the next pass.
        const firstRound = [...pendingProbes];
        if (firstRound.length > 0) await Promise.all(firstRound);
        const secondRound = [...pendingProbes];
        if (secondRound.length > 0) await Promise.all(secondRound);
      }
    })().finally(() => {
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
