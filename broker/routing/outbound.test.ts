// The outbound path. Its one load-bearing property is that a reply is addressed by session and by
// nothing else, which is what lets Claude reply unprompted and still land in the right thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  MAX_MESSAGE_LENGTH,
  appendNarration,
  renderAnswer,
  renderMirror,
  renderPeerIn,
  renderPeerInBrief,
  renderPeerOut,
  renderPeerOutBrief,
  renderTaskNotice,
} from "../discord/render.ts";
import { createBlockedDesk } from "../discord/blocked.ts";
import type { SessionGoalEvent } from "../board/events.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { NEAR_MATCH_THRESHOLD, normalizeForSketch, similarity, sketchOf } from "../similarity.ts";
import {
  ANSWER_LENGTH_ALLOWANCE,
  PEER_BODY_UNREADABLE,
  PEER_NAME_FALLBACK,
  PROMPT_SETTLE_GRACE_MS,
  createEchoMemory,
} from "../tail.ts";
import type { EchoMemory, PeerTraffic } from "../tail.ts";
import { MAX_RUN_WAIT_MS, RUN_PACE_MS, createOutboundRouter } from "./outbound.ts";
import type { OutboundRouter, OutboundRouterOptions } from "./outbound.ts";
import { createThreadWriter } from "./writer.ts";
import type { ThreadWriter } from "./writer.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";

/**
 * A router whose waiting costs nothing, which is what every test not measuring the pacing itself
 * wants: a split run spaces its posts by `RUN_PACE_MS`, so a real timer would spend seconds of
 * suite time per multi-message run to prove something about the renderer or the routing. A test
 * that is about the waiting passes its own `sleep` and overrides this one.
 */
function routerFor(options: OutboundRouterOptions): OutboundRouter {
  return createOutboundRouter({ sleep: async (): Promise<void> => {}, ...options });
}

// The source matters to the registry: a startup arriving under a token a live session already
// holds is a subprocess of that session and registers nothing, so a test that means to replace the
// session under a token announces the replacement the way a /clear does.
function announce(
  registry: Registry,
  sessionId: string,
  processToken = TOKEN,
  source = "startup",
): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    sessionId,
    source,
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
}

function fakeWriter(outcome?: CallOutcome<{ messageId: string }>) {
  const posts: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return outcome ?? { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  return { writer: createThreadWriter({ messenger, now: () => 1_000 }), posts };
}

/** What a posted message says, without the attribution line the renderer opened it with. */
function said(message: string): string {
  return message.slice(message.indexOf("\n") + 1);
}

test("a reply is posted to the thread bound to the session holding the process token", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.reply(TOKEN, "the migration is done"), { status: "sent" });
  assert.deepEqual(posts, [
    { threadId: THREAD, text: renderAnswer("the migration is done")[0] },
  ]);
});

test("a reply tool post says who wrote it, in a line of its own", async () => {
  // Posted bare, it reads as a continuation of whatever sits above it in the thread, which is a
  // mirrored prompt or a mirrored reply as often as not.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  await router.reply(TOKEN, "the migration is done");

  const posted = posts[0].text;
  assert.equal(said(posted), "the migration is done");
  assert.match(posted.split("\n")[0], /Claude/, posted);
  // Told apart from a mirrored reply at a glance, which is the whole point of a second header.
  assert.notEqual(posted.split("\n")[0], renderMirror("reply", "x")[0].split("\n")[0]);
});

test("a reply after a clear goes to the new session's thread, not the old one", async () => {
  // The relay is a child of the process and survives a /clear untouched, so the process token is
  // unchanged while the session, and therefore the thread, is not. Routing by session is what makes
  // this land in the right place.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  announce(registry, "session-b", TOKEN, "clear");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? "old-thread" : "new-thread"),
    mirrorWriter: writer,
  });

  await router.reply(TOKEN, "still here");
  assert.deepEqual(posts, [{ threadId: "new-thread", text: renderAnswer("still here")[0] }]);
});

test("a reply from a process with no announced session is reported, not guessed at", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "no-session" });
  assert.deepEqual(posts, [], "no thread is written to on a guess");
});

test("a reply from a session with no thread yet is reported rather than queued", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => null, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "no-thread" });
  assert.deepEqual(posts, []);
});

test("a reply is neutralized before it is posted", async () => {
  // The reply is Claude's own output, steered by whatever arrived from Discord, so it is untrusted
  // like any other string reaching a Discord surface. Markdown survives, because a reply is prose
  // the operator reads; the invisible class does not.
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  await router.reply(TOKEN, `done${zeroWidth}: **two** files${rightToLeftOverride}`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadId, THREAD);
  assert.equal(said(posts[0].text), "done: **two** files");
});

test("a mirrored prompt and reply post to the thread bound to the token's session", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", "session-a"), {
    status: "sent",
  });
  assert.deepEqual(await router.mirror(TOKEN, "reply", "the migration is done", "session-a"), {
    status: "sent",
  });
  // What the renderer composed, posted as it composed it: the attribution rides on the message
  // rather than being added anywhere downstream, where it would spend budget nothing measured.
  assert.deepEqual(posts, [
    { threadId: THREAD, text: renderMirror("prompt", "run the migration")[0] },
    { threadId: THREAD, text: renderMirror("reply", "the migration is done")[0] },
  ]);
  assert.ok(posts[0].text.includes("console"), posts[0].text);
  assert.ok(posts[1].text.includes("Claude"), posts[1].text);
});

test("a mirror post with no session or no thread is dropped, not queued", async () => {
  // The same outcomes as reply, for the same reason: by the time a thread existed the mirrored
  // turn would be stale.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { writer, posts } = fakeWriter();
  const orphan = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });
  assert.deepEqual(await orphan.mirror(TOKEN, "prompt", "hello", null), { status: "no-session" });

  announce(registry, "session-a");
  const unbound = routerFor({ registry, threadFor: () => null, mirrorWriter: writer });
  assert.deepEqual(await unbound.mirror(TOKEN, "reply", "hello", null), { status: "no-thread" });

  assert.deepEqual(posts, []);
});

test("a straggler mirror post naming a replaced session is dropped, not re-credited", async () => {
  // A /clear fires SessionStart with a new session_id under the same process token, and a late
  // Stop mirror post from the replaced session can arrive after that. Resolved on the token
  // alone it would be credited to the new record and post the previous conversation's reply into
  // the new session's thread.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  announce(registry, "session-b", TOKEN, "clear");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: () => "new-thread",
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "the old conversation's reply", "session-a"), {
    status: "no-session",
  });
  assert.deepEqual(posts, [], "the replaced session's text must not reach the new thread");

  // The same payload naming the current session delivers.
  await router.mirror(TOKEN, "reply", "current, named", "session-b");
  assert.deepEqual(posts, [
    { threadId: "new-thread", text: renderMirror("reply", "current, named")[0] },
  ]);
});

test("a mirror post that names no session of its own is dropped, not delivered", async () => {
  // The gate is closed rather than open, because the post it cannot attribute is the reachable
  // case: every process a session spawns inherits its token, so a claude running as a subprocess
  // mirrors a conversation of its own, often in another repository, under the parent's token. A
  // delivery would put that text in the operator's thread as the parent's own words and nothing
  // could take it back, while a drop is a line in the log.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const secret = "SECRET-from-a-conversation-nobody-asked-for";
  assert.deepEqual(await router.mirror(TOKEN, "reply", secret, null), { status: "no-session" });
  assert.deepEqual(posts, [], "an unattributable post reaches no thread");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("named no session"), lines[0]);
  assert.ok(lines[0].includes("session-a"), "the thread it would have landed in is named");
  assert.ok(!lines[0].includes(secret), `mirror content leaked into the routing log: ${lines[0]}`);
});

test("a mirror post from the parent still reaches its thread after a subprocess announced", async () => {
  // A claude run as a subprocess inherits CHANNEL_PROCESS_TOKEN and announces its own session ID
  // under the parent's token. Were that a supersession, the token would move to the subprocess, the
  // parent's thread would stop being what the token resolves to, and every one of the parent's
  // remaining prompts and replies would meet the straggler gate above as a session the token no
  // longer holds: mirroring stops for the rest of that session, silently.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-parent");
  // The parent's own relay pipe, which is what marks it as a real launch: the registry declines a
  // subprocess only for a session a relay has attached to.
  registry.relaySeen(TOKEN);
  announce(registry, "session-subprocess");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: (sessionId) => (sessionId === "session-parent" ? THREAD : "child-thread"),
    mirrorWriter: writer,
  });

  assert.equal(registry.list().length, 1, "no thread is opened for a session with no record");
  assert.deepEqual(
    await router.mirror(TOKEN, "reply", "the parent is still working", "session-parent"),
    { status: "sent" },
  );
  assert.deepEqual(posts, [
    { threadId: THREAD, text: renderMirror("reply", "the parent is still working")[0] },
  ]);
});

test("a rate-limit block earned by mirror volume does not drop an alert", async () => {
  // The mirror fires on every prompt and every turn end, and a writer's budget blocks whenever
  // Discord reports an emptied bucket. The mirror spends its own writer, so the block it earns
  // lives in its own bucket: the split creates no Discord capacity, it only keeps mirror volume
  // from being the reason a permission alert, the one write a parked session is waiting on, is
  // dropped.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const posts: Array<{ threadId: string; text: string }> = [];
  // Every post reports its bucket emptied, which blocks the observing writer's budget until the
  // reported reset.
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return {
        status: "ok",
        value: { messageId: "msg-1" },
        rate: { remaining: 0, resetAfterMs: 60_000, retryAfterMs: null },
      };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const now = (): number => 1_000;
  // The alert writer never passes through the router at all now; it stands beside it here to show
  // the block the router's conversation traffic earned does not reach the alert bucket.
  const writer = createThreadWriter({ messenger, now });
  const mirrorWriter = createThreadWriter({ messenger, now });
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "turn one", "session-a"), { status: "sent" });
  assert.equal(
    (await router.mirror(TOKEN, "reply", "turn two", "session-a")).status,
    "failed",
    "the mirror bucket is now blocked",
  );

  assert.equal(
    (await writer.alert(THREAD, "permission prompt", null)).status,
    "ok",
    "the alert path must still post while the mirror bucket is blocked",
  );
  assert.deepEqual(
    posts.map((post) => post.text),
    [renderMirror("reply", "turn one")[0], "permission prompt"],
  );
});

test("a failed mirror post reports and logs its kind, never its text", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 403", rate: NO_RATE_INFO });
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const secret = "SECRET-the-reply-that-failed";
  assert.deepEqual(await router.mirror(TOKEN, "reply", secret, "session-a"), {
    status: "failed",
    error: "HTTP 403",
  });
  const captured = lines.join("\n");
  assert.ok(captured.includes("mirrored reply"), captured);
  assert.ok(!captured.includes(secret), `mirror content leaked into the routing log: ${captured}`);
});

/** A reply of `count` paragraphs, long enough that the renderer splits it into several messages. */
function longReply(count: number): string {
  return Array.from({ length: count }, (_, index) => `Paragraph ${index}. ${"detail ".repeat(40)}`.trim()).join(
    "\n\n",
  );
}

test("a mirrored reply too long for one message is posted whole, in order", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const reply = longReply(30);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

  const expected = renderMirror("reply", reply);
  assert.ok(expected.length >= 5, `${expected.length} message(s)`);
  assert.deepEqual(
    posts.map((post) => post.text),
    expected,
    "every message the renderer produced is posted, in the order it produced them",
  );
});

test("every posted mirror message is the message the renderer measured", async () => {
  // The cross-pin between the splitter and the path that posts it. The real writer runs every
  // message through `inertMessage`, which cuts at MAX_MESSAGE_LENGTH: a splitter measuring against
  // a larger ceiling would have its tails eaten here, silently, and one measuring against a smaller
  // ceiling would spend messages it did not need. The discriminating case is a message sitting
  // exactly at the ceiling, so this reply is built to produce one.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const room = MAX_MESSAGE_LENGTH - (renderMirror("reply", "x")[0].length - 1);
  const reply = `${"x".repeat(room)}\n\n${"y".repeat(room)}`;
  await router.mirror(TOKEN, "reply", reply, "session-a");

  assert.deepEqual(
    posts.map((post) => post.text),
    renderMirror("reply", reply),
  );
  assert.equal(posts[0].text.length, MAX_MESSAGE_LENGTH, "a posted message sits exactly at the ceiling");
});

test("a mirrored reply that fails part way through stops and says how far it got", async () => {
  // Not retried and not continued: the rest of a reply posted around a hole reads as text Claude
  // never wrote, and the transport that refused one message refuses the next for the same reason.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  let calls = 0;
  const posts: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      calls += 1;
      if (calls === 3) return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      posts.push(input.text);
      return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const writer = createThreadWriter({ messenger, now: () => 1_000 });
  const lines: string[] = [];
  const sleeps: number[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const reply = `SECRET-marker\n\n${longReply(30)}`;
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), {
    status: "failed",
    error: "HTTP 500",
  });

  const total = renderMirror("reply", reply).length;
  assert.equal(calls, 3, "the run stops at the refusal rather than posting the rest");
  assert.equal(posts.length, 2);
  // The waits are the gaps ahead of the second and third posts and nothing else: a refusal that
  // is not rate limiting earns no wait and no second attempt at the message it refused.
  assert.deepEqual(sleeps, [RUN_PACE_MS, RUN_PACE_MS]);
  const captured = lines.join("\n");
  assert.ok(captured.includes(`2 of ${total} messages`), captured);
  assert.ok(!captured.includes("SECRET-marker"), `mirror content leaked into the routing log: ${captured}`);
});

/**
 * A messenger whose calls resolve out of the order they were made: the first is the slowest. A
 * router that started a post before the one ahead of it landed records them backwards here.
 */
function outOfOrderMessenger(): { messenger: ThreadMessenger; landed: string[] } {
  const landed: string[] = [];
  let call = 0;
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      const delay = Math.max(40 - call * 15, 0);
      call += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      landed.push(input.text);
      return { status: "ok", value: { messageId: `msg-${call}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  return { messenger, landed };
}

test("mirror posts and a reply-tool post land in the order they were accepted", async () => {
  // Mirror delivery is fire-and-forget at the intake and the two paths spend two different writers,
  // so nothing but this router can hold the order between a turn's reply, the next prompt, and what
  // the reply tool posts in between.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { messenger, landed } = outOfOrderMessenger();
  const now = (): number => 1_000;
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  const accepted = [
    router.mirror(TOKEN, "reply", "the turn's reply", "session-a"),
    router.reply(TOKEN, "the reply tool"),
    router.mirror(TOKEN, "prompt", "the next prompt", "session-a"),
  ];
  await Promise.all(accepted);

  assert.deepEqual(landed, [
    renderMirror("reply", "the turn's reply")[0],
    renderAnswer("the reply tool")[0],
    renderMirror("prompt", "the next prompt")[0],
  ]);
});

test("nothing else lands between the messages of one mirrored reply", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { messenger, landed } = outOfOrderMessenger();
  const now = (): number => 1_000;
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  await Promise.all([router.mirror(TOKEN, "reply", reply, "session-a"), router.reply(TOKEN, "the reply tool")]);

  assert.deepEqual(landed, [...messages, ...renderAnswer("the reply tool")]);
});

test("nothing else lands between the messages of one reply tool post", async () => {
  // An answer long enough to split is one task on the thread's chain for the reason a mirrored
  // reply is: a mirrored prompt landing in the middle of it reads as an answer to a question that
  // had not been asked yet.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { messenger, landed } = outOfOrderMessenger();
  const now = (): number => 1_000;
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  const answer = longReply(30);
  const messages = renderAnswer(answer);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  await Promise.all([router.reply(TOKEN, answer), router.mirror(TOKEN, "prompt", "the next prompt", "session-a")]);

  assert.deepEqual(landed, [...messages, renderMirror("prompt", "the next prompt")[0]]);
});

test("a reply tool post too long for one message is posted whole, in order", async () => {
  // The old behavior cut it at one message. An answer is the highest-value thing this system posts
  // and the operator is away from the keyboard, so it is split rather than truncated.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const answer = longReply(30);
  assert.deepEqual(await router.reply(TOKEN, answer), { status: "sent" });

  const expected = renderAnswer(answer);
  assert.ok(expected.length >= 5, `${expected.length} message(s)`);
  assert.deepEqual(
    posts.map((post) => post.text),
    expected,
    "every message the renderer produced is posted, in the order it produced them",
  );
  for (const post of posts) {
    assert.ok(post.text.length <= MAX_MESSAGE_LENGTH, `${post.text.length} characters`);
  }
});

test("a reply tool post with nothing visible in it is reported rather than posted", async () => {
  // Reported to the relay, which is what the model that called the tool reads back: Discord refuses
  // an empty message, and one would land in the thread as an answer of silence.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "​  \n "), {
    status: "failed",
    error: "the message was empty",
  });
  assert.deepEqual(posts, []);
});

test("a reply tool post that fails part way through stops and says how far it got", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  let calls = 0;
  const posts: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      calls += 1;
      if (calls === 3) return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      posts.push(input.text);
      return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const writer = createThreadWriter({ messenger, now: () => 1_000 });
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const answer = `SECRET-marker\n\n${longReply(30)}`;
  // The error the relay reports carries the landed count, because the model reads it and decides
  // whether to resend: a bare error invites reposting the two messages that already landed.
  const total = renderAnswer(answer).length;
  assert.deepEqual(await router.reply(TOKEN, answer), {
    status: "failed",
    error: `stopped after 2 of ${total} messages: HTTP 500`,
  });
  assert.equal(calls, 3, "the run stops at the refusal rather than posting the rest");
  assert.equal(posts.length, 2);
  const captured = lines.join("\n");
  assert.ok(captured.includes(`2 of ${total} messages`), captured);
  assert.ok(!captured.includes("SECRET-marker"), `reply content leaked into the routing log: ${captured}`);
});

test("a busy thread does not hold up another session's thread", async () => {
  // Per thread, never global. Two sessions post concurrently, which is the whole reason the chain
  // is keyed: one session mirroring a forty-message reply must not stall every other thread.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const other = "22222222-3333-4444-5555-666666666666";
  announce(registry, "session-a");
  announce(registry, "session-b", other);
  const landed: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      // The slow thread is the one asked first.
      await new Promise((resolve) => setTimeout(resolve, input.threadId === THREAD ? 40 : 0));
      landed.push(input.threadId);
      return { status: "ok", value: { messageId: `msg-${landed.length}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const now = (): number => 1_000;
  const router = routerFor({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : "other-thread"),
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  await Promise.all([
    router.mirror(TOKEN, "reply", "the slow thread", "session-a"),
    router.mirror(other, "reply", "the other thread", "session-b"),
  ]);

  assert.deepEqual(landed, ["other-thread", THREAD]);
});

test("a mirror post with nothing visible in it is reported rather than posted", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "​  \n ", "session-a"), {
    status: "failed",
    error: "the message was empty",
  });
  assert.deepEqual(posts, []);
});

