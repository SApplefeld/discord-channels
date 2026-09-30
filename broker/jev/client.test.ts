// The shared Jev client. What the two callers' own tests cannot reach is pinned here: the screen
// over a state of several fields, a result handed over on every failure kind, the generic answer
// reading, and the single flight per key. Every state text, the key and every response body carry
// a `SECRET-` sentinel so a log line quoting any of them turns a silent leak into a red test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RepeatLogSurface } from "../repeat-log.ts";
import { JEV_MODEL, JEV_URL, SECRET_SCREEN, createJevClient, readAnswers } from "./client.ts";
import type { JevFetch, JevResult, JevState } from "./client.ts";

const KEY = "SECRET-KEY-0123456789abcdef";
const QUESTIONS = {
  wants_tea: {
    type: "noul",
    instructions: "Does the `note` ask for tea?",
    criteria: { true: "Yes.", false: "No." },
  },
  wants_cake: {
    type: "noul",
    instructions: "Does the `note` ask for cake?",
    criteria: { true: "Yes.", false: "No." },
  },
} as const;
type Question = keyof typeof QUESTIONS;
const SURFACE: RepeatLogSurface<[key: string]> = {
  windowMs: 60_000,
  firstLine: (kind, key) => `tea room: ${kind} key=${key}`,
  countLine: (kind, suppressed) => `tea room: ${kind} occurred ${String(suppressed)} more time(s)`,
};

type Response = Awaited<ReturnType<JevFetch>>;
type Deferred = { resolve: (response: Response) => void; reject: (error: unknown) => void };

function scored(tea: number, cake: number): Response {
  const text = JSON.stringify({
    answers: { wants_tea: { noul: tea }, wants_cake: { noul: cake } },
    echo: "SECRET-BODY",
  });
  return { ok: true, status: 200, text: async () => text };
}

function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertNoContent(lines: readonly string[]): void {
  for (const line of lines) {
    assert.ok(!line.includes("SECRET-"), `a log line carries content: ${line}`);
  }
}

function harness(overrides: { onResult?: (key: string, payload: number, result: JevResult<Question>) => void; log?: (message: string) => void } = {}) {
  const calls: Array<{ url: string; init: Parameters<JevFetch>[1] }> = [];
  const pending: Deferred[] = [];
  const logged: string[] = [];
  const results: Array<{ key: string; payload: number; result: JevResult<Question> }> = [];
  const fetch: JevFetch = (url, init) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  const client = createJevClient<Question, number>({
    apiKey: KEY,
    questions: QUESTIONS,
    repeatLog: SURFACE,
    fetch,
    log: overrides.log ?? ((message) => logged.push(message)),
    onResult: overrides.onResult ?? ((key, payload, result) => results.push({ key, payload, result })),
  });
  return { client, calls, pending, logged, results };
}

const NOTE: JevState = { note: "SECRET-NOTE tea please" };

test("the control: the no-content predicate fires on a line carrying a sentinel", () => {
  assert.throws(() => assertNoContent(["tea room: timeout key=x SECRET-NOTE"]));
  assert.doesNotThrow(() => assertNoContent(["tea room: timeout key=x"]));
});

test("the request goes to the constant host with both headers, the redirect refusal, and the caller's state and questions", async () => {
  const h = harness();
  h.client.submit("a", { note: "SECRET-NOTE", lines: ["SECRET-NOTE one", "SECRET-NOTE two"] }, 1);
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, JEV_URL);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Authorization"], `Bearer ${KEY}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, "error");
  assert.deepEqual(JSON.parse(init.body), {
    state: { note: "SECRET-NOTE", lines: ["SECRET-NOTE one", "SECRET-NOTE two"] },
    model: JEV_MODEL,
    questions: QUESTIONS,
  });
  h.pending[0].resolve(scored(0.9, 0.1));
  await settled();
  assert.deepEqual(h.results, [{ key: "a", payload: 1, result: { ok: true, answers: { wants_tea: 0.9, wants_cake: 0.1 } } }]);
  assert.deepEqual(h.logged, []);
});

test("no argument or setting redirects the host, and the module names no process object", () => {
  const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  assert.ok(!/\bprocess\b|node:process/.test(source), "client.ts reads no environment variable");
});

test("a secret in any text of the state, a field or one line of a list, is never sent and settles as screened", async () => {
  const states: Array<[string, JevState]> = [
    ["a string field", { note: `SECRET-NOTE password = "hunter2"` }],
    ["one line of a list", { lines: ["SECRET-NOTE fine", "SECRET-NOTE Bearer abcdefghij0123456789"] }],
    ["a second field", { note: "SECRET-NOTE fine", extra: "-----BEGIN RSA PRIVATE KEY-----" }],
  ];
  for (const [name, state] of states) {
    const h = harness();
    h.client.submit("a", state, 1);
    await settled();
    assert.equal(h.calls.length, 0, `${name} makes no call`);
    assert.deepEqual(h.results, [{ key: "a", payload: 1, result: { ok: false, kind: "screened" } }], name);
    assert.equal(h.logged.length, 1, name);
    assert.ok(h.logged[0].includes("screened") && h.logged[0].includes("key=a"), h.logged[0]);
    assertNoContent(h.logged);
  }
  assert.ok(SECRET_SCREEN.test("ghp_abcdefghij0123456789"), "the screen is the shared one");
});

