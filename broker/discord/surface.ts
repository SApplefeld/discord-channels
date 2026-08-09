// The reconciler: it holds what each session's thread currently says, works out what it should
// say, and spends the Discord budgets on the difference.
//
// Nothing is queued. A call that cannot be afforded right now is dropped and forgotten, because
// the desired state is recomputed from live state on the next pass: a queued rename would land
// minutes later painting a state that had stopped being true, which is the failure this design is
// built to avoid. The same property makes a dropped call self-healing, since the next pass sees
// the same difference and tries again.
//
// A refusal Discord will repeat is the opposite case and is not retried on a timer. A 404 means
// the object is gone and its identifier is dropped; a run of any other permanent refusal abandons
// the session's surface, because a call that cannot succeed is a write made forever.
import { createBudget } from "./budget.ts";
import type { Budget } from "./budget.ts";
import type { ThreadBinding } from "./bindings.ts";
import { inertName, renderCard, threadName } from "./render.ts";
import { deriveSurfaceState } from "./state.ts";
import type { SessionView, SurfaceState } from "./state.ts";
import type { CallOutcome, DiscordTransport } from "./transport.ts";

/**
 * States worth a rename the moment they appear. Both of them are waiting on a person, and damping
 * them would be damping the only thing the thread list exists to show.
 */
const URGENT: ReadonlySet<SurfaceState> = new Set<SurfaceState>(["needs you", "exited"]);

/**
 * Ceiling on Discord calls in one pass. Sessions announce themselves over a loopback listener that
 * authenticates nothing, so the number of threads wanted at once is set by whatever is running on
 * this machine. The cap turns a burst into a queue of passes rather than a burst of writes into
 * the operator's channel, and the work it defers is picked up by the next pass unchanged.
 */
const DEFAULT_MAX_CALLS_PER_TICK = 10;

/** Consecutive refusals Discord will repeat, after which a session's surface is given up on. */
const MAX_PERMANENT_FAILURES = 3;

/** Passes spent trying to paint a departed session's final state before its thread is let go. */
const MAX_RETIRE_PASSES = 5;

export type SurfaceOptions = {
  transport: DiscordTransport;
  /** Injected so a test drives dwell and heartbeat without sleeping. */
  now: () => number;
  /** How long working or idle has to hold before it is worth a rename. Damps flapping. */
  dwellMs: number;
  /** A live session with no hook traffic for this long renders idle rather than working. */
  idleAfterMs: number;
  /** A session silent for this long is presumed dead and renders exited. */
  exitedAfterMs: number;
  /** Off by default: an exited thread stays open so its final state is readable in the list. */
  archiveOnEnd: boolean;
  maxCallsPerTick?: number;
  /** Threads this broker already owns, from the previous run. */
  bindings?: ThreadBinding[];
  /** Called whenever a binding is created, changed, or dropped, so the caller can persist. */
  onBind?: (bindings: ThreadBinding[]) => void;
  log?: (message: string) => void;
  /** Called once when Discord rejects the credential, which no retry can fix. */
  onFatal?: (message: string) => void;
};

export type Surface = {
  /** Reconciles every session against its thread. Safe to call on a timer. */
  tick: (views: SessionView[]) => Promise<void>;
  /** The thread bound to a session, for the message routing that arrives with the relay. */
  threadFor: (sessionId: string) => string | null;
  /**
   * The cards of the sessions that are running, for the channel's pin list.
   *
   * Read after a pass rather than before one: a card restored from a binding carries no state until
   * the pass has derived it, and a session the registry has dropped is driven to exited by that
   * same pass. A card whose surface has been given up on is left out, since nothing maintains it.
   */
  livePins: () => readonly string[];
};

