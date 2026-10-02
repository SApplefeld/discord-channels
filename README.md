# sapplefeld-channels

Watch and steer long-running Claude Code sessions from Discord.

Every running session gets its own Discord thread, so the thread list is a live dashboard of the
fleet and opening a thread shows what that session is doing now. The conversation is mirrored into
the thread turn by turn, a message in a thread reaches that session, and a tool permission prompt can
be approved from a phone with a five-letter reply.

The system is installed and running against a real bot: threads open, cards tick, and messages cross
in both directions. What still needs a human rather than a test is recorded in
[`docs/operator-checks.md`](docs/operator-checks.md), which keeps each check's procedure and result.
Install a host per [`docs/install.md`](docs/install.md).

**Mirroring means the conversation leaves the machine.** Prompts and replies are posted to Discord
and retained there. [`docs/install.md`](docs/install.md) says what that covers and how to turn it
off, per host or per session.

The addressing is entirely local, on a Discord bot token, so rotating the Anthropic account paying
for a session (as `claude-swap` does mid-run) cannot break it. That is the failure this exists to
solve: Remote Control registers a session in Anthropic's cloud under the account that created it, and
stops accepting input permanently once the seat rotates out from under it.

## Layout

| Path | What |
|---|---|
| `broker/` | The per-host daemon: Discord gateway, session registry, the surfaces |
| `relay/` | The MCP channel server, a stdio child of one Claude Code session |
| `hooks/` | Session-lifecycle hooks: identity and activity to the broker, and the conversation to the mirror |
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

## Releases

A release publishes the relay's runtime to the public marketplace repository `SApplefeld/plugins`,
where it lives under `plugins/relay/`. A pushed tag cuts it, never a push to `main`:

1. Tag the trunk commit to release with any name starting `publish-`, by convention
   `publish-<YYYYMMDD>`, and push the tag.
2. Read the run of the `publish` workflow in the Actions tab. A manual run of the same workflow
   publishes the commit it is started on.

The job copies only the paths in `tools/publish/allowlist.txt`, which are the plugin shim, the broker,
the bridge, the channel server, the hooks, the wrapper, the install scripts, the three root package
files and `docs/install.md`. It removes `version` from the published plugin manifest, so an install
follows the public repository's commits. It then replaces the public `plugins/relay/` folder with
one commit. It refuses to publish when:

- the allowlist resolves no file,
- a path it resolves is a test file or sits under `docs/`, `tools/` or another excluded zone, apart
  from `docs/install.md`, which the list names by its literal path,
- any file or path in the snapshot carries a word from the banned-word list.

Two repository secrets drive it. `PUBLISH_DEPLOY_KEY` is the private half of the public repository's
write deploy key, and `PUBLISH_BANNED_WORDS` is the banned-word list, one word per line. The list's
content lives in that secret and in no repository. A hit names only the file and line, never the
word.

The public folder keeps this repository's root layout, so the install scripts' relative paths hold.
The marketplace entry points at the shim two levels in, `plugins/relay/plugins/relay`. A host that
installs `relay@applefeld` from the public marketplace sets up the broker from that folder's
`install/` scripts, per the `docs/install.md` shipped beside them.

Design and build plan: [`docs/archive/plans/sapplefeld-channels_spec_v1.md`](docs/archive/plans/sapplefeld-channels_spec_v1.md).
