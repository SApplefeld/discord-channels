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
| `dsh_tail` | `session`, `count` (default 40), optional `kinds` (an explicit allow-list of event types) | The last N events from the session log on disk, one line each, bounded per line. The default filter drops the three chunk types (`assistant/chunk`, `text-chunks`, `tool-call-chunks`) and admits every other type; `kinds` replaces the default with the list given |
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
`bridge/sdk.cordis.patch.yml`, `bridge/fixtures/`.

Tests: none earned; this section produces the fixtures section 2's tests consume.

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
- Against the fake, `dsh_prompt` returns within one second of the call with the session id and turn
  number while the fake is still streaming.
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

## Related

- [`../archive/plans/channel-quality-and-plugin_spec_v1.md`](../archive/plans/channel-quality-and-plugin_spec_v1.md):
  introduced the plugin route and the launch shim this plan clones.
- [`../archive/plans/sapplefeld-channels_spec_v1.md`](../archive/plans/sapplefeld-channels_spec_v1.md):
  the relay's design, whose server shape `bridge/index.ts` mirrors.

## Chapters
