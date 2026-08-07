# Channels install simplification

Status: Complete
Commit model: commit on request (no standing push authorization)

## Why

Installing a host today is four documented steps across two elevation contexts, plus a hand-written
managed-settings file and two interactive `/plugin` commands. The steps are individually guarded but
the sequence is operator-assembled, and a host stopped halfway lands in the half-working states
`docs/install.md` warns about. The operator asked for one command that takes the Discord channel ID
and user ID and does everything scriptable, elevating only where elevation is required.

## Constraints that shape the design

- **The unelevated/elevated split is load-bearing.** Files created elevated are owned by
  Administrators, and the broker's credential guard reads that owner shift as a planted token file.
  So the orchestrator itself must run unelevated and refuse elevation, exactly as `Install-Host.ps1`
  does, and spawn one elevated child for only the steps that need it.
- **Three steps genuinely need elevation:** registering the scheduled task, writing
  `C:\Program Files\ClaudeCode\managed-settings.json`, and writing the machine-wide PowerShell
  profile block that dot-sources the wrapper and aliases `cchat`.
- **The plugin route is headlessly scriptable:** `claude plugin marketplace add <path>` and
  `claude plugin install relay@sapplefeld-channels` are CLI commands, no interactive session needed.
- **What stays manual:** creating the Discord application and bot, enabling Message Content Intent,
  inviting the bot, and creating the private channel. That is a web console.

## Sections of work

### 1. Install-Elevated.ps1

`install\Install-Elevated.ps1`: the elevated child. Refuses to run unelevated (mirror of
`Register-BrokerTask.ps1`'s guard, opposite direction from `Install-Host.ps1`'s). Takes
`-User`, `-EnvFile`, `-RepoRoot`, and test seams for the paths it writes. Does three idempotent
things:

