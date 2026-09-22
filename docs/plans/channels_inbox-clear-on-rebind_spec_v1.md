# Clear an Ended Session's Inbox Item When Its Thread Rebinds

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When a supervised session restarts and its Discord thread passes to the successor session, the
`Fleet: Inbox` card drops the item the ended session held. Today that item stays on the card for
as long as the registry retains the ended record, 24 hours by default, because the two events that
clear an item both key on the session the thread now resolves to. A post in the thread reaches the
successor and clears only the successor's item. The ended session's item has no thread of its own
left to post in, so nothing the operator does clears it. When this is done the rebind itself is a
third clearing event: the broker's rebind handler clears the departed session's item before it
posts the restart notice, a failure in that clear cannot stop the notice or the rebind, a judge
verdict for the departed session that returns after the rebind opens nothing, and the architecture
document names the rebind among the events that clear an ended item.

## Dispatch Authorization

The operator asked for this on 2026-09-22 on the ASSISTANT persona's Discord thread, in these
words as ASSISTANT relayed them through the coordinator: "Can you make a small plan to fix that bug
and pass it to the architect so that it can be dispatched out to the Discord worker?" The architect
holds that quote from the coordinator's record and not from the thread itself. The operator
declined a manual clear button in the same exchange, which ASSISTANT's brief records.

## Intent

**The frame, in the operator's words.** "Can you make a small plan to fix that bug and pass it to
the architect so that it can be dispatched out to the Discord worker?" The bug is the one
ASSISTANT's brief describes: a persona restart leaves the ended session's ask on the inbox card
with no way to clear it.

**What done needs to do.** Drop the departed session's inbox item at the moment its thread passes
to the successor. Leave the successor's own item, if it holds one, exactly as it was. Keep the
restart notice and the rebind itself safe from any failure in the clear. Keep a late judge
verdict for the departed session from reopening the item. State the new clearing event where the
architecture document states the other two.

**What done does not need to do.** It does not need to carry the departed session's ask over to
the successor, which never saw the ask and would receive a reply it has no context for. It does
not need a manual way to dismiss an item, which the operator declined. It does not need to change
when a live or stale session's item clears, how an item opens, or how the card draws. It does not
need to clear an item for a restart the surface never rebinds, and it does not need to change how
long the registry retains an ended record.

**Alternatives refused.**
- A reconcile rule dropping the item of any session that is neither live nor bound to a thread.
  Refused because a rebind can only happen inside the Discord surface's own tick, in `entryFor`
  (`broker/discord/surface.ts`), so there is no rebind the handler misses, and the rule would
  reach into the thread bindings from the inbox for a case that does not arise.
- Carrying the item over to the successor session. Refused for the reason above: the successor
  did not ask.
- A manual clear button on the card. Refused by the operator on 2026-09-22, as ASSISTANT's brief
  records. The inbox's reply-to-clear design is the standing reason: an ask is not dismissed
  without an answer.
- Clearing inside the store's `reconcile` on the registry's mutate signal. Refused because the
  registry still holds the ended record, so the store sees the session as retained, and the
  binding change is a surface fact the store does not read.

**Rulings.** None yet.

**Provenance.** Distilled by the architect on 2026-09-22 from ASSISTANT's brief
(`D:\personas\ASSISTANT\briefs\inbox-orphaned-item-on-rebind.md`, held outside this repository)
and from the code at `origin/main` `96b8100`, read that day.

## Related plans

- [`../archive/plans/channels_thread-rebinding_spec_v1.md`](../archive/plans/channels_thread-rebinding_spec_v1.md)
  built the lineage takeover that fires `onRebind`. Its item 6 hardening pass was never merged and
  the plan is shelved. This plan adds one caller-side act to the rebind and changes nothing in the
  takeover itself.
- [`../archive/plans/channels_operator-inbox_spec_v1.md`](../archive/plans/channels_operator-inbox_spec_v1.md)
  built the inbox store and its two clearing events. This plan adds the third.
