# Console-to-Channel Mirroring

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: S2, per-section reviewer bumps above opus writers, finishing reviews
Created: 2026-08-06

## Goal

A wrapped session's Discord thread becomes a faithful record of the console conversation: every
prompt typed at the console appears in the thread, attributed, and every turn's final assistant
reply appears there in full, split across as many Discord messages as it needs. Combined with the
existing inbound path (thread message into the session), the thread becomes a near-replacement for
Remote Control: the operator walks away mid-conversation and keeps both reading and steering from
a phone.

## Approach

**The return path must be structural, not model-discretionary.** Today the only way console output
reaches the thread is the model choosing to call the relay's reply tool. Two sessions on identical
infrastructure demonstrated the problem: `first-light` used the tool and its thread got answers;
`Test-Channel` never called it and its thread got silence while the relay pipe sat healthy. Hooks
fire whether or not the model cooperates, so the mirror rides on hooks.

**Prompt side.** The `UserPromptSubmit` hook payload carries the prompt text. Hook transport is not
uniform (measured: `SessionStart` cannot deliver over an `http` hook; `PostToolUse` and `Stop` can),
and whether `UserPromptSubmit` delivers over `http` is unmeasured. Section 1 measures it first. If
`http` delivers, the prompt mirror is a fragment entry and an intake change only, because an `http`
hook posts its whole payload as the request body. If not, it is a command script shaped like
`hooks/session-start.ps1`.

**Reply side.** No hook payload carries the reply text; the `Stop` payload carries the transcript
file's path. A new command script, `hooks/stop-mirror.ps1`, reads the transcript session-side,
extracts the turn's final assistant message, and posts it to the broker authenticated by the same
process token the other hooks use. The read happens in the hook, in the session's own process tree,
so the broker never opens a file named by data from the wire. The existing `http` Stop hook stays:
it is the fast liveness tick (2s timeout), while the mirror script gets a longer timeout for the
transcript read. Both constraints from `session-start.ps1` apply to any new script: absolute paths
only (a hook's working directory is the watched session's own project), exit 0 without a token and
without opening a socket, and byte-clean posting (Windows PowerShell 5.1 corrupts non-ASCII when a
payload round-trips through a string; post bytes).

**Broker side is a deliberate inversion of the content-free posture.** The intake today drops all
content on purpose. Mirroring adds an explicit content path with the same discipline the content-free
path has: token-authenticated, tokenless and unknown-token posts dropped with 202, size-capped by
config, and the content itself never written to the broker log. Any new config knob is registered in
both `broker/config.ts` and `install/Install-Functions.ps1`'s `$script:ChannelBrokerEnvAllowlist`;
a knob present in only one of them either does not reach the broker or warns at every start.

**Rendering.** Prompts post as attributed messages so the thread distinguishes the operator's
console prompts, the operator's Discord messages, and Claude. Replies split on paragraph and
code-fence boundaries, re-opening a fence across a boundary, into as many messages as needed;
a genuine reply is never truncated (decided 2026-08-06: long replies are among the highest-value
messages and cutting them defeats the feature). A prompt containing a giant paste is the one capped
surface: beyond the cap it is shortened with a visible marker, because the no-truncation argument
protects replies, not the operator's own log dumps. `MAX_MESSAGE_LENGTH` in
`broker/discord/render.ts` stays the single source for the per-message ceiling; the splitter and
every consumer pin against it, not against their own literals.

**Duplication is measured, not preempted** (decided 2026-08-06). When the operator messages from
Discord, the model may reply via the reply tool and the mirror will also post the turn's final
text. Both post. If real use shows the duplication is noise, suppression or coaching the reply tool
into a quick-summary role on top of the mirror is a follow-up effort.

**Privacy** (decided 2026-08-06): full prompts and replies leaving the machine for Discord's
infrastructure is an accepted risk in a channel locked to the operator and the bot.
`docs/install.md`'s promise that tool-approval prompts are the only content leaving the machine is
rewritten in the same change that makes it false, and `CHANNEL_MIRROR` defaults on with a
per-session `-NoMirror` escape on the wrapper for sensitive work.

## Sections of Work

### 1. Measure UserPromptSubmit, wire the hooks
Model: opus
Captures real payloads on this machine before any wiring: `UserPromptSubmit` over `http` and over a
`command` hook (does it deliver, what does the payload carry), and a real `Stop` payload confirming
the transcript path field's name and shape. Findings land in the Chapter and in the
`claude-code-channel-and-hook-facts` project memory. Then: the fragment gains the `UserPromptSubmit`
hook (transport per the measurement) and the `Stop` mirror script entry; `hooks/stop-mirror.ps1`
(and `hooks/prompt-mirror.ps1` if the measurement forces a script) extract and post content;
`install/Install-Functions.ps1`'s merge handles the new entries; the installer substitutes absolute
script paths exactly as it does for `session-start.ps1`.
Acceptance: in a fresh wrapped session, a console prompt and the turn's reply both arrive at the
broker (visible in its log as mirror intake events, not content); an unwrapped session produces
zero visible hook errors and zero mirror posts; `settings-fragment.test.ts` pins every hook URL to
the one port.
Files in scope: `hooks/settings-fragment.json`, `hooks/stop-mirror.ps1` (new),
`hooks/prompt-mirror.ps1` (only if measured necessary), `hooks/session-start.test.ts` siblings,
`install/Install-Functions.ps1`, `hooks/settings-fragment.test.ts`.
Tests: at minimum, lock both directions of the token gate for each new script (no token: exits
without a socket; token: posts) and the fragment-to-script port pin. The silent failure is the
expensive one: a mirror script that never posts looks identical to a session nobody typed in.

