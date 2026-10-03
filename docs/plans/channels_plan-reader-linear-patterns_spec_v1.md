# The board card's plan reader matches headings in linear time, so one pathological line cannot stall a refresh tick

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 from a finding the coordinator persona routed (record ARCHITECT-e07bad48-2f72-460e-99af-d9161193fcb9-3), which arose in the persona repository's plan-record sections plan when that plugin adopted this card's heading patterns. The coordinator queues it for the broker's worker. It needs no operator decision: the change keeps every verdict the reader gives today and only removes a cost.

## Goal

Two of the plan reader's heading patterns in `broker/board/plans.ts`, `BLOCK_HEADING` at `:219` and `SECTION` at `:210`, accept exactly the lines they accept today and run in time proportional to the line's length. A line of 256 KiB, the reader's cap, matches or fails in under a few milliseconds whatever its content, where today a line whose whitespace run ends in a lone carriage return, U+2028 or U+2029 takes seconds. A pinned test proves the new forms accept the same lines as the old over a generated set, and the section reader still returns the same number and title for every heading it returns today.

## Intent

The frame. The coordinator persona routed the finding on 2026-10-02, in its words: "The card runs this on every refresh tick over each plan file under its configured folders, so one such line stalls its tick." The ARCHITECT had ruled the same change for the persona plugin's twin of this reader the same day, after reproducing the cost: at 40,000 spaces plus a carriage return the old block pattern took 503 ms on SCOTT-CLAUDE and the linear form 0.1 ms. The persona worker measured about 23 seconds at the 256 KiB cap, and proved the two forms equal over 7,794,868 generated lines with no difference.

What done needs to do. Replace the two patterns with forms that accept the same lines in linear time, keep the section reader's number and title, and pin the equality in the test suite with a bounded generated set and the named adversarial shapes.

What done does not need to do. It does not change any other pattern in the reader, the block rule, the status read, or the cut and collapse of a value. It does not change what the card draws. It does not touch the persona plugin's copy, which lands under that repository's plan-record sections plan.

Alternatives refused. Stripping the three terminator characters from each line before matching: refused, since that changes the language, so a line the engine rejects today would be accepted. A cap on the whitespace run: refused for the same reason. Leaving it, since no plan file today carries such a line: refused, since the cost is paid inside the refresh tick for every plan under every configured root, and a single pasted line is enough.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 100aa4c7, on 2026-10-02, from `broker/board/plans.ts` and `broker/board/plans.test.ts` at `origin/main` a2af535, and the probe at `D:/personas/ARCHITECT/.kit/regex-probe.mjs` on SCOTT-CLAUDE.

## Approach

**Why the old forms are quadratic.** In `/^##\s+.+$/` the class `\s` accepts a carriage return, U+2028 and U+2029, and `.` refuses all three. On a line whose whitespace run ends in one of them, `.+` fails at that character, the engine gives one character back to `\s+` and retries, and every shorter prefix of the run is tried in turn. `SECTION`, `/^###\s+(\d+)\.\s+(.*)$/`, has the same shape after the period.

**The linear forms.** Let T stand for the character class of those three code points. Written as escapes, never as the live characters, since a literal U+2028 inside a JavaScript regular expression literal is a syntax error in a module:

- `BLOCK_HEADING`: `^##(?:\s[^T]|\s*[T][^T])[^T]*$`. Either one whitespace character and then a non-terminator, or a whitespace run whose last terminator is followed by a non-terminator, then anything but a terminator to the end of the line.
- `SECTION`: `^###\s+(\d+)\.(?:\s([^T]*)|\s*[T]([^T]*))$`. The title is whichever of the two groups matched, trimmed, which is the value the old form's `(.*)` gave after `.trim()`.

Each branch moves forward through the line without retrying a prefix, because a terminator inside the run is either the last one, which the second branch takes directly, or not, in which case the line fails in both forms. The source text of each pattern is asserted in the test, so an editor that turns an escape into the live character is caught.

**The equality pin.** A generated set over the alphabet `#`, space, tab, carriage return, U+2028, U+2029, NEL (U+0085), no-break space, `x`, `1` and the period, at every length up to 6, compared under the old and the new form for both patterns, with zero differences. Beside it, the named shapes: `##` plus 16,000 spaces plus a carriage return, `##` plus a space and a carriage return repeated 8,000 times with and without a trailing `x`, the same with U+2028 in place of the carriage return, and the section twins of each. The old forms are kept in the test file alone, as the oracle. A wall-clock bound is not pinned, since a timing test flakes under load; the Chapter records the measured times instead.

**Sweep.** `git grep -n -E 'BLOCK_HEADING|SECTION\b|isBlockHeading' broker` at a2af535 finds the two constants, `isBlockHeading` at `:221`, its callers `blockLines` `:232` and `statusValue` `:242`, and `sectionHeadings` `:253`, the one caller reading `SECTION`'s captures. No other file names them.

## Sections of Work

### 1. The two patterns are linear, and a pinned test proves they accept the same lines

Model: sonnet

The two constants take the forms above. `sectionHeadings` reads the title as the matched group. A new test in `broker/board/plans.test.ts` holds the old forms as the oracle and the generated and named cases.

Acceptance:
- `BLOCK_HEADING.source` and `SECTION.source` equal the forms in the Approach, with the three terminators written as `\r`, `\u2028` and `\u2029`.
- The generated-set test over the alphabet above at lengths 0 to 6 reports zero differences between old and new for both patterns, and the count of lines compared is printed in the test's name or message and recorded in the Chapter.
- Every named adversarial shape above gives the same verdict under old and new, and the section twins give the same number and title.
- Every existing test in `broker/board/plans.test.ts` passes unchanged; the existing case at `:140`, a `##` line ends the block only when whitespace and text follow the hashes, is the sibling the new cases extend.
- `npm test` and `npm run lint` exit 0 against the baseline recorded before the edit.
- The Chapter records the wall clock of each named shape under old and new on the worker's machine, read from one run of the probe, not pinned.

Files in scope: `broker/board/plans.ts`, `broker/board/plans.test.ts`.
Tests: the language equality, since that is the agreement the persona plugin's twin pins against this card; the title for a heading whose whitespace holds a terminator, since the capture moved into two branches; the pattern source text, since the live character is a silent break.

## Out of Scope

- The persona plugin's twin reader, under `agent_persona` plan `agent_persona_plan-record-sections_spec_v1.md`.
- Any other pattern or rule in `plans.ts`, and the `bounded` cut.

## Assumptions

- assumed 2026-10-02 (source: the persona worker's differential run of 7,794,868 lines, reported through the coordinator and not re-run here): the two linear forms accept exactly the old forms' language; reversal: the pinned test fails, and the forms are corrected before the section closes.
- assumed 2026-10-02 (default): no plan file under the card's roots carries such a line today, so the change has no visible effect on the card; reversal: none needed.

## Operator Verification

- None. The card's output is unchanged by design.

## Open Questions

- None.

## Related

- `agent_persona_plan-record-sections_spec_v1.md` in the persona repository, where the same patterns were adopted and the same forms ruled.
- `../archive/plans/channels_board-markdown_spec_v1.md`, which wrote this reader.

## Chapters
