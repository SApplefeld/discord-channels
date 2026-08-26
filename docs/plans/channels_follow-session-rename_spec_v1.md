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

## Sections of Work

### Section 1: The tailer reads `custom-title` (Model: sonnet)

- `TailItem` gains `{ kind: "title"; title: string | null }`.
- The record reader yields it for a `custom-title` line whose `sessionId` matches, with the value cut
  at the reader's label bound; an unreadable value yields `null`.
- The consumer at `tail.ts:2222` gains a `noteTitle` option on the `noteGoal` pattern, same
  error-withholding wrap.
- Tests in `broker/tail.test.ts`, cloned from the `goal` kind's: the line yields the item, a foreign
  `sessionId` yields nothing, an over-long value is cut in code points, a non-string value yields
  `null`, and the item reaches `noteTitle`.

### Section 2: The registry carries it and the title renders it (Model: sonnet)

- `SessionRecord` and `SessionView` gain `title: string | null`; a `noteTitle(sessionId, title)`
  entry on the registry sets it, stamping nothing (a rename is not engagement and must not clear a
  blocked marker, the same exclusion peer prompts take).
- `displayName` prefers `title` over `name`.
- Persistence: the binding already carries `name` so a thread outlives its session's record
  (`surface.ts:149`); the worker checks whether the composed `desiredName` is what persists (in which
  case nothing changes) or the raw `name` is (in which case `title` rides beside it).
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

## Acceptance

1. `/rename` in a running session changes its Discord thread title to the new name, keeping the
   glyph and state suffix, within poll interval plus dwell, observed on the real thread.
2. The header's launch name never overwrites a tailed title (registry test).
3. A rename stamps no engagement and clears no blocked marker (registry test).
4. The suite's pass count is unchanged against the baseline recorded at the start of Section 1.
5. The exited title and archive still land after a renamed session ends (Section 3).

## Out of scope

Renaming the thread from Discord back into the session; changing `--name` or the wrapper; any change
to the surface's dwell or budget.
