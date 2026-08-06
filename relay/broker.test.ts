// The relay's half of the loopback wire, driven against the broker's real routes. Both ends are
// exercised here rather than mocked, because the wire is the contract: a field renamed on one side
// and not the other produces a session that connects, holds a pipe open, and never hears anything.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { NO_RATE_INFO } from "../broker/discord/transport.ts";
import type { ThreadMessenger } from "../broker/discord/transport.ts";
import { createRegistry } from "../broker/registry.ts";
import { createOutboundRouter } from "../broker/routing/outbound.ts";
import { createThreadWriter } from "../broker/routing/writer.ts";
import { createRelayRoutes } from "../broker/routing/http.ts";
import { createRelayHub } from "../broker/routing/relays.ts";
import type { PermissionRequest } from "../broker/security/permission.ts";
import { createBrokerClient } from "./broker.ts";
import type { BrokerClient } from "./broker.ts";
import type { PermissionVerdict } from "./permission.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";
const GRACE_MS = 50;

// Cleanup is registered with the test rather than written at the end of each one: a failed
// assertion would otherwise leave a listening server and a held-open socket behind, and the test
// runner then never exits.
async function broker(t: TestContext) {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-warden",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });
  const relays = createRelayHub({ registry, graceMs: GRACE_MS });
  const posts: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  let replyRequests = 0;
  const prompts: PermissionRequest[] = [];
  const routes = createRelayRoutes({
    relays,
    outbound: createOutboundRouter({
      registry,
      threadFor: () => THREAD,
      writer: createThreadWriter({ messenger, now: Date.now }),
    }),
    permissions: {
      request: async (_processToken, request) => {
        prompts.push(request);
        return true;
      },
    },
    maxBodyBytes: 64 * 1024,
    streamIdleMs: 60_000,
  });
  const server = http.createServer((request, response) => {
    if ((request.url ?? "").startsWith("/relay/reply")) replyRequests += 1;
    if (routes(request, response)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return {
    // Destroys every socket without closing the listener, which is what a broker killed mid
    // exchange looks like from the relay's side.
    hangUp: () => server.closeAllConnections(),
    replyRequests: () => replyRequests,
    port: (server.address() as AddressInfo).port,
    registry,
    relays,
    posts,
    prompts,
    close,
  };
}

/**
 * Waits until the client holds the stream's `hello`, which is what issues the reply key.
 *
 * The hub registering the pipe is not that: it happens in this process before the line has crossed
 * the socket. A message delivered after the hello travels the same stream through the same reader,
 * so seeing one is proof the hello was already parsed.
 */
async function readyToWrite(context: Awaited<ReturnType<typeof broker>>, seen: () => number): Promise<void> {
  await until(() => context.relays.attached(TOKEN));
  const before = seen();
  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "handshake" });
  await until(() => seen() > before);
}

/** Registers a client's shutdown with the test, so a failed assertion cannot leave one reconnecting. */
function registered(t: TestContext, client: BrokerClient): BrokerClient {
  t.after(() => client.stop());
  return client;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the condition never held");
}

test("a message written to the broker's stream reaches the relay with its chat id", async (t) => {
  const context = await broker(t);
  const received: Array<{ text: string; chatId: string }> = [];
  const client = registered(t, createBrokerClient({
    port: context.port,
    processToken: TOKEN,
    onMessage: (text, chatId) => received.push({ text, chatId }),
  }));
  client.start();
  await until(() => context.relays.attached(TOKEN));

  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "run it" });
  await until(() => received.length > 0);
  assert.deepEqual(received, [{ text: "run it", chatId: THREAD }]);
});

test("a heartbeat keeps the pipe without being mistaken for a message", async (t) => {
  const context = await broker(t);
  const received: string[] = [];
  const client = registered(t, createBrokerClient({
    port: context.port,
    processToken: TOKEN,
    onMessage: (text) => received.push(text),
  }));
  client.start();
  await until(() => context.relays.attached(TOKEN));

  context.relays.heartbeat();
  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "after the ping" });
  await until(() => received.length > 0);
  assert.deepEqual(received, ["after the ping"], "the ping was not delivered as a message");
});

