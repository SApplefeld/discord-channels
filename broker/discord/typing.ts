// Keeps Discord's "is typing..." indicator alive in every thread whose derived state is `working`.
//
// Discord shows the indicator for ten seconds per call, so a thread that stays working needs the
// call repeated inside that window to read as continuously typing rather than flickering on and
// off. A thread that drops out of the working set, whether its session answered, went idle, or
// ended, has its timer cleared at once: the quiet thread that follows is the truth, same as a
// session that fires no hooks reads as idle once the state desk's own window passes.
//
// One timer per thread, held here rather than derived from Discord's own state: nothing Discord
// returns says "a typing call is already running for this thread," so the keeper is the only place
// that can tell a second timer for the same thread from the first.
import { createBudget } from "./budget.ts";
import type { Budget } from "./budget.ts";
import { createRepeatLog } from "../repeat-log.ts";
import type { RepeatLogSurface } from "../repeat-log.ts";
import type { CallOutcome, ThreadTyping } from "./transport.ts";

/**
 * How often the indicator is refreshed for a thread still working. Discord's typing route shows
 * "is typing..." for ten seconds per call, so eight seconds leaves two seconds of margin against a
 * tick landing a little late.
 */
export const TYPING_PERIOD_MS = 8_000;

/**
 * How long a run of typing refusals is aggregated before its next log line. Wide, like the pin
 * keeper's and the receipt tracker's own windows, and for the same reason: this is paced by an
 * eight-second timer, so a narrow window would admit almost every repeat.
 */
const REFUSAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Consecutive permanent or missing refusals one thread takes before its indicator stops being
 * attempted at all, the same shape the pin keeper's own per-route cap takes and for the same
 * reason: a refusal of this kind repeats forever, so a cap is what keeps a dead thread from being
 * retried on every tick for the life of the broker. A dropped thread restarts only once it leaves
 * the working set and re-enters it, since re-entry is the only signal available that something
 * about it may have changed.
 */
export const MAX_THREAD_REFUSALS = 3;

export type TypingKeeper = {
  /**
   * Drives the kept timers to match `working`: the thread ids whose derived state is `working`
   * right now. A thread newly in the set gets one call at once and then one every
   * `TYPING_PERIOD_MS`; a thread no longer in it has its timer cleared at once. A no-op once the
   * keeper has stopped, whether through `stop()` or a fatal outcome on the typing route itself.
   */
  reconcile: (working: readonly string[]) => void;
  /** Clears every timer and latches the keeper against any later `reconcile`. Idempotent. */
  stop: () => void;
};

export type TypingKeeperOptions = {
  typing: ThreadTyping;
  now: () => number;
  log?: (message: string) => void;
  /** Injected so a test drives the refresh timer without real time. Defaults to the real globals. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /**
   * Turns a thrown error into a string safe to log. Optional for the same reason the receipt
   * tracker's is: a test needs nothing beyond a plain thrown value, and the broker wires
   * broker/discord/rest.ts's `describe` here once Discord is configured, since a discord.js error's
   * default stringification can carry the request object, Authorization header included.
   */
  describe?: (error: unknown) => string;
  /**
   * Called once, when a typing call reports the credential itself was rejected. The keeper has
   * already halted by the time this runs, the same way `stop()` leaves it: discord.js discards the
   * token after a 401, and this keeper, driven by its own timers rather than by the surface pass,
   * is as likely as the surface itself to be the first caller to notice. Wired to the same handler
   * the surface's own `onFatal` uses, so either caller stops the whole Discord refresh.
   */
  onFatal?: (message: string) => void;
};

/**
 * The typing keeper's repeat log, keyed by a fixed phrase naming the cause; the varying detail rides
 * beside it, the same shape the pin keeper's own log takes.
 */
export const TYPING_REPEAT_LOG: RepeatLogSurface<[detail: string]> = {
  windowMs: REFUSAL_WINDOW_MS,
  firstLine: (reason, detail) => `discord typing: ${reason} (${detail})`,
  countLine: (reason, suppressed) =>
    `discord typing: ${reason} occurred ${String(suppressed)} more time(s) in the last ` +
    `${String(REFUSAL_WINDOW_MS / 60_000)} minutes`,
};

