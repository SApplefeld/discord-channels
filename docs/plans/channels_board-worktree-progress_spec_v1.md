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

Rulings after the spec shipped, each appended dated. None yet.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the ASSISTANT persona's operator-directed record, the broker sources at `525c05e`, the plugin sources at `a92b351`, and DEV-PLUGIN's persona store read on this machine the same day.

## Approach

**Where the defect is.** The card's queue reader joins a store entry to a plan file by name, looking under the persona's `workdir` only, which is the launch folder the supervisor started the session in. A worker that moved into a linked worktree writes its Chapters there, and the launch folder's copy stays at whatever the branch held when the worktree was cut. The plugin reads the worktree copy, by a walk from the session's live directory, and writes the count to the store. So the store is newer than the file whenever the worker is in a worktree, and the card reads the file.

**Three store fields at intake.** `entryOf` in `broker/board/queues.ts` reads `chapterCount`, `sectionCount` and `nextSection` off the store record, beside the fields it reads today. The two numbers are kept only where finite, integral and non-negative, and `nextSection` only where a string, whitespace-collapsed and held to `MAX_INTAKE_NEXT_LENGTH`, the bound the plan file's own `Next:` value takes. `QueueEntry` gains the three as optional fields.

**The override after the join.** Where the join found a parsed reading and the entry's `chapterCount` is above the reading's `completed`, the reading's `completed` becomes the entry's count, held at or below the section total; its `sections` becomes the entry's `sectionCount` where present and above zero, else the file's; and its `next` becomes the entry's `nextSection` where present, else null, since the file's `Next:` line describes a Chapter the worker has passed. Where the file's count is the higher one, the file wins unchanged: a Chapter written in the launch folder after the worker's last turn is newer. Chapters are append-only, so the higher count is the newer reading in both directions. An archived reading is never overridden: the card has called that entry done.

**The store-only reading.** Where the join found no file in any of the four places and the entry's store status is `active` and it carries `chapterCount`, the reader synthesizes a parsed reading: status `In Progress`, `sections` from `sectionCount` or 0, `completed` from `chapterCount`, `next` from `nextSection` or null, `root` the persona's `workdir`, `stem` the plan name, and the store file's own modification time and size as its stat, since the reading is as fresh as the store. `heldSince` is the queue's own. An entry in any other status, or one with no count, joins to nothing, as today. The reading carries `fromStore: true` so a test and the renderer can tell it from a parse.

**The renderer.** The persona view draws `completed/sections` only where `sections` is above zero. A store-only reading with no `sectionCount` yet has zero sections and a count, so the view gains one form: `<completed> chapters` (`1 chapter` for one) where `sections` is zero and `completed` above zero. Nothing else in the renderer changes.

**The coverage sweep.** Searches run 2026-10-01 at `525c05e`: `PlanReading`, `QueuePlanReading`, `ParsedReading`, `QueueEntry`, `entryOf`, `planSegment`, `textPlanName`, `planName`, `eventPlanName`, `CHANNEL_BOARD_PROJECTS`, `boardProjects`, `sweepPlans`, `eventRoots` and `heldSince` over `broker/` and `docs/`. Surfaces found: `broker/board/queues.ts:114` (`QueueEntry`), `:152` (`QueuePlanReading`), `:360` (`entryOf`), `:659` (`joinPlan`), `:796` to `:810` (the readings map); `broker/board/thread.ts:576`, `:621` (the persona view's reading shape); `broker/board/status.ts:134`, `:138` (`ParsedReading`, `started`); `broker/board/card.ts:72`, `:114`, `:446` (`sectionCount`), `:360`, `:374`; `broker/board/plans.ts:72`, `:95`, `:557`; `broker/config.ts:136`, `:690`; `broker/index.ts:699`; tests `broker/board/queues.test.ts:26`, `:137`, `broker/board/card.test.ts:39`, `:57`, `:392`, `broker/board/status.test.ts:41`, `:64`, `broker/board/thread.test.ts:153`, `:299`, `:351`; docs `docs/operations.md:517`, `:590`, `:1197`, `docs/install.md:112`, `:116`, `docs/architecture.md:713`, `docs/security-model.md:912`, `docs/archive/plans/channels_board-worker-queues_spec_v1.md:55`. The roots, `sweepPlans`, `eventRoots` and the config surfaces are out of scope: this plan reads no new root.

## Sections of Work

### 1. The queue reader takes the three store fields and prefers the newer reading

Model: opus

`entryOf` reads the three fields under the intake rules above. The readings map applies the override and the store-only reading under the rules above.

Acceptance:
- A store record with `chapterCount: 9`, `sectionCount: 11`, `nextSection: "10. The charters"` yields an entry carrying all three. `chapterCount: "9"`, `-1`, `1.5` and `Infinity` each yield an entry with no `chapterCount`. A `nextSection` of newlines and three hundred characters arrives collapsed and held to `MAX_INTAKE_NEXT_LENGTH`.
- A persona whose plan file parses at `completed` 2 of 11 with `next` "3. The executing-work skill", and whose entry carries `chapterCount` 9 and no other field, reads `completed` 9, `sections` 11 and `next` null. With `nextSection` present, `next` is that value. With `sectionCount` 12 present, `sections` is 12. With `chapterCount` 15, `completed` is 11.
- The same persona with `chapterCount` 2 or 1 reads the file's `completed` 2 and the file's `next` unchanged. An archived reading with `chapterCount` 9 beside it is unchanged.
- An active entry whose plan is in none of the four places, carrying `chapterCount` 9 and `sectionCount` 11, reads a parsed reading with `completed` 9, `sections` 11, status `In Progress`, `fromStore` true, and the store file's modification time. The same entry with status `paused`, or with no `chapterCount`, reads nothing, as today.
- The status rule's `started` holds for the store-only reading, so the entry draws as in flight. `blockedAt` on it reads the store's modification time.
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
- assumed 2026-10-01 (default): the store-only reading takes the store file's modification time as its stat, so the in-flight and blocked rules age it by the store; reversal: one assignment.
- assumed 2026-10-01 (default): the count-without-total form is `<n> chapters`; reversal: one template string. Swap menu: `chapter <n>`, `<n> done`.
- assumed 2026-10-01 (default): the blind read and the plan review are skipped, since the spec is two sections over one module and one renderer form; the plugin's companion plan skipped them on the same ground.

## Operator Verification

- After this plan and the plugin's companion merge and the broker restarts, read the board card's line for a persona working a plan in a linked worktree across two section closes. The count moves with the worktree copy. A line still drawing the launch folder's count reopens section 1; a line with a count and no next step after the plugin's plan merged reopens the plugin's plan.

## Open Questions

- None. The field names are fixed under Assumptions and shared with the plugin's plan.

## Chapters
