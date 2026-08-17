# Channels: the board card in live markdown

Status: In Progress
Commit Model: Commit-and-Push

The successor to `docs/archive/plans/channels_board-card_spec_v1.md`: same feeds, same thread,
same budgets, a different body. The fenced three-column table becomes a markdown list, because the
card's content turned out to be prose and a fence can only cut prose where a list can wrap it.

## Related

- `docs/archive/plans/channels_board-card_spec_v1.md` - the effort that built the card this one
  reshapes; its Standing Brief Amendments carry forward whole.
- `docs/architecture.md` "Fleet board card" - the as-built description this effort revises.
- `docs/security-model.md` - the control inventory; the escaping change lands there too.

## Goal

Every fact on the board card reads whole on the operator's phone. Today the card draws each plan as
a fenced table row whose name column (31 code points) and status column (9) are both narrower than
the fleet's real content, so most rows end in ellipses exactly where the information lives: 8 of 14
names cut on the NEO board, every multi-word status cut, a zero-progress bar rendering as nine
blank spaces. The fix is not wider columns (the 46-column fence bound is the measured phone wrap)
but leaving the fence: live markdown wraps at word boundaries with hanging indent, so a
sentence-length status or a 120-character `Next:` costs wrapped lines instead of an ellipsis.

## Decisions

All decided 2026-08-16 with Scott, on a joint read of the three live boards (ASR, Scott, NEO):

- **Live markdown list, not a fence.** `###` heading per project, one bullet per plan with the
  filename stem in bold, one indented sub-bullet carrying count, age and status separated by
  ` · `, and a second sub-bullet `next: ...` only when the plan has one. Chosen over retuning the
  table (arithmetic cannot fit a 35-char name beside a sentence in 46 columns) and over stacked
  rows inside the fence (fixes names, still hard-cuts prose at 46).
- **The progress bar is dropped.** The `completed/sections` count says the same thing, never
  renders as blank space, and the em-dash glyph's font-dependent tiling goes with it.
- **`0/0` is suppressed.** A plan whose doc declares no sections draws no count clause.
- **`README.md` is excluded from the sweep.** A README under `docs/plans/` is an index, not a
  plan; it stops surfacing as a parse failure on every board.
- **Exact `In Progress` (trimmed, case-insensitive) draws no status clause**; it is the ordinary
  state, and with the bar gone nothing else occupies the spot, so absence is unambiguous. Every
  other non-terminal status draws as written, whole to its intake cap. The old near-miss trap
  (`In Progress (auto)` cut to `In Progr…` at 9 columns) dissolves: it draws whole.

## Approach

### The shape

The craft loop's to tune one axis per round; this mock is the starting point, not a pin. Real NEO
and ai-os data, statuses at their intake-capped full length:

```
# 📋 Fleet: Board

### Neuro-Evolution-Operations
- **neo_heremap-migration_spec_v1**
  - 0/6 · 5d 8h · Parked (until pilot data lands)
- **neo_money-rails_spec_v1**
  - 0/4 · 13d 12h · In Progress (auto)
  - next: push + PR to develop (auto-run)
- **neo_go-live_roadmap_v1**
  - 3d 22h

### sapplefeld-ai-os
- **ai-os-warden-steward-gap_handoff_v1**
  - blocked 2h · 5h 0m · Handoff brief for a design discussion (not an execution spec)

card as of just now
```

The blocked and held markers keep their wording and their lead position on the facts sub-bullet.
No blank lines inside a project's list (a blank line ends a markdown list); one between a
project's list and the next heading. Parse-failure and truncation lines become plain bullets in
the same list (`- eleos-demo_spec_v1 (too large to read)`), stems no longer display-cut.

### What changes and what does not

Every untrusted field moves from `inertBlockField` to `inertField`: live markdown is the surface
the question messages and downgrade notices already render untrusted text on, the escape covers
every metacharacter including Discord's `<...>` chip syntax, and the transport's empty
`allowed_mentions` parse list is what keeps `@everyone` in a status from pinging
(`render.test.ts:752`). Intake caps are untouched (`MAX_INTAKE_STATUS_LENGTH` 120, `MAX_NEXT_LENGTH`
120); the display-width cut at `MAX_BLOCK_WIDTH` disappears for this card and the constant stays
for the genuinely tabular cards. Deterministic rendering, edit-on-byte-difference, the running
1,900-character budget with the honest overflow tail, the `card as of` footer, the thread, the
config knobs and the pin handling are all unchanged. Budget arithmetic measures escaped strings,
so backslashes count; bound at intake first, then escape, as the amendments require.

Deleted outright: `BAR_CELLS`, the bar, `STATUS_BAR_SUBSTITUTE`, the padding and column-width
geometry. `fieldUnitsNeutralized` and its cost bound stay, counting the same fields through the
new escape.

## Standing Brief Amendments

The predecessor's four amendments carry forward verbatim into every dispatch brief: bound on every
axis and bound before you transform; a comment is a claim to verify; compare Windows paths as
strings, case-insensitively; bound and validate every intake field before it enters kept state.

