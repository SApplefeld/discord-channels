// The one-command installer's own pieces: the managed-settings merge, the machine-profile block,
// the plugin install verification, and the elevated-child launch, each driven through its test seam
// against temp paths. The scripts are dot-sourced so their runners never fire: nothing here touches
// the real Task Scheduler, Program Files, System32, or the claude CLI, and nothing here needs (or
// may use) elevation, even though the suite may happen to run elevated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ELEVATED_PATH = path.join(INSTALL_DIR, "Install-Elevated.ps1");
const ALL_PATH = path.join(INSTALL_DIR, "Install-All.ps1");

/** How long a probe process gets before it is treated as hung rather than slow. */
const PROBE_TIMEOUT_MS = 30_000;

/** Dot-sources the named script and runs the given PowerShell body against it. */
function probe(directory: string, scriptUnderTest: string, body: string[]): string {
  const scriptPath = path.join(directory, `probe-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(scriptPath, [`. "${scriptUnderTest}"`, ...body].join("\n"), "utf8");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
  );
  assert.notEqual(result.signal, "SIGTERM", `PowerShell hung for ${PROBE_TIMEOUT_MS}ms`);
  assert.equal(result.status, 0, `PowerShell exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

test("the managed-settings write creates the file with the allowlist entry", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "sub", "managed-settings.json");

  probe(dir, ELEVATED_PATH, [`Install-ChannelManagedSettings -Path "${target}"`]);

  const written = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(written.channelsEnabled, true);
  assert.deepEqual(written.allowedChannelPlugins, [
    { marketplace: "sapplefeld-channels", plugin: "relay" },
  ]);
});

test("the managed-settings merge preserves foreign keys and allowlist entries, and re-runs add nothing", (t) => {
  // allowedChannelPlugins replaces Anthropic's allowlist entirely once set, so an entry the
  // operator added for another plugin must survive this installer, and an unrelated managed key
  // even more so.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "managed-settings.json");
  writeFileSync(
    target,
    JSON.stringify({
      somePolicy: "keep-me",
      allowedChannelPlugins: [{ marketplace: "other", plugin: "thing" }],
    }),
    "utf8",
  );

  probe(dir, ELEVATED_PATH, [
    `Install-ChannelManagedSettings -Path "${target}"`,
    `Install-ChannelManagedSettings -Path "${target}"`,
  ]);

  const written = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(written.somePolicy, "keep-me");
  assert.equal(written.channelsEnabled, true);
  assert.deepEqual(written.allowedChannelPlugins, [
    { marketplace: "other", plugin: "thing" },
    { marketplace: "sapplefeld-channels", plugin: "relay" },
  ]);
});

test("the profile block installs fresh, preserves operator content, and replaces only itself", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, "profile.ps1");
  writeFileSync(profile, "# operator's own line\n", "utf8");

  probe(dir, ELEVATED_PATH, [
    `Install-ChannelProfileBlock -RepoRoot "${dir}" -ProfilePath "${profile}"`,
    `Install-ChannelProfileBlock -RepoRoot "${dir}" -ProfilePath "${profile}"`,
  ]);

  const written = readFileSync(profile, "utf8");
  assert.match(written, /# operator's own line/);
  assert.match(written, /Set-Alias -Name cchat -Value Enter-ClaudeSession/);
  assert.equal(written.match(/# region sapplefeld-channels/g)?.length, 1, "one block after a re-run");
  assert.match(written, /Enter-ClaudeSession\.ps1/);
});

test("the plugin install verifies against the CLI's list, not the mutation exit codes", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const callLog = path.join(dir, "calls.txt");

  const out = probe(dir, ALL_PATH, [
    // The mutations exit non-zero, as they do on a re-run when both already exist; only the list
    // answer decides.
    `function fakeclaude {`,
    `    Add-Content -LiteralPath "${callLog}" -Value ($args -join ' ')`,
    `    if ($args[1] -eq 'list') { 'relay@sapplefeld-channels  0.1.0'; return }`,
    `    Write-Error 'already exists'`,
    `}`,
    `Install-ChannelPlugin -RepoRoot "${dir}" -ClaudeCommand fakeclaude`,
    `'survived-the-nonzero-mutations'`,
  ]);
  assert.match(out, /survived-the-nonzero-mutations/);
  const calls = readFileSync(callLog, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(calls, [
    `plugin marketplace add ${dir}`,
    "plugin install relay@sapplefeld-channels",
    "plugin list",
  ]);
});

test("the plugin install throws when the plugin never appears in the list", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, ALL_PATH, [
    `function fakeclaude { 'nothing here' }`,
    `try {`,
    `    Install-ChannelPlugin -RepoRoot "${dir}" -ClaudeCommand fakeclaude`,
    `    'no-throw'`,
    `} catch { 'threw: ' + $_.Exception.Message }`,
  ]);
  assert.match(out, /threw: .*did not install/);
});

