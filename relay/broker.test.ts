// The relay's half of the loopback wire, driven against the broker's real routes. Both ends are
// exercised here rather than mocked, because the wire is the contract: a field renamed on one side
// and not the other produces a session that connects, holds a pipe open, and never hears anything.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { RELAY_REPLY_IDLE_MS, loadConfig } from "../broker/config.ts";
import { renderAnswer } from "../broker/discord/render.ts";
import { NO_RATE_INFO } from "../broker/discord/transport.ts";
import type { ThreadMessenger } from "../broker/discord/transport.ts";
import { createRegistry } from "../broker/registry.ts";
import { MAX_RUN_WAIT_MS, RUN_PACE_MS, createOutboundRouter } from "../broker/routing/outbound.ts";
import { createThreadWriter } from "../broker/routing/writer.ts";
import { createRelayRoutes } from "../broker/routing/http.ts";
import { createRelayHub } from "../broker/routing/relays.ts";
import type { PermissionRequest } from "../broker/security/permission.ts";
import { MCP_TOOL_IDLE_TIMEOUT_MS, createBrokerClient } from "./broker.ts";
import type { BrokerClient } from "./broker.ts";
import type { PermissionVerdict } from "./permission.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";
const GRACE_MS = 50;

// Cleanup is registered with the test rather than written at the end of each one: a failed
// assertion would otherwise leave a listening server and a held-open socket behind, and the test
// runner then never exits.
async function broker(t: TestContext, options: { replyHeartbeatMs?: number } = {}) {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-warden",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
    backgroundTasks: null,
  });
  const relays = createRelayHub({ registry, graceMs: GRACE_MS });
  const posts: Array<{ threadId: string; text: string }> = [];
  // What a run held open looks like from the router's side: the post is in flight and has not come
  // back. Held here rather than by a clock, so a test drives how long a reply takes without waiting
  // out a real one.
  let held: Promise<void> | null = null;
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      if (held !== null) await held;
      posts.push(input);
      return { status: "ok", value: { messageId: "msg-1" }, rate: NO_RATE_INFO };
    },
    editInThread: async () => ({ status: "ok", value: null, rate: NO_RATE_INFO }),
  };
  let replyRequests = 0;
  const prompts: PermissionRequest[] = [];
  const routes = createRelayRoutes({
    relays,
    outbound: createOutboundRouter({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: createThreadWriter({ messenger, now: Date.now }),
    }),
    permissions: {
      request: async (_processToken, request) => {
        prompts.push(request);
        return true;
      },
    },
    maxBodyBytes: 64 * 1024,
    streamIdleMs: 60_000,
    // Long enough by default that a test saying nothing about heartbeats never sees one, which is
    // what makes a broker gone quiet the shape a test asks for rather than the shape it inherits.
    replyHeartbeatMs: options.replyHeartbeatMs ?? 60_000,
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
    /** Holds every post of every run until the returned release is called. */
    holdPosts: (): (() => void) => {
      let release = (): void => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
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
  // The header is a literal on purpose: this test drives the real client end to end, and
  // expressing the expectation through the renderer would let a broken header pass both sides.
  assert.deepEqual(context.posts, [
    { threadId: THREAD, text: "📣 Claude · answer\nthe migration is done" },
  ]);
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

test("a relay that names no idle window takes the one the broker heartbeats under", async () => {
  // The window has to be ordered against the broker's heartbeat, and the two live in different
  // processes: a literal chosen here would be ordered against that heartbeat by coincidence and
  // nothing else, and no runtime signal would report the two as crossed. What this pins is that the
  // default is the shared value rather than a number of the relay's own.
  const client = createBrokerClient({ port: 1, processToken: TOKEN, onMessage: () => {} });
  assert.equal(client.replyIdleMs, RELAY_REPLY_IDLE_MS);
  assert.ok(
    client.replyCeilingMs > client.replyIdleMs,
    "a broker gone quiet has to run out of silence before the reply runs out of ceiling, or every " +
      "dead broker reports as one still posting",
  );

  const named = createBrokerClient({
    port: 1,
    processToken: TOKEN,
    onMessage: () => {},
    replyIdleMs: 200,
    replyCeilingMs: 400,
  });
  assert.equal(named.replyIdleMs, 200, "a caller that names its own window still gets it");
  assert.equal(named.replyCeilingMs, 400);
});

test("the ceiling on one reply settles inside the window Claude Code allows a tool call", async () => {
  // A tool call is bounded from outside this repo by an idle window as well as by a wall clock, and
  // the idle window is the tight one: thirty minutes for a stdio server, reset only by a progress
  // notification. Nothing in this relay sends one, so a ceiling at or past that window would let
  // Claude Code give up on the reply tool first, and what the model is handed then is a tool error,
  // which is the invitation to send the whole answer again over the top of what landed. The window
  // is another program's default and cannot be enforced from here, so what holds the relation is
  // this client settling first. The default is what is under test, so nothing overrides it.
  const client = createBrokerClient({ port: 1, processToken: TOKEN, onMessage: () => {} });

  assert.ok(
    client.replyCeilingMs < MCP_TOOL_IDLE_TIMEOUT_MS,
    `a reply is waited on for ${client.replyCeilingMs}ms against a ${MCP_TOOL_IDLE_TIMEOUT_MS}ms ` +
      `idle window`,
  );
});

test("the longest single run the reply route accepts finishes inside that ceiling", async () => {
  // The ceiling is chosen rather than derived, so nothing else orders it against what a run costs.
  // This is that ordering for the one part of the cost that can be computed: one reply at the
  // largest body the route accepts, measured through the renderer the broker really posts with
  // rather than recomputed here, so a pacing gap, a waiting cap, a body ceiling, or a splitter that
  // packs less densely each move it on their own. It says nothing about the thread's ordering chain,
  // which is unbounded and is what the ceiling exists for.
  const cap = loadConfig({}).maxBodyBytes;
  const longest = renderAnswer("a".repeat(cap));
  const run = longest.length * RUN_PACE_MS + MAX_RUN_WAIT_MS;
  const client = createBrokerClient({ port: 1, processToken: TOKEN, onMessage: () => {} });

  assert.ok(
    run < client.replyCeilingMs,
    `a reply at the ${cap}-byte body cap renders into ${longest.length} messages, which pace at ` +
      `${RUN_PACE_MS}ms and wait up to ${MAX_RUN_WAIT_MS}ms, for ${run}ms against a ` +
      `${client.replyCeilingMs}ms ceiling`,
  );
});

test("a permission prompt waits on its own wait, not on the one a reply is allowed", async () => {
  // A reply is answered across a whole paced run and is allowed to take minutes. The permission
  // route costs one alert post: the operator's verdict comes back down the stream rather than on
  // that response, so a prompt held to the reply's ceiling parks a session for minutes against a
  // broker that has stopped answering, and a parked session is exactly what the prompt exists to
  // unpark.
  const client = createBrokerClient({ port: 1, processToken: TOKEN, onMessage: () => {} });

  assert.ok(
    client.permissionTimeoutMs < client.replyCeilingMs,
    `a prompt waits ${client.permissionTimeoutMs}ms against a reply's ${client.replyCeilingMs}ms`,
  );
});

test("a reply whose run outlasts the idle window lands whole and reports as sent", async (t) => {
  // The regression. A reply waits on its thread's ordering chain, so its response can be minutes
  // away with nothing bounding it; a relay that gave up at a fixed wait would tell the model the
  // reply failed while its messages were still going up, and a model told a reply failed sends the
  // whole answer again over the top of what landed. The run is held at the messenger rather than by
  // a clock, so what is measured here is the relay's tolerance rather than a real run's duration.
  const IDLE_MS = 100;
  const context = await broker(t, { replyHeartbeatMs: 20 });
  let messages = 0;
  const client = registered(
    t,
    createBrokerClient({
      port: context.port,
      processToken: TOKEN,
      onMessage: () => {
        messages += 1;
      },
      replyIdleMs: IDLE_MS,
    }),
  );
  client.start();
  await readyToWrite(context, () => messages);

  const release = context.holdPosts();
  const answer = client.reply("a report worth waiting for");
  const openedAt = Date.now();
  await until(() => Date.now() - openedAt > IDLE_MS * 3);
  release();

  assert.deepEqual(await answer, { status: "sent", error: undefined });
  assert.deepEqual(context.posts, [
    { threadId: THREAD, text: "📣 Claude · answer\na report worth waiting for" },
  ]);
});

test("a broker gone quiet reports failed while one still answering reports still posting", async (t) => {
  // The two timeout shapes, discriminated by the one thing that differs between these brokers:
  // whether the broker keeps writing while the run is in flight. Both hold their run open forever,
  // so a relay reading elapsed time alone could not tell them apart, and the reports have to differ
  // because the remedies do: a reply the broker never answered is safe to send again, and a reply
  // the broker is still posting is exactly the one that must not be.
  const CEILING_MS = 400;
  const quiet = await broker(t);
  const answering = await broker(t, { replyHeartbeatMs: 20 });
  const seen = { quiet: 0, answering: 0 };
  const quietClient = registered(
    t,
    createBrokerClient({
      port: quiet.port,
      processToken: TOKEN,
      onMessage: () => {
        seen.quiet += 1;
      },
      replyIdleMs: 100,
      replyCeilingMs: CEILING_MS,
    }),
  );
  const answeringClient = registered(
    t,
    createBrokerClient({
      port: answering.port,
      processToken: TOKEN,
      onMessage: () => {
        seen.answering += 1;
      },
      replyIdleMs: 100,
      replyCeilingMs: CEILING_MS,
    }),
  );
  quietClient.start();
  answeringClient.start();
  await readyToWrite(quiet, () => seen.quiet);
  await readyToWrite(answering, () => seen.answering);

  // Never released: a chain wedged rather than slow is what the ceiling exists for.
  quiet.holdPosts();
  answering.holdPosts();

  assert.equal((await quietClient.reply("into a dead broker")).status, "failed");
  assert.equal((await answeringClient.reply("into a wedged chain")).status, "still-posting");
});

test("a reply the broker refuses outright still reports the refusal to the model", async (t) => {
  // The reply route commits its 200 before the run, so nothing about a reply's outcome can ride the
  // status line any more. What still rides a status line is a request the route refuses before the
  // run starts, and the relay reads the body on both, so this pins that a refusal is still reported
  // rather than swallowed by a client that stopped looking at status codes.
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

  const result = await client.reply("x".repeat(70 * 1024));
  assert.deepEqual(result, { status: "failed", error: "body too large" });
  assert.deepEqual(context.posts, [], "nothing reached the thread");
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
      replyIdleMs: 200,
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
      replyIdleMs: 2_000,
    }),
  );
  client.start();
  await until(() => ready);

  const result = await client.reply("into the void");
  assert.equal(result.status, "failed", "the promise settled instead of parking the turn");
});
