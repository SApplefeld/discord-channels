// The transcript tailer: mid-turn narration for a thread whose session is deep in a long turn.
//
// Two things the console shows are carried by no hook payload, so the only place they exist is the
// transcript file Claude Code appends beside the session: the assistant text written between tool
// calls, and a message the operator types while the model is mid-turn, which is queued and injected
// without a UserPromptSubmit ever firing. This module polls that file for the sessions the registry
// holds live, reads what grew since the last pass, and hands the routing layer each new assistant
// text block as one interim chunk and each queued typed message as one mirrored prompt, in
// transcript order. Everything it needs from the broker arrives as injected callbacks; what it owns
// is a map of session ID to tail position and nothing else about the world.
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
import { MAX_OPTION_DESCRIPTION_LENGTH } from "./discord/render.ts";
import type { AskedOption, AskedQuestion } from "./discord/render.ts";
import type { ReplyResult } from "./routing/outbound.ts";
import { sliceCodePoints, withoutInvisible } from "./sanitize.ts";
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
  /**
   * Posts one queued mid-turn prompt to the session's own thread; the outbound router's
   * `interimPrompt`. The status is read only to keep the shared result vocabulary; nothing here
   * queues or retries, and no echo digest is recorded for a prompt, because no other path posts
   * this text.
   */
  deliverPrompt: (sessionId: string, text: string) => Promise<ReplyResult>;
  /**
   * Posts one open-question alert to the session's own thread. Both question paths ride this one
   * closure: `question()`, fed by the `AskUserQuestion` PreToolUse hook at emission, and the
   * poll's own read of the call's transcript line, which Claude Code withholds until the picker
   * is answered and which therefore serves as the resolution-time fallback. The status is read
   * only to keep the shared result vocabulary and to decide whether the emission-time alert
   * records its dedupe digest; nothing here queues or retries.
   */
  deliverQuestion: (sessionId: string, questions: readonly AskedQuestion[]) => Promise<ReplyResult>;
  echo: EchoMemory;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
  /**
   * How long one poll pass may run before the next `poll()` reports it as still running. The
   * poll interval is the caller's, not this module's, so the caller scales this to several
   * intervals; a pass legitimately outlasts one interval when Discord is slow, and the watchdog
   * exists for the pass that outlasts them all.
   */
  passWatchdogMs?: number;
  /** The one read this module performs. Injected so a test can count reads or fail them. */
  readFile?: (path: string, offset: number, maxBytes: number) => Promise<TranscriptSlice>;
};

