# Fleet board over worker queues

Status: Complete
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

**Operator decision, 2026-09-21.** The card's closing freshness line also ages with a held plan parse behind a drawn, not-done persona entry, stamped at the instant that parse was last read, exactly as the project view stamps a held row. No marker is drawn on the entry itself, so the entry layout stays as approved. Decided on the relay channel ("Agreed, let's do Option 1 for Section 4, as you recommended") on the section 4 ask that put three options, this one recommended. Rationale: the line's one job is to say how old the card is, and it already counts every other held reading the card draws from.

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

## Standing Brief Amendments

- The card's closing freshness line ages with a held persona store reading as well as with a held plan parse, so the card never reports itself as current while a group above it says how old that group's reading is.
- The card's closing freshness line ages with a held plan parse behind a drawn, not-done persona entry, stamped at the instant that parse was last read, as the project view stamps a held row, and no marker is drawn on the entry itself.
- On a tick whose root list changed, the event reader restarts at the stream's start with the markers it already holds kept, and reads up to nine windows in that tick, so a persona's block recorded before it was enabled is drawn on the first tick after.
- Every free-text field a queue entry or a roster entry contributes to the card is cut at a fixed length at intake or at render, so the card's length bound holds whatever a store writes.
- The join searches the entry's title for a plan name before its objective, over the same pattern and the same four places.
- A worker whose every entry is done draws its label, with its count and its state, and nothing beneath it; a worker with no entries draws nothing.
- Mechanisms this plan's reviews deferred are recorded as backlog items rather than built.

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

Files in scope: `broker/board/card.ts`, `broker/board/card.test.ts`, `broker/board/queues.ts`, `broker/board/queues.test.ts`, `broker/board/thread.ts` (the `personaView` adapter alone), `broker/board/thread.test.ts` (one assertion), `broker/board/status.test.ts` (one fixture line).
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

Files in scope: `broker/board/thread.ts`, `broker/board/thread.test.ts`, `broker/index.ts`, `broker/index.test.ts`, `broker/config.ts` (one comment), `docs/operations.md`, `docs/architecture.md`, `docs/install.md`, `docs/security-model.md`, `docs/backlog.md`.
Tests: lock the build gate in both directions, because a card that silently fails to appear is the failure the old gate would have produced. Lock that raw store words never reach a posted card.

## Related plans

- `agent_persona` repository, `docs/plans/agent_persona_plan-health-from-the-record_v1.md`: makes the persona plugin itself judge a plan from its document, and adds the `planPath` and `lead` fields this card reads when present. Neither plan waits on the other. Until that one lands, the join uses the text match and no entry carries a `lead`.
- [channels_board-card_spec_v1.md](channels_board-card_spec_v1.md): the card's first plan. It listed a session-to-plan join as a non-goal, which this plan reverses for persona queues, and it set the no-model rule this plan keeps.
- [channels_board-markdown_spec_v1.md](channels_board-markdown_spec_v1.md): the card's live-markdown layout, which the persona groups follow.
- [channels_blocked-state_spec_v1.md](channels_blocked-state_spec_v1.md): the kit event stream reader this plan hands more roots to. That plan built the reader; this one keeps it unchanged and gives it a reset with kept markers and a nine-window drain on the tick the root list changes.

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
- Decide whether `docs/security-model.md` gets a `## Threat model` section as its own effort. The finishing security review opened `threat model: absent`; the document carries each surface's accepted-risk sizing in prose and the board-card passage stood in for a model. The item is at `docs/backlog.md` under the same words. A no keeps the prose as it stands.
- Rule on three scope items the goal read raised, each carried in the close-out status with a recommendation: whether the roster `workdir` UNC refusal stays (recommended: keep); whether the shared `UNC_ROOT` rewrite of the intake transcript-path check stays (recommended: keep); whether the `hono` line in the backlog's audit item stays (recommended: keep). A different answer on any reopens the work as a new round.

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

### Interim board 6 - 2026-09-20

Written on the compaction gate's deferral nudge, with section 4 built, committed at first green and
in review round 1. Not a Chapter: section 4 is still open.

**Section stages.** Sections 1, 2 and 3 are closed, committed at `44aa3e8`, `69c57b7` and `fb1db63`,
and pushed. Section 4 is built, verified by this session's own whole-gate run, committed at first
green as `3354a21` and pushed, and in review round 1. Section 5 is not started.

**Live dispatches.** Three reviewers over section 4's delta against `fb1db63`, all at fable on the
Agent tool, none permitted to build or run the whole suite. The adversarial lens carries the spec,
the base ref, the section name, an `Amendments in effect: none` line and the trace target, and was
asked in addition to judge six claims the implementer made rather than assume them, and to test four
things specifically: whether the overflow fixture genuinely overflows rather than merely fitting,
whether the narrowed `sectionCount` signature is behaviour-preserving on the project path, whether
the persona path's failure-mode breadth actually matches the project path's clamp for clamp, and
whether the layout's entry ordering is what the code produces when one of its positions is empty.
The blind lens carries the base ref and the two changed file names alone, plus the two standing
repository properties. The security lens carries the same sighted fields and was pointed at three
properties worth testing here: whether the block-inert path reaches every value drawn inside the
group's fenced label, whether any new path can push the card past the length at which Discord
refuses it outright, and whether a value another program wrote can cost time on the broker's one
event loop proportional to its own length.

**Gate baseline.** Measured on SCOTT-CLAUDE at 2026-09-21T03:06Z, on this branch with section 4's
two files dirty and this session's own claim held and then released: whole gate 1810 tests, 1809
pass, 0 fail, 1 skipped, exit code 0, 37 s wall clock; lint (`tsc --noEmit`) exit code 0. Measured by
this session rather than taken from the implementer's report. Against section 3's close at `fb1db63`,
1795 tests, 1794 pass, 0 fail, 1 skipped, exit 0: section 4 has added 15 tests and broken nothing.
Contention reading: the claims directory was empty before the run, and the wall clock landed within
1 s of the four preceding whole-gate baselines. An empty claims directory means nobody has claimed
the box rather than that the box is free, so the first reading rests on the second.

**Rulings adopted since the last boundary.** Three, all declared at the implementer's adjudication
and none referred.

The first is where the renderer's persona input type lives. The spec says `broker/board/card.ts`
must not import `broker/board/status.ts`. The input could have borrowed section 3's and section 2's
types through a sibling import, which is less code and honours the sentence literally. It is
declared structurally in the card's own vocabulary instead, because the sentence is about the
renderer not depending on the rule module rather than about which file name appears in an import
line. The cost is an adapter at the tick, which section 5 already owes. A test pins that the two
upstream types satisfy the new shapes with no conversion, so the adapter cannot quietly become a
translation.

The second is a persona whose entries are all done. The layout says a persona with nothing left
after rule 1 draws nothing and is silent on this case. It draws nothing too, because the card's shape
forbids a fenced label over an empty list, which its own blank-line walk asserts, and the project
view already drops a root whose plans are all terminal. What that costs is that a fully finished
worker's `N of N done` label is not shown. One line reverses it.

The third is the `personas` field being optional on the renderer's input. That is forced rather than
chosen: `broker/board/thread.ts` is outside section 4's scope and has to keep compiling. Section 5
makes it always passed.

**Scope drift since the last boundary.** None. Section 4's `Files in scope:` line stands as written.
Two surfaces outside it were named by the implementer and left unedited, and both are carried below
rather than folded.