test("a reply travels the wire and comes back as the broker's own verdict", async (t) => {
  const context = await broker(t);
  let messages = 0;
  const client = registered(
    t,
    createBrokerClient({
      port: context.port,
      processToken: TOKEN,
      onMessage: () => {
        messages += 1;
      },
    }),
  );
  client.start();
  await readyToWrite(context, () => messages);

  assert.deepEqual(await client.reply("the migration is done"), { status: "sent", error: undefined });
  assert.deepEqual(context.posts, [{ threadId: THREAD, text: "the migration is done" }]);
});

test("a permission prompt travels the wire and its verdict comes back down the stream", async (t) => {
  // Both directions over the real routes. The prompt is a POST that the broker only acknowledges,
  // and the answer arrives whenever the operator gives it, on the stream, which is the one channel
  // only the holder of this pipe can read.
  const context = await broker(t);
  let messages = 0;
  const verdicts: PermissionVerdict[] = [];
  const client = registered(
    t,
    createBrokerClient({
      port: context.port,
      processToken: TOKEN,
      onMessage: () => {
        messages += 1;
      },
      onVerdict: (verdict) => verdicts.push(verdict),
    }),
  );
  client.start();
  await readyToWrite(context, () => messages);

  assert.equal(
    await client.permissionRequest({
      requestId: "abcde",
      toolName: "Bash",
      description: "run the migration",
      inputPreview: "{ command: npm run migrate }",
    }),
    true,
  );
  assert.deepEqual(context.prompts, [
    {
      requestId: "abcde",
      toolName: "Bash",
      description: "run the migration",
      inputPreview: "{ command: npm run migrate }",
    },
  ]);

  context.relays.deliver(TOKEN, { type: "permission", requestId: "abcde", behavior: "allow" });
  await until(() => verdicts.length > 0);
  assert.deepEqual(verdicts, [{ requestId: "abcde", behavior: "allow" }]);
});

test("a malformed verdict on the stream is ignored rather than answered", async (t) => {
  const context = await broker(t);
  let messages = 0;
  const verdicts: PermissionVerdict[] = [];
  const client = registered(
    t,
    createBrokerClient({
      port: context.port,
      processToken: TOKEN,
      onMessage: () => {
        messages += 1;
      },
      onVerdict: (verdict) => verdicts.push(verdict),
    }),
  );
  client.start();
  await readyToWrite(context, () => messages);

  // A behavior outside the two the protocol defines would otherwise reach Claude Code as a
  // notification it rejects, and a prompt answered with nothing is a parked session.
  context.relays.deliver(TOKEN, {
    type: "permission",
    requestId: "abcde",
    behavior: "maybe" as "allow",
  });
  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "settle" });
  await until(() => messages > 1);
  assert.deepEqual(verdicts, []);
});

test("a relay holding no stream cannot hand over a permission prompt", async (t) => {
  const context = await broker(t);
  const client = registered(
    t,
    createBrokerClient({ port: context.port, processToken: TOKEN, onMessage: () => {} }),
  );

  assert.equal(
    await client.permissionRequest({
      requestId: "abcde",
      toolName: "Bash",
      description: "",
      inputPreview: "",
    }),
    false,
  );
  assert.deepEqual(context.prompts, []);
});

test("a relay holding no stream reports the reply locally instead of attempting it", async (t) => {
  // The reply key arrives on the stream, so no stream is no standing to write into the operator's
  // thread. Answered here rather than over a socket the broker would refuse anyway.
  const context = await broker(t);
  const client = registered(
    t,
    createBrokerClient({ port: context.port, processToken: TOKEN, onMessage: () => {} }),
  );

  const result = await client.reply("unattached");
  assert.equal(result.status, "failed");
  assert.deepEqual(context.posts, []);
  assert.equal(context.replyRequests(), 0, "no socket is opened for a reply that cannot be made");
});

test("a reply against a broker that accepts and then goes silent settles rather than hanging", async (t) => {
  // Probed on Node 24: a peer that dies mid-body emits aborted, error, or close and never end, so
  // a promise resolved only on end never settles and the tool call awaiting it parks the turn.
  const context = await broker(t);
  const client = registered(
    t,
    createBrokerClient({
      port: context.port,
      processToken: TOKEN,
      onMessage: () => {},
      replyTimeoutMs: 200,
    }),
  );
  client.start();
  await until(() => context.relays.attached(TOKEN));

  // Every socket the server holds is destroyed mid-exchange, which is the shape of a broker killed
  // while a reply is on the wire.
  const answer = client.reply("into the void");
  context.hangUp();
  const result = await answer;
  assert.equal(result.status, "failed", "the promise settled instead of parking the turn");
});

