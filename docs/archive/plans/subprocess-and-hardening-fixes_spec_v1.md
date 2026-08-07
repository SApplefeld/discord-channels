# Subprocess Supersession and Silent Hardening

Status: Complete
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

- Follows [`docs/archive/plans/channel-mirroring_spec_v1.md`](channel-mirroring_spec_v1.md),
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

### Chapter 2 - 2026-08-07
Completed: 2. Harden loudly, and only when it is needed
Implemented By: implementer-opus, three review-fix rounds on the same agent
Metrics: 1 review round (adversarial + blind at fable, security at default), 3 fix rounds; 0
NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: **Both root causes were measured before a line was written, and the second
one changed the design.** `Set-Acl` writes the audit section, which nothing in this function sets, so
it demands `SeSecurityPrivilege` on an already-protected path while install step 2 must stay
unelevated. `$item.SetAccessControl(...)` writes only the section that was modified and succeeds
where `Set-Acl` throws, measured both directions on the same directory. Both writes moved to it; the
rollback keeps `Set-Acl` because its `$original` has no section flagged modified, so
`SetAccessControl` would persist nothing and the restore would become a silent no-op.

That mechanism change bought more than the fix: a re-install now REPAIRS drift rather than refusing
it. Verified unelevated on a temp tree shaped like a real install, in three passes: harden seven
paths, re-install as a clean no-op with ACLs byte-identical, then grant `Authenticated Users` on
`hooks/` and watch an ordinary re-install put it back to exactly the three-trustee grant.

**Review caught a regression the change introduced.** The writer accepted Administrators as a
permitted owner and left ownership alone, while `credentials.ts` exempts a grant only to the
descriptor's owner and the permitted trustees. Since the hardened list always names the installing
account by raw SID, an Administrators-owned path was hardened into a state the new verification then
rejects: an install that used to succeed would fail, with advice (re-run elevated) that cannot
change which owner the check accepts. Ownership is now taken whenever the owner is not the
installing account.

