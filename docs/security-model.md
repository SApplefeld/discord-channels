# Security model

What this system trusts, what it does not, and the risks it accepts deliberately.

The short version: anything that can post to the broker can eventually put text in front of Claude,
so the intake is the main attack surface, and every field crossing it is data rather than
instruction. What standing a channel message then has with the model is a separate question,
settled by the relay's instructions and resting on the sender gate below.

## The trust boundary

The broker listens on `127.0.0.1` only, and three origin checks refuse a request before it reaches
the registry. They apply to the relay's routes as well as the hook intake, re-checked there rather
than shared, because those routes are composed in front of the intake and would otherwise be
reachable without either of the first two:

- **The socket peer must be loopback.** Binding to `127.0.0.1` already makes an off-box connection
  impossible; this is defense in depth against a future bind change or a proxy in front of the port.
- **The `Host` header must name a loopback address.** The peer check cannot cover DNS rebinding on
  its own: there the browser genuinely connects to `127.0.0.1`, so the peer is honest. What
  identifies the attack is that the page asked for `http://attacker.example:PORT/`, which is also
  what makes the browser treat the listener as same-origin and skip the preflight. The `Host` header
  is the only place that name survives.
- **The event name rides in a header that is not CORS-simple.** A browser must preflight to send
  `X-Channel-Hook-Event`, and this server answers no `OPTIONS` request. Adding an `OPTIONS` handler,
  or moving the event name into the body, removes that property silently.

Every route caps its request body, and what a route does past the cap is decided by who posts to it.
`POST /hook` and `POST /mirror` are posted by hooks that fire in every Claude Code session on the
machine, so an oversized body on either is drained and answered 2xx rather than refused: Claude Code
surfaces a non-2xx hook response as a visible error inside that session, at the end of exactly its
longest turns. The two differ only in ceiling. `/hook` holds `CHANNEL_MAX_BODY_BYTES`, 64 KB by
default, and `/mirror` carries a conversation, so it holds `CHANNEL_MIRROR_MAX_BYTES`, 256 KB by
default and bounded 64 KB to 4 MB. The relay's own routes have no watched session to disturb and
refuse an oversized body with a 413. The drain itself is bounded, so an endless body cannot hold a
connection open. Refusal logging is rate-limited by reason, so a local process cannot flood the log
with its own refused posts to push earlier evidence of the same behavior out through rotation.

`GET /sessions` withholds `processToken`, and the record is serialized field by field so that a
field added later has to be published deliberately rather than arriving on its own. That route
publishes the session's model reading beside the rest: the model producing its turns, the model it
opened with, its live context size, and the detail of a forced downgrade when one applies, each
named individually rather than spread from the record's own object. It publishes the session's
background-task roster the same way, entry by entry: the harness's own table of the subagents and
background commands a session is waiting on, each carrying an id, a kind, and a description the
model wrote. The card draws less of both than this route publishes: the intake keeps 256 characters
of a description and of a tool-input preview and hands that much to this route, while the card cuts
a description at 60 and a preview at 100 and then tightens each again to whatever its own block
width leaves. The asymmetry runs in that direction on every field, so a card is never the wider
disclosure.
Those are model ids, a token
count, and upstream's own refusal category and consent answer, the same class as the tool-input
preview this route already carries and holding no conversation text. The route also publishes
`lastEngagementAt`, the timestamp of the last signal that a person or live work drove the session,
beside the `lastHookAt` it has always published. It is a bare millisecond timestamp with no
content, and what it adds over its neighbor is an operator-presence signal: engagement newer than
the hook stamp means a person typed at that moment. For a process running as the operator that is
free anyway, since the transcript carries the prompts themselves; for a second authenticated
account on the host, the class this model calls latent, it is new information, accepted because
the blocked-state derivation needs the field and the route's discipline is served by naming it
here.

## The process token authenticates reports, never instructions

`CHANNEL_PROCESS_TOKEN` is minted per launch by the wrapper and joins a hook post to one session. It
is set in the launching process's environment, so the session inherits it, **and so does every shell
subprocess its tools spawn.** A session can therefore read its own forgery key and post hook events
about itself.

This is an accepted risk, and mirroring sets its limit. A token holder can distort its own status:
mark itself working or idle, or end its own record. It can also **post arbitrary text into that
session's Discord thread as the mirror**, because the mirror route authenticates on the process token
alone. So a shell subprocess of a wrapped session can put words on the operator's phone that read as
the session's own prompts and replies. The token is withheld from `GET /sessions` for this reason,
and either mirror switch removes the text half of it: `CHANNEL_MIRROR=off` in `broker.env` for the
host, or `Enter-ClaudeSession -NoMirror` for one session.

**The per-session switch is advisory, and only the host-wide one is enforced.** `-NoMirror` travels
as a header the mirror hooks send, so it suppresses what the hooks post; a process holding the token
can post without that header and be mirrored from a session the operator marked no-mirror. That is
not a hole this switch could close, because such a process can already post arbitrary mirror content
under the paragraph above. The switch exists for the operator's privacy from their own session, not
as a defense against a process that holds the token. `CHANNEL_MIRROR=off` is decided at the broker
and holds against any poster.

The switch governs the transcript tailer too, and there it is advisory in exactly the same way and
for the same reason: the verdict is poster-supplied, so a process holding the token can post one
that arms narration. What differs is the default. The tailer reads nothing until a verdict says to,
where the mirror posts unless a verdict says not to, because the broker reads transcript content
itself and an absent signal there cannot be allowed to mean publish. See "The transcript is read,
not posted" below.

What neither switch reaches is the bounded tool-input preview on the status card, or the
background-task roster beside it. Both ride the identity-and-activity path rather than the mirror,
so a `-NoMirror` session still shows what its last tool was called with and what it is waiting on,
and both travel further than the card: they are fields of the session record, so they are written
to the registry snapshot on disk and published by `GET /sessions` alongside every other record
field. The preview's content is a shell command line, a file path, a URL, a search pattern, or a
tool's free-text description; the roster's is the description the model gave each subagent it
dispatched. Both are capped at 256 characters per field. A session the operator marked no-mirror
discloses that much of itself on all three surfaces.

That also makes an environment variable a privacy control surface, alongside the files below:
anything that can set `CHANNEL_SESSION_MIRROR` for a session influences whether that session is
mirrored, and anything that can set `CHANNEL_MIRROR` in the broker's own environment influences the
host.

No key stronger than the token is available to close this. The mirror hooks are `http` hooks whose
only credential is an environment variable Claude Code interpolates into a header, and any variable
the wrapper set would be inherited by exactly the subprocesses this describes.

**It is not standing to do anything inbound**, and three checks enforce that:

- **A `SessionStart` naming a session ID that another live token already holds is refused.** Session
  IDs are published by `GET /sessions` and are not secrets. Without this, a local process could mint
  a token, announce a running session's ID, and overwrite that record in place. Thread bindings key
  on session ID and persist, so the operator's messages would route to the forger and the forger's
  replies would land in the real thread as that session, while the real session went dark.
- **The first relay stream to claim a token holds it.** A second is refused rather than promoted, so
  a malicious package postinstall or fetched script cannot take over the operator-to-Claude channel
  by attaching its own pipe.
- **Each attachment is issued a reply key**, delivered only down that stream and stored nowhere the
  token holder can read. Every reply through the relay's reply tool must present it, so that path
  requires holding the pipe rather than merely knowing the token. The mirror route is the exception
  and is described above: it posts on the token alone, so the reply key bounds the reply tool, not
  the thread.

