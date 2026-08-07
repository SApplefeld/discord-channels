# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

- Install the ASR host: its own Discord application, bot, and private channel, then
  [`install.md`](install.md) steps 2 through 4 on that machine from a fresh clone, plus the plugin
  route ("The relay as a plugin": managed settings in the elevated step, marketplace and plugin
  install, first-launch verification, then flip ASR's table entry). Step 2 runs unelevated;
  elevation covers step 3 and the managed-settings file.
- Install the NEO host, same shape as ASR. Confirm first whether NEO is one VM or several; the
  system is one broker, bot identity, and channel per host name, and the wrapper's host table only
  knows `NEO`.
- Retire the development-route allow rule (`mcp__channel-relay__reply`) once ASR and NEO run the
  plugin route: the six repository places and the per-host hand edit are listed in
  [`install.md`](install.md)'s "The relay as a plugin". Until the last host leaves the development
  route, both rules stay by design.
- Register the broker's scheduled task and restart it on this host, so the windowless task and the
  mirror's quoting change take effect. The installer prints the exact elevated command, now carrying
  the pinned `-EnvFile`. The broker currently running was started before either landed.
- Measure duplication across the three streams that now land in one thread in real use: the mirrored
  reply, the reply tool's answer, and mid-turn narration from the transcript tailer. Decide whether
  to suppress duplicates or coach the reply tool into a quick-summary role on top of the mirrored
  reply. The tailer already deduplicates itself against the Stop mirror, so what is left to measure
  is the reply tool against both of the others, and whether narration plus a full mirrored reply is
  more than one thread wants to carry. Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
