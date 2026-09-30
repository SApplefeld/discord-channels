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

Open, asked 2026-09-30 on the relay thread, not blocking:

- **May the broker read queue-dequeue lines (type and timestamp only) from mirror-off transcripts, so 👀 marks a message injected mid-turn?** Recommended yes. Without it, a message sent to a busy mirror-off session stays at 📨 until that session's next turn opens. Section 1 builds pickup from the prompt hook (every session) and the tailer's queued-message sighting (mirror-on only), behind one pickup entry point the answer plugs into. Unanswered by finishing, the gap ships and the pull request names it.

## What Is Known

- **Confirmed:** Discord's `POST /channels/{channel.id}/typing` shows the indicator for 10 seconds, per Discord's channel resource docs. The broker's discord.js 14 client exposes it as `sendTyping()`.
- **Confirmed:** a bot's presence is global to the bot user, per Discord's Update Presence docs. Every session posts through one bot, so the participants list can't carry per-session state. That rules it out here.
- **Confirmed:** the broker already derives each session's state from hook traffic: `working`, `needs you`, `blocked`, `idle` or `exited`. That happens in `deriveSurfaceState`, `broker/discord/state.ts`. Inbound messages arrive at `broker/routing/gateway.ts:246`.
- **Confirmed:** the transcript tailer already parses harness `system` lines for forced model downgrades, at `broker/tail.ts:1703`. A rate limit or API error is written to the same transcript as a `system` line with subtype `api_error`. Its fields include `error.status`, `error.rateLimits.rateLimitType`, `error.rateLimits.resetsAt`, `retryInMs`, `retryAttempt`, `maxRetries` and `requestId`, as read from ARCHITECT's transcript on 2026-09-30.
- **Confirmed:** the tailer reads a transcript only after a mirror-on verdict for that session. Personas launch with `CHANNEL_SESSION_MIRROR=off`, as seen on ARCHITECT's process command line. So today no persona's error line would ever be read.
- **Inferred, not confirmed:** Discord clears a bot's typing indicator when the bot posts a message. Section 2 confirms it or handles the case where it doesn't.

## Standing Brief Amendments

- **Section 3, mirror-off read bounds.** In a mirror-off transcript, every line other than a `system` line with subtype `api_error` stays unread, and the read fails closed on any line it cannot parse.
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

_None yet._
