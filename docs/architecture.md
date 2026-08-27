# Architecture

Every running Claude Code session on a host appears as its own Discord thread, and all of the
addressing that makes that work is local. A Discord bot token has no refresh boundary, so rotating
the Anthropic account paying for a session cannot break it. That is the whole reason this exists:
Remote Control registers a session object in Anthropic's cloud under the account that created it,
and stops accepting input permanently once `claude-swap` rotates the seat out from under it.

One host runs one broker, one bot identity, and one Discord channel. A broker reaches its sessions
over loopback, so it cannot serve another machine, and the three hosts (NEO, ASR, SCOTT) share
nothing but the source.

## The load-bearing split

Hooks report what a session is, what it is doing, and what was said in it. The channel carries
messages in, and it is the only path that can carry one in. That asymmetry is what shapes every
component below.

A channel server is never told the session identity. A `notifications/claude/channel` event carries
`content` plus a `meta` bag the server itself authors, and nothing in the protocol hands it a session
ID or a name. A channel is also a subprocess of the *process*, not the session, so a `/clear` mints a
new session ID underneath it without its knowing.

Hooks are the opposite. Every hook payload carries `session_id`, `SessionStart` names the trigger in
a `source` field, and a hook command inherits environment variables set by the launch wrapper. That
inheritance is the join key: the wrapper mints a `CHANNEL_PROCESS_TOKEN` per launch, the hooks report
under it, and the relay running in the same process connects to the broker with the same value.

The conversation leaves the machine on hooks rather than on the channel, and that is a correctness
choice rather than a convenience. The channel's outbound path is the model choosing to call the
relay's `reply` tool, so a session that never calls it leaves a silent thread while the pipe sits
healthy. A `UserPromptSubmit` hook fires on every prompt that opens a turn and a `Stop` hook fires
at every turn end
whether or not the model cooperates, and the `Stop` payload already carries
`last_assistant_message`, the turn's final assistant text whole with thinking excluded. The mirror
is therefore structural, and the `reply` tool remains for what the model wants to say on its own
initiative.

Two things the console shows reach no hook payload at all: what the model writes *between* tool
calls, and a message the operator types while the model is mid-turn, which the harness queues and
injects without a `UserPromptSubmit` ever firing. The transcript tailer below is what recovers
both. The third such surface, the multiple-choice question an `AskUserQuestion` call parks the
session on, is no longer console-only: it reaches the broker at the moment it is asked, through a
`PreToolUse` hook whose payload carries the full question, and that hook's own HTTP request is
held open so the answer can travel back down it. Its transcript line is written only when the
picker resolves, so the tailer's reading of it is the resolution-time fallback and the signal that
the console answered, not the timely alert.

**The question desk** (`broker/question-desk.ts`) owns that held request. One entry per session,
holding the questions, a digest of them, the responses of any identical reposts the CLI retried,
and an expiry timer; a bounded ring remembers the last few closed asks so a console answer can
still rewrite a thread message whose entry is gone. Five triggers end a hold and exactly one wins:
an answer from the thread responds with the operator's choices, while a release, an expiry, a dead
client socket, and a broker shutdown all respond with a body that renders the console picker
normally. Every direction but the first is today's behavior, which is the fail direction the whole
surface is built around: a lost hold must never eat a question. While a hold stands the console
renders no picker at all, so the thread is the only place the question exists.

## Components

Four pieces per host, plus an installer.

- **Launch wrapper** (`wrapper/Enter-ClaudeSession.ps1`). A dot-sourced PowerShell function that
  sets `CHANNEL_SESSION` and a fresh `CHANNEL_PROCESS_TOKEN` GUID, writes a per-launch
  `--mcp-config` registering the relay, and starts `claude` with this host's channel flag. Both
  environment variables are restored when `claude` exits, because a token left behind in the
  operator's shell is inherited by the next `claude` started from it, which the broker then reads as
  a subprocess of the session that holds the token: it never registers, so it gets no thread, no
  status card, and no mirroring.
- **Hooks** (`hooks/`). `SessionStart` is a `command` hook running `session-start.ps1`, which posts
  identity to the broker. `PostToolUse` and a `Stop` liveness tick are `http` hooks posting straight
  to the broker; the broker keeps a bounded, neutralized preview of the tool's input from
  `PostToolUse` for the status card and each event's `transcript_path` for the tailer below, and
  drops the rest of the payload unread. `UserPromptSubmit` and a second `Stop` entry are the mirror:
  `http` hooks posting their whole payload, which already carries the console prompt and the turn's
  final assistant reply, to the content-bearing route. The transport split is fixed by observation:
  the `http` type never delivered `SessionStart`.
- **Relay** (`relay/`). A stdio MCP child of one Claude Code process. It declares
  `claude/channel` and `claude/channel/permission`, exposes a `reply` tool, and holds one HTTP
  stream open to the broker for the life of the process.
