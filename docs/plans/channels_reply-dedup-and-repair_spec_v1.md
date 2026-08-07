# Reply dedup and the broker repair script

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: S2 implementer; the S1, S2, and S3 reviewer pairs (one tier above their writers); finishing reviews
Created: 2026-08-07

## Goal

Two operator-reported items. First, on long turns the thread often carries the same text twice:
the model calls the reply tool with its closing summary, and seconds later the Stop mirror posts
the turn's final text, which is frequently the same words or a light rewording. When this plan is
done, a mirrored reply that matches a reply-tool answer the session just posted, exactly or
nearly, is suppressed, so the thread carries one copy. Second, a broker process that outlives its
scheduled task is a recurring operational hazard (a task stop can orphan the process, which then
holds the port against the replacement and keeps running stale code). When this plan is done, one
script kills everything that is provably this repo's broker, verifies the host's setup, restarts
the task, waits on the real readiness signal, and reports health, so "this host looks stale or
doubled" is one command to fix.

## Approach

**The mirror is the suppressible copy.** The reply tool posts mid-turn and the Stop mirror posts
at turn end, so by the time the duplicate exists, the reply-tool message is already on the
thread. The dedup therefore suppresses the mirrored reply when it matches a recent reply-tool
answer, which nets the operator one copy, the `📣 Claude · answer` one. This mirrors the existing
tailer dedup in shape: the suppressed mirror is reported to the relay as sent (the text is in
front of the operator), and its digest is still recorded in the echo memory so the transcript
tailer does not later post the same text as narration.

**Near-match runs on sketches, never on retained text.** The broker's documented privacy property
is that no conversation text is held in memory past the moment it is posted; the echo memory
holds digests. "Very close" needs more than an exact digest, so the reply record carries a
bounded similarity sketch beside the digest: the text is normalized (invisible-stripped, trimmed,
whitespace-collapsed, case-folded), cut into word 3-gram shingles, each shingle hashed, and the
k smallest hashes kept (bottom-k MinHash, k = 128). Jaccard similarity estimated over two
sketches at or above 0.85 counts as the same thing said nearly the same way. A sketch is derived
hashes with a hard size bound, not text, so the privacy property survives with one word changed:
digests and bounded similarity sketches. A short summary reply against a long mirror scores far
below the threshold, so the full mirror still posts, which is correct: the summary was not the
content.

**One record per session, consumed on match.** The reply record (digest plus sketch) is replaced
on each reply-tool answer and consumed by the mirror it suppresses, the same
no-standing-blocklist rule the tailer echo follows: one answer suppresses at most one mirror, so
a turn ending with the same words as an earlier one is never silenced by history.

**The repair script kills by proof, not by name.** The recurring failure is an orphaned broker
process surviving its task: `Stop-ScheduledTask` does not reliably kill the child node process,
which then holds the port (observed live on SCOTT: the fresh instance exited on EADDRINUSE while
the orphan ran stale code). The script therefore selects targets two ways and only those ways:
any process whose command line names this repo's broker entry point, and whatever process holds
the configured broker port in LISTEN. It never kills by process name alone, because "kill all
node" is the failure mode that takes out unrelated work. Verification reuses what the installers
already know how to check rather than re-deriving it, and readiness is the same real signal the
installer waits on: `GET /sessions` answering.

Decided 2026-08-07 with the operator: both items in one effort; Commit-and-Push; suppress lands
on the mirror side for the temporal reason above.

## Sections of Work

### 1. The similarity sketch

Model: opus

A new module `broker/similarity.ts`: `normalizeForSketch(text)` (strip invisibles via the
existing `withoutInvisible`, trim, collapse whitespace runs to one space, case-fold),
`sketchOf(text): Sketch` (word 3-gram shingles, 64-bit FNV-1a hashes as bigint, bottom-k with
k = 128; a text shorter than one shingle sketches its whole normalized self as a single hash),
and `similarity(a, b): number` (bottom-k Jaccard estimate; two empty sketches are similarity 0,
never 1, because "nothing said twice" must not read as a match). Named constants for k, the
shingle width, and the match threshold `NEAR_MATCH_THRESHOLD = 0.85`, all in this file, so the
tunable knob has one home.

Files: `broker/similarity.ts`, `broker/similarity.test.ts`.

Acceptance: `npm run lint` clean, `npm test` green.

Tests: lock both directions of the threshold on realistic prose (a light rewording of a paragraph
scores at or above it; a two-line summary of that paragraph scores well below), because the
threshold is the feature: too loose suppresses mirrors that carried new content, too tight ships
the duplication this plan exists to remove. Lock normalization robustness (case, whitespace, an
invisible character do not break a match) and the bound (a sketch of a very long text holds at
most k hashes).

### 2. The dedup wiring

Model: fable

`EchoMemory` (broker/tail.ts) gains the reply-answer record: `noteAnswer(sessionId, text)`
stores the digest and sketch of a reply-tool answer, replacing the previous record for that
session, and `isAnswerEcho(sessionId, text)` reports and consumes a match, where a match is the
exact digest or sketch similarity at or above the threshold. The sweep and forget cover the new
record like the existing two.

