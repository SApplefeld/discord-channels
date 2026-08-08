// Cover for the repair script's decision table: which processes the command-line proof selects,
// which port holders it kills and which it names and leaves alive, and the port it reads. The two
// predicates are pure functions over a name, a command line, and the entry path, so every row is
// driven with made-up descriptors and a fixture path under a temp directory. Repair-Broker.ps1 is
// dot-sourced, so its runner never fires: nothing here stops the real scheduled task, kills a real
// process, or reads the operator's real state root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../broker/config.ts";

const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPAIR_PATH = path.join(INSTALL_DIR, "Repair-Broker.ps1");

/** How long a probe process gets before it is treated as hung rather than slow. */
const PROBE_TIMEOUT_MS = 30_000;

/** The broker entry point of a checkout that exists nowhere, so no live process can match it. */
const FIXTURE_ENTRY = "D:\\fixture-checkout\\broker\\index.ts";

/** Dot-sources Repair-Broker.ps1 and runs the given PowerShell body against its functions. */
function probe(directory: string, body: string[]): string {
  const scriptPath = path.join(directory, `probe-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(scriptPath, [`. "${REPAIR_PATH}"`, ...body].join("\n"), "utf8");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
  );
  assert.notEqual(result.signal, "SIGTERM", `PowerShell hung for ${PROBE_TIMEOUT_MS}ms`);
  assert.equal(result.status, 0, `PowerShell exited ${result.status}: ${result.stderr}`);
  // The runner is guarded on $MyInvocation.InvocationName; a leak would print its own banner here
  // after having already stopped the task and killed the live broker.
  assert.doesNotMatch(result.stdout, /Repairing the broker/, "the runner fired on a dot-source");
  return result.stdout;
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "channels-repair-"));
}

test("the command-line proof selects node running this checkout's entry and nothing else", (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, [
    `$processes = @(`,
    //  The broker under the task: node, with the entry point as its argument.
    `    [pscustomobject]@{ ProcessId = 101; Name = 'node.exe'; CommandLine = '"C:\\Program Files\\nodejs\\node.exe" "${FIXTURE_ENTRY}"' },`,
    //  A node process doing something else entirely. Killing this is the expensive failure.
    `    [pscustomobject]@{ ProcessId = 202; Name = 'node.exe'; CommandLine = 'node C:\\work\\other-project\\server.js' },`,
    //  A process the account cannot read: Win32_Process reports a null command line, leaving only
    //  the name, and the name is never a reason to kill anything.
    `    [pscustomobject]@{ ProcessId = 303; Name = 'node.exe'; CommandLine = $null },`,
    //  Another checkout's broker on the same machine, entry point and all.
    `    [pscustomobject]@{ ProcessId = 404; Name = 'node.exe'; CommandLine = 'node E:\\other-checkout\\broker\\index.ts' },`,
    //  The task's launcher: it names Start-Broker.ps1, not the entry point.
    `    [pscustomobject]@{ ProcessId = 505; Name = 'powershell.exe'; CommandLine = 'powershell.exe -NoProfile -File "D:\\fixture-checkout\\install\\Start-Broker.ps1"' },`,
    //  An editor or a grep opened on the entry point holds the whole path in its arguments. It is
    //  not node, so it lives; substring containment alone would kill the operator's editor.
    `    [pscustomobject]@{ ProcessId = 606; Name = 'Code.exe'; CommandLine = 'code ${FIXTURE_ENTRY}' }`,
    `)`,
    `$selected = @(Select-ChannelBrokerProcess -Process $processes -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    `'selected:' + (($selected | ForEach-Object { $_.ProcessId }) -join ',')`,
  ]);

  assert.match(out, /selected:101\r?\n/);
});