- **Broker** (`broker/`). The per-host daemon. It owns the bot token, one Discord gateway
  connection, the session registry, the thread bindings, every Discord surface (a session's thread
  name, its status card, the messages written into it, the fleet usage and board cards' own threads,
  and the channel's pin list), and a poll loop (`broker/tail.ts`) that tails each live session's own
  transcript file for mid-turn narration. It runs as a scheduled task at logon.
- **Installer** (`install/`). Provisions a host: configuration outside the repository, the hooks
  merged into the user-level settings file, hardened access control lists on the execution surface,
  and the scheduled task. The same directory holds the operator's repair path, `Repair-Broker.ps1`,
  which kills every process it can prove is this checkout's broker, reports the host's setup without
  writing to it, restarts the task, and waits on `GET /sessions` before calling the host up.

## Data flow

The broker listens on `127.0.0.1:8787` by default and serves three unrelated groups of routes on one
listener.

1. **Identity and activity, session to broker.** `POST /hook` takes a `SessionStart`, `PostToolUse`,
   or `Stop` payload with the event name, the process token, and the session name in headers. The
   registry turns those into a session record: session ID, name, host, source, last tool, a bounded
   preview of that tool's input (the card's Tool block), tool count, turn count, last-seen
   timestamp, the timestamp of the last engagement (the narrower stamp the blocked desk below reads,
   moved by a `SessionStart`, a completed tool call, or an operator prompt, and by nothing else),
   the model and context figures the tailer reads off the transcript, the completion goal
   and the session's own title it reads the same way, and the roster of in-flight subagents and
   background commands a `Stop` payload carries. Every credited post also teaches the transcript
   tailer where that session's transcript file lives, without adding the path to the record itself.
   A `SessionStart` with `source: "clear"` supersedes the prior record for that token rather than
   mutating it. `GET /sessions` publishes the registry for debugging, with the process token and the
   goal withheld field by field and the transcript path never on the record to begin with.
2. **Conversation, session to broker.** `POST /mirror` is the one content-bearing route, dedicated
   rather than folded into `/hook` so the larger ceiling and the log-suppression rule hold in one
   place. It takes a `UserPromptSubmit` or `Stop` payload under the same three identity headers plus
   `X-Channel-Mirror`, authenticates on the process token alone, and hands the payload's `prompt` or
   `last_assistant_message` to the routing layer for the session's bound thread. Every drop path
   answers 202, and the content never reaches the broker log at any level. A prompt that is the
   harness's own wake-up injection for a finished background task, recognized by its whole-text
   `<task-notification>` prefix, is compressed to a one-line notice by default rather than mirrored
   whole: the injection carries the subagent's entire final report, which the console renders
   compactly and the thread otherwise receives as a many-message quoted block. The
   `CHANNEL_TASK_NOTIFICATION` knob selects `brief`, `full`, or `off`. A post on this route also
   arms or disarms the transcript tailer for the session it names: see "Mid-turn narration" below.
3. **Messages, both directions.** `GET /relay/stream` is the held-open pipe: its first line carries
   a reply key, later lines carry inbound messages and permission verdicts, and its closing is the
   session's death signal. `POST /relay/reply` and `POST /relay/permission` carry the other
   direction and must present that key.
4. **Discord inbound.** A gateway message is gated on the sender's user ID, then either resolved as
   a permission verdict or handed to the session bound to that thread.
5. **Discord outbound.** Every five seconds the surface reconciles the registry against Discord:
   thread names, the starter-message card, any reply, mirrored message, or notice waiting to be
   written, the archiving of an exited session's thread, and, chained after that pass, the channel's
   pin list. Mirror posts spend their own rate-limit budget rather than the one permission prompts
   spend, so a reply arriving as twenty messages cannot starve the alert a parked session waits on.
   Posts are ordered per thread, so a turn's reply, the prompt after it, a mid-turn narration chunk,
   a mid-turn typed message, and a reply-tool call reach the thread in the order the broker received
   or read them. A body that renders into many messages is paced: consecutive posts of one run are
   spaced so the run's send rate stays under the thread's create bucket, and a post the bucket
   refuses anyway is waited out and sent again, under a per-run ceiling on how long that waiting may
   total. A long report therefore arrives over seconds and lands whole, and the thread's turn to
   post is held for all of it, so whatever that session posts next lands below the report it
   follows.

The registry persists to a JSON file on every mutation, and the thread bindings persist beside it,
so a restart at logon rebinds existing threads rather than opening duplicates. Two fields do not
survive that round trip, and for the same reason: a live reading restored from a snapshot would draw
as current. The goal is never written at all, since only the card reads it and nothing restores it;
the context size is written and dropped on load, so a woken card carries the model without a figure
beside it until the next transcript line reports one. The roster is the deliberate exception,
restored with its first-sighting stamps, because the harness replaces it wholesale at the session's
next `Stop` and dropping it would read a mid-fan-out restart as an idle session. The session's title
is written and restored, on the opposite reasoning to the goal's: it is identity rather than intent,
and a restart that dropped it would repaint a renamed thread back to its launch name.

## Mid-turn narration

The mirror above carries only the two moments a hook payload reaches: the prompt that opens a turn
and the reply that closes it. What the model writes in between is not delivered to any hook, so
`broker/tail.ts` recovers it from the same file Claude Code already writes for its own purposes: the
session's transcript, JSONL appended beside the session and never authored for this broker's benefit.

