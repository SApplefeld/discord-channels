// The fleet card's thread: one thread this broker owns in the configured channel, whose starter
// message is the card, edited in place forever after.
//
// One card, edits only. The thread is created once and rebound from the state file across restarts,
// its name is never changed (a rename is the scarce Discord resource, and this card's name carries
// no state), and nothing is ever posted into it. The card is rewritten only when the body the
// renderer composed differs byte for byte from the one this broker last saw land. What that buys is
// a bounded rate rather than silence: the ages and the countdowns the card draws are both resolved
// to the minute, so the steady state is about one edit a minute, far under what the edit route
// allows and at the resolution the operator reads the card at. The card falls silent only once
// nothing on it is moving at that resolution, which takes every reading on it aged past an hour,
// every session line past an hour too, and no reset running.
//
// Nothing is queued. A call that cannot be afforded, or that Discord refuses for the moment, is
// dropped and retried on the next tick, because the next tick recomputes the whole desired card
// from live state: a queued edit would land later carrying numbers that had stopped being true.
//
// A failed cache read never blanks the card. The last reading that could be taken is drawn again
// under a marker naming the failure, so the numbers stay up while their own "as of" age keeps
// climbing beside them: through a claude-swap outage the operator reads the last good figures and
// how old they are, and the session lines beside them stay current. The held reading lives in
// memory alone, so a broker restarted mid-outage draws the unavailable card until the cache comes
// back, which is the reasoning the last rendered body is not persisted under either.
import { createBudget } from "../discord/budget.ts";
import type { Budget } from "../discord/budget.ts";
import type { SessionView, StateThresholds } from "../discord/state.ts";
import type { CallOutcome, DiscordTransport } from "../discord/transport.ts";
import { readUsage } from "./cache.ts";
import type { UsageReading, UsageUnavailableReason } from "./cache.ts";
import { renderUsageCard } from "./card.ts";
import type { UsageCardBinding } from "./binding.ts";

/**
 * What the thread is called, for its whole life. Static by design: the name is the operator's
 * handle on the thread in a channel list, and the card inside it carries every changing fact.
 */
export const USAGE_THREAD_NAME = "Fleet: Usage";

/**
 * How long one reason waits before it may be logged again. Wider than the minute the other
 * limiters in this broker hold, because this one paces lines a refresh timer produces: at the
 * default sixty-second interval a one-minute window would admit almost every repeat, which is the
 * flood the limiter exists to stop.
 */
const REPEAT_WINDOW_MS = 5 * 60 * 1000;

/** Refusals of one route inside the decay window, after which that route is not attempted again. */
const MAX_PERMANENT_FAILURES = 3;

/**
 * Rebuilds inside the decay window after Discord reported the card gone, after which the card is
 * given up on. Without a ceiling, anything deleting the card on a cadence gets a post and a thread
 * open back at every refresh, forever, since a rebuild is not a refusal and no refusal count sees
 * it.
 */
const MAX_REBUILDS = 3;

/**
 * How many refresh passes a failure counts for. A failure arriving within a few passes of the last
 * one is the same standing block and accumulates toward a ceiling; one arriving long after is a
 * separate event, and counting the two together would give up on a route over failures an afternoon
 * apart. Measured in passes rather than in wall time so the rule holds at both ends of the
 * configured refresh range.
 */
const DECAY_PASSES = 3;

/**
 * Rate-limits a repeating log line by its reason, which is a fixed phrase naming the cause; the
 * varying detail (Discord's own refusal text) rides beside it and never keys the limiter.
 *
 * The first of a reason is written at once; a repeat inside the window is counted, and the count
 * rides on the next line that window admits. The same shape the tailer's limiter has, held locally
 * for the reason it holds one: each layer owns its own log seam. It needs no eviction, because the
 * reasons this module logs are a fixed handful of literals rather than one per session.
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
        `usage card: ${reason} occurred ${String(held.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS / 60_000)} minutes`,
      );
    }
    log(`usage card: ${reason} (${detail})`);
    state.set(reason, { windowStart: at, suppressed: 0 });
  };
}

/**
 * Where the card is drawn, and under what thresholds its session lines read. Null when no Discord
 * is configured, which is one of the two ways this card is not built at all.
 */
export type UsageCardChannel = {
  transport: DiscordTransport;
  /** The same windows the thread titles derive from, so one session cannot read two ways. */
  thresholds: StateThresholds;
};