`outbound.reply` records the answer on a fully landed run (the same landed-whole rule the
narration state follows). `outbound.mirror` with the reply kind checks the answer record after
the existing tailer-echo check: on a match, the mirror is dropped with status sent, the drop log
carries a line naming the cause and the session and never the text, and `echo.noteReply` still
records the mirror's digest so the tailer does not re-post the same text as narration. The
mirrored prompt and interim kinds are untouched.

Files: `broker/tail.ts`, `broker/routing/outbound.ts`, `broker/tail.test.ts`,
`broker/routing/outbound.test.ts`, `broker/index.ts` (only if wiring demands it; expected
untouched since the echo memory already flows to both sides).

Acceptance: `npm run lint` clean, `npm test` green.

Tests: lock suppression in both directions (an identical and a lightly reworded mirror are
suppressed and reported sent; a genuinely different mirror and a long mirror following a short
summary reply still post), because the inverted failure is a real reply the operator never sees.
Lock consume-on-match (the same answer suppresses one mirror, not every later identical one) and
the tailer interplay (after a suppressed mirror, the tailer does not post that text as
narration). Lock that a reply run that failed partway records nothing.

### 3. The repair script

Model: opus

`install/Repair-Broker.ps1`, a sibling of the existing installers in style and structure
(param block, dot-sources `Install-Functions.ps1` where its helpers serve). Behavior, in order:

1. `-Pull` (optional): `git pull --ff-only` in the repo root, reporting the before and after
   commits; a non-fast-forward or dirty-tree condition is reported and the script continues to
   the health pass without pulling.
2. Stop the scheduled task (`SapplefeldChannelsBroker`), then kill by proof: every process whose
   command line contains this repo's `broker\index.ts` path (CIM `Win32_Process`), and any
   process holding the configured broker port in LISTEN (port from `broker.env`'s
   `CHANNEL_BROKER_PORT` when present, else 8787, via the same env-file reader the installers
   use). Report each PID killed and what identified it. Never kill by process name.
3. Verify the setup and report each check as pass or fail without stopping: state root exists;
   `broker.env` exists and names a host; the token file named by the env exists; the scheduled
   task is registered; `node` resolves; the repo's HEAD commit, and whether origin is ahead
   (fetch, compare, report only).
4. Start the task, then wait on readiness: poll `http://127.0.0.1:<port>/sessions` until it
   answers 200 or a 30-second budget runs out, reporting which.
5. Print the one-screen summary: host name, HEAD commit, task state, PIDs killed, readiness
   result, and session count from `/sessions`.

The script mutates only broker processes it proved and the scheduled task; it never touches
settings files, hooks, or ACLs (that is the installers' job, and `-Fix`-style repair of install
state is out of scope).

Files: `install/Repair-Broker.ps1`, `install/Repair-Broker.test.ts`.

Acceptance: `npm run lint` clean, `npm test` green, and one real run on SCOTT (the main session
runs it after review; it is the gate the unit tests cannot be).

Tests: lock the kill-selection predicate in both directions (a process whose command line names
this repo's broker entry is selected; a node process with an unrelated command line, and a
process merely named node, are not), because killing a bystander is the expensive failure and
the predicate is pure enough to test without killing anything. Follow the installer tests'
isolation rule: the test must not touch the live state root, the real task, or real processes
(the a-test-that-drives-an-installer-can-install lesson: make the real destination unreachable
by construction).

### 4. The docs carry both changes

Model: fable
Locus: inline

`docs/operations.md`: the dedup joins the mid-turn narration section's account of what lands in
a thread (one copy when the reply tool and the mirror said the same thing, and which copy), and
a short section documents `Repair-Broker.ps1` as the answer to "this host looks stale, doubled,
or wrong". `docs/security-model.md`: the digests-only memory claim widens to digests and bounded
similarity sketches, with the one-sentence argument (derived hashes, hard size bound, no text).
`docs/backlog.md`: the duplication-measurement item retires to the quarter snapshot as measured
and acted on (header volume was settled by narration coalescing; the reply-versus-mirror half is
settled by this plan; what remains watchable, narration volume plus a full mirror on very long
turns, is a new observation if it ever itches). Inline because docs/ writes are the main
thread's.

Files: `docs/operations.md`, `docs/security-model.md`, `docs/backlog.md`,
`docs/archive/backlog-2026-Q3.md`.

Acceptance: no doc claims the memory holds digests only; the script is findable from
operations.md; the backlog item is in the snapshot, not struck through in place.

## Out of Scope

- Suppressing or altering reply-tool messages themselves: a deliberate model-authored message to
  the operator's phone always posts; only the mirror's redundant copy is suppressed.
- Cross-turn dedup (a reply in one turn against a mirror in another beyond the one-record
  window), and any dedup of interim narration beyond what already exists.
- Any repair of install state (settings, hooks, ACLs, task registration): the script reports
  those; fixing them stays the installers' job.
- Coaching the reply tool's usage via prompts or docs.

## Operator Verification

- After a long turn where the close-out reply and the final text say nearly the same thing, the
  thread shows one copy (the `📣 Claude · answer` message) and no `✨ Claude` duplicate. A real
  reply that never appears in any form reopens the work.
- Run `install/Repair-Broker.ps1` on a host you suspect is stale: it should end with a green
  readiness line and a session count, and a second run immediately after should find nothing to
  kill but the healthy process it just started (which it restarts cleanly).

## Open Questions

None.

## Chapters

