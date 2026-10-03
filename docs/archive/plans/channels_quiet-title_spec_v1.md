# A session thread's title stops announcing active and exited, so a restart writes no rename notice

Status: Complete
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

Rulings after the spec shipped: 2026-10-03, the ARCHITECT persona (record DEV-DISCORD-a3e057e2-b227-463b-aea0-95f28b9c5978-1), on the worker's finding that `docs/security-model.md` names the broker's own glyph as the bound on two accepted risks of a transcript-planted title: the resting title carries a fixed broker-owned prefix that names no state, the bullet U+2022, so it reads `• <name>`. Option refused: the bare name with both security-model passages rewritten to a wider residual, since widening an accepted risk is the operator's call. The first character of every title is the broker's own and alone says whether the thread asks for something. The mark is held in one constant so the operator can swap it before deploy.

Provenance: written by the ARCHITECT persona, session 421dc0ce, on 2026-10-03, from `broker/discord/render.ts`, `broker/discord/surface.ts` and the live docs at `origin/main` 649e8f7.

## Approach

The title is composed in one place, `threadName` in `broker/discord/render.ts:1154`, from `titleState` at `:71`, which folds the card's five states into four title states. The change folds them into two. `working`, `idle` and `exited` have no title state, and their thread name is the resting mark `•`, a space and the session's display name, fitted to Discord's 100-character ceiling, with no separator and no state word. `needs you` and `blocked` compose as today: `⏹ <name> · needs you` and `⛔ <name> · blocked`. This plan calls `• <name>` the resting title.

Everything else follows from that one composition, because the surface already compares composed names rather than states.

- `refreshName` (`surface.ts:452`) spends a rename only when the composed name differs from the painted one. An exit from a resting title composes the same name, so it spends nothing. So does the return to a live state after a restart.
- `archive` (`surface.ts:486`) waits until the painted name equals the exited name. That name is now the resting title, so a thread at rest archives at once, and a thread that exits while titled `needs you` or `blocked` is renamed to the resting title first. That one rename is wanted: it clears a title that asks for an answer no one can give. `exited` stays in the `URGENT` set at `surface.ts:35` so this clearing rename does not wait out the dwell ahead of the archive.
- `retire` (`surface.ts:672`) drives a departed session to the same exited name and needs no change beyond what the composition gives it.

The deploy has one visible cost. A thread painted under the old contract carries `⚙ <name> · active`, which no longer equals the resting title, so each live thread is renamed once after the new broker starts, and that rename writes one notice. It is the last notice a quiet thread gets. The existing per-thread budget and per-tick call cap pace it. An archived thread is not maintained, so one already titled `⚠ <name> · exited` keeps that title until its session comes back, at which point it takes the one rename to the resting title.

Nothing outside the broker reads a thread title. Confirmed in this repository: `threadName` has one caller module, `surface.ts`, and `titleState` is otherwise used for one log line at `surface.ts:468`. The persona plugin and the kit carry no `· active` or `· exited` literal at their `origin/main`.

The sweep for surfaces that speak this contract ran as `git grep` over `origin/main` for `titleState|TitleState|TITLE_GLYPHS|threadName(`, for the literals `· active` and `· exited`, and over the live docs for `exited title`, `title state`, `exited rename` and `four states`. It found: `broker/discord/render.ts`, `render.test.ts`, `surface.ts`, `surface.test.ts`, `adapter.test.ts`, `docs/operations.md`, `docs/architecture.md`, `docs/security-model.md` and `docs/backlog.md`. The `"active"` literals in `broker/board/queues.ts`, `queues.test.ts` and `broker/log.test.ts` are a different word, a store status and a file body, and are out of scope. Rows in `docs/README.md` that describe archived plans are history and stay.

## Standing Brief Amendments

