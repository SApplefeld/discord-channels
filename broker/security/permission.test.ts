// Remote tool approval. Two properties carry the weight here: a verdict reaches the request it
// names and no other, and it reaches it once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePermissionId } from "../discord/permission-message.ts";
import type { ActionRow } from "../discord/question-message.ts";
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
  MAX_QUESTION_ALERTS_PER_WINDOW,
  MAX_QUESTION_PINGS_PER_WINDOW,
  createAlertVolume,
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
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
}

/**
 * A Discord write held open until the test releases it, which is what a call that has not come
 * back yet looks like from this side of the messenger.
 */
function heldWrite(): { until: Promise<void>; release: () => void } {
  let release = (): void => {};
  const until = new Promise<void>((settle) => {
    release = settle;
  });
  return { until, release };
}

function harness(
  options: {
    attach?: string[];
    outcomes?: Array<CallOutcome<{ messageId: string | null }>>;
    editOutcomes?: Array<CallOutcome<null>>;
    /** Holds every post past the first `after` of them until the test lets them through. */
    holdPosts?: { after: number; until: Promise<void> };
    /** Holds every edit past the first `after` of them until the test lets them through. */
    holdEdits?: { after: number; until: Promise<void> };
    /** Throws out of every edit past the first `after` of them, as a dead socket does. */
    throwEditsAfter?: number;
    now?: () => number;
  } = {},
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
  const edits: Array<{
    threadId: string;
    messageId: string;
    text: string;
    components?: readonly ActionRow[];
  }> = [];
  const outcomes = options.outcomes ?? [];
  const editOutcomes = options.editOutcomes ?? [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      if (options.holdPosts !== undefined && posts.length >= options.holdPosts.after) {
        await options.holdPosts.until;
      }
      posts.push(input);
      return outcomes.shift() ?? { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async (input) => {
      if (options.holdEdits !== undefined && edits.length >= options.holdEdits.after) {
        await options.holdEdits.until;
      }
      if (options.throwEditsAfter !== undefined && edits.length >= options.throwEditsAfter) {
        throw new Error("SECRET-the socket died mid-request");
      }
      edits.push(input);
      return editOutcomes.shift() ?? { status: "ok", value: null, rate: NO_RATE_INFO };
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
  /**
   * The nonce the desk minted for the prompt it last drew buttons on, read back off the wire the
   * way a press carries it: through the `custom_id` the components were built with.
   */
  const nonceOf = (requestId: string): string => {
    const drawn = edits.filter((edit) => (edit.components ?? []).length > 0).at(-1);
    assert.ok(drawn !== undefined, "the prompt was edited to carry its buttons");
    const reference = parsePermissionId(
      (drawn.components as ActionRow[])[0].components[0].custom_id,
    );
    assert.ok(reference !== null, "and the buttons carry an id this broker can read back");
    assert.equal(reference.requestId, requestId);
    return reference.nonce;
  };
  return { registry, relays, desk, posts, edits, alerts, notices, sent, logged, nonceOf };
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
  assert.equal(posts[0].mentionUserId, OPERATOR, "the prompt names the operator as its one mention");
  assert.match(posts[0].text, /^<@700000000000000002> /, "the mention leads the message");
  assert.match(posts[0].text, /`abcde`/, "the request id is what a verdict has to name");
  assert.match(posts[0].text, /Bash/);
  assert.match(posts[0].text, /run the migration/);
});

test("a verdict reaches the session that asked, as an allow or a deny", async () => {
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request());
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null);
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);

  await desk.request(TOKEN_A, request({ requestId: "qrstu" }));
  await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "deny" }, null);
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

  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "allow" }, null),
    false,
    "an unknown id consumed nothing, and says so",
  );
  assert.deepEqual(sent.get(TOKEN_A), [], "an unknown id matched nothing at all");

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  assert.equal((sent.get(TOKEN_A) as RelayEvent[]).length, 1, "the open request still answers");
});

