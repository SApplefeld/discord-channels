# Channels: five render tweaks

Status: Complete
Commit Model: Commit-and-Push
Created: 2026-08-16

Five small readability changes across the broker's Discord surfaces, requested by the operator
2026-08-16 from a live read of the fleet: the board card's project titles and plan order, the
name-change notices Discord writes into a session thread, the tasks block's second row, and the
state glyph vocabulary. Each is a render or routing change with no new state, no new config, and
no new Discord permission.

## Related

- [`../archive/plans/channels_board-markdown_spec_v1.md`](../archive/plans/channels_board-markdown_spec_v1.md):
  the round that put the board card on live markdown, whose `###` project heading and bullet list
  sections 1 and 2 reshape.
- [`../archive/plans/channels_pin-notice-cleanup_spec_v1.md`](../archive/plans/channels_pin-notice-cleanup_spec_v1.md):
  the round that built the pin-notice cleaner section 3 extends to the rename notice.
- [`../archive/plans/channels_fleet-card-layout_spec_v1.md`](../archive/plans/channels_fleet-card-layout_spec_v1.md):
  the round that settled the session card idiom the tasks block (section 4) draws in.

## Goal

The fleet reads better from the phone, in five specific ways.

1. **Board card, project title as a fenced block.** Each project's heading on the board card is a
   one-line fenced code block carrying the project name, instead of a `###` heading. Discord draws
   a fenced block as a full-width shaded box, and that box is what makes one project's list stop
   and the next start at a glance. Under `MAX_CARD_LENGTH` accounting a fence costs its two fence
   lines, and the name inside it is block-inert (`inertBlockField`: backticks substituted, no
   escapes drawn) rather than markdown-escaped, since a fence honors no backslash escape and a
   Windows-ish directory name would otherwise reach the operator doubled.
2. **Board card, most recent touch first.** Plans are ordered by the plan doc's modification time,
   newest first, so the top of the card is what moved last. Today the sweep lists a root's plans by
   filename and the card draws them in that order; the mtime is already on every `PlanReading`.
   Ordering is applied at the card, not the sweep, so the sweep's name-ordered listing (which the
   per-root cap is defined against) is untouched. See Open Questions for the one interpretation
   call.
3. **Session thread, no rename notices.** Every time the broker renames a session's thread (a state
   flip, an age tick past the dwell window), Discord writes a system message into the thread
   reading `ClaudeRelay changed the channel name: ⏸ ASR: KB Updates · idle`. The broker deletes
   each one it caused as it arrives, exactly as it already deletes the pin notices its own pins
   write in the parent channel: same cleaner, same narrow triple gate, same non-retry policy.
   Deleting a message the bot itself authored needs no permission beyond what the bot has, so the
   install's permission list does not change.
4. **Session card, the tasks block's second row indented.** A task's description row currently
   starts at the separator column, so the two rows read as two entries with a dot in front of
   each. The description row drops its separator and starts two columns to the right of where the
   agent type starts, so it reads as the entry's continuation.
5. **State glyphs.** `idle` draws `⏸` instead of `✅`, and `needs you` draws `⏹` instead of `⏸`.
   The green check is the most attention-grabbing glyph on the thread list and it marks the least
   actionable state; the pause reads as "not doing anything" and the stop-square as "halted on
   you". One table, `GLYPHS` in `broker/discord/render.ts`, feeds both surfaces that draw a state
   glyph, the thread name and the session card title, so the change is one edit plus its pins. The
   fleet usage card's session rows draw the state as a bare word with no glyph and are not involved.

## Approach

Every change is a pure-render or pure-decision edit with a test that pins it, in the module that
already owns the surface. No new module, no new config, no new persisted field.

### The board card (sections 1 and 2)

`broker/board/card.ts`. The project label becomes `fenced([name])` where `name` is
`inertBlockField(lastSegment(root), MAX_PROJECT_LABEL_LENGTH)` (falling back to `unnamedProject`
when it neutralizes to nothing). The `PROJECT_HEADING` constant goes away. `sections()` charges the
fence's three lines where it charged one heading line, through the same `spent()` path, so the
overflow tail still tells the truth. The plan bullets under it are unchanged.

