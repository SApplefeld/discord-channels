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

## Standing Brief Amendments

Every entry here binds every section opened after it, dispatched or inline.

- **A comment, doc line, or log line states only what the code actually does.** Two review rounds
  produced this class in a row: section 1 shipped a deploy note claiming a recovery that did not
  exist yet, and section 2 shipped a fail-direction comment describing behaviour its own code
  contradicted plus two drop lines naming a path the code cannot know was involved. Before writing
  any explanatory line, trace the claim through the code you just wrote and confirm it holds in
  every configuration the knobs allow, the single-path ones included. A drop or log line in
  particular is the operator's only discriminator between a deliberate suppression and a broken
  path, so it states what is known rather than what is usually true.

- **Trace the arming path and re-derive the figure, not just the working path and the prose.** The
  entry above did not hold: the class returned a third time in section 3, on the two shapes it does
  not reach. A coverage claim was traced through the code that does the work and not through the
  code that arms it, so a doc promised a recovery in exactly the state the tailer sets its read
  baseline and cannot deliver one. And a figure was carried out of a Chapter into a shipped doc
  without re-deriving what it had measured, so a number recorded as the population a gate admits
  was republished as the cost that gate imposes. So a claim about when something happens traces the
  initialization and arming paths as well, and any figure is re-derived at the source that produced
  it rather than copied from earlier prose about it.

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
this session, `promptSource === "typed"`, root `origin.kind === "human"`, excluded when the text
carries `<command-name>` markup, and excluded when `isMeta` is true. The peer shape is excluded by
these tests already; keep the assertion explicit so the peer-traffic plan's no-double-post rule
survives both plans.

The content is read through a reader narrower than `userText`, and the narrowing is a security
gate rather than a convenience. `userText` joins every text block with a newline, which is right
for finding a command in a line and wrong for republishing one as the operator's own words: a
harness that ever attached an injected block to a typed line would have that text published inside
the operator's unforgeable quoted register. So the reader admits a plain string, or a content array
holding exactly one `text` block beside any number of `image` blocks, which is the operator
pasting a screenshot with their prompt, and refuses everything else. An image carries no text and
cannot reach the register. This one gate therefore fails toward no recovery rather than toward a
duplicate, against the direction the rest of this section takes. The image allowance is what keeps
that failure notional rather than real: about three percent of typed prompts on this machine carry
an image beside their words, and refusing them would have cost the recovery on all of those. What
is refused is a second text block or a block of an unknown kind, neither seen on this machine.

The normal case now produces the same prompt twice (the mirror hook within milliseconds, the
tailer up to a poll interval later), so the echo memory gains a prompt **pair** beside the reply
pair, built the way the reply pair is built rather than as one shared record: `promptMirror` is
written only by the mirror path and read only by the tailer path, `promptTailer` the reverse.
Two slots make a path consuming its own claim structurally impossible instead of conditionally
impossible, and they keep the deferral bits disjoint so one path's fresh claim cannot spend the
deferral the other path's still-running delivery is owed. Whichever arrives first suppresses the
other's exact repeat, every match consumes the record, digests only, never text. Both orderings
are real: the tailer can read the line before a slow mirror post lands. On a host running the
mirror with interim mirroring off no tailer is constructed at all, so that host writes
`promptMirror` and reads a `promptTailer` that is always null: the dedup is inert there by
construction rather than by a tag.

A claim expires. Without a bound, a claim the tailer never answered (its transcript past the read
ceiling, a freshly learned session, a broker restarted mid-turn) stands indefinitely and swallows
the next identical prompt that has no live competitor, which is the exact loss this plan exists to
prevent. Each prompt claim is stamped with the time it was made and refused once older than
`promptClaimMs`, derived as `Math.max(60_000, interimPollMs * 3)` on the house pattern the
registry's fallback-attach window and the pass watchdog already use. Three intervals rather than
the one the duplicate window physically spans, because the module already treats a pass outlasting
an interval as normal and does not call one overdue until three: a claim window narrower than a
delay the module itself tolerates would cost a duplicate on every slow pass. The clock is injected
so a test moves it without sleeping.

