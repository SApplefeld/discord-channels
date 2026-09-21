// The inbox judge. Two properties carry the weight: no failure path throws into the caller or
// delivers a flag, and no log line carries the reply text, the response body or the key. Every
// reply fixture, the key and every response body carry a `SECRET-` sentinel so a line quoting any
// of them turns a silent leak into a red test. The single-flight is driven with deferred promises,
// never with a sleep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWellFormed } from "../sanitize.ts";
import {
  JUDGE_MODEL,
  JUDGE_URL,
  MAX_JUDGED_CODE_POINTS,
  QUESTIONS,
  SECRET_SCREEN,
  createJudge,
  readScores,
} from "./judge.ts";
import type { JudgeFetch, JudgeOptions, JudgeReply, JudgedFlag } from "./judge.ts";

const KEY = "SECRET-KEY-0123456789abcdef";
const REPLY_TEXT = "SECRET-REPLY finished the refactor; should I merge the branch now?";
const SESSION = "session-a";

type Response = Awaited<ReturnType<JudgeFetch>>;
type Call = { url: string; init: Parameters<JudgeFetch>[1] };
type Deferred = {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

/**
 * A response body carrying the two numbers, in the vendor's shape, plus a sentinel field so a
 * line quoting the body is caught on the well-formed and malformed-number branches too.
 */
function scored(needsReply: number, needsAct: number): string {
  return JSON.stringify({
    answers: { needs_reply: { noul: needsReply }, needs_act: { noul: needsAct } },
    echo: "SECRET-BODY",
  });
}

function respond(text: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function reply(text: string = REPLY_TEXT, postedAt = 1_000, messageId?: string): JudgeReply {
  return messageId === undefined ? { text, postedAt } : { text, postedAt, messageId };
}

/** Lets every promise the judge chained on a settled call run, without a timer. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The predicate every log assertion here runs: no line carries any sentinel, so no reply text,
 * response body or key reached the log. The control test below proves it fires.
 */
function assertNoContent(lines: readonly string[]): void {
  for (const line of lines) {
    assert.ok(!line.includes("SECRET-"), `a log line carries content: ${line}`);
  }
}

/**
 * A failure line is pinned on the tokens a reader acts on, the kind and the session, never on its
 * sentence. A suppressed-count line is pinned on the count it carries.
 */
function assertFailureLines(
  lines: readonly string[],
  expected: ReadonlyArray<{ kind: string; session: string } | { suppressed: number }>,
): void {
  assert.equal(lines.length, expected.length, `lines: ${lines.join(" | ")}`);
  expected.forEach((want, index) => {
    const line = lines[index]!;
    if ("suppressed" in want) {
      assert.ok(line.includes(`occurred ${String(want.suppressed)} more`), line);
      return;
    }
    assert.ok(line.includes(want.kind), `${line} names the kind ${want.kind}`);
    assert.ok(line.includes(`session=${want.session}`), `${line} names the session`);
  });
  assertNoContent(lines);
}

/** A judge over a fetch whose every call is held until the test settles it. */
function harness(overrides: Partial<JudgeOptions> = {}) {
  const calls: Call[] = [];
  const pending: Deferred[] = [];
  const logged: string[] = [];
  const verdicts: Array<{ sessionId: string; flag: JudgedFlag }> = [];
  const fetch: JudgeFetch = (url, init) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  const judge = createJudge({
    apiKey: KEY,
    threshold: 0.7,
    fetch,
    log: (message) => logged.push(message),
    onVerdict: (sessionId, flag) => verdicts.push({ sessionId, flag }),
    ...overrides,
  });
  return {
    judge,
    calls,
    pending,
    logged,
    verdicts,
    /** The `state.message` the call at `index` sent. */
    message: (index: number): string =>
      (JSON.parse(calls[index]!.init.body) as { state: { message: string } }).state.message,
  };
}

test("the control: the no-content predicate fires on a line carrying a sentinel", () => {
  assert.throws(() => assertNoContent(["inbox judge: timeout session=x SECRET-REPLY"]));
  assert.doesNotThrow(() => assertNoContent(["inbox judge: timeout session=x"]));
});

test("a score at or above the threshold on either question delivers a flag, below on both none", async () => {
  const cases: Array<[number, number, JudgedFlag["winner"] | null]> = [
    [0.71, 0.1, "needs_reply"],
    [0.1, 0.71, "needs_act"],
    [0.7, 0.1, "needs_reply"],
    [0.1, 0.7, "needs_act"],
    [0.69, 0.69, null],
    [0.8, 0.8, "needs_reply"],
  ];
  for (const [needsReply, needsAct, winner] of cases) {
    const h = harness();
    h.judge.submit(SESSION, reply(REPLY_TEXT, 1_234, "msg-1"));
    h.pending[0]!.resolve(respond(scored(needsReply, needsAct)));
    await settled();
    if (winner === null) {
      assert.deepEqual(h.verdicts, [], `${String(needsReply)}/${String(needsAct)} delivers nothing`);
      continue;
    }
    assert.deepEqual(h.verdicts, [
      {
        sessionId: SESSION,
        flag: {
          source: "judged",
          postedAt: 1_234,
          scores: { needsReply, needsAct },
          winner,
          messageId: "msg-1",
        },
      },
    ]);
    assert.deepEqual(h.logged, []);
  }
});

test("a flag carries the reply's own instant and omits the message id the reply did not carry", async () => {
  const h = harness({ now: () => 999_999 });
  h.judge.submit(SESSION, reply(REPLY_TEXT, 42));
  h.pending[0]!.resolve(respond(scored(0.9, 0.2)));
  await settled();
  assert.deepEqual(h.verdicts[0]!.flag, {
    source: "judged",
    postedAt: 42,
    scores: { needsReply: 0.9, needsAct: 0.2 },
    winner: "needs_reply",
  });
  assert.ok(!("messageId" in h.verdicts[0]!.flag));
});

test("the request goes to the constant host with both headers and the calibrated body", () => {
  const h = harness();
  h.judge.submit(SESSION, reply());
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0]!;
  assert.equal(url, JUDGE_URL);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Authorization"], `Bearer ${KEY}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, "error", "a redirect fails the call rather than re-posting the text");
  assert.deepEqual(JSON.parse(init.body), {
    state: { message: REPLY_TEXT },
    model: JUDGE_MODEL,
    questions: QUESTIONS,
  });
  assert.equal(JUDGE_MODEL, "jev-latest");
  assert.equal(QUESTIONS.needs_reply.type, "noul");
  assert.equal(QUESTIONS.needs_act.type, "noul");
});

test("no argument or setting redirects the host", () => {
  // An extra field smuggled past the type reaches nothing: the URL is a module constant.
  const h = harness({ url: "https://example.invalid/elsewhere" } as Partial<JudgeOptions>);
  h.judge.submit(SESSION, reply());
  assert.equal(h.calls[0]!.url, JUDGE_URL);
  // And the module never names the process object at all, by either spelling, so no environment
  // variable can name another host.
  const source = readFileSync(new URL("./judge.ts", import.meta.url), "utf8");
  assert.ok(!/\bprocess\b|node:process/.test(source), "judge.ts reads no environment variable");
});

test("a timeout, a non-2xx, a malformed body and a network failure each deliver nothing and log without content", async () => {
  const failures: Array<[string, (d: Deferred) => void, string]> = [
    [
      "timeout",
      (d) => d.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      "timeout",
    ],
    ["non-2xx", (d) => d.resolve(respond("SECRET-BODY refused", 503)), "http 503"],
    ["not JSON", (d) => d.resolve(respond("SECRET-BODY not json")), "malformed"],
    [
      "needs_act absent",
      (d) =>
        d.resolve(
          respond(
            JSON.stringify({ answers: { needs_reply: { noul: 0.9 } }, echo: "SECRET-BODY" }),
          ),
        ),
      "malformed",
    ],
    [
      "noul a string",
      (d) =>
        d.resolve(
          respond(
            JSON.stringify({
              answers: { needs_reply: { noul: "0.9" }, needs_act: { noul: 0.1 } },
              echo: "SECRET-BODY",
            }),
          ),
        ),
      "malformed",
    ],
    ["noul above 1", (d) => d.resolve(respond(scored(1.2, 0.1))), "malformed"],
    ["noul below 0", (d) => d.resolve(respond(scored(0.5, -0.1))), "malformed"],
    ["noul null", (d) => d.resolve(respond(scored(0.5, null as unknown as number))), "malformed"],
    ["network", (d) => d.reject(new Error("SECRET-BODY socket hang up")), "network"],
    [
      "body read failed",
      (d) =>
        d.resolve({
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error("SECRET-BODY stream reset")),
        }),
      "network",
    ],
  ];
  for (const [name, fail, kind] of failures) {
    const h = harness();
    assert.doesNotThrow(() => h.judge.submit(SESSION, reply()));
    fail(h.pending[0]!);
    await settled();
    assert.deepEqual(h.verdicts, [], `${name} delivers nothing`);
    assertFailureLines(h.logged, [{ kind, session: SESSION }]);
  }
});