Ordering: `sections()` sorts each project's open plans by `reading.mtimeMs` descending before it
places them; ties (equal mtime, which two files written in one commit can share) break by filename
stem ascending so the order is stable across renders. Failures and truncation notes keep their
current position after the parsed plans. Project order: see Open Questions; the recommendation is
that projects also order by their newest plan's mtime, newest first, with the configured order as
the tie-break, and this spec is written to that recommendation.

Mock, at the shape the card draws:

````
📋 **Fleet: Board**
# 📋 Fleet: Board

```
sapplefeld-channels
```
- **channels_render-tweaks_spec_v1**
  - 0/6 · 3m
  - next: section 1
- **channels_board-markdown_spec_v1**
  - 4/4 · 2h · Draft

```
sapplefeld-claude-kit
```
- **kit_memory-decay_spec_v2**
  - 2/5 · 1d

card as of just now
````

### The rename notice (section 3)

`broker/routing/gateway.ts`. `classifyMessage` gains one more `delete` answer, inside the in-thread
branch and before `deliver`: the thread's parent is this host's channel, the type is
`MessageType.ChannelNameChange` (Discord type 4), and the author is this bot. All three bind, so a
thread the operator renamed by hand keeps its notice, and a broker sharing the guild deletes
nothing in another host's threads. Everything else in the in-thread branch is as it is.

The delete route today is bound to the parent channel id
(`broker/discord/adapter.ts`, `deleteMessage`, `/channels/${channelId}/messages/...`). A message in
a thread lives under the thread's id, so `deleteMessage` takes an optional `channelId` (defaulting
to the configured channel) and the gateway passes the thread id for a rename notice. The cleaner
(`createPinNoticeCleaner`) is renamed to what it now is (`createSystemNoticeCleaner`), and its log
line names which notice was refused. Non-retry, one log line per window: unchanged.

The cleaner also latches a kind off for the run once that kind's refusal reports `permanent`. A
rename notice arrives on every state flip and every age tick past the dwell window, per session
thread, where a pin notice arrives only when the pin list reconciles, so a standing permanent
refusal on the rename path would spend one refused request per rename per thread against Discord's
invalid-request budget, whose overrun is an hour-long ban of the host IP that takes the permission
prompts down with it. The latch is per kind, is named once in the log, and is strictly narrowing:
it can only remove requests, never add one.

The Message Content intent is not involved; the type and author are on every message event.

### The tasks block (section 4)

`broker/discord/render.ts`, `rosterEntry`. The second row becomes
`" ".repeat([...lead].length + ROSTER_DESCRIPTION_INDENT) + described`, with
`ROSTER_DESCRIPTION_INDENT = 2` as a named constant beside `MAX_TASK_DESCRIPTION_LENGTH`, and the
description's room reduced by the same two columns so no row exceeds `MAX_BLOCK_WIDTH`. Before and
after, in the fence:

```
Tasks
14m · claude-kit:implementer-opus
    · Section 1 of the board card, the plan reader
```

```
Tasks
14m · claude-kit:implementer-opus
        Section 1 of the board card, the plan reader
```

The knob is `ROSTER_DESCRIPTION_INDENT`; "more" or "less" is one number.

### The glyphs (section 5)

`broker/discord/render.ts`, `GLYPHS`: `idle: "⏸"`, `"needs you": "⏹"`. Every test that pins a
thread name, a card title, or a fleet row through the literal glyph is updated to draw from
`GLYPHS` where it does not already; a test that must pin the literal (the vocabulary itself is the
claim) pins the new one. `docs/operations.md`'s thread-list example and its `needs you` sentence
change with it.

## Standing Brief Amendments

Folded into every dispatch brief from here on. Each is a finding class two separate review rounds
in this effort produced, which means the briefs were generating it rather than the implementers.

