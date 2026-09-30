// The inbox judge: the broker's first outbound call to a host other than Discord.
//
// A session reply that carries no `ASK:` line may still need something from the operator, and this
// module asks TypeSafe's Jev classifier whether it does. Two yes-or-no questions go out with the
// reply's text and two probabilities come back. The larger one is the reply's score, and a score at
// or above the threshold is delivered to the inbox store as a judged flag. The call itself is the
// shared Jev client's: the host, the model, the timeout, the secret screen, the failure kinds and
// the per-session single flight live in `broker/jev/client.ts`, and this module supplies the
// questions, the reply's text and the reading of the two numbers. Nothing this module takes as an
// argument can send a reply anywhere else, and it reads no setting and no environment variable.
//
// What leaves the machine is closed at the text of one reply, screened for secrets over its whole
// length and then cut to its first 12,000 code points. A reply matching the screen is never sent,
// and neither is an empty one. Length never blocks a send. The screen is a pattern and not a proof,
// an accepted residual recorded in `docs/security-model.md`.
//
// Every failure lands on one direction: no flag, one rate-limited log line, and never a throw into
// the caller. A log line names the failure kind and the session and carries no reply text, no
// response body and no part of the key. The reply text is the one string the security model says
// must not leak, so the log seam here is held to the question desk's rule: ids, kinds and counts,
// never content.
//
// Each session holds at most one call in flight and one reply waiting. A reply arriving while a
// call is in flight takes the waiting place, replacing whatever was there. The call in flight is
// never aborted, its verdict is always delivered, and the waiting reply is judged when it settles.
import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JEV_URL,
  MAX_JEV_CODE_POINTS,
  SECRET_SCREEN,
  createJevClient,
  readAnswers,
} from "../jev/client.ts";
import type { JevFetch } from "../jev/client.ts";
import type { RepeatLogSurface } from "../repeat-log.ts";
import { sliceCodePoints } from "../sanitize.ts";
import type { JudgeScores, JudgeWinner } from "./store.ts";

export { SECRET_SCREEN };

/** The one host a reply is ever sent to. A constant, so no argument or setting can redirect it. */
export const JUDGE_URL = JEV_URL;

/** The classifier model named in every request. */
export const JUDGE_MODEL = JEV_MODEL;

/** How long one call may take before it is abandoned. A call is never retried. */
export const JUDGE_TIMEOUT_MS = JEV_TIMEOUT_MS;

/** The most code points of a reply that are sent. The cut never splits a surrogate pair. */
export const MAX_JUDGED_CODE_POINTS = MAX_JEV_CODE_POINTS;

/**
 * How long a run of the same failure kind is aggregated before its next line. The same window the
 * intake's refusal log and the question desk's repeat log hold.
 */
const REPEAT_WINDOW_MS = 60_000;

const PREAMBLE =
  "The `message` is the final reply an AI coding agent sent to its human operator at the end of " +
  "a work turn. The operator reads many such messages a day and wants to see first the ones that " +
  "need something from them.";

/**
 * The two questions, each yes-or-no (`noul`), keyed by the name its answer comes back under.
 * The texts are the calibrated ones: a change here is a change to what the inbox catches.
 */
export const QUESTIONS = {
  needs_reply: {
    type: "noul",
    instructions:
      `${PREAMBLE} Does this message ask the operator to decide something, answer a question, or ` +
      "confirm a choice? Count it whether or not the agent keeps working meanwhile. A message that " +
      "only reports progress, results, or findings does not count.",
    criteria: {
      true: "Yes, the operator is asked to decide, answer, or confirm something.",
      false: "No, nothing in it asks the operator to decide, answer, or confirm.",
    },
  },
  needs_act: {
    type: "noul",
    instructions:
      `${PREAMBLE} Does this message tell the operator that some act is theirs to perform now, ` +
      "such as merging a pull request, approving a change, running a command or installer, or " +
      "restarting something? A future act that becomes due only after further work does not count.",
    criteria: {
      true: "Yes, an act is the operator's to perform now.",
      false: "No, nothing is the operator's to do now.",
    },
  },
} as const;

/** The two questions' names, the keys every answer is read under. */
const QUESTION_NAMES: readonly JudgeWinner[] = ["needs_reply", "needs_act"];

/**
 * What a verdict at or above the threshold delivers: the shape the inbox store records for a
 * judged item. `postedAt` and `messageId` are the reply's own, carried through from what was
 * submitted and never read from a clock at verdict time, so a verdict that returns after the
 * operator has answered carries the instant the store compares against.
 */
