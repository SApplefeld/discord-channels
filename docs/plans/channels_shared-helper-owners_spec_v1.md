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
