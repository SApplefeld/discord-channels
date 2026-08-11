# A mirrored table keeps its text

Status: In Progress. Both sections built, the security pass's critical fixed and its measurement
reproduced, gate green. One operator look outstanding: a real mirrored table read on a phone. It
reaches Complete on that look, and archives in the same close-out.
Commit model: Review-Only (commit when the operator asks)

## Why

Discord renders no Markdown table, so a mirrored table is redrawn as a fenced monospace block. The
block is held to 46 columns, and the separators are spent first, so a three-column table leaves 40
columns for the cells to share: about thirteen each. Every cell past that is cut with an ellipsis.

Measured on a table of the kind these threads actually carry:

```
Option        | What it costs | Recommendati…
Keep the fen… | Truncates ev… | No
Drop to raw … | Pipes and da… | Yes, as the …
One block pe… | Longest outp… | Worth a round
```

The operator's report is that this loses almost everything and the table cannot be read. That is the
whole defect: not that the grid is ugly, that the content is gone.

## The rule already exists in this file

A table too **long** for one message is not drawn as a block at all. It ships as the Markdown the
model wrote, and `render.ts` says why: a block cut mid-row "reads as a complete table that says
something different from what was written, where raw text reads as raw text."

That is exactly the argument against cutting cells for **width**. One axis refuses to lie and the
other lies quietly. So this is not a matter of choosing a better column bound, it is one path
contradicting the principle its neighbour states, and the fix is to hold both axes to the same rule.

## What ships

**A table whose cells all fit keeps its grid.** Nothing changes for the small aligned tables the
fence serves well.

**A table that would need any cell cut is drawn as one block per row instead.** The first column's
cell becomes the row's heading, and every other column becomes a `label: value` line under it, the
label being that column's header. Nothing is truncated, nothing needs a horizontal drag, and Discord
wraps the lines itself.

The cost is vertical: a long table becomes several messages. That is accepted, because the operator's
requirement is the text, and a reply already splits across messages without a length cap.

## The hazard this introduces

Cell text is conversation content, which is untrusted, and the fence was doing security work: a
fenced body renders no Markdown, resolves no mention, and honors no quote marker.

Per-row output is **outside** a fence, so every cell it draws needs the unfenced escape (`inertText`
and its bounded pairing) rather than the block-inert one. A cell carrying `**`, a backtick, a quote
marker, or a mention must not be able to draw any of them, and the headings this rendering composes
must not be forgeable by a cell that contains the same markup. This is the one channel where
permission prompts are answered, so a cell that can draw a mention or a quote is the failure that
matters, not a cosmetic one.

The existing raw-Markdown fallback already emits unfenced cell text and relies on the chip and quote
neutralization that runs after the table transform. The new rendering rides the same seam and must
keep that ordering: the table transform reads and writes ordinary Markdown, and the escape runs
after it.

## Bounds

The transform runs over every mirrored reply, on the single event loop every hook, heartbeat, and
permission prompt shares, and a reply has no length cap. The existing parse and draw counters
(`tableParses`, `tableRowsDrawn`) exist to hold it to a cost linear in the text, and the per-row path
must stay inside that discipline: it draws only after a table has been recognized whole, never
speculatively per candidate start.

## Gate

`npm test` stands at 1139 tests, 1138 pass, 1 skipped, 0 fail. The skip is the POSIX token-file
platform gate.

`broker/tail.test.ts` carries a known intermittent failure under machine load, recorded in
`docs/backlog.md`. A single failure there is not this round's; anything else is.

What no test can settle: whether the per-row shape actually reads better than pipes on a real phone.
That is one operator look at one mirrored table.

## Sections

### Section 1: never cut a cell

Recognize the case where the grid would truncate, and route it to the per-row rendering instead of
drawing a cut grid. Keep the grid whenever every cell fits.

### Section 2: the per-row rendering

Compose the heading and the labelled lines, under the unfenced escape, with the header row supplying
the labels.

## Chapters

### Chapter 1: both sections, and the header the shape was dropping

