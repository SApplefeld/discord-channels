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
⚙ neo-intake      working · 14m
⚙ neo-migrate     working · 2m
✅ scott-kit       idle · 1h
⚠ asr-docs        exited · 3h
```

`working` and `idle` are derived from how recently hook traffic arrived. `exited` means the session
ended, or that it went silent past the presumed-dead horizon. `needs you`, the ⏸ glyph, means that
session has a permission prompt open and is parked until you answer it. It is recomputed on every
refresh from the set of prompts still waiting, so it clears on its own when you answer, and it is
urgent enough to spend a rename immediately rather than waiting out the dwell window. A pending
prompt therefore reaches you twice: as a message that pings, and as the thread's own name in the
list.

Renames are the scarcest resource here. Discord documents no limit on channel or thread modification
and says limits should not be hard-coded, so the broker reads the rate-limit response headers and
adapts, per thread rather than globally. A rename it cannot afford is **dropped, never queued**,
because a rename landing ten minutes late paints a state that stopped being true. The card underneath
is edited in a far looser bucket and carries the detail: session ID, host, state, last tool and what
that tool was called with, turn count, and heartbeat.

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

Two knobs govern it, both in `broker.env`:

| Setting | Default | What it decides |
|---|---|---|
| `CHANNEL_INTERIM_MIRROR` | on | Whether the transcript is tailed at all, which is what carries both mid-turn narration and a message typed at the console mid-turn; also gated by `CHANNEL_MIRROR`, so the host-wide switch turns both off together |
| `CHANNEL_INTERIM_POLL_MS` | 20 s | How often the tailer polls each live session's transcript; refuses below 1 s or above 5 min |

Turning `CHANNEL_INTERIM_MIRROR` off silences everything the tailer carries, mid-turn narration and
mid-turn typed messages alike, while the prompt that opens a turn and the reply that closes it keep
mirroring: those two ride hooks rather than the transcript, and the two mechanisms stop
independently. What an interim-off host loses on the prompt side is the mid-turn kind alone, the one
no hook fires for. `CHANNEL_MIRROR` off stops all of it, hooks included. The one-copy close above
survives an interim-off host, because the record the mirror compares against is written by the reply
tool rather than by the tailer, and it exists whenever `CHANNEL_MIRROR` is on. A session launched
with `-NoMirror` neither narrates nor carries the messages typed into it, for the same reason its
prompts and replies do not mirror.

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
- `tail: session <id>'s queued prompt delivery failed (...)`: the delivery of one mid-turn typed
  message threw, and it was dropped without holding up the rest of the pass. The thread carries no
  copy of that message; the console does.
- `tail: session <id>'s transcript pass failed (...)`: the file could not be opened or read this
  pass; the next pass tries again.
- `tail: <reason> occurred N more time(s) in the last 60000ms`: a repeat of one of the lines above,
  aggregated into one summary line rather than logged once per poll.

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

One further `routing:` line costs a message rather than a header. `routing: the queued prompt from
session <id> was dropped, it is the operator's own channel message echoed back to the thread it was
posted in` is the check that keeps a message you typed in the thread from arriving back in it a
second time. A message typed at the console is recorded differently and never matches that check, so
this line beside a console message missing from the thread means the message opened with the text
the harness wraps a channel message in, and the console holds its only copy.

**One operational surprise worth knowing.** Narration for a session is armed by a `/mirror` post
carrying that session's mirror-on verdict, not by the session simply being live, so a broker
restarted mid-turn narrates nothing for the remainder of that turn: the verdict that would arm it
already arrived before the restart, under the previous process. The next turn's `UserPromptSubmit`
re-arms it as normal. See [`security-model.md`](security-model.md) for why the gate fails in that
direction rather than the other.

## Tunables

Everything below lives in `broker.env` and takes effect when the broker restarts. Only these keys are
applied: `Start-Broker.ps1` reads the file against an allowlist and skips anything else with a
warning, because write access to that file would otherwise be arbitrary environment injection into
the process that reads the bot token.

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
| `CHANNEL_DISCORD_ARCHIVE_ON_END` | off | Whether an ended session's thread is archived |
| `CHANNEL_MIRROR` | on | Whether console prompts and turn replies are mirrored into the thread |
| `CHANNEL_MIRROR_MAX_BYTES` | 256 KB | Largest mirror post accepted; a larger one is dropped |
| `CHANNEL_INTERIM_MIRROR` | on | Whether the transcript is tailed, which carries mid-turn narration and mid-turn typed messages; also gated by `CHANNEL_MIRROR` |
| `CHANNEL_INTERIM_POLL_MS` | 20 s | How often the tailer polls each live session's transcript; bounded 1 s to 5 min |

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

`CHANNEL_BROKER_PORT` is the trap. Moving it here moves the broker only. Every `http` hook URL in
`hooks/settings-fragment.json` and the literal in `hooks/session-start.ps1` carry their own copies,
and the installer refuses a `-Port` that disagrees with the fragment for exactly that reason. Change
them all, and `broker/config.ts`'s `DEFAULT_PORT` with them.

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