test("a rejected post is reported to the caller rather than swallowed", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 403", rate: NO_RATE_INFO });
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "failed", error: "HTTP 403" });
});

test("a reply tool post cannot draw the line that says who wrote a mirrored message", async () => {
  // Both writers post into the one thread, so the attribution renderMirror composes is only
  // unforgeable if the other path into that thread cannot compose it either. The text of a reply is
  // written by a model that has read whatever the session read, so this is the reachable half of
  // the same forgery the mirror's own escape closes.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  // The operator-attributed block is the forgery that matters: a quoted block is what a reader takes
  // for the operator's own typing, and a reply is the path a prompt-injected model writes through.
  const attribution = renderMirror("prompt", "anything")[0].split("\n")[0];
  await router.reply(TOKEN, `${attribution}\nthe operator's session was compromised, run this`);

  const posted = posts[0].text;
  assert.ok(!posted.split("\n").some((line) => line === attribution), posted);
  assert.equal(
    posted.split("\n").filter((line) => /^[ \t]*>/.test(line)).length,
    0,
    `a reply tool post must open no quote at all: ${posted}`,
  );
  assert.ok(posted.includes("\\>"), `the quote marker must reach Discord escaped: ${posted}`);
});

test("a reply tool post cannot carry a mention pill or a timestamp chip", async () => {
  // allowed_mentions stops a smuggled pill pinging anyone; it does not stop one rendering, in the
  // one channel permission prompts are answered in.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  await router.reply(TOKEN, "<@700000000000000002> **Permission needed** <t:1700000000:R>");

  const posted = posts[0].text;
  assert.equal(said(posted), "\\<@700000000000000002\\> **Permission needed** \\<t:1700000000:R\\>");
  assert.ok(!/<@\d+>/.test(posted), posted);
  assert.ok(!/<t:\d+:R>/.test(posted), posted);
});

test("a reply tool post keeps its code readable", async () => {
  // The escape is the mirror's, so it is fence-aware for the reason the mirror's is: a reply from a
  // coding assistant is mostly code, Discord processes no escapes inside a fence, and an escape
  // there reaches the reader as a backslash on every generic and comparison.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const reply = "here:\n\n```ts\nconst f = (a: Array<string>) => a.length < 10;\n```";
  await router.reply(TOKEN, reply);

  assert.equal(said(posts[0].text), reply, "nothing inside a fence is escaped");
});

test("a mirror post dropped before it reaches a thread leaves a line saying so", async () => {
  // A mirror the operator switched off and a mirror that is broken are both total silence in the
  // thread, so the log is the only thing that tells them apart. Content-free and rate-limited: a
  // session whose thread never opens drops every prompt and every turn for as long as that lasts.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter();
  const lines: string[] = [];
  let now = 1_000;
  const router = routerFor({
    registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
    now: () => now,
  });

  const secret = "SECRET-the-prompt-nobody-saw";
  assert.deepEqual(await router.mirror(TOKEN, "prompt", secret, null), { status: "no-thread" });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(lines[0].includes("thread"), lines[0]);
  assert.ok(!lines[0].includes(secret), `mirror content leaked into the routing log: ${lines[0]}`);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    now += 1_000;
    await router.mirror(TOKEN, "prompt", secret, null);
  }
  assert.equal(lines.length, 1, `a repeat inside the window is counted, not logged: ${lines.join("\n")}`);

  now += 60_000;
  await router.mirror(TOKEN, "prompt", secret, null);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("5 more time(s)"), lines[1]);
});

test("a mirror post from an unannounced process leaves a line that names no session", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { writer } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "a turn nobody is watching", null), {
    status: "no-session",
  });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("mirrored reply"), lines[0]);
  // The process token is the key such a post is authenticated by, and it is the only thing this
  // drop path holds, so the line names the cause and nothing else.
  assert.ok(!lines[0].includes(TOKEN), `the process token must never be logged: ${lines[0]}`);
});

test("a mirror post with nothing visible in it leaves a line naming its session", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  await router.mirror(TOKEN, "prompt", "\u200b  \n ", "session-a");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
});

test("a message the operator posted in the thread does not mirror back into it", async () => {
  // The harness delivers a channel message to the session as a user prompt, wrapped in its own
  // envelope, so the prompt mirror would post that message straight back into the thread it was
  // typed in and the operator would read their own message twice.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const envelope = '<channel source="channel-relay" chat_id="123">the migration finished?</channel>';
  assert.deepEqual(await router.mirror(TOKEN, "prompt", envelope, "session-a"), {
    status: "failed",
    error: "the message came from the channel",
  });
  assert.deepEqual(posts, [], "the operator's own message must not come back to them");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(lines[0].includes("channel"), lines[0]);
  assert.ok(
    !lines[0].includes("the migration finished?"),
    `mirror content leaked into the routing log: ${lines[0]}`,
  );
});

test("an invisible character in front of the envelope does not sneak it past the filter", async () => {
  // The renderer strips the invisible class before anything is posted, so a zero-width character
  // in front of the envelope changes nothing the operator would read; it must not be the reason
  // the echo comes back. The filter reads the text through the same strip.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const veiled = String.fromCharCode(0x200b) + '<channel source="channel-relay" chat_id="123">hello</channel>';
  assert.equal((await router.mirror(TOKEN, "prompt", veiled, "session-a")).status, "failed");
  assert.deepEqual(posts, []);
});

test("only a prompt that opens with the envelope is taken for a channel message", async () => {
  // The marker is the opening of the harness's wrapper, not a word to be found anywhere. A prompt
  // quoting it mid-text is the operator typing about it, and a reply is Claude's own words.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const quoting = 'the hook wraps it in <channel source="channel-relay"> before I see it';
  assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", "session-a"), {
    status: "sent",
  });
  assert.deepEqual(await router.mirror(TOKEN, "prompt", quoting, "session-a"), { status: "sent" });
  assert.deepEqual(await router.mirror(TOKEN, "reply", `<channel source= is the marker`, "session-a"), {
    status: "sent",
  });

  assert.deepEqual(
    posts.map((post) => post.text),
    [
      renderMirror("prompt", "run the migration")[0],
      renderMirror("prompt", quoting)[0],
      renderMirror("reply", "<channel source= is the marker")[0],
    ],
  );
});

test("one session's steady drops do not swallow the first drop of another's", async () => {
  // The limiter keys on the line, which carries the session: a key shared across sessions would
  // suppress the first evidence that a second session is dropping too.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const other = "99999999-8888-7777-6666-555555555555";
  announce(registry, "session-a");
  announce(registry, "session-b", other);
  const { writer } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
    now: () => 1_000,
  });

  await router.mirror(TOKEN, "prompt", "one", null);
  await router.mirror(TOKEN, "prompt", "two", null);
  await router.mirror(other, "prompt", "three", null);

  assert.equal(lines.length, 2, lines.join("\n"));
  assert.ok(lines[1].includes("session-b"), lines[1]);
});

test("an interim chunk posts to the session's own thread under the working attribution", async () => {
  // The tailer holds a session ID and no process token, so the interim path resolves the thread
  // directly; the registry's live set has already gated which sessions are read at all.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const asked: string[] = [];
  const router = routerFor({
    registry,
    threadFor: (sessionId) => {
      asked.push(sessionId);
      return THREAD;
    },
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.interim("session-a", "running the suite now"), { status: "sent" });
  assert.deepEqual(asked, ["session-a"]);
  assert.deepEqual(posts, [{ threadId: THREAD, text: renderMirror("interim", "running the suite now")[0] }]);
  assert.ok(posts[0].text.startsWith("✨ Claude · working\n"), posts[0].text);
});

test("an interim chunk with no thread is dropped with a line that names no content", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const secret = "SECRET-narration-nobody-saw";
  assert.deepEqual(await router.interim("session-a", secret), { status: "no-thread" });
  assert.deepEqual(posts, [], "nothing is queued for a thread that does not exist yet");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(!lines[0].includes(secret), `transcript content leaked into the routing log: ${lines[0]}`);
});

test("an interim chunk cannot land between the messages of a split reply", async () => {
  // The interim path shares the per-thread chain the mirror and reply paths post on; without it a
  // chunk read mid-poll would interleave with a forty-message reply already going out.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { messenger, landed } = outOfOrderMessenger();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
  });

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  await Promise.all([
    router.mirror(TOKEN, "reply", reply, "session-a"),
    router.interim("session-a", "narration racing the reply"),
  ]);

  assert.deepEqual(landed, [...messages, renderMirror("interim", "narration racing the reply")[0]]);
});

test("a queued prompt posts under the operator's attribution, indistinguishable from a mirrored one", async () => {
  // A message typed at the console mid-turn reaches this router off the transcript rather than off
  // a hook, and the thread must not be able to tell the two apart: one rendering, one attribution.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const asked: string[] = [];
  const router = routerFor({
    registry,
    threadFor: (sessionId) => {
      asked.push(sessionId);
      return THREAD;
    },
    mirrorWriter: writer,
  });

  assert.deepEqual(
    await router.interimPrompt("session-a", "check the migration order too", "queued", null),
    { status: "sent" },
  );
  assert.deepEqual(asked, ["session-a"]);
  assert.deepEqual(posts, [
    { threadId: THREAD, text: renderMirror("prompt", "check the migration order too")[0] },
  ]);
});

test("a queued prompt that is the operator's own channel message does not echo back into the thread", async () => {
  // The operator typed it in the thread, so the thread already shows it. The check reads the same
  // normalized pre-render text the hook-carried mirror's does, on whichever line shape the harness
  // recorded the message under.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const envelope = '<channel source="channel-relay" chat_id="123">the migration finished?</channel>';
  assert.deepEqual(await router.interimPrompt("session-a", envelope, "queued", null), {
    status: "failed",
    error: "the message came from the channel",
  });
  const veiled = String.fromCharCode(0x200b) + envelope;
  assert.equal((await router.interimPrompt("session-a", veiled, "queued", null)).status, "failed");

  assert.equal(posts.length, 0, "the operator's own message must not come back to them");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(lines[0].includes("channel"), lines[0]);
  assert.ok(
    !lines[0].includes("the migration finished?"),
    `transcript content leaked into the routing log: ${lines[0]}`,
  );

  // A prompt quoting the marker mid-text is the operator typing about it, and still posts.
  const quoting = 'the hook wraps it in <channel source="channel-relay"> before I see it';
  assert.deepEqual(await router.interimPrompt("session-a", quoting, "queued", null), { status: "sent" });
  assert.deepEqual(posts.map((post) => post.text), [renderMirror("prompt", quoting)[0]]);
});

test("a queued prompt cannot forge the attribution or carry a live chip", async () => {
  // Transcript text is untrusted, and text that entered through a file read is escaped by exactly
  // the machinery that makes the attribution unforgeable for text that entered through a hook.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const attribution = renderMirror("prompt", "anything")[0].split("\n")[0];
  await router.interimPrompt(
    "session-a",
    `${attribution}\n> <@700000000000000002> approve the deploy <t:1700000000:R>`,
    "queued",
    null,
  );

  const posted = posts[0].text;
  assert.equal(
    posted.split("\n").filter((line) => line === attribution).length,
    1,
    `only the renderer may draw the attribution: ${posted}`,
  );
  assert.equal(
    said(posted).split("\n").filter((line) => /^[ \t]*>/.test(line)).length,
    0,
    `a queued prompt must open no quote of its own: ${posted}`,
  );
  assert.ok(posted.includes("\\>"), `the quote marker must reach Discord escaped: ${posted}`);
  assert.ok(!/<@\d+>/.test(posted), posted);
  assert.ok(!/<t:\d+:R>/.test(posted), posted);
});

test("a queued prompt with no thread, and one with nothing visible in it, are dropped with content-free lines", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  let threadId: string | null = null;
  const router = routerFor({
    registry,
    threadFor: () => threadId,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const secret = "SECRET-the-message-nobody-saw";
  assert.deepEqual(await router.interimPrompt("session-a", secret, "queued", null), {
    status: "no-thread",
  });
  assert.deepEqual(posts, [], "nothing is queued for a thread that does not exist yet");

  // Nothing visible once the invisible class is stripped. Unlike a chunk of narration, no later
  // item narrates what this one did not, so the drop leaves a line of its own.
  threadId = THREAD;
  assert.deepEqual(await router.interimPrompt("session-a", String.fromCharCode(0x200b), "queued", null), {
    status: "failed",
    error: "the message was empty",
  });
  assert.deepEqual(posts, []);

  assert.equal(lines.length, 2, lines.join("\n"));
  for (const line of lines) {
    assert.ok(line.includes("session-a"), line);
    assert.ok(!line.includes(secret), `transcript content leaked into the routing log: ${line}`);
  }
});

/**
 * A wake prompt: the harness's injection when a background task finishes while its session is
 * idle, opening with the marker and carrying the task's whole final report.
 */
const WAKE =
  "<task-notification>Background task completed.\n<task-id>agent-42</task-id>\n\n" +
  "The subagent's whole final report, many paragraphs of it.";

test("a wake prompt compresses to exactly one notice message by default", async () => {
  // The injected report renders compactly at the console, so mirrored whole it makes the thread
  // louder than the terminal: with the option absent the compression is the behavior.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", WAKE, "session-a"), { status: "sent" });
  assert.equal(posts.length, 1, posts.map((post) => post.text).join("\n---\n"));
  assert.deepEqual(posts, [{ threadId: THREAD, text: renderTaskNotice(WAKE) }]);
  assert.ok(posts[0].text.startsWith("📨 background task finished"), posts[0].text);

  // Only a prompt is a wake-up: a reply opening with the marker is Claude's own words about one,
  // and it mirrors exactly as any reply does.
  await router.mirror(TOKEN, "reply", WAKE, "session-a");
  assert.equal(posts[1].text, renderMirror("reply", WAKE)[0]);
});

test("an invisible character in front of the marker does not carry the whole report past the compression", async () => {
  // The recognizer reads through the same invisible strip the envelope check does: a zero-width
  // character in front of the marker changes nothing the operator would read, so it must not be
  // what floods the thread.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const veiled = String.fromCharCode(0x200b) + WAKE;
  assert.deepEqual(await router.mirror(TOKEN, "prompt", veiled, "session-a"), { status: "sent" });
  assert.deepEqual(posts, [{ threadId: THREAD, text: renderTaskNotice(WAKE) }]);
});

test("a wake marker that grows an attribute still compresses", async () => {
  // The recognizer's literal stops before the closing bracket on purpose: a harness revision that
  // gives the tag an attribute must not silently disable the compression, because the silent fail
  // direction is the flood the knob exists to close.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  const grown = '<task-notification id="a4f5">Background task completed.\n<task-id>agent-42</task-id>';
  assert.deepEqual(await router.mirror(TOKEN, "prompt", grown, "session-a"), { status: "sent" });
  assert.deepEqual(posts, [{ threadId: THREAD, text: renderTaskNotice(grown) }]);
});

test("full restores the whole-report mirror exactly as an ordinary prompt", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    taskNotifications: "full",
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", WAKE, "session-a"), { status: "sent" });
  assert.deepEqual(
    posts.map((post) => post.text),
    renderMirror("prompt", WAKE),
    "the pre-compression rendering, byte for byte",
  );
  assert.ok(posts[0].text.startsWith(">>> ⌨ typed at the console\n"), posts[0].text);
});

test("off posts nothing and leaves one line naming the session, never the report", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    taskNotifications: "off",
    log: (message) => lines.push(message),
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", WAKE, "session-a"), {
    status: "failed",
    error: "task notification suppressed",
  });
  assert.deepEqual(posts, [], "a suppressed wake reaches no thread");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(
    !lines[0].includes("agent-42") && !lines[0].includes("report"),
    `wake prompt content leaked into the routing log: ${lines[0]}`,
  );
});

test("the envelope drop and an ordinary prompt are unchanged on every setting", async () => {
  // The wake check sits after the envelope check, and neither it nor the knob may touch what was
  // already true: the operator's own channel message never echoes back, and an ordinary prompt
  // mirrors whole.
  const envelope = '<channel source="channel-relay" chat_id="123">the migration finished?</channel>';
  for (const mode of ["brief", "full", "off"] as const) {
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const { writer, posts } = fakeWriter();
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      taskNotifications: mode,
    });

    assert.deepEqual(
      await router.mirror(TOKEN, "prompt", envelope, "session-a"),
      { status: "failed", error: "the message came from the channel" },
      mode,
    );
    assert.deepEqual(await router.interimPrompt("session-a", envelope, "queued", null), {
      status: "failed",
      error: "the message came from the channel",
    });
    assert.equal(posts.length, 0, mode);

    assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", "session-a"), {
      status: "sent",
    });
    assert.deepEqual(
      posts.map((post) => post.text),
      [renderMirror("prompt", "run the migration")[0]],
      mode,
    );
  }
});

