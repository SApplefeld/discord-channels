# sapplefeld-channels

Watch and steer long-running Claude Code sessions from Discord.

The design gives every running session its own Discord thread, so the thread list is a live dashboard
of the fleet and opening a thread shows what that session is doing now. Sending a message into a
running session and approving a tool permission prompt from your phone are planned, and both sit
behind a prerequisite gate: it is unproven that a channel survives a `claude-swap` seat rotation, and
the gate's kill condition stops that half of the work if it does not.

Nothing here is built yet. The [build plan](docs/plans/sapplefeld-channels_spec_v1.md) is the record
of what exists.

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

## Runtime model

There is no build step. TypeScript runs directly under Node 24's type stripping, so every entry
point is invoked as source (`node broker/index.ts`), which is also how the scheduled task starts the
broker.

The cost of that is one rule: **relative imports carry the `.ts` extension**, never `.js` and never
bare. Under this configuration a `./thing.js` specifier type-checks clean and then throws
`ERR_MODULE_NOT_FOUND` at runtime, because no `.js` file is ever produced, and no compiler option
catches it. `import-hygiene.test.ts` is the enforcement.

Gates: `npm run lint` (`tsc --noEmit`) and `npm test` (`node --test`, which refuses to report green
when it matched no test files).

Design and build plan: [`docs/plans/sapplefeld-channels_spec_v1.md`](docs/plans/sapplefeld-channels_spec_v1.md).
