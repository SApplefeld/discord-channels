# channels: one Discord thread across a supervisor's restarts, v1

Status: In Progress
Commit Model: Branch-and-PR. Work on branch `passive-supervisor-rebind`, push to `origin`, open a PR against `main`, never push directly to `main`.
Created: 2026-09-11
Worker: the `agent_persona` supervisor's own persona, building this on the operator's explicit instruction (relayed via `agent_persona/discussion.md`) that this repository is open for this one requirement.

## Goal

A long-running Claude Code supervisor (`agent_persona`'s `bin/supervise.sh`) restarts its child on every goal completion, and on a crash. Each restart is a new Claude Code session with a new session ID. Today the broker binds a Discord thread to a session ID (`broker/registry.ts`), so a supervisor's restart opens a brand-new thread, and the operator ends up following a trail of short-lived threads instead of one conversation with one long-running worker.

The fix: a session that carries a stable "lineage name" (set by the supervisor, constant across every child it launches) rebinds to the thread its lineage already owns, instead of opening a new one. The existing per-session behavior for every other launch shape (the wrapper, `wrapper/Enter-ClaudeSession.ps1`) is unchanged: only a session that opts into a lineage name gets this behavior, and the impostor guard at `registry.ts:484` still holds for every session that doesn't.

## Related plans

`sapplefeld-channels_dsh-bridge_spec_v1.md` is a separate, currently active effort in this repository (Status: In Progress, `bridge/` in flight). This plan does not touch `bridge/` and has no dependency on it.

## Roadmap

1. A session declares its lineage. A new env var, `CHANNEL_LINEAGE` (parallel to `CHANNEL_SESSION` and `CHANNEL_PROCESS_TOKEN`), set by a launcher that wants restart continuity. `bin/supervise.sh` in `agent_persona` sets it once per supervisor lifetime (already has the stable name available as `$CHANNEL_NAME`); the wrapper (`Enter-ClaudeSession.ps1`) never sets it, so interactive wrapper-launched sessions are unaffected. Proof: a registry unit test asserting a session with no `CHANNEL_LINEAGE` behaves exactly as today.

2. The registry rebinds instead of creating. When a session with a `CHANNEL_LINEAGE` value registers (`SessionStart` hook post, `POST /hook`), the registry checks its persisted thread bindings for an existing thread bound to that lineage. If one exists, the new session's record takes over that thread binding (the old session's own record is superseded the way a same-token restart already supersedes today, per `registry.ts`'s existing "ends a previous session when a token announces a new one" behavior) rather than the surface creating a new thread. If none exists (the supervisor's first-ever launch), a new thread is created and bound to the lineage, same as today's per-session binding, so the lineage becomes the thread's owner from then on.

3. A restart says so, once, in the thread. The moment a lineage rebind happens (not the first launch), the surface posts one line into the thread - a system-style notice, not attributed to either party - naming that the supervisor restarted. This uses the existing notice-posting path the rest of the surface already has (the `Discord outbound` reconciliation pass in `docs/architecture.md`), not a new one.

4. The impostor guard is unaffected. `registry.ts:484` and its neighbors, which guard the title-storage cycle, take no new input from this feature and are not touched. A session carrying no lineage is invisible to the new lookup path entirely - it is a strict addition, not a rewrite of the existing binding logic.

5. `docs/architecture.md` gets one paragraph. Under "The name a session goes by" or its own small section: what a lineage is, that it is opt-in, and that it is the one case where a restart's new session ID does not mean a new thread.

## Out of Scope

- Multiple supervisors sharing one lineage name (a collision is a caller error the registry may refuse or log, not something this plan resolves).
- Anything under `bridge/` (see Related plans).
- Changing the wrapper's own per-session behavior.

## Chapters

(none yet)
