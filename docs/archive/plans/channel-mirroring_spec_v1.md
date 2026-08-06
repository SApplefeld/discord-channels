# Console-to-Channel Mirroring

Status: Complete
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
the broker keeps. And a reply larger than `maxBodyBytes` (64KB) earned a 413, which Claude Code
surfaces as a visible error inside that session, so the mirror route's ceiling is a correctness fix
and not only a new knob. That 413 outlived this section's fix and was closed in the finishing pass:
both hook routes now drain and answer 2xx, differing only in ceiling. See Chapter 5.

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
The honesty-critical doc corrections land in this section rather than Section 4, because this is the
change that makes them false and the Approach commits to rewriting such a promise in the same
change. Two claims in `docs/security-model.md` go: that posting into the operator's thread as Claude
requires holding the relay pipe rather than merely knowing the process token (the mirror posts on
the token alone, and that token is inherited by every subprocess a wrapped session spawns), and that
what a session can distort is only its own status. `docs/install.md`'s promise that tool-approval
prompts are the only content leaving the machine goes with them. Section 4 keeps the rest of the doc
work, including the `-NoMirror` switch it documents.
Files in scope: `broker/intake.ts`, `broker/registry.ts` (only if association needs it),
`broker/routing/outbound.ts`, `broker/config.ts`, `install/Install-Functions.ps1`,
`docs/security-model.md`, `docs/install.md`, matching test files.
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
`broker/discord/render.ts`; no consumer holds its own literal.

Sanitization needs building here, not merely calling. `inertMessage` applies `withoutInvisible` and
`fit` and never the markdown escape `inertText` uses, so text posted through it keeps `<@id>` mention
pills and `<t:...:R>` timestamp chips. Discord's `allowed_mentions` stops those from pinging anyone
but not from rendering, so mirrored text can draw a convincing copy of a permission prompt or a
broker notice inside the very channel the operator answers prompts in. Mirrored text therefore gets
the chip syntax neutralized while keeping markdown readable, and every mirrored message carries a
renderer-composed attribution that mirrored content cannot forge.

Ordering is this section's to build, not to assume: mirror delivery is fire-and-forget at the
Section 2 seam, so per-thread sequencing between a turn's reply, the next prompt, and a reply-tool
post has to be made real here.
Acceptance: a reply longer than several messages arrives whole and in order; a code block spanning
a boundary is fenced correctly in both messages; a boundary-length message does not split; ordering
between mirror posts and reply-tool posts is per-thread sequential. Card edits are outside that
sequence by nature: a card edit rewrites a message that already exists rather than appending to the
thread, so it cannot interleave in post order and has nothing to be sequenced against.
Files in scope: `broker/discord/render.ts`, `broker/discord/surface.ts` or
`broker/routing/outbound.ts` (whichever owns posting), matching test files.
Tests: at minimum, fence-spanning, exact-boundary, code-point-safe splits (reuse
`sliceCodePoints`), a no-truncation pin for a very long reply, and a writer/reader cross-pin so the
splitter and the poster agree on the ceiling by construction rather than by coincidence.

### 4. Wrapper toggle and the honest docs
Model: sonnet
Locus: split. The code (wrapper switch, hook header, installer allowlists, broker honoring it) is
dispatched; every write under `docs/` is the main thread's, which is where doc authoring belongs.
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

- Builds on [`docs/archive/plans/sapplefeld-channels_spec_v1.md`](sapplefeld-channels_spec_v1.md),
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

### Chapter 2 - 2026-08-06
Completed: 2. Broker mirror intake
Implemented By: implementer-fable, one review-fix round on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at default), then 1 fix round; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **The honesty-critical doc corrections were pulled forward from Section 4
into this section.** The security review found `docs/security-model.md` promising that posting into
the operator's thread as Claude requires holding the relay pipe rather than merely knowing the
process token. The mirror route makes that false: it posts on the token alone, and that token is
inherited by every subprocess a wrapped session spawns. Under Commit-and-Push the section reaches
origin as soon as it passes, so deferring the correction would leave an untrue security document on
the remote across sections, against the Approach's own rule that a promise is rewritten in the same
change that falsifies it. The route was deliberately NOT gated behind a stronger key: the mirror
hooks are `http` hooks whose only credential is an environment variable interpolated into a header,
so any new key would be inherited by exactly the subprocesses in question and would buy the
appearance of a control rather than a control. The guarantee is restated with its real blast radius
instead. `docs/install.md` and `docs/security-model.md` were corrected in the main thread; Section 4
keeps the rest of the doc work.

