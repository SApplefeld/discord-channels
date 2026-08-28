# Peer-Chatter Rendering: Subtext for Session-to-Session Traffic

Status: Complete (armed 2026-08-27, closed 2026-08-28; see Dispatch Authorization)
Commit Model: Commit-and-Push (the model every sibling plan in this repo ran under; the operator
confirms at arming)
Fable Spend: research and this spec in the Expert session; implementation dispatched
Created: 2026-08-27

## Problem

Session-to-session relays render in a thread at full size in the same voice as operator-facing
lines, so the operator re-checks headers every few lines to know the audience. From a phone that
re-checking is the dominant reading cost of a busy thread. The backlog item (parked 2026-08-27,
operator-approved and slotted as the first post-reboot effort) owns the rendering-of-chatter
surface; the volume half (audience labels on relays, delta-only capped operator reports) lives in
claude-kit's coordination slate and composes with this rather than overlapping it.

## The settled design (operator-approved, not reopened here)

Recorded in `docs/backlog.md` and banked in commit `fc7be96`, with the live rendering check run
2026-08-27 on the operator's phone client against a broker-posted three-form sample:

- Normal text for operator-facing lines.
- Discord `-#` subtext (small grey type, one prefix per line, scannable without a tap) for
  session-to-session chatter, each block led by a one-line header naming sender and receiver at
  full size. Subtext with a full-size header is **confirmed rendering**.
- Spoilers reserved for oversized bodies nobody scans anyway. Spoilers are **confirmed rendering**
  but occupy the same space as plain text and stay open once tapped.
- `>` blockquote **does not render** on relay-posted messages (literal `>` characters), removing it
  as an option on this surface.
- Bot-authored embeds are the one alternative still standing, held in reserve as a bigger broker
  change, not needed unless subtext proves insufficient in practice.

## Confirmed ground

Read from the files named, at commit `fc7be96`, on 2026-08-27.

- **One dispatch covers every path.** All three routes a peer message reaches a thread by (the
  tailer's own `peer-in`/`peer-out` items, the mirror-hook prompt seam, the queued-prompt seam)
  funnel through `deliverPeerMessage` (`broker/routing/outbound.ts:883`) into the one mode dispatch
  `peerRun` (`outbound.ts:817-828`), which calls exactly four render functions: `renderPeerIn`
  (`broker/discord/render.ts:1422`), `renderPeerOut` (`:1439`), `renderPeerInBrief` (`:1488`),
  `renderPeerOutBrief` (`:1500`). Changing those four changes every chatter rendering.
- **The header is already a full-size one-line attribution.** `peerAttribution` (`render.ts:371`)
  composes `📡 <name> → **Claude**` (direction by position, counterparty escaped through
  `inertField`, bounded at `MAX_PEER_NAME_DRAWN` 240). The bold on `**Claude**` alone is
  load-bearing: it is the one token a peer's escaped name cannot draw, so a counterparty naming
  itself `Claude` cannot make the direction unrecoverable (`PEER_SELF` doc, `render.ts:292-302`).
- **There is no per-line prefix machinery anywhere in the renderer.** The operator register is
  `>>> `, a message-level quote (`ATTRIBUTION.prompt`, `render.ts:262`); attributions are per-message
  prefixes the splitter carries (`split`, `render.ts:1750`). `-#` subtext is per-line by Discord's
  rule, so this effort introduces the renderer's first per-line transform.
- **The splitter's hard cut is a register escape hatch if left alone.** A single line longer than a
  message is cut mid-line and the continuation opens the next message bare
  (`render.ts:1803-1819`). Under a naive per-line prefix, a peer composing one long line would have
  its continuation render at full size.
- **The mirror body pipeline draws fences chatter cannot hold.** `mirrorBody` (`render.ts:1359`)
  runs `withTablesBlocked` first, which redraws Markdown tables into fenced blocks, then
  `withoutChips` (`render.ts:1654`), which escapes chip syntax outside fences and the line-leading
  quote marker everywhere, the quote being the stated exception to the fence exemption
  (`render.ts:1644`). A fence is a multi-line construct; its lines cannot each open with `-# ` and
  remain a fence.
- **Escape precedents already shipped.** `MARKDOWN` (`render.ts:93`) includes `` ` `` and `|`;
  `inertText` backslash-escapes both, so backslash-neutralizing fence delimiters and spoiler
  delimiters is established practice, not an invented rendering rule. `withoutAttributions`
  (`render.ts:1689`) neutralizes attribution glyphs at line starts and already runs on peer bodies.
- **Bounds in force.** Discord's ceiling on a message is 2,000 characters; `MAX_MESSAGE_LENGTH`
  1,900 sits under it to leave room for renderer-added markers (`render.ts:206`), `MAX_MIRRORED_PROMPT_LENGTH`
  16,384 as the peer-body cap via `peerCapped` (`render.ts:1451`), `MAX_PEER_BRIEF_LENGTH` 200 for
  the brief line (`render.ts:350`). `CHANNEL_PEER_MESSAGES` governs volume only
  (`broker/routing/outbound.ts:86-102`); attribution and register are deliberately not knobs.
- **The security model names the registers.** `docs/security-model.md` carries the
  six-untrusted-surfaces neutralization inventory, the peer-body attribution-forgery pass, and the
  unforgeable-register claims (quoted = operator, attribution openers renderer-composed). The
  register vocabulary this plan adds must land there in the same effort.

## Design

### The register contract

**The invariant, stated once and precisely: in a thread's collapsed reading (what a scroll shows
with nothing tapped), no peer-authored character renders at full size, with one named exception:
the counterparty display name inside the broker-composed header, escaped through `inertField` and
bounded at 240, because the name is the routing information the header exists to carry.** A
spoilered body revealed by a tap is the second, deliberate departure: the tap is the operator
choosing to read, and what scannability protects is the un-tapped scroll. Everywhere this document
or a test speaks of the register, this paragraph is the contract; the shorthand "no peer text at
full size" means exactly this. What the invariant buys: full-size body text under a chatter header
cannot exist un-tapped, so anything full-size at a scroll is the broker's own composition or an
operator-facing surface.

- The header line stays exactly as composed today: `📡 <name> → **Claude**`, full size, on every
  message of a split chatter rendering. The settled design says "bold one-line header"; this plan
  keeps the bold on the self token alone rather than the whole line, because whole-line bold erases
  the one discriminator that keeps direction readable against a peer named `Claude`
  (`render.ts:292-302`). Letter-level deviation from the approved wording, intent preserved; named
  in the arming ask so the operator confirms it knowingly.
- Every rendered line of a chatter body opens with `-# ` at absolute line start (prefix before any
  original leading whitespace). Blank lines stay bare: they carry nothing, forge nothing, and a
  prefixed empty subtext line is an unverified rendering.
- The brief forms keep their one bounded line, now prefixed: header, newline, `-# ` + the existing
  `peerLine` output. Register applies at every volume setting; volume stays the knob's whole job.
- An unreadable body renders `PEER_BODY_UNREADABLE` as a subtext line under the header, same as any
  body.

### The chatter body pipeline

Chatter gets its own body assembly, composed from the shared pieces rather than a second escape or
a second splitter (the sibling rule: two readings of where a fence is are a forgery waiting to
happen). Order, with each step's reason:

1. Strip invisibles and cap: `peerCapped` as today (cap measured pre-escape; the `shortened`
   marker joins the body here and takes the subtext prefix like every other line).
