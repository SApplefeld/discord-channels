# Operating the broker

## Where things are

| What | Where |
|---|---|
| Broker state (the session registry) | `%LOCALAPPDATA%\sapplefeld-channels\broker-state.json` |
| Thread bindings | `%LOCALAPPDATA%\sapplefeld-channels\discord-threads.json` |
| Host configuration | `%LOCALAPPDATA%\sapplefeld-channels\broker.env` |
| Bot token | `%LOCALAPPDATA%\sapplefeld-channels\discord-token.txt`, or wherever `CHANNEL_DISCORD_TOKEN_FILE` points inside the state root |
| Relay registration, rewritten per launch | `%LOCALAPPDATA%\sapplefeld-channels\relay-mcp.json` |
| Log file | `CHANNEL_BROKER_LOG_FILE` in `broker.env`, by default `%LOCALAPPDATA%\sapplefeld-channels\broker.log`, rotated at 5 MB with 5 files kept |
| Scheduled task | `SapplefeldChannelsBroker`, at logon, restarting every minute on failure |

The log is the first place to look when anything is wrong. Several failures here are deliberately
silent everywhere else: the `SessionStart` hook swallows every error so it can never slow or block a
session, the broker answers a misrouted or forged hook post with a quiet acknowledgement rather than
an error, and a dropped inbound message or permission prompt is logged and nothing more. The log is
where those become visible.

```powershell
Get-Content $env:LOCALAPPDATA\sapplefeld-channels\broker.log -Tail 50 -Wait
curl.exe -s http://127.0.0.1:8787/sessions
```

## When a broker looks stale, doubled, or wrong

One command kills, verifies, and restarts:

```powershell
D:\sapplefeld-channels\install\Repair-Broker.ps1        # health pass + restart
D:\sapplefeld-channels\install\Repair-Broker.ps1 -Pull  # update the checkout first (ff-only)
```

It stops the scheduled task, kills every process it can prove is this checkout's broker (the
node name plus the broker entry path in the command line, or a node-named process holding the
broker port with an unreadable command line, which is what an orphan left by a task stop looks
like), verifies the setup without stopping (state root, env, host name, token file, task
registration, node, HEAD commit and whether origin is ahead), restarts the task, waits up to 30 seconds for
`/sessions` to answer, and prints a one-screen summary. It never kills by process name alone: a
non-node process squatting on the broker port, or a node whose readable command line names some
other program, is reported with its PID and left alive, and the summary's readiness line then
says the port is still contested. It never touches settings, hooks, or ACLs; a broken install is
the installers' job.

The recurring failure it exists for: a task stop can orphan the broker process, which keeps
running stale code and holds the port so the replacement exits immediately with EADDRINUSE. The
tell is a log line pair of `gateway: connected` followed by `broker: failed to bind ...
EADDRINUSE`, over a broker that still answers `/sessions` with old behavior.

## The failure this design exists to make visible

`channelsEnabled` is a managed setting, and when it is off the channel server still connects and its
tools still work while channel messages silently stop arriving. The warning fires **at startup
only**, and a `claude-swap` seat rotation lands mid-session, hours later, so a swap onto an account
without `channelsEnabled` would kill message delivery with no signal at all.

The status card closes that hole, and it is why the card is a safety feature rather than polish. The
two paths fail independently: the card is fed by hooks running locally over loopback, while messages
ride the channel. If channels die on a swap, **the card keeps ticking**. You see a session that is
demonstrably alive and working while your messages go unanswered, which names the failure exactly.
Without the card, the same failure is indistinguishable from Claude ignoring you.

A thread whose card is updating but whose messages are ignored means channels are off for the current
session. Check which account `cswap` last moved to, and check the host's managed-settings file: a
local file at `C:\Program Files\ClaudeCode\managed-settings.json` is machine-scoped and honored on
every account, including a personal one, which is the durable fix rather than chasing the rotation.

## Reading a thread

Thread names are glyph-first because the mobile thread list truncates hard and the actionable part
has to survive truncation.

```
⚙ neo-intake · active
⚙ neo-migrate · active
⚙ scott-kit · active
⏹ neo-deploy · needs you
⛔ scott-kit-goal · blocked
⚠ asr-docs · exited
```

The name between the glyph and the state is the name the session currently goes by: what an
in-session `/rename` last set, or the name it launched under while nothing has. "Renaming a session"
below covers how one reaches the thread and how long it takes.

A title carries four states. `active` means the session is up, whether it is mid-turn or sitting
quiet. `exited` means the session ended, or that it went silent past the presumed-dead horizon.
`needs you`, the ⏹ glyph, means that session has a permission prompt open and is parked until you
answer it; it is recomputed on every refresh from the set of prompts still waiting, so it clears on
its own when you answer, and it is urgent enough to spend a rename immediately rather than waiting
out the dwell window. A pending prompt therefore reaches you twice: as a message that pings, and as
the thread's own name in the list. `blocked`, the ⛔ glyph, means a `/kit-goal` run in that session
recorded a blocked stop and nothing there moves until you engage it; it takes the ordinary dwell
rather than an immediate rename, and the alert described under "When a run is blocked on you" is
what reaches you quickly.

The title is coarser than the state the broker tracks because every rename writes a notice into the
thread that nothing can remove: an app cannot delete a thread-rename notice (Discord error 50021),
where a human account with Manage Messages can, so a title following every change would run a column
of notices down a thread you read for its content.
`working` versus `idle`, and how many tasks a session is waiting on, are on the card underneath,
which is edited in place and writes nothing into the thread.

The glyph alone says how much the state wants from you when the list truncates everything behind it:
the gear is running, the stop-square is halted on you, the no-entry sign is halted with nothing left
to try, and the warning triangle is over. The two you can clear are the stop-square, by answering the
prompt, and the no-entry sign, by engaging the session.

Renames are the scarcest resource here. Discord documents no limit on channel or thread modification
and says limits should not be hard-coded, so the broker reads the rate-limit response headers and
adapts, per thread rather than globally. A rename it cannot afford is **dropped, never queued**,
because a rename landing ten minutes late paints a state that stopped being true. The card underneath
is edited in a far looser bucket and carries the detail. The card opens with a heading naming the
session and its state, in a five-state vocabulary that splits the title's `active` into `⚙ working`
and `⏸ idle` and keeps `⏹ needs you`, `⛔ blocked` and `⚠ exited` as the title draws them, then a
fenced block of fields (host, session, state, model, context size, a
`From` row while the session is running below the model it opened with, and heartbeat), then one
fenced block per thing the session has to say about itself: the goal it is working toward, the tool
it last ran and what that tool was called with, and the subagents and background commands it is
waiting on. A section with nothing to show is left out rather than drawn empty, so a quiet session
is a short card.

## The channel's pins, and threads that put themselves away

The channel's pinned messages are the sessions that are running. The broker pins a session's card
while its session is live, unpins it when the session exits, and keeps the fleet usage and board
cards pinned permanently, so the pin list answers "what is running right now" without a scroll. It works by
reading the channel's own pins each pass and moving them toward that set, which is what survives a
broker restart and a card rebuilt after a deletion. A pin you added by hand is left alone.

This needs Discord's **Pin Messages** permission on the broker's channel, and it is worth knowing
that the older pin route answers `Missing Permissions` when the newer permission is what is actually
missing, so that error names the wrong cause. Without the grant nothing breaks: a refused pin writes
one log line and every other surface behaves exactly as it does without the feature.

Two costs come from Discord rather than from here. A channel holds at most fifty pins in total, the
ones you added by hand included, and the broker budgets its cards against what is left rather than
against all fifty; at the ceiling the oldest live sessions keep theirs rather than an older session
being evicted for a newer one, and one log line says how many were left unpinned. And pinning writes
a system line into the channel while unpinning writes none, so a host that starts many sessions pays
a line per session.