The tailer polls, on `CHANNEL_INTERIM_POLL_MS` (20 seconds by default), every session the registry
currently holds live. For each one it reads past the byte offset the previous pass left, up to a
bounded ceiling per pass, and stops at the last complete line so a line still being flushed is left
for the next pass. Six line shapes carry conversation into the thread, and all must be
non-sidechain lines carrying the session ID the path was learned for: a `text` content block on
an `assistant` line is
one interim chunk, a `queued_command` attachment recording a human-origin prompt is one mid-turn
typed message, delivered in transcript order among the chunks around it, a `user` line the harness
stamps as typed by a human is the prompt that opened the turn, recovered so a mirror hook the CLI
abandoned under load costs the delay rather than the words, a `queued_command`
attachment whose structured origin names a peer is one message another session sent this one
while it was working, a `tool_use` block naming `SendMessage` is one message this session sent
another, and a `tool_use` block naming `AskUserQuestion` is one open-question alert. That transcript line exists only once the
picker is answered, so this yield is the fallback behind the `PreToolUse` hook post that alerts
the same question at emission; a bounded per-session set of outstanding digests lets the yield
recognize and skip a question the hook path already alerted, and a session whose installed hooks
predate the `PreToolUse` entry still alerts here, at answer time, which is that host's
compatibility story. A digest lives exactly as long as the byte offset it was recorded against,
at one copy per question: the set holds at most 8 and drops whole whenever the offset does (a
newly taught path, a mirror-off suppression), because a digest outliving the resolution line it
waits for would consume a later identical question's only alert. The preserved fail direction is
at most one duplicate ping, never a silent question. That same yield is what tells the desk a
question was answered at the console, so a thread message whose question the operator answered at
the keyboard stops asking for an answer already given; a yield that reports such a flip posts no
alert of its own, because the flipped message is the report. The question alert takes its own delivery path: it posts through the steering writer's alert tier, mentioning the operator the
way a permission prompt does, under its own per-thread ping/quiet/drop window (1 mention and 4
posts per thread per minute, a window deliberately separate from the permission prompt's own), so
a session parked on a picker reaches a phone without a long narration run ahead of it and without
becoming a ping primitive for whatever can write transcript lines. That alert then upgrades in
place: one edit turns the notice into the interactive message, a select per question carrying the
option descriptions the console picker shows, buttons instead when the ask is a single question of
at most four options, and a control row to send or to hand the question back to the console. An ask
no single message can carry spills, and what spills rides plain continuation messages, at most six
of them, posted below the notice before that edit runs: the interactive message's markers say the
rest is readable in full below or at the console, so they are drawn only over messages already in
the thread, and they stay true for the late question the six-message cap leaves undrawn. Those
posts are spaced 1,200 milliseconds apart and each one is preceded by a fresh read of the hold, so
an ask answered, expired, or shut down part way through stops posting where it stands, and a post
Discord refuses releases the hold instead of leaving a marker pointing at nothing. The edit itself
runs inside the ordered drawing queue behind its own liveness read, the way a tap-refresh does,
because the posts ahead of it are a window several round trips wide in which the hold can end. The
continuation texts are composed from the questions alone, never from the operator's accumulated
selections, so a redraw after a tap yields the same texts, which the caller has already posted and
never edits. A
press arrives as an `INTERACTION_CREATE` gateway event, passes the same one-account allowlist every
inbound message passes before it touches any state, and resolves against an opaque
server-minted entry reference rather than anything the press itself carries, so what a press can
submit is only a label the session's own tool call offered. An ask the bounded reader could not
carry whole is refused the thread path and released to the console instead, because the caps that
merely truncated a notice would, on an answering surface, drop a question from the answer map
while the session still asked it. The file's position is
taken the moment a session is both allowed to be read and has a learned path, whichever of the two
arrives second, by a probe that reads its size and no content: what the transcript already held is
never republished into the thread, and the turn's opening chunk, written seconds after the mirror-on
verdict rather than a poll tick later, falls inside the window rather than behind it.

A queued mid-turn message takes a rendering of its own: the operator's own words in the
operator-attributed quoted block a hook-mirrored prompt draws, through the same escape and the same
check that keeps a message posted in the thread itself from echoing back into it. Posting it ends
the narration block above it, so the next chunk starts fresh below the operator's words.

Each surviving chunk reaches the thread through the same routing and rendering path a mirrored
reply uses, under a `✨ Claude · working` attribution that marks it as mid-turn rather than final,
and consecutive chunks coalesce: while the newest message in the thread is the narration message
the router last wrote, a chunk that fits appends into it by editing that message in place, so a
working stretch reads as one growing block under a single attribution rather than a header per
sentence. A full block, or anything else landing in the thread (the operator's message, a
permission prompt, a notice, the turn's final reply), starts the next chunk on a fresh message.
The router knows its message is still newest because every message in its threads comes back over
the gateway, and it judges what arrives by snowflake order rather than by the bare fact of an
arrival. Snowflakes carry their creation time, so an ID strictly newer than the remembered message
ends the block, while the run's own echo, which Discord routinely delivers before the REST response
resolves, announces nothing newer and leaves the block standing. Notices and permission prompts end
it directly on posting, and a message that outranks a fresh post's own final message during its
round trip, or one whose ID the comparison cannot place, keeps that post from being remembered as a
block at all. A chunk that cannot be posted (the thread is not open yet, Discord refuses it for a
reason waiting cannot pass) is dropped rather than queued, the rule the whole routing layer follows
outside one in-flight run's own pacing and rate-limit waits, and a refused edit falls back to a
fresh post of the same chunk in the same call: the fail direction of coalescing is more messages,
never lost narration.

**How this relates to the mirror the tailer deduplicates against.** Two of a turn's moments are
read twice by design. The turn's final reply reaches the thread once from the Stop mirror within
milliseconds of turn end and again from the tailer's next pass over the same transcript line, up to
one poll interval later; the prompt that opens the turn arrives the same two ways, from the
`UserPromptSubmit` mirror hook and from the tailer. A shared echo memory, keyed per session, is
what collapses each of those to one copy in the thread; it is described under "One copy of a
turn's open and close" below, and it serves the reply tool's own near-duplicate as well.

Reading a session's transcript at all is gated on an explicit mirror-on verdict seen for that session
under the current broker process; see [`security-model.md`](security-model.md) for what that gate
covers and why it fails in the direction it does.

## Peer traffic between sessions

Claude Code sessions message each other directly, and one session's thread carries every exchange
that session is party to, in both directions and in transcript order, so an operator watches a
cross-session conversation without tabbing between terminals. Peer traffic renders under a `📡`
attribution of its own rather than in either register the mirror already has, because neither can
carry it honestly: the `>>>` quoted block means the operator typed something, and `✨ Claude` means
this session wrote it. `CHANNEL_PEER_MESSAGES` governs how much of each message is drawn (`full`,
`brief`, `off`) and governs nothing else: the attribution and the engagement-stamp exclusion below
hold on every setting.

**Three paths, one reading, one rendering.** A message reaches a thread three ways, and the three
must not disagree about one message. Only one of them rides the prompt seams: a delivery landing
while the session is idle fires `UserPromptSubmit`, so it arrives at the mirror as prompt text with
the wrapper markup around it, and the classification that recognizes it is the same exported
reading the tailer owns rather than a second copy beside it. The other two are read off the
transcript by the tailer: the mid-turn attachment and this session's own `SendMessage` block. All
three render through one mode dispatch, so no path draws whole what another compresses.

**Why that cannot double-post.** The idle delivery is a user line, and the tailer does not read
user lines for peer traffic at all, so the mirror's copy is the only copy. The mid-turn delivery
fires no prompt hook, on the queued-injection rule the operator's own typed mid-turn message
follows, so the tailer's copy is the only copy. Both halves are established rather than assumed, by
different kinds of evidence. The idle half is structural: the shipped reader yields nothing at all
for a real idle-delivery line, so the tailer cannot produce a second copy of one. The busy half is
observational, because no counter on this surface witnesses whether a prompt hook fired: the
liveness vocabulary and the mirror vocabulary are separate by construction and no liveness hook
sends `UserPromptSubmit`, so a mirror post moves no liveness field whether it fired or not. What
settles it is the thread's own copy count, counted against live traffic worded differently on each
message so a missing copy cannot be mistaken for a duplicate suppressed. Were either half ever
to change, the fallback is the mechanism already here, the shared echo memory that collapses the
turn-close duplicate below.

**One text does reach both prompt seams, and it is not a peer's.** The classification is a prefix
match on the harness's own wrapper opening, so a prompt the operator really typed that starts with
that opening is read as a delivery by the mirror hook and again by the tailer's recovery of the same
transcript line. Both peer seams therefore take the per-path prompt claim an ordinary mirrored
prompt takes: each consults the other path's slot before it renders and reports a copy that path
already dispatched as sent, then claims its own slot as its run goes on the wire, releasing the
claim and retrying once where the run lands nothing at all. The tailer's own two kinds carry no
claim, having no second copy anywhere. What the pair buys is one copy of a misread prompt rather
than two under a peer's attribution, and the drop line that names which path stood down is in
[`operations.md`](operations.md).

**The attribution names a counterparty, which is why it is composed rather than tabled.** The
existing attributions are fixed literals in a keyed record; a peer line embeds a name, so it is
built from component constants and the name goes through the full markdown neutralization a card
title takes. The renderer's own bound covers whatever the reader admits, so a name that got past
the reader is drawn whole rather than cut to half a name nobody can look up: the reader refuses a
name over 120 code points whole, and the renderer bounds at 240 what neutralizing one produced,
which is the ceiling that escape can grow 120 code points to, every character it touches being
ASCII that leaves as two. This session's own side of the arrow renders as a bold token a name
cannot supply, because every counterparty here is itself a Claude session and a peer named `Claude`
would otherwise draw an identical header in both directions.

A peer message posts through the thread's ordering chain like any other line, so it takes its place
among the narration around it and ends any narration block being grown there. It spends the mirror
budget, never the alert tier, and mentions nobody.

## One copy of a turn's open and close

Three streams can carry the same closing words into one thread, so a shared per-session echo memory
(`broker/tail.ts`) decides which copy the operator sees. The reply tool posts a closing summary
mid-turn as `📣 Claude · answer`, the Stop mirror posts the turn's final text as `✨ Claude`, and
the tailer reads that same final text off the transcript up to one poll interval later as
`✨ Claude · working`.

The memory holds one record per session with five slots: the digest of the last interim chunk, the
digest of the last mirrored reply, the reply-tool answer record, and one prompt claim per path.
The first two answer an exact repeat between the tailer and the Stop mirror, in whichever order
the two arrive. The third answers
a rewording, so it carries a normalized length and a bottom-k similarity sketch (word 3-gram
shingles, 128 hashes, `broker/similarity.ts`) beside its digest: a candidate matches at an estimated
Jaccard similarity of **0.85** or above, and only while its normalized length is within **1.10** of
the answer's, so a final text that grew past the allowance always posts. The reply-tool message is
never the suppressed one, because it posted first and its text is already in front of the operator;
what the answer record suppresses is the Stop mirror, and a tailer poll landing between the two,
which is what collapses both orderings to one copy.

The same memory answers the turn's opening prompt, which arrives twice for the reason the closing
reply does. Two slots rather than one: `promptMirror` is written only by the mirror hook's path and
`promptTailer` only by the tailer's, each read by the other, so no path can consume its own claim
and neither path's fresh claim can spend the deferral the other's still-running delivery is owed.
Whichever copy arrives first suppresses the other's exact repeat. A prompt claim also expires,
after the longer of a minute and three poll intervals, and is given up wherever the tailer's read
position jumps over bytes it will never read: a claim nothing can now answer would otherwise stand
over the next identical prompt and swallow it, which is the loss the recovery exists to prevent.
The fail direction of the dedup is a duplicate prompt rather than a missing one, with the one
exception the reply pair also carries: a copy that won the race and then landed nothing at all,
whose single retry landed nothing either, is reported on its own log line and is genuinely lost.
The reader that decides whether a transcript line is a prompt at all fails the other way on
purpose, and so does an unarmed session: both yield no recovery rather than risk the operator's
register or a wrong attribution.
The mid-turn message the
operator types while the model works stays outside this entirely, because it fires no hook and so
has no second copy for a claim to answer for.

Every match consumes the record it matched, and the reply-kind mirror clears the answer record
whether or not it matched, which bounds it to one turn. What is held is a digest, a number, and
bounded derived hashes, never conversation text; the memory is created whenever `CHANNEL_MIRROR` is
on, so turning mid-turn narration off does not disarm the reply-tool dedup.

## The fleet usage card

A second surface answers a question the session threads cannot: how much headroom the accounts
behind them still have. One thread the broker owns carries a card it edits in place, built from
`broker/usage/`: a bounded reader over claude-swap's own local cache and account list, a pure
renderer from that reading plus a registry snapshot, and a thread module that owns the card's
lifecycle.

Nothing here invokes claude-swap or touches the network. The usage endpoint it fronts allows on the
order of thirty requests an hour per account, shared across every machine and consumer polling it,
so a card that shelled the tool would compete with the auto-switcher for a budget already near its
ceiling. Reading the cache costs nothing and mutates nothing, and the reader opens exactly two
files, uses no field of either as a path, and leaves the failure detail of a failed poll unread,
because an authentication error is where a token would appear.

The card is drawn as a bold label over a fenced block per account, and the label is the one field
on this card that lands outside a fence: a bold line is live markdown, where a crafted account
name could otherwise draw a mention pill, a heading, a fence delimiter, or close the emphasis it
sits inside, so the label takes the same full-markdown neutralization the session card's title takes
rather than the lighter escape a fenced field needs.

The card's discipline is freshness rather than completeness. Ages are derived from each reading's
own fetch time; countdowns are recomputed from reset instants rather than repeated from strings the
cache froze at fetch time; a window whose reset has passed is drawn for the period it is in now,
which is what the console shows and what keeps the card from reporting an operator out of headroom
against a window that has actually reset; and a fetch time the reader cannot believe renders as
unknown rather than as fresh. The pace marker mirrors claude-swap's own rule constant for constant,
verified differentially against that tool's own renderer, because a marker on one surface and not
the other reads as a bug in whichever the operator trusts less.

The card is edited only when its rendered body differs from what was posted, which bounds the cost
rather than removing it: ages and countdowns are drawn to the minute below a day, so about one edit
a minute is the real steady state and the card settles only once everything it draws has aged past
that mark. Each failure keeps the card honest rather than silent: an unreadable cache
redraws the last good numbers under a marker so their age goes on climbing, each Discord route
carries its own refusal count with a decay so one refused verb cannot abandon the others, and a
pass arriving while one is on the wire is handed the live one, which is what lets shutdown wait for
the write it must wait for and keeps a second card out of the channel on the next boot.

## What a session card knows about itself

Two more facts ride the session's own card, both read from the transcript lines the tailer already
follows. The model producing its turns and the raw size of its context, drawn raw rather than as a
percentage because the window is a per-model fact that can move upstream while a rendered
percentage keeps looking authoritative. And a standing marker whenever a session is running below
the model it opened with, which persists for as long as that is true rather than only at the moment
of the change, so a downgrade nobody saw is still visible later, and clears on return.

Two upstream records force a downgrade and they carry different fields: a safeguard refusal names a
category and a session scope, while an entitlement fallback names a consent answer and neither of
those. A reader keyed to the first sees nothing on the second, which is the one an operator can act
on, so both are read.

What the session is trying to finish rides the same card, read from the `/goal` command in the same
transcript. Its end is the unobservable half, since a goal that completes need not write anything,
so the card drops the line the moment the session reads idle or exited rather than trying to detect
one: a finished goal drawn indefinitely reads as current, which is worse than no goal line at all.

The session's in-flight work rides the same card, and it corrects a state rather than adding one. A
session blocked on dispatched subagents fires no hooks at all, so hook-driven liveness called it
idle at the moment it was most heavily worked. The harness reports its own table of in-flight
subagents and background commands on every `Stop` payload, which the broker already receives, so
the roster is read rather than reconstructed: a reconstruction from dispatch events cannot tell a
finished agent from a stranded one, and accumulates ghosts across restarts. The count rides the state
on the card, for `blocked` as much as for `working`, and stops there.

The card's own vocabulary is five states, `working`, `needs you`, `blocked`, `idle` and `exited`,
drawn glyph-first as ⚙, ⏹, ⛔, ⏸ and ⚠, and graded by how much each wants from the operator. The
thread title distinguishes four of them, `active`, `needs you`, `blocked` and `exited`, so working,
idle, and a draining fan-out are one title and cost no renames at all: every rename writes a system
notice into the thread that an app cannot delete, and a title spent on a moving number would run a
column of them down the thread. Blocked earns a title because it is the halted-on-the-operator class
the title exists for. The rename damper keys on the composed title rather than on the state, which is
what holds a session renaming itself to one rename.

## The name a session goes by

A session carries two names, kept apart on purpose, and the thread title draws whichever of them is
current. The launch `name` is what the wrapper set with `-Name` and what the `X-Channel-Session-Name`
header carries on every hook post for the process's whole life, so it can never follow an in-session
`/rename`. The `title` is Claude Code's own record of the session's name, read off the `custom-title`
transcript line that both a launch `--name` and a `/rename` write. `displayName`
(`broker/discord/render.ts`) prefers the title, falls back to the launch name, and falls back again to
a stub built from the first eight characters of the session ID, and it is the one reading behind the
thread name, the session card's heading, and the fleet card's session rows, so no two surfaces can
call one session different things.

Two fields rather than a precedence rule inside one is what makes the ordering irrelevant. The header
arrives on every post and writes only `name`; the transcript writes only `title`; neither can clobber
the other, so a rename read at 10:00 is not undone by the hook post at 10:00:01. `broker/tail.ts`
reads the line, `boundedTitle` (`broker/sanitize.ts`) normalizes it, and `registry.noteTitle` stores
it, early-returning on a value equal to the one it holds because the harness re-emits that line on
every poll and an unconditional write would spend a snapshot write per pass.

The repaint is the rename path that already existed. The surface composes the thread name from the
view each refresh tick (5 seconds), and paints it once the composed name has held for the dwell
(`CHANNEL_DISCORD_DWELL_MS`, 60 seconds), so a rename lands within one poll interval plus one dwell,
about **80 seconds** at the defaults, and a flurry of renames paints only the settled name at the cost
of one slot from a per-thread bucket holding about two renames in ten minutes. The two states that
skip the dwell by design, `needs you` and `exited`, carry a title change onto the next pass with them. The title also rides
the thread binding on disk as `sessionTitle`, and the surface holds the last one it saw across a view
that carries none, so a restart or a rebuilt registry record neither repaints the thread back to the
launch name nor loses the only surviving copy of the rename.

The normalization lives in `broker/sanitize.ts` rather than beside the renderer that draws it, because
the storage layer reads it too. `broker/persistence.ts` and `broker/discord/bindings.ts` re-admit the
title from files on disk, and taking the composition from `broker/discord/render.ts` would put a
2,400-line display module, and its own imports of the registry and the board's event reader, on the
load path a state file is read through, one edge short of a cycle that type-checks clean and throws at
the first restore. `sanitize.ts` imports nothing at run time, and `import-hygiene.test.ts` pins both
that leaf property and the direction, each with a control so the pin cannot pass for want of a subject.

## The fleet board card

A third surface answers what the other two cannot: which plans are open across the projects on this
host, and how far each has got. One more broker-owned thread carries a card edited in place, built
from `broker/board/`: a sweep that parses plan documents, a tail over the kit's goal event stream, a
pure renderer, and a thread module owning the lifecycle, on the usage card's pattern.

The renderer is deterministic. No agent, no model call, and no token spend sit anywhere in the path
between a plan file and the card, so what the card says is what the documents say, and a card that
disagreed with the plan tree would be a bug rather than a judgment call.

It reads exactly two kinds of file. The first is `docs/plans/*.md` under each configured project
root, parsed against the kit's frozen v1 plan-doc machine contract: the `Status` header, the sections
listed under `## Sections of Work`, which of them a Chapter's `Completed:` line closes, and the latest
Chapter's `Next:`. That contract's sharp edges are reproduced rather than corrected. A foreign `##`
heading inside the sections block ends it early and drops what follows, and a `Completed:` value
registers a section only under three exact forms. An external engine reads the same files the same
way, so a card that quietly disagreed with it about what is done would be the dishonest one. The
second is the kit's goal event stream, one JSON object per line, tailed by byte offset and keyed by
project and plan, which is where the blocked marker comes from. That file has a second reader with
its own offset, the blocked desk below, and the two folds live side by side in `broker/board/events.ts`.

Paths are never derived from what either file says. The configured roots are the only path input;
the one join is a root with a directory entry's own name, which cannot contain a separator, so no
field of a plan document or an event can steer a read. Roots are compared as strings,
separator-normalized and case-folded on Windows, never by asking the filesystem whether two paths name
the same place, and the configured spelling and the folded form come from one shared normalizer so
the two readers cannot disagree about which root an event belongs to.

Cost is bounded because the broker has a single event loop and the card runs on a timer, so a stall
here is a stall on the channel where approvals are answered. A file is opened only when its
modification time or size has moved, and that holds for a file that fails to parse exactly as it does
for one that succeeds: a malformed or oversized document is held shut at the stat it failed at rather
than being re-read every tick forever. The per-file ceiling is well above a real plan and far below
what would hurt, the per-root file count is capped, a truncated sweep says on the card what it
dropped, and each untrusted field is cut to length as it enters rather than after it has been walked
for escaping.

A torn read is drawn rather than hidden. A plan caught mid-write redraws its last good parse under a
held marker whose age climbs, so the operator sees staleness instead of a plan that silently stopped
moving. The blocked marker is set by a `goal-blocked` event and cleared by a newer plan modification
time or by the goal completing, with a stamp from the future taken as now, since otherwise one bad
timestamp would pin the marker permanently.

Order is decided at the card and nowhere else. The sweep lists a root's plans by name, and that
listing is what the per-root cap is defined against, so it stays name-ordered and the renderer sorts
what it is handed: plans by modification time newest first with the filename stem breaking a tie,
projects by the newest plan under each. A root the card can date outranks one it cannot, so a
project holding only a parse failure or a truncation note sinks beneath every project holding a plan
that parsed. The configured list is a tie-break and only that, consulted for two roots the times
leave equal and for two the card cannot date at all, which means the time is the first key for a
root nothing configured exactly as it is for a configured one. Both comparisons compare the instants
rather than subtracting them, because a plan carrying no usable time sorts at negative infinity and
two of those subtract to `NaN`, which is a comparator returning an arbitrary order rather than a
stable one.

Membership is decided in two places, one rule each. The sweep's is that a `README.md` under a swept
`docs/plans` is a directory index rather than a piece of open work, so it is absent: no bullet, no
parse-failure line, and no count against the per-root cap, which it is excluded ahead of. The
renderer's is that every non-terminal status is drawn as written except the exact value
`In Progress`, compared case-insensitively on the trimmed text, which draws no status clause at
all. That is the ordinary state and nothing else occupies the spot, so its absence is unambiguous
and every near miss, `In Progress (auto)` among them, draws whole rather than cut to a width. The
one status that is named rather than drawn is a value carrying text that neutralizes to nothing,
which draws `(unreadable status)`: it cannot be dropped, because dropping it would spend the one
absence the card gives a meaning to. A `Status:` header that was blank to begin with draws nothing,
since there is no text there to report unusable.

The plans are drawn in live markdown, which is what lets those statuses draw whole: a bold-stem
bullet per plan, and an indented sub-bullet carrying the sections count, the age and the status,
with a second sub-bullet for the latest Chapter's `Next:` when there is one. Drawing those inside a
fence would bound every column at the narrowest window they are read in, which is narrower than a
real plan name or a sentence-length status, so it cuts a line exactly where the information is.
Markdown wraps at word boundaries with a hanging indent instead, so a long fact costs wrapped lines
rather than an ellipsis, and the sections count carries progress on its own, where a bar renders as
blank space at zero and tiles by font.

Each project is named by a one-line fence rather than a heading, which is the one fenced thing on
the card. A fence draws as a full-width shaded box, and that box is what makes one project's list
stop and the next start at a glance, which is the boundary a reader scrolls the card by. Nothing is
aligned inside it, so the width bound the tabular cards pad to does not apply: the label is free
text in a box with no grid to break, and a name past the reader's window wraps inside the box rather
than being cut. That is why `MAX_PROJECT_LABEL_LENGTH` (60) is the card's own cap and not
`MAX_BLOCK_WIDTH`, since a truncated directory name is a project the operator cannot recognize.

The two positions take two different escapes. Every field on a body line takes the full markdown
neutralization, and the bound handed to that escape is each field's own cap times two rather than
the cap itself: a field is bounded on raw code points where it enters and on escaped text where it
is drawn, and the escape can grow a string, so passing the cap would silently cut a field the intake
had already bounded. Two is a ceiling rather than a margin, since every character the escape touches
is ASCII and leaves as two code points and two UTF-16 units, while an astral code point is never
escaped. The project label takes the block escape instead, because a fence honors no backslash
escape: a backtick is substituted rather than escaped, and the bound handed to it is the cap itself,
since substituting one character for one and stripping the rest can never grow a value.

## The blocked desk

A `/kit-goal` run that has stopped on the operator says so on the thread that session already owns.
The kit's own Stop hook appends a `goal-blocked` line to its goal event stream naming the project,
the plan, and the session id, and `broker/discord/blocked.ts` is the session surface's reader of
that line: a second fold over the file the board card reads, keyed by session id rather than by
(root, plan) and holding its own byte offset, so neither fold consumes bytes the other never saw.
The desk is built whenever Discord is, independent of `CHANNEL_BOARD_CARD`, and both folds resolve
the same `CHANNEL_BOARD_EVENTS_PATH`, so an operator who redirects the stream redirects all of it
rather than half. Without Discord the desk is never built and no session stands blocked, because no
surface exists to draw one.

A session **stands blocked** while its latest kept goal event is a `goal-blocked` whose instant is
newer than the session's engagement stamp. Engagement is the registry's record that a person or live
work drove the session, moved on an explicit allowlist rather than on everything but a denied few: a
`SessionStart`, a `PostToolUse`, and an operator prompt on any of the three prompt paths (the
hook-carried mirror, the tailer's mid-turn queued yield, and the tailer's turn-opening yield),
minus two prompts that are machine-generated and must not clear a gate that waits on a person: the
harness's own background-task wake injection, and a peer session's message riding the same prompt
path. Both exclusions hold at all three stamp sites and under every setting of the knobs that
govern how those two are drawn, since a knob decides how text reaches the thread and not who wrote
it.

Two credited events carry liveness and deliberately do not stamp. `Stop` is the blocked stop
itself, whose own hook traffic would otherwise clear the marker it raises. `PreToolUse` fires only
for `AskUserQuestion`
here, so it marks the instant a session parks on a person, and stamping it would clear a standing
block for the whole life of an open question.

Both of the tailer's prompt paths stamp with a borrowed instant rather than the moment they ran:
the transcript line's own timestamp, with read time as the fallback for a line naming no readable
instant. Only the hook-carried mirror stamps when it runs. The borrowed instant is bounded at both
ends by the registry, never moving the field backwards and never landing later than now, so a line
can neither un-engage a session nor post-date its way past a block. Without it, a prompt read a
poll interval after it was typed would clear the very block the turn it opened went on to raise.

A `goal-complete` newer than the block replaces it in
the fold, so a run that finished can never stand blocked whatever the engagement clock says. The
standing computation is one function, read at both `toView` call sites, which is what keeps the
fleet card and the session's own thread from disagreeing about who is blocked.

The ping keys on the event rather than on the drawn state, and the two answer different questions. A
block that clears within the same model turn (the queue moved on, the next completed tool call
stamped engagement) never renders `⛔` and still pings, because the run did stop on the operator.
One alert is posted per episode, an episode being the pair of a session id and the event's admitted
millisecond instant, and only while that instant is within 10 minutes of the observing tick: a
broker restart re-reads the stream from the top, so the bound is what keeps a replayed backlog from
ringing a phone about a block that is no longer news. The alert rides the steering writer's alert
tier under a volume window of its own, sized like the question alert's at 1 mention and 4 posts per
thread per minute, and a slot is refunded when the post did not land, so an outage cannot make the
real ping arrive quiet. The episode key is recorded as the post goes on the wire and released again
when the post fails, which is what lets the next tick retry while the block stays fresh without
double-posting an episode whose write spanned a tick boundary. A session whose thread is not open
yet records nothing and simply goes again next pass.

The title is the slow channel and the alert is the fast one. `blocked` is deliberately not one of
the states worth an immediate rename, because the mid-turn transient above can appear and clear
inside a refresh tick, and an undamped rename there would write Discord's irremovable notice twice
and empty a per-thread bucket that holds about two renames in ten minutes, the same bucket the final
exited rename and the archive need. A real block lasts minutes to hours, so it settles well inside
the ordinary dwell window.

What the desk reads is lower-privilege than every token-gated surface here: appending to the stream
needs write access to the operator's home directory and no process token at all. So a line whose
instant is later than the read's own clock is dropped whole rather than clamped, session ids are
normalized through the same sanitizer the registry stores ids through and dropped rather than
truncated at the field bound, the kept map is capped at 200 sessions, and every log line the desk
writes carries a cause and a session id and never the plan text. [`security-model.md`](security-model.md)
carries what that credential admits and what the surface is therefore worth as evidence.

## What the cards are made of

The session and fleet cards draw their bodies inside fenced monospace blocks so the columns line up
at a glance, with each block's own label outside the fence where Discord still renders it. They
label a section differently. The session card uses a `###` heading; the fleet card uses a bold
paragraph line, because Discord puts a margin above a heading and a card carrying one section per
account pays that margin three or four times, which is air spent instead of numbers. The width they
pad to is one shared constant, `MAX_BLOCK_WIDTH` in `broker/discord/render.ts`, currently 46
columns, and it is a phone's constraint rather than a taste. A code block wraps to the width of the
window it is read in rather than scrolling sideways, measured at roughly 51 columns on a folded
phone and 62 unfolded, and a wrapped line under a padded column reads as a value in that column. So
a grid's width bound belongs below the narrowest window it is read in, which is what keeps the
columns a grid exists for from scrambling.

The board card's plan list is the exception, and the reason is what its content is. A fence pays for
aligned columns with a hard width, which is the right trade for numbers and the wrong one for prose:
that card's fields are a plan's name and a sentence about its state, neither of which fits a phone's
column bound, so a fence cuts them where a list wraps them. Those draw in live markdown, because the
alternative is an ellipsis in the middle of every fact worth reading. The card's one fence is the
project label, which aligns with nothing, so `MAX_BLOCK_WIDTH` is what the genuinely tabular cards
pad to and it bounds nothing on the board.

A fence is also a security surface, and the shape of its protection is measured rather than
reasoned. Escaping a backtick does not defend it, because Discord resolves the escape before it
finds the fence, and opening with more than three backticks does not defend it either, because three
is the whole delimiter and a fourth is content. So every backtick in a fenced field becomes an
apostrophe, which cannot open anything, and the tests assert that no backtick reaches a body at all
rather than that no two are adjacent. The backslash escape stays, because Discord does resolve it
inside a block, which is what draws a Windows path correctly.

The mirroring path borrows the same machinery for one transform of its own. Discord renders no
Markdown tables, so a table in anything mirrored, a reply, a mid-turn chunk, or a narration append,
would reach the thread as literal pipes. The renderer redraws it into a fenced block padded to the
same shared width, honoring the header's alignment markers, and it neutralizes each cell before
padding rather than after, so a cell that grows under neutralization cannot push its column out of
line. The transform is the only place the mirror rewrites a model's own formatting, and it declines
in three cases rather than guessing: a table already inside a fence is the author's own text, a
malformed table is passed through unchanged, and a table whose redrawn block would not fit a message
is mirrored raw, on the reasoning that readable pipes beat a truncated block.

The channel's pinned messages are maintained the same way the threads are: by reconciling against
Discord's own answer rather than a flag this broker keeps, which is what survives a restart, a
hand-made pin, and a card rebuilt after a deletion. The sweep touches only messages the broker
recognizes as its own cards, so a pin the operator made is not collateral. That narrowing is also
why the fifty-pin ceiling is read as the channel's rather than as this broker's: every pin the sweep
will not touch is counted against the ceiling before the cards are, since nothing here will ever
free those slots and asking for a pin the channel has no room for is a permanent refusal, three of
which stop the pin route for the life of the process.

An exited session's thread archives itself on the same tick, unless the host turns that off. The
flag lives beside the binding and clears the moment the session's derived state stops reading
exited, which is what lets a presumed-dead session that wakes get its card and its title maintained
again, and be archived once more at its real exit.

## External integrations

Three, and each one fails in its own way.

- **Claude Code's hook protocol.** The user-level settings file registers four events and five hooks:
  `SessionStart`, `PostToolUse`, and a `Stop` liveness tick post payloads the broker reads only as
  far as a session's identity and activity plus the two bounded fields above (a tool-input preview
  and a transcript path); the Stop tick's payload also carries the turn's final reply, which that
  route drops unread. `UserPromptSubmit` and a second `Stop` entry carry the console prompt and the
  turn's final assistant reply to the mirror, which keeps them, save for a background task's wake
  prompt, which mirrors as the one-line notice under the default `CHANNEL_TASK_NOTIFICATION`
  setting. All of them fail open: a broker that is down cannot slow or block a session.
- **Claude Code's channel protocol.** The relay registers only from the interactive REPL, and only
  when `channelsEnabled` is on and the plugin is allowlisted. Claude Code refuses a channel whose
  negotiated protocol revision is at or past `2026-07-28`.
- **Discord.** The REST API for thread creation, renames, and message writes, and the gateway for
  inbound messages. Renames are the scarce resource, so the broker reads the rate-limit response
  headers and drops a rename it cannot afford rather than queueing it.

## Runtime model

There is no build step. TypeScript runs directly under Node 24's type stripping, so every entry
point is invoked as source (`node broker/index.ts`), which is also how the scheduled task starts the
broker. The cost is one rule: relative imports carry the `.ts` extension, never `.js` and never
bare. A `./thing.js` specifier type-checks clean and then throws `ERR_MODULE_NOT_FOUND` at runtime,
and no compiler option catches it. `import-hygiene.test.ts` is the enforcement.

Gates are `npm run lint` (`tsc --noEmit`) and `npm test` (`node --test`, which refuses to report
green when it matched no test files).

## End result

A host running this has a Discord channel whose thread list is a live dashboard of every session on
that machine, a card in each thread carrying what that session is doing right now, the conversation
itself mirrored into the thread turn by turn, mid-turn narration on a long turn, an alert when a
session parks itself on a question and a way to answer it from the thread, a ⛔ title and one ping
when a goal run stops on the operator, background-task wake-ups compressed to one line, and a path
for sending it a message or approving its tool calls from a phone. The status path, the message path, and the mirror fail independently, which is what makes a
dead message path visible instead of silent.

Installing a host is [`install.md`](install.md). Running one is [`operations.md`](operations.md).
What the design trusts and what it does not is [`security-model.md`](security-model.md).
