# Channels: the fleet board card

Status: In Progress
Commit Model: Commit-and-Push
Created: 2026-08-16

Design approved by the operator 2026-08-16, who specifically ratified the membership rule: the
card shows every non-terminal plan in `docs/plans/` with its status drawn verbatim, hiding only
`Status: Complete`, rather than filtering to In Progress, so a plan waiting on the operator (a
Draft) is visible and a variant status spelling surfaces instead of silently vanishing.

## Related

- [`../archive/plans/channels_usage-card_spec_v1.md`](../archive/plans/channels_usage-card_spec_v1.md):
  the round that built the fleet usage card and the one-thread/one-card/edit-in-place pattern this
  card is a third instance of.
- [`../archive/plans/channels_fleet-card-layout_spec_v1.md`](../archive/plans/channels_fleet-card-layout_spec_v1.md):
  the round that settled the card idiom this card renders in: bold labels outside fences, fenced
  blocks padded to the shared width bound, markers legended only when drawn.

## Goal

A third persistent Discord surface, a broker-owned thread whose first message is a card listing
every open plan across a configured set of local project roots: the plan's filename (the handle the
operator mentions and feeds to `/kit-goal`), sections complete over total, what the latest Chapter
says comes next, how long since the plan doc last moved, and a blocked marker when the goal event
stream says a leashed run stopped needing the operator. Today the channel answers "what just
happened" well and "where is everything" poorly; reconstructing overall execution state costs
prompts. This card answers it at a glance, from the phone.

Two constraints are load-bearing and version-scoped. The renderer is deterministic: it draws only
state already published in machine-readable form, with no agent in the loop, so the card is honest
by construction and costs zero tokens per refresh. And v1 reads exactly two feeds: the plan-doc
header and structure that the kit freezes as a v1 machine contract (the nine parsed shapes in the
kit's `curating-docs` skill), and the goal event stream at `~/.claude/kit-events.jsonl` (one JSON
object per line: `ts`, `event`, `project`, `plan`, `session`, optional `detail`). What those two
cannot express, v1 does not draw. Extending the plan-doc contract is a coordinated versioned change
across the kit and Spine repositories and is out of scope here.

## Approach

The card is a third instance of the established pattern, not a new idiom: one thread the broker
owns, created once and rebound from persisted state across restarts, its starter message edited in
place only when the rendered body differs byte for byte from what last landed, with per-route
budgets and refusal ceilings, because a message create and a message edit are separate Discord rate
buckets and a block on one must not stop the other.

**The project list is configuration, never derived.** `CHANNEL_BOARD_PROJECTS` names absolute
project roots, semicolon-separated. The sweep reads `docs/plans/*.md` directly under each root and
nothing else (never `docs/archive/`). This keeps the broker's standing discipline that no field of
another program's file is used as a path: goal events carry absolute project paths, and those values
are matched against the configured set by normalized path equality, never opened. An event for an
unconfigured project is dropped.

**The plan reader parses the frozen contract exactly, including its sharp edges.** Status is the
first `Status:` line above the first `##` heading, terminal only when the value equals `Complete`
whole (case-insensitive); sections are `### N. <Title>` inside `## Sections of Work`, with any
foreign `##` heading ending the block early; chapters are `### Chapter N` inside `## Chapters`; a
section counts complete only when a chapter's first `Completed:` line matches it under the
contract's three forms (leading section number plus period or space, or the exact title,
case-sensitive, never a substring). A plan whose `Completed:` phrasing matches no form renders as
open. That is correct, not a bug to smooth over: the Spine engine reads the same rule, and a card
that disagreed with the engine about what is done would be the dishonest one. The current-work line
is the highest-numbered chapter's first `Next:` value, free-form prose, rendered bounded and
neutralized.

**Torn and oversized reads keep the last good render.** A plan doc mid-write by a live session can
be unparseable for a tick. Per plan path, the reader holds the last successful parse and redraws it
under a marker whose age climbs, the same discipline the usage card applies to an unreadable cache.
A file over the read cap is refused whole, never parsed as a prefix, because a recognizer running
on a cut copy can manufacture a match the full text does not contain. The held parse lives in
memory only; a restart re-reads everything, which is one tick of work.