test("the readiness wait returns on a live probe and throws with the log path on a dead one", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, ALL_PATH, [
    `Wait-ChannelBrokerReady -Port 9999 -TimeoutSeconds 5 -Probe { param($p) $true }`,
    `'came-up'`,
    `try {`,
    `    Wait-ChannelBrokerReady -Port 9999 -TimeoutSeconds 2 -Probe { param($p) $false }`,
    `    'no-throw'`,
    `} catch { 'threw: ' + $_.Exception.Message }`,
  ]);
  assert.match(out, /came-up/);
  assert.match(out, /threw: .*did not answer .*broker\.log/);
});

test("the elevation guards point in opposite directions", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, ALL_PATH, [
    `. "${ELEVATED_PATH}"`,
    `try { Assert-ChannelInstallUnelevated -IsElevated $true; 'all-no-throw' } catch { 'all-threw' }`,
    `Assert-ChannelInstallUnelevated -IsElevated $false; 'all-ok-unelevated'`,
    `try { Assert-ChannelInstallElevated -IsElevated $false; 'elev-no-throw' } catch { 'elev-threw' }`,
    `Assert-ChannelInstallElevated -IsElevated $true; 'elev-ok-elevated'`,
  ]);
  assert.match(out, /all-threw/);
  assert.match(out, /all-ok-unelevated/);
  assert.match(out, /elev-threw/);
  assert.match(out, /elev-ok-elevated/);
});

test("the broker restart stops the task, clears only a node straggler, and restarts", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "restart-log.txt");

  const out = probe(dir, ELEVATED_PATH, [
    `$log = { param($line) Add-Content -LiteralPath "${log}" -Value $line }`,
    // A node straggler holds the port after the task stops; it must be killed before the start.
    `Restart-ChannelBroker -Port 9999 -GraceSeconds 1 -StopTask { param($n) & $log "stop:$n" } -StartTask { param($n) & $log "start:$n" } -GetListener { param($p) [pscustomobject]@{ ProcessId = 42; Name = 'node' } } -StopListener { param($id) & $log "kill:$id" }`,
    // A foreign process on the port is never killed; the restart refuses instead.
    `try {`,
    `    Restart-ChannelBroker -Port 9999 -GraceSeconds 1 -StopTask { } -StartTask { } -GetListener { param($p) [pscustomobject]@{ ProcessId = 7; Name = 'sqlservr' } } -StopListener { param($id) & $log "kill-foreign:$id" }`,
    `    'no-throw'`,
    `} catch { 'threw: ' + $_.Exception.Message }`,
  ]);
  assert.match(out, /threw: .*not a broker/);
  const calls = readFileSync(log, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(calls, [
    "stop:SapplefeldChannelsBroker",
    "kill:42",
    "start:SapplefeldChannelsBroker",
  ]);
});

test("the elevated launch pins the user and env file and throws on a failing child", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argLog = path.join(dir, "elevated-args.txt");

  const out = probe(dir, ALL_PATH, [
    `$capture = {`,
    `    param($ArgumentList)`,
    `    Set-Content -LiteralPath "${argLog}" -Value ($ArgumentList -join [char]10)`,
    `    return 0`,
    `}`,
    `Invoke-ChannelElevatedInstall -User 'HOST\\someone' -EnvFile 'X:\\state\\broker.env' -RepoRoot "${dir}" -Launcher $capture`,
    `$failing = { param($ArgumentList) return 5 }`,
    `try {`,
    `    Invoke-ChannelElevatedInstall -User 'HOST\\someone' -EnvFile 'X:\\state\\broker.env' -RepoRoot "${dir}" -Launcher $failing`,
    `    'no-throw'`,
    `} catch { 'threw: ' + $_.Exception.Message }`,
  ]);
  assert.match(out, /threw: .*exited 5/);

  const args = readFileSync(argLog, "utf8").split("\n");
  assert.ok(args.includes(`"HOST\\someone"`), `user not pinned: ${args.join(" ")}`);
  assert.ok(args.includes(`"X:\\state\\broker.env"`), `env file not pinned: ${args.join(" ")}`);
  assert.ok(
    args.some((a) => a.includes("Install-Elevated.ps1")),
    `elevated script not named: ${args.join(" ")}`,
  );
});
