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
| `dsh_status` | `session` | Whether the session is live (this bridge holds a running child with it) or stored (known by name with a log on disk and no child, after a kill or a bridge restart); whether a turn is in flight and the last notification time, both from the child; turn count, step count, compaction count and last event kind, all from the on-disk log, and where that log cannot be read at all, a report naming the reason with those four fields absent while every field above them is still answered, since whether the session is live, whether a turn is in flight and which turn it is never needed the log |
| `dsh_busy` | none | `true` when any session this bridge owns has a turn in flight, with the session names; the Reviewer consults it before starting a live test run |
| `dsh_tail` | `session`, `count` (default 40), optional `kinds` (an explicit allow-list of event types) | The last N events from the session log on disk, one line each, bounded per line. The default filter drops the four chunk types (`assistant/chunk`, `text-chunks`, `tool-call-chunks`, `reasoning-chunks`) and admits every other type; `kinds` replaces the default with the list given |
| `dsh_kill` | `session` | Terminates the DSH child. The session log survives on disk; the next `dsh_prompt` with the same name resumes it |
| `dsh_record_rotate` | `session`, `archive_path` | Moves the record file to `archive_path` and starts a fresh one; refused while that session has a turn in flight |

A turn is in flight from the moment the runtime accepts a `session/prompt` until that session's
`session.status` notification reports the agent idle, or `dsh_kill` ends it. `dsh_busy` and
`dsh_record_rotate` both key on that state. The status field carries exactly two values, `running`
and `idle`, established in section 1 both empirically in the fixtures and structurally in the
protocol's own typing, so there is no error status to end a turn: a turn that ended badly ends on
an idle like any other, and what went wrong is read off the `turn/end` event's `reason.kind`.

One channel event per finished turn. When a session's `session.status` reports idle after a prompt
was accepted, the bridge emits `notifications/claude/channel` with `content` =
the worker's final response, bounded at `MAX_CHANNEL_CONTENT` characters (12,000 as the initial
value; the overflow is in the record file and in `dsh_tail`), and `meta` =
`{ session, kind, turn, finish_reason, files_touched, commands_run }`. `kind` is `turn_end` for a
turn the runtime completed, `error` for one whose `turn/end` reason says it failed, and `killed`
when `dsh_kill` ends an in-flight turn, in which case
`content` is the last assistant text committed in that turn, empty if none; a kill with no turn in
flight emits nothing, and the bridge's own shutdown emits nothing, the session it would push to
being gone. Every meta value is a string: `turn` and `commands_run` are decimal counts,
`files_touched` is a comma-separated list of paths relative to the session's `cwd`, capped at
`MAX_META_FILES` entries (20 initially) with a trailing `+N` naming the remainder. Meta keys are
identifiers (letters, digits, underscores) because Claude Code drops any other key silently. The
server's `instructions` string is a static literal, as `relay/protocol.ts` does it, telling Claude
what the attributes mean and that the body is the worker's own text, data rather than steering.

The record. When `dsh_prompt` carries a `record` path, the bridge appends
`## <party> @ <ISO>` + the prompt text + `NEXT: <counterparty>` once the runtime has accepted the
prompt and before the receipt returns (never before sending, so a prompt the bridge refuses or the
runtime rejects leaves the record untouched), and on the turn's
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

- **The envelope guard is the bridge's second layer under Claude Code's own, its classes are
  Unicode's, and its test's yardstick is the product's.** Claude Code defends the channel envelope
  itself. It renders an event as an opening `channel` tag carrying a `source` attribute and the
  caller's `meta` keys, then the body, then the matching closing tag; every attribute value and the
  source alike pass through an XML escaper that turns `&`, `<`, `>`, `"` and `'` into entities, and
  the body passes through a close-only disarmer that rewrites a closing channel tag into a form the
  reader cannot resolve as one. That disarmer skips a filler class of roughly 4,700 code points
  between the tag's letters, folds 33 bracket and slash lookalikes onto their ASCII forms, and
  matches case-insensitively, so a closing tag spelled with an invisible character wedged between
  its letters, or with a fullwidth angle bracket, does not survive it. Three things it does not
  cover are what the bridge's guard is for: a forged tag that is not the channel tag, an *opening*
  channel tag rather than a closing one, and a tag name whose letters are themselves spelled in
  fullwidth or other lookalike letters, which the product matches literally. The bridge's guard is
  also the only layer on a build that lacks the product's, so it is kept rather than deleted.

  The bridge's classes are Unicode property expressions held in one exported definition, never
  enumerated ranges and never spelled a second time at a second site: a hidden class for what is
  replaced in attributes and refused in paths, and a wider filler class for what is skipped while
  spelling a tag name, the second being the allowlist stated as its complement. The one enumerated
  table is the delimiter-lookalike map, carried as data with the build it was read from named beside
  it. Both the attribute path and the body path resolve a code point through one resolver, so the
  two cannot come to disagree about what a character means, which is the drift that produced a
  finding inside a single file.

  The guard's test takes its yardstick from a fixture of the product's own classes rather than from
  the guard. That is what ends the circularity: a test whose oracle is built from the guard proves
  only that the guard matches itself, however many code points it walks, which is why five
  consecutive rounds each passed their test and each still found a gap. The test asserts that the
  bridge's class contains the product's, that hidden, filler and visible characters partition the
  code space, and that no spelling the fixture's reader resolves to a tag survives the guard, with
  enumerated spellings kept beside the property as regression pins rather than in place of it.

  Severity in this family is capped at Major until a live session is observed acting on a forged
  tag. Every rating of Critical so far has rested on an assumption about how a model reads an
  unusual tag spelling that nobody has measured, and a reported spelling counts as a finding at all
  only if the fixture's reader resolves it to a tag.
- **A guard at a hostile boundary is a property of the boundary, so a second caller imports it rather
  than reimplementing it.** Before writing a call that spawns a process, builds a child environment,
  joins a path from stored data, or sanitizes text bound for a trusted channel, grep the tree for
  that boundary's other callers and reuse the guard one of them already exports. Where the owning
  file sits outside the section's `Files in scope:`, name the file, the guard and the export it needs
  in the report and leave it unedited rather than cloning it.
- **Every stored value is untrusted input the moment it reaches the filesystem, and the check is
  owed field by field rather than to the field that earned the rule.** Anything read back from the
  bridge's own state file is shape-checked before it is joined into a path, opened, statted, or
  handed to a child process as a working directory. Enumerate the record's fields at the read and
  say which guard each one takes; a field admitted on `typeof value === "string"` alone has not been
  checked. This entry was first written naming session ids, and the next round found the same class
  at the stored workspace path, which had been admitted as a bare string and reached `statSync` and
  the spawn. An absolute-path test is not that guard on Windows: a UNC path is absolute, so the
  first filesystem call on it opens an outbound connection to a host the caller named, under the
  operator's credentials, before any refusal can run.
- **A claim about a runtime artifact is settled against that artifact, never against a second one
  that resembles it.** This vendor emits several streams that carry the same event vocabulary in
  different shapes: the SDK notification stream, the on-disk session log, and the composed
  configuration tree are three different surfaces, and a reading taken from one is evidence about
  that one alone. So before a guard, a filter or a default is set from a measurement, name the
  surface the code under it will actually read at run time, and take the measurement there. Where
  the real surface cannot be read at all, the value is marked inferred and the section that can
  observe it is named, rather than a stand-in being measured and reported as though it settled the
  question. The class has now produced three defects in as many rounds, and each had the same
  shape: the stand-in agreed with the claim, so the check came back green and the real surface was
  never opened. Section 1 verified the permission preset against the composed config row rather
  than against what the runtime mounts, and the bridge's log reader had its chunk filter narrowed
  on a count taken over the SDK notification fixtures while the reader itself reads the on-disk
  log, where the types it had stopped dropping are the two most numerous in the file.

  The third instance is the same generator at run time rather than at the keyboard, so the rule
  has a second half. **A check whose subject is shared between processes reads the shared artifact
  at the moment of the check, never a copy of it this process is holding.** An in-memory map loaded
  at construction, a value cached at startup, a snapshot taken before a wait: each is a second
  artifact that resembles the first and agrees with it exactly until the moment another process
  changes the original, which is the only moment the check exists for. So a guard that answers
  "does another process hold this" opens the file, and one that cannot is not a guard against
  another process. The instance: the per-session ownership lease was read from a map populated once
  in the bridge's constructor, so two bridges started before either prompted each saw no owner and
  the second resumed a session id the first was already running. The machine's own heavy-process
  protocol is the worked example of the rule, and it is written this way for exactly this reason:
  the claim file is read immediately before the spawn rather than at the top of the run, and a
  claim's age is taken from the file's modification time rather than from a line inside it.

  The fifth instance arrived as the vendor's own prose rather than as a neighbouring stream, so the
  rule has a third half. **A vendor document is not the runtime, in either direction: it cannot
  settle a claim about behaviour, and its silence cannot settle one either.** A document is evidence
  about what the vendor wrote down, which is a fact about the document. So a premise the code depends
  on is marked inferred until the runtime has been observed, and it is marked inferred just the same
  when a document agrees with it, because a document that agrees is the resembling artifact this
  amendment is about. What a contradicting document does buy is a bound on confidence rather than a
  measurement: it establishes that the premise is contested, which is enough to route the behaviour
  to whichever branch is safe under uncertainty and to name the section that can observe the truth.
  The instance: the bridge asserted throughout its comments and its README that a session id whose
  log is absent is refused on the resume that would use it, and built a first-turn timeout branch on
  that assertion, while the SDK it drives documents at `lib/index.js:335` and
  `lib/types/client.d.ts:92` that an unknown id creates the session instead. Neither sentence was
  ever measured against a runtime. Note what the earlier halves would have missed here: the first
  half asks which surface the code reads at run time and the answer was correct, since the code does
  read the runtime, and the defect was that nobody had read it yet while the prose spoke as though
  somebody had.

  The rule has a fourth half, and it is the write side of the second. **A guard against another
  process is worth only what is visible to that process at the window's start, so the claim is
  published before the act it guards rather than after the act succeeds.** The second half fixed the
  read: open the shared file at the moment of the check. That leaves the other end untouched, and a
  guard can read the file faultlessly and still see nothing, because the fact it is looking for has
  not been written yet. So name the window a guard is meant to cover, then check that the claim
  reaches the shared artifact before that window opens; where the claim is written only once the
  guarded act has returned, the guard covers every moment except the one it exists for. The
  publication and the reading are one mechanism and a round that repairs one of them has repaired
  half a guard. The machine's own heavy-process protocol is the worked example on this side too, and
  in the same detail: the claim is written *before* the spawn, never once the suite is running, and
  it is deleted after the operation ends rather than when the turn does.

  The instance, which is this class's third in three rounds and the fifth time in this section that
  a fix has left open the case it was written for: the per-session ownership lease is set in memory
  with this process as owner before the prompt is sent, and reaches disk only once the runtime has
  answered the prompt request, which is bounded by the request timeout rather than by anything
  quick. A second bridge in the scope, prompting inside that window, reads the file correctly under
  the second half's rule, finds the previous run's dead owner or no owner at all, takes the name, and
  resumes the same session id in a second runtime. That is the two-unsandboxed-workers-on-one-log
  hazard the lease exists to prevent, surviving a lease. The two earlier instances are the same
  mechanism read from the other end: the lease read from a snapshot taken in the constructor, and the
  held record replaced by a stale copy from the file.

  The rule has a fifth half, and it closes the gap the fourth one narrowed. **A check and a
  publication are two acts, and the interval between them belongs to whoever else is reading, so the
  publication is conditional on the state the check read rather than unconditional on the artifact.**
  The second half fixed where the check reads. The fourth fixed when the claim is published. Both
  leave a guard that reads correctly, publishes on time, and still admits two winners, because
  nothing ties the write to the read that authorized it: the check says the name is free, the write
  says the name is mine, and between those two sentences another process runs both of its own. So a
  claim against another process is written as a compare-and-set against the shared artifact, its edit
  refusing where the artifact now carries another live claimant and reporting that refusal to the
  caller as a contested claim, or, where the write cannot be made conditional, verified by a read
  after it that reverts and refuses on finding a foreign claim. Naming the residual window is part of
  the rule rather than an apology for it: a conditional edit reduces the exposure to a preemption
  between two adjacent synchronous calls, which is not zero, and a document that says the hazard is
  closed where the code has narrowed it is the resembling-artifact defect in prose.

  The same rule governs every later write that touches a shared name, not only the claim, and that is
  where this instance actually bites. A write filtered on "records this process owns" is filtered on
  the wrong question: it establishes that this process believes it owns the name, never that the
  artifact agrees, so a turn-count write landing after a neighbour legitimately took the name
  overwrites a live lease with a stale one and the neighbour is refused mid-conversation by a claim
  that was already dead. The filter that keeps a claim alive through a write and the filter that
  decides whether the write may touch a name are two different filters, and one standing in for both
  is this class's shape again.

  The instance, which is this class's fourth in four rounds and the sixth time in this section that a
  fix has left open the case it was written for: the fourth half's own repair moved the lease's
  publication ahead of the prompt, and the write that publishes it lays this bridge's records over the
  file unconditionally, so two bridges that both read the name as free both publish, the later rename
  wins whole, neither is told, and both prompt the same session id in two runtimes. The turn-count
  write at a turn's end reaches the same unconditional edit from the other direction. All three review
  lenses found it independently in one round, from the spec, from the diff alone, and from the threat
  model, which is what a defect on a guard's own axis looks like when the guard has been repaired
  three times without the write being made conditional. The conditional shape was already in the same
  file thirty lines from the defect, in the claim's own release path.

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
- The turn-end handler hands the uncapped final response to its listeners, and only the channel
  notification builder cuts at `MAX_CHANNEL_CONTENT`, so section 3's record append receives the full
  text. Pinned: a final response longer than the cap reaches the turn-end listener whole.
- `dsh_busy` is `true` between acceptance and the idle status and `false` outside it.
- `dsh_prompt` with a `cwd` that differs from the remembered one for that name is refused, and
  stays refused after `dsh_kill`, the refusal naming the workspace the name belongs to and telling
  the caller to use a different name to work somewhere else. A session name is bound to its
  workspace for the life of its conversation, because a DSH session's log is filed under the
  workspace it was created in and reusing its id anywhere else is refused by the runtime, so
  re-pointing a name would have to abandon the conversation the state file exists to preserve. The
  criterion first read that a differing `cwd` was accepted again after a kill, which is the opposite
  of what a kill means here: a kill ends the runtime and deliberately keeps the record, so that the
  next prompt for that name resumes the same DSH conversation in the same workspace.
- `dsh_kill` terminates the child and the next `dsh_prompt` for the same name reuses the persisted
  DSH session id and `cwd`.
- `dsh_tail`, run by hand against the web session's log at
  `~/.dsh/sessions/--D-DeepSeekHarness--/`, returns the last 40 non-chunk events; the Chapter quotes
  the first two lines. No unit test reads that file, since another process appends to it.

