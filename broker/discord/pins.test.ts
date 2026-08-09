import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHANNEL_PINS, createPinKeeper } from "./pins.ts";
import type { IntendedPins } from "./pins.ts";
import type { CallOutcome, ChannelPins, RateLimitObservation } from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

const START = 1_000_000;
const HEALTHY: RateLimitObservation = { remaining: 4, resetAfterMs: 5_000, retryAfterMs: null };

function ok<T>(value: T): CallOutcome<T> {
  return { status: "ok", value, rate: HEALTHY };
}

/** A refusal Discord will repeat: the 403 a bot without Pin Messages takes on both writes. */
function forbidden(): CallOutcome<never> {
  return { status: "failed", error: "HTTP 403", rate: HEALTHY, permanent: true };
}

type Channel = {
  pins: ChannelPins;
  /** What the channel currently carries, in the order the route would answer it. */
  list: string[];
  hasMore: boolean;
  reads: number;
  pinned: string[];
  unpinned: string[];
  /** Scripted results for the next call of each kind. Anything unscripted succeeds. */
  nextList: CallOutcome<{ messageIds: readonly string[]; hasMore: boolean }> | null;
  nextPin: CallOutcome<null> | null;
  nextUnpin: CallOutcome<null> | null;
  /** Every write is refused the way a host without the permission refuses it. */
  refuseWrites: boolean;
  calls: () => number;
};

function channel(list: string[] = []): Channel {
  const state: Channel = {
    list,
    hasMore: false,
    reads: 0,
    pinned: [],
    unpinned: [],
    nextList: null,
    nextPin: null,
    nextUnpin: null,
    refuseWrites: false,
    calls: () => state.reads + state.pinned.length + state.unpinned.length,
    pins: {
      listPins: async () => {
        state.reads += 1;
        const scripted = state.nextList;
        state.nextList = null;
        return scripted ?? ok({ messageIds: [...state.list], hasMore: state.hasMore });
      },
      pin: async ({ messageId }) => {
        state.pinned.push(messageId);
        const scripted = state.nextPin ?? (state.refuseWrites ? forbidden() : null);
        state.nextPin = null;
        if (scripted !== null) return scripted;
        state.list.push(messageId);
        return ok(null);
      },
      unpin: async ({ messageId }) => {
        state.unpinned.push(messageId);
        const scripted = state.nextUnpin ?? (state.refuseWrites ? forbidden() : null);
        state.nextUnpin = null;
        if (scripted !== null) return scripted;
        state.list = state.list.filter((held) => held !== messageId);
        return ok(null);
      },
    },
  };
  return state;
}

function keeperWith(pins: ChannelPins, logged: string[] = [], now = () => START) {
  return createPinKeeper({ pins, now, log: (message) => logged.push(message) });
}

function intended(permanent: string | null, live: string[]): IntendedPins {
  return { permanent, live };
}

test("a divergent pin list converges: what is missing is pinned, what is stale is unpinned", async () => {
  // The reconcile reads Discord's own answer rather than a broker-side flag, which is what survives
  // a restart, a card rebuilt under a new id, and a pin the operator added by hand: none of those
  // pass through this process, so none of them would show up in a flag.
  const room = channel(["4000", "4001", "4009"]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended("4000", ["4001", "4002"]));

  assert.deepEqual(room.unpinned, ["4009"], "a pin whose session is gone is dropped");
  assert.deepEqual(room.pinned, ["4002"], "a live session missing from the list is pinned");
  assert.deepEqual([...room.list].sort(), ["4000", "4001", "4002"]);
});

test("the fleet card stays pinned across a pass that changes every session pin", async () => {
  const room = channel(["4000", "4005"]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended("4000", ["4007"]));

  assert.deepEqual(room.unpinned, ["4005"]);
  assert.deepEqual(room.pinned, ["4007"]);
  assert.ok(room.list.includes("4000"), "the one card that is always relevant is never given up");
});

