# DSH bridge: a channel that drives a DeepSeek Harness worker by message

Status: In Progress
Commit Model: Commit-and-Push
Created: 2026-09-07

## Goal

A Claude Code session can hand a task to a Qwen worker running under DeepSeek Harness (DSH) with one
tool call, keep working, and have the worker's answer pushed into the session the moment the
worker's turn ends. Today the two agents coordinate through one shared file, `DISCUSSION.md` in
`D:\DeepSeekHarness`, which both of them append to and both of them poll by modification time, so a
finished turn is discovered late or not at all, a whole-file rewrite by either side clobbers the
other, and nothing but a convention file keeps their live test runs from colliding. When this plan
is complete, a new plugin in this marketplace, `dsh-bridge`, is the only writer of that record
file, is the only process that starts or resumes a DSH session on the Claude session's behalf, and
is the path by which a finished DSH turn reaches the Claude session without polling. The cheap model
does the mechanical work, the expensive model reviews it, and neither waits on a file watcher.

## Approach

### Two vocabularies this document uses

"The kit" is claude-kit, the operator's Claude Code plugin (`github.com/sapplefeld/claude-kit`),
installed on this machine; its judgment sidecar is a hook that sends each tool call to the same Qwen
host for an advisory verdict, which is why that host's slot count matters below. Two unrelated
things are called a goal. A Claude Code native goal (`/goal`) is a harness feature that holds a
Claude session to an objective with periodic check-ins. A DSH goal is DSH's own feature of the same
name, a persistent objective the DSH agent keeps working in rounds until a cap; DSH's default cap is
raised to an effectively unbounded value in the operator's settings. The bridge's sessions carry no
DSH goal: each `dsh_prompt` is one turn, and the worker's loop is driven by the Reviewer's prompts.

### The loop this replaces

Two parties write `D:\DeepSeekHarness\DISCUSSION.md`. The Reviewer is a Claude Code session in
that directory; DeepSeekHarness is a DSH web session (`npx @deepseek-ai/dsh web`, port 3080) whose
model is Qwen3.8-27B served by llama.cpp at `http://192.168.58.245:11434`. The protocol, stated in
the file's own header: append a `## <Party> @ <ISO timestamp>` section, never edit an earlier one,
end it with `NEXT: <party>`, and the other party waits for a write. The Reviewer wakes on a Monitor
task polling the file's mtime every 20 seconds plus a native goal's half-hour check-ins. The DSH
side wakes through a DSH goal: the web session's log carries a `goal/change` event at turn one whose
objective tells the worker that a review agent writes to `DISCUSSION.md` and to read the feedback,
address it, and write a response. Cutover therefore has a DSH-side act too: the operator ends that
goal in the web UI, or lets the web session sit idle, so two workers do not answer one Reviewer.

The Reviewer session named its frictions in this order, and the design answers them in the same
order: no end-of-turn signal (three rounds ran with no completion entry, discovered by mtime an hour
late); a shared single-writer file with no locking; and live-test collisions on a shared persona
store guarded only by `.kit/RUNNING`.

### One process, three faces

The bridge is one Node process started by Claude Code as a channel plugin's MCP server. Toward
Claude it is two things at once: an MCP tool server (the Claude session calls tools on it) and a
channel (it pushes `notifications/claude/channel` events into the session unprompted). Toward DSH it
is an SDK client: it spawns `dsh --profile sdk`, a documented JSON-RPC-over-stdio automation
surface, and drives sessions through `@deepseek-ai/dsh-sdk-client`. It is the shape the relay
already has (`relay/index.ts` is an MCP server that pushes channel events and exposes a `reply`
tool), with a DSH runtime where the relay has a Discord broker.

The six tools, all prefixed `dsh_` so the allow rules and the instructions name one family. Five
are built in section 2; `dsh_record_rotate` is built in section 3.

| Tool | Arguments | Returns |
|---|---|---|
| `dsh_prompt` | `session` (a name the caller chooses), `text`, `cwd` (absolute path of the worker's workspace; required on the first prompt for a session name, remembered after, and a later different value is refused until `dsh_kill`), optional `record` (absolute path of the record file, remembered per session), optional `party` (default `Reviewer`) and `counterparty` (default `DeepSeekHarness`) | As soon as the runtime accepts the prompt, without waiting for agent activity: a receipt naming the DSH session id and turn number |
| `dsh_status` | `session` | Whether the session is live (this bridge holds a running child with it) or stored (known by name with a log on disk and no child, after a kill or a bridge restart); whether a turn is in flight and the last notification time, both from the child; turn count, step count, compaction count and last event kind, all from the on-disk log |
| `dsh_busy` | none | `true` when any session this bridge owns has a turn in flight, with the session names; the Reviewer consults it before starting a live test run |
| `dsh_tail` | `session`, `count` (default 40), optional `kinds` (an explicit allow-list of event types) | The last N events from the session log on disk, one line each, bounded per line. The default filter drops the four chunk types (`assistant/chunk`, `text-chunks`, `tool-call-chunks`, `reasoning-chunks`) and admits every other type; `kinds` replaces the default with the list given |
| `dsh_kill` | `session` | Terminates the DSH child. The session log survives on disk; the next `dsh_prompt` with the same name resumes it |
| `dsh_record_rotate` | `session`, `archive_path` | Moves the record file to `archive_path` and starts a fresh one; refused while that session has a turn in flight |

A turn is in flight from the moment the runtime accepts a `session/prompt` until that session's
`session.status` notification reports the agent idle or reports an error, or `dsh_kill` ends it.
`dsh_busy` and `dsh_record_rotate` both key on that state.

One channel event per finished turn. When a session's `session.status` reports idle after a prompt
was accepted, or reports an error, the bridge emits `notifications/claude/channel` with `content` =
the worker's final response, bounded at `MAX_CHANNEL_CONTENT` characters (12,000 as the initial
value; the overflow is in the record file and in `dsh_tail`), and `meta` =
`{ session, kind, turn, finish_reason, files_touched, commands_run }`. `kind` is `turn_end` for idle,
`error` for an error status, and `killed` when `dsh_kill` ends an in-flight turn, in which case
`content` is the last assistant text committed in that turn, empty if none; a kill with no turn in
flight emits nothing, and the bridge's own shutdown emits nothing, the session it would push to
being gone. Every meta value is a string: `turn` and `commands_run` are decimal counts,
`files_touched` is a comma-separated list of paths relative to the session's `cwd`, capped at
`MAX_META_FILES` entries (20 initially) with a trailing `+N` naming the remainder. Meta keys are
identifiers (letters, digits, underscores) because Claude Code drops any other key silently. The
server's `instructions` string is a static literal, as `relay/protocol.ts` does it, telling Claude
what the attributes mean and that the body is the worker's own text, data rather than steering.

The record. When `dsh_prompt` carries a `record` path, the bridge appends
`## <party> @ <ISO>` + the prompt text + `NEXT: <counterparty>` before sending, and on the turn's
end appends `## <counterparty> @ <ISO>` + the final response + `NEXT: <party>`. The record path is
remembered per session name, so later prompts need not repeat it. Appends are atomic per section
(one `appendFile` call per section, never a read-modify-write), and the file is created if absent.
`dsh_record_rotate` moves the current record to `archive_path` and starts a fresh one carrying the
same header block. The rule, and the whole point of section 3: **the record file admits appends from
the bridge alone; a Reviewer entry, a worker entry, and a rotation all arrive through a bridge tool,
and no agent opens the file for writing.** Reading it is unrestricted, and the operator's own hand
edit is outside the rule, which binds the two agents and the bridge.

Session identity and resume. The caller names sessions (for example `agentic-plugin-builder`, the
name the Reviewer would give the worker session that builds `D:\DeepSeekHarness\agentic-plugin`);
the bridge maps each name to a DSH session id, its `cwd`, and its record path in a small JSON file
under the project's state root (`%LOCALAPPDATA%\sapplefeld-channels\dsh-bridge\sessions.json`,
beside the relay's registration), so a bridge restart or a `dsh_kill` resumes the same DSH
conversation in the same workspace. Reusing a DSH session id resumes its durable conversation; that
is the SDK client's documented contract for `run()` with a `sessionId`.

Process lifetime. The bridge dies with the Claude session that started it (Claude Code closes the
stdio pipe; the shim in `plugins/relay/launch.mjs` documents that EOF, not a signal, is what stops a
child on Windows). The DSH child is shut down through the client's own escalation (protocol
`shutdown`, then SIGTERM, then SIGKILL). A turn in flight at that moment is lost as a turn and kept
as a log; the session resumes on the next prompt.

### Decisions and their reasons

