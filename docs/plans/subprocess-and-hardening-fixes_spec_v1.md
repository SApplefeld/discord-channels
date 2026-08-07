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

Supersession currently keys on a changed session ID rather than on the source, and `registry.ts`
states why: a `/clear` mints a new session ID and so does every other replacement, so the ID covers
the case even if the source field ever arrived wrong. That defensiveness is what has to be preserved
while the defect is fixed, because the cost of getting it wrong in the other direction is a `/clear`
whose new session never registers at all.

So the rule is inverted rather than replaced: **supersede unless the source is exactly `startup`.**
`/clear` sends `source: "clear"` (operator check B), and a fresh session sends `source: "startup"`,
confirmed against the live registry where every record, wrapped session and subprocess alike, reads
`startup`. An unknown, absent, or future source value therefore still supersedes, which keeps the
original protection intact; only the one value known to mean "a new process started" is treated as
the subprocess it is when it arrives under a token a live session already holds. A genuinely new
wrapped session gets its own token minted by the wrapper and never collides with a live one, so it
is unaffected.

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

### 1. A subprocess is not a supersession
Model: opus
`broker/registry.ts` treats a `SessionStart` whose `source` is exactly `startup`, arriving under a
token a live record already holds, as a subprocess of that session: the existing record keeps the
token and stays live, and the arriving session is not registered. Every other source, including an
absent or unrecognized one, supersedes exactly as it does today. The parent's own posts keep
routing, and no thread is opened for the child.
Acceptance: a `SessionStart` with `source: "startup"` under a live token leaves the live record
current and creates nothing; the same with `source: "clear"` supersedes as it does now; so does one
with a source the broker has never seen, and one with no source at all; a `SessionStart` under a
token no live session holds registers normally, which is the ordinary first announcement; a mirror
post from the parent still routes after a subprocess has announced.
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

### Chapter 1 - 2026-08-07
Completed: 1. A subprocess is not a supersession
Implemented By: implementer-opus, two review-fix rounds on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at default), 2 fix rounds; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **Two reviewers wanted the guard moved in opposite directions, and one
condition satisfied both.** Blind wanted it widened to protect a stale parent, on the grounds that a
parent is hook-silent exactly while a long tool runs. Security wanted it narrowed, because the first
implementation rested on a false load-bearing claim: it treated "a live record holds this token" as
proof a real parent exists, when any process that knows the token can create one with a single hook
post. That turned a self-healing supersession into a permanent, silent registration denial, since a
live record is skipped by both the prune and the eviction filter and the squatter can refresh it
forever, leaving the real session unwatched with the squatter's name on its card.

Gating the decline on the incumbent having an attached relay pipe closes both. A real wrapped session
has one; a record announced by hook posts alone does not, so the real session supersedes it and the
old self-healing is restored. Blind's stale case stops arising, because relay heartbeats hold an
attached session live independent of hook traffic.

Named accepted limits rather than closed: a subprocess launched as `claude --resume` sends
`source: "resume"` and still supersedes, because an in-session `/resume` sends the same source under
the same token and must supersede, so the source cannot separate them. A real session is unprotected
for up to one relay heartbeat (15s default) if its pipe attaches before its `SessionStart` lands. A
session whose relay never attaches at all keeps the pre-section behavior. And a squatter that
attaches a pipe first is protected like any other holder, which is the first-pipe-wins race
`docs/security-model.md` already accepts.

Two things were corrected that this section did not set out to touch, both stale claims in shipped
comments that a reviewer caught: `registry.ts` said whether `session_id` rides on a `PostToolUse` or
`Stop` payload was unconfirmed, which this session's measurements falsify, and the wrapper explained
its token restore by a supersession consequence that no longer holds.
Review Findings: Both Majors fixed and pinned red first. Security's second Major, that an impostor
`SessionStart` (the session-takeover attack the security model names) was logged under the same
generic reason and rate-limit bucket as the commonest benign drop, so an attacker could suppress the
only evidence of a takeover attempt by first posting a few ordinary drops, is fixed with its own
reason and its own bucket, pinned by a test that opens the benign window first. Minors fixed: the
new log line's comment claimed the session ID was published by `GET /sessions` when a declined
session is never published; the `lastRelayAt` doc still said the relay did not exist; the generic
drop comment claimed to be a forgery-only signal while a declined subprocess's ordinary traffic now
lands there too; and the straggler gate now fails closed on a mirror post with no `session_id`,
which changes nothing today and makes the failure mode a logged drop rather than another session's
conversation posted into this thread.
Stamps: see the close-out.
Next: 2. Harden loudly, and only when it is needed
Commit Model: Commit-and-Push