test("the command-line proof matches the same file through case and separator differences", (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, [
    `'upper:' + (Test-IsChannelBrokerCommandLine -Name 'NODE.EXE' -CommandLine 'NODE D:\\FIXTURE-CHECKOUT\\BROKER\\INDEX.TS' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    `'slash:' + (Test-IsChannelBrokerCommandLine -Name 'node' -CommandLine 'node D:/fixture-checkout/broker/index.ts' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    `'empty:' + (Test-IsChannelBrokerCommandLine -Name 'node' -CommandLine '' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    `'partial:' + (Test-IsChannelBrokerCommandLine -Name 'node' -CommandLine 'node D:\\fixture-checkout\\broker\\other.ts' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
  ]);

  assert.match(out, /upper:True/);
  assert.match(out, /slash:True/);
  assert.match(out, /empty:False/);
  assert.match(out, /partial:False/);
});

test("the port proof kills the broker and the unreadable orphan, and refuses every other holder", (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = probe(dir, [
    //  The orphan the script exists for, in its readable form: node, holding the port, command
    //  line naming our entry.
    `'orphan:' + (Test-IsChannelBrokerPortHolder -Name 'node.exe' -CommandLine 'node "${FIXTURE_ENTRY}"' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    //  The same orphan seen from an account that cannot open it: Win32_Process hides the command
    //  line, and node holding the broker's own port with nothing readable is the fallback row.
    `'unreadable:' + (Test-IsChannelBrokerPortHolder -Name 'node' -CommandLine $null -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    //  A readable command line naming another project is affirmative proof of a bystander. The
    //  broker's default port is a popular one for local development servers, so this row is the
    //  difference between a repair and killing someone's dev server.
    `'foreignnode:' + (Test-IsChannelBrokerPortHolder -Name 'node.exe' -CommandLine 'node C:\\work\\other\\server.js' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    //  An unrelated application squatting on the port is named, never killed.
    `'stranger:' + (Test-IsChannelBrokerPortHolder -Name 'sqlservr.exe' -CommandLine 'sqlservr.exe -sMSSQLSERVER' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    //  A holder this account cannot even name is refused: a repair with no proof kills nothing.
    `'unnamed:' + (Test-IsChannelBrokerPortHolder -Name '' -CommandLine '' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
    //  A non-node process naming our entry point is a tool holding the path, not the broker.
    //  Start-Broker.ps1 runs node with that path, so the real broker is never this row.
    `'wrapped:' + (Test-IsChannelBrokerPortHolder -Name 'powershell.exe' -CommandLine 'powershell -File x.ps1 ${FIXTURE_ENTRY}' -BrokerEntryPath '${FIXTURE_ENTRY}')`,
  ]);

  assert.match(out, /orphan:True/);
  assert.match(out, /unreadable:True/);
  assert.match(out, /foreignnode:False/);
  assert.match(out, /stranger:False/);
  assert.match(out, /unnamed:False/);
  assert.match(out, /wrapped:False/);
});

test("the port comes from broker.env and falls back to the broker's own default", (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configured = path.join(dir, "broker.env");
  const junk = path.join(dir, "junk.env");
  writeFileSync(configured, "CHANNEL_HOST_NAME=FIXTURE\nCHANNEL_BROKER_PORT=9911\n", "utf8");
  writeFileSync(junk, "CHANNEL_BROKER_PORT=not-a-port\n", "utf8");

  const out = probe(dir, [
    `'configured:' + (Get-ChannelBrokerPort -EnvFile "${configured}")`,
    `'junk:' + (Get-ChannelBrokerPort -EnvFile "${junk}")`,
    `'missing:' + (Get-ChannelBrokerPort -EnvFile "${path.join(dir, "absent.env")}")`,
  ]);

  // A wrong port is a repair that kills whatever holds a port the broker was never on, and then
  // polls an endpoint nothing answers, so both the read and the fallback are pinned.
  assert.match(out, /configured:9911/);
  // Against broker/config.ts's own exported literal, not a second copy of the number: the script's
  // fallback and the broker's default must be the same port, and a change on the config side fails
  // here rather than showing up as a repair pass that hunts an empty port.
  assert.match(out, new RegExp(`junk:${DEFAULT_PORT}\\b`));
  assert.match(out, new RegExp(`missing:${DEFAULT_PORT}\\b`));
});
