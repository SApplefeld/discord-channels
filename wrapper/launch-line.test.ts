// The arguments Enter-ClaudeSession actually hands `claude`, captured by running the real function.
//
// The launch line is where a host's channel flag turns into a channel, and both ways it can be wrong
// are invisible from inside the session: an entry the flag cannot resolve loads no channel while the
// session starts, works, and reports its status, and a relay registered twice (once on the command
// line, once by the plugin carrying the same server) runs two relays against one session.
//
// `claude` itself is never started: the probe script defines a PowerShell function named `claude`
// before calling Enter-ClaudeSession, and PowerShell resolves a function ahead of an external
// executable. Assert-InstalledHookPath, Assert-InstalledMirrorSwitch, and
// Assert-HookScriptProtected are shadowed as no-ops for the same reason no-mirror.test.ts shadows
// them: none has a fixture seam reachable from Enter-ClaudeSession, so replacing them is the only
// way to drive the launch without touching real operator state or a real machine's ACLs.
// LOCALAPPDATA points at a temp directory so the generated registration is never written to the
// operator's own state directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.join(WRAPPER_DIR, "Enter-ClaudeSession.ps1");

/** How long a probe process gets before it is treated as hung rather than slow. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Runs Enter-ClaudeSession on a host carrying the given channel flag and returns the argument list
 * the shadowed `claude` was called with. The flag is written into the host table after the
 * dot-source, so the probe pins each route's launch line regardless of which flag any host's
 * table entry carries in the checkout.
 */
function launchArgs(directory: string, flag: string): { args: string[]; stateRoot: string } {
  const outPath = path.join(directory, `args-${flag.replace(/[^a-z]/g, "")}.txt`);
  const stateRoot = path.join(directory, "localappdata");
  const scriptPath = path.join(directory, `probe-${flag.replace(/[^a-z]/g, "")}.ps1`);

  const lines = [
    `. "${WRAPPER_PATH}"`,
    `$script:ChannelFlagByHost['NEO'] = '${flag}'`,
    `function Assert-InstalledHookPath { param([string]$SettingsPath) }`,
    `function Assert-InstalledMirrorSwitch { param([string]$SettingsPath) }`,
    `function Assert-HookScriptProtected { }`,
    `function claude {`,
    `    Set-Content -LiteralPath "${outPath}" -Value ($args -join [char]10) -NoNewline`,
    `}`,
    // A shadow that failed to install would launch the real interactive binary and hang the suite
    // with no diagnostic; this fails fast and distinctly instead.
    `if (-not (Get-Command claude -CommandType Function -ErrorAction SilentlyContinue)) {`,
    `    throw 'the claude shadow did not install; refusing to risk launching the real binary'`,
    `}`,
    `Enter-ClaudeSession -Name 'probe-session'`,
  ];
  writeFileSync(scriptPath, lines.join("\n"), "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CHANNEL_SESSION;
  delete env.CHANNEL_PROCESS_TOKEN;
  delete env.CHANNEL_SESSION_MIRROR;
  // Resolve-ChannelHost throws on a COMPUTERNAME outside its known set, which the machine running
  // this suite may or may not have; naming a known host keeps the probe independent of it.
  env.CHANNEL_HOST_NAME = "NEO";
  // Removed under every casing before the override lands, so the probe cannot write a registration
  // into the operator's real state root on a host whose inherited spelling differs.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "LOCALAPPDATA") delete env[key];
  }
  env.LOCALAPPDATA = stateRoot;

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", env, timeout: PROBE_TIMEOUT_MS },
  );
  assert.notEqual(
    result.signal,
    "SIGTERM",
    `PowerShell was killed after ${PROBE_TIMEOUT_MS}ms; the claude shadow likely did not intercept ` +
      "the launch and a real process hung",
  );
  assert.equal(result.status, 0, `PowerShell exited ${result.status}: ${result.stderr}`);
  return { args: readFileSync(outPath, "utf8").split("\n"), stateRoot };
}

test("a host on the development flag registers the relay and passes its server entry", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { args, stateRoot } = launchArgs(dir, "--dangerously-load-development-channels");
  const registration = path.join(stateRoot, "sapplefeld-channels", "relay-mcp.json");
  assert.deepEqual(args, [
    "--name",
    "probe-session",
    "--mcp-config",
    registration,
    "--dangerously-load-development-channels",
    "server:channel-relay",
  ]);
});

test("a host on the plain channel flag passes the plugin entry and no --mcp-config", (t) => {
  // The plugin carries the same server. Registering it on the command line as well would start a
  // second relay against the one session, so the entry travels alone.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { args } = launchArgs(dir, "--channels");
  assert.deepEqual(args, [
    "--name",
    "probe-session",
    "--channels",
    "plugin:relay@sapplefeld-channels",
  ]);
});

test("the relay registration is written on the plugin route too, since the shim reads it", (t) => {
  // plugins/relay/launch.mjs resolves the machine's live relay from this file. It is not passed to
  // `claude` on this route, and it still has to be on disk and current, or the plugin's channel
  // starts nothing.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { stateRoot } = launchArgs(dir, "--channels");
  const registration = path.join(stateRoot, "sapplefeld-channels", "relay-mcp.json");
  assert.ok(existsSync(registration), `expected the generated registration at ${registration}`);
  const config = JSON.parse(readFileSync(registration, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(Object.keys(config.mcpServers), ["channel-relay"]);
});
