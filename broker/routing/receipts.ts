// One reaction on each person's own message, in a session's thread, tracking where that message
// stands: handed to the session, picked up by a turn, or answered.
//
// A stage change adds the new emoji and then removes the old one, so a message is never shown
// with no stage at all. Every write for one thread, across every message in it, runs through one
// serial queue: Discord's reaction buckets are per channel, and a thread is a channel, so the
// budget and the ordering are both scoped to the thread rather than to the message or to the
// tracker as a whole. A stage change's own add/remove pair is chained inside that same queue, so a
// fast run through all three stages still cannot land on the wire out of order. Every reaction call
// is fire-and-forget from the caller's side: nothing here is awaited by delivery or posting.
//
// A write the thread's own budget cannot afford right now waits, inside the queue, for the bucket
// to refill, up to a bound; past that bound it is skipped rather than delayed further, logged and
// dropped like any other refusal. Nothing here is retried once attempted: a call that comes back
// rate-limited or failed is logged and dropped, not tried again.
import type { Budget } from "../discord/budget.ts";
import { createBudget } from "../discord/budget.ts";
import type { CallOutcome, MessageReactions } from "../discord/transport.ts";

/** The three stage emoji, in one place so the operator can swap any of them. */
export const STAGE_EMOJI = {
  delivered: "📨",
  pickedUp: "👀",
  answered: "✅",
} as const;

/** One tracked message: its current stage and when it was handed to the session. */
type Tracked = {
  messageId: string;
  stage: "delivered" | "pickedUp";
  deliveredAt: number;
};

/**
 * Tracked messages per thread, oldest first. Bounded so a thread nobody answers cannot grow this
 * map without limit; the oldest is dropped, which leaves its last-painted reaction standing
 * forever rather than spending unbounded memory to keep advancing it.
 */
const MAX_TRACKED_PER_THREAD = 50;

/** How long a run of reaction refusals is aggregated before its next log line, mirroring the
 * windowed refusal logging `gateway.ts`'s system-notice cleaner uses. */
const REFUSAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * How long a write will wait for a thread's paced-out budget to refill before it gives up on this
 * attempt. Discord's own reset for an emptied reaction bucket is on the order of a quarter second,
 * so this is generous headroom above the normal case; past it, the bucket is either genuinely
 * behind or the budget's own blind backoff is standing in for a response that carried no reset,
 * and either way delaying a stage change further costs more than skipping this one write.
 */
const MAX_PACE_WAIT_MS = 5_000;

export type ReceiptTrackerOptions = {
  reactions: MessageReactions;
  log: (message: string) => void;
  now: () => number;
  /**
   * Turns a thrown error into a string safe to log. Optional so a test needs nothing beyond a
   * plain thrown value to drive a refusal line; the broker wires broker/discord/rest.ts's
   * `describe` here once Discord is configured, since a discord.js error's default
   * stringification can carry the request object, Authorization header included. Not imported
   * here directly: this module is loaded unconditionally, and `rest.ts` is the one file that
   * pulls in discord.js, loaded only by a broker actually configured to reach Discord.
   */
  describe?: (error: unknown) => string;
  /**
   * Waits out a thread's paced budget before a write is attempted. Injected so a test can drive
   * the pacing wait without real time; defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
};

export type ReceiptTracker = {
  /** The message was handed to the session: track it and paint 📨. */
  delivered: (threadId: string, messageId: string, at: number) => void;
  /**
   * A turn in this thread started carrying every message still at 📨 whose `deliveredAt` is at or
   * before `at`: each moves to 👀. A message delivered after `at` is still queued behind this turn
   * and stays at 📨.
   */
  pickedUp: (threadId: string, at: number) => void;
  /** The session posted a reply: every message at 👀 moves to ✅ and leaves tracking. */
  answered: (threadId: string) => void;
  /** The thread's session ended or its thread was retired: drop its tracking. */
  forget: (threadId: string) => void;
};

/** One thread's serial write queue and the rate budget scoped to it. */
type ThreadQueue = {
  budget: Budget;
  /** The last task chained onto this thread's queue; the next write chains behind it. */
  tail: Promise<void>;
};

