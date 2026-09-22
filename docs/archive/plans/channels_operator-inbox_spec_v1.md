# Operator Inbox

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-21

## Goal

A reply from a session that needs something from the operator lands in one inbox the operator reads
first. The inbox is a standing pinned card in the host's Discord channel, `Fleet: Inbox`, carrying
one line per session that holds an open ask, with a link into that session's thread. An ask is
recognized two ways: the session marks it with an `ASK:` line in its reply, or, where the reply
carries no mark, an external judge (TypeSafe's Jev) scores the reply and a score at or above a
threshold opens the item. An item leaves the inbox when the operator sends that session a prompt,
from Discord or from the console, and never because the operator merely read it. It matters because
sessions drop decisions, questions and operator-only acts into long status reports without a
`BLOCKED:`, and the operator, scrolling forward from Discord's last-read marker, misses some.

## Intent

**The frame, in the operator's words.** "What I need to handle is more than blocked. They drop a lot
of decisions, input, questions to me without marking BLOCKED." "It would just be neat if there was
some kind of check for whether a message needed a response from me, instead of just being an update,
so those could be flagged and held separately to be sure I see them first." "Right now, Discord saves
where I last read, so I basically just start there and scroll forward, scanning for any questions. I
still miss things." On the judge: "if the session specifies, that's optimal, but running it through
Jev is a quick extra check in case it didn't." On the judge's question: "many asks don't full stop,
they just tell me something I need to rule on and keep going, or give me a task to do when I get to
it that they can't handle."

**What done needs to do.** Hold every open ask in one place the operator sees before anything else.
Catch an ask whether or not the session stopped for it, and whether it wants a reply or an act such
as a merge. Work from the first day, when no session marks its asks, which is why the judge runs
from day one (operator ruling, 2026-09-21). Keep an item until the operator has answered that
session.

**What done does not need to do.** It does not need to be right every time: a false alarm costs one
glance, and a miss is the status quo. It does not need to ping the phone. It does not need to show
the ask's text for a judge-opened item, only where it is. It does not need to track several asks per
session separately. It does not need a glasses screen, a voice reply path, or any listener beyond
the broker's loopback one. It does not need to teach sessions to write `ASK:`, which is the kit's
to do in its own repository.

**Alternatives refused.**
- A model call inside the card renderer: refused, because every standing card here is deterministic
  by design and the judge belongs at intake, once per reply.
- Clearing an item when the operator reads the thread: refused, because reading is how asks get
  missed today.
- A new field on the relay's reply tool as the producer signal: refused for this plan, because the
  mirrored final reply arrives from the Stop hook with no tool call to carry a field, so a text
  line is the only mark that rides both paths.
- One judge question with "before the agent can continue": refused on the calibration spike, where
  it missed every ask-and-continue and every "your merge" message.
- Reusing the personas repository's TypeSafe client: refused, because this broker has no build
  step and no package path to a sibling repository, and one fetch is smaller than that dependency.

**Rulings after the spec shipped.**
- 2026-09-21: a supervised persona session's reply that carries the steward-shaped ask line is
  neither marked nor judged. The Architect reported that workers ask the steward often and the
  operator rarely prompts a worker directly, so those lines would rest on the card for days. The
  operator chose this over keeping them, and over applying the rule to every session. The accepted
  cost: an ask meant for the operator inside such a reply is missed unless it arrives as a
  `BLOCKED:`.

**Provenance.** Distilled from the Expert seat's design session on SCOTT-CLAUDE, 2026-09-21
(session `b0a32d8b`), including the operator's Discord relay messages in that session's thread and
the calibration spike recorded under `D:\personas\.kit\jev-inbox\FINDINGS.md`.

## Approach

**Where the text is.** A session's replies reach the broker as plain strings at two sites, and the
inbox taps both after the existing checks have passed. The mirrored turn-final reply is the string
`handleMirror` extracts at `broker/intake.ts:814` and hands to `outbound.mirror` (kind `reply`),
which sits behind the per-session mirror suppression header, so a reply the operator chose not to
mirror is never judged. A reply-tool answer is the `text` argument of `reply` at
`broker/routing/outbound.ts:976`. The tap is taken in the outbound router, never in the intake handler. It fires where a reply's
text is on the thread and the inbox has not seen it: after a landed reply-tool post, after a landed
reply mirror, and where a reply mirror is dropped as an interim echo
(`broker/routing/outbound.ts:1113`), since the tailer posted that text as narration and narration
is never tapped. A reply mirror dropped as an answer echo is not tapped, since the reply-tool tap
already saw that text. It sits there so the inbox sees exactly what reached the thread and the hook's 202 is never delayed. Prompts, narration chunks and peer messages are not tapped. A session running with its mirror
off still posts reply-tool answers, and those are parsed for `ASK:` lines and never sent to the
judge, so switching a session's mirror off also keeps its text from the vendor.

**The producer signal.** A line whose first non-space characters are exactly `ASK:` (uppercase, the
colon included) and which sits outside a fenced code block marks an ask. A blockquoted `> ASK:`
line and a bulleted `- ASK:` line do not, since their first non-space character is the marker. The rest of that line,
whitespace-collapsed and cut to 200 code points, is the item's excerpt. A reply carrying at least
one such line opens or refreshes the session's item with source `marked`, and the judge is not
called for it. The kit has no `ASK:` convention today. The persona plugin does: `agent_persona`'s
`hooks/index.ts` matches a worker's turn-final answer against a line of the form
`ASK: <question>? Recommend: <choice>` and opens an ask record that a reader or the steward
answers. That line is addressed to the steward, so it is kept off the operator's card. A supervised
session is one whose record carries a lineage (`SessionRecord.lineage`, set from `CHANNEL_LINEAGE`,
which `agent_persona`'s supervisor sets on every session it launches and an interactive session
never carries). A reply from a supervised session that carries at least one steward-shaped line, an
`ASK:` line whose text contains `? Recommend:` on the persona matcher's own pattern, is neither
marked nor judged: it opens nothing and its text is not sent to the judge. A plain `ASK:` line in
that same reply does not change this, and a worker's ask of the operator reaches him as a
`BLOCKED:`, which the blocked desk already carries. The same line from a session with no lineage is
an ordinary `ASK:` line and marks an ask.

**The judge.** Jev is a hosted classifier from the vendor TypeSafe. A caller posts a JSON state and
a set of named questions, and each answer comes back with a number. For a yes-or-no question (type
`noul`) that number is the probability of yes, from 0 to 1. A tapped reply with no `ASK:` line goes
to it: `POST https://api.typesafe.ai/v1/systemone`, headers `Authorization: Bearer <key>` and `Content-Type: application/json`, body
`{ state: { message }, model: 'jev-latest', questions }`. The response is JSON whose
`answers.needs_reply.noul` and `answers.needs_act.noul` are the two numbers. A body where either is
absent, not a finite number, or outside 0 to 1 is malformed. The two questions are stated in full
under section 2. The score is the larger of the two numbers. A score at or above the threshold
opens or refreshes the item with source `judged`, recording both scores and which question won. The
call is detached from the post, has a 5-second timeout and is never retried. Each session has one
call in flight at most and one reply waiting at most. A reply that arrives while a call is in
flight takes the waiting place, replacing any reply already there, and is judged when the call in
flight returns. The call in flight is never aborted and its result is always used. Any failure opens nothing and logs one
rate-limited line that carries no reply text. What the judge sends is closed at this: the text of a tapped reply that carries no `ASK:` line and
does not match the secret screen, cut to its first 12,000 code points. Length never blocks a send.
A reply with an `ASK:` line, a reply matching the screen, and any text that is not a tapped reply
are never sent. The secret screen is stated in full under section 2. This is the broker's first outbound call to a host other than Discord, confirmed by a
search for `fetch(` outside test files that returns nothing while the same search inside them
returns two files.

**The item.** The inbox holds at most one item per session, keyed by session ID: the set is closed
at one item per live session record, so its size is bounded by `CHANNEL_MAX_SESSIONS`. An item
carries the session ID, the instant it opened, the instant it was last refreshed, its source, its
excerpt where marked, its scores where judged, a count of flagged replies since it opened, and the
Discord message ID of the most recent flagged post where the writer returns one. Every flag
carries the instant its reply arrived, read from the broker's clock before the reply's run rather than after it lands, and that instant
is what an open or a refresh records, never the later instant a judge verdict returns. A flagged
reply for a session that already holds an item refreshes that item and never opens a second. A
reply with several `ASK:` lines takes its excerpt from the first. A refresh by a marked reply
replaces the excerpt, and an upgrade to `marked` keeps the scores already held. This is the
dedup the spike called for: a close-out recap restating a standing wait attaches to the ask it
restates. A `marked` flag upgrades a `judged` item, and never the reverse.

**Clearing.** An item clears when an operator prompt for its session carries an instant later than
the item's last refresh. The store also keeps each session's latest operator-prompt instant, and a
flag whose post instant is not later than it is dropped. So a judge verdict that returns after the
operator has already answered opens nothing. A prompt is an operator prompt only where a person
typed it: the harness's own wake injection and a peer session's message are not, which the registry
already separates at its stamp. The registry's operator-prompt stamp (`broker/registry.ts:757`, fed by all
three prompt paths) is one source. A Discord message the inbound router delivered
(`broker/routing/inbound.ts:287`, the `delivered` branch) is the other, because a channel message
that lands mid-turn may fire no prompt hook. The instant the clear receives is the clamped stamp the registry computes on the first path, and
the broker's clock at delivery on the second. A Discord message the router could not deliver to a
live session clears nothing, and the ended-session case is stated below. An answer from anyone other than the operator clears nothing, by design. The steward-shaped rule
above is what keeps a worker's steward asks from resting on the card unanswerable.
`SessionStart` and `PostToolUse` do not clear an item,
which is the deliberate difference from the blocked desk: a session that asks and keeps working
makes tool calls all the while. A message the inbound router consumed as a permission verdict or a
held-question answer does not clear an item. A stale record keeps its item, since a stale session can revive. An ended record keeps its item
too, drawn with an ended marker, because an act such as a merge outlives the session that asked for
it. That item leaves when the operator posts any message in the ended session's thread, which the
inbound router sees behind the sender gate even though it delivers nothing, or when the registry
prunes the record. The store reconciles against the registry's session set on the registry's
mutate signal, which is how a pruned record's item leaves.

