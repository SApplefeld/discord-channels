import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RUN_WAIT_MS } from "../routing/outbound.ts";
import { MAX_USABLE_WAIT_MS, createDiscordTransport, createInteractionResponder } from "./adapter.ts";
import type { RawRequest, RawResult } from "./adapter.ts";
import { createBudget } from "./budget.ts";

const CHANNEL = "999000111";

type Sent = { route: string; method: string; body: Record<string, unknown> };

/** Headers as Discord sends them: counts as strings, times in seconds. */
function headers(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name.toLowerCase()] ?? null;
}

function transportWith(reply: (sent: Sent) => RawResult) {
  const sent: Sent[] = [];
  const request: RawRequest = async (input) => {
    // The verbs that carry no body record an empty one here. Whether a body reached the wire at all
    // is the pin routes' own concern and is pinned where they are, against the raw input.
    const call: Sent = { ...input, body: input.body ?? {} };
    sent.push(call);
    return reply(call);
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
  // The permission prompt and the question alert are the messages this broker writes that are
  // meant to reach a phone.
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

test("the pin routes are the message-scoped ones, on the channel, carrying no body", async () => {
  // The legacy `/channels/{id}/pins/{id}` pair answers 403 Missing Permissions to a bot holding
  // Manage Messages without Pin Messages, which names a permission the operator has granted; these
  // accept either bit. The raw input is read here rather than the normalized recording above,
  // because whether a body reached the wire at all is what this pins.
  const calls: { route: string; method: string; body: unknown }[] = [];
  const request: RawRequest = async (input) => {
    calls.push({ route: input.route, method: input.method, body: input.body });
    return respond(input.method === "GET" ? { items: [], has_more: false } : null);
  };
  const transport = createDiscordTransport({ channelId: CHANNEL, request });

  await transport.listPins();
  await transport.pin({ messageId: "message-42" });
  await transport.unpin({ messageId: "message-42" });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.route}`),
    [
      `GET /channels/${CHANNEL}/messages/pins`,
      `PUT /channels/${CHANNEL}/messages/pins/message-42`,
      `DELETE /channels/${CHANNEL}/messages/pins/message-42`,
    ],
  );
  for (const call of calls) assert.equal(call.body, undefined, call.route);
});

test("the pin list reads the page's message ids, and an unreadable page is a refusal", async () => {
  // The route answers `{ items, has_more }`, each item carrying the pinned message. An item with no
  // readable message id is dropped rather than guessed at, and a body that is not a page at all is
  // reported permanent: read as an empty channel it would have the caller pin messages that are
  // already pinned, and every pin writes a system message into the operator's channel.
  const { transport } = transportWith(() =>
    respond({
      items: [
        { pinned_at: "2026-08-09T00:00:00Z", message: { id: "message-42" } },
        { pinned_at: "2026-08-09T00:00:01Z", message: { id: "message-7" } },
        { pinned_at: "2026-08-09T00:00:02Z" },
      ],
      has_more: true,
    }),
  );

  const listed = await transport.listPins();
  assert.deepEqual(listed.status === "ok" ? listed.value : null, {
    messageIds: ["message-42", "message-7"],
    hasMore: true,
  });

  const { transport: broken } = transportWith(() => respond({ pins: [] }));
  const refused = await broken.listPins();
  assert.equal(refused.status, "failed");
  assert.equal(refused.status === "failed" ? refused.permanent : null, true);
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

test("a wait that is not a finite number never reaches the budget that spends it", async () => {
  // The value crosses into this process from the client, and a non-finite one is not a long wait,
  // it is a number no arithmetic above here survives: folded into a bucket it becomes a block no
  // clock reaches, and the bucket then refuses every write it is asked for until the process
  // restarts. On the post bucket that is every reply, notice, and permission alert for the life of
  // the broker, so the clamp is pinned here on the pair rather than on the field alone.
  for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const { transport } = transportWith(() => ({ kind: "rate-limited", retryAfterMs: raw }));
    const outcome = await transport.postToThread({ threadId: "thread-77", text: "hello" });

    assert.equal(outcome.status, "rate-limited", String(raw));
    assert.equal(outcome.rate.retryAfterMs, 0, `a wait of ${String(raw)} names no usable wait`);

    const budget = createBudget();
    budget.observe(outcome.rate, 1_000);
    assert.ok(
      budget.affordable(1_000),
      `a ${String(raw)} wait bricked the bucket: blockedUntil is ${String(budget.blockedUntil())}`,
    );
  }
});

test("a wait too large to act on never wedges the budget that spends it", async () => {
  // Magnitude is the same hazard as a non-finite value and needs no overflow to reach it: a wait
  // of 1e30 folded into a bucket is a block roughly 1e33 milliseconds out, which no clock reaches,
  // and the bucket then refuses every write it is asked for until the process restarts. On the
  // create-message bucket that is every reply, notice, and permission alert for the life of the
  // broker. Every arm a refusal can arrive on is driven, because a wait bounded on one of them and
  // raw on another is a bucket wedged by whichever refusal Discord happens to send: the client's
  // own pre-send refusal, a 429 carrying the wait in its header, and a 429 carrying it in its body.
  // The two header-and-body cases are also where a value finite on the wire turns infinite, since
  // the seconds a response reports are multiplied by a thousand on the way in.
  const refusals: RawResult[] = [
    { kind: "rate-limited", retryAfterMs: 1e30 },
    { kind: "response", status: 429, header: headers({ "retry-after": "1e306" }), body: null },
    { kind: "response", status: 429, header: headers({}), body: { retry_after: 1e306 } },
    { kind: "rate-limited", retryAfterMs: Number.NaN },
    { kind: "rate-limited", retryAfterMs: Number.POSITIVE_INFINITY },
    { kind: "rate-limited", retryAfterMs: Number.NEGATIVE_INFINITY },
  ];

  for (const [index, refusal] of refusals.entries()) {
    const { transport } = transportWith(() => refusal);
    const outcome = await transport.postToThread({ threadId: "thread-77", text: "hello" });
    assert.equal(outcome.status, "rate-limited", `refusal ${index}`);

    // Pinned on the pair rather than on the field, because the field alone says nothing about
    // whether the bucket survives being handed it.
    const budget = createBudget();
    budget.observe(outcome.rate, 1_000);
    assert.ok(
      budget.affordable(1_000 + MAX_USABLE_WAIT_MS),
      `refusal ${index} wedged the bucket past the ceiling: it blocks until ${String(budget.blockedUntil())}`,
    );
  }
});

test("the wait ceiling is the longest wait the router above it can act on", () => {
  // The router stops a run rather than sit out more than its own per-run cap, and a budget blocks
  // for exactly as long as the wait it is handed names. A ceiling above the cap would therefore
  // bound nothing any decision reads, and one below it would shorten a wait a run would have spent
  // in full. Nothing at runtime would report the two as crossed.
  assert.equal(MAX_USABLE_WAIT_MS, MAX_RUN_WAIT_MS);
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

test("an edit forwards the rows it was given, and sends no components field without them", async () => {
  // The field's absence is load-bearing: a PATCH that omits it leaves the message's existing rows
  // in place, which is what an edit rewriting only text means, while `[]` is what strips them.
  const { sent, transport } = transportWith(() => respond(null));
  const row = { type: 1 as const, components: [] };

  await transport.editInThread({ threadId: "thread-1", messageId: "msg-1", text: "text only" });
  await transport.editInThread({
    threadId: "thread-1",
    messageId: "msg-1",
    text: "with rows",
    components: [row],
  });
  await transport.editInThread({
    threadId: "thread-1",
    messageId: "msg-1",
    text: "rows stripped",
    components: [],
  });

  assert.deepEqual(
    sent.map((call) => call.body.components),
    [undefined, [row], []],
  );
  assert.ok(!("components" in sent[0].body), "the field is left off entirely, never sent undefined");
});

test("an interaction callback answers on its own route, deferred or ephemeral", async () => {
  // Its own route and therefore its own rate bucket, which is why the caller budgets it apart from
  // every message write. Type 6 acknowledges without touching the message; type 4 with the
  // ephemeral flag answers the one person who pressed.
  const sent: Sent[] = [];
  const responder = createInteractionResponder(async (input) => {
    sent.push({ ...input, body: input.body ?? {} });
    return respond(null);
  });

  await responder.acknowledge({ interactionId: "interaction-1", token: "SECRET-token" });
  await responder.ephemeral({
    interactionId: "interaction-2",
    token: "SECRET-token",
    text: "Question 2 is not answered yet.",
  });

  assert.deepEqual(
    sent.map((call) => `${call.method} ${call.route}`),
    [
      "POST /interactions/interaction-1/SECRET-token/callback",
      "POST /interactions/interaction-2/SECRET-token/callback",
    ],
  );
  assert.deepEqual(sent[0].body, { type: 6 });
  assert.deepEqual(sent[1].body, {
    type: 4,
    data: {
      content: "Question 2 is not answered yet.",
      allowed_mentions: { parse: [] },
      // EPHEMERAL and SUPPRESS_EMBEDS: visible to the presser alone, and never unfurling a link.
      flags: 68,
    },
  });
});
