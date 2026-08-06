import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandler, isAllowedHost, isLoopback, parseIntake } from "./intake.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { startBroker } from "./index.ts";
import type { BrokerConfig } from "./config.ts";

const TOKEN = "5f0c2e4a-0000-4000-8000-000000000001";

test("isLoopback accepts only the loopback forms", () => {
  for (const address of [
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "::1",
    "::1%lo0",
    "::ffff:127.0.0.1",
    "  127.0.0.1  ",
  ]) {
    assert.equal(isLoopback(address), true, address);
  }

  for (const address of [
    "192.168.1.5",
    "10.0.0.4",
    "0.0.0.0",
    "128.0.0.1",
    "::ffff:192.168.1.5",
    "fe80::1",
    "2001:db8::1",
    "",
    "not an address",
    undefined,
  ]) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

// The handler is exported separately from the server precisely so a non-loopback remote address can
// be presented: a request from off-box cannot be originated against a socket bound to 127.0.0.1.
function fakeRequest(
  remoteAddress: string | undefined,
  init: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
    /** When set, the body stream throws this message after its data, like a connection dying mid-read. */
    streamError?: string;
  } = {},
): IncomingMessage & { bodyConsumed: boolean; destroyed: boolean } {
  const body = init.body ?? "";
  const request = {
    // Flips when the handler iterates the body stream. The drop paths that must discard a body
    // without assembling it into a string call resume() instead, which leaves this false: that is
    // the observable difference between draining a body and reading it.
    bodyConsumed: false,
    destroyed: false,
    method: init.method ?? "POST",
    url: init.url ?? "/hook",
    // A real client always sends Host, and the handler now requires it, so the default stands in
    // for one. A test that cares about Host overrides it.
    headers: { host: "127.0.0.1:8787", ...(init.headers ?? {}) },
    socket: { remoteAddress },
    // The routes that drain rather than read a body call this. It stands in for the real stream's
    // flowing-mode switch.
    resume() {
      return this;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
    async *[Symbol.asyncIterator]() {
      this.bodyConsumed = true;
      if (body !== "") yield Buffer.from(body, "utf8");
      if (init.streamError !== undefined) throw new Error(init.streamError);
    },
  };
  return request as unknown as IncomingMessage & { bodyConsumed: boolean; destroyed: boolean };
}

type Captured = { status: number; body: unknown };

function fakeResponse(): { response: ServerResponse; done: Promise<Captured> } {
  let settle: (value: Captured) => void;
  const done = new Promise<Captured>((resolve) => {
    settle = resolve;
  });
  let status = 0;
  const response = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(text: string) {
      settle({ status, body: text === "" ? null : JSON.parse(text) });
    },
  };
  return { response: response as unknown as ServerResponse, done };
}

function hookHeaders(event: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-channel-hook-event": event,
    "x-channel-process-token": TOKEN,
    "x-channel-session-name": "neo-intake",
    ...extra,
  };
}

function brokerConfig(overrides: Partial<BrokerConfig> & { stateFile: string }): BrokerConfig {
  return {
    port: 0,
    host: "NEO",
    staleAfterMs: 60_000,
    sweepIntervalMs: 60_000,
    maxBodyBytes: 64 * 1024,
    relayHeartbeatMs: 60_000,
    retainTerminalMs: 24 * 60 * 60 * 1000,
    maxSessions: 500,
    logFile: null,
    logMaxBytes: 5 * 1024 * 1024,
    logMaxFiles: 5,
    mirror: true,
    mirrorMaxBytes: 256 * 1024,
    ...overrides,
  };
}

type MirrorOptions = Parameters<typeof createHandler>[0]["mirror"];

type Delivery = { processToken: string; kind: string; text: string; sessionId: string | null };

/** A mirror seam that records what reaches it, standing in for the outbound router. */
function fakeMirror(overrides: Partial<MirrorOptions> = {}): {
  mirror: MirrorOptions;
  deliveries: Delivery[];
} {
  const deliveries: Delivery[] = [];
  return {
    deliveries,
    mirror: {
      enabled: true,
      maxBytes: 1024,
      deliver: async (processToken, kind, text, sessionId) => {
        deliveries.push({ processToken, kind, text, sessionId });
        return null;
      },
      ...overrides,
    },
  };
}

function harness(mirror?: MirrorOptions): {
  registry: Registry;
  handle: ReturnType<typeof createHandler>;
} {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  return {
    registry,
    handle: createHandler({ registry, maxBodyBytes: 1024, mirror: mirror ?? fakeMirror().mirror }),
  };
}

