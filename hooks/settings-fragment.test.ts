// Locks the shape of hooks/settings-fragment.json against the silent-break failure modes a later
// edit could introduce. Every one of them fails open and quiet: the session starts normally, the
// operator sees nothing wrong, and the session simply never appears on any Discord surface. That is
// the whole class this file exists to catch, because none of it shows up in a running session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DEFAULT_QUESTION_HOLD_MS } from "../broker/config.ts";
import { PROMPT_SETTLE_GRACE_MS } from "../broker/tail.ts";

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

/**
 * Every http hook the fragment declares, in any event and any entry, tagged with the event it
 * belongs to. The checks below run over this rather than over a hand-written list of events, so an
 * entry added later is held to the same rules the moment it exists instead of the day someone
 * remembers to add it here.
 */
function httpHooks(): Array<{ event: string; hook: HookEntry["hooks"][number] }> {
  const fragment = loadFragment();
  const found: Array<{ event: string; hook: HookEntry["hooks"][number] }> = [];
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        if (hook.type === "http") found.push({ event, hook });
      }
    }
  }
  return found;
}

/**
 * Every hook the fragment declares, command and http alike, tagged with its event. Unlike
 * httpHooks(), this also reaches SessionStart's command hook, which a check for "nothing outside
 * the mirror route carries the switch header" has to cover to mean what its name says: a check that
 * silently narrows to http hooks would pass even if the header leaked onto a command hook, since a
 * command hook is never in httpHooks()'s result at all.
 */
function allHooks(): Array<{ event: string; hook: HookEntry["hooks"][number] }> {
  const fragment = loadFragment();
  const found: Array<{ event: string; hook: HookEntry["hooks"][number] }> = [];
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        found.push({ event, hook });
      }
    }
  }
  return found;
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

