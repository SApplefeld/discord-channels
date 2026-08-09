# Channels: the tailer blackout

Status: Open
Commit Model: Commit-and-Push

## Related

- [channels_prompt-surfacing-and-wake-compression_spec_v1.md](../archive/plans/channels_prompt-surfacing-and-wake-compression_spec_v1.md):
  the effort whose live verification surfaced this. Its question alert shipped correct at the unit
  level and delivered 7.5 hours late in the live check that closes it, which reopens the work as
  this round.

## The defect, with the evidence that survived the first forensics pass

During the prior effort's close-out on session `24f852b6` (broker at commit f8afb7d, bound
2026-08-08T23:39:01Z), the transcript tailer went silently dark for that session: narration posted
at 23:40:57 and 23:41:37 and then never again, through a 33-minute stretch that dispatched five
subagents and a quiet 4-minute stretch after them; an `AskUserQuestion` `tool_use` line written at
00:14:14 was alerted at 07:40:31, the same second the picker's resolution wrote the next
transcript lines. The operator's other session, updated the same day, alerted correctly, so the
feature works in the simple case.

Constraints established by direct measurement (full detail and evidence in the project memory
`the-tailer-can-black-out-silently-for-a-subagent-heavy-session`):

- Zero log lines explain any of it: no `tail:` line at all after the restart, no routing drops for
  the session, no staleness transitions. The system failed invisibly, which violates its own
  dead-paths-are-visible principle regardless of the mechanism.
- The question line was newline-terminated when written; the whole-line rule did not hold it.
- The session stayed live all night (relay-attached sessions are exempt from the staleness sweep;
  `lastRelayAt` ticked throughout), so the tailer's live set held it and the poll timer had every
  opportunity.
- Per-poll growth stayed under `MAX_TAIL_READ_BYTES` and no single line exceeded it (no `outgrew`
  lines, and the largest real lines were ~50 KB).
- No hook fired between 00:14:05 and 07:40:31, so the path and offset the tailer held at 00:14:05
  stood unchanged all night; whatever they were, twenty-second passes against them delivered
  nothing for 7.5 hours and then delivered.

## Candidate mechanisms, to be confirmed or killed by Section 1 before anything is fixed

1. **Path flapping from subagent hooks.** Hypothesis: a subagent's tool calls fire `PostToolUse`
   under the parent's `session_id` while carrying the subagent's own
   `<sessionId>\subagents\agent-*.jsonl` as `transcript_path`. `broker/tail.ts`'s `learn()` reads
   any path change as a relearn: epoch bump, offset dropped, silent rebaseline at the new file's
   current end. Continuous flapping between the agent file and the main file would skip everything
   written between flaps, with no log line, which matches the dark subagent stretch exactly. It
   does not by itself explain the overnight stall (no hooks fired overnight, so no flapping), nor
   the delivery landing at the resolution second.
2. **A poll pass that never settles.** `poll()` answers a concurrent call with the running pass and
   starts no new one; a pass wedged on any await (one session's hung read, a delivery await inside
   an ordering chain that never resolves) silences the tailer for every session, forever, with no
   log line saying so. What would have released such a wedge at exactly 07:40:31 is unexplained,
   which is the main reason this stays a candidate rather than a conclusion.

Neither candidate cleanly explains the exact-second delivery, so Section 1 exists.

## Sections of Work

### 1. Instrumented reproduction

Model: fable
Locus: inline (the repro drives live sessions, restarts, and thread reads only the main session
can safely coordinate)

Reproduce the blackout with the mechanism observable, before any fix:

- Capture one real subagent `PostToolUse` payload from a wrapped session (the `tools/dump-hook.ps1`
  harness exists for this; register the capture against a scratch settings scope or a dedicated
  probe session, never the live user settings by accident, per the
  `a-test-that-drives-an-installer-can-install` memory). The single load-bearing fact: does its
  `transcript_path` name the subagent's `agent-*.jsonl` under the parent's `session_id`? That
  confirms or kills candidate 1 in one observation.
- Add temporary (or permanent, if cheap) tailer observability sufficient to watch the live state:
  at minimum a rate-limited debug line or debug endpoint exposing, per session, the learned path's
  stem, the held offset, the allowed flag, and the epoch, plus a pass watchdog that logs when a
  poll pass has been running longer than several intervals. The watchdog is wanted permanently
  regardless of mechanism: it is the visibility line the blackout lacked.
- Drive a wrapped session through a subagent-dispatching stretch and watch the state: a flapping
  path stem confirms candidate 1; a pass-age counter that never resets confirms candidate 2;
  anything else is the real mechanism.

Acceptance: the blackout mechanism is named with a captured observation, not an inference, and the
Chapter records the discriminating evidence.

### 2. The fix the mechanism earns, plus the two hardenings already justified

Model: fable

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