2. Neutralize fence delimiters: backslash-escape each backtick in every run of three or more
   backticks. Chatter cannot hold a fence (a fence's lines cannot be subtext), and a neutralized
   delimiter renders as the characters the peer wrote. Runs of one or two backticks survive, so
   inline code inside a line keeps rendering; inline code cannot span lines, so it cannot leak a
   line out of the register.
3. `withoutChips` on the result: with no fences left, the chip and quote escapes apply uniformly.
   `withTablesBlocked` is deliberately skipped: it draws fences, and a coordination message's table
   arriving as its own raw Markdown in subtext is the acceptable cost. Its pipes are escaped by the
   pipe pass rather than read as columns, so a peer cannot compose a spoiler of its own at any body
   size, and in the oversized form the pair is this renderer's own delimiter.
4. `withoutAttributions`: defense in depth behind the prefix, kept so the register does not rest on
   a single pass.
5. Wrap long lines: any line longer than `MAX_PEER_SUBTEXT_LINE_LENGTH` (new constant, recommended
   1,200 UTF-16 units, measured on the escaped text because UTF-16 units are the splitter's budget
   currency, with cuts landing on code-point boundaries so no astral pair is split) is broken into
   pieces at safe cut points (never splitting a backslash from what it escapes, never inside a
   backtick run; `cutSafely` is the in-module shape to reuse). This is what forecloses the
   splitter's hard cut for chatter: every line fits a message with the header prefix in front of
   it, so no bare continuation line can ever exist.
6. Prefix every non-empty line with `-# `.
7. `split(body, headerPrefix)` unchanged. The per-line prefixes are already in the text, so the
   budget counts them with no splitter change; the fence close/reopen machinery is inert because
   step 2 left it nothing to see.

### The oversized form

A body whose raw length (measured where `peerCapped` measures, pre-escape) exceeds
`MAX_PEER_SUBTEXT_LENGTH` (new constant, recommended 2,000 code points, a tunable) is the "nobody
scans it anyway" case. The two recommended constants in this plan are the implementer's defaults;
the values actually shipped are recorded in the section's chapter, and both are the named knobs a
one-word adjustment reaches later. The oversized form renders as:

- The header, full size, every message.
- A teaser: the body's opening line through the existing `peerLine` bounding, as one subtext line
  on the first message. Peer etiquette on this machine (the kit's peer-sessions skill: every
  message opens by naming its blast radius) makes the first line the one worth keeping scannable;
  where a sender ignores the etiquette the teaser is just the opening line, which costs nothing.
- The body inside a spoiler: pipeline steps 1-4 as above, the pipe neutralization among them, so a
  peer writing `||` cannot close the spoiler early and surface full-size text; then wrapped and
  split so that each posted message's body sits wholly inside one `||...||` pair with the header
  (and teaser) outside it. Spoilers do not span messages, so the pair is per message and its four
  units are counted in that message's budget. A body's trailing backslash run is evened before the
  closing delimiter is appended, because an odd run escapes the pair's first pipe and leaves the
  spoiler open; the evening reads the same whitespace class the splitter's own trailing trim reads,
  since a guard and a trim that disagree about where a message ends is exactly how the pair breaks.
- Step 6 (the `-# ` prefix) is deliberately skipped inside the spoiler, and Section 2 pins that as
  intended rather than leaving it readable as an omission. Two reasons: the register contract's
  collapsed reading is what the invariant protects, and a tapped-open spoiler is the operator
  choosing to read the body at reading size; and `-#` inside `||` is an unverified composition this
  plan refuses to invent a rendering rule for.

Multi-line spoiler rendering and escaped-pipe-inside-spoiler rendering are not covered by the
2026-08-27 check (it confirmed spoilers render and how they behave once tapped, not these
compositions), so Section 4's live check gates this form. If the live check fails the form, the
fallback is subtext at every size (drop the threshold branch), and that call goes to the operator
with the phone evidence rather than being decided silently.

### What does not change

Classification (`broker/tail.ts`), the three delivery paths, the echo-dedup claims, engagement
stamping, `CHANNEL_PEER_MESSAGES` semantics, the empty-render drop, the `off` drop lines, the
16,384 cap, the header composition, and every operator-facing rendering: prompts, replies,
narration, answers, task notices, cards, alerts, permission prompts.

## Dispatch Authorization

The operator (Scott Applefeld) armed this plan on 2026-08-27 (2026-08-28T01:40Z) by running
`/kit-goal docs/plans/channels_peer-chatter-rendering_spec_v1.md` at the keyboard of the
CHANNELS: Worker session the goal is bound to. The grant covers executing this plan's sections
under the executing-work skill, with the arming condition's own words asking for parallelized
dispatch; anything the plan does not cover still goes to the operator. Recorded by the expert from
the on-disk goal state (`.kit/goal-state.json`, read 2026-08-27), which names this plan, the bound
session, and the arming instant; the keyboard act itself is the bound session's account. The
Commit-and-Push model in this plan's header is confirmed by that arming, and the bound worker named
that reading, with the header-bold deviation, to the operator rather than assuming either
silently.

## Standing Brief Amendments

Inherited from `archive/plans/channels_follow-session-rename_spec_v1.md`, binding on every section
dispatched from this plan, folded into every dispatch brief:

1. A test never asserts against an expression the implementation also evaluates; assert literal
   expected values.
2. Every untrusted display string is normalized through `clean` before it is bounded.
3. Every bound sits behind every strip: normalize completely, then measure.
4. Adding a reader to a shared symbol means editing that symbol's own doc block in the same change.

## Sections of Work

### Section 1: The subtext register (Model: opus)

`broker/discord/render.ts`: the chatter body pipeline (steps 1-7), the line-wrap bound and its
constant, the rewiring of `renderPeerIn`, `renderPeerOut`, `renderPeerInBrief`,
`renderPeerOutBrief`. `broker/discord/render.test.ts`: pins for the register contract, at minimum:
every non-blank body line of every emitted message opens with `-# ` across a multi-paragraph body,
a single line long enough that the old path would have hard-cut it, a body carrying a fence, a body
carrying a table, a body opening lines with attribution glyphs, and the unreadable body; the header
opens every message; brief mode emits one message of header plus one prefixed line; a body with an
unclosed fence yields no bare fence line anywhere in the output. `broker/routing/outbound.test.ts`:
update the assertions that pin the old rendered shapes. `broker/sanitize.ts`: the doc block on
`sliceCodePoints` only, naming the wrap as a new reader per standing amendment 4.

Two guards this section carries that the pipeline steps above do not name, both found at review and
both properties of the register rather than additions to it. The marker neutralizes itself: a peer's
own line-leading `-#` is escaped, applied per drawn piece rather than in the escape chain, because
the wrap runs after the chain and can carry a peer's mid-line `-#` to the start of a piece. And the
chatter body normalizes U+0085, U+2028 and U+2029 to `\n` before any line is read, so the escapes,
the marking and the splitter share one line model.

Baseline the suite before the section per
testing discipline, and read the echo-dedup group's flake note in `docs/backlog.md` before calling
any red there a regression.

### Section 2: The oversized spoiler form (Model: opus)

The threshold constant, the pipe neutralization, the teaser line, the per-message spoiler wrapping
with its budget accounting. The pipe neutralization covers every chatter body rather than the
oversized form alone: under-threshold bodies otherwise keep live pipes permanently, which lets a
peer hide its own text behind a spoiler tap and inverts the scannability the register buys. Tests: the threshold boundary both directions (at the bound, subtext;
past it, spoilered); no peer-authored text outside a spoiler beyond the teaser; the teaser is
prefixed and bounded; the spoiler's content carries no `-# ` prefix, pinned as the deliberate skip
the Design names rather than left readable as an omission; every message's spoiler pair closes within that message; a body dense with
`|` characters cannot close a spoiler early (pin the escape, and pin that the assembled message
carries balanced renderer-composed delimiters).

Three guards this section carries that the paragraphs above do not name, all three found at review
and all three properties of the form rather than additions to it. The trailing-backslash evening
reads the splitter's own trailing-trim whitespace class rather than a narrower one, because the two
readings decide the same boundary and a peer's backslash followed by a no-break space otherwise
escapes the closing pair's first pipe and leaves the whole body drawn at full size. The teaser is
composed from a line model shared with the brief forms, normalized before the split, because a body
whose first line carries U+0085 would otherwise draw a second unmarked line outside the spoiler.
And the peer's own `-#` is neutralized inside the spoiler as well as outside it, so the form holds
its register on two covers rather than on one unverified rendering.

The register pins read a posted message the way Discord parses it rather than by searching for raw
`||`. A positional search finds a pair on a message whose closing delimiter is escaped, strips the
body, and reports green on exactly the break the pins exist to catch.

### Section 3: The register vocabulary lands in the docs (Model: opus, Locus: inline, meaning run
in the executing session itself rather than dispatched to a subagent)

`docs/security-model.md`: the chatter register joins the attribution inventory. State what is
true, in the contract paragraph's own terms: a peer body line never renders at full size in the
collapsed reading, the header's escaped counterparty name being the one full-size peer-chosen
field and a tapped spoiler the one full-size reveal; the subtext prefix marks chatter on
broker-composed messages but is not itself unforgeable (a reply's own `-#` is that reply's
markdown, and claims nothing false about authorship); the quoted register and the attribution
openers remain the unforgeable set; the peer-body attribution-forgery pass stays. Sweep the whole document for claims
the new rendering falsifies, not just the sections named here. `docs/architecture.md`: the
rendering seam's description if it names the peer forms. `docs/backlog.md`: the spoiler-collapsed
task-reports item already points at this plan's decisions; confirm the pointer names this plan file
once it exists.

### Section 4: Live verification (Model: the worker session itself, plus operator phone time)

