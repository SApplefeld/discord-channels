# Show Steward Asks on the Inbox Card

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

A supervised session's reply carrying the steward-shaped line `ASK: <question>? Recommend: <choice>`
opens an item on the `Fleet: Inbox` card, drawn with a marker that says the line takes the form a
worker uses to ask its supervisor. Today the broker returns at that line before the mark read and
the judge, so the reply reaches the session's Discord thread and never the card. The card is the
roll-up that answers "who is waiting on me" without opening every thread, so an ask missing from
it is one the operator only finds by visiting that thread. When this is done the card lists the
ask with its excerpt and the marker, the item clears the way every other item clears, the
steward-ask exclusion is gone from the tap, and the three host documents that state the exclusion
state the marker instead.

## Intent

**The frame, in the operator's words.** "Wait... you mean the session will ask something and it
will block it from reaching me? I am not sure how I feel about that. I think I would want to at
least see those messages, but maybe have something appended to them noting that the Supervisor
was informed?" After the correction that the message does reach the thread and only the card
entry is missing: "Ship what you have now, add that paragraph, and then write the shell of the
plan with your recommendations and pass it to the architect to be reviewed, finalized, and
dispatched out for execution."

**What done needs to do.** Open a card item for a supervised session's reply that carries the
steward-shaped line, with the ask's excerpt, drawn with a marker that tells the operator the line
is shaped as an ask of the session's supervisor. This marker stands in for the "Supervisor was
informed" note the operator floated, which the refused alternatives below say the broker cannot
honestly draw. Clear the item on the same events that clear any other item. Say in the host documents what the marker means and what it does not claim.

**What done does not need to do.** It does not need to change the persona plugin's matcher or
what the steward does with the ask. It does not need to change the judge's questions, threshold,
screen or cut. It does not need to change how an ask with no steward shape opens, draws or clears.
It does not need to tell the operator whether the supervisor read the line, because the broker
cannot observe that.

**Alternatives refused.**
- A third item source, `steward`, beside `marked` and `judged`: the snapshot loader refuses the
  whole file on an item whose source it does not know, so a rollback to the previous broker would
  drop every open item rather than the steward ones, and a third source needs an upgrade order
  against `marked` that a flag on a marked item does not.
- Telling a reply-tool answer from a turn-final mirror at the tap, so the marker could say the
  supervisor read the line: the persona plugin's own reply backstop posts a turn-final answer
  through the reply tool when a channel-opened turn ends without a reply call, so the origin of a
  post does not tell the two apart.
- A marker reading "supervisor informed": the broker sees a line's shape and a record's lineage,
  never whether the plugin read the line.
- Keeping the exclusion for a steward-shaped line the mark rule refuses (lowercase or inside a
  fence): that keeps the card blind for the very shape this plan makes visible, and the judge is
  the reading every other unmarked reply takes.

**Rulings after the spec shipped.** None yet.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session at the close of
`../archive/plans/channels_judge-unmirrored-replies_spec_v1.md`, whose finishing review found the
gap and whose `## Intent` records the operator's ruling to ship with it and plan this separately.
Finalized the same day by the Architect seat on the coordinator persona's record, after reading
the installed persona plugin's hook.

## Approach

**The exclusion becomes a flag on the marked item, not a return and not a new source.** The tap
is `inboxWiring.reply` in `broker/index.ts`, called by the outbound router once a reply's text is on
the session's thread. It admits a reply whose session the registry still holds and refuses every
other, which is unchanged. Today it then returns at `if (record.lineage !== null &&
hasStewardAsk(text)) return;` before the mark read and the judge. That line goes. The mark read
runs on every reply the tap admits, and a marked flag carries one new boolean, `stewardAsk`, true
where the record carries a lineage and `hasStewardAsk(text)` holds. The excerpt is what `findAsk`
returns for the reply, which for the steward line is the question and the recommendation together
(the existing test at `broker/index.test.ts` "a supervised session's steward-shaped reply" already
pins that excerpt as `which backend? Recommend: postgres`). A marked reply is never judged, as
today. An unmarked reply goes to the judge as today, and that now includes a supervised session's
reply whose steward-shaped line the mark rule refuses, a lowercase `ask:` or a line inside a
fence, since `hasStewardAsk` is case-insensitive and fence-blind where `findAsk` is neither. The
two rules differ in the other direction too: `findAsk` marks an indented `ASK:` line and
`hasStewardAsk` refuses one, because the plugin's own matcher anchors at the line's first
character. So an indented steward-shaped line from a supervised session marks with the flag
false, which is right, since the plugin would not have read it as a steward ask either.

