# Channels: three title states, and the rename cleaner retired

Status: Complete
Commit Model: Commit-and-Push
Created: 2026-08-17

Two changes to what a session thread's name does, decided by the operator 2026-08-17 from a live
read of the fleet. First, the rename-notice cleaner shipped in the render-tweaks round is retired:
Discord refuses an app's delete of a thread-rename notice by rule (HTTP 403, JSON code 50021,
"Cannot execute action on a system message"; a human account with Manage Messages is not held to
it), so the branch is dead code that costs one refused request per broker start and then latches
itself off, and its refusal line has been in every run's log since it shipped. Second, the thread
title changes only among three states, active, needs you, and exited, because every rename writes
a notice into the thread that nothing can remove, and the finer state (working versus idle, the
count of tasks a session is waiting on) is already on the status card the operator reads.

## Related

- [`../archive/plans/channels_render-tweaks_spec_v1.md`](../archive/plans/channels_render-tweaks_spec_v1.md):
  section 3 built the rename-notice branch this plan removes; section 5 set the glyph vocabulary
  the title now uses a subset of.
- [`../archive/plans/channels_pin-notice-cleanup_spec_v1.md`](../archive/plans/channels_pin-notice-cleanup_spec_v1.md):
  the pin-notice cleaner, which stays exactly as it is; only the rename kind leaves.

## Goal

1. **No dead delete.** `classifyMessage` never answers `delete` for a `ChannelNameChange` message.
   An own-authored rename notice in a thread under this host's channel is dropped in silence, the
   same as one written by anyone else. `SystemNoticeKind` is `"pin"` alone, `deleteMessage` takes
   no thread id, and the cleaner's refusal line can only ever name the pin kind. The broker log
   after a restart carries no rename-notice refusal line.
2. **A refusal names Discord's reason.** A 4xx from the REST adapter carries Discord's JSON error
   code and message when the body has them (`HTTP 403 (50021: Cannot execute action on a system
   message)`), and the bare `HTTP <status>` when it does not. This is what would have made the
   dead branch diagnosable from the log in one read instead of a live probe.
3. **Three title states.** The thread name is `<glyph> <name> · <title state>` where the title
   state is one of `active` (⚙), `needs you` (⏹), `exited` (⚠). `working` and `idle` both render
   `active`; the waiting-task count no longer rides the title. The status card keeps its four-state
   vocabulary and its count exactly as today: the card is where the state lives, and the title is
   what the thread list can afford to change.
4. **One rename per thread on deploy, then quiet.** Existing threads carry a `working`/`idle`
   title from the previous format; the first pass after the restart renames each once to the new
   format, and after that a thread renames only when its title state actually flips.

## Approach

### The rename cleaner (section 1)

`classifyMessage` in `broker/routing/gateway.ts` returns `delete` for an in-thread
`ChannelNameChange` this bot authored under this host's channel. That decision becomes `drop`; the
`report` branch for unexpected own-authored system messages is untouched, and a rename notice must
not become `report` either, since it is expected on every rename and would flood the once-per-type
log line. `SystemNoticeKind` loses `"rename"`, `createSystemNoticeCleaner` loses the per-kind latch
only if that leaves it simpler (a one-kind latch is still a latch; keep the shape, drop the union
member). `deleteMessage` in `broker/discord/transport.ts` and `broker/discord/adapter.ts` returns
to the channel-only signature. The gateway's header comment and the transport's doc comment stop
naming the rename notice. `docs/security-model.md` (the paragraph at ~352-362) states the rule as a
present-tense fact: an app cannot delete a thread-rename notice (Discord error 50021), so the
broker does not try; the pin notice remains deletable and is deleted.

The adapter's `classify` folds every 4xx into `HTTP <status>`. It reads the response body already;
when that body is an object with numeric `code` and string `message`, the error becomes
`HTTP <status> (<code>: <message>)`, message bounded to a sane length and sanitized to printable
characters since it is a network-supplied string headed for the log. `permanent`, `missing`, and
every other field are unchanged, so nothing downstream reads differently.

### The title (section 2)

`threadName` in `broker/discord/render.ts` composes glyph, name, and `stateLabel(view, state)`.
A new `titleState(state: SurfaceState): TitleState` maps `working` and `idle` to `active` and passes
`needs you` and `exited` through; `threadName` uses `GLYPHS[titleState]`-shaped lookup (a
`TITLE_GLYPHS` record over the three, ⚙ ⏹ ⚠, so `GLYPHS` over the four stays for the card) and the
title state as the label with no count. `stateLabel` stays for the card, which is unchanged. The
dwell in `surface.ts` keys on the composed name and needs no change: `working` to `idle` no longer
changes the name, so no rename is composed, and the `URGENT` set still bypasses the dwell for the
two states that matter. `docs/operations.md` "Reading a thread" and the "What a session is waiting
on" passage, and `docs/architecture.md` ~330, are rewritten to the three-state title with the count
on the card only.

## Standing Brief Amendments

- No em dashes anywhere, code comments included.
- The repo tree is the reviewers' read-only; implementers run `npm test` (the pretest gate
  requires at least one test file to match) and `npm run lint` before reporting.
- Tests are `node:test` over `**/*.test.ts`; both directions of every gate that changes.

## Sections of Work