**Carried out-of-scope surfaces, for adjudication at section 4's close.** Two, both named by the
implementer in its report and neither touched. An entry title and a block reason have no intake cap
in `broker/board/queues.ts`, so the renderer measures a value of another program's choosing before
cutting it, and the remaining bound is coarse: a 2 MiB store file times 16 personas, on the broker's
one event loop, every tick. Section 2's Chapter had already routed that length bound here, so this is
where it lands. The implementer declined to pre-slice, because the cut helper is shared with the
project path and an existing test pins it on exactly its measure-before-cut behaviour, and it stated
the property in the card's header instead. The remedy named is an intake cap on `title`, `objective`,
`blockedReason` and `lead.reason` in the reader, in the shape `broker/board/plans.ts` already uses
for a plan's status. Separately, the project path's own facts line carries the same non-finite hold
instant hole the persona path now guards against.

**Next action per section.** Section 4: adjudicate round 1's three lenses, capture the provenance of
every Major against `.kit/scratch/channels_board-worker-queues/section-4/fix-round-1.diff`, dispatch
the fix round, then the lens any fix delta owes, the Minor close pass, adjudicate the two carried
surfaces above under the out-of-scope route, the close gate, chapter 4, and the close commit. Section
5: not started, and it inherits from section 3 that a block reason rides out of the rule module uncut
because the layout paragraph puts the 120-character cut on the renderer, which section 4 has now
applied.

### Interim board 7 - 2026-09-21

Written on the compaction gate's deferral nudge, with section 4 in its second round of fixes and one
implementer still in flight. Not a Chapter: section 4 is still open.

**Section stages.** Sections 1, 2 and 3 are closed, committed at `44aa3e8`, `69c57b7` and `fb1db63`,
and pushed. Section 4 is committed at first green as `3354a21`, has had review round 1 adjudicated in
full, and carries two fix rounds: the first accepted and verified, the second with one implementer
still working. Section 5 is not started.

**Live dispatches.** None. The last, an implementer at opus, returned while this entry was being
written. It was asked to move the reduction of `planPath` to its final path segment out of the
per-tick read and into intake, where every other bound in that module now sits. Its brief names the trap that makes the change non-trivial: `planNameFor` today
distinguishes an absent path, a reducible one, and one present but reducing to nothing, and only the
third yields no name without falling back to the entry's prose. Collapsing the third into the first
would break section 2's bullet that a carried `planPath` displaces the text search. Three dispatches
returned since the last boundary and are adjudicated below.

**Gate baseline.** The last reading this session measured itself: targeted lane over
`card.test.ts`, `queues.test.ts` and `status.test.ts`, 122 tests, 122 pass, 0 fail, exit code 0, on
2026-09-21 at the tree carrying fix round 1 and nothing else; `tsc --noEmit` exit 0. The claims
directory was empty before that run, this session wrote and released its own claim around it, and the
declared `test(` count across the three paths equalled the reporter's `tests` number, which is what
rules out a silently ignored path. A later reading of 126 tests, 126 pass, 0 fail, exit 0 is the
footer implementer's rather than this session's, taken on a tree a second implementer was editing, so
it is recorded as reported and is not the baseline.

**Rulings adopted since the last boundary.** Three, two of them from a judge.

The first is the card's closing freshness line. A blind lens found that the footer read "as of just
now" under a group label reading `held 5m`, two ages for one card. No acceptance bullet speaks to the
footer, so the finding was held as new-requirement and went to a scope judge, which ruled
accept-and-declare on the Goal sentence about what the operator can tell from a phone. It is adopted,
recorded as this plan's first `## Standing Brief Amendments` bullet, and now built.

The second is the uncapped identity and path residual, raised by the fix-round implementer rather
than by a lens. Every other free-text field a queue entry carries is now bounded at intake, but `id`
and `planPath` are still walked in full on every tick. The proposed fix paired a refusal on an
over-length `id` with a reduction of `planPath` to its final segment. The judge refused it as a pair
and ordered the work written within the form the plan names. The path half is that form already:
section 2's bullets state the reduction, so moving it earlier changes nothing they name. The `id`
half departs from it, because a refusal drops the entry, and a store whose `activeGoalId` names the
dropped entry then reads as nothing in flight and draws the worker's queue short, against the
Intent's "Show each worker's queue in its running order." So `id` leaves the reader as the store
wrote it. Its per-tick cost is routed to `docs/backlog.md` as a restructure rather than a bound.

The third is that the intake caps cover every other free-text field, sized as multiples of the bound
the card draws each value at, so a value a worker really wrote is cut by the card alone.

**Two defects in this session's own briefs, both caught by the seat rather than by the author.** The
first scope-adjudicator dispatch carried the plan's Approach, which that charter forbids, and the
orchestrator's own lean; it returned NEEDS_CONTEXT and was rebuilt. Both of that seat's briefs then
stated the plan carries no `## Intent` section, which is false. The omission was checked afterwards
against all three negative-half surfaces and could not have changed either ruling, but the judge
never saw Intent, so the orchestrator rather than a fresh seat is what stands behind that half.

**A correction to a standing claim in this run's dispatch briefs.** Three briefs told implementers
that this repository's worktree is CRLF. That holds for `docs/*.md` and is false for the TypeScript
sources, which are LF in the worktree and LF in git. There is no `.gitattributes` and `core.autocrlf`
is true, so the two diverge by file rather than by repository. No file was corrupted by the wrong
claim, which was redundant rather than harmful on the source files. It is now a project memory.

**Scope drift since the last boundary.** One, deliberate and recorded. Section 4's `Files in scope:`
line is widened by `broker/board/queues.ts` and `broker/board/queues.test.ts`. The ground is the
carve-out that a security finding of Major weight is fixed before its section closes or raised to the
operator, and is never parked for scope: two independent lenses found that a persona-written store
field reaches the renderer with no intake bound, costing a full walk of that value on the broker's
only event loop every tick, for as long as the file stays as written.

**Next action per section.** Section 4: read the path implementer's diff against the three states its
brief names, run the close gate, run the Minor close pass over the six recorded Minors, dispatch the
one review round the fix delta owes under the fix-delta bar, then chapter 4 and the close commit.
Section 5: not started. It must amend `docs/backlog.md:444`, whose advisory count says two where
`npm audit` now reports three, and rewrite `docs/security-model.md:619-660`, which predates the
roster and store readers entirely.

### Interim board 8 - 2026-09-21

Written on a park: the coordinator relayed the operator's request to restart this machine to apply
claude-kit fixes, and asked every session to make its state durable and stand down at its next safe
boundary. Not a Chapter: section 4 is still open, and this entry is what a session resuming after the
restart reads first.

**Section stages.** Sections 1, 2 and 3 are closed, committed at `44aa3e8`, `69c57b7` and `fb1db63`,
and pushed. Section 4 is committed at first green as `3354a21`, carries two fix rounds committed and
pushed as `54f656b`, and has now had review round 2 returned and adjudicated. It does not close here:
that round returned two Majors, both owed and neither fixed. Section 5 is not started.

**Live dispatches.** None. The review round this boundary was waiting on returned before the park and
is adjudicated below. Nothing was stopped, and nothing is in flight across the restart.

**Gate baseline.** No gate ran at this boundary. The last reading this session measured itself stands:
targeted lane over `card.test.ts`, `queues.test.ts` and `status.test.ts`, 127 tests, 127 pass, 0 fail,
0 skipped, exit code 0, on 2026-09-21 at the tree carrying both fix rounds, which is the tree committed
as `54f656b`; `tsc --noEmit` exit code 0. The declared `test(` count across the three paths equalled
the reporter's `tests` number, which is what rules out a silently ignored path. The whole gate this
branch last recorded, at `3354a21`, was 1810 tests, 1809 pass, 0 fail, 1 skipped, exit 0, 37 s.

