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

Hooks report what a session is and what it is doing. The channel carries messages in and out.
Neither can do the other's job, and that constraint is what shapes every component below.

A channel server is never told the session identity. A `notifications/claude/channel` event carries
`content` plus a `meta` bag the server itself authors, and nothing in the protocol hands it a session
ID or a name. A channel is also a subprocess of the *process*, not the session, so a `/clear` mints a
new session ID underneath it without its knowing.

Hooks are the opposite. Every hook payload carries `session_id`, `SessionStart` names the trigger in
a `source` field, and a hook command inherits environment variables set by the launch wrapper. That
inheritance is the join key: the wrapper mints a `CHANNEL_PROCESS_TOKEN` per launch, the hooks report
under it, and the relay running in the same process connects to the broker with the same value.

## Components

Four pieces per host, plus an installer.

- **Launch wrapper** (`wrapper/Enter-ClaudeSession.ps1`). A dot-sourced PowerShell function that
  sets `CHANNEL_SESSION` and a fresh `CHANNEL_PROCESS_TOKEN` GUID, writes a per-launch
  `--mcp-config` registering the relay, and starts `claude` with this host's channel flag. Both
  environment variables are restored when `claude` exits, because a token left behind in the
  operator's shell would be inherited by the next session and read as a supersession.
- **Hooks** (`hooks/`). `SessionStart` is a `command` hook running `session-start.ps1`, which posts
  identity to the broker. `PostToolUse` and `Stop` are `http` hooks posting straight to the broker.
  The transport split is fixed by observation: the `http` type never delivered `SessionStart`.
- **Relay** (`relay/`). A stdio MCP child of one Claude Code process. It declares
  `claude/channel` and `claude/channel/permission`, exposes a `reply` tool, and holds one HTTP
  stream open to the broker for the life of the process.
- **Broker** (`broker/`). The per-host daemon. It owns the bot token, one Discord gateway
  connection, the session registry, the thread bindings, and the three Discord surfaces. It runs as
  a scheduled task at logon.
- **Installer** (`install/`). Provisions a host: configuration outside the repository, the hooks
  merged into the user-level settings file, hardened access control lists on the execution surface,
  and the scheduled task.

## Data flow

The broker listens on `127.0.0.1:8787` by default and serves two unrelated groups of routes on one
listener.

1. **Identity and activity, session to broker.** `POST /hook` takes a `SessionStart`, `PostToolUse`,
   or `Stop` payload with the event name, the process token, and the session name in headers. The
   registry turns those into a session record: session ID, name, host, source, last tool, tool
   count, turn count, and last-seen timestamp. A `SessionStart` with `source: "clear"` supersedes
   the prior record for that token rather than mutating it. `GET /sessions` publishes the registry
   for debugging, with the process token withheld.
2. **Messages, both directions.** `GET /relay/stream` is the held-open pipe: its first line carries
   a reply key, later lines carry inbound messages and permission verdicts, and its closing is the
   session's death signal. `POST /relay/reply` and `POST /relay/permission` carry the other
   direction and must present that key.
3. **Discord inbound.** A gateway message is gated on the sender's user ID, then either resolved as
   a permission verdict or handed to the session bound to that thread.
4. **Discord outbound.** Every five seconds the surface reconciles the registry against Discord:
   thread names, the starter-message card, and any reply or notice waiting to be written.

The registry persists to a JSON file on every mutation, and the thread bindings persist beside it,
so a restart at logon rebinds existing threads rather than opening duplicates.

## External integrations

Three, and each one fails in its own way.

- **Claude Code's hook protocol.** The user-level settings file registers three hooks. All of them
  fail open: a broker that is down cannot slow or block a session.
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
that machine, a card in each thread carrying what that session is doing right now, and a path for
sending it a message or approving its tool calls from a phone. The status path and the message path
fail independently, which is what makes a dead message path visible instead of silent.

Installing a host is [`install.md`](install.md). Running one is [`operations.md`](operations.md).
What the design trusts and what it does not is [`security-model.md`](security-model.md).