### 2. Broker mirror intake
Model: fable
The content-bearing intake path: accepts the prompt and reply posts from Section 1's hooks,
authenticated by process token, associates them with the session via the registry, and hands them
to the routing layer for the bound thread. Tokenless and unknown-token posts drop with 202 like the
existing intake. New config: `CHANNEL_MIRROR` (default on) and `CHANNEL_MIRROR_MAX_BYTES` (default
256KB, the intake-side ceiling; `maxBodyBytes` for the mirror route must admit it), each registered
in both `broker/config.ts` and the installer's env allowlist. Mirror content never appears in the
broker log at any level. Whether this extends `POST /hook` with content-bearing events or adds a
dedicated route is the implementer's call within those constraints.
Acceptance: a token-authenticated mirror post reaches the thread queue; every refusal and drop path
answers exactly like the existing intake's equivalents; `CHANNEL_MIRROR=off` results in accepted,
dropped, unposted content.
Files in scope: `broker/intake.ts`, `broker/registry.ts` (only if association needs it),
`broker/routing/outbound.ts`, `broker/config.ts`, `install/Install-Functions.ps1`,
matching test files.
Tests: at minimum, both directions of `CHANNEL_MIRROR`, the size cap at and over the boundary, the
token gate in both directions, and a pin that mirror content is absent from log output. The
security review for this section is the changeset's priority: this is the section that inverts the
content-free posture.

### 3. Rendering and the splitter
Model: opus
Attribution and splitting. Prompt messages render with a console-origin attribution; reply messages
render as Claude's text. The splitter breaks on paragraph boundaries, falls back to line and then
hard boundaries, re-opens an interrupted code fence in the next message, and emits as many messages
as the reply needs with no count ceiling. Prompts beyond the paste cap are shortened with a visible
`(long paste shortened in mirror)` marker. All limits derive from `MAX_MESSAGE_LENGTH` in
`broker/discord/render.ts`; no consumer holds its own literal. Untrusted text goes through the
existing sanitization (`inert*` helpers) so a prompt cannot smuggle mentions or timestamps.
Acceptance: a reply longer than several messages arrives whole and in order; a code block spanning
a boundary is fenced correctly in both messages; a boundary-length message does not split; ordering
between mirror posts, reply-tool posts, and card edits is per-thread sequential.
Files in scope: `broker/discord/render.ts`, `broker/discord/surface.ts` or
`broker/routing/outbound.ts` (whichever owns posting), matching test files.
Tests: at minimum, fence-spanning, exact-boundary, code-point-safe splits (reuse
`sliceCodePoints`), a no-truncation pin for a very long reply, and a writer/reader cross-pin so the
splitter and the poster agree on the ceiling by construction rather than by coincidence.

### 4. Wrapper toggle and the honest docs
Model: sonnet
`Enter-ClaudeSession -NoMirror` sets the per-session off switch; the hooks forward it (header from
an allowlisted env var, or the scripts reading `$env:CHANNEL_MIRROR`), and the broker honors it per
post. Docs: `docs/install.md`'s privacy paragraph rewritten to state what leaves the machine with
mirroring on and how to turn it off; `docs/operations.md` gains the mirror failure modes (mirror
silent but session healthy, and the off-switch as the first check); `relay/README.md` and fragment
comments updated where they describe the content posture.
Acceptance: `-NoMirror` provably stops mirror posts for that session while another session mirrors
on; a sweep of `docs/` finds no surviving claim that permission prompts are the only content
leaving the machine.
Files in scope: `wrapper/Enter-ClaudeSession.ps1`, `relay/reply-permission.test.ts` (if the launch
line moves), `docs/install.md`, `docs/operations.md`, `relay/README.md`,
`hooks/settings-fragment.json` comments.
Tests: at minimum, both directions of `-NoMirror`.

## Out of Scope

- Deduplicating mirror posts against reply-tool posts, and any coaching of the reply tool into a
  summary role. Measured first; a follow-up effort if real use demands it.
- Mirroring tool calls, tool output, or anything mid-turn. The mirror carries the operator's
  prompts and each turn's final reply, nothing else.
- Streaming or incremental delivery of a reply while the turn is still running.
- Remote session start/stop, multi-user access, and everything the original spec already excludes.
- Retroactive mirroring of turns that completed before the session's hooks were installed.

## Open Questions

- Does `UserPromptSubmit` deliver over an `http` hook? Owner: Section 1's measurement, first thing
  it does; the section is written to absorb either answer.
- Prompt paste cap default (proposed 16KB before the shortening marker). Owner: Scott; adjustable
  during execution without design impact.

## Related

- Builds on [`docs/archive/plans/sapplefeld-channels_spec_v1.md`](../archive/plans/sapplefeld-channels_spec_v1.md),
  which built the broker, relay, hooks, and installer this extends. That spec's "Mirroring terminal
  output" out-of-scope entry excluded scraping terminal rendering via the relay's stdio; this plan
  mirrors conversation content via hook payloads, the source that spec itself named as richer.

## Chapters
