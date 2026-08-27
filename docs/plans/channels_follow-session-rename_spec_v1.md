# Follow a Session Rename: the Thread Title Tracks `/rename`

Status: In Progress
Commit Model: Commit-and-Push (the model every sibling plan in this repo ran under; the operator confirms at arming)
Fable Spend: research and this spec in the Expert session; implementation dispatched to one worker
Created: 2026-08-26

## Problem

A session's Discord thread is titled from the name given at launch and never follows an in-session
`/rename`. The operator's pattern is therefore name-at-launch, never rename, and a wrong name stays
wrong for the session's life. The kit's planned one-command seat takeover (claude-kit
`kaizen/notes-SCOTT-CLAUDE.md`, the `/role` note) assumes the name is fixed at launch because of
this; if the thread follows a rename, that design loosens.

## Confirmed ground

Read from the files named, at commit `c4cd373`, on 2026-08-26.

- **Where the name enters.** `wrapper/Enter-ClaudeSession.ps1:228` sets `CHANNEL_SESSION` to
  `-Name` and `:251` passes the same value to `claude --name`. `hooks/session-start.ps1:49-50`
  sends it as the `X-Channel-Session-Name` header; `broker/intake.ts:410` reads it into
  `intake.sessionName`; `broker/registry.ts:511` and `:672` write it to `record.name` on every hook
  post that carries the header. The header carries the launch-time environment variable for the
  process's whole life, so a `/rename` never reaches it.
- **Where the title is composed.** `broker/discord/render.ts:875` `threadName` builds
  `<glyph> <displayName> · <state>` inside `MAX_THREAD_NAME_LENGTH` (100); `:838` `displayName`
  renders `view.name` through `inertName`, falling back to the first eight characters of the
  session id.
- **The rename path already exists and already handles a changed name.** `broker/discord/surface.ts:369`
  `refreshName` repaints the title whenever the composed name differs from `renderedName`, subject to
  a dwell (`DEFAULT_DWELL_MS = 60_000`, `broker/discord/config.ts:31`; urgent states skip it) and a
  per-thread rename budget (`surface.ts:216`; the comment at `:29` sizes Discord's bucket at about two
  renames per ten minutes per thread, shared with the final exited rename and the archive). The dwell
  comment at `surface.ts:447-449` names "a session renaming itself" as one of the two title changes it
  measures. The adapter is `PATCH /channels/{threadId}` with `{ name }` (`broker/discord/adapter.ts:343`).
  An archived thread cannot be renamed, and the surface returns before `refreshName` for an archived
  entry (`surface.ts:474`); a session that renders anything but exited clears the flag (`:470`).
- **What `/rename` writes.** Claude Code writes
  `{"type":"custom-title","customTitle":"<name>","sessionId":"<id>"}` to the session's transcript
  (this session's transcript, `~/.claude/projects/D--discord-channels/7878833c-3cf4-4ebc-bb2d-729f5a002e75.jsonl`,
  carries it at lines 5, 22, 47, 78, 91, 109, 133, one value, re-emitted through the session). The
  line carries no timestamp. `--name` at launch writes the same line, so at launch the transcript and
  the header agree.
- **The tailer already follows that file and already routes a line kind to the registry.**
  `broker/tail.ts:835` `TailItem` carries a `goal` kind read off a transcript line, and
  `broker/tail.ts:2222` delivers it through `options.noteGoal`; the new kind follows that path.
- **No harness hook fires on a rename.** The hook events the broker consumes are the ones in
  `hooks/settings-fragment.json`; none is a rename event, and the transcript line is the only
  on-disk signal. Polling the transcript is what the tailer already does, so no new poll is needed.

## Design

A second name field, not a precedence rule over the first. The registry record gains `title`,
sourced only from the transcript's `custom-title` line, beside the existing `name` sourced only from
the header. `displayName` prefers `title` when present, else `name`, else the session-id fallback.
Keeping the two fields apart means the header, which arrives on every hook post, never clobbers a
tailed rename and no ordering between the two sources has to be reasoned about; the transcript is
the harness's own record of the session's title, and the header is the launch label.

The title is untrusted content from another program's file, on the same footing as `name`: bounded
at the reader (cut in code points, the tailer's label bound `broker/tail.ts:1168` is the shape to
reuse) and neutralized at the render site through `inertName`, which it already passes through in
`displayName`. An empty or unreadable `customTitle` reads as absent, never as a rename to the empty
string. A `custom-title` line whose `sessionId` is not the tailed session's is ignored.

The rename reaches Discord through the existing `refreshName`: the dwell restarts on the title
change (`entryFor`, `surface.ts:450-453`), so a rename lands about one dwell after the transcript
line is read, out of the same per-thread budget the state renames spend. Nothing in the surface
changes.

