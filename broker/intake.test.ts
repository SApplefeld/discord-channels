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
import type { AskedQuestion } from "./discord/render.ts";
import { createEchoMemory, createTranscriptTailer } from "./tail.ts";

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
    interimMirror: true,
    interimPollMs: 20_000,
    taskNotifications: "brief",
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
    toolInput: null,
    transcriptPath: null,
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

test("a subprocess SessionStart is dropped under its own reason, not the unroutable one", async () => {
  // A claude run as a subprocess inherits CHANNEL_PROCESS_TOKEN and announces a session of its own
  // under it. The registry declines it so the parent keeps the token, and both drops answer null,
  // so without its own line this expected traffic would be logged as a post that reached no
  // session and read as the parent's own registration silently failing.
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => lines.push(message), error: () => {} };
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    log: logger,
    mirror: fakeMirror().mirror,
  });
  announce(registry);
  // The pipe the wrapper starts with every session it launches, which is what marks the incumbent
  // as a real session rather than a record any process holding the token could have posted.
  registry.relaySeen(TOKEN);

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-subprocess", source: "startup" }),
    }),
  );

  assert.equal(result.status, 202);
  assert.equal(registry.list().length, 1, "nothing is registered for the subprocess");
  assert.equal(registry.current(TOKEN)?.sessionId, "session-a", "the parent keeps the token");
  const captured = lines.join("\n");
  assert.ok(captured.includes("SessionStart from a subprocess"), captured);
  assert.ok(captured.includes("session-subprocess"), captured);
  assert.ok(
    !captured.includes("no session holds this process token"),
    `the subprocess drop must not borrow the unroutable post's reason: ${captured}`,
  );
  assert.ok(!captured.includes(TOKEN), "the process token is never logged");
});

test("a refused takeover is logged under its own reason, not counted into a benign one", async () => {
  // The refusal docs/security-model.md names: a SessionStart carrying a session ID another process
  // token holds. It shares apply's null with the commonest benign drop, so on a shared reason
  // string an attacker could post a few unroutable events to open that reason's window and have its
  // takeover attempt counted into the suppressed tally instead of written down.
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => lines.push(message), error: () => {} };
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    log: logger,
    // A fixed clock, so nothing here can leave the rate limiter's window by elapsed time: what is
    // written is written because the reason is its own, not because a window closed.
    now: () => 1_000,
    mirror: fakeMirror().mirror,
  });
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-intake",
    sessionId: "session-a",
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
  });

  // The cover traffic first: unroutable posts under a token no session holds, which open the
  // ordinary drop reason's window and are counted from then on.
  for (let repeat = 0; repeat < 4; repeat += 1) {
    await call(
      handle,
      fakeRequest("127.0.0.1", {
        headers: { ...hookHeaders("PostToolUse"), "x-channel-process-token": "unknown-token" },
        body: JSON.stringify({ tool_name: "Bash" }),
      }),
    );
  }
  const beforeTakeover = lines.length;

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: {
        ...hookHeaders("SessionStart"),
        "x-channel-process-token": "22222222-2222-2222-2222-222222222222",
      },
      body: JSON.stringify({ session_id: "session-a", source: "startup" }),
    }),
  );

  assert.equal(result.status, 202);
  assert.equal(registry.list().length, 1, "the takeover creates nothing");
  assert.equal(registry.current(TOKEN)?.sessionId, "session-a", "the real session keeps its record");
  const captured = lines.slice(beforeTakeover).join("\n");
  assert.ok(
    captured.includes("naming a session another process token holds"),
    `the takeover must be written down even behind a run of ordinary drops: ${lines.join("\n")}`,
  );
  assert.ok(captured.includes("session-a"), captured);
  assert.ok(!captured.includes("subprocess"), captured);
  assert.ok(!lines.join("\n").includes(TOKEN), "the process token is never logged");
});

