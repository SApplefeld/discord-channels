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
// buffer goes down whole when a message addresses the bot, a cap is reached, or the judge says the
// thread expects an answer. Nothing about who may say what moves; only when the session hears it.
// In shadow the message goes down at once, and the same buffer runs beside that
// delivery as a simulation whose every decision is journaled and none of which reaches the pipe.
//
// A held buffer survives the broker. In `live` the gate hands every change to what it holds to a
// file beside the journal, and this router reads that file once when it is built: a buffer whose
// session record restored is held again and delivered, under a line saying it was held across a
// restart, when that session's relay attaches; one whose session did not restore is dropped with
// the counted notice a session's end posts. In `off` and `shadow` the file is neither written nor
// read.
//
// A process token identifies a pipe. It is not evidence about who sent a message, and no check
// here consults it for that.
import { readFileSync } from "node:fs";
import { boundedAuthor, clean, withoutInvisible } from "../sanitize.ts";
import { parseVerdict } from "../security/permission.ts";
import type { PermissionDesk } from "../security/permission.ts";
import { SNOWFLAKE } from "../security/senders.ts";
import type { SenderClass, SenderGate } from "../security/senders.ts";
import type { Registry, SessionRecord } from "../registry.ts";
import type { RelayEvent, RelayHub } from "./relays.ts";
import {
  HELD_BUFFERS_FORMAT_VERSION,
  bufferedEvent,
  createResponseGate,
  overBudget,
  saveHeldBuffers,
} from "./response-gate.ts";
import type {
  BufferDelivery,
  BufferedMessage,
  HeldBuffer,
  JournalRow,
  ResponseGate,
  ResponseGateJudge,
  ResponseGateMode,
} from "./response-gate.ts";
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
  /** True when a bot wrote it. This bot's own cards, replies and notices all come back over the gateway. */
  fromBot: boolean;
  /**
   * True when this bot's own user wrote it, which is narrower than `fromBot`: another bot or a
   * webhook in the thread is a bot and not the assistant. Read by the response gate's last-post
   * clock alone. False before the connection knows its own user.
   */
  fromSelf: boolean;
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
  /** The judge's window, threshold and key. Absent, the gate has its certain triggers alone. */
  judge?: ResponseGateJudge;
  /** Takes one row per gate decision, in `shadow` and `live` alike. */
  journal: (row: JournalRow) => void;
  /**
   * Where the held buffers are kept across a broker restart, and the floor a restored buffer's
   * age cap is re-armed to, the window a relay is given to reconnect after a restart. Read and
   * written in `live` alone: in `off` and `shadow` a file left by an earlier `live` run is
   * neither read nor touched.
   */
  buffers?: { file: string; graceMs: number };
  /** Injected so a test fires the age cap and the quiet window without sleeping. */
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
   * The response gate's mode, caps and judge. Absent, or in any mode but `live`, every admitted
   * message is delivered at once, which is the path a host with one account takes; in
   * `shadow` the gate runs beside that delivery and journals what it would have done.
   */
  responseGate?: ResponseGateSettings;
  /** Injected so a test drives the rate ceiling without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
  /**
   * The receipt tracker's delivered stage, told once a message is actually handed to a session:
   * on the direct path, right after the pipe takes it, and on the response-gate path, once for
   * each message a released buffer hands over. Optional so a Discord-less broker and every
   * existing test keep working with no reactions painted at all.
   */
  receipts?: { delivered: (threadId: string, messageId: string, at: number) => void };
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
   * Drops every held buffer and its timer, delivering nothing and writing nothing, so the buffers
   * file keeps what was held for the next start to restore. For the broker stopping: a held
   * buffer is not a reason to wait, and its timer must not fire into pipes being torn down. A
   * no-op with the gate off. Never throws.
   */
  close: () => void;
  /**
   * A relay attached for `processToken`. Delivers the buffer restored across a broker restart for
   * the session that token holds, if one is still held; a buffer opened since stays held. Called
   * by the relay hub's attach signal. A no-op with the gate off or in shadow. Never throws.
   */
  relayAttached: (processToken: string) => void;
  /**
   * Starts the age cap of every buffer restored across a broker restart, re-armed from its oldest
   * message as of now and floored at the relay restart window. For the moment the listener binds,
   * beside the relay hub's restart windows: the restore itself runs when the router is built,
   * before the Discord login is awaited, and a cap measured then would spend the login on the
   * window a relay has to come back. A no-op with the gate off or in shadow. Never throws.
   */
  armRestored: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One entry of the buffers file, parsed and never trusted: the file is an ordinary file anything
 * running as this user can rewrite. Every string is bounded again by the guard the router or the
 * gateway applies to a message on the way in, `boundedAuthor` for the name and `bounded` for the
 * text, so a tampered file re-admits nothing the wire refuses; the ids take the registry file's
 * own normalization. A shape this broker never writes, a text or a name that bounds to nothing,
 * a class that is not one of the two words, an empty list, or a list whose restored event is
 * more than the relay's pipe will carry, is null. The list is bounded by that event budget and
 * not by the size cap: the cap is a knob a config edit lowers at a restart, which is the moment
 * this reads, and an entry the gate held under the old cap is still one the pipe carries. A time
 * after the clock is clamped to it rather than refused, since a clock stepped back across the
 * outage is no reason to lose the host's every held buffer; the clamp keeps the re-armed cap a
 * delay Node's timers take, at most the larger of the age cap and the relay restart window.
 */
