# Channels: mirror fidelity under machine load

Status: In Progress
Commit Model: Commit-and-Push
Created: 2026-08-25

Running many simultaneous sessions saturates a host, and the mirror's hook timeouts start firing:
the operator observed repeated `UserPromptSubmit hook timed out after 5s — output discarded` on
2026-08-25 while five sessions plus a full test-suite gate ran at once. The two mirror hooks
(`UserPromptSubmit` and the second `Stop` entry, `hooks/settings-fragment.json:82` and `:122`) are
http posts the harness waits on, so a broker that answers late costs the timeout and the content
both. The two losses are not symmetric:

- A lost `Stop` mirror self-heals: the tailer re-reads the turn's final text within a poll interval
  and posts it, mislabeled `✨ Claude · working` instead of `✨ Claude` but present, and the echo
  memory keeps the healthy case to one copy.
- A lost `UserPromptSubmit` is permanent: the tailer recovers only mid-turn `queued_command`
  attachments, never the typed prompt that opens a turn, so the thread shows a reply with no
  question above it. This is the one hook timeout whose cost is unrecoverable content.

Two fixes, ordered so the cheap mitigation ships and deploys while the durable one is built:
raise the two mirror timeouts to the top of their designed band, then teach the tailer to recover
turn-opening prompts so prompt fidelity survives any mirror-hook loss, not just slow-but-under-10s
ones. The liveness ticks stay at 2s deliberately: they are paid per tool call, their loss costs
card staleness and a late engagement stamp rather than content, and the next tick heals them.

## Related

- [`channels_peer-traffic_spec_v1.md`](channels_peer-traffic_spec_v1.md): in flight as this plan is
  written, editing the same `lineItems` reader section 2 extends. This plan runs after it
  completes; section 2's implementer reads the landed code, not this spec's memory of it. Its
  ground-truth section also established the provenance stamps this plan's classification reads.
- [`../archive/plans/channels_mirror-fidelity-repairs_spec_v1.md`](../archive/plans/channels_mirror-fidelity-repairs_spec_v1.md):
  built the queued-prompt tailer path and the echo memory this plan adds a slot to.

## Ground truth

- The mirror timeouts are this repository's own choice: `hooks/settings-fragment.json` sets 5s on
  both mirror entries, and `hooks/settings-fragment.test.ts:278` pins them to the band 3..10s with
  the rationale "leave room for a whole reply and still bound the turn". The harness holds the turn
  open while a `UserPromptSubmit` http hook runs, so the timeout is worst-case added latency per
  prompt while the broker is slow-but-alive; a broker that is down refuses the connection instantly
  and costs nothing (the fail-open design).