test("a timeout, a non-2xx, a malformed body, a missing question and a network failure each settle as their kind, logged without content", async () => {
  const failures: Array<[string, (d: Deferred) => void, string]> = [
    ["timeout", (d) => d.reject(new DOMException("timed out", "TimeoutError")), "timeout"],
    ["non-2xx", (d) => d.resolve({ ok: false, status: 503, text: async () => "SECRET-BODY" }), "http 503"],
    ["not JSON", (d) => d.resolve({ ok: true, status: 200, text: async () => "SECRET-BODY" }), "malformed"],
    [
      "one question absent",
      (d) => d.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ answers: { wants_tea: { noul: 0.5 } }, echo: "SECRET-BODY" }) }),
      "malformed",
    ],
    ["network", (d) => d.reject(new Error("SECRET-BODY socket hang up")), "network"],
    ["body read failed", (d) => d.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("SECRET-BODY reset")) }), "network"],
  ];
  for (const [name, fail, kind] of failures) {
    const h = harness();
    assert.doesNotThrow(() => h.client.submit("a", NOTE, 1));
    fail(h.pending[0]);
    await settled();
    assert.deepEqual(h.results, [{ key: "a", payload: 1, result: { ok: false, kind } }], name);
    assert.equal(h.logged.length, 1, name);
    assert.ok(h.logged[0].includes(kind) && h.logged[0].includes("key=a"), `${name}: ${h.logged[0]}`);
    assertNoContent(h.logged);
  }
});

test("a fetch that throws rather than rejects is a network failure, not a throw into the caller", async () => {
  const logged: string[] = [];
  const results: string[] = [];
  const client = createJevClient<Question, number>({
    apiKey: KEY,
    questions: QUESTIONS,
    repeatLog: SURFACE,
    fetch: () => {
      throw new Error("SECRET-BODY boom");
    },
    log: (message) => logged.push(message),
    onResult: (_key, _payload, result) => results.push(result.ok ? "ok" : result.kind),
  });
  assert.doesNotThrow(() => client.submit("a", NOTE, 1));
  await settled();
  assert.deepEqual(results, ["network"]);
  assertNoContent(logged);
});

test("a submission in flight replaces the one waiting, the in-flight result is delivered, and the waiting one flies next", async () => {
  const h = harness();
  h.client.submit("a", NOTE, 1);
  h.client.submit("a", NOTE, 2);
  h.client.submit("a", NOTE, 3);
  h.client.submit("b", NOTE, 9);
  assert.equal(h.calls.length, 2, "one call per key in flight");
  h.pending[0].resolve(scored(0.9, 0.1));
  await settled();
  assert.deepEqual(h.results.map((r) => [r.key, r.payload]), [["a", 1]]);
  assert.equal(h.calls.length, 3, "the waiting submission flies, the replaced one never");
  h.pending[2].resolve(scored(0.1, 0.9));
  await settled();
  assert.deepEqual(h.results.map((r) => [r.key, r.payload]), [["a", 1], ["a", 3]]);
  h.client.submit("a", NOTE, 4);
  assert.equal(h.calls.length, 4, "once idle, the next submission opens a fresh call");
});

test("a handler that throws is logged as its own kind, and a log that throws loses the line and not the result", async () => {
  let handled = 0;
  const thrower = harness({
    onResult: () => {
      handled += 1;
      throw new Error("SECRET-BODY handler broke");
    },
  });
  thrower.client.submit("a", NOTE, 1);
  thrower.client.submit("a", NOTE, 2);
  thrower.pending[0].resolve(scored(0.9, 0.1));
  await settled();
  assert.equal(handled, 1);
  assert.equal(thrower.calls.length, 2, "the waiting submission still flies");
  assert.ok(thrower.logged[0].includes("verdict handler threw"), thrower.logged[0]);
  assertNoContent(thrower.logged);

  const written: string[] = [];
  const results: string[] = [];
  const client = createJevClient<Question, number>({
    apiKey: KEY,
    questions: QUESTIONS,
    repeatLog: SURFACE,
    fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    log: (message) => {
      written.push(message);
      throw new Error("SECRET-BODY log broke");
    },
    onResult: (_key, _payload, result) => results.push(result.ok ? "ok" : result.kind),
  });
  client.submit("a", NOTE, 1);
  await settled();
  assert.deepEqual(written.length, 1, "the failure line was attempted once");
  assert.deepEqual(results, ["timeout"], "and the result still reached the caller");
});

test("readAnswers reads one number per named question and refuses every malformed shape", () => {
  const body = (answers: unknown): string => JSON.stringify({ answers });
  assert.deepEqual(readAnswers(body({ a: { noul: 0 }, b: { noul: 1 } }), ["a", "b"]), { a: 0, b: 1 });
  assert.deepEqual(readAnswers(body({ a: { noul: 0.5 }, extra: { noul: 0.5 } }), ["a"]), { a: 0.5 }, "an extra answer is ignored");
  assert.equal(readAnswers("null", ["a"]), null);
  assert.equal(readAnswers("[]", ["a"]), null);
  assert.equal(readAnswers(body(null), ["a"]), null);
  assert.equal(readAnswers(body({ a: 0.5 }), ["a"]), null, "the number must sit under noul");
  assert.equal(readAnswers(body({ a: { noul: "0.5" } }), ["a"]), null);
  assert.equal(readAnswers(body({ a: { noul: 1.2 } }), ["a"]), null);
  assert.equal(readAnswers(body({ a: { noul: -0.1 } }), ["a"]), null);
  assert.equal(readAnswers(body({ a: { noul: null } }), ["a"]), null);
  assert.equal(readAnswers(body({ a: { noul: 0.5 } }), ["a", "b"]), null, "every named question must answer");
});
