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

**Both sides are `http` hooks, and neither reads a transcript.** Hook transport is not uniform
(`SessionStart` cannot deliver over an `http` hook; `PostToolUse` and `Stop` can), and the two facts
this design turned on were measured before any of it was wired:

- `UserPromptSubmit` **does** deliver over an `http` hook, and its payload carries the prompt text in
  a `prompt` field alongside `session_id`, `transcript_path`, `cwd`, `prompt_id`, and
  `permission_mode`.
- The `Stop` payload carries **`last_assistant_message`**: the turn's final assistant text, whole.
  Thinking blocks are excluded from it, and a turn that dispatched subagents carries the main
  agent's reply rather than any subagent's report.

So neither mirror hook is a script. Both are fragment entries posting their whole payload as the
request body, which also keeps them off the one hazard a command hook has here: a `UserPromptSubmit`
hook's stdout is injected into the session's context, exactly as `SessionStart`'s is, and an `http`
hook has no stdout to leak into it.

The existing `http` Stop hook stays unchanged as the fast liveness tick (2s timeout, content-free
`/hook` route). The mirror rides a second Stop entry beside it, posting to the content-bearing route
with a longer timeout.

**Content already crosses the wire today.** The installed Stop hook posts its whole payload, and
that payload has always contained `last_assistant_message`; the intake reads it and drops it at
parse. Two consequences. Mirroring is not the first content on this socket, only the first content
the broker keeps. And a reply larger than `maxBodyBytes` (64KB today) already earns a 413, which
Claude Code surfaces as a visible error inside that session, so the mirror route's ceiling is a
correctness fix and not only a new knob.

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

### 1. Wire the mirror hooks
Model: opus
The measurement is done (see the Approach section and Chapter 1); no script is needed on either
side. The fragment gains two `http` entries posting to the content-bearing route `/mirror` on the
same broker port: a `UserPromptSubmit` entry, and a second `Stop` entry beside the existing
liveness one. Both carry the same three identity headers the existing hooks carry
(`X-Channel-Hook-Event`, `X-Channel-Process-Token`, `X-Channel-Session-Name`) with the same
`allowedEnvVars`, and both take a timeout longer than the liveness tick's 2s but still small.
`install/Install-Functions.ps1` admits `UserPromptSubmit` to its allowed-event list so
`Assert-ValidChannelFragment` stops refusing the fragment, and its identity match keeps recognizing
this project's own entries so a re-install replaces rather than duplicates them.
Acceptance: in a fresh wrapped session, a console prompt and the turn's reply both arrive at the
broker; an unwrapped session produces zero visible hook errors and zero mirror content kept;
`settings-fragment.test.ts` pins every hook URL, the two mirror entries included, to the one port;
merging the fragment twice leaves one copy of each entry.
Files in scope: `hooks/settings-fragment.json`, `install/Install-Functions.ps1`,
`hooks/settings-fragment.test.ts`, `install/Install-Functions.test.ts`.
Tests: at minimum, the port pin extended over the new entries, the allowlist-versus-header
consistency check extended over them, the installer's idempotent-merge case with two Stop entries
present, and a pin that the liveness Stop entry still targets `/hook` with its 2s timeout. The
silent failure is the expensive one: a mirror hook posting into a route nothing serves looks
identical to a session nobody typed in.