export function createTypingKeeper(options: TypingKeeperOptions): TypingKeeper {
  const log = options.log ?? ((): void => {});
  const now = options.now;
  const describeError =
    options.describe ?? ((error: unknown) => (error instanceof Error ? error.message : "unknown transport error"));
  const repeats = createRepeatLog(TYPING_REPEAT_LOG, log, now);
  const schedule = options.setTimer ?? setInterval;
  const unschedule = options.clearTimer ?? clearInterval;

  /** One kept thread: the interval driving its refresh, and its run of permanent or missing refusals. */
  type Kept = { timer: NodeJS.Timeout; budget: Budget; refusals: number };
  const kept = new Map<string, Kept>();
  // A thread's budget outlives its timer: a session flapping out of and back into working inside a
  // 429's own window must stay blocked, not get a fresh bucket that reads as affordable at once.
  // Dropped only on `stop()`, since nothing before that is ever a reason to forget what a thread's
  // own bucket last reported.
  const budgets = new Map<string, Budget>();
  // Threads refused past the cap, held here rather than in `kept` so a reconcile that still finds
  // them working does not start them again. Cleared only by the thread leaving the working set.
  const dropped = new Set<string>();
  // Latched by `stop()` and by a fatal outcome on this keeper's own route; once set, `reconcile`
  // and `start` do nothing, which is what keeps a surface pass already in flight when the latch
  // trips from restarting timers it just cleared.
  let stopped = false;

  function budgetFor(threadId: string): Budget {
    let budget = budgets.get(threadId);
    if (budget === undefined) {
      budget = createBudget();
      budgets.set(threadId, budget);
    }
    return budget;
  }

  function clear(threadId: string): void {
    const entry = kept.get(threadId);
    if (entry === undefined) return;
    unschedule(entry.timer);
    kept.delete(threadId);
  }

  /** Clears every kept timer and latches the keeper, whether from `stop()` or a fatal outcome. */
  function halt(): void {
    if (stopped) return;
    stopped = true;
    for (const threadId of [...kept.keys()]) clear(threadId);
    dropped.clear();
  }

  /** This thread's run of permanent or missing refusals has reached the cap: stop retrying it. */
  function drop(threadId: string, refusals: number): void {
    clear(threadId);
    dropped.add(threadId);
    log(
      `discord typing: the thread's typing call was refused ${String(refusals)} times in a row, ` +
        "its indicator is not attempted again until it leaves and rejoins the working set",
    );
  }

  /**
   * One typing call, spent against the thread's own budget and never thrown out of the timer: a
   * refusal is logged and dropped, and the timer that called this keeps running regardless, since
   * the next tick eight seconds away is this keeper's own retry. Looks the thread's entry up by id
   * rather than closing over it, so a call a cleared or dropped thread's timer fires late (the gap
   * between `clearInterval` and the event loop's next turn) finds nothing left to act on.
   */
  async function fire(threadId: string, entry: Kept): Promise<void> {
    if (!entry.budget.affordable(now())) {
      repeats("a typing call was skipped", "the thread's bucket is paced out");
      return;
    }
    let outcome: CallOutcome<null>;
    try {
      outcome = await options.typing.sendTyping({ threadId });
    } catch (error) {
      repeats("a typing call failed", describeError(error));
      return;
    }
    if (outcome.status !== "failed") entry.budget.observe(outcome.rate, now());
    if (outcome.status === "rate-limited") {
      repeats("a typing call was skipped", "the bucket is empty");
      return;
    }
    if (outcome.status === "ok") return;
    if (outcome.fatal === true) {
      // Guarded on `stopped` rather than relying on `halt()`'s own idempotence: two threads can
      // both be mid-call when the token is rejected, and only the first to resume here should
      // report it, the same way the surface's own fatal handling reports once per credential.
      if (stopped) return;
      halt();
      options.onFatal?.("discord typing: the bot token was rejected, the surfaces are stopped");
      return;
    }
    repeats("a typing call failed", outcome.error);
    if (outcome.permanent !== true && outcome.missing !== true) return;
    entry.refusals += 1;
    if (entry.refusals >= MAX_THREAD_REFUSALS) drop(threadId, entry.refusals);
  }

  function start(threadId: string): void {
    const budget = budgetFor(threadId);
    const run = (): void => {
      const entry = kept.get(threadId);
      if (entry === undefined) return;
      void fire(threadId, entry);
    };
    const timer = schedule(run, TYPING_PERIOD_MS);
    kept.set(threadId, { timer, budget, refusals: 0 });
    run();
  }

  return {
    reconcile(working) {
      if (stopped) return;
      const workingSet = new Set(working);
      for (const threadId of [...kept.keys()]) {
        if (!workingSet.has(threadId)) clear(threadId);
      }
      // A dropped thread may restart only once it has left the working set: its absence here is
      // the only signal that whatever made it unreachable may no longer apply.
      for (const threadId of [...dropped]) {
        if (!workingSet.has(threadId)) dropped.delete(threadId);
      }
      for (const threadId of workingSet) {
        if (!kept.has(threadId) && !dropped.has(threadId)) start(threadId);
      }
    },
    stop() {
      halt();
      budgets.clear();
    },
  };
}
