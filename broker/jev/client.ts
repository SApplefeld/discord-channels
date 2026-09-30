// The Jev client: the one way the broker sends text to a host other than Discord.
//
// Two callers ask TypeSafe's Jev classifier yes-or-no questions about text. The inbox judge asks
// about a session's final reply, and the response gate asks about a thread's buffered
// conversation. Each supplies its own questions, the state they are asked about, the threshold it
// reads the answer against and the two lines its failures are logged on. What they share is here,
// and none of it is an argument: the host, the model and the timeout are constants, so nothing a
// caller passes can send a text anywhere else, and this module reads no setting and no environment
// variable.
//
// What leaves the machine is the state a caller hands over, every text of it screened for secrets
// first. A state matching the screen is never sent, and the call settles as a failure of its own
// kind. The screen is a pattern and not a proof, an accepted residual recorded in
// `docs/security-model.md`. The code point cut is each caller's to apply, since each knows what its
// text is and which end of it to keep; the limit is shared so both cut at one length.
//
// Every failure lands on one direction: a result naming its kind, one rate-limited log line, and
// never a throw into the caller. A log line names the failure kind and the caller's key and carries
// no state, no response body and no part of the API key.
//
// Each key holds at most one call in flight and one submission waiting. A submission arriving while
// a call is in flight takes the waiting place, replacing whatever was there. The call in flight is
// never aborted, its result is always delivered, and the waiting submission flies when it settles.
import { createRepeatLog } from "../repeat-log.ts";
import type { RepeatLogSurface } from "../repeat-log.ts";

/** The one host a state is ever sent to. A constant, so no argument or setting can redirect it. */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** The classifier model named in every request. */
export const JEV_MODEL = "jev-latest";

/** How long one call may take before it is abandoned. A call is never retried. */
export const JEV_TIMEOUT_MS = 5_000;

/** The most code points of text a caller sends in one request. A cut never splits a surrogate pair. */
export const MAX_JEV_CODE_POINTS = 12_000;

/**
 * The secret screen. A state carrying a text that matches any branch is never sent, whatever else
 * it says.
 *
 * The branches, in order: an `api_key` or `api-key` assignment to a quoted value of 12 or more
 * characters; `bearer` followed by 20 or more token characters; a PEM private-key header; `sk-`
 * at a word boundary followed by 20 or more token characters (letters, digits, `_` and `-`, so a
 * `sk-proj-` or `sk-ant-api03-` shaped key is caught with its infix, while a hyphenated name
 * such as `task-runner-config-loader` that merely contains `sk-` is not); a GitHub token prefix
 * (`gho_`, `ghp_`, `ghs_`, `github_pat_`) followed by 20 or more token characters; and a
 * `password` assignment to a quoted value of one or more characters. Case-insensitive throughout.
 */
