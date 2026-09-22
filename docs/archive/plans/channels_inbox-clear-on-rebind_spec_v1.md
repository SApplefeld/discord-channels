# Clear an Ended Session's Inbox Item When Its Thread Rebinds

Status: Complete
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

- [`channels_thread-rebinding_spec_v1.md`](channels_thread-rebinding_spec_v1.md)
  built the lineage takeover that fires `onRebind`. Its item 6 hardening pass was never merged and
  the plan is shelved. This plan adds one caller-side act to the rebind and changes nothing in the
  takeover itself.
- [`channels_operator-inbox_spec_v1.md`](channels_operator-inbox_spec_v1.md)
  built the inbox store and its two clearing events. This plan adds the third.
- [`channels_judge-unmirrored-replies_spec_v1.md`](channels_judge-unmirrored-replies_spec_v1.md)
  edited the inbox tap in `broker/index.ts` and removed the `mirrored` signal from `inboxWiring`
  and from the tests that call it; it is merged. The card-steward-asks plan edits the same tap and
  is open as pull request #21. Both touch a different region of that file from this plan, and this
  plan's tests open items with an `ASK:` line rather than through the judge, so whichever merges
  second takes a textual merge and nothing more.

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

### 2. The store's clearEnded contract names the rebind
Model: sonnet
Locus: inline

`clearEnded`'s doc comment in `broker/inbox/store.ts` defines its instant as "the instant the
operator posted in the ended session's thread", which section 1's rebind handler, a second caller
passing the rebind's instant, makes incomplete. The comment names both callers' instants and keeps
its account of why the instant is recorded. No code changes.
Acceptance: the comment names the operator's post in the ended thread and the thread's rebind to a
successor as the two instants a caller passes; `npm run lint` exits 0; the targeted lane of section 1
exits 0.
Files in scope: `broker/inbox/store.ts`.

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

