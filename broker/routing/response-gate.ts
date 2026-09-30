// The response gate: a per-thread buffer that holds admitted messages until one of them addresses
// the bot, the buffer ages or fills past a cap, or TypeSafe's Jev judges that the conversation now
// expects a response, and then hands them over as one delivery.
//
// It sits behind everything the inbound router decides. A message reaches `admit` only after the
// sender gate admitted it, the operator-only readings declined it, its session was found live, and
// the rate ceiling took it, so nothing here is a check on standing: the buffer holds what the
// router would otherwise have delivered at once, and the only question it answers is when.
//
// The fourth trigger is a judgement. A held buffer waits for a quiet window since the thread's last
// message, and then one question goes to Jev with the buffered lines and the seconds since the bot
// last posted in the thread: does the latest message expect a response from the assistant? At or
// above the threshold the buffer delivers; below it the buffer stays held and the next message's
// quiet window asks again. A call that fails delivers, since a missed ask costs more than a chatty
// reply. The certain triggers and the age cap never wait on the window or the call. A thread has
// at most one call in flight, and a window that elapses during it asks when the call settles.
//
// Every decision is journaled, one row each, so a week of rows can be labelled and scored before
// a threshold decides anything live. A row carries ids, a trigger, an outcome, a probability where
// a call ran and the lines that were held. No reply text, no key and no token ever enters one.
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
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { MAX_JEV_CODE_POINTS, SECRET_SCREEN, createJevClient } from "../jev/client.ts";
import type { JevFetch } from "../jev/client.ts";
import { rotate } from "../log.ts";
import type { RepeatLogSurface } from "../repeat-log.ts";
import { sliceCodePoints } from "../sanitize.ts";
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
 * cap, written here rather than imported because the relay is the other process and the broker's
 * runtime code does not reach into it; inbound.test.ts pins the two equal, and pins the
 * worst-case buffered event under it. The size cap below has a second reading against it: a
 * buffer delivers early rather than grow past what the pipe will carry.
 */
export const MAX_EVENT_UNITS = 64 * 1024;

/** One admitted message as the buffer holds it: what its delivered line and the event read. */
export type BufferedMessage = {
  /** The message's own Discord id: the key a journal row carries and a label is written against. */
  id: string;
  /** The display name, bounded by the gateway for the attribute it rides. A label, never a key. */
  author: string;
  /** The class the sender roster gives the account that wrote it. */
  senderClass: SenderClass;
  /** Already bounded by the inbound router: invisible characters stripped, the ceiling applied. */
  text: string;
  /** Whether the router cut it, so a delivery can announce each cut it carried and a drop none. */
  truncated: boolean;
};

/**
 * What delivered a buffer. The first three are a message's own act, the fourth is the timer's, and
 * the last two are the judge's: a verdict at or above the threshold, or a call that failed.
 */
export type BufferTrigger = "mention" | "reply" | "size-cap" | "age-cap" | "judge" | "judge-failed";

export type BufferDelivery = {
  /** Oldest first, and never empty. */
  messages: readonly BufferedMessage[];
  trigger: BufferTrigger;
};

/**
 * One gate decision as the journal records it. The fields are closed at these: the id is the
 * newest buffered message's, the key a label names; `probability` is present only where a call
 * ran; `lines` is absent where the secret screen matches any of them, on every trigger, since a
 * row is on disk. The outcome is `delivered` or `held`, or `stale` for a verdict that returned
 * after its buffer had already gone, which delivers nothing. A judge row records what the call
 * was asked: the id and lines at the time of the ask. The event a verdict delivers carries the
 * buffer as it then stands, lines that arrived during the call included, so a label reads the
 * row's lines and the session may have read one or two more.
 */
export type JournalRow = {
  id: string;
  time: string;
  threadId: string;
  sessionId: string;
  trigger: BufferTrigger;
  probability?: number;
  outcome: "delivered" | "held" | "stale";
  lines?: readonly string[];
};

/** The judge's settings, present on a host whose gate asks Jev. */
export type ResponseGateJudge = {
  /** A held buffer asks once the thread has been quiet this long since its last message. */
  quietMs: number;
  /** A probability at or above this delivers the buffer. */
  threshold: number;
  /** The inbox judge's key, read from the same file. Never logged, in whole or in part. */
  apiKey: string;
  /** Injected so a test drives the call without a network. */
  fetch?: JevFetch;
};

