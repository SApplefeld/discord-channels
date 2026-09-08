// How the DSH runtime child is named and what environment it is handed: the values shared by the
// bridge and by the by-hand spike that captured the fixtures, held in a module that imports nothing
// of either so importing one never runs the other.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";

/** This checkout's root, from this file's own location, so the bridge runs from any directory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The runtime launcher, in its own single-root install rather than in this repository's dependency
 * tree: co-installing it beside the SDK client mints several physical copies of the tool packages,
 * and the scheduler registry is keyed on a `Symbol()`, so the runtime executes no tool at all.
 */
export const RUNTIME_BIN = path.join(REPO_ROOT, "bridge", "runtime", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

/** The overlay that presets the worker's permission knobs to what the operator's web session runs. */
export const RUNTIME_PATCH = path.join(REPO_ROOT, "bridge", "sdk.cordis.patch.yml");

/** The provider route and model, matching the `ollama` provider entry in the operator's settings. */
export const PROVIDER = "ollama";
export const MODEL = "qwen3.8:27b";

/** Bound on each JSON-RPC request. Generous: it covers the `initialize` handshake and a boot. */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The runtime launcher, or a refusal saying how to install it.
 *
 * The runtime is not a dependency of this repository and `npm install` at the root does not produce
 * it. Without this the failure is a spawn of a path that does not exist, which reaches the caller as
 * a transport error naming neither the missing directory nor the command that creates it.
 */
export function requireRuntimeBin(bin: string = RUNTIME_BIN): string {
  if (!existsSync(bin)) {
    throw new Error(
      `The DSH runtime is not installed at '${bin}'. It lives in its own single-root ` +
        "install, so run 'npm ci' in bridge/runtime; installing at the repository root does not produce it.",
    );
  }
  return bin;
}

/**
 * The environment the runtime child is spawned with, which replaces the parent's outright.
 *
 * `scrubbedParentEnv` is the far side's own guard and the base every DSH child starts from; the
 * explicit values merge after it, which is the order that package documents, because the scrub
 * removes every `DSH_*` name and would otherwise remove the home this function exists to set.
 *
 * What that scrub actually drops is every name matching `/KEY|PASSWORD|SECRET|TOKEN/i` and every
 * `DSH_*` name. That is a name-shape filter and not a guarantee: `GITHUB_PAT`, `SSH_AUTH_SOCK`, and
 * any `*_URL` carrying an embedded password all survive it. The two families removed here on top of
 * it are this session's own: a worker spawned from a Claude Code session would otherwise inherit
 * `CLAUDE_*` and `CHANNEL_*`, which name that session's messaging socket and identity, and the
 * worker has no business holding either.
 *
 * `OLLAMA_API_KEY` is named by the provider entry in the operator's settings, and it is
 * credential-shaped, so the scrub takes it: passing it back is a deliberate act and reaches the
 * child only when the parent actually carries a value.
 */
export function childEnv(home: string, parentApiKey: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(scrubbedParentEnv())) {
    const upper = key.toUpperCase();
    if (upper.startsWith("CLAUDE") || upper.startsWith("CHANNEL_")) continue;
    env[key] = value;
  }
  env.DSH_HOME = home;
  if (parentApiKey !== undefined) env.OLLAMA_API_KEY = parentApiKey;
  return env;
}
