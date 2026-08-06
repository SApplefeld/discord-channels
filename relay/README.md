# relay/

The MCP channel server: a stdio child of one Claude Code process.

It declares `claude/channel` and a `reply` tool, joins the broker by the `CHANNEL_PROCESS_TOKEN` it
inherits from the launch wrapper, and carries messages both ways over the broker's loopback
listener. `claude/channel/permission` and the verdict path are Section 6's.

A channel server is never told what session it belongs to: the protocol hands it `content` and a
`meta` bag it authors itself, and a channel is a child of the *process*, so a `/clear` mints a new
session underneath it without its knowing. Identity therefore travels over hooks, and the broker
does the join. That is also why an outbound reply carries no address: it is routed to whichever
session the process token currently holds, which is what lets an unprompted reply land correctly.

- `index.ts` wires the MCP server and is the entry point Claude Code spawns.
- `protocol.ts` holds the notification shape, the tool, and the `instructions` string.
- `broker.ts` speaks the loopback wire: a held-open stream in, a reply POST out.

Registering it with a session takes two things: an MCP server entry named `channel-relay`, and that
name passed to `--channels` (or, where the relay is not allowlisted, to
`--dangerously-load-development-channels`). The reply tool's allow rule ships in
`hooks/settings-fragment.json` and names the server, so the two have to agree;
`reply-permission.test.ts` is what holds them together.
