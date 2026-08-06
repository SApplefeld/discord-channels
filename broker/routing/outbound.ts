// Session to Discord: a `reply` tool call becomes a message in that session's own thread.
//
// The routing is by **session**, never by the `chat_id` Claude passed. A chat_id that arrived on an
// inbound event is advisory: it is the thread the last message came from, which is not necessarily
// the thread this session owns now, and Claude may reply having received no event at all. Routing
// by session is what makes an unprompted reply land correctly, and it is also what stops a reply
// from being addressable: the relay never forwards a chat_id, so there is nothing here to honor.
import { renderMirror } from "../discord/render.ts";
import type { MirrorKind } from "../discord/render.ts";
import type { Registry } from "../registry.ts";
import type { ThreadWriter } from "./writer.ts";

export type OutboundRouterOptions = {
  registry: Registry;
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  writer: ThreadWriter;
  /**
   * The writer mirror posts spend. A separate writer from the reply one because each writer holds
   * its own budget bucket: mirror volume arrives on every prompt and every turn end of every
   * wrapped session, and a rate-limit block it earns must not be the block that drops a permission
   * alert a parked session is waiting on. The split creates no Discord capacity; it only stops one
   * path's rate-limit state from starving the other.
   */
  mirrorWriter: ThreadWriter;
  log?: (message: string) => void;
};

/** Why a reply could not be posted, in the terms the relay reports back to Claude. */
export type ReplyResult =
  | { status: "sent" }
  | { status: "no-session" }
  | { status: "no-thread" }
  | { status: "failed"; error: string };

/**
 * What a mirror post carries: the operator's console prompt, or the turn's final assistant reply.
 * The kind rides the whole path from the intake so the rendering layer can attribute a prompt to
 * the console rather than presenting it as Claude's own text. Defined by that renderer, and passed
 * through here, so the intake asks for a kind the renderer knows how to draw.
 */
export type { MirrorKind };

export type OutboundRouter = {
  /** Posts one reply from the session currently held by this process token. */
  reply: (processToken: string, text: string) => Promise<ReplyResult>;
  /**
   * Posts one mirrored prompt or reply from the session currently held by this process token.
   *
   * `sessionId` is the session the mirror payload names, when it names one. It is honored the way
   * the /hook path's registry keying honors it: a /clear replaces the session under the same
   * process token, so a straggler post carrying the replaced session's id is dropped rather than
   * credited to the new session and posted into its thread. With no session id the token routes
   * alone, as reply does.
   *
   * This is the seam where mirror text becomes Discord messages. The renderer decides how many it
   * takes, and they are posted in order through the mirror writer. A post refused part way through
   * stops the run: the rest are dropped and never retried, so the thread shows a reply that ends
   * early rather than a reply with an invisible hole in the middle, and the count that landed is
   * logged. Retrying would be a second reason to write into a thread whose budget has already said
   * no.
   */
  mirror: (
    processToken: string,
    kind: MirrorKind,
    text: string,
    sessionId: string | null,
  ) => Promise<ReplyResult>;
};