Separately, an exited session's thread archives itself unless the host turns that off. An archived
thread leaves the active list but is not destroyed: it stays readable and searchable, and posting in
it revives it. That matters because the session that exited wrongly is the one worth reading
afterward. A session that was only presumed dead and then comes back is picked up again on both
sides: posting revives the thread on Discord, and the broker drops the archived flag the moment that
session stops reading exited, so its card and its title resume being maintained and it is archived
again at its real exit.

## Renaming a session

`/rename` at a session's own console moves that session's thread title, and it is the only thing that
does. The broker reads the name off the session's transcript, prefers it over the name the session
launched under, and repaints the thread with the glyph and the state suffix intact. Nothing has to be
done in Discord, and renaming the thread from the Discord client is not a way to do it: the name you
type there reaches no session, and the broker does not read a thread's name back, so it stands until
the broker's own composed name next changes and overwrites it.

Expect it within about **80 seconds** on the defaults, which is one transcript poll
(`CHANNEL_INTERIM_POLL_MS`, 20 seconds) plus one dwell (`CHANNEL_DISCORD_DWELL_MS`, 60 seconds).
Renaming twice inside that window spends one rename rather than two, because the dwell restarts on
each change and only the settled name is painted. A session already reading `needs you` or `exited`
skips the dwell and repaints on the next pass.

Two carve-outs are worth knowing before you wait on one. A session launched `-NoMirror` never follows
a rename, because its transcript is never read at all, and that is the flag working as intended rather
than a fault: `-NoMirror` says this session's transcript content does not leave the machine, and the
name is transcript content. Its thread keeps the launch name for the session's life. And nothing
clears a title once set: a later `/rename` replaces it, but there is no path back to the launch name
short of starting a session under it.

The launch name is still what a session with no `/rename` is called, and it is still what the thread
falls back to when a rename yields nothing readable. A session launched without the wrapper, carrying
neither, draws as `session ` plus the first eight characters of its session ID.

## What a session is trying to finish

A session running under a completion goal shows it on its card, read from the goal command in the
session's own transcript. The line is drawn while the session is working and dropped the moment it
reads idle or exited, which is deliberate: a goal that completes need not write anything down, so
the end of one is not observable, and a card showing a finished goal indefinitely would be worse
than no goal line at all. A session that never set one shows nothing.

## Answering a permission prompt

When a session asks to run a tool, the broker posts one message into that session's thread and
mentions you. It carries the tool name, the tool's description, a preview of its input, and a
five-letter request ID:

```
@you Permission needed · qwtrb
Reply `y qwtrb` to allow or `n qwtrb` to deny.
Tool: Bash
What: Run the test suite
Input: npm test
```

Reply with exactly `y <id>` or `n <id>` and nothing else. The pattern is anchored at both ends, so a
sentence that merely contains a verdict is treated as prose and forwarded to the session instead. A
verdict is consumed as a verdict and never also delivered as chat, and answering consumes the
request, so the same message sent twice names nothing the second time.

A verdict is bound to the thread it was typed in as well as to the ID. An ID that names nothing open
in that thread gets an in-thread notice saying so rather than being matched against another session's
pending prompt.

Three ceilings govern volume, and they behave differently on purpose. Past **3 prompts a minute in
one thread** the message still arrives and is still answerable but stops mentioning you, so the phone
stops ringing for a run nobody could keep up with. Past **12 prompts a minute in one thread** a
prompt is dropped: it is logged, no notice is posted, and the session that sent it stays parked.
Across the whole host, **64 requests** may be open at once, and at the ceiling the newest is refused
rather than the oldest evicted, because the oldest is the session that has been waiting longest.

Inbound chat has its own ceiling: **20 messages a minute per session**. Past it a message is dropped
with a log line and no in-thread notice.

A message up to **4,000 characters**, Discord's own maximum, is delivered whole. Past that the text
is cut at 4,000 and, once the cut text has actually reached the session, the thread says so with a
notice asking you to resend the tail as its own message; a cut message that reached no session is
dropped for the reason its own ceiling names, with no notice about the cut. The cut is a backstop
for a future Discord cap change, not something a message a client can send today will hit.

A message you type in a thread reaches the session as your own steering, at the same standing as
the keyboard: the relay's instructions tell the model every delivered message has passed the sender
gate. The same instructions keep the confirm-first discipline: the model is told to confirm before
anything irreversible or outward-facing, exactly as at the console. A session reads those
instructions once, when its channel connects at launch, so an edited instruction text reaches the
next session to start rather than the ones already running.

## When a session asks you a question

A session can park itself on a multiple-choice question at the console (the `AskUserQuestion`
picker). For a session whose hooks include the `PreToolUse` question entry (any session started
after the install that added it), the broker is told the moment the question is asked and posts
one alert into the thread within seconds, while the picker is still open, mentioning you. For a
session on an older hook set, the transcript tailer still recognizes the call in the session's
transcript, but Claude Code writes that line only when the picker is answered, so the fallback
alert arrives at answer time, which tells you what was asked but not that anything is waiting:

```
@you ❓ Waiting on you · 2 questions · answer here or at the console

**1. Commit model** · Commit model for this effort?
**2. Sections** · Which sections ship first? *(pick any)*
[ select ]  [ select ]
[ Send answers ]  [ Answer at console ]

_Typing a reply here answers in your own words instead._
```

**A long ask is readable in full below its controls.** The broker composes a message to at most
**1,900** units, Discord's own ceiling less room for a cut marker, and an ask past that spills: a
question whose options or whose own text the body could not draw ends its block on a marker saying
the rest is readable in full below or at the console. What spilled is posted as plain messages
under the interactive one, each opening `❓ Question continued from above`
and carrying the whole block of every spilled question: its number, its header, its question text,
and every option with the full gloss the call wrote for it. One ask posts at most **6** of them.
Past that the last one ends by naming how many options it did not draw and sending you to the
console; the pickers still offer every option either way, so nothing past the cap is unanswerable,
only unread in the thread.

The continuations land before the controls appear, and they are spaced **1,200 milliseconds** apart
so a run of posts cannot crowd the budget permission prompts ride. A maximal ask therefore takes
about **7.2 seconds** between the alert and the interactive message. They are never edited and never
deleted, so they stand as thread history after the ask closes, which is also why an ask released
part way through posting can leave continuation text above a message that now names the console. A
post Discord refuses ends the upgrade rather than skipping the text: the hold is released, the
message rewrites to the console line, and the log names which post of how many failed. A marker
pointing at a message that never arrived would send you hunting for text that does not exist.

**Answer it from the thread.** Pick from a question's menu, or tap a button when the ask is a
single question with a handful of options, then Send; a single-question ask sends on the one tap.
Typing a reply instead answers the whole ask in your own words. Whichever way you answer, the
session takes it as your answer at the picker and carries on, and the message rewrites itself to
show what was submitted.

**Answer it at the console instead** by tapping Answer at console, which releases the question and
renders the picker at the keyboard within a second or so. That is also what happens on its own if
nothing answers within the hold: the question falls back to the console picker, and the thread
message says so. Until then the console shows the tool call thinking rather than a picker, because
a held question renders none.

A question you answer at the console flips its thread message to say so, so a message that still
shows live controls is a question still waiting. Two windows are worth knowing. A message typed in
the moment between the alert landing and its controls appearing is taken as the answer even though
the controls were not up yet. And a message that happens to read as a permission verdict, a yes or
no followed by exactly five letters, is treated as a verdict first: it becomes the question's
answer only when no permission request is waiting for it.

One question raises one alert: the ask-time post records a digest that the answer-time transcript
read recognizes and skips. That memory is deliberately short-lived, so a mirror toggled off and
back on, or a session taught a new transcript path, while a picker sits open can let the same
question alert a second time when it resolves. A duplicate ping is the designed direction on
every branch of that dedupe, chosen over the alternative of a question that alerts nowhere.

