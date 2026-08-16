// The board card's thread: one thread this broker owns in the configured channel, whose starter
// message is the card, edited in place forever after.
//
// One card, edits only. The thread is created once and rebound from the state file across restarts,
// its name is never changed (a rename is the scarce Discord resource, and this card's name carries
// no state), and nothing is ever posted into it. The card is rewritten only when the body the
// renderer composed differs byte for byte from the one this broker last saw land. What that buys is
// a bounded rate rather than silence: every age the card draws is resolved to the minute, so the
// steady state is about one edit a minute, far under what the edit route allows and at the
// resolution the operator reads the card at. A fleet whose plans have all sat untouched for over a
// day draws in days and hours and costs an edit an hour instead; a card drawing any plan at all
// never goes fully quiet, because an age is one of the things it draws.
//
// Nothing is queued. A call that cannot be afforded, or that Discord refuses for the moment, is
// dropped and retried on the next tick, because the next tick recomputes the whole desired card from
// live state: a queued edit would land later carrying ages that had stopped being true.
//
// A pass costs one stat per plan file and a read of only the files whose modification time or size
// moved, because this module holds what every file it has read yielded and hands it back to the
// sweep under exactly the stat it was read at. A file that moved by a byte fails that comparison and
// is read again, which is what keeps a held parse from outliving the bytes it describes.
//
// Failure is held on the same terms as a parse. A file that is unreadable, over the read cap, or
// carries no `Status:` header would otherwise be opened and read in full on every tick for as long
// as it sits there, since no parse of it can ever match the stat a later tick sees. Both holds are
// rebuilt from each sweep rather than added to, so a file gone from the disk is gone from both.
//
// A plan doc mid-write by a live session parses as a failure for a tick. Its last good parse is
// drawn again under a marker whose age climbs, the same discipline the usage card applies to an
// unreadable cache, and only a plan this broker has never parsed draws as unreadable. Every hold
// lives in memory alone, so a restart re-reads the whole fleet, which is one tick of work.
import { createBudget } from "../discord/budget.ts";
import type { Budget } from "../discord/budget.ts";
import type { CallOutcome, DiscordTransport } from "../discord/transport.ts";
import { renderBoardCard } from "./card.ts";
import type { BoardPlan } from "./card.ts";
import { initialEventState, readEvents } from "./events.ts";
import type { EventReaderState, ReadEventsResult } from "./events.ts";
import { sweepPlans } from "./plans.ts";
import type {
  PlanFailure,
  PlanFailureReason,
  PlanParse,
  PlanSweep,
  SweepPlansOptions,
} from "./plans.ts";
import type { BoardCardBinding } from "./binding.ts";

/**
 * What the thread is called, for its whole life. Static by design: the name is the operator's handle
 * on the thread in a channel list, and the card inside it carries every changing fact.
 */
export const BOARD_THREAD_NAME = "Fleet: Board";

/**
 * How long one reason waits before it may be logged again. Wider than the minute the other limiters
 * in this broker hold, because this one paces lines a refresh timer produces: at the default
 * sixty-second interval a one-minute window would admit almost every repeat, which is the flood the
 * limiter exists to stop.
 */
const REPEAT_WINDOW_MS = 5 * 60 * 1000;

/** Refusals of one route inside the decay window, after which that route is not attempted again. */
const MAX_PERMANENT_FAILURES = 3;

/**
 * Rebuilds inside the decay window after Discord reported the card gone, after which the card is
 * given up on. Without a ceiling, anything deleting the card on a cadence gets a post and a thread
 * open back at every refresh, forever, since a rebuild is not a refusal and no refusal count sees it.
 */
const MAX_REBUILDS = 3;

/**
 * How many refresh passes a failure counts for. A failure arriving within a few passes of the last
 * one is the same standing block and accumulates toward a ceiling; one arriving long after is a
 * separate event, and counting the two together would give up on a route over failures an afternoon
 * apart. Measured in passes rather than in wall time so the rule holds at both ends of the configured
 * refresh range.
 */
const DECAY_PASSES = 3;

