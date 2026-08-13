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

## Standing Brief Amendments

Folded into every later section's dispatch brief. Each earned its place from a review finding on an
earlier section.

- **A constant that must track another constant gets a cross-component pin.** Two components
  agreeing is not two checks: where a bound on one surface is only correct relative to a bound on
  another (an intake cap against a render cap, a field cap against the message ceiling), assert the
  relationship in a test so a later move goes red at the constant rather than in production.
- **Continuation posts spend the create-message bucket that permission prompts ride.**
  `steeringWriter`'s `reply`, `notice`, and `alert` share one post budget, and `alert` is the write
  permission prompts use. The question path's per-thread window admits 4 alerts per 60 seconds and
  bounded create-message spend only because each admitted alert cost exactly one post. Continuation
  posts must be gated under that same per-thread window, or a crafted ask multiplies the question
  surface's spend against the approval channel by up to sevenfold. Decided 2026-08-13 with the
  operator: continuations get their own per-thread window of 8 posts per 60 seconds, separate from
  the alert window's 4. Worst-case spend per thread falls from 28 posts per 60 seconds to 12, a
  legitimate long ask still posts whole, and a crafted flood has its continuations dropped and the
  hold released to the console, the fail direction every delivery failure here already takes.
  Counting continuations against the alert window itself was weighed and declined: an ask needing
  five or more continuations could then never post them, breaking the feature on exactly the long
  asks that motivated it.
- **`docs/security-model.md` states the post ceiling as the thing preventing approval-channel
  starvation.** Any change to what one admitted ask may post amends that document in the same
  changeset, so the doc an auditor reads describes the real ceiling.

## Sections of Work

### 1. Continuation rendering

Model: fable

`broker/discord/question-message.ts` and `broker/discord/question-message.test.ts`, plus
`broker/discord/render.ts` and `broker/tail.test.ts` for the intake cap below.

A question spills in two ways, and both reach the continuations: its options can run past its share,
and its own text can be cut by `titleRoom`. Each ends its block with a marker of its own, so a block
never ends looking whole when it is not, and the spill predicate is the marker rather than the
option count.

Every continuation opens with a fixed framing line that interpolates no untrusted content and stays
true after the hold ends. Without one a continuation's first line is the spilled question's own
words, drawn bold, at the top of a broker-authored message in the channel where tool approvals are
answered, and continuations are never edited, so that line would stand indefinitely. This is
`ATTRIBUTION`'s rule for split replies: a message scrolled to on a phone carries its own framing or
it carries none.

The intake bound on a description (`MAX_HELD_DESCRIPTION_LENGTH`) sits at no less than the body's
reading cap. Intake cuts with a bare slice and no ellipsis while a render site marks its own cuts,
so an intake bound below the reading cap hands every surface a description cut mid-sentence that
draws looking whole, which is the decision-on-half-a-sentence this plan exists to end. A test pins
the two constants in the required order.

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

The posts are spaced by `CONTINUATION_POST_PACE_MS` and the hold is re-read before each one. The
window ceiling bounds a count over 60 seconds and not a burst, and the create-message budget is one
instance shared across every thread, so an unpaced run of posts dense enough to earn a 429 would
block the alert route in every thread until it lifted. Re-reading before each post is what stops an
ask that was answered, expired, or shut down partway through from spending budget, window slots, and
thread space on a hold nobody is waiting on. A continuation failure releases by entry id rather than
by digest, so a hold that ended mid-posting cannot have its successor released in its place.

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

