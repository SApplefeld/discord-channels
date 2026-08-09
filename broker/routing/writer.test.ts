// The one place a message is posted into a thread. Every caller reaches Discord only through here,
// because all three are provoked from outside the machine: the sender gate narrows that to one
// account, and the budget is what keeps that account's accident or a runaway session from filling
// the channel this fleet is watched from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_USABLE_WAIT_MS } from "../discord/adapter.ts";
import { createBudget } from "../discord/budget.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createThreadWriter } from "./writer.ts";

const THREAD = "900000000000000001";

function fakeMessenger(outcomes: Array<CallOutcome<{ messageId: string }>> = []) {
  const posts: Array<{ threadId: string; text: string; mentionUserId?: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return outcomes.shift() ?? { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  return { messenger, posts };
}

function fakeEditMessenger(outcomes: Array<CallOutcome<null>> = []) {
  const edits: Array<{
    threadId: string;
    messageId: string;
    text: string;
    components?: readonly unknown[];
  }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async () => ({ status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO }),
    editInThread: async (input) => {
      edits.push(input);
      return outcomes.shift() ?? { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  return { messenger, edits };
}

test("a reply is neutralized before it is posted", () => {
  // A reply is Claude's own output, steered by whatever arrived from Discord, so it is untrusted
  // like any other string reaching a Discord surface. Markdown survives, because a reply is prose
  // the operator reads; the invisible class does not.
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const { messenger, posts } = fakeMessenger();
  const writer = createThreadWriter({ messenger, now: () => 0 });

  return writer.reply(THREAD, `done${zeroWidth}: **two** files${rightToLeftOverride}`).then(() => {
    assert.deepEqual(posts, [{ threadId: THREAD, text: "done: **two** files" }]);
  });
});

test("a post refused for rate limiting blocks the next one rather than queueing it", async () => {
  const { messenger, posts } = fakeMessenger([
    {
      status: "rate-limited",
      rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 },
    },
  ]);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  assert.equal((await writer.reply(THREAD, "first")).status, "rate-limited");
  assert.equal(posts.length, 1);

  const blocked = await writer.reply(THREAD, "second");
  assert.equal(blocked.status, "rate-limited");
  assert.equal(posts.length, 1, "a call that cannot be afforded is dropped, never queued");

  now += 5_000;
  assert.equal((await writer.reply(THREAD, "third")).status, "ok");
  assert.equal(posts.length, 2, "the bucket refills and the next reply goes");
});

test("a failed call is not evidence about the bucket, in either direction", async () => {
  // The rule the surfaces already follow. A call that failed says nothing about the bucket: its
  // headers may report an exhausted one it never reached, and blocking on that would silence the
  // thread for the reset window over an error that had nothing to do with rate limiting.
  const { messenger, posts } = fakeMessenger([
    { status: "failed", error: "HTTP 500", rate: { remaining: 0, resetAfterMs: 600_000, retryAfterMs: null } },
  ]);
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  assert.equal((await writer.reply(THREAD, "first")).status, "failed");
  assert.equal(
    (await writer.reply(THREAD, "second")).status,
    "ok",
    "a failed call must not have set a block",
  );
  assert.equal(posts.length, 2);
});

test("a burst into one thread earns one notice, not one per message", async () => {
  const { messenger, posts } = fakeMessenger();
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  assert.equal(await writer.notice(THREAD, "this session has ended"), true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    now += 100;
    assert.equal(await writer.notice(THREAD, "this session has ended"), false);
  }
  assert.equal(posts.length, 1);

  now += 60_000;
  assert.equal(await writer.notice(THREAD, "this session has ended"), true);
  assert.equal(posts.length, 2, "the floor lifts, so a later message is still answered");
});

test("a notice that did not land does not silence the thread", async () => {
  const { messenger, posts } = fakeMessenger([
    { status: "failed", error: "HTTP 500", rate: NO_RATE_INFO },
  ]);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  assert.equal(await writer.notice(THREAD, "ended"), false);
  now += 100;
  assert.equal(await writer.notice(THREAD, "ended"), true, "the floor tracks notices that landed");
  assert.equal(posts.length, 2);
});

test("the notice floor is per thread", async () => {
  const { messenger, posts } = fakeMessenger();
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  assert.equal(await writer.notice("thread-a", "ended"), true);
  assert.equal(await writer.notice("thread-b", "ended"), true);
  assert.equal(posts.length, 2, "one busy thread must not silence another session's");
});

test("an alert carries the one user it may mention and shares the bucket", async () => {
  // The write that reaches a phone is the loudest failure available here, so it is inside the
  // budget rather than exempt from it. It carries no per-thread floor: unlike a notice, it is the
  // only way a waiting session can be answered, and one silently dropped is a parked session.
  const { messenger, posts } = fakeMessenger([
    {
      status: "ok",
      value: { messageId: "msg-1" },
      rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: null },
    },
  ]);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  assert.equal(
    (await writer.alert(THREAD, "<@700000000000000002> permission needed", "700000000000000002")).status,
    "ok",
  );
  assert.deepEqual(posts, [
    {
      threadId: THREAD,
      text: "<@700000000000000002> permission needed",
      mentionUserId: "700000000000000002",
    },
  ]);

  assert.equal(
    (await writer.alert(THREAD, "second", "700000000000000002")).status,
    "rate-limited",
    "the bucket the replies and notices spend is the bucket this spends",
  );
  assert.equal(posts.length, 1);

  now += 5_000;
  assert.equal((await writer.alert(THREAD, "third", "700000000000000002")).status, "ok");
  assert.equal(posts.length, 2, "back to back alerts are allowed once the bucket refills");
});

test("a reply surfaces the id Discord assigned, the target of a later edit", async () => {
  const { messenger } = fakeMessenger([
    { status: "ok", value: { messageId: "msg-42" }, rate: NO_RATE_INFO },
  ]);
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  const posted = await writer.reply(THREAD, "first line");

  assert.deepEqual(posted.status === "ok" ? posted.value : null, { messageId: "msg-42" });
});

test("an edit goes out when there is room in the edit bucket", async () => {
  const { messenger, edits } = fakeEditMessenger();
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  const edited = await writer.edit(THREAD, "msg-42", "updated line");

  assert.equal(edited.status, "ok");
  assert.deepEqual(edits, [{ threadId: THREAD, messageId: "msg-42", text: "updated line" }]);
});

test("an edit carries components only when the caller named them, and an empty list strips them", async () => {
  // The asymmetry is the whole point: a PATCH omitting the field leaves the message's rows alone,
  // so an edit that only rewrites text must not send one, and `[]` is the only way a resolved
  // question's message loses the buttons that answered it.
  const { messenger, edits } = fakeEditMessenger();
  const writer = createThreadWriter({ messenger, now: () => 1_000 });
  const row = { type: 1 as const, components: [] };

  await writer.edit(THREAD, "msg-42", "text only");
  await writer.edit(THREAD, "msg-42", "with rows", [row]);
  await writer.edit(THREAD, "msg-42", "rows stripped", []);

  assert.deepEqual(edits, [
    { threadId: THREAD, messageId: "msg-42", text: "text only" },
    { threadId: THREAD, messageId: "msg-42", text: "with rows", components: [row] },
    { threadId: THREAD, messageId: "msg-42", text: "rows stripped", components: [] },
  ]);
});

test("an edit bucket emptied by an edit 429 refuses the next edit without touching the messenger", async () => {
  // The hazard this guards is the same one the post budget guards: a budget bypass on the new verb
  // is a write that never stops, this time landing on an edit instead of a post.
  const outcomes: Array<CallOutcome<null>> = [
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 } },
  ];
  const { messenger, edits } = fakeEditMessenger(outcomes);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  const first = await writer.edit(THREAD, "msg-42", "first");
  assert.equal(first.status, "rate-limited");
  assert.equal(edits.length, 1, "the first attempt found room and reached the messenger");

  const blocked = await writer.edit(THREAD, "msg-42", "should not go out");
  assert.equal(blocked.status, "rate-limited");
  assert.equal(edits.length, 1, "the bucket the first 429 emptied refuses the second without a call");

  now += 5_000;
  const recovered = await writer.edit(THREAD, "msg-42", "goes out once the bucket refills");
  assert.equal(recovered.status, "ok");
  assert.equal(edits.length, 2);
});

