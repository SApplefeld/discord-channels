# Show Steward Asks on the Inbox Card

Status: Draft (for the Architect seat to review, finalize and set Ready)
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

A persona's ask that is addressed to its own supervisor still appears on the `Fleet: Inbox` card,
marked so the operator can see it went to the supervisor as well. Today the broker leaves such an
ask off the card entirely: a reply from a supervised session carrying a line of the form
`ASK: <question>? Recommend: <choice>` matches the steward-ask exclusion and opens nothing. The
reply still reaches the session's Discord thread, but the card is the roll-up that answers "who
is waiting on me" without opening every thread, so an ask missing from it is one the operator only
finds by visiting that thread. When this is done the card lists that ask with its text and a marker
saying it was addressed to the supervisor, and it clears the way every other item clears.

## Intent

**The frame, in the operator's words.** "Wait... you mean the session will ask something and it
will block it from reaching me? I am not sure how I feel about that. I think I would want to at
least see those messages, but maybe have something appended to them noting that the Supervisor
was informed?" After the correction that the message does reach the thread and only the card
entry is missing: "Ship what you have now, add that paragraph, and then write the shell of the
plan with your recommendations and pass it to the architect to be reviewed, finalized, and
dispatched out for execution."

**What done needs to do.** Open a card item for a supervised session's steward-shaped reply,
carrying the ask's text, drawn with a marker that distinguishes it from an ask addressed to the
operator. Keep such a reply away from the judge, since it is already marked and a vendor call
would add nothing. Clear the item on the same events that clear any other item.

**What done does not need to do.** It does not need to change the persona plugin's matcher or
what the steward does with the ask. It does not need to change the judge. It does not need to
change how an ask addressed to the operator opens, draws or clears.

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session at the close of
`archive/plans/channels_judge-unmirrored-replies_spec_v1.md`, whose finishing review found the gap
and whose `## Intent` records the operator's ruling to ship with it and plan this separately. The
Architect seat owns the final form.

## Approach

**The exclusion becomes a source, not a return.** `inboxWiring.reply` in `broker/index.ts`
currently returns at the line `if (record.lineage !== null && hasStewardAsk(text)) return;`, before
the mark read and the judge. The recommended change keeps the test and replaces the return with a
flag on a third item source, `steward`, beside `marked` and `judged` in `InboxSource`
(`broker/inbox/store.ts:67`). The excerpt is read from the steward line the same way `findAsk`
reads a marked one. A steward item is never submitted to the judge.

**The card names what the broker knows, not what it assumes.** The operator asked for a note that
the supervisor was informed. The broker does not observe the supervisor receiving anything. It
observes a line shaped as a worker's question to its steward, from a session whose record carries a
lineage. Whether the persona plugin reads a reply-tool answer at all, rather than only a worker's
turn-final answer, is a claim about a plugin outside this repository that this draft has not
verified. So the recommended marker says the ask was addressed to the supervisor, for example
`(to supervisor)`, rather than claiming the supervisor was told. Open question 1 asks the
Architect seat to settle this against the persona plugin's own source.

**Clearing is unchanged unless the supervisor's answer is a prompt the broker sees.** An item
clears when the operator's Discord message is delivered to the session
(`broker/routing/inbound.ts:333`) or when a console prompt reaches it (`broker/index.ts:881`). A
supervisor answering its worker may or may not arrive through either path. If it does not, a
steward item lingers until the operator prompts that session or it ends. Open question 2 asks
whether that is acceptable or whether a supervisor's answer should clear it.

**What still speaks the old contract.** A persisted inbox snapshot written by the new broker and
read by an older one refuses an item whose source it does not know (`broker/inbox/store.ts:283`),
so a rollback drops steward items rather than failing. The documents that state the exclusion
(`docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`) say such a reply opens
nothing, and those sentences change with the code.

## Dispatch Authorization

None yet. The Architect seat finalizes this draft, sets it Ready, and schedules it through the
coordinator for the discord-channels worker, which is where the grant is written.

## Sections of Work

### 1. A steward-shaped reply opens a steward item
Model: opus
Replace the early return at the steward test in `inboxWiring.reply` with a flag on a new
`steward` source carrying the ask's excerpt and the message ID where one is known. Add `steward`
to `InboxSource`, the flag union, the store's merge rules and the snapshot load. A steward item is
never judged. A later operator-addressed `ASK:` on the same session upgrades the item to `marked`,
the same way a marked flag upgrades a judged one today.
Acceptance: a supervised session's reply `ASK: merge now? Recommend: yes` opens one item with
source `steward` and the excerpt `findAsk` returns for that same line, and makes no judge call; the same reply
from a session with no lineage still opens a `marked` item; an unmarked reply from a supervised
session is still judged; a snapshot holding a steward item round-trips; `npm run lint` exits 0.
Files in scope: `broker/index.ts`, `broker/inbox/store.ts`, `broker/inbox/ask.ts`,
`broker/index.test.ts`, `broker/inbox/store.test.ts`, `broker/inbox/ask.test.ts`.

### 2. The card draws a steward item with its marker
Model: sonnet
`broker/inbox/card.ts` draws a steward item with the mark glyph, its excerpt on the sub-bullet,
and the marker open question 1 settles, placed after the age. Nothing else about the line
changes.
Acceptance: a card test draws one item of each source and pins the marker on the steward item
alone; the marker text passes the card's existing escape.
Files in scope: `broker/inbox/card.ts`, `broker/inbox/card.test.ts`.

### 3. Documents
Model: opus
Locus: inline
`docs/architecture.md`, `docs/operations.md` and `docs/security-model.md` state that a supervised
session's steward-shaped reply opens a steward item on the card and is never judged, and say
what clears it.
Acceptance: each passage stating that such a reply opens nothing is opened and rewritten.
Files in scope: `docs/architecture.md`, `docs/operations.md`, `docs/security-model.md`.
Audience: the operator, expert in this system; a future session with no context, engineer level.
Voice: company. Fact base: the as-built modules of sections 1 and 2.

## Out of Scope

- The persona plugin's matcher and what the steward does with an ask.
- The judge's questions, threshold, screen, cut, host or model.
- How an ask addressed to the operator opens, draws or clears.

## Assumptions

- assumed 2026-09-22 (default): a steward item is never sent to the judge, since it is already
  marked; reversal: one condition at the tap.
- assumed 2026-09-22 (default): a later operator-addressed `ASK:` upgrades a steward item to
  `marked`; reversal: one branch in the store's merge.

## Operator Verification

- After the broker is updated, a persona ask of its supervisor with a recommendation on one line
  appears on the `Fleet: Inbox` card with the marker within one refresh interval. Its absence
  reopens section 1.

## Open Questions

1. What does the marker say? Recommended: `(to supervisor)`, which states what the broker
   observes. "Supervisor informed" is true only if the persona plugin reads reply-tool answers,
   and this draft has not checked that against the plugin's source.
2. Should a supervisor's answer clear the item? Recommended: no change for this plan. The item
   clears on the operator's own prompt as every item does. Revisit if steward items linger in
   practice.
3. Should steward items sort or count differently from operator asks? Recommended: no, they draw
   in the same oldest-first order.

## Related plans

- Builds on `archive/plans/channels_judge-unmirrored-replies_spec_v1.md`, whose `## Intent` ruling
  records the gap this plan closes, and on `archive/plans/channels_operator-inbox_spec_v1.md`,
  which introduced the steward-ask exclusion.

## Chapters
