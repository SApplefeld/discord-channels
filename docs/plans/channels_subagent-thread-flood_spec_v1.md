# Stop the finishing-subagent thread flood

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-24

## Goal
A finishing subagent's full final report no longer floods the operator's thread. When a session dispatches a subagent (a blind read, a review, an Explore) and it finishes, the operator's thread shows at most a one-line notice under the default `brief` setting, the same treatment a wake prompt already gets on the prompt surface, rather than the subagent's entire report posted under the `📣 Claude · answer` attribution. The `full` and `off` settings keep their existing meanings. This covers the backlog item "A finishing subagent's full report floods the operator's thread (parked 2026-09-24)," which retires when this ships.

## Intent
The operator asked to stop the flood: several times a day a dispatched subagent's whole report lands on his thread and makes it hard to read. He confirmed on 2026-09-24 by pasting back a verbatim blind read framed `📣 Claude · answer` that no reply-tool call had sent.

What done needs: a finishing subagent's report is compressed to a one-line notice under `brief` (the default) and suppressed under `off`, on whatever surface it currently reaches the thread by, matching the treatment the prompt surface already applies at `broker/routing/outbound.ts:1215` and `:1581`.

What done does not need: any change to the `full` setting, which still mirrors the whole report by design; any change to an ordinary session turn's own reply, which is the operator's window into the session and stays; any change to the reply tool. The fix gates a subagent's report, not a session's own answer.

Alternatives refused: guessing the exact bypass path from static reading and gating there. Refused because the report arrives under the `answer` attribution, not the prompt attribution the two known gates cover, and the exact path could not be pinned by reading alone from outside the broker. The reproduce-first section exists for that reason.

Rulings after the spec ships: none yet.

Provenance: distilled from the operator's relay thread on 2026-09-24 and the ARCHITECT persona's read-only trace of the broker that day.

## Approach
The trace so far, all confirmed by reading the broker at `e6eeefa`:
- The `taskNotifications` setting (`broker/config.ts:80`, env `CHANNEL_TASK_NOTIFICATION`, default `brief` at `broker/config.ts:416`) already compresses a finishing subagent's wake prompt to a one-line notice on two prompt paths, the hook-carried mirror at `broker/routing/outbound.ts:1215` and the transcript-tailer prompt at `:1581`. Both gate on `isTaskNotification(text)` (`:355`), which is true only when the text, trimmed of invisibles, starts with `<task-notification`.
- The transcript tailer drops sidechain records (`broker/tail.ts:1694`), so a subagent's own transcript messages are excluded from the interim mirror.
- The `📣 Claude · answer` attribution (`broker/discord/render.ts:282`) is the answer surface, reached by the reply tool and by the Stop mirror of a turn's final reply, not by the prompt surface the two gates cover.
- No `SubagentStop` hook is declared (`broker/security/permission.ts:312`), so a subagent finishing does not reach the broker as its own Stop.

The tension the fix must resolve: the report reaches the thread on the answer surface, past both known guards, yet a subagent's finish does not fire a Stop of its own. The exact path is not pinned. Section 1 reproduces the flood and watches which broker call posts the report, so Section 2 gates the real path rather than a guessed one. The likely shapes to check first: a wake prompt whose text is prefixed (for example by a `[SYSTEM NOTIFICATION ...]` banner) so `isTaskNotification` returns false and it falls through; and a mirror of the parent's own turn that carries the injected report into an answer-attributed post.

## Sections of Work

### 1. Reproduce the flood and pin the exact bypass path
Model: opus
Locus: inline
Reproduce the flood against a live or test broker: dispatch a subagent from a session whose thread is bound, let it finish while the parent is idle, and capture which broker call posts the report and under which attribution. Instrument or trace the routing so the exact path is named: the file and function that posts the report to the thread, the `kind` it carries, and why both `isTaskNotification` gates (`broker/routing/outbound.ts:1215`, `:1581`) and the sidechain filter (`broker/tail.ts:1694`) do not catch it. Confirm whether the operator's `CHANNEL_TASK_NOTIFICATION` is unset or `brief`, so the result is a genuine bypass rather than a `full` setting.
Acceptance: a written trace naming the exact posting call, the attribution, and the reason each existing guard misses it, with a reproduction a reviewer can run. The output is the confirmed root cause Section 2 gates.
Files in scope: read across `broker/routing/outbound.ts`, `broker/tail.ts`, `broker/discord/render.ts`, `broker/discord/surface.ts`, `broker/config.ts`; a temporary reproduction harness under a gitignored scratch path, deleted after.

### 2. Gate the confirmed path to the taskNotifications rule
Model: opus
Once Section 1 names the path, gate it so a finishing subagent's report gets the same treatment the prompt surface already gives a wake prompt: a one-line notice under `brief`, suppression under `off`, and the whole report under `full`. Reuse the existing `deliverTaskNotice` and the `isTaskNotification` or sidechain signal rather than adding a parallel mechanism. Where the bypass is a fixed-string check defeated by a prefix, fix the recognizer to see the wrapper through the prefix rather than only at the string start.
Acceptance: with `CHANNEL_TASK_NOTIFICATION` unset or `brief`, a finishing subagent's report does not appear as a full `📣 Claude · answer` post; it appears as a one-line notice or not at all. With `off`, nothing posts. With `full`, the whole report still mirrors, unchanged. An ordinary session turn's own reply still posts under `full`-independent rules, unchanged.
Files in scope: `broker/routing/outbound.ts` and whichever module Section 1 names, plus the matching test in `broker/routing/` and `broker/discord/`.
Tests: at minimum, lock that a subagent's report is compressed under `brief` and suppressed under `off` on the confirmed path, and that a session's own turn reply is untouched; a control at `full` proves the whole-report path still works. The expensive failure is gating a session's own answer by mistake, which would silence the operator's window into the session.

## Out of Scope
- The `full` setting's whole-report mirror, which is intended behavior.
- A session's own turn reply and the reply tool, which are not a subagent's report.
- Adding a `SubagentStop` hook or otherwise changing which hooks the harness fires; the fix works with the paths that already reach the broker.
- The persona plugin and the kit, which dispatch the subagents; the flood is the channel's to gate.

## Assumptions
- assumed 2026-09-24 (default): the operator's `CHANNEL_TASK_NOTIFICATION` is unset or `brief`, per the operator's word that he does not think it is set; reversal: if it is `full`, the fix is a config change and Section 2 is unneeded, which Section 1 confirms first.
- assumed 2026-09-24 (default): the correct behavior for a subagent's report is the existing `taskNotifications` rule (notice under brief, suppress under off, whole under full), not a new setting; reversal: a separate knob if the operator wants subagent reports controlled apart from wake prompts.
- assumed 2026-09-24 (brainstorming 1-2 section allowance): this two-section reproduce-and-fix spec skips the blind read, the gating litmus, and the plan review; the executing worker's own reviews stand. The root cause is deferred to Section 1 by design, since it could not be pinned from outside the broker.

## Open Questions
- Whether the bypass is the prefix-defeated recognizer, the parent-turn mirror, or a third path. Owner: Section 1, which reproduces and pins it before Section 2 gates it.

## Chapters
(Appended by executing-work as sections complete. Leave empty at creation.)
