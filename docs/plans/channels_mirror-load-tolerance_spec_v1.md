# Channels: mirror fidelity under machine load

Status: Ready
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

In `hooks/settings-fragment.json`: both mirror entries' `timeout` from 5 to 10, the top of the
designed band. In `hooks/settings-fragment.test.ts`: the band pin tightens to assert the value is
exactly 10 rather than a range that 5 also satisfies, with the comment carrying the load reasoning:
5s was observed insufficient on a saturated host (2026-08-25, five sessions plus a test gate), 10
is the band's own ceiling, and the escalation past 10 is a design decision about per-prompt latency
that belongs to the operator, not to a future edit that quietly widens the band. The fragment's
`_comment` and `docs/install.md`'s deploy note say what is true now: mirror timeouts are 10s;
hosts pick the fragment up at their next `Install-Host` run. The liveness ticks' 2s and the
question hook's hold-ceiling margin are untouched, and the existing pins prove it.

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

(Ready; none yet.)
