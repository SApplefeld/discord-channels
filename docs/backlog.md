# Backlog

The living handoff and next-steps doc. It carries active items only. When an item is done, it moves
out to a dated snapshot in `archive/` (`backlog-YYYY-QN.md`) rather than being struck through in
place.

Per-plan history does not live here. A plan's Chapters travel with the plan into `archive/` when it
closes. This file is for cross-effort next-steps that do not belong to any single open plan.

## Active

- Install the ASR host: its own Discord application, bot, and private channel, then
  [`install.md`](install.md) steps 2 through 4 on that machine from a fresh clone. Step 2 runs
  unelevated; only step 3 is elevated.
- Install the NEO host, same shape as ASR. Confirm first whether NEO is one VM or several; the
  system is one broker, bot identity, and channel per host name, and the wrapper's host table only
  knows `NEO`.
- Verify the plugin route on SCOTT and flip its flag. The repo now ships as a marketplace hosting
  the relay plugin; what remains is the operator half: write the managed-settings file, install the
  marketplace and plugin, run the four-point verification in [`install.md`](install.md)'s "The
  relay as a plugin", then move SCOTT's `$script:ChannelFlagByHost` entry to `--channels` and prune
  the losing allow rule from the six places that checklist names. Until then every host keeps the
  development flag and its keypress, which is what still blocks an unattended session supervisor.
- Register the broker's scheduled task and restart it on this host, so the windowless task and the
  mirror's quoting change take effect. The installer prints the exact elevated command, now carrying
  the pinned `-EnvFile`. The broker currently running was started before either landed.
- Now that mirroring has shipped, measure mirror-versus-reply-tool duplication in real threads, and
  decide whether to suppress duplicates or coach the reply tool into a quick-summary role on top of
  the mirrored reply. Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.

- [`archive/backlog-2026-Q3.md`](archive/backlog-2026-Q3.md)