/**
 * Rate-limits a repeating log line by its reason, which is a fixed phrase naming the cause; the
 * varying detail (Discord's own refusal text) rides beside it and never keys the limiter.
 *
 * The first of a reason is written at once; a repeat inside the window is counted, and the count
 * rides on the next line that window admits. The same shape the usage card's limiter has, held
 * locally for the reason it holds one: each layer owns its own log seam. It needs no eviction,
 * because the reasons this module logs are a fixed handful of literals rather than one per plan.
 */
function createRepeatLog(
  log: (message: string) => void,
  now: () => number,
): (reason: string, detail: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (reason, detail) => {
    const at = now();
    const held = state.get(reason);
    if (held !== undefined && at - held.windowStart < REPEAT_WINDOW_MS) {
      held.suppressed += 1;
      return;
    }
    if (held !== undefined && held.suppressed > 0) {
      log(
        `board card: ${reason} occurred ${String(held.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS / 60_000)} minutes`,
      );
    }
    log(`board card: ${reason} (${detail})`);
    state.set(reason, { windowStart: at, suppressed: 0 });
  };
}

export type BoardCardOptions = {
  /** The feature knob. Off means nothing is constructed: no thread, no timer, and no file opened. */
  enabled: boolean;
  /** Null when no Discord is configured, which is one of the three ways this card is not built. */
  transport: DiscordTransport | null;
  /**
   * The configured project roots, in the order the card draws them. Empty is the third way the card
   * is not built: there is nothing to sweep, and a card that could only ever say so is not worth a
   * thread in the operator's channel.
   */
  roots: readonly string[];
  /** The resolved path of the kit's goal event stream. Absent on disk is not an error. */
  eventsPath: string;
  /**
   * The thread this broker already owns, from the previous run. Read through a call rather than
   * passed, so a broker that is not building a card touches no state file on its account.
   */
  binding: () => BoardCardBinding | null;
  /** Called whenever the binding is created or changes, so the caller can persist it. */
  onBind?: (binding: BoardCardBinding) => void;
  /** How often the fleet is re-swept and re-rendered. An edit is spent only when it changed. */
  refreshMs: number;
  /** Injected so a test drives budgets and ages without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
  /** The plan sweep, injected so a test drives readings without a tree of plan docs on disk. */
  sweep?: (options: SweepPlansOptions) => PlanSweep;
  /** The event read, injected so a test drives blocked markers without the kit's own file. */
  readEvents?: (previous: EventReaderState) => ReadEventsResult;
  /** Injected so a test drives the refresh without waiting on a real interval. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type BoardCard = {
  /**
   * Reconciles the card against the plan docs and the event stream. Safe to call on a timer: a call
   * that lands while a pass is running joins that pass rather than starting a second one, and the
   * promise it returns is the running pass's own.
   */
  tick: () => Promise<void>;
  /** Runs one pass at once and begins the refresh. Calling it twice runs one timer, not two. */
  start: () => void;
  /**
   * Clears the refresh timer synchronously and returns the drain: the promise of a pass already on
   * the wire. Waiting on it is what keeps a shutdown from racing an edit whose binding write has not
   * happened yet, and the synchronous clear is what lets a caller take this timer down in the same
   * block as its own, before it starts awaiting anything.
   */
  stop: () => Promise<void>;
  /**
   * The message the card is drawn on, for the channel's pin list, and null until one exists. Null
   * again for as long as a card Discord reported gone has not been rebuilt, so the pin the old
   * identifier held is dropped rather than kept against a message that is not there.
   */
  cardMessage: () => string | null;
};

/**
 * One Discord route this card writes on, with the budget it spends and the refusals it has taken.
 *
 * Per route rather than per card, because the three fail for unrelated reasons: a bot without
 * thread-create permission is refused on the open forever while its edits land, and one whole counter
 * shared between them both retries a hopeless route on every success elsewhere and gives up on
 * healthy routes when a hopeless one reaches the ceiling.
 */