**Review round 2, and why section 4 does not close.** One adversarial lens at opus through Workflow at
effort high, per the reviewer-effort table's later-round row over an opus writer. The round was owed
under the fix-delta bar because the delta reaches a security surface. It returned CHANGES_REQUIRED,
no Critical, two Majors and seven Minors. The Minors are recorded in the section's Minor list for the
close pass. Neither Major is a security finding and neither is a Critical, so the carve-out that
forbids parking one does not reach either, and the park is safe on that ground rather than on silence.

The first Major is fix-introduced, and it is this session's own fix biting back. The intake cap on
`objective` was added to bound a value the renderer walks every tick. But `objective` has exactly one
consumer, the join that finds the plan document's name inside it, so capping it at 400 code points
narrows the only window that search runs over. The Approach says the join searches the entry's
`objective`, not a prefix of it. An entry whose `docs/plans/<name>.md` sits past that cut now yields no
plan reading at all: no sections count, no next step, and the status rules that read a plan's status
can no longer see it, so a running plan draws as `queued`. The lens measured the live fleet: every
store entry on this box carries no `planPath`, so the text search is the sole join today, and objectives
there run to 500 and 769 characters, already past the cap. Nothing breaks yet only because today's
earliest `docs/plans/` offsets happen to be 0, 10 and 22. The remedy named is to run the name match over
the raw field at intake and store the matched name alone, capping `objective` for memory rather than for
the search, which also removes the per-tick regex. The defect is not live: this work sits on
`board-worker-queues` with no pull request merged, and the running broker is on `main` from a different
checkout.

The second Major is held as new-requirement and owes a judge, which the park leaves undispatched. The
finding is that the footer now ages with a held persona store reading while a held plan parse behind a
persona entry ages nothing and is marked nowhere, so the card can draw an entry's stale sections count
and next step under a footer reading `card as of just now`. The lens raised the fork itself rather than
asserting past it, and asked for adjudication. This session's reading, recorded as this session's rather
than a fresh seat's: the amendment's phrase "as well as with a held plan parse" names the project view's
pre-existing behaviour, and the amendment's own rationale clause, that the card never reports itself as
current while a group above it says how old that group's reading is, does not reach a per-entry parse,
whose age the card never states anywhere. Interim board 4 already declined a per-entry held marker on
the ground that the layout paragraph puts the held marker at the group label and sources it from the
store's reading, so a per-entry marker is a mechanism no clause in this plan names. That is the reading
that makes this new-requirement rather than spec-traceable. It is deliberately not ruled here: a scope
ruling written in a hurry to clear a park is the failure mode, and the resuming session dispatches the
judge on the fixed brief before it writes anything.

**What is owed and unrun at this park.** Three things, in this order. The fix round over the first
Major, whose own delta will owe a further round under the fix-delta bar because it moves work at the
join. The judge on the second Major, on the scope-adjudicator's fixed brief, carrying the plan's what
and neither this entry's reading nor any lean from it. Then the Minor close pass over the thirteen
Minors now recorded, the close gate, chapter 4 and the close commit. Section 4's round count stands at
two, well inside the review-round backstop.

**Scope drift since the last boundary.** None beyond what interim board 7 already recorded. Section 4's
`Files in scope:` line now names `broker/board/queues.ts` and `broker/board/queues.test.ts` in the
document itself, which board 7 described in prose and left unwritten; that correction is in this
commit.

**The goal tree, updated at the coordinator's request.** It held one complete root and nothing else, so
a resume would have read this persona as idle with two plans outstanding. It now carries both plans as
nodes under the root, the Fleet Board plan active and the stale-after-restart plan queued behind it,
each naming its plan document so the card's own join can find it. No other persona file was touched and
nothing was written to any other worker.

**Next action per section.** Section 4: dispatch the judge on the held Major and the fix round on the
fix-introduced one, then the round that fix delta owes, the Minor close pass, the close gate, chapter 4
and the close commit. Section 5: not started. It must amend `docs/backlog.md:444`, whose advisory count
says two where `npm audit` now reports three, and rewrite `docs/security-model.md:619-660`, which
predates the roster and store readers entirely.

### Interim board 9 - 2026-09-21

Written after the restart, by the session that resumed this plan on the operator's word on the relay
channel ("please resume the plan and continue"), with no kit goal armed at the operator's choice. The
goal record in `.kit/goal-state.json` still names the session that parked at interim board 8 and is
left as it is. Not a Chapter: section 4 is still open.

**Section stages.** Sections 1, 2 and 3 are closed and pushed. Section 4 carries three fix rounds.
Round 3's fix is committed with this entry. Section 4 holds on one question put to the operator,
below. Section 5 is not started.

**Live dispatches.** None.

**Gate baseline.** Measured on SCOTT-CLAUDE at 2026-09-21T04:34Z, on this branch at `e5f8928` with
`broker/board/queues.ts` and `broker/board/queues.test.ts` dirty, while session DEV-PLUGIN held the
machine's heavy-process claim for a whole-gate sequence in another repository, so contended:
targeted lane over `queues.test.ts`, `card.test.ts` and `status.test.ts`, 130 tests, 130 pass, 0
fail, 0 skipped, exit code 0; `tsc --noEmit` exit code 0. The declared `test(` count across the three
files is 39, 67 and 24, which equals the reporter's 130. Against interim board 8's 127 on the same
lane: 3 tests added, none failing. No whole gate has run since `3354a21`.

**The first Major, fixed.** The name search now runs once at intake over the uncut `title` and then
the uncut `objective`, and the entry carries the matched name on `textPlanName`. The join reads that
name where `planSegment` is absent, with the three `planSegment` states unchanged. `objective` had no
other reader, so it and its cap constant are gone from `QueueEntry`. The title cap narrowed the same
search and is covered by the same move. Two tests were watched red on the old code first: a plan path
past the title cap and one deep in a long objective. `kind` joined the cap test, closing a recorded
Minor. Review round 3, one adversarial lens at opus through Workflow at effort high, returned
APPROVED_WITH_CONCERNS: no Critical, no Major, four claim Minors, all docstring sentences, now on the
section's Minor list.

**The second Major, held for the operator.** The finding is that a held plan parse behind a persona
entry ages neither the footer nor anything drawn. The scope adjudicator, dispatched on its fixed
brief, ruled ASK. Its grounds: carrying a hold instant on a queue plan reading is named by no
acceptance bullet, Goal sentence or Intent clause, and a recorded decision it could not read is in
play. The pre-BLOCKED consult then ruled option (a) alone, on facts. The footer should age with a held
plan parse behind a drawn, not-done persona entry, stamped at the parse instant as the project view
stamps `readAt`, with no per-entry marker. Its ground is that `footerLine`'s own docstring, written by
this section, says a card redrawing a held reading says how old that reading is, and the code leaves
this reading out. That docstring was confirmed at `broker/board/card.ts:922-929`. The ask went to the
operator on the relay channel as a decision with option (a) recommended, rather than as a BLOCKED,
because the run is attended. The section does not close until it is answered.

**Next action per section.** Section 4: on the operator's answer, build option (a) or whichever option
is chosen, run the round that fix owes, then the Minor close pass over the eighteen Minors now listed,
the close gate, chapter 4 and the close commit. Section 5: not started, with interim board 8's two
document duties still owed.

### Interim board 10 - 2026-09-21

Written by the session that took the `dev-discord` persona after its predecessor died. Not a Chapter:
sections 4 and 5 are both open. This entry is what a session resuming after this one reads first.

