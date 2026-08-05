# Session Channels: steering long-running Claude Code sessions from Discord

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: reviewer pairs on the opus-tier sections (S2, S4, S5, S6); finishing reviews. No fable-tier implementation sections.
Created: 2026-08-04

## Goal

Scott runs several long-lived interactive Claude Code sessions at once (typically one to three per
host, across three hosts named NEO, ASR, and SCOTT), each working for ten to twenty hours on a
loosely-defined goal. He needs to watch them and talk to them from his phone. Anthropic's Remote
Control is the supported way to do that and it does not survive his setup: every host runs
`claude-swap`, which rotates the paying Anthropic account mid-session as usage windows fill, and
after a rotation Remote Control stops accepting input permanently.

When this is done, every such session appears as its own Discord thread. The thread list is a live
dashboard of the whole fleet and its states. Opening a thread shows what that session is doing right
now, lets Scott send it a message that lands in the running session, and lets him approve a tool
permission prompt without being at the keyboard. None of it depends on Anthropic's cloud holding a
session registration, so a seat rotation cannot break it.

## Approach

### Why the addressing must stay off the Anthropic account

Remote Control registers a session object in Anthropic's cloud, owned by the OAuth identity that
created it. After a seat swap the session keeps running, but at the first credential-refresh boundary
the renewal happens under the new account's identity against a cloud object owned by the old one.
Nothing local can re-point a server-side registration. This mechanism is inferred from the documented
credential model and the observed failure timing, not read from Claude Code source, but the
consequence holds regardless of mechanism: **any addressing that lives in Anthropic's cloud and is
bound to an account fails this way.** The design keeps addressing entirely local, on a Discord bot
token that has no refresh boundary for a rotation to land on.

### The load-bearing split: hooks own identity, the channel owns messages

The instinctive design is a single custom MCP channel that does everything. It cannot work, for a
reason confirmed in the channel contract: **a channel server is never told the session identity.** A
`notifications/claude/channel` event carries exactly `content` plus a `meta` bag the server itself
authors, and nothing anywhere in the protocol hands the server a session ID or name. A channel is
also a subprocess of the *process*, not the session, so a `/clear` (which mints a new session ID)
leaves it untouched and unaware.

Hooks are the opposite: they are session-scoped and carry the identity. Both facts below were
confirmed empirically against the live CLI on 2026-08-04 by running a headless session with probe
hooks and reading the payloads, not from documentation:

- `SessionStart` delivers `session_id`, `transcript_path`, `cwd`, and a `source` field naming the
  trigger. **The field tracks the real trigger**, observed reading `startup` on a fresh session and
  `resume` on one launched with `--resume`; the documented value set is `startup`, `resume`, `clear`,
  `compact`, `fork`.
- Hook commands **inherit environment variables set by the launch wrapper**. A probe set
  `CHANNEL_SESSION` and `CHANNEL_PROBE_TOKEN` before launch and the hook read both back. This is the
  join key that binds a hook to the relay running in the same process.
- `PostToolUse` delivers `tool_name`, `tool_input`, `tool_response`, `duration_ms`, and `prompt_id`.
- `Stop` delivers `last_assistant_message`, `background_tasks`, and `session_crons`.
- **Hook transport is not uniform, and the split is fixed by observation.** The `http` hook type
  (documented fields `url`, `headers`, `allowedEnvVars`, `timeout`) delivers `PostToolUse` correctly:
  a probe received the complete payload as an `application/json` POST on a loopback port. The same
  configuration never delivered `SessionStart` across two runs, the second with the listener verified
  reachable before launch, while `SessionStart` over a `command` hook delivered fine in an earlier
  probe. The cause is unknown and does not need to be known: **use `command` for `SessionStart` and
  `http` for `PostToolUse` and `Stop`.** That is the right shape anyway, since `SessionStart` fires
  once per session (one process spawn is free) and the per-tool-call events are the ones that must
  not spawn anything.

So: **hooks report what the session is and what it is doing; the channel carries messages in and
out.** Neither can do the other's job.

### The three Discord surfaces

Message volume is the failure mode to design against. A session makes hundreds of tool calls an hour
and none of them should be a notification. Three surfaces, each matched to how often it can change:

**Thread name** is the always-visible coarse state. On mobile it sits in the header bar and does not
scroll away, and in the channel's thread list it makes every session's state readable at a glance
without opening anything. Format is glyph first, because list view truncates hard and the actionable
bit has to survive truncation:

