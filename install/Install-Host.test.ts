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
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
  mkdirSync(path.join(root, "relay"), { recursive: true });
  mkdirSync(path.join(root, "broker", "discord"), { recursive: true });
  copyFileSync(
    path.join(REAL_REPO_ROOT, "hooks", "settings-fragment.json"),
    path.join(root, "hooks", "settings-fragment.json"),
  );
  writeFileSync(path.join(root, "hooks", "session-start.ps1"), "# fixture hook\n", "utf8");
  writeFileSync(path.join(root, "wrapper", "Enter-ClaudeSession.ps1"), "# fixture wrapper\n", "utf8");
  writeFileSync(path.join(root, "broker", "index.ts"), "// fixture broker entry\n", "utf8");
  // The real credentials module, not a stand-in: the installer's post-hardening verification runs
  // the broker's own protection check, and a fixture copy of that check would verify the fixture
  // rather than the thing the broker will enforce at startup.
  copyFileSync(
    path.join(REAL_REPO_ROOT, "broker", "discord", "credentials.ts"),
    path.join(root, "broker", "discord", "credentials.ts"),
  );
  // The merged settings file names this as an MCP server command, so Claude Code runs it at the
  // start of every session and the installer hardens it alongside the hook script.
  writeFileSync(path.join(root, "relay", "index.ts"), "// fixture relay entry\n", "utf8");
  // A second file in each tree that no required-path list names. The installer verifies every file
  // under a tree rather than one that stands for it, and these are what a check of one file per
  // tree would step over.
  writeFileSync(path.join(root, "relay", "tools.ts"), "// fixture relay tool\n", "utf8");
  writeFileSync(path.join(root, "wrapper", "Assert-Mirror.ps1"), "# fixture wrapper helper\n", "utf8");
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

/**
 * Builds and runs a driver script that supplies -BotToken as a real SecureString via splatting.
 *
 * Every run is fenced into the fixture twice over, because the installer's job is to write the
 * operator's real settings file and a forgotten parameter here reaches it. A test that omits
 * `settingsPath` or `stateRoot` is refused outright, and the child process is handed a fixture
 * HOME, USERPROFILE, and LOCALAPPDATA so that even a default resolves inside the fixture rather
 * than into the real profile. One of these alone is not enough: the first catches the omission,
 * the second catches a path this harness does not know the installer derives.
 */
function runInstallHost(args: InstallArgs, directory: string): { status: number | null; stdout: string; stderr: string } {
  if (args.settingsPath === undefined) {
    throw new Error("runInstallHost: settingsPath is required, or this writes the real ~/.claude/settings.json");
  }
  if (args.stateRoot === undefined) {
    throw new Error("runInstallHost: stateRoot is required, or this writes the real %LOCALAPPDATA%");
  }

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
  const profile = path.join(directory, "fixture-profile");
  mkdirSync(path.join(profile, ".claude"), { recursive: true });
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driverPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: profile,
      USERPROFILE: profile,
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the harness refuses to run an install that is not fenced into a fixture", () => {
  // This guard exists because its absence caused a real incident: a test that omitted settingsPath
  // fell through to the installer's own default and merged this project's hooks into the operator's
  // live ~/.claude/settings.json, pointing SessionStart at a fixture directory the test then
  // deleted. Every Claude Code session on the machine reported a hook error afterwards, and nothing
  // in the suite noticed, because the installer had done exactly what it was asked to do.
  const base = { scriptPath: "unused", hostName: "NEO" };

  assert.throws(
    () => runInstallHost({ ...base, stateRoot: "somewhere" }, os.tmpdir()),
    /settingsPath is required/,
  );
  assert.throws(
    () => runInstallHost({ ...base, settingsPath: "somewhere" }, os.tmpdir()),
    /stateRoot is required/,
  );
});

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
    permissions?: { allow?: string[] };
  };
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /session-start\.ps1/);
  assert.ok(
    command.includes(path.join(repoRoot, "hooks", "session-start.ps1")) ||
      command.includes(path.join(repoRoot, "hooks", "session-start.ps1").replace(/\\/g, "\\\\")),
    `expected the fixture's own hook path in ${command}`,
  );

  // The allow rule lands in the file that actually runs: the plugin route's plugin-scoped key, the
  // one route in service. The relay's own registration does not come from here: a settings file's
  // mcpServers key is read by nothing, so the wrapper writes a --mcp-config per launch instead.
  assert.deepEqual(settings.permissions?.allow, ["mcp__plugin_relay_channel-relay__reply"]);
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
      channelId: "not-a-snowflake",
      allowedUserId: "876543210987654321",
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipAcl: true,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0);
});