Files in scope: `bridge/index.ts`, `bridge/protocol.ts`, `bridge/harness.ts`, `bridge/log.ts`,
`bridge/fake-dsh.ts`, `bridge/*.test.ts`, `bridge/README.md`, `bridge/env.ts` (the child-environment
and runtime-binary guard, which gained a second caller and so became a shared module rather than a
private helper), and `bridge/tools/sdk-smoke.ts` (section 1's file, which becomes that guard's other
caller). The last two are widenings recorded in the Chapter as the approval drift they are.

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
`record` argument appends the party section once the runtime has accepted the prompt, never before,
so a refused or rejected prompt leaves the record untouched, and remembers the path for the session;
turn end appends the counterparty section from the same final response the channel carried, in
full, not capped; `dsh_record_rotate(session, archive_path)` moves the file with `rename`, refuses
while any session whose record path is the same file has a turn in flight (two names may share one
record, so the refusal keys on the file rather than on the named session), and starts a fresh file
carrying the original file's leading header
block, meaning every byte before the first line that begins `## `. Timestamps are the real clock in
ISO 8601 UTC. Section text is written verbatim: the bridge never edits, summarizes, or escapes what
either party wrote.

Acceptance:

- A prompt with `record` produces exactly one appended section ending in `NEXT: <counterparty>`,
  and the finished turn exactly one more ending in `NEXT: <party>`, byte-identical to the inputs
  between the header and the `NEXT:` line.
- A prompt the bridge refuses (a `cwd` mismatch) or the runtime rejects appends nothing to the record.
- A rotate during an in-flight turn is refused with a message naming every session holding a turn on
  that file, the idle name that asked included when another name shares the path; after the turn it
  moves the file and the new file's first bytes equal the old header block.
- A missing record file is created. A `record` or `archive_path` that is relative, or that names an
  existing directory, is refused; the path is otherwise the caller's choice and is not checked
  against the session's `cwd`, since the record the plan exists to write sits in one directory while
  the worker runs in a worktree.

`dsh_prompt`'s own schema is this section's too. Section 2 built it with `additionalProperties: false`
and without `record`, `party` or `counterparty`, correctly, because nothing read them yet; the wire
therefore refuses those three arguments today, so adding them to the schema is part of making the
record work rather than a separate tidy-up. Section 2's review round surfaced this and it is recorded
here rather than fixed there.

Files in scope: `bridge/record.ts`, `bridge/record.test.ts`, `bridge/protocol.ts` (the tool schema
for `dsh_record_rotate`, and `dsh_prompt`'s `record`, `party` and `counterparty` arguments),
`bridge/index.ts` (dispatch).

Tests: lock the append-only property (an existing section is never altered), the refusal during a
turn including the shared-path case (two names, one record, one in flight), the refused prompt that
appends nothing, the relative-path and directory refusals, and the header carry-over on rotate.

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
list gains the same six so the installer merges them; the sixth, `dsh_prompt`, is composed on the
operator's answer of 2026-09-08 recorded under Open Questions (auto-allow, the chain recorded as an
accepted risk by section 6), never on this section's own reading. The install path gains the second
plugin wherever it names the first: `install/Install-All.ps1`'s `Install-ChannelPlugin` installs
`dsh-bridge@sapplefeld-channels` beside `relay@sapplefeld-channels` and checks both in the plugin
list, `install/Install-Elevated.ps1`'s managed-settings merge adds the
`{ marketplace: 'sapplefeld-channels'; plugin: 'dsh-bridge' }` row beside the relay's, and
`install/Install-All.test.ts` pins both rows and both installs. `docs/install.md`'s managed-settings
example gains the plugin's `allowedChannelPlugins` row, and its sentence that `Install-All.ps1`
installs and allowlists the plugin says plugins. This section also installs the plugin on this host
with `claude plugin install dsh-bridge@sapplefeld-channels` (after `claude plugin marketplace add`
for this checkout where the registration is stale) and records the command and its result in the
Chapter, so section 5's run meets an installed plugin rather than an allowlist refusal it cannot
repair from inside its own scope.

Acceptance:

- `plugins/manifest.test.ts` and `plugins/launch-shim.test.ts` are extended to cover the second
  plugin with the same pins they hold for the relay, and pass.
- `wrapper/launch-line.test.ts` pins that `-DshBridge` adds exactly the one entry and that its
  absence leaves the launch line byte-identical to today's.
- A new `bridge/allow-rules.test.ts` pins the six rule names against the fragment and against the
  tool names in `bridge/protocol.ts`, and `install/Install-Functions.test.ts` pins them against the
  installer's list.
- `install/Install-All.test.ts` pins the managed-settings allowlist as exactly the relay row and the
  bridge row, and the installer as installing and checking both plugins, and passes.
- **The bridge's execution chain is hardened by the installer, and pinned.** `install/Install-Host.ps1`
  hardens every path Claude Code or the bridge executes from, and until this section it names
  `hooks/`, `relay/`, `wrapper/`, `install/`, `broker/`, the token file and the state root, with no
  `bridge/` entry at all. Installing this plugin is what puts four new paths on that chain:
  `bridge/index.ts` and the rest of the bridge's own sources, which Claude Code runs through the
  plugin shim; `bridge/runtime/`, whose `@deepseek-ai/dsh` binary the bridge spawns; and
  `bridge/sdk.cordis.patch.yml`, which is the file that presets the worker's sandbox and approval to
  `danger-full-access` and `never`. Write access to any of them is code execution in the operator's
  context, and the patch file specifically lets an attacker change the worker's confinement without
  touching a hardened file. So this section adds `Protect-ChannelPath` entries for `bridge/` and
  `bridge/runtime/`, and `install/Install-Host.test.ts` pins them beside the entries it already pins
  for the relay. This criterion is the disposition of a security Major raised by section 2's
  thirteenth review round, and it lands here rather than there because the exposure does not exist
  until this section installs the plugin: section 2's files are not on any execution chain while the
  plugin is unregistered.
- `npm run lint` and `npm test` pass.

Files in scope: `plugins/dsh-bridge/.claude-plugin/plugin.json`, `plugins/dsh-bridge/.mcp.json`,
`plugins/dsh-bridge/launch.mjs`, `.claude-plugin/marketplace.json`, `plugins/manifest.test.ts`,
`plugins/launch-shim.test.ts`, `wrapper/Enter-ClaudeSession.ps1`, `wrapper/launch-line.test.ts`,
`hooks/settings-fragment.json`, `install/Install-Functions.ps1`, `install/Install-Functions.test.ts`,
`install/Install-Host.test.ts`, `install/Install-All.ps1`, `install/Install-Elevated.ps1`,
`install/Install-All.test.ts`, `install/Install-Host.ps1`, `bridge/allow-rules.test.ts`,
`docs/install.md`. The three `install/`
files after `Install-Host.test.ts` entered this scope at the 2026-09-08 plan review (Interim board
11) and left `## Out of Scope` the same day. `install/Install-Host.ps1` entered it at Interim board
13 and left `## Out of Scope` then, on the hardening criterion above.

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
since the worker shares the Qwen host and its live tests share the machine). The script also takes
the machine's heavy-process claim before launching and releases it after, per the role skill's claim
protocol; the `.kit/RUNNING` check is additional to that claim, never the boundary.

Acceptance, read from the transcript and the filesystem, never from the exit code alone:

- The channel registered: the "Channels" line of the startup notice names
  `plugin:dsh-bridge@sapplefeld-channels`, read from the interactive fallback launch below, or from
  the `-p` transcript only if that output format carries the notice, which is not assumed. If the
  allowlist refused it, the Chapter records the
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
- The scope key the bridge wrote into its state file is read and recorded. Section 2 keys that file
  by the bridge process's own working directory so two projects naming one worker keep their own
  sessions, and that this directory is the Claude session's project directory is inferred from the
  relay's launch shim spawning with an inherited working directory rather than confirmed: nothing in
  the channel contract states what Claude Code hands a plugin's MCP child. This run is what settles
  it. If the key turns out to be a fixed directory, every session shares one scope, the collision the
  scope exists to prevent returns silently, and the fix is a different discriminator in one function
  (`defaultScope` in `bridge/harness.ts`); the behaviour degrades to a single shared scope rather
  than losing data either way.
- The reader premise is measured rather than assumed. One extra prompt in the same run, sent under a
  second session name with no `record` argument so the two-section record criterion above stays
  untouched, has the worker emit a body carrying four forged-tag spellings: a `<system-reminder>` opening tag, a
  closing channel tag whose letters are fullwidth, one whose angle brackets are the mathematical
  lookalikes, and one whose `c` is the Cyrillic letter. The transcript is then read for whether the
  session treated any of them as structure rather than as text. This is the only observation that
  can give this family of findings a real severity: six review rounds rated a forged tag Critical
  on an assumption about how a model reads an unusual spelling, and nobody has measured it. A
  spelling the session acts on lifts that one spelling back to Critical and earns a fix; one it
  reads as text confirms the cap the amendments block now states.

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
verbatim. The same document's allow-rule paragraph (the one stating that one rule is merged into the
user-level settings file) is rewritten to count the bridge's six rules beside the relay's one, and
the `dsh_prompt` chain the Open Questions entry describes lands under its accepted-risks heading as
the operator's 2026-09-08 answer. That accepted-risk entry states the boundary as it actually is,
which is wider than the entry's own reasoning implies: the worker's workspace is checked for shape
and not for location, so any absolute drive-rooted directory the calling model names is admitted,
and the dedicated worktree the risk's reasoning leans on is a convention the operator and the
calling session keep rather than a confinement the code enforces. The document says so rather than
leaving an auditor to infer a bound that is not there. This sentence is the disposition of a
security Major from section 2's thirteenth review round, whose code half is the operator's recorded
decision (a workspace allowlist was one of the three options answered on 2026-09-08 and was not the
one chosen), leaving the record as the part still owed.
`docs/install.md` gains one line naming a Claude Code version floor of 2.1.260 for this
plugin, with the reason: from that build onward Claude Code escapes a channel event's attributes
and disarms a forged closing channel tag in its body, and the bridge's own guard is the second
layer under it; below that floor the bridge's guard is the only layer, which is a narrower defence
rather than none. Whether builds before 2.1.260 carry the layer is unknown rather than known to be
absent, and the line says so.

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
  (a test in `bridge/protocol.test.ts` reads the doc, pins the six tool names and the meta keys, and
  asserts that no other `dsh_`-prefixed identifier or `meta` key appears in it).
- The security model's egress paragraph names the host and port from `~/.dsh/settings.yaml`, its
  allow-rule paragraph counts seven rules across two plugins, and its accepted-risks list carries the
  `dsh_prompt` entry.
- `docs/README.md`'s reference table has the row; the Plans table row for this plan is present
  until the close-out moves it.

Files in scope: `docs/dsh-bridge.md`, `docs/README.md`, `docs/architecture.md`, `docs/install.md`,
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
  `docs/operations.md`, `docs/backlog.md`, `README.md`,
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
- ANSWERED 2026-09-08 (operator, keyboard; recorded by the CHANNELS Expert seat at the plan review):
  auto-allow, with the chain recorded as an accepted risk. The reasoning the operator accepted: the
  Reviewer session that drives the worker already runs with Bash pre-approved, so text able to steer
  it into one `dsh_prompt` call could steer it into Bash today, and a per-call prompt would add a
  click to every round while closing nothing; the workspace-allowlist option confines where the
  worker starts rather than what it reaches. Section 4 composes the rule on this answer and section 6
  records it. The question as it stood: should `dsh_prompt` be auto-allowed, and does the security
  model record what it composes? Raised
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

### Interim board 4 - 2026-09-07

Written at the compaction gate's signal, 68 offers held over forty minutes, with section 2's third
review round adjudicated and its third fix round in flight. The closure-drought floor is met twice
over: three review rounds have now been adjudicated on this section with no section closing.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented and has been through three full three-lens review rounds, all adjudicated; its third fix
round is in flight. Sections 3 through 6 are unstarted. Section 2's twelve untracked `bridge/` files
and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-opus`, section 2 fix round 3, carrying seven Majors and fifteen Minors from the round
  below, the two sharpened Standing Brief Amendments, the standing prohibition on killing any process
  it did not spawn, and the box-budget clause with this session's identity substituted. It is told to
  run targeted per-file lanes only and leave the whole gate to the orchestrator. Four findings are
  named in its brief as explicitly not its work, so it does not spend a round rediscovering them.

Round 3's three lenses (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all at fable
through the Agent tool) have completed and are adjudicated. All three were confirmed to have run at
the tier they were dispatched at rather than silently downgraded, read from their own transcripts.
Verdicts were APPROVED_WITH_CONCERNS, CHANGES_REQUIRED and CONCERNS, with **no Critical surviving
adjudication**, so the tier-escalation ladder does not fire and the section stays at opus.

**Gate baseline.** Unchanged and not re-run since Interim board 2: whole gate taken
2026-09-07T19:59:14Z on this checkout with no foreign uncommitted files, lint exit 0, test exit 0,
tests 1609, pass 1608, fail 0, skipped 1, duration 147.6s, against a committed baseline of
1582/1581/0/1. Fix round 2 reported its own per-file lanes at env 3, protocol 11, log 12, index 8,
redact 8, harness 21, all exit 0, against its starting protocol 9, log 8, index 7, harness 15, so
plus 21 tests on those lanes. Those are the implementer's numbers on the implementer's tree and are
not a whole-gate reading; the close gate is the orchestrator's and has not run. The machine's heavy
slot was taken by a peer at 2026-09-07T21:54:56Z for 1800 seconds, so it is expected free from about
22:25Z; an absent claim is nobody having claimed the box rather than evidence the box is free, so the
slot is taken under the protocol at the gate rather than assumed.

**Rulings adopted since the last boundary.**

- **The claim that Claude Code escapes a channel event's body is unsupported, and the amendment is
  widened to cover the body.** The bridge's code and the relay's alike assert that Claude Code owns
  the envelope and the escaping inside it. Claude Code's published channels reference documents
  `content` only as the body of the `<channel>` tag and states no escaping of content or meta
  anywhere; what it does describe, for untrusted senders, is a sender check rather than an escape,
  and it names an ungated channel as a prompt injection vector outright. The asymmetry is the tell:
  the same document says the client sanitizes `description` and `input_preview` when relaying a
  permission prompt outward to a channel, so the product sanitizes the channel-facing direction and
  documents nothing for the session-facing one. Standing Brief Amendment 1 is therefore widened from
  the attributes to the whole event, attributes and body alike, this being the class's third site.
  The exposure is not equal across the two channels that share the pattern: the relay's senders are
  an account allowlist, which is exactly the defence the vendor names, while this bridge's sender is
  an unsandboxed worker reading arbitrary files and command output and is not gated at all. So the
  bridge takes the guard in this section and the relay's version is routed to the backlog as a
  decision for the operator rather than a defect fixed on sight.
- **Standing Brief Amendment 3 is sharpened, because it was under-applied at the first opportunity.**
  It was written in round 2 naming stored session ids. Round 3 found the same class at the stored
  workspace path, which was admitted on a bare string type check and reached `statSync` and the
  spawned child's working directory. The amendment now requires the check field by field, with the
  record's fields enumerated at the read and each one's guard named, and it records that an
  absolute-path test is not that guard on Windows: a UNC path is absolute, so the first filesystem
  call on it opens an outbound connection to a caller-named host under the operator's credentials
  before any refusal can run. An amendment naming an example rather than an enumeration is read as
  covering the example.
- **Two findings correctly belong to other sections and are recorded there rather than fixed here.**
  Section 3 gains the `dsh_prompt` schema arguments: section 2 built that schema with
  `additionalProperties: false` and no `record`, `party` or `counterparty`, correctly, since nothing
  read them yet, which means the wire refuses all three today and section 3's brief must carry the
  schema edit or its own feature is unreachable. Section 5 gains an acceptance line reading the scope
  key the bridge writes into its state file, which settles by observation the one claim this section
  leaves inferred.
- **The scope key stays inferred, deliberately.** Section 2 keys its state file on the bridge
  process's own working directory so that two projects naming one worker keep their own sessions.
  That this directory is the Claude session's project directory is inferred from the relay's launch
  shim spawning with an inherited working directory; nothing in the channel contract states what
  Claude Code hands a plugin's MCP child. Three parties named it independently, the implementer among
  them. It is accepted as inferred because the failure mode is bounded: a fixed directory would mean
  every session shares one scope, which is today's behaviour rather than data loss, and the fix is a
  different discriminator in one function.

**Review round 3 adjudicated.** Seven Majors and fifteen Minors accepted. Four were dispositioned as
already-owned rather than acted on: the two section handoffs above, the `fast-uri` and `qs`
advisories that arrive through the MCP SDK and are pre-existing and already parked, and the plan
document's own LAN address, which is on the operator's close-out list. Three Majors were confirmed by
the orchestrator against the code rather than taken on report. A runtime can become bound and
unkillable: `spawn` binds the workspace before the prompt request is made, and a non-timeout
rejection on a first prompt deletes the only session record, after which every `dsh_kill` answers
"No session named" and every prompt naming another workspace is refused, with nothing the model can
call to recover it. The workspace path admits a UNC spelling and the stored copy is never
shape-checked, which is amendment 3's class above. And a unit test asserts on an install the
repository does not carry, `bridge/runtime/node_modules` being gitignored and produced only by a
separate install while the root test glob collects the file regardless, so the suite reddens on a
fresh clone for an environment reason. Two lenses independently found that a control in the test
suite cannot reach the code it claims to exercise, the fake writing its foreign idle before the
bridge subscribes, so the test is green whether the bridge handles the case or not: an absence check
whose silence was never earned.

**A note on the sidecar's readings.** The judgment sidecar raised roughly a dozen verdict alerts
across this stretch and one was checked in full: it reported that verifying the unkillable-runtime
finding had diverged, on the ground that the code shown "explicitly implements a working `kill()`
method", which is the finding rather than a refutation of it, the defect being precisely that
`kill()` refuses when the session map is empty. Consistent with the operator record putting the
sidecar at about one fair alert in three.

**Next action per section.** Section 2: adjudicate fix round 3, take the heavy-process claim under
the protocol, run the whole gate with the contention lane beside it, then close with a Chapter and
commit and push. Sections 3 through 6: unstarted, in order, with section 4 still gated on the
operator's answer to the Open Questions entry about whether `dsh_prompt` should be auto-allowed.

**Uncommitted at this boundary.** Section 2's twelve untracked `bridge/` files and its one modified
tracked file. This plan doc and `docs/backlog.md` are committed at this boundary and deliberately
**not** pushed, on the same reasoning as the last one: a push to this repository's main is an install
surface that takes the whole gate, and the tree is mid-fix-round, so a gate run now would read a
half-edited worktree. The commit is the durable recovery point and the push rides with the section
close once the gate is green.

### Interim board 5 - 2026-09-07

Written at the compaction gate's signal, with section 2's fourth review round adjudicated and its
fourth fix round in flight. The closure-drought floor is met four times over: four review rounds
have now been adjudicated on this section and no section has closed since Chapter 1.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented and has been through four full three-lens review rounds, all adjudicated; its fourth fix
round is in flight. Sections 3 through 6 are unstarted. Section 2's twelve untracked `bridge/` files
and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-opus`, section 2 fix round 4, carrying one Critical, four Majors and eleven Minors,
  the three Standing Brief Amendments with entry 1's new clause, the standing prohibition on killing
  any process it did not spawn, and the box-budget clause with this session's identity substituted.
  It is told to run targeted per-file lanes only and to leave the whole gate to the orchestrator, and
  five findings are named in its brief as explicitly not its work.

