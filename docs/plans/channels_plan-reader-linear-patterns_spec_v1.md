# The board card's plan reader matches headings in linear time, so one pathological line cannot stall a refresh tick

Status: In Progress
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

**Why the old forms are quadratic.** In `/^##\s+.+$/` the class `\s` accepts a carriage return, U+2028 and U+2029, and `.` refuses all three. On a line whose whitespace run ends in one of them, `.+` fails at that character, the engine gives one character back to `\s+` and retries, and every shorter prefix of the run is tried in turn. `SECTION`, `/^###\s+(\d+)\.\s+(.*)$/`, has the same cost after the period, but since its `(.*)` accepts the empty string, a run ending in a lone terminator matches at once; its quadratic line is a whitespace run, a terminator, text and a second terminator.

**The linear forms.** Let T stand for the character class of those three code points. Written as escapes, never as the live characters, since a literal U+2028 inside a JavaScript regular expression literal is a syntax error in a module:

- `BLOCK_HEADING`: `^##(?:\s[^T]|\s*[T][^T])[^T]*$`. Either one whitespace character and then a non-terminator, or a whitespace run whose last terminator is followed by a non-terminator, then anything but a terminator to the end of the line.
- `SECTION`: `^###\s+(\d+)\.(?:\s([^T]*)|\s*[T]([^T]*))$`. The title is whichever of the two groups matched, trimmed, which is the value the old form's `(.*)` gave after `.trim()`.

Each branch moves forward through the line without retrying a prefix, because a terminator inside the run is either the last one, which the second branch takes directly, or not, in which case the line fails in both forms. The source text of each pattern is asserted in the test, so the persona plugin's copy and this one stay textually identical. A live terminator in a regular expression literal fails loudly at import on its own.

**The equality pin.** A generated set over the alphabet `#`, space, tab, carriage return, U+2028, U+2029, NEL (U+0085), no-break space, `x`, `1` and the period, at every length up to 6, each tried bare and after the prefixes `##`, `###` and `### 1.` so the section pattern's matching region is reached, compared under the old and the new form for both patterns, with zero differences. Beside it, the named shapes: `##` plus 16,000 spaces plus a carriage return, the same followed by `x` and a second carriage return, `##` plus a space and a carriage return repeated 8,000 times with and without a trailing `x`, the same with U+2028 in place of the carriage return, and the section twins of each. The old forms are kept in the test file alone, as the oracle. A wall-clock bound is not pinned, since a timing test flakes under load; the Chapter records the measured times instead.

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

### Chapter 1 - 2026-10-03
Completed: 1. The two patterns are linear, and a pinned test proves they accept the same lines
Implemented By: implementer-sonnet; the round 1 fix round in the main session
Metrics: review rounds 1, closed major-closed; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused (security lens returned one Minor, no Critical or Major); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open: changes BLOCK_HEADING and SECTION in broker/board/plans.ts to the Approach's linear forms, sectionHeadings reading the title from whichever branch group matched, plus an equality test in plans.test.ts; serves the Goal sentence "accept exactly the lines they accept today and run in time proportional to the line's length"; adds no mechanism (two pattern rewrites and a test); size about 2 changed lines of code plus one test; not building it leaves a lone-CR line costing seconds inside every refresh tick.
- round 1 Major (adversarial, title read untested): changes the branch-title test to drive parsePlan's completed count with distinct titles closed by title-only Completed: lines, so the production read (match[2] ?? match[3]) is exercised; serves the section's Tests line "the title for a heading whose whitespace holds a terminator"; adds no mechanism; size one test rewritten, about 15 lines; not building it leaves a regression to "" on the second branch green while Chapters closed by title stop registering.
- Status flipped from `Ready` to `In Progress` at the run's start.
- The two constants are now exported so the test can reach them; no runtime caller outside plans.ts reads them (reviewer sweep, git grep over broker).
- Spec deviation, Approach updated to match: the old SECTION is not slow on the section twins of the block shapes, because its `(.*)` accepts the empty string. Its quadratic line is a whitespace run, a terminator, text and a second terminator, now among the named shapes. The source pin's stated reason was also wrong, since a live terminator in a regex literal is a loud syntax error at import; the pin's real job is keeping the persona plugin's copy textually identical.
- The generated set is tried bare and after the prefixes `##`, `###` and `### 1.`, since no line of length 6 or less can reach SECTION's matching region (the shortest match, `### 1. x`, is 8 characters). The count is 7,794,868 lines and sits in the test's name.
- The patterns' equality holds for lines without `\n`, which `.` refuses and the new classes accept; `parsePlan` splits on `\r?\n` first, and the comment at BLOCK_HEADING states the invariant.
- Wall clock on SCOTT-CLAUDE, one run each, measured 2026-10-03 against the worktree at 77becd5 with no foreign test runner on the box (process poll before the run), not pinned:
  - BLOCK_HEADING, `##` + 16,000 spaces + CR: old 82.8 ms, new 0.1 ms; with U+2028: old 99.2 ms, new 0.1 ms. The alternating and trailing-`x` shapes: old at most 0.7 ms, new 0.0 ms.
  - BLOCK_HEADING at the 256 KiB cap, `##` + 262,140 spaces + CR: old 21,925 ms, new 0.4 ms.
  - SECTION, `### 1.` + 16,000 spaces + CR + `x` + CR: old 74.5 ms, new 0.1 ms; with U+2028: old 91.4 ms, new 0.1 ms. At 262,130 spaces: old 20,401 ms (CR) and 24,057 ms (U+2028), new 0.4 ms.
