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
  connection, the session registry, the thread bindings, the three Discord surfaces, and a poll loop
  (`broker/tail.ts`) that tails each live session's own transcript file for mid-turn narration. It
  runs as a scheduled task at logon.
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
   preview of that tool's input (the card's `Last tool` row), tool count, turn
   count, and last-seen timestamp. Every credited post also teaches the transcript tailer where that
   session's transcript file lives, without adding the path to the record itself. A `SessionStart`
   with `source: "clear"` supersedes the prior record for that token rather than mutating it. `GET
   /sessions` publishes the registry for debugging, with the process token and the transcript path
   both withheld.
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
   thread names, the starter-message card, and any reply, mirrored message, or notice waiting to be
   written. Mirror posts spend their own rate-limit budget rather than the one permission prompts
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
so a restart at logon rebinds existing threads rather than opening duplicates.

## Mid-turn narration

The mirror above carries only the two moments a hook payload reaches: the prompt that opens a turn
and the reply that closes it. What the model writes in between is not delivered to any hook, so
`broker/tail.ts` recovers it from the same file Claude Code already writes for its own purposes: the
session's transcript, JSONL appended beside the session and never authored for this broker's benefit.

The tailer polls, on `CHANNEL_INTERIM_POLL_MS` (20 seconds by default), every session the registry
currently holds live. For each one it reads past the byte offset the previous pass left, up to a
bounded ceiling per pass, and stops at the last complete line so a line still being flushed is left
for the next pass. Three line shapes contribute anything, and all must be non-sidechain lines
carrying the session ID the path was learned for: a `text` content block on an `assistant` line is
one interim chunk, a `queued_command` attachment recording a human-origin prompt is one mid-turn
typed message, delivered in transcript order among the chunks around it, and a `tool_use` block
naming `AskUserQuestion` is one open-question alert. That transcript line exists only once the
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
at most four options, and a control row to send or to hand the question back to the console. A
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

**How this relates to the mirror the tailer deduplicates against.** The turn's own final reply is
read twice by design: once by the Stop mirror within milliseconds of turn end, and again by the
tailer's own next pass over the same transcript line, up to one poll interval later. A shared echo
memory, keyed per session, is what collapses that to one copy in the thread; it is described under
"One copy of a turn's close" below, and it serves a second duplicate pair as well.

Reading a session's transcript at all is gated on an explicit mirror-on verdict seen for that session
under the current broker process; see [`security-model.md`](security-model.md) for what that gate
covers and why it fails in the direction it does.

## One copy of a turn's close

Three streams can carry the same closing words into one thread, so a shared per-session echo memory
(`broker/tail.ts`) decides which copy the operator sees. The reply tool posts a closing summary
mid-turn as `📣 Claude · answer`, the Stop mirror posts the turn's final text as `✨ Claude`, and
the tailer reads that same final text off the transcript up to one poll interval later as
`✨ Claude · working`.

The memory holds one record per session with three slots: the digest of the last interim chunk, the
digest of the last mirrored reply, and the reply-tool answer record. The first two answer an exact
repeat between the tailer and the Stop mirror, in whichever order the two arrive. The third answers
a rewording, so it carries a normalized length and a bottom-k similarity sketch (word 3-gram
shingles, 128 hashes, `broker/similarity.ts`) beside its digest: a candidate matches at an estimated
Jaccard similarity of **0.85** or above, and only while its normalized length is within **1.10** of
the answer's, so a final text that grew past the allowance always posts. The reply-tool message is
never the suppressed one, because it posted first and its text is already in front of the operator;
what the answer record suppresses is the Stop mirror, and a tailer poll landing between the two,
which is what collapses both orderings to one copy.

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

The card's discipline is freshness rather than completeness. Ages are derived from each reading's
own fetch time; countdowns are recomputed from reset instants rather than repeated from strings the
cache froze at fetch time; a window whose reset has passed is drawn for the period it is in now,
which is what the console shows and what keeps the card from reporting an operator out of headroom
against a window that has actually reset; and a fetch time the reader cannot believe renders as
unknown rather than as fresh. The pace marker mirrors claude-swap's own rule constant for constant,
verified differentially against that tool's own renderer, because a marker on one surface and not
the other reads as a bug in whichever the operator trusts less.

The card is edited only when its rendered body differs from what was posted, so a fleet with
nothing moving spends nothing; a running reset ticks the countdowns about once a minute, which is
the real steady state. Each failure keeps the card honest rather than silent: an unreadable cache
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

The session's in-flight work rides the same card, and it corrects a state rather than adding one. A
session blocked on dispatched subagents fires no hooks at all, so hook-driven liveness called it
idle at the moment it was most heavily worked. The harness reports its own table of in-flight
subagents and background commands on every `Stop` payload, which the broker already receives, so
the roster is read rather than reconstructed: a reconstruction from dispatch events cannot tell a
finished agent from a stranded one, and accumulates ghosts across restarts. The count reaches the
thread title, where a phone's truncation eats everything else, and the rename damper keys on the
composed title rather than on the state, so a fan-out draining coalesces instead of spending the
budget a parked session's own title needs.

## What the cards are made of

Both cards draw their bodies inside fenced monospace blocks so their columns line up at a glance,
with headings outside the fences where Discord still renders them. The width they pad to is one
shared constant, `MAX_BLOCK_WIDTH` in `broker/discord/render.ts`, currently 46 columns, and it is a
phone's constraint rather than a taste: a code block scrolls sideways on a phone rather than
wrapping, so a card wider than its bound costs a drag to read, which is worse than the ragged lines
the fence replaced.

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
recognizes as its own cards, so a pin the operator made is not collateral.

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
session parks itself on a question and a way to answer it from the thread, background-task wake-ups
compressed to one line, and a path for sending it a message or approving its tool calls from a
phone. The status path, the message path, and the mirror fail independently, which is what makes a
dead message path visible instead of silent.

Installing a host is [`install.md`](install.md). Running one is [`operations.md`](operations.md).
What the design trusts and what it does not is [`security-model.md`](security-model.md).