Round 4's three lenses (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all at fable
through the Agent tool) have completed and are adjudicated. Verdicts were CHANGES_REQUIRED,
CHANGES_REQUIRED and CONCERNS. First-turn readings were taken on all three at the five-minute window
and each was healthy: 35, 24 and 39 non-synthetic assistant lines with a `<synthetic>` count of zero,
so no dispatch took the never-started path.

**A Critical survived adjudication this round, and the tier ladder still does not fire.** The ladder
turns on two *consecutive* rounds with surviving Criticals. Round 3 had none, so this is the first of
a possible pair rather than the second, and section 2 stays at opus. If round 5 also carries a
Critical the ladder fires and the comparison it demands is owed: whether a finding class repeats,
which would make the tier the lever, or whether the new Criticals land on fresh ground, which would
make the spec's premise the generator and call for a consult instead of a bump.

**Gate baseline.** Still the whole gate taken 2026-09-07T19:59:14Z on this checkout with no foreign
uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0, skipped 1, duration
147.6s, against a committed baseline of 1582/1581/0/1. Fix round 3 reported its own per-file lanes
going 55 to 66 tests, all exit 0, on the implementer's tree; those are not a whole-gate reading. The
orchestrator's own lane runs this stretch, on the post-round-3 tree plus its own two folds, read
`bridge/protocol.test.ts` at 14/14/0 exit 0 and `bridge/harness.test.ts` at 29 tests with the
deliberate red described below. The close gate is the orchestrator's and has not run. The machine's
heavy slot was taken and released by the round 3 implementer under the protocol at 22:26:57Z, and the
claims directory is empty as of 22:41Z; an absent claim is nobody having claimed the box rather than
evidence the box is free, so the slot is taken under the protocol at the gate rather than assumed.

**Rulings adopted since the last boundary.**

- **The lost-answer Critical is real, and it is a regression fix round 3 introduced.** Two lenses
  traced it independently and the orchestrator confirmed it by measurement rather than on report:
  `receive()` calls `disown()` at confirmation time, but everything gathered after a held receipt is
  the current turn's own, so a runtime that splices, runs the whole turn and goes idle before the
  prompt request returns its id gets a `turn_end` pushed with an empty body. The confirming test was
  written into the tree and observed red, `the worker's own words reached the event: ""`, lane exit 1.
  Round 3's M5 fix was right that prior-turn accumulation had to be cleared and wrong about when, so
  the two properties now have to hold together and the fix round is told that failing to reconcile
  them is a NEEDS_CONTEXT rather than a choice between them.
- **Standing Brief Amendment 1 gains a clause naming the generator rather than the site.** The
  channel-sanitization class has now appeared in all four rounds: `files_touched` in round 1,
  `session` and `finish_reason` in round 2, the body being unguarded entirely in round 3, and in
  round 4 the body's guard being too narrow. Each fix wrote a fresh pattern for the field in front of
  it, so within one file the attribute path strips the invisible class while the body path matched
  ASCII whitespace alone, and a closing tag spelled with a zero-width space between its letters
  renders as a delimiter to the model and matches nothing in the guard. The clause requires the
  hostile class to be derived from one exported definition rather than spelled a second time, which
  is amendment 2 applied to a character class rather than to a function. Two sites that hand-write
  one class will drift, and the drift is invisible at review because each site reads correct alone.
- **The orchestrator's own fold was itself the round's Major.** The body neutralizer's whitespace
  widening was written by this session between round 3's return and round 4's dispatch, with a
  red-before-green probe and a byte-verified restore, and both the security and adversarial lenses
  then found it ASCII-only. That is the same class the amendment now names, produced by the
  orchestrator rather than by an implementer, which is worth recording: the generator is the practice
  of spelling a class at the site, not the seat that spells it.
- **A flaky control was found by running the suite, which no lens does.** The foreign-idle test's
  control leg failed once in five whole-lane runs and passed three of three in isolation. Root-caused
  from the code rather than filed as a flake: the test waits on the fake's replay-end marker and then
  asserts on what the bridge pushed, so the wait signals the producer's side of the boundary while
  the assertion reads the consumer's. Round 3 deleted the older silence-detector to kill this class
  and this leg still raced. The fix round is told to wait on the observable the assertion is about and
  to sweep the file for the same shape rather than patching the one site.
- **Two scope widenings are recorded rather than left implicit.** `bridge/env.ts` (the shared
  child-environment and runtime-binary guard, which became a module when it gained a second caller)
  and `bridge/tools/sdk-smoke.ts` (section 1's file, that guard's other caller) are now named on
  section 2's `Files in scope:` line. Both are approval drift and are recorded as such.
- **One scope ruling handed down rather than asked.** The body neutralizer also covers
  `<system-reminder>`, on the ground that the class is text the model reads as harness structure
  rather than the channel tag alone, and a forged system-reminder is the highest-value target after
  the envelope itself. The fix round is told not to go wider than those two tag names without asking,
  because neutralizing more would start mangling legitimate worker output.

**Review round 4 adjudicated.** One Critical (found twice, confirmed by measurement), four Majors and
eleven Minors accepted. Five findings were dispositioned as already-owned rather than acted on: the
`bridge/env.ts` scope drift, which this session recorded itself; the `fast-uri` and `qs` advisories
arriving through the MCP SDK, pre-existing and parked; the plan document's LAN address, on the
operator's close-out list; `dsh_prompt`'s `record`, `party` and `counterparty` schema arguments,
which are section 3's; and whether a model-facing refusal should neutralize the caller-chosen session
name, ruled out of scope because a tool result is not rendered as an attribute and the name is the
calling model's own. The security lens additionally confirmed amendments 2 and 3 as properly applied,
reading each stored field's guard at the state-file read, and reported `npm audit` in `bridge/runtime`
clean at zero vulnerabilities across all severities, which is a new fact this round.

**A note on the sidecar's readings.** Roughly a dozen more verdict alerts fired across this stretch.
Three named the round 3 implementer fighting a control-character edit; that class was checked in full
with an independent predicate over all twelve `bridge/*.ts` files, matching zero with a planted 0x1F
control that spoke, so the tree is clean and those alerts described a mid-round state the implementer
had already reported and fixed. One alert called the implementer's baseline capture a divergence for
swapping pre-round copies in before measuring, which is exactly the right method. Two were fair and
had already been caught and acted on in the same turn. Consistent with the operator record putting the
sidecar at about one fair alert in three.

**Next action per section.** Section 2: adjudicate fix round 4, take the heavy-process claim under the
protocol, run the whole gate with the contention lane beside it, then close with a Chapter and commit
and push. Sections 3 through 6: unstarted, in order, with section 4 still gated on the operator's
answer to the Open Questions entry about whether `dsh_prompt` should be auto-allowed.

**Uncommitted at this boundary.** Section 2's twelve untracked `bridge/` files and its one modified
tracked file, plus the orchestrator's two folds inside them. This plan doc is committed at this
boundary and deliberately **not** pushed, on the same reasoning as the last three: a push to this
repository's main is an install surface that takes the whole gate, and the tree is mid-fix-round with
a deliberate red test in it, so a gate run now would read a half-edited worktree and report a red the
fix round exists to clear. The commit is the durable recovery point and the push rides with the
section close once the gate is green.

### Interim board 6 - 2026-09-07

Written at the closure drought's floor again: section 2's fifth review round is adjudicated, no
section has closed since Chapter 1, and the round's outcome fired the tier-escalation ladder, so the
boundary is worth recording before the escalated round returns.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented and has been through five full three-lens review rounds, all adjudicated; its sixth fix
round, the first at an escalated tier, is in flight. Sections 3 through 6 are unstarted. Section 2's
thirteen untracked `bridge/` files and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 6, dispatched with the explicit fable model override that
  the tier escalation authorizes. It carries one Critical, five Majors and eleven Minors by way of a
  findings file under the gitignored scratch path, the amendments block including entry 1's new fifth
  clause, a six-item list of findings named as explicitly not its work, all standing prohibitions,
  and the box-budget clause with this session's identity substituted. It is told to run targeted
  per-file lanes only and to leave the whole gate to the orchestrator.

Round 5's three lenses (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all at fable
through the Agent tool) have completed and are adjudicated. Verdicts were CHANGES_REQUIRED,
CHANGES_REQUIRED and CONCERNS. First-turn readings were taken on all three and each was healthy: 44,
and 35 non-synthetic assistant lines with a `<synthetic>` count of zero, the blind lens having
completed before its reading was due. The round was bracketed by a `git status --porcelain` capture
before dispatch and again at return; the two are byte-identical, so no agent moved the tree under
the round and the findings stand.

**The tier-escalation ladder fired, and the comparison it demands was made before the bump was
spent.** The ladder turns on two consecutive rounds carrying surviving Criticals, which round 4 and
round 5 now are. The comparison: round 4's Critical was `disown` running at the wrong moment, at the
runtime's confirmation rather than at the splice, which threw away the turn's own answer; round 5's
is `disown` failing to clear all the state it owns, so a held idle belonging to a prior turn survives
the splice and closes this turn with an empty body, losing the answer the same way, at adjacent
lines, through the fix round 4 itself wrote. That is the same finding class repeating rather than new
ground, which is the branch where the tier is the lever rather than the spec's premise, so section 2
escalates from opus to fable for one re-dispatch with both rounds' evidence carried forward. Had no
class repeated, the correct move would have been the opposite one: no bump, and a consult on the
spec's premise instead.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. The orchestrator's own
targeted lane over the post-round-4 tree, measured 2026-09-07T23:17Z, read `bridge/protocol.test.ts`
15, `bridge/harness.test.ts` 34, `bridge/log.test.ts` 14, `bridge/index.test.ts` 9,
`bridge/env.test.ts` 3, `bridge/fake-dsh.test.ts` 2, `bridge/redact.test.ts` 8 and
`import-hygiene.test.ts` 5, every one exit 0, with `npx tsc --noEmit` exit 0. Those counts and exit
codes confirm the round-4 implementer's own report exactly. The close gate is the orchestrator's and
has not run. The machine's heavy slot was taken for that lane at 2026-09-07T23:17:05Z and released
after verifying the claim's own session line; the claims directory is empty as of that release, and
an absent claim is nobody having claimed the box rather than evidence the box is free.

**A reading trap cost a second false negative and is worth recording as a standing hazard.** The
count grep over a fully green run came back empty again, exactly as Chapter 1 records. The cause is
sharper than that Chapter states it: Node prints its summary with a leading information symbol
rather than a hash, and that symbol is three bytes in UTF-8, so a pattern anchored with a
single-character wildcard matches one byte, lands mid-glyph and matches nothing. Both times the run
was green and both times the grep said nothing at all, which is why the verdict is read from the
process exit code and never from a grep shaped for the lines expected. The escalated brief carries
this hazard explicitly.

**Rulings adopted since the last boundary.**

- **The round-4 Critical is fixed and confirmed by the orchestrator against the code**, not taken on
  the implementer's report: `disown` now runs at the splice in `observeReceipt` and `receive` states
  in the code that it disowns nothing. The deliberately red test written before that round is green,
  and so is the round-3 test asserting the opposite property, so the two hold together.
