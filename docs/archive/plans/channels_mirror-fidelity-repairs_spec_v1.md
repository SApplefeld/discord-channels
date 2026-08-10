# Channels: mirror fidelity repairs

Status: Complete
Commit Model: Commit-and-Push
Fable Spend: fable-tier sections and the reviewer bumps, dispatched with the explicit override from this Opus-led session; overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the round whose
  live walk surfaced the multi-select join difference in Section 2 below.
- [channels_usage-card_spec_v1.md](channels_usage-card_spec_v1.md): the other concurrent round,
  whose card fields this round's redesign draws.

All three rounds write `broker/discord/render.ts`, so their commits interleave on one branch and
one finishing pass covers the three changesets together.

## Goal

The surfaces the operator reads most often become scannable and findable, and the one place a
thread answer still differs from a console answer stops differing. The cards the broker composes
itself, the session status card and the fleet usage card, put their tabular body in a fenced
monospace block so columns line up at a glance; the channel's pin list becomes the roster of what
is running, maintained by the broker as sessions start and exit; and a multi-select question
answered from the thread reaches the session in the same text the console's own answer produces. A
Markdown table the model wrote is the lower-priority last piece: the operator reads those with
effort today, where the cards are read at a glance many times a day.

## The measured ground

- **Discord renders no Markdown table.** The pipes and dashes arrive literally, which is
  unreadable on a phone. Fenced monospace and embeds are the two shapes that work; embeds render
  at most three fields across and are a separate payload from the content string every narration
  surface here edits, so the fence is the fit. A fence also draws no mention pill and no timestamp
  chip, confirmed by operator check E on a real host, so the conversion makes mirrored text more
  inert rather than less.
- **A multi-select answer's rendering depends on the surface that answered.** From one session's
  transcript carrying both paths for one question: the broker's array of labels reaches the model
  as `"Jalapeños,Mushrooms,Pepperoni"`, the console picker's own answer as
  `"Jalapeños, Mushrooms, Pepperoni"`. The array is the documented shape and it answers correctly;
  only the rendering differs.

## Sections of Work

### 1. The broker's own cards read as aligned blocks

Model: opus

The session status card and the fleet usage card put their tabular body inside a fenced monospace
block so their columns line up. These are the surfaces the operator reads constantly, and they are
composed by this codebase rather than by the model, so their shape is entirely ours to choose.

The shape is a hybrid, forced by what a fence does: Discord renders no Markdown inside one, so bold
and mention pills die there. The card's title line therefore stays outside the fence, carrying its
glyph, its name, and its state, and only the body moves inside. A card that carries a mention keeps
that mention outside the fence too.

Width is the binding constraint. A Discord code block scrolls horizontally on a phone rather than
wrapping, so a card wider than roughly the mid-forties of characters costs the operator a drag to
read, which is worse than the ragged lines it replaces. Columns are therefore abbreviated to fit a
declared width bound rather than padded to their natural width, and the bound lives in one place
both cards read.

Acceptance: each card renders its title outside a fence and its body inside one, with columns
aligned down the block; every card stays inside the declared width bound at its worst case (the
usage card at its account and per-model maximum, the status card with its longest tool preview);
no card body relies on Markdown that a fence would show literally; the usage card's byte-compare
change detection still spends no edit on an unchanged reading. Tests pin the width bound at each
card's worst case and pin that no emphasis syntax survives inside a body.

### 2. A thread answer joins the way the console joins

Model: sonnet

The question desk submits a multi-select answer as the labels joined with a comma and a space,
rather than as an array, so a session cannot tell which surface answered it. Single-select and
free-form answers are unchanged.

Acceptance: the submitted `updatedInput.answers` carries a joined string for a multi-select
question, pinned against the measured console text; single-select still carries a bare label and
free-form still replaces the map with `response`. The comma-in-a-label ambiguity this inherits
from the console's own format is recorded in the test's own words rather than guarded against.

### 3. The channel's pins are the live sessions

Model: opus

