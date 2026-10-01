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
 * How often the indicator is refreshed for a thread still working. Discord shows "is typing..." for
 * ten seconds per call (confirmed: Discord's channel resource docs, cited in the spec's "What Is
 * Known"), so eight seconds leaves two seconds of margin against a tick landing a little late.
 */
export const TYPING_PERIOD_MS = 8_000;

/**
 * How long a run of typing refusals is aggregated before its next log line. Wide, like the pin
 * keeper's and the receipt tracker's own windows, and for the same reason: this is paced by an
 * eight-second timer, so a narrow window would admit almost every repeat.
 */
const REFUSAL_WINDOW_MS = 5 * 60 * 1000;

export type TypingKeeper = {
  /**
   * Drives the kept timers to match `working`: the thread ids whose derived state is `working`
   * right now. A thread newly in the set gets one call at once and then one every
   * `TYPING_PERIOD_MS`; a thread no longer in it has its timer cleared at once.
   */
  reconcile: (working: readonly string[]) => void;
  /** Clears every timer. Called once, at broker shutdown. */
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

  /** One kept thread: the interval driving its refresh, and the budget it spends against. */
  type Kept = { timer: NodeJS.Timeout; budget: Budget };
  const kept = new Map<string, Kept>();

  /**
   * One typing call, spent against the thread's own budget and never thrown out of the timer: a
   * refusal is logged and dropped, and the timer that called this keeps running regardless, since
   * the next tick eight seconds away is this keeper's own retry.
   */
  async function fire(threadId: string, budget: Budget): Promise<void> {
    if (!budget.affordable(now())) {
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
    budget.observe(outcome.rate, now());
    if (outcome.status === "rate-limited") {
      repeats("a typing call was skipped", "the bucket is empty");
      return;
    }
    if (outcome.status === "failed") {
      repeats("a typing call failed", outcome.error);
    }
  }

  function start(threadId: string): void {
    const budget = createBudget();
    void fire(threadId, budget);
    const timer = schedule(() => {
      void fire(threadId, budget);
    }, TYPING_PERIOD_MS);
    kept.set(threadId, { timer, budget });
  }

  function clear(threadId: string): void {
    const entry = kept.get(threadId);
    if (entry === undefined) return;
    unschedule(entry.timer);
    kept.delete(threadId);
  }

  return {
    reconcile(working) {
      const workingSet = new Set(working);
      for (const threadId of [...kept.keys()]) {
        if (!workingSet.has(threadId)) clear(threadId);
      }
      for (const threadId of workingSet) {
        if (!kept.has(threadId)) start(threadId);
      }
    },
    stop() {
      for (const threadId of [...kept.keys()]) clear(threadId);
    },
  };
}
