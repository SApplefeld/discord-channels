// The SDK spike: drive a real DeepSeek Harness runtime against the local Qwen host and write down
// what the bridge will be built on.
//
// This is not library code. It is run by hand, it talks to a live model, and its product is the two
// notification fixtures under bridge/fixtures/ that the bridge's own tests replay instead of ever
// touching Qwen. What it has to establish, and what the fixtures then pin, is the shape of a turn:
// which notifications arrive, in what order, what the `session.status` values actually are (the SDK
// documents the method name and not its payloads), and that a second prompt carrying a session id
// resumes the first prompt's conversation.
//
// Three DSH surfaces are load-bearing here and none is obvious from the SDK's README.
//
// The runtime is the `dsh` launcher, not a separate agent binary: `dsh --profile sdk` serves SDK
// clients over JSON-RPC on stdio, and `--patch <file>` layers an overlay after every bundle layer,
// after the profile's own `cordis.patch.yml`, and after the home-level one. That is how this script
// sets the worker's permission preset without writing a byte into the operator's harness home.
//
// The launcher is a process to spawn rather than a module to import, and it lives in its own install
// under bridge/runtime/ instead of in this repository's dependency tree. `HarnessClientOptions.command`
// is a required field, so the caller supplies the executable; and `@deepseek-ai/dsh-tools` keys its
// scheduler registry on a plain `Symbol()`, so a registry minted by one physical copy of that package
// and read by another yields `undefined` and no tool can be executed. Co-installing the runtime beside
// `@deepseek-ai/dsh-sdk-client` in one tree is what produces those several copies.
//
// The harness home travels in the child environment. `HarnessClientOptions.env` replaces the child
// environment outright when given, so building it by hand would drop PATH and everything else. The
// base is `scrubbedParentEnv` from `@deepseek-ai/dsh-subprocess`, the same scrub every in-repo DSH
// spawner starts from. That scrub is why `DSH_HOME` is set after it and not before.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessNotification, RunResult } from "@deepseek-ai/dsh-sdk-client";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { runDirectly } from "../../broker/entrypoint.ts";

/** The repository root, from this file's own location, so the script runs from any directory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The throwaway workspace the worker is given. Under `.kit/`, which .gitignore covers, so nothing
 * the worker writes can be committed, and on disk rather than in the OS temp directory so the run
 * leaves evidence to read afterwards. It is never deleted by this script.
 */
const WORKSPACE = path.join(REPO_ROOT, ".kit", "dsh-spike-workspace");

/** Where the redacted notification streams land, one JSONL file per run. */
const FIXTURES = path.join(REPO_ROOT, "bridge", "fixtures");

/** The overlay that presets the worker's permission knobs. */
const PATCH = path.join(REPO_ROOT, "bridge", "sdk.cordis.patch.yml");

/**
 * The launcher, resolved through the isolated runtime install at bridge/runtime/ rather than through
 * this repository's own node_modules or a global `dsh`.
 */
const DSH_BIN = path.join(REPO_ROOT, "bridge", "runtime", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

/** The provider route and model, matching the `ollama` provider entry in the operator's settings. */
const PROVIDER = "ollama";
const MODEL = "qwen3.8:27b";

/** The operator's harness home, and the dedicated one the fallback seeds from it. */
const SHARED_HOME = path.join(os.homedir(), ".dsh");
const DEDICATED_HOME = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "sapplefeld-channels",
  "dsh-bridge",
  "home",
);

/** The two files a dedicated home is seeded with. Copied, never moved: the originals are the operator's. */
const SEED_FILES = ["settings.yaml", ".credentials.yaml"];

/** The two spellings `--home` accepts. Anything else is a typo, and a typo must not pick a default. */
const HOME_CHOICES = ["shared", "dedicated"] as const;

/** The file the first prompt asks for, checked on the filesystem rather than taken from the answer. */
const ARTIFACT = "hello-from-qwen.txt";

/**
 * Wall clock allowed for one `run()`. The SDK's own per-request bound does not cover a turn: the
 * prompt request returns as soon as the runtime accepts it and the turn is then observed through
 * notifications, which have no timeout at all. Without this a wedged worker hangs the script
 * forever with no log line saying so.
 */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Bound on each JSON-RPC request. Generous: it covers the `initialize` handshake and a boot. */
