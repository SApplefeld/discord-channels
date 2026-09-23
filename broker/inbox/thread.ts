// The inbox card's thread: one thread this broker owns in the configured channel, whose starter
// message is the card, edited in place forever after.
//
// One card, edits only, on the board card's own discipline (`../board/thread.ts`): the thread is
// created once and rebound from the state file across restarts, its name is never changed, nothing
// is ever posted into it, and the card is rewritten only when the body the renderer composed differs
// byte for byte from the one this broker last saw land.
//
// Unlike the board and usage cards, this module reads no setting of its own: whether the card is
// built at all, and what it reads to draw it, are its caller's to decide. It takes the store's items,
// a session lookup, the guild accessor a jump link needs, the refresh interval and the transport to
// write with, and does nothing else with configuration. The knob that turns this card off, and the
// null check for a broker with no Discord configured, both live in the wiring that constructs it,
// the way `../board/thread.ts`'s own `createBoardCard` folds them in for the board card; this one
// leaves them to its caller instead, so a caller with nothing to build never constructs this module
// at all.
//
// Nothing is queued. A call that cannot be afforded, or that Discord refuses for the moment, is
// dropped and retried on the next tick, because the next tick reads the store fresh: a queued edit
// would land later carrying items that had stopped being true.
import { createBudget } from "../discord/budget.ts";
import type { Budget } from "../discord/budget.ts";
import type { CallOutcome, DiscordTransport } from "../discord/transport.ts";
import { createRepeatLog } from "../repeat-log.ts";
import type { RepeatLogSurface } from "../repeat-log.ts";
import { renderInboxCard } from "./card.ts";
import type { InboxSessionLookup } from "./card.ts";
import type { InboxItem } from "./store.ts";
import type { InboxCardBinding } from "./binding.ts";

/**
 * What the thread is called, for its whole life. Static by design: the name is the operator's handle
 * on the thread in a channel list, and the card inside it carries every changing fact.
 */
export const INBOX_THREAD_NAME = "Fleet: Inbox";

/**
 * How long one reason waits before it may be logged again, on the board card's own reasoning: wide
 * enough that a refresh timer producing the same line every tick is not what floods the log.
 */
const REPEAT_WINDOW_MS = 5 * 60 * 1000;

/** Refusals of one route inside the decay window, after which that route is not attempted again. */
const MAX_PERMANENT_FAILURES = 3;

/**
 * Rebuilds inside the decay window after Discord reported the card gone, after which the card is
 * given up on, on the board card's own reasoning.
 */
const MAX_REBUILDS = 3;

/** How many refresh passes a failure counts for, on the board card's own reasoning. */
const DECAY_PASSES = 3;

/**
 * The inbox card's repeat log, keyed by the fixed phrase naming the cause; the varying detail rides
 * beside it. Its reasons are a fixed handful of literals, like the sibling cards', so it needs no
 * sweep.
 */
export const INBOX_CARD_REPEAT_LOG: RepeatLogSurface<[detail: string]> = {
  windowMs: REPEAT_WINDOW_MS,
  firstLine: (reason, detail) => `inbox card: ${reason} (${detail})`,
  countLine: (reason, suppressed) =>
    `inbox card: ${reason} occurred ${String(suppressed)} more time(s) in the last ` +
    `${String(REPEAT_WINDOW_MS / 60_000)} minutes`,
};

export type InboxCardOptions = {
  /** Every open item, oldest opened first, read fresh on every tick. */
  items: () => readonly InboxItem[];
  /** The session facts the renderer needs, read fresh on every tick per item. */
  session: InboxSessionLookup;
  /** The guild the card's channel sits in, read fresh on every tick: null until the gateway has
   * cached it, which is one of the two things (with a flagged reply's message ID) a jump link to a
   * specific message needs. */
  guildId: () => string | null;
  /** What the card writes to and reads its rate limits from. */
  transport: DiscordTransport;
  /**
   * The thread this broker already owns, from the previous run. Read through a call rather than
   * passed, matching the sibling cards. The read happens at construction, not at `start`, so a
   * caller with nothing to build must not construct this module at all.
   */
  binding: () => InboxCardBinding | null;
  /** Called whenever the binding is created or changes, so the caller can persist it. */
  onBind?: (binding: InboxCardBinding) => void;
  /** How often the card is re-read and re-rendered. An edit is spent only when it changed. */
  refreshMs: number;
  /** Injected so a test drives budgets and ages without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
  /** Injected so a test drives the refresh without waiting on a real interval. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type InboxCard = {
  /**
   * Reconciles the card against the store. Safe to call on a timer: a call that lands while a pass
   * is running joins that pass rather than starting a second one, and the promise it returns is the
   * running pass's own.
   */
  tick: () => Promise<void>;
  /** Runs one pass at once and begins the refresh. Calling it twice runs one timer, not two. */
  start: () => void;
  /**
   * Clears the refresh timer synchronously and returns the drain: the promise of a pass already on
   * the wire. Waiting on it is what keeps a shutdown from racing an edit whose binding write has not
   * happened yet, and the synchronous clear is what lets a caller take this timer down in the same
   * block as its own, before it starts awaiting anything.
   */
  stop: () => Promise<void>;
  /**
   * The message the card is drawn on, for the channel's pin list, and null until one exists. Null
   * again for as long as a card Discord reported gone has not been rebuilt, so the pin the old
   * identifier held is dropped rather than kept against a message that is not there.
   */
  cardMessage: () => string | null;
};

