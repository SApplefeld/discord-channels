# Thread fidelity: the thread carries what the console carried

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: S1 implementer and its reviewer pair; the S3 and S4 reviewer pairs (one tier above their opus writers); finishing reviews
Created: 2026-08-07

## Goal

A session watched side by side with its own Discord thread currently shows four gaps, all observed
live on 2026-08-07: the first narration chunk of a session's first turn never appears; consecutive
narration chunks post as separate headed messages instead of coalescing; a message typed at the
console while the model is mid-turn is never mirrored at all; and a long reply that splits into
many messages stops partway, dropping the rest. When this plan is done, the thread is a faithful
copy of the console: narration starts with the turn's first chunk and grows one message, a mid-turn
typed message lands as an operator-attributed mirror in order, and a split reply always lands
whole, taking as long as Discord's rate limits require rather than truncating.

## Approach

Four root causes, each confirmed against the live broker log, the session transcript's own
timestamps, or both. Each section below fixes one, and the fixes stay inside the components that
own the behavior today: no new processes, no new trust surfaces, no queueing of content for later
delivery beyond a single in-flight run pacing itself.

**Coalescing loses to the broker's own gateway echo.** The interim path takes its coalescing entry
off the map for the whole of a fresh post's HTTP round trip and refuses to remember the run when
the per-thread invalidation clock moved mid-flight. Every gateway MESSAGE_CREATE in a thread with
no held entry bumps that clock, including the echo of the very message being posted, and Discord
routinely delivers a bot's own echo over the websocket before the REST response resolves. So the
common ordering forfeits the state on every fresh post and nothing ever coalesces: the residue the
narration-coalescing close-out accepted as rare is the dominant case. The fix keeps every
invalidation window that contract established and stops only the own-echo false positive: arrivals
that carry a parseable message ID are judged by snowflake order against the run's own final
message, and only something strictly newer refuses the remember. The blind clock remains for the
arrivals that carry no ID to judge.

**The tailer's baseline swallows the first turn's opening narration.** A transcript is read only
after the session's mirror-on verdict, which arrives with the first UserPromptSubmit, and the first
allowed pass baselines to the file's current end. The poll ticks every 20 seconds and the model's
first text lands a few seconds after the prompt, so the baseline usually lands past it and skips it
permanently. The fix moves the baseline to the moment the verdict itself arrives: the allow signal
fires seconds before the model writes anything, so a size probe taken then captures the whole turn.
The probe reads zero content bytes, and a -NoMirror session is never allowed, so the fail-closed
property of the gate is untouched: no transcript of an opted-out session is ever opened.

**A mid-turn typed message fires no hook.** A message typed while the model is working is queued
and injected as a `queued_command` attachment line in the transcript; no `type:"user"` line is
written and no UserPromptSubmit fires, so the hook-driven mirror path never hears of it. The fix
reads it where it does exist: the tailer already reads the transcript under the exact trust posture
this content needs, so its allowlist grows a second line shape, and the extracted prompt is
delivered through a new router seam that renders it with the same operator attribution, the same
escaping, and the same channel-envelope echo check a hook-mirrored prompt gets. The fail direction
of the allowlist stays silence: any field deviating from the observed shape yields nothing.

**Split runs are truncated by design, and the design is wrong for this surface.** The router stops
a run at the first refused post and drops the remainder, and the refusal that triggers this mid-run
is the conversation budget's bucket going empty: Discord allows roughly five message creates per
five seconds per thread and a long report renders into more, fired back to back. Ending early was
chosen over an invisible mid-reply hole, but the operator's real loss is the content: half a report
read from a phone hours later is strictly worse than a report that took twenty seconds longer to
finish posting. The fix paces the run instead of amputating it, decided 2026-08-07 with the
operator: a proactive gap between consecutive posts of one run keeps the send rate under the
bucket, and a rate-limited refusal waits out the budget's own reported reset and retries that same
message, under a per-run cap on total reactive waiting. Rate-limited is precisely the class where
nothing landed and a retry is safe; every other refusal stops the run exactly as today. The
per-thread ordering chain already serializes everything behind the paced run, which is the correct
order for a thread to read in, and permission alerts ride a separate writer that never enters this
router, so nothing steering-tier waits behind a report.

Decided 2026-08-07, all with the operator: pace rather than truncate, with proactive spacing near
one post per 1.5 seconds; queued-prompt mirroring via the tailer; baseline at allow time;
Commit-and-Push.

## Sections of Work

Sections run in order: 1, 3, and 4 all touch `broker/routing/outbound.ts`, and 3 builds on the
tailer shape 2 leaves behind, so nothing here builds in parallel with anything else.

### Standing Brief Amendments

Folded into every implementer and reviewer dispatch from here on. Each earned its place by
surfacing in more than one section's review, which makes it a property of how this work generates
defects rather than a one-off.

- **A comment that names a property is a claim, and falsifying it is a defect.** Sections 1 and 2
  both shipped comments asserting properties their own changes had removed, including a closed
  enumeration that omitted one of its members. A change that falsifies a comment anywhere in the
  tree fixes that comment in the same pass, and the sweep includes JSON `_comment` fields.
- **A guard and its test must not share a premise.** Section 2's round-one Critical survived a
  green suite because the test inserted a scheduling boundary that serialized away the exact
  ordering the guard mishandled. A test that constructs its fixture from the same assumption as the
  code under test proves only that the two agree. Pin the mechanism by removing it and watching the
  test go red.
- **Pin a privacy or silence property on the operation, not on the output.** An assertion that
  nothing was published is satisfied identically by a read that happened and yielded nothing. Where
  the property is that something never occurred, assert on the injected seam's call count or bytes
  read.
- **A write-back after an await re-validates first.** Every `await` is a real gap in which an
  independently-arriving request mutates the same entry. `tsc --noEmit` does not invalidate a
  `=== null` narrowing across an await, so a green lint says nothing here.

