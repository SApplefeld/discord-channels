// The plugin packaging's cross-file pins. Five files have to agree for a session launched on the
// plugin route to come up with a channel: the marketplace manifest, the plugin manifest, the
// plugin's MCP registration, the launch line's tagged entry in the wrapper, and the reply tool's
// allow rule in the settings fragment.
//
// Every disagreement between them fails the same silent way this project keeps guarding against. A
// name the marketplace does not carry refuses the channel and the session starts anyway, watched on
// its card and unanswerable; a permission rule naming a server key that is not the one the tool
// arrives under parks the first reply on a prompt at a keyboard nobody is sitting at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MARKETPLACE_PATH = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "relay");
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const MCP_PATH = path.join(PLUGIN_DIR, ".mcp.json");
const WRAPPER_PATH = path.join(REPO_ROOT, "wrapper", "Enter-ClaudeSession.ps1");
const FRAGMENT_PATH = path.join(REPO_ROOT, "hooks", "settings-fragment.json");

type Marketplace = {
  name: string;
  owner: { name: string; email?: string };
  plugins: { name: string; source: string; description?: string }[];
};
type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  channels: { server: string }[];
};
type McpConfig = { mcpServers: Record<string, { command: string; args: string[] }> };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function marketplace(): Marketplace {
  return readJson<Marketplace>(MARKETPLACE_PATH);
}

function pluginManifest(): PluginManifest {
  return readJson<PluginManifest>(PLUGIN_MANIFEST_PATH);
}

function mcpConfig(): McpConfig {
  return readJson<McpConfig>(MCP_PATH);
}

test("the marketplace lists the relay plugin at a directory that holds a plugin manifest", () => {
  const entry = marketplace().plugins.find((plugin) => plugin.name === "relay");
  assert.notEqual(entry, undefined, "the marketplace must list the relay plugin");
  const source = path.resolve(REPO_ROOT, (entry as Marketplace["plugins"][number]).source);
  assert.equal(source, PLUGIN_DIR, "the listed source must be the plugin directory in this checkout");
  assert.ok(existsSync(PLUGIN_MANIFEST_PATH), `expected a plugin manifest at ${PLUGIN_MANIFEST_PATH}`);
  assert.equal(pluginManifest().name, "relay", "the plugin must answer to the name the marketplace lists");
});

test("the plugin's declared channel names a server its own MCP config registers", () => {
  // A channel naming a server the plugin does not register loads nothing, and the session says so
  // nowhere.
  const declared = pluginManifest().channels;
  assert.equal(declared.length, 1, "the plugin offers exactly one channel, the relay");
  const servers = mcpConfig().mcpServers;
  assert.ok(
    Object.prototype.hasOwnProperty.call(servers, declared[0].server),
    `the plugin declares channel server '${declared[0].server}', which its .mcp.json does not register`,
  );
});

test("the plugin's MCP config runs the shim from the plugin's own installed directory", () => {
  // An installed plugin is a copy in Claude Code's plugin cache, so a path resolved any other way
  // names a directory that is not there. ${CLAUDE_PLUGIN_ROOT} is what Claude Code substitutes.
  const server = mcpConfig().mcpServers["channel-relay"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/launch.mjs"]);
  assert.ok(existsSync(path.join(PLUGIN_DIR, "launch.mjs")), "the shim the config names must exist");
});

test("the wrapper's plugin entry names this marketplace and this plugin", () => {
  // `plugin:<plugin>@<marketplace>`. Either half wrong and the launch is refused on a host that has
  // moved to the plain --channels flag.
  const declared = readFileSync(WRAPPER_PATH, "utf8").match(
    /\$script:ChannelPluginEntry\s*=\s*'([^']+)'/,
  );
  assert.notEqual(declared, null, "the wrapper must name the plugin channel entry as a literal");
  assert.equal(
    (declared as RegExpMatchArray)[1],
    `plugin:${pluginManifest().name}@${marketplace().name}`,
  );
});

test("the fragment pre-approves the reply tool under the plugin-scoped server key", () => {
  // Claude Code scopes a plugin-provided server's key by the plugin carrying it, so the rule holds
  // both names: one per route the relay arrives by. The fragment ships this rule beside the
  // --mcp-config route's for as long as both routes are in service across the fleet.
  const fragment = readJson<{ permissions: { allow: string[] } }>(FRAGMENT_PATH);
  const manifest = pluginManifest();
  const expected = `mcp__plugin_${manifest.name}_${manifest.channels[0].server}__reply`;
  // Also held as a hard literal, not only as the composition above: the literal is the name a live
  // plugin-route session's tool calls carry on the wire, and a composition rebuilt the same wrong
  // way on both sides of a check would pass it while matching nothing at a session's first reply.
  assert.equal(expected, "mcp__plugin_relay_channel-relay__reply");
  assert.ok(
    fragment.permissions.allow.includes(expected),
    `the fragment must allow '${expected}'; it allows ${JSON.stringify(fragment.permissions.allow)}`,
  );
});

test("the shim reads exactly what the wrapper writes: key, directory, and file name", () => {
  // The wrapper is the writer of the relay registration and the shim is its reader, in two
  // languages, each holding its own copy of the server key, the state directory, and the file
  // name. Each side's own tests exercise it against its own literals, which is how a rename passes
  // a green suite while every plugin-route launch finds no usable command: this pin is the one
  // place the two sets of literals meet.
  const shim = readFileSync(path.join(PLUGIN_DIR, "launch.mjs"), "utf8");
  const wrapper = readFileSync(WRAPPER_PATH, "utf8");

  const shimKey = shim.match(/const SERVER_KEY = "([^"]+)"/)?.[1];
  const shimPath = shim.match(/path\.join\(base, "([^"]+)", "([^"]+)"\)/);
  const wrapperKey = wrapper.match(/\$script:ChannelServerName = '([^']+)'/)?.[1];
  const wrapperDir = wrapper.match(/Join-Path \$env:LOCALAPPDATA '([^']+)'/)?.[1];
  const wrapperFile = wrapper.match(/Join-Path \$Directory '([^']+)'/)?.[1];

  assert.ok(shimKey && shimPath && wrapperKey && wrapperDir && wrapperFile,
    "one of the five literals moved out from under this test's extraction; re-anchor it");
  assert.equal(shimKey, wrapperKey, "the shim's server key must be the one the wrapper registers");
  assert.equal(shimKey, pluginManifest().channels[0].server,
    "and the same key the plugin manifest declares the channel under");
  assert.equal(shimPath[1], wrapperDir, "the shim's state directory must be the wrapper's");
  assert.equal(shimPath[2], wrapperFile, "and its file name the one the wrapper writes");
});