test("the relay reconnects after the broker drops its pipe", async (t) => {
  // The broker is a scheduled task restarted at logon and can go down for any part of a
  // twelve-hour session. A relay that did not come back would leave the session running and
  // permanently unreachable while its status card kept ticking.
  const context = await broker(t);
  const client = registered(t, createBrokerClient({
    port: context.port,
    processToken: TOKEN,
    onMessage: () => {},
    reconnectDelayMs: 10,
  }));
  client.start();
  await until(() => context.relays.attached(TOKEN));

  context.relays.closeAll();
  await until(() => !context.relays.attached(TOKEN));
  await until(() => context.relays.attached(TOKEN));
});

test("a relay that keeps losing the pipe race backs off instead of retrying every second", async (t) => {
  // A refused attach arrives as a 200 that ends immediately. Reset on the status code alone, the
  // backoff never grows, so a relay that lost the race to a local process retries once a second
  // for the life of the session and writes a broker log line each time.
  const attempts: number[] = [];
  const server = http.createServer((_request, response) => {
    attempts.push(Date.now());
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({ type: "refused", reason: "already attached" })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  // 25ms doubling reaches 200ms by the fifth attempt while a reset backoff stays at 25 plus a few
  // milliseconds of loopback overhead. The two are far enough apart that scheduling noise cannot
  // dress one up as the other, which a "the last gap is bigger than the first" check could not say.
  const BASE_MS = 25;
  const client = registered(
    t,
    createBrokerClient({
      port: (server.address() as AddressInfo).port,
      processToken: TOKEN,
      onMessage: () => {},
      reconnectDelayMs: BASE_MS,
    }),
  );
  client.start();
  await until(() => attempts.length >= 5);
  client.stop();

  const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
  assert.ok(
    gaps[gaps.length - 1] >= BASE_MS * 4,
    `the delay has to keep doubling across refusals, saw ${JSON.stringify(gaps)}`,
  );
});

test("a reply reaching no broker at all is reported rather than thrown", async (t) => {
  const context = await broker(t);
  const port = context.port;
  // Closed first, on purpose: this is the broker being down, which is a state the relay must
  // report rather than throw from.
  await context.close();

  const client = registered(
    t,
    createBrokerClient({ port, processToken: TOKEN, onMessage: () => {} }),
  );
  const result = await client.reply("hello");
  assert.equal(result.status, "failed");
});

test("a reply whose response is cut off mid-body settles instead of hanging", async (t) => {
  // The failure the response-level handlers exist for, driven for real rather than approximated.
  // Node reports a peer that dies part-way through a body with 'aborted' and 'error' and never with
  // 'end', so a promise resolved only on 'end' never settles and the tool call awaiting it parks
  // the turn. Probed on Node 24: a server that closes connections before the request is even made
  // does not reproduce this, which is why the socket is destroyed from inside the handler.
  const server = http.createServer((request, response) => {
    if ((request.url ?? "").startsWith("/relay/stream")) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ type: "hello", replyKey: "issued" })}\n`);
      // A message behind the hello, so the test has something observable to wait on. It travels
      // the same stream through the same reader, so seeing it proves the hello was already parsed
      // and the reply key is held. Without it this test can run its reply before the key arrives
      // and pass on the local refusal instead of on the settle path it exists to prove.
      response.write(`${JSON.stringify({ type: "message", chatId: THREAD, text: "ready" })}\n`);
      return;
    }
    request.resume();
    request.on("end", () => {
      // Headers and a truncated body, then the socket goes. Content-Length promises more than is
      // ever written, so the client is left waiting on bytes that never come.
      response.writeHead(200, { "content-type": "application/json", "content-length": "64" });
      response.write('{"stat');
      setTimeout(() => response.socket?.destroy(), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  let ready = false;
  const client = registered(
    t,
    createBrokerClient({
      port: (server.address() as AddressInfo).port,
      processToken: TOKEN,
      onMessage: () => {
        ready = true;
      },
      replyTimeoutMs: 2_000,
    }),
  );
  client.start();
  await until(() => ready);

  const result = await client.reply("into the void");
  assert.equal(result.status, "failed", "the promise settled instead of parking the turn");
});
