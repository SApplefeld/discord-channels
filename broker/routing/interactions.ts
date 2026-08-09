// Discord to a held question: the second path a press from outside this machine reaches a running
// session by.
//
// The sender gate is the first thing `deliver` does, and it is in front of everything else for the
// reason it is in inbound.ts: a component press answers a question inside a running session, so who
// pressed it is the only authority for anything here. A press from anyone but the operator is
// ignored in silence, with nothing written to the thread and nothing said back to the presser: an
// interaction from an account this broker does not act for is not owed an error message, and a
// reply would confirm that the message it named is live.
//
// A `custom_id` is a reference and never evidence. It carries an opaque entry token and positions
// inside the ask that token names, so every value behind it is looked up in the desk rather than
// read off the wire, and an id naming an entry the desk no longer holds resolves to nothing at all.
//
// Question content never appears in the broker log at any level, the same rule the desk and the
// tailer hold: the lines here carry session ids, entry ids, and states.
import { createBudget } from "../discord/budget.ts";
import {
  CLOSED_NOTICE,
  autoSubmits,
  incompleteNotice,
  parseComponentId,
  parseOptionValue,
} from "../discord/question-message.ts";
import type { QuestionDesk, QuestionEntryView, QuestionSubmission } from "../question-desk.ts";
import type { InteractionResponder } from "../discord/transport.ts";
import type { SenderGate } from "../security/senders.ts";

/**
 * One component press read off the Discord gateway, reduced to what routing needs.
 *
 * The token is a credential for this one interaction and the only thing that can answer it, so it
 * is passed to the responder and never logged, stored, or rendered.
 */
export type InboundInteraction = {
  interactionId: string;
  token: string;
  /**
   * The thread it was pressed in, checked against the thread the entry's own message lives in
   * before anything is done with it: a `custom_id` is a string that travels, and nothing else in
   * the reference ties it to the one thread its message was ever drawn in.
   */
  threadId: string;
  /** The presser's Discord user ID. The allowlist over it is the only authority for anything here. */
  senderId: string;
  customId: string;
  /** Every option a select now has chosen; empty for a button. */
  values: readonly string[];
};

export type InteractionRouterOptions = {
  /** The allowlist over pressers. Required: there is no permissive default to fall back to. */
  gate: SenderGate;
  desk: QuestionDesk;
  responder: InteractionResponder;
  /**
   * Redraws a held ask's own message so the operator sees the selections the desk has accumulated.
   * A select reports its whole selection back to Discord, but the client redraws the menu from the
   * message, so an entry whose message is never rewritten shows the placeholder again after every
   * choice. Nothing here waits on the redraw's outcome past logging it: the selection is already
   * recorded, and a refused edit costs a confusing menu rather than a lost answer.
   */
  refresh: (entry: QuestionEntryView) => Promise<void>;
  /** Injected so a test drives the callback budget without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
};

export type InteractionRouter = {
  /** Routes one component press. Never throws: a failed callback is logged, not propagated. */
  deliver: (interaction: InboundInteraction) => Promise<void>;
};

/**
 * How long a run of the same rate-limited log reason is aggregated before its next flush, and how
 * many reasons are held while that happens.
 *
 * The refused-press line is the one line here anyone but the operator can drive: a press is one tap
 * by anybody who can see the thread, and one line per tap would push every other line out of the log
 * through rotation. A reason carries the presser's account id, so the key count is bounded by the
 * sweep rather than by who taps.
 */
const REPEAT_WINDOW_MS = 60_000;
const MAX_REPEAT_KEYS = 64;

/**
 * Rate-limits a repeating log line by its reason, which carries the account and the cause and
 * nothing that varies per repeat.
 *
 * The first of a reason is written at once; a repeat inside the window is counted, and the count
 * rides on the next line that window admits. Over the key bound the oldest closed windows are swept
 * and what each still owes is written on the way out, so the map is bounded over the life of the
 * process rather than by how many accounts ever pressed a button. Held locally, the same rule the
 * tailer's limiter and the desk's follow: each layer owns its own log seam.
 */