A session's card is pinned in the channel while that session is running and unpinned when it
exits, so the channel's pin list answers "what is running right now" without a scroll. The fleet
usage card is pinned too, permanently, since it is the one card that is always relevant.

**The route and the permission, both measured rather than assumed.** Pinning wants Discord's own
`PIN_MESSAGES` bit rather than `MANAGE_MESSAGES`: with Manage Messages alone the legacy route
answers `403 Missing Permissions` while the newer `PUT /channels/{id}/messages/pins/{message}`
answers 204, and with Pin Messages alone both answer 204. Use the newer route, and have the install
ask for Pin Messages as a channel-level overwrite. Reads need neither grant.

**A thread's starter message cannot be pinned inside its own thread**, measured on both routes and
both permissions: it answers `400 Unknown Message`, because the starter belongs to the parent
channel even though clients draw it at the top of the thread. So the pin lives in the channel,
where the thread list lives, which is also where it answers the question the operator actually
asked.

**The section ships dark on a host that has not granted the permission, and that is not a fallback,
it is the shape.** A refused pin is logged once per reason through the repeat limiter and changes
nothing else: the card, the thread, and every other surface behave exactly as they do now. Nothing
about this section may make a host without the permission worse than it is today.

**Reconcile rather than track.** On startup and whenever the registry's live set changes, read the
channel's pins and drive it toward the intended set: pin a live session's card that is not pinned,
unpin a card whose session has exited or whose binding is gone. Reconciling from Discord's own
answer is what survives a broker restart, a pin the operator added by hand, and a card rebuilt
after a 404, none of which a broker-side flag would survive.

**Two costs to hold, both from Discord rather than from us.** A channel takes at most 50 pins, so
the reconcile needs a policy at the ceiling: oldest live pins are kept, the newest arrivals go
unpinned, and the shortfall is logged once, because dropping an older session to make room would
unpin something the operator may be watching. And pinning writes a system line into the channel,
one per pin, so a host starting many sessions pays a line per session; unpinning writes nothing.
That cost is named here so it is a decision rather than a surprise.

Acceptance: with the permission absent, every pin call is refused, one log line names it, and no
other behavior changes; with it granted, a live session's card is pinned, an exited session's is
unpinned, the fleet card stays pinned, and a broker restart converges the pin list to the live set
without duplicating or dropping. Tests drive a fake transport for the permission-refused path both
directions, the reconcile from a divergent starting list, the 50-pin ceiling, and the exit
transition.

### 4. An exited session's thread archives itself, by default

Model: opus

A thread whose session has exited leaves the active list on its own, so the channel reads as what
is running rather than as everything that ever ran. The capability already exists behind
`CHANNEL_DISCORD_ARCHIVE_ON_END` and is off unless a host sets it; this section makes it the
default and makes the setting survive an install.

**Archiving rather than deleting is the whole point.** An archived thread is not destroyed: it
stays readable and searchable, and a post revives it. That matters because a session that exits
wrongly is exactly the one worth reading afterward, and because reading old threads is how this
project has repeatedly established what actually happened. Deletion would trade a recoverable
record for a tidier list.

**Default on, with an explicit off, matching the mirror switch's own idiom.** The absent setting
means archive, and only the recognized off vocabulary disables it, so a new host gets the behavior
without configuring anything and a host that wants threads left alone says so once.

**Three things must not silently break under the new default**, each with its own test: the fleet
usage card's thread is never archived, since it is permanent and belongs to a different owner than
the session surface; an archived thread cannot be renamed, so the archive stays the last write for
a session and no later rename is attempted against it; and a thread that revives because something
posts into it is not re-archived until its session exits again.

**A startup reconcile catches what the old default left behind.** Hosts carry exited sessions whose
threads were never archived, so the surface archives any bound thread whose session has already
exited, once, rather than only acting on the live transition.

**The install stops clobbering operator settings.** `broker.env` is rewritten from a fixed key list
today, so a hand-set knob vanishes at the next install with no signal. The writer merges instead:
keys already in the file that are on the installer's own environment allowlist are preserved, and
the allowlist is what bounds this, since it already governs everything the broker will export.
Without this the default is the only reachable behavior, because turning it off would not survive.

