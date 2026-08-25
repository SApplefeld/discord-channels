# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

An item carries its parked date once it has one, and ages from it: past 90 days it gets a
promote, retire, or keep call at the next close-out. Every item below this line was parked between
2026-08-06, when this file was created, and 2026-08-13, so none of them is near that threshold yet
and none carries a date of its own. An item added from here on carries `(parked YYYY-MM-DD)`.

- Make a cross-session exchange watchable from one Discord surface (parked 2026-08-25). Claude
  Code sessions now message each other directly (cross-session messaging: `SendMessage`/`ListAgents`,
  inbound wrapped as `<cross-session-message>` with sender name and mode). During a live four-session
  coordination experiment on 2026-08-25 (claude-kit repo), the operator reported doing their best to
  follow the back-and-forth, which today means tabbing between terminals or threads. Unverified from
  that session: how the broker's mirror currently renders an inbound peer message or an outbound
  SendMessage call, so the first step is to read that rendering. The candidate: mark peer traffic
  distinctly in the thread mirror (counterparty name, direction), and consider a per-exchange view so
  one surface shows both halves of a conversation its session participated in.
- Root-cause the intermittent timing failure in `broker/tail.test.ts:2469`, "a long reply the
  tailer is still posting is not posted again by the Stop mirror" (parked 2026-08-21, found while
  baselining an unrelated round). It fails with `AssertionError: the condition never held` from the
  test's own `until` helper (tail.test.ts:2459), observed once in a full-suite run and once in three
  isolated runs of the file, on a clean tree at 3417f79, and passes on re-run. A genuine flake by
  the repeat test, not a regression from any open work; it needs its `until` window read against
  what the test drives (a real timer against an injected clock is the usual shape) rather than a
  retry wrapper. Also observed under suite load later the same day: its mirror-image sibling (the
  inverse dedup direction) and "a mirror run that landed nothing after the tailer deferred still
  gets the text posted" each failed the same way, always with the `until` helper's "the condition
  never held", always green alone and in-file (111/111 across repeated runs) and green on full-suite
  re-run, so the flake covers the in-flight echo-dedup group in `tail.test.ts`, not one test, and
  the shared `until` polling window under parallel suite load is the prime suspect.

- **Allow-list what a thread delivers instead of deny-listing one system type (parked 2026-08-17,
  from the title-states security review).** `classifyMessage`'s thread branch drops
  `ChannelNameChange` and delivers everything else, so any other system message type Discord posts
  into a thread reaches `onMessage` and the sender gate, stopped today only because no such type
  carries composed content, and past that by the empty-content guard in `inbound.ts`. A future
  Discord type that does carry text would reach a session as if the operator typed it. The
  hardening is to deliver `Default` and `Reply` in a thread and drop the rest; the pin-notice test
  ("a pin notice in a thread is delivered like any message") flips with it. Do it when the gateway
  is next open, and pin both directions.

- Run operator check F (`operator-checks.md`), now the side-by-side fidelity watch: console beside
  thread, one long turn, on SCOTT and on NEO with both restarted onto this code. It covers the
  coalesced surface (one growing `(edited)` message under one header, and a typed message breaking
  the block), the one-copy close (the turn's closing words appearing once, under whichever
  attribution posted them first), and the three fidelity legs: the turn's first narration chunk
  reaching the thread, a message typed at the console mid-turn arriving as an operator-attributed
  quote in order, and a reply splitting into six or more messages landing whole against the console
  copy. Its first successful append is also the evidence that closes the open question of whether
  editing the bot's own message needs any permission beyond the six `install.md` already grants (a
  refused-append log line carrying a permissions error reopens that). Narration sitting above a
  typed message more than momentarily, a missing chunk, a missing queued prompt, or a report that
  still ends early reopens the thread-fidelity effort as a new round. NEO and ASR pick the code up
  at their next `git pull` plus broker restart (or next logon, which restarts the task).
- Revisit the coalescing freshness map's eviction race if this ever runs at fleet scale. The
  per-thread invalidation clock is bounded, so with 64 or more other threads narrating during one
  run, an evicted entry reads as "no arrival" and a run can be remembered above a foreign message,
  which is narration above a permission prompt in the channel where approvals are answered. Accepted
  at a two-host installation because reachability needs 64 concurrently narrating threads, and
  because the clean fix, a single monotonic arrival counter that survives eviction, would make any
  ID-less arrival anywhere end every in-flight run's coalescing. Growing the fleet is the trigger to
  take that trade.
