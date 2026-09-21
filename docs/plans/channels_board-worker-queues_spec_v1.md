# Fleet board over worker queues

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-20

## Goal

When this is done, the pinned `Fleet: Board` card can draw one group per worker persona on this machine. Each group lists that worker's queued plans in running order, with a plain status word and the real progress of the plan document behind each entry. The operator can tell from a phone what is running, what is next, what is blocked, and how far along each plan is. The existing folder view is unchanged and is switched off by leaving its folder list empty. It matters because the fleet now runs as personas working through queues, and a sweep of plan folders no longer says what anybody is doing.

## Dispatch Authorization

The operator asked for this plan on 2026-09-20 on the architect persona's Discord thread.

> It would be nice if I could get an overview of the plan queue, status within it, and progress overall on work in that `Fleet: Board` instead, in a way that's compatible with the Personas approach.

He approved the sketch, its Assumptions and its addendum the same day with "Yes, they're great. Please proceed." That approval covers authoring. Execution waits on the operator handing this plan to a worker by name.

## Intent

**The frame.** The operator's words: the board card "doesn't give me an idea of what plans are in the goal, what they do, what progress is happening on them." He proposed the shape himself: read the goal trees, show what they have queued, and cross-reference the plan documents "to see what progress exists on them and what they do".

**What done needs to do.** Show each worker's queue in its running order. Put a plain word on each entry that matches what the worker would say about it. Show sections done out of sections total for each plan it can read, and the latest next step for the plan in flight. Make a blocked or stalled entry stand out.

**What done does not need to do.** It does not print the persona plugin's own status words. The operator ruled on this during design: workers told him "paused" only means "not now", and he would read it as "won't". It does not judge health, and no model or classifier runs on the way to the card, which keeps the rule the card's first plan set. It writes nothing to any persona's files. It does not read plan documents from branches that are not checked out. It does not try to tell, from a worker's free-text pause reason, whether that pause is waiting on the operator.

**How the file-name guard is sized.** The join in the Approach takes a file name from a file a persona can write. The operator sized that risk himself during design: "the secret was posted... to my private server, seen only by me? That's hardly a massive disclosure". The guard is kept because it is nearly free, and it earns no raised model tier and no added reviewer on security grounds alone.

**Alternatives refused.**
- Removing the folder view's code: the operator wants it kept behind its setting and inert when the list is empty.
- A closing group of open plans that no queue names: the operator chose the simpler card.
- Trusting the queue file's status as the truth: on 2026-09-20 both workers' in-flight plans read `blocked` with the reason `Max rounds reached` while both workers were working normally. That status is the plugin controller's bookkeeping. The plan document and the heartbeat are better sources.
- Reading a parked plan's progress from its own branch through git: the broker runs no git process today, and the first version does not add one.
- Drawing model-made health answers on the card: those belong to the agent_persona plan named under Related plans, where they are measured before anything shows them.

**Rulings after the spec shipped.** Three, all taken during section 3 and all recorded in the Approach's own wording above, which this line points at rather than restates. The store's block reason draws only where the store's own block is the block. The round-limit reason is compared on the trimmed, case-folded value rather than exactly. `broker/board/queues.ts` gained one export so the queue-ordering key has one owner, which widened section 3's Files in scope by that file.

**Provenance.** Distilled from the architect persona's design conversation with the operator on 2026-09-20.

## Approach

**One new setting.** `CHANNEL_BOARD_ROSTER` holds the absolute path of the fleet roster file, which on this machine is `D:\personas\fleet.json`. The roster is a JSON array the operator maintains. The card uses three fields of each entry: `name`, `workdir` and `enabled`. A roster `workdir` is trusted the way a configured project root is trusted, because the operator writes the file and its location comes from the broker's own settings.

**What is read per enabled persona, each tick.**
- `<workdir>/.agentic-personas.json`, the persona plugin's store. The top-level key is the persona's name. Under it, `goals` is a flat array of queue entries and `activeGoalId` names the entry the controller counts as active. The card uses these entry fields: `id`, `kind`, `title`, `objective`, `status`, `blockedReason`, `pausedByNudgeCap`, `sortKey`, `createdAt`, and `planPath` and `lead` when present. It also reads `monitor.lastTurnComplete`.
- `<workdir>/.agentic-heartbeat.json`. Under the persona's name, `turnStartedAt` is a number while the worker is inside a turn and null otherwise.
- The plan document each entry names, through the join below, parsed by the existing `parsePlan`.

The store is written whole with no rename and no lock, so a read can land mid-write. A store or heartbeat that fails to read or parse keeps its last good reading, as the card already does for a plan document mid-write, and the group's label says so. The store is held on mtime and size like a plan document, so an unchanged file is not parsed again.

**The join from a queue entry to its plan.** The persona's store is writable by the persona, so its text never becomes a path. The broker takes a file name only. From `planPath`, when the entry has one, it keeps the final path segment. Otherwise it searches the entry's `title` and then its `objective` with the expression `docs/plans/([A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-])` and keeps the first capture. Live entries write the path followed by a comma or a full stop, which that expression leaves outside the name. In both cases the kept name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$`, whose suffix folds case so that the join and the folder sweep agree on what a plan file is called, and must not be `README.md` in any case. The text expression above does not fold, so a plan whose name carries an upper case suffix joins through `planPath` and not through the text search. The broker then looks for that name in exactly four places under that persona's own `workdir`, in this order: `docs/plans/`, `docs/archive/plans/`, `docs/archive/`, `docs/plans/archive/`. A name found only in an archive folder marks the entry done. An entry with no usable name, or whose name is found in none of the places, has no plan reading and draws from its store fields alone. The set of places is closed at those four.

**Blocked events.** The card's existing rule decides whether a kit `goal-blocked` event is outstanding for a plan: the latest event for a root and a plan name, cleared by a later `goal-complete` or by the plan document's mtime moving past the event. That rule lives in `card.ts` as `blockedAt`, with `eventIndex` building the index it reads and the helpers `planName` and `eventPlanName`. Section 3 exports those four unchanged and applies the rule to an entry that has a parsed plan reading. An entry with no plan reading takes no event. The event reader is called with the configured roots first and the enabled personas' working folders after them. Because the reader keeps the first spelling that claims a folder, the status function first finds the root spelling the event state holds whose `comparablePath` equals `comparablePath(workdir)`. It then calls `blockedAt` with a reading whose `root` is that spelling. When no held spelling matches, the entry takes no event.

**The status word.** One pure function takes a persona's entries and readings and returns a word for each entry. The rules run in this order, and the first that matches wins.

| Order | Word | Holds when |
|---|---|---|
| 1 | not drawn | the entry's `kind` is `root`, or its store status is `abandoned`. Such an entry is removed before any other rule sees it, and it is not counted |
| 2 | done | the entry's store status is `complete`, or its plan reading's `terminal` is true, or its plan was found only in an archive folder |
| 3 | blocked | a kit `goal-blocked` event is outstanding for the entry's plan, or the entry's `lead.state` is `blocked`, or the store status is `blocked` and `blockedReason` is anything other than exactly `Max rounds reached` |
| 4 | stalled | the store status is `paused` and `pausedByNudgeCap` is true |
| 5 | in flight | among entries not yet matched, the one whose plan reading's status equals `In Progress` and whose document has the newest mtime, a tie going to the earlier entry in queue order. When no entry has such a reading, the entry `activeGoalId` names, if it is not yet matched |
| 6 | started, parked | any other unmatched entry whose plan reading's status equals `In Progress` |
| 7 | up next | the first unmatched entry in queue order, wherever the in-flight entry sorts |
| 8 | queued | every remaining entry |

`terminal` is the existing `PlanParse` field. A plan reading's status equals `In Progress` when it matches those two words as the whole value, ignoring case. Queue order is ascending by key. Each entry's key is its own `sortKey` when it has one, else its own `createdAt`, and keys compare as numbers. A store status of `blocked` with the reason `Max rounds reached` falls through rule 3 on purpose, so that entry is judged by rules 5 to 8 like any other. That reason is compared on the trimmed, case-folded value, the way every other store string here is compared, because a spelling that differs from the plugin's by a trailing space or a capital is the same bookkeeping. A reason draws only on an entry whose word is blocked. It is `lead.reason` when the lead is blocked, else the store's `blockedReason` when the store's own block is the block, and an entry blocked by an event alone draws none. The store's reason is withheld on a block found by another route, because an entry the round limit marked could otherwise hand that exact string to a block the event found.

The worker's state, for the label, is `running now` while the heartbeat's `turnStartedAt` is a number. Otherwise it is `idle <span>` measured from `monitor.lastTurnComplete` with the existing `span` formatter, or `idle` alone when that stamp is absent. The heartbeat is read first: `running now` wins over everything, and `nothing started` replaces only the two `idle` forms, when no entry is in flight. The done count is the number of done entries, and the total is every entry that rule 1 does not remove.

**The layout.** Persona groups draw before project groups, in roster order. A persona with no entries left after rule 1 draws nothing. Each group opens with the existing one-line fenced label. It holds the persona's name cut at 60 characters, the counts, the worker's state, and `held <span>` when the store's reading is a held one. Full entries follow in this order: the in-flight entry, the up-next entry, then every blocked, stalled and parked entry in queue order. A full entry is a bold title bullet and one facts sub-bullet holding the word, the sections count where a plan reading exists and is not `0/0`, and the reason on a blocked entry. The in-flight entry's word reads `in progress`, and it also takes the existing `next:` sub-bullet. Every queued entry folds into one closing bullet, `then: <title>, <title>, +N`, which names as many titles as fit in 200 characters. Done entries appear only in the count. Titles are cut at 60 characters, and at 40 inside the `then:` line. A blocked reason is cut at 120. Every field passes through the existing `inertField` escape, and the label through `inertBlockField`.

This fixture and this body are the reference for the layout. Persona `dev-plugin`, heartbeat not in a turn, last turn completed 12 minutes before now, and six entries in queue order:

| Title | Store status | Plan reading |
|---|---|---|
| Fleet coordinator seat | paused | `Ready`, 0 of 2 |
| Test-requirement axis | blocked, `Max rounds reached` | `In Progress`, 2 of 3, next `Section 3, the reviewer charters` |
| Memory database | paused | `In Progress`, 4 of 7, older mtime |
| Kaizen: messages wait too long | complete | none |
| Reviewer re-ranking | blocked, `Waiting on two operator forks` | `Ready`, 3 of 8 |
| Prose register | paused | `Ready`, 0 of 4 |

```
dev-plugin · 1 of 6 done · idle 12m
- **Test-requirement axis**
  - in progress · 2/3
  - next: Section 3, the reviewer charters
