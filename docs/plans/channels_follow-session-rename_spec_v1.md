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
  so a name padded with 130 spaces otherwise stores 120 characters and draws as an ellipsis.
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

Files in scope: `broker/registry.ts`, `broker/discord/render.ts`, `broker/discord/surface.ts`,
`broker/index.ts`, and their tests.

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
plus dwell; then a second rename twice inside a minute confirms only the settled name is painted. Read `broker.log` for the rename line and for
a dropped-for-budget line, if any. Then end the session and confirm the exited title and the archive
still land, which is the budget claim this plan most needs to see hold.

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
- Record the reader's normalization: `clean` then the label bound, with the emptiness test taken
  again on the cut result.

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
  spends a slot of the per-thread rename budget the exited title and the archive share. Accepted
  rather than fixed, because the line shape offers no discriminator and the value is bounded and
  neutralized on the way out; recorded here and in Section 4's egress paragraph so it is an accepted
  risk on the record rather than an unnoticed one. Whether a model can reach `/rename` at all is
  unverified from this repo.

## Acceptance

1. `/rename` in a **mirrored** session changes its Discord thread title to the new name, keeping the
   glyph and state suffix, within poll interval plus dwell, observed on the real thread.

   A `-NoMirror` session is carved out deliberately, and the carve-out is the correct behaviour
   rather than a gap to close. The tailer is suppressed for such a session (`broker/intake.ts:1001`),
   so its transcript is never read and its title never moves off the launch name. That follows from
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
