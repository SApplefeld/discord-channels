// Session to Discord: a `reply` tool call becomes a message in that session's own thread.
//
// The routing is by **session**, never by the `chat_id` Claude passed. A chat_id that arrived on an
// inbound event is advisory: it is the thread the last message came from, which is not necessarily
// the thread this session owns now, and Claude may reply having received no event at all. Routing
// by session is what makes an unprompted reply land correctly, and it is also what stops a reply
// from being addressable: the relay never forwards a chat_id, so there is nothing here to honor.
import {
  appendNarration,
  renderAnswer,
  renderMirror,
  renderPeerIn,
  renderPeerInBrief,
  renderPeerOut,
  renderPeerOutBrief,
  renderTaskNotice,
} from "../discord/render.ts";
import type { MirrorKind } from "../discord/render.ts";
import { withoutInvisible } from "../sanitize.ts";
import type { Registry } from "../registry.ts";
// The peer classification is read here rather than duplicated, so the two paths a peer message
// reaches a thread by cannot answer differently about one message. A runtime import back into the
// tailer, which imports this module type-only, so the modules stay acyclic at run time.
import { crossSessionDelivery } from "../tail.ts";
import type { EchoMemory, EchoSlot, PeerTraffic, PromptSource } from "../tail.ts";
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
  /**
   * The dedup memory, present whenever the Stop mirror is on. The transcript tailer shares it and
   * additionally requires interim mirroring, so a mirror-only host has this memory and no tailer.
   * There the reply-tool dedup is the only pairing that ever matches: nothing writes the interim
   * slot or the tailer's prompt slot at all, so the prompt dedup answers nothing rather than
   * swallowing the operator's next identical prompt.
   *
   * The tailer reads the turn's final reply off the transcript up to a poll interval after the Stop
   * mirror posts it, so the two paths consult one memory: `mirror` with the reply kind skips a post
   * matching the tailer's last interim chunk, records its own digest once the text is on the thread
   * (by this post or by the tailer's), and the tailer skips a chunk matching either digest. A match
   * consumes the digest it matched, so nothing here becomes a standing blocklist.
   *
   * The prompt pair is the same pairing over the operator's typed words that open a turn, which
   * reach a thread by the `UserPromptSubmit` mirror and, when that hook is slow or the harness
   * timed it out, by the tailer's read of the same line. One slot per path, each written by its own
   * path and read by the other, so whichever sends first wins and neither path can reach its own
   * claim. A claim also expires, since a claim the other path never answers would otherwise stand
   * over the next identical prompt forever.
   *
   * The memory also carries the reply-tool dedup: `reply` records the answer it posted, and
   * `mirror` with the reply kind skips a post matching it exactly or nearly, because a long turn's
   * closing reply-tool summary and its Stop mirror are frequently the same words. Without the
   * memory, prompts and replies mirror exactly as they did before interim mirroring existed.
   */
  echo?: EchoMemory;
  /**
   * How a wake prompt, the harness's injection when a background task finishes while its session
   * is idle, reaches the thread. `brief`, the default when absent, posts the one-line notice
   * `renderTaskNotice` composes in place of the injected report; `full` mirrors the whole report
   * exactly as an ordinary prompt; `off` posts nothing and leaves a log line. Applied on both
   * paths a prompt reaches a thread by, the hook-carried mirror and the prompts the transcript
   * tailer reads, so one wake prompt gets one answer whichever way it arrived.
   *
   * That one answer rests on the harness's own stamping rather than on there being one path. Every
   * task-notification user line the harness writes carries `promptSource` `system` or `sdk` with
   * `origin.kind` `task-notification`, so the tailer's turn-open reading refuses the shape at its
   * first lock and only the hook-carried mirror ever sees a wake; the queued reading admits the
   * mid-turn shape the harness queues, which is the other way one arrives. Should a revision start
   * stamping a wake the way it stamps a typed prompt, both paths would see one wake and the setting
   * would apply twice to it, which is why the treatment is identical on both rather than owned by
   * one.
   */
  taskNotifications?: "brief" | "full" | "off";
  /**
   * How much of a peer message reaches the thread. `full`, the default when absent, draws the
   * message whole under its own peer attribution; `brief` draws one line, the sender's own summary
   * where an outbound send wrote one and the body's opening line otherwise; `off` posts nothing and
   * leaves a log line. Applied on all three paths a peer message reaches a thread by and in both
   * directions, so no path draws a message another path would compress.
   *
   * What this setting cannot do is put a path on the wire. Only the inbound half delivered to an
   * idle session rides the prompt seams; this session's own sends and every message that arrived
   * while it was working are read off the transcript, so they reach a thread only while the tailer
   * exists. An exchange is whole here only while it does, and the broker says so once at startup
   * rather than leaving half a conversation reading like all of one.
   *
   * Volume is all it governs, and attribution is not a knob: a peer message is drawn under the peer
   * attribution and stamps no engagement on every setting, `full` included, because what a peer
   * wrote is never the operator's own register and never evidence that a person is driving.
   */
  peerMessages?: "full" | "brief" | "off";
  log?: (message: string) => void;
  /**
   * The clock this router reads: the drop log's window, and what a paced run's reactive waits are
   * measured against so the cap bounds the time they really cost. Injected so a test moves both
   * without sleeping, alongside the `sleep` below, which is what advances an injected one.
   */
  now?: () => number;
  /**
   * Waits, which is what paces a split run and what sits out a rate-limited refusal before the
   * refused message is posted again. Injected so a test drives a paced run's timing without
   * spending it.
   *
   * The default timer does not hold the event loop open, so a broker shutting down mid-gap exits
   * rather than lingering for the rest of the run, which drops the remainder exactly as a shutdown
   * mid-run does.
   */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The gap between consecutive posts of one run. No gap precedes a run's first post.
 *
 * Discord allows roughly five message creates per five seconds in one thread, and a long report
 * renders into more messages than that. Fired back to back they empty the bucket part way through
 * and the rest of the report is refused; spaced by this, a run's send rate stays under the bucket
 * and the refusal is rare rather than routine. The cost is that a report arrives over seconds,
 * which is what the operator reading it on a phone would choose over half of it.
 */
export const RUN_PACE_MS = 1_500;

/**
 * How much of one run's time may be spent waiting out rate-limit refusals. Pacing gaps are not
 * counted against it: they are the mechanism that keeps the bucket full, not evidence it is empty.
 *
 * Past this a run stops where it got to and reports the count, the same answer it gives any
 * refusal it cannot pass. What it bounds is the waiting and nothing else. The pacing is the larger
 * hold and no constant here bounds it: it scales with the message count, so a body near the mirror
 * route's ceiling paces for minutes, and the thread's ordering chain is held for all of it, with
 * the operator's own queued prompt and every later post for that thread landing after the report
 * they follow. That order is the one a thread reads correctly in; what this cap keeps off the end
 * of it is an unbounded wait on a genuinely wedged bucket.
 */
export const MAX_RUN_WAIT_MS = 60_000;

/**
 * How long a rate-limited refusal that names no usable wait is sat out.
 *
 * Reached by a refusal carrying no `retryAfterMs` at all, one carrying a wait that has already
 * elapsed, and one carrying a value that is not a finite number: none of the three names a wait
 * this run can act on. Every reactive wait is therefore strictly positive, which is what makes the
 * cap above reachable in a finite number of retries rather than a bound on a loop that never
 * advances.
 */
const BLIND_RETRY_MS = 5_000;

/**
 * The shortest a rate-limited refusal is sat out, whatever wait it reported.
 *
 * A reported wait comes off the wire, and a sub-millisecond one is a request storm rather than a
 * pause: `setTimeout` floors at about a millisecond, so a run honoring such a wait literally would
 * fire roughly a thousand real posts a second at a bucket that has not moved, and the cap above
 * would take hundreds of millions of iterations to catch it. Discord's create bucket refills over
 * seconds, so a second is the shortest wait that can plausibly change the refusal's answer, and it
 * is what turns the cap into a bound on the number of attempts as well as on their duration.
 */
const MIN_REACTIVE_WAIT_MS = 1_000;

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
 * How many threads the narration coalescing maps hold entries for at once: the state map, the
 * invalidation clock, and the high-water mark alike.
 *
 * A state entry normally clears the moment anything newer lands in its thread, but a fleet of
 * threads all mid-turn holds one each with nothing arriving to clear them, and the clock and the
 * mark gain an entry for any thread a message lands in, so all three maps are capped the way the
 * drop log is. Past the cap the oldest entry is evicted, and what that costs the evicted thread
 * is at most one attribution header: the next chunk there posts fresh instead of appending. That
 * holds for the state map and the clock by construction, and for the high-water map because its
 * eviction bumps the evicted thread's clock, which its own comment explains.
 */
const MAX_NARRATION_THREADS = 64;

