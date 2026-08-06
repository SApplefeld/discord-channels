// The --mcp-config the wrapper writes for each launch, exercised by running the real function.
//
// This is the only thing that registers the relay, so every failure here is a session that starts,
// works, reports its status, and cannot be answered, with nothing anywhere saying why. It is also
// the one file in this project written at launch rather than installed, which is deliberate: it is
// derived from the wrapper's own location, so unlike the installed hook path it cannot come to name
// a checkout that has moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(WRAPPER_DIR);
const WRAPPER_PATH = path.join(WRAPPER_DIR, "Enter-ClaudeSession.ps1");

type McpConfig = { mcpServers: Record<string, { command: string; args: string[] }> };

/**
 * Dot-sources the wrapper and calls New-ChannelMcpConfig against a temp directory.
 *
 * Dot-sourcing is safe here and nothing launches: the file defines functions and a few script
 * variables at load, and Enter-ClaudeSession is never called. The directory is passed explicitly so
 * this never writes to the real %LOCALAPPDATA%.
 */
function writeConfig(directory: string): { path: string; config: McpConfig } {
  const script = path.join(directory, "probe.ps1");
  writeFileSync(
    script,
    [`. "${WRAPPER_PATH}"`, `New-ChannelMcpConfig -Directory "${directory}"`].join("\n"),
    "utf8",
  );
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `PowerShell exited ${result.status}: ${result.stderr}`);
  const written = result.stdout.trim();
  assert.ok(existsSync(written), `expected a config at ${written}`);
  return { path: written, config: JSON.parse(readFileSync(written, "utf8")) as McpConfig };
}

test("the wrapper writes a config registering this checkout's own relay", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { config } = writeConfig(dir);
  const keys = Object.keys(config.mcpServers);
  assert.deepEqual(keys.length, 1, "exactly one server, the relay");
  const server = config.mcpServers[keys[0]];
  assert.equal(server.command, "node");
  assert.deepEqual(
    server.args,
    [path.join(REPO_ROOT, "relay", "index.ts")],
    "the relay path must resolve to the checkout the wrapper is running from",
  );
});

test("the config is valid JSON with no byte order mark", (t) => {
  // Claude Code parses this file as JSON. PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM,
  // which is a parse error, and the failure would surface as a session with no channel rather than
  // as anything naming this file.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { path: written } = writeConfig(dir);
  const bytes = readFileSync(written);
  assert.notEqual(bytes[0], 0xef, "a byte order mark makes this unparseable to Claude Code");
  assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")));
});

test("rewriting the config leaves one file, not a new one per launch", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = writeConfig(dir);
  const second = writeConfig(dir);
  assert.equal(first.path, second.path);
  assert.deepEqual(first.config, second.config);
});
