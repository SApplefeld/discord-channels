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
bounded similarity sketch beside the digest: the text is normalized (whitespace collapsed before
and after the invisible stripping, because tab and newline are in the invisible class and
stripping them first would weld words together; trimmed; case-folded), cut into word 3-gram
shingles, each shingle hashed, and the
k smallest hashes kept (bottom-k MinHash, k = 128). Jaccard similarity estimated over two
sketches at or above 0.85 counts as the same thing said nearly the same way. A sketch is derived
hashes with a hard size bound, not text, so the privacy property survives with one word changed:
digests and bounded similarity sketches. A short summary reply against a long mirror scores far
below the threshold, so the full mirror still posts, which is correct: the summary was not the
content.

**One record per session, consumed on match, and bounded to one turn.** The reply record (digest
plus sketch) is replaced on each reply-tool answer, consumed by the delivery it suppresses, and
cleared by the turn's reply-kind mirror whether or not it matched: the Stop mirror is the turn
boundary, and the reply tool always posts before it, so a record standing past it could only
suppress a coincidental near-match in some later turn. Both orderings of the duplicate collapse
to one copy: the Stop mirror consults the record, and so does the transcript tailer, because a
poll landing between the reply-tool post and the Stop mirror reads the same closing text off the
transcript and would otherwise post it as narration.

**Suppression never eats content the answer did not carry.** A match requires the sketch
similarity threshold AND that the mirror's normalized text is not materially longer than the
recorded answer (within ten percent): a true duplicate or a light rewording preserves length,
while a mirror that grew carries an addendum the operator would otherwise never see, and the fail
direction of this feature is a duplicate message, never lost words.

**The record exists whenever the Stop mirror does.** The echo memory is created whenever
mirroring is on, and the transcript tailer is handed it only when interim mirroring is also on,
so turning interim narration off does not silently disarm the reply dedup.

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

A new module `broker/similarity.ts`: `normalizeForSketch(text)` (collapse whitespace, strip
invisibles via the existing `withoutInvisible`, collapse again, trim, case-fold; collapsing
brackets the strip because tab and newline are in the invisible class),
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
2. Stop the scheduled task (`SapplefeldChannelsBroker`), then kill by the decision table below,
   built from two proofs: the command line (CIM `Win32_Process`) and the configured broker port
   in LISTEN (port from `broker.env`'s `CHANNEL_BROKER_PORT` when present, else 8787, via the
   same env-file reader the installers use). Report each PID killed and what identified it,
   deduping the reasons (a dual-stack listener reports one row per address family for one PID).

   The table, every row pinned by the pure-predicate tests: a node-named process whose command
   line names this checkout's broker entry is killed (the primary proof; requiring the node name
   is what keeps an editor or a grep holding the path in its arguments alive); a node-named port
   holder whose command line is unreadable is killed (the orphan fallback, the case the script
   exists for); a node-named port holder whose readable command line names something else is
   refused and named, because a readable foreign command line is affirmative proof of a
   bystander; any non-node process is never killed, and one holding the port is reported loudly
   with the EADDRINUSE consequence, the same refusal `Install-Elevated.ps1`'s restart makes.
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

