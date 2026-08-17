# Channels: five render tweaks

Status: In Progress
Commit Model: Commit-and-Push
Created: 2026-08-16

Five small readability changes across the broker's Discord surfaces, requested by the operator
2026-08-16 from a live read of the fleet: the board card's project titles and plan order, the
name-change notices Discord writes into a session thread, the tasks block's second row, and the
state glyph vocabulary. Each is a render or routing change with no new state, no new config, and
no new Discord permission.

## Related

- [`../archive/plans/channels_board-markdown_spec_v1.md`](../archive/plans/channels_board-markdown_spec_v1.md):
  the round that put the board card on live markdown, whose `###` project heading and bullet list
  sections 1 and 2 reshape.
- [`../archive/plans/channels_pin-notice-cleanup_spec_v1.md`](../archive/plans/channels_pin-notice-cleanup_spec_v1.md):
  the round that built the pin-notice cleaner section 3 extends to the rename notice.
- [`../archive/plans/channels_fleet-card-layout_spec_v1.md`](../archive/plans/channels_fleet-card-layout_spec_v1.md):
  the round that settled the session card idiom the tasks block (section 4) draws in.

## Goal

The fleet reads better from the phone, in five specific ways.

1. **Board card, project title as a fenced block.** Each project's heading on the board card is a
   one-line fenced code block carrying the project name, instead of a `###` heading. Discord draws
   a fenced block as a full-width shaded box, and that box is what makes one project's list stop
   and the next start at a glance. Under `MAX_CARD_LENGTH` accounting a fence costs its two fence
   lines, and the name inside it is block-inert (`inertBlockField`: backticks substituted, no
   escapes drawn) rather than markdown-escaped, since a fence honors no backslash escape and a
   Windows-ish directory name would otherwise reach the operator doubled.
2. **Board card, most recent touch first.** Plans are ordered by the plan doc's modification time,
   newest first, so the top of the card is what moved last. Today the sweep lists a root's plans by
   filename and the card draws them in that order; the mtime is already on every `PlanReading`.
   Ordering is applied at the card, not the sweep, so the sweep's name-ordered listing (which the
   per-root cap is defined against) is untouched. See Open Questions for the one interpretation
   call.
3. **Session thread, no rename notices.** Every time the broker renames a session's thread (a state
   flip, an age tick past the dwell window), Discord writes a system message into the thread
   reading `ClaudeRelay changed the channel name: ✅ ASR: KB Updates · idle`. The broker deletes
   each one it caused as it arrives, exactly as it already deletes the pin notices its own pins
   write in the parent channel: same cleaner, same narrow triple gate, same non-retry policy.
   Deleting a message the bot itself authored needs no permission beyond what the bot has, so the
   install's permission list does not change.
4. **Session card, the tasks block's second row indented.** A task's description row currently
   starts at the separator column, so the two rows read as two entries with a dot in front of
   each. The description row drops its separator and starts two columns to the right of where the
   agent type starts, so it reads as the entry's continuation.
5. **State glyphs.** `idle` draws `⏸` instead of `✅`, and `needs you` draws `⏹` instead of `⏸`.
   The green check is the most attention-grabbing glyph on the thread list and it marks the least
   actionable state; the pause reads as "not doing anything" and the stop-square as "halted on
   you". One table, `GLYPHS` in `broker/discord/render.ts`, feeds the thread name, the session
   card title, and the fleet card rows, so the change is one edit plus its pins.

## Approach

Every change is a pure-render or pure-decision edit with a test that pins it, in the module that
already owns the surface. No new module, no new config, no new persisted field.

### The board card (sections 1 and 2)

`broker/board/card.ts`. The project label becomes `fenced([name])` where `name` is
`inertBlockField(lastSegment(root), MAX_PROJECT_LABEL_LENGTH)` (falling back to `unnamedProject`
when it neutralizes to nothing). The `PROJECT_HEADING` constant goes away. `sections()` charges the
fence's three lines where it charged one heading line, through the same `spent()` path, so the
overflow tail still tells the truth. The plan bullets under it are unchanged.

