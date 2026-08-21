// Behavioral cover for the blocked-state desk: the standing computation both toView call sites
// read, and the one pinging alert a block episode earns, with its freshness bound, its
// instant-keyed dedup, and its damping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BLOCKED_PING_FRESH_MS, MAX_POSTED_BLOCK_KEYS, createBlockedDesk } from "./blocked.ts";
import type { BlockedDesk, BlockedDeskOptions } from "./blocked.ts";
import { NO_RATE_INFO } from "./transport.ts";
import type { CallOutcome } from "./transport.ts";
import type {
  SessionEventReaderState,
  SessionGoalEvent,
} from "../board/events.ts";

const OPERATOR = "700000000000000002";

/** A fixed instant for the injected clock, so freshness is arithmetic rather than wall time. */
const NOW = 1_800_000_000_000;

function blockedAt(tsMs: number, plan = "docs/plans/widget_spec_v1.md"): SessionGoalEvent {
  return { event: "goal-blocked", ts: new Date(tsMs).toISOString(), tsMs, plan };
}

function completeAt(tsMs: number): SessionGoalEvent {
  return { event: "goal-complete", ts: new Date(tsMs).toISOString(), tsMs, plan: "docs/plans/done.md" };
}

/**
 * A reader seam that hands each tick the next fold in the list, repeating the last one, so a test
 * states the kept map directly instead of composing file bytes. `"unreadable"` hands the caller's
 * own state back the way the real read does.
 */
function reader(
  ...folds: Array<ReadonlyMap<string, SessionGoalEvent> | "unreadable">
): (previous: SessionEventReaderState) => { state: SessionEventReaderState; unreadable: boolean } {
  let at = 0;
  return (previous) => {
    const next = folds[Math.min(at, folds.length - 1)];
    at += 1;
    if (next === "unreadable") return { state: previous, unreadable: true };
    return {
      state: { offset: 0, identity: null, midLine: false, malformed: 0, latest: new Map(next) },
      unreadable: false,
    };
  };
}

type Posted = { threadId: string; text: string; mentionUserId: string | null };

/** The desk under test, its alert wire recorded and every collaborator injectable per test. */
function wired(overrides: Partial<BlockedDeskOptions> = {}): {
  desk: BlockedDesk;
  alerts: Posted[];
  logs: string[];
} {
  const alerts: Posted[] = [];
  const logs: string[] = [];
  const desk = createBlockedDesk({
    // Unused whenever a test injects `readEvents`; the default-path test below passes its own.
    eventsPath: path.join(os.tmpdir(), "never-read.jsonl"),
    threadFor: (sessionId) => `thread-${sessionId}`,
    alert: async (threadId, text, mentionUserId) => {
      alerts.push({ threadId, text, mentionUserId });
      return { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    operatorId: OPERATOR,
    now: () => NOW,
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { desk, alerts, logs };
}

test("a blocked event newer than the last engagement stands, and everything else does not", async () => {
  const { desk } = wired({
    readEvents: reader(
      new Map([
        ["s1", blockedAt(NOW - 1_000)],
        ["s2", completeAt(NOW - 1_000)],
      ]),
    ),
  });
  await desk.tick();

  assert.equal(desk.standing({ sessionId: "s1", lastEngagementAt: NOW - 2_000 }), true);
  // Strictly newer: an engagement at the block's own instant already answers it.
  assert.equal(desk.standing({ sessionId: "s1", lastEngagementAt: NOW - 1_000 }), false);
  assert.equal(desk.standing({ sessionId: "s1", lastEngagementAt: NOW }), false);
  assert.equal(desk.standing({ sessionId: "s2", lastEngagementAt: 0 }), false, "complete clears");
  assert.equal(desk.standing({ sessionId: "s3", lastEngagementAt: 0 }), false, "no event, no block");
});

test("a fresh block pings once, keyed on the instant rather than the stamp's spelling", async () => {
  // The same instant spelled two ways across ticks: `Date.parse` accepts unlimited spellings of
  // one instant, so a dedup keyed on the raw string would hand the key to whatever writes the file.
  const first = blockedAt(NOW - 5_000);
  const respelled: SessionGoalEvent = {
    ...first,
    ts: new Date(first.tsMs).toISOString().replace("Z", "+00:00"),
  };
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", first]]), new Map([["s1", respelled]])),
  });

  await desk.tick();
  await desk.tick();

  assert.equal(alerts.length, 1, "one episode, one alert, whatever the spelling");
  assert.equal(alerts[0].threadId, "thread-s1");
  assert.equal(alerts[0].mentionUserId, OPERATOR);
  assert.ok(alerts[0].text.startsWith(`<@${OPERATOR}> ⛔ **Blocked**`), alerts[0].text);
  assert.ok(alerts[0].text.includes("widget\\_spec\\_v1.md"), "the plan rides the alert, inert");
});

test("a new block instant is a new episode and pings again", async () => {
  const { desk, alerts } = wired({
    readEvents: reader(
      new Map([["s1", blockedAt(NOW - 8_000)]]),
      new Map([["s1", blockedAt(NOW - 2_000)]]),
    ),
  });

  await desk.tick();
  await desk.tick();

  assert.equal(alerts.length, 2, "a wake-and-re-block is a new episode");
});

test("a stale block does not ping and is not recorded as posted", async () => {
  const event = blockedAt(NOW - BLOCKED_PING_FRESH_MS - 1);
  let at = NOW;
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", event]])),
    now: () => at,
  });

  await desk.tick();
  assert.equal(alerts.length, 0, "a block older than the freshness bound is the title alone");

  // The injected clock is wound back to expose what no forward clock can: had the stale pass
  // recorded the episode as posted, this fresh view of the very same instant would stay silent.
  at = event.tsMs + 1_000;
  await desk.tick();
  assert.equal(alerts.length, 1, "the stale pass recorded nothing");
});

