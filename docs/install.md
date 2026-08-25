# Installing a host

One broker per host, one Discord bot identity per host, one channel per host. A broker reaches its
sessions over localhost, so it cannot serve another machine.

The three hosts are NEO, ASR, and SCOTT. NEO and ASR are organization-owned; SCOTT is a personal Max
account with no organization. Steps 1 through 4 are identical on all three. The only thing that
differs is the channel flag the launch wrapper passes, which is decided by whether that host's
managed settings allowlist the relay, not by which kind of account pays for the session.

## 1. Create the Discord application

Once per host, so three times. Each host gets its own bot so the three fleets never share an
identity, and so a revoked token takes down one machine rather than all of them.

1. At <https://discord.com/developers/applications>, create an application and name it for the host.
2. Under **Bot**, create the bot and copy the token. It is shown once.
3. Under **Bot**, enable **Message Content Intent**. Without it the bot receives message events with
   empty content, which reads as a silent delivery failure rather than a permission error.
4. Under **OAuth2 > URL Generator**, select the `bot` scope and these permissions: View Channels,
   Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message
   History. **Pin Messages** is optional and buys one thing: the channel's pin list becomes the
   sessions that are running. Grant it as a channel-level override on the broker's own channel
   rather than server-wide, since it also permits deleting other people's messages. Without it the
   pin list simply does not populate and one log line says so; nothing else changes. Note that
   Discord's older pin route reports a missing-permission error naming Manage Messages when Pin
   Messages is the one actually required, so that error points at the wrong grant.
5. Open the generated URL and invite the bot to your server.
6. Create a text channel for the host and copy its ID (right-click the channel with Developer Mode
   on). Copy your own user ID the same way; it is the only account permitted to steer a session.

**Make that channel private to you and the bot.** The sender allowlist governs who can *write* into
a session, not who can read. Everyone with access to the channel sees every message, and a tool
approval prompt carries the tool's actual input: the shell command, the patch body, file contents.

**With mirroring on, which is the default, the conversation itself leaves the machine too.** Every
prompt typed at the console and every turn's final assistant reply reaches that session's thread in
full, so the operator can read and steer from a phone. Discord retains all of it. A turn that closed
through the reply tool lands one copy of its closing words rather than two, and
[`security-model.md`](security-model.md) carries the bound on what that suppression can cost.

Two switches turn it off. `CHANNEL_MIRROR=off` in `broker.env` covers every session on the host, and
`Enter-ClaudeSession -NoMirror` covers one session while every other session keeps mirroring.

**Neither switch makes a session private.** They stop the conversation being mirrored, and nothing
else. A tool approval prompt from that session still carries the tool's actual input to Discord, as
the paragraph above describes, because that is how the prompt is answerable at all. A session where
the shell commands and file contents themselves are sensitive should not be answering approvals over
the channel either.

The per-session switch needs the hooks installed from this version of the repository: it works by a
header the mirror hooks carry, so a host installed before the switch existed has no such header. The
wrapper refuses to launch with `-NoMirror` against settings that lack it rather than mirroring the
session anyway, and the fix is re-running the installer.

**The optional fleet cards send content of their own, and both are off until you turn them on.** The
usage card (`CHANNEL_USAGE_CARD`) carries each account's identity and headroom. The board card
(`CHANNEL_BOARD_CARD` plus `CHANNEL_BOARD_PROJECTS`) sweeps plan documents under the project roots
you name and puts their titles, progress, and next steps in the channel, along with the last path
segment of each root as the project name, so a root at or just under your home directory would put
your account name there too. Both are configured in `broker.env` and documented in
[`operations.md`](operations.md); a value tuned by hand there survives a re-install.

Create Public Threads and Manage Threads are the two that fail quietly if missed: the broker posts a
starter message successfully and then cannot open a thread on it.

## The one-command install

Steps 2 and 3, plus the plugin install, the managed-settings file, and the `cchat` launcher, in one
unelevated invocation from the repository root:

```powershell
install\Install-All.ps1 -HostName SCOTT -ChannelId <channel id> -AllowedUserId <your user id>
```