export function createOutboundRouter(options: OutboundRouterOptions): OutboundRouter {
  const log = options.log ?? ((): void => {});

  // Resolution shared by both posting paths, held in one place so the two cannot drift: a post is
  // addressed by the session currently holding the process token and by nothing else, and nothing
  // is queued for a thread that does not exist yet, because by the time one did the post would be
  // stale.
  function locate(
    processToken: string,
  ): { sessionId: string; threadId: string } | { status: "no-session" | "no-thread" } {
    const record = options.registry.current(processToken);
    // No announced session for this process. The relay is running, but the SessionStart hook has
    // not reported yet or is not installed, so there is no thread to name.
    if (record === null) return { status: "no-session" };

    const threadId = options.threadFor(record.sessionId);
    // The session is known but its thread has not been opened yet, or Discord is not configured
    // at all.
    if (threadId === null) return { status: "no-thread" };

    return { sessionId: record.sessionId, threadId };
  }

  // Per-thread ordering, held here because this router is the one place both conversation-carrying
  // paths pass through: a mirrored prompt, a mirrored reply, and a reply-tool post. They reach
  // Discord through two different writers, deliberately, so no single writer can order them, and
  // delivery from the mirror intake is fire-and-forget, so nothing upstream orders one against the
  // next either. Without this a turn's reply and the prompt that followed it race, and a reply
  // split across twenty messages interleaves with whatever else the session posts mid-run.
  //
  // Keyed by thread, never global: two sessions' threads post concurrently, as they must, since a
  // busy session would otherwise hold every other session's writes behind it.
  //
  // This is ordering, not queueing. A task waits only on the posts already on the wire for its own
  // thread; nothing is held for a thread that has none, and nothing is retried or kept for later,
  // which is the rule the whole routing layer follows: a message that lands minutes late answers a
  // question the operator stopped asking. Alerts and notices do not come through here, which is
  // what keeps a permission prompt from queueing behind a long mirrored reply.
  const chains = new Map<string, Promise<void>>();

  function inOrder<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(threadId) ?? Promise.resolve();
    const running = previous.then(task);
    // What the next task waits on never rejects: a refused or failed post is that caller's to
    // report, and letting it reject here would cancel every post queued behind it.
    const settled = running.then(
      () => {},
      () => {},
    );
    chains.set(threadId, settled);
    void settled.then(() => {
      // Dropped once the thread is quiet, so the map holds the conversations in flight rather than
      // one entry for every thread this broker has ever written to.
      if (chains.get(threadId) === settled) chains.delete(threadId);
    });
    return running;
  }

  return {
    async reply(processToken, text) {
      const located = locate(processToken);
      if ("status" in located) return located;

      const posted = await inOrder(located.threadId, () =>
        options.writer.reply(located.threadId, text),
      );
      if (posted.status === "ok") return { status: "sent" };

      const error = posted.status === "rate-limited" ? "rate limited" : posted.error;
      log(`routing: the reply from session ${located.sessionId} was not posted: ${error}`);
      return { status: "failed", error };
    },

    async mirror(processToken, kind, text, sessionId) {
      const located = locate(processToken);
      if ("status" in located) return located;

      // The straggler gate. A payload naming a session the token no longer holds belongs to a
      // conversation that ended at a /clear; delivering it would post that conversation's text
      // into the new session's thread.
      if (sessionId !== null && sessionId !== located.sessionId) return { status: "no-session" };

      const messages = renderMirror(kind, text);
      // Nothing visible in the payload once the invisible class is stripped. Reported rather than
      // posted: Discord refuses an empty message, and one would read in the thread as the session
      // having answered with silence.
      if (messages.length === 0) return { status: "failed", error: "the message was empty" };

      // The whole run is one task on the thread's chain, so nothing else this router posts lands
      // between the messages of one reply.
      const run = await inOrder(located.threadId, async () => {
        let landed = 0;
        for (const message of messages) {
          const outcome = await options.mirrorWriter.reply(located.threadId, message);
          if (outcome.status !== "ok") {
            const failure = outcome.status === "rate-limited" ? "rate limited" : outcome.error;
            return { landed, error: failure };
          }
          landed += 1;
        }
        return { landed, error: null as string | null };
      });
      if (run.error === null) return { status: "sent" };

      // The kind, the counts, and the transport's error class only. The text is the operator's
      // prompt or Claude's reply, and mirror content never appears in the broker log at any level.
      // The counts are what make a reply that stopped early visible as that rather than as a reply
      // Claude never finished.
      log(
        `routing: the mirrored ${kind} from session ${located.sessionId} stopped after ` +
          `${run.landed} of ${messages.length} messages: ${run.error}`,
      );
      return { status: "failed", error: run.error };
    },
  };
}
