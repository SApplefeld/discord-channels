# Channels: the usage and fleet-health card

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: fable-tier sections and the reviewer bumps, dispatched with the explicit override from this Opus-led session; overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](../archive/plans/channels_question-answering_spec_v1.md):
  a concurrent round, landed and archived.
- [channels_mirror-fidelity-repairs_spec_v1.md](channels_mirror-fidelity-repairs_spec_v1.md): the
  other concurrent round, which redrew the cards this plan's Sections 3 and 4 write into.

All three rounds write `broker/discord/render.ts` as well as `broker/index.ts`, so their commits
interleave on one branch and no section here can be read against the card alone.

## Goal

Away from the keyboard, the operator can see what the console sees. Two surfaces carry it. One
always-there Discord thread ("Fleet: Usage") holds a card the broker edits on a cadence, carrying
each account's 5h / 7d / per-model usage bars with reset times and pace, and one line per live
session on this host (name, state, minutes since last activity). Each session's own status card
gains what makes a long quiet stretch legible: the model actually running (with a standing marker
when a session was forced below the model it opened with), the raw context size, and the subagents
the session is waiting on. The blindness this removes is recorded operator pain: rate limits,
silent model downgrades, and a session that looks idle while it is running four agents are all
invisible from Discord until a walk back to the console.

## The measured ground (scouted 2026-08-09, file:line evidence in the scout report)

- claude-swap (v0.24.1, a Python uv tool) maintains `%USERPROFILE%\.claude-swap-backup\cache\usage.json`:
  per-account `lastGood` blocks with snake_case `five_hour` / `seven_day` / `spend` / `scoped[]`
  (each `pct`, `resets_at`, `countdown`, `clock`), plus freshness (`fetchedAt`, `nextPollAt`) and
  failure fields (`consecutiveFailures`, `lastError`, `backoffUntil`). Reading it costs no
  network, no auth, and no mutation. Sub-keys can be missing per account (observed live); the
  reader tolerates absence everywhere.
- `cswap list --json` is the documented contract (schemaVersion 1) but is NOT read-only: a stale,
  poll-due entry triggers a live fetch, cache rewrite, and possibly an OAuth token refresh. The
  upstream endpoint allows roughly 28-30 requests per rolling hour per account token, shared
  uncoordinated across every machine and consumer; claude-swap self-budgets to ~20/hour.
- Account identity for display comes from `sequence.json` beside the cache (email, organization
  name, active slot).
- The credentials directory beside these files holds base64-encoded plaintext OAuth material;
  nothing in this effort reads it, and the reader never opens any file but `cache\usage.json`
  and `sequence.json`.

## Approach

**Mirror, never poll.** The broker reads the two local files on its own timer and renders; it
never invokes claude-swap and never touches the network for usage. Freshness is displayed, not
manufactured: the card carries "as of <age>" per account from `fetchedAt`, and a `lastError` /
`backoffUntil` state renders as a warning line.

One transform is applied rather than mirrored, and it serves that same rule (decided 2026-08-09,
where the two rules below collided): a weekly or per-model window whose reset instant has passed
is rolled forward to its current period, the way claude-swap's own console does, rather than
rendering the last-written percentage against a boundary that is gone. The reset instant is a fact
the cache itself wrote, so applying it reads what the data says rather than inventing anything,
and the alternative fails in the expensive direction, telling the operator they are out of
headroom against a window that has actually reset. A rolled window is showing its new period, not
the last write, which is why the card says so in its own prose: a reader comparing the card to the
cache file would otherwise find numbers that are not in it. A reading whose fetch time is not
believable rolls nothing. When every other claude-swap consumer is off and
the cache goes stale, the card says so; active polling is a later round if staleness proves
common (decided 2026-08-09: passive-first risks nothing).

**One card thread, edits only.** The broker owns one thread named "Fleet: Usage" in the
configured channel, created (or re-bound from state, surviving restarts the way session threads
do) at startup when the feature is on. The card is the thread's first message, edited in place.
No renames after creation (renames are the scarce resource), no mentions ever, and an edit posts
only when the rendered card's content actually changed (byte compare against the last rendered
body), so a quiet fleet costs zero Discord calls. Edits ride an edit budget the way the existing
writers do.

