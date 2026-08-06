// Exercises the real Enter-ClaudeSession function to prove -NoMirror's per-session behavior: with
// the switch, the launched process's environment carries CHANNEL_SESSION_MIRROR set to an off value;
// without it, the environment carries nothing new. A second group of tests drives
// Assert-InstalledMirrorSwitch directly against a fixture settings file, proving -NoMirror throws
// rather than launching silently unmirrored-in-appearance-only when the installed mirror hooks
// predate the switch header.
//
// `claude` itself is never started: each probe script defines a PowerShell function named `claude`
// before calling Enter-ClaudeSession, and PowerShell's command resolution finds a function ahead of
// an external executable, so the wrapper's `& claude ...` call runs this stand-in and never launches
// a real session. Assert-InstalledHookPath, Assert-HookScriptProtected, and (in the env-var probe,
// where it is not the thing under test) Assert-InstalledMirrorSwitch are shadowed as no-ops the same
// way: none has a fixture-path override reachable from Enter-ClaudeSession's own call sites, so the
// only way to drive it here without touching real operator state or a real machine's ACLs is to
// replace them before they run. LOCALAPPDATA is pointed at a temp directory so
// New-ChannelMcpConfig's default write target (the operator's real state directory) is never touched
// either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_FALSE } from "../broker/config.ts";

const WRAPPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(WRAPPER_DIR);
const WRAPPER_PATH = path.join(WRAPPER_DIR, "Enter-ClaudeSession.ps1");
const SESSION_START_PATH = path.join(REPO_ROOT, "hooks", "session-start.ps1");

/** How long a probe process gets before it is treated as hung rather than slow. */
const PROBE_TIMEOUT_MS = 30_000;

/** Marks CHANNEL_SESSION_MIRROR absent, distinct from the empty string, which a bare $env: read cannot tell apart. */
const UNSET_MARKER = "(unset)";

/**
 * Runs Enter-ClaudeSession end to end in an isolated PowerShell process and returns whatever the
 * shadowed `claude` function observed CHANNEL_SESSION_MIRROR to be at the moment it was invoked.
 */
function probeMirrorEnv(directory: string, noMirror: boolean): string {
  const outPath = path.join(directory, `out-${noMirror}.txt`);
  const localAppData = path.join(directory, "localappdata");
  const scriptPath = path.join(directory, `probe-${noMirror}.ps1`);

  const lines = [
    `. "${WRAPPER_PATH}"`,
    // Overrides installed after the dot-source win: PowerShell resolves a function call dynamically
    // against the current scope's function table, not against whatever was in scope when the calling
    // function was defined, so Enter-ClaudeSession picks up these replacements the moment it calls
    // them, further down in this same script.
    `function Assert-InstalledHookPath { param([string]$SettingsPath) }`,
    `function Assert-InstalledMirrorSwitch { param([string]$SettingsPath) }`,
    `function Assert-HookScriptProtected { }`,
    `function claude {`,
    `    if (Test-Path Env:CHANNEL_SESSION_MIRROR) {`,
    `        Set-Content -LiteralPath "${outPath}" -Value $env:CHANNEL_SESSION_MIRROR -NoNewline`,
    `    } else {`,
    `        Set-Content -LiteralPath "${outPath}" -Value '${UNSET_MARKER}' -NoNewline`,
    `    }`,
    `}`,
    // A shadow that failed to install (a real claude.exe found ahead of the function, for instance)
    // would otherwise launch the real interactive binary and hang the suite with no diagnostic; this
    // fails fast and distinctly instead.
    `if (-not (Get-Command claude -CommandType Function -ErrorAction SilentlyContinue)) {`,
    `    throw 'the claude shadow did not install; refusing to risk launching the real binary'`,
    `}`,
    noMirror
      ? `Enter-ClaudeSession -Name 'probe-session' -NoMirror`
      : `Enter-ClaudeSession -Name 'probe-session'`,
  ];
  writeFileSync(scriptPath, lines.join("\n"), "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  // The wrapper is meant to be run from a shell that has never dot-sourced it before, and a stray
  // CHANNEL_SESSION_MIRROR inherited from whatever launched this test process would make the
  // without-switch case pass for the wrong reason.
  delete env.CHANNEL_SESSION_MIRROR;
  delete env.CHANNEL_SESSION;
  delete env.CHANNEL_PROCESS_TOKEN;
  // Resolve-ChannelHost throws on a COMPUTERNAME outside its known set, which the machine running
  // this suite may or may not have; naming a known host directly keeps the probe independent of it.
  env.CHANNEL_HOST_NAME = "NEO";
  env.LOCALAPPDATA = localAppData;

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
  return readFileSync(outPath, "utf8");
}

test("-NoMirror sets CHANNEL_SESSION_MIRROR to an off value in the launched environment", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-no-mirror-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const value = probeMirrorEnv(dir, true);
  assert.notEqual(value, UNSET_MARKER, "CHANNEL_SESSION_MIRROR must be present when -NoMirror is given");
  // broker/intake.ts's per-request off vocabulary and broker/config.ts's own CHANNEL_MIRROR knob
  // share this one exported list; the wrapper's literal has to be a member of it or the value it
  // sets would fail to turn the mirror off at the broker.
  assert.ok(
    FLAG_FALSE.includes(value.trim().toLowerCase()),
    `${JSON.stringify(value)} must be a member of broker/config.ts's FLAG_FALSE`,
  );
});

