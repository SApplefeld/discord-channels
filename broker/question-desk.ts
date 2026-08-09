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
import type { ServerResponse } from "node:http";
import type { AskedQuestion } from "./discord/render.ts";
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

/** How a hold ended, for the terminal-state notifier. */
export type QuestionTerminalState = "answered" | "released" | "expired" | "client-gone" | "shutdown";

/**
 * What an answered hold injects, in the vocabulary Claude Code reads out of `updatedInput`:
 * `answers` maps exact question text to an option label (single-select) or an array of labels
 * (multi-select); `response` is a whole-ask free-form reply that replaces the per-question answers
 * entirely.
 */
export type QuestionAnswers =
  | { kind: "answers"; answers: Readonly<Record<string, string | readonly string[]>> }
  | { kind: "response"; response: string };

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
  /**
   * Told each entry's terminal state once, after the response is answered (or found unanswerable).
   * This is the message-edit seam: a no-op until a thread-message editor is wired to it, and the
   * desk never lets a throw out of it reach the response path.
   */
  onTerminal?: (sessionId: string, state: QuestionTerminalState) => void;
  /** Injected so a test drives expiry without sleeping. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

type HeldEntry = {
  /**
   * The tailer's own digest of the bounded parse, so a retry attaches to the ask it repeats and a
   * digest-checked release matches the ask it was asked about.
   */
  digest: string;
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

export function createQuestionDesk(options: QuestionDeskOptions): QuestionDesk {
  const log = options.log ?? ((): void => {});
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const held = new Map<string, HeldEntry>();

  function notifyTerminal(sessionId: string, state: QuestionTerminalState): void {
    try {
      options.onTerminal?.(sessionId, state);
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
  function settle(sessionId: string, state: QuestionTerminalState, body: unknown | null): boolean {
    const entry = held.get(sessionId);
    if (entry === undefined) return false;
    held.delete(sessionId);
    clearTimer(entry.timer);
    if (body !== null) {
      for (const response of entry.responses) respond(sessionId, response, body);
    }
    log(`question desk: session ${sessionId}'s question hold ended: ${state}`);
    notifyTerminal(sessionId, state);
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
      clearTimer(entry.timer);
      log(`question desk: session ${sessionId}'s held response closed before resolution`);
      notifyTerminal(sessionId, "client-gone");
    });
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
          log(
            `question desk: refused a retry for session ${sessionId}, its hold already carries ` +
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
      held.set(sessionId, { digest, questionsInput, responses: [response], timer });
      return true;
    },

    resolve(sessionId, answers) {
      const entry = held.get(sessionId);
      if (entry === undefined) return false;
      // The measured wire shape: a 2xx whose hookSpecificOutput allows the call and rewrites its
      // input skips the picker entirely, and the turn proceeds showing the injected answers as the
      // operator's picks. `response` replaces the per-question answers whole.
      const updatedInput =
        answers.kind === "answers"
          ? { questions: entry.questionsInput, answers: answers.answers }
          : { questions: entry.questionsInput, response: answers.response };
      return settle(sessionId, "answered", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      });
    },

    release(sessionId, digest) {
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
    },

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
