// Remote tool approval. Two properties carry the weight here: a verdict reaches the request it
// names and no other, and it reaches it once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { createRelayHub } from "../routing/relays.ts";
import type { RelayEvent } from "../routing/relays.ts";
import { createThreadWriter } from "../routing/writer.ts";
import {
  MAX_ALERTS_PER_WINDOW,
  MAX_OPEN_REQUESTS,
  MAX_PROMPTS_PER_WINDOW,
  createPermissionDesk,
  parseVerdict,
} from "./permission.ts";

const OPERATOR = "700000000000000002";
const TOKEN_A = "11111111-2222-3333-4444-555555555555";
const TOKEN_B = "99999999-8888-7777-6666-555555555555";
const THREAD_A = "900000000000000001";
const THREAD_B = "900000000000000002";

function announce(registry: Registry, processToken: string, sessionId: string): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    sessionId,
    source: "startup",
    toolName: null,
  });
}

function harness(
  options: { attach?: string[]; outcomes?: Array<CallOutcome<null>>; now?: () => number } = {},
) {
  const now = options.now ?? ((): number => 1_000);
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, TOKEN_A, "session-a");
  announce(registry, TOKEN_B, "session-b");
  const relays = createRelayHub({ registry, graceMs: 10_000 });
  const sent = new Map<string, RelayEvent[]>();
  for (const token of options.attach ?? [TOKEN_A, TOKEN_B]) {
    const events: RelayEvent[] = [];
    sent.set(token, events);
    relays.attach(token, {
      send: (event) => {
        if (event.type !== "hello") events.push(event);
        return true;
      },
      close: () => {},
    });
  }
  const posts: Array<{ threadId: string; text: string; mentionUserId?: string }> = [];
  const outcomes = options.outcomes ?? [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return outcomes.shift() ?? { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const logged: string[] = [];
  const desk = createPermissionDesk({
    registry,
    relays,
    threadFor: (sessionId) =>
      sessionId === "session-a" ? THREAD_A : sessionId === "session-b" ? THREAD_B : null,
    writer: createThreadWriter({ messenger, now }),
    operatorId: OPERATOR,
    now,
    log: (message) => logged.push(message),
  });
  /** Just the prompts, which is what the mention distinguishes from a notice. */
  const alerts = (): typeof posts => posts.filter((post) => post.mentionUserId !== undefined);
  /** Just the broker-authored notices, which is where a dropped prompt has to become visible. */
  const notices = (): typeof posts => posts.filter((post) => post.mentionUserId === undefined);
  return { registry, relays, desk, posts, alerts, notices, sent, logged };
}

function request(overrides: Partial<{ requestId: string; toolName: string; description: string; inputPreview: string }> = {}) {
  return {
    requestId: "abcde",
    toolName: "Bash",
    description: "run the migration",
    inputPreview: "{ command: npm run migrate }",
    ...overrides,
  };
}

test("a verdict is read off a message, and its id is lowercased", () => {
  assert.deepEqual(parseVerdict("y abcde"), { behavior: "allow", requestId: "abcde" });
  assert.deepEqual(parseVerdict("YES ABCDE"), { behavior: "allow", requestId: "abcde" });
  assert.deepEqual(parseVerdict("  n  qrstu  "), { behavior: "deny", requestId: "qrstu" });
  assert.deepEqual(parseVerdict("No\tqrstu"), { behavior: "deny", requestId: "qrstu" });
});

test("prose that merely contains a verdict is not one", () => {
  // The pattern is anchored at both ends. A message that happens to carry a verdict is something
  // the operator wrote for Claude, and consuming it would both swallow the message and answer a
  // prompt they were not answering.
  assert.equal(parseVerdict("y abcde please"), null);
  assert.equal(parseVerdict("go ahead, y abcde"), null);
  assert.equal(parseVerdict("yabcde"), null);
  assert.equal(parseVerdict("y abcd"), null, "four letters is not a request id");
  assert.equal(parseVerdict("y abcdef"), null, "six letters is not a request id");
  assert.equal(parseVerdict("y ablde"), null, "the id alphabet has no l in it");
  assert.equal(parseVerdict("y abc1e"), null);
  assert.equal(parseVerdict("maybe abcde"), null);
  assert.equal(parseVerdict(""), null);
});

test("a request is posted into its session's thread, mentioning the operator", async () => {
  const { desk, posts } = harness();
  await desk.request(TOKEN_A, request());

  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadId, THREAD_A);
  assert.equal(posts[0].mentionUserId, OPERATOR, "the prompt is the one message that pings");
  assert.match(posts[0].text, /^<@700000000000000002> /, "the mention leads the message");
  assert.match(posts[0].text, /`abcde`/, "the request id is what a verdict has to name");
  assert.match(posts[0].text, /Bash/);
  assert.match(posts[0].text, /run the migration/);
});