function heldBufferOf(value: unknown, now: number): HeldBuffer | null {
  if (!isRecord(value)) return null;
  if (typeof value.threadId !== "string" || typeof value.sessionId !== "string") return null;
  const threadId = clean(value.threadId);
  const sessionId = clean(value.sessionId);
  // The thread is the channel a dropped buffer's notice is posted to, so it must be a Discord id.
  if (!SNOWFLAKE.test(threadId) || sessionId === "") return null;
  // Finite, not merely a number: JSON.parse turns 1e999 into Infinity.
  const oldestAt = value.oldestAt;
  if (typeof oldestAt !== "number" || !Number.isFinite(oldestAt) || oldestAt < 0) return null;
  if (!Array.isArray(value.messages) || value.messages.length === 0) return null;
  const messages: BufferedMessage[] = [];
  for (const entry of value.messages as unknown[]) {
    if (!isRecord(entry)) return null;
    if (
      typeof entry.id !== "string" ||
      typeof entry.senderId !== "string" ||
      typeof entry.author !== "string" ||
      typeof entry.text !== "string" ||
      typeof entry.truncated !== "boolean"
    ) {
      return null;
    }
    if (entry.senderClass !== "operator" && entry.senderClass !== "participant") return null;
    const id = clean(entry.id);
    const senderId = clean(entry.senderId);
    const author = boundedAuthor(entry.author);
    const { text, truncated } = bounded(entry.text);
    if (id === "" || senderId === "" || author === "" || text === "") return null;
    messages.push({
      id,
      senderId,
      author,
      senderClass: entry.senderClass,
      text,
      truncated: entry.truncated || truncated,
    });
  }
  // The gate's own budget check, restart line included: an entry it would not have held whole.
  if (overBudget(threadId, messages)) return null;
  return { threadId, sessionId, oldestAt: Math.min(oldestAt, now), messages };
}

/**
 * The held buffers an earlier broker process left in `file`, read on `loadSessions`'s discipline
 * (`broker/persistence.ts`): a file that is missing, cannot be read, is not JSON, is not a
 * snapshot, is another format or holds an entry the file cannot vouch for restores nothing and
 * logs one line naming the file and never its content. The parse error is deliberately unread,
 * since its message embeds an excerpt of the file, which holds message text, and the format a
 * mismatched file claims is not repeated, since it is the file's own text. One bad entry refuses
 * the whole file, as one malformed record empties the registry: a file this broker did not write
 * is not one to restore from in part.
 */