### Chapter 1 - 2026-08-13
Completed: 1. Continuation rendering
Implemented By: implementer-fable, with one review-fix round resumed on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at its default); NEEDS_CONTEXT 0; escalations 0; advisor opus
Decisions / Surprises: The section's headline promise failed for the question-text field itself.
Spill detection keyed only on the options marker, so a question whose own text was cut by
`titleRoom` produced no marker and no continuation. Reproduced before the fix: four cap-length
questions drew 174 of 1,500 characters each with zero continuations, roughly 5,300 units readable
nowhere. Raising the question cap made this worse than before the change, since the old 500-unit cap
bounded the silent loss at about 325 units. A question now carries its own spill marker and the
predicate is the marker, not the option count. Second surprise: raising the body description cap to
1,500 inverted it against the intake cap of 1,000 in `render.ts`, where the cut is a bare slice with
no ellipsis, so real descriptions would have been cut invisibly. Both are the "two components
agreeing is not two checks" shape, and both now carry cross-component pins. `MARKER_ROOM` is derived
from the marker strings rather than stated as a number, so a rewording cannot silently reintroduce
the spill it prevents; it moved from 60 to 68 when the markers were reworded to survive the
continuation cap.
Review Findings: 2 Critical addressed. (a) The title-truncation gap above, found independently by
the adversarial and blind reviewers and reproduced by probe before the fix. (b) The blind reviewer's
"nothing posts the continuations" is Section 2's wiring by design, not a defect; it is real while
Section 1 stands alone on origin, and Section 2 follows immediately in this effort. 3 Major
addressed: the intake cap inversion, the missing continuation framing line (an unframed continuation
opens on model-chosen bold text in the approval channel and is never edited), and the security
reviewer's post-budget finding, which arms only when posting lands and is carried into Section 2 as
a Standing Brief Amendment with its `docs/security-model.md` obligation. 3 Minor addressed: marker
wording that stays true past the continuation cap, a test pin coupling the field caps to the message
ceiling, and an off-by-one in the refinement round that counted the marker line as an option.
Deviation from spec: file scope expanded to `broker/discord/render.ts` (the intake constant) and
`broker/tail.test.ts` (its forced test consumer); the spec section is updated to match. The section's
fix round was verified by re-running the gates and re-running the original probe rather than by a
second full review round; the finishing pass reviews the whole changeset.
Stamps: adjudicated 1 surfaced, stamped 2 (`escaping-untrusted-text-for-discord`,
`three-stop-mirror-claim-tests-flake-only-in-parallel-runs`)
Next: 2. Delivery wiring
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-13
Completed: 2. Delivery wiring
Implemented By: implementer-opus, with one review-fix round resumed on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at its default); NEEDS_CONTEXT 0; escalations 0; advisor opus
Decisions / Surprises: The operator decided the rate question on 2026-08-13 (continuations get their
own per-thread window of 8 per 60 seconds, recorded with its rationale in Standing Brief
Amendments). Review then found the window bounds a count and not a burst: the create-message budget
is a single instance shared across every thread, so an unpaced run of posts dense enough to earn a
429 would block the alert route, which permission prompts ride, in every thread until it lifted.
Answered with `CONTINUATION_POST_PACE_MS`, one knob at 1,200ms, sized against an assumed and
explicitly inferred allowance of 5 posts per 5 seconds, since Discord publishes no number for that
bucket. A maximal six-continuation ask now takes 7.2 seconds before its interactive prompt appears.
Second surprise: the continuation loop had no liveness check, so a hold ending mid-posting kept
posting under its own close-out. The cosmetic reading of that (odd-looking thread) is not why it
matters; the dead posts spend the continuation window, so a later legitimate long ask in the same
thread could be refused and released to the console, breaking the feature on exactly the asks it
exists for.
Review Findings: 2 Critical addressed, both the same one converged on by the adversarial and
security reviewers: `docs/security-model.md` still claimed the 4-post alert ceiling bounded this
path's spend of the bucket permission prompts ride, which this change makes false. Amended in the
main thread, since the docs guard blocks subagent writes there. 2 Major addressed: the missing
per-post liveness check (converged, adversarial and blind) and the burst pacing (security). 5 Minor
addressed: release by entry id rather than digest so a mid-posting close-out cannot release a
successor holding the same ask, a log line that claimed a release it never checked, ordering tests
that could not distinguish sequential from concurrent posting and would have stayed green under a
`Promise.all` regression, a test comment overclaiming what it locked, and two change-narrative
comments. 1 Minor accepted and documented rather than fixed: continuations posted before a mid-ask
refusal stay in the thread, since continuations are never edited, so a released ask can leave framed
question text above a message rewritten to the console line. Named in the security model as an
accepted residue. 1 Minor left alone as out of scope: `steeringWriter.reply` does not end a thread's
narration block the way `notice` and `alert` do, which is pre-existing drift on that verb.
Process note: my blind-reviewer dispatch included one diff-describing sentence, which violates that
reviewer's input contract. It flagged the sentence and reviewed the diff alone, so the round stands,
but the dispatch was mine to get right.
Stamps: none surfaced
Next: finishing-work
Commit Model: Commit-and-Push

