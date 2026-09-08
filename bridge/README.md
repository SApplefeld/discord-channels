# bridge/

The DSH bridge: an MCP channel server, a stdio child of one Claude Code process, that hands work to
a DeepSeek Harness worker and pushes the worker's answers back into the session.

It is the relay's shape with a DeepSeek Harness runtime where the relay has a Discord broker. It
declares `claude/channel` and five tools; instead of carrying an operator's messages both ways, it
spawns `dsh --profile sdk`, drives sessions over the SDK's JSON-RPC-over-stdio protocol, and emits
one `notifications/claude/channel` event per finished worker turn. It declares no
`claude/channel/permission`: the events it carries are a machine's output, and a permission relay on
that channel would let a worker's text approve Claude's tool calls.

## The five tools

- `dsh_prompt(session, text, cwd?)` hands one task to the worker and returns as soon as the runtime
  accepts it, naming the DSH session id and the turn number. It never waits for the worker. The
  session name is at most `MAX_SESSION_NAME` code points, declared on the schema as `maxLength` and
  refused by the bridge past it: the name is a key in the state file every bridge on the machine
  shares, and that file is refused whole past its own ceiling, so an unbounded name would be one
  prompt away from wedging persistence for every bridge in every scope.
- `dsh_status(session)` reports the session's record, its DSH session id, workspace and turn count, as
  the state file has it at the call for a name this bridge has not prompted, so a neighbour bridge's
  advance of such a name is what it shows, and from this bridge's own copy for a name it has prompted,
  along with this bridge's own view of whether it holds a running worker for the session and whether
  a turn is in flight, and what the session's log on disk records, including the permission preset,
  sandbox mode and approval policy as the session log records them. That log is written by the
  worker's own unsandboxed runtime, so the three knobs are its account of its confinement rather
  than an authority over it. When the reader could not read the log whole, a `log_unread_bytes` line
  names how much it left and says the counts cover the readable part. The counts are read under
  `MAX_STATUS_LOG_BYTES`, a ceiling well under `dsh_tail`'s, because the read happens on every status
  call on the event loop that delivers every channel event; a log past it, or one the reader could not
  open at all, leaves the counts out and the `log:` line says why, while the state, the in-flight bit
  and the turn count, which come from the child, are reported as usual.
- `dsh_busy()` says whether any session has a turn in flight, and which. It is the check before
  starting anything that contends with the worker for the machine.
- `dsh_tail(session, count?, kinds?)` returns the last events of the session log, for the session id
  the state file names at the call, one bounded line
  each, dropping the four streaming chunk types (`assistant/chunk`, `text-chunks`,
  `tool-call-chunks`, `reasoning-chunks`) by default. On the on-disk log those are top-level event
  types, and the packed rows are the most numerous lines in a busy session's file, so a default
  that admitted them would fill the tail with deltas. `count` is a positive number: zero and a
  negative are refused, a fraction below one floors to 1, a value past `MAX_TAIL_COUNT` is clamped
  to it, and `kinds` is an array naming at least one
  event type or is refused, since an empty allow-list would drop every event and report a full log as
  empty and a non-array would silently fall back to the default filter.
  Each line is the worker's runtime's own text, so it is neutralized as the channel body is: the
  hidden class becomes `?`, a forged harness tag is disarmed, and the line is cut with a `~`; the
  JSON's own quotes and brackets stay, because the line is JSON the model reads as JSON.
- `dsh_kill(session)` terminates the worker process. One worker serves every session this bridge
  owns, so it stops that one worker whatever session is named and every turn in flight ends with it,
  each reported as a `killed` event; a name this bridge does not know still stops a running worker,
  which is what keeps an unsandboxed child reachable after a refusal took its record away. The
  session logs survive and the next `dsh_prompt` for a name resumes the same conversation in the
  same workspace.

## The channel event

