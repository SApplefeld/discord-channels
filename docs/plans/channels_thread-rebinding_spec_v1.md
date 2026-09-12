# channels: one Discord thread across a supervisor's restarts, v1

Status: In Progress
Commit Model: Branch-and-PR. Work on branch `passive-supervisor-rebind`, push to `origin`, open a PR against `main`, never push directly to `main`.
Created: 2026-09-11
Worker: the `agent_persona` supervisor's own persona, building this on the operator's explicit instruction (relayed via `agent_persona/discussion.md`) that this repository is open for this one requirement.

## Goal

A long-running Claude Code supervisor (`agent_persona`'s `bin/supervise.sh`) restarts its child on every goal completion, and on a crash. Each restart is a new Claude Code session with a new session ID. Today the broker binds a Discord thread to a session ID (`broker/registry.ts`), so a supervisor's restart opens a brand-new thread, and the operator ends up following a trail of short-lived threads instead of one conversation with one long-running worker.

The fix: a session that carries a stable "lineage name" (set by the supervisor, constant across every child it launches) rebinds to the thread its lineage already owns, instead of opening a new one. The existing per-session behavior for every other launch shape (the wrapper, `wrapper/Enter-ClaudeSession.ps1`) is unchanged: only a session that opts into a lineage name gets this behavior, and the impostor guard at `registry.ts:484` still holds for every session that doesn't.

## Related plans

`sapplefeld-channels_dsh-bridge_spec_v1.md` is a separate, currently active effort in this repository (Status: In Progress, `bridge/` in flight). This plan does not touch `bridge/` and has no dependency on it.

## Roadmap

1. A session declares its lineage. A new env var, `CHANNEL_LINEAGE` (parallel to `CHANNEL_SESSION` and `CHANNEL_PROCESS_TOKEN`), set by a launcher that wants restart continuity. `bin/supervise.sh` in `agent_persona` sets it once per supervisor lifetime (already has the stable name available as `$CHANNEL_NAME`); the wrapper (`Enter-ClaudeSession.ps1`) never sets it, so interactive wrapper-launched sessions are unaffected. Proof: a registry unit test asserting a session with no `CHANNEL_LINEAGE` behaves exactly as today.

2. The registry rebinds instead of creating. When a session with a `CHANNEL_LINEAGE` value registers (`SessionStart` hook post, `POST /hook`), the registry checks its persisted thread bindings for an existing thread bound to that lineage. If one exists, the new session's record takes over that thread binding (the old session's own record is superseded the way a same-token restart already supersedes today, per `registry.ts`'s existing "ends a previous session when a token announces a new one" behavior) rather than the surface creating a new thread. If none exists (the supervisor's first-ever launch), a new thread is created and bound to the lineage, same as today's per-session binding, so the lineage becomes the thread's owner from then on. Proof: a registry unit test where a second session registers with the same `CHANNEL_LINEAGE` as a first, asserting the thread ID returned to the second session equals the first session's thread ID, and that the first session's own binding record is superseded (no longer the active binding for that thread) exactly as a same-token restart supersedes today.

3. A restart says so, once, in the thread. The moment a lineage rebind happens (not the first launch), the surface posts one line into the thread - a system-style notice, not attributed to either party - naming that the supervisor restarted. This uses the existing notice-posting path the rest of the surface already has (the `Discord outbound` reconciliation pass in `docs/architecture.md`), not a new one. Proof: a live run - launch a session with a lineage, note its thread, kill it, launch a second session with the same lineage - observed directly in the real Discord thread as one continuous conversation with a single restart notice line in it, not two threads.

4. The impostor guard is unaffected. `registry.ts:484` and its neighbors, which guard the title-storage cycle, take no new input from this feature and are not touched. A session carrying no lineage is invisible to the new lookup path entirely - it is a strict addition, not a rewrite of the existing binding logic.

5. `docs/architecture.md` gets one paragraph. Under "The name a session goes by" or its own small section: what a lineage is, that it is opt-in, and that it is the one case where a restart's new session ID does not mean a new thread. Proof: the paragraph is in place and a fresh read of the document (as the blind-reader review this repo's own docs hold themselves to) does not need this plan doc to understand what a lineage is.

## Gate

This repository's own: `npm run lint` then `npm test`, both exit codes read from the run, not grepped from their output. No live-suite equivalent exists in this repository the way `agent_persona`'s `.kit/live-all.sh` does; the roadmap's own proof lines (registry unit tests, the live restart-cycle observation) are the acceptance evidence beyond the gate.

## Out of Scope

- Multiple supervisors sharing one lineage name (a collision is a caller error the registry may refuse or log, not something this plan resolves).
- Anything under `bridge/` (see Related plans).
- Changing the wrapper's own per-session behavior.

## Chapters