Holding a token has one further consequence, and it cuts the other way. **A `SessionStart` whose
source is `startup`, arriving under a token whose live session has a relay attached, is declined
rather than registered**: it is a subprocess of that session, since every process a wrapped session
spawns inherits the token, and registering it would end the parent, open a thread for the child, and
stop the parent being mirrored with nothing saying so. Every other source still supersedes, so a
`/clear` behaves as it always has.

The relay pipe is the precondition that keeps this from becoming a denial of service. A record
created by hook posts alone, which any process holding the token can do, has no pipe, so it does not
decline anything and the real session's announcement supersedes it. What remains is the race the
paragraph below already accepts: a process that attaches a pipe before the genuine relay does holds
the token under first-pipe-wins, and its record is protected like any other.

The residual is a race: a local process that attaches a stream *before* the relay does holds the
token and its key until that pipe closes. Nothing detects it, and the operator's only signal is a
session whose status card keeps ticking while its answers read wrong. Closing it would need the
broker to learn the relay's process identity, which the channel protocol does not carry.

Since that process can also issue permission prompts, the residual is now phishing as well as
impersonation: it can ring the phone with an approval request carrying a tool name, description and
input of its choosing. It cannot escalate to approving a *real* pending call, because holding the
pipe means the genuine relay was refused and there are no real prompts to answer. Volume is damped
per thread: past **3 prompts a minute** the message still arrives and is still answerable but stops
mentioning the operator, and only past **12 a minute** is a prompt dropped. The ping stops; the
session does not park. The split is deliberate, because a single ceiling that drops prompts would let
a local process park every session on the host by spending it first, turning phishing into denial.

## The transcript is read, not posted

Everything above describes content that reaches Discord because a session posted it. The transcript
tailer is the one stream that reaches Discord because the broker went and read it. Two things the
console shows are carried by no hook payload: the text a model writes between tool calls, and a
message the operator types while the model is mid-turn, which the harness queues and injects without
firing the hook the mirror rides. So `broker/tail.ts` polls the session's own transcript file, the
JSONL Claude Code appends beside every session, and publishes both, plus a third yield: an
`AskUserQuestion` `tool_use` line becomes an open-question alert. That third yield is a fallback.
The question's timely signal is a `PreToolUse` hook post on `/hook`, matched to `AskUserQuestion`
alone, whose payload carries the question's conversation text and whose entry therefore carries
the per-session mirror switch header; the intake reads that header exactly as `/mirror` reads a
verdict, hands the bounded parse to the tailer's question seam, and the seam alerts only a
session whose mirror-on verdict it holds. The transcript line for an open question is written
only at resolution, which is why the emission-time hook post is the one signal that exists while
the operator can still act on it.

One further yield is a recovery rather than a gap. The prompt that opens a turn is carried by a hook
payload, but that hook is one the CLI abandons when a saturated host makes the broker answer late,
and a prompt lost before the broker accepts the post would be lost permanently on the hook path
alone. So the tailer reads that
prompt off the transcript as well, which moves a line the mirror hook normally supplies onto a path
where the file is the only authority for it.

That inverts the direction a mirror switch has to fail in, and the design accounts for it.
Everywhere else, suppression means the hooks post nothing, so an absent signal means absent content.
Here an absent signal would mean the broker reads and publishes anyway. **So the tailer reads
nothing until it is armed.** A session's transcript is not opened at all until an explicit
mirror-on verdict has arrived for that session under the current broker process, which every
`/mirror` post from a live session carries, and that names that very session: a post naming another
session or naming none is a subprocess mirroring a conversation of its own, which the router already
refuses to post, and it is not this session's verdict to give. A session launched `-NoMirror` is
never armed by its own traffic under any ordering, a broker restarted mid-turn narrates nothing for
the remainder of that turn, and a transcript path learned without an accompanying verdict is a path
that is never read.

The two halves of the verdict take deliberately different evidence, and both routes that carry a
verdict hold the same split. Suppression is recorded on the process token alone, before the
request body is read, because failing closed on weak evidence costs some narration. Permission
requires the payload to name the session the token holds, and on the `PreToolUse` route the
question itself sits behind that same gate rather than behind the token alone: the CLI retries a
refused hook post for hours, so a retry can outlive the session that emitted it, and a post
credited by token alone would otherwise put a predecessor session's question into the thread of
whatever session holds the token now. A process that holds the token can still supply the naming,
which is what keeps this advisory rather than enforced.

**What the tailer extracts is decided by an allowlist, never by a denylist.** The transcript belongs
to another program and can grow line shapes without notice, so a line yields something only by
matching one of ten named shapes whole: an assistant line's `text` content block; an attachment
whose type is `queued_command`, whose mode is `prompt`, whose origin kind is `human`, and whose
prompt is a non-empty string; an attachment of that same type whose structured origin kind is
instead `peer`, which yields the message another session sent this one, read from the origin's own
`body` and `name` fields rather than by parsing wrapper markup, and never from the `from` pipe
address, `msg_id`, `hopChain`, or `fromMode`, none of which is actionable from a thread; an
assistant line's `tool_use` block naming exactly `SendMessage`, whose `to`, `summary`, and
`message` yield the message this session sent, the duplicate aliases the harness carries beside
them read by nobody; an assistant line's `tool_use` block naming exactly
`AskUserQuestion`, whose bounded reading (at most 4 questions and 4 option labels, each readable
only as a non-empty string once invisibles are stripped) becomes the open-question alert; an
assistant line's own model name and the usage figures that sum to a context size; a structured
model-fallback record, whose subtype is read through an own-property check so a prototype key names
no cause; a `user` line whose console-command markup names exactly `/goal`, whose argument becomes
the goal line; a `custom-title` line, whose `customTitle` field is refused outright if it is
ill-formed and otherwise stripped, cleaned and cut into the session's own title, and which yields
no item at all rather than a null when nothing readable survives that; and a `user` line whose
`promptSource` is `typed` and whose root `origin` kind is `human`, carrying no `isMeta` stamped
`true`, no closed `<command-name>`/`</command-name>` pair anywhere in its text, and text that is
not blank once invisibles are stripped, which becomes the turn-opening prompt. That last shape
reads its content through a narrower reader than any other entry here, and the narrowing is the
gate rather than a convenience: it admits a plain string, or exactly one `text` block beside any
number of `image` blocks, and refuses everything else, because this is the one
attached to a typed line would otherwise be published as the operator's words. An image carries
no text and
cannot reach that register. What the reader refuses is a second text block or a block of a kind it
does not know. Neither shape appears in a sweep of this host's own transcripts, where the
image-bearing shape the reader admits accounts for about three percent of typed prompts; that
sweep and its method are recorded in the plan doc this reading shipped under, not here. The
refusal costs the recovery rather than
risking the register, which is the direction this one gate fails in. A
deviation in any field yields silence.

The `/goal` yield is a class of egress worth naming on its own, because it sends operator prose
rather than model output. What the operator types after `/goal` at the console is extracted from
the transcript and drawn on the session card in Discord, which means a completion goal is written
wherever that channel is read. Five things bound it. The allowlist admits that one command and no
other, so no other slash command's arguments are ever extracted. The reading is gated on the line
having been typed at the console: a line whose `promptSource` is `system`, or whose `origin` names
anything other than a human, yields no goal, which is what keeps another session's delivered
message from setting or clearing the goal on the operator's card. That gate admits a line carrying
no `origin` at all, the shape the harness writes for its own local command output, since it
refuses a `system` prompt source and any named non-human origin and admits everything else. What
it establishes is that no peer wrote the line rather than that the operator typed it. The read is
gated on the same
mirror-on verdict every other transcript read is gated on, so a session with mirroring off yields
nothing. The rendered value is drawn through the fenced-field neutralizer, so a crafted goal
manufactures no mention, chip, or markup. And it is withheld from `GET /sessions` and omitted from
the on-disk snapshot, so the one place it exists off the transcript is the card itself. Two of the queued-command clauses carry weight past format
hygiene. The mode clause keeps out the machine-written background-task notices that make up the
bulk of queued lines, which would otherwise fill the thread. And the origin clause is what stops a
message the operator posted in the thread itself from being extracted and posted back into it,
because the harness records that one under a channel origin rather than a human one. The envelope
check is the belt beside that brace: one reading of the harness's injection marker, shared by the
hook-carried prompt and the extracted one, so the two cannot answer differently about the same
message.

