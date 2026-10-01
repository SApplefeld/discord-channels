# Session Activity Signals in Discord Threads

Status: In Progress
Repository: discord-channels (`D:\discord-channels`), the relay broker
Commit Model: Branch-and-PR
Author: ASSISTANT, 2026-09-30

## Goal

Someone reading a session's Discord thread can tell, without leaving the thread, whether the session got their message, is working on it, has answered it, or is stuck on a harness error. Today that answer lives on the status card. Reaching the card means leaving the conversation and coming back. The need grows as more people talk to the sessions.

## Intent

Three signals, each cheap, each shown in the thread itself:

1. **Receipt reactions.** An emoji on each person's own message shows where that message stands.
2. **Typing indicator.** Discord's "is typing…" line runs while the session is working.
3. **Harness error notices.** A short line in the thread says the session hit a rate limit or an API error, and when it will retry. The session itself can't say this, because it can't produce a turn.

The 2026-09-30 incident is the case this answers. ARCHITECT sat for two hours in a Fable rate-limit retry wait. The operator's message queued unread, and nothing in the thread showed the difference between thinking and stuck.

Operator decisions:

- **Decided 2026-09-30: the plan is approved to run here.** The operator answered on the Discord relay thread: "Yes. Please proceed." Rationale: the plan arrived from ASSISTANT through the Steward with an approval stated only in its own header, so the worker asked before starting.
- **Decided 2026-09-30: the broker may read `api_error` lines from mirror-off sessions.** Same message: "And yes, reading error lines is approved." This settles the Open Question below as recommended: a status-only read of `system` lines with subtype `api_error`, using only their structured fields in fixed wording.

- **Decided 2026-09-30: the broker may read queued-message lines from mirror-off transcripts, so 👀 marks a message injected mid-turn.** The operator answered on the relay thread: "Absolutely that's allowed. ... the prohibition against reading with mirroring turned off was to keep the text shown to the user minimized. It wasn't meant to prevent you from reading things programmatically for insight or processing." Rationale: the mirror-off gate governs what is published to the thread, not what the broker may read to derive a status. Section 1 exposes one pickup entry point, and Section 3's mirror-off reader feeds it, per the Standing Brief Amendments.

- **Decided 2026-09-30: the typing indicator runs only while a turn is open.** The operator answered on the relay thread: "Agreed, Option 1 is way more logical and fits better. Yes please!" Rationale: the card's `working` lasts `idleAfterMs` (120 s) past a turn's end, and indefinitely while background agents run, so typing that followed it would show "is typing" for about two minutes after every answer. Typing that tracks the open turn reads as "working on it right now", and it meets the section's own "gone within 10 seconds of the turn ending". The card itself is unchanged, so for up to two minutes after a turn ends the card can read working while typing has stopped.

## What Is Known

- **Confirmed:** Discord's `POST /channels/{channel.id}/typing` shows the indicator for 10 seconds, per Discord's channel resource docs. The broker's discord.js 14 client exposes it as `sendTyping()`.
- **Confirmed:** a bot's presence is global to the bot user, per Discord's Update Presence docs. Every session posts through one bot, so the participants list can't carry per-session state. That rules it out here.
- **Confirmed:** the broker already derives each session's state from hook traffic: `working`, `needs you`, `blocked`, `idle` or `exited`. That happens in `deriveSurfaceState`, `broker/discord/state.ts`. Inbound messages arrive at `broker/routing/gateway.ts:246`.
- **Confirmed:** the transcript tailer already parses harness `system` lines for forced model downgrades, at `broker/tail.ts:1703`. A rate limit or API error is written to the same transcript as a `system` line with subtype `api_error`. Its fields include `error.status`, `error.rateLimits.rateLimitType`, `error.rateLimits.resetsAt`, `retryInMs`, `retryAttempt`, `maxRetries` and `requestId`, as read from ARCHITECT's transcript on 2026-09-30.
- **Confirmed:** the tailer reads a transcript only after a mirror-on verdict for that session. Personas launch with `CHANNEL_SESSION_MIRROR=off`, as seen on ARCHITECT's process command line. So today no persona's error line would ever be read.
- **Inferred, not confirmed:** Discord clears a bot's typing indicator when the bot posts a message. Section 2 confirms it or handles the case where it doesn't.