type ThreadState = {
  /** The starter message, posted once and edited in place forever after. */
  messageId: string | null;
  threadId: string | null;
  /** What the thread title and the card actually say, as far as an accepted call reported. */
  renderedName: string | null;
  renderedCard: string | null;
  /** The state most recently derived, for the paths that reason about it rather than the title. */
  desired: SurfaceState;
  /**
   * The title most recently composed, and when it last changed. Together they are the dwell, and
   * it keys on the whole composed name rather than on the state because the agent count rides the
   * title: a fan-out draining a step per turn holds the state at working while changing the name
   * every step, and a dwell that only saw the state would spend a rename per step out of the same
   * budget an urgent needs-you rename has to come out of. Re-stamping on any name change makes a
   * drain coalesce into the renames that settle; the card still carries every count as it moves.
   */
  desiredName: string | null;
  desiredSince: number;
  archived: boolean;
  /**
   * Set for a session that was already terminal the first time it was seen, which is what a
   * retained dead record looks like after a restart, and for one whose surface Discord keeps
   * refusing. Either way it gets no further calls.
   */
  abandoned: boolean;
  /** Consecutive refusals Discord will repeat. Reset by any accepted call. */
  refusals: number;
  /** Passes spent painting a departed session's final state. */
  retirePasses: number;
  /** The last view seen, which is what a vanished session's final render is built from. */
  lastView: SessionView;
};