- **Fleet coordinator seat**
  - up next · 0/2
- **Memory database**
  - started, parked · 4/7
- **Reviewer re-ranking**
  - blocked · 3/8 · Waiting on two operator forks
- then: Prose register
```

The first line above is the content of the fenced label. The group composes against the card's existing 1,900-character budget. In the overflow tail, an undrawn queue entry counts as a plan and an undrawn persona group counts as a project, so the tail keeps its form, `(+N plans, +M projects not shown)`. Persona groups spend the budget first, so a large fleet can push project groups into the tail.

**The build gate.** Today the card is not built when the project list is empty (`broker/board/thread.ts:246-252`). After this plan it is built when the feature knob is on, Discord is configured, and at least one of the two sources is set. With neither set it builds nothing and logs once: `board card: neither project roots nor a roster is configured, the card is not built`.

**The sweep.** Searches run on trunk `0d97205`: the four `CHANNEL_BOARD_*` names, `boardCard|BoardPlan|PlanReading|BoardCardOptions|renderBoardCard`, `comparablePath|inertField|inertBlockField|MAX_CARD_LENGTH`, `Fleet: Board|NOTHING_OPEN|boardCardWiring|permanentCards`, and `board|plan doc|trust|path` in the security model. Surfaces found: `broker/config.ts` and its test; `install/Install-Functions.ps1:588-591`, the installer's setting allowlist, pinned by `install/Install-Functions.test.ts:875-878`; `broker/board/card.ts`, `plans.ts`, `thread.ts`, `events.ts` and their tests; `broker/index.ts:652-680` and `:1476-1498` with `broker/index.test.ts`; `docs/architecture.md:505-620`; `docs/operations.md:430-473` and `:897-900`; `docs/install.md:56-62`; `docs/security-model.md:619-660` and `:688-692`; `docs/backlog.md:142-160` and `:193-216`. The root `README.md` and `docs/operator-checks.md` name nothing about the card. No env template exists.

## Sections of Work

### 1. The roster setting and the roster reader
Model: sonnet

`CHANNEL_BOARD_ROSTER` is parsed in `broker/config.ts` beside `CHANNEL_BOARD_PROJECTS`, as one absolute path or empty. A value that is not absolute throws at load, as a bad project root does. The installer's allowlist gains the name. `namesOneDirectory` in `broker/config.ts` is exported. A new module `broker/board/roster.ts` reads the roster file with a 64 KiB cap, holds its last good reading on a read or parse failure, and returns the enabled personas as `{ name, workdir }` in file order. An entry yields a persona only when its `enabled` is exactly `true`, its `name` is a non-empty string not already taken by an earlier entry, and its `workdir` is absolute and passes `namesOneDirectory`. The module keeps at most 16 personas, logs the number it dropped once per change, and never logs a `workdir`.

Acceptance:
- A roster with five enabled entries yields five personas in file order. An entry with `enabled: false`, and one with `enabled` absent, each yield none.
- A relative `workdir`, a missing `name`, a repeated `name` and a non-array file each yield no persona from that entry or file and no throw.
- A roster that parsed last tick and does not parse this tick yields last tick's personas.
- `CHANNEL_BOARD_ROSTER=relative\path` fails config load with a message that does not echo the value.
- The installer's allowlist test names five board settings.

Files in scope: `broker/config.ts`, `broker/config.test.ts`, `broker/board/roster.ts`, `broker/board/roster.test.ts`, `install/Install-Functions.ps1`, `install/Install-Functions.test.ts`, `broker/index.test.ts`, `broker/intake.test.ts`, `broker/intake.ts`.
Tests: lock the held reading on a torn roster, because a roster mid-save must not blank the card. Lock the refusal of a non-absolute `workdir`, because that value becomes a read path.

### 2. The queue, heartbeat and plan readers, and the join
Model: opus

A new module `broker/board/queues.ts` takes the personas from Section 1 and returns, for each, its entries in queue order, its heartbeat turn state, its `monitor.lastTurnComplete`, a plan reading or none for each entry, and the instant its store reading began to be held, or null. A plan reading is the existing `PlanReading` with `root` set to the persona's `workdir`, plus an `archived` flag. A name found only in an archive folder yields the flag and no parse. It reads the store and the heartbeat with a size cap of 2 MiB, holds each on mtime and size, and keeps the last good reading when a read or a parse fails. It keeps at most 200 entries per persona. The join follows the Approach exactly. The capped file read in `plans.ts`, `readPlanFile`, is exported for it, so a plan document opened through the join takes the same 256 KiB cap and the same failure classes as a swept one.

Acceptance:
- An entry whose `objective` holds `Finish docs/plans/a_b_v1.md, which lives on a branch` joins to `<workdir>/docs/plans/a_b_v1.md`. So does one whose text ends `docs/plans/a_b_v1.md.` with a full stop.
- When that file is absent and `<workdir>/docs/archive/a_b_v1.md` exists, the join reports the plan as archived.
- An entry carrying `planPath` uses it in preference to its text.
- A name that fails the pattern, a name of `README.md`, and an entry naming no plan each yield no reading and open no file.
- With `planPath` set to `..\..\secret.md` or to an absolute path ending in `secret.md`, the only paths the join tries are `secret.md` under the four places inside `workdir`. No path outside `workdir` is opened or statted.
- A store that fails to parse this tick yields last tick's entries and the instant the hold began. A store with no key for the persona yields no entries and no error.

Files in scope: `broker/board/queues.ts`, `broker/board/queues.test.ts`, `broker/board/plans.ts`, `broker/board/plans.test.ts`.
Tests: lock the join in both directions: a live-shaped text with trailing punctuation opening the right file, and a crafted name opening nothing outside the four places. Lock the held reading on a torn store. The guard's worst case is sized in the Intent.

### 3. The status word
Model: opus

Export `blockedAt`, `eventIndex`, `planName` and `eventPlanName` from `broker/board/card.ts` with no change in behavior. A new module `broker/board/status.ts` exports one pure function implementing the Approach's table, the blocked-event lookup and the worker's state. It takes one persona's `workdir`, entries, readings, heartbeat state, the event reader's state and the current time. It returns each entry's word and reason, the group's done and total counts, and the worker's state. It reads no file and no clock of its own, and its output type carries no store status string.

Acceptance, one case per row of the table and these besides:
- A store status of `blocked` with `blockedReason` exactly `Max rounds reached`, whose plan reads `In Progress`, is in flight.
- A store status of `paused` with `pausedByNudgeCap` false and a reason the worker wrote is up next or queued, and its reason is not returned.
- Two entries whose plans read `In Progress`: the newer document is in flight and the other is started, parked. Two entries joined to one document: the earlier in queue order is in flight.
- No entry with an `In Progress` plan and `activeGoalId` naming any entry whose kind is not `root`: that entry is in flight. `activeGoalId` naming a root or a done entry: nothing is in flight, and the worker's state is `nothing started` with the heartbeat outside a turn and `running now` with it inside one.
- A store holding one `root` entry with status `complete` and nothing else returns no entries and a total of 0. An `abandoned` entry whose plan is archived is not counted as done.
- An event recorded under the root spelling `D:\personas\dev` marks an entry of a persona whose roster `workdir` is `D:/personas/dev`.
- For every case in this suite, no returned word or reason contains `paused`, `pending` or `Max rounds`, given stores that hold all three.

Files in scope: `broker/board/status.ts`, `broker/board/status.test.ts`, `broker/board/card.ts` (the four exports only), `broker/board/queues.ts` (the `queueKey` export only).
Tests: every row of the table, plus the two misreadings this plan exists to remove: `paused` shown as not going to run, and a round-limit block shown as blocked. Lock the root-spelling match, since the live roster writes forward slashes.

### 4. The persona group in the renderer
Model: opus

`renderBoardCard` gains an input holding the persona groups and draws them ahead of the project groups under the Approach's layout. That input carries the status function's output, words and reasons and counts, beside each entry's title and plan reading. The tick in `thread.ts` calls the status function, and `card.ts` never imports `status.ts`. The project groups and every existing marker draw exactly as before. The persona groups spend the same running budget and feed the overflow tail as the Approach states. The empty-card text draws only when neither view has anything to draw.

Acceptance:
- The Approach's fixture, passed through the status function, renders the Approach's body, line for line, inside a card that also holds the title and footer.
- The same fixture with the heartbeat inside a turn reads `running now` in the label. With the store held for five minutes the label ends `held 5m`.
- A title, a blocked reason and a persona name carrying markdown, a mention and a newline each render inert, by the existing escape tests' method.
- A fixture large enough to overflow ends in the tail, counts undrawn entries as plans and undrawn groups as projects, and keeps the whole card at or under `MAX_CARD_LENGTH`.
- With no persona input, every existing card test passes unchanged.

Files in scope: `broker/board/card.ts`, `broker/board/card.test.ts`.
Tests: lock the budget with persona groups present, because a card over Discord's limit fails to post at all. Lock the reference body, because it is the layout the operator approved.

### 5. Wiring, the build gate, and the documents
Model: sonnet

`BoardCardOptions` gains the roster path and the two new readers as injectable seams, as `sweep` and `readEvents` are today. `createBoardCard` builds when either source is set and logs the Approach's message once when neither is. `boardCardWiring` passes the new setting through. The tick reads the roster, then the queues, then the events, then calls the status function for each persona, then sweeps the projects, and passes both views to the renderer. The event reader receives the configured roots first and the enabled personas' working folders after them. The reader is incremental and drops an event whose project matches no root it was handed, so when the set of roots handed to it changes, the tick resets the reader's state and the stream is read again from its start.

The documents state the card as it then behaves. `docs/operations.md` gains the setting in its table and the persona view in the board card's section, with the status words and what each means. `docs/architecture.md` describes the second source and its readers. `docs/install.md` names the new setting where it names the other two. `docs/security-model.md:619-660` is rewritten to state the rule as it then stands: a roster folder is trusted as configuration, a persona's store contributes a file name only, the pattern and the four places are the whole of the join, and the risk is sized as the Intent sizes it. `docs/backlog.md` drops or amends any item this plan overtakes.

Acceptance:
- With the roster set and the project list empty the card is built and draws persona groups only. With both empty it is not built, and the log carries the Approach's message once. The pin on the old message in `broker/board/thread.test.ts` moves to the new one.
- `broker/index.test.ts` drives one tick through `boardCardWiring` with a fake store holding the statuses `paused`, `pending` and `blocked` with `Max rounds reached`, and asserts the posted body holds a persona group and none of the strings `paused`, `pending` and `Max rounds`.
- A `goal-blocked` event read on a tick before a persona was enabled marks that persona's entry on the first tick after it is enabled.
- Each of the four documents names `CHANNEL_BOARD_ROSTER`. The security model states the four points above and no longer says that no field of a file the card reads is ever used as a path. `docs/backlog.md:193` names the roster as the other way to turn the card on.

Files in scope: `broker/board/thread.ts`, `broker/board/thread.test.ts`, `broker/index.ts`, `broker/index.test.ts`, `docs/operations.md`, `docs/architecture.md`, `docs/install.md`, `docs/security-model.md`, `docs/backlog.md`.
Tests: lock the build gate in both directions, because a card that silently fails to appear is the failure the old gate would have produced. Lock that raw store words never reach a posted card.

## Related plans

- `agent_persona` repository, `docs/plans/agent_persona_plan-health-from-the-record_v1.md`: makes the persona plugin itself judge a plan from its document, and adds the `planPath` and `lead` fields this card reads when present. Neither plan waits on the other. Until that one lands, the join uses the text match and no entry carries a `lead`.
- [channels_board-card_spec_v1.md](../archive/plans/channels_board-card_spec_v1.md): the card's first plan. It listed a session-to-plan join as a non-goal, which this plan reverses for persona queues, and it set the no-model rule this plan keeps.
- [channels_board-markdown_spec_v1.md](../archive/plans/channels_board-markdown_spec_v1.md): the card's live-markdown layout, which the persona groups follow.

## Out of Scope

- The folder view's behavior, its sort order and its markers.
- `broker/board/events.ts` and `broker/board/binding.ts`. The event reader is called with more roots and is not changed.
- The usage card, the pin list and `broker/discord/render.ts`.
- Any change in the `agent_persona` repository.
- Reading a plan document from a branch that is not checked out, reading personas on another machine, and any write to a persona's files.
- An "offline" word for a worker that is not running. A worker that has stopped draws as `idle` with a growing span.
- The root `README.md` and `docs/operator-checks.md`, which name nothing about the card. `docs/README.md` and `docs/plans/README.md` change only at this plan's own close-out.

## Assumptions

- assumed 2026-09-20 (default): the plan name is found by the Approach's text match until the persona plugin stores it as a field, and the field wins when present; reversal: a few lines in Section 2.
- assumed 2026-09-20 (source: both workers' pause reasons in their stores, which name branch checkouts inside the roster `workdir`): the copy of a plan document checked out in the worker's folder is the live copy of the plan in flight, and a plan parked on another branch can under-report its sections count; reversal: reading other branches needs a git process in the refresh loop.
- assumed 2026-09-20 (source: the operator's ruling that a worker's "paused" means "not now"): a paused entry draws as up next or queued even when its free-text reason says it waits on the operator. What is blocked reaches the card through a kit blocked event, a store block that is not the round limit, a stall, or the `lead` field; reversal: a rule over free text, which this plan refuses.
- assumed 2026-09-20 (source: `docs/archive/` in agent_persona and claude-kit, `docs/archive/plans/` in discord-channels, `docs/plans/archive/` holding two older plans in agent_persona): a completed plan is found in one of three archive shapes; reversal: one more entry in the closed list of places.
- assumed 2026-09-20 (default): the caps are 64 KiB for the roster, 16 personas, 200 entries per persona and 2 MiB per store; the largest live store measured 170 KB; reversal: four constants.
- assumed 2026-09-20 (source: `bin/Register-PersonaTasks.ps1:143-149` in agent_persona, which requires `enabled` to be a JSON boolean): a persona counts only when `enabled` is exactly `true`; reversal: one comparison.

## Operator Verification

- Set `CHANNEL_BOARD_ROSTER` to the fleet roster's path, leave `CHANNEL_BOARD_PROJECTS` as you prefer, and restart the broker. Read the card on a phone. Ask each worker what it is on and what is next. The work reopens if a worker's answer and its group disagree, or if the words `paused` or `Max rounds` appear anywhere on the card.

## Open Questions

None.

## Chapters

### Interim board 1 - 2026-09-20

Written on the compaction gate's deferral nudge, at the adjudication of section 1's first review
round. Not a Chapter: section 1 is still open.

**Section stages.** Section 1 is built, reviewed once, and in fix round 1. Sections 2 to 5 are not
started.

**Live dispatches.** One `implementer-sonnet` holds `broker/config.ts`, `broker/config.test.ts`,
`broker/board/roster.ts` and `broker/board/roster.test.ts`, applying the seven adjudicated fixes
listed below. Round 1's three reviewers have all returned.

**Gate baseline.** Measured on this branch at `4152f79` with a clean worktree, before section 1's
first round: whole suite 1721 tests, 1720 pass, 0 fail, 1 skipped, exit code 0, 34.1 s wall clock;
lint (`tsc --noEmit`) exit code 0. After section 1's first round, reported by its implementer and
not yet re-run here: 1733 tests, 1732 pass, 0 fail, 1 skipped. The targeted lane over
`roster.test.ts` alone, run here: 11 tests, 11 pass, exit code 0.

**Header normalization.** This run set `Status:` from `Ready` to `In Progress` at its start. Carried
into chapter 1 when section 1 closes.

**Scope drift so far.** Section 1's `Files in scope:` is widened by two files, `broker/index.test.ts`
and `broker/intake.test.ts`. Each builds a whole `BrokerConfig` object literal, so the new required
field broke the type check until each gained one line. Folded rather than made a section of its own:
same directory as a file the section already changed, no acceptance criterion of its own, and covered
by the gate the section was going to run.

**Rulings adopted since the last boundary.** Round 1 returned no Critical, seven owed Majors and ten
Minors across three lenses. All seven Majors enter fix round 1: the non-array roster returning the
held reading rather than none; a byte-cap test that passes with the cap deleted; a doc comment
asserting a path-safety property the plan's own join contradicts; a config refusal message
byte-identical to the events-path refusal, so a failed start names no setting; read and parse
failures logged nowhere, making a mistyped roster path indistinguishable from an empty fleet; an
untrimmed and uncapped persona name held across ticks; and a `workdir` naming a UNC root.

The UNC refusal is the one ruling worth flagging. It narrows a trust this plan's Approach states in
the sentence "A roster `workdir` is trusted the way a configured project root is trusted". The
narrowing was taken rather than referred, on three grounds: the guard already exists in this
repository at `broker/intake.ts:321-331` for a file-supplied path, so this is reuse rather than a new
mechanism; the live roster's five entries all use drive-letter paths, so nothing in use breaks; and
the Intent's own sizing paragraph keeps a guard that is nearly free. Reversing it is one predicate.
Named to the operator rather than left in this document alone.

The security lens's dependency advisory is not a finding against this section. `docs/backlog.md:444`
already carries that item, parked 2026-09-07. That entry says two advisories where `npm audit`
now reports three, so its count is stale; amending it belongs to section 5, which already opens that
file.

**Next action per section.** Section 1: read the fix round's diff, run the close gate, run the one
lens the fix delta owes, take the Minor close pass, write chapter 1. Sections 2 to 5: not started.

### Interim board 2 - 2026-09-20

Written on the closure drought: two review-round adjudications have now passed with section 1 still
open. Not a Chapter.

**Section stages.** Section 1 is built, reviewed twice, and in review round 3. Sections 2 to 5 are
not started.

**Live dispatches.** One adversarial reviewer at sonnet, effort high, over the round-2 fix delta.
It was asked to judge the UNC guard convergence described below, and in particular whether widening
this section into `broker/intake.ts` breaks any caller that previously passed that module's guard.
Round 2's own lens has returned.

**Gate baseline.** Measured on this branch at `2c684ed` with the section's nine files dirty and no
foreign process holding the box, after round 1's fixes and before round 2's: whole suite 1737 tests,
1736 pass, 0 fail, 1 skipped, exit code 0, 35.7 s wall clock; lint (`tsc --noEmit`) exit code 0. The
branch baseline it is a delta against, measured at `4152f79` on a clean worktree, was 1721 tests,
1720 pass, 0 fail, 1 skipped, exit 0, 34.1 s. So the section has added 16 tests and broken nothing.
The targeted lane after round 2's fix, over `roster.test.ts`, `intake.test.ts` and `config.test.ts`:
97 tests, 97 pass, exit code 0.

**Rulings adopted since the last boundary.** Round 2 returned one Critical and no Major. It is
fix-introduced: fix round 1's own UNC refusal was written as a fresh pattern matching only the two
homogeneous two-separator spellings, `\\` and `//`. Windows resolves any two leading separators as a
share root, so the mixed spellings `/\host\share` and `\/host/share` passed the guard while
`path.win32.normalize` collapsed all four to the same share. The guard refused exactly the inputs its
own test named and admitted the ones it did not. Confirmed here by running the real exported
functions rather than by reading: both mixed forms returned true from `namesOneLocalDirectory` and
normalized to `\\host\share\dir`.

