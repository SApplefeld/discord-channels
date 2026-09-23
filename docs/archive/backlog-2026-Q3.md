# Backlog snapshot, 2026 Q3

Items completed and moved out of [`backlog.md`](../backlog.md). This file is append-only history;
the live backlog carries active items only.

## Completed 2026-08-07

- **Measure duplication across the three streams that land in one thread, then decide.** Measured
  by operation rather than instrumentation: the operator reported the reply-tool answer and the
  mirrored final reply repeating each other on long turns, and narration header volume was
  settled by [`plans/channels_narration-coalescing_spec_v1.md`](plans/channels_narration-coalescing_spec_v1.md).
  Acted on by [`plans/channels_reply-dedup-and-repair_spec_v1.md`](plans/channels_reply-dedup-and-repair_spec_v1.md):
  a mirrored reply matching a reply-tool answer, exactly or nearly and no longer than it, is
  suppressed, and both orderings of the duplicate collapse to one copy. What remains watchable,
  whether narration plus a full mirrored reply is more than a thread wants on very long turns, is
  a new observation if it ever itches rather than a standing item.

- **Re-run the installer on this host and confirm it completes without the seven `Set-Acl` errors it
  printed before.** The one acceptance criterion of
  [`plans/subprocess-and-hardening-fixes_spec_v1.md`](plans/subprocess-and-hardening-fixes_spec_v1.md)
  that named this machine. Passed on the second attempt: the first refused on a state-root artifact,
  which is the defect that plan's Chapter 4 records, and the run after that correction reported
  `Verified 77 hardened path(s)` and `Provisioned` with no `Set-Acl` error.
- **Run operator check E** from [`operator-checks.md`](../operator-checks.md), the verification the
  mirroring effort could not close from code. Passed in full: a mention and a timestamp inside a
  fenced code block render as literal text, an escaped line-leading quote opens no blockquote, and
  `-NoMirror` stopped one session's mirroring while another running beside it kept mirroring. Both
  claims the chip escape rests on are now observed rather than inferred.