One event per finished turn, whose `content` is the worker's own last text, cut at
`MAX_CHANNEL_CONTENT`, and whose `meta` carries `session`, `kind`, `turn`, `finish_reason`,
`files_touched` and `commands_run`. Every value is a string, because Claude Code drops a meta entry
that is not one, and every key is a plain identifier for the same reason. `kind` is `turn_end` for a
turn the runtime reported `completed`, `error` for every other ending, and `killed` for one
`dsh_kill` ended while it was running; the runtime's own word for the ending is in `finish_reason`
either way. A kill with no turn in flight emits nothing, and so does the bridge's own shutdown, the
session it would push to being gone.

A turn ends on the session's first idle status **after** the runtime has confirmed which queued
message it is running, which it does by splicing that message into the session's inbox. An idle
before that confirmation belongs to whatever the session was doing when the prompt arrived, and
ending on it would push an empty answer and leave the real one with no turn to reach.

A prompt request the runtime never answers within its bound ends its turn there, as an `error` event
with `finish_reason` `unattributed` and an empty body, and the tool call fails with a sentence saying
so. The timeout is the SDK client giving up its wait; the wire has no cancel and the SDK documents
nothing about what the runtime does with the request, so the runtime may be running the prompt, may
be about to, or may have hung before it read the message. Either way the bridge never learns the
queued message id, so nothing the session does afterwards can be told apart from work it was already
doing; a turn left in flight would wait on an idle it could never attribute, or on one that had
already come and gone. The session's record is kept and the turn counted, on a first prompt as on any
other, so the next prompt for the name resumes the same session id, and `dsh_tail` reads what the
worker did with the unanswered prompt where a log exists. On a first prompt the id was minted a
moment earlier by the SDK and the runtime may or may not have opened a session for it. What the
runtime does when prompted again under an id it never opened is unmeasured: the bridge's design
infers nothing from it, the SDK's own documentation states that an unknown id creates the session
(`@deepseek-ai/dsh-sdk-client/lib/index.js:335`, `lib/types/client.d.ts:92`), no run has observed the
runtime either way, and section 5's live run is where it is observed. The record is kept because the
two branches are not symmetric under that uncertainty: kept, an id the runtime refuses costs one name
its conversation, recovered by prompting under a different name; forgotten, an id the runtime is
running the prompt under has the next prompt mint a second one, and two unsandboxed workers then
write one workspace at once.

The body is a boundary under one of Claude Code's own. The product, as read at build 2.1.263, the
build `fixtures/claude-code-reader.ts` copies its tables from, renders the event as a `channel` tag
whose attributes it XML-escapes and whose body it passes through a close-only disarmer that rewrites
a closing `channel` tag, skipping a filler class of roughly 4,700 code points between the tag's
letters and folding the bracket lookalikes onto their ASCII forms. Three shapes that disarmer does
not reach are what the bridge's own layer is for: a forged tag that is not `channel`, an opening
`<channel ...>` rather than a closing one, and a `channel` tag whose letters are themselves fullwidth
or other lookalikes, which the product matches literally. The bridge's layer is also the only one on
a build that lacks the product's; which other builds carry the product's layer is not established
here, since one build is the only one that was read.

The builder spells a forgeable tag harmlessly, replacing the leading `<` with a `?` and touching
nothing else, so the worker's words arrive as it wrote them. What reads the result is a model rather
than a parser, so a spelling is judged as that reader resolves it: `</ CHANNEL>`, a tag with a
zero-width space or a Hangul filler inside its name, and a tag in fullwidth letters or behind a
fullwidth `＜` are all the tag, and all are neutralized. Each code point is resolved through the
delimiter map, then NFKD, mark-stripping, NFKC and case, at the match and never in the text itself,
so the body keeps its own bytes; a confusable, a Cyrillic `с` for the Latin `c`, is a distinct
letter with no fold and is outside every code-point class, which is where this guard's reach ends.

Claude Code XML-escapes each meta value into an attribute of the envelope it wraps the event in, and
the bridge's layer sits under that, so **every** value the builder emits is neutralized and bounded
whether or not the layer above is present on the running build: the hidden class, the `<>&"'` class
and any code point that resolves to one of those all become `?`, a value past `MAX_META_VALUE` is
cut with a trailing `~`, and `finish_reason` is cut at `MAX_META_REASON` because a reason is one
word. Each path in `files_touched` is neutralized against the comma too, that being the list's own
separator, and cut at `MAX_META_FILE_LENGTH`. Who wrote a value is not what decides this: a name the
calling model chose and a word copied off the runtime wire are the same class as the worker's text.