test("an answered request is consumed, so the same verdict repeated does nothing", async () => {
  const { desk, sent } = harness();
  await desk.request(TOKEN_A, request());

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" }, null),
    false,
    "the replay found nothing open, which is the same answer an unknown id gets",
  );
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null);
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

  await desk.resolve(THREAD_B, { requestId: "abcde", behavior: "allow" }, null);
  assert.deepEqual(sent.get(TOKEN_A), [], "the other session's prompt is untouched");
  assert.deepEqual(sent.get(TOKEN_B), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);

  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" }, null);
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

  await desk.resolve(THREAD_A, { requestId: wanted[0], behavior: "allow" }, null);
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
  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null),
    true,
    "the request was answered, so the message is spent rather than left for another reading",
  );
  await desk.settled();
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

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), false);
  assert.deepEqual(sent.get(TOKEN_A), [], "nothing was approved on the strength of a guess");

  await desk.reportUnknownVerdict(THREAD_A, { requestId: "abcde", behavior: "allow" });
  assert.match(notices()[notices().length - 1].text, /No permission request `abcde` is open/);
});

test("an unmatched verdict says so in-thread, because silence reads as success from a phone", async () => {
  // The broker restarts at every logon and this table does not survive one, so an answer to a
  // prompt asked before the restart lands here. Dropping it in silence is indistinguishable, on a
  // phone, from an approval that worked. The report is its own call: a message of the verdict shape
  // has other readings, and only a caller that has exhausted them asks for this.
  const { desk, notices, sent, logged } = harness();
  assert.equal(await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "allow" }, null), false);
  assert.deepEqual(notices(), [], "resolving nothing writes nothing");

  await desk.reportUnknownVerdict(THREAD_A, { requestId: "qrstu", behavior: "allow" });
  assert.deepEqual(sent.get(TOKEN_A), []);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /`qrstu`/);
  assert.match(notices()[0].text, /keyboard/);
  assert.match(
    logged.join("\n"),
    /no request qrstu is open in thread 900000000000000001, dropping/,
    "the drop is on the record as well as in the thread",
  );
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
  await desk.resolve(THREAD_A, { requestId: wanted[wanted.length - 1], behavior: "allow" }, null);
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
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null);

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

  await desk.resolve(THREAD_A, { behavior: "allow", requestId: "abcde" }, null);
  assert.deepEqual([...desk.waiting()], [], "answering it stops the session waiting");
});

test("a prompt that never reached the operator does not leave a session looking parked", async () => {
  // A prompt the writer refused is not held open, so it must not be reported as waiting either:
  // the thread would claim a person owes an answer to a question never asked.
  const { desk } = harness({ outcomes: [{ status: "failed", error: "no", rate: NO_RATE_INFO }] });

  await desk.request(TOKEN_A, request());

  assert.deepEqual([...desk.waiting()], []);
});

test("an alert volume window pings, then quiets, then drops, per thread, and reopens", () => {
  let at = 1_000;
  const volume = createAlertVolume({ now: () => at, pingCeiling: 2, postCeiling: 4, windowMs: 60_000 });

  assert.equal(volume(THREAD_A), "ping");
  assert.equal(volume(THREAD_A), "ping");
  assert.equal(volume(THREAD_A), "quiet", "past the ping ceiling the write goes quiet");
  assert.equal(volume(THREAD_A), "quiet");
  assert.equal(volume(THREAD_A), "drop", "past the post ceiling nothing is written");
  assert.equal(volume(THREAD_A), "drop", "a drop spends no slot, so the window cannot re-arm itself");

  // Another thread holds its own window: a flood in one must not quiet or drop the other.
  assert.equal(volume(THREAD_B), "ping");

  // The stamps age out rather than accumulate, so a closed window restores the loud tier.
  at += 60_000;
  assert.equal(volume(THREAD_A), "ping");
});

test("the question alert's own ceilings ring once a window and stop writing at four", () => {
  // The live pair index.ts wires: one ping a window, because a question is not answerable from
  // the thread and one ping a minute is a person's reading pace for a go-to-the-console notice;
  // three quiet posts behind it; then nothing, because past that the only thing left to protect
  // is the channel and the post budget the permission prompts share. Its own instance, so this
  // run spends none of a permission window's slots.
  const volume = createAlertVolume({
    now: () => 1_000,
    pingCeiling: MAX_QUESTION_PINGS_PER_WINDOW,
    postCeiling: MAX_QUESTION_ALERTS_PER_WINDOW,
    windowMs: 60_000,
  });

  const levels = Array.from({ length: 6 }, () => volume(THREAD_A));
  assert.deepEqual(levels, ["ping", "quiet", "quiet", "quiet", "drop", "drop"]);
});

