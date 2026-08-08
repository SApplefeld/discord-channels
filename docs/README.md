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
| [`operator-checks.md`](operator-checks.md) | Six checks that need a human at a terminal, a phone, or an Administrator prompt. Five have been run and passed, including E, which confirmed that Discord draws no mention pill or timestamp chip inside a code block and that the per-session mirror off switch holds on a real host. Check F, the side-by-side watch of a long turn with the console beside the thread, covering the coalesced narration, the one-copy close, and whether the thread carries everything the console carried, is not yet run. The file records each result and keeps the procedure for re-running it on a new host. |

## Plans

| Plan | Status | What it is |
|---|---|---|
| [`plans/channels_thread-fidelity_spec_v1.md`](plans/channels_thread-fidelity_spec_v1.md) | In Progress | The thread carries what the console carried: narration coalescing survives the broker's own gateway echo (freshness judged by snowflake high-water), the tailer baselines at the mirror-on verdict so a first turn narrates from its opening chunk, mid-turn queued prompts mirror through the tailer with the same attribution and envelope check as hook-mirrored prompts, and split replies pace themselves against the rate-limit budget instead of truncating. |

Archived plans, most recent first.

| Plan | Status | What it is |
|---|---|---|
| [`archive/plans/channels_reply-dedup-and-repair_spec_v1.md`](archive/plans/channels_reply-dedup-and-repair_spec_v1.md) | Complete | One copy of a turn's close: a mirrored reply repeating a reply-tool answer, exactly or nearly and no longer than it, is suppressed on bounded sketches rather than retained text, both orderings collapse to one copy, and the record lives one turn. Also `install/Repair-Broker.ps1`, the one command for a stale, doubled, or orphaned broker, killing only under a proof-based decision table, verified by two real runs on SCOTT. |
| [`archive/plans/channels_narration-coalescing_spec_v1.md`](archive/plans/channels_narration-coalescing_spec_v1.md) | Complete | Mid-turn narration chunks edit-append into one growing thread message while it is the newest thing in its thread, instead of one headed message per chunk. Freshness comes from the gateway echo with snowflake ordering, a per-thread invalidation clock, and direct clears from the steering writer; every failure direction is a fresh post, never lost narration. Operator check F is the live gate still to run. |
| [`archive/plans/channels_install-simplification_v1.md`](archive/plans/channels_install-simplification_v1.md) | Complete | One-command host provisioning: `Install-All.ps1` runs everything scriptable unelevated, launches a single UAC child for the scheduled task, managed settings, and the machine-wide `cchat` launcher, then waits on the broker's real readiness signal. Closed when its two operator gates passed: NEO verified live on the plugin route, and ASR provisioned by the installer's first real end-to-end run. |
| [`archive/plans/interim-mirroring_spec_v1.md`](archive/plans/interim-mirroring_spec_v1.md) | Complete | Mid-turn visibility on long turns: the assistant text written between tool calls, recovered by tailing the session's own transcript file and deduplicated against the mirror's post of the turn's final reply, plus a bounded tool-input preview on the status card. Four Chapters, including the review round that inverted the mirror switch's fail direction for a stream the broker reads rather than receives. |
| [`archive/plans/channel-quality-and-plugin_spec_v1.md`](archive/plans/channel-quality-and-plugin_spec_v1.md) | Complete | Four operator-reported channel-quality items and the plugin packaging: deleted surfaces of dead sessions stay deleted, reply-tool answers carry their own attribution and split instead of truncating, the operator's own channel messages stop echoing back, and the repository ships as a plugin marketplace whose relay plugin removes the launch dialog, verified live on SCOTT. |
| [`archive/plans/subprocess-and-hardening-fixes_spec_v1.md`](archive/plans/subprocess-and-hardening-fixes_spec_v1.md) | Complete | Two silent-failure defects operator check E surfaced: a `claude` subprocess superseding its parent's session and quietly ending its mirroring, and the installer reporting a successful install having hardened nothing. |
| [`archive/plans/channel-mirroring_spec_v1.md`](archive/plans/channel-mirroring_spec_v1.md) | Complete | Console-to-channel mirroring: every console prompt and every turn's final reply posted into the session's thread, making the return path structural rather than dependent on the model choosing the reply tool. Five Chapters, including the measurement that removed a whole planned script and the finishing pass that closed four cross-section gaps. |
| [`archive/plans/sapplefeld-channels_spec_v1.md`](archive/plans/sapplefeld-channels_spec_v1.md) | Complete | The design and build record for the whole system, in seven sections, with a Chapter per section covering what shipped, the decisions, and the surprises. |

[`backlog.md`](backlog.md) carries cross-effort next-steps that belong to no single open plan.

`tools/` holds the hook-capture harness the operator checks use.

## Related work

This repository is deliberately independent of `sapplefeld-ai-os` (the Spine and Reach autonomous
engine). It is in part a fallback for the case where that system is unavailable, so it shares no bot
identity, process, or state with it.