const REQUEST_TIMEOUT_MS = 120_000;

/** One absolute path the fixtures must not carry, and what stands in for it. */
export interface RedactionRule {
  /** A regular-expression source matching every spelling of the path. Compiled fresh at each use. */
  readonly source: string;
  /** What replaces a match. Obviously not a path, so a leak reads as a bug on sight. */
  readonly placeholder: string;
}

/**
 * A regular-expression source matching every spelling of `absolute` that can appear in a log line.
 *
 * Redaction is done on decoded string values rather than on serialized JSON, so nothing here has to
 * know about backslash escaping. What it does have to know is that one path reaches a log under
 * several spellings: Windows accepts either separator and compares case-insensitively, a tool may
 * report `D:/x` where the caller passed `D:\x`, and a `file://` URL carries the same path with
 * forward slashes behind a scheme that this source simply does not consume.
 */
export function pathPatternSource(absolute: string): string {
  return absolute
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]+");
}

/** A fresh matcher for a rule. Fresh because a `g` regex carries `lastIndex` between calls. */
function matcher(rule: RedactionRule): RegExp {
  return new RegExp(rule.source, "gi");
}

/**
 * The paths a fixture must not carry, most specific first.
 *
 * Three rather than one, and the order is load-bearing. The workspace sits inside the repository
 * root and the dedicated home sits inside the user's home, so a shorter path redacted first would
 * eat the prefix of a longer one and leave the remaining segments in the file. Covering all three
 * is what makes a path arriving through a tool error or an stderr tail, rather than through the
 * prompt, redacted too: the worker reads and writes as the operator and can name any of them.
 */
export function redactionRules(
  workspace: string = WORKSPACE,
  repoRoot: string = REPO_ROOT,
  home: string = os.homedir(),
): RedactionRule[] {
  return [
    { source: pathPatternSource(workspace), placeholder: "<WORKSPACE>" },
    { source: pathPatternSource(repoRoot), placeholder: "<REPO>" },
    { source: pathPatternSource(home), placeholder: "<HOME>" },
  ];
}

/** Every rule applied to one decoded string, in rule order. */
export function redactText(text: string, rules: readonly RedactionRule[]): string {
  let out = text;
  for (const rule of rules) out = out.replace(matcher(rule), rule.placeholder);
  return out;
}

/**
 * Replace every occurrence of a redacted path inside a value, however deeply nested.
 *
 * A replacement, never a deletion: the returned value has the same shape, the same keys, and the
 * same array lengths as what the runtime emitted. The bridge's tests replay these files as ground
 * truth, so a fixture that quietly dropped a record would be worse than no fixture at all.
 */
export function redactValue(value: unknown, rules: readonly RedactionRule[]): unknown {
  if (typeof value === "string") return redactText(value, rules);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, rules));
  if (value !== null && typeof value === "object") {
    // Own enumerable keys only. These objects are parsed off a wire, so walking anything inherited
    // would carry prototype members into a fixture that is supposed to mirror the wire exactly.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValue(item, rules)]),
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One streamed fragment of a block: where it sits in the stream, which block it belongs to, its text. */
interface DeltaSlot {
  /** Index of the carrying notification in the stream. */
  readonly at: number;
  /** The block this fragment belongs to. Fragments sharing a key concatenate into one value. */
  readonly key: string;
  /** Which field of the chunk carries the fragment. */
  readonly field: "argumentsDelta" | "text";
  readonly payload: string;
}

/**
 * Every streamed fragment in the stream, in wire order.
 *
 * The model emits a tool call's arguments and an assistant's text a few characters at a time, and
 * `redactValue` sees one fragment at a time, so a path spread across thirty fragments matches
 * nothing. Grouping is what makes it visible: a tool call's fragments are keyed by the call id the
 * runtime stamps on every one of them, and a text block's by the turn, step, and block index
 * together, since a bare block index repeats on every step.
 */
export function deltaSlots(notifications: readonly HarnessNotification[]): DeltaSlot[] {
  const slots: DeltaSlot[] = [];
  notifications.forEach((notification, at) => {
    const event = asRecord(notification.params.event);
    if (event === undefined || event.type !== "assistant/chunk") return;
    const data = asRecord(event.data);
    const chunk = data === undefined ? undefined : asRecord(data.chunk);
    if (chunk === undefined) return;
    if (chunk.type === "tool-call-delta" && typeof chunk.argumentsDelta === "string") {
      slots.push({ at, key: `tool-call:${String(chunk.id)}`, field: "argumentsDelta", payload: chunk.argumentsDelta });
      return;
    }
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      const key = `text:${String(data?.turn)}/${String(data?.step)}/${String(chunk.index)}`;
      slots.push({ at, key, field: "text", payload: chunk.text });
    }
  });
  return slots;
}