**SDK profile, not the running web session.** The web app's API is an internal typed gateway,
token-gated (a bare GET on port 3080 answers 401) and undocumented as an external surface. The SDK
profile is the documented automation surface with a published client. Cost: a second DSH runtime
process on the machine, and sessions created by the bridge are separate from the operator's
interactive one. Both runtimes share `~/.dsh`, so the bridge's sessions should be listed in the web
UI; that is inferred and section 1 checks it.

**SDK, not the Agent Client Protocol, for this version.** DSH also serves ACP (`dsh --profile acp`)
with cancel, permission relay, and session list/resume/close. The SDK protocol has none of those:
its requests are `initialize`, `session/prompt`, `shutdown`, its notifications `session.event`,
`session.status`, `subagent.started`, `subagent.finished`, and its README states server-to-client
requests are a dead capability and there is no cancel or session-close. The SDK still wins for
version one because the client library owns process lifecycle and resume, so the bridge stays thin;
cancel is `dsh_kill` plus resume-by-name. ACP is the version-two path if mid-run steering is ever
needed, and it is listed under Out of Scope.

**Approvals are preset, never relayed.** With no server-to-client requests, DSH cannot ask the
bridge for permission. DSH's approval policy `ask` falls through to `unavailable` when no answerer is
attached and the caller fails closed; `never` rejects deterministically. So the bridge's profile
patch presets approval and sandbox mode to what the operator's web session runs today. Its log
records the values as `permission/preset`, `sandbox/mode`, and `approval/policy` events: the session
opened at `workspace-write` with policy `ask` and switched three seconds later to preset
`danger-full-access`, sandbox `danger-full-access`, policy `never`, which is the state it has run in
since. Mirroring that means the worker runs with no sandbox and no approvals, exactly as it does in
the web session now, so the bridge widens nothing. The blast radius is bounded by git rather than by
the sandbox: the DSH sandbox's Windows backend self-reports partial enforcement even when on, and the
operator has approved running the worker in a dedicated worktree. Section 1 re-reads the three
events at run time rather than trusting this paragraph, since the operator can change the mode in
the web UI at any time. The bridge does not declare `claude/channel/permission`: the inbound events
are machine-generated, and a permission relay on that channel would let the worker's output approve
Claude's tool calls.

