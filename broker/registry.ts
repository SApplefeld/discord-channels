// The session registry: the broker's whole model of what is running on this host. Hook events
// arrive already parsed and validated by the intake layer; nothing here touches HTTP.
//
// Records are retained forever within a run. "ended" and "stale" are state transitions on a kept
// record, not deletions, because a superseded session still owns a Discord thread that has to be
// renamed to its final glyph.

/**
 * Lifecycle as the broker can observe it. The working / needs-you / idle / exited vocabulary the
 * thread names use is a rendering concern and lives with the Discord surfaces.
 */
export type SessionState = "live" | "stale" | "ended";

export type SessionRecord = {
  sessionId: string;
  /** The GUID the launch wrapper minted for the Claude Code process. Joins hooks to a relay. */
  processToken: string;
  /** Human name from CHANNEL_SESSION, absent if the wrapper did not set one. */
  name: string | null;
  host: string;
  /** The SessionStart trigger: startup, resume, clear, compact, or fork. */
  source: string | null;
  state: SessionState;
  lastTool: string | null;
  /**
   * A bounded, neutralized preview of what the last tool was called with, so the card can say what
   * a multi-minute Bash call is running rather than only that one is. Null when the tool's input
   * carried nothing previewable, and written only in the same assignment `lastTool` is written in:
   * the two are rendered as one line about one call, so a preview that could move without the name
   * it belongs to would read as belonging to a call it never came from.
   */
  lastToolInput: string | null;
  toolCount: number;
  turnCount: number;
  startedAt: number;
  /** Timestamp of the most recent hook event for this session. */
  lastHookAt: number;
  /**
   * Timestamp of the most recent relay liveness signal, set by `relaySeen` when a pipe attaches
   * and on every heartbeat it answers. Null for a session no relay has ever attached to, which is
   * a session announced by hook posts alone: the wrapper starts a relay with every session it
   * launches, so the field is also the registry's only evidence that a record belongs to a real
   * launch rather than to any local process that knows the token.
   */
  lastRelayAt: number | null;
  endedAt: number | null;
};

export type HookEvent = "SessionStart" | "PostToolUse" | "Stop";

/** A validated hook post, reduced to the fields the registry keeps. */
export type HookIntake = {
  event: HookEvent;
  processToken: string;
  sessionName: string | null;
  sessionId: string | null;
  source: string | null;
  toolName: string | null;
  /** The previewable field of the tool's input, already cleaned, or null when it had none. */
  toolInput: string | null;
  /**
   * Where Claude Code writes this session's transcript, for the tailer to learn once the post is
   * credited. The registry itself never touches it: the path is held only in the tailer's own
   * in-memory map, never stored on a SessionRecord, never persisted, and never published.
   */
  transcriptPath: string | null;
};

export type RegistryOptions = {
  host: string;
  staleAfterMs: number;
  /** How long a terminal record is kept after it ended or went stale. Default 24 hours. */
  retainTerminalMs?: number;
  /** Ceiling on total records, held by evicting terminal records oldest first. */
  maxSessions?: number;
  /** Injected so a test can drive the stale transition without sleeping. */
  now?: () => number;
  /** Called after any mutation, with the full record set, so the caller can persist. */
  onMutate?: (sessions: SessionRecord[]) => void;
  sessions?: SessionRecord[];
};

