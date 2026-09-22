# Judge Unmirrored Replies

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

Every reply that reaches a session's Discord thread and carries no `ASK:` line is read by the inbox
judge, whether or not that session mirrors its console. Today the judge reads a reply only after
the broker has seen a mirror post from its session, and every persona session the fleet supervisor
launches runs with its mirror off, so the `Fleet: Inbox` card is structurally empty for the whole
persona fleet. When this is done the card fills for a persona exactly as it fills for a mirrored
interactive session, the relay's own instructions tell every session how to mark an ask so the card
can show its text, and the four documents that promise mirror-off text stays on the machine say
what is true instead. The judge is Jev, a hosted classifier from the vendor TypeSafe, which the
broker calls under a key read from the file `CHANNEL_INBOX_JUDGE_KEY_FILE` names. It matters because the operator steers the fleet from a phone and the inbox
is the one place that lists who is waiting on him.

## Intent

**The frame, in the operator's words.** "It found that in the design, we have a structural gap
where the Judge can't see direct to Discord Replies to weigh them for the Fleet Inbox." "For our
Discord Personas, we need the second suggestion, and that's what I'd like to tackle as soon as we
reasonably can." The second suggestion, from the assistant session that diagnosed the gap: "change
the relay so an unmirrored session's reply-tool answers are judged too." The sketch the operator
approved with "Please proceed!" carried two lines on the switches: "No per-session opt-out from
the judge. The mirror-off switch was about thread noise, not the vendor, and no requirement names
a new switch," and "The host-wide mirror-off setting no longer keeps sessions off the judge either.
Only the card switch and the key file do."

**What done needs to do.** Judge a reply-tool answer from a session the broker has never seen a
mirror post from. Keep the two switches that already stop every send, the inbox card setting and the
judge key file, as the only ways to keep reply text from the vendor. Keep the steward-ask exclusion,
the secret screen and the length cut exactly as they are. Tell every relay session, in the relay's
own instructions, to open a reply that hands the operator a decision or an act with an `ASK:` line.
Make the security model, the architecture doc, the operations guide and the install guide state the
new rule.

**What done does not need to do.** It does not need a new per-session switch that keeps one session
off the judge while the card is on. It does not need to change the judge's questions, its threshold,
its screen or its cut. It does not need to touch how the persona supervisor launches sessions, or
what the persona plugin reads as a worker's ask of its steward. It does not need to teach the mark
in the kit's doctrine, which is the kit repository's own plan.

**Alternatives refused.**
- Teaching the mark in the kit doctrine alone: refused, because it reaches only a session that
  remembers to mark, and a persona that forgets is exactly the case the judge exists for.
- Launching personas with their mirror on: refused, because the threads then carry every turn
  rather than conversation, which is why the supervisor turns the mirror off.
- A new per-session judge switch: refused, because no requirement names a session that should stay
  unjudged while the card is on, and the two host-wide switches already close the path.

**Rulings after the spec shipped.** Decided 2026-09-22, on the finishing review's held Major: ship
with the steward-shape gap recorded rather than closed here. A supervised session's reply carrying
a line of the form `ASK: <question>? Recommend: <choice>` matches the steward-ask exclusion and
opens no item on the `Fleet: Inbox` card, even though that is the shape a session writes when it
follows the new instruction and attaches a recommendation. The reply still reaches the session's
Discord thread, since the tap runs only after the post has landed; what it misses is the card
entry. The operator's words on the gap: "I think I would want to at least see those messages, but
maybe have something appended to them noting that the Supervisor was informed?" That change
reworks the steward-ask exclusion, which `## Out of Scope` keeps out of this plan, so it is its
own plan, drafted at this plan's close and handed to the Architect seat to review, finalize and
dispatch. The earlier recommendation to add an instruction clause steering sessions to put the
recommendation on its own line was withdrawn, because it dodged the matcher rather than fixing
what the card shows.

**Provenance.** Distilled from the Architect seat's design exchange with the operator on the seat's
Discord thread, 2026-09-22, and the assistant session's diagnosis the operator forwarded in it.

## Approach

**The gate is one condition.** `inboxWiring` in `broker/index.ts` keeps a set of session IDs the
outbound router has reported a mirror post from, and `reply` submits an unmarked reply to the judge
only where the set holds the session (`mirrored.has(sessionId)`). The router fills the set at its
straggler gate (`broker/routing/outbound.ts`, the `options.inbox.mirrored` call), the wiring's
`reconcile` prunes it, a restart forgets it, and the start log line names it. The archived inbox
plan recorded the gate as a default the operator could overrule, with reversal cost "one
condition." This plan is that reversal.

**Retire the machinery, not just the condition.** With the condition gone, the `mirrored` seam on
`OutboundInbox`, the router's call into it, the set, the prune loop over it and the comment block
explaining the restart window serve nothing. They go, so the next reader does not find a signal
nothing consumes. What stays at the tap, in order: a reply from a session the registry (the
broker's record of live sessions) no longer holds opens nothing and is never judged; a supervised
session's reply carrying the steward-shaped ask opens nothing and is never judged; a reply with an
`ASK:` line opens or refreshes a marked item and is never judged; every other reply goes to the
judge where the judge is on, and nowhere when it is off. A supervised session is one the persona
supervisor launched, whose record carries a lineage. The steward-shaped ask is a line of the form
`ASK: <question>? Recommend: <choice>`, which the persona plugin reads as a worker's question to
its steward and which `hasStewardAsk` in `broker/inbox/ask.ts` matches with a copy of that
plugin's pattern. The judge's own module does not change.

**Teach the mark at the source.** The relay's server instructions (`INSTRUCTIONS` in
`relay/protocol.ts`) are what every relay session reads at start, persona or interactive, kit or not.
They gain one sentence telling the session to open a reply that hands the operator a decision, a
question or an act with an `ASK:` line. A marked item shows the ask's text on the card where a
judged one shows only a link, and the judge becomes the backstop it was designed to be.

**What still speaks the old contract.** The security model's judge paragraph lists "any reply from
a session no mirror post has reached the outbound router from" under what is never sent, and two of
its accepted residuals rest on that. The architecture doc's inbox section states the arming rule,
the restart window and that "neither the relay's instructions nor any kit skill names the mark."
The operations guide quotes the start log line, states the `-NoMirror` rule, the restart window and
that `CHANNEL_MIRROR=off` keeps every session off the judge. The architecture doc's External
integrations bullet says "each unmarked reply from a mirrored session". The install guide's
mirror-switch paragraphs say the two switches stop the conversation being mirrored "and nothing
else", which under the new rule leaves a reader believing the judge stops with them. Section 3
rewrites each of those.