**The card.** `Fleet: Inbox` is a third standing card on the board card's pattern: its own thread,
a persisted `{messageId, threadId}` binding, an edit only when the rendered bytes change, a
permanent pin slot through `permanentCards` at `broker/index.ts:767`, off unless
`CHANNEL_INBOX_CARD` is on, and off meaning no thread, no timer and no judge call. It joins
the permanent pins, and this plan claims nothing about where Discord draws it among them: the pin
keeper pins what is missing and never reorders (`broker/discord/pins.ts:298`). Each line carries the session's
title through the existing name escape, a glyph for the kind (reply or act, or marked), the age, the
excerpt for a marked item through the full live-markdown escape, and a link to the flagged message
or to the thread where no message ID is held. Items draw oldest first. An empty inbox draws one
fixed line. The renderer is pure and makes no model call. The card mentions nobody.

**Persistence.** Items survive a broker restart through a versioned snapshot written
temp-file-then-rename beside the card binding, degrading to an empty inbox rather than refusing to
start. A restored item whose session record did not restore is dropped.

**Sweep.** One Explore sweep ran over the repository for nine contracts: the mirror path, the
blocked desk, the standing cards, the inbound router, config, the security model, outbound HTTP,
tests, and the architecture document. The surfaces it returned, each confirmed by opening the file:
`broker/intake.ts`, `broker/routing/outbound.ts`, `broker/routing/inbound.ts`, `broker/registry.ts`,
`broker/index.ts`, `broker/config.ts`, `broker/discord/config.ts` (token-file reader),
`broker/discord/blocked.ts`, `broker/discord/pins.ts`, `broker/discord/render.ts`,
`broker/discord/budget.ts`, `broker/board/thread.ts`, `broker/board/binding.ts`,
`broker/board/card.ts`, `broker/usage/*`, `install/Install-Functions.ps1`
(`$script:ChannelBrokerEnvAllowlist`), `hooks/settings-fragment.json`, `docs/architecture.md`,
`docs/operations.md`, `docs/install.md`, `docs/security-model.md`, and their sibling test files.

## Dispatch Authorization

The operator approved this design on 2026-09-21 and gave its scheduling to the Architect seat, so the grant covers the session the Architect's schedule assigns and no other. His words to the Expert seat, at the keyboard: "I'm fine with you skecthing out the plan and handing it off to the Architect to review and schedule." On the sketch and the day-one judge ruling: "I'm good with the Inbox on Jev from Day 1. I love this. Let's go forward!" The section is written by the Expert seat's session, which commits under the machine's one git identity, so a receiver records the trace as the sending seat's report of the operator's word.

## Sections of Work

### 1. Inbox store and the `ASK:` parser
Model: opus
A new module `broker/inbox/store.ts` holding the item map, the open-or-refresh rule, the upgrade
rule, the clear rule, the drop-on-session-end rule and the snapshot. A new `broker/inbox/ask.ts`
holding the pure line parser. Acceptance: a reply with an `ASK:` line outside a fence opens a
`marked` item with the bounded excerpt; the same line inside a fence, a lowercase `ask:`, and
`ASK:` mid-line open nothing; a second flagged reply refreshes and increments the count; a `judged`
item upgrades to `marked` and not back; a clear with an instant at or before the last refresh leaves
the item; the map never exceeds one item per session; a snapshot round-trips and a malformed one
yields an empty inbox.
Files in scope: `broker/inbox/store.ts`, `broker/inbox/ask.ts`, their tests.
The parser also reports whether a reply carries a steward-shaped line, as a separate pure
function, and section 3 applies the lineage condition.
Tests: lock the parser's three refusals, since a parser that matches quoted code turns every
code review into an ask; lock the clear rule's instant comparison in both directions, since a clear
that fires on an older prompt silently empties the inbox.

### 2. The judge
Model: fable
A new module `broker/inbox/judge.ts`. The two questions, each of type `noul`, share this preamble: "The
`message` is the final reply an AI coding agent sent to its human operator at the end of a work
turn. The operator reads many such messages a day and wants to see first the ones that need
something from them." `needs_reply` continues: "Does this message ask the operator to decide
something, answer a question, or confirm a choice? Count it whether or not the agent keeps working
meanwhile. A message that only reports progress, results, or findings does not count." Its criteria
are true "Yes, the operator is asked to decide, answer, or confirm something." and false "No,
nothing in it asks the operator to decide, answer, or confirm." `needs_act` continues: "Does this
message tell the operator that some act is theirs to perform now, such as merging a pull request,
approving a change, running a command or installer, or restarting something? A future act that
becomes due only after further work does not count." Its criteria are true "Yes, an act is the
operator's to perform now." and false "No, nothing is the operator's to do now." Each question is an
object `{ type, instructions, criteria: { true, false } }` keyed by its name. The secret screen is
one case-insensitive pattern, and a reply matching any branch is not sent: an `api_key` or
`api-key` assignment to a quoted value of 12 or more characters, `bearer` followed by 20 or more
token characters, a PEM private-key header, `sk-` followed by 20 or more token characters, a GitHub
token prefix (`gho_`, `ghp_`, `ghs_`, `github_pat_`) followed by 20 or more characters, and a
`password` assignment to a quoted value. The module holds the two questions as constants, the secret screen, the cut,
the fetch with its timeout, the response read (both `noul` values, refusing a malformed body), the
per-session single-flight, and the rate-limited failure log. The module takes the key and the threshold as arguments and reads no setting, so this section
touches no config file. Every setting lands in section 3. Acceptance: against an injected fetch, a body scoring 0.71 on
either question returns a flag, exactly 0.7 returns a flag, and 0.69 on both returns none at
threshold 0.7; the request carries both headers; a timeout, a non-2xx
and a malformed body each return none and log without reply text; a reply matching the secret
screen makes no call; the host is a constant and no setting can redirect it; a reply arriving while a call is in flight replaces any reply already waiting, the in-flight
verdict is still used, and the waiting reply is judged next.
One live call closes the section: where `TYPESAFE_API_KEY` is present in the implementer's
environment, a throwaway script under `.kit/` sends one fixed harmless message through the module
and reads two numbers back, and the Chapter records the two values. Where the key is absent the
Chapter says so and the check moves to Operator Verification.
Files in scope: `broker/inbox/judge.ts`, its test.
Tests: lock that no failure path throws into the caller and that no log line carries reply text,
since this module handles the one string the security model says must not leak; lock the secret
screen in both directions.

