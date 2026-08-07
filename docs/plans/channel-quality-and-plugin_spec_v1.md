# Channel Quality Fixes and Plugin Packaging

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: research, briefs, and reviews in the main session; implementation dispatched
Created: 2026-08-07

## Goal

Four operator-reported channel-quality items and one packaging effort, all approved in one round on
2026-08-07:

1. A dead session's Discord card resurrects after the operator deletes it.
2. A reply-tool message posts with no attribution header, so it reads as a continuation of the
   message above it.
3. A message the operator types in Discord echoes back into the same thread as a mirrored
   "typed at the console" prompt, wrapped in the harness's `<channel source>` envelope.
4. The relay ships as a per-launch `--mcp-config` registration behind
   `--dangerously-load-development-channels`, which costs a full-screen warning and a keypress at
   every launch. Packaging the repo as a plugin marketplace removes both (existing backlog item).
5. Interim visibility on long turns is poor: mid-turn assistant text never mirrors, and the card
   names the last tool without its input. This effort delivers a spec for a future session, not an
   implementation.

## Evidence and root causes

- Resurrection: `broker/discord/surface.ts` treats a 404 on a card edit as damage to repair
  (`settle`, missing branch): it drops the message ID and the next pass re-posts the card and
  re-opens a thread. Right for a live session (permission prompts need the thread), spam for a
  session that exited hours ago. The first-sight guard (`entryFor`, abandoned when first seen
  exited) is bypassed by both the 404 path and the restart path. Confirmed from `broker.log`
  2026-08-07: eight sessions 404 at 08:50Z after a broker restart, eight fresh cards in the channel
  at 4:50 AM local.
- Missing header: `outbound.reply` posts bare `inertReply(text)`; the mirror path prefixes every
  message via `renderMirror`'s `ATTRIBUTION`. Confirmed at `broker/routing/outbound.ts` reply
  branch.
- Echo: the harness injects a channel message into the session as a user prompt, so the installed
  `UserPromptSubmit` hook mirrors it back to the thread it came from. Observed live by the operator
  2026-08-07.
- Launch dialog: documented in `docs/install.md`, "The launch dialog" and "Packaging the relay as a
  plugin". The wrapper's `$script:ChannelFlagByHost` carries the development flag for every host.

## Sections of work

### S1: Exited surfaces stay deleted

Model: opus

Files: `broker/discord/surface.ts`, `broker/discord/surface.test.ts`.

In `open()`, a session whose derived state is `exited` never gains a new surface: the guard covers
both the deleted-card shape (`messageId === null`) and the deleted-thread shape (card survives,
thread gone), since `open()` is the only builder. This generalizes the existing first-sight guard:
an exited session never gains a *new* surface, while an existing surface still gets its final edit
and rename.

Two refinements over the first cut, both review findings:

- Abandonment (`entry.abandoned = true`, which is permanent) is reserved for lifecycle `ended`,
  which the registry never revives. The heartbeat backstop's `exited` is a presumption about a
  silent record that can still wake, so for it the guard declines to build, without abandoning,
  and a revived session rebuilds normally. `entryFor`'s first-sight guard holds the same line.
- When a card survives (thread-deleted shape), abandonment waits until the card carries its final
  exited render, the same wait `archive()` holds for the title, so a rate-limited final edit
  cannot freeze a dead session's card saying "working".

The abandonment is logged; the first-sight guard stays silent (nothing existed to explain).

Acceptance:

- A session whose card edit returns 404 (missing) while the session renders `exited` is not
  re-posted on later ticks; the entry is abandoned.
- A session whose thread rename returns 404 while it renders `exited` does not get a fresh thread
  opened on the surviving card.
- A session whose card is deleted while it renders `working`, `needs you`, or `idle` still rebuilds
  its card and thread (existing behavior, pinned by a test).
- A binding restored at startup whose message is gone (404) for a session rendering `exited` does
  not repost.
- A backstop-exited (stale, not ended) session's deleted surface is not rebuilt while it stays
  silent, and is rebuilt when the session revives.
- A dead session's surviving card is painted exited before its surface is given up on.
- The first-sight guard in `entryFor` keeps its behavior for ended records.
- Full suite green against the recorded baseline.

### S2: The reply tool's messages carry their own attribution

Model: opus

Files: `broker/discord/render.ts`, `broker/routing/outbound.ts`, and their tests.