test("a fetch that throws rather than rejects is a network failure, not a throw into the caller", async () => {
  const h = harness({
    fetch: () => {
      throw new Error("SECRET-BODY boom");
    },
  });
  assert.doesNotThrow(() => h.judge.submit(SESSION, reply()));
  await settled();
  assert.deepEqual(h.verdicts, []);
  assertFailureLines(h.logged, [{ kind: "network", session: SESSION }]);
});

test("a call is never retried", async () => {
  const h = harness();
  h.judge.submit(SESSION, reply());
  h.pending[0]!.reject(new DOMException("timed out", "TimeoutError"));
  await settled();
  assert.equal(h.calls.length, 1);
});

test("the failure log writes one line per kind per window and counts the rest", async () => {
  let at = 0;
  const h = harness({ now: () => at });
  const timeOut = async (): Promise<void> => {
    h.judge.submit(SESSION, reply());
    h.pending[h.pending.length - 1]!.reject(new DOMException("timed out", "TimeoutError"));
    await settled();
  };
  await timeOut();
  await timeOut();
  await timeOut();
  assertFailureLines(h.logged, [{ kind: "timeout", session: SESSION }]);
  // A different kind inside the same window is its own line.
  h.judge.submit(SESSION, reply());
  h.pending[h.pending.length - 1]!.resolve(respond("SECRET-BODY server error", 500));
  await settled();
  assertFailureLines(h.logged, [
    { kind: "timeout", session: SESSION },
    { kind: "http 500", session: SESSION },
  ]);
  at = 60_000;
  await timeOut();
  assertFailureLines(h.logged, [
    { kind: "timeout", session: SESSION },
    { kind: "http 500", session: SESSION },
    { suppressed: 2 },
    { kind: "timeout", session: SESSION },
  ]);
});