export type Registry = {
  /** Applies a hook event. Returns the touched record, or null when the event was ignored. */
  apply: (intake: HookIntake) => SessionRecord | null;
  /**
   * True when this SessionStart is a subprocess announcing itself under a token a relayed session
   * already holds, which `apply` declines to register.
   *
   * `apply` answers null for every event it ignores, so the null alone cannot tell an expected
   * subprocess announcement apart from a post that reached no session at all. This is what tells
   * them apart, for a caller that reports one differently from the other. Nothing is mutated, so
   * the answer is the same before and after the `apply` it explains.
   */
  subprocessStart: (intake: HookIntake) => boolean;
  /**
   * True when this SessionStart names a session ID another process token still holds, which `apply`
   * refuses. The attempted takeover this refuses is a security event rather than routine traffic,
   * and it shares `apply`'s null with the routine drops, so a caller that reports it as its own
   * cause reads it here.
   */
  impostorStart: (intake: HookIntake) => boolean;
  /**
   * Marks overdue sessions stale, then prunes terminal records past the retention horizon and
   * evicts down to the record cap. Returns only the records that went stale; a pruned record is
   * dropped silently, having long since stopped being worth reporting.
   */
  sweep: () => SessionRecord[];
  list: () => SessionRecord[];
  /** The live or stale record currently held by a process token, if any. */
  current: (processToken: string) => SessionRecord | null;
  /**
   * Records that the relay running in this process is alive, which holds its session out of the
   * staleness sweep on a path independent of hook traffic. Returns the touched record, or null when
   * no session holds the token yet.
   */
  relaySeen: (processToken: string) => SessionRecord | null;
  /**
   * Marks one named session ended, which is what a relay's stdio closing and staying closed
   * signals. This is the death signal rather than a `SessionEnd` hook because a hard kill fires no
   * hook at all, and the relay's pipe closes either way.
   *
   * The session is named rather than looked up from the token because the two can disagree by the
   * time this runs: a `/clear` moves the token to a new session while the old pipe is still
   * closing, and ending "whatever this token holds now" would kill the replacement.
   */
  relayClosed: (processToken: string, sessionId: string) => SessionRecord | null;
};

const DEFAULT_RETAIN_TERMINAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;

