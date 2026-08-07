# Security model

What this system trusts, what it does not, and the risks it accepts deliberately.

The short version: anything that can post to the broker can eventually put text in front of Claude,
so the intake is the main attack surface, and every field crossing it is data rather than
instruction.

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
field added later has to be published deliberately rather than arriving on its own.

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
can steer every session on the host and approve any tool call it asks about, so that account's own
password, second factor, and the device its notifications reach are part of this trust boundary. The
gate says nothing about who is at the other end of it.

## Tool approval over the channel

**A permission prompt sends the tool's actual input off this machine.** `input_preview` is the shell
command, the patch body, the file path and its contents. The mirror is the other surface that sends
content off the machine: with `CHANNEL_MIRROR` on, every console prompt and every turn's final
assistant reply is posted into the session's thread in full. The log file records neither, and
mirror content never reaches it at any level. A prompt crosses to Discord's servers, is stored there under their retention, and is rendered on
a phone. **The sender gate governs who can write, not who can read**, so every member of the channel
sees every prompt. The channel must be private to the operator, and `install.md` says so.

The description and the input preview are written by a tool call, which anything the session has
read can influence, and they land in the one message this system deliberately pings with. They are
rendered as inert text with mention and chip syntax escaped, and each is cut to its own budget so it
cannot push the request ID and the answering instructions off the end of the message. A cut field is
labelled as cut, because otherwise an attacker-influenced input can front-load benign content and
push the part worth refusing past the boundary.

A verdict is bound to the thread it was typed in as well as to the five-letter request ID, and
answering consumes the request, so a verdict cannot be replayed or applied to a different open
prompt. A verdict naming nothing open is answered in-thread rather than dropped in silence: from a
phone, silence is indistinguishable from success.

A prompt reaches the broker over the same loopback route a reply does and is held to the same bar,
the per-attachment reply key. A process token is not enough. Without that, any of the subprocesses
that inherit the token could ring the operator's phone with an approval request of its own devising,
in the one message they are trained to answer quickly.

**A channel event tells the model that its sender is unverified.** The relay's instructions say so
explicitly and make no claim that a message came from the operator, because at that layer nothing
establishes who wrote it. Text arriving over the channel carries less authority than what the
operator typed at the keyboard, and the model is told that in the same breath as it is told the
events exist.

**The reply tool's allow rule is a machine-wide pre-approval.** `mcp__channel-relay__reply` is merged
into the user-level settings file, so it applies to every Claude Code session on the machine, not
only wrapped ones, and any MCP server registered under the name `channel-relay` has its `reply` tool
pre-approved with no prompt. The relay is registered per launch by the wrapper rather than at user
scope, so an unwrapped session normally has no such server, but a project `.mcp.json` in a repository
a session is working in can squat the name. The installer refuses to merge any permission rule
outside its own one-entry allowlist, which stops the fragment being used to widen this; it does not
stop the squat.

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

  **The permission prompt is the one write that deliberately mentions someone**, because its whole
  job is to reach a phone. It is not a widening: the empty `parse` list stays, and the prompt adds
  `allowed_mentions.users` naming exactly the one allowlisted operator ID, which is validated as a
  snowflake at load. The only mention syntax in the message is composed by the renderer from that
  ID. Content still cannot produce one.
- **The log file.** Untrusted fields pass through the same neutralization before they land, so a
  newline cannot forge a second log line and a bidi run cannot misdirect a reader.

**Conversation text is neutralized on a narrower rule than a name is.** A mirrored prompt, a
mirrored reply, and a `reply` tool call are prose with code in them, so escaping the whole of
markdown would trade the readability of the surface away. All three go through one fence-aware
escape that neutralizes Discord's angle-bracket chip syntax and a line-leading quote marker and
leaves the rest alone. `renderMirror` applies it to mirrored text and `inertReply` applies it to the
reply tool's, both before the text reaches the message path. That is what stops either from drawing
a mention pill, a timestamp chip, or a copy of the renderer's own attribution line, in the one
channel the operator answers permission prompts in.

The quote marker is escaped inside a code fence as well as outside it, so the attribution's
unforgeability does not rest on this project's reading of where a fence is agreeing with Discord's.
Where the two readings do differ, the cost is bounded to a chip left unescaped in a region this
project called code and Discord called prose, which `allowed_mentions` still keeps from pinging
anyone. Operator check E is what confirms the rendering half against the real client.

`processToken` never reaches either.

## Files that must not be writable

The `SessionStart` hook runs under `-ExecutionPolicy Bypass` at every session start, and the launch
wrapper is dot-sourced into the operator's interactive shell. **Write access to either is code
execution in the operator's context.** The bot token is a bearer credential: read access is control
of the bot, write access lets an attacker substitute a token and redirect the host's entire session
inventory to a server they own.

Two more things widen this. At every logon the scheduled task runs `install/Start-Broker.ps1` under
the same Bypass, which loads `install/Install-Functions.ps1` and executes `broker/`. And the merged
user settings name `relay/index.ts` as an MCP server command, so Claude Code executes the relay at
the start of every wrapped session. So the surface is every path on the execution chain, not a pair
of files, and **directories count as much as the files in them**: a hardened file in a directory that
permits delete-child can simply be deleted and re-created attacker-owned with a clean access control
list, which defeats the file's own permissions entirely.

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
  body. The broker drops the tool fields after parsing, but dropping after receipt is
  not the same as not transmitting: anything running as this user can read all of it off the
  loopback interface, and a local process that wins the race to bind the port before the broker
  starts sees it directly. The loopback bind and the `Host` check are what this rests on.
- **One allowlisted Discord user per host.** There is no multi-user model and no per-user
  permissions.
- **A session cannot be started or restarted remotely.** A channel injects into a running session; it
  cannot create one. This is a property of the mechanism, not a gap to close.
