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
  init: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const body = init.body ?? "";
  const request = {
    method: init.method ?? "POST",
    url: init.url ?? "/hook",
    // A real client always sends Host, and the handler now requires it, so the default stands in
    // for one. A test that cares about Host overrides it.
    headers: { host: "127.0.0.1:8787", ...(init.headers ?? {}) },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body, "utf8");
    },
  };
  return request as unknown as IncomingMessage;
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
    retainTerminalMs: 24 * 60 * 60 * 1000,
    maxSessions: 500,
    logFile: null,
    logMaxBytes: 5 * 1024 * 1024,
    logMaxFiles: 5,
    ...overrides,
  };
}

function harness(): { registry: Registry; handle: ReturnType<typeof createHandler> } {
  const registry = createRegistry({ host: "NEO", staleAfterMs: 60_000 });
  return { registry, handle: createHandler({ registry, maxBodyBytes: 1024 }) };
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
    { "x-channel-hook-event": "SessionStart" },
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