**The `custom-title` yield is the only transcript reading that becomes a property of a Discord
object rather than the content of a message.** Claude Code writes that line for a launch `--name`
and for an in-session `/rename` alike, and its value becomes the session's title, which the thread
carries as its name: composed into the call that opens the thread when a title is already known at
that moment, and written with a `PATCH /channels/{threadId}` on every change after. So the goal's
inventory does not describe it and is not borrowed. Where the goal is withheld from `GET /sessions`
and omitted from the on-disk snapshot, the title reaches six places: the thread's own name, the
session card body and the fleet card's session rows, all three by way of `displayName`;
`GET /sessions`, as a field of the published record; and two files on disk, the registry snapshot
and the thread binding, the latter so a restart does not spend a rename repainting a thread that
already says the right thing. The broker log is not among them, and no line puts it there: the
invariant below, that transcript content reaches the broker log at no level, covers this shape like
every other.

Two of those storage and publication routes take no field on their own. The published record and the
persisted record are each declared as the session record minus a named few, which makes a new field
a compile error until somebody decides about it, and the copy at each seam is then written field by
field rather than by deleting from a copy, so the field is published or written only where a line
names it. The title is named at both, deliberately: it is identity rather than intent, a restored
record should carry the name the operator knows the session by, and the value is already drawn on a
public thread, so withholding it would protect nothing. The goal is named at neither, for the
opposite reason. The thread binding forces nothing of the kind: it is a hand-declared shape with a
validator of its own, so a field reaches it only because somebody wrote one there.

Five things bound the reading. It is read only for the session the transcript was learned for,
behind the same sidechain and session-id gates every other shape sits behind. It is read only where
mirroring is on, so a rename made after launch never leaves a `-NoMirror` session's machine; the
launch name is not covered by that, since it reaches the thread over the hook header rather than
through the transcript. It is neutralized and bounded at the read rather than at the render, because
the render is not the only consumer: a value carrying an unpaired surrogate is refused outright,
since nothing in the strip below reaches the surrogate range and the value ends in a request body
that must be valid UTF-8, and what survives is run through the same invisible-class strip and
whitespace collapse the thread name itself is drawn through, then cleaned, then cut on the stricter
of a code-point and a UTF-16 count of a hundred and twenty, spending one of that budget on a
trailing ellipsis when it cuts. The clean is there for the repo-wide rule that a stored display
string is cleaned before it is bounded. Its control-character strip changes nothing in that
position, those characters being already gone, but its own cap counts UTF-16 units and so can fall
between the halves of an astral pair, and that is what the well-formedness check after the cut
answers: it makes the guarantee a property of the composition rather than a fact a caller has to
hold about how its own bound compares to the clean's. That whole composition is one exported
function, so the two files the field re-enters from on a restart, both of which anything running as
this user can rewrite, are guarded by it exactly as the transcript read is. The registry seam
ignores a value equal to the one it holds, which is what keeps the line's re-emission on every poll
from marking the record changed on every pass. And the repaint waits out a dwell, so a flurry of
renames paints only the settled name, except in the two states that skip the dwell by design,
`needs you` and `exited`, where a title change rides the next pass. That exception is what puts the
rename budget within reach of the title: in either state a value alternating on each pass is a
rename attempt on each pass, and the archive refuses to run until the thread carries the composed
exited name, so a bucket held empty leaves a thread frozen at a stale title and unarchived.
Discord's own rename bucket is the ceiling underneath all of that: the broker holds no rename-rate
number of its own and blocks only once a response reports the bucket exhausted, though a single pass
spends at most ten Discord calls of any kind. The figure of roughly two renames per ten minutes per
thread is the developer-reported size of an undocumented bucket rather than a number this code
holds.

Two limits on that reading are accepted rather than closed, and they are stated here so an auditor
reading this document does not have to reconstruct them from the code that implements them. The line
carries no origin field, so unlike the `/goal` shape there is nothing to gate the read on: anything
that can append to a mirrored session's transcript can rename that session's thread, to another live
session's exact name included. What bounds it is that a permission verdict is already bound to its
own thread and request id, so what is reachable is an operator steering a thread they have
misidentified rather than an approval landing on the wrong session. The composed glyph and separator
are the broker's own and cannot be moved from the transcript. The state suffix is weaker than that
and is not a bound to lean on, because it is derived from signals the same appender reaches, an
engagement stamp read off a typed-prompt line among them, which the accepted-risk list below already
carries. The room a name gets inside the composed title is under ninety characters, not the reader's
hundred and twenty, because the glyph and the state suffix are spent first. Two things narrow that
bound rather than removing it. The glyph vocabulary and the separator are ordinary characters a
title may itself contain, so a title reading as a glyph, a name and a state draws inside the
broker's own composed one, and a client that truncates a long thread name in a list cuts the
broker's true suffix off the end while the planted one stays visible. And the field re-enters from
the two files named above rather than from the transcript alone: those files are in the set that
must not be writable. For a live mirrored session such a plant is corrected at the next re-emitted
`custom-title` line, which the harness writes many times across a session; what has no such
correction is a session whose tailer is never armed, a `-NoMirror` one among them, or one that has
ended. Nothing clears a title either, at any layer: the reader yields no clear, the registry seam
only ever replaces, and the surface holds the last title it saw across a view carrying none, so a
planted value survives a rebuilt record and a restart and goes only when an in-session `/rename` at
that session's own console replaces it. Second, the invisible class is deliberately a class of what
renders as nothing on every surface rather than of everything that happens to draw blank in some
font, so a title made only of printable-blank characters, the Hangul filler and the Braille blank
pattern among them, passes every gate and draws as an empty-looking name inside the composed title,
whose glyph and state suffix still render. Widening the class at this reader alone would put it out
of step with the render site it shares the class with, which is the drift the shared class exists to
prevent.

**The question alert is the second mention-bearing write, so its volume is bounded the way the
permission prompt's is, by a window of its own.** It has two triggers, a credited `PreToolUse`
post at emission and a transcript line at resolution, and anything that can post with the process
token or arm the tailer and append to the file can mint either, so without a ceiling it would
hand a token-holding local process an unbounded phone-ping primitive. Both triggers end in the
one delivery closure and the one window, deduplicated by a bounded per-session set of outstanding
question digests, so the double path cannot double-spend the ceilings, and a digest is recorded
only for an alert that landed, so a dropped emission alert leaves the resolution fallback armed.
The set holds at most 8 digests, one copy per question, and drops whole whenever the tailer's byte
offset does, so a digest can never outlive the resolution line it waits for and swallow a later
identical question's only alert. Every branch of the dedupe fails the same way: at most one
duplicate ping, never a silent question.
Each thread gets 1 mention and 4 posts per 60 seconds: past the first, the alert posts without
mentioning; past the fourth, it is dropped and one rate-limited, content-free log line says so.
The window's stamps are deliberately separate from the permission prompt's window, because shared
stamps would let a forged run of questions spend the prompt window's slots and push a real
permission prompt into drop, converting a ping nuisance into a parked session. The alert itself
composes at most one Discord message, naming how many further questions wait at the console when
the content would not fit, so the mention and the alert line always survive.

