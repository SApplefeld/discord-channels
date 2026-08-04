# Documentation index

## Plans

| Plan | Status | What it is |
|---|---|---|
| [`plans/sapplefeld-channels_spec_v1.md`](plans/sapplefeld-channels_spec_v1.md) | In Progress | The whole system: a per-host broker daemon, a relay MCP channel, and session-lifecycle hooks that surface each running Claude Code session as a Discord thread you can watch and steer from a phone. |

## Reference

Written as sections land. `rotation-gate.md` (S1), `install.md` and `operations.md` (S7).

## Related work

This repository is deliberately independent of `sapplefeld-ai-os` (the Spine and Reach autonomous
engine). It is in part a fallback for the case where that system is unavailable, so it shares no bot
identity, process, or state with it.
