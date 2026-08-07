// The one place the registry's lifecycle vocabulary and the thread-name vocabulary meet, plus the
// narrowed view of a session that the Discord surfaces are allowed to see.
import type { SessionRecord } from "../registry.ts";

/** What a thread name and the status card say about a session. */
export type SurfaceState = "working" | "needs you" | "idle" | "exited";

/**
 * Everything the surfaces render, and nothing else.
 *
 * Built field by field rather than by copying a `SessionRecord`, so a field added to the record has
 * to be surfaced deliberately instead of arriving here on its own. `processToken` is the forgery
 * key for hook posts, and a card that serialized a whole record would publish it to a Discord
 * channel.
 */
export type SessionView = {
  sessionId: string;
  name: string | null;
  host: string;
  lastTool: string | null;
  /** A bounded preview of what that tool was called with, or null when it had none. */
  lastToolInput: string | null;
  turnCount: number;
  /** Timestamp of the most recent hook event, which is what the heartbeat and idleness read. */
  lastHookAt: number;
  endedAt: number | null;
  /** True while the session is blocked on a permission verdict. Fed by the permission relay. */
  needsAttention: boolean;
  /** The registry's own lifecycle state, mapped to a surface state by `deriveSurfaceState`. */
  lifecycle: SessionRecord["state"];
};

export function toView(record: SessionRecord, needsAttention = false): SessionView {
  return {
    sessionId: record.sessionId,
    name: record.name,
    host: record.host,
    lastTool: record.lastTool,
    lastToolInput: record.lastToolInput,
    turnCount: record.turnCount,
    lastHookAt: record.lastHookAt,
    endedAt: record.endedAt,
    needsAttention,
    lifecycle: record.state,
  };
}

export type StateThresholds = {
  /** A live session with no hook traffic for this long renders idle rather than working. */
  idleAfterMs: number;
  /** A session silent for this long is presumed dead and renders exited. */
  exitedAfterMs: number;
};

/**
 * Maps a session onto the four states the surfaces render.
 *
 * - `ended` renders `exited`, whatever ended it.
 * - A session that has been silent past `exitedAfterMs` also renders `exited`. This is the
 *   heartbeat backstop, and without it a hard-killed session is indistinguishable from a quiet
 *   one forever: a kill fires no hook, and until the relay exists nothing but a `/clear` ever
 *   marks a record ended. It outranks attention because a session that stopped answering has
 *   stopped waiting for one.
 * - Attention wins over the two live states. It is the one state that is waiting on a person, so
 *   it is worth a rename even mid-flap.
 * - `live` splits on hook recency: traffic within `idleAfterMs` is `working`, anything older is
 *   `idle`. Hooks are the only activity signal the broker has.
 * - `stale` renders `idle` until the backstop fires. Staleness means no hook traffic and no relay
 *   liveness for the registry's own window, so the process may well still be running and simply
 *   not doing anything observable. Claiming a death that soon would be claiming one nobody saw.
 *
 * Only a stale record can reach the backstop, so relay liveness holds a session out of it for
 * free: a record the registry still calls live is one something has heard from.
 *
 * The three windows are ordered, and `loadDiscordConfig` refuses a configuration where they cross.
 * `idleAfterMs` below the registry's `staleAfterMs`, or a live record is marked stale before it
 * could ever render `idle`; `exitedAfterMs` above it, or every stale record is instantly dead.
 */
export function deriveSurfaceState(
  view: SessionView,
  now: number,
  thresholds: StateThresholds,
): SurfaceState {
  if (view.lifecycle === "ended") return "exited";
  if (view.lifecycle === "stale" && now - view.lastHookAt >= thresholds.exitedAfterMs) {
    return "exited";
  }
  if (view.needsAttention) return "needs you";
  if (view.lifecycle === "stale") return "idle";
  return now - view.lastHookAt <= thresholds.idleAfterMs ? "working" : "idle";
}
