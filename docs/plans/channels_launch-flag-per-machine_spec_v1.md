# A new machine launches without editing the wrapper

Status: In Progress
Commit model: Branch-and-PR

## Goal

A machine that is not SCOTT, NEO or ASR launches wrapped sessions with no edit to any file in the
checkout, so its broker checkout stays clean and `Repair-Broker.ps1 -Pull` keeps updating it.

## Intent

Approved by the operator on Discord, 2026-10-01: "go ahead and fix that now". The defect came from
the coordinator, relayed from the persona session writing the client-sandbox runbook. The launch
wrapper refused any machine missing from `$script:ChannelFlagByHost`, a table in its own source. A
client host therefore had to edit tracked code, and `Update-ChannelCheckout` skips the pull on any
dirty tree. The one documented way around the edit, setting `CHANNEL_HOST_NAME` to a known name,
also relabels every card and record, because the broker reads that variable as its host label.

Not done: no change to the broker, the installer or `broker.env`. No per-host table survives in
another form.

## Approach

Every machine in the table already took `--channels`, so the table carried no per-host information.
The wrapper takes `--channels` by default. One user environment variable, `CHANNEL_LAUNCH_FLAG`,
overrides it with `--dangerously-load-development-channels` for the rollback `docs/install.md`
describes. Any other non-empty value refuses the launch. `Resolve-ChannelHost` and the table go.
`CHANNEL_HOST_NAME` remains the broker's display label and no longer affects the launch.

An environment variable rather than a `broker.env` key: `Set-ChannelEnvFile` carries forward only
keys on the broker allowlist when the installer rewrites that file, so a hand-added key would vanish
on the next `Install-Host` run and silently move the machine back to `--channels`.

Acceptance:

- With `CHANNEL_LAUNCH_FLAG` unset, on any machine name, the launch line is the plain-channels line.
- With it set to the development flag, the launch line is the development line.
- With it set to anything else, the wrapper throws naming the two accepted values, and `claude` is
  never called.
- `docs/install.md` no longer tells anyone to edit the wrapper, and documents the variable.

## Sections of Work

### Section 1: Flag from the environment
Model: opus
Locus: inline
Files in scope: wrapper/Enter-ClaudeSession.ps1, wrapper/launch-line.test.ts,
wrapper/no-mirror.test.ts, docs/install.md

## Chapters
