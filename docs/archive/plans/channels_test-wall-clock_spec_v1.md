# Test suite wall clock

Status: Complete
Commit model: Review-Only (commit when the operator asks)

## Why

A full `npm test` took 65 to 69 seconds, and it is run several times over a single change: once for a
baseline, once after the edit, once more after review findings land. The cost was not the tests
themselves. It was one file.

## What the measurement said

Node's test runner already runs files in parallel, at `availableParallelism()` processes. What it does
not do is run the tests *inside* a file in parallel: a root-level `test()` call has a fixed
concurrency of 1, and nothing in this repository declared otherwise. Timed individually, the 50 test
files summed to 121 seconds while the suite walled at 65, which is the file-level parallelism working
as intended.

The wall clock was therefore one number: the slowest single file.

| File | Before | Shape |
| --- | --- | --- |
| `install/Install-Host.test.ts` | 61.8s | 14 tests, each a real PowerShell installer run |
| `install/Install-Functions.test.ts` | 21.0s | 44 tests, PowerShell probes against real temp trees |
| `install/Install-All.test.ts` | 8.5s | 14 tests, 3 PowerShell runs |
| `broker/index.test.ts` | 5.5s | 26 tests, no child processes |
| `hooks/session-start.test.ts` | 5.0s | 3 tests, 2 PowerShell runs |
| every other file | under 3s each | |

`Install-Host.test.ts` at 61.8 seconds was essentially the entire 65-second wall clock. Every other
file finished while it was still running.

Two properties made those runs serial. Each was a `spawnSync`, which blocks the event loop and so
offers no await point to interleave at; and each `test()` was root-level, where the runner's
concurrency is fixed at 1. Declaring concurrency without converting the spawn changes nothing, which
is why the conversion comes first.

## Approach

For each file on the critical path: convert the child-process helper from `spawnSync` to a promise
over `spawn`, then move its tests inside `describe(name, { concurrency: N }, ...)`.

The bound is a number rather than `true`. The runner is already running fifteen other file processes
alongside, and an unbounded fan-out would put every installer run and its `icacls` calls on the
machine at one moment. Measured on `Install-Host.test.ts`: concurrency 4 gives 22.0s, 8 gives 15.9s,
14 gives 14.5s. The curve flattens after 8, so 8 is the setting in both files.

Concurrency is safe here for a reason worth stating rather than assuming: every test in these files
builds its own `mkdtemp` fixture tree and removes it in `t.after()`, none mutates `process.env` or the
working directory, and every server in the suite binds an ephemeral port (`port: 0`, `listen(0)`)
rather than a fixed one. There is no shared mutable state for concurrent tests to collide over.

## What this does not do

The installer tests are not tagged, skipped, or moved out of the default gate. They run the real
`Install-Host.ps1` against a fixture because that installer once merged this project's hooks into the
operator's live `~/.claude/settings.json`; the guard that now prevents it is a test in this file.
Trading that gate for wall clock is not on the table. The speedup comes from running the same work at
once, not from running less of it.

## The floor

`Install-Host.test.ts` is contention-bound rather than scheduling-bound: one installer run takes about
4.4 seconds, and the file still takes 14.5 seconds with all fourteen running at once. No test-runner
setting moves that. The cause is inferred rather than measured: disk, antivirus, and PowerShell 5.1
startup are the plausible candidates, and which of them dominates was never established. What was
measured is the curve, 22.0s at concurrency 4, 15.9s at 8, 14.5s at 14.

Two numbers, and they are not the same number. Run alone, the file takes 15.9 seconds at the chosen
concurrency. In a full run it competes with fifteen other file processes, so it contributes more than
that, and the suite settles at 19 to 20 seconds. The roughly four-second gap is that competition,
not an unclaimed saving: there is no four seconds sitting somewhere waiting to be found.

The standalone figure is still the one that decides what is worth doing, because it is what each file
was compared against. Every other file in the suite is far below it (the next largest is 8.5 seconds),
so no amount of rewriting them moves the wall clock. The only lever that would is the per-run cost of
the installer itself, dominated by the ACL walk over the fixture tree, which is a different effort
with a different risk profile.

## Sections

### Section 1: Install-Host.test.ts, complete

Converted `runInstallHost` to a promise over `spawn` and wrapped its 14 tests in a describe at
concurrency 8. The helper is a plain function returning a promise rather than an `async` function,
deliberately: its two fencing guards (`settingsPath is required`, `stateRoot is required`) throw
synchronously, which is what lets the guard test hold them with `assert.throws`. An `async` helper
would turn both into rejections a synchronous assertion cannot see, and the guard would pass
vacuously.

File 61.8s to 15.9s.

### Section 2: Install-Functions.test.ts, complete

Added one async `runPowerShell` helper and pointed both existing helpers at it, awaited all 28 call
sites, and wrapped the file in a describe at concurrency 8.

The roughly twenty inline `spawnSync` calls in the ACL tests were deliberately left synchronous. The
helper conversion alone brought the file to 11.7 seconds, below the 15.9-second floor, so converting
them would cost a large and risky diff for exactly zero wall clock. The short `icacls.exe` and
`cmd.exe` setup calls stay synchronous for the same reason: tens of milliseconds against PowerShell's
several hundred.

`runFunctions` asserts on the child's exit status inside itself, so a call site that lost its `await`
would turn a failed assertion into an unhandled rejection that no test owns, which the suite counts
would not reliably catch. The call sites were checked for that directly, not just left to the gate.

