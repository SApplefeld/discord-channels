# Channels: the tailer blackout

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: standing (Fable-led session)

## Related

- [channels_prompt-surfacing-and-wake-compression_spec_v1.md](../archive/plans/channels_prompt-surfacing-and-wake-compression_spec_v1.md):
  the effort whose live verification surfaced this. Its question alert shipped correct at the unit
  level and delivered 7.5 hours late in the live check that closes it, which reopens the work as
  this round.

## The mechanism, as Section 1's forensics confirmed it

There was no tailer blackout. The confirmed account (evidence in Chapter 1 and the project memory
`an-open-askuserquestions-line-is-withheld-from-the-transcript`):

- **The assistant line carrying an open `AskUserQuestion` is not written to the transcript while
  the picker is open.** Proof is byte order against the append-only file: lines stamped 00:41,
  00:49, and 07:40:31 sit at lower offsets than the question line stamped 00:14:14, so that line
  was physically written at 07:40:31, the second the operator answered. A transcript line's
  `timestamp` is emission time, not write time; the first forensics pass sorted by timestamp and
  manufactured the "7.5-hour-late tailer" narrative from that error.
- **The tailer was healthy through the whole window.** The "dark 33 minutes" contained one
  assistant text block total, and it was delivered nine seconds after it was written, appended by
  coalescing edit into the 23:41:37 Discord message where a content-prefix scan could not see it.
  Every alert observed live that night, across both sessions, was a post-answer alert because the
  question lines landed at answer time.
