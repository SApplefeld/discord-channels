// Discord to session: the one path a message from outside this machine takes to reach Claude.
//
// The sender gate is the first thing `deliver` does, and it is deliberately in front of everything
// else: the thread lookup, the verdict pattern, and the relay pipe all sit behind it, so a message
// from anyone the roster does not name is refused before this file has read anything but who wrote
// it. A verdict-shaped message is not a special case there, and it must not become one, because a
// verdict approves a tool call in a running session.
//
// Behind the gate, the paths that consume a message as the operator's act key on the sender's
// class and never on the author's name: a verdict, a held question's typed answer, and the inbox
// clears run only for an operator. A participant's message, whatever its shape, is delivered as
// the text it is.
//
// The response gate, where a host turns it on, is the last thing before the pipe: a message that
// every reading above has passed joins its thread's buffer instead of going down at once, and the
// buffer goes down whole when a message addresses the bot or a cap is reached. Nothing about who
// may say what moves; only when the session hears it.
//
// A process token identifies a pipe. It is not evidence about who sent a message, and no check
// here consults it for that.
import { withoutInvisible } from "../sanitize.ts";
import { parseVerdict } from "../security/permission.ts";
import type { PermissionDesk } from "../security/permission.ts";
import type { SenderClass, SenderGate } from "../security/senders.ts";
import type { Registry, SessionRecord } from "../registry.ts";
import type { RelayEvent, RelayHub } from "./relays.ts";
import { bufferedEvent, createResponseGate } from "./response-gate.ts";
import type { BufferDelivery, ResponseGate, ResponseGateMode } from "./response-gate.ts";
import type { ThreadWriter } from "./writer.ts";

/**
 * A message read off the Discord gateway, reduced to what routing needs.
 *
 * The text is untrusted data and stays data: it is passed to the relay verbatim, never interpolated
 * into anything the broker or the relay treats as a command, and never editorialized.
 */
export type InboundMessage = {
  /** The thread it was posted in, which is what identifies the session it is addressed to. */
  threadId: string;
  /**
   * The message's own Discord ID. Nothing in inbound routing reads it: it is the freshness signal
   * the outbound router's narration coalescing consumes, riding here because every message that
   * lands in a thread, this bot's own posts included, arrives over this one gateway event.
   */
  messageId: string;
  /** The author's Discord user ID. The allowlist over it is the only authority for anything here. */
  senderId: string;
  /**
   * The author's display name, already bounded by the gateway's `authorName` for the attribute it
   * rides on the delivered event. A label for the reader and never an authority: nothing here
   * decides anything on it.
   */
  author: string;
  /** True when this bot wrote it. Its own cards, replies, and notices all come back over the gateway. */
  fromBot: boolean;
  /**
   * True when the message mentions this bot's own user directly. A role mention or an @everyone is
   * not one. Read by the response gate alone, which delivers a held buffer on it.
   */
  mentionsBot: boolean;
  /**
   * True when the message replies to one this bot wrote. A reply to anyone else's, or one whose
   * referenced message is gone, is not one. Read by the response gate alone, as the mention is.
   */
  repliesToBot: boolean;
  text: string;
};

/**
 * Ceiling on the text handed to a session, in code points. It matches Discord's own maximum
 * message length, the 4,000-character Nitro ceiling and the longest message any client can send,
 * so no message Discord delivers is cut. The slice below is the backstop for a future cap change,
 * not a working path. The pipe carrying the text is the session's own MCP transport, so the bound
 * stays the broker's to set rather than Discord's.
 */
export const MAX_INBOUND_TEXT_LENGTH = 4_000;

/**
 * Most messages one session is handed in a window, and the window. A session steered from a phone
 * receives a handful of messages an hour; a burst past this is a mistake or a stuck client, and
 * the ceiling keeps either from flooding a running session's context.
 */
export const MAX_INBOUND_PER_WINDOW = 20;
const INBOUND_WINDOW_MS = 60_000;