/**
 * One Discord route this card writes on, with the budget it spends and the refusals it has taken,
 * on the sibling cards' own reasoning: a message create, a thread create, and a message edit fail
 * for unrelated reasons, so a block on one holds neither of the others back.
 */
type Route = {
  budget: Budget;
  /** Refusals in the current run; a landed call on this route clears them. */
  refusals: number;
  /** When the last refusal landed, and null when none has: nothing to accumulate against. */
  refusedAt: number | null;
  /** True once the ceiling is reached. The other two routes keep working. */
  stopped: boolean;
};

function createRoute(): Route {
  return { budget: createBudget(), refusals: 0, refusedAt: null, stopped: false };
}

/**
 * The count a failure arriving now carries: one more of a run still going, or the first of a new one.
 * A gap wider than the window says nothing about the call being made now, so it starts over.
 */
function accumulate(count: number, last: number | null, at: number, windowMs: number): number {
  return last !== null && at - last < windowMs ? count + 1 : 1;
}

/** The card's thread, built unconditionally from whatever this is handed: the caller decides whether
 * to call this at all, and what the store and the session lookup answer. */
export function createInboxCard(options: InboxCardOptions): InboxCard {
  const log = options.log ?? ((): void => {});
  const transport = options.transport;
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(INBOX_CARD_REPEAT_LOG, log, now);
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;

  // How long a failure of one kind counts toward its ceiling, in wall time.
  const decayMs = options.refreshMs * DECAY_PASSES;

  // Three routes, three budgets, on the sibling cards' own reasoning: these are the card's own
  // budget instances rather than the thread messenger's, so a refusal here never delays a permission
  // alert and a busy session surface never delays this card.
  const posts = createRoute();
  const opens = createRoute();
  const edits = createRoute();

  const persisted = options.binding();
  let messageId = persisted?.messageId ?? null;
  let threadId = persisted?.threadId ?? null;
  // What the card on Discord actually says, as far as an accepted call reported. Null after a
  // restart even when the message is rebound: its ages have moved on regardless, and the one edit
  // that re-establishes them costs less than persisting a body that may already be wrong.
  let rendered: string | null = null;
  let rebuilds = 0;
  let rebuiltAt: number | null = null;
  // Set only by the two failures that end the whole card: a rejected token, and a card being rebuilt
  // faster than it can be kept. A single route giving up carries its own flag instead.
  let halted = false;
  let timer: NodeJS.Timeout | null = null;
  // The pass on the wire, kept so shutdown can wait for it: clearing the timer cancels nothing that
  // has already been sent, or the binding write that follows it.
  let inFlight: Promise<void> = Promise.resolve();
  // The pass currently running, and null between passes. It is what a `tick` arriving mid-pass is
  // answered with, so every caller waits on the call actually on the wire.
  let pass: Promise<void> | null = null;
  // That same pass paired with the one copy of it whose failure is reported, so a timer fire landing
  // on a pass already running waits on that copy instead of attaching a second reporter to it.
  let observed: { pass: Promise<void>; reported: Promise<void> } | null = null;

  function bound(): void {
    if (messageId === null) return;
    options.onBind?.({ messageId, threadId });
  }

  /**
   * Folds one call's outcome into the budget it came from and into the health of this card. A failed
   * call's headers are deliberately not observed: a 4xx reports a bucket with room in it, and letting
   * that clear a standing block would turn a refusal into a retry storm.
   */
  function settle(route: Route, outcome: CallOutcome<unknown>, what: string): void {
    const at = now();
    if (outcome.status !== "failed") route.budget.observe(outcome.rate, at);

    if (outcome.status === "rate-limited") {
      repeats(`the card ${what} was dropped and will be retried`, "the bucket is empty");
      return;
    }
    if (outcome.status === "ok") {
      route.refusals = 0;
      route.refusedAt = null;
      return;
    }

    repeats(`the card ${what} failed`, outcome.error);
    if (outcome.fatal === true) {
      halted = true;
      // Reported once, and not through the limiter: the REST client discards a rejected token, so
      // every later call would fail complaining about a missing token rather than a refused one, and
      // this card makes none of them.
      log("inbox card: the bot token was rejected, the card is stopped");
      return;
    }
    if (outcome.missing === true) {
      // The message the card is drawn on is gone, which is what an operator deleting it looks like.
      // Both identifiers are dropped so the next tick builds a new card rather than calling a dead
      // one forever, bounded by the rebuild ceiling.
      messageId = null;
      threadId = null;
      rendered = null;
      rebuilds = accumulate(rebuilds, rebuiltAt, at, decayMs);
      rebuiltAt = at;
      if (rebuilds < MAX_REBUILDS) return;
      halted = true;
      log(
        `inbox card: the card went missing ${String(rebuilds)} times in a row, ` +
          `it is not rebuilt again`,
      );
      return;
    }
    if (outcome.permanent !== true) return;
    route.refusals = accumulate(route.refusals, route.refusedAt, at, decayMs);
    route.refusedAt = at;
    if (route.refusals < MAX_PERMANENT_FAILURES) return;
    route.stopped = true;
    log(
      `inbox card: the ${what} was refused ${String(route.refusals)} times in a row, ` +
        `it is not attempted again`,
    );
  }

  /** Posts the card. Returns true when there is a message to work with afterwards. */
  async function post(card: string): Promise<boolean> {
    if (posts.stopped || !posts.budget.affordable(now())) return false;
    const posted = await transport.postCard({ card });
    settle(posts, posted, "post");
    if (posted.status !== "ok") return false;
    messageId = posted.value.messageId;
    rendered = card;
    bound();
    return true;
  }

  /**
   * Opens the thread on the posted card. Separate from the post against separate failures: a thread
   * that could not be opened leaves a message that is kept and retried against, because reposting the
   * card whenever thread creation failed would fill the channel with orphaned cards at the refresh
   * interval.
   */
  async function open(messageIdentifier: string): Promise<void> {
    if (opens.stopped || !opens.budget.affordable(now())) return;
    const opened = await transport.openThread({
      messageId: messageIdentifier,
      name: INBOX_THREAD_NAME,
    });
    settle(opens, opened, "thread open");
    if (opened.status !== "ok") return;
    threadId = opened.value.threadId;
    bound();
  }

  async function edit(messageIdentifier: string, card: string): Promise<void> {
    if (edits.stopped || !edits.budget.affordable(now())) return;
    const outcome = await transport.editCard({ messageId: messageIdentifier, card });
    settle(edits, outcome, "edit");
    if (outcome.status !== "ok") return;
    rendered = card;
  }

  async function run(): Promise<void> {
    const at = now();
    const card = renderInboxCard({
      items: options.items(),
      session: options.session,
      guildId: options.guildId(),
      now: at,
    });

    // Creation first, and it is not held back by anything else: a card is worth far more than an
    // empty channel.
    if (messageId === null) await post(card);
    const identifier = messageId;
    if (identifier === null) return;
    if (threadId === null) await open(identifier);
    // The open can report the card itself gone, which drops the identifier this pass is holding.
    // Editing it anyway would spend a call on a message Discord has already said is not there.
    if (messageId === null) return;

    // A card that already says the right thing costs no Discord call.
    if (card === rendered) return;
    await edit(identifier, card);
  }

  /**
   * One pass at a time. A caller arriving mid-pass is answered with the pass already running rather
   * than with a promise of nothing: shutdown waits on what this returns, and a resolved stand-in
   * there would let a broker go down with a post still on the wire, whose binding never lands and
   * whose card the next start posts a second time.
   */
  function tick(): Promise<void> {
    if (halted) return Promise.resolve();
    if (pass !== null) return pass;
    const started = run().finally(() => {
      pass = null;
    });
    pass = started;
    return started;
  }

  /** One refresh pass, held so shutdown can wait for it. */
  function fire(): void {
    // A fire that joined the pass already running takes the copy that pass is already reported on.
    // One pass that fails is one failure however many fires observed it, and a second reporter on
    // the same rejection would count it again and log a repeat that never happened.
    if (observed !== null && observed.pass === pass) {
      inFlight = observed.reported;
      return;
    }
    // A rejection out of a pass would be fatal to the process under Node 24, taking the hook intake
    // down with the card, and the intake is the half that has to keep running.
    const started = tick();
    const reported = started.catch(() => {
      // The error is discarded unread: a transport failure can carry the request object, which holds
      // both the credential and the card body the call was writing.
      repeats("a refresh pass failed", "the detail is withheld, it can carry the request");
    });
    observed = { pass: started, reported };
    inFlight = reported;
  }

  return {
    tick,

    cardMessage: () => messageId,

    start: () => {
      if (timer !== null) return;
      timer = setTimer(fire, options.refreshMs);
      // And one pass now, rather than one interval from now. Creating or rebinding the thread is what
      // starting is for, and at the configured ceiling the card would otherwise be absent from the
      // channel for a refresh interval after a restart.
      fire();
    },

    stop: (): Promise<void> => {
      // Cleared before anything is awaited and before this returns, so a caller can take this timer
      // down in the same synchronous block as its own and await the drain later.
      if (timer !== null) clearTimer(timer);
      timer = null;
      // Every pass the timer starts is assigned here, which is every pass in a running card. A
      // `tick` a caller drives by hand is that caller's own to await.
      return inFlight;
    },
  };
}
