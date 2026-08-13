# Channels: a question prompt is read whole, however long it runs

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: S1, the reviewer bumps on S2, finishing reviews
Created: 2026-08-13

## Related

- [`../archive/plans/channels_question-answering_spec_v1.md`](../archive/plans/channels_question-answering_spec_v1.md):
  built the interactive question message this plan extends. That round's budget work
  (`questionRooms`, the refinement pass) shares one message well; this plan covers the ask that
  no single message can carry.

## Goal

An `AskUserQuestion` mirrored to a session's thread is readable in full, always. Today the
interactive message shares one Discord message's ~1,900-unit budget across the ask, and an option
that does not fit exists only inside the select menu, where Discord caps a description at 100
units and a phone ellipsizes it further; the operator decides on the front third of a sentence.
When the ask outgrows one message, the overflow is posted as plain continuation messages directly
below the interactive one, each within the message ceiling, so every question and every option's
full gloss is readable in the thread. An ask that fits one message behaves exactly as today.

The operator reported this live (2026-08-13): a two-question ask drew two of three options in
the body and the third arrived cut mid-sentence in the menu, unreadable anywhere in the thread.

## Approach

Ratified with the operator 2026-08-13: continuation messages, not a split of the interactive
message itself. One interactive message keeps all components (selects, buttons, control row) and
as much reading copy as fits, exactly as today; overflow rides plain follow-up posts. The
alternative, spreading pickers across several messages each under its own question text, was
weighed and declined: the desk's one-message model would break (terminal close-out and every
tap-refresh editing N messages, partial-failure states throughout), and a single long question
can exceed one message on its own, so continuation text is needed regardless.

Key decisions:

- **The continuation is the reading copy for what spilled, self-contained.** Any question whose
  body block ended with a spill marker gets its whole block redrawn in the continuation: number,
  header, question text, and every option with its full gloss, so the continuation reads on its
  own days later. Questions that fit are not repeated.
- **Markers point below, never at the menu.** The body marker becomes wording that says the rest
  is continued in full below this message (both layouts; the fast path's
  "without their notes" wording likewise). The menu remains the picker only.
- **Continuations land before the prompt edit that references them.** The upgrade posts the
  continuations first and only then edits the notice into the interactive prompt, so a marker
  never points at messages that failed to arrive. A continuation post failure releases the hold
  to the console, the fail direction every delivery failure here takes.
- **Reading-copy caps rise from layout bounds to anti-abuse bounds.** Today's 500-unit question
  and 400-unit description caps were set from measured p90s under single-message pressure. With
  continuations the pressure is gone: raise them to what one message can carry alongside its
  furniture (~1,500 units per field), kept only as a bound on untrusted conversation content.
  Evidence for the shape: measured over 30 real asks, descriptions run median 158 / p90 406.
- **Continuation count is bounded, and the bound is honest.** A constant cap (6 messages,
  ~11,000 units of reading copy, far past any real ask) bounds what one adversarial ask can make
  the broker post. Overflow past the cap ends the last continuation with a line naming how many
  options were not drawn and sending the reader to the console; components still carry every
  option either way.
- **Continuations are never edited and never deleted.** They carry pure ask text, no live claims
  ("waiting", mentions, components), so they stand as thread history after the hold ends, like
  the notice stands when an ask is never upgraded. The desk learns nothing about them: no new
  state, no close-out changes, no refresh changes. `renderQuestionPrompt` stays deterministic
  from the entry alone, so tap-refreshes redraw identical markers.
- **Rate shape:** continuations spend the writer's create-message bucket (via the plain post
  path), the prompt edit spends the PATCH bucket; the two are separate Discord buckets by
  measurement, so the new posts cannot starve the interactive edit.

Security posture unchanged: every continuation field is untrusted conversation content and goes
through `inertField`; no question content in any log line; continuation failure logs carry
counts and session ids only.

## Sections of Work

### 1. Continuation rendering

Model: fable

`broker/discord/question-message.ts` and `broker/discord/question-message.test.ts`.

