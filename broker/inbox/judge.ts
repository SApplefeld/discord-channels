// The inbox judge: the broker's first outbound call to a host other than Discord.
//
// A session reply that carries no `ASK:` line may still need something from the operator, and this
// module asks TypeSafe's Jev classifier whether it does. Two yes-or-no questions go out with the
// reply's text and two probabilities come back. The larger one is the reply's score, and a score at
// or above the threshold is delivered to the inbox store as a judged flag. The host, the model and
// the questions are constants: nothing this module takes as an argument can send a reply anywhere
// else, and it reads no setting and no environment variable.
//
// What leaves the machine is closed at the text of one reply, screened for secrets over its whole
// length and then cut to its first 12,000 code points. A reply matching the screen is never sent,
// and neither is an empty one. Length never blocks a send. The screen is a pattern and not a proof,
// which `docs/security-model.md` records as an accepted residual.
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
import { sliceCodePoints } from "../sanitize.ts";

/** The one host a reply is ever sent to. A constant, so no argument or setting can redirect it. */
export const JUDGE_URL = "https://api.typesafe.ai/v1/systemone";

/** The classifier model named in every request. */
export const JUDGE_MODEL = "jev-latest";

/** How long one call may take before it is abandoned. A call is never retried. */
export const JUDGE_TIMEOUT_MS = 5_000;

/** The most code points of a reply that are sent. The cut never splits a surrogate pair. */
export const MAX_JUDGED_CODE_POINTS = 12_000;

/**
 * How long a run of the same failure kind is aggregated before its next line. The same window the
 * intake's refusal log and the question desk's repeat log hold, kept local for the reason they keep
 * theirs: each layer owns its own log seam.
 */
const REPEAT_WINDOW_MS = 60_000;

/**
 * The secret screen. A reply matching any branch is never sent, whatever else it says.
 *
 * The branches, in order: an `api_key` or `api-key` assignment to a quoted value of 12 or more
 * characters; `bearer` followed by 20 or more token characters; a PEM private-key header; `sk-`
 * followed by 20 or more alphanumerics; a GitHub token prefix (`gho_`, `ghp_`, `ghs_`,
 * `github_pat_`) followed by 20 or more token characters; and a `password` assignment to a quoted
 * value of any length. Case-insensitive throughout. Run over the whole reply before the cut, so a
 * secret past the cut still blocks the send.
 */
export const SECRET_SCREEN =
  /(api[_-]key\s*[:=]\s*['"][^'"]{12,}|bearer\s+[a-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[a-z0-9]{20,}|(gho_|ghp_|ghs_|github_pat_)[a-z0-9_]{20,}|password\s*[:=]\s*['"][^'"]+)/i;

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

export type JudgeWinner = "needs_reply" | "needs_act";

/**
 * What a verdict at or above the threshold delivers: the shape the inbox store records for a
 * judged item. `postedAt` and `messageId` are the reply's own, carried through from what was
 * submitted and never read from a clock at verdict time, so a verdict that returns after the
 * operator has answered carries the instant the store compares against.
 */
export type JudgedFlag = {
  source: "judged";
  postedAt: number;
  scores: { needsReply: number; needsAct: number };
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

/**
 * The one request this module makes, as the narrowest shape a test fake needs to answer. The
 * global `fetch` satisfies it, and the default is that.
 */
export type JudgeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

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

/** A session's place in the single-flight: the call it has out and the reply held for after it. */
type Flight = { waiting: JudgeReply | null };

/**
 * The two numbers read out of a response body, or null where the body is malformed: not JSON,
 * either `answers.<question>.noul` absent, not a finite number, or outside 0 to 1. The body text
 * is never returned or logged, since a response is the vendor's and could quote the reply back.
 */
export function readScores(body: string): { needsReply: number; needsAct: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  const needsReply = noul(answers, "needs_reply");
  const needsAct = noul(answers, "needs_act");
  if (needsReply === null || needsAct === null) return null;
  return { needsReply, needsAct };
}

function noul(answers: unknown, question: JudgeWinner): number | null {
  if (typeof answers !== "object" || answers === null) return null;
  const answer = (answers as Record<string, unknown>)[question];
  if (typeof answer !== "object" || answer === null) return null;
  const value = (answer as { noul?: unknown }).noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * Rate-limits a repeating failure line by its kind. The first of a kind is written at once; a
 * repeat inside the window is counted, and the count rides on the next line that window admits.
 * The kinds are a closed set (a timeout, a network failure, a malformed body, a handler throw,
 * and one per HTTP status), so the map is bounded without a sweep.
 */
function createRepeatLog(
  log: (message: string) => void,
  now: () => number,
): (kind: string, sessionId: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (kind, sessionId) => {
    const at = now();
    const entry = state.get(kind);
    if (entry !== undefined && at - entry.windowStart < REPEAT_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    if (entry !== undefined && entry.suppressed > 0) {
      log(
        `inbox judge: ${kind} occurred ${String(entry.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS)}ms`,
      );
    }
    log(`inbox judge: ${kind} session=${sessionId}`);
    state.set(kind, { windowStart: at, suppressed: 0 });
  };
}

/** The failure kind a thrown fetch reports: the timeout signal's own name, or a network failure. */
function thrownKind(error: unknown): string {
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
}

export function createJudge(options: JudgeOptions): Judge {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const request: JudgeFetch = options.fetch ?? globalThis.fetch;
  const failed = createRepeatLog(log, now);
  const flights = new Map<string, Flight>();

  /**
   * One call: the request, the read, and the verdict. Resolves whatever happened, so the caller's
   * chain to the waiting reply never breaks. Nothing in here throws out.
   */
  async function judge(sessionId: string, reply: JudgeReply): Promise<void> {
    const message = sliceCodePoints(reply.text, MAX_JUDGED_CODE_POINTS);
    let body: string;
    try {
      const response = await request(JUDGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: { message }, model: JUDGE_MODEL, questions: QUESTIONS }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      if (!response.ok) {
        failed(`http ${String(response.status)}`, sessionId);
        return;
      }
      body = await response.text();
    } catch (error) {
      failed(thrownKind(error), sessionId);
      return;
    }
    const scores = readScores(body);
    if (scores === null) {
      failed("malformed", sessionId);
      return;
    }
    if (Math.max(scores.needsReply, scores.needsAct) < options.threshold) return;
    const flag: JudgedFlag = {
      source: "judged",
      postedAt: reply.postedAt,
      scores,
      winner: scores.needsAct > scores.needsReply ? "needs_act" : "needs_reply",
      ...(reply.messageId === undefined ? {} : { messageId: reply.messageId }),
    };
    try {
      options.onVerdict(sessionId, flag);
    } catch {
      failed("verdict handler threw", sessionId);
    }
  }

  /** Runs one call for the session and, when it settles, the reply waiting behind it. */
  function fly(sessionId: string, flight: Flight, reply: JudgeReply): void {
    void judge(sessionId, reply).then(() => {
      const next = flight.waiting;
      flight.waiting = null;
      if (next === null) {
        flights.delete(sessionId);
        return;
      }
      fly(sessionId, flight, next);
    });
  }

  return {
    submit(sessionId, reply) {
      if (reply.text.trim() === "" || SECRET_SCREEN.test(reply.text)) return;
      const flight = flights.get(sessionId);
      if (flight !== undefined) {
        flight.waiting = reply;
        return;
      }
      const opened: Flight = { waiting: null };
      flights.set(sessionId, opened);
      fly(sessionId, opened, reply);
    },
  };
}