### 2. Broker mirror intake
Model: fable
The content-bearing intake path: accepts the prompt and reply posts from Section 1's hooks,
authenticated by process token, associates them with the session via the registry, and hands them
to the routing layer for the bound thread. Tokenless and unknown-token posts drop with 202 like the
existing intake. New config: `CHANNEL_MIRROR` (default on) and `CHANNEL_MIRROR_MAX_BYTES` (default
256KB, the intake-side ceiling; the mirror route's own body limit must admit it), each registered
in both `broker/config.ts` and the installer's env allowlist. Mirror content never appears in the
broker log at any level. The route is `POST /mirror`, dedicated rather than folded into `POST /hook`
(decided 2026-08-06): it leaves the content-free path byte-for-byte as it is, confines the larger
body ceiling to the one route where content is expected, and gives the log-suppression rule a single
place to hold, which is what makes this section's security review tractable. A tokenless post is
answered 202 without its body ever being assembled into a string, so an unwrapped session's prompts
and replies transit the socket and are discarded unread rather than buffered.
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
`Enter-ClaudeSession -NoMirror` sets the per-session off switch; the mirror hooks forward it as a
header interpolated from an allowlisted environment variable, and the broker honors it per post. Docs: `docs/install.md`'s privacy paragraph rewritten to state what leaves the machine with
mirroring on and how to turn it off; `docs/operations.md` gains the mirror failure modes (mirror
silent but session healthy, and the off-switch as the first check); `relay/README.md` and fragment
comments updated where they describe the content posture.
Acceptance: `-NoMirror` provably stops mirror posts for that session while another session mirrors
on; a sweep of `docs/` finds no surviving claim that permission prompts are the only content
leaving the machine.
Files in scope: `wrapper/Enter-ClaudeSession.ps1`, `relay/reply-permission.test.ts` (if the launch
line moves), `docs/install.md`, `docs/operations.md`, `docs/security-model.md`, `relay/README.md`,
`hooks/settings-fragment.json` comments. `docs/security-model.md` carries two statements mirroring
falsifies: that a permission prompt is the only surface sending content off the machine, and an
accepted-risk bullet describing the loopback socket's cleartext in terms of tool metadata alone.
The doc sweep also has counts to correct: several docs say the fragment declares two http hooks or
three events.
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

- Prompt paste cap default (proposed 16KB before the shortening marker). Owner: Scott; adjustable
  during execution without design impact. Running with 16KB unless told otherwise.

Resolved: `UserPromptSubmit` delivers over an `http` hook, measured 2026-08-06 with a `PostToolUse`
positive control in the same run. See Chapter 1.

## Related

- Builds on [`docs/archive/plans/sapplefeld-channels_spec_v1.md`](../archive/plans/sapplefeld-channels_spec_v1.md),
  which built the broker, relay, hooks, and installer this extends. That spec's "Mirroring terminal
  output" out-of-scope entry excluded scraping terminal rendering via the relay's stdio; this plan
  mirrors conversation content via hook payloads, the source that spec itself named as richer.

## Chapters

### Chapter 1 - 2026-08-06
Completed: 1. Wire the mirror hooks
Implemented By: implementer-opus, two review-fix rounds on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at default), then 2 fix rounds; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **The measurement overturned the reply-side design before a line was
written.** The `Stop` hook payload carries `last_assistant_message`, the turn's final assistant text
in full: measured whole at 34,892 characters, thinking excluded, and carrying the main agent's reply
rather than a subagent's report on a turn that dispatched subagents. The spec had assumed no payload
carried reply text and budgeted `hooks/stop-mirror.ps1` to read the transcript session-side. That
script is not needed and was never written. `UserPromptSubmit` also delivers over `http`, measured
with a `PostToolUse` positive control in the same run so a null result could be told apart from a
probe harness that never loaded. Both sides are therefore fragment entries, which additionally
dodges a hazard a script would have had: a `UserPromptSubmit` command hook's stdout is injected into
the watched session's context exactly as `SessionStart`'s is.

The route is `POST /mirror`, dedicated rather than folded into `POST /hook`, so the content-free
path stays as it is and the larger body ceiling is confined to where content is expected.

A consequence found while measuring, not previously known: the installed `Stop` hook has always
posted `last_assistant_message`, so content already crosses this socket in every session on the
machine and a reply over the 64KB cap already earns a 413. Section 2 owns raising that ceiling.

Deviation from the spec as written: Sections 1's two PowerShell scripts are gone and the section is
declaration, installer, and tests. The Approach and Section 1 text were rewritten to match before
implementation started.
Review Findings: Both reviewers independently returned the same Critical: the fragment shipped hooks
at `/mirror` while the broker answered 404 there, and a non-2xx hook response is a visible in-session
error, machine-wide, on every prompt and every turn end. Fixed by landing an accept-and-drop stub for
`POST /mirror` that answers 202, drains the body without assembling it, and logs nothing, which makes
the section independently safe to push under Commit-and-Push. Second Critical (adversarial, echoed as
a Major by the security review): `Assert-ValidChannelFragment` pinned command hooks but validated
nothing about an http hook, so anyone who can write the fragment could point a url off-host and
exfiltrate every prompt on the machine at the next re-install. Fixed by pinning http urls to
loopback and this project's two routes, and holding header names and `allowedEnvVars` to exact
allowlists. Security Major, accepted and fixed: the widened event list admitted a `command` hook
under `UserPromptSubmit` with an attacker-chosen directory, so `command` is now refused on every
event but `SessionStart`. All Minors fixed: exact liveness timeout pin, a mirror-timeout floor,
`matchAll` so a header interpolating two variables has both checked, the substitution test extended
over every http url, and a stale comment in `Install-Host.ps1`.

Two findings were adjudicated and discarded, both from the blind reviewer, which by contract had
neither the spec nor the measurement: that the fragment comment is wrong to say the `Stop` payload
carries the reply (it does, measured), and that the `session-start.ps1` port pin had been dropped (it
is live at `hooks/settings-fragment.test.ts:237-243`, read directly).

Deferred with reason: the merge sweeps only the events the fragment declares, so an event later
removed from the fragment leaves orphaned entries in the operator's settings with no uninstall path.
Pre-existing, not triggered by a change that only adds events. The security review's doc findings
(`docs/security-model.md` claims mirroring falsifies) are routed to Section 4, whose file list now
names that doc.
Stamps: adjudicated 2, stamped 2 (`typescript-runs-unbuilt-under-node-type-stripping`,
`a-test-that-drives-an-installer-can-install`; both were forwarded into the dispatch brief and shaped
the import convention and the installer-test isolation). The measured hook facts were written to the
`claude-code-channel-and-hook-facts` project memory.
Next: 2. Broker mirror intake
Commit Model: Commit-and-Push
