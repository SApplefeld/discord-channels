// Session to Discord: a `reply` tool call becomes a message in that session's own thread.
//
// The routing is by **session**, never by the `chat_id` Claude passed. A chat_id that arrived on an
// inbound event is advisory: it is the thread the last message came from, which is not necessarily
// the thread this session owns now, and Claude may reply having received no event at all. Routing
// by session is what makes an unprompted reply land correctly, and it is also what stops a reply
// from being addressable: the relay never forwards a chat_id, so there is nothing here to honor.
import type { Registry } from "../registry.ts";
import type { ThreadWriter } from "./writer.ts";

export type OutboundRouterOptions = {
  registry: Registry;
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  writer: ThreadWriter;
  log?: (message: string) => void;
};

/** Why a reply could not be posted, in the terms the relay reports back to Claude. */
export type ReplyResult =
  | { status: "sent" }
  | { status: "no-session" }
  | { status: "no-thread" }
  | { status: "failed"; error: string };

export type OutboundRouter = {
  /** Posts one reply from the session currently held by this process token. */
  reply: (processToken: string, text: string) => Promise<ReplyResult>;
};

export function createOutboundRouter(options: OutboundRouterOptions): OutboundRouter {
  const log = options.log ?? ((): void => {});

  return {
    async reply(processToken, text) {
      const record = options.registry.current(processToken);
      // No announced session for this process. The relay is running, but the SessionStart hook has
      // not reported yet or is not installed, so there is no thread to name.
      if (record === null) return { status: "no-session" };

      const threadId = options.threadFor(record.sessionId);
      // The session is known but its thread has not been opened yet, or Discord is not configured
      // at all. Nothing is queued: by the time a thread existed the reply would be stale.
      if (threadId === null) return { status: "no-thread" };

      const posted = await options.writer.reply(threadId, text);
      if (posted.status === "ok") return { status: "sent" };

      const error = posted.status === "rate-limited" ? "rate limited" : posted.error;
      log(`routing: the reply from session ${record.sessionId} was not posted: ${error}`);
      return { status: "failed", error };
    },
  };
}