- **A new Critical survived adjudication, rated above the Major the lens gave it.** A held
  `pendingEnd` survives `disown`, so a prior turn's idle can close this turn with an empty body while
  the real answer arrives to find no turn. The orchestrator confirmed the reachable sequence by
  reading the three sites rather than accepting the finding. It is rated Critical because the
  section's own text names a lost final response as the expensive failure. Three independent signals
  landed on this one state machine: the adversarial lens found this path, the blind lens flagged its
  sibling at the same lines, and the round-4 implementer had itself named this area as the claim it
  would most expect to be wrong. The fix is owed at the level of the state machine's invariant rather
  than the line, which is what the escalated brief demands.
- **Standing Brief Amendment 1 gains a fifth clause naming the test method as the generator.** The
  channel-sanitization class has now been found wanting in five consecutive rounds, and the fourth
  clause already required the class to derive from one exported definition, which the round-4 fix
  did correctly. The gap that remained was in how the guard is proven: each round's test pinned
  exactly the spellings that round's reviewer named, so the next reviewer only had to name one nobody
  had thought of, and did, five times running. The clause requires the test to derive its cases from
  the class definition rather than enumerate them, so that widening the definition widens the test in
  the same edit, with enumerated cases kept as regression pins beside the property rather than in
  place of it. This is approval drift and is recorded as such.
- **The orchestrator reversed one of its own rulings on new evidence.** It had ruled that
  `workspacePath`'s hand-spelled control class should stay independent of the shared hidden class,
  on the ground that refusing a path and neutralizing text are opposite operations at different
  boundaries. The adversarial lens showed the reasoning was thinner than claimed: those code points
  reach a filesystem call, the spawned child's working directory, and a refusal message quoted back
  to the model. The refusal now derives from the shared class, which refuses strictly more and
  repairs nothing, so the original objection does not apply to it.
- **One finding was routed rather than taken where the lens aimed it.** A gap in the invisible class,
  the Hangul fillers and U+180E, was reported against `broker/sanitize.ts`, which is outside this
  section's scope and whose narrower class is correct for its own boundary, Discord rather than a
  model. It is fixed instead at `isHidden` in `bridge/protocol.ts`, which is this plan's own widening
  point and already widens the broker's class, so the fix needs no scope change and the shipped
  component is untouched.
- **One finding was discarded with its reason.** Exact-wording pins on `dsh_busy`'s tool-result text
  were reported as the retire class for prose pins. The lens offered the counter-reading itself and
  it is the right one: that output is key-value fields the model parses rather than prose, so the
  pins are doing real work.
- **The spec was corrected to as-built** at the Approach's turn-ending clause. It said a turn ends
  when `session.status` reports an error; the protocol carries exactly two status values, `running`
  and `idle`, which section 1 established and Chapter 1 already recorded, and the code correctly
  reads a bad ending off the `turn/end` event's reason. Left uncorrected, section 6's document would
  have copied a status value that does not exist.

**Deferred to their owners rather than fixed here.** The dependency advisories arriving through the
MCP SDK are pre-existing, confirmed again this round by an empty lockfile diff against main, and stay
parked in the backlog. The guard that `workspacePath` duplicates is owned by `broker/intake.ts`,
outside this section's scope, so amendment 2's out-of-scope route applies and it is named here with
the export it would need rather than edited: `transcriptPathField` at `broker/intake.ts:319-327`,
which shares the same UNC, device-prefix and drive-root shape and is currently private to that file.
The security model's bridge entry belongs to section 6, whose brief must name four items so none is
lost: the environment scrub's residue, the state file's trust, kill-by-any-name, and the deliberately
absent channel permission capability.

**Next action per section.** Section 2: adjudicate the escalated fix round, confirm the Critical's
fix against the code, take the heavy-process claim, run the whole gate with the contention lane
beside it, then close with a Chapter and commit and push. Sections 3 through 6: unstarted, in order,
with section 4 still gated on the operator's answer to the Open Questions entry about whether
`dsh_prompt` should be auto-allowed.

**Uncommitted at this boundary.** Section 2's thirteen untracked `bridge/` files and its one modified
tracked file. This plan doc is committed at this boundary and deliberately **not** pushed, on the
same reasoning as the last four: a push to this repository's main is an install surface that takes
the whole gate, and the tree is mid-fix-round, so a gate run now would read a half-edited worktree.
The commit is the durable recovery point and the push rides with the section close once the gate is
green.

### Interim board 7 - 2026-09-08

Written at the closure drought's floor again, and at the compaction gate's own signal. Section 2's
sixth review round is adjudicated, no section has closed since Chapter 1, and this round's outcome
sent the section to a consult rather than to a seventh fix round, which is the boundary worth
recording before that ruling lands.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented and has been through six full three-lens review rounds, all adjudicated. Its sixth fix
round, the first at the escalated fable tier, returned and was verified. Sections 3 through 6 are
unstarted. Section 2's thirteen untracked `bridge/` files and its one modified tracked file are
uncommitted.

**Live dispatches.**

- `consultant` at fable, on the premise behind the channel-envelope guard. It carries the six-round
  history, both of this round's confirmed escapes, the paths, and this session's own lean labelled
  explicitly as an instinct to test rather than to ratify. It is asked to rule between four
  premises and to say what its ruling does not cover.

Round 6's three lenses (`adversarial-reviewer`, `blind-reviewer`, `security-reviewer`, all at fable
through the Agent tool) have completed and are adjudicated. Verdicts were CHANGES_REQUIRED,
APPROVED_WITH_CONCERNS and BLOCK. First-turn readings were taken on all three and each was healthy:
45, 29 and 37 non-synthetic assistant lines with a `<synthetic>` count of zero. The round was
bracketed by a `git status --porcelain` capture before dispatch and again at return; the two are
byte-identical, so no agent moved the tree under the round and the findings stand.

**The escalated fix round did its job, and the section still did not close.** The round-5 Critical
is fixed at the level of the invariant rather than the line, confirmed by this session reading the
code rather than accepting the report. The per-turn bookkeeping record is now split in two: the
fields describing this bridge's own prompt sit on one record that no notification touches, and
everything the runtime has been observed doing sits in a second record that is replaced whole at
every boundary by a single constructor. The field whose staleness was round 5's Critical moved
inside that second record, so clearing it is no longer something an author has to remember; it is a
property of the field having been declared there at all. Both review lenses traced every ordering
the test double produces and found the invariant holding on each.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. This session's own
targeted lane over the post-round-6 tree, measured 2026-09-08T00:10Z under a claim it held and
released, read `bridge/protocol.test.ts` 17, `bridge/harness.test.ts` 40, `bridge/log.test.ts` 16,
`bridge/index.test.ts` 10, `bridge/env.test.ts` 3, `bridge/fake-dsh.test.ts` 2,
`bridge/redact.test.ts` 8 and `import-hygiene.test.ts` 5, every one exit 0, with `npx tsc --noEmit`
exit 0. Those counts reproduce the fix round's own report exactly. The close gate is this session's
and has not run. The machine's heavy slot was taken at 2026-09-08T00:09:24Z and released after
verifying the claim's own session line; the claims directory is empty as of that release, and an
absent claim is nobody having claimed the box rather than evidence the box is free.

**The tier ladder fired a second time, and the comparison it demands sent the round the other way.**
The ladder turns on two consecutive rounds carrying surviving Criticals, which rounds 5 and 6 both
are. The comparison: round 5's Critical was the per-turn bookkeeping failing to clear a field it
owned, and round 6's is the hostile-character class being hand-enumerated where the Unicode standard
already names it. **No finding class repeats**, and round 5's fix demonstrably held. That is the
branch where the tier is not the lever and the specification's own premise is the generator, so no
bump was spent and a consult was convened instead. The point is doubly settled here, since the
section was escalated to the strongest tier available last round and there is no bump left to spend.

**Rulings adopted since the last boundary.**

- **The round-5 Critical is fixed and confirmed against the code**, not taken on the implementer's
  report. The bookkeeping split described above holds, and the deliberately red test written before
  the round is green.
- **A new Critical survived adjudication and was confirmed by this session's own probe.** The guard
  that stops worker text from forging the envelope it rides in tests each character against a
  hand-written list. The Unicode standard already names that class as a property, and the two do not
  agree: of the 4,273 code points the standard's own ignorable, control, format and separator
  properties admit, the hand-written list rejects 4,036. A closing tag spelled with one of them
  between its letters passes the guard intact, which this session reproduced directly rather than
  reading off a report.
- **The clause written last round to stop this class was satisfied and did not stop it, and the
  reason is structural.** That clause required the guard's test to derive its cases from the class
  definition rather than enumerate the spellings a reviewer named. The test does exactly that, and
  walks every code point to do it. But the yardstick the test measures against is built from the
  guard itself, so it can only ever establish that the guard matches its own definition. It cannot
  establish that the definition covers what the reader actually ignores, which is the question. The
  derivation is a circle. This is what the consult is asked to rule on.
- **The same class was found at a second site in the same file, by two lenses independently and
  confirmed by probe.** The path that neutralizes the envelope's attributes compares raw characters
  against an ASCII set, while the path that neutralizes the body folds each character to its
  canonical form first. So by the file's own stated premise, every character whose canonical form is
  an attribute delimiter passes the attribute guard untouched. This is the drift that the
  derive-from-one-definition clause exists to prevent, occurring inside one file between two
  functions.
- **The threat's own premise is named as unconfirmed rather than assumed.** Every round has rated a
  forged tag Critical, and that rating rests on how a model reads a tag spelled with unusual
  characters. Nobody has tested it against a real session. The consult is asked whether the residual
  risk is priced correctly at all, since settling the premise may be worth more than another round
  of hardening against a threat whose reachability is inferred. Section 5 is a live end-to-end run
  and is where it would be settled.

**Review round 6 adjudicated.** One Critical, four Majors and sixteen Minors accepted; the full
adjudicated brief is at the gitignored scratch path. Findings dispositioned rather than acted on:
the accepted two-bridges-in-one-scope write merge, whose accepted cost the blind lens sharpened and
which is carried to section 5's Chapter rather than redesigned here; and the six items already owned
elsewhere, re-confirmed as not this round's. One Major is a premise question rather than a code
change, on whether a session identifier persisted after a timed-out prompt is one the runtime holds:
the file states one answer and the vendor's own documentation states the other, both cannot hold,
and section 5's live run is where it is observable.

**A note on what the lenses confirmed rather than found.** Recorded so a later round does not spend
itself re-deriving it: the per-turn bookkeeping invariant holds on every ordering the test double
produces; the shutdown and runtime-lost paths cannot both reap the same runtime; the state file's
fields are each checked at the read; the compressed-log frame walker matches the format's published
field sizes; and the three vendor-contract claims the state machine rests on were each settled
against the vendor's own source rather than against its documentation.

**Next action per section.** Section 2: adjudicate the consult's ruling against the code, dispatch
the fix round it implies, re-review whatever the fix delta earns, take the heavy-process claim, run
the whole gate with the contention lane beside it, then close with a Chapter and commit and push.
Sections 3 through 6: unstarted, in order, with section 4 still gated on the operator's answer to
the Open Questions entry about whether the prompt tool should be auto-allowed.

**Uncommitted at this boundary.** Section 2's thirteen untracked `bridge/` files and its one modified
tracked file. This plan doc is committed at this boundary and deliberately **not** pushed, on the
same reasoning as the last five: a push to this repository's main is an install surface that takes
the whole gate, and the tree is mid-round with a confirmed Critical outstanding, so a gate run now
would read a worktree whose known defect has not been fixed. The commit is the durable recovery
point and the push rides with the section close once the gate is green.

### Interim board 8 - 2026-09-08

Written at the compaction gate's own signal, 56 offers held over 39 minutes. Section 2's consult
returned and was adjudicated, its ruling was verified against the product rather than adopted on
report, the amendments block was rewritten on it, and fix round 7 is in flight. The boundary is
worth recording because this ruling reverses a premise six review rounds were built on.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through six full three-lens review rounds, and is in fix round 7, the second
at the escalated fable tier. Sections 3 through 6 are unstarted. Section 2's thirteen untracked
`bridge/` files and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 7, dispatched with the explicit fable model override the
  escalation authorizes. It carries the rewritten amendment 1, the consult's confirmed premise
  reversal, the concrete change across five files including two new ones, the round-6 findings still
  owed, an eight-item list of findings named as explicitly not its work, all standing prohibitions,
  the reading trap, and the box-budget clause with this session's identity substituted. It is told
  to run targeted per-file lanes only and to leave the whole gate to this session. First-turn
  reading at 2026-09-08T01:01Z was healthy: 38 non-synthetic assistant lines, `<synthetic>` count
  zero. Growth readings at 01:12Z and 01:32Z read 1,168,325 then 2,031,962 bytes with 221
  non-synthetic assistant lines and still zero synthetic, so the dispatch is alive rather than quiet.

The `consultant` dispatch has completed. Its first-turn reading was healthy at 417,513 bytes and 27
non-synthetic assistant lines with zero synthetic; it ran 38 tool calls over roughly 26 minutes.

**The consult's ruling, and the fact that inverts six rounds.** Every round since the first has
rated a forged channel tag Critical on the premise that Claude Code does not escape a channel
event. That premise is false on every build installed on this machine, and this session confirmed it
by reading the running binary directly rather than accepting the consultant's account of it. What
the product does, read at `~/.local/share/claude/versions/2.1.263`:

- The renderer filters meta keys against the identifier pattern, warns about the ones it drops, then
  builds the envelope with **every attribute value and the source passed through an XML escaper**
  that turns ampersand, both angle brackets, the double quote and the apostrophe into entities.
- The **body** is passed through a close-only disarmer for the channel tag, which rewrites a closing
  tag into a form the reader cannot resolve as one. It skips a filler class of roughly 4,700 code
  points between the tag's letters, folds a 33-entry table of bracket and slash lookalikes onto
  their ASCII forms, and matches case-insensitively.
- The product's filler class **contains U+034F**, which is the exact code point round 6's Critical
  was reproduced with. That escape is therefore not reachable at the envelope on any installed
  build, and the finding is downgraded from Critical to Major on that ground rather than on any
  finding that the bridge's guard was adequate.
- The rule table that neutralizes forged system-reminder and channel-source tags is the **subagent
  output** sanitizer and is not applied to channel content, which is what leaves the bridge's guard
  a real job to do.

A detail worth recording because it nearly stopped the verification one step short: the closing
channel tag appears nowhere in the binary as a literal string, and the first read of that absence
was that the payload must be compressed. It is not; the bundle is plainly readable. The tag is
absent because it is built from a shared constant, and that indirection is exactly the shape of a
renderer that owns its own escaping. The empty grep was the evidence rather than the obstacle.

**Rulings adopted since the last boundary.**

- **The consult's ruling is adopted, having been confirmed against the product.** The guard's
  problem was never its class. It was its oracle and its rating. The bridge keeps a guard, because
  three things the product's layer does not cover are precisely what it is for: a forged tag that is
  not the channel tag, an opening channel tag rather than a closing one, and a tag name whose
  letters are themselves lookalikes, which the product matches literally. It is also the only layer
  on a build that lacks the product's, and whether builds before 2.1.260 carry that layer is unknown
  rather than known to be absent.
- **Amendment 1's five clauses are replaced by one.** Each of the five named a generator and each
  was satisfied by the round that followed it, and the class escaped anyway, six times. The reason
  is that all five were reasoning about the guard while the question was about the reader. The new
  clause states the two-layer truth, requires the bridge's classes to be Unicode property
  expressions in one exported definition with the lookalike table carried as a named copy of the
  product's, requires both the attribute path and the body path to resolve a code point through one
  resolver, and requires the test's yardstick to be a fixture of the product's classes rather than
  the guard. This is approval drift and is recorded as such.