test("a post that reaches no session still names the unroutable reason", async () => {
  // The other side of the check above: the subprocess line must not swallow the drop that reports
  // a tool post from a token no session holds, which is where forged and replayed hook traffic
  // lands.
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => lines.push(message), error: () => {} };
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    log: logger,
    mirror: fakeMirror().mirror,
  });

  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PostToolUse"),
      body: JSON.stringify({ tool_name: "Bash" }),
    }),
  );

  assert.equal(result.status, 202);
  const captured = lines.join("\n");
  assert.ok(captured.includes("no session holds this process token"), captured);
  assert.ok(!captured.includes("subprocess"), captured);
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

test("a body at the /hook cap is read; one byte over is drained and dropped, never parsed", async () => {
  // The Stop payload carries the turn's final assistant message, so the posts that reach this
  // ceiling are the liveness ticks at the end of exactly the longest turns, and a refusal there is
  // a visible error inside that session. Over the cap the post is dropped with the same 2xx every
  // other drop on this route answers, and nothing over the cap is assembled or parsed.
  const body = JSON.stringify({ session_id: "session-a", source: "startup" });
  const exact = Buffer.byteLength(body);
  const request = (): IncomingMessage =>
    fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart"), body });

  const atCap = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const accepted = await call(
    createHandler({ registry: atCap, maxBodyBytes: exact, mirror: fakeMirror().mirror }),
    request(),
  );
  assert.equal(accepted.status, 200, "a body exactly at the cap is inside it");
  assert.equal(atCap.list().length, 1);

  const overCap = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const dropped = await call(
    createHandler({ registry: overCap, maxBodyBytes: exact - 1, mirror: fakeMirror().mirror }),
    request(),
  );
  assert.equal(dropped.status, 202, "over the cap is a drop with a 2xx, never a 413");
  assert.deepEqual(dropped.body, { ignored: true });
  assert.deepEqual(overCap.list(), [], "an oversized body reaches nothing that could store it");
});

test("an oversized /hook post is logged by its size, with nothing of its body", async () => {
  const lines: string[] = [];
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 32,
    log: {
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    },
    mirror: fakeMirror().mirror,
  });

  const secret = "SECRET-the-longest-turn-of-the-day";
  const result = await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("Stop"),
      body: JSON.stringify({ session_id: "session-a", last_assistant_message: secret }),
    }),
  );

  assert.equal(result.status, 202);
  const captured = lines.join("\n");
  assert.ok(captured.includes("over the size cap"), captured);
  assert.ok(/\d+ bytes/.test(captured), captured);
  assert.ok(!captured.includes(secret), `hook content leaked into the log: ${captured}`);
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

test("a per-session X-Channel-Mirror off value stops that post, unread, without touching the host-wide switch", async () => {
  // wrapper/Enter-ClaudeSession.ps1's -NoMirror sets CHANNEL_SESSION_MIRROR in one session's own
  // environment; the mirror hooks forward it as this header. options.mirror.enabled here stays
  // true throughout, so this is the header alone doing the work, not the config knob's off path
  // this file already covers above.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  for (const value of ["off", "0", "false", "no", "OFF", " off "]) {
    const request = fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": value }),
      body: JSON.stringify({ prompt: "sensitive work" }),
    });
    const result = await call(handle, request);
    await settled();

    assert.equal(result.status, 202, `off value ${JSON.stringify(value)} must stay quiet, never refuse`);
    assert.equal(request.bodyConsumed, false, `off value ${JSON.stringify(value)} must drain the body unread`);
  }
  assert.deepEqual(deliveries, [], "no off value may deliver anything");
});

