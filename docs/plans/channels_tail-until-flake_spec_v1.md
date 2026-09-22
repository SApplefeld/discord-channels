# Make the Tailer Tests' Wait Say Why It Failed, Then Fix the Flake From That Evidence

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

The five echo-dedup and deferral tests in `broker/tail.test.ts` stop failing intermittently, and a
failure that does happen says what it means. Today a shared `until` helper waits a fixed count of
1000 `setImmediate` turns and then fails with one message, "the condition never held", whichever
of the tests hits it. The backlog recorded the group going red on a clean tree in full-suite runs,
most often while another suite loaded the box, and on a different member each time: three
consecutive full-suite runs on 2026-08-26 each failed a different one, and every isolated run of the
file between them was green. Every red costs a round a re-run and a question about whose it is. The
backlog records that the obvious fix, widening the bound, is a trap. A bound that expired too
early and a tailer that genuinely failed to post give the same message, so widening it would hide
the second case for good. When this is done the helper says which of the two happened, the flake's
cause has been named from that evidence, and the fix it points to has landed.

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
The coordinator named this group as one of the two most load-bearing backlog items. It folds the
two backlog entries that describe it: "Root-cause the intermittent timing failure in
`broker/tail.test.ts:2469`" and "An intermittent failure in `broker/tail.test.ts`, inside the
`until` helper".

**What done needs to do.** Make an expired wait distinguish "the condition became true shortly
after the bound" from "the condition never became true", and name the condition. Gather enough
runs to say which of the two the group's reds are. Fix the cause that evidence names. The two
backlog entries already left the active list when the operator approved the candidate for planning, and sit in
`docs/archive/backlog-2026-Q3.md` under "Planned 2026-09-22".

**What done does not need to do.** It does not change the tailer's behaviour unless the evidence
shows the tailer failing to post. It does not touch the other polling helpers in
`relay/broker.test.ts` or `broker/routing/http.test.ts`, which already bound on wall clock. It does
not add a retry wrapper around the group, which the backlog names as the wrong shape.

**Alternatives refused.**
- Widening the turn count. Refused, because an expired bound and a tailer that never posted give
  the same message today, and a wider bound hides the second case for good.
- Switching the bound to wall clock without instrumenting first. Refused, because the hypothesis
  that names the cause is inferred, and the backlog insists it be confirmed before the bound moves.
- Two plans, one for the instrument and one for the fix. Refused, because the instrument alone is
  not worth a round, and a "never held" red opens a new plan for the tailer anyway.
- A retry wrapper around the group. Refused, because it would pass a tailer that fails to post.
- Running the file under a second full suite as load. Refused, because the machine's
  one-heavy-process rule reads a run that dies under contention as no result, and the suite's own
  file concurrency is already the load the backlog names.

**Rulings.** Decided 2026-09-22 by the architect on the drafter's three questions: one plan with a
conditional third section; an evidence budget of 30 full-suite runs, one at a time, with no second
suite beside them; sonnet for the two code sections and inline main-session work for the evidence
section.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session from the two backlog entries and
from the code at `origin/main` `0690eb4`, read that day through a read-only scout whose load-bearing
claims were re-read by the drafting session. Finalized 2026-09-22 by the architect, who re-read
every code anchor the Approach names at that commit.

## Related plans

None open. No plan on the board touches `broker/tail.test.ts`.

## Approach

**What exists today.**

- `until` at `broker/tail.test.ts:2723-2729` loops up to 1000 times, yielding one `setImmediate`
  per turn, and then asserts `holds()` with the fixed message "the condition never held". The
  backlog's line numbers (2451, 2459, 2469) are stale: the helper has moved. Every line number in
  this plan is read at the commit Provenance names; where a line has moved, find the site by the
  text quoted beside it.
- Seven `until` calls sit in five tests: "a long reply the tailer is still posting is not posted
  again by the Stop mirror", "a long reply the Stop mirror is still posting is not posted again by
  the tailer", "a tailer run that landed nothing after the mirror deferred still gets the text
  posted", "a mirror run that landed nothing after the tailer deferred still gets the text posted",
  and "a reply record left by a deferral dies with the interim run that never landed". All are
  built on the `integration` fixture at
  `broker/tail.test.ts:2578-2650`. That fixture injects fixed clocks and replaces the router's
  pacing sleep with a no-op, so no real timer lies on the tested path.
- The one real wait on the path is file I/O. `tailer.poll()` reads the transcript through
  `readSlice` (`broker/tail.ts:1848-1858`): `open`, `stat`, `read` and `close` from
  `node:fs/promises`, each a round trip through libuv's thread pool. A `setImmediate` turn does
  not wait for any of them. So 1000 turns, a few milliseconds of an idle event loop, is a bound
  measured in the wrong unit for a wait that spans disk calls. The five `until` calls that cover a
  poll are at lines 2753, 2789, 2881, 2921 and 2996. The two that cover only the mirror path (2780
  and 2913) do no file I/O.
- The two sibling helpers, `relay/broker.test.ts:132-138` and `broker/routing/http.test.ts:266-272`,
  bound on wall clock: up to 300 or 200 tries with a 10 ms `setTimeout` between them.

**The leading hypothesis, inferred and not yet confirmed.** The reds are a bound that expired
before the thread pool finished the poll's four calls, not a tailer that failed to post. That
fits the backlog's record: a moving member, green alone, green on re-run, and reds even on a
lightly loaded box, since thread-pool latency varies without CPU load. It is exactly the
hypothesis the backlog says must be confirmed before the bound changes, which is why section 1
instruments first. What would confirm it is section 2's evidence: every red classified as "held only
after the bound".