### 3. Wiring: taps, clears and settings
Model: opus
`broker/index.ts` constructs the inbox only when the card is on and hands it to the outbound
router, the inbound router and the registry as an optional seam, the way `standingBlocked` is
threaded today, so with the card off each call site holds a no-op. The outbound router calls the
inbox after a landed `reply` and a landed mirror of kind `reply`. The
registry's operator-prompt stamp and the inbound router's delivered branch call the clear. Settings:
`CHANNEL_INBOX_CARD` (strict flag, default off), `CHANNEL_INBOX_JUDGE_KEY_FILE` (the key is read
from this file and never from `broker.env`; with none set the judge is off and the inbox runs on
`ASK:` lines alone; a file that is set but unprotected, missing or empty turns the judge off with
one warning and never stops the broker, unlike the Discord token file),
`CHANNEL_INBOX_THRESHOLD` (bounded 0.4 to 0.95, default 0.7), `CHANNEL_INBOX_CARD_REFRESH_MS` on the
board card's bounds; all four join `$script:ChannelBrokerEnvAllowlist`. Acceptance: with the card
off, no inbox module is constructed and no fetch is made; a suppressed mirror, a prompt, a
narration chunk and a peer message reach the inbox never; a permission verdict and a held-question
answer clear nothing; a delivered Discord message and a console prompt each clear; `PostToolUse`
and `SessionStart` clear nothing; a supervised session's reply carrying a steward-shaped line opens
nothing and makes no judge call, and the same reply from a session with no lineage opens a marked
item; a stale session's item stays; an ended session's item stays until
an operator message in its thread or the record's prune, and then leaves; a mirror-off session's
reply-tool answer is parsed and never judged; a reply mirror dropped as an interim echo is tapped
and one dropped as an answer echo is not.
Files in scope: `broker/routing/outbound.ts`, `broker/routing/inbound.ts`, `broker/registry.ts`,
`broker/index.ts`, `broker/config.ts`, `install/Install-Functions.ps1`, `broker/intake.test.ts`, and their tests.
Tests: lock each never-tapped kind and each never-clearing event, since each is a silent bypass.

### 4. The `Fleet: Inbox` card
Model: sonnet
`broker/inbox/card.ts`, `thread.ts` and `binding.ts`, cloned from `broker/board/card.ts`,
`thread.ts` and `binding.ts` with the inbox's renderer. It joins `permanentCards`. The glyphs, the empty-inbox line and the age format are the
implementer's to choose on the board card's conventions, and the renderer takes its clock as an
argument so a fixed clock yields fixed bytes. The session title and the excerpt both go through
`inertField` in `broker/discord/render.ts` (amended at finishing from `inertName` for the title, the
decision Chapter 4 records). Acceptance:
the rendered card for a fixed item set is byte-stable; an unchanged render issues no edit; an
excerpt carrying a mention, a masked link, a heading marker and a backtick fence draws inert; an
empty inbox draws the fixed line; the pin keeper's sweep recognizes the card as the broker's own.
Files in scope: `broker/inbox/card.ts`, `broker/inbox/thread.ts`, `broker/inbox/binding.ts`,
`broker/index.ts`, `broker/routing/gateway.ts` (the guild accessor the jump link needs), `broker/discord/pins.ts` only if its known-card set needs the new ID, and tests.
Two sentences that count the standing cards as two are corrected here: the comment at
`broker/board/binding.ts:8` and the test title at `broker/discord/pins.test.ts:214`.
Tests: lock the escape of the excerpt, the one model-authored string this card draws outside a
fence.