test("a posted prompt grows a Deny and an Allow, Deny leading and drawn danger", async () => {
  // The prompt posts as text and is edited to carry its controls, because the post is what yields
  // the message id an edit needs. Deny leads and is danger, Allow follows and is secondary: the
  // button a thumb lands on first is not the one that grants.
  const { desk, posts, edits } = harness();
  await desk.request(TOKEN_A, request());

  assert.equal(posts.length, 1, "the prompt is posted once");
  assert.equal(edits.length, 1, "and edited once, to attach the controls");
  assert.equal(edits[0].threadId, THREAD_A);
  assert.equal(edits[0].messageId, "msg-1");
  assert.equal(edits[0].text, posts[0].text, "the message reads as it did, the typed line included");
  const row = (edits[0].components as ActionRow[])[0];
  assert.deepEqual(
    row.components.map((component) => ({
      label: (component as { label: string }).label,
      style: (component as { style: number }).style,
    })),
    [
      { label: "Deny", style: 4 },
      { label: "Allow", style: 2 },
    ],
  );
});

test("a button press answers its request, both ways", async () => {
  const { desk, sent, nonceOf } = harness();
  await desk.request(TOKEN_A, request());
  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, nonceOf("abcde")),
    true,
  );

  await desk.request(TOKEN_A, request({ requestId: "qrstu" }));
  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "qrstu", behavior: "deny" }, nonceOf("qrstu")),
    true,
  );

  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
    { type: "permission", requestId: "qrstu", behavior: "deny" },
  ]);
});

test("a press carrying any nonce but the open request's own resolves to nothing", async () => {
  // The control the whole button path rests on. A request id is five letters, so a later prompt in
  // this thread can draw the id an answered message in scrollback still carries, and stripping that
  // message's buttons cannot be relied on: the strip is an edit, and an edit can be refused.
  const { desk, sent, notices, nonceOf } = harness();
  await desk.request(TOKEN_A, request());
  const nonce = nonceOf("abcde");

  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, `${nonce}0`),
    false,
    "a nonce that is not this request's answers nothing",
  );
  assert.deepEqual(sent.get(TOKEN_A), [], "no verdict reached the session");
  assert.deepEqual(notices(), [], "and nothing was written about it either");

  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" }, nonce),
    true,
    "the request is still open, so its own button still answers it",
  );
});

test("two prompts drawing the same request id in one thread carry different nonces", async () => {
  // The recycled-id case the nonce exists for: the first prompt's buttons name a nonce the second
  // prompt's request does not have, so a tap on the old message answers nothing.
  const { desk, sent, nonceOf } = harness();
  await desk.request(TOKEN_A, request());
  const first = nonceOf("abcde");
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "deny" }, first);

  await desk.request(TOKEN_A, request());
  const second = nonceOf("abcde");
  assert.notEqual(second, first, "each prompt is minted its own");

  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, first),
    false,
    "the answered message's button does not approve the request that replaced it",
  );
  assert.deepEqual(
    sent.get(TOKEN_A),
    [{ type: "permission", requestId: "abcde", behavior: "deny" }],
    "only the first verdict was ever delivered",
  );
});

test("a press naming a request open in another thread resolves to nothing", async () => {
  // The thread a press arrives in is the authority, never anything the custom_id carries: an id is
  // a string that travels, and the pair of them names one request in one thread or nothing at all.
  const { desk, sent, nonceOf } = harness();
  await desk.request(TOKEN_A, request());
  const nonce = nonceOf("abcde");

  assert.equal(
    await desk.resolve(THREAD_B, { requestId: "abcde", behavior: "allow" }, nonce),
    false,
  );
  assert.deepEqual(sent.get(TOKEN_A), [], "session A's request was not answered from another thread");
  assert.deepEqual(sent.get(TOKEN_B), []);
});

test("an answered prompt is rewritten and stripped, whichever way it was answered", async () => {
  // The typed path resolves the same entry the buttons do, so it clears the same message: a live
  // button over a request nothing holds is a tap that reports a failure and changes nothing.
  const { desk, edits } = harness();
  await desk.request(TOKEN_A, request());
  await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null);
  await desk.settled();

  assert.equal(edits.length, 2, "one edit attached the controls, one closed the prompt out");
  const closed = edits[1];
  assert.equal(closed.messageId, "msg-1");
  assert.deepEqual(closed.components, [], "the components are stripped");
  assert.match(closed.text, /Allowed/);
  assert.match(closed.text, /`abcde`/);
  assert.match(closed.text, /Bash/, "the thread keeps the record of which tool was allowed");
});

