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
- Run operator check E in [`operator-checks.md`](operator-checks.md), the only verification the
  mirroring effort could not close from code. Two things: whether Discord renders a mention pill or a
  timestamp chip inside a fenced code block and whether a backslash-escaped `>` opens a blockquote
  (the chip escape is fence-aware on the premise that it does neither, and the confined fix if it is
  wrong is dropping the fence exemption in `withoutChips`), and whether `-NoMirror` stops mirror
  posts on a real host while another session mirrors on. Either failing reopens the work as a new
  round.
- Now that mirroring has shipped, measure mirror-versus-reply-tool duplication in real threads, and
  decide whether to suppress duplicates or coach the reply tool into a quick-summary role on top of
  the mirrored reply. Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.