Two knobs land: `CHANNEL_MIRROR` (default on, strict boolean, refuses an unrecognized spelling the
way the numeric knobs refuse a bad value) and `CHANNEL_MIRROR_MAX_BYTES` (default 256KB, bounded
64KB to 4MB). Both are registered in `broker/config.ts` and the installer's env allowlist, now under
a mechanical pin, which did not previously exist.

An oversized mirror post is drained and answered 202 rather than 413. A 413 is a visible error
inside the session, at the end of exactly the longest turns, which is the failure Section 1 spent a
round removing. The cost is that a reply past the ceiling misses the thread with only a log line
saying so, which Section 4's failure-modes documentation names.
Review Findings: Blind found, by execution, that the mirror event gate was bypassable through the
prototype chain: `constructor` or `__proto__` as the event header resolved to a mapping, skipped the
400, and ran the authenticated path with an undefined field, delivering `{"undefined":"text"}` with
an undefined kind. Fixed with an `Object.hasOwn` guard and pinned with a test driving four prototype
keys. Security found two more Majors, both fixed: mirror posts spent the same Discord write budget
as permission prompts, so mirror volume could hold the shared rate-limit block and drop the alerts a
parked session waits on (the mirror now has its own bucket, which creates no Discord capacity and is
only a starvation guard, as its comment says); and mirror posts resolved on the process token alone
while the liveness path honors a payload `session_id` opportunistically, so a straggler `Stop` post
arriving after `/clear` replaced the session would post the previous conversation's reply into the
new session's thread. All eight Minors fixed: a response-body token-validity oracle (`{accepted:true}`
versus `{ignored:true}`), an unbounded drain a live-token holder could hold open, three refusal
causes sharing one rate-limiter key so one masked the others, an over-cap log line that overstated
what had been buffered, a missing `resume()` on one early exit, a config floor that accepted a value
silently disabling the feature, duplicated resolution logic between `reply()` and `mirror()`, and a
leak test whose comment claimed coverage of every branch while four went undriven. That last one is
the repo's own recurring defect shape, caught by both reviewers.

The central invariant holds and was traced branch by branch by two reviewers independently: mirror
content reaches the log at no level, including inside a caught parse error (V8 embeds a source
excerpt, so the error object is discarded rather than logged) and inside the delivery rejection.
Review Findings deferred with reason: the mirror still truncates at `MAX_MESSAGE_LENGTH` and still
posts unordered, and `inertMessage` does not escape mention or timestamp chip syntax. All three are
Section 3's, and the spec's Section 3 text was corrected: it had premised the work on the `inert*`
helpers already neutralizing chips, which is false for the message path.
Stamps: none surfaced (zero unstamped reads in the section's span; Chapter 1's sweep took both).
Next: 3. Rendering and the splitter
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-06
Completed: 3. Rendering and the splitter
Implemented By: implementer-opus, one correction round and one review-fix round on the same agent,
plus a resume after an API error killed the first run during orientation
Metrics: 1 review round (adversarial + blind at fable, security at default), 2 fix rounds; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **Sanitizing mirrored text turned out to be the hard part of this section,
not the splitter.** The spec had premised the work on the existing `inert*` helpers already stopping
smuggled mentions and timestamps. They do not: `inertMessage` applies `withoutInvisible` and `fit`
and never the markdown escape, so anything posted through it keeps `<@id>` pills and `<t:...:R>`
chips. Discord's `allowed_mentions` stops those from pinging but not from rendering, in the very
channel where tool approvals are answered.

The first implementation escaped every `<` and `>` unconditionally. Rendering a representative reply
showed why that fails: Discord processes no escapes inside a code fence, so `const f = (a) =\> a \<
10;` and `Array\<string\>` reach the reader with visible backslashes, and a coding assistant's
replies are mostly code. The escape was made fence-aware, which then cost a full review round: all
three reviewers returned Criticals in one family, because any divergence between our fence model and
Discord's is a bypass. Two executed their repros. The bypasses were a hard cut slicing a ``` in half
(after which the escape and the splitter disagreed about the whole remainder), a hard cut landing
between an inserted backslash and the character it neutralized, and text after a CLOSING delimiter
on the same line being treated as code when Discord renders it as prose.

