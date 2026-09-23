# Give Each Hand-Copied Broker Helper One Owner

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

Each small mechanism the broker has copied by hand across its modules lives in one place that every
caller imports, and the one copy that is wrong today is fixed by the move. Four families are
copied now. The rate-limited repeat logger exists as eight copies. The standing cards' binding
module exists as three. The size-capped file read exists as four. The non-finite modification-time
clamp exists as two. The usage cache's copy of the capped read performs a single read with no
loop, so a short read hands the parser a prefix of the file under the name of the whole, which the
parser refuses as malformed and the usage card reads as unavailable for that poll. The
codebase's own precedent set three copies as the point to extract, and every family but the clamp
is past it. When this is done each family has one owner, the usage cache's read loops like its
siblings, and no caller's observable behaviour changes otherwise. The four backlog entries left the
active list when the operator approved the candidate for planning, and sit in
`docs/archive/backlog-2026-Q3.md`
under "Planned 2026-09-22".

## Dispatch Authorization

The operator ruled this backlog candidate a go on 2026-09-22, in a batched ruling the coordinator
relayed to the architect as coordinator record `ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-11`:

> Operator's ruling on the three backlog candidates: approved #1 (tail-test flake group) and #2
> (shared helper module), declined #3 (thread delivery allow-list).

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff.

## Intent

**The frame.** This plan originates from the DEV-DISCORD worker seat rather than from an operator
ask, under the operator's standing pattern relayed by the coordinator on 2026-09-22: when the
worker's queue is empty, it drafts plans from `docs/backlog.md` for the Architect seat to finalize.
It folds four backlog entries: "Fold the eight duplicated `createRepeatLog` implementations into
one", "The three standing cards' binding modules are near-duplicates", "Give the capped file read
one owner, and fix the copy that does not loop", and "Give the non-finite modification time guard
one owner".

**What done needs to do.** One owner per family, imported by every caller. The usage cache's
capped read loops until the descriptor drains. Every log line the repeat logger writes keeps its
exact text per surface, since operators and memory records grep for those lines. The queue
reader's stat keeps refusing anything that is not a regular file.

**What done does not need to do.** It does not change any window, cap or log wording. It does not
take the backlog's filesystem-path-guard entry, which needs a read of two hostile boundaries'
rules before anyone can say whether one guard serves both; that stays on the backlog. It does not
extract anything with fewer than two copies. It does not touch the board events reader's own
offset read in `broker/board/events.ts`, which returns bytes from a position with a rotation check
and is a different contract from the four text reads.

**Alternatives refused.**
- Four plans, one per family. Refused, because each section is already reviewable and revertible
  on its own, and one round closes four former backlog entries.
- Proving the short read on a real disk. Refused, because a short `readSync` cannot be provoked
  there on demand, so the test would prove nothing either way.
- Exporting the clamp from the card renderer or from the status module. Refused, because the
  status module already imports from the card, so an export from status makes an import cycle, and
  an export from the card adds a fifth export to a renderer whose export list an earlier plan's
  approved section fixed at four.
- Keeping each logger's own order of state and log. Refused, because the judge's order is the one
  that survives a throwing log, and the other seven differ from it only by accident.

**Rulings.** Decided 2026-09-22 by the architect on the drafter's five questions: one plan with
four sections; the shared read takes an injectable reader so the short read can be proven red;
the clamp lives in `broker/board/events.ts`, which both callers already import and which imports
nothing from the board; the judge's state-before-log order applies to all eight loggers; opus for
the logger section and sonnet for the other three.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session from the four backlog entries and
from the code at `origin/main` `0690eb4`, read that day through a read-only scout. The drafting
session re-read the capped-read defect and the eight logger definitions. Finalized 2026-09-22 by
the architect, who re-read every code anchor the Approach names at that commit.

## Related plans