Failed approaches: tried the Edit tool for lines carrying `\u2028`, `\u2029` and `\u00a0` escapes inside string and regex literals, failed because it wrote some of them as live characters (the implementer's first edit left plans.ts a syntax error, and the round 1 fix put three live characters in the ALPHABET line), learned to rescan for live U+2028, U+2029, U+0085 and U+00A0 after every such edit and to repair with a script that builds the backslash from its char code.
Assumptions:
- assumed 2026-10-03 (default, section 1): the generated set also runs after the prefixes `##`, `###` and `### 1.`, since the bare set cannot reach SECTION's matching region; reversal: drop the prefixes, at the cost of no section coverage.
- assumed 2026-10-03 (default, section 1): the generated comparison checks SECTION's number and trimmed title as well as its match verdict; reversal: none needed, it is strictly stronger.
Review Findings: review: adversarial + blind + security at opus, Workflow (high). Major (adversarial, spec-traceable): no test drove the production title read on the new branch; fixed, the test now closes three sections by title-only Completed: lines, and the mutant `(match[2] ?? "")` turns it red (1 fail, exit 1) before the restore. Major (adversarial, spec-traceable, orchestrator-checked trace to acceptance bullet 1): the source pin pins a choice; justified-not-fixed, since acceptance bullet 1 requires it, with its false stated reason corrected in the test comment and the Approach. Refused: a wall-clock test (blind Minor), since the Approach refuses a timing pin; a smaller generated set (blind Minor), since it measured 661 ms. Minors: 7 fixed in the fix round (the "take seconds" comment, the missing SECTION quadratic shape, the count in the test name, NEL called whitespace, "three terminators the dot refuses", the `\n` invariant raised by both the adversarial and security lenses, the twin comment naming the persona plugin's copy), 0 upgraded, 0 left. The fix delta changes tests and one comment and adds no module or outward action, so it owed no round; author re-read in place of a round: live-character scan clean on both files, targeted lane green, and the mutant run above.
Stamps: adjudicated 1, stamped 0 (subagent-can-report-a-documented-past-injection-as-a-live-one was read by a reviewer, not applied by this session's work).
Gate: targeted lane `node --test broker/board/plans.test.ts` on the worktree at 77becd5 plus the uncommitted fix round: 34 tests, 34 pass, 0 fail, exit 0, 1.3 s; `npm run lint` exit 0. The implementer's full suite at 77becd5: 2363 tests, 2362 pass, 0 fail, 1 skipped, exit 0, about 44.9 s (reported by the implementer, not re-run here; the whole gate runs at finishing). Baseline at aa9eda0 clean, run by this session: 2359 tests, 2358 pass, 0 fail, 1 skipped, exit 0, 46.6 s, no foreign runner on the box. Delta: +4 tests, all passing. Tests added: the source pin (pins the forms the persona plugin's copy shares); the generated-set equality over 7,794,868 lines (pins the language equality); the long-run shapes (pins the verdict on the quadratic inputs for both patterns); the branch title through parsePlan's completed count (pins the title read on both branches). None spawns a process. None retired, none edited.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: measured 2026-10-03 on SCOTT-CLAUDE against the worktree with the section uncommitted; output:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
