// Session to Discord: a `reply` tool call becomes a message in that session's own thread.
//
// The routing is by **session**, never by the `chat_id` Claude passed. A chat_id that arrived on an
// inbound event is advisory: it is the thread the last message came from, which is not necessarily
// the thread this session owns now, and Claude may reply having received no event at all. Routing
// by session is what makes an unprompted reply land correctly, and it is also what stops a reply
// from being addressable: the relay never forwards a chat_id, so there is nothing here to honor.
import { renderAnswer, renderMirror } from "../discord/render.ts";
import type { MirrorKind } from "../discord/render.ts";
import { withoutInvisible } from "../sanitize.ts";
import type { Registry } from "../registry.ts";
import type { ThreadWriter } from "./writer.ts";

export type OutboundRouterOptions = {
  registry: Registry;
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  /**
   * The writer conversation volume spends: mirrored prompts and replies, and the reply tool's
   * answers. A separate writer from the alert one because each writer holds its own budget bucket:
   * conversation volume arrives on every prompt and every turn end of every wrapped session, and
   * can run many messages per post, so a rate-limit block it earns must not be the block that
   * drops a permission alert a parked session is waiting on. The split creates no Discord
   * capacity; it only stops one path's rate-limit state from starving the other.
   */
  mirrorWriter: ThreadWriter;
  log?: (message: string) => void;
  /** Drives the drop-log rate limiter. Injected so a test moves its window without sleeping. */
  now?: () => number;
};

/** How long a run of the same drop line for the same session is aggregated before its next flush. */
const DROP_WINDOW_MS = 60_000;

/**
 * How many drop keys are held before the closed ones are swept.
 *
 * A key carries a session id, so without the sweep this map would hold one entry for every session
 * this broker has ever dropped a post for, for as long as it runs.
 */
const MAX_DROP_KEYS = 64;

/**
 * Rate-limits a repeating drop line by its own text, which carries the kind and the session and
 * nothing else that varies.
 *
 * A mirror drop is not a one-off: a session whose thread has not opened drops every prompt and
 * every turn for as long as that lasts, and one line each would push the earlier evidence of it out
 * through rotation. The first of a line is written at once; a repeat inside the window is counted
 * and the count rides on the next line that window admits. Keyed per session as well as per cause,
 * because one session's steady drops on a shared key would swallow the first drop of another's.
 *
 * Local rather than the intake's refusal limiter: that one writes through a Logger's warn level
 * under its own hook-refused prefix, and this layer holds a plain log function.
 */