export function createRegistry(options: RegistryOptions): Registry {
  const now = options.now ?? Date.now;
  const retainTerminalMs = options.retainTerminalMs ?? DEFAULT_RETAIN_TERMINAL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, SessionRecord>();
  for (const record of options.sessions ?? []) sessions.set(record.sessionId, record);

  function list(): SessionRecord[] {
    return [...sessions.values()];
  }

  function mutated(): void {
    options.onMutate?.(list());
  }

  // A process token holds at most one non-ended session at a time: SessionStart ends the previous
  // one before creating its replacement.
  function current(processToken: string): SessionRecord | null {
    for (const record of sessions.values()) {
      if (record.processToken === processToken && record.state !== "ended") return record;
    }
    return null;
  }

  // A session ID is not a secret: GET /sessions publishes every one of them. Without this, a local
  // process could mint a token, announce a SessionStart carrying a running session's ID, and
  // overwrite that record in place with one holding its own token. Thread bindings key on session
  // ID and persist, so the operator's messages would then route to the impostor and its replies
  // would land in the real thread as that session, while the real one went dark.
  //
  // Only a record still holding the ID is protected. An ended one is a tombstone, and a session ID
  // that is genuinely reused is a case the supersession path handles.
  function impostor(intake: HookIntake, sessionId: string): boolean {
    const held = sessions.get(sessionId);
    return held !== undefined && held.state !== "ended" && held.processToken !== intake.processToken;
  }

  function impostorStart(intake: HookIntake): boolean {
    if (intake.event !== "SessionStart" || intake.sessionId === null) return false;
    return impostor(intake, intake.sessionId);
  }

  // The one reading of "this is a subprocess, not a replacement", shared by the branch that
  // declines the arrival and the caller that reports the drop, so what the registry does and what
  // the log says it did cannot drift apart. Ordered as start() is: an arrival the impostor guard
  // refuses is refused for that reason, and a token's own session announcing itself again is a
  // refresh rather than a subprocess.
  //
  // The incumbent must hold a relay pipe, which `lastRelayAt` records. A live record is not enough:
  // any process that reads CHANNEL_PROCESS_TOKEN out of the environment it inherited can create one
  // with a single hook post, and a live record is never pruned and never evicted, so a squatter that
  // announced a session of its own before the real one did would otherwise hold the token forever,
  // declining the real session's announcement for the life of the broker and refreshing its claim
  // with one hook post per staleness window. Requiring the pipe means such a record is superseded
  // by the real session exactly as it was before this branch existed.
  //
  // The signal is "a relay has attached to this session", not "a pipe is open right now": the
  // registry holds the timestamp, not the connection. For a live record the two coincide closely,
  // because a pipe that closes and stays closed ends its session at the relay hub's grace window.
  function subprocessStart(intake: HookIntake): boolean {
    if (intake.event !== "SessionStart" || intake.sessionId === null) return false;
    if (intake.source !== "startup") return false;
    if (impostor(intake, intake.sessionId)) return false;
    const previous = current(intake.processToken);
    if (previous === null || previous.state !== "live" || previous.lastRelayAt === null) return false;
    return previous.sessionId !== intake.sessionId;
  }

  function start(intake: HookIntake, sessionId: string): SessionRecord | null {
    if (impostor(intake, sessionId)) return null;

    const previous = current(intake.processToken);

    if (previous && previous.sessionId === sessionId) {
      // The same session announcing again (a resume, or a repeated startup hook). Refresh it
      // rather than replacing it, and revive it if the sweep had marked it stale.
      previous.state = "live";
      previous.source = intake.source ?? previous.source;
      previous.name = intake.sessionName ?? previous.name;
      previous.lastHookAt = now();
      return previous;
    }

    if (subprocessStart(intake)) {
      // A subprocess of the live session, not a replacement for it. CHANNEL_PROCESS_TOKEN is
      // inherited by every process a wrapped session spawns, so a `claude` invoked as a subprocess
      // announces a session ID of its own under its parent's token. Registering it would end the
      // parent, hand the token to a process that often exits within the minute, and open a Discord
      // thread for it; from then on the parent's own mirror posts name a session the token no
      // longer holds and are dropped by the straggler gate in routing/outbound.ts, so the session
      // the operator is watching stops being mirrored and nothing says so.
      //
      // Nothing is registered and nothing on the parent is touched, not even its staleness clock:
      // a child process announcing itself is evidence about the child, not about whether the
      // parent is still working. The arrival is declined with the null every ignored event
      // answers; `subprocessStart` above is how a caller names this one as what it is.
      //
      // What holds the token here is a session with a relay pipe, which is what a launch through
      // the wrapper always has and what a process posting hooks alone never gets. A stale or ended
      // record is not protected either: this reading rests on the incumbent being demonstrably
      // alive, and a record the sweep has given up on is not. A wrapped session of the operator's
      // own is never the arrival declined here, because the wrapper mints it a token of its own.
      //
      // What this does not close: a process that attaches a pipe of its own before the real relay
      // does holds the token under the relay hub's first-pipe-wins rule, and a record it announces
      // is then protected exactly as a real session's is. That is the relay race docs/security-
      // model.md records as an accepted residual, and this branch neither widens nor narrows it.
      return null;
    }

    if (previous) {
      // Supersession keys on a changed session ID for every source but "startup", not on
      // source === "clear". A /clear mints a new session ID, and so does every other replacement,
      // so an unrecognized source, a trigger Claude Code adds later, and a payload carrying no
      // source at all all replace the session rather than being read as a subprocess. The
      // asymmetry is deliberate: `startup` is the one value known to mean a new process started,
      // and the cost of erring the other way is a /clear whose new session never registers, which
      // is a live session with no thread and no mirror at all.
      previous.state = "ended";
      previous.endedAt = now();
    }

    const record: SessionRecord = {
      sessionId,
      processToken: intake.processToken,
      name: intake.sessionName,
      host: options.host,
      source: intake.source,
      state: "live",
      lastTool: null,
      lastToolInput: null,
      toolCount: 0,
      turnCount: 0,
      startedAt: now(),
      lastHookAt: now(),
      lastRelayAt: null,
      endedAt: null,
    };
    sessions.set(sessionId, record);
    return record;
  }

  /**
   * Picks the record a tool or stop event belongs to.
   *
   * Hook posts are independent HTTP requests with no ordering guarantee, so an event from the
   * session a `/clear` just replaced can land after the new session announced itself. Routing on
   * the process token alone would credit it to the new record, corrupting its counts and holding
   * it out of staleness on traffic from a session that is gone.
   *
   * The session ID is therefore honored when it is present, and the process token must still match
   * so an event cannot be aimed at a session it does not belong to. Every hook payload carries
   * `session_id`, `PostToolUse` and `Stop` included, so that keying is what routes an event in
   * practice. The token-only path is kept for a payload that arrives without one, which is a
   * defensive case rather than an expected one.
   */
  function route(intake: HookIntake): SessionRecord | null {
    if (intake.sessionId === null) return current(intake.processToken);
    const keyed = sessions.get(intake.sessionId);
    if (!keyed || keyed.processToken !== intake.processToken) return null;
    return keyed;
  }

  function apply(intake: HookIntake): SessionRecord | null {
    if (intake.event === "SessionStart") {
      // An unknown process token is the normal case here: SessionStart is the first announce.
      if (intake.sessionId === null) return null;
      const record = start(intake, intake.sessionId);
      if (record === null) return null;
      mutated();
      return record;
    }

    // Every other event needs a session that already announced itself. Without this a stray or
    // replayed post would conjure a session record for a process that may not exist.
    const record = route(intake);
    if (!record) return null;

    if (intake.event === "PostToolUse") {
      record.toolCount += 1;
      // The name and the preview move together, under the one guard, because the card renders them
      // as one line describing one call. Set apart, an event carrying an input but no usable name
      // would leave the previous call's name beside this one's input, and the card would assert a
      // pairing that never happened. Inside the guard the preview is still unconditional, so a call
      // whose input carried nothing previewable clears the last one's rather than keeping it.
      if (intake.toolName !== null) {
        record.lastTool = intake.toolName;
        record.lastToolInput = intake.toolInput;
      }
    } else {
      record.turnCount += 1;
    }
    if (intake.sessionName !== null) record.name = intake.sessionName;
    // An event that arrives after its session ended still counts, but it cannot revive the record
    // or hold it out of a staleness sweep it has already left.
    if (record.state !== "ended") {
      record.state = "live";
      record.lastHookAt = now();
    }
    mutated();
    return record;
  }

  /** When a terminal record stopped being current, which is what retention is measured from. */
  function terminalSince(record: SessionRecord): number {
    return record.endedAt ?? Math.max(record.lastHookAt, record.lastRelayAt ?? 0);
  }

  // Ended and stale records are kept so the Discord surfaces can paint a final state, but they are
  // not kept forever: nothing else removes a record, and the whole set is rewritten to disk on
  // every hook event.
  function prune(at: number): number {
    let removed = 0;
    for (const record of [...sessions.values()]) {
      if (record.state === "live") continue;
      if (at - terminalSince(record) < retainTerminalMs) continue;
      sessions.delete(record.sessionId);
      removed += 1;
    }

    if (sessions.size > maxSessions) {
      // A live session is never evicted: losing it would lose the only handle on a running process.
      const terminal = [...sessions.values()]
        .filter((record) => record.state !== "live")
        .sort((a, b) => terminalSince(a) - terminalSince(b));
      for (const record of terminal) {
        if (sessions.size <= maxSessions) break;
        sessions.delete(record.sessionId);
        removed += 1;
      }
    }

    return removed;
  }

  function sweep(): SessionRecord[] {
    const at = now();
    const changed: SessionRecord[] = [];
    for (const record of sessions.values()) {
      if (record.state !== "live") continue;
      const lastSeen = Math.max(record.lastHookAt, record.lastRelayAt ?? 0);
      if (at - lastSeen < options.staleAfterMs) continue;
      record.state = "stale";
      changed.push(record);
    }
    const removed = prune(at);
    if (changed.length > 0 || removed > 0) mutated();
    return changed;
  }

  function relaySeen(processToken: string): SessionRecord | null {
    const record = current(processToken);
    if (!record) return null;
    // A session the sweep had given up on is demonstrably alive: its relay is answering.
    const revived = record.state !== "live";
    record.lastRelayAt = now();
    record.state = "live";
    // Persisted only on the transition. This runs on every heartbeat of every attached relay, and
    // the snapshot is written whole and synchronously, so persisting a timestamp each time would be
    // thousands of full rewrites a day to record something a restart invalidates anyway: the pipe
    // it measures does not survive one, and the relay re-announces itself within a heartbeat.
    if (revived) mutated();
    return record;
  }

  function relayClosed(processToken: string, sessionId: string): SessionRecord | null {
    const record = sessions.get(sessionId);
    // A record that is gone, already ended, or held by another process is not this pipe's to end.
    // A repeated close is therefore a no-op rather than a second end with a later timestamp.
    if (!record) return null;
    if (record.state === "ended" || record.processToken !== processToken) return null;
    record.state = "ended";
    record.endedAt = now();
    mutated();
    return record;
  }

  return { apply, subprocessStart, impostorStart, sweep, list, current, relaySeen, relayClosed };
}
