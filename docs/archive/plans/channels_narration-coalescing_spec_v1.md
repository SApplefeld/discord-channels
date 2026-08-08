# Narration coalescing: mid-turn chunks edit-append into one message

Status: Complete
Commit Model: Commit-and-Push
Fable Spend: S3 implementer; the S2 and S3 reviewer pairs (one tier above their opus and fable writers); finishing reviews
Created: 2026-08-07

## Goal

During a long turn, the transcript tailer's narration chunks currently land in a session's thread
as one Discord message each, every one opening with its own `✨ Claude · working` attribution and
its own Discord author header. On a busy turn that is a wall of headers with a sentence between
each pair. When this plan is done, consecutive narration chunks append into the newest narration
message by editing it in place, so a working stretch reads as one growing block under a single
header, the way it reads at the console. A new message starts only when the running block is full,
or when anything else has landed in the thread since (the operator's own message, a permission
prompt, a notice, the turn's final reply), so the block never buries something newer than itself.

## Approach

The three ingredients already exist in adjacent code, and each section extends one of them rather
than building anything parallel.

**Freshness comes from the gateway, not from polling Discord.** The append is only correct while
the narration message is still the newest thing in its thread. Asking Discord before every edit
(a GET per chunk) would double the API spend of the system's highest-volume write path. Instead,
the broker already receives every message that lands in its threads over the gateway, including
its own posts coming back (`broker/routing/gateway.ts`, and `inbound.ts` documents that bot
messages are deliberately reported). The gateway event gains the message ID, and any message
arriving in a thread whose ID is not the remembered narration message clears that thread's
coalescing state. Message edits emit no message-create event, so an append never invalidates
itself. The router also clears the state synchronously whenever it posts non-interim content
itself, so the common interleavers do not even wait on the gateway echo. The accepted residue is
one narrow race: a message landing milliseconds before an edit can end up below text appended
above it, a one-chunk cosmetic ordering blip bounded by gateway latency, against a poll interval
measured in seconds.

**The append decision is made inside the per-thread ordering chain.** The router already
serializes every conversation write per thread (`inOrder` in `routing/outbound.ts`). The check
"is coalescing state still held, and does the merged content fit" runs inside the chained task,
at the moment the write is about to go on the wire, never at call time, so an invalidation that
arrives while an append is queued behind a reply run is honored.

**Appending is a render-layer question, answered by the render layer.** The narration message's
content is remembered verbatim as posted. A new chunk is neutralized by the same escaping and
fence machinery every mirrored string already goes through (`withoutChips`, `scanFences`; there
is deliberately one reading of fence structure in `render.ts` and this plan adds no second one),
and the merged candidate is the remembered content plus a blank line plus the neutralized body.
It is accepted only if it fits `MAX_MESSAGE_LENGTH` whole; otherwise the chunk posts fresh
through the existing split path and the fresh run's final message becomes the new remembered
tail. Both sides of the merge always hold every code fence closed: the splitter closes an
unterminated fence at every message end, and the append helper does the same to the body it
admits, so a merged message never holds a fence open over what follows.

**Failure falls back to what happens today.** An edit refused for any reason clears the state,
and the same call then posts the chunk as a fresh message, so delivery is never lost to the
optimization. A refused edit is never retried. Budget stays conversation-tier: edits go out
through the same `mirrorWriter`, in their own budget instance beside the post one, because a
message PATCH is a different Discord rate bucket from a create POST and one route's headers must
never clear or install the other's block.

**Only narration coalesces.** The turn's final reply (`✨ Claude`) and the reply tool's answers
are the turn's actual word and stay their own messages. Mirrored prompts are operator-attributed
quote blocks, and the attribution rule (a quoted block is the operator's text, an unquoted one is
Claude's) is a security property that one message must never mix. The `EchoMemory` dedup between
the tailer and the Stop mirror keeps comparing raw chunk text exactly as it does now: coalescing
changes how a chunk is delivered, never what is recorded about it. One already-true behavior is
worth naming: when the Stop mirror drops the final reply because the tailer already posted that
text as its last interim chunk, the turn's final word lives inside the coalesced block. That is
today's behavior with fewer headers around it.

Decided 2026-08-07, all with the operator: narration chunks only; Commit-and-Push; gateway-echo
freshness over per-edit GETs.

## Sections of Work

### 1. Transport and writer learn message identity and in-place edits

Model: sonnet

`ThreadMessenger.postToThread` returns `CallOutcome<{ messageId: string | null }>` instead of
`CallOutcome<null>`, the ID read off the response body with `readId` as `postCard` reads it. A
2xx whose body carries no readable ID stays `ok` with a null `messageId`, unlike `postCard`'s
failure: there the ID is what the next call is made against, here the message landed and the ID
only feeds the append optimization, so reporting the post failed would invite the caller to
resend text the operator can already see. A new `ThreadMessenger.editInThread({ threadId,
messageId, text })` PATCHes `/channels/{threadId}/messages/{messageId}` as a sibling of
`editCard`, carrying the same `allowed_mentions` empty-parse list and `SUPPRESS_EMBEDS`,
returning `CallOutcome<null>`. `createThreadWriter` gains `edit(threadId, messageId, text)`:
same `inertMessage` neutralization, same refusal of an empty message, same rule of not observing
a failed call's headers, but its own budget instance, because a message PATCH is a different
Discord rate bucket from a create POST and one route's headers must never clear or install the
other's block. `reply` surfaces the posted message ID to its caller; `notice` and `alert` keep
their boolean contracts. The unconfigured-messenger stub in `broker/index.ts` gains the matching
`editInThread` failure.

Files: `broker/discord/transport.ts`, `broker/discord/adapter.ts`, `broker/routing/writer.ts`,
`broker/index.ts`, `broker/discord/adapter.test.ts`, `broker/routing/writer.test.ts`.

Acceptance: `npm test` green; the adapter test proves the edit hits the message route with both
suppressions and that a posted message's ID is surfaced; the writer test proves the two verbs
hold separate budgets.

Tests: lock the edit budget in both directions (room in the bucket → the edit goes out; empty
bucket → the edit is refused without touching the messenger), because a budget bypass on the new
verb is the failure that writes forever. Lock the verb separation in both directions (a
rate-limited post does not block the next edit, a rate-limited edit does not block the next
post), because cross-route header folding is how a standing block gets cleared by the wrong
route's headroom. Lock that `postToThread` reports a 2xx with no readable ID as ok with a null
`messageId`, because a landed message reported as failed is the resend-and-duplicate path.

### 2. Renderer: the append fit

Model: opus

A new exported function in `broker/discord/render.ts`, `appendNarration(existing: string,
text: string): string | null`. It neutralizes `text` through the same machinery `renderMirror`
uses (invisible stripping, trim, `withoutChips`), closes any fence the body leaves open, and
returns `existing + "\n\n" + body` when the merged whole fits `MAX_MESSAGE_LENGTH`, else `null`.
A body that neutralizes to nothing returns `null`. No second fence scanner and no second escape:
the existing `scanFences`/`withoutChips`/`fenceAfter` are the only readings used, per the
one-model rule documented at `scanFences`.

Files: `broker/discord/render.ts`, `broker/discord/render.test.ts`.

Acceptance: `npm test` green.

Tests: lock both directions of the fit (a chunk that fits merges; one code point over returns
null), because a message over the ceiling is rejected by Discord and the chunk would vanish.
Lock that a chip and a line-leading quote marker in the appended chunk arrive escaped, and that
a chunk with an unterminated fence merges with that fence closed: the appended text is transcript
content, the same untrusted class as a mirrored reply, and the attribution-unforgeability rule
must hold for text that enters a message by edit exactly as it does for text that enters by post.

### 3. Router coalescing and freshness tracking

Model: fable

The outbound router (`broker/routing/outbound.ts`) holds per-thread coalescing state: the message
ID and exact content of the newest narration message, present only while that message is believed
newest. `interim` consults it inside the thread's ordering chain: state held and
`appendNarration` accepts → `writer.edit`, and on success the remembered content updates; no
state, no fit, or a failed edit → the existing fresh-post path runs in the same call, and a fresh
interim run remembers its final message's ID and content as the new state. The remembered content
is the exact string handed to the writer, and it updates only on a successful edit; a run whose
final post reported a null `messageId` remembers nothing, because there is no target to edit. A
failed edit clears the state first, so the fallback and every later chunk post fresh. `reply` and `mirror` clear the
thread's state whenever a run of theirs goes out through `deliver`, inside the chained task at the
moment the run hits the wire (conservative on purpose: clearing costs one header, stale state
costs narration appended above newer content; the echo-drop branch that posts nothing does not
clear).

Freshness holds against three windows the naive clear-on-message shape misses. A new router
method, `noteThreadMessage(threadId, messageId)`, clears the state only when the arriving ID is
strictly newer than the remembered message by snowflake ordering (an unparseable ID clears
conservatively), so the late echo of an older message, the remembered message's own echo
included, cannot clear state for a message that genuinely is the thread's newest. Every
invalidation, with or without an ID, bumps a per-thread invalidation clock; the interim task
snapshots the clock inside its chained task before posting fresh and refuses to remember the run
when the clock moved during the post's round trip, so a message that landed mid-post is never
buried by later appends. And the steering writer's notice and alert paths, which post outside
this router and would otherwise clear only by gateway echo, clear the thread's state directly on
a successful post through a router method that needs no ID, so a permission prompt ends the
narration block even while the gateway is disconnected. The state map and the clock map are
bounded the way the drop log is bounded, so a fleet of threads cannot grow them without limit.

`InboundMessage` gains `messageId`, read from `message.id` in
`broker/routing/gateway.ts`. The wiring in `broker/index.ts` calls
`outbound.noteThreadMessage` for every gateway message before handing it to `inbound.deliver`,
because `deliver` drops bot-authored messages first and the invalidation must see exactly those.
`EchoMemory` recording is untouched: the tailer and the Stop mirror keep recording raw chunk
text.

Files: `broker/routing/outbound.ts`, `broker/routing/inbound.ts`, `broker/routing/gateway.ts`,
`broker/index.ts`, `broker/routing/outbound.test.ts`.

Acceptance: `npm test` green.

Tests: lock the freshness gate in both directions (a foreign gateway message clears the state and
the next chunk posts fresh; the remembered message's own echo does not clear it), because the
inverted failure is narration silently burying an operator message, in the one channel approvals
are answered in. Lock the three freshness windows: an invalidation arriving during the fresh
post's round trip means the run is not remembered; a late echo of an older message does not
clear a genuinely-newest remembered message; a successful notice or alert clears the block with
no gateway involved. Lock the edit-failure fallback (the chunk still lands as a fresh post in the
same call), because the fail direction of this feature must be "more messages", never "lost
narration". Lock that a reply run clears the state, and that the append decision made inside the
chain honors an invalidation that arrived while the append was queued.

### 4. The docs carry the coalesced surface

Model: fable
Locus: inline

`docs/architecture.md`, `docs/operations.md`, and `docs/security-model.md` currently describe
interim narration as one message per chunk. Each is updated to state the coalescing behavior as
current fact: how a thread reads during a long turn, that a chunk appends by edit while the
narration message is newest, what breaks the block, and (security-model) that appended text goes
through the same neutralization as posted text and that the freshness signal is the gateway echo.
Inline because implementer subagents cannot write under `docs/` in this harness; fable because
the session model is what runs inline work here.

Files: `docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`.

Acceptance: no doc still claims one-message-per-chunk delivery; the security model names the new
write verb and its trust argument.

## Related

Extends the delivery half of
[`interim-mirroring_spec_v1.md`](interim-mirroring_spec_v1.md),
which built the transcript tailer and the chunk pipeline this plan changes the posting shape of.
The tailer, its gates, and the EchoMemory dedup are untouched here. The duplication question
this plan's Out of Scope deferred is completed by
[`channels_reply-dedup-and-repair_spec_v1.md`](channels_reply-dedup-and-repair_spec_v1.md),
whose repair script also grew out of the orphaned-broker incident this plan's close-out Chapter
records.

## Out of Scope

- Coalescing anything but interim narration: final replies, reply-tool answers, mirrored prompts,
  notices, alerts, and permission prompts all stay discrete messages.
- Listening to MESSAGE_UPDATE or any new gateway intent.
- Per-edit freshness reads (GET before PATCH), and any retry of a refused edit.
- Changing the tailer's chunking, polling cadence, or the EchoMemory dedup contract.

## Operator Verification

- Watch one long turn from the phone: narration accumulates in one message under a single
  `✨ Claude · working` header; typing a message into the thread breaks the block and the next
  chunk starts a fresh message below yours. Narration appearing above your message more than
  momentarily, or a chunk that never appears at all, reopens the work.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-08-07
Completed: 1. Transport and writer learn message identity and in-place edits
Implemented By: implementer-sonnet, plus a fix round on the same agent after review
Metrics: 2 review rounds (initial + prescriptive fix verification); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: Two spec claims were wrong on contact with the code and the spec was amended to match the fix, both flagged here. First, "same budget bucket as its posts" became per-verb budgets: a message PATCH is a different Discord rate bucket from a create POST, `budget.observe` clears a block on any headroom, and the budget holds no synthetic allowance (it is purely observed-header state), so a clean split is the faithful shape. Second, "the same no-id-in-body failure as postCard" became ok-with-null-messageId: rest.ts's readBody returns null on an unparseable 2xx, and a landed message reported as failed is the resend-and-duplicate path, worst on the permission prompt. The interface change mechanically forced stub-shape updates in six test files outside the declared scope (structural typing; no assertions changed); accepted. Security review's two latent minors are recorded as deliberate non-fixes: edit-target provenance stays at the router (the sole caller; ids flow only from postToThread responses, and the writer doc states the contract), and snowflake-shape validation at the transport is declined because every interpolated id originates from Discord's own responses or validated config, not from inbound content.
Review Findings: 1 Critical (no-id 2xx synthesized failure) fixed; 2 Major (cross-bucket header folding, budget test that pinned nothing) fixed; Minors fixed: stale one-bucket comment, stale ThreadMessenger doc block, unused callback parameter, duplicated body-preparation, verb-blind drop log. Minors noted without fix: editing an alert-posted message would drop its mention whitelist (no such edit path exists); writer-level edit re-neutralization overlaps the renderer's ceiling check (pinned by the cross-pin test).
Stamps: adjudicated 1, stamped 0 (claude-code-channel-and-hook-facts was opened by a subagent but covers hooks and registration, which this section never touched)
Next: 2. Renderer: the append fit (built in parallel, closed in Chapter 2)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-07
Completed: 2. Renderer: the append fit
Implemented By: implementer-opus, plus one main-session minor fix after review
Metrics: 1 review round; 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: Both reviewers approved without required changes; the implementer's out-of-tree red-first discipline (a scratchpad copy of the module, five defect injections, each failing exactly its intended test) is worth reusing on a shared live tree. The one adopted minor is a precondition guard added in the main session: appendNarration refuses an `existing` that is empty or not trimmed-and-invisible-free, since renderer output always is, so the check is identity for legitimate callers and fails closed for buggy ones. The implementer's cross-pin (inertMessage(merged) === merged at the exact ceiling) locks the writer/renderer contract Section 3 depends on. Noted without fix, both inside the documented scanFences divergence bound: a 4+-backtick fence closed by the bare three-backtick closer, and the untested chip-inside-fence case on the append path (structurally unable to diverge while the one-model rule holds).
Review Findings: 0 Critical, 0 Major; Minors: precondition guard fixed inline with a test; the two scanner-divergence notes recorded above; the reviewers' shared demand that Section 3 remember the exact posted string and update only on a successful edit was written into the spec's Section 3 text.
Stamps: covered by Chapter 1's adjudication (same boundary)
Next: 3. Router coalescing and freshness tracking
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-07
Completed: 3. Router coalescing and freshness tracking
Implemented By: implementer-fable, plus two fix rounds on the same agent (one orchestrator finding pre-review, one review round)
Metrics: 2 review rounds (initial three-reviewer round + prescriptive fix verification); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The orchestrator caught one defect before review: deliver cleared coalescing state at hand-off rather than inside its chained task, which both posted a needless header for a queued append that was still valid and left stale state when a reply landed behind a remembered fresh post; fixed with a watched-red test. The review round then converged on the same generator from three angles: freshness had a single source (the gateway echo) and no memory of what it had seen, so an invalidation processed during a fresh post's HTTP round trip was lost, and out-of-router posts (notices, permission alerts) could not clear at all during a gateway outage. The fix is the spec's amended three-window contract: snowflake-ordered clearing (only a strictly newer ID clears, so a split run's own late echoes cannot end its block), a per-thread invalidation clock consulted before remembering a fresh run, and endNarration, a no-ID clear wired in index.ts to successful notice and alert posts via a steeringWriter wrapper (writer.ts stays uncoupled from the router). Deliberate non-fixes, with reasons: LRU-ordering the eviction would require re-setting the map entry on append, which would resurrect state an invalidation just cleared, the exact bug the in-place mutation prevents; the tail.test first-chunk assertion is covered by adjacent tests. Accepted residues, both failing conservative (a needless header, never a burial): a run's own gateway echo beating its REST response costs that run its remembered state, and a clock entry evicted mid-round-trip under 64-plus-thread bump pressure can let a run remember anyway.
Review Findings: 1 converged Major (lost invalidation during the post round trip) fixed; 1 blind Major (echo-only clearing for out-of-router posts) fixed; Minors fixed: older-echo over-clearing (snowflake ordering), silent refused edit (drop-log line, error class only); Minors noted: insertion-order eviction (reasoned above), security reviewer rated the whole surface CLEAR with edit-target provenance and escaping parity confirmed.
Stamps: adjudicated 1, stamped 0 (claude-code-channel-and-hook-facts again, opened by a subagent; hooks and registration facts did not steer router logic)
Next: 4. The docs carry the coalesced surface
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-07
Completed: 4. The docs carry the coalesced surface
Implemented By: main session (docs/ writes are the main thread's; Locus: inline as planned)
Metrics: 0 review rounds (prose-only section; finishing-work's whole-changeset reviews cover it); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: architecture.md describes the coalescing behavior and all three freshness mechanisms in its mid-turn narration section; operations.md tells the operator how a thread reads (one growing message, the (edited) tag is normal, typing breaks the block) and adds the refused-append routing line to the runbook's discriminators; security-model.md replaces the retired "no second escape" claim with the two-entry-points-one-machinery argument, names the edit verb's suppressions and provenance rule (no gateway ID ever becomes an edit target), and states what an unauthorized member can do to coalescing (end a block early, one header, nothing else). Tree-wide claim sweep for the old one-message-per-chunk and no-second-escape claims: remaining hits are this plan, the append-only archive, and tailer comments that stay true.
Review Findings: none (see Metrics)
Stamps: adjudicated 0, none surfaced in the window
Next: finishing-work
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-07
Completed: finishing pass; the effort closes
Implemented By: main session orchestrating qa-verifier, security-reviewer, adversarial-reviewer (fable), docs-curator
Metrics: QA PASS on every criterion (585/584/0/1 against the 550/549/0/1 opening baseline, all +35 tests new); security CLEAR; final adversarial APPROVED with four wording minors, all fixed; advisor opus
Decisions / Surprises: The finishing reviews' minors were all precision defects in prose: the security model and the appendNarration comment attributed to a runtime guard what actually holds by provenance (the router is the sole caller and feeds back only renderer output), both reworded to state the real split; the runbook's quoted log line now matches the emission; this spec's Section 3 and Approach text were aligned with the as-built freshness contract (in-task clearing, per-verb budgets). Drift Report: three deviations, no mistakes. D1 (spec Approach still claimed a shared budget) fixed in this close-out; D2 (operator-checks and the index claimed five-of-five checks passed while the file holds six with F unrun, a pre-existing untrue claim) corrected to six-with-F-unrun under the honesty gate; D3 (the security model's escape-applier enumeration missed appendNarration and had a pre-existing kind undercount) fixed by the curator in place. The curator also pointed operator check F at the coalesced surface and left one open question that only a live run can close: whether editing the bot's own message needs any Discord permission beyond what install.md grants (recall says no; the first real append is the evidence). Deployed: SCOTT's broker restarted onto this code in-session; the task-stop left the old process holding port 8787 (EADDRINUSE on the fresh bind, the new instance correctly exited), killed by PID and restarted clean, gateway reconnected, both live relays reattached, /sessions 200.
Review Findings: finishing security 2 Minors (doc-precision wording, fixed; a contrived clock-eviction edge under a 64-thread bump storm inside one round trip, accepted, self-heals); final adversarial 4 Minors, all fixed. No Critical, no Major anywhere in the finishing round.
Stamps: adjudicated 1, stamped 0 (claude-code-channel-and-hook-facts, third consecutive skip on the same grounds); memory written: discord-edit-and-create-are-separate-rate-buckets (project tier)
Operator Verification pending: watch one long turn from the phone per operator check F; narration accumulates in one message under one header, your typed message breaks the block, and the next chunk posts fresh below it. Narration sitting above your message more than momentarily, a chunk that never appears, or a refused-append log line carrying a permissions error reopens this work. Carried in docs/backlog.md.
Next: none; archived
Commit Model: Commit-and-Push

