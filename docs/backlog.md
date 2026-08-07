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
- Package the relay as a channel plugin in a marketplace. Removes
  `--dangerously-load-development-channels` and its launch-dialog keypress on every host, which is
  what an unattended session supervisor is blocked on. See the launch-dialog section of
  [`install.md`](install.md).
- Re-run the installer on this host, unelevated, and confirm it completes without the seven
  `Set-Acl` errors it printed before. That is the one acceptance criterion of
  [`archive/plans/subprocess-and-hardening-fixes_spec_v1.md`](archive/plans/subprocess-and-hardening-fixes_spec_v1.md)
  that names this machine; the behavior is verified on a disposable tree but not on the real
  install. It is also what puts the windowless scheduled task and the mirror's quoting change into
  effect, so it is one run rather than three.
- Now that mirroring has shipped, measure mirror-versus-reply-tool duplication in real threads, and
  decide whether to suppress duplicates or coach the reply tool into a quick-summary role on top of
  the mirrored reply. Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.