SCOTT is this machine's hostname, the host whose broker serves the operator's relay threads. This
machine has one checkout, `D:\discord-channels`, and the live broker serves it: the scheduled task
`SapplefeldChannelsBroker` launches `D:\discord-channels\install\Start-Broker.ps1`, and
`install/Repair-Broker.ps1` defaults its repo root to the checkout the script itself lives in, so
development tree and served tree are the same tree. `sapplefeld-channels` survives only as the
product name, carried by the plugin marketplace and by the state root `%LOCALAPPDATA%\sapplefeld-channels`
(`broker/config.ts:435`). Restart the broker onto the built code by running
`.\install\Repair-Broker.ps1 -Pull` from the checkout root in an elevated prompt
(`docs/operations.md` owns the procedure; the broker has no health route, so liveness is
`GET /sessions`). Then the worker composes and drives the eight payloads below itself, a real
cross-session exchange in each direction (`SendMessage` from a sibling session covers inbound;
this session's own send covers outbound), and the operator reads the thread on the phone. Item 5
needs `CHANNEL_PEER_MESSAGES=brief` in `broker.env` and its own broker restart, so it runs last
and the setting is restored after. What is being read, each item pass/fail on its own line:

1. A multi-message chatter body: every body line small and grey, header full size on every message,
   no full-size peer line anywhere.
2. Inline code inside a subtext line renders (or degrades to literal backticks; either keeps the
   register, note which).
3. A body that carried a fence: delimiters render as literal characters inside subtext, no code
   block, no full-size lines.
4. The oversized form: teaser scannable, body collapsed behind the spoiler, tap reveals it, escaped
   pipes render as pipes, nothing outside the spoiler but header and teaser.
5. Brief mode: one message, header plus one small grey line.
6. A body whose lines open with the marker and with a heading marker: a peer line written `-# x`
   draws the two characters visibly rather than composing a second marker, and a peer line written
   `# x` draws small and grey rather than as a heading. The second is the open question: the
   renderer prefixes the subtext marker, so what Discord receives is a subtext marker followed by a
   heading marker, and whether the subtext rule carries the doubled-marker guard its heading rule
   does is unobserved. A heading drawing there is peer text above full size, so this item gates the
   register exactly as item 4 gates the collapsed form.
7. The escaped attribution glyph: a peer body opening a line with `📡` draws the glyph with a
   visible backslash in front of it, which is the accepted cost of the attribution pass, and draws
   no second header. In the same payload, a tilde fence (`~~~`): the fence neutralization matches
   backtick runs only, so a tilde fence is left live in a chatter body deliberately. Read whether it
   opens a code block on this surface. If it does, the fence claim needs the tilde form too.
8. The two quoted registers side by side: an operator-typed message and a peer message in the same
   thread. The backlog records that a plain `>` blockquote does not render on relay-posted messages
   at all, drawing as literal `>` characters, and the security model's unforgeability claim rests on
   the operator's `>>> ` block being visually distinct from anything content can draw. Read whether
   `>>> ` draws as a quote bar on this surface. If it does not, the discriminator is weaker than the
   document claims and that is a finding about the security model rather than about this plan, to be
   recorded and routed rather than fixed here.

Items 4 and 6 failing route to the operator with the evidence (the fallback named in Design applies
to both: subtext at every size for item 4, and for item 6 either escaping the heading marker or
accepting it). Item 8 is a reading rather than a gate on this plan: whatever it finds is recorded,
and a finding against the security model's claim is routed out of this effort. Any other item
failing reopens its section.

## Traps, each with its handling

- **The hard cut is the register's escape hatch.** One un-prefixed continuation line is a peer
  rendering at full size. Handled structurally: the line wrap (step 5) makes the hard-cut path
  unreachable for chatter, and Section 1 pins the long-line case rather than trusting the
  reasoning.
- **The table transform draws fences.** Running `mirrorBody` unchanged would put fence lines inside
  subtext. Handled: chatter skips `withTablesBlocked`; the pipeline is composed from `withoutChips`
  and `split` directly.
- **The `shortened` marker closes fences.** `shortened` (`render.ts:1572`) appends a closing fence
  when the cut leaves one open. Run the fence neutralization after capping so whatever `shortened`
  appended is neutralized with everything else; a literal escaped fence in a cut body is correct,
  an active fence is not. Pin the order with the fence-carrying over-cap body.
- **Cap before strip is the standing amendment's trap in new clothes.** Every bound in the new
  pipeline sits behind the strips and escapes it measures (the wrap measures escaped text; the
  threshold and cap measure pre-escape text at the seam that already does). State each
  measurement's ground in the constant's doc block.
- **Escape-aware cutting.** The wrap must not separate a backslash from the character it escapes or
  split a backtick run; `cutSafely` already knows the rules, reuse it rather than re-deriving.
- **Two readings of fence structure.** The neutralization (step 2) must run before `withoutChips`
  so the chip escape sees the fence-free text it will actually be rendered as. Reversed, the chip
  escape would exempt runs the neutralization then unfences, leaving live chips inside former
  fences.
- **The splitter comment budget.** `MAX_MESSAGE_LENGTH` leaves 100 units of the Discord ceiling for
  renderer-added markers; the spoiler pair spends 4 of it per message. Count it in the assembly
  rather than trusting the slack, and say so where the constant is spent.

## Acceptance

1. Every chatter rendering, both directions, both volume modes, satisfies the register contract as
   the contract paragraph states it (collapsed reading, header-name exception, spoiler-tap
   departure). Pinned by tests at the render layer, where all three delivery paths converge
   (confirmed ground: the `peerRun` funnel), plus the updated `outbound.test.ts` assertions, which
   are the path-level pins; no new per-path suites are being asked for.
2. The whole gate green against the recorded baseline, with the echo-dedup flake family read per
   the backlog's own discriminator (a moving member across runs is contention; the same member
   twice is a regression).
3. `docs/security-model.md` states the new register truthfully and no claim elsewhere in `docs/` is
   falsified by the change.
4. The Section 4 live check read on the operator's phone, items 1-3 and 5 passing, item 4 passing
   or its fallback decided by the operator on the evidence.

## Out of scope

- The volume half: audience labels on relays, delta-only capped operator reports (claude-kit's
  coordination slate).
- The spoiler-collapsed background-task-reports item (`docs/backlog.md`): it takes its rendering
  vocabulary from this plan's decisions once they are live, as its own effort.
- Bot-authored embeds (the reserve alternative; touched only if subtext proves insufficient in
  practice, which is an operator call on lived experience, not this plan's).
- The `>>> ` operator register and every operator-facing rendering.
- `CHANNEL_PEER_MESSAGES` semantics.

## Related plans

- `archive/plans/channels_peer-traffic_spec_v1.md`: built the classification and delivery surface
  this plan re-renders.
- `archive/plans/channels_follow-session-rename_spec_v1.md`: source of the inherited standing
  amendments and the current house shape for sections and briefs.
- claude-kit's 2026-08-27 coordination slate (that repo's docs): the volume half this composes
  with.

## Chapters

