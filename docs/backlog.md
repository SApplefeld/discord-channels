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
  the shared `until` polling window under parallel suite load is the prime suspect. The group has
  since grown: the prompt slot's own deferral tests joined it on 2026-08-25, and "a tailer run that
  landed nothing after the mirror deferred still gets the text posted" failed the same way in a
  full-suite run taken while three review agents were working the same box, then passed 152/152 in
  each of three isolated runs of the file. A separate full-suite run over the same code, taken on a
  box carrying no review agents, came back 1492/1491/0/1 exit 0. "A reply record left by a deferral
  dies with the interim run that never landed" joined on the same day, failing once in a full-suite
  run with the same "the condition never held", then passing 159/159 in each of three isolated runs
  and green on the next full-suite run at 1505/1504/0/1 exit 0. It failed a second time, with "a
  mirror run that landed nothing after the tailer deferred still gets the text posted", across two
  further full-suite runs taken while another project's .NET suite held eleven processes on the
  box; each isolated to 160/160 exit 0 and each followed by a green full suite, the last of them
  1510/1509/0/1 exit 0 with that contention gone. On 2026-08-26 three consecutive full-suite runs
  each went red on a different member of the group, in order "a mirror run that landed nothing
  after the tailer deferred still gets the text posted", "a long reply the Stop mirror is still
  posting is not posted again by the tailer", and "a long reply the tailer is still posting is not
  posted again by the Stop mirror", every one at the same helper line with the same message, while
  another project's release suite held eleven .NET processes on the box; three isolated runs of the
  file in between were 160/160 exit 0 each, and the run taken once that contention had drained was
  green at 1510/1509/0/1 exit 0. A moving member across consecutive runs is the discriminator worth
  keeping: a regression fails the same test twice. So the member list tracks whatever the
  echo-dedup group holds rather than a fixed set of names, the trigger is load on the box rather
  than any one test, and the fix belongs in the helper.

- Teach the runtime-cycle pin to read re-exports (parked 2026-08-26, from the peer-traffic round's
  finishing review). `import-hygiene.test.ts` guards the `tail` to `outbound` edge by scanning for
  runtime `import` forms, and its own assertion message promises type-only imports alone. A runtime
  re-export (`export { x } from "./routing/outbound.ts"`) is a runtime edge that closes the same
  cycle and passes the pin in silence. The pin is a check whose acceptance is that it finds
  nothing, so the gap reads exactly like a clean result. Add the re-export forms to the scan, and
  prove the addition can speak before trusting it.

