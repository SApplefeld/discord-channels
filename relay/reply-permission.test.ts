// The relay's registration name, pinned across the four files that have to agree on it. Nothing at
// runtime notices a disagreement, and every way it can break fails open and silent:
//
//   - A permission rule naming a server that is not the relay's is never matched, so the first
//     reply a session sends opens a permission prompt at the terminal and parks the session. That
//     is the exact failure this project exists to prevent, and it appears only on the first reply
//     of a real session, hours after launch, with the operator on their phone.
//   - A channel flag given a name no server is registered under loads no channel at all. The
//     session starts and works normally; it simply cannot be answered, and says so nowhere.
//
// The name is the key the relay is registered under, which the wrapper writes into the --mcp-config
// it generates per launch and then passes to the channel flag. Claude Code builds an MCP tool's
// permission rule as `mcp__<key>__<tool>`, replacing every character of the key outside
// [a-zA-Z0-9_-] with an underscore. The relay's own `Server` name is not that identifier and is
// checked here only for the confusion a mismatch would cause in a debug log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAGMENT_PATH = path.join(REPO_ROOT, "hooks", "settings-fragment.json");
const INSTALL_FUNCTIONS_PATH = path.join(REPO_ROOT, "install", "Install-Functions.ps1");
const WRAPPER_PATH = path.join(REPO_ROOT, "wrapper", "Enter-ClaudeSession.ps1");
const RELAY_PATH = path.join(REPO_ROOT, "relay", "index.ts");

function wrapper(): string {
  return readFileSync(WRAPPER_PATH, "utf8");
}

/** The name the wrapper registers the relay under, which is the identifier everything else follows. */
function registrationKey(): string {
  const declared = wrapper().match(/\$script:ChannelServerName\s*=\s*'([^']+)'/);
  assert.notEqual(declared, null, "the wrapper must name the channel server as a literal");
  return (declared as RegExpMatchArray)[1];
}

/** Claude Code's own transformation from a registration key to a tool rule's server segment. */
function ruleSegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fragmentRules(): string[] {
  const fragment = JSON.parse(readFileSync(FRAGMENT_PATH, "utf8")) as {
    permissions?: { allow?: string[] };
    mcpServers?: unknown;
  };
  // A settings file's mcpServers key is read by nothing: measured against build 2.1.223, a session
  // started with one applies the permission rules beside it and starts no server. Shipping the
  // registration there would look installed and do nothing.
  assert.equal(fragment.mcpServers, undefined, "the fragment must not pretend to register a server");
  return fragment.permissions?.allow ?? [];
}

test("the fragment ships exactly one allow rule, built from the registration key", () => {
  const rules = fragmentRules();
  assert.equal(rules.length, 1, "the fragment merges its permission rules into the operator's own");
  assert.equal(
    rules[0],
    `mcp__${ruleSegment(registrationKey())}__reply`,
    "the allow rule does not name the server the wrapper registers the relay as",
  );
});

test("the wrapper registers the relay and passes its name with the channel flag", () => {
  // Both channel flags are variadic. A flag passed with no value swallows the next argument, and
  // the session then loads no channel while starting and running normally.
  const text = wrapper();
  assert.match(
    text,
    /&\s*claude\s+--mcp-config\s+\$mcpConfig\s+\$channelFlag\s+"server:\$\(\$script:ChannelServerName\)"/,
    "the wrapper must register the relay and pass its tagged server entry immediately after the channel flag",
  );
  assert.match(
    text,
    /\$script:RelayScript\s*=\s*Join-Path\s*\(Split-Path\s+-Parent\s+\$PSScriptRoot\)\s*'relay\\index\.ts'/,
    "the relay path must be resolved from the wrapper's own location, never a stored literal",
  );
  assert.match(
    text,
    /\$script:ChannelServerName\s*=\s*\[ordered\]@\{|\$script:ChannelServerName\s+=\s*\[ordered\]@\{/,
    "the generated config must be keyed by the same server name",
  );
});

test("the installer will merge exactly the rule the fragment ships", () => {
  // Install-Functions.ps1 refuses any permission rule outside its own allowlist, because this
  // fragment is attacker-writable on at least one host and a rule merged verbatim into the
  // operator's user-level settings pre-approves a tool for every session on the machine.
  const functions = readFileSync(INSTALL_FUNCTIONS_PATH, "utf8");
  const allowed = functions.match(/\$script:AllowedChannelPermissionRules\s*=\s*@\(([^)]*)\)/);
  assert.notEqual(allowed, null, "the installer must declare its allowed permission rules");
  const rules = [...(allowed as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(rules, fragmentRules());
});

test("the relay identifies itself as the name it is registered under", () => {
  // Not what Claude Code derives the tool name from, but a server reporting one name while running
  // under another is a trap for whoever reads a debug log next.
  const declared = readFileSync(RELAY_PATH, "utf8").match(/name:\s*"([^"]+)",\s*version:/);
  assert.notEqual(declared, null, "relay/index.ts must declare its server name as a literal");
  assert.equal((declared as RegExpMatchArray)[1], registrationKey());
});
