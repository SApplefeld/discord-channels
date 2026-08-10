# Channels: the fleet card's per-account layout

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: fable-tier reviewer bumps only, dispatched with the explicit override from this
Opus-led session; overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_usage-card_spec_v1.md](../archive/plans/channels_usage-card_spec_v1.md): the round that
  built the fleet card. This round changes only how it is drawn.
- [channels_mirror-fidelity-repairs_spec_v1.md](../archive/plans/channels_mirror-fidelity-repairs_spec_v1.md):
  the round that gave the session status card the heading-plus-fence shape this round copies.

## Goal

The fleet card reads the way the session status card reads. Today it is one fence holding every
account end to end, so three accounts run together as twelve near-identical lines with no visual
boundary, and the operator has to count rows to find where one account stops and the next begins.
The session card solved this already: a heading names a section, a fenced block holds its columns,
and a section with nothing to say is left out. The fleet card takes the same shape, one heading and
one block per account, one more pair for the sessions.

The layout is the operator's, specified against a live screenshot.

## The shape

```
# 📊 Fleet: Usage

### ▶ scott@scottapplefeld.com · 2m ago
5 Hr     2%  resets 4h 23m
7 Day   23%  resets 6d 13h
Fable   23%  resets 6d 13h

### · sapplefeld@gmail.com · 8m ago
5 Hr     0%
7 Day   70%  resets 2d 12h
Fable   96%  resets 2d 12h  (!)
Spend    6%  $95.40 of $1,500

### Sessions
✅ CHNL: Answering · idle · 7h 44m

(^) ahead of pace   (!) at or above 90%
card as of 8m ago
```

Each `###` heading sits outside its fence; each block of rows sits inside one.

## Decisions taken before building (2026-08-09)

**The account label is the full email address.** Chosen over the organization name and over a
positional `Account N`, because it is the only unambiguous identity: two of this operator's three
accounts are `scott@…` and differ only by domain, so a local part or a slot number makes them
indistinguishable at exactly the moment the card is being read to tell them apart. The organization
name loses because nothing confirms these accounts carry one, and the existing fallback chain would
then draw a mix of org names and emails across the card.

The width objection that argued for dropping the email does not survive the new shape: the label is
now a heading outside the fence, where Discord renders it as ordinary text. It cannot push a column,
force a horizontal scroll, or disturb alignment, because width pressure exists only inside a fence.

**The pace reading stays, as an end marker.** It was listed for removal on width grounds, and the
marker column removes that ground. It is the only signal separating 66% on the second day of a week
from 66% on the sixth, and it mirrors claude-swap's own rule, which is why the reader computes it.

**One marker per row, warning winning.** A window at or above the 90% threshold draws `(!)` and
nothing else, even when it is also ahead of pace, which at 100% it almost always is. Two markers on
one row would be the common case rather than the rare one, and a row that can carry either one
marker or two is a row whose end column moves.

## Sections of Work

### 1. The card draws a heading and a block per account

Model: opus

`broker/usage/card.ts`. The composition changes from one fence around everything to a title heading,
then a heading-and-fence pair per account, then a heading-and-fence pair for the sessions, then the
marker legend and the footer as plain lines at the end.

**Row format inside a block**, from the operator's own mock: the window label left-padded to a fixed
width, the percentage right-aligned in a fixed width so the digits stack, two spaces, then the reset
clause or the spend amount, then two spaces and the marker when there is one. Labels are `5 Hr`,
`7 Day`, the scoped model's own name, and `Spend`. A window with no reset time draws its percentage
and stops, which is what the 5-hour window does at zero.

Markers are not padded to a fixed column. They follow the clause after two spaces, so rows whose
clauses are the same width align naturally and no row carries trailing whitespace.

**The legend is drawn only when a marker was drawn**, so a fleet with nothing to warn about does not
carry a permanent key to symbols that are not on the card.

**The security requirement, which the shape changes.** The account label moves from inside a fence to
outside one. Inside, `inertBlockField` was sufficient because a fence renders no markdown and draws
no mention pill. Outside, it is not: a heading is live Discord markdown, so the label must go through
the same neutralization the session card's own title uses, not the block field's. This is the one way
the redesign can be less safe than what it replaces, and it is the thing to get right first. A
crafted address must manufacture no mention, no pill, no heading of its own, and must not close or
open a fence.

Column alignment stays computed so that every account's numbers stand in one column across the whole
card rather than in a column per block, which is the property that lets two accounts be compared by
eye.

Byte determinism is unchanged and load-bearing: the card is edited only when its rendered bytes
change, so the renderer reads no clock and nothing outside its inputs, and two renders of the same
inputs compose the same bytes.

The one-message bound is unchanged, and the per-block budget accounting has to survive the split:
room for the footer, the legend, and the overflow tail is reserved before the first block is
measured, and the overflow tail still names what was dropped rather than ending mid-card.

