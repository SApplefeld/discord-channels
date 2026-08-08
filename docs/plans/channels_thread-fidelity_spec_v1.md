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

`allow` in `broker/tail.ts` gains the baseline probe. When it flips a session that has a learned
path and no held offset, it starts the same zero-byte size probe `pollOne` performs today
(`read(path, 0, 0)`) and holds the pending promise on the entry; the probe's resolution sets the
offset to the observed size only when the entry still holds the same path and the offset is still
unset, and a rejection is swallowed so the poll-time fallback covers it. `pollOne` awaits a pending
probe before its own null-offset branch, which remains as the fallback for a session whose allow
arrived pathless or whose probe failed. A second allow while a probe is pending starts nothing new.
`forget` guards apply: a probe resolving after its session was dropped writes nothing. The
`-NoMirror` property is preserved structurally: allow is the only new probe trigger, a suppressed
session never receives one, and so its transcript is still never opened, not even for a stat.

Files: `broker/tail.ts`, `broker/tail.test.ts`.

Acceptance: `npm test` green.

Tests: lock the regression, red first: text appended to the transcript after the allow signal but
before the first poll pass is delivered as narration, which is exactly the first-turn opening chunk
that vanishes today. Lock the fail-closed direction: a session that is learned but never allowed
gets zero reads of any kind, probe included, asserted on the injected `readFile`'s call count. Lock
the staleness guards: a path relearned between the probe starting and resolving discards the stale
size; a probe rejection falls back to the poll-time baseline without republishing anything older
than the fallback's own observation. Lock that a second allow during a pending probe does not
double-probe.

### 3. Queued mid-turn prompts mirror through the tailer

Model: opus

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

Tests: lock the allowlist in both directions: the observed live shape yields the prompt (fixture
matching the transcript line measured on 2026-08-08, `attachment.type` `queued_command`,
`commandMode` `prompt`, `origin.kind` `human`), and each single-field deviation (sidechain, foreign
session, `origin.kind` not `human`, `commandMode` not `prompt`, attachment of another type, empty
prompt) yields nothing. Lock the envelope check: a queued prompt opening with the channel envelope
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
`retryAfterMs`, with a blind 5-second fallback when the outcome carries none, and every reactive
wait accrues against a per-run cap, a named constant `MAX_RUN_WAIT_MS` of 60 seconds, pacing gaps
excluded. A run that exhausts the cap stops and logs exactly the truncation line the runbook names
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

Files: `broker/routing/outbound.ts`, `broker/routing/writer.ts`,
`broker/routing/outbound.test.ts`, `broker/routing/writer.test.ts`.

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
transcript is never opened. `docs/operator-checks.md` extends check F into the full side-by-side
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

- Whether the operator's own channel message, injected mid-turn, is recorded as a
  `queued_command` attachment with `origin.kind` `human` (and is therefore seen by Section 3's
  extraction) is unobserved; the envelope check makes both answers safe, and the first live
  channel-steered turn after this ships is the observation. If it surfaces under a different
  `origin.kind`, nothing mirrors and nothing breaks.

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
