// Runs Install-Host.ps1 itself, end to end, against a fixture tree standing in for a real
// checkout: a fake repo root, a fake ~/.claude/settings.json, and a fake %LOCALAPPDATA% state root.
// The fixture's own hooks/, wrapper/, install/, and broker/ directories and its token file really
// are hardened by these tests (Protect-ChannelPath's own tests already prove that is safe against a
// throwaway temp tree); what these tests must never do, and do not, is touch the real
// ~/.claude/settings.json, the real Task Scheduler, or the real checkout's ACL.
//
// -BotToken is a SecureString parameter, which spawnSync cannot hand a script directly (there is no
// way to put a SecureString on a literal command line). Every invocation here goes through a small
// generated driver script that builds one with ConvertTo-SecureString and then calls Install-Host.ps1
// by splatting, so the token itself never appears as a bare command-line argument even in the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_REPO_ROOT = path.dirname(INSTALL_DIR);
const INSTALL_HOST_SCRIPT = path.join(INSTALL_DIR, "Install-Host.ps1");
const REGISTER_TASK_SCRIPT = path.join(INSTALL_DIR, "Register-BrokerTask.ps1");
const START_BROKER_SCRIPT = path.join(INSTALL_DIR, "Start-Broker.ps1");

/** A fixture checkout: real fragment, stand-in hook/wrapper/broker files, real install/ scripts. */
function fixtureRepoRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-repo-"));
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  mkdirSync(path.join(root, "wrapper"), { recursive: true });
  mkdirSync(path.join(root, "install"), { recursive: true });
  mkdirSync(path.join(root, "broker"), { recursive: true });
  copyFileSync(
    path.join(REAL_REPO_ROOT, "hooks", "settings-fragment.json"),
    path.join(root, "hooks", "settings-fragment.json"),
  );
  writeFileSync(path.join(root, "hooks", "session-start.ps1"), "# fixture hook\n", "utf8");
  writeFileSync(path.join(root, "wrapper", "Enter-ClaudeSession.ps1"), "# fixture wrapper\n", "utf8");
  writeFileSync(path.join(root, "broker", "index.ts"), "// fixture broker entry\n", "utf8");
  copyFileSync(INSTALL_HOST_SCRIPT, path.join(root, "install", "Install-Host.ps1"));
  copyFileSync(
    path.join(INSTALL_DIR, "Install-Functions.ps1"),
    path.join(root, "install", "Install-Functions.ps1"),
  );
  copyFileSync(REGISTER_TASK_SCRIPT, path.join(root, "install", "Register-BrokerTask.ps1"));
  copyFileSync(START_BROKER_SCRIPT, path.join(root, "install", "Start-Broker.ps1"));
  return root;
}

type InstallArgs = {
  scriptPath: string;
  hostName?: string;
  channelId?: string;
  allowedUserId?: string;
  botToken?: string;
  botTokenFile?: string;
  port?: number;
  repoRoot?: string;
  settingsPath?: string;
  stateRoot?: string;
  skipAcl?: boolean;
  skipNpmCi?: boolean;
};