The classes a hostile character is read through have one definition each, in `reader-class.ts`: a
hidden class replaced in attributes and refused in paths, and a wider filler class skipped while
spelling a tag name, both Unicode property expressions rather than enumerated ranges. Every boundary
derives from them rather than spelling a class of its own, and both the attribute path and the body
path resolve a code point through one resolver, so the two cannot come to disagree about what a
character means. The one enumerated table is the delimiter-lookalike map, carried as data with the
build it was copied from. The guard's test takes its yardstick from a fixture of the product's own
classes rather than from the guard: it asserts that the bridge's filler contains the product's, that
the filler and the visible classes cover the code space between them (they are not disjoint: a
default-ignorable point Unicode also assigns as a letter, such as U+3164, is in both), and that no
spelling the fixture's reader resolves to a tag survives the guard, with enumerated spellings kept
beside the property as regression pins rather than in place of it. The fixture supplies the filler
and lookalike halves of that yardstick; its letter fold is the guard's own pipeline restated, since
the product folds no letters, and section 5's live probe is what measures that half.

`files_touched` and `commands_run` describe this session's own tool calls and nothing else.
`files_touched` names the files written through the runtime's file-writing tools (`write`, `edit`,
`str_replace_editor`) and `commands_run` counts its shell tool calls (`pwsh` on Windows, `bash`
elsewhere). A file written by a shell command is in neither, and neither is anything done by a
subagent the worker spawned, which runs as a session of its own that this bridge never prompted. The
worker runs unsandboxed, so the receipt is a summary of what the session declared rather than an
account of what happened on the machine; the session log holds the rest.

A turn retains `MAX_META_FILES` paths and one more, and counts everything past that, because a
worker looping over a large tree is the ordinary case here and every path is worker-chosen text held
for the length of the turn. The `+N` tail names that count, which is deduplicated against the
retained paths and not against itself: a worker rewriting one unretained file in a loop is counted
once per write, telling a repeat from a new path past the bound being the memory the bound refuses.
The tail also counts a written path the receipt cannot spell relative to the workspace: one on
another drive, on Windows one rooted at no drive, or one outside the workspace on its own drive,
whose relative spelling would leave the workspace and then name the rest of this machine; each would
put this machine's shape into an attribute that promises the workspace's. A relative path is resolved
against the workspace before that rule is applied, so a relative spelling that begins by leaving the
workspace is counted exactly as the absolute spelling of the same place is, and one that stays inside
it is spelled resolved. Paths are neutralized once, by the event builder, so two distinct long paths
stay two entries.

## Sessions, workspaces and state

The caller names sessions and the bridge maps each name to a DSH session id and its workspace, in
`%LOCALAPPDATA%\sapplefeld-channels\dsh-bridge\sessions.json`, so a kill or a restart resumes the
same conversation. The `initialize` handshake is process-wide and the sandbox
policy's root is the runtime's own working directory, so **one bridge holds one runtime and one
runtime serves one workspace**: the first prompt binds it, and a new session naming a different
workspace is refused until `dsh_kill` frees the binding. **A session name's workspace is fixed for
the life of its conversation**, bound runtime or not, because a DSH session's log is filed under the
workspace it was created in and pointing the name elsewhere would abandon the conversation this file
exists to preserve. Whether the runtime would itself refuse the id in another workspace is inferred
rather than observed, and the binding does not rest on it: a refused id leaves the name a
conversation it cannot reach, and an accepted one leaves two workers on a single name. A different
workspace takes a different session name.

That file is one path per machine and a bridge is a child of every Claude session that names the
plugin, so it is keyed by scope first and by session name inside it. A scope is the directory the
bridge process was started in. That this is the project directory of the Claude session that started
it is inferred rather than observed, and section 5's live run is what observes it; if it does not
hold, every bridge on the machine shares one scope and two projects naming one worker read one
record. The directory is resolved and on Windows folded to one case by the same rule the workspace
comparison applies, since one directory there is named by every casing of its path and two sessions
launched with the project spelled in two cases are one project: two projects both naming a worker
`builder` keep two records, and a restarted bridge resumes its own conversation rather than a
stranger's.

