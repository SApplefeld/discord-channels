# An inbound message lands whole, and a cut is loud

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: n/a (Fable-led session)
Created: 2026-08-08

## Goal

A channel message the operator can send lands in the session whole, as one event: the broker's
inbound ceiling matches Discord's own 4,000-character maximum, so no deliverable message is ever
cut. If a longer message ever arrives anyway, the cut is announced in the thread instead of
happening in silence, so the operator knows to resend rather than discovering the loss
mid-conversation.

## Approach

Decided 2026-08-08 with the operator, live on the channel after they hit the old silent cut.

The old bound, `MAX_INBOUND_TEXT_LENGTH = 2_000` (broker/routing/inbound.ts:46), sat below
Discord's Nitro message cap of 4,000, so a long dictation that Discord accepted lost its tail with
no signal on either end. The operator first asked for chunked delivery; the refinement settled on
whole-message delivery instead, because chunking solves a case that stops existing once the
constant matches Discord's cap: a single gateway message can never exceed 4,000, and 4,000 code
points fit one broker-to-relay stream line with about four-times headroom under the relay's 64 KB
line ceiling. One message, one stream line, one channel notification, one instruction.

Explicitly considered and declined: coalescing consecutive Discord messages into one delivery
(covers only the case where Discord's client itself splits a dictation, and costs a quiet-window
delay on every steering message; revisit only if the operator actually hits client-side
splitting), and chunked overflow delivery (dead code once the ceiling matches Discord's cap, and
two events per instruction is exactly what the operator asked to avoid).

