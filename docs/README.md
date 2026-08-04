# Documentation index

## Plans

| Plan | Status | What it is |
|---|---|---|
| [`plans/sapplefeld-channels_spec_v1.md`](plans/sapplefeld-channels_spec_v1.md) | In Progress | The whole system: a per-host broker daemon, a relay MCP channel, and session-lifecycle hooks that surface each running Claude Code session as a Discord thread you can watch and steer from a phone. |

## Reference

| Document | What it is |
|---|---|
| [`operator-checks.md`](operator-checks.md) | The four checks that need a human at a terminal, a phone, or an Administrator prompt: the seat-rotation gate that blocks sections 5 and 6, the `/clear` behavior, the mobile header, and whether a local managed-settings file controls channels on a host. Each states its steps, its pass criteria, and what the answer changes. |

`tools/` holds the hook-capture harness those checks use. `install.md` and `operations.md` arrive
with section 7.

## Related work

This repository is deliberately independent of `sapplefeld-ai-os` (the Spine and Reach autonomous
engine). It is in part a fallback for the case where that system is unavailable, so it shares no bot
identity, process, or state with it.
