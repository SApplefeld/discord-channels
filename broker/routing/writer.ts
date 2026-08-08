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
import { usableWaitMs } from "../discord/adapter.ts";
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
  /**
   * Posts a reply from a session. Reports the outcome, because the model is told whether it
   * landed, and the id it carries on success, when Discord's response yielded one, is the target
   * of a later `edit` on the same message.
   */
  reply: (threadId: string, text: string) => Promise<CallOutcome<{ messageId: string | null }>>;
  /**
   * Rewrites a message this writer posted. Spends its own budget, separate from `reply`, `notice`,
   * and `alert`: a message PATCH is a different Discord rate bucket from the create-message POST
   * the other three share, and folding one route's headers into the other's budget would let an
   * edit's headroom clear a block a post 429 earned, or an edit 429 silence replies and notices
   * that were never refused.
   */
  edit: (threadId: string, messageId: string, text: string) => Promise<CallOutcome<null>>;
  /**
   * Posts a broker-authored notice, at most one per thread per floor interval. Returns true when it
   * was written. A dropped notice is not retried: the next message provokes the next one.
   */
  notice: (threadId: string, text: string) => Promise<boolean>;
  /**
   * Posts a message that mentions one user, or nobody when the caller passes null. Returns true
   * when it was written.
   *
   * The same bucket as `reply` and `notice`, deliberately: this is the write that reaches a phone,
   * so a flood of them is the loudest failure available here, and it is bounded by the budget
   * rather than exempted from it. It carries no per-thread floor, because unlike a notice it is the
   * only thing a waiting session can be answered through, and one silently dropped is a parked
   * session.
   */
  alert: (threadId: string, text: string, mentionUserId: string | null) => Promise<boolean>;
};

export type ThreadWriterOptions = {
  messenger: ThreadMessenger;
  /** Injected so a test drives the budget and the notice floor without sleeping. */
  now: () => number;
  log?: (message: string) => void;
};

/** The neutralized body, or null when the text carries nothing to send once neutralized. */
function neutralize(text: string): string | null {
  const body = inertMessage(text);
  return body === "" ? null : body;
}

/** The shared shape of "nothing to send": a failure that carries no bucket claim either way. */
function emptyMessageFailure<T>(): CallOutcome<T> {
  return {
    status: "failed",
    error: "the message was empty",
    rate: { remaining: null, resetAfterMs: null, retryAfterMs: null },
  };
}

export function createThreadWriter(options: ThreadWriterOptions): ThreadWriter {
  const log = options.log ?? ((): void => {});
  // Two buckets, not one: a create-message POST and a message PATCH are different Discord rate
  // buckets, so a caller that folded their headers into one budget would let an edit's headroom
  // clear a block a post 429 earned, or an edit 429 silence the replies, notices, and alerts that
  // spend the post budget and were never refused.
  const postBudget: Budget = createBudget();
  const editBudget: Budget = createBudget();
  const lastNotice = new Map<string, number>();

  // Shared by every write this module makes: the budget check, the observe-only-on-non-failure
  // rule, and the drop log all live here once rather than once per verb. `budget` is whichever of
  // the two buckets the caller's verb spends, so the check and the observation land on the same
  // one. `send` is only reached when that bucket has room, and its outcome is the whole function's
  // outcome.
  async function withBudget<T>(
    budget: Budget,
    verb: string,
    threadId: string,
    send: () => Promise<CallOutcome<T>>,
  ): Promise<CallOutcome<T>> {
    const at = options.now();
    if (!budget.affordable(at)) {
      log(`routing: ${verb} to thread ${threadId} was dropped, the bucket is empty`);
      // The remaining block, reported as the wait a caller would have to sit out, so one field
      // answers "how long" for a refusal this bucket made on its own and for a 429 Discord made,
      // whose `retry_after` the transport forwards in the same place. Read off the bucket this
      // verb spends and no other: a create POST and a message PATCH are separate Discord buckets,
      // so the wait one route earned says nothing about the other's.
      //
      // Held to the same bound a wait read off the wire is held to, because this is a producer of
      // the field in its own right and the transport's clamp never sees what it makes: the block it
      // subtracts from was set by whatever the bucket last observed, so a refusal here can report a
      // wait no caller could act on without any response being involved at all.
      return {
        status: "rate-limited",
        rate: {
          remaining: 0,
          resetAfterMs: null,
          retryAfterMs: usableWaitMs(budget.blockedUntil() - at),
        },
      };
    }
    const outcome = await send();
    // A failed call's headers are deliberately not observed, the same rule the surfaces follow: a
    // 4xx reports a bucket with room in it, and letting that clear a standing block turns a refusal
    // into a retry storm.
    if (outcome.status !== "failed") budget.observe(outcome.rate, at);
    return outcome;
  }

  function post(
    threadId: string,
    text: string,
    mentionUserId?: string,
  ): Promise<CallOutcome<{ messageId: string | null }>> {
    return withBudget(postBudget, "a post", threadId, async () => {
      const body = neutralize(text);
      if (body === null) return emptyMessageFailure();
      // The field is left off entirely rather than sent as undefined, so the only write that
      // carries a mentionable user is the one that meant to.
      return options.messenger.postToThread({
        threadId,
        text: body,
        ...(mentionUserId === undefined ? {} : { mentionUserId }),
      });
    });
  }

  function edit(threadId: string, messageId: string, text: string): Promise<CallOutcome<null>> {
    return withBudget(editBudget, "an edit", threadId, async () => {
      const body = neutralize(text);
      if (body === null) return emptyMessageFailure();
      return options.messenger.editInThread({ threadId, messageId, text: body });
    });
  }

  return {
    reply: (threadId, text) => post(threadId, text),
    edit,

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
