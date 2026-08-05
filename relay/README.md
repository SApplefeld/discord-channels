# relay/

The MCP channel server: a stdio child of one Claude Code session. Connects to the broker, declares
`claude/channel` and `claude/channel/permission`, and exposes a `reply` tool.