- 2026-10-03, ruling of the ARCHITECT persona: a resting title is `• <name>`, the bullet U+2022 held in one exported constant, then a space, then the display name fitted to the room left under Discord's 100-character ceiling. It applies to `working`, `idle` and `exited` alike, so all three still compose one string and spend no rename between them. A session title that itself begins with a state glyph composes with the resting mark first. A thread restored from `⚙ <name> · active` is renamed once to `• <name>`.

## Sections of Work

### 1. The title carries two states

Model: opus

`titleState`, `TitleState` and `TITLE_GLYPHS` in `broker/discord/render.ts` cover `needs you` and `blocked` only, and `threadName` returns the resting mark, a space and the fitted display name for `working`, `idle` and `exited`, the mark held in one constant. The comments above them state the new rule in the present tense. The log line at `surface.ts:468` names a rename to the resting title in plain words rather than a state that no longer exists. The comments in `surface.ts` at `:22-34`, `:481-485` and `:661-666` are brought in line with the resting title, and the `URGENT` set keeps `exited`.

The shape of `titleState`'s return for a state with no title is the implementer's call. Opus rather than sonnet because the tests encode the old contract in 36 title literals across three test files, and several assert the exited rename as the gate on the archive, so each needs a judgment on what it now proves rather than a literal swap.

Acceptance:

- A session moving `working` to `idle` to `exited` and a new session taking over the thread by lineage spends zero renames across the whole sequence, with the thread at the resting title throughout.
- A session at the resting title that exits is archived with no rename before it.
- A session titled `needs you` or `blocked` that exits is renamed to the resting title without waiting the dwell, then archived.
- A thread restored from a binding whose painted name is `⚙ <name> · active` is renamed once to `• <name>`, and not again.
- `needs you` and `blocked` titles compose byte-for-byte as they do at `origin/main` 649e8f7, and `needs you` is still painted at once while `blocked` still waits the dwell.
- A display name at or over 100 characters yields a resting title of at most 100 characters.
- A session title that itself begins with a state glyph composes with the resting mark first.
- `npm run lint` and `npm test` exit 0, read from each run's own exit code.

Files in scope: `broker/discord/render.ts`, `broker/discord/render.test.ts`, `broker/discord/surface.ts`, `broker/discord/surface.test.ts`, `broker/discord/adapter.test.ts`.

Tests: lock the zero-rename exit and return, since that is the defect and a later title change could bring the rename back unseen. Lock the archive at rest with no rename, since the archive gate used to depend on the exited rename landing. Lock the clearing rename from `needs you` and from `blocked` at exit, since without it a dead thread keeps asking for an answer. Lock the one-time rename from an old painted name, since that is the migration. The literal in `adapter.test.ts:167-171` is a transport fixture and changes only if the implementer wants it to stop showing a title the broker no longer writes.

### 2. The docs describe the title as built

Model: sonnet

Four live documents state the old contract and are corrected in place, in the present tense, with no account of the change.

- `docs/operations.md`, "Reading a thread", from the sample block near `:85` through the glyph paragraph near `:122`. The sample shows resting titles as `• <name>` beside one `needs you` and one `blocked` title. The text says a title carries a state only when the session wants something from the operator, and says where liveness is read instead: the status card, the thread leaving the active list when its session exits, the typing line, and the `↻ supervisor restarted` line. The glyph paragraph covers three marks. The same file's other carriers of the old title follow: the card-vocabulary sentence near `:131`, the archive paragraph near `:229`, the `/rename` paragraph near `:239`, and the fan-out sentence near `:817`.
- `docs/architecture.md` near `:641-647`, the sentence naming four title states, and near `:915-918`, "the final exited rename and the archive".
- `docs/security-model.md:1074`, the same phrase about the per-thread bucket. Its title-bound passages near `:573-594` and `:1494-1497` stay true in substance and correct only what moved: the state suffix no longer renders at rest, so the blank-title passages say the broker's glyph still renders, and the "under ninety characters" room is restated from the code as built, since a resting title spends two characters and a state title spends more.
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