It prompts for the bot token on a first install (or takes `-BotTokenFile`, same rules as below); a
re-run reuses the hardened token from the last install without prompting. It runs
`Install-Host.ps1` in-process, registers this checkout as a plugin marketplace and installs the
relay plugin through the `claude` CLI, then raises exactly one UAC prompt for
`Install-Elevated.ps1`, which registers the broker's scheduled task, writes the managed-settings
file described under "The launch dialog", and installs a block into the machine-wide PowerShell
profile that dot-sources the launch wrapper and aliases it, so a new shell anywhere on the machine
launches a watched session with `cchat <session-name>`. Every piece is idempotent; re-run it after
moving the checkout or rotating a token. The three identity arguments are needed on the first
install only: a re-run reads `-HostName`, `-ChannelId`, `-AllowedUserId`, and `-Port` back from the
`broker.env` the last install wrote, announces each reused value as it picks it up, and refuses a
malformed ID or port on disk naming the key. An argument you supply always wins, which is how a host is
rebound to a different channel.

Step 1 stays manual either way (it is Discord's web console), and a host still runs the per-host
verification checklist under "The relay as a plugin" before its wrapper table entry moves to plain
`--channels`. The sections below describe what the one command does, and remain the way to run any
piece alone.

## 2. Provision the host

From the repository root, in a plain non-elevated session:

```powershell
install\Install-Host.ps1 -HostName SCOTT -ChannelId <channel id> -AllowedUserId <your user id>
```

It prompts for the bot token and reads it without echoing. **Do not pass the token as plain text on
the command line**: PowerShell's history file keeps it in the clear indefinitely, and it also lands
in the process command line and in transcription logs. `-BotToken` accepts only a `SecureString` for
that reason. Use `-BotTokenFile <path>` instead to read a token from a file you already placed, and
put that file inside the state root, which is where the installer hardens permissions.

Unelevated is a requirement, not a convenience: a file created by an elevated shell is owned by the
machine's Administrators group rather than by the account, and the broker's credential guard reads
that owner shift as a planted token file and refuses to start. Elevation belongs only to step 3.

`-Port` must agree with every hook URL in `hooks/settings-fragment.json` and the literal in
`hooks/session-start.ps1`. They are pinned together by the test suite, and the installer
refuses a port that disagrees rather than moving one copy and silently disconnecting the hooks.

The installer:

- writes `broker.env` and the token file under `%LOCALAPPDATA%\sapplefeld-channels\`, outside the
  repository, keeping any allowlisted key already in `broker.env` that this run does not itself set,
  so a knob tuned by hand survives a re-install,
- substitutes this checkout's absolute path into the `SessionStart` hook and merges every hook the
  fragment declares, plus the relay's one reply-tool permission rule, into your user-level
  `~/.claude/settings.json`,
  backing it up first and preserving every hook, rule, and setting that is not this project's,
- hardens the access control lists on the whole execution surface: `hooks/`, `relay/`, `wrapper/`,
  `install/`, and `broker/` as directories, the bot token file, and the state root,
- runs `npm ci`, which installs the reviewed lockfile rather than resolving newer dependencies.

Directories are hardened as containers rather than file by file, because a hardened file in a
directory that permits delete-child can be deleted and re-created with a clean access control list.
The reasoning is in [`security-model.md`](security-model.md); the short version is that every one of
those paths is executed automatically, either by the scheduled task at logon or by Claude Code at the
start of every session on the machine.

The hooks belong in the **user-level** settings file rather than a project one, because the sessions
being watched live in arbitrary repositories. That is also why the `SessionStart` hook names its
script by absolute path: a hook runs with the monitored session's own project as its working
directory. Re-run the installer after moving or re-cloning the repository; the launch wrapper refuses
to start a session when the installed hook points somewhere else, rather than letting every session
run unwatched.

The two mirror hooks carry a 10-second timeout, pinned to that exact value by the test suite.
They post the console prompt and the turn's final reply, which are larger than a liveness tick
and slower to accept, and the CLI holds the turn open while the post runs, so the value is what a
prompt pays at worst when the broker is busy rather than a cost every prompt pays. It is paid by
every session on the machine, though, not only the ones being watched: these hooks are installed
user-level and fire for every Claude Code session on the host.

A session saturated enough to blow through the timeout says so at the console, on a line
beginning `UserPromptSubmit hook timed out after 10s`. That prompt does not reach the thread and
cannot be recovered, which is what makes it worth watching for: the thread then shows a reply
with no question above it. A run of those means the host is oversubscribed.

Changing the value means editing the fragment and its pin together. A timeout edited by hand in
a host's own `~/.claude/settings.json` does not survive: the installer recognizes this project's
hook entries by their headers, ignores their timeouts, and re-adds them from the fragment as
written. For the same reason a host already installed keeps whatever value it was installed with
until its next `Install-Host` run, and nothing at launch reports the difference, so a fleet host
that has not been re-installed since a timeout change is still running the old one.

## 3. Install the service

Elevated, once:

```powershell
install\Register-BrokerTask.ps1 -User <the account that ran step 2>
```

`Install-Host.ps1` prints that exact command with the account already filled in, and `-User` matters:
the ACLs from step 2 grant the account that ran it, so a task registered under a different principal
starts a broker that cannot read its own token file. It also scopes the logon trigger, since an
unscoped one fires on any account's logon and a second broker cannot bind the port the first holds.

The task starts the broker at logon and restarts it every minute on failure, up to 999 times, with no
execution time limit. Running the script again updates the existing task in place rather than
creating a second one. It refuses to run unelevated with a message saying so, rather than failing
with an access error further in.

## 4. Launch a session

```powershell
. .\wrapper\Enter-ClaudeSession.ps1
Enter-ClaudeSession -Name 'neo-warden'
```

The name is yours to choose, appears in the thread title, and may repeat across sessions: thread
identity is the session ID, not the name. It is restricted to printable ASCII, because the name
travels as an HTTP header and a non-ASCII one would fail in a way that silently prevents the session
from ever being announced.

The wrapper refuses to launch rather than launching a session that cannot be watched. It throws when
the hook script or the relay is missing, when the installed `SessionStart` hook in your user settings
names a different checkout, or when the hook script has lost the permissions the installer set. Each
message names the command that fixes it, which is almost always re-running `Install-Host.ps1` from
this checkout. On a fresh clone where the installer has not run, expect the permission refusal.

Each launch also rewrites `%LOCALAPPDATA%\sapplefeld-channels\relay-mcp.json`, which is the
`--mcp-config` that registers the relay for that one session. It is regenerated from the wrapper's
own location every time, so unlike the installed hook path it can never come to name a checkout that
has moved.

Confirm the session registered:

```powershell
curl.exe -s http://127.0.0.1:8787/sessions
```

## The launch dialog

A custom channel is not on Anthropic's approved allowlist, so it normally requires
`--dangerously-load-development-channels` and a full-screen warning that needs a keypress at the
terminal. Setting `allowedChannelPlugins` to include the relay replaces the Anthropic allowlist
entirely and removes both.

`channelsEnabled` and `allowedChannelPlugins` are managed settings, deliverable on Windows as a local
file at `C:\Program Files\ClaudeCode\managed-settings.json`, a `managed-settings.d\` drop-in
directory, or `HKLM\SOFTWARE\Policies\ClaudeCode`. All three are machine-scoped rather than
account-scoped, so one file per host survives every account rotation, and a local file is honored
even on a personal account with no organization behind it. That is what makes this route available on
every host rather than only the organization-owned ones, and it is also what stops a rotation onto an
account without `channelsEnabled` from silently killing message delivery.

**Note that the replacement is total.** Once `allowedChannelPlugins` is set, any shipped channel
plugin you also want must be listed alongside this project's.

The file this project needs:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "sapplefeld-channels", "plugin": "relay" }
  ]
}
```

The wrapper picks the flag from a table keyed by host name
(`wrapper/Enter-ClaudeSession.ps1`, `$script:ChannelFlagByHost`), and that flag decides the rest of
the launch line. On `--dangerously-load-development-channels` the wrapper passes the generated
`--mcp-config` and the entry `server:channel-relay`. On plain `--channels` it passes
`plugin:relay@sapplefeld-channels` and no `--mcp-config`, because the plugin carries the same
server and registering it twice would run two relays against one session. Every host in the table
carries plain `--channels`, because `Install-All.ps1` installs and allowlists the plugin and an
installed plugin's relay loads in every session regardless of route, which makes the development
flag beside it exactly that double registration. A new host runs the verification below on its
first wrapped launch. Add a new host to that table rather than branching elsewhere.

## The relay as a plugin

This repository is a plugin marketplace hosting one plugin, and that plugin provides the relay as a
channel. `.claude-plugin/marketplace.json` names the marketplace `sapplefeld-channels` and lists
the plugin `relay` at `./plugins/relay`; `plugins/relay/.claude-plugin/plugin.json` declares the
channel, and `plugins/relay/.mcp.json` registers the server behind it. What the plugin route buys
is the removal of the development flag and its launch dialog, and with it the option of an
unattended supervisor that restarts a crashed session, which the dialog forecloses because a
keypress at the terminal cannot be automated away.

Install it on a host, from a session in any directory:

```
/plugin marketplace add D:\sapplefeld-channels
/plugin install relay@sapplefeld-channels
```

An installed plugin is a copy of its own directory in Claude Code's plugin cache, not this
checkout, so the plugin cannot run the relay itself: `relay/index.ts` imports sibling repository
modules and this repository's `node_modules`, and neither exists beside a cached copy. The plugin
ships a shim instead, `plugins/relay/launch.mjs`. It reads
`%LOCALAPPDATA%\sapplefeld-channels\relay-mcp.json`, the registration the wrapper rewrites on every
launch, and runs the relay named there with the MCP conversation passed straight through. The relay
serving the channel is therefore always the one in the checkout that launched the session, and a
checkout that moves needs no reinstall. A missing or unreadable registration makes the shim exit
non-zero with one line on stderr naming the path it looked for, rather than registering a channel
that is silently dead.

Claude Code builds the reply tool's permission rule from the key the server arrives under, and the
plugin route scopes that key by the plugin carrying it. `hooks/settings-fragment.json` ships one
allow rule, `mcp__plugin_relay_channel-relay__reply`, the name a plugin-route session's tool calls
carry on the wire. Six repository places hold that name in agreement: the fragment,
`install/Install-Functions.ps1`'s `$script:AllowedChannelPermissionRules`,
`relay/reply-permission.test.ts`, `install/Install-Functions.test.ts`,
`install/Install-Host.test.ts`, and `plugins/manifest.test.ts`. The development route's rule,
`mcp__channel-relay__reply`, is deliberately absent from all of them: every fleet host runs the
plugin route, and a rule with no route that needs it is a standing squattable pre-approval. A host
dropped back onto the development flag therefore parks its first reply on a permission prompt; for
a longer stay, add that rule by hand to that host's `~/.claude/settings.json` and remove it when
the host returns. `Install-Host.ps1` adds rules and never removes one already there, so a host
provisioned while the fragment still shipped the development rule keeps it until the same hand
edit removes it.

**This is the one place a host can be installed into a half-working state.** A host launched with
plain `--channels` before its plugin is installed and allowlisted has its channel refused, and then
the session starts, the hooks announce it, the thread opens and the card ticks, and messages typed
into the thread reach nothing. That is the same shape as the `channelsEnabled` failure
[`operations.md`](operations.md) describes. So verify a host before its table entry moves:

1. Install the marketplace and the plugin on that host, and write the managed-settings file above.
2. Point that host's entry in `$script:ChannelFlagByHost` at `--channels` and launch through the
   wrapper, from a freshly dot-sourced shell. The wrapper is the only route worth testing: a
   session started without it carries no process token, so it gets no thread and there is nothing
   to answer.
3. Check three things: no full-screen warning dialog at launch; a message typed in the session's
   thread reaching the session; and a reply from the session landing back in the thread. The
   in-terminal launch output looks no different on a healthy plugin-route launch, so the thread
   round-trip is the check, not the banner.
4. Confirm the permission rule matched. A session running with permissions bypassed raises no
   prompt, so the direct check is the wire: after the reply lands, `curl.exe -s
   http://127.0.0.1:8787/sessions` shows that session's `lastTool` as
   `mcp__plugin_relay_channel-relay__reply`. A session that instead parks its reply on a permission
   prompt is showing you the rule name Claude Code built; if it is not the shipped rule, that
   observed name replaces the plugin-scoped one in the six places above.
5. If any check fails, put the entry back on `--dangerously-load-development-channels` before
   working on the host again, and expect the first reply there to raise a permission prompt: the
   development route's rule is not installed.
