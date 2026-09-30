# Sender classes, author attribution and a response gate for a shared client thread

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-30

## Dispatch Authorization

The operator asked the ARCHITECT on its channel on 2026-09-30 for the plans that let a small group of client users steer a persona fleet on a client's own VM through Discord, and named this repository, the persona plugin and the kit as the three that change. This plan is the broker's share and the first in the build order, because the persona plugin's plan reads a field this plan adds to the delivered channel event. It has no merge precondition. It runs on a branch and lands through a pull request, since `main` merges through pull requests. The companion plans are `agent_persona_client-sandbox_spec_v1.md` in the `agent_persona` repository and `claude-kit_liaison-seat_spec_v1.md` in the `claude-kit` repository.

## Goal

A broker host admits a short list of Discord accounts rather than one, each tagged operator or participant, and every message it delivers to a session names its author and that author's class. On a host that turns the response gate on, messages in a thread are buffered and reach the session together when someone mentions the persona, replies to one of its messages, the buffer ages or fills past a cap, or TypeSafe's Jev judges that the conversation now expects a response. The gate has a shadow mode that journals every judgement while delivering as today, so a threshold is chosen from labelled samples before it decides anything live. A host with the gate off and one allowlisted id behaves exactly as it does today. The paths that consume a message as the operator's act, a permission verdict, a button press, a held question's answer and the inbox clear, take an operator's message only. Mentions the broker writes reach every operator on the list.

## Intent

Scott runs a fleet of persona sessions steered from Discord, and his clients want the same setup on a VM of their own, with two to five of their business analysts talking to one persona in a shared thread. Today the broker admits one Discord account and hands its every message to the session as the operator's own word. Scott's frame, in his words: a small group of already ordained, high-level analysts who feed him requests today should be able to steer directly, hold authority, and finalize what they ask for, with the code still landing through pull request review. He does not want them to have to tag the persona, since they may not understand when tagging is appropriate; he wants the messages since the persona's last turn buffered and a quick Jev call deciding whether a response is expected.

Done means: a broker configured with a list of accounts and classes, an event that names its author, operator-only consumption of verdicts, answers and clears, and a buffer with the four triggers above plus a shadow journal and a scoring tool, all pinned by tests and stated in the security model. Done does not need: delivery from a parent channel, more than two classes, per-user permissions inside a class, more than one thread per session, or a broker serving more than one Discord server.

Alternatives refused. Treating everyone in the room as an operator: the broker's own security model argues that a room's membership is not a credential, and an explicit id list costs one line per person. A classifier as the only delivery path: a mention and a reply-to are free and certain, so they short-circuit the judge, and the judge's miss is bounded by the age cap. Answering every message: the shape today, chatty in a group and a turn spent on every aside. Holding the persona's last reply in memory for the judge's context: the broker keeps a digest of a reply and never its text, by its security model, so the judge reads the buffered inbound lines and the time since the persona last spoke.

Rulings after the spec shipped: none yet.

Provenance: distilled by the ARCHITECT persona from the operator's three channel messages on 2026-09-30 and the reconnaissance recorded under Approach.

## Approach

The gate widens from one string to a small map, and everything downstream reads the class rather than the fact of admission. `createSenderGate` takes a list of `{ id, class }` entries, exposes `classOf(senderId)` returning `operator`, `participant` or `null`, keeps `allows` as `classOf !== null`, and exposes `operatorIds`. Section 1 keeps `operatorId` as the first operator's id so every caller still compiles, and section 3 retires it when the mention sites take the list. `loadSenderGate` reads `CHANNEL_SENDERS`, a comma-separated list of `<snowflake>:<operator|participant>`, and still reads `CHANNEL_ALLOWED_USER_ID` as one operator, so an existing host changes nothing. A gate with no operator refuses to start, as today.

The inbound message carries the author's display name and class from the gateway. The relay wire event and the MCP notification's `meta` gain `author` and `sender_class`, which Claude Code renders as attributes on the `<channel>` envelope it wraps the text in. That envelope is how the persona plugin's plan reads the class. The display name is bounded and sanitized in the broker before it rides an attribute.