The status card (`render.ts`, the card body) and the board's `/sessions` route render the same
`displayName`, so both follow without a second change; the worker confirms rather than assumes this.

## Dispatch Authorization

The operator (Scott Applefeld) authorized this run at the keyboard of the CHANNELS: Expert session on 2026-08-26, for any session holding this plan. The grant covers executing this plan's sections under the executing-work skill; anything the plan does not cover still goes to the operator.

## Standing Brief Amendments

Binding on every section dispatched after the amendment was written, and folded into every dispatch
brief.

1. A test never asserts against an expression the implementation also evaluates. Assert literal
   expected values. Where the expectation and the implementation call the same helper with the same
   arguments, the test pins the constant and nothing about the behaviour, and it stays green through
   a regression of the helper. (Adopted at Section 1's review round, where the over-long-title test
   was written this way and could not fail.)
2. Every untrusted display string is normalized through `clean` (`broker/sanitize.ts:19`) before it
   is bounded, so no downstream seam has to remember to do it. (Adopted at the same round, where the
   reader admitted raw control characters into a value a later section publishes on `GET /sessions`.)
3. Every bound sits behind every strip. A length cap applied before a character class is stripped is
   spent on characters the reader never sees, which turns a padded value into a dropped one or a
   truncated one, and `clean`'s own cap counts UTF-16 units, so a cap taken ahead of a strip can also
   split an astral pair and emit a lone surrogate. Normalize completely, then measure. (Adopted at
   Section 1's second review round, where `withoutInvisible(clean(value))` did exactly this: proved
   by running the real functions, 300 invisible characters ahead of a real name dropped the rename
   entirely, and 241 ahead of eight astral characters emitted a lone high surrogate.)
4. Adding a reader to a shared symbol means editing that symbol's own doc block in the same change.
   A doc that counts its readers, names them, or explains why it is exported goes stale the moment a
   new call site lands, and the staleness is invisible at the new site: the reader who is misled is
   the next one to arrive at the old one. (Adopted at Section 2's second review round, where
   `MAX_PEER_NAME_LENGTH`'s doc still said one reader outside the tailer shares the number after
   this section added two more. The same constant's doc was corrected once already at Section 1's
   third round, which is the recurrence that earns the amendment.)

## Sections of Work

### Section 1: The tailer reads `custom-title` (Model: sonnet)

- `TailItem` gains `{ kind: "title"; title: string }`. `null` never crosses this wire: the sibling
  seam's `null` means "clear the field" (`registry.ts:821`), so a title that could carry one would
  let a single malformed line wipe a good title. An unreadable value yields no item at all, which is
  what `goalCommand` already does by returning `undefined`.
- The record reader yields it for a `custom-title` line whose `sessionId` matches (the existing gate
  at `tail.ts:1648` already refuses a foreign one). The value is normalized in this order and the
  order is load-bearing: strip the invisible class and collapse whitespace runs, then `clean`, then
  cut at the reader's label bound. Every bound must sit behind every strip. A bound taken first is
  spent on padding a reader never sees: `clean` caps at 256 UTF-16 units, so a title padded with 300
  invisible characters caps to 256 of them, strips to nothing, and drops the rename outright, and
  the same UTF-16 cap can split an astral pair and emit a lone surrogate onto the wire. Ordinary
  whitespace is not in the invisible class but the render site collapses it (`render.ts` `visible`),
  so a name padded with 130 spaces otherwise stores five characters of name and 114 of padding, and
  draws as `Build …` with the rest of the session's name gone.
- An ill-formed value is refused outright, ahead of the normalization: a lone surrogate is in none
  of the classes the steps above strip, and `fit` only declines to create one, so nothing else
  stands between it and a `PATCH` body that has to be valid UTF-8. Refusing rather than repairing,
  because nothing legitimate writes one and keeping the thread's current name beats painting a
  replacement character onto it.
- The consumer at `tail.ts:2222` gains a `noteTitle` option on the `noteGoal` pattern, same
  error-withholding wrap. Its doc says plainly that this is the one note seam whose value is written
  to Discord, as the thread name.
- Tests in `broker/tail.test.ts`, cloned from the `goal` kind's: the line yields the item, a foreign
  `sessionId` yields nothing, an over-long value is cut in code points and an at-the-bound value
  passes through uncut, a value padded with invisible characters or whitespace recovers the real name
  rather than spending the bound on the padding, a value that is nothing but padding yields nothing,
  a non-string or absent value yields nothing, an embedded newline and an embedded escape are both
  stripped, and a throwing `noteTitle` costs its own reading and not the narration behind it.
  Expectations are literal values, never a re-evaluation of the reader's own expression.