/**
 * Bounded, free of anything that can hide or reorder what it says, and cut on code points so a
 * truncation cannot leave a lone surrogate. Still entirely attacker-controlled text.
 *
 * The invisible class is stripped here rather than at a render site because this path has no render
 * site: the text goes to the model, while the operator reads the original in Discord. A bidi
 * override is exactly the character that would show those two different messages, and the whole
 * control this design rests on is a person deciding what is safe to send.
 *
 * Whether the cut fired rides along with the text, because announcing it is not this function's
 * call: the notice belongs only to a message that was actually delivered, and only the caller
 * knows whether one was.
 */
function bounded(text: string): { text: string; truncated: boolean } {
  const visible = withoutInvisible(text).trim();
  const characters = [...visible];
  const truncated = characters.length > MAX_INBOUND_TEXT_LENGTH;
  return {
    text: truncated ? characters.slice(0, MAX_INBOUND_TEXT_LENGTH).join("") : visible,
    truncated,
  };
}

/**
 * The operator inbox's clearing seam. What reaches it is only what an operator wrote: everything
 * here sits behind the sender gate, and the router calls it for an operator's message alone.
 */
export type InboundInbox = {
  /**
   * An operator's message reached a live or stale session at `at`. A message landing mid-turn may
   * fire no prompt hook, so the delivery is itself the operator answering that session.
   */
  clear: (sessionId: string, at: number) => void;
  /**
   * An operator wrote in an ended session's thread at `at`. Nothing is delivered, and the post is
   * still the operator having seen that session's last word.
   */
  clearEnded: (sessionId: string, at: number) => void;
};

/**
 * The response gate as the broker configures it. The router builds the gate from these rather than
 * taking one built elsewhere, because the gate's age-cap timer delivers into this router's own pipe
 * and thread, and only this file holds both.
 */
export type ResponseGateSettings = {
  mode: ResponseGateMode;
  /** A held buffer delivers on reaching this many messages. */
  maxMessages: number;
  /** A held buffer delivers once its oldest message is this old. */
  maxWaitMs: number;
  /** Injected so a test fires the age cap without sleeping. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type InboundRouterOptions = {
  registry: Registry;
  relays: RelayHub;
  /** The allowlist over message authors. Required: there is no permissive default to fall back to. */
  gate: SenderGate;
  /** Where a verdict goes, and the only thing that decides whether one names an open request. */
  permissions: PermissionDesk;
  /**
   * The question desk's typed-answer seam. Required, like the gate and the desk above: a router
   * wired without it would hand a parked session's answer to the model as chat and leave the
   * question waiting for a hold expiry nobody is watching for.
   */
  questions: {
    /** True when this text answered the session's held question, and is therefore spent. */
    answerTyped: (sessionId: string, response: string) => boolean;
  };
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  /** Writes a notice back into the thread a message could not be delivered from. */
  writer: ThreadWriter;
  /**
   * The operator inbox, present only while it is on. A message consumed as a permission verdict or
   * a held question's answer never reaches it: each answers a prompt the session is parked on, not
   * whatever the session last asked in its reply.
   */
  inbox?: InboundInbox;
  /**
   * The response gate's mode and caps. Absent, or in any mode but `live`, every admitted message is
   * delivered at once, which is the path a host with one account has always had.
   */
  responseGate?: ResponseGateSettings;
  /** Injected so a test drives the rate ceiling without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
};

export type InboundRouter = {
  /** Routes one gateway message. Never throws: a failed notice is logged, not propagated. */
  deliver: (message: InboundMessage) => Promise<void>;
  /**
   * Drops the held buffer, and its timer, of every thread whose session has ended or left the
   * registry, delivering nothing. Called with the full record set on every registry mutation, the
   * seam the inbox reconciles on, because a session ends on several paths and that is the one
   * that sees them all. A no-op with the gate off. Never throws.
   */
  reconcile: (sessions: readonly SessionRecord[]) => void;
  /**
   * Drops every held buffer and its timer, delivering nothing. For the broker stopping: a held
   * buffer is not a reason to wait, and its timer must not fire into pipes being torn down. A
   * no-op with the gate off. Never throws.
   */
  close: () => void;
};

