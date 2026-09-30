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
import type { SenderClass } from "../security/senders.ts";
import type { RelayEvent } from "./relays.ts";

/** The per-host mode. `off` and `shadow` deliver every message at once; `live` buffers. */
export type ResponseGateMode = "off" | "shadow" | "live";

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
   * Handed a buffer the age cap delivered, with no message of its own to answer on. The caller
   * owns the pipe and the thread, so it delivers and announces; this only says the wait is over.
   */
  onAgeCap: (threadId: string, delivery: BufferDelivery) => void;
  /** Injected so a test drives the age cap without sleeping. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type ResponseGate = {
  /**
   * Takes one admitted message into its thread's buffer. Returns the whole buffer, this message
   * last, when the message delivers it: it mentions the bot, replies to one of the bot's messages,
   * or fills the buffer to the cap. Returns null while the buffer is held.
   */
  admit: (
    threadId: string,
    message: BufferedMessage,
    addressed: { mentionsBot: boolean; repliesToBot: boolean },
  ) => BufferDelivery | null;
  /** Drops a thread's buffer and its timer, delivering nothing. For a session that has ended. */
  clear: (threadId: string) => void;
  /** Every thread holding a buffer now, so the caller can find the ones whose session is gone. */
  threads: () => string[];
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

/** A thread's held messages and the timer that delivers them at the age cap. */
type Held = { messages: BufferedMessage[]; timer: NodeJS.Timeout };

export function createResponseGate(options: ResponseGateOptions): ResponseGate {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const held = new Map<string, Held>();

  /** The age cap: the buffer is handed over as it stands, and the thread starts empty again. */
  function expire(threadId: string): void {
    const buffer = held.get(threadId);
    if (buffer === undefined) return;
    held.delete(threadId);
    options.onAgeCap(threadId, { messages: buffer.messages, trigger: "age-cap" });
  }

  return {
    admit(threadId, message, addressed) {
      const buffer = held.get(threadId);
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
        if (buffer !== undefined) {
          held.delete(threadId);
          clearTimer(buffer.timer);
        }
        return { messages, trigger };
      }
      // The timer runs from the oldest message and is never restarted by a later one, so a held
      // ask is late by at most the cap however steadily the thread keeps talking.
      if (buffer === undefined) {
        held.set(threadId, {
          messages,
          timer: setTimer(() => expire(threadId), options.maxWaitMs),
        });
      }
      return null;
    },

    clear(threadId) {
      const buffer = held.get(threadId);
      if (buffer === undefined) return;
      held.delete(threadId);
      clearTimer(buffer.timer);
    },

    threads: () => [...held.keys()],
  };
}