## Standing Brief Amendments

- **Section 3, mirror-off read bounds.** In a mirror-off transcript, the reader acts only on a `system` line with subtype `api_error` and on the queued-message line named below, uses only their structured fields, and fails closed on any line it cannot parse. No text from any mirror-off line is ever published.
- **Section 3, mirror-off pickup.** The mirror-off reader also reads the transcript line that records a queued message being injected mid-turn, using only its type and timestamp, and calls Section 1's pickup entry point with that timestamp. Acceptance: a mirror-off session's message delivered mid-turn moves from 📨 to 👀 when that line appears, and none of the line's text reaches Discord.
- **Section 3, reader coverage.** The status reader runs for every session whose transcript path the broker has learned, whether or not the interim tailer is built on this host. With `CHANNEL_INTERIM_MIRROR` off or the host-wide mirror off, no tailer exists, and the mid-turn pickup of a message injected into a running turn comes only from this reader.
- **Section 3, turn-opening pickup.** The same reader also credits pickup, with the line's own timestamp, for a `user` line whose root `origin` kind is `channel` and whose server names this relay: the line a Discord message writes when it opens a turn on an idle session. That covers a turn whose `UserPromptSubmit` post the broker never received.
- **Section 2, turn-open typing.** The keeper types for a thread only while its session's derived state is `working` and a turn is open. A turn opens on the session's credited `UserPromptSubmit` post or a completed tool call, and closes on its `Stop` hook. A broker restarted mid-turn treats the turn as closed until the next of those events. Acceptance: after a `Stop`, no typing call is sent for that thread, though the card still reads working. A session with an outstanding background roster and no open turn shows no typing.
- **Section 3, added acceptance.** A test feeds a mirror-off session's transcript holding assistant text, a user prompt and an `api_error` line. Only the fixed-wording notice reaches Discord.

## Sections of Work

### 1. Receipt Reactions

Model: sonnet

The broker reacts on each inbound message a person sends in a session's thread. The message moves through three stages:

| Stage | Emoji | Set when |
|---|---|---|
| Delivered | 📨 | The broker hands the message to the session |
| Picked up | 👀 | The session starts a turn that carries the message: its UserPromptSubmit hook, or the tailer seeing it injected mid-turn |
| Answered | ✅ | The session posts a reply to the thread after picking the message up |

- Each stage replaces the one before it, so a message carries one stage emoji at a time.
- A message still at 📨 is queued behind a running turn and unread. That is exactly what the operator could not see on 2026-09-30.
- A message from each person gets its own reactions, so several people in one thread each see their own status.
- A reaction call that fails is logged and dropped. It never blocks delivery.
- The emoji set is a default the operator can swap. Keep the three in one exported constant.

**Acceptance:** a broker test drives one message through delivered, picked up and answered, and shows one stage reaction at each step. A second message sent mid-turn stays at 📨 until its turn starts. A failed reaction call leaves delivery intact.

### 2. Typing Indicator

Model: sonnet

While a session's derived state is `working`, the broker calls `sendTyping()` on its thread every 8 seconds. It stops at any other state.

- The indicator comes from the same state the card shows, so the two never disagree.
- A stuck turn fires no hooks, so its state drops to `idle` after `idleAfterMs` and the indicator stops. The quiet thread then reads as "nothing is happening," which is the truth.
- One timer per thread, cleared on state change and on session end, so no timer outlives its session.
- Confirm on a live thread whether a posted reply clears the indicator. If it doesn't, the thread shows "typing" for up to 10 seconds after a reply. Accept that and say so in the Chapter. Don't add a workaround.

**Acceptance:** a unit test with a fake clock shows calls every 8 seconds while `working` and none after a state change. A live check on one thread shows the indicator during a tool-running turn and gone within 10 seconds of the turn ending.

### 3. Harness Error Notices

Model: opus

Gate: answered 2026-09-30, see Operator decisions under Intent.

When a session's transcript records an `api_error` line, the broker posts one short notice in its thread. On a pending inbound message, it also swaps the stage reaction to ⚠️.

