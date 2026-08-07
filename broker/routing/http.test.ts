// The relay's loopback routes, driven over a real HTTP server rather than by calling the handler.
// The stream is a held-open response whose closing is a session's death signal, and neither that
// nor the Host check can be exercised by calling functions: fetch substitutes the real Host header,
// and a mocked response never closes a socket.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRegistry } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { createRelayHub } from "./relays.ts";
import { createThreadWriter } from "./writer.ts";
import { createOutboundRouter } from "./outbound.ts";
import { createRelayRoutes } from "./http.ts";
import { NO_RATE_INFO } from "../discord/transport.ts";
import type { ThreadMessenger } from "../discord/transport.ts";
import type { PermissionRequest } from "../security/permission.ts";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const THREAD = "900000000000000001";
const GRACE_MS = 50;

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

type Harness = {
  port: number;
  registry: Registry;
  relays: ReturnType<typeof createRelayHub>;
  posts: Array<{ threadId: string; text: string }>;
  /** What the permission route handed the desk, which is where the loopback contract ends. */
  prompts: Array<{ processToken: string; request: PermissionRequest }>;
  /** Makes the desk refuse the next prompt, the way an unpostable one is refused in production. */
  refusePrompts: () => void;
  close: () => Promise<void>;
};

// Cleanup is registered with the test rather than written at the end of each one: a failed
// assertion would otherwise leave a listening server and a held-open socket behind, and the test
// runner then never exits.
async function harness(t: TestContext): Promise<Harness> {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  announce(registry, "session-a");
  const relays = createRelayHub({ registry, graceMs: GRACE_MS });
  const posts: Array<{ threadId: string; text: string }> = [];
  const messenger: ThreadMessenger = {
    postToThread: async (input) => {
      posts.push(input);
      return { status: "ok", value: null, rate: NO_RATE_INFO };
    },
  };
  const prompts: Array<{ processToken: string; request: PermissionRequest }> = [];
  // What the desk reports back about a prompt. A desk that could not post one says so, and the
  // route has to carry that answer rather than reporting every prompt as taken.
  let accept = true;
  const routes = createRelayRoutes({
    relays,
    outbound: createOutboundRouter({
      registry,
      threadFor: () => THREAD,
      mirrorWriter: createThreadWriter({ messenger, now: Date.now }),
    }),
    permissions: {
      request: async (processToken, request) => {
        prompts.push({ processToken, request });
        return accept;
      },
    },
    maxBodyBytes: 64 * 1024,
    streamIdleMs: 60_000,
  });
  const server = http.createServer((request, response) => {
    if (routes(request, response)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return {
    port,
    registry,
    relays,
    posts,
    prompts,
    refusePrompts: () => {
      accept = false;
    },
    close,
  };
}

/** Opens the stream and resolves once the broker has registered it. */
function openStream(
  port: number,
  onLine: (line: string) => void,
  token = TOKEN,
): Promise<http.ClientRequest> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/relay/stream",
        headers: { "x-channel-process-token": token },
      },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let cut = buffer.indexOf("\n");
          while (cut !== -1) {
            onLine(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
          }
        });
        assert.equal(response.statusCode, 200);
        resolve(request);
      },
    );
    request.on("error", reject);
  });
}

function post(port: number, path: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          "x-channel-process-token": TOKEN,
          ...headers,
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: raw }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/** Waits for a condition the far end of a socket has to produce, rather than for a fixed delay. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the condition never held");
}

/** The reply key the broker issues on the stream's first line. */
function replyKeyOf(lines: string[]): string {
  const hello = JSON.parse(lines[0]) as { type: string; replyKey?: string };
  assert.equal(hello.type, "hello", "the first line of a stream is the handshake");
  return hello.replyKey ?? "";
}

test("a relay attaches over the stream and receives events as newline-delimited JSON", async (t) => {
  const context = await harness(t);
  const lines: string[] = [];
  const request = await openStream(context.port, (line) => lines.push(line));
  await until(() => context.relays.attached(TOKEN));
  await until(() => lines.length > 0);

  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "run it" });
  await until(() => lines.length > 1);
  assert.deepEqual(JSON.parse(lines[1]), { type: "message", chatId: THREAD, text: "run it" });

  request.destroy();
});