An ask no single message can carry posts its overflow as plain continuation messages, up to 6 of
them, so what one admitted ask spends on the create-message bucket is more than a single post. Those
continuations carry their own per-thread window of 8 posts per 60 seconds, with its own stamps,
separate from both the alert window's and the permission prompt's for the same reason those two
are separate. So the question surface's whole ceiling against the bucket permission prompts ride
is 4 alert posts plus 8 continuation posts per thread per 60 seconds, and that pair is what bounds
it, rather than the alert ceiling alone. A refused continuation releases the hold to the console
rather than leaving a marker pointing at text that never arrived, so the refusal costs a thread
answer, never a parked session. Posts within one ask are paced, because the count ceiling bounds a
window and not a burst, and the create-message budget is one instance shared across every thread:
a burst dense enough to earn a 429 would block the alert route in every thread until it lifts.

Two residues are accepted rather than fixed. A continuation posted before a mid-ask refusal stays
in the thread, since continuations are never edited, so a released ask can leave framed question
text above a message rewritten to the console line; the text is neutralized and mentions nothing,
so what it costs is thread clutter. And the pacing narrows the burst rather than proving it away,
since Discord does not publish the bucket it is paced against.

**A forged question post is mostly a second door to a capability a token holder already had, with
one exception named below.** The broker's scheduled task runs as the operator at limited
integrity, the same account a token-holding subprocess runs as, so making the broker perform the
read confers no privilege. Such a process can already read any of the operator's files and post
arbitrary text to the thread through the mirror route. A forged `PreToolUse` question post is
credited only against the session its token holds, it must name that session in its own payload
to reach the question seam at all, it alerts only into that session's own thread, and it spends
that thread's own question window first.

**The exception, accepted deliberately: a forged question elicits, and its answer returns to the
forger.** A held question is answered by writing the operator's choice back down the very HTTP
request the `PreToolUse` post opened, so whoever sent that post receives the answer. A local
process holding the token can therefore ring the operator's phone with a question of its own
devising, rendered exactly like a real one, and read back what the operator submits: an option
label it chose the wording of, or, on the typed path, the operator's free text verbatim. This is
a real elicitation primitive and it is not held to the reply-key bar the section below sets for
permission prompts, because the hook is fired by a CLI that holds no reply key and putting one in
the hook's headers would only mint another secret every subprocess inherits.

It is accepted on its blast radius rather than on its difficulty. The attacker is already code
running as the operator, which already reads every file the operator owns; what the primitive
adds is what is not on disk, an answer from the operator's own head. Narrowing it would cost the
feature its point, so the residual is recorded here rather than engineered around, and the
operator's own signal is the same one every other forged surface leaves: a question in a thread
that no session at the console is actually parked on. Through the tailer it costs one additional forged `/mirror` post to arm the session, and what
it can aim at is bounded twice over: the path must pass validation below, and a line yields text only
when its own recorded session ID matches the session the path was learned for, so another registered
session's transcript yields nothing.

**The transcript path is treated as an instruction to open a file, not as a display string.** It is
control-character stripped and trimmed, then refused whole rather than normalized if it is over
length, not absolute, or a UNC path. Refusing on length rather than truncating is what keeps a
too-long path from becoming a path that silently never opens, which is indistinguishable from an
unreadable file. Refusing UNC is what keeps `\\host\share\x.jsonl` from making the broker open an
outbound SMB connection carrying the operator's credentials. The path is held only in memory: it is
never written to the registry snapshot, never published by `GET /sessions`, and never logged.

**Transcript content is untrusted text of the same class as a mirrored reply**, and it reaches
Discord through exactly the escape a mirrored reply uses, whether it enters a message by post
(`renderMirror`) or by edit (`appendNarration`, which grows the narration message in place). The
two entry points are built from the same escape and the same fence scanner, so there is no second
reading of where a code block is: text appended by edit is stripped, escaped, and fence-closed
exactly as text posted fresh, and the base it appends to is the renderer's own prior output and is
never escaped a second time. That the base really is renderer output rests on provenance, the
router is the only caller and only ever feeds back what the renderer returned, backstopped by a
cheap invariant check that refuses an empty, padded, or invisible-carrying base outright. The edit
write itself carries the same mention and embed suppression every post carries, and its target can
only be an ID Discord returned for one of the broker's own posts: no ID that arrives over the
gateway ever becomes an edit target, gateway IDs are only compared against the remembered one to
decide freshness. Its `✨ Claude · working` attribution is forgeable by content in the same way the
mirrored reply's `✨ Claude` is, and for the same reason that is accepted: it is a Claude-authored
line opening a Claude-authored message, claiming nothing the message does not already claim. The
operator-attributed quoted block is the one attribution content cannot draw: no text passing through
the renderer can compose it, whichever path that text arrived on. What the renderer cannot establish
is who authored the words handed to it, and on the queued-prompt path the broker awards the operator
attribution to a line it read off a file, so what holds there is that the attribution belongs to
whatever wrote that line into the transcript. The accepted-risk list below carries what that rests
on. What an unauthorized channel member's messages can do to coalescing is end a block early (their
gateway events clear the freshness state), which costs one attribution header and nothing else.

**Transcript content never reaches the broker log at any level.** Every line the tailer writes
carries a static reason, a session ID, a byte count, or an offset. A `JSON.parse` failure and a
filesystem failure are both discarded unread, because the parse error embeds an excerpt of the line
that produced it and the filesystem error carries the path.

**Reads are bounded** to a ceiling per session per pass, measured against the file's size before
anything is parsed, so a transcript that grew faster than the poll is skipped to its current end
rather than read out as a backlog. Only whole lines are consumed. A read is never retried and
nothing is queued for a later pass: a chunk or a prompt that could not be posted is dropped where it
stands. What one in-flight posting run does do is sit out a rate-limited refusal and send that same
message again, bounded on three sides so it cannot become a retry storm against the operator's
channel. Only a refusal saying the bucket is empty is retried at all, and that is the one class
where nothing landed. Every wait is floored at a second, so a refusal reporting a sliver of a
millisecond is a pause rather than a thousand posts. And a run stops for good once its waits total a
minute, whatever it is still holding.

## The sender gate

The authority for any inbound action is the Discord sender's user ID, checked against a one-entry
allowlist (`CHANNEL_ALLOWED_USER_ID`), and it is gated on the sender rather than the channel or
thread. A thread identifies a room, and everyone with access to the room can post in it, so treating
the room as the credential would let any member steer a session and approve its tool calls. A broker
with a Discord connection refuses to start without an allowlist, and says why in its log rather than
dying silently under the scheduled task.

The gate runs before everything else on the inbound path, **including the verdict pattern**, so a
verdict-shaped message from anyone else is refused before it is read as one.

**What it does not protect.** The allowlist is one Discord account. Whoever controls that account
can steer every session on the host and approve any tool call it asks about, and its messages reach
the model at the keyboard's standing, so that account's own password, second factor, and the device
its notifications reach are part of this trust boundary. The gate says nothing about who is at the
other end of it.

## The broker deletes messages, under three conditions that all bind

The broker holds one irreversible capability against the operator's own channel: it deletes the pin
notices its own pins cause. Discord writes one into the channel whenever the broker pins a message,
which cannot be suppressed at the source, and left alone they bury the channel.