test("an absent X-Channel-Mirror header, and an unrecognized value, both mirror normally", async () => {
  // The vast majority of sessions never set CHANNEL_SESSION_MIRROR, so absence is the steady state and
  // must never be read as off; that would silently disable the feature for every session on the
  // host. An unrecognized spelling also falls through rather than refusing the post: this header
  // arrives per request from a session's own environment, and the only way to refuse a request is
  // a non-2xx, which Claude Code surfaces as a visible error inside that session.
  const { mirror, deliveries } = fakeMirror();
  const { registry, handle } = harness(mirror);
  announce(registry);

  const cases: Array<{ label: string; headers: Record<string, string> }> = [
    { label: "absent", headers: hookHeaders("UserPromptSubmit") },
    { label: "on", headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": "on" }) },
    { label: "unrecognized", headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": "maybe" }) },
  ];
  for (const { label, headers } of cases) {
    const request = fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers,
      body: JSON.stringify({ prompt: `delivered despite ${label}` }),
    });
    const result = await call(handle, request);
    await settled();
    assert.equal(result.status, 202, label);
  }

  assert.deepEqual(
    deliveries.map((delivery) => delivery.text),
    ["delivered despite absent", "delivered despite on", "delivered despite unrecognized"],
    "an absent header, an on value, and an unrecognized value must all deliver",
  );
});

test("a per-session suppression is logged with the session id, never content", async () => {
  // Without this line, a session the operator suppressed with -NoMirror and a mirror that has
  // silently broken both read as total silence in the log, with no way to tell them apart. The line
  // is static and names the session; it must never carry the prompt or reply text.
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => lines.push(message), error: () => {} };
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { mirror, deliveries } = fakeMirror();
  const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger, mirror });
  registry.apply({
    event: "SessionStart",
    processToken: TOKEN,
    sessionName: "neo-intake",
    sessionId: "session-suppressed",
    source: "startup",
    toolName: null,
    toolInput: null,
    transcriptPath: null,
  });

  const secret = "SECRET-suppressed-prompt";
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": "off" }),
      body: JSON.stringify({ prompt: secret }),
    }),
  );
  await settled();

  const captured = lines.join("\n");
  assert.ok(!captured.includes(secret), "the suppression line must not carry mirror content");
  assert.ok(captured.includes("session-suppressed"), "the suppression line must name the session");
  assert.deepEqual(deliveries, []);
});

