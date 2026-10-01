# The board card draws a worker's plan progress from the worker's own store reading

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

The `Fleet: Board` card's line for a worker's plan in flight shows the Chapter count the worker's own plugin recorded at its last turn end, and the next step from the same source, so a persona working its plan in a linked worktree is drawn where it actually is. Today the card reads the plan file under the persona's launch folder, which a worktree never updates, and drew `2/11, next: 3. The executing-work skill` for a worker on section 9. The persona store the card already reads each tick carries `chapterCount` for that entry, and two companion fields the plugin's plan `agent_persona_plan-record-sections_spec_v1.md` adds, `sectionCount` and `nextSection`. This plan reads all three, prefers the store's count over a staler file, and draws a plan that has no file under any swept folder from the store alone.

## Intent

The operator's frame, through the ASSISTANT persona on 2026-10-01: a plan-tracked goal's Chapter count on the card should follow the copy of the plan the worker actually updates. In his words: "let's see if it's a gap we can improve on, even if maybe not fully, deterministically close."

What done needs to do. For an entry whose store record carries a Chapter count above what the card counted from the file, the card draws the store's count and drops the file's stale next step, drawing the store's next step where the store carries one. For an active entry whose plan file is in none of the four places the card looks, the card draws a line from the store alone rather than no count at all. The store's three fields pass the same intake every other store field passes: a number that is not a finite non-negative integer is dropped, and the next step is whitespace-collapsed and bounded. No new path is opened. The security model states the three fields as intake.

What done does not need to do. It does not enumerate git worktrees, read `.git` files, spawn git, or open any path a store, a plan file or an event names. The plan reader's rule at the top of `broker/board/plans.ts`, that a path comes only from configuration, stands untouched. It does not change the folder view, where a plan is drawn under a configured project root with no store beside it. It does not change what counts as a completed section when the file's count is the higher one.

Alternatives refused. Enumerating `git worktree list` under each persona's folder and reading the newest copy, the ASSISTANT's second direction: refused because a worktree's path would be a path read out of a `.git` file, which the reader's own rule forbids, and because the store already carries the figure. Having the plugin record the path of every Edit or Write that names the plan file, the first direction: refused in the plugin's plan, since the plugin's own count is already right, which DEV-PLUGIN's store proved on 2026-10-01 with the mechanism-cut holder at Chapter 9. Waiting for the plugin's two new fields before shipping anything here: refused because the Chapter count alone closes the visible defect today and the two fields only complete the line.

Rulings after the spec shipped, each appended dated.

- decided 2026-10-01 by the operator ("Agreed, Fix it"), on the scope adjudicator's ask and the ARCHITECT persona's concurring answer: a store-only reading never clears a `goal-blocked` block by its modification time, and it clears only on a `goal-complete` for the pair or the entry leaving the store's `active` status. The store is rewritten at every turn end, the blocking turn's included, so its write says the worker took a turn and not that a Chapter landed. The in-flight rule keeps aging the reading by the store, since there the question is whether the worker is taking turns. A stale "blocked" sends the operator to look, where a false clear hides a stopped run.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the ASSISTANT persona's operator-directed record, the broker sources at `525c05e`, the plugin sources at `a92b351`, and DEV-PLUGIN's persona store read on this machine the same day.

## Approach

**Where the defect is.** The card's queue reader joins a store entry to a plan file by name, looking under the persona's `workdir` only, which is the launch folder the supervisor started the session in. A worker that moved into a linked worktree writes its Chapters there, and the launch folder's copy stays at whatever the branch held when the worktree was cut. The plugin reads the worktree copy, by a walk from the session's live directory, and writes the count to the store. So the store is newer than the file whenever the worker is in a worktree, and the card reads the file.

**Three store fields at intake.** `entryOf` in `broker/board/queues.ts` reads `chapterCount`, `sectionCount` and `nextSection` off the store record, beside the fields it reads today. The two numbers are kept only where finite, integral and non-negative, and `nextSection` only where a string, whitespace-collapsed and held to `MAX_INTAKE_NEXT_LENGTH`, the bound the plan file's own `Next:` value takes. `QueueEntry` gains the three as optional fields.

