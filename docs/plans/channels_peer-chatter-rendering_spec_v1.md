# Peer-Chatter Rendering: Subtext for Session-to-Session Traffic

Status: In Progress (armed 2026-08-27; see Dispatch Authorization)
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
   arriving as raw escaped pipes in subtext is the acceptable cost.
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
- The body inside a spoiler: pipeline steps 1-4 as above, then `|` characters additionally
  neutralized (already in `MARKDOWN`'s escape repertoire) so a peer writing `||` cannot close the
  spoiler early and surface full-size text; then wrapped and split so that each posted message's
  body sits wholly inside one `||...||` pair with the header (and teaser) outside it. Spoilers do
  not span messages, so the pair is per message and its four units are counted in that message's
  budget.
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
update the assertions that pin the old rendered shapes. Baseline the suite before the section per
testing discipline, and read the echo-dedup group's flake note in `docs/backlog.md` before calling
any red there a regression.

### Section 2: The oversized spoiler form (Model: opus)

The threshold constant, the pipe neutralization, the teaser line, the per-message spoiler wrapping
with its budget accounting. Tests: the threshold boundary both directions (at the bound, subtext;
past it, spoilered); no peer-authored text outside a spoiler beyond the teaser; the teaser is
prefixed and bounded; the spoiler's content carries no `-# ` prefix, pinned as the deliberate skip
the Design names rather than left readable as an omission; every message's spoiler pair closes within that message; a body dense with
`|` characters cannot close a spoiler early (pin the escape, and pin that the assembled message
carries balanced renderer-composed delimiters).

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

SCOTT is this machine's hostname, the host whose broker serves the operator's relay threads; the
deployed checkout is `D:\sapplefeld-channels`, distinct from this development tree. Restart the
broker onto the built code with `install\Repair-Broker.ps1 -Pull` from an elevated prompt
(`docs/operations.md` owns the procedure; the broker has no health route, so liveness is
`GET /sessions`). Then the worker composes and drives the five payloads below itself, a real
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

Item 4 failing routes to the operator with the evidence (the fallback named in Design). Any other
item failing reopens its section.

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

None yet. The first chapter lands when the first section ships.