test("a rate-limited post does not block the next edit", async () => {
  // The two verbs are two Discord rate buckets. Folding a post's headers into the edit bucket
  // would silence an edit that was never refused.
  const { messenger: postMessenger, posts } = fakeMessenger([
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 } },
  ]);
  const edits: Array<{ threadId: string; messageId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: postMessenger.postToThread,
    editInThread: async (input) => {
      edits.push(input);
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  assert.equal((await writer.reply(THREAD, "first")).status, "rate-limited");
  assert.equal(posts.length, 1);

  const edited = await writer.edit(THREAD, "msg-42", "unrelated edit");
  assert.equal(edited.status, "ok", "the post bucket's block must not reach the edit bucket");
  assert.equal(edits.length, 1);
});

test("a rate-limited edit does not block the next post", async () => {
  const { messenger: editMessenger, edits } = fakeEditMessenger([
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 } },
  ]);
  const posts: Array<{ threadId: string; text: string; mentionUserId?: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: editMessenger.editInThread,
  };
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  assert.equal((await writer.edit(THREAD, "msg-42", "first")).status, "rate-limited");
  assert.equal(edits.length, 1);

  const replied = await writer.reply(THREAD, "unrelated reply");
  assert.equal(replied.status, "ok", "the edit bucket's block must not reach the post bucket");
  assert.equal(posts.length, 1);
});

