# A new machine launches without editing the wrapper

Status: Complete
Commit model: Branch-and-PR

## Goal

A machine that is not SCOTT, NEO or ASR launches wrapped sessions with no edit to any file in the
checkout, so its broker checkout stays clean and `Repair-Broker.ps1 -Pull` keeps updating it.

## Intent

Approved by the operator on Discord, 2026-10-01: "go ahead and fix that now". The defect came from
the coordinator, relayed from the persona session writing the client-sandbox runbook. The launch
wrapper refused any machine missing from `$script:ChannelFlagByHost`, a table in its own source. A
client host therefore had to edit tracked code, and `Update-ChannelCheckout` skips the pull on any
dirty tree. The one documented way around the edit, setting `CHANNEL_HOST_NAME` to a known name,
also relabels every card and record, because the broker reads that variable as its host label.

Not done: no change to the broker, the installer's behavior or `broker.env`. No per-host table
survives in another form.

## Approach

Every machine in the table already took `--channels`, so the table carried no per-host information.
The wrapper takes `--channels` by default. One user environment variable, `CHANNEL_LAUNCH_FLAG`,
overrides it with `--dangerously-load-development-channels` for the rollback `docs/install.md`
describes. Any other non-empty value refuses the launch. `Resolve-ChannelHost` and the table go.
`CHANNEL_HOST_NAME` remains the broker's display label and no longer affects the launch.

An environment variable rather than a `broker.env` key: `Set-ChannelEnvFile` carries forward only
keys on the broker allowlist when the installer rewrites that file, so a hand-added key would vanish
on the next `Install-Host` run and silently move the machine back to `--channels`.

Acceptance:

- With `CHANNEL_LAUNCH_FLAG` unset, on any machine name, the launch line is the plain-channels line.
- With it set to the development flag, the launch line is the development line.
- With it set to anything else, the wrapper throws naming the two accepted values, and `claude` is
  never called.
- `docs/install.md` no longer tells anyone to edit the wrapper, and documents the variable.

## Standing Brief Amendments

- The installer may change printed advice that names the wrapper's flag choice, as long as no step
  it runs or file it writes changes.
- `docs/security-model.md` records `CHANNEL_LAUNCH_FLAG` as a route choice among its environment
  control surfaces.
- A `CHANNEL_LAUNCH_FLAG` value is matched after surrounding spaces are trimmed, and a blank value
  reads as unset.

## Sections of Work

### Section 1: Flag from the environment
Model: opus
Locus: inline
Files in scope: wrapper/Enter-ClaudeSession.ps1, wrapper/launch-line.test.ts,
wrapper/no-mirror.test.ts, docs/install.md

### Section 2: Installer and threat-model pointers
Model: opus
Locus: inline
Files in scope: install/Install-All.ps1, install/Install-Host.ps1, docs/security-model.md

## Chapters

### Chapter 1 - 2026-10-01
Completed: 1. Flag from the environment
Implemented By: main session
Metrics: review rounds 1, closed major-closed; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: add-decision (section open): replace the host table with a default of --channels and a CHANNEL_LAUNCH_FLAG override; serves the Goal; adds no mechanism beyond what the Approach names; about 30 lines; not building it leaves every client host dirty and un-updatable. Add-decision (refusal-test Major): assert the refusal names both allowed flags; serves acceptance bullet 3; no mechanism; 5 lines; without it the bullet's half that matters is untested. Surprise: the stale-pointer sweep for `ChannelFlagByHost` missed two installer sentences that name the table in plain words ("channel-flag table"); both reviewers caught them, and they became Section 2 (approval drift, appended from this section). The Intent's "no change to the installer" was narrowed to the installer's behavior to admit those two sentences (approval drift).
Failed approaches: tried scripted string replacement without asserting each match landed; one replacement silently missed and the first red run failed on a ReferenceError rather than on the defect; every later scripted edit asserts its match count.
Assumptions: CHANNEL_LAUNCH_FLAG is a user environment variable rather than a broker.env key, because Set-ChannelEnvFile (install/Install-Functions.ps1:518-527) keeps only allowlisted keys on rewrite (decided 2026-10-01, section 1; reversible).
Review Findings: review: adversarial, blind and security at fable, Agent tool (capacity reader: "fable capacity: no reading (stale) -> ladder governs"; all three started and returned). Major addressed: installer pointers (blind and adversarial; moved to Section 2); refusal test pinned wording rather than the flag names (adversarial; fixed). Security verdict CLEAR. Minors: 3 fixed in the close pass (install.md 166-character line, case-sensitivity named in the refusal, security-model sentence via Section 2), 0 upgraded, 2 left: no padded-value test (trim is a tolerance no requirement names, and each case is a PowerShell spawn); control characters echoed in the refusal (only the operator's own account can set the variable).
Stamps: adjudicated 12, stamped 0 (operator-tier reads from earlier sessions; none bore on this section)
Gate: targeted lane, `node --test` over the three wrapper files and install/Install-All.test.ts and install/Install-Host.test.ts, 2026-10-01 09:22 EDT on branch plans/launch-flag-per-machine with this section's fixes uncommitted: 52 tests / 52 pass / 0 fail, exit 0, 33.1 s. Baseline on the three wrapper files at 7ec4576: 14/14/0, exit 0. Tests added 3: an unlisted machine launches on --channels with nothing set (pins the Goal); --channels named explicitly matches unset (pins bullet 1); a non-flag value refuses and names both allowed flags (pins bullet 3). Edited 2: the development-route and plain-route launch-line cases now set the flag through the environment, since the table they wrote into is gone. Spawning tests added: 3, each one PowerShell process through runLaunch. Contention: a foreign `node --test` run (PID 1004, another repository's suite, started 09:12) was live throughout.
Next: 2. Installer and threat-model pointers
Commit Model: Branch-and-PR
Delta: kit-size reports no measured corpus in this repository.