A delete cannot be undone, so the gate is as narrow as the notice allows and all three conditions
bind together: **this host's channel**, **Discord's type for that notice**, and **this bot as the
author**. A notice behind a pin the operator made by hand carries their user id and is left where it
is. A second broker sharing the guild deletes nothing here, because the channel condition is its own
configured channel. No message's content is read to make the decision, and nothing that is not a
system message this bot itself caused is ever a candidate. The decision is one pure function
(`classifyMessage`).

The other notice this bot causes, the one a rename writes into a session's thread, is not deletable:
an application asking to delete a system message of that kind is answered 403 with error 50021
whatever permissions it holds, where a human account with Manage Messages may remove it in the
client. So the broker never asks, and a rename notice is dropped rather than delivered, which is
also what keeps Discord-composed text out of the inbound route.

Nothing is retried. A refused delete costs a notice that stays where it landed, which is the surface
a broker without this feature has, and the request budget a retry would spend is shared with the
writes that reach a phone. A refusal Discord marks permanent latches that one kind off for the rest
of the run, because the same call would be refused the same way on every later pass and Discord's
invalid-request budget is enforced with an hour-long IP ban that would take the permission prompts
down with it. A 404 does not latch: it is permanent about the identifier it named and about nothing
else, so one notice already gone must not stand the cleaner down for every other thread.

Deleting a message the bot itself authored needs no permission beyond what the bot already holds, so
this capability adds nothing to the install's permission list.

## Tool approval over the channel

**A permission prompt sends the tool's actual input off this machine.** `input_preview` is the shell
command, the patch body, the file path and its contents. The mirror is the other surface that sends
content off the machine: with `CHANNEL_MIRROR` on, every console prompt is posted into the
session's thread in full, and every turn's final assistant reply is posted unless the thread
already carries that text: a reply the transcript tailer posted as narration, or a reply-tool
answer the final text matches exactly or nearly (the same words within a bounded similarity
threshold, and never when the final text is materially longer than the answer, so a final text
that grew past the length allowance always posts). The accepted residual of the near-match rule is that a final reply
differing from the answer by a small fraction of its words can be suppressed with those words
reaching the thread nowhere; the bound is the threshold and the length guard, both named
constants. What the broker holds in memory to make these comparisons is never the text: a
digest, a normalized length, and a bounded sketch of hashed word shingles, one record per
session, consumed or cleared within the turn. The sketch's hashes are not preimage-resistant
(a dictionary can confirm a guessed phrase against them), which is acceptable precisely because
the sketch never leaves process memory: nothing serializes it, and a process that could read
broker memory could read live conversation text anyway. The log file records none of this
content, and mirror content never reaches it at any level. A prompt crosses to Discord's servers, is stored there under their retention, and is rendered on
a phone. **The sender gate governs who can write, not who can read**, so every member of the channel
sees every prompt. The channel must be private to the operator, and `install.md` says so.

The description and the input preview are written by a tool call, which anything the session has
read can influence, and they land in the one mention-bearing message this system asks the operator
to answer (the four writes that deliberately mention someone are enumerated below; the permission
prompt is the only one soliciting a reply). They are
rendered as inert text with mention and chip syntax escaped, and each is cut to its own budget so it
cannot push the request ID and the answering instructions off the end of the message. A cut field is
labelled as cut, because otherwise an attacker-influenced input can front-load benign content and
push the part worth refusing past the boundary.

A verdict is bound to the thread it was typed in as well as to the five-letter request ID, and
answering consumes the request, so a verdict cannot be replayed or applied to a different open
prompt. A verdict naming nothing open is answered in-thread rather than dropped in silence: from a
phone, silence is indistinguishable from success. One case takes precedence over that notice: when
the session holds a question the thread can answer, a verdict shape that resolved nothing becomes
that question's answer instead, because the verdict pattern is also the shape of a short reply and
the alternative parks the session for the rest of its hold. The notice still fires when no hold
takes the message.

**A component interaction is a second gated inbound path.** A button or a menu on a question message
arrives over the gateway and is checked against the same one-account allowlist every typed message
passes, before it reads or changes anything; a press from any other account is ignored with no reply
and no state change. What a press carries is an opaque server-minted reference and a position, never
content: the desk resolves the position against its own copy of the ask, so a press can only ever
submit a label the session itself offered, and a crafted reference resolves to nothing rather than
to another session's ask. Interaction acknowledgements spend their own rate budget, separate from
the buckets the message surfaces spend.

**A message the inbound ceiling cut is never read as a verdict.** The pattern tolerates interior
whitespace, so a cut can land on an exact verdict match that the operator's full message never
made, approving a real tool call on words nobody sent. Cut text is delivered to the session as chat
instead. The ceiling matches Discord's own maximum message length, so nothing a client can send
today is cut; the guard is what keeps a future ceiling below that maximum from turning a truncation
into an approval.

A prompt reaches the broker over the same loopback route a reply does and is held to the same bar,
the per-attachment reply key. A process token is not enough. Without that, any of the subprocesses
that inherit the token could ring the operator's phone with an approval request of its own devising,
in the one message they are trained to answer quickly.

**A model change is the third mention-bearing write, and it carries its own window.** A session
forced off its model mid-run posts one message, on the notice tier by default and on the
mention-bearing alert tier under `CHANNEL_MODEL_CHANGE_ALERT`. The model it reports is read from
the session's own transcript, which a token holder can write, so the alert tier would otherwise let
a line alternating its model string mint one phone-reaching post per poll against the same budget
permission prompts spend. It therefore rides a per-thread ping and post window of its own, sized
like the question alert's and separate from it, so the surface reaches a phone without becoming a
ping primitive. The knob is off by default, which is likelihood rather than severity, and it is a
notification control alongside the mirror switches rather than a privacy one.

The card's downgrade marker is a report, not an authority. Its direction is decided by matching a
model name against a known family list, so a crafted model string can be made to rank wrong and a
forged downgrade can be made to render unmarked. Whoever can do that already writes the whole
model line, so nothing is gained by guarding it; what matters is that the marker's absence is not
evidence a session is running the model it opened with.

**The question surface does not meet that bar, and the difference is deliberate.** A held
`AskUserQuestion` rings the same phone on the process token alone, because its post comes from a
CLI that holds no reply key. The two surfaces are held apart by what an answer can do rather than
by who may ask: a verdict approves a real pending tool call, so it is bound to a key a subprocess
cannot inherit and to the request id it names, while a question's answer is text handed back to
whoever asked, which is why the forged-question residual above is recorded as elicitation and not
as approval. A forged question cannot approve anything, and a forged verdict cannot be sent.

**The fleet card sends account identity.** Its per-account label is the account's own email
address, falling back to its organization name, read from claude-swap's `sequence.json` beside the
usage cache. It is the one field on that card drawn outside a fence: the bold line above an
account's block is live markdown, so the label takes the full neutralization the session card's own
title takes rather than the lighter fenced-field escape, and a crafted address therefore draws no
mention pill, no heading, and no fence delimiter, and cannot close the emphasis it sits
inside. Two of the three hosts are
organization-owned, so those labels are corporate identities, and they cross to Discord under
Discord's retention the way every other surface's content does. What the card does not carry is
anything from the credentials directory that sits beside the files it reads: the reader opens
exactly `cache/usage.json` and `sequence.json`, no field of either file is ever used as a path,
and `lastError`'s content is deliberately left unread, because an authentication failure string is
where a token or a token-bearing URL would appear. What it takes from that field is that one
exists.

