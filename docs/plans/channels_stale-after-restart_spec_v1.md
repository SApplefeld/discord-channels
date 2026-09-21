# channels: a session that died during a broker outage is ended, and a deleted thread stays deleted, v1

Status: In Progress
Commit Model: Branch-and-PR. Work on branch `stale-after-restart`, push to `origin`, open a PR against `main`, never push directly to `main`.
Created: 2026-09-20
Worker: a dev persona, handed over by the coordinator persona. The architect persona wrote this plan and does not execute it.
Checkout: the live broker runs from `D:\Discord-Channels`, so the worker builds in a separate git worktree for the branch rather than switching that checkout, which would change the running broker's code underneath it.

## Goal

After a broker restart, a session whose process died while the broker was down is marked ended within two minutes of the broker answering on its port again, so its Discord thread paints as exited and the operator's deletion of that thread sticks. A session that is still alive is never ended by a restart, however long the broker was down. Separately, a deleted card or thread is not rebuilt for a session the broker has heard nothing from for the staleness window, so a deletion is honored whatever made the session silent.

## Intent

The operator's frame, 2026-09-20: "why discord-channels keeps bringing back these few specific channels that aren't online". Three threads, for sessions that were gone, reappeared within a minute of every deletion for hours.

What done needs to do. A thread for a session that is not running stops coming back after the operator deletes it. The broker stops holding a dead session in the quiet-but-maybe-alive state just because the broker itself restarted at the wrong moment.

What done does not need to do. It does not need to clean up the three threads from the night of 2026-09-20, which expire on their own through the existing four hour backstop. It does not need to find what killed the broker that night, since the log holds no shutdown line and the fix does not depend on the cause. It does not shorten the four hour backstop, change the staleness window, or change how a session with no relay is judged alive or dead. It adds no lifecycle state, no new persisted field and no operator command. The hub's in-memory window entries gain one field.

Alternatives refused.

- Reuse the existing 15 second relay grace window for the restart case. Refused: the relay client's reconnect delay doubles to a 30 second ceiling, so after any outage past half a minute a healthy relay can take longer than 15 seconds to return. The session would be marked ended, and ended is terminal.
- Persist the in-memory grace windows across a restart. Refused: a new persisted field, and it covers only a pipe that closed before the broker died. A process that died during the outage never had a window to persist.
- Shorten the four hour presumed-exit backstop. Refused: it exists so a long quiet session is not declared dead on silence alone, and that reasoning is unchanged.
- End every restored record at startup and let survivors re-announce. Refused: ended is terminal and a relay re-attach skips ended records, so every live session would lose its thread on every broker restart.

Decided 2026-09-20, on the operator's Discord channel: the surface guard in Section 2 is in. The question put was whether the broker should stop rebuilding a deleted thread for any session silent past the staleness window, with a session blocked on the operator exempt. The answer was yes. The stated cost was accepted: a quiet but living session whose thread is deleted by accident stays without one until its next activity.

Rulings after the spec shipped: none at the write.

Provenance: distilled from the architect persona's design conversation with the operator on Discord, 2026-09-20, and the root-cause analysis delivered in that thread the same night.

## Root cause

A relay pipe closing opens a grace window in `broker/routing/relays.ts` (`pending`, a `Map` in memory). If the pipe stays gone for `graceMs`, `reapPending` calls `registry.relayClosed` and the session becomes `ended`. That window does not survive the broker process.

On 2026-09-20 the broker log records two sessions' pipes closing at 04:04:56Z and 04:05:07Z, and then nothing until the broker's next listening line at 04:14:17Z. A third session has no close line at all, so its process ended while the broker was down. `createRegistry` restores records exactly as saved (`broker/registry.ts`, the `options.sessions` loop), so all three came back `live` with no window open. The first sweep, at 04:14:30Z, moved them to `stale`, because `sweep` only ever moves `live` to `stale`. Two paths set `ended`, and the set is closed at those two: `relayClosed`, and a new `SessionStart` on the same process token superseding the previous record (`start()` in `broker/registry.ts`). No hook ends a session. `Stop` only counts a turn, and the intake refuses `SessionEnd` with a 400. A process that is gone sends no second `SessionStart`, and its pipe close had no broker to land on. The broker restarted a second time at 04:34:44Z and restored the same three as `stale`, which is why the Approach seeds stale records as well as live ones.