### Chapter 1 - 2026-08-27
Completed: Section 1: The subtext register
Implemented By: implementer-opus (one dispatch, resumed once for the review-fix round; no tier escalation)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: `MAX_PEER_SUBTEXT_LINE_LENGTH` ships at 1,200 UTF-16 units measured on the
escaped text, and `PEER_SUBTEXT` is `-# `; those are the two named knobs a later one-word adjustment
reaches. The bound costs throughput on purpose: a marked line is 1,203 units against a per-message
body budget of roughly 1,643 to 1,878, so the splitter fits one wrapped line per message and a
16,384-unit single-line body now posts about 14 messages where the old hard-cut path posted about
10. That is the price of the hard cut being unreachable, which is what the register rests on. Two
guards were added at review that the Design's seven steps do not name, both recorded into Section 1
above: the marker neutralizes a peer's own line-leading `-#`, applied per drawn piece rather than in
the escape chain because the wrap runs after the chain and can carry a mid-line `-#` to the start of
a piece; and the chatter body normalizes U+0085, U+2028 and U+2029 to `\n` before any line is read,
because JavaScript's multiline `^` treats U+2028 and U+2029 as terminators but not U+0085, so the
escapes and the marking disagreed about where a line starts before Discord was ever consulted.
Section 1's `Files in scope` grew by `broker/sanitize.ts` (one doc block, no logic) and the Design's
step 3 was corrected: it claimed a table arrives as "raw escaped pipes", and nothing in the pipeline
escapes a pipe. Section 2's scope was widened in the same edit, from neutralizing pipes for the
oversized form to neutralizing them for every chatter body, because under-threshold bodies would
otherwise keep live pipes permanently and let a peer hide its own text behind a spoiler tap.
Machine, not code: the suite's four `credentials`/`config` token-file failures were environmental,
root-caused here to `TEMP=D:\Temp` carrying inherited `Authenticated Users:(I)(M)` and
`BUILTIN\Users:(I)(RX)`, which made the guard at `broker/discord/credentials.ts:244` correctly
refuse a world-readable token file while the tests asserted the opposite. The guard was right
throughout and the machine was what changed. The operator repaired it by breaking inheritance on
that directory and granting three principals in one pass, and the repair is subtractive by nature:
adding correct permissions to a directory whose entries are all inherited changes nothing while
reporting success. Confirmed on this session's own surface by re-reading `icacls D:\Temp` and by the
isolated 21-test run going 20/0; the clock times for the repair are SCOTT-CLAUDE: Coordinator's
report and are not cited here as fact.
Assumptions: none beyond the spec.
Review Findings: adversarial, blind and security reviewers, all at opus/max, all read-only (round
bracketed with `git status --porcelain` before and after; identical, so the read-only briefs held).
One Critical addressed: the register did not neutralize its own `-# ` marker, so a peer line opening
with `-#` drew as `-# -# ...` and, if Discord's subtext rule carries the doubled-marker guard its
heading rule does, would have rendered peer text at full size under a chatter header. Three Majors
addressed: a whitespace-only wrap piece could leave a bare `-#` after the splitter's `trimEnd`
(found independently by two reviewers with a traced repro); a shipped comment claimed pipes were
escaped when nothing escapes them; and the three exotic line breaks above. Eight Minors addressed,
including two test assertions that had become vacuous, where deleting `withoutAttributions` from the
chatter path left them green. Each fix was watched failing first against an out-of-tree copy of
`broker/`. One judgment call left as-is with the doc corrected rather than the code changed:
`shortened`'s fence-closing suffix reaches the operator escaped on an over-cap body cut inside a
fence, which is cosmetic and provably cannot reach the register; reversal is a boolean through
`shortened`. One finding routed out of the plan to `docs/backlog.md`: `withoutInvisible` leaves
U+0085, U+2028 and U+2029 raw on every surface, not just chatter, and sizing that needs a scout
rather than a blind extension of this section.
Stamps: adjudicated 3, stamped 3 (`node-test-count-lines-are-not-tap`,
`a-contended-suite-run-forges-results-not-just-deaths`, `ask-the-coordinator-not-the-process-list`,
all operator tier). `memq unstamped --since 6h` then returned zero in both swept tiers, so the
stretch is accounted for and no hand walk was owed.
Gate: baseline at `d50f18c` with a clean tree, 1557 tests / 1551 pass / 5 fail / 1 skip, exit 1,
87.1s. Close gate, 1563 / 1562 / 0 / 1, exit 0, 41.1s, started 02:44:31Z. Delta is +6 tests, all
green, no new failing name. The baseline's five failures are each accounted for: four were the TEMP
ACL fault the operator repaired, and the fifth was the known `until`-helper echo-dedup flake, which
`broker/tail.test.ts` alone answered at 171/171 exit 0 in 1.3s and which did not recur across three
consecutive full runs. The one skip is test 238, a POSIX-only guard the test emits on Windows, and
it is the same skip the baseline carried. Every wall clock here was measured tonight on this
hardware and none is comparable to any figure this repo recorded before the rebuild; whole-gate cost
on this box tonight ran 41 to 87 seconds across three runs at different contention, which measures
the box's load more than the tree.
Next: Section 2: The oversized spoiler form
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-27
Completed: Section 2: The oversized spoiler form
Implemented By: implementer-opus (one dispatch, resumed once for the review-fix round; no tier escalation)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: `MAX_PEER_SUBTEXT_LENGTH` ships at 2,000 code points, measured pre-escape at
`peerCapped`'s own seam, and is the knob a one-word adjustment reaches; unlike the line bound it is a
reading-comfort choice rather than a correctness one, since both forms hold the collapsed reading.
The budget went through the splitter rather than beside it: `split` gained an optional per-message
`decorate(index)` returning a lead and a tail, charged inside its existing `overhead` closure and
drawn by `flush` from the same `messages.length` reading, so the count and the draw cannot disagree.
Index-aware rather than uniform because the teaser rides only the first message, and a reserve wide
enough for it charged against every message would spend `MAX_PEER_BRIEF_LENGTH` of each later
message's budget on nothing. `attributed` passes no decoration, so every pre-existing caller's output
is byte-identical. The widening the plan took on at Section 1's close turned out to be a
consistency fix rather than a new rule: `MARKDOWN` already carries the pipe and `inertText` already
escapes it, so both brief forms have neutralized pipes since they were written and only the whole
mode skipped it. One performance defect was fixed in passing: the first pipe pass was a run form
that backtracked quadratically over a long backslash run carrying no pipe, which is peer-controlled
input on the broker's event loop, measured at 327ms against a 16,384-backslash body; the shipped
token scan measures 0ms on the same input. The scan's equivalence to the run form was the one claim
the implementer flagged as most likely wrong, so it was settled here by a differential test over
300,000 randomized backslash/pipe/newline strings: zero mismatches, with a sanity control asserting
both sides escape a bare pipe read before the count.
Assumptions: none beyond the spec.
Review Findings: adversarial, blind and security reviewers, all at opus/max, all read-only (round
bracketed with `git status --porcelain` before and after; identical, so the read-only briefs held).
All three independently found the same Critical from three directions, and it was reproduced here on
the real renderer before any fix: `evenEscapes` evened a trailing backslash run against `[ \t]*$`
while the splitter trims with `trimEnd()`, whose class is the whole Unicode space set, so a peer
body ending a message with a backslash and a no-break space escaped the first pipe of the broker's
own closing delimiter and left that message's spoiler open, drawing the whole body at full size.
A second Critical, also reproduced here: the teaser was composed from the raw body and so bypassed
`newlinesOnly`, letting U+0085 survive into the one peer-authored line the form draws outside the
spoiler. Fixed at the shared seam in `firstLine`, which closed the same latent hole in both brief
forms. Three Majors addressed, and the sharpest was in the tests rather than the code: the register
oracle located the spoiler by raw `||` search, so on a message whose closing delimiter Discord would
read as escaped it still found a pair, stripped the body, and reported green on precisely the break
it exists to catch. Rebuilt on the escape-aware reading and shown red against the broken guard
first. The fixture meant to cover the trailing-whitespace branch was vacuous, `peerCapped`'s own
trim having flattened it into a copy of its neighbour, which is why the hole survived; it was
rebuilt at an interior message boundary over seven trailing-whitespace shapes. Five Minors
addressed, including two doc-block figures that did not reconstruct. One finding routed out of the
plan to `docs/backlog.md`: `withoutChips` inserts its escape without counting the backslash run
already in front of the character, so author-escaped input comes back double-escaped. The item's
first wording claimed this hands a live chip back, and the adversarial reviewer's low-confidence
Minor challenged it; re-checking showed the reviewer right, since every Discord chip construct needs
its closing bracket adjacent and the same bypass puts a literal backslash there, so the item was
rewritten to claim only the non-idempotent escape and to mark the chip risk unproven.
Stamps: adjudicated 3, stamped 10. The three the sweep surfaced were peer-session reads over this
window and none steered the work, so all three were skipped; the ten stamped are the records that
did steer it, nine operator tier and one project tier. Two memories were written rather than only
read: `task-output-artifact-can-be-empty-for-a-live-agent` (project), because a dispatch's `.output`
transcript stayed 0 bytes for this section's whole implementer run while a sibling dispatch's was
847KB, so the never-started reading returned the wedge shape twice on a healthy agent and only the
worktree showed it working; and `quoted-heredoc-collapses-backslashes` (operator), because a quoted
heredoc through the Bash tool halved the doubled backslashes in a probe's regexes, which returned
138,000 mismatches out of 200,000 that were entirely the probe's own corruption and read exactly
like a real finding.
Gate: baseline at `669cb8f` with a clean tree, 1563 tests / 1562 pass / 0 fail / 1 skip, exit 0,
49.9s. Close gate, read here rather than taken from the implementer's report, 1568 / 1567 / 0 / 1,
exit 0, 42.7s, `tsc --noEmit` clean. Delta is +5 tests, all green, no new failing name. The one skip
is test 238, the POSIX-only token-file guard the test emits on Windows, the same skip both earlier
gates carried. The intermediate gate over the pre-fix work read 1567 / 1566 / 0 / 1 at 87.8s while
three reviewers held the box, which measures the contention rather than the tree.
Next: Section 3: The register vocabulary lands in the docs
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-28
Completed: Section 3: The register vocabulary lands in the docs
Implemented By: main session (Locus: inline, as the section specifies; the docs-write-guard denies a subagent any write under `docs/`)
Metrics: review rounds 1; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: the section grew past its three named files, and the growth was the point
rather than drift. Acceptance criterion 3 is that no claim anywhere in `docs/` is falsified by the
change, and the sweep found the falsified claims were concentrated in a file the section never
named: `docs/operations.md`, whose peer-traffic section still showed the pre-register rendering in a
worked sample and whose `CHANNEL_PEER_MESSAGES` table row still described bodies drawn whole. That
is the document the operator reads to interpret what they see on the phone, so Section 4's live
check would have been read against a stale reference. Folded in under the fold predicate (same
directory, no new acceptance criterion, the same gate), along with `docs/README.md` and
`docs/plans/README.md`, both of which still said no plan was open. Three of this section's own new
claims were false when written and were caught by review rather than by me: that the five
non-chatter surfaces take the shared escape "and nothing else" (they also take the table transform,
which chatter skips, so the sentence inverted the asymmetry it was written to state); that the table
transform escapes its cells through the cell escape (the fenced shape uses the block escape, and the
cell escape belongs to the second, unfenced per-row shape); and that the collapsed form marks no
line at all (it marks exactly one, the teaser, which is the only peer text drawn outside the
spoiler, so the sentence contradicted the register it sat beside). Section 4's payload list grew
from five items to eight, all three additions being compositions the documents would otherwise have
asserted without evidence: a peer's heading marker behind the subtext marker, the escaped
attribution glyph beside a tilde fence, and the two quoted registers side by side.
Assumptions: none beyond the spec.
Review Findings: adversarial and security reviewers, both at opus/max, both read-only (round
bracketed with `git status --porcelain` before and after; only this session's own doc edits, so the
read-only briefs held). The blind lens was skipped deliberately: this is a docs-only section with no
`Audience:` line, so omitting the `docs/` paths empties the changed-file list and there is no diff
for that lens to read. Recorded here so the gap reads as a decision. The security dispatch died
mid-response on an API connection fault, which is an environment fault rather than a result, and
took its one same-model retry over the corrected state, so its review is of what actually ships.
One Critical addressed: `docs/operations.md` falsifying acceptance criterion 3, described above.
Seven Majors addressed across the two reviewers: the three false claims of my own named above, the
backlog's own peer-chatter item still asserting in the present tense that relays render at full
size, the new backlog pointer written as a bare repo-rooted code span where its ten neighbours are
`docs/`-relative markdown links, `docs/README.md`'s peer-traffic archive row stale on both halves,
and the register promise stated as established while the heading composition that could falsify it
is unobserved and its live gate unrun. That last one is the finding worth keeping: the document now
states the promise as designed-and-gated, names item 6 as what settles it, and gives that item its
own fallback rather than letting it borrow the collapsed form's. Five Minors addressed, including
scoping the surviving-construct claim to the whole-mode body, since the brief line and the teaser
both compose through the full markdown escape and carry none of the three. One Minor accepted rather
than fixed: `MAX_PEER_SUBTEXT_LINE_LENGTH`'s doc block says the lead and tail cost "at most 209
units" where the exact maximum is 208, which is a true upper bound stated loosely in a sentence that
already says "about", so the committed file is not churned for it.
Stamps: adjudicated 3, stamped 2. The three the sweep surfaced were the same peer-session reads
Chapter 2 skipped, and none steered this section either. The two stamped are the heredoc trap, which
this section applied by writing its edit scripts through the Write tool rather than a shell
heredoc, and the record that the operator reads plain language over technical, which shaped
`operations.md`'s two new paragraphs.
Gate: 1568 tests / 1567 pass / 0 fail / 1 skip, exit 0, 42.1s, unchanged from Chapter 2's close
because this section changed no code. Run rather than assumed, since a prose section that quietly
touched a fixture would look exactly like one that did not.
Next: Section 4: Live verification
Commit Model: Commit-and-Push