The operator-keyed paths are keyed on `classOf === "operator"`: the verdict parse and the permission desk's `resolve`, the interaction press path, `answerTyped` on the question desk, and the inbox `clear` and `clearEnded` on delivery. A participant's verdict-shaped text is delivered as text. Mentions target every operator id.

The response gate is a new module in front of `relays.deliver`, with a per-host mode `CHANNEL_RESPONSE_GATE` of `off`, `shadow` or `live`, default `off`. It buffers admitted messages per thread. Four triggers deliver a buffer: a mention of the bot, a reply to one of the bot's messages, a buffer older than the age cap or larger than the size cap, and a Jev judgement at or above the threshold. The judge call reuses the inbox judge's client, host, timeout, secret screen and failure discipline, and reads the same key file. In `shadow` the broker delivers every message as today and journals what the gate would have done. In `live` the gate decides. A judge failure fails open and delivers. A `tools/response-gate-score.ts` script reads the journal beside a labels file and prints precision and recall at candidate thresholds, so the threshold is a measured value before the mode flips to `live`.

The contract sweep for this plan ran over the repository on 2026-09-30 and returned 74 surfaces under eight headings: the gate and its constructor, loader and tests; the delivery event shape from gateway to relay notification; the operator-keyed paths; the mention writes and their transport; the install scripts and their tests; the docs; the test files pinning each; and the inbox judge. Every surface it returned is in a section's Files in scope below or under Out of Scope.

## Sections of Work

### 1. The sender roster with classes
Model: opus
The gate takes a list of classed entries and keeps the one-id form working. `createSenderGate(entries)` exposes `classOf`, `allows` and `operatorIds`. `loadSenderGate` reads `CHANNEL_SENDERS` and `CHANNEL_ALLOWED_USER_ID`, unions them with the latter as an operator, validates each id as a snowflake and each class as one of the two words, refuses a duplicate id with two classes, and refuses to start with no operator, logging why. The install scripts write and validate the new key beside the old one, and the operations doc's variable table describes both.
Acceptance:
- A host with only `CHANNEL_ALLOWED_USER_ID` set behaves as today: that id is an operator, every other id is refused.
- `CHANNEL_SENDERS=111111111111111111:operator,222222222222222222:participant` admits both, classes them, and `operatorIds` holds the first alone.
- A `CHANNEL_SENDERS` entry with a malformed id, an unknown class, or an id repeated with a different class refuses startup with a log line naming the entry and never the token.
- A list with no operator refuses startup with the existing reason.
- `install/Install-Host.ps1` accepts a senders list, writes it to `broker.env`, and `Install-All.ps1` reads it back and validates it. `Install-All.ps1` requires an operator in either key, and refuses only when both leave it without one.
- `gate.operatorId` still returns the first operator's id, so `broker/index.ts`, the permission desk and the blocked desk compile unchanged until section 3.
Files in scope: `broker/security/senders.ts`, `broker/security/senders.test.ts`, `broker/index.ts` (the `loadSenderGate` call and the startup log line naming the steering user), `install/Install-Host.ps1`, `install/Install-Functions.ps1` (the env-key allowlist), `install/Install-All.ps1`, `install/Install-Host.test.ts`, `install/Install-All.test.ts`, `docs/operations.md` (the variable table and the startup-refusal paragraph).
Tests: the one-id form still admits one and refuses a stranger; the classed form classes each id; every refusal shape refuses; the union of both variables classes the legacy id as an operator.

