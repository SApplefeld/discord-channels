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
- Remove the retired `mcp__channel-relay__reply` rule from `~/.claude/settings.json` on NEO and on
  ASR: both were provisioned while the fragment still shipped it, and `Install-Host.ps1` never
  removes a rule already there. SCOTT's copy is already done.
- Inbound truncation is silent: the broker cuts a channel message to 2,000 code points
  (`MAX_INBOUND_TEXT_LENGTH`, `broker/routing/inbound.ts`) with no in-thread notice and no marker on
  what the session receives, so a long dictation loses its tail with no signal on either end, which
  the operator hit live on 2026-08-08. Options, cheapest first: an in-thread truncation notice, a
  truncation marker appended to the delivered text, or raising the constant toward Discord's 4,000.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
