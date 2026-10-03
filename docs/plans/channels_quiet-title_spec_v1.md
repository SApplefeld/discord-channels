# A session thread's title stops announcing active and exited, so a restart writes no rename notice

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-03

## Dispatch Authorization

The operator asked for this plan on 2026-10-03 on the ARCHITECT persona's own channel, as a quick change for the broker's worker. The coordinator persona queues it. It needs no further operator decision: the operator named the two title states to remove, and the one fork the design held is recorded under Intent.

## Goal

A session's Discord thread is titled with the session's name alone while the session is running and after it has exited. The title changes only to say `needs you` or `blocked`, and back. A supervised session that exits and restarts therefore writes no "changed the channel name" notice into its thread, where today it writes two per restart. The status card, the archive of an exited thread, the typing line and the `↻ supervisor restarted` line carry liveness, and none of them changes.

## Intent

The frame, in the operator's words on 2026-10-03: "Now, with Supervisor and the process, the thread being active pretty much means it is online all the time. Those become a lot of noise." Then: "if we just had the 'supervisor restarted' event, that is all we need anymore." Then: "I think we might even be able to entirely remove the 'Active' and 'Exited' thread renames. I'm not sure we need those with the typing indicator, the board card for status, and the persistent usage of threads thanks to the Personas." His sample was a quiet thread on the ASR host: eight restarts over eleven days, each leaving an `exited` rename notice and an `active` rename notice around one restart line.

What done needs to do. Remove `active` and `exited` from the title's vocabulary, so neither transition spends a rename. Keep `needs you` and `blocked` exactly as they are, since those are the two titles that ask something of the operator.

What done does not need to do. It does not delete rename notices: Discord refuses an app's delete of a thread-rename notice (error 50021), which is why stopping the rename is the only fix. It does not change the status card, the archive on exit, the restart line, the rename budget, the dwell, or how a session's own `/rename` reaches the title. It does not retitle threads already archived under an `exited` title, and it does not clean the notices already in a thread.

Alternatives refused. Keeping the title at `⚙ <name> · active` for good and merely skipping the exited rename: refused, since an archived thread of a dead session would read active, which is untrue on a surface the operator reads. A grace window that delays the exited rename until a restart had its chance: refused, since it keeps both renames for every exit that outlasts the window and adds a timer nothing asked for. A switch to turn the old titles back on: refused, since it keeps two title contracts under test and the operator asked for removal. Skipping the exited rename for supervised sessions only: refused, since the operator's reasons hold for every thread.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 421dc0ce, on 2026-10-03, from `broker/discord/render.ts`, `broker/discord/surface.ts` and the live docs at `origin/main` 649e8f7.

## Approach

The title is composed in one place, `threadName` in `broker/discord/render.ts:1154`, from `titleState` at `:71`, which folds the card's five states into four title states. The change folds them into two. `working`, `idle` and `exited` have no title state, and their thread name is the session's display name alone, fitted to Discord's 100-character ceiling, with no glyph, no separator and no state word. `needs you` and `blocked` compose as today: `⏹ <name> · needs you` and `⛔ <name> · blocked`. This plan calls the bare name the resting title.

Everything else follows from that one composition, because the surface already compares composed names rather than states.

- `refreshName` (`surface.ts:452`) spends a rename only when the composed name differs from the painted one. An exit from a resting title composes the same name, so it spends nothing. So does the return to a live state after a restart.
- `archive` (`surface.ts:486`) waits until the painted name equals the exited name. That name is now the resting title, so a thread at rest archives at once, and a thread that exits while titled `needs you` or `blocked` is renamed to the resting title first. That one rename is wanted: it clears a title that asks for an answer no one can give. `exited` stays in the `URGENT` set at `surface.ts:35` so this clearing rename does not wait out the dwell ahead of the archive.
- `retire` (`surface.ts:672`) drives a departed session to the same exited name and needs no change beyond what the composition gives it.

The deploy has one visible cost. A thread painted under the old contract carries `⚙ <name> · active`, which no longer equals the resting title, so each live thread is renamed once after the new broker starts, and that rename writes one notice. It is the last notice a quiet thread gets. The existing per-thread budget and per-tick call cap pace it. An archived thread is not maintained, so one already titled `⚠ <name> · exited` keeps that title until its session comes back, at which point it takes the one rename to the resting title.

Nothing outside the broker reads a thread title. Confirmed in this repository: `threadName` has one caller module, `surface.ts`, and `titleState` is otherwise used for one log line at `surface.ts:468`. The persona plugin and the kit carry no `· active` or `· exited` literal at their `origin/main`.

The sweep for surfaces that speak this contract ran as `git grep` over `origin/main` for `titleState|TitleState|TITLE_GLYPHS|threadName(`, for the literals `· active` and `· exited`, and over the live docs for `exited title`, `title state`, `exited rename` and `four states`. It found: `broker/discord/render.ts`, `render.test.ts`, `surface.ts`, `surface.test.ts`, `adapter.test.ts`, `docs/operations.md`, `docs/architecture.md`, `docs/security-model.md` and `docs/backlog.md`. The `"active"` literals in `broker/board/queues.ts`, `queues.test.ts` and `broker/log.test.ts` are a different word, a store status and a file body, and are out of scope. Rows in `docs/README.md` that describe archived plans are history and stay.

## Sections of Work

### 1. The title carries two states

Model: opus