test("a refused close-out edit still leaves the verdict applied exactly once", async () => {
  // The verdict is recorded and delivered before the edit is attempted, so a Discord refusal costs
  // a stale message and nothing else. The entry is consumed either way, so a second answer to the
  // same request finds nothing to apply.
  const { desk, sent, logged } = harness({
    editOutcomes: [
      { status: "ok", value: null, rate: NO_RATE_INFO },
      { status: "failed", error: "message edit refused", rate: NO_RATE_INFO },
    ],
  });
  await desk.request(TOKEN_A, request());

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  await desk.settled();
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);
  assert.ok(
    logged.some((line) => line.includes("was answered but its prompt was not rewritten")),
    "the refusal is logged",
  );

  assert.equal(
    await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null),
    false,
    "the request is consumed, so it cannot be answered a second time",
  );
  assert.equal((sent.get(TOKEN_A) as RelayEvent[]).length, 1, "and the verdict was delivered once");
});

test("a prompt whose buttons could not be attached is still open to a typed verdict", async () => {
  // A refused attach costs the one tap, never the prompt: the whole message is in front of the
  // operator and the `y <id>` line still answers it.
  const { desk, sent, logged } = harness({
    editOutcomes: [{ status: "failed", error: "message edit refused", rate: NO_RATE_INFO }],
  });
  assert.equal(await desk.request(TOKEN_A, request()), true, "the prompt reached the operator");
  assert.ok(logged.some((line) => line.includes("kept the plain prompt")));

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);
});

test("a verdict is applied and delivered before the writes it leaves behind are waited on", async () => {
  // A press holds a Discord interaction open on this answer, and a callback has about three seconds
  // while the close-out rewrite is a round trip of its own. So the answer comes off the table and
  // the relay alone, and what the thread shows catches up behind `settled`.
  const rewrite = heldWrite();
  const { desk, sent, edits } = harness({ holdEdits: { after: 1, until: rewrite.until } });
  await desk.request(TOKEN_A, request());
  assert.equal(edits.length, 1, "the prompt is up and carrying its buttons");

  // Raced against a bound, so an answer that waits on Discord reads as a failure here rather than
  // as a test that never finishes.
  const applied = await Promise.race([
    Promise.resolve(desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null)),
    new Promise((settle) => setTimeout(() => settle("waited on a Discord write"), 200).unref()),
  ]);

  assert.equal(applied, true, "the verdict is reported the moment it is applied");
  assert.deepEqual(
    sent.get(TOKEN_A),
    [{ type: "permission", requestId: "abcde", behavior: "allow" }],
    "and the session already has it",
  );
  assert.equal(edits.length, 1, "while the prompt's rewrite is still on the wire");

  rewrite.release();
  await desk.settled();
  assert.equal(edits.length, 2, "which lands once Discord answers");
  assert.deepEqual(edits[1].components, [], "carrying the strip");
});

test("a close-out write that throws is logged, and its detail is not", async () => {
  // The rewrite runs behind the caller that applied the verdict rather than under it, so a throw
  // out of the transport has nobody left to report it to and would surface as an unhandled
  // rejection against whatever else is running. The detail goes unread: a serialized transport
  // error can carry the request it was made for, and that one carries the prompt.
  const { desk, sent, logged } = harness({ throwEditsAfter: 1 });
  await desk.request(TOKEN_A, request());

  assert.equal(desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  await desk.settled();

  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);
  assert.ok(
    logged.some((line) => line.includes("closing its prompt out threw")),
    logged.join("\n"),
  );
  assert.ok(!logged.join("\n").includes("SECRET"), "the error detail is withheld");
});

