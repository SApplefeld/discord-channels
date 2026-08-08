# Channels: prompt surfacing and wake compression

Status: In Progress
Commit model: Commit-and-Push (per this repo's precedent and the operator's "run them both now",
2026-08-08)
Model: implementer sections at the session tier (fable), reviewer pair per section

## Why

Two operator reports from live fleet use, both diagnosed against real transcripts and the live
Discord threads on 2026-08-08:

1. **A question prompt parks a session invisibly.** When a session calls `AskUserQuestion`, the
   console shows a picker and the thread shows nothing. No hook fires for the tool (verified
   against current Claude Code docs: `PreToolUse` does not run for it, `Notification` does not
   fire for it, and the channel protocol carries only tool-permission requests). The one place the
   question exists outside the console is the session transcript: the model's `tool_use` line
   carries the full questions and options, and it is flushed at emission, before the operator
   answers (verified by reading an in-flight session's own transcript mid-turn). The transcript
   tailer already polls that file.

2. **A background subagent finishing floods the thread.** A subagent finishing while its parent
   session is idle wakes the session with an injected prompt: a `user` line whose content is a
   bare string beginning `<task-notification>`, carrying the subagent's entire final report. The
   injection fires `UserPromptSubmit`, so the mirror posts the whole report into the thread as an
   operator-attributed "typed at the console" block, split across many messages (measured: one
   scout report became 8 paced messages). The console renders these wake-ups compactly, so the
   thread is louder than the terminal. Memory:
   `an-idle-sessions-task-notification-arrives-as-a-real-prompt.md`.

The operator chose: compress the wake prompts to a one-line notice (with a knob to restore full
fidelity), and surface an open question in the thread as an alert. Remote *answering* of a question
is out of scope: no extension point exists (see Out of scope).

## Measured shapes this spec builds on

An `AskUserQuestion` `tool_use` block's `input`, from a real transcript
(`4724aa3a-5ad6-4780-9064-943424d85355.jsonl`):

```json
{ "questions": [ { "question": "…", "header": "Posture", "multiSelect": false,
    "options": [ { "label": "…", "description": "…" }, … ] }, … ] }
```

`questions` is 1 to 4 entries; `options` is 2 to 4 entries per question. All strings are untrusted
conversation text.

A wake prompt is the mirror-route `UserPromptSubmit` payload whose `prompt`, after
`withoutInvisible(...).trimStart()`, begins with the literal `<task-notification>`. The mirror
route drops oversized bodies whole rather than truncating, so a prompt that reaches the router is
complete and a prefix recognizer cannot be fooled by a cut (the
`parsing-truncated-text-can-manufacture-a-match` memory's condition is satisfied). The mid-turn
variant of a task notification is a `queued_command` attachment with `commandMode:
"task-notification"`, which the tailer's allowlist already refuses; only the idle-wake variant
reaches Discord, through the hook mirror.

## Section 1: wake-prompt compression on the mirror path

**Files:** `broker/config.ts`, `broker/routing/outbound.ts`, `broker/discord/render.ts`,
`broker/index.ts`, plus `broker/config.test.ts`, `broker/routing/outbound.test.ts`,
`broker/discord/render.test.ts`.

- `broker/config.ts`: a `taskNotifications` knob read from `CHANNEL_TASK_NOTIFICATION`, vocabulary
  `brief | full | off`, default `brief`, refusing any other spelling at startup exactly as
  `strictFlag` refuses (a knob silently moved is a knob nobody can reason about).
- `broker/discord/render.ts`: `renderTaskNotice(text: string): string`. Extracts the task id from
  the first `<task-id>…</task-id>` pair (bounded: accept at most 64 characters of id, else treat
  as absent), and composes one line: `📨 background task finished · <id>` with the id through
  `inertText`, or `📨 background task finished` when no id is readable. Broker-composed text with
  one neutralized untrusted field, following `renderPermissionRequest`'s pattern.
- `broker/routing/outbound.ts`: a new option `taskNotifications: "brief" | "full" | "off"`
  (default `"brief"` when absent). A prompt-kind post is recognized as a wake prompt by
  `withoutInvisible(text).trimStart().startsWith("<task-notification>")`, one reading applied in
  both places a prompt reaches a thread, the `mirror` prompt branch and `interimPrompt`, exactly
  as the channel-envelope check is applied in both, and checked after the envelope check.
  - `brief`: post `renderTaskNotice(text)` as a single-message run through the chained `deliver`
    doorway (so it takes its thread-order place and ends any narration block), report `sent` on
    success.
  - `full`: current behavior, untouched.
  - `off`: drop with a `dropped(...)` line naming the cause and the session, report
    `{ status: "failed", error: "task notification suppressed" }` (the intake ignores the result;
    the log line is the discriminator, and it never carries the text).
- `broker/index.ts`: pass the config knob into `createOutboundRouter`.

**Acceptance:** with the knob at `brief` (and by default), a prompt-kind mirror post whose text is
a `<task-notification>` wake prompt produces exactly one thread message reading
`📨 background task finished · <id>`; `full` reproduces today's behavior byte-for-byte;
`off` posts nothing and logs one bounded line; an ordinary prompt and a channel-envelope prompt
behave exactly as before on all three settings; an unrecognized `CHANNEL_TASK_NOTIFICATION`
spelling refuses startup. `npm run lint` and `npm test` green.

## Section 2: open-question alert from the tailer

**Files:** `broker/tail.ts`, `broker/discord/render.ts`, `broker/index.ts`, plus their tests.

- `broker/tail.ts`: the `lineItems` allowlist gains a third yield. A non-sidechain line whose
  `sessionId` matches, whose `type` is `assistant`, and whose `message.content` array holds a
  block with `type: "tool_use"` and `name: "AskUserQuestion"` yields one question item carrying
  bounded structured data from `input.questions`: for each of at most 4 entries, `question`
  (non-empty string), optional `header` (string), `multiSelect` (boolean, absent reads false),
  and at most 4 option labels (`options[].label`, non-empty strings; descriptions are dropped).
  An entry missing a readable `question` is skipped; a line yielding zero readable questions
  yields nothing (allowlist silence, never a guess). New `TailItem` variant
  `{ kind: "question", questions: … }`.
- Delivery: a new injected seam `deliverQuestion` beside `deliver` and `deliverPrompt`, one await
  per item in transcript order, drop-not-retry, no echo digest (no other path posts this text),
  errors discarded unread exactly as the sibling paths discard them.
- `broker/discord/render.ts`: `renderQuestionNotice(input: { operatorId: string; questions: … }):
  string`. One message: a mention of the operator composed from the broker's own config (the
  second deliberate mention in the system, alongside the permission prompt, and safe for the same
  reason: every untrusted field goes through `inertText`), a header line saying a question is
  waiting at the console, then per question a bounded `Q:` line (`fit` at 500 code points,
  prefixed with the `header` through `inertText` when present, suffixed `(multi-select)` when
  set) and an `Options:` line (labels through `inertText`, each `fit` at 100, joined with the
  `·` separator). Field caps follow `renderPermissionRequest`'s reasoning: the mention and the
  header line must survive any content length.
- `broker/index.ts`: wire `deliverQuestion` to a closure that resolves the thread via `threadFor`,
  renders with the sender gate's `operatorId`, and posts through `steeringWriter.alert` (the
  unfloored, phone-reaching tier permission prompts use; the notice floor could swallow a
  question, and a swallowed question is a parked session). Before Discord is configured the
  closure reports `no-thread` and drops. `endNarration` is already handled inside
  `steeringWriter.alert`.