- [`channels_judge-unmirrored-replies_spec_v1.md`](channels_judge-unmirrored-replies_spec_v1.md)
  edits the inbox tap in `broker/index.ts` and is open on its own branch. It also removes the
  `mirrored` signal from `inboxWiring` and from the tests that call it. The two plans touch
  different regions of that file, and this plan's tests open items with an `ASK:` line rather
  than through the judge, so neither depends on the mirror and whichever merges second takes a
  textual merge and nothing more.

## Approach

**What exists today.** Each point was read at `origin/main` `96b8100` on 2026-09-22. Find each
site by the function or text named rather than by line, since the open judge plan moves lines in
the same file.

- The surface fires `onRebind` from `entryFor` in `broker/discord/surface.ts`, once, when a newer
  session carrying a lineage registers with no entry of its own while an older entry answers to
  that lineage and has a real thread. The event carries `lineage`, `fromSessionId`, `toSessionId`
  and `threadId`, and `threadId` is null when the starter message exists but the thread is not yet
  open. The takeover runs nowhere else, so a rebind that happens after a broker outage still runs
  inside the first tick that sees both sessions, and fires the event then.
- `startBroker` in `broker/index.ts` passes an `onRebind` handler to `createDiscordSurface` that
  returns when `threadId` is null and otherwise posts `renderRestartNotice(event.lineage)` to the
  thread through `messenger.postToThread`. It sits beside the `bound`, `log` and `onFatal`
  handlers. Nothing tests it: `renderRestartNotice` is tested in `broker/discord/render.test.ts`
  and the surface's event is tested in `broker/discord/surface.test.ts`, but the closure that
  joins them is not.
- The inbox handle in `startBroker` is `inbox`, the return of `inboxWiring`, and it is null when
  `CHANNEL_INBOX_CARD` is off. The wiring already exposes `clearEnded(sessionId, at)`, which the
  inbound router calls when the operator posts into an ended session's thread
  (`broker/routing/inbound.ts`, the `record.state === "ended"` branch). The router wraps that call
  in `toInbox`, a local guard that catches a throw and logs one line naming the session, so a
  message already routed never reads as failed.
- The store's `clearEnded` in `broker/inbox/store.ts` records the instant as the session's latest
  prompt and deletes the item, ignoring the refresh-instant comparison that `clear` applies. The
  store's `flag` drops a flag whose `postedAt` is at or before that recorded prompt instant. So a
  judge verdict for the departed session that returns after `clearEnded` carries an earlier
  `postedAt` and opens nothing.
- `broker/index.ts` exposes its wiring as exported factories that take their collaborators as
  options (`inboxWiring`, `usageCardWiring`, `boardCardWiring`, `questionDelivery`), and
  `broker/index.test.ts` builds each with fakes. That is the sibling this plan's factory clones.
- `docs/architecture.md` states the two clearing events for an ended item in the paragraph
  opening "What clears an item", under "The operator inbox", and describes the rebind's restart
  notice in the paragraph opening "that does, the wrapper never does" under the lineage section.
  `docs/operations.md` tells the operator the same two events in its inbox passage, in the
  sentence opening "Post a plain message in that session's thread and the line leaves".

**The design.**

1. A new exported factory in `broker/index.ts`, `rebindHandling`, takes the inbox handle (nullable,
   with `clearEnded`), a function that posts the restart notice to a thread, a clock and a log
   function. It returns the `onRebind` handler. `startBroker` builds the handler through it and
   passes the result to `createDiscordSurface` where the closure sits today.
2. The handler clears first and posts second. It calls `inbox.clearEnded(event.fromSessionId,
   now())` when the inbox handle is not null, inside a guard that catches a throw and logs one line
   naming the session, on `toInbox`'s shape. Then, when `event.threadId` is not null, it posts the
   restart notice exactly as today. The clear does not wait on the thread ID, because the rebind
   happened whether or not the thread is open yet.
3. Nothing in the store, the surface, the router or the card changes.

## Sections of Work

### 1. The rebind handler clears the departed session's item
Model: sonnet

Tests: Lock that a rebind from A to B drops A's open item and leaves B's open item untouched, in
both directions of the guard: with the inbox handle present the item goes, and with the handle
null the handler posts the notice and touches nothing. Lock that a rebind whose predecessor holds
no item changes nothing and throws nothing. Lock that an inbox handle whose `clearEnded` throws
still results in the restart notice being posted, with one log line naming the departed session.
Lock that a rebind with a null thread ID still clears A's item and posts nothing. Lock that a judge
verdict for A submitted after the rebind opens no item, since a late verdict reopening a cleared
ask is the regression this clearing event would otherwise hide.