File 21.0s to 11.7s.

### Sections 3 and 4: not needed

Originally planned: converting `Install-All.test.ts` (8.5s), `hooks/session-start.test.ts` (5.0s),
`wrapper/no-mirror.test.ts` (2.8s), and looking into `broker/index.test.ts` (5.5s, no child processes
at all).

Every one of them is already below the 15.9-second floor, so converting any of them buys nothing at
all. They are recorded here as considered and declined rather than left as pending work, so that a
later session does not spend an afternoon on them expecting a result.

## Gate

`npm test` must report 1117 tests, 1116 pass, 1 skipped, 0 fail. The skip is
`a POSIX token file is refused unless it is owner-only`, a platform gate, and it is expected.

The specific way this refactor could ship a green lie is registration moving inside an async boundary:
an `async` describe callback, or a generating loop inside an awaited function. The runner would never
register those tests and the suite would go green with fewer of them. Making a test *callback* async
is safe; making *registration* async is not. Diff all four counts, never just the failures.

## Result

| | Before | After |
| --- | --- | --- |
| Full suite | 65.4s, 68.9s | 19.1s, 19.5s, 19.8s, 20.0s |
| `Install-Host.test.ts` | 61.8s | 15.9s |
| `Install-Functions.test.ts` | 21.0s | 11.7s |

Counts identical on every run: 1117 tests, 1116 pass, 1 skipped, 0 fail. Four consecutive full runs
were taken rather than one, because the change is a concurrency change and a single green says
nothing about flake.

## Chapters

### Chapter 1: the measurement and Section 1

The starting assumption, that the runner was serialized the way another repository's had been, was
wrong: file-level parallelism was already on and already working. The real finding was that
parallelism stops at the file boundary, and one file held 61.8 of the 65 seconds.

Two samples were taken for the baseline rather than one, since a single sample on Windows with live
antivirus is a point rather than a range: 65.4s and 68.9s. The concurrency curve was measured rather
than picked.

### Chapter 2: Section 2, and the floor deciding the rest of the plan

Section 2's file is a different shape from Section 1's: rather than one helper, it has two helpers
plus about twenty inline `spawnSync` calls scattered through the ACL test bodies. The full conversion
was scoped and then deliberately not done.

What settled it was reading the floor as a budget. With `Install-Host.test.ts` contention-bound at
15.9 seconds, Section 2 did not need to be as fast as possible, it needed to be under 15.9. The
helper conversion alone reached 11.7, so the riskiest two thirds of the diff was never written. The
same reasoning then retired Sections 3 and 4 outright, since both were already under the floor before
any work started.

The surprise worth recording is that the speedup is sublinear and contention-bound rather than
scheduling-bound: fourteen installer runs at once take 3.3 times as long as one, not a fourteenth of
fourteen. That is why the suite lands near 19 seconds rather than near 5. What contends was not
measured, only inferred from the shape of the work: disk, antivirus, and PowerShell 5.1 startup are
the candidates, and anyone chasing the floor further should establish which before trying to move it.

### Chapter 3: the blind review round

A blind correctness review of the diff returned CHANGES_REQUIRED. It cleared the risk this refactor
existed to avoid, confirming by reading both files that no test lost its registration: both `describe`
callbacks are synchronous and both generating loops still run at describe time. It also confirmed the
ordered ACL sequences were untouched and that every helper call site awaits.

Four findings were accepted and fixed.

Neither `spawn` call attached an `'error'` listener, where the synchronous spawn it replaced had
reported a failure to launch as a null status that the assertions already read. Both helpers now
resolve that way on `'error'`, which keeps a failed launch a readable assertion.

Neither closed the child's stdin. A synchronous spawn hands the child an already-closed stdin; a
spawned child gets a live pipe. `Install-Host.ps1` prompts for the token with `Read-Host` when neither
token argument is given, and the runner applies no per-test timeout, so such a run would have waited
forever instead of failing. Latent rather than live, since the one test omitting both arguments fails
parameter validation before the script body runs, but it was one future test away. Both helpers now
call `child.stdin.end()`.

Two tests shared the machine-global scheduled-task name `ProbeTask`, and one of them asserts on real
machine-wide state. Neither registers a task today, so nothing was broken, but the coupling was
created by making them concurrent. They now use distinct names, and the comment says why the name
must stay unique.

The helper's own comment claimed the only remaining synchronous calls were the short `icacls.exe` and
`cmd.exe` ones, while about a dozen full `spawnSync` PowerShell calls remain in the ACL tests. In this
codebase a comment asserting a property is a claim, so the comment was corrected to state the real
stopping point and why it is where it is.

One finding was rejected. The review reported a UTF-8 BOM at the head of `Install-Host.test.ts`; the
file's first three bytes are `2F 2F 20`. The review read the file during the window in which its line
endings were being rewritten, and the reading is an artifact of that race.

One finding was accepted but its severity corrected. The missing `'error'` listener was reported as
aborting the whole test file. Driven directly, by pointing the helper at an executable that does not
exist, the runner attributes the uncaught exception to a test and carries on: 13 failures without the
listener against 12 clean assertion failures with it, and the file reports all 14 tests either way.
The fix is still right, because an assertion naming the failure beats an uncaught exception whose
attribution under concurrency is not dependable, but it does not take the file down.
