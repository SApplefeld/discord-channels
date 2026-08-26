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
import {
  MAX_HELD_DESCRIPTION_LENGTH,
  MAX_MODEL_DETAIL_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  fit,
  inertName,
} from "./discord/render.ts";
import type { AskedOption, AskedQuestion } from "./discord/render.ts";
import type { ModelFallback, ModelFallbackCause, ModelReading } from "./registry.ts";
import type { ReplyResult } from "./routing/outbound.ts";
import { clean, withoutInvisible } from "./sanitize.ts";
import { NEAR_MATCH_THRESHOLD, normalizeForSketch, similarity, sketchOf } from "./similarity.ts";
import type { Sketch } from "./similarity.ts";

/**
 * Ceiling on what one pass reads from one session's transcript. Past it the offset jumps to the
 * file's current end and the skip is logged by count, never by content: a session that outran the
 * tailer is better served by current narration than by a backlog read out minutes late.
 */
export const MAX_TAIL_READ_BYTES = 256 * 1024;

/**
 * Which path put a prompt on a thread: the `UserPromptSubmit` hook, or the tailer's own read of the
 * transcript. Each path has a prompt slot of its own, writes only that one and reads only the
 * other's, so a caller names its own path once and the slot arithmetic follows from it: a path
 * cannot reach its own claim, and a drop line worded from a match names the path that really
 * dispatched the surviving copy rather than the path that usually does.
 */
export type PromptPath = "mirror" | "tailer";

/**
 * The four claimable slots. Named at every release so a run gives up its own claim and no other:
 * a run's text can equal text some other path genuinely posted, and sweeping every slot on a digest
 * match would spend a record that is doing its job.
 */
export type EchoSlot = "interim" | "reply" | "prompt-mirror" | "prompt-tailer";

/**
 * Which shape of prompt a transcript line carried: the typed prompt that opens a turn, which the
 * `UserPromptSubmit` mirror also posts, or the message the operator types mid-turn, which the
 * harness queues and injects without firing any hook.
 *
 * The router branches on it because the two shapes have different path counts. A turn-opening
 * prompt exists twice and needs the dedup; a queued one exists once, so a claim it made could only
 * swallow a later prompt and a consult it made could only lose the operator's words to a claim
 * standing over the same text.
 */
export type PromptSource = "turn-open" | "queued";

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
 * A digest is claimed when a delivery is dispatched rather than when it lands, and released when
 * that run lands nothing at all. The window is why: a long reply posts as several paced messages,
 * so a digest recorded on the way out sits seconds behind the check that needed it, and the other
 * path arriving inside those seconds finds a gap and posts its own whole copy. A run every message
 * of which was refused therefore leaves the text owed to whichever path can still post it, which is
 * the property record-on-sent bought and the claim must not spend.
 *
 * Each claim also carries whether the other path has already matched it and dropped its own copy on
 * that strength, which is what `release` reports. That case is the one the claim alone cannot
 * answer: the deferring path has posted nothing and will not look again, and on the tailer's side
 * the bytes are already behind its offset, so a claimed run refused on every message is text with no
 * path left carrying it. The releasing site is what acts on the report. The bit is per slot and a
 * fresh claim on a slot clears it, because a new run is one nothing has deferred to yet, and because
 * the mirror records its own reply digest immediately after deferring to an interim claim.
 *
 * The prompt pair is the same discipline over the other duplicate pair, the operator's own typed
 * words: the `UserPromptSubmit` mirror posts a turn-opening prompt within milliseconds, and the
 * tailer reads the same line off the transcript up to a poll interval later. Either side records
 * and either side consults, because both orderings are real: the mirror hook is normally far the
 * faster of the two, so it is normally the tailer's copy that defers, but a hook the harness timed
 * out under load posts nothing at all and a slow one can land behind a poll.
 *
 * A pair rather than one shared record, built exactly as the reply pair above is built. `mirror`
 * writes `promptMirror` and reads `promptTailer`; the tailer does the reverse. A path meeting its
 * own claim is then impossible by construction rather than by a test: `continue` typed twice in a
 * row is an ordinary way to drive a session, and one record for both paths would let the second
 * copy match the first's and vanish from the thread with nothing anywhere saying so. Two slots also
 * keep the deferral bits disjoint, so one path's fresh claim cannot spend the deferral the other
 * path's still-running delivery is owed. Where only one path exists at all, which is a supported
 * host, the split is what makes the pair inert: mirroring on with interim mirroring off builds this
 * memory and no tailer, so `promptTailer` is never written and the mirror's every consult of it
 * reads null.
 *
 * A prompt claim expires, which the reply pair needs no equivalent of because a reply is bounded by
 * its own turn. A claim the other path never answered stands until something spends it, and the
 * tailer legitimately never answers one: a transcript past `MAX_TAIL_READ_BYTES`, a session learned
 * after the turn opened, a broker restarted mid-turn, a window with interim mirroring off. The next
 * identical prompt, with no live competitor anywhere, would then meet that record and be dropped as
 * an echo of a copy nothing ever posted. So each claim carries the time it was made, and a consult
 * refuses and discards a record older than `promptClaimMs`. The fail direction of the bound is a
 * duplicate prompt, never a lost one.
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
  /**
   * Records the last turn-opening prompt this session dispatched, in the slot belonging to the path
   * dispatching it: `by` is the caller's own path, never the path it is asking about.
   */
  notePrompt: (sessionId: string, text: string, by: PromptPath) => void;
  /**
   * Marks the caller's own standing claim over this text as landed, shrinking its remaining life
   * to `PROMPT_SETTLE_GRACE_MS`: past that, the only consult a landed run's claim could still
   * answer is a retype, never the copy it raced. A claim over other text is left alone, since it
   * belongs to a later prompt's run. The tailer's success seam calls this; the mirror's does not,
   * because the mirror claim's consumer is a poll pass that can run the whole claim window late,
   * and a mirror claim dying with its run would hand the tailer a gap and a duplicate on every
   * slow pass.
   */
  settlePrompt: (sessionId: string, text: string, by: PromptPath) => void;
  /** Records the last reply-tool answer posted for this session, replacing the previous one. */
  noteAnswer: (sessionId: string, text: string) => void;
  /**
   * True when the text matches either remembered digest, consuming what it matched. The prompt
   * slots are not among them: this is the narration path's lookup, and the operator's words and
   * Claude's are two registers on the thread, so a chunk of narration quoting a prompt back is not
   * that prompt's second copy.
   */
  isEcho: (sessionId: string, text: string) => boolean;
  /** True when the text matches the last interim chunk, consuming it on a match. */
  isInterimEcho: (sessionId: string, text: string) => boolean;
  /**
   * True when the text matches a turn-opening prompt the *other* path claimed, consuming it on a
   * match. `by` names the path asking, and the slot read is the other path's, so two identical
   * prompts down one path both post: the asking path's own claim is not reachable from here.
   *
   * A record older than `promptClaimMs` never matches and is discarded where it is found, whatever
   * its digest says. It is a claim the other path never came to answer, and left standing it would
   * suppress a later prompt that has no second copy anywhere.
   */
  isPromptEcho: (sessionId: string, text: string, by: PromptPath) => boolean;
  /** True when the text matches the last answer, exactly or nearly, consuming it on a match. */
  isAnswerEcho: (sessionId: string, text: string) => boolean;
  /**
   * Drops a claim over this text, made by whichever half is reporting that its run landed nothing.
   *
   * Scoped to the slot the caller claimed, its own prompt slot included, and to a digest equal to
   * this text's, with one exception: an interim release also spends a reply record over the same
   * digest, which the reply-kind mirror leaves behind when it defers to an interim claim and posts
   * nothing. The answer record is never touched at all, since it carries its own turn boundary and
   * no posting path claims it. The implementation states which cross-slot clears are safe and why.
   *
   * True when a claim being dropped here had already suppressed the other path's own copy, which
   * makes the releasing site the last place this text can still reach the thread.
   */
  release: (sessionId: string, text: string, slot: EchoSlot) => boolean;
  /**
   * Drops both prompt claims for a session, leaving the deferral bits, the interim and reply
   * records and the answer record where they are.
   *
   * Called by the tailer wherever it commits to never reading a stretch of a session's transcript.
   * There are four places its read position jumps forward over bytes nobody read: the baseline
   * probe, which is the ordinary way a freshly learned or re-learned session starts, and which
   * calls this at its dispatch rather than at its resolution so the claim the arming prompt's own
   * delivery writes while the read is in flight survives it; the same baseline taken inside a
   * pass, the fallback for a probe that never resolved; a file that shrank below the held offset;
   * and a backlog past `MAX_TAIL_READ_BYTES` skipped to the file's end. All four call this. A
   * prompt claim made before such a jump is one this path has now guaranteed it will never
   * answer, and the age bound only caps how long it can suppress:
   * this closes the generator, which matters most under exactly the saturated host where a skip
   * and a timed-out hook are both likely and the next identical prompt is the one the recovery
   * exists for.
   *
   * The claims only. A deferral bit records something that already happened, that the other path
   * met a claim and dropped its own copy, and the run it belongs to is still in flight: clearing it
   * would take away the one retry that run is owed and the text would reach the thread by neither
   * path, which is the loss this whole section prevents. A bit left standing over a claim that is
   * gone costs nothing, since `notePrompt` clears one over its own digest when the slot is claimed
   * again and `release` spends it.
   *
   * The reply pair is untouched too, and has no equivalent exposure: a reply claim is bounded by
   * its own turn and released by the run that made it, and clearing one here would let a reply the
   * Stop mirror is still posting be posted a second time by the next pass.
   */
  forgetPrompts: (sessionId: string) => void;
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

/**
 * How long a prompt claim may stand before a consult refuses it, where the caller names no bound.
 * The caller that wires the broker derives its own from the poll interval; this is the floor that
 * derivation starts from, and it is what a memory built by a test gets.
 *
 * A minute is far wider than the window it has to cover, which is the gap between the two copies of
 * one prompt: milliseconds for the hook, one poll pass for the tailer. Wide because the cost of the
 * two directions is not symmetric. Too short only ever costs a second copy of a prompt the operator
 * is looking at anyway; too long is the loss the bound exists to close.
 */