### 1. Router freshness judges arrivals by snowflake, not by count

Model: fable
Status: Complete

The interim path's remember decision in `broker/routing/outbound.ts` changes its evidence. Today
`noteThreadMessage` with no held entry bumps the thread's invalidation clock unconditionally, and
the fresh-post task refuses to remember when the clock moved during its round trip; the run's own
gateway echo is what usually moves it. Instead, every arrival with a parseable snowflake records a
per-thread high-water mark, the newest message ID this router has seen land in the thread, in a map
bounded by `capBeside` like its siblings. The fresh-post task remembers its run when the ID-less
clock did not move during the round trip and the high-water mark is absent or not strictly newer
than the run's own `lastMessageId` by snowflake order. Snowflakes are monotonic in creation time,
so the run's own echoes and the late echoes of everything older can never exceed the run's final
message, while a foreign message genuinely created after it always does; the high-water mark needs
no clearing for correctness, only bounding for memory, and the bound bumps the evicted thread's
ID-less clock so a dropped mark refuses a remember rather than permitting one. The run's own posted
message IDs raise the mark like any arrival, so a thread whose gateway echoes are lost does not hold
a mark that ages while REST keeps posting under it. The ID-less clock remains for what cannot be
judged: `endNarration` (a notice or alert posted outside this router) keeps bumping it, and so does
an arrival whose ID does not parse as a snowflake, both refusing the remember conservatively
exactly as today. The held-entry semantics of `noteThreadMessage` change in no way: the remembered
message's own echo does not clear, an older echo does not clear, a strictly newer or unparseable
arrival clears. The doc comments on `noteThreadMessage`, the invalidation clock, and the interim
path state the new contract.

Files: `broker/routing/outbound.ts`, `broker/routing/outbound.test.ts`.

Acceptance: `npm test` green.

Tests: lock the regression this section exists for, red first: a message-create arriving between
the fresh post going out and its response resolving, carrying the ID of the run's own final message
(or an older one), no longer forfeits the state, and the next chunk appends by edit. Lock the
refusals that must survive the change: a foreign arrival strictly newer than the run's final
message mid-round-trip refuses the remember; an `endNarration` mid-round-trip refuses it; an
unparseable ID mid-round-trip refuses it. Lock the held-entry paths unchanged in both directions:
own echo and older echo keep the state, a strictly newer arrival clears it. The failure mode this
section must not introduce is the inverted one: a wrongly remembered run appends narration above a
message that landed mid-post, in the channel approvals are answered in, so every refusal test
asserts the next chunk posts fresh.

### 2. The tailer baselines at the mirror-on verdict, not the next poll tick

Model: sonnet
Status: Complete

`broker/tail.ts` gains the baseline probe: the same zero-byte size probe `pollOne` performs today
(`read(path, 0, 0)`), fired the moment a session is both allowed and has a learned path, with the
pending promise held on the entry. Either of `allow` and `learn` can complete that pair, and
whichever does is the one that fires it: the mirror-on verdict and the hook post that teaches the
path arrive on independent routes with no ordering guarantee between them, so an allow-before-learn
session would otherwise wait for the next poll tick and lose exactly the opening chunk this section
exists to save. A second allow while a probe is pending starts nothing new. `pollOne` awaits a
pending probe before its own null-offset branch, which remains as the fallback for a session whose
probe failed, and `poll` drains the probes outstanding once its pass finishes, including one
started too late in the pass for any per-session closure to have awaited. The drain runs in a
`finally`, so a pass that rejects still drains rather than settling while a read holds a file
handle, and it is bounded to two rounds against a snapshot rather than looping while the set is
non-empty: a probe that keeps re-arming would otherwise hold `running` non-null forever and halt
narration for every session. A probe still outstanding after both rounds is left running, and
`pollOne`'s own await of the pending probe catches up with it on the next pass. What this covers is
probes started during a pass; a probe fired between poll ticks is not awaited by the broker's
shutdown, which awaits the last pass rather than the tailer's outstanding reads.

A probe's resolution is not enough evidence on its own, because the state it validates against can
be restored by the very signals that should invalidate it: a re-allow restores `allowed`, and a
relearn back onto the same path restores `path`, so a probe dispatched before a suppression can
resolve after a re-allow with every field reading unchanged and write its pre-suppression size as
the baseline, publishing the whole mirror-off window on the next pass. The discriminator is a
per-entry epoch counter, bumped by `suppress`, by `forget`, and by `learn` on a path change, and
captured at dispatch: a write-back lands only when the map still holds this exact entry, the epoch
still matches, the session is still allowed, and the path is still the one read. `pollOne` captures
the epoch on entry and re-checks all four after every await it makes (the pending probe, the
fallback read, the content read, and each delivery), because a suppression landing inside any of
those gaps otherwise reaches an unguarded write: in particular `held.offset += lastNewline + 1`
against a nulled offset evaluates `null + n` to `n`, silently converting an absolute file position
into a slice-relative one, and neither the shrink guard nor the overrun guard catches it (`size <
null` is false and `size - null` is `size`). A probe rejection is swallowed so the poll-time
fallback covers it.

`suppress` also drops the held offset, so a later re-allow rebaselines rather than resuming from
before the suppressed window: the transcript keeps growing while mirroring is off, and resuming
from the old position would publish everything written during it. The cost is at most one poll
interval of narration at the moment mirroring resumes, which is the correct direction.

The `-NoMirror` property is preserved structurally: `startProbe` requires `allowed` at dispatch, so
a session that is never allowed never receives a probe and its transcript is never opened, not even
for a stat. The narrower statement that now holds of a suppressed session is that no new read is
started for it and a read already in flight writes nothing back.

Files: `broker/tail.ts`, `broker/tail.test.ts`.

Acceptance: `npm test` green.

