# Backlog snapshot, 2026 Q3

Items completed and moved out of [`backlog.md`](../backlog.md). This file is append-only history;
the live backlog carries active items only.

## Completed 2026-08-07

- **Measure duplication across the three streams that land in one thread, then decide.** Measured
  by operation rather than instrumentation: the operator reported the reply-tool answer and the
  mirrored final reply repeating each other on long turns, and narration header volume was
  settled by [`plans/channels_narration-coalescing_spec_v1.md`](plans/channels_narration-coalescing_spec_v1.md).
  Acted on by [`plans/channels_reply-dedup-and-repair_spec_v1.md`](plans/channels_reply-dedup-and-repair_spec_v1.md):
  a mirrored reply matching a reply-tool answer, exactly or nearly and no longer than it, is
  suppressed, and both orderings of the duplicate collapse to one copy. What remains watchable,
  whether narration plus a full mirrored reply is more than a thread wants on very long turns, is
  a new observation if it ever itches rather than a standing item.

- **Re-run the installer on this host and confirm it completes without the seven `Set-Acl` errors it
  printed before.** The one acceptance criterion of
  [`plans/subprocess-and-hardening-fixes_spec_v1.md`](plans/subprocess-and-hardening-fixes_spec_v1.md)
  that named this machine. Passed on the second attempt: the first refused on a state-root artifact,
  which is the defect that plan's Chapter 4 records, and the run after that correction reported
  `Verified 77 hardened path(s)` and `Provisioned` with no `Set-Acl` error.
- **Run operator check E** from [`operator-checks.md`](../operator-checks.md), the verification the
  mirroring effort could not close from code. Passed in full: a mention and a timestamp inside a
  fenced code block render as literal text, an escaped line-leading quote opens no blockquote, and
  `-NoMirror` stopped one session's mirroring while another running beside it kept mirroring. Both
  claims the chip escape rests on are now observed rather than inferred.

- **Package the relay as a plugin and move SCOTT off the development flag.** Done in
  [`plans/channel-quality-and-plugin_spec_v1.md`](plans/channel-quality-and-plugin_spec_v1.md): the
  repository is a marketplace hosting the relay plugin (a launcher shim over the checkout's relay),
  SCOTT's managed settings allowlist it, and a live launch verified no warning dialog, the thread
  round-trip, and the plugin-scoped permission rule name observed on the wire
  (`mcp__plugin_relay_channel-relay__reply`).
- **Install the ASR host.** Done by the operator with
  [`plans/channels_install-simplification_v1.md`](plans/channels_install-simplification_v1.md)'s
  `Install-All.ps1`, the installer's first real end-to-end run, which was itself that plan's final
  acceptance gate.
- **Install the NEO host.** NEO was provisioned during the install-simplification effort (its
  wrapper entry flipped to `--channels` in that plan's Chapter 1), and the operator's live
  plugin-route verification on NEO closed the remaining gate.
- **Register the broker's scheduled task and restart it on this host.** The task
  `SapplefeldChannelsBroker` is registered on SCOTT and the broker was restarted onto current code
  by the elevated installer half; readiness confirmed on `/sessions`.
- **Retire the development-route allow rule (`mcp__channel-relay__reply`).** Removed from the six
  repository places that carried it, with the fragment, installer allowlist, and test pins now
  shipping the plugin-scoped rule alone, and swapped out of SCOTT's `~/.claude/settings.json` by
  hand (which had carried only the development rule; the plugin-scoped rule replaced it). The
  remaining per-host hand edits on NEO and ASR stay on the live backlog.
- **Make an inbound cut impossible for a deliverable message, and loud otherwise.** The inbound
  ceiling rose to Discord's own 4,000-character maximum, so no message a client can send is cut;
  a message over the ceiling is delivered cut with an unfloored in-thread notice asking for the
  tail as its own message. Closed by `channels_inbound-whole-delivery_spec_v1.md` the same day the
  operator hit the old silent 2,000 cut live.

## Completed 2026-08-09

- **Answer a console question from the thread.** Graduated to its own plan and delivered by it,
  [`plans/channels_question-answering_spec_v1.md`](plans/channels_question-answering_spec_v1.md):
  the broker holds the `AskUserQuestion` `PreToolUse` request open, posts the questions as an
  interactive message, and answers the hook with the operator's choices, with every failure of the
  hold releasing cleanly to the console picker. The two live checks that plan left open ride on the
  live backlog rather than here.