/**
 * Lay `text` back out across fragments of the given lengths.
 *
 * Each fragment keeps its original length where the text reaches that far, and the last one takes
 * whatever remains, so the fragment count and the streaming shape survive redaction while the
 * fragments still concatenate to exactly `text`. A replacement shorter or longer than what it
 * replaced only moves the boundaries around it.
 */
export function resplit(text: string, lengths: readonly number[]): string[] {
  const parts: string[] = [];
  let at = 0;
  lengths.forEach((length, index) => {
    const remaining = text.length - at;
    const take = index === lengths.length - 1 ? remaining : Math.max(0, Math.min(length, remaining));
    parts.push(text.slice(at, at + take));
    at += take;
  });
  return parts;
}

/** Every fragment group in the stream, keyed as `deltaSlots` keys them, each joined into one value. */
export function assembledBlocks(notifications: readonly HarnessNotification[]): Map<string, string> {
  const joined = new Map<string, string>();
  for (const slot of deltaSlots(notifications)) {
    joined.set(slot.key, (joined.get(slot.key) ?? "") + slot.payload);
  }
  return joined;
}

/**
 * Redact a whole notification stream, reassembling streamed blocks before matching.
 *
 * Two passes, because the two failure modes are different. Every string leaf is redacted on its own,
 * which covers the paths that arrive whole (a tool's assembled arguments, a tool result's body, the
 * system prompt). Then each fragment group is joined, redacted as one string, and laid back out
 * across its original fragments, which covers the path no single fragment contains.
 */
export function redactStream(
  notifications: readonly HarnessNotification[],
  rules: readonly RedactionRule[],
): HarnessNotification[] {
  const grouped = new Map<string, DeltaSlot[]>();
  for (const slot of deltaSlots(notifications)) {
    const existing = grouped.get(slot.key);
    if (existing === undefined) grouped.set(slot.key, [slot]);
    else existing.push(slot);
  }

  const replacement = new Map<number, string>();
  for (const group of grouped.values()) {
    const redacted = redactText(group.map((slot) => slot.payload).join(""), rules);
    const parts = resplit(redacted, group.map((slot) => slot.payload.length));
    group.forEach((slot, index) => replacement.set(slot.at, parts[index]));
  }

  return notifications.map((notification, at) => {
    const out = redactValue(notification, rules) as HarnessNotification;
    const payload = replacement.get(at);
    if (payload === undefined) return out;
    const event = asRecord(out.params.event);
    const data = event === undefined ? undefined : asRecord(event.data);
    const chunk = data === undefined ? undefined : asRecord(data.chunk);
    if (chunk !== undefined) chunk[chunk.type === "tool-call-delta" ? "argumentsDelta" : "text"] = payload;
    return out;
  });
}

/** Every string leaf in a value, in traversal order. */
function stringLeaves(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) stringLeaves(item, out);
  }
  return out;
}

/**
 * Every place a redacted path is still reachable in a stream, named. Empty means the stream is clean.
 *
 * The check the fixtures are gated on, and it is deliberately run against two different joins,
 * because one of them cannot see the defect that made this function necessary. Joining every string
 * leaf in the stream catches a path sitting whole in one leaf and a path split across adjacent
 * leaves, but the fragments of a streamed block are not adjacent leaves: each one arrives in its own
 * notification, behind that notification's own method name, session id, and chunk type, so the
 * whole-stream join interleaves those between the fragments and the path never appears in it.
 * Joining each fragment group is what reads the value the runtime actually assembled.
 */
