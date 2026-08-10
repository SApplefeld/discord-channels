// The channel's pin list, held as the roster of what is running: a live session's card is pinned,
// an exited one's is unpinned, and the fleet usage card stays pinned for as long as it exists.
//
// Reconciled from Discord's own answer rather than from a broker-side flag. The list is read and
// driven toward the intended set, which is what survives a broker restart, a pin the operator added
// by hand, and a card rebuilt under a new message id after a 404: a flag saying "this one is
// pinned" survives none of those, because none of them pass through this process.
//
// The sweep reaches only the messages this broker recognizes as its own cards, so the channel is a
// place the operator can still pin something of their own.
//
// A pass is spent only when the intended set has changed or the last pass left something undone.
// Pinning writes a system message into the channel, one per pin, so a keeper that pinned and
// unpinned the same message across successive passes would write a line into the operator's channel
// on every pass; unpinning writes none. The converged gate is what makes a settled channel cost
// nothing at all, read included.
//
// The permission is Discord's `PIN_MESSAGES` bit, and this ships dark without it: the two writes are
// refused, the refusal is logged once per reason through the repeat limiter, the route stops being
// attempted, and every other surface behaves exactly as it does with no pins at all.
import { createBudget } from "./budget.ts";
import type { Budget } from "./budget.ts";
import type { CallOutcome, ChannelPins } from "./transport.ts";

/**
 * Discord's own ceiling on a channel's pins. At the ceiling the oldest live sessions keep their
 * pins and the newest arrivals go unpinned, because evicting an older session to make room would
 * unpin a card the operator may be watching.
 */
export const MAX_CHANNEL_PINS = 50;

/** Refusals of one route in a row, after which that route is not attempted again. */
const MAX_PERMANENT_FAILURES = 3;

/**
 * How long one reason waits before it may be logged again. Wide, like the fleet card's own limiter
 * and for the same reason: these lines are paced by a refresh timer measured in seconds, so a
 * narrow window would admit almost every repeat.
 */
const REPEAT_WINDOW_MS = 5 * 60 * 1000;

/**
 * The pins this channel is meant to carry.
 *
 * The permanent one is outside the ceiling: it is the fleet usage card, the one card that is always
 * relevant, so it is pinned before any session is and is never given up to make room.
 */
export type IntendedPins = {
  /** The fleet usage card, or null while this broker has none. */
  permanent: string | null;
  /** The cards of the sessions that are running. Order here is not read; age decides. */
  live: readonly string[];
  /**
   * Every message this broker recognizes as one of its own cards: the fleet card and every card a
   * thread binding names, live or not. The sweep reaches exactly this set, so a pin the operator
   * added by hand stays where they put it while an exited session's card is still dropped, because
   * its binding is still there.
   *
   * What the narrowing costs is named rather than hidden: a card whose binding has been pruned
   * entirely is no longer recognized, so a pin left over from one can only be removed by hand.
   */
  known: readonly string[];
};

export type PinKeeper = {
  /**
   * Drives the channel's pins toward the intended set. Safe to call on a timer: a call arriving
   * while a pass is running returns at once rather than starting a second one, and a call whose
   * intended set matches the last converged pass spends nothing.
   */
  reconcile: (intended: IntendedPins) => Promise<void>;
};

export type PinKeeperOptions = {
  pins: ChannelPins;
  /** Injected so a test drives budgets and the log window without sleeping. */
  now: () => number;
  log?: (message: string) => void;
};

/**
 * One Discord route this keeper works on, with the budget it spends and the refusals it has taken.
 *
 * Per route rather than per keeper, because the three fail for unrelated reasons: without the pin
 * permission the two writes are refused forever while the read keeps answering, and one counter
 * shared between them would give up on the read over refusals that belong to the writes. Their
 * buckets are separate too, since a read, a PUT, and a DELETE report their limits independently.
 */
type Route = {
  budget: Budget;
  /** Refusals in a row on this route; a landed call clears them. */
  refusals: number;
  /** True once the ceiling is reached. The other routes keep working. */
  stopped: boolean;
};

function createRoute(): Route {
  return { budget: createBudget(), refusals: 0, stopped: false };
}