- A Discord code block wraps to the rendered width of the window it is read in, and never scrolls
  sideways. Measured on the operator's own devices at roughly 51 columns on a folded phone, 62
  unfolded, 83 on a desktop, and no wrap at all past 120 on an ultrawide. Recorded here because two
  decisions in `broker/discord/render.ts` rest on it: `MAX_BLOCK_WIDTH` is set below the narrowest of
  those so a card's padded columns cannot be scrambled by a wrap, and the permission prompt's tool
  input is deliberately not wrapped, since no constant is right for a reader whose width is their
  window. Anyone tempted to widen the card bound should re-run the check first: a ruler of `END|`
  markers at known columns, read on the narrowest device that matters.

- Two live checks the question-answering round could not close from code, both needing a real held
  question at a console with the thread beside it
  ([`archive/plans/channels_question-answering_spec_v1.md`](archive/plans/channels_question-answering_spec_v1.md)
  is the delivered plan). First, stopping the broker while a question is genuinely held: the desk
  releases every held hook on shutdown so the console picker takes over, which is tested against a
  synthetic entry but never against a live socket, and the failure it guards is a session wedged
  with no picker on either surface. Second, clearing a multi-select back to nothing and re-picking
  before submitting, the one interaction path where Discord's own component state, not the desk's,
  decides what arrives.
- One live check the question-overflow round could not close from code, needing a real session and a
  phone ([`archive/plans/channels_question-overflow_spec_v1.md`](archive/plans/channels_question-overflow_spec_v1.md)
  is the delivered plan). Provoke a long ask, or wait for a real one, and read the thread on the
  phone: the interactive message plus its continuation messages, every option's gloss readable in
  full, and the pickers still answering the ask end to end. An option still cut anywhere in the
  thread reopens the rendering section; a marker standing over a continuation that never arrived
  reopens the delivery section. Worth watching the timing too, since a maximal six-continuation ask
  now takes about 7.2 seconds between the alert and the controls appearing, and that pace is one
  constant (`CONTINUATION_POST_PACE_MS`) if it reads as too slow in practice.
- A dangling sentence in `security-model.md`, in the `GET /sessions` paragraph: "Those are model
  ids, a token count, and upstream's own refusal category and consent answer" follows a sentence
  about card-versus-route disclosure and has no antecedent left, so a reader cannot tell what
  "those" names. Predates the question-overflow round, which is why that round left it alone rather
  than guessing at the missing clause. Whoever fixes it should read the surrounding paragraph
  against `GET /sessions`'s actual field list rather than inferring the lost sentence.
- Fold the six duplicated `createRepeatLog` implementations into one. The rate-limited repeat
  logger is hand-copied into `broker/tail.ts`, `broker/question-desk.ts`,
  `broker/routing/interactions.ts`, `broker/discord/pins.ts`, `broker/usage/thread.ts`, and
  `broker/board/thread.ts`, each with its own window constant, so a fix to the throttling behavior
  has to be found in six places. Low risk and no behavior change wanted; purely drift. The board
  card's round took the sixth copy deliberately, on the codebase's own precedent that a small
  terminal mechanism is duplicated per surface, and named three copies as the extraction threshold.
  That threshold is now well past, so this is the round that should collapse them.
- The board card's binding module is a near-duplicate of the usage card's. `broker/board/binding.ts`
  and `broker/usage/binding.ts` differ only in identifiers and their header paragraphs. Accepted
  deliberately at the time, on the same per-surface-duplication precedent, with a fourth card named
  as the point to extract. If one ever lands, the shape to build is a single card-binding module
  taking a label.
- Decide whether a plan's status should be allowed to spell the board card's own marker vocabulary
  (parked 2026-08-16). A status is drawn whole, so `Status: held 9h 10m · blocked 2d 1h` renders as
  clauses a reader tells from the broker's own markers only by position: the markers lead the facts
  line and a status ends it. Nothing is authorized off that card, so the cost is a misread rather
  than an action, and `docs/security-model.md` states the limit rather than promising past it. Every
  fix changes the body shape settled on 2026-08-16 (a prefix on the status clause, a marker glyph, a
  separator only the broker draws), so this is a preference and risk-appetite call rather than a
  defect to route.
- Decide whether the board card's `Next:` line should stay cut at 120 characters when the sweep
  takes the value in at 400 (parked 2026-08-16). It is the one field on the card that can still end
  in an ellipsis, and the round that removed every other cut left this one where the spec put it.
  Raising the render cap to 400 is a one-constant change (`MAX_NEXT_LENGTH` in `broker/board/card.ts`)
  and costs card budget that overflowing boards spend on plans; leaving it costs the tail of a long
  next-step phrase.
