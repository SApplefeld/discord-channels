# channels: a credential on the lineage thread takeover, v1

Status: Declined
Commit Model: none. The plan was declined before any branch was cut and no section of it was ever built.
Created: 2026-09-20
Worker: unassigned. This plan spans two repositories and needs the operator's word before it is armed, because the rollout order is load-bearing and the second repository was not opened to the effort that produced this spec.

## Goal

A session can claim a stable lineage name and take over the Discord thread that lineage already owns. That claim carries no credential today. Any process able to reach the broker on `127.0.0.1:8787` can announce a session it invented, name a lineage it does not own, and take that lineage's thread. It then receives the operator's typed steering in a thread the operator believes belongs to a trusted worker.

This plan puts a secret behind the claim, so that only a process holding the lineage's own key can take its thread.

## Why the obvious fix is not the fix

The broker cannot simply start requiring a key. The supervisor that would supply it lives in `agent_persona` (`bin/supervise.sh`), a different repository. A broker that enforces a key before the supervisor sends one refuses every legitimate rebind, which reopens exactly the problem the rebinding feature exists to solve: one new Discord thread per restart.

The reverse order costs nothing. The supervisor can start sending a key while the broker still ignores it, because an unknown header is already discarded. Once every live supervisor sends one, the broker begins enforcing. No session loses continuity at any point in that sequence.

So the rollout order is the design, not an implementation detail.

## What was built and never shipped

A partial defense was built during the rebinding plan's finishing pass (`channels_thread-rebinding_spec_v1.md`, "Interim board 1"). It was never merged. It lived only on branch `rebind-live-proof`, which was deleted when that plan was shelved, so none of it is in production and this section is a record of what was tried rather than of what protects anything.

That defense refused a takeover while the incumbent session still held an attached relay pipe, and it logged every lineage path. It closed the always-available form of the attack, so a thread could not be stolen out from under a session that was currently running.

What it left open was the restart gap. Between the supervisor killing its child and the replacement registering, no pipe is attached. A broker restart opens the same gap on a schedule, since the hub starts holding no pipes at all. A process that survived the kill can register first and take the thread. What it then keeps is not bounded by its own socket. A claimant that attaches a pipe of its own keeps the thread for as long as it holds that pipe, because the liveness guard then refuses the legitimate replacement on the claimant's behalf. One that attaches no pipe keeps the thread until a legitimate restart displaces it, while receiving none of the operator's steering. A second gap the liveness guard never reached is a process holding the incumbent's own `CHANNEL_PROCESS_TOKEN`. This plan would have closed all of these, because a key proves who is claiming rather than whether anyone is connected.

With the branch deleted, the starting point is earlier than the paragraphs above describe. The takeover on `main` has no credential and no liveness guard at all. The operator accepted that state on 2026-09-20; the close-out Chapter records the ruling.

## Decisions taken at scoping (2026-09-20)

**The key is per lineage and per supervisor lifetime, not per session.** The supervisor mints a fresh process token for each child, so no existing secret survives a restart to serve as the credential. A value the supervisor sets once and passes to every child it launches is the only thing with the right lifetime.

**The broker stores a hash, never the key.** The binding file sits on disk and is read by the fleet card path. A stolen binding file must not yield a working credential.

**First sight stamps the binding.** A lineage whose binding carries no hash yet accepts the first key it is offered and records it. Every later takeover under that lineage must match.

**First-sight stamping must not ship ahead of the supervisor.** On an unkeyed binding, first sight is a lockout primitive: whoever claims a lineage first owns it, and an attacker claiming one before the real supervisor restarts locks the real supervisor out. That is why the ordering below is mandatory rather than preferred.

## Sections of Work

### Section 1: the supervisor sends a key (repository `agent_persona`)

Model: sonnet. One shell file, an existing sibling pattern to mimic.

`bin/supervise.sh` already sets `CHANNEL_LINEAGE` once per supervisor lifetime and mints `CHANNEL_PROCESS_TOKEN` per child. Add `CHANNEL_LINEAGE_KEY`, generated once per supervisor lifetime by the same means the process token uses, and export it to every child alongside the lineage.

The broker ignores the header this produces until Section 3 ships, so this section is independently safe to land and must land first.