export function createReceiptTracker(options: ReceiptTrackerOptions): ReceiptTracker {
  const describeError =
    options.describe ?? ((error: unknown) => (error instanceof Error ? error.message : "unknown transport error"));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const threads = new Map<string, Tracked[]>();
  // One queue per thread, holding that thread's own budget: Discord's reaction buckets are per
  // channel and a thread is a channel, so a burst across several messages in one thread must pace
  // against one shared budget instead of racing several independent ones. Dropped once nothing is
  // chained behind the last task that ran, so a thread with no live traffic does not hold a budget
  // forever; the next write after a drain starts against a fresh one.
  const queues = new Map<string, ThreadQueue>();
  let loggedAt: number | null = null;
  let suppressed = 0;

  function reportRefusal(reason: string): void {
    const at = options.now();
    if (loggedAt !== null && at - loggedAt < REFUSAL_WINDOW_MS) {
      suppressed += 1;
      return;
    }
    const more = suppressed === 0 ? "" : ` (and ${String(suppressed)} more since the last line)`;
    options.log(`receipts: a reaction call was refused: ${reason}${more}`);
    loggedAt = at;
    suppressed = 0;
  }

  function queueFor(threadId: string): ThreadQueue {
    let queue = queues.get(threadId);
    if (queue === undefined) {
      queue = { budget: createBudget(), tail: Promise.resolve() };
      queues.set(threadId, queue);
    }
    return queue;
  }

  /**
   * One reaction write, spent against the thread's own budget and never thrown out of. Waits out a
   * paced budget up to `MAX_PACE_WAIT_MS`; past that, the write is skipped rather than delayed
   * further. Reports whether the call landed, so a paired remove can be made to depend on it.
   */
  async function write(
    budget: Budget,
    threadId: string,
    messageId: string,
    kind: "add" | "remove",
    emoji: string,
  ): Promise<boolean> {
    const at = options.now();
    if (!budget.affordable(at)) {
      const wait = budget.blockedUntil() - at;
      if (wait > MAX_PACE_WAIT_MS) {
        reportRefusal("the thread's bucket is paced past the wait bound, the write is skipped");
        return false;
      }
      await sleep(wait);
    }
    let outcome: CallOutcome<null>;
    try {
      outcome =
        kind === "add"
          ? await options.reactions.addReaction({ threadId, messageId, emoji })
          : await options.reactions.removeReaction({ threadId, messageId, emoji });
    } catch (error) {
      reportRefusal(describeError(error));
      return false;
    }
    budget.observe(outcome.rate, options.now());
    if (outcome.status === "rate-limited") {
      reportRefusal("the bucket is empty");
      return false;
    }
    if (outcome.status === "failed") {
      reportRefusal(outcome.error);
      return false;
    }
    return true;
  }

  /** Chains one thread's next reaction task behind whatever it is already running. */
  function enqueue(threadId: string, task: (budget: Budget) => Promise<void>): void {
    const queue = queueFor(threadId);
    const running = queue.tail
      .then(() => task(queue.budget))
      .catch((error: unknown) => {
        // A throw here (from `options.log`, `options.now`, or `budget.observe`, none of which
        // `write` guards) must not wedge this thread's queue behind an unhandled rejection: the
        // task after it still has to run.
        reportRefusal(`an internal error interrupted a reaction write: ${describeError(error)}`);
      });
    queue.tail = running;
    void running.then(() => {
      // Only when nothing chained onto this task while it ran: a later call already waiting on
      // `running` must keep the budget it started against, not a fresh one.
      if (queues.get(threadId)?.tail === running) queues.delete(threadId);
    });
  }

  function trackedFor(threadId: string): Tracked[] {
    let list = threads.get(threadId);
    if (list === undefined) {
      list = [];
      threads.set(threadId, list);
    }
    return list;
  }

  return {
    delivered(threadId, messageId, at) {
      const list = trackedFor(threadId);
      list.push({ messageId, stage: "delivered", deliveredAt: at });
      if (list.length > MAX_TRACKED_PER_THREAD) list.shift();
      enqueue(threadId, async (budget) => {
        await write(budget, threadId, messageId, "add", STAGE_EMOJI.delivered);
      });
    },

    pickedUp(threadId, at) {
      const list = threads.get(threadId);
      if (list === undefined) return;
      for (const entry of list) {
        if (entry.stage !== "delivered" || entry.deliveredAt > at) continue;
        entry.stage = "pickedUp";
        const messageId = entry.messageId;
        enqueue(threadId, async (budget) => {
          const landed = await write(budget, threadId, messageId, "add", STAGE_EMOJI.pickedUp);
          if (landed) await write(budget, threadId, messageId, "remove", STAGE_EMOJI.delivered);
        });
      }
    },

    answered(threadId) {
      const list = threads.get(threadId);
      if (list === undefined) return;
      const remaining: Tracked[] = [];
      for (const entry of list) {
        if (entry.stage !== "pickedUp") {
          remaining.push(entry);
          continue;
        }
        const messageId = entry.messageId;
        enqueue(threadId, async (budget) => {
          const landed = await write(budget, threadId, messageId, "add", STAGE_EMOJI.answered);
          if (landed) await write(budget, threadId, messageId, "remove", STAGE_EMOJI.pickedUp);
        });
      }
      threads.set(threadId, remaining);
    },

    forget(threadId) {
      threads.delete(threadId);
      queues.delete(threadId);
    },
  };
}