export type TranscriptTailer = {
  /**
   * Teaches the tailer where a session's transcript lives, from a credited hook post. A path
   * whose filename stem is not the session id it is taught for is refused whole: every real
   * transcript is `<session-id>.jsonl`, so a path that breaks that invariant is an upstream
   * shape change or a forged payload, and either must not re-aim what this module reads.
   */
  learn: (sessionId: string, path: string) => void;
  /**
   * Posts one emission-time question alert for a session whose mirror verdict is on, through the
   * same `deliverQuestion` seam the poll's transcript yield uses. Fed by the `AskUserQuestion`
   * PreToolUse hook, which fires while the console's picker is open, long before the transcript
   * line exists. Fails toward silence on every gate: a session with no verdict seen, a
   * suppressed one, or an empty parse contributes nothing, and a question whose digest is
   * already outstanding (the CLI re-posting an identical payload) is skipped rather than pinged
   * twice. An alert that lands records a one-shot digest in the entry's bounded outstanding set
   * so the resolution-time transcript yield skips its own copy of the same question; an alert
   * that does not land records nothing, leaving that yield armed as the fallback.
   *
   * Reports whether a delivery was dispatched, not whether it landed: the delivery is
   * fire-and-forget, so the answer is available synchronously, and false names every gate above.
   * The hold seam reads it, because a hold created for a post that alerted nowhere is a question
   * parked with nothing to answer it.
   */
  question: (sessionId: string, questions: readonly AskedQuestion[]) => boolean;
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
 * The pass watchdog's default threshold when the caller supplies none: three of the default poll
 * intervals, the same "several intervals" scaling index.ts applies to the configured one.
 */
const DEFAULT_PASS_WATCHDOG_MS = 60_000;

/**
 * The most emission-time question digests one session holds outstanding at once. A session parks
 * on one question at a time in practice, but a resolution line is consumed only by a later poll,
 * so a fast ask-answer-ask run holds a few unconsumed together; the bound is what keeps a
 * session that asks forever from growing the entry without limit. Past it the oldest digest is
 * evicted, whose cost if its line still arrives is one duplicate alert, never a lost question.
 */
const MAX_OUTSTANDING_QUESTION_DIGESTS = 8;

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
    // Oldest closed window first, and whatever it still owes is written on the way out. A reason
    // carries a session id, so an entry left in the map because it owes a count is one only that
    // same session could ever flush, and a session that went away never will: the map would then
    // grow by one for the life of the process. Open windows are left alone, where the count riding
    // on the next line of a reason is still the reason's to report.
    const closed = [...state]
      .filter(([, kept]) => at - kept.windowStart >= REPEAT_WINDOW_MS)
      .sort(([, left], [, right]) => left.windowStart - right.windowStart);
    for (const [key, kept] of closed) {
      if (state.size <= MAX_REPEAT_KEYS) return;
      if (kept.suppressed > 0) {
        log(`tail: ${key} occurred ${kept.suppressed} more time(s) in the last ${REPEAT_WINDOW_MS}ms`);
      }
      state.delete(key);
    }
  };
}

/**
 * One thing a transcript line contributes: a block of assistant narration, a mid-turn message the
 * operator typed at the console, or the questions an `AskUserQuestion` call is holding the
 * session on. All carry untrusted content, and they differ in where they go, `deliver` against
 * `deliverPrompt` against `deliverQuestion`, and therefore in how the thread presents them.
 */
type TailItem =
  | { kind: "text" | "prompt"; text: string }
  | { kind: "question"; questions: readonly AskedQuestion[] };

/**
 * The most questions one `AskUserQuestion` line contributes, the tool's own ceiling.
 *
 * Exported because the interactive message spends one Discord action row per question out of a
 * budget of five, so this bound and that budget are one constraint held in two modules: a pin over
 * the pair fails the moment either moves alone.
 */
export const MAX_QUESTIONS_PER_ASK = 4;

/** The most option labels one question contributes, the tool's own ceiling. */
const MAX_OPTIONS_PER_QUESTION = 4;

/**
 * The bounded questions an `AskUserQuestion` `tool_use` block's `input` holds; empty when nothing
 * in it is readable. Exported because the hook intake reads the PreToolUse payload's `tool_input`
 * through this same reader: one reading on both paths, so the emission-time alert and the
 * resolution-time fallback cannot drift apart in what they admit or render.
 *
 * Parsed by the allowlist's own rule: the input is another program's tool-call format, so
 * anything malformed contributes silence, never a guess and never a throw. At most the first four
 * entries of `questions` are read, and per entry the `question` string carries the weight: an
 * entry without one, or whose question is empty once the invisible class is stripped and the rest
 * trimmed (the same reading the renderer neutralizes by, so an entry the notice would draw as a
 * blank line never yields), is skipped whole. The `header` and each option `label` are read on
 * that same stripped-then-trimmed test, so no field admitted here renders as absent later,
 * `multiSelect` is read strictly (anything but `true` reads false), and at most the first four
 * option entries contribute their `label` and their `description`. The description is the one
 * field bounded here rather than at a render site: the label is the string an answer is submitted
 * as, so it is held verbatim, while nothing reads a description but a display surface with a hard
 * field limit, and cutting it at the reader keeps an unbounded one out of the held entries and the
 * digests taken over them. A description that is absent, or empty once the invisible class is
 * stripped and the rest trimmed, reads as null and renders as absent.
 */