test("an off header on a forged or unrecognized token still produces the unknown-token refusal", async () => {
  // The header check runs after the token and registry checks specifically so this case is still
  // visible: an off value alongside a token no live session holds must not take the same quiet path
  // a legitimate per-session suppression gets, or the one record of forged mirror traffic disappears.
  const lines: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => lines.push(message), error: () => {} };
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { mirror, deliveries } = fakeMirror();
  const handle = createHandler({ registry, maxBodyBytes: 1024, log: logger, mirror });

  const request = fakeRequest("127.0.0.1", {
    url: "/mirror",
    headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": "off" }),
    body: JSON.stringify({ prompt: "a forged post carrying the off header too" }),
  });
  const result = await call(handle, request);
  await settled();

  assert.equal(result.status, 202);
  assert.deepEqual(deliveries, []);
  assert.ok(
    lines.some((line) => line.includes("no live session holds this process token")),
    "the unknown-token refusal must still fire even when the post also carries the off header",
  );
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

test("a tool input is previewed from the first previewable key it carries", () => {
  const preview = (toolInput: unknown): string | null => {
    const parsed = parseIntake(
      fakeRequest("127.0.0.1", { headers: hookHeaders("PostToolUse") }),
      JSON.stringify({ tool_name: "Bash", tool_input: toolInput }),
    );
    assert.ok("intake" in parsed);
    return parsed.intake.toolInput;
  };

  assert.equal(preview({ command: "npm test" }), "npm test");
  // The probe stops at the first key it matches, so a tool whose input carries both a path and the
  // file's whole contents previews the path. `content` is on no probe list at any position.
  assert.equal(preview({ file_path: "D:\\x\\y.ts", content: "x".repeat(5_000) }), "D:\\x\\y.ts");
  assert.equal(preview({ file_path: "D:\\x\\y.ts", command: "npm test" }), "npm test");
  assert.equal(preview({ prompt: "find the caller" }), "find the caller");
  // A key whose value is empty once cleaned is not a preview, so the probe goes on to the next key
  // rather than stopping at it and reporting nothing.
  assert.equal(preview({ command: "   ", file_path: "D:\\x\\y.ts" }), "D:\\x\\y.ts");
  // The order runs from what identifies a call most precisely to what identifies it least, so a
  // tool carrying both a path and a sentence about what it is doing previews the path.
  assert.equal(preview({ description: "reads a file", path: "D:\\x\\y.ts" }), "D:\\x\\y.ts");
});

test("a tool input with nothing previewable in it previews nothing", () => {
  const preview = (body: string): string | null => {
    const parsed = parseIntake(
      fakeRequest("127.0.0.1", { headers: hookHeaders("PostToolUse") }),
      body,
    );
    assert.ok("intake" in parsed);
    return parsed.intake.toolInput;
  };

  // Absent, not an object, and an object carrying none of the probed keys. The nested and
  // array-valued cases are what keeps an unbounded structure out of a field the card renders.
  assert.equal(preview(JSON.stringify({ tool_name: "Bash" })), null);
  assert.equal(preview(JSON.stringify({ tool_input: "a bare string" })), null);
  assert.equal(preview(JSON.stringify({ tool_input: ["command", "npm test"] })), null);
  assert.equal(preview(JSON.stringify({ tool_input: { todos: [{ command: "npm test" }] } })), null);
  assert.equal(preview(JSON.stringify({ tool_input: { command: { nested: "npm test" } } })), null);
  assert.equal(preview(JSON.stringify({ tool_input: { offset: 12, limit: 40 } })), null);
  // tool_response is dropped whole: nothing reads it, whatever it carries.
  assert.equal(preview(JSON.stringify({ tool_response: { command: "npm test" } })), null);
});

test("a previewed tool input is normalized like every other payload string", () => {
  const parsed = parseIntake(
    fakeRequest("127.0.0.1", { headers: hookHeaders("PostToolUse") }),
    JSON.stringify({ tool_input: { command: `git log\u001b[31m ${"x".repeat(400)}` } }),
  );

  assert.ok("intake" in parsed);
  assert.equal(parsed.intake.toolInput?.length, 256);
  assert.ok(!parsed.intake.toolInput?.includes("\u001b"), parsed.intake.toolInput ?? "");
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
      body: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git status --porcelain" },
        duration_ms: 12,
      }),
    });
    assert.equal(tooled.status, 200);

    const listed = await fetch(`${base}/sessions`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      sessions: { lastTool: string; lastToolInput: string; toolCount: number }[];
    };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].lastTool, "Bash");
    // Published beside the tool name: it is already-neutralized, already-capped tool metadata of
    // the same class. The process token, which is what a hook post is authenticated by, is not.
    assert.equal(body.sessions[0].lastToolInput, "git status --porcelain");
    assert.ok(!JSON.stringify(body).includes(TOKEN), "the forgery key stays withheld");
    assert.equal(body.sessions[0].toolCount, 1);

    // Over the cap on a real socket, where draining mid-stream could have reset the connection
    // before the response was written.
    const oversized = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hookHeaders("PostToolUse") },
      body: JSON.stringify({ tool_name: "Bash", padding: "x".repeat(128 * 1024) }),
    });
    assert.equal(oversized.status, 202, "an oversized liveness post is drained and dropped, not refused");
    assert.deepEqual(await oversized.json(), { ignored: true });

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

test("transcript_path rides the intake as a cleaned string, and anything else as null", () => {
  const parsed = parseIntake(
    fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart") }),
    JSON.stringify({ session_id: "session-a", transcript_path: "C:\\t\\session-a.jsonl\u0000" }),
  );
  assert.ok("intake" in parsed);
  assert.equal(parsed.intake.transcriptPath, "C:\\t\\session-a.jsonl");

  const nonString = parseIntake(
    fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart") }),
    JSON.stringify({ session_id: "session-a", transcript_path: { evil: true } }),
  );
  assert.ok("intake" in nonString);
  assert.equal(nonString.intake.transcriptPath, null);
});

