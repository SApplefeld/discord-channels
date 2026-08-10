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

### 2. The docs describe the card that ships

Model: opus

`docs/operations.md` describes the fleet card's sections; that description is the shape being
replaced. It gains the per-account heading-and-block shape, what the two markers mean, and the fact
that the legend appears only when a marker is on the card. `docs/architecture.md`'s account of what
the cards are made of gains the one new fact: a fleet card heading carries untrusted text outside a
fence, so it takes the title's neutralization rather than the block field's.

Acceptance: both documents describe the shipped shape, and neither describes the single-fence card.