test("declares exactly SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop", () => {
  const fragment = loadFragment();
  assert.deepEqual(Object.keys(fragment.hooks).sort(), [
    "PostToolUse",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
});

test("no SubagentStop is declared, which is what makes Stop mean the session stopped", () => {
  // The broker clears a session's open permission prompts when its turn ends, because a session
  // parked awaiting a verdict cannot finish one. That reading holds only while a subagent finishing
  // reaches the broker as nothing at all: with SubagentStop declared, a session parked on a prompt
  // while its background agents finish would post one, and the broker would drop a prompt the
  // operator has yet to answer, parking that session with nobody able to answer it.
  const fragment = loadFragment();
  assert.ok(
    !Object.hasOwn(fragment.hooks, "SubagentStop"),
    "broker/security/permission.ts's turnEnded rests on this event never being declared here",
  );
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

test("every http hook posts to a broker route with the token wired through", () => {
  const hooks = httpHooks();
  assert.equal(
    hooks.length,
    5,
    "the fragment declares five http hooks: two liveness, two mirror, one question",
  );

  for (const { event, hook } of hooks) {
    assert.equal(typeof hook.url, "string");
    assert.match(hook.url as string, /^http:\/\/127\.0\.0\.1:\d+\/(hook|mirror)$/);

    const headers = hook.headers ?? {};
    // The event name in the header is what the broker routes on. A hook whose header names a
    // different event than the one it fires for is indistinguishable at the broker from a session
    // sending the wrong signal entirely.
    assert.equal(headers["X-Channel-Hook-Event"], event);
    assert.match(headers["X-Channel-Process-Token"] ?? "", /\$\{?CHANNEL_PROCESS_TOKEN\}?/);

    const allowed = hook.allowedEnvVars ?? [];
    // Every variable interpolated in a header must also be allowlisted. The allowlist authorizes
    // and does not itself inject, so a name referenced but not listed leaves the header empty and
    // the request looks like an unannounced session rather than failing loudly.
    for (const [name, value] of Object.entries(headers)) {
      // Every name in the value, not just the first: a header interpolating two variables with only
      // one of them allowlisted is the same silent drop, and it is invisible to a check that stops
      // at the first match.
      for (const match of value.matchAll(/\$\{?([A-Z0-9_]+)\}?/g)) {
        assert.ok(
          allowed.includes(match[1]),
          `${event} header ${name} interpolates ${match[1]}, which must appear in allowedEnvVars ` +
            `or the header is silently dropped from every request`,
        );
      }
    }
  }
});

test("only the content-bearing hooks carry X-Channel-Mirror; every liveness hook carries no switch", () => {
  // The generic check above would pass unchanged if X-Channel-Mirror leaked onto a liveness hook or
  // even onto SessionStart's command hook, since it only requires that whatever is interpolated is
  // allowlisted and says nothing about which hooks may carry the header at all. So the negative half
  // is asserted explicitly here, over allHooks() rather than httpHooks(): the command hook has no
  // headers or allowedEnvVars at all, and a check narrowed to http hooks would never see it, passing
  // even if it somehow carried the switch. Content-bearing means the two mirror hooks and the
  // PreToolUse question hook: its payload carries the open question's text to /hook, so it rides
  // the same per-session consent the mirror posts ride.
  for (const { event, hook } of allHooks()) {
    const carriesContent =
      hook.type === "http" && ((hook.url ?? "").endsWith("/mirror") || event === "PreToolUse");
    const headers = hook.headers ?? {};
    const allowed = hook.allowedEnvVars ?? [];

    if (carriesContent) {
      assert.match(
        headers["X-Channel-Mirror"] ?? "",
        /^\$\{?CHANNEL_SESSION_MIRROR\}?$/,
        `${event}'s content-bearing hook must forward -NoMirror's per-session switch as X-Channel-Mirror`,
      );
      assert.ok(
        allowed.includes("CHANNEL_SESSION_MIRROR"),
        `${event}'s content-bearing hook interpolates CHANNEL_SESSION_MIRROR but does not allowlist it`,
      );
    } else {
      assert.equal(
        headers["X-Channel-Mirror"],
        undefined,
        `${event}'s ${hook.type} hook must not carry X-Channel-Mirror; it posts no content for a mirror switch to govern`,
      );
      assert.ok(
        !allowed.includes("CHANNEL_SESSION_MIRROR"),
        `${event}'s ${hook.type} hook must not allowlist CHANNEL_SESSION_MIRROR`,
      );
    }
  }
});

test("the liveness hooks keep the short timeout they are paid at per tool call", () => {
  // PostToolUse and the content-free Stop entry fire on every tool call and every turn of a
  // twelve-hour session. A broker that is down costs nothing (a refused loopback connection returns
  // immediately), but one that accepts and answers slowly charges this timeout against every one of
  // them before the result returns to the model.
  // PreToolUse also posts to /hook, but it is the content-bearing question alert, fires only when
  // AskUserQuestion opens a picker, and keeps its own timeout; the ticks paid per tool call are
  // the other two.
  const liveness = httpHooks().filter(
    ({ event, hook }) => (hook.url ?? "").endsWith("/hook") && event !== "PreToolUse",
  );
  assert.deepEqual(
    liveness.map(({ event }) => event).sort(),
    ["PostToolUse", "Stop"],
    "the content-free route is for the PostToolUse and Stop liveness ticks",
  );
  for (const { event, hook } of liveness) {
    assert.equal(
      hook.timeout,
      2,
      `${event}'s liveness timeout is 2s, the value the design budgets against a slow broker`,
    );
  }
});

test("the mirror hooks post content to their own route on their own timeout", () => {
  // The mirror carries the console prompt and the turn's final reply, which are larger and slower to
  // accept than a liveness tick. They ride a separate route so that cost is confined to them: a Stop
  // mirror entry that drifted onto /hook would put content-bearing posts back on the path the status
  // card's freshness depends on, and neither surface would say so.
  const mirror = httpHooks().filter(({ hook }) => (hook.url ?? "").endsWith("/mirror"));
  assert.deepEqual(
    mirror.map(({ event }) => event).sort(),
    ["Stop", "UserPromptSubmit"],
    "the content-bearing route is for the UserPromptSubmit and Stop mirror posts",
  );
  for (const { event, hook } of mirror) {
    // One exact value rather than a band, because both directions off it are wrong in ways a range
    // would admit. Below it, a saturated host exceeds the budget: the mirror is what carries the
    // operator's typed prompt, and intake.ts answers 202 only once it has read the whole body, so
    // a hook the CLI abandons before that point posts nothing at all, while one abandoned after it
    // still reaches the thread. What the value buys is the broker's room to reach that answer
    // under load. Above it, the harness holds the turn open while the hook runs, so the cost lands
    // on every prompt in every session on the machine, watched or not, and that trade is the
    // operator's to make in the fragment rather than a later edit's to make quietly here.
    assert.equal(
      hook.timeout,
      10,
      `${event}'s mirror timeout is 10s, the ceiling of the band that leaves room for a whole reply`,
    );
  }
});

test("the settled-claim grace covers the whole mirror timeout the fragment grants", () => {
  // A cross-component pin, because the two surfaces are edited by different concerns and neither
  // mentions the other. The tailer keeps a landed prompt claim alive for the grace so the mirror
  // copy it raced can still be suppressed when it arrives; the fragment decides how long the
  // harness will wait for that copy to be posted at all. Raise the fragment's timeout without
  // raising the grace and a copy still inside its own budget arrives to find the claim discarded,
  // which is the duplicate prompt the claim exists to prevent, on exactly the loaded host the
  // raise was made for. The grace is stated in milliseconds and the timeout in seconds.
  const mirror = httpHooks().filter(({ hook }) => (hook.url ?? "").endsWith("/mirror"));
  for (const { event, hook } of mirror) {
    assert.ok(
      PROMPT_SETTLE_GRACE_MS >= (hook.timeout ?? 0) * 1000,
      `${event}'s mirror timeout is ${hook.timeout}s, which the ${PROMPT_SETTLE_GRACE_MS}ms settled-claim grace must cover`,
    );
  }
});

test("PreToolUse is the question alert: matched to AskUserQuestion alone, carrying the switch", () => {
  // The transcript line for an open AskUserQuestion is withheld until the picker is answered, so
  // this hook is the only emission-time signal a parked question sends. Its payload carries the
  // question text, which is why it is the one /hook entry that also carries the per-session
  // mirror switch, and the matcher is exact: any wider and every tool call on the machine posts
  // its input to the broker at emission.
  const fragment = loadFragment();
  assert.equal(fragment.hooks.PreToolUse.length, 1);
  const [entry] = fragment.hooks.PreToolUse;
  assert.equal(entry.matcher, "AskUserQuestion", "the matcher is exact, never a wildcard");
  assert.equal(entry.hooks.length, 1);
  const [hook] = entry.hooks;
  assert.equal(hook.type, "http");
  assert.equal(hook.url, `http://127.0.0.1:${DEFAULT_PORT}/hook`);
  assert.equal(hook.headers?.["X-Channel-Hook-Event"], "PreToolUse");
  // Hours, not the mirror band: the broker's question desk holds this hook's response open while
  // the question is answerable from the thread, and this timeout is how long the CLI will wait
  // for it. Its floor against the desk's hold is the cross-component pin below; what this test
  // holds is that the value stays explicit and finite rather than falling to the 600s default,
  // under which every hold past ten minutes would die as a client-side timeout error.
  assert.ok(
    typeof hook.timeout === "number" && hook.timeout > 0,
    "the question hook's timeout must be explicit; the hold contract is pinned below",
  );
});

test("the question hook's timeout clears the desk's hold ceiling with margin", () => {
  // The cross-component pin between the two halves of the hold contract: the desk (broker side)
  // releases a held question after at most DEFAULT_QUESTION_HOLD_MS, which is also the ceiling of
  // the CHANNEL_QUESTION_HOLD_MS override, and the CLI (fragment side) abandons the held response
  // at this timeout. The margin is what makes every hold end in the broker's clean `{}` release,
  // measured to render the console picker normally, rather than a client-side timeout error. One
  // source each side, the desk ceiling imported and the fragment read, so the pin fails if either
  // moves alone.
  const fragment = loadFragment();
  const [hook] = fragment.hooks.PreToolUse[0].hooks;
  assert.ok(typeof hook.timeout === "number");
  const marginMs = hook.timeout * 1000 - DEFAULT_QUESTION_HOLD_MS;
  assert.ok(
    marginMs >= 60_000,
    `the fragment timeout must exceed the desk's hold ceiling by at least a minute, ` +
      `got ${marginMs}ms of margin`,
  );
});

test("Stop declares the liveness tick and the mirror post as separate entries", () => {
  // Two entries rather than two hooks in one entry, and the liveness one keeps its own short
  // timeout: the tick that decides whether a session looks alive must not wait on the post that
  // carries a whole assistant reply.
  const fragment = loadFragment();
  assert.equal(fragment.hooks.Stop.length, 2);
  const urls = fragment.hooks.Stop.map((entry) => {
    assert.equal(entry.hooks.length, 1, "each Stop entry declares exactly one hook");
    return entry.hooks[0].url;
  });
  assert.deepEqual(
    [...urls].sort(),
    [`http://127.0.0.1:${DEFAULT_PORT}/hook`, `http://127.0.0.1:${DEFAULT_PORT}/mirror`],
    "Stop must post the liveness tick to /hook and the mirror to /mirror",
  );
});

test("UserPromptSubmit is a single mirror hook and never a command hook", () => {
  // A UserPromptSubmit command hook's stdout is injected into the watched session's context exactly
  // as SessionStart's is, so a script here would feed its own output back to the model on every
  // prompt of every session on the machine. An http hook has no stdout to leak.
  const fragment = loadFragment();
  assert.equal(fragment.hooks.UserPromptSubmit.length, 1);
  const [entry] = fragment.hooks.UserPromptSubmit;
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, "http");
  assert.equal(entry.hooks[0].url, `http://127.0.0.1:${DEFAULT_PORT}/mirror`);
});

test("all copies of the broker port agree", () => {
  // Three places name this port: broker/config.ts (where the broker binds), every http URL in this
  // fragment, and session-start.ps1's own literal. Nothing at runtime notices a disagreement; the
  // hooks post into a port nothing is listening on, and every affected session looks unannounced or
  // goes stale while it is actively working.
  for (const { event, hook } of httpHooks()) {
    assert.equal(
      new URL(hook.url ?? "").port,
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