export function askedQuestions(input: unknown): AskedQuestion[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  const questions = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(questions)) return [];
  const readable: AskedQuestion[] = [];
  for (const entry of questions.slice(0, MAX_QUESTIONS_PER_ASK)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    const question = fields["question"];
    if (typeof question !== "string" || withoutInvisible(question).trim() === "") continue;
    const header = fields["header"];
    const rawOptions = fields["options"];
    const options: AskedOption[] = [];
    if (Array.isArray(rawOptions)) {
      for (const option of rawOptions.slice(0, MAX_OPTIONS_PER_QUESTION)) {
        if (typeof option !== "object" || option === null || Array.isArray(option)) continue;
        const fields = option as Record<string, unknown>;
        const label = fields["label"];
        if (typeof label !== "string" || withoutInvisible(label).trim() === "") continue;
        const description = fields["description"];
        options.push({
          label,
          description:
            typeof description === "string" && withoutInvisible(description).trim() !== ""
              ? sliceCodePoints(description, MAX_OPTION_DESCRIPTION_LENGTH)
              : null,
        });
      }
    }
    readable.push({
      question,
      header:
        typeof header === "string" && withoutInvisible(header).trim() !== "" ? header : null,
      multiSelect: fields["multiSelect"] === true,
      options,
    });
  }
  return readable;
}

/**
 * What one transcript line contributes, decided by an allowlist and never a denylist. Three line
 * shapes yield anything, and all must first not be a sidechain and must name in `sessionId` the
 * session this transcript was learned for.
 *
 * A line yields assistant text when its `type` is `assistant`, its `message.content` is an array,
 * and a block in that array is a `text` block carrying a non-empty string.
 *
 * A line yields a question item when its `type` is `assistant` and a block in `message.content`
 * is a `tool_use` block naming `AskUserQuestion`: the one tool call the console answers with a
 * picker. Claude Code withholds this line from the transcript while the picker is open and
 * writes it at answer time, so what this yield carries is the resolution-time reading; the
 * emission-time alert rides the tool's PreToolUse hook through `question()`, and the digest
 * recorded there is what keeps this yield from alerting the same question twice. What is yielded
 * is the bounded structured reading `askedQuestions` above takes of the block's `input`, never
 * the block itself, and a block yielding zero readable questions yields nothing.
 *
 * A line yields a queued prompt when its `type` is `attachment` and its `attachment` is an object
 * whose `type` is `queued_command`, whose `commandMode` is `prompt`, whose `origin.kind` is
 * `human`, and whose `prompt` is a non-empty string. That is the shape of a message typed at the
 * console while the model was working, which fires no hook and writes no user line. The narrower
 * clauses are each load-bearing against a real line: `task-notification` is the mode of the
 * machine-written background-task notices that make up the bulk of `queued_command` lines,
 * `origin.kind` `channel` is the harness's injection of a message the operator posted in the
 * thread itself, and a `prompt` that is an object rather than a string carries pasted image
 * references rather than prose.
 *
 * Everything else yields nothing: thinking blocks, tool calls, tool results, attachments of other
 * types, a `queued_command` whose `commandMode` is not `prompt`, withdrawn queue entries, system
 * lines, user lines, and every line type this build has never seen. The transcript is another
 * program's file format that can grow new line types without notice, so the safe default for the
 * unrecognized is silence, never publication.
 *
 * The `sessionId` match is what carries the weight, because it is the one field verifiable
 * against live data; `isSidechain` is defense against a build that starts interleaving subagent
 * traffic into the main session's file. `sessionId` rather than `session_id`, which some lines of
 * these shapes carry and some do not.
 *
 * A parse failure yields nothing and the error is discarded unread: the file is written by
 * another process, so a half-flushed line is not an error, and the parse error's message embeds
 * an excerpt of the line's own text, which must never reach a log.
 */