test("each secret screen branch blocks the send", () => {
  const secrets: Array<[string, string]> = [
    ["api_key assignment", `set api_key = "abcdefghijkl" and run`],
    ["api-key assignment, uppercase", `API-KEY: 'ABCDEFGHIJKLMNOP'`],
    ["bearer token", "Authorization: Bearer abcdefghij0123456789"],
    ["PEM header", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
    ["sk- key", "the key is sk-abcdefghij0123456789xyz"],
    ["sk-proj- key", "OPENAI_API_KEY is sk-proj-abcdefghij0123456789"],
    ["sk-ant-api03- key", "use sk-ant-api03-abcdefghij0123456789"],
    ["GitHub gho_", "gho_abcdefghij0123456789"],
    ["GitHub ghp_", "ghp_abcdefghij0123456789"],
    ["GitHub ghs_", "ghs_abcdefghij0123456789"],
    ["GitHub github_pat_", "github_pat_abcdefghij0123456789"],
    ["password assignment", `password = "hunter2"`],
  ];
  for (const [name, secret] of secrets) {
    assert.ok(SECRET_SCREEN.test(secret), `${name} matches the screen`);
    const h = harness();
    h.judge.submit(SESSION, reply(`SECRET-REPLY done. ${secret}`));
    assert.equal(h.calls.length, 0, `${name} makes no call`);
    assert.deepEqual(h.logged, []);
  }
});

test("a near miss of each branch does not block the send", () => {
  const nearMisses: Array<[string, string]> = [
    ["an 11-character api_key value", `api_key = "abcdefghijk"`],
    ["bearer with 19 token characters", "Bearer abcdefghij012345678"],
    ["sk- with 19 alphanumerics", "sk-abcdefghij012345678"],
    ["sk- with 19 token characters", "sk-proj-abcdefghij0123"],
    ["a GitHub prefix with 19 characters", "ghp_abcdefghij012345678"],
    ["a password mentioned without an assignment", "reset your password before Friday"],
    ["a PEM public key", "-----BEGIN PUBLIC KEY-----"],
    ["the word bearer alone", "the bearer of the token is the operator"],
  ];
  for (const [name, text] of nearMisses) {
    assert.ok(!SECRET_SCREEN.test(text), `${name} does not match the screen`);
    const h = harness();
    h.judge.submit(SESSION, reply(text));
    assert.equal(h.calls.length, 1, `${name} is sent`);
  }
});

test("the screen runs over the whole reply, so a secret past the cut still blocks the send", () => {
  const h = harness();
  const text = `${"x".repeat(MAX_JUDGED_CODE_POINTS + 10)} password = "hunter2"`;
  h.judge.submit(SESSION, reply(text));
  assert.equal(h.calls.length, 0);
});

test("the cut keeps the first 12,000 code points and never splits a surrogate pair", () => {
  const h = harness();
  const astral = "\u{1F600}".repeat(MAX_JUDGED_CODE_POINTS + 5);
  h.judge.submit(SESSION, reply(astral));
  const sent = h.message(0);
  assert.equal([...sent].length, MAX_JUDGED_CODE_POINTS);
  assert.ok(isWellFormed(sent));
  assert.equal(sent, "\u{1F600}".repeat(MAX_JUDGED_CODE_POINTS));
});

test("length never blocks a send, and a reply inside the cut is sent whole", () => {
  const h = harness();
  h.judge.submit("long", reply("y".repeat(100_000)));
  assert.equal(h.calls.length, 1);
  assert.equal(h.message(0).length, MAX_JUDGED_CODE_POINTS);
  const whole = "\u{1F600}".repeat(MAX_JUDGED_CODE_POINTS);
  h.judge.submit("whole", reply(whole));
  assert.equal(h.message(1), whole);
});

test("an empty or whitespace-only reply makes no call", () => {
  const h = harness();
  h.judge.submit(SESSION, reply(""));
  h.judge.submit(SESSION, reply(" \n\t "));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.logged, []);
});

