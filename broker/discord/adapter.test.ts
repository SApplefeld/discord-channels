import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordTransport } from "./adapter.ts";
import type { RawRequest, RawResult } from "./adapter.ts";

const CHANNEL = "999000111";

type Sent = { route: string; method: string; body: Record<string, unknown> };

/** Headers as Discord sends them: counts as strings, times in seconds. */
function headers(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name.toLowerCase()] ?? null;
}

function transportWith(reply: (sent: Sent) => RawResult) {
  const sent: Sent[] = [];
  const request: RawRequest = async (input) => {
    sent.push(input);
    return reply(input);
  };
  return { sent, transport: createDiscordTransport({ channelId: CHANNEL, request }) };
}

function respond(body: unknown, values: Record<string, string> = {}): RawResult {
  return { kind: "response", status: 200, header: headers(values), body };
}

test("posting the card and opening the thread are separate calls", async () => {
  // They fail independently, and the surface keeps the posted message when the second one fails,
  // so the two are never one call that has to be redone from the start.
  const { sent, transport } = transportWith((input) =>
    respond({ id: input.route.endsWith("/threads") ? "thread-77" : "message-42" }),
  );

  const posted = await transport.postCard({ card: "card" });
  assert.deepEqual(posted.status === "ok" ? posted.value : null, { messageId: "message-42" });

  const opened = await transport.openThread({
    messageId: "message-42",
    name: "⚙ neo-intake · working",
  });
  assert.deepEqual(opened.status === "ok" ? opened.value : null, { threadId: "thread-77" });

  assert.deepEqual(
    sent.map((call) => `${call.method} ${call.route}`),
    [
      `POST /channels/${CHANNEL}/messages`,
      `POST /channels/${CHANNEL}/messages/message-42/threads`,
    ],
  );
  assert.equal(sent[1].body.name, "⚙ neo-intake · working");
  assert.equal(
    sent[1].body.auto_archive_duration,
    10080,
    "a thread that takes the channel default archives out of the dashboard overnight",
  );
});

test("every message this bot writes suppresses all mentions and every embed", async () => {
  // A session announces its own name, so `@everyone` is a real input rather than a hypothetical
  // one. The renderer keeps it from restructuring the card; this is what keeps it from pinging.
  // Suppressed embeds keep a bare URL in a name from being fetched by Discord's crawler.
  const { sent, transport } = transportWith(() => respond({ id: "id-1" }));

  await transport.postCard({ card: "@everyone https://example.invalid/beacon" });
  await transport.editCard({ messageId: "message-42", card: "@here card" });

  const writes = sent.filter((call) => "content" in call.body);
  assert.equal(writes.length, 2, "the post and the edit are the only writes carrying text");
  for (const call of writes) {
    assert.deepEqual(call.body.allowed_mentions, { parse: [] }, call.route);
    assert.equal(call.body.flags, 4, call.route);
  }
});

test("a thread message resolves no mention unless one user is named, and then only that one", async () => {
  // The permission prompt is the one message this broker writes that is meant to reach a phone.
  // The empty parse list still stands, so no mention class is resolved from the content: the users
  // list is a whitelist of exactly one id, and the renderer has escaped Discord's mention syntax
  // out of every untrusted field, so the only mention in the message is the one the broker wrote.
  const { sent, transport } = transportWith(() => respond(null));

  await transport.postToThread({ threadId: "thread-77", text: "@everyone a reply" });
  await transport.postToThread({
    threadId: "thread-77",
    text: "<@700000000000000002> permission needed",
    mentionUserId: "700000000000000002",
  });

  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
  assert.deepEqual(sent[1].body.allowed_mentions, {
    parse: [],
    users: ["700000000000000002"],
  });
  for (const call of sent) assert.equal(call.body.flags, 4);
});

test("a thread post surfaces the id Discord assigned, the append target for a later edit", async () => {
  const { transport } = transportWith(() => respond({ id: "msg-501" }));

  const posted = await transport.postToThread({ threadId: "thread-77", text: "first line" });

  assert.deepEqual(posted.status === "ok" ? posted.value : null, { messageId: "msg-501" });
});

test("a thread post with no readable id in the body still reports the message as landed", async () => {
  // Unlike postCard, where the id is the target of the very next call, here the id only feeds the
  // append optimization: the message already landed, and reporting a landed write as failed is
  // the resend-and-duplicate path, not a safer one.
  const { transport } = transportWith(() => respond({ nothing: true }));

  const posted = await transport.postToThread({ threadId: "thread-77", text: "first line" });

  assert.equal(posted.status, "ok");
  assert.deepEqual(posted.status === "ok" ? posted.value : null, { messageId: null });
});

test("an edit in a thread patches the named message and suppresses mentions and embeds", async () => {
  const { sent, transport } = transportWith(() => respond(null));

  await transport.editInThread({ threadId: "thread-77", messageId: "msg-501", text: "updated" });

  assert.equal(sent[0].route, "/channels/thread-77/messages/msg-501");
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].body.content, "updated");
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
  assert.equal(sent[0].body.flags, 4);
});