- **Both candidate mechanisms are killed.** Path flapping: a captured subagent `PostToolUse`
  payload carries the parent's own transcript path (the subagent identity rides in separate
  `agent_id`/`agent_type` fields), so `learn()` is never taught a subagent path. Wedged pass: the
  broker's timers, Discord writes, and tailer deliveries ran normally all night; the 03:08-07:41
  log silence was an idle fleet (zero sleep/wake events exist in the machine's System log).
- Two real but secondary observations: oversized subagent-completion `PostToolUse` posts bounced
  off the intake's size cap all evening (`hook refused` lines, retried by the CLI for ~3 hours),
  and the flush is lazy rather than strictly resolution-gated (one question asked while its turn
  was actively writing narration landed pre-answer and alerted ~70s before its answer).

The consequence: **no tailer patch can alert a quietly parked question**, because the data does
not exist on disk until the answer. The timely signal is upstream's `PreToolUse` hook for
`AskUserQuestion` (changelog 2.1.85, which also allows answering via `updatedInput`), pending live
confirmation that it fires on an interactive session on this host.

## Sections of Work

### 1. Forensic identification of the mechanism (complete)

Model: fable
Locus: inline

As planned, this section was an instrumented reproduction. As executed, no instrumentation was
needed: the mechanism was named from artifacts that already existed. What ran, each observation
captured rather than inferred:

- A scratch-settings headless probe captured a real subagent `PostToolUse` payload: it carries the
  parent's `session_id` and the parent's own transcript path, with the subagent identity in
  separate `agent_id`/`agent_type` fields. Candidate 1's premise killed in one observation, as
  specified.
- Byte-offset timelines of the blackout session's transcript (a scratch script, `timeline.mjs`)
  proved the question line was written at resolution, not at emission, and that the "dark stretch"
  contained almost no assistant text at all.
- The broker log across the window showed the intake refusing oversized hook posts all evening and
  an idle-fleet silence from 03:08, not a wedge; Discord thread reads over REST confirmed every
  delivery the transcript owed, including the one narration chunk hidden inside a coalescing edit.

Acceptance met: the mechanism is named with captured observations (byte order, a captured payload,
the log, and the thread), and Chapter 1 records the discriminating evidence.

### 2. The fix the mechanism earns, plus the two hardenings already justified

Model: fable

> **Pending redesign.** Section 1's findings invalidate this section's premise: there is no tailer
> mechanism to fix, and the fix the confirmed mechanism earns is a `PreToolUse` hook path for
> `AskUserQuestion`, gated on a live interactive probe. The redesign is in front of the operator
> now (Chapter 1 records the findings); this section's text is rewritten once ratified.

- Fix the confirmed mechanism from Section 1.
- Regardless of mechanism, two hardenings are already evidence-backed: `learn()` refuses a taught
  path whose filename stem is not the session id it is taught for (every real transcript's stem
  equals its session id, per the `claude-code-transcript-jsonl-shape` memory; a subagent file can
  then never become a session's learned path, and the refusal logs one bounded line), and the
  pass watchdog from Section 1 stays, as the permanent visibility line. Both carry tests; the
  stem-pin's test drives `learn` with an `agent-*.jsonl` path and asserts refusal plus the log
  line, and a red-probe proves each test discriminates.
- The full gates (`npm run lint`, `npm test`) green, with counts against the current baseline
  (728 tests / 727 pass / 0 fail / 1 skipped at commit 7c64797).

### 3. Deploy and live re-verify

Model: fable
Locus: inline

- Restart the SCOTT broker. The restart needs an elevated hand: the running broker was started
  from an elevated prompt, and the `claude-sessions-on-scott-run-elevated` memory carries why an
  unelevated session cannot bounce it. Coordinate with the operator, or land the backlog's
  `Start-Broker.ps1` port-clearing hardening first so the scheduled task clears its own port.
- Re-run the prior effort's two live checks under subagent load: a session that dispatches
  subagents must narrate through the stretch, and an `AskUserQuestion` asked during or after such
  a stretch must alert within one poll interval, not at resolution. The operator confirms the
  alert reached the phone.

## Chapters

### Chapter 1 - 2026-08-09
Completed: Section 1: Forensic identification of the mechanism
Implemented By: main session
Metrics: 0 review rounds (read-only forensics; no code changed); 0 NEEDS_CONTEXT; 0 escalations;
advisor off
Decisions / Surprises: the effort's founding premise died under evidence. The discriminating find
is byte order against the append-only transcript: lines stamped 00:41, 00:49, and 07:40:31 sit at
lower offsets than the `AskUserQuestion` line stamped 00:14:14, so Claude Code wrote the question
line at answer time and the tailer alerted within a second of the line existing. The first
forensics pass had sorted by `timestamp`, which is emission time, not write time. Candidate 1
(subagent path flapping) was killed by a captured subagent `PostToolUse` payload carrying the
parent's own transcript path; candidate 2 (wedged pass) by the broker's visibly healthy night
(live card-edit and refusal chatter until an idle fleet went quiet at 03:08; zero sleep events in
the System log). The "missing" narration chunk was found delivered inside a coalescing edit of an
earlier Discord message (edited_timestamp 00:10:31, nine seconds after the text was written); the
operator's three overnight Discord messages were the buffered `queue-operation` neighbors that
made the byte-order proof possible. Convergent discovery: upstream changelog 2.1.85 added
`PreToolUse` for `AskUserQuestion` (with `updatedInput` answering), found in the operator's fresh
`D:\Claude-Code` clone before the forensics began; it is the only timely alert path and the fix
direction Section 2's redesign now proposes. Secondary observations for later rounds: subagent
completion `PostToolUse` payloads (67-327KB) bounce off the intake size cap and the CLI retries
them for hours; the flush is lazy rather than strictly resolution-gated, so pre-answer alerts can
happen but are never guaranteed. Records corrected in the same session: the
`the-tailer-can-black-out-silently-for-a-subagent-heavy-session` memory retired and superseded by
`an-open-askuserquestions-line-is-withheld-from-the-transcript`; the transcript-shape memory
gained the append-order-versus-timestamp rule; the backlog's "no hook runs for that tool,
upstream-blocked" entry rewritten around 2.1.85. The archived prior plan's contrary claim
("flushed at emission") stays as append-only history.
Review Findings: none (no code changed; the finishing pass covers the round)
Stamps: adjudicated 4, stamped 1 (claude-code-transcript-jsonl-shape); the blackout memory was
corrected and superseded rather than stamped; three operator-tier reads
(claude-code-file-permission-rules, claude-code-permission-deny-rules,
azure-cli-under-armed-sp-on-windows) skipped as not applied to this work
Next: Section 2, pending the operator's ratification of the redesign (PreToolUse alert path gated
on the interactive probe, plus which hardenings survive)
Commit Model: Commit-and-Push
