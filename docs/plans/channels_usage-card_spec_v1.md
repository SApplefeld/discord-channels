# Channels: the usage and fleet-health card

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session); overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the concurrent
  round; the two share the broker but no files beyond `broker/index.ts` wiring, and land
  independently.

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
   window: `5h 46% · resets 3h44m`, `7d 56% · resets 4d6h · ahead of pace`, per-model scoped rows
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
newest few entries with description, type, and age, then an overflow count (`⚙ 7 agents ·
Grooming S6 implementation (implementer-fable) 35m · PR ladder fix round three (implementer-opus)
62m · +5 more`). A full roster rendered in full runs past 700 characters at twelve entries, which
would crowd every other thing the card carries, so the bound is structural rather than cosmetic.
Nothing is rendered when the roster is empty.

**The state vocabulary gains the case.** `working`, `needs you`, `idle`, `exited` cannot express
waiting on agents, which is why the card is wrong today rather than merely thin. A session with an
outstanding roster renders as working with its agent count rather than idle, in the thread title
as well as the card, since the title is what survives the mobile thread-list truncation. The
existing states are unchanged for every session with an empty roster, and the rename budget is
unaffected because the title already changes on state transitions.

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