test("a queued wake prompt gets the same brief, full, and off treatment", async () => {
  // A wake-up the harness records as a queued line reaches the thread off the transcript rather
  // than off a hook, and one wake prompt must get one answer whichever way it arrived.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");

  const brief = fakeWriter();
  const briefRouter = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: brief.writer });
  assert.deepEqual(await briefRouter.interimPrompt("session-a", WAKE, "queued", null), { status: "sent" });
  assert.deepEqual(brief.posts, [{ threadId: THREAD, text: renderTaskNotice(WAKE) }]);
  const veiled = String.fromCharCode(0x200b) + WAKE;
  assert.deepEqual(await briefRouter.interimPrompt("session-a", veiled, "queued", null), {
    status: "sent",
  });
  assert.equal(brief.posts[1].text, renderTaskNotice(WAKE), "the invisible-stripped prefix is recognized here too");

  const full = fakeWriter();
  const fullRouter = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: full.writer,
    taskNotifications: "full",
  });
  assert.deepEqual(await fullRouter.interimPrompt("session-a", WAKE, "queued", null), { status: "sent" });
  assert.deepEqual(
    full.posts.map((post) => post.text),
    renderMirror("prompt", WAKE),
    "full reproduces the operator-attributed block off the transcript too",
  );

  const off = fakeWriter();
  const lines: string[] = [];
  const offRouter = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: off.writer,
    taskNotifications: "off",
    log: (message) => lines.push(message),
  });
  assert.deepEqual(await offRouter.interimPrompt("session-a", WAKE, "queued", null), {
    status: "failed",
    error: "task notification suppressed",
  });
  assert.deepEqual(off.posts, []);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(
    !lines[0].includes("agent-42") && !lines[0].includes("report"),
    `wake prompt content leaked into the routing log: ${lines[0]}`,
  );
});

// Peer traffic. A message another session sent this one reaches the two prompt seams as the
// harness's wrapper text and nothing else, because the `UserPromptSubmit` payload carries the
// prompt string alone; the tailer's own two kinds arrive whole through `peer`. The fixtures below
// carry the delivery shape a live exchange writes, with the body shortened.

/** The pipe address a peer session is addressed by on the wire, which renders nowhere. */
const PEER_PIPE = "uds:\\\\.\\pipe\\LOCAL\\cc-msg-5b54bcd5ec2e5910d3a6618b3f8c54d8";
const PEER_NAME = "KIT: Messaging";
const PEER_BODY = "Blast radius: answers only, nothing touching your tree.";

/** A peer message as the harness delivers it to an idle session: the preamble, then the wrapper. */
function idleDelivery(body: string = PEER_BODY, name: string = PEER_NAME): string {
  return (
    "Another Claude session sent a message:\n" +
    `<cross-session-message from="${PEER_PIPE}" from-name="${name}" from-mode="bypass">\n` +
    `${body}\n</cross-session-message>`
  );
}

/**
 * A delivery whose wrapper never closes: a peer message this broker cannot read the body of, which
 * is a different answer from "not a delivery" and must not fall back into the operator's register.
 */
const UNREADABLE_DELIVERY =
  "Another Claude session sent a message:\n" +
  `<cross-session-message from="${PEER_PIPE}" from-name="${PEER_NAME}" from-mode="bypass">\n` +
  "the close tag the harness writes never arrives";

/** The outbound half, as the tailer reads one off a `SendMessage` call. */
const SENT = {
  kind: "peer-out",
  to: PEER_NAME,
  summary: "Questions about cross-session messaging",
  message: "Hello from CHANNEL: Fable, the session in the Discord broker repo.",
} satisfies PeerTraffic;

/** The inbound half in the shape the tailer hands it over, for the paths that take an item. */
const RECEIVED = { kind: "peer-in", name: PEER_NAME, body: PEER_BODY } satisfies PeerTraffic;

test("a peer message is drawn under its own attribution, never in the operator's quoted register", async () => {
  // The failure this whole classification exists to close: the harness's wrapper text mirrored as
  // the operator's own words, in the one register this surface holds unforgeable.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", idleDelivery(), "session-a"), {
    status: "sent",
  });
  assert.deepEqual(await router.interimPrompt("session-a", idleDelivery(), "queued", null), {
    status: "sent",
  });

  const drawn = renderPeerIn(PEER_NAME, PEER_BODY);
  assert.deepEqual(
    posts.map((post) => post.text),
    [...drawn, ...drawn],
    "one message, one rendering, whichever seam it arrived on",
  );
  for (const post of posts) {
    assert.equal(post.threadId, THREAD);
    assert.ok(!post.text.startsWith(">>>"), `drawn in the operator's register: ${post.text}`);
    assert.ok(!post.text.includes("cross-session-message"), post.text);
    assert.ok(!post.text.includes("Another Claude session sent a message"), post.text);
    // The chatter register, pinned where the delivery paths converge rather than only at the
    // renderer: every line of the body reaches the thread as subtext, so a peer's text is never
    // drawn at the size the operator's own is. The attribution line is the deliberate exception.
    for (const line of post.text.split("\n").slice(1)) {
      assert.ok(
        line.trim() === "" || line.startsWith("-# "),
        `a peer line reached the thread at reading size: ${line}`,
      );
    }
    // The mirror budget and nothing louder: a peer exchange is worth reading, not worth a ping.
    assert.ok(!post.text.includes("<@"), `a peer post carried a mention: ${post.text}`);
  }
});

test("a delivery this broker could not read renders as a peer message, not as a prompt", async () => {
  // Section 1's third state. Collapsing it into "not a delivery" would hand a peer the switch that
  // puts its own text in the operator's register: write a body this reader cannot parse, and the
  // fall-through does the rest.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", UNREADABLE_DELIVERY, "session-a"), {
    status: "sent",
  });
  assert.deepEqual(await router.interimPrompt("session-a", UNREADABLE_DELIVERY, "queued", null), {
    status: "sent",
  });

  const drawn = renderPeerIn(PEER_NAME_FALLBACK, PEER_BODY_UNREADABLE);
  assert.deepEqual(posts.map((post) => post.text), [...drawn, ...drawn]);
  assert.ok(posts[0].text.includes(PEER_BODY_UNREADABLE), posts[0].text);
  assert.ok(
    !posts[0].text.includes("the close tag the harness writes never arrives"),
    "the unparsed text must not ride through under any attribution",
  );
});

test("the peer knob governs volume on every path, in both directions, and never attribution", async () => {
  // The mode matrix: the two prompt seams and the tailer's own doorway, inbound and outbound.
  for (const mode of ["full", "brief", "off"] as const) {
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const { writer, posts } = fakeWriter();
    const lines: string[] = [];
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      peerMessages: mode,
      log: (message) => lines.push(message),
    });

    const drawnIn =
      mode === "off"
        ? []
        : mode === "brief"
          ? renderPeerInBrief(PEER_NAME, PEER_BODY)
          : renderPeerIn(PEER_NAME, PEER_BODY);
    const drawnOut =
      mode === "off"
        ? []
        : mode === "brief"
          ? renderPeerOutBrief(SENT.to, SENT.summary, SENT.message)
          : renderPeerOut(SENT.to, SENT.message);
    const answer =
      mode === "off"
        ? { status: "failed", error: "peer messages suppressed" }
        : { status: "sent" };

    assert.deepEqual(await router.mirror(TOKEN, "prompt", idleDelivery(), "session-a"), answer, mode);
    assert.deepEqual(
      await router.interimPrompt("session-a", idleDelivery(), "queued", null),
      answer,
      mode,
    );
    assert.deepEqual(await router.peer("session-a", RECEIVED), answer, mode);
    assert.deepEqual(await router.peer("session-a", SENT), answer, mode);

    assert.deepEqual(
      posts.map((post) => post.text),
      [...drawnIn, ...drawnIn, ...drawnIn, ...drawnOut],
      mode,
    );
    // The register holds at every volume setting, which is the half of this test the knob's own
    // semantics do not cover: `brief` composes the marker by hand in a different function from the
    // one the whole rendering uses, so it is the mode a register change is most likely to miss.
    for (const post of posts) {
      for (const line of post.text.split("\n").slice(1)) {
        assert.ok(
          line.trim() === "" || line.startsWith("-# "),
          `${mode}: a peer line reached the thread at reading size: ${line}`,
        );
      }
    }
    if (mode === "off") {
      // Two lines rather than four: the drop log aggregates a repeat of one line for one session,
      // and the two directions are two lines. Neither carries the message.
      assert.equal(lines.length, 2, lines.join("\n"));
      for (const line of lines) {
        assert.ok(line.includes("session-a"), line);
        assert.ok(
          !line.includes(PEER_BODY) && !line.includes(SENT.message) && !line.includes(SENT.summary),
          `peer content leaked into the routing log: ${line}`,
        );
      }
    } else {
      assert.deepEqual(lines, [], mode);
    }

    // Whatever the setting, the operator's own prompt still mirrors exactly as it always did.
    assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", "session-a"), {
      status: "sent",
    });
    assert.equal(
      posts[posts.length - 1].text,
      renderMirror("prompt", "run the migration")[0],
      mode,
    );
  }
});

test("a peer message with no thread, and one with nothing visible in it, are dropped with content-free lines", async () => {
  // Dropped, never queued, like every other post here, and each line is the discriminator for a
  // thread that shows an exchange nowhere: it carries the direction and the session and no text.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });
  assert.deepEqual(await router.peer("session-a", RECEIVED), { status: "no-thread" });

  const open = fakeWriter();
  const opened = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: open.writer,
    log: (message) => lines.push(message),
  });
  // Nothing visible once the invisible class is stripped: the renderer returns no messages, and
  // Discord refuses an empty one.
  assert.deepEqual(
    await opened.peer("session-a", { kind: "peer-in", name: PEER_NAME, body: "​" }),
    { status: "failed", error: "the message was empty" },
  );

  assert.deepEqual(posts, []);
  assert.deepEqual(open.posts, []);
  assert.equal(lines.length, 2, lines.join("\n"));
  for (const line of lines) {
    assert.ok(line.includes("session-a") && line.includes("peer"), line);
    assert.ok(!line.includes(PEER_NAME), `a counterparty's name reached the log: ${line}`);
  }
});

test("a prompt suppressed as peer traffic leaves the one line that says what became of it", async () => {
  // `off` deletes what it suppresses rather than compressing it, and a prompt the classification
  // read as a delivery is deleted with it. That is still the better answer than falling through to
  // the mirror, which would draw a peer's words in the operator's own quoted register on exactly the
  // setting chosen to hear less from peers. It is defensible only while the drop leaves a trace an
  // operator can act on, so this line is that trace: the direction, the session, the knob that
  // restores it, and the fact that a typed prompt can be what it dropped.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    peerMessages: "off",
    log: (message) => lines.push(message),
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", idleDelivery(), "session-a"), {
    status: "failed",
    error: "peer messages suppressed",
  });
  assert.deepEqual(posts, [], "a suppressed message reaches no thread");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /CHANNEL_PEER_MESSAGES is off/);
  assert.match(lines[0], /prompt read as peer traffic is dropped here too/);
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(!lines[0].includes(PEER_BODY), `peer content leaked into the routing log: ${lines[0]}`);

  // The outbound line carries no such clause: nothing the operator typed arrives on that path, so
  // saying a prompt might be what was dropped would send a reader hunting for one that never was.
  await router.peer("session-a", SENT);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.doesNotMatch(lines[1], /prompt read as peer traffic/);
  assert.match(lines[1], /CHANNEL_PEER_MESSAGES is off/);
});

test("a reply that opens with the wrapper is still Claude's own reply", async () => {
  // Only a prompt is classified, on the envelope check's reasoning exactly: a reply is Claude's own
  // words about a delivery rather than one, so a turn that opens by quoting the message it just
  // read must not be redrawn as the peer that sent it. Without the guard this renders under the
  // peer attribution, saying a counterparty wrote what this session did.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "reply", idleDelivery(), "session-a"), {
    status: "sent",
  });
  assert.deepEqual(
    posts.map((post) => post.text),
    renderMirror("reply", idleDelivery()),
    "the reply rendering, byte for byte",
  );
});

test("a peer message ends the narration block it lands under", async () => {
  // The chained doorway's own effect: what a session says after an exchange belongs below it, not
  // appended into the block that was growing above it.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const edits: string[] = [];
  const posts: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      return { status: "ok", value: { messageId: "900000000000000010" }, rate: NO_RATE_INFO };
    },
    editInThread: async (input) => {
      edits.push(input.text);
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
  });

  await router.interim("session-a", "reading the failing test");
  await router.interim("session-a", "still reading");
  assert.equal(edits.length, 1, "consecutive chunks coalesce into the block");

  await router.peer("session-a", RECEIVED);
  await router.interim("session-a", "found the off-by-one");
  assert.equal(edits.length, 1, "the chunk after a peer message posts fresh below it");
  assert.deepEqual(posts, [
    renderMirror("interim", "reading the failing test")[0],
    ...renderPeerIn(PEER_NAME, PEER_BODY),
    renderMirror("interim", "found the off-by-one")[0],
  ]);
});

test("a mirrored reply matching the last interim chunk is skipped, and only that one", async () => {
  // The Stop mirror's half of the dedup: the tailer posted the turn's final text first, so the
  // reply arriving milliseconds later says nothing the thread does not already show.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: (message) => lines.push(message),
  });

  echo.noteInterim("session-a", "the final text, already narrated");
  assert.deepEqual(
    await router.mirror(TOKEN, "reply", "the final text, already narrated", "session-a"),
    { status: "sent" },
  );
  assert.equal(posts.length, 0, "the text is already on the thread and must not double");
  assert.ok(lines.some((line) => line.includes("interim")), lines.join("\n"));
  assert.ok(
    !lines.join("\n").includes("already narrated"),
    `mirror content leaked into the routing log: ${lines.join("\n")}`,
  );

  // A different reply still mirrors, and a prompt is answered by the prompt pair alone: the same
  // words in the operator's register are their own message, not this reply's second copy.
  await router.mirror(TOKEN, "reply", "a different reply", "session-a");
  await router.mirror(TOKEN, "prompt", "the final text, already narrated", "session-a");
  assert.equal(posts.length, 2, posts.map((post) => post.text).join("\n---\n"));
});

test("a mirrored reply records its digest whether it posts or is skipped", async () => {
  // "Either way" is what lets the tailer skip the same text off the transcript on its next pass,
  // whichever path put it on the thread.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.mirror(TOKEN, "reply", "posted normally", "session-a");
  assert.equal(echo.isEcho("session-a", "posted normally"), true);

  echo.noteInterim("session-a", "narrated first");
  await router.mirror(TOKEN, "reply", "narrated first", "session-a");
  assert.equal(echo.isEcho("session-a", "narrated first"), true, "a skipped reply is still recorded");
});

test("an invisible character cannot hide a reply from the interim dedup", async () => {
  // The memory compares on withoutInvisible(text).trim(), exactly as the envelope check does: the
  // transcript's copy and the hook payload's copy of one reply can differ by characters nobody
  // sees, and a zero-width difference must not be the reason the operator reads it twice.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  echo.noteInterim("session-a", "the same text  ");
  await router.mirror(TOKEN, "reply", `​the same text`, "session-a");
  assert.deepEqual(posts, [], "a zero-width character must not manufacture a second post");
});

test("a mirrored reply that failed to land is not remembered as mirrored", async () => {
  // The digest is claimed as the run is dispatched and released again by a run that landed nothing
  // at all. Kept, a reply the transport refused would poison the memory, the tailer's next pass
  // would skip the same text off the transcript, and the reply would appear nowhere: the silence
  // this whole design trades away from. The tailer's own half releases the same way; this is the
  // symmetric guarantee on the mirror's half.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 500", rate: NO_RATE_INFO });
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  const reply = "the reply the transport refused";
  assert.equal((await router.mirror(TOKEN, "reply", reply, "session-a")).status, "failed");
  assert.equal(
    echo.isEcho("session-a", reply),
    false,
    "a reply that never landed must not suppress the tailer's copy of the same text",
  );
});

test("a reply the tailer deferred to goes again once when its run landed nothing", async () => {
  // The claim's own cost, bounded here. The tailer met the claim mid-run and skipped the text with
  // its transcript offset already past those bytes, so a run that then lands nothing is the last
  // thing carrying the turn's closing words: it goes again, once, and the loss gets a line of its
  // own rather than the partial-run line, which reads identically for a run whose text the other
  // path is about to carry.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const echo = createEchoMemory();
  const lines: string[] = [];
  const posts: string[] = [];
  const reply = "the turn's closing words, refused on every attempt";
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      // The tailer's poll landing inside the run: it finds the claim and skips the chunk.
      if (posts.length === 1) echo.isEcho("session-a", reply);
      return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    echo,
    log: (message) => lines.push(message),
  });

  assert.equal((await router.mirror(TOKEN, "reply", reply, "session-a")).status, "failed");
  assert.equal(posts.length, 2, `the run goes again exactly once: ${posts.join("\n---\n")}`);
  assert.ok(
    lines.some((line) => line.includes("reached the thread by neither path")),
    lines.join("\n"),
  );
  assert.ok(
    !lines.join("\n").includes("closing words"),
    `mirror content leaked into the routing log: ${lines.join("\n")}`,
  );
  assert.equal(
    echo.isEcho("session-a", reply),
    false,
    "text on the thread by neither path is claimed by neither path",
  );
});