Both alert sources ride the tailer's question seam and its mirror-verdict gate, so alerts land
only where mid-turn narration does: a host with `CHANNEL_INTERIM_MIRROR` or `CHANNEL_MIRROR` off,
and a session launched with `-NoMirror`, get no alert at all, at ask time or answer time, and the
question stays visible only at the console. The alert rides the same unfloored
writer tier as a permission prompt, with its own per-thread window:
**1 mention and 4 posts per thread per minute**. Past the mention ceiling the alert still posts
but stops pinging; past the post ceiling it is dropped and the log says so. A real session asks
questions minutes apart, so hitting either ceiling means a runaway or forged transcript rather
than a session you are failing to hear.

Continuations are counted in a second window of their own, **8 posts per thread per minute**, with
its own stamps rather than the alert's. One maximal ask fits inside it; two asks needing six
continuations each in the same thread inside a minute do not, so the second has its remaining posts
refused and its hold released to the console. The whole question surface therefore costs one thread
at most 4 alert posts plus 8 continuation posts a minute.

## When a run is blocked on you

A `/kit-goal` run that records a `BLOCKED:` stop is halted until you deal with it, and the thread
says so in three places. The kit's own Stop hook writes a `goal-blocked` line to its goal event
stream, the broker reads it within a refresh, and from then on the thread title carries
`⛔ <name> · blocked`, the card underneath draws `⛔ blocked` on its state row (with the waiting-task
count still beside it when the session had a fan-out running), and one alert posts into the thread and
mentions you:

```
@you ⛔ **Blocked** · docs/plans/channels_blocked-state_spec_v1.md - the run is stopped on you; the reason is in this thread
```

The alert carries the plan and nothing else. Why the run stopped is in the thread above it, in that
turn's own final reply, which is where the `BLOCKED:` prose was mirrored.

**Engaging the session is what clears it.** Typing at the console, answering from the thread, and the
run's own next completed tool call all stamp the same engagement clock, and the state clears as soon
as that stamp is newer than the event. The card follows on the next refresh and the title one dwell
window later (`CHANNEL_DISCORD_DWELL_MS`, 60 seconds by default), so a `⛔` title outliving the card
by a minute is the damper rather than a stuck state. Two things deliberately do not clear it: the
blocked stop's own turn-end hook, which would otherwise erase the marker it just raised, and an
`AskUserQuestion` picker opening, which is the session parking on you rather than leaving you. Two
prompts do not clear it either, both machine-written: a background task finishing and waking the
session, and a message another Claude session sent this one. In both cases the woken turn's first
completed tool call clears it, if the run genuinely resumes.

**The ping fires once per block episode, and only while the block is news.** The episode is the
event, so a run that blocks one plan and carries straight on to the next pings without the `⛔` ever
reaching the title, which is wanted: the run did stop on you. An event older than **10 minutes** when
the broker first observes it is not pinged at all and shows as the `⛔` title alone, which is what a
broker restarted over a backlog does. The alert rides its own per-thread window of **1 mention and 4
posts a minute**, separate from the permission prompt's and the question alert's; past the mention
ceiling it lands quietly, and past the post ceiling it is dropped with a log line. A post that fails
is retried on the next pass for as long as the block stays fresh, and a session whose thread is not
open yet simply waits for it.

Three limits are worth knowing before you read the absence of a `⛔` as good news. A standing block
is exempt from the silence backstop: a session blocked overnight keeps its `⛔` however long it
sits, where any other session silent past `CHANNEL_DISCORD_EXITED_AFTER_MS` (4 hours) renders
exited. The price of the exemption is the inverse misread: a session killed while blocked keeps
its `⛔` until the broker lets the record go, rather than flipping to exited at the backstop. The
event stream is a
plain file in your home directory that any process running as you can append to, so a crafted
`goal-complete` clears a real block and a flood of junk session ids can push a real one out of the
reader's 200-session map. And a block landing while the broker is down past the freshness bound
arrives as the title without the ping. The state is evidence when it draws and never proof when it
does not; [`security-model.md`](security-model.md) states that at the write's own paragraph.

Both readers of that file, this one and the board card's per-plan marker, resolve
`CHANNEL_BOARD_EVENTS_PATH`, so redirecting the knob moves the whole stream rather than half of it.
If no session ever draws `⛔` and the board card draws no blocked markers either, that path is the
thing to check.

