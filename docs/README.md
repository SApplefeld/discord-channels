# Documentation index

This repository steers long-running Claude Code sessions from Discord. Every running session on a
host appears as its own Discord thread: the thread list is a live dashboard of the fleet, the
thread's first message is a status card showing what that session is doing, the conversation itself
is mirrored into the thread turn by turn, and a message typed in the thread reaches the running
session. Tool permission prompts are answered from the same thread with a one-line reply. All of it
is built and installable.

## Reference

| Document | What it is |
|---|---|
| [`architecture.md`](architecture.md) | The system in one page: the four components per host, the split between hooks (which carry identity, activity, and the conversation outward) and the channel (which is the only path carrying a message in), the data flow across the three route groups, the external integrations, and the no-build-step runtime model. Read this first. |
| [`install.md`](install.md) | Standing a host up: creating the Discord application, provisioning the host, registering the broker's scheduled task, and launching a session. |
| [`operations.md`](operations.md) | Running a host: where state and logs live, how to read a thread, how to answer a permission prompt, the tunables, and what to do when something is wrong. |
| [`security-model.md`](security-model.md) | The trust boundary: what the process token authenticates, what the sender gate is the only authority for, what the permission prompt and the mirror send off the machine, and which files must not be writable. |
| [`operator-checks.md`](operator-checks.md) | Five checks that need a human at a terminal, a phone, or an Administrator prompt. All five have been run and passed, including E, which confirmed that Discord draws no mention pill or timestamp chip inside a code block and that the per-session mirror off switch holds on a real host. The file records each result and keeps the procedure for re-running it on a new host. |

## Plans

No plan is open. Both are archived, most recent first.

| Plan | Status | What it is |
|---|---|---|
| [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md) | Complete | Console-to-channel mirroring: every console prompt and every turn's final reply posted into the session's thread, making the return path structural rather than dependent on the model choosing the reply tool. Five Chapters, including the measurement that removed a whole planned script and the finishing pass that closed four cross-section gaps. |
| [`archive/plans/sapplefeld-channels_spec_v1.md`](archive/plans/sapplefeld-channels_spec_v1.md) | Complete | The design and build record for the whole system, in seven sections, with a Chapter per section covering what shipped, the decisions, and the surprises. |

[`backlog.md`](backlog.md) carries cross-effort next-steps that belong to no single open plan.

`tools/` holds the hook-capture harness the operator checks use.

## Related work

This repository is deliberately independent of `sapplefeld-ai-os` (the Spine and Reach autonomous
engine). It is in part a fallback for the case where that system is unavailable, so it shares no bot
identity, process, or state with it.