- assumed 2026-10-03 (ruled): the resting title is `• <name>`, ruled 2026-10-03 on the worker's finding that security-model.md leans on a broker-owned glyph; reversal: one constant and its tests, and one more rename per live thread.
- assumed 2026-10-03 (default): one rename notice per live thread at deploy is acceptable, since it is the last one a quiet thread gets; reversal: a lazy migration that waits for the next wanted rename, which adds a second comparison to `refreshName`.
- assumed 2026-10-03 (operator, 2026-10-03 messages): `needs you` and `blocked` keep their titles, since the operator named only active and exited; reversal: a further plan.
- assumed 2026-10-03 (default): the blind read and the plan review are skipped, as the brainstorming skill allows for a plan of two sections.

## Operator Verification

- After the new broker is installed on a host, watch one quiet supervised thread across a supervisor restart. It shows the `↻ supervisor restarted` line and no "changed the channel name" notice. A notice reading `active` or `exited` after the one-time rename reopens the work.

## Open Questions

None.

## Related

- `channels_title-states-and-rename-cleaner_spec_v1.md`, which set up the title-state vocabulary this plan cuts to two states.
- `channels_blocked-state_spec_v1.md`, which added the `blocked` title this plan keeps byte for byte.
- `channels_follow-session-rename_spec_v1.md`, whose archive-at-rename gate now waits on the resting title.
- `channels_session-activity-signals_spec_v1.md`, the parent plan whose typing line and restart line now carry liveness instead of the title.

## Chapters

