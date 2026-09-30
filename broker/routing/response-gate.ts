// The response gate: a per-thread buffer that holds admitted messages until one of them addresses
// the bot, or the buffer ages or fills past a cap, and then hands them over as one delivery.
//
// It sits behind everything the inbound router decides. A message reaches `admit` only after the
// sender gate admitted it, the operator-only readings declined it, its session was found live, and
// the rate ceiling took it, so nothing here is a check on standing: the buffer holds what the
// router would otherwise have delivered at once, and the only question it answers is when.
//
// The delivered event's class is the lowest class present, `operator` only when every buffered
// message was written from an operator account. A line's prefix is text: a message's own text can
// span lines, so a participant can type a line that reads as an operator's, and the line's class is
// data for following the conversation rather than evidence of standing. The class the persona
// plugin acts on is the event's alone, and this is where it is computed from the accounts that
// wrote the event, never from what any line says.
//
// A buffer is held for the session it was admitted to, not for the thread alone. A thread moves to
// a session's replacement of the same lineage, and what was said to the old session is not said
// to the new one: a buffer whose session has gone is dropped, never handed to whoever holds the
// thread next.
import type { SenderClass } from "../security/senders.ts";
import type { RelayEvent } from "./relays.ts";

/** The per-host mode. `off` and `shadow` deliver every message at once; `live` buffers. */
export type ResponseGateMode = "off" | "shadow" | "live";

/**
 * The most UTF-16 code units one delivered event may serialize to, its newline included.
 *
 * The relay reads its stream as a decoded string and guards the unterminated remainder after each
 * read against its own cap: a line the stream splits, whose remainder passes the cap before its
 * newline arrives, is dropped with no signal to either side. An event over that cap is therefore
 * a buffer lost in silence whenever the socket splits it, which a line that long is. This is that
 * cap, written
 * here rather than imported because the relay is the other process and the broker's runtime code
 * does not reach into it; inbound.test.ts pins the two equal, and pins the worst-case buffered
 * event under it. The size cap below has a second reading against it: a buffer delivers early
 * rather than grow past what the pipe will carry.
 */
export const MAX_EVENT_UNITS = 64 * 1024;

/** One admitted message as the buffer holds it: what its delivered line and the event read. */
export type BufferedMessage = {
  /** The display name, bounded by the gateway for the attribute it rides. A label, never a key. */
  author: string;
  /** The class the sender roster gives the account that wrote it. */
  senderClass: SenderClass;
  /** Already bounded by the inbound router: invisible characters stripped, the ceiling applied. */
  text: string;
  /** Whether the router cut it, so a delivery can announce each cut it carried and a drop none. */
  truncated: boolean;
};

/** What delivered a buffer. The first three are a message's own act; the last is the timer's. */
export type BufferTrigger = "mention" | "reply" | "size-cap" | "age-cap";

export type BufferDelivery = {
  /** Oldest first, and never empty. */
  messages: readonly BufferedMessage[];
  trigger: BufferTrigger;
};

export type ResponseGateOptions = {
  /** A buffer holding this many messages delivers on reaching it. */
  maxMessages: number;
  /** A buffer whose oldest message is this old delivers on a timer, with or without another. */
  maxWaitMs: number;
  /**
   * Handed a buffer the age cap delivered, with no message of its own to answer on, and the
   * session it was held for. The caller owns the pipe and the thread, so it delivers and
   * announces; this only says the wait is over.
   */
  onAgeCap: (threadId: string, sessionId: string, delivery: BufferDelivery) => void;
  /**
   * Told of a buffer `admit` dropped because its thread admitted a message for another session:
   * the thread, the session the buffer was held for, and how many messages it held. The caller
   * owns the thread and tells its readers; the gate has no writer and only names the drop in its
   * log.
   */
  onDrop?: (threadId: string, sessionId: string, count: number) => void;
  /**
   * Injected so a test drives the age cap without sleeping. The default is a real timer that does
   * not hold the process open: a held buffer is not a reason for a broker asked to stop to wait.
   */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Where a buffer dropped here is named: its count, thread and session, never its text. */
  log?: (message: string) => void;
};

export type ResponseGate = {
  /**
   * Takes one admitted message into its thread's buffer, held for `sessionId`. Returns what the
   * message delivered, in order, which is nothing while the buffer is held, the whole buffer
   * with this message last when the message mentions the bot, replies to one of its messages or
   * fills the buffer to the cap, and two deliveries when the message would also have pushed the
   * held buffer past the event budget: the held buffer first, without this message, and then
   * whatever this message delivers on its own.
   */
  admit: (
    threadId: string,
    sessionId: string,
    message: BufferedMessage,
    addressed: { mentionsBot: boolean; repliesToBot: boolean },
  ) => readonly BufferDelivery[];
  /**
   * Drops a thread's buffer and its timer, delivering nothing, and returns how many messages that
   * dropped so the caller can say so. For a session that has ended.
   */
  clear: (threadId: string) => number;
  /** Drops every thread's buffer and timer, delivering nothing. For the broker stopping. */
  close: () => void;
  /** Every buffer held now, with the session each is held for, so the caller can drop the stale. */
  held: () => Array<{ threadId: string; sessionId: string }>;
};

/** The wire event a delivered buffer becomes. */
type MessageEvent = Extract<RelayEvent, { type: "message" }>;

/**
 * One buffered message as its line in the delivered text: `<author> (<class>): <text>`. The shape
 * the relay's instructions describe to the model, so the two are pinned against each other.
 */
