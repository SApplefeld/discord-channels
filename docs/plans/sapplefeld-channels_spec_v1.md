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
  It also delivers `session_id` and `hook_event_name`, along with `transcript_path`, `cwd`,
  `tool_use_id`, `permission_mode`, and `effort`. Every hook payload carries `session_id`, so the
  broker's session-ID-based event routing is a reliable path rather than an opportunistic hedge.
- **An environment variable set by the launch wrapper reaches an `http` hook request through header
  interpolation.** A `headers` value written `"${CHANNEL_PROCESS_TOKEN}"` (the `$VAR` form works
  identically) is substituted, provided the name is also listed in `allowedEnvVars`. The allowlist
  authorizes and does not itself inject: listing a variable without referencing it in `headers` puts
  it nowhere in the request. Confirmed against build 2.1.222 with a hardcoded-literal control run to
  distinguish a non-interpolating reference from a hook that never fired.
  The event name stays in a header rather than moving to the body's `hook_event_name`, even though
  that field exists: `X-Channel-Hook-Event` is not a CORS simple header, so it forces a preflight
  the broker never answers, which is a second line of defense against a cross-site POST.
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
- **Every string that reaches a Discord surface is untrusted and is neutralized at the render site,
  not at intake.** The broker's intake strips control characters and caps length; it deliberately
  does not touch `@everyone`, `@here`, markdown, or bidi controls, because escaping display syntax
  is the renderer's job. Any Discord write sets `allowed_mentions` to suppress all pings, and a
  session name or tool name is inert text in a thread title or card. A local process can announce a
  session with any name it likes, so this is a real input, not a hypothetical one.
- **Never render a `SessionRecord` wholesale.** `processToken` is the forgery key for hook posts and
  is already stripped from `GET /sessions`; a surface that serializes a whole record re-leaks it.
- **The process token authenticates reports about a session, never instructions to one.** The token
  is set in the launching process's environment, so the session inherits it and so does every shell
  subprocess its tools spawn. A session can therefore read its own forgery key and post hook events
  about itself. That is tolerable for status, which is the only thing it can currently distort, and
  it is why `GET /sessions` withholds the token. It stops being tolerable the moment the token
  authorizes anything inbound: **S5's message routing and S6's permission verdicts must not treat
  possession of a process token as authorization.** S6's sender gate is on the Discord user ID and
  is the only authority for inbound action.
- **A hook must never make a session slower, louder, or dependent on the broker.** Timeouts are
  measured against the per-tool-call path, not the once-per-session one; nothing writes to a
  `SessionStart` hook's stdout, because that stdout is injected into the session's context; and a
  session started without the launch wrapper carries no token, is not being watched, and must
  no-op without opening a socket.

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

**PASSED, 2026-08-06. S5 and S6 are unblocked.** Scott ran all four operator checks and every one
met its pass condition. A channel keeps delivering across three consecutive `cswap` rotations, so
the message path this project rests on is confirmed rather than merely reasoned about, and the
pre-provisioned-bot fallback is not needed.

Two results change the design beyond simply unblocking:

- **Check B is confirmed with captured payloads**, not just a pass report: `/clear` fires
  `SessionStart` with `source: "clear"` and a **new `session_id`**, which is exactly what S2's
  supersession branch assumes. The capture also shows `SessionEnd` fires on a clean exit, carrying
  the ending session's ID. That does not change the carried decision (a hard kill still fires no
  hook, so relay stdio close and the heartbeat remain the death signals), but it is a free, precise
  signal for the clean case and S5 may use it.
- **Check D passed, which resolves the most valuable unknown.** A local managed-settings file **is**
  honored on a personal account with no organization. So `channelsEnabled` and
  `allowedChannelPlugins` can be set per machine, machine-scoped rather than account-scoped, which
  permanently closes the silent-delivery-death hole on every host including SCOTT: a rotation onto
  an account without channels enabled can no longer kill delivery. It also means **SCOTT can drop
  `--dangerously-load-development-channels`**, and with it the launch dialog, once the relay is
  packaged as a plugin and named in that file. Until the relay exists, SCOTT keeps the flag, because
  the allowlist route requires a plugin to allowlist. Removing the dialog everywhere restores the
  option of an unattended supervisor that restarts a crashed session, which the Approach previously
  recorded as foreclosed.

The original statement of the gate follows, kept because it records what was at stake and what the
fallback would have been.

**This gate blocked S5 and S6 only.** It was unproven that a channel survives
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
- The fragment installs into the **user-level** settings file, because the sessions being watched
  live in arbitrary repositories. A hook runs with the monitored session's project as its working
  directory, so the `SessionStart` command names its script by a drive-rooted absolute path, which
  S7's installer substitutes per host. The path is a literal rather than an environment variable:
  a hook command is interpolated, so a variable there would make the executed path settable by
  anything on the machine that can persist one, and it runs under `-ExecutionPolicy Bypass`.
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
Locus: inline for everything under `docs/` (the docs-write-guard denies a non-curator subagent any
write there); `install/` and the scheduled task are dispatched.