**The two flag parsers stop disagreeing.** One accepts `1`, `true`, `yes`; the other also accepts
`on` and `off`. A host writing `on` for a setting the first parser reads gets a silent false. Both
read one shared vocabulary, which is this codebase's own recurring defect shape (two components
each correct alone, disagreeing at the seam) closed at the seam.

Acceptance: a host with no setting archives an exited session's thread; the recognized off
vocabulary disables it and survives a reinstall; `on` and `true` mean the same thing to every
reader; the fleet card's thread is never archived; a rename is never attempted against an archived
thread; and a startup pass archives already-exited threads exactly once. Tests cover each direction
including the reinstall-preserves-off case against a real temp env file.

### 5. The card says what the session is trying to finish

Model: opus

A session running under a completion goal shows that goal on its card, so the thread answers what a
long quiet stretch is *for* rather than only that it is busy.

**The reading is confirmed.** A slash command lands in the transcript as a user-type line carrying
`<command-name>` and `<command-args>` markup; `/goal`, `/model`, and `/rename` were all found that
way in a live transcript, with the goal's full text in its args. The tailer's line reader gains an
allowlisted yield for it, admitting `/goal` alone: an allowlist rather than a sweep of every
command, because a command's args are operator prose and most of them are nobody's business on a
shared surface.

**Knowing it ended is the hard half, and the design routes around it rather than guessing.** A goal
set is observable; a goal cleared may not be, since one that auto-clears on completion need not
write anything. So the card does not try to detect the end. It shows the goal while the session is
working, and drops it the moment the session reads idle or exited, on the reasoning that a goal
being met is precisely what lets a session stop. An explicit `/goal clear` clears it immediately
when it does appear. The failure this avoids is a card that displays a finished goal indefinitely,
which is worse than no goal line at all because it reads as current.

**Bounded like every other transcript-sourced field:** the text is cut to a line's worth with the
existing ellipsis helper, neutralized with the same escaper every card field uses, and never
logged. A session with no goal renders exactly as it does today.

Acceptance: a session under a goal shows it on the card while working and drops it on idle or
exited; `/goal clear` clears it at once; a session that never set one renders unchanged; a goal
longer than the line bound is cut rather than wrapping; a crafted goal text cannot manufacture a
mention pill, a chip, or markdown. Tests cover each direction, including the drop-on-idle rule that
substitutes for an unobservable clear.

### 6. A long reply cannot post twice

Model: opus

The turn's closing text reached the operator's thread twice, whole, once from the Stop mirror and
once from the tailer. Confirmed from a live host's log rather than reasoned: no partial-run line and
no dedup drop line exists anywhere in the window, so neither path suppressed the other and both
posted.

**The window is the cause.** Both paths record their echo digest only after a successful post, and a
long reply posts as several paced messages, so the recording lands seconds after the check. The
tailer polls, finds no digest, and begins posting; the mirror arrives mid-flight, finds no digest
because the tailer has not finished, and posts its own copy. Discord's own timestamps show the
mirror first, which is the opposite of the order the checks ran in, and is why the shape is hard to
read from the outside.

**Record-on-sent is not simply wrong, which is the trap.** It exists so a refused post cannot poison
the memory and leave the reply appearing nowhere at all, and that reasoning holds for a single short
message where the window is milliseconds. It stops holding for the most expensive message of the
turn, where the window is seconds wide.

So close the window without reintroducing the poison: reserve the digest when a delivery is
dispatched, so the other path sees a claim rather than a gap, and release the reservation if the run
lands nothing at all, so the text is still owed to whichever path can post it. A run that lands
anything keeps the digest, since the operator has the text. Where a path skips because of a
reservation it reports the same outcome it reports today for a match, because the text is on its way
by the other route.