test("the stream closing marks the session ended, within a heartbeat", async (t) => {
  const context = await harness(t);
  const request = await openStream(context.port, () => {});
  await until(() => context.relays.attached(TOKEN));

  request.destroy();
  await until(() => !context.relays.attached(TOKEN));
  assert.equal(
    context.registry.list()[0].state,
    "live",
    "a closed pipe gets its grace window before the session is called dead",
  );

  await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 10));
  context.relays.heartbeat();
  assert.equal(context.registry.list()[0].state, "ended");
});

test("a second stream on the same token is refused rather than promoted", async (t) => {
  // Every shell subprocess a session spawns inherits the process token. A newcomer that took over
  // the pipe would receive the operator's steering messages and could answer as Claude.
  const context = await harness(t);
  const first: string[] = [];
  const held = await openStream(context.port, (line) => first.push(line));
  await until(() => first.length > 0);

  const second: string[] = [];
  await openStream(context.port, (line) => second.push(line));
  await until(() => second.length > 0);
  assert.deepEqual(JSON.parse(second[0]), { type: "refused", reason: "already attached" });

  context.relays.deliver(TOKEN, { type: "message", chatId: THREAD, text: "steer" });
  await until(() => first.length > 1);
  assert.equal(second.length, 1, "the impostor is told no and hears nothing else");

  held.destroy();
});

test("a reply is posted to the session's thread and reports its outcome", async (t) => {
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(context.port, "/relay/reply", JSON.stringify({ text: "done" }), {
    "x-channel-reply-key": replyKeyOf(lines),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { status: "sent" });
  // The header is a literal on purpose: this test pins what crosses the wire, and expressing the
  // expectation through the renderer would let a broken header pass both sides.
  assert.deepEqual(context.posts, [{ threadId: THREAD, text: "📣 Claude · answer\ndone" }]);

  stream.destroy();
});

test("a reply carrying a chat_id is routed by session all the same", async (t) => {
  // The relay does not send one, so this is the wire being explicit about ignoring it: an extra
  // field cannot become an address later without someone deliberately reading it.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(
    context.port,
    "/relay/reply",
    JSON.stringify({ text: "done", chat_id: "999999999999999999" }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.deepEqual(JSON.parse(answer.body), { status: "sent" });
  // The header is a literal on purpose: this test pins what crosses the wire, and expressing the
  // expectation through the renderer would let a broken header pass both sides.
  assert.deepEqual(context.posts, [{ threadId: THREAD, text: "📣 Claude · answer\ndone" }]);

  stream.destroy();
});

test("a reply from a token holder that does not hold the pipe is refused", async (t) => {
  // This is the whole point of the key. A process token is readable by every tool subprocess a
  // session spawns, so without it any of them could post into the operator's thread as Claude,
  // which is a credible way to talk a person into approving something.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const forged = await post(context.port, "/relay/reply", JSON.stringify({ text: "approve this" }), {
    "x-channel-reply-key": "guessed",
  });
  assert.equal(forged.status, 403);

  const bare = await post(context.port, "/relay/reply", JSON.stringify({ text: "approve this" }));
  assert.equal(bare.status, 403, "knowing the token alone is not standing to write");
  assert.deepEqual(context.posts, [], "nothing reached the operator's thread");

  stream.destroy();
});

test("a reply stops being accepted once its pipe is gone", async (t) => {
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);
  const key = replyKeyOf(lines);

  stream.destroy();
  await until(() => !context.relays.attached(TOKEN));

  const answer = await post(context.port, "/relay/reply", JSON.stringify({ text: "late" }), {
    "x-channel-reply-key": key,
  });
  assert.equal(answer.status, 403);
});