The bound caps that loss without closing its generator, so the claims are also given up wherever
the tailer's read position jumps over bytes it will never read. There are four such jumps (the
probe's own baseline, the fallback rebaseline after a dropped offset, the shrink branch, and the
skip past the read ceiling) and each one is the tailer guaranteeing it can no longer answer a claim
standing behind it. Only the two prompt claims are given up; the deferral bits are not, because a
deferral records something that already happened to a run still in flight and dropping it would
take away the one retry that run is owed.

The queued mid-turn message stays out of the dedup entirely, neither claiming nor consulting. It
fires no prompt hook, so it has no second copy anywhere: a claim it makes serves nothing and can
only swallow a later prompt, and a consult it makes can only lose the operator's own words to a
standing mirror claim. The two shapes are already distinct at classification, so the item kind
carries which one it is and the router branches on it. The fail direction throughout is a
duplicate prompt, never a lost one; the suppression must never be the mirror's copy when both
survive classification, so the faster path wins and the thread reads identically to today's
healthy case. The one accepted residual is timing rather than loss: a recovered prompt arrives up
to a poll interval late and below any narration the turn already posted, which is honest
transcript order.

The engagement stamp is taken at the instant the prompt was typed rather than the instant it was
read. The stamp is what clears a standing blocked state, and the derivation is a comparison of
times, so a recovered prompt stamped at read time would clear a block the turn that prompt started
went on to raise. The prompt item therefore carries the transcript line's own instant, the router
passes it to the registry, and the registry never moves the field backwards. A line naming no
readable instant falls back to read time. On the mirror path the stamp stays where it is, ahead of
the dedup: that hook fires as the operator presses return, so it cannot be newer than a block
raised by the turn its own prompt started, and a suppressed mirror stamping again is a duplicate
stamp with no hazard behind it.

Tests red-first against real line shapes (fixtures from the transcript named above): recovery when
no mirror copy arrives, suppression in both orderings, an expired claim posting rather than
swallowing, a queued mid-turn repeat posting both copies, the cross-path deferral surviving the
other path's fresh claim, a deferral surviving an offset jump that gives up the claims, every
offset jump giving up the claims behind it, an interim-off control proving the tailer slot can
never match there, a block surviving the recovery of a prompt typed before it and clearing for one
typed after it, an image-bearing prompt recovered and a second text block refused, command-markup
and meta and peer exclusions, envelope and task-notification checks honored.

### 3. Live verification and docs

Model: fable

On a real session: type a prompt with the broker healthy and confirm one copy in the thread; stop
the broker's answer path or induce load (a second gate run suffices) and confirm the prompt still
lands from the tailer within a poll interval; confirm a slash command mirrors exactly as it did
before this plan. Update `docs/architecture.md` (the mid-turn narration section's line-shape count and the
one-copy story, which now covers prompts) and `docs/operations.md`/`docs/install.md` where the
timeout is stated. `docs/security-model.md` is in scope too: its allowlist enumeration of the
shapes the tailer admits gains the turn-opening prompt, and its accepted risk on the operator
attribution resting on the transcript file now covers the ordinary turn-opening prompt through a
shallower shape rather than the mid-turn message alone. The precondition has not changed, since
both rest on write access to the transcript, but the enumeration is the control a reader checks
against, and nothing else in this plan would have caught it. Deploy: the fragment change reaches SCOTT, NEO, and ASR at their next
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

### Interim board 1 - 2026-08-25
Section 1 is closed and pushed as `a22adcf`. Section 2 has taken two review rounds and is about to
take a third dispatch. Nothing is in flight as this is written; no dispatch is live.

**Section 2's stage.** Built, gates green, twice reviewed. Round 1 (adversarial, blind, security,
all at opus/max) returned one Critical all three found independently: the echo memory's prompt slot
carried no record of which path claimed it, so a path consumed its own claim and a repeated prompt
was dropped with `status: "sent"` and nothing posted. Reachable on a host with `CHANNEL_MIRROR` on
and `CHANNEL_INTERIM_MIRROR` off, and also whenever an unconsumed claim is left standing, which the
tailer's own offset rules produce (a transcript past the read ceiling, a freshly learned session, a
broker restarted mid-turn). Fixed by tagging each claim with the path that made it, with three
regression tests watched red first. Round 2 (adversarial, blind, at opus/xhigh) returned no
Critical and several Majors that share one root: one overwritable, turn-unbounded record cannot
serve two message shapes whose path counts differ. A queued mid-turn message fires no hook and so
has no second copy to dedup against, yet it claims and consults the same slot a turn-opening prompt
does; a fresh claim by either path wipes the deferral bit the other path's still-running delivery
needs; and a claim outlives its turn, so a stale one suppresses a later identical prompt with no
live competitor. The claimant tag was a correct fix for round 1's defect and does not reach these.

