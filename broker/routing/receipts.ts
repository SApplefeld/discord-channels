// One reaction on each person's own message, in a session's thread, tracking where that message
// stands: handed to the session, picked up by a turn, or answered.
//
// A stage change adds the new emoji and then removes the old one, so a message is never shown
// with no stage at all, and the two writes for one message are chained so a fast run through all
// three stages cannot land on the wire out of order. Every reaction call is fire-and-forget from
// the caller's side: nothing here is awaited by delivery or posting, and a refusal is logged and
// dropped rather than retried, on the broker's own reaction budget.
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

export type ReceiptTrackerOptions = {
  reactions: MessageReactions;
  log: (message: string) => void;
  now: () => number;
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
  const budget: Budget = createBudget();
  const threads = new Map<string, Tracked[]>();
  // One promise chain per message, keyed by thread and message, so the add/remove pair of one
  // stage change and the add/remove pair of the next cannot interleave on the wire.
  const chains = new Map<string, Promise<void>>();
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

  /** One reaction write, spent against the shared budget and never thrown out of. */
  async function write(kind: "add" | "remove", threadId: string, messageId: string, emoji: string): Promise<void> {
    const at = options.now();
    if (!budget.affordable(at)) return;
    let outcome: CallOutcome<null>;
    try {
      outcome =
        kind === "add"
          ? await options.reactions.addReaction({ threadId, messageId, emoji })
          : await options.reactions.removeReaction({ threadId, messageId, emoji });
    } catch (error) {
      reportRefusal(String(error));
      return;
    }
    budget.observe(outcome.rate, options.now());
    if (outcome.status === "rate-limited") reportRefusal("the bucket is empty");
    if (outcome.status === "failed") reportRefusal(outcome.error);
  }

  /** Chains one message's next reaction task behind whatever it is already running. */
  function enqueue(threadId: string, messageId: string, task: () => Promise<void>): void {
    const key = `${threadId}:${messageId}`;
    const previous = chains.get(key) ?? Promise.resolve();
    const running = previous.then(task);
    chains.set(key, running);
    void running.then(() => {
      if (chains.get(key) === running) chains.delete(key);
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
      enqueue(threadId, messageId, () => write("add", threadId, messageId, STAGE_EMOJI.delivered));
    },

    pickedUp(threadId, at) {
      const list = threads.get(threadId);
      if (list === undefined) return;
      for (const entry of list) {
        if (entry.stage !== "delivered" || entry.deliveredAt > at) continue;
        entry.stage = "pickedUp";
        const messageId = entry.messageId;
        enqueue(threadId, messageId, async () => {
          await write("add", threadId, messageId, STAGE_EMOJI.pickedUp);
          await write("remove", threadId, messageId, STAGE_EMOJI.delivered);
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
        enqueue(threadId, messageId, async () => {
          await write("add", threadId, messageId, STAGE_EMOJI.answered);
          await write("remove", threadId, messageId, STAGE_EMOJI.pickedUp);
        });
      }
      threads.set(threadId, remaining);
    },

    forget(threadId) {
      threads.delete(threadId);
    },
  };
}