type Route = {
  budget: Budget;
  /** Refusals in the current run; a landed call on this route clears them. */
  refusals: number;
  /** When the last refusal landed, and null when none has: nothing to accumulate against. */
  refusedAt: number | null;
  /** True once the ceiling is reached. The other two routes keep working. */
  stopped: boolean;
};

function createRoute(): Route {
  return { budget: createBudget(), refusals: 0, refusedAt: null, stopped: false };
}

/**
 * The count a failure arriving now carries: one more of a run still going, or the first of a new one.
 * A gap wider than the window says nothing about the call being made now, so it starts over.
 */
function accumulate(count: number, last: number | null, at: number, windowMs: number): number {
  return last !== null && at - last < windowMs ? count + 1 : 1;
}

/**
 * One plan doc's last good parse, with the stat it was read at and when that reading was last known
 * to describe the file.
 *
 * `mtimeMs` and `sizeBytes` are what a later sweep's stat is compared against, and a difference in
 * either sends the file back to the reader. `readAt` is what the card draws a held row's marker from,
 * and it moves on every pass the file is confirmed unmoved, because an unmoved file's parse is as
 * current as one read this tick.
 */
type Held = { parse: PlanParse; mtimeMs: number; sizeBytes: number; readAt: number };

/**
 * One plan doc that yielded no parse, with the stat it failed at.
 *
 * This is the same gate the held parse is, pointed the other way: a file that has not moved since it
 * failed fails the same way again, so the sweep is told the reason rather than sent to open the file.
 * Without it every failing file in the fleet costs a full read on every tick forever, because no
 * parse of it exists to match the stat and nothing else stops the read.
 */
type HeldFailure = { reason: PlanFailureReason; mtimeMs: number; sizeBytes: number };

/**
 * The card's thread, or null when this broker is not to have one.
 *
 * All three refusals are here rather than at the call site so that none can be half-applied: with the
 * knob off, with no Discord configured, or with no project roots to sweep, no thread is created, no
 * timer has anything to drive, and no plan doc or event stream is ever opened.
 */