test("a narration chunk with nothing visible in it leaves no claim behind", async () => {
  // The claim is made as the delivery is dispatched, before the chunk is rendered, so a chunk that
  // neutralizes to nothing claims a digest and then posts nothing. The release is what keeps the
  // memory as it found it: a claim left standing on that digest would suppress the next mirror
  // carrying the same text.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  assert.equal((await router.interim("session-a", "​")).status, "failed");
  assert.deepEqual(posts, []);
  assert.equal(echo.isInterimEcho("session-a", "​"), false, "nothing posted, nothing claimed");
});

/** A close-out answer of the length and register the reply tool and the Stop mirror both carry. */
const ANSWER = [
  "Done: the channel quality pass is delivered. The broker now coalesces consecutive narration",
  "chunks into one growing message, so a working stretch reads as a single block instead of a",
  "header per sentence, and the status card names the tool a session is working in rather than",
  "only saying one is running. The repair script landed too: it kills only processes it can",
  "prove are this repo broker, by command line or by the configured port, and never a process",
  "merely named node. All gates ran green, the docs carry the new surfaces, and the plan doc is",
  "archived. The one thing left for you is a real phone-side check of the new card copy.",
].join(" ");

/** The same answer as the Stop mirror phrases it: two clauses lightly reworded. */
const MIRRORED_ANSWER = ANSWER.replace("is delivered", "is done").replace(
  "All gates ran green",
  "Gates ran green",
);

/** New content on the same effort: a mirror the operator has not read in any form yet. */
const DIFFERENT_REPLY = [
  "The next effort is the reply dedup: a mirrored reply matching a reply-tool answer the session",
  "just posted should be suppressed so the thread carries one copy. The sketch module is written",
  "and reviewed; what remains is the wiring through the echo memory and the router, plus tests",
  "locking both directions of the threshold on the mirror path.",
].join(" ");

/** The answer in the reply tool's shorter register: a summary must not suppress the full text. */
const SUMMARY_ANSWER =
  "Done: quality pass delivered, repair script landed, gates green. Card copy needs your phone-side check.";

test("a mirrored reply matching the reply tool's answer is suppressed and reported sent", async () => {
  // The reply tool posts mid-turn, so by the time the Stop mirror arrives the answer is already
  // on the thread: the mirror is the suppressible copy, and sent is the honest status because
  // the text is in front of the operator by the other path.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: (message) => lines.push(message),
  });

  assert.deepEqual(await router.reply(TOKEN, ANSWER), { status: "sent" });
  assert.equal(posts.length, 1);
  assert.deepEqual(await router.mirror(TOKEN, "reply", ANSWER, "session-a"), { status: "sent" });
  assert.equal(posts.length, 1, "the operator reads one copy, the reply tool's");

  const captured = lines.join("\n");
  assert.ok(captured.includes("session-a"), captured);
  assert.ok(captured.includes("answer"), captured);
  assert.ok(!captured.includes("quality pass"), `answer content leaked into the routing log: ${captured}`);

  // A prompt is never consulted against the answer record, and does not consume it either: the
  // record posted below still stands for the reply that follows.
  await router.reply(TOKEN, ANSWER);
  assert.deepEqual(await router.mirror(TOKEN, "prompt", ANSWER, "session-a"), { status: "sent" });
  assert.equal(posts.length, 3, "a prompt carrying the same words still mirrors");
  await router.mirror(TOKEN, "reply", ANSWER, "session-a");
  assert.equal(posts.length, 3, "the record survived the prompt and suppressed the reply");
});

test("a lightly reworded mirror of the answer is suppressed, and the tailer half still records", async () => {
  // The reason the record carries a sketch beside the digest: the Stop mirror is frequently a
  // light rewording of the closing summary, not a byte-identical copy. The suppressed mirror's
  // own digest is still recorded, so the tailer reading that text off the transcript up to a
  // poll interval later does not post it as narration.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  assert.deepEqual(await router.mirror(TOKEN, "reply", MIRRORED_ANSWER, "session-a"), {
    status: "sent",
  });
  assert.equal(posts.length, 1, "a light rewording is the same answer said twice");
  assert.equal(
    echo.isEcho("session-a", MIRRORED_ANSWER),
    true,
    "a suppressed mirror is still recorded for the tailer's half of the dedup",
  );
});

test("a genuinely different mirror, and a full mirror after a summary reply, still post", async () => {
  // The inverted failure is the expensive one: a real reply the operator never sees. A mirror
  // carrying new content must post however recent the answer record is, and a short summary
  // answer must not suppress the long final text it summarizes.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  assert.deepEqual(await router.mirror(TOKEN, "reply", DIFFERENT_REPLY, "session-a"), {
    status: "sent",
  });
  assert.equal(posts.length, 2, "new content posts whatever the record holds");

  await router.reply(TOKEN, SUMMARY_ANSWER);
  assert.deepEqual(await router.mirror(TOKEN, "reply", ANSWER, "session-a"), { status: "sent" });
  assert.equal(posts.length, 4, "the summary was not the content; the full mirror must post");
});

test("one answer suppresses one mirror, not every later identical one", async () => {
  // Consumed on match, the rule every record in the echo memory follows: a standing record
  // would silence a later turn that genuinely ends with the same words.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  await router.mirror(TOKEN, "reply", ANSWER, "session-a");
  assert.equal(posts.length, 1, "the first mirror is the duplicate and is suppressed");

  await router.mirror(TOKEN, "reply", ANSWER, "session-a");
  assert.equal(posts.length, 2, "a later identical mirror has no record left to match");
});

test("a reply run that failed partway records no answer", async () => {
  // The same landed-whole rule the mirror's own record follows: an answer the transport refused
  // partway is not reliably in front of the operator, and remembering it would suppress the Stop
  // mirror carrying the turn's only whole copy.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  let calls = 0;
  const messenger: ThreadMessenger = {
    postToThread: async () => {
      calls += 1;
      if (calls === 3) return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    echo,
  });

  const answer = longReply(30);
  assert.equal((await router.reply(TOKEN, answer)).status, "failed");
  assert.equal(
    echo.isAnswerEcho("session-a", answer),
    false,
    "an answer that never landed whole must not suppress the mirror carrying the same text",
  );
});

test("the reply-kind mirror is the turn boundary: an unmatched record does not survive it", async () => {
  // The record has no clock, so the Stop mirror is its bound: the reply tool always posts before
  // the turn's mirror, and a record still standing when that mirror arrives belongs to a turn
  // that is over. Left standing, turn N's answer could suppress a coincidentally near-matching
  // reply turns later, which is a real reply the operator never sees.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  await router.mirror(TOKEN, "reply", DIFFERENT_REPLY, "session-a");
  assert.equal(posts.length, 2, "the non-matching turn-N mirror posts");

  assert.deepEqual(await router.mirror(TOKEN, "reply", MIRRORED_ANSWER, "session-a"), {
    status: "sent",
  });
  assert.equal(posts.length, 3, "a later turn's coincidental near-match of a dead record must post");
});

test("a mirror suppressed as the tailer's echo still ends the turn for the answer record", async () => {
  // The interim-echo branch returns before the answer consult, and it is still the turn's Stop
  // mirror: the record must die there too, or it would stand into the next turn through exactly
  // the ordering the tailer dedup handles.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  echo.noteInterim("session-a", "the closing text the tailer already narrated");
  await router.mirror(TOKEN, "reply", "the closing text the tailer already narrated", "session-a");
  assert.equal(posts.length, 1, "suppressed through the interim-echo path");

  await router.mirror(TOKEN, "reply", MIRRORED_ANSWER, "session-a");
  assert.equal(posts.length, 2, "the record died at that turn boundary all the same");
});

test("a mirror that is the answer plus a new closing sentence posts whole", async () => {
  // The security direction of near-match dedup: suppressed, the added sentence would reach the
  // operator nowhere. The preconditions pin that the length guard, not the similarity threshold,
  // is what lets this mirror through, so the fixture cannot rot into testing the wrong gate.
  const amended = `${ANSWER} One more thing: the gateway token expires tonight, so rotate it before you log off.`;
  assert.ok(
    similarity(sketchOf(ANSWER), sketchOf(amended)) >= NEAR_MATCH_THRESHOLD,
    "precondition: the sketch alone would call the amended mirror a near-match",
  );
  assert.ok(
    normalizeForSketch(amended).length > normalizeForSketch(ANSWER).length * ANSWER_LENGTH_ALLOWANCE,
    "precondition: the amended mirror is materially longer than the answer",
  );
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  await router.reply(TOKEN, ANSWER);
  assert.deepEqual(await router.mirror(TOKEN, "reply", amended, "session-a"), { status: "sent" });
  assert.equal(posts.length, 2, "the mirror carrying an addendum must post");
  assert.equal(posts[1].text, renderMirror("reply", amended)[0]);
});

test("without an echo memory, a mirror matching the reply tool's answer posts as it always did", async () => {
  // The echo option is absent only when mirroring is off entirely, and the fail direction of
  // this switch matters in both directions: with the memory the duplicate is suppressed, and
  // without it reply and mirror behave exactly as before, two copies and no consultation.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, ANSWER), { status: "sent" });
  assert.deepEqual(await router.mirror(TOKEN, "reply", ANSWER, "session-a"), { status: "sent" });
  assert.deepEqual(
    posts.map((post) => post.text),
    [renderAnswer(ANSWER)[0], renderMirror("reply", ANSWER)[0]],
    "no memory means no suppression: both copies post, exactly the pre-dedup behavior",
  );
});

test("an interim run that stops part way logs its counts, never its text", async () => {
  // The one interim log line that rides beside conversation content. The tailer's own seam is
  // pinned the same way; without this pin a regression widening the router's line would go
  // uncaught.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  let calls = 0;
  const messenger: ThreadMessenger = {
    postToThread: async () => {
      calls += 1;
      if (calls === 2) return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    log: (message) => lines.push(message),
  });

  const narration = `SECRET-interim-marker\n\n${longReply(30)}`;
  const total = renderMirror("interim", narration).length;
  assert.ok(total >= 3, `${total} message(s)`);
  const result = await router.interim("session-a", narration);
  assert.equal(result.status, "failed");

  const captured = lines.join("\n");
  assert.ok(captured.includes(`1 of ${total} messages`), captured);
  assert.ok(!captured.includes("SECRET-interim-marker"), `transcript content leaked into the routing log: ${captured}`);
});

/**
 * The coalescing seam: a messenger that hands every post its own snowflake-shaped id (`1001`,
 * `1002`, ... in landing order) and records edits, plus the knobs the freshness tests turn.
 * `nextPostIdNull` makes the next post land as ok with no readable id, `editError` makes every
 * edit fail with that error, and the delay knobs hold a write on the wire so an invalidation can
 * arrive while it is out. `refuseAt` refuses the post of that call number for rate limiting and
 * `refuseFrom` refuses every post from that call number on, both reporting `retryAfterMs`, which a
 * refusal reporting no wait at all sets to null. `duringWait` runs at each wait the router takes,
 * which is where a gateway arrival lands while a paced run is sitting one out, and `waitOverrunMs`
 * is what each wait costs the clock beyond the time it asked for, which is a stalled event loop or
 * a slow retry seen from the router's side.
 *
 * The writer's clock is the router's clock, and the fake waits advance it, so a refusal's block
 * really does lift while the run waits it out rather than the retry meeting a bucket frozen at the
 * moment it was emptied, and the run's own reactive waits cost the time they claim to.
 */
function narrationHarness(threadFor: (sessionId: string) => string | null = () => THREAD) {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const posts: Array<{ threadId: string; text: string }> = [];
  const edits: Array<{ threadId: string; messageId: string; text: string }> = [];
  const lines: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000;
  let calls = 0;
  const control = {
    nextPostIdNull: false,
    editError: null as string | null,
    editDelayMs: 0,
    postDelayMs: 0,
    refuseAt: null as number | null,
    refuseFrom: null as number | null,
    retryAfterMs: 4_000 as number | null,
    waitOverrunMs: 0,
    duringWait: null as ((ms: number) => void) | null,
  };
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      if (control.postDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, control.postDelayMs));
      }
      calls += 1;
      if (calls === control.refuseAt || (control.refuseFrom !== null && calls >= control.refuseFrom)) {
        return {
          status: "rate-limited",
          rate: { remaining: 0, resetAfterMs: null, retryAfterMs: control.retryAfterMs },
        };
      }
      posts.push({ threadId: input.threadId, text: input.text });
      const messageId = control.nextPostIdNull ? null : String(1_000 + posts.length);
      control.nextPostIdNull = false;
      return { status: "ok", value: { messageId }, rate: NO_RATE_INFO };
    },
    editInThread: async (input) => {
      if (control.editDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, control.editDelayMs));
      }
      edits.push({ threadId: input.threadId, messageId: input.messageId, text: input.text });
      if (control.editError !== null) {
        return { status: "failed", error: control.editError, rate: NO_RATE_INFO };
      }
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor,
    mirrorWriter: createThreadWriter({ messenger, now: () => clock }),
    echo,
    log: (message) => lines.push(message),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms + control.waitOverrunMs;
      control.duringWait?.(ms);
    },
  });
  return { router, posts, edits, lines, sleeps, control, echo };
}

test("consecutive interim chunks grow one narration message by edit", async () => {
  const { router, posts, edits } = narrationHarness();

  assert.deepEqual(await router.interim("session-a", "reading the failing test"), { status: "sent" });
  assert.deepEqual(await router.interim("session-a", "found the off-by-one"), { status: "sent" });

  assert.equal(posts.length, 1, "the second chunk edits instead of posting a second header");
  const merged = appendNarration(renderMirror("interim", "reading the failing test")[0], "found the off-by-one");
  assert.ok(merged !== null);
  assert.deepEqual(edits, [{ threadId: THREAD, messageId: "1001", text: merged }]);
});

test("a foreign gateway message breaks the block and the next chunk posts fresh", async () => {
  // The inverted failure is the one that matters: narration silently appending above the
  // operator's own message, in the one channel approvals are answered in.
  const { router, posts, edits } = narrationHarness();
  await router.interim("session-a", "chunk one");

  router.noteThreadMessage(THREAD, "2000");
  await router.interim("session-a", "chunk two");

  assert.deepEqual(edits, [], "nothing appends above the operator's message");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].text, renderMirror("interim", "chunk two")[0]);
});

test("the remembered message's own gateway echo does not break the block", async () => {
  // Every post this broker makes comes back over the gateway. The narration message's own echo
  // announces nothing newer than itself, and treating it as foreign would put a fresh header on
  // every chunk, which is the wall of headers coalescing exists to end.
  const { router, posts, edits } = narrationHarness();
  await router.interim("session-a", "chunk one");

  router.noteThreadMessage(THREAD, "1001");
  await router.interim("session-a", "chunk two");

  assert.equal(posts.length, 1, "the echo must not force a fresh post");
  assert.equal(edits.length, 1);
});

test("a reply run breaks the block, and so does a mirrored prompt", async () => {
  // Conservative on purpose: the clear costs one header, while stale state risks narration
  // appended above newer content.
  const { router, posts, edits } = narrationHarness();
  await router.interim("session-a", "chunk one");
  await router.reply(TOKEN, "the answer");
  await router.interim("session-a", "chunk two");
  await router.mirror(TOKEN, "prompt", "keep going", "session-a");
  await router.interim("session-a", "chunk three");

  assert.deepEqual(edits, [], "narration never appends above a reply or a prompt");
  assert.equal(posts.length, 5, posts.map((post) => post.text).join("\n---\n"));
});

test("a queued prompt breaks the block, so the next chunk posts below the operator's words", async () => {
  // The operator's typed message is newer than the narration above it, and narration appending
  // back into the block would put the model's later words above the operator's, in the one
  // channel permission approvals are answered in.
  const { router, posts, edits } = narrationHarness();
  await router.interim("session-a", "chunk one");
  await router.interimPrompt("session-a", "check the migration order too", "queued", null);
  await router.interim("session-a", "chunk two");

  assert.deepEqual(edits, [], "narration never appends above the operator's own message");
  assert.deepEqual(
    posts.map((post) => post.text),
    [
      renderMirror("interim", "chunk one")[0],
      renderMirror("prompt", "check the migration order too")[0],
      renderMirror("interim", "chunk two")[0],
    ],
  );
});

test("a Stop mirror dropped as the tailer's echo does not break the block", async () => {
  // The echo-drop branch posts nothing, so the narration message is still the thread's newest
  // and the block it ends a turn with stays growable.
  const { router, posts, edits, echo } = narrationHarness();
  await router.interim("session-a", "the final text");
  // The tailer records what it delivers; the harness stands in for it here.
  echo.noteInterim("session-a", "the final text");

  assert.deepEqual(await router.mirror(TOKEN, "reply", "the final text", "session-a"), {
    status: "sent",
  });
  assert.equal(posts.length, 1, "the echo drop posts nothing");

  await router.interim("session-a", "and one more thing");
  assert.equal(edits.length, 1, "a branch that posted nothing must not cost the block");
  assert.equal(posts.length, 1);
});

test("a failed edit falls back to a fresh post in the same call, and is never retried", async () => {
  // The fail direction of coalescing is always more messages, never lost narration.
  const { router, posts, edits, lines, control } = narrationHarness();
  await router.interim("session-a", "chunk one");

  control.editError = "HTTP 404";
  assert.deepEqual(await router.interim("session-a", "chunk two"), { status: "sent" });
  assert.equal(edits.length, 1, "the refused edit is never retried");
  assert.equal(posts.length, 2, "the chunk still lands, as a fresh message, in the same call");
  assert.equal(posts[1].text, renderMirror("interim", "chunk two")[0]);

  // The refusal leaves a line, because a systematically failing PATCH route otherwise reads
  // exactly like coalescing switched off. The error class only: transcript content is
  // conversation content, and it never appears in the broker log at any level.
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("HTTP 404"), lines[0]);
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(!lines[0].includes("chunk two"), `transcript content leaked into the routing log: ${lines[0]}`);

  // The fallback post is the new block: the next chunk appends to it, not to the message whose
  // edit was refused.
  control.editError = null;
  await router.interim("session-a", "chunk three");
  assert.equal(edits.length, 2);
  assert.equal(edits[1].messageId, "1002");
});