### Chapter 1 - 2026-09-22
Completed: 1. The rebind handler clears the departed session's item
Implemented By: implementer-sonnet (build and tests); main session (the three document passages, placed from the implementer's drafts, and the Minor close pass)
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 1 open | changes: extracts the broker's onRebind closure into an exported `rebindHandling` factory that clears the departed session's inbox item (guarded) before posting the restart notice | serves: the Goal sentence "the broker's rebind handler clears the departed session's item before it posts the restart notice, a failure in that clear cannot stop the notice or the rebind" | adds a mechanism: no new unit beyond what the Goal names; the guard is the Goal's own "a failure in that clear cannot stop the notice" | size: about 20 source lines in broker/index.ts plus 6 tests and 3 doc passages | not building it costs: a persona restart leaves the ended session's ask on the Fleet: Inbox card for 24 hours with nothing the operator can do to clear it.
  Then: the Status header read `Ready` and now reads `In Progress`, set at run start. The `## Related plans` entry for the judge-unmirrored-replies plan said it was open on its own branch; it is merged and archived, so the entry now links the archive copy and names the card-steward-asks plan (pull request #21) as the other open edit to the same tap. Both are edits above `## Chapters`, made deliberately. The factory takes the inbox handle by value at build time: `inbox` is assigned once, at `broker/index.ts:923`, before the surface is built, and never reassigned (confirmed by the implementer and by both reviewers). The late-verdict test presents the late flag through the tap with the reply's original `postedAt` rather than through the judge; the spec's own procedure ("presents a flag for A") allows it, since the store's `postedAt` comparison is the same for a judged flag, and the test is titled for what it drives. A failed clear logs at error level through `console.error` and `logger.error`, as the inbox's other failures do, rather than through `note` at info. The review surfaced `clearEnded`'s doc in `broker/inbox/store.ts`, which named only the operator's post as the instant a caller passes; that file sits outside this section's directory, so it failed the fold predicate and was appended as section 2 (approval drift, surfaced by this section's review).
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: code pair at opus, Workflow (adversarial high, blind high)`. Adversarial CHANGES_REQUIRED, 1 Critical and 6 Minors; blind APPROVED_WITH_CONCERNS, 3 Minors, one of them the adversarial's test-title Minor. The adversarial Critical (the two documents absent from the reviewed commit range) was downgraded at adjudication: the section routes its `docs/` writes to the main thread, which placed them in the worktree after the first-green commit while the round ran, and the adversarial lens read those edits and found one Minor in them; they commit with this Chapter. Minors: 7 fixed in the close pass (the late-flag test's title and comments, its inverted "exists to hide" comment, the no-item test now over the real inbox rather than a double that cannot throw, the `rebindHandling` doc's change-narrative, the architecture document's "that message" antecedent and its reflowed line, the failed-clear log level), 0 upgraded, 2 left with the reason (the throwing-clear test's withheld-error assertion pins `toInbox`'s documented "never the error" shape, which the spec asks this guard to mirror; the blind lens's note that a takeover does not check the predecessor has ended, so a live predecessor's item would be cleared: the Intent defines this clear as happening "at the moment its thread passes to the successor", and the plan changes nothing in the takeover itself, whose own guard is the shelved thread-rebinding plan's item 6 territory), 1 routed to section 2 (the store's `clearEnded` doc). The close pass's delta took the author re-read: test and logging edits, no outward action or new module, owing no round.
Stamps: adjudicated 0, stamped 0; `memq recall` surfaced nothing bearing on this section, and no memory was read in the stretch.
Gate: targeted lane `node --test broker/index.test.ts broker/inbox/store.test.ts broker/discord/surface.test.ts` at section close, 2026-09-22 ~19:47 UTC on SCOTT-CLAUDE against `fddd1ae` plus the close pass, the three documents and section 2's comment, unstaged: 148 tests, 148 pass, 0 fail, exit code 0. Baseline on the same lane at `3e4ad41` before the change: 142/142/0, exit 0; delta +6 tests, no regressions. First green at `fddd1ae`: 148/148/0, exit 0. Red first: with the factory absent (`git show HEAD:broker/index.ts` swapped in), `node --test broker/index.test.ts` failed to load the file on the missing `rebindHandling` export (1 test, 0 pass, 1 fail); the late-flag test's absence control went red at "the rebind cleared it" with the clear commented out (implementer's runs, restored by byte-diff against a `.kit/` copy). `npm run lint` exit code 0. Test delta: 6 added in `broker/index.test.ts`: the handle-present rebind drops the predecessor's item and keeps the successor's; the null handle posts and touches nothing; a predecessor with no item changes nothing and throws nothing, over the real inbox; a throwing `clearEnded` still posts the notice with one log line naming the session; a null thread ID still clears and posts nothing; a late flag with the reply's original instant opens no item after the rebind. 0 retired, 0 edited. 0 added tests spawn a process. No contention lane is defined in this repository; foreign `node` processes on the box were service processes, no test runner.
Next: 2. The store's clearEnded contract names the rebind
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 ~19:47 UTC on SCOTT-CLAUDE against the worktree at `fddd1ae` carrying the close pass.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-22
Completed: 2. The store's clearEnded contract names the rebind
Implemented By: main session (Locus: inline, tier sonnet)
Metrics: review rounds 0, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Decisions / Surprises: section 2 open | changes: rewrites `clearEnded`'s doc comment in `broker/inbox/store.ts` to name both instants a caller passes | serves: the Goal sentence "the broker's rebind handler clears the departed session's item" through the call the store documents | adds a mechanism: no; prose only | size: one doc comment, 4 lines to 5 | not building it costs: the store's contract tells the next reader the instant is always the operator's post, which the rebind caller contradicts.
  Then: appended mid-run from section 1's review (approval drift, recorded in Chapter 1). A trivial comment-only section, so per-section reviews were skipped as the section loop allows; the finishing pass covers it.
Assumptions: none.
Review Findings: none; trivial comment-only section, reviews skipped, finishing covers it.
Stamps: none surfaced.
Gate: the same targeted lane run as Chapter 1's close, which carried this comment: 148/148/0, exit code 0; `npm run lint` exit code 0. Test delta: 0 added, 0 retired, 0 edited.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: reading taken 2026-09-22 ~19:47 UTC on SCOTT-CLAUDE against the worktree at `fddd1ae` carrying both sections' edits.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 3 - 2026-09-22
Completed: finishing pass (QA, folded finishing review, goal read, Minor pass, documentation curation, close and archive)
Implemented By: main session (the Minor pass, the drift adjudication and its one correction, the close); qa-verifier, adversarial-reviewer, scope-adjudicator and docs-curator dispatched
Metrics: review rounds 1, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT count 0; escalations 0; consults 0
Recap: Goal, verbatim: "When a supervised session restarts and its Discord thread passes to the successor session, the `Fleet: Inbox` card drops the item the ended session held. Today that item stays on the card for as long as the registry retains the ended record, 24 hours by default, because the two events that clear an item both key on the session the thread now resolves to. A post in the thread reaches the successor and clears only the successor's item. The ended session's item has no thread of its own left to post in, so nothing the operator does clears it. When this is done the rebind itself is a third clearing event: the broker's rebind handler clears the departed session's item before it posts the restart notice, a failure in that clear cannot stop the notice or the rebind, a judge verdict for the departed session that returns after the rebind opens nothing, and the architecture document names the rebind among the events that clear an ended item."; What the tree does now: when a persona restarts and the broker hands its Discord thread to the new session, the broker first removes the old session's line from the operator's inbox card and then posts the restart notice in the thread, and if the removal fails it logs one error line and posts the notice anyway; the removal also stamps the old session as answered at that instant, so a late verdict from the reply judge about the old session's last reply cannot put the line back; the architecture, operations and security documents describe this; Refinements during the run: section 2 appended from section 1's review to correct the store's `clearEnded` doc comment (approval drift, Chapter 1); the goal read declared the failed-clear log line as built-but-unasked and accepted it; the curator's drift D1 and D2 recorded as deviations (the clear ignores the old session's registry state, and a lineage takeover can now remove another session's ask); Operator-pending: confirm the next persona restart leaves no item for the ended session on the `Fleet: Inbox` card.
Decisions / Surprises: finishing opens | base ref `3e4ad41` (merge-base of `inbox-clear-on-rebind` with `origin/main`); the changeset listing matched the union of both sections' `Files in scope:` plus the plan doc, so the ref checked out. Folded review: the per-section round ran at opus, below Fable, so it cleared nothing and the finishing pass read both sections whole; the effort is about 20 source lines, so the performance and security lenses folded into one adversarial dispatch, each printing under its own label. Drift, both `deviation`: D1, the rebind clear keys on the departed session whatever its registry state, since neither the takeover in `entryFor` (`broker/discord/surface.ts:511-526`, checked here: lineage, message, abandonment and start order only) nor `rebindHandling` reads it, so a live or stale predecessor also loses its item; the architecture and operations documents now say so. This is the blind lens's Chapter 1 Minor, left then on the Intent's "at the moment its thread passes" and now documented as built. D2, `docs/security-model.md`'s lineage-takeover accepted risk now says a takeover also removes the incumbent's inbox item; the curator's sentence called that "the same reach" as the operator-prompt stamp, which the inbox bullet it cites bounds to the claimant's own session, so it was corrected to say the reach is one session wider and smaller than the thread and steering the takeover already hands over. Library hygiene: H2 (stale index rows) settled by this close; H1 (the card-steward plan's Related section does not name this plan) left, since that plan is archived by pull request #21 and an edit to its copy here would only manufacture a merge conflict.
Assumptions: none beyond the plan's own `## Assumptions` section.
Review Findings: `review: finishing adversarial at fable/high, Workflow, performance and security folded` resolved `claude-fable-5-1` 39 of 39 turns. APPROVED_WITH_CONCERNS, 0 Critical, 0 Major, 5 Minors; advisory 0 performance, 0 security (threat model read from `docs/security-model.md`'s trust-boundary and untrusted-strings sections; the error-level line's session id passes the intake's `clean` and already appears in other log lines). Minors: 3 fixed (the architecture paragraph's 124-column line reflowed; the `rebindHandling` doc comment's semicolon parenthetical split into sentences; Chapter 1's red-first evidence is stated here: its first red was a module-load failure on the missing `rebindHandling` export, which reddens the whole file, and the assertion-level red that earns the late-flag test is the absence control on the same Gate line), 2 left with the reason (`void options.post(...)` discards a rejection the transport's `CallOutcome` contract never produces, as the pre-change closure did; commit `8566275`'s `DOCS:` title under-describes its source and test edits, which its body names and the pull request body names too, and rewriting published history is not worth it). Goal read: `goal read: scope-adjudicator at fable, 1 built-but-unasked (0 refused, 1 declared, 0 asked), 0 asked-but-unbuilt`; the declared item is the one log line a failed clear emits, bounded inside the Goal's "a failure in that clear cannot stop the notice". Tree-state bracket: clean before and after QA, the review round and the goal read.
Stamps: none surfaced.
Gate: whole gate after the close edits (archive move, backlog item, index rows, Minor fixes, curator edits), 2026-09-22 20:05-20:06 UTC on SCOTT-CLAUDE against `8566275` plus those edits, uncommitted: `npm run lint` exit code 0; `npm test` 1995 tests, 1994 pass, 0 fail, 1 skipped, exit code 0, read from the run's own exit marker. Started only once no foreign `node --test` process was live, under the heavy-process claim. Baseline: the QA verifier's two runs at `8566275`, 1995/1994/0/1, exit 0 both; delta 0, no regressions. No contention lane is defined in this repository. Test delta this pass: 0 added, 0 retired, 0 edited.
Next: none; the plan is complete.
Commit Model: Branch-and-PR