Tests: lock the regression, red first: text appended to the transcript after the allow signal but
before the first poll pass is delivered as narration, which is exactly the first-turn opening chunk
that vanishes today. Lock the same for an allow that arrives before the matching learn. Lock the
fail-closed direction: a session that is learned but never allowed gets zero reads of any kind,
probe included, asserted on the injected `readFile`'s call count. Lock the staleness guards: a path
relearned between the probe starting and resolving discards the stale size; a probe rejection falls
back to the poll-time baseline without republishing anything older than the fallback's own
observation. Lock that a second allow during a pending probe does not double-probe, and that an
allow arriving after the baseline is already set does not move it.

Lock the epoch, which is the guard the whole privacy direction rests on. A probe dispatched before
a suppression and resolving after an immediate re-allow, with no macrotask boundary serializing the
two, writes no offset; a suppression landing during `pollOne`'s own content read leaves no
slice-relative offset behind; and a `learn` onto a new path landing during `pollOne`'s await of a
stale probe does not baseline the new path with the old file's size. Lock that content written
during a suppressed window is never published by the re-allow that follows. At least one of these
pins on bytes actually read rather than on messages posted, because an assertion that nothing was
published is satisfied identically by a read that happened and yielded nothing, which is the weaker
claim; the rest discriminate through non-empty same-session fixture content, so a failed guard
yields a non-empty post list.

Lock the two mechanisms whose removal would otherwise leave the suite green: `poll` does not settle
while a probe started from inside its own pass is still reading, and a suppression landing during
one chunk's delivery stops the rest of the batch from posting.

### 3. Queued mid-turn prompts mirror through the tailer

Model: opus
Status: Complete

The tailer's line scan in `broker/tail.ts` yields a second item kind beside assistant text, in
transcript order within one pass. A line yields a queued prompt only when all of these hold: its
`type` is `attachment`, it is not a sidechain, its `sessionId` names the session the transcript was
learned for, its `attachment` is an object whose `type` is `queued_command`, whose `commandMode` is
`prompt`, whose `origin.kind` is `human`, and whose `prompt` is a non-empty string. Everything else
yields nothing, the same allowlist discipline `assistantTexts` holds: `queue-operation` lines are
deliberately ignored (an enqueued message the operator withdrew before injection was never part of
the conversation), and a queued slash or shell command is not conversation prose. Delivery goes
through a new option on the tailer, `deliverPrompt`, wired in `broker/index.ts` to a new router
method, with the same one-await-per-item ordering the chunks follow, so a prompt line sitting
between two assistant lines posts between them; a failed delivery is dropped and never retried, and
no echo digest is recorded, because no other path posts this text.

The router method in `broker/routing/outbound.ts`, `interimPrompt(sessionId, text)`, addresses by
session ID through `threadFor` exactly as `interim` does. It applies the channel-envelope check the
mirror path applies to hook-carried prompts, on the same normalized pre-render text: a queued
message that is the harness's injection of the operator's own channel message must not echo back
into the thread it was typed in, whichever line shape the harness records it under. It renders
through `renderMirror("prompt", text)`, so a queued prompt and a hook-mirrored prompt are
indistinguishable on the thread: operator-attributed quote block, full escaping, the attribution
unforgeability rule holding for text that entered through a file read exactly as for text that
entered through a hook. Delivery goes through `deliver`, so the post takes its place on the
thread's ordering chain and ends any narration block in-chain, exactly as the operator's message
being newer demands. Empty-after-render and no-thread drops log under the same drop-log
discipline as the interim path, cause and session and never content.

Files: `broker/tail.ts`, `broker/routing/outbound.ts`, `broker/index.ts`, `broker/tail.test.ts`,
`broker/routing/outbound.test.ts`.

Acceptance: `npm test` green.

Tests: lock the allowlist in both directions. The observed live shape yields the prompt: a fixture
matching the line measured on 2026-08-08 across this project's 41 transcripts, `type` `attachment`,
`attachment.type` `queued_command`, `commandMode` `prompt`, `origin.kind` `human`, `prompt` a
string, `isSidechain` false, alongside top-level `sessionId`, `cwd`, `uuid`, `parentUuid`,
`timestamp`, `userType`, `version`, `gitBranch`, and `entrypoint`.

Each single-field deviation yields nothing, and three of the refusals are the measured live
population rather than hypotheticals, so each gets a fixture drawn from the real shape. The
dominant line by far is `commandMode` `task-notification` (118 of 136 measured), a machine-written
background-task notice that must never reach the thread. `origin.kind` `channel` (7 of 136) is the
operator's own channel message, which carries `origin.server` and `isMeta` and must not echo back
into the thread it was typed in. And a `prompt` that is an object rather than a string (measured
alongside `imagePasteIds`) must not render, which is what makes the string check a guard rather
than a formality. The remaining refusals are sidechain, foreign session, and an attachment of
another type. One measured line carries no top-level `session_id` at all, so the match is on
`sessionId`. Lock the envelope check: a queued prompt opening with the channel envelope
is dropped with a log line and never posted. Lock ordering: a queued prompt between two assistant
texts posts between them on the thread's chain. Lock the security rendering: a queued prompt
carrying a chip line and a line-leading quote marker arrives escaped inside the operator
attribution, the same pin the mirror path holds. Lock that the post ends a held narration block, so
the next chunk posts fresh below the operator's words rather than appending above them.

### 4. A split run paces itself and lands whole

Model: opus