/**
 * A session whose thread was never reached is not addressed by this message, and a session with no
 * thread at all cannot be. The registry is small (a handful of sessions per host, plus a day of
 * retained dead ones), so this is a scan rather than a second index that could fall out of step
 * with the surface's own bindings.
 *
 * A live session wins over an ended one holding the same thread, which is what a supersession looks
 * like for the moment before the old thread is retired.
 */
function sessionForThread(
  records: readonly SessionRecord[],
  threadFor: (sessionId: string) => string | null,
  threadId: string,
): SessionRecord | null {
  let ended: SessionRecord | null = null;
  for (const record of records) {
    if (threadFor(record.sessionId) !== threadId) continue;
    if (record.state !== "ended") return record;
    ended = record;
  }
  return ended;
}

/** What the thread is told when a message had nowhere to go. */
export const ENDED_NOTICE =
  "This session has ended, so the message was not delivered. Nothing is queued: start a new " +
  "session and it opens its own thread.";

export const UNREACHABLE_NOTICE =
  "This session has no channel connected, so the message was not delivered. It is still running; " +
  "it was started without the relay, or the relay is reconnecting.";

/**
 * The unreachable notice for what was dropped: the single-message notice above, byte for byte,
 * for one message, and a count for a held buffer of more, since a dropped buffer loses every
 * message in it and a notice about one would understate the loss.
 */
export function unreachableNotice(count: number): string {
  if (count === 1) return UNREACHABLE_NOTICE;
  return (
    `This session has no channel connected, so ${String(count)} messages were not delivered. It ` +
    "is still running; it was started without the relay, or the relay is reconnecting."
  );
}

/**
 * Posted after a cut message was delivered, so the loss of the tail is never silent. Only the
 * delivered path earns it: a cut on text that reached no session is noise about a message nobody
 * received.
 */
export const TRUNCATED_NOTICE =
  `This message was cut at ${MAX_INBOUND_TEXT_LENGTH.toLocaleString("en-US")} characters, so ` +
  "the session received only the beginning. The rest was not delivered: resend it as its own " +
  "message.";

