# Operator Inbox

Status: In Progress
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
carries the instant its reply was posted, read from the broker's clock at the tap, and that instant
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
`broker/index.ts`, `broker/config.ts`, `install/Install-Functions.ps1`, and their tests.
Tests: lock each never-tapped kind and each never-clearing event, since each is a silent bypass.

### 4. The `Fleet: Inbox` card
Model: sonnet
`broker/inbox/card.ts`, `thread.ts` and `binding.ts`, cloned from `broker/board/card.ts`,
`thread.ts` and `binding.ts` with the inbox's renderer. It joins `permanentCards`. The glyphs, the empty-inbox line and the age format are the
implementer's to choose on the board card's conventions, and the renderer takes its clock as an
argument so a fixed clock yields fixed bytes. The session title goes through `inertName` and the
excerpt through `inertField`, both in `broker/discord/render.ts`. Acceptance:
the rendered card for a fixed item set is byte-stable; an unchanged render issues no edit; an
excerpt carrying a mention, a masked link, a heading marker and a backtick fence draws inert; an
empty inbox draws the fixed line; the pin keeper's sweep recognizes the card as the broker's own.
Files in scope: `broker/inbox/card.ts`, `broker/inbox/thread.ts`, `broker/inbox/binding.ts`,
`broker/index.ts`, `broker/discord/pins.ts` only if its known-card set needs the new ID, and tests.
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

## Open Questions

- Whether the mirror writer returns a Discord message ID the item can link to. Owner: the section 3
  implementer, who reads `outbound.ts`; the thread link is the stated fallback.
- The scheduling slot and the executing worker. Owner: the Architect.

## Related plans

- `archive/plans/channels_blocked-state_spec_v1.md`: the blocked desk, the nearest sibling surface.
- `archive/plans/channels_board-card_spec_v1.md`: the card pattern section 4 clones.

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