Two things follow, and the second is a correction to interim board 1. First, the fix is now a shared
pattern rather than a fourth copy: `broker/config.ts` exports `UNC_ROOT = /^[\\/][\\/]/`, over the
separator class the way `WINDOWS_ROOT` already did, and `namesOneLocalDirectory` uses it. Second,
interim board 1 recorded that the UNC narrowing was "reuse rather than a new mechanism" because the
guard "already exists in this repository at `broker/intake.ts:321-331`". That ground was weaker than
stated. `transcriptPathField` there is unexported, independently written, and carried the same
mixed-separator hole: a `transcript_path` of `/\host\share\x.jsonl` posted to the broker's intake
passed it and would have been opened. That is confirmed by a test watched failing before the fix. The
narrowing was a new mechanism when it was taken, and it is genuine reuse only now that both call
sites share one exported pattern.

**Scope drift since the last boundary.** Section 1's `Files in scope:` gains `broker/intake.ts`
alongside the two test fixtures already folded. The out-of-scope route forbids parking a security
finding of Critical or Major weight whatever its scope: it is fixed before the section closes or
raised to the operator. Fixing was chosen because the change makes an HTTP-facing guard strictly more
refusing, the whole suite covers it, and leaving two divergent copies of one boundary check is what
produced the defect. Named to the operator rather than left in this document alone.