**The verification promised more than it delivered**, and the stronger remedy was taken rather than
the smaller sentence. It checked one representative file per directory while `Protect-ChannelPath`
is not recursive, so a child whose inheritance was already detached was never read back, and the
files the scheduled task actually executes at every logon were among the unchecked ones. It now
walks every file and subdirectory under the five trees and the state root. Measured cost, reported
rather than hidden: 73 files in 15.5 seconds on the real checkout, so roughly 20 seconds added to an
install, and the suite went from 60 to 103 seconds because pinning the walk requires six real
install runs.
Review Findings: Four Majors, all fixed: the ownership disagreement above; the representative-file
scope; nothing pinning that every tree is actually verified (dropping a tree from the list left every
test green, now parameterized and proved by mutation); and a rollback whose throw asserted "restored
its original ACL" even when the restore had failed and been swallowed, with a successful
take-ownership never rolled back at all. Minors fixed: the state root is now walked, a token file
this run wrote is deleted on a verification failure rather than left in plaintext at a path just
declared unprotected (a pre-existing `-BotTokenFile` is named as residue instead, since it is the
operator's), and change-narrative comments were reworded.

One reported Major did not survive contact with the runtime. The claim was that .NET omits callback
(conditional) ACEs from `GetAccessRules`, letting a conditional grant hide from the skip. Building a
real conditional ACE and measuring showed the managed rule count and the raw ACE count agree on
Windows PowerShell 5.1, and the conditional entry surfaces as an ordinary rule, so the fingerprint
already moves and refuses the skip. The count check added for it is inert on this runtime and kept
as defense in depth with a comment saying exactly that, plus a test pinning the behavior that does
the protecting.
Stamps: see the close-out.
Next: finishing-work
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-07
Completed: finishing-work
Implemented By: main session, with the qa-verifier and one combined final review at fable
Metrics: QA PASS; 1 combined finishing review; advisor opus
Decisions / Surprises: The per-section rounds had already run adversarial, blind, and security over
each section post-fix, and the two sections share no files, so the finishing pass was one combined
review scoped to cross-section cohesion, spec-versus-built, debris, and the honesty of the shipped
comments, rather than three duplicate deep passes. It confirmed the expected result on cohesion,
that there was little to find, and earned its keep elsewhere.

**A deviation from the Approach that Chapter 2 should have named and did not.** The Approach says the
already-hardened check should read `Assert-ChannelPathProtected`'s standard. The shipped skip instead
compares against the exact descriptor the write would apply, plus the owner, the protection flag, and
a raw-versus-managed ACE count backstop. That is the stronger design, because it makes the skip
provably no more permissive than the write rather than merely agreeing with a second opinion, and the
verifier's independent standard still guards the result through the install-time read-back. Recorded
here as a deliberate deviation rather than left implicit.

QA drove the two behavioral claims directly rather than trusting the tests: on a disposable tree,
hardening is idempotent (a second pass leaves the access list byte-identical) and repairing (an
`Authenticated Users` grant added with `icacls` is gone after an ordinary re-run). It also correctly
declined to conclude anything from the running broker, which predates these commits by sixteen hours.
Review Findings: One Major fixed that the diff-scoped rounds could not see: `docs/architecture.md`
still carried the same falsified claim about an inherited token being read as a supersession that
this effort corrected in the wrapper. The rule is to sweep the tree for a falsified claim rather than
the diff, and the sweep had missed the curated doc. A second Major fixed: the verification failure
message told the operator to take ownership, which cannot clear the shape the walk most often catches,
a child file whose inheritance was detached carrying its own grant, since re-running hardens the tree
roots and not their children. The message now names both repairs. Minors fixed: the synopsis omitted
`relay/` from the hardened surface it walks; a docstring claimed `Set-Acl` cannot perform either
write unelevated when the truth is it cannot RE-apply them, which is why only installs after the
first ever failed; and the empty-path guard was unreachable because the binder rejected an empty
array first, so it now carries `AllowEmptyCollection`.
Stamps: adjudicated at each Chapter; the sweep is in the close-out.
Next: none. The effort is complete.
Commit Model: Commit-and-Push

## Operator-pending

**Closed 2026-08-07.** The one acceptance criterion that named this host has been exercised.

- A re-install on this machine completes without the seven `Set-Acl` errors it printed before.
  **Result: passed**, on the second attempt. The first refused on a state-root artifact and is what
  Chapter 4 is about; after that correction the run reported `Verified 77 hardened path(s)` and
  `Provisioned`, with no `Set-Acl` error and no refusal.

### Chapter 4 - 2026-08-07
Completed: operator-pending item, the real re-install on this host
Implemented By: main session
Metrics: 0 review rounds (a scoped correction to a defect the operator's own run surfaced); advisor
opus
Decisions / Surprises: **The first real re-install failed, and the walk was the thing that was
wrong.** It refused on `broker-state.json` in the state root, reporting a grant to an account
"broader than its owner". Reading the actual state showed that file carrying three inherited access
entries and no explicit ones, so it was inheriting the hardened list exactly as intended. What
tripped the check was ownership: `broker-state.json`, `broker.env`, `discord-threads.json`, and
`relay-mcp.json` are owned by `BUILTIN\Administrators` on this host, having been written by an
elevated process at some point, while the list they inherit names the operator's account.

The verifier's rule is owner-relative by design, permitting a grant to the path's own owner plus
Administrators and SYSTEM, which is the correct standard for a credential file. Applying it to every
runtime artifact in the state root was the error: those files are written by the broker and the
launch wrapper, so each is owned by whichever process created it, and a correctly-inheriting state
file reads as granting a foreign account. The install was refusing a path that is exactly as
protected as it should be.

The state root is therefore verified through the token file alone, whose check covers the directory
holding it, which is also precisely the check the broker runs at every start. The five code trees
are still walked in full, which is where the walk's value was: their contents are source files that
should all be owned by the installing account. The count pin makes the token file's presence
observable, proved by dropping it and watching the test fail.

This is the operator-only criterion closing in the way that justifies keeping such criteria: no
amount of fixture work would have produced a state root with four Administrators-owned artifacts in
it, and the temp trees the section verified against were all created by the test process itself.
Review Findings: None dispatched. The change narrows a check rather than widening one, the narrowing
is argued above, and the full gate plus a red-first probe on the replacement pin cover it.
Stamps: none surfaced.
Next: none. The effort is complete.
Commit Model: Commit-and-Push