The most valuable finding was not a bypass at all. The unbounded fence info string was carried onto
every subsequent message, driving the per-message budget negative and the splitter into a
one-code-point-per-message fallback: 80KB of crafted input produced 78,119 messages and 148MB of
strings in 24.4 seconds, synchronously, on the broker's only event loop, ahead of any budget check.
That is not a mirroring failure, it stalls permission-prompt delivery and verdict intake for every
session on the host. Bounding the info string and clamping the cut floor took the same shape to 141
messages in 23ms at the intake's 256KB ceiling.

Decided while fixing: the attribution's unforgeability no longer depends on the fence model being
right. A line-leading `>` is escaped unconditionally, inside fences too, so a model divergence costs
a visible backslash in front of a line of code rather than a forged `> ✨ Claude`. Inline code spans
are deliberately NOT exempted from the escape, so `` `a \<= b` `` still shows a backslash: exempting
them means modelling a second syntax, which is the class that just failed. A multi-message reply
that fails part way stops, drops the rest, and reports how far it got, because a reply posted around
a hole reads as text Claude never wrote. The spec's card-edit ordering criterion was amended rather
than built: a card edit rewrites an existing message rather than appending, so it has nothing to be
sequenced against.
Review Findings: All Criticals and Majors fixed and pinned red-first, with the reviewers' own repro
scripts flipped and re-run by the main session: the forged attribution now lands as escaped text
with only the renderer's own quoted line, and the message-per-code-point explosion is gone. Minors
fixed: an escaped backtick no longer reads as a delimiter, the shortening marker closes an open
fence before appearing so it is not rendered as code, and four-or-more backtick runs toggle once.
Two limits are stated in the code rather than fixed: trailing whitespace at a message boundary is
not preserved, and a mid-line delimiter can still put the two fence models at odds. One reviewer
wanted inline code spans exempted for readability and another argued against it; recorded above.

Residual, and the reason the field pass matters: two rendering claims are INFERRED, not measured.
That Discord draws no mention pill or timestamp chip inside a fenced code block, and that a
backslash-escaped `>` does not open a blockquote. Both are cheap to retire with one look at the real
channel, and if either is false the fix is confined to the escape.
Stamps: adjudicated 2, stamped 2 (`two-components-agreeing-is-not-two-checks`, which is exactly what
the reviewers caught here in a comment claiming one shared fence scanner made divergence impossible;
and `claude-code-channel-and-hook-facts`, whose measured payload fields the mirror event vocabulary
is built from).
Next: 4. Wrapper toggle and the honest docs
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-06
Completed: 4. Wrapper toggle and the honest docs
Implemented By: implementer-sonnet for the code, main session for every write under `docs/`, one
review-fix round
Metrics: 1 review round (adversarial + blind at opus, security at default), 1 fix round; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **Two of the round's worst findings were things the orchestrator had already
noticed and waved off**, which is the lesson worth keeping. The per-session switch was originally
given the same environment variable name as the broker's own host-wide knob, `CHANNEL_MIRROR`, on
the reasoning that the two live in different processes. They do not stay there: the broker inherits
its environment, `broker.env` only overrides keys it actually contains, and `Install-Host.ps1` never
writes that key, so a broker started from a `-NoMirror` shell comes up with mirroring off for every
session on the host, while the runbook's first diagnostic step points at a file that does not
mention it. Renamed to `CHANNEL_SESSION_MIRROR`, which removes the class rather than the instance.

The Critical: `-NoMirror` silently did nothing on this machine as installed. The switch rides a
header the mirror hooks carry, and the settings file merged onto this host predates that header, so
the wrapper would set the variable, no header would be sent, and the session would mirror in full
while the operator believed otherwise. A privacy control that fails open silently is worse than
none, so the wrapper now verifies the installed mirror hooks carry the switch and refuses to launch,
naming the installer, rather than running the session mirrored.

Decided: the switch stays advisory rather than enforced. Recording the preference on the session
record at `SessionStart` would stop a token holder omitting the header, but a token holder can
already post arbitrary mirror content, so enforcement closes nothing that is open. The switch is the
operator's privacy from their own session, and `docs/security-model.md` now says exactly that.