Ordering: `sections()` sorts each project's open plans by `reading.mtimeMs` descending before it
places them; ties (equal mtime, which two files written in one commit can share) break by filename
stem ascending so the order is stable across renders. Failures and truncation notes keep their
current position after the parsed plans. Project order: see Open Questions; the recommendation is
that projects also order by their newest plan's mtime, newest first, with the configured order as
the tie-break, and this spec is written to that recommendation.

Mock, at the shape the card draws:

````
📋 **Fleet: Board**
# 📋 Fleet: Board

```
sapplefeld-channels
```
- **channels_render-tweaks_spec_v1**
  - 0/6 · 3m
  - next: section 1
- **channels_board-markdown_spec_v1**
  - 4/4 · 2h · Draft

```
sapplefeld-claude-kit
```
- **kit_memory-decay_spec_v2**
  - 2/5 · 1d

card as of just now
````

### The rename notice (section 3)

`broker/routing/gateway.ts`. `classifyMessage` gains one more `delete` answer, inside the in-thread
branch and before `deliver`: the thread's parent is this host's channel, the type is
`MessageType.ChannelNameChange` (Discord type 4), and the author is this bot. All three bind, so a
thread the operator renamed by hand keeps its notice, and a broker sharing the guild deletes
nothing in another host's threads. Everything else in the in-thread branch is as it is.

The delete route today is bound to the parent channel id
(`broker/discord/adapter.ts`, `deleteMessage`, `/channels/${channelId}/messages/...`). A message in
a thread lives under the thread's id, so `deleteMessage` takes an optional `channelId` (defaulting
to the configured channel) and the gateway passes the thread id for a rename notice. The cleaner
(`createPinNoticeCleaner`) is renamed to what it now is (`createSystemNoticeCleaner`), and its log
line names which notice was refused. Non-retry, one log line per window: unchanged.

The Message Content intent is not involved; the type and author are on every message event.

### The tasks block (section 4)

`broker/discord/render.ts`, `rosterEntry`. The second row becomes
`" ".repeat([...lead].length + ROSTER_DESCRIPTION_INDENT) + described`, with
`ROSTER_DESCRIPTION_INDENT = 2` as a named constant beside `MAX_TASK_DESCRIPTION_LENGTH`, and the
description's room reduced by the same two columns so no row exceeds `MAX_BLOCK_WIDTH`. Before and
after, in the fence:

```
Tasks
14m · claude-kit:implementer-opus
    · Section 1 of the board card, the plan reader
```

```
Tasks
14m · claude-kit:implementer-opus
        Section 1 of the board card, the plan reader
```

The knob is `ROSTER_DESCRIPTION_INDENT`; "more" or "less" is one number.

### The glyphs (section 5)

`broker/discord/render.ts`, `GLYPHS`: `idle: "⏸"`, `"needs you": "⏹"`. Every test that pins a
thread name, a card title, or a fleet row through the literal glyph is updated to draw from
`GLYPHS` where it does not already; a test that must pin the literal (the vocabulary itself is the
claim) pins the new one. `docs/operations.md`'s thread-list example and its `needs you` sentence
change with it.

## Sections of Work

### 1. Board card: fenced project title
Model: sonnet
`broker/board/card.ts` (+ `card.test.ts`). The project label as a one-line fence carrying the
block-inert directory name; `PROJECT_HEADING` removed; budget accounting charges the fence's lines.
Tests: the label is a fence whose one content line is the name; a directory name containing a
backtick run reaches the card with no backtick inside the fence; a name that neutralizes to nothing
draws `project N` inside the fence; the overflow tail is right on a card that stops between a
fence and its first item (the fence and its first item are spent together, as the heading was).
References: `fenced` and `inertBlockField` in `broker/discord/render.ts`; the "Approach" mock.

