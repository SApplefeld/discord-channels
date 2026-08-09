// The question desk: holds a credited AskUserQuestion PreToolUse hook response open so the answer
// can arrive from the session's Discord thread instead of the console picker.
//
// While a PreToolUse hook response is held, the console shows the tool call waiting and renders no
// picker, so the held response body is the only answer channel that exists. Five triggers end a
// hold, all through one guarded resolution path so an entry resolves exactly once: answered (the
// response carries `permissionDecision: "allow"` with `updatedInput`, and the turn proceeds with
// the injected answers), released (a `{}` no-decision body, measured to render the picker normally
// in about a second), expired (the desk's own timer, the same `{}`), client gone (the response
// socket closed first, so nothing can be written), and shutdown (every held entry answered `{}`
// before the sockets are torn down). The fail direction throughout is the release: a lost hold
// must never eat a question, so every failure lands on today's behavior, an alerted phone and a
// console picker.
//
// This module's standing rule, shared with the tailer: no question content in any log line, ever.
// Log lines carry session IDs, counts, and states; never a question, an option, or an answer.
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AskedQuestion } from "./discord/render.ts";
import { MAX_INBOUND_TEXT_LENGTH } from "./routing/inbound.ts";
import { sliceCodePoints, withoutInvisible } from "./sanitize.ts";
import { questionDigest } from "./tail.ts";

/**
 * Most question holds open at once, across every session on this host.
 *
 * Bounded by count for the reason MAX_OPEN_REQUESTS is: a wall-clock eviction would quietly
 * release a question an operator is still reading. At the ceiling the newest post is refused
 * rather than the oldest released, and a refused post is answered immediately, which is exactly
 * today's behavior; a session parks on one question at a time, so sixteen is many hosts' worth of
 * headroom before the cap can matter.
 */
export const MAX_HELD_QUESTIONS = 16;

/**
 * Most responses one held entry carries, the retry ceiling.
 *
 * A retry attaches to the entry it matches rather than creating one, so the host-wide cap above
 * cannot bound it: without this ceiling a CLI reposting an identical question would pin a socket
 * per attempt for the whole hold. Past it the newest attempt is refused, which answers that post
 * immediately, the same fail direction the entry cap takes; the attempts already attached still
 * receive the answer.
 */
export const MAX_RESPONSES_PER_ENTRY = 4;

/**
 * How long shutdown waits for the released bodies to reach the wire before the sockets are torn
 * down. `closeAllConnections` destroys a socket, which drops a write still buffered, and the
 * session sees that as the connection reset the release exists to avoid. The wait is bounded, and
 * bounded over the whole set rather than per response, so one stuck socket cannot hold the
 * process open: past it the teardown proceeds and that one response degrades to a reset.
 */
const SHUTDOWN_FLUSH_MS = 1_000;

/**
 * How long a run of the same rate-limited log reason is aggregated before its next flush.
 *
 * The refused-retry line is the one line here a client can drive without limit: a CLI retrying past
 * an entry's response cap writes one per attempt for the life of a four-hour hold, which would push
 * every other line out through rotation. Local rather than shared with the tailer's limiter or the
 * intake's, the same rule those two follow: each layer holds its own log seam.
 */
const REPEAT_WINDOW_MS = 60_000;

/**
 * How a hold ended, for the terminal-state notifier.
 *
 * `answered-at-console` is the one state that arrives after the hold is already over: the response
 * was released to the console picker and the operator answered it there, which the transcript's own
 * resolution line reports minutes or hours later. It is a state of the thread message rather than of
 * a held response, and it is what stops that message from still saying a question is waiting at a
 * console that has already been answered.
 */
export type QuestionTerminalState =
  | "answered"
  | "answered-at-console"
  | "released"
  | "expired"
  | "client-gone"
  | "shutdown";

/**
 * What an answered hold injects, in the vocabulary Claude Code reads out of `updatedInput`:
 * `answers` maps exact question text to an option label (single-select) or an array of labels
 * (multi-select); `response` is a whole-ask free-form reply that replaces the per-question answers
 * entirely.
 */