test("the tailer learns a path only from a hook post the registry credited", async () => {
  // An unwatched, forged, or unroutable post must not aim the tailer at a file of its choosing
  // under a session it does not hold: the read happens with the broker's own permissions, and the
  // path names which file's contents end up in the operator's thread.
  const learned: Array<{ sessionId: string; path: string }> = [];
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    mirror: fakeMirror().mirror,
    tail: {
      learn: (sessionId, path) => learned.push({ sessionId, path }),
      allow: () => {},
      suppress: () => {},
      question: () => {},
    },
  });

  // Tokenless (unwatched) and unroutable posts both carry a path and teach nothing.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: { "x-channel-hook-event": "SessionStart" },
      body: JSON.stringify({ session_id: "session-x", source: "startup", transcript_path: "C:\\forged.jsonl" }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PostToolUse"),
      body: JSON.stringify({ session_id: "session-a", tool_name: "Bash", transcript_path: "C:\\forged.jsonl" }),
    }),
  );
  assert.deepEqual(learned, [], "an uncredited post must teach the tailer nothing");

  // A credited announce teaches it, and every later credited post re-teaches it, which is what
  // re-arms the tailer after a broker restart mid-session.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("SessionStart"),
      body: JSON.stringify({ session_id: "session-a", source: "startup", transcript_path: "C:\\t\\a.jsonl" }),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PostToolUse"),
      body: JSON.stringify({ session_id: "session-a", tool_name: "Bash", transcript_path: "C:\\t\\a.jsonl" }),
    }),
  );
  assert.deepEqual(learned, [
    { sessionId: "session-a", path: "C:\\t\\a.jsonl" },
    { sessionId: "session-a", path: "C:\\t\\a.jsonl" },
  ]);
});

test("every mirror post reaching a live session reports its verdict: allow on, suppress off", async () => {
  // The tailer fails closed, so the affirmative half of the signal matters as much as the off
  // half: a session narrates only after an explicit allow, and the allow rides every ordinary
  // mirror post from a live session. UserPromptSubmit fires at the start of every turn, so both
  // verdicts land before that turn can produce any interim text. An anonymous or forged request
  // reports neither: it cannot switch a session's narration in either direction.
  const allowed: string[] = [];
  const suppressed: string[] = [];
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const { mirror, deliveries } = fakeMirror();
  const handle = createHandler({
    registry,
    maxBodyBytes: 1024,
    mirror,
    tail: {
      learn: () => {},
      allow: (sessionId) => allowed.push(sessionId),
      suppress: (sessionId) => suppressed.push(sessionId),
      question: () => {},
    },
  });
  announce(registry);

  // A normal mirror post naming its own session is the allow.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit"),
      body: JSON.stringify({ session_id: "session-a", prompt: "mirrored normally" }),
    }),
  );
  assert.deepEqual(allowed, ["session-a"]);
  assert.deepEqual(suppressed, []);

  // A post under the right token that names another session, or names none, is a subprocess of
  // this session mirroring a conversation of its own: the same traffic the router's straggler gate
  // refuses to post. It is not this session's verdict to give, so it arms nothing. Permission
  // needs the stronger evidence; suppression below does not, because failing closed on weak
  // evidence costs narration rather than privacy.
  for (const body of [
    JSON.stringify({ session_id: "another-session", prompt: "a subprocess conversation" }),
    JSON.stringify({ prompt: "naming no session at all" }),
  ]) {
    await call(
      handle,
      fakeRequest("127.0.0.1", {
        url: "/mirror",
        headers: hookHeaders("UserPromptSubmit"),
        body,
      }),
    );
    assert.deepEqual(allowed, ["session-a"], `an unattributable post must not arm: ${body}`);
  }
  assert.deepEqual(suppressed, []);

  // The off header under a token no live session holds reaches the unknown-token drop first and
  // reports nothing in either direction.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: {
        ...hookHeaders("UserPromptSubmit", { "x-channel-mirror": "off" }),
        "x-channel-process-token": "not-the-announced-token",
      },
      body: JSON.stringify({ prompt: "forged" }),
    }),
  );
  assert.deepEqual(allowed, ["session-a"]);
  assert.deepEqual(suppressed, []);

  await call(
    handle,
    fakeRequest("127.0.0.1", {
      url: "/mirror",
      headers: hookHeaders("UserPromptSubmit", { "x-channel-mirror": "off" }),
      body: JSON.stringify({ session_id: "session-a", prompt: "suppressed" }),
    }),
  );
  await settled();
  assert.deepEqual(suppressed, ["session-a"]);
  assert.deepEqual(allowed, ["session-a"], "the off post must not also report an allow");
  // Every post that named a session is still handed to the routing layer, including the two that
  // armed nothing: this intake decides the tailer's verdict, and the straggler gate that refuses to
  // post another session's conversation is the router's, which is where this fake stops.
  assert.deepEqual(deliveries.map((delivery) => delivery.text), [
    "mirrored normally",
    "a subprocess conversation",
    "naming no session at all",
  ]);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.sessionId),
    ["session-a", "another-session", null],
    "the router is handed the session each post named, which is what it drops a straggler on",
  );
});