test("Install-Host refuses -SkipAcl combined with a token", (t) => {
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
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
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

test("Install-Host refuses a fragment whose http hooks name more than one port", (t) => {
  // The broker is opened on the port this resolves to, so reading one url and merging the rest
  // would leave the mirror hooks free to name a different local port: whatever is listening there
  // receives this machine's console prompts, replies, and process token, from an install that
  // reported success. The positive direction is the passing install above, which merges the shipped
  // fragment with every url on the one port.
  const repoRoot = fixtureRepoRoot();
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  // The fixture's own copy of the fragment, never the one in this checkout.
  const fragmentPath = path.join(repoRoot, "hooks", "settings-fragment.json");
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
  };
  for (const entry of fragment.hooks.UserPromptSubmit) {
    for (const hook of entry.hooks) hook.url = "http://127.0.0.1:9999/mirror";
  }
  writeFileSync(fragmentPath, JSON.stringify(fragment, null, 2), "utf8");

  const result = runInstallHost(
    {
      scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
      hostName: "NEO",
      channelId: "123456789012345678",
      allowedUserId: "876543210987654321",
      botToken: "fake",
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );
  assert.notEqual(result.status, 0, `expected a refusal; stdout: ${result.stdout}`);
  // PowerShell wraps a thrown message at the console width, so these match single tokens rather
  // than a phrase a line break can land inside.
  assert.match(result.stderr, /agree/i);
  assert.match(result.stderr, /9999/);
});

/**
 * Every tree the installer hardens, each named by a file inside it that no required-path list
 * mentions, and for `broker/` one that sits in a subdirectory.
 *
 * The point of driving all of them is that a verification pass reaching only some of these trees
 * passes the happy-path test either way: proving the asserts succeed is not proving they ran. A
 * tree dropped from the walk turns its row here red.
 */
const HARDENED_TREES: Array<{ tree: string; victim: string; names: RegExp }> = [
  { tree: "hooks", victim: "hooks/settings-fragment.json", names: /settings-fragment/ },
  { tree: "relay", victim: "relay/tools.ts", names: /tools/ },
  { tree: "wrapper", victim: "wrapper/Assert-Mirror.ps1", names: /Assert-Mirror/ },
  { tree: "install", victim: "install/Install-Functions.ps1", names: /Install-Functions/ },
  { tree: "broker", victim: "broker/discord/credentials.ts", names: /credentials/ },
];

// The state root is deliberately absent from that list. It holds runtime artifacts written by the
// broker and the launch wrapper, so each is owned by whichever process created it, while the check
// permits a grant to the path's own owner: a state file owned by Administrators that correctly
// inherits the three-trustee list would read as granting a foreign account and refuse an install
// over a path that is exactly as protected as it should be. What the state root needs proven is its
// own list, which the token file's check covers as its parent, and that is pinned separately below.

for (const { tree, victim, names } of HARDENED_TREES) {
  test(`Install-Host fails the install when a file under ${tree} is left open`, (t) => {
    // Hardening that quietly did nothing is the defect this verification exists for: hooks/ runs
    // under -ExecutionPolicy Bypass at the start of every session on the machine, and install/ and
    // broker/ are what the scheduled task executes at every logon, so an install that printed
    // success over an open one leaves the operator acting on a guarantee they do not have.
    //
    // The victim is opened in the one way hardening its tree does not close: an explicit grant to
    // Authenticated Users with inheritance detached. Protect-ChannelPath rewrites the directory's
    // list and succeeds, the inheritable grant never reaches a child that stopped inheriting, and
    // the file stays writable by every account on the machine. That is the planted-file shape the
    // broker's own check refuses, and the installer reads the same answer from the same code.
    const repoRoot = fixtureRepoRoot();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-settings-"));
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "channels-fixture-state-"));
    t.after(() => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(settingsDir, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    });

    const tokenFile = path.join(stateRoot, "discord-token.txt");
    const target = path.join(repoRoot, ...victim.split("/"));
    execFileSync("icacls.exe", [target, "/inheritance:d"], { stdio: "ignore" });
    execFileSync("icacls.exe", [target, "/grant", "*S-1-5-11:(M)"], { stdio: "ignore" });

    const result = runInstallHost(
      {
        scriptPath: path.join(repoRoot, "install", "Install-Host.ps1"),
        hostName: "NEO",
        channelId: "123456789012345678",
        allowedUserId: "876543210987654321",
        botToken: "fake-token-value",
        repoRoot,
        settingsPath: path.join(settingsDir, "settings.json"),
        stateRoot,
        skipNpmCi: true,
      },
      repoRoot,
    );

    assert.notEqual(result.status, 0, `expected a refusal; stdout: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /Provisioned/, "an install that could not harden must not report success");
    // PowerShell wraps a thrown message at the console width, so these match single tokens rather
    // than a phrase a line break can land inside.
    assert.match(result.stderr, /hardening/i);
    assert.match(result.stderr, /hold/i);
    assert.match(result.stderr, names, `the message must name the file that failed: ${result.stderr}`);
    // The install stops at the verification rather than carrying on and provisioning against a
    // surface it could not close.
    assert.equal(existsSync(path.join(stateRoot, "broker.env")), false);
    // The token file this run wrote holds the bot token in plain text, and the path it sits under
    // was just reported as reachable by other accounts, so it is removed rather than left there.
    assert.equal(existsSync(tokenFile), false, "the plaintext token written by this run must not be left behind");
  });
}

test("Install-Host verifies the token file, which is what covers the state root", (t) => {
  // The state root is not walked, for the reason stated beside HARDENED_TREES, so the token file is
  // the only entry that proves anything about it: the check reads the directory holding a path to
  // the same standard, which is also exactly the check the broker runs at every start. Dropping the
  // token file from the verification list would leave the state root proven by nothing, and the
  // count is what notices, since every other entry is a file under one of the five trees.
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
      botToken: "fake-token-value",
      repoRoot,
      settingsPath: path.join(settingsDir, "settings.json"),
      stateRoot,
      skipNpmCi: true,
    },
    repoRoot,
  );

  assert.equal(result.status, 0, `install failed; stderr: ${result.stderr}`);
  const verified = result.stdout.match(/Verified (\d+) hardened path\(s\)/);
  assert.notEqual(verified, null, `the install must report what it verified: ${result.stdout}`);

  const underTrees = ["hooks", "relay", "wrapper", "install", "broker"].reduce(
    (total, tree) => total + countEntries(path.join(repoRoot, tree)),
    0,
  );
  assert.equal(
    Number((verified as RegExpMatchArray)[1]),
    underTrees + 1,
    "every entry under the five trees, plus the token file standing for the state root",
  );
});

/** Files and subdirectories under a path, counted the way the installer's walk enumerates them. */
function countEntries(directory: string): number {
  return readdirSync(directory, { withFileTypes: true, recursive: true }).length;
}

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