- **One notice per episode, never per retry.** The harness rewrites the countdown every 30 seconds under one `requestId`. Key the episode on the request id, and post again only when the id changes.
- **Built from structured fields only.** The notice is rendered in fixed wording from `status`, `rateLimitType`, `resetsAt` and `retryInMs`. For example: "Rate-limited (seven-day Fable limit). Retrying at 1:16 PM, limit resets 3:00 AM." The error's free-text message is never posted.
- **A recovery line closes the episode.** When the next assistant output or tool call appears, post "Resumed," and restore the stage reaction.
- **The notice reaches the card.** Where the card has room, it carries the same one line under the session's state.

**Acceptance:** a tailer test feeds a transcript with 20 `api_error` lines under one request id, then an assistant line. It shows exactly one notice and one recovery line. A test with an error whose message text holds markdown or a mention shows none of that text reaches Discord.

## Open Question for the Operator

Answered 2026-09-30: approved as recommended. The question as asked is kept below.

The error notices need the broker to read one harness line type from sessions that have mirroring turned off, which includes every persona. The mirror-off gate exists so that a session marked private never has transcript content published.

**Recommendation:** allow a status-only read for mirror-off sessions. It would parse only `system` lines with subtype `api_error`, and use only their structured fields in fixed wording. No model text, no prompt text and no error message text would ever be read into a post. That keeps the gate's promise, since nothing the model or a person wrote is published. It also covers the persona case that prompted this plan. The alternative is error notices for mirror-on sessions only, which would not have helped ARCHITECT.

## Out of Scope

- **Participants-list status.** It's global to the one bot, per What Is Known.
- **Per-session bot identities.** Separate bots would give each session its own presence. That is a much larger change.
- **Any change to the status card beyond the one error line.**

## Chapters

### Interim board 1 - 2026-09-30

Header change: `Status:` was set to `In Progress` when this run started (it arrived reading Approved), a deliberate change and not drift.