export function bufferedLine(message: BufferedMessage): string {
  return `${message.author} (${message.senderClass}): ${message.text}`;
}

/**
 * The class the event carries: `operator` only when every message is an operator's. A mixed
 * buffer is a participant's, so an operator's ask mixed into participant chatter arrives without
 * standing and is re-asked, rather than participant lines arriving with an operator's.
 */
export function lowestClass(messages: readonly BufferedMessage[]): SenderClass {
  const allOperators = messages.every((message) => message.senderClass === "operator");
  return allOperators ? "operator" : "participant";
}

/**
 * The event a delivered buffer becomes on the relay's pipe.
 *
 * A buffer of one message is the ungated event: that message's own text, author and class, and no
 * `buffered` count, so a lone mention on a host with the gate on is byte-identical on the wire to
 * one on a host with it off. A buffer of more is one line per message, oldest first, its author
 * the newest message's, which is the one that triggered it or, on the timer, the last to arrive.
 */
export function bufferedEvent(chatId: string, messages: readonly BufferedMessage[]): MessageEvent {
  const newest = messages[messages.length - 1];
  if (messages.length === 1) {
    return {
      type: "message",
      chatId,
      text: newest.text,
      author: newest.author,
      senderClass: newest.senderClass,
    };
  }
  return {
    type: "message",
    chatId,
    text: messages.map(bufferedLine).join("\n"),
    author: newest.author,
    senderClass: lowestClass(messages),
    buffered: messages.length,
  };
}

/**
 * Whether the event these messages would become is more than the pipe will carry, measured on the
 * serialized line the hub writes, in the units the relay's guard compares: the JSON text's UTF-16
 * length, plus the newline that ends the line.
 */
function overBudget(chatId: string, messages: readonly BufferedMessage[]): boolean {
  return JSON.stringify(bufferedEvent(chatId, messages)).length + 1 > MAX_EVENT_UNITS;
}

/** A thread's held messages, the session they are held for, and the timer that delivers them. */
type Held = { sessionId: string; messages: BufferedMessage[]; timer: NodeJS.Timeout };

export function createResponseGate(options: ResponseGateOptions): ResponseGate {
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): NodeJS.Timeout => setTimeout(callback, ms).unref());
  const clearTimer = options.clearTimer ?? clearTimeout;
  const log = options.log ?? ((): void => {});
  const held = new Map<string, Held>();

  /** Takes a thread's buffer out of the map with its timer stopped, or nothing if none is held. */
  function release(threadId: string): Held | undefined {
    const buffer = held.get(threadId);
    if (buffer === undefined) return undefined;
    held.delete(threadId);
    clearTimer(buffer.timer);
    return buffer;
  }

  /** The age cap: the buffer is handed over as it stands, and the thread starts empty again. */
  function expire(threadId: string): void {
    const buffer = held.get(threadId);
    if (buffer === undefined) return;
    held.delete(threadId);
    options.onAgeCap(threadId, buffer.sessionId, { messages: buffer.messages, trigger: "age-cap" });
  }

  return {
    admit(threadId, sessionId, message, addressed) {
      const deliveries: BufferDelivery[] = [];
      let buffer = held.get(threadId);

      // A buffer held for a session the thread no longer belongs to is dropped, not handed to the
      // newcomer. `reconcile` drops it at the mutation that moved the thread; this is the same
      // answer for a router nothing reconciles.
      if (buffer !== undefined && buffer.sessionId !== sessionId) {
        release(threadId);
        log(
          `routing: dropped ${String(buffer.messages.length)} buffered messages held for session ` +
            `${buffer.sessionId}, thread ${threadId} now admits for session ${sessionId}`,
        );
        options.onDrop?.(threadId, buffer.sessionId, buffer.messages.length);
        buffer = undefined;
      }

      // The second reading of the size cap. A buffer this message would push past the event
      // budget is delivered first, as it stands, so that no event the gate writes is one the relay
      // drops; the message then opens a fresh buffer and is read on its own below, so its own
      // mention, reply or count still delivers it.
      if (buffer !== undefined && overBudget(threadId, [...buffer.messages, message])) {
        release(threadId);
        deliveries.push({ messages: buffer.messages, trigger: "size-cap" });
        buffer = undefined;
      }

      const messages = buffer?.messages ?? [];
      messages.push(message);

      // A mention outranks a reply and both outrank the cap, so the trigger names the message's
      // own act where it made one. Either address is certain, which is why neither waits on the
      // cap or the timer: the person asked the bot, and the buffer goes with the ask.
      let trigger: BufferTrigger | null = null;
      if (addressed.mentionsBot) trigger = "mention";
      else if (addressed.repliesToBot) trigger = "reply";
      else if (messages.length >= options.maxMessages) trigger = "size-cap";

      if (trigger !== null) {
        if (buffer !== undefined) release(threadId);
        deliveries.push({ messages, trigger });
        return deliveries;
      }
      // The timer runs from the oldest message and is never restarted by a later one, so a held
      // ask is late by at most the cap however steadily the thread keeps talking.
      if (buffer === undefined) {
        held.set(threadId, {
          sessionId,
          messages,
          timer: setTimer(() => expire(threadId), options.maxWaitMs),
        });
      }
      return deliveries;
    },

    clear(threadId) {
      return release(threadId)?.messages.length ?? 0;
    },

    close() {
      for (const threadId of [...held.keys()]) release(threadId);
    },

    held: () => [...held].map(([threadId, buffer]) => ({ threadId, sessionId: buffer.sessionId })),
  };
}
