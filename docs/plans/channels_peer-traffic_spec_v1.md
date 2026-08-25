# Channels: peer traffic on the mirror

Status: In Progress
Commit Model: Commit-and-Push
Created: 2026-08-25

Claude Code sessions now message each other directly (`SendMessage`/`ListAgents`, the cross-session
messaging surface). The broker's mirror predates that surface and mishandles it in two directions,
observed live on 2026-08-25 during a four-session coordination experiment:

1. **Inbound is misattributed or invisible.** A peer message delivered to an idle session renders in
   that session's thread under `>>> ⌨ typed at the console`, the operator's own quoted register,
   carrying the raw `<cross-session-message ...>` wrapper text (operator's verbatim Discord paste,
   2026-08-25). A peer message delivered mid-turn reaches the transcript as a `queued_command`
   attachment whose `origin.kind` is `"peer"`, which `lineItems` drops at its `"human"` gate, so it
   never reaches the thread at all. The quoted operator block is the one attribution this surface
   holds unforgeable, and today the harness itself forges it on the broker's behalf.
2. **Outbound is invisible.** A `SendMessage` call is an ordinary assistant `tool_use` block, which
   `lineItems` skips (only `AskUserQuestion` is read), so the thread shows a session mid-negotiation
   as if it were silent, with only the status card's tool preview hinting otherwise.
3. **The engagement stamp is wrong.** `mirror` and `interimPrompt` stamp `lastEngagementAt` for any
   prompt that is not a task notification (`broker/routing/outbound.ts:826`, `:1105`). A peer
   message riding the prompt path is machine-generated, so today it can clear a standing blocked
   state (`⛔`) that exists to wait on a person. The task-notification exclusion's reasoning applies
   verbatim: the woken turn's first completed tool call stamps if the run genuinely resumes.

The goal: peer traffic renders in each session's thread under its own honest attribution, both
directions, so one thread shows the whole of every exchange its session participated in, and the
operator watches a cross-session conversation without tabbing between terminals.

## Related

- Backlog item "Make a cross-session exchange watchable from one Discord surface (parked
  2026-08-25)", which this plan delivers. Close it out with this plan.
