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
  toolCount: number;
  turnCount: number;
  startedAt: number;
  /** Timestamp of the most recent hook event for this session. */
  lastHookAt: number;
  /**
   * Timestamp of the most recent relay liveness signal. The relay does not exist yet, so this
   * stays null and staleness rests on hook traffic alone; feeding it is a single assignment.
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

  function start(intake: HookIntake, sessionId: string): SessionRecord | null {
    // A session ID is not a secret: GET /sessions publishes every one of them. Without this, a
    // local process could mint a token, announce a SessionStart carrying a running session's ID,
    // and overwrite that record in place with one holding its own token. Thread bindings key on
    // session ID and persist, so the operator's messages would then route to the impostor and its
    // replies would land in the real thread as that session, while the real one went dark.
    //
    // Only a record still holding the ID is protected. An ended one is a tombstone, and a session
    // ID that is genuinely reused is a case the supersession path below already handles.
    const held = sessions.get(sessionId);
    if (held && held.state !== "ended" && held.processToken !== intake.processToken) return null;

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

    if (previous) {
      // Supersession keys on a changed session ID, not on source === "clear". A /clear mints a new
      // session ID, and so does every other replacement, so this covers the case even if the
      // source field were ever to arrive wrong.
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
   * so an event cannot be aimed at a session it does not belong to. Whether `session_id` rides on
   * a `PostToolUse` or `Stop` payload is unconfirmed (the observed field list does not include
   * it), so this is strictly opportunistic: with no session ID, the process token routes as before.
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
      if (intake.toolName !== null) record.lastTool = intake.toolName;
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

  return { apply, sweep, list, current, relaySeen, relayClosed };
}
