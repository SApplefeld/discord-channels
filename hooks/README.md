# hooks/

Session-lifecycle hooks, carrying two different things to the broker over four events and five
hooks. `SessionStart` announces identity, and `PostToolUse` and a `Stop` liveness tick feed the
status card, all three carrying no conversation content. `UserPromptSubmit` and a second `Stop`
entry are the mirror: they post their whole payload, which carries the console prompt and the turn's
final assistant reply, to the broker's content-bearing route.