- **Package the relay as a plugin and move SCOTT off the development flag.** Done in
  [`plans/channel-quality-and-plugin_spec_v1.md`](plans/channel-quality-and-plugin_spec_v1.md): the
  repository is a marketplace hosting the relay plugin (a launcher shim over the checkout's relay),
  SCOTT's managed settings allowlist it, and a live launch verified no warning dialog, the thread
  round-trip, and the plugin-scoped permission rule name observed on the wire
  (`mcp__plugin_relay_channel-relay__reply`).
- **Install the ASR host.** Done by the operator with
  [`plans/channels_install-simplification_v1.md`](plans/channels_install-simplification_v1.md)'s
  `Install-All.ps1`, the installer's first real end-to-end run, which was itself that plan's final
  acceptance gate.
- **Install the NEO host.** NEO was provisioned during the install-simplification effort (its
  wrapper entry flipped to `--channels` in that plan's Chapter 1), and the operator's live
  plugin-route verification on NEO closed the remaining gate.
- **Register the broker's scheduled task and restart it on this host.** The task
  `SapplefeldChannelsBroker` is registered on SCOTT and the broker was restarted onto current code
  by the elevated installer half; readiness confirmed on `/sessions`.
- **Retire the development-route allow rule (`mcp__channel-relay__reply`).** Removed from the six
  repository places that carried it, with the fragment, installer allowlist, and test pins now
  shipping the plugin-scoped rule alone, and swapped out of SCOTT's `~/.claude/settings.json` by
  hand (which had carried only the development rule; the plugin-scoped rule replaced it). The
  remaining per-host hand edits on NEO and ASR stay on the live backlog.
- **Make an inbound cut impossible for a deliverable message, and loud otherwise.** The inbound
  ceiling rose to Discord's own 4,000-character maximum, so no message a client can send is cut;
  a message over the ceiling is delivered cut with an unfloored in-thread notice asking for the
  tail as its own message. Closed by `channels_inbound-whole-delivery_spec_v1.md` the same day the
  operator hit the old silent 2,000 cut live.

## Completed 2026-08-09

- **Answer a console question from the thread.** Graduated to its own plan and delivered by it,
  [`plans/channels_question-answering_spec_v1.md`](plans/channels_question-answering_spec_v1.md):
  the broker holds the `AskUserQuestion` `PreToolUse` request open, posts the questions as an
  interactive message, and answers the hook with the operator's choices, with every failure of the
  hold releasing cleanly to the console picker. The two live checks that plan left open ride on the
  live backlog rather than here.

- **A usage and fleet-health card in the channel.** Graduated to its own plan and delivered by it,
  [`plans/channels_usage-card_spec_v1.md`](plans/channels_usage-card_spec_v1.md): one always-there
  "Fleet: Usage" thread whose card mirrors claude-swap's local cache rather than invoking a CLI
  that mutates credentials and spends a shared request budget, plus the model, context size and
  subagent roster on each session's own card. The operator-only deploy and walk survive on the live
  backlog rather than here.

## Completed 2026-08-16

- **The status card's context figure no longer doubles on a multi-iteration turn.** `contextTokens()`
  in `broker/tail.ts` reads one iteration of `usage.iterations` when the array is present and
  non-empty, and the top-level fields otherwise; the iteration chosen is the largest rather than
  the last, mirroring the kit compaction gate's `consumedFromUsage` rule and its fail-direction
  argument exactly, so the card and the gate cannot read one transcript row two ways. (The parked
  note said "last entry"; the kit's shipped rule is largest, and matching the shipped rule won.)
  Two regression tests pin the largest-iteration read and the malformed-array refusal, both watched
  red before the fix.

- **Draw the board card's project headings stronger.** Retired 2026-08-16 by
  [`plans/channels_render-tweaks_spec_v1.md`](plans/channels_render-tweaks_spec_v1.md) section 1,
  which went further than the item asked: the project label is no longer a heading at all but a
  one-line fenced block, which Discord paints as a full-width shaded box. `PROJECT_HEADING`, the
  constant the item named, no longer exists. The item's own reasoning is why the stronger answer
  won: the project is the boundary the card is scrolled by, and a shaded box separates two lists
  more sharply than any heading level does.

- **Order the plans within a project.** Retired 2026-08-16 by the same plan's section 2, built on
  the item's recommended key and settling the design point it left open. Plans order by modification
  time newest first, with the filename stem breaking a tie; projects order the same way by the
  newest plan under each, with `CHANNEL_BOARD_PROJECTS` as the tie-break and a project the card
  cannot date sinking below every one it can. The sort runs behind the per-root cap of 64, at the
  card rather than at the sweep, so it reorders whichever plans the name-ordered listing returned
  and leaves the cap defined against that listing exactly as before.

- **Make a cross-session exchange watchable from one Discord surface.** Retired 2026-08-26 by
  [`plans/channels_peer-traffic_spec_v1.md`](plans/channels_peer-traffic_spec_v1.md). Peer traffic
  now renders in both directions under its own `📡` register, unquoted, so the operator's `>>>`
  block stays theirs alone; the item's first step, reading how the mirror rendered peer traffic
  today, turned up two defects rather than a gap, an inbound message drawn inside the operator's
  own quoted register and an outbound one drawn nowhere at all. A peer prompt also no longer
  stamps engagement, so a message from another session cannot clear a `⛔` a person is owed.
  Verified on the live thread on 2026-08-26 rather than in the suite alone: three real messages
  from a peer session, two delivered mid-turn and one to a deliberately idle session, each
  rendered once under the peer attribution, and this session's own outgoing messages rendered
  too. The item's second half, a per-exchange view showing both halves of one conversation, was
  parked deliberately in the plan's Design section and not built: with both directions rendered,
  a session's own thread already carries every exchange it is party to, and no correlation
  identifier exists to key a cross-thread view on.

## Completed 2026-08-28

- Peer-chatter rendering in threads: subtext, not spoilers (parked 2026-08-27; operator-approved
  and slotted as the first post-reboot effort, in parallel with claude-kit's coordination spec).
  Delivered: the register shipped in `669cb8f` and the collapsed form in `d0cba9c`, and this item
  is retired at that plan's close-out. Session-to-session relays used to render at full size in
  the same voice as operator-facing lines, so the operator re-checked headers every few lines to
  know the audience, which from a phone was the dominant reading cost of a busy thread. The approved design: normal text for
  operator-facing lines; Discord's `-#` subtext (small grey type, scannable without a tap, one
  prefix per line) for session-to-session chatter, each block led by a bold one-line header naming
  sender and receiver so the routing stays readable at full size; spoilers reserved for oversized
  bodies nobody scans anyway. The rendering check is settled (2026-08-27, operator's phone client,
  a broker-posted three-form sample in this machine's relay thread): subtext renders small and
  grey with the bold header at full size, confirmed; `>` blockquote does not render on
  relay-posted messages at all (literal `>` characters at full size), which removes it as an
  option on this surface; spoilers render but occupy the same space as plain text and stay open
  once tapped, confirming them as worst-of-both for scannable chatter. The one alternative still
  standing is bot-authored embeds (colored sidebar cards), the strongest separation but a bigger
  broker change, not needed unless subtext proves insufficient in practice. This item owns the
  rendering-of-chatter surface; the spoiler-collapsed task-reports item above should take its
  rendering from whatever this decides, and the volume-of-chatter half (audience labels on relays,
  delta-only capped operator reports) lives in claude-kit's coordination spec under its 2026-08-27
  slate, so the two compose rather than overlap.
  Retired at the plan's close-out. The plan is archived at
  [`plans/channels_peer-chatter-rendering_spec_v1.md`](plans/channels_peer-chatter-rendering_spec_v1.md),
  whose Chapters carry the delivered design, the eight live readings, and the one accepted
  residual: inside a spoiler a tap has revealed, a peer body can compose a line shaped like the
  renderer's own attribution, because the escape that would mark it is one the client consumes.

## Ruled won't-fix 2026-09-22

- **Allow-list what a thread delivers instead of deny-listing one system type (parked 2026-08-17,
  from the title-states security review).** `classifyMessage`'s thread branch drops
  `ChannelNameChange` and delivers everything else, so any other system message type Discord posts
  into a thread reaches `onMessage` and the sender gate, stopped today only because no such type
  carries composed content, and past that by the empty-content guard in `inbound.ts`. A future
  Discord type that does carry text would reach a session as if the operator typed it. The
  hardening is to deliver `Default` and `Reply` in a thread and drop the rest; the pin-notice test
  ("a pin notice in a thread is delivered like any message") flips with it. Do it when the gateway
  is next open, and pin both directions.

  Ruled won't-fix by the operator on 2026-09-22, relayed by the coordinator, as excessive hardening not
  worth its review cost. No system message type carries composed text today, and the router drops
  empty text, so the thread keeps delivering every type but the rename notice.

## Planned 2026-09-22

The operator approved these for planning on 2026-09-22. Each now lives in the plan named above
its entries, so it has left the active list.

Owned by `plans/channels_tail-until-flake_spec_v1.md`:

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

  Measured by the owning plan on 2026-09-22, with the helper instrumented to name its condition and
  classify an expiry: 30 serial full-suite runs on SCOTT-CLAUDE, on a box polled clear before each,
  at 2006 tests, went red 3 times. All three were "a mirror run that landed nothing after the tailer
  deferred still gets the text posted", at its wait for the tailer's poll to settle, and each
  classified as the condition holding 22 to 25 ms after the 1,000-turn bound expired. None was a
  condition that never held. The cause is the bound's unit: the turns run out while the poll's
  thread-pool file calls are still in flight. One member failing three times is therefore not the
  regression signal the rule above describes, because the classification now settles which case a
  red is. The plan's Chapter 2 holds the counts and each red's record.

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
  (parked 2026-08-11, backfilled)

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

  Measured by the owning plan on 2026-09-22, after that instrument-first fix: 30 serial full-suite
  runs on SCOTT-CLAUDE gave 3 reds, each classified "held only after the bound", 22 to 25 ms late,
  and none "never held". So every observed red was a bound that expired early, not a tailer that
  failed to post. None of the 30 runs showed the expensive case this entry warned about, and the
  grace still reports it as "never held" if it occurs, which is what makes a wall-clock bound safe
  to adopt. The plan's Chapter 2 holds the counts and each red's record.

Owned by `plans/channels_shared-helper-owners_spec_v1.md`:

- Fold the eight duplicated `createRepeatLog` implementations into one. The rate-limited repeat
  logger is hand-copied into `broker/tail.ts`, `broker/question-desk.ts`,
  `broker/routing/interactions.ts`, `broker/discord/pins.ts`, `broker/usage/thread.ts`,
  `broker/board/thread.ts`, `broker/inbox/thread.ts`, and `broker/inbox/judge.ts`, each with its
  own window constant, so a fix to the throttling behavior has to be found in eight places. Low risk
  and no behavior change wanted; purely drift. The board card's round took the sixth copy
  deliberately, on the codebase's own precedent that a small terminal mechanism is duplicated per
  surface, and named three copies as the extraction threshold, and the operator inbox took the
  seventh and eighth on the same precedent. That threshold is now well past, so this is the round
  that should collapse them. (parked 2026-08-16, backfilled)

- The three standing cards' binding modules are near-duplicates. `broker/board/binding.ts`,
  `broker/usage/binding.ts` and `broker/inbox/binding.ts` differ only in identifiers and their
  header paragraphs. Accepted deliberately at the time, on the same per-surface-duplication precedent, with
  a fourth card named as the point to extract. The inbox card is that fourth card and took a third
  copy instead, so the extraction is due: the shape to build is a single card-binding module taking
  a label. (parked 2026-08-16, backfilled)

- Give the capped file read one owner, and fix the copy that does not loop (parked 2026-09-20,
  surfaced by the Fleet Board worker queues plan and routed here because that plan serves the board
  card rather than this family). Four modules now read a size-capped file into a buffer one byte
  larger so an oversized file is refused whole rather than truncated. Three of them loop the read
  until the descriptor is drained and say in a comment why. The fourth, `broker/usage/cache.ts:270-281`,
  performs a single `readSync` with no loop, so a short read hands the parser a prefix of the file
  under the name of the whole. That one is a confirmed defect rather than a style divergence, read
  against its three siblings. It fails closed, since a truncated JSON document does not parse, so
  the symptom is a usage card that reports itself unavailable rather than one that reports wrong
  numbers, which is why it is parked rather than fixed in flight. What it costs to leave is that the
  next author copies whichever of the four they happen to open. The shape of the fix is one module
  owning a parameterised capped read that the four call, with the cap and the subject as arguments.
  A smaller piece of the same convergence: `broker/board/queues.ts` carries hand-written copies of
  five helpers `broker/board/plans.ts` keeps unexported. They are `planStem`, the README-stem check,
  `bounded` with its `WHITESPACE_RUN` constant, the capped read inside `readPlanFile`, and
  `statPlanFile`. The queue reader's copy of the last also refuses anything that is not a regular
  file, which the sweep settles from its own listing instead, so a shared stat must keep that
  refusal for the reader. The queue reader was written that way deliberately, to keep its section
  inside its own files, and the exports are the cheap half of this item.

- Give the non-finite modification time guard one owner (parked 2026-09-20, surfaced by the Fleet
  Board worker queues plan's section 3 and routed here because that section's spec bounds
  `broker/board/card.ts` to four exports). Two modules now carry the same three-line clamp that turns
  a modification time which is not a finite number into negative infinity before a comparator sorts
  by it: `touchedAt` in `broker/board/card.ts` and in `broker/board/status.ts`. The guard exists because a
  comparator handed a value that is neither above, below nor equal to another orders nothing, so the
  word it decides lands wherever the loop happens to leave it. Neither copy is wrong today. What it
  costs to leave is that a writer and a reader hold one rule in two places, which is the shape
  through which a later edit to either moves a word with neither side's tests noticing. The fix is
  one exported clamp the two call. It was not taken in section 3 because exporting a fifth name from
  the card renderer would contradict a section line the operator approved.

## Completed 2026-09-23

- Write `docs/security-model.md` a `## Threat model` section (handoff 2026-09-21, from the Fleet
  Board worker queues plan's finishing security review, which opened `threat model: absent`). The
  document carries the accepted-risk sizing for each surface in prose, and the board-card passage
  plus the plan's Intent stood in for a model at that review. A stated model names the attacker
  classes (same-account code, a Discord account that is not the operator's, a peer on the store's
  remote), what each can reach, and which entries are accepted, so a security lens can cite an entry
  rather than reason from the prose. Operator-pending: the operator decides whether that section is
  written as its own effort. The operator inbox plan's finishing security review opened `threat
  model: absent` as well, and so did the judge-unmirrored-replies plan's on 2026-09-22.
  Done 2026-09-23: `docs/security-model.md` now opens with a `## Threat model` section naming
  eight attacker classes, T1 to T8, each with its reach and the entries that hold or accept it.