`postRun` in `broker/routing/outbound.ts` stops truncating on rate limits. Two mechanisms, both
inside the run's existing chained task, driven by an injectable `sleep` on
`OutboundRouterOptions` so tests drive time without waiting. Proactively, consecutive posts of one
run are spaced by a pacing gap, a named constant `RUN_PACE_MS` of 1500ms, no gap before the first
post, which holds a run's send rate under Discord's roughly five-per-five-seconds create bucket so
the budget rarely empties mid-run. Reactively, a post refused as `rate-limited` waits out the
refusal and retries that same message once per refusal: the wait is the outcome's reported
`retryAfterMs`, with a blind 5-second fallback, and every reactive wait accrues against a per-run
cap, a named constant `MAX_RUN_WAIT_MS` of 60 seconds, pacing gaps excluded. The fallback covers
a reported wait of zero or less as well as an absent one, which is what makes the cap reachable in
finite steps: the reported value comes off the wire from a service this process does not control,
and a wait of zero accrues nothing against the cap, so a refusal that kept reporting it would spin
the loop forever. Every reactive wait is therefore positive. A run that exhausts the cap stops and logs exactly the truncation line the runbook names
today. Every non-rate-limited refusal stops the run exactly as today, because those are the
refusals where retrying can double-post or hammer a broken route. The remember-only-when-whole
rules downstream are untouched and simply fire more often: echo digests and coalescing state are
recorded on landed-whole runs, which is what pacing makes the normal case.

The seam this needs in `broker/routing/writer.ts`: the pre-flight budget refusal currently answers
`rate-limited` with a null `retryAfterMs` while the budget privately knows `blockedUntil()`. The
refusal outcome carries the remaining block instead, `max(blockedUntil - now, 0)`, so the router
reads one field for both the pre-flight case and a genuine 429, whose `retryAfterMs` the transport
already forwards. No behavior of `notice`, `alert`, or `edit` changes: the notice floor, the
alert's unpaced immediacy, and the refused-edit fallback are all outside `postRun`, and the
steering writer never enters this router. A paced run holds its thread's chain while it sleeps,
which is intended: later conversation posts for that thread belong after the report they follow.
Broker shutdown mid-sleep drops the run's remainder as any shutdown mid-run does today.

Pacing a run changes what the rest of the system was sized for, and three things still spoke the
old fast-run contract.

The relay's reply timeout is the worst of them, and it is UNRESOLVED: see the Open Question below.
The broker sends no bytes on `/relay/reply` until the run resolves, and the relay destroys a
pending request after a timeout, reporting the reply as failed to the model with no landed count.
At `RUN_PACE_MS`, an 11-message answer passes the original hand-set 15 seconds from pacing alone,
so the model is told its reply failed while the broker is still posting it, and a resend
double-posts everything already landed. That is strictly worse than the truncation this section
removes.

Deriving the timeout from the run's worst case was tried and does not hold. `/relay/reply` does not
wait on its own run alone: `deliver` puts every posting run on the thread's ordering chain, and the
mirror path's chunks enter through the same doorway, so a reply queued behind an in-flight paced
mirror run waits that run's full duration plus its own. Nothing bounds how much is ahead of it, so
no per-run constant can bound the wait. The derived constant is in the tree and it raises the
ceiling, but it is not a fix, and the operator's decision on the Open Question determines what
replaces it.

A wait that is not a finite number, or merely an enormous one, never terminates and poisons what it
touches. A `NaN` makes the cap test false forever, `sleep` fire immediately, and
`Budget.blockedUntil` compare false forever; a finite `1e30` wedges the same bucket with no overflow
at all. That is the severe one, because the writer's post budget is spent by the steering path's
permission alerts, so one such observation drops every alert for the process lifetime with no
self-heal: `withBudget` returns before the call, so no headers are ever observed again and the
clearing branch is unreachable. The clamp therefore bounds magnitude as well as kind, and lands on
every arm that can produce a wait, with the finiteness reading taken AFTER the seconds-to-
milliseconds multiplication rather than before it, since a `retry_after` of `1e306` is finite at the
check and infinite after the multiply. The writer's own pre-flight refusal is a second producer that
the transport's clamp never sees, computing its wait from `blockedUntil`, so it shares the clamp.
The run loop's finiteness check remains as defense in depth against a producer added later.

A very small positive wait is a request storm. The cap accrued what a wait asked for, so a refusal
reporting a sliver of a millisecond passed the blind fallback, lapsed its budget block within the
timer's own floor, and issued a real post per millisecond indefinitely. Two changes close it: a
named `MIN_REACTIVE_WAIT_MS` floor of 1 second, which is the shortest wait that can change the
answer given the create bucket refills over seconds, and accrual of elapsed time rather than
requested time, which turns the cap into a bound on attempt count as well as duration.

The cap bounds reactive waiting only. Pacing holds the thread's ordering chain for as long as the
run is long, with no constant bounding it, so a body near the mirror route's ceiling paces for
minutes and the operator's own queued prompt lands after the report. That is accepted rather than
fixed, because bounding total run duration reintroduces truncation; what changed is that the
comment now states it instead of claiming a bound the code does not have.

Files: `broker/routing/outbound.ts`, `broker/routing/writer.ts`,
`broker/routing/outbound.test.ts`, `broker/routing/writer.test.ts`, and, for the contracts pacing
broke, `broker/config.ts`, `broker/config.test.ts`, `broker/discord/adapter.ts`,
`broker/discord/adapter.test.ts`, `broker/discord/rest.ts`, `broker/routing/http.ts`,
`broker/tail.ts`, `relay/broker.ts`, `relay/broker.test.ts`.

Acceptance: `npm test` green.

Tests: lock the regression, red first: a run whose Nth post is refused rate-limited resumes after
the reported wait and lands all M messages, and the caller's result reports the run whole. Lock
the pacing in both directions: a multi-message run sleeps `RUN_PACE_MS` between consecutive posts
and a single-message run never sleeps. Lock the cap in both directions: reactive waits under the
cap keep the run alive; waits that would exceed it stop the run with today's truncation log line;
pacing gaps do not accrue against the cap. Lock the unchanged stop: a `failed` refusal mid-run
stops immediately with no sleep and no retry. Lock the writer seam in both directions: a
pre-flight refusal reports the remaining block in `retryAfterMs`, and an affordable bucket still
posts untouched. Lock the interplay with Section 1: a run that paced through a reactive wait still
remembers its coalescing state when nothing newer than its final message arrived, and still
refuses when something did.