test("a permission prompt is taken off the pipe and handed to the desk", async (t) => {
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(
    context.port,
    "/relay/permission",
    JSON.stringify({
      request_id: "abcde",
      tool_name: "Bash",
      description: "run the migration",
      input_preview: "{ command: npm run migrate }",
    }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { status: "received" });
  assert.deepEqual(context.prompts, [
    {
      processToken: TOKEN,
      request: {
        requestId: "abcde",
        toolName: "Bash",
        description: "run the migration",
        inputPreview: "{ command: npm run migrate }",
      },
    },
  ]);

  stream.destroy();
});

test("a prompt missing its descriptive fields is still taken", async (t) => {
  // Refusing it would turn a cosmetic gap into a session parked on a question nobody is asked.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(
    context.port,
    "/relay/permission",
    JSON.stringify({ request_id: "abcde", tool_name: "Bash", description: 7 }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(context.prompts[0].request, {
    requestId: "abcde",
    toolName: "Bash",
    description: "",
    inputPreview: "",
  });

  stream.destroy();
});

test("a prompt the desk could not put in front of the operator reports as dropped", async (t) => {
  // A relay told its prompt was received waits for a verdict that is never coming, and says so
  // nowhere. The wire has to carry the difference.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);
  context.refusePrompts();

  const answer = await post(
    context.port,
    "/relay/permission",
    JSON.stringify({ request_id: "abcde", tool_name: "Bash" }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { status: "dropped" });

  stream.destroy();
});

test("a body past the cap is refused with a 413 the relay actually receives", async (t) => {
  // The refusal is written after the read gives up on the body, so this drives a real oversized
  // POST rather than trusting that the response survives abandoning the request stream.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(
    context.port,
    "/relay/reply",
    JSON.stringify({ text: "x".repeat(200 * 1024) }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.equal(answer.status, 413, "the peer was told why, rather than having its socket dropped");
  assert.deepEqual(JSON.parse(answer.body), { error: "body too large" });
  assert.deepEqual(context.posts, []);

  stream.destroy();
});

test("a prompt with no request id at all is refused rather than posted", async (t) => {
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const answer = await post(
    context.port,
    "/relay/permission",
    JSON.stringify({ tool_name: "Bash" }),
    { "x-channel-reply-key": replyKeyOf(lines) },
  );
  assert.equal(answer.status, 400);
  assert.deepEqual(context.prompts, []);

  stream.destroy();
});

test("a permission prompt from a token holder that does not hold the pipe is refused", async (t) => {
  // The same bar a reply is held to, for a sharper reason: this is the write that rings the
  // operator's phone and asks them for a yes, so a subprocess that scraped the process token out
  // of its environment must not be able to send one.
  const context = await harness(t);
  const lines: string[] = [];
  const stream = await openStream(context.port, (line) => lines.push(line));
  await until(() => lines.length > 0);

  const body = JSON.stringify({ request_id: "abcde", tool_name: "Bash" });
  const forged = await post(context.port, "/relay/permission", body, {
    "x-channel-reply-key": "guessed",
  });
  assert.equal(forged.status, 403);

  const bare = await post(context.port, "/relay/permission", body);
  assert.equal(bare.status, 403, "knowing the token alone is not standing to ring a phone");
  assert.deepEqual(context.prompts, []);

  stream.destroy();
});

test("a request with no process token is refused", async (t) => {
  const context = await harness(t);
  const answer = await post(context.port, "/relay/reply", JSON.stringify({ text: "x" }), {
    "x-channel-process-token": "",
  });
  assert.equal(answer.status, 400);
});

test("a rebinding Host header is refused on both relay routes", async (t) => {
  // The socket peer is honestly loopback in a DNS rebinding attack; the Host header is the only
  // place the name the page asked for survives. Driven over node:http because fetch replaces it.
  const context = await harness(t);
  const answer = await post(context.port, "/relay/reply", JSON.stringify({ text: "x" }), {
    host: `attacker.example:${context.port}`,
  });
  assert.equal(answer.status, 403);

  const refused = await new Promise<number>((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: context.port,
        path: "/relay/stream",
        headers: {
          "x-channel-process-token": TOKEN,
          host: `attacker.example:${context.port}`,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
  });
  assert.equal(refused, 403);
  assert.equal(context.relays.attached(TOKEN), false);
});

test("a route this handler does not own is left for the hook intake", async (t) => {
  const context = await harness(t);
  const answer = await post(context.port, "/hook", "{}");
  assert.equal(answer.status, 404, "the fallback handler answered, not the relay routes");
});