**The board card reads two foreign files and sends none of their paths.** It opens plan documents
under the operator's configured project roots and the kit's goal event stream, both written by other
programs, and renders their content into the channel where approvals are answered. Three properties
bound what that content can do. No field of either file is ever used as a path: the configured roots
are the only path input, and the single join is a root with a directory entry's own name, which
cannot contain a separator, so nothing a plan document or an event says can steer a read outside the
directory being swept. Roots are matched as strings, separator-normalized and case-folded on Windows,
never by asking the filesystem whether two paths name the same place, and both readers fold through
one shared normalizer so they cannot disagree about which root an event belongs to. And the event
stream's `project` field, an absolute path that ordinarily embeds the operator's own account name, is
matched and then dropped rather than carried: what the card holds is the configured root it matched,
so that field reaches neither the log nor Discord. The refusal of a project root that is not a fixed
directory names the entry's position and never its text, for the same reason.

What does cross is the project label, which is the last segment of a configured root. A root placed
at or one level under a home directory therefore draws the account name into the channel, and that is
the operator's choice of root rather than a property the card can fix.

The card's body is live markdown apart from the one-line fence naming each project, so a field takes
whichever of the two escapes matches where it lands. Every field on a body line, which is every
filename, status and `Next:` value, takes the full markdown escape, the same control the question
messages and the downgrade notices render their text through. That escape covers every
metacharacter including the angle brackets Discord's mention and timestamp syntax lives inside, and
the card's routes send an empty `allowed_mentions` parse list, which is what keeps an `@everyone` in
a plan's status as text that pings nobody. Together they mean neither a crafted filename nor a
crafted status or `Next:` value can draw a mention pill, a timestamp chip, a heading, a quote bar,
or a fence delimiter, and none of them is ever the first character of a line, since every body line
this card emits opens with a literal prefix of the card's own.

The project label is the one field drawn inside a fence, and a fence honors no backslash escape, so
it takes the block escape instead: every backtick is substituted rather than escaped, which is what
holds the fence closed. A crafted directory name therefore cannot close its own block and reach the
markdown outside it, and it cannot open a second one. The property both escapes share is the one
that keeps a field to the line it was given: the invisible class is stripped and whitespace runs
collapse, so no field of either kind can carry a newline and compose a body line of its own.

What the escape does not reach is vocabulary. A status is drawn whole and can therefore spell the
words the card's own `blocked` and `held` markers use, which the markers are told from only by
their lead position on the line. The consequence is a plan that reads as blocked when it is not, on
a surface that reports state rather than authorizing anything; it draws no live pill, chip, or
prompt, and the neutralization above is what holds that line.

**The blocked-goal alert is the fourth mention-bearing write, and its trigger credential is the
weakest in the set.** The session surface reads the same goal event stream through a second fold,
keyed by session id rather than by project root and filtered by no root list: one appended
`goal-blocked` line naming a session this broker tracks becomes a `⛔` state on that session's card
and thread title and, while the event is fresh, one alert into its thread. Appending to the stream
requires no process token and no per-session binding, only write access to the operator's own home
directory, so any process running as the operator, an unwrapped session in any repository
included, can raise this alert with a plan path of its choosing. The bounds are the ones the write
rides: the session id must match a registered session through the same sanitizer the registry
stores ids through, a line stamped later than the reader's own clock is dropped, the alert posts
only while the event is younger than its freshness bound, one alert per episode instant is
remembered, and the write rides a per-thread ping and post window of its own, sized like the
question alert's, so the surface reaches a phone without becoming a ping primitive. The plan path
it renders takes the full markdown escape and the reader's own length bound, and the route's empty
`parse` list plus the single-user whitelist mean the only mention the message can carry is the one
the renderer composes. What the escape does not reach is vocabulary, as with the card above, and
here the words land in a pinging message rather than a status surface: a crafted plan path reads
as prose in an alert the operator is trained to act on, which is the residual the trigger
credential prices in. The same feed is an accepted suppression primitive in both directions: a
crafted `goal-complete` naming a real session clears its standing block before a tick observes it,
and a flood of junk session ids can evict a real session's kept event through the fold's bound.
The feed can also spend a thread's rename budget: alternating events held past the title's dwell
each way drive real renames out of the same small per-thread bucket the final exited rename and
the archive draw on. So the blocked surface is evidence when it draws and never proof when it does
not, which is the same standing every state this broker renders from another program's file
already has.

What the operator's own configuration can still reach is worth stating, because these knobs sit in
the access-controlled `broker.env` rather than in anything an attacker supplies. A project root may
name a UNC share, in which case the sweep opens outbound SMB under the broker's own credentials once
a tick, and the event stream path is taken as given. Both are the same trust class as any other value
in that file, which the model already treats as equivalent to code execution on the host.

**A channel event reaches the model at the keyboard's standing.** The relay's instructions describe
the sender gate rather than commanding trust: a message is delivered only after the broker has
checked its author's Discord account against the allowlist, and a broker connected to Discord
refuses to start without one, so the model treats channel steering as the operator's own. The
residuals ride in the same text: the check establishes the account, not the person, and an action
that is irreversible or outward-facing is confirmed first, a discipline about blast radius rather
than identity, so it binds a keyboard instruction equally. What the description is not is
verification by the relay: the relay cannot identify its peer, so the instructions state a
structural property of the system, backed by the broker refusing to run ungated, and the forged
peer this leaves open is carried in the accepted-risk list below.

**The reply tool's allow rule is a machine-wide pre-approval.** One rule is merged into the
user-level settings file: `mcp__plugin_relay_channel-relay__reply`, for the relay arriving as this
repository's plugin, the route every fleet host runs. It applies to every Claude Code session on
the machine, not only wrapped ones, and any MCP server whose registered key sanitizes to the name
inside the rule has its `reply` tool pre-approved with no prompt. The relay is registered per
launch by the wrapper rather than at user scope, so an unwrapped session normally has no such
server, but a project `.mcp.json` in a repository a session is working in can squat the name. The
installer refuses to merge any permission rule outside its own exact-match, case-sensitive
allowlist, which stops the fragment being used to widen this; it does not stop the squat. The
development route's rule, `mcp__channel-relay__reply`, is not shipped: a dormant rule is a standing
pre-approval with no route that needs it, and a second squattable name. A host temporarily on the
development flag parks its first reply on a permission prompt instead, and the rule name that
prompt shows is the one to add by hand for the duration.

## Untrusted strings

A session name and a tool name are attacker-influenceable, not hypothetically: any local process that
can reach the intake can announce a session with any name it chooses.

Neutralization happens **at the render site, not at intake**. The intake strips control characters
and caps length; it deliberately does not touch `@everyone`, `@here`, markdown, or bidi controls,
because escaping display syntax is the job of whatever is displaying it. There are two render sites
and both apply it:

- **Discord.** Every message write suppresses embeds, so a bare URL cannot auto-link and leak a
  fetch to an attacker-chosen host, and every write sends an empty `allowed_mentions.parse` list, so
  **no mention is ever resolved from message content**: `@everyone`, `@here`, a role, and any user
  the text names all stay inert. Markdown and Discord's angle-bracket chip syntax are escaped, so a
  name cannot render as a fake timestamp, mention, or emoji, and a card cannot spoof the heartbeat
  it exists to carry.

  **Four writes deliberately mention someone: the permission prompt, the open-question alert, the
  model-change alert, and the blocked-goal alert.** They differ in what must be presented to
  trigger one, which is the fact to audit: the permission prompt demands the per-attachment reply
  key, the question alert and the model-change alert a session's own process token to arm and then
  a line in that armed session's transcript, and the blocked-goal alert only an appended line in a
  file at a fixed well-known path in the operator's home directory, with no arming step at all,
  the weakest credential in the set, bounded where that write is described above. All four exist to reach a
  phone, and none is a widening: the empty `parse` list stays, and each adds
  `allowed_mentions.users` naming exactly the one allowlisted operator ID, which is validated as a
  snowflake at load. The only mention syntax in any of these messages is composed by the renderer
  from that ID. Content still cannot produce one. The question alert additionally carries its own
  per-thread ping/quiet/drop window, described under the transcript section below, because its
  triggers, a credited hook post and a transcript line, are mintable by a token holder rather
  than held to the reply key the way a relay request is.
