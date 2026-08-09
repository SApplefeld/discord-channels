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

/**
 * What a transcript's assistant line says about the model running the session: the model that
 * produced the turn, and the live context size its usage block adds up to. Raw tokens rather than a
 * percentage, because the window is a per-model fact that can move upstream and a rendered
 * percentage keeps looking authoritative after its denominator rots.
 */
export type ModelReading = {
  model: string;
  contextTokens: number;
};

/**
 * Which of the two forced downgrades upstream recorded. `refusal` is the safeguard path, where a
 * request was flagged and retried on a lower model; `consent` is the entitlement path, fired when
 * the session's model requires usage credits. They carry different fields, and a reader keyed to
 * one misses the other, which is the one an operator away from the keyboard can act on.
 */
export type ModelFallbackCause = "refusal" | "consent";

/**
 * The forced downgrade a transcript system line recorded, reduced to the fields the card and the
 * change message name. Every string is untrusted content from another program's file, bounded at
 * the reader and neutralized at the render site.
 */
export type ModelFallback = {
  cause: ModelFallbackCause;
  /** The model the session was running when the downgrade fired. */
  originalModel: string;
  /** The model it was moved to, which is not always a bare id: `claude-opus-5[1m]` is one. */
  fallbackModel: string;
  /** The API's refusal category; null on the consent path, which carries none at all. */
  category: string | null;
  /** What the operator answered the consent prompt; null when the record carries no answer. */
  choice: string | null;
};

/**
 * What kind of work a background task is. `subagent` is a dispatched agent running inside the
 * session's own process; `shell` is a backgrounded command. Both are invisible work: the session's
 * main thread fires no hooks while it waits on either.
 */
export type BackgroundTaskKind = "subagent" | "shell";

/**
 * One entry of the harness's own task table, as a `Stop` payload reports it. Every string is
 * untrusted, model-authored text from another program, bounded at the reader and neutralized at the
 * render site.
 */
export type BackgroundTaskReading = {
  id: string;
  kind: BackgroundTaskKind;
  /** The prose the dispatching model wrote for the task; null when the entry carried none. */
  description: string | null;
  /** The agent type a subagent runs as; null on a shell task and on a subagent without one. */
  agentType: string | null;
};

/**
 * Ceiling on the entries kept from one reported table. A measured fan-out session peaked at twelve
 * concurrent, so this leaves room for the real case several times over while keeping a crafted
 * table from growing a session record without limit. Entries past it are dropped, not refused: the
 * count the card renders is the count of what was kept.
 *
 * Exported beside the roster types because two readers hold tables to it, the wire intake and the
 * persistence load, and a bound that lived in one of them could drift from the other's.
 */
export const MAX_BACKGROUND_TASKS = 32;

/**
 * Longest task id kept, shared by the same two readers. An id is a short token, so a longer one
 * identifies nothing worth storing, and treating it as absent rather than truncating it keeps two
 * distinct tasks from being read as one under a shared truncated id, which is what the roster's
 * own carry-forward keys on.
 */
export const MAX_BACKGROUND_TASK_ID_LENGTH = 64;

/**
 * A task on a session's roster: what the table reported, plus when this broker first saw the entry,
 * which is what the card ages it from. The payload carries no start time of its own, so the age is
 * measured from first sighting and carried forward while the same id keeps appearing.
 */
export type BackgroundTask = BackgroundTaskReading & { since: number };

/** A session's model changing from one line to the next, and the downgrade record standing for it. */
export type ModelChange = {
  sessionId: string;
  from: string;
  to: string;
  downgrade: ModelFallback | null;
};

/**
 * The model families this build orders, strongest first. Every comparison here and in the render
 * layer is on the family rather than on the exact string, because a fallback model arrives
 * decorated (`claude-opus-5[1m]`) and no version arithmetic is attempted: what is compared is the
 * direction between two families and nothing finer.
 */
const MODEL_FAMILIES: readonly string[] = ["fable", "opus", "sonnet", "haiku"];

/**
 * Where a model string sits in that order, or null when it names no family this build ranks. The
 * first family the string contains wins, so a name carrying two of them reads as the stronger.
 *
 * Containment is the whole test, and it is a display heuristic rather than an authoritative
 * degradation signal: a crafted string such as `haiku[fable]` ranks as the stronger family, so a
 * forged transcript can render a genuine downgrade unmarked. No guard is added, because whoever
 * writes the model string already writes the whole transcript line, and a check here would lend
 * the marker an authority its input cannot support.
 *
 * Lives here and is imported by the render layer's marker, so what the registry attaches to a
 * change and what the card draws cannot disagree about what a family is.
 */
