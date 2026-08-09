# Channels: mirror fidelity repairs

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session); overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the round whose
  live walk surfaced the multi-select join difference in Section 2 below.

## Goal

The surfaces the operator reads most often become scannable, and the one place a thread answer
still differs from a console answer stops differing. The cards the broker composes itself, the
session status card and the fleet usage card, put their tabular body in a fenced monospace block so
columns line up at a glance, and a multi-select question answered from the thread reaches the
session in the same text the console's own answer produces. A Markdown table the model wrote is the
lower-priority third piece: the operator reads those with effort today, so it rides behind the two
that are read constantly.

## The measured ground

- **Discord renders no Markdown table.** The pipes and dashes arrive literally, which is
  unreadable on a phone. Fenced monospace and embeds are the two shapes that work; embeds render
  at most three fields across and are a separate payload from the content string every narration
  surface here edits, so the fence is the fit. A fence also draws no mention pill and no timestamp
  chip, confirmed by operator check E on a real host, so the conversion makes mirrored text more
  inert rather than less.
- **A multi-select answer's rendering depends on the surface that answered.** From one session's
  transcript carrying both paths for one question: the broker's array of labels reaches the model
  as `"Jalapeños,Mushrooms,Pepperoni"`, the console picker's own answer as
  `"Jalapeños, Mushrooms, Pepperoni"`. The array is the documented shape and it answers correctly;
  only the rendering differs.

## Sections of Work

### 1. The broker's own cards read as aligned blocks

Model: opus

The session status card and the fleet usage card put their tabular body inside a fenced monospace
block so their columns line up. These are the surfaces the operator reads constantly, and they are
composed by this codebase rather than by the model, so their shape is entirely ours to choose.

The shape is a hybrid, forced by what a fence does: Discord renders no Markdown inside one, so bold
and mention pills die there. The card's title line therefore stays outside the fence, carrying its
glyph, its name, and its state, and only the body moves inside. A card that carries a mention keeps
that mention outside the fence too.

Width is the binding constraint. A Discord code block scrolls horizontally on a phone rather than
wrapping, so a card wider than roughly the mid-forties of characters costs the operator a drag to
read, which is worse than the ragged lines it replaces. Columns are therefore abbreviated to fit a
declared width bound rather than padded to their natural width, and the bound lives in one place
both cards read.

Acceptance: each card renders its title outside a fence and its body inside one, with columns
aligned down the block; every card stays inside the declared width bound at its worst case (the
usage card at its account and per-model maximum, the status card with its longest tool preview);
no card body relies on Markdown that a fence would show literally; the usage card's byte-compare
change detection still spends no edit on an unchanged reading. Tests pin the width bound at each
card's worst case and pin that no emphasis syntax survives inside a body.

### 2. A thread answer joins the way the console joins

Model: sonnet

The question desk submits a multi-select answer as the labels joined with a comma and a space,
rather than as an array, so a session cannot tell which surface answered it. Single-select and
free-form answers are unchanged.

Acceptance: the submitted `updatedInput.answers` carries a joined string for a multi-select
question, pinned against the measured console text; single-select still carries a bare label and
free-form still replaces the map with `response`. The comma-in-a-label ambiguity this inherits
from the console's own format is recorded in the test's own words rather than guarded against.

### 3. A mirrored table becomes an aligned block

Model: opus

Lower priority than the two above, and explicitly so: the operator reads a model-authored table
with effort today, where the cards are read at a glance many times a day. Build this last, and only
after Sections 1 and 2 are live.

A GFM table in mirrored conversation text renders as a fenced block with the columns padded to a
common width, in the render layer beside the existing neutralizers, so every mirrored surface
inherits it (narration chunks, the reply tool's answers, the Stop mirror).

What the transform owes:

- **Recognize a table only when the whole shape is there** (a header row, a delimiter row of
  dashes and optional colons, and at least one body row), on the codebase's own rule that what a
  block is gets decided from the whole block before it is bounded. A ragged, malformed, or
  header-only table is left exactly as today's text.
- **Leave fenced content alone.** A table inside an existing code fence is already monospace and
  must not be re-wrapped, and the transform must not open a fence inside one.
- **Fit a phone.** Columns pad to the widest cell, capped so the rendered width stays inside a
  bound the module owns; a cell past its column's cap is cut with the existing ellipsis helper,
  and a table whose natural width exceeds the bound drops to the widest fit rather than
  overflowing. Cell content is bounded and neutralized before padding, never after.
- **Respect the message ceiling.** A table that cannot fit the ceiling falls back to today's raw
  text rather than being silently truncated into a shape that reads as complete.
- **Alignment markers** (`:---`, `---:`, `:---:`) are honored when present and default to left.

Acceptance: a three-column table mirrors as one fenced block whose columns line up; a table inside
a fence is untouched; a malformed table is untouched; a wide table stays inside the width bound
with cut cells; a table that cannot fit the message ceiling mirrors as raw text; no mention pill
or chip can be manufactured by cell content. Tests lock each of those directions and pin the
escaping order (neutralize, then pad).

### 4. Docs and live verify

Model: opus
Locus: inline

`docs/operations.md` gains how to read a card's fenced body and what a mirrored table looks like;
`docs/architecture.md` names the width bound the cards share and the transform in the mirroring
path. Live verify: read both cards on a phone and confirm no horizontal drag is needed, answer a
multi-select question from the thread and confirm the session reports the labels comma-space
joined, and mirror a turn carrying a table.

## Out of Scope

- Embeds, for the reasons in the measured ground.
- Any table the model did not write: this repairs mirrored conversation text, not the status card
  or the question message, both of which compose their own lines.

## Operator Verification

- Both cards read on the phone with their columns lined up and no horizontal drag, at a fleet
  carrying several accounts and several live sessions. A card that needs dragging reopens
  Section 1's width bound.
- A multi-select answered from the thread reports the same text a console answer reports.
- A turn carrying a table reads as an aligned block on the phone, with no horizontal drag at three
  columns. Overflow at more columns is acceptable and expected.

## Open Questions

None.

## Chapters

(Appended by executing-work as sections complete.)