The backstop changes the failure mode, not the bound: a message over the ceiling is still cut at
4,000 code points (the flood bound on the session's context stays), but the broker posts a notice
into the thread naming the cut. The notice fires only when a truncated message was actually
delivered to a live session, because a cut on a message that reached no session is noise about
text nobody received.

The cross-component risk this spec pins: the broker writes a stream line the relay reads, and the
relay silently drops any line past its 64 KB buffer cap. Each side tested only against its own
constant is how a mismatch stays invisible, so the relay's cap is exported and one test asserts
the worst-case inbound line (4,000 astral code points, the widest UTF-8 a message can carry) fits
under it.

## Sections of Work

### 1. The ceiling, the notice, and the wire pin

Model: fable

- broker/routing/inbound.ts: raise `MAX_INBOUND_TEXT_LENGTH` to `4_000` and rewrite the
  constant's comment to its new justification: it matches Discord's own maximum message length,
  so no message Discord delivers is cut, and the slice below is the backstop for a future cap
  change, not a working path. Add a truncation notice (a module constant beside
  `UNREACHABLE_NOTICE` and `ENDED_NOTICE`, wording in their register, e.g. naming that the
  message was cut at 4,000 characters and the rest was not delivered) posted via the existing
  `notice()` helper when, and only when, a truncated message was delivered to a live session:
  detect the cut where `bounded()` is applied, deliver the truncated text exactly as today, and
  post the notice after a successful `relays.deliver`. No notice on the undelivered paths (no
  thread, ended session, over rate, no relay attached).
- relay/broker.ts: export the 64 KB line cap (`MAX_LINE_BYTES`) so the cross-component pin can
  read it; behavior unchanged.
- Tests, broker/routing/inbound.test.ts: the existing slice tests already key on
  `MAX_INBOUND_TEXT_LENGTH` symbolically and must stay green at the new value. New: a
  4,000-code-point message is delivered whole and unsliced; an over-ceiling message is delivered
  cut AND the thread receives the truncation notice; an over-ceiling message that reaches no
  session posts no notice. The wire pin: `Buffer.byteLength(JSON.stringify({type, chatId, text}))`
  for a 4,000-astral-code-point text stays under the relay's exported `MAX_LINE_BYTES`, importing
  both constants so neither side can move without this test seeing it.

Files in scope: broker/routing/inbound.ts, broker/routing/inbound.test.ts, relay/broker.ts, plus
relay/broker.test.ts only if the export needs a smoke assertion.

Acceptance: `node --test broker/routing/inbound.test.ts relay/broker.test.ts` green;
`npm run lint` exit 0; the notice fires on exactly the delivered-truncated path.

Tests: lock both directions of the backstop: a deliverable-length message must arrive whole with
no notice, and an over-ceiling delivered message must arrive cut with the notice; the silent-loss
regression is the expensive failure. Lock the wire relation with both real constants, never a
literal restated in the test.

### 2. The docs and the backlog

Model: fable
Locus: inline

Documentation is main-thread work (implementer subagents are blocked under docs/).

- docs/operations.md: in the inbound-chat material, state the bound and the failure mode: a
  message up to 4,000 characters (Discord's own maximum) is delivered whole; past it the message
  is cut at 4,000 and the thread says so. Keep the existing steering-deference paragraph as is.
- docs/backlog.md: the truncation item this effort completes moves to the quarter's snapshot
  (docs/archive/backlog-2026-Q3.md), per the pruned-live discipline.
- Sweep for any other prose stating the 2,000 inbound bound; the known sites are the backlog item
  and the constant's own comment (Section 1).

Acceptance: no doc states the 2,000 inbound bound; the backlog carries no completed item.

## Out of Scope

- Coalescing multiple Discord messages into one delivery (declined above; revisit on a real hit).
- Chunked delivery of over-ceiling text (declined above; the notice replaces it).
- The 20-messages-per-minute inbound rate ceiling and its silent drop; unchanged.
- The permission-verdict path and the sender gate; unchanged.

## Related

- [`../archive/plans/channels_provenance-instructions_spec_v1.md`](../archive/plans/channels_provenance-instructions_spec_v1.md),
  the effort during whose close-out the operator hit the silent cut live.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-08-08
Completed: 1. The ceiling, the notice, and the wire pin
Implemented By: implementer-fable
Metrics: 2 review rounds (adversarial + blind + security, then a fix round back to the same implementer); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The review round earned its cost twice. The adversarial reviewer found the writer's 60-second per-thread notice floor could silently swallow the truncation notice (or let it swallow a failure notice), recreating the exact silent loss the effort kills; fixed by posting the announcement through the writer's unfloored reply path, which neither reads nor stamps the floor, bounded by the 20-per-minute inbound ceiling and the post budget. The blind reviewer found the cut could manufacture a verdict: the anchored pattern's interior whitespace lets "y" plus thousands of spaces plus a request ID plus a tail truncate into an exact verdict match, approving a real tool call the full message never stated; fixed by never parsing a truncated message as a verdict. The security reviewer sharpened the wire pin to the true worst case (a lone surrogate JSON-escapes to six bytes per code point; the pin now models it with a 20-digit snowflake). The implementer single-sourced the notice's "4,000" from the constant so a future cap change cannot make the notice lie. All three new regression tests were watched red against the pre-fix code (3 fail, exit 1) before going green. Security's grep-artifact worry about relay/index.ts comment markers was dismissed with evidence: tsc exit 0 proves the files parse.
Review Findings: 1 Major (notice floor masking) fixed; 4 Minor fixed (verdict-from-cut, surrogate wire pin, 20-digit chatId fixture, double code-point spread); 1 Minor dismissed with evidence (grep rendering artifact).
Stamps: none surfaced (memq unstamped --since 1h returned 0; two-components-agreeing was stamped at design time for the wire pin)
Next: 2. The docs and the backlog
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-08
Completed: 2. The docs and the backlog
Implemented By: main session
Metrics: 0 review rounds (two-paragraph doc delta, covered by the finishing pass); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: operations.md states the 4,000 bound, whole-message delivery, and the loud cut beside the inbound rate ceiling; the completed truncation backlog item moved to the 2026-Q3 snapshot; the sweep found no other live prose stating the old 2,000 bound.
Review Findings: none (deferred to the finishing pass)
Stamps: none surfaced
Next: finishing-work
Commit Model: Commit-and-Push

