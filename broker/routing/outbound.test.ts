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
  });

  await router.reply(TOKEN, "still here");
  assert.deepEqual(posts, [{ threadId: "new-thread", text: "still here" }]);
});

test("a reply from a process with no announced session is reported, not guessed at", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "no-session" });
  assert.deepEqual(posts, [], "no thread is written to on a guess");
});

test("a reply from a session with no thread yet is reported rather than queued", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer, posts } = fakeWriter();
  const router = createOutboundRouter({ registry, threadFor: () => null, writer });

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
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer });

  await router.reply(TOKEN, `done${zeroWidth}: **two** files${rightToLeftOverride}`);
  assert.deepEqual(posts, [{ threadId: THREAD, text: "done: **two** files" }]);
});

test("a rejected post is reported to the caller rather than swallowed", async () => {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const { writer } = fakeWriter({ status: "failed", error: "HTTP 403", rate: NO_RATE_INFO });
  const router = createOutboundRouter({ registry, threadFor: () => THREAD, writer });

  assert.deepEqual(await router.reply(TOKEN, "hello"), { status: "failed", error: "HTTP 403" });
});