export const DEFAULT_PROMPT_CLAIM_MS = 60_000;

/**
 * How long a settled prompt claim, one whose run has already landed, keeps answering consults.
 *
 * A landed run has one legitimate consult left: the same prompt's copy on the other path, already
 * in flight when the run landed. For the tailer's claim, the only one that settles, that copy is
 * the `UserPromptSubmit` post, whose harness-side timeout the hook fragment pins at ten seconds
 * and whose delivery follows the intake's body read at once, so a copy that has not consulted
 * this long after the landing is not the raced one. Measured from the landing, which is later
 * than the keystroke that started the hook's own clock, so the grace covers that whole budget
 * with room. Past it, a matching consult is the operator retyping the same words, and suppressing
 * that is the loss the claim window exists to prevent.
 */
export const PROMPT_SETTLE_GRACE_MS = 10_000;

export type EchoMemoryOptions = {
  /**
   * How long a prompt claim stands before a consult refuses and discards it. Scaled by the caller
   * to the poll interval, since a claim has to outlive the pass that would answer it.
   */
  promptClaimMs?: number;
  /** Stamps and ages prompt claims. Injected so a test moves the window without sleeping. */
  now?: () => number;
};

export function createEchoMemory(options: EchoMemoryOptions = {}): EchoMemory {
  const promptClaimMs = options.promptClaimMs ?? DEFAULT_PROMPT_CLAIM_MS;
  const now = options.now ?? Date.now;

  /**
   * A prompt claim: the digest of the text, when the run carrying it was dispatched, and when
   * that run landed, null while it is still posting.
   */
  type PromptClaim = { digest: string; at: number; settledAt: number | null };

  type Entry = {
    interim: string | null;
    reply: string | null;
    /**
     * One prompt slot per path, on the reply pair's own arrangement: `promptMirror` is written by
     * the `UserPromptSubmit` mirror and read by the tailer, `promptTailer` the reverse. Neither
     * path can reach the slot it writes, so two identical prompts down one path both post.
     */
    promptMirror: PromptClaim | null;
    promptTailer: PromptClaim | null;
    /**
     * The digest of the claim in each slot that the other path matched and dropped its own copy
     * over, held past the match that consumed the claim itself: the release comes from the run that
     * made the claim, which is seconds of paced posting later, and what it needs to know then is
     * whether anything else is still carrying this text.
     *
     * Held per slot, and reset by a fresh claim on that slot alone, because the reply pair defer to
     * each other within one turn: the mirror matching the tailer's interim claim records its own
     * reply digest one line later, and that record says nothing about the tailer's deferral. The
     * prompt slots being per path is what extends that property to them: a fresh claim by either
     * path touches only its own bit, so the deferral the other path's still-running delivery is
     * owed survives it.
     */
    deferred: Record<EchoSlot, string | null>;
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
      held = {
        interim: null,
        reply: null,
        promptMirror: null,
        promptTailer: null,
        deferred: {
          interim: null,
          reply: null,
          "prompt-mirror": null,
          "prompt-tailer": null,
        },
        answer: null,
      };
      state.set(sessionId, held);
    }
    return held;
  }

  /** The entry field a path claims into: its own, never the one it reads. */
  function owned(by: PromptPath): "promptMirror" | "promptTailer" {
    return by === "mirror" ? "promptMirror" : "promptTailer";
  }

  /** The slot name a path's own claim is released under, the release site's argument. */
  function ownedSlot(by: PromptPath): EchoSlot {
    return by === "mirror" ? "prompt-mirror" : "prompt-tailer";
  }

  /** The path a caller reads, which is the one it is not. */
  function other(by: PromptPath): PromptPath {
    return by === "mirror" ? "tailer" : "mirror";
  }

  return {
    noteInterim(sessionId, text) {
      const held = entry(sessionId);
      held.interim = digest(text);
      held.deferred.interim = null;
    },
    noteReply(sessionId, text) {
      const held = entry(sessionId);
      held.reply = digest(text);
      held.deferred.reply = null;
    },
    notePrompt(sessionId, text, by) {
      const held = entry(sessionId);
      const mark = digest(text);
      // The deferral bit is cleared only where it stands over these same words, unlike the reply
      // pair's own claims, which clear theirs outright. Neither prompt path is serialized: the
      // intake answers a `UserPromptSubmit` and dispatches its delivery without awaiting it
      // (intake.ts), so two prompts for one session overlap, and a second one claiming here
      // while the first one's run is still posting would spend a bit the first one is owed. That
      // run then lands nothing, finds no deferral, and never takes the retry that is the only thing
      // left carrying the operator's words. The same-digest clear does not share that safety:
      // claims carry no run identity, so this call cannot tell a re-dispatch of the run the bit
      // was set against from a distinct overlapping run that happens to carry identical text,
      // which is the ordinary case of typing the same words twice. In that shape this clear
      // spends the bit the first run is owed all the same: that run, landing nothing, finds no
      // deferral, takes no retry, logs the ordinary stopped-early line rather than `reached the
      // thread by neither path`, and its release spends this call's own claim besides. The
      // residual stands with the run-identity gap that produces it, which is the structure the
      // prompt slots share with the reply pair; closing it means tagging every slot with the run
      // that made it.
      if (held.deferred[ownedSlot(by)] === mark) held.deferred[ownedSlot(by)] = null;
      held[owned(by)] = { digest: mark, at: now(), settledAt: null };
    },
    settlePrompt(sessionId, text, by) {
      const held = state.get(sessionId);
      if (held === undefined) return;
      const claim = held[owned(by)];
      // The digest guard scopes the settle to the run's own claim: a different digest means a
      // later prompt claimed over this one mid-run, and that claim's life is its own run's to
      // bound.
      if (claim === null || claim.digest !== digest(text)) return;
      claim.settledAt = now();
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
      // The caller is about to post nothing for this text, so each claim it consumes is one the
      // caller is now relying on. Recorded as the claim is spent, since that is the only moment
      // both the digest and the deferral are in hand.
      if (held.interim !== null && mark === held.interim) {
        held.interim = null;
        held.deferred.interim = mark;
        matched = true;
      }
      if (held.reply !== null && mark === held.reply) {
        held.reply = null;
        held.deferred.reply = mark;
        matched = true;
      }
      return matched;
    },
    isInterimEcho(sessionId, text) {
      const held = state.get(sessionId);
      if (held === undefined || held.interim === null || digest(text) !== held.interim) return false;
      held.deferred.interim = held.interim;
      held.interim = null;
      return true;
    },
    isPromptEcho(sessionId, text, by) {
      const held = state.get(sessionId);
      if (held === undefined) return false;
      // The other path's slot, always: `by` is the caller's own path, and the caller's own claim is
      // not reachable from here. The operator typing the same words twice is two messages and not
      // one echo, and this is what keeps the second one on the thread.
      const slot = owned(other(by));
      const claim = held[slot];
      if (claim === null) return false;
      // Age before digest, and the stale record is discarded whether or not this text matches it.
      // A claim this old is one the claiming path made and the asking path never came to answer,
      // which is what a transcript past the read ceiling, a session learned mid-turn, a restarted
      // broker, or a mirror-only window leaves behind. Left standing it would suppress a prompt
      // that has no second copy anywhere.
      //
      // A claim stamped in the future is expired too, which is what a wall clock stepped backwards
      // produces: the elapsed time goes negative and stays there, so a plain upper bound would let
      // one stale record refuse every consult until something overwrote the slot. Both directions
      // out of the window are answered the same way, and the cost either way is one duplicate.
      const elapsed = now() - claim.at;
      if (elapsed < 0 || elapsed > promptClaimMs) {
        held[slot] = null;
        return false;
      }
      // A settled claim is one whose run already landed, so the only consult it still answers is
      // the copy it raced, and that copy's own clock runs out `PROMPT_SETTLE_GRACE_MS` after the
      // landing at the latest. Past the grace, a match is the operator's retype with no live
      // competitor, and the stale record is discarded the way the age bound above discards one,
      // a backwards clock step included.
      if (claim.settledAt !== null) {
        const since = now() - claim.settledAt;
        if (since < 0 || since > PROMPT_SETTLE_GRACE_MS) {
          held[slot] = null;
          return false;
        }
      }
      if (digest(text) !== claim.digest) return false;
      held.deferred[ownedSlot(other(by))] = claim.digest;
      held[slot] = null;
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
    release(sessionId, text, slot) {
      const held = state.get(sessionId);
      if (held === undefined) return false;
      const mark = digest(text);
      // The caller's own slot always, and one cross-slot clear beside it.
      //
      // The scoping is the general rule: a digest standing in a slot the caller did not claim is
      // usually a record some other path established over text it really did post or is still
      // posting, and dropping that would put a second copy of the same words on the thread. On a
      // prompt slot it would additionally hand a failed run's digest to a path that never claimed
      // it, which is why those two are released by name and never swept.
      //
      // The exception is the reply record against an interim release, and one site makes it
      // necessary: the reply-kind mirror that meets a standing interim claim records its own reply
      // digest and posts nothing (routing/outbound.ts, the isInterimEcho drop branch), on the
      // strength of the tailer's interim run carrying the text. If that run and its one retry both
      // land nothing, the reply digest is standing over text that reached the thread by neither
      // path, and it would suppress the next identical narration chunk through isEcho. So an
      // interim release spends it. The clear is one-directional: a reply release leaves an interim
      // record alone, because that record is a live claim by a run that is still posting.
      if (slot === "interim") {
        if (held.interim === mark) held.interim = null;
        if (held.reply === mark) held.reply = null;
      } else if (slot === "reply") {
        if (held.reply === mark) held.reply = null;
      } else {
        const field = slot === "prompt-mirror" ? "promptMirror" : "promptTailer";
        if (held[field]?.digest === mark) held[field] = null;
      }
      // The deferral is spent here too, so a second release over the same text reports nothing left
      // to save and the releasing site's retry stays bounded to one.
      if (held.deferred[slot] !== mark) return false;
      held.deferred[slot] = null;
      return true;
    },
    forgetPrompts(sessionId) {
      const held = state.get(sessionId);
      if (held === undefined) return;
      held.promptMirror = null;
      held.promptTailer = null;
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
   * Posts one interim chunk to the session's own thread; the outbound router's `interim`. Nothing
   * about the result is consulted: nothing here queues or retries, and the echo digest this chunk
   * claims is claimed and released inside the router, beside the count of messages that landed,
   * which is also where a run the Stop mirror deferred to goes again once after landing nothing.
   * The router's own result type, imported type-only so the two modules share one status
   * vocabulary without a runtime cycle: a typo'd status string here would otherwise compile and
   * silently never match.
   */
  deliver: (sessionId: string, text: string) => Promise<ReplyResult>;
  /**
   * Posts one typed prompt to the session's own thread; the outbound router's `interimPrompt`.
   * Carries both prompt shapes this reader yields, named by `source`: the mid-turn message the
   * harness queues without firing a hook, and the turn-opening prompt the `UserPromptSubmit` mirror
   * normally posts first. The status is read only to keep the shared result vocabulary; nothing
   * here queues or retries.
   *
   * The echo digest for this path's prompt slot is claimed and released inside the router, beside
   * the count of messages that landed, exactly as the interim chunk's is, and only for the
   * turn-opening shape: that one reaches the thread by two paths, and whichever arrives second
   * finds the other's claim and drops its copy. The queued shape stays out of the memory entirely,
   * having no second copy anywhere to dedup against.
   */
  deliverPrompt: (
    sessionId: string,
    text: string,
    source: PromptSource,
    at: number | null,
  ) => Promise<ReplyResult>;
  /**
   * Posts one peer message, in either direction, to the session's own thread; the outbound router's
   * `peer`. The status is read only to keep the shared result vocabulary; nothing here queues or
   * retries.
   *
   * No echo digest is recorded, which rests on a contract rather than on a measurement: that no one
   * delivery reaches both this path and the mirror path. This reader does not read the idle-delivery
   * line at all, which is half of it; the other half is that the mid-turn delivery fires no prompt
   * hook, and that is inferred from the harness's queued-injection behavior rather than observed.
   * Only a live exchange against a running harness settles that half, which is not something this
   * module can observe. Where it does not hold, one delivery posts twice, and the answer is the
   * mechanism already here: dedup by digest through the echo memory the mirror and the tailer share.
   */
  deliverPeer: (sessionId: string, traffic: PeerTraffic) => Promise<ReplyResult>;
  /**
   * Posts one open-question alert to the session's own thread. Both question paths ride this one
   * closure: `question()`, fed by the `AskUserQuestion` PreToolUse hook at emission, and the
   * poll's own read of the call's transcript line, which Claude Code withholds until the picker
   * is answered and which therefore serves as the resolution-time fallback. The status is read
   * only to keep the shared result vocabulary and to decide whether the emission-time alert
   * records its dedupe digest; nothing here queues or retries.
   */
  deliverQuestion: (sessionId: string, questions: readonly AskedQuestion[]) => Promise<ReplyResult>;
  /**
   * Reports that an ask reached its resolution line, which Claude Code writes when the picker
   * closes: the question has been answered at the console. The question desk's seam, where it flips
   * a thread message that has been telling the operator to answer there. Called for every question
   * the transcript yields, whether or not this session's alert path already handled that ask, since
   * what a session has open is the desk's to know and not this module's.
   *
   * True means a message was flipped, and a flipped ask is one this pass does not also alert: the
   * thread now says the console answered it, and an alert behind that would post the same ask as
   * one still waiting there.
   */
  answeredAtConsole: (sessionId: string, questions: readonly AskedQuestion[]) => boolean;
  /**
   * Records what an assistant line said about the model running the session and the context it ran
   * against; the registry's `noteModel`. Called for every line that carries both, so a session's
   * card tracks the model within a poll of it changing. Nothing here is posted as content, and the
   * call is synchronous: what it feeds is a record the card is rendered from, not a write to
   * Discord, and a throw out of it is caught and dropped so the narration behind it still posts.
   */
  noteModel?: (sessionId: string, reading: ModelReading) => void;
  /**
   * Records the forced downgrade a system line reported; the registry's `noteFallback`. Its own
   * seam rather than a field of the reading above, because the record arrives on its own line and
   * names what the reading cannot: which of the two paths forced the change, and what upstream
   * flagged.
   */
  noteFallback?: (sessionId: string, fallback: ModelFallback) => void;
  /**
   * Records what the session is trying to finish, as a `/goal` command line set it, or clears it on
   * the explicit `/goal clear`; the registry's `noteGoal`. Nothing here is posted as content and the
   * text is never logged: what it feeds is a record the card is rendered from.
   */
  noteGoal?: (sessionId: string, goal: string | null) => void;
  /**
   * Records the title a `custom-title` line named, whether it was written by a launch `--name` or
   * an in-session `/rename`; the registry's `noteTitle`. Unlike the other note seams, this one's
   * value is not confined to the card: it is composed into `threadName` and painted onto Discord as
   * the thread's own name, through a `PATCH /channels/{threadId}` the surface issues on its own
   * schedule. That is why the value is neutralized and bounded at the read, in `customTitle`, and
   * not left to the render site alone: what arrives here is already the text the thread will draw.
   * The call itself stays synchronous, and a throw out of it is caught and dropped so the narration
   * behind it still posts.
   */
  noteTitle?: (sessionId: string, title: string) => void;
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
 * One thing a transcript line contributes. Three of them are posted as their own message and carry
 * untrusted content into the thread: a block of assistant narration, a prompt the operator typed at
 * the console, and the questions an `AskUserQuestion` call is holding the session on. They differ
 * in where they go, `deliver` against `deliverPrompt` against `deliverQuestion`, and therefore in
 * how the thread presents them.
 *
 * The prompt carries which shape of prompt it is, because the two shapes have different path
 * counts: a turn-opening prompt is also posted by the `UserPromptSubmit` mirror and needs the
 * dedup, while a mid-turn message the harness queued fires no hook and has no second copy to dedup
 * against. They render identically and are told apart only by that field.
 *
 * It also carries `at`, the instant the line records for itself, which is when the operator
 * pressed return rather than when this module read it. The engagement stamp is taken against that
 * instant, because a poll runs up to an interval behind the line it reads and a stamp at read time
 * would sit past anything the session did in between. Null where the line names no parseable
 * timestamp, which leaves the stamp at read time, and every user line the harness writes carries
 * one.
 *
 * Two more are posted as their own message and carry text a peer session wrote: a message another
 * session sent this one while it was working, and a message this session sent another. They are the
 * two halves of one exchange, rendered under an attribution of their own, which is what keeps the
 * quoted operator register the operator's alone.
 *
 * The other four feed a session's record rather than a message on the thread: the model that
 * answered a line and the context size its usage adds up to, a structured record naming why a model
 * was forced down, the goal a `/goal` command set, and the title a `/rename` (or a launch `--name`)
 * wrote. The first three reach the operator on the card, which is why they are neutralized at the
 * render site rather than at the read, and the goal reaches nowhere else: `PublicSessionRecord` and
 * `PersistedRecord` both omit it.
 *
 * The title is the exception on both counts. It is written to Discord, as the thread's own name,
 * which the surface repaints with a `PATCH /channels/{threadId}` once the composed name settles; so
 * it is neutralized and bounded here at the read, in `customTitle`, against the same character class
 * and the same whitespace rule the render site holds a thread name to. What crosses this wire is
 * therefore already the text the thread will draw, which is what lets the reader's bound be a bound
 * on what a person actually sees.
 *
 * It is Claude Code's own record of the session's name, re-emitted on its `custom-title`
 * line every time the name is set, whether by `--name` at launch or by an in-session `/rename`. An
 * unreadable value contributes no item at all, never a `null` title: this kind carries a real string
 * only, unlike the goal's `null`, which is the operator's own explicit clear. The two are byte-alike
 * to a consumer wired the goal's way, and one malformed line must not be able to wipe a good title,
 * so the type itself, not a comment, is what keeps a rename this reader could not parse from reading
 * as a request to blank it.
 */
export type TailItem =
  | { kind: "text"; text: string }
  | { kind: "prompt"; text: string; source: PromptSource; at: number | null }
  | { kind: "question"; questions: readonly AskedQuestion[] }
  | PeerTraffic
  | { kind: "model"; reading: ModelReading }
  | { kind: "fallback"; fallback: ModelFallback }
  | { kind: "goal"; goal: string | null }
  | { kind: "title"; title: string };

/**
 * One peer message off the transcript, in either direction: a message another session sent this one
 * while it was working, or a message this session sent another.
 *
 * Named apart from the rest of the union because it is also what crosses the seam to the routing
 * layer whole. The two directions render under one attribution vocabulary and post through one
 * doorway, so the router takes the item rather than a per-direction argument list, and a field
 * added to either kind reaches the render site without a second signature to keep in step.
 */
export type PeerTraffic =
  | { kind: "peer-in"; name: string; body: string }
  | { kind: "peer-out"; to: string; summary: string | null; message: string };

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
 * as, so it is held verbatim, while an unbounded description would reach the held entries and the
 * digests taken over them. The bound is `MAX_HELD_DESCRIPTION_LENGTH` rather than any one surface's
 * field limit, because two surfaces draw this text at two different widths and each cuts to its own
 * room: bounding it at the narrower one here would spend the wider one's room before it was reached.
 * The cut is made through `fit`, which marks it, because this one is made before any surface sees
 * the text: a description shortened here and then drawn inside a surface's own room draws looking
 * whole, and an option decided on the front of a sentence with no cue that there is more is the
 * reading the whole question surface exists to prevent.
 * A description that is absent, or empty once the invisible class is stripped and the rest trimmed,
 * reads as null and renders as absent.
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
              ? fit(description, MAX_HELD_DESCRIPTION_LENGTH)
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
 * The slash command a user line reports, and its arguments, from the markup Claude Code writes a
 * console command as: `<command-name>/goal</command-name>` beside `<command-args>…</command-args>`.
 *
 * The first of each tag wins, and the content is taken non-greedily, so a command whose arguments
 * quote the markup itself cannot re-aim the reading: what an operator typed is text of the same
 * class as any other transcript content, and the tags are read as a fixed shape rather than parsed
 * as a document.
 */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The one command whose arguments this reader admits.
 *
 * An allowlist rather than a sweep of every command: a command's arguments are operator prose, and
 * most of it is nobody's business on a surface that leaves the machine. `/goal` is admitted because
 * what a session is trying to finish is exactly what a long quiet stretch on the thread needs
 * explaining, and it is the operator's own words about their own work.
 */
const GOAL_COMMAND = "/goal";

/** The argument that clears a goal, which is the one end of a goal this reader can observe. */
const GOAL_CLEAR = "clear";

/**
 * The text of a user line, whichever shape it carries it in: Claude Code writes `message.content`
 * as a string on some lines and as an array of blocks on others, and a command lands in either.
 */
function userText(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    const fields = block as Record<string, unknown>;
    if (fields["type"] !== "text") continue;
    const text = fields["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/**
 * What a `/goal` command line contributes: the goal it set, or null for the explicit clear.
 *
 * Undefined for every other line, which is every other command, a bare `/goal` (a query at the
 * console rather than a setting), and a goal whose text is empty once the invisible class is
 * stripped, on `askedQuestions`' rule that a field the surface would draw blank is not a field.
 * The text itself is held as it was written and bounded at the render site, the way an option label
 * is: nothing but the card reads it.
 */
function goalCommand(text: string): string | null | undefined {
  const name = COMMAND_NAME.exec(text);
  if (name === null || withoutInvisible(name[1]).trim() !== GOAL_COMMAND) return undefined;
  const args = COMMAND_ARGS.exec(text);
  if (args === null) return undefined;
  const written = withoutInvisible(args[1]).trim();
  if (written === "") return undefined;
  // Compared trimmed and case-folded, the way every other operator-written word this broker reads
  // is: a goal named "Clear" is nobody's goal, and reading one as a goal would leave the card
  // carrying the word the operator used to take it down.
  return written.toLowerCase() === GOAL_CLEAR ? null : args[1];
}

/**
 * Whether a user line is one the operator wrote at their own console.
 *
 * The console's own command lines carry no `origin` at all, a typed prompt carries
 * `origin.kind` `human` beside `promptSource` `typed`, and a peer message delivered to an idle
 * session carries `origin.kind` `peer` beside `promptSource` `system`. Two independent locks
 * rather than one, because either field alone is the harness's contract and can move: an origin
 * this reader does not recognize is refused whatever the prompt source says, and a
 * system-sourced line is refused whatever its origin says.
 *
 * The fail direction is the operator's, deliberately. A harness revision that starts stamping
 * console lines with an origin this does not admit costs the operator the one command read off
 * this file, which the card shows by going blank; admitting the wrong line costs the operator
 * their goal card overwritten by whoever wrote the text, which is not theirs to lose.
 */
/**
 * When a transcript line says it was written, as milliseconds, or null when it names no timestamp
 * this build can read.
 *
 * The engagement stamp is taken against this rather than against the moment the poll read the
 * line. A pass runs up to a poll interval behind the file, so a stamp at read time would land past
 * whatever the session did in between, and the blocked derivation compares a `goal-blocked` event
 * against exactly that field: a block the turn raised after the operator's prompt would be cleared
 * by the prompt that preceded it.
 *
 * The value is the harness's, so it is read defensively and never trusted beyond ordering: a
 * missing or unparseable field yields null and the caller falls back to read time, which is the
 * behaviour every path here had before the field was read at all. Nothing is published from it.
 */
function lineInstant(record: Record<string, unknown>): number | null {
  const stamp = record["timestamp"];
  if (typeof stamp !== "string") return null;
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? at : null;
}

function typedAtTheConsole(record: Record<string, unknown>): boolean {
  if (record["promptSource"] === "system") return false;
  const origin = record["origin"];
  if (origin === undefined) return true;
  if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return false;
  return (origin as Record<string, unknown>)["kind"] === "human";
}

/**
 * The whole of a user line's content when it is the operator's words and nothing else: a plain
 * string, or a content array holding exactly one text block beside any number of image blocks.
 * Null for anything else.
 *
 * Narrower than `userText` above deliberately, and the narrowness is the point. `userText` joins
 * every text block with a newline, which is the right reading for finding a command in a line; it
 * is the wrong reading for republishing a line as the operator's own message. Two things follow
 * from a multi-block line, and the second decides it. The mirror's copy of the same prompt is the
 * raw `UserPromptSubmit` string, so a joined reading digests differently, misses the dedup, and
 * posts a second copy carrying blocks the hook's copy never had. And a harness that attaches an
 * injected block to a typed line, a `system-reminder` for instance, would have that text published
 * inside the operator's own quoted register, which is the one attribution this surface holds
 * unforgeable and which no upstream shape change may be allowed to breach.
 *
 * So this one gate fails toward no recovery rather than toward a duplicate, against the direction
 * the rest of the prompt path takes. What it admits is the two shapes a person's own submission
 * arrives in: the plain string of a typed prompt, and the array a prompt with pasted screenshots
 * attached to it carries, which is one text block beside its images. An image block is admitted
 * because it carries no text and so cannot reach the register at all; the recovered copy is the
 * words alone, since the mirror hook's own copy of that prompt is the prompt string and the images
 * were never part of what the thread shows.
 *
 * The cost of the refusal is the rest: a line carrying two text blocks, or a text block beside a
 * block of a kind this build has never seen, is not recovered at all when its hook is lost. That
 * is the direction the register requires, because a second text block is either content the hook's
 * copy never had or an injection the operator did not write.
 */
function soleTypedText(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  let found: string | null = null;
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
    const fields = block as Record<string, unknown>;
    // Images pass and contribute nothing. Every other kind, a second text block included, refuses
    // the whole line: one is content the hook's copy never carried, the other is a block the
    // operator did not write, and neither may reach their register.
    if (fields["type"] === "image") continue;
    if (fields["type"] !== "text" || found !== null) return null;
    const text = fields["text"];
    if (typeof text !== "string") return null;
    found = text;
  }
  return found;
}

/**
 * The typed prompt that opened a turn, or null: the one thing the mirror carries whose loss is
 * otherwise permanent.
 *
 * The `UserPromptSubmit` hook is an http post the harness waits on and abandons at its timeout, so
 * a saturated host loses the prompt and the thread shows a reply with no question above it. Every
 * other mirror loss self-heals off this file within a poll; this reading is what makes that true of
 * prompts too. Structural throughout, never a text sniff: the harness stamps provenance on user
 * lines, and what a person typed is a property of the line rather than of the words in it.
 *
 * Four independent locks over the line, because each one alone is the harness's contract and can
 * move upstream without notice. `promptSource` `typed` is the stamp itself. `origin.kind` `human`
 * is the second reading of the same fact, the pairing `typedAtTheConsole` above already rests on.
 * `isMeta` true marks the harness's own injections, the peer delivery and the local-command caveat
 * among them. And command markup excludes a slash command, whose user line carries the markup where
 * the words the operator typed would be: whether the mirror hook fires for local commands is
 * unestablished, so admitting one here would risk a copy of something the mirror never posts, and
 * it is also what keeps a `/goal` line's one reading from becoming two. A fifth lock sits in
 * `soleTypedText` over the content, on its own reasoning.
 *
 * The fail direction is a prompt the thread does not show, deliberately. A harness revision that
 * drops one of these stamps costs the recovery and leaves the mirror hook carrying prompts alone,
 * which is what carried them before this reading existed; admitting the wrong line costs text
 * somebody else wrote, drawn in the operator's own quoted register.
 */
function typedPromptText(record: Record<string, unknown>): string | null {
  if (record["promptSource"] !== "typed") return null;
  const origin = record["origin"];
  if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return null;
  if ((origin as Record<string, unknown>)["kind"] !== "human") return null;
  if (record["isMeta"] === true) return null;
  const text = soleTypedText(record["message"]);
  if (text === null || COMMAND_NAME.test(text)) return null;
  // A prompt the surface would draw blank is not a prompt, `askedQuestions`' own rule. What is
  // returned is the string as it was written rather than the stripped reading the test was made on:
  // it is untrusted content of the same class as a mirrored reply, neutralized at the render site.
  return withoutInvisible(text).trim() === "" ? null : text;
}

/**
 * What a peer message's counterparty is called when the shape it arrived in carries no name this
 * reader can use.
 *
 * The name is the one field of a peer reading that falls back instead of gating. A body this
 * reader cannot read is a message it does not have; a name it cannot read still leaves the whole
 * message and a counterparty nobody can point to, and dropping the message over it would let a
 * peer take itself off the thread by choosing a blank display name. The name is peer-chosen text,
 * so it is exactly the field a peer controls.
 *
 * Exported because the two shapes a peer message reaches a thread in, the structured origin the
 * tailer reads and the wrapper text the prompt path reads, name an unnameable counterparty by this
 * one literal, and the pins over them read it rather than repeating the words.
 */
export const PEER_NAME_FALLBACK = "another session";

/**
 * What is drawn where a peer message's own body would be when the delivery is a peer message this
 * reader could not read the body of.
 *
 * A classified delivery always renders under the peer attribution, whether or not its body could
 * be read, because the alternative is the failure this whole reading exists to close: text a peer
 * wrote reaching the thread in the operator's own quoted register. A peer that can make its body
 * unreadable would otherwise hold the switch that puts its words there. So an unreadable body is
 * reported as one, under a name and an attribution that say exactly where the message came from,
 * and the operator reads the message itself at the console.
 *
 * A peer can write this same sentence as its body, and it renders the same way. Nothing is lost by
 * that: both readings say a peer sent something this thread cannot show, which is true either way.
 */
export const PEER_BODY_UNREADABLE = "(a message this broker could not read)";

/**
 * The most code points a name, a summary, or any other short peer-written label contributes.
 *
 * One reader outside that description shares the number: `customTitle`, whose value is the session's
 * own title rather than a peer's label. It is the same order of thing, a short name a person typed
 * for a surface someone reads, and giving it a constant of its own would be two numbers nobody
 * would remember to keep in step. What it does not share is the counting below, because it measures
 * through `fit` rather than through this module's own reading.
 *
 * Code points rather than UTF-16 units, the unit every other bounded reading in this module counts
 * in, so one emoji in a display name costs one of this budget rather than two. Which makes the
 * bound a reading this module applies rather than a regex quantifier: an attribute pattern counts
 * units, so the bound is taken after the capture, on the string, exactly as `modelName` takes its
 * own.
 *
 * Exported because it is one bound over both shapes a peer message arrives in, and a pin that the
 * two paths agree about a name has to be able to build a name that is over it.
 */
export const MAX_PEER_NAME_LENGTH = 120;

/** The most characters an outbound message's one-line summary contributes. */
const MAX_PEER_SUMMARY_LENGTH = 300;

/**
 * How a peer session is addressed on the wire: a named pipe, the one stable sender key, and the
 * one field of a delivery that is infrastructure rather than anything an operator reads.
 *
 * It renders nowhere, so a reading that finds one where a display name belongs treats the name as
 * absent. Live `SendMessage` calls really do address a peer by this string when the sender has no
 * display name for it, and drawing it would put a pipe address where a thread's reader is looking
 * for the counterparty they know by name.
 */
const PEER_ADDRESS_SCHEME = "uds:";

/**
 * One field of a peer message: the string it was written as, or null when there is nothing there.
 *
 * Absent, non-string, and empty once the invisible class is stripped and the rest trimmed all read
 * as nothing, `askedQuestions`' rule that a field the surface would draw blank is not a field. What
 * is returned is the string as it was written rather than the stripped reading the test was made
 * on: peer text is untrusted content of the same class as a mirrored reply, neutralized at the
 * render site the way an option label is, and this reader's job is only to decide whether there is
 * anything to render.
 *
 * No bound here, because the fields this gates divide into two kinds that take two different ones.
 * A message body is the content itself and is bounded where a mirrored prompt is bounded, at the
 * render site that splits it across messages; a name or a summary is a label and is bounded at the
 * read below, where being over the bound is a property of the field rather than of the surface.
 */
function peerField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return withoutInvisible(value).trim() === "" ? null : value;
}

/**
 * A peer message's body, or null when there is nothing readable in it.
 *
 * Trimmed, whichever shape it came out of. On the wrapper path the surrounding whitespace is the
 * harness's markup, the newlines it writes the body on its own lines with; on the structured path
 * there is usually none. Trimming both is what makes the two readings return the identical body for
 * one message, which is the property that keeps a thread from telling two stories about one
 * exchange depending on whether its session was busy when the message landed.
 */
function peerBody(value: unknown): string | null {
  const body = peerField(value);
  return body === null ? null : body.trim();
}

/**
 * A peer-written label, bounded: a counterparty's display name or an outbound summary, or null when
 * there is nothing usable there.
 *
 * A name is refused whole when it is over the bound rather than cut to it, `modelName`'s reasoning
 * about a model name exactly: half a display name names a counterparty nobody can look up, and the
 * fallback that replaces it says plainly that no usable name arrived. A pipe address is refused by
 * the same door, because it is a name for a machine rather than for a reader.
 */
function peerName(value: unknown): string | null {
  const name = peerField(value);
  if (name === null) return null;
  const written = withoutInvisible(name).trim();
  if (written.toLowerCase().startsWith(PEER_ADDRESS_SCHEME)) return null;
  return [...name].length > MAX_PEER_NAME_LENGTH ? null : name;
}

/**
 * Whether every surrogate code unit in a string has its partner, which is what makes the string
 * encodable as the UTF-8 a JSON request body is sent as.
 *
 * Written out rather than called as `String.prototype.isWellFormed`, which exists on the Node this
 * runs on but is typed only from the `es2024` library: reaching it would mean moving the whole
 * project's compiler target for one call, which is a larger change than this reading is worth.
 */
function isWellFormed(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      at += 1;
    }
  }
  return true;
}

/**
 * A `custom-title` line's `customTitle` field, normalized and bounded, or null when there is
 * nothing usable there.
 *
 * Deliberately not `peerName`'s refuse-whole answer to an over-bound value: a refused peer name
 * falls back to a readable placeholder the thread already knows how to draw, while a refused title
 * would mean the rename this work exists to surface silently never lands. So an over-bound title is
 * cut through `fit` rather than turned away. The two bounds are the same number and nothing else:
 * `peerName` counts code points and refuses whole, while `fit` holds the stricter of the code-point
 * and the UTF-16 count and cuts, so an astral character costs this reader two of the budget where it
 * costs a peer name one.
 *
 * An ill-formed value is refused outright, which is the one place the refuse-whole answer is the
 * right one. A lone surrogate is in no character class any of the steps below strip: `isInvisible`
 * covers none of `0xd800` through `0xdfff`, `inertName` spreads by code point and keeps it whole,
 * `clean` strips only C0 and DEL, and `fit` only declines to create one. It would therefore reach a
 * `PATCH /channels/{threadId}` body that has to be valid UTF-8, where the rename is refused on every
 * pass and spends a bucket the exited title and the archive share. Nothing legitimate writes one:
 * the harness writes this line as a JSON string it built from the name a person typed, so an
 * ill-formed value is corruption or an append by something else, and dropping it keeps the name the
 * thread already has rather than painting a replacement character onto it.
 *
 * Every bound sits behind every strip, and the order is the whole substance of this function. The
 * normalization is `inertName`, which is what a thread name is drawn through at the render site:
 * it strips the invisible class and collapses runs of whitespace to one space. Only then are the
 * emptiness gate and the cut taken, on that one string. Measuring a bound ahead of a strip spends
 * it on characters nobody sees, and each of the three ways that goes wrong is a real title lost:
 * `clean`'s 256-unit cap taken first turns three hundred zero-width characters ahead of a name into
 * two hundred fifty-six zero-width characters and drops the rename outright; that same cap counts
 * UTF-16 units, so it can fall between the halves of an astral pair and put a lone surrogate on a
 * wire that ends in a JSON request body; and a name padded with a hundred and thirty spaces
 * otherwise stores five characters of name, a hundred and fourteen of padding and an ellipsis,
 * which the render collapses to `Build …` and the rest of the session's name is gone. Normalizing
 * first is also what keeps the gate and the cut answering about the same text, so a title that
 * passes the gate cannot still cut to nothing a reader can see.
 *
 * This bound is not the last one the value meets, and it is not meant to be: `threadName` cuts the
 * composed name again to what is left of the hundred-character thread-name budget after the glyph
 * and the state suffix, which is under ninety. What this one buys is that the value the record
 * carries and the value the surface persists are bounded before they are stored, rather than only
 * on the way out.
 *
 * `clean` is kept for the repo-wide rule that a stored display string is cleaned before it is
 * bounded. Behind `inertName` it changes no value: the control class it strips is a subset of the
 * invisible class already gone, and its 256-unit cap sits outside the tighter bound taken next.
 *
 * What this cannot promise is that the result draws as anything. The invisible class is a class of
 * characters that render as nothing on every surface, not of every character that happens to draw
 * blank in some font: the Hangul filler and the Braille blank pattern are ordinary printable
 * characters and survive, here and at the render site alike. A title made only of those reads as an
 * empty thread name to a person and as a set title to this reader, which is the shared class's
 * limit rather than a gap in this gate, and widening the class here would put the two surfaces that
 * share it out of step.
 */
function customTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!isWellFormed(value)) return null;
  const written = clean(inertName(value));
  return written === "" ? null : fit(written, MAX_PEER_NAME_LENGTH);
}