test("a block at exactly the freshness bound still pings", async () => {
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", blockedAt(NOW - BLOCKED_PING_FRESH_MS)]])),
  });
  await desk.tick();
  assert.equal(alerts.length, 1);
});

test("a session with no thread yet is retried next tick, and recorded only once it lands", async () => {
  let open = false;
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", blockedAt(NOW - 5_000)]])),
    threadFor: (sessionId) => (open ? `thread-${sessionId}` : null),
  });

  await desk.tick();
  assert.equal(alerts.length, 0, "nowhere to post yet, and no failure either");

  open = true;
  await desk.tick();
  assert.equal(alerts.length, 1, "the surface opened the thread, and the episode is still owed");

  await desk.tick();
  assert.equal(alerts.length, 1, "landed once, recorded once");
});

test("a refused post records nothing, spends nothing, and logs its trouble once", async () => {
  const outcomes: CallOutcome<{ messageId: string | null }>[] = [
    { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO },
    { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO },
    { status: "ok", value: { messageId: "msg-2" }, rate: NO_RATE_INFO },
  ];
  const calls: { text: string; mentionUserId: string | null }[] = [];
  const logs: string[] = [];
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", blockedAt(NOW - 5_000)]])),
    alert: async (_threadId, text, mentionUserId) => {
      calls.push({ text, mentionUserId });
      return outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    },
    log: (message) => logs.push(message),
  });
  const refusalLines = (): string[] =>
    logs.filter((line) => line.includes("session s1's blocked alert was not written"));

  await desk.tick();
  assert.equal(calls.length, 1);
  assert.equal(refusalLines().length, 1, logs.join("\n"));
  assert.ok(!logs.join("\n").includes("widget"), "the log names the session, never the plan");

  await desk.tick();
  assert.equal(calls.length, 2, "unrecorded, so the fold tries the episode again");
  assert.equal(refusalLines().length, 1, "the same stuck episode is not news twice");

  await desk.tick();
  assert.equal(calls.length, 3, "and once landed it is done");
  // The discriminating half of the refund: the ping ceiling is one, so a refusal that kept its
  // slot would arrive quiet here, a mention nobody was ever pinged for having spent.
  assert.equal(calls[2].mentionUserId, OPERATOR, "the refused attempts left the window unspent");
  assert.ok(calls[2].text.startsWith(`<@${OPERATOR}> `), calls[2].text);

  await desk.tick();
  assert.equal(calls.length, 3, "landed once, recorded once");
  assert.equal(alerts.length, 0, "this test's own wire replaced the recorder");
});

test("past the ping ceiling the alert lands without its mention, in text and whitelist alike", async () => {
  // Two episodes in one thread inside one window. The question alert's ceilings apply: one ping a
  // minute, and the second alert still lands, quietly.
  const { desk, alerts } = wired({
    readEvents: reader(
      new Map([
        ["s1", blockedAt(NOW - 5_000)],
        ["s2", blockedAt(NOW - 4_000)],
      ]),
    ),
    threadFor: () => "thread-shared",
  });

  await desk.tick();

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].mentionUserId, OPERATOR);
  assert.ok(alerts[0].text.startsWith(`<@${OPERATOR}> `), alerts[0].text);
  assert.equal(alerts[1].mentionUserId, null, "past the ping ceiling the alert goes quiet");
  assert.ok(!alerts[1].text.includes("<@"), alerts[1].text);
});