function createRepeatLog(
  log: (message: string) => void,
  now: () => number,
): (reason: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (reason) => {
    const at = now();
    const entry = state.get(reason);
    if (entry !== undefined && at - entry.windowStart < REPEAT_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    if (entry !== undefined && entry.suppressed > 0) {
      log(
        `routing: ${reason} occurred ${String(entry.suppressed)} more time(s) in the last ` +
          `${String(REPEAT_WINDOW_MS)}ms`,
      );
    }
    log(`routing: ${reason}`);
    state.set(reason, { windowStart: at, suppressed: 0 });
    if (state.size <= MAX_REPEAT_KEYS) return;
    const closed = [...state]
      .filter(([, kept]) => at - kept.windowStart >= REPEAT_WINDOW_MS)
      .sort(([, left], [, right]) => left.windowStart - right.windowStart);
    for (const [key, kept] of closed) {
      if (state.size <= MAX_REPEAT_KEYS) return;
      if (kept.suppressed > 0) {
        log(
          `routing: ${key} occurred ${String(kept.suppressed)} more time(s) in the last ` +
            `${String(REPEAT_WINDOW_MS)}ms`,
        );
      }
      state.delete(key);
    }
  };
}

/**
 * What a submit is answered with: nothing at all when it landed, since the ask's own message is
 * rewritten by the terminal state that ended it, and an ephemeral line otherwise. One mapping for
 * both the Send button and the tap that completes a single-select ask, so the two cannot answer the
 * same outcome differently.
 */
function submissionReply(submission: QuestionSubmission): string | null {
  if (submission.kind === "answered") return null;
  return submission.kind === "incomplete"
    ? incompleteNotice(submission.questionNumber)
    : CLOSED_NOTICE;
}

export function createInteractionRouter(options: InteractionRouterOptions): InteractionRouter {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const repeats = createRepeatLog(log, now);
  // The callback route's own bucket. A callback and a message write are separate Discord rate
  // surfaces reporting their limits independently, so folding them into one budget would let a
  // message route's headroom clear a block this route earned, or the reverse.
  const budget = createBudget();

  /**
   * Answers one interaction, at most once, under this route's own budget, which the caller has
   * already found affordable at `at`.
   *
   * Discord takes one callback per interaction, so the deferred acknowledgement and an ephemeral
   * reply are alternatives rather than a sequence. Nothing is retried: the client reports the press
   * as failed after about three seconds, by which time a retry is answering an interaction the
   * operator has already been told did not work.
   */
  async function answer(
    interaction: InboundInteraction,
    reply: string | null,
    at: number,
  ): Promise<void> {
    try {
      const outcome =
        reply === null
          ? await options.responder.acknowledge({
              interactionId: interaction.interactionId,
              token: interaction.token,
            })
          : await options.responder.ephemeral({
              interactionId: interaction.interactionId,
              token: interaction.token,
              text: reply,
            });
      // A failed call's headers are deliberately not observed, the writer's own rule: a 4xx
      // reports a bucket with room in it, and letting that clear a standing block turns a refusal
      // into a retry storm.
      if (outcome.status !== "failed") budget.observe(outcome.rate, at);
      if (outcome.status !== "ok") {
        log(
          `routing: an interaction callback in thread ${interaction.threadId} was not accepted: ` +
            (outcome.status === "rate-limited" ? "rate limited" : outcome.error),
        );
      }
    } catch {
      // The detail is discarded unread rather than described: a serialized transport error can
      // carry the request it was made for, and the request on this route carries the interaction's
      // own token, which is the credential that answers it.
      log(
        `routing: an interaction callback in thread ${interaction.threadId} failed; ` +
          "the error detail is withheld, it can carry a credential",
      );
    }
  }

  return {
    async deliver(interaction) {
      // Everything below this line is what one Discord account is trusted to do. Silent, with no
      // callback at all: the presser's client shows the interaction as failed, which is the honest
      // report, and this broker says nothing about a message it will not act on for them.
      //
      // Rate-limited, unlike the lines below it: a press is one tap by anyone who can see the
      // thread, so an account outside the allowlist can write one line per tap for as long as it
      // cares to, which would push every other line out of the log through rotation.
      if (!options.gate.allows(interaction.senderId)) {
        repeats(`ignored an interaction from ${interaction.senderId}, who is not the allowed sender`);
        return;
      }

      const reference = parseComponentId(interaction.customId);
      // A component this module did not write. Nothing else in this broker builds any, so the
      // reachable case is a message from an older build or another application's, and neither is
      // this desk's to answer.
      if (reference === null) return;

      // The whole callback budget, checked before anything the desk cannot take back. A press
      // resolved on the desk and then left unanswered is a session proceeding while the operator's
      // client reports the tap as failed and sends them to a console picker the hold is blinding,
      // so an empty bucket drops the press whole instead.
      const at = now();
      if (!budget.affordable(at)) {
        log(`routing: an interaction in thread ${interaction.threadId} was dropped, the bucket is empty`);
        return;
      }

      const entry = options.desk.entry(reference.entryId);
      // Both are the same answer: an entry nothing holds any longer, and one whose message lives in
      // another thread than the press came from. The second is defence behind the allowlist rather
      // than in front of it, and it is what keeps a `custom_id` from being a reference that resolves
      // anywhere it is pasted: the id is opaque, but it is still only a string that travels.
      if (entry === null || entry.alert === null || entry.alert.threadId !== interaction.threadId) {
        // The hold ended while the message was still on the operator's screen: answered from
        // another device, released, expired, or gone with the session. The message they pressed is
        // edited by the terminal state that ended it, and this tells the person who pressed.
        await answer(interaction, CLOSED_NOTICE, at);
        return;
      }

      if (reference.action.kind === "console") {
        // The release is digest-checked inside the desk, so a press against an ask the session has
        // since replaced releases nothing. Answered first, because the release edits this very
        // message through the terminal seam and Discord takes one callback per press.
        await answer(interaction, null, at);
        const released = options.desk.releaseEntry(reference.entryId);
        log(
          `routing: session ${entry.sessionId}'s question was released to the console from the thread` +
            (released ? "" : "; the hold had already ended"),
        );
        return;
      }

      if (reference.action.kind === "send") {
        await answer(interaction, submissionReply(options.desk.submit(reference.entryId)), at);
        return;
      }

      // A press that names an option: a button carries its own position and a select carries the
      // whole of what is now chosen. Positions never leave this layer as anything but positions;
      // the desk resolves them against its own copy of the ask.
      const chosen =
        reference.action.optionIndex === null
          ? interaction.values
              // Read by the module that wrote the values, so the two cannot come to disagree about
              // what a select's option value means.
              .map((value) => parseOptionValue(value))
              .filter((value): value is number => value !== null)
          : [reference.action.optionIndex];
      const updated = options.desk.select(reference.entryId, reference.action.questionIndex, chosen);
      if (updated === null) {
        await answer(interaction, CLOSED_NOTICE, at);
        return;
      }

      // The whole ask is answered by this tap when nothing is left to choose and no question is a
      // multi-select: a single-select ask is complete the moment its last question has a value, and
      // a Send button would be one more tap for nothing. Anything else accumulates and waits.
      if (autoSubmits(updated.questions, updated.selections)) {
        await answer(interaction, submissionReply(options.desk.submit(reference.entryId)), at);
        return;
      }

      // Acknowledged before the redraw: the callback is the three-second clock, the edit is not.
      await answer(interaction, null, at);
      try {
        await options.refresh(updated);
      } catch {
        // The redraw reports a refused edit itself; what reaches here is a throw out of the
        // transport, whose detail is discarded unread because a serialized one can carry the
        // request it was made for, and that request is the question message.
        log(
          `routing: redrawing session ${entry.sessionId}'s question message threw; ` +
            "the error detail is withheld, it can carry content",
        );
      }
    },
  };
}