Acceptance: two paths racing over one long reply post it once, whichever checks first; a run that
lands nothing releases its claim and the other path posts; a run that lands part of a reply keeps
its claim and is not duplicated; and the existing orderings the echo memory already handles keep
their current behavior. Tests drive both orderings with a delivery that resolves slowly, which is
the shape no current test has, plus the zero-landed release both ways.

### 7. A mirrored table becomes an aligned block

Model: opus

Lower priority than the two above, and explicitly so: the operator reads a model-authored table
with effort today, where the cards are read at a glance many times a day. Build this last, and only
after Sections 1 and 2 are live.

A GFM table in mirrored conversation text renders as a fenced block with the columns padded to a
common width, in the render layer beside the existing neutralizers, so every mirrored surface
inherits it (narration chunks, the reply tool's answers, the Stop mirror).

What the transform owes:

- **Recognize a table only when the whole shape is there** (a header row, a delimiter row of
  dashes and optional colons, and at least one body row), on the codebase's own rule that what a
  block is gets decided from the whole block before it is bounded. A ragged, malformed, or
  header-only table is left exactly as today's text.
- **Leave fenced content alone.** A table inside an existing code fence is already monospace and
  must not be re-wrapped, and the transform must not open a fence inside one.
- **Fit a phone.** Columns pad to the widest cell, capped so the rendered width stays inside a
  bound the module owns; a cell past its column's cap is cut with the existing ellipsis helper,
  and a table whose natural width exceeds the bound drops to the widest fit rather than
  overflowing. Cell content is bounded and neutralized before padding, never after.
- **Respect the message ceiling.** A table that cannot fit the ceiling falls back to today's raw
  text rather than being silently truncated into a shape that reads as complete.
- **Alignment markers** (`:---`, `---:`, `:---:`) are honored when present and default to left.

Acceptance: a three-column table mirrors as one fenced block whose columns line up; a table inside
a fence is untouched; a malformed table is untouched; a wide table stays inside the width bound
with cut cells; a table that cannot fit the message ceiling mirrors as raw text; no mention pill
or chip can be manufactured by cell content. Tests lock each of those directions and pin the
escaping order (neutralize, then pad).

### 8. Docs and live verify

Model: opus
Locus: inline

`docs/operations.md` gains how to read a card's fenced body, what the channel's pin list means, what archiving on exit does and how to turn
it off, what a host without the pin permission sees instead, and what a mirrored table looks like;
`docs/install.md` gains Pin Messages as the optional grant the pin list needs, scoped to the
broker's channel rather than the server, and says plainly what it also permits;
`docs/architecture.md` names the width bound the cards share, the pin reconcile, and the transform
in the mirroring path. Live verify: read both cards on a phone and confirm no horizontal drag is
needed, watch a session start and exit and confirm the pin list follows it, answer a multi-select
question from the thread and confirm the session reports the labels comma-space joined, and mirror
a turn carrying a table.

## Out of Scope

- Embeds, for the reasons in the measured ground.
- Any table the model did not write: this repairs mirrored conversation text, not the status card
  or the question message, both of which compose their own lines.

## Operator Verification

- Both cards read on the phone with their columns lined up and no horizontal drag, at a fleet
  carrying several accounts and several live sessions. A card that needs dragging reopens
  Section 1's width bound.
- Pin Messages granted on the broker's channel, then: the pin list holds exactly the sessions
  that are running, a session exiting drops out of it, and the fleet card stays. Before the grant,
  the only visible difference from today is one log line.
- An exited session's thread leaves the active list on its own, and is still readable when opened.
- A multi-select answered from the thread reports the same text a console answer reports.
- A turn carrying a table reads as an aligned block on the phone, with no horizontal drag at three
  columns. Overflow at more columns is acceptable and expected.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-08-09
Completed: Section 1: The broker's own cards read as aligned blocks
Implemented By: implementer-opus (build round), implementer-fable (review-fix round, dispatched
with the explicit override this Opus-led session's spend header authorizes)
Metrics: 1 review round (adversarial at fable via the one-tier bump, security at its default; no
blind pass, the change is a rendering shape with no new inbound surface) plus the fix round's
red-first evidence; 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: moving a card body inside a fence created a security surface that did not
exist before, which is why this section drew a security review at all: untrusted text inside a
block can close the block, after which everything following renders as live markdown. It holds,
and it was proven rather than argued, by enumerating every untrusted field that reaches a body and
then driving a hostile cast through the real renderer (two hundred backticks, a literal triple
backtick, a mention and a timestamp chip in every field, sixteen accounts and forty sessions),
which composed exactly two fence delimiters with no adjacent backticks anywhere.
That same property then constrained the round's own fidelity fix, and the tension is worth
recording because the next person to tidy this will feel the pull. The full markdown escaper was
still running on text a fence renders none of, so a realistic tool name drew with six literal
backslashes and burned double width per escaped character. The obvious simplification, stop
escaping inside a fence, would reopen the breakout: the backtick and backslash escapes are exactly
what make two adjacent backticks impossible to compose. The fix is a fence-aware neutralizer that
drops the characters a fence ignores and keeps those two plus the invisible strip, and the
breakout is now pinned directly in both cards rather than resting on the reasoning.
The adversarial reviewer caught the round's own worst habit: a pin that would have caught a real
defect had been rewritten to match the new output. The roster's whole-entry rule was pinned by a
two-blank-task card; the rewrite split it into two single-task cards, which is precisely the shape
that cannot expose the defect, and the defect was live (an entry named by its kind ignored the
width budget, so two of them cut mid-parenthesis with no overflow count). The pin is restored on
the original input shape.
Two attacker-shaped findings from security, neither obvious: a long tool name silently removed the
input preview, and both the name and the input are attacker-influenceable, so a session could hide
what its tools were called with by naming the tool long; and the session id was sliced after
escaping, so eight code points could be four real characters and two sessions could be made to
show the same prefix on the surface the operator uses to tell threads apart.
Decisions the orchestrator made rather than deferring: the width bound stays at 46 and the roster
keeps its one-named-entry-plus-count shape, because the approved sample that conflicts with the
bound was drawn with artificially short task descriptions and real ones exceed thirty characters
alone, so two whole entries fit at no width a phone reads without dragging. The bound remains a
single constant so the live walk can overrule it. Accepted from the implementer: the downgrade
marker splits across two rows rather than being cut, since one row would have dropped the opening
model and the refusal category, both recorded elsewhere as load-bearing; the session id shows eight
characters, which is the one affordance this change costs, since the full id existed on no other
Discord surface and is what a resume takes; and the context size rounds in its rendering while the
record keeps the exact figure.
Operator requests folded into the same round: money renders as money (`$95.40 of $1,500`), grouped
and symboled by hand rather than through a locale-dependent formatter, because the fleet card edits
only when its bytes change and a locale that groups differently would both misread and defeat that.
The operator also asked what an Opus row was doing on the fleet card; it was an implementer fixture
inventing a second scoped window, and the live cache carries exactly one per account, so nothing
was wrong and nothing changed.
Review Findings: adversarial CHANGES_REQUIRED (4 Major, 3 Minor); security CONCERNS (0 Critical,
3 Minor). All items implemented, items 1 to 4 red-first, plus the operator's money formatting. The
implementer corrected one claim in the brief rather than implementing it as written: a newline is
stopped by the invisible strip rather than by the whitespace collapse, same guarantee by a
different mechanism, and the comments now state the accurate one.
Named check riding to Section 7's live verify: the width bound counts code points while a
glyph-led line can draw one column wider, so a card may need a horizontal drag on a real phone
that no test can see. One constant settles it.
Stamps: none surfaced at this boundary
Next: Section 2: A thread answer joins the way the console joins
Commit Model: Commit-and-Push

### Chapter 2 - 2026-08-09
Completed: Section 2: A thread answer joins the way the console joins, and Section 3: The channel's
pins are the live sessions
Implemented By: implementer-opus (both sections in one round; they touch disjoint files)
Metrics: 0 review rounds so far (the round carried red-first evidence for both; the finishing pass
covers the changeset); 0 NEEDS_CONTEXT; 0 escalations; advisor off
Decisions / Surprises: the pin work needed no discovery, because every fact it rests on was
measured against the live channel before the section was written: the newer message-scoped route,
the legacy route's misleading refusal, the impossibility of pinning a thread's starter inside its
own thread, and both Discord ceilings. That is the difference between a section that builds and one
that investigates, and it is worth noting how cheap the measuring was compared to the review round
it would otherwise have cost.
The reconcile drives the channel's pins toward the intended set by reading Discord's own answer
rather than trusting a flag, which is what survives a restart, a hand-made pin, and a card rebuilt
after a deletion. A converged channel spends nothing, pinned by a test that runs two identical
passes and asserts zero calls, which is what keeps a system message per pin from becoming a system
message per tick.
Two consequences the implementer named rather than buried. The full sweep unpins anything pinned
that is not in the intended set, which is the only rule that can unpin a card whose binding is gone
but which also removes a pin the operator added by hand; that is being narrowed in the following
round to sweep only messages the broker recognizes as its own cards. And Section 2's join moved a
bound: the thread's answered-from-the-thread message bounded each label at a hundred characters and
now bounds the whole joined list at the same number, so three realistic labels would ellipsize
where they did not before, which the same round corrects.
Review Findings: none yet; the finishing pass covers both sections.
Named check riding to Section 7's live verify: the pin keeper's wiring is chained after the
surface's own tick and nothing exercises that ordering in a test, so a session starting and exiting
against the real channel is what settles it.
Stamps: none surfaced at this boundary
Next: the card's own redesign, which the operator specified against a live screenshot, then
Section 4
Commit Model: Commit-and-Push

### Chapter 3 - 2026-08-09
Completed: the session card's redesign, specified by the operator against a live screenshot, plus
two corrections the previous round surfaced
Implemented By: implementer-opus
Metrics: 0 review rounds so far (red-first evidence carried in-round; the finishing pass covers the
changeset); 0 NEEDS_CONTEXT; 0 escalations; advisor consulted by the implementer, and its one
flagged concern checked and found not to hold, which is recorded below
Decisions / Surprises: the operator reviewed the first fenced card against a real session and every
item they raised was a real defect rather than a preference. The roster line was spending its room
on the least informative field, rendering a fully truncated description beside a partially
truncated agent type, so it named neither the work nor the worker. The tool row was structurally
doomed in a label column, since a real path needs more room than the row has after the label, which
made the row read `(cut)` essentially always and therefore carry nothing. Both are now their own
fenced blocks under their own headers, which is the right fix rather than a workaround: the card is
a fixed label column, the roster is a repeating two-row entry, and the tool is one long string that
should wrap, and those three want different layouts.
The operator's two-row roster beats the single row for a reason worth keeping: at this width one
row forces the age, the type and the description to compete, and truncation reaches the description
first, which is the only field that says what the work is. Two rows remove the competition instead
of tuning who loses it, and vertical space is cheap on a surface already being scrolled.
Both optional blocks render `None` rather than being omitted, on the operator's own reasoning: an
omitted section cannot be told apart from a broken renderer.
Tokens were asked for and are not available. The harness's task table carries no usage figures, and
the per-agent output files that might have held them measured zero bytes for every agent a live
session was running, so nothing writes them down; the console shows them because it is the process
running the agents. Recorded so the question is not reopened.
Two corrections from the previous round landed here: the close-out message's answer bound, which
Section 2's join had quietly turned from a per-label ceiling into a whole-list ceiling, is now
derived from the per-label bound and the ask's own option count; and the pin sweep is narrowed to
messages the broker recognizes as its own cards, so an operator's hand-made pin survives, at the
stated cost that a card whose binding has been pruned can no longer be swept automatically.
Review Findings: none yet; the finishing pass covers this changeset. The implementer's own advisor
raised an unbounded-answer concern which it checked and refuted with a test rather than acting on,
and it found and fixed a real defect while writing that pin (the wrapping helper could split an
escape pair at a line end).
Open with the operator: the tool block still draws a Windows path with doubled backslashes, because
the fence-aware neutralizer keeps the backslash escape. Whether that escape is load-bearing inside
a fence depends on whether Discord processes escapes there at all, which is unobservable from the
server side; a probe message is posted in the operator's own thread and their reading of it decides
whether the escape can be dropped for paths.
Stamps: none surfaced at this boundary
Next: Section 4: An exited session's thread archives itself, by default
Commit Model: Commit-and-Push

### Chapter 4 - 2026-08-09
Completed: Sections 4 and 5 (archive by default, the goal on the card), the operator's card polish,
Sections 6 and 7 (the duplicate reply, the mirrored table), and Section 8's documentation. The
out-of-band Critical the operator's own probes uncovered landed with Sections 4 and 5.
Implemented By: implementer-opus across four rounds
Metrics: 0 formal review rounds on these sections, each round carrying red-first evidence; the
whole-effort finishing pass covers the changeset; 0 escalations
Decisions / Surprises: the round's most valuable work came from the operator rendering probes in a
real client, which is the one instrument this repository does not have. Three separate questions
that looked like design calls turned out to be measurements, and two of them contradicted what
inspection had concluded. Escaping does not protect a fence, because Discord resolves the escape
before it finds the delimiter; a longer opening fence is no alternative, because three backticks are
the whole delimiter and a fourth is content; and a heading parses directly under a paragraph line,
where a blank line before it adds margin on top of the margin Discord already gives a heading, so
the tighter spacing the operator asked for comes from having no blank line rather than from removing
one that was never there.
That fence finding is the effort's own recurring shape at the highest level of care available: the
code satisfied a property, the tests asserted the same property, a security review verified the code
against it, and a hostile-cast probe through the renderer confirmed it. All four agreed and all four
measured the same wrong thing, because the assumption that no adjacent backticks implies the fence
holds was never itself testable here. The tests now assert that no backtick reaches a fenced body at
all, which no wrong model of Discord can satisfy.
The duplicate reply was diagnosed from a live host's log by what was absent from it: no partial-run
line and no dedup drop line in the window, so neither path suppressed the other and both posted.
Record-on-sent was not wrong, which is why the fix keeps its reasoning: it exists so a refused post
cannot leave a reply appearing nowhere, and that holds for a short message where the window is
milliseconds rather than for the one message a turn that takes seconds to post.
Named risk, for the finishing reviewers rather than accepted here: claiming at dispatch narrows one
guarantee the old rule held. If one path claims, the other drops its own copy, and the claiming run
then lands nothing at all, the release restores the digest but the tailer's bytes are already past
its offset, so that text reaches the thread nowhere. It is strictly rarer than the duplicate it
fixes, since it needs a race and a total failure rather than a race alone, but its cost is the
worse direction for this codebase, and the reviewers should weigh whether the release should do more
than restore a digest.
Verification note, recorded rather than smoothed: one full-suite run reported a single failure whose
identity was not captured before it cleared, followed by six consecutive clean runs including two
with full output preserved. It is not reproduced and not identified, so it is not called a flake
here. Heavy concurrent load during the session is a plausible but unproven explanation, and the
finishing pass's QA run is instructed to capture any failure's output rather than only its count.
Review Findings: none formal on these sections; the finishing pass covers them.
Stamps: none surfaced at this boundary
Next: the whole-effort finishing pass
Commit Model: Commit-and-Push

### Chapter 5 - 2026-08-09 - close-out
Completed: the whole-effort finishing pass, run once over this round and the concurrent usage-card
round together, because all three of the day's rounds write `broker/discord/render.ts` and a
per-plan split would have handed each reviewer half the story of the same file. Base ref
`03772e3`, resolved by asking git which commit added each plan doc rather than by reading commit
subjects, which put it eight commits earlier than the subjects suggested and would otherwise have
hidden the usage cache reader from every reviewer.
Implemented By: two qa-verifier agents (one per plan), security-reviewer and adversarial-reviewer
at the fable tier per the Fable Spend header, three implementer agents on disjoint file sets, one
implementer for the follow-on quadratic, and docs-curator.
Metrics: suite 1094 tests, 1093 pass, 0 fail, 1 skip, exit 0, against a 1082/1081/0/1 baseline, so
+12 tests and no regressions. Typecheck exit 0 at every commit. 1 Critical, 6 Major, 3 Minor found
and all fixed here. 0 escalations.

QA on this plan returned FAIL, on Section 8: the table transform reached no documentation, because
the docs commit `52dd6f7` landed before the transform and the transform's own commit `2ca5a37`
touched no `docs/` file. Two named acceptance items were unmet with nothing to signal it. A green
suite cannot see that, and no per-section review would have either, since Section 8 was reviewed
while its claims were still true.

Decisions / Surprises: the effort's largest defect was invisible to both efforts that caused it.
The mirrored-table transform was quadratic over a run of pipe-carrying lines that never forms a
table, measured at 809ms for 4000 such lines, and it runs on untrusted model output on the broker's
only event loop. It passed every test and satisfied its spec line by line; it mattered only because
a different section's decision, that a mirrored reply is never truncated, sets the input size. A
second quadratic shape survived the first fix, found because parses went linear while wall time
kept quadrupling, which located the remaining cost downstream of parsing. Both are fixed and both
are pinned by gates that count work rather than measure wall time, since a timing assertion is
flaky on a loaded machine.

The claim-at-dispatch narrowing this round's Chapter 4 handed to the reviewers was real in both
orderings, and the answer was yes, the release should do more than restore a digest. The echo
memory now records that a match consumed a claim, and a zero-landed run whose claim had already
suppressed the other path re-takes the claim without yielding and runs once more.

The verification method worth keeping is the differential fuzz, and specifically what one
implementer did with it. Its first corpus reported zero output mismatches against the pre-fix
renderer, so it built a deliberately-wrong mutant of its own predicate and ran the same corpus
against it. The mutant also passed, proving the corpus could not tell right from wrong. It added
inputs straddling the refusal point, at which the mutant produced 340 mismatches and the real fix
still produced zero across 28680 comparisons. A green result from a test never shown able to go red
is not evidence, which is the same lesson the fence-escaping property taught this effort in
Chapter 4, learned there at the cost of four agreeing sources all measuring the same wrong thing.

Deviations recorded rather than reconciled: the retry converts a conditional duplicate into a
certain one in one case, where a transport loses the response after Discord has already created the
message. That case is a false zero-landed verdict today too, and today it duplicates by the other
path posting; the retry makes that duplicate deterministic rather than introducing a new class.
Reversal cost is one commit: drop the retry at the two release sites and keep the loud log line.
The retry also gives the run a fresh wait budget, so a rate-limited run plus its retry can hold a
thread's ordering chain for roughly twice `MAX_RUN_WAIT_MS`.

Chapter 3 recorded that both optional card blocks render `None` rather than being omitted, on the
operator's reasoning that an omitted section cannot be told from a broken renderer. The shipped code
omits them, on the later operator instruction, and the reversal was recorded nowhere until the
curation pass surfaced it. The docs already described the as-built behavior; this is the record.

Review Findings: QA FAIL on Section 8 (fixed here); security CONCERNS (0 Critical, 2 Major, 1
Minor, all fixed); adversarial CHANGES_REQUIRED (1 Critical, 3 Major, 2 Minor, all fixed). Neither
reviewer contradicted the other. Two findings were corrections to my own prose: the security model
named a width-derived mechanism for the card's field cuts that does not exist, and my brief to one
implementer named a pin-budget formula that, taken literally, would have made the channel thrash.
That implementer implemented the intent instead and said so.
Operator-pending: carried to `docs/backlog.md` so they survive the archive, and named in the
close-out status in the order they are run.
Stamps: none surfaced at this boundary
Next: none; the effort is complete
Commit Model: Commit-and-Push