export function createInboundRouter(options: InboundRouterOptions): InboundRouter {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const recent = new Map<string, number[]>();

  /** True while this session has room in the window, which it then spends. */
  function withinRate(sessionId: string): boolean {
    const at = now();
    const stamps = (recent.get(sessionId) ?? []).filter((when) => at - when < INBOUND_WINDOW_MS);
    if (stamps.length >= MAX_INBOUND_PER_WINDOW) {
      recent.set(sessionId, stamps);
      return false;
    }
    stamps.push(at);
    recent.set(sessionId, stamps);
    // A session that has gone quiet leaves its window behind. Sessions are pruned from the registry
    // at the retention horizon and this map has no such horizon, so anything that ages out of every
    // window is dropped rather than held for the life of the daemon.
    for (const [other, when] of recent) {
      if (other !== sessionId && when.every((stamp) => at - stamp >= INBOUND_WINDOW_MS)) {
        recent.delete(other);
      }
    }
    return true;
  }

  /**
   * Hands one clear to the inbox. A throw behind it is caught here, since the message it rides on
   * has already been routed and must not read as failed; the line names the session and never the
   * error, whose owner reports its own.
   */
  function toInbox(clear: (inbox: InboundInbox) => void, sessionId: string): void {
    if (options.inbox === undefined) return;
    try {
      clear(options.inbox);
    } catch {
      log(`routing: the inbox could not take a message to session ${sessionId}`);
    }
  }

  async function notice(threadId: string, text: string): Promise<void> {
    try {
      await options.writer.notice(threadId, text);
    } catch (error) {
      log(`routing: could not post a notice into thread ${threadId}: ${String(error)}`);
    }
  }

  /**
   * Announces one cut after the text it was cut from reached a live session. Only the delivered
   * path earns it: on every undelivered path (no thread, ended session, over the rate ceiling, no
   * relay, a buffer dropped with its session), a cut is noise about text nobody received.
   *
   * Posted as a reply rather than a notice, deliberately: the notice floor would let a recent
   * failure notice swallow this announcement, or let this announcement swallow the next failure
   * notice, and a suppressed announcement recreates the silent loss it exists to kill. Its volume
   * is bounded without the floor: the inbound rate ceiling caps deliveries per minute, and the
   * writer's post budget paces the wire.
   */
  async function announceCut(threadId: string): Promise<void> {
    try {
      const outcome = await options.writer.reply(threadId, TRUNCATED_NOTICE);
      if (outcome.status !== "ok") {
        log(`routing: could not announce a truncation in thread ${threadId}: ` + outcome.status);
      }
    } catch (error) {
      log(`routing: could not announce a truncation in thread ${threadId}: ` + String(error));
    }
  }

  /**
   * Writes one event down the session's pipe, or tells the thread the session is unreachable and
   * how many messages that cost. True when the pipe took it.
   */
  async function handOver(
    record: SessionRecord,
    threadId: string,
    event: RelayEvent,
    count: number,
  ): Promise<boolean> {
    if (options.relays.deliver(record.processToken, event)) return true;
    log(`routing: session ${record.sessionId} has no relay attached, rejecting in-thread`);
    await notice(threadId, unreachableNotice(count));
    return false;
  }

  /**
   * Delivers a buffer the gate released, on a message's own act or on the timer, and announces
   * each cut it carried. The inbox is not cleared here: an operator's message cleared it when the
   * buffer took it, since the operator had answered the session either way.
   */
  async function handOverBuffer(
    record: SessionRecord,
    threadId: string,
    delivery: BufferDelivery,
  ): Promise<void> {
    const event = bufferedEvent(threadId, delivery.messages);
    if (!(await handOver(record, threadId, event, delivery.messages.length))) return;
    if (delivery.messages.length > 1) {
      log(
        `routing: delivered ${String(delivery.messages.length)} buffered messages to session ` +
          `${record.sessionId} on ${delivery.trigger}`,
      );
    }
    for (const message of delivery.messages) {
      if (message.truncated) await announceCut(threadId);
    }
  }

  /**
   * Whether a buffer held for `sessionId` in `threadId` still has that session to go to: one that
   * is live and is the session the thread resolves to now. A session that ended, left the
   * registry, or handed its thread to its replacement leaves the buffer with nowhere to go, and
   * it is dropped rather than delivered to whoever holds the thread next.
   */
  function stillHeldFor(
    records: readonly SessionRecord[],
    threadId: string,
    sessionId: string,
  ): SessionRecord | null {
    const record = sessionForThread(records, options.threadFor, threadId);
    if (record === null || record.state === "ended" || record.sessionId !== sessionId) return null;
    return record;
  }

  /**
   * The age cap fired for a thread. The session is looked up again rather than trusted from the
   * buffer, because it may have ended or been superseded while the buffer waited: `reconcile`
   * drops such a buffer the moment the registry says so, and this is the same answer for a
   * router nothing reconciles.
   */
  async function expired(
    threadId: string,
    sessionId: string,
    delivery: BufferDelivery,
  ): Promise<void> {
    const record = stillHeldFor(options.registry.list(), threadId, sessionId);
    if (record === null) {
      log(
        `routing: dropped ${String(delivery.messages.length)} buffered messages held for session ` +
          `${sessionId}, which no longer holds thread ${threadId}`,
      );
      return;
    }
    await handOverBuffer(record, threadId, delivery);
  }

  // Built only for `live`. `off` and `shadow` deliver at once below, and the absence of a gate is
  // what keeps that path the one it always was rather than a gate with a pass-through mode.
  const gate: ResponseGate | null =
    options.responseGate?.mode === "live"
      ? createResponseGate({
          maxMessages: options.responseGate.maxMessages,
          maxWaitMs: options.responseGate.maxWaitMs,
          // Fire and forget, on the timer's own tick: the delivery never rejects by construction,
          // and the catch is the same backstop the gateway puts behind `deliver`.
          onAgeCap: (threadId, sessionId, delivery) => {
            void expired(threadId, sessionId, delivery).catch((error: unknown) => {
              log(`routing: delivering a buffer at the age cap failed: ${String(error)}`);
            });
          },
          ...(options.responseGate.setTimer === undefined
            ? {}
            : { setTimer: options.responseGate.setTimer }),
          ...(options.responseGate.clearTimer === undefined
            ? {}
            : { clearTimer: options.responseGate.clearTimer }),
        })
      : null;

  return {
    async deliver(message) {
      // Everything this broker writes into a thread arrives back over the same gateway. Without
      // this, the first reply would be routed straight back into the session that prompted it.
      // It stands in front of the gate because it is a drop and not a pass: a bot's own ID is
      // never the allowlisted one, so the gate below would refuse it a line later either way.
      if (message.fromBot) return;

      // Everything below this line is what a rostered Discord account is trusted to do, and the
      // class decides how much. Gating on the thread instead would make access to the room the
      // credential, and every member of the channel could steer a session and approve its tool
      // calls.
      const senderClass: SenderClass | null = options.gate.classOf(message.senderId);
      if (senderClass === null) {
        log(`routing: refused a message from ${message.senderId}, who is not the allowed sender`);
        return;
      }
      // Whether this message can be the operator's act: a verdict, a held question's answer, or the
      // inbox clear. A participant talks to the session and answers nothing on the operator's
      // behalf, so every one of those paths is skipped for them and their message flows on as text.
      const operator = senderClass === "operator";

      const { text, truncated } = bounded(message.text);
      // An attachment, a sticker, or a message whose whole content was invisible. There is nothing
      // to hand a session, and a notice would only be noise.
      if (text === "") return;

      // A verdict that names a request this thread has open is consumed as a verdict and nothing
      // else. Forwarding it as chat as well would hand the model a message the operator wrote for
      // the broker, in the middle of a turn parked on the very prompt it answers. The pattern is
      // anchored, so ordinary prose that happens to carry a verdict is not one and falls through to
      // the session below.
      //
      // A verdict shape that resolved nothing is not consumed here. The pattern is a word and five
      // letters, which is also an ordinary English reply, so the message stays in play for the
      // readings below and is reported as an unknown request only once they have all declined it.
      //
      // A truncated message is never parsed as a verdict: the message the operator actually sent
      // was not one, and the pattern tolerates enough interior whitespace that a cut can land on
      // an exact match, which would approve a tool call on words the full text never said. The cut
      // text flows to the session as chat instead, announced below.
      //
      // A participant's message is never parsed as a verdict either: a verdict approves a tool
      // call, which is the operator's authority alone, so a participant's `y abcde` is words for
      // the session like any other and is neither resolved nor reported as naming nothing.
      //
      // No nonce goes with it: this is a message composed now, in this thread, by an account this
      // broker acts for, so the ID it names is the ID the operator is looking at. The nonce is the
      // button path's control over a tap on a message of any age.
      const verdict = truncated || !operator ? null : parseVerdict(text);
      if (verdict !== null && options.permissions.resolve(message.threadId, verdict, null)) return;

      const record = sessionForThread(options.registry.list(), options.threadFor, message.threadId);

      // A message typed while this session's question is held is that question's answer, in the
      // operator's own words, for the whole ask. It is consumed here and not also delivered, for
      // the reason a verdict is: the session is parked inside the tool call this answers, so the
      // same text as steering would reach the model as a second, contextless copy of an answer it
      // is already being given.
      //
      // Ahead of the ended branch, because a held response is an HTTP socket the desk owns and
      // owes an answer whatever became of the relay pipe: a session whose relay dropped can still
      // be parked on a question, and telling the operator their answer was not delivered while the
      // desk would have taken it leaves that question to expire. Ahead of the rate ceiling for the
      // reason a verdict is exempt from it too: the ceiling bounds what a flood puts into a
      // session's context, and at most one message per hold is spent this way.
      //
      // A truncated message is never an answer, the rule the verdict pattern above follows: what
      // the operator sent was longer than what a cut leaves, and injecting the beginning of it
      // would answer the session's question with a sentence that stops mid-thought. The cut text
      // flows on as chat instead, announced, and the question stays held and answerable.
      //
      // Only an operator's message is an answer. A participant speaking while the session is parked
      // is delivered as chat below and leaves the question held for an operator to answer.
      //
      // A verdict shape that resolved no request reaches here and is submitted as the answer it
      // reads as. The trade this accepts: a genuine verdict whose request was lost, which a broker
      // restart between the prompt and the answer does, becomes the answer to whatever question the
      // session is holding. Deliberate, because the request that verdict named is already gone and
      // no reading of the message can approve anything, while the operator sees exactly what was
      // submitted in the thread message's own terminal edit.
      if (
        record !== null &&
        operator &&
        !truncated &&
        options.questions.answerTyped(record.sessionId, text)
      ) {
        return;
      }

      // Nothing else could take it, so the operator is told their answer named no open request.
      // Ahead of the ended, rate, and delivery branches below: a verdict shape is never handed to a
      // session as chat, so it can never be one of their delivery failures either, and reporting it
      // as one would answer a message about permissions with a notice about steering.
      if (verdict !== null) {
        await options.permissions.reportUnknownVerdict(message.threadId, verdict);
        return;
      }

      // A thread this broker does not own, or one whose session has been pruned. Silence is right:
      // the operator is talking in some other thread of their own.
      if (record === null) return;

      if (record.state === "ended") {
        const endedAt = now();
        // The inbox item is the session waiting on an operator, so only an operator's post clears
        // it, here and on the delivered path below.
        if (operator) {
          toInbox((inbox) => inbox.clearEnded(record.sessionId, endedAt), record.sessionId);
        }
        log(
          `routing: a message reached the ended session ${record.sessionId}, rejecting it in-thread`,
        );
        await notice(message.threadId, ENDED_NOTICE);
        return;
      }

      // Checked after the thread is resolved, so a flood into an unrelated thread cannot spend a
      // session's allowance, and before the pipe, so a flood cannot reach the model.
      if (!withinRate(record.sessionId)) {
        log(`routing: session ${record.sessionId} is over its inbound rate ceiling, dropping`);
        return;
      }

      if (gate === null) {
        const delivered = await handOver(
          record,
          message.threadId,
          { type: "message", chatId: message.threadId, text, author: message.author, senderClass },
          1,
        );
        if (!delivered) return;
        const deliveredAt = now();
        if (operator) {
          toInbox((inbox) => inbox.clear(record.sessionId, deliveredAt), record.sessionId);
        }
        // Announced only here, after the truncated text reached a live session.
        if (truncated) await announceCut(message.threadId);
        return;
      }

      // The gate is live, so the message joins its thread's buffer rather than going down at once.
      //
      // An operator's message clears the inbox item now, whether or not the buffer delivers on it:
      // the item is the session waiting on an operator, and the operator has answered by writing
      // in the thread, however long the gate holds the words. A rate-dropped message never reaches
      // here, so it joins no buffer and counts toward no cap.
      if (operator) {
        const admittedAt = now();
        toInbox((inbox) => inbox.clear(record.sessionId, admittedAt), record.sessionId);
      }
      const deliveries = gate.admit(
        message.threadId,
        record.sessionId,
        // The text as bounded above and the name as the gateway bounded it: what a delivered line
        // carries is exactly what a delivered message carries, and nothing is sanitized twice.
        { author: message.author, senderClass, text, truncated },
        { mentionsBot: message.mentionsBot, repliesToBot: message.repliesToBot },
      );
      // Held, when there are none. Nothing is announced then, a cut included: the announcement
      // belongs to a delivery, and this one has not happened yet. Two, when this message pushed
      // the held buffer past the event budget and then delivered on its own: in order, so the
      // session reads the thread in the order it was written.
      for (const delivery of deliveries) {
        await handOverBuffer(record, message.threadId, delivery);
      }
    },

    reconcile(sessions) {
      if (gate === null) return;
      for (const { threadId, sessionId } of gate.held()) {
        if (stillHeldFor(sessions, threadId, sessionId) === null) gate.clear(threadId);
      }
    },

    close() {
      gate?.close();
    },
  };
}
