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
`backoffUntil` state renders as a warning line. When every other claude-swap consumer is off and
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

**The reading** (measured; see the `a-sessions-subagent-roster-is-readable-from-its-transcript`
memory). The tailer's line reader gains a fifth allowlisted yield: an assistant `tool_use` named
`Agent` carries `description` and `subagent_type`; its matching `tool_result` (paired by
`tool_use_id`) carries `agentId`, which is the roster key; a later line containing
`<task-notification>` with that id in `<task-id>` ends the run. Outstanding is launched minus
notified. Pairing a dispatch with its own `tool_result` must not be used as completion: a
backgrounded dispatch answers at launch, so that reading reports every agent finished instantly.
Descriptions are operator-authored prose from this session and are rendered inert like every other
transcript-sourced field.

**Concurrency is the normal case, and the roster is an inference rather than a fact.** Measured
against a real fan-out session: 50 dispatches, peak 12 concurrent, and a naive launched-minus-
notified reading claiming 14 outstanding hours after the fact. Two corrections, both measured:

- **Scope to the session instance.** A transcript spans instances (the `session_id` field on each
  line, distinct from the conversation's `sessionId`), and a restart strands every agent the
  previous instance launched: their completions never arrive, so they haunt the roster forever.
  Instance scoping cut the same reading from 14 to 7.
- **Bound by age, and say what is known.** Even inside one instance an agent can be outstanding
  because it died, was stopped, or its notification never landed. Past a bound the entry is
  rendered as unconfirmed rather than dropped or asserted, because both silent alternatives lie in
  a different direction. The roster line therefore reads as dispatched-and-not-reported-back, which
  is what the transcript actually establishes.

**The card** carries a roster line per session while anything is outstanding: the count, then the
newest few entries with description, type, and age, then an overflow count (`⚙ 7 agents ·
Grooming S6 implementation (implementer-fable) 35m · PR ladder fix round three (implementer-opus)
62m · +5 more`). A full roster rendered in full runs past 700 characters at twelve entries, which
would crowd every other thing the card carries, so the bound is structural rather than cosmetic.
Nothing is rendered when the roster is empty.

**One unverified candidate worth a probe before building:** a `Stop` hook payload carries a
`background_tasks` field, which may or may not enumerate live subagents (it is documented in the
project memory as present, never as containing agents). If it does, it is an authoritative live
roster from the harness itself, arriving on a route the broker already receives, and it would
replace the age-bound inference for the timely case. Probe it first; the transcript reading stays
as the fallback either way, since it is the only source that survives a broker restart.

**The state vocabulary gains the case.** `working`, `needs you`, `idle`, `exited` cannot express
waiting on agents, which is why the card is wrong today rather than merely thin. A session with an
outstanding roster renders as working with its agent count rather than idle, in the thread title
as well as the card, since the title is what survives the mobile thread-list truncation. The
existing states are unchanged for every session with an empty roster, and the rename budget is
unaffected because the title already changes on state transitions.

**No start and stop posts in v1.** The roster is a state the operator reads on the card when they
look, not an event stream; a post per dispatch would be the loudest surface in the thread on a
fan-out round. A completion that matters already reports itself in the session's own narration.

Files: `broker/tail.ts` (the yield), `broker/registry.ts` (the roster slot and the state
derivation), `broker/discord/render.ts` (the card line and the title), plus tests. Tests lock the
launch-versus-completion pairing including the backgrounded-dispatch trap in both directions, the
instance-scoping rule (an agent launched by a previous instance never appears), the age bound's
unconfirmed rendering, the empty-roster inertness, the idle-versus-waiting state both ways, and
the overflow bound at a twelve-agent fan-out.

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

(Appended by executing-work as sections complete.)