**Single writer for the record.** The clobber and the missing-entry frictions are both properties of
two agents writing one file. Making the bridge the only writer removes both by construction, and the
completion entry is written from the turn-end event, so it cannot be forgotten. The cost is a
protocol change both parties must be told about at cutover (section 6's runbook), and the worker's
instructions change from "append to the file" to "answer the message".

**A sibling plugin in this marketplace.** The Claude Code channel contract (`claude/channel`
capability, `notifications/claude/channel`, allowlisted plugins under `--channels`) is exactly what
`plugins/relay` already satisfies and the wrapper already launches on this host with plain
`--channels`. A second plugin reuses the launch shim pattern, the marketplace manifest, the
settings-fragment allow rules, the manifest and launch-shim tests, and the no-build Node 24 runtime
rules. The operator's standing ruling of 2026-08-30 says new machine customization defaults to the
kit repo, and names this relay as a candidate to fold into the kit rather than a packaging model to
copy; the operator placed this plan here at the keyboard on 2026-09-07 with that relay in view. The
placement is recorded under Assumptions with its reversal cost.

**Opt-in per session.** A channel plugin's server is a child of every session that names it under
`--channels`, and this one spawns a DSH runtime. Loading it into every wrapper-launched session would
start a DSH child for sessions that never call it. The wrapper gains a `-DshBridge` switch that adds
`plugin:dsh-bridge@sapplefeld-channels` to the channel flag for that launch only.

**Pinned preview versions.** DSH is a developer preview that announces compatibility-breaking
changes. `npm view` on 2026-09-07 reports `@deepseek-ai/dsh` at `0.1.2-rc.1` (dist-tag `latest`)
and `@deepseek-ai/dsh-sdk-client` at `0.0.1-rc.1`. The bridge pins exact versions, and section 1
records the versions it validated against in its Chapter.

### Facts the implementer needs

Each fact names the surface it was read from on 2026-09-07. A DSH path is a file in the
`deepseek-ai/deepseek-harness` repository at `master`; "this machine" means a probe or a file read
on the operator's machine, which is one session's observation and not a documented contract.

DSH, documented:

- Profiles live at `$DSH_HOME/profiles/<name>` and are materialized from shipped templates on first
  use (`docs/architecture.md`, `apps/cli/README.md`); the CLI lists `web`, `headless`, `sdk`,
  `sdk-minimal`, `acp`. A profile's overrides go in its `cordis.patch.yml`, described by the web
  profile's own generated header as a YAML array of loader patch entries: id-targeted config
  overrides, disables, and insert lists, with `!!js` expressions allowed. The entry schema is in
  `docs/cordis-primer.md`, and `dsh --dump-config --profile <name>` prints the composed tree without
  booting, which is how the ids to target are read (`apps/cli/README.md`).
- The permission knobs, from `docs/config-catalog.md` and `docs/subsystems/permission-presets.md`:
  `@deepseek-ai/dsh-permission-presets` takes `defaultPreset` and `presets[<name>].sandbox` and
  `.approval`; the shipped preset `danger-full-access` pairs sandbox `danger-full-access` with
  approval `never`, so `defaultPreset: danger-full-access` is the first thing section 1 tries.
  `@deepseek-ai/dsh-sandbox-policy` takes `mode`. The approval policy's own setter is
  `setApprovalPolicy` per `docs/subsystems/approval.md`; a config key for it is not in the catalog
  excerpt read, so if the preset alone does not carry it, section 1 reads that doc for the key.
- The SDK protocol (`packages/sdk/protocol/README.md`): requests `initialize`, `session/prompt`,
  `shutdown`; notifications `session.event`, `session.status`, `subagent.started`,
  `subagent.finished`; no cancel, no session-close, and server-to-client requests are a dead
  capability.
- The SDK client (`packages/sdk/client/README.md`): the `DeepSeekHarness` constructor takes
  `profile`, `patches`, `provider`, `model`, optional `reasoningEffort`, `maxTokens`, `dshBin`,
  `cwd`, `env` (replaces the child environment entirely when given), `initializeTimeoutMs`
  (default 10,000). `run(input, { sessionId?, onNotification? })` returns
  `{ sessionId, finalResponse, events, notifications }`. The lower `HarnessClient` layer's
  `prompt()` returns the queued message id as soon as the runtime accepts it and never waits for
  agent activity, and `subscribe(filter?)` yields an async-iterable subscription. `close()`
  escalates `shutdown` (1,000 ms default) to SIGTERM to SIGKILL. The README documents no DSH home
  option; the Python client (`python/sdk/README.md`) takes `dsh_home` and refuses to read `~/.dsh`
  implicitly. So the candidates for passing the home are, in order: a constructor option the
  installed typings at `node_modules/@deepseek-ai/dsh-sdk-client/dist/*.d.ts` reveal, `env` with
  `DSH_HOME` set and the parent environment copied in, and `dshBin` pointing at a wrapper script.
- Compaction defaults (`docs/config-catalog.md`): `thresholdRatio: 0.8`, `retainRatio: 0.16`; the
  tool-result pruner trims results past 8,192 characters.
- The session log (`docs/architecture.md`): `$DSH_HOME/sessions/<workspace-key>/session-<id>/`
  holds `session.jsonl[.zstd]` for the v0 format and `session.vN.jsonl[.zstd]` for later ones;
  select the numerically highest generation.
- Headless one-shot (`dsh --profile headless "task"`, `apps/cli/README.md`) prints a final answer
  and exits with no resume, and is not used by this plan.

DSH, observed on this machine:

- `~/.dsh/settings.yaml` carries the provider entry the bridge inherits: `llm-pi-ai.providers.ollama`
  with `api: openai-completions`, `baseURL: http://192.168.58.245:11434`, model `qwen3.8:27b` with
  `contextWindow: 65536` and `maxTokens: 16384`, and `agent-default-model` pointing at it. The web
  session's log confirms the window in its `request/context` event and shows 15 compactions in one
  session, so the machinery works at that size.
- Credentials sit in `~/.dsh/.credentials.yaml`, written by the web UI. Whether the SDK child reads
  them without its own onboarding step is unverified; the llama.cpp host needs no key, so the likely
  failure is a refused empty credential rather than a rejected request. Section 1 settles it.
- The web session's log is one file of 8,323 zstd frames holding 14,130 events, appended one frame
  per write. **Node's `zlib.zstdDecompressSync` and `createZstdDecompress` both stop after the first
  frame**, returning one line from a 4 MB file, so `dsh_tail` splits on the frame magic
  `28 B5 2F FD`, decompresses frame by frame, and drops a truncated trailing frame, since the writer
  may be mid-append. Each line is `{ "type", "seq", "time", "data": { "turn", "step", ... } }`.
  Types observed: `session`, `request/header`, `request/context`, `turn/start`, `turn/end`,
  `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/chunk`, `text-chunks`,
  `tool-call-chunks`, `tool/call`, `tool/result`, `compaction/start`, `compaction/summary`,
  `compaction/prune`, `compaction/end`, `agent/inbox/spliced`, `todo/write`, `command/run`,
  `command/done`, `permission/preset`, `sandbox/mode`, `approval/policy`, `goal/change`. The
  receipt's `files_touched` and `commands_run` are derived from `tool/call` events.

Claude Code channels, from `code.claude.com/docs/en/channels` and `channels-reference`:

- A channel server declares `capabilities.experimental['claude/channel'] = {}` and, for tools,
  `capabilities.tools = {}`; it pushes `notifications/claude/channel` with `{ content: string,
  meta?: Record<string, string> }`. Meta keys outside `[A-Za-z_][A-Za-z0-9_]*` are dropped silently.
  The model sees `<channel source="plugin:dsh-bridge:dsh-bridge" ...attrs>content</channel>`.
- A custom channel loads under `--channels` only from an allowlisted plugin; during the research
  preview the development flag `--dangerously-load-development-channels plugin:<name>@<marketplace>`
  loads one regardless. This host's wrapper table already runs the relay on plain `--channels`, and
  `docs/install.md` records the managed-settings `allowedChannelPlugins` list the relay sits on; the
  bridge is added to that list the same way, and section 5 reads the startup notice to confirm the
  channel registered.
- Tool allow rules are named `mcp__plugin_<plugin>_<server>__<tool>`, so the bridge's are
  `mcp__plugin_dsh-bridge_dsh-bridge__dsh_prompt` and siblings, held in agreement across
  `hooks/settings-fragment.json`, `install/Install-Functions.ps1`'s allowed-rule list, and the pins
  in `plugins/manifest.test.ts`, exactly as the relay's one rule is today.

This machine, probed: Node v24.16.0; `zlib.zstdDecompressSync` present; no `pnpm`, no global `dsh`;
the llama.cpp host reports `total_slots: 4` with `n_ctx: 98304` per slot, so the bridge's sessions
and the kit's judgment sidecar do not contend for a slot.

### The packaging-contract sweep

The contract a second plugin must join is the set of files that agree on the relay's plugin route.
`plugins/manifest.test.ts` states the set as five files, and a repository grep for the three
identifiers that name the route (`plugin:relay@sapplefeld-channels`, `channel-relay`,
`sapplefeld-channels`) over `*.ts`, `*.mjs`, `*.json`, `*.ps1`, `*.md`, excluding `node_modules`
and `docs/archive`, returned these surfaces on 2026-09-07:

`.claude-plugin/marketplace.json`, `README.md`, `broker/config.ts`, `docs/backlog.md`,
`docs/install.md`, `docs/operations.md`, `docs/security-model.md`, `hooks/settings-fragment.json`,
`install/Install-All.ps1`, `install/Install-Elevated.ps1`, `install/Install-Functions.ps1`,
`install/Install-Host.ps1` and their `.test.ts` twins, `plugins/launch-shim.test.ts`,
`plugins/manifest.test.ts`, `plugins/relay/.claude-plugin/plugin.json`, `plugins/relay/.mcp.json`,
`plugins/relay/launch.mjs`, `relay/README.md`, `relay/index.ts`, `relay/permission.test.ts`,
`relay/reply-permission.test.ts`, `smoke.test.ts`, `wrapper/Enter-ClaudeSession.ps1`,
`wrapper/launch-line.test.ts`, plus the broker test files, which name the marketplace only as a
state-directory segment.

Every file that grep returned appears in some section's Files in scope or under Out of Scope.

## Standing Brief Amendments

Every entry here binds every section opened after it was written, dispatched or inline.

- **Neutralize and bound every string that crosses into a channel attribute, at the boundary rather
  than at the caller.** A channel event's `meta` values are rendered into the Claude session as XML
  attributes, and Claude Code does not escape them, so any value carrying a quote, an angle bracket,
  an ampersand or a control character can end the attribute and inject markup the model reads as
  structure. Worker-controlled text is the obvious source, but it is not the boundary: a value copied
  off the runtime wire, a name the calling model chose, and a reason string the vendor may extend
  with an unknown word are all the same class. So the neutralizer and the length cap belong to the
  `meta` builder, applied to every value it emits, never to the one field whose defect was found
  first. This entry exists because that defect was found twice at two different fields in two
  consecutive review rounds, which is the workflow generating the bug rather than two unlucky sites.
- **A guard at a hostile boundary is a property of the boundary, so a second caller imports it rather
  than reimplementing it.** Before writing a call that spawns a process, builds a child environment,
  joins a path from stored data, or sanitizes text bound for a trusted channel, grep the tree for
  that boundary's other callers and reuse the guard one of them already exports. Where the owning
  file sits outside the section's `Files in scope:`, name the file, the guard and the export it needs
  in the report and leave it unedited rather than cloning it.
- **A stored identifier is untrusted input the moment it becomes a path segment.** Anything read back
  from the bridge's own state file, session ids included, is shape-checked before it is joined into a
  filesystem path.

## Sections of Work

### 1. SDK runtime spike and fixtures

Model: opus

Stand the SDK profile up against the real Qwen host and capture what the bridge will be built on.
Add `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` to `package.json` at exact pinned versions.
Write `bridge/tools/sdk-smoke.ts`, a script that constructs the client against `~/.dsh` (home passed
by the first of the three candidates above that the installed typings admit), a throwaway workspace
directory the script creates, provider `ollama`, model `qwen3.8:27b`, and a profile patch file
`bridge/sdk.cordis.patch.yml` that presets the permission knobs to the values the operator's web
session log records for `permission/preset`, `sandbox/mode`, and `approval/policy`, read from the
log with the frame-by-frame decompression above and not copied from this document, since the
operator may have changed them. Start with `defaultPreset` alone and add the sandbox and approval
keys only if the log's values are not what the preset implies; `dsh --dump-config --profile sdk` is
how the ids to target are read. The script runs one prompt that asks the worker to create one file
in the workspace, then a second prompt on the same session id that asks what it just created, and
writes every notification to `bridge/fixtures/sdk-run-1.jsonl` and `sdk-run-2.jsonl` with the
workspace path redacted.

Acceptance:

- The first run's `finalResponse` is non-empty and the file the prompt asked for exists in the
  workspace afterwards.
- The second run's `finalResponse` names the file from the first run, proving resume by session id.
- The fixtures contain the `session.status` sequence for both runs and at least one `session.event`
  carrying a `tool/call`; the Chapter quotes the status values observed (the SDK README does not
  enumerate them, so this is where they are learned).
- The Chapter records: the exact package versions installed, whether the credentials file was read
  or an onboarding step was needed, how the DSH home was passed, whether a second runtime on the
  shared home was refused or admitted, the three preset values read from the web session's log, and
  the patch entries that set them.
- If two runtimes on one home are refused, the script switches to a dedicated home
  (`%LOCALAPPDATA%\sapplefeld-channels\dsh-bridge\home`) seeded by copying `settings.yaml` and
  `.credentials.yaml`, and the Chapter says so; the bridge then uses that home in section 2.

Files in scope: `package.json`, `package-lock.json`, `bridge/tools/sdk-smoke.ts`,
`bridge/sdk.cordis.patch.yml`, `bridge/fixtures/`, `bridge/runtime/package.json`,
`bridge/runtime/package-lock.json`, `bridge/redact.test.ts`.

The runtime install is a second, single-root npm install rather than a root dependency, and the
reason is a defect this section hit rather than a preference. `@deepseek-ai/dsh-tools` keys its
scheduler registry on a plain `Symbol()`, so a registry minted by one physical copy and read by
another yields `undefined`; co-installing the runtime and the SDK client produced six copies across
two version lines and the runtime could not execute a single tool. The bridge needs the runtime as a
process to spawn rather than a module to import: the SDK client's only runtime import from the
vendor family is `@deepseek-ai/dsh-sdk-protocol`, which imports nothing but Node builtins, and
`HarnessClientOptions.command` is required, the caller supplying the executable. So the runtime
leaves the root tree entirely and lives at `bridge/runtime/` with its own lockfile, installed by
`npm ci` in that directory and never as an npm workspace, which would rehoist it into the root and
recreate the mixed graph.

Tests: one earned, by a defect that actually occurred rather than by the section as first written.
The redaction pass missed a path the worker streamed across roughly thirty argument chunks, so a
committed fixture carried it verbatim while the assembled event beside it read `<WORKSPACE>`. The
test feeds the redaction a tool-call argument stream split across chunks and asserts the reassembled
arguments carry no absolute path, with a control proving the predicate speaks against an unredacted
stream. The fixtures this section produces are what section 2's tests consume.

### 2. Bridge core

Model: opus

The MCP server with the five core tools, the DSH child, and the channel push. Mirror the relay's
module split: `bridge/protocol.ts` holds the tool schemas, the static `INSTRUCTIONS` literal, the
meta-key pattern, `MAX_CHANNEL_CONTENT`, `MAX_META_FILES`, and the `channelNotification` builder,
lockable by test without loading the MCP SDK; `bridge/harness.ts` owns the DSH child (one runtime
per bridge, lazily started on the first `dsh_prompt`), the session map (name to DSH session id,
`cwd`, and record path, persisted under the state root), turn tracking as the Approach defines it,
and the receipt derivation from `session.event` notifications; `bridge/log.ts` reads the on-disk
session log frame by frame for `dsh_tail` and `dsh_status`; `bridge/index.ts` wires the server
exactly as `relay/index.ts` does, including the `runDirectly` guard so tests can import without
seizing stdio, `oninitialized` before any DSH spawn, and the fallback notification handler that
names unhandled methods once. `dsh_prompt` returns when the runtime accepts the prompt, before the
worker does anything; on the first call for a bridge that includes the child's spawn and
`initialize`, so the bound there is the initialize timeout rather than the one-second bound the fake
meets. The push happens from the status handler. Every push is fire-and-forget with the failure
written to stderr, never thrown into the pipe.

Acceptance:

- `npm run lint` and `npm test` pass with the new tests, run against a fake runtime:
  `bridge/fake-dsh.ts` is a stdio JSON-RPC stub that speaks `initialize`, `session/prompt`, and
  `shutdown` and replays a fixture from section 1 as its notification stream, so no test touches
  Qwen, opens a port, or shares state with a neighbor.
- Against the fake, `dsh_prompt` returns with the session id and turn number while the fake is still
  streaming, and returns before any channel push for that turn. The criterion is the ordering rather
  than a wall-clock bound: a timing assertion measures the machine's load at the moment of the run,
  and one written here as a one-second bound failed at 2086 ms on a contended box while the property
  it stood for held. The ordering assertions prove the property the bound was reaching for, which is
  that the receipt does not wait on the worker.
- Exactly one channel notification per finished turn, with `content` capped at
  `MAX_CHANNEL_CONTENT`, `kind` correct for idle, error, and kill-in-flight, no notification for a
  kill with no turn in flight, every meta key matching the identifier pattern, every meta value a
  string, and `files_touched` capped at `MAX_META_FILES` with the `+N` tail.
- `dsh_busy` is `true` between acceptance and the idle status and `false` outside it.
- `dsh_prompt` with a `cwd` that differs from the remembered one for that name is refused, and
  accepted again after `dsh_kill`.
- `dsh_kill` terminates the child and the next `dsh_prompt` for the same name reuses the persisted
  DSH session id and `cwd`.
- `dsh_tail`, run by hand against the web session's log at
  `~/.dsh/sessions/--D-DeepSeekHarness--/`, returns the last 40 non-chunk events; the Chapter quotes
  the first two lines. No unit test reads that file, since another process appends to it.

Files in scope: `bridge/index.ts`, `bridge/protocol.ts`, `bridge/harness.ts`, `bridge/log.ts`,
`bridge/fake-dsh.ts`, `bridge/*.test.ts`, `bridge/README.md`.

Tests: lock the turn state machine in both directions (idle status after acceptance ends the turn
and pushes; an idle status with no accepted prompt pushes nothing), the one-push-per-turn invariant,
the three `kind` values, the content cap, the meta-key filter and string-value rule, the persisted
session map across a kill, the `cwd` refusal, and the frame-by-frame log reader against a
three-frame fixture whose last frame is truncated; a silent second push or a lost final response is
the expensive failure.

### 3. Record writer

Model: sonnet

`bridge/record.ts`: the single-writer append the Approach defines, restated here so this section
stands alone: the record file admits appends from the bridge alone, and every append arrives through
`dsh_prompt` or the turn-end handler; `dsh_record_rotate` is the only move. `dsh_prompt` with a
`record` argument appends the party section before sending and remembers the path for the session;
turn end appends the counterparty section from the same final response the channel carried, in
full, not capped; `dsh_record_rotate(session, archive_path)` moves the file with `rename`, refuses
while the session is in flight, and starts a fresh file carrying the original file's leading header
block, meaning every byte before the first line that begins `## `. Timestamps are the real clock in
ISO 8601 UTC. Section text is written verbatim: the bridge never edits, summarizes, or escapes what
either party wrote.

Acceptance:

- A prompt with `record` produces exactly one appended section ending in `NEXT: <counterparty>`,
  and the finished turn exactly one more ending in `NEXT: <party>`, byte-identical to the inputs
  between the header and the `NEXT:` line.
- A rotate during an in-flight turn is refused with a message naming the session; after the turn it
  moves the file and the new file's first bytes equal the old header block.
- A missing record file is created. A `record` or `archive_path` that is relative, or that names an
  existing directory, is refused; the path is otherwise the caller's choice and is not checked
  against the session's `cwd`, since the record the plan exists to write sits in one directory while
  the worker runs in a worktree.

Files in scope: `bridge/record.ts`, `bridge/record.test.ts`, `bridge/protocol.ts` (the tool schema
for `dsh_record_rotate`), `bridge/index.ts` (dispatch).

Tests: lock the append-only property (an existing section is never altered), the refusal during a
turn, the relative-path and directory refusals, and the header carry-over on rotate.

### 4. Plugin packaging and launch

Model: sonnet

Package the bridge on the plugin route the relay uses, opt-in per session. `plugins/dsh-bridge/`
gets `.claude-plugin/plugin.json` (name `dsh-bridge`, `channels: [{ server: "dsh-bridge" }]`),
`.mcp.json` registering server key `dsh-bridge` as `node ${CLAUDE_PLUGIN_ROOT}/launch.mjs`, and a
`launch.mjs` shim cloned from `plugins/relay/launch.mjs` that reads
`%LOCALAPPDATA%\sapplefeld-channels\dsh-bridge-mcp.json` and runs the bridge in the live checkout.
`.claude-plugin/marketplace.json` gains the plugin row. `wrapper/Enter-ClaudeSession.ps1` gains a
`-DshBridge` switch: when set, the launch writes `dsh-bridge-mcp.json` beside `relay-mcp.json` (a
sibling of `New-ChannelMcpConfig`) and appends `plugin:dsh-bridge@sapplefeld-channels` to the
`--channels` entry list; when not set, nothing about the launch changes. `hooks/settings-fragment.json`
gains the six allow rules (`dsh_prompt`, `dsh_status`, `dsh_busy`, `dsh_tail`, `dsh_kill`,
`dsh_record_rotate`) in the plugin-scoped form, and `install/Install-Functions.ps1`'s allowed-rule
list gains the same six so the installer merges them. `docs/install.md`'s managed-settings example
gains the plugin's `allowedChannelPlugins` row.

Acceptance:

- `plugins/manifest.test.ts` and `plugins/launch-shim.test.ts` are extended to cover the second
  plugin with the same pins they hold for the relay, and pass.
- `wrapper/launch-line.test.ts` pins that `-DshBridge` adds exactly the one entry and that its
  absence leaves the launch line byte-identical to today's.
- A new `bridge/allow-rules.test.ts` pins the six rule names against the fragment and against the
  tool names in `bridge/protocol.ts`, and `install/Install-Functions.test.ts` pins them against the
  installer's list.
- `npm run lint` and `npm test` pass.

Files in scope: `plugins/dsh-bridge/.claude-plugin/plugin.json`, `plugins/dsh-bridge/.mcp.json`,
`plugins/dsh-bridge/launch.mjs`, `.claude-plugin/marketplace.json`, `plugins/manifest.test.ts`,
`plugins/launch-shim.test.ts`, `wrapper/Enter-ClaudeSession.ps1`, `wrapper/launch-line.test.ts`,
`hooks/settings-fragment.json`, `install/Install-Functions.ps1`, `install/Install-Functions.test.ts`,
`install/Install-Host.test.ts`, `bridge/allow-rules.test.ts`, `docs/install.md`.

Tests: the cross-file pins are the tests; the silent failure they guard is a channel refused at
launch with the session starting anyway, which is the same failure `plugins/manifest.test.ts`
already names for the relay.

### 5. Live end-to-end run

Model: opus

Prove the whole path on the real stack once, the way the Reviewer's own live tests do. The script
`bridge/tools/live-e2e.ps1` launches a session through the wrapper with `-DshBridge`, passing
`-p --input-format stream-json --output-format stream-json` after the wrapper's `--` separator so
they reach `claude`; the wrapper runs `claude` in-process, so its stdout is the script's to redirect
to `.kit/dsh-bridge-e2e.out.jsonl`. The script holds stdin open, exactly as the Reviewer's
`.kit/live-*.sh` scripts hold their sessions open so timers fire, until the transcript shows the
channel event or a timeout of 20 minutes elapses, then closes stdin. The first stdin message tells
Claude to call `dsh_prompt` with a `record` path in a throwaway workspace and a small task for the
worker, to call `dsh_busy` once, then to wait for the channel event and report what arrived. The
script honors `.kit/RUNNING` in `D:\DeepSeekHarness` (it must not start while that file exists,
since the worker shares the Qwen host and its live tests share the machine).

Acceptance, read from the transcript and the filesystem, never from the exit code alone:

- The startup notice registered the channel (the "Channels" line names
  `plugin:dsh-bridge@sapplefeld-channels`), or, if the allowlist refused it, the Chapter records the
  refusal text and the run is repeated with `--dangerously-load-development-channels`, with the
  install doc updated to say which route this host takes and why.
- The transcript contains a `dsh_prompt` tool result carrying a session id, a `dsh_busy` result of
  `true`, then a `<channel source="plugin:dsh-bridge:dsh-bridge" kind="turn_end" ...>` event whose
  content is the worker's response, then Claude's own report of it. If a `-p` session turns out not
  to receive channel events while its stdin is held open, the Chapter records that, and the run is
  repeated as an interactive wrapper launch observed through the session's transcript file under
  `~/.claude/projects/`.
- The record file holds exactly two sections in order, `## Reviewer` then `## DeepSeekHarness`,
  ending `NEXT: DeepSeekHarness` and `NEXT: Reviewer`.
- The worker's session appears in `~/.dsh/sessions/` under the throwaway workspace key.

Files in scope: `bridge/tools/live-e2e.ps1`, the Chapter (`.gitignore`'s `.kit/` line already
covers the output).

Tests: none earned beyond the run itself; this section is the real-run gate for behavior the fake in
section 2 cannot prove: the channel allowlist, the plugin shim, the wrapper flag, and the real
DSH-to-Qwen path.

### 6. Documentation and the cutover runbook

Model: sonnet

`docs/dsh-bridge.md`: what the bridge is, the six tools and the channel event with its attributes,
how a session is launched with it, where its state lives, and the cutover runbook: the protocol
amendment to paste into `D:\DeepSeekHarness\DISCUSSION.md`'s header (both parties stop writing the
file; the Reviewer sends through `dsh_prompt` with `record`; the worker answers the message;
`.kit/RUNNING` stays as the live-test claim until version two), the DSH-side step (end the web
session's goal or leave that session idle), the round-boundary rule (cut over after a completion
entry and its verdict, never mid-round), the Reviewer's new loop (no Monitor on the file; wait for
the channel event; consult `dsh_busy` before a live run), and the operator checks. `docs/README.md`
gains the reference row; `docs/architecture.md` gains one paragraph placing the bridge beside the
relay as the second channel; `docs/security-model.md` gains the bridge's egress inventory: the
prompt text, every tool result the worker sees (the contents of files it reads and the output of
commands it runs), and its own responses travel in cleartext over the LAN to the llama.cpp host at
`192.168.58.245:11434`, and the record file is written on the local disk with both parties' text
verbatim.