**Sections of the card:**
1. Per account (ordered as `sequence.json`): active marker, email or alias, then one line per
   window: `5h 46% · resets 3h 44m`, `7d 56% · resets 4d 6h · ahead of pace` (the space between the
   two units is the operator's own request, made for readability on a phone), per-model scoped rows
   (Fable) the same way, spend when present. Percent bars as text (the repo's aesthetic: compact
   lines, no embeds). Over-threshold (>= 90%) values carry a warning glyph.
2. Per live session on this host, from the registry: `⚙ CHNL: Answering · working · 2m` (name,
   state, age of last hook activity), ended sessions omitted. This section is registry-read only.
3. A footer: card refresh age and the interim-off / feature-off coupling note where relevant.

**Config:** one knob to enable (`CHANNEL_USAGE_CARD`, default off; on for SCOTT at deploy), a
cache-path override for non-standard installs, and a refresh interval (default 60s, bounded).
All follow `broker/config.ts` sibling patterns. Content discipline: the card carries usage
numbers and session names the threads already display; no question content, no tokens, and the
reader extracts by field allowlist (never re-serializes unknown cache content into Discord).

## Sections of Work

### 1. The cache reader and card renderer

Model: opus

`broker/usage/cache.ts` (new): bounded reader for `usage.json` + `sequence.json`, field
allowlist, absence-tolerant, byte-capped file reads, never throws (a malformed cache renders as
"usage unavailable"). `broker/usage/card.ts` (new): pure renderer from the reader's shape plus a
registry snapshot to one bounded message body. Tests mirror sibling reader/renderer test files;
fixtures cover the observed missing-key cases (an account with `pct` only, an account with no
`spend`), a stale cache, a `lastError` account, and hostile strings in emails/aliases (rendered
inert with the existing helpers).

### 2. The card thread lifecycle and wiring

Model: opus

Thread create-or-rebind at startup under the knob (persisted in the broker's state file beside
session bindings), the refresh timer, change-detection before edit, its own edit budget
instance, wiring in `broker/index.ts`. A Discord-less or knob-off broker constructs none of it.
Tests: rebind-over-restart from state, no-edit-when-unchanged, budget refusal handling (skip,
retry next tick), knob-off inertness both directions.

### 3. The session card's model and context line

Model: opus

The per-session status card (the thread's own first message, not the fleet card) gains one line
carrying the session's live model and raw context size, read from the transcript lines the tailer
already polls: `message.model`, and `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` from `message.usage` (both measured; see the
`transcript-lines-carry-model-and-context-size` memory). Rendered raw, never as a percentage: the
1M window is a per-model fact that can change upstream without notice, and the raw count needs no
denominator to be honest.

**A downgrade is read, not inferred, and there are two of them.** A mid-session model change
writes a `system` line whose subtype names the cause (measured; see the
`a-model-downgrade-writes-a-structured-transcript-record` memory), with a matching `fallback`
content block on the assistant line at the transition. `model_refusal_fallback` is the safeguard
path: `originalModel`, `fallbackModel`, `apiRefusalCategory` (measured `cyber`),
`retractedMessageUuids`, `scope: "session"`, and the console's own warning prose.
`model_consent_fallback` is the entitlement path, fired when the session's model requires usage
credits: `originalModel`, `fallbackModel` (measured `claude-opus-5[1m]`, so a model string is not
always a bare id), `choice` (measured `cancelled`), and `persistedAsDefault`, with no `scope` or
category at all. The tailer's line reader gains this shape as a fourth allowlisted yield and must
handle both subtypes; a reader keying only on the refusal record's fields misses the entitlement
downgrade entirely, which is the one an operator can act on. Nothing is guessed: the report names
what upstream named and no more.

**It is a state, because upstream says so.** The refusal record carries `scope: "session"`, the
machine-readable form of the operator's observation that a downgraded session stays downgraded
until it is switched back by hand; the entitlement downgrade behaves the same way and says so in
its prose ("for this session"). The cost is duration rather than the instant: an oversight
thread that drops model at hour one runs degraded for every hour after. So the session record
keeps the model first seen for the session beside the current one, and while they differ the card
carries a standing marker (`⚠ claude-opus-4-8, down from claude-fable-5 · flagged cyber`) rather
than a field that reads normal at a glance. Returning to the opening model clears the marker,
which is how the operator confirms from the thread that a manual switch-back took effect.

Direction is distinguished by a fixed rank (fable, opus, sonnet, haiku), compared on the model
family rather than the exact string, since a fallback model can arrive decorated
(`claude-opus-5[1m]`). A downgrade carries the marker, an upgrade renders plainly and clears it.
Both forced paths are downward from Fable, so the upward direction is the operator's own action
and needs no alarm.

**The entitlement downgrade names the action that reverses it.** Its `choice` field distinguishes
a consent the operator accepted from one that was dismissed, and a dismissed consent means a
standing authorization to spend credits has not taken effect: the session runs on the fallback
until someone consents at the console. That is the one downgrade an operator away from the keyboard
can actually act on, so its message says what to do rather than only what happened.

**The change also posts one message,** on the steering writer's notice tier by default and
switchable to the alert tier (with the operator mention that reaches the phone) by a config knob,
because whether a notice is loud enough on a phone is a question only live use answers, and a knob
makes the upgrade an env change rather than a code round. The message names the two models and the
refusal category, and says the scope is the session, so the operator can judge from the thread
whether to let the work continue or halt it. One message per change, floored the way the notice
tier already floors, and never one per poll. A downgrade whose record the reader cannot parse
still posts the plain model-change message: the fallback shape is upstream's and may move.

Files: `broker/tail.ts` (the extraction, extending the existing line reader by allowlist),
`broker/registry.ts` (the record's opening-model and current-model slots),
`broker/discord/render.ts` (the card line and the change message), `broker/config.ts` (the tier
knob), `broker/index.ts` (wiring), plus tests. The reader stays an allowlist: a line missing
either field renders the card exactly as today, and no new content reaches a log line.

Acceptance: a card for a session whose transcript carries the fields shows model and raw context;
a session missing them renders as today; a session below its opening model carries the marker for
as long as it stays there, and clears it on return; a downgrade whose `model_refusal_fallback`
record parses names its category in both the marker and the message; one whose record is absent or
malformed still posts the plain change message; a change posts exactly one message at the
configured tier; the extraction never throws on a malformed line. Tests lock both directions of
the missing-field case, both directions of the tier knob, the marker's persistence across polls
(not just at the moment of change), the one-message-per-change rule, and the refusal record's
absence path. Fixtures come from the captured specimen's shape, with its untrusted strings
rendered inert like every other transcript-sourced field.

### 4. The subagent roster, and the idle state that is wrong without it

Model: opus

A session whose main thread is waiting on dispatched subagents fires no hooks, so the card's
hook-driven liveness calls it idle at the moment it is most heavily worked. The operator reads
that as nothing happening and waits for an update that is hours away. The roster is both the
missing content and the correction to a state the card currently gets wrong.

**The reading is the harness's own task table** (captured live; see the
`a-sessions-subagent-roster-arrives-in-its-stop-payload` memory). A `Stop` payload carries
`background_tasks`, an array of records with `id`, `type` (`subagent` or `shell`), `status`,
`description`, plus `agent_type` on a subagent and `command` on a shell task. The broker already
receives `Stop` for the conversation mirror, so the roster costs one more field read on a route it
serves today: no transcript reconstruction, no instance scoping, no age bound, and no ghosts,
because the harness reports what it is actually running rather than what was once dispatched.

It arrives at turn end, which is precisely when a session stops producing other signals and starts
looking idle, so the timing matches the need. A record's shell entries are carried too: a
long-running background command is the same class of invisible work.

The roster is stored on the session record and replaced wholesale by each `Stop` (never merged, so
a finished agent cannot survive its own disappearance from the table). Descriptions are
model-authored prose and are rendered inert like every other session-sourced field. A payload with
no `background_tasks` clears the roster, which is what a session that finished its agents reports.

**Concurrency is the normal case.** Measured against a real fan-out session: 50 dispatches over its
life, peak 12 concurrent. The card is sized for a dozen entries rather than patched for them later.

**Ruled out by measurement, recorded so neither is re-litigated.** The process list cannot answer
this: a session is exactly one `claude.exe`, and one with seven outstanding agents shows no
children beyond its own relay pair, because subagents are concurrent loops inside the single
process. The per-agent `<agentId>.output` file under the harness temp path is equally useless as a
liveness signal: it existed from dispatch but stayed 0 bytes for every agent measured, finished and
running alike, with an mtime recording the dispatch rather than any activity. And reconstructing
the roster from transcript dispatch-and-notification events, the approach this section carried
before the `background_tasks` capture, overcounts twice: a restart strands agents whose completions
can never arrive (a real session read 14 outstanding, 7 of them ghosts of a previous instance), and
what remains still cannot distinguish a live agent from a dead one. The transcript reading survives
only as the restart-time fallback, and if it is ever built it needs instance scoping, an age bound,
and the knowledge that pairing a dispatch with its own `tool_result` reports every backgrounded
agent as finished at launch.

**The card** carries a roster line per session while anything is outstanding: the count, then the
entries with description, type, and age, then an overflow count when the bound bites (`⚙ 7 tasks ·
Grooming S6 implementation (implementer-fable) 35m · PR ladder fix round three (implementer-opus)
62m · +5 more`).

The as-built bound is `MAX_ROSTER_ENTRIES = 24`, oldest first, so the overflow count hides the
newest (amended 2026-08-09 in the finishing pass; the section as written said "the newest few" at a
bound the twelve-entry illustration above would have crossed, and the shipped code, which arrived
via the concurrent card redesign, does the opposite). The as-built behavior is the one kept, on the
adversarial reviewer's adjudication and my own: at any fan-out an operator actually sees, all of it
is named, and when the message ceiling does force a cut, the oldest task is the longest-running and
therefore the one most likely stuck, while keeping the oldest also holds each entry in a stable
position as the fan-out grows. It is the same keep-the-oldest policy the channel's pin ceiling
holds. The real working bound is the message ceiling rather than this constant, which is a backstop
against a count another program reports.

The line sits below the turn count and the heartbeat, because a card that runs long is cut from
its end and those are what the card exists to carry. Nothing is rendered when the roster is empty,
and nothing is rendered for a session that has exited, whose roster describes work that no longer
exists.

**The roster survives a restart** (decided 2026-08-09, where two reviewers reached opposite
conclusions). It is persisted with its first-sighting stamps and restored. The ruled-out paragraph
above forbids reconstructing a roster from transcript dispatch events, where ghosts accumulate
because completions can never arrive; this table is authoritative and replaced wholesale at the
next report, so a persisted roster is bounded rather than accumulating. The two failures decide it:
a stale roster after a restart shows visibly old ages and self-corrects at the next report, while
dropping it makes a session read idle for the whole remaining fan-out after a mid-fan-out restart,
which is the defect this section exists to fix, reopened at every restart. Whatever is persisted is
tolerated at field level on load, never validated in a way that could reject the whole snapshot.

**The state vocabulary gains the case.** `working`, `needs you`, `idle`, `exited` cannot express
waiting on agents, which is why the card is wrong today rather than merely thin. A session with an
outstanding roster renders as working with its task count rather than idle, in the thread title
as well as the card, since the title is what survives the mobile thread-list truncation. The
existing states are unchanged for every session with an empty roster.

**The rename damper moves with the count** (corrected 2026-08-09; this paragraph previously claimed
the rename budget was unaffected because the title already changes on state transitions, which is
false and was caught in review). The surface diffs the whole composed title, so a count in the
title makes every count change a rename trigger, while the dwell timer re-stamps only when the
derived state changes: a settled session would rename on every step of a fan-out draining, and a
token holder alternating its reported table would drive one rename per report. The victim is the
same either way, because an urgent `needs you` rename bypasses the dwell but not the budget, so an
exhausted bucket delays the operator's only passive signal that a session is parked. The damper
therefore keys on the rendered name rather than on the state, which coalesces a drain and closes
the same door on a hostile table.

**The limits this surface carries, recorded so they are not read as defects.** A table that is
present but not an array leaves the roster standing, so a token holder can pin its own card at a
waiting state by reporting one populated table and then garbage; it is bounded by the exited
backstop and sits inside the accepted risk that a token holder can distort its own status. An
oversized `Stop` post is drained and dropped, which now costs the roster-clearing report as well as
the liveness tick, so the route's ceiling is raised to the one its sibling route already carries
for the same payload. And a long-lived background shell holds its session at working for as long as
it runs, which is the same class of invisible work the roster exists to show rather than a
misreport.

**No start and stop posts in v1.** The roster is a state the operator reads on the card when they
look, not an event stream; a post per dispatch would be the loudest surface in the thread on a
fan-out round. A completion that matters already reports itself in the session's own narration.

Files: `broker/intake.ts` (reading `background_tasks` off the credited `Stop` payload by allowlist,
beside the mirror's own read of that payload), `broker/registry.ts` (the roster slot and the state
derivation), `broker/discord/render.ts` (the card line and the title), plus tests. The field is
parsed by the bounded-allowlist discipline every other payload field takes: a malformed or
oversized entry contributes nothing, the entry count is capped, and no roster content reaches a
log line.

Tests lock the wholesale replacement (a roster shrinking to empty clears rather than lingers), the
subagent-versus-shell rendering, the empty and absent cases as inertness, the idle-versus-waiting
state both ways, the overflow bound at a twelve-agent fan-out, and a malformed `background_tasks`
leaving the previous roster untouched rather than throwing.

### 5. Docs, deploy, and live verify

Model: fable
Locus: inline

`docs/architecture.md` (the new surface in the component map, and the session card's new line),
`docs/operations.md` (reading the card, the staleness semantics, the knob, what a model-change
notice means), `docs/security-model.md` (what the reader opens, what never leaves the machine:
one clause). Deploy to SCOTT (env knob on, broker restart, elevated hand). Live verify: the card
appears, matches a console `cswap` read, ages honestly when claude-swap consumers are off, the
session-health section tracks a real session end within one refresh, and a session card shows a
model and a context figure that match what the console reports for that session.

## Out of Scope

- Drilling into a running subagent from the thread (the console's own feature): the roster names
  what is running and for how long, and nothing more.
- A post per subagent start and stop: the roster is read as state on the card, not streamed as
  events.

- Invoking claude-swap in any form (the mutation and budget findings; revisit only if passive
  staleness bites).
- Cross-host aggregation (NEO/ASR sessions on this card): the registry is per-host; a later
  round if wanted.
- Backlog/plan surfacing on the card (deferred 2026-08-09, operator's call: no good mechanism).
- Thread-name status packing (renames are scarce; the name stays static).

## Operator Verification

- With claude-swap's watch/auto running on the host, the card's numbers match a console
  `cswap status` read within one refresh interval; a mismatch beyond rounding reopens Section 1.
- Kill the claude-swap consumers for an hour: the card's "as of" ages visibly instead of showing
  stale numbers as fresh; a fresh-looking stale card reopens Section 1.

## Open Questions

None at creation; the design round closed 2026-08-09 in conversation (thread card + both
sections, mirror-never-poll, backlog deferred).

## Chapters

### Chapter 1 - 2026-08-09
Completed: Section 1: The cache reader and card renderer
Implemented By: implementer-opus (build round), implementer-fable (review-fix round, then the
roll-forward adjudication on the same agent's context)
Metrics: 1 full review round (adversarial + blind + security, all at the session tier) plus two
fix passes; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the review round's two strongest findings both came from reading outside
this repository. The adversarial reviewer opened claude-swap's own Python and found the
`ahead of pace` annotation missing entirely, which the spec names in its Goal, and brought back
the upstream algorithm so the card cannot disagree with the console: a seven-day period, elapsed
measured against the fetch time rather than now, suppressed for a day after a reset, and a
fifteen-point threshold, on the weekly and per-model rows only. The same source settled the
implementer's own flagged uncertainty in both directions: `backoffUntil` is an epoch instant, so
a presence test rendered a backing-off warning for a state upstream considers expired, while
`lastError` as a presence test is correct because success clears it. The blind reviewer found by
probe that account keys round-tripped through `Number` and back through `String`, so one account
could render twice and consume two slots while another was read under the wrong key or dropped.
Security found the freshness guard defeating itself: a finiteness check before a seconds-to-
milliseconds multiply that reintroduces infinity, rendering arbitrarily stale numbers as just
now. Both non-security reviewers independently found the same asymmetry, an available reading
with zero accounts rendering a bare heading with no reason where the unavailable path explains
itself.
Adjudicated by the orchestrator: the spec contradicted itself on a window whose reset has passed,
where mirroring the last-written percentage collides with matching the console. Resolved toward
the roll-forward and the Approach amended to say so: advancing a boundary the cache's own reset
instant declares reads the data rather than manufacturing freshness, and the alternative fails in
the expensive direction, telling the operator they are out of headroom against a window that
already reset. The security model's account of what crosses to Discord now names the card's
account identity, corporate on two of three hosts, beside what the reader deliberately leaves
unread in that directory.
The verification is the part worth keeping: the renderer was checked differentially against
upstream's own summary function driven through claude-swap's interpreter, 230 rows with 90 of
them rolled windows, 0 mismatched. An earlier grid's nine mismatches were root-caused rather than
waved off, to a microsecond ISO round-trip putting upstream's gap 238 nanoseconds past a
suppression boundary the card lands exactly on; the agent also caught and reported a bug in its
own harness that had reported every row mismatched. Accounts order ascending, which a receipt
from three upstream call sites shows is the rotation array's own order, so the deviation is
recorded rather than re-litigated. Deliberate: the cache's own countdown and clock strings are
never read, because they were computed at fetch time and drift, which the live file proved by
carrying a countdown eleven minutes stale.
Review Findings: adversarial CHANGES_REQUIRED (1 Critical, 5 Major, 6 Minor); blind
CHANGES_REQUIRED (3 Major, 8 Minor); security CONCERNS (0 Critical, 4 Minor). All 19
deduplicated items fixed, items 1 to 5 red-first. Accepted with justification: the exported
reason member renamed rather than reworded, since the value is itself the loggable word; the
floored modulus left untested as documented defensive correctness the caller cannot reach; the
footer's age anchored to the data rather than the clock, so a quiet fleet spends no edit; and a
maxed per-model row taking the warning glyph over the pace marker, mirroring upstream.
Named check riding to Section 5's live verify: the roll counts missed periods against now while
pace measures elapsed against the fetch time, which is upstream's own split, mirrored
deliberately; the differential covers it at a ninety-second gap between the two clocks and not at
a gap wide enough to straddle a boundary by itself.
Stamps: adjudicated 0 unstamped over the section span; none surfaced
Next: Section 2: The card thread lifecycle and wiring
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-09
Completed: Section 2: The card thread lifecycle and wiring
Implemented By: implementer-opus (build round), implementer-fable (review-fix round)
Metrics: 1 review round (adversarial + blind at the session tier; no security pass, the section
adds no inbound surface and opens no new file); 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the build round disproved an assumption in its own brief before it cost
anything. Told to persist the card's thread binding the way session threads are persisted, it read
that store first and found it retires and deletes any binding no registry record claims, which no
session will ever do for a fleet thread: sharing the file would have deleted the binding on the
first pass after every restart and opened a new thread each boot. It wrote a sibling store on the
same mechanism instead.
Both reviewers then found Criticals that a green suite structurally cannot see. The shutdown drain
did not drain: a refresh firing while a pass was on the wire short-circuited and overwrote the
handle `stop()` waits on, so shutdown returned mid-write, the binding was never saved, and the next
boot would post a second card into the operator's channel, accumulating an orphan per occurrence.
The blind reviewer reproduced it outside the repo rather than arguing it. The unreadable-cache hold
suppressed the whole edit rather than the usage block, which inverted Section 1's own behavior
(rendering unavailable once and never again), made the 404 self-heal unreachable, and froze the
card's age while the data aged, the stale-as-fresh direction the module exists to prevent; the
implementer had recorded that as an accepted cost and the reviewer correctly overturned it, while
bounding the claim to the unreadable branch alone. Also fixed: the card's timer was cleared after
unbounded awaits in the broker's stop, so a pass could write to Discord and to disk on behalf of a
torn-down broker; one refusal counter covered three routes and any success reset it, so a
permanently refused route retried forever while a permanently failing thread-open abandoned a card
whose edits worked; and no pass ran at startup, so the thread would not exist for up to a full
refresh interval, an hour at the configured ceiling.
Operator request folded into the same round: the countdowns put a space between their two units
(`4d 0h`), which the spec's own illustration above now matches. The operator declined an absolute
wall-clock time, since it would be converted in the head anyway and the relative figure is what a
burst decision actually uses.
Two false claims corrected rather than carried: the comment asserting the card's budgets are not
buckets the session writers spend (they route through the same channel-scoped paths; the true
statement is the thread-messenger distinction), and the header's claim that a quiet fleet costs no
Discord calls. The implementer refused half of that second item as briefed and was right: an idle
card is not byte-stable either, because ages are minute-granular below an hour, so the honest
steady state is about one edit a minute until every reading and session line has aged past that
mark. The same overstatement in Section 1's footer comment is corrected in this changeset.
Review Findings: adversarial CHANGES_REQUIRED (1 Critical, 3 Major, 4 Minor); blind
CHANGES_REQUIRED (1 Critical, 2 Major, 3 Minor). All 13 deduplicated items implemented, items 1 to
5 red-first. Accepted with justification: the refusal decay window is expressed in refresh passes
rather than wall time, so it holds at both ends of the configured range; reaching the rebuild
ceiling or a route's refusal ceiling halts that path for the process lifetime, mirroring the
existing refusal precedent, with a restart as the recovery; and the hundred-column convention is
convention rather than a gate, so pre-existing long lines elsewhere were left alone.
Named check riding to Section 5's live verify: a host with zero live sessions and no claude-swap
install renders a static body, so no edit is attempted and a deleted card would go undetected until
restart. That is the byte-compare design rather than a defect, and it is the one remaining path to
a silent card.
Stamps: none surfaced at this boundary
Next: Section 3: The session card's model and context line
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-09
Completed: Section 3: The session card's model and context line
Implemented By: implementer-opus (build round), implementer-fable (review-fix round, dispatched
with the explicit override from this Opus-led session)
Metrics: 1 full review round (adversarial + blind at fable via the one-tier bump, security at its
default) plus the fix round's red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the round produced this effort's first genuine Critical, found by tracing
and confirmed twice by execution. A `system` line's subtype was read through a bare object index,
so a prototype key (`constructor`, `toString`, `__proto__`) resolved to something that is not
undefined and passed the guard, storing a downgrade whose cause was a function. `JSON.stringify`
drops a function-valued field, the next load then failed validation, and `loadSessions` answers a
malformed record by returning none, so one crafted line in a file this module treats as untrusted
would discard every session record on the host and with it every Discord thread binding. Two
independent locks landed: the lookup is guarded, and the snapshot validator now nulls a malformed
downgrade at field level rather than rejecting the record. The second is the one that removes the
primitive whatever the source, and it was already written down one function above the defect,
where the sibling validator's own comment explains why strictness there empties the registry.
The most instructive finding was a measurement no code reading could have produced. The two
downgrade paths write their transcript lines in opposite orders: on the refusal path the assistant
line carrying the new model lands first and the system record follows about twelve seconds later
(observed twice in the captured specimen), while the consent path leads with the record. The
implementation and its tests assumed record-first, so on the more common path the transition was
seen before its reason existed, the message posted with no category, and a session starting
downgraded seeded its opening model from the fallback itself, permanently hiding the marker the
feature exists to show. A downward change with no record beside it is now held briefly and released
either enriched by a record that arrives or plain when the hold expires, so both orders produce one
identical message; a record trailing a transition reseeds a mis-seeded opening model, guarded so a
genuine opening is never rewritten.
Also fixed: a session that starts downgraded now posts its change from the opening model, where the
silence had been pinned by a passing test asserting it as intended; a stale downgrade no longer
rides a later manual switch, attaching only when the destination family-matches the record and
clearing on any move whose family reaches the opening; and model-change alerts take their own
per-thread window, since the alert tier has no floor by design and this was the third
mention-bearing write to arrive without one. Minors: the context sum re-checks its total, the
status route rebuilds the downgrade field by field rather than publishing the object by reference,
a floored or refused notice logs content-free, and a change read before the Discord doorway is live
is held rather than lost.
Adjudicated by the orchestrator: publishing the four fields on the loopback status route is
in-class and now documented in the security model, alongside the model-change message as the third
mention-bearing write and the knob as a notification control. Recorded as limits rather than
defects: the family rank is substring containment, so a crafted model string can render a genuine
downgrade unmarked and the marker's absence is not evidence; the tailer baselines at the file's
current size, so a downgrade written before the path is learned is never read; and the model line
exists only where both mirror switches are on, since reading a suppressed session's transcript for
the model alone would be a content-safety regression.
Review Findings: security BLOCK (1 Critical, 2 Major, 4 Minor); blind CHANGES_REQUIRED (3 Major,
3 Minor); adversarial APPROVED_WITH_CONCERNS (2 Major, 4 Minor). All 13 deduplicated items
implemented or recorded, items 1 to 6 red-first. One file beyond the section's set:
`broker/security/permission.ts`, because the new alert window's ceilings belong beside the
siblings they mirror.
Named check riding to Section 5's live verify: the model line has never rendered against real
Discord, and the open question is whether the marker's glyph beside the card's own state glyph
reads clearly at a phone's width.
Stamps: none surfaced at this boundary
Next: Section 4: The subagent roster, and the idle state that is wrong without it
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-09
Completed: Section 4: The subagent roster, and the idle state that is wrong without it
Implemented By: implementer-opus (build round), implementer-fable (review-fix round, dispatched
with the explicit override this Opus-led session's spend header authorizes)
Metrics: 1 full review round (adversarial and blind at fable via the one-tier bump, security at
its default) plus the fix round's red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the round's defining moment was two reviewers reaching opposite conclusions
on whether the roster survives a restart, which the orchestrator adjudicated toward persisting it.
The adversarial reviewer read the section's own ruled-out paragraph as forbidding it; that
paragraph governs reconstructing a roster from transcript dispatch events, where ghosts accumulate
because completions can never arrive, while this table is authoritative and replaced wholesale, so
a persisted copy is bounded rather than accumulating. The failures decide it: a stale roster after
a restart shows visibly old ages and self-corrects at the next report, where dropping it makes a
session read idle for the whole remaining fan-out after a mid-fan-out restart, which is the defect
this section exists to fix, reopened at every restart.
Two reviewers independently found the same Major from opposite directions, and it falsified a
sentence of the spec rather than a line of the code: putting the task count in the thread title
made every count change a rename, because the dwell timer re-stamped only on a state change while
the surface compares the whole composed title. Adversarial found the drain case, security found
the hostile case of a token holder alternating its reported table, and both land on the same
victim, since an urgent parked-session rename bypasses the dwell but not the budget. The damper now
keys on the composed name, which coalesces a drain and closes the hostile door with one change; the
spec paragraph is corrected and says so.
Also fixed: an exited session's card carried a waiting-on line whose ages grew for work that no
longer existed, fixed at the render seam because the backstop's exited state is derived rather than
written, so a registry-side clear could not reach it; and an oversized `Stop` post, which this host
refuses in ordinary operation, now cost the roster-clearing report as well as a liveness tick, so
the `/hook` ceiling is floored at the bound its sibling route already carries for the same payload
rather than a new posture being invented. Minors: the roster line moved below the turn count and
the heartbeat, since a long card is cut from its end; the label reads tasks rather than agents,
because a background shell is not an agent; an explicit JSON null now preserves the roster where
only an empty array clears it; and the first-sighting carry-forward keys on kind and id together.
The security reviewer corrected a premise in the orchestrator's own brief: task descriptions never
reach the thread title, which carries only a state word and an integer, so no escaping was added
where none is needed.
Recorded as limits rather than defects: a table that is present but not an array preserves the
roster, so a token holder can pin its own card at a waiting state, bounded by the exited backstop
and inside the accepted risk that a token holder distorts its own status; a long-lived background
shell holds a session at working for as long as it runs, which is the invisible work the roster
exists to show; and a restart reseeds nothing now that stamps persist.
Process note, second instance and therefore a pattern rather than a slip: the orchestrator's blind
dispatch again carried diff-describing framing, which the reviewer named and disregarded before
reviewing the diff alone. The correction is to the dispatch template, not to the output: a blind
brief carries the base ref, the changed-file list, and only lenses that would read identically for
any diff in this repository.
Review Findings: adversarial APPROVED_WITH_CONCERNS (2 Major, 4 Minor); blind
APPROVED_WITH_CONCERNS (5 Minor); security CONCERNS (2 Major, 2 Minor). All 10 deduplicated items
implemented or recorded, items 1 to 4 red-first. Two files beyond the section's set, both forced:
the broker's wiring, where the raised ceiling is passed, and a comment-only correction in config
whose contract statement would otherwise have been false.
Stamps: adjudicated 1, stamped 1 (a-model-downgrade-writes-a-structured-transcript-record)
Next: Section 5: Docs, deploy, and live verify
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-09
Completed: Section 5's documentation. The deploy and the live checks are the operator's and are
carried into the close-out rather than holding the plan open.
Implemented By: main session (documentation is main-thread work in this harness)
Metrics: 0 review rounds (prose only; the finishing pass covers the changeset); 0 escalations
Decisions / Surprises: operations gained the fleet card and, importantly, why it mirrors a local
cache rather than running the tool it reads, since that reasoning is what stops a future session
from "simplifying" the reader into a CLI call that would compete for a request budget already near
its ceiling. It also gained what a session card now says about the model answering its turns, the
two forced downgrades and which of them an operator can act on, and what a session is waiting on.
The architecture carries the same at design altitude, including why the roster is read from the
harness's own table rather than reconstructed from dispatch events. The security model already
carried this round's egress clauses, added as each section landed rather than deferred to here.
The tunables table gained the four knobs these surfaces read.
One correction rather than an addition: the security model quoted fixed character counts for what
a card draws of a task description and a tool input, which stopped being true when the card's body
moved into a fenced block in the concurrent fidelity round. Both are now whatever the block's width
leaves, which is less than the status route carries rather than more, so the figures were the wrong
thing to state and the asymmetry is stated instead.
Operator-pending, carried to the close-out and to the backlog rather than holding this plan open:
the deploy (the card is off until `CHANNEL_USAGE_CARD` is set and the broker restarted) and the two
live checks the plan names, the numbers matching a console read and the card aging honestly when
claude-swap's own consumers are stopped. A third rides from Chapter 3: whether the downgrade
marker's glyph reads clearly beside the card's own state glyph at a phone's width.
Review Findings: none new; every section's findings were closed in its own round.
Stamps: none surfaced at this boundary
Next: the whole-effort finishing pass
Commit Model: Commit-and-Push