**Partially deliverable ahead of the prerequisite gate.** Everything here except the relay's plugin
packaging is independent of S5 and S6, and is built now. The one deferred bullet is naming the relay
in `allowedChannelPlugins` for NEO and ASR, which cannot be written until the relay exists.

Make the broker survive a reboot and install it on all three hosts.

Acceptance:
- The broker runs as a Windows scheduled task at logon, restarts on failure, and logs to a rotating
  file.
- An install script provisions one host: bot token, channel ID, allowlisted user ID, port, and host
  name, writing config outside the repo. It also substitutes the absolute `SessionStart` script path
  into the settings fragment for that host's checkout, and hardens the ACL on the executed hook
  script and the wrapper: both currently inherit `Authenticated Users: Modify` from the `D:\` root
  on the SCOTT host, and the hook runs under `-ExecutionPolicy Bypass` at every session start, so
  write access to that path is code execution in the operator's context.
- The installer writes the substituted path into the **user-level settings file**, and the wrapper's
  launch-time path check reads *that* file rather than the checkout's copy of the fragment. They are
  different files, and only the merged one runs. A moved or re-cloned checkout whose user settings
  still name the old path is exactly the state the check exists to catch, and today it would pass.
- `docs/security-model.md` states the trust boundary this design actually has: what the process
  token authenticates (reports about a session) and what it must never authorize (anything inbound),
  that hook payloads cross loopback in cleartext with `tool_input` and `tool_response` in them, and
  the ACL requirement above.
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

**All four are resolved as of 2026-08-06.** The three operator checks in
[`docs/operator-checks.md`](../operator-checks.md) were run and all passed; the fourth is answered by
S4's implementation. The original questions are kept below with their answers, because what each one
would have changed is the reason the design has the shape it does.

1. **Resolved, yes.** A local managed-settings file is honored on a personal account. See the
   prerequisite gate above for what it unlocks: machine-scoped channel settings on every host, and
   the removal of SCOTT's development flag once the relay is a plugin.
2. **Resolved, yes, with captured payloads.** `SessionStart` fires with `source: "clear"` and a new
   session ID. The fallback (detecting a changed `session_id` on any hook event) is not needed.
3. **Resolved, yes.** The thread name stays pinned in the mobile header while scrolling, so the
   in-thread header and the thread-list dashboard both work as designed.
4. **Answered by construction.** The rename budget is read from live response headers rather than
   assumed, so no number was ever hard-coded and none needs measuring.

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

### Chapter 2 - 2026-08-05
Completed: 2. Broker core: session registry and hook intake
Implemented By: implementer-opus (one build round, one review-fix round via the same agent)
Metrics: 1 review round (adversarial + blind at fable, security at default); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The security reviewer found a **Critical the other two missed**: the listener
checked the socket's peer address but not the `Host` header, so DNS rebinding defeated it. The peer
check passes honestly under rebinding, because the browser really does connect to 127.0.0.1; the page
then treats the port as same-origin, needs no CORS preflight, and can both read `GET /sessions` (which
was publishing every process token) and post forged hooks. Fixed with a `Host` allowlist checked
before routing. The adversarial and blind reviewers independently found the same Major: `PostToolUse`
and `Stop` routed purely by process token, so an event from the old session arriving after a `/clear`
was credited to the new record and held it out of staleness. Fixed by routing on `session_id` when
present, opportunistically, because whether `session_id` rides on every hook payload is unconfirmed
(the spec's confirmed `PostToolUse` field list does not include it).
The implementer added two conditions beyond the fix brief and both were accepted: the keyed record's
process token must also match (otherwise an event could be aimed at any session by ID), and an ended
record takes counts without being revived, which keeps "ended" a genuine terminal transition.
Deliberate deviation from the review: **no write coalescing was added** despite the security
reviewer's Major. Once pruning bounds the record count, the snapshot is small and a synchronous write
of a few KB per hook event is not a measured cost; keeping the crash-safety story simple beat
optimizing a cost nobody has observed. Reversal is localized to the `onMutate` wiring.
Two findings were routed forward rather than fixed here: Discord-active text (`@everyone`, bidi marks)
is neutralized at S4's render site via `allowed_mentions`, not at intake, because escaping display
syntax is the renderer's job - now a Standing Brief Amendment, along with a ban on rendering a
`SessionRecord` wholesale. An intake audit log and `docs/security-model.md` go to S7 with the rotating
log file.
Surprise worth keeping: `fetch` treats `Host` as a forbidden header and silently substitutes the real
one, so the Host-check unit tests had to drive `node:http` directly. A test written with `fetch` would
have passed while proving nothing.
Review Findings: 1 Critical fixed (Host header / DNS rebinding). 4 Major fixed - the `/clear` routing
race, `processToken` published by `GET /sessions`, unbounded registry growth (retention horizon
defaulting to 24h plus a record cap with terminal-first eviction), and the sanitizer's overclaiming
comment. 1 Major deliberately not fixed, justified above. 9 Minor fixed: `positiveInt` accepting 0
(a zero sweep interval was a busy loop), `FORMAT_VERSION` written but never read, a listen-error
listener left attached that would swallow one error then crash on the next, non-uniform finite checks
letting `Infinity` hold a record live forever, unsanitized strings re-admitted on load, file modes for
a token-bearing file, a fixed temp filename, a case-sensitive run-directly guard that made
`node broker/index.ts` exit 0 having started nothing, and the state file's name added to `.gitignore`.
Gate delta: lint exit 0 unchanged; tests 3 passing → 47 passing, 0 failing throughout. The nine new
defenses were red-checked by mutation (9 tests went red, files restored and verified by hash) and
confirmed against a live `node broker/index.ts` with `curl.exe`: a rebinding Host got 403 on both
routes, `GET /sessions` carried no process token on the wire, and a misrouted `PostToolUse` was
dropped with 202 while the correctly-routed one incremented only its own record. Tree state was
captured before and after the review round and was byte-identical.
Not proven: that retention fires *at the configured horizon* under real wall time. The horizon is
locked by the injected-clock test; the live run proves only that the sweep prunes and evicts without
crashing.
Stamps: adjudicated 1, stamped 1 (`typescript-runs-unbuilt-under-node-type-stripping`, which shaped
this section's brief and the import convention its code follows)
Next: 3. Session lifecycle hooks and the launch wrapper
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-05
Completed: 3. Session lifecycle hooks and the launch wrapper
Implemented By: adopted from a prior session, then verified, repaired, and reviewed by the main
session (the originating agent no longer existed to resume, so the review-fix round ran inline)
Metrics: 1 review round (adversarial + blind at opus, security at default); 0 NEEDS_CONTEXT; 0
escalations; advisor opus
Decisions / Surprises: **The section arrived as untracked files again**, the same way S1 did: a
prior session built the hooks, the wrapper, and a shape test, wrote its probe findings into the
Approach, and was terminated before any of it was reviewed or committed. It was re-verified from
scratch rather than assumed good, and that was load-bearing: the inherited fragment ran the
SessionStart script by a **working-directory-relative path**, which is silently wrong for every
session this project exists to watch. A hook runs with the *monitored* session's project as its
working directory, and those sessions live in other repositories, so the path resolved only for
sessions launched from this checkout. Measured with the broker live: a session started from a
non-repo directory never appeared in `GET /sessions` at all, while the identical run from the
repository root produced a complete record. Nothing about the failure is visible from inside a
running session.
The fix went through two reversals worth recording. It was first fixed with `${CHANNEL_HOOK_SCRIPT}`,
after a probe confirmed that a `command` hook interpolates environment variables (it does, and
unlike the `http` header case it needs no `allowedEnvVars` entry). The security reviewer then
pointed out what that buys: the *executed* path becomes settable by anything on the machine that
can persist an environment variable, and it runs under `-ExecutionPolicy Bypass` at every session
start. Two guard forms that would have let an unwrapped session no-op were probed and **both
failed**, because Claude Code interpolates the bare `$VAR` form too and ate the `$env:` in each.
So the design landed where all three reviewers and the advisor independently pointed: a drive-rooted
absolute literal in the fragment, substituted per host by S7's installer, with the "am I watched?"
guard moved inside the script where it is testable. The wrapper now refuses to launch when the
fragment's path disagrees with its own checkout, which is what keeps a moved clone loud.
Two findings are accepted risks rather than fixes, both recorded as Standing Brief Amendments
because they bind later sections. The process token is inherited by every tool subprocess a session
spawns, so a session can read its own forgery key and post status about itself; that is tolerable
for status and **must not** become tolerable for S5's inbound routing or S6's permission verdicts,
which is now written into the brief. And hook payloads cross loopback in cleartext carrying
`tool_input` and `tool_response`, which S7's `docs/security-model.md` states rather than hides.
The adversarial reviewer flagged one thing for adjudication rather than as a defect: the wrapper's
`Test-Path` guard is the only place in this section that can stop a session from starting, and the
spec's fail-open language covers the hook, not the launcher. Kept deliberately - failing loudly at
the keyboard beats running a twelve-hour session that is silently unwatched.
Surprise worth keeping: the live runs incidentally proved S2's staleness sweep under real wall
time, which Chapter 2 listed as unproven. Two records aged from `live` to `stale` on their own
while later probes ran. The 24h retention horizon is still only locked by the injected-clock test.
Review Findings: 3 Critical fixed - the wrapper leaked `CHANNEL_SESSION` and `CHANNEL_PROCESS_TOKEN`
into the dot-sourcing shell and never restored them, so a later bare `claude` in that shell inherited
a live token and the broker read it as a supersession, marking the still-running session ended and
crediting its events to the newcomer (now restored in a `finally`); a non-ASCII session name made
`Invoke-RestMethod` throw client-side before opening the socket, inside the catch, so the session was
permanently invisible with no signal (name now ASCII-validated at the wrapper, with the header
dropped rather than the announcement as a second line); and the 10s `http` hook timeout was charged
against every tool call of a twelve-hour session whenever the broker was slow rather than down, which
Chapter 2's deliberate no-write-coalescing decision makes reachable (now 2s, pinned by test).
1 Critical routed to S7 rather than fixed here: the executed hook script inherits
`Authenticated Users: Modify` from the `D:\` root, verified with `Get-Acl`, which composes with
`-ExecutionPolicy Bypass` into unattended code execution. Latent today (one enabled local account,
verified) and the fix is an ACL change on a shared drive, which is Scott's call, not a code edit.
5 Major fixed: `CHANNEL_HOST_NAME` carried two incompatible contracts (a free-form broker label and
an exact wrapper table key), so the natural label for this machine broke the launcher - the env value
now goes through the same matching as `COMPUTERNAME`; `CHANNEL_BROKER_PORT` was interpolated raw into
the request URI, where a value like `80@evil.com` redirects the post and its token to a remote host,
and it moved only two of the three port copies, so the override is gone and the literal is pinned
three ways; the fail-open promise had no automated cover at all (now `session-start.test.ts`, which
runs the real script against a dead broker and a hung one); and an unwrapped session spawned
PowerShell that exited 127 on every session start machine-wide (now a silent no-op, proven live).
6 Minor fixed: the relative-path guard's regex missed `..\`; PowerShell 5.1 decoded stdin as IBM437
and re-encoded the body as Latin-1, corrupting non-ASCII payload fields (now byte-for-byte); the
host prefix match classified `SCOTTSDALE-KIOSK` as SCOTT and would have handed it another host's
channel flag; the unknown-host error named `COMPUTERNAME` when `CHANNEL_HOST_NAME` was the source;
the `PostToolUse`/`Stop` entries never asserted their hook count; and the port-pin comments claimed
a three-way guarantee the test did not implement.
Gate delta: lint exit 0 unchanged; tests 47 (Chapter 2 baseline) → 53 with the inherited files →
60 passing, 0 failing throughout. The three fragment guards were red-checked by mutation (each a
single-test red, file restored and hash-verified). Verified live against build 2.1.222 with the
broker running: a wrapped session from a non-repo directory registers with the right name, source,
tool, and turn count; an unwrapped session in the same directory creates no record and opens no
socket. Tree state was captured before and after the review round and was byte-identical.
Not proven: any of this on NEO or ASR. Both the absolute script path and the channel flag differ
per host, and only SCOTT was available. S7's installer is what makes the path correct there.
Known scope gap, routed to S7 rather than fixed here: the wrapper's path check reads the fragment
**in the checkout**, but the copy that actually runs is the one merged into the user-level settings
file. Every run verified here used `--settings <repo path>`, so the merged-settings install path is
unexercised, and a checkout whose user settings still name an old path would pass the check while
every session silently failed to announce. S7 owns the merged file and now carries the criterion.
Stamps: adjudicated 1, stamped 0 (`memq unstamped --since 1d` returned no unapplied reads; the
type-stripping record was already stamped in Chapter 2's window and shaped this section's new
test files the same way)
Next: 4. Discord surface: threads, rename budget, status card
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-06
Completed: 4. Discord surface: threads, rename budget, status card
Implemented By: implementer-opus (one build round, two review-fix rounds via the same agent)
Metrics: 2 review rounds (adversarial + blind at fable, security at default on round 1; adversarial +
blind at fable on round 2); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **Built against a seam, because there is no bot token until S7.** The two hard
acceptance criteria (a refused rename is dropped, and flapping produces at most one rename) are not
testable against `discord.js`, so the transport is a narrow interface with a real adapter over
`discord.js` and a fake that returns synthetic rate-limit headers and 429s. Exactly one file imports
`discord.js`, so the suite never loads it. Time is injected, reusing S2's clock pattern rather than
inventing a second one.
The spec named four surface states (working, needs you, idle, exited) while the registry speaks three
(live, stale, ended), and never wrote the mapping. Resolved in one function: `ended` to exited,
recent hook traffic to working, quiet to idle, and `needs you` modelled but fed by nothing until S6.
The interesting part was `stale`, which the second review round caught: rendering it as idle meant a
**hard-killed session showed the success glyph forever**, contradicting the carried decision that "a
heartbeat timeout is the backstop" for session death. Since nothing marks a record ended before S5
exists, that is the S1-S4 product's only death signal. Resolved with a second, longer, configurable
horizon (four hours) past which a stale record renders exited with the warning glyph. Only a *stale*
record can reach it, so S5's relay liveness will hold a live session out of it for free.
Two rate-limit facts stayed marked rather than assumed: Discord documents no channel-modification
limit, and the stricter bucket is community-reported and undocumented. Nothing hard-codes a number;
the budget acts only on observed headers. The second round found the budget was keyed globally while
Discord's bucket is per-thread, which meant one flapping session could hold an urgent `needs you`
rename hostage on a different thread, spending the design's scarcest signal on the wrong surface.
Surprise worth keeping: `@discordjs/rest` **throws on a 4xx rather than returning the response**, so
the first attempt at "detect a rejected token once and stop" never fired; the live run caught it and
the adapter now translates the error back into a response carrying its status. A second: a failed
call's own headers were being folded into the budget, so a 4xx reporting `remaining > 0` cleared a
block it had no business clearing. A failed call is no longer evidence about a bucket.
Deliberate deviation, accepted by both reviewers: `allowed_mentions` rides on the two message writes
and not on the channel PATCH that renames. It is a message-object field, the Modify Channel route
does not define it, and a thread title resolves no mentions, so sending it risks a refused rename for
no security gain. The rename body is pinned as exactly `{ name }`.
Review Findings: Round 1 - 1 Critical fixed: `createThread` was two writes, and a failed thread-open
discarded the posted message id, so a persistent 4xx reposted the starter card every five seconds
forever, roughly 17k messages a day into the dashboard channel. That is the exact message-churn
failure the Approach names as the design's enemy, and it violated "never re-posted". Split into two
calls with the message id recorded the moment the post lands, creates put under their own budget, and
a per-pass call ceiling added. 5 Major fixed: thread bindings were memory-only while the registry
persists, so every restart opened duplicate threads for live sessions **and** brand-new threads for
up to 24h of retained dead ones (S7 restarts at every logon, so this was routine); a session that
vanished from the registry was never driven to its terminal render; `<` was missing from the escape
class, so Discord chip syntax survived into the card and could spoof the heartbeat the card exists to
carry; the global rename budget; and the bot token file was read with no permission check.
Round 2 - 0 Critical, 7 Major fixed: `retire()` had no terminal exit, so a permanently refused final
rename retried forever across restarts; `retire()` painted the title but not the card, leaving a
thread titled exited over a card still claiming working; a 404 or 403 on a bound object was retried
every tick forever; the POSIX permission check rejected mode 0400, so a correctly hardened read-only
credential aborted startup; the broad-principal check was a denylist that missed domain groups and
raw SIDs, now inverted to an allowlist; the token file's own ACL was checked but not its parent
directory's, so a file in an attacker-writable directory could be deleted and re-created with a clean
ACL; and the stale-renders-as-success problem above. 20+ Minor fixed across both rounds.
Gate delta: lint exit 0 unchanged; tests 60 (Chapter 3 baseline) → 107 after the build → 134 → 153
passing, 1 skipped (a POSIX-only permission test on Windows), 0 failing throughout. 34 mutations were
applied across the two fix rounds, each reddening its target test, with files restored and
hash-verified byte-identical afterwards. Two mutations initially came back green, which is how the
budget-evidence rule and the split create budgets got the tests they were missing. The token-file
gate was proved against a **real Windows ACL**: `icacls` granting Authenticated Users on the file,
and separately on its directory, and both were refused. Tree state was captured before and after both
review rounds and was byte-identical each time.
Not proven, and it needs a live bot: that `auto_archive_duration: 10080` is accepted by the guild,
the real shape of a successful create response, and a real bindings write after a successful post.
Everything Discord actually returns on success is fake-driven. That live walk belongs to S7, which is
where the token, the channel, and the invite exist.
Stamps: adjudicated 1, stamped 0 (`memq unstamped --since 1d` returned no unapplied reads; the
type-stripping record remains stamped from Chapter 2's window and shaped this section's imports)
Next: 5. Relay MCP channel server and message routing (blocked on the prerequisite gate, operator
Check A in docs/operator-checks.md, which only Scott can run)
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-06
Completed: 7. Supervision and three-host install (every part except the relay's plugin packaging,
which cannot be written until the relay exists)
Implemented By: implementer-sonnet for `install/` and the logger (one build round, one review-fix
round via the same agent); main session for everything under `docs/` and for `wrapper/`
Metrics: 1 review round (security at default, blind at opus); 0 NEEDS_CONTEXT; 0 escalations;
advisor opus
Decisions / Surprises: **S7 was built out of order, ahead of S5 and S6.** The gate blocks those two
only, and everything here except naming the relay in `allowedChannelPlugins` is independent of them,
so stopping at S4 would have left a section's worth of unblocked work undone. The routing override
mattered: `docs/` is most of this section and the docs-write-guard denies a non-curator subagent any
write there, so the dispatch covered `install/` and the logger while the three documents were written
in the main thread. Recorded as `Locus: inline` on the section.
The security review's verdict was BLOCK on three Criticals, all measured live with `icacls` rather
than reasoned about. The most dangerous was found independently by both reviewers and was **not** a
subtle one: `Protect-ChannelPath` hardened the token file's parent directory, and with the documented
`-BotTokenFile D:\token.txt` that parent is `D:\`, so a normal documented invocation would have
stripped and rewritten the access control list of the entire drive, inherited by everything under it,
with no backup and a cheerful "Provisioned" at the end. The other two were the same defect this
project had already reasoned about once and then failed to apply to itself: the scheduled task runs
the broker's source and its own launcher under `-ExecutionPolicy Bypass` at every logon, and none of
those paths were hardened, while `hooks/` and `wrapper/` still permitted delete-child, which defeats
file-level hardening entirely. The fourth Critical was the hooks fragment being attacker-writable and
merged verbatim into the operator's real user-level settings, which would persist an arbitrary
`PreToolUse` command machine-wide and survive a re-clone.
Worth keeping as a pattern: **the hardening and the verification were wrong in the same direction.**
Both trusted "the file's current owner", and on a shared root any account can create a file and is
then its owner, so a planted file would have been hardened into the attacker's exclusive control and
then passed the broker's own check. Two components agreeing is not two checks.
Deliberate strictness, and the one thing Scott will notice: the launch wrapper now refuses to start a
session when the hook script has lost its protection, calling the broker's own rule rather than
restating it. On a checkout where the installer has not run, that means `Enter-ClaudeSession` refuses
until it does. That is the correct posture (the script runs under Bypass at every session start) and
it matches the broker's refusal on an unprotected token file, but it is a real behavior change and
the message says exactly which command fixes it.
Review Findings: 4 Critical fixed (arbitrary-directory ACL wipe, unhardened logon execution surface,
delete-child on the hook and wrapper directories, unvalidated fragment merged into user settings).
11 Major fixed: the token was a plaintext command-line parameter and the docs told the operator to
paste it (now `SecureString`, prompted); the owner-trust hole above, fixed on both sides; the ACL
rewrite stripped inheritance before granting anything and had no rollback, so an unmappable SID left
a path nobody could read (now one in-memory descriptor and a single write, restoring on failure); the
scheduled task declared no principal and `-AtLogOn` fired on any user's logon; the log file was empty
in exactly the two cases it exists for, a bind failure and a bad config, because both paths bypassed
it; `-Port` moved the broker but not the hooks, silently disconnecting them; `broker.env` was applied
to the broker's environment with no allowlist, making write access to it `NODE_OPTIONS` injection
into the process that reads the bot token; the state root was hardened only incidentally and
`CHANNEL_BROKER_STATE` was never written; and nothing re-asserted the hook script's ACL at launch.
14 Minor fixed, including a false pass I introduced myself: the wrapper's `-File` regex was anchored
to end-of-string, so any hook command with a trailing argument was skipped silently, which is a false
negative in the one check standing between a moved checkout and permanently invisible sessions.
Gate delta: lint exit 0 throughout; tests 153 (Chapter 4 baseline) → 176 after the build → 194
passing, 1 skipped, 0 failing. Guards were red-checked by mutation across both rounds, each
reddening its target. The ACL work was proved against real Windows access control lists rather than
mocks, and the wrapper's path check was re-verified by hand across seven cases (correct path, stale
path, both with and without trailing arguments, an unparseable path, an unrelated third-party hook,
and an unquoted path) after the regex fix.
Verified afterwards, because a mutation test briefly pointed the ACL code at the real `D:\` before an
unmodified guard intercepted it: the drive's access control list is unchanged, still carrying
`Authenticated Users: Modify`, and the repository's files still inherit it. Nothing on this machine
was hardened, no scheduled task was registered, and the real `~/.claude/settings.json` was not
touched. Every install path is proved against fixture trees and dry runs.
Not proven, and only a real install can: registering the scheduled task, merging into the real user
settings file, and hardening a real repository's ACLs. The `Protect-ChannelPath` rollback branch is
verified by inspection only, since forcing that failure deterministically needs elevation.
Stamps: adjudicated 1, stamped 0 (`memq unstamped --since 1d` returned no unapplied reads)
Next: BLOCKED on operator Check A. Sections 5 and 6 are the only work left and the gate blocks both.
Commit Model: Commit-and-Push

### Chapter 6 - 2026-08-06
Completed: 5. Relay MCP channel server and message routing
Implemented By: implementer-opus (one build round, one review-fix round via the same agent); main
session for `docs/` and the incident fix below
Metrics: 1 review round (adversarial + blind at fable, security at default, retried once after an API
failure); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **An incident opened this stretch, not a section.** Scott reported a hook error
on every Claude Code launch, naming a path under a temp directory. It was not the hooks design: a
test in `install/Install-Host.test.ts` omitted `-SettingsPath`, so the installer fell through to its
own default and merged this project's hooks into his **live** `~/.claude/settings.json`, pointing
`SessionStart` at a fixture the test then deleted. The suite stayed green throughout, because the
installer did exactly what it was asked. The S7 implementer had reported "no real settings-file
change was made to this machine"; that claim was false and only the operator's own observation caught
it. The harness now refuses any run without a fixture settings path and state root, **and** hands the
child a fixture HOME, USERPROFILE and LOCALAPPDATA so a default cannot reach the real profile either.
Locked by a test, and verified by hashing the real settings file across a full suite run.
The lesson worth keeping is not "pass the parameter". It is that a test which drives a real installer
is a test that can install, and the only durable guard is the one that makes the destination
unreachable rather than merely unspecified.
**The section itself was built out of order and against a live channel.** The gate passed, so S5 was
unblocked; SCOTT still carries the development flag, which meant the relay could be loaded against a
real Claude Code session rather than only fakes. That paid for itself: the handshake, the broker
binding, the reply key, the refused second stream, the grace window and the forged-SessionStart
refusal were all confirmed live rather than reasoned about.
Two design facts were read out of the Claude Code binary and shaped the code. Claude Code refuses to
register a channel whose negotiated protocol revision is at or past `2026-07-28`, and the SDK's
latest is `2025-11-25`, so a future SDK bump would silently kill delivery; a test pins the bound.
And stdio version probing starts the server, hard-closes it, and respawns it, which is why the relay
opens its broker pipe only at `oninitialized` and the hub's detach is identity-checked.
**The implementer overrode the fix brief on one point, correctly.** I instructed it to register the
relay via an `mcpServers` key in the settings fragment. It implemented that, then measured build
2.1.223 applying the `permissions.allow` from such a file while starting **no server at all** from
its `mcpServers` key. It reverted and moved registration to the wrapper, which writes a
`--mcp-config` per launch from its own location. That is better scoped anyway: a user-scope
registration would start a relay for every session on the machine, including the unwrapped ones the
Standing Brief Amendment requires to no-op. Primary evidence beat my instruction, which is the
outcome the brief's marked-assertions rule exists to produce.
Review Findings: 4 Critical fixed. A forged `SessionStart` could overwrite a live record and steal
its thread, because `start()` never checked the existing record's token: session IDs are published by
`GET /sessions`, so the operator's messages would route to the forger and its replies land in the
real thread. **That was a pre-existing S2 defect that S5 turned into full takeover**, and it is the
second time the token-match condition had to be added to a path Chapter 2 only fixed in `route()`.
Stream attachment treated token possession as inbound authorization, so any tool subprocess could
attach its own pipe and man-in-the-middle the operator; fixed by first-claim-wins plus a per-
attachment reply key that never travels where the token holder can read it. A transient pipe close
permanently tombstoned a live session, with the relay's own read-timeout recovery as a trigger, so
the client's reconnect logic and the server's close-is-death rule contradicted each other; fixed with
a grace window, which also matches the acceptance criterion's "within one heartbeat interval" more
exactly than the original did. And the relay's `instructions` asserted that channel text came from
the operator, a provenance the transport cannot establish, which undercut the data-not-instruction
paragraph directly above it.
7 Major fixed: reply authorship (closed by the reply key), a `reply()` that could hang forever
(blind probed the exact Node 24 behavior: a peer dying mid-body emits `aborted`/`error`/`close` and
never `end`), bidi and zero-width characters reaching the model on the one path with no render site,
unbounded stream buffering and connection count, replies and notices bypassing the rate-limit budget
entirely, and the relay-registration gap. 10 Minor fixed.
Deliberate deviation, recorded: the in-thread rejection notice stops once the ended record is pruned
at the 24h horizon, after which a message into that thread is ignored in silence. Fixing it needs a
tombstone outliving the registry record, which is a retention change rather than a routing one. It is
in `docs/operations.md` instead.
Gate delta: lint exit 0 throughout; tests 195 (the real Chapter 5 baseline, which the implementer
measured against a clean `git archive` and corrected from my stated 194) → 245 after the build → 273
passing, 1 skipped, 0 failing. 53 mutations across the two rounds. Four came back green and were
chased rather than accepted: two were wrong anchors or unreachable test directions, one was a test
passing for the wrong reason (`closeAllConnections` before the connection existed), and one is a
genuine redundant pair. Worth recording honestly: **no single settle-handler on the reply path is
individually necessary** on Node 24.19; only removing every path but the clean `end` reddens. The
redundancy is deliberate for a promise that must always settle, and the implementer reported the
green rather than implying otherwise.
Not proven, and it needs a person at the keyboard: an inbound event reaching the model, and a `reply`
tool call round-tripping. Claude Code registers a channel only from its interactive REPL, so a
headless `claude -p` run never registers one at all and the notification is delivered to nothing.
Everything below that boundary is confirmed live; the boundary itself is not.
Stamps: adjudicated 1, stamped 0 (`memq unstamped --since 1d` returned no unapplied reads)
Next: 6. Sender gating and permission relay
Commit Model: Commit-and-Push

### Chapter 7 - 2026-08-06
Completed: 6. Sender gating and permission relay. **All seven sections are implemented.**
Implemented By: implementer-opus (one build round, one review-fix round via the same agent); main
session for `docs/` and for repairing the operator's settings file
Metrics: 1 review round (security at default, blind at fable; the first security dispatch died on an
API error and was re-run); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **No Criticals, and both reviewers independently verified the boundary this
section exists to build.** The gate is genuinely first and unreachable-around: it runs before the
thread lookup, the verdict pattern, the rate window and the pipe; a message edit never re-delivers;
a webhook is bot-authored and dropped; and no wiring exists where a gateway runs without a gate.
Verdicts cannot be forged, replayed or cross-applied. `/relay/permission` sits behind the same
reply-key check as `/relay/reply`. That is the section's whole point, and it holds.
The wire shape was read out of the Claude Code binary rather than guessed: the notification names,
the params, the literal ID alphabet `abcdefghijkmnopqrstuvwxyz`, and the fact that the verdict
handler is registered only when the permission capability is declared. The `[a-km-z]{5}` pattern in
the spec is therefore coupled to a Claude Code internal, and the code logs a refusal naming that
cause so a future alphabet change is diagnosable rather than silent.
**The ping tension was real and resolved rather than waved through.** The Standing Brief Amendment
says every Discord write suppresses all pings; this section's acceptance says the permission message
pings. Resolved by keeping the empty `parse` list, which is what stops content ever resolving a
mention, and adding a one-ID `users` whitelist naming the validated operator. A crafted description
still cannot mention anyone, and a test counts unescaped mention syntax to prove it.
**Deviation accepted, argued rather than assumed.** I asked for one per-thread ceiling on alerts.
The implementer shipped two, because a single ceiling that drops prompts parks the session that sent
them, and "one unanswered prompt parks a session indefinitely" is the carried decision this project
exists to honour: a local process could otherwise park every session on the host by spending the
ceiling first, turning phishing into denial. Past three prompts a minute per thread the message
still arrives and is still answerable but stops mentioning the operator; only past twelve is one
dropped. Literal deviation from "a new message that pings" for prompts four through twelve in a
minute, reversible in one branch of `volumeFor`.
Review Findings: 0 Critical. 6 Major fixed: a refused alert lost the prompt permanently, because the
open entry was inserted before the post and the dedupe then swallowed every re-send, parking the
session with only a log line (entries are now inserted on success and a failed alert is surfaced
in-thread); the open-request table is in-memory while the broker restarts at every logon, so an
unmatched verdict was swallowed in silence, which from a phone reads as success (an unmatched
verdict is now answered in-thread, chosen over persistence as the smaller surface); `loadSenderGate`
threw with nothing catching it and the scheduled task discards stderr, so a misconfigured host got a
broker that failed every logon with a zero-byte log, the same class Chapter 5 fixed; the pipe-race
residual grew a phishing dimension; `/relay/permission` reported success for prompts it had dropped;
and two documents no longer described the system, one claiming all pings are suppressed and neither
recording the tool-input egress. 9 Minor fixed, including a shared invisible-character class that
omitted the Unicode tag block, which is the standard hidden-ASCII smuggling range and reaches both
the render site and the model.
One Minor was **not reproduced and correctly not "fixed"**: the reviewer's unreachable-413 finding
was probed three ways against the real handler and returned 413 to the peer every time. The
implementer left working code alone and added a durable pin instead, which is the right call.
Gate delta: lint exit 0 throughout; tests 273 (Chapter 6 baseline) → 316 after the build → 332
passing, 1 skipped, 0 failing, identical across five consecutive full runs. 48 mutations across the
two rounds. Three came back green and were chased rather than accepted, and the pattern is worth
keeping: each time the *test* was wrong, not the code. One assertion (`gaps[last] > gaps[0]`) was
satisfied by scheduling noise and passed for the wrong reason until tightened to an absolute floor.
The implementer also found a **pre-existing flake** in `relay/broker.test.ts`, failing roughly one
run in three at the base commit, and fixed it with a deterministic barrier; blind independently
verified the barrier proves what it claims.
Incident closed this chapter: the hooks a test wrongly merged into the operator's live
`~/.claude/settings.json` were removed with his explicit authorization, after a backup, changing only
that one key. The cause was fixed in `2ed4a3e`; **the damage sat on his machine for hours while this
session kept building**, which is the process failure worth remembering: fixing the generator is not
fixing the harm, and the operator reported the same incident twice before it was cleared.
Not proven, and it needs a person at the keyboard: a permission prompt reaching the model and a
verdict round-tripping, because Claude Code registers a channel only from its interactive REPL; and
whether `allowed_mentions.users` actually pings, since no live bot has ever run.
Stamps: adjudicated 1, stamped 0 (`memq unstamped --since 1d` returned no unapplied reads)
Next: finishing-work
Commit Model: Commit-and-Push