### Section 2: The registry carries it and the title renders it (Model: sonnet)

Files in scope: `broker/registry.ts`, `broker/discord/state.ts`, `broker/discord/render.ts`,
`broker/discord/surface.ts`, `broker/discord/bindings.ts`, `broker/persistence.ts`,
`broker/sanitize.ts`, `broker/index.ts`, `import-hygiene.test.ts`, and their tests.

`state.ts` and `bindings.ts` were folded in at Section 2's open, because the plan named the wrong
homes for two of the types it changes: `SessionView` is declared at `broker/discord/state.ts:16`
and built field by field by `toView` at `:64`, not in the registry, and `ThreadBinding` is declared
at `broker/discord/bindings.ts:14` with its own shape validator and normalizer.

`persistence.ts` was folded in during the section, on a fork the plan did not see. Two types are
declared as the session record minus a named few, and both name the goal: `PublicSessionRecord`
(`broker/intake.ts:582`), which is what `GET /sessions` publishes, and `PersistedRecord`
(`broker/persistence.ts:31`), the registry's on-disk snapshot. Adding `title` to the record
therefore publishes and persists it unless it is added to those lists too, and the ruling is that it
is added to neither. The goal is excluded because a restored goal would draw as current long after
the session stopped working toward it; a title is identity rather than intent, a restored record
should carry the name the operator knows the session by, and the value is already drawn on a public
Discord thread, so withholding it from `GET /sessions` would protect nothing. Both seams copy field
by field rather than by deleting from a copy (`broker/intake.ts:585`, `broker/persistence.ts:292`),
so the exclusion type forces the decision and the rebuild is where a field is actually published.
The thread binding is the third route and forces nothing of the kind: it is a hand-declared shape
with its own validator, so a field reaches it only because somebody wrote one there.

`sanitize.ts` was folded in for the same section's third amendment: Section 1's refusal of an
ill-formed title guarded the transcript path alone, and the value re-enters from two files on disk
(`broker/persistence.ts` and `broker/discord/bindings.ts`) that were reading it under nothing but
the ordinary field clean, which caps in UTF-16 units and can split an astral pair of its own. As
built the fix went further than moving the scan. The reader's whole composition is one exported
function, `boundedTitle`: refuse an ill-formed value, then strip the invisible class and collapse
whitespace runs, then `clean`, then `fit` at the label bound, then check well-formedness once more
after the cut, since `clean`'s UTF-16 cap is what can split a pair and the code-point cut is what
carries the split half away. The tailer's `customTitle` and both restore paths call it, so the three
readers cannot drift, and an ill-formed value resolves to null at all three, falling through to the
launch name rather than painting a replacement character onto a live thread.

`boundedTitle` lives in `broker/sanitize.ts` rather than in the renderer that also draws the value,
which Section 2's review round settled. Written into `broker/discord/render.ts`, it made the storage
layer import the display layer: `persistence.ts` and `bindings.ts` reached a 2,400-line module that
itself imports `registry.ts` and `board/events.ts`, putting all of it on the load path a state file
is read through, one edge away from a cycle that type-checks clean and throws only at the first
restore. `visible` and `fit` moved down with it, since neither needs anything the renderer owns, and
`render.ts` re-exports `fit` and `boundedTitle` so the callers that already read them from there are
untouched. `import-hygiene.test.ts` pins the direction with a control, beside the tailer-and-router
pin that exists for the same class of hazard.

- `SessionRecord` and `SessionView` gain `title: string | null`; a `noteTitle(sessionId, title)`
  entry on the registry sets it, stamping nothing (a rename is not engagement and must not clear a
  blocked marker, the same exclusion peer prompts take). It early-returns on an unchanged value the
  way `noteGoal` does at `registry.ts:824`, because the `custom-title` line is re-emitted on every
  poll and an unconditional write would drive a record write per pass.
- `broker/index.ts:933` wires `noteTitle` from the tailer to the registry, beside `noteGoal`. Without
  it the Section 1 seam is dead code.
- `displayName` prefers `title` over `name`.
- Persistence: the binding persists the raw `name` (`surface.ts:205`, `name: entry.lastView.name`)
  and rebuilds a placeholder view from it on restore (`surface.ts:192`). So `title` rides beside it
  in `ThreadBinding` and in `placeholder`, or a restart rebuilds a view with no title, composes the
  launch name, finds it differs from the persisted `renderedName`, and repaints the thread back to
  the launch name. Note the name collision before writing: `ThreadBinding.title` already exists and
  means the fully composed thread title (glyph, name, state), so the new field needs a name that
  cannot be read as that one.