### 5. The docs carry the fidelity surface

Model: session
Locus: inline

`docs/architecture.md` describes narration coalescing's freshness by snowflake high-water, the
allow-time baseline, queued-prompt mirroring as the second prompt path, and paced delivery.
`docs/operations.md` tells the operator how a thread reads now: a long reply arrives over seconds
rather than truncating, the first turn narrates from its opening chunk, a mid-turn typed message
appears in the thread, and the runbook's `stopped after N of M messages: rate limited`
discriminator is rewritten to mean what it means now, the pacing cap tripped or a genuinely
wedged bucket, both rare. `docs/security-model.md` adds the queued-prompt extraction to the
transcript-reading surface: the same untrusted class, the same single rendering machinery, the
envelope check on both prompt paths, and the unchanged property that a -NoMirror session's
transcript is never opened. Four specific claims there go stale the moment Section 3 ships, and
each is named rather than left to a general sweep: the tailer no longer only "posts the assistant
text blocks it finds"; the sentence that the operator-attributed quoted block is the one
attribution content cannot draw stays true of the renderer but now sits beside a path where the
broker awards that attribution to text read off a file, so it needs the qualifier; the data-egress
enumeration lists hook-carried console prompts and final replies, and mid-turn queued prompts read
from disk are a new class crossing to Discord's servers; and the accepted-risk bullets speak only
of mid-turn prose where they now cover operator-attributed prompts. The accepted-risk list also
gains the provenance point directly: attribution on this path rests on the transcript file's
contents, so anything running as the operator that can append a `queued_command` line with
`origin.kind` `human` to a live session's transcript puts words in the operator's mouth in the
channel where approvals are answered. That is the same wall the model already documents a token
holder standing behind, and this is a third door through it rather than a new capability, but
"unforgeable" must not be left carrying a meaning it does not have for this path. `docs/operator-checks.md` extends check F into the full side-by-side
fidelity watch this plan's Operator Verification describes, and `docs/README.md`'s operator-checks
row follows. Inline because implementer subagents cannot write under `docs/` in this harness.

Files: `docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`,
`docs/operator-checks.md`, `docs/README.md`.

Acceptance: no doc still claims runs truncate on rate limits as normal behavior, that narration
coalescing's freshness rests on a bare invalidation count, or that the mirror path is the only way
operator prompts reach a thread; the security model names the queued-prompt extraction and its
trust argument.

## Related

Amends the freshness contract of
[`channels_narration-coalescing_spec_v1.md`](../archive/plans/channels_narration-coalescing_spec_v1.md)
(Section 1 here replaces the clock-only remember refusal whose own-echo residue that plan's
Chapter 3 accepted as rare and the first live run measured as dominant). Extends the tailer of
[`interim-mirroring_spec_v1.md`](../archive/plans/interim-mirroring_spec_v1.md) (Sections 2 and 3)
and the split-run delivery of
[`channel-mirroring_spec_v1.md`](../archive/plans/channel-mirroring_spec_v1.md) and
[`channel-quality-and-plugin_spec_v1.md`](../archive/plans/channel-quality-and-plugin_spec_v1.md)
(Section 4). The EchoMemory dedup contract of
[`channels_reply-dedup-and-repair_spec_v1.md`](../archive/plans/channels_reply-dedup-and-repair_spec_v1.md)
is untouched.

## Out of Scope

- Retrying any refusal other than rate-limited, and any retry of a refused edit.
- Pacing or retrying notices, alerts, card edits, or renames; the steering and surface writers
  keep their drop-not-queue behavior.
- Mirroring queued commands whose `commandMode` is not `prompt` (slash commands, shell lines).
- Listening to MESSAGE_UPDATE or any new gateway intent, and per-edit freshness GETs.
- Changing the tailer's poll cadence, chunking, or the EchoMemory contract.
- Solving the hook-payload size-cap drops on `/hook` (PostToolUse liveness posts over the body
  ceiling cost a status-card tick by design; unrelated to conversation fidelity).

## Operator Verification

One side-by-side session per host (SCOTT and NEO both restarted onto this code), console beside
thread, one long turn, which is operator check F in its extended form:

- The turn's first narration chunk appears in the thread; narration accumulates in one growing
  message under one header.
- A message typed at the console mid-turn appears in the thread as an operator-attributed quote,
  in order, and the next narration chunk starts a fresh message below it.
- A reply long enough to split into six or more messages lands whole, checked against the console
  copy section by section, arriving over seconds rather than truncating.
- Narration sitting above your typed message more than momentarily, a missing chunk, a missing
  queued prompt, or a report that still ends early reopens the work.

## Open Questions

- **OPEN, blocking Section 4's close: how should the reply tool learn that a paced run is still
  going?** Pacing makes a long reply outlive any fixed reply timeout, and the failure is a
  double-post rather than a truncation, which is worse than the problem this section fixes. Timing
  arithmetic cannot solve it, because the reply waits on a per-thread ordering chain whose backlog
  nothing bounds. Three candidates, none yet built: the broker sends an early byte on the reply
  response so the relay's idle timer measures broker liveness rather than run length, which makes
  the timeout question disappear; or the relay distinguishes a timeout from a failure, so the model
  is told the answer is already going up and must not be resent; or the reply route answers
  immediately the way the mirror path's intake already does, trading the landed count for
  certainty. The derived-constant approach in the tree is a stopgap that raises the ceiling without
  closing the hole.

- Answered 2026-08-08, by measurement over this project's own 41 transcripts. The operator's own
  channel message is recorded as a `queued_command`, but under `origin.kind` `channel`, carrying
  `origin.server` and `isMeta`, never under `human`. Section 3's allowlist requires `human`, so a
  channel-steered message structurally never mirrors, which is the wanted answer: the operator
  typed it in the thread, so the thread already shows it. The envelope check stays as
  belt-and-braces against a future build recording it differently, rather than as the primary
  defense it was written to be.

  `origin.kind` is not a two-member set. A third value, `auto-continuation`, appears in the wider
  transcript corpus on this machine though not in this project's own 41 files, and the allowlist
  refuses it correctly by requiring `human`. The set is open, because the format belongs to another
  program: what the allowlist admits is one named value, never everything outside a list of known
  bad ones.

