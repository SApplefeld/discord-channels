# A prompt answered anywhere stops waiting here

Status: Complete. Confirmed on a live host: a prompt answered at the console lost its buttons, and the
thread's pause glyph and `needs you` cleared a moment later, which is the refresh tick the state is
recomputed on.
Commit model: Review-Only (commit when the operator asks)

## Why

A permission prompt answered at the keyboard is never cleared from the broker. The entry is removed
only when a verdict resolves it, expiry by age was deliberately rejected, and Claude Code announces
nothing when a prompt resolves elsewhere. That last part is measured rather than assumed: a relay
carrying a fallback handler that names every unclaimed notification stayed silent through exactly that
sequence.

Three things follow, and the third is the one that matters.

A live, working session renders `needs you` until it ends or the broker restarts. Observed on a
session that had fired a hook a minute earlier.

Its prompt keeps live Allow and Deny buttons over a request that no longer exists. A tap delivers a
verdict for something already resolved and rewrites the message to claim a verdict the operator may
not have given.

And the entry holds one of 64 slots, host-wide across every session. At the ceiling the **newest**
request is refused rather than the oldest evicted, and a refused prompt is not posted to Discord at
all: the session parks with one log line. So 64 console-answered prompts stop every later prompt on
that host from reaching the operator. Bounded and terminal, not gradual.

## The signal

Claude Code will not tell us, so the rule is derived from what the broker already hears.

**A `Stop` from a session means every permission prompt that session had open has resolved.** A
session parked awaiting a verdict cannot finish its turn, so a turn that ended is a session no longer
parked.

`PostToolUse` cannot serve. A subagent's tool calls fire it under the same process token, so a session
parked on a prompt while background agents work still emits it, and clearing on that would drop a
genuinely open prompt.

What separates the two is which events this project wires: `hooks/settings-fragment.json` declares
`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`, and **not**
`SubagentStop`. A subagent finishing therefore reaches the broker as nothing at all, while the
session's own turn ending reaches it as `Stop`.

That is load-bearing and it is a property of the fragment, not of the harness. Adding `SubagentStop`
to the fragment later would silently make this signal wrong, so the rule's own test pins the fragment
against it.

## What ships

**On `Stop` for a session, clear that session's open requests.** Only those opened before the `Stop`
arrived, so a prompt raised in the moment a stale `Stop` is in flight keeps its entry. Ordering is the
only guard needed and the fail direction chooses it: keeping an entry too long shows a wrong glyph,
clearing one too early parks a session in silence.

**When a session ends, clear its open requests.** A prompt whose session is gone can never be
answered and is holding a slot. This is the floor that covers a session which dies without a `Stop`.

**A cleared prompt's message is rewritten and its buttons stripped.** The broker knows the request
resolved and does not know how, so the message says it is no longer waiting and never names a verdict
it did not carry. Live buttons over a resolved request are the state that lets one tap claim an answer
the operator never gave.

## The fail direction, which is not negotiable

This surface may keep showing a session as waiting when it is not. It may never stop showing one that
is. A wrong glyph costs a glance; the other way parks a session with nobody able to answer it, which
is the failure this whole project exists to prevent.

Every judgement call in this section resolves that way.

## Gate

`npm test` stands at 1162 tests, 1161 pass, 1 skipped, 0 fail. The skip is the POSIX token-file
platform gate. `broker/tail.test.ts` carries a documented intermittent under load, recorded in
`docs/backlog.md`.

Tests must cover, at minimum: a `Stop` clears that session's entries and no other session's; an entry
opened after a `Stop` survives it; a session ending clears its entries; the cleared prompt is
rewritten with its components stripped; a cleared entry frees its slot against the 64 ceiling; and the
fragment declares no `SubagentStop`, so the signal's premise fails loudly if that changes.

What no test can settle: that a real console-answered prompt clears within a refresh tick, and that
the thread stops reading `needs you` for a session that is working.

## Sections

### Section 1: the clearing rule

`Stop` and session end both clear, with the ordering guard.

### Section 2: the message the operator is left with

The rewrite and the component strip, saying only what is known.

## Chapters

### Chapter 1: both sections

`Stop` clears through a `turnEnded(sessionId, at)` verb on the desk, called from the credited-event
path in `broker/intake.ts` under the gate the tail seam already uses: the payload must name the very
session the post was credited to, so a `Stop` carrying no session id clears nothing and waits for the
sweep. The timestamp is read before the request body is consumed, and the compare is strict, so a
prompt raised while that post was still being read keeps its entry. Both choices are the fail
direction picking the answer.

Session end clears through `sweepEnded()` on the existing sweep interval, and it clears only records
in the registry's `ended` state, never `stale`. That distinction is load-bearing rather than
cosmetic: a stale record is revivable, since a pipe reattaching puts it straight back to live, so
clearing on stale would drop a genuinely open prompt from a session whose connection hiccupped. Ended
is terminal. The sweep runs on an interval rather than at the mutation sites because ending is a
registry state rather than an event the desk can hear, so one caller covers every road into it.

The message a cleared prompt is rewritten to is a sibling of the answered one rather than an
extension of it. Threading a nullable verdict through the existing renderer is exactly how a verdict
gets named by accident, and the broker knows only that the request resolved, never how. The sibling
carries no verdict vocabulary at all.

Six probes were watched red before their fixes, including one that matters more than it looks: a turn
ending between a prompt's post landing and its controls edit going up. The guard that the entry is
still the one the attach began for is what stops buttons being drawn over a request already let go,
and removing it turns that test red.

Two known gaps, both chosen in the safe direction. A clear landing while the prompt's post is still
on the wire leaves the text unrewritten, because there is no message handle yet, but it leaves no
buttons either, which is the half that can be acted on. And an entry whose session record has been
pruned entirely is not cleared, since only `ended` clears.

### What is still open

One live check, which no test can settle: a real console-answered prompt clearing within a refresh
tick, and the thread ceasing to read `needs you` for a session that is working.
