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

### Chapter 1 - 2026-09-22
Completed: 1. The wait names its condition and classifies an expiry
Implemented By: implementer-sonnet, with two main-session corrections before review
Metrics: review rounds 1, closed major-closed; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open: changes `until` in broker/tail.test.ts to take a label and classify an expiry over a 2 s monotonic grace at 10 ms steps; serves the Design step 1 and section 1's acceptance; adds a mechanism the plan names (the classifying grace), none unnamed; size ~20 lines of helper, 3 tests, 7 call-site labels; not building it leaves every red reading "the condition never held", which is the evidence section 2 needs.
- The implementer's "held only after the bound" test flipped its flag from a 50 ms timer, betting that 1000 event-loop turns finish first. A loaded box can break that bet, which would make the new test flaky in the same way as the group it instruments. The main session replaced the timer with a check counter that turns true on the first grace poll (call `UNTIL_TURNS + 2`), and named the bound `UNTIL_TURNS` so the count follows it.
- Red first. The implementer observed all three helper tests red at runtime (`TypeError: holds is not a function`, the two-argument call hitting the one-argument helper). The main session then probed the new signature with the old failure body, on its own tree copy, restored and byte-compared. The two classification tests failed on their messages, and the pass-path test passed, as a pass-path lock should.
- The blind reviewer, which never saw the plan, independently named the plan's leading hypothesis: the turn-counted bound races thread-pool file I/O in `tailer.poll()`. That is independent support for the hypothesis, not confirmation. Section 2 is still the confirmation.
- Contention: a claude-kit full suite from another session (PID 15548) was live while the implementer ran and at the main session's first lane run at 22:16 UTC. The runner poll (`.kit/scratch/poll-runners.ps1`, validated against a decoy process) was built after that run. The close gate below ran on a box the poll read CLEAR both before and after.
Assumptions:
- assumed 2026-09-22 (the plan's section 1 Tests line, section 1): the grace stays a fixed 2 s rather than an injectable parameter, so the never-held test costs 2 s on this file's lane; reversal: one optional parameter.
Review Findings: review: adversarial + blind at opus, Workflow at high. Major (blind, trace orchestrator-made to the Intent's refused alternative "switching the bound to wall clock without instrumenting first"): the bound is still counted in turns while the tailer waits on thread-pool I/O. Justified-not-fixed: this is the plan's own hypothesis, and section 3 moves the bound if section 2 confirms it. Major (adversarial): red-first unrecorded for the pass-path test. Dispositioned by the record above. Major (adversarial): lane and lint evidence not yet recorded. Dispositioned by the Gate line below. Minors: 2 fixed in the close pass (the doc comment names `UNTIL_TURNS` rather than repeating 1000; the step constant has its own comment), 0 upgraded, 4 left with the reason (2 s grace cost, noted by both lenses, is the plan's fixed grace; full-sentence message anchors are the contract section 2 reads; the pass-path test's reach is covered by the two rejection tests). The close pass was prose-only, and the author re-read its diff.
Stamps: adjudicated 2, stamped 1 (forward-resource-arrangements-into-dispatch-briefs); the other was a peer session's read.
Gate: targeted lane `node --test broker/tail.test.ts` at 2026-09-22 22:22 UTC, SCOTT-CLAUDE, box CLEAR before and after: 174 tests / 174 pass / 0 fail, exit 0, 2.6 s. Baseline on the same lane at 22:12 UTC, clean box, f0f6fbc: 171/171/0, exit 0, 0.6 s. Delta +3 tests, +2.0 s (the never-held test's grace). `npm run lint` exit 0 (baseline exit 0). Tests added: 3, each pinning one design-step-1 requirement: a condition held inside the bound passes; a condition held only after the bound fails with "<label> held only after the bound, N ms late"; a condition that never holds fails with "<label> never held within the grace". Retired 0, edited 7 call sites (label argument only, no behaviour change). Spawning tests added 0.
Next: 2. Evidence: which kind of red the group produces
Commit Model: Branch-and-PR
Delta: kit-size at 2026-09-22 22:23 UTC, SCOTT-CLAUDE, exit 2:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-22
Completed: 2. Evidence: which kind of red the group produces
Implemented By: main session (inline, per the section's Locus)
Metrics: review rounds 0, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 2 open: runs `npm test` 30 times, one at a time, on a box polled clear before each run, and records every red's classified message; serves section 2's acceptance; adds no mechanism in the code (the runner is scratch tooling under `.kit/`); size 0 lines in the tree; not running it leaves section 3 moving a bound on no evidence, which is the trap the backlog names.
- Result: 30 runs counted out of 30 attempts, none died partway. Every run reported 2006 tests. 3 reds, all in the group, all the same test and the same wait, and all classified "held only after the bound":
  - run 5, 22:28 UTC: "a mirror run that landed nothing after the tailer deferred still gets the text posted", `the tailer's poll has settled held only after the bound, 25 ms late` (tail.test.ts:2970).
  - run 21, 22:41 UTC: same test and wait, 22 ms late.
  - run 22, 22:41 UTC: same test and wait, 22 ms late.
  - No red was "never held". No red fell outside the five tests, so there is no found work to raise.
- The hypothesis is confirmed. The 1000-turn bound expired while the poll's thread-pool file calls were still in flight, and the condition held 22 to 25 ms later. The branch rule in the Approach's design step 3 sends the run to section 3.
- Unlike the backlog's record of a different member failing each run, every red here was one member: the wait on a tailer poll that runs while a paced mirror run holds the thread. The inferred reason is that this box's timing favors that path. It does not change the branch, since every red is the same kind.
- Contention: the runner started each run only on a CLEAR poll, and held the heavy-process claim from 22:23:49 UTC until it finished at about 22:47:46 UTC. Another session's short red/green probe (`node .kit/controller-tick-test.mjs`, the direct-lines work) started at 22:24:22 UTC during run 1's tail, and a foreign process was present at the end of runs 5 and 7. The runner waited on foreign processes 9 times in all. Runs 21 and 22 read CLEAR both before and after, so the reds do not depend on another session's load.
Assumptions:
- assumed 2026-09-22 (section 2): a full run's totals line reading 2006 tests is the "did not die partway" test; every run carried it.
Review Findings: no review. The section has no code or document delta, so the reviewers have nothing to read. The runner and its message extractor are scratch tooling, and the extractor was checked against a synthetic log holding both message shapes and an unrelated failure.
Stamps: adjudicated 0, stamped 0; none surfaced beyond Chapter 1's window.
Gate: the section's gate is its 30 runs, `npm test`, SCOTT-CLAUDE, 2026-09-22 22:23:49-22:47:46 UTC, on branch tail-until-flake at 52d2be7: 27 exit 0 at 2006/2006/0, and 3 exit 1 at 2006/2005/1 (runs 5, 21, 22). Wall clock 37-42 s per run. Per-run records: `.kit/scratch/channels_tail-until-flake_spec_v1/evidence/results.log`. No code delta, so no targeted lane.
Next: 3. The wait bounds on wall clock
Commit Model: Branch-and-PR
Delta: no code or document delta beyond this Chapter; kit-size measures no corpus in this repository (Chapter 1's reading).