## Sections of Work

### 1. The sweep excludes README
Model: sonnet
`broker/board/plans.ts` (+ test). One filter clause at the listing (`plans.ts:510`): a file whose
stem case-folds to `readme` is not a plan file. It is absent, not a failure: no row, no
parse-failure line, no count against `MAX_PLANS_PER_ROOT`.
Tests: `README.md` and `ReadMe.MD` listed beside real plans yield readings for the plans only and
no failure; a plan legitimately named `readme-rework_spec_v1.md` still surfaces (the exclusion is
the whole stem, not a prefix).

### 2. The renderer in markdown
Model: opus
`broker/board/card.ts` (+ its test, + the pinned bodies in `broker/board/thread.test.ts`). The
body per "The shape": `###` project headings, bold-stem bullets, facts sub-bullet (count unless
sections are zero, markers leading, age, status unless exact `In Progress`), `next:` sub-bullet,
failure and truncation bullets, empty-card line, footer. All fields through `inertField`; no
display-width cut on any field; the running budget composed against escaped lengths with the
overflow tail reserved as today.
Tests: at minimum, lock that adversarial stems, statuses and `Next:` prose (markdown
metacharacters, `<t:...:R>` chips, `@everyone`, backticks) render inert on the live-markdown
surface; that a name full of underscores renders literally; both directions of the status rule
(exact `In Progress` absent, `In Progress (auto)` drawn whole); the zero-section count
suppression; the blocked marker's draw and both clear rules, which must survive the reshape; and
the render-cost bound via `fieldUnitsNeutralized`. Pin full clauses, not words: a text pin locks
vocabulary, not semantics.

### 3. Documentation
Model: opus
Locus: inline
`docs/architecture.md` "Fleet board card": the body description and any mock updated to the list
shape, the bar's mention removed, the README exclusion and status rule stated as membership rules.
`docs/security-model.md`: the board card's paragraph now states its fields render on live markdown
through the full `inertField` neutralization, same control as the question messages, with
`allowed_mentions` named as the ping control. Sweep the tree for comments asserting the fenced
geometry (a comment that names a property is a claim to sweep). Inline because implementer
subagents cannot write under `docs/` in this harness.

## Out of Scope

- Sort order within a project (sweep order today). If recency-sorting is wanted it is a one-knob
  follow-up; noted, not built.
- The age's semantics (time since the doc last moved) and any staleness styling.
- The other cards' fenced bodies and `MAX_BLOCK_WIDTH` itself.
- Any plan-doc contract extension. The contract is frozen and read by two engines.

## Operator Verification

- Read the card on the phone, folded and unfolded: nested bullets render with hanging indent, no
  name or status ends in an ellipsis at its intake-capped length, long facts wrap rather than cut.
- The NEO board (14 plans) either fits whole or ends in the honest overflow tail, never a silent
  drop.

## Open Questions

- Whether `###` reads better than a bold line for project headings on the phone: a one-axis craft
  swap after the first live render, not a blocker.

## Chapters