export type JudgedFlag = {
  source: "judged";
  postedAt: number;
  scores: JudgeScores;
  /** The question with the larger number. A tie goes to `needs_reply`. */
  winner: JudgeWinner;
  messageId?: string;
};

/** One reply as the tap hands it over: its text and the instant and message it was posted as. */
export type JudgeReply = {
  text: string;
  postedAt: number;
  messageId?: string;
};

/** The one request this module makes: the shared client's, under the name its callers use. */
export type JudgeFetch = JevFetch;

export type JudgeOptions = {
  /** Sent as the bearer credential and never logged, in whole or in part. */
  apiKey: string;
  /** A score at or above this delivers a flag. */
  threshold: number;
  /** Injected so a test drives the call without a network. */
  fetch?: JudgeFetch;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
  /**
   * Told each flag once, on the call's own settlement. Never told about a below-threshold verdict
   * or a failed call, since neither opens anything. A throw out of it is caught and logged so the
   * session's waiting reply is still judged next.
   */
  onVerdict: (sessionId: string, flag: JudgedFlag) => void;
};

export type Judge = {
  /**
   * Hands one reply to the judge. Returns at once and never throws: the call runs detached, and
   * whatever it delivers arrives through `onVerdict`. A reply that is empty or matches the secret
   * screen makes no call and touches nothing, so a reply already waiting for this session keeps
   * its place.
   */
  submit: (sessionId: string, reply: JudgeReply) => void;
};

/** The two answers under the names the inbox store records them by. */
function toScores(answers: Readonly<Record<JudgeWinner, number>>): JudgeScores {
  return { needsReply: answers.needs_reply, needsAct: answers.needs_act };
}

/**
 * The two numbers read out of a response body, or null where the body is malformed: not JSON,
 * either `answers.<question>.noul` absent, not a finite number, or outside 0 to 1. The body text
 * is never returned or logged, since a response is the vendor's and could quote the reply back.
 */
export function readScores(body: string): JudgeScores | null {
  const answers = readAnswers(body, QUESTION_NAMES);
  return answers === null ? null : toScores(answers);
}

/**
 * The judge's repeat log, keyed by the failure kind; the session rides beside it. The kinds are a
 * closed set (the screen, a timeout, a network failure, a malformed body, a handler throw, and one
 * per HTTP status), so the map is bounded without a sweep.
 */
export const JUDGE_REPEAT_LOG: RepeatLogSurface<[sessionId: string]> = {
  windowMs: REPEAT_WINDOW_MS,
  firstLine: (kind, sessionId) => `inbox judge: ${kind} session=${sessionId}`,
  countLine: (kind, suppressed) =>
    `inbox judge: ${kind} occurred ${String(suppressed)} more time(s) in the last ` +
    `${String(REPEAT_WINDOW_MS)}ms`,
};

/**
 * Builds the judge over its injected seams. `threshold` is the seam contract's one number: the
 * caller supplies a finite value in 0 to 1 out of its own bounded setting, and this module does
 * not re-validate it, so an out-of-range value is the caller's defect and not detected here.
 */
export function createJudge(options: JudgeOptions): Judge {
  const client = createJevClient<JudgeWinner, JudgeReply>({
    apiKey: options.apiKey,
    questions: QUESTIONS,
    repeatLog: JUDGE_REPEAT_LOG,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // A failed call delivers nothing: the client has logged its kind, and no flag opens on it. A
    // throw out of `onVerdict` is the client's to catch and log, so the waiting reply still flies.
    onResult: (sessionId, reply, result) => {
      if (!result.ok) return;
      const scores = toScores(result.answers);
      if (Math.max(scores.needsReply, scores.needsAct) < options.threshold) return;
      const flag: JudgedFlag = {
        source: "judged",
        postedAt: reply.postedAt,
        scores,
        winner: scores.needsAct > scores.needsReply ? "needs_act" : "needs_reply",
        ...(reply.messageId === undefined ? {} : { messageId: reply.messageId }),
      };
      options.onVerdict(sessionId, flag);
    },
  });

  return {
    submit(sessionId, reply) {
      // Screened here, over the whole reply and before the cut, so a secret past the cut still
      // blocks the send and a screened reply never displaces the reply waiting for this session.
      if (reply.text.trim() === "" || SECRET_SCREEN.test(reply.text)) return;
      client.submit(sessionId, { message: sliceCodePoints(reply.text, MAX_JUDGED_CODE_POINTS) }, reply);
    },
  };
}
