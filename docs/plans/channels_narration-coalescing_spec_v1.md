# Narration coalescing: mid-turn chunks edit-append into one message

Status: In Progress
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
optimization. A refused edit is never retried. Budget is neutral: an edit replaces a post
one-for-one against the same writer budget, spent through the same `mirrorWriter`.

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

`ThreadMessenger.postToThread` returns `CallOutcome<{ messageId: string }>` instead of
`CallOutcome<null>`, read off the response body exactly as `postCard` reads it (`readId`, and the
same no-id-in-body failure). A new `ThreadMessenger.editInThread({ threadId, messageId, text })`
PATCHes `/channels/{threadId}/messages/{messageId}` as a sibling of `editCard`, carrying the same
`allowed_mentions` empty-parse list and `SUPPRESS_EMBEDS`, returning `CallOutcome<null>`.
`createThreadWriter` gains `edit(threadId, messageId, text)`: same budget bucket as its posts,
same `inertMessage` neutralization, same refusal of an empty message, same rule of not observing
a failed call's headers. `reply` surfaces the posted message ID to its caller; `notice` and
`alert` keep their boolean contracts. The unconfigured-messenger stub in `broker/index.ts` gains
the matching `editInThread` failure.

Files: `broker/discord/transport.ts`, `broker/discord/adapter.ts`, `broker/routing/writer.ts`,
`broker/index.ts`, `broker/discord/adapter.test.ts`, `broker/routing/writer.test.ts`.

Acceptance: `npm test` green; the adapter test proves the edit hits the message route with both
suppressions and that a posted message's ID is surfaced; the writer test proves an edit spends
the shared budget.

Tests: lock the budget in both directions (room in the bucket → the edit goes out; empty bucket →
the edit is refused without touching the messenger), because a budget bypass on the new verb is
the failure that writes forever. Lock that `postToThread` reports the no-id body as a failure,
because S3 stores that ID as the append target.

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
interim run remembers its final message's ID and content as the new state. A failed edit clears
the state first, so the fallback and every later chunk post fresh. `reply` and `mirror` clear the
thread's state whenever they hand a run to `deliver` (conservative on purpose: clearing costs one
header, stale state costs narration appended above newer content; the echo-drop branch that posts
nothing does not clear). A new router method, `noteThreadMessage(threadId, messageId)`, clears
the state unless the ID matches the remembered message. The state map is bounded the way the
drop log is bounded, so a fleet of threads cannot grow it without limit.

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
are answered in. Lock the edit-failure fallback (the chunk still lands as a fresh post in the
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
[`../archive/plans/interim-mirroring_spec_v1.md`](../archive/plans/interim-mirroring_spec_v1.md),
which built the transcript tailer and the chunk pipeline this plan changes the posting shape of.
The tailer, its gates, and the EchoMemory dedup are untouched here.

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

