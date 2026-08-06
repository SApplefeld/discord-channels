// The one place a message is posted into a thread. Both callers reach Discord only through here,
// because both are provoked from outside the machine and Section 6's sender gate does not exist
// yet: without a budget in front of them, anyone in the channel earns a bot message per message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";
import { createThreadWriter } from "./writer.ts";

const THREAD = "900000000000000001";

function fakeMessenger(outcomes: Array<CallOutcome<null>> = []) {
  const posts: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return outcomes.shift() ?? { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  return { messenger, posts };
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