/**
 * The tool_input of the live-captured PreToolUse payload, verbatim in shape: one question, four
 * options with descriptions, no multi-select. The tests below drive the /hook route with it.
 */
function capturedQuestionInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "Test question: which beverage should power this morning's session?",
        header: "Beverage",
        options: [
          { label: "Coffee (Recommended)", description: "The classic. Reliable caffeine delivery." },
          { label: "Tea", description: "Gentler ramp-up, wide variety, lower jitter risk." },
          { label: "Water", description: "Hydration-first strategy. Zero caffeine, zero regrets." },
          { label: "Energy drink", description: "Maximum throughput now, possible crash later." },
        ],
        multiSelect: false,
      },
    ],
  };
}

/** The captured PreToolUse body, with any field replaceable, aimed at the announced session. */
function preToolUseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-a",
    transcript_path: "C:\\t\\session-a.jsonl",
    cwd: "C:\\Users\\LocalAdmin",
    prompt_id: "0ed14699-70a8-42ce-b274-5230a1c0700b",
    permission_mode: "bypassPermissions",
    effort: { level: "high" },
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: capturedQuestionInput(),
    tool_use_id: "toolu_01GWPED2HfgzZBLVxgmWY5bC",
    ...overrides,
  });
}

/** A handler over the tailer seam, capturing what the question path and its neighbors report. */
function questionHarness(): {
  handle: ReturnType<typeof createHandler>;
  registry: Registry;
  asked: Array<{ sessionId: string; questions: readonly AskedQuestion[] }>;
  suppressed: string[];
  learned: string[];
  lines: string[];
} {
  const asked: Array<{ sessionId: string; questions: readonly AskedQuestion[] }> = [];
  const suppressed: string[] = [];
  const learned: string[] = [];
  const lines: string[] = [];
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  const handle = createHandler({
    registry,
    maxBodyBytes: 64 * 1024,
    log: {
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    },
    mirror: fakeMirror().mirror,
    tail: {
      learn: (_sessionId, path) => learned.push(path),
      allow: () => {},
      suppress: (sessionId) => suppressed.push(sessionId),
      question: (sessionId, questions) => asked.push({ sessionId, questions }),
    },
  });
  announce(registry);
  return { handle, registry, asked, suppressed, learned, lines };
}