**How this session came to hold the plan.** Two sessions worked the plan after interim board 9. The
first committed section 5's five documents as `baaf725` at 00:43 local and dispatched section 5's
code implementer, then died with it; that implementer's partial tree is kept at
`.kit/scratch/channels_board-worker-queues/section-5/partial/`. The second took the persona at 00:59,
re-dispatched the code implementer from
`.kit/scratch/channels_board-worker-queues/section-5/brief-redispatch.md`, and died at 01:02 with
that implementer mid-work, its transcript ending inside a file read. The persona plugin then handed
this session the persona on the stale heartbeat. The kit goal record in `.kit/goal-state.json` still
names the session that parked at interim board 8 and is left as it is, per interim board 9.

**The operator's answer on section 4.** At 05:06Z on the relay channel: "Agreed, let's do Option 1
for Section 4, as you recommended." That is option (a). It is recorded above as a dated line under
`## Intent` and as the second `## Standing Brief Amendments` bullet, both written at this boundary and
before any dispatch. The answer reached a passive session rather than the one that asked, which is
why it sat unbuilt for ten minutes.

**Section stages.** Sections 1, 2 and 3 are closed and pushed. Section 4 carries three fix rounds
committed and its fourth, option (a), not yet built. Section 5's documents are committed at
`baaf725`; its code is built and green in the worktree and not yet committed.

**Live dispatches.** None. Both dead dispatches are named above; nothing of theirs is in flight.

**Gate baseline.** Measured on SCOTT-CLAUDE at 2026-09-21T05:15Z, on this branch at `baaf725` with
section 5's four code files dirty, while a DEV-PLUGIN heavy-process claim 45 minutes past its stated
15 minute span stood in the claims directory, read as residue rather than as a live holder: targeted
lane over `thread.test.ts` and `index.test.ts`, 77 tests, 77 pass, 0 fail, 0 skipped, exit code 0,
6.0 s; `tsc --noEmit` exit code 0. The declared `test(` count across the two files is 35 and 42,
which equals the reporter's 77. Red evidence for section 5's four new tests, taken here since the
implementer that wrote them never reported: with HEAD's `thread.ts` and `index.ts` put in place of
the worktree's, those four fail and the other 73 pass, exit code 1; the worktree files were then
restored from the pre-probe copies and confirmed byte-identical, with `git status --porcelain`
unchanged. No whole gate has run since `3354a21`.

**Section 5's code, as the dead implementer left it.** `BoardCardOptions` carries `rosterPath`,
`readRoster` and `readQueues` as seams; the gate refuses only when both sources are empty and logs
the Approach's message; the tick reads roster, queues, events, the status rule per persona, then the
sweep, and passes both views; the event reader is handed the roots then the personas' folders and is
reset to its start when that list changes; `boardCardWiring` passes the roster path through. Four
tests pin the gate in both directions, the roster-only build, the reset by observed offsets, and the
wiring tick over a fake store carrying `paused`, `pending` and `Max rounds reached` with none of them
reaching the posted body. What is still owed: the third acceptance bullet is pinned only through the
reader's offset, not through a persona's entry drawing blocked after it is enabled, so one test is
owed on the real event reader; the implementer's report, its add-decision lines and its
out-of-scope surfaces were never delivered and are taken from the diff instead.

**Rulings adopted since the last boundary.** The operator's, above. Nothing else.

**Next action per section.** Section 5: first-green commit of its four code files on this session's
own gate reading, then hold while section 4's fix lands, since that fix adds one line to the adapter
in `thread.ts`. Section 4: dispatch option (a) to `implementer-opus` over `card.ts`, `card.test.ts`,
`queues.ts`, `queues.test.ts` and the one adapter line in `thread.ts`, run the round that fix owes,
the Minor close pass over the eighteen recorded Minors, the close gate, chapter 4 and the close
commit. Then section 5: the owed test on the real event reader, review round 1 with the code pair,
the security lens and the performance lens over a sonnet writer, its fixes, the close gate, chapter
5 and the close commit. Then finishing-work and the pull request.

