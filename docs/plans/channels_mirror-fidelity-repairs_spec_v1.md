# Channels: mirror fidelity repairs

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session); overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the round whose
  live walk surfaced the multi-select join difference in Section 2 below.

## Goal

Two things the thread shows differently from the console, both found in live use, read the same on
both surfaces. A Markdown table mirrored into a thread becomes an aligned monospace block instead
of literal pipes, and a multi-select question answered from the thread reaches the session in the
same text the console's own answer produces.

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

### 1. A mirrored table becomes an aligned block

Model: opus

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

### 2. A thread answer joins the way the console joins

Model: sonnet

The question desk submits a multi-select answer as the labels joined with a comma and a space,
rather than as an array, so a session cannot tell which surface answered it. Single-select and
free-form answers are unchanged.

Acceptance: the submitted `updatedInput.answers` carries a joined string for a multi-select
question, pinned against the measured console text; single-select still carries a bare label and
free-form still replaces the map with `response`. The comma-in-a-label ambiguity this inherits
from the console's own format is recorded in the test's own words rather than guarded against.

### 3. Docs and live verify

Model: opus
Locus: inline

`docs/operations.md` gains what a mirrored table looks like and why; `docs/architecture.md` names
the transform in the mirroring path. Live verify: mirror a turn containing a table and read it on
a phone, and answer a multi-select question from the thread and confirm the session reports the
labels comma-space joined.

## Out of Scope

- Embeds, for the reasons in the measured ground.
- Any table the model did not write: this repairs mirrored conversation text, not the status card
  or the question message, both of which compose their own lines.

## Operator Verification

- A turn carrying a table reads as an aligned block on the phone, with no horizontal scrolling
  needed at three columns. Overflow at more columns is acceptable and expected.
- A multi-select answered from the thread reports the same text a console answer reports.

## Open Questions

None.

## Chapters

(Appended by executing-work as sections complete.)