A table whose cells all fit keeps its fenced grid, decided by comparing the capped column widths
against the natural ones. A table that would have to cut any cell is drawn a block per row instead.
The test that pinned the old cut grid was removed rather than adjusted, because the case it described
no longer exists.

The shape as first built dropped one thing: the first column's own header. Rows were headed by their
first cell alone, so a table of options showed each option and never the word "Option". That is
content loss inside a round whose premise is that content loss is the defect, and the implementer
raised it against its own work rather than leaving it to a reviewer. The heading now carries its
column's header, so every word the model wrote survives, and the four tests that pinned the older
shape were updated with it.

Measured, on the table the spec quotes:

```
**Option: Keep the fenced block**
What it costs: Truncates every cell past about thirteen characters
Recommendation: No
```

against the grid's `Keep the fen… | Truncates ev… | No`.

The escaping was the part worth the care. Outside a fence nothing is inert by position, so every cell
and every label takes the unfenced escape, and the test drives a hostile table carrying a mention, a
quote marker, a timestamp chip, bold markup, and a backtick, asserting on the final mirrored output
rather than on the transform. Two properties do the work: the escape neutralizes the markup, and its
whitespace collapse stops a cell composing a line of its own, which is what makes the heading and
label shapes unforgeable. The asterisk count is pinned so a cell's own emphasis cannot add a second
heading. The test opens by asserting the output carries no fence, so it cannot silently drift back
onto the grid path and pass by testing the wrong thing.

Two boundaries worth knowing. Angle brackets end up escaped twice, once here and once by the chip
pass that runs after, so a cell carrying them shows a visible backslash: no chip can resolve, and how
that reads is one of the things only a real look settles. And the length refusal still runs before
widths are known, so a table both wide and very tall, past roughly 620 body rows for two columns,
ships as raw Markdown rather than per row. That is the older rule winning, and it fails in the honest
direction.

The `broker/tail.test.ts` intermittent fired twice during this round, once for the implementer and
once for me, and was correctly not attributed either time. The backlog entry did its job.

### Chapter 2: the shape amplified, and what the new branch failed to inherit

The security pass returned BLOCK on a critical the suite could not see, and the numbers reproduced
independently. A two-column table carrying one 60,000-character header cell over 600 trivial rows:

| | input | messages | expansion | event loop |
| --- | --- | --- | --- | --- |
| before this round | 66 KB | 35 | 1.0x | 17 ms |
| the per-row shape | 66 KB | 19,200 | 548x | 3.07 s |
| after the bounds | 66 KB | 35 | 1.0x | 22 ms |

The mechanism is that a header cell is re-drawn once per body row, so its length is spent as many
times as the table is tall, and nothing bounded either term. Reachable from the reply-tool route as
well as the mirror route, so the mirror off switch does not close it, into the one channel that has
to stay answerable.

Two things made it. The per-row branch returns before the length guard the fenced path has always
had, so a new branch beside an old guard inherited none of its protection. And the heading fix in
Chapter 1, which added the first column's header to every row's heading to stop dropping a word,
put a second string into that same multiplier. The completeness call was right; it was made without
asking what else is emitted once per row.

The bounds hold the per-row path to the rule the rest of the file already follows, which is to fall
back to raw Markdown rather than cut anything: a header cell past 40 characters is prose rather than
a column name and ships the table raw, and a composed output more than eight times its source, or
past an absolute ceiling, does the same. The growth factor was picked against measured legitimate
ratios rather than derived: real tables here run 1.1x to 1.3x, and the worst honest shape that could
be built reached 5.1x.

The bound admits one behaviour change worth knowing: a table with 32 to 40 character headers over
hundreds of one-character cells now ships raw where it drew per row. Nothing is lost when it does,
which is why the fallback is the honest direction, but the trade is real and no test covered that
shape before.

### What is still open

One operator look at one real mirrored table, which no test can settle: whether the per-row shape
reads better on a phone than pipes, and how the doubled backslash looks in a cell carrying angle
brackets.