**Commit state at this boundary.** The plan doc is committed here; the section's code is not. The
first-green commit is deliberately held until round 3 returns, because that round's brief names
`2c684ed` as its base and states the code is unstaged, and moving HEAD under a reading reviewer would
blind it. The code commits with chapter 1.

**Next action per section.** Section 1: adjudicate round 3, take the Minor close pass over the seven
surviving Minors, run the close gate, write chapter 1, and make the first-green and close commits
together. Sections 2 to 5: not started.

### Chapter 1 - 2026-09-20
Completed: 1. The roster setting and the roster reader
Implemented By: implementer-sonnet, no escalation
Metrics: review rounds 3, closed clean; provenance 6 spec-traceable, 1 fix-introduced, 1
new-requirement, rulings (0 refused, 0 declared, 0 asked); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:

- Builds the `CHANNEL_BOARD_ROSTER` setting and a reader turning the fleet roster into a list of
  enabled personas. Serves the Goal sentence "the pinned `Fleet: Board` card can draw one group per
  worker persona on this machine" and Section 1's own acceptance bullets. Adds no mechanism the spec
  does not name. Size: the section as specified, roughly 150 lines across two new files and three
  edits. Not building it leaves the card with no source of personas at all.
- A parsed non-array roster yields no persona and clears the held reading, rather than returning the
  held one. Serves the acceptance bullet "a non-array file each yield no persona from that entry or
  file". Adds no mechanism: it narrows an existing branch. Size: 2 lines. Not fixing it means an
  operator who rewrites the roster into an object keeps seeing the old fleet drawn forever, with the
  previously enabled workdirs still opened every tick.
- The byte-cap test's padded file carries a second distinct enabled persona, so the assertion changes
  when the cap is not enforced. Serves the acceptance bullet "reads the roster file with a 64 KiB
  cap" by making the check able to fail. Adds no mechanism. Size: 1 line. Not fixing it leaves a test
  that stays green with the cap deleted.
- The `boardRosterPath` doc comment states what is true of the join: the persona store contributes a
  validated file name and never a path, and `workdir` is the only path input trusted as
  configuration. Serves the Approach sentence "The broker takes a file name only". Adds no mechanism.
  Size: 4 lines of comment. Not fixing it ships a false path-safety claim into the file whose wording
  Section 5 copies into the security model.
- The `CHANNEL_BOARD_ROSTER` refusal names the setting. Serves the acceptance bullet
  "`CHANNEL_BOARD_ROSTER=relative\path` fails config load with a message that does not echo the
  value". Adds no mechanism. Size: 1 line. Not fixing it means a broker refusing to start logs a
  message byte-identical to the events-path refusal, so the log cannot say which knob to fix.
- Every roster read or parse failure logs once per change. Serves the Goal sentence "The operator can
  tell from a phone what is running", since a card drawing nothing must say why. Adds a mechanism,
  a second use of the existing once-per-change log seam the section already builds for the cap drop.
  Size: about 10 lines. Not fixing it makes a mistyped roster path indistinguishable from an empty
  fleet, with nothing written anywhere.
- A persona `name` is trimmed before the non-empty check and refused past a length cap. Serves the
  acceptance bullet "its `name` is a non-empty string". Adds a mechanism, a length cap, mirroring
  `MAX_INTAKE_STATUS_LENGTH` in `plans.ts`. Size: 3 lines and one constant. Not fixing it lets a
  64 KiB name be held across every tick and drawn into the card's budget, and lets a whitespace name
  draw a blank group heading.
- A roster `workdir` naming a UNC root is refused. Serves Section 1's Tests line, "Lock the refusal
  of a non-absolute `workdir`, because that value becomes a read path", read at its stated reason
  rather than its literal. Adds a mechanism, a UNC refusal. **This narrows a trust the Approach
  states**: "A roster `workdir` is trusted the way a configured project root is trusted." Size: 3
  lines plus the comment. Not fixing it lets one line in a file any process running as the operator
  can rewrite make the broker open `\\attacker\share` every refresh under the operator's own
  identity, which is the forced-authentication primitive `broker/intake.ts:328` already refuses for
  the transcript path. No live roster entry uses a UNC workdir, so the refusal breaks nothing today.

Three surprises beyond those lines. The header read `Ready` at this run's start and was normalized to
`In Progress`, recorded here as the deliberate change it was. The UNC narrowing's own first fix was
written as a fresh pattern matching `\\` and `//` alone, which admitted the mixed spellings, and
round 2 caught it; interim board 2 carries that account and the correction to interim board 1's
overstated reuse ground. And the same mixed-separator hole was found in `transcriptPathField` in
`broker/intake.ts`, an HTTP-facing guard, which is why that file joined this section's scope.