## Chapters

### Chapter 1 - 2026-08-07
Completed: 1. Router freshness judges arrivals by snowflake, not by count
Implemented By: implementer-fable
Metrics: 1 review round; 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The spec's "the high-water mark needs no clearing for correctness, only
bounding for memory" hid a fork the implementation had to resolve: `capBeside` evicting a mark
fails in the opposite direction from evicting a state or clock entry. A dropped state entry costs
one attribution header, while a dropped mark makes the remember gate read the thread as having
seen nothing newer, so a run posted around a foreign message would be remembered above it, in the
channel permission approvals are answered in. The first implementation documented that asymmetry
and shipped it as accepted; both reviewers independently rated it Major with the same one-line
fix, and it now bumps the evicted thread's ID-less clock, which converts the failure to one fresh
header. The spec's Approach paragraph carries the amended contract. Two hazards were briefed up
front and both proved load-bearing: the mark is a monotonic max rather than a blind overwrite
(out-of-order gateway echoes would otherwise lower it below a foreign message and permit the
remember), and the falsified comment claim at the shared cap constant was swept.
Review Findings: 1 Major from each reviewer, the same one (permissive mark eviction), fixed with a
red-first probe: with the clock bump removed the new eviction test fails, with it restored it
passes. 3 Minors, all fixed: the invalidations-map comment omitted the held-entry clear from its
list of bumpers; the run's own posted IDs did not raise the mark, so the mark's stated contract
held only of echoes; the bounded-map test pinned only the refusal direction, so a regression
refusing on any held mark would have stayed green (a permits-direction test now pins it). Two test
names carrying change-narrative phrasing were reworded to state the property.
Stamps: adjudicated 3, stamped 1 (`a-brokers-own-gateway-echo-races-ahead-of-its-rest-response`,
which is the root cause this section fixes; the transcript-shape and rate-bucket records were read
as forward reading for Sections 2 to 4 and steered nothing here).
Next: 2. The tailer baselines at the mirror-on verdict, not the next poll tick
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-08
Completed: 2. The tailer baselines at the mirror-on verdict, not the next poll tick
Implemented By: implementer-sonnet (an earlier session left the section built but uncommitted,
unreviewed, and unchaptered; this session gated it, ran two review rounds, and dispatched
implementer-sonnet twice to address findings)
Metrics: 2 review rounds; 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The section as found in the tree was materially larger than the section as
specified, and three of the four additions were right. `learn` fires the baseline probe as well as
`allow`, which the spec's "allow is the only new probe trigger" forbade but the ordering demands:
the mirror-on verdict and the hook post that teaches the path arrive on independent routes, so an
allow-before-learn session would otherwise wait for the next tick and lose the very chunk the
section exists to save. `poll` drains the probes outstanding after its pass. And `suppress` drops
the held offset, which is a contract change to a function the section does not name: it closes a
pre-existing privacy leak, proved real by a test that is red at Chapter 1's commit, where a
re-allow resumed from before the mirror-off window and published everything written during it.
Kept rather than reverted, because reverting restores the leak; the spec's Section 2 now carries
all three, and the widened scope is the deliberate deviation this Chapter records.

The baseline this section was measured against is Chapter 1's commit, not the tree as found: the
first `npm test` run of the session was already post-change and proved nothing about regressions.
A clean worktree at ba8ab34 gave the real numbers, 624 tests / 623 pass / 0 fail / 1 skipped, and
doubled as the red state: 7 of the 11 tests found in the tree fail there, the headline
first-turn-narration pin among them, so the section's regression tests genuinely discriminate. The
skip is pre-existing. Final gate is 641 / 640 / 0 fail / 1 skipped, lint clean.
Review Findings: Round one returned CHANGES_REQUIRED from the adversarial and blind reviewers and
BLOCK from the security reviewer, all three landing independently on the same Critical: a baseline
probe dispatched before a `suppress` and resolving after a later `allow` passed every clause of its
own validity check, because a re-allow restores `allowed` and a relearn restores `path`, so it
wrote its pre-suppression size and the next pass published the entire mirror-off window. The blind
and security reviewers each found a second Critical the adversarial one missed: `pollOne` wrote
back to `held.offset` after its awaits with no re-validation, where `held.offset += lastNewline + 1`
against an offset `suppress` had nulled evaluates `null + n` to `n`, silently converting an absolute
file position into a slice-relative one, with both the shrink guard (`size < null` is false) and
the overrun guard (`size - null` is `size`) passing it through. `tsc --noEmit` cannot see this: the
`=== null` narrowing survives the await, so lint stayed green over it.

The fix is a per-entry epoch counter, bumped by `suppress`, `forget`, and `learn` on a path change,
captured at dispatch and re-checked at every write-back, with `pollOne` re-validating after all
four of its awaits. Confirmed load-bearing by a single-knob probe run in an isolated worktree:
deleting only the `held.epoch === epoch` clause turns exactly the two leak tests red, and one of
those pins on bytes read rather than on messages posted, so it cannot be satisfied by a read that
happened and yielded nothing. Round two returned no Criticals from any lens, and all three
independently confirmed both classes closed.

Round two's Majors were all fixed rather than justified: the probe drain moved into a `finally`, so
a rejecting pass still drains instead of settling with file handles open, and it is bounded to two
snapshot rounds rather than looping while the set is non-empty, so a re-arming probe can no longer
hold `running` non-null and halt narration for every session. `stillValid` gained
`held.probe === pending`, free and self-sufficient. The rest were falsified comment claims, which
this codebase treats as defects in their own right, including a closed enumeration of the epoch's
bumpers that omitted `forget`, a `liveSessions` doc calling the probe an immediate open when the
code defers it a microtask deliberately, and a `poll` doc claiming shutdown awaits every read in
flight when the broker awaits the last completed pass. Two mechanisms whose deletion left the suite
green now have red-first tests: the probe drain, and the guard that stops a batch mid-delivery when
the operator throws the mirror-off switch.