export type QuestionAnswers =
  | { kind: "answers"; answers: Readonly<Record<string, string | readonly string[]>> }
  | { kind: "response"; response: string };

/**
 * Where a held entry's alert is, once one has been posted for it. The thread message this names is
 * the one every terminal state edits, and the one the components that answer the hold live on.
 */
export type QuestionAlert = { threadId: string; messageId: string };

/**
 * A held entry as the answering surface reads it: the opaque id its components are addressed by,
 * the ask itself, and the selections accumulated against it so far.
 *
 * Selections are the option labels the operator has chosen, one list per question in the ask's own
 * order, empty where nothing is chosen yet. Labels rather than positions, because a label is what
 * an answer is submitted as, and the two must not be able to disagree about which option was meant.
 */
export type QuestionEntryView = {
  id: string;
  sessionId: string;
  questions: readonly AskedQuestion[];
  /**
   * The payload's own `questions` array, verbatim. Read beside the bounded parse above by the
   * surface that decides whether this ask can be answered from the thread at all: the two are the
   * same ask only when the reader carried it whole, and an answered hold builds its map over the
   * parse while the session reads that map against this.
   */
  questionsInput: readonly unknown[];
  selections: ReadonlyArray<readonly string[]>;
  alert: QuestionAlert | null;
};

/** What a submit from the thread did. An incomplete one names the question still unanswered. */
export type QuestionSubmission =
  | { kind: "answered" }
  | { kind: "incomplete"; questionNumber: number }
  | { kind: "gone" };

/** The entry detail the terminal notifier needs to edit the ask's own message. */
export type QuestionTerminalDetail = {
  entryId: string;
  alert: QuestionAlert | null;
  questions: readonly AskedQuestion[];
  /** What an answered hold submitted; null under every other terminal state. */
  answers: QuestionAnswers | null;
};