export function createSurface(options: SurfaceOptions): Surface {
  const threads = new Map<string, ThreadState>();
  // Discord buckets a channel modification per channel, and a thread is a channel, so one flapping
  // session must not be able to hold up an urgent rename on another thread.
  const renameBudgets = new Map<string, Budget>();
  // Message edits, message creates, and thread creates are three different buckets on three
  // different routes, and one route's headers say nothing about another's.
  const edits = createBudget();
  const posts = createBudget();
  const opens = createBudget();
  const maxCallsPerTick = options.maxCallsPerTick ?? DEFAULT_MAX_CALLS_PER_TICK;
  const log = options.log ?? (() => {});
  let running = false;
  let credentialRejected = false;
  let calls = 0;

  /**
   * What a restored binding knows about its session before the registry hands over a view. The
   * name is carried in the binding precisely so a thread whose session is already gone can still
   * be titled with the name the operator knows it by.
   */
  function placeholder(sessionId: string, name: string | null): SessionView {
    return {
      sessionId,
      name,
      host: "",
      lastTool: null,
      lastToolInput: null,
      turnCount: 0,
      lastHookAt: options.now(),
      endedAt: options.now(),
      model: null,
      openingModel: null,
      contextTokens: null,
      downgrade: null,
      backgroundTasks: [],
      needsAttention: false,
      lifecycle: "ended",
    };
  }

  for (const binding of options.bindings ?? []) {
    threads.set(binding.sessionId, {
      messageId: binding.messageId,
      threadId: binding.threadId,
      // The title is persisted, so a restart does not repaint a thread that already says the right
      // thing. The card is not: its heartbeat has moved on regardless, and one edit re-establishes
      // it at a cost the looser bucket carries easily.
      renderedName: binding.title,
      renderedCard: null,
      desired: "working",
      // Null, so the first pass stamps the dwell with whatever name it composes: a restart has no
      // idea what the session has been doing, and a fresh stamp is the conservative read.
      desiredName: null,
      desiredSince: options.now(),
      archived: binding.archived,
      abandoned: false,
      refusals: 0,
      retirePasses: 0,
      lastView: placeholder(binding.sessionId, binding.name),
    });
  }

  function bindings(): ThreadBinding[] {
    const all: ThreadBinding[] = [];
    for (const [sessionId, entry] of threads) {
      if (entry.messageId === null) continue;
      all.push({
        sessionId,
        messageId: entry.messageId,
        threadId: entry.threadId,
        archived: entry.archived,
        name: entry.lastView.name,
        title: entry.renderedName,
      });
    }
    return all;
  }

  function bound(): void {
    options.onBind?.(bindings());
  }

  function renameBudget(threadId: string): Budget {
    let budget = renameBudgets.get(threadId);
    if (budget === undefined) {
      budget = createBudget();
      renameBudgets.set(threadId, budget);
    }
    return budget;
  }

  /** A session ID is untrusted text and a log file is a render site like any other. */
  function label(view: SessionView): string {
    return inertName(view.sessionId);
  }

  /**
   * Folds one call's outcome into the budget it came from and into the health of the binding it
   * named. A failed call's headers are deliberately not observed: a 4xx reports a bucket with room
   * in it, and letting that clear a standing block would turn a refusal into a retry storm.
   */
  function settle(
    budget: Budget | null,
    entry: ThreadState,
    outcome: CallOutcome<unknown>,
    what: string,
    named: "message" | "thread",
  ): void {
    if (outcome.status !== "failed") budget?.observe(outcome.rate, options.now());

    if (outcome.status === "rate-limited") {
      log(`discord: ${what} dropped, the bucket is empty`);
      return;
    }
    if (outcome.status === "ok") {
      entry.refusals = 0;
      return;
    }

    log(`discord: ${what} failed: ${outcome.error}`);
    if (outcome.fatal === true && !credentialRejected) {
      credentialRejected = true;
      // Reported once. The REST client discards a rejected token, so every later call would fail
      // complaining about a missing token rather than about the one Discord refused.
      options.onFatal?.("discord: the bot token was rejected, the surfaces are stopped");
      return;
    }

    if (outcome.missing === true) {
      // The object is gone: an operator deleted the message or the thread. The identifier is
      // dropped so the next pass builds a new one rather than calling a dead one forever. A
      // missing message takes its thread with it, since the thread hangs off that message.
      if (named === "message") {
        entry.messageId = null;
        entry.renderedCard = null;
      }
      entry.threadId = null;
      entry.renderedName = null;
      entry.refusals = 0;
      bound();
      return;
    }

    if (outcome.permanent !== true) return;
    entry.refusals += 1;
    if (entry.refusals >= MAX_PERMANENT_FAILURES) {
      entry.abandoned = true;
      log(`discord: ${what} refused ${entry.refusals} times, this session's surface is given up on`);
    }
  }

  /** True while there is room in this pass for one more call, which it then counts. */
  function spend(): boolean {
    if (credentialRejected || calls >= maxCallsPerTick) return false;
    calls += 1;
    return true;
  }

  /**
   * Posts the card, then opens the thread on it. The two are separate calls against separate
   * failures: a thread that could not be opened leaves a posted message that is kept and reused,
   * because reposting the card on every pass would fill the channel with orphaned starter messages
   * at the refresh interval.
   */
  async function open(view: SessionView, state: SurfaceState, entry: ThreadState): Promise<void> {
    // An exited session never gains a new surface, and this function only builds: whichever half
    // is missing here is gone because it was never created or because the operator deleted it, and
    // creating it now announces a session that is over. Deletion is honored as cleanup rather than
    // repaired, which is the same rule as the first-sight guard in entryFor, applied to a session
    // that reaches the state later. A surface that still exists is unaffected: reconcile drives an
    // existing card and thread to their final state without coming through here.
    if (state === "exited") {
      // Abandonment is forever, so it is reserved for `ended`, which the registry never revives.
      // The backstop's exited is a presumption about a silent record that a hook or a relay can
      // still wake, and a surface abandoned on a presumption belongs to a session that may come
      // back to find its card, its thread, and its message routing all dead. Declining to build,
      // without abandoning, spends nothing either way: a record that stays silent builds nothing on
      // any pass, and one that wakes renders a live state and rebuilds normally.
      if (view.lifecycle !== "ended") return;
      // A surviving card is painted with its final state before the entry is let go, the same wait
      // archive() holds for the final title, so the guard cannot freeze a dead session's card at
      // "working" when the paint it is owed was rate-limited this pass. reconcile edits the card
      // before it comes through here, so on any pass where that edit landed, this comparison holds.
      if (entry.messageId !== null && entry.renderedCard !== renderCard(view, state, options.now())) {
        return;
      }
      entry.abandoned = true;
      // Logged, unlike the first-sight guard, because a surface that existed and stops being
      // maintained is the kind of absence an operator goes to the log to explain.
      log(`discord: session ${label(view)} is exited, not rebuilding its surface`);
      return;
    }

    if (entry.messageId === null) {
      if (!posts.affordable(options.now())) return;
      if (!spend()) return;
      const card = renderCard(view, state, options.now());
      const posted = await options.transport.postCard({ card });
      settle(posts, entry, posted, `card post for ${label(view)}`, "message");
      if (posted.status !== "ok") return;
      entry.messageId = posted.value.messageId;
      entry.renderedCard = card;
      bound();
    }

    if (!opens.affordable(options.now())) return;
    if (!spend()) return;
    const name = threadName(view, state);
    const opened = await options.transport.openThread({ messageId: entry.messageId, name });
    settle(opens, entry, opened, `thread open for ${label(view)}`, "message");
    if (opened.status !== "ok") return;
    entry.threadId = opened.value.threadId;
    entry.renderedName = name;
    bound();
  }

  /** True when the card on Discord carries the text this state renders to. */
  async function refreshCard(
    view: SessionView,
    state: SurfaceState,
    entry: ThreadState,
  ): Promise<boolean> {
    if (entry.messageId === null) return false;
    const card = renderCard(view, state, options.now());
    if (card === entry.renderedCard) return true;
    if (!edits.affordable(options.now())) return false;
    if (!spend()) return false;

    const outcome = await options.transport.editCard({ messageId: entry.messageId, card });
    settle(edits, entry, outcome, `card edit for ${label(view)}`, "message");
    if (outcome.status !== "ok") return false;
    entry.renderedCard = card;
    return true;
  }

  /** True when the thread title carries what this state renders to. */
  async function refreshName(
    view: SessionView,
    state: SurfaceState,
    entry: ThreadState,
  ): Promise<boolean> {
    if (entry.threadId === null) return false;
    const name = threadName(view, state);
    if (name === entry.renderedName) return true;

    // Dwell: a state that has not settled is not worth a rename, since the flap would spend the
    // whole budget painting states that lasted seconds.
    const settled = URGENT.has(state) || options.now() - entry.desiredSince >= options.dwellMs;
    if (!settled) return false;

    const budget = renameBudget(entry.threadId);
    if (!budget.affordable(options.now())) {
      log(`discord: rename of ${label(view)} to ${state} dropped, no budget`);
      return false;
    }
    if (!spend()) return false;

    const outcome = await options.transport.renameThread({ threadId: entry.threadId, name });
    settle(budget, entry, outcome, `rename for ${label(view)}`, "thread");
    if (outcome.status !== "ok") return false;
    entry.renderedName = name;
    bound();
    return true;
  }

  /**
   * Archiving waits for the exited title to land, so a thread is never closed still claiming to be
   * working. An archived thread cannot be renamed, which makes this the last write, and it patches
   * the same route a rename does, so it comes out of the same budget.
   */
  async function archive(view: SessionView, entry: ThreadState): Promise<boolean> {
    if (entry.threadId === null) return false;
    if (entry.archived) return true;
    if (entry.renderedName !== threadName(view, "exited")) return false;

    const budget = renameBudget(entry.threadId);
    if (!budget.affordable(options.now())) return false;
    if (!spend()) return false;

    const outcome = await options.transport.archiveThread({ threadId: entry.threadId });
    settle(budget, entry, outcome, `archive for ${label(view)}`, "thread");
    if (outcome.status !== "ok") return false;
    entry.archived = true;
    bound();
    return true;
  }

  function entryFor(view: SessionView, state: SurfaceState): ThreadState {
    const now = options.now();
    const name = threadName(view, state);
    let entry = threads.get(view.sessionId);
    if (entry === undefined) {
      entry = {
        messageId: null,
        threadId: null,
        renderedName: null,
        renderedCard: null,
        desired: state,
        desiredName: name,
        desiredSince: now,
        archived: false,
        // A session first seen already exited never had a thread and is not getting one. Ended
        // only, for the reason open() holds abandonment to ended: the backstop's exited is a
        // presumption, and a presumed-dead record that wakes must find its surface buildable. Until
        // it wakes, open() declines to build for it, so the looser condition here costs no calls.
        abandoned: state === "exited" && view.lifecycle === "ended",
        refusals: 0,
        retirePasses: 0,
        lastView: view,
      };
      threads.set(view.sessionId, entry);
    }
    entry.lastView = view;
    entry.desired = state;
    // The dwell stamp: any change to the composed title restarts it, a state transition and a
    // count change alike, so refreshName's settled check below always measures how long the name
    // it is about to paint has held.
    if (name !== entry.desiredName) {
      entry.desiredName = name;
      entry.desiredSince = now;
    }
    return entry;
  }

  async function reconcile(view: SessionView): Promise<void> {
    const state = deriveSurfaceState(view, options.now(), {
      idleAfterMs: options.idleAfterMs,
      exitedAfterMs: options.exitedAfterMs,
    });
    const entry = entryFor(view, state);
    if (entry.abandoned || entry.archived) return;

    // The card is refreshed whether or not the thread exists yet. A posted message whose thread
    // could not be opened is still on display, and left alone it would sit there frozen at the
    // text it carried the moment it was posted.
    await refreshCard(view, state, entry);
    if (entry.threadId === null) {
      await open(view, state, entry);
      return;
    }

    await refreshName(view, state, entry);
    if (options.archiveOnEnd && state === "exited") await archive(view, entry);
  }

  /**
   * A session the registry has pruned or evicted stops arriving in the view set. Its thread is
   * still on Discord, so both surfaces are driven to the final state before the entry is
   * forgotten: dropping it here would leave a thread titled working forever, or a title that says
   * exited over a card that still says working.
   *
   * Returns true when the entry can be let go, which is when both surfaces are painted, or when
   * Discord has refused permanently, or when enough passes have been spent trying. A departed
   * session whose thread cannot be reached is not worth a call on every tick for the life of the
   * broker.
   */
  async function retire(entry: ThreadState): Promise<boolean> {
    if (entry.abandoned) return true;
    if (entry.messageId === null && entry.threadId === null) return true;

    entry.retirePasses += 1;
    const refusalsBefore = entry.refusals;
    const view: SessionView = {
      ...entry.lastView,
      lifecycle: "ended",
      needsAttention: false,
      endedAt: entry.lastView.endedAt ?? options.now(),
    };
    entry.lastView = view;
    if (entry.desired !== "exited") {
      entry.desired = "exited";
      // Kept coherent with entryFor's stamping, though exited is urgent and never waits the dwell.
      entry.desiredName = threadName(view, "exited");
      entry.desiredSince = options.now();
    }

    const cardPainted = entry.messageId === null ? true : await refreshCard(view, "exited", entry);
    const namePainted = entry.threadId === null ? true : await refreshName(view, "exited", entry);
    const archived = options.archiveOnEnd && entry.threadId !== null ? await archive(view, entry) : true;

    if (entry.abandoned) return true;
    if (entry.refusals > refusalsBefore) {
      // Discord refused in a way it will repeat. The final state cannot be painted, and a
      // departed session is not worth a doomed call on every tick for the life of the broker.
      log(`discord: cannot paint the final state of ${label(view)}, letting the thread go`);
      return true;
    }
    if (entry.retirePasses >= MAX_RETIRE_PASSES) {
      log(`discord: gave up painting the final state of ${label(view)} after ${entry.retirePasses} passes`);
      return true;
    }
    return cardPainted && namePainted && archived;
  }

  return {
    tick: async (views) => {
      // One pass at a time. A slow call would otherwise let the next tick post a second starter
      // message for a session whose first post had not returned yet.
      if (running || credentialRejected) return;
      running = true;
      calls = 0;
      try {
        for (const view of views) await reconcile(view);

        const present = new Set(views.map((view) => view.sessionId));
        let dropped = false;
        for (const [sessionId, entry] of [...threads]) {
          if (present.has(sessionId)) continue;
          if (!(await retire(entry))) continue;
          threads.delete(sessionId);
          if (entry.threadId !== null) renameBudgets.delete(entry.threadId);
          dropped = true;
        }
        if (dropped) bound();
      } finally {
        running = false;
      }
    },

    threadFor: (sessionId) => threads.get(sessionId)?.threadId ?? null,

    livePins: () => {
      const live: string[] = [];
      for (const entry of threads.values()) {
        if (entry.messageId === null || entry.abandoned) continue;
        if (entry.desired === "exited") continue;
        live.push(entry.messageId);
      }
      return live;
    },
  };
}