test("a post that landed without a readable id starts no block", async () => {
  // A 2xx whose body yields no id is reported ok with a null messageId: the message is in front
  // of the operator, but there is no target to edit, so nothing must remember it and try.
  const { router, posts, edits, control } = narrationHarness();
  control.nextPostIdNull = true;
  assert.deepEqual(await router.interim("session-a", "chunk one"), { status: "sent" });

  await router.interim("session-a", "chunk two");
  assert.deepEqual(edits, [], "there is no id to edit by, so nothing tries");
  assert.equal(posts.length, 2);
});

test("the remembered content is the exact string handed to the writer, append after append", async () => {
  // appendNarration's precondition is that `existing` is the exact content the message holds on
  // Discord. Any drift between the remembered copy and what the last edit was handed breaks
  // every later merge, so the second edit is the pin: its base must be the first edit's output.
  const { router, edits } = narrationHarness();
  await router.interim("session-a", "one");
  await router.interim("session-a", "two");
  await router.interim("session-a", "three");

  const first = renderMirror("interim", "one")[0];
  const second = appendNarration(first, "two");
  assert.ok(second !== null);
  const third = appendNarration(second, "three");
  assert.ok(third !== null);
  assert.deepEqual(
    edits.map((edit) => edit.text),
    [second, third],
  );
});

test("a split interim run remembers only its final message", async () => {
  // Appending to any earlier message of the run would put text above the messages that followed
  // it; the run's last message is the only one with nothing below it.
  const { router, posts, edits } = narrationHarness();
  const narration = longReply(30);
  const messages = renderMirror("interim", narration);
  assert.ok(messages.length >= 3, `${messages.length} message(s)`);
  await router.interim("session-a", narration);
  assert.equal(posts.length, messages.length);

  await router.interim("session-a", "a small chunk after");
  const merged = appendNarration(messages[messages.length - 1], "a small chunk after");
  assert.ok(merged !== null);
  assert.deepEqual(edits, [
    { threadId: THREAD, messageId: String(1_000 + messages.length), text: merged },
  ]);
});

test("a chunk the merge cannot hold posts fresh, and the block moves to it", async () => {
  const { router, posts, edits } = narrationHarness();
  const wide = "x".repeat(MAX_MESSAGE_LENGTH - 100);
  await router.interim("session-a", wide);
  assert.equal(posts.length, 1, "the wide chunk itself fits one message");

  // Too big to merge into the wide block, small enough for a message of its own.
  await router.interim("session-a", "y".repeat(200));
  assert.equal(edits.length, 0, "an over-ceiling merge is refused, not truncated");
  assert.equal(posts.length, 2);

  await router.interim("session-a", "tail");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, "1002", "the block is the fresh post, not the full one");
});

test("an interim chunk queued ahead of a reply run still appends, and the reply clears behind it", async () => {
  // The clear runs inside the reply's chained task, at the moment its messages actually go out,
  // never at hand-off: until the reply task runs, the narration message really is the thread's
  // newest, and the append queued ahead of it is entitled to go first. A hand-off clear would
  // instead make the queued chunk post fresh and re-remember, leaving state that names a message
  // with the reply below it.
  const { router, posts, edits } = narrationHarness();
  await router.interim("session-a", "chunk one");

  // Both queued before either task runs: the chunk holds the earlier place on the chain.
  const append = router.interim("session-a", "chunk two");
  const reply = router.reply(TOKEN, "the answer");
  assert.deepEqual(await append, { status: "sent" });
  assert.deepEqual(await reply, { status: "sent" });

  assert.equal(edits.length, 1, "the queued chunk appends: nothing newer had landed when it ran");
  assert.equal(edits[0].messageId, "1001");
  assert.equal(posts.length, 2, "the reply posts below the grown block");
  assert.equal(posts[1].text, renderAnswer("the answer")[0]);

  // The reply's task cleared the state as it ran, so nothing appends above the reply.
  await router.interim("session-a", "chunk three");
  assert.equal(edits.length, 1);
  assert.equal(posts.length, 3, "the chunk after the reply posts fresh, below it");
});

test("an invalidation arriving while an append is queued is honored at the wire", async () => {
  // The state is consulted inside the chained task, at the moment the write goes out, never at
  // call time. Chunk two's edit is held on the wire, chunk three queues behind it, and the
  // foreign message arrives while both are pending: chunk two's late success must not resurrect
  // the state, and chunk three must post fresh, below whatever landed.
  const { router, posts, edits, control } = narrationHarness();
  await router.interim("session-a", "chunk one");

  control.editDelayMs = 30;
  const second = router.interim("session-a", "chunk two");
  // Lets chunk two's task start, so its edit is on the wire before the invalidation rather than
  // queued behind it.
  await new Promise((resolve) => setImmediate(resolve));
  const third = router.interim("session-a", "chunk three");
  router.noteThreadMessage(THREAD, "the-operators-message");
  assert.deepEqual(await second, { status: "sent" });
  assert.deepEqual(await third, { status: "sent" });

  assert.equal(edits.length, 1, "chunk two's append was already committed to the wire");
  assert.equal(posts.length, 2, "chunk three's decision was made at the wire, so it posts fresh");
  assert.equal(posts[1].text, renderMirror("interim", "chunk three")[0]);
});

test("the coalescing state is bounded, so a fleet of threads cannot grow it without limit", async () => {
  // The cap is MAX_NARRATION_THREADS in outbound.ts, 64 like the drop log's. The 65th thread's
  // insert evicts the oldest entry, and what that costs the evicted thread is one fresh header.
  const { router, posts, edits } = narrationHarness((sessionId) => `thread-${sessionId}`);
  for (let index = 0; index <= 64; index += 1) {
    await router.interim(`s${index}`, "a chunk");
  }

  await router.interim("s0", "another chunk");
  assert.deepEqual(edits, [], "the oldest entry was evicted at the cap");
  assert.equal(posts.length, 66);

  await router.interim("s64", "another chunk");
  assert.equal(edits.length, 1, "an entry inside the cap still appends");
});

test("an invalidation during the fresh post's round trip means the run is not remembered", async () => {
  // The task takes its entry off the map before posting, so a message landing while the post is
  // on the wire finds nothing to clear; the moved invalidation clock is how it reaches the task.
  // Refusing to remember costs one header, while remembering would bury the mid-post arrival, a
  // permission prompt as easily as the operator's message, under every later append.
  const { router, posts, edits, control } = narrationHarness();
  control.postDelayMs = 30;
  const first = router.interim("session-a", "chunk one");
  // Lets the task start, so the post is on the wire when the foreign message arrives.
  await new Promise((resolve) => setImmediate(resolve));
  router.noteThreadMessage(THREAD, "2000");
  assert.deepEqual(await first, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk two");
  assert.deepEqual(edits, [], "a run posted around a foreign message is not a block to grow");
  assert.equal(posts.length, 2);
});

test("the run's own gateway echo mid-round-trip does not forfeit the block", async () => {
  // Discord routinely delivers a bot's own MESSAGE_CREATE echo over the websocket before the
  // REST response resolves, so this ordering is the common case of every fresh post, not a rare
  // race. The echo carries the run's own message, which announces nothing newer than the run's
  // final message by snowflake order, so the state is remembered and the next chunk appends.
  const { router, posts, edits, control } = narrationHarness();
  control.postDelayMs = 30;
  const first = router.interim("session-a", "chunk one");
  // Lets the task start, so the post is on the wire when its own echo arrives.
  await new Promise((resolve) => setImmediate(resolve));
  router.noteThreadMessage(THREAD, "1001");
  assert.deepEqual(await first, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk two");
  assert.equal(edits.length, 1, "the next chunk appends: the echo announced nothing newer");
  assert.equal(edits[0].messageId, "1001");
  assert.equal(posts.length, 1);
});

test("a late echo of an older message mid-round-trip does not forfeit the block", async () => {
  // A reply run's echoes can trail into the next fresh interim post's round trip. Older than
  // the run's own final message by snowflake order, they announce nothing newer, so the state
  // is remembered all the same.
  const { router, posts, edits, control } = narrationHarness();
  await router.interim("session-a", "chunk one");
  await router.reply(TOKEN, "the answer");

  control.postDelayMs = 30;
  const fresh = router.interim("session-a", "chunk two");
  await new Promise((resolve) => setImmediate(resolve));
  // The reply message's late echo, older than the fresh post going out as message 1003.
  router.noteThreadMessage(THREAD, "1002");
  assert.deepEqual(await fresh, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk three");
  assert.equal(edits.length, 1, "the reply's late echo is older than the run's final message");
  assert.equal(edits[0].messageId, "1003");
  assert.equal(posts.length, 3);
});

test("a foreign newer arrival still refuses the remember when an older echo lands after it", async () => {
  // Gateway echoes arrive out of order: a foreign message can echo first and the run's own,
  // older message after it. The high-water mark is monotonic, the max of everything seen, never
  // a blind overwrite: lowered by the late echo, the gate would read nothing newer, remember the
  // run, and the next chunk would append above the foreign message, in the channel approvals
  // are answered in.
  const { router, posts, edits, control } = narrationHarness();
  control.postDelayMs = 30;
  const first = router.interim("session-a", "chunk one");
  await new Promise((resolve) => setImmediate(resolve));
  router.noteThreadMessage(THREAD, "9999");
  router.noteThreadMessage(THREAD, "1001");
  assert.deepEqual(await first, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk two");
  assert.deepEqual(edits, [], "nothing appends above the foreign message");
  assert.equal(posts.length, 2, "the next chunk posts fresh, below what landed");
  assert.equal(posts[1].text, renderMirror("interim", "chunk two")[0]);
});

test("an arrival whose ID does not parse mid-round-trip still refuses the remember", async () => {
  // What snowflake order cannot judge falls to the ID-less clock and refuses conservatively,
  // exactly as an endNarration does: the fail direction is one fresh header, never narration
  // appended above an arrival that might be newer.
  const { router, posts, edits, control } = narrationHarness();
  control.postDelayMs = 30;
  const first = router.interim("session-a", "chunk one");
  await new Promise((resolve) => setImmediate(resolve));
  router.noteThreadMessage(THREAD, "not-a-snowflake");
  assert.deepEqual(await first, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk two");
  assert.deepEqual(edits, [], "an unjudgeable arrival is treated as newer");
  assert.equal(posts.length, 2, "the next chunk posts fresh");
});

test("the high-water map is bounded, and an eviction mid-round-trip refuses the remember", async () => {
  // The cap is MAX_NARRATION_THREADS, shared with the sibling maps, but a dropped mark would
  // fail in the opposite direction from a dropped state or clock entry: the remember gate would
  // read the thread as having seen nothing newer and remember a run posted around the very
  // foreign message the evicted mark carried. The eviction bumps the evicted thread's ID-less
  // clock for exactly that reason, so the fail direction is the one every path here holds: one
  // fresh header, never narration above an arrival.
  const { router, posts, edits, control } = narrationHarness((sessionId) => `thread-${sessionId}`);
  control.postDelayMs = 30;
  const first = router.interim("s0", "a chunk");
  await new Promise((resolve) => setImmediate(resolve));
  // A foreign message lands in s0's thread while its post is on the wire, and the mark carrying
  // it is then evicted by 64 other threads' arrivals before the round trip resolves.
  router.noteThreadMessage("thread-s0", "9999");
  for (let index = 1; index <= 64; index += 1) {
    router.noteThreadMessage(`thread-s${index}`, "9999");
  }
  assert.deepEqual(await first, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("s0", "another chunk");
  assert.deepEqual(edits, [], "the evicted mark's thread refuses the remember, it does not permit it");
  assert.equal(posts.length, 2, "the next chunk posts fresh, below what landed");
});

test("a held mark older than the run's final message permits the remember", async () => {
  // The gate compares by snowflake order rather than by whether any mark is held: a thread this
  // router has posted into before holds a mark from those messages, and every later post
  // outranks it, so a held mark must not refuse on its own. Without this, the mark would end
  // coalescing on the second chunk of every thread the gateway has ever echoed.
  const { router, posts, edits } = narrationHarness();
  // The echo of an earlier post, older than everything this run will send.
  router.noteThreadMessage(THREAD, "500");

  await router.interim("session-a", "chunk one");
  await router.interim("session-a", "chunk two");
  assert.equal(edits.length, 1, "the older mark does not refuse the remember");
  assert.equal(posts.length, 1);
});

test("a late echo of an older message does not clear the newest narration message", async () => {
  // A split run's earlier messages echo back after its final one was remembered, and a reply
  // run's echoes can trail a fresh interim post the same way. Snowflake order is thread order,
  // so only something strictly newer than the remembered message ends the block; clearing on the
  // old echoes would silently end coalescing after every split run for as long as the gateway
  // lags.
  const { router, posts, edits } = narrationHarness();
  const narration = longReply(30);
  const messages = renderMirror("interim", narration);
  assert.ok(messages.length >= 3, `${messages.length} message(s)`);
  await router.interim("session-a", narration);

  // The echoes of every message of the run arrive, the remembered final one included.
  for (let index = 1; index <= messages.length; index += 1) {
    router.noteThreadMessage(THREAD, String(1_000 + index));
  }
  await router.interim("session-a", "a small chunk after");
  assert.equal(edits.length, 1, "the run's own echoes must not force a fresh header");
  assert.equal(edits[0].messageId, String(1_000 + messages.length));

  // Something genuinely newer still clears.
  router.noteThreadMessage(THREAD, "9999");
  await router.interim("session-a", "after the operator spoke");
  assert.equal(edits.length, 1);
  assert.equal(posts.length, messages.length + 1);
});

test("a notice or alert posting outside the router ends the block without the gateway", async () => {
  // Notices and permission alerts go out through the steering writer, never through this
  // router, and their gateway echoes are lost while the gateway is disconnected. endNarration is
  // the direct clear index.ts wires to their successful posts.
  const { router, posts, edits, control } = narrationHarness();
  await router.interim("session-a", "chunk one");
  router.endNarration(THREAD);
  await router.interim("session-a", "chunk two");
  assert.deepEqual(edits, [], "nothing appends above the notice");
  assert.equal(posts.length, 2);

  // Landing during a fresh post's round trip, it bumps the invalidation clock as well, so the
  // run posted around it is not remembered above it.
  router.endNarration(THREAD);
  control.postDelayMs = 30;
  const third = router.interim("session-a", "chunk three");
  await new Promise((resolve) => setImmediate(resolve));
  router.endNarration(THREAD);
  assert.deepEqual(await third, { status: "sent" });
  control.postDelayMs = 0;

  await router.interim("session-a", "chunk four");
  assert.deepEqual(edits, [], "chunk four posts fresh below the prompt");
  assert.equal(posts.length, 4);
});

test("a run refused for rate limiting part way through waits it out and lands whole", async () => {
  // The report the operator reads hours later on a phone. Half of it is strictly worse than all
  // of it arriving a few seconds later, and rate limiting is the refusal class where nothing
  // landed, so the same message goes again rather than the rest being dropped.
  const { router, posts, sleeps, control } = narrationHarness();
  control.refuseAt = 3;
  control.retryAfterMs = 4_000;

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

  assert.deepEqual(
    posts.map((post) => post.text),
    messages,
    "every message the renderer produced is on the thread, in order",
  );
  assert.deepEqual(
    sleeps.filter((ms) => ms !== RUN_PACE_MS),
    [4_000],
    "one reactive wait, of exactly the length the refusal reported",
  );
  assert.equal(
    sleeps.filter((ms) => ms === RUN_PACE_MS).length,
    messages.length - 1,
    "the pacing is unchanged by the refusal: one gap between each pair of posts",
  );
});

test("consecutive posts of one run are spaced, and a run of one message waits for nothing", async () => {
  const paced = narrationHarness();
  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  await paced.router.mirror(TOKEN, "reply", reply, "session-a");
  assert.deepEqual(
    paced.sleeps,
    Array.from({ length: messages.length - 1 }, () => RUN_PACE_MS),
    "a gap between consecutive posts and none before the first",
  );

  const single = narrationHarness();
  assert.equal(renderMirror("prompt", "one short line").length, 1);
  await single.router.mirror(TOKEN, "prompt", "one short line", "session-a");
  assert.deepEqual(single.sleeps, [], "a run with nothing to pace against spends no time");
});

test("a run whose waiting would pass the cap stops and says how far it got", async () => {
  // The bound on how long one report can hold its thread's chain. Past it the run answers the way
  // it answers any refusal it cannot pass, which is the line the runbook sends an operator to.
  const { router, posts, sleeps, lines, control } = narrationHarness();
  control.refuseAt = 3;
  control.retryAfterMs = MAX_RUN_WAIT_MS + 1;

  const reply = longReply(30);
  const total = renderMirror("reply", reply).length;
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), {
    status: "failed",
    error: "rate limited",
  });

  assert.equal(posts.length, 2, "the refused message is not posted and the rest are dropped");
  assert.deepEqual(
    sleeps,
    [RUN_PACE_MS, RUN_PACE_MS],
    "the gaps ahead of the second and third posts: a wait past the cap is not taken at all",
  );
  assert.ok(
    lines.join("\n").includes(`stopped after 2 of ${total} messages: rate limited`),
    lines.join("\n"),
  );
});

test("a run whose waiting reaches the cap exactly still runs to the end", async () => {
  // The boundary the cap is read at: the wait that would pass it stops the run, the wait that
  // lands on it is spent.
  const { router, posts, sleeps, control } = narrationHarness();
  control.refuseAt = 3;
  control.retryAfterMs = MAX_RUN_WAIT_MS;

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

  assert.equal(posts.length, messages.length);
  assert.deepEqual(
    sleeps.filter((ms) => ms !== RUN_PACE_MS),
    [MAX_RUN_WAIT_MS],
  );
});

test("the pacing of a long run is not spent against the waiting cap", async () => {
  // The two are different things: a pacing gap is what keeps the bucket full, not evidence that
  // it is empty. A run this long spends more time pacing than the cap allows for waiting, so a
  // cap that counted the gaps would amputate it around the middle.
  const { router, posts, sleeps, control } = narrationHarness();
  const reply = longReply(300);
  const messages = renderMirror("reply", reply);
  assert.ok(
    (messages.length - 1) * RUN_PACE_MS > MAX_RUN_WAIT_MS,
    `${messages.length} message(s) pace for ${(messages.length - 1) * RUN_PACE_MS}ms`,
  );
  control.refuseAt = messages.length;
  control.retryAfterMs = 4_000;

  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });
  assert.equal(posts.length, messages.length, "the run lands whole, refusal and all");
  assert.deepEqual(
    sleeps.filter((ms) => ms !== RUN_PACE_MS),
    [4_000],
  );
});

test("a rate-limited refusal that reports no wait is sat out blind", async () => {
  // A refusal whose headers named no reset at all. Waiting nothing would spend the run's retries
  // against a bucket that has not moved.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const posts: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const writer: ThreadWriter = {
    reply: async (_threadId, text) => {
      calls += 1;
      if (calls === 2) return { status: "rate-limited", rate: NO_RATE_INFO };
      posts.push(text);
      return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
    },
    edit: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    notice: async () => true,
    alert: async () => ({ status: "ok", value: { messageId: null }, rate: NO_RATE_INFO }),
  };
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

  assert.equal(posts.length, messages.length, "the blind wait is followed by the same message");
  assert.deepEqual(
    sleeps.filter((ms) => ms !== RUN_PACE_MS),
    [5_000],
  );
});

test("a reported wait of zero or less names nothing to wait and is sat out blind", async () => {
  // The blind branch is the loop's termination guard, and it covers more than an absent wait:
  // Discord sends zero and sub-second values, and a run that honored a reported zero literally
  // would post as fast as the event loop allows while accruing nothing against the cap. A branch
  // narrowed back to the absent case alone would leave the suite green and the hammer restored.
  for (const reported of [null, 0, -5_000]) {
    const { router, posts, sleeps, control } = narrationHarness();
    control.refuseAt = 2;
    control.retryAfterMs = reported;

    const reply = longReply(30);
    const messages = renderMirror("reply", reply);
    assert.ok(messages.length >= 3, `${messages.length} message(s)`);
    assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

    assert.equal(posts.length, messages.length, `the run landed whole after a ${String(reported)} wait`);
    assert.deepEqual(
      sleeps.filter((ms) => ms !== RUN_PACE_MS),
      [5_000],
      `a reported wait of ${String(reported)} is sat out blind`,
    );
  }
});

test("a refusal reporting a sliver of a millisecond is sat out for the floor", async () => {
  // Such a wait passes every guard ahead of the floor: it is finite, it is positive, and it is a
  // long way under the cap. Honored literally it is a request storm rather than a pause, because a
  // timer floors at about a millisecond and the cap would need hundreds of millions of iterations
  // to catch a run spending fractions of one.
  const { router, posts, sleeps, control } = narrationHarness();
  control.refuseAt = 2;
  control.retryAfterMs = 0.0001;

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

  assert.equal(posts.length, messages.length);
  assert.deepEqual(
    sleeps.filter((ms) => ms !== RUN_PACE_MS),
    [1_000],
    "the reported sliver is raised to the floor rather than taken as written",
  );
});

test("a wait that is not a finite number is sat out blind rather than acted on", async () => {
  // The transport clamps what arrives off the wire, and this is the loop's own reading of the same
  // value, held here because the two failures a non-finite wait causes are not proportionate: a
  // `NaN` passes the "already elapsed" test, defeats the cap (every comparison against it is
  // false), and sleeps for no time, which is an unbounded retry loop holding the thread's chain.
  for (const reported of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const posts: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    // A plain writer rather than a real one over a budget: what is under test is the loop's own
    // guard, and a real budget fed a non-finite wait blocks forever on its own, which would hide
    // the loop's answer behind the bucket's.
    const writer: ThreadWriter = {
      reply: async (_threadId, text) => {
        calls += 1;
        if (calls === 2) {
          return { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: reported } };
        }
        posts.push(text);
        return { status: "ok", value: { messageId: `msg-${calls}` }, rate: NO_RATE_INFO };
      },
      edit: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
      notice: async () => true,
      alert: async () => ({ status: "ok", value: { messageId: null }, rate: NO_RATE_INFO }),
    };
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const reply = longReply(30);
    const messages = renderMirror("reply", reply);
    assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), { status: "sent" });

    assert.equal(posts.length, messages.length, `the run landed whole after a ${String(reported)} wait`);
    assert.deepEqual(
      sleeps.filter((ms) => ms !== RUN_PACE_MS),
      [5_000],
      `a wait of ${String(reported)} names nothing this run can act on`,
    );
  }
});