test("a verdict reaches the session that asked, as an allow or a deny", async () => {
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request());
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);

  await desk.request(TOKEN_A, request({ requestId: "qrstu" }));
  await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "deny" });
  assert.deepEqual((sent.get(TOKEN_A) as RelayEvent[])[1], {
    type: "permission",
    requestId: "qrstu",
    behavior: "deny",
  });
});

test("a well-formed verdict naming no open request is dropped, not applied to another", async () => {
  // The whole hazard: the operator mistypes one letter, or answers a prompt that has already been
  // dealt with, and a session is handed an approval for a tool call nobody looked at.
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request({ requestId: "abcde" }));

  await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), [], "an unknown id matched nothing at all");

  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });
  assert.equal((sent.get(TOKEN_A) as RelayEvent[]).length, 1, "the open request still answers");
});

test("an answered request is consumed, so the same verdict repeated does nothing", async () => {
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request());

  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" });
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });
  assert.deepEqual(
    sent.get(TOKEN_A),
    [{ type: "permission", requestId: "abcde", behavior: "allow" }],
    "a replayed verdict cannot reverse or repeat the answer",
  );
});

test("a verdict answers only a request open in the thread it was typed in", async () => {
  // Claude Code derives the five letters from a tool use, so two sessions on one host can mint the
  // same id. Keyed on the id alone, one session's answer would arrive at the other's prompt.
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request({ requestId: "abcde", toolName: "Read" }));
  await desk.request(TOKEN_B, request({ requestId: "abcde", toolName: "Bash" }));

  await desk.resolve(THREAD_B, { requestId: "abcde", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), [], "the other session's prompt is untouched");
  assert.deepEqual(sent.get(TOKEN_B), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);

  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" });
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "deny" },
  ]);
});

test("the same request arriving twice pings once", async () => {
  const { desk, posts } = harness();
  await desk.request(TOKEN_A, request());
  await desk.request(TOKEN_A, request());
  await desk.request(TOKEN_A, request({ description: "a different description" }));
  assert.equal(posts.length, 1, "one decision earns one notification");
});

test("a request id no verdict could ever name is refused rather than posted", async () => {
  const { desk, posts } = harness();
  await desk.request(TOKEN_A, request({ requestId: "ABCDE" }));
  await desk.request(TOKEN_A, request({ requestId: "ablde" }));
  await desk.request(TOKEN_A, request({ requestId: "abcdef" }));
  assert.deepEqual(posts, [], "a prompt the operator cannot answer is not worth waking them for");
});

test("a request from a session with no thread is not posted anywhere", async () => {
  const { desk, posts } = harness();
  await desk.request("00000000-0000-0000-0000-000000000000", request());
  assert.deepEqual(posts, []);
});

/** Distinct five-letter ids drawn from the alphabet Claude Code uses, which has no `l`. */
function ids(count: number): string[] {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const built: string[] = [];
  for (let index = 0; index < count; index += 1) {
    built.push(`${letters[Math.floor(index / letters.length)]}${letters[index % letters.length]}xyz`);
  }
  return built;
}

/** A clock that never lets the alert window close, so the ceiling is the thing under test. */
function frozen(): () => number {
  return () => 1_000;
}

/** A clock that steps past the alert window on every read, so the ceiling never binds. */
function unhurried(): () => number {
  let at = 1_000;
  return () => {
    at += 120_000;
    return at;
  };
}