- **The circularity is named exactly, because it is the round's real lesson.** Round 5's clause
  required the test to derive its cases from the class definition, and round 6's test did that,
  walking every code point in Unicode to do it. It still proved nothing, because the yardstick it
  measured against was built from the guard. A test whose oracle is the thing under test proves only
  self-consistency, however much it walks. Sample size cannot repair a circular oracle.
- **Severity in this family is capped at Major** until a live session is observed acting on a forged
  tag, and a reported spelling counts as a finding only if the fixture's reader resolves it to a tag.
- **Two items the consult offered as operator forks were taken as low-blast reversible defaults
  rather than escalated**, and both are recorded here as the approval drift they are. Section 5
  gains an acceptance line measuring the reader premise directly: one extra prompt has the worker
  emit four forged-tag spellings and the transcript is read for whether the session treated any as
  structure. That is the only observation that can give this family a real severity, and section 5
  is a live run that is happening regardless. Section 6 gains one line in the install document
  naming a Claude Code version floor of 2.1.260 with its reason, and `docs/install.md` joins that
  section's Files in scope. Escalating either would have cost an operator round-trip worth more than
  reversing them.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. The targeted lane over
the post-round-6 tree, measured by this session 2026-09-08T00:10Z under a claim it held and
released, read `bridge/protocol.test.ts` 17, `bridge/harness.test.ts` 40, `bridge/log.test.ts` 16,
`bridge/index.test.ts` 10, `bridge/env.test.ts` 3, `bridge/fake-dsh.test.ts` 2,
`bridge/redact.test.ts` 8 and `import-hygiene.test.ts` 5, every one exit 0, with `npx tsc --noEmit`
exit 0. That is the baseline round 7 reports its deltas against. The close gate is this session's
and has not run. The machine's claims directory was empty at 2026-09-08T00:53:14Z, which is a
reading rather than a clearance: an absent claim is nobody having claimed the box, never evidence
the box is free, so the slot is taken under the protocol at the gate.

**A note on the sidecar's readings.** Roughly a dozen verdict alerts fired across this stretch and
every one concerned a subagent's own tool calls rather than this session's. Two are worth naming
because they invert their subject. One called a growth reading a divergence for using `stat` rather
than reading the transcript, when reading that transcript is what the doctrine bars and `stat` is
the reading it prescribes. Another called the consult's disarmer probe a failure for reporting that
fullwidth letters pass, when passing is the finding the probe existed to establish. Consistent with
the operator record putting the sidecar at about one fair alert in three.

**Next action per section.** Section 2: adjudicate fix round 7's report against the code, re-review
whatever the fix delta earns under the owed-round triggers, take the heavy-process claim, run the
whole gate with the contention lane beside it, then close with a Chapter and commit and push,
carrying the five deferred doc-commit pushes with it. Sections 3 through 6: unstarted, in order,
with section 4 still gated on the operator's answer to the Open Questions entry about whether the
prompt tool should be auto-allowed.

**Uncommitted at this boundary.** Section 2's thirteen untracked `bridge/` files and its one
modified tracked file, plus whatever fix round 7 is writing into them right now. This plan doc is
committed at this boundary and deliberately **not** pushed, on the same reasoning as the last six: a
push to this repository's main is an install surface that takes the whole gate, and a fix round is
mid-flight in the tree, so a gate run now would read a half-edited worktree. The commit is the
durable recovery point and the push rides with the section close once the gate is green.

### Interim board 9 - 2026-09-08

Written at the closure drought's floor again: section 2's seventh review round is adjudicated, no
section has closed since Chapter 1, and fix round 8 is in flight. The boundary is worth recording
because this is the first round since the premise reversal, and it settles whether the reversal
held.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through seven full three-lens review rounds, and is in fix round 8, the third
at the escalated fable tier. Sections 3 through 6 are unstarted. Section 2's fifteen untracked
`bridge/` files and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 8, dispatched with the explicit fable model override the
  escalation authorizes. It carries the round-8 findings file under the gitignored scratch path
  (four Majors, fifteen Minors, an eight-item not-your-work list), all four Standing Brief
  Amendments including the new fourth, every standing prohibition, the reading trap, and the
  box-budget clause with this session's identity substituted and the live foreign claim named. It is
  told to run targeted per-file lanes only and to leave the whole gate to this session.

Fix round 7 (`implementer-fable`) and all three review lenses have completed and are adjudicated.

**Round 7's fix round held, and this session verified the part that mattered rather than adopting
it.** The round's whole point was to replace a circular test oracle with one taken from a fixture of
Claude Code's own reader classes, which makes that fixture the yardstick every later green is
measured against. An error in it would therefore fail silently and in the safe-looking direction,
since the bridge's own filler class is some 955,000 code points wide against the product's 4,700, so
a mistyped range boundary would leave every subset assertion green while quietly moving the
yardstick. The implementer named exactly this as the claim it would most expect to be wrong. It was
checked against the running build directly: the product's class assembled from the binary's own
range strings admits 4,700 code points, the fixture admits 4,700, and **no code point in the entire
code space is classified differently by the two**. The 33-entry delimiter-lookalike map parsed out
of the product's own table differs from the fixture's nowhere. A control that removed one range from
the binary-derived class produced a difference, so the comparison demonstrably speaks. The oracle's
independence was confirmed by reading as well: the test's resolver reaches the fixture's two tables
and standard normalization only, with no guard symbol in it.

**Review round 7 adjudicated. No Critical from any lens**, which is the first round on this section
since round 3 that can say so, and it means the tier-escalation ladder does not fire. Verdicts were
CHANGES_REQUIRED, CHANGES_REQUIRED and CLEAR. First-turn readings were taken on all three at the
window, each healthy at 37 and 54 non-synthetic assistant lines with a `<synthetic>` count of zero,
the security lens having completed before its reading was due. The round was bracketed by a
`git status --porcelain` capture before dispatch and again at return; the two are byte-identical, so
no agent moved the tree under the round and the findings stand. Four Majors and roughly fifteen
Minors were accepted; two Minors were found by two lenses independently.

**The round's most valuable finding was settled by measurement, and it inverts a fix from the round
before.** Round 7 narrowed the session log's default chunk filter to a single event type, on the
reasoning that the other chunk kinds appear only nested inside it, and counted them to check. The
count was taken over the SDK notification fixtures. But the tool that uses the filter reads the
**on-disk session log**, which is a different shape the same runtime writes, and the spec's own
observation of that log lists the other chunk kinds as top-level types. This session read the
operator's real log frame by frame to settle it: 39,333 events, zero unparseable lines, zero
unreadable frames. Of those, `tool-call-chunks` numbers 15,851, `assistant/chunk` 11,421 and
`text-chunks` 4,465, so chunk events are 81% of the file and the narrowed filter would admit 20,316
of them. Since the tool returns the last forty events, a busy turn's tail would be almost entirely
chunk noise with the turn-end and tool-call events the tool exists to surface pushed clean out of
the window. The narrowing is a regression and round 8 restores the four types.

**Rulings adopted since the last boundary.**

- **The plan gains a fourth Standing Brief Amendment, under the recurrence rule.** The class is *a
  claim about a runtime artifact settled against a second artifact that resembles it*. It has now
  produced two defects a section apart, and both had the same shape: the stand-in agreed with the
  claim, so the check came back green and the real surface was never opened. Section 1 verified the
  permission preset against the composed configuration row rather than against what the runtime
  actually mounts, caught in that section's own review. Section 2 set the log reader's chunk filter
  from a count over the notification fixtures while the reader reads the on-disk log. Two instances
  of one class is the workflow generating the bug, so the amendment requires the surface the code
  will actually read at run time to be named before a measurement is taken from it, and requires a
  value that cannot be measured on the real surface to be marked inferred with the section that can
  observe it named, rather than a stand-in being measured and reported as settled. This is approval
  drift and is recorded as such.
- **The spec's post-kill workspace criterion was stale and is corrected to the code.** The
  acceptance criterion said a differing workspace is accepted again after a kill. The code refuses
  it for the life of the record, and the code is right: a DSH session's log is filed under the
  workspace it was created in and reusing its id elsewhere is refused by the runtime, so re-pointing
  a name would abandon the conversation the state file exists to preserve, and the refusal names the
  recovery, which is a different session name. Interim board 2 had already adopted exactly this
  ruling; nobody brought the acceptance text into line with it, which is the whole of the defect the
  lens found. Corrected rather than escalated, because the ruling was already adopted and the
  correction changes no design intent. Approval drift, recorded.
- **A Major previously accepted under one heading is reopened, because the new finding is a
  different mechanism.** An earlier round accepted a state-file write merge between two bridges
  sharing one scope. The blind lens has now named a worse consequence of the same scope key: two
  Claude sessions in one project directory can drive two runtime processes that reuse a single DSH
  session id, which puts two appenders on one append-only compressed session-log container and races
  two turn counts. The earlier acceptance does not cover it, because sharing a project's ordinary
  files is not the same as sharing a container written on a single-writer assumption. Round 8 adds a
  lease on the record rather than redesigning the scope key, which stays section 5's to settle by
  observation.
- **A reachable path can leave a turn in flight forever, and a test pins the wedged state as
  correct.** Where a prompt request times out after the runtime has already spliced, run and gone
  idle, that idle was the turn's only ending and is discarded, no later one arrives, and the tool
  error meanwhile tells the model to wait for a channel event that cannot come. Round 8 is told to
  fix this at the level of the invariant and to rewrite the test that currently pins the wedged
  state, watching the new test fail first.
- **Two round-7 reversions were weighed and accepted.** The implementer reverted two findings it was
  asked to fix and justified both with test evidence: a frame-straddle carry that regressed a
  control, and a hook relocation that broke five tests because the runner runs teardown hooks in
  registration order. Both lenses that weighed them accepted them. One observation rides forward
  rather than a fix: the control behind the first is not writer-shaped, so it says less than it
  looks.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. Fix round 7 reported its
own targeted lanes on its own tree as `bridge/protocol.test.ts` 21 (up 4), `bridge/harness.test.ts`
40, `bridge/log.test.ts` 16, `bridge/index.test.ts` 10, `bridge/env.test.ts` 3,
`bridge/fake-dsh.test.ts` 2, `bridge/redact.test.ts` 8 and `import-hygiene.test.ts` 5, every one
exit 0 with `npx tsc --noEmit` exit 0; those are the implementer's numbers on the implementer's tree
and are the baseline round 8 reports against. The close gate is this session's and has not run. The
machine's heavy slot is held by a foreign session as of 2026-09-08T01:51:55Z, a worker seat on
another repository, started 01:43:30Z with an expected 3600 seconds, so it is expected held until
about 02:43Z; the round was dispatchable against that hold because reviewers build nothing, and the
constraint rides in every brief.

**A note on the sidecar's readings.** Roughly a dozen more verdict alerts fired across this stretch.
The great majority concerned a subagent's own tool calls rather than this session's. Two inverted
their subject in the now-familiar way: one called a growth reading a divergence for using the file's
modification time rather than reading the transcript, when reading that transcript is exactly what
the doctrine bars and the modification time is the reading it prescribes, and one reported that a
file read was of "a different file" when it was the named file. One was fair and useful in an
unintended way: it flagged that a probe found three code points un-neutralized in a session field,
which is correct and is by design, those three being comma lookalikes and the comma being unsafe
only in the path list where it is the separator. Consistent with the operator record putting the
sidecar at about one fair alert in three.

**Next action per section.** Section 2: adjudicate fix round 8's report against the code, re-review
whatever the fix delta earns under the owed-round triggers, take the heavy-process claim once the
foreign hold clears, run the whole gate with the contention lane beside it, then close with a
Chapter and commit and push, carrying the seven deferred doc-commit pushes with it. Sections 3
through 6: unstarted, in order, with section 4 still gated on the operator's answer to the Open
Questions entry about whether the prompt tool should be auto-allowed.

**Uncommitted at this boundary.** Section 2's fifteen untracked `bridge/` files and its one modified
tracked file, plus whatever fix round 8 is writing into them right now. This plan doc is committed
at this boundary and deliberately **not** pushed, on the same reasoning as the last six: a push to
this repository's main is an install surface that takes the whole gate, and a fix round is editing
the tree right now, so a gate run now would read a half-edited worktree. The commit is the durable
recovery point and the push rides with the section close once the gate is green.

### Interim board 10 - 2026-09-08

Written at the compaction gate's own signal, 14 offers held over 32 minutes, and at the closure
drought's floor: section 2's eighth review round is adjudicated, no section has closed since
Chapter 1, and fix round 10 is in flight. The boundary is worth recording because this round found
the previous round's own fix failing in the case it was built for, and because that failure is the
third instance of a class the plan already carries a rule for.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through eight full three-lens review rounds, and is in fix round 10, the
fourth at the escalated fable tier. Sections 3 through 6 are unstarted. Section 2's fifteen
untracked `bridge/` files and its one modified tracked file are uncommitted.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 10, dispatched with the explicit fable model override the
  escalation authorizes. It carries the round-10 findings file under the gitignored scratch path
  (four Majors, seven Minors, an eight-item not-your-work list), all four Standing Brief Amendments
  with the instruction to re-read amendment 4 because it changed since its last dispatch, every
  standing prohibition, both reading traps, and the box-budget clause with this session's identity
  substituted and the live foreign claim named as overrun. It is told to run targeted per-file lanes
  only, to write and delete no claim, and to leave the whole gate to this session. First-turn reading
  at 2026-09-08T02:55Z was healthy: 38 non-synthetic assistant lines, `<synthetic>` count zero.

Fix round 8 and all three round-9 review lenses have completed and are adjudicated.

**Fix round 8 was adjudicated against the code rather than adopted from its report.** The two things
its brief made explicit demands about both hold. It watched its new timeout test fail against the
round-7 code before fixing, restoring from its own pre-probe copies and verifying the restore with a
byte comparison, and it reported honestly that one of its four tests did not go red in the order the
scheduler picked. And its lease guard treats the stored owner as untrusted input at the read, per
amendment 3: `isSessionOwner` requires a record, a safe-integer process id strictly above zero, and
an ISO-timestamp field matched against a fixed pattern, which is a shape check rather than the
`typeof` pass the amendment names as insufficient. Its restoration of the log reader's chunk filter
names the on-disk log as the surface in the code's own comment, which is what amendment 4 asks for at
the site that earned it. Four of its six concerns were accepted as argued, the unattributed event's
empty body among them, on the ground that a bridge-authored sentence there would make the server's
own instructions untrue and would land in section 3's record as though the worker had said it.

**Review round 9 adjudicated. No Critical from any lens**, which is the second consecutive round that
can say so, so the tier-escalation ladder does not fire. Verdicts were CHANGES_REQUIRED,
CHANGES_REQUIRED and CONCERNS. First-turn readings were taken at the window on the two lenses still
running, each healthy at 32 and 41 non-synthetic assistant lines with a `<synthetic>` count of zero;
the adversarial lens had completed before its reading was due. The round was bracketed by a
`git status --porcelain` capture before dispatch and again at return, and the two are byte-identical,
so no agent moved the tree under the round and the findings stand.