**Four `broker:` lines report this surface**, each naming a cause and a session id and never the
plan text the events carry. `broker: the session surface could not read the goal event stream;
blocked states and their pings lag until it reads again` is logged once per outage rather than once
per tick. The other three belong to one episode's alert and are logged once per episode: `over its
window; the message is dropped` is the volume ceiling, `was not written; nothing is queued, the next
tick goes again while the block is fresh` is a refusal Discord returned, and `could not be posted;
the error detail is withheld, it can carry content` is a throw whose detail is dropped because it can
quote the message.

## The fleet usage card

One thread named **Fleet: Usage** carries a card the broker edits in place, so the channel answers
"how much headroom is left" without a walk to the console. It is off unless the host sets
`CHANNEL_USAGE_CARD`, and it appears within a refresh of the broker starting.

Each account on the card is a bold label over a fenced block. The label carries an active marker
(`▶` on the account claude-swap is currently on, `·` on the others), the account's address, and the
age of its numbers. Inside the block, one row per window: a bar of up to fifteen cells showing how
far through its budget the window is, the percentage, then the reset countdown or the spend amount.
Any usage at all draws at least one cell, so an empty bar always means a true zero, even beside a
trace that rounds to `0%`. A spend of a thousand and up is drawn whole; below that it keeps its
cents when it has any. A row can end in one marker: `(^)` on a weekly window ahead of pace (the same rule
claude-swap's own console applies), `(!)` on any window at or above 90%, and the warning wins when
both apply. The key to the markers is drawn at the foot only when a marker is on the card. Live
sessions get one more label-and-block pair, omitted when nothing is running, and a card that runs
out of room names what it dropped rather than ending mid-thought.

The bar's filled cells are drawn in one named constant, `BAR_GLYPH` in `broker/discord/render.ts`,
currently `—` (U+2014). This is the only card that draws a bar, so that constant is the whole of
where a swap has to land. That is a typographic character rather than a box-drawing one, so whether
consecutive cells tile into an unbroken line or leave hairline gaps between them is a property of
the font the reading client draws with. `─` (U+2500) is the swap on a client that leaves gaps.

The card reads claude-swap's own local files and never runs it. That is deliberate: the usage
endpoint behind claude-swap allows roughly thirty requests an hour per account, shared across every
machine and every consumer polling it, so a card that invoked the tool would be a fourth competitor
for a budget the auto-switcher already spends. What the card reads instead is the cache claude-swap
keeps beside its own state, which costs nothing and mutates nothing.

Read it as a mirror rather than as a source. Each account carries the age of the numbers beside it,
so a cache nobody is refreshing shows its numbers going stale rather than presenting them as
current, and an account whose polling is failing or backing off says so beside its last good
figures rather than in place of them. Countdowns are recomputed from each window's reset instant
rather than repeated from the strings claude-swap wrote when it fetched, because those freeze at
fetch time and drift. A weekly or per-model window whose reset has already passed is drawn for the
period it is in now, at zero, which is what the console shows for the same window: the alternative
would report you out of headroom against a window that has actually reset.

The card is edited only when its rendered text changes, which is not the same as a quiet fleet
costing nothing. Ages and countdowns are drawn to the minute below a day and to the hour beyond it,
so the honest steady state is about one edit a minute for as long as anything on the card is under
a day old, and the card genuinely settles only once every reading and session line has aged past
that mark.

## The fleet board card

One thread named **Fleet: Board** carries a second broker-edited card, answering "what is still open
and how far has it got" without opening a plan document. It is off unless the host sets both
`CHANNEL_BOARD_CARD` and `CHANNEL_BOARD_PROJECTS`, and off means nothing is built: no thread, no
timer, and no file opened.

`CHANNEL_BOARD_PROJECTS` is a semicolon-separated list of absolute project roots. Each is swept for
`docs/plans/*.md`, and every plan not marked Complete gets an entry. A `README.md` there is taken as
a directory index rather than a plan and is simply absent: it draws nothing, not even a line saying
it would not parse, and it does not count against the per-root plan cap. A root that is not a fixed
directory, meaning anything relative or drive-relative that would resolve against whichever drive the
broker happened to start on, refuses at load: the message names the entry's position rather than its
text, since a root usually carries your own account name. That refusal stops the broker starting even
with the card switched off, which is the same strictness the other typed knobs have, so a typo in a
board value is a start failure rather than a silently missing card. Two spellings of one directory
collapse to one root.

Each project is a label over a list, and the label is the last segment of the root, so choose roots
whose final segment is the project name. The label is drawn as a one-line fenced block, which
Discord paints as a full-width shaded box, and that box is what makes one project's list stop and
the next start at a glance on a phone. A name too long for the reader's window wraps inside the box
rather than scrolling out of it, and a name past **60** characters is cut with the mark that says
so. A plan is one bullet carrying its filename stem, with an indented sub-bullet beneath it carrying
the sections-complete count, the time since the document last moved, and the status, and a second
sub-bullet for the latest Chapter's `Next:` when there is one. The body is live markdown rather than
a fenced block, so a long name or a sentence-length status wraps at a word boundary with a hanging
indent instead of ending in an ellipsis at a fixed column. Within a plan's bullet the `Next:` line
is the one field cut, at **120** characters against the **400** the sweep takes in, and a cut one
carries the mark that says so.

The card is ordered by what moved last, so the top of it is what you are working on. Within a
project, plans are ordered by their document's modification time, newest first, with the filename
stem settling two that moved at the same instant. The per-root cap of **64** runs ahead of that, on
the sweep's name-ordered listing, so a project holding more open plans than the cap orders whichever
64 came first by name. That bound is far above any real project and is worth knowing only if you
ever hit it. Projects are ordered the same way, by the newest
plan under each. A project the card cannot date at all, because everything under it is a parse
failure or a truncation note, sinks below every project it can, which is worth knowing when a
project you are working in drops to the bottom: the plan stopped parsing. `CHANNEL_BOARD_PROJECTS`
settles only what the times leave tied, and it does so for configured and unconfigured roots alike,
since the modification time is the first key for every root that has one. The consequence worth
expecting is that a project's box moves down the card when you touch a plan somewhere else, since
nothing is pinned to a fixed position.

Two things are drawn by their absence, so they are worth knowing. A plan whose document declares no
sections draws no count, since a fraction of nothing measures nothing. And a plan whose status is
exactly `In Progress` draws no status at all: that is the ordinary state, nothing else occupies the
spot, so an entry with no status clause is a plan simply running. Any other spelling draws as
written, `In Progress (auto)` included, and draws whole. The exception is a status whose text is
all invisible characters, which draws `(unreadable status)` rather than nothing, so a document with
an unusable value there is never mistaken for one simply running.

A plan the broker cannot parse right now redraws its last good reading under a held marker whose age
climbs, rather than dropping off the card. A plan whose goal is blocked carries the age of the block,
cleared when the document moves again or when the goal completes. A card that runs out of room names
how many plans and projects it dropped.

The card is deterministic and spends no tokens: nothing between a plan file and the card involves a
model. It also reads the plan-doc contract exactly as the external engine does, sharp edges included,
so a section the card does not count as done is a section that engine does not count either, and the
fix is in the document rather than here.

Cost per refresh is small and bounded. A file is opened only when its modification time or size has
moved, and a file that fails to parse is held shut on the same terms rather than being re-read every
tick. A plan above 256 KB is refused whole rather than parsed as a prefix, and draws a bullet saying so,
so a truncated document never reaches the card as if it were complete; a real plan runs tens of KB.
Each root contributes at most 64 plan files.

## What a session card says about its model

A session's own card carries the model producing its turns and the raw size of its context, both
read from the transcript the tailer already follows. The count is raw rather than a percentage on
purpose: the window is a per-model fact that can change upstream, and a percentage keeps looking
authoritative after its denominator stops being true.

A session forced below the model it opened with carries a standing marker naming the drop and, when
upstream said why, its category. The marker stands for as long as the session runs below its
opening model, not just at the moment of the change, so a downgrade you slept through is still
visible hours later; it clears when the model returns, which is how you confirm from the thread
that a switch back took effect. A change also posts one message, on the quiet notice tier by
default and on the mention-bearing tier under `CHANNEL_MODEL_CHANGE_ALERT`.

Two forced downgrades exist and both are read. One is a safeguard refusal, where a model's own
guardrails flag a message and the session drops to a weaker model for the rest of its life. The
other is entitlement: the session's model needs usage credits and the consent prompt was dismissed,
so it fell back. That second one is the one you can act on, at the console with `/model`, and a
standing authorization to spend credits does not survive a dismissed prompt.

The marker's absence is not proof. Model families are matched by name, so a crafted model string can
render a genuine downgrade unmarked; whoever could do that already writes the whole line, so this is
a report rather than an authority.

Both the model line and the context size exist only for sessions with mirroring on, because the
tailer is the only reader and it never opens a suppressed session's transcript.

## What a session is waiting on

A session whose main thread is blocked on dispatched subagents fires no hooks at all, so liveness
alone would read it as idle at the moment it is working hardest. The harness reports its own table
of in-flight work at every turn end, and the card carries it in two places: the count beside the
state on the card's own state row, and the tasks themselves with their ages in a block below. The
thread title says only `active`, since a count that moved with the fan-out would spend a rename, and
a permanent notice in the thread, on every step of a drain. At any fan-out you are likely to see,
every task is named. A card omits one only when the message ceiling forces it, which is the bound
that decides in practice, since each entry takes two rows: the card starts from at most twenty-four
entries and drops them one at a time until the whole message fits. An entry reads as one thing
rather than two: the first row carries the age and the agent's type behind a separator dot, and the
second row carries the description with no separator of its own, indented two columns past where the
type starts so it reads as the entry continuing.

```
Tasks
14m · claude-kit:implementer-opus
        Section 1 of the board card
```

What the card keeps when it has to drop is the oldest, counting the rest as `+N more`, for two
reasons: the longest-running task is the one most likely to be stuck and so the most worth reading,
and keeping the oldest holds each entry in the same position as a fan-out grows, where keeping the
newest would reshuffle the list under you. Long-running background commands ride the same line,
since a command left running is the same kind of invisible work.

The roster survives a broker restart, so a restart in the middle of a fan-out does not go back to
reporting idle for the rest of the wait. It is replaced wholesale by each report rather than merged,
so a task that finishes disappears rather than lingering, and an exited session's card drops the
line entirely rather than aging work that no longer exists.

## Background-task wake notices

When a background subagent finishes while its session sits idle, the harness wakes the session by
injecting the subagent's entire final report as a prompt. By default the broker compresses that
wake to one line rather than mirroring the report as a quoted block spanning many messages:

```
📨 background task finished · a4f567e05ff9c7b5f
```

The session's own next reply, which summarizes what the subagent found, mirrors normally moments
later, so the thread keeps the readable account and loses only the raw report. The
`CHANNEL_TASK_NOTIFICATION` knob selects the behavior: `brief` is the default, `full` mirrors the
whole injected report, and `off` posts nothing.

`off` is silent on every surface but the log, where each suppressed wake writes one line naming the
session and no content. That line is the only thing telling a deliberately quiet wake apart from a
wake path that is broken, so check for it before treating a missing 📨 notice as a defect.

## Mid-turn narration and typed messages

On a long turn the thread otherwise shows nothing between the prompt that opened it and the final
reply that closes it, which can be many minutes later. `broker/tail.ts` polls each live session's own
transcript file and posts what the model wrote in between, in order, under a `✨ Claude · working`
attribution distinct from a mirrored reply's plain `✨ Claude`. It reads only what a hook has already
identified as belonging to that session's transcript, and posts through the same routing and
rendering path a mirrored reply uses. Narration carries the turn's own first chunk: the file's
position is taken when the session's mirror-on verdict arrives, seconds before the model writes
anything, rather than at the poll tick after it.

The same pass carries a message you type at the console while the model is working. The harness
queues such a message and injects it without firing the hook the mirror rides, so the transcript is
the only place it exists. It lands in the thread as an operator-attributed quote, in its place among
the narration around it, and the chunk after it starts a fresh message below your words.

In the thread, a working stretch reads as one growing message: consecutive chunks append into the
newest narration message by editing it in place (the `(edited)` tag on it is normal), and a new
message starts when the block is full or when anything else lands in the thread, your own message
included. Anything you type breaks the block, and the next chunk starts fresh below it.

A turn's close lands once. When the model sends its closing summary through the reply tool
(`📣 Claude · answer`) and the turn's final text says the same thing, exactly or nearly, the
mirrored `✨ Claude` copy is suppressed and the thread keeps the reply-tool message. A final
reply that carries materially more than the answer still posts in full, and a short summary
never suppresses a long reply: the comparison requires both near-identical wording and
near-identical length, so the fail direction is a duplicate message, never lost words.

A Markdown table in anything mirrored arrives as an aligned block rather than as the row of literal
pipes Discord would otherwise draw, because Discord renders no tables. The broker redraws the table
into a fenced monospace block whose columns are padded to line up, honoring the header's alignment
markers (`---:` right, `:---:` centered, left by default) and padding to the same width the cards
use, so a wide table has its cells cut rather than wrapped. Every mirrored surface draws it the same
way: a reply, a mid-turn chunk, and a narration append are indistinguishable on this. Three things
are deliberately left alone. A table already inside a code fence is untouched, since the author
meant it as text. A malformed table, one missing its delimiter row or with a row whose column count
disagrees with the header, is passed through unchanged rather than guessed at. And a table so large
that the redrawn block would not fit a message is mirrored as its raw text, on the reasoning that
literal pipes you can read beat a block that had to be truncated to exist.

Two knobs govern it, both in `broker.env`:

| Setting | Default | What it decides |
|---|---|---|
| `CHANNEL_INTERIM_MIRROR` | on | Whether the transcript is tailed at all, which is what carries mid-turn narration, a message typed at the console mid-turn, the open-question alert, and the recovery of a turn-opening prompt whose mirror hook was lost; also gated by `CHANNEL_MIRROR`, so the host-wide switch turns off everything below it too |
| `CHANNEL_INTERIM_POLL_MS` | 20 s | How often the tailer polls each live session's transcript; refuses below 1 s or above 5 min |

Turning `CHANNEL_INTERIM_MIRROR` off silences what the tailer carries, mid-turn narration,
mid-turn typed messages, the open-question alert, and the turn-opening prompt recovery among it.
The peer traffic it carries stops too, but not all of it: a peer message delivered to an idle
session arrives as prompt text on the mirror's own route and keeps posting, which is
`CHANNEL_PEER_MESSAGES`' business rather than this knob's. The question alert is the costly loss,
so it is worth deciding deliberately rather than as a side effect: a session parked on an
`AskUserQuestion` picker then signals nothing anywhere off the
console, where narration merely goes quiet. The prompt that opens a turn and the reply that closes
it ride hooks rather than the transcript, so both keep mirroring on an interim-off host whenever
those hooks land. What stops with the tailer is the second copy that covers a hook the CLI
abandoned under load: with interim mirroring off, a lost prompt and a lost closing reply are both
gone for good, where a host running the tailer usually recovers either within a poll interval.
Both recoveries sit inside the tailer's read position, the reach bound
[`install.md`](install.md) sets out; only the prompt is additionally gated on the shape of the
line, since the closing reply is read from an assistant text block that carries no such test.
`CHANNEL_MIRROR` off stops all of it, hooks included. The one-copy close above
survives an interim-off host, because the record the mirror compares against is written by the reply
tool rather than by the tailer, and it exists whenever `CHANNEL_MIRROR` is on. A session launched
with `-NoMirror` narrates nothing, carries none of the messages typed into it, and raises no
question alert, for the same reason its prompts and replies do not mirror: the tailer is never
armed for it.

**The log carries `tail:` lines**, each naming a session ID, a count, or a byte offset and never any
transcript text:

- `tail: session <id>'s transcript shrank below the held offset (...)`: the transcript file was
  replaced or truncated since the last pass; the tailer resumes from the file's new end rather than
  republishing the conversation from the start.
- `tail: session <id>'s transcript outgrew one pass (...)`: more grew between two polls than one
  pass reads; the excess is skipped and narration resumes from the file's current end rather than
  reading out a backlog minutes late.
- `tail: session <id>'s interim delivery failed (...)`: one chunk's delivery threw, and that chunk
  was dropped without holding up any other chunk in the same pass. This is the uncommon failure. A
  chunk Discord refused, or one for a thread that is not open yet, returns a status rather than
  throwing and logs under `routing:` instead, so narration that is missing without a `tail:` line
  to explain it should be looked for there.
- `tail: session <id>'s transcript-read prompt delivery failed (...)`: the delivery of one prompt
  the tailer read off the transcript threw, and it was dropped without holding up the rest of the
  pass. That prompt is either a message typed at the console mid-turn or the prompt that opened the
  turn, and the line does not distinguish them. This path put no copy in the thread. A mid-turn
  message reaches it by no other path, so the thread is missing it; a turn-opening prompt may
  still be there from the mirror hook, which usually posts it first. The console holds the words
  either way.
- `tail: session <id>'s peer message delivery failed (...)`: the delivery of one peer message the
  tailer read off the transcript threw, and it was dropped without holding up the rest of the pass.
  That message is either one another session sent this one mid-turn or one this session sent, and
  the line does not distinguish them. Neither reaches the thread by any other path, so the thread is
  missing it and the console holds the words.
- `tail: session <id>'s question alert was refused (...)`: an open-question alert was not written,
  because the per-thread window dropped it or Discord refused the write. The console still shows
  the question; the thread does not.
- `tail: session <id>'s question alert failed (...)`: the alert's delivery threw rather than
  returning a refusal, and it was dropped without holding up the rest of the pass. The console
  still shows the question.
- `tail: session <id>'s transcript pass failed (...)`: the file could not be opened or read this
  pass; the next pass tries again.
- `tail: session <id> was taught a transcript path whose filename is not its own session id (...)`:
  a hook post tried to teach the tailer a path whose filename stem is not the session's id, which
  no real transcript has; the path is refused and the entry keeps its prior path. If this ever
  appears for a healthy session, Claude Code has changed how it names transcripts, and that
  session's narration and fallback question alerts are dark until the pin is revisited.
- `tail: a poll pass is still running past the watchdog threshold (...)`: one poll pass has been
  running for several poll intervals, which means a wedge somewhere in a read or a delivery;
  without this line the only symptom would be narration quietly stopping for every session.
- `tail: <reason> occurred N more time(s) in the last 60000ms`: a repeat of one of the lines above,
  aggregated into one summary line rather than logged once per poll.

**Two `broker:` lines report a question that alerted and then could not be made answerable**, both
naming a session ID, counts, and the transport's error class and never any question text. `broker:
session <id>'s question could not post continuation N of M and released its hold` means an ask too
long for one message lost one of the plain messages carrying its overflow, so the hold went to the
console rather than leaving a marker over text that never arrived. `broker: session <id>'s question
kept the plain notice and released its hold` means the edit that turns the alert into the
interactive message was refused, so the thread carries the alert and the console carries the picker.
Either line ends with `found its hold already ended` instead when the ask closed while the write was
on the wire, which is not a failure to act on: the close-out already ran.

Two of the routing layer's drop lines report a mirrored reply suppressed as a duplicate, and neither
is a lost reply. `routing: the mirrored reply from session <id> was dropped, the tailer already posted the
same text as interim narration` is the deduplication between the tailer and the Stop mirror, and
the text is on the thread as narration. `routing: the mirrored reply from session <id> was dropped,
it matches the answer the reply tool already posted` is the deduplication between the reply tool
and the Stop mirror, and the text is on the thread as the `📣 Claude · answer` message. Another
line, `routing: the narration append from session <id> was refused, the chunk posts
fresh: <error>`, is not lost narration either: the edit was refused and the same chunk landed as its
own message, so the thread shows more headers than usual rather than missing text, but the line
repeating steadily means every edit is failing (the error class it carries says how) and coalescing
is effectively off. Nothing else goes quiet with it: the edit route spends its own rate-limit
budget, so a blocked PATCH bucket costs extra headers and leaves replies, mirrored text, notices,
and permission prompts untouched. A rejection out of the whole poll pass, which normal operation
should never produce, logs as `broker: a transcript poll pass failed; the error detail is withheld,
it can carry content`.

Two `routing:` lines report the one case where the deduplication above and a transport failure meet.
A path claims the turn's closing text when it starts posting, so the other path drops its own copy;
if that run then lands nothing at all, nothing else is still carrying the text, and the run goes
again once. `routing: the mirrored reply from session <id> landed nothing (...) with the other path
already deferred to it; its one retry posted N of M messages` is that retry working, and the thread
has the text. `routing: the <mirrored reply|interim narration|mirrored prompt|transcript-read
prompt|inbound peer message> from session <id> reached the thread by neither path` is the one to
act on: the retry failed too, the text reached the thread nowhere,
and the console holds its only copy. It is rarer than the duplicate it replaced, since it needs a
race and a total transport failure rather than a race alone, but it is the expensive direction and a
repeat of it is a defect rather than noise.

One further `routing:` line costs a message rather than a header. `routing: the transcript-read
prompt from session <id> was dropped, it is the operator's own channel message echoed back to the
thread it was posted in` is the check that keeps a message you typed in the thread from arriving
back in it a second time. A message typed at the console is recorded differently and never matches
that check, so this line beside a console message missing from the thread means the message opened
with the text the harness wraps a channel message in, and the console holds its only copy.

Two `routing:` lines report a prompt suppressed as a duplicate. The mirror hook and the tailer
both carry the prompt that opens a turn, so whichever dispatches first suppresses the other.
`routing: the transcript-read prompt from session <id> was dropped, the mirror hook had already
dispatched the same text to this thread` is the ordinary healthy case: the hook posts within
milliseconds of the prompt being typed, while the tailer reaches the same line on its next pass,
up to a poll interval later. `routing: the mirrored prompt from session <id> was dropped, the
tailer had already dispatched the same text to this thread, read off the transcript` is the tailer
having got there first, which means the hook took longer to arrive than the tailer's next pass over
that line. A run of that second line is the load symptom the raised mirror timeout addresses.
Neither line is a lost prompt on its own, with one exception, the same one the reply pair carries:
if the copy that won then lands nothing at all, the `reached the thread by neither path` line above
reports it under the subject `mirrored prompt` or `transcript-read prompt`, and that line is the
one to act on.

Two more `routing:` lines belong to the background-task wake above. `routing: the task notification
waking session <id> was dropped, task notifications are off` is `CHANNEL_TASK_NOTIFICATION=off`
working as set, and it is the only evidence of it anywhere. `routing: the task notice for session
<id> stopped after N of M messages: <error>` is the 📨 notice itself failing to post under `brief`,
with the transport's error class and no content. Neither line names which path the wake arrived on:
the hook-carried mirror and the transcript tailer's queued prompt write the same text, deliberately,
so one wake gets one answer whichever way it arrives.

**One operational surprise worth knowing.** Narration for a session is armed by a `/mirror` post
carrying that session's mirror-on verdict, not by the session simply being live, so a broker
restarted mid-turn narrates nothing for the remainder of that turn: the verdict that would arm it
already arrived before the restart, under the previous process. The whole transcript read is armed
together, so a question asked in that same unarmed stretch raises no alert either. The next turn's
`UserPromptSubmit` re-arms it as normal, and so do the interrupted turn's own `Stop` mirror post
and a credited `PreToolUse` question post, the first on the same `/mirror` route and the second
on `/hook`, which is this paragraph's one exception. What no re-arming recovers
is anything written before the tailer took its read baseline, so a prompt typed while the session
had no baseline reaches the thread by the mirror hook or not at all. See
[`security-model.md`](security-model.md) for why the gate fails in that direction rather than the
other.

## Peer traffic between sessions

Claude Code sessions message each other directly, and a session's thread carries both halves of
every exchange it is party to, so one surface shows a whole conversation without tabbing between
terminals. Peer traffic is drawn under a 📡 attribution of its own, and the direction is which side
of the arrow this session sits on:

```
📡 KIT: Messaging → **Claude**
the message that session sent, drawn below

📡 **Claude** → KIT: Messaging
the message this session sent, drawn below
```

The bold `Claude` is this session, always, and it is bold for a reason worth knowing: every
counterparty here is itself a Claude session, so a peer whose display name is `Claude` would
otherwise draw an identical header in both directions. A counterparty name goes through the full
markdown neutralization, so a name cannot supply that token.

**Peer traffic never renders in the `>>>` quoted block.** That block means the operator typed
something, and it is the one attribution this surface holds unforgeable. A peer message is drawn
outside it on every setting, which is what stops another session's words from arriving in the
channel permission prompts are answered in as if you had written them. For the same reason a peer
message never clears a `⛔` blocked state: the engagement stamp records that a person is driving,
and another machine writing is not that. A woken session that genuinely resumes stamps on its own
first completed tool call, so a run that really restarts still clears its own block.

Peer messages post on the mirror budget rather than the alert tier and ping nobody. An exchange
between two sessions is worth reading, not worth waking someone for. Under `full` a message longer
than **16,384** code points is drawn to that length and says it was cut, the bound a mirrored prompt
takes, because a peer body is text arriving from outside rather than this session's own words; under
`brief` each message is one line of at most **200** characters: the send's own summary outbound (its
message's opening line where the send carried no summary), and the body's opening line inbound.

Six `routing:` lines belong to this path, and each carries the direction and the session and never
the text, because a peer message is conversation content. `routing: the <inbound|outbound> peer
message for session <id> was dropped, CHANNEL_PEER_MESSAGES is off` is that setting working as set,
and it is the only evidence of it anywhere. On the inbound direction it ends `; a prompt read as
peer traffic is dropped here too`, which names the one thing this setting can delete: a prompt you
really typed that the classification misreads as a delivery reaches the thread nowhere under `off`,
where under `full` and `brief` the same misreading costs only the attribution. `routing: the
<inbound|outbound> peer message for session <id> was dropped, it carried no visible text` is a
message that held nothing once the invisible class was stripped. `routing: the <inbound|outbound>
peer message for session <id> was dropped, its thread is not open yet` is an exchange that happened
before the session's thread existed. `routing: the <inbound|outbound> peer message for session <id>
stopped after N of M messages: <error>` is the post itself failing, with the transport's error class
and no content.

The last two are the dedup working, and they appear only for a prompt the classification misread,
because a real peer message reaches a thread by one path only. `routing: the inbound peer message
for session <id> was dropped, the tailer had already dispatched the same text to this thread, read
off the transcript` is the hook's copy standing down behind the recovery's; `routing: the inbound
peer message for session <id> was dropped, the mirror hook had already dispatched the same text to
this thread` is the recovery standing down behind the hook's. Either one means the thread has the
words once, which is the intent; seeing neither beside a doubled message is the failure.

One vocabulary wrinkle is worth knowing before grepping. The two lines a run that landed nothing
produces, the retry notice and `reached the thread by neither path`, are written by the helper the
reply and prompt paths share, and it says `from session <id>` where every line above says `for
session <id>`. Both spellings name the same session.

## Tunables

Everything below lives in `broker.env` and takes effect when the broker restarts. Only these keys are
applied: `Start-Broker.ps1` reads the file against an allowlist and skips anything else with a
warning, because write access to that file would otherwise be arbitrary environment injection into
the process that reads the bot token.

A key you set by hand survives the next install. The installer merges rather than rewriting the file
from its own fixed list, preserving any key already there that is on the same allowlist and that the
install does not itself carry a value for. Anything off the allowlist is not preserved, which is the
same bound that keeps the file from being an injection surface.

Every boolean knob reads one vocabulary: `1`, `true`, `yes`, and `on` mean on, and `0`, `false`,
`no`, and `off` mean off, in any case. An empty value means the default, and anything else is
refused by name rather than guessed at.

| Setting | Default | What it decides |
|---|---|---|
| `CHANNEL_HOST_NAME` | the machine name | The host label on every card and record |
| `CHANNEL_BROKER_PORT` | 8787 | The loopback port. Must match the hooks; see below |
| `CHANNEL_BROKER_STATE` | state root | Path to the registry snapshot |
| `CHANNEL_STALE_AFTER_MS` | 5 min | Silence after which a session is marked stale |
| `CHANNEL_SWEEP_INTERVAL_MS` | 15 s | How often the staleness sweep runs |
| `CHANNEL_MAX_BODY_BYTES` | 64 KB | Ceiling on a hook or relay request body |
| `CHANNEL_RETAIN_TERMINAL_MS` | 24 h | How long an ended session is kept before pruning |
| `CHANNEL_MAX_SESSIONS` | 500 | Record ceiling, terminal records evicted oldest first |
| `CHANNEL_BROKER_LOG_FILE` | unset (console only) | The rotating log file |
| `CHANNEL_BROKER_LOG_MAX_BYTES` | 5 MB | Rotation size |
| `CHANNEL_BROKER_LOG_MAX_FILES` | 5 | Files kept, active plus rotated |
| `CHANNEL_DISCORD_TOKEN_FILE` | state root | The bot token file |
| `CHANNEL_DISCORD_CHANNEL` | unset | The channel threads are opened in |
| `CHANNEL_ALLOWED_USER_ID` | unset | The one Discord user allowed to steer this host |
| `CHANNEL_DISCORD_REFRESH_MS` | 5 s | How often the surfaces are reconciled |
| `CHANNEL_DISCORD_DWELL_MS` | 60 s | How long a state must hold before a rename is spent on it |
| `CHANNEL_DISCORD_IDLE_AFTER_MS` | 2 min | Silence after which a thread reads `idle` rather than `working` |
| `CHANNEL_DISCORD_EXITED_AFTER_MS` | 4 h | Silence after which a stale session is presumed dead and reads `exited` |
| `CHANNEL_DISCORD_ARCHIVE_ON_END` | on | Whether an ended session's thread is archived, so the channel reads as what is running; an archived thread stays readable and a post revives it |
| `CHANNEL_MIRROR` | on | Whether console prompts and turn replies are mirrored into the thread |
| `CHANNEL_MIRROR_MAX_BYTES` | 256 KB | Largest mirror post accepted; a larger one is dropped |
| `CHANNEL_TASK_NOTIFICATION` | brief | How a background task's wake prompt reaches the thread: `brief` posts the one-line 📨 notice, `full` mirrors the whole injected report, `off` posts nothing |
| `CHANNEL_INTERIM_MIRROR` | on | Whether the transcript is tailed, which carries mid-turn narration, mid-turn typed messages, open-question alerts, and the recovery of a turn-opening prompt whose mirror hook was lost; also gated by `CHANNEL_MIRROR` |
| `CHANNEL_INTERIM_POLL_MS` | 20 s | How often the tailer polls each live session's transcript; bounded 1 s to 5 min |
| `CHANNEL_PEER_MESSAGES` | full | How much of a message this session exchanges with another Claude session reaches the thread, in both directions: `full` draws each message whole under its own 📡 attribution, `brief` draws one line per message, `off` posts none of it. Volume only; attribution is not a knob |
| `CHANNEL_USAGE_CARD` | off | Whether the Fleet: Usage thread and its card exist on this host |
| `CHANNEL_USAGE_CARD_REFRESH_MS` | 60 s | How often the fleet card is re-read and re-rendered; bounded 5 s to 1 h |
| `CHANNEL_USAGE_CACHE_ROOT` | the profile's claude-swap backup | Where the usage cache and account list are read from |
| `CHANNEL_BOARD_CARD` | off | Whether the Fleet: Board thread and its card exist on this host |
| `CHANNEL_BOARD_PROJECTS` | none | Semicolon-separated absolute project roots swept for `docs/plans/*.md`; the card builds nothing without at least one |
| `CHANNEL_BOARD_CARD_REFRESH_MS` | 60 s | How often the board card is re-swept and re-rendered; bounded 5 s to 1 h |
| `CHANNEL_BOARD_EVENTS_PATH` | `kit-events.jsonl` under the profile's `.claude` | Where the kit's goal event stream is tailed from. One stream, two readers: the board card's per-plan blocked marker and the session surface's own `⛔` state and its alert, so redirecting this moves both. Read whenever Discord is configured, board card or not |
| `CHANNEL_MODEL_CHANGE_ALERT` | off | Whether a mid-session model change posts on the mention-bearing alert tier rather than the quiet notice tier |

Two keys in that file are metadata rather than settings. `CHANNEL_NODE_EXE` is the absolute path to
`node` pinned at install time, which `Start-Broker.ps1` reads directly so it never resolves `node`
from whatever PATH a logon happened to carry. `CHANNEL_TASK_USER` records the account that installed,
so a mismatch with the account the scheduled task runs as is something you can see in the file rather
than diagnosing from a broker that cannot read its own token.

Every knob **refuses a bad value rather than clamping it**, and the broker does not start. A knob
silently moved to a value you did not ask for is a knob whose behavior nobody can reason about later.

`CHANNEL_DISCORD_EXITED_AFTER_MS` is the one most likely to want moving. It is the backstop for a
session that was hard-killed: nothing fires a hook on a kill, so without it a dead session would show
the idle glyph indefinitely. Four hours is deliberately long, so that a slow tool call, a compaction,
or a session parked at a prompt is never reported as a death. Shorten it if you would rather learn
about a dead session sooner and can tolerate the occasional false report.

Three windows are ordered and the broker refuses a configuration where they cross:
`CHANNEL_DISCORD_IDLE_AFTER_MS` must be below `CHANNEL_STALE_AFTER_MS`, or a session is marked stale
before it could ever render idle, and `CHANNEL_DISCORD_EXITED_AFTER_MS` must be above it, or every
quiet session is instantly called dead.

`CHANNEL_PEER_MESSAGES` governs how much of a peer message is drawn and never whether the path
exists. Two of the three ways a peer message reaches a thread are read off the transcript, so with
`CHANNEL_MIRROR` or `CHANNEL_INTERIM_MIRROR` off this host's own sends and every message arriving
while a session is working reach no thread at all, whatever this is set to. Only the inbound half
delivered to an idle session rides the independent mirror route. A thread in that state shows one
side of a conversation and reads like the whole of it, so the broker says so once at startup:
`broker: peer messages are on without the transcript tailer, so this host's outbound peer messages
and the ones that arrive mid-turn reach no thread; they need CHANNEL_MIRROR and
CHANNEL_INTERIM_MIRROR both on`.

`CHANNEL_BROKER_PORT` is the trap. Moving it here moves the broker only. Every `http` hook URL in
`hooks/settings-fragment.json` and the literal in `hooks/session-start.ps1` carry their own copies,
and the installer refuses a `-Port` that disagrees with the fragment for exactly that reason. Change
them all, and `broker/config.ts`'s `DEFAULT_PORT` with them.

## Upgrading a host

Re-run `install\Install-All.ps1` from the repository root with no identity arguments. The three
identity arguments (`-HostName`, `-ChannelId`, `-AllowedUserId`) are needed on a first install,
`-Port` is optional with a default, and all four are read back from the `broker.env` the last
install wrote on every one after it, so picking up new hooks is one command
rather than a trip to the Discord console. Each reused value is announced as it is picked up, which
is how a run from the wrong checkout shows itself before anything is provisioned, and a malformed
ID or port on disk is refused naming the key and the file. An argument you do supply always wins, which
is how a host is rebound to a different channel. `Install-Host.ps1` run on its own still takes its
arguments explicitly.

## When something is wrong

**A session never appears as a thread.** Check the log for the intake refusing or dropping its posts.
A session started without the launch wrapper carries no process token, is not watched, and is
correctly ignored. If the checkout moved, the launch wrapper refuses to start rather than running
unwatched; re-run the installer.

**Threads stop updating but the broker is running.** Check the log for a rejected token. The broker
stops its Discord surfaces after one rejection rather than retrying forever, and says so once.

**Sessions are tracked and nothing appears in Discord at all.** A half-configured Discord is the one
shape that looks identical to a working one from every other signal: the registry fills, the log
ticks, `GET /sessions` is healthy. A token with no channel, or a channel with no token, turns the
surfaces off and warns **once at startup**, so the evidence is at the top of the log and nowhere
else.

**The broker will not start.** Three refusals are deliberate and each names its cause in the log
before the process exits. It refuses a token file that any account on the machine can read or write,
and one whose directory is that permissive, naming the file and the principal. It refuses to run a
Discord connection with no `CHANNEL_ALLOWED_USER_ID`, because a gate that was misconfigured and a
gate that was never wired look identical from the outside. And it refuses any out-of-range or
misordered tunable. Re-run the installer for the first, fix `broker.env` for the other two.

**A message into an old thread gets no answer at all.** A message sent to a session that has ended is
normally answered in-thread with a notice saying so. That only works while the broker still holds the
ended record, which is `CHANNEL_RETAIN_TERMINAL_MS` (24 hours by default). Past that horizon the
thread is unknown to the broker and a message there is ignored in silence. Threads are left open on
purpose, so old ones stay in the list and stay writable; a silent one is old, not broken.

**A verdict comes back saying nothing is open, and you know you were just asked.** The open-request
table lives in memory and the scheduled task restarts the broker at every logon. A restart forgets
every outstanding prompt, the session behind it is not re-asked, and your answer gets the
unknown-request notice. Answer that one at the keyboard.

**A session is parked and no prompt ever arrived.** Three causes, all log-only. The thread was over
its 12-prompt minute and the prompt was dropped. Or the session has no thread yet, so the prompt had
nowhere to go. Or the request ID fell outside the alphabet a verdict can name, which is a Claude Code
internal this project is coupled to: the log line names that cause specifically, so a future alphabet
change is diagnosable rather than silent.

**Messages reach a session but its answers read wrong.** The relay holds its pipe on a
first-claim-wins basis and every reply must present a key issued only down that pipe, so a second
process cannot take the channel from a relay that already holds it. What it can do is get there
first, before the relay attaches. Nothing detects that, and the status card keeps ticking either way.
If a session's replies do not match what it is doing, stop the session rather than steering it, and
see [`security-model.md`](security-model.md).

**The thread shows a session working normally but carries none of the conversation.** The mirror is
off somewhere, and there are two switches. `CHANNEL_MIRROR` in `broker.env` turns it off for the
whole host, which is the first thing to check because it survives restarts and nothing on the thread
says so. The second is per session: a session launched with `Enter-ClaudeSession -NoMirror` sends a
header that turns the mirror off for that session alone, and every other session on the host keeps
mirroring. A suppressed post is logged as such, naming the session and no content, which is what
tells a deliberately quiet mirror apart from a broken one. The status card, the tool counts, and the
permission prompts all keep working either way, because the identity-and-activity path they are fed
from is not affected by either switch. The card's tool-input preview is worth naming separately: it
is session content, it rides that same unaffected path, and neither switch reaches it, so a
no-mirror session still shows what its last tool was called with. See
[`security-model.md`](security-model.md) for where else that preview travels.

`-NoMirror` depends on a header the mirror hooks carry, so it needs the hooks installed from a
version of this repository that has it. The wrapper refuses to launch rather than running the
session mirrored when the installed settings lack it, so this shows up as a refused launch naming
the installer, never as a session you believed was unmirrored.

**A very long reply never reaches the thread, but shorter ones do.** A mirror post larger than
`CHANNEL_MIRROR_MAX_BYTES` is drained and dropped, and the log says so with a byte count and no
content. The post is answered normally rather than refused, deliberately: refusing it would surface
as a visible error inside the session at the end of exactly its longest turns. Raise the knob if you
want those replies, remembering that the whole reply then arrives as many messages.

**A mirrored message shows backslashes in front of `<` and `>`.** That is the escape that stops
mirrored text drawing a mention pill, a timestamp chip, or a copy of the attribution line saying who
wrote the message. Discord renders `\<` as `<` in ordinary prose, so the backslash is visible only
where Discord processes no escapes: inside an inline code span, and in front of a line-leading `>`
inside a code block. A fenced code block is otherwise left exactly as it was written, which is why a
mirrored reply full of generics and comparisons reads normally. A message posted by the `reply` tool
carries the same escape, because it lands in the same thread beside mirrored text, and so does a
mid-turn narration chunk from the transcript tailer.

**A long reply arrives cut short with the thread otherwise healthy.** A reply that renders into many
messages is paced against the thread's create bucket, and a post the bucket refuses anyway is waited
out and sent again, so a long report ordinarily arrives over seconds and lands whole. While a run is
pacing it holds that thread's turn to post, so anything the session posts next, a mid-turn message
you typed included, lands after the report rather than inside it. The log names how far a run got
and what stopped it, and the two causes read differently. `stopped after N of M messages: rate
limited` is the run reaching its ceiling on waiting, a minute of it within one run, which takes a
bucket that stays empty across repeated waits: a thread being written to heavily from elsewhere, or
a genuinely wedged bucket, both rare. Every other refusal names its own error class and stops the
run where it stands, because rate limiting is the one class where nothing landed and sending the
same message again cannot double-post it. The mirror's rate-limit budget is deliberately separate
from the budget the permission prompts and notices spend, so a long reply can exhaust its own writes
without costing you a prompt you were waiting on.

**A reply the model was told not to send again.** A reply is answered across the whole of its run,
and the relay waits on it for as long as the broker keeps feeding the response, up to a ceiling of
fifteen minutes on one reply. A run still going at the ceiling is reported to the model as still
posting rather than as failed, with an instruction not to send the message again, because its
messages may be going up in the thread at that moment. The log line for such a run is `relay: a
/relay/reply run settled <status> after its caller had closed the connection`, and it is the only
place that run's outcome is reported to anyone: the connection that would have carried it is gone.

**A closed session takes half a minute to show as exited.** That is the design, not a lag. The relay
reconnects on its own, and a pipe that closed and came back is a reconnect rather than a death, so
the broker holds one heartbeat of grace (15 seconds) before ending the session. The sweep is periodic
on top of that, so a close landing just after a tick is not acted on until the tick after next: the
bound is up to two heartbeat intervals, roughly 30 seconds, rather than one. The trade buys the
opposite failure, which is worse: without the grace, a relay's own reconnect would strand a working
session as exited, and ended is terminal with no way back.
