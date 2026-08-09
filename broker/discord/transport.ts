// The seam between the surface logic and Discord.
//
// Every call reports what the response said about the rate-limit bucket, because the budget is the
// scarce resource this design is built around and Discord's real one for a thread rename is
// undocumented. Nothing above this interface knows about HTTP, discord.js, or a token; nothing
// below it knows about sessions or states.
import type { ActionRow } from "./question-message.ts";

/**
 * What one call learned about its bucket. All times are milliseconds, converted at the adapter:
 * Discord sends `X-RateLimit-Reset-After` and a 429 body's `retry_after` in seconds.
 */
export type RateLimitObservation = {
  /** `X-RateLimit-Remaining`: calls left in this bucket. Null when the response carried none. */
  remaining: number | null;
  /** `X-RateLimit-Reset-After`: how long until the bucket refills. */
  resetAfterMs: number | null;
  /**
   * How long to wait before trying again: `retry_after` from a 429, or the block the writer's own
   * pre-flight budget refusal already holds, which names a wait without a 429 having happened.
   * Null unless the call was refused for rate limiting.
   */
  retryAfterMs: number | null;
};

/** A response that said nothing about the bucket, which is how a transport error reports. */
export const NO_RATE_INFO: RateLimitObservation = {
  remaining: null,
  resetAfterMs: null,
  retryAfterMs: null,
};

export type CallOutcome<T> =
  | { status: "ok"; value: T; rate: RateLimitObservation }
  | { status: "rate-limited"; rate: RateLimitObservation }
  | {
      status: "failed";
      error: string;
      rate: RateLimitObservation;
      /**
       * True when the credential itself was rejected. Retrying cannot fix it, and the REST client
       * discards the token on a 401, so every later call would fail with a message about a missing
       * token rather than a refused one.
       */
      fatal?: boolean;
      /**
       * True when Discord refused the request itself rather than the moment: a 4xx that is not a
       * 429. The same call will be refused the same way on every later pass, so a caller that
       * retries it forever is a caller that writes forever.
       */
      permanent?: boolean;
      /**
       * True when the object the call named is gone (404). Whatever identifier the call carried is
       * dead and cannot be reused.
       */
      missing?: boolean;
    };

export type DiscordTransport = {
  /** Posts the card to the host's channel. The message a thread is later opened on. */
  postCard: (input: { card: string }) => Promise<CallOutcome<{ messageId: string }>>;
  /**
   * Opens a thread on a message this bot posted. Separate from posting it because the two can fail
   * independently: a broker that reposted the card whenever thread creation failed would fill the
   * channel with orphans, and a bot that creates a thread from its own message owns that message
   * permanently, so the posted one is worth keeping and retrying against.
   */
  openThread: (input: {
    messageId: string;
    name: string;
  }) => Promise<CallOutcome<{ threadId: string }>>;
  /** Rewrites the starter message in place. It is never re-posted. */
  editCard: (input: { messageId: string; card: string }) => Promise<CallOutcome<null>>;
  renameThread: (input: { threadId: string; name: string }) => Promise<CallOutcome<null>>;
  archiveThread: (input: { threadId: string }) => Promise<CallOutcome<null>>;
};

/**
 * The two writes that post and edit a message in a thread rather than the card. Separate from
 * `DiscordTransport` because the two have different callers and different cadences: the surfaces
 * reconcile passive state on a timer and must never post, while the message routing posts and
 * edits only what a person is meant to see or be pinged about. The verbs sit on different Discord
 * rate buckets (a create-message POST and a message PATCH), which is why a caller holding both
 * must budget them separately rather than folding one route's headers into the other's.
 */
export type ThreadMessenger = {
  /**
   * Posts a new message into the thread. The id it returns, when Discord's response carries one,
   * is the target of a later `editInThread`; a 2xx whose body carries no readable id still reports
   * `ok`, because the message landed regardless of what the caller can read back from it.
   */
  postToThread: (input: {
    threadId: string;
    text: string;
    /**
     * The single Discord user this one message may resolve as a mention. Left unset on every
     * write but the permission prompt and the question alert, the two messages in this system
     * meant to reach a phone before the operator next looks at it.
     */
    mentionUserId?: string;
  }) => Promise<CallOutcome<{ messageId: string | null }>>;
  /**
   * Rewrites a message this bot posted into the thread. Never re-posts it.
   *
   * `components` replaces the message's rows whole, and an empty array is the only way to take
   * rows off a message: a PATCH that omits the field leaves the existing ones in place, so a
   * resolved question's message would keep buttons that answer a hold that has ended. Typed by the
   * one module that builds rows, imported for its type alone, so the shape a caller composes and
   * the shape that reaches the wire cannot drift.
   */
  editInThread: (input: {
    threadId: string;
    messageId: string;
    text: string;
    components?: readonly ActionRow[];
  }) => Promise<CallOutcome<null>>;
};

/**
 * The interaction callback: how a component press is answered.
 *
 * Its own surface beside `ThreadMessenger`, and its own rate bucket at every caller, because
 * `POST /interactions/{id}/{token}/callback` is a different Discord route from the message verbs and
 * reports its limits independently. A callback is also time-bounded in a way a message write is
 * not: Discord gives three seconds before the operator's client reports the interaction as failed,
 * so nothing here is queued or retried.
 */
export type InteractionResponder = {
  /**
   * Acknowledges a component press without changing the message: the deferred message update. What
   * follows it, an edit or nothing at all, is the caller's own decision, so one acknowledgement
   * covers a selection that only accumulates and one that resolves the whole ask.
   */
  acknowledge: (input: { interactionId: string; token: string }) => Promise<CallOutcome<null>>;
  /**
   * Answers with a message only the operator who pressed can see. What an incomplete Send and a
   * press against an ask that is no longer open are told: both are answers to that one person and
   * neither belongs in the thread.
   */
  ephemeral: (input: {
    interactionId: string;
    token: string;
    text: string;
  }) => Promise<CallOutcome<null>>;
};