test("a session that exits drops out of the pin list on the next pass", async () => {
  const room = channel([]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended(null, ["4001", "4002"]));
  assert.deepEqual(room.pinned, ["4001", "4002"]);

  // The exit: the surface stops reporting that card as live, which is the whole input this reads.
  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.unpinned, ["4002"]);
  assert.deepEqual(room.list, ["4001"]);
});

test("two identical passes over a converged channel spend nothing at all", async () => {
  // Pinning writes a system message into the channel, one per pin, so a keeper that re-derived the
  // list every tick would be a keeper the operator reads as churn. A converged channel whose
  // intended set has not changed is not even read.
  const room = channel([]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended("4000", ["4001"]));
  const spent = room.calls();
  assert.equal(spent, 3, "one read, two pins");

  await keeper.reconcile(intended("4000", ["4001"]));
  await keeper.reconcile(intended("4000", ["4001"]));
  assert.equal(room.calls(), spent, "a converged pass costs no call, the read included");
});

test("a session that exits and comes back costs one call per transition and nothing between", async () => {
  // The presumed-dead backstop can call a merely quiet session exited and a later hook can wake it.
  // Each of those is a genuinely different intended set, so each drives exactly one write; what the
  // channel must never pay is a write on a pass whose input said the same thing as the last one,
  // because a pin writes a system message into the channel and an operator reads that as churn.
  const room = channel([]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended(null, ["4001"]));
  await keeper.reconcile(intended(null, []));
  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.pinned, ["4001", "4001"], "one pin per pass that asked for it");
  assert.deepEqual(room.unpinned, ["4001"], "and one unpin for the pass that did not");

  // The pass that follows the flap costs nothing, which is what keeps a settled channel settled.
  const spent = room.calls();
  await keeper.reconcile(intended(null, ["4001"]));
  assert.equal(room.calls(), spent);
});

test("at the pin ceiling the oldest live sessions keep their pins and the shortfall is logged once", async () => {
  // Evicting an older session to make room would unpin a card the operator may be watching, so the
  // newest arrivals are what go unpinned. A Discord id rises with time, and it is the only age a
  // card that is not pinned yet has.
  const room = channel([]);
  const logged: string[] = [];
  const keeper = keeperWith(room.pins, logged);
  // Ten past the ceiling, offered newest first so nothing here can pass by accident of order.
  const live = Array.from({ length: MAX_CHANNEL_PINS + 10 }, (_, at) => String(6000 + at)).reverse();

  await keeper.reconcile(intended("5000", live));

  assert.equal(room.pinned.length, MAX_CHANNEL_PINS, "the channel takes no more than fifty");
  assert.equal(room.pinned[0], "5000", "the permanent card is pinned before any session is");
  assert.deepEqual(
    room.pinned.slice(1, 4),
    ["6000", "6001", "6002"],
    "oldest first, whatever order they were offered in",
  );
  assert.ok(!room.pinned.includes("6059"), "the newest arrival goes unpinned");
  const shortfall = logged.filter((line) => line.includes("pin ceiling"));
  assert.equal(shortfall.length, 1, logged.join("\n"));
  assert.match(shortfall[0], /11 live session\(s\) are left unpinned/);
});

test("without the permission every write is refused, one line names it, and nothing else changes", async () => {
  // The ship-dark shape rather than a fallback: a host that has not granted Pin Messages sees one
  // log line and a channel that behaves exactly as it does with no pin list at all.
  const room = channel(["4009"]);
  room.refuseWrites = true;
  const logged: string[] = [];
  const keeper = keeperWith(room.pins, logged);

  for (let pass = 0; pass < 6; pass += 1) {
    await keeper.reconcile(intended("4000", ["4001"]));
  }

  assert.deepEqual(room.list, ["4009"], "the channel's pins are exactly what they were");
  assert.equal(
    logged.filter((line) => line.includes("is not attempted again")).length,
    2,
    `the pin route and the unpin route each give up once: ${logged.join("\n")}`,
  );
  const refusals = room.pinned.length + room.unpinned.length;
  assert.ok(refusals <= 6, `a refused route stops being attempted: ${String(refusals)} writes`);

  // And a route that has given up is not read for either: a stopped keeper costs no calls at all.
  const spent = room.calls();
  await keeper.reconcile(intended("4000", ["4001", "4002"]));
  assert.equal(room.reads, spent - refusals + 1, "one more read, and no further writes");
  assert.equal(room.pinned.length + room.unpinned.length, refusals);
});