- Tests: registry sets and reads the field and stamps no engagement; `displayName` prefers the
  title; `threadName` with a title differing from the name composes the title; the surface test that
  covers "a session renaming itself" (or a new one on its pattern) sees `refreshName` paint the new
  title after the dwell and not before.

### Section 3: Live verification (Model: the worker session itself, one operator action)

Against the running broker, after `install/Repair-Broker.ps1` (elevated) has restarted it on the
new code: a session is launched under one name and renamed with `/rename`, which is a slash command
only a person at that session's keyboard can type, so the worker asks the operator over its own
thread to run the rename in a session of their choosing (the worker's own is fine) and reads the
result. The worker reads the thread title change on Discord (through `GET /sessions` and
`broker.log`, or the operator's word for what the phone shows), timing it against poll interval
plus dwell; then a second rename twice inside a minute confirms only the settled name is painted.

The evidence is `GET /sessions` and the thread itself, not the log. `broker.log` carries no line for
a rename that worked: the surface logs a rename only when it is dropped for budget
(`broker/discord/surface.ts`, the budget branch of `refreshName`) or when the call fails, and
returns silently on success. So read the log for a dropped-for-budget line and for a failure, and
read the absence of both as the rename having gone through rather than as its never having fired.
The title on the thread is the observation that settles it.

Then end the session and confirm the exited title and the archive still land, which is the budget
claim this plan most needs to see hold.

### Section 4: The security model names the tenth shape (Model: opus, Locus: inline)

Appended during Section 1's review round, which surfaced the surface: `docs/security-model.md:203`
states the tailer's extraction allowlist as "nine named shapes" and enumerates them, and this work
adds a tenth. The doc is the standard an auditor reads the code against, so a stale count there is a
defect rather than a tidiness item. Inline because it writes under `docs/`, which a dispatched
implementer is blocked from.

- Add the `custom-title` shape to the enumeration and correct the count.
- Give the title the egress inventory the `/goal` shape already carries at `:249-250`. The two differ
  and the difference is the point: the goal is withheld from `GET /sessions` and omitted from the
  on-disk snapshot, while the title is written to Discord as the thread name and is persisted in the
  thread binding, so its paragraph says so rather than borrowing the goal's.
- Record the reader's normalization as built: an ill-formed value refused outright, then
  `inertName` (the render site's own strip of the invisible class and collapse of whitespace runs),
  then `clean`, then the label bound through `fit`. `clean` is kept for the repo-wide rule and
  changes no value in that position.
- Record two accepted risks that currently live only in code comments, so they sit on the audit
  record rather than in a source file an auditor is not reading. First, the thread-identity half of
  the missing origin gate: anything that can append to a session's transcript renames that session's
  thread to any 120-character string, including another session's exact name, so an operator can be
  steering a thread they have misidentified. The composed glyph and state suffix stay true, and an
  approval verdict is already bound to its thread and request id, so what is at risk is steering
  rather than approval. Second, a title made only of printable-blank characters (the Hangul filler,
  the Braille blank pattern) passes every gate and draws as an empty thread name; the invisible
  class is deliberately a class of what renders as nothing everywhere rather than of what draws
  blank in some font, and widening it here alone would put this reader and the render site out of
  step.

## Traps, each with its handling

- **Budget starvation.** Two renames per ten minutes per thread, shared with the exited rename and
  the archive. A rename flurry cannot spend it, since the dwell restarts on each change and only a
  settled title is painted; but one settled rename inside the ten minutes before a session exits
  leaves one bucket slot for two writes. The archive already waits for the exited title
  (`surface.ts:407`) and retries on later passes, so the cost is a late archive, not a wrong one.
  Section 3 measures it.
- **Archived thread.** An archived entry never reaches `refreshName`; a rename on a dead session is
  dropped, which is correct, and a revived session repaints on its next pass.
- **Rename racing the create.** `open` composes the name at open time (`surface.ts:341`), so a title
  read before the thread exists simply lands in the create call and spends no rename.
- **The tailer's baseline.** The tailer reads forward from a baseline position that cannot reach
  behind it (the mirror-load-tolerance round). A `custom-title` written before the tailer attached is
  seen only if re-emitted. Inferred, not established: the line is re-emitted through a session (seven
  copies in this session's transcript), so the gap closes on its own; at launch the header carries
  the name anyway. Section 3 records whether a rename made before the first hook post is caught.
- **Two sources disagreeing forever.** By design: `title` wins when present, `name` is the launch
  label and stays what the header says. No reconciliation, no clobber.

- **No origin gate on the title, unlike the goal's.** The goal is read only off a line the operator
  typed at their own console (`tail.ts:1725`), a gate the security model names as load-bearing so
  untrusted content cannot write to the card. A `custom-title` line carries no origin field at all,
  so there is nothing to gate on: a session that can reach `/rename` renames its own thread and
  spends a slot of the per-thread rename budget the exited title and the archive share. Budget is
  the smaller half. The larger is thread identity: the new name is any 120-character string,
  another live session's exact name included, so an operator can steer a thread they have
  misidentified. What bounds it is that the glyph and the state suffix are composed by the broker
  and stay true, and that an approval verdict is already bound to its own thread and request id
  (`docs/security-model.md`), so what is reachable is misdirected steering rather than a misrouted
  approval. Accepted
  rather than fixed, because the line shape offers no discriminator and the value is bounded and
  neutralized on the way out; recorded here and in Section 4's egress paragraph so it is an accepted
  risk on the record rather than an unnoticed one. Whether a model can reach `/rename` at all is
  unverified from this repo.

## Acceptance

1. `/rename` in a **mirrored** session changes its Discord thread title to the new name, keeping the
   glyph and state suffix, within poll interval plus dwell, observed on the real thread.

   A `-NoMirror` session is carved out deliberately, and the carve-out is the correct behaviour
   rather than a gap to close. The tailer is suppressed for such a session (`broker/intake.ts:1001`),
   so its transcript is never read and its title never moves off the launch name by that route.
   One other route reaches it, found by Section 2's second review round: the title also re-enters
   from the broker's own state file and thread bindings, so a value planted in either is drawn even
   for a session whose tailer was never armed. Both files are already in the set that must not be
   writable, so this is a durability note on an accepted risk rather than a new one, and it is
   recorded in `docs/security-model.md` beside the missing origin gate. That follows from
   what the flag means: `-NoMirror` says this session's transcript content does not leave the
   machine, and the custom title is transcript content. A session that wants its thread renamed
   wants mirroring on.
2. The header's launch name never overwrites a tailed title (registry test).
3. A rename stamps no engagement and clears no blocked marker (registry test).
4. The suite's pass count is unchanged against the baseline recorded at the start of Section 1.
5. The exited title and archive still land after a renamed session ends (Section 3).

## Out of scope

Renaming the thread from Discord back into the session; changing `--name` or the wrapper; any change
to the surface's dwell or budget.

## Chapters

### Chapter 1 - 2026-08-26
Completed: Section 1: The tailer reads `custom-title`
Implemented By: implementer-sonnet (rounds 1 and 2), escalated to implementer-opus (round 3); the round-3 review's fixes applied in the main session
Metrics: 3 review rounds; NEEDS_CONTEXT 0; escalations 1 (sonnet to opus, earned on a repeating finding class); consults 0
Decisions / Surprises: The normalization runs `inertName` first, which is the render site's own `visible`, rather than a second whitespace regex beside it. That was the opus implementer's call and it is the right one: the reader now normalizes through the identical function the thread name is drawn through, so the stored title and the drawn title cannot drift. Its one visible consequence is that a newline is deleted rather than turned into a space (`Real\nName` stores `RealName`), because the newline is in the invisible class; that is the render's own answer and the spec now says so. The implementer also proved, and I confirmed by reading `broker/sanitize.ts:9,19` and `broker/discord/render.ts:894-909`, that `clean` is a genuine no-op in this composition: its control class is a strict subset of the invisible class already stripped, and its 256-UTF-16-unit cap can never be observed behind `fit`'s 120. The call is kept anyway, because Standing Amendment 2 binds and is not the implementer's to relax, and the function's doc says plainly that it changes no value there rather than claiming a guarantee it does not give. Round 3's review then found the class none of the three normalization steps covers: an unpaired surrogate arriving in the input, which `isInvisible` does not reach, `inertName` keeps whole, `clean` ignores and `fit` only declines to create. It is now refused outright ahead of the normalization. `String.prototype.isWellFormed` exists on this Node but is typed only from the `es2024` library, so the check is eight hand-written lines rather than a project-wide compiler-target move for one call.
Assumptions: `broker/index.ts` wiring belongs to Section 2 (2026-08-26, section 2), carried forward from Interim board 1.
Review Findings: Round 3 (adversarial, blind and security, all opus at max effort): 0 Critical. 3 Major, all addressed. The ill-formed-input gap (adversarial and security, independently) is fixed with the refusal above plus a three-case test watched red first. The throwing-note test pinned only that the error detail is withheld from the log and not the title itself, which `docs/security-model.md:357` names as a hard invariant; the assertion is added. The blind reviewer's Major, that `noteTitle` has no production consumer, is Section 2's assigned work rather than a Section 1 defect, and the blind lens has no spec by design so it could not know; recorded, not changed. Minors addressed: the literal zero-width character in a fixture replaced with the `ZERO_WIDTH` constant the same changeset introduces (all three reviewers flagged it), an explicit `null` fixture added, and four doc claims corrected that were false as written (the bound is not `peerName`'s measure, the render cuts again below this bound, the whitespace-padding counterfactual draws `Build …` rather than nothing, and `MAX_PEER_NAME_LENGTH`'s own doc said "peer-written" of a constant this reader now shares). Two accepted risks that lived only in code comments, thread-identity spoofing and printable-blank titles, are routed into the Traps section and Section 4 so they sit on the audit record.
Stamps: adjudicated 1, stamped 0 from the window list (`admin-seat-sandbox-precondition` was read from the recall digest and steered nothing here). Two records outside the list were stamped for fresh application: `node-test-count-lines-are-not-tap` and `probe-scripts-scratchpad-and-controls`.
Next: Section 2: The registry carries it and the title renders it
Commit Model: Commit-and-Push

Gate: `npm run lint` exit 0; `npm test` exit 0, 1529 tests, 1528 pass, 0 fail, 1 skipped, zero failure lines. Baseline at `3a887cf` was 1518/1517/0 over 58 test files, so this is +11 tests and no regression. The load-sensitive flake family the round-3 implementer identified is confirmed rather than reported: during the guard-removal probe, `a long reply the Stop mirror is still posting is not posted again by the tailer` went red alongside the intended test, and it touches no `custom-title` line. The mechanism is `broker/tail.test.ts:2700`, where `until` spins a bounded 1,000 `setImmediate` turns rather than waiting on a deadline, so a loaded box starves it; the box carried 46 node processes throughout. Not fixed here, and not this section's to fix.

### Interim board 1 - 2026-08-26

Written at the closure-drought floor: two review-round adjudications have passed with no section
closing, so this entry carries the state a Chapter would, in case a compaction lands here.

**In flight.** Section 1 only. Sections 2, 3 and 4 have not started.

**Section 1 stage.** Built, gate green, failed two review rounds, third implementation round running.

- Round 1 (implementer-sonnet, reviewed by adversarial, blind and security at opus/xhigh): four
  Majors. The reader computed its emptiness gate and its length cut from two different strings; the
  item carried a `null` the sibling seam reads as "clear this field"; the seam's doc claimed the
  value never reaches Discord when the thread title is exactly where it goes; and the over-long test
  asserted against the reader's own expression, so it could not fail.
- Round 2 (same implementer, same three reviewers): the fix was half applied. `clean`'s own
  256-unit cap sat ahead of the invisible strip, so the same class survived at the larger bound.
  Confirmed by running the real `clean`, `withoutInvisible` and `fit` against the reported inputs
  rather than by reading: 300 invisible characters ahead of a real name dropped the rename outright,
  241 ahead of eight astral characters emitted a lone high surrogate, and a name padded with 130
  ordinary spaces stored 120 characters that render as `Build …`.
- Round 3 dispatched to implementer-opus. The tier bump is earned rather than reflexive: the two
  rounds' surviving findings repeat a class (normalization ordering in `customTitle`, and a doc
  block misstating where the value travels, recurring at a new site), which is the ladder's own
  test for the implementer missing something rather than the spec generating it.

**Gate baseline.** Captured at `3a887cf` with `npm test`: exit 0, 1518 tests, 1517 pass, 0 fail, 58
test files. Last full run at the round-2 state, run by this session rather than reported: exit 0,
1525 tests, 1524 pass, 0 fail, 1 skipped. One flake reported by the round-1 implementer, "a mirror
run that landed nothing after the tailer deferred still gets the text posted", did not reproduce in
either of this session's two full runs.

**Rulings adopted since the run opened.**

1. An unreadable title yields no item at all rather than a `null`, over the spec's literal Section 1
   bullet and in favour of its Design paragraph. The Section 1 text now says so.
2. A `-NoMirror` session never follows a rename, and that is correct rather than a gap. Acceptance
   criterion 1 now says "mirrored session".
3. Three Standing Brief Amendments adopted, all recorded in this doc's own block above.
4. Section 4 appended, correcting the security model's "nine named shapes". Named to the operator
   over the relay at the moment it was appended, as Commit-and-Push requires.

**Assumptions declared.** `broker/index.ts` wiring belongs to Section 2 (2026-08-26, section 2): the
plan named neither section as its owner, and Section 2 is the one that creates the registry entry the
wiring hands to. Low blast, reversible, so decided rather than asked.

**Next action per section.** Section 1: adjudicate round 3, then a third review round, then close.
Section 2: dispatch at sonnet once Section 1 closes, since the two share the `broker/index.ts` wiring
site. Section 3: needs one operator keystroke and a broker restart on the new code. Section 4: inline
in the main thread, because it writes under `docs/`.

**Commit Model.** Commit-and-Push.


### Chapter 2 - 2026-08-26
Completed: Section 2: The registry carries it and the title renders it
Implemented By: implementer-sonnet under the predecessor session (build, review rounds 1 and 2); this session adjudicated round 3 and applied its fixes in the main thread, the predecessor having died mid-turn at 22:34Z on a harness fault with the section built and uncommitted
Metrics: 3 review rounds (rounds 1 and 2 by the predecessor, round 3 by this session); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: Three things moved that the spec did not foresee. First, `boundedTitle` left the renderer for `broker/sanitize.ts`, taking `visible` and `fit` with it. Written into `render.ts` it made the storage layer import the display layer, so `persistence.ts` and `bindings.ts` pulled a 2,400-line module and its own imports of `registry.ts` and `board/events.ts` onto the load path a state file is read through, one edge short of a cycle that type-checks clean and throws only at the first restore. The move costs nothing, since neither function needs anything the renderer owns, and `render.ts` re-exports both so no existing caller changed. The same reasoning then reached the registry: `noteTitle` now bounds its own argument through `boundedTitle`, which is safe only because `sanitize.ts` imports nothing, so that leaf property is now pinned rather than merely stated in the module header. Second, two log lines went back the way they came. The section had started writing the title into `broker.log` at the stale-sweep line and the rename-drop line, which falsified `docs/security-model.md`'s bolded invariant that transcript content reaches the broker log at no level. Reverting both was the smaller change than weakening the invariant, and neither line was in this section's declared scope; `label(view)` was read first and confirmed to be the session ID alone, so the two lines were the whole breach. Third, and unplanned, the plan's Traps entry on the tailer's forward-only baseline is now confirmed rather than inferred: the wiring pin written this round failed for twenty seconds with a single `custom-title` line written just before the tailer attached, and passed in 401ms once the fixture re-emitted the line the way Claude Code itself does. Two smaller surprises are worth the next reader's time: the broker refuses to learn a transcript path whose filename is not the session's own id, which is what the first two failures of that pin were actually reporting; and `broker/registry.ts` imported nothing at all before this section, which is the property that made the renderer free to import it.
Assumptions: `broker/index.ts` wiring belongs to Section 2 (2026-08-26, section 2), carried forward from Interim board 1 and now discharged, the wiring being built and pinned end to end.
Review Findings: Round 3 ran four reviewers over the uncommitted tree, all at opus: adversarial, blind and security over the code at xhigh, and a second adversarial over `docs/security-model.md` at max, that file being Section 4's inline deliverable and so reviewed at no tier headroom. 1 Critical, 4 Major, 16 Minor, and the Critical and two of the Majors are one finding that four reviewers reached independently: the broker-log egress above, fixed by the revert. The other Majors: nothing pinned the `broker/index.ts:939` wiring the spec calls out as the thing keeping Section 1 from being dead code, now covered by an end-to-end test that drives a real transcript through a real broker and reads the title off `GET /sessions`; and the storage-imports-display edge, fixed by the move. Minors addressed: `displayName`'s doc block still described a two-way fallback that is now three-way (Standing Amendment 4's own class, third instance); `entry.sessionTitle` moved without persisting, so the on-disk binding lagged the sticky copy in exactly the case the field exists for; `cleanWellFormed` refusing a whole name where `boundedTitle` cuts a title, now carrying the reason the two answers differ; a missing blank line between two tests; and eleven documentation findings, all of them fixed in place, of which the substantive ones were an inventory that said five and enumerated six, a mitigation claim that the composed state suffix stays true when the same appender can move it, and a durability claim contradicted by the line's own re-emission. One finding was declined and is recorded here rather than fixed: the blind reviewer read the sticky-title rule in the surface as letting the thread and `GET /sessions` disagree indefinitely, which is true and is the deliberate trade the field exists for, since the alternative is a rebuilt registry record repainting a renamed thread back to its launch name and overwriting the only surviving copy of the rename. Its reversal cost is one line in `entryFor`.
Stamps: adjudicated the 6h window; `memq unstamped` listed none and reported 8 reads it could not attribute, which is the known shape recorded in `unstamped-lists-peer-session-reads` rather than an unaccounted stretch: this session's own reads came from one `memq recall` at start, and the rest are peer sessions on a shared sidecar. Five stamped for fresh application: `node-test-count-lines-are-not-tap` (the suite's summary is not TAP, so a `# tests` grep reads as zero failures on a red run), `crlf-per-file-in-windows-checkouts` and `verify-line-endings-by-reading-bytes-not-by-grepping` (this tree is mixed per file and within files; `core.autocrlf` is true, so the commit is unaffected), `edit-script-prose-belongs-in-its-own-file` (the shell would not carry this section's prose at all), and `unstamped-lists-peer-session-reads`.
Next: Section 4: The security model names the tenth shape
Commit Model: Commit-and-Push

Gate: `npm run lint` exit 0; `npm test` exit 0, 1557 tests, 1556 pass, 0 fail, 1 skipped over 58
test files, 48.2s on a box the machine coordinator serialized for the run. Baseline at `216674f`,
recorded at Chapter 1, was 1529/1528/0/1, so this is +28 tests and no regression: +24 from the
section as the predecessor built it, and +4 written this round (an import-hygiene pin on the
storage-to-display direction, a second pinning the normalization module as a leaf, an end-to-end
pin driving a `custom-title` line through a real broker to `GET /sessions`, and a registry test
that the title seam bounds what it stores).

The load-sensitive flake family Chapter 1 identified is now measured rather than asserted. Three
full runs on this tree: 92.07s with one other suite overlapping, where `broker/tail.test.ts`s
`a long reply the Stop mirror is still posting is not posted again by the tailer` went red and then
passed 171/171 alone; then 60.28s and 48.23s serialized, both with zero failures. The mechanism is
unchanged (`broker/tail.test.ts:2700`, where `until` spins a bounded 1,000 `setImmediate` turns
rather than waiting on a deadline, so a loaded box starves it), and it is still not this plan s to
fix. What the series adds is that the same suite on the same tree varies by more than 1.5x with
machine load, so a wall clock read across different contention states is not a comparison.

### Chapter 3 - 2026-08-26
Completed: Section 4: The security model names the tenth shape
Implemented By: main session, inline, the section writing under `docs/` where a dispatched implementer is blocked; drafted by the predecessor session and finished here after its round-3 review
Metrics: 1 review round (adversarial alone at opus and max effort, no tier headroom over an inline opus writer; blind: no code diff, the section's only changed file being documentation); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The section's four deliverables were already drafted when this session picked the plan up, and the review round is what finished them. The one that mattered is not in the section's own list: the changeset it documents had falsified a standing invariant elsewhere in the same file, that transcript content reaches the broker log at no level, and the doc had not moved. The fork was to weaken the invariant or to revert the code, and the code lost: two log lines were writing the title, neither was in Section 2's declared scope, and a bolded invariant an auditor reads is worth more than a nicer log line. So this section's paragraph now names the broker log as somewhere the title does not go, which is a claim the code earns rather than a carve-out. The rest of the round was accuracy against the code as built, which is the standard this file is held to: an egress inventory that said five and enumerated six, a compile-error guarantee that covers the published and persisted records but not the hand-declared thread binding, a mitigation resting on a composed state suffix the same appender can move, and a durability claim the line's own re-emission contradicts.
Assumptions: none.
Review Findings: 1 Critical, 3 Major, 8 Minor, all addressed in place. Critical: the falsified log invariant above, closed by reverting the two code lines rather than by amending the claim. Majors: the five-against-six inventory; the state-suffix mitigation, now saying plainly that the glyph and separator are the broker's own while the suffix is derived from signals the same appender reaches, cross-referenced to the accepted-risk list; and the durability claim, now qualified to a session whose tailer is never armed or has ended, since a live mirrored session's planted title is corrected at the next re-emitted line. Minors: the thread binding named as forcing nothing; the reason for the `clean` step stated and the well-formedness recheck reframed as a property of the composition rather than a fact about one caller's bound; the thread-create call named beside the rename as an egress route; the per-pass ten-call ceiling distinguished from a rename-rate number the broker does not hold; "empty thread name" corrected to an empty-looking name inside a composed title whose glyph and suffix still render; the claim that these risks are absent from the code dropped, since both sit in code comments; and a ragged line reflowed. Two accepted risks now also carry one-line bullets in the document's own canonical accepted-risk inventory, where the sibling transcript-attribution risk already sits, rather than living only in the transcript section's prose. Two further properties the security reviewer surfaced are recorded in the same paragraph: a title has no clearing path at any layer short of an in-session `/rename`, and a title alternating in one of the two dwell-skipping states can hold the per-thread rename bucket empty, which leaves a thread frozen at a stale title and unarchived. One ragged line at the same seam was left alone: it predates this work and sits in HEAD.
Stamps: adjudicated in Chapter 2's walk of the same window, which covers this section's span; none surfaced beyond the five recorded there.
Next: Section 3: Live verification, which needs one operator keystroke and an elevated broker restart
Commit Model: Commit-and-Push

Gate: the same run Chapter 2 records, this section having changed one documentation file and no
code: `npm run lint` exit 0; `npm test` exit 0, 1557 tests, 1556 pass, 0 fail, 1 skipped over 58
test files. The code half of this section s work is the revert Chapter 2 describes, which that run
covers.