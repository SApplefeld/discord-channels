// Discord to session: the one path a message from outside this machine takes to reach Claude.
//
// **This is where Section 6's sender gate attaches.** `deliver` is the single caller of the relay
// hub, and `InboundMessage.senderId` is already carried here unused for that reason: the gate is a
// refusal at the top of `deliver`, keyed on the Discord user ID, and needs nothing threaded through
// to reach it. It is deliberately absent rather than present and permissive, because an unset gate
// that allows everything is indistinguishable from a gate that was never wired.
//
// Until it exists, nothing here authorizes anything, and nothing downstream should be read as
// having done so. A process token identifies a pipe; it is not evidence about who sent a message,
// and no check below consults it for that.
import { sliceCodePoints, withoutInvisible } from "../sanitize.ts";
import type { Registry, SessionRecord } from "../registry.ts";
import type { RelayHub } from "./relays.ts";
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
  /** The author's Discord user ID. Section 6's allowlist is the only authority on it. */
  senderId: string;
  /** True when this bot wrote it. Its own cards, replies, and notices all come back over the gateway. */
  fromBot: boolean;
  text: string;
};

/**
 * Ceiling on the text handed to a session, in code points. Discord allows a longer message than
 * this from a boosted server, and the pipe carrying it is the session's own MCP transport, so the
 * bound is the broker's to set rather than Discord's.
 */
export const MAX_INBOUND_TEXT_LENGTH = 2_000;

/**
 * Most messages one session is handed in a window, and the window. A session steered from a phone
 * receives a handful of messages an hour; a burst past this is either a mistake or someone using
 * the thread to flood a running session's context, and there is no sender gate in front of it yet.
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
 */
function bounded(text: string): string {
  return sliceCodePoints(withoutInvisible(text).trim(), MAX_INBOUND_TEXT_LENGTH);
}

export type InboundRouterOptions = {
  registry: Registry;
  relays: RelayHub;
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  /** Writes a notice back into the thread a message could not be delivered from. */
  writer: ThreadWriter;
  /** Injected so a test drives the rate ceiling without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
};

export type InboundRouter = {
  /** Routes one gateway message. Never throws: a failed notice is logged, not propagated. */
  deliver: (message: InboundMessage) => Promise<void>;
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
  registry: Registry,
  threadFor: (sessionId: string) => string | null,
  threadId: string,
): SessionRecord | null {
  let ended: SessionRecord | null = null;
  for (const record of registry.list()) {
    if (threadFor(record.sessionId) !== threadId) continue;
    if (record.state !== "ended") return record;
    ended = record;
  }
  return ended;
}

/** What the operator sees in the thread when a message had nowhere to go. */
export const ENDED_NOTICE =
  "This session has ended, so the message was not delivered. Nothing is queued: start a new " +
  "session and it opens its own thread.";

export const UNREACHABLE_NOTICE =
  "This session has no channel connected, so the message was not delivered. It is still running; " +
  "it was started without the relay, or the relay is reconnecting.";

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
    return true;
  }

  async function notice(threadId: string, text: string): Promise<void> {
    try {
      await options.writer.notice(threadId, text);
    } catch (error) {
      log(`routing: could not post a notice into thread ${threadId}: ${String(error)}`);
    }
  }

  return {
    async deliver(message) {
      // Everything this broker writes into a thread arrives back over the same gateway. Without
      // this, the first reply would be routed straight back into the session that prompted it.
      if (message.fromBot) return;

      const record = sessionForThread(options.registry, options.threadFor, message.threadId);
      // A thread this broker does not own, or one whose session has been pruned. Silence is right:
      // the operator is talking in some other thread of their own.
      if (record === null) return;

      const text = bounded(message.text);
      // An attachment, a sticker, or a message whose whole content was invisible. There is nothing
      // to hand a session, and a notice would only be noise.
      if (text === "") return;

      if (record.state === "ended") {
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

      const delivered = options.relays.deliver(record.processToken, {
        type: "message",
        chatId: message.threadId,
        text,
      });
      if (delivered) return;

      log(`routing: session ${record.sessionId} has no relay attached, rejecting in-thread`);
      await notice(message.threadId, UNREACHABLE_NOTICE);
    },
  };
}