### 2. The author and class on the delivered event
Model: opus
Every delivered message names who wrote it and what class they hold. The gateway reads the author's display name (the member nickname, else the global name, else the username) beside the id. The broker sanitizes it: invisible characters stripped, cut to 32 code points, and every double quote, angle bracket, square bracket and line break replaced by a space, so it can ride an attribute and can never read as a plugin label. The inbound message, the relay wire event and the relay's channel notification `meta` carry `author` and `sender_class`. The relay client passes both through to the notification.
Acceptance:
- The relay wire event for a delivered message is `{ type: "message", chatId, text, author, senderClass }`, and a client reading an older broker's event without the two fields still delivers.
- The MCP notification's `meta` carries `chat_id`, `author` and `sender_class`; section 5 adds `buffered` beside them, so the pin here is that those three are present, not that no other key is.
- A display name of 40 code points carrying a `<`, a `"` and a newline arrives as 32 code points with those characters replaced.
Files in scope: `broker/routing/gateway.ts` (the message and interaction facts), `broker/routing/inbound.ts` (the `InboundMessage` type and the `deliver` call), `broker/routing/relays.ts` (the wire union), `relay/broker.ts` (the parse and `InboundHandler`), `relay/index.ts` (the `onMessage` wiring that calls `channelNotification`), `relay/protocol.ts` (`channelNotification` and its meta), `broker/sanitize.ts` where the name bound lands, and the test files `broker/routing/inbound.test.ts`, `broker/routing/relays.test.ts`, `broker/routing/http.test.ts`, `broker/tail.test.ts`, `relay/broker.test.ts`, `relay/index.test.ts` wherever they pin the two-field shape.
Tests: the wire event and the notification carry both fields; the name bound holds each replaced character and the cut; an event without the fields still delivers.