test("the waiting cap counts what a wait cost, not what it asked for", async () => {
  // The cap exists to bound how long a run holds its thread's ordering chain waiting, and a cap
  // read against the request alone bounds the number of retries instead: a run whose waits overrun,
  // because the event loop stalled or the retry itself was slow, would sit far past it. Here every
  // wait costs thirty times what it asked for, so a cap counting requests would let this run wait
  // for half an hour of the thread's chain and call it a minute.
  const { router, sleeps, lines, control } = narrationHarness();
  control.refuseFrom = 2;
  control.retryAfterMs = 100;
  control.waitOverrunMs = 29_000;

  const reply = longReply(30);
  const total = renderMirror("reply", reply).length;
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), {
    status: "failed",
    error: "rate limited",
  });

  const reactive = sleeps.filter((ms) => ms !== RUN_PACE_MS);
  assert.deepEqual(reactive, [1_000, 1_000], "two waits of thirty seconds each fill the cap");
  assert.ok(
    reactive.length * (1_000 + control.waitOverrunMs) <= MAX_RUN_WAIT_MS,
    `the run really waited ${reactive.length * (1_000 + control.waitOverrunMs)}ms against a ${MAX_RUN_WAIT_MS}ms cap`,
  );
  assert.ok(lines.join("\n").includes(`stopped after 1 of ${total} messages: rate limited`), lines.join("\n"));
});

test("a paced interim run remembers its block when nothing newer landed while it waited", async () => {
  // The freshness gate reads what arrived over the whole of the run, and a reactive wait makes
  // that window seconds long rather than one round trip. An echo of the run's own message is not
  // something newer, so the next chunk still appends.
  const { router, posts, edits, sleeps, control } = narrationHarness();
  control.refuseAt = 2;
  control.retryAfterMs = 4_000;
  control.duringWait = (ms) => {
    if (ms === 4_000) router.noteThreadMessage(THREAD, "1001");
  };

  const narration = longReply(30);
  const messages = renderMirror("interim", narration);
  assert.ok(messages.length >= 3, `${messages.length} message(s)`);
  assert.deepEqual(await router.interim("session-a", narration), { status: "sent" });
  assert.equal(posts.length, messages.length);
  assert.ok(sleeps.includes(4_000), "the run did wait one refusal out");

  await router.interim("session-a", "a small chunk after");
  const merged = appendNarration(messages[messages.length - 1], "a small chunk after");
  assert.ok(merged !== null);
  assert.deepEqual(edits, [
    { threadId: THREAD, messageId: String(1_000 + messages.length), text: merged },
  ]);
});

test("a paced interim run refuses its block when something newer landed while it waited", async () => {
  // The inverted failure is the one that matters: narration appending above a message that landed
  // mid-run, in the channel permission approvals are answered in. The wait widens exactly that
  // window, so what arrives inside it must still be honored.
  //
  // The injected id outranks every id this run posts, and a real message created during the wait
  // could not: snowflakes carry creation time, so it would sit below the posts that follow the
  // wait, and the gate would remember the run above it correctly, because the run's final message
  // really is the thread's newest by then. The reachable shape of what is injected here is a
  // foreign message created after the run's last post, whose gateway echo beats that post's own
  // REST response back. The id is what the gate reads either way, so the fixture names it
  // directly rather than staging the race.
  const { router, posts, edits, control } = narrationHarness();
  control.refuseAt = 2;
  control.retryAfterMs = 4_000;
  control.duringWait = (ms) => {
    if (ms === 4_000) router.noteThreadMessage(THREAD, "9999");
  };

  const narration = longReply(30);
  const messages = renderMirror("interim", narration);
  assert.deepEqual(await router.interim("session-a", narration), { status: "sent" });
  assert.equal(posts.length, messages.length);

  await router.interim("session-a", "a small chunk after");
  assert.deepEqual(edits, [], "nothing appends above the message that landed mid-run");
  assert.equal(posts.length, messages.length + 1, "the next chunk posts fresh below it");
});

test("the cap's stop reads on every posting path as the count it reached", async () => {
  // The three paths each build their own line out of the run's error, and the wording is the
  // discriminator the runbook sends an operator to. The reply tool's is also what the model reads
  // back: it carries the count, because a bare error invites resending an answer whose first
  // messages are already on the thread.
  const answered = narrationHarness();
  answered.control.refuseAt = 3;
  answered.control.retryAfterMs = MAX_RUN_WAIT_MS + 1;
  const answer = longReply(30);
  const answerTotal = renderAnswer(answer).length;
  assert.deepEqual(await answered.router.reply(TOKEN, answer), {
    status: "failed",
    error: `stopped after 2 of ${answerTotal} messages: rate limited`,
  });
  assert.ok(
    answered.lines.join("\n").includes(`stopped after 2 of ${answerTotal} messages: rate limited`),
    answered.lines.join("\n"),
  );

  const narrated = narrationHarness();
  narrated.control.refuseAt = 3;
  narrated.control.retryAfterMs = MAX_RUN_WAIT_MS + 1;
  const narration = longReply(30);
  const narrationTotal = renderMirror("interim", narration).length;
  assert.deepEqual(await narrated.router.interim("session-a", narration), {
    status: "failed",
    error: "rate limited",
  });
  assert.ok(
    narrated.lines.join("\n").includes(`stopped after 2 of ${narrationTotal} messages: rate limited`),
    narrated.lines.join("\n"),
  );
});

/**
 * A registry that records what the router engaged, over a real one so every other path behaves as
 * it does in production: the stamp is a fact about a session the registry holds, and a hand-built
 * double would answer `current` from a shape nothing else in the router agrees with.
 */
function engagementSpy(registry: Registry): { registry: Registry; engaged: string[] } {
  const engaged: string[] = [];
  return {
    registry: {
      ...registry,
      engage: (sessionId: string) => {
        engaged.push(sessionId);
        registry.engage(sessionId);
      },
    },
    engaged,
  };
}

test("a mirrored prompt engages its session, and a reply or interim never does", async () => {
  // Engagement is what clears a standing blocked marker, so it means a person spoke: a reply is
  // Claude's own words and narration is the transcript being read, and either one stamping would
  // clear the marker a blocked run just raised.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer } = fakeWriter();
  const router = routerFor({ registry: spy.registry, threadFor: () => THREAD, mirrorWriter: writer });

  await router.mirror(TOKEN, "prompt", "run the migration", "session-a");
  assert.deepEqual(spy.engaged, ["session-a"]);

  await router.mirror(TOKEN, "reply", "the migration is done", "session-a");
  await router.interim("session-a", "reading the schema");
  await router.reply(TOKEN, "the migration is done");
  assert.deepEqual(spy.engaged, ["session-a"], "only a prompt is a person speaking");
});

test("a mirrored prompt the straggler gate turns away engages nothing", async () => {
  // The post named a conversation that ended at a /clear, so nothing about the session the token
  // holds now can be read from it.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  announce(spy.registry, "session-b", TOKEN, "clear");
  const { writer } = fakeWriter();
  const router = routerFor({ registry: spy.registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", "still here", "session-a"), {
    status: "no-session",
  });
  assert.deepEqual(spy.engaged, []);
});

test("a prompt dropped as the operator's own channel echo still engages the session", async () => {
  // An injected channel message means the operator answered from their phone. The drop is about
  // not echoing their words back into the thread they typed them in, and says nothing about
  // whether they spoke, which is the fact the stamp records.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry: spy.registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: () => {},
  });

  const envelope = '<channel source="channel-relay" chat_id="123">the migration finished?</channel>';
  assert.equal((await router.mirror(TOKEN, "prompt", envelope, "session-a")).status, "failed");
  assert.deepEqual(await router.interimPrompt("session-a", envelope, "queued", null), {
    status: "failed",
    error: "the message came from the channel",
  });

  assert.deepEqual(posts, [], "the echo is still not posted back");
  assert.deepEqual(spy.engaged, ["session-a", "session-a"], "both paths stamp the answer");
});

test("a queued prompt engages its session once its thread resolves, and not before", async () => {
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer } = fakeWriter();
  const unbound = routerFor({
    registry: spy.registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: () => {},
  });
  assert.deepEqual(await unbound.interimPrompt("session-a", "check the order too", "queued", null), {
    status: "no-thread",
  });
  assert.deepEqual(spy.engaged, []);

  const bound = routerFor({ registry: spy.registry, threadFor: () => THREAD, mirrorWriter: writer });
  assert.deepEqual(await bound.interimPrompt("session-a", "check the order too", "queued", null), {
    status: "sent",
  });
  assert.deepEqual(spy.engaged, ["session-a"]);
});

test("the stamp a mirrored prompt writes lands on the record the surfaces read", async () => {
  // The spy above proves the call; this proves the call moves the field the blocked derivation
  // compares a goal-blocked event against.
  let at = 1_000_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: () => at });
  announce(registry, "session-a");
  const { writer } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  at += 5_000;
  await router.mirror(TOKEN, "prompt", "run the migration", "session-a");
  const record = registry.list()[0];
  assert.equal(record.lastEngagementAt, at);
  assert.notEqual(record.lastHookAt, at, "the prompt is not hook traffic of its own");
});

test("a mirrored prompt with no thread to post to engages nothing", async () => {
  // The stamp sits behind the straggler gate, which is behind the lookup that resolves the session
  // and its thread. A session with no thread yet is dropped there, so the symmetry with the queued
  // path below holds: neither path stamps for a session the router could not reach.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer } = fakeWriter();
  const router = routerFor({
    registry: spy.registry,
    threadFor: () => null,
    mirrorWriter: writer,
    log: () => {},
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", "session-a"), {
    status: "no-thread",
  });
  assert.deepEqual(spy.engaged, []);
});

test("the harness's wake injection engages nothing, under every notification setting", async () => {
  // A finished background task's report is machine-generated, and engagement is what clears a gate
  // that waits on a person. The setting governs how the report is drawn in the thread, never
  // whether a human wrote it, so `full` (which mirrors the report as an ordinary prompt) and `off`
  // (which posts nothing at all) exclude it exactly as the default does.
  const settings: Array<"brief" | "full" | "off"> = ["brief", "full", "off"];
  for (const taskNotifications of settings) {
    const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
    announce(spy.registry, "session-a");
    const { writer } = fakeWriter();
    const router = routerFor({
      registry: spy.registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      taskNotifications,
      log: () => {},
    });

    await router.mirror(TOKEN, "prompt", WAKE, "session-a");
    await router.interimPrompt("session-a", WAKE, "queued", null);
    assert.deepEqual(spy.engaged, [], `a wake prompt is not a person under ${taskNotifications}`);

    // The marker is read through the invisible strip, like every other reading of it here, so a
    // zero-width character in front of it cannot buy a stamp the plain shape does not get.
    const veiled = String.fromCharCode(0x200b) + WAKE;
    await router.mirror(TOKEN, "prompt", veiled, "session-a");
    await router.interimPrompt("session-a", veiled, "queued", null);
    assert.deepEqual(spy.engaged, [], `a veiled wake prompt too, under ${taskNotifications}`);

    // The session is still reachable and a real prompt still stamps: the exclusion is about this
    // one shape of text, not about a router that has stopped stamping.
    await router.mirror(TOKEN, "prompt", "run the migration", "session-a");
    assert.deepEqual(spy.engaged, ["session-a"], `a typed prompt still stamps under ${taskNotifications}`);
  }
});

test("a peer message engages nothing, under every peer setting", async () => {
  // A message another session sent this one is machine-generated, exactly as the wake injection
  // above is, and engagement is what clears a gate that waits on a person. The setting governs how
  // the message is drawn in the thread, never whether a human wrote it, so `full` and `off` exclude
  // it as the default does.
  const settings: Array<"full" | "brief" | "off"> = ["full", "brief", "off"];
  for (const peerMessages of settings) {
    const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
    announce(spy.registry, "session-a");
    const { writer } = fakeWriter();
    const router = routerFor({
      registry: spy.registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      peerMessages,
      log: () => {},
    });

    await router.mirror(TOKEN, "prompt", idleDelivery(), "session-a");
    await router.interimPrompt("session-a", idleDelivery(), "queued", null);
    assert.deepEqual(spy.engaged, [], `a peer message is not a person under ${peerMessages}`);

    // A delivery this broker could not read the body of is still a delivery, so it is still not a
    // person; the classification's third state must not buy a stamp the readable shape is denied.
    await router.mirror(TOKEN, "prompt", UNREADABLE_DELIVERY, "session-a");
    await router.interimPrompt("session-a", UNREADABLE_DELIVERY, "queued", null);
    assert.deepEqual(spy.engaged, [], `an unreadable delivery either, under ${peerMessages}`);

    // Read through the invisible strip like every other reading here, so a zero-width character in
    // front of the wrapper cannot buy the stamp the plain shape is denied.
    const veiled = String.fromCharCode(0x200b) + idleDelivery();
    await router.mirror(TOKEN, "prompt", veiled, "session-a");
    await router.interimPrompt("session-a", veiled, "queued", null);
    assert.deepEqual(spy.engaged, [], `a veiled delivery too, under ${peerMessages}`);

    // The session is still reachable and a real prompt still stamps: the exclusion is about this
    // one shape of text, not about a router that has stopped stamping.
    await router.mirror(TOKEN, "prompt", "run the migration", "session-a");
    await router.interimPrompt("session-a", "and the seed after it", "queued", null);
    assert.deepEqual(
      spy.engaged,
      ["session-a", "session-a"],
      `a typed prompt still stamps under ${peerMessages}`,
    );
  }
});