- **Section 1, Receipt Reactions: fix round 3 in flight.** First green d2cbbb8; fix round 1 bb3c3ec; fix round 2 f0edc64; all pushed to feat/session-activity-signals. Review rounds 1 to 3 ran the full roster (adversarial, blind, security, performance) at opus, high effort, via Workflow, each re-raised by a surviving correctness Critical. Rounds 1 and 2 surfaced Criticals of one class (reaction rate-limit pacing), round 3 one of another (turn attribution of the answered stage), so fix round 3 is escalated to implementer-fable, brief at `.kit/scratch/session-activity/s1-fix3-brief.md`. The review-round backstop fires at the fifth round's adjudication.
- **Live dispatch:** implementer-fable, asked to key `answered` on the reply's arrival instant and each entry's pickup instant, widen the pacing wait to the whole discord.js offset window, test the Stop-mirror answered path, and clear seven Minors.
- **Gate baseline:** targeted lane (8 broker test files) 679 tests, 679 pass, 0 fail, exit 0 on f0edc64, main checkout, 2026-09-30, no foreign runner seen. Whole-suite baseline at a5257e2: 2211 tests, 2210 pass, 0 fail, 1 skipped.
- **Rulings since start:** the message-id format finding was refused by the scope adjudicator (fable), since the threat model already treats a writer of that file as holding the bot token (`docs/security-model.md` T4 lines 57-62, 1294, 1315-1318). The UserPromptSubmit instant, stamped at hook arrival rather than turn open, is an accepted residual of one hook round trip. The channel-origin queued line is written at injection, not enqueue (70 of 129 such lines follow a tool's hook result or tool result, and enqueue has its own `queue-operation` line). A Section 3 amendment on reader coverage was added.
- **Next per section:** Section 1: verify fix round 3, commit, review round 4. Section 2: dispatch from `.kit/scratch/session-activity/s2-brief.md` after Section 1 closes. Section 3: brief from `.kit/scratch/session-activity/section-3-brief-draft.md` plus the amendments.

### Chapter 1 - 2026-09-30
Completed: 1. Receipt Reactions
Implemented By: implementer-sonnet (first green and fix rounds 1 and 2), escalated to implementer-fable for fix round 3; close pass in the main session
Metrics: review rounds 4, closed major-closed; provenance 13 spec-traceable, 4 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 9 findings, 4 fixed, 2 deferred, 3 refused-or-covered; NEEDS_CONTEXT 0; escalations 1 (sonnet to fable after rounds 1 to 3 each left a surviving Critical); consults 0
Decisions / Surprises: The section's add-decision lines, verbatim from `.kit/scratch/session-activity/add-decisions-section-1.md`:
- section 1 open: changes = new receipt tracker module + MessageReactions transport interface (PUT/DELETE reaction routes) + wiring at inbound handOver, the /mirror prompt post (allowed or suppressed), the tailer queued-prompt sighting, and the reply/Stop-mirror posts; serves Section 1's stage table and acceptance bullets; adds a mechanism = the tracker and its own reaction budget, both named by the section (stages, "logged and dropped"); size ~250-400 lines incl tests (estimate); not building it costs the whole section.
- implementer (round 0, DONE_WITH_CONCERNS): windowed refusal log in receipts.ts = new small helper mirroring gateway.ts:208 idiom rather than reuse (no exported general helper exists); onRetired hook in surface.ts at threads.delete (forget lags session end by a few ticks, bounded by the 50/thread cap); cap not separately pinned. Serve Section 1 bullets "logged and dropped" / "no timer outlives" analogue; add no unnamed mechanism.
- orchestrator amendment: source B keyed on queued_command origin kind "channel" (confirmed 129/152 lines) -> tail.ts pickup-only item; serves Section 1 stage table "tailer seeing it injected mid-turn"; adds one item kind, no new mechanism beyond the named source; size TBD; not building it = source B never fires for Discord messages.
- Round 1 A2 (add-then-remove): write() reports whether the call landed and the old stage is removed only after the new one landed; serves "Each stage replaces the one before it, so a message carries one stage emoji at a time"; no new mechanism (a condition on the existing pair); ~6 lines; not building it leaves a message with no stage emoji at all.
- Round 1 A4/B2 (child-process pickup): pickup is credited only when the post's session_id names the session holding the token, the same straggler gate allow() already applies; on the mirror-off and host-off paths the capped body is read for session_id alone and discarded; serves "The session starts a turn that carries the message: its UserPromptSubmit hook" and "A message still at 📨 is queued behind a running turn"; reuses the existing gate, no new mechanism; ~30 lines; not building it lets a spawned claude -p flip queued, unread messages to 👀 and then ✅.
- Round 1 B1 (host-wide mirror off): the host-off early return also credits pickup for a live token holder; serves the same UserPromptSubmit clause; no new mechanism (the same call on one more path); ~10 lines; not building it leaves every message on a mirror-off host at 📨 forever.
- Round 1 A5 (buffer ordering): every written message in a released buffer is marked delivered before the first await; serves "A message still at 📨 is queued behind a running turn"; no mechanism, a moved loop; ~6 lines; not building it leaves later buffered messages at 📨 after the turn that read them.
- Round 1 B4 (interim-echo answer): the dedup branch that reports the reply as already on the thread also marks the thread answered; serves "Answered: the session posts a reply to the thread"; no mechanism, one call; 1 line; not building it leaves messages at 👀 after a narrated final reply.
- Round 2 adv M1 (answered before the tailer reads a mid-turn pickup): the tracker records each thread's last answered instant, and a pickup whose instant is at or before it moves the message straight to answered; serves "Answered: the session posts a reply to the thread after picking the message up"; no new mechanism beyond one stored instant and the branch the answered clause asks for; ~12 lines; not building it leaves a mid-turn message at 👀 after the reply that answered it, for up to one tailer poll or until the next reply.
- Round 2 adv M3 / blind (stage advanced before its write landed): each tracked message records the emoji actually painted, and a transition removes that one after the new add lands; serves "Each stage replaces the one before it"; no new mechanism (replaces the assumed-previous-emoji with the recorded one); ~10 lines; not building it leaves 📨 beside ✅.
- Round 2 adv M4 (startBroker wiring untested): one source-shape pin on broker/index.ts's receipt seams, like restoreWiringGaps, plus one named pickup entry point shared by the intake and tailer seams; serves the Intent's "Section 1 exposes one pickup entry point" and the acceptance bullets; no mechanism; ~30 lines; not building it lets a deleted wiring line turn a stage off with every test green.
- Round 3 perf Major (pace margin skipped when the budget has just cleared): the write waits whenever the instant is before blockedUntil plus the margin, not only while unaffordable; completes round 2's correctness Critical (the orchestrator confirmed the gap at budget.ts affordable and receipts.ts write); serves "Each stage replaces the one before it"; no mechanism, one condition; ~3 lines; not building it drops ~1 in 8 idle-session 👀 adds (reviewer's estimate).
- Round 3 adv Major (Stop-mirror answered path untested): one outbound test for the reply-kind mirror landing and a prompt-kind control; serves "Answered: the session posts a reply"; no mechanism; ~40 test lines; not building it lets the ordinary answered source vanish with the suite green.
- Round 3 blind Minor-as-fixed (isAnswerEcho branch): the reply-tool answer-echo dedup branch also calls answered with the reply's instant; serves the answered clause; no mechanism; 1 line.