- **Sweep the falsified claim, not the changed line.** A comment in this codebase asserts a system
  property, so a change that makes one false has to find every one it made false, in the edited file
  and outside it. Grep the tree (excluding `node_modules`) for the vocabulary the change retires,
  including JSON `_comment` fields, test-helper doc comments, and the doc comment on any exported
  type or option the change reaches. Two rounds here shipped a correct implementation whose file
  still described the shape it replaced. Report anything outside the brief's file scope rather than
  editing it.
- **A test whose fixture cannot produce the case it names is not a test.** Before a section closes,
  check each new test's fixture actually differs from its expected output on the axis under test, and
  prove it by breaking the code and watching the test go red. An ordering test whose input order
  already equals its expected order passes with the sort deleted; an overflow test whose fill
  overflows before the boundary never reaches the boundary. Both shapes shipped here and both were
  caught by review rather than by the suite.

## Sections of Work

### 1. Board card: fenced project title (Complete)
Model: sonnet
`broker/board/card.ts` (+ `card.test.ts`). The project label as a one-line fence carrying the
block-inert directory name; `PROJECT_HEADING` removed; budget accounting charges the fence's lines.
Tests: the label is a fence whose one content line is the name; a directory name containing a
backtick run reaches the card with no backtick inside the fence; a name that neutralizes to nothing
draws `project N` inside the fence; the overflow tail is right on a card that stops between a
fence and its first item (the fence and its first item are spent together, as the heading was).
References: `fenced` and `inertBlockField` in `broker/discord/render.ts`; the "Approach" mock.

### 2. Board card: newest touch first (Complete)
Model: sonnet
`broker/board/card.ts` (+ test). Plans within a project by `mtimeMs` descending, stem ascending on
a tie; projects by their newest plan's `mtimeMs` descending, configured order on a tie, with a root
holding only failures or a truncation note (no mtime to order by) after every root that has one.
Tests: two plans in one root arrive name-ordered and draw mtime-ordered; a tie draws stem-ordered;
two roots configured A, B draw B first when B's newest plan is newer; a held plan (`heldSince`
non-null) orders by its parse's mtime like any other.
References: `PlanReading.mtimeMs` in `broker/board/plans.ts:104`.

### 3. Thread: delete the rename notice (Complete)
Model: opus
`broker/routing/gateway.ts` (+ test), `broker/discord/adapter.ts` (+ test). The in-thread
`ChannelNameChange` own-authored delete in `classifyMessage`; `deleteMessage` takes the thread id;
the cleaner renamed and its refusal line naming the notice kind. Tests, at minimum, both directions
of every gate: own-authored rename notice in a thread under this channel deletes; the same notice
authored by another user delivers nothing and deletes nothing (it is a system message, so it must
not `deliver` either: pin the exact decision); the same notice in a thread under another channel
drops; an ordinary own-authored thread message still delivers; the parent-channel pin-notice path
is byte-for-byte as before. The adapter test pins the thread id on the route.
References: `classifyMessage` at `broker/routing/gateway.ts:66`; the delete route at
`broker/discord/adapter.ts:415`; discord.js `MessageType.ChannelNameChange`.

### 4. Session card: tasks description indent (Complete)
Model: haiku
`broker/discord/render.ts` (+ test). `ROSTER_DESCRIPTION_INDENT`, the second row without its
separator and indented by it, room reduced to match. Tests: the second row starts exactly
`[...lead].length + ROSTER_DESCRIPTION_INDENT` columns in and carries no separator; no roster row
exceeds `MAX_BLOCK_WIDTH` for a description at the cap.
References: `rosterEntry` at `broker/discord/render.ts:1724`.

### 5. Glyphs and docs (Complete)
Model: haiku
Locus: inline for the `docs/` half
`broker/discord/render.ts` (`GLYPHS`), every test pinning the old literals
(`render.test.ts`, `surface.test.ts`, `index.test.ts`, `question-message.test.ts` and
`security/permission.test.ts` where they pin a state glyph rather than the verdict check),
`docs/operations.md` (thread-list example, the `needs you` sentence, and the board card's project
paragraph at line 328, which still calls the project label a heading). Gate: a tree-wide grep for
`✅` and `⏸` after the change finds only the permission verdict and the answered-question headers,
which are not state glyphs and keep the check. Docs for sections 1 to 4: `docs/operations.md`'s
board card and tasks block paragraphs, `docs/README.md`'s pin-notice-cleanup row gains the
rename notice in one clause, and this plan is indexed.

