# Channels: mirror fidelity repairs

Status: In Progress
Commit Model: Commit-and-Push
Fable Spend: fable-tier sections and the reviewer bumps, dispatched with the explicit override from this Opus-led session; overage onto usage credits approved 2026-08-09
Created: 2026-08-09

## Related

- [channels_question-answering_spec_v1.md](channels_question-answering_spec_v1.md): the round whose
  live walk surfaced the multi-select join difference in Section 2 below.

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

### 6. A mirrored table becomes an aligned block

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

### 7. Docs and live verify

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