/**
 * The peer message a `queued_command` attachment's structured `origin` carries, or null when that
 * origin is not a peer delivery at all.
 *
 * The harness's contract, not this project's: an `origin` object whose `kind` is `peer`, whose
 * `body` holds the message's own text with no wrapper markup around it, and whose `name` holds the
 * sender's chosen display name. Read from those fields rather than from the sibling `prompt`, which
 * carries the same message inside the `<cross-session-message>` wrapper: structured fields need no
 * markup parsing, so nothing a peer writes inside its own message can move what this reads. The
 * `from` pipe address, `msg_id`, `hopChain` and `fromMode` are read by nobody: none of them is
 * actionable from a thread.
 *
 * An origin that names a peer delivery and carries no readable body is still a delivery, and reads
 * as one under `PEER_BODY_UNREADABLE`, exactly as the wrapper reading answers the same message. The
 * two shapes one message arrives in are read in two places, so they are held to one answer here: a
 * message this broker cannot make out is a visible placeholder whether it landed while the session
 * was idle or while it was working, rather than a placeholder on one and silence on the other. Only
 * the gate above is silence, and it is the honest one: an origin that is not a peer delivery is not
 * this reader's line.
 *
 * The failure direction is silence. A harness revision that moves this shape leaves a peer message
 * delivered to a busy session reaching the thread nowhere, visible at the console alone. Observable
 * on any exchange, and not an action.
 */