test("a failed edit is not evidence about the bucket either", async () => {
  const { messenger } = fakeEditMessenger([
    { status: "failed", error: "HTTP 500", rate: { remaining: 0, resetAfterMs: 600_000, retryAfterMs: null } },
  ]);
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  assert.equal((await writer.edit(THREAD, "msg-42", "first")).status, "failed");
  assert.equal(
    (await writer.edit(THREAD, "msg-42", "second")).status,
    "ok",
    "a failed edit must not have set a block",
  );
});

test("an empty edit is refused before it reaches the wire", async () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const { messenger, edits } = fakeEditMessenger();
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  const refused = await writer.edit(THREAD, "msg-42", zeroWidth);

  assert.equal(refused.status, "failed");
  assert.equal(edits.length, 0);
});

test("a reply and a notice name no user to mention at all", async () => {
  const { messenger, posts } = fakeMessenger();
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  await writer.reply(THREAD, "done");
  await writer.notice(THREAD, "this session has ended");
  for (const post of posts) {
    assert.equal(
      (post as { mentionUserId?: string }).mentionUserId,
      undefined,
      "only the permission prompt is allowed to ping",
    );
  }
});

test("a refusal the bucket makes itself reports how much of the block is left", async () => {
  // The wait a caller sits out before trying the same message again, in the one field a 429 from
  // Discord reports it in: a pre-flight refusal that named no wait would leave a paced run
  // guessing at a number this writer already knows exactly.
  const { messenger, posts } = fakeMessenger([
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 } },
  ]);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  await writer.reply(THREAD, "the 429 that earned the block");
  now += 2_500;

  const refused = await writer.reply(THREAD, "refused before it reaches the messenger");
  assert.equal(refused.status, "rate-limited");
  assert.equal(refused.rate.retryAfterMs, 1_500, "the block runs to 5000 and the clock reads 3500");
  assert.equal(posts.length, 1, "the refusal is made here, without a call");
});

test("a refusal the bucket makes itself reports a wait a caller can act on, however wedged the bucket", async () => {
  // This refusal is a producer of the wait field in its own right: it subtracts a clock from a
  // block the bucket already holds, so a bucket blocked absurdly far out hands the caller the same
  // unusable number without any response being read. The caller folds what it is told into a
  // budget of its own, which is where an unbounded wait stops being one call's problem.
  const { messenger } = fakeMessenger([
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: null, retryAfterMs: 1e30 } },
  ]);
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  await writer.reply(THREAD, "the refusal that wedged the bucket");
  now += 1_000;

  const refused = await writer.reply(THREAD, "refused before it reaches the messenger");
  assert.equal(refused.status, "rate-limited");
  const budget = createBudget();
  budget.observe(refused.rate, now);
  assert.ok(
    budget.affordable(now + MAX_USABLE_WAIT_MS),
    `the reported wait wedges a bucket that reads it: it blocks until ${String(budget.blockedUntil())}`,
  );
});

test("a bucket with room in it posts and reports the wait the response itself carried", async () => {
  const { messenger, posts } = fakeMessenger([
    { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 9_000, retryAfterMs: 7_000 } },
  ]);
  const writer = createThreadWriter({ messenger, now: () => 1_000 });

  const refused = await writer.reply(THREAD, "reaches Discord and is refused there");
  assert.equal(refused.status, "rate-limited");
  assert.equal(refused.rate.retryAfterMs, 7_000, "Discord's own retry_after is passed through");
  assert.deepEqual(posts, [{ threadId: THREAD, text: "reaches Discord and is refused there" }]);
});

test("each verb's refusal reports its own bucket's block, never the other verb's", async () => {
  // A post create and a message PATCH are separate Discord rate buckets, so the wait one route
  // earned is no answer for the other: reported across, a caller would sit out an edit's long
  // block before a post that was never refused, or retry a post inside a block it must not.
  const posts: Array<{ threadId: string; text: string }> = [];
  const edits: Array<{ threadId: string; messageId: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push({ threadId: input.threadId, text: input.text });
      return { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 5_000, retryAfterMs: 4_000 } };
    },
    editInThread: async (input) => {
      edits.push({ threadId: input.threadId, messageId: input.messageId });
      return { status: "rate-limited", rate: { remaining: 0, resetAfterMs: 40_000, retryAfterMs: 30_000 } };
    },
  };
  let now = 1_000;
  const writer = createThreadWriter({ messenger, now: () => now });

  await writer.reply(THREAD, "earns the post block");
  await writer.edit(THREAD, "msg-42", "earns the edit block");
  now += 1_000;

  const refusedPost = await writer.reply(THREAD, "refused pre-flight");
  const refusedEdit = await writer.edit(THREAD, "msg-42", "refused pre-flight");
  assert.equal(refusedPost.rate.retryAfterMs, 3_000, "the post block runs to 5000");
  assert.equal(refusedEdit.rate.retryAfterMs, 29_000, "the edit block runs to 31000");
  assert.equal(posts.length, 1);
  assert.equal(edits.length, 1);
});
