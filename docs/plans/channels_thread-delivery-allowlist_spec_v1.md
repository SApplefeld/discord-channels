# Deliver Only the Operator's Own Message Types From a Thread

Status: Draft (for the Architect seat to review, finalize and set Ready)
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

A message posted in one of this host's session threads reaches the session only when Discord types
it as something a person wrote: an ordinary message or a reply. Today the broker's gateway delivers
every message type in a thread except the rename notice, so any other system message Discord posts
into a thread reaches the sender gate and, past it, the session's inbound route. Nothing carries
composed text that way today, and the router's empty-text guard stops most of what could. A future
Discord system type that does carry text would reach a session as though the operator typed it.
When this is done the thread branch delivers `Default` and `Reply` and drops every other type, and
the tests pin both directions.

## Intent

**The frame.** This plan originates from the DEV-DISCORD worker seat rather than from an operator
ask, under the operator's standing pattern relayed by the coordinator on 2026-09-22: when the
worker's queue is empty, it drafts plans from `docs/backlog.md` for the Architect seat to finalize.
The source is the backlog item "Allow-list what a thread delivers instead of deny-listing one
system type", parked 2026-08-17 from the title-states security review.

**What done needs to do.** Deliver an ordinary message and a reply in a host thread exactly as
today. Drop every other message type in a host thread. Keep the rename notice dropped. Pin both
directions: each allowed type delivers, and a representative spread of other types drops.

**What done does not need to do.** It does not change the parent channel's branch (the pin-notice
delete and the unexpected-type report). It does not change the sender gate or the router. It does
not read message content. It does not add reporting for dropped thread types unless the Architect
seat rules it wanted (open question 2).

**Provenance.** Drafted 2026-09-22 by the DEV-DISCORD session from the backlog item named above and
from the code at `origin/main` `0690eb4`, read that day. The Architect seat owns the final form.

## Approach

**What exists today.** `classifyMessage` in `broker/routing/gateway.ts:82-106` handles a thread at
lines 97-105: a thread outside this host's channel drops, a `ChannelNameChange` drops, and
everything else returns `"deliver"`. `broker/routing/gateway.test.ts:144-150`, "a pin notice in a
thread is delivered like any message, never deleted", pins the deliver-everything shape. The
router's `if (text === "") return;` at `broker/routing/inbound.ts:243` is the second stop the
backlog item names. No code in `broker/` names `MessageType.Reply` today, because the thread branch
never distinguishes types beyond the rename.

**The recommended change.** Replace the rename test with an allow-list: return `"deliver"` when the
type is `MessageType.Default` or `MessageType.Reply`, and `"drop"` otherwise. The rename's comment
keeps its reason (an application cannot delete it) as the account of why the path drops rather
than deletes. The pin-notice test flips to expect `"drop"`, and its comment states why.

**`Reply` is load-bearing.** A message the operator sends with Discord's "Reply" action is typed
`Reply`, not `Default`. Leaving it off the list would silently stop the operator's replies reaching
the session, the regression most likely to ship unnoticed, since the tests today build every
thread message as `Default`. So the tests must include a `Reply`-typed operator message that
delivers.

## Open questions for the Architect seat

1. **Is the list complete?** Recommend `Default` and `Reply` only. A forwarded message arrives as
   `Default` with a snapshot, and a slash command arrives as an interaction rather than a message,
   so neither needs a type of its own. Worth one read of discord.js's `MessageType` enum at the
   installed version to confirm nothing the operator can type in a thread uses another type.
2. **Should a dropped thread type be reported once, as the channel branch reports?** Recommend no:
   the channel branch reports because a silent drop there hides a cleaner that stopped working,
   and no such mechanism depends on a thread drop. Adding it is a mechanism no requirement names.
3. **Model tier.** Recommend sonnet, one section, `Locus: dispatch`: a two-line code change and
   four tests, with a clear sibling in the existing tests.

## Sections of Work

### 1. The thread branch delivers only an ordinary message or a reply
Model: sonnet

Tests: lock that a `Default` message and a `Reply` message from the operator in a host thread each
deliver; that a `ChannelPinnedMessage`, a `ThreadCreated` and one further system type in a host
thread each drop; that the rename notice still drops; and that a thread of another host's channel
still drops whatever its type. Watch the `Reply` test and the pin-notice flip go red before the
change.

Change `classifyMessage`'s thread branch in `broker/routing/gateway.ts` to the allow-list, and flip
the pin-notice test in `broker/routing/gateway.test.ts`. Update `docs/security-model.md`'s passage
at lines 506-510, which says dropping the rename notice "is also what keeps Discord-composed text
out of the inbound route": after the change the allow-list is what keeps it out, for every system
type. Check `docs/architecture.md` for a passage stating what a thread delivers and update it the
same way if one exists.

Acceptance:
- Every behaviour on the `Tests:` line has a test, and the `Reply` test and the flipped pin-notice
  test were observed red first.
- `npm run lint` exits 0.
- The targeted lane `node --test broker/routing/gateway.test.ts broker/routing/inbound.test.ts`
  exits 0, reported as a delta against a baseline taken on the same lane before the change.

Files in scope: `broker/routing/gateway.ts`, `broker/routing/gateway.test.ts`,
`docs/security-model.md`, `docs/architecture.md`.

## Out of Scope

- The parent channel's branch and its unexpected-type report.
- Reading or filtering on message content.
- Any change to the sender gate, the router or the permission verdict reader.

## Operator Verification

- After deploy, a plain message and a Discord "Reply" typed in a session's thread both still reach
  the session.

## Chapters