test("without -NoMirror, the launched environment carries no CHANNEL_SESSION_MIRROR at all", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-no-mirror-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const value = probeMirrorEnv(dir, false);
  assert.equal(value, UNSET_MARKER, "CHANNEL_SESSION_MIRROR must stay absent when -NoMirror is not given");
});

// --- Assert-InstalledMirrorSwitch: -NoMirror's fail-closed check against a real settings file ---

/**
 * A minimal settings-file shape carrying this checkout's own SessionStart hook (so
 * Assert-InstalledMirrorSwitch recognizes the project as installed) and, when asked, mirror hooks
 * that do or do not carry the X-Channel-Mirror switch header. mirrorState controls all of it at
 * once because the function under test requires both mirror hooks to carry the switch, and the
 * "missing entirely" and "present but stale" cases both have to reach the same throw.
 */
function fixtureSettings(
  mirrorState: "current" | "stale" | "static" | "missing" | "not-installed",
): unknown {
  const sessionStartCommand =
    mirrorState === "not-installed"
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\some\\other\\tool\\session-start.ps1"'
      : `powershell -NoProfile -ExecutionPolicy Bypass -File "${SESSION_START_PATH}"`;

  const mirrorHook = (eventName: string): unknown => {
    const headers: Record<string, string> = {
      "X-Channel-Hook-Event": eventName,
      "X-Channel-Process-Token": "${CHANNEL_PROCESS_TOKEN}",
    };
    const allowedEnvVars = ["CHANNEL_PROCESS_TOKEN"];
    if (mirrorState === "current" || mirrorState === "static") {
      // A fixed value where the interpolation belongs: the header is present on every request from
      // every session, and carries no session's own setting.
      headers["X-Channel-Mirror"] = mirrorState === "static" ? "on" : "${CHANNEL_SESSION_MIRROR}";
      allowedEnvVars.push("CHANNEL_SESSION_MIRROR");
    }
    return { type: "http", url: "http://127.0.0.1:8787/mirror", headers, allowedEnvVars, timeout: 5 };
  };

  const hooks: Record<string, unknown> = {
    SessionStart: [{ hooks: [{ type: "command", command: sessionStartCommand, timeout: 10 }] }],
  };
  if (mirrorState !== "missing") {
    hooks.UserPromptSubmit = [{ hooks: [mirrorHook("UserPromptSubmit")] }];
    hooks.Stop = [{ hooks: [mirrorHook("Stop")] }];
  }
  return { hooks };
}

/**
 * Calls Assert-InstalledMirrorSwitch directly against a fixture path, never through
 * Enter-ClaudeSession, so this drives the real check without needing to shadow anything: the
 * function's own -SettingsPath parameter is the fixture seam.
 */
function runMirrorSwitchCheck(
  directory: string,
  settings: unknown | null,
): { status: number | null; stderr: string } {
  const settingsPath = path.join(directory, "settings.json");
  if (settings !== null) writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

  const scriptPath = path.join(directory, `probe-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(
    scriptPath,
    [`. "${WRAPPER_PATH}"`, `Assert-InstalledMirrorSwitch -SettingsPath "${settingsPath}"`].join("\n"),
    "utf8",
  );

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
  );
  assert.notEqual(result.signal, "SIGTERM", `PowerShell was killed after ${PROBE_TIMEOUT_MS}ms`);
  return { status: result.status, stderr: result.stderr };
}

test("-NoMirror throws when the installed mirror hooks do not carry the switch header", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, fixtureSettings("stale"));
  assert.notEqual(status, 0, "a stale mirror install must fail the check, not pass it silently");
  assert.match(stderr, /-NoMirror cannot be honored/);
  assert.match(stderr, /X-Channel-Mirror/);
});

test("-NoMirror throws when the mirror hooks are absent entirely from an otherwise-installed host", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, fixtureSettings("missing"));
  assert.notEqual(status, 0, "an install that predates the mirror hooks entirely must also fail the check");
  assert.match(stderr, /-NoMirror cannot be honored/);
});

test("-NoMirror throws when the installed switch header carries a fixed value", (t) => {
  // The header being present is not the property that makes -NoMirror work. A hook sending a fixed
  // value sends it from every session on the machine, so CHANNEL_SESSION_MIRROR reaches the broker
  // from none of them: the session would mirror in full while this check reported it suppressed,
  // which is the fail-open-and-silent shape this whole check exists to refuse.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, fixtureSettings("static"));
  assert.notEqual(status, 0, "a header that carries no session's own value must fail the check");
  assert.match(stderr, /-NoMirror cannot be honored/);
  assert.match(stderr, /X-Channel-Mirror/);
});

test("-NoMirror does not throw when the installed mirror hooks carry the switch header", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, fixtureSettings("current"));
  assert.equal(status, 0, `expected no throw; stderr: ${stderr}`);
});

test("-NoMirror's check is silent when nothing of this project is installed", (t) => {
  // Silence means no opinion, the same rule Assert-InstalledHookPath holds: a settings file with no
  // hook of this project's own has no mirror traffic to suppress either way.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, fixtureSettings("not-installed"));
  assert.equal(status, 0, `expected no throw; stderr: ${stderr}`);
});

test("-NoMirror's check is silent when there is no settings file at all", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-mirror-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { status, stderr } = runMirrorSwitchCheck(dir, null);
  assert.equal(status, 0, `expected no throw; stderr: ${stderr}`);
});