export type ResponseGateOptions = {
  /** A buffer holding this many messages delivers on reaching it. */
  maxMessages: number;
  /** A buffer whose oldest message is this old delivers on a timer, with or without another. */
  maxWaitMs: number;
  /**
   * The fourth trigger. Absent, the gate has its three certain triggers and the age cap alone,
   * which is the shape the router's own tests drive; a host with the gate on always supplies it.
   */
  judge?: ResponseGateJudge;
  /** Takes one row per decision. A throw out of it is logged and never reaches a delivery. */
  journal: (row: JournalRow) => void;
  /**
   * True where the gate runs beside an ungated delivery, as it does in `shadow`: nothing it holds
   * is withheld from anyone, so a buffer it drops is not a loss and is not logged as one.
   */
  simulated?: boolean;
  /**
   * Handed a buffer released with no message of its own to answer on, by the age cap or the
   * judge, and the session it was held for. The caller owns the pipe and the thread, so it
   * delivers and announces; this only says the wait is over.
   */
  onRelease: (threadId: string, sessionId: string, delivery: BufferDelivery) => void;
  /**
   * Told of a buffer `admit` dropped because its thread admitted a message for another session:
   * the thread, the session the buffer was held for, and how many messages it held. The caller
   * owns the thread and tells its readers; the gate has no writer and only names the drop in its
   * log.
   */
  onDrop?: (threadId: string, sessionId: string, count: number) => void;
  /**
   * Injected so a test drives the age cap and the quiet window without sleeping. The default is a
   * real timer that does not hold the process open: a held buffer is not a reason for a broker
   * asked to stop to wait.
   */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Where a drop, a failed call or a lost journal row is named: never a message's text. */
  log?: (message: string) => void;
  /** The clock a row's time and the seconds since the bot's last post are read from. */
  now?: () => number;
};

export type ResponseGate = {
  /**
   * Takes one admitted message into its thread's buffer, held for `sessionId`. Returns what the
   * message delivered, in order, which is nothing while the buffer is held, the whole buffer
   * with this message last when the message mentions the bot, replies to one of its messages or
   * fills the buffer to the cap, and two deliveries when the message would also have pushed the
   * held buffer past the event budget: the held buffer first, without this message, and then
   * whatever this message delivers on its own. A held message restarts its thread's quiet window.
   */
  admit: (
    threadId: string,
    sessionId: string,
    message: BufferedMessage,
    addressed: { mentionsBot: boolean; repliesToBot: boolean },
  ) => readonly BufferDelivery[];
  /**
   * The bot posted in the thread now. Memory only: the judge is told the seconds since this, and
   * `never` for a thread the bot has not posted in since the broker started.
   */
  notePost: (threadId: string) => void;
  /**
   * Drops a thread's buffer, its timers and its last-post clock, delivering nothing, and returns
   * how many messages that dropped so the caller can say so. For a session that has ended. A
   * call in flight for the buffer is not aborted; its verdict is journaled as stale and delivers
   * nothing.
   */
  clear: (threadId: string) => number;
  /** Drops every thread's buffer, timers and clock, delivering nothing. For the broker stopping. */
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
 * the newest message's, which is the one that triggered it or, on the timer or the judge, the last
 * to arrive.
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

/**
 * The lines the judge is sent: the newest buffered lines that fit the shared code point cut,
 * oldest first. The latest message is always sent, and is cut alone where it alone exceeds the
 * limit. A line the router builds cannot reach it: its name is bounded by the gateway's
 * `MAX_AUTHOR_NAME_LENGTH` and its text by the router's `MAX_INBOUND_TEXT_LENGTH`, whose sum with
 * the line's own prefix sits under `MAX_JEV_CODE_POINTS`, which the gate's test pins.
 */
export function conversationLines(messages: readonly BufferedMessage[]): string[] {
  const lines: string[] = [];
  let remaining = MAX_JEV_CODE_POINTS;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = bufferedLine(messages[index]);
    const length = [...line].length;
    if (length > remaining) {
      if (lines.length === 0) lines.push(sliceCodePoints(line, remaining));
      break;
    }
    lines.push(line);
    remaining -= length;
  }
  return lines.reverse();
}

