# Interim Mirroring: Mid-Turn Visibility on Long Turns

Status: Draft
Commit Model: undecided (set when the effort is picked up)
Created: 2026-08-07

## Problem

On a long turn, the operator watching the Discord thread sees nothing between their prompt and the
turn's final reply, which can be many minutes later. Two gaps, reported together on 2026-08-07:

1. **Mid-turn assistant text never mirrors.** The text the model writes between tool calls (intent
   narration, findings, status notes) is carried by no hook payload: `UserPromptSubmit` carries the
   prompt, `Stop` carries only `last_assistant_message`, the turn's final text. The broker cannot
   mirror what never reaches it.
2. **The card names the last tool without its input.** "Last tool: Bash" says something is running
   but not what; on a multi-minute command the operator cannot tell a build from a hang.

## Mechanism

### Interim assistant text: tail the session transcript

Every hook payload carries `transcript_path`, the session's local JSONL transcript, and the broker
runs on the same host as every session it watches, so the file is readable where the broker already
is. This is the one place mid-turn text exists.

Design sketch, to be firmed when the effort is picked up:

- The intake records `transcript_path` per session as hook events arrive (a payload field like any
  other; path stored, never trusted as content).
- A tailer owned by the broker polls the transcripts of live sessions on a modest interval (order
  of tens of seconds, budget-aware), holding a byte offset per session. New complete JSONL lines
  past the offset are parsed; assistant text blocks are extracted. Thinking blocks, tool calls,
  tool results, and subagent traffic are excluded, mirroring the Stop hook's own exclusions.
- Extracted text posts to the session's thread through the existing mirror writer and renderer
  with its own attribution (distinct from the final reply's `✨ Claude`, e.g. `✨ Claude · working`),
  so interim narration and the final answer read differently at a glance.
- **Dedup with the Stop mirror:** the turn's final message arrives twice, once as the tail of the
  transcript and once in the Stop payload. The tailer remembers what it posted for the current
  turn; when Stop's mirror delivers, text already posted verbatim as the last interim chunk is
  skipped (or the interim chunk is skipped when Stop is known to be imminent; pick one at
  implementation time and pin it with a test). The failure mode to design against is the operator
  reading the same paragraph twice at the exact moment the turn ends.

### Current activity: a bounded input preview on the card

Hook payloads on tool events carry the tool name and input. The card's `Last tool:` line gains a
bounded, neutralized preview of the input (the Bash command line, the file path being edited),
rendered through the existing `inertText` escape with the permission prompt's cut-marker discipline
(`promptField` in `render.ts` is the sibling to mirror). Bound it hard: one line, order of 100
characters, cut marked when cut.

Card-edit volume is the cost: the preview changes on every tool call, and every change is an edit
against the card's budget. Acceptable because the edit budget already absorbs heartbeat ticks;
confirm at implementation time that a busy session does not starve other sessions' card edits, and
coarsen (edit at most every N seconds) if it does.

## Security posture

- Transcript content and tool inputs are untrusted text, same trust class as mirrored prompts and
  replies. Everything reaches Discord through the existing render escapes (`renderMirror`-family
  for messages, `inertText` for card fields); nothing bypasses them, and no new escape is written.
- Transcript content never appears in the broker log at any level (the standing mirror rule).
- The tailer reads only paths learned from hook payloads for sessions the registry holds live, and
  it stops reading a session's transcript when the session ends.
- A transcript is the session's whole conversation; the tailer must post only what the design
  names (assistant text of the current turn), never tool results or embedded file contents, which
  the operator did not ask to have published to Discord.

## Deliberately out of scope

- No queueing and no replay: an interim chunk that cannot be posted now (budget, closed thread) is
  dropped, consistent with the whole routing layer. Late narration answers a question the operator
  stopped asking.
- No subagent transcripts.
- No configuration surface beyond an on/off knob (`CHANNEL_INTERIM_MIRROR`, default decided at
  implementation) and possibly the poll interval; every other bound is a constant with a comment.
- No change to the permission-prompt or reply-tool paths.

## Open questions for the implementing session

- Poll-based tailing versus `fs.watch`: polling is simpler and the latency bar is low; confirm
  polling cost against the number of live sessions before choosing watch.
- Whether interim mirroring is per-session opt-out like the mirror (`X-Channel-Mirror` header
  parallel) or global-only.
- The exact JSONL schema of the transcript (verify against a real transcript before parsing;
  treat the schema as an external contract that changes silently, like the channel envelope).

## Chapters

(none; not yet started)