## Out of Scope

- Suppressing the rename notice by renaming less often. The dwell window and the rename budget are
  their own tuned system; deleting the notice is cheaper and does not change what the thread list
  shows.
- Any change to the sweep's per-root cap or its name-ordered listing.
- Reordering the fleet usage card or the session card's other blocks.

## Operator Verification

Read from the phone after the broker restarts on the new build:

1. The board card: each project name sits in its own shaded box; the plan you touched last is at
   the top of its project; the project you touched last is the top project.
2. Open a session thread that has flipped state at least once since restart: no "changed the
   channel name" lines after the flip. Lines from before the restart remain (nothing sweeps
   history).
3. A session running a fan-out: the description rows sit visibly right of the agent type, no dot.
4. The thread list: an idle session shows `⏸`, one waiting on you shows `⏹`, and nothing shows the
   green check.

## Open Questions

- **Section 2, project order.** Decided 2026-08-16: projects order by their newest plan's mtime,
  newest first, configured order as the tie-break, so the top of the card is the project in focus;
  bullets within a project order the same way. The alternative (projects fixed in configured
  order, bullets reordered within) was weighed and passed over because the card's job is to show
  from the phone what moved last. Cost accepted: a project's box moves when a plan elsewhere is
  touched.

## Chapters

Sections 1, 3 and 4 were built concurrently on disjoint files and reviewed as one changeset, so
their three Chapters share one review round, one gate run and one commit. Each is recorded on its
own because the section is the unit the record is read by.

