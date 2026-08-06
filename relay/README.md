# relay/

The MCP channel server: a stdio child of one Claude Code process.

It declares `claude/channel` and a `reply` tool, joins the broker by the `CHANNEL_PROCESS_TOKEN` it
inherits from the launch wrapper, and carries messages both ways over the broker's loopback
listener. A relay that holds a token also declares `claude/channel/permission`, which is what makes
Claude Code route a tool permission prompt at it; the prompt goes straight to the broker, and the
operator's answer comes back down the stream as the verdict Claude Code is waiting on. A relay
without a token declares only `claude/channel`, because a prompt aimed at a server that cannot
reach the broker is a prompt nobody is asked.

A channel server is never told what session it belongs to: the protocol hands it `content` and a
`meta` bag it authors itself, and a channel is a child of the *process*, so a `/clear` mints a new
session underneath it without its knowing. Identity therefore travels over hooks, and the broker
does the join. That is also why an outbound reply carries no address: it is routed to whichever
session the process token currently holds, which is what lets an unprompted reply land correctly.

- `index.ts` wires the MCP server and is the entry point Claude Code spawns.
- `protocol.ts` holds the notification shape, the tool, and the `instructions` string.
- `permission.ts` holds the two permission methods, the capability set, and the request schema.
- `broker.ts` speaks the loopback wire: a held-open stream in, a reply or a prompt POSTed out.

Registering it with a session takes two things: an MCP server entry named `channel-relay`, and that
name passed to `--channels` (or, where the relay is not allowlisted, to
`--dangerously-load-development-channels`). The reply tool's allow rule ships in
`hooks/settings-fragment.json` and names the server, so the two have to agree;
`reply-permission.test.ts` is what holds them together.