export function modelRank(model: string): number | null {
  const lowered = model.toLowerCase();
  const rank = MODEL_FAMILIES.findIndex((family) => lowered.includes(family));
  return rank === -1 ? null : rank;
}

/** True when both names rank and rank the same; two unrankable names are not the same family. */
function sameFamily(left: string, right: string): boolean {
  const rank = modelRank(left);
  return rank !== null && rank === modelRank(right);
}

/** True when the move from `from` to `to` is downward between two ranked families. */
function isDowngrade(from: string, to: string): boolean {
  const fromRank = modelRank(from);
  const toRank = modelRank(to);
  return fromRank !== null && toRank !== null && toRank > fromRank;
}

/** True when `model`'s family is at or above `openingModel`'s, which is what ends a downgrade. */
function reachesFamily(model: string, openingModel: string): boolean {
  const rank = modelRank(model);
  const opened = modelRank(openingModel);
  return rank !== null && opened !== null && rank <= opened;
}

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
  /**
   * The model this session was first seen running, kept beside the current one for as long as the
   * record lives. A forced downgrade is a state rather than an instant, because upstream says so:
   * the refusal record carries `scope: "session"` and the entitlement one says the same in its
   * prose, so a downgraded session stays downgraded until it is switched back by hand. Holding the
   * opening model is what lets the card carry a standing marker while the two differ, and clear it
   * when they agree again. Null until a transcript line reports a model.
   */
  openingModel: string | null;
  /** The model running now, from the most recent transcript line that named one. */
  model: string | null;
  /**
   * The live context size in tokens, as of the most recent line that reported one. Not what a
   * snapshot restores: a persisted figure would render an hours-old size as current, so a restart
   * reads null here until the next line reports one.
   */
  contextTokens: number | null;
  /**
   * The forced downgrade behind the current model, when one was read. Null when the session is
   * running what it opened with, and null too for a change whose record the reader never saw: the
   * fallback shape is upstream's and may move, so the marker and the message both compose without
   * it.
   */
  downgrade: ModelFallback | null;
  /**
   * The work this session is waiting on, as its last `Stop` reported it. Replaced wholesale by each
   * report and never merged, so a task that has left the harness's table cannot survive on the card;
   * an empty roster is a session waiting on nothing.
   *
   * This is the only signal the broker has for a session whose main thread is blocked on dispatched
   * agents: that session fires no hooks at all while it waits, so its hook-driven liveness would
   * otherwise read as idle at the moment it is most heavily worked.
   */
  backgroundTasks: BackgroundTask[];
};

export type HookEvent = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";

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
  /**
   * The session's in-flight work as this payload reported it, or null when the payload said nothing
   * about it. Null leaves the roster standing; an empty array clears it.
   */
  backgroundTasks: readonly BackgroundTaskReading[] | null;
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
  /**
   * How long a downward model change with no downgrade record beside it is held before
   * `dueModelChanges` releases it plain. The measured refusal order writes its record about twelve
   * seconds after the transition line, and the tailer can read the pair on different passes, so
   * the caller sizes this in poll intervals. Default 60 seconds.
   */
  fallbackAttachMs?: number;
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
   * Records what a transcript line said about the model and the context size. Returns the changes
   * to announce now, and an empty array otherwise: a first sighting over an unseeded opening model
   * is not a change, and a session polled every twenty seconds reports one message per change
   * rather than one per poll.
   *
   * A downward change with no downgrade record beside it is not returned here: it is held for the
   * record the measured refusal order writes after the transition line, and released enriched by
   * `noteFallback` or plain by `dueModelChanges`, so the record-first and transition-first orders
   * post one identical message. A change that supersedes a held one releases the held change
   * ahead of itself, which is the one case two changes come back from one reading.
   *
   * Only a session the registry still holds unended is written: an ended record is a tombstone the
   * surfaces paint a final state from, and a line arriving after it cannot move what it says.
   */
  noteModel: (sessionId: string, reading: ModelReading) => ModelChange[];
  /**
   * Records the forced downgrade a transcript system line reported, replacing any earlier one. A
   * session whose opening model is not yet known takes it from the record's own `originalModel`,
   * which is the model it was running when the downgrade fired.
   *
   * Returns the change this record's arrival releases for announcement, when there is one: the
   * held transition it trails, or the change a first reading could not report because the
   * transition line landed before any other reading. Null when the record only updates state.
   */
  noteFallback: (sessionId: string, fallback: ModelFallback) => ModelChange | null;
  /**
   * Held changes whose attach window has closed, released plain and exactly once. Polled on the
   * tailer's own cadence, because the hold exists for a record the tailer reads: a change whose
   * record never arrives (the fallback shape is upstream's and may move) still posts, without a
   * cause. A hold whose session has ended is dropped instead, since its thread paints a final
   * state a change message cannot move.
   */
  dueModelChanges: () => ModelChange[];
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
const DEFAULT_FALLBACK_ATTACH_MS = 60_000;