export type UsageCardOptions = {
  /** The feature knob. Off means nothing is constructed: no thread, no timer, and no cache read. */
  enabled: boolean;
  channel: UsageCardChannel | null;
  /**
   * The sessions the card lists, read on every tick rather than captured once: what is live, and
   * which of them are waiting on a permission verdict, is exactly what changes between ticks.
   */
  sessions: () => readonly SessionView[];
  /** Whether the transcript tailer is running, which is what the card's footer note reports. */
  interimMirror: boolean;
  /** claude-swap's backup directory, or null for the default under the operator's profile. */
  cacheRoot: string | null;
  /**
   * The thread this broker already owns, from the previous run. Read through a call rather than
   * passed, so a broker that is not building a card touches no state file on its account.
   */
  binding: () => UsageCardBinding | null;
  /** Called whenever the binding is created or changes, so the caller can persist it. */
  onBind?: (binding: UsageCardBinding) => void;
  /** How often the card is re-read and re-rendered. An edit is spent only when it changed. */
  refreshMs: number;
  /** Injected so a test drives budgets and ages without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
  /** The cache read, injected so a test drives readings without a claude-swap install. */
  read?: () => UsageReading;
  /** Injected so a test drives the refresh without waiting on a real interval. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type UsageCard = {
  /**
   * Reconciles the card against the cache and the registry. Safe to call on a timer: a call that
   * lands while a pass is running joins that pass rather than starting a second one, and the
   * promise it returns is the running pass's own.
   */
  tick: () => Promise<void>;
  /** Runs one pass at once and begins the refresh. Calling it twice runs one timer, not two. */
  start: () => void;
  /**
   * Clears the refresh timer synchronously and returns the drain: the promise of a pass already on
   * the wire. Waiting on it is what keeps a shutdown from racing an edit whose binding write has
   * not happened yet, and the synchronous clear is what lets a caller take this timer down in the
   * same block as its own, before it starts awaiting anything.
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
 * thread-create permission is refused on the open forever while its edits land, and one whole
 * counter shared between them both retries a hopeless route on every success elsewhere and gives up
 * on healthy routes when a hopeless one reaches the ceiling.
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
 * The count a failure arriving now carries: one more of a run still going, or the first of a new
 * one. A gap wider than the window says nothing about the call being made now, so it starts over.
 */
function accumulate(count: number, last: number | null, at: number, windowMs: number): number {
  return last !== null && at - last < windowMs ? count + 1 : 1;
}

/**
 * The card's thread, or null when this broker is not to have one.
 *
 * Both refusals are here rather than at the call site so that neither can be half-applied: with the
 * knob off, or with no Discord configured, no thread is created, no timer has anything to drive,
 * and claude-swap's files are never opened.
 */
export function createUsageCard(options: UsageCardOptions): UsageCard | null {
  if (!options.enabled || options.channel === null) return null;
  const channel = options.channel;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const repeats = createRepeatLog(log, now);
  const cacheRoot = options.cacheRoot;
  const read =
    options.read ?? ((): UsageReading => readUsage(cacheRoot === null ? {} : { root: cacheRoot }));
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;

  // How long a failure of one kind counts toward its ceiling, in wall time.
  const decayMs = options.refreshMs * DECAY_PASSES;

  // Three routes, three budgets. A message create, a thread create, and a message edit report their
  // limits independently, so a block on one holds neither of the others back. These are the card's
  // own budget instances rather than the thread messenger's, so a refusal this card takes never
  // delays a permission alert and a busy session surface never delays the card. Discord's own
  // buckets underneath are channel-scoped and shared with those writers, which is part of why the
  // card's cadence is a minute rather than a second.
  const posts = createRoute();
  const opens = createRoute();
  const edits = createRoute();

  const persisted = options.binding();
  let messageId = persisted?.messageId ?? null;
  let threadId = persisted?.threadId ?? null;
  // What the card on Discord actually says, as far as an accepted call reported. Null after a
  // restart even when the message is rebound: its numbers have moved on regardless, and the one
  // edit that re-establishes them costs less than persisting a body that may already be wrong.
  let rendered: string | null = null;
  // The last reading the cache actually yielded, redrawn under a marker while it cannot be read.
  // In memory only, for the same reason the rendered body is.
  let lastReadable: UsageReading | null = null;
  let rebuilds = 0;
  let rebuiltAt: number | null = null;
  // Set only by the two failures that end the whole card: a rejected token, and a card being
  // rebuilt faster than it can be kept. A single route giving up carries its own flag instead.
  let halted = false;
  let timer: NodeJS.Timeout | null = null;
  // The pass on the wire, kept so shutdown can wait for it: clearing the timer cancels nothing that
  // has already been sent, or the binding write that follows it.
  let inFlight: Promise<void> = Promise.resolve();
  // The pass currently running, and null between passes. It is what a `tick` arriving mid-pass is
  // answered with, so every caller waits on the call actually on the wire.
  let pass: Promise<void> | null = null;

  function bound(): void {
    if (messageId === null) return;
    options.onBind?.({ messageId, threadId });
  }

  /**
   * Folds one call's outcome into the budget it came from and into the health of this card. A
   * failed call's headers are deliberately not observed: a 4xx reports a bucket with room in it,
   * and letting that clear a standing block would turn a refusal into a retry storm.
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
      // every later call would fail complaining about a missing token rather than a refused one,
      // and this card makes none of them.
      log("usage card: the bot token was rejected, the card is stopped");
      return;
    }
    if (outcome.missing === true) {
      // The message is gone: an operator deleted it, and its thread went with it. Both identifiers
      // are dropped so the next tick builds a new card rather than calling a dead one forever. The
      // stale file is left until that post has an identifier worth persisting, so a broker that
      // dies in between rebinds to the dead message and finds it missing again, which is the same
      // self-healing pass one tick later.
      messageId = null;
      threadId = null;
      rendered = null;
      rebuilds = accumulate(rebuilds, rebuiltAt, at, decayMs);
      rebuiltAt = at;
      if (rebuilds < MAX_REBUILDS) return;
      halted = true;
      log(
        `usage card: the card went missing ${String(rebuilds)} times in a row, ` +
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
      `usage card: the ${what} was refused ${String(route.refusals)} times in a row, ` +
        `it is not attempted again`,
    );
  }

  /** Posts the card. Returns true when there is a message to work with afterwards. */
  async function post(card: string): Promise<boolean> {
    if (posts.stopped || !posts.budget.affordable(now())) return false;
    const posted = await channel.transport.postCard({ card });
    settle(posts, posted, "post");
    if (posted.status !== "ok") return false;
    messageId = posted.value.messageId;
    rendered = card;
    bound();
    return true;
  }

  /**
   * Opens the thread on the posted card. Separate from the post against separate failures: a thread
   * that could not be opened leaves a message that is kept and retried against, because reposting
   * the card whenever thread creation failed would fill the channel with orphaned cards at the
   * refresh interval.
   */
  async function open(messageIdentifier: string): Promise<void> {
    if (opens.stopped || !opens.budget.affordable(now())) return;
    const opened = await channel.transport.openThread({
      messageId: messageIdentifier,
      name: USAGE_THREAD_NAME,
    });
    settle(opens, opened, "thread open");
    if (opened.status !== "ok") return;
    threadId = opened.value.threadId;
    bound();
  }

  async function edit(messageIdentifier: string, card: string): Promise<void> {
    if (edits.stopped || !edits.budget.affordable(now())) return;
    const outcome = await channel.transport.editCard({ messageId: messageIdentifier, card });
    settle(edits, outcome, "edit");
    if (outcome.status !== "ok") return;
    rendered = card;
  }

  async function run(): Promise<void> {
    const fresh = read();
    // A cache that cannot be read leaves the last reading that could be standing in for it, marked
    // as held. The numbers keep their own fetch time, so their age climbs on the card through the
    // outage rather than freezing, and everything else on the card stays live. Only a broker that
    // has never had a readable cache draws the unavailable body, which is what it has.
    let reading = fresh;
    let unreadable: UsageUnavailableReason | null = null;
    if (fresh.available) {
      lastReadable = fresh;
    } else {
      if (lastReadable !== null) {
        reading = lastReadable;
        unreadable = fresh.reason;
      }
      repeats("the usage cache could not be read", fresh.reason);
    }

    const card = renderUsageCard({
      reading,
      sessions: options.sessions(),
      thresholds: channel.thresholds,
      interimMirror: options.interimMirror,
      unreadable,
      now: now(),
    });

    // Creation first, and it is not held back by an unreadable cache: a card saying the usage
    // cache cannot be read is worth far more than an empty channel.
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
    // A rejection out of a pass would be fatal to the process under Node 24, taking the hook intake
    // down with the card, and the intake is the half that has to keep running.
    inFlight = tick().catch(() => {
      // The error is discarded unread: a transport failure can carry the request object, which
      // holds both the credential and the card body the call was writing.
      repeats("a refresh pass failed", "the detail is withheld, it can carry the request");
    });
  }

  return {
    tick,

    cardMessage: () => messageId,

    start: () => {
      if (timer !== null) return;
      timer = setTimer(fire, options.refreshMs);
      // And one pass now, rather than one interval from now. Creating or rebinding the thread is
      // what starting is for, and at the configured ceiling the card would otherwise be absent from
      // the channel for an hour after a restart.
      fire();
    },

    stop: (): Promise<void> => {
      // Cleared before anything is awaited and before this returns, so a caller can take this timer
      // down in the same synchronous block as its own and await the drain later: across a
      // shutdown's other awaits, a surviving interval starts passes that write to Discord and to
      // the binding file on behalf of a broker that has already let go of everything else.
      if (timer !== null) clearTimer(timer);
      timer = null;
      // Every pass the timer starts is assigned here, which is every pass in a running broker. A
      // `tick` a caller drives by hand is that caller's own to await.
      return inFlight;
    },
  };
}