- A peer display name carrying a double quote reads differently on the two inbound paths (parked
  2026-08-26, from the peer-traffic round's finishing review). The mid-turn path takes
  `origin.name` whole, while the idle path's attribute read stops at an embedded quote, so one
  message can carry two different attributions depending on whether the receiver was busy. The
  failure is a truncated but still labelled name rather than a forgery, and it may be unreachable:
  whether the harness escapes quotes inside those attributes is unobserved, and the ground truth
  is silent on it. Worth a fixture the day a quote-bearing display name is seen live, and not
  before, since inventing the escaping rule is what the ground-truth discipline exists to prevent.

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
  1. Pull, re-run `Install-Host`, and restart the broker on SCOTT, NEO and ASR, and set
     `CHANNEL_USAGE_CARD` on wherever the fleet card is wanted. The `Install-Host` run is what
     carries the mirror hooks' 10-second timeout onto a host: an installed host keeps the value it
     was installed with until then, and nothing at launch reports the difference. That run is not
     a bare re-invocation, so it is a keyboard job rather than a phone one: `-HostName`,
     `-ChannelId` and `-AllowedUserId` are mandatory, and the bot token is prompted for as a
     SecureString unless `-BotToken` or `-BotTokenFile` supplies it. Nothing else on this list can
     run before this.
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
  12. Confirm a turn-opening prompt survives a lost mirror hook. Read the broker log for this, not
     the thread alone: both paths render the prompt identically, so a prompt in the thread says
     nothing about which path put it there. Run it on a session the tailer has already polled since
     the restart in step 1, and not on a prompt typed before the tailer had a baseline for that
     session, which sits behind the read position and is not recoverable by design. Type a prompt with the host
     quiet and confirm one copy in the thread beside a `routing: the transcript-read prompt from
     session <id> was dropped, the mirror hook had already dispatched the same text to this thread`
     line, which is the healthy race. Then take the mirror's copy away while leaving everything
     else running, and read the same log. Load alone is not that test: the broker answers 202 once
     it has read the body, so a hook the CLI abandons after that point still posts and the mirror
     still wins. What is needed is a `UserPromptSubmit` post the broker never receives while `/hook`
     posts keep flowing. Repointing that one hook entry's URL at a dead port does it: in
     `~/.claude/settings.json` the `UserPromptSubmit` entry is the only one, and changing only its
     port is enough, with no session restart, since Claude Code re-reads the file live. The console
     then reports `UserPromptSubmit hook error` with `connect ECONNREFUSED` naming the dead port,
     which is the confirmation the post was never made rather than merely slow. Revert the port
     afterwards or prompts stop mirroring. Whatever induces it, the session must have
     been armed and polled since the last broker restart, since a restart re-baselines the tailer
     past anything already written. With the mirror's copy gone the prompt should reach the thread
     up to a poll interval late with no drop line at all, which is the recovery carrying it alone;
     a drop line means the mirror got through after all and the run must be repeated.
     Confirm in the same pass that a slash command mirrors exactly as it
     did before, since the recovery excludes command lines by design. Every ordering of the two
     copies was exercised against a clock a test moves; what no test supplies is a real hook the CLI
     actually abandons. The plan is
     [`archive/plans/channels_mirror-load-tolerance_spec_v1.md`](archive/plans/channels_mirror-load-tolerance_spec_v1.md).
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

- `COMMAND_NAME` in `broker/tail.ts` scans quadratically on a line carrying many unclosed
  `<command-name>` tokens: a 224 KB synthetic line measured 403 ms of blocked event loop, against
  1.7 ms at a thousand repeats. Found by the security review of the mirror-load-tolerance round and
  left there deliberately: it is bounded by `MAX_TAIL_READ_BYTES` at 256 KB per pass, and reaching
  its input is any user line the console-origin gate admits, which is a same-user write to a live
  transcript, the accepted risk `security-model.md` already carries, plus the harness's own local
  command output, so it is a hardening rather than a defect. The same regex ran on the same lines
  before that round, through `goalCommand`. Worth doing if the transcript read ever accepts a
  larger pass or a less trusted file.

- Tag a prompt claim with the run that made it. The prompt slots in `broker/tail.ts` hold a text
  digest and two instants and no run identity, which leaves two residuals that share one cause.
  `notePrompt`'s same-digest deferral clear cannot tell a re-dispatch of the run a bit was set
  against from a distinct overlapping run carrying identical text, so typing one word twice can
  spend the bit the first run is owed: that run lands nothing, takes no retry, and logs the
  ordinary stopped-early line rather than `reached the thread by neither path`. And a `learn` post
  that arrives after a mirror post has already claimed starts the baseline probe, whose
  dispatch-time give-up spends that claim, which the arming-order fix does not reach because it
  bounds the probe `allow` starts rather than the one a late `learn` starts. Both are bounded by
  the claim window and neither is a regression; closing them means tagging every slot with its run
  rather than patching either site. Whether the late-`learn` ordering occurs at all is unconfirmed:
  it turns on which of the two arming posts the fragment emits first on a session's opening prompt,
  which nobody has measured.

- Clamp `lastEngagementAt` when a snapshot is restored. `broker/registry.ts` bounds the engagement
  stamp forward at the `engage` seam, so a transcript line cannot post-date a session out of its
  blocked state, but `broker/persistence.ts` restores the persisted field verbatim, so a state file
  carrying a future value survives a restart and suppresses `⛔` until the next completed tool call
  overwrites it outright. Bounded and self-healing, and behind the same same-user write to local
  state the security model already carries as an accepted risk, which is why it sits here rather
  than in the round that found it.

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

  Measured again on 2026-08-25, during the peer-traffic round, with the control the earlier
  measurement lacked: a clean HEAD tree extracted outside the shared worktree (`git archive HEAD
  | tar -x`) ran the full suite ten times and went red twice, once on "a long reply the tailer is
  still posting is not posted again by the Stop mirror" at `broker/tail.test.ts:2464`, same `until`
  assertion, with none of that round's code present. So a red in this group is pre-existing by
  default and no round needs to re-litigate whose it is. Two things in the wording above are
  sharper than the evidence supports: 2 in 10 on a clean tree is a far higher rate than the 21-to-1
  recorded here, and the reds arrived without the load the entry names as the trigger, so "only
  under machine load" and "the polling window under parallel suite load is the prime suspect" are
  both unproven. The helper's bound is a count of 1,000 `setImmediate` turns rather than wall clock
  (`broker/tail.test.ts:2473-2479`), which is load-independent by construction: it expires when the
  microtask loop spins fast relative to the paced run's real timer, which load would slow rather
  than hasten. The instrument-first fix above is unchanged and is still the right first move.

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
- **Detect a fleet-wide usage-pause freeze from the tailer's own vantage (parked 2026-08-26, routed
  from the kit's kaizen pass).** When the harness holds every session behind a weekly-usage banner,
  every transcript the tailer follows goes quiet simultaneously with no completions: a detectable
  signature the broker is uniquely positioned to see, since it watches all of them and the harness
  UI is visible to none of them. One symptom-keyed alert to the operator thread ("fleet appears
  frozen, check for a usage banner") would have turned the 2026-08-25 twelve-hour silent freeze into
  a phone ping; that freeze is the evidence, with queued relay messages piling up against sessions
  that all looked healthy from inside. Symptom-keyed rather than banner-keyed by necessity, so the
  detector needs a quiet-threshold tuned against normal overnight silence to avoid crying freeze at
  an idle fleet.
- **Warn at send time when an operator message is shaped like a slash command (parked 2026-08-26,
  routed from the kit's kaizen pass).** A slash command typed into the relay thread lands in the
  session as conversation text; the harness never sees it, and the operator learns it did not fire
  only when the session says so, a session-turn later. The class is already documented here (channel
  events are conversation input, not UI commands); what is missing is the signal at the moment of
  sending, which is the direction the silence hurts. Candidate: the broker detects a leading-slash
  shape in an outbound operator message and answers the thread immediately with a one-line
  "commands do not execute remotely" note. Evidence: an operator `/compact` over the relay on
  2026-08-25 reached the model as text and failed silently.

- Decide whether the display fields restored from the two on-disk files should carry a
  well-formedness guard, and apply or refuse it as one call (parked 2026-08-26, found by two
  reviewers independently during the follow-a-rename plan's Section 2). `broker/persistence.ts` and
  `broker/discord/bindings.ts` both restore untrusted display strings from files anything running as
  this user can rewrite. The session name and the session title now pass a guard that refuses a
  value `clean`'s UTF-16 cap left ill-formed; `host`, `source`, `lastTool`, `lastToolInput`,
  `openingModel`, `model` and the composed thread name do not, and `lastTool` and `lastToolInput`
  reach the Discord card body exactly as the name reaches the thread name. The inconsistency is the
  finding rather than a demonstrated defect: either the guard's rationale extends to all of them or
  it does not justify guarding the name alone. Left out of that section deliberately, because the
  fields are pre-existing surface serving a different goal than following a rename.

- Watch a renamed session end, and confirm the exited title and the archive both land (parked
  2026-08-27, Acceptance item 5 of the follow-a-rename plan, the one item that run could not
  observe). It needs a mirrored session carrying a `/rename` title to actually exit while someone is
  watching the thread, which did not happen inside that run. The finishing adversarial round read
  every path and reports it holds: `archive()` gates on the same `threadName` composition the exited
  rename writes, the title cannot move after exit because `noteTitle` refuses ended records, and
  `boundedTitle` is idempotent on its own output so a restart recomposes the same name. That is a
  code reading rather than the observation, so the item stays open until someone sees it.

- Decide whether a renamed session evicted by the `maxSessions` cap should still get its thread
  archived (parked 2026-08-27, found by the follow-a-rename plan's finishing adversarial round,
  medium confidence). A record leaving the registry by the cap rather than by the 24-hour retention
  falls to `retire()`, which caps at five passes seconds apart. If the per-thread rename bucket is
  empty across those five, the thread is left unarchived, or frozen at a pre-exit title where the
  exited rename never landed. The pass cap and the budget gate both predate the title work, which
  only adds one more consumer of the shared bucket, so this is pre-existing machinery worth a
  deliberate call rather than a defect that effort introduced. The plan's Traps section states the
  cost as "a late archive, not a wrong one", which is true everywhere except here.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