- **The log file.** Untrusted fields pass through the same neutralization before they land, so a
  newline cannot forge a second log line and a bidi run cannot misdirect a reader.

**Conversation text is neutralized on a narrower rule than a name is.** A mirrored prompt, a
mid-turn typed message, a mirrored reply, a mid-turn narration chunk, a `reply` tool call, and a
peer message's body in either direction are prose with code in them, so escaping the whole of
markdown would trade the readability of the surface away. All six go through one fence-aware
escape that neutralizes Discord's angle-bracket chip syntax and a line-leading quote marker and
leaves the rest alone. `renderMirror` applies it to
mirrored, typed, and narration text, `renderAnswer` to the reply tool's, the peer renderings to a
peer body, and `appendNarration` to a chunk entering an existing message by edit, all before the
text reaches the message path.

A peer body takes one pass the other five do not, and the difference is who is forging what. The
escape above stops a chip and a line-leading quote marker; it does not stop an attribution line,
and the reply marker's accepted residual is why it did not have to: there the forger and the
claimed author are the same party, so a Claude reply drawing a Claude attribution says nothing
untrue about who wrote it. A peer is a different author, and a peer body drawing this session's
own outbound peer line says this session sent something it did not send, in the one channel
permission prompts are answered in. So an attribution glyph opening a line inside a peer body is
escaped as well, on the same reasoning as the quote marker, and the opener set is derived from the
renderer's own attributions rather than hand-listed, so a later attribution joins it without
anyone remembering to. An emoji has no markdown escape, so the backslash renders visibly there;
that is the accepted cost of the pass and it is stated at the constant. That is what stops any of them from drawing a
mention pill, a timestamp chip, or a copy of the renderer's own attribution line, in the one channel
the operator answers permission prompts in.

The quote marker is escaped inside a code fence as well as outside it, so the attribution's
unforgeability does not rest on this project's reading of where a fence is agreeing with Discord's.
Where the two readings do differ, the cost is bounded to a chip left unescaped in a region this
project called code and Discord called prose, which `allowed_mentions` still keeps from pinging
anyone. Operator check E is what confirms the rendering half against the real client.

**What the narrower rule deliberately leaves live, and what that admits.** Emphasis, headings,
spoilers, and the masked link form `[text](url)` all survive into a thread, and the masked link is
the one with a security consequence: Discord renders it for a bot's own messages, so conversation
text can post a link whose visible words name one destination and whose target is another, in the
channel permission prompts are answered in. It is live because the readable label is the useful half
of a link on this surface, where an artifact address is long and says nothing about itself, and a
bare URL auto-links whether or not the masked form is escaped. So the choice is between a labelled
link and an unlabelled one, never between a link and none. The accepted risk is bounded by what a
link cannot do: it draws no mention pill, no timestamp chip, no quote bar, and no copy of the
attribution, so it cannot impersonate this broker or the operator, and following one is an act the
operator takes rather than an approval the thread can extract. Nothing here is a permission grant,
which is answered by a component or by a typed reply and never by a link.

`processToken` never reaches either.

**Peer traffic is a sixth untrusted-input surface, and its author holds the weakest credential of
any of them.** Another Claude session's message is remote-authored text that reaches a thread with
no process token and no per-attachment reply key: what mints it is the ability to send a
cross-session message to a session this host watches. Two residuals accepted above are therefore
reachable by that author, and both are worth naming as reachable rather than left to inference. The
masked link survives into a peer body, so another session can post a link whose visible words name
one destination and whose target is another; it is bounded by exactly what bounds it for
conversation text generally, since a link draws no mention pill, no chip, no quote bar and no copy
of the attribution, and following one is an act the operator takes rather than an approval the
thread can extract. The readable-notice text is the other. Neither is a widening of what content
can do, and the attribution and the quoted block stay unforgeable against a peer body by the pass
described above.

**A peer message never stamps engagement, and the classification decides that as well as the
attribution.** The engagement stamp records that a person is driving, and it is what clears a `⛔`
standing blocked state; another machine writing is not a person, so a peer-classified prompt is
excluded at all three stamp sites on the wake injection's own ground, under every setting. Because
one
reading now decides two things, its two failure directions are asymmetric and the quiet one is the
expensive one. A harness shape move that stops the classification matching costs a delivery its
attribution, which is read off the thread at a glance, and it silently restores the stamp, so a
machine-generated message clears a block again with nothing to show for it. A false positive, a
prompt the operator really typed read as a delivery, costs the peer attribution under `full` and
`brief`, costs the message entirely under `off`, and withholds the stamp on every setting, so a
block the operator typed to clear stands until their next completed tool call. The classification
is a prefix match on the harness's own opening for that reason: what an operator types does not
open with it.

One residual on that exclusion is accepted rather than closed. Withholding the stamp at delivery
keeps the block standing at the moment a peer writes, but a woken session that goes on to run any
tool stamps on that tool's `PostToolUse`, so a peer message that actually causes work clears the
block one tool call later. That is the same ordering the task-notification exclusion accepts and
for the same reason: the gate exists to wait on a person, and a run that genuinely resumes is the
evidence the gate was waiting for. What it is not is a way for a peer to clear a block without
moving the session, since the session has to actually act.

## Files that must not be writable

The `SessionStart` hook runs under `-ExecutionPolicy Bypass` at every session start, and the launch
wrapper is dot-sourced into the operator's interactive shell. **Write access to either is code
execution in the operator's context.** The bot token is a bearer credential: read access is control
of the bot, write access lets an attacker substitute a token and redirect the host's entire session
inventory to a server they own.

Three more things widen this. At every logon the scheduled task runs `install/Start-Broker.ps1`
under the same Bypass, which loads `install/Install-Functions.ps1` and executes `broker/`. The
merged user settings name `relay/index.ts` as an MCP server command, so Claude Code executes the
relay at the start of every wrapped session. And on the plugin route, Claude Code executes
`plugins/relay/launch.mjs` from its plugin cache under the user profile, and that shim in turn
executes whatever command the state root's `relay-mcp.json` names: the registration file was
already on the execution chain as the wrapper's `--mcp-config`, and the plugin route keeps it there
with the shim as one more link, while the cache copy of the shim itself is user-profile state in
the same writability class as the settings file. So the surface is every path on the execution
chain, not a pair of files, and **directories count as much as the files in them**: a hardened file
in a directory that permits delete-child can simply be deleted and re-created attacker-owned with a
clean access control list, which defeats the file's own permissions entirely.

The installer strips inheritance and grants only the owner, Administrators, and SYSTEM on:

- `hooks/`, `relay/`, `wrapper/`, `install/`, and `broker/`, as directories, inherited by their
  contents
- the bot token file
- the state root, unconditionally, since `broker.env`, the registry snapshot, the log file, and the
  per-launch relay registration all live there whether a token does or not

It also refuses to harden a drive root, and refuses a token file outside the state root, because
rewriting the access control list of an arbitrary directory an operator happened to name is a
destructive act that no install step should be able to take by accident.

This is not theoretical on these hosts: a repository checked out under a drive root that grants
`Authenticated Users: Modify` inherits exactly that, and until the installer runs, it holds. Three
independent checks enforce it afterwards, all calling the same rule rather than restating it: the
installer reads back every path it hardened and fails the install rather than reporting success, the
broker refuses to start against a token file or token directory that fails, and the launch wrapper
refuses to start a session when the hook script has lost its protection, which is what a re-clone or
a branch switch can silently undo. A check that cannot *run* is treated as a refusal for the
credential, and as a warning for the launcher, where blocking work would cost more than it protects.

