# Make the Tailer Tests' Wait Say Why It Failed, Then Fix the Flake From That Evidence

Status: Draft (for the Architect seat to review, finalize and set Ready)
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

The five echo-dedup and deferral tests in `broker/tail.test.ts` stop failing intermittently, and a
failure that does happen says what it means. Today a shared `until` helper waits a fixed count of
1000 `setImmediate` turns and then fails with one message, "the condition never held", whichever
of the tests hits it. The group goes red on a clean tree in about 2 runs in 10 (backlog, 2026-08-25
measurement) and on a different test each time. Every red costs a round a re-run and an argument
about whose it is, and one once sent an implementer to report against a baseline it misread. The
backlog records that the obvious fix, widening the bound, is a trap. A bound that expired too
early and a tailer that genuinely failed to post give the same message, so widening it would hide
the second case for good. When this is done the helper says which of the two happened, the flake's
cause has been named from that evidence, and the fix it points to has landed.

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
backlog entries already left the active list when the operator approved this plan, and sit in
`docs/archive/backlog-2026-Q3.md` under "Planned 2026-09-22".

**What done does not need to do.** It does not change the tailer's behaviour unless the evidence
shows the tailer failing to post. It does not touch the other polling helpers in
`relay/broker.test.ts` or `broker/routing/http.test.ts`, which already bound on wall clock.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session from the two backlog entries and
from the code at `origin/main` `0690eb4`, read that day through a read-only scout whose load-bearing
claims were re-read by the drafting session. The Architect seat owns the final form.

## Approach

**What exists today.**

- `until` at `broker/tail.test.ts:2723-2729` loops up to 1000 times, yielding one `setImmediate`
  per turn, and then asserts `holds()` with the fixed message "the condition never held". The
  backlog's line numbers (2451, 2459, 2469) are stale: the helper has moved.
- Seven `until` calls sit in five tests, all built on the `integration` fixture at
  `broker/tail.test.ts:2578-2650`. That fixture injects fixed clocks and replaces the router's
  1.5 s pacing sleep with a no-op, so no real timer lies on the tested path.
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
instruments first.

**The design.**

1. `until` takes a label naming the condition. On expiry it keeps polling on wall clock for a
   bounded grace (recommended 2 s at 10 ms steps) purely to classify the failure, then fails with
   one of two messages: "`<label>` held only after the bound, N ms late", or "`<label>` never held
   within the grace". The test still fails either way, so the instrument hides nothing.
2. Collect evidence: run the full suite repeatedly (recommended 20 runs, plus 10 with the five
   tests' file alone under a concurrent full suite for load) and record each red's message.
3. Branch on the evidence. If every red is "held only after the bound", replace the turn count
   with the siblings' wall-clock bound and keep the labelled messages. If any red is "never held",
   stop and root-cause the tailer from that test's state. That is new work with its own plan, and
   the bound stays as it is.

## Open questions for the Architect seat

1. **One plan with a conditional third section, or two plans?** Recommend one plan whose section 3
   is written for the expected branch (the wall-clock bound) and states that a "never held" red
   stops the run with a `BLOCKED:` and a new plan. The instrument alone is not worth a round of its
   own.
2. **Evidence budget.** Twenty full-suite runs is about 17 minutes of box time at the suite's
   current 49 s. Recommend it, run under the heavy-process claim.
3. **Model tiers.** Recommend sonnet for sections 1 and 3, which have a named sibling to clone, and
   inline main-session work for section 2, which is running and reading, not writing code.

## Sections of Work

### 1. The wait names its condition and classifies an expiry
Model: sonnet

Tests: lock that `until` passes when the condition holds within the bound; that a condition which
becomes true after the bound fails with the "held only after the bound" message naming its label;
and that a condition which never becomes true fails with the "never held" message naming its
label. Drive the three with a controllable condition rather than the tailer.

Give `until` a label parameter and the classifying grace, and pass a label at each of the seven
call sites naming what it waits for.

Acceptance:
- The three helper tests exist and were observed red first.
- The five group tests pass unchanged in behaviour.
- `npm run lint` exits 0, and `node --test broker/tail.test.ts` exits 0, reported as a delta
  against a baseline on the same lane.

Files in scope: `broker/tail.test.ts`.

### 2. Evidence: which kind of red the group produces
Model: sonnet
Locus: inline

Run the evidence budget the Architect seat sets, under the heavy-process claim, and record every
red's message, test and run in this plan's Chapter. No code changes.

Acceptance: the Chapter carries the run count, the red count, and each red's classified message; if
no red occurs, the Chapter says so and section 3 proceeds on the mechanism alone.

Files in scope: none.

### 3. The wait bounds on wall clock
Model: sonnet

Runs only if section 2 recorded no "never held" red. Otherwise the run stops with `BLOCKED:` and a
new plan for the tailer.

Tests: section 1's helper tests still pass with the bound restated in wall-clock terms.

Replace the 1000-turn count with a wall-clock bound matching the siblings' shape, keeping the
labelled messages.

Acceptance:
- `npm run lint` exits 0; `node --test broker/tail.test.ts` exits 0 against the same-lane baseline.
- A further 20 full-suite runs show no red in the group.

Files in scope: `broker/tail.test.ts`.

## Out of Scope

- Any change to `broker/tail.ts` (unless section 2's evidence opens a new plan).
- The wall-clock helpers in `relay/broker.test.ts` and `broker/routing/http.test.ts`.

## Operator Verification

- None. The evidence is gathered on this box by the run.

## Chapters