### Chapter 1 - 2026-09-12
Completed: items 1-5 (CHANNEL_LINEAGE, the rebind, the restart notice, the impostor guard confirmed unaffected, the architecture.md paragraph)
Implemented By: main session (`agent_persona`'s supervisor persona), across four commits: `c05c63a` (item 1), `0bcf3f2` (item 2), `a637bff` (item 3), and this Chapter's own commit (item 4's confirmation and item 5's paragraph)
Metrics: review rounds 0 inline (no dispatch this section); provenance 5 spec-traceable (the roadmap's own five items), 0 fix-introduced, 0 new-requirement; rulings 0 refused, 0 declared, 0 asked; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: Item 1 is purely additive - every existing HookIntake/SessionRecord/SessionView literal across the test suite got `lineage: null`, which is item 1's own "behaves exactly as today" proof lived out in every one of them rather than argued separately. Item 2's real discovery: the surface reconciler (`broker/discord/surface.ts`) is documented as never posting a Discord message itself - "the surfaces reconcile passive state on a timer and must never post" (`ThreadMessenger`'s own comment) - which the roadmap's own wording ("this uses the existing notice-posting path the rest of the surface already has") did not anticipate needing a second call site. `onRebind` is the signal `entryFor` emits; `broker/index.ts`, the one place `Surface` and `ThreadMessenger` already meet, is where the actual `postToThread` call for item 3 lives. Item 2 carries two defensive guards the roadmap text does not spell out: a lineage match against an entry with no real thread yet (`messageId === null`) is skipped, since there is nothing to take over, and a match against an entry Discord has already permanently refused (`abandoned`) is skipped too, since resurrecting a broken surface silently is worse than a fresh thread. Item 4 needed no code: `impostorStart`/`impostor` in `broker/registry.ts` read only `sessionId` and `processToken`, confirmed by reading the function directly rather than trusting the roadmap's own claim.
Assumptions: The restart notice's wording ("↻ supervisor restarted · <lineage>") and its treatment as a new attribution class registered in `ATTRIBUTION_OPENERS` (the spoofing guard every other notice line already uses) are this session's own calls, following the file's established pattern rather than a new one (2026-09-12).
Review Findings: none yet (posted for the Reviewer's next round on `agent_persona`'s DISCUSSION.md)
Stamps: none - this repository carries no live-suite equivalent; see the plan's own Gate section
Gate: this repository's own - `npm run lint` (`tsc --noEmit`) exit 0, `npm test` exit 0, 1711 of 1712 pass, 1 pre-existing skip, 0 fail, at each of the four commits in this Chapter (baseline before item 1 was 1704 of 1705 pass).
Next: the live restart-cycle proof (items 2 and 3's own proof lines) - launch a session with a lineage, note its thread, kill it, launch a second under the same lineage, observe one continuous thread with a restart notice in it, not two threads. This needs a real Discord-connected broker and cannot be proven by this repository's own test suite.
Commit Model: Branch-and-PR

### Chapter 2 - 2026-09-12
Completed: item 2's own defect, found by the Reviewer's live probe against the running broker rather than by reading - a departed session's roster record keeps arriving in every later tick, so a rebind flip-flopped the thread between the old and new session ID on each pass.
Implemented By: main session (`agent_persona`'s supervisor persona)
Metrics: review rounds 1 (Reviewer's live-broker probe, Round 60); provenance 1 review-finding, 0 fix-introduced, 0 new-requirement; rulings 0 refused, 1 declared (in-memory rather than persisted supersession, see Assumptions), 0 asked; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: the broker's registry never drops an ended session's record, so `entryFor`'s lineage-match loop saw that session's own next view as a brand-new session under its old lineage - the entry the takeover had just moved away was gone from `threads`, so nothing distinguished "never registered" from "just superseded." Fixed with a `Set<string>` of superseded session IDs, populated at the takeover site and checked at the top of `reconcile`: a superseded session's own view builds nothing, ever, no matter how many more ticks the roster reports it (ended or still claiming live - the Reviewer's probe hit both shapes and the fix does not distinguish them).
Assumptions: the superseded set is held in memory only, not persisted alongside the thread bindings. Every case the round names, and every test added for it, is a same-process, multi-tick scenario - no broker restart in between. A broker restart is a different failure mode (out of the roadmap's own scope statement) and is not covered by this fix; naming it here rather than silently narrowing what "fixed" means (2026-09-12).
Review Findings: Round 60 point 3 (this Chapter). Reviewer's own live probe: three ticks, five `onRebind` events alternating `a->b`/`b->a`, `threadFor("session-a")` landing on `null` or `thread-1` depending on tick parity.
Stamps: none - this repository carries no live-suite equivalent; see the plan's own Gate section
Gate: this repository's own - `npm run lint` (`tsc --noEmit`) exit 0, `npm test` exit 0, 1713 of 1714 pass, 1 pre-existing skip, 0 fail (baseline before this Chapter was 1711 of 1712 pass). Fix proven red-then-green: reverted the `reconcile` guard, confirmed 2 of the 2 new tests failed (exit 1), restored from a pre-probe backup verified byte-identical via `diff`, reran green.
Next: the live restart-cycle proof (items 2 and 3's own proof lines), still held pending the operator's answer on restarting the one live broker (127.0.0.1:8787, serving both active Discord threads) onto this branch's code.
Commit Model: Branch-and-PR
