# Channels: answering a question from the thread

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session); overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_tailer-blackout_spec_v1.md](../archive/plans/channels_tailer-blackout_spec_v1.md): shipped the
  ask-time question alert and the `PreToolUse` hook entry this design turns into an answer
  channel. This plan begins where that one's backlog entry ("Answering a console question from
  the thread") left off; the entry is absorbed here.

## Goal

An `AskUserQuestion` parked at a console is answerable from the session's Discord thread: the
questions arrive as a readable interactive message (option pickers with descriptions, a typed
reply for free-form), the chosen answers ride back through the held `PreToolUse` hook response,
and the console picker never renders unless the operator releases the question to it or the hold
expires. Both surfaces clean up after whichever one answers.

## Measured shapes this spec builds on

All measured live on this host (operator-driven probe, 2026-08-09) or confirmed in upstream
documentation; none are guesses.

- **A held `PreToolUse` hook blinds the console.** The picker renders only after every
  `PreToolUse` hook has responded; during the hold the console shows the tool call thinking and
  counting seconds. There is no both-surfaces race: the hook response body is the only answer
  channel while it is held.
- **`updatedInput` answering works end to end.** A 2xx response whose JSON body carries
  `hookSpecificOutput.permissionDecision: "allow"` and
  `updatedInput: { questions, answers }` skips the picker entirely; the turn proceeds showing
  the injected answers as the operator's picks. Measured over an `http` hook's response body.
- **A `{}` (no-decision) response releases cleanly to the normal picker,** and a hook timeout is
  a non-blocking error with the same outcome. Every failure direction lands on today's behavior.
- **The answer vocabulary:** `answers` is a map keyed by exact question text; a single-select
  answer is an option label string; a multi-select answer is an array of label strings; a
  free-form reply is `response`, a sibling of `answers` inside `updatedInput` that replaces the
  per-question answers entirely.
- **Long holds are honored.** With the fragment `timeout` at 900, a hook held 6 minutes was
  answered normally: no client-side abort at the common 5-minute mark, and the turn proceeded
  with the injected answers. The hook `timeout` field is per entry, default 600s, no documented
  maximum. Ceilings past 6 minutes are unmeasured; the desk's client-gone trigger self-detects
  one if it exists, so overshooting costs one logged release, never a lost question.
