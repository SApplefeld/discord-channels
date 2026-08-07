# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

- Run operator check F (`operator-checks.md`), the live watch of a long turn's narration, which now
  covers the coalesced surface: one growing `(edited)` message under one header, and a typed
  message breaking the block. Its first successful append is also the evidence that closes the
  open question of whether editing the bot's own message needs any permission beyond the six
  `install.md` already grants (a refused-append log line carrying a permissions error reopens
  that). A failed check reopens the narration-coalescing effort as a new round. SCOTT's broker
  already runs the coalescing code; NEO and ASR pick it up at their next `git pull` plus broker
  restart (or next logon, which restarts the task).
- Remove the retired `mcp__channel-relay__reply` rule from `~/.claude/settings.json` on NEO and on
  ASR: both were provisioned while the fragment still shipped it, and `Install-Host.ps1` never
  removes a rule already there. SCOTT's copy is already done.
- Measure duplication across the three streams that land in one thread in real use: the mirrored
  reply, the reply tool's answer, and mid-turn narration from the transcript tailer. Decide whether
  to suppress duplicates or coach the reply tool into a quick-summary role on top of the mirrored
  reply. The tailer already deduplicates itself against the Stop mirror, so what is left to measure
  is the reply tool against both of the others, and whether narration plus a full mirrored reply is
  more than one thread wants to carry. A working stretch is one growing message rather than one
  message per chunk, so what is left to measure there is duplicated text and not header volume.
  Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