### Chapter 1 - 2026-10-03
Completed: 1. The title carries two states
Implemented By: implementer-opus (first build and the round 1 fix round, resumed); main session (the archived-entry guard in `retire` with its test, and the round 2 fix)
Metrics: review rounds 2, closed major-closed; provenance 1 spec-traceable, 1 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 3 findings, 1 fixed, 1 deferred, 0 refused (one covered by Section 2); NEEDS_CONTEXT 0; escalations 0; consults 0; one architect ruling (option (b), resting mark) taken through the expert seat
Decisions / Surprises: section 1 open: changes titleState/threadName so working, idle and exited compose the bare fitted display name; serves Goal sentence 1 and acceptance bullets 1-6; adds no mechanism (removes two title states); size about 5 files, 36 test literals; not building it leaves two rename notices per supervised restart.
fold: retire skips refreshName for an archived entry; serves Intent negative clause 'does not retitle threads already archived' and Out of Scope 'Retitling archived threads'; adds no unnamed mechanism (restores the no-call behavior the old composition gave); 1 line + 1 test; not building it spends one doomed rename per old archived binding at deploy.
round 1 fix (Major, blind+security, trace Goal sentence 1 as amended): resting title becomes `• <name>` via one exported constant; serves the Standing Brief Amendment of 2026-10-03 (architect ruling) and the new acceptance bullet; adds no unnamed mechanism (the amendment names the constant); size one constant, one branch, ~30 test literals; not building it lets a planted title draw byte-identical to a broker needs-you title and widens two accepted risks without the operator.
The implementer's DONE_WITH_CONCERNS surfaced that `retire` would spend one doomed rename on a thread archived under the old `⚠ <name> · exited` title once its session departs, contradicting the Intent's "does not retitle threads already archived"; the main session added the guard, watched its test fail first (`actual: ['neo-intake']`), and the round 1 adversarial reviewer confirmed it implements the Approach sentence. The worker's docs sweep found that `docs/security-model.md` names the broker's own glyph as the bound on two accepted risks of a transcript-planted title, which a bare resting title removed; the blind and security reviewers independently raised the same defect as a Major. The architect ruled option (b) on 2026-10-03 (record DEV-DISCORD-a3e057e2-b227-463b-aea0-95f28b9c5978-1): a resting title is `• <name>`. Recorded under Intent, Assumption 1, Approach, Section 1, Section 2, and a new Standing Brief Amendments block. Promises p1-p4 read above 0.6 (0.75, 0.67, 0.61, 0.60 after the fix round): each is cross-file behavior the source alone cannot show, and each is pinned by a named test the implementer reports red on the old code.
Failed approaches: tried a Perl substitution with the bullet written literally into the `-e` script under `-CSD`, failed because Perl does not decode a script's own source as UTF-8 without `use utf8`, learned to write the code point as `\x{2022}`.
Assumptions: none
Review Findings: `review: adversarial + blind + security at fable, Agent tool` (round 1); `review: adversarial at opus, Workflow, effort high` (round 2). Round 1: Major (blind, security) bare resting title lets a planted title pass as a broker title, fixed by the architect's ruling in the round 1 fix; orchestrator-made trace for the blind lens's copy (Goal sentence 1). Round 2: Major (adversarial) tests repeated the resting mark as a literal 31 times beyond the vocabulary pin, fix-introduced, fixed by building every expected resting title from `RESTING_MARK`; the swap control (mark changed to `◦` in a detached probe worktree at 103df2a) failed exactly one of 283 targeted tests, the vocabulary pin. Advisory: security Major on `security-model.md:573-594` fixed through Section 2; security Minor `npm audit` deferred, already the backlog item parked 2026-10-03 by the plan reader plan; security Minor `:1074` covered by Section 2. Minors: 4 fixed (the archive-liveness comment claim, the duplicate render test folded, the RESTING_MARK pin sentence, "draws" narrowed to "composes"), 0 upgraded, 1 left (blind: `entry.archived` can be stale across a revival window; no visible effect, since every thread archived under this code already carries the resting title).
Stamps: adjudicated 2, stamped 1 (forward-resource-arrangements-into-dispatch-briefs: the section's brief forwarded the kit suite and main-checkout baseline as workspace constraints); kit-memory-database-host skipped, read but not applied.
Gate: targeted lane (render, surface, adapter tests) at 103df2a exit 0, 283 tests, 283 pass, 0 fail; npm run lint exit 0; npm test on the worktree at 103df2a plus Section 2's uncommitted docs, 2026-10-03, exit 0, 2367 tests, 2366 pass, 0 fail, 1 skipped (the POSIX token-file test, Windows skip), 53 s wall, a foreign `node --test` (pid 11288) running beside it. Baseline on the same lane: main checkout at 649e8f7, exit 0, 2363 tests, 2362 pass, 1 skipped, 56 s, the implementer's runs possibly beside it. Delta: 0 failing to 0 failing, 4 tests added net. Added: zero renames across a supervised restart (the defect); archive at rest with no rename; clearing rename from needs you and blocked at exit without the dwell; ceiling for the resting title at 98, 100, 101 and 400; a glyph-led session title composes behind the resting mark; an archived thread whose session departs takes no rename. Retired: "a session going quiet or exiting does not change its thread name", class duplicate. Edited: about 20 tests repointed from the exit rename to the needs-you rename so budget, GONE, refusal, retire-pass and archive-gate contracts are still exercised; expected titles moved to the resting title. Tests spawning a process: 0.
Next: 2. The docs describe the title as built
Commit Model: Branch-and-PR
Delta: moment 2026-10-03, worktree D:/discord-channels-wt/quiet-title at 103df2a with Section 2 docs uncommitted, this machine.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-10-03
Completed: 2. The docs describe the title as built
Implemented By: main session (`Locus: inline`, docs/ writes stay in the main thread; the section's tier is sonnet)
Metrics: review rounds 1, closed major-closed; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement (reader and prose findings take no trace; counted from the prose reviewer's three accuracy Majors), rulings (0 refused, 0 declared, 0 asked); advisory: 0; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: section 2 open: rewrites the title passages in operations.md, architecture.md, security-model.md and backlog.md to the resting title • <name>; serves Section 2 acceptance and the 2026-10-03 amendment; adds no mechanism; ~10 passages across 4 files; not doing it leaves live docs stating a title the broker no longer writes.
The plan's sweep named the "Reading a thread" block alone in `docs/operations.md`; a wider read found four more carriers in the same file (the card-vocabulary sentence, the `/rename` paragraph, the fan-out sentence and the blocked-backstop sentence) and two title-bound passages in `docs/security-model.md` (near 573-596 and 1496-1500). Their substance was folded into this section, all inside its listed files, and the plan's Section 2 text was amended to name them; recorded as approval drift. `docs/operator-checks.md:141` ("rendered glyph-first") was read and left: it stays true with the mark first. `docs/security-model.md:83` speaks of the session's `exited` state, not a title, and stays.
Failed approaches: none
Assumptions: none
Review Findings: `review: blind-reader + prose-reviewer at fable, Agent tool (1 reader)`; code pair not run, the section changed documents only. The blind-reader dispatch carried focus framing (which words to search for), which the reader itself recorded as contamination; its findings are read with that discount. Prose reviewer, CHANGES_REQUIRED: Major `operations.md` claimed an exit writes no rename notice at all, fixed by scoping it to a thread at rest and stating the clearing rename and the archive that waits on it; Major the blocked-backstop sentence still said a title flips to exited, fixed; Major the backlog attributed today's archive gate to an August round's reading, fixed by keeping that round's report as found and stating the current gate as present fact. Blind reader: Major the archive can be late behind a clearing rename, fixed in the same `operations.md` paragraph with the knob named (`CHANNEL_DISCORD_ARCHIVE_ON_END`); Major the `/rename` paragraph implied an exited session repaints faster, fixed (an ended record takes no further title, confirmed at `broker/registry.ts:805`); Major unreadable `/rename` fallback, outside this plan's behavior, routed to `docs/backlog.md` (parked 2026-10-03). Minors: 7 fixed (glyph-first wording to mark, "exited name" to resting title, the parenthetical split, the over-long security sentence split, the architecture-versus-security bound strength aligned, Discord's 100-character cap stated, every touched paragraph rewrapped under 101 characters), 0 upgraded, 5 left: the `security-model.md:1074` bucket wording stays `blocked` because that passage is about the blocked-goal feed; four blind-reader Minors on pre-existing passages this plan does not change (the dropped-rename log line, the dwell table row, the Unicode examples, the wrapper `-Name` relationship). The fix delta is prose only, so it owes no round; it took the author re-read against `render.ts`, `surface.ts` and `registry.ts`.
Stamps: none surfaced since Chapter 1.
Gate: docs sweep over live docs (`docs` and `README.md`, excluding `docs/archive`, `docs/plans` and `docs/README.md`) for `· active|· exited|exited title|title state|exited rename|four states|state suffix intact|says only \`active\`|title.{0,40}\`active\`|composed exited name|flipping to exited|glyph-first because`: exit 1, no match; the same pattern at 649e8f7 matches 13 lines across the four documents, so it speaks. The pattern is literal and the class (statements about the title) has no structural shape, so the named members are swept and the class is not; the passages the wider read found are listed above. npm test on this tree, 2026-10-03, exit 0, 2367 tests, 2366 pass, 1 skipped, 53 s wall, foreign `node --test` pid 11288 beside it; npm run lint exit 0. Delta against the Chapter 1 baseline: unchanged. Tests added, retired, edited: none.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: moment 2026-10-03, worktree D:/discord-channels-wt/quiet-title at 103df2a with this section's docs uncommitted, this machine.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-10-03
Finishing pass, steps 1-3. Base ref 649e8f7 (merge-base of `plans/quiet-title-docs` with main is 2d29ae6, whose tree carries the shipped code; 649e8f7 is the parent of the plan's first Chapter commit, used so the reviewers saw the whole effort). Tree-state capture before the round: porcelain empty at 38c1d6c; after: empty, no delta.
Step 1 QA (qa-verifier, Agent tool): PASS. npm run lint exit 0; npm test exit 0, 2367 tests, 2366 pass, 0 fail, 1 skipped; every Section 1 and 2 acceptance bullet verified; `needs you` and `blocked` byte-identical to 649e8f7 across 8 names; docs sweep 0 matches at HEAD against 9 at 649e8f7. Contention lane: none defined.
Steps 2-3 (Workflow wf_20aafe3f-d6c, fable, effort high): security CLEAR, performance CLEAR, adversarial APPROVED_WITH_CONCERNS, prose APPROVED_WITH_CONCERNS.
Majors, both fixed: adversarial, the two plan-index lines in `docs/README.md` and `docs/plans/README.md` copied the pre-ruling Goal ("name alone") and said Ready; prose, `operations.md` said a thread falls back to the launch name after a rename yielding nothing readable, which `noteTitle` (registry.ts:977-985) refuses without clearing, so a renamed thread keeps its last readable title; the sentence now says so.
Advisory: security Minor dwell wording (operations.md narrower than URGENT) fixed, naming the silence-backstop exited case; security Minor plan status word fixed with the index lines; security Minor npm audit deferred, the backlog item parked 2026-10-03 stands; performance Minor one rename per unarchived old `⚠ · exited` thread on an archive-off host, accepted: one notice once per such thread, paced by the budget, inside Assumption 2's one-rename-per-live-thread deploy cost; performance Minor double threadName per tick, pre-existing, refused as outside the plan.
Minors fixed: bindings.ts comment on the composed title; render.ts comment scoped to a thread at rest; operator-checks.md "glyph-first" to the mark wording; security-model.md resting case stated (a planted suffix is the only one at rest) and the truncation sentence scoped to a titled state, the cap sentence split into one number style; operations.md rule and reason split, rename budget named at first use; architecture.md over-long sentence split and the copied verdict replaced by a pointer; backlog.md "now" dropped. Minors left: restored-binding fixtures spelling `· working` (pre-existing, still a stale name no state composes); docs/README.md:59 archived-row gloss (history, exempt).
Gate after the fixes: targeted lane, npm run lint exit 0, `node --test "broker/discord/*.test.ts"` exit 0, 431 tests, 430 pass, 0 fail, 1 skipped. Comment-only code delta, so no review round owed.
Next: step 4 goal read, step 5 docs-curator, step 6 close.
Step 4 goal read (scope-adjudicator, fable, Agent tool), RULED: asked-but-unbuilt empty. Built-but-unasked, accept-and-declare: the archived-thread guard in `retire` (serves Intent "does not retitle threads already archived"); the `bindings.ts` comment; the `operator-checks.md` sentence; the plan index line. Ask, two items taken together: the rewritten `/rename`-to-nothing-readable sentence in `operations.md` and the backlog item parking that question. Settled by the seat's own recommended branch after reading the code: `customTitle` (tail.ts:1269, 1781) yields no item for an unreadable value, `noteTitle` (registry.ts:977-985) refuses rather than clears, `displayName` (render.ts:1125) prefers the stored title, so the new sentence holds and the backlog item, added in this changeset and never on main, was retired as answered. Low-blast and reversible: a docs sentence and one unmerged backlog entry. Left: `adapter.test.ts:45,56` carry the literal `• neo-intake` beside the one vocabulary pin, a fixture the plan allows either way. Tree-state check: porcelain before and after the round the same 10 files, no delta.

### Chapter 3 - 2026-10-03
Completed: finishing-work. Both sections pass their acceptance; the code shipped on PR #40 (merged at 103df2a, merge 2d29ae6) and the docs and close-out ship on a second pull request from branch `plans/quiet-title-docs`, since the merged-branch push guard refused the first branch after the operator merged it mid-run.
Implemented By: main session (finishing pass, fix pass and close path); qa-verifier, four finishing reviewers, scope-adjudicator and docs-curator as dispatched seats
Metrics: finishing review rounds 1, closed major-closed; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 4 declared, 1 asked and settled on the seat's recommended branch); advisory: 0 Critical or Major, 5 Minors (2 fixed, 1 deferred to the existing backlog item, 1 accepted, 1 refused as outside the plan); NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "A session thread's title is the session name alone while it runs and after it exits, changing only for `needs you` and `blocked`, so a supervised restart writes no rename notice." As built, under the architect's ruling of 2026-10-03: the resting title is `• <name>`, the bullet held in `RESTING_MARK` (`broker/discord/render.ts`), so every title opens with a mark the broker owns. Working, idle and exited compose that one title, so a restart spends no rename. A thread titled `needs you` or `blocked` at exit takes one clearing rename without the dwell, then the archive. The two state titles compose byte for byte as before. The Goal sentence is the approved text and stays; the ruling is recorded under Intent, Assumption 1 and Standing Brief Amendments.
Decisions / Surprises:
- Base ref 649e8f7, the parent of the plan's first Chapter commit. The branch's merge-base with main is 2d29ae6, whose tree already carries the code, so the reviewers took 649e8f7 to see the whole effort. The changeset listing against it is the plan's Files in scope, the bookkeeping set, and `broker/discord/bindings.ts` (a comment) and `docs/operator-checks.md` (two sentences), both declared by the goal read.
- Two review Majors fixed: the plan-index lines carried the pre-ruling Goal and a stale status; `operations.md` said a thread falls back to the launch name after a rename to nothing readable, which `noteTitle` refuses without clearing.
- Goal read ask settled: the rewritten fallback sentence holds against `customTitle` (tail.ts:1269, 1781), `noteTitle` (registry.ts:977-985) and `displayName` (render.ts:1125), so the backlog item parking that question, added in this effort and never on main, was retired as answered.
- Drift (docs-curator, all deviation): D1 Goal wording versus the ruled `• <name>`, kept as above; D2 the archived-thread guard in `retire`, documented in `operations.md`; D3 a backstop-exited session skips the dwell only until its thread is archived, confirmed at `surface.ts:648-652` and documented; D4 a blocked fan-out carries its state title, wording corrected; D5 `operator-checks.md` thread-list claim corrected; D6 the `bindings.ts` comment, declared. Library hygiene: Related now names the title-states, blocked-state, follow-session-rename and activity-signals plans.
- Deploy cost, declared: each live thread takes one rename from the old title at the new broker's first pass. On a host with the archive off, a thread left unarchived under the old `⚠ <name> · exited` title also takes one, once.
Failed approaches: tried an index-editing script as `.js` under `.kit/`, failed because the repo's `package.json` sets `"type": "module"`, learned to name such scratch scripts `.cjs`.
Assumptions: none in the finishing pass
Review Findings: review: security + performance + adversarial + prose at fable, Workflow wf_20aafe3f-d6c (high); capacity reading `fable capacity: scoped 58%, 7d 44%, 5h 29% (account 6) -> dispatch`. Verdicts: security CLEAR, performance CLEAR, adversarial APPROVED_WITH_CONCERNS, prose APPROVED_WITH_CONCERNS. Majors and Minors as on Interim board 1; the fix delta was prose and two code comments, gated on the targeted lane. Goal read: scope-adjudicator at fable, RULED, asked-but-unbuilt empty. QA: qa-verifier PASS. Tree-state check around steps 1-4: no delta.
Stamps: none surfaced in the finishing pass.
Gate: whole gate (handoff), measured 2026-10-03 on this machine over the worktree at 38c1d6c plus the uncommitted finishing edits and the archive move, after a foreign `node --test` (pid 12728, another repository's single test file) exited: `npm test` 2367 tests, 2366 pass, 0 fail, 1 skipped (the POSIX token-file test), exit 0, wall 48 s; `npm run lint` exit 0. No contention lane is defined in this repo. Delta against the baseline at 649e8f7 (2363 tests, 2362 pass, 1 skipped): 0 failing to 0 failing, 4 tests added net.
Next: none
Commit Model: Branch-and-PR
Delta: moment 2026-10-03, worktree D:/discord-channels-wt/quiet-title on `plans/quiet-title-docs` at 38c1d6c with the finishing edits uncommitted, this machine.