### Chapter 1 - 2026-08-16
Completed: 1. The sweep excludes README
Implemented By: implementer-sonnet
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The exclusion sits inside the `readdirSync` filter chain, before the
per-root cap is applied, which is what makes a README cost nothing against `MAX_PLANS_PER_ROOT`
and produce no truncation count. A downstream filter in `sweepPlans`'s per-name loop would have
satisfied "no row" while still eating a cap slot. The exclusion was also extended to the
held-listing path: every held listing originates from the filtered path today, so there was no
live failure, but `heldListing` is a public option whose type accepts arbitrary names, and
leaving the property resting on a caller's discipline is this repo's standing writer-and-verifier
defect shape.
Review Findings: 1 Major, 6 Minor across adversarial, blind and security reviewers. The Major was
found independently by all three and confirmed here by a real probe: the fixture wrote `README.md`
and `ReadMe.MD` into one directory, which on this host is one file (`readdirSync` returned a single
entry named for the first write, holding the second write's content), so the case-fold arm of the
exclusion had never executed. Fixed by giving each case variant its own root and asserting the
on-disk name before sweeping, so a future silent collapse fails the test instead of passing it.
Minors fixed: stem derivation extracted to one `planStem` so the exclusion and the displayed stem
cannot drift; the held-listing gap above; `sweepPlans`'s doc comment now names the sweep's own
exclusion; the cap test now asserts stems rather than a length that a regression could satisfy.
One Minor routed onward rather than fixed here: the false nine-column comment at `plans.ts:56-59`,
which only became false when section 2 landed, so it was fixed in that section's round.
Stamps: adjudicated 5, stamped 5.
Next: 2. The renderer in markdown
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-16
Completed: 2. The renderer in markdown
Implemented By: implementer-opus
Metrics: 1 review round; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Three calls the spec left open were settled against the mock rather than
against the prose. The `blocked` and `held` markers draw without the parentheses the fenced row
wrapped them in: the spec says the markers keep their wording, and the wording is the words, while
the parens were disambiguating inside a fence that no longer exists. The render bound handed to
`inertField` is the field's cap times an escape-expansion constant rather than the cap itself,
because intake bounds raw code points and the render bounds escaped text, so passing the cap would
silently cut a field the intake had already bounded, which is this repo's recorded two-bounds
trap. That constant landed at 2 after review, not 4: every character the escape touches is ASCII,
so an escaped code point yields two code points and two UTF-16 units, while an astral code point
is never escaped, giving a 2N ceiling in both measures `fit` binds. The `wrapped` helper was
dropped from this card one step beyond the spec's delete list, since hard-wrapping at 46 columns
on live markdown would only insert breaks the surface does not need.
Also carried forward deliberately: `Next:` is still cut at the card's own 120 while intake allows
400 (`plans.ts:64`), so it is the one field on the card that can still end in a mark. The spec
names 120 as staying, so this is compliance rather than drift, but the 400/120 asymmetry is a
one-knob follow-up if a fuller `Next:` is wanted.
Review Findings: 1 Major, 8 Minor across adversarial, blind and security reviewers; no Criticals,
and all three independently verified the escape arithmetic, the budget's tail reservation and the
`MAX_STEM_LENGTH` addition as sound. Major, found by the blind reviewer: this section falsified a
load-bearing comment in `plans.ts` claiming the intake caps sit above anything the renderer draws,
when the card now draws a status whole at the intake cap, so the cap became a display bound and a
maintainer raising it would silently widen every status until the overflow tail ate plans. Fixed
by stating the coupling. Minors fixed: `fieldUnitsNeutralized` was blind on the `Next:` path
because the count ran on the post-cut string while `fit` spreads the raw value, so the largest
walk on that path went uncounted (fixed by one function owning both the measure and the cut, with
a pin that goes red on exactly that blindness); the escape constant tightened to 2; the overflow
tail now closes the list with a blank line, since it sat flush under a sub-bullet where a lazy
list continuation could attach it to one plan; three comments corrected against what the code
actually does.
One Minor recorded and deliberately not fixed: a `Status:` value can forge the card's own marker
vocabulary (`Status: held 9h 10m · blocked 2d 1h` draws clauses distinguishable from
broker-authored markers only by position), a defense the deleted nine-column cut used to carry
incidentally. Every fix preserves the body shape decided on 2026-08-16, and the fix for this one
would not, so it is raised to the operator as a craft-loop question rather than settled here.
Surprise worth recording: the section's file scope missed a wiring test. `broker/index.test.ts`
pinned the old bold project label and the unescaped stem, and only a full-suite run surfaced it,
because the section's targeted test files were all green. The dispatch brief, not the implementer,
is what scoped three files and never asked for a tree-wide sweep of card-body pins.
Stamps: adjudicated 5, stamped 5.
Next: 3. Documentation
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-16
Completed: 3. Documentation
Implemented By: main session (Locus: inline, since the docs-write guard blocks a subagent under
`docs/`)
Metrics: 0 review rounds at the section level, the finishing pass covering it; NEEDS_CONTEXT 0;
escalations 0; consults 0
Decisions / Surprises: The section named two documents; the sweep found four. `docs/operations.md`
described the card to the operator as a bold label over a fenced block carrying a progress bar, and
separately claimed `BAR_GLYPH` was read by "both cards that draw a bar", which is now one card.
`docs/backlog.md`'s operator check number 9 told the operator to read the card on a phone looking
for horizontal drag and for whether its bar tiles into an unbroken line, both of which this effort
deleted; it now names what there actually is to look at, including the overflow tail standing on
its own line, which is the one shape a reviewer suspected the client might attach to the last plan.
The architecture doc's "What the cards are made of" section needed the board card carved out as a
stated exception rather than a silent one, since its opening claim that every card draws inside a
fence was the general rule this effort broke.
The security model's board-card block was rewritten past what the section asked for. The section
called for stating the full `inertField` neutralization and naming `allowed_mentions`; the block
also asserted the project label was "the one field on this card outside a fence", which the
security reviewer independently flagged as falsified. It now states the control positively (no
fence, so position neutralizes nothing and every field takes the full escape) and adds the two
properties that carry it: the invisible-class strip that stops a field composing a line, and the
literal prefix on every emitted line that keeps a field out of column zero. It also states the
limit of the control, that a status can spell the marker vocabulary, so the document does not
promise more than the code does.
Review Findings: none at the section level. The code-comment sweep this section owns found the
board module clean: `card.ts`'s header was rewritten by section 2 and asserts the list shape, and
`plans.ts`'s falsified caps comment was fixed in section 2's round. No JSON `_comment` field
carries a board-card geometry claim.
Stamps: adjudicated 5, stamped 5 at the section 1 and 2 boundary; none newly surfaced here.
Next: finishing-work
Commit Model: Commit-and-Push