**Acceptance:** appending a real-shape `AskUserQuestion` `tool_use` line to a tailed transcript
produces exactly one alert in the session's thread, mentioning the operator, showing each
question and its option labels, with markdown and chips neutralized; sidechain lines, foreign
`sessionId` lines, and malformed `input` shapes yield silence; the alert posts even while a long
mirror run is pacing in the same thread (it rides the steering writer, not the mirror writer).
`npm run lint` and `npm test` green.

## Section 3: docs

`docs/architecture.md`: the mirror path's description gains the wake-prompt compression (data
flow item 2 and the external-integrations hook paragraph), and the mid-turn narration section
gains the question alert as the tailer's third yield. `docs/operations.md` gains the
`CHANNEL_TASK_NOTIFICATION` knob if it carries the knob table (check at execution). Present-state
prose only; the journey stays in this spec and the commits. Docs are main-session work
(subagents cannot write under `docs/` in this harness).

## Section 4: deploy and live verify

- Baseline `npm run lint` / `npm test` counts are recorded before Section 1 and re-run after each
  section; deltas reported against the baseline.
- Deploy: restart the SCOTT broker via the blessed path (consult `machine-launch-surfaces`
  memory), confirm `GET /sessions` answers and the log shows the Discord surfaces up.
- Live verify Section 1: from this session, dispatch a trivial background subagent, end the turn,
  and let its completion wake the session; read the thread over REST and confirm the wake shows
  as one `📨` line rather than a quoted report.
