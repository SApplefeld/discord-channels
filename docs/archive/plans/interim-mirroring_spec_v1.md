# Interim Mirroring: Mid-Turn Visibility on Long Turns

Status: Complete
Commit Model: Commit-and-Push
Fable Spend: research, briefs, and reviews in the main session; implementation dispatched
Created: 2026-08-07

## Problem

On a long turn, the operator watching the Discord thread sees nothing between their prompt and the
turn's final reply, which can be many minutes later. Two gaps, reported together on 2026-08-07:

1. **Mid-turn assistant text never mirrors.** The text the model writes between tool calls (intent
   narration, findings, status notes) is carried by no hook payload: `UserPromptSubmit` carries the
   prompt, `Stop` carries only `last_assistant_message`, the turn's final text. The broker cannot
   mirror what never reaches it.
2. **The card names the last tool without its input.** "Last tool: Bash" says something is running
   but not what; on a multi-minute command the operator cannot tell a build from a hang.

## Confirmed ground

Measured this session, not assumed:

- **Every hook payload carries `transcript_path`.** `tools/hook-capture.jsonl` holds real captured
  payloads carrying it beside `session_id` and `cwd`, and the project memory file
  `claude-code-channel-and-hook-facts` records it as measured across all four hook events.
- **The transcript is line-per-content-block JSONL.** Across 35 transcripts in this project's
  history (771 assistant lines), no line mixed content-block types: `thinking`, `text`, and
  `tool_use` each get their own line. A text line looks like
  `{"type":"assistant","isSidechain":false,"sessionId":"<id>","message":{"content":[{"type":"text","text":"..."}]},...}`.
- **Other line types are numerous and must never be published.** One 1195-line transcript held 329
  `attachment` lines, 158 `user:tool_result` lines, 144 `assistant:thinking` lines, and 58 each of
  `custom-title`, `last-prompt`, `mode`, and `bridge-session`. This is why the filter below is an
  allowlist.
- **`isSidechain` is present but never true in this project's history** (0 occurrences across all 35
  files), so subagent traffic is not observed to land in the main session's transcript on this
  build. The filter keeps the check anyway; the load-bearing filter is the `sessionId` match, which
  is verifiable.
- **The card is repainted on a timer, not per tool call.** `broker/discord/surface.ts` repaints only
  when the rendered text differs, on the `CHANNEL_DISCORD_REFRESH_MS` tick (default 5s). So a
  preview that changes on every tool call costs at most one edit per refresh tick per session, not
  one per tool call. The plan's card-edit-volume worry is therefore already bounded by the existing
  design; no coarsening layer is needed.

## Decisions taken at pick-up

These were the plan's open questions. Each is settled here, with the reason, rather than asked.

- **Poll, not `fs.watch`.** The latency bar is tens of seconds and the live-session count on one
  machine is single digits. Polling is a `stat` and a bounded read per live session per tick;
  `fs.watch` on Windows adds a per-file OS handle and a change-event model that fires on metadata
  writes too. Reversible if the cost ever shows up.