function peerDelivery(origin: unknown): { name: string; body: string } | null {
  if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return null;
  const fields = origin as Record<string, unknown>;
  if (fields["kind"] !== "peer") return null;
  return {
    name: peerName(fields["name"]) ?? PEER_NAME_FALLBACK,
    body: peerBody(fields["body"]) ?? PEER_BODY_UNREADABLE,
  };
}

/**
 * The outbound peer message a `SendMessage` `tool_use` block's `input` holds, or null when nothing
 * renderable is in it.
 *
 * `message` carries the weight, on `askedQuestions`' rule about a question: a call whose message is
 * unreadable is a call this reader cannot report faithfully, so it yields nothing rather than an
 * attribution line over an empty body. `to` falls back by `PEER_NAME_FALLBACK`, the pipe address
 * live calls address an unnamed peer by included, and `summary` is genuinely optional, a shape this
 * reader meets rather than a failure, so an unreadable one reads as absent. The summary is cut to
 * its bound rather than refused, unlike a name: it is a sentence about the message, and the front
 * of one still says what the message was about.
 *
 * The input carries duplicate aliases beside those three, `type` naming the message class,
 * `recipient` duplicating `to` and `content` duplicating `message`. Three fields are read and the
 * rest ignored, so an alias moving upstream costs nothing.
 *
 * What is read is the call, so what is reported is the attempt: a send whose `tool_result` came
 * back an error renders as sent. The result lands on a later transcript line and this reader is
 * per-line, so nothing here can see it, and the correlation machinery that could is a standing cost
 * against a rare case the thread's own next lines usually explain. The read of the result would add
 * little even then: its success does not distinguish queued from delivered.
 *
 * The failure direction is silence, the same one `peerDelivery` carries: a shape move leaves an
 * outbound message invisible on the thread while the status card's tool preview still names the
 * call.
 */