**One bridge per scope and session name is the operator's arrangement, and the bridge guards nothing
about a second one.** Two Claude sessions in one project directory driving one worker session name at
the same time is operator error rather than a case the bridge defends against: the state file carries
no ownership lease, no process-liveness check and no claim protocol between bridges, and a second
bridge with no record of a name adopts the file's record for it exactly as a restarted bridge does,
since the two are the same read.

The file is re-read under each write, this bridge's record for the one name the write concerns is laid
over what is there, and the write goes to a sibling and is renamed over the file so a crash cannot
truncate it. A file that is present and does not read as a session map under this version's rules,
past `MAX_STATE_BYTES`, not JSON, or not the shape this version writes, is not written over at all:
the write refuses, the refusal is logged, and the file is left for the operator, because what it holds
is other bridges' records and the rename would replace them with one scope. A file that is absent is
created with an exclusive create rather than a rename, so a reading of absent that was wrong, or a
neighbour creating the file between the read and the write, cannot replace a file that is there;
absent is `ENOENT` from the stat or the read and nothing else, since an existence check answers false
to every error and would read a present file this process cannot open as absent.

What the write does enforce is a **compare-and-set on the conversation identifier**: a write refuses
to lay a different DSH session id over a name whose entry already carries one, and reports the name
as superseded. The identifier is the runtime's, never the bridge's, so a name resumed off the file
compares equal to itself and a name this process was running compares unequal where the file has since
been given another conversation under it. An entry the reader would not admit as a session is treated
as free rather than as another conversation, since treated as another it could never be replaced. What
this buys is a property of the file's own contents: this bridge never silently replaces the identity of
a name it is running, never writes a turn count against a conversation it is not running, and where two
bridges both read the file as absent and both mint, the exclusive create refuses the loser's write and
its caller is told. Where the file is present the write takes no lock, so a write whose read lands
inside another write's parse-to-rename interval lays over it with neither caller told, and two bridges
writing the one file is the case that interval belongs to. It is not a guard against a second bridge,
and the case of two sessions whose scope keys have collapsed to one directory is not handled by it:
a bridge with no record of the name adopts what the file says.

A superseded refusal at the prompt drops this process's claim to the name as it is raised, so the
refusal's advice is true: the next prompt for the name reads the file and resumes the conversation it
names, or a different session name starts a new one. The same refusal at a turn's end costs the count
and drops the claim in the same way, said in the log.

The record for a name is written before the prompt for it goes out, with the count as of the last turn
that finished, and the turn in flight reaches the count only when it ends and the runtime is known to
have taken it. A prompt that fails after that write, refused by the runtime, killed, lost under its
request, or superseded at the write, gives the name back on disk as in memory: the record goes back to
the record as this bridge read it before the prompt, or the entry is removed where there was none, and
only where the file still carries the session id the prompt wrote, so an entry naming another
conversation is left as it is.

The write is two acts, a read and a publication, and a failure of each is decided on its own. A
prompt whose **read fails**, because the file is present and does not read under this version's rules
(past `MAX_STATE_BYTES`, not JSON, not a session map, or refused by the filesystem), **is refused**
before the runtime is started, and again at the write if the file turns unreadable in between: nothing
was compared and nothing was published, and every bridge in the project meets the same file. The
refusal names which fault it was and carries neither the file's path nor its bytes. For a filesystem
refusal it says to prompt again first, since a neighbour or a scanner holding the file clears on its
own, and to hand the file to the operator only if it persists; for a file past the ceiling, not JSON or
not a session map it says the condition does not clear by itself. A write whose **publication fails**
after a clean read, because the sibling could not be written or the rename over the map was refused
while a neighbour holds it, is said in the log and **the prompt goes on**, since that failure clears in
milliseconds and refusing every prompt over it would cost the model its worker for as long as the
neighbour keeps the file. The write at the turn's end is best effort in every case, since that turn is
over and a lost count harms nobody; the log names the failure by its code, or by the reader's own
reason where the reader refused the file.