test("the open-request table refuses the newest rather than dropping the oldest", async () => {
  // The oldest is the request a session has been parked on longest. Evicting it to make room
  // answers the wrong question and leaves the session that has waited most with no way back.
  const wanted = ids(MAX_OPEN_REQUESTS + 1);
  const { desk, sent } = harness({ now: unhurried() });
  const accepted: boolean[] = [];
  for (const requestId of wanted) accepted.push(await desk.request(TOKEN_A, request({ requestId })));

  assert.equal(accepted.filter(Boolean).length, MAX_OPEN_REQUESTS);
  assert.equal(accepted[accepted.length - 1], false, "the newest is the one refused");

  await desk.resolve(THREAD_A, { requestId: wanted[0], behavior: "allow" });
  assert.equal(
    (sent.get(TOKEN_A) as RelayEvent[]).length,
    1,
    "the oldest request is still open and still answerable",
  );
});

test("a verdict for a session whose relay has gone is answered in-thread, not thrown", async () => {
  const { desk, relays, notices } = harness();
  await desk.request(TOKEN_A, request());
  relays.closeAll();
  await assert.doesNotReject(() => desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }));
  assert.equal(notices().length, 1, "an answer that went nowhere is not reported as success");
  assert.match(notices()[0].text, /no channel connected/);
});

test("a prompt that could not be posted is not held open, and is re-postable", async () => {
  // The expensive shape. Holding a request whose prompt never landed makes its id deduplicate
  // against a message that does not exist, so every later attempt returns without trying and the
  // session stays parked with a log line as the only trace.
  const { desk, alerts, notices } = harness({
    outcomes: [{ status: "rate-limited", rate: { remaining: 0, resetAfterMs: 0, retryAfterMs: 0 } }],
  });

  assert.equal(await desk.request(TOKEN_A, request()), false, "a dropped prompt reports as dropped");
  assert.equal(alerts().length, 1, "the post was attempted");
  assert.equal(notices().length, 1, "the operator is told the prompt did not land");
  assert.match(notices()[0].text, /could not be posted/);

  assert.equal(await desk.request(TOKEN_A, request()), true, "the re-send is attempted, not swallowed");
  assert.equal(alerts().length, 2);
});

test("a verdict for a prompt that never landed is answered rather than silently dropped", async () => {
  // The clock steps past the notice floor between the two, so this observes the verdict's own
  // answer rather than the undelivered-prompt notice that precedes it.
  let at = 1_000;
  const { desk, sent, notices } = harness({
    now: () => at,
    outcomes: [{ status: "failed", error: "HTTP 500", rate: NO_RATE_INFO }],
  });
  await desk.request(TOKEN_A, request());
  at += 120_000;

  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), [], "nothing was approved on the strength of a guess");
  assert.match(notices()[notices().length - 1].text, /No permission request `abcde` is open/);
});

test("an unmatched verdict says so in-thread, because silence reads as success from a phone", async () => {
  // The broker restarts at every logon and this table does not survive one, so an answer to a
  // prompt asked before the restart lands here. Dropping it in silence is indistinguishable, on a
  // phone, from an approval that worked.
  const { desk, notices, sent } = harness();
  await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), []);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /`qrstu`/);
  assert.match(notices()[0].text, /keyboard/);
});

test("a run of prompts stops ringing but keeps arriving, and is still answerable", async () => {
  // A local process that wins the pipe race can author these, and they are the one message the
  // operator is trained to answer fast. Going quiet costs nothing: the prompt is still there. Not
  // posting it at all would park the session, which is the failure this project exists to prevent,
  // so the ping ceiling and the post ceiling are different numbers.
  const wanted = ids(MAX_ALERTS_PER_WINDOW + 4);
  let at = 1_000;
  const { desk, posts, alerts, sent } = harness({ now: () => at });
  const accepted: boolean[] = [];
  for (const requestId of wanted) {
    at += 100;
    accepted.push(await desk.request(TOKEN_A, request({ requestId })));
  }

  assert.equal(alerts().length, MAX_ALERTS_PER_WINDOW, "only the first few ring the phone");
  assert.equal(posts.length, wanted.length, "every prompt still landed in the thread");
  assert.ok(accepted.every(Boolean), "no session was left parked to keep the phone quiet");

  // The quiet ones are real prompts, not decoration.
  await desk.resolve(THREAD_A, { requestId: wanted[wanted.length - 1], behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: wanted[wanted.length - 1], behavior: "allow" },
  ]);

  at += 60_000;
  await desk.request(TOKEN_A, request({ requestId: "zzzzz" }));
  assert.equal(alerts().length, MAX_ALERTS_PER_WINDOW + 1, "the window reopens and it rings again");
});