const PREAMBLE =
  "The `conversation` is the newest part of a group chat between a few people and an AI " +
  "assistant, one message per line, oldest first, each line written as `<name> (<class>): " +
  "<text>`. `seconds_since_assistant_posted` is how long ago the assistant last wrote in this " +
  "chat, or `never`. The assistant answers when it is wanted and stays out of the people's own " +
  "exchanges with each other.";

/**
 * The one question, yes-or-no (`noul`), keyed by the name its answer comes back under. The text
 * is a first wording rather than a tuned one: the journal and the scoring tool measure it.
 */
export const GATE_QUESTIONS = {
  expects_reply: {
    type: "noul",
    instructions:
      `${PREAMBLE} Does the latest message in the conversation expect a response from the ` +
      "assistant? Count a question or a request put to the assistant or to the room, and a " +
      "message that continues something the assistant was asked, whether or not it names the " +
      "assistant. A message addressed to another person, an aside, or an acknowledgement that " +
      "closes an exchange does not count.",
    criteria: {
      true: "Yes, the latest message expects the assistant to respond.",
      false: "No, the latest message expects nothing from the assistant.",
    },
  },
} as const;

/**
 * The gate's repeat log, keyed by the failure kind; the thread rides beside it. The kinds are the
 * client's closed set plus a handler throw, so the map is bounded without a sweep.
 */
export const GATE_REPEAT_LOG: RepeatLogSurface<[threadId: string]> = {
  windowMs: 60_000,
  firstLine: (kind, threadId) => `response gate: ${kind} thread=${threadId}`,
  countLine: (kind, suppressed) =>
    `response gate: ${kind} occurred ${String(suppressed)} more time(s) in the last 60000ms`,
};

/**
 * The journal on disk: one JSON row per line, appended to `file` and rotated at the broker log's
 * size and file count through the log's own rotation. Written for the owning user only, since a
 * row holds message text, and the directory is the state file's, made the way the state file's
 * writer makes it: once, before the first row, and again only where an append finds it gone.
 * Throws on a failed write; the gate logs that and delivers regardless.
 */
export function createResponseGateJournal(options: {
  file: string;
  maxBytes: number;
  maxFiles: number;
}): (row: JournalRow) => void {
  let directoryMade = false;
  const append = (line: string): void => {
    if (!directoryMade) {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
      directoryMade = true;
    }
    appendFileSync(options.file, line, { encoding: "utf8", mode: 0o600 });
  };
  return (row) => {
    const line = `${JSON.stringify(row)}\n`;
    try {
      append(line);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      // The directory was removed under the running broker: made again, once, for this row.
      directoryMade = false;
      append(line);
    }
    if (statSync(options.file).size >= options.maxBytes) rotate(options.file, options.maxFiles);
  };
}

/**
 * A thread's held messages, the session they are held for, the age-cap timer that delivers them,
 * the quiet-window timer that asks about them, and whether that window has elapsed with the ask
 * still owed because a call was in flight.
 */
type Held = {
  sessionId: string;
  messages: BufferedMessage[];
  timer: NodeJS.Timeout;
  quiet: NodeJS.Timeout | null;
  quietElapsed: boolean;
};

/** What one call was asked about, carried back with its verdict: the buffer, its newest id, the lines sent. */
type Asked = { buffer: Held; id: string; lines: string[] };