test("the card is edited in place on the message the broker posted", async () => {
  const { sent, transport } = transportWith(() => respond(null));

  await transport.editCard({ messageId: "message-42", card: "fresh" });

  assert.equal(sent[0].route, `/channels/${CHANNEL}/messages/message-42`);
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].body.content, "fresh");
});

test("a rename patches the thread and carries nothing but the name", async () => {
  // allowed_mentions is a message field. A thread title resolves no mentions whatever it says, and
  // a field the route does not define risks a refused rename in exchange for nothing.
  const { sent, transport } = transportWith(() => respond(null));

  await transport.renameThread({ threadId: "thread-77", name: "⚠ neo-intake · exited" });

  assert.equal(sent[0].route, "/channels/thread-77");
  assert.equal(sent[0].method, "PATCH");
  assert.deepEqual(sent[0].body, { name: "⚠ neo-intake · exited" });
});

test("archiving patches the thread and is the only call that closes it", async () => {
  const { sent, transport } = transportWith(() => respond(null));

  await transport.archiveThread({ threadId: "thread-77" });

  assert.deepEqual(sent[0].body, { archived: true });
});

test("rate-limit headers are read in seconds and reported in milliseconds", async () => {
  const { transport } = transportWith(() =>
    respond(null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.75" }),
  );

  const outcome = await transport.renameThread({ threadId: "thread-77", name: "name" });

  assert.deepEqual(outcome.rate, { remaining: 0, resetAfterMs: 1750, retryAfterMs: null });
});

test("a 429 response is a refusal carrying its wait, not an error", async () => {
  const { transport } = transportWith(() => ({
    kind: "response",
    status: 429,
    header: headers({ "x-ratelimit-remaining": "0" }),
    body: { retry_after: 2.5, global: false },
  }));

  const outcome = await transport.renameThread({ threadId: "thread-77", name: "name" });

  assert.equal(outcome.status, "rate-limited");
  assert.equal(outcome.rate.retryAfterMs, 2500);
});

test("a client that refuses before sending reports the same refusal", async () => {
  // The REST client is configured to throw rather than wait out a bucket, and it reports its wait
  // in milliseconds already.
  const { transport } = transportWith(() => ({ kind: "rate-limited", retryAfterMs: 4_000 }));

  const outcome = await transport.renameThread({ threadId: "thread-77", name: "name" });

  assert.equal(outcome.status, "rate-limited");
  assert.equal(outcome.rate.retryAfterMs, 4_000);
});

test("a refused or broken call is a failure with no bucket claim", async () => {
  const forbidden = transportWith(() => ({
    kind: "response",
    status: 403,
    header: headers({}),
    body: { message: "Missing Access" },
  }));
  const broken = transportWith(() => ({ kind: "failed", error: "socket hang up" }));

  const denied = await forbidden.transport.renameThread({ threadId: "t", name: "n" });
  const dead = await broken.transport.renameThread({ threadId: "t", name: "n" });

  assert.equal(denied.status, "failed");
  assert.equal(dead.status, "failed");
  assert.equal(dead.rate.remaining, null);
  assert.equal(dead.rate.retryAfterMs, null, "a transport error says nothing about the budget");
});

test("a create that never yields an id fails rather than binding a thread that is not there", async () => {
  const { transport } = transportWith(() => respond({ nothing: true }));

  assert.equal((await transport.postCard({ card: "card" })).status, "failed");
  assert.equal((await transport.openThread({ messageId: "m", name: "n" })).status, "failed");
});

test("a refusal Discord will repeat is marked as one, and a 404 names a dead object", async () => {
  // The difference decides whether the caller retries on a timer forever: a 5xx is the moment, a
  // 4xx is the request, and a 404 is an identifier that has stopped naming anything.
  async function outcomeFor(status: number) {
    const { transport } = transportWith(() => ({
      kind: "response",
      status,
      header: headers({ "x-ratelimit-remaining": "5" }),
      body: { message: "no" },
    }));
    const outcome = await transport.renameThread({ threadId: "thread-77", name: "name" });
    assert.equal(outcome.status, "failed");
    return outcome.status === "failed" ? outcome : null;
  }

  const gone = await outcomeFor(404);
  assert.equal(gone?.permanent, true);
  assert.equal(gone?.missing, true);

  const forbidden = await outcomeFor(403);
  assert.equal(forbidden?.permanent, true);
  assert.equal(forbidden?.missing, false);
  assert.notEqual(forbidden?.fatal, true);

  const broken = await outcomeFor(502);
  assert.notEqual(broken?.permanent, true, "a server error is worth trying again");
  assert.notEqual(broken?.missing, true);
});

test("a rejected token is a fatal failure, not one to retry", async () => {
  // The REST client discards a token Discord refused, so every later call would complain about a
  // missing token instead of the rejected one. The distinction has to be made at the first 401.
  const { transport } = transportWith(() => ({
    kind: "response",
    status: 401,
    header: headers({}),
    body: { message: "401: Unauthorized" },
  }));

  const outcome = await transport.postCard({ card: "card" });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" ? outcome.fatal : undefined, true);
});