### Interim board 1 - 2026-08-28

Section 4 is open and blocked on the operator; Sections 1-3 are closed and pushed
(`669cb8f`, `d0cba9c`, `830f3cf`).

**Stage.** Everything Section 4 can do without the operator is done. What remains needs two things
only he supplies: an elevated prompt for the broker restart, and his eyes on the phone for eight
readings. Both sit in the completion contract's blocker set as an external dependency.

**Live dispatches.** None. The pre-BLOCKED ask went to the CHANNELS: Expert seat and was answered
in the same turn; no subagent is in flight.

**Gate baseline.** 1568 tests / 1567 pass / 0 fail / 1 skipped, exit 0, 49.5s, run in this session
after the doc repairs below. Identical to Chapter 3's close on every count, as expected: this
boundary changed documentation and a gitignored scratch probe, no code.

**Rulings adopted since Chapter 3.**

The spec's own premise for this section was false and is repaired. Section 4 said the deployed
checkout is `D:\sapplefeld-channels`, distinct from the development tree. No such directory exists.
This machine has one checkout, `D:\discord-channels`, and the live broker serves it: the scheduled
task `SapplefeldChannelsBroker` launches `D:\discord-channels\install\Start-Broker.ps1`, and
`install/Repair-Broker.ps1:28` defaults its repo root to the checkout the script itself lives in.
`sapplefeld-channels` survives only as the product name, carried by the plugin marketplace and by
the state root `%LOCALAPPDATA%\sapplefeld-channels` (`broker/config.ts:435`). The CHANNELS: Expert
seat, asked, confirmed the checkout was renamed rather than split, and named the sentence as its own
unsourced inference rather than a fact from any source; its three cited pieces of evidence were
re-verified here before being acted on, and all three hold: the old harness project directory
`~/.claude/projects/D--sapplefeld-channels` carries no transcript after 2026-08-17, the path entered
`docs/operations.md` in `f88ad47` on 2026-08-07 when it was still true, and the state root reads as
the expert said. The repair landed in two places, the spec's own sentence and `docs/operations.md`,
whose lines 31-32 handed the operator that same non-existent path in the one procedure this section
tells him to run.

`docs/operations.md` also now records that the repair runs from an elevated prompt and why. The
scheduled task starts the broker in session 0, where an ordinary desktop session cannot open the
process even to read its command line: confirmed here, `Invoke-CimMethod GetOwner` on the live
broker returns access-denied and its `ExecutablePath` reads empty from this session. That is the
same unreadable orphan the script's kill step identifies by port. `install/Repair-Broker.ps1` does
not test for elevation before it runs, so an unelevated attempt is not refused up front.

**The eight payloads are composed and pre-verified.** `.kit/scratch/section4-probe.mjs` drives the
real chatter renderers over all eight and prints exactly what the broker would post;
`--emit` writes the bodies to `.kit/scratch/section4-payloads.json` for the live run to replay
verbatim. Both are gitignored scratch, not deliverables. The probe caught a payload defect worth
recording: the first draft of item 1 was 3,273 code points, past `MAX_PEER_SUBTEXT_LENGTH`, so it
rendered as the spoiler form and would have read item 4 a second time while reporting itself as the
multi-message subtext case. The window that item needs is narrow, since the body must stay under
2,000 code points while exceeding the splitter's 1,900-unit per-message budget, and the per-line
`-# ` prefix is the only budget it can spend without spending code points: the payload is therefore
many short lines rather than few long ones, and now renders as three subtext messages. The probe
asserts each payload's expected form and message count so a later edit cannot silently drift one
item into another's case.

Two readings the probe settled in advance, so the operator is not asked to adjudicate them on the
phone. The trailing-backslash evening from Section 2 is visibly working: item 4's body ends
`ends-with-backslash\` with the run evened before the closing pair. And in the oversized form the
opening line is drawn twice, once as the teaser outside the spoiler and again as the body's own
first line inside it, which is the composition the design specifies rather than a defect, since the
teaser is a preview and the spoiler holds the complete body.

**Next action, Section 4.** The operator runs `.\install\Repair-Broker.ps1 -Pull` from
`D:\discord-channels` in an elevated prompt, confirms `GET /sessions` answers, and reads the thread
on his phone while this session drives the payloads. The live broker (PID 1160) started
2026-08-27 20:20, before Section 1 landed at 22:47, so it is serving pre-register code and the
restart is not optional. Item 5 needs `CHANNEL_PEER_MESSAGES=brief` in `broker.env` and its own
restart, so it runs last and the setting is restored after.

### Interim board 2 - 2026-08-28

Section 4 is running live with the operator. The broker was restarted onto the register code and the
first six readings are in.

**Stage.** Items 1 and 4 read pass on their collapsed readings, item 6 read **fail** and its fix is
shipped, and items 2, 3, 7 and 8 are posted but unread. Item 5 is staged and waiting on a restart.

**Live dispatches.** None. The CHANNELS: Expert seat is acting as the test partner for the inbound
direction, which is coordination rather than dispatch.

**Gate baseline.** 1569 tests / 1568 pass / 0 fail / 1 skipped, exit 0, 44.1s. One test more than the
1568 recorded at Chapter 3 and at Interim board 1, that one being this boundary's own pin; no
regressions.

**What the live check established.**

Item 1 passes: an under-threshold body splitting across three messages draws every body line small
and grey with the header full size on each, and the split seams carry no unmarked line. Item 4's
collapsed reading passes: the teaser draws small and grey and each message's body is concealed behind
a single spoiler block, which retires "a spoiler pair spanning several lines within one message" from
the security model's unobserved list. The escaped pipe inside a spoiler is still unread, since it
needs a tap, and it is now the only entry left on that list.

**Item 6 failed, which is the finding this boundary exists for.** A peer line written `# text` draws
as a heading on the operator's client. Discord's subtext rule carries no doubled-marker guard, so the
client reads past the `-# ` prefix this renderer puts in front and sets the line as a heading: peer
text not at full size but above it, which is a strictly worse break than the reading-size
fall-through the sibling guard was written for. The plan named two dispositions for this item and the
escaping one was taken, on the reasoning that accepting it would let any peer set its words larger
than the operator's own in the operator's own thread, which empties the register of its purpose. The
operator was given the fix, the evidence and the one-line revert rather than being told after the
fact.

The guard escapes the first character of a line-leading heading marker run, which breaks the
construct because a heading marker is read only at a line's start. Both chatter forms take it through
one shared helper: the marked and spoilered forms were already duplicating the subtext-marker replace
between them, and a second guard added by copy-paste is how one form later loses it in silence, so
the pair moved to `withoutOwnMarkers` and both call sites route through it. Applied per drawn piece,
because the wrap runs after the escape chain and can carry a mid-line hash to a piece start. The pin
was watched failing first and reports the exact string the operator's screenshot shows,
`-# # forged heading`. Shipped in `8d73126`.

Three documented claims were falsified by the reading and repaired in the same commit.
`docs/security-model.md` stated the promise as designed-and-gated pending this very item, and its
unobserved-composition list dropped from three entries to one. `docs/architecture.md` gained the
reason the prefix alone is not enough. A test comment asserting the subtext rule's behaviour was not
knowable from here, and a code comment calling the spoiler rendering unseen, were both true when
written and are not now.

**Local state altered, with its rollback.** `%LOCALAPPDATA%\sapplefeld-channels\broker.env` gained
`CHANNEL_PEER_MESSAGES=brief` at line 13 for item 5, with a backup beside it at
`broker.env.pre-item5`. Restoring means deleting that line or copying the backup back, and it is owed
before the effort closes.

**Next actions.** The operator restarts elevated for item 5, then again to leave brief mode, and that
second restart is what confirms the item 6 fix on a real client rather than only against the renderer
here. Items 2, 3, 7 and 8 are posted and need reading; item 4's spoiler needs a tap for the pipe
reading. An interactive browser session was proposed to let this session read the renderings itself
rather than spending operator attention; Chrome is not running on the host, so that route is
unavailable until it is started.

### Interim board 3 - 2026-08-28

**Every readable item is read on a real client, and seven of the eight pass.** This session drove the
Discord web client directly through the browser-automation surface rather than relaying screenshots,
so each reading below is a first-hand observation of the rendered thread.

Item 1, a multi-message chatter body of 80 short lines, passes: every body line draws small and grey
across all three messages, the header repeats at full size on each, and no line goes full size at a
split seam.

Item 2, inline code inside a subtext line, passes, and the recorded answer is that the code renders
rather than degrading. Single backticks survive the escape chain and Discord draws inline code chips
inside a subtext line; the chips are still small, so the register holds.

Item 3, a body carrying a triple-backtick fence, passes. The delimiters draw as literal characters,
small and grey, and no code block opens.

Item 4, the oversized spoilered form, passes on all four of its checks. Nothing sits outside the
spoiler but the header and one small grey teaser line. The body is concealed until tapped. A tapped
spoiler reveals the body at full size, which is the register contract's own named departure rather
than a failure. And the composition the security model listed as unread is now read: a peer's own
pipe pair draws as ordinary pipe characters, opening neither a nested spoiler nor a table row, and a
table-shaped line does the same. The trailing backslash payload arrived and drew intact, so the
Section 2 backslash fix is confirmed in the wild rather than only in tests.