`renderQuestionPrompt` additionally yields the continuation texts for the ask it rendered:
zero strings when every block drew whole, otherwise one or more messages, each within
`MAX_MESSAGE_LENGTH`, composed of the full blocks of every question that spilled (number,
header, question, all options with full glosses), split only at line boundaries. Spill markers
in the body (both layouts) reword to say the text continues in full below. Reading-copy caps
(`MAX_PROMPT_QUESTION_LENGTH`, `MAX_BODY_DESCRIPTION_LENGTH`) rise to ~1,500 so any field one
message can carry arrives whole; the continuation-count cap and its overflow tail line are this
section's to place. The existing single-message budget machinery (`questionRooms`, the
refinement round) is untouched in behavior for asks that fit.

Acceptance:
- An ask whose every field sits inside today's caps and that fits one message yields zero
  continuations and byte-identical content to today. (An ask with a field between the old cap
  and the new one renders longer by design; the identity claim is scoped to the common case.)
- A spilled option's full label and gloss appear whole in a continuation; nothing readable only
  in the menu.
- Every continuation is at or under `MAX_MESSAGE_LENGTH`; no line is ever cut mid-option.
- Both layouts' markers name the continuation, not the menu; a marker exists exactly when a
  continuation carries that question.
- An adversarial maximum ask (4 questions × 4 options, every field at its cap) stays inside the
  continuation cap or ends with the honest overflow tail.
- Re-rendering with selections yields identical content and markers (determinism for refresh).

Tests: at minimum, lock the zero-continuation identity for a fitting ask (the common case must
not regress), the whole-gloss guarantee for a spilled option in both layouts, the per-message
ceiling on every continuation, escape behavior in continuations (markdown-escaped fields, an
`@everyone` and a bracketed link neutralized as the body neutralizes them), and the overflow
tail in both directions (present past the cap, absent under it). The risk driving each: a cut
option is a decision made on half a sentence, and an unescaped continuation is untrusted content
live in the approval channel.

### 2. Delivery wiring

Model: opus

`broker/index.ts` (`questionUpgrade`, its construction sites) and `broker/index.test.ts`.

`questionUpgrade` gains a plain post seam (the steering writer's reply path against the ask's
thread). When the render yields continuations, they post sequentially after the entry is
confirmed live and before the prompt edit that references them; all landed, the upgrade
proceeds exactly as today. Any continuation post failing (refused, rate-limited, empty)
releases the hold with the ask's digest and logs a count-only line, landing exactly where a
failed upgrade edit lands today: the terminal rewrite sends the reader to the console. Zero
continuations means zero posts and today's path untouched.

One race is this section's to close, with a test: today nothing yields between the held-entry
read and the prompt edit (the code says so and leans on it), and sequential continuation posts
insert awaits into that window. An entry that resolves or expires mid-posting must not get the
prompt edit afterwards, or a closed message grows live components; the edit must confirm the
entry is still held inside the ordered drawing queue, the way the tap-refresh path already does.

Acceptance:
- With continuations, the thread receives them in order, then the notice becomes the prompt.
- A continuation failure releases the hold; the console picker renders; the marker-bearing
  prompt edit never runs, so no marker ever points at absent text.
- An entry that ends while continuations are posting never has components drawn onto its
  message after its close-out.
- No question content in any log line this section adds.
- The fitting ask posts nothing extra and upgrades exactly as before.

Tests: at minimum, lock the ordering (continuations on the wire before the upgrade edit), the
release-on-failure direction, the mid-posting race (close-out lands, prompt edit skips), and
the no-extra-posts identity for a fitting ask. The risk driving each: a marker pointing at
absent text sends the operator hunting for a message that does not exist, a silently swallowed
post failure parks a four-hour hold behind an unreadable ask, and components on a closed
message are taps that report failures.

## Out of Scope

- The pre-upgrade notice and the terminal outcome messages keep their existing bounds: both send
  the reader to a surface that holds the ask whole.
- The select menu's own 100-unit descriptions: Discord's wire limit, unfixable, and no longer
  the reading surface.
- Editing or deleting continuations at close-out; they stand as thread history.
- The permission prompt's rendering; only the question surface changes.

## Operator Verification

- On a live session, provoke a long ask (or wait for a real one): the thread shows the
  interactive message plus continuation(s), every option readable in full on the phone, and the
  pickers still answer it end to end. A cut option anywhere in the thread reopens S1; a marker
  with no continuation below it reopens S2.

## Open Questions

None.

## Chapters