`dsh_status` and `dsh_tail` report a name this process never prompted as the file has it at the call,
so a neighbour's advance of such a name is what they show; a name this process has prompted is
reported from this process's own copy, which every write of it came from.

Every entry the file already holds, in this scope and in any other, is carried through a write exactly
as it was parsed, never through this version's shape rules, and this bridge's own record is laid over
its scope's entry by name: a record another bridge wrote in a shape this one refuses is still that
bridge's memory of a live conversation.

Every field of a stored record is shape-checked when the file is read, because the state file is a
file on disk that anything running as this user can write: the session id against the shape a
runtime mints, since it names a directory under the harness home; the workspace and any record path
against the same guard a caller's own `cwd` takes; and the turn count against being a whole,
non-negative number. A record that fails the first two is not used and stays in the file as it was,
which costs one name its `cwd` on the next prompt. Each refusal is said once per bridge process rather
than on every read, since the file is read on every tool call and the record it refuses never leaves
it.

A workspace path is admitted only if it names one place on this machine: absolute, drive-rooted on
Windows, carrying nothing from the hidden class (`isHidden`, which covers the control characters,
the zero-width family and the bidirectional overrides), within a length bound, and never a
`\\host\share` or `//` path. The state file itself is refused whole past `MAX_STATE_BYTES`, since
it is read whole at construction and on every write. `path.isAbsolute` is true of a UNC path, and the first filesystem call on one opens an outbound
SMB connection to a host the caller named, carrying the operator's credentials, before any refusal
could run; the same string would then be an unsandboxed child's working directory. A mapped drive
letter is outside that guard: `Z:\x` is drive-rooted, so a share mapped with `net use` or a path
grafted on with `subst` is admitted and reaches `statSync` against whatever the operator mapped it
to, which is the operator's own mapping rather than a host the caller named.

The runtime launcher is checked for at the first spawn rather than at startup, so a bridge whose
`bridge/runtime/` install is missing still registers its channel and answers `dsh_prompt` with the
sentence naming the `npm ci` that fixes it.

## Files

- `index.ts` wires the MCP server and is the entry point Claude Code spawns.
- `protocol.ts` holds the tool schemas, the event builder, the bounds, and the `instructions` string.
- `harness.ts` owns the runtime child, the session map, the turn state machine, and the receipt.
- `log.ts` reads a session log off disk, frame by frame.
- `env.ts` names the runtime launcher and the patch, provider and model it is started with, checks
  that the launcher is installed, and builds the child environment. Both the bridge and the spike
  spawn through it, so the guard on what a worker process is handed has one copy; it imports neither
  of them, so either can use it without loading the other.
- `fake-dsh.ts` is the stand-in runtime the tests drive; no test touches a model, a port, or the
  operator's harness home.
- `tools/sdk-smoke.ts` is the by-hand spike that captured `fixtures/`, run against the real worker.
- `runtime/` is the launcher's own single-root install, installed with `npm ci` in that directory.
  It is a process to spawn, never a module to import: co-installing it beside the SDK client mints
  several physical copies of the tool packages, and the scheduler registry is keyed on a `Symbol()`,
  so the runtime then executes no tool at all.

A session log is a container of concatenated Zstandard frames, one per append. Node's
`zstdDecompressSync` stops after the first of them, so `log.ts` walks the container frame by frame,
taking each frame's length from its own header and dropping a trailing frame the buffer is too short
to hold. The length comes from the header rather than from a search for the next frame magic,
because those four bytes occur inside compressed payloads: a boundary taken from one of them cuts a
frame in half and silently loses every frame after it. Whatever stops the walk short, a torn tail, a
frame that will not decode, one past the per-frame plaintext ceiling, one that would pass the
whole-container plaintext budget, or bytes that are not a frame, the bytes it left are counted and
reach `dsh_status`, so counts taken over a prefix are never reported as counts of the whole.
