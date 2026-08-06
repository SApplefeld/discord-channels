// Every message this broker posts into a thread goes through here.
//
// The surfaces edit a card and rename a thread on a timer, and there is a budget for that because
// a write Discord refuses is a write repeated forever. A reply, a rejection notice, and a
// permission prompt are a different route and a different bucket, but the same hazard, and a worse
// one: they are the only writes something outside this machine can provoke. The sender gate means
// only the operator can provoke them, so the budget and the notice floor are what stand between an
// accident or a runaway session and the channel this fleet is watched from.
//
// Nothing is queued, for the same reason nothing is queued in the surfaces: a reply that lands
// minutes late answers a question the operator has stopped asking, and a notice that lands late
// says a session is dead long after the operator worked that out.
import { createBudget } from "../discord/budget.ts";
import type { Budget } from "../discord/budget.ts";
import { inertMessage } from "../discord/render.ts";
import type { CallOutcome, ThreadMessenger } from "../discord/transport.ts";

/**
 * Shortest gap between two notices in the same thread. A notice answers something the operator did,
 * so a tight burst of messages into a dead session's thread earns one answer, not one each.
 */
const NOTICE_FLOOR_MS = 60_000;

export type ThreadWriter = {
  /** Posts a reply from a session. Reports the outcome, because the model is told whether it landed. */
  reply: (threadId: string, text: string) => Promise<CallOutcome<null>>;
  /**
   * Posts a broker-authored notice, at most one per thread per floor interval. Returns true when it
   * was written. A dropped notice is not retried: the next message provokes the next one.
   */
  notice: (threadId: string, text: string) => Promise<boolean>;
  /**
   * Posts a message that mentions one user, or nobody when the caller passes null. Returns true
   * when it was written.
   *
   * The same bucket as the other two, deliberately: this is the write that reaches a phone, so a
   * flood of them is the loudest failure available here, and it is bounded by the budget rather
   * than exempted from it. It carries no per-thread floor, because unlike a notice it is the only
   * thing a waiting session can be answered through, and one silently dropped is a parked session.
   */
  alert: (threadId: string, text: string, mentionUserId: string | null) => Promise<boolean>;
};

export type ThreadWriterOptions = {
  messenger: ThreadMessenger;
  /** Injected so a test drives the budget and the notice floor without sleeping. */
  now: () => number;
  log?: (message: string) => void;
};

export function createThreadWriter(options: ThreadWriterOptions): ThreadWriter {
  const log = options.log ?? ((): void => {});
  // One bucket: both calls are POSTs to the same create-message route.
  const budget: Budget = createBudget();
  const lastNotice = new Map<string, number>();

  async function post(
    threadId: string,
    text: string,
    mentionUserId?: string,
  ): Promise<CallOutcome<null>> {
    const at = options.now();
    if (!budget.affordable(at)) {
      log(`routing: a message to thread ${threadId} was dropped, the bucket is empty`);
      return { status: "rate-limited", rate: { remaining: 0, resetAfterMs: null, retryAfterMs: null } };
    }
    const body = inertMessage(text);
    if (body === "") {
      return {
        status: "failed",
        error: "the message was empty",
        rate: { remaining: null, resetAfterMs: null, retryAfterMs: null },
      };
    }
    // The field is left off entirely rather than sent as undefined, so the only write that carries
    // a mentionable user is the one that meant to.
    const outcome = await options.messenger.postToThread({
      threadId,
      text: body,
      ...(mentionUserId === undefined ? {} : { mentionUserId }),
    });
    // A failed call's headers are deliberately not observed, the same rule the surfaces follow: a
    // 4xx reports a bucket with room in it, and letting that clear a standing block turns a refusal
    // into a retry storm.
    if (outcome.status !== "failed") budget.observe(outcome.rate, at);
    return outcome;
  }

  return {
    reply: (threadId, text) => post(threadId, text),

    async notice(threadId, text) {
      const at = options.now();
      const previous = lastNotice.get(threadId);
      if (previous !== undefined && at - previous < NOTICE_FLOOR_MS) return false;
      const outcome = await post(threadId, text);
      if (outcome.status !== "ok") return false;
      // Recorded only on a notice that actually landed, so a refused one does not silence the
      // thread for the next minute as well.
      lastNotice.set(threadId, at);
      return true;
    },

    async alert(threadId, text, mentionUserId) {
      const outcome = await post(threadId, text, mentionUserId ?? undefined);
      return outcome.status === "ok";
    },
  };
}