### Chapter 2 - 2026-10-01
Completed: 2. Installer and threat-model pointers
Implemented By: main session
Metrics: review rounds 0 (prose-only delta, author re-read), closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: add-decision (section open): reword two installer sentences and add one threat-model sentence; serves the Goal and acceptance bullet 4's intent that nothing tells an operator to edit the wrapper; no mechanism; 9 lines; without it the installer's closing banner sends every new host to a table that no longer exists.
Failed approaches: none
Assumptions: none
Review Findings: none raised against this section's own delta; it is the fix for Section 1's installer-pointer Major, checked by author re-read against that finding. A tree-wide sweep for "flag table", "channel-flag table", "host table", "table entry" and "ChannelFlag" outside docs/archive now matches only the new wrapper symbols; the same sweep matched both stale installer sentences before this fix, which is its control.
Stamps: none surfaced
Gate: the Section 1 targeted run above covers this delta (install/Install-All.test.ts and install/Install-Host.test.ts included): 52/52/0, exit 0.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: kit-size reports no measured corpus in this repository.

### Chapter 3 - 2026-10-01
Completed: finishing
Implemented By: main session
Metrics: review rounds 1 (finishing adversarial with performance and security folded in, plus the goal read), closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 4 declared, 0 asked); advisory: 0 findings; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "A machine that is not SCOTT, NEO or ASR launches wrapped sessions with no edit to any file in the checkout, so its broker checkout stays clean and `Repair-Broker.ps1 -Pull` keeps updating it."; The launch wrapper now starts every machine with the plain channel flag unless that machine's own user environment variable, CHANNEL_LAUNCH_FLAG, asks for the development flag, and it refuses any other value rather than guessing; the hard-coded list of three machine names is gone, so a client machine needs no edit to the code and keeps receiving updates, and the installer, install guide and threat model all describe the variable instead of the list; Refinements during the run: Section 2 appended from Section 1's review to fix two installer sentences that still pointed at the removed list; the Intent's "no change to the installer" narrowed to the installer's behavior to admit those sentences; three extras declared by the goal read and recorded in Standing Brief Amendments (installer advice text, the threat-model sentence, trimming of surrounding spaces); the environment variable chosen over a broker.env key because the installer drops unknown broker.env keys on rewrite; Operator-pending: none.
Decisions / Surprises: Finishing Minor pass: the refusal message and docstring now say the match happens after trimming; the plain-route launch test was retired as a duplicate of the outside-the-fleet test, since the wrapper reads no machine name, and its comment moved there; the refusal test no longer pins the list's comma; the threat-model sentence moved to its own paragraph. QA was self-run in the main thread (the full suite and the acceptance bullets, each pinned by a launch-line test) rather than dispatched to qa-verifier, and docs curation was done by hand in Sections 1 and 2 rather than by docs-curator: the change touched four documents, each already reviewed in its section and again by the finishing pass.
Failed approaches: none
Assumptions: none beyond Chapter 1's
Review Findings: review: finishing adversarial at fable, Agent tool, frontmatter effort (recorded as lower-effort than the high this pass names); verdict APPROVED, 0 Critical, 0 Major, 5 Minor. goal read at fable, Agent tool: 4 built-but-unasked (0 refused, 4 declared, 0 asked), 0 asked-but-unbuilt. Minors: 4 fixed in the close pass, 0 upgraded, 1 left: docs/operator-checks.md:165-167 says SCOTT keeps the development flag, already untrue at the base ref and outside this effort.
Stamps: none surfaced
Gate: whole gate at finishing, `npm test` on branch plans/launch-flag-per-machine at 0cc2ca9, 2026-10-01 ~09:30 EDT, clean tree: 2349 tests / 2348 pass / 0 fail / 1 skipped, exit 0 from its own marker, 64.9 s; the last recorded whole gate (PR #34 close) was 2346 / 2345 / 0 / 1. After the Minor pass, wrapper lane 16/16/0, exit 0 (one duplicate retired: retire class duplicate, its route still pinned by the outside-the-fleet test). Handoff gate, `npm test` over the final tree (Minor pass and archive uncommitted, origin/main not ahead), 2026-10-01 ~09:45 EDT: 2348 / 2347 / 0 / 1 skipped, exit 0 from its own marker, 59.5 s; the one fewer test is the retired duplicate.
Next: none
Commit Model: Branch-and-PR
Delta: kit-size reports no measured corpus in this repository.
