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
- Answering a console question from the thread, if Claude Code ever grows an extension point for
  it. Today the thread only alerts that an `AskUserQuestion` picker is open: no hook runs for that
  tool, nothing observes it, and the channel permission protocol's verdict vocabulary is
  `allow | deny` alone, so there is nothing to carry an option choice back. The shape wanted is
  "whatever the operator types in the thread becomes the picker's Other answer", which needs
  upstream support before any of it is buildable.
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

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
