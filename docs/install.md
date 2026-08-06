# Installing a host

One broker per host, one Discord bot identity per host, one channel per host. A broker reaches its
sessions over localhost, so it cannot serve another machine.

The three hosts are NEO, ASR, and SCOTT. NEO and ASR are organization-owned; SCOTT is a personal Max
account with no organization. That difference decides two things below: the channel flag the launch
wrapper uses, and whether the launch dialog appears.

## 1. Create the Discord application

Once per host, so three times. Each host gets its own bot so the three fleets never share an
identity, and so a revoked token takes down one machine rather than all of them.

1. At <https://discord.com/developers/applications>, create an application and name it for the host.
2. Under **Bot**, create the bot and copy the token. It is shown once.
3. Under **Bot**, enable **Message Content Intent**. Without it the bot receives message events with
   empty content, which reads as a silent delivery failure rather than a permission error.
4. Under **OAuth2 > URL Generator**, select the `bot` scope and these permissions: View Channels,
   Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message
   History.
5. Open the generated URL and invite the bot to your server.
6. Create a text channel for the host and copy its ID (right-click the channel with Developer Mode
   on). Copy your own user ID the same way; it is the only account permitted to steer a session.

Create Public Threads and Manage Threads are the two that fail quietly if missed: the broker posts a
starter message successfully and then cannot open a thread on it.

## 2. Provision the host

From the repository root, elevated is not required for this step:

```powershell
install\Install-Host.ps1 -HostName SCOTT -ChannelId <channel id> -AllowedUserId <your user id>
```

It prompts for the bot token and reads it without echoing. **Do not pass the token as plain text on
the command line**: PowerShell's history file keeps it in the clear indefinitely, and it also lands
in the process command line and in transcription logs. `-BotToken` accepts only a `SecureString` for
that reason. Use `-BotTokenFile <path>` instead to read a token from a file you already placed, and
put that file inside the state root, which is where the installer hardens permissions.

`-Port` must agree with the two hook URLs in `hooks/settings-fragment.json` and the literal in
`hooks/session-start.ps1`. Those three are pinned together by the test suite, and the installer
refuses a port that disagrees rather than moving one copy and silently disconnecting the hooks.

The installer:

- writes `broker.env` and the token file under `%LOCALAPPDATA%\sapplefeld-channels\`, outside the
  repository,
- substitutes this checkout's absolute path into the `SessionStart` hook and merges the three hooks
  into your user-level `~/.claude/settings.json`, backing it up first and preserving every hook and
  setting that is not this project's,
- hardens the access control lists on the hook script, the launch wrapper, the token file, and the
  token file's directory,
- runs `npm ci`, which installs the reviewed lockfile rather than resolving newer dependencies.

The hooks belong in the **user-level** settings file rather than a project one, because the sessions
being watched live in arbitrary repositories. That is also why the `SessionStart` hook names its
script by absolute path: a hook runs with the monitored session's own project as its working
directory. Re-run the installer after moving or re-cloning the repository; the launch wrapper refuses
to start a session when the installed hook points somewhere else, rather than letting every session
run unwatched.

## 3. Install the service

Elevated, once:

```powershell
install\Register-BrokerTask.ps1
```

This registers a scheduled task that starts the broker at logon and restarts it on failure. Running
it again updates the existing task rather than creating a second one. It refuses to run unelevated
with a message saying so, rather than failing with an access error further in.

## 4. Launch a session

```powershell
. .\wrapper\Enter-ClaudeSession.ps1
Enter-ClaudeSession -Name 'neo-warden'
```

The name is yours to choose, appears in the thread title, and may repeat across sessions: thread
identity is the session ID, not the name. It is restricted to printable ASCII, because the name
travels as an HTTP header and a non-ASCII one would fail in a way that silently prevents the session
from ever being announced.

Confirm the session registered:

```powershell
curl.exe -s http://127.0.0.1:8787/sessions
```

## The launch dialog, on NEO and ASR

A custom channel is not on Anthropic's approved allowlist, so it normally requires
`--dangerously-load-development-channels` and a full-screen warning that needs a keypress at the
terminal. On Team and Enterprise plans an organization admin can set `allowedChannelPlugins` to
include a plugin from their own marketplace, which replaces the Anthropic allowlist entirely. NEO and
ASR take that route and launch with plain `--channels` and no dialog; SCOTT keeps the flag and the
keypress.

`channelsEnabled` and `allowedChannelPlugins` are managed settings, deliverable on Windows as a local
file at `C:\Program Files\ClaudeCode\managed-settings.json`, a `managed-settings.d\` drop-in
directory, or `HKLM\SOFTWARE\Policies\ClaudeCode`. All three are machine-scoped rather than
account-scoped, so one file per host survives every account rotation.

**Note that the replacement is total.** Once `allowedChannelPlugins` is set, any shipped channel
plugin you also want must be listed alongside this project's.

## Not yet installable

Packaging the relay as a plugin, and naming it in `allowedChannelPlugins`, waits on the relay itself
(Section 5 of the plan, which is gated on the rotation check in
[`operator-checks.md`](operator-checks.md)). Until then a host runs the broker, the hooks, and the
Discord surfaces: sessions appear as threads and the thread list works as a dashboard, but there is
no path for sending a message into a session.