### Chapter 1 - 2026-08-16
Completed: 1. Board card: fenced project title
Implemented By: implementer-sonnet, with the review-fix round taken by implementer-opus
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The fence needs no new budget arithmetic. `fenced()` returns one string
carrying two internal newlines and `spent()` charges each element its own length plus one newline,
so pushing the label as a single element already charges exactly the fence's three lines. The label
goes through a new `cutBlockField` beside `cutField`, whose guard is `cap` rather than
`cap * MAX_ESCAPE_EXPANSION`: that multiple exists for the markdown escape's up-to-2x growth, and
block-inert substitutes one character for one and strips the rest, so it can never grow a value.
`MAX_PROJECT_LABEL_LENGTH` stays at 60 rather than dropping to `MAX_BLOCK_WIDTH` (46). A fenced
block wraps to the reader's own window and never scrolls sideways, so a long label wraps inside the
box, and `MAX_BLOCK_WIDTH` exists to keep the grid cards' columns from scrambling, which this label
has no grid to break. A directory name the operator cannot recognize is the worse failure. The
reasoning is now a comment on the constant so it is not re-litigated.
Review Findings: Two Criticals: none. Majors addressed: the falsified-comment sweep (eight standing
comments in `card.ts` still asserted a `###` heading, found independently by both reviewers); the
fence-atomicity test could not fail on the case it named, since its fill overflowed mid-first-project
so no card ever stopped at a fence boundary. The reviewers disagreed on that second one and the
controller ruled by reading the test. It is rebuilt to search for the fill that crosses exactly at
the second project's opening, asserts the overflow tail's plan and project counts (which the
original never read), and was proven red-then-green against a deliberately undercharged fence.
Majors in docs, addressed here rather than deferred: `docs/security-model.md` documented "this card
draws no fence" and named the wrong escape for a field rendered in the approval channel, and
`docs/architecture.md` said every field lands outside a fence. Minor addressed: a change-narrative
comment in the test. Minor noted, not fixed: the parked backlog item "Draw the board card's project
headings stronger" names the deleted `PROJECT_HEADING` and is retired by this work; it goes to the
archive snapshot at close-out.
Bonus, outside the section: `docs/architecture.md` asserted that a code block scrolls sideways on a
phone rather than wrapping. That is contradicted by this project's own ruler measurement, so the
paragraph now states the measured behavior. Undo by reverting that one paragraph in
`docs/architecture.md`.
Stamps: adjudicated 6, stamped 6 (`stop-mirror-claim-tests-flake-in-isolation-too`,
`discord-code-blocks-wrap-to-window-width`, `typescript-runs-unbuilt-under-node-type-stripping`,
`a-comment-that-names-a-property-is-a-claim-to-sweep`, `two-components-agreeing-is-not-two-checks`,
`subagents-cannot-write-to-docs-in-this-harness`)
Next: 2. Board card: newest touch first
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-16
Completed: 3. Thread: delete the rename notice
Implemented By: implementer-opus, with the review-fix round taken by implementer-opus
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: A rename notice authored by anyone other than this bot is dropped rather than
delivered. Discord composes a system message's content from the new name, so delivering it would put
text into the session's inbound route that nobody typed, and the sender gate would then be judging a
message with no author intent behind it. That path was open before this section and is now closed.
`deleteMessage` takes an optional channel id defaulting to the configured channel, so the pin path
is byte-for-byte unchanged while the rename path passes the thread id. `MessageType.ChannelNameChange`
is 4, confirmed by running the installed discord.js rather than read off documentation.
Review Findings: Criticals: none. Major addressed: the cleaner ignored the `permanent` flag a failed
`CallOutcome` carries, so a permanently-refused delete was re-attempted once per notice forever. That
cost little on the pin path, which reconciles rarely, but a rename fires on every state flip and age
tick per session thread, and the refused requests count against Discord's invalid-request budget
whose overrun is an hour-long IP ban that takes the permission prompts down with it. The cleaner now
latches per kind on a permanent refusal and names the latch once. This is an amendment to the spec,
which called the cleaner's policy unchanged; it was taken rather than escalated because it is
strictly narrowing, able only to remove requests. Minor addressed: the cleaner's `kind` parameter was
an unnarrowed `string` and is now the union `SystemNoticeKind`. Minor declined: adding snowflake
validation to the channel id interpolated into the REST route. The only value that reaches it is
`message.channelId` from discord.js, on a path already gated by `parentId === channelId`, so the
check would guard a caller that does not exist. Recorded so it is not re-litigated.
Unverified premise worth naming: whether Discord ever answers a thread-rename notice delete with a
permanent 4xx at all is not confirmed against the live API. The latch costs nothing if it never
fires, and operator verification step 2 is what settles it.
Stamps: adjudicated with Chapter 1's sweep; none additional surfaced
Next: 2. Board card: newest touch first
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-16
Completed: 4. Session card: tasks description indent
Implemented By: implementer-sonnet
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Dispatched at sonnet rather than the `haiku` tier the section carries. The
haiku tier requires naming an exact sibling to clone plus a self-surfacing gate, and this is a
modification of one existing function with no sibling to transcribe, so the tier rule's own floor
sends it to sonnet. A tier substitution, not a tier change. The description's room is now
`min(MAX_TASK_DESCRIPTION_LENGTH, max(room - ROSTER_DESCRIPTION_INDENT, 0))`, which holds the second
row to exactly `MAX_BLOCK_WIDTH`; the 60-code-point field cap never binds, since the room left
beside a lead is at most 41. The knob is `ROSTER_DESCRIPTION_INDENT` in `broker/discord/render.ts`.
Review Findings: Criticals: none. Majors: none. Both reviewers read the indent arithmetic against
`MAX_BLOCK_WIDTH` and found it exact. The security reviewer notes the change is a narrowing: a
continuation row indented past the lead with no separator is less able to masquerade as a roster
entry than the separator-bearing row it replaces.
Stamps: adjudicated with Chapter 1's sweep; none additional surfaced
Next: 2. Board card: newest touch first
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-16
Completed: 2. Board card: newest touch first
Implemented By: implementer-sonnet, with the review-fix round taken by implementer-opus
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The spec was silent on how a root that is not on the configured list orders
against one that is, so the controller ruled: mtime is the primary key for every root that has one,
configured or not, and the configured-versus-not distinction survives only as the tie-break index in
the placement order. The old property "unconfigured roots draw after configured ones" is deliberately
retired and its comment rewritten. Both comparators compare the ordering instants rather than
subtracting them, because a plan with no usable mtime sorts at negative infinity and two of those
subtract to `NaN`, which is a comparator that silently returns an arbitrary order. The pre-sort the
caller in `thread.ts` did is deleted: `renderBoardCard` is the only consumer of `fleet.plans`
(`broker/board/thread.ts:528`) and `sections()` re-sorts every plan itself, so the caller's sort was
dead work whose comment asserted an ordering the card no longer took from it.
Review Findings: Criticals: none. Twelve findings adjudicated and taken (a self-contradicting doc
block on `sections()`; the exported `roots` JSDoc naming the wrong tie-break; three falsified
comments outside the changed lines; an unreachable `?? 0` fallback; `unnamedProject` fed the
post-sort index so a label churned as projects moved; an incomplete cost account in the module
header; the `NaN` comparator above; the dead pre-sort; a config paragraph left unreflowed; three
over-long lines). Two were tests that could not fail on the case they named, which is the finding
class the Standing Brief Amendments block now carries: the held-plan test's input order already
equalled its expected order, and so did the project-order test's. Both were rebuilt and proven red
with the sort disabled and with the comparator inverted, then green restored.
Minor declined: printing a held plan's live file mtime instead of its held parse's. `PlanFailure.stat`
does carry the live mtime and `thread.ts:508` discards it, but `reading.mtimeMs` feeds both the
ordering and the age clause printed beside the plan, so ordering by the live value would put a number
on the card that contradicts the text next to it. The `held Xm` marker already tells the operator the
file has moved. Recorded so it is not re-litigated; the in-scope fix was correcting the comment that
overclaimed "what the operator touched most recently".
Deviation accepted: the project-order test's fixture runs opposite to the brief's construction. The
brief said make the first-configured root's plan the newer one, which cannot discriminate, since
newest-first and configured-order then produce the same expected array; the implementer proved that
with a probe that left the test green. It reversed the fixture instead so the expected order differs
from the configured list. The cost is that the test's two ticks now assert the same array, so it no
longer distinguishes a "root that reported a failure sinks forever" implementation, which the card
cannot have because it is pure per render. Two projects and one configured order cannot buy both.
Stamps: `memq unstamped` reported zero on both tiers; nothing recalled this section went unapplied.
Next: 5. Glyphs and docs
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-16
Completed: 5. Glyphs and docs. This closes the plan.
Implemented By: implementer-sonnet for the glyph table and its pins; the `docs/` half inline, since
the docs-write guard denies a subagent any write under `docs/`.
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The glyph table is the single claim and one test pins its literals; every
other assertion that composes a thread title now reads its glyph from `GLYPHS` rather than repeating
one. The blind reviewer argued the opposite, that keeping literals in the end-to-end surface tests
buys a second independent pin against exactly the swap this change made. The controller ruled for
single-sourcing: a literal in a composition test re-asserts the vocabulary as a side effect and gets
updated mechanically when the vocabulary moves, which is churn rather than a check. The hazard the
reviewer named is real and is answered instead by the one vocabulary test pinning both moved entries
and being proven red against a reverted table. The docs half also carries sections 1 to 4, which had
shipped their code with no operator-facing description: the board card's fenced label and its
newest-touch-first ordering, and the tasks block's indented continuation row.
Review Findings: Criticals: none. Majors addressed: the tasks-block example in `docs/operations.md`
printed a description the renderer cannot emit (52 columns against a 38-code-point cap, uncut), found
by a reviewer rendering a real card rather than reading the arithmetic; the `GLYPHS` export comment
justified the export by a fleet-card consumer that does not exist and whose own file says the
opposite, a claim that was already false before this section and that this section owns under the
falsified-claim sweep; `broker/discord/state.test.ts:65` called the idle glyph "the success glyph";
both new ordering paragraphs omitted the rule that a project the card cannot date sinks below every
one it can, and the operations paragraph stated the configured list as a general placement rule where
Chapter 4 had ruled it a tie-break only; `docs/README.md` said the rename delete is bound to the
thread instead of the channel, where the gate is this host's channel reached through the thread's
parent and only the delete route moves to the thread. Minors addressed: the `Next:` line was called
the one field the card cuts, which the 60-character project label falsified; an inserted sentence
broke the antecedent of the one after it; four paragraphs left unreflowed; two glyph pins left as
literals after the conversion.
Declined, recorded so it is not re-litigated: the pause and the stop-square are adjacent code points
that render as similar small outline squares, and a reviewer argued that undercuts the stated reason
the glyph leads the thread name (it has to survive the mobile list's truncation). The vocabulary is
the operator's own explicit choice in this plan's Goal, so it is not the controller's to overrule,
and Operator Verification step 4 is the check that settles whether the two read apart on a real
phone.
Named, no code change: existing threads carry the old glyph in their persisted title until a rename
lands, and an idle session's rename is gated by the dwell window and the per-thread rename budget, so
a thread can sit a while after restart showing a glyph no longer in the table. It is self-healing and
bounded, an expected post-deploy transient rather than a defect.
Backlog: two items retired with receipts to `docs/archive/backlog-2026-Q3.md`. "Draw the board card's
project headings stronger" named the deleted `PROJECT_HEADING` constant and is overtaken by the fence.
"Order the plans within a project" is delivered by section 2, including the design point it left open
(the sort runs behind the per-root cap of 64, at the card rather than the sweep).
Finishing Pass: QA verification PASS. Every code-verifiable acceptance criterion across all five
sections holds with named evidence, and the verifier independently re-proved the two ordering tests
the Standing Brief Amendments block singles out as historically fragile by disabling the comparator
and watching them go red. The four Operator Verification items are correctly operator-only, and the
one unconfirmed premise stands as Chapter 2 recorded it: whether Discord ever answers a rename-notice
delete with a permanent 4xx is not settled against the live API.
Security review: CONCERNS, no exploitable defect and no architecture-invariant break. The escape
choice, the budget accounting, and the three-way delete gate all verified, including that `visible()`
strips every newline class before a label reaches its fence, that the only path joins are over
`readdirSync` entries which cannot carry a separator, and that the indented description row feeds
`fenced()` directly so it can never reach column zero where a real roster entry sits. Four findings
taken, two with a regression test proven red first:
- The cleaner read `permanent` alone, and a 404 sets it. So a single notice already gone, or one
  thread the operator deleted, latched rename cleanup off for the whole run and every other session
  thread with it. The transport already carried a distinct `missing` flag that nothing read. The
  latch is now `permanent && !missing`.
- The card ordered through the non-finite guard but drew the age straight off `mtimeMs`, so the same
  value the guard exists to bound rendered as `NaNd NaNh`. The age clause now reads `undated` through
  the same guard.
- `docs/security-model.md` documented no message-delete capability at all, while this effort widened
  one from the parent channel to every session thread. It now carries a section naming the three
  binding conditions, the non-retry policy, and why a 404 does not latch.
- `docs/operations.md` described the plan ordering without the per-root cap of 64 that runs ahead of
  it on the name-ordered listing, which `docs/architecture.md` had right.
Declined: snowflake validation on the interpolated channel id, held from Chapter 2 on the same
reasoning (the only value reaching it is discord.js's own on a path already gated by
`parentId === channelId`). Noted, no change: a rate-limited refusal never latches, which is bounded
in practice because `rejectOnRateLimit` makes discord.js throw before sending on a bucket it knows is
empty, so most such refusals cost no HTTP request at all.
Stamps: `memq unstamped` reported zero on both tiers.
Next: none. Every section is Complete.
Commit Model: Commit-and-Push