/**
 * Rate-limits a repeating log line by its reason, which is a fixed phrase naming the cause; the
 * varying detail rides beside it and never keys the limiter. The same shape the fleet card's
 * limiter has, held locally for the reason it holds one: each layer owns its own log seam. It needs
 * no eviction, because the reasons this module logs are a fixed handful of literals.
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
        `discord pins: ${reason} occurred ${String(held.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS / 60_000)} minutes`,
      );
    }
    log(`discord pins: ${reason} (${detail})`);
    state.set(reason, { windowStart: at, suppressed: 0 });
  };
}

/**
 * Oldest first. A Discord id is a snowflake whose value rises with time, and it is the only age
 * this keeper has for a card that is not pinned yet, since a pinned-at time exists only for one
 * that already is. Compared by length and then character by character rather than as a number: the
 * ids are decimal integers with no sign and no leading zeros, which makes that ordering exact,
 * where a conversion to a JavaScript number would round two ids minted seconds apart onto one value.
 */
function olderFirst(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The intended set as one string, so an unchanged one is recognized without a Discord call.
 *
 * The recognized set is part of it, because it decides what a pass may unpin: the first pass after a
 * restart loads bindings naming cards that are pinned and not live, and a signature blind to them
 * would call a channel converged that this keeper has not yet swept.
 */
function signature(intended: IntendedPins): string {
  return [
    intended.permanent ?? "",
    [...intended.live].sort(olderFirst).join(","),
    [...intended.known].sort(olderFirst).join(","),
  ].join("|");
}

export function createPinKeeper(options: PinKeeperOptions): PinKeeper {
  const log = options.log ?? ((): void => {});
  const now = options.now;
  const repeats = createRepeatLog(log, now);
  const reads = createRoute();
  const pins = createRoute();
  const unpins = createRoute();
  let running = false;
  // Set only by a rejected credential, which no retry can fix.
  let halted = false;
  let lastSignature: string | null = null;
  // False until a pass drives the channel the whole way to the intended set. Anything left undone
  // for a reason a later pass could get past (an empty bucket, a refusal short of its ceiling, a
  // page that did not carry the whole list) clears it, so the work is picked up again rather than
  // waiting on the live set to change. A route that has stopped leaves it set, because no later
  // pass can do more than this one did, which is what keeps a host without the permission from
  // reading the pin list on every tick forever.
  let converged = false;

  /** Folds one call's outcome into the budget it came from and into that route's health. */
  function settle(route: Route, outcome: CallOutcome<unknown>, what: string): void {
    // A failed call's headers are deliberately not observed: a 4xx reports a bucket with room in
    // it, and letting that clear a standing block would turn a refusal into a retry storm.
    if (outcome.status !== "failed") route.budget.observe(outcome.rate, now());

    if (outcome.status === "rate-limited") {
      repeats(`the ${what} was dropped and will be retried`, "the bucket is empty");
      return;
    }
    if (outcome.status === "ok") {
      route.refusals = 0;
      return;
    }
    if (outcome.fatal === true) {
      halted = true;
      // Reported once, and not through the limiter: the REST client discards a rejected token, so
      // every later call would fail complaining about a missing token rather than a refused one.
      log("discord pins: the bot token was rejected, the pin list is no longer maintained");
      return;
    }
    if (outcome.missing === true) {
      // The message is gone: a card the operator deleted, or one rebuilt under a new id. There is
      // nothing to pin or unpin and nothing here owns the identifier, so it is not a refusal of the
      // route. The next pass is handed the new id by whoever owns the card.
      repeats(`the ${what} named a message that is gone`, outcome.error);
      return;
    }
    repeats(`the ${what} failed`, outcome.error);
    if (outcome.permanent !== true) return;
    route.refusals += 1;
    if (route.refusals < MAX_PERMANENT_FAILURES) return;
    route.stopped = true;
    // The ship-dark line: on a host that has not granted Pin Messages this is what the operator
    // sees, once, and nothing else about the channel differs from a broker with no pin list at all.
    log(
      `discord pins: the ${what} was refused ${String(route.refusals)} times in a row, ` +
        "it is not attempted again",
    );
  }

  /**
   * What the channel is meant to carry, in the order the ceiling reads: the permanent card first,
   * then the live sessions oldest first. Duplicates are collapsed, since one message pinned twice
   * is one pin.
   *
   * `heldByOthers` is how many of the channel's slots are already spent on pins this keeper does not
   * sweep. Discord's ceiling is the channel's, not this broker's share of it, so budgeting all fifty
   * for cards in a channel the operator also pins in asks for pins the channel has no room for: each
   * is refused permanently, and three refusals in a row stop the pin route for the life of the
   * process, long after the room comes back.
   */
  function wanted(
    intended: IntendedPins,
    heldByOthers: number,
  ): { kept: string[]; shortfall: number } {
    const live = [...new Set(intended.live)]
      .filter((messageId) => messageId !== intended.permanent)
      .sort(olderFirst);
    const room = MAX_CHANNEL_PINS - heldByOthers - (intended.permanent === null ? 0 : 1);
    const kept = intended.permanent === null ? [] : [intended.permanent];
    kept.push(...live.slice(0, Math.max(room, 0)));
    return { kept, shortfall: live.length - Math.min(live.length, Math.max(room, 0)) };
  }

  /** True when this pass left nothing a later one could finish. */
  async function run(intended: IntendedPins): Promise<boolean> {
    // Cleared by anything this pass leaves undone that a later one could finish.
    let complete = true;
    if (reads.stopped) return true;
    if (!reads.budget.affordable(now())) return false;
    const listed = await options.pins.listPins();
    settle(reads, listed, "pin list read");
    if (listed.status !== "ok") return reads.stopped;

    const pinned = listed.value.messageIds;
    // A partial page cannot be reasoned about in the pinning direction: a message missing from it
    // may be pinned on a page this pass never saw, and pinning it again writes a second system
    // message into the channel. Unpinning is unaffected, because a message on the page is pinned
    // whatever the rest of the list holds, and it is also what makes room.
    const whole = !listed.value.hasMore;
    if (!whole) complete = false;

    // The sweep's whole reach: this broker's own cards, and nothing else in the channel. A pin the
    // operator made by hand is in neither set and is left exactly where they put it.
    const ourCards = new Set([...intended.known, ...(intended.permanent === null ? [] : [intended.permanent])]);
    // Which is also what makes those pins part of the ceiling rather than of the budget: nothing
    // here will ever free their slots. A page that did not carry the whole list undercounts them,
    // and undercounting only widens the budget on a pass that pins nothing anyway.
    const heldByOthers = pinned.filter((messageId) => !ourCards.has(messageId)).length;

    const { kept, shortfall } = wanted(intended, heldByOthers);
    if (shortfall > 0) {
      repeats(
        "the channel is at its pin ceiling",
        `${String(shortfall)} live session(s) are left unpinned, the oldest keep their pins`,
      );
    }
    const intendedSet = new Set(kept);

    // Unpins first, so a channel at the ceiling has room for the pins below before they are tried.
    for (const messageId of pinned) {
      if (intendedSet.has(messageId) || !ourCards.has(messageId) || unpins.stopped) continue;
      if (halted) return false;
      if (!unpins.budget.affordable(now())) {
        complete = false;
        continue;
      }
      const unpinned = await options.pins.unpin({ messageId });
      settle(unpins, unpinned, "unpin");
      if (unpinned.status !== "ok" && !unpins.stopped) complete = false;
    }

    const alreadyPinned = new Set(pinned);
    for (const messageId of kept) {
      if (alreadyPinned.has(messageId) || pins.stopped) continue;
      if (!whole || halted) return false;
      if (!pins.budget.affordable(now())) {
        complete = false;
        continue;
      }
      const spent = await options.pins.pin({ messageId });
      settle(pins, spent, "pin");
      if (spent.status !== "ok" && !pins.stopped) complete = false;
    }

    return complete;
  }

  return {
    reconcile: async (intended) => {
      if (halted || running) return;
      const current = signature(intended);
      // The whole point of the gate: a channel already carrying the intended set costs no call at
      // all, so the reconcile can ride the same tick the session surfaces do.
      if (converged && current === lastSignature) return;
      running = true;
      lastSignature = current;
      converged = false;
      try {
        converged = await run(intended);
      } finally {
        running = false;
      }
    },
  };
}
