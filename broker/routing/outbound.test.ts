// The outbound path. Its one load-bearing property is that a reply is addressed by session and by
// nothing else, which is what lets Claude reply unprompted and still land in the right thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MESSAGE_LENGTH, renderAnswer, renderMirror } from "../discord/render.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { createEchoMemory } from "../tail.ts";
import { createOutboundRouter } from "./outbound.ts";
import { createThreadWriter } from "./writer.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";

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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "no-session" });
  assert.deepEqual(posts, [], "no thread is written to on a guess");
});

test("a reply from a session with no thread yet is reported rather than queued", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => null, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

  await router.reply(TOKEN, `done${zeroWidth}: **two** files${rightToLeftOverride}`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadId, THREAD);
  assert.equal(said(posts[0].text), "done: **two** files");
});

test("a mirrored prompt and reply post to the thread bound to the token's session", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({
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
  const orphan = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });
  assert.deepEqual(await orphan.mirror(TOKEN, "prompt", "hello", null), { status: "no-session" });

  announce(registry, "session-a");
  const unbound = createOutboundRouter({ registry, threadFor: () => null, mirrorWriter: writer });
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "turn one", "session-a"), { status: "sent" });
  assert.equal(
    (await router.mirror(TOKEN, "reply", "turn two", "session-a")).status,
    "failed",
    "the mirror bucket is now blocked",
  );

  assert.equal(
    await writer.alert(THREAD, "permission prompt", null),
    true,
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({
    registry,
    threadFor: () => THREAD,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const reply = `SECRET-marker\n\n${longReply(30)}`;
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, "session-a"), {
    status: "failed",
    error: "HTTP 500",
  });

  const total = renderMirror("reply", reply).length;
  assert.equal(calls, 3, "the run stops at the refusal rather than posting the rest");
  assert.equal(posts.length, 2);
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer });

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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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
  const router = createOutboundRouter({
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

test("a mirrored reply matching the last interim chunk is skipped, and only that one", async () => {
  // The Stop mirror's half of the dedup: the tailer posted the turn's final text first, so the
  // reply arriving milliseconds later says nothing the thread does not already show.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const echo = createEchoMemory();
  const lines: string[] = [];
  const router = createOutboundRouter({
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

  // A different reply still mirrors, and a prompt is never consulted against the memory.
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  echo.noteInterim("session-a", "the same text  ");
  await router.mirror(TOKEN, "reply", `​the same text`, "session-a");
  assert.deepEqual(posts, [], "a zero-width character must not manufacture a second post");
});

test("a mirrored reply that failed to land is not remembered as mirrored", async () => {
  // The digest is recorded only after the run posted whole. Recorded before delivery, a reply the
  // transport refused would still poison the memory, the tailer's next pass would skip the same
  // text off the transcript, and the reply would appear nowhere: the silence this whole design
  // trades away from. The tailer's own half already records only on sent; this is the symmetric
  // guarantee on the mirror's half.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 500", rate: NO_RATE_INFO });
  const echo = createEchoMemory();
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, mirrorWriter: writer, echo });

  const reply = "the reply the transport refused";
  assert.equal((await router.mirror(TOKEN, "reply", reply, "session-a")).status, "failed");
  assert.equal(
    echo.isEcho("session-a", reply),
    false,
    "a reply that never landed must not suppress the tailer's copy of the same text",
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
  const router = createOutboundRouter({
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
