// The rename budget, driven entirely by response headers.
//
// Discord's published documentation states no limit on modifying a channel or a thread, says
// explicitly that limits "should not be hard-coded", and tells an app to parse response headers
// instead. A stricter bucket for channel updates is widely reported by developers but is
// undocumented and can change without notice. So nothing here is a number taken on faith: the
// budget knows only what the last response told it.
import type { RateLimitObservation } from "./transport.ts";

/**
 * How long to hold off when a response reports an exhausted bucket but no reset time. Only reached
 * on a malformed or truncated set of headers; the normal path uses the reported reset.
 */
const BLIND_BACKOFF_MS = 5_000;

export type Budget = {
  /** Whether a call may be attempted now. A call that cannot be afforded is dropped, not queued. */
  affordable: (now: number) => boolean;
  /** Folds what a completed call learned about the bucket. */
  observe: (rate: RateLimitObservation, now: number) => void;
  /** When the block lifts, for logging. Zero when nothing is blocked. */
  blockedUntil: () => number;
};

export function createBudget(): Budget {
  let blockedUntil = 0;

  return {
    affordable: (now) => now >= blockedUntil,

    observe: (rate, now) => {
      if (rate.retryAfterMs !== null) {
        // A 429. The reported wait is the only authority on when this bucket is usable again.
        blockedUntil = now + rate.retryAfterMs;
        return;
      }
      if (rate.remaining === null) {
        // Headers absent: a transport failure, or an endpoint that did not report a bucket. An
        // existing block is left standing, and no new one is invented from an absence.
        return;
      }
      // An emptied bucket blocks until it reports itself refilled. Anything else clears the block:
      // the bucket has room, which is the only question this answers.
      blockedUntil = rate.remaining > 0 ? 0 : now + (rate.resetAfterMs ?? BLIND_BACKOFF_MS);
    },

    blockedUntil: () => blockedUntil,
  };
}