**Live dispatches.** None. Round 2's first attempt (three reviewers at opus/max) wedged: all three
transcripts stopped growing within the same second, ended mid-tool-result, and the run's journal
held only `started` lines for 49 minutes. Read as a common-cause environment fault rather than
three independent stalls, stopped with TaskStop, and re-dispatched once as two reviewers at
opus/xhigh, which returned normally. The security reviewer was not re-run in that second attempt;
section 4's finishing pass runs a security-reviewer over the whole changeset, which is where that
coverage lands.

**Gate baseline.** Section 1's opening baseline was 1463 tests, 1462 pass, 0 fail, 1 skipped, exit
0. The tree now stands at 1492 / 1491 / 0 / 1, lint exit 0, measured by the implementer on a box
carrying no review agents. This session's own full-suite run, taken while three review agents
worked the same box, came back
with one failure, `a tailer run that landed nothing after the mirror deferred still gets the text
posted`, inside `tail.test.ts`'s own `until` helper. Three isolated runs of that file returned
152/152 exit 0. That is the flake `docs/backlog.md` already records with receipts from a clean tree
at `3417f79`, predating every line of this plan; this section added a member to the group it
covers, and the backlog entry now says so.

**Rulings adopted since the last boundary.**
- Section 1 ran inline despite its `sonnet` tier, because it writes `docs/install.md` and the
  docs-write-guard denies a non-curator subagent that write. Recorded as `Locus: inline`.
- The plan header's `Status: Ready` was normalized to `In Progress`, the kit's own vocabulary.
- Section 1's second Major, that nothing at launch compares an installed host's mirror timeout
  against the fragment, was justified rather than fixed: adding a launch-time assertion is a
  different surface, and the spec already routes deployment through section 3's `Install-Host`
  walk. The drift is now stated in `docs/install.md` where an operator reads.
- A `## Standing Brief Amendments` block was created after two consecutive rounds produced the same
  class: a comment, doc line, or log line that asserts something the code does not do. It binds
  every section opened after it.
- `docs/security-model.md` was added to section 3's docs scope. Its allowlist enumeration of the
  shapes the tailer admits is stale against section 2's new shape, and nothing else in this plan
  would have caught it.

**Next action per section.** Section 2: adjudicate round 2 through a consult on the spec's own
one-slot premise, since the defect class repeated across two rounds and the implementer executed
the brief faithfully both times, which points at the premise rather than the tier. Then re-dispatch
with the ruling folded in, re-review, and close. Section 3 (live verification and docs) and section
4 (finishing) follow in order.
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-25
Completed: 2. Turn-opening prompt recovery (tail, echo memory, outbound)
Implemented By: implementer-opus (four review rounds; one consult on the spec's own premise; no
tier escalation)
Metrics: 4 review rounds; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises: The spec's central mechanism was wrong and a fresh-context consultant said
so. The spec asked for one prompt slot in the echo memory, justified as "mirroring the
pre-existing interim and reply slots". Those slots are a pair, one per path, and `broker/tail.ts`
said so verbatim in a comment predating this plan; one shared slot broke the pattern rather than
copying it, and the claimant tag round 1 added was restoring by convention what the existing pair
gets by construction. Both of the first two rounds' defect sets are downstream of that one
departure. The section now ships the pair: `promptMirror` written by the hook path and read by
the tailer, `promptTailer` the reverse. Two further rulings came with it. The queued mid-turn
message leaves the dedup entirely, neither claiming nor consulting, because it fires no hook and
so has no second copy for either operation to answer for; a consult it made could only lose the
operator's words to a claim standing over an earlier prompt of the same text, which the suite was
pinning as an accepted residual while the spec's own fail direction forbade it. And a claim
expires, because a claim the tailer never answers (a transcript past the read ceiling, a session
learned mid-turn, a restarted broker) would otherwise stand over the next identical prompt
forever, destroying with the recovery the very prompt the recovery exists to save.