export type QuestionDesk = {
  /**
   * Takes ownership of a held response. True means the caller must not write to that response
   * again, because the desk answers it at resolution or it is already dead; false means the desk
   * refused and the caller answers it exactly as it would have without a desk. A second post for
   * a session already held attaches to the same entry when its questions digest identically (the
   * CLI retrying one ask: both responses are answered the same way at resolution) and replaces
   * the entry when they do not (the older hold is released with `{}`; the newer ask is the one
   * still standing).
   *
   * `dispatched` reports whether this post's own alert went out. It gates the creation of an
   * entry and nothing else: a new hold with no alert behind it is a question parked where nobody
   * was told to look, while a retry attaching to a live entry rides the alert that entry already
   * has, which is exactly the shape the tailer's outstanding-digest dedupe produces.
   */
  hold: (
    sessionId: string,
    questions: readonly AskedQuestion[],
    questionsInput: readonly unknown[],
    response: ServerResponse,
    dispatched: boolean,
  ) => boolean;
  /**
   * Answers the session's held entry: a 200 whose body allows the tool call with the payload's own
   * questions passed back verbatim and the given answers injected. False when no entry is held,
   * which is a report and never a fault: the hold may have expired, been released, or lost its
   * socket while the answer was in flight.
   */
  resolve: (sessionId: string, answers: QuestionAnswers) => boolean;
  /**
   * Answers the session's held entry with the operator's own words, which replace the per-question
   * answers for the whole ask. The thread's typed-reply path: a message posted while a session's
   * question is held is that question's answer.
   *
   * Answers only an entry whose alert has landed, on the rule that gates entry creation: an ask
   * with no message in the thread is one the operator was never shown, so a message typed in that
   * window is talking about something else, and answering with it would put words the operator
   * never aimed at a question into the session's tool result with nothing in the thread saying so.
   * False there and false with nothing held, and either way the caller still has the message.
   *
   * The text is stripped of invisibles and cut to the inbound ceiling here as well as at the router
   * that reads it off Discord: this seam is where untrusted text enters a session's tool result, so
   * the bound is the desk's own rather than something a caller is trusted to have applied.
   */
  answerTyped: (sessionId: string, response: string) => boolean;
  /**
   * Reports that an ask this desk held was answered at the console, so its thread message stops
   * saying the question is still waiting there.
   *
   * Fed by the transcript's resolution-time yield, which lands when the picker closes: by then the
   * hold is over and the entry is gone, so what this reaches is the small record of recently closed
   * asks rather than a live entry. One-shot per ask, and it reports whether it found one. A session
   * still holding this ask answers false and is left standing: the console renders no picker under
   * a hold, so it cannot be the surface that answered.
   */
  answeredAtConsole: (sessionId: string, digest: string) => boolean;
  /**
   * Releases the session's held entry with `{}`, so the console picker renders normally.
   *
   * With a digest, the release is checked against the entry's own and a different ask's entry is
   * left standing. That check is what keeps the alert path's failure release honest: both
   * question paths share one delivery closure, so a failed delivery names a session, and without
   * the digest an unrelated ask's failure would end a hold whose own alert is up and answerable.
   * Without a digest it releases whatever that session holds, which is what shutdown and the
   * operator's own release mean.
   */
  release: (sessionId: string, digest?: string) => boolean;
  /**
   * The entry a session holds for one ask, or null when it holds none for that digest. The read
   * the alert path takes before it decides what to draw: the ask may have been replaced, released,
   * or refused while the notice was on its way to Discord.
   */
  held: (sessionId: string, digest: string) => QuestionEntryView | null;
  /**
   * Records where the alert for a session's held ask landed, and reports that entry's opaque id so
   * the caller can address its components. Null when the session holds no entry for that digest,
   * and null again when the entry already carries an alert: an entry has exactly one message its
   * components live on, and repointing it would strand the components already drawn on the first.
   */
  noteAlert: (sessionId: string, digest: string, alert: QuestionAlert) => string | null;
  /** The held entry an opaque component id names, or null when nothing holds it any longer. */
  entry: (entryId: string) => QuestionEntryView | null;
  /**
   * Records the options chosen for one question of a held ask, replacing whatever that question
   * held before: a select reports its whole selection on every change, so the last report is the
   * answer. Option positions rather than labels cross this seam, and the entry resolves them
   * against its own copy of the ask, so a forged or stale position selects nothing rather than
   * submitting a label the picker never offered.
   */
  select: (
    entryId: string,
    questionIndex: number,
    optionIndexes: readonly number[],
  ) => QuestionEntryView | null;
  /**
   * Answers the entry from the thread with what it has accumulated. An ask with a question still
   * unanswered submits nothing and names that question, because a partial answer would commit the
   * session to picks the operator did not make.
   */
  submit: (entryId: string) => QuestionSubmission;
  /**
   * Releases the entry an opaque component id names, so the console picker renders: the
   * Answer-at-console button. Digest-checked through the entry itself, so a stale id whose ask has
   * been replaced releases nothing.
   */
  releaseEntry: (entryId: string) => boolean;
  /**
   * Releases every held entry with `{}`, then waits, briefly and boundedly, for those bodies to
   * reach the wire. Shutdown's half: the socket teardown that follows destroys connections, and a
   * body still buffered when its socket is destroyed is dropped, which the session sees as a
   * connection reset rather than the clean release.
   */
  releaseAll: () => Promise<void>;
};

