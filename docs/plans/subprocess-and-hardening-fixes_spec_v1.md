# Subprocess Supersession and Silent Hardening

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: finishing reviews only
Created: 2026-08-07

## Goal

Two defects found while running operator check E on the mirroring effort, both pre-existing and both
of the same family: a guard that fails without saying so. One silently stops a session being
mirrored; the other silently leaves the machine's execution surface unhardened while reporting a
successful install.

## Approach

**Both are silent-failure defects, so the acceptance bar is the noise, not only the fix.** This
project's own operations doc calls a mirror that stops without saying so the expensive failure, and
the same reasoning applies to an installer that hardens nothing and prints success. Each section
fixes the behavior and makes the failure path observable.

**Defect 1: any `claude` subprocess supersedes its parent's session.** `CHANNEL_PROCESS_TOKEN` is
inherited by every process a wrapped session spawns, so a `claude` invoked as a subprocess fires
`SessionStart` with a new `session_id` under the parent's token. The registry treats any new session
ID under a live token as a supersession, so the parent is marked ended, a thread is opened for the
child, and the parent's mirror posts are dropped from then on by the straggler gate in
`outbound.mirror`. It fails safe rather than misrouting, which is why it went unnoticed, but the
session stops being mirrored and nothing says so.

Measured on this host: eight `mirroring` records, seven of them one-turn probe subprocesses, the
parent marked `ended` at turn 9, and the token held by a throwaway headless run.

Supersession exists for `/clear`, which operator check B measured as firing `SessionStart` with
`source: "clear"` and a new session ID. A subprocess fires `source: "startup"`. A genuinely new
wrapped session gets its own token minted by the wrapper and never collides with a live one. So the
trigger for supersession is `source: "clear"`, and a `startup` arriving under a token a live session
already holds is a subprocess: the parent keeps the token, and the child is not registered.

**Defect 2: the installer's ACL hardening fails open and says nothing.** Two independent causes,
both confirmed by probe rather than reasoning:

- `Set-Acl` carries no `-ErrorAction Stop`, so its failure is non-terminating. The catch around it
  never runs, its descriptive throw never fires, and `Protect-ChannelPath` returns as though it had
  hardened the path. `Install-Host.ps1` then prints `Provisioned`. Confirmed: the same call with
  `-ErrorAction Stop` does throw and does restore.
- Re-applying a protected ACL to an already-hardened path requires `SeSecurityPrivilege`, which an
  unelevated session does not hold, while step 2 of the install is required to be unelevated.
  Confirmed: hardening a fresh directory unelevated succeeds, and hardening the same directory a
  second time throws.

So a first install hardens correctly and every re-install fails, invisibly. The fix for the second
cause is not elevation: a path already hardened to the standard needs no write. `Protect-ChannelPath`
checks first and writes only when the ACL differs, which also makes a re-install cheap.
`Assert-ChannelPathProtected` already encodes that standard and is what the check should read.

**What must not regress.** The hardening's purpose is the settings fragment's own security argument:
`hooks/` is executed by Claude Code at the start of every session on the machine, and the fragment
inherits `Authenticated Users: Modify` on at least one host until hardened. A "skip when already
correct" path that is wrong about "correct" is worse than the current bug, because it would report
success on a genuinely open directory. The comparison is therefore against the existing verifier
rather than a second opinion of what hardened means.

## Sections of Work

### 1. Supersede only on a real clear
Model: opus
`broker/registry.ts` supersedes a live record only when the intake's `source` is `clear`. A
`SessionStart` carrying any other source under a token a live session already holds is a subprocess
of that session: the existing record keeps the token and stays live, and the arriving session is not
registered. The parent's own posts keep routing, and no thread is opened for the child.
Acceptance: a `SessionStart` with `source: "startup"` under a live token leaves the live record
current and creates nothing; the same with `source: "clear"` supersedes exactly as it does now; a
`SessionStart` under a token no live session holds registers normally, which is the ordinary first
announcement; a mirror post from the parent still routes after a subprocess has announced.
Files in scope: `broker/registry.ts`, `broker/registry.test.ts`, and `broker/intake.test.ts` if the
intake's own tests assume the current behavior.
Tests: at minimum, both directions of the source check, the ordinary first announcement, and an
end-to-end case proving the parent's mirror post still reaches its thread after a subprocess
announcement, which is the defect's actual symptom. Prove the subprocess case red first.

### 2. Harden loudly, and only when it is needed
Model: opus
`Protect-ChannelPath` returns without writing when the path is already hardened to the standard
`Assert-ChannelPathProtected` enforces, and every `Set-Acl` it does run carries `-ErrorAction Stop`
so the existing catch, restore, and descriptive throw are reachable. `Install-Host.ps1` verifies
after hardening rather than assuming it: a failure to harden fails the install with a message naming
the path, rather than printing `Provisioned`.
Acceptance: hardening an already-hardened path is a no-op that neither writes nor throws, unelevated;
hardening a path that is not hardened still hardens it; a `Set-Acl` failure surfaces as a thrown
error naming the path rather than as a printed error the install continues past; a re-install on this
host completes without the seven `Set-Acl` errors it currently prints.
Files in scope: `install/Install-Functions.ps1`, `install/Install-Host.ps1`,
`install/Install-Functions.test.ts`, `install/Install-Host.test.ts`.
Tests: at minimum, the already-hardened no-op and the not-yet-hardened write, both unelevated
against a fixture directory; a failing `Set-Acl` proven to throw rather than warn; and a pin that
`Install-Host.ps1` verifies each path it hardened. Every test drives fixture paths under the
temp directory and never the repository or the operator's real state root.

## Out of Scope

- Elevating step 2 of the install. It is unelevated by design: a file created by an elevated shell is
  owned by Administrators and the broker's credential guard reads that owner shift as a planted token
  file.
- Changing what the hardened ACL grants. The three-trustee grant is unchanged; only when it is
  written changes.
- Cleaning up the stale `mirroring` records and their Discord threads already on this host. They age
  out of the registry after the retention window; the threads are the operator's to delete.
- The reply-tool and mirror duplication question, which stays where the mirroring plan left it.

## Related

- Follows [`docs/archive/plans/channel-mirroring_spec_v1.md`](../archive/plans/channel-mirroring_spec_v1.md),
  whose operator check E surfaced both defects. Neither was introduced by that effort; mirroring made
  the first one consequential and a re-install made the second one visible.

## Chapters