`titleState`, `TitleState` and `TITLE_GLYPHS` in `broker/discord/render.ts` cover `needs you` and `blocked` only, and `threadName` returns the fitted display name alone for `working`, `idle` and `exited`. The comments above them state the new rule in the present tense. The log line at `surface.ts:468` names a rename to the resting title in plain words rather than a state that no longer exists. The comments in `surface.ts` at `:22-34`, `:481-485` and `:661-666` are brought in line with the resting title, and the `URGENT` set keeps `exited`.

The shape of `titleState`'s return for a state with no title is the implementer's call. Opus rather than sonnet because the tests encode the old contract in 36 title literals across three test files, and several assert the exited rename as the gate on the archive, so each needs a judgment on what it now proves rather than a literal swap.

Acceptance:

- A session moving `working` to `idle` to `exited` and a new session taking over the thread by lineage spends zero renames across the whole sequence, with the thread at the resting title throughout.
- A session at the resting title that exits is archived with no rename before it.
- A session titled `needs you` or `blocked` that exits is renamed to the resting title without waiting the dwell, then archived.
- A thread restored from a binding whose painted name is `⚙ <name> · active` is renamed once to `<name>`, and not again.
- `needs you` and `blocked` titles compose byte-for-byte as they do at `origin/main` 649e8f7, and `needs you` is still painted at once while `blocked` still waits the dwell.
- A display name at or over 100 characters yields a resting title of at most 100 characters.
- `npm run lint` and `npm test` exit 0, read from each run's own exit code.

Files in scope: `broker/discord/render.ts`, `broker/discord/render.test.ts`, `broker/discord/surface.ts`, `broker/discord/surface.test.ts`, `broker/discord/adapter.test.ts`.

Tests: lock the zero-rename exit and return, since that is the defect and a later title change could bring the rename back unseen. Lock the archive at rest with no rename, since the archive gate used to depend on the exited rename landing. Lock the clearing rename from `needs you` and from `blocked` at exit, since without it a dead thread keeps asking for an answer. Lock the one-time rename from an old painted name, since that is the migration. The literal in `adapter.test.ts:167-171` is a transport fixture and changes only if the implementer wants it to stop showing a title the broker no longer writes.

### 2. The docs describe the title as built

Model: sonnet

Four live documents state the old contract and are corrected in place, in the present tense, with no account of the change.

- `docs/operations.md`, "Reading a thread", from the sample block near `:85` through the glyph paragraph near `:122`. The sample shows resting titles as bare names beside one `needs you` and one `blocked` title. The text says a title carries a state only when the session wants something from the operator, and says where liveness is read instead: the status card, the thread leaving the active list when its session exits, the typing line, and the `↻ supervisor restarted` line. The glyph paragraph covers two glyphs.
- `docs/architecture.md` near `:641-647`, the sentence naming four title states, and near `:915-918`, "the final exited rename and the archive".
- `docs/security-model.md:1074`, the same phrase about the per-thread bucket.
- `docs/backlog.md`, two parked items. The item parked 2026-08-27 that opens "Watch a renamed session end" still needs its observation, and now names the archive alone, since no exited title exists. The item parked 2026-08-27 on a session evicted by the `maxSessions` cap drops "frozen at a pre-exit title where the exited rename never landed" for what can still happen: a thread left unarchived, or left titled `needs you` or `blocked`.

Acceptance:

- No live document outside `docs/archive/` and the archived-plan rows of `docs/README.md` says a title reads `active` or `exited`, checked with the Approach's sweep, which finds the old phrases at 649e8f7 and so is known to speak.
- Every statement the four documents make about the title matches `render.ts` and `surface.ts` as Section 1 left them.

Files in scope: `docs/operations.md`, `docs/architecture.md`, `docs/security-model.md`, `docs/backlog.md`.

Audience: the operator and a session maintaining the broker. Both know Discord and the fleet. Neither has this plan in hand. The documents must answer: what does a thread title tell me, where do I read whether a session is up, and why does a title not follow every state.
Voice: company.
Fact base: `broker/discord/render.ts`, `broker/discord/surface.ts`, and this plan's Approach.

## Out of Scope

- Deleting or hiding rename notices already in a thread. Discord refuses it to an app.
- Retitling archived threads that still read `exited`.
- The `↻ supervisor restarted` line, the status card, the board, inbox and usage cards, and the typing line.
- The archive on exit, the rename budget, the dwell, the per-tick call cap and the presumed-dead horizon.
- A configuration switch for the old titles.

## Assumptions

- assumed 2026-10-03 (default): the resting title is the bare session name with no glyph; reversal: one constant and its tests, and one more rename per live thread.
- assumed 2026-10-03 (default): one rename notice per live thread at deploy is acceptable, since it is the last one a quiet thread gets; reversal: a lazy migration that waits for the next wanted rename, which adds a second comparison to `refreshName`.
- assumed 2026-10-03 (operator, 2026-10-03 messages): `needs you` and `blocked` keep their titles, since the operator named only active and exited; reversal: a further plan.
- assumed 2026-10-03 (default): the blind read and the plan review are skipped, as the brainstorming skill allows for a plan of two sections.

## Operator Verification

- After the new broker is installed on a host, watch one quiet supervised thread across a supervisor restart. It shows the `↻ supervisor restarted` line and no "changed the channel name" notice. A notice reading `active` or `exited` after the one-time rename reopens the work.

## Open Questions

None.

## Chapters