**The override after the join.** Where the join found a parsed reading and the entry's `chapterCount` is above the reading's `completed`, the reading's `completed` becomes the entry's count, held at or below the section total; its `sections` becomes the entry's `sectionCount` where present and above zero, else the file's; and its `next` becomes the entry's `nextSection` where present, else null, since the file's `Next:` line describes a Chapter the worker has passed. Where the file's count is the higher one, the file wins unchanged: a Chapter written in the launch folder after the worker's last turn is newer. Chapters are append-only, so the higher count is the newer reading in both directions. An archived reading is never overridden: the card has called that entry done.

**The store-only reading.** Where the join found no file in any of the four places and the entry's store status is `active` and it carries `chapterCount`, the reader synthesizes a parsed reading: status `In Progress`, `sections` from `sectionCount` or 0, `completed` from `chapterCount` held at or below `sections` where that is above zero, `next` from `nextSection` or null, `root` the persona's `workdir`, `stem` the plan name, and the store file's own modification time and size as its stat, since the reading is as fresh as the store. `heldSince` is the queue's own. An entry in any other status, or one with no count, joins to nothing, as today. The reading carries `fromStore: true` so a test and the renderer can tell it from a parse.

**The renderer.** The persona view draws `completed/sections` only where `sections` is above zero. A store-only reading with no `sectionCount` yet has zero sections and a count, so the view gains one form: `<completed> chapters` (`1 chapter` for one) where `sections` is zero and `completed` above zero. Nothing else in the renderer changes.