**The item carries the flag and the card draws it.** `InboxItem` gains `stewardAsk: boolean`,
false for a judged item. On a refresh the flag is assigned in the same statement and under the
same condition as the excerpt, the store's `latest || item.source !== "marked"`, so a marked flag
that takes the excerpt takes the flag with it, a judged-to-marked upgrade with an older instant
included. A later plain `ASK:` from the same session drops the marker and a later steward-shaped
one raises it. The snapshot
restores an absent field as false, so a snapshot written by the previous broker loads, and refuses
a value that is not a boolean, the rule every other field takes. The previous broker reading a
snapshot written by this one ignores the field, since its loader destructures the fields it knows,
so a rollback keeps every item and loses only the marker. The card draws the marker as one more
part on the item's line, in the position and wording section 2 fixes.

**The marker names what the broker knows.** The persona plugin that runs on this machine is
`agentic-plugin`, installed outside this repository under
`%USERPROFILE%\.claude\plugins\cache\agent-persona\agentic-plugin\<hash>\`, where the hash is the
`installPath` of the `agentic-plugin@agent-persona` entry in
`%USERPROFILE%\.claude\plugins\installed_plugins.json` and reads `dda8afb4b77f` at the write. Its
`hooks/index.ts` matches the steward shape once,
at `turn.complete`, over the worker's turn-final answer, and never over the reply tool's message
argument. The same handler's reply backstop posts that turn-final answer through the reply tool
when a channel-opened turn ends with no reply call. So a steward-shaped line at the tap may or may
not be one the plugin read, and no signal the broker holds tells which. The marker therefore says
the line is shaped as an ask of the session's supervisor, and the operations document tells the
operator what that means: the supervisor may be answering it, so read the worker's thread before
acting on it.

**Coverage sweep.** One Explore sweep ran over the worktree for three contracts: the steward-ask
exclusion (`hasStewardAsk`, `STEWARD_ASK`, `steward`, `Recommend:`, `supervised session`, "opens
nothing", "never judged"), the tap's call shape (`OutboundInbox`, `tapReply(`, `inbox.reply`), and
the item and flag shape (`InboxSource`, `InboxFlag`, `InboxItem`, `source: "marked"`,
`source: "judged"`, `excerpt:`). Its hits are the files each section names. The tap's call shape
changes in no file, since the tap keeps its four arguments. Beyond the files the draft named, the
sweep returned four the sections now carry: the `InboxItem` fixtures in `broker/inbox/thread.test.ts`
and `broker/index.test.ts` and the marked flag built in `broker/routing/outbound.test.ts`, which
stop compiling once the field is required, and the two passages that describe the card line part
by part, in `docs/architecture.md` under the inbox card and in `docs/operations.md` under "Reading
the card", which section 3 gives the marker. `broker/inbox/judge.ts` builds judged flags only and
changes nowhere, since the field rides the marked variant and the item.

**What still speaks the old contract.** Three host documents state the exclusion: the steward
paragraph and the sentence "One reply is excluded from both readings" in `docs/architecture.md`,
the "One shape is skipped on purpose" sentence in `docs/operations.md`, and the steward clause in
the "What is never sent" list of `docs/security-model.md`. Section 3 rewrites each. The archived
plan rows in `docs/README.md` that describe the exclusion describe history and stay. The
`inboxWiring` doc comment in `broker/index.ts` states the order of the tap and is rewritten in
section 1 with the code.

## Dispatch Authorization

The operator directed on the discord-channels worker's Discord thread on 2026-09-22 that the
draft be written and passed to the Architect seat to be reviewed, finalized and dispatched for
execution, and the coordinator persona's record of the same day asked the Architect seat to take
it. The plan is finalized by the Architect seat and scheduled through the coordinator persona for
the discord-channels worker, so the grant covers the session that persona's queue assigns and no
other.

## Standing Brief Amendments

- The steward flag is read from the line the mark read took its excerpt from, never from the
  whole reply: a supervised session's reply `ASK: merge it?` followed on the next line by
  `ASK: which backend? Recommend: postgres` opens a marked item with the excerpt `merge it?` and
  `stewardAsk` false, and a reply whose marked line is `ASK: which?` with `Recommend: postgres` on
  the next line opens one with `stewardAsk` false.

## Sections of Work

### 1. A steward-shaped reply opens a marked item carrying the flag
Model: opus
Remove the steward return from `inboxWiring.reply` in `broker/index.ts`. The mark read runs on
every admitted reply, and a marked flag carries `stewardAsk: record.lineage !== null &&
hasStewardAsk(text)`. Rewrite the `inboxWiring` doc comment's account of the tap's order to match.
In `broker/inbox/store.ts`, add `stewardAsk: boolean` to the marked variant of `InboxFlag` and to
`InboxItem`, false on a judged item and on every judged flag's open; on a refresh set it beside
the excerpt under the same condition; in `restoreItem` restore an absent field as false, refuse a
non-boolean, and refuse a judged item whose field is true, as a judged item carrying an excerpt is
refused. In `broker/inbox/ask.ts`, the `hasStewardAsk` doc comment's reason for copying the
plugin's matcher whole now reads that a disagreement would raise the flag on a line the plugin
never read, or leave it down on one it did, since a line the steward is answering now lands on
the card by design. The `InboxItem` fixtures in `broker/inbox/card.test.ts`, `broker/inbox/thread.test.ts`
and `broker/index.test.ts`, and the marked flag built in `broker/routing/outbound.test.ts`, gain
the field so the build stays green, with no card or thread behaviour changed in this section. The
existing test "a supervised session's steward-shaped reply opens nothing and is never judged, and
the same reply unsupervised marks" in `broker/index.test.ts` is rewritten under a title that says
what now holds, since its first half inverts.
Acceptance: a supervised session's reply `ASK: which backend? Recommend: postgres` opens one
marked item with `stewardAsk` true and the excerpt `which backend? Recommend: postgres`, and the
judge is not called; the same reply from a session with no lineage opens a marked item with
`stewardAsk` false; a supervised session's reply `  ASK: which backend? Recommend: postgres`,
indented, opens a marked item with `stewardAsk` false; a supervised session's reply `ask: which
backend? Recommend: postgres` with no uppercase mark opens nothing at the tap and is submitted to
the judge; a supervised session's later
plain `ASK: merge it?` refreshes the item to `stewardAsk` false; a marked flag that arrives with an
older instant than the item's last refresh moves the flag no more than it moves the excerpt; a
snapshot holding an item with `stewardAsk` true round-trips; a snapshot item without the field
restores with it false; a snapshot item with `stewardAsk: "yes"` refuses the snapshot; a judged
snapshot item with `stewardAsk: true` refuses the snapshot; `npm run lint` exits 0 and `npm test`
exits 0.
Files in scope: `broker/index.ts`, `broker/inbox/store.ts`, `broker/inbox/ask.ts`, `broker/index.test.ts`,
`broker/inbox/ask.test.ts`, `broker/inbox/store.test.ts`, `broker/inbox/card.test.ts`, `broker/inbox/thread.test.ts`,
`broker/routing/outbound.test.ts`.
Tests: lock both directions of the flag at the tap (lineage with the shape raises it, no lineage
or no shape leaves it false), the refused-shape path reaching the judge, the flag following the
excerpt on refresh in both directions, and the snapshot's absent-field and wrong-type rules; a
marker drawn for a session the plugin never read, or an ask dropped from the card again, is the
expensive failure.

### 2. The card draws the marker
Model: sonnet
`broker/inbox/card.ts` draws a marked item whose `stewardAsk` is true with one more part on its
line, the constant `STEWARD_MARKER` reading `supervisor ask`, placed after the link where one is
drawn and before the `ended` marker where the session has ended. The glyph, the title, the age,
the link, the excerpt sub-bullet and the rest of the line are unchanged.
Acceptance: a card test draws one marked item with the flag true, one marked item with it false,
one judged item and one ended item with the flag true, and pins the marker on exactly the two
items with the flag and in its position relative to the link and the `ended` marker; the existing
byte-stable fixture test still passes unchanged; `npm run lint` exits 0 and `npm test` exits 0.
Files in scope: `broker/inbox/card.ts`, `broker/inbox/card.test.ts`.

### 3. The host documents state the marker
Model: opus
Locus: inline
Inline means the orchestrating session writes this section itself rather than dispatching it;
sections 1 and 2 carry no Locus line and are dispatched at the model each names.
The three documents that state the exclusion state the new rule instead. `docs/architecture.md`:
the steward paragraph under the inbox section and the sentence "One reply is excluded from both
readings" say that a supervised session's reply carrying the steward-shaped line is marked like
any other reply with an `ASK:` line, that its item carries the steward flag drawn as the marker,
and that the broker reads the line's shape and the record's lineage and not whether the persona
plugin read the line; the passage listing what an item carries adds the steward flag, and the
passage drawing the card line part by part adds the marker in its position. `docs/operations.md`:
the "One shape is skipped on purpose" sentence in the inbox card section is replaced by what the
`supervisor ask` marker means and what to do on seeing it, which is to read the worker's thread
before acting because its supervisor may be answering, and the "Reading the card" walk of the
line's parts names the marker where it draws.
`docs/security-model.md`: the steward clause leaves the "What is never sent" list, and the list's
`ASK:` clause says that a marked reply is read locally whatever its shape, while a steward-shaped
line the mark rule refuses is judged like any unmarked reply.
Acceptance: each of the seven passages named above (three in `docs/architecture.md`, two in
`docs/operations.md`, one clause and one list in `docs/security-model.md`) is opened and rewritten,
and the acceptance is the read of each named passage; as a second net, `grep -n "opens nothing\|is not judged\|never
judged\|skipped on purpose" docs/architecture.md docs/operations.md docs/security-model.md` returns
no line about a supervised session's steward-shaped reply, with every remaining hit read once
against its own subject rather than counted.
Files in scope: `docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`,
`docs/backlog.md` (the section review's out-of-scope reader findings, added to the existing
comprehension-pass entry).
Audience: the operator, expert in this system; a future session with no context, engineer level.
Questions each must answer: what a `supervisor ask` marker on the card means; whether such a reply
is sent to the judge; what clears the item. Voice: company. Fact base: the as-built
`broker/index.ts`, `broker/inbox/store.ts` and `broker/inbox/card.ts` of sections 1 and 2, and
the installed persona plugin's `hooks/index.ts`, at the path the Approach gives, for what the
plugin reads.

## Out of Scope

- The persona plugin's matcher and what the steward does with an ask.
- The judge's questions, threshold, screen, cut, host or model.
- How an item opens, draws or clears where the reply carries no steward-shaped line.
- Sorting or counting steward-flagged items apart from other items.
- Clearing an item on the supervisor's answer, which the broker does not see.
- The archived plan rows in `docs/README.md` that describe the exclusion as it was.
The list is closed at these six, and a change no section names and no bullet above keeps out is
in scope only once a section is amended to name it.

## Assumptions

- assumed 2026-09-22 (default): a steward-shaped line the mark rule refuses, a lowercase `ask:` or
  a line inside a fence, is judged like any unmarked reply rather than kept off the judge as
  today; reversal: one condition at the tap restoring the return for that residue.
- assumed 2026-09-22 (default): a supervisor's answer to its worker does not clear the item, which
  clears on the operator's own prompt as every item does; reversal: a new clear path fed from
  whatever surface carries that answer, which no module in this repository reads today.
- assumed 2026-09-22 (default): steward-flagged items sort and count as every other item does;
  reversal: one comparator branch in the store's `items` and a card test.
- assumed 2026-09-22 (installed plugin `dda8afb4b77f`): the persona plugin matches the steward
  shape only over the worker's turn-final answer, and its reply backstop can post that answer
  through the reply tool; reversal: none needed, since the marker states the line's shape and
  stays true whatever the plugin reads.
- assumed 2026-09-22 (default): the marker reads `supervisor ask`; reversal: one constant in
  `broker/inbox/card.ts`, one card test and one sentence in `docs/operations.md`.
- assumed 2026-09-22 (the archived judge-unmirrored-replies plan's own wording): "the coordinator
  persona", its record and its queue, and `Voice: company`, are read as that plan and the kit's
  brainstorming skill use them, and are not defined again here; reversal: two sentences.

## Operator Verification

- After the broker is updated on a host running personas, a persona worker's reply carrying
  `ASK: <question>? Recommend: <choice>` on one line appears on the `Fleet: Inbox` card with its
  excerpt and the `supervisor ask` marker within one refresh interval
  (`CHANNEL_INBOX_CARD_REFRESH_MS`, 60 seconds by default). Its absence two intervals later reopens
  section 1; its presence without the marker reopens section 2.
- With such a flagged item on the card, let the worker's supervisor answer it and note whether the
  item clears without a prompt of your own. Either result is consistent with the host documents,
  which say the broker does not tell the supervisor's submitted answer from your prompt; the result
  settles whether the plan's second assumption (a supervisor's answer does not clear the item) holds
  on this plugin, and an item that clears is the case the documents' "either may clear it" covers.

## Open Questions

None. The draft's three questions are settled above: the marker states the line's shape, because
the installed plugin's hook shows the broker cannot know more; a supervisor's answer does not
clear the item; steward-flagged items sort as every item does.

## Related plans

- Builds on `../archive/plans/channels_judge-unmirrored-replies_spec_v1.md`, whose `## Intent`
  ruling records the gap this plan closes, and on
  `../archive/plans/channels_operator-inbox_spec_v1.md`, which introduced the steward-ask
  exclusion.

## Chapters

### Chapter 1 - 2026-09-22
Completed: 1. A steward-shaped reply opens a marked item carrying the flag
Implemented By: implementer-opus (first build and fix round 1)
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 1 findings, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 1 open | changes: removes the steward return from the inbox tap and adds a `stewardAsk` boolean to the marked flag and the item, restored false when absent, so a supervised session's steward-shaped reply opens a marked item | serves: the Goal sentence "A supervised session's reply carrying the steward-shaped line ... opens an item on the `Fleet: Inbox` card" | adds a mechanism: no new unit of behavior beyond the flag the Approach names; one return is removed | size: about 6 source lines across three files plus fixtures | not building it costs: the persona's ask of its supervisor stays off the card, which is the gap the operator ruled should close.
  round 1 Major (spec-traceable, blind lens, orchestrator-traced; the adversarial lens reported the same defect as a Minor) | changes: reads the steward flag from the raw line the mark read matched rather than from the whole reply, so the flag and the excerpt describe one line | serves: the Goal sentence "drawn with a marker that says the line takes the form a worker uses to ask its supervisor" | adds a mechanism: no; it narrows the input of the flag the Approach names, with one exported helper in ask.ts returning the matched line | size: about 10 source lines across ask.ts and index.ts plus 2 tests | not building it costs: the card draws "supervisor ask" beside a plain operator ask whenever the same reply also carries a steward-shaped line, including one inside a fence, steering the operator away from an ask that is theirs to answer.
  Then: the Status header read `Ready` and now reads `In Progress`, set at run start. The spec's own section text computed the flag as `hasStewardAsk(text)` over the whole reply; the round 1 Major showed that contradicts the Goal's "the line", so the section was amended through a new `## Standing Brief Amendments` block rather than by rewriting the section body. `findAsk` was factored onto an exported `findAskLine`, which returns the marked line untrimmed, so the flag reads that one line and an indented line still fails the matcher's first-character anchor; `findAsk`'s output is unchanged and its existing tests pass unchanged. `broker/inbox/ask.test.ts` was folded into the section's Files in scope for the helper's pin (same directory, no new acceptance, covered by the gate). The implementer also refuses a non-boolean `stewardAsk` at `flag()` on the way in, one line past the section text, consistent with store.ts's rule that `flag` makes every check the loader makes; declared rather than removed. A live broker (process 6480) runs this tree's `broker/index.ts` and sees none of this until it restarts.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: code pair plus security at fable, Agent tool (blind low, adversarial low, security medium)`. Blind CHANGES_REQUIRED, 1 Major and 4 Minors; adversarial APPROVED_WITH_CONCERNS, 4 Minors; security ADVISORY, 1 Major and 2 Minors, opening `threat model: absent`. Correctness Major, fixed in fix round 1 (above; red observed in the harness on the first case, and by a scratch probe of the old expression on all three). Security Major (advisory, honesty route): `docs/security-model.md`'s "What is never sent" steward clause is false from this commit on, since a fenced steward-shaped line is now judged; disposition fix now, in section 3 of this plan, which rewrites that clause in the same pull request, so no merge carries the false sentence. Minors: 2 fixed in the fix round (the `hasStewardAsk` comment's "card's" flag, the `InboxFlag` doc's "reads as"), 2 resolved by the Major's fix (the index.ts doc's "the line's shape", `STEWARD_ASK`'s `\s*` spanning a newline), 1 refused on the plan's own ground (a lowercase or fenced steward line reaching the judge is the Intent's refused alternative and the Assumptions' first entry), 1 declared (the `flag()` refusal above), 1 carried to section 3 (the three host documents false until it lands), 1 carried to section 3's brief (the security lens's note that `x-channel-lineage` is poster-supplied, so the marker is a report and never proof), 1 left as pre-existing (npm audit, already on `docs/backlog.md`). Critical 0. Majors: 1 correctness fixed, 1 advisory fixed-by-section-3. The fix delta owed no round (no outward action, no new module, one expression pinned red-first) and took the author re-read of its diff.
Stamps: adjudicated 3, stamped 1 (`release-an-exclusive-claim-at-the-operations-end-not-the-turns-end`, operator tier, which shaped releasing the heavy-process claim at the gate's end). 2 skipped as read by dispatched agents rather than applied here.
Gate: targeted lane `node --test broker/index.test.ts broker/inbox/store.test.ts broker/inbox/ask.test.ts broker/inbox/card.test.ts broker/inbox/thread.test.ts broker/routing/outbound.test.ts` at section close, 2026-09-22 ~18:50 UTC on SCOTT-CLAUDE against the worktree at `70de76d` plus the fix round's unstaged edits: 289 tests, 289 pass, 0 fail, exit code 0. The five-file lane (without ask.test.ts) was 271/271/0 exit 0 at `4408da7` and 275/275/0 exit 0 at `70de76d`; the six-file lane has no pre-change baseline, so its delta is stated as +4 tests at first green and +2 in the fix round, 0 failing throughout. `npm run lint` exit code 0. The implementer's whole-suite run at first green: 1993 tests, 1992 pass, 0 fail, 1 skipped, exit 0 (reported; the whole gate runs at finishing). Test delta: 6 added (index.test.ts: indented line marks with the flag down; refused shape is judged, lowercase and fenced; flag read from the excerpt's line, three cases. store.test.ts: flag follows the excerpt on refresh both ways; absent field restores false. ask.test.ts: `findAskLine` returns the marked line on findAsk's rules), 1 rewritten to the new contract (the steward test, whose first half inverted), fixtures in four files edited to carry the field, snapshot refusal cases added to the existing malformed-item test. 0 added tests spawn a process. Contention: a foreign `node .kit/controller-tick-test.mjs` (not a test runner) ran beside some lane runs; all were green. No contention lane is defined in this repository.
Next: 2. The card draws the marker
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `70de76d` carrying the fix round's edits.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-22
Completed: 2. The card draws the marker
Implemented By: implementer-sonnet (first build); main session (the Minor close pass)
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 2 open | changes: the inbox card draws a `supervisor ask` part on the line of a marked item whose steward flag is up, after the link and before the ended marker | serves: the Goal sentence "drawn with a marker that says the line takes the form a worker uses to ask its supervisor" | adds a mechanism: no; one constant and one conditional part in the existing line builder | size: about 3 source lines plus one card test | not building it costs: section 1's flag is stored and never shown, so the card lists a steward ask with nothing telling the operator its supervisor may be answering it.
  Then: the acceptance's "one judged item and one ended item with the flag true" was read as the flag on the ended item only, since the store refuses a judged item carrying the flag; the close pass then added a separate pin that a judged item with the flag forced up draws no marker, because the section text says the card draws the marker for "a marked item whose `stewardAsk` is true" and the first build gated on the flag alone. The advisory lenses were ruled not triggered: the delta draws one fixed literal into an existing line, with no input handling, process, lock or store query.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: code pair at opus, Workflow (blind high, adversarial high)`. Adversarial APPROVED_WITH_CONCERNS, 3 Minors; blind APPROVED_WITH_CONCERNS, 4 Minors; three of them the same items. Critical 0, Major 0. Minors: 4 fixed in the close pass (the link-before-marker assertion passed by default when `indexOf` returned -1, now the link's presence is asserted first; the `STEWARD_MARKER` comment said "reply" where the flag reads the marked line and "past its link" where no link may draw; the card gated on the flag without the marked source the section names, now `item.source === "marked" && item.stewardAsk`, pinned red-first by a judged-item test; the test title's "only there" was unchecked, now pinned by a count of exactly two markers on the card), 0 upgraded, 0 left. The close pass's delta took the author re-read: two test assertions, one new test and one condition, no outward action or new module, so it owed no round.
Stamps: none surfaced; this section's reads were the plan doc and the card files, and no memory bore on it.
Gate: targeted lane `node --test broker/inbox/card.test.ts broker/inbox/thread.test.ts broker/index.test.ts broker/inbox/store.test.ts broker/inbox/ask.test.ts broker/routing/outbound.test.ts` at section close, 2026-09-22 ~19:10 UTC on SCOTT-CLAUDE against `a30be41` plus the close pass's two unstaged files (and section 3's three unstaged documents, which no test reads): 291 tests, 291 pass, 0 fail, exit code 0. Same lane at section 1's close: 289/289/0 exit 0; delta +2 tests, no regressions. The judged-item pin failed first against `a30be41`'s card (`node --test broker/inbox/card.test.ts`: 19 tests, 18 pass, 1 fail, exit 1, the new test named). `npm run lint` exit code 0. Test delta: 2 added (card.test.ts: the steward marker draws on exactly the two flagged items, after the link and before `ended`; a judged item draws no marker even with the flag forced up). 0 edited, 0 retired. 0 added tests spawn a process. No contention lane is defined in this repository.
Next: 3. The host documents state the marker
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `a30be41` carrying the close pass and section 3's documents.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 3 - 2026-09-22
Completed: 3. The host documents state the marker
Implemented By: main session (Locus: inline, tier opus)
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0. The document pair sits outside the provenance read, so its findings are counted on the Review Findings line.
Decisions / Surprises: section 3 open | changes: rewrites the seven passages in `docs/architecture.md`, `docs/operations.md` and `docs/security-model.md` that stated the steward exclusion, so each states the marked item, the steward flag, the `supervisor ask` marker, what it does not claim, what clears the item and that a refused steward shape is judged | serves: the Goal sentence "the three host documents that state the exclusion state the marker instead" | adds a mechanism: no; prose only | size: 7 passages across 3 files, about 50 lines added and 18 removed | not building it costs: the security model keeps saying a steward-shaped reply is never sent to the judge, which is false from section 1 on, and the operator meets a marker the operations guide never explains.
  Then: the documents also state section 1's security lens's note that the lineage behind the marker is the session's own declaration (`x-channel-lineage`, `broker/intake.ts:417`), so the marker is a report and never proof; that closes the Minor Chapter 1 carried to this section's brief. The security model's "What is never sent" clause is corrected in this section, which lands in the same pull request as section 1, so no merge carries the false sentence Chapter 1's advisory Major named. What the persona plugin reads is stated from the spec's `## Approach`, which the Architect seat read from the installed plugin outside this repository; it is reported, not re-read here. The section's acceptance grep first hit the new architecture sentence "It is marked like any other `ASK:` line and never judged", which states the new rule rather than the exclusion; the sentence now reads "is not sent to the judge", so the grep's remaining hits (`docs/architecture.md:816` and `:936`) are about a clearing event and a judge failure, each read once. The readers' out-of-scope findings were appended to `docs/backlog.md`'s existing comprehension-pass entry, whose file this section's staging now carries.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: document pair (2 readers) at fable, Agent tool (blind-reader low, prose-reviewer low)`. Prose reviewer APPROVED_WITH_CONCERNS, 2 Majors and 11 Minors, with every code-backed claim checked against `broker/index.ts`, `store.ts`, `card.ts`, `ask.ts` and `intake.ts` and no drift found. Majors fixed: `docs/operations.md` used "supervised session" and "lineage" undefined, now the worker and its declared lineage are defined where the marker is explained; `docs/security-model.md` did not say what clears the item, now it does. Minors: 10 fixed in the fix round (architecture: the supervisor's answer clears nothing, a refused shape is read per reply not per line, the acceptance-grep sentence, a 44-word sentence split in three, the item list's nested flag rule moved to its own sentence, the header mechanics pointed at the security model as owner; operations: the line-parts walk names both conditions, the marker paragraph opens on its meaning, a colon-packed sentence split; security-model: the rule-and-consequence sentence split with the surplus "supervised" dropped, and "steward" replaced by the shape's form), 0 upgraded, 1 left with the reason (the security model's own restatement of the `x-channel-lineage` header at two places: the marker sentence carries the header because a security reader acts on where the claim comes from, and the second place is pre-existing). The two blind readers (operator; fresh engineering session) returned no finding on this section's passages; their findings on the rest of the three documents, several already listed there, went to the backlog as above. The fix delta is prose-only and owed no round; its author re-read is the read of each rewritten passage above.
Stamps: none surfaced; no memory bore on the documents.
Gate: prose section, no test lane applies. `npm run lint` (`tsc --noEmit`) exit code 0 at 2026-09-22 ~19:06 UTC on SCOTT-CLAUDE against the worktree at `ea312f2` with the three documents and `docs/backlog.md` dirty. Em-dash control over the delta's added lines: 0 matches. Acceptance grep `grep -n "opens nothing\|is not judged\|never judged\|skipped on purpose"` over the three documents: 2 lines, neither about a supervised session's steward-shaped reply; the grep spoke on the first draft's own sentence before the reword, which is its control. Test delta: 0 added, 0 retired, 0 edited. No contention lane: no machine-shared state touched.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 on SCOTT-CLAUDE against the worktree at `ea312f2` carrying section 3's four dirty files.

### Interim board 1 - 2026-09-22
The finishing pass is past steps 1 to 3 and its fix round; base ref `4408da7`, the merge-base with main.
QA verifier PASS: lint exit 0, whole suite 1997 tests, 1996 pass, 0 fail, 1 skipped, exit 0, at `ff4a303` on a clean worktree; every acceptance bullet and both amendment cases pinned; the live-card check is the operator's.
Finishing wave at fable, high, through Workflow: adversarial APPROVED_WITH_CONCERNS (5 Minors), security CLEAR (2 Minors, `threat model: absent`), performance CLEAR (1 Minor), prose CHANGES_REQUIRED (1 Critical, 1 Major, 6 Minors). The adversarial lens confirmed the persona plugin's matcher and reply backstop at the installed plugin's own source, so the documents' claims about what it reads are confirmed rather than reported.
The prose Critical: all three documents said a supervisor's answer "clears nothing", while the installed plugin delivers that answer as a prompt submitted into the worker, which the broker does not tell from the operator's. Neither this session's transcript nor the broker's session record could settle whether that prompt reaches the mirror route, so the documents now say either may clear the item, and Operator Verification carries the live check. This also puts the plan's second assumption and its `## Out of Scope` fifth bullet in doubt; the final Chapter records it.
Fix round committed at `033bc4a`: the documents' clear claim, the architecture "goes to the judge" condition, the indented-line case named, the security model's never-sent clause split, the tap's double scan replaced by one `findAskLine` call and an exported `excerptOf`, `hasStewardAsk`'s doc, the backlog entry's reader claims checked and cited, and `docs/backlog.md` added to section 3's Files in scope. Targeted lane 291/291/0 exit 0, lint exit 0.
Live dispatch: the scope adjudicator's whole-changeset goal read, at fable through the Agent tool.
Rulings since the last boundary: none.
Next: the goal read, the docs curator, the final Chapter, the archive, the handoff whole gate, and the pull request.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