```
⏸ neo-warden      needs you · Bash
⚙ neo-intake      working · 14m
⚙ neo-migrate     working · 2m
✅ scott-kit       idle · 1h
⚠ asr-docs        exited · 3h
```

Renames are the scarcest resource here. Discord's published documentation contains **no** documented
limit on channel or thread modification (both the rate-limits page and the channel resource page were
read directly and neither states one), and the docs say explicitly that limits "should not be
hard-coded" and an app "should parse response headers to prevent hitting the limit." A stricter
bucket for channel updates is widely reported by the developer community but is undocumented and can
change. Therefore the broker is header-driven: it reads `X-RateLimit-Remaining` and the `retry_after`
on a 429 and adapts. Two rules follow. Spend renames on states that need Scott (`needs you`,
`exited`) and damp states that flap (`working` to `idle` and back). **Drop a rename you cannot
afford; never queue it**, because a rename landing ten minutes late paints a state that stopped being
true.

**The thread's starter message** is the detail card, edited in place and never re-posted. A bot that
creates a thread from its own message owns that message permanently. Message edits sit in a far
looser bucket than renames, so this can carry session ID, host, current state, last tool, turn count,
and heartbeat, refreshed every few seconds. Pinning is deliberately not used: pinning emits a
"pinned a message" system message, which is the exact churn this design avoids, and a thread's
starter message already renders at the top.

**New messages** are only ever a deliberate reply from Claude or a permission request. Those are the
only things that ping the phone.

### Why the status card is a safety feature, not polish

`channelsEnabled` is an organization-level managed setting, and when it is off the MCP server still
connects and its tools still work while channel messages silently stop arriving. The warning about it
fires **at startup only**, and a seat rotation lands mid-session, hours later. So a swap onto a
non-enabled account kills message delivery with no signal whatsoever.

The status card closes that hole because the two paths fail independently: the card is fed by hooks
running locally, while messages ride the channel. If channels die on a swap, the card keeps ticking,
and Scott sees a session that is demonstrably alive and working while his messages go unanswered,
which names the failure exactly. Without the card the same failure is indistinguishable from Claude
ignoring him.

### The launch dialog, and why it is a nuisance rather than a blocker

A custom channel is not on Anthropic's approved allowlist, so it normally needs
`--dangerously-load-development-channels`, which opens a full-screen warning dialog requiring a
selection at the terminal. Two things defuse this.

First, Scott is an organization Owner for NEO and ASR. On Team and Enterprise plans an admin can set
`allowedChannelPlugins` to include a plugin from their own marketplace, which replaces the Anthropic
allowlist entirely. So on those two hosts the relay is packaged as a plugin, allowlisted, and launched
with plain `--channels` with **no development flag and no dialog**. Note the replacement is total: if
any shipped channel plugin is ever wanted on those accounts it must be listed alongside the relay.
The SCOTT host is a personal Max pool with no organization and keeps the development flag.

Second, even where the dialog remains, it fires at launch, and sessions are launched from the desk.
It costs one keypress at the moment Scott is already there, and no design can start a session
remotely anyway (a channel injects into a running session, it cannot create one). The real residual
cost is that it forecloses an unattended supervisor that restarts a crashed session, so a session
that dies while he is out stays dead until he is back. That is already true today.

### Components

Four pieces per host, three hosts. A broker is per-host by necessity: it reaches its sessions over
localhost, so it cannot serve another machine.

```
Discord ──gateway── broker daemon (one per host: owns the bot token, the gateway
                        │           connection, the session registry, the surfaces)
              ┌─────────┼──────────┐
        localhost HTTP  │      localhost HTTP
              │         │          │
          hooks     relay-mcp   hooks        relay: stdio MCP child of one session
        (session A) (session A) (session B)  hooks: SessionStart / PostToolUse / Stop
```

**Launch wrapper** (PowerShell). Sets `CHANNEL_SESSION` (the human name) and `CHANNEL_PROCESS_TOKEN`
(a fresh GUID per launch), then starts Claude Code with the relay channel.

**Hooks.** `SessionStart` announces identity: this process token now holds this session ID, named
this, triggered by this source. `PostToolUse` and `Stop` feed the status card. `SessionStart` is a
`command` hook and the other two are `http` hooks posting straight to the broker, per the transport
finding above.