Assumptions: none beyond the plan's own `## Assumptions` section. Every gap this section met was
answered by an acceptance bullet or by the Approach.
Review Findings: `review: code pair + security at opus, Workflow` for round 1 over a sonnet writer;
`review: adversarial at sonnet, Workflow` for rounds 2 and 3. Round 1: no Critical, 7 Majors, 9
Minors. All 7 Majors fixed. Round 2: 1 Critical, fix-introduced, fixed before close under the
carve-out that keeps a Critical off the hold-and-bucket route; its trace was orchestrator-made for
the blind lens. Round 3: APPROVED, no Critical, no Major, 1 Minor. No finding was held and no judge
was convened: the one new-requirement finding, the UNC refusal, is a security Major, which the
out-of-scope route sends to fix-before-close rather than to a bucket. Minors: 2 fixed in fix round 1,
4 fixed in the close pass, 4 left with the reason, 0 upgraded. The four left: the capped-read loop
duplicating `readPlanFile`, which Section 2 exports and converges; dedup on `name` rather than on the
comparable `workdir`, which is what the section's own acceptance bullet specifies, so changing it
would add an unasked mechanism; no checked-in roster fixture pinning the parsed field names, declined
because a real roster's `workdir` values carry the operator's OS account name into the repository;
and round 3's platform Minor, that `UNC_ROOT` is not gated on `win32`, declined because gating it
would make a security guard conditional to admit a POSIX path with a literal backslash at its root,
which this Windows-targeted broker never sees. The close pass changed prose in four hunks only and so
owed no round; it took the author re-read in its place. One security-lens item was routed out rather
than fixed: three known-vulnerable transitive dependencies, pre-existing and untouched here, already
at `docs/backlog.md:444` whose stale advisory count Section 5 amends.
Stamps: adjudicated 8, stamped 3. Stamped `a-model-override-the-account-cannot-serve-never-runs` and
`a-self-stamped-liveness-field-cannot-establish-exit`, both of which steered how the dispatches were
placed and how a quiet agent was read, and `node-test-count-lines-are-not-tap`, which turned out to
own the reporter-marker trap this run hit twice when a grep over suite output returned nothing. The
remaining 5 were read in the window and did not change what was built.
Gate: targeted lane owed at this close; the whole gate run instead, since it covers the targeted lane
and the box allowed it. No contention lane: the section's delta touches config parsing, a roster
reader and two path guards, none of them machine-shared state. Measured on SCOTT-CLAUDE at
2026-09-20T20:29-0400, on this branch at `854adba` with the section's nine files dirty. Whole gate
1737 tests, 1736 pass, 0 fail, 1 skipped, exit code 0, 35 s wall clock; lint (`tsc --noEmit`) exit
code 0. Against the branch baseline at `4152f79` on a clean worktree, 1721 tests, 1720 pass, 0 fail,
1 skipped, exit 0, 34.1 s: 16 tests added, 0 failing to 0 failing. Contention reading: contended. A
live heavy-process claim stood on the box throughout, held by session DEV-PLUGIN running a sequence
of whole gates in `D:/personas/dev-plugin/repo`. A process poll taken before this run found no suite
and read the claim as residual; its holder corrected that on the relay, saying the poll landed
between two legs of its sequence. The wall clock landing within 0.7 s of an earlier uncontended
baseline suggests light overlap, but the run is recorded as contended rather than reasoned clean from
timing. The claim was neither written nor deleted by this session. Test delta: 16 added, 0 retired, 2
edited to stay green on this section's own change, so no retire class applies. Of the added, 15 in
`broker/board/roster.test.ts` pin the reader's contract, one per acceptance bullet plus the failure
classes: file order and enabled-true-only, a non-boolean truthy `enabled`, a relative `workdir`, a
missing `name`, a repeated `name`, a non-array file clearing rather than holding, a torn write
holding, an unreadable file, the byte cap, the persona cap with its once-per-change log, the three
distinct failure-class logs, the name trim and length cap, and the UNC refusal over all four
separator spellings with the general rule as its withheld control. The 16th, in `broker/config.test.ts`,
pins that the setting has no default location, refuses a non-absolute value, and never echoes the
value in its refusal. The 2 edited: the existing UNC test in `broker/intake.test.ts` gained the two
mixed spellings, and the installer allowlist pin in `install/Install-Functions.test.ts` moved from
four board settings to five. Two `BrokerConfig` object literals in `broker/index.test.ts` and
`broker/intake.test.ts` each gained one field to keep the type check green. Added tests that spawn a
process, directly or through a shared helper: 0.
Next: 2. The queue, heartbeat and plan readers, and the join
Commit Model: Branch-and-PR
Delta: measured on SCOTT-CLAUDE at 2026-09-20T20:30-0400, worktree at `854adba` with the section's
nine files dirty.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 3 - 2026-09-20

Written on the compaction gate's deferral nudge, with section 2's first review round part-returned.
Not a Chapter: section 2 is still open.

**Section stages.** Section 1 is closed, committed at `44aa3e8` and pushed. Section 2 is built,
verified by this session's own gate run, reviewed once by all three lenses, and entering fix round 1.
Sections 3 to 5 are not started.

**Live dispatches.** Three reviewers over section 2's delta, all at fable on the Agent tool, none
permitted to build or run a suite because a sibling session holds the box. The blind lens has
returned APPROVED_WITH_CONCERNS, six Minors and no Critical or Major. The security lens has returned
CLEAR, four Minors and no Critical or Major, recording the path pattern, the expression over
untrusted text, the deserialization, the caps, the logging and the absence of any write as checked
and clean. The adversarial lens has returned CHANGES_REQUIRED, five Majors, six Minors and no
Critical. No dispatch is live at this boundary; the fix round is dispatched next.

**Gate baseline.** Measured on this branch at `44aa3e8` with section 2's four files dirty, while a
sibling session held a live heavy-process claim, so contended: targeted lane over
`queues.test.ts` and `plans.test.ts` 47 tests, 47 pass, 0 fail, exit code 0; lint (`tsc --noEmit`)
exit code 0. The whole-gate figure this branch last recorded, at `854adba` and also contended, was
1737 tests, 1736 pass, 0 fail, 1 skipped, exit 0, 35 s. No whole gate has run since section 2's
delta landed.

**Rulings adopted since the last boundary.** Section 1 closed with its chapter, and the plan's
`Files in scope:` for that section already carries the three folded files. Section 2's implementer
returned DONE_WITH_CONCERNS with four add-decision lines, all of which serve acceptance bullets and
none of which adds a mechanism no clause names, so no design stop fired. Two of the blind lens's six
Minors are confirmed here against the code rather than taken on report. The first is a suffix-case
disagreement: `plans.ts` matches `.md` case-insensitively and sweeps `SPEC_V1.MD` as a plan, while
`queues.ts`'s name pattern is case-sensitive and refuses it, so one module draws a file the other
will not join. The second is that a store which stays unreadable, unparseable or over the 2 MiB cap
is re-opened and fully read every tick, because the failure path never records the stat it failed
at, where `plans.ts` holds one through `heldFailure`. That second one is being upgraded from Minor
to Major at adjudication on a stated consequence and a trace: the Approach says the store is "held
on mtime and size like a plan document, so an unchanged file is not parsed again", and an unchanged
failing store is re-read regardless.

A third finding, from the security lens, is upgraded the same way and confirmed here by tracing every
use of the map: the join builds a fresh per-tick parse map, writes it, and never reads it, taking its
hold from the previous tick's map alone. So two entries naming one plan document both read and parse
that document inside one tick whenever it has moved, up to two hundred times per persona, on the
broker's only event loop. Section 3's own acceptance bullets make two entries sharing one document a
specified case rather than an exotic one, and the join's docstring already claims the folding this
defeats. The fix is one line, reading the in-tick map before the held one.

The adversarial lens then raised the unheld failing store independently, which is corroboration
rather than a second finding and confirms the upgrade was right. Fix round 1 carries six owed Majors,
every one of them spec-traceable, none fix-introduced and none new-requirement, so no finding is held
and no judge is convened. They are: a plan document's parse dropped rather than held on a tick where
it fails to read or parse, against the Approach's "keeps its last good reading, as the card already
does for a plan document mid-write"; the store and heartbeat failures not held on their stat, against
"holds each on mtime and size"; the in-tick parse map written and never read; an empty-string
`planPath` yielding neither a reading nor the text fallback, against "when the entry has one"; and
two test-strength Majors, that nothing can go red if the title-before-objective search order is
swapped or the no-fallback rule is reversed, and that the README refusal is tested only against the
literal it already matches, so a case-sensitive rewrite of it would keep the suite green while
`docs/plans/readme.md` drew as a plan. That last one is the same defect class as section 1's
Critical, found a second time in this plan, which is what the recurrence rule exists for.

No fix on that list adds a mechanism no clause names, so no design stop fires. The suffix-case
disagreement stays a Minor for the close pass.

**Surfaces routed out, pending one write.** Three, adjudicated and awaiting a single
`docs/backlog.md` entry written after the round so that shared file is touched once. A confirmed
defect at `broker/usage/cache.ts:270-281`, which reads its capped file with a single `readSync` and
no loop where the three sibling readers all loop, so a short read hands the parser a prefix of the
file as the whole; it fails closed, since truncated JSON does not parse. The capped-read loop now
standing in four copies, whose remedy is one module owning a parameterized `readCapped`. And three
helpers in `plans.ts` left unexported, so `queues.ts` carries its own stat wrapper, stem function
and README check.

**Next action per section.** Section 2: dispatch fix round 1 to `implementer-opus` over the six owed
Majors, then run the one lens the fix delta owes (it adds no module and reaches no outward action,
but it reaches the path-join surface, so the adversarial lens runs at opus through Workflow), then
the Minor close pass, the close gate, chapter 2, the routed-out backlog entry, and the commit.
Sections 3 to 5: not started.

### Interim board 4 - 2026-09-20

Written on the closure drought: two review-round adjudications have now passed with section 2 still
open. Not a Chapter.

**Section stages.** Section 1 is closed, committed at `44aa3e8` and pushed. Section 2 is built,
reviewed twice, fixed once, and in fix round 2. Sections 3 to 5 are not started.

**Live dispatches.** One `implementer-opus` holds this section's four files, applying the three
adjudicated fixes below. Review round 2's single lens has returned.

**Gate baseline.** Measured on this branch at `3519aae` with section 2's four files dirty, on a box
carrying no foreign claim, after fix round 1 and before fix round 2: targeted lane over
`queues.test.ts` and `plans.test.ts` 55 tests, 55 pass, 0 fail, 0 skipped, exit code 0, 226 ms;
lint (`tsc --noEmit`) exit code 0. Measured by this session rather than taken from the implementer's
report. The lane's own prior baseline, at `44aa3e8` and contended, was 47 tests, 47 pass, 0 fail,
exit 0. So fix round 1 added 8 tests and broke nothing. No whole gate has run since section 2's
delta landed.

**Rulings adopted since the last boundary.** Fix round 1 landed all six owed Majors and its gate was
re-run here rather than taken on report. Review round 2 ran one adversarial lens at opus through
Workflow at effort high, per the reviewer-effort table's later-round row over an opus writer. It
returned CHANGES_REQUIRED with no Critical, four Majors and six Minors, and it confirmed fixes 5 and
6 as correct and adequately pinned.

Provenance on the four: one spec-traceable and three fix-introduced. None is new-requirement, so no
finding is held and no judge is convened. No fix adds a mechanism no clause names, so no design stop
fires.

