// The outbound path. Its one load-bearing property is that a reply is addressed by session and by
// nothing else, which is what lets Claude reply unprompted and still land in the right thread.
import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(posts, [
    { threadId: THREAD, text: "run the migration" },
    { threadId: THREAD, text: "the migration is done" },
  ]);
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
    { threadId: "new-thread", text: "current, named" },
    { threadId: "new-thread", text: "current, unnamed" },
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
    ["turn one", "permission prompt"],
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

test("a rejected post is reported to the caller rather than swallowed", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 403", rate: NO_RATE_INFO });
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer, mirrorWriter: writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "failed", error: "HTTP 403" });
});
