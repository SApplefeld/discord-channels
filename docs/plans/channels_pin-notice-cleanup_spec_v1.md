# The channel stops filling with pin notices

Status: In Progress
Commit model: Review-Only (commit when the operator asks)

## Why

Discord posts a system message every time a message is pinned, and there is no way to suppress it.
The broker reconciles the channel's pin list every pass, so pins come and go honestly, while the
notices behind them are append-only. The result is a channel whose thread list is buried under
notices about pins that are no longer pinned.

The asymmetry is the defect: the thing that is reconciled stays true, and the thing that is not piles
up in front of it.

## What ships

Each pin notice this broker causes is deleted as it arrives. Nothing else is touched.

The notices already accumulated are the operator's to clear by hand. A sweep over channel history was
offered and declined, deliberately: a predicate proven on messages we watched arrive is worth more
than one pointed at history before it has been watched at all.

## The predicate

Three conditions, all required, and nothing else ever deleted:

1. The message is in this host's configured channel, and not in a thread.
2. Its type is Discord's channel-pin-notice system type.
3. Its author is this bot's own user.

Each condition is load-bearing on its own. Two brokers can share a guild, so the channel check is
what keeps one host from deleting in another's channel. The type check is what keeps this from
touching a real message. The author check is what keeps a pin the operator made by hand, and the
notice it produced, out of scope, which is the same rule the pin keeper already holds for a pin added
by hand.

## What this is not allowed to become

Deletion is irreversible and this is the operator's own channel, so the failure that matters is not a
notice surviving, it is a real message being removed. Nothing here reads a message's content, and
nothing widens the predicate to tidy up around the pins.

## The routing gate this opens

`broker/routing/gateway.ts` drops every message that is not in a thread, and does so deliberately:
inbound routing exists to deliver into sessions, and a parent-channel message has no session to reach.
Pin notices land in the parent channel, so this needs a path for a class of message that filter
currently closes.

That path must be a dead end. A parent-channel message must reach the delete decision and nothing
else, and in particular must never reach the inbound-to-session route, the sender gate's steering
path, or the permission verdict reader. The thread filter stays exactly as strict for everything it
guards today.

## Permission

Deleting one's own message needs no Manage Messages grant, so this is expected to work on the six
permissions `install.md` already asks for plus the optional Pin Messages. That is inferred rather
than measured. If a refusal says otherwise, the fallback is a channel-level Manage Messages override
on the broker's own channel and never a server-wide grant, and `install.md` gains that note.

A host without Pin Messages pins nothing, so it produces no notices and this does nothing at all.

## Failure

A refused delete costs a notice that stays in the channel, which is exactly the state today. So it is
one rate-limited log line and never a retry: the notice is cosmetic, and the budget it would spend is
shared with the writes that reach a phone.

## Gate

`npm test` stands at 1145 tests, 1144 pass, 1 skipped, 0 fail. The skip is the POSIX token-file
platform gate. `broker/tail.test.ts` carries a documented intermittent under load, recorded in
`docs/backlog.md`; a single failure there is not this round's.

Each of the three predicate conditions needs a test proving it is necessary: a message failing only
that condition must survive. A test that only proves the happy path would pass against a predicate
that deletes everything.

What no test can settle: that Discord accepts the delete on the permissions this install grants, and
that the notices actually stop appearing. That is one look at the channel after a session starts.

## Sections

### Section 1: the delete verb

The transport gains a delete for a message in the host's channel, beside the existing `unpin`.

### Section 2: the recognizer and the dead-end path

The gateway recognizes a pin notice ahead of the thread filter and routes it to the delete, with the
thread filter unchanged for everything else.

## Chapters

### Chapter 1: both sections, and the absence that had to be made visible

The transport gained a message delete beside its `unpin`, and the gateway's `MessageCreate` handler
became a switch over one pure decision function. Putting the whole predicate in that function is what
makes the dead end structural rather than incidental: it answers `deliver` only inside its in-thread
branch, and the handler holds no conditional of its own, so the inbound route has no independent path
to reach. A test walks every shape a parent-channel message can take and asserts none of them
delivers.

Each of the three delete conditions has a test proving it is necessary, and each was watched red
against a copy of the file with that condition removed. A happy-path test alone would have passed
against a predicate that deleted everything in the channel, which is the failure worth designing the
tests around when the action is irreversible and the channel is the operator's own.

The implementer named the risk that mattered, against its own work: this broker pins on Discord's
message-scoped route, which is newer than the notice type the predicate matches, and whether that
route still emits the classic type is inferred rather than measured. If it does not, the cleaner
deletes nothing and says nothing, and an absence of notices being removed reads exactly like the
feature working.

That is the same shape as the round before it, where a null measurement was only evidence because the
instrument was proven able to fire. So a fourth decision was added: a system message this bot wrote in
its own channel that is not the pin notice is named once per type in the log. An ordinary message is
dropped in silence, because the broker's own session cards are posted here every time a session opens
and reporting those would bury the line worth reading. If the inference is wrong, `broker.log` carries
the real type in one line rather than leaving anyone to re-derive it.

### What is still open

Three things no test can settle, all one look at a live channel: that Discord accepts the delete on
the permissions this install already grants, that the notices stop appearing, and that no real message
disappears. If the notices continue, the log line above names the type to match instead.