A `stale` record renders `idle` until `exitedAfterMs` (four hours) has passed since its last hook (`deriveSurfaceState` in `broker/discord/state.ts`). `settle` in `broker/discord/surface.ts` drops the identifiers of a card or thread Discord reports missing, and `open` rebuilds both on the next pass unless the session renders `exited`. So each deletion produced a fresh `idle` thread within a minute. The broker log records that cycle 4, 4 and 9 times for the three sessions between 04:14Z and 04:56Z.

Four other records went `stale` in the same sweep and never resurfaced, because a newer session under the same lineage had taken over each thread (`entryFor`'s lineage takeover).

## Related plans

- [channels_thread-rebinding_spec_v1.md](../archive/plans/channels_thread-rebinding_spec_v1.md) (Shelved): one Discord thread across a supervisor's restarts. Its lineage takeover is why only sessions with no running successor showed the symptom. Unchanged by this round.

## Approach

**A broker restart is treated as a pipe close for every restored record that held a relay.** A relay pipe never survives the broker process, so at startup every restored record that is not `ended` and carries a non-null `lastRelayAt` has, as a matter of fact, a closed pipe. The relay hub opens a window for each such record at the moment the broker's listener binds its port, and not before. `broker/index.ts` builds the hub and starts the heartbeat long before it binds, with an awaited Discord login in between. A window opened at construction would run down while no relay could reach the broker, and a slow login would end every living session. A relay that re-attaches cancels its window through the existing `attach` path, which already deletes the `pending` entry. One that never returns is ended through the existing `reapPending` and `relayClosed` path. No new lifecycle state, no new persisted field, no new terminal path.

**The restart window is longer than the ordinary one, and is derived from the relay client's reconnect ceiling.** The ordinary `graceMs` is one heartbeat (15 seconds by default), sized for a pipe that drops while the broker is up, where the client's backoff has just been reset to one second. After a broker outage the client's delay has doubled up to `MAX_RECONNECT_DELAY_MS` (30 seconds, `relay/broker.ts`), so a healthy relay's next attempt can land up to 30 seconds plus connect time after the broker returns. The restart window is three times that ceiling, 90 seconds at the default, which spans two full retry cycles with margin. The ceiling moves to the shared constants in `broker/config.ts`, where `RELAY_READ_TIMEOUT_MS` already lives for the same reason, so the client and the hub read one value and a test pins the ratio. Getting this wrong in the short direction is the expensive failure: `ended` is terminal, `current()` skips ended records, and a living session would run on with a dead thread.

**Records restored as `stale` are seeded too.** `relayClosed` already accepts a stale record. Seeding them makes the rule self-healing across two restarts in quick succession, and a stale record with relay history is by construction one whose pipe is gone.

**A record with `lastRelayAt === null` is left exactly as today.** It never held a pipe, so pipe absence says nothing about it. That includes the narrow case of a relay that attached and was never persisted before a crash. `relaySeen` is the registry function that stamps `lastRelayAt`, and it persists only on a state transition. Such a record goes stale as it does today and is covered by the surface guard below.

**The surface declines to build for a silent record, without abandoning it.** In `open`, a view whose lifecycle is `stale` and whose derived state is `idle` builds nothing. This is the same shape as the existing presumed-exit branch beside it: decline, never set `abandoned`, so a record that wakes (a hook or a relay revives it to `live`) builds normally on the next pass. `needs you`, `blocked` and `working` are untouched, so a stale session waiting on the operator still gets its thread rebuilt. An existing surface is unaffected, since `reconcile` drives an existing card and thread without coming through `open`.

The contract sweep for this plan ran over the four parts of the contract (lifecycle states, the grace window, the reconnect backoff, the rebuild rule). Its searches and the surfaces it returned are listed under Sweep result at the end of this section.

### Sweep result

Searches run, over the whole tree outside `node_modules` and `dist`: `relayClosed|SessionEnd`, `stale.{0,15}ended|nothing.{0,20}ended|only.{0,20}ends`, `not session death|closeAll`, `presumed dead|comes back|tombstone`, `RECONNECT_DELAY|graceMs|readTimeoutMs|backoff`, `RELAY_READ_TIMEOUT_MS|relayHeartbeat`, `graceMs|relayHeartbeatMs|createRelayHub` in `broker/index.ts`, `lastRelayAt` in `broker/persistence.ts`, and `test\(.*(exited|rebuild|deleted|missing|404)` in the surface tests. `bridge/` returned nothing for the backoff patterns, so it holds no second reconnect implementation.

Surfaces returned, by part of the contract.

- Lifecycle states. `broker/registry.ts` declares `SessionState` and holds the only two sites that set `ended` (`start()` supersession, `relayClosed`). `broker/persistence.ts` pins the persisted vocabulary. `broker/intake.ts` accepts four hook events and answers any other, `SessionEnd` included, with a 400. Tests: `broker/registry.test.ts`. No code among these changes, since Section 1 adds no state and no path. Two comments in `broker/registry.ts` change in Section 1, because they state what a restart does with `lastRelayAt`.
- Grace window. `broker/routing/relays.ts` (`pending`, `detach`, `reapPending`, `closeAll`, the `graceMs` option comment and the file header), wired in `broker/index.ts`. Tests: `broker/routing/relays.test.ts`. Docs: `docs/operations.md`, the paragraph "A closed session takes half a minute to show as exited". All in Section 1 or Section 3.
- Reconnect backoff. `relay/broker.ts` (`DEFAULT_RECONNECT_DELAY_MS`, `MAX_RECONNECT_DELAY_MS`, `reconnect()`), and `broker/config.ts` (`RELAY_READ_TIMEOUT_MS` and the heartbeat clamp). Tests: `relay/broker.test.ts`, `broker/config.test.ts`. No doc outside `docs/plans/` states the backoff ceiling today. In Section 1, with the docs statement added in Section 3.
- Rebuild rule. `broker/discord/surface.ts` (`open`, `settle`, `entryFor`, `reconcile`) and `broker/discord/state.ts` (`deriveSurfaceState`). Tests: `broker/discord/surface.test.ts`, `broker/discord/state.test.ts`. No test in the tree pins a deleted card for a record that is `stale` and renders `idle`. The existing idle case drives a `live` record past the idle threshold. Docs: `docs/operations.md` (the state legend, the pin sweep's "a card rebuilt after a deletion", the archive paragraph on a presumed-dead session that comes back) and `docs/architecture.md` (the pin sweep and the archive paragraph). `state.ts` and `state.test.ts` do not change, since the guard reads the derived state rather than altering it. The rest sit in Section 2 or Section 3.
- Adjacent and out of scope. `install/Register-BrokerTask.ps1` states that broker restarts are routine. `docs/backlog.md` holds no item on this defect. Its usage-card line about a deleted card concerns a different surface.

## Standing Brief Amendments

- Persisting `lastRelayAt` on a relay's first attach stays outside this plan, per its Out of Scope list. A restored record whose `lastRelayAt` is null opens no restart window and is left to the staleness sweep and to section 2's surface guard.

## Sections of Work

### 1. Open a reconnect window at startup for every restored record that held a relay

Model: opus

In `broker/config.ts`, export `RELAY_MAX_RECONNECT_DELAY_MS = 30_000` beside `RELAY_READ_TIMEOUT_MS`, with a comment stating that the relay client's backoff ceiling and the hub's restart window are derived from it. In `relay/broker.ts`, replace the local `MAX_RECONNECT_DELAY_MS` with that import. The value does not change.

Also in `broker/config.ts`, export `RELAY_RESTART_GRACE_MS = 3 * RELAY_MAX_RECONNECT_DELAY_MS` beside it. It is a constant rather than an environment setting, because a host that shortened it could end living sessions.

In `broker/routing/relays.ts`, `RelayHubOptions` does not change. Five test files outside this section build the hub with `registry` and `graceMs` alone, and a new required option would fail `npm run lint` on all of them. The restart window reaches the hub as the method's argument instead. Give `Pending` its own `graceMs` so each entry carries the window it was opened with, and have `reapPending` compare against the entry's own value. `detach` opens entries with `options.graceMs`, as today. Add a method `openRestartWindows(graceMs: number)` to `RelayHub`. Hub construction seeds nothing. The method seeds a `pending` entry for every record from `options.registry.list()` that meets both conditions: its `state` is not `ended`, and its `lastRelayAt` is not null. The set is closed at those two conditions. The age of `lastRelayAt` is not one, so a record stale for days is seeded like any other. The entry is keyed by the record's `processToken` and carries the record's `sessionId`, `since: now()` and the `graceMs` the method was given. `start()` ends the previous record whenever a new one takes a token, so at most one record that is not `ended` holds a given token. `relayClosed` takes the session ID and ends only the record the entry names, as it does today.

Nothing new drives the reap. `broker/index.ts` runs `relays.heartbeat()` on an unconditional interval, and `heartbeat()` calls `reapPending()` whether or not any pipe is attached. So seeded windows close on the heartbeat after a restart in which no relay ever returns.

A record whose token already holds a pipe when the method runs is skipped. The method runs its seeding once per hub, and every later call returns without reading the registry, so a window is never reopened with a later `since`.

Log one line per seeded record in the style of the `detach` line beside it, which names the session ID. The title never appears, since `docs/security-model.md` holds that transcript content reaches the broker log at no level.

In `broker/index.ts`, call `relays.openRestartWindows(RELAY_RESTART_GRACE_MS)` inside the `server.listen` callback, which is the first moment a relay can attach. Update the file header comment of `relays.ts` and the `graceMs` option comment so they state both windows as current fact.

In `broker/registry.ts`, comments only: the `lastRelayAt` field comment and the `relaySeen` comment gain the fact that a restored non-null `lastRelayAt` is what opens a restart window. The `relaySeen` comment's claim that a relay re-announces itself within a heartbeat is corrected to the reconnect ceiling. No code in that file changes.

Acceptance criteria.

- A hub created over a restored `live` record whose `lastRelayAt` is set, with `openRestartWindows()` never called: no heartbeat at any clock value ends the record. This is the slow-login case.
- A registry restored with a `live` record whose `lastRelayAt` is set, a hub created over it, `openRestartWindows()` called, no attach, and the injected clock advanced past the window given to that call followed by `heartbeat()`: the record is `ended` with `endedAt` set. Every case below calls `openRestartWindows()` and measures from that call.
- The same setup with a `heartbeat()` run at the ordinary `graceMs + 1` milliseconds, which is past the ordinary window and inside the restart window: the record is not `ended` at that heartbeat. An attach for that process token follows, the record is `live`, and no later heartbeat ends it. The heartbeat before the attach is what lets this case go red, since `reapPending` runs only inside `heartbeat()` and an attach deletes the entry unconditionally.
- The same setup with the record restored as `stale`: ended the same way.
- A restored record with `lastRelayAt === null`: never ended by the hub, at any clock value.
- A restored `ended` record: untouched, `endedAt` unchanged.
- `closeAll()` still clears every window and ends nothing.
- A pin test asserts `RELAY_RESTART_GRACE_MS` is at least twice `RELAY_MAX_RECONNECT_DELAY_MS`, reading both exported constants rather than literals.
- A test drives the injected clock in heartbeat steps of the default interval from the `openRestartWindows()` call, and asserts a seeded record that never re-attaches is `ended` at or before 105000 ms. That is `RELAY_RESTART_GRACE_MS` plus one heartbeat, and it is the Goal's two minute bound, measured from the port binding. The thread paints as exited on the surface's next pass after that.
- A second `openRestartWindows()` call after the clock has advanced leaves each entry's `since` unchanged.
- `broker/index.ts` calls `openRestartWindows()` inside the `server.listen` callback and nowhere else. The worker confirms this by reading the file, since no unit test reaches the bind.
- The existing ordinary-grace tests pass unchanged.

Files in scope: `broker/config.ts`, `broker/config.test.ts`, `relay/broker.ts`, `broker/routing/relays.ts`, `broker/routing/relays.test.ts`, `broker/index.ts`, `broker/registry.ts` (comments only). The targeted lane also runs `relay/broker.test.ts`, unchanged, because the client's backoff ceiling moves home.
Tests: lock both directions of the window. A dead session not ended is the defect this plan fixes. A living session ended is the expensive failure, because it is silent and permanent, so the attach-inside-the-window case is written first and watched red against a build that seeds with the ordinary `graceMs`.

### 2. Decline to build a surface for a silent record

Model: sonnet

In `broker/discord/surface.ts`, in `open`, directly after the `exited` branch: when `view.lifecycle === "stale"` and `state === "idle"`, return without building and without setting `abandoned`. Sibling to mirror: the presumed-exit early return in the same function (`if (view.lifecycle !== "ended") return;` inside the `exited` branch), which declines on the same terms. The comment states the rule as current fact: a record nothing has heard from for the staleness window gains no new card or thread, a deletion is honored as cleanup, and a record that wakes renders a live state and builds normally.

Acceptance criteria.

- A stale view rendering `idle`, whose card is reported missing by the transport: no `postCard` and no thread open on any later pass while it stays stale. The entry is not abandoned.
- The same record revived to `live` by a hook: the next pass posts a card and opens a thread.
- A stale view rendering `blocked`, one rendering `needs you`, and one rendering `working` because it holds a background task, each with the card reported missing: rebuilt on the next pass, as today.
- A stale view rendering `idle` whose card is intact and whose thread is reported missing: the thread is not reopened while it stays stale, and the card is still maintained.
- A stale view with an existing card and thread: still reconciled to its current state, as today.
- The existing `exited` tests pass unchanged.

Files in scope: `broker/discord/surface.ts`, `broker/discord/surface.test.ts`.
Tests: lock the decline and the wake. A guard that also swallowed `blocked` would hide the one thread the operator must answer in, so that direction is pinned beside it.

### 3. State the two rules in the solution docs

Model: sonnet
Locus: inline

Update the about-the-solution docs so they describe both rules in the present tense, with no account of how they were found: the restart window and its derivation from the reconnect ceiling, and the surface declining to build for a silent record. Every doc site the sweep returned that states the old rule is brought into line.

The sites, named by their text since line numbers move:

- `docs/operations.md`, the troubleshooting paragraph "A closed session takes half a minute to show as exited". It gains the restart case: after a broker restart the wait is the restart window, 90 seconds at the default, because a relay that was backing off against a down broker can take up to 30 seconds to retry.
- `docs/operations.md`, the state legend line that defines `exited`, and the archive paragraph beginning "Separately, an exited session's thread archives itself". They gain the rule that a session silent past the staleness window gets no new card or thread until it is heard from again, with `needs you`, `blocked`, and a session holding background tasks exempt.
- `docs/operations.md` and `docs/architecture.md`, the pin sweep sentences that mention "a card rebuilt after a deletion". Each stays true for a session the broker is hearing from and is qualified so it does not promise a rebuild for a silent one.
- `docs/architecture.md`, the archive paragraph on a presumed-dead session that wakes. It states that the same decline-and-wake rule now starts at staleness rather than at the four hour backstop.

Acceptance criteria.

- Each site above states the rule as it now behaves, in the present tense.
- `docs/operations.md` states the restart window's default and that it derives from the relay's reconnect ceiling.
- No sentence in `docs/operations.md` or `docs/architecture.md` says a deleted card or thread is rebuilt without the heard-from qualification. The worker checks this by reading every hit of `rebuil|deleted` in those two files, not by an empty grep.

Files in scope: `docs/operations.md`, `docs/architecture.md`.

### 4. Land it on the running broker

Model: opus
Locus: inline

The broker runs from `D:\Discord-Channels` as the scheduled task `docs/operations.md` names, so the change takes effect only after that checkout carries the merged commit and the broker restarts. That restart is itself the first live reading of Section 1, in the direction that matters most. The readings come from `curl.exe -s http://127.0.0.1:8787/sessions`, which needs no credential on the loopback address, and from the broker log at `%LOCALAPPDATA%\sapplefeld-channels\broker.log`. `docs/operations.md` states both at its top. Before the restart, record the session IDs `GET /sessions` lists as `live` with a non-null `lastRelayAt`. Where that list is empty, start one wrapped session first, since a restart with no relayed session reads nothing. Restarting the broker interrupts every session's Discord thread for about a minute, so the worker asks the operator for a yes before it, through the coordinator persona, and names the rollback below in the ask. After the PR merges and the yes arrives, run `install/Repair-Broker.ps1 -Pull` from an elevated shell, with no other build or test process running on the machine. Two minutes after the broker answers again, read `GET /sessions` and the broker log. Every session recorded before the restart that is still running is `live`, and the log holds no ended line for any of them. Still running is never inferred from the `/sessions` answer itself, because a living session wrongly ended would then read as one that stopped. The registry holds no process ID, so the worker attributes by hand. Before the restart it records, beside each session ID, the session's `name` from `/sessions` and the process ID and start time of the `claude` process launched under that name, read from the process list's command lines. After the restart, a recorded process still present with the same start time is a running session, and its session ID must read `live`. Where a name cannot be matched to one process, the worker says so in the Chapter and leaves that session out of the reading.

The operator merges the pull request. No section performs the merge. Section 4 runs after it, so its Chapter and the plan's close-out cannot ride the merged branch. They land on a new branch cut from `main`, under their own pull request. Record both readings in the Chapter as observations, since a suite cannot see a restart.

If any running session reads `ended`, that is a regression in Section 1 and a stop. Tell the operator first. The rollback is a revert of the merge by pull request, then `install/Repair-Broker.ps1 -Pull` again. A session already marked ended stays ended until it next starts, since no path revives an ended record.

## Gate

- Baseline: the worker records `npm test` pass and fail counts and the exit code on a clean tree at the base commit before touching anything, and reports every later run as a delta against it.
- Sections 1 and 2 each close on their targeted lane green (`node --test` over the section's own test files), with the red-then-green record for the new tests in the Chapter.
- The whole gate is `npm run lint` then `npm test`, from the repository root, each read from its own exit code. Both run green before the PR is marked ready. `node --test` strips types, so only lint catches a broken call site.
- The fresh-context reviewer pair runs over each code section's delta, per the executing-work skill.
- Section 4 closes on the two live readings, named in the Chapter as observations.

## Out of Scope

- The three threads from 2026-09-20. They expire through the existing backstop.
- What stopped the broker on 2026-09-20. The log holds no shutdown line.
- The four hour `exitedAfterMs` backstop, the five minute `staleAfterMs` window, and the ordinary 15 second `graceMs`. All unchanged.
- Persisting `lastRelayAt` on a relay's first attach. The unpersisted case is covered by Section 2.
- The relay client's backoff schedule. Only the home of its ceiling constant moves.

## Assumptions

- assumed 2026-09-20 (source: the sibling plans' headers and the last two merges to `main`, both pull requests): the commit model is Branch-and-PR; reversal: a header edit before the run starts.
- assumed 2026-09-20 (default): the restart window is three times the reconnect ceiling, 90 seconds; reversal: one multiplier in `broker/config.ts`, bounded below by the pin test at twice the ceiling.
- assumed 2026-09-20 (default): the plan is born `Ready`, since no worker starts it at the write; reversal: the run sets `In Progress` when it starts.
- assumed 2026-09-20 (source: `broker/persistence.ts` persists `lastRelayAt`): a non-null `lastRelayAt` on a restored record is sufficient evidence the record held a pipe; reversal: none needed unless persistence drops the field.

## Operator Verification

After Section 4, with the broker on the new code: start a wrapped session, stop the broker task, close that session's window while the broker is down, and start the broker task again. Within two minutes the session's thread paints as exited. Delete the thread. It does not come back. A thread that returns reopens Section 1.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-09-21
Completed: 2. Decline to build a surface for a silent record
Implemented By: implementer-sonnet, close pass in the main session
Metrics: review rounds 1, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 2 open (2026-09-21): changes `open` in `broker/discord/surface.ts` to decline building a card or thread for a view whose lifecycle is `stale` and whose derived state is `idle`, without abandoning the entry; serves the Goal's third sentence (a deleted card or thread is not rebuilt for a session the broker has heard nothing from for the staleness window) and section 2's bullets; adds a guard, which that Goal sentence names; size about 6 lines of code plus a comment and five tests; not building it leaves every deleted thread of a silent session rebuilt within a minute.
- Run start: this Chapter records the header normalization `Status: Ready` to `Status: In Progress`, made when the run began. Section 3 gained `Locus: inline` under its `Model:` line, since it writes under `docs/` and a docs write is the main thread's; its tier stays sonnet. Both edits sit above `## Chapters` and are recorded here as deliberate.
- Sections 1 and 2 ran concurrently on disjoint files; section 3's prose was written in the main thread during their run.
- The worktree's line endings on this freshly cut branch are CRLF for every file, sources included, because git wrote them under `core.autocrlf=true`. The brief said the sources were LF, and the implementer converted `surface.ts` and `surface.test.ts` to LF on that premise. Both endings store as LF, so the files were left as they are and the project memory record was corrected.
Assumptions:
- assumed 2026-09-21 (source: the plan's Approach, "a view whose lifecycle is `stale` and whose derived state is `idle` builds nothing", section 2): a surface never built, or left half built when a pass ran out of budget, is declined by the same guard as a deleted one; the guard's comment states all three.
Review Findings: review: adversarial + blind at opus, Workflow at effort high (writer sonnet); resolved models claude-opus-5 on both (18 and 23 turns). No Critical, no Major. Minors: 4 fixed in the close pass, 0 upgraded, 0 left. The four: a test comment claiming a seeding shape the exited case does not use (deleted with the rewrite); the thread test seeded a null thread rather than having the transport report one missing (rewritten to open under `needs you`, go stale, and meet a rename 404); the guard's comment reasoned from deletion alone (now names the never-built and half-built cases); a test that passes with or without the guard titled as coverage of it (retitled as a pin on the reconcile path). Close-pass delta read by its author against section 2's bullets rather than by a round, since it changes test code and a comment only.
Stamps: adjudicated 5, stamped 0. The five are operator records read by the decay pass and by the implementer, none applied to this section's work.
Gate: targeted lane `node --test broker/discord/surface.test.ts broker/discord/state.test.ts`: tests 75, pass 75, fail 0, exit 0; `npm run lint` exit 0 (2026-09-21T11:47:32Z to 11:47:35Z, SCOTT-CLAUDE, working tree on branch stale-after-restart at 4152f79 with sections 1 to 3 uncommitted, uncontended under this session's claim). No run on this lane at 4152f79 was recorded; 71 tests there is inferred (75 less the 4 added), with 0 fail read from the whole-gate baseline; whole-gate baseline 1721 tests, 1720 pass, 0 fail, 1 skipped, exit 0 (11:38:43Z). Delta: +4 tests, 0 retired, 0 edited. Added: "a stale idle session's deleted card waits, and its revival rebuilds it" pins bullets 1 and 2; "a deleted card for a stale session is rebuilt when it needs the operator, is blocked, or holds background work" pins bullet 3; "a stale idle session whose thread is deleted does not reopen it, and its card stays maintained" pins bullet 4; "the reconcile path repaints a stale session's existing card and keeps its thread" pins bullet 5. Tests spawning a process: 0. Red record: against the guard removed (a detached worktree under `.kit/`), the first and third fail and the rest pass; against an over-wide guard (`lifecycle === "stale"` alone) the third fails at needs you, per the implementer's report. Wall clock: lane duration_ms 134.
Next: 1. Open a reconnect window at startup for every restored record that held a relay (in review)
Commit Model: Branch-and-PR
Delta: 2026-09-21T11:47:52Z, SCOTT-CLAUDE, working tree as the Gate line names, uncontended.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-21
Completed: 1. Open a reconnect window at startup for every restored record that held a relay
Implemented By: implementer-opus, close pass in the main session
Metrics: review rounds 1, closed major-closed; provenance 0 spec-traceable, 0 fix-introduced, 1 new-requirement, rulings (1 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open (2026-09-21): changes the relay hub to open a grace window at port bind for every restored record with relay history, moves the reconnect ceiling to shared config, and derives the restart window from it; serves the Goal's first sentence (a session dead during an outage is ended within two minutes of the port answering) and section 1's acceptance bullets; adds a mechanism, `openRestartWindows`, which the section names; size about 40 lines of code across three files plus tests and comments; not building it leaves a dead session in `stale` forever and its deleted thread rebuilt every minute.
- The plan gained a `## Standing Brief Amendments` block above `## Sections of Work`, carrying the scope judge's refusal below as a rule. It sits above `## Chapters` and is recorded here as deliberate approval drift.
- The implementer added a test the acceptance bullets do not list, for a token already holding a pipe when the windows open; the section's text names that skip. It also added a log assertion to the ended-record test, because the registry's `relayClosed` refuses an ended record on its own, so the state check alone stayed green with the hub's skip removed.
Assumptions: none
Review Findings: review: adversarial + blind at fable, Agent tool at frontmatter effort (writer opus); resolved models claude-fable-5-1 on both (34 and 22 turns). One Major, from the blind lens, traced by the orchestrator: `lastRelayAt` is persisted only on a revival, so a session whose relay attached with no later hook restores with null and gets no restart window; its proposed fix persisted the field on first attach. Provenance new-requirement; held and put to the scope adjudicator (fable, 9 turns, claude-fable-5-1), which ruled REFUSE on the `## Out of Scope` entry "Persisting `lastRelayAt` on a relay's first attach. The unpersisted case is covered by Section 2."; that entry exists and names the proposed fix, so the ruling was adopted and no fix written. The `lastRelayAt` field comment gained a clause saying a null value proves less than a set one. No Critical. Minors: 3 fixed in the close pass (the held-pipe test filtered on log wording and would pass open if the sentence changed, now filtered on the session ID and shown red with the skip removed; the seeding loop now names the one-record-per-token invariant it relies on; the `lastRelayAt` clause above), 0 upgraded, 3 left with the reason: `attach` drops the pending entry before it checks the hello write, which predates this plan, is shared by the ordinary window and fails in the safe direction; a `/clear` inside the restart window leaves the new session with no window, the same shape the ordinary window has, and section 2's guard covers the stale result; the config comment argues for three ceilings while the pin holds two, both true, since the pin holds the plan's stated floor.
Stamps: adjudicated 5, stamped 0. The same five operator records Chapter 1 names, none applied here.
Gate: targeted lane `node --test broker/routing/relays.test.ts broker/config.test.ts relay/broker.test.ts`: tests 59, pass 59, fail 0, exit 0; `npm run lint` exit 0 (2026-09-21T11:50:38Z to 11:50:46Z, SCOTT-CLAUDE, working tree on branch stale-after-restart at 4f230d3 with sections 1 and 3 uncommitted, uncontended under this session's claim). Baseline on the same lane at 4152f79: 48 tests (13, 16 and 19 by file), the implementer's reading; whole-gate baseline 1721 tests, 1720 pass, 0 fail, 1 skipped, exit 0 (11:38:43Z). Delta: +11 tests, 0 retired, 0 edited (only the import lines of `relays.test.ts` changed among existing lines). Added: "the restart window spans at least two of the relay's reconnect ceilings" pins the ratio bullet; "a relay that returns inside the restart window keeps its session, past the ordinary one" pins the attach-inside-the-window bullet; "a session whose relay does not return after a restart is ended when the window closes" pins the ended-after-the-window bullet; "a session restored stale is ended the same way when its relay does not return" pins the stale bullet; "no restart window runs before the listener binds" pins the slow-login bullet; "a restored session no relay ever attached to is left to the sweep" pins the null bullet; "a restored ended session is left exactly as it was" pins the ended bullet; "closing every pipe for a shutdown clears the restart windows too" pins the `closeAll` bullet; "a second call does not reopen the restart windows later" pins the second-call bullet; "a token already holding a pipe when the windows open gets no window" pins the section text's held-pipe skip; "a relay that never returns after a restart is ended inside the two minute bound" pins the 105000 ms bullet. Tests spawning a process: 0. Red record per the implementer's report: the first four new window tests fail against a build seeding the ordinary `graceMs`; the null, ended, second-call and held-pipe tests each fail with their own guard removed; the ratio pin and the slow-login test pass trivially and were not watched red. The held-pipe test was shown red again after the close pass, in a detached worktree under `.kit/` with the skip removed. The call-site bullet is checked by reading `broker/index.ts:1443`, inside the `server.listen` callback, the only production call. Wall clock: not recorded separately for this lane.
Next: 3. State the two rules in the solution docs (in review)
Commit Model: Branch-and-PR
Delta: 2026-09-21T11:51:14Z, SCOTT-CLAUDE, working tree as the Gate line names, uncontended.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