/** Builds and runs a driver script that supplies -BotToken as a real SecureString via splatting. */
function runInstallHost(args: InstallArgs, directory: string): { status: number | null; stdout: string; stderr: string } {
  const lines: string[] = [];
  const params: string[] = [];
  if (args.hostName !== undefined) params.push(`HostName = "${args.hostName}"`);
  if (args.channelId !== undefined) params.push(`ChannelId = "${args.channelId}"`);
  if (args.allowedUserId !== undefined) params.push(`AllowedUserId = "${args.allowedUserId}"`);
  if (args.botTokenFile !== undefined) params.push(`BotTokenFile = "${args.botTokenFile}"`);
  if (args.port !== undefined) params.push(`Port = ${args.port}`);
  if (args.repoRoot !== undefined) params.push(`RepoRoot = "${args.repoRoot}"`);
  if (args.settingsPath !== undefined) params.push(`SettingsPath = "${args.settingsPath}"`);
  if (args.stateRoot !== undefined) params.push(`StateRoot = "${args.stateRoot}"`);
  if (args.skipAcl) params.push(`SkipAcl = $true`);
  if (args.skipNpmCi) params.push(`SkipNpmCi = $true`);

  if (args.botToken !== undefined) {
    lines.push(`$secure = ConvertTo-SecureString -String "${args.botToken}" -AsPlainText -Force`);
    params.push("BotToken = $secure");
  }

  lines.push(`$params = @{ ${params.join("; ")} }`);
  // A parameter-validation failure inside `&` (e.g. ValidatePattern) is a non-terminating error by
  // default: PowerShell writes it to the error stream and keeps running the driver script, which
  // would otherwise reach `exit 0` right after. $ErrorActionPreference makes it terminating so the
  // catch below, and this driver's own exit code, actually reflect the failure.
  lines.push(`$ErrorActionPreference = 'Stop'`);
  lines.push(`try {`);
  lines.push(`    & "${args.scriptPath}" @params`);
  lines.push(`    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
  lines.push(`    exit 0`);
  lines.push(`} catch {`);
  lines.push(`    Write-Error $_.Exception.Message`);
  lines.push(`    exit 1`);
  lines.push(`}`);

  const driverPath = path.join(directory, `driver-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(driverPath, lines.join("\n"), "utf8");
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driverPath], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("Install-Host provisions config, merges hooks, hardens the fixture tree, and creates the token file", (t) => {
  const repoRoot = fixtureRepoRoot();
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsDir, "settings.json");

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botToken: "fake-token-value",
      repoRoot,
      settingsPath,
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.equal(result.status, 0, `Install-Host failed: ${result.stdout}\n${result.stderr}`);

  // The config file, outside the repository, with every value the acceptance criteria name.
  const envPath = path.join(stateRoot, "broker.env");
  assert.ok(existsSync(envPath));
  const env = readFileSync(envPath, "utf8");
  assert.match(env, /CHANNEL_HOST_NAME=NEO/);
  assert.match(env, /CHANNEL_BROKER_PORT=8787/);
  assert.match(env, /CHANNEL_DISCORD_CHANNEL=123456789012345678/);
  assert.match(env, /CHANNEL_ALLOWED_USER_ID=876543210987654321/);
  assert.match(env, /CHANNEL_DISCORD_TOKEN_FILE=/);
  assert.match(env, /CHANNEL_BROKER_LOG_FILE=/);
  assert.match(env, /CHANNEL_BROKER_STATE=/);
  assert.match(env, /CHANNEL_NODE_EXE=/);
  assert.match(env, /CHANNEL_TASK_USER=/);

  // The token file, written outside the repository and never in the config file itself.
  const tokenFile = path.join(stateRoot, "discord-token.txt");
  assert.ok(existsSync(tokenFile));
  assert.equal(readFileSync(tokenFile, "utf8"), "fake-token-value");
  assert.doesNotMatch(env, /fake-token-value/, "the token itself must not be written into the config file");

  // The merged settings file, with the SessionStart path substituted to this fixture's own
  // absolute hook script, not the real repository's.
  assert.ok(existsSync(settingsPath));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { SessionStart: [{ hooks: [{ command: string }] }] };
  };
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /session-start\.ps1/);
  assert.ok(
    command.includes(path.join(repoRoot, "hooks", "session-start.ps1")) ||
      command.includes(path.join(repoRoot, "hooks", "session-start.ps1").replace(/\\/g, "\\\\")),
    `expected the fixture's own hook path in ${command}`,
  );
});

test("Install-Host rejects both -BotToken and -BotTokenFile together", (t) => {
  const repoRoot = fixtureRepoRoot();
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });
  const tokenFile = path.join(stateRoot, "existing-token.txt");
  writeFileSync(tokenFile, "already-there", "utf8");

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botToken: "fake",
      botTokenFile: tokenFile,
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not both/i);
});

test("Install-Host rejects a channel or user ID that is not a Discord snowflake", (t) => {
  const repoRoot = fixtureRepoRoot();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "not-a-snowflake",
      allowedUserId: "876543210987654321",
      repoRoot,
      skipAcl: true,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0);
});

test("Install-Host refuses -SkipAcl combined with a token", (t) => {
  const repoRoot = fixtureRepoRoot();
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botToken: "fake",
      repoRoot,
      stateRoot,
      skipAcl: true,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SkipAcl/i);
});

test("Install-Host refuses a -Port that disagrees with the fragment's own literal", (t) => {
  const repoRoot = fixtureRepoRoot();
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botToken: "fake",
      port: 9000,
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disagrees with the port/i);
});

test("Install-Host refuses a -BotTokenFile outside the state root", (t) => {
  const repoRoot = fixtureRepoRoot();
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-elsewhere-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
  const outsideToken = path.join(elsewhere, "token.txt");
  writeFileSync(outsideToken, "outside-token", "utf8");

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botTokenFile: outsideToken,
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0, `expected a refusal; stdout: ${result.stdout}`);
  assert.match(result.stderr, /outside the state root/i);
});