**All three lenses independently found the same Major, and this session confirmed it in the code
before acting on it.** Round 8 added an ownership lease so that two bridges in one project cannot
drive one DSH conversation, which is the two-appenders-on-one-container hazard board 9 recorded. The
lease is written to the state file on disk and read from a map populated once in the bridge's
constructor: `readState(` appears at exactly two places in the file, its own definition and that one
constructor call, and `writeState` re-reads the file to merge before writing but never refreshes the
map. So two bridges started before either prompts each hold a snapshot showing the name free; the
first takes the lease and writes it, and the second consults its own snapshot, passes the refusal,
and resumes the same session id in a second runtime. The check passes at exactly the moment it exists
to fail. The test round 8 wrote for the lease cannot see it, because it writes the owned record
before constructing the second bridge, which is not the ordering two live sessions produce.

**Rulings adopted since the last boundary.**

- **Standing Brief Amendment 4 gains a second half, under the recurrence rule.** The class is *a
  claim about a runtime artifact settled against a second artifact that resembles it*, and this is
  its third instance in as many rounds: the permission preset verified against the composed
  configuration row rather than what the runtime mounts, the chunk filter tuned on a count over the
  notification stream while the reader reads the on-disk log, and now the lease read from a
  process-local snapshot rather than the shared file. The generator is one, so the rule gained a
  clause rather than the block gaining a fifth entry: a check whose subject is shared between
  processes reads the shared artifact at the moment of the check, never a copy this process holds,
  and a guard that cannot open the file is not a guard against another process. The machine's own
  heavy-process protocol is named in the amendment as the worked example, since it is written that
  way for exactly this reason. This is approval drift and is recorded as such.
- **A Minor was upgraded to Major on this session's own reading.** The state-file write replaces the
  whole file with this scope alone where the existing file is unreadable or oversized, which silently
  deletes another bridge's records; the process that destroys them is not the one that logged the
  warning. The lens rated it Minor; the consequence is silent loss of a peer's state, so it is
  routed as a Major with the remedy of refusing to write rather than overwriting.
- **A pid-reuse Minor is fixed in words rather than in code, deliberately.** All three lenses noted
  that the lease's recorded start time is never compared, so a recycled process id can hold a name
  for as long as the unrelated process lives. A creation-time comparison would need a command spawn
  on this platform, which is a worse cure than the disease, so the refusal is reworded to stop
  promising a release it cannot guarantee and the limit is stated in the module's README.
- **A public-repository finding was swept and dispositioned rather than acted on tree-wide.** The
  security lens flagged the OS account name in a tracked plan-doc line. The sweep, run with a control
  that demonstrably speaks after a first attempt whose control was silently broken by the shell's
  backslash handling, found the name is already published across this repository by design: it is the
  host fixture in sixteen broker test files and two reference documents, and it is the author of
  every commit. The marginal disclosure is therefore nil. The one gratuitous instance, in board 9's
  own text, is reworded; the deliberate fixtures are left alone rather than churned; and the single
  pre-existing instance in an installer's usage example is outside this plan's scope and is routed
  rather than fixed here.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. Fix round 8 reported its
own targeted lanes on its own tree as `bridge/protocol.test.ts` 21, `bridge/harness.test.ts` 43 (up
3), `bridge/log.test.ts` 16, `bridge/index.test.ts` 10, `bridge/env.test.ts` 3,
`bridge/fake-dsh.test.ts` 2, `bridge/redact.test.ts` 8 and `import-hygiene.test.ts` 5, every one exit
0 with `npx tsc --noEmit` exit 0; those are the implementer's numbers on the implementer's tree and
are the baseline round 10 reports against. The close gate is this session's and has not run.

**The machine's heavy slot is held and has overrun.** The claim is a worker seat on another
repository, file mtime 2026-09-08T01:43:30Z with an expected 3600 seconds, so it is 66 minutes old
against its own hour at the 02:49Z reading. The holder is live and busy on the roster, which is the
reading that outranks any file hint, so the claim is honest rather than abandoned and presence is
grounds for waiting. It is not this session's to delete, its `Session:` line being another's. Both
review rounds and both fix rounds were dispatchable against the hold because reviewers build nothing
and the implementers run targeted per-file lanes only; the whole gate is what waits for the slot.

**A note on the sidecar's readings.** Roughly a dozen more verdict alerts fired across this stretch,
the great majority concerning a subagent's own tool calls. Several inverted their subject in the
now-familiar way, one calling a growth reading a divergence for using the file's modification time
rather than reading the transcript when reading that transcript is exactly what the doctrine bars,
and one reading a modified worktree file as a non-empty index. **One was fair and caught a real
defect in this session's own work:** it reported that a control meant to prove an absence-sweep's
predicate had failed to speak, which was true, the shell having eaten the backslashes out of the
control's needles, and the sweep was re-run with the control built through a route that survives.
Consistent with the operator record putting the sidecar at about one fair alert in three.

**Next action per section.** Section 2: adjudicate fix round 10's report against the code, re-review
whatever the fix delta earns under the owed-round triggers, take the heavy-process claim once the
foreign hold clears, run the whole gate with the contention lane beside it, then close with a Chapter
and commit and push, carrying the eight deferred doc-commit pushes with it. Sections 3 through 6:
unstarted, in order, with section 4 still gated on the operator's answer to the Open Questions entry
about whether the prompt tool should be auto-allowed.

**Uncommitted at this boundary.** Section 2's fifteen untracked `bridge/` files and its one modified
tracked file, plus whatever fix round 10 is writing into them right now. This plan doc is committed
at this boundary and deliberately **not** pushed, on the same reasoning as the last seven, with one
addition: a push to this repository's main is an install surface that takes the whole gate, a fix
round is editing the tree right now, and the machine's heavy slot is held by another session, so the
gate cannot honestly run yet. The commit is the durable recovery point and the push rides with the
section close.

### Interim board 11 - 2026-09-08

**Plan review, run once over the whole spec after a machine hard restart, by the CHANNELS Expert
seat (session b97861ad) while no session held the leash.** The kit's `plan-reviewer` agent,
dispatched at fable, effort high, through Workflow with the spec path alone, returned
`READY_WITH_FINDINGS`: 11 findings, 4 Major and 7 Minor, none Critical. Every finding resting on a
repository claim was confirmed against the file before adjudication (`install/Install-Elevated.ps1`
lines 59 to 64, `install/Install-All.ps1` lines 54 to 72, `install/Install-All.test.ts` lines 44 to
46, `docs/install.md` lines 253 and 270 to 272, `docs/security-model.md` lines 705 to 706,
`bridge/protocol.ts` line 303). Section 1 is closed and drew no finding.

**Adjudication. plan review: 11 findings, 10 fixed, 0 assumed, 1 asked.**

- Asked and answered: the `dsh_prompt` allow rule (Major, preference-as-ruling). The operator
  answered at the keyboard 2026-09-08: auto-allow, with the chain recorded as an accepted risk.
  Section 4 composes the rule on that answer and the Open Questions entry carries the reasoning.
- Fixed as a scope widening, recorded here as the approval drift it is: section 4 gains
  `install/Install-All.ps1`, `install/Install-Elevated.ps1` and `install/Install-All.test.ts`, removed
  from Out of Scope the same day, because the installer hard-codes the relay in both the plugin install
  and the allowlist merge and the test pins exactly that list, so `docs/install.md` would have
  described an allowlist the installer never writes and section 5 would have met an uninstalled plugin
  with no in-scope repair (one Major falsified-surface, one Major unguaranteed-handoff). Section 4
  also installs the plugin on this host and records the command.
- Fixed in section 5: the forged-tag prompt goes under a second session name with no `record`, so
  the two-section record criterion holds (Major, two-way); the "Channels" line is read from the
  interactive fallback or from the `-p` transcript only where that format carries it (Minor); the run
  takes the machine's heavy-process claim, `.kit/RUNNING` being additional (Minor, rule-conflict).
- Fixed in Approach and section 3: the party section is appended after runtime acceptance, so a
  refused prompt leaves the record untouched (Minor, two-way); rotate refuses while any session
  sharing the record file has a turn in flight (Minor, unwanted-satisfaction).
- Fixed in section 2: one new acceptance bullet, the turn-end listener receives the uncapped final
  response and only the channel builder cuts (Minor, unguaranteed-handoff, low confidence;
  `bridge/protocol.ts` line 303 cuts at the builder, so the code is expected to hold already).
- Fixed in section 6: the security model's allow-rule paragraph is rewritten to count seven rules
  across two plugins and its accepted-risks list gains the `dsh_prompt` entry (Minor,
  unguaranteed-handoff); the doc pin also refuses any `dsh_` identifier or meta key the protocol does
  not carry (Minor, unwanted-satisfaction).

**Section 2 in flight is touched in one place,** the new acceptance bullet above. The resuming Worker
checks it at fix round 10's adjudication.

**Next action per section.** Unchanged from Interim board 10: Section 2 resumes at adjudicating fix
round 10's report. Section 4 is no longer gated on an Open Questions answer. Sections 3 through 6
otherwise as Interim board 10 states them.

**Committed at this boundary, not pushed,** on the same reasoning as the last eight: a push to main
is an install surface that takes the whole gate, and no gate has run since the restart. Section 2's
uncommitted `bridge/` files were left untouched by this seat and are the Worker's.

### Interim board 12 - 2026-09-08

Written at the compaction gate's own signal, 42 offers held over 30 minutes, and at the closure
drought's floor: section 2's eleventh review round is adjudicated, no section has closed since
Chapter 1, and fix round 12 is in flight. **The seat changed hands at this boundary.** The Worker
session bound to this plan from 2026-09-07T17:43Z died with fix round 10 in flight; the operator
re-armed the goal at the keyboard on 2026-09-08 and it is now bound to a fresh Worker session
(6ab14fb9), taken cold and delegated.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through eleven full three-lens review rounds, and is in fix round 12, the fifth
at the escalated fable tier. Sections 3 through 6 are unstarted. Section 2's fifteen untracked
`bridge/` files and its one modified tracked file are uncommitted.

**Fix round 10 was adjudicated against the code and its own logs, because its report died with its
session.** The dispatch was in flight when the predecessor session ended, so the report that would
have carried its reasoning is gone, while its edits and its scratch logs survived. All eleven of its
findings were verified closed by reading the code: the two lease call sites now both read the state
file through `recall()`, the first-turn timeout persists only once the log is on disk, the tail keeps
parsed events and renders only survivors, the container gains a whole-walk plaintext budget, the
state write refuses a present-but-unreadable file, and the name bound landed at the shared `named()`
helper rather than at each quoting site, which is a wider fix than the finding asked for. Its
red-first discipline is recoverable from `.kit/round10-logs/`: 48 tests at 43 pass and 5 fail before
the fix, 48 pass and 0 fail after, with two clean reruns. A report is not the only place a round's
reasoning can live, and this round's survived because the code carries it: `recall()`'s own doc
comment states amendment 4's rule and justifies its fallback, which is what the lost report was asked
to explain.

**One acceptance bullet was owed and unmet, and it is now built.** Interim board 11 added a bullet
requiring the turn-end handler to hand the uncapped final response to its listeners while only the
channel builder cuts, and left it for the resuming Worker to check. The cut was indeed at the builder
alone, but there was no listener at all: the single turn-end outlet was `push`, which receives the
notification after the builder has already cut it, so a section 3 record appender hooked there would
have received truncated text. `BridgeOptions` now carries an optional `onTurnEnd`, called from
`finish()` inside its own try and catch separate from the push's, so a channel event that cannot be
sent does not also cost the record its answer and a record that cannot be appended does not swallow
the event the model waits on. The pin the bullet asks for exists: one turn, an answer of 12,500 code
points, the listener's text whole and the event's content cut to exactly the cap, with the two tied
to one turn by their shared session, kind and turn number. It needed an answer-length flag on the
stand-in runtime, since nothing could previously drive an answer past the cap.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 12, dispatched with the explicit fable model override the
  escalation authorizes. It carries the round-11 findings file under the gitignored scratch path
  (five Majors, eight Minors, a ten-item not-your-work list), all four Standing Brief Amendments with
  the instruction to re-read amendment 4 because it gained a third half minutes before the dispatch,
  every standing prohibition, the red-first and byte-verified-restore discipline, the corrected test
  runner, and the box-budget clause with this session's identity substituted.

Round 11's three review dispatches have completed and are adjudicated.

**Review round 11 adjudicated. No Critical from any lens**, which is the third consecutive round that
can say so, so the tier-escalation ladder does not fire and fable remains the writer tier. Verdicts
were CHANGES_REQUIRED, CHANGES_REQUIRED and CLEAR. The round was bracketed by a
`git status --porcelain` capture before dispatch and again at return and the two are byte-identical,
so no agent moved the tree under the round. Five Majors and eight Minors stand; the security lens
returned CLEAR with three Minors and nothing above them.

**The round found round 10's own fix defeating the lease it was built to protect, which is the
fourth time in this section that a fix has broken the case it was written for.** `persistable()`
writes only records whose owner is this process, and the lease reaches disk only at acceptance and at
finish, so during a turn's in-flight window the file still carries the previous owner. `recall()`
replaces the in-memory record with the file's copy unconditionally, so a second prompt for a name
with a turn in flight puts the stale owner back, and the finishing turn's count and lease are then
never written at all. Confirmed by this session against `persistable()`, both write sites and
`recall()` before the finding was acted on. A second Major has the same shape at a different site:
the first-turn timeout path calls `sessionLogFile` before `finish()`, and that function throws
outright on an id failing its shape check and on an unreadable harness home, so the throw escapes the
catch and leaves the turn in flight for the life of the process, which is this section's own named
expensive failure.

**Rulings adopted since the last boundary.**

- **Standing Brief Amendment 4 gains a third half, under the recurrence rule, and this is its fifth
  instance.** The new shape: a runtime claim settled against the vendor's own prose rather than
  against a neighbouring stream. A vendor document is not the runtime in either direction, so it can
  settle a claim about behaviour no better than its silence can, and a premise the code depends on is
  marked inferred until the runtime has been observed, marked inferred just the same when a document
  agrees with it. What a contradicting document buys is a bound on confidence rather than a
  measurement: enough to route the behaviour to the branch that is safe under uncertainty and to name
  the section that can observe the truth. Recorded here as the approval drift it is.
- **The first-turn timeout keeps its session record, reversing round 10's forget branch on evidence
  that arrived after it.** The bridge asserted throughout its comments and README that an id whose
  log is absent is refused on the resume that would use it, and round 10 built a branch that forgets
  such an id on that basis. The SDK documents the opposite verbatim at two paths, that an unknown id
  creates the session. Neither sentence has been measured against a runtime, so the ruling is made on
  the cost asymmetry rather than on either document: keeping costs at worst one session name that has
  lost its conversation and is recovered by using another name, while forgetting costs at worst two
  unsandboxed workers writing one workspace concurrently with the first answer routed to nobody,
  which is the hazard the lease design exists to prevent. Reversal is one line if section 5's live run
  finds unknown ids are in fact refused. The premise's own sentences are reworded to state the
  refusal as inferred and to name the contradicting line, and section 5 is named as the section that
  can settle it.
- **A same-scope record loss is raised on two lenses agreeing.** The state write carries other
  scopes through as raw parsed bytes by design and then rebuilds this scope from the validated map,
  so a neighbour's record in this scope in a shape this version refuses is dropped and the rename
  makes it permanent. The blind lens rated it Minor and the security lens rated it Minor at high
  confidence; two independent findings on one line, with two sessions per project a supported case,
  is what moves it into the fix round rather than the backlog.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. This session's own