### Chapter 1 - 2026-08-08
Completed: 1. The similarity sketch
Implemented By: implementer-opus
Metrics: 1 review round (combined over S1-S3); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The spec-literal normalization order was wrong on contact with the code and the spec was amended: tab and newline live inside withoutInvisible's class, so stripping before collapsing welded words together; the as-built order brackets the strip with collapses. The implementer's measured threshold landscape (four scattered word edits per 144 words sits at the 0.85 boundary; a clause-level rewrite of half the sentences scores ~0.6; a summary scores 0; containment ~0.3) became the empirical basis for Section 2's fixtures. The union-bottom-k estimator was probe-verified against the naive containment estimator, which is exactly the wrong one for the short-summary case.
Review Findings: no findings against this section itself; the reviewers verified the estimator honest at every length ratio.
Stamps: none surfaced in the window
Next: 2. The dedup wiring (built beside Section 3, closed in Chapters 2-3)
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-08
Completed: 2. The dedup wiring
Implemented By: implementer-fable, plus a fix round on the same agent after the combined review
Metrics: 2 review rounds (combined initial + prescriptive fix verification); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The review round rewrote the contract in three places, all now spec text. The echo memory existed only under interim mirroring, so the headline dedup silently disarmed on a mirror-only host; it is now created whenever mirroring is on, with the tailer alone gated on the interim switch. The tailer-first ordering shipped the duplicate as narration (a poll between the reply-tool post and the Stop mirror); the tailer now consults the answer record too, so both orderings collapse to one copy. The answer record gained a turn boundary (cleared by every reply-kind mirror, matched or not) after three reviewers independently flagged cross-turn coincidental suppression. The security review surfaced the one finding that changed shape rather than wiring: near-match suppression was a bounded content-loss channel (a mirror that is the answer plus a new closing sentence stayed above threshold and the sentence reached the operator nowhere), closed with the length guard: suppression additionally requires the mirror's normalized length within ANSWER_LENGTH_ALLOWANCE (1.10) of the answer's, so the direction that loses words now posts. Residual, accepted and to be documented in the security model by Section 4: a sub-ten-percent addendum with high shingle overlap can still be suppressed.
Review Findings: 2 Major fixed (inert-when-interim-off gate; tailer-first ordering); Minors fixed: turn boundary, length guard (from the security review); Minor noted: the startBroker seam's positive half (dedup with echo present and no tailer) is pinned at the router seam rather than through startBroker, because without Discord configured the echo consult is unreachable through the entrypoint; the wiring line itself is a reviewed one-line ternary.
Stamps: none surfaced in the window
Next: 3. The repair script (closed in Chapter 3)
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-08
Completed: 3. The repair script
Implemented By: implementer-opus, plus two fix rounds on the same agent (the port-holder refusal pre-review, the decision table after review)
Metrics: 2 review rounds; 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: The kill policy tightened twice, both times toward proof. Before review, the orchestrator replaced the spec's unconditional port-holder kill with the non-node refusal Install-Elevated already makes. The review round then converged on the remaining two bystander paths and the spec's step 2 became an explicit decision table: the command-line proof now also requires the node name (an editor holding the entry path in its arguments was killable), and a node-named port holder with a readable foreign command line is refused (only an unreadable command line earns the orphan fallback). Hardening minors all fixed: deduped dual-stack reasons, 200-is-ready with best-effort session count, the 8787 fallback cross-pinned against broker/config.ts's DEFAULT_PORT by importing it in the test, and a Get-Process name fallback for a listener PID missing from the CIM snapshot. The real-run gate on SCOTT is the finishing pass's, recorded in the close-out Chapter.
Review Findings: 1 Major fixed (readable-foreign node holder killed by port proof); security Minors fixed (substring proof over any process; snapshot-miss refusal); Minors fixed: dual-stack double reason, readiness parse; noted: git fetch runs during the down window (spec ordering; an unreachable origin extends the outage by git's TCP timeout, accepted).
Stamps: none surfaced in the window
Next: 4. The docs carry both changes
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-08
Completed: 4. The docs carry both changes
Implemented By: main session (docs/ writes; Locus: inline as planned)
Metrics: 0 review rounds (prose-only section; the finishing pass covers it); 0 NEEDS_CONTEXT; 0 escalations; advisor opus
Decisions / Surprises: security-model.md's "every turn's final reply is posted in full" claim was the standing sentence the dedup falsified; it now states the two suppression cases (tailer narration, reply-tool answer), the length guard, the accepted residual (a small addendum inside the threshold can be suppressed), what is actually held in memory (digest, length, bounded sketch, one record, one turn), and the never-serialized precondition the sketch's non-preimage-resistant hashes rest on. operations.md gained the one-copy account beside the coalescing description and a "When a broker looks stale, doubled, or wrong" section documenting Repair-Broker.ps1, its decision table in operator terms, and the orphan tell (gateway connected followed by EADDRINUSE). The backlog's measure-duplication item retired to the Q3 snapshot as measured-by-operation and acted on, with the residual watchable named as an observation rather than a standing item.
Review Findings: none (see Metrics)
Stamps: none surfaced in the window
Next: finishing-work
Commit Model: Commit-and-Push