/** Announces a session holding TOKEN, so a mirror post authenticated by it has somewhere to go. */
function announce(registry: Registry): void {
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-intake",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
  });
}

/** Delivery happens after the 202 is written; one macrotask turn lets it land before asserting. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function call(
  handle: ReturnType<typeof createHandler>,
  request: IncomingMessage,
): Promise<Captured> {
  const { response, done } = fakeResponse();
  handle(request, response);
  return done;
}

test("a non-loopback request is refused and cannot touch the registry", async () => {
  const { registry, handle } = harness();

  const result = await call(
    handle,
    fakeRequest("192.168.1.5", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    }),
  );

  assert.equal(result.status, 403);
  assert.deepEqual(registry.list(), [], "a refused request must not create a session");
});

test("a request with no remote address at all is refused", async () => {
  const { registry, handle } = harness();
  const result = await call(handle, fakeRequest(undefined, { headers: hookHeaders("Stop") }));
  assert.equal(result.status, 403);
  assert.deepEqual(registry.list(), []);
});

test("a SessionStart post creates the session and GET /sessions returns it", async () => {
  const { registry, handle } = harness();

  const posted = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-a", source: "startup", cwd: "D:\\work" }),
    }),
  );
  assert.equal(posted.status, 200);

  const listed = await call(
    handle,
    fakeRequest("127.0.0.1", { method: "GET", url: "/sessions" }),
  );
  assert.equal(listed.status, 200);
  const sessions = (listed.body as { sessions: { sessionId: string; name: string }[] }).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, "session-a");
  assert.equal(sessions[0].name, "neo-intake");
  assert.equal(registry.list()[0].source, "startup");
});

test("a PostToolUse from an unannounced process token is accepted and dropped", async () => {
  const { registry, handle } = harness();

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PostToolUse"),
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "whoami" } }),
    }),
  );

  assert.equal(result.status, 202);
  assert.deepEqual(registry.list(), []);
});

test("a post with no process token is dropped as unwatched, never refused", async () => {
  // The installed hooks fire in every session on the machine; one started without the launch
  // wrapper posts with no token (or an empty one) after every tool call. A non-2xx here surfaces
  // as a visible hook error inside that session, so the drop must answer 202.
  const { registry, handle } = harness();

  const bare: Record<string, string> = { "x-channel-hook-event": "PostToolUse" };
  const empty: Record<string, string> = { ...bare, "x-channel-process-token": "" };
  const start: Record<string, string> = { "x-channel-hook-event": "SessionStart" };
  for (const headers of [bare, empty, start]) {
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", { headers, body: JSON.stringify({ tool_name: "Read" }) }),
    );
    assert.equal(result.status, 202, JSON.stringify(headers));
  }
  assert.deepEqual(registry.list(), []);
});

test("malformed JSON is a 400 and mutates nothing", async () => {
  const { registry, handle } = harness();

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart"), body: "{ nope" }),
  );

  assert.equal(result.status, 400);
  assert.deepEqual(registry.list(), []);
});

test("an oversized body is refused before it is parsed", async () => {
  const { registry, handle } = harness();

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-a", padding: "x".repeat(4096) }),
    }),
  );

  assert.equal(result.status, 413);
  assert.deepEqual(registry.list(), []);
});

test("a post with no recognized event header is a 400", async () => {
  const { handle } = harness();

  const cases: Record<string, string>[] = [
    {},
    { "x-channel-process-token": TOKEN },
    { "x-channel-hook-event": "SessionEnd", "x-channel-process-token": TOKEN },
  ];

  for (const headers of cases) {
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", { headers, body: JSON.stringify({ session_id: "session-a" }) }),
    );
    assert.equal(result.status, 400, JSON.stringify(headers));
  }
});

test("an unknown route is a 404", async () => {
  const { handle } = harness();
  const result = await call(handle, fakeRequest("127.0.0.1", { method: "GET", url: "/admin" }));
  assert.equal(result.status, 404);
});

test("a token-authenticated prompt reaches the mirror seam whole, with its kind", async () => {
  const { mirror, deliveries } = fakeMirror({ maxBytes: 4096 });
  const { registry, handle } = harness(mirror);
  announce(registry);

  // Longer than MAX_FIELD_LENGTH on purpose: the identity-field path caps strings at 256, and a
  // mirrored prompt run through it would be silently cut. The whole text must arrive.
  const prompt = "p".repeat(600);
  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: JSON.stringify({ prompt }),
    }),
  );
  await settled();

  assert.equal(result.status, 202);
  // Byte-identical to every drop's answer, so the response body cannot tell a local prober
  // whether a token was honored.
  assert.deepEqual(result.body, { ignored: true });
  assert.deepEqual(deliveries, [
    { processToken: TOKEN, kind: "prompt", text: prompt, sessionId: null },
  ]);
});

test("a Stop post delivers the turn's final reply as the reply kind", async () => {
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("Stop"),
      body: JSON.stringify({ last_assistant_message: "the migration is done" }),
    }),
  );
  await settled();

  assert.equal(result.status, 202);
  assert.deepEqual(deliveries, [
    { processToken: TOKEN, kind: "reply", text: "the migration is done", sessionId: null },
  ]);
});

test("a payload's session_id rides to the seam; its absence rides as null", async () => {
  // The router drops a straggler whose session_id names a replaced session, so the intake must
  // forward the field faithfully rather than resolving on the token alone.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("Stop"),
      body: JSON.stringify({ session_id: "session-a", last_assistant_message: "named" }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("Stop"),
      body: JSON.stringify({ last_assistant_message: "unnamed" }),
    }),
  );
  await settled();

  assert.deepEqual(
    deliveries.map((delivery) => ({ text: delivery.text, sessionId: delivery.sessionId })),
    [
      { text: "named", sessionId: "session-a" },
      { text: "unnamed", sessionId: null },
    ],
  );
});

test("a prototype key in the event header is refused, not resolved through the chain", async () => {
  // MIRROR_EVENTS is a plain object, and a bare index into one answers prototype keys: an event
  // header naming "constructor" or "__proto__" would return a non-undefined mapping, skip the
  // 400, and run the authenticated path with mapping.field === undefined, at which point a body
  // keyed "undefined" delivers text with a kind outside MirrorKind. The gate must answer these
  // exactly as it answers any unknown event.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  for (const event of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", {
        url: "/mirror",
        headers: hookHeaders(event),
        body: JSON.stringify({ undefined: "smuggled through the prototype chain" }),
      }),
    );
    assert.equal(result.status, 400, event);
  }
  await settled();
  assert.deepEqual(deliveries, []);
});

test("a body streaming far past the ceiling is cut off, not drained forever", async () => {
  // The quiet drain exists for an honestly-oversized post; a token-holding local process
  // streaming an endless chunked body is neither, and it must not get to hold the connection and
  // the drain loop open. Past a multiple of the ceiling the connection is destroyed.
  const { mirror, deliveries } = fakeMirror({ maxBytes: 100 });
  const { registry, handle } = harness(mirror);
  announce(registry);

  const request = fakeRequest("127.0.0.1", {
    url: "/mirror",
    headers: hookHeaders("Stop"),
    body: JSON.stringify({ last_assistant_message: "x".repeat(2_000) }),
  });
  const { response } = fakeResponse();
  handle(request, response);
  await settled();
  await settled();

  assert.equal(request.destroyed, true, "the connection must be destroyed past the drain limit");
  assert.deepEqual(deliveries, []);
});

test("with the mirror off, a post is accepted, drained, and nothing is delivered", async () => {
  const { mirror, deliveries } = fakeMirror({ enabled: false });
  const { registry, handle } = harness(mirror);
  announce(registry);

  const request = fakeRequest("127.0.0.1", {
    url: "/mirror",
    headers: hookHeaders("UserPromptSubmit"),
    body: JSON.stringify({ prompt: "sensitive work" }),
  });
  const result = await call(handle, request);
  await settled();

  assert.equal(result.status, 202, "off must stay quiet at the socket, never refuse");
  assert.deepEqual(deliveries, [], "off means unposted, not merely unrendered");
  assert.equal(request.bodyConsumed, false, "off also means the body is never assembled");
});

test("a tokenless mirror post is dropped before its body is ever read", async () => {
  // An unwrapped session on this machine posts its full prompt and reply here on every turn. The
  // token check runs before the body read, so that content transits the socket and is discarded
  // without ever being assembled into a string in broker memory.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  const tokenless: Record<string, string>[] = [
    { "x-channel-hook-event": "UserPromptSubmit" },
    { "x-channel-hook-event": "Stop", "x-channel-process-token": "" },
  ];
  for (const headers of tokenless) {
    const request = fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers,
      body: JSON.stringify({ prompt: "an unwrapped session's prompt" }),
    });
    const result = await call(handle, request);
    assert.equal(result.status, 202, JSON.stringify(headers));
    assert.equal(request.bodyConsumed, false, "the body must be drained, not read");
  }
  await settled();
  assert.deepEqual(deliveries, []);
});

test("a mirror post from a token no live session holds is dropped unread", async () => {
  const { mirror, deliveries } = fakeMirror();
  const { handle } = harness(mirror);

  const request = fakeRequest("127.0.0.1", {
    url: "/mirror",
    headers: hookHeaders("UserPromptSubmit"),
    body: JSON.stringify({ prompt: "a forged or replayed post" }),
  });
  const result = await call(handle, request);
  await settled();

  assert.equal(result.status, 202, "a drop answers exactly like /hook's equivalent, never a refusal");
  assert.equal(request.bodyConsumed, false);
  assert.deepEqual(deliveries, []);
});

test("a body at the mirror ceiling is delivered; one byte over is drained and dropped", async () => {
  const body = JSON.stringify({ last_assistant_message: "r".repeat(500) });
  const exact = Buffer.byteLength(body);

  const atCap = fakeMirror({ maxBytes: exact });
  {
    const { registry, handle } = harness(atCap.mirror);
    announce(registry);
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", { url: "/mirror", headers: hookHeaders("Stop"), body }),
    );
    await settled();
    assert.equal(result.status, 202);
    assert.equal(atCap.deliveries.length, 1, "a body exactly at the ceiling is inside it");
  }

  const overCap = fakeMirror({ maxBytes: exact - 1 });
  {
    const { registry, handle } = harness(overCap.mirror);
    announce(registry);
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", { url: "/mirror", headers: hookHeaders("Stop"), body }),
    );
    await settled();
    assert.equal(result.status, 202, "over the ceiling is a drop with a 2xx, never a 413");
    assert.deepEqual(overCap.deliveries, [], "the over-cap content is dropped, not posted");
  }
});

test("an absent or empty mirror field answers 2xx and posts nothing", async () => {
  // A turn whose final assistant message is empty is a real case, and a payload without the field
  // at all is indistinguishable from it on this side. Neither is an error.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  const cases: Array<{ event: string; body: string }> = [
    { event: "UserPromptSubmit", body: JSON.stringify({}) },
    { event: "UserPromptSubmit", body: JSON.stringify({ prompt: "" }) },
    { event: "Stop", body: JSON.stringify({}) },
    { event: "Stop", body: JSON.stringify({ last_assistant_message: "" }) },
    { event: "Stop", body: JSON.stringify({ last_assistant_message: 7 }) },
  ];
  for (const { event, body } of cases) {
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", { url: "/mirror", headers: hookHeaders(event), body }),
    );
    assert.equal(result.status, 202, `${event} ${body}`);
  }
  await settled();
  assert.deepEqual(deliveries, []);
});

test("a mirror post with an event outside the mirror vocabulary is a 400, like /hook", async () => {
  // The installed hooks carry UserPromptSubmit or Stop as static headers, so nothing that can show
  // an in-session error ever sends anything else; whatever did is malformed traffic of the same
  // class /hook answers 400.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  for (const event of ["SessionStart", "PostToolUse", "SessionEnd"]) {
    const result = await call(
      handle,
      fakeRequest("127.0.0.1", {
        url: "/mirror",
        headers: hookHeaders(event),
        body: JSON.stringify({ prompt: "hello" }),
      }),
    );
    assert.equal(result.status, 400, event);
  }
  await settled();
  assert.deepEqual(deliveries, []);
});

test("mirror content never appears in the log, on any path, at any level", async (t) => {
  // The section's central invariant, asserted the discriminating way: a logger that captures every
  // line at every level, every branch of the route driven with a distinct secret, and the assert is
  // on the secrets being absent from the captured output, not on how many lines were written.
  const lines: string[] = [];
  const logger = {
    info: (message: string) => lines.push(message),
    warn: (message: string) => lines.push(message),
    error: (message: string) => lines.push(message),
  };
  const originalConsoleError = console.error;
  console.error = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  t.after(() => {
    console.error = originalConsoleError;
  });

  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  // A delivery that throws an error quoting the text it failed to post: the hardest case, because
  // the one place the content could legitimately reach a catch block is here.
  const deliver = async (_token: string, _kind: string, text: string): Promise<null> => {
    throw new Error(`delivery exploded while posting: ${text}`);
  };
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    log: logger,
    mirror: { enabled: true, maxBytes: 200, deliver },
  });
  announce(registry);

  const secrets = {
    delivered: "SECRET-delivered-prompt",
    tokenless: "SECRET-unwrapped-session-prompt",
    unknownToken: "SECRET-forged-post-reply",
    overCap: "SECRET-oversized-reply",
    malformed: "SECRET-inside-broken-json",
    unknownEvent: "SECRET-behind-a-bad-event",
    nonObject: "SECRET-body-that-is-a-bare-string",
    mirrorOff: "SECRET-posted-while-off",
    streamError: "SECRET-quoted-by-a-dying-stream",
  };

  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: JSON.stringify({ prompt: secrets.delivered }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: { "x-channel-hook-event": "UserPromptSubmit" },
      body: JSON.stringify({ prompt: secrets.tokenless }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("Stop", { "x-channel-process-token": "not-the-announced-token" }),
      body: JSON.stringify({ last_assistant_message: secrets.unknownToken }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("Stop"),
      body: JSON.stringify({ last_assistant_message: secrets.overCap + "x".repeat(400) }),
    }),
  );
  // V8's JSON.parse error message embeds an excerpt of the source text, so a caught-and-logged
  // parse error is a leak even though no code ever touched the parsed content.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: `{ "prompt": "${secrets.malformed}"`,
    }),
  );
  // An unknown event still arrives with a content-bearing body; the 400 must not describe it.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("SessionEnd"),
      body: JSON.stringify({ prompt: secrets.unknownEvent }),
    }),
  );
  // Valid JSON whose whole body is the secret, refused as a non-object.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: JSON.stringify(secrets.nonObject),
    }),
  );
  // The off switch drains a content-bearing post; off must also mean unlogged.
  const offHandle = createHandler({
    registry,
    maxBodyBytes: 1024,
    log: logger,
    mirror: { enabled: false, maxBytes: 200, deliver },
  });
  await call(
    offHandle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: JSON.stringify({ prompt: secrets.mirrorOff }),
    }),
  );
  // A stream that dies mid-read throws out of the body loop into the route's outer catch, and the
  // error message can quote body text; the catch must discard it unread.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: `{ "prompt": "`,
      streamError: `connection burst while carrying: ${secrets.streamError}`,
    }),
  );
  await settled();

  const captured = lines.join("\n");
  for (const [name, secret] of Object.entries(secrets)) {
    assert.ok(!captured.includes(secret), `${name} content leaked into the log: ${captured}`);
  }
  // The logger was demonstrably live: the drop and failure paths above do write content-free
  // refusal lines, so an empty capture would mean the logger was unplugged, not that nothing
  // leaked.
  assert.ok(lines.length > 0, "expected content-free refusal lines to prove the logger was live");
});

test("payload fields that are not strings are ignored rather than stored", () => {
  const parsed = parseIntake(
    fakeRequest("127.0.0.1", { headers: hookHeaders("PostToolUse") }),
    JSON.stringify({ tool_name: { evil: true }, source: 7 }),
  );

  assert.ok("intake" in parsed);
  assert.equal(parsed.intake.toolName, null);
  assert.equal(parsed.intake.source, null);
});

test("control characters are stripped and long fields are capped", () => {
  const parsed = parseIntake(
    fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart") }),
    JSON.stringify({ session_id: "a".repeat(400), source: "start\u001b[31mup\u0000" }),
  );

  assert.ok("intake" in parsed);
  assert.equal(parsed.intake.sessionId?.length, 256);
  assert.equal(parsed.intake.source, "start[31mup");
});

test("isAllowedHost accepts only the loopback names", () => {
  for (const host of [
    "127.0.0.1",
    "127.0.0.1:8787",
    "localhost",
    "localhost:8787",
    "[::1]",
    "[::1]:8787",
    "  LOCALHOST:8787  ",
    // The port is not compared against the listening port: a page can only name a port it reached,
    // so the port carries no signal and the hostname carries all of it.
    "127.0.0.1:65535",
  ]) {
    assert.equal(isAllowedHost(host), true, host);
  }

  for (const host of [
    // The rebinding shape: the socket peer really is 127.0.0.1, and only the Host header tells you
    // the page asked for someone else's name.
    "attacker.example",
    "attacker.example:8787",
    "127.0.0.1.attacker.example",
    "evil-127.0.0.1",
    "192.168.1.5:8787",
    "0.0.0.0:8787",
    "127.0.0.1:notaport",
    "",
    "   ",
    undefined,
    ["127.0.0.1", "attacker.example"],
  ]) {
    assert.equal(isAllowedHost(host), false, String(host));
  }
});

test("a rebinding request from a loopback socket is refused", async () => {
  // The peer address is genuinely loopback here, which is exactly the case isLoopback cannot catch.
  const { registry, handle } = harness();

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart", { host: "attacker.example:8787" }),
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    }),
  );

  assert.equal(result.status, 403);
  assert.deepEqual(registry.list(), [], "a rebound request must not create a session");
});

test("a request with no Host header is refused", async () => {
  const { registry, handle } = harness();
  const request = fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart") });
  delete (request.headers as Record<string, unknown>).host;

  const result = await call(handle, request);

  assert.equal(result.status, 403);
  assert.deepEqual(registry.list(), []);
});

test("GET /sessions never publishes a process token", async () => {
  const { handle } = harness();
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    }),
  );

  const listed = await call(handle, fakeRequest("127.0.0.1", { method: "GET", url: "/sessions" }));

  // Asserted on the serialized text, not on a field, so a record rendered wholesale by a later
  // section cannot slip the token back in.
  const serialized = JSON.stringify(listed.body);
  assert.ok(!serialized.includes(TOKEN), serialized);
  assert.ok(!serialized.includes("processToken"), serialized);
  assert.equal((listed.body as { sessions: { sessionId: string }[] }).sessions[0].sessionId, "session-a");
});

/** A GET with an arbitrary Host header, which fetch refuses to send. */
function rawGet(
  port: number,
  route: string,
  host: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: route, method: "GET", headers: { host } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

// One end-to-end pass over a real bound socket, because the handler tests above never exercise
// listening, routing off a real request line, or the JSON actually put on the wire.
test("the broker serves a real request on a bound loopback port", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-broker-"));
  const broker = await startBroker(brokerConfig({ stateFile: path.join(dir, "broker-state.json") }));

  try {
    const base = `http://127.0.0.1:${broker.port}`;

    const announced = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("SessionStart") },
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    assert.equal(announced.status, 200);

    const tooled = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("PostToolUse") },
      body: JSON.stringify({ tool_name: "Bash", duration_ms: 12 }),
    });
    assert.equal(tooled.status, 200);

    const listed = await fetch(`${base}/sessions`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { sessions: { lastTool: string; toolCount: number }[] };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].lastTool, "Bash");
    assert.equal(body.sessions[0].toolCount, 1);

    // Over the cap on a real socket, where refusing mid-stream could have reset the connection
    // before the response was written.
    const oversized = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("PostToolUse") },
      body: JSON.stringify({ tool_name: "Bash", padding: "x".repeat(128 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    // A whole turn's reply to the mirror route on a real socket, well past the same cap. The fake
    // request in the unit tests above cannot show this: only a real connection proves the drained
    // body neither stalls the response nor leaves the socket unusable for what follows it.
    const mirrored = await fetch(`${base}/mirror`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("Stop") },
      body: JSON.stringify({ last_assistant_message: "x".repeat(256 * 1024) }),
    });
    assert.equal(mirrored.status, 202);
    assert.deepEqual(await mirrored.json(), { ignored: true });

    const afterMirror = await fetch(`${base}/sessions`);
    assert.equal(afterMirror.status, 200, "the connection must still serve the next request");

    // The rebinding shape on a real connection, where the Host header is the only thing that
    // differs from a legitimate request. Sent over node:http because fetch treats Host as a
    // forbidden header and would silently send the real one.
    const rebound = await rawGet(broker.port, "/sessions", "attacker.example");
    assert.equal(rebound.status, 403);

    const honest = await rawGet(broker.port, "/sessions", `127.0.0.1:${broker.port}`);
    assert.equal(honest.status, 200);
    assert.ok(!honest.text.includes(TOKEN), honest.text);
  } finally {
    await broker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry write that fails leaves the broker serving", async () => {
  // The state path's parent is a file, so every save throws. An unhandled throw here would be an
  // uncaught exception on the sweep interval and would end the daemon.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-unwritable-"));
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "", "utf8");

  const broker = await startBroker(brokerConfig({ stateFile: path.join(blocker, "broker-state.json") }));

  try {
    const base = `http://127.0.0.1:${broker.port}`;
    const announced = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("SessionStart") },
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    assert.equal(announced.status, 200, "the session is still registered in memory");

    const listed = await fetch(`${base}/sessions`);
    assert.equal(listed.status, 200);
    assert.equal(((await listed.json()) as { sessions: unknown[] }).sessions.length, 1);
  } finally {
    await broker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