- **The tailer suppresses the echo; the Stop mirror is untouched.** The `/mirror` Stop hook posts
  the final reply within milliseconds of turn end, and the tailer reads that same text off the
  transcript on its *next* poll, up to a poll interval later. So the duplicate arrives from the
  tailer, and the tailer is where it is suppressed. The reverse guard is kept too (a rare race where
  a poll lands inside the turn's last moment), so the memory is consulted from both sides.
  Rejected: having Stop stop posting when interim mirroring is on. That degrades to *silence* when a
  transcript is unreadable, where this degrades to the operator seeing a paragraph twice.
- **Per-session opt-out is honored.** A session that set `CHANNEL_SESSION_MIRROR` off (the wrapper's
  `-NoMirror`) must not have its mid-turn text published either. The header only arrives on
  `/mirror` posts, so the intake tells the tailer to drop that session when it sees the header off.
  `UserPromptSubmit` fires at the start of every turn, so the suppression is recorded before that
  turn can produce any interim text.
- **`CHANNEL_INTERIM_MIRROR` defaults on.** The operator reported the gap; a feature that ships off
  answers nothing. It is also gated behind `CHANNEL_MIRROR`, so the existing host-wide off switch
  turns it off with everything else.
- **The transcript path is never persisted and never published.** It is held in the tailer's own
  in-memory map keyed by session ID, learned from hook posts. After a broker restart the next hook
  post from a live session re-teaches it, which costs at most one poll interval of narration. This
  keeps `SessionRecord`, `redact()`, and `SessionView` free of a local filesystem path.

## Sections of Work

### Section 1: A bounded tool-input preview on the card

Model: opus

The card's `Last tool:` line gains a bounded, neutralized preview of what the tool was called with.

**Extraction (`broker/intake.ts`).** `parseIntake` currently drops `tool_input` with a comment
saying it is "of no use to any surface the broker renders". That comment becomes false and is
rewritten rather than left. In its place, a shape-aware probe: when `tool_input` is a JSON object,
take the first string-valued field present among an ordered key list, and nothing otherwise.

The key list, ordered, is `command`, `file_path`, `pattern`, `url`, `description`, `path`, `query`,
`prompt`. Ordered rather than per-tool-named so an MCP tool or a tool Claude Code adds later still
gets a useful preview instead of nothing, and so there is no per-tool table to keep in step with a
harness this project does not control. A non-object `tool_input`, an absent one, and an object with
none of those keys all yield no preview.

The extracted value goes through `clean()` like every other payload string, which strips control
characters and caps at `MAX_FIELD_LENGTH` (256). That is the storage bound; the display bound is
below.

**Carriage.** `HookIntake` gains `toolInput: string | null`; `SessionRecord` gains
`lastToolInput: string | null`. The registry sets both `lastTool` and `lastToolInput` together on a
`PostToolUse`, so a tool with no extractable preview clears the previous tool's preview rather than
leaving a stale one attached to a new tool name. `SessionView` gains `lastToolInput` and `toView`
copies it, field by field as that file requires.

`redact()` in `broker/intake.ts` publishes it on `GET /sessions` (it is already-neutralized,
already-capped tool metadata of the same class as `lastTool`, which that route publishes).

**Persistence compatibility.** `SessionRecord` is persisted whole via `onMutate`, and
`isSessionRecord` in `broker/persistence.ts` validates every field. A snapshot written by the
current build has no `lastToolInput`, so a strict `optionalString` check would reject the whole
snapshot and the broker would come up with an empty registry, losing every live session's thread
binding on the first restart after this ships. The loader must accept `undefined` for this field and
normalize it to `null`. A test drives a v1 snapshot with no `lastToolInput` field and asserts the
records load.

**Render (`broker/discord/render.ts`).** The card line becomes:

```
Last tool: Bash · git status --porcelain
Last tool: Bash · npm test -- --reporter=dot --grep "the very long … (cut)
```

The preview is `inertText`-escaped like every other card field, cut to `MAX_TOOL_INPUT_PREVIEW = 100`
code points through the existing `fit`, and marked ` (cut)` when `fit` shortened it. The cut marker
follows `promptField`'s discipline and its reasoning: a tool input is attacker-influenced text, so
it can front-load the harmless part, and a reader must be able to tell a whole preview from a
partial one. `SEPARATOR` (`·`) joins the name to the preview, so the tool name stays first and
readable when a thread list or a narrow phone view truncates. With no preview the line renders
exactly as it does today.

**Acceptance criteria.**

1. A `PostToolUse` payload with `tool_input: {"command":"npm test"}` and `tool_name: "Bash"` renders
   `Last tool: Bash · npm test` on the card.
2. A `PostToolUse` with `tool_input: {"file_path":"D:\\x\\y.ts","content":"..."}` previews the path,
   never the content: the ordered key list reaches `file_path` and stops.
3. A preview containing Discord chip syntax (`<@123>`, `<t:0:R>`) renders as those characters and
   draws no pill and no live timestamp.
4. A preview longer than 100 code points renders cut and carries the ` (cut)` marker; one at or
   under 100 carries no marker.
5. A `PostToolUse` whose `tool_input` has none of the listed keys clears any preview the previous
   tool left, leaving `Last tool: <name>` alone.
6. A registry snapshot written without `lastToolInput` loads with every record intact and the field
   `null`.
7. `GET /sessions` publishes `lastToolInput` and still withholds `processToken`.
8. Every existing test still passes.

### Section 2: The transcript tailer

Model: fable

**New module `broker/tail.ts`.** It owns a map of session ID to `{ path, offset, suppressed }` and
nothing else about the world; everything it needs from the broker arrives as injected callbacks, the
same shape `threadFor` already uses.

```
createTranscriptTailer({ liveSessions, deliver, echo, log, now, readFile })
  -> { learn(sessionId, path), suppress(sessionId), poll(): Promise<void>, forget(sessionId) }
```

**Learning a path.** `parseIntake` gains `transcriptPath: string | null` (read with `payloadString`,
so it is control-character stripped and capped like every other field). The intake calls
`tailer.learn(record.sessionId, intake.transcriptPath)` after a `/hook` post is credited to a record,
and `handleMirror` calls `tailer.suppress(holder.sessionId)` on the `X-Channel-Mirror`-off branch.
The path is stored, never trusted as content and never used as anything but an argument to a read.

**A poll pass.** For each session the registry currently holds `live`, that is not suppressed, and
that has a learned path:

- Read the file from the held byte offset. Read is bounded: at most `MAX_TAIL_READ_BYTES` (256KB)
  per session per pass; past that the offset jumps to the file's current end and the skip is logged
  by count, never by content, because a session that outran the tailer is better served by current
  narration than by a backlog.
- **Consume only up to the last `\n`.** A trailing partial line is left unconsumed and the offset
  stops before it. This is the classic tailer bug and it fails silently as a dropped chunk.
- If the file's size is *below* the held offset, the file was replaced or truncated: reset the
  offset to zero and re-scan is wrong (it would republish the whole conversation), so reset the
  offset to the file's current end and log it. A session ID maps to one transcript file that only
  grows; a shrink means something the tailer does not model.
- Parse each complete line as JSON, discarding parse failures silently (a transcript is written by
  another process and a half-flushed line is not an error).

**The allowlist.** A line yields text only when *all* of these hold, checked as an allowlist and
never as a denylist:

- `type === "assistant"`
- `isSidechain !== true`
- `sessionId === ` the session ID this transcript was learned for
- `message.content` is an array
- the block's `type === "text"` and its `text` is a non-empty string

Everything else is discarded: thinking blocks, tool calls, tool results, attachments, system lines,
user lines, and every line type not enumerated here including ones this build has never seen. The
`sessionId` match is what carries the weight, because it is the one field that is verifiable against
live data; `isSidechain` is defense against a build that starts interleaving subagent traffic.

**Posting.** Each surviving text block is one interim chunk, posted in order through the existing
routing and rendering path. `MirrorKind` in `broker/discord/render.ts` gains a third member,
`interim`, with attribution `✨ Claude · working\n`, unquoted like `reply`, since the quoted block
is the one that must stay unforgeable. `renderMirror` treats it exactly as `reply` (uncapped, split
across messages, chips escaped). `OutboundRouter` gains
`interim(sessionId: string, text: string): Promise<ReplyResult>`, which resolves the thread with
`threadFor` directly (the tailer holds a session ID, not a process token) and delivers through the
same `deliver` / `inOrder` chain, so an interim chunk cannot interleave with the messages of a split
reply.

**Echo suppression (`broker/tail.ts` or a small sibling).** A per-session memory of two SHA-256
digests: the last interim chunk posted, and the last final reply mirrored. Digests rather than the
strings themselves, so no conversation text is held in broker memory past the moment it is posted.
Both sides consult it:

- the tailer skips a chunk whose digest matches either remembered digest;
- `outbound.mirror` with `kind === "reply"` skips a post whose digest matches the last interim
  digest, and records its own digest either way.

Comparison is on the normalized pre-render text (`withoutInvisible(text).trim()`), before any
escaping, exactly as the `CHANNEL_ENVELOPE` check at `broker/routing/outbound.ts:330` compares:
escaping must be able to neither hide a match nor manufacture one. The memory is dropped when a
session leaves the live set.

**Configuration.** Two knobs in `broker/config.ts`, read through the existing `strictFlag` and
`integerAtLeast` so a typo refuses at startup rather than silently picking a default:

- `CHANNEL_INTERIM_MIRROR`, default on, and additionally gated by `CHANNEL_MIRROR`: interim
  mirroring is mirroring.
- `CHANNEL_INTERIM_POLL_MS`, default 20000, minimum 1000.

Everything else is a constant with a comment.

**Wiring (`broker/index.ts`).** The tailer is constructed beside the registry, handed to the intake
and the outbound router, and driven by a `setInterval` alongside the sweep and refresh timers. The
interval is cleared in `stop()`, and the in-flight pass is awaited there the way `inFlight` already
is for the Discord refresh, so shutdown does not race a read. A rejection out of the poll is caught
and logged, never allowed to reach the process: under Node 24 an unhandled rejection on a timer
would take the hook intake down with it.

**Security posture (unchanged from the design, restated as requirements).**

- Transcript content is untrusted text of the same class as a mirrored reply, and reaches Discord
  only through `renderMirror`. No new escape is written.
- Transcript content never appears in the broker log at any level. Every log line here carries a
  static message, a session ID, a count, or a byte offset. A caught error object from a read or a
  parse is discarded unread, because a thrown error can quote the text that produced it.
- Only `live` registry sessions are read, only from paths learned from hook posts, and a session's
  reading stops the moment it leaves the live set or is suppressed.
- Nothing is queued and nothing is replayed. A chunk that cannot be posted now is dropped, the same
  rule the whole routing layer follows.

**Acceptance criteria.**

1. A transcript growing by an `assistant`/`text` line for a live, non-suppressed session posts that
   text to the session's thread under the `✨ Claude · working` attribution, on the next poll.
2. `thinking`, `tool_use`, `tool_result`, `attachment`, `system`, `user`, and an invented unknown
   line type each post nothing. Driven from a fixture built out of the real line shapes above.
3. A line whose `sessionId` names a different session posts nothing, even in the file learned for
   this one. A synthetic line with `isSidechain: true` posts nothing.
4. A file whose last line is incomplete (no trailing newline) posts the complete lines only, and the
   next pass, after the line completes, posts it exactly once.
5. The turn's final reply, arriving first through the Stop mirror and then again as the tailer's
   next read, posts exactly once. Proved in both orders.
6. A session whose `X-Channel-Mirror` header is off posts no interim text after that header is seen.
7. With `CHANNEL_INTERIM_MIRROR` off, or `CHANNEL_MIRROR` off, no interim text is posted and no
   transcript is read at all.
8. A transcript that is unreadable, absent, or not JSON produces no post, no throw, and no broker
   log line carrying any of its bytes.
9. A file that shrank below the held offset resumes from its new end rather than republishing.
10. No log line produced by this section contains transcript text. Asserted, not eyeballed.
11. Every existing test still passes.

### Section 3: Documentation and operator checks

Model: sonnet

`docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`, and `docs/operator-checks.md`
carry the two new surfaces: the knobs and their defaults, what the tailer reads and what it refuses
to publish, the trust class of transcript content, and an operator check that walks a long turn and
confirms mid-turn narration lands once, with the working attribution, and that the final reply is
not doubled. `broker/README.md` gains the tailer module in its map. Prune the backlog of anything
this effort retires.

## Deliberately out of scope

- No queueing and no replay: an interim chunk that cannot be posted now (budget, closed thread) is
  dropped, consistent with the whole routing layer. Late narration answers a question the operator
  stopped asking.
- No subagent transcripts.
- No configuration surface beyond the two knobs named above; every other bound is a constant with a
  comment.
- No change to the permission-prompt or reply-tool paths.
- No change to the plugin-packaging effort in `docs/plans/channel-quality-and-plugin_spec_v1.md`,
  which is In Progress and blocked on the operator's own verification.

## Chapters

### Chapter 1: The card says what the tool is working on

Delivered in this changeset. `PostToolUse` payloads now yield one bounded field of `tool_input`,
carried on the session record to the status card's `Last tool:` line.

**What shipped.** An ordered key probe in `broker/intake.ts` takes the first previewable string from
`tool_input` (`command`, `file_path`, `pattern`, `url`, `path`, `description`, `query`, `prompt`),
cleaned like every other payload string. It rides `HookIntake.toolInput` to
`SessionRecord.lastToolInput`, through `toView` to `SessionView`, and renders as
`Last tool: Bash · npm test`, escaped with `inertText`, cut at `MAX_TOOL_INPUT_PREVIEW = 100`, and
marked ` (cut)` when cut. `GET /sessions` publishes it; `processToken` stays withheld.

**Decisions and surprises.**

- The ordered probe beat a per-tool table because the tool vocabulary belongs to a harness this
  project does not control. Walked against the tools actually watched: Bash, Read, Edit, Write,
  Grep, Glob, WebFetch, Task, WebSearch all preview usefully. `NotebookEdit` (`notebook_path`) and
  `BashOutput` (`bash_id`) preview nothing, which is a blank line rather than a wrong one.
- The snapshot validator had to be widened before the field could ship. `isSessionRecord` rejects a
  whole snapshot on one malformed record, so a strict check on a field older snapshots do not carry
  would have emptied the registry on the first restart after this shipped, taking every session's
  Discord thread binding with it. `absentOrString` accepts the absence and `cleanRecord` normalizes
  it to null. Driven red first against the strict check, which failed with exactly the predicted
  "holds malformed records, starting empty".

**Review findings addressed.** Both fresh-context reviewers independently returned CHANGES_REQUIRED
on the same defect, and all four fixes are in this changeset.

- The registry set `lastTool` behind a guard and `lastToolInput` unguarded. A `PostToolUse` carrying
  an input but no usable `tool_name` therefore left the previous call's name beside this call's
  input, and the card asserted a pairing that never happened. Both now move under the one guard,
  which still satisfies the "a tool with no preview clears the last one" criterion. Driven red
  first: the probe reproduced `'rm -rf /'` rendered under a previous `Read`.
- The tool *name* rendered with no length cut beside a bounded preview. At the wire cap, with every
  untrusted field markdown-dense, the card reached roughly 2247 characters against a 1900 ceiling,
  and the whole-card `fit` cuts the tail, which is where `Turns:` and `Heartbeat:` live. The name is
  now cut to `MAX_TOOL_NAME_LENGTH`. Driven red first, failing on `Turns:` missing from the card.
  Worst case now lands near 1835, about 65 characters of headroom: a future card field has to be
  paid for rather than assumed.
- The key list's docstring said "a path before a free-text description" and the array shipped the
  opposite. `path` moved ahead of `description`, and the order is pinned by a test.
- `broker/config.ts` and `broker/intake.ts` called `/hook` "the content-free liveness path" in three
  places. That became false the moment the route kept a tool-input preview, so all three now state
  what the route actually carries.

**Accepted, not engineered around.** Card-edit volume rises: a preview changes on nearly every tool
call, so an active session's card now differs on nearly every refresh tick where before it was
byte-identical between heartbeat buckets. The per-session cost stays at the one edit per tick the
spec pre-authorized. The residual both reviewers named is that `maxCallsPerTick` is 10 across all
sessions, so several busy sessions can crowd one pass. It is self-healing, since the next pass sees
the same difference, and this is a single-operator machine. Revisit if a card is ever observed
visibly stale during a busy stretch.

**Deferred to Section 2, deliberately.** A session launched with `-NoMirror` opted out of having its
content mirrored, and its tool arguments now reach Discord on the card regardless. The machinery
that knows a session is suppressed is Section 2's; wiring it here would build it twice.

**Gate.** Baseline before the section: 489 tests, 488 pass, 0 fail, 1 skipped, lint clean, at commit
`b4a2cbb`. After: 501 tests, 500 pass, 0 fail, 1 skipped, lint clean. No existing test changed
status. Re-run in the main session rather than taken from the implementer's report.

**Next.** Section 2, the transcript tailer.

### Chapter 2: Mid-turn narration, read from the session's own transcript

Delivered in this changeset. `broker/tail.ts` polls each live session's transcript file, extracts the
assistant text blocks written between tool calls, and posts them to that session's thread under
`✨ Claude · working`.

**What shipped.** The intake learns a session's `transcript_path` from any credited `/hook` post and
learns its mirror verdict from any `/mirror` post. The tailer holds a per-session tail position and
reads only whole lines, only from live sessions, only past a held byte offset, bounded at 256KB per
session per pass. The line filter is an allowlist: `type === "assistant"`, not a sidechain,
`sessionId` matching the session the path was learned for, `message.content` an array, the block a
`text` block with a non-empty string. `MirrorKind` gained `interim`, rendered by the same
`renderMirror` a mirrored reply uses, so no second escape and no second splitter exists. Two knobs,
`CHANNEL_INTERIM_MIRROR` (default on, gated by `CHANNEL_MIRROR`) and `CHANNEL_INTERIM_POLL_MS`
(default 20s, bounded 1s to 5m).

**The decision that changed under review: the mirror opt-out now fails closed.** As first built, the
tailer read a session's transcript unless it had been told not to. Three reviewers independently
found that this inverts the direction the `-NoMirror` switch fails in. Under the hook-only design,
suppression meant the hooks posted nothing, so an absent signal meant absent content. The tailer
reads the content itself, so an absent signal meant publish. A broker restart mid-turn, or a session
going stale and reviving, dropped the in-memory suppression and would have published the mid-turn
prose of a session that asked not to be mirrored.

Persisting the suppressed set was the obvious fix and the wrong one: it hardens one ordering and
leaves the direction of failure inverted. The default is inverted instead. A session's transcript is
not read at all until an explicit mirror-on verdict arrives for it under the current process, which
every `/mirror` post from a live session carries. A normal session is re-armed at the top of every
turn by `UserPromptSubmit`, which is when narration is wanted anyway; a `-NoMirror` session can
never narrate under any restart or revive ordering. The consequence worth knowing: a broker
restarted mid-turn stays silent for the remainder of that turn rather than for one poll interval,
and the next turn re-arms it.

**Review findings addressed.** Nine, from three fresh-context reviewers (adversarial, blind,
security), all in this changeset and each driven red first.

- The reply digest was recorded before the reply was delivered, so a rate-limited or partly-landed
  Stop mirror poisoned the echo memory and the tailer then skipped the same text off the transcript,
  and the reply appeared nowhere. Both sides now record only on a landed post, which makes them
  symmetric: the tailer already did this.
- An echo digest was never consumed, so it acted as an indefinite blocklist. A turn ending with
  "Done." suppressed a later turn's mid-turn "Done." forever. A match now nulls the digest it
  matched, bounding the cost to one skipped chunk.
- A delivery that threw discarded every later chunk in the batch, whose bytes were already behind
  the offset and could not be re-read. Each delivery now holds its own failure.
- `stop()` did not await a genuinely in-flight pass: `poll()` answered a fresh resolved promise
  whenever a tick was skipped for overlap, so shutdown returned while a pass still held an open file
  handle. `poll()` now answers the running pass itself.
- The pass was sequential across sessions, so one session mid-way through a long split reply held
  every other session's narration. `broker/routing/outbound.ts` states the opposing principle where
  it keys its ordering chains by thread; the sessions now run concurrently, with the per-chunk order
  inside one session untouched.
- `CHANNEL_INTERIM_POLL_MS` had a floor but no ceiling, and Node clamps a `setInterval` delay above
  2147483647 to 1ms, turning the knob into the near-busy loop the floor exists to prevent. Now
  `bounded`.
- `transcript_path` went through the 256-character identity cap, and the longest real path on this
  machine measures 206. A truncated path never opens and leaves only a rate-limited pass-failed line
  forever, indistinguishable from an unreadable file. It now has its own reader that refuses rather
  than truncates, and that also refuses a UNC path, which on Windows would have made the broker
  open an outbound SMB connection carrying the operator's credentials.
- One log-hygiene assertion was missing on the interim path's partial-failure line.

**Rejected, with the reason.** One reviewer proposed reserve-then-roll-back on both sides of the
echo memory, to close the window where a poll in flight on the final text at the instant the Stop
hook posts yields a duplicate. Rejected: reserving lets the tailer skip a chunk on a reservation the
mirror then rolls back, and the tailer's offset has already advanced, so the rollback cannot bring
the text back. That trades a duplicate for silence, which is the trade backwards. The remaining
window degrades to the operator seeing a paragraph twice, which this plan authorizes by name.

Also rejected: awaiting the in-flight tail pass on the `failedToBind` path in `broker/index.ts`. It
matches how the existing Discord refresh is handled there, and changing one of the two is worse than
leaving both consistent.

**Accepted residuals.**

- In the race ordering, the turn's final reply can post under `✨ Claude · working` rather than
  `✨ Claude`. The count is right and the text is right; only the label reads as mid-turn.
- The `sessionId` gate in `assistantTexts` carries more weight than its comment suggests and has no
  early warning if a future build writes a transcript whose internal session ID differs from the
  hook's. It fails closed, to silence, so the cost is a feature that goes inert rather than one that
  publishes wrongly.
- A token-holding local process can aim the tailer at an unwrapped session's transcript by
  registering that session's unclaimed ID. This is the same same-user file read plus Discord post
  that `/mirror` already grants, so the capability class is unchanged; the fail-closed gate now
  makes it cost an additional forged `/mirror` post, and the path refusals remove the UNC variant.

**Unconfirmed, and only a real long turn can settle it.** That the Stop payload's
`last_assistant_message` is byte-identical to the transcript's final text block. It held across 758
sampled assistant lines, none of which carried more than one text block, but a turn ending in
several text lines would miss the digest and show the last paragraph twice. That is the authorized
direction.

**Gate.** Baseline before the section: 501 tests, 500 pass, 0 fail, 1 skipped, lint clean, at commit
`d90eb95`. After implementation: 532 / 531. After the review round: 541 tests, 540 pass, 0 fail, 1
skipped, lint clean. No existing test changed status at either step. Both gates re-run in the main
session rather than taken from a report.

**Next.** Section 3, documentation and operator checks.

### Chapter 3: The docs describe both surfaces, and the security model describes the new one honestly

Delivered in this changeset. `docs/architecture.md` gains the tailer as a component and the card's
tool-input preview; `docs/operations.md` gains the two knobs, the `tail:` log vocabulary, and the
mid-turn-restart behavior; `docs/security-model.md` gains the section this effort most needed;
`docs/operator-checks.md` gains check F; `broker/README.md` gains the module; `docs/backlog.md` has
its duplication-measurement item widened rather than closed, because interim narration is a third
stream in the same thread and the question it asks got bigger rather than answered.

**What the security model had to say.** Two of its existing claims stopped being true and are
corrected rather than supplemented. It described `-NoMirror` as suppressing what the hooks post,
which no longer covers the one stream the broker reads for itself, and it said the broker drops the
tool fields after parsing, which is now false for the bounded preview. The new section states the
thing the effort turns on: everywhere else, suppression means the hooks post nothing, so an absent
signal means absent content, and the tailer inverts that, so the arming gate exists to put the fail
direction back. Three residuals are named in "Accepted, and worth stating": an unregistered session
ID can be claimed and its transcript read, the line filter fails to silence rather than to
publication and does so quietly, and a turn's final reply can arrive labelled as mid-turn.

**Surprise worth recording for the next session.** The dispatched implementer could not write to
`docs/` at all: both `Edit` and `Write` are hard-blocked under that role in this harness, whatever
the content. It drafted `architecture.md` and `operations.md` into `.kit/scratch/` before the block
ended its run, and those drafts were reviewed against the as-built code and applied from the main
session; the remaining four files were written in the main session directly. A documentation section
in this project is main-session work, not dispatchable work.

**Gate.** 541 tests, 540 pass, 0 fail, 1 skipped, lint clean, unchanged from the end of Section 2,
which is what an all-prose section should do. Two claims in the applied drafts were checked against
the source rather than trusted: the `broker: a transcript poll pass failed` log string
(`broker/index.ts:150`) and the poll interval's 1s to 5m bounds (`broker/config.ts:91-92`). Five em
dashes arrived with the drafts and were removed.

**Next.** The whole-effort finishing pass: QA verification against every acceptance criterion, then
the finishing reviews, then this plan to Complete and into the archive.

### Chapter 4: The finishing pass, and what it caught in the prose

Delivered in this changeset. The effort is Complete.

**QA verification passed on every criterion.** All nineteen acceptance criteria across Sections 1
and 2 were confirmed by direct test execution or targeted code reading, none by a test that would
pass whether or not the behavior existed. The verifier additionally compared the tailer's test
fixture against a live transcript on this machine, field for field, which is the check that matters
most: the parser is written against another program's file format, and a fixture that drifted from
the real shape would let the whole suite stay green over a feature that had stopped working.

**The finishing review found nothing wrong with the code and four false claims in the prose**, which
is the right shape for a changeset whose code went through two review rounds and whose docs had gone
through none.

- `docs/security-model.md` said the mirror switch is "enforced at the broker rather than at the
  poster" for the tailer. False, and contradicted two paragraphs later in the same file: the arming
  verdict is poster-supplied, so a token holder forges one. The file now says the switch is advisory
  in exactly the same way it is for the mirror, and that what the tailer changes is the default
  rather than the enforcement.
- `docs/security-model.md` named three disclosure axes for the transcript path (never persisted,
  never on `GET /sessions`, never logged) and named none for the tool-input preview, which travels
  on two of those three: it is a session-record field, so it lands in the registry snapshot on disk
  and is published by `GET /sessions`. A `-NoMirror` session discloses a shell command line or a
  file path on all three surfaces, and the file now says so.
- `docs/architecture.md` said the liveness hooks carry "never the conversation itself". The Stop
  liveness entry is an `http` hook posting its whole payload, `last_assistant_message` included; the
  broker drops it unread, but dropping after receipt is not the same as not transmitting, which the
  security model already said elsewhere. The sentence confused what the broker keeps with what the
  hook carries.
- `hooks/settings-fragment.json` still called the liveness hooks "content-free" and used "the
  liveness hooks carry no content" as the justification for their not carrying the mirror switch
  header. This was the fourth site of a claim Chapter 1 corrected in three others, and the one that
  mattered most, because it was load-bearing for a design decision rather than merely descriptive.
  The standing rule is to sweep the whole tree for a banned pattern rather than the diff, and this
  is what that rule is for.

**One code change came out of the review.** The arming verdict fired on any `/mirror` post from a
live session, without checking that the payload named that session. Every process a wrapped session
spawns inherits its token, so a subprocess mirroring a conversation of its own could arm the parent,
which is exactly the traffic the router's straggler gate refuses to post. Permission now requires
the payload to name the session the token holds. Suppression deliberately does not, and the
asymmetry is the point: failing closed on weak evidence costs some narration, where failing open on
weak evidence costs privacy.

**Declined, with the reason.** The review reported that acceptance criterion 7's test pinned only
the withholding of the process token and not the publication of the preview. It cited the wrong
line; `broker/intake.test.ts:1258` asserts the published value directly, and the QA verifier
independently confirmed it. The review also flagged five source lines over roughly 100 columns:
there is no formatter config, no `.editorconfig`, and no lint gate in this tree, and the reviewer
correctly declined to call them violations of anything.

**Gate.** 541 tests, 540 pass, 0 fail, 1 skipped, lint clean, unchanged across the finishing pass:
the one code change replaced a weaker assertion with a stronger one rather than adding a test. The
single skip is a POSIX-only permission test and predates this effort.

**What only a human at a real host can settle**, and what operator check F exists to ask: that a
long turn narrates itself once from the phone, that the final reply is not doubled, and that a
`-NoMirror` session stays silent. The suite verifies the rendered strings and every ordering it can
construct; it cannot see a Discord client.
