# Active Plans

This folder holds active plans only: specs that are open or in progress. A plan is the single source
of truth for one effort's intent and state, and a fresh or post-compaction session resumes from it.

No plan is open. One is parked at `Status: Ready`:
[`channels_stale-after-restart_spec_v1.md`](channels_stale-after-restart_spec_v1.md), which ends a session lost in a broker
outage and keeps its deleted thread deleted. Everything delivered, shelved or declined is in
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