export function createBoardCard(options: BoardCardOptions): BoardCard | null {
  const log = options.log ?? ((): void => {});
  if (!options.enabled || options.transport === null) return null;
  if (options.roots.length === 0) {
    // Said once, at the one moment it can be said: the knob is on and there is a channel to draw in,
    // so an operator who enabled the card and left the project list empty gets the reason rather than
    // a missing card. The roots themselves are never named, here or anywhere else this module logs:
    // a configured root typically embeds the operator's OS username.
    log("board card: no project roots are configured, the card is not built");
    return null;
  }
  const transport = options.transport;
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(log, now);
  const roots = options.roots;
  const eventsPath = options.eventsPath;
  const sweep =
    options.sweep ?? ((sweepOptions: SweepPlansOptions): PlanSweep => sweepPlans(roots, sweepOptions));
  const readEventStream =
    options.readEvents ??
    ((previous: EventReaderState): ReadEventsResult => readEvents(previous, roots, { path: eventsPath }));
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;

  // How long a failure of one kind counts toward its ceiling, in wall time.
  const decayMs = options.refreshMs * DECAY_PASSES;

  // Where each configured root sits in the card, so a row keeps its place whether it was read this
  // tick or redrawn from a hold. The sweep returns its readings and its failures in two lists, and a
  // plan moving between them on a torn read would otherwise move on the card too.
  const rootOrder = new Map(roots.map((root, index): [string, number] => [root, index]));

  // Three routes, three budgets. A message create, a thread create, and a message edit report their
  // limits independently, so a block on one holds neither of the others back. These are the card's
  // own budget instances rather than the thread messenger's, so a refusal this card takes never
  // delays a permission alert and a busy session surface never delays the card. Discord's own buckets
  // underneath are channel-scoped and shared with those writers, which is part of why the card's
  // cadence is a minute rather than a second.
  const posts = createRoute();
  const opens = createRoute();
  const edits = createRoute();

  const persisted = options.binding();
  let messageId = persisted?.messageId ?? null;
  let threadId = persisted?.threadId ?? null;
  // What the card on Discord actually says, as far as an accepted call reported. Null after a restart
  // even when the message is rebound: its ages have moved on regardless, and the one edit that
  // re-establishes them costs less than persisting a body that may already be wrong.
  let rendered: string | null = null;
  // The last good parse of every plan file the last pass saw, keyed by path. Rebuilt from each
  // sweep rather than added to, so a plan that is gone from the disk is gone from here too and the
  // map stays bounded by what one sweep returns.
  let holds = new Map<string, Held>();
  // The last failure of every plan file the last pass saw, on the same terms and with the same
  // bound: rebuilt from each sweep, so it holds at most one entry per file that sweep returned.
  let failedHolds = new Map<string, HeldFailure>();
  let events = initialEventState();
  let rebuilds = 0;
  let rebuiltAt: number | null = null;
  // Set only by the two failures that end the whole card: a rejected token, and a card being rebuilt
  // faster than it can be kept. A single route giving up carries its own flag instead.
  let halted = false;
  let timer: NodeJS.Timeout | null = null;
  // The pass on the wire, kept so shutdown can wait for it: clearing the timer cancels nothing that
  // has already been sent, or the binding write that follows it.
  let inFlight: Promise<void> = Promise.resolve();
  // The pass currently running, and null between passes. It is what a `tick` arriving mid-pass is
  // answered with, so every caller waits on the call actually on the wire.
  let pass: Promise<void> | null = null;
  // That same pass paired with the one copy of it whose failure is reported, so a timer fire landing
  // on a pass already running waits on that copy instead of attaching a second reporter to it. The
  // pass is carried alongside rather than inferred, because a resolved chain left over from an
  // earlier pass would otherwise be handed to shutdown while a call is still on the wire.
  let observed: { pass: Promise<void>; reported: Promise<void> } | null = null;

  function bound(): void {
    if (messageId === null) return;
    options.onBind?.({ messageId, threadId });
  }

  /**
   * Folds one call's outcome into the budget it came from and into the health of this card. A failed
   * call's headers are deliberately not observed: a 4xx reports a bucket with room in it, and letting
   * that clear a standing block would turn a refusal into a retry storm.
   */
  function settle(route: Route, outcome: CallOutcome<unknown>, what: string): void {
    const at = now();
    if (outcome.status !== "failed") route.budget.observe(outcome.rate, at);

    if (outcome.status === "rate-limited") {
      repeats(`the card ${what} was dropped and will be retried`, "the bucket is empty");
      return;
    }
    if (outcome.status === "ok") {
      route.refusals = 0;
      route.refusedAt = null;
      return;
    }

    repeats(`the card ${what} failed`, outcome.error);
    if (outcome.fatal === true) {
      halted = true;
      // Reported once, and not through the limiter: the REST client discards a rejected token, so
      // every later call would fail complaining about a missing token rather than a refused one, and
      // this card makes none of them.
      log("board card: the bot token was rejected, the card is stopped");
      return;
    }
    if (outcome.missing === true) {
      // The message the card is drawn on is gone, which is what an operator deleting it looks like.
      // Both identifiers are dropped so the next tick builds a new card rather than calling a dead
      // one forever, bounded by the rebuild ceiling. The stale file is left until that post has an
      // identifier worth persisting, so a broker that dies in between rebinds to the dead message
      // and finds it missing again, which is the same self-healing pass one tick later.
      messageId = null;
      threadId = null;
      rendered = null;
      rebuilds = accumulate(rebuilds, rebuiltAt, at, decayMs);
      rebuiltAt = at;
      if (rebuilds < MAX_REBUILDS) return;
      halted = true;
      log(
        `board card: the card went missing ${String(rebuilds)} times in a row, ` +
          `it is not rebuilt again`,
      );
      return;
    }
    if (outcome.permanent !== true) return;
    route.refusals = accumulate(route.refusals, route.refusedAt, at, decayMs);
    route.refusedAt = at;
    if (route.refusals < MAX_PERMANENT_FAILURES) return;
    route.stopped = true;
    log(
      `board card: the ${what} was refused ${String(route.refusals)} times in a row, ` +
        `it is not attempted again`,
    );
  }

  /** Posts the card. Returns true when there is a message to work with afterwards. */
  async function post(card: string): Promise<boolean> {
    if (posts.stopped || !posts.budget.affordable(now())) return false;
    const posted = await transport.postCard({ card });
    settle(posts, posted, "post");
    if (posted.status !== "ok") return false;
    messageId = posted.value.messageId;
    rendered = card;
    bound();
    return true;
  }

  /**
   * Opens the thread on the posted card. Separate from the post against separate failures: a thread
   * that could not be opened leaves a message that is kept and retried against, because reposting the
   * card whenever thread creation failed would fill the channel with orphaned cards at the refresh
   * interval.
   */
  async function open(messageIdentifier: string): Promise<void> {
    if (opens.stopped || !opens.budget.affordable(now())) return;
    const opened = await transport.openThread({
      messageId: messageIdentifier,
      name: BOARD_THREAD_NAME,
    });
    settle(opens, opened, "thread open");
    if (opened.status !== "ok") return;
    threadId = opened.value.threadId;
    bound();
  }

  async function edit(messageIdentifier: string, card: string): Promise<void> {
    if (edits.stopped || !edits.budget.affordable(now())) return;
    const outcome = await transport.editCard({ messageId: messageIdentifier, card });
    settle(edits, outcome, "edit");
    if (outcome.status !== "ok") return;
    rendered = card;
  }

  /**
   * The plans this pass draws, and the failures it has nothing to draw for.
   *
   * A parse is handed back to the sweep only under the exact modification time and size it was read
   * at, so a file that moved is read again and a held parse never describes bytes that are gone. A
   * failure is handed back on the same terms, so an unchanged file that cannot be read or parsed
   * costs a stat rather than a read. A plan that failed this tick and has a parse held for it is
   * drawn from that parse under its own age; one with none is handed to the renderer as a failure,
   * which is the row saying the card has nothing for it.
   */
  function readFleet(at: number): { plans: BoardPlan[]; failures: PlanFailure[]; sweep: PlanSweep } {
    const previous = holds;
    const previouslyFailed = failedHolds;
    const swept = sweep({
      heldParse: (file, mtimeMs, sizeBytes) => {
        const held = previous.get(file);
        if (held === undefined || held.mtimeMs !== mtimeMs || held.sizeBytes !== sizeBytes) {
          return undefined;
        }
        return held.parse;
      },
      heldFailure: (file, mtimeMs, sizeBytes) => {
        const failed = previouslyFailed.get(file);
        if (failed === undefined || failed.mtimeMs !== mtimeMs || failed.sizeBytes !== sizeBytes) {
          return undefined;
        }
        return failed.reason;
      },
    });

    const kept = new Map<string, Held>();
    const keptFailures = new Map<string, HeldFailure>();
    const plans: BoardPlan[] = [];
    for (const reading of swept.readings) {
      const parse: PlanParse = {
        status: reading.status,
        terminal: reading.terminal,
        sections: reading.sections,
        completed: reading.completed,
        next: reading.next,
      };
      kept.set(reading.path, {
        parse,
        mtimeMs: reading.mtimeMs,
        sizeBytes: reading.sizeBytes,
        readAt: at,
      });
      plans.push({ reading, heldSince: null });
    }

    const failures: PlanFailure[] = [];
    for (const failure of swept.failures) {
      // A failure with no stat behind it is one whose stat is what failed, and there is no reading
      // of the file to skip on the strength of it: the next tick stats it again, which is all a
      // failing stat ever costs.
      if (failure.stat !== undefined) {
        keptFailures.set(failure.path, {
          reason: failure.reason,
          mtimeMs: failure.stat.mtimeMs,
          sizeBytes: failure.stat.sizeBytes,
        });
      }
      const held = previous.get(failure.path);
      if (held === undefined) {
        failures.push(failure);
        continue;
      }
      kept.set(failure.path, held);
      plans.push({
        reading: {
          ...held.parse,
          root: failure.root,
          path: failure.path,
          stem: failure.stem,
          mtimeMs: held.mtimeMs,
          sizeBytes: held.sizeBytes,
        },
        heldSince: held.readAt,
      });
    }
    holds = kept;
    failedHolds = keptFailures;

    // Configured root order, then path, which inside one root is the sweep's own name order.
    const place = (plan: BoardPlan): number => rootOrder.get(plan.reading.root) ?? roots.length;
    plans.sort((left, right) => {
      const byRoot = place(left) - place(right);
      if (byRoot !== 0) return byRoot;
      return left.reading.path < right.reading.path ? -1 : left.reading.path > right.reading.path ? 1 : 0;
    });
    return { plans, failures, sweep: swept };
  }

  async function run(): Promise<void> {
    const at = now();
    const fleet = readFleet(at);

    const read = readEventStream(events);
    events = read.state;
    if (read.unreadable) {
      // Not fatal to the card: the blocked markers are one field of it, and every row beside them is
      // still worth drawing. The path is not named, since it is configurable to anywhere.
      repeats("the goal event stream could not be read", "the markers it feeds are not drawn");
    }

    const card = renderBoardCard({
      plans: fleet.plans,
      failures: fleet.failures,
      truncated: fleet.sweep.truncated,
      events,
      now: at,
    });

    // Creation first, and it is not held back by a fleet that read badly: a card saying a plan could
    // not be read is worth far more than an empty channel.
    if (messageId === null) await post(card);
    const identifier = messageId;
    if (identifier === null) return;
    if (threadId === null) await open(identifier);
    // The open can report the card itself gone, which drops the identifier this pass is holding.
    // Editing it anyway would spend a call on a message Discord has already said is not there.
    if (messageId === null) return;

    // A card that already says the right thing costs no Discord call.
    if (card === rendered) return;
    await edit(identifier, card);
  }

  /**
   * One pass at a time. A caller arriving mid-pass is answered with the pass already running rather
   * than with a promise of nothing: shutdown waits on what this returns, and a resolved stand-in
   * there would let a broker go down with a post still on the wire, whose binding never lands and
   * whose card the next start posts a second time.
   */
  function tick(): Promise<void> {
    if (halted) return Promise.resolve();
    if (pass !== null) return pass;
    const started = run().finally(() => {
      pass = null;
    });
    pass = started;
    return started;
  }

  /** One refresh pass, held so shutdown can wait for it. */
  function fire(): void {
    // A fire that joined the pass already running takes the copy that pass is already reported on.
    // One pass that fails is one failure however many fires observed it, and a second reporter on
    // the same rejection would count it again and log a repeat that never happened.
    if (observed !== null && observed.pass === pass) {
      inFlight = observed.reported;
      return;
    }
    // A rejection out of a pass would be fatal to the process under Node 24, taking the hook intake
    // down with the card, and the intake is the half that has to keep running.
    const started = tick();
    const reported = started.catch(() => {
      // The error is discarded unread: a transport failure can carry the request object, which holds
      // both the credential and the card body the call was writing, and a filesystem error carries a
      // path under the operator's own profile.
      repeats("a refresh pass failed", "the detail is withheld, it can carry the request");
    });
    observed = { pass: started, reported };
    inFlight = reported;
  }

  return {
    tick,

    cardMessage: () => messageId,

    start: () => {
      if (timer !== null) return;
      timer = setTimer(fire, options.refreshMs);
      // And one pass now, rather than one interval from now. Creating or rebinding the thread is what
      // starting is for, and at the configured ceiling the card would otherwise be absent from the
      // channel for an hour after a restart.
      fire();
    },

    stop: (): Promise<void> => {
      // Cleared before anything is awaited and before this returns, so a caller can take this timer
      // down in the same synchronous block as its own and await the drain later: across a shutdown's
      // other awaits, a surviving interval starts passes that write to Discord and to the binding
      // file on behalf of a broker that has already let go of everything else.
      if (timer !== null) clearTimer(timer);
      timer = null;
      // Every pass the timer starts is assigned here, which is every pass in a running broker. A
      // `tick` a caller drives by hand is that caller's own to await.
      return inFlight;
    },
  };
}