test("a reply arriving in flight replaces the one waiting, the in-flight verdict is used, and the waiting one is judged next", async () => {
  const h = harness();
  h.judge.submit(SESSION, reply("SECRET-REPLY first", 1));
  h.judge.submit(SESSION, reply("SECRET-REPLY second", 2));
  h.judge.submit(SESSION, reply("SECRET-REPLY third", 3));
  assert.equal(h.calls.length, 1, "one call in flight");
  h.pending[0]!.resolve(respond(scored(0.9, 0.1)));
  await settled();
  assert.deepEqual(
    h.verdicts.map((v) => v.flag.postedAt),
    [1],
    "the in-flight verdict is delivered",
  );
  assert.equal(h.calls.length, 2, "the waiting reply is judged next");
  assert.equal(h.message(1), "SECRET-REPLY third", "the replaced reply is never sent");
  h.pending[1]!.resolve(respond(scored(0.2, 0.95)));
  await settled();
  assert.deepEqual(
    h.verdicts.map((v) => [v.flag.postedAt, v.flag.winner]),
    [
      [1, "needs_reply"],
      [3, "needs_act"],
    ],
  );
  assert.equal(h.calls.length, 2);
  // Once idle, the next reply opens a fresh call.
  h.judge.submit(SESSION, reply("SECRET-REPLY fourth", 4));
  assert.equal(h.calls.length, 3);
});