Add `rebindHandling` to `broker/index.ts` on the design above, and rewire `startBroker`'s
`onRebind` to it. Write the regression tests in `broker/index.test.ts` against the factory with a
fake inbox and a fake poster, and watch the first go red before the factory exists. The late-verdict
test builds the real wiring through the file's existing inbox harness, opens a marked item for A
through the tap with an `ASK:` line, drives a rebind event from A through the handler that
`rebindHandling` returns with the real inbox and a fake poster at a later instant, and then
presents a flag for A carrying the reply's original `postedAt`. Nothing opens. The item is opened
with a mark rather than through the judge, so the test does not need the mirror signal the open
judge plan removes.

Update `docs/operations.md` where its inbox passage tells the operator how an ended item leaves,
so the rebind is named beside the post and the prune, and the sentence no longer sends the
operator to a thread the ended session no longer has. Update `docs/architecture.md` in two places. The "What clears an item" paragraph names the rebind
as the third event that removes an ended record's item, beside the operator's post in the ended
thread and the registry's prune. The lineage paragraph that describes the restart notice says the
rebind also clears the departed session's inbox item, and that the clear is guarded so it cannot
stop the notice.

Acceptance:
- Every behaviour on the `Tests:` line has a test in `broker/index.test.ts`, and the first one was
  observed red before the factory was added.
- `startBroker` builds its `onRebind` handler through `rebindHandling` and passes nothing else
  for that option.
- `npm run lint` exits 0.
- The targeted lane `node --test broker/index.test.ts broker/inbox/store.test.ts
  broker/discord/surface.test.ts` exits 0, reported as a delta against a baseline taken on the
  same lane before the change.
- Both `docs/architecture.md` passages and the `docs/operations.md` passage state the rebind
  clear as described, with no change-narrative.

Files in scope: `broker/index.ts`, `broker/index.test.ts`, `docs/architecture.md`,
`docs/operations.md`.

## Out of Scope

- A manual clear button on the inbox card. The operator declined it on 2026-09-22.
- Card edit lag from the empty Discord rate bucket. That is a pacing matter of its own.
- Items orphaned before this ships. They leave through the 24-hour retention.
- A restart the surface never rebinds, which can happen when a restored binding has no lineage on
  the first tick after a broker restart. That is the shelved rebinding plan's item 6 territory. In
  that case the ended session keeps its thread, so the operator's post there still clears the item.
- Any change to the registry's ended-record retention or to the store's `reconcile`.

## Assumptions

- assumed 2026-09-22 (the repository's open plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-22 (the file's own pattern): the handler is extracted into an exported factory
  rather than tested through `startBroker`, because `startBroker` needs a Discord transport the
  test harness does not build, and the file's other wiring is tested this way; reversal: inline the
  guard into the closure and test only the store call, losing the notice-survives test.
- assumed 2026-09-22 (the brief's acceptance 3): the guard is written inline in the handler on
  `toInbox`'s shape rather than shared with `broker/routing/inbound.ts`, because the two sites hold
  different inbox handles and different log sinks; reversal: export `toInbox` from the router.
- assumed 2026-09-22 (the brainstorming skill): the spec has one section, so the
  blind read and the gating litmus are skipped as the brainstorming skill allows. The plan review
  ran at fable and effort high and returned READY_WITH_FINDINGS, one Major and three Minors, all
  applied.
- Evidence outside this repository is reported, not confirmed. The live instance in the brief
  (DEV-DISCORD session `edb1c801` holding an item after the 17:28Z restart, thread bound to
  `3780be4a`) was read by ASSISTANT from the running broker's state files. The architect did not
  read those files.

## Operator Verification

- Once this is on the running broker, the next persona restart should leave no item for the ended
  session on the `Fleet: Inbox` card. The current orphaned item for session `edb1c801` expires on
  its own and is not evidence either way.

## Chapters