test("two requests for one prompt arriving together post it once", async () => {
  // The table is what makes a thread and an id one request, and the id comes from the tool use, so
  // a re-send is the same decision. Held only from after the post, a second request inside that
  // round trip would ping the operator again and mint a nonce over the first, leaving the message
  // already on their phone carrying buttons the desk answers to nothing.
  const { desk, alerts, edits, sent, nonceOf } = harness();

  const both = await Promise.all([
    desk.request(TOKEN_A, request()),
    desk.request(TOKEN_A, request()),
  ]);

  assert.deepEqual(both, [true, true], "both callers are told the prompt is up");
  assert.equal(alerts().length, 1, "one decision is one prompt");
  assert.equal(edits.length, 1, "and one set of buttons");
  assert.equal(
    desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, nonceOf("abcde")),
    true,
    "the buttons on the message the operator has answer the request the desk holds",
  );
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);
});

test("a prompt whose post reported no id is answerable, with nothing to draw on", async () => {
  // A 2xx whose body carried no readable message id: the prompt landed, so the request is open and
  // the typed verdict answers it, but there is no handle to attach buttons to or to rewrite.
  const { desk, edits, sent } = harness({
    outcomes: [{ status: "ok", value: { messageId: null }, rate: NO_RATE_INFO }],
  });

  assert.equal(await desk.request(TOKEN_A, request()), true, "the prompt reached the operator");
  assert.deepEqual(edits, [], "there is no message to draw the buttons on");

  assert.equal(desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  await desk.settled();
  assert.deepEqual(edits, [], "and none to rewrite on the way out");
  assert.deepEqual(sent.get(TOKEN_A), [
    { type: "permission", requestId: "abcde", behavior: "allow" },
  ]);
});

test("a verdict its session never received draws no tick over a tool that never ran", async () => {
  // The rewritten prompt is the loudest message in the thread and it replaces the only copy of the
  // request. An answer applied here that reached no session leaves that session parked, so the line
  // says so: the fail direction is a thread that still looks like it is waiting, never one that
  // reports a tool as allowed when nothing ran it.
  const { desk, edits, notices } = harness({ attach: [] });
  await desk.request(TOKEN_A, request());

  assert.equal(await desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
  await desk.settled();

  const closed = edits[1];
  assert.deepEqual(closed.components, [], "the components go either way");
  assert.match(closed.text, /Allowed, not delivered/);
  assert.doesNotMatch(closed.text, /✅/);
  assert.equal(notices().length, 1, "and the notice sends the operator to the keyboard");
});

/** Nothing in a cleared prompt may read as a verdict: the broker knows of none. */
const VERDICT_WORDING = /allow|deny|denied|approved|✅|⛔/i;

test("a session's turn ending clears the prompts it had open, and no other session's", async () => {
  // A prompt answered at the console is announced to this broker nowhere, so a turn that ended is
  // the only evidence that the session is no longer parked on the prompts it had open.
  let at = 1_000;
  const { desk, edits } = harness({ now: () => at });
  await desk.request(TOKEN_A, request());
  await desk.request(TOKEN_B, request({ requestId: "qrstu" }));
  assert.deepEqual([...desk.waiting()].sort(), ["session-a", "session-b"]);

  at += 1_000;
  desk.turnEnded("session-a", at);
  await desk.settled();

  assert.deepEqual([...desk.waiting()], ["session-b"], "only the session that stopped is cleared");
  assert.deepEqual(
    edits.filter((edit) => (edit.components ?? []).length === 0).map((edit) => edit.threadId),
    [THREAD_A],
    "and only its prompt was rewritten",
  );
  assert.equal(
    desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null),
    false,
    "the cleared request is no longer open",
  );
  assert.equal(
    desk.resolve(THREAD_B, { requestId: "qrstu", behavior: "allow" }, null),
    true,
    "and the other session's prompt is still answerable",
  );
});

test("a prompt raised after a turn ended survives it", async () => {
  // The ordering guard. A `Stop` in flight while a fresh prompt goes up must not take that prompt
  // with it: clearing an entry too early parks a session with nobody able to answer it, which is
  // the one direction this surface may not fail in.
  let at = 1_000;
  const { desk } = harness({ now: () => at });
  const stopped = at;
  at += 1_000;
  await desk.request(TOKEN_A, request());

  desk.turnEnded("session-a", stopped);
  await desk.settled();

  assert.deepEqual([...desk.waiting()], ["session-a"], "the newer prompt is still waiting");
  assert.equal(desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), true);
});