### Section 2: the hook forwards it (repository `discord-channels`)

Model: sonnet. Mirrors the existing lineage header exactly.

`hooks/session-start.ps1` reads `CHANNEL_LINEAGE` and sends it as `X-Channel-Lineage` behind a character gate. Do the same for `CHANNEL_LINEAGE_KEY` as `X-Channel-Lineage-Key`. Parse it in `broker/intake.ts` beside the lineage. The broker reads it and does nothing with it yet.

Note for the worker: the existing gates on that file use `$` as the end anchor, which in .NET regex also matches before a trailing newline, so a value ending in a newline passes the gate and then throws when the header is added. Use `\z`. Fix the two pre-existing gates in the same change and say so.

### Section 3: the broker enforces (repository `discord-channels`)

Model: fable. Security-sensitive, and the ordering constraints are subtle.

Persist a key hash on `ThreadBinding` beside `lineage` and `startedAt`, widening for a snapshot that predates the field. At the takeover site in `broker/discord/surface.ts`, require the incoming session's key to hash to the stored value. A binding with no stored hash accepts and records the first key offered. A takeover offering no key at all is refused once any hash is stored.

Keep the relay-pipe liveness guard that the rebinding plan's "Interim board 1" added. The two are independent: the key proves who you are, the pipe guard refuses to disturb a session that is currently working.

Log every refusal with its reason, never with the key or the hash.

**Do not start this section until the operator confirms every live supervisor is running Section 1's code.** A supervisor still running the old build sends no key, and its first rebind after this ships would stamp nothing and then be refused on the one after.

### Section 4: the security model records it

Model: inline.

Update `docs/security-model.md`. The lineage paragraph added by the rebinding plan names the restart-gap residual as accepted. Replace that with the credential, its storage, its first-sight rule, and whatever residual genuinely remains.

## Gate

- Baseline recorded on a clean tree before anything is touched, as pass and fail counts with the exit code read from the run.
- Each section closes on the targeted lane green, then the whole gate green, with the red-then-green record for every new test in the Chapter.
- Section 3 additionally requires a test driving the real attack shape: a stored hash, a takeover attempt offering a wrong key, and a refusal, plus the companion proving the right key still succeeds.
- The fresh-context reviewer pair runs over Sections 2 and 3.

## Out of Scope

- Changing how the broker authenticates anything other than the lineage takeover. The process token's own handling is untouched.
- Binding the broker to anything other than the loopback interface.
- Any change to the rebinding behavior itself: which thread a lineage owns and when it moves is settled and stays settled.

## Operator Verification

After Section 3, restart a supervisor and confirm its thread still carries over. Then confirm the broker log shows a takeover accepted with a key match, rather than the unkeyed acceptance the first-sight rule allows before a hash exists.

## Chapters

### Chapter 1 - 2026-09-20 (close-out)
Completed: nothing. This plan was never armed and no section of it was built.

Operator decision (decided 2026-09-20): declined, on the same ruling that shelved the rebinding plan. The stated ground is that a local desktop-only virtual machine in a sandbox does not warrant closing edge-case security holes, and that there is no realistic scenario in which one session maliciously takes over another's thread to feed it false steering. A conflated lineage name would surface as a session visibly confused by the steering it received, which the operator would notice.

Why it is archived rather than deleted. The plan existed only on branch `rebind-live-proof`, which was deleted in the same close-out. Archiving it preserves the analysis, chiefly the rollout-order finding: the broker cannot begin requiring a key before the supervisor in the separate `agent_persona` repository begins sending one, or every legitimate rebind is refused and the feature's whole purpose is undone. Anyone reviving this line of work needs that finding and would otherwise pay for it twice.

What remains true without it. The lineage takeover on `main` carries no credential and no liveness guard, since the guard was on the deleted branch. Any process that can reach the broker on `127.0.0.1:8787` can announce an invented session, name a lineage it does not own, and take that lineage's thread. This is the accepted state, not an open defect awaiting a fix.

Assumptions: none.
Review Findings: none; no code changed.
Gate: no code delta. The repository's own gate ran over the archival commit that carries this Chapter.
Next: none. Declined and archived.
Commit Model: none
