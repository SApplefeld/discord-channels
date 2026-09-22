# Give Each Hand-Copied Broker Helper One Owner

Status: Draft (for the Architect seat to review, finalize and set Ready)
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

Each small mechanism the broker has copied by hand across its modules lives in one place that every
caller imports, and the one copy that is wrong today is fixed by the move. Four families are
copied now. The rate-limited repeat logger exists as eight copies. The standing cards' binding
module exists as three. The size-capped file read exists as four. The non-finite modification-time
clamp exists as two. The usage cache's copy of the capped read performs a single read with no
loop, so a short read would hand the parser a prefix of the file under the name of the whole. The
codebase's own precedent set three copies as the point to extract, and every family but the clamp
is past it. When this is done each family has one owner, the usage cache's read loops like its
siblings, no caller's observable behaviour changes otherwise, and the four backlog entries are
retired.

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
extract anything with fewer than two copies.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session from the four backlog entries and
from the code at `origin/main` `0690eb4`, read that day through a read-only scout. The drafting
session re-read the capped-read defect and the eight logger definitions. The Architect seat owns
the final form.

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
- **Card binding.** `broker/board/binding.ts` and `broker/usage/binding.ts` (117 lines each) and
  `broker/inbox/binding.ts` (115) are one module in three spellings. They differ in type names, log
  labels, header prose, and one fact: board and usage define a private `SNOWFLAKE` regex where the
  inbox imports the shared one from `broker/security/senders.ts:27`. A fourth private copy of that
  regex sits at `broker/discord/bindings.ts:67`.
- **Capped read.** Three copies loop the read until the buffer fills or a read returns 0:
  `readPlanFile` in `broker/board/plans.ts:427` (exported), `readCappedFile` in
  `broker/board/queues.ts:214`, and `readRosterFile` in `broker/board/roster.ts` near line 67.
  `readCapped` in `broker/usage/cache.ts:271-281` reads once (confirmed at lines 279-280). Each
  defines its own identical result type.
- **Clamp.** `touchedAt` is identical in `broker/board/card.ts:445-447` and
  `broker/board/status.ts:140-142`.
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
   modules become thin callers or disappear. Every `SNOWFLAKE` copy imports the one in
   `broker/security/senders.ts`.
3. A new `broker/capped-read.ts` exports the looping read and its result type, parameterised by the
   cap. All four callers use it, which fixes the usage cache.
4. `touchedAt` is exported once, from the module the Architect seat picks (open question 3), and
   `broker/board/queues.ts` imports the plan helpers from `broker/board/plans.ts`, which exports
   them, with the stat's regular-file refusal as an option.

## Open questions for the Architect seat

1. **One plan or two?** Recommend one plan with four sections, one per family. Each section is
   independently reviewable and revertible, and together they retire four backlog entries in one
   round.
2. **How is the short read proven red?** A short `readSync` is hard to provoke on a local disk.
   Recommend that `broker/capped-read.ts` take an optional reader function whose default is
   `readSync`. A test hands it a reader that returns the file in two chunks: the usage cache's old
   single read goes red on it, and the shared loop goes green.
3. **Where does `touchedAt` live?** Recommend `broker/board/status.ts`, since the card imports from
   status already, over a new module for three lines. The backlog notes the card's exports were
   bounded by an approved section line, which this would respect.
4. **Is the judge's state-before-log order acceptable for all eight?** Recommend yes: it changes
   nothing unless a log function throws, and then it is the correct order.
5. **Model tiers.** Recommend sonnet for every section: each has an existing copy to clone, a clear
   contract, and suites that already cover the callers.

## Sections of Work

### 1. The capped file read has one owner, and the usage cache's read loops
Model: sonnet

Tests: lock that the shared read returns a file under the cap whole; that it refuses a file over
the cap as oversized; that it returns a file delivered in two short reads whole (observed red
against the usage cache's single-read shape first); and that an unopenable file reads as
unreadable.

Create `broker/capped-read.ts` and point the four callers at it, deleting their private copies and
result types.

Acceptance: the tests exist, and the short-read test was observed red first; `npm run lint` exits 0;
`node --test broker/usage/cache.test.ts broker/board/plans.test.ts broker/board/queues.test.ts
broker/board/roster.test.ts` exits 0 against a same-lane baseline.

Files in scope: `broker/capped-read.ts` (new), `broker/capped-read.test.ts` (new),
`broker/usage/cache.ts`, `broker/board/plans.ts`, `broker/board/queues.ts`, `broker/board/roster.ts`.

### 2. The repeat logger has one owner
Model: sonnet

Tests: lock the shared logger's four behaviours: the first line writes, a repeat inside the window
writes nothing, the window's close writes the count line and then the new line, and eviction past
the key cap writes what each evicted key owes. Every existing test that asserts a surface's log
text must still pass unchanged.

Create `broker/repeat-log.ts` and replace the eight private copies.

Acceptance: the tests exist; `npm run lint` exits 0; the full suite exits 0 against a whole-gate
baseline, since the eight callers span most of the broker.

Files in scope: `broker/repeat-log.ts` (new), `broker/repeat-log.test.ts` (new), and the eight
files named above.

### 3. The card binding has one owner
Model: sonnet

Tests: the existing binding tests for all three cards pass unchanged; add one test that the shared
module's log lines carry the label it was given.

Create `broker/card-binding.ts`, reduce the three card modules to callers of it, and point every
`SNOWFLAKE` at `broker/security/senders.ts`.

Acceptance: `npm run lint` exits 0; the three cards' binding tests and the new test exit 0 against a
same-lane baseline.

Files in scope: `broker/card-binding.ts` (new), `broker/board/binding.ts`, `broker/usage/binding.ts`,
`broker/inbox/binding.ts`, `broker/discord/bindings.ts`, and their tests.

### 4. The clamp and the queue reader's helpers import from one place
Model: sonnet

Tests: the board card, status and queue tests pass unchanged, and a queue test still proves a
directory in the queue is refused.

Export `touchedAt` once and import it in the other module. Export the plan helpers from
`broker/board/plans.ts` and import them in `broker/board/queues.ts`, keeping the regular-file
refusal. Retire the four backlog entries.

Acceptance: `npm run lint` exits 0; `node --test broker/board/*.test.ts` exits 0 against a same-lane
baseline; the four entries are gone from `docs/backlog.md`.

Files in scope: `broker/board/card.ts`, `broker/board/status.ts`, `broker/board/plans.ts`,
`broker/board/queues.ts`, `docs/backlog.md`.

## Out of Scope

- The filesystem-path guard entry, which stays on the backlog.
- Any change to a window, a cap or a log line's wording.

## Operator Verification

- None beyond the gate. The usage card's short-read fix fails closed today, so there is nothing
  live to watch.

## Chapters