Item 6 reproduces its failure exactly on the pre-fix broker, which is the binary that was still live
at reading time: the subtext-marker line draws small and grey, and both heading-marker lines draw as
large bold headings. The fix in 8d73126 is not yet re-confirmed live, because reading it requires the
broker to be out of brief mode.

Item 7, the attribution glyph and a tilde fence, passes, and it corrects a prediction this plan
carried. The glyph draws clean with no visible backslash, since Discord consumes the escape, so the
guard costs nothing visible here. The forged header attempt does not read as a real message header,
and the tilde fence draws as literal tildes with no code block.

Item 8 passes in both halves, and its second half needed no operator typing after all. A peer's
line-leading quote markers draw as literal characters with no quote bar. The operator's own typed
lines, already present in the thread, draw a real quote bar at full size under the console label. The
operator's voice is therefore visually distinct from anything a peer can produce.

**A diagnosis this session got wrong and corrected.** Chrome was reported unavailable on the evidence
that no process named chrome.exe was running. That probe was wrong: a Chromium-based browser under a
different executable name was running the extension the whole time. Browser availability is read from
the extension's own connected-browsers listing, never from a process-name match.

**Documentation changed.** The security model's unobserved-composition list is now empty and the
paragraph states the three compositions as read. The one remaining unobserved rule named in that
document is Discord's behaviour on a doubled subtext marker, which is a different question and stays
as written.

Item 5, brief mode, passes. A three-sentence inbound peer message draws as one message carrying the
full-size header and exactly one small grey line, the payload's first line; the remaining two lines are
dropped rather than wrapped or truncated mid-sentence.

**Next actions.** Brief mode is removed from broker.env and the pre-item-5 file is restored, so one
elevated broker restart is all that stands between here and the item 6 re-confirmation, which is the
last reading Section 4 needs. Then Section 4 closes and the whole-effort finishing pass runs.

### Chapter 4 - 2026-08-28
Completed: Section 4: Live verification

**All eight payloads are read on a real Discord client and all eight pass.** The readings were taken
first-hand through the Discord web client rather than relayed as screenshots, which is what let the
check follow its own evidence rather than only the questions framed in advance.

Items 1, 2, 3, 4, 5, 7 and 8 passed on their first reading and are recorded item by item in Interim
board 3. Item 6 failed, was fixed, and now passes in both directions on the fixed broker: a peer
line opening with a subtext marker and lines opening with first- and second-level heading markers
all draw small and grey, as literal characters, with no heading anywhere and no visible backslash.
The fix is a line-leading heading escape routed through a shared per-piece helper so the two chatter
forms cannot drift apart.

**Two recorded answers that were open questions.** Inline code inside a subtext line renders as code
chips rather than degrading to literal backticks, and the chips are small, so the register holds
either way and the recorded answer is that it renders. Discord consumes a marker escape rather than
drawing it, for the attribution glyph, the subtext hyphen and the heading hash alike, so the guards
this plan added cost no visible backslash on any surface it checked. The plan had predicted a
visible backslash as the honest cost of blocking forged headers; that prediction was wrong in the
project's favour and is corrected wherever it appeared.

**Decisions and surprises.**

The register contract's departure for a tapped spoiler is load-bearing rather than decorative. A
revealed spoiler body draws at full size, so the contract holds only because the collapsed reading
is the one it speaks about. Reading item 4 without tapping would have recorded a pass on a strictly
weaker question than the one the security model rested on.

The security model's unobserved-composition list is now empty. An escaped pipe inside a spoiler
draws as an ordinary pipe character, opening neither a nested spoiler nor a table row, which was the
last composition the register rested on unread. The one rule that document still names as
unobserved is Discord's behaviour on a doubled subtext marker, a different question left as written.

The operator half of the register comparison needed no operator action. Operator-typed lines already
in the thread draw a real quote bar at full size under the console label, while a peer's own quote
markers draw as literal characters with no bar, so the operator's voice is visually distinct from
anything a peer can compose.

**A transport finding this section surfaced, outside its own scope.** The broker's transcript tailer
skips to a session's current end whenever that session's transcript outgrows one pass, and anything
sitting in the skipped window is never relayed. It fired eight times against this session, whose
transcript grows unusually fast because browser screenshots ride in it, and it silently dropped two
peer payloads. The inbound leg of the item 6 reading was taken in the sibling seat's thread instead,
where the same renderer draws the same message without this session's transcript in the path. This
is a transport property rather than a rendering one and it is recorded to memory; it is not a defect
this plan fixes, and nothing in the peer-chatter register depends on it.

**Local state altered and restored.** `broker.env` carried `CHANNEL_PEER_MESSAGES=brief` for the
item 5 reading and is restored from its pre-item-5 copy. The spare copies beside it are removed.

Next: Section 4 was the last section. The whole-effort finishing pass follows.

### Interim board 4 - 2026-08-28

**The finishing review round found two critical defects, and the plan does not close on this round.**
Four fresh-context agents ran over the whole changeset (base `fc7be96`): QA verification, adversarial
review, blind diff-only review, and security review. Every finding below was re-confirmed here by
driving the shipped renderer, rather than accepted from a report.

**Critical 1: a peer can forge this renderer's own attribution line.** `withoutAttributions` runs in
`chattered`'s escape chain, which executes before the line wrap, and it matches line-leading only. A
peer that places an attribution glyph mid-line at the wrap boundary gets it carried to the start of a
drawn piece with no escape. In the spoilered form there is no subtext marker in front of it, so on a
tapped-open body it draws at reading size and reads as a genuine header. Reproduced on a single-line
2,220 code point body: the drawn line is the spoiler opener followed immediately by the peer's own
`glyph **Claude** -> Fable`. This falsifies the unforgeability claim the security model states in the
present tense, so it is a defect by this project's own honesty rule rather than a documentation gap.
The adversarial and security reviewers found it independently, which is worth recording: it is the
exact argument this effort used to move the subtext and heading guards into a per-drawn-piece helper,
applied to every marker except this one.

**Critical 2: one character makes a peer message disappear.** In `firstLine`, `newlinesOnly` runs
inside the trim rather than in front of it, so a body opening with U+0085 has that break converted to
a newline the trim can no longer remove and the first line reads empty. In brief mode the render
returns no messages at all and the delivery is dropped with a log line saying it carried no visible
text, which is false. Reproduced directly: the same body renders one message without the leading
character and none with it. The oversized form loses its teaser the same way, leaving a header over a
collapsed spoiler with nothing saying what it conceals.

**Also confirmed, and carried into the fix round.** The heading and subtext guards this effort added
tolerate only space and tab before the marker, so a non-ASCII space slips past them, which is the
same narrow-whitespace-class shape Section 2 already fixed once. The marked form can post a message
that is an attribution and nothing else, which three doc blocks say cannot happen. Several comments
and one security model paragraph still carry the visible-backslash prediction the live check
falsified. Two path-level pins assert a marker on every body line, an invariant the oversized form
deliberately violates and which holds only because both fixtures sit under the threshold.

**What the round did not shake.** The register contract itself held under both reviewers' fuzzing: no
unmarked non-blank line outside a spoiler, no message over the length cap, no ping reachable, the
splitter's hard cut unreachable on both chatter paths, and the operator-attributed quoted block
uncomposable from a peer body. QA reported the build clean and the suite at 1569/1568/0/1, exit 0,
matching the expected count with no new failures.

**One QA finding is already repaired.** The security model still stated the operator quoted block's
discriminator as unread. It is read: the block opens with a triple quote marker, which draws a real
quote bar at reading size, while a plain single marker draws as the character itself, which is why
the block uses the triple form. That paragraph now states the confirmed fact.

**Next actions.** A fix round for the two criticals and the confirmed majors, each with a regression
pin watched failing first, then the reviewers re-run over the result. Section 4's live readings are
unaffected: none of these defects touches a composition the eight items exercised.

### Interim board 5 - 2026-08-28

**The finishing re-review round is back, one Critical survives it, and the plan does not close on this
round either.** The fix round for Interim board 4's two Criticals is verified and holds; a third
defect, of the same class as the two before it, is now the only thing between here and the close.

**Stage.** Sections 1-4 remain closed and pushed. The fix round for Interim board 4 sits uncommitted
in four files and is confirmed good in both directions. The whole gate has not been run over it. One
Critical is open and turns on a fact nobody has read.

**Live dispatches.** None. Three returned this round: `security-reviewer` (fable, 8m43s) verdict
CLEAR; `adversarial-reviewer` (fable, 12m09s) verdict CHANGES_REQUIRED; `consultant` (fable, 3m57s)
status RULED. The round was bracketed with `git status --porcelain` before and after and the two
readings are identical, so the read-only briefs held. Both reviewer dispatches were read for
substitution: the security dispatch's resolved-model distribution is 50 of 50 assistant turns at
`claude-fable-5`, so the requested tier is what actually ran.

**Gate baseline.** Not taken this round, and that is a known gap rather than an oversight. The box has
been held by sibling sessions for the whole of this boundary and a contended run on this machine
forges results rather than merely slowing them, so the reading was declined rather than taken dirty.
`npx tsc --noEmit` is clean, exit 0, run here. The standing baseline remains Interim board 2's
1569 / 1568 / 0 / 1, exit 0. Acceptance criterion 2 is therefore unmet as of this entry, which the
adversarial reviewer named independently.