- runs `Register-BrokerTask.ps1` with the passed user and env file,
- writes the managed-settings file (creating `C:\Program Files\ClaudeCode\` if absent), merging
  `channelsEnabled` and this project's `allowedChannelPlugins` entry into an existing file rather
  than clobbering someone else's keys or allowlist entries,
- installs the profile block into the machine-wide Windows PowerShell profile
  (`$PSHOME\profile.ps1`), between `# region sapplefeld-channels` markers so a re-run replaces its
  own block and never touches operator content outside the markers,
- restarts the broker so it runs the code and config just installed (the scheduled task only fires
  at logon, so nothing else ever bounces a running broker): stop the task, clear a node process
  still holding the port (anything else on the port refuses rather than kills), start the task.
  Readiness is checked by the unelevated parent, not here, because this child's console vanishes
  with its UAC session.

### 2. Install-All.ps1

`install\Install-All.ps1`: the orchestrator, run unelevated.
`-HostName -ChannelId -AllowedUserId [-BotTokenFile] [-Port]`, token prompted securely when not
given, all passed through to `Install-Host.ps1`. A verify-run on an installed host reuses the
existing hardened token file instead of re-prompting, so the idempotent path never risks an empty
token overwrite; rotating is passing a token explicitly. Then:

- registers the marketplace and installs the plugin via the `claude` CLI, tolerating
  already-installed,
- launches the elevated child once via `Start-Process -Verb RunAs -Wait`, passing the current
  account name and this state root's `broker.env` path explicitly so the ACL/principal mismatch
  trap cannot fire, and fails loudly on a non-zero child exit (the child sets
  `$ErrorActionPreference = 'Stop'` with a trap, so a failed cmdlet becomes that non-zero exit
  rather than text in a vanishing console),
- waits for the restarted broker to answer on its `/sessions` endpoint, a real readiness signal
  rather than a sleep, and fails naming the broker log if it never comes up,
- prints the remaining manual checklist: the Discord console steps if the bot does not answer, and
  the per-host verification checklist before that host's wrapper table entry moves to `--channels`.

### 3. Tests and docs

- `install/Install-All.test.ts` and coverage for the elevated child in the house probe style
  (spawned PowerShell with shadowed commands, temp LOCALAPPDATA, `-WhatIf`/seam parameters, never
  touching real machine state): the two elevation guards (as seam-carrying assert functions, the
  same shape as `Register-BrokerScheduledTask`'s), the plugin-install verification, the elevated
  launch's argument pinning and failure path, the broker-restart orchestration, the readiness wait,
  managed-settings merge behavior, and profile-block idempotency. The orchestrator's step order
  itself is straight-line runner code, exercised by the real install rather than a probe.
- `docs/install.md` gains the one-command path as the front door, with the existing steps kept as
  the reference for what it does and for partial re-runs.

## Chapters

### Chapter 1: all three sections, delivered in this changeset (2026-08-07)

Shipped: `install/Install-Elevated.ps1` (task + managed-settings merge + profile block for 5.1 and
pwsh-when-present + broker restart), `install/Install-All.ps1` (unelevated orchestrator with token
reuse, headless plugin install, one UAC child, `/sessions` readiness wait), nine probe tests in
`install/Install-All.test.ts`, and the one-command front door in `docs/install.md`. Riding in the
same changeset, from the diagnosis that started the effort: NEO's wrapper table entry flipped to
`--channels` (two relays were racing on one session, the dev-route `--mcp-config` copy against the
newly installed plugin's copy, visible in broker.log as "refused a second pipe"), the machine-wide
profile with the `cchat` alias hand-written on NEO (identical in shape to what the installer now
writes, so a re-run adopts it), `Name` made positional with `--` pass-through for single-dash
claude flags and a leading-dash name guard, and `--name $Name` added to both launch lines.

Decisions and surprises:

- `claude --name <name>` exists and sets the session display name (picker + terminal title), the
  same surface /rename writes. Confirmed against this host's installed CLI via `claude --help`;
  older fleet CLI builds are unverified, which matters because the wrapper passes it
  unconditionally.
- `ValueFromRemainingArguments` does not protect single-dash flags from PowerShell's common
  parameters (`-p` binds to `-PipelineVariable` and vanishes); `--` is the documented escape, and
  the reviewer's live 5.1 probe is what caught it.
- The elevated child's exit code is its only signal, and PS 5.1's `-File` exits 0 on
  non-terminating cmdlet errors, so the runner sets `$ErrorActionPreference = 'Stop'` with a
  `trap { exit 1 }`. Without it a failed task registration printed into a vanishing UAC console
  and read as success.
- Both review agents' findings adjudicated: all accepted except reverting the NEO flip (kept,
  verification pending below), the marketplace stale-path minor (mitigated by design: the shim
  resolves the live relay from relay-mcp.json, rewritten each launch), and the
  single-quote-in-RepoRoot pathological path.

Gate: full suite 549/550 pass, 0 fail, 1 skipped (baseline before the effort: 540/541, 0 fail; all
nine new tests are this effort's).

Remaining before Complete, both operator-gated: the NEO plugin-route live verification (thread
round-trip + `lastTool` = `mcp__plugin_relay_channel-relay__reply` on the wire), and one real
`Install-All.ps1` run on a host (ASR is the natural candidate) to exercise the runner sequence no
probe covers.

### Chapter 2: ASR flips to the plugin route ahead of its install (2026-08-07)

ASR's table entry moves to `--channels` in the same delivery, before its install rather than after
its checklist, because the checklist's own ordering assumption no longer holds: `Install-All.ps1`
installs and allowlists the plugin as part of provisioning, and an installed plugin's relay loads
in every session regardless of launch route (observed on NEO: an unwrapped session carried the
plugin relay tool with no channel flag at all). A dev-flag wrapper launch beside an installed
plugin is therefore a guaranteed dual-relay collision, the failure that opened this effort. The
per-host checklist still runs on ASR's first wrapped launch; the wrapper and install.md prose now
describe the plugin route as the fleet default with the development flag kept for a host that must
launch before its plugin is installed. Delivered with all of Chapter 1 in this changeset's commit.

### Chapter 3: the elevated half runs for real on SCOTT (2026-08-07)

A verify pass on SCOTT after the operator's repo pull. `Install-All.ps1` refused to run because
sessions on SCOTT hold an elevated token, so its unelevated guard fired; that guard working as
designed is itself a real-run observation, and the workaround is recorded in project memory
(claude-sessions-on-scott-run-elevated). `Install-Elevated.ps1` then ran directly from the
session's already-elevated shell, exit 0: task re-registered in place, managed-settings merge was
a structural no-op over the operator's correct file, the machine-profile block and `cchat` alias
were written for the first time on SCOTT (its hand-install predated them), and the broker
restarted onto the pulled code (its process predated the pull, which changed `broker/intake.ts`).
Readiness confirmed by the parent-side wait: `/sessions` answered on the first probe and
broker.log shows the gateway reconnected. A stranded close-out chapter for the archived
channel-quality plan was found dirty in the worktree and committed as `b257fa1` under that plan's
Commit-and-Push authorization.

Still open, unchanged: the NEO plugin-route live verification, and the real `Install-All.ps1`
run, which on ASR must come from a plain operator-opened PowerShell window if ASR's sessions are
also elevated.

### Chapter 4: both operator gates pass and the effort closes (2026-08-07)

The operator confirms both remaining checks passed: the NEO plugin-route live verification and the
real `Install-All.ps1` run on ASR. That empties the gate list from Chapter 1, so the effort is
complete: every host in the wrapper table runs the plugin route, and the one-command installer has
been exercised end to end on a real host. Close-out delivered in this changeset: this plan flips
to Complete and moves to the archive, the backlog's ASR and NEO install items and the
broker-task-registration item move to the Q3 snapshot, the development-route rule-retirement item
is reworded to reflect that its fleet-wide condition is now met, and the docs index gains this
plan's archive row. The operator's confirmation is the evidence for the two gate results; this
session did not observe ASR or NEO directly.

## Related

- [`channel-quality-and-plugin_spec_v1.md`](channel-quality-and-plugin_spec_v1.md): packaged the
  relay as a plugin and verified SCOTT on the plugin route; the dual-relay collision its rollout
  exposed on NEO is the failure that opened this effort, and this plan's installer is what carries
  that plugin route to the rest of the fleet.