function peerSend(input: unknown): { to: string; summary: string | null; message: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  const message = peerBody(fields["message"]);
  if (message === null) return null;
  const summary = peerField(fields["summary"]);
  return {
    to: peerName(fields["to"]) ?? PEER_NAME_FALLBACK,
    summary: summary === null ? null : fit(summary, MAX_PEER_SUMMARY_LENGTH),
    message,
  };
}

/**
 * How the Claude Code harness opens a peer message delivered to an idle session, in the two shapes
 * one is written in: the wrapper element itself, and the prose preamble the harness writes in front
 * of the wrapper.
 *
 * The harness's contract, not this project's, like `TASK_NOTIFICATION` in the routing layer: an
 * external shape that can change without notice. Both failure directions now reach past attribution,
 * because the routing layer reads this classification for two decisions rather than one: how the
 * text is drawn, and whether it stamps engagement.
 *
 * A shape move that stops this matching costs a delivery its own attribution, leaving it drawn in
 * the operator's quoted register carrying the wrapper markup as the operator's own words, and it
 * also restores the stamp: a peer message would again clear a standing blocked state that exists to
 * wait on a person. The first is read off the thread at a glance; the second is silent, and it is
 * the defect this reading exists to close.
 *
 * A false positive, a prompt the operator really typed that this reads as a delivery, costs three
 * things. Under `full` and `brief` it is drawn under the peer attribution, and where the prompt also
 * carries a whole wrapper for the extraction to fail on, under the placeholder body. Under `off` it
 * is dropped: the operator's own words never reach the thread, and the routing layer's drop line is
 * the only trace. And on every setting the engagement stamp is withheld, so a standing blocked state
 * does not clear on words a person really typed.
 *
 * That is why the classification is a prefix match on the harness's own opening rather than anything
 * looser: what an operator types does not open with this.
 *
 * The wrapper literal deliberately stops before the attribute list, on `TASK_NOTIFICATION`'s
 * reasoning exactly: the tag is never written bare, so matching the tag name alone is what survives
 * a harness revision that adds an attribute. The preamble is matched whole because it is a
 * sentence, and half a sentence is a prefix an operator could type.
 */