function createDropLog(
  log: (message: string) => void,
  now: () => number,
): (line: string) => void {
  const state = new Map<string, { windowStart: number; suppressed: number }>();
  return (line) => {
    const at = now();
    const entry = state.get(line);
    if (entry !== undefined && at - entry.windowStart < DROP_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    const repeats =
      entry !== undefined && entry.suppressed > 0
        ? ` (and ${entry.suppressed} more time(s) in the last ${DROP_WINDOW_MS}ms)`
        : "";
    log(`routing: ${line}${repeats}`);
    state.set(line, { windowStart: at, suppressed: 0 });
    if (state.size <= MAX_DROP_KEYS) return;
    for (const [key, held] of state) {
      // Only a closed window with nothing counted against it: an entry still owing a repeat count
      // is what the next line of its kind reports, and dropping it would lose that count.
      if (held.suppressed === 0 && at - held.windowStart >= DROP_WINDOW_MS) state.delete(key);
    }
  };
}

/**
 * How the Claude Code harness opens the envelope it wraps a channel message in before injecting it
 * into the session as a user prompt.
 *
 * The harness's contract, not this project's: an external shape that can change without notice, and
 * a change to it costs the operator a duplicate of their own message in the thread rather than
 * anything unsafe, which is why the match is a plain prefix rather than a parse.
 */
const CHANNEL_ENVELOPE = "<channel source=";

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
   * `sessionId` is the session the mirror payload names, and a post is delivered only when it
   * matches the session the token holds. A /clear replaces the session under the same process
   * token, so a straggler carrying the replaced session's id is dropped rather than credited to
   * the new session and posted into its thread, and a post naming no session at all is dropped for
   * the same reason: it is content that cannot be attributed to the session whose thread it would
   * land in. The reply tool routes on the token alone, which is different because a reply is
   * written by the session holding the pipe rather than by whatever inherited the token.
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
  const dropped = createDropLog(log, options.now ?? Date.now);

  // Resolution shared by both posting paths, held in one place so the two cannot drift: a post is
  // addressed by the session currently holding the process token and by nothing else, and nothing
  // is queued for a thread that does not exist yet, because by the time one did the post would be
  // stale.
  //
  // The no-thread answer carries the session it resolved, which the caller has no other way to
  // name in a log line: the only other thing it holds is the process token, and that is the key a
  // post is authenticated by rather than something to write down.
  function locate(
    processToken: string,
  ):
    | { sessionId: string; threadId: string }
    | { status: "no-session" }
    | { status: "no-thread"; sessionId: string } {
    const record = options.registry.current(processToken);
    // No announced session for this process. The relay is running, but the SessionStart hook has
    // not reported yet or is not installed, so there is no thread to name.
    if (record === null) return { status: "no-session" };

    const threadId = options.threadFor(record.sessionId);
    // The session is known but its thread has not been opened yet, or Discord is not configured
    // at all.
    if (threadId === null) return { status: "no-thread", sessionId: record.sessionId };

    return { sessionId: record.sessionId, threadId };
  }

  // Per-thread ordering, held here because this router is the one place both conversation-carrying
  // paths pass through: a mirrored prompt, a mirrored reply, and a reply-tool post. The writer
  // orders nothing (it takes one message at a time and knows nothing about the next), and delivery
  // from the mirror intake is fire-and-forget, so nothing upstream orders one post against the
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
  //
  // The order this holds is the order posts reach this router, and the mirror intake hands one over
  // when its body has finished being read rather than when its request arrived. So two mirror posts
  // for one thread can be handed over in the other order, which takes one post's body still
  // arriving as the next one lands: a turn's reply and the prompt after it are separated by however
  // long the operator spends typing, and the intake reads a body in one pass off a loopback socket.
  // Exactness would mean the intake taking its place on a thread's chain before it reads, and the
  // thread is precisely what it cannot resolve there, since it holds a process token and this
  // router is keyed by the thread that token's session is bound to.
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

  /**
   * Posts one rendered run of messages, in order, as one task on the thread's chain, so nothing
   * else this router posts lands between the messages of one answer or one mirrored reply. A post
   * refused part way through stops the run: the rest posted around a hole reads as text the author
   * never wrote, and the transport that refused one message refuses the next for the same reason.
   *
   * One function for both posting paths on purpose: the landed count and the error wording are
   * part of what the callers log and report, and two copies of this loop would let those drift.
   */
  async function deliver(
    threadId: string,
    messages: string[],
  ): Promise<{ landed: number; error: string | null }> {
    return inOrder(threadId, async () => {
      let landed = 0;
      for (const message of messages) {
        const outcome = await options.mirrorWriter.reply(threadId, message);
        if (outcome.status !== "ok") {
          return { landed, error: outcome.status === "rate-limited" ? "rate limited" : outcome.error };
        }
        landed += 1;
      }
      return { landed, error: null };
    });
  }

  return {
    async reply(processToken, text) {
      const located = locate(processToken);
      // Rebuilt rather than passed along, so the session `locate` resolved for the log line below
      // stays here: this result is serialized back to the relay and read by the model, and the
      // relay is told why a reply did not land, never what the broker knows about the session.
      if ("status" in located) return { status: located.status };

      // Rendered by the same machinery the mirror below is rendered by, and for the same reasons:
      // both paths post into the one thread, so a reply tool call is the other way a line that
      // renders as the mirror's attribution, or a mention pill, or a timestamp chip, could reach it,
      // and a reply longer than one message is split rather than cut. The text of a reply is written
      // by a model that has read whatever the session read, which is what makes this an untrusted
      // string rather than the broker's own.
      const messages = renderAnswer(text);
      // Nothing visible once the invisible class is stripped. Reported to the relay, which is read
      // by the model that called the tool, rather than posted: Discord refuses an empty message.
      if (messages.length === 0) return { status: "failed", error: "the message was empty" };

      // Spent against the conversation writer, never an alert-tier one, because an answer is
      // conversation volume: it can run many messages, and a rate-limit block earned by one long
      // answer must not be the block that drops the permission prompt a parked session is waiting
      // on. Alert paths hold their own writer and never come through this router.
      const run = await deliver(located.threadId, messages);
      if (run.error === null) return { status: "sent" };

      // The counts and the transport's error class only. The text is Claude's own words to the
      // operator, and conversation content never appears in the broker log at any level.
      log(
        `routing: the reply from session ${located.sessionId} stopped after ` +
          `${run.landed} of ${messages.length} messages: ${run.error}`,
      );
      // The count rides back to the relay too, because the model reads this result and decides
      // whether to try again: a bare error invites resending the whole answer, and the first
      // `landed` messages would post a second time. A run that landed nothing is safe to resend
      // and reports the plain error.
      return {
        status: "failed",
        error:
          run.landed === 0
            ? run.error
            : `stopped after ${run.landed} of ${messages.length} messages: ${run.error}`,
      };
    },

    async mirror(processToken, kind, text, sessionId) {
      const located = locate(processToken);
      // A drop here is silent on every other surface: the session sees its 202, the thread shows
      // nothing, and a mirror suppressed on purpose reads exactly like one that is broken. These
      // lines are the discriminator the runbook sends an operator to, so they carry the cause and
      // the session and never the text.
      if ("status" in located) {
        dropped(
          located.status === "no-thread"
            ? `the mirrored ${kind} from session ${located.sessionId} was dropped, its thread is not open yet`
            : // The process token is the only other thing this post arrived with, and it is the
              // key such a post is authenticated by, so the line names no session at all.
              `a mirrored ${kind} was dropped, no announced session holds the posting process`,
        );
        return { status: located.status };
      }

      // The straggler gate, which every mirror post must pass by naming the session it came from.
      // A payload naming a session the token no longer holds belongs to a conversation that ended
      // at a /clear, and one naming nothing cannot be attributed at all: both would otherwise post
      // as the current session's own words. The unattributable case is the reachable one, because
      // every process a session spawns inherits its token, and a `claude` running as a subprocess
      // mirrors prompts and replies from a conversation of its own, often in another repository.
      //
      // Closed rather than open, so what a missing field costs is a log line rather than another
      // conversation's text in the operator's thread, which nothing can take back. Every hook
      // payload carries `session_id`, so nothing that arrives today is turned away here.
      if (sessionId === null) {
        dropped(
          `a mirrored ${kind} for session ${located.sessionId} was dropped, it named no session of its own`,
        );
        return { status: "no-session" };
      }
      if (sessionId !== located.sessionId) return { status: "no-session" };

      // A message the operator posted in this very thread, handed to the session as a prompt and on
      // its way back to where it was typed. Mirrored, it shows the operator their own message a
      // second time, attributed to a console they were not sitting at.
      //
      // Matched before the renderer's escapes touch the text, so what is tested is the string the
      // harness composed rather than a rewritten copy of it: escaping can neither hide the envelope
      // from this nor build one that was not there. The invisible class is stripped first, though,
      // by the same rule the renderer strips it, because a zero-width character in front of the
      // envelope would otherwise hide it from a prefix match while changing nothing the reader
      // sees. Only the opening counts, so a prompt that quotes the marker mid-text still mirrors,
      // and only a prompt is examined, because a reply is Claude's own words about the envelope
      // rather than one.
      if (kind === "prompt" && withoutInvisible(text).trimStart().startsWith(CHANNEL_ENVELOPE)) {
        dropped(
          `the mirrored prompt from session ${located.sessionId} was dropped, it is the operator's ` +
            `own channel message echoed back to the thread it was posted in`,
        );
        return { status: "failed", error: "the message came from the channel" };
      }

      const messages = renderMirror(kind, text);
      // Nothing visible in the payload once the invisible class is stripped. Reported rather than
      // posted: Discord refuses an empty message, and one would read in the thread as the session
      // having answered with silence.
      if (messages.length === 0) {
        dropped(
          `the mirrored ${kind} from session ${located.sessionId} was dropped, it carried no visible text`,
        );
        return { status: "failed", error: "the message was empty" };
      }

      const run = await deliver(located.threadId, messages);
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