Resolved or discovered: reaction writes are paced per thread, because discord.js 2.6.3 adds a 50 ms offset to every reset it records (`node_modules/@discordjs/rest/dist/index.js:140`, `:1113`) and the broker's client refuses rather than waits (`broker/discord/rest.ts:70`); the tracker waits 100 ms past the reported reset. The answered stage is keyed on the reply's arrival instant and each message's pickup instant, not on when the reply's post lands. Claude Code fires `UserPromptSubmit` for a Discord turn-opener: 140 of 416 channel-origin turn-opening lines in the 15 newest transcripts per persona folder are followed within a few lines by a `UserPromptSubmit` hook's added-context record, and the remainder belong to sessions whose hooks add no context, so absence there is no evidence. The channel queued line is written at injection, not enqueue: 70 of 129 follow a tool's hook result or tool result, and enqueue has its own `queue-operation` line. The relay's server name is `plugin:relay:channel-relay` on every one of the 1,289 channel-origin lines on this machine; `channel-relay` (the wrapper's manual entry) is accepted too but unseen. Files beyond the section's code: `docs/security-model.md` (eleventh tailer shape with its server clause; the session-id read on the -NoMirror and host-off paths) and `docs/install.md` (Add Reactions permission), both describing behavior this section added. Two backlog entries were written: transitive npm advisories, and the missing refusal latch.
Failed approaches: tried pacing on the tracker's own header budget, failed because discord.js keeps the bucket limited 50 ms longer and the budget was dropped whenever a queue drained, learned to wait past the library's own window and keep a thread's budget until the thread is retired. Tried crediting answered when the reply's post landed, failed because a slow final post from one turn marked the next turn's freshly picked-up message answered, learned to attribute by instants the broker reads at arrival.
Assumptions: (2026-09-30, section 1) The pickup instant on the `UserPromptSubmit` path is the broker's own clock when the hook post arrives, not the turn's open; a message delivered inside that one hook round trip can show 👀 a moment early. No cheap fix exists, so it is an accepted residual. (2026-09-30, section 1) A mirror-off turn that ends without the reply tool leaves its messages at 👀 until the session's next reply answers them, since nothing was posted to the thread and ✅ would be untrue.
Review Findings: `review: adversarial, blind, security, performance at opus, Workflow (high)` for rounds 1 to 3, each re-raised by a surviving correctness Critical; `review: adversarial, blind, security, performance at fable, Agent tool (frontmatter effort)` for round 4, after the escalation. Fable capacity read "no reading (stale) -> ladder governs" before each fable dispatch. Criticals fixed: round 1, the remove half of each stage change dropped by the tracker's own budget; round 2, the paced write landing inside discord.js's offset window (blind lens, trace orchestrator-made); round 3, answered attributed to post landing (adversarial). Majors fixed: add-then-remove with no stage, child-process pickup, host-off pickup, buffer ordering, interim-echo answer, answered-before-tailer pickup, stage advanced before landing, untested startBroker wiring, Stop-mirror answered path untested, pace margin skipped after a cleared budget. Majors justified: the hook-latency pickup instant (accepted residual, above); round 4's idle-session pickup Major, settled by the transcript evidence above, with a Section 3 amendment adding a turn-opener transcript fallback for a lost hook; round 1's mirror-off mid-turn pickup, owned by Section 3's amendments. Advisory: the message-id route finding was refused by the scope adjudicator (fable, relevance shape), on `docs/security-model.md` T4 lines 57-62 and 1294, 1315-1318, grounds checked present; the false security-doc sentences were fixed; the perf Criticals and Majors were covered by the correctness findings; npm advisories and the refusal latch deferred to the backlog. Minors: 9 fixed in the close pass or the fix rounds (header claim, answered recording for untracked threads, unref'd pace timer, security-doc server clause, straight-to-answered comment, and four fixed inside fix rounds), 0 upgraded, 7 left with the reason (the wiring pin's brittleness follows the repo's restoreWiringGaps pattern; the reaction-lag and global-cap notes bind no requirement; the >1 MiB mirror-off body is left since such prompts are rare; the post-forget budget has a live owner because a post-forget delivery re-tracks the thread; the mirror-off Stop leaves 👀 by design; the `channel-relay` name is unseen on this machine).
Stamps: adjudicated 14 records unstamped in the last day, stamped 3 (`a-supervisor-answer-reaches-the-worker-as-a-submitted-prompt`, `a-queued-discord-message-has-origin-kind-channel`, `mirror-off-limits-publishing-not-programmatic-reads`); the other 11 operator-tier records were read and did not change this section's work.
Gate: targeted lane (`broker/routing/receipts.test.ts`, `broker/discord/adapter.test.ts`, `broker/routing/inbound.test.ts`, `broker/intake.test.ts`, `broker/routing/outbound.test.ts`, `broker/tail.test.ts`, `broker/discord/surface.test.ts`, `broker/index.test.ts`) 694 tests, 694 pass, 0 fail, exit 0, and `npm run lint` exit 0, on the main checkout at ffa23ad plus the close pass, 2026-09-30, no foreign test runner in the process list, 14.2 s wall clock. Delta on that lane: 656/656 at first green d2cbbb8 to 694/694, no lane baseline recorded before the section. Whole-suite baseline at a5257e2 for the finishing gate: 2211 tests, 2210 pass, 0 fail, 1 skipped. Test delta: a new `receipts.test.ts`, plus tests added in the adapter, inbound, intake, outbound, tail, surface and index files, each pinning a Section 1 bullet or a review finding as named in the fix rounds' reports. One existing tail test was edited to expect the pickup item a channel-origin queued line now yields, a contract this section names. 0 added tests spawn a process; the cross-module test runs an in-process HTTP server.
Next: 2. Typing Indicator
Commit Model: Branch-and-PR
Delta: kit-size, 2026-09-30, main checkout:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 2 - 2026-09-30