const CROSS_SESSION_WRAPPER = "<cross-session-message";
const CROSS_SESSION_PREAMBLE = "Another Claude session sent a message:";

/**
 * One cross-session wrapper, read as one match: its attribute region, then its body.
 *
 * Sticky rather than searching, and run only at the opening the classification found, which is what
 * makes the reading the harness's own tag rather than any tag. A searching pattern restarts at
 * every later occurrence of the literal, and a peer writes its own body, so it can plant an
 * occurrence there and be found by the restart: the attribution of the message would then be the
 * one its own sender chose to plant. It is also what keeps the cost linear on hostile text, since a
 * restart at every occurrence of a literal a sender can repeat is quadratic in the length they
 * choose.
 *
 * The attribute region admits `>` inside a quoted value and nowhere else, so a display name
 * containing one closes at its own quote instead of ending the tag early and spilling the harness's
 * remaining attributes into the body. The body is taken non-greedily between that one opening and
 * the first close, `COMMAND_NAME`'s discipline: markup a message quotes inside its own body is
 * content, so it can truncate what this reads and never re-aim it.
 *
 * Sticky patterns carry their own `lastIndex`, so this one is positioned at every use rather than
 * reused as it was left.
 */
const CROSS_SESSION_MESSAGE = new RegExp(
  `${CROSS_SESSION_WRAPPER}((?:[^">]|"[^"]*")*)>([\\s\\S]*?)</cross-session-message>`,
  "y",
);

/** The sender's chosen display name, read out of one wrapper's own attribute region. */
const CROSS_SESSION_FROM_NAME = /from-name="([^"]*)"/;

/**
 * A peer message read out of the text one was delivered to an idle session in: the counterparty it
 * came from, the body to draw, and whether that body is the message's own or the placeholder that
 * stands in for one this reader could not make out.
 *
 * The routing layer deliberately does not read `readable`: both states render identically, under the
 * peer attribution and under the peer setting, and a branch on this flag is the hole it looks like a
 * safety valve for. A peer writes its own body, so it chooses whether that body parses; any path
 * reserved for the unreadable case is therefore a path a peer can select, and the one worth
 * selecting is the operator's quoted register. The flag is carried for a reader that wants to say
 * less about an unreadable delivery than about a readable one without taking it somewhere else.
 */
export type CrossSessionDelivery = { name: string; body: string; readable: boolean };

/**
 * What a prompt is carrying when it is a peer message delivered to an idle session: null when the
 * prompt is no such delivery, and otherwise the message, marked with whether its body could be
 * read.
 *
 * Three states rather than two, and the third is the load-bearing one. A delivery whose body this
 * reader cannot make out is still a delivery, and returning null for it would hand a peer's own
 * text back to the caller as an ordinary prompt, to be drawn in the operator's quoted register: a
 * peer that writes a body this cannot read would hold the switch on the one attribution this
 * surface keeps unforgeable. So `readable` false still names the counterparty and still renders
 * under the peer attribution, with `PEER_BODY_UNREADABLE` where the body would be.
 *
 * One reading for both paths a peer message reaches a thread by, so the two cannot answer
 * differently for one message: the transcript tailer sees the structured origin and reads it
 * through `peerDelivery`, while the prompt path sees text alone, because the `UserPromptSubmit`
 * payload carries the prompt string and nothing else.
 *
 * Classified on the invisible-stripped, trim-started prefix, `isTaskNotification`'s reasoning
 * exactly: a zero-width character in front of the marker changes nothing a reader sees, so it must
 * not be what decides the attribution, and only the opening counts, so a prompt quoting the wrapper
 * mid-text is the operator typing about it. Extraction then runs on the raw text at the first
 * occurrence of the opening literal, which under that classification is the harness's own opening:
 * the preamble in front of it is prose with no tag in it. Markup that an invisible strip would have
 * to repair therefore reads as unreadable rather than as a guess at what it meant.
 *
 * Classified text carrying no opening tag at all is no delivery, the one case that goes back to the
 * caller as an ordinary prompt: every real delivery carries the wrapper, so what this admits is an
 * operator opening their own prompt with the preamble sentence, whose words are then their own on
 * the thread rather than a placeholder. No peer can reach it, since the harness writes the wrapper
 * around whatever a peer sends.
 *
 * The preamble in front of the wrapper and the harness's advisory paragraph behind it are dropped
 * with everything else outside the tags: neither is the peer's message.
 */
export function crossSessionDelivery(text: string): CrossSessionDelivery | null {
  const opening = withoutInvisible(text).trimStart();
  if (
    !opening.startsWith(CROSS_SESSION_WRAPPER) &&
    !opening.startsWith(CROSS_SESSION_PREAMBLE)
  ) {
    return null;
  }
  const at = text.indexOf(CROSS_SESSION_WRAPPER);
  if (at === -1) return null;
  CROSS_SESSION_MESSAGE.lastIndex = at;
  const wrapper = CROSS_SESSION_MESSAGE.exec(text);
  if (wrapper === null) {
    return { name: PEER_NAME_FALLBACK, body: PEER_BODY_UNREADABLE, readable: false };
  }
  const attribute = CROSS_SESSION_FROM_NAME.exec(wrapper[1] ?? "");
  const name = (attribute === null ? null : peerName(attribute[1])) ?? PEER_NAME_FALLBACK;
  const body = peerBody(wrapper[2]);
  return body === null
    ? { name, body: PEER_BODY_UNREADABLE, readable: false }
    : { name, body, readable: true };
}

/** The three usage figures that add up to the context a turn ran against. */
const CONTEXT_FIELDS: readonly string[] = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

/**
 * A model name off a transcript line: stripped of the invisible class, trimmed, and refused whole
 * when it is empty or past the display bound. Refused rather than truncated, on `renderTaskNotice`'s
 * reasoning about an id: half a model name names no model, and a line that cannot say which model
 * ran it says nothing this reader stores.
 */
function modelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = withoutInvisible(value).trim();
  if (name === "" || [...name].length > MAX_MODEL_NAME_LENGTH) return null;
  return name;
}

/**
 * One of a downgrade record's short words, the refusal category or the consent answer. Absent,
 * empty once stripped and trimmed, or past its bound all read as null, which renders as the clause
 * being left off: an entitlement record genuinely carries no category, so absence is a shape this
 * reader meets rather than a failure.
 */
function fallbackDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const detail = withoutInvisible(value).trim();
  if (detail === "" || [...detail].length > MAX_MODEL_DETAIL_LENGTH) return null;
  return detail;
}

/**
 * The three input figures of one request's usage object, summed. Null unless every one of them is
 * present as a finite, non-negative number, so a shape that grew a field or renamed one
 * contributes nothing rather than a total that is quietly short. The per-field finiteness check
 * keeps `1e999`, which JSON.parse reads as Infinity, out of the sum; the check on the total is its
 * own lock, because three individually finite figures near the top of the double range still add
 * to Infinity.
 */
function summedContextFields(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  let total = 0;
  for (const field of CONTEXT_FIELDS) {
    const entry = fields[field];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) return null;
    total += entry;
  }
  if (!Number.isFinite(total)) return null;
  return total;
}

/**
 * The context a turn ran against.
 *
 * A turn that took several internal iterations carries a `usage.iterations` array, and the
 * top-level cache figures are then sums across those iterations rather than any single request's,
 * while `input_tokens` is not aggregated the same way, so no arithmetic on the top level recovers
 * the real figure. The reading there is one iteration outright: the largest, not the last. The
 * two are identical on every observed row, but a turn ending on a small internal call would make
 * the last entry understate the context, and the largest can only overstate by the iterations'
 * spread. The kit's compaction gate reads the same rule for the same reason (`consumedFromUsage`
 * in its `kit-compact-gate.js`), so this card and that gate cannot read one row two ways.
 *
 * One unreadable iteration makes the whole reading illegible rather than being skipped, so a
 * malformed array cannot quietly narrow the set being maximized. A turn without the array, which
 * is every single-iteration turn, reads the top level: there it is the request itself.
 */
function contextTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const fields = usage as Record<string, unknown>;
  const iterations = fields["iterations"];
  if (Array.isArray(iterations) && iterations.length > 0) {
    let largest: number | null = null;
    for (const entry of iterations) {
      const sum = summedContextFields(entry);
      if (sum === null) return null;
      if (largest === null || sum > largest) largest = sum;
    }
    return largest;
  }
  return summedContextFields(usage);
}

/** The two system subtypes that record a forced downgrade, and which path each one is. */
const FALLBACK_CAUSES: Readonly<Record<string, ModelFallbackCause>> = {
  model_refusal_fallback: "refusal",
  model_consent_fallback: "consent",
};

/**
 * What one transcript line contributes, decided by an allowlist and never a denylist. Five line
 * shapes yield anything, and all must first not be a sidechain and must name in `sessionId` the
 * session this transcript was learned for.
 *
 * An `assistant` line also yields a model reading when it names a model and its `message.usage`
 * carries all three context figures. The reading is the card's, not the thread's: nothing about it
 * is posted as content, and a line missing either half yields no reading while the narration on the
 * same line is unaffected.
 *
 * A `system` line yields a forced downgrade when its `subtype` is one of the two upstream writes
 * for one and it names both models. `model_refusal_fallback` is the safeguard path and carries an
 * `apiRefusalCategory`; `model_consent_fallback` is the entitlement path, which carries a `choice`
 * and no category at all, so a reader keyed to the refusal record's fields would miss the one an
 * operator can act on.
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
 * console while the model was working, which fires no hook and writes no user line, and it carries
 * `source: "queued"` for that reason: with no second copy anywhere, it stays out of the prompt
 * dedup on both sides. Where the same words do appear as both a queued prompt and a typed user
 * line, they are two submissions the operator made separately, a queued message and a later
 * retype, rather than one message the transcript wrote twice: each carries its own copy and each
 * is owed its own place on the thread.
 *
 * The narrower clauses are each load-bearing against a real line: `task-notification` is the mode
 * of the machine-written background-task notices that make up the bulk of `queued_command` lines,
 * `origin.kind` `channel` is the harness's injection of a message the operator posted in the
 * thread itself, and a `prompt` that is an object rather than a string carries pasted image
 * references rather than prose.
 *
 * A `user` line yields a goal when its content carries the console-command markup and the command
 * named in it is `/goal`. One command by allowlist, never a sweep: a command's arguments are
 * operator prose, and most of it is nobody's business on a surface that leaves the machine. What is
 * yielded is the goal's own text, or null for the explicit `/goal clear`.
 *
 * A `custom-title` line yields a title when its `customTitle` field reads as a usable string once
 * normalized: Claude Code writes this line both for a launch `--name` and for an in-session
 * `/rename`, with no way to tell the two apart from the line alone, and either one is the harness's
 * own record of the session's title. A value that reads as nothing, whether because it is not a
 * string or because it is empty once cleaned, yields no item at all: unlike the goal, whose `null`
 * is an explicit clear the operator typed, an unreadable title has no clear to make, and the item
 * is narrowed to carry only a real string for exactly that reason.
 *
 * A `user` line also yields a prompt when it is the typed prompt that opened a turn, read through
 * `typedPromptText`: the same `prompt` kind the queued attachment below yields, so both reach the
 * thread by one path, distinguished only by `source`. The `UserPromptSubmit` mirror normally posts
 * this text first and the echo memory's prompt pair is what keeps the two copies to one in the
 * thread; this reading is what makes the prompt survive a mirror hook the harness timed out under
 * load, which is otherwise the one mirror loss nothing heals. The two readings of a `user` line are
 * independent, so a line that satisfied both would yield both.
 *
 * A peer message delivered to an idle session is a user line too, carrying the wrapper text in its
 * content and the same structured `origin` the attachment below carries. It yields nothing, on both
 * counts that matter: it fires the prompt hook, so the mirror path posts it and a second reading
 * here would put the message on the thread twice, and its content is text a peer wrote, which the
 * goal read above refuses to take a command out of. Three of the prompt reading's own tests refuse
 * it independently, which is what keeps that no-double-post rule standing.
 *
 * A line yields an inbound peer message when it is that same `queued_command` attachment shape and
 * its `origin.kind` is `peer` instead of `human`: the message another session sent this one while
 * the model was working, which the harness queues and injects without firing a prompt hook. What is
 * yielded is `peerDelivery`'s reading of the structured origin, never the wrapper-wrapped copy the
 * `prompt` field carries beside it. A line yields an outbound peer message when its `type` is
 * `assistant` and a block in `message.content` is a `tool_use` block naming `SendMessage`, read
 * through `peerSend`. The two together are what puts a whole exchange on one thread: this session's
 * half of it is on its own transcript, and the counterparty's half arrives as the deliveries above.
 *
 * Everything else yields nothing: thinking blocks, tool calls other than those two, tool results,
 * attachments of other types, a `queued_command` whose `commandMode` is not `prompt`, withdrawn
 * queue entries, arrival records for a peer message that has not been delivered yet, system
 * lines, every other user line, and every line type this build has never seen. The transcript is another
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
 *
 * Exported for the tests that pin these readings against whole transcript lines in the shapes
 * Claude Code actually writes: what each line type contributes is this module's contract with an
 * external file format, and a reading taken of a hand-built object handed to one of the helpers
 * above cannot catch a gate two levels up admitting the wrong line.
 */