Acceptance: three accounts render as three headings and three fences with the operator's row format;
the percentages stack in one column across every block; a window with no reset draws no clause; a
window at or above the threshold draws `(!)` and never also `(^)`; a window below it that is ahead of
pace draws `(^)`; the legend appears only when a marker did; the sessions section is its own heading
and fence and is omitted when no session is live; the footer and legend survive a card that ran out
of room; a hostile account label manufactures no mention, pill, heading, or fence in the heading it
now occupies, and no backtick reaches any fenced body; the same inputs render the same bytes twice;
every block stays inside the shared width bound at its worst case.

### 2. A re-install reads what the last one wrote

Model: opus

`install/Install-All.ps1` requires `-HostName`, `-ChannelId` and `-AllowedUserId` on every run,
including a run whose only purpose is to pick up new hooks on a host installed months ago. All
three, and `-Port`, already sit in `broker.env` under allowlisted keys the installer itself wrote:
`CHANNEL_HOST_NAME`, `CHANNEL_DISCORD_CHANNEL`, `CHANNEL_ALLOWED_USER_ID`, `CHANNEL_BROKER_PORT`.
So a re-install retypes values the host already holds, and the Discord IDs are the two nobody
remembers, which makes an upgrade a trip to the Discord console rather than one command.

An argument not supplied falls back to the value in `broker.env`. An argument supplied always wins,
so rebinding a host to a different channel stays exactly what it is today.

The precedent is in this file already: the bot token reuses the hardened token from the last
install rather than re-prompting, for the same reason and with the same shape.

**Reused values are validated rather than trusted.** `ChannelId` and `AllowedUserId` carry a
`ValidatePattern` that PowerShell applies to a bound parameter and to nothing else, so a value read
from a file bypasses it entirely. A hand-edited, truncated, or partially written `broker.env` would
otherwise reach `Install-Host.ps1` and fail there with a message about the wrong thing. Each reused
ID is checked against the same pattern the parameter declares, and a value that fails is reported as
a bad `broker.env` entry naming the key, never silently dropped back to "required".

**Reuse is announced, never silent.** The three values decide which Discord channel a host binds to
and whose account is allowed to steer it, so an install that picked them up from disk says so, one
line per reused value. An operator who ran the command in the wrong checkout should see the wrong
host name go by rather than discover it afterward.

The first install on a fresh host is unchanged: no `broker.env` exists, nothing is found, and the
existing error still names the three arguments and points at the docs.

Acceptance: with all three in `broker.env`, `Install-All.ps1` with no identity arguments proceeds
and reports each reused value; an explicitly supplied argument overrides the file on every one of
the four; a missing `broker.env` still throws the existing message naming all three; a `broker.env`
carrying a malformed channel or user ID throws naming the key and the file rather than proceeding or
reporting the argument as absent; a `broker.env` holding only some of the three reuses those and
throws for the rest. Tests drive a real temp env file, the way the existing installer tests do.

### 3. The docs describe the card that ships

Model: opus
Locus: inline

`docs/operations.md` describes the fleet card's sections; that description is the shape being
replaced. It gains the per-account heading-and-block shape, what the two markers mean, and the fact
that the legend appears only when a marker is on the card. `docs/architecture.md`'s account of what
the cards are made of gains the one new fact: a fleet card heading carries untrusted text outside a
fence, so it takes the title's neutralization rather than the block field's.

`docs/install.md` carries the install command with its three arguments, and `docs/operations.md`
covers upgrading a host. Both gain Section 2's rule: the identity arguments are needed on a first
install and are read from `broker.env` on every one after it.

Acceptance: all three documents describe the shipped shape, none describes the single-fence card,
and the install and upgrade paths agree on when the identity arguments are required.

### 4. Every window draws a bar

Model: opus

Specified by the operator against the shipped card, whose numbers he reports having to read and
convert rather than take in at a glance. Four changes to the row, one to the section labels.

**A bar leads the row.** A fixed area of 15 cells, filled left to right with `—` (U+2014), one cell
per 100/15 of a percent, rounded to nearest. The unfilled remainder is blank, so the columns after
the bar stand still whatever the value is. A window at any nonzero percentage draws at least one
cell, which round-to-nearest alone would not give: below 3.3% it would round to an empty bar, and a
bar identical to zero on a window that is not zero is the one reading this section exists to prevent.
The cells are measured off the percentage as the card draws it, so the bar and the number beside it
cannot disagree; the floor alone reads the raw percentage, so a trace that rounds to `0%` still
draws its one cell, which is the only way the operator can tell a trace from a true zero.

**The row's geometry**, measured off the operator's own mock so the columns are his:

```
5 Hr   ———————————————  100%  3h 23m (!)
7 Day  ————————          50%  2d 15h (^)
Fable  —                  5%  2d 15h
Spend  —                  6%  $15.40
```

The label sits in the computed label column followed by one space; the bar occupies its 15 cells;
the percentage is right-aligned in 6, which is what puts every `%` on one column; then two spaces
and the reset clause when there is one, then one space and the marker when there is one.

**The word `resets` is dropped**, and the spend drops its limit: the row carries the amount alone.
The bar is what says how far along the window is, so the word and the ceiling are both saying again
what the row already shows, and the space they cost is what the bar needs. An amount of a thousand
and up is drawn whole, and one below it keeps its cents: cents carry no decision at four figures,
and the columns they cost are what lets a marked spend stand inside the width bound.