test("a session that has ended clears the prompts it left open", async () => {
  // The floor under the turn-end clear, for a session that dies without ending a turn. Nobody can
  // answer its prompt and it holds one of the host's open-request slots until it is dropped.
  const { desk, registry, edits } = harness();
  await desk.request(TOKEN_A, request());
  registry.relayClosed(TOKEN_A, "session-a");

  desk.sweepEnded();
  await desk.settled();

  assert.deepEqual([...desk.waiting()], []);
  assert.equal(desk.resolve(THREAD_A, { requestId: "abcde", behavior: "allow" }, null), false);
  assert.equal(edits.at(-1)?.threadId, THREAD_A, "its prompt says so");
});

test("a stale session keeps its open prompt", async () => {
  // Stale is revivable: a relay answering puts the session back to live, and a session parked on a
  // prompt is exactly one that has gone quiet. Only ended, which is terminal, clears.
  const { desk, registry } = harness();
  await desk.request(TOKEN_A, request());
  // The registry under this harness runs on the wall clock, so the state a sweep would write is
  // written here directly.
  const record = registry.list().find((held) => held.sessionId === "session-a");
  assert.ok(record !== undefined);
  record.state = "stale";

  desk.sweepEnded();
  await desk.settled();

  assert.deepEqual([...desk.waiting()], ["session-a"]);
});

test("a cleared prompt is rewritten with its buttons stripped, naming no verdict", async () => {
  // Live buttons over a request nothing holds are what lets one tap claim an answer the operator
  // never gave, and the broker knows the request resolved without knowing how, so the message says
  // only that.
  let at = 1_000;
  const { desk, edits } = harness({ now: () => at });
  await desk.request(TOKEN_A, request());
  at += 1_000;

  desk.turnEnded("session-a", at);
  await desk.settled();

  const closed = edits.at(-1);
  assert.ok(closed !== undefined);
  assert.equal(closed.messageId, "msg-1", "the prompt's own message is the one rewritten");
  assert.deepEqual(closed.components, [], "the buttons go");
  assert.match(closed.text, /No longer waiting/);
  assert.match(closed.text, /`abcde`/, "the request it stood for is still named");
  assert.match(closed.text, /Bash/);
  assert.doesNotMatch(closed.text, VERDICT_WORDING);
});

test("a turn ending while a prompt is still going up draws no buttons over it", async () => {
  // The clear can land between the post and the edit that grows the prompt's controls. What is left
  // in the thread is a prompt saying it is waiting, which is the direction this surface may fail in;
  // what must never be left is a live Allow and Deny over a request nothing holds, since one tap
  // then claims an answer the operator never gave. The prompt goes unrewritten here for the reason
  // an answered one does when its post reported no id: there is no message handle to rewrite.
  let at = 1_000;
  const posting = heldWrite();
  const { desk, edits } = harness({
    now: () => at,
    holdPosts: { after: 0, until: posting.until },
  });
  const inFlight = desk.request(TOKEN_A, request());

  at += 1_000;
  desk.turnEnded("session-a", at);
  posting.release();
  assert.equal(await inFlight, true, "the prompt itself still reached the operator");
  await desk.settled();

  assert.deepEqual([...desk.waiting()], []);
  assert.deepEqual(
    edits.filter((edit) => (edit.components ?? []).length > 0),
    [],
    "no controls were drawn on a prompt the desk had already let go",
  );
});

test("a cleared entry gives its slot back against the open-request ceiling", async () => {
  // The ceiling is host-wide and refuses the newest request, so an entry nobody can answer stops
  // every later prompt on the machine from reaching the operator.
  let at = 1_000;
  // Steps past the alert window on every read, so the per-thread prompt ceiling never binds.
  const { desk } = harness({
    now: () => {
      at += 120_000;
      return at;
    },
  });
  const wanted = ids(MAX_OPEN_REQUESTS + 2);
  for (const requestId of wanted.slice(0, MAX_OPEN_REQUESTS)) {
    assert.equal(await desk.request(TOKEN_A, request({ requestId })), true);
  }
  assert.equal(
    await desk.request(TOKEN_A, request({ requestId: wanted[MAX_OPEN_REQUESTS] })),
    false,
    "the table is full",
  );

  desk.turnEnded("session-a", at + 1);
  await desk.settled();

  assert.equal(
    await desk.request(TOKEN_A, request({ requestId: wanted[MAX_OPEN_REQUESTS + 1] })),
    true,
    "the cleared entries freed their slots",
  );
});
