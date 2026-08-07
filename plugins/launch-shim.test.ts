// The plugin's launch shim, exercised by running it as a real process, which is the only gate it
// has: it is plain JavaScript, so the type check never looks at it.
//
// Every run here points LOCALAPPDATA at a temp directory. The shim falls back to the home directory
// when that variable is unset, and on the operator's own machine that resolves to the live
// registration and would start the real relay on inherited stdio, inside the test suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.join(PLUGIN_DIR, "relay", "launch.mjs");

/** How long a shim run gets before it is treated as hung rather than slow. */
const RUN_TIMEOUT_MS = 30_000;

/** Writes a registration the shim will find, in the layout the wrapper writes it in. */
function writeRegistration(stateRoot: string, server: unknown): string {
  const dir = path.join(stateRoot, "sapplefeld-channels");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "relay-mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { "channel-relay": server } }), "utf8");
  return file;
}

function runShim(stateRoot: string): { status: number | null; stderr: string; signal: string | null } {
  const result = spawnSync(process.execPath, [SHIM_PATH], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    // Piped rather than inherited: the shim gives its child this process's own stdio, and a child
    // writing into the test runner's stream would land in the middle of the suite's output.
    stdio: ["ignore", "pipe", "pipe"],
    // The inherited variable is removed under every casing before the override lands: a plain
    // object happily holds LOCALAPPDATA and LocalAppData side by side, and if the inherited one won
    // inside the child, this test would read the operator's real registration and start the real
    // relay against the live broker in the middle of the suite.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "LOCALAPPDATA"),
      ),
      LOCALAPPDATA: stateRoot,
    },
  });
  assert.notEqual(result.signal, "SIGTERM", `the shim was killed after ${RUN_TIMEOUT_MS}ms`);
  return { status: result.status, stderr: result.stderr, signal: result.signal };
}

test("the shim starts the relay the machine's registration names", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const marker = path.join(dir, "child-ran.txt");
  writeRegistration(dir, {
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(process.argv[1], "ran");`, marker],
  });

  const { status } = runShim(dir);
  assert.equal(status, 0, "a clean child exit must come back as a clean shim exit");
  assert.ok(existsSync(marker), "the shim must run the command the registration names");
  assert.equal(readFileSync(marker, "utf8"), "ran");
});

test("the shim exits with the relay's own exit code", (t) => {
  // The channel's caller only ever sees this process. A relay that refused to start and a relay that
  // stopped cleanly have to stay distinguishable through it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeRegistration(dir, { command: process.execPath, args: ["-e", "process.exit(3)"] });

  assert.equal(runShim(dir).status, 3);
});

test("a missing registration exits non-zero and names the path it looked for", (t) => {
  // The failure this covers is a session that starts, announces itself, looks watched on its card,
  // and cannot be answered. One line on stderr at launch is the whole difference.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runShim(dir);
  assert.notEqual(status, 0, "a channel that cannot start must not exit clean");
  assert.match(stderr, /channel-relay plugin/);
  assert.ok(
    stderr.includes(path.join(dir, "sapplefeld-channels", "relay-mcp.json")),
    `the path it looked for must be in the message; got: ${stderr}`,
  );
});

test("a malformed registration exits non-zero and names the path", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateDir = path.join(dir, "sapplefeld-channels");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "relay-mcp.json"), "{ this is not json", "utf8");

  const { status, stderr } = runShim(dir);
  assert.notEqual(status, 0);
  assert.ok(stderr.includes(path.join(stateDir, "relay-mcp.json")), `got: ${stderr}`);
});

test("a registration without the relay's own entry exits non-zero", (t) => {
  // A file that parses is not a file that registers the relay. Reading a command off a shape this
  // did not check would spawn whatever happened to be there, or nothing, silently.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateDir = path.join(dir, "sapplefeld-channels");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "relay-mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");

  const { status, stderr } = runShim(dir);
  assert.notEqual(status, 0);
  assert.match(stderr, /channel-relay/);
});