- **Deploy the two delivered rounds and walk them, in this order.** Everything below needs a real
  host, a real Discord client, or a phone, and none of it can be closed from code. The delivered
  plans are
  [`archive/plans/channels_usage-card_spec_v1.md`](archive/plans/channels_usage-card_spec_v1.md)
  and
  [`archive/plans/channels_mirror-fidelity-repairs_spec_v1.md`](archive/plans/channels_mirror-fidelity-repairs_spec_v1.md).
  1. Pull and restart the broker on SCOTT, NEO and ASR, and set `CHANNEL_USAGE_CARD` on wherever
     the fleet card is wanted. Nothing else on this list can run before this.
  2. Read both cards on a phone and confirm neither costs a horizontal drag. The width bound counts
     code points, while a glyph-led line can draw one column wider, so this is the check the bound
     itself cannot make. The downgrade marker's glyph beside the state glyph is read in the same
     pass. In the same look, confirm the fleet card's bars draw as unbroken lines rather than dashed
     runs: whether consecutive U+2014 glyphs tile is a property of the client's font, and the swap
     is one constant, `BAR_GLYPH` in `broker/discord/render.ts`, with `─` (U+2500) as the named
     alternative. The card's new shape (bold labels, bars, whole-dollar spends) is
     [`archive/plans/channels_fleet-card-layout_spec_v1.md`](archive/plans/channels_fleet-card-layout_spec_v1.md).
  3. Compare the fleet card's numbers against a console `cswap status` within one refresh. This
     cannot be run from a session at all: `cswap` mutates the cache under test and spends the shared
     budget of roughly 28 requests per hour per account.
  4. Watch a session start and exit and confirm the channel's pin list follows it.
  5. Mirror a turn that carries a Markdown table and confirm it draws as an aligned block.
  6. Answer a multi-select from the thread and confirm the session reports comma-space text.
  7. Stop every other claude-swap consumer for an hour and confirm the card's "as of" ages honestly
     rather than reading fresh.
  8. On a host with zero sessions and no claude-swap, confirm the static body means a deleted card
     goes undetected until restart.
  9. Turn the board card on (`CHANNEL_BOARD_CARD` plus `CHANNEL_BOARD_PROJECTS`) and read it on a
     phone in the same pass as check 2, folded and unfolded. The card draws no bar, and its one
     fence is the box naming each project, so what is being read is whether that box reads as the
     boundary between one project's list and the next, whether a long project name wraps inside the
     box rather than being cut, whether the nested bullets render with a hanging indent, whether any
     name
     or status still ends in an ellipsis at its full length, and whether a long fact wraps rather
     than cuts. On a board large enough to overflow, confirm it ends in the tail naming what it left
     out rather than dropping a project silently, and that the tail stands on its own line rather
     than reading as part of the last plan's entry. The delivered plans are
     [`archive/plans/channels_board-card_spec_v1.md`](archive/plans/channels_board-card_spec_v1.md)
     and
     [`archive/plans/channels_board-markdown_spec_v1.md`](archive/plans/channels_board-markdown_spec_v1.md),
     which moved the body from a fence to live markdown.
  10. Drive a real `/kit-goal` run to a blocked stop and confirm all four surfaces the event drives:
     the board card's blocked marker, the session thread's `⛔ <name> · blocked` title, the `⛔` state
     on that session's card, and the alert arriving on the phone exactly once for the episode. Then
     resume it and confirm both clears, the board card's marker on the plan's next modification or
     the goal completing, and the session's `⛔` on engagement (type at the console, or answer from
     the thread, and watch the card clear on the next refresh and the title one dwell window later).
     Every clear rule on both sides was exercised only against synthetic events, and the live event
     stream is the one thing a test host cannot supply. The delivered plan is
     [`archive/plans/channels_blocked-state_spec_v1.md`](archive/plans/channels_blocked-state_spec_v1.md).
  11. Confirm the board card takes and keeps a pin beside the usage card. The pin list's permanent
     slot became a list for this, and that arithmetic was verified against a test double rather than
     a live channel's pin ceiling.
- Confirm what Discord does with a rename on a still-archived thread. Inferred, never established:
  after the archive-revive fix, a session woken by hook traffic alone leaves the broker's archived
  flag cleared while Discord's thread may still be archived. If Discord refuses the rename as a
  permanent failure, three refusals mark the entry abandoned and the card is unpinned, which is a
  louder failure than the frozen card it replaces but still not the intended one. Nothing in this
  repository states the rule and no test can establish it; a real archived thread taking a
  name-change request settles it.