None open. `../archive/plans/channels_board-worker-queues_spec_v1.md` (complete) is the plan whose
approved section line bounded the card renderer's exports, which is why the clamp does not live
there.

## Approach

**What exists today.**

- **Repeat logger.** Eight private `createRepeatLog` functions: `broker/tail.ts:780`,
  `broker/question-desk.ts:350`, `broker/routing/interactions.ts:109`, `broker/inbox/judge.ts:200`,
  `broker/discord/pins.ts:113`, `broker/usage/thread.ts:76`, `broker/board/thread.ts:111`,
  `broker/inbox/thread.ts:58`. All share one core: write the first line for a key, count repeats
  inside the window, and write an "occurred N more time(s)" line when the window closes. They
  differ in five ways:
  - the window is 60 s in the first four and 5 minutes in the last four;
  - the three 60 s copies in tail, question desk and routing evict past 64 keys, and the others do
    not;
  - the call shape is `(reason, detail)`, `(reason)` or `(kind, sessionId)`;
  - the log prefix and the count line's unit (`ms` or `minutes`) differ;
  - the judge's copy alone updates its state before it logs, so a throwing log cannot leave the
    window stale.
  Two further limiters share the core and stay local: the intake's refusal limiter
  (`broker/intake.ts:161`) and the router's drop limiter (`broker/routing/outbound.ts:217`). Each
  writes through a different kind of log sink, a `Logger`'s warn level against a plain log
  function, and their headers say so.
- **Card binding.** `broker/board/binding.ts` and `broker/usage/binding.ts` (117 lines each) and
  `broker/inbox/binding.ts` (115) are one module in three spellings. They differ in type names, log
  labels, header prose, and one fact: board and usage define a private `SNOWFLAKE` regex where the
  inbox imports the shared one from `broker/security/senders.ts:27`. A fourth private copy of that
  regex sits at `broker/discord/bindings.ts:67`.
- **Capped read.** Three copies loop the read until the buffer fills or a read returns 0:
  `readPlanFile` in `broker/board/plans.ts:427` (exported), `readCappedFile` in
  `broker/board/queues.ts:214`, and `readRosterFile` in `broker/board/roster.ts:69`.
  `readCapped` in `broker/usage/cache.ts:271-281` reads once (confirmed at lines 279-280). Each
  defines its own identical result type.
- **Clamp.** `touchedAt` is identical in `broker/board/card.ts:445-447` and
  `broker/board/status.ts:140-142`. The status module imports from the card, and both import from
  `broker/board/events.ts`, which imports only `broker/sanitize.ts`.
- **Queue reader copies.** `broker/board/queues.ts` hand-copies `WHITESPACE_RUN`, `bounded`,
  `MARKDOWN_SUFFIX`, the README stem, `planStem` and the stat from `broker/board/plans.ts`. Its stat
  alone adds `if (!stat.isFile()) return null;`, which the shared one must keep for that caller.
- **No shared home exists** for file or logging helpers. `broker/sanitize.ts` holds only text
  helpers.

**The design.**

1. A new `broker/repeat-log.ts` exports one `createRepeatLog` taking the window, an optional key
   cap for eviction, and a function that composes each surface's two lines, so every surface keeps
   its exact text. The shared core takes the judge's order, state before log, as the safer of the
   two orders. That is a behaviour change only for a log function that throws.
2. A new `broker/card-binding.ts` exports one load and one save taking a label, and the three card
   modules stay as thin callers, so `docs/architecture.md`, which names `binding.ts` beside the
   inbox card, stays true. Every `SNOWFLAKE` copy imports the one in
   `broker/security/senders.ts`.
3. A new `broker/capped-read.ts` exports the looping read and its result type, parameterised by the
   cap, and takes an optional reader function whose default is `readSync` and whose parameters and
   return are `readSync`'s own, so a test can hand it a reader that delivers a file in two chunks.
   All four callers use it, which fixes the usage cache.