### 2. Board card: newest touch first
Model: sonnet
`broker/board/card.ts` (+ test). Plans within a project by `mtimeMs` descending, stem ascending on
a tie; projects by their newest plan's `mtimeMs` descending, configured order on a tie, with a root
holding only failures or a truncation note (no mtime to order by) after every root that has one.
Tests: two plans in one root arrive name-ordered and draw mtime-ordered; a tie draws stem-ordered;
two roots configured A, B draw B first when B's newest plan is newer; a held plan (`heldSince`
non-null) orders by its parse's mtime like any other.
References: `PlanReading.mtimeMs` in `broker/board/plans.ts:104`.

### 3. Thread: delete the rename notice
Model: opus
`broker/routing/gateway.ts` (+ test), `broker/discord/adapter.ts` (+ test). The in-thread
`ChannelNameChange` own-authored delete in `classifyMessage`; `deleteMessage` takes the thread id;
the cleaner renamed and its refusal line naming the notice kind. Tests, at minimum, both directions
of every gate: own-authored rename notice in a thread under this channel deletes; the same notice
authored by another user delivers nothing and deletes nothing (it is a system message, so it must
not `deliver` either: pin the exact decision); the same notice in a thread under another channel
drops; an ordinary own-authored thread message still delivers; the parent-channel pin-notice path
is byte-for-byte as before. The adapter test pins the thread id on the route.
References: `classifyMessage` at `broker/routing/gateway.ts:66`; the delete route at
`broker/discord/adapter.ts:415`; discord.js `MessageType.ChannelNameChange`.

### 4. Session card: tasks description indent
Model: haiku
`broker/discord/render.ts` (+ test). `ROSTER_DESCRIPTION_INDENT`, the second row without its
separator and indented by it, room reduced to match. Tests: the second row starts exactly
`[...lead].length + ROSTER_DESCRIPTION_INDENT` columns in and carries no separator; no roster row
exceeds `MAX_BLOCK_WIDTH` for a description at the cap.
References: `rosterEntry` at `broker/discord/render.ts:1724`.

### 5. Glyphs and docs
Model: haiku
`broker/discord/render.ts` (`GLYPHS`), every test pinning the old literals
(`render.test.ts`, `surface.test.ts`, `index.test.ts`, `question-message.test.ts` and
`security/permission.test.ts` where they pin a state glyph rather than the verdict check),
`docs/operations.md` (thread-list example, the `needs you` sentence). Gate: a tree-wide grep for
`✅` and `⏸` after the change finds only the permission verdict and the answered-question headers,
which are not state glyphs and keep the check. Docs for sections 1 to 4: `docs/operations.md`'s
board card and tasks block paragraphs, `docs/README.md`'s pin-notice-cleanup row gains the
rename notice in one clause, and this plan is indexed.

## Out of Scope

- Suppressing the rename notice by renaming less often. The dwell window and the rename budget are
  their own tuned system; deleting the notice is cheaper and does not change what the thread list
  shows.
- Any change to the sweep's per-root cap or its name-ordered listing.
- Reordering the fleet usage card or the session card's other blocks.

## Operator Verification

Read from the phone after the broker restarts on the new build:

1. The board card: each project name sits in its own shaded box; the plan you touched last is at
   the top of its project; the project you touched last is the top project.
2. Open a session thread that has flipped state at least once since restart: no "changed the
   channel name" lines after the flip. Lines from before the restart remain (nothing sweeps
   history).
3. A session running a fan-out: the description rows sit visibly right of the agent type, no dot.
4. The thread list: an idle session shows `⏸`, one waiting on you shows `⏹`, and nothing shows the
   green check.

## Open Questions

- **Section 2, project order.** Decided 2026-08-16: projects order by their newest plan's mtime,
  newest first, configured order as the tie-break, so the top of the card is the project in focus;
  bullets within a project order the same way. The alternative (projects fixed in configured
  order, bullets reordered within) was weighed and passed over because the card's job is to show
  from the phone what moved last. Cost accepted: a project's box moves when a plan elsewhere is
  touched.

## Chapters

(none yet)