test("past the post ceiling nothing posts, and the drop is logged once, content-free", async () => {
  const fold = new Map(
    Array.from({ length: 5 }, (_unused, index): [string, SessionGoalEvent] => [
      `s${String(index + 1)}`,
      blockedAt(NOW - 5_000 - index),
    ]),
  );
  const { desk, alerts, logs } = wired({
    readEvents: reader(fold),
    threadFor: () => "thread-shared",
  });
  const dropLines = (): string[] => logs.filter((line) => line.includes("blocked alert is over its window"));

  await desk.tick();

  assert.equal(alerts.length, 4, "the question alert's post ceiling holds here too");
  assert.equal(dropLines().length, 1, logs.join("\n"));
  assert.ok(!logs.join("\n").includes("widget"), "the drop line names the session, never the plan");

  // The clock stands still, so the window is still full and the fifth episode still drops; the
  // retry is the ping pass's ordinary walk, not news, and the log says nothing new.
  await desk.tick();
  assert.equal(alerts.length, 4);
  assert.equal(dropLines().length, 1, "a second tick over the same still-dropped episode logs nothing");
});

test("the ping keys on the episode, not the standing state an engagement already cleared", async () => {
  // A mid-queue block: the continuing turn's first tool call stamps engagement past the emit, so
  // the session never renders blocked, and the ping is deliberately still owed.
  const { desk, alerts } = wired({
    readEvents: reader(new Map([["s1", blockedAt(NOW - 5_000)]])),
  });

  await desk.tick();

  assert.equal(desk.standing({ sessionId: "s1", lastEngagementAt: NOW }), false);
  assert.equal(alerts.length, 1, "standing gates the rendered state, never the episode's ping");
});

test("an unreadable stream is logged once per outage, not once per tick", async () => {
  const { desk, logs } = wired({
    readEvents: reader(
      "unreadable",
      "unreadable",
      new Map<string, SessionGoalEvent>(),
      "unreadable",
    ),
  });
  const outageLines = (): string[] =>
    logs.filter((line) => line.includes("could not read the goal event stream"));

  await desk.tick();
  await desk.tick();
  assert.equal(outageLines().length, 1, "a standing failure costs the log one line");

  await desk.tick();
  await desk.tick();
  assert.equal(outageLines().length, 2, "a new outage after a recovery is news again");
});

test("the posted-key set is bounded: an evicted episode still in the fold pings again", async () => {
  // The eviction's observable cost, pinned as the accepted trade it is: once enough later episodes
  // push a key out, a still-fresh block whose key was evicted posts a second time.
  const flood = new Map(
    Array.from({ length: MAX_POSTED_BLOCK_KEYS - 1 }, (_unused, index): [string, SessionGoalEvent] => [
      `b${String(index)}`,
      blockedAt(NOW - 10_000 - index),
    ]),
  );
  const { desk, alerts } = wired({
    readEvents: reader(
      new Map([["a", blockedAt(NOW - 5_000)]]),
      flood,
      new Map([["c", blockedAt(NOW - 6_000)]]),
      new Map([["a", blockedAt(NOW - 5_000)]]),
    ),
  });

  await desk.tick();
  assert.equal(alerts.length, 1, "the first episode lands and is recorded");

  await desk.tick();
  assert.equal(alerts.length, MAX_POSTED_BLOCK_KEYS, "the flood fills the set exactly to its cap");

  await desk.tick();
  assert.equal(alerts.length, MAX_POSTED_BLOCK_KEYS + 1, "one over the cap evicts the oldest key");

  await desk.tick();
  const reposts = alerts.filter((posted) => posted.threadId === "thread-a");
  assert.equal(reposts.length, 2, "the evicted episode, still fresh in the fold, posts again");
});

test("the default read walks the configured path, and an absent file is the quiet ordinary case", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-blocked-desk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "kit-events.jsonl");
  const { desk, alerts, logs } = wired({ eventsPath });

  await desk.tick();
  assert.equal(alerts.length, 0, "nothing written yet is not a failure");
  assert.equal(logs.length, 0, "and not a log line either");

  writeFileSync(
    eventsPath,
    JSON.stringify({
      ts: new Date(NOW - 5_000).toISOString(),
      event: "goal-blocked",
      project: "D:\\somewhere",
      plan: "docs/plans/p.md",
      session: "s1",
    }) + "\n",
    "utf8",
  );
  await desk.tick();

  assert.equal(alerts.length, 1, "the real reader feeds the same ping path the seam does");
  assert.equal(alerts[0].threadId, "thread-s1");
  assert.ok(alerts[0].text.includes("docs/plans/p.md"), alerts[0].text);
  assert.equal(desk.standing({ sessionId: "s1", lastEngagementAt: NOW - 10_000 }), true);
});