test("a screened reply arriving in flight neither makes a call nor displaces the reply waiting", async () => {
  const h = harness();
  h.judge.submit(SESSION, reply("SECRET-REPLY first", 1));
  h.judge.submit(SESSION, reply("SECRET-REPLY second", 2));
  h.judge.submit(SESSION, reply(`SECRET-REPLY password = "hunter2"`, 3));
  h.pending[0]!.resolve(respond(scored(0.1, 0.1)));
  await settled();
  assert.equal(h.calls.length, 2);
  assert.equal(h.message(1), "SECRET-REPLY second");
});

test("a failed call still hands the session to its waiting reply", async () => {
  const h = harness();
  h.judge.submit(SESSION, reply("SECRET-REPLY first", 1));
  h.judge.submit(SESSION, reply("SECRET-REPLY second", 2));
  h.pending[0]!.reject(new DOMException("timed out", "TimeoutError"));
  await settled();
  assert.equal(h.calls.length, 2);
  h.pending[1]!.resolve(respond(scored(0.8, 0.1)));
  await settled();
  assert.deepEqual(
    h.verdicts.map((v) => v.flag.postedAt),
    [2],
  );
  assertNoContent(h.logged);
});

test("a verdict handler that throws is logged and the waiting reply is still judged", async () => {
  let calls = 0;
  const h = harness({
    onVerdict: () => {
      calls += 1;
      throw new Error("SECRET-BODY handler broke");
    },
  });
  h.judge.submit(SESSION, reply("SECRET-REPLY first", 1));
  h.judge.submit(SESSION, reply("SECRET-REPLY second", 2));
  h.pending[0]!.resolve(respond(scored(0.9, 0.1)));
  await settled();
  assert.equal(calls, 1);
  assert.equal(h.calls.length, 2);
  assertFailureLines(h.logged, [{ kind: "verdict handler threw", session: SESSION }]);
});

test("a log that throws on a failure line does not stop the waiting reply from being judged", async () => {
  const written: string[] = [];
  const h = harness({
    log: (message) => {
      if (written.length === 0) {
        written.push(message);
        throw new Error("SECRET-BODY log broke");
      }
      written.push(message);
    },
  });
  h.judge.submit(SESSION, reply("SECRET-REPLY first", 1));
  h.judge.submit(SESSION, reply("SECRET-REPLY second", 2));
  h.pending[0]!.reject(new DOMException("timed out", "TimeoutError"));
  await settled();
  assert.equal(written.length, 1, "the failure line was attempted once");
  assert.equal(h.calls.length, 2, "the waiting reply is judged after the log threw");
  h.pending[1]!.resolve(respond(scored(0.8, 0.1)));
  await settled();
  assert.deepEqual(
    h.verdicts.map((v) => v.flag.postedAt),
    [2],
  );
  // Once idle, the session is released rather than stranded.
  h.judge.submit(SESSION, reply("SECRET-REPLY third", 3));
  assert.equal(h.calls.length, 3);
  assertNoContent(written);
});

test("sessions fly independently: one session's call in flight never holds another's", () => {
  const h = harness();
  h.judge.submit("a", reply());
  h.judge.submit("b", reply());
  assert.equal(h.calls.length, 2);
});

test("readScores refuses every malformed shape and reads a well-formed one", () => {
  assert.deepEqual(readScores(scored(0, 1)), { needsReply: 0, needsAct: 1 });
  assert.equal(readScores("null"), null);
  assert.equal(readScores("[]"), null);
  assert.equal(readScores(JSON.stringify({ answers: null })), null);
  assert.equal(readScores(JSON.stringify({ answers: { needs_reply: 0.5, needs_act: 0.5 } })), null);
});
