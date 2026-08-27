// The one place the registry's lifecycle vocabulary and the thread-name vocabulary meet, plus the
// narrowed view of a session that the Discord surfaces are allowed to see.
import type { BackgroundTask, ModelFallback, SessionRecord } from "../registry.ts";

/** What a thread name and the status card say about a session. */
export type SurfaceState = "working" | "needs you" | "blocked" | "idle" | "exited";

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
  /** The model running now, and the one the session opened with. Null until a line reported one. */
  model: string | null;
  openingModel: string | null;
  /** The live context size in tokens, rendered raw: the window is a per-model fact that can move. */
  contextTokens: number | null;
  /** The forced downgrade behind the current model, when one was read. */
  downgrade: ModelFallback | null;
  /** The work the session is waiting on, in the table's own order. Empty when it waits on nothing. */
  backgroundTasks: readonly BackgroundTask[];
  /**
   * What the session is trying to finish, from the most recent `/goal` command, and null for a
   * session running under none. Raw operator prose: the card is what bounds and neutralizes it.
   */
  goal: string | null;
  /**
   * The session's own title, as a `custom-title` transcript line last set it (launch `--name` or an
   * in-session `/rename`), and null for a session neither has touched. `displayName` prefers this
   * over `name` when it is set.
   */
  title: string | null;
  /** True while the session is blocked on a permission verdict. Fed by the permission relay. */
  needsAttention: boolean;
  /**
   * True while the session's latest kit goal event is a `goal-blocked` newer than its last
   * engagement, which is a run halted on the operator. Fed by the wiring that reads the kit event
   * stream, the way `needsAttention` is fed by the permission relay.
   */
  blocked: boolean;
  /** The registry's own lifecycle state, mapped to a surface state by `deriveSurfaceState`. */
  lifecycle: SessionRecord["state"];
};

/**
 * The signals no record carries. Both arrive from outside the registry, `needsAttention` from the
 * permission relay and `blocked` from the kit event stream, and they are named at every call site
 * rather than passed positionally: two adjacent booleans of the same type are transposable in
 * silence, and each of them drives a rename.
 */
export type ViewSignals = {
  needsAttention?: boolean;
  blocked?: boolean;
};

export function toView(record: SessionRecord, signals: ViewSignals = {}): SessionView {
  return {
    sessionId: record.sessionId,
    name: record.name,
    host: record.host,
    lastTool: record.lastTool,
    lastToolInput: record.lastToolInput,
    turnCount: record.turnCount,
    lastHookAt: record.lastHookAt,
    endedAt: record.endedAt,
    model: record.model,
    openingModel: record.openingModel,
    contextTokens: record.contextTokens,
    downgrade: record.downgrade,
    backgroundTasks: record.backgroundTasks,
    goal: record.goal,
    title: record.title,
    needsAttention: signals.needsAttention ?? false,
    blocked: signals.blocked ?? false,
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
 * Maps a session onto the five states the surfaces render.
 *
 * - `ended` renders `exited`, whatever ended it.
 * - A session that has been silent past `exitedAfterMs` also renders `exited`. This is the
 *   heartbeat backstop, and without it a hard-killed session is indistinguishable from a quiet
 *   one forever: a kill fires no hook, and until the relay exists nothing but a `/clear` ever
 *   marks a record ended. It outranks attention because a session that stopped answering has
 *   stopped waiting for one. It does not outrank `blocked`, the one state whose whole meaning is
 *   that the run deliberately stopped to wait: the operator sleeps longer than the backstop's
 *   window, and a run blocked overnight read as exited is exactly the misread the state exists to
 *   prevent (the operator chose this exemption 2026-08-21). The cost is that a session killed
 *   while blocked keeps its `⛔` until the registry lets the record go, which the operator prefers
 *   over the inverse.
 * - Attention wins over the two live states, and over `blocked`. Both are waiting on a person, and
 *   the ordering between them is nominal: a run that has stopped on the operator is not holding a
 *   permission prompt open, so the two do not stand at once in practice. Waiting on a person is
 *   worth a rename even mid-flap.
 * - `blocked` outranks the roster and both live states, because it too waits on a person: the run
 *   has deliberately stopped and nothing moves until the operator answers. Hook recency measures
 *   nothing about a session in that condition, which is exactly why it cannot be left to the
 *   branches below. It sits under `ended`, a real end being a real end whatever the run last said,
 *   and above the silence backstop, whose presumption of death is the misread a blocked run
 *   invites: silence is what blocked looks like.
 * - An outstanding roster is `working`, whatever the hook clock says and whether the record is live
 *   or stale. A session whose main thread is blocked on dispatched agents fires no hooks at all
 *   while it waits, so hook recency measures the wait rather than the work, and both branches below
 *   would read the busiest sessions as the quietest. It sits under attention and under the death
 *   backstop: a session waiting on a person is waiting on a person whatever its agents are doing,
 *   and a roster is a report from the last turn rather than evidence the process is still alive.
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
  // The backstop's one exemption: silence is what blocked looks like, so the presumption of death
  // is the misread this state exists to prevent. A record the registry really ends, or finally
  // lets go of, still exits above and in retirement.
  if (view.lifecycle === "stale" && !view.blocked && now - view.lastHookAt >= thresholds.exitedAfterMs) {
    return "exited";
  }
  if (view.needsAttention) return "needs you";
  if (view.blocked) return "blocked";
  if (view.backgroundTasks.length > 0) return "working";
  if (view.lifecycle === "stale") return "idle";
  return now - view.lastHookAt <= thresholds.idleAfterMs ? "working" : "idle";
}