**The sweep.** One Explore sweep ran over the worktree for the surfaces that state, implement, test
or document the arming rule, the mirror-off exclusion, the `CHANNEL_MIRROR=off` reading, or the
claim that no instructions name the mark, searching for `mirrored(`, `mirrored.has`,
`OutboundInbox`, `-NoMirror` beside the judge, "mirror post" beside the judge, "never judged",
"not judged", "of mirrored sessions", "arms the judge", "names the mark" and `ASK:` under `relay/`
and `docs/`. It returned the wiring (`broker/index.ts`, the `inboxWiring` docstring, the set, the
condition and the log line), the router seam (`broker/routing/outbound.ts`, the `OutboundInbox`
type and the straggler-gate call), five tests in `broker/index.test.ts` that arm the judge through
`inbox.mirrored`, one test in `broker/routing/outbound.test.ts` ("a mirror post that never passes
the straggler gate is neither shown nor counted as mirrored") whose second half pins the signal,
the four passages in `docs/architecture.md`, `docs/operations.md` and `docs/security-model.md`
named above, and the residuals at the security model's end. It also returned the intake
(`broker/intake.ts`), the transcript tailer (`broker/tail.ts`), the session launcher under
`wrapper/` and the config (`broker/config.ts`) where they implement the mirror switch itself; those
govern the thread and not the judge, and are out of scope. The sweep counted five tests in
`broker/index.test.ts`; a later read found nine, and section 1 carries the nine. Every section's
Files in scope was written from that return.

**Nothing new leaves the machine.** A reply-tool answer is on the operator's Discord thread before
the tap sees it, and the operator's ruling that every project may send text to TypeSafe already
covers the judge. The change widens which replies are judged and adds no new kind of text.

## Dispatch Authorization

The operator approved the sketch on the Architect seat's Discord thread on 2026-09-22 ("Please
proceed!"). The plan is written by the Architect seat and scheduled through the coordinator persona
for the discord-channels worker, so the grant covers the session that persona's queue assigns and
no other.

## Sections of Work

### 1. Retire the mirror gate
Model: opus
The tap judges every unmarked reply. In `broker/index.ts`, `inboxWiring` loses the `mirrored` set,
its `mirrored` method, the prune loop over the set in `reconcile`, and the condition on
`mirrored.has(sessionId)` in `reply`, so an unmarked reply from a session the registry holds is
submitted to the judge whenever the judge is on. The docstring above `inboxWiring` and the comment
block above the set are rewritten to the new order of checks and no longer describe a restart
window. The start log line becomes `broker: the operator inbox is on, and the judge reads unmarked
replies`. In `broker/routing/outbound.ts`, `OutboundInbox` loses its `mirrored` member and the
router's call into it at the straggler gate goes, with the comment that explained it. Untouched in
signature: the `InboundInbox` type in `broker/routing/inbound.ts`, and the `reconcile` and `items`
members of `Inbox` in `broker/index.ts`, whose `Inbox` type still intersects `OutboundInbox`, now
carrying `reply` alone. The `reconcile` docstring loses "and every mirror verdict".
Acceptance: the grep `grep -n "const mirrored\|mirrored(\|mirrored\.has\|mirrored:"
broker/index.ts broker/routing/outbound.ts broker/index.test.ts broker/routing/outbound.test.ts`
is run against the pre-change tree first and must speak there (19 lines at `f8ce674`, among them
`broker/index.ts:805`, `:808`, `:821` and `broker/routing/outbound.ts:40`, `:1125`) before its
silence on the changed tree counts; on the changed tree it returns nothing.
The word `mirrored` has a second sense in both files, a prompt or reply the mirror route posted,
and every line still holding the word after that grep is read once and kept only where it carries
that sense. `inbox.reply` on a session the registry holds, with no prior mirror post, makes one
judge call; the same reply with an `ASK:` line, or a steward-shaped line from a supervised
session, makes none; with no key file, no reply makes a call; `npm run lint` exits 0.
Files in scope: `broker/index.ts`, `broker/routing/outbound.ts`, `broker/index.test.ts`,
`broker/routing/outbound.test.ts`.
Tests: lock both directions of the widened tap. An unmarked reply-tool answer from a session with
no mirror post is judged, since a silent gate left behind is the defect this plan removes. An
`ASK:` reply, a supervised session's steward-shaped reply, and any reply with the judge off still
send nothing, since a send that slips past those is the expensive failure. The existing test "a
mirror-off session's reply-tool answer is parsed for ASK: and never judged" is rewritten to the new
rule rather than deleted. Nine tests in `broker/index.test.ts` call `inbox.mirrored`; the eight
others use it as a precondition, drop the call and assert the same outcomes, and the test "an
unmarked reply from a mirrored session is judged" is renamed to say the session is unmirrored.
In `broker/routing/outbound.test.ts`, the `watchedInbox` helper and the two inline inbox fakes
lose their `mirrored` member, the test "a landed reply mirror is shown to the inbox, and a prompt
mirror never is" drops its assertion that both posts were counted as evidence the mirror is on,
the test "a mirror post that never passes the straggler gate is neither shown nor counted as
mirrored" keeps its first half and loses its second, and the test "an inbox that throws never
turns a landed post into a failure" keeps its throwing `reply` alone. The withheld control is the
reply the old rule dropped, now asserted to reach the fake fetch.

### 2. The relay's instructions name the mark
Model: sonnet
`INSTRUCTIONS` in `relay/protocol.ts` gains one sentence that closes the reply-tool paragraph, the
constant's last, in the register the constant already uses: a reply that hands the operator a decision, a question or an
act only they can perform opens with a line beginning `ASK:` followed by the ask in one sentence,
because the broker lists such replies on the operator's inbox card until they answer, and reads an
unmarked reply with a classifier that can miss. The sentence names no setting, no file and no
model. `relay/protocol.test.ts` pins that the instructions contain `ASK:` beside its existing
`reply` and `operator` pins, and the existing pin that no environment value appears in the
instructions still holds.
Acceptance: `node --test relay/protocol.test.ts` exits 0 with the new pin; the added sentence is
one sentence; `relay/README.md` is read for a restatement of the instructions and updated only
where it quotes them.
Files in scope: `relay/protocol.ts`, `relay/protocol.test.ts`, `relay/README.md` (read; edit only
on a quote).

### 3. Documents
Model: opus
Locus: inline
`docs/security-model.md`: the judge paragraph's "What is never sent" list drops the clause about a
session no mirror post has reached the router from, and the sentence naming the `-NoMirror`
session's reply-tool answers with it; the residual "While the judge is on, every unmarked reply's
text leaves the machine" drops "from a mirrored session" and its closing sentence about
`-NoMirror`; the residual "The per-session mirror switch is advisory for the judge as it is for the
mirror" is replaced by one stating that the per-session mirror switch and the host-wide
`CHANNEL_MIRROR` setting do not reach the judge, that the inbox card setting and the key file are
the two switches that keep reply text from the vendor, and that a reply-tool answer is already on
Discord before the judge sees it. `docs/architecture.md`, the operator inbox section: the judge
paragraph drops the arming rule, the straggler-gate sentence and the restart sentence, and states
that the judge reads every tapped reply with no mark while its key file is usable; the sentence
"The one surface that teaches a session to write the mark is the persona plugin" and the sentence
"Neither the relay's instructions nor any kit skill names the mark" become one statement that the
relay's instructions name the mark for every session, the persona plugin teaches the steward shape
to its workers, and no kit skill names it; the persistence paragraph drops the mirrored-set
sentence; and the External integrations bullet for TypeSafe's Jev drops "from a mirrored session".
`docs/operations.md`: the quoted start log line, the `-NoMirror` sentence under "What opens an
item", the restart paragraph under "Edges worth knowing", and the `CHANNEL_MIRROR=off` sentence
under "Turning the judge off" are rewritten to the new rule. `docs/install.md`: the paragraph
"Neither switch makes a session private" gains one sentence that neither mirror switch reaches
the inbox judge, which reads a session's reply-tool answers while its key file is usable and the
inbox card is on. `docs/README.md` already carries this plan's row under Plans; the close-out
moves that row to the archive list, and this section does not touch it.
Acceptance: each passage named above is opened and read after the edit, and states the new rule.
The grep `grep -n "mirror" docs/security-model.md docs/architecture.md docs/operations.md
docs/install.md | grep -i "judge\|inbox\|-NoMirror"` is run as a second net, not the check: it
fires only where both words share one wrapped line, and every line it returns is read; the
passages it cannot see are the ones named above. `npm run lint` exits 0.
Files in scope: `docs/security-model.md`, `docs/architecture.md`, `docs/operations.md`,
`docs/install.md`.
Audience: the operator, expert in this system; a future session with no context, engineer level.
Must answer: what leaves the machine and which two switches stop it; what opens an item for an
unmirrored session; how a session marks an ask.
Voice: company. Fact base: the as-built modules of sections 1 and 2.

## Out of Scope

- A per-session switch that keeps one session off the judge while the card is on.
- The judge's questions, threshold, secret screen, length cut, host or model.
- The steward-ask exclusion and the persona plugin's matcher it copies.
- How the persona supervisor launches sessions, including `CHANNEL_SESSION_MIRROR`.
- The kit doctrine's own sentence about `ASK:` lines, which is a claude-kit plan.
- The mirror route, the interim tailer and the per-session mirror switch as they govern the thread.

The list is closed at these six items.

## Assumptions

- assumed 2026-09-22 (operator ruling on the sketch): no per-session judge opt-out; the card
  setting and the key file are the only off switches; reversal: adding an opt-out later costs one
  header read at the intake, one record field, one condition at the tap, and the documents.
- assumed 2026-09-22 (operator ruling on the sketch): `CHANNEL_MIRROR=off` no longer keeps
  sessions off the judge; reversal: one condition at the tap reading the host setting.
- assumed 2026-09-22 (operator ruling, 2026-09-21, recorded in the archived inbox plan, that every
  project may send text to TypeSafe): reply-tool answers from unmirrored sessions may go to the
  judge; reversal: the judge is off without its key file.
- assumed 2026-09-22 (operator ruling on the sketch): the kit doctrine sentence is a separate
  claude-kit plan; reversal: none here.
- assumed 2026-09-22 (default): the relay instructions sentence rides in this plan rather than the
  kit's, since the relay's instructions reach sessions the kit does not; reversal: drop section 2.
- assumed 2026-09-22 (default): the retired `mirrored` seam is deleted rather than left as a no-op;
  reversal: keep the method and the call, with the set unread.

## Operator Verification

- After the broker is updated on a host running personas, read the broker's start log for
  `the judge reads unmarked replies`. A line still reading `of mirrored sessions` reopens section 1.
- Watch one persona reply that asks something without an `ASK:` line reach the `Fleet: Inbox` card
  within one refresh interval, which is `CHANNEL_INBOX_CARD_REFRESH_MS` and defaults to 60
  seconds. A card that stays at `No open asks.` two intervals after such a reply, with the key
  file in place, reopens section 1.
- Read one persona's next reply that hands you a decision. An `ASK:` line at its top, drawn on the
  card with its excerpt, confirms section 2 reached the session; its absence on a session started
  after the update reopens section 2.
- Write a `## Threat model` section for `docs/security-model.md`. The document inventories what
  leaves the machine and now states that a reply-tool answer reaches the vendor whatever the mirror
  setting, but it names no attacker classes and no assets, so a security review of any later change
  has nothing to rule a finding against. This is the finishing pass's security lens reporting
  `threat model: absent`, carried here because writing the model is the operator's call rather than
  this plan's work. It is on `docs/backlog.md` too, so it survives this plan's archive.

## Open Questions

None.

## Related plans

- Builds on [`channels_operator-inbox_spec_v1.md`](channels_operator-inbox_spec_v1.md),
  whose assumption that a mirror-off session is never sent to the judge this plan reverses.

## Chapters


### Chapter 1 - 2026-09-22
Completed: 1. Retire the mirror gate
Implemented By: implementer-opus
Metrics: review rounds 1, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 2 findings, 1 fixed, 1 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 1 open | changes: removes the `mirrored` set, its seam on `OutboundInbox`, the router call, the prune loop and the `mirrored.has(sessionId)` condition, so the judge reads every unmarked reply from a session the registry holds | serves: the Goal sentence "Every reply that reaches a session's Discord thread and carries no `ASK:` line is read by the inbox judge, whether or not that session mirrors its console" | adds a mechanism: no, it removes one; no new unit of behavior runs | size: 19 grep-matched lines across four files at 96b8100, plus the docstring, comment block and log line | not building it costs: the `Fleet: Inbox` card stays structurally empty for the whole persona fleet, which is the defect the plan exists to fix.
  Then: the spec's "nine tests call `inbox.mirrored`" and the control grep's ten matching lines are both right; two call sites sit inside one test ("a reply or a verdict for a session the registry no longer holds opens nothing"). The performance lens was ruled not triggered and not dispatched: the delta removes a Set, its prune loop and a condition, so it takes work out of `reconcile` rather than adding any, and the external call it widens (`judge.submit`) is itself untouched and unawaited. The implementer put the new order of checks in the `inboxWiring` docstring alone rather than also above the retired set, since the set no longer exists to comment above; the adversarial lens then found it had left a second copy inline, which the Minor pass removed. It also renamed the straggler-gate test, which the spec did not ask for, because the old name asserted a rule this change removes.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: code pair plus security at fable, Workflow (blind low, adversarial low, security medium)`; adversarial APPROVED, blind APPROVED_WITH_CONCERNS, security 2 Minors. 0 Critical, 0 Major. Minors: 3 fixed in the close pass, 0 upgraded, 1 deferred with the reason.
  Fixed: the inline comment at the judge branch duplicated the `inboxWiring` docstring's rule, and two copies of one rule drift, so the inline copy is now one line; the docstring said a pruned session's reply is "never judged, whether it arrives at the tap or as a late verdict", which is imprecise because a late verdict's reply was submitted before the prune and its text had already left, so it now distinguishes the two; the rewritten test's title still read "a mirror-off session's reply-tool answer is judged", which after this section duplicates its neighbour, so it is retitled to name the judged-to-marked transition it uniquely pins.
  Deferred: the security lens's `npm audit` Minor (three pre-existing production advisories, `fast-uri` high, `hono` and `qs` moderate). `package.json` and the lockfile are unchanged against the base ref, so this section did not introduce them, and the item is already on `docs/backlog.md` at lines 460 and 592 from two earlier plans. No third entry written.
  Confirmed and not a finding: the blind lens's privacy-boundary Minor, that a mirror-off session's reply-tool text now reaches the vendor. That is this plan's intended effect under the operator's ruling that the mirror switch governed thread noise rather than the vendor, and the surface that must say so to the operator is section 3's `docs/install.md` paragraph.
Stamps: adjudicated 5, stamped 2 (`source-code-may-leave-the-lan-to-typesafe`, `typesafe-request-body-retention-risk-accepted`, both operator tier, both load-bearing for the security disposition above). Three skipped: read by dispatched agents rather than applied here.
Gate: targeted lane `node --test broker/index.test.ts broker/routing/outbound.test.ts` at section close: 209 tests, 209 pass, 0 fail, 0 skipped, exit code 0, 5.96s. Delta against the same lane's baseline captured before the first edit (209/209/0, exit 0, 5.93s): unchanged, no regressions. `npm run lint` (`tsc --noEmit`) exit 0. Whole-gate baseline recorded this run at `96b8100` on a worktree clean but for the plan doc: 1988 tests, 1987 pass, 0 fail, 1 skipped, exit 0, 43.3s. No contention lane: the section's delta is source code and touches no machine-shared state. Test delta: 0 added, 0 retired, 11 edited to stay green on the section's own change. Nine dropped the retired `inbox.mirrored` precondition and assert the same outcomes; one ("an unmarked reply from an unmirrored session is judged") was renamed and pins that the widened tap reaches the fake fetch, which is the section's withheld control; one ("a later ASK: on a judged session turns its open item from judged into marked") was rewritten to the new rule and widened to pin the item's source, the marked upgrade's source and excerpt, and that the marked reply adds no second judge call. 0 added tests spawn a process. Acceptance grep control: the predicate `grep -n "const mirrored\|mirrored(\|mirrored\.has\|mirrored:"` over the four in-scope files returned 19 lines at `96b8100`, including all five file:line anchors the spec named, and returns nothing on the changed tree, exit 1. 45 surviving lines hold the word in its second sense (a prompt or reply the mirror route posted) and were read and kept.
Next: 2. The relay's instructions name the mark
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at this commit.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-22
Completed: 2. The relay's instructions name the mark
Implemented By: implementer-sonnet
Metrics: review rounds 2, closed major-closed; provenance 2 spec-traceable, 1 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 2 open | changes: appends one sentence to `INSTRUCTIONS` in `relay/protocol.ts` telling a session to open an ask-bearing reply with an `ASK:` line, and pins it in `relay/protocol.test.ts` | serves: the Goal sentence "the relay's own instructions tell every session how to mark an ask so the card can show its text" | adds a mechanism: no; the sentence is prose the model reads, and no new unit of behavior runs | size: 5 wrapped lines of the constant, ~330 bytes | not building it costs: every session stays dependent on the classifier, and a marked item's excerpt never reaches the card.
  round 2 Major (fix-introduced) | changes: replaces two `assert.match` calls that pin the new sentence's exact wording with one that pins the requirement, a wide alternation over the markup the sentence must refuse, and widens the delimiter class of the `assert.doesNotMatch` regression pin | serves: the same Goal sentence, by keeping the pin that guards it from a trim while letting the sentence be reworded | adds a mechanism: no; two assertions become two assertions and nothing new runs | size: 3 assertions edited, 0 added, 1 dropped | not building it costs: the test goes red on any reword that preserves every real constraint, which is a pin on a choice and trains the next session to delete it.
  Then: the advisory lenses were ruled not triggered and not dispatched. The delta is a prose constant the model reads plus one test file: it spawns no process, runs on no per-tool-call path, holds no lock, and changes no input handling, secret, grant or external boundary that this section owns. The judge's own call to the vendor is section 1's and is untouched here. One collision is documented rather than fixed, since the plan's `## Out of Scope` keeps the steward-ask exclusion out: a supervised session writing `ASK: <question>? Recommend: <choice>`, the shape the kit doctrine's own every-ask-carries-a-recommendation rule encourages, is matched by `hasStewardAsk` and opens no inbox item at all. The new sentence was softened not to promise the card lists every marked reply, which is what round 1's second Major named.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: code pair at opus, Workflow (blind high, adversarial high)` for round 1; `review: adversarial at sonnet, Workflow (high)` for round 2. Round 1 returned 2 Majors, both spec-traceable and both fixed: the sentence showed the mark as `` `ASK:` ``, a form `findAsk` returns null for, so a session reproducing what it was shown writes a line the broker refuses; and the sentence promised the operator's inbox would carry the ask, which over-states what the card does for a supervised session. Round 2 returned APPROVED_WITH_CONCERNS with 1 Major and 1 Minor. The Major is fix-introduced, sitting in lines round 1's fix wrote and tracing to this section's acceptance clause that the test "pins that the instructions contain `ASK:`": two `assert.match` calls pinned the sentence's exact wording rather than any contract, so a reword preserving every real constraint would turn them red, which is a pin on a choice. Fixed by pinning the requirement instead, on an alternation over the markup the sentence must refuse. The Minor, that the delimiter class was narrower than its own comment claimed, sat on the same assertion and was fixed in the same edit rather than deferred to the close pass. 0 Critical. Majors: 3 total, 3 fixed, 0 justified-not-fixed. Minors: 1 fixed in the fix round, 0 upgraded, 0 left with a reason, 0 carried to a close pass. No design stop fired: neither fix added a mechanism. The fix delta owes no round under the fix-delta bar (no outward action, no new module, and its subject is two assertions whose behavior a withheld control proved in both directions), so it took the below-bar author re-read instead, which caught one defect of its own: deleting the first assertion stranded its comment lines above the new one, leaving the block reading as two openings. Corrected before the gate.
Stamps: adjudicated 9, stamped 3. The `memq unstamped --since 4h` sweep listed 7; 1 was stamped (`a-system-checking-review-cannot-catch-a-record-only-defect`, applied when reading this Chapter's counts against their own enumeration) and 6 skipped as read but not load-bearing. 2 more came from the resume `memq recall` outside the sweep window and were stamped: `a-control-must-be-constructed-not-nominated` (the round 2 control's cases were constructed and withheld from both patterns rather than nominated from the live text) and `clean-check-covers-only-what-it-covered` (which is the shape of the Minor itself). No hand walk was owed: the window covers the whole stretch since Chapter 1.
Gate: targeted lane `node --test relay/protocol.test.ts` at section close: 8 tests, 8 pass, 0 fail, 0 skipped, exit code 0, 189ms. Baseline captured on that same lane at `b7dc33f` in a detached worktree at `D:/Temp/jur-baseline`, since no relay-lane baseline had been recorded: 7 tests, 7 pass, 0 fail, 0 skipped, exit 0, 247ms. Delta: +1 test, no regressions. `npm run lint` (`tsc --noEmit`) exit 0. Exit codes read from `${PIPESTATUS[0]}` on each run rather than from its output. No contention lane: the section's delta is a source constant and a test, and touches no machine-shared state. Test delta: 1 added, 0 retired, 1 edited. Added: "the instructions teach the ask mark in the one form the broker's own reader accepts", which pins that the instructions name the markup they refuse, that they show the mark behind no markdown decoration, and that `findAsk` accepts the bare form and refuses the four decorated ones. Edited: "the instructions are a static literal with nothing interpolated into them" gained an `/ASK:/` presence line beside its `reply` and `operator` pins, which is the section's own acceptance. 0 added tests spawn a process. Withheld control for the two absence-shaped assertions, at `.kit/scratch/judge-unmirrored-replies/2/control-round-2.mjs`: 7 cases, exit 0. It speaks on every defect state (a trim dropping the markup refusal, the round-1 backticked text, a bold-wrapped mark, a bulleted example, a blockquoted example) and stays silent on the live constant and on the reviewer's own proposed reword, which was withheld from both patterns and matched on shape. Box polled before the gate with no foreign runner or build visible, a sample rather than a clearance; the claim file was written and released on this session's own id.
Next: 3. Documents
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `b7dc33f` carrying section 2's two unstaged files.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-09-22
Section 3 (Documents), inline, in review round 2. Round 1 was the document pair at fable, low, through Workflow: two blind readers (the operator persona, a fresh engineering session) and the prose reviewer. The prose reviewer returned CHANGES_REQUIRED with 1 Critical, 2 Majors and 5 Minors, all on this section's own passages, and all fixed. The Critical and both Majors were one defect: the security model said a mirror-off session is judged exactly as a mirrored one, while `broker/intake.ts:683-687` and `:733-747` drop that session's turn-final replies before the tap, so only its reply-tool answers reach the judge. The spec's instruction to drop "from a mirrored session" with no qualifier led there; the documents now say every reply that reaches the thread is judged. The two readers returned 9 Majors (8 distinct) and 28 Minors, none on this section's passages; they went to `docs/backlog.md` as one entry, with the straggler gate's lost definition as a second entry. The round 1 delta capture was not taken before the fixes; `.kit/scratch/judge-unmirrored-replies/3/fix-round-2.diff` holds the section's delta after them.
Live dispatch: `wqlgy1e2k`, one prose reviewer at opus, high, through Workflow, over the whole section 3 delta, asked to confirm each round 1 finding resolved and to review the delta afresh. The fix delta was prose-only and owed no round; this one was added by choice, because the Critical was a false statement about what leaves the machine.
Gate baseline: `npm run lint` exit 0 at 14:30 UTC on the worktree at `14efce7` with the four documents, `docs/backlog.md` and this plan doc dirty; the section changes no code, so no test lane applies.
Rulings since the last boundary: none.
Next: adjudicate round 2, write Chapter 3, commit and push, then finishing-work.

### Chapter 3 - 2026-09-22
Completed: 3. Documents
Implemented By: main session (Locus: inline, tier opus; a docs/ write is always the main thread's)
Metrics: review rounds 2, closed major-closed; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0. The document pair sits outside the provenance read, so its findings are counted on the Review Findings line rather than here.
Decisions / Surprises: section 3 open | changes: rewrites the passages in `docs/security-model.md`, `docs/architecture.md`, `docs/operations.md` and `docs/install.md` that state the retired mirror gate, so each states that the judge reads every unmarked reply from a session the registry holds and that the inbox card setting and the key file are the only two switches that keep reply text from the vendor | serves: the Goal sentence "the four documents that promise mirror-off text stays on the machine say what is true instead" | adds a mechanism: no; prose only, and no unit of behavior runs | size: 9 passages across 4 files, net about 30 lines removed | not building it costs: four published documents keep promising that `-NoMirror` and `CHANNEL_MIRROR=off` keep reply text off the vendor, which after section 1 is false, and a false privacy claim on the surface an operator reads to decide what leaves the machine is the costliest kind of wrong.
  round 1 fixes (prose-reviewer Critical and two Majors, one defect) | changes: narrows the security model's judge passage and residual, and the architecture judge paragraph, from "a mirror-off session is judged exactly as a mirrored one" to "every reply that reaches the thread is judged; a mirror-off session's turn-final replies are dropped at the intake, so only its reply-tool answers reach the tap", and brings the operations guide and install guide to the same statement | serves: the Goal sentence "the four documents that promise mirror-off text stays on the machine say what is true instead", which the first draft over-corrected past the truth | adds a mechanism: no; prose only | size: 4 passages rewritten, 2 journey-shaped sentences and 1 duplicated rationale deleted, net about 10 lines | not building it costs: the security model states that turn-final text from a -NoMirror session goes to the vendor, which the intake at broker/intake.ts:683-687 and :733-747 refutes, and a false sentence on the document that inventories what leaves the machine.
  round 2 fix (prose-reviewer Major, fix-introduced by orchestrator trace) | changes: splits the security model's "Neither mirror switch" residual so "never reach the judge" holds of `CHANNEL_MIRROR=off` alone, and restores the advisory bound on `-NoMirror`, since a process holding the token can post a turn-final reply without the off header and have it tapped and judged | serves: the Goal sentence "the four documents that promise mirror-off text stays on the machine say what is true instead" | adds a mechanism: no; prose only | size: 1 bullet rewritten, about 3 lines added | not building it costs: the document that inventories what leaves the machine states an absolute the per-session switch does not enforce, contradicting its own line 78.
  Then: the spec told the security model to drop "from a mirrored session" with no qualifier, which the first draft followed into a false statement, that a mirror-off session is judged exactly as a mirrored one. The as-built intake drops that session's turn-final replies before the tap, so the documents say every reply that reaches the thread is judged, and name the reply-tool answers as what reaches the tap from a mirror-off session. This is a departure from the spec's wording in service of its Goal, not of its intent. The advisory lenses were ruled not triggered: the delta is four documents and a backlog file, and no code runs differently. The round 1 delta capture was not taken before round 1's fixes, so round 2's Major was traced to round 1's fix lines by the orchestrator's own record of what that fix rewrote rather than by a capture difference. The steward-shape collision (a supervised session writing `ASK: <q>? Recommend: <c>` opens no item) stays documented in `docs/operations.md` and out of scope under the plan's `## Out of Scope`. The interim board entry's lint moment reads "14:30 UTC"; the run was before round 2's dispatch at 14:18 UTC, so that stamp is wrong by some minutes and this Chapter's gate pin supersedes it.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: document pair (2 readers) at fable, Workflow (blind-reader low, prose-reviewer low)` for round 1; `review: prose-reviewer at opus, Workflow (high)` for round 2, added by choice since round 1's fix delta was prose-only and owed none, because its Critical was a false statement about what leaves the machine. Round 1: prose-reviewer CHANGES_REQUIRED, 1 Critical, 2 Majors, 5 Minors, all on this section's passages and all fixed (the Critical and both Majors were the one over-correction above). The two readers returned 9 Majors (8 distinct) and 28 Minors, none on this section's passages; routed to `docs/backlog.md` as one comprehension-pass entry, with the straggler gate's lost definition in `docs/` as a second entry. Round 2: prose-reviewer CHANGES_REQUIRED, confirmed every round 1 finding resolved, and returned 1 Major and 9 Minors. The Major, orchestrator-traced to the Goal sentence above and to round 1's fix lines: the rewritten residual said `-NoMirror` and `CHANNEL_MIRROR=off` alike mean turn-final replies "never reach the judge", which is true of the host-wide setting (`broker/intake.ts:684-688`) and false of the per-session header (`:733-747`), contradicting the document's own line 78. Fixed. Minors: 8 fixed in the fix round (the "mirror switches advisory" plural; the "widens who has read" framing, now "sends it to a second third party"; install.md naming TypeSafe and pointing to the key-file step; install.md's "every" narrowed by the secret screen; install.md's off-switch pointer matching the operations steps, restart included; architecture's "No kit skill names the mark, so" non-sequitur split in two; an "are"/"is" agreement slip; operations' antecedent-less "exactly as before"), 0 upgraded, 1 left with the reason: the "`CHANNEL_MIRROR=off` is not one of them" negation frame stays, because it names the one setting earlier releases told an operator kept text local, and deleting it drops the fact that reader acts on. The round 2 fix delta is prose-only and owes no round; its author re-read caught two defects of its own ("secret screen" is jargon at that point of the install guide, now "screen for secrets"; "turn the judge back on" misdescribed what a header can do, now "undo either one") and a reflow. The reviewer's no-source claim that the persona supervisor launches every channel-attached persona with the mirror off was confirmed on the installed plugin at `supervise.sh:2558`. 0 Critical outstanding, 1 Major fixed, 0 justified-not-fixed.
Stamps: adjudicated 6, stamped 2 (`claims-sections-need-more-review-rounds-than-code-sections`, which shaped the choice to run round 2 on a delta that did not owe it; `docs-write-guard-blocks-subagent-doc-writes`, the reason this section ran inline), both operator tier. 4 skipped as read but not load-bearing. `memq unstamped --since 2h` covers the whole stretch since Chapter 2.
Gate: prose section, no test lane applies. `npm run lint` (`tsc --noEmit`) exit 0, read from the run's own exit status, at 2026-09-22 ~14:22 UTC on SCOTT-CLAUDE against the worktree at `9e5df75` with the four documents and `docs/backlog.md` dirty; baseline on that lane exit 0 at `14efce7`; no change. Em-dash control over the delta's added lines: 0 matches, with the pattern speaking on the one pre-existing literal at `docs/operations.md:415`, which is a quoted constant outside the delta. The spec's second-net grep was run after round 1 and every line it returned was read. Test delta: 0 added, 0 retired, 0 edited. No contention lane: no machine-shared state touched.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `9e5df75` carrying section 3's five dirty files.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 2 - 2026-09-22
All three sections are closed and pushed; `a49f2a9` carries section 3 and Chapter 3. The finishing
pass is in step 1 through 3, on its second dispatch of the reviewer wave.
Live dispatches: the finishing wave at `wf_d06708f8-ab2` (task `wdg6mitdq`), asked for QA
verification, the security and adversarial lenses over the whole changeset, and the prose lens over
the four documents, at base `96b8100`. The `qa-verifier` returned PASS at 14:27 UTC and its result
replays from the run's cache. The first pair of fable reviewers (`a551b638f11f73138` security,
`a75a75964368bb79f` adversarial) each stalled after taking turns at 14:29 UTC, answered no probe by
15:05, and were stopped at 15:53. The resumed run's pair (`a60dba9ee43b78808`, `a6a76d9e5bfe86062`)
holds both never-started counts at zero an hour after dispatch and was probed at 16:53. The prose
lens has not started in either dispatch. `.kit/scratch/judge-unmirrored-replies/finishing/wedges.md`
holds the chain. If the probe window closes with the counts still zero, the pair meets the
unavailability rule's second trigger and the round compensates at opus, effort max.
Gate baseline: the whole gate at `a49f2a9`, run by the verifier at 14:27 UTC on a clean worktree:
1989 tests, 1988 pass, 0 fail, 1 skipped, exit 0, 45.2s, against 1988/1987/0/1 at `96b8100`.
Rulings since the last boundary: none.
Next: read the probe, then either adjudicate the returned reviews or compensate the round; then the
goal read, the performance lens, the docs curator, the final Chapter, the archive, the handoff gate
and the pull request.

### Interim board 3 - 2026-09-22
The finishing pass has cleared steps 1 through 5. What remains is the final Chapter, the handoff
whole gate, and the pull request, and one operator decision gates the last of those.

Correction to interim board 2. That entry recorded the resumed run's pair as holding both
never-started counts at zero an hour after dispatch. That reading was wrong, and the cause is the
path rather than the instrument: a resumed Workflow run writes its agents' transcripts into the
original run id's directory, and no directory exists under the resumed handle at all. Both agents
were working the whole time. They sit at `subagents/workflows/wf_d06708f8-ab2/` with 26 and 32
assistant lines, and both returned full reviews. No compensation round was needed or run.

Reviews, all at fable and effort high. Adversarial: APPROVED_WITH_CONCERNS, 1 Major, 4 Minors; its
resolved model reads `claude-fable-5-1` on its own transcript, so the tier held. Security: CLEAR,
0 Critical, 0 Major, 3 Minors, opening `threat model: absent`. Performance: CLEAR, 2 Minors, both
rated nothing-to-fix. Goal read: RULED, 5 built-but-unasked all ACCEPT-AND-DECLARE, 0
asked-but-unbuilt. Each declare was checked against the item itself; two of the judge's line
citations pointed at lines that do not exist or hold unrelated text, while every claim held in
substance at another location.

The adversarial Major is held and is the operator decision below. A doctrine-shaped ask,
`ASK: <question>? Recommend: <choice>` on one line, matches `STEWARD_ASK` at
`broker/inbox/ask.ts:79` and is dropped for a lineage-carrying session at `broker/index.ts:808`
before both the mark read and the judge. The scope adjudicator ruled ASK on the ground that the fix
reopens a risk the plan accepted.

Minor close pass, run and gated. Four fixes: the judge off-switch wording in `docs/install.md` and
`docs/operations.md` now names unsetting `CHANNEL_INBOX_JUDGE_KEY_FILE` rather than removing a key
from `broker.env`, which contradicted `docs/security-model.md:703-704`; a comment seam at
`broker/index.ts:735`; and the markup pin at `relay/protocol.test.ts:80`, anchored to the mark's
own sentence. The pin's tightening was proved with a withheld control: a trimmed clause carrying
innocent decoy words elsewhere passes the old pattern and fails the new one.

Documentation curation, adjudicated. Three drift items, all `deviation`, none blocking; the record
is at `.kit/scratch/judge-unmirrored-replies/finishing/drift-adjudication.md`. Two are the known
spec-wording departures from sections 2 and 3. The third is the curator's own find and is fixed: the
rename carve-out at `docs/operations.md:188` claimed `-NoMirror` keeps a session's transcript
content on the machine, which section 1 made false. Its replacement prose was rewritten to house
style. Two library-hygiene rows for the close-out: `docs/README.md:34` and
`docs/plans/README.md:6` both still describe the plan as parked and Ready.

Gate: targeted lane at the Minor pass, `node --test relay/protocol.test.ts broker/index.test.ts`,
64 tests, 64 pass, 0 fail, exit 0 read from the run; `npm run lint` exit 0. The handoff whole gate
has not run yet and runs after the last tree change.

Rulings since the last boundary: the threat model is absent and is carried to this plan's
`## Operator Verification` and to `docs/backlog.md`, so it survives the archive.

Operator decision in flight, asked on the Discord thread and not yet answered. The operator's reply
reframed it: he wants such asks visible on the card, marked as ones the supervisor was also told
about. That is a change to the steward-ask exclusion, which `## Out of Scope` keeps out of this
plan. The recommendation put to him is to ship this branch with the gap recorded and write the card
change as its own plan, and it withdraws the earlier recommendation to add an instruction clause,
which was a dodge around the matcher rather than a fix.

Live dispatch: the finishing prose lens over the four documents, which never started in either wave
1 dispatch and is the one lens still ungated. The documents changed after their section review, so
it is owed rather than waived.

Next: read the prose lens; then the operator's answer, the final Chapter, the archive and the two
index rows, the handoff whole gate, and the pull request.

### Chapter 4 - 2026-09-22
Completed: finishing pass
Implemented By: main thread (the Minor pass, the prose fixes and the close), with qa-verifier, adversarial-reviewer, security-reviewer and performance-reviewer at fable/high through Workflow, prose-reviewer at fable, scope-adjudicator twice at fable through the Agent tool, and docs-curator; the close ran in a second session after the first was restarted for a harness update
Metrics: review rounds 1 (the finishing wave; its prose lens never started in either wave dispatch and ran on its own after the Minor pass, over the documents as they then stood), closed major-closed; provenance 1 spec-traceable (the held steward-shape Major, traced to the Goal sentence "the card fills for a persona exactly as it fills for a mirrored interactive session"), 1 fix-introduced (the prose lens's Major, in a sentence this pass's curator fix wrote), 0 new-requirement, rulings (0 refused, 0 declared, 1 asked); advisory: 0 findings at Critical or Major, security CLEAR opening `threat model: absent`, performance CLEAR; drift 3 items, 0 mistake, 3 deviation; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "Every reply that reaches a session's Discord thread and carries no `ASK:` line is read by the inbox judge, whether or not that session mirrors its console. Today the judge reads a reply only after the broker has seen a mirror post from its session, and every persona session the fleet supervisor launches runs with its mirror off, so the `Fleet: Inbox` card is structurally empty for the whole persona fleet. When this is done the card fills for a persona exactly as it fills for a mirrored interactive session, the relay's own instructions tell every session how to mark an ask so the card can show its text, and the four documents that promise mirror-off text stays on the machine say what is true instead. The judge is Jev, a hosted classifier from the vendor TypeSafe, which the broker calls under a key read from the file `CHANNEL_INBOX_JUDGE_KEY_FILE` names. It matters because the operator steers the fleet from a phone and the inbox is the one place that lists who is waiting on him."; What the tree does now: when a session answers through the reply tool, the broker posts the answer to its Discord thread and then shows it to the inbox. An answer opening with an `ASK:` line puts the ask's own text on the Fleet: Inbox card. Any other answer goes to TypeSafe's Jev classifier, whether or not the session mirrors its console, so persona sessions now reach the card the way interactive sessions always did. Every session reads a sentence at startup telling it to open an ask with that line. Turning the inbox card off, or leaving the judge's key file unset, are the only two ways to keep reply text from TypeSafe; neither mirror switch reaches the judge. One gap stays open by ruling: a persona's ask written as a question and a recommendation on one line reaches its thread but not the card; Refinements during the run: section 1 carried nine tests calling the retired seam rather than the five the sweep counted, and renamed the straggler-gate test whose old name asserted the removed rule; section 2 shipped a softer sentence than the spec's draft, promising no card listing, because a supervised session's steward-shaped ask opens no item, and its pin was rewritten to guard the requirement rather than the wording; section 3 narrowed the documents from "a mirror-off session is judged exactly as a mirrored one" to "every reply that reaches the thread is judged", since the intake drops a mirror-off session's turn-final replies before the tap; the finishing curator found and fixed a false privacy claim outside the four named documents, the operations guide's `-NoMirror` rename carve-out; the operator ruled 2026-09-22 to ship with the steward-shape gap recorded and to plan the card change separately, withdrawing the earlier instruction-clause recommendation; Operator-pending: read the broker's start log for `the judge reads unmarked replies` after the update; watch an unmarked persona ask reach the card within one refresh interval; read one persona's next decision reply for an `ASK:` line on the card; decide whether the security model's threat model section is written as its own effort; decide the card-change plan once the Architect seat returns it
Decisions / Surprises: Finishing base ref 96b8100942720767ac6cbe13fe100b022b908eda, the merge-base with main, which origin/main still equals at this close, so no update merge was taken. The changeset listing matched the union of the three sections' Files in scope plus the plan doc and `docs/backlog.md`. Goal read declares, accepted and checked against the items themselves: the backlog entry recording the straggler gate's lost description; the backlog comprehension-pass entry on the two blind readers' findings; the tap-versus-verdict comment at `broker/index.ts:731`; the instruction sentence widening to "a decision, a question, or an act" with its plain-text rule at `relay/protocol.ts:89-92`; and the judged-to-marked pin at `broker/index.test.ts:1998`. Two of the goal read's citations named lines that do not exist or hold unrelated text, while every claim held in substance elsewhere. The held adversarial Major: `STEWARD_ASK` at `broker/inbox/ask.ts:79` matches a one-line `ASK: <question>? Recommend: <choice>`, and `broker/index.ts:808` returns before the mark read and the judge for a session with a lineage, so a persona following the new instruction with a recommendation attached opens no card item. The scope adjudicator ruled ASK, the fix reopening the exclusion `## Out of Scope` keeps out; the operator ruled to ship with the gap recorded (the `## Intent` ruling, dated), which makes the Major justified-not-fixed on that ruling, and the card change is a separate plan handed to the Architect seat. The first session's interim board 2 read a resumed reviewer pair as never started; the cause was the reading's path, since a resumed Workflow run writes into the original run id's directory, and board 3 corrected it. Drift: D1 and D2 are the section 3 and section 2 spec-wording departures above, recorded for the pull request; D3 is the `-NoMirror` carve-out, fixed. Hygiene: `docs/README.md` and `docs/plans/README.md` both still listed the plan as Ready, fixed at this close's index refresh. The duplicated threat-model backlog entry this plan's finishing pass wrote was folded into the older one it restated.
Assumptions: none; every Chapter's `Assumptions:` line reads none beyond the plan's own `## Assumptions` section.
Review Findings: `review: finishing wave at fable, Workflow (adversarial high, security high, performance high)`; `review: prose-reviewer at fable, Agent tool (frontmatter effort)`, recorded at reduced effort against the high its row names; `review: scope-adjudicator at fable, Agent tool (high)` twice, one held-finding ruling and one goal read. QA PASS at 14:27 UTC on the clean worktree at `a49f2a9`: lint exit 0, 1989 tests, 1988 pass, 0 fail, 1 skipped, exit 0, 45.2 s. Adversarial APPROVED_WITH_CONCERNS, 1 Major (held, above) and 4 Minors. Security CLEAR, 3 Minors. Performance CLEAR, 2 Minors, both rated nothing to fix. Prose lens 1 Major, fixed: the operations guide said `-NoMirror` "covers the transcript alone" when the header also drops that session's hook-carried mirror posts (`broker/intake.ts:733-747`). Critical 0. Majors: 2 total, 1 fixed, 1 justified-not-fixed on the operator's ruling. Minors: 6 fixed in the close pass and the prose fix round (the judge off-switch wording in `docs/install.md` and `docs/operations.md`, one item from two lenses; the docstring seam at `broker/index.ts:735`; the markup pin anchored to the mark's own sentence at `relay/protocol.test.ts:80`, proved by a withheld control; the prose lens's three: the `-NoMirror` "never ... at all" absolute now carrying the security model's qualifier, both judge switches naming the restart, an unqualified "every reply's text is sent to TypeSafe"), 0 upgraded, 4 left with the reason (the supervisor mirror claim, confirmed at `supervise.sh:2558` in Chapter 3; the pre-existing npm advisories already on `docs/backlog.md`; no ceiling on judge call volume, one item from two lenses, since the judge's call path is out of scope and bounded per session; the per-reply registry scan, pre-existing at fleet size). The fix deltas were prose-only and owed no round; each took the author re-read. goal read: 5 built-but-unasked (0 refused, 5 declared, 0 asked), 0 asked-but-unbuilt.
Stamps: adjudicated 1, stamped 0. `memq unstamped --since 1h` listed one operator-tier record, `a-trace-target-you-composed-cannot-check-your-own-work`, read before this session began; the reading session is the restarted one, and nothing this session did applied it, so it is skipped.
Gate: handoff whole gate from Git Bash on SCOTT-CLAUDE at 2026-09-22T17:45Z over the archived tree (`7383b77` plus this Chapter, the `## Intent` ruling, the archive move, the backlog entries and the index refresh), under this session's own heavy-process claim, written after a foreign `node --test` over claude-kit's tests had exited: `npm test` 1989 tests, 1988 pass, 0 fail, 1 skipped, exit code 0, 36.5 s; `npm run lint` exit code 0; both read from the runs' own exit status. Against the whole-gate baseline at `a49f2a9` (1989/1988/0/1, exit 0) and the first session's run at `7383b77` (the same counts): unchanged, no regressions. Against the effort's baseline at `96b8100` (1988/1987/0/1): one test added across the effort, still 0 failing. origin/main still equals the merge-base, so no update merge was taken. This repository defines no contention lane. Tests added 0, edited 0, retired 0 at this close. Spawning tests added: 0.
Next: none; the plan is archived and the pull request carries it
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `7383b77` carrying this close's plan doc edits.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