test("a credited PreToolUse AskUserQuestion post hands the tailer its bounded questions at emission", async () => {
  // The emission-time path: the transcript line for an open question is withheld until it is
  // answered, so this post is the only signal that exists while the picker is open. The intake
  // parses tool_input with the tailer's own bounded reader and hands the result to the tailer,
  // which owns the verdict gate and the delivery seam.
  const { handle, asked, learned } = questionHarness();

  const { status } = await call(
    handle,
    fakeRequest("127.0.0.1", { headers: hookHeaders("PreToolUse"), body: preToolUseBody() }),
  );
  assert.equal(status, 200, "the liveness answer PostToolUse gets");
  assert.deepEqual(asked, [
    {
      sessionId: "session-a",
      questions: [
        {
          question: "Test question: which beverage should power this morning's session?",
          header: "Beverage",
          multiSelect: false,
          options: ["Coffee (Recommended)", "Tea", "Water", "Energy drink"],
        },
      ],
    },
  ]);
  assert.deepEqual(learned, ["C:\\t\\session-a.jsonl"], "PreToolUse teaches the path as PostToolUse does");
});

test("only a credited PreToolUse AskUserQuestion reaches the question seam; everything near it is silent", async () => {
  // The negative space around the one shape that alerts: a tokenless post, the answer-time
  // PostToolUse for the same tool, another tool under PreToolUse, and every malformed tool_input.
  // Silence on all of them, and no log line carries a fragment of any question.
  const { handle, asked, lines } = questionHarness();

  // Tokenless: unwatched traffic, dropped before any parse of the tool input matters.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: { "x-channel-hook-event": "PreToolUse" },
      body: preToolUseBody(),
    }),
  );

  // The answer-time PostToolUse carries the same questions plus the answers; alerting on it would
  // recreate the resolution-time ping the emission path exists to replace.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PostToolUse"),
      body: preToolUseBody({ hook_event_name: "PostToolUse" }),
    }),
  );

  // Another tool under PreToolUse: the matcher should prevent this, but the intake must not trust
  // the matcher.
  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PreToolUse"),
      body: preToolUseBody({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
    }),
  );

  // Malformed tool_input in every shape askedQuestions refuses: silence, never a throw.
  for (const toolInput of [
    undefined,
    "SECRET-a-bare-string",
    ["SECRET-in-an-array"],
    { questions: "SECRET-not-an-array" },
    { questions: [{ header: "SECRET-no-question-field" }] },
    { questions: [{ question: "\u200b\u200b" }] },
  ]) {
    const { status } = await call(
      handle,
      fakeRequest("127.0.0.1", {
        headers: hookHeaders("PreToolUse"),
        body: preToolUseBody({ tool_input: toolInput }),
      }),
    );
    assert.equal(status, 200, "a malformed input is still a credited liveness post");
  }

  assert.deepEqual(asked, [], "none of these may reach the question seam");
  assert.ok(!lines.join("\n").includes("SECRET"), `no fragment of a question reaches the log: ${lines.join("\n")}`);
  assert.ok(!lines.join("\n").includes("beverage"), lines.join("\n"));
});

test("a PreToolUse post carrying the session's mirror-off switch suppresses instead of asking", async () => {
  // The question hook carries X-Channel-Mirror because its payload is conversation text: a
  // -NoMirror session's post must land on silence, and it doubles as the same suppress signal the
  // mirror route records. An absent or unrecognized value changes nothing, exactly as /mirror
  // reads the header.
  const { handle, asked, suppressed } = questionHarness();

  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PreToolUse", { "x-channel-mirror": "0" }),
      body: preToolUseBody(),
    }),
  );
  assert.deepEqual(asked, [], "a mirror-off post never reaches the question seam");
  assert.deepEqual(suppressed, ["session-a"]);

  await call(
    handle,
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PreToolUse", { "x-channel-mirror": "unrecognized-spelling" }),
      body: preToolUseBody(),
    }),
  );
  await call(
    handle,
    fakeRequest("127.0.0.1", { headers: hookHeaders("PreToolUse"), body: preToolUseBody() }),
  );
  assert.equal(asked.length, 2, "an unrecognized value and an absent header both ask normally");
  assert.deepEqual(suppressed, ["session-a"], "only the recognized off vocabulary suppresses");
});