- Live verify Section 2: at close-out, issue a real `AskUserQuestion` from this session and
  confirm the ❓ alert lands in this session's own thread within one poll interval.

## Out of scope, recorded so it is not re-litigated

- **Remote answering of a question.** No extension point exists: `PreToolUse` does not run for
  `AskUserQuestion`, no hook observes it, and the channel permission protocol's verdict
  vocabulary is `allow | deny` only. The operator's chosen future shape, "whatever I type
  becomes the Other answer", needs upstream Claude Code support; a backlog entry records it.
- **A "waiting on you" thread-title state.** Renames are the scarce Discord resource and the
  alert already pings the phone; revisit only if the alert proves insufficient.
- **Spoiler-collapsed full reports (the operator's "Option B for Q2 later")**: backlog, behind
  the `full` knob value if wanted.
- **A `Notification` hook registration** (would catch permission prompts in unwrapped sessions):
  separate effort, needs its own transport measurement.

## Chapters

### Chapter 1 - 2026-08-08
Completed: Section 1: wake-prompt compression on the mirror path
Implemented By: implementer-fable (recognizer symmetry and prefix-hardening review fixes applied
by the main session)
Metrics: 1 review round (adversarial + blind + security, all at fable); 0 NEEDS_CONTEXT; 0
escalations; advisor off
Decisions / Surprises: three one-line edits outside the spec's file list were forced and accepted:
`intake.test.ts` and `index.test.ts` hold exhaustive `BrokerConfig` defaults helpers the compiler
forces the new field into, and `install/Install-Functions.ps1`'s env allowlist gains
`CHANNEL_TASK_NOTIFICATION` because an unbriefed pin test fails without it and an installed broker
could never receive the knob (the spec's file list simply missed it). The recognizer literal
deliberately stops before the tag's closing bracket (blind-review hardening: an attribute-growing
harness revision must not silently disable the compression), and the id scan reads the
invisible-stripped text so it and the recognizer cannot disagree about one message (flagged
independently by two reviewers). The `off` result shape mirrors the sibling drop paths.
Review Findings: 0 Critical, 0 Major; 9 Minor across three reviewers. Fixed: extraction/recognizer
invisible-strip asymmetry; prefix hardened past the closing bracket (both with pinning tests).
Noted, not fixed: the narration-block-ending claim rides the shared `deliver` doorway rather than
a dedicated test; `interimPrompt`'s wake gate is defense in depth the current tailer allowlist
makes unreachable (spec says so); `strictFlag`-style error messages interpolate the raw env value
unbounded (matches the existing sibling, operator-controlled startup-only surface); first
task-id-pair-wins is attacker-orderable but bounded and neutralized. Deferred to Section 3 docs:
name `full` mode as re-accepting the operator-attributed rendering of harness-injected wake text
(security reviewer, security-model residue).
Stamps: adjudicated 3, stamped 3 (claude-code-transcript-jsonl-shape,
claude-code-channel-and-hook-facts, an-idle-sessions-task-notification-arrives-as-a-real-prompt)
Next: Section 2: open-question alert from the tailer
Commit Model: Commit-and-Push
