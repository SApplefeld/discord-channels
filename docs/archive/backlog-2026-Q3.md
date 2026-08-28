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

- **A usage and fleet-health card in the channel.** Graduated to its own plan and delivered by it,
  [`plans/channels_usage-card_spec_v1.md`](plans/channels_usage-card_spec_v1.md): one always-there
  "Fleet: Usage" thread whose card mirrors claude-swap's local cache rather than invoking a CLI
  that mutates credentials and spends a shared request budget, plus the model, context size and
  subagent roster on each session's own card. The operator-only deploy and walk survive on the live
  backlog rather than here.

## Completed 2026-08-16

- **The status card's context figure no longer doubles on a multi-iteration turn.** `contextTokens()`
  in `broker/tail.ts` reads one iteration of `usage.iterations` when the array is present and
  non-empty, and the top-level fields otherwise; the iteration chosen is the largest rather than
  the last, mirroring the kit compaction gate's `consumedFromUsage` rule and its fail-direction
  argument exactly, so the card and the gate cannot read one transcript row two ways. (The parked
  note said "last entry"; the kit's shipped rule is largest, and matching the shipped rule won.)
  Two regression tests pin the largest-iteration read and the malformed-array refusal, both watched
  red before the fix.

- **Draw the board card's project headings stronger.** Retired 2026-08-16 by
  [`plans/channels_render-tweaks_spec_v1.md`](plans/channels_render-tweaks_spec_v1.md) section 1,
  which went further than the item asked: the project label is no longer a heading at all but a
  one-line fenced block, which Discord paints as a full-width shaded box. `PROJECT_HEADING`, the
  constant the item named, no longer exists. The item's own reasoning is why the stronger answer
  won: the project is the boundary the card is scrolled by, and a shaded box separates two lists
  more sharply than any heading level does.

- **Order the plans within a project.** Retired 2026-08-16 by the same plan's section 2, built on
  the item's recommended key and settling the design point it left open. Plans order by modification
  time newest first, with the filename stem breaking a tie; projects order the same way by the
  newest plan under each, with `CHANNEL_BOARD_PROJECTS` as the tie-break and a project the card
  cannot date sinking below every one it can. The sort runs behind the per-root cap of 64, at the
  card rather than at the sweep, so it reorders whichever plans the name-ordered listing returned
  and leaves the cap defined against that listing exactly as before.

- **Make a cross-session exchange watchable from one Discord surface.** Retired 2026-08-26 by
  [`plans/channels_peer-traffic_spec_v1.md`](plans/channels_peer-traffic_spec_v1.md). Peer traffic
  now renders in both directions under its own `📡` register, unquoted, so the operator's `>>>`
  block stays theirs alone; the item's first step, reading how the mirror rendered peer traffic
  today, turned up two defects rather than a gap, an inbound message drawn inside the operator's
  own quoted register and an outbound one drawn nowhere at all. A peer prompt also no longer
  stamps engagement, so a message from another session cannot clear a `⛔` a person is owed.
  Verified on the live thread on 2026-08-26 rather than in the suite alone: three real messages
  from a peer session, two delivered mid-turn and one to a deliberately idle session, each
  rendered once under the peer attribution, and this session's own outgoing messages rendered
  too. The item's second half, a per-exchange view showing both halves of one conversation, was
  parked deliberately in the plan's Design section and not built: with both directions rendered,
  a session's own thread already carries every exchange it is party to, and no correlation
  identifier exists to key a cross-thread view on.

## Completed 2026-08-28

- Peer-chatter rendering in threads: subtext, not spoilers (parked 2026-08-27; operator-approved
  and slotted as the first post-reboot effort, in parallel with claude-kit's coordination spec).
  Delivered: the register shipped in `669cb8f` and the collapsed form in `d0cba9c`, and this item
  is retired at that plan's close-out. Session-to-session relays used to render at full size in
  the same voice as operator-facing lines, so the operator re-checked headers every few lines to
  know the audience, which from a phone was the dominant reading cost of a busy thread. The approved design: normal text for
  operator-facing lines; Discord's `-#` subtext (small grey type, scannable without a tap, one
  prefix per line) for session-to-session chatter, each block led by a bold one-line header naming
  sender and receiver so the routing stays readable at full size; spoilers reserved for oversized
  bodies nobody scans anyway. The rendering check is settled (2026-08-27, operator's phone client,
  a broker-posted three-form sample in this machine's relay thread): subtext renders small and
  grey with the bold header at full size, confirmed; `>` blockquote does not render on
  relay-posted messages at all (literal `>` characters at full size), which removes it as an
  option on this surface; spoilers render but occupy the same space as plain text and stay open
  once tapped, confirming them as worst-of-both for scannable chatter. The one alternative still
  standing is bot-authored embeds (colored sidebar cards), the strongest separation but a bigger
  broker change, not needed unless subtext proves insufficient in practice. This item owns the
  rendering-of-chatter surface; the spoiler-collapsed task-reports item above should take its
  rendering from whatever this decides, and the volume-of-chatter half (audience labels on relays,
  delta-only capped operator reports) lives in claude-kit's coordination spec under its 2026-08-27
  slate, so the two compose rather than overlap.
  Retired at the plan's close-out. The plan is archived at
  [`plans/channels_peer-chatter-rendering_spec_v1.md`](plans/channels_peer-chatter-rendering_spec_v1.md),
  whose Chapters carry the delivered design, the eight live readings, and the one accepted
  residual: inside a spoiler a tap has revealed, a peer body can compose a line shaped like the
  renderer's own attribution, because the escape that would mark it is one the client consumes.