**The coverage sweep.** Searches run 2026-10-01 at `525c05e`: `PlanReading`, `QueuePlanReading`, `ParsedReading`, `QueueEntry`, `entryOf`, `planSegment`, `textPlanName`, `planName`, `eventPlanName`, `CHANNEL_BOARD_PROJECTS`, `boardProjects`, `sweepPlans`, `eventRoots` and `heldSince` over `broker/` and `docs/`. Surfaces found: `broker/board/queues.ts:114` (`QueueEntry`), `:152` (`QueuePlanReading`), `:360` (`entryOf`), `:659` (`joinPlan`), `:796` to `:810` (the readings map); `broker/board/thread.ts:576`, `:621` (the persona view's reading shape); `broker/board/status.ts:134`, `:138` (`ParsedReading`, `started`); `broker/board/card.ts:72`, `:114`, `:446` (`sectionCount`), `:360`, `:374`; `broker/board/plans.ts:72`, `:95`, `:557`; `broker/config.ts:136`, `:690`; `broker/index.ts:699`; tests `broker/board/queues.test.ts:26`, `:137`, `broker/board/card.test.ts:39`, `:57`, `:392`, `broker/board/status.test.ts:41`, `:64`, `broker/board/thread.test.ts:153`, `:299`, `:351`; docs `docs/operations.md:517`, `:590`, `:1197`, `docs/install.md:112`, `:116`, `docs/architecture.md:713`, `docs/security-model.md:912`, `docs/archive/plans/channels_board-worker-queues_spec_v1.md:55`. The roots, `sweepPlans`, `eventRoots` and the config surfaces are out of scope: this plan reads no new root.

## Standing Brief Amendments

- A reading the store alone gives never clears a `goal-blocked` block by its modification time; it clears only on a `goal-complete` for the pair, the store ceasing to say the worker is on the entry, or the store dropping its `chapterCount`, and the in-flight rule still ages the reading by the store.
- A store `sectionCount` of zero leaves the file's known section total in place, since a zero total is no newer reading of it.
- A store-only reading carries the store's hold instant as its `heldSince`, so a torn store ages that line as it ages any held reading.
- `docs/security-model.md` states the three fields' intake rule in a paragraph of its own under the first property, beside the lead paragraph's naming of them.
- `docs/architecture.md` and `docs/operations.md` each state, in one sentence, when a store-only entry's blocked mark clears.
- A file reading the store overrode on an entry the worker is on is aged for the in-flight rule by the later of its file's modification time and the store file's, and for the blocked rule by its file's alone, so a worktree worker's entry outranks a parked plan whose file was touched after the worktree was cut.
- The store says the worker is on an entry when its status is `active`, or `blocked` with the reason `Max rounds reached`, which `status.ts` already treats as ordinary running; that one test keys both the store-only reading and the store's turn time, and widens the Assumption that named `active` alone.

## Sections of Work

### 1. The queue reader takes the three store fields and prefers the newer reading

Model: opus

`entryOf` reads the three fields under the intake rules above. The readings map applies the override and the store-only reading under the rules above.

Acceptance:
- A store record with `chapterCount: 9`, `sectionCount: 11`, `nextSection: "10. The charters"` yields an entry carrying all three. `chapterCount: "9"`, `-1`, `1.5` and `Infinity` each yield an entry with no `chapterCount`. A `nextSection` of newlines and three hundred characters arrives collapsed and held to `MAX_INTAKE_NEXT_LENGTH`.
- A persona whose plan file parses at `completed` 2 of 11 with `next` "3. The executing-work skill", and whose entry carries `chapterCount` 9 and no other field, reads `completed` 9, `sections` 11 and `next` null. With `nextSection` present, `next` is that value. With `sectionCount` 12 present, `sections` is 12. With `chapterCount` 15, `completed` is 11.
- The same persona with `chapterCount` 2 or 1 reads the file's `completed` 2 and the file's `next` unchanged. An archived reading with `chapterCount` 9 beside it is unchanged.
- An active entry whose plan is in none of the four places, carrying `chapterCount` 9 and `sectionCount` 11, reads a parsed reading with `completed` 9, `sections` 11, status `In Progress`, `fromStore` true, and the store file's modification time. The same entry with status `paused`, or with no `chapterCount`, reads nothing, as today. With `chapterCount` 15 it reads `completed` 11.
- The status rule's `started` holds for the store-only reading, so the entry draws as in flight. A `goal-blocked` event for it stands however far the store's modification time has moved past the event (ruling 2026-10-01 under Intent).
- `npm test` exits 0 with the new cases present and no prior case removed.

Files in scope: `broker/board/queues.ts`, `broker/board/queues.test.ts`, `broker/board/status.ts` (only where `ParsedReading` or `started` must admit `fromStore`), `broker/board/status.test.ts` (only where a fixture needs the new field).
Tests: the three intake rules in both directions; the override's four readings, the file winning at an equal or higher count, and the archived carve-out; the store-only reading for an active entry and its absence for a paused one and for one with no count; `started` on the store-only reading.

### 2. The persona view draws a count with no total, and the docs state the three fields

Model: sonnet

The renderer gains the `<completed> chapters` form. The docs name the three fields as store intake.

Acceptance:
- A persona entry whose reading has `sections` 0 and `completed` 9 draws `9 chapters` where the count sits; with `completed` 1 it draws `1 chapter`; with `completed` 0 it draws no count, as today. A reading with `sections` 11 and `completed` 9 still draws `9/11`.
- The render-cost test's bound is unchanged by the new form.
- `docs/security-model.md`, in the paragraph opening "The board card reads foreign files and sends none of their paths", names `chapterCount`, `sectionCount` and `nextSection` as fields read from each persona's store, each held to the intake rule section 1 states, and says that none is used as a path. `docs/operations.md`, where it states what the board card draws for a worker's plan, says the count is the worker's own where the store's is newer than the file's, and that a plan with no file under the worker's folder draws from the store. `docs/architecture.md:713`'s sentence on the persona view says the same in one clause.
- `docs/README.md` carries this plan's row and `docs/plans/README.md` names it as open.
- `npm test` exits 0.

Files in scope: `broker/board/card.ts`, `broker/board/card.test.ts`, `docs/security-model.md`, `docs/operations.md`, `docs/architecture.md`, `docs/README.md`, `docs/plans/README.md`.
Tests: the three count forms, and the cost bound holding.

## Out of Scope

- Any new root, path or process: worktree enumeration, `.git` reads, git itself.
- The folder view's rows under configured project roots, which have no store beside them.
- The plugin's writing of `sectionCount` and `nextSection`, which is `agent_persona_plan-record-sections_spec_v1.md` in the plugin's repository. This plan reads `chapterCount`, which the plugin writes today, and the other two whenever they appear.
- A change to the completed-section rule where the file's count is the higher one.

## Assumptions

- assumed 2026-10-01 (source: DEV-PLUGIN's store on this machine, holder `plan-muovpehg-ew9q` at `chapterCount` 9 while `D:\claude-kit\docs\plans\claude-kit_mechanism-cut_spec_v1.md` held two Chapters): the store is the newer reading whenever a worker is in a worktree, and the file whenever it is not; reversal: none needed, the higher count wins in either direction.
- assumed 2026-10-01 (source: the plugin's plan under Assumptions): the companion field names are `sectionCount` and `nextSection`; reversal: rename in both plans before either is armed.
- assumed 2026-10-01 (default): a store-only reading is synthesized for an `active` entry alone, since the store carries no document status and `active` is the one store status that says the worker is on it; reversal: one condition.
- assumed 2026-10-01 (default): the store-only reading takes the store file's modification time as its stat, so the in-flight rule ages it by the store; the blocked half was reversed by the operator's ruling of 2026-10-01 under Intent, and a store-only reading never clears a block by that time; reversal: one assignment.
- assumed 2026-10-01 (default): the count-without-total form is `<n> chapters`; reversal: one template string. Swap menu: `chapter <n>`, `<n> done`.
- assumed 2026-10-01 (default): the blind read and the plan review are skipped, since the spec is two sections over one module and one renderer form; the plugin's companion plan skipped them on the same ground.

## Operator Verification

- After this plan and the plugin's companion merge and the broker restarts, read the board card's line for a persona working a plan in a linked worktree across two section closes. The count moves with the worktree copy. A line still drawing the launch folder's count reopens section 1; a line with a count and no next step after the plugin's plan merged reopens the plugin's plan.

## Open Questions

- None. The field names are fixed under Assumptions and shared with the plugin's plan.

## Chapters

### Interim board 1 - 2026-10-01

- Section 1: round 1 adjudicated, held on one operator decision. The blind reviewer's Major (orchestrator-traced: Goal sentence 1, new-requirement as it reverses the Assumption at line 86): a store-only reading's `mtimeMs` is the store file's, and `blockedAt` (`broker/board/card.ts:422`) clears an event-found block once that passes the event, so a store-only block clears at the next turn-end store write. Scope adjudicator ruled ask (fable, Agent tool); asked of the operator on the relay thread, expert ask to ARCHITECT, notice to STEWARD. Recommended form if approved: in `status.ts`'s event-block check, a `fromStore` reading passes `mtimeMs` negative infinity to `blockedAt`, leaving the in-flight rule on the store's mtime. The other Major (store `sectionCount` 0 erased the file's total) is fixed in 3c88669.
- Section 2: round 1 adjudicated, Minors only; close pass done in 3c88669. Closes with section 1.
- Live dispatches: none.
- Gate: targeted lane (queues, status, card, thread tests) 186/186, exit 0, tsc exit 0, at 3c88669 on a clean tree, 2026-10-01 ~16:10 -04:00, no foreign runner on the box.
- Rulings adopted: none yet.
- Next: on the operator's answer, apply or record the ruling, re-run the lane, write Chapters 1 and 2, then finishing-work. PR #36 is open as a draft with auto-merge off.

### Chapter 1 - 2026-10-01
Completed: 1. The queue reader takes the three store fields and prefers the newer reading
Implemented By: implementer-opus (first build, prior session, 23f8ee9); main session for the fix rounds and the ruling's fix after a session restart
Metrics: review rounds 2, closed claim-exit; provenance 1 spec-traceable, 0 fix-introduced, 1 new-requirement, rulings (0 refused, 0 declared, 1 asked); advisory: 1 findings (security Minor), 0 fixed, 0 deferred, 1 refused as covered by docs/backlog.md:486; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: section 1 open: changes entryOf intake (three store fields) and the queue reader's readings map (override after the join, store-only reading); serves Goal sentences 1 and 3 and Intent "what done needs to do"; adds the mechanisms the Approach names and no other; size about 60 lines of source plus tests; not building it leaves mechanism-cut's card drawing 2/11 while the worker is on Chapter 9. / r1 fix (blind Major, queues.ts:819): preferNewer takes the store's sectionCount only where above zero, else keeps the file's total; serves section 1 acceptance 'With sectionCount 12 present, sections is 12' and Goal sentence 1 (orchestrator-made trace); adds no mechanism (one condition); size 1 line plus one test; not building it lets a store writing sectionCount 0 erase a file's known 11 and draw '9 chapters' for '9/11'. / r1 fix (blind Major, operator ruling 2026-10-01): eventBlocked passes mtimeMs negative infinity for a fromStore reading so a store write never clears a goal-blocked block; serves the dated ruling under Intent and Goal sentence 1; adds no mechanism the ruling does not name (one assignment); size 2 lines plus one test case flipped; not building it clears a store-only worker's blocked mark within one turn. / The prior session died while its round-1 reviewers were out; this session re-ran the lane and re-dispatched round 1. Draft PR #36 had already been opened by that session. Spec deviations, each amended in the spec: the override takes sectionCount only above zero (Approach), and the store-only reading caps completed at its total (Approach and acceptance bullet 4). Approval drift: the operator's ruling of 2026-10-01 added a dated Intent ruling, flipped the Assumption's blocked clause and acceptance bullet 5, and created the Standing Brief Amendments block. The ARCHITECT's answer said only goal-complete clears; the code also clears when the store stops calling the entry active, so every carrier states both.
Failed approaches: none
Assumptions: none
Review Findings: review: adversarial at fable, Agent tool; blind at fable, Agent tool; security at fable, Agent tool; performance at fable, Agent tool (round 1); adversarial at opus, Workflow high (round 2, over both sections' fix delta). Major (blind, sectionCount 0 erases the file's total): fixed in 3c88669, trace orchestrator-made. Major (blind, store-only block cleared by the store's per-turn mtime): held, scope adjudicator (fable, Agent tool) ruled ask on the Assumption it reverses, ARCHITECT concurred, operator ruled "fix it", fixed in f6a7c76. Minors: 3 fixed in the close pass (storeOnly clamp, readings-map doc, round 2's spec store-only paragraph); 4 left with the reason: the per-entry absent closure (noise on a stat-bound loop), the transient-stat fall-through (the store's figures are the worker's own and a fair draw for that tick), the in-flight tie between two store-only readings (rare; the spec chose the store mtime for that rule), countField admitting -0 (draws as 0); the status-vocabulary single-sourcing Minor left since status.ts carries no `active` word to share and imports from queues.ts. Round 2's stale interim-board Minor left: these Chapters supersede the entry in the doc's own order.
Stamps: adjudicated 9, stamped 0 (all nine are other sessions' reads of the operator tier; none shaped this section)
Gate: targeted lane (queues, status, card, thread tests) 186/186, exit 0, tsc exit 0, wall 0.46 s, 2026-10-01T17:19-04:00 on the close-pass tree over f6a7c76, no foreign runner found by the process poll at resume; baseline at resume on the same lane 185/185 exit 0 at cfca54c. Tests added: "a store-only reading holds its count at or below the store's section total" (pins the cap); edited: the override test gains the "untotalled" leg (pins a store total of zero keeping the file's), and the store-only block test's last case flipped to "blocked" (pins the 2026-10-01 ruling). Spawning tests added: 0. Retired: none.
Next: 2. The persona view draws a count with no total, and the docs state the three fields
Commit Model: Branch-and-PR
Delta: 2026-10-01T17:20-04:00, SCOTT-CLAUDE, no contention. kit-size measured no corpus in this repository:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-10-01
Completed: 2. The persona view draws a count with no total, and the docs state the three fields
Implemented By: implementer-sonnet (first build, prior session, cfca54c); main session for the close pass
Metrics: review rounds 2, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 1's ruling changed behavior this section's docs describe, so `docs/operations.md` and `docs/architecture.md` (the block-clearing sentence at the persona view's marker rule) were re-opened and corrected under step 5. The security-model fields were first merged into the wrong paragraph in the close pass; round 2 caught it, and the lead paragraph now names the three fields with the detail paragraph restored.
Failed approaches: tried folding the three-field paragraph into the paragraph above it to meet the acceptance bullet's "in the paragraph opening", failed because that was the store-exception paragraph whose topic is "a file name and nothing more", learned the named paragraph is the four-line lead, which now names the fields itself.
Assumptions: none
Review Findings: review: adversarial at opus, Workflow high (round 1); blind at fable, Agent tool (round 1, over both sections' code); security and performance at fable, Agent tool (round 1, whole changeset); adversarial at opus, Workflow high (round 2). No Critical or Major. Minors: 7 fixed in the close passes (security-model placement, twice; operations store-only conditions; the dropped caveat restored; architecture rewrap; card.ts comment scoped to the persona view; operations and status.ts rewraps), 0 left.
Stamps: adjudicated 9, stamped 0 (the same window as Chapter 1)
Gate: targeted lane 186/186, exit 0, tsc exit 0, at the same run as Chapter 1. Tests added: none this round beyond the prior session's count-form test (card.test.ts, pins `9 chapters`, `1 chapter`, no count at 0, `9/11`). Spawning tests added: 0. Retired: none. The render-cost test's bound is untouched (both round-1 reviewers confirmed by reading).
Next: finishing-work
Commit Model: Branch-and-PR
Delta: as Chapter 1's reading; kit-size measured no corpus in this repository.

### Interim board 2 - 2026-10-01

- Finishing pass, base ref 525c05e. QA (qa-verifier): PASS, full suite 2357/2356/0/1 skip exit 0, lint and tsc exit 0, every acceptance bullet verified.
- Advisory (fable, Workflow high): security CLEAR, performance CLEAR. Dispositions: npm audit advisories covered by docs/backlog.md:486; the third store-only clearing route (a store write dropping chapterCount) and the rest go to the Minor pass.
- Final adversarial (fable, Workflow high): one Major. Add-decision: in-flight rule ages an overridden reading by the later of file and store mtime, block rule keeps the file's; serves Goal sentence 1 and "the next step from the same source"; adds a mechanism (a second mtime on an overridden reading); about 10 lines plus one test; not building it can draw a worktree worker's entry as parked beside a later-touched parked plan, hiding its next step. Design stop: scope adjudicator first returned NEEDS_CONTEXT on a brief defect (the brief named `## Approach`, which its charter bars); corrected and re-dispatched once; ruled ask, conditioned on the Approach recording the file-stat choice and declare otherwise. The Approach records no such choice, so the orchestrator adopted declare; fixed in 0c06120 and added to the Standing Brief Amendments.
- Goal read (scope adjudicator, fable, Agent tool): 4 built-but-unasked, all declared into the Standing Brief Amendments; 0 asked-but-unbuilt.
- Live dispatches: fix-round adversarial over a6e78df..0c06120 (Workflow wf_0d83f72a-dd0, fable high).
- Gate: targeted lane 187/187 exit 0, tsc exit 0, at 0c06120 on a clean tree, 2026-10-01 ~17:45 -04:00.
- Next: adjudicate the fix round; Minor pass from .kit/scratch/board-worktree-progress/finishing/minors.md (fix: store-only block test's goal-complete leg, security-model's literal 400, the third clearing route in docs and the status.ts comment); docs curation; final Chapter, archive, whole gate; mark PR #36 ready and arm auto-merge.