export function loadHeldBuffers(
  file: string,
  options: { now: () => number; log: (message: string) => void },
): HeldBuffer[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      options.log(`routing: no held buffers at ${file}, restoring none`);
      return [];
    }
    options.log(`routing: cannot read the held buffers at ${file}, restoring none: ${String(error)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    options.log(`routing: the held buffers at ${file} are not valid JSON, restoring none`);
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.buffers)) {
    options.log(`routing: the held buffers at ${file} are not a snapshot, restoring none`);
    return [];
  }
  if (parsed.version !== HELD_BUFFERS_FORMAT_VERSION) {
    options.log(
      `routing: the held buffers at ${file} are not format ` +
        `${String(HELD_BUFFERS_FORMAT_VERSION)}, restoring none`,
    );
    return [];
  }

  const buffers: HeldBuffer[] = [];
  const threads = new Set<string>();
  const now = options.now();
  for (const entry of parsed.buffers as unknown[]) {
    const buffer = heldBufferOf(entry, now);
    // A thread holds one buffer, so a second entry for it is not something this broker wrote.
    if (buffer === null || threads.has(buffer.threadId)) {
      options.log(`routing: the held buffers at ${file} hold a malformed entry, restoring none`);
      return [];
    }
    threads.add(buffer.threadId);
    buffers.push(buffer);
  }
  return buffers;
}

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
 * Why a held buffer was dropped: its session ended or left the registry, or its thread now belongs
 * to a different live session, which is what a `/clear` does to a thread.
 */
export type DropCause = "ended" | "moved";

/**
 * Posted into a thread whose held buffer was dropped with its session, so the loss of the held
 * messages is never silent. It counts them, names the cause the router can tell apart, and asks
 * for a re-post; it never carries a message's text or an author's name, since a notice is a
 * broker-authored post in a thread several people read.
 */
export function droppedBufferNotice(count: number, cause: DropCause): string {
  const held = count === 1 ? "the message" : `the ${String(count)} messages`;
  const them = count === 1 ? "it" : "them";
  if (cause === "ended") {
    return (
      `This session has ended, so ${held} it was still holding ${count === 1 ? "was" : "were"} ` +
      `not delivered. Nothing is queued: start a new session and re-post ${them} in its thread.`
    );
  }
  return (
    `This thread now belongs to a new session, after a /clear, so ${held} held for the old one ` +
    `${count === 1 ? "was" : "were"} not delivered. Nothing is queued: re-post ${them} here and ` +
    "the new session will read " +
    `${them}.`
  );
}

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

  /**
   * Posts a notice through the writer's per-thread floor and says what became of it: written,
   * floored, or failed, the last logged here. Most callers post and move on; a caller whose notice
   * is the only in-thread record of a loss reads the outcome to log a floored one.
   */
  async function notice(threadId: string, text: string): Promise<"posted" | "floored" | "failed"> {
    try {
      return (await options.writer.notice(threadId, text)) ? "posted" : "floored";
    } catch (error) {
      log(`routing: could not post a notice into thread ${threadId}: ${String(error)}`);
      return "failed";
    }
  }

  /**
   * Tells a thread that a held buffer was dropped with its session, once, counted, and never with
   * the text. The floor is the writer's: a second drop notice inside the interval is refused, the
   * log line is then its only record, and nothing retries it, since the next message into the
   * thread provokes the next notice. An empty buffer posts nothing.
   */
  async function announceDrop(threadId: string, count: number, cause: DropCause): Promise<void> {
    if (count === 0) return;
    const outcome = await notice(threadId, droppedBufferNotice(count, cause));
    if (outcome === "floored") {
      log(
        `routing: the drop notice for thread ${threadId} was floored, the log line is its record`,
      );
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
   * Delivers the buffers the gate released, on a message's own act or on the timer, and announces
   * each cut they carried. The inbox is not cleared here: an operator's message cleared it when
   * the buffer took it, since the operator had answered the session either way.
   *
   * Every event is written first, back to back with nothing awaited between, and only then is
   * anything posted or logged. The gateway does not await a delivery, so a message posted during
   * a Discord round trip is routed before that round trip returns: an announcement awaited between
   * two writes would let a later message's event reach the pipe ahead of an earlier one's, and the
   * session would read the thread out of order. A pipe that took nothing earns the unreachable
   * notice per delivery, counting what that delivery lost.
   */
  async function handOverBuffers(
    record: SessionRecord,
    threadId: string,
    deliveries: readonly BufferDelivery[],
  ): Promise<void> {
    const outcomes = deliveries.map((delivery) => ({
      delivery,
      written: options.relays.deliver(
        record.processToken,
        bufferedEvent(threadId, delivery.messages, delivery.restoredAt),
      ),
    }));
    // Read once for the whole batch: every message this call hands over lands in the pipe in the
    // same back-to-back pass above, so they are delivered at the same instant as far as a stage
    // reaction is concerned.
    const deliveredAt = now();
    // Every written message is registered delivered here, ahead of this function's first await:
    // a pickup racing this call in the gap an awaited notice or cut announcement opens must see
    // every message this batch wrote as already delivered, not the ones a still-running loop
    // below has merely reached so far.
    for (const { delivery, written } of outcomes) {
      if (!written) continue;
      for (const message of delivery.messages) {
        options.receipts?.delivered(threadId, message.id, deliveredAt);
      }
    }
    for (const { delivery, written } of outcomes) {
      if (!written) {
        log(`routing: session ${record.sessionId} has no relay attached, rejecting in-thread`);
        await notice(threadId, unreachableNotice(delivery.messages.length));
        continue;
      }
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
  }

  /**
   * Why a buffer held for `sessionId` has nowhere to go, read off the records and never off the
   * thread binding. A `/clear` ends the session and registers its replacement in one registry
   * mutation, and the surface moves the thread to the replacement only on a later refresh, by
   * lineage, so at the moment of the drop the thread still resolves to the ended session. What
   * tells a `/clear` from a plain end is the replacement itself: a live record sharing the ended
   * session's lineage and started after it, the same rule the surface rebinds on, since only a
   * newer session takes a lineage over. A session with no lineage has nothing to link it to a
   * replacement, so its drop is an end.
   */
  function dropCause(records: readonly SessionRecord[], sessionId: string): DropCause {
    const held = records.find((record) => record.sessionId === sessionId);
    if (held === undefined || held.lineage === null) return "ended";
    const replaced = records.some(
      (record) =>
        record.sessionId !== sessionId &&
        record.state !== "ended" &&
        record.lineage === held.lineage &&
        record.startedAt > held.startedAt,
    );
    return replaced ? "moved" : "ended";
  }

  /**
   * Whether a buffer held for `sessionId` in `threadId` still has that session to go to: one that
   * is live and is the session the thread resolves to now. A session that ended, left the
   * registry, or handed its thread to its replacement leaves the buffer with nowhere to go, and
   * it is dropped rather than delivered to whoever holds the thread next, with the cause the
   * thread's readers are told.
   */
  function holdFor(
    records: readonly SessionRecord[],
    threadId: string,
    sessionId: string,
  ): { record: SessionRecord } | { record: null; cause: DropCause } {
    const record = sessionForThread(records, options.threadFor, threadId);
    if (record !== null && record.state !== "ended" && record.sessionId === sessionId) {
      return { record };
    }
    return { record: null, cause: dropCause(records, sessionId) };
  }

  /**
   * The age cap or the judge released a thread's buffer. The session is looked up again rather
   * than trusted from the buffer, because it may have ended or been superseded while the buffer
   * waited: `reconcile` drops such a buffer the moment the registry says so, and this is the same
   * answer for a router nothing reconciles.
   */
  async function released(
    threadId: string,
    sessionId: string,
    delivery: BufferDelivery,
  ): Promise<void> {
    const hold = holdFor(options.registry.list(), threadId, sessionId);
    if (hold.record === null) {
      log(
        `routing: dropped ${String(delivery.messages.length)} buffered messages held for session ` +
          `${sessionId}, which no longer holds thread ${threadId}`,
      );
      await announceDrop(threadId, delivery.messages.length, hold.cause);
      return;
    }
    await handOverBuffers(hold.record, threadId, [delivery]);
  }

  // Built for `live` and `shadow`, and absent for `off`: the absence of a gate is what keeps the
  // off path the one it always was rather than a gate with a pass-through mode. In shadow the gate
  // is a simulation. Every message still goes down at once through the ungated path below, and
  // what the gate releases or drops reaches no pipe and no thread; the journal is its only output.
  const mode = options.responseGate?.mode ?? "off";
  const simulated = mode === "shadow";
  const settings = options.responseGate;
  // The buffers file, in live alone. Shadow's simulated buffer withholds nothing from anyone, so
  // there is nothing of it to keep across a restart.
  const buffersFile = settings?.buffers === undefined || simulated ? null : settings.buffers.file;
  const gate: ResponseGate | null =
    settings !== undefined && mode !== "off"
      ? createResponseGate({
          maxMessages: settings.maxMessages,
          maxWaitMs: settings.maxWaitMs,
          ...(settings.judge === undefined ? {} : { judge: settings.judge }),
          journal: settings.journal,
          simulated,
          // Fire and forget, on the timer's or the verdict's own tick: the delivery never rejects
          // by construction, and the catch is the same backstop the gateway puts behind `deliver`.
          onRelease: (threadId, sessionId, delivery) => {
            if (simulated) return;
            void released(threadId, sessionId, delivery).catch((error: unknown) => {
              log(`routing: delivering a released buffer failed: ${String(error)}`);
            });
          },
          // The gate dropped a buffer because its thread admitted a message for a different
          // session. The gate logged it; the thread's readers are told here, since the writer is
          // this router's, with the cause read off the records as on every other drop. Not in
          // shadow, where nothing was withheld from the thread.
          onDrop: (threadId, sessionId, count) => {
            if (simulated) return;
            const cause = dropCause(options.registry.list(), sessionId);
            void announceDrop(threadId, count, cause).catch((error: unknown) => {
              log(`routing: announcing a dropped buffer failed: ${String(error)}`);
            });
          },
          ...(buffersFile === null
            ? {}
            : { persist: (buffers) => saveHeldBuffers(buffersFile, buffers) }),
          ...(settings.setTimer === undefined ? {} : { setTimer: settings.setTimer }),
          ...(settings.clearTimer === undefined ? {} : { clearTimer: settings.clearTimer }),
          log,
          now,
        })
      : null;

  /**
   * A restored line classed again through the roster as it stands now, or null for an account
   * the roster no longer admits. The class in the file is the roster's answer at admission, and a
   * roster change takes effect at a restart, so a line held across one is delivered under the
   * class its account holds today and never under one it has lost: the same guard the inbound
   * path applies, on the same id.
   */
  function reclassed(message: BufferedMessage): BufferedMessage | null {
    const senderClass = options.gate.classOf(message.senderId);
    return senderClass === null ? null : { ...message, senderClass };
  }

  // What an earlier broker process held, read once here and in live alone. An entry is held again
  // for its thread and session where its session record restored with a state other than ended
  // and the thread is that session's bound thread, with each line classed again through the
  // roster and a line from an account no longer admitted dropped. An entry whose session did not
  // restore is dropped with the counted notice the same drop posts mid-run, its cause read off the
  // records; one whose thread is not its session's is dropped with a log line alone, since the
  // thread's readers are not that session's. The restore runs before the first message; the age
  // caps are armed later, by `armRestored`, at the bind. In production the listener binds after
  // this router is built, so a session's relay attaching is what delivers a restored buffer; the
  // already-attached branch serves a second router over one state directory, which the tests
  // drive. The file is read only where it held something: a missing or unusable file is one log
  // line from the loader and no write, so an unusable file is left for the operator to read until
  // the first admit, delivery or drop writes the file over.
  if (gate !== null && buffersFile !== null && settings?.buffers !== undefined) {
    const records = options.registry.list();
    const entries = loadHeldBuffers(buffersFile, { now, log });
    const kept: Array<{ entry: HeldBuffer; record: SessionRecord }> = [];
    for (const entry of entries) {
      const count = String(entry.messages.length);
      const record = records.find((held) => held.sessionId === entry.sessionId);
      if (record === undefined || record.state === "ended") {
        log(
          `routing: dropped ${count} buffered messages held for session ${entry.sessionId}, ` +
            "which did not survive the broker restart",
        );
        // Fire and forget, as on every other drop: the announcement never rejects by construction.
        const cause = dropCause(records, entry.sessionId);
        void announceDrop(entry.threadId, entry.messages.length, cause).catch((error: unknown) => {
          log(`routing: announcing a dropped buffer failed: ${String(error)}`);
        });
        continue;
      }
      if (options.threadFor(entry.sessionId) !== entry.threadId) {
        log(
          `routing: dropped ${count} buffered messages held for session ${entry.sessionId}, ` +
            `whose thread is not ${entry.threadId}`,
        );
        continue;
      }
      const messages = entry.messages.map(reclassed).filter((message) => message !== null);
      if (messages.length < entry.messages.length) {
        log(
          `routing: dropped ${String(entry.messages.length - messages.length)} of ${count} buffered ` +
            `messages held for session ${entry.sessionId}, written from accounts the roster no ` +
            "longer admits",
        );
      }
      if (messages.length > 0) kept.push({ entry: { ...entry, messages }, record });
    }
    if (entries.length > 0) {
      gate.restore(kept.map(({ entry }) => entry));
      for (const { record } of kept) {
        if (options.relays.attached(record.processToken)) gate.deliverRestored(record.sessionId);
      }
    }
  }

  return {
    async deliver(message) {
      // Everything this broker writes into a thread arrives back over the same gateway. Without
      // this, the first reply would be routed straight back into the session that prompted it.
      // It stands in front of the gate because it is a drop and not a pass: a bot's own ID is
      // never the allowlisted one, so the gate below would refuse it a line later either way.
      // Before the drop, this bot's own post stamps the thread's last-post clock, which the judge
      // is told the seconds since: the writer's replies and the mirror's posts alike arrive here
      // under the bot's own user. Another bot's post is dropped the same way and stamps nothing.
      if (message.fromBot) {
        if (message.fromSelf) gate?.notePost(message.threadId);
        return;
      }

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

      // The message as the gate holds it: the text as bounded above and the name as the gateway
      // bounded it, so what a delivered line carries is exactly what a delivered message carries,
      // and nothing is sanitized twice.
      const buffered = {
        id: message.messageId,
        senderId: message.senderId,
        author: message.author,
        senderClass,
        text,
        truncated,
      };
      const addressed = { mentionsBot: message.mentionsBot, repliesToBot: message.repliesToBot };

      if (gate === null || simulated) {
        // Shadow: the message joins the simulated buffer here, before the delivery below awaits
        // anything, as it would join the live buffer. The gateway does not await one delivery
        // before firing the next, so an admission after the pipe write and its notices could
        // take a later message first. The pipe's outcome is never read: live admission does not
        // read it either. What the gate decides is journaled by the gate and reaches nothing else.
        gate?.admit(message.threadId, record.sessionId, buffered, addressed);
        const delivered = await handOver(
          record,
          message.threadId,
          { type: "message", chatId: message.threadId, text, author: message.author, senderClass },
          1,
        );
        if (!delivered) return;
        const deliveredAt = now();
        options.receipts?.delivered(message.threadId, message.messageId, deliveredAt);
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
      const deliveries = gate.admit(message.threadId, record.sessionId, buffered, addressed);
      // Held, when there are none. Nothing is announced then, a cut included: the announcement
      // belongs to a delivery, and this one has not happened yet. Two, when this message pushed
      // the held buffer past the event budget and then delivered on its own: written in order, so
      // the session reads the thread in the order it was written.
      await handOverBuffers(record, message.threadId, deliveries);
    },

    reconcile(sessions) {
      if (gate === null) return;
      for (const { threadId, sessionId } of gate.held()) {
        const hold = holdFor(sessions, threadId, sessionId);
        if (hold.record !== null) continue;
        const dropped = gate.clear(threadId);
        // The simulated buffer clears as the live one would, and that is all: nothing was
        // withheld from the thread, so there is no loss to log or to tell its readers of.
        if (simulated) continue;
        log(
          `routing: dropped ${String(dropped)} buffered messages held for session ${sessionId}, ` +
            `which no longer holds thread ${threadId}`,
        );
        // Fire and forget, on the registry's own mutation tick: the announcement never rejects by
        // construction, and this seam is synchronous.
        void announceDrop(threadId, dropped, hold.cause).catch((error: unknown) => {
          log(`routing: announcing a dropped buffer failed: ${String(error)}`);
        });
      }
    },

    close() {
      // No notice for these drops: the broker is shutting down, and a post from a process on its
      // way out is one it may not be there to finish. What was held is in the file, for the next
      // start to restore.
      gate?.close();
    },

    relayAttached(processToken) {
      if (gate === null || simulated) return;
      const record = options.registry.current(processToken);
      if (record !== null) gate.deliverRestored(record.sessionId);
    },

    armRestored() {
      if (gate === null || buffersFile === null || settings?.buffers === undefined) return;
      gate.armRestored(settings.buffers.graceMs);
    },
  };
}
