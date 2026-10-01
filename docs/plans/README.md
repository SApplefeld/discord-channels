# Active Plans

This folder holds active plans only: specs that are open or in progress. A plan is the single source
of truth for one effort's intent and state, and a fresh or post-compaction session resumes from it.

One plan is open:

- [`channels_board-worktree-progress_spec_v1.md`](channels_board-worktree-progress_spec_v1.md) (In Progress, two sections, Branch-and-PR): the `Fleet: Board` card draws a worker's plan progress from the Chapter count and next step the worker's own plugin wrote to its store, preferring them over the launch folder's stale copy of the plan file, and draws a plan with no file under any swept folder from the store alone. Reads `chapterCount` today and the two fields the plugin's companion plan `agent_persona_plan-record-sections_spec_v1.md` adds.

The most recently archived plan is
[`../archive/plans/channels_launch-flag-per-machine_spec_v1.md`](../archive/plans/channels_launch-flag-per-machine_spec_v1.md),
delivered: a new machine launches wrapped sessions without editing the wrapper, on plain
`--channels` unless its own `CHANNEL_LAUNCH_FLAG` asks for the development flag.

Everything delivered, shelved or declined is in
[`../archive/plans/`](../archive/plans/), listed newest first in [`../README.md`](../README.md).

## Rules

- A plan lives here while it is being worked. When it reaches `Status: Complete`, or is abandoned,
  shelved or declined, it moves to `../archive/plans/` in the same close-out that finished it, via
  `git mv`, so history is preserved and the Chapters travel with the file.
- Naming: `<project>_<content-type>_v<n>.md`. Increment the version rather than overwriting a prior
  one.
- The `Status` header drives the lifecycle. `In Progress` plans are surfaced for resume; a
  `Complete` plan still sitting here is unarchived and is the thing this folder exists to prevent.
- When a plan relates to or supersedes another, cross-reference it in a `## Related plans` section.