test("a PreToolUse post re-arms the verdict after a restart: on and absent alert, off stays silent", async () => {
  // The parked-session restart, the exact case the emission alert exists for: the broker comes
  // back with a fresh tailer holding no verdict, the session is sitting on an open picker, and
  // no /mirror post will arrive because a parked session produces neither a prompt nor a turn
  // end. The question post itself must carry the verdict, both halves read as /mirror reads the
  // same header: a non-off value, the absent header included, is the session mirroring normally
  // and records the allow; the recognized off vocabulary suppresses. Driven against the real
  // tailer, fresh per case, so what is proved is the re-arm and not a mock's bookkeeping.
  const delivered: string[][] = [];
  function restartedBroker(): ReturnType<typeof createHandler> {
    const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
    const tailer = createTranscriptTailer({
      liveSessions: () => ["session-a"],
      deliver: async () => ({ status: "sent" }),
      deliverPrompt: async () => ({ status: "sent" }),
      deliverQuestion: async (_sessionId, questions) => {
        delivered.push(questions.map((entry) => entry.question));
        return { status: "sent" };
      },
      echo: createEchoMemory(),
    });
    const handle = createHandler({
      registry,
      maxBodyBytes: 64 * 1024,
      mirror: fakeMirror().mirror,
      tail: {
        learn: tailer.learn,
        allow: tailer.allow,
        suppress: tailer.suppress,
        question: tailer.question,
      },
    });
    announce(registry);
    return handle;
  }

  await call(
    restartedBroker(),
    fakeRequest("127.0.0.1", { headers: hookHeaders("PreToolUse"), body: preToolUseBody() }),
  );
  await settled();
  assert.equal(delivered.length, 1, "the absent-header form must re-arm the verdict and alert");

  await call(
    restartedBroker(),
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PreToolUse", { "x-channel-mirror": "on" }),
      body: preToolUseBody(),
    }),
  );
  await settled();
  assert.equal(delivered.length, 2, "an explicit non-off value is mirroring normally too");

  await call(
    restartedBroker(),
    fakeRequest("127.0.0.1", {
      headers: hookHeaders("PreToolUse", { "x-channel-mirror": "0" }),
      body: preToolUseBody(),
    }),
  );
  await settled();
  assert.equal(delivered.length, 2, "the off form arms nothing and alerts nothing");
});

test("a transcript path is refused rather than truncated, and never a UNC path", () => {
  // A truncated path would never open, and the only witness would be a rate-limited pass-failed
  // line forever; a UNC path opened on Windows initiates an outbound SMB connection carrying the
  // operator's credentials. Both are refused whole, which the tailer experiences as no path
  // learned for that session: a legible failure instead of a quiet wrong one.
  const parse = (transcript_path: unknown): string | null => {
    const parsed = parseIntake(
      fakeRequest("127.0.0.1", { headers: hookHeaders("SessionStart") }),
      JSON.stringify({ session_id: "session-a", transcript_path }),
    );
    assert.ok("intake" in parsed);
    return parsed.intake.transcriptPath;
  };

  const deep = `C:\\${"a-deep-checkout\\".repeat(120)}transcript.jsonl`;
  assert.ok(deep.length > 1024);
  assert.equal(parse(deep), null, "an over-long path is refused whole, never cut to a wrong one");

  assert.equal(parse("\\\\host\\share\\x.jsonl"), null, "a UNC path is never opened");
  assert.equal(parse("//host/share/x.jsonl"), null, "the forward-slash UNC spelling is refused too");
  assert.equal(parse("..\\x.jsonl"), null, "a relative path is refused");
  assert.equal(parse("transcripts\\x.jsonl"), null);
  assert.equal(parse("C:x.jsonl"), null, "a drive-relative path is refused");

  assert.equal(parse("C:\\t\\a.jsonl"), "C:\\t\\a.jsonl");
  assert.equal(parse("C:/t/a.jsonl"), "C:/t/a.jsonl");
});