### Chapter 4 - 2026-09-21
Completed: 4. The persona group in the renderer
Implemented By: implementer-opus, no escalation; fix rounds by implementer-opus; the Minor close pass by implementer-sonnet
Metrics: review rounds 4, closed claim-exit; provenance 5 spec-traceable, 1 fix-introduced, 2 new-requirement, rulings (1 refused, 1 declared, 1 asked); advisory: 1 finding, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises:
- Section open. Teaches `renderBoardCard` to draw persona groups ahead of the project groups, under the Approach's layout, from an input carrying the status function's output beside each entry's title and plan reading. Serves the Goal sentence "the pinned `Fleet: Board` card can draw one group per worker persona on this machine" and section 4's own acceptance bullets. Adds no mechanism the spec does not name. Size: the section as specified, roughly 300 lines of renderer and one test per acceptance bullet. Not building it leaves the card with a status word per entry and nothing that draws it.
- `MAX_WORKER_STATE_LENGTH` and the block-inert cut on the worker phrase; the finite guard on `heldSince`; `STOPPED_WORDS`: the implementer's three lines, each serving the layout paragraph, none adding a mechanism no clause names, carried verbatim in `.kit/scratch/channels_board-worker-queues/add-decisions-section-4.md`.
- Round 1's four Majors, all test strength and all spec-traceable: the overflow fixture's queued fold, the absent-persona-input test, the `stalled` word's fixture, and the blank-line walk's persona fill. Each serves the acceptance bullet "A fixture large enough to overflow ends in the tail" or "With no persona input, every existing card test passes unchanged". None adds a mechanism.
- The card's closing freshness line ages with a held persona store reading (round 1, blind lens, held new-requirement, judge accept-and-declare, the first `## Standing Brief Amendments` bullet). Serves the Goal's "The operator can tell from a phone". Adds one fold. Size: 6 lines.
- Intake caps on every free-text field a queue entry carries but `id`, `planSegment` and `textPlanName` (round 1, security and adversarial lenses on one subject, fixed before close under the carve-out for a security finding of Major weight). Serves the Goal's single card on the broker's one event loop. Adds a mechanism, a cap per field in the shape `plans.ts` already uses. Size: about 30 lines. Not fixing it walks a value of another program's choosing in full every tick.
- The uncapped identity and path residual (implementer-raised, design stop, judge REFUSE): the path reduction moved to intake within the form section 2's bullets name; the `id` refusal not built, because dropping an entry draws the worker's queue short against the Intent. Its per-tick cost is a `docs/backlog.md` restructure item.
- The plan-name search moved to intake over the raw text (round 2, fix-introduced): the objective cap had narrowed the only window the join searches. Two tests watched red on the old code.
- The footer over a held plan parse behind a drawn, not-done persona entry (round 2, held new-requirement, judge ASK, consult ruled option (a) on facts, operator chose option (a) on the relay 2026-09-21 05:06Z; the second `## Standing Brief Amendments` bullet; fix round 4, commit `aa3bf56`). Changes: the queue reader's per-document parse hold records the instant it was last known good, moving on every tick the document is confirmed unmoved and standing still on a tick it fails; the renderer's persona entry reading carries it; `footerLine` folds it over drawn, not-done entries in groups that draw. Serves the amended acceptance and the Goal's "how far along each plan is". Adds a mechanism: one instant per held parse and one fold, mirroring `Held.readAt` in `thread.ts`. Size: 49 lines in `queues.ts`, 41 in `card.ts`, 7 in `thread.ts`, plus tests. Not building it lets the card say "card as of just now" over an entry whose sections count and next step are minutes stale.
- An intentional widening recorded rather than left unremarked: the intake whitespace collapse (round 1's cap fix) means a store writing "Max  rounds reached" with a doubled space now falls through rule 3 as the plugin's bookkeeping, where it used to draw blocked, and the same collapse closes the leak where that spelling escaped the withholding at `status.ts` and would have put "Max rounds" on the card.
- Surprises. Three sessions died on this section after interim board 8, all inside a tool call, one with its implementer mid-work; the operator reports a persona-plugin bug since hotfixed. The persona goal tree auto-blocked the Fleet Board node mid-section on its default ten-round budget, every controller nudge being a round, and activated the second plan; this session rebuilt the node with a 400-round budget, dropped the auto-blocked one and paused stale-after-restart behind it. The relay refused the session before this one's status message, so the operator learned the fix was being built only from this session's scan report.
Assumptions: the close-pass items that asked for a guard no clause names (an inner empty-list guard beside `drawsGroup`, a finite guard on the project-plan fold, a refusal of a word outside the closed union) are left with the reason and their docstrings narrowed instead (declared 2026-09-21, section 4). The overflow tail keeps its `(+N plans, +M projects not shown)` wording over persona groups because the Approach states that form (declared 2026-09-21, section 4). The section's Files in scope line names `broker/board/thread.ts` (the adapter hunk), `broker/board/thread.test.ts` (one assertion) and `broker/board/status.test.ts` (one fixture line), widened at fix round 4 because the required `heldSince` field forced each (declared 2026-09-21, section 4).
Review Findings: `review: code pair + security at fable, Agent tool` for round 1 over an opus writer; `review: adversarial at opus, Workflow` at effort high for rounds 2, 3 and 4. Round 1: no Critical, 4 Majors, 1 new-requirement Major declared by the scope adjudicator, 1 security Major fixed under the carve-out, 5 Minors. Design stop on the implementer-raised id and path residual: ruling REFUSE by the scope adjudicator, the path half written within the named form. Round 2: no Critical, 2 Majors, one fix-introduced and fixed, one held new-requirement, judge ASK, consult, operator decision (option (a)), 7 Minors. Round 3: APPROVED_WITH_CONCERNS, 4 claim Minors. Round 4: APPROVED_WITH_CONCERNS, no Critical, no Major, 5 Minors, confirming the moving rule against `Held.readAt` and the byte-identical entry pin. Blind-lens traces were orchestrator-made. Minors: 23 recorded; 14 fixed in the close pass (all docstring or test-comment sentences, one duplicate test retired, one comment reflow, one cap-test line found already present); 5 left with the reason above; 2 carried to section 5 (`docs/operations.md` owes one sentence on a persona entry's held plan parse aging the closing line, and `docs/backlog.md:498-501` names three copied helpers where `bounded` and `WHITESPACE_RUN` make it five); 1 recorded above as an intentional widening; 1 resolved by fix round 4's docstring. The close pass changed prose and retired one test whose assertions survive at `card.test.ts:560`, `:1043` and `:1092`, so it owed no round and took the author re-read, which read every non-comment line of its delta and found only the retired test.
Stamps: adjudicated 15, stamped 1, `a-live-process-overwrites-your-edit-to-its-state-file`, which is why the goal tree was repaired through the persona plugin's own tools rather than by editing its store file. The other 14 were read in the window, most by the predecessor sessions, and did not change what was built. Window 4h, covering the span since chapter 3; its account came out, so no hand walk was owed.
Gate: targeted lane (`node --test` over `queues.test.ts`, `card.test.ts`, `status.test.ts`, `thread.test.ts`) 168 tests, 168 pass, 0 fail, 0 skipped, exit code 0, 336 ms; `tsc --noEmit` exit code 0. Measured on SCOTT-CLAUDE at 2026-09-21T05:56Z on this branch at `aa3bf56` with the close pass's four files dirty, while session DEV-PLUGIN held the machine's heavy-process claim for a whole-gate sequence in another repository, so contended; this session wrote no claim and ran the light lane alone. Declared `test(` count 40, 69, 24 and 35 equals the reporter's 168. Against the same lane at fix round 4's first green, 169 tests, 169 pass, exit 0 (this session, 05:42Z, same contention): minus 1, the retired duplicate. Against interim board 9's 130 on the three-file lane plus thread's 35: plus 3, all fix round 4's, and none failing. No whole gate has run since `3354a21`; finishing-work owes it. Test delta this section: 4 added in fix round 4 (the three-tick moving rule in `queues.test.ts`, pinning the amended acceptance's "stamped at the instant that parse was last read"; the drawn-entry footer age with the byte-identical entry pin, the undrawn-entry and done-entry absence pair with that test as its control, and the NaN instant, in `card.test.ts`; one assertion in `thread.test.ts` pinning the adapter, probed red by mutation), 1 retired (a duplicate, retire class: same render and because-string as `card.test.ts:1298`), 0 edited to stay green. Added tests that spawn a process: 0.
Next: 5. Wiring, the build gate, and the documents. Its code and documents are committed (`aaee236`, `baaf725`); it owes one test on the real event reader for the third acceptance bullet, the two document duties above plus interim board 8's two (`docs/backlog.md:444` advisory count, `docs/security-model.md:619-660`), its review round 1 with the code pair, the security lens and the performance lens over a sonnet writer, its fixes, the close gate and chapter 5. Then finishing-work and the pull request. At the plan's close, `goal_resume` the paused stale-after-restart node.
Commit Model: Branch-and-PR
Delta: read on SCOTT-CLAUDE at 2026-09-21T05:56Z, against the worktree at `aa3bf56` with the close pass's four files dirty.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 5 - 2026-09-21
Completed: 5. Wiring, the build gate, and the documents
Implemented By: implementer-sonnet (the section's code and documents, in the sessions before this one); the owed reader test and fix round 1 by implementer-sonnet; the document edits and the close pass in the main thread
Metrics: review rounds 2, closed claim-exit; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 2 findings, 0 fixed, 0 deferred, 0 refused, 2 covered by the correctness finding on the same subject; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Section open. Wires the roster, queue and status modules into the board card's tick and build gate, passes the roster setting through `boardCardWiring`, and brings four documents and the backlog up to the card as it then behaves. Serves the Goal sentence "the pinned `Fleet: Board` card can draw one group per worker persona on this machine" and section 5's own acceptance bullets. Adds no mechanism the spec does not name. Size: the section as specified, one adapter and a gate change in `thread.ts`, one passthrough in `index.ts`, their tests, and five document edits. Not building it leaves sections 1 to 4 unreachable from the running broker.
- The event reader's reset keeps the markers the card already holds and drains the stream inside the tick (round 1, three lenses on one subject, spec-traceable; fix round 1, commit `645cd4f`). On a tick whose root list changed, the reader restarts at offset 0 with the previous `latest` map carried rather than emptied, and the tick calls the reader again while its offset advances, bounded at `EVENT_DRAIN_WINDOWS` (nine 128 KiB windows, past the kit's 1 MB rotation point). Serves the acceptance bullet "A `goal-blocked` event read on a tick before a persona was enabled marks that persona's entry on the first tick after it is enabled" and the Goal's "The existing folder view is unchanged". Adds one bounded loop, in the form the section's own sentence "the stream is read again from its start" asks for, since the reader reads one window per call. Size: 12 lines and two tests. Not building it means every roster edit blanks every blocked marker for up to eight ticks, and for good where the kit has rotated the line out, and the persona's own event past 128 KiB is not marked on the first tick.
- The security model's join passage states the bound the code holds (round 1, adversarial and security lenses on one subject; prose only, main thread). "No path outside the `workdir` is opened or statted" and "cannot send outbound SMB" narrowed to the string form, and the passage now says the join's stat follows a link, on the ground chapter 2 recorded: whoever can plant the link can plant the content. The code keeps chapter 2's decision. Serves the nothing-untrue-ships rule and section 5's "state the rule as it then stands".
- The card's titles map keeps the first entry's title on a repeated id, matching the queue reader's first-entry-wins reading (round 1 Minor, fix round 1, pinned).
- The `hono` advisory rides in the backlog's parked audit item with the other two on the same ground. The `npm audit --json` run of 2026-09-21T06:02Z reports three advisories: `fast-uri` high, `hono` and `qs` moderate. The lockfile reaches `hono` through the SDK's `@hono/node-server`, only the SDK's shipped example server imports it, and `bridge/index.ts` imports the stdio transport alone. Interim board 1 routed the count amendment here by name.
- Two performance Minors on files outside this section (`queues.ts` per-entry stats at the caps, `status.ts` rebuilding the event index per persona) are a `docs/backlog.md` measurement item rather than a change here.
- Surprises. Chapter 4's Next line said `docs/security-model.md:619-660` was still owed; `git show baaf725 -- docs/security-model.md` shows the rewrite landed there, so the section owed the join-bound correction above and nothing else on that file. Fix round 1's implementer ran 3.8 hours for a 12-line change and four tests, with the machine's heavy-process claim held by another session for the first 90 minutes. This session's fix-delta capture once landed in the repository root under a mangled Windows path; removed before the close gate, the real capture being in scratch.
Assumptions: the `hono` advisory is recorded as parked with the other two on the same ground, its only import inside the SDK being a shipped example server (declared 2026-09-21, section 5). The copied-helper count in `docs/backlog.md` stays five with `WHITESPACE_RUN` named as `bounded`'s constant rather than a sixth helper (declared 2026-09-21, section 5). The section's Files in scope line names `broker/config.ts` for one comment, folded because it sits beside `index.ts`, needs no acceptance and `tsc` covers it (declared 2026-09-21, section 5). Round 2 ran one adversarial lens at sonnet rather than a pair, because the fix touched the reader reset at the event-stream boundary and round 1's other three lenses had no finding left open (declared 2026-09-21, section 5).
Review Findings: `review: code pair + security + performance at opus, Workflow` at effort high for round 1 over a sonnet writer; `review: adversarial at sonnet, Workflow` at effort high for round 2. Round 1: no Critical, 2 Majors on two subjects (the reset's one-window read that dropped markers, spec-traceable and fixed; the security model's absolute-bound claim over a link-following stat, spec-traceable and fixed as prose), 14 Minors; the performance lens's Major and the security lens's Major each read the same reset subject and were covered by its fix. Round 2: APPROVED_WITH_CONCERNS, no Critical, no Major, both Majors confirmed fixed against `events.ts:394-396` and `queues.ts:246-247`, 4 Minors. Blind-lens traces were orchestrator-made. Minors: 18 recorded; 5 fixed in fix round 1 (titles first-wins, two comments, the file-backed default-readers test with its withheld control, the event stamp between mtime and clock); 5 prose fixed in the main thread (`docs/operations.md` three status-word sentences and the Discord clause, `docs/install.md` block reason, `docs/security-model.md` join passage, the drain loop's exit comment after round 2); 2 routed to the backlog measurement item; 1 resolved by the Major's fix; 5 left with the reason (the backlog advisory's provenance lives above rather than in a commit body; `card.ts` NOTHING_OPEN wording is outside this section and behind pinned tests, carried to finishing-work's drift read; DOS device names were probed in chapter 2; a re-marked block across a reset needs the events file past its own 1 MB rotation point, which the reader's contract rules out). The close pass changed one comment, so it owed no round and took the author re-read.
Stamps: adjudicated 13, all operator tier; stamped 1, `a-chapters-claim-about-its-own-commit-is-unverified-until-diffed`, which is why the security-model rewrite came off the owed list. The other 12 were read in the window by this session's dispatches and by peers and did not change what was built. Window 5h, covering the span since chapter 4.
Gate: targeted lane (`node --test` over `thread.test.ts` and `index.test.ts`) 82 tests, 82 pass, 0 fail, 0 skipped, exit code 0; `tsc --noEmit` exit code 0. Measured on SCOTT-CLAUDE at 2026-09-21T10:17Z on this branch at `645cd4f` with the close pass's one file dirty, claim directory empty and no foreign runner in the process list, so uncontended. Declared `test(` count 40 and 42 equals the reporter's 82. Against the same lane at fix round 1's first green (this session, 10:08Z, 82 pass, exit 0): no change. Against the owed-test gate on `thread.test.ts` alone (06:07Z, 36 pass): plus 4, all fix round 1's. Test delta this section since chapter 4: 5 added (the owed reader test on the real `readEvents` with a temp directory and a control instance, probed red by disabling the reset; the drain past the first window and the marker surviving a reset past the drain budget, both watched red first; the first-title pin; the file-backed default-readers test with `assert.throws` as its control), 0 retired, 2 edited to stay green (the offsets-mock test converges at `[0,100,100]` and the first-call-per-tick test reads one flag, both because a drain now calls the reader more than once on a reset tick; contracts unchanged). Added tests that spawn a process: 0. No whole gate has run since `3354a21`; finishing-work owes it, with the contention lane beside it.
Next: none. Every section is complete. Finishing-work: the whole gate with the contention lane, the finishing reviews over the whole changeset (`107836c` is section 5's base; the plan's base is the branch point from `main`), docs curation with the `card.ts` NOTHING_OPEN wording in its drift read, then the pull request under Branch-and-PR. At the plan's close, `goal_resume` the paused stale-after-restart node.
Commit Model: Branch-and-PR
Delta: read on SCOTT-CLAUDE at 2026-09-21T10:17Z, against the worktree at `645cd4f` with the close pass's one file dirty.

### Interim board 11 - 2026-09-21

Written by the session running the finishing pass. Not a Chapter: every section is closed and the
pass has no Chapter until its close. This entry carries the pass's add-decision lines and its
advisory dispositions, which the finishing-work skill places here.

**Base ref.** `4152f79`, the merge-base with `main`; 22 commits and 26 changed files, every one
inside the union of the sections' Files in scope lines but the plan document itself.

**Step 1, QA.** `qa-verifier` at the charter's tier: build exit 0; suite 1832 tests, 1831 pass, 0
fail, 1 skipped (a POSIX-only token-file permissions test), exit 0. One FAIL: `docs/security-model.md`
never named `CHANNEL_BOARD_ROSTER`, against section 5's fourth bullet. Fixed in the main thread by
naming both board settings beside their paths at the passage's first sentence; the whole gate re-run
here under a claim read the same counts at exit 0.

**Steps 2 and 3, one wave at fable effort high through Workflow.** All three transcripts resolved
wholly to `claude-fable-5-1` (48, 40 and 34 assistant turns). Security: CLEAR, `threat model:
absent`, 5 Minors, disclosure sweep no hit (the lens ran its grep without a control; the main thread
re-ran it over the changeset with a withheld file as the control, 0 against 3). Performance: CLEAR, 5
advisory Minors with measured figures, three folded into the backlog's tick item. Adversarial:
APPROVED_WITH_CONCERNS, 2 Majors, 8 Minors, no debris.

**Add-decisions for the owed Majors, both spec-traceable, fixed in this pass's fix round 1.**
- A worker whose every entry is done draws its label with nothing beneath it (adversarial, `trace:`
  the Goal's "one group per worker persona" and the Approach's layout sentence "A persona with no
  entries left after rule 1 draws nothing" read with "the total is every entry that rule 1 does not
  remove"). Changes: `drawsGroup` answers on any entry rather than on a not-done one, and the render
  budget charges a label-only group as one empty item so the label, the tail reserve and the blank
  line fall out of the existing arithmetic. Serves the Goal's "what is running" for a finished
  worker, which otherwise vanishes indistinguishably from one dropped off the roster. Adds no
  mechanism: one predicate and one carry. Size: 2 production lines, 4 docstrings, 2 tests added, 1
  absence pin retired, 2 tests reshaped, the walk test's shape rule widened to admit a fence followed
  by a blank line. This reverses interim board 6's choice, which hid the group on the ground that the
  card stands no label over an empty list; the spec's layout never said so and the operator never
  ruled on it. One line reverts it. `docs/operations.md` states the drawn case.
- The relative `workdir` refusal is pinned on shape (adversarial, `trace:` section 1's "A relative
  `workdir` ... yield no persona"). Changes: `roster.test.ts` loops the four members, `relative\path`,
  `personas/worker`, `\personas\worker` and `/personas/worker`, the last two being what
  `path.isAbsolute` accepts and `WINDOWS_ROOT` refuses, with `namesOneLocalDirectory` as the control.
  Serves the same bullet. Adds no mechanism. Size: 19 test lines. The probe reduced the guard to
  `path.isAbsolute` and the test went red on `\personas\worker`.
- The implementer's own, marked in its report: the empty-item carry above; a capitalised control on
  `assertNoBannedWords` beside the `i` flag; the `projects()` and `groups()` test helpers anchored on
  the blank line before an opening fence, since a label-only group's closing fence read as a spurious
  label; `footerLine`'s stale all-done sentence corrected. None adds a mechanism.

**Advisory dispositions.** Security Minors: the deleted-roster hold and the two security-model
precision sentences fixed as prose in the main thread; the per-tick drain under a roster rewritten
every tick left as bounded and same-account; the copied helpers already at the backlog. `threat
model: absent` is a handoff: an item at `docs/backlog.md` and one under `## Operator Verification`
at the final Chapter. Performance Minors: the stat term (about 0.13 s at the caps), the moved-file
parse term (about 6 ms per 2 MiB store, about 0.35 s for a tick at every cap with every file
moving, against the 5 s floor) and the per-persona index rebuild written into the backlog's tick
item, now a trim rather than a measurement; the roster's per-tick read and its UNC-accepting
setting left as the same class the project roots accept. No advisory Critical, no fix-now lean.
The figures are the performance lens's own `node -e` microbenchmarks, taken on SCOTT-CLAUDE between
2026-09-21T10:30Z and 10:40Z during its review dispatch (`statSync` 5.0 µs present, 10.4 µs absent;
`JSON.parse` of a 2,093,270-byte store 1.1 ms; field bounding over it 4.2 ms; open plus capped read
0.7 ms), with no claim written and no contention read, so each is a single uncontended sample rather
than a gate reading; the raw report is at
`.kit/scratch/channels_board-worker-queues/finishing/r-agent2.md`.

**Fix round 1 gate.** Targeted lane over `card.test.ts`, `roster.test.ts`, `thread.test.ts`: `tsc
--noEmit` exit 0; 125 tests, 125 pass, 0 fail, exit 0, measured on SCOTT-CLAUDE at
2026-09-21T11:02Z under this session's claim, against the implementer's baseline of 124 on the
unedited tree (+2 added, 1 retired). Declared `test(` count 70, 15 and 40 equals 125. The
implementer waited out two foreign claims (`DEV-PLUGIN`, then `dev`) before its runs.

**Tree state.** HEAD `35ea88a`, pushed. Dirty and uncommitted until step 7, all this pass's: six
`broker/` files from fix round 1, `docs/security-model.md`, `docs/operations.md`, `docs/backlog.md`
and this entry. Fix delta captured at
`.kit/scratch/channels_board-worker-queues/finishing/fix-round-1.diff`; Minors at `finishing/minors.md`.

**Next action.** Review round 2, the adversarial lens alone at fable effort high over the fix delta.
Then step 4 (the goal read), step 3's Minor pass, step 5 (docs curation), step 6 (the final Chapter,
archive, whole gate), step 7 (the pull request).

### Chapter 6 - 2026-09-21
Completed: finishing-work; every section closed in Chapters 1 to 5
Implemented By: main session for the pass; fix round 1 by implementer-opus; the Minor pass by implementer-sonnet; the document edits in the main thread
Metrics: review rounds 2, closed claim-exit; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (2 refused, 5 declared, 1 asked); advisory: 10 findings, 6 fixed, 1 deferred, 3 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "When this is done, the pinned `Fleet: Board` card can draw one group per worker persona on this machine. Each group lists that worker's queued plans in running order, with a plain status word and the real progress of the plan document behind each entry. The operator can tell from a phone what is running, what is next, what is blocked, and how far along each plan is. The existing folder view is unchanged and is switched off by leaving its folder list empty. It matters because the fleet now runs as personas working through queues, and a sweep of plan folders no longer says what anybody is doing."; what the tree does now: the broker's pinned status card in Discord reads a fleet roster file named by one new setting, and for each enabled worker persona in it reads that worker's queue file, heartbeat and the plan documents its queue names, then draws one group per worker: the worker's name, how many of its queued plans are done, whether it is running now or how long it has been idle, and under that the plan in flight with its sections done out of total and its next step, the plan up next, every blocked or parked plan with the reason a worker wrote, and the rest of the queue folded onto one line; a worker's block reaches the card through the kit's own event stream, the lead field or a real store block, never through the persona plugin's own status words, which are withheld; the card runs no model, writes to no persona's file, and holds its last good reading when a file fails to read, aging its closing freshness line; the old folder view still draws behind its own setting and is off when that list is empty; Refinements during the run: the closing freshness line ages with a held persona store reading; the closing freshness line ages with a held plan parse behind a drawn not-done entry, stamped at that parse's last read, with no marker on the entry (operator decision, option (a), 2026-09-21); the event reader's reset keeps the markers it holds and drains nine windows on that tick; every free-text field a queue or roster entry contributes is cut at a fixed length; the join searches the entry's title before its objective; a worker whose every entry is done draws its label with nothing beneath it, reversing interim board 6's choice to hide it; mechanisms the reviews deferred are backlog items rather than built; three section 3 rulings recorded in the Approach (the store's block reason draws only where the store's own block is the block, the round-limit reason compares trimmed and case-folded, `queueKey` has one owner); the roster `workdir` refusal narrowed to a local folder (chapter 1, deliberate, a UNC share refused); Operator-pending: set `CHANNEL_BOARD_ROSTER` and restart the broker, then read the card on a phone against what each worker says it is on; decide whether the security model gets a `## Threat model` section; rule on the three scope items in the close-out (roster UNC refusal, intake `UNC_ROOT` rewrite, `hono` backlog line)
Decisions / Surprises:
- Base ref `4152f79`, the merge-base with `main`; 22 commits, 26 files, every one inside the scope union but the plan document.
- QA found one unmet bullet: `docs/security-model.md` never spelled `CHANNEL_BOARD_ROSTER`. Fixed by naming both board settings at the passage's first sentence. The rest of the suite and every other bullet verified.
- The two owed Majors from the finishing adversarial lens, fixed in fix round 1 and recorded on interim board 11: a finished worker draws its label (spec-traceable to the layout paragraph read with the worker-state paragraph; interim board 6's hidden group reversed), and the relative `workdir` refusal pinned on shape with `\personas\worker` as the withheld member.
- Round 2's one arrived Major was a claim finding on interim board 11's own unpinned figures, rated Minor and fixed by pinning them.
- The goal read (scope-adjudicator at fable, RULED): five items accept-and-declared, now the last five `## Standing Brief Amendments` bullets; two refused (the intake `UNC_ROOT` rewrite, the `hono` line), presented to the operator with their undo lines rather than reverted, since single-sourcing a guard is the doctrine's own rule and both were recorded at the time; one asked (the roster `workdir` UNC refusal), carried with a keep recommendation; one narrowed promise (a `then:`-folded entry shows no sections count, by the approved layout).
- Docs curation returned seven deviations and no mistake: the local-folder narrowing (D1), the empty-card text naming the configured projects on a roster-only card (D2), the `then:` fold's missing count (D3), four exclusivity claims about the card's one fence, now naming both group kinds (D4), the event reader reset's kept markers and drain (D5), two stale line references in a backlog item (D6), the in-flight fallback firing when no unplaced entry has a started plan (D7). Each is documented as built. Every literal the curator wrote (the config refusal message, the once-per-change log lines, the empty-card text) was checked against the code here.
- The `heldRoot` re-spelling edge and the duplicate-id double draw (round 1 adversarial Minors) are left as named edges: the first needs the operator to re-spell a working folder in the roster while a block stands under the old spelling, and clears on the plan's next write; the second draws what a store carrying two goals under one id holds, which is the persona plugin's defect.
- Surprises. Two peers held the machine's heavy-process slot during this pass (`DEV-PLUGIN` for 400 s, `dev` for 180 s twice); every lane here and in the dispatches waited them out, and one of my own leftover claims (a test-only implementer's, 20 s stated, 4.5 min old) was reported by DEV-PLUGIN and deleted under my own session id. The brief's suggested red probe for the stop-position tail test did not perturb it, since a group dropped whole never reaches the carry; the implementer added a drawn-label-first test that does go red on it. Chapter 5 omitted the `Delta:` reading; it is taken here.
Assumptions: the status function returns the table's word `in flight` rather than the layout paragraph's `in progress`, which is section 4's renderer substitution, since collapsing them would put renderer vocabulary inside a pure function (declared 2026-09-20, section 3). Two entries joined to one plan document tie by `path` so that queue order breaks the tie, because the reader stats per entry rather than per file within one tick, so a mid-tick save hands one file two timestamps and a time-only tie-break never reaches queue order (declared 2026-09-20, section 3). The close-pass items that asked for a guard no clause names (an inner empty-list guard beside `drawsGroup`, a finite guard on the project-plan fold, a refusal of a word outside the closed union) are left with the reason and their docstrings narrowed instead (declared 2026-09-21, section 4). The overflow tail keeps its `(+N plans, +M projects not shown)` wording over persona groups because the Approach states that form (declared 2026-09-21, section 4). The section's Files in scope line names `broker/board/thread.ts` (the adapter hunk), `broker/board/thread.test.ts` (one assertion) and `broker/board/status.test.ts` (one fixture line), widened at fix round 4 because the required `heldSince` field forced each (declared 2026-09-21, section 4). The `hono` advisory is recorded as parked with the other two on the same ground, its only import inside the SDK being a shipped example server (declared 2026-09-21, section 5). The copied-helper count in `docs/backlog.md` stays five with `WHITESPACE_RUN` named as `bounded`'s constant rather than a sixth helper (declared 2026-09-21, section 5). The section's Files in scope line names `broker/config.ts` for one comment, folded because it sits beside `index.ts`, needs no acceptance and `tsc` covers it (declared 2026-09-21, section 5). Round 2 ran one adversarial lens at sonnet rather than a pair, because the fix touched the reader reset at the event-stream boundary and round 1's other three lenses had no finding left open (declared 2026-09-21, section 5). The intake `UNC_ROOT` rewrite and the `hono` backlog line stay in the changeset pending the operator's word, each with a one-line undo (declared 2026-09-21, finishing). The twenty undated backlog items carry their introducing commit's date as `(parked YYYY-MM-DD, backfilled)`, all between 2026-08-07 and 2026-08-26, so none is past the 90-day threshold and no promote/retire/keep call is owed (declared 2026-09-21, finishing). Chapters 1 and 2 declared none beyond the plan's own `## Assumptions` section.
Review Findings: `review: security + performance + adversarial at fable, Workflow` at effort high for round 1, all three transcripts wholly `claude-fable-5-1`: security CLEAR with `threat model: absent` and 5 Minors, disclosure sweep no hit with the control run here; performance CLEAR with 5 advisory Minors and measured figures; adversarial APPROVED_WITH_CONCERNS, 2 Majors, 8 Minors, no debris. `review: adversarial at fable, Workflow` at effort high for round 2 over the fix delta: APPROVED_WITH_CONCERNS, both Majors confirmed fixed, 1 claim Major rated Minor, 4 Minors. Goal read: `scope-adjudicator at fable, Agent tool`, RULED, BUILT-BUT-UNASKED 9 (2 refuse, 6 accept-and-declare, 1 ask), ASKED-BUT-UNBUILT 1 (narrowed by the approved layout). Minors: 23 recorded; 5 fixed in fix round 1 (three comments, the `i` flag with its capitalised control, the empty-item carry's docstrings); 3 fixed in the Minor pass (the walk rule narrowed to the finished worker's label, three label-only shapes pinned, +3 tests); 8 fixed as prose in the main thread (two security-model sentences, the deleted-roster hold and its clear route, the backlog tick item's figures and its wording, the interim board pin); 1 deferred (the threat-model handoff); 6 left with the reason (the `heldRoot` re-spelling edge, the replay past 1,152 KiB, the duplicate-id double draw, the reserved device names probed in chapter 2, the roster's unheld per-tick read, the UNC-accepting roster setting). The drift read's D1 is the adversarial lens's `namesOneLocalDirectory` Minor, routed there.
Stamps: adjudicated 4, all operator tier, over the stretch since chapter 5 (`--since 2h`, the tighter window returning the same four); stamped 2, `a-trace-target-you-composed-cannot-check-your-own-work` (both trace targets were cut from the spec by line range) and `proceeding-past-an-aged-claim-is-not-taking-it` (the peer exchange over my leftover claim). The other two were read by dispatches and did not change what was built.
Gate: whole gate (`npm run lint`, then `npm test` over every `*.test.ts`) exit code 0 and exit code 0: 1836 tests, 1835 pass, 0 fail, 1 skipped (a POSIX-only token-file permissions test, skipped on Windows), 34.5 s. Measured on SCOTT-CLAUDE at 2026-09-21T11:25Z on this branch at `35ea88a` with the whole finishing pass dirty (the six `broker/` files, the four documents, the two indexes, this archived plan), under this session's claim with the claim directory otherwise empty and no foreign runner in the process list, so uncontended. Contention lane: this repository defines none. Against the pass's first whole gate (the QA verifier's at about 10:25Z and this session's re-run under a claim at 10:31Z, both 1832 tests, 1831 pass, 1 skipped, exit 0): plus 4, all this pass's. Test delta this pass: 6 added (the finished worker's label alone and its empty-persona control, in fix round 1; the lone finished worker ending the card, the label-only group at the stop position, and the drawn label-only item spending no plan count, in the Minor pass; the roster test reshaped in place over four members), 1 retired (the absence pin on the hidden all-done group, whose subject the empty-persona control covers), 2 edited to stay green (the footer-age test split into its empty and all-done cases; the held-parse-behind-undrawn-entry test retitled, assertion unchanged), and the `assertNoBannedWords` helper gained a capitalised control. Added tests that spawn a process: 0. Declared `test(` count over the three files the pass touched, 73, 15 and 40, equals the targeted lane's 128 at 11:14Z.
Next: none. The plan is complete and archived. Its pull request is what remains, under Branch-and-PR, and the operator-pending items above.
Commit Model: Branch-and-PR
Delta: read on SCOTT-CLAUDE at 2026-09-21T11:20Z against the worktree at `35ea88a` with the finishing pass's files dirty; the reading below is the verb's own non-output line, unchanged since chapter 4.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