Two claims are corrected rather than asserted. Whether a mid-session suppress and re-allow is
reachable in production is disputed between rounds, so the comment now says the guard does not
depend on how the two signals interleave rather than claiming a reachable window. And the spec's
own Tests paragraph, written this session, claimed all four epoch locks pin on bytes; only one
does, and the sentence now says so.
Stamps: adjudicated 5, stamped 3. The two `memq unstamped` surfaced
(`discord-edit-and-create-are-separate-rate-buckets`,
`claude-code-transcript-jsonl-shape`) are forward reading for Sections 3 and 4 and steered nothing
here, so neither was stamped. Three that steered this section reached it through the recall digest
rather than a file read, so they never entered the unstamped list:
`a-switch-that-suppresses-a-post-fails-differently-from-one-that-gates-a-read` is why the
suppressed-window property is pinned on reads rather than on posts;
`two-components-agreeing-is-not-two-checks` named the round-one Critical's exact shape, a test that
inserted a scheduling boundary to serialize away the ordering that breaks the code; and
`a-comment-that-names-a-property-is-a-claim-to-sweep` rode in every reviewer brief and generated a
large share of the findings.
Next: 3. Queued mid-turn prompts mirror through the tailer
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-08
Completed: 3. Queued mid-turn prompts mirror through the tailer
Implemented By: implementer-opus, with implementer-sonnet for the review Minors
Metrics: 1 review round; 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The section's allowlist was specified from an unobserved format, so it was
measured before anyone was briefed on it: all 41 of this project's transcripts, 136 lines whose
`attachment.type` is `queued_command`. That measurement answered this plan's Open Question and
changed what the section had to defend against. The operator's own channel message is recorded, but
under `origin.kind` `channel` with `origin.server` and `isMeta`, so requiring `human` structurally
prevents it echoing back into the thread it was typed in, and the envelope check becomes
belt-and-braces rather than the primary defense it was written to be. Two shapes the spec never
mentioned turned out to matter more than the ones it did: 118 of the 136 lines are `commandMode`
`task-notification`, machine-written background-task notices that would have filled the thread, and
one line carries `prompt` as an object beside `imagePasteIds`, which is what makes the string check
a guard rather than a formality. The security reviewer independently re-ran the measurement and
matched the counts, differing by two lines because the corpus had grown since.

The Standing Brief Amendments block was added to this plan in this section, under the recurrence
rule: falsified comment claims had by then surfaced in both Section 1's and Section 2's reviews, so
the guard now rides in every later dispatch rather than in whichever brief happened to carry it.
Review Findings: No Criticals from any lens. The adversarial reviewer returned APPROVED, the blind
reviewer APPROVED_WITH_CONCERNS, the security reviewer CONCERNS.

Two of the blind reviewer's Majors were rejected with receipts rather than fixed, both rated low
confidence by the reviewer itself and both contradicted by the security reviewer's own measurement
over the live corpus. The first predicted a turn-boundary double post, where a message queued near
turn end is flushed as the next turn's real prompt and mirrors through the hook path while the
tailer independently posts its attachment line; measurement found 15 of 16 human queued prompts
appear nowhere as a `user` line, and the single match is the operator genuinely typing the same
text twice. The second predicted that writer and verifier share a premise about `sessionId` being
present on attachment lines, so the feature could be silently dead with a green suite; measurement
found all 9 publishable lines carry a string `sessionId` equal to their own transcript's stem, zero
missing. Adding the suggested echo-digest guard would also have crossed this plan's Out of Scope
line on the EchoMemory contract. Recorded here so neither is re-litigated.

Everything else was fixed. The blind reviewer's Minor on the envelope check is real and narrow: on
the queued-prompt path the tailer already admits only `human` origin, so a channel injection never
reaches that check and its only reachable effect there is a false positive that drops the
operator's only thread copy of a message opening with the marker text. The check stays as
belt-and-braces; the comment now names both consumers and their opposite fail directions. Comments
naming `assistantTexts` after the rename to `lineItems` were swept, and the claim that queued slash
and shell commands yield nothing was softened to what the code actually enforces, since no such
line was observed and the refusal was asserted rather than demonstrated.

The adversarial reviewer's Minor on an untested guard turned out to be a class rather than an
instance. The `typeof origin !== "object"` check had no isolating fixture, because the only
origin-less fixture also failed the earlier `commandMode` check, and its removal would have turned
a refusal into a property read on `undefined` that throws out of the allowlist's yield-nothing
contract. Auditing for siblings found the `attachment`-is-object and `message`-is-object guards
masked identically: every fixture reaching those branches supplied a well-formed object. All three
now have isolating tests proven red by deletion, each also asserting no failure log line, so a
silently caught throw cannot pass them. Two guards one level deeper are noted as still masked and
were left, as past the minimum a Minor earns.

The security reviewer's one Major is that `docs/security-model.md` ships four claims this section
falsifies. That is Section 5's work by design rather than a defect here, and Section 5's text now
names all four specifically plus the provenance point, so it cannot be satisfied by a general
sweep. My own spec text also carried the closed-enumeration defect the Standing Brief Amendments
name: it presented `origin.kind` as a two-member set, and `auto-continuation` exists in the wider
corpus. Corrected.