Two review rounds produced Criticals, rounds 1 and 3, and the escalation ladder's comparison was
run before deciding not to spend a tier bump: the classes do not repeat. Round 1's was the
self-suppression the shared slot made possible; round 3's was an engagement stamp taken ahead of
the dedup consult. Different ground, so the ladder routes to a consult on the premise rather than
a stronger implementer, and that consult had already run and produced round 3.

Round 3's Critical is worth recording in full because it is the section's least obvious hazard.
The engagement stamp is what clears a standing blocked state, and the derivation is a comparison
of times. A recovered prompt stamped at read time is stamped up to a poll interval after it was
typed, so a session that opened a turn with that prompt, ran, and stopped BLOCKED inside the poll
interval had the block it just raised cleared by its own opening prompt. Round 3 closed the half
where the copy was suppressed; round 4 found the other half, the recovery path itself, still open.
The fix is that the prompt item carries the transcript line's own instant and the registry stamps
with it, never moving the field backwards. That is correct in both directions rather than only
one: a prompt typed before a block no longer clears it, and a prompt typed after one still does.

Two comments shipped in round 3 asserting measurements that do not survive a full-scale sweep, and
one of those measurements was this session's own. A subsample of six transcripts per project
directory said no queued mid-turn prompt ever also appears as a typed user line, and that figure
went into a dispatch brief and from there into a shipped comment. Across all 318 transcripts on
this machine it is 2 of 106, both intra-session, and both trace to two separate operator
submissions of the same words rather than one message written twice, so the design decision
survives and the sentence did not. The same sweep falsified a second comment claiming the
content-array refusal "costs nothing observable": 10 of 321 typed turn-opening lines carry a
content array, every one of them `text|image`, the operator pasting a screenshot with their
words. Those prompts were silently unrecoverable. The reader now admits one text block beside any
number of image blocks, which closes that gap while keeping the gate that matters, since an image
carries no text and cannot reach the operator's unforgeable register.

The section widened twice, both recorded here as the drift they are. `broker/registry.ts` joined
the files in scope for the optional engagement instant. And a `forgetPrompts` method was folded in
so the tailer gives up prompt claims wherever its read position jumps over bytes it will never
read; there are four such jumps, and round 3 covered three of them while naming the fourth, the
probe's own baseline, as though it did not exist.
Assumptions: The claim window's multiplier was this session's to pick and was picked twice. It
went in at two poll intervals on the reasoning that a shorter window is the safer direction
against the loss; round 4's evidence reversed it to three, because the module already treats a
pass outlasting one interval as normal and does not call one overdue until three, so a window
narrower than a delay the module tolerates costs a duplicate on every slow pass (declared
2026-08-25, section 2). `createEchoMemory()` with no options takes the 60-second floor and the
system clock; the production caller always passes both, and no test that does not move the clock
is affected (declared 2026-08-25, section 2). Clearing claims at an offset jump also gives up a
claim whose line happens to sit just after the new baseline, costing one duplicate copy of that
prompt, which is the section's declared fail direction (declared 2026-08-25, section 2). Spec
section 2 was rewritten to match all of the above, per the deviation rule.
Review Findings: Four rounds. Round 1: one Critical, found independently by all three reviewers,
fixed. Round 2: no Critical, several Majors sharing one root, which the consult then ruled on.
Round 3: one Critical (the engagement stamp) plus three Majors and four Minors; the Critical and
every Major fixed, two of them after this session verified the reviewers' reachability claims and
found one of them false. That one is worth naming: two reviewers independently rated a
wake-notice double-post a Major, and it is unreachable, because every task-notification user line
on this machine carries `promptSource` system or sdk with `origin.kind` task-notification and is
refused at the recovery's first lock. What misled them is a test: `broker/tail.test.ts` hand-builds
a typed wake line, a shape the harness does not write, and to a fresh reader a fixture asserting
behaviour on an impossible shape reads as evidence the shape exists. That test now says so in its
own comment. Round 4: no Critical, five Majors and five Minors; all fixed except two, both
justified rather than fixed. First, prompt claims carry no run identity, so two overlapping runs
of identical text can mis-attribute a release: this is the structure the reply slot has always
had, the consult ruled it out of scope, and tagging runs means touching all four slots. Second,
the mirror path stamps engagement above its own dedup consult, so a suppressed mirror stamps
twice: the hook fires as the operator presses return and cannot be newer than a block raised by
the turn its own prompt started, so it is a duplicate stamp with no hazard, and the site now says
why. One further residual is stated rather than closed: a prompt whose hook was lost and which is
also a channel echo stamps on neither path.
Stamps: adjudicated 1, stamped 1. `memq unstamped --since 8h` surfaced one operator-tier record,
that an unservable model override yields an agent which never runs and that the transcript's
assistant-line model tally is how to tell. It steered re-dispatching this section's reviewers at
opus rather than reaching for fable after round 2's first attempt wedged, and reading that wedge
as an environment fault rather than an unservable override.
Next: 3. Live verification and docs
Commit Model: Commit-and-Push

