# Operating the broker

## Where things are

| What | Where |
|---|---|
| Broker state (the session registry) | `%LOCALAPPDATA%\sapplefeld-channels\broker-state.json` |
| Thread bindings | `%LOCALAPPDATA%\sapplefeld-channels\discord-threads.json` |
| Host configuration | `%LOCALAPPDATA%\sapplefeld-channels\broker.env` |
| Log file | `CHANNEL_BROKER_LOG_FILE` in `broker.env`, by default `%LOCALAPPDATA%\sapplefeld-channels\broker.log` |
| Scheduled task | `SapplefeldChannelsBroker`, at logon, restarts on failure |

The log is the first place to look when anything is wrong. Several failures here are deliberately
silent everywhere else: the `SessionStart` hook swallows every error so it can never slow or block a
session, and the broker answers a misrouted or forged hook post with a quiet acknowledgement rather
than an error. The log is where those become visible.

```powershell
Get-Content $env:LOCALAPPDATA\sapplefeld-channels\broker.log -Tail 50 -Wait
curl.exe -s http://127.0.0.1:8787/sessions
```

## The failure this design exists to make visible

`channelsEnabled` is an organization-level managed setting. When it is off, the channel server still
connects and its tools still work while channel messages silently stop arriving, and the warning
fires **at startup only**. A `claude-swap` seat rotation lands mid-session, hours later, so a swap
onto an account without `channelsEnabled` kills message delivery with no signal at all.

The status card closes that hole, and it is why the card is a safety feature rather than polish. The
two paths fail independently: the card is fed by hooks running locally over loopback, while messages
ride the channel. If channels die on a swap, **the card keeps ticking**. You see a session that is
demonstrably alive and working while your messages go unanswered, which names the failure exactly.
Without the card, the same failure is indistinguishable from Claude ignoring you.

So: a thread whose card is updating but whose messages are ignored means channels are off on the
current account. Check which account `cswap` last moved to and whether that account has
`channelsEnabled`.

## Reading a thread

Thread names are glyph-first because the mobile thread list truncates hard and the actionable part
has to survive truncation.

```
⏸ neo-warden      needs you · Bash
⚙ neo-intake      working · 14m
✅ scott-kit       idle · 1h
⚠ asr-docs        exited · 3h
```

`working` and `idle` are derived from how recently hook traffic arrived. `exited` means the session
ended, or that it went silent past the presumed-dead horizon.

Renames are the scarcest resource here. Discord documents no limit on channel or thread modification
and says limits should not be hard-coded, so the broker reads the rate-limit response headers and
adapts. A rename it cannot afford is **dropped, never queued**, because a rename landing ten minutes
late paints a state that stopped being true. The card underneath is edited in a far looser bucket and
carries the detail.

## Tunables

All live in `broker.env` and take effect on restart.

| Setting | Default | What it decides |
|---|---|---|
| `CHANNEL_STALE_AFTER_MS` | 5 min | Silence after which a session is marked stale |
| `CHANNEL_DISCORD_IDLE_AFTER_MS` | 2 min | Silence after which a thread reads `idle` rather than `working` |
| `CHANNEL_DISCORD_EXITED_AFTER_MS` | 4 hours | Silence after which a stale session is presumed dead and reads `exited` |
| `CHANNEL_DISCORD_DWELL_MS` | 60 s | How long a state must hold before a rename is spent on it |
| `CHANNEL_DISCORD_ARCHIVE_ON_END` | off | Whether an ended session's thread is archived |
| `CHANNEL_RETAIN_TERMINAL_MS` | 24 h | How long an ended session is kept before pruning |

`CHANNEL_DISCORD_EXITED_AFTER_MS` is the one most likely to want moving. It is the backstop for a
session that was hard-killed: nothing fires a hook on a kill, so without it a dead session would show
the success glyph indefinitely. Four hours is deliberately long, so that a slow tool call, a
compaction, or a session parked at a prompt is never reported as a death. Shorten it if you would
rather learn about a dead session sooner and can tolerate the occasional false report. It must stay
above `CHANNEL_STALE_AFTER_MS`; the broker refuses to start otherwise.

## When something is wrong

**A session never appears as a thread.** Check the log for the intake refusing or dropping its posts.
A session started without the launch wrapper carries no process token, is not watched, and is
correctly ignored. If the checkout moved, the launch wrapper refuses to start rather than running
unwatched; re-run the installer.

**Threads stop updating but the broker is running.** Check the log for a rejected token. The broker
stops its Discord surfaces after one rejection rather than retrying forever, and says so once.

**The broker will not start.** It refuses a token file that any account on the machine can read or
write, and it refuses one whose directory is that permissive, naming the file and the principal. Re-
run the installer, which sets both.