The four lines below are review inputs for the kit's prose reviewer, which reads a deliverable
document against a named audience; `company` names the neutral house voice rather than the
operator's personal one.

Audience: the operator, who knows the relay and the DISCUSSION protocol and needs the cutover steps
and what leaves the machine; a Claude session holding the Reviewer seat, which needs the tool
semantics and the busy check; a session installing the plugin on another host, which needs the
launch flag and the allowlist row. Must answer, for the operator: what do I paste, when, what do I
do in the DSH web UI, and what changes on my machine; for the Reviewer: how do I send, how do I know
the turn ended, what do I check before a live run; for the installer: what flag, what allowlist
row, what breaks if the host is on the development route.
Voice: company.
Fact base: this plan, `bridge/README.md`, `bridge/protocol.ts`, the section 5 Chapter,
`docs/install.md`.
Disclosure: nothing; every persona is the operator or the operator's own sessions.

Acceptance:

- `docs/dsh-bridge.md` exists and every tool and attribute it names matches `bridge/protocol.ts`
  (a test in `bridge/protocol.test.ts` reads the doc and pins the six tool names and the meta keys).
- The security model's egress paragraph names the host and port from `~/.dsh/settings.yaml`.
- `docs/README.md`'s reference table has the row; the Plans table row for this plan is present
  until the close-out moves it.