4. `touchedAt` is exported once from `broker/board/events.ts` and imported by the card and the
   status module, and `broker/board/queues.ts` imports the plan helpers from
   `broker/board/plans.ts`, which exports them. The shared stat takes a boolean option, off by
   default, that refuses anything not a regular file, and the queue reader passes it on.

## Sections of Work

The four sections run in order as commits on one work branch cut from `origin/main`, named by the
worker, with this plan file on it, and finishing-work opens the one pull request.

### 1. The capped file read has one owner, and the usage cache's read loops
Model: sonnet

Tests: lock that the shared read returns a file under the cap whole; that it refuses a file over
the cap as oversized; that it returns a file delivered in two short reads whole; and that an
unopenable file reads as unreadable. The two-chunk case earns its red against the usage cache's
single-read shape: copy the shared module aside, run the test once with its loop replaced by that
single read, watch it fail, restore the module from the copy and diff the two, and watch it pass.

Create `broker/capped-read.ts` and point the four callers at it, deleting the private copies and
result types nothing else imports. `readPlanFile` and `PlanRead` stay exported from
`broker/board/plans.ts`, the function as a one-line wrapper over the shared read, since
`broker/board/queues.ts`, `broker/board/plans.test.ts`, `broker/board/queues.test.ts` and
`broker/board/thread.test.ts` import them. This section touches nothing else the queue reader
imports; section 4 owns those.

Acceptance: the tests exist, and the short-read test was observed red first; `npm run lint` exits 0;
`node --test broker/usage/cache.test.ts broker/board/plans.test.ts broker/board/queues.test.ts
broker/board/roster.test.ts` exits 0 against a same-lane baseline.

Files in scope: `broker/capped-read.ts` (new), `broker/capped-read.test.ts` (new),
`broker/usage/cache.ts`, `broker/board/plans.ts`, `broker/board/queues.ts`, `broker/board/roster.ts`.

### 2. The repeat logger has one owner
Model: opus

Tests: lock the shared logger's four behaviours: the first line writes, a repeat inside the window
writes nothing, the window's close writes the count line and then the new line, and eviction past
the key cap writes the pending count line each evicted key owes. Every existing test that asserts a surface's log
text must still pass unchanged. The new `broker/repeat-log.test.ts` pins each of the eight
surfaces' first line and count line verbatim against the text each surface writes before the move,
read from the tree the section starts on, since only three of the eight surfaces' own suites pin a
count line today.

Create `broker/repeat-log.ts` and replace the eight private copies. `MAX_REPEAT_KEYS` stays
exported from `broker/question-desk.ts`, since its test imports it.

Acceptance: the tests exist; `npm run lint` exits 0; the full suite exits 0 against a whole-gate
baseline, since the eight callers span most of the broker.

Files in scope: `broker/repeat-log.ts` (new), `broker/repeat-log.test.ts` (new), `broker/tail.ts`,
`broker/question-desk.ts`, `broker/routing/interactions.ts`, `broker/inbox/judge.ts`,
`broker/discord/pins.ts`, `broker/usage/thread.ts`, `broker/board/thread.ts`,
`broker/inbox/thread.ts`.

### 3. The card binding has one owner
Model: sonnet

Tests: the existing binding tests for all three cards pass unchanged; add one test that the shared
module's log lines carry the label it was given.

Create `broker/card-binding.ts`, reduce the three card modules to thin callers of it that keep
their file names and re-export their per-card type names as aliases of the shared type, so their
tests import unchanged, and point every `SNOWFLAKE` at `broker/security/senders.ts`.

Acceptance: `npm run lint` exits 0; the three cards' binding tests and the new test exit 0 against a
same-lane baseline.

Files in scope: `broker/card-binding.ts` (new), `broker/card-binding.test.ts` (new),
`broker/board/binding.ts`, `broker/usage/binding.ts`, `broker/inbox/binding.ts`,
`broker/discord/bindings.ts`, `broker/board/binding.test.ts`, `broker/usage/binding.test.ts`,
`broker/inbox/binding.test.ts`, `broker/discord/bindings.test.ts`.

