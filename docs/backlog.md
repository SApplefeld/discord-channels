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
- A session that spawns `claude` as a subprocess supersedes its own registry record. The child
  inherits `CHANNEL_PROCESS_TOKEN` and announces a new session ID under it, so the parent is marked
  ended, a thread is opened for the child, and the parent's mirror posts are dropped by the
  straggler gate from then on: mirroring stops for that session with nothing saying so. Any new
  wrapped session mints its own token and never collides, so the fix is to supersede only on
  `source: "clear"`, which check B measured as what `/clear` sends, and to treat a `startup` under a
  token a live session already holds as the subprocess it is.
- Fix the installer's silent ACL-hardening failure. `Set-Acl` in `Protect-ChannelPath` carries no
  `-ErrorAction Stop`, so its failure is non-terminating: the surrounding catch never runs, the
  descriptive throw never fires, and the installer reports success having hardened nothing. Root
  cause the `SeSecurityPrivilege` refusal first, since adding the flag alone converts a silent
  failure into a blocked install. `Install-Host.ps1` also never calls `Assert-ChannelPathProtected`,
  the verifier that already exists beside it.
- Now that mirroring has shipped, measure mirror-versus-reply-tool duplication in real threads, and
  decide whether to suppress duplicates or coach the reply tool into a quick-summary role on top of
  the mirrored reply. Deliberately excluded from
  [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md);
  measure first.

## Snapshots

Completed items are archived to `archive/backlog-YYYY-QN.md`.
