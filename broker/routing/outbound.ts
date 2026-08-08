// Session to Discord: a `reply` tool call becomes a message in that session's own thread.
//
// The routing is by **session**, never by the `chat_id` Claude passed. A chat_id that arrived on an
// inbound event is advisory: it is the thread the last message came from, which is not necessarily
// the thread this session owns now, and Claude may reply having received no event at all. Routing
// by session is what makes an unprompted reply land correctly, and it is also what stops a reply
// from being addressable: the relay never forwards a chat_id, so there is nothing here to honor.
import { appendNarration, renderAnswer, renderMirror } from "../discord/render.ts";
import type { MirrorKind } from "../discord/render.ts";
import { withoutInvisible } from "../sanitize.ts";
import type { Registry } from "../registry.ts";
import type { EchoMemory } from "../tail.ts";
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
   * The dedup memory, present whenever the Stop mirror is on; the transcript tailer shares it
   * and additionally requires interim mirroring to exist at all, so on a mirror-only host the
   * memory serves the reply-tool dedup alone. The tailer reads the turn's final reply off the
   * transcript up to a poll interval after
   * the Stop mirror posts it, so the two paths consult one memory: `mirror` with the reply kind
   * skips a post matching the tailer's last interim chunk, records its own digest once the text
   * is on the thread (by this post or by the tailer's), and the tailer skips a chunk matching
   * either digest. A match consumes the digest it matched, so nothing here becomes a standing
   * blocklist. The memory also carries the reply-tool dedup: `reply` records the answer it
   * posted, and `mirror` with the reply kind skips a post matching it exactly or nearly, because
   * a long turn's closing reply-tool summary and its Stop mirror are frequently the same words.
   * Without the memory, replies mirror exactly as they did before interim mirroring existed.
   */
  echo?: EchoMemory;
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
   * Delivered through the thread's ordering chain, so the post takes its place among the messages
   * around it and ends any narration block being grown there: the operator's message is newer than
   * the narration above it, and the next chunk belongs below it.
   */
  interimPrompt: (sessionId: string, text: string) => Promise<ReplyResult>;
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
   * Posts one rendered run of messages, in order. A post refused part way through stops the run:
   * the rest posted around a hole reads as text the author never wrote, and the transport that
   * refused one message refuses the next for the same reason.
   *
   * One loop for every posting path on purpose: the landed count and the error wording are part
   * of what the callers log and report, and two copies would let those drift. Not chained here,
   * because the interim path runs it inside a chain task of its own, where taking a second place
   * on the same chain would deadlock; `deliver` below is the chained doorway everything else uses.
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
    for (const message of messages) {
      const outcome = await options.mirrorWriter.reply(threadId, message);
      if (outcome.status !== "ok") {
        return {
          landed,
          error: outcome.status === "rate-limited" ? "rate limited" : outcome.error,
          lastMessageId: null,
        };
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
      if (run.error === null) {
        // Recorded only now that the run posted whole, matching the tailer's own record-on-sent
        // rule. Recorded before delivery, a reply the transport refused would still poison the
        // memory, the tailer's next pass would skip the same text off the transcript, and the
        // reply would appear nowhere at all.
        if (kind === "reply") options.echo?.noteReply(located.sessionId, text);
        return { status: "sent" };
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

    async interimPrompt(sessionId, text) {
      const threadId = options.threadFor(sessionId);
      // Dropped, never queued, like every other post here, and the line carries the cause and the
      // session and never the text: a queued prompt that never lands is silence in the thread,
      // which reads exactly like a session nobody typed at.
      if (threadId === null) {
        dropped(
          `the queued prompt from session ${sessionId} was dropped, its thread is not open yet`,
        );
        return { status: "no-thread" };
      }

      if (fromChannel(text)) {
        dropped(
          `the queued prompt from session ${sessionId} was dropped, it is the operator's own ` +
            `channel message echoed back to the thread it was posted in`,
        );
        return { status: "failed", error: "the message came from the channel" };
      }

      const messages = renderMirror("prompt", text);
      // Nothing visible once the invisible class is stripped. Logged, unlike the interim path's
      // own empty drop: a chunk of narration that carried nothing is answered by the next chunk,
      // while this is the operator's only copy of a message they typed, so its absence from the
      // thread is worth a line.
      if (messages.length === 0) {
        dropped(
          `the queued prompt from session ${sessionId} was dropped, it carried no visible text`,
        );
        return { status: "failed", error: "the message was empty" };
      }

      // Through the chained doorway, which clears the thread's narration state as the run goes on
      // the wire: what follows the operator's message posts fresh below it rather than growing the
      // block above it.
      const run = await deliver(threadId, messages);
      if (run.error === null) return { status: "sent" };

      // The counts and the transport's error class only: a queued prompt is conversation content,
      // and it never appears in the broker log at any level.
      log(
        `routing: the queued prompt from session ${sessionId} stopped after ` +
          `${run.landed} of ${messages.length} messages: ${run.error}`,
      );
      return { status: "failed", error: run.error };
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