- **Section 2, Typing Indicator: fix round 1 being dispatched; one finding held for the operator.** First green f021ecf, pushed. Review round 1 (adversarial, blind, security at opus, high effort, Workflow) returned a blind Critical (a refresh pass in flight restarts the keeper's timers after `stop()`), a blind Major (the keeper ignores fatal, permanent and missing refusals, so a typing call can consume the one 401 and leave the surfaces running on a dead token) and ten Minors. Fix round 1 takes all of those.
- **Held: the adversarial Critical on the typing source.** The section's bullet "the indicator comes from the same state the card shows" conflicts with its acceptance "gone within 10 seconds of the turn ending": `working` lasts `idleAfterMs` (120 s) after a `Stop` and indefinitely while a background roster is outstanding (`broker/discord/state.ts:171-173`). Asked the operator on the relay thread 2026-09-30 with three options: typing only while a turn is open (recommended), typing as the card (as built), or typing only while a thread message is picked up and unanswered. Section 2 does not close until this is answered.
- **Gate baseline:** Section 2 targeted lane (typing, adapter, surface, index tests) 170 tests, 170 pass, 0 fail, exit 0, and lint exit 0, on f021ecf, main checkout, 2026-09-30, no foreign runner.
- **Next per section:** Section 2: verify fix round 1, then apply the operator's answer, then review round 2. Section 3: dispatch from `.kit/scratch/session-activity/s3-brief.md` after Section 2 closes.