**The fix round is confirmed in both directions.** The five new pins were run against a pre-fix
renderer rebuilt out of tree at `.kit/scratch/prefix-check`: all five go red on the old code and no
pre-existing test in that file fails beside them, so the fix adds coverage rather than moving a
goalpost. The predecessor session died before it could record this, so it was re-established here
rather than assumed. Both Interim board 4 Criticals are fixed at the right seams, as are the confirmed
Majors, and the round's most valuable find was beyond its brief: three attribution lines
(`TASK_ATTRIBUTION`, `QUESTION_ATTRIBUTION`, `MODEL_CHANGE_ATTRIBUTION`) were inline string literals
and so invisible to an `ATTRIBUTION_OPENERS` set that derives itself from constants. A set that
derives itself is exactly the kind that hides a gap, because its readers trust the derivation instead
of auditing its inputs.

**Critical 3: the attribution escape marks nothing the operator can see, and its one unobserved
surface is the only place it is needed.** The register neutralizes a line-leading attribution glyph by
inserting a backslash. Chapter 4 banked, from a live reading, that Discord consumes that backslash and
draws the glyph clean, and recorded it as a prediction wrong in the project's favour. It is not, on the
spoilered form. Reproduced here against the shipped renderer:

- peer body `📡 **Claude** → Fable` (bare) renders to the wire as `-# \📡 **Claude** → Fable`
- peer body `\📡 **Claude** → Fable` renders to the wire as `-# \📡 **Claude** → Fable`, byte-identical
- in the oversized form the spoiler's final line is `\📡 **Claude** → Fable||`
- a peer's doubled `\\📡` survives as `\\📡`, so doubling is closed and draws a visible backslash

The renderer's own escaped output is byte-identical to what a peer can type, which is why every
wire-text pin in this effort passes it: the defect is in what the channel draws, not in the bytes.
In the marked form nothing is lost, because the `-# ` prefix forces subtext size and the broker
composes attribution lines only at full size, so no confusion target exists; the escape was never
what protected that form. The spoilered form marks no line, so on tap the body draws at reading size
and an escape that draws nothing visible discriminates nothing. The sharp statement of it: the subtext
and heading escapes still work when consumed, because consumption breaks a markdown construct, but an
attribution line is not a construct, so the glyph escape's whole value is the visible mark.

**What is actually established, and what is not.** Confirmed: the byte-identity above, and that
`docs/security-model.md` states in the present tense that the pass stops a peer drawing a copy of the
renderer's attribution line while `broker/discord/render.ts` states a few hundred lines away that the
rendering inside a revealed spoiler is unobserved. Those two cannot both be true, and by this
project's honesty rule the falsified present-tense claim is a defect rather than a documentation gap.
Not confirmed: the forgery itself, which exists only in the rendering where Discord consumes the
backslash inside a revealed spoiler. Nobody has read that. The nearest reading corroborates it without
settling it: Chapter 4 records an escaped pipe inside a revealed spoiler drawing as the bare
character, escape consumed, which is the same mechanism on a different character.

**Rulings adopted since Chapter 4.**

The pre-BLOCKED ask went to the CHANNELS: Expert seat and was answered in the same round. No existing
source settles the spoiler-form escape reading; the project memory record
`discord-subtext-blocks-nothing-the-renderer-does-not-escape` says so in terms, closing that how the
escapes draw inside the spoilered form is not observed. No source records the escape as
intended-visible there. The seat's own reading, as the steward of this spec, is that scoping the
security model's unforgeability claim to the collapsed reading aligns it with the register contract as
written rather than changing the spec. Each cited source was re-checked here before being acted on.

The consult ruled and corrected this session's framing on one point that changed the plan of action:
the byte-identity is the precondition rather than the forgery, so writing the residual paragraph
without the live reading would replace one unverified rendering claim with another. Its ruling is to
take the reading first, then ship the wording that reading dictates. It rejected outright the
candidate fix of marking the glyph with an invisible character: peer bodies are stripped of invisibles
so the mark would be unforgeable in bytes, but the two renderings stay pixel-identical, so it would
buy a wire-level pin asserting neutralization while the operator-facing forgery stood untouched. That
is the false-green shape this project's testing discipline exists to refuse, and it is recorded here
so it is not re-proposed.

The register contract's departure for a tapped spoiler is a grant from the type-size promise family;
the unforgeability claim belongs to the authorship family and the document states it unconditionally.
The tap licenses peer prose at reading size. Whether the operator also accepts that it admits a forged
attribution line at reading size is recorded in no artifact, and that gap is his to close.

**Next actions.** One live reading on a real client: an oversized peer body carrying a line-leading
attribution glyph, tapped open, read for whether the backslash draws or is consumed, and for whether
the revealed region carries a background tint that discriminates it independently. It runs in the
sibling seat's thread rather than this one, per Chapter 4's transport finding that this session's
transcript growth makes the broker's tailer drop payloads. If the backslash draws, there is no forgery
and the repair is retiring three "not observed" comments and one security-model sentence. If it is
consumed, the unforgeability claim is scoped to the collapsed reading, the residual is recorded in the
masked-link class, and the fork goes to the operator. Then the whole gate, then the close.

### Interim board 6 - 2026-08-28

**The re-review round's findings are all addressed, the whole gate is queued rather than run, and the
plan stops here on an operator dependency.** Every defect Interim board 5 left open is closed except
Critical 3, which cannot be closed from this seat at all: it turns on a rendering nobody has read, and
the surface that would read it is gone.

**Stage.** Sections 1-4 remain closed and pushed. The fix round now sits uncommitted in four files
with the adversarial reviewer's surviving Major fixed and all five Minors adjudicated. The whole gate
is owed and is the last item; it is queued behind a sibling session rather than blocked.

**Live dispatches.** None, and none this round. The work here was inline: it was adjudication and
repair of an existing round's findings, not new implementation.

**Gate baseline.** The targeted lane is green on the final state, run here: `render.test.ts` 178/178
exit 0, `outbound.test.ts` 145/145 exit 0, `npx tsc --noEmit` clean exit 0. The whole gate is not run.
The standing baseline remains Interim board 2's 1569 / 1568 / 0 / 1, exit 0, and acceptance criterion
2 stays unmet until a whole-gate reading is taken against it. This is a queue rather than a refusal:
the box is held by a sibling session, this machine's coordinator seat has recorded the slot and the
expected shape, and the run is one command once the slot lands.

**The surviving Major is fixed, and the fix was earned in both directions.** The marked-form half of
"an attribution the wrap carries to the start of a drawn piece is neutralized there" asserted an
absence on a body the guard never touched. Confirmed by reading, not by argument: on the shipped
fixture the renderer emitted zero escaped glyphs, so the assertion passed because nothing had happened
rather than because the guard had held. The glyph sat at unit 1,100 of a 1,221-unit body while the
wrap falls at 1,200, so the cut landed inside the trailing run and the glyph was never delivered to a
piece start. Both halves of the test now build their fixture from `MAX_PEER_SUBTEXT_LINE_LENGTH`
rather than from its value, which is the root fix rather than the symptom: a literal is silently one
unit short again the moment the bound is retuned, which is exactly how this went vacuous. Watched
failing first against an out-of-tree renderer with the attribution guard removed, and the marked half
was isolated and watched failing on its own, because the oversized half was already non-vacuous and
would otherwise have supplied the red.

**Five Minors adjudicated, three fixed, one accepted with its reasoning recorded, one fixed as an
overclaim.**

The two fixtures this effort added carried raw invisible characters in source (U+0085, U+2028, U+2029;
U+00A0, U+2000, U+3000) and now spell them as `\u` escapes. A raw invisible in source survives only as
long as nothing normalizes it, and a fixture whose character an editor silently rewrites stops testing
the thing it is named for while still passing. The pre-existing U+2026 and U+200B occurrences
elsewhere in both files are outside this changeset and were left alone.

The glyph-class Minor was the round's second instance of one class and so took the recurrence rule's
generator fix rather than a patch. `attributionOpeningLines` carries its own hand-written glyph class,
and the test driving the three notice renderers asserted only an absence through it, so a notice
opening with a glyph that class does not know would return no lines whether the renderer escaped it or
not, and the silence would read exactly like a pass. That is the same shape as the defect this round
already found once, where three attribution lines written as inline literals were invisible to a set
that derives itself from constants. The test now runs the oracle against a raw line first and requires
it to speak, so a glyph the class cannot see is reported as a gap in the test rather than hidden
behind the assertion it would otherwise have made vacuous. Its name was narrowed in the same edit:
it claimed every line this renderer opens with a glyph and covers the three notices, not the card
glyphs, which are not attribution openers in the implementation either.

`atReadingSize`'s raw `||` parity reading is accepted rather than rewritten. Its conservative
direction treats any delimiter-bearing line as concealed, which is safe only because a peer's own
pipes are escaped before they are drawn, and that premise is pinned independently in `render.test.ts`
by "a body dense with pipes cannot close a spoiler early, and the pairs stay the renderer's own". That
is one claim pinned once rather than two oracles reading the same structure two ways, which is the
arrangement this plan's Design warns against. The doc block now names the pin, so the reasoning is
checkable from the helper rather than resting on an assertion about the pipeline made locally.

`subtexted`'s doc block claimed that emptying a whitespace-only drawn piece leaves the peer's
paragraphing unchanged. Probed rather than argued, and the claim is false in exactly the case the
same block sets up two sentences earlier: where the wrap produced the piece, a source line of
bound-wide indent followed by content reaches the operator as an empty line above that content, so the
peer wrote two lines and the renderer drew three. The block now states the bound exactly and records
the trade, which is deliberate: the alternative is the whitespace-only piece surviving as the whole
buffer of a message and posting an attribution with nothing under it.

