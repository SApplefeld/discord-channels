# Active Plans

This folder holds active plans only: specs that are open or in progress. A plan is the single source
of truth for one effort's intent and state, and a fresh or post-compaction session resumes from it.

One plan is parked as Ready for the worker's queue:
[`channels_card-steward-asks_spec_v1.md`](channels_card-steward-asks_spec_v1.md), which has a
supervised session's steward-shaped `ASK: <question>? Recommend: <choice>` reply open an item on the
`Fleet: Inbox` card with a `supervisor ask` marker, instead of opening nothing. It builds on
[`../archive/plans/channels_judge-unmirrored-replies_spec_v1.md`](../archive/plans/channels_judge-unmirrored-replies_spec_v1.md).
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