/**
 * The newest narration message in a thread, as this router last wrote it: the target of the next
 * chunk's edit, and the exact content that message holds on Discord, which is the precondition
 * `appendNarration` merges on. Held only while that message is believed the thread's newest, so
 * anything else landing in the thread drops the entry.
 */
type NarrationTail = { messageId: string; content: string };

/**
 * A Discord snowflake as a comparable number, or null when the string is not one.
 *
 * Snowflakes carry their creation time in the high bits, so numeric order is thread order, which
 * is what `noteThreadMessage` reads to tell the late echo of an older message from something
 * genuinely newer than the remembered narration message.
 */
function asSnowflake(id: string): bigint | null {
  return /^\d+$/.test(id) ? BigInt(id) : null;
}

/** Drops the oldest entry other than `kept` once `map` outgrows the cap these maps share. */
function capBeside<T>(map: Map<string, T>, kept: string): void {
  if (map.size <= MAX_NARRATION_THREADS) return;
  for (const key of map.keys()) {
    if (key === kept) continue;
    map.delete(key);
    break;
  }
}

/**
 * How the Claude Code harness opens the envelope it wraps a channel message in before injecting it
 * into the session as a user prompt.
 *
 * The harness's contract, not this project's: an external shape that can change without notice.
 * The two consumers of this marker fail in opposite directions when the harness's shape moves out
 * from under it. On the hook-carried mirror path, a mismatch costs the operator a duplicate of
 * their own message in the thread rather than anything unsafe. On the queued-prompt path the
 * transcript tailer's allowlist already admits only `origin.kind === "human"` lines, so a channel
 * injection never reaches this check there; its only reachable effect on that path is a false
 * positive, a prompt that opens with this marker for some other reason (for instance, one that
 * pastes text starting with it) being mistaken for an echoed channel message and dropped, costing
 * the operator their thread's only copy of a message they actually typed. The match is a plain
 * prefix rather than a parse either way.
 */
const CHANNEL_ENVELOPE = "<channel source=";

/**
 * Whether a prompt is the harness's injection of a message the operator posted in the thread this
 * post would land in. Mirrored, it shows the operator their own message a second time, attributed
 * to a console they were not sitting at.
 *
 * Read before the renderer's escapes touch the text, so what is tested is the string the harness
 * composed rather than a rewritten copy of it: escaping can neither hide the envelope from this nor
 * build one that was not there. The invisible class is stripped first, though, by the same rule the
 * renderer strips it, because a zero-width character in front of the envelope would otherwise hide
 * it from a prefix match while changing nothing the reader sees. Only the opening counts, so a
 * prompt that quotes the marker mid-text still mirrors.
 *
 * One reading for both paths a prompt reaches a thread by, the hook-carried mirror and the queued
 * prompt the transcript tailer extracts, so the two cannot answer differently for one message.
 */
function fromChannel(text: string): boolean {
  return withoutInvisible(text).trimStart().startsWith(CHANNEL_ENVELOPE);
}

/**
 * How the Claude Code harness opens the prompt it injects to wake an idle session when a
 * background task that session dispatched finishes. The injection carries the task's entire final
 * report, which the console renders compactly and the mirror would otherwise post whole, as an
 * operator-attributed block split across many messages.
 *
 * The harness's contract, not this project's, like the channel envelope above: an external shape
 * that can change without notice. The two failure directions are bounded the same way. A shape
 * move that stops this matching costs the thread the loud behavior the knob exists to compress, a
 * whole report mirrored as if typed; a false positive, a prompt the operator really typed that
 * opens with this literal, costs their words being compressed to the one-line notice, which the
 * `full` setting restores. The match is a plain prefix rather than a parse either way, and the
 * literal deliberately stops before the closing bracket: a harness revision that grows the tag an
 * attribute (`<task-notification id="...">`) would otherwise silently disable the compression,
 * which is the loud fail direction the knob exists to close, while what the missing bracket
 * admits is only a prompt opening with a longer tag name of this prefix, which nobody types.
 */
const TASK_NOTIFICATION = "<task-notification";

/**
 * Whether a prompt is the harness's wake-up injection for a finished background task.
 *
 * Read on the raw text before the renderer's escapes touch it, and through the same invisible
 * strip, on `fromChannel`'s reasoning exactly: escaping must be able to neither hide a match nor
 * manufacture one, and a zero-width character in front of the marker changes nothing a reader
 * sees, so it must not be what lets the whole report through. Only the opening counts, so a
 * prompt quoting the marker mid-text is the operator typing about it.
 *
 * One reading for both paths a prompt reaches a thread by, the hook-carried mirror and the queued
 * prompt the transcript tailer extracts, so the two cannot answer differently for one message.
 */
function isTaskNotification(text: string): boolean {
  return withoutInvisible(text).trimStart().startsWith(TASK_NOTIFICATION);
}

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
   * takes, and they are posted in order through the mirror writer, spaced so a long reply stays
   * under the thread's create bucket and a refusal earned anyway is waited out and the same
   * message posted again. A refusal the run cannot pass, one that is not rate limiting or one that
   * has exhausted the run's waiting cap, stops it: the rest are dropped and never retried, so the
   * thread shows a reply that ends early rather than a reply with an invisible hole in the middle,
   * and the count that landed is logged.
   */
  mirror: (
    processToken: string,
    kind: MirrorKind,
    text: string,
    sessionId: string | null,
  ) => Promise<ReplyResult>;
  /**
   * Posts one mid-turn chunk from the transcript tailer to the session's own thread.
   *
   * Addressed by session ID directly, through `threadFor`, rather than through `locate`: the
   * tailer holds a session ID and no process token, and which sessions it reads at all is
   * already gated by the registry's live set. Delivery goes through the same per-thread chain
   * the other paths use, so an interim chunk cannot land between the messages of a split reply.
   *
   * Consecutive chunks coalesce: while the newest message in the thread is the narration message
   * this path last wrote, a chunk that fits appends into it by edit, so a working stretch reads
   * as one growing block under one attribution rather than a header per sentence. A chunk that
   * will not fit, or one arriving after anything else landed in the thread, posts fresh through
   * the split path exactly as every chunk did before coalescing, and a refused edit falls back to
   * that same fresh post in the same call: the fail direction is always more messages, never
   * lost narration.
   */
  interim: (sessionId: string, text: string) => Promise<ReplyResult>;
  /**
   * Posts one queued mid-turn prompt from the transcript tailer to the session's own thread.
   *
   * A message typed at the console while the model is working is queued and injected without a
   * UserPromptSubmit ever firing, so it reaches this router off the transcript rather than off a
   * hook. Addressed by session ID through `threadFor`, exactly as `interim` is, and rendered
   * through the same `renderMirror("prompt", ...)` the hook-carried mirror renders through, so the
   * two are indistinguishable on the thread: the operator's words under the operator's
   * attribution, escaped by the one machinery that makes that attribution unforgeable, whether the
   * text arrived through a file read or through a hook. The channel-envelope check is the same one
   * for the same reason, because whichever line shape the harness records it under, the operator's
   * own channel message must not echo back into the thread it was typed in.
   *
   * The tailer also recovers the typed prompt that opens a turn, which the `UserPromptSubmit`
   * mirror normally posts first and loses outright when the harness times that hook out. So for
   * that shape alone, named by `source`, this path claims its own echo slot and consults the
   * mirror's, and whichever gets there first suppresses the other's exact repeat: the healthy case
   * reads as it always did, one copy under one attribution, and a lost hook costs a prompt arriving
   * a poll interval late rather than never. The queued shape neither claims nor consults, having
   * fired no hook and so having no second copy for either operation to answer for.
   *
   * Delivered through the thread's ordering chain, so the post takes its place among the messages
   * around it and ends any narration block being grown there: the operator's message is newer than
   * the narration above it, and the next chunk belongs below it.
   */
  interimPrompt: (
    sessionId: string,
    text: string,
    source: PromptSource,
    at: number | null,
  ) => Promise<ReplyResult>;
  /**
   * Posts one peer message the transcript tailer read, in either direction, to the session's own
   * thread.
   *
   * Addressed by session ID through `threadFor`, exactly as `interim` is, and delivered through the
   * thread's ordering chain, so a message takes its place among the lines around it and ends any
   * narration block being grown there: what follows a peer message posts fresh below it. Spent
   * against the mirror writer like every other conversation-carrying path here, never an alert-tier
   * one, and it pings nobody: an exchange between two sessions is worth reading rather than worth
   * waking someone for.
   *
   * The inbound half of this is also reached from the two prompt seams, which see a peer message
   * delivered to an idle session as prompt text; all three render through one mode dispatch.
   */
  peer: (sessionId: string, traffic: PeerTraffic) => Promise<ReplyResult>;
  /**
   * Records that a message landed in one of this broker's threads, as read off the gateway.
   *
   * This is the freshness signal narration coalescing rests on: a chunk appends into the
   * remembered narration message only while that message is the thread's newest. The state
   * clears only for an ID strictly newer than the remembered message by snowflake order (or one
   * the comparison cannot place, cleared conservatively): gateway echoes arrive late and out of
   * band, so the remembered message's own echo, and the echoes of everything older that it was
   * posted or grown above, announce nothing newer and must not end the block. Edits emit no
   * gateway message-create event, so an append never clears its own state.
   *
   * Every arrival with a parseable snowflake also raises the thread's high-water mark, the
   * newest message ID this router has seen land there, which is what an interim task consults
   * after a fresh post's round trip: the run is remembered only when nothing strictly newer
   * than its own final message arrived while its posts were on the wire, so the run's own echo,
   * which Discord routinely delivers before the REST response resolves, cannot forfeit the
   * state. An arrival whose ID does not parse bumps the ID-less invalidation clock instead,
   * refusing that remember conservatively, and so does every clear here.
   */
  noteThreadMessage: (threadId: string, messageId: string) => void;
  /**
   * Ends a thread's narration block without naming a message: the caller only knows its post
   * landed. For the writes that reach a thread outside this router, the notices and permission
   * alerts posted through the steering writer, whose only other clear is their own gateway echo,
   * and a dropped gateway loses echoes while REST keeps posting: without this, the block would
   * grow above a permission prompt for as long as chunks fit. Bumps the ID-less invalidation
   * clock, because a post this router cannot place by snowflake order landed, so a fresh
   * interim run mid-post is not remembered above the post.
   */
  endNarration: (threadId: string) => void;
};

