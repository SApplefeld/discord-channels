// Behavioral cover for hooks/session-start.ps1's one load-bearing promise: it exits zero, silently,
// and quickly no matter what the broker does. Every other test in this directory reads the hook
// declarations as data; these run the script.
//
// Two failure modes are worth the cost of spawning a real PowerShell. A broker that is *down* is
// cheap and obvious (a refused loopback connection returns immediately). A broker that accepts the
// connection and then never answers is the expensive one, and it is reachable: Chapter 2 records
// that the broker writes its state file synchronously on every hook event with no coalescing. If
// this script blocks there, every session on the fleet pays it at startup.
//
// The script hardcodes the broker port on purpose, so these tests run a copy with that one literal
// rewritten rather than adding a test-only override to production code. The copy also proves the
// literal is where settings-fragment.test.ts's pin says it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_START_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-start.ps1");

/** The declared -TimeoutSec in the script, plus room for PowerShell startup. */
const GENEROUS_CEILING_MS = 9_000;

const PAYLOAD = JSON.stringify({
  session_id: "11111111-2222-3333-4444-555555555555",
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: "D:\\somewhere",
});

/** Writes a copy of the hook script that targets `port`, and returns its path. */
function scriptTargeting(port: number, directory: string): string {
  const source = readFileSync(SESSION_START_PATH, "utf8");
  const rewritten = source.replace(/^(\s*\$brokerPort\s*=\s*)\d+\s*$/m, `$1${port}`);
  assert.notEqual(rewritten, source, "the $brokerPort literal was not found to rewrite");
  const target = path.join(directory, "session-start.ps1");
  writeFileSync(target, rewritten, "utf8");
  return target;
}

type Run = { status: number | null; stdout: string; stderr: string; elapsedMs: number };

function runHook(scriptPath: string, env: Record<string, string>): Run {
  const started = process.hrtime.bigint();
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { input: PAYLOAD, encoding: "utf8", env: { ...process.env, ...env } },
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", elapsedMs };
}

/** A port with nothing listening: bound to learn a free number, then released. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A listener that accepts connections and never writes a byte back. */
async function hungListener(): Promise<{ port: number; connections: number; close: () => Promise<void> }> {
  const sockets: net.Socket[] = [];
  const state = { connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.push(socket);
    // Deliberately no response, ever.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    get connections() {
      return state.connections;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as { port: number; connections: number; close: () => Promise<void> };
}

test("exits zero and silently when the broker is not running at all", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "channels-hook-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const run = runHook(scriptTargeting(await deadPort(), directory), {
    CHANNEL_PROCESS_TOKEN: "99999999-9999-9999-9999-999999999999",
    CHANNEL_SESSION: "dead-broker",
  });

  assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr: ${run.stderr}`);
  assert.equal(run.stdout, "", "stdout is injected into the session's context and must stay empty");
  assert.ok(run.elapsedMs < GENEROUS_CEILING_MS, `took ${Math.round(run.elapsedMs)}ms`);
});

test("exits zero and quickly when the broker accepts the connection and never answers", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "channels-hook-"));
  const listener = await hungListener();
  t.after(async () => {
    await listener.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const run = runHook(scriptTargeting(listener.port, directory), {
    CHANNEL_PROCESS_TOKEN: "99999999-9999-9999-9999-999999999999",
    CHANNEL_SESSION: "hung-broker",
  });

  assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr: ${run.stderr}`);
  assert.equal(run.stdout, "", "stdout is injected into the session's context and must stay empty");
  // The point of the test: the script must bail on its own timeout well inside the hook's own,
  // rather than holding session startup open for as long as the broker stays silent.
  assert.ok(
    run.elapsedMs < GENEROUS_CEILING_MS,
    `a hung broker held session startup for ${Math.round(run.elapsedMs)}ms`,
  );
});

test("a session with no process token never contacts the broker", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "channels-hook-"));
  const listener = await hungListener();
  t.after(async () => {
    await listener.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // The fragment installs into the user-level settings file, so this hook runs for every Claude
  // Code session on the machine. The ones not launched through the wrapper are not being watched.
  const run = runHook(scriptTargeting(listener.port, directory), { CHANNEL_PROCESS_TOKEN: "" });

  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
  assert.equal(listener.connections, 0, "an unwatched session must not open a socket to the broker");
});