### 4. The clamp and the queue reader's helpers import from one place
Model: sonnet

Runs after section 1 on the same branch.

Tests: the board card, status and queue tests pass unchanged, and a queue test still proves a
directory in the queue is refused.

Export `touchedAt` from `broker/board/events.ts` and import it in the card and the status module,
deleting both private copies. Export the plan helpers from `broker/board/plans.ts` and import them
in `broker/board/queues.ts`, keeping the regular-file refusal.

Acceptance: `npm run lint` exits 0; `node --test broker/board/*.test.ts` exits 0 against a same-lane
baseline; `touchedAt` is defined once across `broker/board/`.

Files in scope: `broker/board/events.ts`, `broker/board/card.ts`, `broker/board/status.ts`,
`broker/board/plans.ts`, `broker/board/queues.ts`.

## Out of Scope

- The filesystem-path guard entry, which stays on the backlog.
- Any change to a window, a cap or a log line's wording.
- The board events reader's offset read in `broker/board/events.ts`, a different contract from the
  four text reads.
- The intake's refusal limiter (`broker/intake.ts:161`) and the router's drop limiter
  (`broker/routing/outbound.ts:217`), which their own headers keep local because each holds a
  different log seam.

## Assumptions

- assumed 2026-09-22 (the repository's plans): the commit model is Branch-and-PR; reversal: one
  header line.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose
  executing-work and testing-discipline skills own the lane vocabulary, the baseline captured on
  the same command before a change, the pre-probe copy and diff restore, and the Chapter; reversal:
  a paragraph naming each.
- The plan review ran at fable and effort high and returned READY_WITH_FINDINGS, four Major and
  three Minor, all applied. The blind read returned 7 questions and 4 comprehension gaps: 10
  answered in the spec, 1 assumed above, 0 asked. The gating litmus: 4 definitions, the four Files
  in scope lists; 4 one-sided, since the author had counted none and the reader all four; 0
  crossed, 0 unplaced, 0 under-length, every pair placed as the reader placed it. Each list is the
  closed set it reads as, so none was rewritten.

## Operator Verification

- None beyond the gate. The usage card's short read fails closed today, so there is nothing live
  to watch.

## Chapters

### Chapter 1 - 2026-09-22
Completed: 1. The capped file read has one owner, and the usage cache's read loops
Implemented By: implementer-sonnet; close-pass Minors fixed by the main session
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- Section 1 open: moves four capped reads onto one exported `readCappedFile` in `broker/capped-read.ts`; serves the Goal sentence "the usage cache's read loops like its siblings" and Approach design item 3; adds one mechanism the design names (the injectable reader parameter, design item 3), nothing unnamed; about +60 lines new module, about -110 lines across four callers; not building it leaves the usage card reading "unavailable" on any short read.
- The implementer's report carried no add-decision line of its own; every mechanism it built is design item 3's.
- Status header normalized from `Ready` to `In Progress` at run start (commit 4e7dc49).
- No file imports `CappedRead` from `usage/cache.ts` or `board/queues.ts`, so both keep the name only as an exported alias of the shared type, because their exported option signatures name it.
- The spec's "two short reads" test first used a 3-byte reader, which delivers four chunks; the close pass set it to 5 bytes so the test is the two-chunk case the Tests line names.
Assumptions:
- assumed 2026-09-22 (the main session, section 1): where a module exported its own `CappedRead`, it keeps that name as a type alias of the shared one rather than dropping the export, so no module's public surface changes; reversal: delete two alias lines and point the option types at the shared type.
Review Findings: review: adversarial + blind at opus, Workflow (effort high); no Critical, no Major. Minors: 6 fixed in the close pass (two false alias comments, the shared header's "every board reader" claim that the events reader contradicts, a copied "this module refuses to recognize" sentence, the misnamed two-chunk test, and the missing cap-boundary pins, which added two tests), 0 upgraded, 0 left. Close-pass author re-read of the delta done. The two added boundary tests were observed red on scratch copies, not the tree, because section 2's implementer was live: `>=` for `>` failed the exact-cap test, and a one-pass loop failed both chunked tests (pass 4, fail 2, exit 1).
Stamps: adjudicated 2 listed (both read by other work, skipped); stamped 2 applied outside the list: `worktree-line-endings-are-read-from-git-ls-files-eol-not-inferred-from-autocrlf` (the LF check before commit) and `a-bare-cd-in-the-bash-tool-repoints-every-later-dispatch` (cwd restored before dispatch).
Gate: targeted lane `node --test broker/usage/cache.test.ts broker/board/plans.test.ts broker/board/queues.test.ts broker/board/roster.test.ts broker/capped-read.test.ts` 115/115/0, exit 0, 1 s, at 2026-09-22T23:45:50Z on the main checkout at bde5c5c plus the close-pass edits, SCOTT-CLAUDE, box poll CLEAR; `npm run lint` exit 0. Baseline on the four-file lane: 109/109/0, exit 0, 1 s, at 2026-09-22T23:37:35Z on 4e7dc49, clean tree. Delta: +6 tests, 0 retired, 0 edited. Added: whole under the cap; oversized; two short reads whole (the usage cache's defect); unopenable reads unreadable; exactly-the-cap whole and cap-plus-one oversized; oversized through short reads. None spawns a process. The short-read test was observed red against the single-read shape by the implementer (pre-probe copy restored, `cmp` exit 0).
Next: 2. The repeat logger has one owner
Commit Model: Branch-and-PR
Delta: 2026-09-22T23:46:12Z, SCOTT-CLAUDE, main checkout.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-09-22
- Section 1: closed (Chapter 1).
- Section 2: implementing. A live dispatch to implementer-opus was asked to build `broker/repeat-log.ts` and its test, replace the eight private copies, pin each surface's text from `bde5c5c`, and run the whole gate.
- Sections 3 and 4: not started. Section 3 opens after section 2's first green, and section 4 after section 3.
- Baselines at 4e7dc49, 2026-09-22T23:37:35Z-23:38:21Z, SCOTT-CLAUDE, clean tree, poll CLEAR: whole gate 2003/2002/0, 1 skipped, exit 0, 40 s; lint exit 0; section 3 lane 31/31 exit 0; section 4 lane 264/264 exit 0.
- Rulings since the last boundary: none.

### Chapter 2 - 2026-09-23
Completed: 2. The repeat logger has one owner
Implemented By: implementer-opus; close-pass Minor fixed by the main session
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- Section 2 open: replaces eight private `createRepeatLog` copies with one exported from `broker/repeat-log.ts`, parameterised by window, optional key cap, and a per-surface line composer; serves the Goal sentence "Each small mechanism ... lives in one place that every caller imports" and Approach design item 1; adds no mechanism the design does not name (the composer and the optional key cap are design item 1's own); about +90 lines new module and test, about -250 lines across eight callers; not building it leaves eight copies drifting, with the state-after-log order in seven of them leaving a window stale when a log throws.
- Implementer add-decision (section 2, adjudicated): exports one surface const per module (eight export-list additions) so the Tests line's per-surface pins drive each surface's real text; serves section 2's Tests line; adds no mechanism that runs; 8 lines; not building it leaves pins that only restate the shared core and cannot catch a drifted prefix.
- `MAX_REPEAT_KEYS` stays exported from `broker/question-desk.ts`; the tailer and the router keep their own private constant of the same value, as before the move.
Assumptions: none
Review Findings: review: adversarial + blind at fable, Agent tool (frontmatter effort). No Critical. One Major, orchestrator-traced (the lens returned `trace: none`): the "each surface keeps its own key cap" test pins a literal cap per surface. Justified-not-fixed: it traces to the Intent clause "It does not change any window, cap or log wording", and the same table pins windows and text as literals for that clause. Minors: 1 fixed in the close pass (the new `../repeat-log.ts` import in `broker/discord/pins.ts` moved above the `./` imports, as every sibling orders them), 0 upgraded, 2 left: the router's import already sits beside its `../question-desk.ts` neighbour, and the blind lens's note that state-before-log changes seven surfaces' behaviour on a throwing log is the change design item 1 and the refused alternative order. Close-pass author re-read of the one-file delta done.
Stamps: adjudicated 2 listed; stamped `forward-resource-arrangements-into-dispatch-briefs` (section 3's brief named section 2's files off-limits while both were live); skipped `subagent-can-report-a-documented-past-injection-as-a-live-one` (read, not applied).
Gate: whole gate `npm test` 2026/2025/0, 1 skipped, exit 0, 39 s, and `npm run lint` exit 0, at 2026-09-23T00:00:24Z-00:01:05Z on the main checkout at c0eb885 plus this section's close-pass edit and section 3's unstaged implementation (`broker/card-binding.ts`, its test, the three card binding modules, `broker/discord/bindings.ts`), SCOTT-CLAUDE, box poll CLEAR. Baseline: 2003/2002/0, 1 skipped, exit 0, 40 s at 4e7dc49. Delta +23 tests: section 1's 6, this section's 16, section 3's 1; 0 retired, 0 edited. This section's 16 in `broker/repeat-log.test.ts` pin the first line, the in-window silence, the count-then-new-line close, the sweep past the cap with owed counts, an open window never swept, no sweep without a cap, the window left fresh by a throwing log, eight per-surface first-and-count-line pins taken from `bde5c5c`, and each surface's cap. None spawns a process.
Next: 3. The card binding has one owner
Commit Model: Branch-and-PR
Delta: 2026-09-23T00:01:25Z, SCOTT-CLAUDE, main checkout.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 2 - 2026-09-23
- Sections 1 and 2: closed (Chapters 1 and 2).
- Section 3: implemented by implementer-sonnet and verified (lint exit 0; its lane 32/32 exit 0 by the implementer; whole gate above green with it in the tree). Next: first-green commit, then review round 1 at opus, effort high, through Workflow, with the security reviewer, since the binding identifiers reach token-bearing request paths.
- Section 4: not started; opens after section 3's first-green commit.
- Rulings since the last boundary: none.

### Chapter 3 - 2026-09-23
Completed: 3. The card binding has one owner
Implemented By: implementer-sonnet; the round 1 Major fix and close-pass Minors by the main session
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- Section 3 open: moves the three card binding modules' load and save onto one `broker/card-binding.ts` taking a label, leaving the three as thin callers with aliased type names, and points every `SNOWFLAKE` at `broker/security/senders.ts`; serves the Goal sentence "Each small mechanism ... lives in one place that every caller imports" and Approach design item 2; adds no mechanism the design does not name; about +130 lines new module and test, about -300 lines across three modules and one regex; not building it leaves three copies of a token-path-bearing validator to drift.
- Implementer judgment (section 3, adjudicated): `saveCardBinding` takes no label, against design item 2's "one load and one save taking a label"; save writes no log line in any of the three originals, and `noUnusedParameters` in tsconfig.json would refuse an unused label; adds no mechanism; one parameter fewer; not doing it fails lint. This is a declared deviation from design item 2's wording, and the design's intent (labelled log lines) holds.
- Round 1 Major fix (section 3): pins each card's label by driving `loadBoardBinding`, `loadUsageBinding` and `loadInboxBinding` against a malformed file in `broker/card-binding.test.ts`; serves the Goal sentence "no caller's observable behaviour changes otherwise"; adds no mechanism (tests only); about +25 lines of test; not building it lets a caller's label drift with every lane green.
- Before the first-green commit, each card's six log lines at HEAD were compared with the shared module's, with the card's name substituted by the label: all three identical.
- The move deleted the per-copy comment "Both identifiers are interpolated into token-bearing request paths"; the close pass restored it beside the check in `broker/card-binding.ts` and `broker/discord/bindings.ts`.
Assumptions: none
Review Findings: review: adversarial + blind + security at opus, Workflow (effort high). No Critical. One Major (adversarial, traced to the Goal's "no caller's observable behaviour changes otherwise"): no test pinned which label each card passes. Fixed with three per-card pins that drive each card's own loader, so the existing binding tests stay unchanged as the Tests line asks; observed red on a scratch copy of `broker/` with the usage label changed to `fleet` (3 pass, 1 fail, exit 1). The fix is test and comment lines only, adds no module and no outward action, so it owed no further round; author re-read done. Minors: 4 fixed in the close pass (the header's "still finds it after the move" journey, the save-label deviation now recorded above, the deleted token-path reason restored, and the alpha/beta assertions narrowed to the whole phrase so a host temp path cannot match), 0 upgraded, 1 left (the blind lens's note that the new test exercises only the invalid-JSON line: every labelled line is one template in one module, compared per card before the commit). The stale `SNOWFLAKE` comment in `broker/security/senders.ts`, raised by all three lenses, is outside this section's files and the fold predicate's directory, so it went to `docs/backlog.md`. The security lens found `docs/security-model.md` carries no `## Threat model` section and reported CLEAR.
Stamps: adjudicated 1 listed; skipped `subagent-can-report-a-documented-past-injection-as-a-live-one` (read by a reviewer, not applied).
Gate: section lane `node --test broker/board/binding.test.ts broker/usage/binding.test.ts broker/inbox/binding.test.ts broker/discord/bindings.test.ts broker/card-binding.test.ts` 35/35/0, exit 0, 0.2 s, at 2026-09-23T00:05:53Z; then `npm run lint` exit 0 and whole gate `npm test` 2029/2028/0, 1 skipped, exit 0, 41 s, at 2026-09-23T00:06:34Z; both on the main checkout at 199726c plus this section's close-pass edits and section 4's unstaged implementation, SCOTT-CLAUDE, box poll CLEAR. Baseline on the section lane: 31/31, exit 0 at 4e7dc49. Delta +4 tests, 0 retired, 0 edited: the shared module's log lines carry the label it was given; the board, usage and inbox cards each log as "the <card> card binding". None spawns a process.
Next: 4. The clamp and the queue reader's helpers import from one place
Commit Model: Branch-and-PR
Delta: 2026-09-23T00:07:28Z, SCOTT-CLAUDE, main checkout.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 3 - 2026-09-23
- Sections 1 to 3: closed (Chapters 1 to 3).
- Section 4: implemented by implementer-sonnet, verified, and committed at first green (10c5c0a). The main session folded a third `MARKDOWN_SUFFIX` copy in `broker/board/card.ts` onto the `plans.ts` export and dropped the unused `WHITESPACE_RUN` export. A live Workflow dispatch runs review round 1 at opus, effort high: adversarial, blind and security over 46577ae..10c5c0a.
- Gate: whole gate 2029/2028/0, 1 skipped, exit 0, 41 s; board lane 264/264, exit 0; lint exit 0; at 2026-09-23T00:06:34Z on the main checkout, SCOTT-CLAUDE, box poll CLEAR, tree equal to 10c5c0a.
- Rulings since the last boundary: none.
- Next: adjudicate section 4's round, close it, then finishing-work against base ref f0f6fbc (merge-base with origin/main). The tail-until-flake plan's PR #25 merged at 2026-09-22T23:38:11Z, so finishing merges origin/main into this branch and runs the whole gate over the merge.

### Chapter 4 - 2026-09-23
Completed: 4. The clamp and the queue reader's helpers import from one place
Implemented By: implementer-sonnet; the verification fold and close-pass Minors by the main session
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- Section 4 open: exports `touchedAt` once from `broker/board/events.ts` for the card and status modules, and exports the plan helpers (`WHITESPACE_RUN`, `bounded`, `MARKDOWN_SUFFIX`, the README stem, `planStem`, the stat) from `broker/board/plans.ts` for `broker/board/queues.ts`, the shared stat taking a regular-file option off by default; serves the Goal sentence "Each small mechanism ... lives in one place that every caller imports" and Approach design item 4; adds no mechanism the design does not name (the regular-file option is design item 4's own); about +10 lines of exports, about -60 lines of copies; not building it leaves two clamp copies and six queue-reader copies to drift.
- Implementer add-decision (section 4, adjudicated): `statPlanFile` takes `regularFileOnly`, default false, and the queue reader's `statFile` stays as a one-line wrapper passing true because `PlanStat` and the `statPlan` option fix its one-argument shape; design item 4's own option; adds no mechanism beyond it; one branch.
- Verification fold (section 4, main session): `broker/board/card.ts:339` held a third identical `MARKDOWN_SUFFIX` copy the Approach did not list; it now imports the one from `plans.ts` (card.ts already imported from plans.ts and sits in Files in scope, so the section's file list is unchanged). `WHITESPACE_RUN`'s new export was dropped, since nothing outside plans.ts imports it; adds no mechanism; -1 line.
- The close pass exported `isReadmeStem` in place of the `EXCLUDED_README_STEM` constant, so the README rule itself, not only its constant, has one owner; the queue reader calls it.
- `card.ts` keeps a private function also named `planStem` whose behaviour differs (it reduces a path, not a file name); it is not a copy of the plans helper and was left.
Assumptions: none
Review Findings: review: adversarial + blind + security at opus, Workflow (effort high). No Critical, no Major. Minors: 4 fixed in the close pass (the `statPlanFile` comment's false claim that a sweep stats only names its own listing confirmed, raised by all three lenses and reworded with no behaviour change; the README rule shared through `isReadmeStem`; the `card.ts` fold recorded above; the `touchedAt` comment rewritten to name its callers and keep the card's reason), 0 upgraded, 2 left (the positional `true` in the one wrapper, whose comment names it; and the security lens's advisory `npm audit` finding, three transitive packages through `@modelcontextprotocol/sdk` 1.30.0, confirmed by `npm ls`, which predates this plan and went to `docs/backlog.md`). The close-pass code change is covered by `queues.test.ts:221`, which refuses a README by the case-folded stem; it adds no module and no outward action, so it owed no further round; author re-read done. The security lens found `docs/security-model.md` carries no `## Threat model` section and reported CLEAR.
Stamps: adjudicated 1 listed; skipped `subagent-can-report-a-documented-past-injection-as-a-live-one` (read by a reviewer, not applied).
Gate: board lane `node --test broker/board/*.test.ts` 264/264/0, exit 0, 0.6 s, and `npm run lint` exit 0, at 2026-09-23T00:11:18Z on the main checkout at 10c5c0a plus this section's close-pass edits, SCOTT-CLAUDE, box poll CLEAR. Baseline on the same lane: 264/264, exit 0 at 4e7dc49, and the implementer's own run at 199726c plus its edits, 264/264 exit 0. Delta: 0 tests added, 0 retired, 0 edited. The directory refusal stays pinned by `queues.test.ts:308`, which goes through the module's own stat. `touchedAt` is defined once across `broker/board/`, at `events.ts:225` (`grep -rn "function touchedAt" broker/board/`, one match). The whole gate at 00:06:34Z (Interim board 3) ran on the first-green tree; finishing runs it again.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-09-23T00:11:26Z, SCOTT-CLAUDE, main checkout.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