**Critical 3 is unchanged and is now the blocker, because the instrument that would settle it is
gone.** The reading it needs is a real Discord client: one oversized peer body carrying a line-leading
attribution glyph, tapped open, read for whether the backslash draws or is consumed. Section 4 took
its eight readings by driving the Discord web client directly from this session. That route is
unavailable now. The extension's connected-browsers listing returns empty, and only embedded
`msedgewebview2` processes are running with no browsing surface among them. The listing is the
authoritative reading here rather than a process-name match, which is the correction Interim board 3
recorded against this session's own earlier mistake. So the reading is an operator dependency, which
is the completion contract's external-dependency shape and goes up rather than being ruled on.

The pre-BLOCKED route is already discharged for this Critical and is not re-run: Interim board 5
records the expert ask answered in the same round and the consult ruled, and the consult's ruling is
what makes the reading the next action rather than the wording. Nothing since has changed the
question.

**A reported claim carried for the gate reading, marked as reported because it is not checkable from
here.** This machine's coordinator seat reports that AI-OS: Worker's contended run failed a
fixed-delay race that reported `Expected: 1, Actual: 0` in 767ms. If that holds, a contended red need
not be slow: it can be fast and wear an ordinary assertion failure's costume. That is another repo's
test on another session's surface and is unverifiable from this seat, so it is recorded as reported
rather than banked. It bears on this plan only as a caution when the whole gate is finally read: an
unexpected red is not to be cleared on the grounds that it failed too quickly to be contention.

**Memory banked.** One project-tier record written this boundary,
`a-guard-on-what-a-channel-draws-cannot-be-tested-in-code`: a test suite sees only what the code
emits, never what the channel draws, so a guard whose whole value is a visible mark has no in-code
oracle and needs a live reading as its gate. It carries the classifier that makes it actionable, that
an escape breaking a markdown construct still works when the channel consumes the backslash while one
whose only effect is a visible character does not, and it names the invisible-marker false-green fix
so it is refused rather than re-proposed. Written one level more general than this incident on
purpose: the lesson is about the class of guard, not about the attribution glyph.

**Next actions.** The whole gate on the box slot when this machine's coordinator grants it, read
against the 1569 / 1568 / 0 / 1 baseline and against the wall clock, since 41 to 50 seconds is this
box uncontended and 88 seconds is this box under load. Then the operator's reading of Critical 3, and
the wording that reading dictates: if the backslash draws, three "not observed" comments and one
security-model sentence retire; if it is consumed, the unforgeability claim is scoped to the collapsed
reading and the residual is recorded in the masked-link class. Then the close. The fix round stays
uncommitted until the gate runs over it, and a copy of the diff is kept in gitignored scratch so a
crash costs the worktree rather than the work.

### Chapter 5 - 2026-08-28
Completed: the whole-effort finishing pass
Implemented By: main session, with three fresh-context reviewers and one consult across two finishing
rounds (recorded in Interim boards 4 and 5) and the repair round in Interim board 6
Metrics: review rounds 2; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises: the finishing pass took three rounds rather than one, and each round's
Criticals were the same class arriving at a new site: a claim about what Discord draws, resting on a
reading nobody had taken. The last of them did not close by engineering and was not meant to. The
operator settled it by deciding to close on the desktop readings, and supplied in the same breath the
fact that had been missing all along, that he had watched the same payloads on his phone and could
see no rendering difference between the two surfaces.

That decision resolves acceptance criterion 4, which had quietly gone unmet and which nobody had
noticed until this boundary. The criterion names the operator's phone, and the record shows the phone
set was item 1, item 4 in its collapsed state, and item 6's failure, while items 2, 3, 5, 7, 8 and
item 4's tapped reading were taken by this session in the Discord web client. Chapter 4 says all
eight were read and says the readings were taken through the web client; both statements are true and
the criterion fell between them when the section changed instrument mid-run. That is the transferable
finding: when a live check switches instrument, the acceptance line is the artifact most likely to be
left behind, because it was written before anyone knew which instrument would be used. The criterion
is met on the operator's own testimony rather than by re-reading, and it is recorded that way rather
than as though it had been satisfied at the time.

Critical 3 closes as an accepted residual rather than a fix, and the distinction is written into both
the code and the security model. The attribution escape inserts a backslash Discord consumes, so it
draws nothing a reader can see. In the collapsed reading that costs nothing, because every drawn body
line carries the subtext marker and type size is what discriminates a peer's line from a
broker-composed attribution. Inside a spoiler a tap has revealed, no line is marked, the body draws at
reading size, and a consumed escape discriminates nothing. So the register's authorship promise is
now stated as a promise about the collapsed reading, and the residual, a peer composing a line shaped
like this renderer's attribution inside a body the operator has opened, is recorded beside the masked
link in `docs/security-model.md`, bounded by the tap and by what such a line cannot draw: no mention
pill, no timestamp chip, no quote bar, and no permission grant.

What is deliberately not claimed is that anyone read it. The glyph inside a revealed spoiler is
unread on both surfaces. What is read there is the same mechanism on a different character, an
escaped pipe drawing as the bare character with the backslash consumed, and the document says the
glyph case is inferred from that rather than observed. A later reading finding the backslash visible
inside a revealed spoiler would widen the promise rather than break it, which is the property that
makes the scoped wording safe to ship ahead of the reading.

The consult's ruling was adopted in full and one candidate fix stays refused on its record: marking
the glyph with an invisible character would be unforgeable in bytes, because peer bodies are stripped
of invisibles, and would leave the two renderings pixel-identical. It buys a wire-level pin asserting
neutralization while the operator-facing question stands untouched, which is the false-green shape
this project's testing discipline exists to refuse.
Assumptions: none beyond the spec. The one judgment made without the operator is the wording of the
scoped claim itself, which he authorized by directing the close on the desktop readings.
Review Findings: across the two finishing rounds, three Criticals and their confirmed Majors were
addressed and re-verified here rather than accepted from a report. This boundary closed the last
surviving Major and all five Minors. The Major was a test asserting an absence on a body its guard
never touched: its glyph sat a hundred units short of the wrap bound, so the cut fell inside the
trailing run and the renderer emitted zero escaped glyphs, which was measured rather than argued.
Both halves of that test now build their fixture from `MAX_PEER_SUBTEXT_LINE_LENGTH` rather than its
value, which is the fix that survives a retune, and it was watched failing against an out-of-tree
renderer with the guard removed, the marked half isolated so the oversized half could not supply the
red. Of the Minors, the glyph-class one took the recurrence rule's generator fix: the pin over the
notice glyphs asserted only an absence through an oracle carrying its own hand-written glyph class,
so a glyph that class did not know would have read as a pass whether the renderer escaped it or not,
and it now runs the oracle against a raw line and requires it to speak before trusting its silence.
Two fixtures carrying raw invisible characters now spell them as escapes. One Minor was accepted
rather than rewritten, `atReadingSize`'s conservative pipe reading, with the pin its premise rests on
named in the doc block so the claim is checkable where it is made. One was an overclaiming doc block,
probed rather than argued and found false in exactly the case the same block sets up two sentences
earlier.
Stamps: adjudicated 7, stamped 1. The sweep over the boundary's window surfaced one project-tier and
six operator-tier records read but not applied. The one stamped is
`discord-subtext-blocks-nothing-the-renderer-does-not-escape`, which is the record that closed the
expert ask by stating in terms that how the escapes draw inside the spoilered form is not observed,
and so steered the whole disposition of Critical 3. The six operator-tier hits are skipped with
reason: four belong to another project's Roslyn and build work and never touched this, one names a
bot contributor identity nothing here used, and one concerns a model override, where this boundary
dispatched nothing. One project-tier memory was written rather than only read,
`a-guard-on-what-a-channel-draws-cannot-be-tested-in-code`, banking the class rather than the
incident: a test suite sees only what the code emits and never what the channel draws, so a guard
whose whole value is a visible mark has no in-code oracle and needs a live reading as its gate, with
the classifier that separates an escape breaking a markdown construct from one whose only effect is
a visible character, and with the invisible-marker false green named so it is refused rather than
re-proposed.
Gate: whole gate 1574 tests / 1573 pass / 0 fail / 1 skip, exit 0 read from the run's own marker
file, 53.6s, bracketed 08:02:10Z to 08:03:05Z, against Interim board 2's baseline of 1569 / 1568 /
0 / 1, exit 0. Delta is +5 tests, all green, with no failing name on either side, so the comparison
is by name and not by count alone. The +5 is the fix round's five pins, written before this session
and never before run inside a whole gate. The one skip is test 238, the POSIX-only token-file guard
the test emits on Windows, the same skip every gate in this plan has carried. `npx tsc --noEmit`
clean. Contention row: no foreign engine-class load, three foreign in-process agents, poll-verified
for the engine class only, and that is a coordinator reading rather than one taken here. The wall
clock is reported as lightly loaded rather than clean: this box's uncontended band is 41 to 50
seconds across three runs, and 53.6 sits above it, which is the honest reading of a number that never
approached the 88-second contention signal. The close edits after that run are a doc block in
`broker/discord/render.ts` and prose in `docs/security-model.md`; the render change is comment-only,
verified by a diff carrying no non-comment line, so the executable code the whole gate ran over is
the code that ships, and the targeted lane was re-run over it at 178/178 exit 0 with `tsc` clean.
Next: none. Every section is closed and the effort is complete.
Commit Model: Commit-and-Push