test("with the permission granted the same intended set pins, from the same starting point", async () => {
  // The other direction of the same test: nothing about the keeper's decisions depends on the
  // permission, only on what Discord answered.
  const room = channel(["4009"]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended("4000", ["4001"]));

  assert.deepEqual(room.unpinned, ["4009"]);
  assert.deepEqual(room.pinned, ["4000", "4001"]);
});

test("a fleet card rebuilt under a new id takes the pin with it", async () => {
  // The card is rebuilt after Discord reports it gone, under an id nothing in this process could
  // have predicted. Reconciling from the channel's own list is what moves the pin.
  const room = channel([]);
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended("4000", []));
  assert.deepEqual(room.pinned, ["4000"]);

  await keeper.reconcile(intended("4100", []));
  assert.deepEqual(room.unpinned, ["4000"]);
  assert.deepEqual(room.pinned, ["4000", "4100"]);
});

test("a partial page holds the pins back and is retried, while its unpins still land", async () => {
  // A message missing from a page that did not carry the whole list may be pinned on a page this
  // pass never saw, and pinning it again writes a second system message into the channel. A pin the
  // page does show is pinned whatever the rest of the list holds, so the unpin is safe and is also
  // what makes room.
  const room = channel(["4009"]);
  room.hasMore = true;
  const keeper = keeperWith(room.pins);

  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.unpinned, ["4009"]);
  assert.deepEqual(room.pinned, [], "nothing is pinned against a list that was not read whole");

  // The next pass sees a whole page, and the unchanged intended set is retried rather than skipped.
  room.hasMore = false;
  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.pinned, ["4001"]);
});

test("a pin dropped for an empty bucket is retried on the next pass, not left undone", async () => {
  // The intended set has not changed, so only the unconverged pass is what brings the keeper back.
  const room = channel([]);
  const keeper = keeperWith(room.pins);
  room.nextPin = { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: 0 } };

  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.list, [], "the pin did not land");

  await keeper.reconcile(intended(null, ["4001"]));
  assert.deepEqual(room.list, ["4001"]);
});

test("a rejected token stops the keeper rather than being retried", async () => {
  const room = channel([]);
  const logged: string[] = [];
  const keeper = keeperWith(room.pins, logged);
  room.nextList = {
    status: "failed",
    error: "the bot token was rejected",
    rate: NO_RATE_INFO,
    fatal: true,
    permanent: true,
  };

  await keeper.reconcile(intended(null, ["4001"]));
  await keeper.reconcile(intended(null, ["4002"]));

  assert.equal(room.reads, 1, "no call is made after the credential was refused");
  assert.equal(logged.filter((line) => line.includes("token was rejected")).length, 1);
});

test("a message that is gone is not counted as a refusal of the route", async () => {
  // A card the operator deleted, or one rebuilt under a new id. Nothing here owns the identifier,
  // so there is nothing to drop and nothing to give up on.
  const room = channel([]);
  const logged: string[] = [];
  const keeper = keeperWith(room.pins, logged);

  for (let pass = 0; pass < 4; pass += 1) {
    room.nextPin = {
      status: "failed",
      error: "HTTP 404",
      rate: HEALTHY,
      permanent: true,
      missing: true,
    };
    await keeper.reconcile(intended(null, [`400${String(pass)}`]));
  }

  assert.equal(room.pinned.length, 4, "the route keeps being attempted for later cards");
  assert.equal(logged.filter((line) => line.includes("is not attempted again")).length, 0);
});