targeted verify lane on the post-round-10 tree, taken 2026-09-08T14:46:48Z under a claim it wrote and
released, both exit codes read from the runs themselves: lint exit 0; the harness and stand-in lanes
exit 0 with tests 51, pass 51, fail 0, duration 13.8s. That is the lane round 12 reports against. The
close gate is this session's and has not run.

**A false instrument caught before it did damage, worth carrying because its verdict is
destructive.** The never-started reading for a dispatch was taken from the output path the Agent tool
advertises, which on this machine is a zero-byte placeholder created at dispatch and never written
again. It therefore produced the exact never-started shape, zero bytes and zero assistant lines, for
a healthy agent, and that shape authorizes a TaskStop, which on a live implementer mid-edit leaves a
half-written file with no author. Three memory records name this and were stamped applied. The real
artifact is the agent's own transcript under the session's `subagents/` directory, which showed 7,280
bytes of growth in eight seconds for the same dispatch.

**Next action per section.** Section 2: adjudicate fix round 12's report against the code, re-review
whatever the fix delta earns under the owed-round triggers, take the heavy-process claim, run the
whole gate with the contention lane beside it, then close with a Chapter and commit and push,
carrying the nine deferred doc-commit pushes with it. Sections 3 through 6: unstarted, in order.
Section 4 is no longer gated on an Open Questions answer, the operator having answered the prompt
tool's allow rule at the keyboard on 2026-09-08.

**Committed at this boundary, not pushed,** on the same reasoning as the last nine: a push to this
repository's main is an install surface that takes the whole gate, and a fix round is editing the
tree right now, so the gate cannot honestly run yet. The commit is the durable recovery point and the
push rides with the section close. Section 2's sixteen uncommitted `bridge/` paths stay as they are.

**Routed out of this plan.** The security lens named a path-guard export gap outside this section's
files: the broker's own transcript-path guard is private and the bridge's workspace guard is a
stricter second implementation of the same boundary. It is named in the code's own comment rather
than silent, so it is not drift by amendment 2's bar, but two path guards with different rules now
sit at two hostile boundaries. Routed to `docs/backlog.md` rather than fixed here.

### Interim board 13 - 2026-09-08

Written at the compaction gate's own signal, 19 offers held over 40 minutes, and at the closure
drought's floor: section 2's thirteenth review round is adjudicated, no section has closed since
Chapter 1, and fix round 14 is in flight.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through thirteen full three-lens review rounds, and is in fix round 14, the
sixth at the escalated fable tier. Sections 3 through 6 are unstarted. Section 2's fifteen untracked
`bridge/` files and its one modified tracked file are uncommitted.

**Fix round 12 was adjudicated against the code rather than adopted from its report, and all five of
its Majors and eight Minors verified closed.** `recall()` now refuses to replace a record this
process owns with the file's copy, returning the disk record only in the one case the file can speak
to that the copy cannot, another live process holding the name, with `heldElsewhere()` as the single
predicate both that path and the refusal read, so the two cannot come to disagree. `sessionLogFile`
is gone from the timeout catch entirely rather than guarded there, and now has exactly two callers,
both of them tools where a throw is a failed call that strands nothing; the freshly minted session id
is held to the same shape check as the stored one at the point it is minted, so both take one guard
before either is written down or rendered. The first-turn record is kept, with the premise's own
sentences reworded to state the refusal as inferred, to cite the two SDK paths that contradict it,
and to name Section 5 as the section that observes the runtime. The turn-end payload carries an
`accepted` bit so Section 3's record writer can order its two sections, with the listener's contract
stated in the option's own doc. And the state write now carries every scope's entries through raw and
overlays this bridge's records onto its own scope's raw entries by name, so a neighbour's record in a
shape this version refuses is no longer deleted by the rename.

The round's own reported protocol breach is recorded rather than smoothed over: its red lanes were
spawned in the same command as the claim-file read, with no conditional between them, and ran about
fifty seconds while a foreign claim was live. The reds are unaffected in kind, each having failed on
the assertion it names, but they were taken on a contended box. Its later spawns were gated on a
poller it wrote for the purpose, and fix round 14's brief carries that pattern as an instruction
along with the reason the chained form cannot work: a read and a spawn in one command cannot branch
on what the read returned.

**Two items round 12 flagged rather than fixed were folded by this session, both in the section's own
files.** The log call in `lost()` is now guarded on its own, which matters more than the Minor it
mirrors: everything that method exists to do runs after that line, so a throwing sink would have left
the model waiting on turns nothing would ever end and an unsandboxed worker running with no handle
left to reap it by. And the workspace-binding premise in `refuseWrongWorkspace`'s doc and in
`bridge/README.md` is marked inferred with Section 5 named, with the refusal's reasoning restated so
that it no longer rests on that premise: pointing a name at a new workspace abandons the conversation
the state file exists to preserve, which holds whichever way the runtime answers.

**Live dispatches.**

- `implementer-fable`, section 2 fix round 14, dispatched with the explicit fable model override the
  escalation authorizes. It carries the round-13 findings file under the gitignored scratch path
  (four Majors, ten Minors, a thirteen-item not-your-work list), all four Standing Brief Amendments
  with the instruction to re-read amendment 4 because it gained a fourth half minutes before the
  dispatch, every standing prohibition, both reading traps, the red-first and byte-verified-restore
  discipline, and the box-budget clause with this session's identity substituted, the live foreign
  claim named as overrun, and the instruction to gate every spawn on a claim-free poll rather than
  reading the claim once.

Round 13's three review dispatches have completed and are adjudicated.

**Review round 13 adjudicated. No Critical from any lens**, which is the fourth consecutive round
that can say so, so the tier-escalation ladder does not fire and fable remains the writer tier.
Verdicts were APPROVED_WITH_CONCERNS, CHANGES_REQUIRED and CONCERNS. First-turn readings were taken
on all three at the window and each was healthy: 40, 22 and 42 non-synthetic assistant lines with a
`<synthetic>` count of zero. The round was bracketed by a `git status --porcelain` capture before
dispatch and again at return and the two are byte-identical, so no agent moved the tree under the
round. Four Majors and ten Minors stand.

**The round's two most consequential findings, both confirmed by this session before they were acted
on.** `dsh_status` calls the log reader unguarded, and that reader throws on states that are ordinary
rather than exotic, a log past its ceiling and a generation file rotated between the existence check
and the read among them, so the whole tool call fails and the model loses the fields that never
needed the log at all: whether the session is live, whether a turn is in flight, and which turn.
Found independently by two lenses, and the report type already models the degraded case. Separately,
the owner lease reaches disk only once the runtime has answered the prompt, so during a window
bounded by the request timeout rather than by anything quick the file still carries the previous run's
dead owner, and a second bridge in the scope reads it correctly, takes the name, and resumes the same
session id in a second runtime. That is the two-unsandboxed-workers-on-one-log hazard the lease exists
to prevent, surviving a lease, and the existing test states both halves of it in its own comment while
exercising only the same-bridge case.

**Rulings adopted since the last boundary.**

- **Standing Brief Amendment 4 gains a fourth half, under the recurrence rule, and it is the write
  side of the second.** The second half fixed the read: a check whose subject is shared between
  processes opens the shared file at the moment of the check. That left the other end untouched, and
  a guard can read the file faultlessly and still see nothing, because the fact it is looking for has
  not been written yet. So a guard against another process is worth only what is visible to that
  process at the window's start, and the claim is published before the act it guards rather than
  after that act succeeds. The lease is this class's third instance in three rounds and the fifth
  time in this section that a fix has left open the case it was written for; the two earlier
  instances are the same mechanism read from the other end, the lease taken from a constructor
  snapshot and the held record replaced by a stale copy. The machine's own heavy-process protocol is
  named as the worked example on this side too, and in the same detail: its claim is written before
  the spawn, never once the suite is running. Approval drift, recorded.
- **An unowned security Major is given an owner rather than parked, and the owner is section 4.** The
  installer hardens every path on the execution chain and names no `bridge/` path at all, so the
  bridge's own sources, its runtime binary and the patch file that presets the worker's sandbox and
  approval to their widest values sit outside the protected set; write access to any of them is code
  execution in the operator's context, and the patch file in particular lets the worker's confinement
  be changed without touching a hardened file. It is not section 2's to fix, and the reason is not
  scope bookkeeping: the exposure does not exist while the plugin is unregistered, and section 4 is
  what registers it. So section 4 gains an acceptance criterion for the hardening and its pin, and
  `install/Install-Host.ps1` joins that section's `Files in scope` and leaves `## Out of Scope` the
  same day. Approval drift, recorded, and named to the operator as the scope change it is.
- **A security Major on the workspace's containment is ruled a recorded decision rather than a
  defect, with the record half routed to section 6.** The workspace is checked for shape and not for
  location, so any absolute drive-rooted directory the calling model names is admitted, and the
  dedicated worktree the accepted risk's reasoning leans on is a convention rather than a
  confinement. The operator answered that exact fork at the keyboard on 2026-09-08 with a workspace
  allowlist as one of three options and not the one chosen, so adding a location check now would
  reverse a decision rather than close a defect. What was genuinely owed is the record: section 6
  now states the boundary as it actually is, wider than the accepted risk's own reasoning implies,
  rather than leaving an auditor to infer a bound that is not there.
- **Two deviations from acceptance criteria are recorded rather than reversed.** `dsh_busy` reads
  true from the moment a prompt is sent rather than from acceptance, where the criterion says
  acceptance; the code's reason is sound, since a turn marked in flight only after acceptance has
  already missed the idle that would end it, and the wider window is the safer one for what
  `dsh_busy` is consulted for. And a channel push can precede `dsh_prompt`'s return on two paths, a
  held end released at confirmation and the request timeout's own finish, where the criterion says
  the receipt returns before any push for that turn; the inversion happens only when the turn was
  already over. Both stand as written and the fix round is told not to change either. The README
  paragraph that implies the event always follows the receipt is the fix round's to correct.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. Fix round 12 reported its
own final lanes on its own tree, with exit codes read from the runs, as `tsc --noEmit` exit 0,
`harness.test.ts` 54 of 54 exit 0 (from a baseline of 49), `index.test.ts` 11 of 11 exit 0 (from 10),
`log.test.ts` 17 of 17 and `protocol.test.ts` 21 of 21 both unchanged and exit 0; those are the
implementer's numbers on the implementer's tree, taken partly under the contention recorded above,
and they are the baseline round 14 reports against. This session's own verification lane and the
close gate have not run, and the reason is the box rather than the schedule.

**The machine's heavy slot is held and has overrun.** The claim is a worker seat on another
repository, file modification time 2026-09-08T15:43:02Z with an expected 900 seconds, so at the
16:05Z reading it was 22 minutes old against its own fifteen. Presence is grounds for waiting and an
absent claim would not be grounds for starting, so the slot is taken under the protocol at the gate
rather than assumed. It is not this session's to delete, its `Session:` line being another's. Round
13's three lenses were dispatchable against the hold because reviewers build nothing, and the
constraint rode in all three briefs; the whole gate is what waits.

**Next action per section.** Section 2: adjudicate fix round 14's report against the code, re-review
whatever the fix delta earns under the owed-round triggers, take the heavy-process claim once the
foreign hold clears, run this session's verification lane and then the whole gate with the contention
lane beside it, then close with a Chapter and commit and push, carrying the eleven deferred
doc-commit pushes with it. Sections 3 through 6: unstarted, in order. Section 4 now carries the
installer-hardening criterion above; section 6 now carries the containment record.

**Committed at this boundary, not pushed,** on the same reasoning as the last ten: a push to this
repository's main is an install surface that takes the whole gate, a fix round is editing the tree
right now, and the machine's heavy slot is held by another session, so the gate cannot honestly run
yet. The commit is the durable recovery point and the push rides with the section close. Section 2's
sixteen uncommitted `bridge/` paths stay as they are.

### Interim board 14 - 2026-09-08

Written at the compaction gate's own signal, 21 offers held over 65 minutes, and at a clean point: section
2's fourteenth fix round is adjudicated against the code, its verification lane has been run by this
session under a claim it wrote and released, and the fifteenth review round is in flight after its first
dispatch triple-wedged and was re-dispatched. No section has closed since Chapter 1.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through thirteen full three-lens review rounds and fourteen fix rounds, and is in
review round 15. Sections 3 through 6 are unstarted. Section 2's fifteen untracked `bridge/` files and its
one modified tracked file are uncommitted.

**Fix round 14 was adjudicated against the code rather than adopted from its report, and all four of its
Majors and ten Minors verified closed.** `dsh_status` now reads the log under one guard covering the whole
read, both finding the file and opening it, and degrades to a report carrying `logUnread` with the log
fields absent, so a log past its ceiling or rotated between the listing and the read no longer costs the
model the three fields that never needed the log: whether the session is live, whether a turn is in flight,
and which turn. `tail` still raises on the same read, correctly, the log being that tool's whole subject.
The caller-supplied session name is bounded at 120 code points in one constant, enforced at the bridge's
own entry before anything reads it and declared as a schema `maxLength` on all four `session` properties
through a single shared argument object, so the bound cannot be declared on three of the four by omission.
A status call's log read is bounded by a byte ceiling stated as a latency budget with the plaintext budget
derived from the same shared ratio the container walk uses.

**The round's own headline fix was verified live rather than inert, and that check was the whole of the
adjudication's value.** Round 13's Major was that the ownership lease reached disk only once the runtime
had answered the prompt, so a second bridge prompting inside that window read the file correctly and still
found the previous run's dead owner. The fix moves the write ahead of the request, and the code does read
that way: the record carrying this process as owner is set in the map and written immediately after, before
the prompt request goes out, with the comment stating amendment 4's fourth half in the code's own words.
What that reading alone cannot establish is whether the record survives the write, because the write does
not lay the map down whole: `persistable()` filters it, and a lease written into a map that drops it would
have left the code reading correctly at every future review while the guard covered every moment except the
one it exists for, which is this section's own recurring failure shape. The filter keys on ownership
(`record.owner?.pid === process.pid`) and the claim record carries this pid, so the claim does reach disk at
that write. The turn count is deliberately withheld until `finish`, and only for a kept turn, so no write
counts a turn the runtime is not known to have taken.

**This session's own verification lane, taken under a claim it wrote and released.** Both exit codes read
from the runs themselves rather than from a grep over their output: `npx tsc --noEmit` exit 0;
`bridge/harness.test.ts` 59 of 59 exit 0 in 13.6s, `bridge/index.test.ts` 12 of 12 exit 0,
`bridge/log.test.ts` 18 of 18 exit 0, `bridge/protocol.test.ts` 22 of 22 exit 0. Against round 12's lane of
54, 11, 17 and 21 that is plus 8 tests and plus 8 passes, which is exactly the extension the round reported,
so the round's own numbers reproduce on this session's tree. Nine files carry today's edits and no others:
`harness.ts`, `protocol.ts`, `index.ts`, `log.ts`, `README.md` and the four test files, all LF-only at zero
carriage-return bytes. `bridge/fake-dsh.ts` is byte-identical to its pre-round copy, and
`bridge/tools/sdk-smoke.ts` was not touched by the round, its modification time predating the dispatch by
nineteen hours while its diff against HEAD is section 2's own earlier fold.