### Interim board 2 - 2026-08-25
Section 3 is half delivered and half blocked, so this is a board entry rather than a Chapter: the
section registers no `Completed:` line, because its live verification has not run. Nothing is in
flight as this is written; no dispatch is live.

**Section 3's stage.** The docs half is built, gated, and reviewed four times. `architecture.md`,
`operations.md`, `install.md` and `security-model.md` now describe the recovery as shipped, and
`docs/backlog.md`'s deploy walk carries the `Install-Host` step the fragment change needs plus the
live check as step 12. The live half is blocked on the same orphaned broker as the peer-traffic
plan's section 4, confirmed at source this session rather than carried forward on report: PID
10272 owns the listening socket on port 8787 and does not answer `/health` inside five seconds
(`curl` exit 28, code 000), and the process is opaque to this account, which is the access-denied
signature an elevated kill exists for.

**A code defect came out of the review, and it is section 2's.** `registry.engage` gained an
optional instant in section 2 so a recovered prompt could stamp engagement with the moment it was
typed. It high-water-marked that instant with no forward bound, while `broker/discord/blocked.ts`
decides a session stands blocked by comparing the blocking event against that same field. One
transcript line carrying a far-future timestamp therefore suppressed the blocked state on the
card, the board and the thread title indefinitely, and across restarts, since the field is
persisted. Section 2's own four rounds missed it because every one of them was asking whether the
borrowed instant could be too old, which was the round-3 Critical there; nobody asked what a
too-new one did. It is now clamped to the read clock at the `engage` seam, red-first, with the
pin proving both directions and the null-versus-undefined narrowing that a first draft of the
clamp introduced. A security Major is never parked, which is why this fix rides a docs section.
The one residue is routed rather than fixed: `broker/persistence.ts` restores the persisted stamp
verbatim, so a state file carrying a future value survives a restart until the next completed tool
call overwrites it outright. Bounded, self-healing, and behind the same-user write to local state
the security model already carries, so it went to the backlog with that reasoning stated.

**The recurrence rule fired, and the amendment it produced was not enough.** One finding class ran
through every round of this plan: a doc or comment line asserting more, or less, than the code
does. The Standing Brief Amendments block gained a second entry after round 1 of this section,
naming the two shapes the first entry did not reach, a coverage claim traced through the working
path but not the arming path, and a figure copied out of a Chapter without re-deriving what it had
measured. Round 2 then produced the same class in the opposite direction: the correction to round
1's arming finding denied a recovery that does exist, because any credited `/mirror` post arms the
tailer and `MIRROR_EVENTS` admits `Stop` as well as `UserPromptSubmit`. What finally moved it was
structural rather than another patch: the coverage prose now states the mechanism, the tailer's
read position, and lets the bound follow, instead of naming cases. Round 4's prose findings dropped
to Majors and Minors accordingly.

**What did not converge is the live-verification recipe, and that is the reason for the blocked
stop.** Rounds 3 and 4 each returned a Critical on the procedure written into backlog step 12,
never on the same error: the first named a mechanism that would have killed the tailer along with
the mirror, the second named a knob (`CHANNEL_MIRROR_MAX_BYTES`) with a 64 KB floor whose
violation is fatal at startup, and which needs the restart that unarms the session under test.
Both were invented rather than exercised, because the broker on this host cannot be run. The step
now says what to observe and names its candidate mechanism as untried, which is honest; writing a
third guess would not be.