export function createRegistry(options: RegistryOptions): Registry {
  const now = options.now ?? Date.now;
  const retainTerminalMs = options.retainTerminalMs ?? DEFAULT_RETAIN_TERMINAL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const fallbackAttachMs = options.fallbackAttachMs ?? DEFAULT_FALLBACK_ATTACH_MS;
  const sessions = new Map<string, SessionRecord>();

  /**
   * Announcement bookkeeping beside a record, never on it and never persisted: a change held for
   * the downgrade record that trails it, and whether the session's model has ever moved (the
   * discriminator between an opening model seeded by a real first reading and one mis-seeded by a
   * fallback's own transition line). In-memory because announcements are the running process's
   * thread traffic; a restart re-detects everything from fresh readings. Entries are dropped
   * wherever their record is dropped, so the map is bounded by the record cap.
   */
  type ModelSide = {
    pending: { change: ModelChange; heldAt: number } | null;
    changed: boolean;
  };
  const modelSides = new Map<string, ModelSide>();

  function modelSide(sessionId: string): ModelSide {
    let held = modelSides.get(sessionId);
    if (held === undefined) {
      held = { pending: null, changed: false };
      modelSides.set(sessionId, held);
    }
    return held;
  }
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
      openingModel: null,
      model: null,
      contextTokens: null,
      downgrade: null,
      backgroundTasks: [],
    };
    sessions.set(sessionId, record);
    // A fresh record starts fresh announcement bookkeeping: a held change or a changed flag from
    // a previous run of this session ID describes a model history this record never had.
    modelSides.delete(sessionId);
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

  /**
   * The roster a report replaces the previous one with.
   *
   * Membership is wholesale: what comes back is exactly the reported table, so a task that has left
   * it is gone rather than lingering, which is the whole reason the report is trusted over anything
   * reconstructed from dispatch events. What survives a replacement is the first-sighting time of an
   * entry that is still there, because the table carries no start time of its own and re-stamping a
   * task on every turn would render an hour-old agent as a fresh one forever. The carry-forward
   * keys on the id and the kind together: ids are the harness's to mint, so one reused across kinds
   * names a different task, and keying on the id alone would hand it a dead task's age.
   */
  function taskKey(task: BackgroundTaskReading): string {
    return `${task.kind}:${task.id}`;
  }

  function adoptTasks(
    previous: readonly BackgroundTask[],
    reported: readonly BackgroundTaskReading[],
  ): BackgroundTask[] {
    const at = now();
    const since = new Map(previous.map((task) => [taskKey(task), task.since]));
    return reported.map((task) => ({ ...task, since: since.get(taskKey(task)) ?? at }));
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
    } else if (intake.event === "Stop") {
      record.turnCount += 1;
      // An empty report is as load-bearing as a populated one: a session that has finished its
      // agents reports an empty table, and a roster only replaced when there is something to
      // replace it with would hold that session at working for the rest of its life. Null is the
      // one report that changes nothing, and it means the payload said nothing readable at all.
      if (intake.backgroundTasks !== null) {
        record.backgroundTasks = adoptTasks(record.backgroundTasks, intake.backgroundTasks);
      }
    }
    // PreToolUse moves neither counter: it fires at the moment AskUserQuestion opens its picker,
    // and the same call's completion still arrives as a PostToolUse that does the tool
    // accounting, so counting the emission too would count every question twice, and an emission
    // is not a turn. What it still is, like every credited event, is proof of life, which the
    // shared stamping below records.
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

  /** The session a transcript reading belongs to, or null when nothing unended holds that ID. */
  function reading(sessionId: string): SessionRecord | null {
    const record = sessions.get(sessionId);
    if (record === undefined || record.state === "ended") return null;
    return record;
  }

  function noteModel(sessionId: string, read: ModelReading): ModelChange[] {
    const record = reading(sessionId);
    if (record === null) return [];
    const previous = record.model;
    record.contextTokens = read.contextTokens;
    // The context size moves on every turn and is not persisted on its own account, on the same
    // reasoning relaySeen holds: the snapshot is written whole and synchronously, so a rewrite per
    // turn would record a figure a restart deliberately drops. The model fields below are the
    // opposite case, and they call for the write.
    if (previous === read.model) return [];
    record.model = read.model;
    // The first line to name a model names the model the session opened with, for a session whose
    // downgrade record has not already said what that was.
    if (record.openingModel === null) record.openingModel = read.model;
    // Reaching the opening family ends the downgrade the card was marking. Compared on the family
    // because a switch-back arrives decorated (`claude-fable-5[1m]`), with the exact string kept
    // for a pair the ranking cannot read.
    if (record.model === record.openingModel || reachesFamily(record.model, record.openingModel)) {
      record.downgrade = null;
    }
    mutated();
    const side = modelSide(sessionId);
    const announcements: ModelChange[] = [];
    // A model that moved again inside the attach window supersedes the hold: the held change is
    // released as it stands, ahead of the new one, so both post in order.
    if (side.pending !== null) {
      announcements.push(side.pending.change);
      side.pending = null;
    }
    // The change's `from`. A first reading over an opening model a downgrade record seeded is
    // still a change: the record fired before any assistant line, and without this the one
    // downgrade an operator away from the keyboard can act on would post no message at all.
    const from = previous ?? (record.openingModel === read.model ? null : record.openingModel);
    if (from === null) return announcements;
    side.changed = true;
    // The standing record rides a change only when the change's destination is the model the
    // record says the session fell to: a manual move to a third model is the operator's own hand,
    // and a message blaming a safeguard for it would be untrue.
    const downgrade =
      record.downgrade !== null && sameFamily(read.model, record.downgrade.fallbackModel)
        ? record.downgrade
        : null;
    const change: ModelChange = { sessionId, from, to: read.model, downgrade };
    // A downward move with no record beside it is held rather than announced: the measured
    // refusal order writes the record after the transition line, and announcing now would post a
    // plain message where the record-first order posts the cause. `noteFallback` releases the
    // hold enriched; `dueModelChanges` releases it plain when no record arrives in the window.
    if (downgrade === null && isDowngrade(from, read.model)) {
      side.pending = { change, heldAt: now() };
      return announcements;
    }
    announcements.push(change);
    return announcements;
  }

  function noteFallback(sessionId: string, fallback: ModelFallback): ModelChange | null {
    const record = reading(sessionId);
    if (record === null) return null;
    const side = modelSide(sessionId);
    record.downgrade = fallback;
    if (record.openingModel === null) {
      // The downgrade record names the model the session was running when it fired, which is the
      // opening model for a session whose first transcript line is the downgrade itself. Without
      // this the next assistant line would seed the opening model from the fallback model, and a
      // session that is running degraded would render as one that opened that way.
      record.openingModel = fallback.originalModel;
    } else if (
      !side.changed &&
      record.model !== null &&
      record.model === record.openingModel &&
      sameFamily(record.model, fallback.fallbackModel) &&
      !sameFamily(fallback.originalModel, fallback.fallbackModel)
    ) {
      // The measured refusal order at the top of a session: the transition line was the session's
      // first reading, so the opening model seeded from the fallback model itself and the marker
      // would stay suppressed for a session that is genuinely degraded. A session whose model has
      // ever moved is left alone, because its opening model was seeded by a reading it really ran.
      record.openingModel = fallback.originalModel;
    }
    mutated();
    if (side.pending !== null && sameFamily(side.pending.change.to, fallback.fallbackModel)) {
      // The record the hold was waiting for: released with its cause attached, the same change
      // the record-first order announces.
      const change: ModelChange = { ...side.pending.change, downgrade: fallback };
      side.pending = null;
      return change;
    }
    if (
      !side.changed &&
      record.model !== null &&
      record.model !== record.openingModel &&
      sameFamily(record.model, fallback.fallbackModel)
    ) {
      // The transition this record describes landed as the session's first reading, which could
      // report no change; the record's arrival is what makes it one.
      side.changed = true;
      return { sessionId, from: fallback.originalModel, to: record.model, downgrade: fallback };
    }
    return null;
  }

  function dueModelChanges(): ModelChange[] {
    const at = now();
    const due: ModelChange[] = [];
    for (const [sessionId, side] of modelSides) {
      if (side.pending === null || at - side.pending.heldAt < fallbackAttachMs) continue;
      const change = side.pending.change;
      side.pending = null;
      const record = sessions.get(sessionId);
      // A tombstone's thread paints a final state a change message cannot move, so its hold is
      // dropped rather than released.
      if (record === undefined || record.state === "ended") continue;
      due.push(change);
    }
    return due;
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
      modelSides.delete(record.sessionId);
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
        modelSides.delete(record.sessionId);
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

  return {
    apply,
    subprocessStart,
    impostorStart,
    noteModel,
    noteFallback,
    dueModelChanges,
    sweep,
    list,
    current,
    relaySeen,
    relayClosed,
  };
}
