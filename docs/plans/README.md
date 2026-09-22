# Active Plans

This folder holds active plans only: specs that are open or in progress. A plan is the single source
of truth for one effort's intent and state, and a fresh or post-compaction session resumes from it.

Two plans are parked as Ready for the worker's queue, both drafted from the backlog at the
operator's ruling. [`channels_tail-until-flake_spec_v1.md`](channels_tail-until-flake_spec_v1.md)
has the tailer tests' shared wait name its condition and say whether a failure was a bound that
expired early or a condition that never held, then moves the bound to wall clock where the evidence
says so. [`channels_shared-helper-owners_spec_v1.md`](channels_shared-helper-owners_spec_v1.md)
gives the broker's repeat logger, card binding, capped file read and modification-time clamp one
owner each, fixing the usage cache's single-read copy on the way. The most recently archived plan is
[`../archive/plans/channels_inbox-clear-on-rebind_spec_v1.md`](../archive/plans/channels_inbox-clear-on-rebind_spec_v1.md).

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