Files in scope: `docs/dsh-bridge.md`, `docs/README.md`, `docs/architecture.md`,
`docs/security-model.md`, `bridge/protocol.test.ts`.

## Out of Scope

- A DSH-side MCP mount so the worker can ask the Reviewer a question mid-turn (`ask_reviewer`) or
  claim a live-test slot (`claim_run`); DSH is an MCP client and the bridge could serve it, but that
  is version two.
- Driving the operator's existing web session at 127.0.0.1:3080, or any use of the web app's
  internal gateway.
- The Agent Client Protocol profile, cancel, and permission relay.
- Mirroring the worker's turns into a Discord thread through the relay broker.
- Folding this plugin, or the relay, into the claude-kit repository.
- Changes to `D:\DeepSeekHarness\agentic-plugin`, to the empty `D:\DeepSeekHarness\harness-plugin`,
  or to the Reviewer session's mandate; the cutover is an operator act performed from section 6's
  runbook.
- Sharing one DSH runtime between several Claude sessions; each bridge owns its own child.
- Files the sweep returned that a second plugin does not change: the broker test files
  (`broker/board/card.test.ts`, `broker/board/events.test.ts`, `broker/discord/render.test.ts`,
  `broker/routing/outbound.test.ts`, `broker/tail.test.ts`), `broker/config.ts`,
  `install/Install-All.ps1`, `install/Install-Elevated.ps1`, `install/Install-Host.ps1`,
  `install/Install-All.test.ts`, `docs/operations.md`, `docs/backlog.md`, `README.md`,
  `relay/README.md`, `relay/index.ts`, `relay/permission.test.ts`, `relay/reply-permission.test.ts`,
  `smoke.test.ts`, and the relay's own plugin files under `plugins/relay/`.

## Assumptions