export function lineItems(line: string, sessionId: string): TailItem[] {
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
    const fields = message as Record<string, unknown>;
    const content = fields["content"];
    if (!Array.isArray(content)) return [];
    const items: TailItem[] = [];
    const model = modelName(fields["model"]);
    const context = contextTokens(fields["usage"]);
    if (model !== null && context !== null) {
      items.push({ kind: "model", reading: { model, contextTokens: context } });
    }
    for (const block of content) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      const fields = block as Record<string, unknown>;
      if (fields["type"] === "tool_use" && fields["name"] === "AskUserQuestion") {
        const questions = askedQuestions(fields["input"]);
        if (questions.length > 0) items.push({ kind: "question", questions });
        continue;
      }
      if (fields["type"] === "tool_use" && fields["name"] === "SendMessage") {
        const sent = peerSend(fields["input"]);
        if (sent !== null) {
          items.push({
            kind: "peer-out",
            to: sent.to,
            summary: sent.summary,
            message: sent.message,
          });
        }
        continue;
      }
      if (fields["type"] !== "text") continue;
      const text = fields["text"];
      if (typeof text === "string" && text !== "") items.push({ kind: "text", text });
    }
    return items;
  }
  if (record["type"] === "system") {
    const subtype = record["subtype"];
    // Object.hasOwn, never a bare index: FALLBACK_CAUSES is a plain object, so a bare lookup
    // answers prototype keys, and a subtype naming "constructor" or "__proto__" would pass the
    // undefined guard with a function or Object.prototype as its cause. The declared
    // Record<string, ...> type is what hides the need for this check: it types every string key
    // as present, so the compiler reads the guard below as dead while it is the only runtime lock.
    const cause =
      typeof subtype === "string" && Object.hasOwn(FALLBACK_CAUSES, subtype)
        ? FALLBACK_CAUSES[subtype]
        : undefined;
    if (cause === undefined) return [];
    const originalModel = modelName(record["originalModel"]);
    const fallbackModel = modelName(record["fallbackModel"]);
    // Both models or nothing: the card and the message are both about the pair, and a record naming
    // one of them describes a change this reader cannot report faithfully.
    if (originalModel === null || fallbackModel === null) return [];
    return [
      {
        kind: "fallback",
        fallback: {
          cause,
          originalModel,
          fallbackModel,
          category: fallbackDetail(record["apiRefusalCategory"]),
          choice: fallbackDetail(record["choice"]),
        },
      },
    ];
  }
  if (record["type"] === "custom-title") {
    // Claude Code writes this line for both a launch `--name` and an in-session `/rename`, with no
    // way to tell the two apart from the line alone; that is fine, because either one is the
    // harness's own record of the session's title and names the thread the same way. The line
    // carries no timestamp and is re-emitted many times across a session, so this reader answers
    // only "what does the line say right now" and lets the tailer's forward-only read handle when.
    // An unreadable value yields nothing at all, `goalCommand`'s own answer to a line it cannot
    // parse: the consumer's `null` is the operator's explicit clear on the goal seam, and this kind
    // carries no such clear, so a malformed line must not be able to read as one.
    const title = customTitle(record["customTitle"]);
    return title === null ? [] : [{ kind: "title", title }];
  }
  if (record["type"] === "user") {
    // The console-command markup is read only off a line the operator wrote at their own console.
    // Peer messages and the harness's own injections arrive as user lines too, carrying text this
    // broker did not write and its sender chose, and `COMMAND_NAME` matches that markup wherever in
    // a line it sits: without this gate a peer that writes the markup into its own message sets the
    // goal on the operator's status card, or clears it.
    if (!typedAtTheConsole(record)) return [];
    const text = userText(record["message"]);
    // Two readings of one line, neither of which may swallow the other: the goal card's and the
    // thread's. They are disjoint in practice, since a command line carries the markup the prompt
    // reading refuses, but that is a property of two independent tests rather than of the order
    // they run in, and an early return for either would make it the order's property instead.
    const items: TailItem[] = [];
    const goal = goalCommand(text);
    if (goal !== undefined) items.push({ kind: "goal", goal });
    const typed = typedPromptText(record);
    if (typed !== null) {
      items.push({ kind: "prompt", text: typed, source: "turn-open", at: lineInstant(record) });
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
    const peer = peerDelivery(origin);
    if (peer !== null) return [{ kind: "peer-in", name: peer.name, body: peer.body }];
    if ((origin as Record<string, unknown>)["kind"] !== "human") return [];
    const prompt = fields["prompt"];
    if (typeof prompt !== "string" || prompt === "") return [];
    return [{ kind: "prompt", text: prompt, source: "queued", at: lineInstant(record) }];
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
   *
   * The same baseline hides a downgrade record already in the file: a session whose fallback
   * landed before this tailer learned its path (a broker restarted after the downgrade is the
   * common case) shows no marker until the next record arrives. Inherent to tailing from now, the
   * cost of never republishing.
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
    // The primary give-up, and the first of this module's four offset jumps over unread bytes:
    // everything already in the file when a session is learned, or re-learned after a restart or a
    // mirror-off window, sits behind the baseline this probe is about to take and will never be
    // read, so a prompt claim standing for a line back there is one nothing here can answer. Taken
    // here at dispatch rather than where the read resolves, because the prompt that arms a session
    // claims in between: `allow` returns into the intake handler, whose delivery writes the mirror
    // claim before the probe's read settles, and a give-up at resolution would spend that claim
    // and post the operator's first prompt twice whenever its transcript line lands ahead of the
    // baseline. The cost of the earlier instant: a claim made inside the read's own window for a
    // line the baseline still jumps past survives this give-up and stands until the claim window
    // expires, which is the age bound's loss to cap rather than this jump's to close.
    options.echo.forgetPrompts(sessionId);
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
        // The prompt give-up for this jump runs at the dispatch above rather than beside this
        // write, so a claim made while the read was in flight survives the baseline it lands
        // beside.
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
      // The same baseline the probe writes, taken here for a probe that never resolved usefully,
      // and the second of this module's four offset jumps over unread bytes; the shrink below and
      // the skip below that are the other two. Each one is a promise that a prompt claim standing
      // for a line behind the new position will never be answered from here. A claim made for a
      // line still ahead of it is given up too, which costs one duplicate copy of that prompt; the
      // alternative is the loss this whole recovery exists to prevent, and the fail direction
      // throughout is the duplicate.
      options.echo.forgetPrompts(sessionId);
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
      options.echo.forgetPrompts(sessionId);
      repeats(
        `session ${sessionId}'s transcript shrank below the held offset`,
        `resuming from its current end at ${slice.size} bytes`,
      );
      return;
    }
    if (slice.size - held.offset > MAX_TAIL_READ_BYTES) {
      const skipped = slice.size - held.offset;
      held.offset = slice.size;
      options.echo.forgetPrompts(sessionId);
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
        // These four branches (model, fallback, goal, title) are taken first and synchronously:
        // none of them posts anything itself, so there is no await to re-check an epoch across, and
        // each is held to its own try/catch because a throw escaping here would abandon every chunk
        // behind it in this batch, whose bytes are already past the offset and cannot be read
        // again. The title note is the one whose value later reaches Discord, as the thread name a
        // separate repaint composes; the call made here still only feeds the record it is painted
        // from. The log line names the session and the failure and nothing else, the rule every
        // line in this module follows.
        if (item.kind === "model") {
          try {
            options.noteModel?.(sessionId, item.reading);
          } catch {
            repeats(
              `session ${sessionId}'s model reading could not be recorded`,
              "the reading is dropped; the error detail is withheld, it can carry content",
            );
          }
          continue;
        }
        if (item.kind === "fallback") {
          try {
            options.noteFallback?.(sessionId, item.fallback);
          } catch {
            repeats(
              `session ${sessionId}'s model downgrade could not be recorded`,
              "the record is dropped; the error detail is withheld, it can carry content",
            );
          }
          continue;
        }
        if (item.kind === "goal") {
          try {
            options.noteGoal?.(sessionId, item.goal);
          } catch {
            repeats(
              `session ${sessionId}'s goal could not be recorded`,
              "the goal is dropped; the error detail is withheld, it can carry content",
            );
          }
          continue;
        }
        if (item.kind === "title") {
          try {
            options.noteTitle?.(sessionId, item.title);
          } catch {
            repeats(
              `session ${sessionId}'s title could not be recorded`,
              "the title is dropped; the error detail is withheld, it can carry content",
            );
          }
          continue;
        }
        if (item.kind === "question") {
          // The questions the console held this session on, landing here at answer time because
          // Claude Code writes the line when the picker closes. The hook path usually alerted
          // this same question at emission and recorded its digest, so a match here is that one
          // duplicate, consumed as it is skipped; no digest means an unupgraded hook set or a
          // hook alert that never landed, and then this yield is the question's only signal,
          // delivered on the same one-await-per-item rule the other kinds follow. An alert that
          // could not be made is dropped and never retried, and the error is discarded unread,
          // because it can quote the question.
          //
          // This line exists because the picker closed, so the ask it names has been answered at
          // the console. Reported before the dedupe and independently of it: the outstanding set is
          // bounded and evicts, and a question whose alert is still on the operator's phone has to
          // stop saying it is waiting even when its digest was pushed out.
          let flipped = false;
          try {
            flipped = options.answeredAtConsole(sessionId, item.questions);
          } catch {
            repeats(
              `session ${sessionId}'s console-answer report failed`,
              "the question message is left as it stands; the error detail is withheld, " +
                "it can carry content",
            );
          }
          const outstanding = held.askedDigests.indexOf(questionDigest(item.questions));
          if (outstanding !== -1) {
            held.askedDigests.splice(outstanding, 1);
            continue;
          }
          // A flip is the report the operator already has: the ask's own message now says the
          // console answered it, and an alert for that same ask would post it into the same thread
          // as a question still waiting there, with the record the flip consumed gone and no second
          // flip left to correct it. A report that flipped nothing alerts, which is the evicted
          // digest this ordering exists for.
          if (flipped) continue;
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
          // thread between them. The shape rides along because the router branches on it: the echo
          // digest is claimed and released inside the router, where the count of messages that
          // landed is, the interim chunk's own arrangement, and only a turn-opening prompt has a
          // mirror copy for that to answer for.
          // A delivery that could not be made is dropped and never retried, and the error is
          // discarded unread, because it can quote the text.
          try {
            await options.deliverPrompt(sessionId, item.text, item.source, item.at);
            // Every point past an await re-checks the epoch it started under, the rule the rest of
            // this function follows: a suppress landing during this delivery stops the batch here
            // rather than publishing the items behind it.
            if (!stillValid()) return;
          } catch {
            repeats(
              `session ${sessionId}'s transcript-read prompt delivery failed`,
              "the prompt is dropped; the error detail is withheld, it can carry content",
            );
            if (!stillValid()) return;
          }
          continue;
        }
        if (item.kind === "peer-in" || item.kind === "peer-out") {
          // Peer traffic, in both directions. It is drawn under an attribution of its own rather
          // than as this session's narration, so it goes out through the router's peer doorway
          // instead of the chunk delivery below, on the same one-await-per-item rule the prompt
          // branch follows: a message sitting between two assistant lines reaches the thread
          // between them. No echo digest is recorded, because no other path posts this text. A
          // delivery that could not be made is dropped and never retried, and the error is
          // discarded unread, because it can quote the message.
          try {
            await options.deliverPeer(sessionId, item);
            // Every point past an await re-checks the epoch it started under, the rule the rest of
            // this function follows: a suppress landing during this delivery stops the batch here
            // rather than publishing the items behind it.
            if (!stillValid()) return;
          } catch {
            repeats(
              `session ${sessionId}'s peer message delivery failed`,
              "the message is dropped; the error detail is withheld, it can carry content",
            );
            if (!stillValid()) return;
          }
          continue;
        }
        // What is left is the assistant's own narration. The assignment is the check: a kind added
        // to the union without a branch of its own above stops being assignable to never, so the
        // build fails here rather than the kind going unrouted in silence.
        const narration: { kind: "text"; text: string } = item;
        const text = narration.text;
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
        // land is dropped, never kept for a later call, the rule the whole routing layer follows.
        // The echo digest is claimed and released inside the router, where the count of messages
        // that landed is, so this loop makes no write-back of its own past the await and has no
        // epoch to re-check for one: the claim is made at dispatch, when this pass was valid, and
        // a suppressed session's whole entry is dropped by `forget` and `sweep` regardless. The
        // catch holds each failure to its own chunk: the consumed bytes are already behind the
        // offset, so a throw that escaped this loop would lose every later chunk in the batch with
        // no way to re-read them. The error is discarded unread; it can quote the text it failed
        // to post.
        try {
          await options.deliver(sessionId, text);
          if (!stillValid()) return;
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
