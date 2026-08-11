# Answering a permission prompt from the thread

Status: In Progress
Commit model: Review-Only (commit when the operator asks)

## Why

A permission prompt already reaches the phone and already carries the line that answers it: `Reply
`y qwtrb` to allow or `n qwtrb` to deny`. In live use that line did not read as an instruction. The
five-letter request ID read as corruption in the message, so the operator walked to the console
instead, which is the walk this project exists to remove.

The mechanism was sound and unusable. That is a message-design failure, and a button is the fix.

## What is already built

Nothing here needs new architecture. The question-answering round built every piece:

- The permission desk already holds each request open in a table keyed by thread and request ID, and
  `resolve(threadId, verdict)` already delivers the verdict over the relay. The text path is simply
  the only caller of it today.
- The interaction router already exists, already applies the sender gate before anything else, and
  already treats a `custom_id` as a reference and never as evidence.
- `writer.alert` returns the ID its post landed under, and `writer.edit` takes components on a
  separate Discord rate bucket from the post, so attaching controls after the fact costs nothing the
  prompt budget was holding.

So this round is wiring, and its risk lives in two places: what a stale button can do, and what the
open-request table forgets to forget.

## Section 1: the buttons, built and reviewed

Post the prompt as it posts today, then edit it to carry **Deny** and **Allow**. A press routes
through the existing interaction router to the permission desk's `resolve`, and the message is
rewritten to show what was answered, with its components stripped.

Deny is styled danger and Allow secondary rather than primary, so the button a thumb lands on by
default is not the one that grants.

### The stale-button hazard, and why stripping is not sufficient

A request ID is five letters, and the desk's own comment says it is short enough to repeat across
sessions on one host. `resolve` matches on thread and ID alone. So a prompt is answered, a later
prompt in the same thread draws the same ID, and a tap on the **old** message still in scrollback
approves the new tool.

Stripping the components on resolve is the obvious answer and it is not enough on its own, because
the strip is a Discord edit and an edit can be refused. A refused edit leaves live buttons on an
answered message, which is exactly the state the hazard needs.

So the reference carries a nonce. Each open request stores an opaque nonce alongside its message ID,
the `custom_id` carries it, and a press whose nonce does not match what the desk holds resolves to
nothing. That makes the recycled-ID case structurally impossible rather than dependent on an edit
having succeeded. Stripping stays, because a dead button that reports a failure is still worse than
no button, but it is now the courtesy rather than the control.

## Section 2: a measurement, not a decision. Instrument built, reading outstanding

A prompt answered at the console is never cleared from the desk. The entry is removed only inside
`resolve`, expiry by age was deliberately rejected, and the channel protocol as this repository
implements it carries no "answered elsewhere" notification for the broker to hear. Attention outranks
working in the state machine, so that session renders `needs you` until it ends or the broker
restarts. This is confirmed both by reading the code and by the operator watching a thread stay
`needs you` after answering at the keyboard.

What is **not** known is whether Claude Code sends anything at all when a prompt is resolved
elsewhere. The relay registers a handler for the one notification it expects and nothing observes
what else may arrive. If such a notification exists, it is the correct fix and every alternative below
is a workaround.

So this section is one cheap instrument rather than a design: a fallback notification handler on the
relay's server that logs the **method name** of any notification the relay does not already handle.
Method names only, never params, holding the rule that conversation content never reaches the log.

Then one console-answered prompt settles it.

## Section 3: the clearing rule

Designed from what Section 2 finds, with one floor that is correct regardless: **a session's open
requests are cleared when the session ends.** A prompt whose session is gone can never be answered
and is holding a slot.

If Section 2 finds no notification, the fallback needs care, and the obvious candidate is wrong.
"Any later hook traffic from that session means it is no longer parked" is unsound here: a session
parked on a permission prompt can still have background subagents running, and those fire hooks under
the same process token. Clearing on that signal would drop a genuinely open prompt and report a
parked session as fine, which is precisely the failure this project exists to prevent. The fail
direction has to stay "still shows as waiting when it is not" rather than "stops showing as waiting
when it is".

## Gate

`npm test` stood at 1117 tests, 1116 pass, 1 skipped, 0 fail when this round opened. It stands at
1139, 1138 pass, 1 skipped, 0 fail with Sections 1 and 2 built. The skip is the POSIX token-file
platform gate.

