# sapplefeld-channels

Watch and steer long-running Claude Code sessions from Discord.

Each running session appears as its own Discord thread. The thread list is a live dashboard of every
session and its state; opening a thread shows what that session is doing now, lets you send it a
message that lands in the running session, and lets you approve a tool permission prompt from your
phone.

The addressing is entirely local, on a Discord bot token, so rotating the Anthropic account paying
for a session (as `claude-swap` does mid-run) cannot break it. That is the failure this exists to
solve: Remote Control registers a session in Anthropic's cloud under the account that created it, and
stops accepting input permanently once the seat rotates out from under it.

## Layout

| Path | What |
|---|---|
| `broker/` | The per-host daemon: Discord gateway, session registry, the surfaces |
| `relay/` | The MCP channel server, a stdio child of one Claude Code session |
| `hooks/` | Session-lifecycle hooks that report identity and activity to the broker |
| `wrapper/` | PowerShell launcher that names a session and starts it with the channel |
| `docs/` | [Index](docs/README.md), plans, and operator runbooks |

Design and build plan: [`docs/plans/sapplefeld-channels_spec_v1.md`](docs/plans/sapplefeld-channels_spec_v1.md).