### 3. Operator-only consumption and mentions to every operator
Model: opus
Only an operator's message is consumed as the operator's act. The verdict parse and `permissions.resolve` run only for an operator; a participant's verdict-shaped text is delivered as text. A button or menu press resolves only for an operator. `answerTyped` on the question desk consumes only an operator's message; a participant's message while a question is held is delivered as text and leaves the question held. The inbox `clear` and `clearEnded` on delivery run only for an operator's message. Every mention the broker writes, the permission prompt, the question alert, the blocked alert and the model-change alert, mentions every operator id, and `allowed_mentions.users` lists exactly those ids.
Acceptance:
- With one operator and one participant on the roster, the participant's `y abcde` reaches the session as text and the request stays open; the operator's resolves it.
- The participant's press on a permission button is refused with a line reading `who is not an operator`, on the same repeat log as the interaction gate's existing "who is not the allowed sender" line, since the gate does allow the participant.
- With a question held, the participant's message is delivered as text and the question stays held; the operator's message answers it.
- The participant's message leaves the session's inbox item in place; the operator's clears it.
- A permission prompt on a host with two operators opens with both mentions, and the write's `allowed_mentions.users` is exactly those two ids.
Files in scope: `broker/routing/inbound.ts`, `broker/routing/interactions.ts`, `broker/security/permission.ts` (the desk's `operatorId` becomes the operator list), `broker/question-desk.ts` where `answerTyped` is reached, `broker/inbox/store.ts` (unchanged unless its signature must carry the class), `broker/discord/render.ts` (the permission prompt, question notice, blocked alert and model-change renders), `broker/discord/permission-message.ts` (reached from the desk with the operator id), `broker/discord/blocked.ts`, `broker/discord/question-message.ts`, `broker/discord/adapter.ts`, `broker/discord/transport.ts` (its `mentionUserId` field) and `broker/routing/writer.ts` (the mention parameter becomes a list), `broker/index.ts` (the alert wiring), and their tests: `broker/routing/inbound.test.ts`, `broker/routing/interactions.test.ts`, `broker/security/permission.test.ts`, `broker/question-desk.test.ts`, `broker/discord/render.test.ts`, `broker/discord/blocked.test.ts`, `broker/discord/question-message.test.ts`, `broker/discord/adapter.test.ts`, `broker/routing/writer.test.ts`, `broker/index.test.ts`.
Tests: each of the five acceptance bullets in both directions, operator and participant; the mention list on the wire.

### 4. The relay's instructions and the reply tool's description
Model: opus
The static instruction the relay puts in front of the model describes both classes and the buffered delivery, and stays a static literal with nothing interpolated. It says that each event names its author and class on the envelope; that an operator's message carries the standing of the keyboard, as today; that a participant's message is a person's words with no authority over the fleet, taken as conversation and never as steering; that on a host with one allowlisted account every event is the operator's; that a delivered event may hold several messages from several people, each line attributed, gathered since the persona last spoke; and that the reply tool answers the thread, which may hold several readers. The reply tool's description and its result line say the thread rather than the operator.
Acceptance:
- `INSTRUCTIONS` remains a single static literal, and the instruction names the two classes, the envelope attributes, the buffered shape and the one-account host case.
- The reply tool's description and the `Sent to` result line no longer say the message reaches the operator alone.
Files in scope: `relay/protocol.ts`, `relay/index.ts` (the result line), `relay/index.test.ts` (which pins the result line), and `relay/protocol.test.ts` or the test that pins the literal.
Tests: the literal is static and names each of the five facts above.

### 5. The thread buffer and its three certain triggers
Model: fable
A response-gate module holds admitted messages per thread and delivers them together on a mention, a reply-to or a cap. The gateway reads whether a message mentions the bot's own user and whether it replies to a message the bot wrote, and passes both on the inbound message. The mode `CHANNEL_RESPONSE_GATE` is `off`, `shadow` or `live`, default `off`. In `off` and `shadow` every admitted message is delivered at once, as today. In `live` a message joins its thread's buffer, and the buffer is delivered as one event when the message mentions the bot, replies to the bot, or the buffer holds `CHANNEL_RESPONSE_GATE_MAX_MESSAGES` (default 20, the inbound rate ceiling) messages. The age cap is a timer: a buffer delivers when its oldest message reaches `CHANNEL_RESPONSE_GATE_MAX_WAIT_MS` (default ten minutes), whether or not another message arrives, so a held ask is late by at most the cap and never lost. A delivered buffer's text is one line per message, `<author>: <text>`, oldest first, the event's `author` and `sender_class` being the triggering message's, and its meta carrying `buffered` as the count. A verdict, a press and a held question's answer are consumed before the buffer as they are before delivery today. An operator's message clears the session's inbox item when it is admitted to the buffer, whether or not the buffer has delivered, since the operator has answered the session either way. The buffer is memory only, per thread, cleared on delivery and on session end. A message dropped for rate stays dropped: it joins no buffer, counts toward no cap and restarts no quiet window.
Acceptance:
- With the mode `off`, the inbound path delivers the same wire event through the same calls as section 3 leaves it, and every existing inbound test passes unchanged.
- With the mode `live`, three untagged messages then one mentioning the bot deliver one event of four attributed lines with `buffered=4`.
- A reply to the bot's own message delivers the buffer; a reply to another person's message does not.
- A buffer whose oldest message reaches the age cap delivers on the timer with no further message, and a buffer at the size cap delivers on reaching it.
- A held question's answer from an operator is consumed before buffering, and a verdict is too.
- An operator's buffered message clears the session's inbox item at admission.
- Session end clears the buffer and delivers nothing.
Files in scope: a new `broker/routing/response-gate.ts` and its test, `broker/routing/gateway.ts` (mention and reply facts), `broker/routing/inbound.ts` (the gate sits between the operator-keyed paths and `relays.deliver`), `broker/config.ts` (the mode and the two caps), `install/Install-Functions.ps1` (the env-key allowlist every config knob must be on, pinned by `install/Install-Functions.test.ts`), `broker/index.ts` (wiring), `docs/operations.md` (the three variables).
Tests: each acceptance bullet; the `off` mode's no-change pin; the quiet-window behaviour added in section 6 is not this section's.

### 6. The Jev judgement, the shadow journal and the scoring tool
Model: fable
The fourth trigger asks TypeSafe's Jev whether the thread now expects a response, journals every judgement, and ships a tool that turns labelled journal rows into a threshold. The judge call is extracted from `broker/inbox/judge.ts` into a shared client that both callers use with their own constants: the same host, model, timeout, secret screen, failure kinds and never-throw discipline. The gate asks one question of its own, `expects_reply`, worded as: does the latest message in this group conversation expect a response from the assistant? Its one probability is the score the threshold compares against. The call sends the buffered lines with their authors and the seconds since the bot last posted in that thread, never a reply's text. The gate records that clock itself from the gateway: the bot's own posts arrive there as messages with `fromBot` set, and the inbound router stamps the gate's per-thread last-post time before it drops them, which covers the mirror's posts as well as the writer's. The call runs after a quiet window `CHANNEL_RESPONSE_GATE_QUIET_MS` (default five seconds) since the last message in the thread, so a person typing several lines is not cut mid-thought, and at most one call per thread is in flight, a newer buffer waiting for it. At or above `CHANNEL_RESPONSE_GATE_THRESHOLD` (0.4 to 0.95, default 0.6) the buffer delivers with trigger `judge`. A failed or timed-out call delivers with trigger `judge-failed`, since a missed ask costs more than a chatty reply. On a delivery no message triggered, the judge and age-cap cases, the event's `author` and `sender_class` are the newest buffered message's. In `shadow` every message is delivered at once, as today, and the gate keeps a simulated buffer beside that delivery: it accumulates and clears on exactly the decisions `live` would clear it on, the certain triggers and a judge score at or above the threshold, and a hold carries into the next quiet window as it would in `live`. The journal is `response-gate.jsonl` in the directory of the broker's state file, the one `CHANNEL_BROKER_STATE` names. It holds one row per gate decision, and a row's fields are closed at these: `id`, the Discord message id of the newest buffered message, which is the key the labels file uses; time; thread id; session id; trigger; probability where a call ran; delivered or held; and the buffered lines with their authors. No reply text, no key and no token ever enters a row. It rotates at the same size the broker log does. `tools/response-gate-score.ts`, run as `node tools/response-gate-score.ts <journal> <labels>` under the same type stripping every entry point runs under, reads the journal and a labels file of `<id>\t<yes|no>` and prints, for each threshold from 0.4 to 0.95 in steps of 0.05, the precision and recall of the judge against the labels, so the operator picks the threshold from a week of labelled shadow rows.
Acceptance:
- The inbox judge's behaviour and its tests are unchanged after the extraction.
- In `live`, a buffer below threshold after the quiet window is held; a buffer at threshold delivers with trigger `judge`; a timeout delivers with trigger `judge-failed`.
- A second message inside the quiet window restarts the window and no call is made until it elapses.
- In `shadow`, delivery is immediate and the journal row records the probability and `held` or `delivered` as `live` would have decided.
- With the mode `shadow` or `live`, startup refuses with a line naming the mode and the key when the key variable is unset or `readInboxJudgeKey` returns null for any cause, where the inbox judge alone only warns.
- The scoring tool, given a fixture journal and labels, prints the table with the precision and recall a hand count of the fixture gives.
Files in scope: a new `broker/jev/client.ts` and its test, `broker/inbox/judge.ts` (the extraction), `broker/routing/response-gate.ts` and its test, `broker/routing/inbound.ts` (the last-post stamp on a bot message), `broker/config.ts` (threshold, quiet window, journal path), `install/Install-Functions.ps1` (the env-key allowlist), `broker/index.ts` (the key read is shared with the inbox judge's `readInboxJudgeKey`), `tools/response-gate-score.ts` and its test with a fixture journal, `docs/operations.md` (the variables and the labelling procedure).
Tests: the six acceptance bullets; the secret screen still refuses a screened line before the send; the journal carries no key material.

### 7. The security model, the architecture and the install docs
Model: opus
The documents state the classes, the gate and their egress as present fact. The security model gains an attacker class for a participant account, admitted and holding no authority, states that the operator class may hold more than one account and that every one of them holds the full authority the single account holds today, rewrites the sender gate section and the accepted-risk line that says one allowlisted user per host, and adds the response gate's egress: in `shadow` and `live` every admitted message in a gated thread goes to TypeSafe, and the journal holds message text on disk under the state root. The architecture doc gains the buffer's data flow. The install doc says a client host must have its own server, bot and broker, because the gate governs who writes and never who reads, and walks through writing a classed senders list. The operations doc's variable table is complete for every variable the plan adds.
Acceptance:
- Every variable sections 1, 5 and 6 add appears in the operations variable table with its default.
- The security model's accepted-risk list no longer says one allowlisted user per host, and its threat model has an entry for a participant account.
- The install doc states the one-server-per-client rule with the reason.
Files in scope: `docs/security-model.md`, `docs/architecture.md`, `docs/install.md`, `docs/operations.md`, `README.md` where it names the one-account gate.
Audience: the operator installing a client host, expert in this broker; a kit session reading the security model before a review, expert in the kit and new to this repository.
Voice: company.
Fact base: the code as built by sections 1 to 6 and their tests.
Disclosure: no client name, no Discord id, no token, no path outside this repository's own layout.

## Out of Scope

- Delivery from a parent channel. The broker keeps delivering only from threads it opened, one per session.
- A third class, per-user permissions inside a class, or a permission verdict that needs more than one operator.
- A broker serving more than one Discord server, or two brokers on one host.
- Attribution of Discord users' own posts in the mirror. They are native Discord posts and need none.
- The persona plugin's reading of the class from the envelope, its liaison seat and the client VM runbook, which are the companion plans'.
- The judge's question wording as a tuned artifact. This plan ships one wording and the tool to measure it; a wording round is a later plan.
- The archived plan `docs/archive/plans/channels_fleet-card-layout_spec_v1.md`, which names the old variable in an env table and stays as history.

## Assumptions

- assumed 2026-09-30 (a live transcript): Claude Code renders every `meta` entry of the channel notification as an attribute on the `<channel>` envelope after `source`, as `relay/protocol.ts`'s own comment states and as a persona transcript read on 2026-09-30 shows for `chat_id`; reversal: section 2's operator verification fails and the class rides in the text's first line instead, which the persona plan then parses.
- assumed 2026-09-30 (default): the response gate is a per-host mode rather than a per-thread one, since a client host is its own broker and the operator's own fleet host keeps the mode off; reversal: a per-thread switch is a small addition to section 5's config.
- assumed 2026-09-30 (default): the response gate reads the inbox judge's key file rather than a key file of its own, because both name the same TypeSafe key; reversal: one more variable in section 6.
- assumed 2026-09-30 (default): the caps and defaults in sections 5 and 6 are starting values named as tunable knobs, chosen from the inbound rate ceiling and a typing pause, not measured; reversal: the shadow week's journal moves them.
- assumed 2026-09-30 (the operator's message of 2026-09-30): the pilot's clients all hold the operator class, so the participant class is built and tested here but unused until a host names one; reversal: none, the class costs nothing to leave in place.

## Operator Verification

- On the operator's own server, add a second account of the operator's to `CHANNEL_SENDERS` as a participant, restart the broker, post from it into a persona's thread, and read that persona's transcript: the prompt's envelope carries `author` and `sender_class="participant"`. An envelope without the attributes reopens section 2 and the persona plan's first section.
- Set the mode to `shadow` on that host for a week, post as both accounts, label a hundred journal rows, run the scoring tool, and pick the threshold. A precision below what the operator will accept at every threshold reopens section 6's question wording as a new plan.
- Flip the mode to `live` on that host with the chosen threshold, hold a short two-person conversation with one deliberate ask, and confirm the ask reached the persona as one attributed event. An ask that never arrived before the age cap reopens section 6.

## Open Questions

- Whether a participant's message should ever be able to mention an operator through the broker. The plan keeps every broker-written mention bound to the operator list, so it cannot; the operator decides if a client user should be able to page the operator through the persona. Owner: the operator.

## Related plans

- `agent_persona_client-sandbox_spec_v1.md` in the `agent_persona` repository: reads this plan's `sender_class` attribute, adds the liaison seat and carries the client VM runbook.
- `claude-kit_liaison-seat_spec_v1.md` in the `claude-kit` repository: the liaison skill and the doctrine's class-aware relay clause.
- `docs/archive/plans/sapplefeld-channels_spec_v1.md`: the original design, which listed multi-user access as a non-goal. This plan supersedes that non-goal.

## Chapters