The reply-tool path gets the same attribution-plus-splitting treatment the mirror has, with a
header that tells the two apart at a glance. New renderer entry point `renderAnswer` reuses the
same `split`/`withoutChips` machinery `renderMirror` uses (shared private `attributed` tail), with
its own attribution constant beside `ATTRIBUTION` in `render.ts`. `inertReply` was orphaned by
this and removed. `outbound.reply` posts the resulting messages in order as one task on the
thread's chain, exactly as `mirror` does, through a shared `deliver` helper.

Answers spend the conversation-tier `mirrorWriter`, not the alert-tier writer the first draft of
this section named: an answer can run many messages, and a rate-limit block earned by one long
answer must not be the block that drops a permission prompt. That left the router with no use for
the alert writer at all, so `OutboundRouterOptions.writer` was removed; alert paths (permission
desk, notices) hold their own writer and never pass through the router.

Chosen header: `📣 Claude · answer` (operator asked for a differentiated header, suggested
"Answer"; the glyph and the word both differ from the mirror's `✨ Claude`). It is a named constant
in `render.ts`; swapping the wording is a one-line change.

Acceptance:

- A reply-tool message posts with the header on it; a long reply splits into ordered messages, each
  carrying the header, none exceeding Discord's ceiling (reuses the mirror's split, which already
  holds this).
- The attribution trust model is unchanged: the operator-attributed `>>>` quote block remains the
  one unforgeable marker (the escape strips what draws it), and the answer header, like the
  mirror's `✨ Claude` header, is Claude-voice text that content in an already-Claude-voice message
  can reproduce without claiming any authority it lacks. (An earlier draft of this criterion asked
  for an unforgeable plain-text header, which no unquoted header can satisfy; reworded to the real
  property, with the security review's concurrence.)
- An empty or invisible-only reply is reported to the relay as an error rather than posted.
- Existing truncation behavior is replaced by splitting; no reply is silently cut.
- A partial delivery reports how far it got in the error the relay returns to the model, so a
  retry is an informed choice rather than a duplicate-post hazard.
- Full suite green against the recorded baseline.

### S3: A channel message does not mirror back as a console prompt

Model: opus (same dispatch as S2; both touch `outbound.ts`, and two agents must not share a file)

Files: `broker/routing/outbound.ts`, `broker/routing/outbound.test.ts`.

In `outbound.mirror`, a `prompt` whose text opens with the harness's channel envelope (prefix
`<channel source=`, matched after stripping the invisible class by the same rule the renderer
strips it, so a zero-width character cannot hide the envelope from the prefix test) is dropped
before rendering, with a line through the existing rate-limited drop log naming the session and
the cause. Reply-kind mirrors are not filtered: a reply is Claude's own text, and content merely
containing the marker mid-text is not an envelope. The accepted cost, priced in the code comment:
a console prompt genuinely opening with the envelope text is absent from the mirror record, with
the drop logged.

Acceptance:

- A mirrored prompt opening with `<channel source=` is not posted; the drop log says why and never
  carries the text; an invisible character in front of the envelope does not defeat the filter.
- A normal console prompt still mirrors; a prompt quoting the marker mid-text still mirrors; a
  reply whose body contains the string is not filtered.
- Full suite green against the recorded baseline.

### S4: The repo installs as a plugin marketplace

Model: opus, briefed after the plugin-format research report lands (dispatched 2026-08-07,
claude-code-guide agent)

Goal: the repo is itself a marketplace hosting one plugin that provides the relay as a channel, so
a host names it in `allowedChannelPlugins` and launches with `--channels plugin:...` instead of
`--dangerously-load-development-channels`, removing the dialog and its keypress.

