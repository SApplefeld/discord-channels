# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

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
- Two live checks the question-answering round could not close from code, both needing a real held
  question at a console with the thread beside it
  ([`archive/plans/channels_question-answering_spec_v1.md`](archive/plans/channels_question-answering_spec_v1.md)
  is the delivered plan). First, stopping the broker while a question is genuinely held: the desk
  releases every held hook on shutdown so the console picker takes over, which is tested against a
  synthetic entry but never against a live socket, and the failure it guards is a session wedged
  with no picker on either surface. Second, clearing a multi-select back to nothing and re-picking
  before submitting, the one interaction path where Discord's own component state, not the desk's,
  decides what arrives.
- Fold the five duplicated `createRepeatLog` implementations into one. The rate-limited repeat
  logger is hand-copied into `broker/tail.ts`, `broker/question-desk.ts`,
  `broker/routing/interactions.ts`, `broker/discord/pins.ts`, and `broker/usage/thread.ts`, each
  with its own window constant, so a fix to the throttling behavior has to be found in five places.
  Low risk and no behavior change wanted; purely the drift that a sixth copy would make worse.
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
     is one constant, `BAR_GLYPH` in `broker/usage/card.ts`, with `─` (U+2500) as the named
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

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