- **The broker side already sustains held responses** (`/relay/stream` lives for the client
  process's lifetime); nothing in the repo sets server-level response timeouts that would kill a
  held hook response.
- **Discord facts:** select menus carry a per-option description (100 chars) natively, the
  readability surface the current alert lacks; `INTERACTION_CREATE` arrives with no additional
  gateway intent; interaction callbacks are their own REST surface and therefore their own rate
  bucket (per the `discord-edit-and-create-are-separate-rate-buckets` memory).

## Approach

**The question desk.** A new module beside the permission desk holds the `PreToolUse` hook
request open instead of answering it immediately. One entry per session (a second ask for the
same session attaches to the same entry if its digest matches, else the newer replaces after
releasing the older), a small host-wide cap, and a single resolution path with five triggers:

1. **Answered from Discord** (component interactions complete, or a typed free-form reply):
   respond `allow` + `updatedInput`; edit the thread message to show what was submitted.
2. **Released by the operator** (the Answer-at-console button): respond `{}`; the picker renders
   in about a second; edit the message to say so.
3. **Hold expiry** (the desk's own timer, margin below the hook timeout so the release is always
   the broker's clean `{}` rather than a CLI-side timeout error): respond `{}`; edit the message
   to "hold released, answer at the console".
4. **Client gone** (the response socket's `close` event fires first): no response possible; edit
   the message the same way. This also self-detects any undocumented client-side hold ceiling.
5. **Broker shutdown**: release every held entry with `{}` before exit.

Every trigger except the first degrades to exactly today's behavior: an alerted phone and a
console picker. Fail direction throughout: a lost hold must never eat a question.

**Gates unchanged from the alert path:** mirror-off sessions are never held (the hook is answered
immediately, as today); a volume-window drop releases immediately rather than holding a question
nobody can see; malformed input holds nothing.

**Console answer cleanup.** When the question is answered at the console (after a release or
expiry), the transcript line lands at that moment and the tailer's existing resolution-time yield
fires; where today it only skips the duplicate alert by digest, it now also tells the desk to
edit the thread message to "answered at the console".

**The interactive message.** One message per ask, replacing today's run-on notice:

- Header line: mention + question count + "answer here or at the console".
- Per question: a bold numbered title line (header + question text), then a select menu whose
  options carry label plus bounded description, min/max values set by `multiSelect`. The reader
  (`askedQuestions`) gains bounded option descriptions; both hook and tailer paths inherit them
  through the shared reader.
- Fast path: an ask that is a single single-select question with at most 4 options renders its
  options as one row of buttons (one tap on the phone) with descriptions in the message text as a
  numbered list.
- Control row: **Send answers** (submits; incomplete selections get an ephemeral "question N not
  answered yet") and **Answer at console** (release). Single-select-only asks auto-submit when
  every question has a value; any ask containing a multi-select waits for Send.
- A typed thread message while the session's entry is held becomes the free-form `response` for
  the whole ask, superseding any partial selections (decided 2026-08-09; it is the operator's
  recorded preferred shape, and steering could only queue against a frozen session anyway).
  Verdict parsing (y/n + code) stays ahead of it in the inbound pipeline.
- Terminal states always edit the message and remove components: answered-from-thread (with the
  submitted answers rendered), answered-at-console, released, expired.

**Security.** Interactions are a new inbound surface: every interaction's user id is checked
against the same one-account allowlist that gates thread messages; non-operator interactions are
ignored quietly. `custom_id` values are opaque desk references (never content); all state
resolves server-side. Option labels and descriptions entering components are untrusted
conversation text: invisibles stripped and length-bounded, but not markdown-escaped (components
render plain text), which needs its own helper beside `inertText` per the
`escaping-untrusted-text-for-discord` memory. Question content continues never to reach broker
logs.

**Interaction responses** are budgeted as their own route-verb bucket beside post and edit.

## Sections of Work

### 1. The question desk and the held hook

Model: fable

The desk module, the intake changes that route a credited PreToolUse question post into it
(mirror-on, parse-yielding, window-allowing posts hold; everything else answers immediately as
today), the five resolution triggers, the digest interplay with the tailer's outstanding set, and
the install fragment's PreToolUse `timeout` raised to 14700 seconds with the desk's hold at
14400 (4 hours, env-tunable), margin-locked below the fragment value by a cross-component pin.

Files: `broker/question-desk.ts` (new), `broker/intake.ts`, `broker/index.ts`,
`hooks/settings-fragment.json`, `hooks/settings-fragment.test.ts`,
`install/Install-Functions.ps1` only if validation needs the timeout named, plus tests.

Acceptance: a held credited question post receives no response until resolution; each of the
five triggers produces its documented response (or none for a dead socket) and its message-edit
call; a mirror-off, malformed, window-dropped, or desk-full post is answered immediately with
`{}` and never held; broker shutdown releases all holds; the fragment pin asserts the PreToolUse
timeout exceeds the desk hold by the margin (cross-component pin, one source for the value).

Tests: lock both directions of every gate (held versus answered-immediately), the
socket-close-first race, the double-resolution guard (a Discord answer landing during expiry
resolves exactly once), and the digest set surviving a hold across broker-visible retries.

### 2. The interactive question message and the interaction surface

Model: fable

The message redesign (per-question select menus with descriptions, the fast single-question
button path, the control row), bounded option descriptions in the shared reader,
`INTERACTION_CREATE` handling in the gateway gated on the operator allowlist, the interaction
callback client with its own budget bucket, component state accumulation on the desk entry, and
the terminal-state message edits.

Files: `broker/discord/render.ts`, `broker/tail.ts` (reader), `broker/routing/gateway.ts`,
`broker/discord/rest.ts` or a sibling interaction client, `broker/question-desk.ts`,
`broker/index.ts`, plus tests.

Acceptance: a 2-question ask (one single, one multi) renders one message with two selects and
the control row, every untrusted field bounded; selections accumulate and Send submits the
documented `answers` shape (string and array); the single-question fast path renders buttons and
auto-submits on tap; a non-operator interaction is ignored with no state change; every terminal
state edits the message and strips components; rendering stays inside Discord's caps (rows,
option counts, message length) for the maximum 4x4 ask.

Tests: lock the answers wire shape against the measured vocabulary (string, array, exact
question-text keys), the allowlist gate both directions, and one render pin per terminal state.

References: the mock in this plan's "Message mock" appendix.

### 3. Typed free-form answers and console-answer cleanup

Model: opus

The inbound router learns the desk: a thread message for a session with a held entry becomes the
whole-ask `response` (after verdict parsing, before steering delivery); the tailer's
resolution-time question yield notifies the desk so a console answer edits the thread message.

Files: `broker/routing/inbound.ts`, `broker/tail.ts`, `broker/question-desk.ts` seams, plus
tests.

Acceptance: a typed message during a hold resolves the entry as `response` and is not delivered
as steering; the same message with no held entry steers exactly as today; a verdict-shaped
message is consumed as a verdict even during a hold; a console answer after release triggers the
answered-at-console edit exactly once.

Tests: lock the pipeline order (verdict, then answer, then steering) in both directions, and the
no-hold passthrough.

### 4. Docs, deploy, and live re-verify

Model: fable
Locus: inline (docs are main-session work; deploy and live checks need operator coordination)

Architecture, security model (the new inbound interaction surface and the held-response
discipline), and operations ("When a session asks you a question" rewritten around answering in
the thread, the release button, expiry behavior, and the interim-off coupling). Sweep the tree
for now-false claims ("no remote answer path exists", the question notice docstring, operations'
"cannot be answered from the thread"), per the comment-sweep memory. Deploy via install update
plus broker restart (elevated hand), then the live checks in Operator Verification.

## Out of Scope

- **The usage/status card** (claude-swap account limits and agent health in Discord): its own
  effort, captured in the backlog on 2026-08-09.
- **The deny-chain re-ask contingency** (broker answers deny near expiry to make Claude re-ask,
  chaining holds indefinitely): recorded as a fallback if expiry-to-parked-picker stings in
  practice; burns model turns and the model may rephrase or stop asking, so it is not built now.
- **Per-question free-form mixing** (typing an answer for question 2 while selecting for
  question 1): a typed reply answers the whole ask; per-question Other can ride a later round
  (Discord modals are the natural surface).
- **The channel permission protocol**: its `allow | deny` verdict vocabulary is untouched.

## Operator Verification

- From the phone, with the console out of reach: answer a parked single-select by button, a
  multi-select by menu, and a third ask by typed reply; each console session proceeds with the
  chosen answers and each thread message shows what was submitted. A wrong or missing injected
  answer at the console reopens Section 2.
- At the console: tap Answer-at-console on the phone and confirm the picker renders within a
  couple of seconds; answer it and confirm the thread message flips to answered-at-console. A
  picker that never renders after release reopens Section 1.
- Let one question expire un-answered and confirm the picker appears at the console and the
  thread message says the hold was released. 

## Open Questions

None. The hold ceiling measurement resolved 2026-08-09 (6-minute hold honored, no early abort);
the shipped values are in Section 1.

## Message mock

```
@Scott ❓ **2 questions** · answer here or at the console

**1. Commit model** · Commit model for this effort?
**2. Sections** · Which sections ship first? *(pick any)*

[select: Commit-and-Push · Review-Only · Branch-and-PR]   (each with its description line)
[select (multi): Desk · Message · Docs]
[ Send answers ]  [ Answer at console ]

_Typing a reply here answers in your own words instead._
```

Fast path (single single-select question):

```
@Scott ❓ **Waiting on you** · answer here or at the console

**Commit model** · Commit model for this effort?
1. **Commit-and-Push** · land on main as sections complete
2. **Review-Only** · staged, reviewed before commit
3. **Branch-and-PR** · feature branch, PR at the end

[ Commit-and-Push ] [ Review-Only ] [ Branch-and-PR ]  [ Answer at console ]
```

## Chapters

(Appended by executing-work as sections complete.)