Scope (to be firmed by the research report; every claim in it gets verified against a real launch
before the wrapper's flag table changes):

- `.claude-plugin/` manifests making the repo a marketplace and a plugin; the plugin declares the
  relay MCP server via the plugin-root variable so the path survives the repo moving.
- The wrapper's `$script:ChannelFlagByHost` and channel-flag entry syntax updated for a
  plugin-provided channel, per host, only after the plugin route is verified live on SCOTT.
- The permission-rule name the reply tool registers under is re-derived: the current
  `mcp__channel-relay__reply` allow rule in `hooks/settings-fragment.json` and its pin in
  `relay/reply-permission.test.ts` must match whatever key a plugin-provided server registers
  under, or approvals silently break. This is the known trap in this section.
- `docs/install.md` launch-dialog and packaging sections rewritten to the new state; managed
  settings (`allowedChannelPlugins`, total-replacement caveat) documented as the per-host step.
- The startup-banner channel check remains the operator's verification on each host after the flag
  flips.

Acceptance: a real launch on SCOTT through the wrapper with the plugin route shows the channel
registered in the startup banner, no warning dialog, reply tool functioning end to end (post and
permission prompt), and the suite green. Until that launch passes, the flag table keeps the
development flag.

### S5: Interim-visibility spec (deliverable is a spec, not code)

Model: fable (main session authors it)

Write `docs/plans/interim-mirroring_spec_v1.md`, Status: Draft, covering:

- Mirroring mid-turn assistant text on long turns by tailing the session's transcript file
  (`transcript_path` arrives on every hook payload; the file is local JSONL), with offset tracking
  and dedup against the Stop hook's final-message mirror.
- Richer current-activity display: the card's "Last tool" line carrying a bounded, neutralized
  input preview (e.g. the Bash command line) rather than the bare tool name.
- The security posture for both (untrusted text, existing render escapes, no transcript content in
  logs), budget/rate considerations, and what deliberately does not ship (no queueing, no
  replaying).

The spec is reviewed in-session for shape, then parked for a future effort. It is not implemented
under this plan.

## Delivery

Broker restart at the end of the effort so S1-S3 take effect on the running host (the process
currently running predates this work). Restart is unelevated and safe: relays reconnect, state and
bindings persist on disk. Scheduled-task registration stays a separate backlog item (elevated,
operator's).

## Chapters

### Chapter 1 - 2026-08-07
Completed: S1: Exited surfaces stay deleted
Implemented By: implementer-opus, with the orchestrator (fable) folding in the review round's guard refinements
Metrics: 1 review round (adversarial + blind + security, all at fable); 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: The implementer's guard covered only the deleted-card shape; its own DONE_WITH_CONCERNS report flagged the deleted-thread gap, and the review round flagged two more, all fixed in the same round: the guard is hoisted to cover both shapes, abandonment is held to lifecycle `ended` because the heartbeat backstop's `exited` is a presumption a hook can still wake (the blind reviewer's strongest finding: abandoning on it would permanently kill a revived session's surface and routing, and "stale, never ended" is exactly what a broker restart produces), and a surviving card is painted exited before its surface is let go (the archive() wait, so a rate-limited final edit cannot freeze a card at "working"). Abandonment now logs one line; the silent first-sight guard stays silent.
Review Findings: Blind CHANGES_REQUIRED (backstop-revival Major, paint-wait Major) and adversarial paint-wait Major all fixed as above; security's revival Minor resolved by the same fix; no Majors left unfixed.
Stamps: adjudicated 4, stamped 4 (escaping-untrusted-text-for-discord, two-components-agreeing-is-not-two-checks, claude-code-channel-and-hook-facts, typescript-runs-unbuilt-under-node-type-stripping)
Next: S2/S3 (delivered in the same round; Chapters 2-3 below)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-07
Completed: S2: The reply tool's messages carry their own attribution
Implemented By: implementer-opus, with the orchestrator (fable) resolving its NEEDS_CONTEXT and folding in review fixes
Metrics: 1 review round (shared with S1); 1 NEEDS_CONTEXT (out-of-scope wire pins, answered by the orchestrator taking them); 0 escalations; advisor off
Decisions / Surprises: Three calls decided here. (1) The three wire-test pins assert the header as a hard literal, not `renderAnswer(...)[0]`: a wire pin expressed through the renderer the code itself calls would pass even with a broken header, the writer-verifier-shared-assumption trap this project has been bitten by before. (2) Answers moved off the alert-tier writer onto the conversation-tier mirrorWriter (the implementer's own starvation concern), which orphaned `OutboundRouterOptions.writer` entirely; it was removed, and the outbound router is now conversation-only by construction. (3) The spec's unforgeable-header acceptance criterion was reworded rather than chased: no unquoted plain-text header can be unforgeable, the operator's `>>>` quote block remains the one unforgeable marker, and the security review independently classified header reproduction as claiming no authority the forging surface lacks. A partial delivery now also reports its landed count to the relay so the model does not blind-resend (blind reviewer's duplicate-post Major). The duplicated posting loop was extracted into one `deliver` helper (adversarial Minor). `inertReply` removed as an orphan; docs/security-model.md repointed.
Review Findings: dead-writer-option Major fixed by removal; duplicate-post Major fixed with counts-in-error; loop-duplication Minor fixed via `deliver`; header-forgeability Major resolved by criterion reword with security concurrence.
Stamps: covered in Chapter 1 (same boundary)
Next: S3 (same round)
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-07
Completed: S3: A channel message does not mirror back as a console prompt
Implemented By: implementer-opus (same dispatch as S2), orchestrator folded in one review fix
Metrics: 1 review round (shared); 0 NEEDS_CONTEXT beyond S2's; 0 escalations; advisor off
Decisions / Surprises: The envelope prefix now matches on invisible-stripped text (both non-security reviewers' Minor): a zero-width character in front of the envelope must not defeat a filter whose only job is cosmetic dedup, and the strip is the renderer's own rule so the two readings cannot drift. The accepted cost (a console prompt genuinely opening with the envelope text is absent from the mirror, logged) is priced in the code comment and the spec. Gate after the full round: 475 tests, 474 pass, 1 skipped, 0 fail, against the 453/452/1/0 baseline; lint clean; every new test in the round was watched fail first where an import-level failure did not make that meaningless (the S2 fail-first exception is recorded in the implementer report).
Review Findings: envelope invisible-strip Minor fixed; security review CLEAR overall (no exploitable finding, npm audit clean).
Stamps: covered in Chapter 1 (same boundary)
Next: S4 (plugin packaging; research report in hand), then S5 spec review, then finishing-work
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-07
Completed: S4: The repo installs as a plugin marketplace
Implemented By: implementer-opus (a first dispatch died on an API error before writing; the retry delivered), orchestrator folded in the review round's fixes
Metrics: 1 review round (adversarial + blind at fable, security at default); 0 NEEDS_CONTEXT; 1 infrastructure re-dispatch (not an escalation); advisor off
Decisions / Surprises: The plugin is a launcher shim, not a copy of the relay: marketplace installs run from a cache copy under the user profile (observed on this machine with claude-kit), where the relay's sibling imports and node_modules do not exist, so `plugins/relay/launch.mjs` reads the `relay-mcp.json` registration the wrapper already rewrites every launch and spawns the checkout's relay with inherited stdio. One approved out-of-brief edit: the installer's `$script:AllowedChannelPermissionRules` gained the plugin-scoped rule, because its own fragment validator would otherwise refuse to install the two-rule fragment. Review fixes folded in: a writer-to-reader cross-pin equating the shim's literals with the wrapper's (the adversarial Major, and this project's recurring writer-verifier defect shape); the shim's shutdown comment rewritten to name stdio EOF as the real Windows mechanism, with an exit-event belt added; the unreachable homedir fallback replaced by a loud refusal on unset LOCALAPPDATA; case-variant LOCALAPPDATA scrubbing in both new test harnesses so no test can reach the operator's real state root; `-cnotcontains` on the installer's rule gate; the prune checklist extended to all six rule sites plus the read-the-rule-off-the-prompt fallback for a third live name; and the security model taught the plugin route (execution chain and two-rule squat surface). Deliberately not built: per-launch registration files for the two-concurrent-checkouts race (both reviewers priced it Minor on a single-operator machine; the single-file assumption is now priced in a comment at New-ChannelMcpConfig, and per-launch files are the named fix if the assumption breaks). The permission-rule name `mcp__plugin_relay_channel-relay__reply` remains inferred: both rules ship until a live launch settles it. Docs (install.md rewrite, security-model update) were authored in the main thread per the docs guard.
Review Findings: adversarial Major (cross-pin) fixed; all Minors fixed except the launch race (justified above); security CONCERNS resolved by the model update, `-cnotcontains`, and the squat-surface paragraph; blind's third-candidate rule name handled via the checklist fallback rather than a third standing pre-approval, per the security review's argument against widening.
Stamps: adjudicated 0 surfaced (memq unstamped, 4h window); the four Chapter 1 stamps still cover this span's applied records
Next: operator verification of the plugin route on SCOTT (managed settings, install, live launch per docs/install.md), then the flag flip and rule prune ride a follow-up change; S5 below
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-07
Completed: S5: Interim-visibility spec
Implemented By: main session (fable), per the docs routing override
Metrics: 0 review rounds (a Draft spec parked for a future effort; the shape review was in-session); 0 NEEDS_CONTEXT; advisor off
Decisions / Surprises: The spec (docs/plans/interim-mirroring_spec_v1.md, Status: Draft) covers transcript tailing for mid-turn assistant text with Stop-hook dedup, a bounded neutralized tool-input preview on the card, the security posture (existing escapes only, no transcript content in logs, assistant-text-only extraction), and named non-goals. Open questions are recorded in the spec for the implementing session, including verifying the transcript JSONL schema as an external contract before parsing.
Review Findings: none (not implemented)
Stamps: none surfaced
Next: finishing-work, minus the S4 live-launch acceptance, which is the operator's
Commit Model: Commit-and-Push