export function leakMatches(
  notifications: readonly HarnessNotification[],
  rules: readonly RedactionRule[],
): string[] {
  const found: string[] = [];
  const whole = stringLeaves(notifications, []).join("");
  for (const rule of rules) {
    if (matcher(rule).test(whole)) found.push(`every string leaf joined, matching ${rule.placeholder}`);
  }
  for (const [key, assembled] of assembledBlocks(notifications)) {
    for (const rule of rules) {
      if (matcher(rule).test(assembled)) found.push(`streamed block ${key}, matching ${rule.placeholder}`);
    }
  }
  return found;
}

/**
 * One JSONL line per notification, in wire order, redacted; and never written while a path is still
 * reachable in it. These files are committed to a public repository, so the guard refuses rather
 * than warns: a fixture that leaks the operator's directory layout cannot be unpublished.
 */
function writeFixture(file: string, notifications: readonly HarnessNotification[], rules: readonly RedactionRule[]): void {
  const redacted = redactStream(notifications, rules);
  const leaks = leakMatches(redacted, rules);
  if (leaks.length > 0) {
    throw new Error(`sdk-smoke: refusing to write ${file}, redaction left a path reachable in ${leaks.join("; ")}`);
  }
  const lines = redacted.map((notification) => JSON.stringify(notification));
  writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
}

/**
 * The child environment for the runtime.
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

/**
 * Seed a dedicated harness home from the operator's, for the case where two runtimes on one home
 * turn out not to coexist. The two files are copied and never moved; the operator's home is read
 * and nothing in it is written.
 */
function seedDedicatedHome(): string {
  mkdirSync(DEDICATED_HOME, { recursive: true });
  for (const name of SEED_FILES) {
    const source = path.join(SHARED_HOME, name);
    if (existsSync(source)) copyFileSync(source, path.join(DEDICATED_HOME, name));
    else process.stderr.write(`sdk-smoke: ${source} does not exist, so the dedicated home goes without it\n`);
  }
  return DEDICATED_HOME;
}

/** Says why on the way out, in the shape plugins/relay/launch.mjs uses for the same class of miss. */
function fail(message: string): never {
  process.stderr.write(`sdk-smoke: ${message}\n`);
  process.exit(1);
}

/**
 * The runtime launcher, or an exit saying how to install it.
 *
 * The runtime is not a dependency of this repository and `npm install` at the root does not produce
 * it. Without this the failure is a spawn of a path that does not exist, reported by the SDK client
 * as a launch error naming neither the missing directory nor the command that creates it.
 */
function requireRuntimeBin(): string {
  if (!existsSync(DSH_BIN)) {
    fail(
      `the DSH runtime is not installed at '${DSH_BIN}'. It lives in its own single-root install, ` +
        "so run 'npm ci' in bridge/runtime; installing at the repository root does not produce it.",
    );
  }
  return DSH_BIN;
}

