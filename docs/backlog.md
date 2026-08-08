# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

- Run operator check F (`operator-checks.md`), the live watch of a long turn's narration, which
  covers the coalesced surface (one growing `(edited)` message under one header, and a typed message
  breaking the block) and the one-copy close (the turn's closing words appearing once, under
  whichever attribution posted them first). Its first successful append is also the evidence that closes the
  open question of whether editing the bot's own message needs any permission beyond the six
  `install.md` already grants (a refused-append log line carrying a permissions error reopens
  that). A failed check reopens the narration-coalescing effort as a new round. SCOTT's broker
  already runs the coalescing code; NEO and ASR pick it up at their next `git pull` plus broker
  restart (or next logon, which restarts the task).
- Remove the retired `mcp__channel-relay__reply` rule from `~/.claude/settings.json` on NEO and on
  ASR: both were provisioned while the fragment still shipped it, and `Install-Host.ps1` never
  removes a rule already there. SCOTT's copy is already done.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