**Relay MCP server.** Stdio child of one Claude Code process. Reads `CHANNEL_PROCESS_TOKEN` from its
environment, connects to the broker, declares `claude/channel` and `claude/channel/permission`, and
exposes a `reply` tool. Roughly a hundred lines.

**Broker daemon.** Owns the Discord bot token and one gateway connection. Holds two maps: process
token to relay connection, and session ID to thread ID. Routes inbound thread messages to the owning
session, renders the surfaces, and relays permission verdicts.

Routing note: the broker routes replies **by session, not by the `chat_id` argument Claude passes**.
The chat_id from an inbound event is advisory only. This means Claude can call `reply` unprompted,
with any chat_id or none, and it still lands in the correct thread.

Runtime is Node (confirmed present at v24.18.0) with `discord.js` and
`@modelcontextprotocol/sdk`. Bun also satisfies the SDK requirement but is not assumed.

**There is no build step.** TypeScript runs directly under Node 24's type stripping, so every entry
point is invoked as source (`node broker/index.ts`), which is also how S7's scheduled task starts the
broker. This buys away a compile stage and the stale-`dist` failure class, at the price of one rule:
relative imports carry the `.ts` extension. A `./thing.js` specifier type-checks clean under
`moduleResolution: nodenext` and then throws `ERR_MODULE_NOT_FOUND` at runtime, and no compiler
option catches it (`verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, and disabling
`allowImportingTsExtensions` were each measured against a probe and all three still exit 0).
`import-hygiene.test.ts` is the enforcement.

## Standing Brief Amendments

Folded verbatim into every dispatch brief from here on.

- **Relative imports carry the `.ts` extension**, never `.js` and never bare. There is no build step;
  TypeScript runs under Node 24 type stripping. `npm test` fails on a violation via
  `import-hygiene.test.ts`.
- **`tsc --noEmit` is not a runtime check.** The lint gate is blind to module-resolution failure by
  construction, so a change to any entry point is not "verified" until the entry point has actually
  been imported or run.
- **Gates are `npm run lint` and `npm test`, run from the repo root.** Report the delta against the
  stated baseline, not just "green".

### Decisions carried in

- **Thread identity is the session ID, never the name.** A `/clear` mints a new session ID and
  therefore a new thread, named for the new work. Names may repeat across months without collision.
- **Session death is signalled by the relay's stdio closing**, not by a `SessionEnd` hook, because a
  hard kill fires no hook. A heartbeat timeout is the backstop.
- **A message to a dead session is rejected in-thread with a notice.** Not queued, not dropped
  silently.
- **Permission relay is in v1.** Unattended running is the entire point, and one unanswered prompt
  parks a session indefinitely.
- **One bot identity per host**, three total, each with its own channel. This also keeps the new
  channels clear of the `Spine.Reach` bots already running on two of these hosts, which resolve
  channels named `<entity>-attention|console|journal|board` by name on every boot.

## Prerequisite gate

**This gate blocks S5 and S6 only.** It is unproven that a channel survives
a `claude-swap` seat rotation. The reasoning that it does is sound (a channel is a local subprocess
with no cloud object to orphan, `claude-swap` rewrites credential files without restarting Claude
Code, and it states that it preserves live MCP server state across swaps) but nobody has observed it.

The test uses `fakechat`, which is on the approved allowlist and needs no development flag. Launch
`claude --channels plugin:fakechat@claude-plugins-official`, send a message through the fakechat UI
and confirm it lands, run `cswap switch`, send another, and confirm it still lands. **Repeat the swap
three times**, because Remote Control's failure only appeared after repeated rotation.

**Kill condition:** if delivery stops after any swap, stop building. The fallback is several
pre-provisioned Discord bots using the shipped, allowlisted Discord plugin, leased per launch by
setting `DISCORD_BOT_TOKEN` and `DISCORD_STATE_DIR` in the wrapper. That fallback loses automatic
thread-per-session and the `/clear` behavior, and it is worse, but it works with zero custom code.

**S1 through S4 proceed unconditionally.** None of them touches the relay or a channel event: every
surface in S4 is fed by registry state that arrives over hooks. That matters for build order, because
S1 through S4 is a complete and useful product on its own. With only those four done, launching a
session makes it appear as a Discord thread, the thread list shows the whole fleet and its states,
and the card shows what each session is doing. That solves the half of the problem that hurt most
("the session was following a goal and I couldn't see what it was") with no development flag, no
`channelsEnabled` dependency, and no dependency on this gate. Only sending messages **into** a
session (S5) and approving permissions remotely (S6) need the channel to survive a rotation.

Build S1 through S4 first regardless of when the gate runs.

## Sections of Work

### 1. Repo scaffold and the rotation gate runbook
Model: sonnet

Stand up the repository skeleton and write the operator runbook for the prerequisite gate.

Acceptance:
- `npm install` succeeds from a clean clone; `npm run lint` and `npm test` exist and pass on an empty
  suite.
- Workspace layout: `broker/`, `relay/`, `hooks/`, `wrapper/`, `docs/`.
- `docs/operator-checks.md` and `tools/` already ship the rotation gate procedure, the kill
  condition, and the hook-capture harness. Do not rewrite them; extend only if the gate run surfaces
  a step that was missing.
- `.gitignore` excludes `node_modules/`, `.env`, any token file, and `tools/hook-capture.jsonl`.

Files in scope: repo root, `package.json`, `.gitignore`.

### 2. Broker core: session registry and hook intake
Model: opus

The broker process with no Discord in it yet: an HTTP listener bound to `127.0.0.1` that accepts hook
posts, and the registry that turns them into session state.

Acceptance:
- Listens on a configurable localhost port; refuses any non-loopback origin.
- `POST /hook` accepts a `SessionStart`, `PostToolUse`, or `Stop` payload plus the process token, and
  updates registry state: session ID, human name, host, source, last tool, tool count, turn count,
  last-seen timestamp.
- A `SessionStart` with source `clear` supersedes the prior session for that process token: the old
  session is marked ended and a new session record is created.
- Registry survives a broker restart (persisted to a JSON file, temp-then-rename, corrupt file
  degrades to empty rather than crashing).
- A session with no hook traffic and no relay connection for a configurable interval is marked stale.
- `GET /sessions` returns the registry as JSON for debugging.

Tests: lock that a `source: clear` post creates a second session record rather than mutating the
first, and that a stale-timeout transition fires without any inbound event. Lock that a non-loopback
request is refused; a broker reachable off-box is a remote-code-execution surface, since anything
that can post here can eventually put text in front of Claude.

Files in scope: `broker/`.

### 3. Session lifecycle hooks and the launch wrapper
Model: sonnet

The client half of S2: hook definitions and the PowerShell launcher.

Acceptance:
- A settings fragment registering all three hooks against the broker, with the transport fixed per
  event: `SessionStart` as a `command` hook (it does not deliver over `http`), `PostToolUse` and
  `Stop` as `http` hooks with `url` pointing at the broker. Do not re-litigate this; it was settled by
  probe and the reasoning is in the Approach.
- Hooks fail open. `http` hooks get this for free (non-2xx responses, connection failures, and
  timeouts are all documented as non-blocking errors that let execution continue), so the work is
  making the `SessionStart` command hook match that behavior: it exits zero and silently whatever the
  broker does, and carries a short explicit `timeout`. A broker that is down must never slow or block
  a twelve-hour session.
- `wrapper/Enter-ClaudeSession.ps1` exports a function taking a session name, generating a fresh
  `CHANNEL_PROCESS_TOKEN`, setting `CHANNEL_SESSION`, and launching Claude Code with the correct
  channel flag for the host (plain `--channels` on NEO and ASR, development flag on SCOTT).
- Verified end to end against S2: launching a real session makes it appear in `GET /sessions` with
  the right name, and `/clear` produces a second record.

Files in scope: `hooks/`, `wrapper/`.

### 4. Discord surface: threads, rename budget, status card
Model: opus

Give the broker its Discord connection and the three surfaces.

Acceptance:
- Connects with a bot token read from a local file or environment variable, never committed.
- On a new session, creates a thread in the host's channel from a broker-authored starter message,
  and records the thread ID against the session ID.
- Thread name renders as `<glyph> <session-name> · <state>` with glyph first; states are working,
  needs you, idle, and exited.
- Renames are **header-driven**: the broker reads `X-RateLimit-Remaining` and honors `retry_after`,
  drops a rename it cannot afford rather than queueing it, and damps working/idle flapping with a
  configurable dwell time.
- The starter message is edited in place with session ID, host, state, last tool, turn count, and
  heartbeat. Never re-posted, never pinned.
- On session end, the thread is renamed to the exited glyph and left open; archiving is configurable
  and off by default.

Tests: lock that a rename refused by the rate limiter is dropped and that the next state transition
still renders correctly, because a queued stale rename is the failure this design explicitly rejects.
Lock that flapping between working and idle inside the dwell window produces at most one rename.

Files in scope: `broker/discord/`.

### 5. Relay MCP channel server and message routing
Model: opus

The stdio channel and the two-way message path.

Acceptance:
- Declares `capabilities.experimental['claude/channel']` and `tools`, connects over stdio, and reads
  `CHANNEL_PROCESS_TOKEN` from its environment to register with the broker.
- Inbound: a Discord message in a session's thread reaches that session as a
  `notifications/claude/channel` event carrying `chat_id` in `meta`.
- Outbound: a `reply` tool call is routed to the thread bound to that **session**, ignoring the
  passed `chat_id`, so an unprompted reply still lands correctly.
- The relay's `instructions` string tells Claude what the events are and when to use `reply`.
- An allow rule for the relay's reply tool ships in the settings fragment. Without it the *first*
  outbound reply opens a permission prompt at the terminal and parks the session, which is precisely
  the failure this project exists to prevent.
- Relay stdio close marks the session ended in the registry within one heartbeat interval.
- A message addressed to an ended session is answered in-thread with a rejection notice.

Files in scope: `relay/`, `broker/routing/`.

### 6. Sender gating and permission relay
Model: opus

The security boundary and remote tool approval.

Acceptance:
- Every inbound Discord message is gated on the **sender's user ID** against an allowlist, never on
  the channel or thread ID. Gating on the room would let anyone with access to the channel inject
  text into a running session.
- Declares `capabilities.experimental['claude/channel/permission']`.
- Handles `notifications/claude/channel/permission_request`, posting `tool_name`, `description`, and
  `input_preview` to the session's thread as a new message that pings, including the five-letter
  request ID.
- Recognizes a verdict reply matching `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`, lowercases the
  captured ID, and emits `notifications/claude/channel/permission` with `behavior` set to `allow` or
  `deny`. A verdict is consumed as a verdict and never also forwarded as chat.
- `description` and `input_preview` are treated as untrusted and rendered as inert text.

Tests: lock both directions of the sender gate, since a silent bypass is the expensive failure and
anyone who can reply through this channel can approve arbitrary tool use. Lock that a well-formed
verdict with an unknown ID is dropped rather than applied to a different open request, and that a
verdict-shaped message from a non-allowlisted sender is rejected before the regex ever runs.

Files in scope: `broker/security/`, `relay/permission.ts`.

### 7. Supervision and three-host install
Model: sonnet

Make the broker survive a reboot and install it on all three hosts.

Acceptance:
- The broker runs as a Windows scheduled task at logon, restarts on failure, and logs to a rotating
  file.
- An install script provisions one host: bot token, channel ID, allowlisted user ID, port, and host
  name, writing config outside the repo.
- `docs/install.md` covers the Discord application setup (bot creation, Message Content Intent, the
  OAuth scopes, the invite), and, for NEO and ASR, packaging the relay as a plugin and adding it to
  `allowedChannelPlugins` alongside `channelsEnabled`.
- `docs/operations.md` states what breaks on a rotation onto an account without `channelsEnabled` and
  how the status card reveals it.

Files in scope: `install/`, `docs/install.md`, `docs/operations.md`.

## Out of Scope

- Starting or restarting a session remotely. A channel injects into a running session and cannot
  create one; no design here changes that.
- Any integration with `Spine.Reach` or the `sapplefeld-ai-os` repository. This tool is partly a
  fallback for the situation where that system is unavailable, so it deliberately shares no bot
  identity, process, or state with it.
- Steering Spine's own dispatched workers. Those are headless one-shot processes executing a written
  brief, and a side channel that altered the work mid-flight would break the guarantee that the plan
  document describes what actually happened. Spine's sanctioned equivalent is the Warden escalation
  reply path.
- Mirroring terminal output. The relay's stdio is the MCP protocol pipe and cannot see Claude Code's
  terminal rendering. Hook payloads are the source for status, and they are richer and typed.
- Multi-user access. One allowlisted Discord user ID per host.

## Open Questions

The first three are the operator checks in [`docs/operator-checks.md`](../operator-checks.md), which
carries runnable steps, pass criteria, and what each answer changes. Owner is Scott for all three.

1. **Does a local managed-settings file control channels on this machine?** (Check D.) Partly
   resolved: `channelsEnabled` and `allowedChannelPlugins` are **managed-settings only**, and on
   Windows managed settings are deliverable as a local file at
   `C:\Program Files\ClaudeCode\managed-settings.json`, a drop-in `managed-settings.d\` directory, or
   `HKLM\SOFTWARE\Policies\ClaudeCode`. All three are **machine-scoped, not account-scoped**, which
   would make one file per host survive every rotation and permanently close the silent-delivery-death
   hole. What is untested is whether a local file is honored for a personal account with no
   organization, which decides whether the SCOTT host can also drop the development flag. Answering
   this before S7 may remove the launch dialog everywhere and restore the option of an unattended
   supervisor.
2. **Does `SessionStart` fire with `source: "clear"`?** (Check B.) Low risk now: `source` is confirmed
   to track the real trigger, observed reading `startup` on a fresh session and `resume` on a resumed
   one in the same probe harness. If it somehow does not fire, the fallback is detecting a changed
   `session_id` on any hook event from a known process token, which reaches the same outcome slightly
   less cleanly. S2 should be written so that fallback is a small change.
3. **Does the thread name stay pinned in the mobile header while scrolling?** (Check C.) Cannot run
   until S4 exists. If negative, only the in-thread header is lost; the thread-list dashboard, which
   is the more valuable half, is unaffected.
4. **The real rename budget.** Undocumented by Discord, and to be measured against live response
   headers during S4 rather than assumed. No operator action.

## Chapters

### Chapter 1 - 2026-08-05
Completed: 1. Repo scaffold and the rotation gate runbook
Implemented By: adopted from a prior session, then verified and repaired by the main session
Metrics: 1 review round (adversarial + blind, both at opus); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **The scaffold was not authored in this session.** A prior session wrote it and
was terminated before the work was reviewed or committed, so it arrived as untracked, unverified
files. It was re-verified from scratch and reviewed as if new rather than assumed good. Both
reviewers returned CHANGES_REQUIRED independently, and the shared class was that the gate S1 exists
to build was green on code that crashes at runtime. The material decision was the runtime model,
which S1 had chosen implicitly and never written down: keep Node 24 type stripping (no build step)
and enforce the import convention with a test, rather than switch to a real emit. Type stripping
avoids a compile stage before S7's scheduled task and the stale-`dist` failure class; the price is
that `tsc` provably cannot catch a `./thing.js` specifier, so the guard is homegrown. Chosen while
zero source files exist, which is when the reversal is cheapest. Recorded in Approach, in a new
Standing Brief Amendments block, and in project memory.
Three probe findings worth keeping: `lib: ["es2023"]` does **not** cost the `fetch`/`Response`/
`Headers`/`AbortController` globals S4 needs (`@types/node` v24 declares them), so dropping the DOM
lib is free. `node --test <dir>` treats the directory as a test *file* and errors; only bare
`--test` recurses. A missing literal path alongside a matching glob still exits 0, which killed the
obvious fix for the green-on-zero hole and forced the `pretest` guard instead.
Review Findings: 5 Major addressed - missing `verbatimModuleSyntax` (type-only named imports crashed
at runtime); no compiler guard for `.js`/bare relative specifiers (closed by `import-hygiene.test.ts`,
proven red on `.js`, bare, multi-line, export-from, dynamic import, and a URL sharing the line, and
green on `.ts`, bare specifiers, and a commented-out violation); no `lib` (the type checker accepted
`document`/`WebSocket`, confirmed exit 0 before and exit 2 after); `node --test` reporting green
having run nothing (closed by a `pretest` guard, proven exit 1 on an empty tree and exit 0 with files
present); no stated runtime model for S7 to inherit (now in README and Approach). 4 Minor addressed -
`.mts`/`.cts` outside the lint include; `dist/` inside both gates; narrow secret globs in
`.gitignore`; and the root README claiming the S5/S6 capabilities in the present tense when nothing
is built, an honesty-gate violation swept tree-wide (`docs/README.md` and the plan's own line are
correctly framed as plan and future, so they were left alone).
Gate baseline for later sections to diff against: `npm run lint` exit 0; `npm test` 3 passing, 0
failing; `npm ci` from a wiped `node_modules` exit 0. Tree state was captured before and after the
review round and was byte-identical, so no reviewer probe leaked into the worktree.
Stamps: none surfaced (the project memory store was empty at section start; this section created it)
Next: 2. Broker core: session registry and hook intake
Commit Model: Commit-and-Push
