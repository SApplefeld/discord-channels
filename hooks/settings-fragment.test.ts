// Locks the shape of hooks/settings-fragment.json against the silent-break failure modes a later
// edit could introduce. Every one of them fails open and quiet: the session starts normally, the
// operator sees nothing wrong, and the session simply never appears on any Discord surface. That is
// the whole class this file exists to catch, because none of it shows up in a running session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../broker/config.ts";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENT_PATH = path.join(HOOKS_DIR, "settings-fragment.json");
const SESSION_START_PATH = path.join(HOOKS_DIR, "session-start.ps1");

type HookEntry = {
  matcher?: string;
  hooks: Array<{
    type: string;
    command?: string;
    timeout?: number;
    url?: string;
    headers?: Record<string, string>;
    allowedEnvVars?: string[];
  }>;
};

function loadFragment(): { hooks: Record<string, HookEntry[]> } {
  const text = readFileSync(FRAGMENT_PATH, "utf8");
  return JSON.parse(text) as { hooks: Record<string, HookEntry[]> };
}

/** The `-File <path>` argument of the SessionStart command, quoted or bare. */
function sessionStartScriptPath(command: string): string | null {
  const quoted = command.match(/-File\s+"([^"]+)"/);
  if (quoted !== null) return quoted[1];
  const bare = command.match(/-File\s+(\S+)/);
  return bare === null ? null : bare[1];
}

test("the fragment is valid JSON", () => {
  assert.doesNotThrow(() => loadFragment());
});

test("declares exactly SessionStart, PostToolUse, and Stop", () => {
  const fragment = loadFragment();
  assert.deepEqual(Object.keys(fragment.hooks).sort(), ["PostToolUse", "SessionStart", "Stop"]);
});

test("SessionStart is a command hook with a short timeout, never http", () => {
  const fragment = loadFragment();
  const [entry] = fragment.hooks.SessionStart;
  assert.equal(entry.hooks.length, 1);
  const [hook] = entry.hooks;
  assert.equal(hook.type, "command");
  assert.equal(typeof hook.command, "string");
  assert.ok(typeof hook.timeout === "number" && hook.timeout > 0 && hook.timeout <= 30, "timeout must be short and explicit");
});