**The machine's heavy slot cleared, was taken for that lane, and was released at the lane's end rather
than at the turn's.** The foreign worker seat on another repository that had held the slot since
2026-09-08T15:43:02Z against a 900-second estimate was gone by 16:52Z, with no `testhost` or `dotnet`
process left in the list. An absent claim is nobody having claimed the box rather than evidence the box is
free, so the slot was taken under the protocol at 16:54:50Z with a clock read at the moment of the write,
held for the four lanes, and deleted after verifying its own session line. The release is timed to the
operation rather than the turn on purpose: a review round needs no box, and a claim held across one reads
to every peer as a session still running a suite while it is in fact adjudicating text.

**Review round 15's first dispatch wedged on all three lenses at once, and the cause is recorded because
it is actionable rather than ambient.** The three lenses were dispatched at fable through the Agent tool
against a byte-identical tree capture. Each ran about five minutes, produced 44, 27 and 27 non-synthetic
assistant lines with a `<synthetic>` count of 1, 0 and 1, and then stopped appending within ninety seconds
of one another. The fifteen-minute review-class growth window closed with no growth on any of them;
liveness probes were sent to all three and the twelve-minute probe window closed with no rise in any
non-synthetic assistant count above its value at the send, the probes never having been delivered, since
delivery happens at an agent's next tool round and none of the three took another. That is the whole wedge
hallmark, so all three were stopped, and the stop notifications named the cause: each agent's last message
was an intent to read one file whole, `bridge/harness.ts` at 1,956 lines and 108,432 bytes or
`bridge/harness.test.ts` at 2,057 lines and 123,333 bytes. Three concurrent whole-file reads of a 108 KB
source is a cause rather than a coincidence, so the one same-dispatch re-attempt the rule allows was spent
on a dispatch with that cause removed rather than on an identical retry: every brief now requires those two
files to be read in slices of at most 400 lines. The re-dispatch is healthy, its first-turn readings at 5,
21 and 14 non-synthetic assistant lines and all three growing. A wedge is an environment fault rather than
a failed round, so it counts against neither the two-failure tier ladder nor the never-a-third-dispatch bar,
and the tree bracket taken before the first dispatch and read again after the stops is byte-identical, so
no agent moved the tree and the same capture brackets the re-attempt.

**Live dispatches.**

- `adversarial-reviewer` at fable through the Agent tool, section 2 against the spec, base ref `f1772ad`
  with the changed-file list, the `Amendments in effect:` line carrying all four entries with the fourth's
  four halves, and two areas named as areas rather than findings: the lease's best-effort claim write with
  its give-back path and its process-death case, and the `dsh_status` guard's coverage.
- `blind-reviewer` at fable through the Agent tool, base ref and changed-file list only, with the
  shared-artifact guard property stated as a standing property of the repository that reads identically for
  every diff in it, and no mention of the spec, the plan, or the section.
- `security-reviewer` at fable through the Agent tool, section 2, the same amendments line, the component's
  threat model, and three areas: the lease's coverage, the session-name bound's enforcement at every entry
  against amendment 3's field-by-field check, and whether the status ceiling and its derived plaintext
  budget actually bound the decompression path.

All three carry both reading traps, every standing prohibition, and the range-reading requirement the
wedge earned.

**Rulings adopted since the last boundary.**

- **The fix round's four concerns are dispositioned rather than carried.** The best-effort claim write,
  where a failing write is logged and the prompt proceeds rather than refusing, is handed to the
  adversarial lens as a question rather than adopted or overruled here, since the trade it makes (a
  neighbour holding the file unreadable would otherwise refuse every prompt for as long as it holds it) is
  exactly a reviewer's to weigh and is stated in the code and the README rather than hidden. The
  `dsh_status` deviation from the Approach's letter, where the degraded case reports no counts while the
  Approach says the counts come from the on-disk log, is a real spec deviation and is corrected to
  as-built at this section's step 5 rather than reversed: the degraded case is what round 13's Major
  demanded and the design intent is unchanged, the tool still reading the counts from the log whenever it
  can. Minor b is closed in code with its reachability confirmed by reading and its runtime occurrence
  unmeasured, and it carries no durable test because exercising it needs a flag on the stand-in runtime and
  `bridge/fake-dsh.ts` was omitted from the round's brief though the spec's own Files in scope names it;
  that omission is this session's and is recorded here rather than charged to the round. The fourth concern
  needed no ruling: the brief's instruction to use the Edit tool over Bash for text edits is correct on
  this host, where the shell mangles quoting and backslashes.
- **Two figures the round could not source are removed rather than left standing.** The log module's
  comments had carried a figure of about eight megabytes that no artifact supports, the measured snapshot
  being 4,216,915 bytes and the spec's own observation naming a 4 MB file, and a figure of about four
  hundred bytes per frame that the snapshot contradicts at an average of 1,379. Both are out of the
  comments, which now cite this plan's Chapters, which is where a measured figure carrying its own moment
  belongs.
- **A kaizen note is filed on the kit rule that produced the triple wedge.** The doctrine's
  hunting-in-a-large-file rule requires an outline before reading a file past roughly a thousand lines and
  then exempts the file under review, requiring it read whole. That exemption's reasoning is sound, since a
  reviewer must see its whole subject and an outline cannot prove absence, so the defect is that it states
  a reading goal as a reading method, and the most literal mechanism for it has an undocumented ceiling
  that fails after the agent has done real work and presents as a wedge rather than a refusal. The note
  names two candidates: require the whole file in bounded ranges rather than one call, or have the dispatch
  brief template carry a measured line-and-byte count for every in-scope file past a threshold, since the
  dispatching session already stats those files and the agent cannot know the size before committing to the
  read.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this checkout
with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0, skipped 1,
duration 147.6s, against a committed baseline of 1582/1581/0/1. The targeted lane above, taken by this
session 2026-09-08T16:55Z to 16:58Z on this checkout under a claim it held and released, with the section's
own sixteen uncommitted paths present and no foreign uncommitted files, is the current reading on the
section's own files: tsc exit 0, harness 59/59, index 12/12, log 18/18, protocol 22/22, all exit 0. The
close gate is this session's and has not run, and the reason is now the round rather than the box: the slot
is free and the tree is stable, but round 15's fixes will move it, so a whole gate run before those land
would report on a tree the push will not carry.

**Next action per section.** Section 2: adjudicate review round 15 against the code, dispatch the fix round
it implies and re-review whatever that fix delta earns under the owed-round triggers, correct the
Approach's `dsh_status` sentence to as-built at step 5, take the heavy-process claim, run the whole gate
with the contention lane beside it, then close with a Chapter and commit and push, carrying the twelve
deferred doc-commit pushes with it. Sections 3 through 6: unstarted, in order. Section 4 carries the
installer-hardening criterion adopted at Interim board 13; section 6 carries the workspace-containment
record adopted there.

**Committed at this boundary, not pushed,** on the same reasoning as the last eleven: a push to this
repository's main is an install surface that takes the whole gate, and a review round is reading the tree
while its fix round will edit it, so the gate cannot honestly run yet. The commit is the durable recovery
point and the push rides with the section's close. Section 2's sixteen uncommitted `bridge/` paths stay as
they are.

**Altered outside this repository.** One line was appended to the kit repository's kaizen inbox at
`kaizen/notes-NEO-CLAUDE.md` in that clone, which is that file's normal accreting state and is left
uncommitted there for the kaizen skill's own adjudication seats, and is named here and in the close-out
rather than left as an unexplained dirty file on the machine.

### Interim board 15 - 2026-09-08

Written at a clean point rather than at the gate's signal: section 2's fifteenth review round is
adjudicated, Standing Brief Amendment 4 has gained a fifth half for what that round found, and fix
round 16 is in flight. The compaction this session's last boundary authorized has landed and no
deferral episode is open. No section has closed since Chapter 1.

**Section stages.** Section 1 is closed and pushed (commit 7e790cd). Section 2 (Bridge core) is
implemented, has been through fifteen full three-lens review rounds and is in fix round 16. Sections
3 through 6 are unstarted. Section 2's untracked `bridge/` files and its one modified tracked file
are uncommitted.

**Review round 15 adjudicated. No Critical from any lens**, which is the sixth consecutive round
that can say so, so the tier-escalation ladder does not fire and fable remains the writer tier.
Verdicts were CHANGES_REQUIRED, CHANGES_REQUIRED and CONCERNS. The round was bracketed by a
`git status --porcelain` capture that is byte-identical to the previous round's closing capture, so
no agent moved the tree between the rounds.

**The round's finding is one defect, not the two every lens reported, and establishing that was the
whole of the adjudication's value.** All three lenses found the claim race and the failed-write
overwrite independently, from the spec, from the diff alone and from the threat model, and each
proposed its own fix for each. Read against the code they are one cause reached from two
directions. `writeState`'s edit callback lays every record over the file unconditionally, and the
re-read that would authorize a refusal is already in hand: `rewriteState` parses the file inside the
write. So two bridges that both read a name as free both publish it, the later rename wins whole,
neither is told, and both prompt one session id in two runtimes. The turn-count write at a turn's
end reaches that same callback through `persistable()`, whose filter keys on this process owning the
record, which establishes that this bridge believes it holds the name and never that the file
agrees, so a count written after a neighbour legitimately took the name overwrites a live lease with
a dead one and refuses that neighbour mid-conversation. One conditional edit closes both, and the
conditional shape was already in the same file thirty lines from the defect, in the claim's own
release path.

**A lock file was weighed and rejected.** It would make the window exactly zero, where a conditional
edit narrows it to a preemption between two adjacent synchronous calls. What it costs is a failure
mode worse than the one it fixes: a bridge that dies holding the lock wedges every prompt on the
machine until stale-lock recovery is reasoned about, and stale-lock recovery is the same liveness
problem the lease already has, moved one level down with nothing gained. The residual window is
named honestly in the amendment, the code and the README rather than described as closed.

**Standing Brief Amendment 4 gains a fifth half, under the recurrence rule, and it is this class's
fourth instance in four rounds.** The second half fixed where a guard reads. The fourth fixed when
the claim is published. Both leave a guard that reads correctly, publishes on time and still admits
two winners, because nothing ties the write to the read that authorized it. So a claim against
another process is written as a compare-and-set against the shared artifact, refusing where the
artifact now carries another live claimant, or verified by a read after the write that reverts and
refuses on finding a foreign claim. The half carries a second paragraph the instance earned: a write
filtered on "records this process owns" is filtered on the wrong question, and the filter that keeps
a claim alive through a write is not the filter that decides whether the write may touch a name.

**The Approach is corrected to as-built at step 5.** Its `dsh_status` row promised the turn, step and
compaction counts unconditionally from the on-disk log; the degraded case round 13 demanded reports
the state, the in-flight bit and the turn with those four fields absent. Design intent is unchanged,
so the sentence is corrected rather than the code reversed.

**Interim board 14's diagnosis of the round-15 triple wedge is wrong, and this entry corrects it.**
Board 14 attributed three simultaneous reviewer wedges to three concurrent whole-file reads of
`bridge/harness.ts`, and a kaizen note was filed against the doctrine's read-whole rule on that
basis. Fix round 16 disconfirms it: the brief mandated slices of at most 400 lines, the agent obeyed,
and it wedged anyway. Its transcript's own records name what happened. The 123 KB edit to
`bridge/harness.test.ts` succeeded and the tool result is recorded; what never returned was the next
inference request, at fable, on roughly 185,000 tokens of cached context. Both wedges share a
large-context fable turn rather than a file operation, which also explains what the file-size reading
could not, why round 15's three agents stopped within ninety seconds of one another: one shared meter
emptying is a mechanism where three coincident large reads is a coincidence. The claim is inferred
rather than confirmed. A fable dispatch carrying a trivial context answered in seventeen seconds,
which bounds the hypothesis rather than settling it: that probe tested whether the tier serves at all
and not the failure mode. What is owed at close-out is an amendment to the kaizen note, which
currently aims its remedy at how a reviewer reads a large file.

**The recovery was a resume rather than a re-dispatch, and it preserved the round.** The wedged
agent had written its four tests and left `bridge/harness.ts` byte-identical to its own pre-copy, so
the fix was unstarted while the tests that pin it were done. A resume carried its context forward,
with the work method rewritten around the hazard: every edit to either outsized file a small targeted
call with the minimum anchor, and one line of plain output after each, so a freeze costs a minute
rather than half an hour. The resumed agent has since changed `harness.ts`, `harness.test.ts`,
`protocol.ts` and `README.md`.

**Two readings of this session's own were wrong and were caught by controls rather than by
inspection.** A check for backslashes in a drafted file returned no matches and was reported as
clean; its control, a file with a backslash written for the purpose, also returned no matches, which
is what exposed the instrument. This host's Bash tool collapses a backslash even inside a
single-quoted heredoc, so the same defect had corrupted the pattern, the subject and the calibration
in one call, and an instrument whose escape syntax travels through the layer under test cannot
measure that layer. Counting the byte by its octal name settled it: ten in `bridge/protocol.ts`,
zero in the draft. Separately, a peer session was briefly suspected of writing in the tree on the
strength of a file modification time, which was a misreading of a listing printed with clock times
and no dates; the file was the previous day's, and no peer is in the tree.

**The machine's heavy slot is held by another repository's session** and has not overrun: the claim
was written 2026-09-08T18:39:30Z against a 3600-second estimate, so at the 15:10 local reading it was
31 minutes into its own 60. No `node --test` or `tsc` process is running, and a foreign claim's
presence is grounds for waiting where its absence would never be grounds for starting. The fix
round's brief gates every heavy spawn on a claim-free poll, so its own lanes wait on that slot, and
so does the close gate.

**Gate baseline.** The whole-gate baseline is still the run taken 2026-09-07T19:59:14Z on this
checkout with no foreign uncommitted files: lint exit 0, test exit 0, tests 1609, pass 1608, fail 0,
skipped 1, duration 147.6s, against a committed baseline of 1582/1581/0/1. The current reading on the
section's own files is this session's targeted lane of 2026-09-08T16:55Z: tsc exit 0, harness 59/59,
index 12/12, log 18/18, protocol 22/22, all exit 0, every exit code read from the run. No gate has run
on the present tree and none can honestly run yet, the round being mid-fix and the box being held.

**Next action per section.** Section 2: adjudicate fix round 16 against the code, re-review whatever
its delta earns under the owed-round triggers, take the heavy-process claim once the foreign hold
clears, run this session's verification lane and then the whole gate with the contention lane beside
it, then close with a Chapter and commit and push, carrying the deferred doc-commit pushes with it.
Sections 3 through 6: unstarted, in order. Section 4 carries the installer-hardening criterion adopted
at Interim board 13 and now the dependency-advisory criterion routed from round 15; section 6 carries
the workspace-containment record and now the security-model entry the bridge is owed before the plugin
registers.

**Committed at this boundary, not pushed,** on the same reasoning as the twelve before it: a push to
this repository's main is an install surface that takes the whole gate, and a fix round is editing the
tree while the box is held by another session, so the gate cannot honestly run yet. The commit is the
durable recovery point and the push rides with the section's close.

**Altered outside this repository.** One line remains appended to the kit repository's kaizen inbox at
`kaizen/notes-NEO-CLAUDE.md` in that clone, uncommitted there for the kaizen skill's own adjudication
seats. That note is the one this entry establishes is aimed at the wrong cause, and amending it is
owed at close-out.
