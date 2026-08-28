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