**The design.**

1. `until` takes a label naming the condition. On expiry it keeps polling on wall clock for a
   bounded grace purely to classify the failure. The grace is 2 s of elapsed wall clock read
   from a monotonic clock, polled every 10 ms, however many polls fit. It then fails with
   one of two messages: "`<label>` held only after the bound, N ms late", or "`<label>` never held
   within the grace". N is elapsed milliseconds measured from the moment the turn count expired.
   The test still fails either way, so the instrument hides nothing.
2. Collect evidence: run the full suite (`npm test`) 30 times, one at a time, and record each
   red's message. The suite runs its test files concurrently, which is the load the backlog names.
   A red in a test outside the five carries no classified message: it is recorded with its test
   name, counts toward neither branch of step 3, and is raised with the coordinator as found work.
3. Branch on the evidence. If every red is "held only after the bound", replace the turn count
   with the siblings' wall-clock bound and keep the labelled messages. If any red is "never held",
   stop and root-cause the tailer from that test's state. That is new work with its own plan, and
   the bound stays as it is. If no red occurs in the 30 runs, the run stops with `BLOCKED:`, the
   cause is recorded as unconfirmed, and the bound stays as it is, since a bound moved on no
   evidence is the trap the backlog names.

## Sections of Work

### 1. The wait names its condition and classifies an expiry
Model: sonnet

Tests: lock that `until` passes when the condition holds within the bound; that a condition which
becomes true after the bound fails with the "held only after the bound" message naming its label;
and that a condition which never becomes true fails with the "never held" message naming its
label. Drive the three with a controllable condition rather than the tailer.

Give `until` a label parameter and the classifying grace of 2 s at 10 ms steps, and pass a label
at each of the seven call sites naming what it waits for.

Acceptance:
- The three helper tests exist and were observed red first.
- The five group tests pass unchanged in behaviour.
- `npm run lint` exits 0, and `node --test broker/tail.test.ts` exits 0, reported as a delta
  against a baseline on the same lane.

Files in scope: `broker/tail.test.ts`.

### 2. Evidence: which kind of red the group produces
Model: opus
Locus: inline

Run the full suite (`npm test`) 30 times, one run at a time with no other suite or build on the
box, holding the machine's heavy-process claim throughout, the claim the kit's testing-discipline
skill owns for reserving the box to one heavy process, and record every red's message, test and
run in this plan's Chapter. A red in a test outside the five is recorded with its test name and
counts toward neither branch of section 3. No code changes. At the suite's current wall clock this is about 25 minutes of box
time. A run that dies partway through is contention rather than a result: it is not counted, the
box is cleared, and the run is repeated.

Acceptance: the Chapter carries the run count, the red count, and each red's classified message; if
no red occurs, the Chapter says so, the run stops with `BLOCKED:` naming the cause as unconfirmed,
and section 3 does not run.

Files in scope: none.

### 3. The wait bounds on wall clock
Model: sonnet

Runs only if section 2 recorded at least one red and every red was "held only after the bound".
A "never held" red stops the run with `BLOCKED:` and a new plan for the tailer; no red at all stops
it with `BLOCKED:` and the cause unconfirmed.

Tests: section 1's helper tests still pass with the bound restated in wall-clock terms.

Replace the 1000-turn count with a wall-clock bound matching the siblings' shape, up to 300 tries
with a 10 ms `setTimeout` between them. The 2 s classifying grace and both messages stay; only the
primary bound changes. Record section 2's counts
beside the two former backlog entries in `docs/archive/backlog-2026-Q3.md`, so the receipts sit
with the entries they close.

Acceptance:
- `npm run lint` exits 0; `node --test broker/tail.test.ts` exits 0 against the same-lane baseline.
- A further 20 full-suite runs, one at a time, show no red in the group. Any red in those 20 fails
  the section, and its classified message is recorded in the Chapter before any further change.
- The two former backlog entries in `docs/archive/backlog-2026-Q3.md` carry section 2's counts.

Files in scope: `broker/tail.test.ts`, `docs/archive/backlog-2026-Q3.md`.

## Out of Scope

- Any change to `broker/tail.ts` (unless section 2's evidence opens a new plan).
- The wall-clock helpers in `relay/broker.test.ts` and `broker/routing/http.test.ts`.

## Assumptions

- assumed 2026-09-22 (the repository's plans): the commit model is Branch-and-PR; reversal: one
  header line.
- assumed 2026-09-22 (the architect): section 2 runs inline on the executing session, whose model
  the `Model:` line names as opus per the brainstorming skill's rule for an inline section;
  reversal: one line.
- The cause is inferred, not confirmed. Section 2 exists to confirm or refute it, and section 3 is
  conditional on the answer.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose
  executing-work skill owns the `BLOCKED:` lead, the Chapter, and the lane vocabulary the sections
  use; reversal: a paragraph naming each.
- The plan review ran at fable and effort high and returned READY_WITH_FINDINGS, three Major and
  four Minor, all applied. The blind read returned 6 questions and 5 comprehension gaps: 8 answered
  in the spec, 3 assumed above, 0 asked. The gating litmus found none: the author had counted the
  section 3 gate and the reader did not, and the reconciled reading is that the gate is a condition
  on the run rather than the admission rule of a bounded artifact.

## Operator Verification

- None. The evidence is gathered on this box by the run.

## Chapters