test("a flood past what any person could answer is dropped to protect the channel", async () => {
  // Past this the writes are only starving the replies and notices that share the bucket. This is
  // the last resort, well clear of the ping ceiling, because a dropped prompt parks its session.
  let at = 1_000;
  const { desk, posts } = harness({ now: () => at });
  const accepted: boolean[] = [];
  for (const requestId of ids(MAX_PROMPTS_PER_WINDOW + 5)) {
    at += 10;
    accepted.push(await desk.request(TOKEN_A, request({ requestId })));
  }
  assert.equal(posts.length, MAX_PROMPTS_PER_WINDOW);
  assert.equal(accepted.filter(Boolean).length, MAX_PROMPTS_PER_WINDOW);
  assert.equal(accepted[accepted.length - 1], false, "a dropped prompt reports as dropped");
});

test("one thread's run of prompts does not silence another session's", async () => {
  let at = 1_000;
  const { desk, alerts } = harness({ now: () => at });
  for (const requestId of ids(MAX_ALERTS_PER_WINDOW + 3)) {
    at += 100;
    await desk.request(TOKEN_A, request({ requestId }));
  }
  await desk.request(TOKEN_B, request({ requestId: "zzzzz" }));
  assert.equal(
    alerts().filter((post) => post.threadId === THREAD_B).length,
    1,
    "the ceiling is per thread, so a noisy session cannot hold an urgent prompt hostage",
  );
});

test("the ping ceiling is spent on attempts, not on a single prompt repeated", async () => {
  const { desk, alerts } = harness({ now: frozen() });
  for (let attempt = 0; attempt < MAX_ALERTS_PER_WINDOW + 3; attempt += 1) {
    await desk.request(TOKEN_A, request());
  }
  assert.equal(alerts().length, 1, "one decision is one prompt, whatever it costs to re-send it");
});

test("the log names what was approved, in which session, and by which tool", async () => {
  // This line is the only record of a tool call approved from a phone. An auditor reading it later
  // has no other way to answer "what did I let run, and where".
  const { desk, logged } = harness();
  await desk.request(TOKEN_A, request({ requestId: "abcde", toolName: "Bash" }));
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" });

  const line = logged.find((entry) => entry.includes("abcde") && entry.includes("answered"));
  assert.notEqual(line, undefined, logged.join("\n"));
  assert.match(line as string, /allow/);
  assert.match(line as string, /Bash/);
  assert.match(line as string, /session-a/);
});

test("a session with an unanswered prompt is reported as waiting, and stops when it is answered", async () => {
  // This is what feeds the `needs you` thread state. Without it the thread list shows a session
  // parked on a prompt as idle, indistinguishable from one that is merely quiet, so the one state
  // the dashboard exists to surface is the one it cannot show.
  const { desk } = harness();

  assert.deepEqual([...desk.waiting()], [], "nothing is waiting before a prompt is posted");

  await desk.request(TOKEN_A, request());
  assert.deepEqual([...desk.waiting()], ["session-a"], "the session is parked on its prompt");

  await desk.resolve(THREAD_A, { behavior: "allow", requestId: "abcde" });
  assert.deepEqual([...desk.waiting()], [], "answering it stops the session waiting");
});

test("a prompt that never reached the operator does not leave a session looking parked", async () => {
  // A prompt the writer refused is not held open, so it must not be reported as waiting either:
  // the thread would claim a person owes an answer to a question never asked.
  const { desk } = harness({ outcomes: [{ status: "failed", error: "no", rate: NO_RATE_INFO }] });

  await desk.request(TOKEN_A, request());

  assert.deepEqual([...desk.waiting()], []);
});