**The event reader tails, keyed by (project, plan).** `kit-events.jsonl` is append-only by the
kit's contract; the reader remembers a byte offset, reads only what was appended, resets to a full
read when the file shrinks, tolerates malformed lines by skipping them, and keeps only the latest
event per (project, plan) pair for configured projects. Per-tick work is bounded by a read cap.
`goal-blocked` re-emits at every blocked stop and dedup is explicitly the consumer's policy, which
this keying is. The blocked marker draws while the latest event for a pair is `goal-blocked` and
clears deterministically on either of two observations: a `goal-complete` for the pair, or the plan
doc's mtime moving past the event's timestamp, because a chapter landing after the block means the
run resumed. The marker carries its own age so a stale block reads as stale rather than as current.
An absent events file is not an error; the card simply draws no blocked markers.

**Refresh is the usage card's cadence, mtime-gated.** A timer tick stats each swept plan file and
re-reads only those whose mtime or size moved, appends from the events file, re-renders the whole
card (ages move by the minute), and edits only on a changed body. Same knob shape, same bounds,
same one-pass-at-a-time and shutdown-drain semantics as `broker/usage/thread.ts`.

**Everything drawn is untrusted text.** Plan filenames, titles, `Next:` prose, and event fields are
model-written or another program's file content. Labels outside a fence take the full live-markdown
neutralization; fenced content takes the backtick-to-apostrophe rule; everything is bounded before
it is padded, inside the shared `MAX_BLOCK_WIDTH` (46 columns) so the card never costs a phone a
sideways drag.

**Host scope.** The sweep reads the local disk, so the card shows the enabling host's projects.
Off by default; enabled per host by `CHANNEL_BOARD_CARD`. The thread name is the static
`Fleet: Board`, matching the sibling; if a second host ever enables it, host-qualifying the name is
that round's one-line change. This reads the kit's outbound feed and the kit's plan-doc contract
only, never anything of the Spine engine's, so the repository's independence from
`sapplefeld-ai-os` stands.

### The shape

Geometry is the craft loop's to tune one axis per round, as the fleet card's was; this mock is the
starting point, not a pin. Bold project label outside the fence, fenced block per project, two
lines per plan, filename stem first because it is the handle:

```
# 📋 Fleet: Board

**sapplefeld-channels**
channels_board-card_spec_v1     ━━━░░  3/5
  2h 14m · next: the renderer and its tests

**sapplefeld-ai-os**
ai-os-attention-autonomy-gaps_spec_v1  ⏸ 3h
  blocked · next: rewire the attention loop

card as of 1m ago
```

A non-terminal status other than In Progress (Draft, Abandoned) draws as its own text where the bar
would be. A configured root with no open plans draws nothing; a card with nothing to draw says so
in one line rather than being absent, accepting the same deleted-card-undetected residual the usage
card documents.

## Standing Brief Amendments

Folded into every dispatch brief from here on. Each is a finding class the review of an earlier
section surfaced more than once, so the guard belongs in the brief rather than in one more fix.

- **Bound the work a tick can do, on every axis, and bound before you transform.** Two axes carry
  foreign-file content, not one: the number of items, and the bytes in any single field. A pass
  whose cost is the product of two file-derived counts is the obvious failure; the quieter one is a
  transform that walks a whole megabyte-capable field and only then cuts it to nine columns, which
  measured at multi-second stalls twice in this effort. Cut first, then escape, pad, or collapse.
  The broker has one event loop and the card runs on a timer, so a stall here is a stall on the
  channel where approvals are answered.
- **A comment asserts a system property, so it is a claim.** Verify it against the code you are
  leaving behind, and re-read every comment you touch. A comment promising a property the code does
  not have is a defect in this codebase, not a nit.
- **Compare Windows paths case-insensitively and separator-normalized, as strings.** Never reach the
  filesystem to decide whether two paths name the same place.
- **Bound and validate every intake field before it enters kept state, timestamps included.** A
  field that only gets a length cap still reaches a comparison that silently yields false forever.

## Sections of Work