function lineItems(line: string, sessionId: string): TailItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record["isSidechain"] === true) return [];
  if (record["sessionId"] !== sessionId) return [];
  if (record["type"] === "assistant") {
    const message = record["message"];
    if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) return [];
    const items: TailItem[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      const fields = block as Record<string, unknown>;
      if (fields["type"] === "tool_use" && fields["name"] === "AskUserQuestion") {
        const questions = askedQuestions(fields["input"]);
        if (questions.length > 0) items.push({ kind: "question", questions });
        continue;
      }
      if (fields["type"] !== "text") continue;
      const text = fields["text"];
      if (typeof text === "string" && text !== "") items.push({ kind: "text", text });
    }
    return items;
  }
  if (record["type"] === "attachment") {
    const attachment = record["attachment"];
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      return [];
    }
    const fields = attachment as Record<string, unknown>;
    if (fields["type"] !== "queued_command") return [];
    if (fields["commandMode"] !== "prompt") return [];
    const origin = fields["origin"];
    if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return [];
    if ((origin as Record<string, unknown>)["kind"] !== "human") return [];
    const prompt = fields["prompt"];
    if (typeof prompt !== "string" || prompt === "") return [];
    return [{ kind: "prompt", text: prompt }];
  }
  return [];
}

/**
 * One digest over a parsed question set, for the emission-versus-resolution dedupe. Computed
 * over the bounded structured reading, never the raw input, and both paths parse through
 * `askedQuestions`, so the same call digests identically however it arrived. A digest rather
 * than the questions themselves, the echo memory's own rule: no conversation text is held in
 * broker memory past the moment it is posted.
 *
 * Exported because the question desk keys its held entries by the same reading, and the alert
 * wrapper releases a hold by digest: three modules comparing digests across the seam means one
 * hashing, because a second implementation drifting by a field would turn every cross-module
 * match into a silent miss.
 */
export function questionDigest(questions: readonly AskedQuestion[]): string {
  return createHash("sha256").update(JSON.stringify(questions), "utf8").digest("hex");
}

/**
 * The filename stem of a taught path: the basename with a `.jsonl` extension removed. Every real
 * transcript is named `<session-id>.jsonl`, the measured invariant `learn()` pins taught paths
 * to.
 */