**Gate baseline.** Section 3 opened at 1504 tests, 1503 pass, 0 fail, 1 skipped, lint exit 0. It
stands at 1505 / 1504 / 0 / 1, exit 0: one test added, the engagement clamp's own pin. One
full-suite run inside the section came back with a single failure, `a reply record left by a
deferral dies with the interim run that never landed`, on the `until` helper's `the condition never
held`. Three isolated runs of `tail.test.ts` returned 159/159 exit 0 and the next full suite
returned green, so it is named a flake on the repeat test rather than a regression; it is a member
of the echo-dedup group `docs/backlog.md` already records with receipts from a clean tree at
`3417f79`, and the entry now names it.

**Scope widened three times, all recorded here as the drift they are.** `broker/registry.ts` and
`broker/registry.test.ts` joined a docs section for the engagement clamp above. `docs/backlog.md`
gained two entries beyond the deploy-walk line the section asked for, the persisted-stamp clamp and
the `COMMAND_NAME` quadratic scan, both routed out of review findings rated below the never-park
bar. And `docs/operations.md` took corrections the section did not anticipate, because section 2
renamed log lines the operator's own catalogue still documented by their old strings.

**Rulings adopted since the last boundary.**
- The blind reviewer was skipped in rounds 1 through 3 and run in round 4. A docs-only diff gives
  that lens nothing to read; the registry clamp is what gave it a diff.
- Two reviewers disagreed on the persisted-stamp residue, Major from the blind lens and Minor from
  the security lens. The security rating was adopted, on its stated ground that a completed tool
  call overwrites the field outright, which was confirmed at `broker/registry.ts:680`.
- The repeatable half of the live check was left in the deploy walk rather than moved to
  `docs/operator-checks.md`, which a reviewer proposed. The spec directed this section to add to
  the deploy walk rather than create an item, and the move is a curation call for the finishing
  pass rather than a correctness one.

**Next action.** Section 3's live verification, and with it section 4's finishing pass, waits on an
elevated kill of PID 10272 followed by `install\Repair-Broker.ps1`. That same action unblocks the
peer-traffic plan's section 4. Everything else in section 3 is delivered and pushed.

### Correction to interim board 2 - 2026-08-25

The blocker recorded above is wrong in its diagnosis and smaller than it was written. Re-measured
directly: the broker answers `GET /sessions` with 200 in 1.2 ms, and `/health`, the path the earlier
reading probed, is not a route at all and returns 404. PID 10272 is serving normally. The earlier
`curl` exit 28 stands as what was observed at that moment, but nothing in it supported the standing
conclusion that the process was wedged, and re-measuring is what caught it.

What actually blocks the live verification is staleness, not a wedge. The broker process began at
`2026-08-25T02:24:50Z`, which is local `2026-08-24T22:24`, roughly twelve hours before section 2's
code landed in `d2e4c30` at `2026-08-25T10:11:48-04:00`. It is serving pre-feature code, so none of
section 3's three checks can be exercised against it. The corroborating read is the log itself: over
its whole length it carries neither the new `transcript-read prompt` string nor the `queued prompt`
string it replaced, and the only `was dropped, the ...` line present is the unrelated rate-limit
one. That silence alone proves nothing, which is why the process start time and the commit time are
the evidence and the grep is only corroboration.

The remedy is a restart onto the current checkout rather than a kill. `SapplefeldChannelsBroker`
already runs `install\Start-Broker.ps1` out of `D:\discord-channels`, so restarting picks up
`dc3f8b1` with no reinstall. `install\Repair-Broker.ps1` performs the whole sequence itself,
including the kill: its header states the orphan-outlives-its-task failure it exists for, and
`Test-IsChannelBrokerPortHolder` treats a node process whose command line this account cannot read
as a provable orphan and kills it. The separate pre-kill recorded above is therefore redundant, and
skipping it keeps each kill inside the script's own proof discipline, which reports every PID it
kills and what identified it.

Elevation is still required. `Win32_Process` returns a row for PID 10272 naming `node.exe` with an
empty `CommandLine`, which is what Windows reports for a process this account cannot open, so an
unelevated repair reaches the kill and fails there. The run was not attempted from this session on
purpose: the script stops the scheduled task before it kills, so a failed unelevated attempt trades
a working stale relay for a stopped one while the orphan goes on holding the port.

One further deployment gap, separate from the above and not a blocker for the broker restart: this
host's hook fragment still carries the five-second mirror timeout, so the raised timeout the plan
ships is not deployed here and needs `Install-Host`.