One harness note: the reviewers' reports tripped the instruction-shaped-pattern filter, because
the channel-envelope fixtures they quote look like control tags. The neutralized text was read as
findings, never as instructions.
Stamps: adjudicated 2, stamped 1. `claude-code-transcript-jsonl-shape` steered this section
directly, naming `sessionId` rather than `session_id` as the field to match on and establishing why
the extraction is an allowlist; it was also extended with the measured `queued_command` population
so the next session inherits the distribution instead of re-measuring.
`discord-edit-and-create-are-separate-rate-buckets` is forward reading for Section 4 and steered
nothing here.
Next: 4. A split run paces itself and lands whole
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-08
Completed: nothing; 4. A split run paces itself and lands whole is BLOCKED on an operator decision
Implemented By: implementer-opus, three rounds
Metrics: 2 review rounds; 0 NEEDS_CONTEXT; 0 tier escalations (see the comparison below); advisor
opus
Decisions / Surprises: The section builds and its own behavior is right. What it broke is
everything that was sized for a fast run, and that is where both review rounds landed.

Round one returned three Criticals from two lenses. The per-run wait cap accrued what a wait ASKED
for rather than what it COST, so a 429 reporting a sliver of a millisecond passed the blind
fallback, lapsed its budget block inside the timer's own floor, and issued a real post per
millisecond indefinitely. A non-finite wait on the unclamped discord.js path made the cap
unreachable, spun the loop, and set `blockedUntil` to `NaN`, which compares false forever; because
the post budget is the one the steering path's permission alerts spend, that single observation
would have dropped every alert for the process lifetime with no self-heal. And the paced run
outlives the relay's reply timeout, so the model is told its reply failed while the broker is still
posting, and a resend double-posts everything already landed.

That last one is the section's real lesson, and it is the doctrine's own rule about naming what
still speaks the old contract. Nothing in the diff was wrong in isolation. The defect lived
entirely in the relationship between two constants in two different processes that had only ever
been coincidentally ordered, and no test pinned the relation because each side was tested against
its own literal.

Round two closed the accrual Critical outright, confirmed by both lenses: the wait is floored at a
named minimum and the cap now accrues elapsed time, which bounds attempt count as well as duration
even against a clock that does not advance. The wire-value Critical came back, same class and a
different site: the clamp had been applied to two arms but not the primary HTTP 429 arm, and it
bounded kind rather than magnitude, so a finite `1e30` wedged the bucket with no overflow at all,
and the finiteness reading sat before the seconds-to-milliseconds multiply where a `1e306` header is
still finite. That is now clamped for magnitude on every arm, after the multiply, with the writer's
own pre-flight refusal sharing the clamp because it manufactures a wait from `blockedUntil` and the
transport's clamp never sees it. The pin is on the operation rather than the output: each hostile
value is folded into a real budget and the bucket is asserted still affordable, which is the
property that keeps permission alerts alive.

The tier-escalation comparison, run before deciding not to spend a bump. The wire-value class
repeats across both rounds, which is the signal that says the tier is the lever. The relay-timeout
Critical does not: it survived because the premise in the dispatch brief was wrong, not because the
implementer missed anything. The brief prescribed deriving the reply timeout from the run's worst
case, and both round-two lenses independently showed that no per-run constant can work, because
`/relay/reply` waits on the thread's ordering chain and the backlog ahead of it is unbounded. A
stronger implementer cannot fix a brief that is itself wrong, so the section is raised as a
decision rather than re-dispatched. The derived constant stays in the tree as a stopgap that raises
the ceiling without closing the hole, and the Open Question names the three candidate fixes.

Two further open items are recorded rather than fixed. `CHANNEL_MAX_BODY_BYTES` is operator-settable
with no maximum while the derived ceiling reads the default, and the relay cannot see the broker's
env, so raising that knob re-opens the double-post with no runtime signal. And a reviewer showed the
2x headroom is exhausted by a single default-cap body of escape-heavy prose, since the renderer
escapes every angle bracket before splitting. Both are subsumed by the Open Question: no headroom
factor survives an unbounded queue.

One reviewer rationale was falsified rather than accepted. The claim that writing to a destroyed
socket throws, and so risks an unhandled rejection inside the catch, did not reproduce: a probe on
Node 24.19.0 with a destroyed `ServerResponse` showed no synchronous throw and no unhandled error.
The guard was kept as directed because it makes both paths read alike, but no test was written for
it, because a test that passes with and without the guard earns nothing. The comment the section had
shipped asserting the throw was corrected.

Out of scope by the operator's own Out of Scope line, and left alone: `alert` has no retry, so
mirror contention on the shared per-channel post bucket can drop a permission alert and park the
session. Pacing makes the mirror path push where it used to stop, so this is a real degradation
rather than a theoretical one, and it is raised to the operator alongside the blocking question.
Review Findings: Round one, 3 Criticals across two lenses, all addressed. Round two, 2 Criticals
(one class repeating, one new site of it), addressed; 5 Majors, of which the relay timeout and its
two corollaries are the blocking Open Question, one was a claim-accuracy fix to this spec's own
text, and one is the accepted pacing chain-hold now stated rather than denied. Minors fixed: the
permission route had inherited a timeout derived for replies and now has its own; the error path
gained the guard the success path had; several comments asserting properties the code lacks were
swept, including a closed enumeration missing its third member. Left: `transport.ts` documents
`retryAfterMs` as null unless refused for rate limiting, which the writer's pre-flight refusal made
imprecise, and the file was outside the fix scope.
Stamps: adjudicated 1, stamped 1. `discord-edit-and-create-are-separate-rate-buckets` steered the
writer seam directly: it is why the pre-flight refusal reads `blockedUntil` off the per-verb budget
the verb actually spends rather than a merged one, and both reviewers confirmed the two buckets stay
separate on both the check and the report.
Next: 4 is blocked pending the operator's answer on the reply-timeout Open Question; 5. The docs
carry the fidelity surface follows it, since the runbook text depends on what 4 finally does.
Commit Model: Commit-and-Push, deviated deliberately: this round is committed to the branch
`section-4-pacing` rather than to main, because main should not carry a pacing change whose known
open defect is a double-posted reply. Merging is the operator's call once the Open Question is
answered.