function taughtStem(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
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
   * Digests of the questions the hook path has alerted whose resolution lines the transcript has
   * not yet yielded, oldest first, bounded by MAX_OUTSTANDING_QUESTION_DIGESTS. Written by
   * `question()` on a delivered alert; the poll's transcript yield consults the set and consumes
   * exactly the digest it matched, skipping the resolution-time duplicate of a question already
   * alerted at emission. A set rather than one slot, because the lines land at answer time: Q1
   * answered and Q2 asked before the next poll leaves both outstanding at once, and a slot would
   * let Q2 evict Q1's digest and re-alert Q1. Each digest stays one-shot on the echo memory's
   * discipline (the double path produces exactly one duplicate per question, and a digest left
   * standing would silence a later turn genuinely asking the same question again), and the set
   * doubles as `question()`'s idempotency guard against the CLI re-posting an identical hook
   * payload. Dropped whole by `suppress` and with the entry by `forget`.
   */
  askedDigests: string[];
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
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(log, now);
  const read = options.readFile ?? readSlice;
  const passWatchdogMs = options.passWatchdogMs ?? DEFAULT_PASS_WATCHDOG_MS;
  const sessions = new Map<string, TailEntry>();
  // One pass at a time: a pass can outlast the poll interval when Discord is slow, and a second
  // pass over the same offsets would read and post the same chunks twice. The pass itself is
  // held, not a flag, because the promise a busy poll answers with is what shutdown awaits.
  let running: Promise<void> | null = null;
  // When the running pass began, read only while `running` is held: the watchdog compares it
  // against the clock on every poll that finds the previous pass still going.
  let passStartedAt = 0;
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
      held = { path: null, offset: null, probe: null, askedDigests: [], allowed: false, epoch: 0 };
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
    // The stem-pin: a real transcript is named <session-id>.jsonl, and every credited hook
    // payload carries the parent session's own path (a subagent's identity rides in separate
    // fields, never in this path). A taught path whose stem disagrees is therefore an upstream
    // shape change or a forged payload, and accepting it would reset the offset and aim every
    // later read at a file this session does not own. Refused whole, before the entry is even
    // created: the entry keeps its prior path, and the refusal is one bounded line naming the
    // session and never the path, which is content-adjacent and stays out of the log.
    if (taughtStem(path) !== sessionId) {
      repeats(
        `session ${sessionId} was taught a transcript path whose filename is not its own session id`,
        "the path is refused; the entry keeps its prior path",
      );
      return;
    }
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
    // The outstanding question digests drop with the offset: the resolution lines they were
    // waiting for belong to the file being left behind, and a digest that outlives its own line
    // would mis-consume a later identical question's only alert, the same direction suppress()
    // takes.
    held.askedDigests = [];
    startProbe(sessionId, held);
  }

  function allow(sessionId: string): void {
    const held = entry(sessionId);
    held.allowed = true;
    startProbe(sessionId, held);
  }

  function question(sessionId: string, questions: readonly AskedQuestion[]): boolean {
    // Every gate fails toward silence, the module's own arming rule: an empty parse, a session
    // this tailer has never seen a verdict for, and a suppressed session all contribute nothing.
    // Each returns false, which is the caller's signal that this post reached nobody.
    // `sessions.get` rather than `entry`, so an unseen session is not given an entry by the act
    // of asking about it.
    if (questions.length === 0) return false;
    const held = sessions.get(sessionId);
    if (held === undefined || !held.allowed) return false;
    const digest = questionDigest(questions);
    // The CLI retries a hook post it could not land, for hours when it comes to that, so an
    // identical PreToolUse can arrive again while its first alert's digest is still outstanding.
    // A digest already in the set means this exact question already reached the operator, and
    // the repeat is skipped whole rather than pinged twice.
    if (held.askedDigests.includes(digest)) return false;
    const epoch = held.epoch;
    // Fire-and-forget from the caller's point of view: the hook intake answers its request
    // without waiting on Discord, and a failed alert is dropped, never retried, exactly as the
    // transcript yield drops one. The digest is recorded only for an alert that landed, so a
    // refused or failed emission-time alert leaves the resolution-time yield armed as the
    // fallback, and the write-back is checked against the epoch captured here, the rule every
    // async write in this module follows.
    void (async () => {
      try {
        const outcome = await options.deliverQuestion(sessionId, questions);
        if (sessions.get(sessionId) !== held || held.epoch !== epoch || !held.allowed) return;
        if (outcome.status === "sent") {
          // Recorded only after the delivery resolved as sent, which leaves a narrow window: an
          // answer landing while a slow Discord write is still in flight can put the resolution
          // line on a poll that runs before this digest exists, and that poll posts a duplicate.
          // Deliberate: recording at dispatch would invert the failure direction, because a
          // digest recorded for a delivery that then fails consumes the resolution-time fallback
          // and the question alerts nowhere. The fail direction here is one duplicate ping,
          // never a lost question.
          // The record itself is guarded: two identical asks racing inside one delivery flight
          // both pass the pre-dispatch skip above, and a second copy here would survive the one
          // resolution-time consume to swallow a later identical question's only alert.
          if (!held.askedDigests.includes(digest)) {
            held.askedDigests.push(digest);
            if (held.askedDigests.length > MAX_OUTSTANDING_QUESTION_DIGESTS) held.askedDigests.shift();
          }
        }
        if (outcome.status === "failed") {
          repeats(
            `session ${sessionId}'s question alert was refused`,
            "the alert is dropped, not retried",
          );
        }
      } catch {
        repeats(
          `session ${sessionId}'s question alert failed`,
          "the alert is dropped; the error detail is withheld, it can carry content",
        );
      }
    })();
    return true;
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
    // The outstanding question digests drop with the offset, on the same silence-over-stale-state
    // direction: the suppressed window swallows the resolution lines they were waiting for, and a
    // digest that outlives its own line would mis-consume a later identical question's only
    // alert. The cost of dropping one whose line does still arrive is one duplicate ping, the
    // fail direction every branch of this dedupe takes.
    held.askedDigests = [];
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
      for (const item of lineItems(line, sessionId)) {
        if (item.kind === "question") {
          // The questions the console held this session on, landing here at answer time because
          // Claude Code writes the line when the picker closes. The hook path usually alerted
          // this same question at emission and recorded its digest, so a match here is that one
          // duplicate, consumed as it is skipped; no digest means an unupgraded hook set or a
          // hook alert that never landed, and then this yield is the question's only signal,
          // delivered on the same one-await-per-item rule the other kinds follow. An alert that
          // could not be made is dropped and never retried, and the error is discarded unread,
          // because it can quote the question.
          const outstanding = held.askedDigests.indexOf(questionDigest(item.questions));
          if (outstanding !== -1) {
            held.askedDigests.splice(outstanding, 1);
            continue;
          }
          try {
            const outcome = await options.deliverQuestion(sessionId, item.questions);
            // Every point past an await re-checks the epoch it started under, the rule the rest
            // of this function follows: a suppress landing during this delivery stops the batch
            // here rather than publishing the items behind it.
            if (!stillValid()) return;
            // A refusal is made visible by a bounded line, because this alert is the only signal
            // a parked question sends anywhere: a volume ceiling or a failed write eating it in
            // silence would leave the operator unpinged with nothing in the log saying so.
            // `no-thread` is not logged; it is the steady state of a broker running without
            // Discord.
            if (outcome.status === "failed") {
              repeats(
                `session ${sessionId}'s question alert was refused`,
                "the alert is dropped, not retried",
              );
            }
          } catch {
            repeats(
              `session ${sessionId}'s question alert failed`,
              "the alert is dropped; the error detail is withheld, it can carry content",
            );
            if (!stillValid()) return;
          }
          continue;
        }
        if (item.kind === "prompt") {
          // The operator's own typed words, delivered on the same one-await-per-item rule the
          // chunks below follow, so a prompt sitting between two assistant lines reaches the
          // thread between them. No echo digest is recorded: no other path posts this text, so
          // there is no duplicate to answer for. A delivery that could not be made is dropped and
          // never retried, and the error is discarded unread, because it can quote the text.
          try {
            await options.deliverPrompt(sessionId, item.text);
            // Every point past an await re-checks the epoch it started under, the rule the rest of
            // this function follows: a suppress landing during this delivery stops the batch here
            // rather than publishing the items behind it.
            if (!stillValid()) return;
          } catch {
            repeats(
              `session ${sessionId}'s queued prompt delivery failed`,
              "the prompt is dropped; the error detail is withheld, it can carry content",
            );
            if (!stillValid()) return;
          }
          continue;
        }
        const text = item.text;
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
        // One await per item, here and on the prompt branch above, so a session's chunks and its
        // queued prompts post in the order the transcript holds them. A chunk the router could not
        // land is dropped, never kept for a later call, the rule the whole routing layer follows,
        // and its digest is not recorded: the Stop mirror carrying the same text must
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
    if (running !== null) {
      // The pass watchdog. A pass legitimately outlasts one poll interval when Discord is slow;
      // one that outlasts the threshold, several intervals, is wedged on something, and without
      // this line the only symptom is narration quietly stopping. Rate-limited by the repeat
      // limiter, so a long wedge is one line a window rather than a line a tick, and the line
      // carries a duration and nothing content-adjacent.
      const elapsed = now() - passStartedAt;
      if (elapsed >= passWatchdogMs) {
        repeats(
          "a poll pass is still running past the watchdog threshold",
          `${elapsed}ms since the pass began`,
        );
      }
      return running;
    }
    passStartedAt = now();
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

  return { learn, allow, suppress, question, poll, forget };
}