The reversal is the ruling worth finding in history. Fix round 1's brief carried an explicit
acceptance clause, written by this session, saying a held plan parse is handed back under the
current tick's modification time and size, on the reasoning that the card's downstream rules compare
document modification times. That clause was wrong. `broker/board/thread.ts:497-507` redraws a held
parse under the held stat, not the current one, and this module was written to follow that card. The
consequence of the version shipped: a held parse's status is stale by definition, so a stale
`In Progress` wearing a fresh timestamp outranks a genuinely newer document under section 3's
in-flight rule, and the wrong entry draws as running with the wrong sections count and the wrong
next step, for as long as the failing document keeps failing. Confirmed here by reading the sibling
rather than taken on the reviewer's word. Fix round 2 reverses it to the held stat.

The second ruling is a deliberate divergence from that same sibling. Fix round 1's failure hold
records the failing stat for every terminal class, `unreadable` among them. On Windows a virus
scanner holding a file open returns that class for a file that is otherwise at rest, so the stat
never moves, the file is never opened again, and the persona's whole group freezes on its previous
reading forever. The fix records a failure stat only for the three classes the bytes at that stat
determine. `broker/board/thread.ts:441-447` holds `unreadable` the same way this stops doing, and
the divergence is taken rather than referred: the sweep's version freezes one row where this one
freezes a whole persona group.

The third is that the join holds a parse but holds no failure, so a document that cannot be read or
parsed is opened in full every tick forever, once per entry naming it. `thread.ts:220-228` states
that cost as the reason its own `HeldFailure` exists. The fix mirrors the `failedAt` slot fix round
1 already added for the store. That same fix closes the fourth Major, which is that fix round 1's
in-tick fold does not cover the failure path while its own docstring claims it does.

One half of a Major is declined on a positive ground. The reviewer asked for a held marker on each
plan reading so a stale row can be drawn as stale. The Approach's layout paragraph puts the held
marker at the group label and sources it from the store's reading, so a per-entry marker is a
mechanism no clause in this plan names. Carried forward to section 4, where the layout lands.

**Surfaces routed out, still pending one write.** Unchanged from interim board 3: the single-read
capped read at `broker/usage/cache.ts:270-281`, the capped-read loop in four copies, and three
`plans.ts` helpers left unexported. One `docs/backlog.md` entry, written after the rounds so that
shared file is touched once.

**Next action per section.** Section 2: read fix round 2's diff and re-run its gate here, then run
the one lens that delta owes, then the Minor close pass over the thirteen Minors now listed, then
the close gate, chapter 2, the routed-out backlog entry, and the commit. Sections 3 to 5: not
started.

### Chapter 2 - 2026-09-20
Completed: 2. The queue, heartbeat and plan readers, and the join
Implemented By: implementer-opus, no escalation
Metrics: review rounds 3, closed clean; provenance 7 spec-traceable, 3 fix-introduced, 0
new-requirement, rulings (0 refused, 0 declared, 0 asked); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:

- Builds `broker/board/queues.ts`, the reader turning one persona's store, heartbeat and plan
  documents into that persona's queue, and exports `readPlanFile` from `plans.ts` for it. Serves the
  Goal sentence "Each group lists that worker's queued plans in running order" and section 2's own
  acceptance bullets. Adds no mechanism the spec does not name. Size: the section as specified,
  roughly 520 lines of module and 60 tests. Not building it leaves the card with personas and no
  queues.
- A plan document's parse is held when a tick fails to read or parse it. Serves the Approach's
  "keeps its last good reading, as the card already does for a plan document mid-write". Adds no
  mechanism: the hold map already existed and this reads it on one more branch. Size: about 6 lines.
  Not fixing it blanks an entry's sections count and next step every time a worker saves the plan
  doc it is working from, which is precisely when the card is worth reading.
- A store or heartbeat failure is held on the stat it failed at. Serves the Approach's "holds each
  on mtime and size like a plan document, so an unchanged file is not parsed again". Adds a
  mechanism, a failure stat, mirroring `heldFailure` in `plans.ts`. Size: about 8 lines and one
  field. Not fixing it makes a broker pointed at a missing or oversized store read up to 2 MiB per
  persona per tick for as long as it runs.
- The join consults this tick's own parse map before the previous tick's. Serves the same hold
  sentence and the join's own docstring. Adds no mechanism: the map was already built and written.
  Size: 1 line. Not fixing it re-reads and re-parses one document once per entry naming it, up to
  200 times per persona, on the broker's only event loop.
- An empty or whitespace `planPath` is treated as absent so the text search runs. Serves the
  Approach's "From `planPath`, when the entry has one". Adds no mechanism: it narrows an existing
  branch. Size: 1 line. Not fixing it silently costs an entry its progress whenever the plugin
  writes the key before the value.
- The search order and the no-fallback rule gained tests that can fail. Serves the Approach's stated
  order and its "in both cases the kept name must match". Adds no mechanism. Size: 2 tests. Not
  fixing it leaves both rules green under a reversal.
- The README refusal gained cases that reach it. Serves the Approach's "must not be `README.md` in
  any case". Adds no mechanism. Size: 2 cases and a withheld control. Not fixing it is the same
  defect class as section 1's Critical.
- A plan document's failure is held on its stat, in-tick and across ticks. Serves the same Approach
  hold sentence read at what the card actually does: `broker/board/thread.ts:220-228` states this
  cost as the reason its own `HeldFailure` exists. Adds no mechanism no clause names, the clause
  naming the card's behaviour as the model. Size: about 15 lines and one map. Not fixing it costs a
  256 KiB read every tick forever for a plan doc with a malformed header, multiplied by every entry
  naming it.
- A held parse is handed back under the stat it was parsed at. Serves the same clause, read against
  `broker/board/thread.ts:497-507`. Adds no mechanism: two values change. Size: 2 lines. Not fixing
  it lets a stale parse wearing a fresh timestamp outrank a genuinely newer document under section
  3's in-flight rule, so the wrong entry draws as running with the wrong sections count.
- A failure stat is recorded only for the classes the bytes at that stat decide. Serves the Goal's
  "The operator can tell from a phone what is running". Adds no mechanism: it narrows a branch.
  Size: 1 predicate. Not fixing it lets one transient open failure on a resting store, a scanner's
  sharing violation being the live Windows shape, freeze a whole persona group forever.
- The store and heartbeat read is injectable, as `statPlan` and `readPlan` already were. Serves the
  acceptance that a refused open is retried on the next tick. Adds no mechanism that runs: absent
  the option the default is the function called directly before. Size: 5 lines and one `export`.
  Not building it ships that branch unexercised, because an open the operating system refuses cannot
  be staged from a Node test on Windows.
- The plan-name pattern's suffix folds case, matching the folder sweep. Serves the Goal's single
  card by removing a contradiction between its two views. Adds no mechanism. Size: one regular
  expression flag. **This departs from the Approach's verbatim pattern** and the Approach sentence is
  amended to match. Not fixing it leaves the folder view drawing a file the join refuses.
- A duplicate goal id no longer lends its plan to another entry. Serves section 2's "a plan reading
  or none for each entry". Adds no mechanism. Size: one set. Not fixing it silently gives the second
  entry the first one's plan.

Four surprises beyond those lines. Three of review round 2's four Majors were introduced by fix
round 1, and the worst of them by an acceptance clause this session wrote rather than by anything
the implementer chose: both of that round's load-bearing answers were already sitting in
`broker/board/thread.ts`, three lines each, in the file this module was written to follow. The
recurring defect class of this plan surfaced a third time, a guard tested only against the literal
it already matches, this time the refusal of a directory standing at a plan's name, where every test
that pins which paths are opened injects a seam that reimplements the guard instead of running it.
One acceptance clause this session wrote for the close pass could not fail, and the implementer
proved it by deleting the guard and watching the test stay green, then replaced the assertion with
one that does fail. And the failure hold needed a durability axis to satisfy two clauses that looked
independent and were not: opening a failing document once per tick wants the failure remembered,
while never freezing on a transient failure wants it forgotten.