- Spoiler-collapsed background-task reports, behind `CHANNEL_TASK_NOTIFICATION=full`. The default
  `brief` drops the injected report entirely in favor of the one-line 📨 notice, and `full` posts
  it as a many-message quoted block; a collapsed rendering would keep the report reachable without
  the thread being louder than the terminal. Wanted only if the one-line notice proves too thin.
- Remove the retired `mcp__channel-relay__reply` rule from `~/.claude/settings.json` on NEO and on
  ASR: both were provisioned while the fragment still shipped it, and `Install-Host.ps1` never
  removes a rule already there. SCOTT's copy is already done.
- Teach `Start-Broker.ps1` to clear its own port at startup with `Repair-Broker.ps1`'s
  kill-by-proof rules. The scheduled task runs at the highest run level, so a broker it started is
  elevated, and an unelevated repair cannot kill that orphan when it outlives a task stop: every
  fresh start then dies on EADDRINUSE until someone reaches an elevated prompt (this cost a
  deploy a keyboard trip on 2026-08-08; the corrected `claude-sessions-on-scott-run-elevated`
  memory carries the failure matrix). The task's own elevation is exactly what the startup script
  can use to clear the port safely, under the same proof discipline, never by name.

- Two invisible-character residues in the shared sanitizer, from the fleet-card round's security
  review, both display-spoofing at worst with no syntax reachable. U+0085 (NEL) survives
  `visible()` in `broker/discord/render.ts` (above 0x1F so `isInvisible` passes it, and JS `\s`
  does not match it), so a client that treats NEL as a line break could visually split a bold
  label; U+061C (Arabic Letter Mark) is missing from the invisible class in `broker/sanitize.ts`
  (LRM/RLM and the bidi overrides are covered, ALM is not), so it can invisibly influence display
  order in a label with RTL text. Fix is one range each in `isInvisible` plus a test; the class is
  shared with the path that carries text to the model, so sweep both consumers when changing it.

- An intermittent failure in `broker/tail.test.ts`, inside the `until` helper at its own line 2451,
  which yields up to 1000 `setImmediate` turns and then asserts "the condition never held". It fails
  on a different test each time and only under machine load, and it is old: the fleet-card round hit
  it once too. What is worth knowing before anyone touches it is that the obvious fix is a trap.
  A failure there has two possible causes, a turn-count bound too tight to cover a slow run, or the
  tailer genuinely failing to post that once, and widening the bound cannot tell them apart. Doing
  so would hide the second case permanently, which is the more expensive of the two by a wide
  margin. So the next round that touches the tailer should first make the helper say which condition
  never held, and whether it became true shortly afterwards; a bound that expired and a run that
  never posted are then different messages and the choice of fix is evidence-led.

  Measured while chasing it: 21 clean full runs against 1 failure, no reproduction in 3 runs under 12
  CPU-saturating processes, none in 3 runs under 8 disk-saturating processes. The one failure landed
  while two subagents were working the tree, which is also when it did its damage: an implementer
  read the red as its own and reported against a baseline that was in fact clean. That is the real
  cost of leaving it, and it is why it is written down rather than left as folklore.

- Three display-spoofing residues on the per-row table shape, from that round's security review, none
  with syntax reachable and all in the same class. Drawing a table as lines of `label: value` gives a
  line semantic meaning it did not have inside a fence, so a cell that can compose a line can
  impersonate a column the model never filled. U+0085 (NEL) is the route, and it is the same
  character already recorded above as surviving `visible()`; what this shape changes is its reach,
  not the class. Whether Discord treats NEL as a line break is inferred and unverified, and the
  finding is nothing if it does not. Alongside it: a row whose first cell neutralizes to empty draws
  its values as an orphan paragraph a reader attributes to the row above, and a cell under an empty
  header can open a bullet or ordered list, since `-`, `+` and `1.` are not in the escape class.
  Fixing the NEL class serves the sanitizer item above at the same time.
- Re-pick `MAX_ROW_LABEL_WIDTH` in `broker/discord/render.ts` if a real table ever ships as raw pipes
  unexpectedly. It is 40, justified from the header lengths this repository's own tables carry rather
  than from a rule, and the growth bound beside it effectively tightens it to about 30 for a terse
  and very tall table. A table with a 45-character column header ships raw and nothing in the suite
  says so. Nothing is lost when it happens, which is why this is a note rather than a defect.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
