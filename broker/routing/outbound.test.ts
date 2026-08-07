// The outbound path. Its one load-bearing property is that a reply is addressed by session and by
// nothing else, which is what lets Claude reply unprompted and still land in the right thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MESSAGE_LENGTH, renderMirror } from "../discord/render.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { createOutboundRouter } from "./outbound.ts";
import { createThreadWriter } from "./writer.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";

function announce(registry: Registry, sessionId: string, processToken = TOKEN): void {
  registry.apply({
    event: "SessionStart",
    processToken,
    sessionName: "neo-warden",
    sessionId,
    source: "startup",
    toolName: null,
  });
}

function fakeWriter(outcome?: CallOutcome<null>) {
  const posts: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return outcome ?? { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  return { writer: createThreadWriter({ messenger, now: () => 1_000 }), posts };
}

test("a reply is posted to the thread bound to the session holding the process token", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    writer,
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.reply(TOKEN, "the migration is done"), { status: "sent" });
  assert.deepEqual(posts, [{ threadId: THREAD, text: "the migration is done" }]);
});

test("a reply after a clear goes to the new session's thread, not the old one", async () => {
  // The relay is a child of the process and survives a /clear untouched, so the process token is
  // unchanged while the session, and therefore the thread, is not. Routing by session is what makes
  // this land in the right place.
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  announce(registry, "session-b");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? "old-thread" : "new-thread"),
    writer,
    mirrorWriter: writer,
  });

  await router.reply(TOKEN, "still here");
  assert.deepEqual(posts, [{ threadId: "new-thread", text: "still here" }]);
});

test("a reply from a process with no announced session is reported, not guessed at", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "no-session" });
  assert.deepEqual(posts, [], "no thread is written to on a guess");
});

test("a reply from a session with no thread yet is reported rather than queued", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => null, writer, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  await router.reply(TOKEN, `done${zeroWidth}: **two** files${rightToLeftOverride}`);
  assert.deepEqual(posts, [{ threadId: THREAD, text: "done: **two** files" }]);
});

test("a mirrored prompt and reply post to the thread bound to the token's session", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : null),
    writer,
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.mirror(TOKEN, "prompt", "run the migration", null), { status: "sent" });
  assert.deepEqual(await router.mirror(TOKEN, "reply", "the migration is done", null), { status: "sent" });
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
  const orphan = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });
  assert.deepEqual(await orphan.mirror(TOKEN, "prompt", "hello", null), { status: "no-session" });

  announce(registry, "session-a");
  const unbound = createOutboundRouter({ registry, threadFor: () => null, writer, mirrorWriter: writer });
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
  announce(registry, "session-b");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({
    registry,
    threadFor: () => "new-thread",
    writer,
    mirrorWriter: writer,
  });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "the old conversation's reply", "session-a"), {
    status: "no-session",
  });
  assert.deepEqual(posts, [], "the replaced session's text must not reach the new thread");

  // The same payload naming the current session, and one naming none, both deliver.
  await router.mirror(TOKEN, "reply", "current, named", "session-b");
  await router.mirror(TOKEN, "reply", "current, unnamed", null);
  assert.deepEqual(posts, [
    { threadId: "new-thread", text: renderMirror("reply", "current, named")[0] },
    { threadId: "new-thread", text: renderMirror("reply", "current, unnamed")[0] },
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
        value: null,
        rate: { remaining: 0, resetAfterMs: 60_000, retryAfterMs: null },
      };
    },
  };
  const now = (): number => 1_000;
  const writer = createThreadWriter({ messenger, now });
  const mirrorWriter = createThreadWriter({ messenger, now });
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "turn one", null), { status: "sent" });
  assert.equal(
    (await router.mirror(TOKEN, "reply", "turn two", null)).status,
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
    writer,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const secret = "SECRET-the-reply-that-failed";
  assert.deepEqual(await router.mirror(TOKEN, "reply", secret, null), {
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  const reply = longReply(30);
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, null), { status: "sent" });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  const room = MAX_MESSAGE_LENGTH - (renderMirror("reply", "x")[0].length - 1);
  const reply = `${"x".repeat(room)}\n\n${"y".repeat(room)}`;
  await router.mirror(TOKEN, "reply", reply, null);

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
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const writer = createThreadWriter({ messenger, now: () => 1_000 });
  const lines: string[] = [];
  const router = createOutboundRouter({
    registry,
    threadFor: () => THREAD,
    writer,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  const reply = `SECRET-marker\n\n${longReply(30)}`;
  assert.deepEqual(await router.mirror(TOKEN, "reply", reply, null), {
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
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
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
    writer: createThreadWriter({ messenger, now }),
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  const accepted = [
    router.mirror(TOKEN, "reply", "the turn's reply", null),
    router.reply(TOKEN, "the reply tool"),
    router.mirror(TOKEN, "prompt", "the next prompt", null),
  ];
  await Promise.all(accepted);

  assert.deepEqual(landed, [
    renderMirror("reply", "the turn's reply")[0],
    "the reply tool",
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
    writer: createThreadWriter({ messenger, now }),
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  const reply = longReply(30);
  const messages = renderMirror("reply", reply);
  assert.ok(messages.length >= 5, `${messages.length} message(s)`);
  await Promise.all([router.mirror(TOKEN, "reply", reply, null), router.reply(TOKEN, "the reply tool")]);

  assert.deepEqual(landed, [...messages, "the reply tool"]);
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
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const now = (): number => 1_000;
  const router = createOutboundRouter({
    registry,
    threadFor: (sessionId) => (sessionId === "session-a" ? THREAD : "other-thread"),
    writer: createThreadWriter({ messenger, now }),
    mirrorWriter: createThreadWriter({ messenger, now }),
  });

  await Promise.all([
    router.mirror(TOKEN, "reply", "the slow thread", null),
    router.mirror(other, "reply", "the other thread", null),
  ]);

  assert.deepEqual(landed, ["other-thread", THREAD]);
});

test("a mirror post with nothing visible in it is reported rather than posted", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  assert.deepEqual(await router.mirror(TOKEN, "reply", "​  \n ", null), {
    status: "failed",
    error: "the message was empty",
  });
  assert.deepEqual(posts, []);
});

test("a rejected post is reported to the caller rather than swallowed", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 403", rate: NO_RATE_INFO });
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  await router.reply(TOKEN, "<@700000000000000002> **Permission needed** <t:1700000000:R>");

  const posted = posts[0].text;
  assert.equal(posted, "\\<@700000000000000002\\> **Permission needed** \\<t:1700000000:R\\>");
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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  const reply = "here:\n\n```ts\nconst f = (a: Array<string>) => a.length < 10;\n```";
  await router.reply(TOKEN, reply);

  assert.equal(posts[0].text, reply, "nothing inside a fence is escaped");
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
    writer,
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
    writer,
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
    writer,
    mirrorWriter: writer,
    log: (message) => lines.push(message),
  });

  await router.mirror(TOKEN, "prompt", "\u200b  \n ", null);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes("session-a"), lines[0]);
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
    writer,
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