Assumptions: none beyond the plan's own `## Assumptions` section. Every gap this section met was
answered by an acceptance bullet or by the Approach.
Review Findings: `review: code pair + security at fable, Agent tool` for round 1 over an opus
writer; `review: adversarial at opus, Workflow` for rounds 2 and 3. Round 1: no Critical, 5 Majors
raised and 6 owed after two Minor upgrades, 16 Minors across three lenses; the security lens
returned CLEAR. Round 2: no Critical, 4 Majors, 6 Minors, CHANGES_REQUIRED. Round 3: no Critical, no
Major, 5 Minors, APPROVED_WITH_CONCERNS. All 10 owed Majors fixed. No finding was held and no judge
was convened: no finding traced outside the Goal, the Intent or the acceptance bullets, so none was
new-requirement. No design stop fired. Two Minors were upgraded to Major at round 1's adjudication on
a stated consequence, one of them corroborated independently by a second lens. Minors: 18 banked, 5
fixed in the close pass, 9 left with the reason, 2 upgraded, 2 confirmed dead against the code. The
nine left: the text expression's forward-slash-only spelling, which the Approach states verbatim;
Windows reserved device stems passing the name pattern, where round 3 probed `CON.md`, `NUL.md`,
`COM1.md`, `LPT1.md` and bare `NUL` on this machine and all threw ENOENT, so the route is closed by
the operating system and a pattern-layer refusal would be a mechanism no clause names; `statSync`
following symbolic links, whose docstring was corrected while the behaviour stands, since whoever
can plant the link can plant the content; the 2 MiB buffer on the heartbeat read, the Approach
naming 2 MiB as the cap for both files and the fix reaching the capped-read helper four copies
share; length bounds on `title`, `objective`, `blockedReason` and `lead.reason`, which the renderer
cuts per the layout paragraph, carried to section 4; per-file rather than per-entry stat caching
inside one tick, carried to section 3 where the rule it affects is built; a store parsing to valid
non-object JSON clearing rather than holding, settled by chapter 1's second decision line; a
per-plan-reading held marker, declined because the layout paragraph puts that marker at the group
label and sources it from the store's reading, carried to section 4; and the null-stat early return
leaving an earlier failure stat standing, which is the accepted granularity of a stat-keyed hold
rather than a defect, the good-reading hold two lines above having the same property. The close pass
changed four production lines and five comment blocks and so owed no round; it took the author
re-read in its place, over the full production delta against a pre-pass copy, which confirmed those
four lines are the whole of it. Three surfaces were routed out rather than fixed and are now one
`docs/backlog.md` entry: the single-read capped read at `broker/usage/cache.ts:270-281`, a confirmed
defect that fails closed; the capped-read loop standing in four copies; and three `plans.ts` helpers
left unexported.
Stamps: adjudicated 5, stamped 4. Stamped `forward-resource-arrangements-into-dispatch-briefs`,
which is why every brief carried the box-claim protocol and the machine's state at dispatch;
`fan-out-runs-through-workflow-under-a-session-wide-cap`, which is why rounds 2 and 3 named model and
effort explicitly on the Workflow route; `a-trace-target-you-composed-cannot-check-your-own-work`,
which is why each reviewer was pointed at the plan's own Goal and bullets rather than a summary; and
`git-credential-manager-hangs-headless-on-scott-claude`, which is why every push was bound with a
timeout. The fifth was read and did not apply.
Gate: targeted lane owed at this close; the whole gate run instead, since it covers the targeted
lane, the box allowed it, and this section exported two names other modules can now reach. No
contention lane: the section's delta touches file readers and a join, none of it machine-shared
state. Measured on SCOTT-CLAUDE at 2026-09-21T02:03-0400, on this branch at `c592dbb` with the
section's four files dirty. Whole gate 1771 tests, 1770 pass, 0 fail, 1 skipped, exit code 0; lint
(`tsc --noEmit`) exit code 0; 37 s wall clock for both together. Against the branch baseline at
`4152f79` on a clean worktree, 1721 tests, 1720 pass, 0 fail, 1 skipped, exit 0, 34.1 s: 50 tests
added across both sections and 0 failing to 0 failing. Against section 1's close at `854adba`, 1737
tests, 1736 pass, 0 fail, 1 skipped: this section added 34 tests and broke nothing. Contention
reading: uncontended. The claims directory was empty at the read immediately before the run, this
session wrote its own claim with its own id, and deleted it after confirming that id, having also
read the file's modification time rather than its `Started:` line. An empty claims directory means
nobody has claimed the box rather than that the box is free, so this reading rests on the wall clock
landing within 3 s of two earlier baselines as well. Test delta: 34 added, 0 retired, 2 edited to
stay green on this section's own change, so no retire class applies. The 2 edited both pinned the
held-parse stat this section reversed, and each was strengthened rather than widened: one replaced a
single modification-time assertion with a two-axis assertion plus a fixture guard proving the
document really moved, and the other gained an assertion on the opened-path list that did not exist
before. Of the 34 added, 30 in `broker/board/queues.test.ts` pin the reader's contract, one per
acceptance bullet plus the hold machinery: the live-shaped text join with trailing punctuation, the
archive fold, `planPath` winning over text, the four refusal classes opening nothing, the crafted
name that leaves nothing outside the four places, the torn store, the store with no key for the
persona, the title-before-objective order with both documents on disk, the no-fallback rule, the
README refusal across every case the pattern admits with a withheld control, the held plan parse in
both failure classes, the held store failure with its clearing, the one-read-per-document fold over
two entries and the one-read-per-failing-document fold over three, the transient-versus-durable
failure split at one instrument, the upper-case suffix, the padded `planPath`, the duplicate goal
id, and a directory standing at a plan's name refused by `statFile` without the seam that would have
hidden it. The other 4 are in `broker/board/plans.test.ts`, pinning the newly exported
`readPlanFile` at its cap and its failure classes. Added tests that spawn a process, directly or
through a shared helper: 0.
Next: 3. The status word
Commit Model: Branch-and-PR
Delta: measured on SCOTT-CLAUDE at 2026-09-21T02:06-0400, worktree at `c592dbb` with the section's
four files and two documents dirty.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 5 - 2026-09-20

Written on the compaction gate's deferral nudge, with section 3 built, committed at first green and
in review round 1. Not a Chapter: section 3 is still open.

**Section stages.** Sections 1 and 2 are closed, committed at `44aa3e8` and `69c57b7`, and pushed.
Section 3 is built, verified by this session's own whole-gate run, committed at first green as
`246fe90` and pushed, and in review round 1. Sections 4 and 5 are not started.

**Live dispatches.** Three reviewers over section 3's delta, all at fable on the Agent tool, none
permitted to build or run the whole suite. The adversarial lens carries the spec, the base ref
`69c57b7`, the section name, an `Amendments in effect: none` line and the trace target, and was asked
in addition to judge four decisions named to it as decisions rather than as leans: the `in flight`
word staying the table's rather than the layout's, the document fold by path, the narrowed reason
rule, and the `queueKey` export. The blind lens carries the base ref and the changed-file list alone,
plus the two standing repository properties. The security lens carries the same sighted fields and
was pointed at the two properties worth testing here: whether the bookkeeping sweep reaches every
string the answer carries, and whether any value another program wrote can make the module throw,
loop or order nothing on the broker's only event loop.

**Gate baseline.** Measured on SCOTT-CLAUDE at 2026-09-21T02:31Z, on this branch with section 3's
four files dirty and no claim standing on the box: whole gate 1793 tests, 1792 pass, 0 fail, 1
skipped, exit code 0, 37 s wall clock; lint (`tsc --noEmit`) exit code 0. Measured by this session
rather than taken from the implementer's report. Against section 2's close at `c592dbb`, 1771 tests,
1770 pass, 0 fail, 1 skipped, exit 0: section 3 has added 22 tests and broken nothing. Contention
reading: uncontended by the claim, which this session wrote with its own id and deleted after
confirming that id. An empty claims directory means nobody has claimed the box rather than that the
box is free, so this reading rests on the wall clock landing within 3 s of the two preceding
baselines as well.

**Rulings adopted since the last boundary.** Three, all at the implementer's adjudication and before
any review finding exists.

The first is a spec conflict the implementer surfaced and this session confirmed against the code.
The Approach's reason rule says a blocked entry draws the store's `blockedReason` when the store
status is `blocked`. Section 3's acceptance sweep says no returned reason may carry the string
`Max rounds`. An entry blocked by a kit event whose store happens to hold `blocked` with the reason
`Max rounds reached` satisfies the first sentence by drawing exactly what the second forbids. The
narrowing taken is that the store's reason draws only where the store's own block is the block, which
is what the acceptance bullet requires and what the Intent's whole framing asks for: the round limit
is the plugin's bookkeeping and never a stop. Recorded as a declared assumption rather than referred,
because the acceptance bullet is absolute and the Intent names this exact misreading as one of the
two the plan exists to remove.

The second is the round-limit comparison being taken on the trimmed value where the Approach says
`exactly`. A reason differing from the plugin's own string by a trailing space is the same
bookkeeping, and drawing it as a block is the misreading. Declared rather than referred, since it
widens a refusal rather than a permission and the string is the plugin's on both sides.

The third is a fold, and it widens this section's file list. The implementer reported that
`status.ts` had written a second copy of the queue-ordering key that `broker/board/queues.ts:336`
already owns, and that the two differed in written form: the reader's leans on its field parser to
drop a non-finite key, the copy carried its own finiteness guard. Confirmed here against
`queues.ts:248`, where `numberField` gates both `sortKey` and `createdAt` on `Number.isFinite`, so the
divergence is unreachable on anything the reader can produce. Folded rather than left, because queue
order decides two of the eight words, the in-flight tie and the up-next place, and a writer and a
reader holding two copies of one positional rule is the shape a later edit moves a word through with
neither side's tests noticing. `queueKey` is now exported and called, and the copy is gone. The fold
predicate holds on all three parts: same directory as a file this section changed, no acceptance
criterion the section does not already carry, and covered by the gate that had to run anyway.

**Scope drift since the last boundary.** Section 3's `Files in scope:` gains `broker/board/queues.ts`
for the one exported name above. The spec's own bound on `broker/board/card.ts`, "the four exports
only", is held rather than widened: a second duplicated helper there, the non-finite modification
time guard at `card.ts:293`, was left duplicated in `status.ts` and routed to the backlog instead,
because exporting a fifth name to buy a three-line clamp would contradict a section line the operator
approved.

**Next action per section.** Section 3: adjudicate round 1's three lenses, capture the provenance of
every Major against `.kit/scratch/channels_board-worker-queues/section-3/fix-round-1.diff`, dispatch
the fix round, then the lens any fix delta owes, the Minor close pass, the close gate, chapter 3, the
`docs/backlog.md` entry for the duplicated modification time guard, and the close commit. Sections 4
and 5: not started. Section 4 inherits two Minors carried from section 2, the per-plan-reading held
marker and the length bounds on the free-text fields, and one from this section, that the reason rides
out uncut because the layout paragraph puts the 120-character cut on the renderer.