The installer's read-back walks every file and subdirectory under the hardened trees rather than
sampling one per directory, because the hardening is not recursive: a file whose inheritance was
already detached keeps its own access list and gains nothing from a parent's new inheritable grant.
Hardening is also idempotent and repairing. A path already carrying the exact list is skipped without
a write, which is what lets a re-install run unelevated, and a path that has since been granted
anything else is rewritten back to the three trustees rather than refused.

Ownership is checked, not just the permission list. A file created by an untrusted local account is
owned by that account, so hardening it "to its owner" would hand it to the attacker and then pass
verification. The owner must be this process's account or an administrative identity. Reparse points
are refused outright, since a symbolic link passes every check against its current target and can be
re-pointed afterwards.

`broker.env` gets a second layer beyond its ACL. `Start-Broker.ps1` applies only the keys on a fixed
allowlist and skips anything else with a warning, because that file's contents become environment
variables of the process that then reads the bot token, and something like `NODE_OPTIONS` there is a
code-execution primitive needing no hook and no ACL bypass at all. The settings fragment gets the
same treatment from the other direction: the installer refuses to merge any hook event, hook type, or
permission rule outside its own short lists, so an attacker-writable fragment cannot persist an
arbitrary `PreToolUse` command machine-wide by riding the merge.

The exposure is latent on a single-operator machine and live the moment a host has a second
authenticated account or a non-administrative service account.

## Accepted, and worth stating

- **Hook payloads and relay traffic cross loopback in cleartext.** `PostToolUse` carries
  `tool_input` and `tool_response`, the `UserPromptSubmit` and `Stop` mirror posts carry the console
  prompt and the turn's final assistant reply in full, and the relay pipe carries the text of every
  message exchanged with the operator. The mirror posts cross for every Claude Code session on the
  host, including unwrapped sessions in unrelated repositories, because the hooks are installed at
  user level; those posts carry no process token, and the broker answers them without assembling a
  body. Of the tool fields the broker keeps one bounded preview of `tool_input` for the status card
  and drops the rest, but dropping after receipt is not the same as not transmitting: anything
  running as this user can read all of it off the loopback interface, and a local process that wins
  the race to bind the port before the broker starts sees it directly. The loopback bind and the
  `Host` check are what this rests on.
- **A session ID nothing has registered can be claimed.** An unwrapped session on the host holds no
  registry record, so its session ID is unclaimed, and a token holder that registers that ID can arm
  the tailer against that session's transcript and read its mid-turn prose, and the messages typed
  at its console, into a thread of its own.
  This is the same-user file read plus arbitrary Discord post the mirror route already grants, by a
  different door; the session-ID match in the line filter is what keeps a *registered* session's
  transcript out of another session's thread.
- **The tailer's line filter fails to silence, never to publication.** A line contributes text only
  when its own recorded session ID matches the session the transcript path was learned for. If a
  future Claude Code build writes a transcript whose internal session ID differs from the one its
  hooks report, mid-turn narration stops entirely and nothing distinguishes that from a model that
  wrote nothing between tool calls. The feature goes inert rather than publishing wrongly, which is
  the direction to fail in, but it fails quietly.
- **The operator attribution on a typed message rests on the transcript file.** Such a
  message reaches the thread in the operator's own quoted block because a line in the session's
  transcript records that a human typed it. This covers the ordinary prompt that opens a turn as
  well as the message typed mid-turn, and on a shallower shape: a plain `user` line carrying the
  harness's typed and human stamps, rather than a `queued_command` attachment. The narrower
  content reader is one of four controls that shape adds over the mid-turn one, beside the typed
  prompt source, the meta exclusion, and the command-markup refusal; all four bound what can ride
  in rather than establishing who typed it. The instant that same block's engagement stamp carries
  comes from the file too, bounded at both ends by the registry, never moving the stamp backwards
  and never landing later than now, so an appended line cannot post-date a session out of its own
  blocked state. The escape makes that block undrawable by content, and
  nothing beyond the file's own contents establishes whose words are in it: anything running as the
  operator that can append either shape to a live session's transcript, a `queued_command` line
  with a human origin or a plain `user` line stamped `promptSource: "typed"` with a root
  `origin.kind` of `human`, puts words in the operator's mouth, in the channel where tool approvals
  are answered.
  That is the wall a process holding the process token already stands behind, and this is a third
  door through it rather than a capability the door did not already open. Unforgeable is therefore a
  property of the renderer, not a claim about where the words came from.
- **A session's thread name rests on the same transcript file, and nothing clears it.** The
  `custom-title` line the thread title follows carries no origin field, so unlike the `/goal` shape
  there is nothing to gate the read on: anything that can append to a mirrored session's transcript
  renames that session's thread, to another live session's exact name included, and what is reached
  is an operator steering a thread they have misidentified rather than an approval landing on the
  wrong session, since a verdict is bound to its own thread and request id. The title also re-enters
  from the registry snapshot and the thread binding, both in the set that must not be writable, and
  no layer offers a clear: the reader yields none, the registry seam only ever replaces, and the
  surface holds the last title it saw, so a planted value outlives a rebuilt record and a restart
  and goes only when an in-session `/rename` replaces it. For a live mirrored session the next
  re-emitted line corrects a planted value; a session whose tailer is never armed has no such
  correction. The transcript reading section above carries the full account.
- **A title of printable-blank characters draws as an empty-looking thread name.** The invisible
  class the title and the render site share is deliberately a class of what renders as nothing
  everywhere rather than of everything that draws blank in some font, so the Hangul filler and the
  Braille blank pattern pass every gate. The broker's own glyph and state suffix still render, so
  the thread is identifiable rather than nameless. Widening the class at the title reader alone
  would put it out of step with the render site, which is the drift a shared class exists to
  prevent.
- **A turn's final reply can arrive labelled as mid-turn.** The Stop mirror and the tailer read the
  same text, and whichever posts first is the one the operator sees. When the tailer wins the race,
  the turn's conclusion carries the `✨ Claude · working` attribution rather than `✨ Claude`. The
  text and the count are right; only the label reads as mid-turn.
- **`CHANNEL_TASK_NOTIFICATION=full` re-accepts operator-attributed rendering of harness text.** A
  background task's wake prompt is harness-injected and carries the subagent's whole report, which
  anything that subagent read can influence, and under `full` it renders inside the
  operator-attributed quoted block, in the channel where approvals are answered. Chips, mentions,
  and the quote marker are still escaped, so it cannot render a working prompt or a second
  attribution; what it carries is prose under an attribution the operator never typed. The default
  `brief` removes the surface by composing the broker's own one-line notice, repeating only a
  bounded, neutralized task id from the injection.
- **A forged broker forges the operator's steering.** The relay believes whatever answers the
  broker's loopback port, so a local process that binds it while the broker is down can feed a
  session channel events, and those events arrive at the keyboard's standing the instructions
  grant. Accepted because the same position already holds a stronger primitive: permission verdicts
  ride the same stream, so such a process can approve a session's real tool calls without composing
  a single steering message, and a process running as the operator can rewrite the session-start
  hooks outright. The instruction text changes what a forged message is worth, not who can forge
  one or what they could already do.
- **One allowlisted Discord user per host.** There is no multi-user model and no per-user
  permissions.
- **A session cannot be started or restarted remotely.** A channel injects into a running session; it
  cannot create one. This is a property of the mechanism, not a gap to close.