### 1. The plan reader
Model: opus
`broker/board/plans.ts` (+ test). A sweep function taking the configured roots and returning, per
plan file: path, filename stem, status (raw string plus a terminal flag), section count, completed
count, the latest chapter's `Next:` value, and mtime; and the parse itself as a pure function from
file text, separately exported for tests. Reads are size-capped (1 MiB); an over-cap or unreadable
or unparseable file yields a per-path failure the caller folds into its last-good hold. No value
from any file is used as a path. Sweep errors on a whole root (missing `docs/plans/`) yield an
empty list for that root, not a failure: a project with no plans directory has no open plans.
Tests: at minimum, lock the contract's value rules in both directions: `Complete` with trailing
text is not terminal; a `Completed:` line matching none of the three forms leaves its section open
and one matching each form closes it; a foreign `##` inside `## Sections of Work` drops later
sections; an over-cap file is refused whole rather than parsed as a prefix. The expensive failure
is a card that quietly disagrees with the engine about the same file.
References: the contract table in the kit's `curating-docs` skill
(`D:\sapplefeld-claude-kit\plugins\claude-kit\skills\curating-docs\SKILL.md`, "The header is a
machine contract").

### 2. The event reader
Model: sonnet
`broker/board/events.ts` (+ test). Offset-tracked append reads of the events file (default
`~/.claude/kit-events.jsonl`, overridable by `CHANNEL_BOARD_EVENTS_PATH`), per-tick read cap,
full-read reset when the file shrinks, malformed lines skipped and counted, latest event kept per
(project, plan) with project matched against the configured roots by normalized path equality and
non-matching events dropped. Field lengths re-bounded at intake even though the kit caps them,
because another program's promise is not this broker's control. Absent file yields an empty state.
Tests: at minimum, lock append-only tailing (a second read returns only new lines), the shrink
reset, the malformed-line skip, and that an event for an unconfigured project never surfaces; the
risk is unbounded re-reads and a foreign path keying state.
References: the consumer contract in `D:\sapplefeld-claude-kit\docs\architecture.md`, "Goal
release events".

### 3. The renderer
Model: opus
`broker/board/card.ts` (+ test). Pure function from (plan readings, event state, now) to the card
body: grouped by project, filename stem as the row lead, section bar and count, minute-resolution
ages, the `Next:` prose bounded and neutralized, the blocked marker with its age and clear rules,
the held-parse marker, the non-terminal status text, the empty-card line, and the "card as of"
footer. Every fenced line padded within `MAX_BLOCK_WIDTH`; labels outside fences take full
markdown neutralization via the existing helpers in `broker/discord/render.ts`.
Tests: at minimum, lock that no backtick reaches a fenced body and no line exceeds the width
bound for adversarial filenames and `Next:` prose (the card renders untrusted text in the channel
where approvals are answered); and lock the blocked marker in both directions: drawn on a standing
`goal-blocked`, cleared by a newer plan mtime and by a `goal-complete`.
References: `broker/usage/card.ts` as the sibling; the mock in "The shape" above.

### 4. The thread, the config, and the wiring
Model: opus
`broker/board/thread.ts` sibling to `broker/usage/thread.ts`: one thread, one card, edit on
byte-difference only, per-route budgets (post, open, edit), refusal and rebuild ceilings, repeat-
limited logging, one pass at a time, shutdown drains the in-flight pass. Config knobs in
`broker/config.ts`: `CHANNEL_BOARD_CARD` (strict flag, off default), `CHANNEL_BOARD_PROJECTS`
(semicolon-separated absolute roots; flag on with an empty list builds nothing and logs once),
`CHANNEL_BOARD_CARD_REFRESH_MS` (bounded, default 60s), `CHANNEL_BOARD_EVENTS_PATH` (optional).
Binding persisted beside the usage card's so a restart rebinds rather than reposts; wiring in the
entrypoint alongside the usage card's; the pin reconciler in `broker/discord/pins.ts` recognizes
the board card as one of the broker's own cards so it is pinned and swept like the other two. Off
means absence of machinery: no thread, no timer, no file opened.
Tests: at minimum, lock both directions of the flag (off builds nothing, on with empty projects
builds nothing and says why), the edit-only-on-change rule, and rebind-not-repost across a
restart; the expensive failure is a second card in the channel or a timer running on a host that
never asked.
References: `broker/usage/thread.ts`, `broker/usage/binding.ts`, `broker/config.ts` sibling knobs
at the `CHANNEL_USAGE_CARD` block.

### 5. Documentation
Model: opus
Locus: inline
A "Fleet board card" section in `docs/architecture.md` beside the usage card's, stating the two
feeds, the deterministic-renderer property, the configured-roots rule and why paths are never
derived, the torn-read hold, and the blocked marker's clear rules. Knobs added to `operations.md`
tunables and `install.md` where `CHANNEL_USAGE_CARD` appears. `docs/README.md` opening paragraph
gains the third surface in one clause. `docs/security-model.md` gains the paragraph parallel to the
fleet card's, naming the two files the card opens, the string-only root matching, that no field of
either file becomes a path, and that the event stream's `project` is dropped rather than carried:
that doc is read as the control inventory, and the card adds two foreign-file readers, a new
environment-variable path override, and a new class of content crossing to Discord. Inline because
implementer subagents cannot write under `docs/` in this harness.

## Out of Scope

- Any extension of the plan-doc machine contract (a blocked status, percent-complete, operator-wait
  fields). Coordinated kit/Spine change, different effort.
- A session-to-plan join (which session is executing which plan). The broker keeps no `cwd` and
  widening the hook intake is its own decision, not this card's.
- Cross-host aggregation. The card shows the enabling host's disk.
- Per-project threads, or posting into the board thread. One card, edits only.
- Watching the filesystem. Interval plus mtime is the mechanism.
- Any agent, model call, or token spend in the render path.

## Operator Verification

- Read the card on the phone, folded and unfolded: no horizontal drag, bars draw as unbroken lines
  (same `BAR_GLYPH` consideration the usage card's backlog item records). A dragging card reopens
  the renderer section.
- With a real `/kit-goal` run driven to a blocked stop: the marker appears within one refresh, and
  clears after the run resumes and its next chapter lands. A marker that outlives a resumed run
  reopens the event-reader section.

## Open Questions

- Which roots go into `CHANNEL_BOARD_PROJECTS` at first deploy, and which hosts enable the card.
  Deploy-time values, operator's call; the code takes any list.

## Chapters

### Chapter 1 - 2026-08-16
Completed: 1. The plan reader
Implemented By: implementer-opus, with a second implementer-opus round for the review findings and a
third for the re-review's four
Metrics: 2 review rounds; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Two contract questions the reviewers could not settle were settled from the
engine's own source rather than inferred. The engine's H2 pattern is `^##\s+(.+)$`
(`PlanDocParser.cs:128`), so a `##foo` line does not end a block there; our reader had been ending
the block on it, a real divergence now fixed. The engine strips a UTF-8 BOM because it reads through
`File.ReadAllText` (`PhysicalHarvestFileSystem.cs:65`), so our BOM strip is correct and confirmed
rather than assumed. A plan doc with no `Status:` header above its first `##` yields a `malformed`
failure rather than a reading, so a doc caught mid-write holds its last good parse instead of
drawing with an invented status. The sweep now stats before reading and takes a caller-supplied
`heldParse` seam, which is what the spec's mtime-gated refresh actually needs; the original API could
not express it. Terminal plans are returned flagged, not filtered, because the membership rule is the
renderer's.
Review Findings: One Critical addressed: `parsePlan` was quadratic in file content, measured at
16,565 ms of event-loop-blocking parse on a 3 MB in-cap doc, now 47 ms via an indexed matcher that a
2,079-case fuzz confirms equivalent to the contract's three forms. Majors addressed: the missing
mtime-gate seam, the unbounded per-root file count (now capped at 64 with the drop count surfaced
rather than silent). Minors addressed: short-read loop, case-insensitive `.md`, PII contract on the
returned structs naming `stem` as the loggable identity, the FIFO-swap note, `fstat`-after-read
removed by stating before reading. Minor noted, not fixed: `broker/usage/cache.ts` carries the same
single-`readSync` shape and is deliberately out of scope here.
Stamps: adjudicated 1, stamped 1 (`stop-mirror-claim-tests-flake-in-isolation-too`)
Next: 2. The event reader (delivered in this same changeset; see Chapter 2)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-16
Completed: 2. The event reader
Implemented By: implementer-sonnet, with two implementer-opus fix rounds shared with Section 1
Metrics: 2 review rounds; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Built in parallel with Section 1 on disjoint files, which held: neither agent
touched the other's. The reader keeps the matched configured root rather than the event's own
`project` text, which drops the operator's OS username from held state entirely. Rotation is detected
by file identity as well as size, because a replacement file that has already regrown past the old
offset is invisible to a size check; the identity is built from a bigint stat, since `Number(ino)` is
lossy at NTFS FileId magnitudes (measured: an ulp of 1024 on this volume). Timestamps must carry an
explicit offset, mirroring `broker/usage/cache.ts:170`: a bare `Date.parse` reads an offset-less
stamp as host-local, which would shift the blocked marker's clear comparison by hours.
Review Findings: Majors addressed: a line longer than the read cap wedged the reader permanently,
freezing every event behind it; the byte offset was computed over a lossily re-encoded buffer, so
invalid UTF-8 let the file's writer steer where the next read began; root matching was neither
case-folded nor separator-normalized on Windows, silently dropping every event on a drive-letter case
difference; `project` was truncated before matching, so a long real path could never match its own
root; `ts` was neither bounded nor validated; the documented reference-equality change signal was
false; the kept map grew without bound. Minors addressed: ambiguous key separator, blank
`USERPROFILE`, surrogate-splitting bound, an unused exported constant dropped, the `malformed`
counter's doc made exactly true. Residual named in the module and accepted per the spec's
shrink-means-full-reset choice: `kit-events.jsonl.old` is never read, so events appended between the
last consumed offset and a rotation are lost.
Stamps: adjudicated 1, stamped 1 (shared with Chapter 1's boundary sweep)
Next: 3. The renderer
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-16
Completed: 3. The renderer
Implemented By: implementer-opus, one build round and one seven-item fix round
Metrics: 1 review round (adversarial + blind + security in parallel); NEEDS_CONTEXT 0; escalations 0;
consults 0
Decisions / Surprises: Two deliberate departures from the mock in "The shape", both argued and both
accepted. Empty bar cells are spaces rather than `░`, because U+2591 is East-Asian-Ambiguous width and
renders at two columns on a client configured for a CJK font, which would break the alignment the bar
exists to carry. The blocked marker is ASCII on the row's second line (`(blocked 3h 0m)`) rather than
`⏸` mid-line-one, for the same width reason plus the age being the useful part. The bar glyph moved to
`broker/discord/render.ts` as `BAR_GLYPH` so the two cards cannot drift; `BAR_CELLS` stayed local to
each card, since the two bars are sized independently.
The reviewers contradicted each other outright: the adversarial reviewer asserted no unbounded work
and that the module header's linearity claim was true, while the blind and security reviewers each
*measured* the same code stalling. Measurement won. The header's claim was the defect, not the
reviewer's disagreement about it.
Review Findings: Majors addressed: neutralizing before bounding walked a megabyte-capable `Status:`
and `Next:` in full before cutting to nine and 120 columns, measured at 519 ms for eight plans and up
to 8,165 ms at four roots, on the broker's only event loop and on the channel where approvals are
answered (fixed at the `plans.ts` intake locus, collapse-then-slice in that order so the kept prefix
is a prefix of the meaningful text, which also stops the held-parse cache retaining megabyte strings;
after: 0.4 to 1.9 ms); a `goal-blocked` stamped in the future permanently defeated the mtime clear
rule, so a single bad stamp would pin the marker forever (clamped to `now`); the footer claimed to be
anchored to the oldest thing drawn but reduced over every plan including the terminal ones the card
hides. Minors addressed: `planName` was not idempotent, so `foo.md.md` joined to the wrong event; a
`Status:` of nine bar glyphs forged a full progress bar; the no-parse table was an unguarded
object-literal lookup on a data-driven key; the adversarial corpus bounded shape but never scale,
which is how the megabyte finding survived 29 tests (a cost counter now pins that one render's
neutralized units against the intake caps rather than the file's size, its discrimination proved by
raising the caps to 4 MiB and watching the pin fail).
Residuals named in comments and accepted: a padded untrusted column can exceed display width, bounded
in consequence because a fenced block wraps rather than scrolling sideways; and the project label is
the last segment of a configured root, so a root at or one level under a home directory would draw the
operator's OS username.
Gate: baseline 1274/1273/0 fail/1 skipped, now 1281/1280/0/1. Judged across 21 full runs: ten carried
a red, and every red that was named was a member of the four known `broker/tail.test.ts` Stop-mirror
flakes. The board's own three test files never went red in any run, isolated (10/10) or under the full
suite. The project memory recording that flake was corrected this session on two counts its own
evidence contradicted: the rate varies far more between sampling sessions than the single figure it
carried, and a run can carry more than one member.
Stamps: adjudicated 3, stamped 3 (`discord-code-blocks-wrap-to-window-width`,
`discord-length-ceilings-differ-by-direction`,
`ordering-two-bounds-is-not-a-control-marking-the-cut-is`)
Next: 4. The thread, the config, and the wiring. Two items carried forward from this section's review:
confirm the board card's create and edit routes carry `allowed_mentions` suppression, and note that
enforcing `heldParse` staleness is the caller's job and so lands in that section.
Commit Model: Commit-and-Push