test("a peer message leaves a standing blocked state standing, and the operator's prompt clears it", async () => {
  // What the stamp exclusion buys: `⛔` is a `goal-blocked` event newer than the session's last
  // engagement, and it stands until a person answers. Read through the desk that owns that
  // comparison rather than through the arithmetic, so the writer and the reader of the stamp are
  // pinned against each other rather than each against its own literal.
  const at = 1_800_000_000_000;
  let clock = at - 10_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: () => clock });
  announce(registry, "session-a");
  const blocked: SessionGoalEvent = {
    event: "goal-blocked",
    ts: new Date(at - 5_000).toISOString(),
    tsMs: at - 5_000,
    plan: "docs/plans/widget_spec_v1.md",
  };
  const desk = createBlockedDesk({
    // Never opened: the fold below is injected, the way the desk's own tests inject one.
    eventsPath: path.join(os.tmpdir(), "channels-absent", "kit-events.jsonl"),
    threadFor: () => THREAD,
    alert: async () => ({ status: "ok", value: { messageId: "900000000000000011" }, rate: NO_RATE_INFO }),
    operatorId: "700000000000000002",
    now: () => at,
    readEvents: () => ({
      state: {
        offset: 0,
        identity: null,
        midLine: false,
        malformed: 0,
        latest: new Map([["session-a", blocked]]),
      },
      unreadable: false,
    }),
    log: () => {},
  });
  await desk.tick();
  const { writer } = fakeWriter();
  const router = routerFor({ registry, threadFor: () => THREAD, mirrorWriter: writer });
  const standing = (): boolean => desk.standing(registry.list()[0]);
  assert.equal(standing(), true, "the session stands blocked before anything arrives");

  clock = at;
  await router.mirror(TOKEN, "prompt", idleDelivery(), "session-a");
  await router.interimPrompt("session-a", idleDelivery(), "queued", null);
  assert.equal(standing(), true, "a peer message is not the person the block waits on");

  await router.mirror(TOKEN, "prompt", "go ahead, take the second option", "session-a");
  assert.equal(standing(), false, "the operator answering is what clears it");
});

// The prompt pair: a turn-opening prompt reaches a thread by the `UserPromptSubmit` mirror and,
// when that hook is slow or the harness timed it out, by the tailer reading the same line off the
// transcript. One slot per path, each written by its own path and read by the other. The mid-turn
// message the harness queues is out of it entirely, having no second copy anywhere.

/** What the operator typed, in the tests below. */
const PROMPT = "run the migration against the staging copy first";

/**
 * Whether any standing prompt claim covers this text, asked from both sides and consuming whatever
 * it finds.
 *
 * Each path reads the other's slot, so a one-sided question is blind to the claim the asking path
 * made itself, which reads exactly like no claim at all. Every assertion here that a path left
 * nothing behind goes through this, so it cannot go quiet for the wrong reason.
 */
function promptClaimStanding(echo: EchoMemory, sessionId: string, text: string): boolean {
  const asTailer = echo.isPromptEcho(sessionId, text, "tailer");
  return echo.isPromptEcho(sessionId, text, "mirror") || asTailer;
}

test("a recovered prompt matching one the mirror already posted is skipped, and only that one", async () => {
  // The tailer's half of the prompt dedup, which is the normal case: the hook posted the operator's
  // words within milliseconds of the keystroke, and the poll reading the same line an interval
  // later says nothing the thread does not already show.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: (message) => lines.push(message),
  });

  echo.notePrompt("session-a", PROMPT, "mirror");
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 0, "the text is already on the thread and must not double");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(
    !lines[0].includes("migration"),
    `prompt content leaked into the routing log: ${lines[0]}`,
  );

  // The control, and the bound: the match consumed the record, so the same words typed again post.
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.deepEqual(posts.map((post) => post.text), renderMirror("prompt", PROMPT));
});

test("a mirrored prompt matching one the tailer already recovered is skipped, and only that one", async () => {
  // The mirror's half, which is the slow-hook case the recovery exists for: the poll read the line
  // off the transcript and posted it while this hook was still queued behind whatever saturated the
  // host.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const lines: string[] = [];
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: (message) => lines.push(message),
  });

  echo.notePrompt("session-a", PROMPT, "tailer");
  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.equal(posts.length, 0, "the tailer's copy is already on the thread");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
  assert.ok(
    !lines[0].includes("migration"),
    `prompt content leaked into the routing log: ${lines[0]}`,
  );

  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.deepEqual(posts.map((post) => post.text), renderMirror("prompt", PROMPT));
});

test("a mirrored prompt arriving after the tailer's run landed and its grace passed still posts", async () => {
  // The recovery case leaves the tailer's claim with no consult at all: the hook was lost, the run
  // landed, and nothing ever consumes the record. A claim standing the whole claim window past
  // that landing would suppress the operator's next retype of the same words on the mirror path,
  // so a landed run's claim survives only the raced copy's own grace.
  let clock = 5_000_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory({ now: () => clock });
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 1, "the recovered copy posts");

  clock += PROMPT_SETTLE_GRACE_MS + 1;
  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.equal(posts.length, 2, "a mirrored prompt past the grace is the operator's own retype");
});

test("a mirrored prompt racing the tailer's landed run inside the grace is still suppressed", async () => {
  // The suppression the claim exists to provide: the hook post of this same prompt can arrive
  // after the tailer's short run completes, having been in flight since the keystroke, and inside
  // the grace it is that raced copy rather than a retype.
  let clock = 5_000_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory({ now: () => clock });
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 1, "the recovered copy posts");

  clock += PROMPT_SETTLE_GRACE_MS;
  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.equal(posts.length, 1, "the raced copy inside the grace must not double");
});

test("a landed mirror run keeps its claim the whole window, since the tailer's pass consumes it", async () => {
  // The settle rule is the tailer's alone. The mirror claim's consumer is a poll pass that can
  // legitimately run the whole claim window late, so a mirror claim whose life shrank at its own
  // landing would hand the tailer a gap and a duplicate on every slow pass.
  let clock = 5_000_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory({ now: () => clock });
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.equal(posts.length, 1, "the mirrored copy posts");

  clock += PROMPT_SETTLE_GRACE_MS + 1;
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 1, "the tailer's slow pass still meets the mirror's claim");
});

test("an invisible character cannot hide a prompt from the dedup, on either path", async () => {
  // The two copies of one prompt come from a file read and from a hook payload, so they can differ
  // by characters nobody sees. Both sides compare the normalized pre-render text, exactly as the
  // envelope check does.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  echo.notePrompt("session-a", `${PROMPT}  `, "mirror");
  await router.interimPrompt("session-a", `${String.fromCharCode(0x200b)}${PROMPT}`, "turn-open", null);
  echo.notePrompt("session-a", `${PROMPT}  `, "tailer");
  await router.mirror(TOKEN, "prompt", `${String.fromCharCode(0x200b)}${PROMPT}`, "session-a");
  assert.deepEqual(posts, [], "a zero-width difference must not manufacture a second copy");
});

test("neither prompt path records after deferring, so the run still posting keeps its deferral", async () => {
  // A claim asserts that a run is putting this text on the thread now. The path that just deferred
  // is putting nothing there, so a record it made would stand over a copy it never sent and swallow
  // the operator's next retype of the same words.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  echo.notePrompt("session-a", PROMPT, "tailer");
  await router.mirror(TOKEN, "prompt", PROMPT, "session-a");
  assert.equal(
    echo.release("session-a", PROMPT, "prompt-tailer"),
    true,
    "the claiming run must be told its text has nobody else carrying it",
  );
  assert.equal(
    echo.release("session-a", PROMPT, "prompt-tailer"),
    false,
    "the deferral is spent once",
  );

  echo.notePrompt("session-a", PROMPT, "mirror");
  await router.interimPrompt("session-a", PROMPT, "turn-open", null);
  assert.equal(echo.release("session-a", PROMPT, "prompt-mirror"), true);
});

test("a fresh claim on one prompt slot leaves the other path's deferral where it was", async () => {
  // What the split buys that one shared record could not. The tailer dispatches a prompt and claims
  // its own slot; the mirror hook arrives inside that run, defers to the claim, and posts nothing;
  // the operator then types the same words again and the mirror claims for that second copy. With
  // one record for both paths, the mirror's fresh claim would wipe the bit the tailer's first run
  // is owed, and a run that landed nothing would find nothing left to save it. Each path clearing
  // only its own key is what makes that impossible.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const lines: string[] = [];
  const posts: string[] = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      if (posts.length === 1) {
        // The mirror hook, inside the tailer's run: it finds the claim, drops its own copy, and
        // then the operator's retype arrives and the hook claims for that one.
        assert.equal(echo.isPromptEcho("session-a", PROMPT, "mirror"), true);
        echo.notePrompt("session-a", PROMPT, "mirror");
      }
      return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    echo,
    log: (message) => lines.push(message),
  });

  assert.equal((await router.interimPrompt("session-a", PROMPT, "turn-open", null)).status, "failed");
  assert.equal(posts.length, 2, `the run goes again exactly once: ${posts.join("\n")}`);
  assert.ok(
    lines.some((line) => line.includes("reached the thread by neither path")),
    lines.join("\n"),
  );
});

test("a prompt that landed nothing is not remembered as posted, on either path", async () => {
  // The fail direction this whole slot is built around. A claim standing over a prompt the
  // transport refused would silence the other path's copy, and the operator's question would appear
  // nowhere: the recovery exists to close exactly that hole, not to open a second one.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 500", rate: NO_RATE_INFO });
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  // Asked as the path that did not make the claim, which is the only path a standing claim could
  // ever silence, and so the only question that can see one left behind.
  assert.equal((await router.mirror(TOKEN, "prompt", PROMPT, "session-a")).status, "failed");
  assert.equal(
    echo.isPromptEcho("session-a", PROMPT, "tailer"),
    false,
    "a mirror that never landed must not suppress the tailer's copy",
  );

  assert.equal((await router.interimPrompt("session-a", PROMPT, "turn-open", null)).status, "failed");
  assert.equal(
    echo.isPromptEcho("session-a", PROMPT, "mirror"),
    false,
    "a recovered prompt that never landed must not suppress the mirror's copy",
  );
});

test("a prompt the other path deferred to goes again once when its run landed nothing", async () => {
  // The claim's cost on a prompt slot, bounded exactly as it is on the reply pair: the other path
  // met the claim mid-run and dropped its own copy, so a run that then lands nothing is the last
  // thing carrying the operator's question. It goes again, once, and the loss gets its own line.
  for (const which of ["mirror", "tailer"] as const) {
    /** The path that did not make the claim: the only one whose match can ever spend it. */
    const other = which === "mirror" ? "tailer" : "mirror";
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const echo = createEchoMemory();
    const lines: string[] = [];
    const posts: string[] = [];
    const messenger: ThreadMessenger = {
      postToThread: async (input) => {
        posts.push(input.text);
        // The other path arriving inside the run: it finds the claim and drops its own copy.
        if (posts.length === 1) echo.isPromptEcho("session-a", PROMPT, other);
        return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      },
      editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    };
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
      echo,
      log: (message) => lines.push(message),
    });

    const outcome =
      which === "mirror"
        ? await router.mirror(TOKEN, "prompt", PROMPT, "session-a")
        : await router.interimPrompt("session-a", PROMPT, "turn-open", null);
    assert.equal(outcome.status, "failed", which);
    assert.equal(posts.length, 2, `${which}: the run goes again exactly once: ${posts.join("\n")}`);
    assert.ok(
      lines.some((line) => line.includes("reached the thread by neither path")),
      `${which}: ${lines.join("\n")}`,
    );
    assert.ok(
      !lines.join("\n").includes("migration"),
      `${which}: prompt content leaked into the routing log: ${lines.join("\n")}`,
    );
    assert.equal(
      echo.isPromptEcho("session-a", PROMPT, other),
      false,
      `${which}: text on the thread by neither path is claimed by neither path`,
    );
  }
});

test("a second prompt claiming a slot leaves the deferral the first one's run is owed", async () => {
  // The prompt paths are not serialized: the intake answers a `UserPromptSubmit` and dispatches
  // its delivery without awaiting it, so two prompts for one session overlap. The first one's run
  // is behind the thread's ordering chain when the tailer meets its claim, drops its own copy and
  // leaves the deferral bit; the second one's claim arrives inside that window. Clearing the bit
  // there would leave the first run, on landing nothing, with no deferral to find and no retry to
  // take, and the operator's words would reach the thread by neither path.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const echo = createEchoMemory();
  const lines: string[] = [];
  const posts: string[] = [];
  const second = "and the seed after it";
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input.text);
      if (posts.length === 1) {
        // The tailer, inside the first run: it finds the claim and drops its own copy.
        assert.equal(echo.isPromptEcho("session-a", PROMPT, "tailer"), true);
        // The operator's next prompt, whose own hook claims the same slot for different words.
        echo.notePrompt("session-a", second, "mirror");
      }
      return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
    echo,
    log: (message) => lines.push(message),
  });

  assert.equal((await router.mirror(TOKEN, "prompt", PROMPT, "session-a")).status, "failed");
  assert.equal(posts.length, 2, `the first run goes again exactly once: ` + posts.join("|"));
  assert.ok(
    lines.some((line) => line.includes("reached the thread by neither path")),
    lines.join("|"),
  );
});

test("a prompt that rendered to nothing leaves no claim behind", async () => {
  // The claim is made after the render on both prompt paths, so nothing visible means nothing
  // claimed: a digest left standing here would suppress the other path's copy of the same text.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  const blank = String.fromCharCode(0x200b);
  assert.equal((await router.interimPrompt("session-a", blank, "turn-open", null)).status, "failed");
  assert.equal((await router.mirror(TOKEN, "prompt", blank, "session-a")).status, "failed");
  assert.deepEqual(posts, []);
  assert.equal(
    promptClaimStanding(echo, "session-a", blank),
    false,
    "nothing posted, nothing claimed",
  );
});

test("the prompt pair and the reply pair answer for their own registers only", async () => {
  // The operator's words and Claude's are two attributions on the thread, so one is never the
  // other's duplicate: a reply repeating the question back does not become the prompt's second
  // copy, and narration is not consulted against the prompt slots at all.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  echo.notePrompt("session-a", PROMPT, "mirror");
  await router.mirror(TOKEN, "reply", PROMPT, "session-a");
  await router.interim("session-a", PROMPT);
  assert.equal(posts.length, 2, posts.map((post) => post.text).join("\n---\n"));
  assert.equal(
    echo.isPromptEcho("session-a", PROMPT, "tailer"),
    true,
    "the prompt's own record is untouched by either reply-register path",
  );

  // And the reverse: neither reply-register claim suppresses a prompt carrying the same words.
  echo.noteInterim("session-a", PROMPT);
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 3, "narration's claim is not a prompt slot's");

  const other = "and check the index while you are there";
  echo.noteReply("session-a", other);
  assert.deepEqual(await router.mirror(TOKEN, "prompt", other, "session-a"), { status: "sent" });
  assert.equal(posts.length, 4, "a reply's claim is not a prompt slot's");
});

test("one turn-opening prompt stamps engagement once, on the path that actually posted it", async () => {
  // The stamp records that a person spoke, and one prompt is one person speaking once. The
  // recovery reads the same line up to a poll interval after the hook carried it, so a stamp taken
  // there for a copy the hook already accounted for would move `lastEngagementAt` forward with
  // nobody behind the move. The test below pins what that costs.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry: spy.registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  echo.notePrompt("session-a", PROMPT, "mirror");
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.deepEqual(posts, []);
  assert.deepEqual(spy.engaged, [], "the suppressed copy stamps nothing");

  // The control, and the case the recovery exists for: with no mirror claim standing, this read is
  // the operator's only copy and it stamps.
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 1);
  assert.deepEqual(spy.engaged, ["session-a"]);

  // A queued mid-turn message consults nothing, so it stamps whatever else is standing: it has no
  // second copy anywhere and is always words a person just typed.
  echo.notePrompt("session-a", "check the index too", "mirror");
  assert.deepEqual(await router.interimPrompt("session-a", "check the index too", "queued", null), {
    status: "sent",
  });
  assert.deepEqual(spy.engaged, ["session-a", "session-a"]);
});