/** Reject rather than hang, and say which run it was. The harness is closed by the caller either way. */
function withTimeout(work: Promise<RunResult>, label: string): Promise<RunResult> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not reach idle within ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS);
  });
  return Promise.race([work, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Every distinct `session.status` payload seen, in first-seen order: the values the SDK never enumerates. */
function statusValues(notifications: readonly HarnessNotification[]): string[] {
  const seen: string[] = [];
  for (const notification of notifications) {
    if (notification.method !== "session.status") continue;
    const rendered = JSON.stringify(notification.params);
    if (!seen.includes(rendered)) seen.push(rendered);
  }
  return seen;
}

/** A one-line census of a run, for the transcript this script is read from. */
function summarize(label: string, notifications: readonly HarnessNotification[]): void {
  const methods = new Map<string, number>();
  for (const notification of notifications) methods.set(notification.method, (methods.get(notification.method) ?? 0) + 1);
  const census = [...methods].map(([method, count]) => `${method}=${count}`).join(" ");
  process.stdout.write(`${label}: ${notifications.length} notifications (${census})\n`);
}

/**
 * The permission policy the runtime actually mounted, read out of the turn's own notifications.
 *
 * The runtime splices a context block into the first user message of a session, and two of its
 * sections state the live policy in the worker's own words: `sandbox:policy` names the file policy
 * in force and `approval:policy` says whether the worker can be asked to approve anything. That
 * makes them a report from inside the booted runtime, which is the only thing that settles what
 * mounted. Neither the patch file nor a config dump can: the patch states what is asked for, and
 * `PermissionPresetService` reads `defaultPreset` through an installed settings section whose
 * `setSource` replaces the defaults, so a `permission.defaultPreset` in `$DSH_HOME/settings.yaml`
 * outranks the `--patch` value and neither surface would show it.
 */
export function effectivePolicy(notifications: readonly HarnessNotification[]): Map<string, string> {
  const policy = new Map<string, string>();
  for (const notification of notifications) {
    const event = asRecord(notification.params.event);
    if (event === undefined || event.type !== "user/message") continue;
    const data = asRecord(event.data);
    const source = data === undefined ? undefined : asRecord(data.source);
    const sections = source === undefined ? undefined : source.sections;
    if (!Array.isArray(sections)) continue;
    for (const entry of sections) {
      const section = asRecord(entry);
      if (section === undefined) continue;
      if (typeof section.name !== "string" || typeof section.text !== "string") continue;
      if (!section.name.endsWith(":policy")) continue;
      if (!policy.has(section.name)) policy.set(section.name, section.text);
    }
  }
  return policy;
}

/**
 * Print the composed permission row the launcher would boot with.
 *
 * A diagnostic and not a verification. `--dump-config` composes the same layers a boot composes and
 * prints them without starting anything, so it shows what this overlay asks for; what the runtime
 * mounts is read from `effectivePolicy` instead, for the reason stated there.
 */
function dumpPermissionRow(home: string): void {
  const dump = spawnSync(process.execPath, [DSH_BIN, "--dump-config", "--profile", "sdk", "--patch", PATCH], {
    cwd: WORKSPACE,
    env: childEnv(home, process.env.OLLAMA_API_KEY),
    encoding: "utf8",
    windowsHide: true,
  });
  if (dump.status !== 0) {
    process.stderr.write(`sdk-smoke: --dump-config exited ${String(dump.status)}: ${dump.stderr}\n`);
    return;
  }
  // Ends at the next row or at the end of the dump. `\Z` is a Perl anchor that JavaScript does not
  // have: written that way the lookahead matches a literal `Z` and the row runs to the first one.
  const row = /^- id: permission$[\s\S]*?(?=^- id: |$(?![\s\S]))/m.exec(dump.stdout);
  process.stdout.write(`composed permission row:\n${row === null ? "(no row with id 'permission')" : row[0]}\n`);
}

/**
 * Which harness home this run uses. A misspelling is refused rather than defaulted: `--home dedicted`
 * silently falling through to the shared home is a run that reports having exercised the fallback
 * while it exercised the arrangement the fallback exists to replace.
 */
function chosenHome(argv: readonly string[]): (typeof HOME_CHOICES)[number] {
  const at = argv.indexOf("--home");
  if (at === -1) return "shared";
  const value = argv[at + 1];
  if (value === undefined) fail("--home was given with no value; pass 'shared' or 'dedicated'.");
  if (!HOME_CHOICES.includes(value as (typeof HOME_CHOICES)[number])) {
    fail(`--home '${value}' is not a choice; pass 'shared' or 'dedicated'.`);
  }
  return value as (typeof HOME_CHOICES)[number];
}

async function main(): Promise<void> {
  // `--home dedicated` forces the fallback home; the default is the operator's shared one, which is
  // the arrangement the whole plan rests on and therefore the one this spike has to test.
  const home = chosenHome(process.argv) === "dedicated" ? seedDedicatedHome() : SHARED_HOME;

  requireRuntimeBin();
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(FIXTURES, { recursive: true });
  const rules = redactionRules(WORKSPACE, REPO_ROOT, os.homedir());

  process.stdout.write(`harness home: ${home}\nworkspace: ${WORKSPACE}\nrunner: ${DSH_BIN}\n`);
  dumpPermissionRow(home);

  const harness = new DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: [DSH_BIN, "--profile", "sdk", "--patch", PATCH],
      // The runtime's own working directory is the workspace, because the sandbox policy's
      // workspace root is the runtime process's cwd, so a runtime booted anywhere else would confine
      // the worker to a directory the prompt never mentions.
      cwd: WORKSPACE,
      env: childEnv(home, process.env.OLLAMA_API_KEY),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
    cwd: WORKSPACE,
    provider: PROVIDER,
    model: MODEL,
  });

  const first: HarnessNotification[] = [];
  const second: HarnessNotification[] = [];
  // Set by the writer, never inferred from the file existing: a file on disk may be any earlier
  // run's, so a failed turn beside a stale fixture would otherwise leave the stale one in place and
  // the committed pair could carry two different session ids with nothing saying so.
  let wroteFirst = false;
  let wroteSecond = false;
  try {
    await harness.start();
    process.stdout.write("initialize: handshake completed\n");

    const one = await withTimeout(
      harness.run(
        `Create a file named exactly ${ARTIFACT} in this workspace directory. Its only content must be the single line: hello from qwen. Then stop.`,
        { onNotification: (notification) => first.push(notification) },
      ),
      "run 1",
    );
    writeFixture(path.join(FIXTURES, "sdk-run-1.jsonl"), first, rules);
    wroteFirst = true;
    summarize("run 1", first);
    process.stdout.write(`run 1 sessionId: ${one.sessionId}\n`);
    process.stdout.write(`run 1 finalResponse (${one.finalResponse.length} chars): ${one.finalResponse}\n`);
    process.stdout.write(`run 1 observer saw ${first.length}, RunResult carries ${one.notifications.length}\n`);
    process.stdout.write(`run 1 session.status values: ${statusValues(first).join(" | ")}\n`);

    // What the runtime mounted, from inside the runtime. An empty map means the context block this
    // reads did not arrive, which is itself a finding and not something to pass over quietly.
    const policy = effectivePolicy(first);
    if (policy.size === 0) throw new Error("run 1 carried no ':policy' context section, so nothing states what mounted");
    for (const [name, text] of policy) process.stdout.write(`effective ${name}: ${text}\n`);

    // The filesystem, not the model's claim. A worker that says it wrote a file and did not is the
    // exact failure this check exists for.
    const present = readdirSync(WORKSPACE);
    process.stdout.write(`workspace now holds: ${present.join(", ") || "(nothing)"}\n`);
    process.stdout.write(`artifact '${ARTIFACT}' exists: ${String(present.includes(ARTIFACT))}\n`);

    const two = await withTimeout(
      harness.run("What file did you just create in this workspace? Reply with its exact filename and nothing else.", {
        sessionId: one.sessionId,
        onNotification: (notification) => second.push(notification),
      }),
      "run 2",
    );
    writeFixture(path.join(FIXTURES, "sdk-run-2.jsonl"), second, rules);
    wroteSecond = true;
    summarize("run 2", second);
    process.stdout.write(`run 2 sessionId: ${two.sessionId} (same as run 1: ${String(two.sessionId === one.sessionId)})\n`);
    process.stdout.write(`run 2 finalResponse (${two.finalResponse.length} chars): ${two.finalResponse}\n`);
    process.stdout.write(`run 2 names the artifact: ${String(two.finalResponse.includes(ARTIFACT))}\n`);
    process.stdout.write(`run 2 session.status values: ${statusValues(second).join(" | ")}\n`);
  } finally {
    // Through the client's own escalation, never by killing the process here: `close()` requests
    // protocol shutdown and then walks EOF, SIGTERM, SIGKILL until the child has actually exited.
    // The fixtures are written inside the try, so a turn that fails still leaves what it produced;
    // a refusal from the leak guard is reported here rather than thrown, so it cannot stop the
    // shutdown, and it leaves no file behind either way.
    for (const [label, notifications, written] of [
      ["sdk-run-1.jsonl", first, wroteFirst],
      ["sdk-run-2.jsonl", second, wroteSecond],
    ] as const) {
      if (written) continue;
      if (notifications.length === 0) {
        // Nothing to write, and any file of this name on disk is an earlier run's. Said out loud
        // because the alternative is a committed pair silently drawn from two different sessions.
        process.stderr.write(`sdk-smoke: ${label} captured nothing, so a file of that name is an earlier run's\n`);
        continue;
      }
      try {
        writeFixture(path.join(FIXTURES, label), notifications, rules);
        process.stdout.write(`${label}: written from the finally block, so this run did not complete\n`);
      } catch (error) {
        process.stderr.write(`sdk-smoke: ${label} was not written: ${String(error)}\n`);
      }
    }
    await harness.close();
    process.stdout.write("close: the runtime was shut down through the client's escalation\n");
  }
}

if (runDirectly(import.meta.url)) {
  await main();
}
