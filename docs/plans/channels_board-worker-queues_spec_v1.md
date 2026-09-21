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

**Rulings after the spec shipped.** None at the write.

**Provenance.** Distilled from the architect persona's design conversation with the operator on 2026-09-20.

## Approach

**One new setting.** `CHANNEL_BOARD_ROSTER` holds the absolute path of the fleet roster file, which on this machine is `D:\personas\fleet.json`. The roster is a JSON array the operator maintains. The card uses three fields of each entry: `name`, `workdir` and `enabled`. A roster `workdir` is trusted the way a configured project root is trusted, because the operator writes the file and its location comes from the broker's own settings.

**What is read per enabled persona, each tick.**
- `<workdir>/.agentic-personas.json`, the persona plugin's store. The top-level key is the persona's name. Under it, `goals` is a flat array of queue entries and `activeGoalId` names the entry the controller counts as active. The card uses these entry fields: `id`, `kind`, `title`, `objective`, `status`, `blockedReason`, `pausedByNudgeCap`, `sortKey`, `createdAt`, and `planPath` and `lead` when present. It also reads `monitor.lastTurnComplete`.
- `<workdir>/.agentic-heartbeat.json`. Under the persona's name, `turnStartedAt` is a number while the worker is inside a turn and null otherwise.
- The plan document each entry names, through the join below, parsed by the existing `parsePlan`.

The store is written whole with no rename and no lock, so a read can land mid-write. A store or heartbeat that fails to read or parse keeps its last good reading, as the card already does for a plan document mid-write, and the group's label says so. The store is held on mtime and size like a plan document, so an unchanged file is not parsed again.

**The join from a queue entry to its plan.** The persona's store is writable by the persona, so its text never becomes a path. The broker takes a file name only. From `planPath`, when the entry has one, it keeps the final path segment. Otherwise it searches the entry's `title` and then its `objective` with the expression `docs/plans/([A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-])` and keeps the first capture. Live entries write the path followed by a comma or a full stop, which that expression leaves outside the name. In both cases the kept name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$` and must not be `README.md` in any case. The broker then looks for that name in exactly four places under that persona's own `workdir`, in this order: `docs/plans/`, `docs/archive/plans/`, `docs/archive/`, `docs/plans/archive/`. A name found only in an archive folder marks the entry done. An entry with no usable name, or whose name is found in none of the places, has no plan reading and draws from its store fields alone. The set of places is closed at those four.

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

`terminal` is the existing `PlanParse` field. A plan reading's status equals `In Progress` when it matches those two words as the whole value, ignoring case. Queue order is ascending by key. Each entry's key is its own `sortKey` when it has one, else its own `createdAt`, and keys compare as numbers. A store status of `blocked` with the reason `Max rounds reached` falls through rule 3 on purpose, so that entry is judged by rules 5 to 8 like any other. A reason draws only on an entry whose word is blocked. It is `lead.reason` when the lead is blocked, else the store's `blockedReason` when the store status is `blocked`, and an entry blocked by an event alone draws none.

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

Files in scope: `broker/board/status.ts`, `broker/board/status.test.ts`, `broker/board/card.ts` (the four exports only).
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
