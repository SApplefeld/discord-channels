// One reaction on each person's own message, in a session's thread, tracking where that message
// stands: handed to the session, picked up by a turn, or answered.
//
// A stage change adds the new emoji and, only once that lands, removes whatever is actually
// painted on the message right now, so a message is never shown with no stage at all, and a
// remove is never fired against a stage whose own add never reached Discord. Every write for one
// thread, across every message in it, runs through one serial queue: Discord's reaction buckets
// are per channel, and a thread is a channel, so the budget and the ordering are both scoped to
// the thread rather than to the message or to the tracker as a whole. A stage change's own
// add/remove pair is chained inside that same queue, so a fast run through all three stages still
// cannot land on the wire out of order. Every reaction call is fire-and-forget from the caller's
// side: nothing here is awaited by delivery or posting.
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

/** One tracked message: its current stage, when it was handed to the session, and what is
 * actually painted on it right now. */
type Tracked = {
  messageId: string;
  stage: "delivered" | "pickedUp";
  deliveredAt: number;
  /**
   * The emoji a landed add call last put on this message, or null before any add has landed. A
   * transition removes whatever this names, never the emoji its own stage machine assumes should
   * be there: a stage advances in memory as soon as its signal arrives, but its add can still be
   * refused, and a later transition's remove must clear what Discord is actually showing, not what
   * the prior stage would have painted had its own add landed.
   */
  painted: string | null;
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

/**
 * Waited past `budget.blockedUntil()` on top of the bucket's own reset, before a paced write is
 * retried. discord.js's REST client (`node_modules/@discordjs/rest` 2.6.3) folds a 50ms `offset`
 * into every reset it records (`dist/index.js:140` the default, `:1113` the fold into `this.reset`)
 * and refuses a call locally once `Date.now() < this.reset` (`:975`, `localLimited`), because this
 * broker's client is built with `rejectOnRateLimit: () => true` (broker/discord/rest.ts:70). A wait
 * that lands exactly on the bucket's own reset, with no margin, still wakes inside that client's
 * wider window and is refused before the request ever reaches the wire. The margin covers that
 * offset plus ordinary timer slop.
 */
export const PACE_MARGIN_MS = 100;

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

export function createReceiptTracker(options: ReceiptTrackerOptions): ReceiptTracker {
  const describeError =
    options.describe ?? ((error: unknown) => (error instanceof Error ? error.message : "unknown transport error"));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const threads = new Map<string, Tracked[]>();
  // A thread's rate budget, held apart from its queue and cleared only by `forget`. Discord's
  // reaction bucket for a thread does not reset just because this tracker's own queue drains: the
  // next write after a quiet stretch (the idle-session pickup that follows a delivered message by a
  // couple hundred milliseconds, commonly) can land while the bucket discord.js reported is still
  // exhausted, and a fresh budget would try it immediately instead of pacing against what is
  // actually still blocked.
  const budgets = new Map<string, Budget>();
  // The instant of each thread's last `answered` call, kept until `forget`. The tailer can read a
  // mid-turn injected message's own queued-command line up to `interimPollMs` behind the turn that
  // already answered it, so a `pickedUp` signal can arrive for a message whose reply already
  // posted; without this, that message is moved to 👀 on the strength of a stale signal and never
  // reaches ✅, because nothing else will ever call `answered` for that turn again.
  const lastAnsweredAt = new Map<string, number>();
  // One serial queue per thread, holding only the chain of writes still pending. Dropped once
  // nothing is chained behind the last task that ran, so a thread with no live traffic does not
  // hold a queue entry forever; the budget above outlives this regardless.
  const queues = new Map<string, Promise<void>>();
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

  function budgetFor(threadId: string): Budget {
    let budget = budgets.get(threadId);
    if (budget === undefined) {
      budget = createBudget();
      budgets.set(threadId, budget);
    }
    return budget;
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
      const wait = budget.blockedUntil() - at + PACE_MARGIN_MS;
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
    const budget = budgetFor(threadId);
    const priorTail = queues.get(threadId) ?? Promise.resolve();
    const running = priorTail
      .then(() => task(budget))
      .catch((error: unknown) => {
        // A throw here (from `options.log`, `options.now`, or `budget.observe`, none of which
        // `write` guards) must not wedge this thread's queue behind an unhandled rejection: the
        // task after it still has to run.
        reportRefusal(`an internal error interrupted a reaction write: ${describeError(error)}`);
      });
    queues.set(threadId, running);
    void running.then(() => {
      // Only when nothing chained onto this task while it ran: a later call already waiting on
      // `running` must keep this thread's own queue entry, not have it deleted out from under it.
      if (queues.get(threadId) === running) queues.delete(threadId);
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

  /**
   * One stage transition's task: adds `emoji`, and only once that lands, removes whatever the
   * entry's own record says is actually painted right now (skipped when that is already `emoji`,
   * or nothing at all). The record is updated to `emoji` only once the add has landed, so a
   * transition whose add is refused leaves the entry's `painted` field, and therefore the next
   * transition's remove target, exactly where it stood before this one ran.
   */
  function transition(
    threadId: string,
    entry: Tracked,
    emoji: string,
  ): (budget: Budget) => Promise<void> {
    return async (budget) => {
      const landed = await write(budget, threadId, entry.messageId, "add", emoji);
      if (!landed) return;
      const painted = entry.painted;
      if (painted !== null && painted !== emoji) {
        await write(budget, threadId, entry.messageId, "remove", painted);
      }
      entry.painted = emoji;
    };
  }

  return {
    delivered(threadId, messageId, at) {
      const list = trackedFor(threadId);
      const entry: Tracked = { messageId, stage: "delivered", deliveredAt: at, painted: null };
      list.push(entry);
      if (list.length > MAX_TRACKED_PER_THREAD) list.shift();
      enqueue(threadId, transition(threadId, entry, STAGE_EMOJI.delivered));
    },

    pickedUp(threadId, at) {
      const list = threads.get(threadId);
      if (list === undefined) return;
      const answeredAt = lastAnsweredAt.get(threadId);
      const remaining: Tracked[] = [];
      for (const entry of list) {
        if (entry.stage !== "delivered" || entry.deliveredAt > at) {
          remaining.push(entry);
          continue;
        }
        if (answeredAt !== undefined && at <= answeredAt) {
          // This turn already answered before the tailer's own poll caught up to the line that
          // credits this message's pickup: nothing will ever call `answered` for it again, so it
          // goes straight to ✅ rather than parking at 👀 forever.
          enqueue(threadId, transition(threadId, entry, STAGE_EMOJI.answered));
          continue;
        }
        entry.stage = "pickedUp";
        remaining.push(entry);
        enqueue(threadId, transition(threadId, entry, STAGE_EMOJI.pickedUp));
      }
      threads.set(threadId, remaining);
    },

    answered(threadId) {
      lastAnsweredAt.set(threadId, options.now());
      const list = threads.get(threadId);
      if (list === undefined) return;
      const remaining: Tracked[] = [];
      for (const entry of list) {
        if (entry.stage !== "pickedUp") {
          remaining.push(entry);
          continue;
        }
        enqueue(threadId, transition(threadId, entry, STAGE_EMOJI.answered));
      }
      threads.set(threadId, remaining);
    },

    forget(threadId) {
      threads.delete(threadId);
      budgets.delete(threadId);
      lastAnsweredAt.delete(threadId);
      // The queue is left alone: a chain still running for this thread (a write already in flight
      // when the thread was retired) must keep the entry its own drain cleanup reads, or a later
      // write racing in under the same id would collide with a chain nothing here is tracking
      // anymore. The queue's own drain cleanup in `enqueue` removes the entry once that chain ends.
    },
  };
}