- [`../archive/plans/channels_blocked-state_spec_v1.md`](../archive/plans/channels_blocked-state_spec_v1.md):
  built the engagement allowlist and the task-notification exclusion this plan extends to peer
  prompts; its ordering argument (the woken turn's first tool call stamps) is the reasoning to
  preserve.
- [`../archive/plans/channels_mirror-fidelity-repairs_spec_v1.md`](../archive/plans/channels_mirror-fidelity-repairs_spec_v1.md):
  the queued-prompt tailer path and the unforgeable-attribution machinery peer rendering must join,
  not weaken.

## Ground truth: the harness's shapes

All confirmed 2026-08-25 by reading live transcripts (this repo's session
`f48916fc-0016-4883-8e13-3b93827a95ab.jsonl`, the kit repo's
`84e80f45-83ca-4f60-af3b-b26678ef45d0.jsonl`, both under
`C:\Users\LocalAdmin\.claude\projects\`), except where marked inferred. These are the harness's
contract, not this project's: every shape below can move upstream without notice, and each match
must state its failure direction the way `TASK_NOTIFICATION` does in `broker/routing/outbound.ts`.

- **Arrival, both receiver states:** a `{"type":"queue-operation","operation":"enqueue"|"remove",
  "content":"<cross-session-message ...>..."}` pair. Arrival is not consumption; these lines are
  ignored.
- **Delivery, receiver mid-turn:** an `attachment` line, `attachment.type: "queued_command"`,
  `commandMode: "prompt"`, `origin: {kind: "peer", from: "uds:\\\\.\\pipe\\LOCAL\\cc-msg-<32hex>",
  msg_id: "<guid>", name: "<display name>", hopChain: [...], fromMode: "bypass"|..., body:
  "<clean text, no wrapper>"}`, and `prompt` carrying the wrapper-wrapped text. The structured
  `origin` is the read of choice: `body` needs no wrapper parsing, `name` needs no attribute
  parsing.
- **Delivery, receiver idle:** a user line carrying the
  `<cross-session-message from="..." from-name="..." from-mode="...">...</cross-session-message>`
  wrapper in `message.content` as a plain string (attributes observed: `from` = the pipe address,
  the only stable sender key; `from-name` = peer-chosen display name; `from-mode` = sender's
  permission mode; sometimes `hop-chain`). A prose preamble (`Another Claude session sent a
  message...`) and a trailing harness advisory paragraph ride with it. It is not an ordinary user
  turn: it carries `isMeta: true`, `promptSource: "system"`, a `promptId`, and the same structured
  root-level `origin: {kind: "peer", from, msg_id, name, fromMode, body}` the mid-turn attachment
  carries under `attachment.origin`. The structured origin sits at the line's root here, not under
  an attachment. Two consequences: the wrapper text parsing is needed only where the structured
  origin is unavailable, which is the mirror path (the `UserPromptSubmit` hook payload delivers
  `prompt` text alone, `broker/intake.ts:74`); and the tailer, which does see the whole line,
  deliberately does not read this shape, because the mirror path already posts it and a second
  reading would double-post. Inferred, to confirm in section 4: this delivery fires
  `UserPromptSubmit`, which is how it reaches the mirror today, and the mid-turn delivery fires no
  prompt hook (the queued-injection rule), so no single delivery reaches both the mirror path and
  the tailer path. If the probe in section 4 falsifies that and one delivery can post twice, dedup
  by digest through the echo-memory pattern is the named fallback.
- **Outbound:** an assistant `tool_use` block, `name: "SendMessage"`, `input: {to, summary?,
  message, ...}`. The input carries duplicate aliases beside those three, observed as
  `type: "message"`, `recipient` (duplicating `to`), and `content` (duplicating `message`); the
  reading takes `to`, `summary`, and `message` and ignores the rest, so an alias moving upstream
  costs nothing. The `tool_result` carries `{"success":true,"message":"\u201c<summary>\u201d
  → <resolved name> (...)","msg_id":"<guid>"}`. The input is what renders; the result is not read
  (a success does not distinguish queued from delivered, so it adds nothing renderable).
- **No correlation id exists** anywhere: outbound `msg_id`s never appear in inbound wrappers.
  Correlation is counterparty plus timing, which is why the design renders both directions
  chronologically in the session's own thread and builds no per-exchange surface (parked below).
- **Unobserved kinds stay silent:** `[Cross-session idle notice]`, subscription-expiry notices,
  held-for-approval artifacts. Allowlist discipline: nothing renders as peer traffic unless it
  matches a pinned shape above; everything else keeps today's behavior.

## Design

Two new renderings join the mirror's vocabulary, one glyph for the class so a reader scanning a
thread finds every peer exchange by it:

- Inbound: `📡 <name> → Claude` opening line, body below, unquoted.
- Outbound: `📡 Claude → <name>` opening line, the `message` text below, unquoted.

Unquoted is load-bearing: **the `>>>` quoted block remains the operator's register alone**, which
is the existing unforgeability invariant, and this plan's first effect is to stop the harness's
wrapper text from being drawn inside it. The counterparty name is peer-chosen text, so the
attribution line takes the same full-markdown neutralization a card title takes, bounded, and the
body takes the standard mirror escape (chips and quote markers escaped), so peer content can forge
neither the operator's block nor a broker notice. Exact attribution strings are constants in
`broker/discord/render.ts` beside the existing ones; glyph and wording are the tunable knobs.

`from-mode`, `hop-chain`, `msg_id`, and the pipe address render nowhere: none is actionable from a
thread, and the pipe address is infrastructure the operator never types. The display name is the
join key an operator actually uses (it matches the counterparty's own thread title in the same
channel when the counterparty is local).

A config knob `CHANNEL_PEER_MESSAGES` = `full` (default) | `brief` | `off`, parsed on the
`CHANNEL_TASK_NOTIFICATION` pattern (strict enum, trimmed, case-folded, loud on a typo). `full`
renders a body through the ordinary split-and-pace path, capped where a mirrored prompt is
capped and carrying the same visible cut marker: a peer body is remote-authored input, so it
takes the prompt's bound rather than a reply's freedom. `brief` renders one line per
message: the attribution line plus the outbound `summary` (bounded) or the inbound body's first
line (bounded). `off` drops peer traffic from the thread entirely. Whatever the mode, the
engagement-stamp exclusion and the end of the operator-register misattribution apply: the knob
governs volume, never attribution.

Parked, deliberately: a dedicated per-exchange surface (one thread per conversation). With both
directions rendered, one session's thread already carries every exchange that session is party to,
chronologically; no correlation id exists to key a cross-thread view; and the counterparty's thread
tells the same story from the other side. Revisit only if watching one exchange across many
sessions' threads proves insufficient in practice.

## Sections of work

Gates for every section: `npm run lint`, `npm test`, baseline captured before the first change.

### 1. The peer reading (tail)

Model: opus

In `broker/tail.ts`: `lineItems` yields two new item kinds. A `queued_command` attachment whose
`origin.kind` is `"peer"` yields `{kind: "peer-in", name, body}` read from the structured origin
(allowlist parsing on `askedQuestions`' rule: malformed contributes silence, never a guess or a
throw; absent or invisible-empty `name` renders as a fixed fallback such as `another session`
rather than dropping the message). The `"human"` gate on the prompt kind stays exactly as it is. An
assistant `tool_use` block naming `SendMessage` yields `{kind: "peer-out", to, summary, message}`
under the same parsing discipline (a block whose `message` is unreadable yields nothing). A shared,
exported reading for the idle-delivery wrapper also lives here or beside the existing prefix checks
in `broker/routing/outbound.ts`: given prompt text, decide whether it is a cross-session delivery
(invisible-stripped, trim-started prefix match on `<cross-session-message` and on the observed
prose preamble literal), and if so extract `from-name` and the inner body (first tag wins,
non-greedy, attributes read bounded, preamble and trailing advisory dropped), on `COMMAND_NAME`'s
parsing discipline. One reading for both paths a prompt reaches a thread by, so the two cannot
answer differently. State the failure directions at the constants: a harness shape move returns the
idle path to today's misattributed-but-visible behavior and the mid-turn path to silence, both
observable, neither an action.

Tests in `broker/tail.test.ts`: red first against the real shapes above (fixture from the live
transcript, not hand-invented), both new kinds, the malformed variants, and a pin that the human
gate still admits the operator's queued prompt and still drops every other origin kind.

### 2. The rendering (render)

Model: opus

In `broker/discord/render.ts`: the two attribution constants, the counterparty-name neutralization
(full markdown, bounded, the card-title machinery), rendering through the existing split path so a
long body arrives whole and paced, and the `brief` one-line forms. Tests: attribution rides every
message of a split body; a peer body cannot draw the operator's quoted block or the broker's other
attributions (extend the existing forgery tests to the new kinds); a hostile name neutralizes; the
brief forms bound their text.

### 3. The routing, the stamp, and the knob (outbound, config)

Model: opus

In `broker/routing/outbound.ts`: at the two prompt seams (`mirror`, `interimPrompt`), classify with
the shared reading from section 1 before rendering. A peer-classified prompt renders as `peer-in`
under the knob's mode instead of the operator register, and never stamps `engage` (extend the
`isTaskNotification` exclusions at `outbound.ts:826` and `:1105`). The tailer's new items route to
the thread through the ordered per-thread chain the queued prompt uses, ending any narration block,
posting on the mirror budget, never the alert tier, and never pinging. In `broker/config.ts`: the
`CHANNEL_PEER_MESSAGES` enum, and in `install/Install-Functions.ps1` the
`$script:ChannelBrokerEnvAllowlist` entry for it, without which the knob never reaches the broker
process at all. Tests: engagement spy proves a peer prompt stamps nothing while an
operator prompt still stamps; mode matrix; ordering among narration and prompts.

### 4. Live verification and docs

Model: fable

Drive a real exchange: this plan's authoring session (`CHANNEL: Fable`) answers messages on
request, so the implementing session can produce live traffic in both directions and in both
receiver states (send to it while it is busy and while it is idle). Confirm on the real Discord
thread: inbound under `📡`, never under the operator's quote; outbound visible; a blocked session
receiving a peer message keeps its `⛔` (synthetic event acceptable for this leg); the idle/mid-turn
single-post inference above (the dedup probe; if falsified, apply the named fallback before
closing). Update `docs/architecture.md` (the mirror's line shapes and the new vocabulary) and
`docs/security-model.md` (peer content is untrusted text rendered under a non-operator register;
what the classification failing open costs). Close the backlog item with receipts.

### 5. Finishing

Model: fable

The finishing-work pass: qa-verifier against this spec, adversarial and blind reviewers over the
changeset, security-reviewer (this plan is input handling on an external boundary end to end),
docs curation, archive the plan.

## Chapters

(Section 1 complete.)

### Chapter 1 - 2026-08-25
Completed: 1. The peer reading (tail)
Implemented By: implementer-opus (one build, one review-fix round; no escalation)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The spec's ground truth was wrong in two places and both were corrected in
  the doc before dispatch. The idle delivery is not an ordinary user turn: it carries `isMeta:
  true`, `promptSource: "system"`, a `promptId`, and the same structured `origin` the mid-turn
  attachment carries, at the line's root rather than under an attachment. That is why the wrapper
  text reading is needed only on the mirror path, which receives `prompt` text alone
  (`broker/intake.ts:74`), and why the tailer deliberately does not read the idle shape (the mirror
  posts it; a second reading double-posts). The `SendMessage` input also carries duplicate aliases
  (`type`, `recipient`, `content`) beside `to`/`summary`/`message`. The shared wrapper reading was
  homed in `broker/tail.ts` and exported for section 3; the resulting `outbound` to `tail` runtime
  import is acyclic, since both modules import each other type-only today. Two implementer
  refinements were accepted: classified text carrying no wrapper tag at all still reads as no
  delivery (only an operator can reach that branch, and a placeholder there would delete their
  words), and an unreadable delivery keeps a readable name rather than always falling back.
  `PEER_BODY_UNREADABLE` is broker-authored text a peer can write verbatim as its own body; no
  anti-forgery machinery was built, since both readings then say the same true thing and the string
  renders under the peer attribution either way. Noted at the constant for section 2 to revisit.
Assumptions: The shared wrapper reading lives in `broker/tail.ts` rather than beside the prefix
  checks in `broker/routing/outbound.ts`; the spec authorized either, and tail.ts is where this
  module's other exported shape readers already live (route (b), low-blast, reversible, section 1).
  Inferred and still unconfirmed: that no single delivery reaches both the mirror path and the
  tailer path. Section 4 probes it; the spec's "confirm in section 1" was moved to section 4,
  because the tailer cannot observe what the hook receives.
Review Findings: Two Criticals, both fixed, both re-verified by me against the real module before
  and after. C1: peer-authored body text could set the operator's goal card, because the
  `type === "user"` branch read it through `goalCommand` whose command regexes are unanchored,
  while the new comment claimed the line was not read there. Gated by `typedAtTheConsole`, which
  refuses `promptSource: "system"` and any present-but-non-`human` origin; the two operator shapes
  measured on this repo's live transcript both stay admitted. C2: `crossSessionDelivery` conflated
  "not a delivery" with "a delivery I could not read", so a peer opening its body with a fake close
  tag routed its own text into the operator's quoted register. Now a three-state result. Majors
  fixed: the unanchored `from-name` read let a peer plant a tag in its own body and choose its
  attribution; `[^>]*>` let a `>` in a display name spill harness attributes into the body (both
  closed by one sticky, anchored match reading the attribute region and body together); a `to` that
  is a pipe address now falls back; the two paths now agree on trimming and share one code-point
  name bound. Security Minor closed as a side effect: the searching pattern was superlinear
  (3,382ms on 471KB of crafted text against a 256KB route ceiling), now 26.6ms, and 40.9ms at 1MB.
  One Major accepted with justification: a `SendMessage` whose `tool_result` is an error still
  renders as sent, because `lineItems` is per-line and cannot see a result that lands on a later
  line; building correlation machinery was judged out of proportion, and the constant now says
  plainly that a failed send renders as sent. Minors fixed: an invented `queue-operation` fixture
  replaced with the real root-level arrival record, `usage` added to the SendMessage fixture so
  assertions run against the real two-item yield, a `never`-typed exhaustiveness guard so section 3
  cannot silently forget a kind, and read-time bounds on the peer fields. One Minor deliberately
  not fixed: the em dash inside `PEER_ADVISORY` stays, because that string is a verbatim quote of
  the harness's own advisory text and fidelity beats the house rule for external literals. One
  blind finding adjudicated as not-a-defect: the new readers reach no production consumer, which is
  the section split working as designed; section 3 wires them.
Stamps: adjudicated 2, stamped 2 (`grep-directory-sweeps-miss-transcript-jsonl`,
  `editing-a-crlf-file-with-perl-from-the-bash-tool`). `memq unstamped --since 4h` reported zero in
  both tiers; both were applied this section and stamped on the generous bar regardless.
Gates: baseline at 0e24f76 was lint exit 0, test exit 0, 1417 tests / 1416 pass / 0 fail / 1
  skipped. Now lint exit 0, test exit 0, 1436 tests / 1435 pass / 0 fail / 1 skipped: +19 tests, no
  regression. One full-suite run went red on "a mirror run that landed nothing after the tailer
  deferred still gets the text posted" inside the `until` helper. Discriminated rather than assumed:
  three isolated runs of the file were green at 130/130, the full suite was green on re-run, the
  test sits in the pre-existing echo-dedup group far from this diff, and `docs/backlog.md:214` and
  `:37` document this exact helper and group as a known load-sensitive flake. The helper bounds its
  wait by 1,000 microtask turns rather than by time, which is why it fails under load.
Next: 2. The rendering (render)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-25
Completed: 2. The rendering (render)
Implemented By: implementer-opus (one build, one review-fix round; no escalation)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The rendering is four exported functions (`renderPeerIn`, `renderPeerOut`,
  `renderPeerInBrief`, `renderPeerOutBrief`) rather than two new `MirrorKind` members, because a
  peer attribution embeds a name and `ATTRIBUTION` is a keyed record of fixed literals. The
  attribution is therefore composed by `peerAttribution` from component constants (`PEER_GLYPH`,
  `PEER_SELF`, `PEER_TOWARD`) rather than existing as two greppable literal strings; the spec's
  intent, that glyph and wording are the tunable knobs, is honored, and the literal reading of
  "the two attribution constants" is not. The self side renders bold, `📡 <name> → **Claude**`,
  which is a deviation from the spec's plain wording and is load-bearing: every counterparty here
  is itself a Claude session, so a peer whose display name is `Claude` produced an identical header
  in both directions until the self side became a token a name cannot supply (a name goes through
  the full markdown escape, so `**Claude**` arrives escaped). Section 3 wires all four; nothing
  calls them yet.
Assumptions: The brief forms return `string[]` rather than `string | null`, so section 3's mode
  dispatch has one return type across `full` and `brief` (route (b), low-blast, reversible,
  section 2). An outbound brief whose summary is absent or carries nothing visible falls back to
  the message's own opening line, because an attribution line with nothing under it reads as an
  empty send; the spec named the summary and no fallback (route (b), section 2). Render declares
  its own display bound rather than importing the reader's: `broker/tail.ts` imports
  `broker/discord/render.ts` at its line 32, so the reverse edge would be a cycle (route (a), the
  code's own structure, section 2).
Review Findings: Three Majors, all fixed, all re-verified by me with a live probe against the real
  module before and after. M1: a peer body could draw this renderer's own attribution lines
  verbatim (the peer line in either direction, the reply and answer markers, the blocked alert's
  opener), because `mirrorBody` escapes only the chip brackets and a line-leading quote marker. The
  implementer had copied the reply marker's accepted-residual rationale, which does not transfer:
  there the forger and the claimed author are the same party, and here a peer forging an outbound
  line says this session sent something it did not send, in the one channel permission prompts are
  answered in. Closed by `withoutAttributions`, which escapes an attribution glyph where it opens a
  line, on the same reasoning as the line-leading quote pass, over peer bodies and brief lines only.
  The opener set is derived from the renderer's own attributions (`ATTRIBUTION`,
  `ANSWER_ATTRIBUTION`, `PEER_GLYPH`, and the new `BLOCKED_ATTRIBUTION`) rather than hand-listed, so
  a later attribution joins it without anyone remembering to. An emoji has no markdown escape, so
  the backslash renders visibly; that is the accepted cost and it is stated at the constant in its
  own terms. M2: the peer body was uncapped, contradicting in writing the contract section 1 had
  already recorded at `broker/tail.ts:756-759` (a peer body "is bounded where a mirrored prompt is
  bounded, at the render site"). Ruled for the prompt's bound over the reply's freedom, because a
  reply is Claude's own text written to be read while a peer body is remote-authored input; a 300 KB
  body rendered as 160 thread posts before the fix and 9 with the existing cut marker after. The
  Design section was updated to match. M3: the `Claude` name collision above. Minors fixed: the
  private display bound was renamed `MAX_PEER_NAME_DRAWN` and raised to the reader's own 120, so a
  name that survived the reader is never cut here and the two modules' name rules agree by
  construction; an empty escaped name no longer composes a header with a doubled or trailing space;
  `MAX_PEER_BRIEF_LENGTH` is exported and asserted against; two bound comments claimed code points
  where `fit` holds the tighter of code points and UTF-16; the brief forms, which never pass through
  `split`, gained a ceiling pin; and a forgery-test assertion that was satisfied by construction was
  strengthened. One Minor resolved against the reviewer's suggested fix: `MAX_TABLE_LENGTH`'s
  overhead reservation was left alone and its stale comment corrected instead, because folding the
  variable peer prefix into it would shrink the table budget about 6 percent and change how mirrored
  replies render mid-size tables, which is behavior outside this section, and `split` already
  measures the real prefix before placing a chunk. One security Minor carried forward rather than
  fixed here: `docs/security-model.md` enumerates five neutralization surfaces and peer traffic is a
  sixth, with the masked-link and readable-notice residuals now reachable by an author holding no
  process token and no reply key. Section 4 already owns that doc update and will name those two
  specifics.
Stamps: `memq unstamped --since 3h` reported zero in both tiers; none surfaced this section.
Gates: baseline at 22fcc5d was lint exit 0, test exit 0, 1436 tests / 1435 pass / 0 fail / 1
  skipped. Now lint exit 0, test exit 0, 1445 tests / 1444 pass / 0 fail / 1 skipped: +9 tests, no
  regression, no flake sighting in either of my two full runs. Two behaviors were verified by direct
  byte-comparison against the HEAD copy of the module rather than by the suite, because the fix
  round refactored a shared seam: `renderBlockedAlert` is byte-identical across four cases including
  the quiet null-operator form, and `renderMirror` (all three kinds) and `renderAnswer` are
  byte-identical across six inputs, so the new pass rides its optional parameter and nothing
  inherited it.
Scope: `install/Install-Functions.ps1` was folded into section 3, which had not named it. Its
  `$script:ChannelBrokerEnvAllowlist` is a hand-maintained list, and a knob absent from it parses
  correctly and never reaches the broker process. Approval drift, recorded here deliberately.
  Corrected in Chapter 3: this note first claimed nothing pinned the allowlist against
  `broker/config.ts`. A pin does exist, at `install/Install-Functions.test.ts:842`, and it is
  derived rather than enumerative, scanning `broker/config.ts` for `env.CHANNEL_*` and asserting
  every knob it finds is on the list. The fold was still right and the pin is what proved it: the
  test went red on its own the moment the config knob landed.
Next: 3. The routing, the stamp, and the knob (outbound, config)
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-25
Completed: 3. The routing, the stamp, and the knob (outbound, config)
Implemented By: implementer-opus (one build, one review-fix round; no escalation)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Two rulings shaped this section, both on gaps the spec did not foresee.
  The first: the knob and the machinery it governs are gated independently, so
  `CHANNEL_PEER_MESSAGES=full` with `CHANNEL_INTERIM_MIRROR=off` renders half an exchange. The
  transcript tailer exists only when the echo memory and the interim mirror are both on
  (`broker/index.ts:874`), and two of the three ways a peer message reaches a thread ride it; only
  the inbound half delivered to an idle session rides the independent mirror route. Ruled against
  building a peer-only tailer, because that duplicates the transcript machinery to serve a
  configuration nobody has asked for, and a thread showing one side of a conversation reads like
  the whole of it, which is the real cost. The answer is a one-time startup line naming exactly
  what reaches no thread and which two switches restore it, plus the correction of a router
  comment that had claimed one setting answered for a whole exchange. The second: under `off`, a
  prompt the operator really typed that the classification misreads as a delivery is deleted from
  the thread rather than merely misattributed. Both alternatives were worse and both hand a peer
  the same switch: falling through to `renderMirror` draws whatever a peer wrote inside the
  operator's quoted register on exactly the setting chosen to hear less from peers, and gating
  suppression on `readable === true` lets a peer choose its own path by choosing whether its body
  parses. So the behavior stands and the contract was corrected to say plainly what it costs, at
  `CROSS_SESSION_WRAPPER` and at the `off` branch, with the drop line naming the misread as a
  possibility. The same reasoning is why the router deliberately never reads
  `CrossSessionDelivery.readable`, now documented at the type: a branch reserved for the
  unreadable case is a branch a peer can select.
Assumptions: `peerMessages` defaults to `full` where its sibling `taskNotifications` defaults to
  `brief`; the divergence is deliberate and stated at both the type and the load site, because a
  wake notice is a report the console already renders compactly while peer traffic is the content
  of the exchange being watched (route (b), low-blast, reversible, section 3). The two enum knobs
  now share one `strictEnum(raw, modes, fallback)` reader, on `strictFlag`'s own stated ground
  that two parsers are two admission rules (route (a), the code's own conventions, section 3).
Review Findings: Two Majors and eleven Minors, all addressed. M1 and M2 are the two rulings above.
  Minors fixed: the engagement consequences are named at the classification constant and at both
  stamp sites, in both failure directions, because this reading now decides the stamp as well as
  the attribution and only the attribution failure is visible; `deliverPeer`'s no-double-post
  claim is stated as a contract resting on an unobservable half rather than as fact, with
  echo-digest dedup named as the fallback; `peerRun` gained a `never`-typed default, whose absence
  would have let a later direction fall into the outbound arm and claim a session said something
  it received; the mid-turn and idle paths were made to agree, so an origin naming a peer with an
  unreadable body now yields the placeholder on both rather than a placeholder on one and silence
  on the other; the knob's doc no longer says volume is all it governs without saying that `brief`
  draws the sender's own summary; a runtime-cycle pin joined `import-hygiene.test.ts`; the
  `kind === "prompt"` guard, the drop line, and the startup line each gained a durable test. The
  cycle pin was proven able to speak before it was trusted: a temporary runtime import of
  `RUN_PACE_MS` into `broker/tail.ts` made it fail with the intended message, restored from a file
  copy, and it carries two controls so it cannot go quiet if the runtime edge it guards ever ends.
  Two findings accepted rather than fixed: a `SendMessage` whose `tool_result` errored still
  renders as sent, which is Chapter 1's accepted residual and unchanged here; and m2's contract
  stays half-unobservable by construction, since only a live exchange settles whether the mid-turn
  delivery fires a prompt hook, which section 4 probes.
Stamps: `memq unstamped --since 5h` reported zero in both tiers; none surfaced this section.
Gates: baseline at 10ed595 was lint exit 0, test exit 0, 1445 tests / 1444 pass / 0 fail / 1
  skipped. Now lint exit 0, test exit 0, 1463 tests / 1462 pass / 0 fail / 1 skipped, run by me
  rather than read off the implementer's report: +18 tests, no regression. The echo-dedup `until`
  flake fired three times mid-section and was discriminated rather than assumed, this time with
  the control the earlier sightings lacked: a clean HEAD tree extracted outside the shared
  worktree went red twice in ten full runs with none of this section's code present. Pre-existing,
  confirmed. The receipts and the two wording corrections they force went to `docs/backlog.md`.
Scope: Four files were folded in beyond the section's named `broker/routing/outbound.ts` and
  `broker/config.ts`. `broker/index.ts` wires both new seams and now carries M1's startup line;
  `broker/index.test.ts` and `broker/intake.test.ts` pin them; `import-hygiene.test.ts` is where
  this repo's import-shape pins live and so is where the runtime-cycle pin belongs. All four sit
  in directories the section already touched, need no acceptance criterion the section did not
  carry, and are covered by its gate. `install/Install-Functions.ps1` was the fold Chapter 2
  recorded, and Chapter 2's note about it was factually wrong: it claimed nothing pinned the
  allowlist against `broker/config.ts`. A derived pin does exist, at
  `install/Install-Functions.test.ts:842`, and it went red on its own the moment the config knob
  landed. Corrected in place in Chapter 2 with the original claim preserved. Three surfaces were
  routed to section 4, which already owns the docs update, rather than fixed here:
  `docs/operations.md` needs the `CHANNEL_PEER_MESSAGES` row and the three new `routing:` drop
  lines; `docs/security-model.md` carries two enumerations peer traffic makes wrong ("one of six
  named shapes", "All five go through one fence-aware escape") alongside the sixth-surface note
  Chapter 2 already routed there; and the security reviewer's residual that a peer wake still
  clears a standing block one tool call later through `PostToolUse` needs one sentence.
Next: 4. Live verification and docs
Commit Model: Commit-and-Push