export function createResponseGate(options: ResponseGateOptions): ResponseGate {
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): NodeJS.Timeout => setTimeout(callback, ms).unref());
  const clearTimer = options.clearTimer ?? clearTimeout;
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const held = new Map<string, Held>();
  /** When the bot last posted in each thread, by the gate's clock. */
  const lastPost = new Map<string, number>();
  /** The threads with a call out. A window elapsing on one of these asks when the call settles. */
  const inFlight = new Set<string>();

  /**
   * One row. The lines are screened here, on every trigger, so a pasted secret is kept off disk
   * as the client keeps it off the wire; a row that would have carried one carries no lines. The
   * journal's failure is logged and stops nothing: a delivery never waits on disk.
   */
  function record(
    threadId: string,
    sessionId: string,
    id: string,
    trigger: BufferTrigger,
    outcome: JournalRow["outcome"],
    detail: { probability?: number; lines?: readonly string[] },
  ): void {
    const lines =
      detail.lines === undefined || detail.lines.some((line) => SECRET_SCREEN.test(line))
        ? undefined
        : detail.lines;
    const row: JournalRow = {
      id,
      time: new Date(now()).toISOString(),
      threadId,
      sessionId,
      trigger,
      ...(detail.probability === undefined ? {} : { probability: detail.probability }),
      outcome,
      ...(lines === undefined ? {} : { lines }),
    };
    try {
      options.journal(row);
    } catch (error) {
      log(`routing: the response gate journal lost a row for thread ${threadId}: ${String(error)}`);
    }
  }

  /** A delivered buffer's row: its newest id and every line it held. */
  function recordDelivery(threadId: string, sessionId: string, delivery: BufferDelivery): void {
    const newest = delivery.messages[delivery.messages.length - 1];
    record(threadId, sessionId, newest.id, delivery.trigger, "delivered", {
      lines: delivery.messages.map(bufferedLine),
    });
  }

  /** Takes a thread's buffer out of the map with both timers stopped, or nothing if none is held. */
  function release(threadId: string): Held | undefined {
    const buffer = held.get(threadId);
    if (buffer === undefined) return undefined;
    held.delete(threadId);
    clearTimer(buffer.timer);
    if (buffer.quiet !== null) clearTimer(buffer.quiet);
    return buffer;
  }

  /** The age cap: the buffer is handed over as it stands, and the thread starts empty again. */
  function expire(threadId: string): void {
    const buffer = held.get(threadId);
    if (buffer === undefined) return;
    held.delete(threadId);
    if (buffer.quiet !== null) clearTimer(buffer.quiet);
    const delivery: BufferDelivery = { messages: buffer.messages, trigger: "age-cap" };
    recordDelivery(threadId, buffer.sessionId, delivery);
    options.onRelease(threadId, buffer.sessionId, delivery);
  }

  // The judge, built only where the host asks Jev. Its verdicts arrive through `onResult`, which
  // reads the thread's buffer again rather than trusting the one the call was made about: a
  // certain trigger, the age cap or a drop may have emptied it while the call was out.
  const threshold = options.judge?.threshold ?? 1;
  const judge =
    options.judge === undefined
      ? null
      : createJevClient<"expects_reply", Asked>({
          apiKey: options.judge.apiKey,
          questions: GATE_QUESTIONS,
          repeatLog: GATE_REPEAT_LOG,
          ...(options.judge.fetch === undefined ? {} : { fetch: options.judge.fetch }),
          log,
          now,
          onResult: (threadId, asked, result) => {
            inFlight.delete(threadId);
            const trigger: BufferTrigger = result.ok ? "judge" : "judge-failed";
            const detail = {
              ...(result.ok ? { probability: result.answers.expects_reply } : {}),
              lines: asked.lines,
            };
            try {
              const current = held.get(threadId);
              if (current !== asked.buffer) {
                record(threadId, asked.buffer.sessionId, asked.id, trigger, "stale", detail);
              } else if (result.ok && result.answers.expects_reply < threshold) {
                record(threadId, current.sessionId, asked.id, trigger, "held", detail);
              } else {
                // At or above the threshold, or a call that failed: the buffer goes as it stands,
                // with whatever arrived while the call was out, since those lines continue the
                // ask the verdict answered.
                release(threadId);
                record(threadId, current.sessionId, asked.id, trigger, "delivered", detail);
                options.onRelease(threadId, current.sessionId, { messages: current.messages, trigger });
              }
            } finally {
              // A window that elapsed while this call was out, on this buffer or on one that
              // opened since, owes its ask now, whatever the release above did. A throw out of
              // `onRelease` is the client's to log, and must not strand a buffer waiting on it.
              if (held.get(threadId)?.quietElapsed === true) ask(threadId);
            }
          },
        });

  /** Asks Jev about the thread's buffer as it stands now. Only ever called with no call out. */
  function ask(threadId: string): void {
    const buffer = held.get(threadId);
    if (buffer === undefined || judge === null) return;
    buffer.quietElapsed = false;
    inFlight.add(threadId);
    const lines = conversationLines(buffer.messages);
    const posted = lastPost.get(threadId);
    const seconds =
      posted === undefined ? "never" : String(Math.max(0, Math.floor((now() - posted) / 1000)));
    judge.submit(
      threadId,
      { conversation: lines, seconds_since_assistant_posted: seconds },
      { buffer, id: buffer.messages[buffer.messages.length - 1].id, lines },
    );
  }

  /**
   * The quiet window elapsed: ask now, or note that the ask is owed once the call out settles.
   * Only the buffer's current window counts, so a timer a later message retired asks nothing
   * even where it fires regardless.
   */
  function quietElapsed(threadId: string, timer: NodeJS.Timeout): void {
    const buffer = held.get(threadId);
    if (buffer === undefined || buffer.quiet !== timer) return;
    buffer.quiet = null;
    if (inFlight.has(threadId)) {
      buffer.quietElapsed = true;
      return;
    }
    ask(threadId);
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
        if (options.simulated !== true) {
          log(
            `routing: dropped ${String(buffer.messages.length)} buffered messages held for session ` +
              `${buffer.sessionId}, thread ${threadId} now admits for session ${sessionId}`,
          );
        }
        options.onDrop?.(threadId, buffer.sessionId, buffer.messages.length);
        buffer = undefined;
      }

      // The second reading of the size cap. A buffer this message would push past the event
      // budget is delivered first, as it stands, so that no event the gate writes is one the relay
      // drops; the message then opens a fresh buffer and is read on its own below, so its own
      // mention, reply or count still delivers it.
      if (buffer !== undefined && overBudget(threadId, [...buffer.messages, message])) {
        release(threadId);
        const delivery: BufferDelivery = { messages: buffer.messages, trigger: "size-cap" };
        recordDelivery(threadId, sessionId, delivery);
        deliveries.push(delivery);
        buffer = undefined;
      }

      const messages = buffer?.messages ?? [];
      messages.push(message);

      // A mention outranks a reply and both outrank the cap, so the trigger names the message's
      // own act where it made one. Either address is certain, which is why neither waits on the
      // cap, the timer or the judge: the person asked the bot, and the buffer goes with the ask.
      let trigger: BufferTrigger | null = null;
      if (addressed.mentionsBot) trigger = "mention";
      else if (addressed.repliesToBot) trigger = "reply";
      else if (messages.length >= options.maxMessages) trigger = "size-cap";

      if (trigger !== null) {
        if (buffer !== undefined) release(threadId);
        const delivery: BufferDelivery = { messages, trigger };
        recordDelivery(threadId, sessionId, delivery);
        deliveries.push(delivery);
        return deliveries;
      }
      // The timer runs from the oldest message and is never restarted by a later one, so a held
      // ask is late by at most the cap however steadily the thread keeps talking.
      if (buffer === undefined) {
        buffer = {
          sessionId,
          messages,
          timer: setTimer(() => expire(threadId), options.maxWaitMs),
          quiet: null,
          quietElapsed: false,
        };
        held.set(threadId, buffer);
      }
      // The quiet window runs from the newest message and restarts on each, so a person typing
      // several lines is not cut mid-thought. A restart also retracts an ask the window had
      // already earned but not made, since the thread was not quiet after all.
      if (options.judge !== undefined) {
        if (buffer.quiet !== null) clearTimer(buffer.quiet);
        const quiet: NodeJS.Timeout = setTimer(() => quietElapsed(threadId, quiet), options.judge.quietMs);
        buffer.quiet = quiet;
        buffer.quietElapsed = false;
      }
      return deliveries;
    },

    notePost(threadId) {
      lastPost.set(threadId, now());
    },

    clear(threadId) {
      // The clock goes with the buffer: the session the thread held is over, and the map does not
      // grow by one thread for the life of the broker.
      lastPost.delete(threadId);
      return release(threadId)?.messages.length ?? 0;
    },

    close() {
      for (const threadId of [...held.keys()]) release(threadId);
      lastPost.clear();
    },

    held: () => [...held].map(([threadId, buffer]) => ({ threadId, sessionId: buffer.sessionId })),
  };
}