Also decided: the honesty sweep goes wider than the plan's file list. `docs/install.md` claimed
`-NoMirror` covers "sensitive work", which is untrue of the code: the switch stops the conversation
and nothing else, and a tool approval prompt from that session still carries the shell command and
file contents to Discord. The root `README.md` still said no bot token existed and the Discord half
had never run, contradicted by the install commits and by this session posting to the thread.
Review Findings: Critical and both Majors fixed and pinned red-first. All twelve Minors fixed,
including three the sweep had missed (stale "two http hooks" counts in `hooks/session-start.ps1`,
`broker/config.ts`, and `Install-Host.ps1`'s operator-facing help text), the per-session header check
running ahead of the token check and thereby erasing the only log line that witnesses forged mirror
traffic, an installer allowlist that admitted the switch header on a liveness hook while the repo's
own test forbade it (two gates in one changeset encoding opposite rules), and a fragment test whose
name claimed full coverage while iterating only http hooks, so the SessionStart command hook was
never examined.

A new operator check E was added rather than a test: the seam between Claude Code interpolating an
allowlisted variable into a hook header and the broker reading it cannot be exercised by anything in
this repository, and neither can Discord's rendering of the escape. Both are written up with pass
and fail criteria and what each failure would change.
Stamps: none surfaced (zero unstamped reads in the section's span).
Next: finishing-work
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-06
Completed: finishing-work
Implemented By: main session, with the qa-verifier, a fable security review, a fable adversarial
review, the docs-curator, and one implementer-opus fix round
Metrics: QA PASS; 2 finishing reviews; 1 fix round; advisor opus
Decisions / Surprises: **The finishing reviews earned their keep, because both found the same gap
that four per-section rounds structurally could not see.** Section 3 spent a whole review round
making mirrored text unable to draw a mention pill, a timestamp chip, or the renderer's own
attribution line. The relay's reply tool posts into that same thread through a different writer,
which escaped none of it, so a reply-tool message beginning with the attribution marker rendered
identically to a real one. Each section was correct alone; the invariant failed across the seam
between two writers into one thread. The fix routes reply-tool text through the mirror's own escape
rather than a second one, because two escapes are two readings of where a code fence is, and a
disagreement between them costs exactly the chip one of them believed it had removed.

Three more cross-seam findings, all fixed. The `-NoMirror` gate accepted any non-empty switch header,
so a settings file carrying a fixed `"on"` value passed both host-side gates and the switch failed
open again, in a new shape, after Section 4's round had fixed it in the old one. The installer's URL
pin allowed any port, so a tampered fragment could point the mirror hooks at another local port and
receive every prompt and reply plus the process token, persistently, with the broker running
healthy. And the liveness route still answered 413 to an oversized `Stop` payload: Chapter 1 assigned
raising that ceiling to Section 2, only the mirror route's ceiling landed, and a 413 is a visible
in-session error at the end of exactly the longest turns. That one is a spec item that fell through
the cracks, caught here rather than by an operator.

The docs curator found one stale claim that predates this effort: `docs/operations.md` said the
`needs you` thread state "is fed by nothing", which the sender-gate effort falsified when it wired
`permissions.waiting()` into the surface. Verified against `broker/index.ts` and
`broker/discord/state.ts` before correcting: the code is right and the doc was stale, so this is a
doc fix rather than a code defect.
Review Findings: QA PASS with every acceptance criterion verified or classified operator-only.
Security review: no Critical, one Major (the reply-tool escape) and three Minors, all fixed.
Adversarial review: APPROVED_WITH_CONCERNS, three Majors and four Minors, all fixed or documented as
stated limits. Two limits are stated in code rather than fixed: mirror posts reach the ordering chain
in body-read-completion order rather than arrival order (the window needs a large body still being
read when the next post lands, and a turn's reply and the next prompt are separated by human typing
time), and trailing whitespace at a message boundary is not preserved.
Stamps: see the close-out; the sweep ran at every Chapter and again here.
Next: none. The effort is complete.
Commit Model: Commit-and-Push

## Operator-pending

One verification is not Claude's to close and does not hold this plan open. `docs/operator-checks.md`
check E covers it, with pass and fail criteria and the confined fix if it fails:

- Whether Discord renders a mention pill or a timestamp chip inside a fenced code block, and whether
  a backslash-escaped `>` opens a blockquote. The chip escape is fence-aware on the premise that it
  does neither. If either is false, the fix is confined to `withoutChips` in
  `broker/discord/render.ts`: drop the fence exemption and accept visible backslashes in code.
- Whether `-NoMirror` stops mirror posts on a real host while another session mirrors on. Every leg
  short of the live seam is pinned by tests; the seam where Claude Code interpolates an allowlisted
  environment variable into a hook header cannot be exercised from this repository.

A failure of either reopens the work as a new round.
