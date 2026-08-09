# Channels: the usage and fleet-health card

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session)
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the concurrent
  round; the two share the broker but no files beyond `broker/index.ts` wiring, and land
  independently.

## Goal

Away from the keyboard, the operator can see what the console sees: one always-there Discord
thread ("Fleet: Usage") whose first message is a card the broker edits on a cadence, carrying
each account's 5h / 7d / per-model usage bars with reset times and pace, and one line per live
session on this host (name, state, minutes since last activity). The blindness this removes is
recorded operator pain: rate limits and stuck agents are invisible from Discord until a walk
back to the console.

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

### 3. Docs, deploy, and live verify

Model: fable
Locus: inline

`docs/architecture.md` (the new surface in the component map), `docs/operations.md` (reading the
card, the staleness semantics, the knob), `docs/security-model.md` (what the reader opens, what
never leaves the machine: one clause). Deploy to SCOTT (env knob on, broker restart, elevated
hand). Live verify: the card appears, matches a console `cswap` read, ages honestly when
claude-swap consumers are off, and the session-health section tracks a real session end within
one refresh.

## Out of Scope

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
