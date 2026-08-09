# Channels: answering a question from the thread

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session); overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_tailer-blackout_spec_v1.md](../archive/plans/channels_tailer-blackout_spec_v1.md): shipped the
  ask-time question alert and the `PreToolUse` hook entry this design turns into an answer
  channel. This plan begins where that one's backlog entry ("Answering a console question from
  the thread") left off; the entry is absorbed here.

## Goal

An `AskUserQuestion` parked at a console is answerable from the session's Discord thread: the
questions arrive as a readable interactive message (option pickers with descriptions, a typed
reply for free-form), the chosen answers ride back through the held `PreToolUse` hook response,
and the console picker never renders unless the operator releases the question to it or the hold
expires. Both surfaces clean up after whichever one answers.

## Measured shapes this spec builds on

All measured live on this host (operator-driven probe, 2026-08-09) or confirmed in upstream
documentation; none are guesses.

- **A held `PreToolUse` hook blinds the console.** The picker renders only after every
  `PreToolUse` hook has responded; during the hold the console shows the tool call thinking and
  counting seconds. There is no both-surfaces race: the hook response body is the only answer
  channel while it is held.
- **`updatedInput` answering works end to end.** A 2xx response whose JSON body carries
  `hookSpecificOutput.permissionDecision: "allow"` and
  `updatedInput: { questions, answers }` skips the picker entirely; the turn proceeds showing
  the injected answers as the operator's picks. Measured over an `http` hook's response body.
- **A `{}` (no-decision) response releases cleanly to the normal picker,** and a hook timeout is
  a non-blocking error with the same outcome. Every failure direction lands on today's behavior.
- **The answer vocabulary:** `answers` is a map keyed by exact question text; a single-select
  answer is an option label string; a multi-select answer is an array of label strings; a
  free-form reply is `response`, a sibling of `answers` inside `updatedInput` that replaces the
  per-question answers entirely.
- **Long holds are honored.** With the fragment `timeout` at 900, a hook held 6 minutes was
  answered normally: no client-side abort at the common 5-minute mark, and the turn proceeded
  with the injected answers. The hook `timeout` field is per entry, default 600s, no documented
  maximum. Ceilings past 6 minutes are unmeasured; the desk's client-gone trigger self-detects
  one if it exists, so overshooting costs one logged release, never a lost question.