export type QuestionDeskOptions = {
  /** How long an entry is held before the desk's own timer releases it. */
  holdMs: number;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
  /**
   * Told each entry's terminal state once, after the response is answered (or found unanswerable).
   * This is the message-edit seam: the detail carries where the ask's own message is and what was
   * submitted, so the editor rewrites that message and strips its components. The desk never lets a
   * throw out of it reach the response path.
   */
  onTerminal?: (
    sessionId: string,
    state: QuestionTerminalState,
    detail: QuestionTerminalDetail,
  ) => void;
  /** Injected so a test drives expiry without sleeping. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

type HeldEntry = {
  /**
   * The opaque token every component that answers this entry is addressed by. Minted at random per
   * entry, never derived from the session, the digest, or the ask: a `custom_id` travels to
   * Discord and back through anyone who can see the message, so it must name nothing and predict
   * nothing. It is a lookup key into this map and is meaningless once the entry is gone.
   */
  id: string;
  /**
   * The tailer's own digest of the bounded parse, so a retry attaches to the ask it repeats and a
   * digest-checked release matches the ask it was asked about.
   */
  digest: string;
  /** The bounded parse, which the answering surface draws and resolves option positions against. */
  questions: readonly AskedQuestion[];
  /** The labels chosen so far, one list per question in the ask's order. */
  selections: string[][];
  /** Where this ask's alert landed, once one has; null until the post comes back with an id. */
  alert: QuestionAlert | null;
  /**
   * The payload's own `questions` array, verbatim. An answered hold passes it back inside
   * `updatedInput`, because Claude Code re-reads the whole tool input from the response and a
   * rebuilt array would hand the tool an input the session never wrote.
   */
  questionsInput: readonly unknown[];
  /** Usually one. A digest-matching retry attaches its response here, answered identically. */
  responses: ServerResponse[];
  timer: NodeJS.Timeout;
};

/**
 * How many rate-limited reasons are held before the closed ones are swept. A reason carries a
 * session id, so without the sweep the map would grow by one entry per session this desk ever
 * refused a retry for.
 */
export const MAX_REPEAT_KEYS = 64;

/**
 * How many closed asks are remembered for the console-answer flip, oldest evicted.
 *
 * A record outlives its entry only to name the message a later console answer rewrites, and the
 * window between a release and that answer is one operator walking to a keyboard. Small on purpose:
 * the record holds question text, which is content, so it is bounded the way every other content
 * this module touches is. Past the bound the oldest record is dropped, whose cost is a thread
 * message left reading "answer it at the console" for a question already answered, never a lost
 * question.
 */
export const MAX_CLOSED_ASKS = 8;

/**
 * A hold that ended with its thread message telling the operator to answer at the console.
 *
 * The console answer arrives long after the entry is gone, and the message it has to rewrite is the
 * one the entry carried, so what the edit needs outlives the entry here: the ask's identity
 * (session and digest), the message, and the questions the edit renders. An answered hold records
 * nothing, because the thread already carries its answer and the console never rendered a picker.
 */
type ClosedAsk = {
  sessionId: string;
  digest: string;
  entryId: string;
  alert: QuestionAlert;
  questions: readonly AskedQuestion[];
};

/**
 * Rate-limits a repeating log line by its reason, which carries the session and the cause and
 * nothing that varies per repeat.
 *
 * The first of a reason is written at once; a repeat inside the window is counted, and the count
 * rides on the next line that window admits. The same shape the tailer's limiter has, held locally
 * for the same reason it holds one: each layer owns its own log seam.
 */
