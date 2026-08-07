# broker/

The per-host daemon: owns the Discord bot token, the gateway connection, the session registry, and
the three surfaces (thread name, starter message, new messages).

`broker/tail.ts` polls each live session's own transcript file for the assistant text written
between tool calls and posts it to the session's thread under its own attribution, deduplicated
against the mirror's post of the turn's final reply.