export function createOutboundRouter(options: OutboundRouterOptions): OutboundRouter {
  const log = options.log ?? ((): void => {});
  // Brief when absent, matching the config knob's own default: a caller that says nothing gets
  // the compressed notice, and only an explicit `full` restores the whole-report mirror.
  const taskNotifications = options.taskNotifications ?? "brief";
  // Full when absent, matching the config knob's own default: a caller that says nothing gets the
  // whole message, because peer traffic is the content of an exchange rather than a notice about
  // one.
  const peerMessages = options.peerMessages ?? "full";
  const now = options.now ?? Date.now;
  const dropped = createDropLog(log, now);
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        // Unreferenced, so a pending gap is not something the process waits out before it can
        // exit: a shutdown mid-run drops the run's remainder rather than delaying the shutdown.
        setTimeout(resolve, ms).unref();
      }));

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

  // Per-thread ordering, held here because this router is the one place every conversation-carrying
  // path passes through: a mirrored prompt, a mirrored reply, a reply-tool post, and the transcript
  // tailer's two kinds, a narration chunk and a queued mid-turn prompt. The writer
  // orders nothing (it takes one message at a time and knows nothing about the next), and delivery
  // from the mirror intake is fire-and-forget, so nothing upstream orders one post against the
  // next either. Without this a turn's reply and the prompt that followed it race, and a reply
  // split across twenty messages interleaves with whatever else the session posts mid-run.
  //
  // Keyed by thread, never global: two sessions' threads post concurrently, as they must, since a
  // busy session would otherwise hold every other session's writes behind it.
  //
  // This is ordering, not queueing. A task waits only on the posts already on the wire for its own
  // thread; nothing is held for a thread that has none, and nothing is kept for a later call,
  // which is the rule the whole routing layer follows: a message that lands minutes late answers a
  // question the operator stopped asking. What a run does hold its own chain for is its pacing and
  // its rate-limit waits, which are one in-flight run finishing rather than anything queued behind
  // a call that already answered. Alerts and notices do not come through here, which is
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

  // The coalescing state: one entry per thread whose newest message is believed to be the
  // narration message this router last posted or edited there. Written only by the interim path,
  // and cleared by everything that puts something newer in the thread: `deliver` as its run goes
  // out, `noteThreadMessage` for what arrives over the gateway, and `endNarration` for the
  // notices and alerts that post outside this router.
  const narration = new Map<string, NarrationTail>();

  // The per-thread ID-less invalidation clock, for what snowflake order cannot judge. The
  // interim task takes its entry off the map for the whole of a fresh post's round trip, so an
  // invalidation landing in that window finds nothing to clear; the task refuses to remember its
  // run when the counter moved while its posts were on the wire. What bumps it: an
  // `endNarration`, an arrival whose ID does not parse, every clear of a held entry, and the
  // eviction of a thread's high-water mark, which is the same "something landed here that this
  // router can no longer place" answer in each case. An arrival that carries a parseable ID and
  // finds no held entry is judged by the high-water mark below instead, so the run's own gateway
  // echo does not count against it. Without the clock, a mid-post arrival this router cannot
  // place would sit under state that outlived it, and every later append would pile above it
  // until something cleared.
  const invalidations = new Map<string, number>();

  function bumpInvalidation(threadId: string): void {
    invalidations.set(threadId, (invalidations.get(threadId) ?? 0) + 1);
    capBeside(invalidations, threadId);
  }

  // The per-thread high-water mark: the newest message ID this router has seen land in the
  // thread, by snowflake order, whether it arrived over the gateway or came back as the id of
  // this router's own post. Raised monotonically and never lowered, because gateway echoes
  // arrive out of order and a late echo of an older message says nothing about what the thread's
  // newest is: overwritten blindly, the late echo of a run's first message would lower a mark a
  // newer foreign message set mid-round-trip, and the run would be remembered above it. Never
  // cleared either: snowflakes are monotonic in creation time, so every future post outranks
  // every mark already held.
  const highWater = new Map<string, bigint>();

  /**
   * Bounds the mark map at the cap its siblings hold, bumping the evicted thread's ID-less clock.
   *
   * `capBeside` alone would fail in the opposite direction from every other eviction here:
   * dropping a state or clock entry costs a thread one attribution header, while dropping a mark
   * makes the remember gate read the thread as having seen nothing newer, so a run posted around
   * a foreign arrival would be remembered above it, in the channel permission approvals are
   * answered in. The clock bump is what an evicted thread's in-flight interim task reads instead,
   * and it refuses that remember, so the fail direction stays the one every path here holds: one
   * fresh header, never narration above an arrival.
   */
  function capHighWater(kept: string): void {
    if (highWater.size <= MAX_NARRATION_THREADS) return;
    for (const key of highWater.keys()) {
      if (key === kept) continue;
      highWater.delete(key);
      bumpInvalidation(key);
      break;
    }
  }

  function raiseHighWater(threadId: string, arriving: bigint): void {
    const held = highWater.get(threadId);
    if (held !== undefined && arriving <= held) return;
    highWater.set(threadId, arriving);
    capHighWater(threadId);
  }

  function rememberNarration(threadId: string, tail: NarrationTail): void {
    narration.set(threadId, tail);
    // Unlike the drop log's sweep there is no window to wait out: evicting a live entry only
    // costs its thread one fresh header.
    capBeside(narration, threadId);
  }

  /**
   * Posts one rendered run of messages, in order, paced so the whole run lands.
   *
   * A run is spaced by `RUN_PACE_MS` between consecutive posts, and a post refused for rate
   * limiting waits out the refusal and goes again with the same message, under a per-run cap on
   * how long the waiting may total. Rate limiting is the one refusal class where nothing landed
   * and the same call will be accepted later, so a retry cannot double-post; every other refusal
   * stops the run where it got to, because the rest posted around a hole reads as text the author
   * never wrote and a route refusing the request itself refuses the next one identically. A run
   * that exhausts the cap stops the same way.
   *
   * One loop for every posting path on purpose: the landed count and the error wording are part
   * of what the callers log and report, and two copies would let those drift. Not chained here,
   * because the interim path runs it inside a chain task of its own, where taking a second place
   * on the same chain would deadlock; `deliver` below is the chained doorway everything else uses.
   * The thread's ordering chain is held for the whole of a paced run, which is the order a thread
   * reads correctly in: what a session posts after a report belongs below it.
   *
   * `lastMessageId` is the id of the run's final message, carried only when the whole run landed
   * and Discord's response yielded one: it is what the interim path remembers as the target of
   * the next chunk's edit, and a mid-run id would name a message with newer ones below it.
   */
  async function postRun(
    threadId: string,
    messages: string[],
  ): Promise<{ landed: number; error: string | null; lastMessageId: string | null }> {
    let landed = 0;
    let lastMessageId: string | null = null;
    let waited = 0;
    for (const message of messages) {
      // Between posts and never before the first, so a run of one message spends nothing. Taken
      // whether or not the previous message had to be waited out: a reactive wait is evidence the
      // bucket emptied, not a reason for the next post to skip the spacing that keeps it full.
      if (landed > 0) await sleep(RUN_PACE_MS);
      let outcome = await options.mirrorWriter.reply(threadId, message);
      while (outcome.status === "rate-limited") {
        const reported = outcome.rate.retryAfterMs;
        // A wait this run can act on is a finite positive number of milliseconds, floored so that
        // a refusal naming a sliver of one is a pause rather than a request storm. Anything else
        // is sat out blind. The finiteness reading is defense in depth rather than the only guard:
        // every producer of this field bounds it already, the transport where the wire's value
        // crosses into the process and the writer where its own refusal computes one. What it
        // covers is a producer added later, because a `NaN` reaching this loop is a wait that
        // passes the positive test, defeats the cap below (every comparison against it is false),
        // and sleeps for no time at all.
        const wait =
          reported !== null && Number.isFinite(reported) && reported > 0
            ? Math.max(reported, MIN_REACTIVE_WAIT_MS)
            : BLIND_RETRY_MS;
        // Stopping rather than waiting past the cap. The run reports the count it reached, which
        // is what the callers log, and the messages it did not reach are dropped.
        if (waited + wait > MAX_RUN_WAIT_MS) {
          return { landed, error: "rate limited", lastMessageId: null };
        }
        const before = now();
        await sleep(wait);
        // The greater of what the wait asked for and what it actually cost. The request alone
        // would bound how many retries a run takes and not how long they hold the thread's chain,
        // so a run whose waits overrun would sit past the cap; the elapsed time alone would
        // advance nothing against a clock that does not move. Both together bound both.
        waited += Math.max(now() - before, wait);
        outcome = await options.mirrorWriter.reply(threadId, message);
      }
      if (outcome.status !== "ok") {
        return { landed, error: outcome.error, lastMessageId: null };
      }
      landed += 1;
      lastMessageId = outcome.value.messageId;
    }
    return { landed, error: null, lastMessageId };
  }

  /**
   * Posts one rendered run as one task on the thread's chain, so nothing else this router posts
   * lands between the messages of one answer or one mirrored reply.
   *
   * A run through here is also what ends the thread's narration block, and the state clears
   * inside the chained task, at the moment the run actually goes on the wire, because that is
   * when these messages become newer than the remembered one. Cleared at hand-off instead, it
   * would act on a thread whose chain may still hold an older append that is entitled to go
   * first: that chunk would post a needless fresh header and re-remember a message this very run
   * is about to post below, which is exactly the stale state the clear exists to prevent. The
   * branches that post nothing, the mirror's echo drop above all, never come through here and
   * never clear.
   */
  async function deliver(
    threadId: string,
    messages: string[],
  ): Promise<{ landed: number; error: string | null }> {
    return inOrder(threadId, () => {
      narration.delete(threadId);
      return postRun(threadId, messages);
    });
  }

  /**
   * The one retry a run owes its text when it landed nothing and the other posting path had
   * already dropped its own copy over this run's claim.
   *
   * That combination is the only case where nothing else in the broker is still carrying the text:
   * the deferring path has answered its caller and will not look again, and on the tailer's side
   * the transcript bytes are already behind its offset, which it never rewinds. The ordinary
   * zero-landed run does not come through here, because the release hands the text back to a path
   * that still has it.
   *
   * One retry rather than a loop: what makes a retry worth anything here is a transport failure
   * shorter than the run that met it, and a second failure is evidence of something longer than
   * this run can outlast while it holds the thread's ordering chain. A run that lands even one
   * message keeps its claim on the ordinary rule, so the retry can only ever be the whole text or
   * nothing, never a second copy of messages the operator already has.
   *
   * Both outcomes are logged in their own words. This is a loss the ordinary partial-run line
   * cannot express, since that line reads identically for a run whose text another path is about
   * to carry, and the operator's only other signal is silence in the thread.
   */
  async function retryDeferredRun(
    threadId: string,
    sessionId: string,
    text: string,
    messages: string[],
    slot: EchoSlot,
    reclaim: () => void,
    subject: string,
    firstError: string,
  ): Promise<{ landed: number; error: string | null }> {
    // Re-claimed with no await between the release that reported the deferral and this line: the
    // other path consults the memory on its own schedule, and a gap here is that path posting its
    // own copy beside the retry below.
    reclaim();
    const retry = await deliver(threadId, messages);
    if (retry.landed > 0) {
      log(
        `routing: the ${subject} from session ${sessionId} landed nothing (${firstError}) with the ` +
          `other path already deferred to it; its one retry posted ${retry.landed} of ` +
          `${messages.length} messages`,
      );
      return retry;
    }
    options.echo?.release(sessionId, text, slot);
    log(
      `routing: the ${subject} from session ${sessionId} reached the thread by neither path: the ` +
        `run the other path deferred to landed nothing (${firstError}) and its one retry landed ` +
        `nothing (${retry.error ?? "nothing landed"})`,
    );
    return retry;
  }

  /**
   * Posts the one-line notice a recognized wake prompt compresses to under the `brief` setting,
   * shared by the two prompt paths so the notice and its logging cannot drift between them.
   *
   * Through the chained `deliver` doorway rather than a bare write: the notice takes its
   * thread-order place among the messages around it and ends any narration block being grown
   * there, exactly as the whole-report mirror it replaces would have. On a run error the line
   * carries the counts and the transport's error class only, the discipline every posting path
   * here holds: a wake prompt is conversation content, and it never appears in the broker log at
   * any level.
   */
  async function deliverTaskNotice(
    threadId: string,
    sessionId: string,
    text: string,
  ): Promise<ReplyResult> {
    const messages = [renderTaskNotice(text)];
    const run = await deliver(threadId, messages);
    if (run.error === null) return { status: "sent" };
    log(
      `routing: the task notice for session ${sessionId} stopped after ` +
        `${run.landed} of ${messages.length} messages: ${run.error}`,
    );
    return { status: "failed", error: run.error };
  }

  /**
   * The messages one peer message takes under the current setting, in the direction it was sent.
   *
   * The one mode dispatch, read by all three paths a peer message reaches a thread by, so a message
   * cannot be drawn whole on one and compressed on another. `off` never reaches here: it is
   * answered by the drop below, which posts nothing and says why.
   */
  function peerRun(traffic: PeerTraffic): string[] {
    switch (traffic.kind) {
      case "peer-in":
        return peerMessages === "brief"
          ? renderPeerInBrief(traffic.name, traffic.body)
          : renderPeerIn(traffic.name, traffic.body);
      case "peer-out":
        // `brief` draws the sender's own summary here where it wrote one, which is the compression
        // its author already made of its own message; the body's opening line is the fallback.
        return peerMessages === "brief"
          ? renderPeerOutBrief(traffic.to, traffic.summary, traffic.message)
          : renderPeerOut(traffic.to, traffic.message);
      default: {
        // The assignment is the check, the rule the tailer's own dispatch follows: a direction added
        // to the union without a case of its own stops being assignable to never, so the build fails
        // here. Without it a new kind would fall into the outbound arm and draw as a message this
        // session sent, which is this layer's one unforgivable error: claiming a session said
        // something it received.
        const unreachable: never = traffic;
        return unreachable;
      }
    }
  }

  /** Which direction a peer message went, for the log lines that name a drop without its text. */
  function peerSubject(traffic: PeerTraffic): string {
    return traffic.kind === "peer-in" ? "inbound peer message" : "outbound peer message";
  }

  /**
   * The prompt-echo claim a peer post carries when the text it draws also reaches this thread by the
   * other prompt path, which is the misread typed prompt: the operator's own words that the peer
   * classification reads as a delivery. That text takes the peer branch on both seams while both
   * seams still read it, so without a claim it posts twice.
   *
   * Keyed on the raw pre-render prompt text, never on the drawn body, because that is what the other
   * path claims and consults: the two seams see the same line and the renderer's extraction of a body
   * from it is one seam's own work.
   *
   * `settle` is the tailer's landing rule, which shrinks its own claim to the raced copy's grace; the
   * mirror's claim does not settle, because its consumer is a poll pass that can legitimately run the
   * whole claim window late. Null is the mirror's answer to that.
   */
  type PromptClaim = {
    slot: EchoSlot;
    text: string;
    claim: () => void;
    settle: (() => void) | null;
  };

  /**
   * Posts one peer message, in either direction, shared by the three paths one arrives on so their
   * rendering, their suppression, and their logging cannot drift apart.
   *
   * Through the chained `deliver` doorway rather than a bare write: the message takes its
   * thread-order place among the lines around it and ends any narration block being grown there,
   * because what a session says after an exchange belongs below it. On a run error, and on the
   * empty render, the line carries the direction, the session, and the transport's error class
   * only, the discipline every posting path here holds: a peer message is conversation content, and
   * it never appears in the broker log at any level.
   *
   * A `claim` is passed by the two prompt seams, whose text can also be on its way to this thread by
   * the other prompt path, and by nothing else: the tailer's own two kinds have no second copy
   * anywhere. It is spent only where a post is actually about to be attempted, which is why it is
   * taken here rather than at the seam that built it, and released where the run lands nothing.
   */
  async function deliverPeerMessage(
    threadId: string,
    sessionId: string,
    traffic: PeerTraffic,
    claim: PromptClaim | null = null,
  ): Promise<ReplyResult> {
    if (peerMessages === "off") {
      // The cause and the session, never the text: peer traffic suppressed on purpose reads on
      // every other surface exactly like a classification that broke, so this line is the
      // discriminator, and it names the knob that restores what it dropped.
      //
      // It is also the only trace of one thing this setting deletes. A prompt the operator really
      // typed that the peer classification reads as a delivery reaches here and is dropped from the
      // thread entirely, where under `full` and `brief` the same misreading costs only the
      // attribution. Suppressing it is still the better answer than falling through to the mirror:
      // that would draw whatever a peer wrote inside the operator's quoted register on exactly the
      // setting chosen to hear less from peers, and the register is the one thing this surface holds
      // unforgeable. So the inbound line says plainly that a prompt can be what it dropped.
      const misread =
        traffic.kind === "peer-in" ? "; a prompt read as peer traffic is dropped here too" : "";
      dropped(
        `the ${peerSubject(traffic)} for session ${sessionId} was dropped, ` +
          `CHANNEL_PEER_MESSAGES is off${misread}`,
      );
      return { status: "failed", error: "peer messages suppressed" };
    }

    const messages = peerRun(traffic);
    // Nothing visible once the invisible class is stripped. Logged, like the queued prompt's own
    // empty drop and unlike the interim path's: this is the thread's only copy of a message that
    // really was exchanged, and a message the operator never sees is worth a line.
    if (messages.length === 0) {
      dropped(
        `the ${peerSubject(traffic)} for session ${sessionId} was dropped, it carried no visible text`,
      );
      return { status: "failed", error: "the message was empty" };
    }

    // Claimed here, below the two branches that post nothing and as the run is dispatched, on the
    // prompt paths' own rule. A claim asserts that a run is putting this text on the thread right
    // now: made over the `off` drop or the empty render above, it would stand over a copy no path
    // ever posted and silence the other path's, and the operator's message would appear nowhere.
    // That is strictly worse than the duplicate the claim exists to prevent, and it is why the two
    // branches above return before this line rather than after it.
    claim?.claim();
    const run = await deliver(threadId, messages);
    if (run.error === null) {
      claim?.settle?.();
      return { status: "sent" };
    }

    // The release hands the text back to the other prompt path, the discipline the two prompt seams
    // hold over their own runs: a claim standing over a run that landed nothing would silence the
    // one copy still able to reach the thread. Its report says the other path had already dropped
    // its own copy over this claim, in which case nothing else is carrying the text and this run
    // goes again, once. Reached only where a claim was made, since a run that claimed nothing has
    // nothing to give up and no other path to give it back to.
    //
    // Gated on landing nothing at all, which is the rule the mirrored prompt holds and the trade it
    // carries: a run that landed some of its messages keeps its claim, so the other path stays
    // deferred and a split message that stopped partway shows the thread what landed and no more.
    // Releasing there would post the landed messages a second time, which is why the line is drawn
    // at nothing rather than at everything, and the stopped-after line above is what says so.
    if (
      claim !== null &&
      run.landed === 0 &&
      options.echo?.release(sessionId, claim.text, claim.slot) === true
    ) {
      const retry = await retryDeferredRun(
        threadId,
        sessionId,
        claim.text,
        messages,
        claim.slot,
        claim.claim,
        peerSubject(traffic),
        run.error,
      );
      if (retry.error === null) {
        claim.settle?.();
        return { status: "sent" };
      }
      return { status: "failed", error: retry.error };
    }

    log(
      `routing: the ${peerSubject(traffic)} for session ${sessionId} stopped after ` +
        `${run.landed} of ${messages.length} messages: ${run.error}`,
    );
    return { status: "failed", error: run.error };
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
      if (run.error === null) {
        // The raw pre-render text, recorded only now that the run landed whole, the same rule
        // the mirror's own record follows: an answer the transport refused is not in front of
        // the operator, and remembering it would suppress the Stop mirror carrying the turn's
        // only surviving copy. What this record buys is the mirror-side dedup below: a turn
        // that closes with the reply tool often ends with the same words, and the mirror
        // arriving seconds later says nothing the thread does not already show.
        options.echo?.noteAnswer(located.sessionId, text);
        return { status: "sent" };
      }

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

      // What a peer session sent this one while it was idle, read before anything renders: the
      // classification decides both the attribution below and the stamp on the next line, so it is
      // taken here where the ordering the stamp depends on is undisturbed. Only a prompt is
      // examined, on the envelope check's reasoning: a reply is Claude's own words about a delivery
      // rather than one.
      const delivery = kind === "prompt" ? crossSessionDelivery(text) : null;

      // A person is driving this session, which is the fact the engagement stamp records, so it is
      // stamped here rather than after delivery: whether the copy lands in the thread says nothing
      // about whether anyone spoke. Ahead of the envelope check below for the same reason, since a
      // message the harness injected from the channel is the operator answering from their phone,
      // and the drop there is about not echoing their words back at them.
      //
      // Two prompts are excluded, on one ground. A wake injection is the harness reporting a
      // finished background task, and a peer message is another session writing to this one: both
      // are machine-generated, and the gate this stamp clears is one that waits on a person, so a
      // standing blocked state must survive either. Excluded whatever `taskNotifications` and
      // `peerMessages` say, because those settings govern how the text is drawn in the thread and
      // not whether a human wrote it; if the woken turn genuinely resumes the run, its first
      // completed tool call stamps.
      //
      // Both exclusions rest on a reading of the harness's own text, so both fail in two directions
      // that are worth knowing here. A shape move that stops a recognizer matching restores the
      // stamp, and a machine-generated prompt clears a standing block again, silently. A false
      // positive withholds the stamp from words a person really typed, and the block they typed to
      // clear stands until their next completed tool call.
      // Taken here, above this path's own dedup consult, and still taken when that consult goes
      // on to suppress this copy: the stamp records that a person spoke, and a prompt suppressed
      // as the slower of two copies is the operator speaking all the same. The instant recorded
      // is this post's handling, not the keystroke: the hook fires as the operator presses
      // return, but its payload carries no instant of its own, and under the load this broker is
      // built to tolerate the handling runs late, which is the very case where the tailer's copy
      // wins and this one is suppressed. So the stamp can be newer than the words it stands for,
      // and a post handled late enough can land past a block the same turn went on to raise and
      // clear it, machine-timed, with no person behind the move. The transcript-read path stamps
      // below its consult and with the line's own instant instead, because its lateness is
      // structural, a poll interval on every prompt rather than a loaded broker's tail case.
      if (kind === "prompt" && delivery === null && !isTaskNotification(text)) {
        options.registry.engage(located.sessionId);
      }

      // The dedup against the transcript tailer, which reads this same text off the transcript up
      // to a poll interval from now. Matched on the normalized pre-render text, like the envelope
      // check below and for the same reason. A reply the tailer already posted as its last
      // interim chunk is reported as sent rather than failed, because the text is on the thread;
      // it just got there first by the other path. Its digest is still recorded on this branch,
      // for the same reason it is recorded after a successful post below: the text is genuinely
      // in front of the operator.
      if (kind === "reply" && options.echo !== undefined) {
        if (options.echo.isInterimEcho(located.sessionId, text)) {
          // This mirror is still the turn's end, so the answer record it did not need to
          // consult is spent below all the same.
          options.echo.clearAnswer(located.sessionId);
          options.echo.noteReply(located.sessionId, text);
          dropped(
            `the mirrored reply from session ${located.sessionId} was dropped, the tailer already ` +
              `posted the same text as interim narration`,
          );
          return { status: "sent" };
        }
        // The dedup against the reply tool, which posts mid-turn: by the time this mirror
        // arrives, a matching answer is already on the thread as the reply-tool message, so the
        // mirror is the suppressible copy. The match is exact or near (the mirror is frequently
        // a light rewording of the closing summary), and reported as sent for the same reason
        // the tailer's echo is: the text is in front of the operator, it just got there first
        // by the other path. The digest is still recorded so the tailer does not later read the
        // same text off the transcript and post it as narration.
        if (options.echo.isAnswerEcho(located.sessionId, text)) {
          options.echo.noteReply(located.sessionId, text);
          dropped(
            `the mirrored reply from session ${located.sessionId} was dropped, it matches the ` +
              `answer the reply tool already posted`,
          );
          return { status: "sent" };
        }
        // The reply-kind mirror is the turn boundary for the answer record, matched or not: the
        // reply tool always posts before the Stop mirror, so a record still standing here
        // belongs to a turn that is over and could only suppress a coincidental near-match in
        // some later turn.
        options.echo.clearAnswer(located.sessionId);
      }

      // A message the operator posted in this very thread, handed to the session as a prompt and on
      // its way back to where it was typed. Only a prompt is examined, because a reply is Claude's
      // own words about the envelope rather than one.
      if (kind === "prompt" && fromChannel(text)) {
        dropped(
          `the mirrored prompt from session ${located.sessionId} was dropped, it is the operator's ` +
            `own channel message echoed back to the thread it was posted in`,
        );
        return { status: "failed", error: "the message came from the channel" };
      }

      // A wake prompt: the harness's injection of a finished background task's report, not
      // something the operator typed. After the envelope check, because the envelope names what a
      // prompt is before this names what it carries, and only under a setting that changes
      // anything: `full` falls through and the report mirrors exactly as an ordinary prompt.
      if (kind === "prompt" && taskNotifications !== "full" && isTaskNotification(text)) {
        if (taskNotifications === "off") {
          // The cause and the session, never the text: a wake suppressed on purpose reads on
          // every other surface exactly like one that is broken, so this line is the discriminator.
          dropped(
            `the task notification waking session ${located.sessionId} was dropped, ` +
              `task notifications are off`,
          );
          return { status: "failed", error: "task notification suppressed" };
        }
        return deliverTaskNotice(located.threadId, located.sessionId, text);
      }

      // A peer message the harness delivered to this session while it was idle, which reaches this
      // path as prompt text because the `UserPromptSubmit` payload carries the prompt string alone.
      // It is drawn under the peer attribution rather than falling through to the mirror below,
      // which would put text a peer wrote inside the operator's quoted register, the one
      // attribution this surface holds unforgeable. A delivery whose body could not be read is
      // drawn the same way, carrying the placeholder body the classification returned: "not a
      // delivery" and "a delivery this broker could not read" are different answers, and collapsing
      // them would hand a peer the switch that puts its own words in that register.
      if (delivery !== null) {
        const received: PeerTraffic = {
          kind: "peer-in",
          name: delivery.name,
          body: delivery.body,
        };

        // The prompt dedup, taken on this branch as well as on the mirror below it, because one text
        // takes the peer branch on both prompt paths while both still read it: a turn-opening prompt
        // the operator really typed that this classification reads as a delivery. Without the pair
        // here that text posts once from this hook and once from the tailer's recovery, and the
        // operator sees their own message twice under a peer's attribution.
        //
        // A genuine idle delivery needs none of it, and pays only what every mirror claim costs.
        // The tailer is blind to the transcript line one lands on, so nothing ever writes its slot
        // for that text: the consult reads null, and the claim below answers a consult that never
        // comes and expires on the claim window. What it does leave is an unsettled claim standing
        // for that window, which the ordinary claim-window residual covers: text typed in the
        // window whose digest matches defers to it, and here that means the wrapper retyped
        // character for character while a real delivery of the same bytes is still claimed.
        //
        // The consult reads the tailer's slot, so a match means the tailer dispatched a
        // transcript-read copy of this text to this thread ahead of this hook. Reported sent on the
        // mirror's own rule: the text is in front of the operator, it just got there by the other
        // path. Nothing is recorded on this branch, because it posts nothing.
        if (options.echo?.isPromptEcho(located.sessionId, text, "mirror") === true) {
          dropped(
            `the ${peerSubject(received)} for session ${located.sessionId} was dropped, the tailer ` +
              `had already dispatched the same text to this thread, read off the transcript`,
          );
          return { status: "sent" };
        }

        return deliverPeerMessage(located.threadId, located.sessionId, received, {
          slot: "prompt-mirror",
          text,
          claim: () => options.echo?.notePrompt(located.sessionId, text, "mirror"),
          settle: null,
        });
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

      // The dedup against the tailer's own reading of the prompt that opened this turn, which it
      // recovers off the transcript whenever this hook is slow or lost. Consulted here rather than
      // beside the reply's check above, because everything between decided what this text is: a
      // channel echo, a wake notice, and a peer delivery are all dropped or redrawn before this
      // line, so the slot only ever answers for prompts drawn in the operator's own register, and
      // the tailer's copy of one went through the same gauntlet. Reported sent on the reply
      // branch's own rule: the text is in front of the operator, it just got there by the other
      // path.
      //
      // Nothing is recorded on this branch, unlike the reply echo above. A claim asserts that a run
      // is putting this text on the thread right now, and this branch is putting nothing on the
      // thread: a record made here would stand over a copy this path never posted and suppress the
      // operator's next retype of the same words.
      //
      // The line states what the slot makes knowable and no more. `promptTailer` is written only by
      // the tailer's own delivery seam, at dispatch, so a match here means the tailer dispatched a
      // transcript-read copy of this text to this thread ahead of this hook, inside the claim
      // window. Whether that dispatch landed is a separate question its own run answers, in its own
      // line if it landed nothing by either path.
      if (
        kind === "prompt" &&
        options.echo?.isPromptEcho(located.sessionId, text, "mirror") === true
      ) {
        dropped(
          `the mirrored prompt from session ${located.sessionId} was dropped, the tailer had ` +
            `already dispatched the same text to this thread, read off the transcript`,
        );
        return { status: "sent" };
      }

      // The digest is claimed here, as the run is dispatched, rather than after it lands. A long
      // reply posts as several paced messages, so a digest recorded on the way out would sit
      // seconds behind the check that needed it, and the tailer polling inside those seconds would
      // find a gap and post the same text as narration. Released below when the run lands nothing
      // at all, which is what keeps a reply the transport refused from appearing nowhere: the text
      // is then still owed to whichever path can post it. A prompt claims its own slot on the same
      // reasoning and against the same reader, and normally wins the race outright: this hook fires
      // within milliseconds of the operator pressing return, and the tailer's copy a poll behind.
      //
      // Named by kind rather than assumed, so a mirror kind added to the vocabulary without a slot
      // of its own claims nothing and costs a duplicate at worst, never a suppression it has no
      // record to answer for. The slot rides beside the claim so the release below gives up this
      // run's own record and never one another path is standing on.
      const claimed: { slot: EchoSlot; claim: () => void } | null =
        kind === "reply"
          ? { slot: "reply", claim: () => options.echo?.noteReply(located.sessionId, text) }
          : kind === "prompt"
            ? {
                slot: "prompt-mirror",
                claim: () => options.echo?.notePrompt(located.sessionId, text, "mirror"),
              }
            : null;
      claimed?.claim();
      const run = await deliver(located.threadId, messages);
      if (run.error === null) return { status: "sent" };
      if (claimed !== null && run.landed === 0) {
        // The release reports whether the tailer had already skipped its own copy of this text over
        // this claim. If it had, its transcript bytes are behind its offset and this run is the last
        // thing carrying the text, so it goes again once. The release itself matters even when
        // nothing deferred: a claim left standing over text that never landed is what would make
        // the tailer skip the only copy still recoverable.
        if (options.echo?.release(located.sessionId, text, claimed.slot) === true) {
          const retry = await retryDeferredRun(
            located.threadId,
            located.sessionId,
            text,
            messages,
            claimed.slot,
            () => claimed.claim(),
            `mirrored ${kind}`,
            run.error,
          );
          if (retry.error === null) return { status: "sent" };
          return { status: "failed", error: retry.error };
        }
      }

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

    async interim(sessionId, text) {
      const threadId = options.threadFor(sessionId);
      // Dropped, never queued, like every other post here: narration held for a thread that opens
      // later would land as an answer to a question the operator stopped asking.
      if (threadId === null) {
        dropped(
          `the interim narration from session ${sessionId} was dropped, its thread is not open yet`,
        );
        return { status: "no-thread" };
      }

      // The digest is claimed here, as the delivery is dispatched, rather than after it lands, and
      // released below when the run lands nothing at all. The window is the reason: this chunk can
      // be the turn's closing text, which posts as several paced messages and waits its turn on the
      // thread's chain before that, so a digest recorded on the way out would sit seconds behind
      // the check that needed it and the Stop mirror arriving inside those seconds would post the
      // same text a second time.
      options.echo?.noteInterim(sessionId, text);

      // The whole delivery is one task on the chain, the append decision included: the state is
      // consulted at the moment the write is about to go on the wire, never at call time, so an
      // invalidation that arrives while this chunk is queued behind a reply run is honored and
      // the chunk posts fresh below whatever cleared it.
      const run = await inOrder(
        threadId,
        async (): Promise<{ landed: number; total: number; error: string | null }> => {
          const tail = narration.get(threadId);
          if (tail !== undefined) {
            const merged = appendNarration(tail.content, text);
            if (merged !== null) {
              const outcome = await options.mirrorWriter.edit(threadId, tail.messageId, merged);
              if (outcome.status === "ok") {
                // Updated in place on the entry this task read, never re-inserted: an
                // invalidation that arrived while the edit was on the wire has already dropped
                // the entry, and a map write here would resurrect state for a message that is no
                // longer the thread's newest.
                tail.content = merged;
                return { landed: 1, total: 1, error: null };
              }
              // A refused edit is never retried, and the state clears before the fallback so
              // this chunk and every later one post fresh: the fail direction of coalescing is
              // always more messages, never lost narration. The line is the discriminator for a
              // systematically failing PATCH route, which otherwise looks exactly like coalescing
              // switched off; it carries the error class and never the text.
              dropped(
                `the narration append from session ${sessionId} was refused, the chunk posts ` +
                  `fresh: ${outcome.status === "rate-limited" ? "rate limited" : outcome.error}`,
              );
              narration.delete(threadId);
            }
          }

          const messages = renderMirror("interim", text);
          // Nothing visible once the invisible class is stripped. Nothing posts, nothing in the
          // thread changes, so whatever narration state is held stays valid.
          if (messages.length === 0) {
            return { landed: 0, total: 0, error: "the message was empty" };
          }

          // These posts are about to be newer than any remembered narration message: a chunk the
          // merge would not fit reaches this line with the state still held.
          narration.delete(threadId);
          // The entry is off the map for the whole round trip below, so anything landing while
          // the posts are on the wire has nothing to clear; the clock and the high-water mark
          // are how it reaches this task. The run is remembered only when the ID-less clock did
          // not move and nothing strictly newer than the run's own final message has landed, by
          // snowflake order: the run's own gateway echo, which Discord routinely delivers
          // before the REST response resolves, can never outrank the run's final message, so it
          // does not forfeit the state, while a foreign message genuinely created after it
          // always does. Refusing costs one header, while remembering would bury the mid-post
          // arrival, a permission prompt as easily as the operator's message, under every later
          // append.
          const clock = invalidations.get(threadId) ?? 0;
          const posted = await postRun(threadId, messages);
          // The mark read before this run's own posts raise it, so the comparison below is
          // against what landed from elsewhere rather than against the run itself.
          const mark = highWater.get(threadId);
          const own =
            posted.lastMessageId === null ? null : asSnowflake(posted.lastMessageId);
          // The run's own posts are messages that landed in this thread, so they raise the mark
          // like any gateway arrival: the echoes of these ids are still coming, and a thread
          // whose gateway echoes are lost would otherwise hold a mark that ages while REST keeps
          // posting under it.
          if (own !== null) raiseHighWater(threadId, own);
          // The new block to grow, remembered only when the whole run landed and Discord's body
          // yielded an id to edit by. The content is the exact string the writer was handed,
          // which is the precondition `appendNarration` merges on.
          if (
            posted.error === null &&
            posted.lastMessageId !== null &&
            (invalidations.get(threadId) ?? 0) === clock
          ) {
            // An absent mark means nothing judgeable has landed in the thread; a mark the run's
            // final message equals or outranks is the run's own echoes or something older. A
            // final message whose own ID does not parse cannot be judged against a held mark,
            // so it refuses conservatively: one header, never narration above an arrival.
            if (mark === undefined || (own !== null && mark <= own)) {
              rememberNarration(threadId, {
                messageId: posted.lastMessageId,
                content: messages[messages.length - 1],
              });
            }
          }
          return { landed: posted.landed, total: messages.length, error: posted.error };
        },
      );
      if (run.error === null) return { status: "sent" };
      // The release reports whether the Stop mirror had already dropped its own copy of this text
      // over this claim. If it had, the mirror has answered its caller and this run is the last
      // thing carrying the text, so it goes again once, posting fresh: the block this chunk might
      // have grown is gone either way, and the fail direction of coalescing is more messages rather
      // than lost narration. A chunk that rendered to nothing is excluded by the count below, since
      // there is nothing to post a second time.
      const deferred =
        run.landed === 0 && options.echo?.release(sessionId, text, "interim") === true;
      if (deferred && run.total > 0) {
        const retry = await retryDeferredRun(
          threadId,
          sessionId,
          text,
          renderMirror("interim", text),
          "interim",
          () => options.echo?.noteInterim(sessionId, text),
          "interim narration",
          run.error,
        );
        if (retry.error === null) return { status: "sent" };
        return { status: "failed", error: retry.error };
      }
      // A chunk with nothing visible in it posted nothing. The tailer's next chunk narrates
      // whatever this one did not, so the drop is reported to the caller and not logged.
      if (run.total === 0) return { status: "failed", error: run.error };

      // The counts and the transport's error class only: transcript content is conversation
      // content, and it never appears in the broker log at any level.
      log(
        `routing: the interim narration from session ${sessionId} stopped after ` +
          `${run.landed} of ${run.total} messages: ${run.error}`,
      );
      return { status: "failed", error: run.error };
    },

    async interimPrompt(sessionId, text, source, at) {
      const threadId = options.threadFor(sessionId);
      // Dropped, never queued, like every other post here, and the line carries the cause and the
      // session and never the text: a prompt that never lands is silence in the thread, which reads
      // exactly like a session nobody typed at.
      //
      // "Transcript-read" rather than "queued" throughout this path's lines, because two shapes
      // arrive here and an operator reading one of them has to know which was lost: the mid-turn
      // message the harness queues without firing a hook, and the turn-opening prompt recovered
      // after the hook was lost. Both are prompts this router read off the transcript, and neither
      // is described by the other's name.
      if (threadId === null) {
        dropped(
          `the transcript-read prompt from session ${sessionId} was dropped, its thread is not ` +
            `open yet`,
        );
        return { status: "no-thread" };
      }

      // The same peer classification the mirror path takes, held in one reading so the two paths
      // cannot answer differently about one message. The tailer's own line gates admit a prompt
      // only where the harness marked it typed at the console, so what this catches here is a shape
      // those gates ever came to admit rather than anything observed today; the reading costs one
      // prefix test and the failure it forecloses is a peer's text in the operator's register.
      const delivery = crossSessionDelivery(text);

      // The queued shape's engagement stamp, on the mirror path's reasoning exactly: a person is
      // driving, and neither the envelope check below nor the delivery after it changes that, while
      // the harness's wake injection and a peer session's message are not a person and are excluded
      // on both paths under every notification and peer setting, in both failure directions the
      // mirror path's own comment names: a recognizer that stops matching restores the stamp for
      // machine-generated text, and one that matches too much withholds it from a person. A session
      // whose thread is not open yet is dropped whole above and stamps nothing, which costs one
      // prompt's worth of engagement at the start of a session's life.
      //
      // Here, ahead of everything, because a queued message consults nothing: it has no second copy
      // anywhere, so every one of them is words a person just typed and no later branch can find
      // them already accounted for. The turn-opening shape stamps further down, where that question
      // has been asked.
      if (source === "queued" && delivery === null && !isTaskNotification(text)) {
        options.registry.engage(sessionId, at ?? undefined);
      }

      if (fromChannel(text)) {
        dropped(
          `the transcript-read prompt from session ${sessionId} was dropped, it is the ` +
            `operator's own channel message echoed back to the thread it was posted in`,
        );
        return { status: "failed", error: "the message came from the channel" };
      }

      // The same wake-prompt treatment the hook-carried mirror applies, after the same envelope
      // check, because whichever line shape the harness records the injection under, one wake
      // prompt must get one answer: the notice under `brief`, silence under `off`, and under
      // `full` the fall-through to the whole-report mirror below.
      if (taskNotifications !== "full" && isTaskNotification(text)) {
        if (taskNotifications === "off") {
          // The cause and the session, never the text, matching the mirror path's own line.
          dropped(
            `the task notification waking session ${sessionId} was dropped, ` +
              `task notifications are off`,
          );
          return { status: "failed", error: "task notification suppressed" };
        }
        return deliverTaskNotice(threadId, sessionId, text);
      }

      // A peer message, drawn under the peer attribution for the reason the mirror path draws one
      // there: whichever line shape a delivery arrives in, text a peer wrote never renders in the
      // operator's quoted register, and an unreadable delivery renders there least of all.
      if (delivery !== null) {
        const received: PeerTraffic = {
          kind: "peer-in",
          name: delivery.name,
          body: delivery.body,
        };

        // The prompt dedup, in the mirror seam's own position on its own branch and for its reason:
        // the one text that takes the peer branch on both paths is a turn-opening prompt the
        // operator typed and this classification misread, and it is carried by both.
        //
        // The turn-opening shape alone, the rule the mirror below this holds. A queued mid-turn
        // message fires no hook, so nothing else is carrying it, and a genuine mid-turn delivery
        // does not arrive here at all: the tailer reads that shape as its own peer item and hands it
        // over whole. A consult here for the queued shape could only drop the operator's words
        // against a claim some earlier prompt of the same text left, and a claim could only swallow
        // the next one.
        if (
          source === "turn-open" &&
          options.echo?.isPromptEcho(sessionId, text, "tailer") === true
        ) {
          dropped(
            `the ${peerSubject(received)} for session ${sessionId} was dropped, the mirror hook ` +
              `had already dispatched the same text to this thread`,
          );
          return { status: "sent" };
        }

        return deliverPeerMessage(
          threadId,
          sessionId,
          received,
          source === "turn-open"
            ? {
                slot: "prompt-tailer",
                text,
                claim: () => options.echo?.notePrompt(sessionId, text, "tailer"),
                settle: () => options.echo?.settlePrompt(sessionId, text, "tailer"),
              }
            : null,
        );
      }

      const messages = renderMirror("prompt", text);
      // Nothing visible once the invisible class is stripped. Logged, unlike the interim path's
      // own empty drop: a chunk of narration that carried nothing is answered by the next chunk,
      // while this is the operator's only copy of a message they typed, so its absence from the
      // thread is worth a line.
      if (messages.length === 0) {
        dropped(
          `the transcript-read prompt from session ${sessionId} was dropped, it carried no ` +
            `visible text`,
        );
        return { status: "failed", error: "the message was empty" };
      }

      // The dedup against the `UserPromptSubmit` mirror, which carries the prompt that opens a turn
      // and which this path recovers off the transcript when that hook was slow or timed out. In
      // the mirror path's own position, after every check that decides what this text is, so the
      // two paths meet the pair having answered the same questions of it. Reported sent: the
      // operator is looking at their words already, sent by the faster path, which under a healthy
      // broker is the hook.
      //
      // The turn-opening shape alone, because it is the only one that exists twice. A queued
      // mid-turn message fires no hook, so nothing else is carrying it, and a consult here could
      // only drop the operator's words against a claim the mirror left over some earlier prompt of
      // the same text.
      //
      // The slot read is the mirror's, never this path's own, so the line states which path
      // dispatched the surviving copy rather than which path usually does, and two identical
      // prompts read off the transcript in one turn both post. `promptMirror` is written only by
      // the mirror seam, at dispatch, and refused once older than the claim window, so a match here
      // means the hook dispatched this text to this thread within that window and ahead of this
      // read.
      //
      // Nothing is recorded on this branch, the mirror branch's rule and for its reason: a claim
      // asserts a run is putting this text on the thread now, and this branch posts nothing, so a
      // record here would stand over a copy this path never sent.
      if (source === "turn-open" && options.echo?.isPromptEcho(sessionId, text, "tailer") === true) {
        dropped(
          `the transcript-read prompt from session ${sessionId} was dropped, the mirror hook had ` +
            `already dispatched the same text to this thread`,
        );
        return { status: "sent" };
      }

      // The turn-opening shape's engagement stamp, below the consult above rather than beside the
      // queued one. A turn-opening prompt reaches the registry by the hook as well, which stamps at
      // the instant the operator pressed return, and this read of the same line lands up to a poll
      // interval later. Stamping again for a prompt the hook already accounted for moves
      // `lastEngagementAt` forward in time with no person behind the move, and the blocked
      // derivation reads exactly that field against the latest `goal-blocked` event: a session that
      // stopped blocked inside the interval would be cleared by this path and render as idle. So
      // the stamp is taken only where nothing was suppressed, which is the copy that is the
      // operator's only one.
      //
      // The wake test is still live here, because `full` mirrors a wake as an ordinary prompt and
      // falls through to this line; a peer delivery cannot reach it, having been redrawn and
      // returned above under its own attribution.
      //
      // The cost of the position: a turn-opening prompt that is the operator's own channel message
      // echoed back, or one that renders to nothing, is refused above this line and stamps nothing
      // on this path. It is the intersection of a lost hook with a prompt that was never going to
      // post, and it costs one stamp that the operator's next completed tool call replaces.
      // `delivery === null` is redundant against the peer branch above, which returns on every one
      // of its paths, and it is written anyway so the exclusion is readable here rather than only
      // inferable from control flow several screens up. A peer prompt clearing a block that waits
      // on a person is the failure this guards, and an edit that reordered the branch would
      // otherwise re-arm it silently.
      if (source === "turn-open" && delivery === null && !isTaskNotification(text)) {
        options.registry.engage(sessionId, at ?? undefined);
      }

      // Claimed as the run is dispatched rather than after it lands, the interim chunk's own
      // arrangement: a prompt long enough to split posts as several paced messages behind whatever
      // holds the thread's chain, and a mirror hook arriving inside that window would find a gap
      // and post the operator's words a second time. Released below when the run lands nothing.
      //
      // The turn-opening shape alone, on the consult's reasoning: a claim over a queued message
      // answers no copy this broker will ever see, and the only thing it could do is swallow a
      // later turn-opening prompt carrying the same words.
      const claiming = source === "turn-open";
      if (claiming) options.echo?.notePrompt(sessionId, text, "tailer");

      // Through the chained doorway, which clears the thread's narration state as the run goes on
      // the wire: what follows the operator's message posts fresh below it rather than growing the
      // block above it.
      const run = await deliver(threadId, messages);
      if (run.error === null) {
        // The claim's remaining life shrinks to the raced copy's grace once the run lands. The
        // only consult a landed run's claim still answers is the mirror post of this same prompt,
        // already in flight since the keystroke; in the lost-hook case the recovery exists for, no
        // consult ever comes, and a claim standing the whole claim window past the landing would
        // suppress the operator's next retype of these words on the mirror path. The mirror's own
        // claim never settles, because its consumer is a poll pass that can legitimately run the
        // whole window late.
        if (claiming) options.echo?.settlePrompt(sessionId, text, "tailer");
        return { status: "sent" };
      }

      // The release hands the text back to the mirror path, which is the failure direction this
      // whole pair is built around: a claim standing over a prompt that never landed would silence
      // the one copy still able to reach the thread. Its report says the mirror had already dropped
      // its own copy over this claim, in which case nothing else is carrying the operator's words
      // and this run goes again, once. Reached only where a claim was made, since a run that
      // claimed nothing has nothing to give up and no other path to give it back to.
      if (
        claiming &&
        run.landed === 0 &&
        options.echo?.release(sessionId, text, "prompt-tailer") === true
      ) {
        const retry = await retryDeferredRun(
          threadId,
          sessionId,
          text,
          messages,
          "prompt-tailer",
          () => options.echo?.notePrompt(sessionId, text, "tailer"),
          "transcript-read prompt",
          run.error,
        );
        if (retry.error === null) {
          // The retry's reclaimed record settles on the same rule as the first-run success above.
          options.echo?.settlePrompt(sessionId, text, "tailer");
          return { status: "sent" };
        }
        return { status: "failed", error: retry.error };
      }

      // The counts and the transport's error class only: a prompt is conversation content, and it
      // never appears in the broker log at any level.
      log(
        `routing: the transcript-read prompt from session ${sessionId} stopped after ` +
          `${run.landed} of ${messages.length} messages: ${run.error}`,
      );
      return { status: "failed", error: run.error };
    },

    async peer(sessionId, traffic) {
      const threadId = options.threadFor(sessionId);
      // Dropped, never queued, like every other post here, and the line carries the direction and
      // the session and never the text: an exchange missing from a thread reads exactly like a
      // session that held none.
      if (threadId === null) {
        dropped(
          `the ${peerSubject(traffic)} for session ${sessionId} was dropped, its thread is not ` +
            `open yet`,
        );
        return { status: "no-thread" };
      }
      return deliverPeerMessage(threadId, sessionId, traffic);
    },

    noteThreadMessage(threadId, messageId) {
      const arriving = asSnowflake(messageId);
      // Every judgeable arrival raises the thread's high-water mark, whatever else it means
      // below: the mark is what the interim task's remember gate reads after a fresh post's
      // round trip, and raising it costs nothing when the arrival is only the run's own echo,
      // because the gate compares by snowflake order rather than by whether anything arrived.
      if (arriving !== null) raiseHighWater(threadId, arriving);
      const tail = narration.get(threadId);
      // No entry to compare against. The reachable case that matters is an interim task holding
      // its entry off the map for a fresh post's round trip: the mark above is how a judgeable
      // arrival reaches that task, which remembers its run only when nothing strictly newer
      // than its own final message landed, and the clock bump is how an unjudgeable one refuses
      // the same remember conservatively.
      if (tail === undefined) {
        if (arriving === null) bumpInvalidation(threadId);
        return;
      }
      // The remembered message's own echo: every post this broker makes comes back over the
      // gateway, and the narration message announcing itself is not something newer than itself.
      if (tail.messageId === messageId) return;
      const remembered = asSnowflake(tail.messageId);
      // The late echo of an older message: a split run's earlier messages, or a reply run's
      // echoes arriving after a later narration message was remembered. The remembered message
      // is still the thread's newest, so neither the state nor the clock moves; clearing here
      // would silently end coalescing after every split run for as long as the gateway lags.
      if (arriving !== null && remembered !== null && arriving <= remembered) return;
      // Strictly newer, or an ID the comparison cannot place, which clears conservatively: a
      // wrongly ended block costs one header, a wrongly kept one appends above the arrival.
      narration.delete(threadId);
      bumpInvalidation(threadId);
    },

    endNarration(threadId) {
      narration.delete(threadId);
      bumpInvalidation(threadId);
    },
  };
}
