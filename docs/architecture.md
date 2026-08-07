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
healthy. A `UserPromptSubmit` hook fires on every prompt and a `Stop` hook fires at every turn end
whether or not the model cooperates, and the `Stop` payload already carries
`last_assistant_message`, the turn's final assistant text whole with thinking excluded. The mirror
is therefore structural, and the `reply` tool remains for what the model wants to say on its own
initiative.

What the model writes *between* tool calls, mid-turn, reaches no hook payload at all; the transcript
tailer below is what recovers it.

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
  and the scheduled task.

## Data flow

The broker listens on `127.0.0.1:8787` by default and serves three unrelated groups of routes on one
listener.

1. **Identity and activity, session to broker.** `POST /hook` takes a `SessionStart`, `PostToolUse`,
   or `Stop` payload with the event name, the process token, and the session name in headers. The
   registry turns those into a session record: session ID, name, host, source, last tool, a bounded
   preview of that tool's input (the card's `Last tool: Bash · npm test` line), tool count, turn
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
   answers 202, and the content never reaches the broker log at any level. A post on this route also
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
   and a reply-tool call reach the thread in the order the broker received or read them.

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
for the next pass. A line contributes text only when it is an `assistant` line, not a sidechain, and
carries the session ID the path was learned for; a `text` content block from such a line is one
interim chunk. On learning a path for the first time, the tailer takes the file's current end without
reading anything, so what a transcript already held before this broker process learned about the
session is never republished into the thread.

Each surviving chunk reaches the thread through the same routing and rendering path a mirrored
reply uses, under a `✨ Claude · working` attribution that marks it as mid-turn rather than final,
and consecutive chunks coalesce: while the newest message in the thread is the narration message
the router last wrote, a chunk that fits appends into it by editing that message in place, so a
working stretch reads as one growing block under a single attribution rather than a header per
sentence. A full block, or anything else landing in the thread (the operator's message, a
permission prompt, a notice, the turn's final reply), starts the next chunk on a fresh message.
The router knows its message is still newest because every message in its threads comes back over
the gateway: an arriving ID strictly newer than the remembered message ends the block, notices and
permission prompts end it directly on posting, and a message landing during a fresh post's round
trip keeps that post from being remembered as a block at all. A chunk that cannot be posted (the
thread is not open yet, Discord refuses it) is dropped rather than queued, the rule the whole
routing layer follows, and a refused edit falls back to a fresh post of the same chunk in the same
call: the fail direction of coalescing is more messages, never lost narration.

**How this relates to the mirror the tailer deduplicates against.** The turn's own final reply is
read twice by design: once by the Stop mirror within milliseconds of turn end, and again by the
tailer's own next pass over the same transcript line, up to one poll interval later. A shared digest
memory, keyed per session, records which text each side already posted and drops whichever side's
post is the second to arrive, so the operator sees the duplicate paragraph once rather than twice.

Reading a session's transcript at all is gated on an explicit mirror-on verdict seen for that session
under the current broker process; see [`security-model.md`](security-model.md) for what that gate
covers and why it fails in the direction it does.

## External integrations

Three, and each one fails in its own way.

- **Claude Code's hook protocol.** The user-level settings file registers four events and five hooks:
  `SessionStart`, `PostToolUse`, and a `Stop` liveness tick post payloads the broker reads only as
  far as a session's identity and activity plus the two bounded fields above (a tool-input preview
  and a transcript path); the Stop tick's payload also carries the turn's final reply, which that
  route drops unread. `UserPromptSubmit` and a second `Stop` entry carry the console prompt and the
  turn's final assistant reply to the mirror, which keeps them. All of them fail open: a broker that
  is down cannot slow or block a session.
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
itself mirrored into the thread turn by turn, mid-turn narration on a long turn, and a path for
sending it a message or approving its tool calls from a phone. The status path, the message path,
and the mirror fail independently, which is what makes a dead message path visible instead of silent.

Installing a host is [`install.md`](install.md). Running one is [`operations.md`](operations.md).
What the design trusts and what it does not is [`security-model.md`](security-model.md).