- **The broker side already sustains held responses** (`/relay/stream` lives for the client
  process's lifetime); nothing in the repo sets server-level response timeouts that would kill a
  held hook response.
- **Discord facts:** select menus carry a per-option description (100 chars) natively, the
  readability surface the current alert lacks; `INTERACTION_CREATE` arrives with no additional
  gateway intent; interaction callbacks are their own REST surface and therefore their own rate
  bucket (per the `discord-edit-and-create-are-separate-rate-buckets` memory).

## Approach

**The question desk.** A new module beside the permission desk holds the `PreToolUse` hook
request open instead of answering it immediately. One entry per session (a second ask for the
same session attaches to the same entry if its digest matches, else the newer replaces after
releasing the older), a small host-wide cap, and a single resolution path with five triggers:

1. **Answered from Discord** (component interactions complete, or a typed free-form reply):
   respond `allow` + `updatedInput`; edit the thread message to show what was submitted.
2. **Released by the operator** (the Answer-at-console button): respond `{}`; the picker renders
   in about a second; edit the message to say so.
3. **Hold expiry** (the desk's own timer, margin below the hook timeout so the release is always
   the broker's clean `{}` rather than a CLI-side timeout error): respond `{}`; edit the message
   to "hold released, answer at the console".
4. **Client gone** (the response socket's `close` event fires first): no response possible; edit
   the message the same way. This also self-detects any undocumented client-side hold ceiling.
5. **Broker shutdown**: release every held entry with `{}` before exit.

Every trigger except the first degrades to exactly today's behavior: an alerted phone and a
console picker. Fail direction throughout: a lost hold must never eat a question.

**Gates unchanged from the alert path:** mirror-off sessions are never held (the hook is answered
immediately, as today); a volume-window drop releases immediately rather than holding a question
nobody can see; malformed input holds nothing.

**Console answer cleanup.** When the question is answered at the console (after a release or
expiry), the transcript line lands at that moment and the tailer's existing resolution-time yield
fires; where today it only skips the duplicate alert by digest, it now also tells the desk to
edit the thread message to "answered at the console".

**The interactive message.** One message per ask, replacing today's run-on notice:

- Header line: mention + question count + "answer here or at the console".
- Per question: a bold numbered title line (header + question text), then a select menu whose
  options carry label plus bounded description, min/max values set by `multiSelect`. The reader
  (`askedQuestions`) gains bounded option descriptions; both hook and tailer paths inherit them
  through the shared reader.
- Fast path: an ask that is a single single-select question with at most 4 options renders its
  options as one row of buttons (one tap on the phone) with descriptions in the message text as a
  numbered list.
- Control row: **Send answers** (submits; incomplete selections get an ephemeral "question N not
  answered yet") and **Answer at console** (release). Single-select-only asks auto-submit when
  every question has a value; any ask containing a multi-select waits for Send.
- A typed thread message while the session's entry is held becomes the free-form `response` for
  the whole ask, superseding any partial selections (decided 2026-08-09; it is the operator's
  recorded preferred shape, and steering could only queue against a frozen session anyway).
  Verdict parsing (y/n + code) stays ahead of it in the inbound pipeline.
- Terminal states always edit the message and remove components: answered-from-thread (with the
  submitted answers rendered), answered-at-console, released, expired.

**Security.** Interactions are a new inbound surface: every interaction's user id is checked
against the same one-account allowlist that gates thread messages; non-operator interactions are
ignored quietly. `custom_id` values are opaque desk references (never content); all state
resolves server-side. Option labels and descriptions entering components are untrusted
conversation text: invisibles stripped and length-bounded, but not markdown-escaped (components
render plain text), which needs its own helper beside `inertText` per the
`escaping-untrusted-text-for-discord` memory. Question content continues never to reach broker
logs.

**Interaction responses** are budgeted as their own route-verb bucket beside post and edit.

## Standing Brief Amendments

Folded into every later section's dispatch brief:

- The hold seam ships dark: `createHandler` receives no `questionDesk` until the section that
  ships the first answer route lights it (Section 2), and the lighting commit updates the
  activation-boundary comment in `broker/index.ts` and the production-wiring pin in
  `broker/intake.ts` that currently asserts a question post is answered immediately.
- When lighting the seam, rate-limit the desk's `refused a retry` log line through the `repeats()`
  pattern in `broker/tail.ts`: a CLI retrying past the per-entry response cap otherwise logs one
  unlimited line per attempt for the life of a hold.
- The desk's as-landed seams (verify signatures before use): `hold(sessionId, digest, questions,
  response, dispatched)` where `dispatched` is `tail.question()`'s boolean return; entry creation
  requires a dispatched delivery while a digest-matching attach does not; `release(sessionId,
  digest?)` releases only on digest match when one is given; `releaseAll(): Promise<void>` flushes
  before resolving; `onTerminal` is the message-edit seam.

## Sections of Work

### 1. The question desk and the held hook

Model: fable

The desk module, the intake changes that route a credited PreToolUse question post into it
(mirror-on, parse-yielding, window-allowing posts hold; everything else answers immediately as
today), the five resolution triggers, the digest interplay with the tailer's outstanding set, and
the install fragment's PreToolUse `timeout` raised to 14700 seconds with the desk's hold at
14400 (4 hours, env-tunable), margin-locked below the fragment value by a cross-component pin.

Files: `broker/question-desk.ts` (new), `broker/intake.ts`, `broker/index.ts`,
`hooks/settings-fragment.json`, `hooks/settings-fragment.test.ts`,
`install/Install-Functions.ps1` only if validation needs the timeout named, plus tests.

Acceptance: a held credited question post receives no response until resolution; each of the
five triggers produces its documented response (or none for a dead socket) and its message-edit
call; a mirror-off, malformed, window-dropped, or desk-full post is answered immediately with
`{}` and never held; broker shutdown releases all holds; the fragment pin asserts the PreToolUse
timeout exceeds the desk hold by the margin (cross-component pin, one source for the value).

Tests: lock both directions of every gate (held versus answered-immediately), the
socket-close-first race, the double-resolution guard (a Discord answer landing during expiry
resolves exactly once), and the digest set surviving a hold across broker-visible retries.

### 2. The interactive question message and the interaction surface

Model: fable

The message redesign (per-question select menus with descriptions, the fast single-question
button path, the control row), bounded option descriptions in the shared reader,
`INTERACTION_CREATE` handling in the gateway gated on the operator allowlist, the interaction
callback client with its own budget bucket, component state accumulation on the desk entry, and
the terminal-state message edits. This section also lights the hold seam (the first answer route
ships here), per the Standing Brief Amendments: `createHandler` gains the desk, the activation
comment and the production-wiring pin flip, and the refused-retry log line takes the `repeats()`
limiter. The message copy does not mention typed answers until Section 3 ships them.

Files: `broker/discord/render.ts`, `broker/tail.ts` (reader), `broker/routing/gateway.ts`,
`broker/discord/rest.ts` or a sibling interaction client, `broker/question-desk.ts`,
`broker/index.ts`, plus tests.

Acceptance: a 2-question ask (one single, one multi) renders one message with two selects and
the control row, every untrusted field bounded; selections accumulate and Send submits the
documented `answers` shape (string and array); the single-question fast path renders buttons and
auto-submits on tap; a non-operator interaction is ignored with no state change; every terminal
state edits the message and strips components; rendering stays inside Discord's caps (rows,
option counts, message length) for the maximum 4x4 ask.

Tests: lock the answers wire shape against the measured vocabulary (string, array, exact
question-text keys), the allowlist gate both directions, and one render pin per terminal state.

References: the mock in this plan's "Message mock" appendix.

### 3. Typed free-form answers and console-answer cleanup

Model: opus

The inbound router learns the desk: a thread message for a session with a held entry becomes the
whole-ask `response` (after verdict parsing, before steering delivery); the tailer's
resolution-time question yield notifies the desk so a console answer edits the thread message.

Files: `broker/routing/inbound.ts`, `broker/tail.ts`, `broker/question-desk.ts` seams, plus
tests.

Acceptance: a typed message during a hold resolves the entry as `response` and is not delivered
as steering; the same message with no held entry steers exactly as today; a verdict-shaped
message is consumed as a verdict even during a hold; a console answer after release triggers the
answered-at-console edit exactly once.

Tests: lock the pipeline order (verdict, then answer, then steering) in both directions, and the
no-hold passthrough.

### 4. Docs, deploy, and live re-verify

Model: fable
Locus: inline (docs are main-session work; deploy and live checks need operator coordination)

Architecture, security model (the new inbound interaction surface and the held-response
discipline), and operations ("When a session asks you a question" rewritten around answering in
the thread, the release button, expiry behavior, and the interim-off coupling). Sweep the tree
for now-false claims ("no remote answer path exists", the question notice docstring, operations'
"cannot be answered from the thread"), per the comment-sweep memory. Deploy via install update
plus broker restart (elevated hand), then the live checks in Operator Verification.

## Out of Scope

- **The usage/status card** (claude-swap account limits and agent health in Discord): its own
  effort, captured in the backlog on 2026-08-09.
- **The deny-chain re-ask contingency** (broker answers deny near expiry to make Claude re-ask,
  chaining holds indefinitely): recorded as a fallback if expiry-to-parked-picker stings in
  practice; burns model turns and the model may rephrase or stop asking, so it is not built now.
- **Per-question free-form mixing** (typing an answer for question 2 while selecting for
  question 1): a typed reply answers the whole ask; per-question Other can ride a later round
  (Discord modals are the natural surface).
- **The channel permission protocol**: its `allow | deny` verdict vocabulary is untouched.

## Operator Verification

- From the phone, with the console out of reach: answer a parked single-select by button, a
  multi-select by menu, and a third ask by typed reply; each console session proceeds with the
  chosen answers and each thread message shows what was submitted. A wrong or missing injected
  answer at the console reopens Section 2.
- At the console: tap Answer-at-console on the phone and confirm the picker renders within a
  couple of seconds; answer it and confirm the thread message flips to answered-at-console. A
  picker that never renders after release reopens Section 1.
- Let one question expire un-answered and confirm the picker appears at the console and the
  thread message says the hold was released. 

## Open Questions

None. The hold ceiling measurement resolved 2026-08-09 (6-minute hold honored, no early abort);
the shipped values are in Section 1.

## Message mock

```
@Scott ❓ **2 questions** · answer here or at the console

**1. Commit model** · Commit model for this effort?
**2. Sections** · Which sections ship first? *(pick any)*

[select: Commit-and-Push · Review-Only · Branch-and-PR]   (each with its description line)
[select (multi): Desk · Message · Docs]
[ Send answers ]  [ Answer at console ]

_Typing a reply here answers in your own words instead._
```

Fast path (single single-select question):

```
@Scott ❓ **Waiting on you** · answer here or at the console

**Commit model** · Commit model for this effort?
1. **Commit-and-Push** · land on main as sections complete
2. **Review-Only** · staged, reviewed before commit
3. **Branch-and-PR** · feature branch, PR at the end

[ Commit-and-Push ] [ Review-Only ] [ Branch-and-PR ]  [ Answer at console ]
```

## Chapters

### Chapter 1 - 2026-08-09
Completed: Section 1: The question desk and the held hook
Implemented By: implementer-fable (build round), implementer-fable (review-fix round, fresh
dispatch after a harness restart ended the first agent's context)
Metrics: 1 full review round (adversarial + blind + security, all at the session tier) plus the
fix round's red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the round's headline was the blind reviewer's Critical, aimed at the spec
rather than the code: Section 1 as written wired the hold live while nothing could answer it
until later sections, so a deployed-alone changeset would park an alerted question unanswerable
from anywhere for the full hold. Adjudicated as a spec staging gap and fixed by shipping the seam
dark (desk constructed and fully tested, `createHandler` given no hold seam until Section 2
lights it beside the first answer route); the activation boundary now rides the Standing Brief
Amendments block. The fix round resolved a real contradiction between two brief items (hold only
on a dispatched delivery, versus the composed-retry attach that dedupe makes deliveryless) by
gating entry creation on dispatch while allowing digest-matching attaches, discriminated by a
test pair under the same probe. Other review fixes, each red-proven: a per-entry response cap
(the entry cap bounded entries while identical reposts attached sockets unbounded), digest-scoped
release (both question paths share one delivery closure, so a session-keyed release let one ask's
failure end another ask's live hold), release-on-throw, shutdown flushing released bodies before
`closeAllConnections`, refusing already-dead responses at hold, an override-ceiling config test,
and a composed intake-level retry test. `questionDelivery` is new exported surface added as the
smallest testable seam while the desk is dark, and stop()'s flush-before-destroy ordering is
code-verified only until a live held socket exists (named check riding Section 2's review). The
verification gates flaked once on first run (a `live` versus `ended` assertion in files this
section never touched); five subsequent passes green (two full, three isolated), named flake, to
be pinned if it recurs. Mid-section, the session was silently downgraded off Fable by a
`model_consent_fallback` (the restart dismissed the credit-consent prompt), discovered during the
usage-card investigation and reversed by the operator at the console; the build round ran on
Fable, the fix round on Opus 5, and the finishing reviews will re-cover the section at full
strength regardless.
Review Findings: security CONCERNS (1 Major: unbounded per-entry attach, fixed); blind
CHANGES_REQUIRED (1 Critical: ship dark, fixed; 3 Major: no-dispatch holds, throw path, shutdown
flush, all fixed; 2 Minor: dead-response guard fixed, digest-scoped release fixed); adversarial
APPROVED_WITH_CONCERNS (2 Major: cross-ask release fixed, override-ceiling test added; 3 Minor:
stop-ordering pin riding Section 2, composed retry test added, dead-response guard fixed).
Security's two Minors: the security-model paragraph rides Section 4 by name, and the
long-hold-beyond-6-minutes measurement is accepted on the client-gone trigger's self-truing plus
the free measurement every real parked question provides.
Stamps: adjudicated 0 unstamped over the section span (the design-time stamps landed in-turn);
none surfaced at this boundary
Next: Section 2: The interactive question message and the interaction surface, which also lights
the hold seam
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-09
Completed: Section 2: The interactive question message and the interaction surface
Implemented By: implementer-fable (build round, then the review-fix round on a fresh dispatch)
Metrics: 1 full review round (adversarial + blind + security, all at the session tier) plus the
fix round's red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the round's most valuable finding was a fail direction that inverted
without any code changing: `MAX_QUESTIONS_PER_ASK` and the per-question option cap were written
to bound a glance notice, where truncation cost nothing because the operator went to the console
and saw everything. Bounding the answering surface, the same constants mean a dropped question
yields an `answers` map that does not cover the `questions` array passed back verbatim, and a
dropped option is an answer the operator cannot give and cannot see was omitted. The fix refuses
the thread-answer path for any ask the reader did not carry whole, releasing to the notice and
the console picker. Three reviewers independently converged on the button-label ceiling (80 for a
button, 100 for a select option; the fast path bounded both at 100), which would have silently
disabled thread answering for the common single-question ask, and the test that should have
caught it asserted the wrong bound so it could not fail. All three also caught the `__proto__`
question text, which security confirmed by execution: the answer vanishes from the map and the
terminal render then throws inside a notifier that swallows it, leaving a message that never
closes out with components that look live. Post-await edits could re-install live components over
a resolved hold at two sites; fixed with an ordering barrier rather than the prescribed
re-run-the-closeout (the implementer's reasoned deviation: a replay needs a terminal state and an
answers map nothing carries once the entry is gone, spends three edits to the barrier's two, and
still leaves a window). The implementer's own "no test can reach these lines" claim was rejected
with receipts by the adversarial reviewer: the module establishes the extraction pattern twice, so
the three seam-light-up branches were untested rather than untestable, and they are now extracted
and pinned. Bonus fix taken in the main session and flagged: `broker/tail.ts` carried the
byte-identical unbounded repeat-log sweep the desk's fix corrected, same failure mode and a
different key space; reverting it is the one hunk in `tail.ts`'s `repeats()`. Security cleared the
new inbound surface: the allowlist gate sits ahead of every read, write, and state change; entry
ids are 48-bit CSPRNG never derived from content, with every index re-resolved server-side; there
is no path from a Discord press to arbitrary text in `updatedInput`; and the label-escape split
(components strip but do not escape, content-bound fields escape) is correct.
Review Findings: blind CHANGES_REQUIRED (4 Major, 6 Minor); adversarial CHANGES_REQUIRED (4
Major, 5 Minor); security CONCERNS (0 Major, 6 Minor). All 16 deduplicated findings fixed, 6 of
them red-first. Riding as named checks: `min_values: 0` is the claim most likely wrong (nothing
proves Discord emits an interaction on a deselect-all rather than refusing it client-side), so
the live walk includes a deliberate clear-then-repick; the uncached-thread drop log has no test
because the discord.js-loading gateway module has no test file; and items 7 to 16 were tested
after their fixes rather than red-first.
Stamps: adjudicated 1, stamped 1 (claude-code-channel-and-hook-facts)
Next: Section 3: Typed free-form answers and console-answer cleanup, which also adds the
answered-at-console terminal state Section 2 deliberately left without a producer
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-09
Completed: Section 3's code, built and review-fixed. The section does NOT close here: a security
finding against the typed-answer return channel is with the operator, and its answer decides
whether the typed path ships as built, ships with the security model rewritten, or comes out.
Implemented By: implementer-opus (build round), implementer-fable (review-fix round)
Metrics: 1 full review round (adversarial + blind + security, all at the session tier) plus the
fix round's red-first evidence; 0 NEEDS_CONTEXT; 1 escalation (accepted, below); advisor off
Decisions / Surprises: the security review returned BLOCK on a Critical the orchestrator then
confirmed: a typed answer is written back down the HTTP request the question hook's poster owns,
and that post is credited on the process token plus payload session-naming alone, so a local
process holding the token can invent a question, have the broker ring the operator's phone with
it, and receive the operator's free text on its own socket. The strongest form of the finding is
not the capability delta (a process that can do this already reads every file the operator owns;
what is new is eliciting what is not on disk) but the contradiction with this project's own bar:
`docs/security-model.md` holds a phone-ringing prompt of the sender's devising to the
per-attachment reply key and says in terms that a process token is not enough, and the reply key
is minted per attachment and sent only down the relay's pipe, so a subprocess cannot inherit it.
The question path rings the same phone on the token alone. The operator's options and the
recommendation ride in the decision brief; the reviewer's own suggested fix (gate the hold on the
reply key) is assessed as illusory, because the hook is fired by a CLI that holds no such key and
putting one in the hook headers only creates another inherited env-var secret.
The blind reviewer flagged the orchestrator's own dispatch as partially contaminated: its brief
named "control-flow ordering defects in the inbound message pipeline" and "newly-required
options", which are diff-describing framings that would not read identically for every diff in
this repository. The reviewer hunted past them and its findings stand on the code, but the
dispatch was wrong and the rule it broke is the one that makes a blind review worth running.
Fixed this round, items 1 and 2 red-first: `answeredAtConsole` scanned its closed-ask ring
newest-first while records append oldest-first and resolution lines arrive oldest-first, so a
session that asked one question twice had the first answer flip the second message while the
answered one kept telling the operator to go answer it; and its live-hold early return fired
ahead of the record search, so a re-asked question left the older instance's message stale
forever. A flip was then undone in the same block, because the resolution-time alert still posted
for the ask just flipped. Close-out edits are now serialized against each other through the
in-flight map rather than only behind prompt draws, the hold-stands log line takes the repeat
limiter, `answerTyped` bounds its own input at the desk rather than trusting its caller, and the
composition docstring carries the measured figure the typed-answer footer changed.
Escalation accepted: the brief's item 4 (drop ring records for a session and digest when a hold
is created) was refused with a trace showing it makes both halves of the item 1 Major
unconstructible and, on the ordinary repeat-ask path, drops a record before its resolution line
can be read, which is the Major it was meant to complement. Residual accepted in its place: a
released ask abandoned rather than answered leaves a record a later identical ask's resolution
line can match, flipping the older message to answered-at-console when nobody answered it. The
narrower fix offered rather than taken, if it ever bites: drop older same-digest records when an
entry settles as answered.
Review Findings: blind CHANGES_REQUIRED (2 Major, 5 Minor); adversarial APPROVED_WITH_CONCERNS
(1 Major, 5 Minor); security BLOCK (1 Critical, 5 Minor). Fixed: both blind Majors and the
security and adversarial Minors listed above. Open pending the operator's decision: the Critical,
and the adversarial Major it interacts with (the verdict pattern `y|yes|n|no` plus five letters
swallows plausible typed answers such as "yes merge" and "no thank" before the answer path sees
them, which matters only if the typed path survives).
Stamps: none surfaced at this boundary
Next: the operator's decision on the typed-answer return channel. Then either close this Chapter
into Section 4, or amend the section first.
Commit Model: Commit-and-Push