export const SECRET_SCREEN =
  /(api[_-]key\s*[:=]\s*['"][^'"]{12,}|bearer\s+[a-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bsk-[a-z0-9_-]{20,}|(gho_|ghp_|ghs_|github_pat_)[a-z0-9_]{20,}|password\s*[:=]\s*['"][^'"]+)/i;

/** One yes-or-no (`noul`) question, in the shape the vendor's request carries it. */
export type JevQuestion = {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
};

/**
 * The state a request is evaluated on: an object whose fields a question's instructions name in
 * backticks, each one text or a list of texts.
 */
export type JevState = Readonly<Record<string, string | readonly string[]>>;

/**
 * The one request this module makes, as the narrowest shape a test fake needs to answer. The
 * global `fetch` satisfies it, and the default is that.
 */
export type JevFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    /** A redirect fails the call, so a 307 or 308 can never re-POST the text to another host. */
    redirect: "error";
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * How one call settled: the probability read out for each question, or the failure kind. The
 * kinds are a closed set: `screened`, `timeout`, `network`, `malformed`, and `http <status>`.
 */
export type JevResult<Question extends string> =
  | { ok: true; answers: Readonly<Record<Question, number>> }
  | { ok: false; kind: string };

export type JevClientOptions<Question extends string, Payload> = {
  /** Sent as the bearer credential and never logged, in whole or in part. */
  apiKey: string;
  /** The questions every request carries, keyed by the name each answer comes back under. */
  questions: Readonly<Record<Question, JevQuestion>>;
  /** The caller's two failure lines, keyed by kind with the caller's key beside it. */
  repeatLog: RepeatLogSurface<[key: string]>;
  /** Injected so a test drives the call without a network. */
  fetch?: JevFetch;
  log?: (message: string) => void;
  /** Drives the repeat-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
  /**
   * Told each call's result once, on the call's own settlement, with the payload the submission
   * carried beside it. A throw out of it is caught and logged so the key's waiting submission
   * still flies.
   */
  onResult: (key: string, payload: Payload, result: JevResult<Question>) => void;
};

export type JevClient<Payload> = {
  /**
   * Submits one state for `key`, carrying `payload` back to `onResult` unread. Returns at once and
   * never throws: the call runs detached, and whatever it settles as arrives through `onResult`.
   */
  submit: (key: string, state: JevState, payload: Payload) => void;
};

/** A submission as the flight holds it: what is sent and what rides back with the result. */
type Submission<Payload> = { state: JevState; payload: Payload };

/** A key's place in the single-flight: the call it has out and the submission held for after it. */
type Flight<Payload> = { waiting: Submission<Payload> | null };

/**
 * The numbers read out of a response body, one per question, or null where the body is
 * malformed: not JSON, any `answers.<question>.noul` absent, not a finite number, or outside 0 to
 * 1. The body text is never returned or logged, since a response is the vendor's and could quote
 * the state back.
 */
export function readAnswers<Question extends string>(
  body: string,
  questions: readonly Question[],
): Readonly<Record<Question, number>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  const read = {} as Record<Question, number>;
  for (const question of questions) {
    const value = noul(answers, question);
    if (value === null) return null;
    read[question] = value;
  }
  return read;
}

function noul(answers: unknown, question: string): number | null {
  if (typeof answers !== "object" || answers === null) return null;
  const answer = (answers as Record<string, unknown>)[question];
  if (typeof answer !== "object" || answer === null) return null;
  const value = (answer as { noul?: unknown }).noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/** True when any text in the state matches the screen. Run over every text, whole. */
function screened(state: JevState): boolean {
  return Object.values(state).some((field) =>
    typeof field === "string" ? SECRET_SCREEN.test(field) : field.some((text) => SECRET_SCREEN.test(text)),
  );
}

/** The failure kind a thrown fetch reports: the timeout signal's own name, or a network failure. */
function thrownKind(error: unknown): string {
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
}

/** A repeat log that never throws into the call, so a log's own defect cannot lose a result. */
export function createJevClient<Question extends string, Payload>(
  options: JevClientOptions<Question, Payload>,
): JevClient<Payload> {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const request: JevFetch = options.fetch ?? globalThis.fetch;
  const repeat = createRepeatLog(options.repeatLog, log, now);
  const questions = Object.keys(options.questions) as Question[];
  const flights = new Map<string, Flight<Payload>>();

  /**
   * One failure line. An injected `log` that throws is its owner's defect and not a reason to
   * lose the result the caller is owed, so the throw ends here.
   */
  function failed(kind: string, key: string): void {
    try {
      repeat(kind, key);
    } catch {
      // A log that cannot take the line is a dropped line, not a lost result.
    }
  }

  /** Hands the result over. A handler that throws is logged as its own kind and never escapes. */
  function settle(key: string, payload: Payload, result: JevResult<Question>): void {
    try {
      options.onResult(key, payload, result);
    } catch {
      failed("verdict handler threw", key);
    }
  }

  function fail(key: string, payload: Payload, kind: string): void {
    failed(kind, key);
    settle(key, payload, { ok: false, kind });
  }

  /** One call: the screen, the request, the read, and the result. Resolves on every path. */
  async function ask(key: string, submission: Submission<Payload>): Promise<void> {
    const { state, payload } = submission;
    if (screened(state)) {
      fail(key, payload, "screened");
      return;
    }
    let body: string;
    try {
      const response = await request(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state, model: JEV_MODEL, questions: options.questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        fail(key, payload, `http ${String(response.status)}`);
        return;
      }
      body = await response.text();
    } catch (error) {
      fail(key, payload, thrownKind(error));
      return;
    }
    const answers = readAnswers(body, questions);
    if (answers === null) {
      fail(key, payload, "malformed");
      return;
    }
    settle(key, payload, { ok: true, answers });
  }

  /**
   * Runs one call for the key and, when it settles, the submission waiting behind it. The handoff
   * runs on both arms, so nothing escaping `ask` can strand the key's flight or surface as an
   * unhandled rejection.
   */
  function fly(key: string, flight: Flight<Payload>, submission: Submission<Payload>): void {
    const handOff = (): void => {
      const next = flight.waiting;
      flight.waiting = null;
      if (next === null) {
        flights.delete(key);
        return;
      }
      fly(key, flight, next);
    };
    void ask(key, submission).then(handOff, handOff);
  }

  return {
    submit(key, state, payload) {
      const submission = { state, payload };
      const flight = flights.get(key);
      if (flight !== undefined) {
        flight.waiting = submission;
        return;
      }
      const opened: Flight<Payload> = { waiting: null };
      flights.set(key, opened);
      fly(key, opened, submission);
    },
  };
}