- A turn-opening typed prompt's transcript line, confirmed 2026-08-25 in
  `f48916fc-0016-4883-8e13-3b93827a95ab.jsonl` (this repo's project transcripts): `type: "user"`,
  `promptSource: "typed"`, root-level `origin: {kind: "human"}`, a `promptId`, no `isMeta`, and
  `message.content` as a plain string. The harness stamps provenance on user lines generally:
  peer deliveries carry `promptSource: "system"`, `isMeta: true`, and `origin.kind: "peer"` (the
  peer-traffic plan's ground truth), so typed-by-a-person is a structural read, not a text sniff.
  Harness contract, movable upstream without notice; failure directions at the match site.
- A slash command's user line carries `<command-name>` markup in place of the words the operator
  typed (the tailer's `/goal` reading depends on this). Whether the mirror hook fires for local
  commands is unestablished; the recovery below therefore excludes command-markup lines, which
  keeps it inside what the mirror observably posts today.

## Sections of work

Gates for every section: `npm run lint`, `npm test`, baseline captured before the first change.
Coordinate with the peer-traffic plan's session: this plan starts only after that run completes,
so the tree is never shared.

### 1. The mirror timeout raise (fragment)

Model: sonnet
Locus: inline

In `hooks/settings-fragment.json`: both mirror entries' `timeout` from 5 to 10, the top of the
designed band. In `hooks/settings-fragment.test.ts`: the band pin tightens to assert the value is
exactly 10 rather than a range that 5 also satisfies. The comment carries the reasoning as
present-tense fact rather than as a dated observation, which is the house rule for a shipped
artifact: below the value a saturated host exceeds the budget and the prompt is lost, above it the
cost lands on every session on the machine, and the trade is the operator's to make in the
fragment rather than a later edit's to make quietly in the pin. The load observation and its date
live in the Chapter. The fragment's `_comment` and `docs/install.md`'s deploy note say what is
true now: mirror timeouts are 10s, changing one means editing the fragment and its pin together
because a host-side edit does not survive the installer's merge, and hosts pick the fragment up at
their next `Install-Host` run with nothing at launch reporting the drift until they do. The
liveness ticks' 2s and the question hook's hold-ceiling margin are untouched, and the existing
pins prove it.

Acceptance: the fragment carries 10 on exactly the two mirror entries; the suite is green; no
other timeout moved.

### 2. Turn-opening prompt recovery (tail, echo memory, outbound)

Model: opus

The tailer yields a turn-opening typed prompt as the existing `prompt` item kind, so it inherits
the queued path whole: the operator attribution, the unforgeable-quote escape, the channel-envelope
and task-notification checks, and the engagement stamp, all at `interimPrompt`'s existing seam.
Classification in `lineItems`, structural per the ground truth: a non-sidechain `user` line for
this session, `promptSource === "typed"`, root `origin.kind === "human"`, content read through
`userText`, excluded when the text carries `<command-name>` markup, and excluded when `isMeta` is
true. The peer shape is excluded by these tests already; keep the assertion explicit so the
peer-traffic plan's no-double-post rule survives both plans.

The normal case now produces the same prompt twice (the mirror hook within milliseconds, the
tailer up to a poll interval later), so the echo memory gains a prompt slot beside the reply pair,
worked the same way: the mirror-prompt path records and consults, the tailer-prompt path consults
and records, whichever arrives first suppresses the other's exact repeat, every match consumes the
record, digests only, never text. Both orderings are real: the tailer can read the line before a
slow mirror post lands. Declared residuals, accepted and stated in tests where cheap: a queued
mid-turn message whose text exactly repeats the last turn-opening prompt can be suppressed as its
echo (consume-on-match bounds it to one), and a recovered prompt arrives up to a poll interval
late and below any narration the turn already posted, which is honest transcript order. The fail
direction throughout is a duplicate prompt, never a lost one; the suppression must never be the
mirror's copy when both survive classification, so the faster path wins and the thread reads
identically to today's healthy case.

Tests red-first against real line shapes (fixtures from the transcript named above): recovery when
no mirror copy arrives, suppression in both orderings, command-markup and meta and peer exclusions,
engagement stamped by the recovered prompt, envelope and task-notification checks honored.

### 3. Live verification and docs

Model: fable

On a real session: type a prompt with the broker healthy and confirm one copy in the thread; stop
the broker's answer path or induce load (a second gate run suffices) and confirm the prompt still
lands from the tailer within a poll interval; confirm a slash command mirrors exactly as it did
before this plan. Update `docs/architecture.md` (the mid-turn narration section's three line shapes
become four, and the one-copy story now covers prompts) and `docs/operations.md`/`docs/install.md`
where the timeout is stated. Deploy: the fragment change reaches SCOTT, NEO, and ASR at their next
`Install-Host` plus broker restart; add that to the backlog's deploy walk rather than a new item.

### 4. Finishing

Model: fable

The finishing-work pass: qa-verifier against this spec, adversarial and blind reviewers over the
changeset, security-reviewer (the recovery reads untrusted transcript content into an
operator-attributed register, so the classification's structural gates are the surface), docs
curation, archive the plan.

## Chapters

### Chapter 1 - 2026-08-25
Completed: 1. The mirror timeout raise (fragment)
Implemented By: main session
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The section carries `Model: sonnet` and ran inline anyway, because it
writes `docs/install.md` and the docs-write-guard denies a non-curator subagent that write; the
section now records `Locus: inline` so the override reads as a routing decision rather than a
downgrade. The plan header arrived as `Status: Ready`, outside the kit's two-value vocabulary,
and was normalized to `In Progress` at the run's open so the SessionStart recovery inventory can
see it. Two surprises came out of the review round, both confirmed at source rather than taken on
report. First, a mirror timeout edited by hand in a host's own `~/.claude/settings.json` does not
survive: `Test-IsChannelHookEntry` recognizes this project's entries by their
`X-Channel-Hook-Event` header and never reads their timeout
(`install/Install-Functions.ps1:92-108`), and `Merge-ChannelHooksFragment` then drops and re-adds
them from the fragment verbatim (`:349-368`). The fragment's comment had invited exactly that
edit; it now names the two-file change that actually works. Second, the loss window for a timed
out `UserPromptSubmit` is narrower than the spec's framing: `broker/intake.ts:807-817` answers
202 only after reading the whole body and then delivers fire-and-forget, so a hook the CLI
abandons after that point still reaches the thread and one abandoned before it posts nothing.
What the raised value buys is the broker's room to reach that answer under load, which is a
better statement of the same fix, and the shipped comment says it that way.
Assumptions: The spec asked for a deploy note in `docs/install.md` stating the timeout; neither
that file nor `docs/operations.md` stated any timeout, so there was no stale figure to correct and
the note was written new, placed after the user-level-settings paragraph (declared 2026-08-25,
section 1). The spec directed the pin's comment to carry the load observation with its date; the
house rule keeps a dated change narrative out of a shipped artifact, so the comment states the
reasoning in the present tense and the observation lives here instead (declared 2026-08-25,
section 1). Spec section 1 was updated to match both, per the deviation rule.
Review Findings: One Critical, addressed: the first draft of the deploy note claimed the tailer
recovers a lost prompt, which is section 2's unbuilt work, and under Commit-and-Push that doc
would have reached origin while false. The note now states the loss plainly; section 3 adds the
recovery sentence once the code exists. Two Majors. The first is addressed: the fragment comment
invited a host-side edit the installer silently reverts. The second is justified rather than
fixed: nothing at launch compares an installed host's mirror timeout against the fragment, so
every already-installed host keeps 5 with no surface reporting the drift. Adding a launch-time
assertion is a different surface from this section's, and the spec already routes the deployment
through section 3's `Install-Host` walk; the drift is now stated in `docs/install.md` so it is at
least visible where an operator reads. Six Minors, five fixed (band-versus-exact-pin prose on both
surfaces, a quoted console line truncated before the character that was substituted out of it, the
dated narrative in the pin comment, the overstated loss window, the unnamed machine-wide blast
radius of the raise) and one noted: the literal 10 now sits in the fragment, the pin, and
`docs/install.md`, and only the first two are mechanically held together.
Stamps: adjudicated 7, stamped 7. `memq unstamped --since 2h` reported zero in both tiers, so the
seven were adjudicated off the recall digest's own hits: the CRLF-per-file rule and the
read-the-bytes verification, the `sed -i` strips-CR trap, the node:test count-line glyph, the
probe-with-a-control discipline, the reviewer tier substitution, and the JS replace dollar-sequence
trap. Each steered a concrete step in this section.
Next: 2. Turn-opening prompt recovery (tail, echo memory, outbound)
Commit Model: Commit-and-Push