function createRepeatLog(
  log: (message: string) => void,
  now: () => number,
): (reason: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (reason) => {
    const at = now();
    const entry = state.get(reason);
    if (entry !== undefined && at - entry.windowStart < REPEAT_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    if (entry !== undefined && entry.suppressed > 0) {
      log(
        `question desk: ${reason} occurred ${String(entry.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS)}ms`,
      );
    }
    log(`question desk: ${reason}`);
    state.set(reason, { windowStart: at, suppressed: 0 });
    if (state.size <= MAX_REPEAT_KEYS) return;
    // Oldest closed window first, and whatever it still owes is written on the way out. A reason
    // carries a session id, so an entry left in the map because it owes a count is one only that
    // same session could ever flush, and a session that tripped the cap and went away never will:
    // the map would then grow by one for the life of the process. The open windows are left alone,
    // where the count riding on the next line of a reason is still the reason's to report.
    const closed = [...state]
      .filter(([, kept]) => at - kept.windowStart >= REPEAT_WINDOW_MS)
      .sort(([, left], [, right]) => left.windowStart - right.windowStart);
    for (const [key, kept] of closed) {
      if (state.size <= MAX_REPEAT_KEYS) return;
      if (kept.suppressed > 0) {
        log(
          `question desk: ${key} occurred ${String(kept.suppressed)} more time(s) in the last ` +
            `${String(REPEAT_WINDOW_MS)}ms`,
        );
      }
      state.delete(key);
    }
  };
}

export function createQuestionDesk(options: QuestionDeskOptions): QuestionDesk {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const held = new Map<string, HeldEntry>();
  // Where a component id lands. A second map rather than a scan of `held`, because every
  // interaction arrives holding an id and nothing else, and both maps are written and cleared
  // together in `settle` and in the close watcher.
  const byId = new Map<string, string>();
  // Oldest first: records are appended as their holds close and the transcript's resolution lines
  // arrive in that same order, so the search runs from the front and the oldest unspent record is
  // what a console answer flips. Eviction past the bound is the matching shift.
  const recentlyClosed: ClosedAsk[] = [];
  const repeats = createRepeatLog(log, now);

  function view(entry: HeldEntry, sessionId: string): QuestionEntryView {
    return {
      id: entry.id,
      sessionId,
      questions: entry.questions,
      questionsInput: entry.questionsInput,
      // Copied rather than handed over: a view is what the answering surface renders from, and the
      // entry goes on accumulating behind it, so a shared array would redraw a message from
      // selections that arrived after the read it is drawing.
      selections: entry.selections.map((chosen) => [...chosen]),
      alert: entry.alert,
    };
  }

  /** The held entry a component id names, with the session it belongs to. */
  function located(entryId: string): { sessionId: string; entry: HeldEntry } | null {
    const sessionId = byId.get(entryId);
    if (sessionId === undefined) return null;
    const entry = held.get(sessionId);
    if (entry === undefined || entry.id !== entryId) return null;
    return { sessionId, entry };
  }

  function notifyTerminal(
    sessionId: string,
    digest: string,
    state: QuestionTerminalState,
    detail: QuestionTerminalDetail,
  ): void {
    // Every state that leaves the operator a question to answer at the console is remembered, so
    // the console's own answer can rewrite the message this state is about to write. An answered
    // hold leaves nothing to answer, and the console-answer flip itself is already the last word on
    // that message.
    if (state !== "answered" && state !== "answered-at-console" && detail.alert !== null) {
      recentlyClosed.push({
        sessionId,
        digest,
        entryId: detail.entryId,
        alert: detail.alert,
        questions: detail.questions,
      });
      if (recentlyClosed.length > MAX_CLOSED_ASKS) recentlyClosed.shift();
    }
    try {
      options.onTerminal?.(sessionId, state, detail);
    } catch {
      // The detail is discarded unread: the notifier edits a message that renders question text,
      // and a throw out of it can quote that text.
      log(
        `question desk: the terminal-state notifier failed for session ${sessionId}; ` +
          "the error detail is withheld, it can carry content",
      );
    }
  }

  /**
   * Writes one held response, guarding every step: the socket can die between the liveness check
   * and the write, and a throw here would cross back into the intake's response path, whose catch
   * writes a 500 over a response this desk owns.
   */
  function respond(sessionId: string, response: ServerResponse, body: unknown): void {
    try {
      if (response.writableEnded || response.destroyed) return;
      const text = JSON.stringify(body);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      response.end(text);
    } catch {
      // The socket death stands; the question is still whole at the console. The error detail is
      // discarded because a write error can quote the body, and the body carries answers.
      log(`question desk: could not answer session ${sessionId}'s held response; the socket is gone`);
    }
  }

  /**
   * The single resolution path every trigger ends in. Removing the entry before anything is
   * written is the exactly-once guard: a second trigger, however it races in (an answer landing
   * during expiry, a release crossing a close), finds nothing held and resolves nothing.
   */
  function settle(
    sessionId: string,
    state: QuestionTerminalState,
    body: unknown | null,
    answers: QuestionAnswers | null = null,
  ): boolean {
    const entry = held.get(sessionId);
    if (entry === undefined) return false;
    held.delete(sessionId);
    byId.delete(entry.id);
    clearTimer(entry.timer);
    if (body !== null) {
      for (const response of entry.responses) respond(sessionId, response, body);
    }
    log(`question desk: session ${sessionId}'s question hold ended: ${state}`);
    notifyTerminal(sessionId, entry.digest, state, {
      entryId: entry.id,
      alert: entry.alert,
      questions: entry.questions,
      answers,
    });
    return true;
  }

  /**
   * Waits for written responses to reach the wire, under one bounded wait for the whole set. A
   * response that has already finished, or whose socket is gone, contributes no wait; `finish`
   * and `close` are both accepted per response, because a socket that dies mid-flush is as
   * finished as this desk can make it and emits only the second.
   */
  function flushed(responses: readonly ServerResponse[]): Promise<void> {
    const pending = responses.filter(
      (response) => !response.writableFinished && !response.destroyed,
    );
    if (pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let left = pending.length;
      let timer: NodeJS.Timeout | null = null;
      const finish = (): void => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        resolve();
      };
      for (const response of pending) {
        let counted = false;
        const settled = (): void => {
          if (counted) return;
          counted = true;
          left -= 1;
          if (left === 0) finish();
        };
        response.once("finish", settled);
        response.once("close", settled);
      }
      timer = setTimer(finish, SHUTDOWN_FLUSH_MS);
    });
  }

  /**
   * The client-gone trigger, per response: an un-reinstalled host's short hook timeout closes the
   * socket under every hold, and the desk has to notice rather than sit on a response nothing is
   * reading. The response's own `close` also fires after the desk's write, so membership in a
   * still-held entry is what distinguishes a death from a completion.
   */
  function watch(sessionId: string, response: ServerResponse): void {
    response.once("close", () => {
      const entry = held.get(sessionId);
      if (entry === undefined) return;
      const at = entry.responses.indexOf(response);
      if (at === -1) return;
      entry.responses.splice(at, 1);
      if (entry.responses.length > 0) return;
      held.delete(sessionId);
      byId.delete(entry.id);
      clearTimer(entry.timer);
      log(`question desk: session ${sessionId}'s held response closed before resolution`);
      notifyTerminal(sessionId, entry.digest, "client-gone", {
        entryId: entry.id,
        alert: entry.alert,
        questions: entry.questions,
        answers: null,
      });
    });
  }

  /**
   * The answered trigger, shared by the resolve seam and the thread's own Send: one place composes
   * the measured allow body, so the two cannot come to disagree about the wire shape.
   */
  function resolveHold(sessionId: string, answers: QuestionAnswers): boolean {
    const entry = held.get(sessionId);
    if (entry === undefined) return false;
    // The measured wire shape: a 2xx whose hookSpecificOutput allows the call and rewrites its
    // input skips the picker entirely, and the turn proceeds showing the injected answers as the
    // operator's picks. `response` replaces the per-question answers whole.
    const updatedInput =
      answers.kind === "answers"
        ? { questions: entry.questionsInput, answers: answers.answers }
        : { questions: entry.questionsInput, response: answers.response };
    return settle(
      sessionId,
      "answered",
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      },
      answers,
    );
  }

  /** The release trigger, shared by the session-keyed seam and the Answer-at-console button. */
  function releaseHold(sessionId: string, digest?: string): boolean {
    const entry = held.get(sessionId);
    if (entry === undefined) return false;
    if (digest !== undefined && entry.digest !== digest) {
      log(
        `question desk: session ${sessionId}'s hold is for a different ask than the release ` +
          "names; the hold stands",
      );
      return false;
    }
    return settle(sessionId, "released", {});
  }

  return {
    hold(sessionId, questions, questionsInput, response, dispatched) {
      if (response.writableEnded || response.destroyed) {
        // The socket died between the request arriving and this call, so there is no one to
        // answer: registering it would watch for a `close` that already fired and squat an entry
        // for the whole hold. Nothing is held, and the true return keeps the caller off a
        // response whose every write throws, which is the same thing a hold means to it.
        log(
          `question desk: session ${sessionId}'s question response was gone before the hold; ` +
            "nothing is held",
        );
        return true;
      }
      const digest = questionDigest(questions);
      const existing = held.get(sessionId);
      if (existing !== undefined && existing.digest === digest) {
        if (existing.responses.length >= MAX_RESPONSES_PER_ENTRY) {
          // Rate-limited, unlike every other line here: a CLI retrying past this cap posts for the
          // life of the hold, and one line per attempt would push every other line out of the log
          // through rotation.
          repeats(
            `refused a retry for session ${sessionId}, its hold already carries ` +
              `${String(MAX_RESPONSES_PER_ENTRY)} responses`,
          );
          return false;
        }
        // The CLI retrying the one ask it is parked on. Both responses answer identically at
        // resolution, on the entry's original clock: a retry is the same question, not a new one.
        watch(sessionId, response);
        existing.responses.push(response);
        return true;
      }
      if (existing !== undefined) {
        // A different ask from the same session: the session has moved on, so the older hold is
        // answering a question nobody is parked on. Released rather than replaced-in-place,
        // because its responses belong to the older ask's tool call.
        settle(sessionId, "released", {});
      }
      if (!dispatched) {
        // No alert went out for this ask and no live entry carries one, so a new entry would park
        // the session on a question the operator was never shown. Refused instead, which answers
        // the post at the console: today's behavior, the direction every failure here takes.
        log(`question desk: refused a hold for session ${sessionId}, its question alerted nowhere`);
        return false;
      }
      if (held.size >= MAX_HELD_QUESTIONS) {
        log(
          `question desk: refused a hold for session ${sessionId}, ` +
            `${String(MAX_HELD_QUESTIONS)} are already held`,
        );
        return false;
      }
      const timer = setTimer(() => {
        // Margin below the installed hook timeout (the fragment pin holds it there), so the
        // release is always this clean `{}` and never a CLI-side timeout error.
        settle(sessionId, "expired", {});
      }, options.holdMs);
      watch(sessionId, response);
      // Six random bytes, which is the whole of what a component id has to be: unguessable enough
      // that an id cannot be composed for an entry the operator was never shown, and short enough
      // that four segments of it stay well inside Discord's 100-character custom_id field.
      const id = randomBytes(6).toString("hex");
      held.set(sessionId, {
        id,
        digest,
        questions,
        selections: questions.map(() => []),
        alert: null,
        questionsInput,
        responses: [response],
        timer,
      });
      byId.set(id, sessionId);
      return true;
    },

    resolve: resolveHold,

    answerTyped(sessionId, response) {
      const entry = held.get(sessionId);
      if (entry === undefined) return false;
      if (entry.alert === null) {
        // The window between the hold and the alert landing, which is one Discord round trip: the
        // thread still shows nothing about this ask, so a message typed into it is about something
        // else. The caller keeps it, and it goes wherever a message goes when nothing is held.
        log(
          `question desk: session ${sessionId}'s hold has no message in the thread yet; ` +
            "a typed message is not read as its answer",
        );
        return false;
      }
      // Bounded again here, over the router's own ceiling rather than a second one: what crosses
      // this seam goes verbatim into a session's tool result, and the desk is the boundary that
      // makes it safe rather than the discipline of whoever calls it. Invisibles first, because a
      // bidi override is what would show the operator's thread and the session's own transcript two
      // different answers.
      const bounded = sliceCodePoints(withoutInvisible(response).trim(), MAX_INBOUND_TEXT_LENGTH);
      return resolveHold(sessionId, { kind: "response", response: bounded });
    },

    answeredAtConsole(sessionId, digest) {
      // Oldest first, because the records and the resolution lines are both in the order their asks
      // closed: a session that asked one question twice has the first line reporting the first ask,
      // and the newest match would flip the second message while the answered one went on telling
      // the operator to walk to a console with nothing on it.
      for (const [at, closed] of recentlyClosed.entries()) {
        if (closed.sessionId !== sessionId || closed.digest !== digest) continue;
        // Consumed as it is matched, so the flip happens exactly once however many times the ask's
        // resolution is reported.
        recentlyClosed.splice(at, 1);
        notifyTerminal(sessionId, digest, "answered-at-console", {
          entryId: closed.entryId,
          alert: closed.alert,
          questions: closed.questions,
          answers: null,
        });
        return true;
      }
      const live = held.get(sessionId);
      if (live !== undefined && live.digest === digest) {
        // No closed instance of this ask is left, and the one the session holds is not what the line
        // reports: a held PreToolUse response blinds the console, so no picker has rendered for it
        // and nothing there can have answered it. The hold is left exactly as it was, which is the
        // direction every uncertainty here takes. Rate-limited, because transcript lines drive this
        // one and they arrive far faster than the posts every other bounded line here counts.
        repeats(
          `session ${sessionId} is still holding the ask a console answer names; the hold stands`,
        );
      }
      return false;
    },

    held(sessionId, digest) {
      const entry = held.get(sessionId);
      return entry === undefined || entry.digest !== digest ? null : view(entry, sessionId);
    },

    noteAlert(sessionId, digest, alert) {
      const entry = held.get(sessionId);
      if (entry === undefined || entry.digest !== digest) return null;
      if (entry.alert !== null) {
        // A second alert for the ask this entry already carries one for: the tailer's
        // resolution-time yield landing inside the digest window while the hook's own alert is up.
        // Repointing the entry would leave the first message's components live over a hold whose
        // terminal state now rewrites a different message, so the newer post is left as the plain
        // notice it was written as.
        log(
          `question desk: session ${sessionId}'s question already has a message it is answered ` +
            "through; the newer notice stands as one",
        );
        return null;
      }
      entry.alert = alert;
      return entry.id;
    },

    entry(entryId) {
      const found = located(entryId);
      return found === null ? null : view(found.entry, found.sessionId);
    },

    select(entryId, questionIndex, optionIndexes) {
      const found = located(entryId);
      if (found === null) return null;
      const asked = found.entry.questions[questionIndex];
      if (asked === undefined) return null;
      // Positions resolved against the entry's own copy of the ask, and a position naming no
      // option contributes nothing: what is stored is a label the ask really offered, which is what
      // keeps a stale or forged component from submitting an answer the picker never showed.
      const labels = optionIndexes
        .map((at) => asked.options[at]?.label)
        .filter((label): label is string => label !== undefined);
      // A select reports its whole selection on every change, so the last report replaces the
      // question's answer rather than adding to it.
      found.entry.selections[questionIndex] = asked.multiSelect ? labels : labels.slice(0, 1);
      return view(found.entry, found.sessionId);
    },

    submit(entryId) {
      const found = located(entryId);
      if (found === null) return { kind: "gone" };
      const { entry, sessionId } = found;
      for (const [at] of entry.questions.entries()) {
        // Named in the operator's own numbering, which is what the message shows: a partial answer
        // would commit the session to picks nobody made, so the ask waits instead.
        if (entry.selections[at].length === 0) return { kind: "incomplete", questionNumber: at + 1 };
      }
      // Keyed by the question text the payload carried, verbatim, and valued with the labels the ask
      // itself declared: the measured vocabulary Claude Code reads answers back in.
      //
      // Built on no prototype at all, because the keys are untrusted conversation content: on a
      // plain object a question asked as `__proto__` assigns nothing, so the answer would vanish
      // from the body and the reader would find the prototype where a label belongs. An ask whose
      // questions collide in this map never reaches the thread, which `answerableFromThread` is
      // what decides.
      const answers = Object.create(null) as Record<string, string | readonly string[]>;
      for (const [at, asked] of entry.questions.entries()) {
        const chosen = entry.selections[at];
        answers[asked.question] = asked.multiSelect ? [...chosen] : chosen[0];
      }
      return resolveHold(sessionId, { kind: "answers", answers })
        ? { kind: "answered" }
        : { kind: "gone" };
    },

    releaseEntry(entryId) {
      const found = located(entryId);
      if (found === null) return false;
      return releaseHold(found.sessionId, found.entry.digest);
    },

    release: releaseHold,

    async releaseAll() {
      // Collected before the settles, because settling empties the map: these are the responses
      // whose bodies the teardown that follows must not destroy unflushed.
      const written: ServerResponse[] = [];
      for (const sessionId of [...held.keys()]) {
        const entry = held.get(sessionId);
        if (entry !== undefined) written.push(...entry.responses);
        settle(sessionId, "shutdown", {});
      }
      await flushed(written);
    },
  };
}