### 5. Documents
Model: opus
`docs/architecture.md` gains "The operator inbox" beside the blocked desk and a fourth entry under
External integrations, with how the judge fails. `docs/security-model.md` gains the judge as a named
egress: what is sent (a session reply's text, cut and screened), to whom, under which key, what is
never sent, and the accepted residuals, namely that the secret screen is a pattern and not a proof,
and that reply text leaves the machine to a third party for every unmarked reply while the judge is
on. `docs/operations.md` gains the four tunables, how to read the card and how to turn the judge
off. `docs/install.md` gains the key-file step. `docs/README.md` is updated by the close-out.
Audience: the operator, expert in this system; a future session with no context, engineer level.
Must answer: what opens an item, what clears one, what leaves the machine and how to stop it.
Voice: company. Fact base: the as-built modules of sections 1 to 4.

## Out of Scope

The surfaces this plan changes are closed at the sections' Files in scope. Named exclusions:

- The kit rule telling sessions to write an `ASK:` line. It is a separate plan in the claude-kit
  repository. The compatible shape for it is an `ASK:` line without `Recommend:`, which the persona
  plugin's matcher does not read as a worker's ask record.
- Reading the persona plugin's ask records so a steward-answered ask clears. It would couple this
  broker to a sibling repository's state.
- Any glasses screen, voice reply path, or non-loopback listener. A later plan reads this inbox.
- A mention or phone ping when an item opens.
- Per-ask items within one session, and any excerpt for a judge-opened item.
- A field on the relay reply tool (`relay/protocol.ts`) and any change to `hooks/settings-fragment.json`.
- Threshold tuning against the operator's own replies. The scores are stored so it can be done later.
- The blocked desk, the question desk and the board card, which are unchanged.

## Assumptions

- assumed 2026-09-21 (operator ruling in the design session): the judge runs from day one, before any session marks asks; reversal: set no key file and the inbox runs on marks alone.
- assumed 2026-09-21 (FINDINGS.md of the calibration spike): threshold 0.7 and the second round's two questions; reversal: one setting and two constants.
- assumed 2026-09-21 (default): one item per session, restated asks attaching; reversal: a store rewrite, section 1.
- assumed 2026-09-21 (default): no ping on open, because a judge false alarm would buzz the phone about one reply in three flagged; reversal: a fifth mention-bearing write with its own window and security-model entry.
- assumed 2026-09-21 (default): the broker makes its own minimal fetch and shares no TypeSafe client with the personas repository; reversal: swap one module's transport.
- assumed 2026-09-21 (broker/discord/config.ts token-file pattern): the judge key lives in a file, not in `broker.env`; reversal: small.
- assumed 2026-09-21 (operator ruling, 2026-09-21, that every project may send information to TypeSafe): mirrored reply text may go to Jev; reversal: the judge is off without its key file.
- assumed 2026-09-21 (default): sections 1 to 3 ship dark, and nothing is visible to the operator until section 4's card; reversal: none needed, the card is off by default.
- assumed 2026-09-21 (default, the operator's to overrule): an ended session's item stays until an operator message in its thread or the record's prune; reversal: one store rule, section 1.
- assumed 2026-09-21 (default, the operator's to overrule): a mirror-off session is never sent to the judge; reversal: one condition, section 3.
- assumed 2026-09-21 (the repository's own rule): Branch-and-PR, since `main` refuses a direct push; reversal: none available.

## Operator Verification

- Find the `Fleet: Inbox` card on the phone. If it is not quick to reach among the pins, that
  reopens where the card lives, which this plan does not control.
- Turn the card and judge on for SCOTT-CLAUDE, then watch one real day. An ask that never reached
  the card, or a card that fills with updates, reopens section 2's threshold or questions.
- Reply to a flagged session from the phone and confirm its line leaves the card.
- Decide whether `docs/security-model.md` gets a `## Threat model` section as its own effort. The
  finishing security review opened `threat model: absent`, and the backlog carries the item.

## Open Questions

- Answered: the mirror writer returns its run's final message ID (`lastMessageId`) when the whole
  run lands, so the card draws a jump link to the flagged message and falls back to the thread chip
  where none is held.
- Answered: the Architect's schedule record scheduled the plan, and this session executed it.

## Related plans

- `channels_blocked-state_spec_v1.md`: the blocked desk, the nearest sibling surface.
- `channels_board-card_spec_v1.md`: the card pattern section 4 clones.

## Chapters

### Chapter 1 - 2026-09-21
Completed: 1. Inbox store and the `ASK:` parser
Implemented By: implementer-opus (one dispatch, one follow-up for the operator's ruling, two fix rounds on the same agent)
Metrics: review rounds 1, closed major-closed; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 2 findings, 2 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 1 open: builds broker/inbox/store.ts (item map, open-or-refresh, upgrade, clear, drop, snapshot) and broker/inbox/ask.ts (line parser); serves the Goal's "An ask is recognized ... `ASK:` line" and Approach "The item", "Clearing", "Persistence"; adds only the store and parser mechanisms the section names; size est. ~300 lines code plus tests; not building it leaves sections 2 to 4 nothing to write into. Round 1 fix, blind Major (store.ts flag(), spec-traceable to "a snapshot round-trips and a malformed one yields an empty inbox"): flag() validates postedAt finite, excerpt within 200 code points, messageId a snowflake, dropping what the loader would refuse; adds no mechanism; ~8 lines; not building it lets one bad flag cost every item on the next boot. Round 1 fix, blind Major (store.ts clearEnded, spec-traceable to Approach "Clearing"): clearEnded(sessionId, at) records the operator's post instant as a prompt instant so a late verdict is dropped by the existing rule; adds no mechanism; ~3 lines; not building it leaves a reopened item resting on an ended session. Round 1 fix, security Major confirmed CONFIRM by the scope adjudicator on docs/security-model.md lines 70-73 and 155-156 (ask.ts STEWARD_ASK): a `(?=\S)` lookahead after `\s*` so a whitespace run cannot backtrack (measured 299 ms red at 40,000 spaces, 0.6 ms green); adds no mechanism; one line plus a test; not building it lets a token holder park the broker's event loop once section 3 wires the check. Operator ruling: PR 15 (32939cd) landed after this section was dispatched and added the steward-shaped rule; the branch fast-forwarded to it and the parser gained `hasStewardAsk`, copying the persona plugin's `askMarkerMatch` regex, as a follow-up round rather than a re-dispatch, since the ruling was additive. The header's Status moved from Ready to In Progress. Section 2's spec text changed from "`sk-` followed by 20 or more alphanumerics" to "token characters" to match its review fix (recorded in Chapter 2). Assignment record: Architect schedule record steward-d5b91e27-ba82-4596-ba86-b73ed407697e-11 amended by -12, anchor 32939cd, relayed by the coordinator; the operator confirmed on the relay thread. Refresh order: fields an item shows follow posting order, and a marked flag upgrades a judged item whatever its order. Tab handling: whitespace collapses before `visible()` so a tab keeps the words it separated apart.
Assumptions: assumed 2026-09-21 (default, section 1): CommonMark fence rules, a backtick opener refusing an info string with a backtick; reversal: one regex. assumed 2026-09-21 (default, section 1): a mark with nothing after it still marks with an empty excerpt; reversal: one condition. assumed 2026-09-21 (default, section 1): one malformed item refuses the whole snapshot; reversal: drop the item instead. assumed 2026-09-21 (default, section 1): a judged flag on a marked item updates the scores and winner; reversal: one branch. assumed 2026-09-21 (default, section 1): a marked flag with an excerpt the loader would refuse is dropped rather than cut; reversal: cut instead. assumed 2026-09-21 (default, section 1): operator-prompt instants are not persisted; reversal: add them to the snapshot.
Review Findings: review: code pair at fable, Agent tool; security lens at fable, Agent tool. Blind Majors, both orchestrator-traced spec-traceable and fixed: flag() accepting what the loader refuses; clearEnded recording no instant. Security Major (advisory) confirmed by relevance ruling and fixed: STEWARD_ASK quadratic backtracking. Security Major (advisory) on the excerpt bounded before cleaned: covered by the blind Minor on the same defect, fixed with `visible()`. Minors: 7 fixed in the round (posting-order refresh, non-finite instants, `visible()` on the excerpt and on restore, the stale line pointer, the parity comment narrowed, the save docstring, the snowflake check in flag), 0 upgraded, 3 left with the reason (a fence opener inside a list item, which CommonMark reads as a list item; restored instants unbounded against the clock, consistent with persistence.ts and the hardened state root; the persona plugin's placeholder refusal, named in the comment rather than mirrored). Carried to section 5: the snapshot as a new on-disk holder of reply text for the security model's inventory. Routed to docs/backlog.md: the pre-existing npm audit findings.
Stamps: adjudicated 8, stamped 4 (source-code-may-leave-the-lan-to-typesafe, typesafe-request-body-retention-risk-accepted, forward-resource-arrangements-into-dispatch-briefs, release-an-exclusive-claim-at-the-operations-end-not-the-turns-end, operator tier); the window (2h, from the plan's start) is accounted for by the recall and the briefs.
Gate: targeted lane, `node --test broker/inbox/store.test.ts broker/inbox/ask.test.ts` at 2026-09-21T20:20Z on SCOTT-CLAUDE, worktree carrying section 2's uncommitted fix delta: 37 tests, 37 pass, 0 fail, exit 0, 128 ms; `npm run lint` exit 0. Baseline on this lane: none (new files). Whole-gate baseline at 191d54a, clean tree, 2026-09-21T19:53Z: 1851 tests, 1850 pass, 0 fail, 1 skipped, exit 0, 40 s wall, taken under this session's own claim with no foreign process. Test delta: 37 added, 0 retired, 0 edited. Added tests pin: the three parser refusals (fence, lowercase, mid-line) with a closing-fence control; quoted and bulleted refusals; CommonMark fence shapes; the inline-code opener; the empty-remainder mark; the 200-code-point cut on astral characters; the invisible-class strip; the steward-shaped line on the persona pattern (five cases) and its linear-time bound; open, refresh, count; the judged-to-marked upgrade and never back; the clear rule in both directions with the equal case; the late-flag drop; clearEnded recording its instant; non-finite instants ignored; posting-order refresh and message-ID order; flag validation dropping or normalizing what the loader refuses; onChange firing only on change; items() copies and order; reconcile; snapshot round-trip; ENOENT silent; invalid JSON, wrong version, malformed item, duplicate session and unclean excerpt each refusing with one log line carrying no excerpt (withheld control); temp-file cleanup on success and failure. Spawning tests: 0. Contention: none on this lane's runs (claim held by this session or empty at each spawn; the foreign agent_persona and claude-kit claims that ran during the section were waited out by the implementer at each spawn).
Next: 2. The judge (round 2 in flight); then 3. Wiring: taps, clears and settings
Commit Model: Branch-and-PR
Delta: taken at 2026-09-21T20:21Z on SCOTT-CLAUDE at 72628a5, no contention; the reading `node <plugin-root>/scripts/kit-size.js report --repo D:/personas/dev-discord/repo` prints:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-21
Completed: 2. The judge
Implemented By: implementer-fable (one dispatch, two fix rounds on the same agent)
Metrics: review rounds 2, closed major-closed; provenance 1 spec-traceable, 1 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 0 asked); advisory: 1 finding, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 2 open: builds broker/inbox/judge.ts (two noul questions, secret screen, 12,000 cut, fetch with 5 s timeout, response read, per-session single-flight, rate-limited failure log); serves the Goal's "an external judge (TypeSafe's Jev) scores the reply" and Approach "The judge"; adds only the mechanisms section 2 names; size est. ~250 lines code plus tests; not building it leaves the inbox blind to every unmarked ask, which is every ask on day one. Mid-work, implementer report: catch a throw out of onVerdict and log it as kind `verdict handler threw`; serves section 2's acceptance "the waiting reply is judged next" and its tests line "no failure path throws into the caller"; adds a guard (a mechanism); 5 lines; design stop, ruled ACCEPT-AND-DECLARE by the scope adjudicator on section 2's acceptance clause (spec lines 233-234) and tests line (240), the fifth failure kind the module's closed set carries; the first dispatch of that judge returned NEEDS_CONTEXT on a brief defect of mine (an Approach sentence and the cost clause rode in), corrected on the one re-dispatch. Round 1 fix, blind Major (judge.ts secret screen, orchestrator-traced to section 2 "sk- followed by 20 or more alphanumerics" and "lock the secret screen in both directions"): widen the sk- branch to token characters so sk-proj- and sk-ant- keys match; adds no mechanism; not building it sends a pasted vendor key to the judge. Spec deviation: section 2's wording updated to "token characters" (approval drift, deliberate). Round 2 fix, adversarial Major (fix-introduced, trace Goal "external judge scores the reply"): anchor the widened branch with \b so a kebab-case word ending in "sk" does not match; adds no mechanism; not building it silently drops every reply naming such an identifier. Surprise: the round 1 widening introduced the round 2 false positive, caught only because the fix delta touched the outbound call and so owed its round. Declared assumption (route b): a screened or empty reply is dropped at submit and does not displace a reply already waiting. Line endings: the brief said siblings are CRLF; this worktree holds LF, and git normalizes on commit.
Assumptions: assumed 2026-09-21 (default, section 2): flags only are delivered, never null; reversal: one call. assumed 2026-09-21 (default, section 2): a screened or empty reply does not displace a waiting reply; reversal: three lines. assumed 2026-09-21 (default, section 2): the repeat log is a local copy of the question desk's shape, keyed by failure kind, since neither sibling limiter is exported; reversal: export one and import it. assumed 2026-09-21 (default, section 2): the GitHub and bearer branches take token characters `[a-z0-9_-]`, and `api[_-]key` names exactly the spec's two spellings; reversal: one character class each. assumed 2026-09-21 (default, section 2): the threshold is not re-validated in the module, since its one producer is section 3's bounded setting; reversal: a finite check at construction.
Review Findings: review: code pair at fable, Agent tool; security lens and performance lens at fable, Agent tool; round 2: adversarial lens at fable, Agent tool. Design stop: the verdict-handler guard, ruling ACCEPT-AND-DECLARE by the scope adjudicator. Round 1 blind Major (sk- shapes) orchestrator-traced spec-traceable, fixed. Round 2 adversarial Major (unanchored sk-) fix-introduced, fixed. Security Major (advisory): the header cited a security-model residual the document does not carry until section 5; fixed on the honesty route (present-tense sentence; section 5 makes it true before the plan closes, and the finishing pass checks it). Minors: 8 fixed (settle the flight on both arms; redirect "error"; body sentinels; the environment predicate; the threshold seam docstring; the repeat-log comment and its set-before-log order; the prose near-miss control; the anchor), 0 upgraded, 6 left with the reason (a NaN threshold, producer-bounded; unquoted api_key, Discord token and connection-string shapes, the spec's six branches being the contract and carried to section 5's residual wording; a fleet-wide concurrency cap, the spec bounding per session; the unbounded response body, time-bounded and the vendor's; the abort-signal pin; the trailing suppressed count). Carried to section 3: JudgeWinner and the scores shape declared in both judge.ts and store.ts, unified at the call site. Routed to docs/backlog.md: sliceCodePoints spreading the whole string (17 ms at 4 MB).
Stamps: adjudicated 2, stamped 0 (kit-project-memory-does-not-resolve-from-current-checkout and jev-checks-stated-promises-and-cannot-invent-the-question were read for context and changed nothing this section built); the window (1h) is accounted for.
Gate: targeted lane, `node --test broker/inbox/judge.test.ts` at 2026-09-21T20:24Z on SCOTT-CLAUDE, worktree carrying only this section's round 2 delta over c3b3c1b: 22 tests, 22 pass, 0 fail, exit 0, 110 ms; `npm run lint` exit 0. Baseline on this lane: none (new file). Test delta: 22 added, 0 retired, 0 edited. Added tests pin: the threshold at 0.71, exactly 0.7 and 0.69 on both; both request headers, the body shape, the constant host and model, the redirect refusal; the 12,000-code-point cut on astral characters and the screen running past the cut; timeout, network, non-2xx, six malformed bodies, a body-read failure, a sync-throwing fetch and a handler throw each delivering nothing and logging one line carrying no reply text, body text or key (withheld-sentinel control in-suite and a patched-module control under .kit/); the secret screen's six branches blocking, the two hyphenated sk- key shapes blocking, and nine near-misses sent (two of them the round 2 prose controls); empty and whitespace-only never sent; the repeat log's window and suppressed count; the single-flight replace, settle and next; a throwing log not stranding the waiting reply; the module reading no environment. Spawning tests: 0. Live call: `node .kit/scratch/operator-inbox/live-judge.ts` at 2026-09-21T20:24:55Z on SCOTT-CLAUDE, exit 0, message "Finished the refactor; all tests pass. No action needed." scored needs_reply=0.04 needs_act=0.05 (the implementer's earlier run reported the same two values). Contention: none on this lane's runs.
Next: 3. Wiring: taps, clears and settings
Commit Model: Branch-and-PR
Delta: taken at 2026-09-21T20:25Z on SCOTT-CLAUDE at c3b3c1b, no contention; the reading `node <plugin-root>/scripts/kit-size.js report --repo D:/personas/dev-discord/repo` prints:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-09-21
Rebuilt after the pre-migration checkout lost section 3 uncommitted. The run is under the agentic-plugin goal tree in this checkout (D:/discord-channels), no kit leash. Tests run from Git Bash only: launched from PowerShell 7 the ACL tests spawn Windows PowerShell with the wrong module path (9 false reds, whole gate hangs), recorded in project memory.
- Section 3 (wiring): first green committed at 86bb551 and pushed. Implemented by implementer-opus. Round 1 ran the code pair, security and performance at fable through the Agent tool. Fix round 1 in flight on the same agent: read the tap instant before deliver (adversarial Major, spec-traceable), one startBroker composition test (adversarial Major, spec-traceable), two boundary comments rewritten on the honesty route (security Major, fix now), and four close-pass Minors. Justified-not-fixed: the blind Major on the prompt-mirror engage stamping handling time, since Approach "Clearing" names the clamped registry stamp on all three prompt paths and Intent accepts a miss; named to the operator at close-out. Files in scope widened by a fold: broker/intake.test.ts (four fixture defaults the new BrokerConfig fields need). Round 2 owed: adversarial lens at opus/high through Workflow over the fix delta.
- Section 4 (card): first green committed at 3fe6012 and pushed, card modules only. Implemented by implementer-sonnet. Round 1 ran the code pair at opus/high through Workflow. Fix round 1 in flight on the same agent: draw the Discord jump link where a message ID is held, with the guild ID from the gateway's channel (adversarial Major, spec-traceable; the implementer's no-guild-ID premise was wrong at runtime), plus nine Minors. Then the broker/index.ts wiring (construct under the knob, join permanentCards, binding beside board-card.json) once section 3's fix lands, since both touch index.ts. Round 2 owed after the wiring.
- Section 5 (documents): not started; its fact base is sections 1 to 4 as built. Carry to it: the snapshot file inbox-items.json as an on-disk holder of reply excerpts, the advisory-switch residual (a token holder can arm the judge for a mirror-off session), and the self-clear residual (a session's subprocess can clear its own ask).
- Gate baselines from Git Bash at 98535d6, clean tree, 2026-09-21T21:45Z on SCOTT-CLAUDE, no contention: whole gate 1910 tests, 1909 pass, 0 fail, 1 skipped, exit 0, 38 s; section 3 lane 413/413 exit 0. At 3fe6012: section 3 lane plus intake.test.ts 508/508 exit 0; section 4 lane 243/243 exit 0; lint exit 0.
- Pushing on this box: git-credential-manager hangs headless; push with the gh token as a one-off credential (`git -c credential.helper= -c 'credential.helper=!f(){ echo username=neo-claude; echo "password=$(gh auth token)"; }; f' push`).
- Next: adjudicate both fix reports, section 4 wiring dispatch, round 2 for each section, Chapters 3 and 4, then section 5.

### Chapter 3 - 2026-09-21
Completed: 3. Wiring: taps, clears and settings
Implemented By: implementer-opus (rebuilt from the plan doc after the pre-migration checkout lost the first build uncommitted)
Metrics: review rounds 2, closed claim-exit; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 1 findings, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 3 open (rebuilt after the migration lost the uncommitted first build): wires the inbox store and judge into broker/index.ts, the outbound router's reply taps, the inbound router's delivered and ended-thread clears, the registry's operator-prompt stamp and mutate-signal reconcile, snapshot load and save, and four settings plus their installer allowlist entries; serves the Goal's "lands in one inbox" and "leaves the inbox when the operator sends that session a prompt", Approach "Where the text is", "The producer signal", "Clearing" and "Persistence", and section 3's acceptance; adds only the seams and settings section 3 names; size est. ~250 lines code plus tests; not building it leaves sections 1 and 2 unreachable from any live reply. Round 1 fix, adversarial Major (outbound.ts tapReply postedAt, spec-traceable to Goal "leaves the inbox when the operator sends that session a prompt"): read the tap instant before deliver so a paced or rate-limited Discord landing cannot post-date a console answer; adds no mechanism; ~6 lines; not building it opens an item the operator already answered, cleared only by their next prompt. Round 1 fix, adversarial Major (index.ts startBroker composition, spec-traceable to section 3 Tests "lock each never-tapped kind and each never-clearing event, since each is a silent bypass"): one startBroker test driving the seams through the real registry; adds no mechanism beyond a read-only items handle on Broker; ~40 lines test; not building it lets the onPrompt line be deleted with every unit test still green. Round 1 fix, security Major (index.ts and outbound.ts boundary comments, honesty route): rewrite two sentences to the hooks-send-none, token-holder-can residual; adds no mechanism; prose only; not building it leaves a false security sentence in the code. Approval drift, three items: broker/intake.test.ts folded into Files in scope (four fixture defaults the new BrokerConfig fields need); Approach "The item" amended from "read from the broker's clock at the tap" to the arrival instant read before the run, matching the round 1 fix; the share-root refusal on the key file, added at round 1's close pass on a security Minor, removed at round 2 because config.ts's own rule says an environment-sourced path accepts a share root by design and the Discord token file this key is held to accepts one too. Surprise: the composition test cannot reach the outbound tap or the inbound clear in-process, since both sit behind a real gateway login; the two router spreads in startBroker remain unpinned, carried to section 5's residuals as a known gap. The startBroker lane count differs between the implementer's runs (511, 508) and the orchestrator's runs on the same seven test files (441, 443) with identical top-level test names; the variance sits in nested subtests and is unexplained, so every count on this Chapter names its run.
Assumptions: none
Review Findings: review: code pair at fable, Agent tool (round 1); review: security at fable, Agent tool (round 1); review: performance at fable, Agent tool (round 1); review: adversarial at opus, Workflow at high (round 2). Round 1 adversarial Majors 2 (tap instant, composition test), both fixed. Round 1 blind Major 1, orchestrator-made trace to Approach "Clearing" (spec-traceable), justified-not-fixed: the prompt-mirror path stamps the registry at handling time, so a console prompt queued mid-turn and handled after the turn's final reply clears an ask the operator never saw; the delta implements the clause as written and Intent accepts a miss, the next reply restating the ask reopens the item, and the edge is named to the operator at close-out. Round 1 security Major 1 (two boundary comments said a mirror-off session's text never leaves the machine), fix now on the honesty route. Round 2: no Critical, no Major, 3 claim Minors. Minors: 7 fixed (round 1: pruned-session early return in reply and onVerdict, warning names the judge key file, non-printable-ASCII key refused, share-root refusal added; round 2: reply docstring restated to the arrival instant, share-root refusal and its rationale removed, its wording pin removed with it), 0 upgraded, 8 left with the reason (a reply-tool run landing some messages then failing is not tapped, the landed prefix being a partial answer; a same-millisecond tie between prompt and refresh does not clear, sub-millisecond on a human channel; an empty-text ended-thread message clears, matching the delivered branch; a broker restart between an answer-echo drop and the next reply misses that reply, the status quo Intent accepts; registry.list() copies per tapped reply, O(500) at cap on a human-rate path; the snapshot write is sync and fires on change only; SECRET_SCREEN runs over the whole text before the cut, section 2's design; npm audit's three advisories already on the backlog). Security Minor carried to section 5: a session's subprocess can clear its own ask, one step past the accepted engagement-stamp residual.
Stamps: adjudicated 4, stamped 0 (four operator-tier records read inside the window by nudges and dispatches, none of which shaped this section's work)
Gate: targeted lane from Git Bash on SCOTT-CLAUDE, no contention (claim file clean at each spawn), files broker/config.test.ts broker/index.test.ts broker/intake.test.ts broker/registry.test.ts broker/routing/inbound.test.ts broker/routing/outbound.test.ts install/Install-Functions.test.ts: at close (dac2b6f plus the close pass) 443 tests, 443 pass, 0 fail, exit 0, 13.2 s; at the fix round 441/441 exit 0, 12.0 s; the same lane less intake.test.ts at the 98535d6 baseline 413/413 exit 0. Lint (tsc) exit 0 at each. Whole gate baseline at 98535d6 from Git Bash: 1910 tests, 1909 pass, 0 fail, 1 skipped, exit 0, 38 s. Tests added: outbound "a prompt typed while a reply's run is landing still clears it" (the tap instant is the arrival, not the landing); index "startBroker's inbox restores beside the registry, clears on an operator prompt and follows a prune" (construction, snapshot placement, onPrompt seam, reconcile seam); index "a reply or a verdict for a session the registry no longer holds opens nothing" (pruned-session drop, with a held-session control); plus the first-green tests the 86bb551 commit carries, one per never-tapped kind and never-clearing event per the section's Tests line, and the four config settings. Tests edited: one outbound title and assertion moved to the arrival instant; config's judge key test extended with four non-printable keys. Tests retired: none (the share-root loop inside the config test was removed with its guard, no test retired). Spawning tests added: 0.
Next: 4. The Fleet: Inbox card (round 2 in flight, then its Chapter), then 5. Documents
Commit Model: Branch-and-PR
Delta: read at ff0f129 plus the close pass, SCOTT-CLAUDE, no contention:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 4 - 2026-09-21
Completed: 4. The Fleet: Inbox card
Implemented By: implementer-sonnet (card modules, round 1 fixes, index.ts wiring, close pass), no escalation
Metrics: review rounds 2, closed claim-exit; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 4 open: builds broker/inbox/card.ts (pure renderer taking a clock), thread.ts and binding.ts cloned from broker/board/, corrects the two "two standing cards" sentences, and joins the card to permanentCards in broker/index.ts; serves the Goal's "a standing pinned card ... Fleet: Inbox, carrying one line per session that holds an open ask, with a link into that session's thread" and Approach "The card"; adds only the card mechanisms section 4 names; size est. ~350 lines code plus tests; not building it leaves every item invisible to the operator. Staggered against section 3: the first dispatch excludes broker/index.ts, which section 3's implementer holds, and the index.ts wiring follows once section 3's delta lands. Round 1 fix, adversarial Major (card.ts message link, spec-traceable to Approach "The card": "a link to the flagged message or to the thread where no message ID is held"): draw a Discord jump link where the item holds a message ID, with the guild ID supplied from the gateway's channel, and the thread chip otherwise; adds no mechanism (the spec names the link); ~15 lines plus the option; not building it lands the operator at the top of a long thread and leaves the store's messageId unused. Wiring (round 1 fix follow-on): joins the card to startBroker under the knob and a configured Discord, adds a guild accessor to the gateway's MessageSource read from the client's channel cache; serves the section's "It joins permanentCards" sentence and the Approach's jump-link line; adds no mechanism beyond the accessor the link needs; about 60 lines in index.ts and 10 in gateway.ts; not building it leaves the card modules unreachable and the inbox invisible. Decisions: the implementer's premise that no guild ID is available was wrong at runtime (the Guilds intent populates the client's channel cache), so the jump link the Approach names is drawn; the guild rides as a card-level option rather than a per-session field, since one channel has one guild; the accessor reads the cache on every call rather than latching at ClientReady, because that event fires once discord.js's guild wait times out even with the guild unavailable, so a latched null would last the process's life; the session title goes through inertField rather than the spec's inertName, since a bold title with live markdown would render, and the overflow tail past the message budget is the implementer's. Approval drift: broker/routing/gateway.ts folded into Files in scope for the guild accessor, which no other surface can supply. Surprise: no test can reach a built card in-process, since construction needs a configured Discord transport behind a real gateway login, so the wiring's pins are the absence cases (no Discord, knob off) and the per-tick seams are pinned at thread.ts.
Assumptions: none
Review Findings: review: code pair at opus, Workflow at high (round 1, over the card modules); review: code pair at opus, Workflow at high (round 2: adversarial over the round 1 fixes and the wiring, blind over the wiring commit alone, the wiring being code round 1 never saw). Round 1 adversarial Major 1 (no jump link), fixed. Round 2: no Critical, no Major. Minors: 15 fixed (round 1: age from openedAt, empty-title fallback, unresolvedTitle neutralized before the cut, merged imports, "for one tick" dropped, binding docstring, heading assertions, fence fixture, duplicate thread test retired; round 2: lazy guild read, knob-off test retired as a duplicate, withheld control paired on the no-Discord log assertion, per-tick guild test added, escape-form pin reshaped to the requirement, thread.ts header names the accessor, retire-narrative comment deleted), 0 upgraded, 1 left with the reason (a jump link composes the session's current thread with a message ID posted in a thread the surface may since have rebuilt after an operator deleted it; the operator still lands in the right thread with an unknown-message notice, and recording the thread on the flag is section 1's surface, carried to section 5's residuals). Blind's first-render re-edit Minor (the first pass draws chips before the guild resolves, then re-edits) is resolved by the lazy read.
Stamps: adjudicated 4, stamped 1 (git-credential-manager-hangs-headless-on-scott-claude, operator tier: every push on this branch goes through the gh-token one-off credential helper because of it)
Gate: targeted lane from Git Bash on SCOTT-CLAUDE, no contention (claim file clean at each spawn), files broker/index.test.ts broker/inbox/card.test.ts broker/inbox/thread.test.ts broker/inbox/binding.test.ts broker/routing/outbound.test.ts broker/routing/inbound.test.ts broker/board/binding.test.ts broker/discord/pins.test.ts broker/discord/render.test.ts: at close (e7f8294 plus the close pass) 497 tests, 497 pass, 0 fail, exit 0, 6.2 s; at the wiring commit 497/497 exit 0, 6.2 s; the card-module lane at the fix round (six files, without index.ts and the routers) 248/248 exit 0; at first green 243/243 exit 0. Lint (tsc) exit 0 at each. Whole gate baseline at 98535d6 from Git Bash: 1910 tests, 1909 pass, 0 fail, 1 skipped, exit 0, 38 s. Tests added: card "link drawn when guild and message are known", "chip fallback when guild is null", "chip fallback for a non-snowflake guild or message" (with a withheld control that the raw strings never appear), "age reads from openedAt", "empty title falls through to the session-ID name", "a newline actually ahead of a heading marker still opens no line with one"; thread "the guild is read fresh on every tick, not latched once at construction" (shown red under a construction-time latch, then green); index "the inbox card knob builds nothing on a broker with no discord configured" (absence with a paired positive control on the inbox-on log line); plus the first-green tests the 3fe6012 commit carries for the renderer's byte stability, edit-on-change, the inert excerpt and the empty line. Tests edited: the chip-only card test narrowed to assert no discord.com link without a message ID; two card heading assertions reshaped from the escape form to the requirement; the hostile excerpt fixture gains a real fence. Tests retired: thread's duplicate unresolved-session test (class: duplicate, cover card.test.ts's own); index "the inbox card stays unbuilt when its own knob is off" (class: duplicate that cannot go red, cover "startBroker builds the inbox only when the card is on"). Spawning tests added: 0.
Next: 5. Documents
Commit Model: Branch-and-PR
Delta: read at e7f8294 plus the close pass, SCOTT-CLAUDE, no contention:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 2 - 2026-09-21
- Sections 3 and 4 closed (Chapters 3 and 4). Section 5 (documents) at first green, commit f0d7a36 on origin/operator-inbox: six drafts by implementer-opus placed by the main thread into docs/architecture.md, security-model.md, operations.md and install.md, plus three stale carriers corrected (the pins sentence, the install egress preamble, the hardened-path list). Drafts and their anchors under .kit/scratch/operator-inbox/5/.
- Live dispatches, section 5 round 1 at fable through the Agent tool: blind-reader as the operator persona, blind-reader as the fresh engineering session, prose-reviewer with the full Document Review Brief. Next: adjudicate, fix round if owed, close pass, Chapter 5, commit, push; then finishing-work (whole gate from Git Bash, finishing reviews, docs/README.md index line, memq decay pass, backlog aging, PR with `gh pr create --repo SApplefeld/discord-channels --base main --head operator-inbox`).
- Gate baseline unchanged: whole gate at 98535d6 from Git Bash 1910 tests, 1909 pass, 0 fail, 1 skipped, exit 0, 38 s. No lane reads docs.
- Residuals carried into section 5's text: subprocess self-clear; snapshot holds excerpts; advisory mirror switch reaches the judge; restart forgets the mirrored set; queued console prompt clears an unseen ask; jump link into a rebuilt thread. Test gap not in the documents: the two router spreads in startBroker are unpinned, since no test reaches the Discord block.

### Chapter 5 - 2026-09-21
Completed: 5. Documents
Implemented By: implementer-opus (six drafts under .kit/scratch/operator-inbox/5/ with Anchor: first lines, placed by the main thread under the docs write guard), no escalation; fix round and close pass inline
Metrics: review rounds 2, closed claim-exit after the author re-read of round 2's fixes; provenance 6 spec-traceable Majors (all accuracy or audience), 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: waived (all-prose changeset); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Section 5 open: writes the operator inbox into docs/architecture.md (a section beside the blocked desk plus a fourth external integration), docs/security-model.md (the judge as a named egress, six accepted residuals, the key file on the hardened-path list), docs/operations.md (the card runbook and four tunable rows) and docs/install.md (the optional key-file step); serves the Goal's "the four documents answer what opens an item, what clears one, what leaves the machine and how to stop it"; adds no mechanism; size est. ~330 lines of prose; not writing it leaves the judge's egress undocumented on the surface that inventories every egress. Drafter's spec-versus-code findings adopted into the drafts: the key check is printable ASCII rather than the spec's "non-empty"; the secret screen runs over the whole reply before the 12,000 cut; the session title goes through inertField; the restart forgets the mirrored set because that set is not persisted; engage returns early for an ended record; CHANNEL_MIRROR=off drops every mirror post and so keeps every session off the judge. Round 1 (three readers): every one met the term "straggler gate" undefined, and it is now defined at first use in architecture.md and pointed at from security-model.md. The engineering reader's Major overturned a section 3 ruling: the operations text said a console prompt queued mid-turn stamps later than the turn's final reply and clears an ask the operator never saw. A real transcript (a queued_command line whose own timestamp is the enqueue instant, nine seconds before the line was written) and broker/tail.ts:828-833 show the stamp is the typing instant, earlier than the reply, so the prompt clears nothing that reply asks. Section 3's blind Major on Approach "Clearing" was recorded justified-not-fixed on a reading of the transcript's write order rather than its timestamps; that ruling was wrong on the fact, the code was right all along, and the documents now say so. Approval drift: none this section beyond that correction of the record. Surprise: neither the relay's instructions nor any kit skill teaches a session to write ASK: (grepped at round 1 and again at round 2), and the one teacher is the persona plugin's steward ask, so the documents now state that for an interactive session the judge is what catches an unmarked ask today.
Assumptions: none
Review Findings: review: document pair at fable, Agent tool (round 1: blind-reader as the operator persona, blind-reader as a fresh engineering session, prose-reviewer with the Document Review Brief); review: prose-reviewer at fable, Agent tool (round 2, over the fix diff with the eight new claims named). Round 1 Majors, all fixed: straggler gate undefined (all three); queued-prompt edge false (engineer, confirmed on a transcript); judge input is the pre-render text (operator); the arming mirror post is itself judged, so the restart window is reply-tool answers alone (operator); nothing teaches the ASK: mark (operator); both clear sources advance the store's latest prompt instant (engineer); the judge failure list restated four times, reduced to a pointer in the inbox section (prose). Minors fixed 8: "post anything" tightened to a plain message with the verdict and held-answer shapes named (prose, both sites); 200 characters to code points (prose); the key-file refusal list given one owner in install.md with pointers elsewhere (prose); the snapshot loses a cleared item at the clear's own write (prose); the judge-off step names the elevated Repair-Broker.ps1 restart and that deleting the file alone changes nothing (operator, engineer); the fence rule names tildes (both blind readers); the item's marked source value and the undrawn count named (engineer). Minors left with the reason 6: environment expansion of broker.env values (installer surface, not this plan's); the stale-session chip into a deleted thread (the rebuilt-thread residual already covers it); the steward pattern's exact regex (it is copied from the persona plugin, and the documents name that owner); TypeSafe's response field names and where a key comes from (vendor surface); the two metadata keys outside the tunables table (pre-existing text); the packed-sentence register (house style of both documents, weighed and kept). Round 2 (prose-reviewer over the fix diff, CHANGES_REQUIRED): three Majors, all fixed and each verified against the code before the edit: the off header is read by the intake's /mirror handler ahead of the straggler gate rather than by the gate (broker/intake.ts:733-746), so security-model.md now says so; "nothing teaches the mark" narrowed to name the persona plugin as the one teacher, with the relay and the kit skills as the checked absences; the refusal-list parenthetical dropped from architecture.md's integration bullet so install.md is the one owner. Round 2 Minors fixed 5: the fence rule points at FENCE_OPEN rather than restating a superset of it; the refresh instant names the echo-drop tap's handling-time clock (outbound.ts:1192) as the exception; the engineer-register sentence about hook stamping dropped from the operator runbook; the mangled possessive and "rests undrawn" replaced with plain sentences; three overlong lines rewrapped. Left 0. Claim-exit taken rather than a third round because every round 2 fix is a pointer, an attribution or a rewrap, each read against its cited line before the edit, and the close pass (em-dash sweep 0 with a speaking control, wrap-width sweep clean) ran over the round 2 diff at .kit/scratch/operator-inbox/5/fix-round-2.diff.
Stamps: adjudicated 4, stamped 0
Gate: no lane reads these documents; the em-dash sweep over the fix diff's added lines found 0 (grep over .kit/scratch/operator-inbox/5/fix-round-1.diff, with the control that the pattern finds the character in a scratch line). Whole gate baseline unchanged at 98535d6 from Git Bash: 1910 tests, 1909 pass, 0 fail, 1 skipped, exit 0, 38 s. Tests added 0, edited 0, retired 0. Spawning tests added: 0.
Next: finishing-work (whole gate, finishing reviews, docs/README.md index line, decay pass, backlog aging, PR)
Commit Model: Branch-and-PR
Delta: read at f0d7a36 plus the fix round, SCOTT-CLAUDE, no contention:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 3 - 2026-09-21
- Finishing pass, base ref 32939cdeff55a3252396133a678debff17adf13c (merge-base with main). Changeset listing checked against the Files in scope union: outside it only the plan doc, docs/backlog.md (the section 1 audit entry) and the four documents section 5 names, so the base is right.
- Step 1 QA: PASS. `npm run lint` exit 0; `npm test` from Git Bash exit 0, 1988 tests, 1987 pass, 0 fail, 1 skipped, 35.0 s, against the 98535d6 baseline 1910/1909/0/1. No contention lane defined. The verifier's "operator-only" label on the unpinned router spreads is wrong: that is a disclosed test gap, not an operator check.
- Steps 2 and 3, one Workflow round at fable/high, bracket clean: security CLEAR (threat model: absent, already carried at backlog line 560, so it goes to Operator Verification in the final Chapter), performance CLEAR, adversarial APPROVED_WITH_CONCERNS (Minors only), prose one Major and Minors.
- Advisory dispositions (all Minor): fixed in the Minors pass: security-model title-consumer count six to seven; key-file placement stated as install instruction with the check as the guarantee; the key check refuses spaces too; backlog audit entry names fast-uri; the answered-narration timing edge named under Edges worth knowing; JudgeWinner declared once; a non-2xx judge response body cancelled; index.ts:670 "two cards" comment. Deferred with reason: the per-tick registry copy in the card's session lookup and recordOf (bounded at single-digit ms at the 500-session cap, human-rate or tick-rate); reconcile per hook post (beside a larger pre-existing per-hook save); judge latency unmeasured (recorded in the close-out as not measured; a timeout already logs its kind). Refused: none.
- Owed Major (prose, spec-traceable to section 5's "the accepted residuals"): the -NoMirror "never sent to the judge" absolutes in operations.md and architecture.md contradict security-model.md's advisory-switch residual. Add-decision: scope the sentence to the session's own hooks and point at the residual; adds no mechanism; two sentences; not fixing it ships a contradiction on the egress question the section must answer. Route: fix round 1, prose lens alone over the fix delta.
- Adversarial Minors for the Minors pass: spec section 4's inertName amended to inertField as approval drift; the mirror-arming log line and reconcile docstring say "mirror signal" rather than "mirror verdict"; open question 1 closed at close-out; README row at close-out. Left: boundedFraction key naming (parity with the pre-existing bounded convention); snapshot load on the info tier (parity with the board binding).
- Next: step 4 goal read, then the fix round and Minors pass, then docs-curator, then close.

### Chapter 6 - 2026-09-21
Completed: finishing pass
Implemented By: main thread (finishing fixes and close), with qa-verifier, security-reviewer, performance-reviewer, adversarial-reviewer and a prose lens at fable/high through Workflow, scope-adjudicator at fable through the Agent tool, and docs-curator
Metrics: review rounds 2 (the finishing wave, then the prose lens over fix round 1), closed claim-exit after the author re-read of fix round 2; provenance 1 spec-traceable Major (prose, the -NoMirror absolutes), 0 fix-introduced, 0 new-requirement; goal read RULED, 5 accept-and-declare, 0 asked-but-unbuilt; advisory: security CLEAR, performance CLEAR, Minors only; drift 12 items, 1 mistake resolved, 11 deviations; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "A reply from a session that needs something from the operator lands in one inbox the operator reads first. The inbox is a standing pinned card in the host's Discord channel, `Fleet: Inbox`, carrying one line per session that holds an open ask, with a link into that session's thread. An ask is recognized two ways: the session marks it with an `ASK:` line in its reply, or, where the reply carries no mark, an external judge (TypeSafe's Jev) scores the reply and a score at or above a threshold opens the item. An item leaves the inbox when the operator sends that session a prompt, from Discord or from the console, and never because the operator merely read it. It matters because sessions drop decisions, questions and operator-only acts into long status reports without a `BLOCKED:`, and the operator, scrolling forward from Discord's last-read marker, misses some."; What the tree does now: with `CHANNEL_INBOX_CARD` on, the broker keeps a pinned Discord card named Fleet: Inbox listing each session that is waiting on the operator, with how long it has waited, a short excerpt of the ask and a link that jumps to the message that asked. A session opens a line by writing a line that starts with `ASK:` in its reply, or, where a key file for TypeSafe's Jev classifier is configured, by writing a reply that classifier scores as needing a reply or an action. The line goes away when the operator next types to that session, from Discord or from the console, and never because the operator read it. Everything is off by default, the classifier is the broker's one call to a host other than Discord, and a reply is screened for secrets and cut to 12,000 characters before it is sent; Refinements during the run: the operator's PR 15 ruling added the persona plugin's steward-shaped ask, which keeps a supervised session's reply out of the inbox and off the judge since its steward answers it (section 1); section 2's secret-screen wording changed from alphanumerics to token characters to match its review fix; section 3 was rebuilt after the migration lost its uncommitted first build, on the operator's "Go"; Approach "The item" amended from the broker's clock at the tap to the arrival instant read before the run; broker/intake.test.ts folded into section 3's files; the key file's share-root refusal added and then removed in section 3; section 4 amended from inertName to inertField for the title; broker/routing/gateway.ts folded into section 4's files for the guild accessor the jump link needs; section 3's justified-not-fixed ruling on the queued console prompt reversed in section 5, since the prompt stamps the instant it was typed and clears nothing the later reply asks; the -NoMirror "never judged" sentences scoped to the session's own hooks at finishing; Operator-pending: find the card on the phone; turn the card and judge on for SCOTT-CLAUDE and watch one real day; reply to a flagged session from the phone and confirm its line leaves; decide whether the threat model section is written as its own effort
Decisions / Surprises: Finishing base ref 32939cd (merge-base with main); changeset listing matched the Files in scope union plus the plan doc, docs/backlog.md and the four documents. Goal read declares, accepted and named here: the key-file check at startup; the read-only `Broker.inbox` seam the composition test reaches; the jump link with the gateway's guild accessor; the board binding comment reword; the judge's repeat log and the card's overflow tail. Drift adjudication: D8 (mistake) is the `CHANNEL_INBOX_CARD` row and the startBroker comment saying an inbox that is off keeps reply text on the machine, when the mirror still posts replies to Discord. Pre-change read: broker/index.ts and docs/operations.md both present at 32939cd with neither claim there (this effort wrote both), so nothing refutes it; the code leg holds, since spec line 161 defines off as no thread, no timer and no judge call and the mirror is its own knob. The defect is text, not behavior: the row, the comment at broker/index.ts:723 and its sibling at broker/config.ts:158 now say no reply text goes to TypeSafe. It was resolved rather than raised because no behavior is in question and the fix rides the PR the operator reviews; named in the close-out and the PR. Deviations, recorded for the PR: D1 and D2 docs/README.md intro and security-model row, fixed at the index refresh; D3 the two plan-index lines, fixed at the archive; D4 displayName's fourth consumer; D5 the inbox card as a second unfenced card; D6 the judge as the one content egress to a third party; D7 the inbox excerpt held to the name's escape; D9 eight createRepeatLog copies; D10 the binding extraction now due; D11 architecture.md's end-result list omits all three standing cards, left as a pre-existing omission; D12 the key check refuses more than the spec's "missing or empty", by design since the key rides an HTTP header. Hygiene: H2, an archived plan row sitting in docs/README.md's Reference table, is pre-existing and left. The curator's security-model sentence was rewrapped to the 100-column width with its parenthetical made a sentence.
Assumptions: assumed 2026-09-21 (default, section 1): CommonMark fence rules, a backtick opener refusing an info string with a backtick; reversal: one regex. assumed 2026-09-21 (default, section 1): a mark with nothing after it still marks with an empty excerpt; reversal: one condition. assumed 2026-09-21 (default, section 1): one malformed item refuses the whole snapshot; reversal: drop the item instead. assumed 2026-09-21 (default, section 1): a judged flag on a marked item updates the scores and winner; reversal: one branch. assumed 2026-09-21 (default, section 1): a marked flag with an excerpt the loader would refuse is dropped rather than cut; reversal: cut instead. assumed 2026-09-21 (default, section 1): operator-prompt instants are not persisted; reversal: add them to the snapshot. assumed 2026-09-21 (default, section 2): flags only are delivered, never null; reversal: one call. assumed 2026-09-21 (default, section 2): a screened or empty reply does not displace a waiting reply; reversal: three lines. assumed 2026-09-21 (default, section 2): the repeat log is a local copy of the question desk's shape, keyed by failure kind, since neither sibling limiter is exported; reversal: export one and import it. assumed 2026-09-21 (default, section 2): the GitHub and bearer branches take token characters `[a-z0-9_-]`, and `api[_-]key` names exactly the spec's two spellings; reversal: one character class each. assumed 2026-09-21 (default, section 2): the threshold is not re-validated in the module, since its one producer is section 3's bounded setting; reversal: a finite check at construction.
Review Findings: QA PASS (lint exit 0; npm test from Git Bash 1988 tests, 1987 pass, 0 fail, 1 skipped, exit 0, 35.0 s). Security CLEAR with `threat model: absent`, carried to Operator Verification and already in docs/backlog.md. Performance CLEAR. Adversarial APPROVED_WITH_CONCERNS, Minors only. Prose one Major, fixed (above). Fixed Minors: the title-consumer count, the key-file placement, the key check's space refusal, the fast-uri naming, the answered-narration edge, JudgeWinner declared once, the "two cards" comment. Deferred with reason: the per-tick registry copy in the card's session lookup and recordOf (bounded at single-digit milliseconds at the 500-session cap); reconcile per hook post (beside a larger existing per-hook save); a non-2xx judge response body cancel (the JudgeFetch seam type carries no body, so it waits on widening that type); judge latency, not measured. Refused: "mirror verdict" renamed, since it is the codebase's existing term (broker/intake.ts:797, broker/tail.ts:1903). Left for parity: boundedFraction's key naming and the snapshot load's log tier.
Stamps: adjudicated 0, stamped 0
Gate: whole gate from Git Bash on SCOTT-CLAUDE at 2026-09-22T03:29Z over the archived tree (fb22de9 plus the curator's edits, the D8 comment fixes, this Chapter, the archive move, the backlog item and the index refresh), under this session's own claim with no foreign test runner or build in the process list: `npm run lint` exit 0; `npm test` 1988 tests, 1987 pass, 0 fail, 1 skipped, exit 0, 42.1 s, read from the run's own exit markers. Against the whole-gate baseline at 98535d6 (1910 tests, 1909 pass, 0 fail, 1 skipped): 78 tests added across the effort, still 0 failing; the one skip is the POSIX-only "a POSIX token file is refused unless it is owner-only", and the baseline's skip was not named, so its identity is inferred. origin/main equals the merge-base 32939cd, so no update merge was taken. No contention lane is defined in this repository. Tests added 0, edited 0, retired 0 at this pass. Spawning tests added: 0.
Next: none; the plan is archived and the pull request carries it
Commit Model: Branch-and-PR
