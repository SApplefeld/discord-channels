# Judge Unmirrored Replies

Status: In Progress
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

**Rulings after the spec shipped.** None yet.

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

## Open Questions

None.

## Related plans

- Builds on [`../archive/plans/channels_operator-inbox_spec_v1.md`](../archive/plans/channels_operator-inbox_spec_v1.md),
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