- assumed 2026-09-07 (operator's word at the keyboard, this session): the bridge lives in this
  repository as a sibling plugin of the relay, against the operator's 2026-08-30 ruling that new
  machine customization defaults to the kit repo; reversal: `git mv` of `plugins/dsh-bridge/`,
  `bridge/`, and this plan into the kit, plus a marketplace row and the wrapper entry re-pointed,
  about an hour.
- assumed 2026-09-07 (default): the bridge is the single writer of the record file and both agents
  stop writing it; reversal: drop section 3 and the `record` argument, the agents keep appending,
  and the clobber friction stays.
- assumed 2026-09-07 (default): cutover happens at a round boundary of the current
  `DISCUSSION.md` loop, after the v0.6.3 completion entry and its verdict; reversal: none in code.
- assumed 2026-09-07 (operator's word, "That's fine"): the worker runs with the web session's
  recorded mode, which as of 2026-09-07 is preset `danger-full-access` and approval `never`, so no
  sandbox and no approvals, with the blast radius bounded by a dedicated worktree; reversal: a
  different preset value in `bridge/sdk.cordis.patch.yml`, at the cost of tools the worker's live
  tests need (they spawn `claude` and write outside the workspace) being rejected.
- assumed 2026-09-07 (default): the SDK profile, not ACP, for this version; reversal: a new
  `bridge/acp.ts` transport behind the same tools, section-sized.
- assumed 2026-09-07 (source: every prior plan in this repository): Commit-and-Push.
- assumed 2026-09-07 (default): the channel is opt-in per launch through a wrapper switch, never
  added to every session; reversal: one line in the wrapper's host table.
- assumed 2026-09-07 (default): exact version pins on the two DSH packages at the versions section 1
  validates; reversal: widen the range when a later DSH release is validated.
- assumed 2026-09-07 (default): `MAX_CHANNEL_CONTENT` starts at 12,000 characters and
  `MAX_META_FILES` at 20; reversal: two constants in `bridge/protocol.ts`.
- assumed 2026-09-07 (default): a kill during an in-flight turn pushes a `killed` event carrying the
  last committed assistant text, so the Reviewer learns the turn ended abnormally; reversal: drop
  the third `kind` value and the Reviewer reads `dsh_status` instead.
- assumed 2026-09-07 (default): the record path is not checked against the session's `cwd`;
  reversal: one containment check in `bridge/record.ts`, at the cost of refusing the real record
  when the worker runs in a worktree elsewhere.

## Operator Verification

- Open `http://127.0.0.1:3080` after section 5 and confirm the bridge-driven session appears in the
  session list; if it does not, the inference that a shared home lists both runtimes' sessions is
  wrong, and the plan reopens to give the bridge its own home by default.
- At the round boundary, paste section 6's protocol amendment into `DISCUSSION.md`, end the web
  session's goal or leave that session idle, and tell the Reviewer session; a Reviewer that keeps
  its Monitor loop running beside the channel, or two workers answering one Reviewer, is the outcome
  that reopens the runbook.

## Open Questions

- Does a second DSH runtime on `~/.dsh` coexist with the running web session, or does one refuse?
  Section 1 answers; the fallback is a dedicated home seeded from the operator's settings.
- Does the SDK child read `~/.dsh/.credentials.yaml`, or does the `ollama` provider's `apiKeyEnv`
  need an empty variable set? Section 1 answers.
- Which of the three candidates carries the DSH home into the SDK child? Section 1 answers from the
  installed typings.
- Does this host's channel allowlist admit a second plugin from `sapplefeld-channels` on plain
  `--channels`? Section 5 reads the startup notice; `docs/install.md` records the answer either way.
- Does a `-p` session with stdin held open receive channel events? Section 5 answers, with the
  interactive fallback stated there.
- Should `dsh_prompt` be auto-allowed, and does the security model record what it composes? Raised
  by section 2's security review and carried here because it is an operator decision rather than an
  implementation choice, and because section 4 is what makes it live. The worker runs as the
  operator with no sandbox and approval `never`, which the operator has approved. What no document
  records is the chain that approval composes once the tool is allowed: text that steers the Claude
  session into a single `dsh_prompt` call reaches arbitrary command execution as the operator,
  without Claude Code's own approval prompt for a command, because the approval was preset on the
  far side. The bound is the dedicated worktree and git as a recovery path for tracked content, and
  there is no technical confinement. Section 4 composes the allow rule
  (`mcp__plugin_dsh-bridge_dsh-bridge__dsh_prompt`) and must not compose it before this is answered:
  auto-allow as the other five tools are, allow only against a fixed workspace allowlist, or leave
  it to a per-call approval. Section 6's `docs/security-model.md` paragraph then records the answer
  as an accepted risk under that document's own "Accepted, and worth stating" heading, which is
  where it belongs once the launch path exists rather than while the tools are unreachable.

## Related

- [`../archive/plans/channel-quality-and-plugin_spec_v1.md`](../archive/plans/channel-quality-and-plugin_spec_v1.md):
  introduced the plugin route and the launch shim this plan clones.
- [`../archive/plans/sapplefeld-channels_spec_v1.md`](../archive/plans/sapplefeld-channels_spec_v1.md):
  the relay's design, whose server shape `bridge/index.ts` mirrors.

## Chapters

### Interim board 1 - 2026-09-07

Written at a closure drought: the compaction gate had held 16 offers over 33 minutes with Section 1
implemented but not yet closed, and four read-only dispatches live whose briefs exist only in the
orchestrator's context.

**Section stages.** Section 1 (SDK runtime spike and fixtures) is implemented and self-verified by
its implementer, and is in its first review round. Sections 2 through 6 are unstarted.

**Live dispatches.**

- `adversarial-reviewer` at fable, section 1 against the spec, base ref HEAD, amendments none. Asked
  additionally to judge the `overrides` block's mechanism and the fixture redaction on their own
  terms, as areas to examine rather than findings to confirm.
- `blind-reviewer` at fable, base ref HEAD and the changed-file list only.
- `security-reviewer` at fable, section 1. Asked to run the two-question grant audit independently
  and, specifically, to test whether the implementer's three claimed *bounds* on the permission
  grant's width actually hold; and to judge what the fixture redaction pass does not cover.
- `consultant` at fable, on the dependency-install decision Section 1 surfaced (below).

All four are read-only and none builds or runs a suite, which is why the round was dispatchable
against a held heavy-process slot.

**Gate baseline.** Reported by the section 1 implementer from its own runs, on the post-change tree,
around 2026-09-07T18:05Z: `npm run lint` exit 0; `npm test` exit 0 with tests 1574, pass 1573,
fail 0, skipped 1. Its pre-change baseline on the same lane was identical. **Not independently
re-run by the orchestrator**: a peer session on this machine took the heavy-process claim at 2026-09-07T18:12:32Z with an
expected duration of 3600 seconds, so the verification re-run is owed and waits on that slot.

**Rulings adopted since the last boundary.** None yet; the consult that would produce one is in
flight.

**Verified independently by the orchestrator, not taken from the implementer's report.** The
lockfile's one-path-per-package property holds: zero `@deepseek-ai` packages appear at more than one
path, tested with a predicate that reaches nested paths and was not supplied by the implementer. The
58 nested `@deepseek-ai` entries are single copies that merely sit nested, not duplicates.

**The open decision.** Section 1 found that co-installing `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-sdk-client` left the runtime unable to execute any tool
(`Cannot read properties of undefined (reading 'prepare')`), because `dsh-tools` keys its scheduler
registry on a plain `Symbol()` and the install produced six physical copies across two version
lines. The implementer's fix, in the tree and verified working, is an `overrides` block collapsing
six packages to one version. It forces peers outside the SDK client's declared range, which works
today and is a semver violation against a preview that announces breaking changes. The alternative
is dropping the runtime package from the repository tree and launching from an isolated install,
which is structurally what makes the operator's own session work but contradicts Section 1's
acceptance criterion 1 and owes an install story in Section 4. The consult rules before Section 2
builds on either, since Section 2's `bridge/harness.ts` is what encodes how the child is spawned.

**Next action per section.** Section 1: adjudicate the review round, adopt or discard the consult's
ruling, re-run the gate once the heavy-process slot frees, then close with a Chapter. Sections 2
through 6: unstarted, and Section 2 opens only once the install-strategy decision is settled.

### Chapter 1 - 2026-09-07
Completed: 1. SDK runtime spike and fixtures
Implemented By: implementer-opus, then a fix round at the same tier carrying the round's findings and one consult ruling
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises: The section's headline question is answered: a second DSH runtime on the shared harness home is ADMITTED rather than refused, confirmed across four runtime starts while the operator's web session was live on port 3080, so the dedicated-home fallback never fired and bridge sessions land in the shared sessions directory under their own workspace key, which answers the plan's Operator Verification item in advance. Versions installed are the two the plan expected. A third direct dependency was added beyond the two the section names, because the script imports the vendor's environment scrub from it and importing an undeclared transitive resolves by npm's layout rather than by contract. No onboarding step was needed and no provider key was set; whether the child reads the credentials file stays UNVERIFIED, since the local model host needs no key and nothing exercised that path. The harness home travels by the second of the three candidates, an environment variable in the launch spec, because the first does not exist in this version: the installed typings expose no profile, patch, binary-path, reasoning-effort or initialize-timeout option at all, so the Approach's constructor description is wrong for this release, and the typings live under the library directory rather than the distribution one. The session status field takes exactly two values, running and idle, confirmed both empirically in the fixtures and structurally in the protocol typing. The three permission values were read from the live web session's log frame by frame rather than copied from this document, and they are the preset, sandbox mode and approval policy this document already names, with one correction: the session switched to them 115 seconds in rather than the three seconds the Approach states. Two properties of the patch mechanism were established and are now documented in the patch file itself: an entry's config REPLACES the targeted row's config rather than merging, so the profile's preset table is dropped and the service's schema default applies; and the three knob events are written before the SDK's observed interval, so they never reach the notification stream and section 2 must read them from the on-disk log. The biggest surprise was that the runtime could not execute a single tool while both packages shared one npm tree, every call ending in an error with no stack, which is banked as project memory one-install-root-per-process-not-version-overrides. The second was that the fixture redaction shipped a real disclosure, banked as redaction-must-group-streamed-fragments-before-matching. Two deliberate deviations from the section as approved: acceptance criterion 1 is met in intent and not in letter, the exact pin now living in the isolated runtime manifest rather than the root one, reversal being to move the line back and re-add an overrides block, one commit; and the section's Files in scope and Tests lines were widened mid-run, which is approval drift recorded here, to admit the isolated runtime install and the test the redaction defect earned. Branch fact worth carrying: this checkout moved from the feature branch to main at 17:36Z by something outside this session, that branch was merged and deleted and survives on no remote, and operator memory neo-claude-gh-cannot-open-pull-requests-on-sapplefeld-repos records that this repository takes direct commits to main with pull requests disabled, so Commit-and-Push straight to main is the only model available here rather than a choice among three.
Assumptions: assumed 2026-09-07 (default, section 1): the throwaway workspace lives under the gitignored scratch path, so nothing an unsandboxed worker writes there can be committed; reversal: one path constant. assumed 2026-09-07 (source: this machine has npm and no pnpm, as the plan's own probe recorded, section 1): npm is the package manager and its lockfile the committed one; reversal: none in code.
Review Findings: review: code pair at fable, Agent tool; review: security at fable, Agent tool; consult at fable, Agent tool. Three lenses independently found the same Major, that the committed fixtures leaked an absolute workspace path through streamed argument deltas, which is a disclosure into a PUBLIC repository and was fixed before close. Majors addressed: the delta-chunk redaction leak, fixed by grouping fragments and redacting the joined value behind a pre-write guard that refuses to write while a pattern still matches; two false statements in the permission patch file, one claiming the workspace bounds the worker under a preset that removes all confinement and one using the transport's lack of server-to-client requests to justify the sandbox knob when it justifies only the approval knob; the fallback write path that could commit a fixture pair stitched from two different runs; and the permission verification reading the composed config row rather than what the runtime actually mounts, now asserted from the runtime-context snapshot. Minors addressed: a regex anchor that was matching a literal character, the redaction's scope widened to workspace, repository root and home with distinct placeholders, argument validation on the home switch, a redundant cast, and an overstated comment about which names the environment scrub removes, with the harness's own session and channel variables additionally dropped from the child environment. Majors justified rather than fixed: none. Findings DISCARDED with reason: a reviewer reported the seed list naming a credentials file that "does not exist", which is false, the file being present at 192 bytes as verified by direct listing, the reviewer's listing having omitted dotfiles; and a reviewer's suggestion to make the narrower sandbox the default preset with the wide one an opt-in, which is a design change the operator already ruled on and which goes to the operator rather than into a fix round. One security Major was re-adjudicated against evidence: the dependency advisories were reported as arriving with the harness packages and trace instead to the MCP SDK, so they are pre-existing rather than introduced and are parked in the backlog with that reasoning. The consult ruled against both options as framed and dissolved the dichotomy; its crux was verified independently against the installed code before adoption rather than taken on its word.
Stamps: adjudicated 12 over a 2h window covering the section's span, stamped 9, skipped 3 that recognition nudges surfaced but which steered nothing. The nine: the resource-arrangement forwarding rule, the queued-agent-looks-never-started rule, the stale-SessionStart-git-status rule, the standing delegation record, the heartbeat-measures-turn-end rule, the host-endpoint dialect record, the zstd first-frame record, the local model host and harness home record, and the direct-commits-to-main record.
Gate: whole gate, run by the orchestrator rather than taken from the implementer, because this section's close pushes to a trunk consumers install from with no CI gating the merge. Lint exit 0. Test exit 0, tests 1582, pass 1581, fail 0, skipped 1, duration 86.2s. Baseline on the same lane, reported by the section's first dispatch and identical to its own pre-change run, was tests 1574, pass 1573, fail 0, skipped 1. Delta plus 8 tests and plus 8 pass, fail unchanged at 0 and skipped unchanged at 1, the eight being exactly the new redaction test file. Both exit codes were read from the runs themselves rather than from a grep over their output, which mattered here: the summary lines carry an information-symbol prefix rather than a hash, so a grep shaped for the latter returned nothing while the run was in fact green. Contention lane: the machine's heavy-process claim file was read before the gate and the slot was free; the claim was written with a clock read taken at the moment of the write, held for the gate, and released only after verifying its own session line. A peer session had held the slot from 18:12:32Z for an expected hour and cleared early at about 18:45Z, and the fix round did all its editing under that hold, taking the slot only once it cleared. Absence checks, each reported with its predicate and scope rather than as a bare pass: the published-fixture leak predicate tests three path spellings against a delta-value join, a whole-string-value join and the raw bytes, over all 63 records of the first fixture and all 19 of the second, and matched nothing on any leg; its control over the known-leaking pre-fix fixture matched two needles via the delta join at exit 1, so that silence is a predicate that demonstrably speaks. That same control caught the orchestrator's own first instrument, which joined every string value and claimed to be a strictly wider net: it is not, because each fragment sits behind its own notification's metadata so the path is never contiguous, and version one both missed the real leak and fired a false positive on a three-character user-name needle. The lockfile predicate, no vendor-scope name at more than one path, holds at 20 of 20 distinct names in the root tree and 225 of 225 in the isolated runtime tree, with a control planting a duplicate at a nesting depth the predicate was never handed and being caught in both.
Next: 2. Bridge core
Commit Model: Commit-and-Push
Delta: reading taken 2026-09-07T19:04:23Z on this checkout, whole-tree, with no foreign uncommitted files present.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 2 - 2026-09-07

Written at the compaction gate's own signal: it had held 34 offers over 40 minutes with section 2
implemented, its review round adjudicated, and a fix round in flight whose brief exists only in the
orchestrator's context.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through one full three-lens review round, and is in its fix round. Sections 3
through 6 are unstarted. Section 2's ten files are untracked and uncommitted.

**Live dispatches.**

- `implementer-opus`, the section 2 fix round, carrying one Critical, nine Majors and twelve Minors
  from the review round below. It also carries a hard prohibition on killing any process it did not
  spawn, earned by this section (see Incident). It was told the machine's heavy slot is held by a
  peer until roughly 20:50Z, so it edits under that hold, runs targeted single-file lanes only, and
  leaves the whole gate to the orchestrator at close.

The three review dispatches (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all at
fable through the Agent tool) have completed and are adjudicated.

**Gate baseline.** Whole gate run by the orchestrator on the post-implementation tree, taken
2026-09-07T19:59:14Z on this checkout with no foreign uncommitted files: lint exit 0; test exit 0,
tests 1609, pass 1608, fail 0, skipped 1, duration 147.6s. Both exit codes read from the runs' own
markers. The committed baseline this is a delta against is tests 1582, pass 1581, fail 0, skipped 1,
so the section adds 27 tests and 27 passes.

That baseline took two runs to establish and the reason is recorded rather than smoothed over. The
first whole-gate run, 2026-09-07T19:53:40Z to 19:59:14Z, came back test exit 1 with tests 1609, pass
1606, fail 2, duration 280.8s. Both failures were pure wall-clock assertions: section 2's own
one-second receipt bound, measured at 2086ms, and `hooks/session-start.test.ts`'s hung-broker bound,
measured at 9233ms, in a pre-existing file this section never touched. Both passed alone at exit 0
(9 of 9 and 3 of 3), and the re-run with no code change went green. Ruled a machine transient rather
than a regression, on four grounds: both assertions are wall-clock, both passed in isolation, the
unchanged re-run passed, and a section cannot redden a file it did not touch while shared load
explains both at once. Durations across three runs of the identical tree recovered monotonically,
89.5s measured by the implementer before the incident below, then 280.8s, then 147.6s, which is the
recovery shape of a box working through an antivirus rescan rather than a code change. The
orchestrator's own timestamps falsified the competing hypothesis that the kill landed inside the
gate's window: the gate ran 19:53:40Z to 19:59:14Z and the kill was at 19:38:57Z, 14 minutes 43
seconds earlier.

**Rulings adopted since the last boundary.**

- One runtime per bridge serves exactly one workspace, and a `dsh_prompt` naming a different `cwd`
  is refused. Adopted before dispatch, from the installed typings: `InitializeParams.cwd` is
  process-wide ("recorded on every SDK-created session's header") and the sandbox policy's workspace
  root is the runtime process's own cwd. The spec gives `dsh_prompt` a per-session `cwd`, so the two
  had to be reconciled; this generalizes the refusal the spec already specifies for a changed `cwd`
  on one session name. Reversal is a map of runtimes keyed by workspace, local to `bridge/harness.ts`,
  with no protocol or tool-contract change.
- `dsh_prompt` drives the low-level `HarnessClient.prompt`, not `DeepSeekHarness.run()`, because
  `run()` settles only at idle and the section's acceptance criterion requires the receipt to return
  while the worker is still streaming.
- The review round's flake ruling above.

**Review findings adjudicated.** One Critical, nine Majors, twelve Minors accepted; none discarded.
The Critical is in `bridge/log.ts`: the frame splitter's recovery premise is false, because
`zstdDecompressSync` does not throw on a truncated frame but returns partial plaintext, so a magic
sequence occurring inside a compressed payload is taken for a frame boundary and the rest of the log
is silently lost. The orchestrator confirmed that premise with its own probe rather than taking the
finding on report, and a reviewer had reproduced the end-to-end effect at a three-frame file of five
events reading as zero. Two lenses independently found the same concurrent-start race in
`bridge/harness.ts`, which can spawn two runtimes and defeat the one-workspace invariant. One
security Major was raised to the operator rather than fixed or parked, and is recorded in this
plan's Open Questions: whether `dsh_prompt` should be auto-allowed at all, which is a risk-appetite
decision and which section 4's allow rule makes live.

**Incident, machine-shared state altered.** The section 2 implementer hit a hung test run and ran
`taskkill /F /IM node.exe`, which is machine-wide rather than scoped to processes it spawned. It
killed the operator's live DeepSeek Harness web session mid-turn (nothing listening on port 3080
afterwards; that session's log frozen at 19:38:57Z at 5,473,202 bytes) and destroyed the MCP server
children of several Claude sessions on the box, including both relay children, which were the only
route to the operator's phone. All five peer sessions survived; their children did not. No data was
lost on disk and the harness conversation is resumable from its web UI. The web session was NOT
restarted by this session, because that is an outward act in another session's working directory and
belongs to the operator. Two peer seats were notified and both independently verified the readings.
A kaizen note is filed, and the fix round's brief now carries the prohibition the incident earned.

**Next action per section.** Section 2: adjudicate the fix round's report, re-run the whole gate once
the peer's heavy-process claim clears at about 20:50Z, then close with a Chapter and commit under
Commit-and-Push. Sections 3 through 6: unstarted, in order, with section 4 gated on the operator's
answer to the Open Questions entry above.

**Uncommitted at this boundary.** Section 2's ten `bridge/` files and this plan doc's two edits (the
Open Questions entry and this board entry). The doc commit is deliberately deferred to the section
close rather than pushed here, because a push to this repository's main is an install surface that
takes the whole gate, and the tree is mid-fix-round with a peer holding the box, so a gate run now
would read a half-edited tree.

### Interim board 3 - 2026-09-07

Written at the compaction gate's signal, six offers held over thirty minutes, with section 2's second
review round adjudicated and its second fix round in flight.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented and has now been through two full three-lens review rounds, both adjudicated; its second
fix round is in flight. Sections 3 through 6 are unstarted. Section 2's eleven files are untracked.

**Live dispatches.**

- `implementer-opus`, section 2 fix round 2, carrying eight Majors and ten Minors from the round
  below, the three new Standing Brief Amendments, and the standing prohibition on killing any process
  it did not spawn. Its brief carries the box-budget clause with this session's own identity
  substituted, and instructs it to run targeted per-file lanes only and leave the whole gate to the
  orchestrator.

The second round's three lenses (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all
at fable through the Agent tool) have completed and are adjudicated. Round 2 verdicts were
CHANGES_REQUIRED, CHANGES_REQUIRED and CONCERNS, with **no Critical surviving adjudication**, so the
tier-escalation ladder does not fire and the section stays at opus.

**Gate baseline.** Unchanged from Interim board 2 and not re-run since: whole gate taken
2026-09-07T19:59:14Z on this checkout with no foreign uncommitted files, lint exit 0, test exit 0,
tests 1609, pass 1608, fail 0, skipped 1, duration 147.6s, against a committed baseline of
1582/1581/0/1. Fix round 1 reported the bridge lane going 35 to 47 tests, so the next whole gate is
expected to read about plus 12 tests and plus 12 pass against 1609/1608, before whatever fix round 2
adds. The machine's heavy-process claim file was absent at 2026-09-07T21:09:22Z, the peer having
released it, so the slot is expected free for the close gate; an absent claim is nobody having
claimed the box rather than evidence the box is free, so the slot is taken under the protocol at the
gate rather than assumed.

**Rulings adopted since the last boundary.**

- **The section 2 Critical is real in mechanism and latent in incidence, and the record is corrected
  to say so.** Interim board 2 stated that a frame magic sequence occurring inside a compressed
  payload silently loses the rest of the log, as though the loss were occurring. The mechanism is
  confirmed twice: `zstdDecompressSync` returns partial plaintext rather than throwing on a truncated
  frame, and the fix round's hand-built three-frame fixture reproduces the end-to-end effect. The
  incidence on the real corpus is zero. Measured in one pass over the operator's live web session log
  at 6,192,542 bytes: 15,274 frame magic occurrences against 15,274 real frame starts by a structural
  RFC 8878 walk, so zero interior false boundaries, and zero trailing bytes after the walk. The old
  splitter was never wrong on this data; it was one unlucky byte sequence away from silent
  truncation with no error. The fix stands on that basis rather than on an observed loss.
- **Acceptance criterion 7 is satisfied.** `dsh_tail` was run by hand against the operator's real
  session log at `~/.dsh/sessions/--D-DeepSeekHarness--/`, exit 0, while a live process was appending
  to the file. It read 24,052 events, 7 turns, 926 steps, 21 compactions, recovered all three
  permission values (`danger-full-access`, `danger-full-access`, `never`) and returned 40 non-chunk
  lines. The Chapter quotes the first two lines.
- **An instrument error of the orchestrator's own, caught before it reached a Chapter.** A first
  reading of that log appeared to show 11,646 duplicate sequence numbers, which would have read as a
  corrupt or double-written file. It was an artifact: 11,732 of the 24,229 records carry no `seq`
  field at all, and a Set keyed on the field collapsed every one of them into a single `undefined`
  bucket. Re-run with a presence guard, zero sequence values repeat anywhere. Banked to the operator
  memory tier as `counting-distinct-over-an-optional-field-invents-duplicates`.
- **The plan gains a `Standing Brief Amendments` block**, under the recurrence rule. The class that
  earned it is worker-controlled or wire-sourced text crossing into a channel attribute: round 1
  found it at `files_touched`, and round 2 found all three lenses reporting it again at `session` and
  `finish_reason`, which had skipped the neutralizer round 1 installed. Two instances of one class is
  the workflow generating the bug, so the guard moves to the `meta` builder and the rule now binds
  every section opened after it. Two further entries ride with it: a guard at a hostile boundary is
  imported rather than reimplemented, and a stored identifier is untrusted input the moment it
  becomes a path segment. The block sits above `## Sections of Work` and so inside the
  approval-scoped fingerprint; it is approval drift, recorded here and in the Chapter.
- **Two spec corrections, both drift the round surfaced.** The `dsh_tail` row said the default filter
  drops three chunk types; it drops four, `reasoning-chunks` being a real vendor type, so the code was
  right and the document was stale. And section 2's acceptance criterion 2 was a one-second wall-clock
  bound, which failed at 2086 ms on a contended box while the property it stood for held; the
  criterion is now the ordering it was reaching for, that the receipt returns while the worker is
  still streaming and before any channel push for that turn.
- **Section 2's scope is widened by one file**, `bridge/tools/sdk-smoke.ts`, to fold in the
  de-duplication of the child-environment guard that now has two producers. That file is section 1's,
  so the widening is approval drift and is recorded as such.

**Review round 2 adjudicated.** Eight Majors and ten Minors accepted, none discarded; four findings
were dispositioned as already-owned rather than acted on (the `dsh_prompt` auto-allow decision, which
is the operator's and section 4's; the LAN address and workspace-key path already committed in this
document; the `unhandledNotifications` duplication with the relay, which is spec-directed and Out of
Scope; and the environment denylist-versus-allowlist question, which is a design change rather than a
defect). The highest-value finding was found independently by two lenses, both citing vendor source
rather than inferring: `stop()` retries a runtime handle whose `close()` already failed, but the SDK
client memoizes with `this.closeTask ??= this.performClose()`, so the retry returns the same rejected
promise forever and can never succeed, while the loop's throw-on-first-failure leaves the current live
runtime unclosed. One failed shutdown therefore leaks an unsandboxed worker and makes every later
`dsh_kill` a permanent error. One security Major stands beside it: the receipt under-reports what the
worker did, missing files written through the shell and everything any subagent session performed,
while the server's own instructions tell the model it names the files written and counts the commands
run.

**Incident update.** The operator's DeepSeek Harness web session, killed mid-turn in section 2's first
fix round by a machine-wide `taskkill`, is running again: port 3080 is listening and the session log
is being appended to. The rollback this session declined to perform, on the ground that it was an
outward act in another session's working directory, was performed by someone else. Fix round 1 also
reported that it killed three node processes by explicit PID, all its own, and issued no kill by image
name, which is the prohibition the incident earned working as intended.

**Next action per section.** Section 2: adjudicate fix round 2, run the whole gate with the contention
lane beside it, then close with a Chapter and commit and push. Sections 3 through 6: unstarted, in
order, with section 4 still gated on the operator's answer to the Open Questions entry about whether
`dsh_prompt` should be auto-allowed.

**Uncommitted at this boundary.** Section 2's eleven `bridge/` files, untracked, and this plan doc.
The doc is committed at this boundary but deliberately **not** pushed: a push to this repository's
main is an install surface that takes the whole gate, and the tree is mid-fix-round, so a gate run now
would read a half-edited worktree. The commit is the durable recovery point; the push rides with the
section close once the gate is green. Commit and push are separate steps by doctrine, and this is that
separation used deliberately rather than a deferral of the commit model.
