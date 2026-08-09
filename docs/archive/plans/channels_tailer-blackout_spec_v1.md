# Channels: the tailer blackout

Status: Complete
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session)

## Related

- [channels_prompt-surfacing-and-wake-compression_spec_v1.md](channels_prompt-surfacing-and-wake-compression_spec_v1.md):
  the effort whose live verification surfaced this. Its question alert shipped correct at the unit
  level and delivered 7.5 hours late in the live check that closes it, which reopens the work as
  this round.
- [channels_question-answering_spec_v1.md](../../plans/channels_question-answering_spec_v1.md): builds on this
  round's `PreToolUse` hook entry and its ratifying probe, turning the alert path into an answer
  path (the held hook response carries the operator's choices back).

## The mechanism, as Section 1's forensics confirmed it

There was no tailer blackout. The confirmed account (evidence in Chapter 1 and the project memory
`an-open-askuserquestions-line-is-withheld-from-the-transcript`):

- **The assistant line carrying an open `AskUserQuestion` is not written to the transcript while
  the picker is open.** Proof is byte order against the append-only file: lines stamped 00:41,
  00:49, and 07:40:31 sit at lower offsets than the question line stamped 00:14:14, so that line
  was physically written at 07:40:31, the second the operator answered. A transcript line's
  `timestamp` is emission time, not write time; the first forensics pass sorted by timestamp and
  manufactured the "7.5-hour-late tailer" narrative from that error.
- **The tailer was healthy through the whole window.** The "dark 33 minutes" contained one
  assistant text block total, and it was delivered nine seconds after it was written, appended by
  coalescing edit into the 23:41:37 Discord message where a content-prefix scan could not see it.
  Every alert observed live that night, across both sessions, was a post-answer alert because the
  question lines landed at answer time.
- **Both candidate mechanisms are killed.** Path flapping: a captured subagent `PostToolUse`
  payload carries the parent's own transcript path (the subagent identity rides in separate
  `agent_id`/`agent_type` fields), so `learn()` is never taught a subagent path. Wedged pass: the
  broker's timers, Discord writes, and tailer deliveries ran normally all night; the 03:08-07:41
  log silence was an idle fleet (zero sleep/wake events exist in the machine's System log).
- Two real but secondary observations: oversized subagent-completion `PostToolUse` posts bounced
  off the intake's size cap all evening (`hook refused` lines, retried by the CLI for ~3 hours),
  and the flush is lazy rather than strictly resolution-gated (one question asked while its turn
  was actively writing narration landed pre-answer and alerted ~70s before its answer).

The consequence: **no tailer patch can alert a quietly parked question**, because the data does
not exist on disk until the answer. The timely signal is upstream's `PreToolUse` hook for
`AskUserQuestion` (changelog 2.1.85, which also allows answering via `updatedInput`), pending live
confirmation that it fires on an interactive session on this host.

## Sections of Work

### 1. Forensic identification of the mechanism (complete)

Model: fable
Locus: inline

As planned, this section was an instrumented reproduction. As executed, no instrumentation was
needed: the mechanism was named from artifacts that already existed. What ran, each observation
captured rather than inferred:

- A scratch-settings headless probe captured a real subagent `PostToolUse` payload: it carries the
  parent's `session_id` and the parent's own transcript path, with the subagent identity in
  separate `agent_id`/`agent_type` fields. Candidate 1's premise killed in one observation, as
  specified.
- Byte-offset timelines of the blackout session's transcript (a scratch script, `timeline.mjs`)
  proved the question line was written at resolution, not at emission, and that the "dark stretch"
  contained almost no assistant text at all.
- The broker log across the window showed the intake refusing oversized hook posts all evening and
  an idle-fleet silence from 03:08, not a wedge; Discord thread reads over REST confirmed every
  delivery the transcript owed, including the one narration chunk hidden inside a coalescing edit.

Acceptance met: the mechanism is named with captured observations (byte order, a captured payload,
the log, and the thread), and Chapter 1 records the discriminating evidence.

### 2. The emission-time question alert over PreToolUse, plus the two hardenings

Model: fable

Ratified 2026-08-09 after two gating measurements: `PreToolUse` fires for `AskUserQuestion` on a
live interactive session, at emission, carrying the full `tool_input.questions` (receive-stamped
capture, 50 seconds before the answer's `PostToolUse`), and the `PreToolUse` event delivers over
an `http` hook (the live broker logged the probe's post; the rejection was the intake's own
header allowlist, exactly as designed for an unheadered post).

**Files:** `install/Install-Functions.ps1`, `broker/intake.ts`, `broker/tail.ts`,
`broker/index.ts`, plus their tests. `broker/discord/render.ts` is reused unchanged
(`renderQuestionNotice` already takes the bounded question shape).

- **Install:** the installed hook set gains a `PreToolUse` entry with matcher `AskUserQuestion`,
  an `http` hook to the same `/hook` route, carrying `X-Channel-Hook-Event: PreToolUse` and every
  header its sibling entries carry, the mirror switch header included: the payload carries
  conversation text, so it rides the same mirror consent the narration surfaces ride. Whatever
  pin test guards the installed fragment's shape extends to the new entry.
- **Intake (`broker/intake.ts`):** the `/hook` route's event allowlist gains `PreToolUse`, with
  the same liveness and path-teaching semantics as `PostToolUse` (`lastHookAt`, `learn`). When the
  payload's `tool_name` is `AskUserQuestion` and the session's mirror verdict is on, the bounded
  question reader (exported from `broker/tail.ts` rather than duplicated; single-source per the
  two-surfaces rule) parses `tool_input`, and the alert posts through the same wired
  `deliverQuestion` closure the tailer uses: same `renderQuestionNotice`, same steering-writer
  alert tier, same `createAlertVolume` window instance, so the two paths share one set of
  per-thread ceilings and a double path can never double-ping. A mirror-off session's question
  never alerts from this path (fail toward silence, the tailer's own arming rule); malformed
  `input` contributes silence; content never reaches a log line.
- **Dedupe:** the hook path records a per-session bounded set of outstanding question digests
  (cap 8, oldest evicted; one slot proved insufficient in review when two asks land inside one
  poll interval); the tailer's question yield consumes exactly the digest it matches, skipping
  the resolution-time duplicate for a question the hook already alerted. `question()` also skips
  delivery for a digest already outstanding (the CLI re-posts hooks on its retry cadence), a
  digest is recorded only for an alert that landed (fail direction: one duplicate ping, never a
  lost question), and `suppress()` drops the set beside the offset. A session whose hook set
  predates this round (no digest recorded) keeps the tailer alert as its fallback, which is the
  compatibility story for unupgraded hosts.
- **Verdict re-arm:** the PreToolUse post's mirror header is read exactly as `/mirror` reads it,
  both halves: recognized off vocabulary suppresses, and a non-off value (absent included) records
  the allow verdict under `/mirror`'s evidence bar, so a broker restarted while a session sits
  parked on a question can still alert at the next emission or retry rather than staying silent
  until the next mirror post. The installer's fragment validator pins any `PreToolUse` entry's
  matcher to exactly `AskUserQuestion` (review finding, three reviewers independently): the
  validator runs where a fragment can be tampered, and a widened matcher would post every tool
  call's input to the broker at emission.
- **The two hardenings, unchanged from the original round:** `learn()` refuses a taught path
  whose filename stem is not the session id (measured invariant; one bounded refusal log line),
  and the poll-pass watchdog logs when a pass runs longer than several intervals (the visibility
  line this round's forensics had to reconstruct from Discord instead of reading off the log).
  Both carry tests; the stem-pin test drives `learn` with an `agent-*.jsonl` path and asserts
  refusal plus the log line, and a red probe proves each new test discriminates.
- The full gates (`npm run lint`, `npm test`) green, with counts against the baseline
  (728 tests / 727 pass / 0 fail / 1 skipped, re-confirmed at f77b52d).

**Acceptance:** a `/hook` post shaped as the captured probe payload (PreToolUse, AskUserQuestion,
mirror-on session) produces exactly one thread alert identical in rendering to the tailer's, and
a subsequent tailer read of the same question yields no second alert; the same post for a
mirror-off session, or with malformed `input`, produces silence and no content in any log; a
tailer-only question (no hook digest) still alerts exactly as today; the stem-pin and watchdog
behave as specified with red-proven tests.

### 3. Docs, deploy, and live re-verify

Model: fable
Locus: inline (docs are main-session work; the deploy and live checks need operator coordination)

- **Docs:** `docs/architecture.md` and `docs/security-model.md` gain the hook-path question alert
  (primary source at emission) with the tailer yield as the resolution-time fallback, and the
  shared alert window as a security property; `docs/operations.md`'s "When a session asks you a
  question" section states the real timing story (ask-time alerts for sessions started after the
  install update, answer-time for older ones). Sweep the tree for the now-false "no hook fires
  for that tool / nothing observes it" comment claims (`broker/tail.ts` carries at least two),
  per the `a-comment-that-names-a-property-is-a-claim-to-sweep` memory.
- **Deploy:** run the install update so the hook fragment lands in user settings, then restart
  the SCOTT broker. The restart needs an elevated hand (`claude-sessions-on-scott-run-elevated`
  memory); coordinate with the operator.
- **Live re-verify:** in a console session started after the install update, ask an
  `AskUserQuestion` and let it park unanswered: the alert must reach the thread and phone within
  seconds of the ask, while the picker is still open. Answer it and confirm no second alert
  arrives from the tailer's resolution-time read. The operator confirms the ping reached the
  phone with the picker open, which is the exact check the original defect failed.

## Chapters

### Chapter 1 - 2026-08-09
Completed: Section 1: Forensic identification of the mechanism
Implemented By: main session
Metrics: 0 review rounds (read-only forensics; no code changed); 0 NEEDS_CONTEXT; 0 escalations;
advisor off
Decisions / Surprises: the effort's founding premise died under evidence. The discriminating find
is byte order against the append-only transcript: lines stamped 00:41, 00:49, and 07:40:31 sit at
lower offsets than the `AskUserQuestion` line stamped 00:14:14, so Claude Code wrote the question
line at answer time and the tailer alerted within a second of the line existing. The first
forensics pass had sorted by `timestamp`, which is emission time, not write time. Candidate 1
(subagent path flapping) was killed by a captured subagent `PostToolUse` payload carrying the
parent's own transcript path; candidate 2 (wedged pass) by the broker's visibly healthy night
(live card-edit and refusal chatter until an idle fleet went quiet at 03:08; zero sleep events in
the System log). The "missing" narration chunk was found delivered inside a coalescing edit of an
earlier Discord message (edited_timestamp 00:10:31, nine seconds after the text was written); the
operator's three overnight Discord messages were the buffered `queue-operation` neighbors that
made the byte-order proof possible. Convergent discovery: upstream changelog 2.1.85 added
`PreToolUse` for `AskUserQuestion` (with `updatedInput` answering), found in the operator's fresh
`D:\Claude-Code` clone before the forensics began; it is the only timely alert path and the fix
direction Section 2's redesign now proposes. Secondary observations for later rounds: subagent
completion `PostToolUse` payloads (67-327KB) bounce off the intake size cap and the CLI retries
them for hours; the flush is lazy rather than strictly resolution-gated, so pre-answer alerts can
happen but are never guaranteed. Records corrected in the same session: the
`the-tailer-can-black-out-silently-for-a-subagent-heavy-session` memory retired and superseded by
`an-open-askuserquestions-line-is-withheld-from-the-transcript`; the transcript-shape memory
gained the append-order-versus-timestamp rule; the backlog's "no hook runs for that tool,
upstream-blocked" entry rewritten around 2.1.85. The archived prior plan's contrary claim
("flushed at emission") stays as append-only history.
Review Findings: none (no code changed; the finishing pass covers the round)
Stamps: adjudicated 4, stamped 1 (claude-code-transcript-jsonl-shape); the blackout memory was
corrected and superseded rather than stamped; three operator-tier reads
(claude-code-file-permission-rules, claude-code-permission-deny-rules,
azure-cli-under-armed-sp-on-windows) skipped as not applied to this work
Next: Section 2, pending the operator's ratification of the redesign (PreToolUse alert path gated
on the interactive probe, plus which hardenings survive)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-09
Completed: Section 2: The emission-time question alert over PreToolUse, plus the two hardenings
Implemented By: implementer-fable (two rounds: initial build, then the review-fix round on the
same agent's context)
Metrics: 1 full review round (adversarial + blind + security, all at the session tier) plus the
fix round's own red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the operator's interactive probe confirmed both design gates in one
morning: PreToolUse fires for AskUserQuestion at emission with the full question payload
(receive-stamped capture, 50 seconds before the answer's PostToolUse, which itself carries an
`answers` map keyed by question text), and the event delivers over http (the live broker logged
the unheadered probe post's refusal, which is the header allowlist working, not a transport
failure). Implementer deviations accepted: registry.ts joined the file list because the HookEvent
union lives there, and its turn-counter refactor was verified by the adversarial reviewer as a
no-op for the old vocabulary and a required exemption for the new (SessionStart never counted
turns at base; the else-branch only ever received Stop). The intake reads the PreToolUse post's
mirror header both halves, exactly as /mirror does; the allow half was a review finding whose fix
closes the restart-while-parked gap, the original defect's own scenario. The one-slot dedupe
digest was the blind reviewer's Major (two asks inside one poll interval produce a duplicate
alert): fixed as a bounded outstanding set, cap 8, oldest evicted, consume-exactly-the-match,
with question() skipping already-outstanding digests (the CLI's documented retry cadence).
Risk acceptances encoded as comments rather than code: the digest records only on a landed alert
(recording at dispatch would invert the fail direction from one duplicate ping to a lost
question), and the in-flight identical-race stays open for the same reason. The stem-pin's
dependency on the filename-stem-equals-session-id invariant is accepted with the refusal log line
as its witness; if upstream ever ships a legitimate divergence, the pin fails toward silence for
that session and the log line is the tell. A host running CHANNEL_INTERIM_MIRROR=off has no
tailer and therefore no emission-time alert (the seam is a no-op); the live host runs it on, and
Section 3's operations text names the coupling.
Review Findings: adversarial APPROVED_WITH_CONCERNS (4 Minor), security CLEAR (2 Minor), blind
APPROVED_WITH_CONCERNS (1 Major, 4 Minor). Fixed: the one-slot digest Major; question()
idempotency; suppress() digest clearing; the installer's PreToolUse matcher pin (flagged
independently by all three reviewers); the missing allow half. Accepted with justification:
record-on-sent timing (comment names the window); stem-pin invariant risk. Riding Section 3 as
named checks: the security model and operations doc updates (security reviewer: the effort
cannot close without them), and a live confirmation that the post-answer transcript line's
`input` still digest-matches the emission payload (adversarial, low confidence).
Stamps: adjudicated 1, stamped 1 (claude-code-channel-and-hook-facts)
Next: Section 3: docs, deploy, and live re-verify
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-09
Completed: Section 3: docs, deploy, and live re-verify
Implemented By: main session (docs at b07b839; deploy ran before this session via the install
update plus broker restart)
Metrics: 0 review rounds this section (docs and verification; the finishing pass covers the
effort); 0 NEEDS_CONTEXT; 0 escalations
Decisions / Surprises: the live re-verify closed with thread-level receipts rather than operator
recollection. The operator's morning report ("it alerts me immediately") supplied the ask-time
half; the resolution half came from reading the session's own thread over REST: 34 messages,
exactly one question alert (11:13:55Z, posted the same second the picker opened and confirmed on
the operator's phone while the picker was still open), and zero further alerts after the picker
resolved, so the emission-digest dedupe held against the resolution-time transcript yield. The
resolution observed was a dismissal rather than an answer, which is a stricter case than the
acceptance asked for, and the withheld line landing on dismissal is confirmed by direct
transcript read, not assumed: the session's own transcript carries the dismissed call's
`tool_use` line (line 188, all four question headers, stamped 11:13:57Z), the thread carries
narration mirrored from after that line's write moment (so a poll read through it), and the
thread still shows exactly one alert, which is the digest match working end to end. The literal
answered-picker case rides the question-answering round's live checks, where every check answers
a picker remotely. Convergent bonus evidence from the
same morning's probe work: a session launched without the wrapper fired the new PreToolUse hook
and the intake dropped it tokenless with one log line, the no-watch fail direction working as
designed. The alert's readability and the absence of any remote answer path were reported by the
operator as the next round's work; that round is specced and open as
channels_question-answering_spec_v1.md.
Review Findings: the two named checks riding from Chapter 2 closed: the security model and
operations docs landed at b07b839, and the resolution-time transcript line's input
digest-matching the emission payload is confirmed by the receipts chain above (the transcript's
own `tool_use` line, a poll that read past it, one alert in the thread).
Stamps: none this section
Next: the whole-effort finishing pass (QA verification, finishing reviews, docs curation,
archive)
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-09
Completed: the whole-effort finishing pass; the plan is Complete and archived in this changeset
Implemented By: main session orchestrating qa-verifier, security-reviewer, adversarial-reviewer,
docs-curator, and one implementer-fable fix round
Metrics: 1 finishing review round plus 1 fix round; 0 NEEDS_CONTEXT; 0 escalations; tree-state
bracket clean across all three review rounds
Decisions / Surprises: QA passed at 749/748/0/1 against the recorded 728/727/0/1 baseline with
the delta verified as real new tests. The finishing reviews then earned their keep: security
(CLEAR, 1 Minor) traced a real inversion of the module's own promised fail direction, a digest
record straddling the awaited delivery so a racing identical question could strand a stale copy
that would swallow a later identical ask's only alert, and adversarial (APPROVED_WITH_CONCERNS)
found the question seam missing the straggler gate its sibling allow half holds. Both were
confirmed against the code before dispatch and fixed red-first in one round (4fd6af7), with a
third guard from the same trace: learn()'s path-change branch now drops outstanding digests
beside the offset, suppress()'s own direction. Gates after the fix round, re-run by the main
session: lint exit 0, 752/751/0/1. Adversarial's second Major was this plan's own Chapter 3
overclaiming its verification; it is restated above with transcript receipts (the dismissed
call's tool_use line read directly at line 188), which upgraded the evidence rather than
weakening the claim. QA's one UNVERIFIABLE item (re-running red proofs would mutate the tree
inside the bracket) stands on Chapter 2's build-time record plus the fix round's fresh red-first
evidence. Accepted without change: the end-to-end log assertion's single-macrotask window
(adversarial Minor, low), covered tightly by the unit-level content-never-logged pins.
Review Findings: security CLEAR (1 Minor, fixed); adversarial APPROVED_WITH_CONCERNS (2 Major:
one fixed in code, one resolved by restating Chapter 3 on receipts; 2 Minor: both README rows
fixed in this close-out's docs work; 1 Minor accepted with justification). Drift Report: 4
deviations, 0 mistakes: the remote-answering pointer moved from backlog to the open plan (fixed
both sites), the straggler gate and the learn() digest drop are as-built guards stronger than
the Section 2 text (this Chapter is their record), and the live resolution was a dismissal
rather than an answer (receipts in Chapter 3; the answered case rides the question-answering
round's live checks).
Stamps: adjudicated at close-out; the sweep and recap ride the close-out status
Operator-pending: none; the live re-verify closed on receipts
Next: none; the follow-on work is its own open plan, channels_question-answering_spec_v1.md
Commit Model: Commit-and-Push
