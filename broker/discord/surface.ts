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
import { inertName, renderCard, threadName, titleState } from "./render.ts";
import { deriveSurfaceState } from "./state.ts";
import type { SessionView, SurfaceState } from "./state.ts";
import type { CallOutcome, DiscordTransport } from "./transport.ts";

/**
 * States worth a rename the moment they appear. Both of them are waiting on a person, and damping
 * them would be damping the only thing the thread list exists to show.
 *
 * `blocked` is not one of them, though it also waits on a person, because it can be transient in a
 * way the other two cannot: a run that blocks one plan and carries on to the next derives `blocked`
 * for the part of a model turn between the event and that turn's first completed tool call, and the
 * refresh tick runs every few seconds inside that window. Undamped, one such transient writes
 * Discord's irremovable rename notice twice and empties a per-thread rename bucket that holds about
 * two in ten minutes, which is the same bucket the final exited rename and the archive need. A real
 * block lasts minutes to hours, so one dwell window of title lag costs nothing, and the alert that
 * pings the operator is the fast channel.
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
  /**
   * On by default: an exited session's thread leaves the active list once its final state is
   * painted. The thread itself survives archiving, readable and searchable, and a post revives it.
   */
  archiveOnEnd: boolean;
  maxCallsPerTick?: number;
  /** Threads this broker already owns, from the previous run. */
  bindings?: ThreadBinding[];
  /** Called whenever a binding is created, changed, or dropped, so the caller can persist. */
  onBind?: (bindings: ThreadBinding[]) => void;
  /**
   * Called once a rebind actually happens: a session carrying CHANNEL_LINEAGE registered and this
   * surface found an existing thread already bound to that same lineage (a previous session under
   * it, restarted). The reconciler itself never posts a thread message (see ThreadMessenger's own
   * comment on why); this is the signal the caller needs to post the one-line restart notice item 3
   * asks for, with the thread it landed in. See docs/plans/channels_thread-rebinding_spec_v1.md.
   */
  onRebind?: (event: { lineage: string; fromSessionId: string; toSessionId: string; threadId: string | null }) => void;
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
  /**
   * Every card this surface holds a binding for, live or not, which is what the pin sweep is
   * allowed to reach: a pinned message outside this set was pinned by someone else.
   *
   * A card whose binding this surface has let go of is not in it, so a pin left over from one is the
   * operator's to remove. That is the price of leaving their own pins alone.
   */
  knownPins: () => readonly string[];
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
   * The title most recently composed, and when it last changed. Together they are the dwell, and it
   * keys on the whole composed name rather than on the state because the two move independently: a
   * session renaming itself changes the name without changing the state, and a title-state
   * transition changes both. Either one restarts the dwell, so the settled check always measures how
   * long the name about to be painted has held.
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
  /**
   * The title composed for this session, once it has one. Sticky: set from the restored binding
   * or from the first live view that carries a non-null title, and held across every later view
   * whose own title is null, the same guarantee `noteTitle` already gives the registry record (a
   * title is replaced, never cleared). `lastView.title` mirrors this value rather than carrying a
   * view's own possibly-null one, so a re-announced session that lost its registry title still
   * paints and persists the one already established, instead of repainting the thread back to its
   * launch name and overwriting the only surviving copy with null.
   */
  sessionTitle: string | null;
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
   * What a restored binding knows about its session before the registry hands over a view. Both
   * the name and the title are carried in the binding precisely so a thread whose session is
   * already gone can still be titled with the name, or the rename, the operator knows it by.
   */
  function placeholder(
    sessionId: string,
    name: string | null,
    title: string | null,
    lineage: string | null,
    startedAt: number,
  ): SessionView {
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
      goal: null,
      title,
      needsAttention: false,
      blocked: false,
      lifecycle: "ended",
      // Round 62 point 2: a restored placeholder now carries the lineage and startedAt its own
      // binding persisted, so it can join a lineage-takeover match from the very first pass after
      // a restart, before its own session has re-registered. Without this, the shape where the old
      // session's own still-live roster record reconciles before the new one's does opened a second
      // thread: the placeholder's lineage was null, the old view's lineage loop found no match, and
      // it fell through to a fresh entry - live, so not abandoned, and not caught by the ended-view
      // guard that protects the other ordering. A fresh session's own real view still overwrites
      // both fields the moment it lands, the same as every other placeholder field.
      lineage,
      startedAt,
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
      lastView: placeholder(binding.sessionId, binding.name, binding.sessionTitle, binding.lineage, binding.startedAt),
      sessionTitle: binding.sessionTitle,
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
        sessionTitle: entry.sessionTitle,
        title: entry.renderedName,
        lineage: entry.lastView.lineage,
        startedAt: entry.lastView.startedAt,
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

    // A record nothing has heard from for the staleness window gains no new card or thread,
    // whichever way the half came to be missing: deleted by the operator, never built because the
    // record was first seen stale, or left unopened when a pass ran out of budget. A deletion is
    // honored as cleanup, same as the exited branch above, but the entry is never
    // abandoned: a record that wakes (a hook or a relay revives it to live) renders a live state
    // and builds normally on the next pass. needs you, blocked and working are untouched, so a
    // stale session waiting on the operator, or one still holding a background task, still gets
    // its surface rebuilt.
    if (view.lifecycle === "stale" && state === "idle") return;

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
      log(`discord: rename of ${label(view)} to ${titleState(state)} dropped, no budget`);
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

  /**
   * Null means: build nothing for this view, this pass. The one case that produces it is a session
   * with no entry of its own whose lineage already belongs to a same-or-newer session - see the
   * ordering comment below. Returning null rather than a fresh entry is what keeps a superseded
   * session (whose roster record the broker retains and keeps reporting) from ever opening a
   * second thread of its own once a newer session has taken its lineage's thread.
   */
  function entryFor(view: SessionView, state: SurfaceState): ThreadState | null {
    const now = options.now();
    const existing = threads.get(view.sessionId);
    // Sticky, the same guarantee `noteTitle` already gives the registry record it came from: a
    // title is set or replaced, never cleared. Applied here rather than left to the raw view, so
    // a session whose registry record was rebuilt with no title of its own (a lost state file, a
    // fresh SessionStart) still paints and persists the title already established, instead of a
    // live view's null repainting the thread back to its launch name and overwriting the only
    // surviving copy of a rename with null.
    const sessionTitle = view.title ?? existing?.sessionTitle ?? null;
    const effectiveView: SessionView = view.title === sessionTitle ? view : { ...view, title: sessionTitle };
    const name = threadName(effectiveView, state);
    let entry = existing;
    // Item 2 (docs/plans/channels_thread-rebinding_spec_v1.md): a session with no entry of its own
    // yet, carrying a lineage another entry already answers to, takes that entry over instead of
    // getting a fresh one - the thread a restart would otherwise duplicate. Guarded to a real
    // thread only (messageId !== null): a lineage match against a placeholder that never posted
    // has nothing worth taking over, and falling through to the ordinary fresh-entry path below
    // costs nothing since that path is exactly what a first-ever launch under this lineage needs.
    //
    // Round 62 point 3: a takeover only ever runs from an older session to a newer one
    // (view.startedAt > other.lastView.startedAt). The broker's roster keeps an ended session's
    // record, so a superseded session's own view kept arriving in every later tick, and a
    // superseded-IDs set (this fix's first attempt) only held that off in memory - a broker
    // restart drops it, restores the winning session's binding from disk, and the departed
    // session's still-retained roster record reads as a fresh session under its old lineage again.
    // The startedAt ordering needs nothing new persisted: it is already on the registry's own
    // SessionRecord, reloaded from the registry's own persistence on every broker restart, and it
    // makes the wrong direction structurally impossible rather than remembered-and-checked - the
    // older session's own startedAt never becomes greater than the newer one's, restart or not.
    // A placeholder entry (a binding restored before its session has re-registered) carries no
    // lineage of its own yet (see `placeholder()` below), so it never matches here regardless of
    // its startedAt; the ordering only ever compares two sessions that have each announced
    // themselves for real.
    if (entry === undefined && view.lineage !== null) {
      for (const [otherId, other] of threads) {
        if (otherId === view.sessionId) continue;
        if (other.lastView.lineage !== view.lineage) continue;
        if (other.messageId === null) continue;
        // A surface Discord kept permanently refusing is not worth resurrecting silently: better a
        // fresh thread the new session can actually use than a rebind onto one nothing will ever
        // paint again with no sign anything is wrong.
        if (other.abandoned) continue;
        // A real lineage match exists. Only a newer session takes it over - never the reverse. An
        // older or equal one defers instead of falling through to the fresh-entry path below: this
        // is the same match, not a miss, so building a second thread for it would be exactly the
        // duplicate this feature exists to prevent, just approached from the other direction. This
        // is what stops a superseded session's still-reappearing roster record from ever opening
        // its own thread once a newer session already took its lineage's one.
        if (view.startedAt <= other.lastView.startedAt) return null;
        threads.delete(otherId);
        // Refusals and retire-passes are about the surface's own recent Discord traffic, not about
        // which session speaks for it - carrying them over would count the old session's failures
        // (or its own retirement countdown, if it had briefly started one) against the new one.
        other.refusals = 0;
        other.retirePasses = 0;
        threads.set(view.sessionId, other);
        entry = other;
        // Stamped before bound() persists it, not left to the common assignment below: bound()
        // reads bindings() straight from `entry`, and the binding must carry the new session's own
        // lineage and startedAt (Round 64 point 2's fix) from this first persist, not the old
        // session's, which is all `other.lastView` still holds at this point otherwise.
        entry.lastView = effectiveView;
        // The persisted binding is keyed by session ID, and the takeover just changed which ID
        // this thread answers to. Unconditional, not folded into the titleMoved check below: a
        // broker restart before any other change reaches this entry restores it under the old ID,
        // and the ordering guard above cannot protect a session ID whose binding was never moved.
        bound();
        options.onRebind?.({
          lineage: view.lineage,
          fromSessionId: otherId,
          toSessionId: view.sessionId,
          threadId: other.threadId,
        });
        break;
      }
    }
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
        lastView: effectiveView,
        sessionTitle,
      };
      threads.set(view.sessionId, entry);
    }
    entry.lastView = effectiveView;
    // Persisted the moment it moves, the way every other field the binding carries is. Left to ride
    // out on some later call, the on-disk binding lags the sticky copy for exactly the cases the
    // field exists for: a title that composes to the same thread name spends no rename, so nothing
    // else would write the file, and a restart in that window restores the older value.
    const titleMoved = entry.sessionTitle !== sessionTitle;
    entry.sessionTitle = sessionTitle;
    entry.desired = state;
    // The dwell stamp: any change to the composed title restarts it, a title-state transition and
    // a session renaming itself alike, so refreshName's settled check below always measures how
    // long the name it is about to paint has held.
    if (name !== entry.desiredName) {
      entry.desiredName = name;
      entry.desiredSince = now;
    }
    if (titleMoved) bound();
    return entry;
  }

  async function reconcile(view: SessionView): Promise<void> {
    const state = deriveSurfaceState(view, options.now(), {
      idleAfterMs: options.idleAfterMs,
      exitedAfterMs: options.exitedAfterMs,
    });
    const entry = entryFor(view, state);
    // null: a same-or-newer session already holds this lineage's thread. Nothing to build.
    if (entry === null) return;
    // A thread is archived on the derived exited, which includes the backstop's presumption about a
    // record that has merely been silent, and posting into an archived thread revives it on
    // Discord's side. So a session that comes back stops being an archived one here the moment it
    // renders anything but exited: its card and its title are maintained again, and the archive it
    // is owed at its real exit is one this pass has not already spent. The flag is what a restart
    // reads back, so a change to it is persisted like any other.
    if (state !== "exited" && entry.archived) {
      entry.archived = false;
      bound();
    }
    if (entry.abandoned || entry.archived) return;

    // The card is refreshed whether or not the thread exists yet. A posted message whose thread
    // could not be opened is still on display, and left alone it would sit there frozen at the
    // text it carried the moment it was posted.
    await refreshCard(entry.lastView, state, entry);
    if (entry.threadId === null) {
      await open(entry.lastView, state, entry);
      return;
    }

    await refreshName(entry.lastView, state, entry);
    if (options.archiveOnEnd && state === "exited") await archive(entry.lastView, entry);
  }

  /**
   * A session the registry has pruned or evicted stops arriving in the view set. Its thread is
   * still on Discord, so both surfaces are driven to the final state before the entry is
   * forgotten: dropping it here would leave a thread titled active forever, or a title that says
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
      blocked: false,
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

    knownPins: () => {
      const known: string[] = [];
      for (const entry of threads.values()) {
        // Abandoned and exited alike: the card is still on Discord and this broker still posted it,
        // which is the whole question the sweep asks.
        if (entry.messageId !== null) known.push(entry.messageId);
      }
      return known;
    },
  };
}