One caution for anyone reading a red on this tree. `broker/tail.test.ts` carries a pre-existing
intermittent failure inside its `until` helper, on a different test each time and only under machine
load. It is recorded in `docs/backlog.md` with its measurements and with the reason the obvious fix
is a trap. A single failure there is not this round's; anything else is.

Two behaviours cannot be established from code and need the operator: a real button press answering a
real prompt, and the Section 2 measurement.

## Chapters

### Chapter 1: Section 1, and what two reviewers found

The buttons went in as specified, with the nonce as the control rather than the component strip. Both
reviewers confirmed independently that the nonce closes the recycled-request-ID hazard, and the
security pass found no Critical and no Major: the gate is genuinely in front of the new path, the
thread comes from the interaction and never from the wire, the nonce is CSPRNG-minted and actually
checked, and both new render surfaces neutralize.

Two findings converged across both reviewers, which is what made them worth acting on rather than
arguing about.

The first was ordering. The press was acknowledged only after the verdict's Discord writes had
completed, against a three-second callback window, so the operator could see "This interaction
failed" over a tool that was in fact allowed and already running. The question path had solved this
already and said so in a comment; this branch had diverged from a settled local pattern without
stating why. `resolve` is now synchronous: the lookup, the nonce check, the delete, and the relay
delivery all complete before the callback, and the notice and the prompt rewrite run detached behind
a `settled()` promise that exists for tests.

The second was that the nonce parameter was optional and its guard skipped the check when absent. Both
callers were correct, so nothing was broken; the defect was that a future component-bearing caller
would lose the control silently, with no type error. Making it a required nullable turned thirteen
existing call sites red, which is precisely the silence that was being relied on.

Three more came from the adversarial pass alone: a rate-limit timestamp read before an await and used
after it, so a 429 was recorded as expiring early; a missing test on the budget guard for the one
press that grants a tool, where the equivalent question-path guarantee was already pinned; and a
check-then-act window in `request` that the attach edit had widened across two round trips, which two
concurrent requests for one prompt could have crossed.

Two comments were rewritten because they asserted properties the code does not have. One claimed the
entry is inserted before the attach so a press arriving mid-attach finds it, which cannot happen since
no button exists until the attach lands. The ordering is right for reasons the comment did not state:
the re-send dedupe, and a nonce a second request would otherwise overwrite. In this codebase a comment
naming a property is a claim, so the sweep for the same claim in other words was part of the fix.

One judgment call the spec had not covered, kept: a verdict applied but delivered nowhere draws
"Allowed, not delivered" rather than a tick. A tick would report that a tool ran when nothing did,
which is the direction this surface is never allowed to fail in.

### Chapter 2: Section 2, and a cheaper instrument than planned

The measurement was going to report through a new authenticated broker route, on the assumption that
the relay's stderr was unreadable. Checking that assumption removed the route.

Claude Code captures an MCP server's stderr to disk, one directory per project and one file per
session, under `%LOCALAPPDATA%\claude-cli-nodejs\Cache\`. A relay line lands there as
`{"error":"Server stderr: relay: ..."}`. So the instrument is a `process.stderr.write` and nothing
else: no new route, no new authenticated surface, nothing for a security pass to weigh.

The same file also carries Claude Code's own `debug` line per notification it receives from the
relay, which makes it a readable trace of one session's channel protocol. That is worth knowing for
its own sake, and it sharpened this design: those lines cover only the relay-to-Claude direction, so
an absent line without a relay-side handler would have proved nothing about what Claude Code sends.
Reading a null result as an answer was the trap here, and the handler is what avoids it.

`unhandledNotifications` names each distinct unclaimed method once, bounded in length and in count,
and writes the method and nothing else: a notification's params carry conversation content and this
line goes to disk. It is exported and injected with its writer so the test drives the same code the
relay runs.

The test delivers a real notification across a real transport rather than calling the handler,
because the load-bearing assumption is that the SDK routes an unregistered method to the fallback at
all. It does, and that is now confirmed by a passing test rather than inferred from the type. A
handler never reached would have produced an absent line reading exactly like a protocol that says
nothing, which is the same trap in a second place.