test("SessionStart runs its script from a drive-rooted absolute path", () => {
  const fragment = loadFragment();
  const command = fragment.hooks.SessionStart[0].hooks[0].command ?? "";
  const scriptPath = sessionStartScriptPath(command);

  // A hook runs with the monitored session's own project as its working directory, and those
  // sessions live in other repositories. A relative script path therefore resolves to nothing for
  // every session this project exists to watch, while still passing every other check here and
  // failing open in silence. Measured directly against build 2.1.222: with a relative path, a
  // session launched outside this checkout never appeared in GET /sessions at all, while the
  // identical run from the repository root produced a complete record.
  assert.notEqual(scriptPath, null, "the SessionStart command must run a script with -File");
  assert.match(
    scriptPath as string,
    /^[A-Za-z]:[\\/]/,
    `the SessionStart script path must be drive-rooted, got ${JSON.stringify(scriptPath)}`,
  );

  // An environment variable in the path is the other way to make it absolute, and it is rejected
  // on purpose: the hook command is interpolated, so the executed path would be settable by
  // anything on the machine that can persist an environment variable, and it runs under
  // -ExecutionPolicy Bypass at every session start.
  assert.doesNotMatch(
    scriptPath as string,
    /\$\{?[A-Za-z_]/,
    "the executed script path must be a literal, never an interpolated environment variable",
  );
});

test("SessionStart runs this repository's own hook script", () => {
  const fragment = loadFragment();
  const scriptPath = sessionStartScriptPath(fragment.hooks.SessionStart[0].hooks[0].command ?? "");
  // Section 7's installer rewrites this path per host. It still has to name the right file, or the
  // wrapper's launch-time check (Assert-HookPathMatchesFragment) is the only thing left between a
  // moved checkout and a fleet of sessions that never announce themselves.
  assert.equal(
    path.basename((scriptPath as string).replace(/\\/g, "/")),
    "session-start.ps1",
    "the SessionStart command must run session-start.ps1",
  );
});

for (const event of ["PostToolUse", "Stop"] as const) {
  test(`${event} is an http hook posting to the broker with the token wired through`, () => {
    const fragment = loadFragment();
    const [entry] = fragment.hooks[event];
    assert.equal(entry.hooks.length, 1, `${event} must declare exactly one hook`);
    const [hook] = entry.hooks;

    assert.equal(hook.type, "http");
    assert.equal(typeof hook.url, "string");
    assert.match(hook.url as string, /^http:\/\/127\.0\.0\.1:\d+\/hook$/);

    const headers = hook.headers ?? {};
    assert.equal(headers["X-Channel-Hook-Event"], event);
    assert.match(headers["X-Channel-Process-Token"] ?? "", /\$\{?CHANNEL_PROCESS_TOKEN\}?/);

    const allowed = hook.allowedEnvVars ?? [];
    // Every variable interpolated in a header must also be allowlisted. The allowlist authorizes
    // and does not itself inject, so a name referenced but not listed leaves the header empty and
    // the request looks like an unannounced session rather than failing loudly.
    for (const [name, value] of Object.entries(headers)) {
      const referenced = value.match(/\$\{?([A-Z0-9_]+)\}?/)?.[1];
      if (referenced === undefined) continue;
      assert.ok(
        allowed.includes(referenced),
        `${event} header ${name} interpolates ${referenced}, which must appear in allowedEnvVars ` +
          `or the header is silently dropped from every request`,
      );
    }

    // These fire on every tool call of a twelve-hour session. A broker that is down costs nothing
    // (a refused loopback connection returns immediately), but one that accepts and answers slowly
    // charges this timeout against every tool call before the result returns to the model.
    assert.ok(
      typeof hook.timeout === "number" && hook.timeout > 0 && hook.timeout <= 3,
      `${event} timeout must be small; it is paid per tool call against a slow broker`,
    );
  });
}

test("the two http hooks agree on the same broker URL", () => {
  const fragment = loadFragment();
  const postToolUseUrl = fragment.hooks.PostToolUse[0].hooks[0].url;
  const stopUrl = fragment.hooks.Stop[0].hooks[0].url;
  assert.equal(postToolUseUrl, stopUrl, "PostToolUse and Stop must target the same broker port");
});

test("all three copies of the broker port agree", () => {
  // Three literals name this port: broker/config.ts (where the broker binds), this fragment's two
  // http URLs, and session-start.ps1's own. Nothing at runtime notices a disagreement; the hooks
  // post into a port nothing is listening on, and every affected session looks unannounced or goes
  // stale while it is actively working.
  const fragment = loadFragment();
  for (const event of ["PostToolUse", "Stop"] as const) {
    const url = fragment.hooks[event][0].hooks[0].url ?? "";
    assert.equal(
      new URL(url).port,
      String(DEFAULT_PORT),
      `${event} posts to a port the broker does not default to`,
    );
  }

  const script = readFileSync(SESSION_START_PATH, "utf8");
  const declared = script.match(/^\s*\$brokerPort\s*=\s*(\d+)\s*$/m);
  assert.notEqual(declared, null, "session-start.ps1 must set $brokerPort to a literal");
  assert.equal(
    Number((declared as RegExpMatchArray)[1]),
    DEFAULT_PORT,
    "session-start.ps1's broker port has drifted from broker/config.ts",
  );
});

test("session-start.ps1 cannot announce a session it was not given a token for", () => {
  // The fragment installs user-level, so this hook runs for every Claude Code session on the
  // machine. One not started through the wrapper has no token, is not being watched, and must not
  // open a socket or emit anything: a SessionStart hook's stdout is injected into the session's
  // context, so any output here becomes model input on every unrelated launch.
  const script = readFileSync(SESSION_START_PATH, "utf8");
  assert.match(
    script,
    /IsNullOrWhiteSpace\(\$env:CHANNEL_PROCESS_TOKEN\)\s*\)\s*\{\s*exit 0\s*\}/,
    "session-start.ps1 must exit early when CHANNEL_PROCESS_TOKEN is absent",
  );
});
