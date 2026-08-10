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

/** Writes a broker.env holding exactly the given keys, and returns its path. */
function writeEnvFile(directory: string, values: Record<string, string>): string {
  const envPath = path.join(directory, "broker.env");
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  return envPath;
}

test("a re-install with no identity arguments reuses all four values from broker.env and announces each", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = writeEnvFile(dir, {
    CHANNEL_HOST_NAME: "NEO",
    CHANNEL_DISCORD_CHANNEL: "123456789012345678",
    CHANNEL_ALLOWED_USER_ID: "876543210987654321",
    CHANNEL_BROKER_PORT: "9001",
  });

  const out = probe(dir, ALL_PATH, [
    `$resolved = Resolve-ChannelInstallIdentity -EnvFile "${envPath}"`,
    // Field by field, so a stray value on the function's output stream turns the return into an
    // array and shows up here rather than passing as a hashtable.
    `"host=[$($resolved.HostName)]"`,
    `"channel=[$($resolved.ChannelId)]"`,
    `"user=[$($resolved.AllowedUserId)]"`,
    `"port=[$($resolved.Port)]"`,
  ]);

  assert.match(out, /host=\[NEO\]/);
  assert.match(out, /channel=\[123456789012345678\]/);
  assert.match(out, /user=\[876543210987654321\]/);
  assert.match(out, /port=\[9001\]/);
  // Every reused value is named on its own line, so an operator running from the wrong checkout
  // sees the identity go by rather than discovering it after the host is bound.
  assert.match(out, /Reusing -HostName NEO/);
  assert.match(out, /Reusing -ChannelId 123456789012345678/);
  assert.match(out, /Reusing -AllowedUserId 876543210987654321/);
  assert.match(out, /Reusing -Port 9001/);
});

test("an explicitly supplied argument beats broker.env on each of the four", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = writeEnvFile(dir, {
    CHANNEL_HOST_NAME: "OLD",
    CHANNEL_DISCORD_CHANNEL: "111111111111111111",
    CHANNEL_ALLOWED_USER_ID: "222222222222222222",
    CHANNEL_BROKER_PORT: "9001",
  });

  const out = probe(dir, ALL_PATH, [
    `$resolved = Resolve-ChannelInstallIdentity -EnvFile "${envPath}" -HostName TRINITY ` +
      `-ChannelId 333333333333333333 -AllowedUserId 444444444444444444 -Port 9500`,
    `"host=[$($resolved.HostName)]"`,
    `"channel=[$($resolved.ChannelId)]"`,
    `"user=[$($resolved.AllowedUserId)]"`,
    `"port=[$($resolved.Port)]"`,
  ]);

  assert.match(out, /host=\[TRINITY\]/);
  assert.match(out, /channel=\[333333333333333333\]/);
  assert.match(out, /user=\[444444444444444444\]/);
  assert.match(out, /port=\[9500\]/);
  // Nothing was taken from the file, so nothing is announced as reused.
  assert.doesNotMatch(out, /Reusing/);
});

test("a broker.env holding only some of the three reuses those and still throws for the rest", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = writeEnvFile(dir, {
    CHANNEL_HOST_NAME: "NEO",
    CHANNEL_DISCORD_CHANNEL: "123456789012345678",
    // A key written empty by a truncated install is as absent as a key that is not there at all.
    CHANNEL_ALLOWED_USER_ID: "",
  });

  const out = probe(dir, ALL_PATH, [
    `try {`,
    `    Resolve-ChannelInstallIdentity -EnvFile "${envPath}" | Out-Null`,
    `    'no-throw'`,
    `} catch { 'threw: ' + $_.Exception.Message }`,
  ]);

  assert.match(out, /Reusing -HostName NEO/);
  assert.match(out, /Reusing -ChannelId 123456789012345678/);
  assert.doesNotMatch(out, /Reusing -AllowedUserId/);
  assert.match(out, /threw: .*-AllowedUserId/);
});

test("a malformed id or port in broker.env throws naming the key and the file", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badChannel = writeEnvFile(path.join(dir), {
    CHANNEL_HOST_NAME: "NEO",
    CHANNEL_DISCORD_CHANNEL: "12345",
    CHANNEL_ALLOWED_USER_ID: "876543210987654321",
  });
  const badUserDir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(badUserDir, { recursive: true, force: true }));
  const badUser = writeEnvFile(badUserDir, {
    CHANNEL_HOST_NAME: "NEO",
    CHANNEL_DISCORD_CHANNEL: "123456789012345678",
    CHANNEL_ALLOWED_USER_ID: "not-an-id",
  });
  const badPortDir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(badPortDir, { recursive: true, force: true }));
  const badPort = writeEnvFile(badPortDir, {
    CHANNEL_HOST_NAME: "NEO",
    CHANNEL_DISCORD_CHANNEL: "123456789012345678",
    CHANNEL_ALLOWED_USER_ID: "876543210987654321",
    CHANNEL_BROKER_PORT: "87.9",
  });

  const out = probe(dir, ALL_PATH, [
    `try {`,
    `    Resolve-ChannelInstallIdentity -EnvFile "${badChannel}" | Out-Null`,
    `    'channel-no-throw'`,
    `} catch { 'channel threw: ' + $_.Exception.Message }`,
    `try {`,
    `    Resolve-ChannelInstallIdentity -EnvFile "${badUser}" | Out-Null`,
    `    'user-no-throw'`,
    `} catch { 'user threw: ' + $_.Exception.Message }`,
    `try {`,
    `    Resolve-ChannelInstallIdentity -EnvFile "${badPort}" | Out-Null`,
    `    'port-no-throw'`,
    `} catch { 'port threw: ' + $_.Exception.Message }`,
  ]);

  // Each names the key and the file, so the operator learns their broker.env is bad rather than
  // being told the argument is missing or hitting the failure inside Install-Host.ps1.
  assert.match(out, /channel threw: .*CHANNEL_DISCORD_CHANNEL/);
  assert.match(out, new RegExp(`channel threw: .*${badChannel.replace(/[\\.]/g, "\\$&")}`));
  assert.match(out, /user threw: .*CHANNEL_ALLOWED_USER_ID/);
  assert.match(out, new RegExp(`user threw: .*${badUser.replace(/[\\.]/g, "\\$&")}`));
  assert.match(out, /port threw: .*CHANNEL_BROKER_PORT/);
  assert.match(out, new RegExp(`port threw: .*${badPort.replace(/[\\.]/g, "\\$&")}`));
});

test("the runner with no arguments and no broker.env still names all three required arguments", (t) => {
  // The real runner, not the seam: the resolution runs before the elevation guard and before
  // anything is written, so an argument-less invocation fails on the message and provisions
  // nothing. LOCALAPPDATA is fenced into the fixture so the state root it resolves is an empty
  // temp directory rather than this machine's installed host.
  const dir = mkdtempSync(path.join(os.tmpdir(), "channels-installall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ALL_PATH], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LOCALAPPDATA: dir },
  });

  assert.notEqual(result.status, 0, `the runner must fail without an identity: ${result.stdout}`);
  assert.match(result.stderr, /-HostName/);
  assert.match(result.stderr, /-ChannelId/);
  assert.match(result.stderr, /-AllowedUserId/);
  assert.match(result.stderr, /docs\/install\.md/);
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