### 1. Retire the rename-notice cleaner; refusals carry Discord's code (Complete)
Model: opus
`broker/routing/gateway.ts` (+ `gateway.test.ts`), `broker/discord/transport.ts`,
`broker/discord/adapter.ts` (+ `adapter.test.ts`), `docs/security-model.md`. Tests: an own-authored
in-thread `ChannelNameChange` under this channel now decides `drop` (the test at
`gateway.test.ts:166` flips); the operator-authored and other-channel cases still `drop`; an
ordinary own-authored thread message still delivers; the parent-channel pin path is byte-for-byte
as before; `deleteMessage` issues against the configured channel only (the thread-scoped adapter
test at `adapter.test.ts:214-231` goes); the cleaner never receives a rename kind (type-level).
Adapter: a 403 whose body is `{"message":"Cannot execute action on a system message","code":50021}`
classifies with error `HTTP 403 (50021: Cannot execute action on a system message)`; a 403 with an
empty or non-JSON body classifies `HTTP 403`; `permanent` is true in both.
References: `classifyMessage` at `gateway.ts:66`; `createSystemNoticeCleaner` at `gateway.ts:157`;
`classify` at `adapter.ts:163-193`; `deleteMessage` at `adapter.ts:417`.

### 2. Three title states (Complete)
Model: opus
`broker/discord/render.ts` (+ `render.test.ts`), `docs/operations.md`, `docs/architecture.md`.
Tests: `threadName` for a `working` view and an `idle` view is identical and ends `· active` with
the ⚙ glyph; `needs you` and `exited` titles are unchanged from today; a `working` view with three
background tasks titles `· active` with no count while `renderCard` for the same view still carries
`working · 3 tasks` (the test at `render.test.ts:2340` splits into card and title expectations);
the existing glyph-first and invisible-character tests still hold. `surface.test.ts`: a session
flipping `working` to `idle` composes no rename (no `renameThread` call), and one flipping to
`needs you` still renames immediately.
References: `threadName` at `render.ts:698`; `stateLabel` at `render.ts:686`; `GLYPHS` at
`render.ts:26`; the card title at `render.ts:1943`.

## Out of Scope

- The board card, the usage card, and the pin-notice cleaner.
- Any change to what the status card says; the four states and the task roster stay as they are.
- Rename budget and dwell tuning; the change removes renames rather than damping them.

## Operator Verification

After `Repair-Broker.ps1` restarts the broker on the new commit: every live thread renames once to
`⚙ <name> · active` (or its needs-you/exited form); the log carries no
`deleting a rename notice was refused` line; a session going quiet (working to idle) leaves the
title alone while the card flips to `⏸ idle`; a permission prompt still flips the title to
`⏹ <name> · needs you` at once.

## Open Questions

None at writing.

## Chapters

Both sections were built concurrently on disjoint files, reviewed as one changeset (adversarial,
blind, and security reviewers at fable, one implementer-opus fix round), gated once and committed
once. Recorded as one Chapter because the fix round crossed both.

### Chapter 1 - 2026-08-17
Completed: 1. Retire the rename-notice cleaner; refusals carry Discord's code; 2. Three title states
Implemented By: implementer-opus (both sections in parallel), implementer-opus (fix round)
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The blind reviewer found the section's one real defect: `broker/discord/rest.ts`
catches the client's `DiscordAPIError` and returned `body: null`, so the adapter's new
`refusalReason` could only ever fire under the test fake and was inert against the real client, the
exact wire-shape gap a fake cannot catch. Fixed by extracting the catch mapping into an exported
`outcomeOfError` (the request function needs a real client, so the mapping is the testable seam) that
passes `error.rawError` through, with a new `rest.test.ts` driving a constructed `DiscordAPIError`,
watched red (body null) then green. The security reviewer noted the refusal string reaches two sinks,
the log and the relay reply result the session reads, which the adapter comment now states as an
accepted trust in Discord's fixed error catalog, stripped to printable ASCII and bounded to 120
characters; an empty-after-strip message falls back to the bare status. The old-format persisted
titles cause exactly one rename per live thread on the first pass after restart, pinned by a
surface test rather than assumed. A project memory written 19 hours earlier by another session
already held the 50021 finding with the same probe and the discord.js `DeletableMessageTypes`
evidence; this session re-derived it because it began in another repository and never ran
`memq recall` here. That memory is updated to the as-built state (the adapter now names the code;
the title carries three states).
Review Findings: Critical none. Major (blind): the inert `rest.ts` body path, fixed as above.
Minors addressed: `desiredName` and the dwell-stamp comments in `surface.ts` restated for a title
the count no longer reaches; the no-budget log line names the title state; "titled working
forever" reads active; two surface title tests read `TITLE_GLYPHS`; `operations.md` no longer
over-generalizes 50021 to every system message and one line is re-wrapped; a stale comment in
`broker/usage/card.ts` (Out of Scope, one line, undo by reverting that comment). Minor noted, routed
to the backlog: the gateway's thread branch is a deny-list by message type (only `ChannelNameChange`
is dropped), so a future Discord system type carrying composed content in a thread would reach the
inbound route until the empty-content guard; an allow-list of `Default` and `Reply` is the hardening.
Stamps: adjudicated 1, stamped 0 (`discord-refuses-deleting-rename-system-messages` was found after
the work, updated rather than stamped)
Next: none; plan Complete. Operator: `Repair-Broker.ps1` to restart the broker on this commit, then
the verification list above.
Commit Model: Commit-and-Push