### Chapter 3 - 2026-09-20
Completed: 3. The status word
Implemented By: implementer-opus, no escalation
Metrics: review rounds 2, closed claim-exit; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises:
- Section open. Builds `broker/board/status.ts`, one pure function turning a persona's queue entries and plan readings into a status word per entry, the group's done and total counts, and the worker's state, plus four existing helpers exported unchanged from `broker/board/card.ts`. Serves the Goal sentence "Each group lists that worker's queued plans in running order, with a plain status word" and section 3's own acceptance bullets. Adds no mechanism the spec does not name: the Approach's eight-row table, the blocked-event lookup and the worker's state are each stated there. Size: the section as specified, roughly 250 lines of module and one test per table row plus the seven extra acceptance bullets. Not building it leaves the card with queues and no word on any entry, so the operator cannot tell running from queued.
- Queue ordering inside `status.ts`. Changes: the function sorts its entries by the queue key before applying any rule. Serves the acceptance bullet "Queue order is ascending by key ... keys compare as numbers" and rules 5 and 7, which are positional. Adds a mechanism that runs: one stable sort. Size: 5 lines plus its comment. Not building it makes the answer depend on the caller's ordering, so the exported function has no defined answer of its own and that bullet cannot be pinned.
- The document fold by path. Changes: candidates are folded by `reading.path` and ranked on the newest instant seen for that path, so entries on one document tie. Serves the acceptance bullet "Two entries joined to one document: the earlier in queue order is in flight". Adds a mechanism: one map. Size: 8 lines. Not building it lets a mid-tick save hand one file two stats and give the word to the later entry for the same work.
- `touchedAt`, the non-finite modification time guard, copied from `card.ts:293`. Serves no bullet by name; it is the failure-mode breadth the brief asks an implementer to mirror from its sibling. Adds no new behaviour on good input. Size: 3 lines. Not building it lets a value that is not a number make the in-flight comparison order nothing, and the word lands wherever the loop leaves it.
- Finite guards on `turnStartedAt` and `lastTurnComplete`, and a whitespace-only reason folding to null. Serves the worker-state paragraph and the reason rule read at their meaning. Size: 3 predicates. Not building them draws an idle span with no number in it and a blank reason clause.
- `queueKey` is exported from `queues.ts` and called from `status.ts`, replacing the second copy this section had written. Serves the acceptance bullet "Queue order is ascending by key" and the Goal's single card, by giving the rule one owner. Adds no mechanism: one `export` keyword, and a call replacing a local function. Size: 1 line added, 17 removed. Not fixing it leaves a writer and a reader holding two copies of the rule that decides two of the eight words, with the copies already differing in written form, so a later edit to either moves a word with neither side's tests noticing.
- The event fixture's default root spelling (round 1's one Major, spec-traceable). Changes: the default event fixture is built under the roster's own forward-slash spelling, and the backslash spelling stays in the one test guarded to Windows. Serves the section's Tests line, "Lock the root-spelling match, since the live roster writes forward slashes." Adds no mechanism: two constants, one of which moves. Size: 2 lines. Not fixing it leaves three event-rule assertions green on Windows alone, because the separator fold they lean on is a Windows-only branch of `comparablePath`, so the rules the plan exists to get right go untested anywhere else.
- Folding case on the round-limit comparison. Changes: the round-limit reason is compared on the trimmed, case-folded value, which is the form every status comparison beside it already takes. Serves the acceptance bullet "no returned word or reason contains `paused`, `pending` or `Max rounds`". Adds no mechanism: one existing comparison changes the form of its two operands. Size: 1 line. Not fixing it lets a plugin release that changes the string's case hand the card the exact bookkeeping reason this section exists to keep off it.
- The order-independence claim in `personaStatus`'s opening comment, and the absurd-values test's because-string. Changes: both are narrowed to what holds. Serves nothing new; it is the nothing-untrue-ships rule over the section's own prose. Adds no mechanism: prose only. Size: 4 lines. Not fixing it leaves a comment promising an answer independent of caller order, which a hand-built non-finite key does not get, and a test claiming to pin an ordering it asserts nothing about.
- The bookkeeping sweep's control and its walk. Changes: the control is judged before the sweep loop and excluded from it, so it speaks over the same collection; the walk reaches a map or a set. Serves the acceptance bullet "For every case in this suite, no returned word or reason contains ...". Adds no mechanism in the product: two branches inside a test helper. Size: 6 lines. Not fixing it leaves a control that proves the predicate works on a result the loop never saw, and a walk that would return empty for a future map field and go quiet exactly as a by-name check would.
- Withholding any block reason that carries the round limit's own string (close pass). Changes: `reason` returns null for text containing that string, whatever else the text says. Serves section 3's acceptance bullet on the sweep and the plan's Operator Verification line, "the work reopens if `Max rounds` appears anywhere on the card". Adds a mechanism that runs: one membership test inside an existing function. Size: 1 line. Not fixing it lets a store writing a round count after the string, `Max rounds reached (3/3)`, be judged a block by the whole-value rule and then hand the card the one phrase the operator reopens this work over.
- Surprise, and the round's most useful finding: the round-2 lens disproved a sentence this session wrote, by experiment rather than by reading. The narrowed comment claimed a non-finite sort key "leaves that entry where the caller put it". The lens ran the comparator over 2000 randomized inputs of 2 to 41 elements and the planted entry moved in 1490 of them. It holds only for the three-element shapes the suite happens to use. The sentence now says the position is unspecified.
Assumptions: the status function returns the table's word `in flight` rather than the layout paragraph's `in progress`, which is section 4's renderer substitution, since collapsing them would put renderer vocabulary inside a pure function (declared 2026-09-20, section 3). Two entries joined to one plan document tie by `path` so that queue order breaks the tie, because the reader stats per entry rather than per file within one tick, so a mid-tick save hands one file two timestamps and a time-only tie-break never reaches queue order (declared 2026-09-20, section 3).
Review Findings: review: code pair and security lens at fable, Agent tool (round 1); adversarial lens at opus, Workflow at effort high (round 2). Round 1 returned one Major, from the blind lens: the test file was green on Windows alone, because the default event fixture's backslash root matched the roster's forward-slash working folder only through the win32 separator fold in `comparablePath`. Confirmed against `broker/board/events.ts:295` before acting on it rather than taken on report. Traced by this session as spec-traceable to the section's Tests line, an orchestrator-made trace, the blind lens carrying no spec. Fixed. Round 2 returned no Critical and no Major, and confirmed the repair by running the suite with the platform value spoofed to linux: exit code 0, 22 pass, 1 skipped. Minors: 11 fixed across the fix round and the close pass, 0 upgraded, 3 left with the reason. Left: a reading whose modification time is not a number leaves an outstanding event's block standing, which is the conservative direction rather than a defect, since an unreadable time is no evidence the document moved after the event; `running now` is unbounded by the heartbeat stamp's age, the Approach stating that rule as built, so a ceiling is a mechanism no clause names and it is parked in `docs/backlog.md`; and rule 5's fallback fires when no unmatched entry has a started reading rather than when no entry at all does, which is the reading intended, since a blocked In Progress plan has already taken its word and should not suppress another entry's draw. Two carve-outs recorded rather than fixed: the sweep's control is a deliberately built case whose own free text carries a banned word, excluded from the sweep by identity, the acceptance bullet's subject being the plugin's bookkeeping rather than an operator's prose; and the round-limit comparison now folds case where the Approach said "exactly", which widens a refusal and is recorded in the Approach's own wording. The close pass's delta took an author re-read rather than a round: it is prose but for the one-line reason guard, which is directly tested with a red run watched first.
Stamps: adjudicated 13, stamped 3. Stamped `sed-i-in-git-bash-rewrites-a-crlf-file-whole-to-lf` and `git-bash-sed-i-strips-cr`, which is why both red probes restored from a filesystem copy taken before the first mutation rather than from the edited file, and `byte-counts-need-one-line-ending-basis`, which is why the line-ending audit counts carriage returns against total lines rather than comparing bytes. The window was 1d, covering the section's whole span since Chapter 2, and its own account came out, so no hand walk was owed.
Gate: targeted lane (`node --test` over `status.test.ts`, `card.test.ts`, `queues.test.ts`) 104 tests, 104 pass, 0 fail, 0 skipped, exit code 0, measured on SCOTT-CLAUDE at 2026-09-21T02:55Z on this branch with the section's files dirty and this session's own claim held and then released. Against the same lane's 102 pass at round 1's dispatch: plus 2, both added here. The whole gate ran beside it for comparability with the recorded baselines, though Branch-and-PR does not owe it at a section close: 1795 tests, 1794 pass, 0 fail, 1 skipped, exit code 0, 36 s wall clock, same moment and same box. Against section 3's first green at 1793 tests, 1792 pass, 0 fail, 1 skipped: plus 2 tests, no regressions. Against section 2's close at `c592dbb`, 1771 tests, 1770 pass, 0 fail, 1 skipped: plus 24. Type check (`tsc --noEmit`) exit code 0. Test delta: 2 tests added, 0 retired, 6 edited to say what they actually pin rather than to stay green on a behaviour change. Added: "a round-limit reason is bookkeeping in any case or padding the plugin writes it in", pinning that the round limit falls through rule 3 however the plugin spells it; "a block reason that carries the round limit and more is blocked, and draws nothing", pinning that the string never reaches the card even where the entry is a genuine block. Added tests that spawn a process, directly or through a shared helper: 0, the module being pure. Contention: the claims directory was empty before each run, this session wrote the claim with its own id and deleted it after confirming that id, and the wall clock landed within 1 s of the three preceding whole-gate baselines. An empty claims directory means nobody has claimed the box rather than that the box is free, so that second reading is what the first rests on.
Next: 4. The persona group in the renderer
Commit Model: Branch-and-PR
Delta: read on SCOTT-CLAUDE at 2026-09-21T02:56Z, against the worktree at this Chapter's own state.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