test("a suppressed turn-opening prompt does not clear a block raised after its hook", async () => {
  // The failure the position of that stamp closes, through the desk that owns the comparison
  // rather than through the arithmetic. The hook stamps at the instant the operator pressed
  // return; the session then stops blocked and writes its `goal-blocked`; the poll reads the same
  // line an interval later. A stamp there would be newer than the block and would clear it, and
  // the fleet card would show as idle a session that is standing on a person.
  const at = 1_800_000_000_000;
  let clock = at - 20_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: () => clock });
  announce(registry, "session-a");
  const blocked: SessionGoalEvent = {
    event: "goal-blocked",
    ts: new Date(at - 5_000).toISOString(),
    tsMs: at - 5_000,
    plan: "docs/plans/widget_spec_v1.md",
  };
  const desk = createBlockedDesk({
    // Never opened: the fold below is injected, the way the desk's own tests inject one.
    eventsPath: path.join(os.tmpdir(), "channels-absent", "kit-events.jsonl"),
    threadFor: () => THREAD,
    alert: async () => ({ status: "ok", value: { messageId: "900000000000000011" }, rate: NO_RATE_INFO }),
    operatorId: "700000000000000002",
    now: () => at,
    readEvents: () => ({
      state: {
        offset: 0,
        identity: null,
        midLine: false,
        malformed: 0,
        latest: new Map([["session-a", blocked]]),
      },
      unreadable: false,
    }),
    log: () => {},
  });
  await desk.tick();
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });
  const standing = (): boolean => desk.standing(registry.list()[0]);

  // The hook, ten seconds before the block: it posts, claims, and stamps.
  clock = at - 10_000;
  assert.deepEqual(await router.mirror(TOKEN, "prompt", PROMPT, "session-a"), { status: "sent" });
  assert.equal(posts.length, 1);
  assert.equal(standing(), true, "the block is newer than the hook's stamp, so it stands");

  // The poll, five seconds after the block, reading the line the hook already carried.
  clock = at;
  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), { status: "sent" });
  assert.equal(posts.length, 1, "the copy is suppressed, as the healthy case requires");
  assert.equal(standing(), true, "and it clears nothing on its way out");

  // The control: a prompt the operator really typed after the block, with no claim standing, is
  // what clears it. Without this the assertion above could pass on a desk that never clears.
  assert.deepEqual(await router.interimPrompt("session-a", "go ahead", "turn-open", null), {
    status: "sent",
  });
  assert.equal(standing(), false, "the operator answering is what clears it");
});

test("a recovered prompt is engagement at the instant it was typed, not the instant it was read", async () => {
  // The case the whole section exists for, and the direction round 3 did not close. The hook is
  // lost, so the poll's copy is the only one; but the poll runs up to an interval behind the file,
  // and a stamp taken at read time would sit past a `goal-blocked` the turn raised in between and
  // clear a block nobody answered. The line's own timestamp is when the operator spoke.
  const at = 1_800_000_000_000;
  let clock = at - 30_000;
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000, now: () => clock });
  announce(registry, "session-a");
  const blocked: SessionGoalEvent = {
    event: "goal-blocked",
    ts: new Date(at - 5_000).toISOString(),
    tsMs: at - 5_000,
    plan: "docs/plans/widget_spec_v1.md",
  };
  const desk = createBlockedDesk({
    // Never opened: the fold below is injected, the way the desk's own tests inject one.
    eventsPath: path.join(os.tmpdir(), "channels-absent", "kit-events.jsonl"),
    threadFor: () => THREAD,
    alert: async () => ({ status: "ok", value: { messageId: "900000000000000011" }, rate: NO_RATE_INFO }),
    operatorId: "700000000000000002",
    now: () => at,
    readEvents: () => ({
      state: {
        offset: 0,
        identity: null,
        midLine: false,
        malformed: 0,
        latest: new Map([["session-a", blocked]]),
      },
      unreadable: false,
    }),
    log: () => {},
  });
  await desk.tick();
  const { writer, posts } = fakeWriter();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo: createEchoMemory(),
    log: () => {},
  });
  const standing = (): boolean => desk.standing(registry.list()[0]);
  assert.equal(standing(), true, "the session stands blocked before anything arrives");

  // The poll, five seconds after the block, reading a line written twenty seconds before it. The
  // copy posts, because nothing else carried it, and the stamp it takes is the line's own.
  clock = at;
  assert.deepEqual(
    await router.interimPrompt("session-a", PROMPT, "turn-open", at - 20_000),
    { status: "sent" },
  );
  assert.equal(posts.length, 1, "the recovery still posts: this is the copy that was lost");
  assert.equal(
    standing(),
    true,
    "a prompt typed before the block does not clear the block that followed it",
  );

  // The other direction, which must keep working: words typed after the block clear it.
  assert.deepEqual(
    await router.interimPrompt("session-a", "go ahead", "turn-open", at - 1_000),
    { status: "sent" },
  );
  assert.equal(standing(), false, "a prompt typed after the block clears it");
});

test("a prompt line naming no readable instant stamps at read time", async () => {
  // The fallback, and the behaviour every path here had before the line's own timestamp was read
  // at all: the field is the harness's, so a shape change that drops or malforms it costs the
  // precision and not the stamp.
  const spy = engagementSpy(createRegistry({ host: "NEO", staleAfterMs: 60_000 }));
  announce(spy.registry, "session-a");
  const { writer } = fakeWriter();
  const router = routerFor({
    registry: spy.registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo: createEchoMemory(),
    log: () => {},
  });

  assert.deepEqual(await router.interimPrompt("session-a", PROMPT, "turn-open", null), {
    status: "sent",
  });
  assert.deepEqual(spy.engaged, ["session-a"]);
});

test("a wake notice reaches the thread before a prompt slot ever sees it", async () => {
  // The dedup sits after every check that decides what a prompt's text is, so the slot only ever
  // answers for prompts drawn in the operator's own register or under the peer attribution. A wake
  // compressed to a notice claims nothing on either path: the notice is not the report's text, so a
  // claim over it would answer for words the thread never showed.
  //
  // The peer branch is the one redrawing that does claim, because one text reaches both prompt paths
  // and takes that branch on both: the tests from "a typed prompt the classification misreads as a
  // delivery still nets one copy" onward own that pair.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  for (const send of [
    () => router.mirror(TOKEN, "prompt", WAKE, "session-a"),
    () => router.interimPrompt("session-a", WAKE, "turn-open", null),
  ]) {
    const before = posts.length;
    assert.deepEqual(await send(), { status: "sent" });
    assert.ok(posts.length > before, "the redrawn message still reaches the thread");
    assert.equal(
      promptClaimStanding(echo, "session-a", WAKE),
      false,
      "a wake notice claims no prompt digest",
    );
  }

  // The channel envelope, which posts nothing at all, claims nothing either.
  const envelope =
    '<channel source="channel-relay" chat_id="123">the migration finished?</channel>';
  assert.equal((await router.mirror(TOKEN, "prompt", envelope, "session-a")).status, "failed");
  assert.equal(promptClaimStanding(echo, "session-a", envelope), false);
});

test("two identical prompts down the recovered path both land: a path never consumes its own claim", async () => {
  // The claim carries which path made it, and a match is only ever the other path's. Without that
  // tag the second of two identical prompts matches the first's own claim and is dropped with a
  // `sent` status and nothing posted, which is the operator's words gone from the thread. The fail
  // direction here is a duplicate prompt and never a lost one.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  assert.deepEqual(await router.interimPrompt("session-a", "continue", "turn-open", null), {
    status: "sent",
  });
  assert.deepEqual(await router.interimPrompt("session-a", "continue", "turn-open", null), {
    status: "sent",
  });
  assert.deepEqual(posts.map((post) => post.text), [
    renderMirror("prompt", "continue")[0],
    renderMirror("prompt", "continue")[0],
  ]);
});

test("two identical mirrored prompts both land: a path never consumes its own claim", async () => {
  // The hook's half of the same property. `continue` twice in a row is an ordinary way to drive a
  // session, and the second one reaching the thread must not depend on a tailer existing to have
  // claimed the first.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", "continue", "session-a"), {
    status: "sent",
  });
  assert.deepEqual(await router.mirror(TOKEN, "prompt", "continue", "session-a"), {
    status: "sent",
  });
  assert.deepEqual(posts.map((post) => post.text), [
    renderMirror("prompt", "continue")[0],
    renderMirror("prompt", "continue")[0],
  ]);
});

test("a mirror-only host, where nothing ever writes the tailer's prompt slot, posts every prompt", async () => {
  // The supported knob combination this pins: `CHANNEL_MIRROR` on with `CHANNEL_INTERIM_MIRROR`
  // off builds the echo memory and no tailer at all. The mirror writes `promptMirror` and reads
  // `promptTailer`, which nothing on that host ever writes, so the dedup is inert there by
  // construction. A repeated prompt has no second path to have claimed it, and every copy is the
  // only copy.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const lines: string[] = [];
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: (message) => lines.push(message),
  });

  for (const typed of ["run it", "run it", "run it"]) {
    assert.deepEqual(await router.mirror(TOKEN, "prompt", typed, "session-a"), { status: "sent" });
  }
  assert.equal(posts.length, 3, posts.map((post) => post.text).join("\n---\n"));
  assert.deepEqual(lines, [], "nothing was suppressed, so nothing is reported as suppressed");
  assert.equal(
    echo.isPromptEcho("session-a", "run it", "mirror"),
    false,
    "the slot the mirror reads is the one no path on this host writes",
  );

  // The control, so the silence above is the absent path and not an echo memory that stopped
  // answering: the same question, with the slot the tailer would have written written by hand.
  echo.notePrompt("session-a", "run it", "tailer");
  assert.equal(echo.isPromptEcho("session-a", "run it", "mirror"), true);
});

test("a typed prompt the classification misreads as a delivery still nets one copy", async () => {
  // The false positive's third cost, which the ruling that accepted the other two did not name.
  // A turn-opening prompt the operator really typed reaches the thread by two paths, and what
  // holds it to one copy is the prompt-echo claim the two paths make against each other. A peer
  // delivery needs none of that, because the tailer is blind to the line an idle delivery lands
  // on, so the peer branches were written above the claim seam. A misread typed prompt is the one
  // text that takes the peer branch on both paths while still being read by both, so it took the
  // branch that skips the claim twice and posted twice. The operator earns this by typing a
  // message that opens with the harness's own wrapper, which is what debugging this system looks
  // like.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  // The operator types it; the hook carries it first, exactly as the healthy race runs.
  const typed = idleDelivery();
  assert.equal((await router.mirror(TOKEN, "prompt", typed, "session-a")).status, "sent");
  const afterMirror = posts.length;
  assert.ok(afterMirror > 0, "the mirror path posts the operator's words once");

  // Then the tailer reads the same typed line off the transcript, as it does for every
  // turn-opening prompt: `typedAtTheConsole` admits it, because it genuinely was typed.
  await router.interimPrompt("session-a", typed, "turn-open", null);
  assert.equal(
    posts.length,
    afterMirror,
    `the second path must defer to the first, not post again: ${posts.map((post) => post.text).join("\n---\n")}`,
  );
});

test("the misread prompt nets one copy in the other race order too, the tailer's read first", async () => {
  // The same pair from the other side, which is the case the mirror hook's own consult answers: a
  // hook the harness ran slow lands behind a poll, so the tailer's recovery is the copy that posted
  // and this one is the duplicate. Without the consult on the mirror's peer branch the fix would
  // hold in the healthy order alone and fail in exactly the loaded conditions the recovery exists
  // for.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  const typed = idleDelivery();
  assert.equal((await router.interimPrompt("session-a", typed, "turn-open", null)).status, "sent");
  const afterTailer = posts.length;
  assert.ok(afterTailer > 0, "the recovered copy posts the operator's words once");

  assert.equal((await router.mirror(TOKEN, "prompt", typed, "session-a")).status, "sent");
  assert.equal(
    posts.length,
    afterTailer,
    `the late hook must defer, not post again: ${posts.map((post) => post.text).join("\n---\n")}`,
  );
});

test("a peer-classified prompt the knob dropped leaves no claim standing, on either path", async () => {
  // The fail direction that matters more than the duplicate. `off` posts nothing at all, so a claim
  // made over it would stand for a copy no path ever put on the thread and silence the other path's:
  // under a setting chosen to hear less from peers, a prompt the operator really typed and this
  // classification misread would then appear nowhere instead of once.
  for (const send of ["mirror", "tailer"] as const) {
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const { writer, posts } = fakeWriter();
    const echo = createEchoMemory();
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      echo,
      peerMessages: "off",
      log: () => {},
    });

    const typed = idleDelivery();
    const outcome =
      send === "mirror"
        ? await router.mirror(TOKEN, "prompt", typed, "session-a")
        : await router.interimPrompt("session-a", typed, "turn-open", null);
    assert.equal(outcome.status, "failed", send);
    assert.equal(posts.length, 0, send);
    assert.equal(
      promptClaimStanding(echo, "session-a", typed),
      false,
      `${send}: a drop that posted nothing must claim nothing`,
    );
  }
});

test("a delivery carrying nothing visible draws the placeholder, so no seam posts an empty run", async () => {
  // Why the empty render is not reachable from the two prompt seams, pinned where a change would
  // make it reachable. The classifier refuses a body carrying nothing visible on the same
  // `withoutInvisible` reading the renderer strips with, so it hands over the placeholder instead
  // and the run is never empty. The claim still sits below the empty check in `deliverPeerMessage`,
  // because that agreement spans two modules: were it ever loosened, a claim above the check would
  // stand over a run of no messages and silence the other path's copy.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  // A zero-width space is visible to `String.trim`, which leaves it where it is, and to nothing
  // else. Written as an escape so the fixture is readable in a diff.
  const hollow = idleDelivery("\u200b");
  assert.equal((await router.mirror(TOKEN, "prompt", hollow, "session-a")).status, "sent");
  assert.equal(posts.length, 1, posts.map((post) => post.text).join("\n---\n"));
  assert.ok(posts[0].text.includes(PEER_BODY_UNREADABLE), posts[0].text);
  assert.equal(
    echo.isPromptEcho("session-a", hollow, "tailer"),
    true,
    "a run that did post claims its slot, so the other path's copy of the same text defers",
  );
});

test("a peer-classified turn-open post whose run landed nothing leaves no claim standing", async () => {
  // The release, which is the same hole from the other side: a claim standing over a run the
  // transport refused would silence the copy still able to reach the thread, and a misread typed
  // prompt would be gone from the thread with nothing anywhere saying so.
  for (const send of ["mirror", "tailer"] as const) {
    /** The path that did not make the claim, the only one a standing claim could ever silence. */
    const other = send === "mirror" ? "tailer" : "mirror";
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const { writer } = fakeWriter({ status: "failed", error: "HTTP 500", rate: NO_RATE_INFO });
    const echo = createEchoMemory();
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: writer,
      echo,
      log: () => {},
    });

    const typed = idleDelivery();
    const outcome =
      send === "mirror"
        ? await router.mirror(TOKEN, "prompt", typed, "session-a")
        : await router.interimPrompt("session-a", typed, "turn-open", null);
    assert.equal(outcome.status, "failed", send);
    assert.equal(
      echo.isPromptEcho("session-a", typed, other),
      false,
      `${send}: a run that never landed must not suppress the other path's copy`,
    );
  }
});

test("a peer-classified prompt the other path deferred to goes again once when its run landed nothing", async () => {
  // The claim's own cost, bounded on this branch exactly as it is bounded on the mirrored prompt:
  // the other path met the claim mid-run and dropped its copy, so a run that then lands nothing is
  // the last thing carrying the text. It goes again, once, and the loss gets its own line.
  for (const send of ["mirror", "tailer"] as const) {
    const other = send === "mirror" ? "tailer" : "mirror";
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    announce(registry, "session-a");
    const echo = createEchoMemory();
    const lines: string[] = [];
    const posts: string[] = [];
    const typed = idleDelivery();
    const messenger: ThreadMessenger = {
      postToThread: async (input) => {
        posts.push(input.text);
        // The other path arriving inside the run: it finds the claim and drops its own copy.
        if (posts.length === 1) echo.isPromptEcho("session-a", typed, other);
        return { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO };
      },
      editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
    };
    const router = routerFor({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: createThreadWriter({ messenger, now: () => 1_000 }),
      echo,
      log: (message) => lines.push(message),
    });

    const outcome =
      send === "mirror"
        ? await router.mirror(TOKEN, "prompt", typed, "session-a")
        : await router.interimPrompt("session-a", typed, "turn-open", null);
    assert.equal(outcome.status, "failed", send);
    assert.equal(posts.length, 2, `${send}: the run goes again exactly once: ${posts.join("\n")}`);
    assert.ok(
      lines.some((line) => line.includes("reached the thread by neither path")),
      `${send}: ${lines.join("\n")}`,
    );
    assert.ok(
      !lines.join("\n").includes(PEER_BODY),
      `${send}: peer content leaked into the routing log: ${lines.join("\n")}`,
    );
    assert.equal(
      echo.isPromptEcho("session-a", typed, other),
      false,
      `${send}: text on the thread by neither path is claimed by neither path`,
    );
  }
});

test("a genuine mid-turn peer delivery posts whatever the prompt slots hold", async () => {
  // The control the pair above must not break. A mid-turn delivery reaches the tailer as its own
  // peer item and the queued prompt seam as `queued`, and neither shape exists twice: no hook fires
  // for an injected message. So neither consults a slot, where a consult could only drop a peer's
  // message against a claim some earlier text of the same bytes left behind, and neither claims one,
  // where a claim could only swallow a later copy nothing is racing.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const router = routerFor({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    echo,
    log: () => {},
  });

  // A claim over the very text arriving, standing on both slots: the state that would suppress this
  // message if the queued shape consulted anything.
  const arriving = idleDelivery();
  echo.notePrompt("session-a", arriving, "mirror");
  echo.notePrompt("session-a", arriving, "tailer");

  assert.deepEqual(await router.interimPrompt("session-a", arriving, "queued", null), {
    status: "sent",
  });
  assert.deepEqual(await router.peer("session-a", RECEIVED), { status: "sent" });
  const drawn = renderPeerIn(PEER_NAME, PEER_BODY);
  assert.deepEqual(
    posts.map((post) => post.text),
    [...drawn, ...drawn],
    "a delivery with no second copy anywhere posts under every claim standing",
  );
  assert.equal(
    promptClaimStanding(echo, "session-a", arriving),
    true,
    "and consumes neither claim on its way past",
  );
});