**The legend keys off the lines as drawn**, not off the markers earned alone: a row whose marker was
cut by the width backstop cannot leave the legend orphaned, and a cache string that merely reads as
a marker cannot summon it, because both conditions must hold at once.

**Section labels become bold lines rather than headings.** Discord adds its own margin above a
heading and around a code block, and at one account per block that margin is paid three or four
times down the card, which is the loose spacing the operator is reading as wasted. `###` is already
Discord's smallest heading, so the only remaining lever is dropping out of heading rank entirely.
Bold paragraph text carries no margin. The card's own title keeps both of its lines: the plain first
line Discord draws inline beside the bot's name, and the `#` heading under it.

The bar's glyph is one named constant. U+2014 is a typographic character rather than a box-drawing
one, so whether consecutive ones tile without gaps is a property of the reader's font, and only a
real phone settles it; `─` (U+2500) is the swap if they do not.

Acceptance: a window draws a bar whose filled cells are its percentage rounded to nearest of 15,
blank to the right; any nonzero percentage draws at least one cell and zero draws none; every
percentage in a block ends on one column whatever its bar; no row carries the word `resets`; a spend
row carries its amount without a limit, whole at a thousand and up and with cents below it; a
section label is a bold line and no `###` heading remains on the card; the title still carries both
of its lines; every row stays inside the shared width bound at its worst case, a marked spend under
the widest label column included; the legend appears only when a drawn line ends in a marker, so a
cut row takes the legend down with the marker it lost and a cache string that reads as a marker
cannot summon it; a hostile label still manufactures nothing in the bold line it now occupies, which
is live markdown exactly as the heading was; the same inputs still render the same bytes twice.

## Chapters

### Chapter 1 - 2026-08-09
Completed: 1. The card draws a heading and a block per account
Implemented By: unrecorded (reconstructed from git; the executing session wrote no Chapter)
Metrics: unrecorded
Decisions / Surprises: reconstructed after the fact: the section landed as commit 037b859 with the
per-account heading-and-fence shape, the marker pair, the conditional legend, and the inertField
neutralization on the heading. Review metrics for this section were never recorded.
Review Findings: unrecorded
Stamps: unrecorded
Next: 2. A re-install reads what the last one wrote
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-09
Completed: 2. A re-install reads what the last one wrote
Implemented By: unrecorded (reconstructed from git; the executing session wrote no Chapter)
Metrics: unrecorded
Decisions / Surprises: reconstructed after the fact: the section landed as commit 03916e8, with the
spec text for it left uncommitted in the worktree, which is how a later session found code on origin
whose spec section existed only locally. Review metrics were never recorded.
Review Findings: unrecorded
Stamps: unrecorded
Next: 4. Every window draws a bar (run before section 3, so the docs describe the final shape once)
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-10
Completed: 4. Every window draws a bar
Implemented By: implementer-opus (one implementation round plus one review-fix round, same agent)
Metrics: 1 review round (adversarial + blind at fable, security at default); NEEDS_CONTEXT 0;
escalations 0; advisor off
Decisions / Surprises: Sections 3 and 4 were deliberately reordered: section 4 changes the shape
section 3 documents, so the bars shipped first and the docs pass runs once against the final card.
The bar takes two percentages: cells measured off the drawn value so bar and number agree, the
one-cell floor off the raw value so a trace that rounds to 0% still shows (the adversarial Critical,
resolved by synthesis rather than by either side winning). Spend amounts drop cents at a thousand
and up so a marked spend fits the width bound. The legend gates on earned markers AND a drawn line
ending in one: the conjunction exists because a currency code is untrusted text at end-of-line and
could otherwise summon the legend, while a cut row could otherwise orphan it; the residual gap (an
earned marker cut on one row while another row's currency code fakes one) was judged too narrow for
machinery. A marker with no clause draws after one space, per the spec's per-part rule. A negative
spend draws symbol-before-sign ($-13,440); pre-existing composition, now pinned by a test. The
U+2014 bar glyph's tiling is font-dependent and only a real phone settles it; U+2500 is the named
swap, one constant (BAR_GLYPH in broker/usage/card.ts).
Review Findings: Critical (sub-0.5% band drew an empty bar against the spec's floor sentence) fixed.
Major (long spend amount cut by the width backstop, eating money or the marker while the legend
still drew) fixed via the cents rule, the drawn-line legend gate, and a widened worst-case test.
Minors fixed: PCT_WIDTH exported and imported by the test instead of a restated literal; the
index.test.ts wiring regex tightened so 146% cannot satisfy it. Security review CLEAR; its two
out-of-diff observations (U+0085 survives visible(), U+061C missing from the invisible class) are
held as found work for a separate commit. Blind reviewer's note that only a real client settles the
bar glyph's tiling stands as the operator's verification step.
Stamps: none surfaced (memq unstamped --since 1d returned zero on both tiers)
Next: 3. The docs describe the card that ships
Commit Model: Commit-and-Push
