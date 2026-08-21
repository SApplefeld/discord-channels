// The blocked-state desk: the session surface's half of the kit's goal event stream.
//
// It holds the session fold's reader state, advances it once per Discord refresh pass, and answers
// two questions from what the fold keeps. Whether a session *stands* blocked, which is what the
// card and the thread title render, is the standing computation: the latest kept goal event is a
// `goal-blocked` newer than the session's last engagement. Whether a block *episode* gets its one
// pinging alert is a different question with a different key: the episode is the event itself, so a
// mid-queue block whose engagement already cleared the rendered state still pings once, and the
// standing computation gates only the drawn state, never the ping.
//
// The desk exists whenever Discord does, independent of whether the board card is on: the two folds
// of the stream hold independent offsets in `broker/board/events.ts`, so neither surface starves
// the other. The feed is lower-privilege than the broker's token-gated surfaces (append access to
// the operator's home directory, no process token), which is why every log line here names a cause
// and a session id and never the plan text the events carry.
import {
  MAX_TRACKED_SESSIONS,
  initialSessionEventState,
  readSessionEvents,
} from "../board/events.ts";
import type { ReadSessionEventsResult, SessionEventReaderState } from "../board/events.ts";
import type { SessionRecord } from "../registry.ts";
import {
  ALERT_WINDOW_MS,
  MAX_QUESTION_ALERTS_PER_WINDOW,
  MAX_QUESTION_PINGS_PER_WINDOW,
  createAlertVolume,
} from "../security/permission.ts";
import { renderBlockedAlert } from "./render.ts";
import type { CallOutcome } from "./transport.ts";

/**
 * How recent a `goal-blocked` event has to be for its alert to be posted at all, measured from the
 * event's clamped instant to the observing tick.
 *
 * Episode identity is the event, not the rendered state: a mid-queue block that never renders
 * blocked (the queue moved on and the next tool call cleared the standing marker) still pings once,
 * because the run did stop on the operator and the ping is the fast channel that says so. What the
 * bound refuses is the backlog: a broker restart re-reads the stream from the top, and a block
 * replayed from it pings only while it is still recent enough to be news. An older one is the `⛔`
 * title alone.
 */
export const BLOCKED_PING_FRESH_MS = 10 * 60 * 1000;

/**
 * The most posted episode keys the desk remembers, the oldest recorded evicted to make room, the
 * way the narration maps bound theirs.
 *
 * Episode instants come from another program's file, so without a ceiling the set grows for as long
 * as the broker runs. Twice the session fold's own ceiling, because the fold holds at most
 * `MAX_TRACKED_SESSIONS` live episodes at once: at this size an eviction can only reach a key whose
 * episode has itself long been superseded or evicted from the fold, and the cost of one that has
 * not is a session's block episode pinging a second time.
 */
export const MAX_POSTED_BLOCK_KEYS = 2 * MAX_TRACKED_SESSIONS;

/**
 * The posted-key for one block episode: the session id and the event's clamped instant.
 *
 * The instant, never the raw `ts` string: `Date.parse` accepts unlimited spellings of one instant,
 * so a dedup keyed on the raw stamp would hand the key to whatever writes the file, and one block
 * respelled per line would ping once per spelling. The separator is a NUL because a session id is
 * free-form text from another program's file, and any separator it could contain would let two
 * different episodes produce one key.
 */
function episodeKey(sessionId: string, tsMs: number): string {
  return `${sessionId}\u0000${String(tsMs)}`;
}

export type BlockedDeskOptions = {
  /** The resolved path of the kit's goal event stream, the same path the board fold reads. */
  eventsPath: string;
  /** The session's thread, or null while it has none, in which case the episode retries next tick. */
  threadFor: (sessionId: string) => string | null;
  /**
   * The steering writer's alert tier: the phone-reaching write, which also ends the thread's
   * narration block on a successful post. A null mention posts the same text quietly.
   */
  alert: (
    threadId: string,
    text: string,
    mentionUserId: string | null,
  ) => Promise<CallOutcome<{ messageId: string | null }>>;
  /** The operator the ping tier mentions. */
  operatorId: string;
  now?: () => number;
  /**
   * The fold's read, one tick's worth. Injected so a test drives the kept state without a real
   * file, mirroring the board card's `readEvents` seam; production reads the configured path.
   */
  readEvents?: (previous: SessionEventReaderState) => ReadSessionEventsResult;
  log: (message: string) => void;
};

export type BlockedDesk = {
  /**
   * Advances the session fold by one tick and posts the alerts the new state owes. The fold and
   * every gate ahead of a post run synchronously inside the call, so views built after it return
   * read this tick's events; the returned promise carries only the posts already on the wire and
   * never rejects, so a caller can fold it into the pass it drains at shutdown.
   */
  tick: () => Promise<void>;
  /**
   * Whether the session stands blocked: its latest kept goal event is a `goal-blocked` newer than
   * its last engagement. The one computation both `toView` call sites read, so the fleet card and
   * the thread cannot disagree; a `goal-complete`, or an engagement newer than the block, clears it.
   */
  standing: (session: Pick<SessionRecord, "sessionId" | "lastEngagementAt">) => boolean;
};

export function createBlockedDesk(options: BlockedDeskOptions): BlockedDesk {
  const now = options.now ?? Date.now;
  const read =
    options.readEvents ??
    ((previous: SessionEventReaderState): ReadSessionEventsResult =>
      readSessionEvents(previous, { path: options.eventsPath, now }));
  let state = initialSessionEventState();
  // One line per outage rather than one per tick: the flag arms on the first unreadable read and
  // holds until a read succeeds again, so a standing failure costs the log a single line and a new
  // outage after a recovery is the news it is.
  let unreadableReported = false;
  /**
   * Episodes whose alert landed, insertion-ordered so eviction drops the oldest recorded first. An
   * episode's key is added when its post goes on the wire, so a tick arriving while the post is
   * still in flight cannot double it, and removed again when the post did not land, so the fold
   * retries the episode on its next tick for as long as the block stays fresh. Nothing is queued:
   * the retry is the standing fold walking its own kept state.
   */
  const posted = new Set<string>();
  // Its own window instance, never the question alert's or the permission desk's: shared stamps
  // would let a run of one class spend another's slots and push it into drop, the starvation the
  // damping exists to prevent. The ceilings are the question alert's, because the two are the same
  // class of write: a mention-bearing alert for a session waiting on a person.
  const volume = createAlertVolume({
    now,
    pingCeiling: MAX_QUESTION_PINGS_PER_WINDOW,
    postCeiling: MAX_QUESTION_ALERTS_PER_WINDOW,
    windowMs: ALERT_WINDOW_MS,
  });

  /**
   * Episodes whose trouble has already been logged, so a stuck episode costs the log one line
   * rather than one per tick for the length of the freshness window. Every failure class of one
   * episode shares the entry: the first line names the cause, and the retries behind it are the
   * ping pass's ordinary walk, not news. Bounded like `posted`, and an evicted key's cost is the
   * mirror of its sibling's: one repeated line, never a lost one.
   */
  const reported = new Set<string>();

  /** Adds a key to one of the bounded sets, evicting the oldest other key past the ceiling. */
  function remember(held: Set<string>, key: string): void {
    held.add(key);
    if (held.size <= MAX_POSTED_BLOCK_KEYS) return;
    for (const oldest of held) {
      if (oldest === key) continue;
      held.delete(oldest);
      break;
    }
  }

  /** Logs an episode's first trouble line and swallows the repeats the retrying tick would emit. */
  function reportOnce(key: string, message: string): void {
    if (reported.has(key)) return;
    remember(reported, key);
    options.log(message);
  }

  /**
   * One episode's post, fire-and-forget like every write off a timer pass: a ping that could not
   * be posted costs an alert the operator reads as the `⛔` title instead. The log lines carry the
   * cause and the session id only, never the plan text the alert renders: the plan is kit-shaped
   * on the honest path, but the feed is writable by anything with append access to the operator's
   * home directory, and the log discipline here is uniform.
   */
  async function deliver(sessionId: string, threadId: string, key: string, plan: string): Promise<void> {
    const level = volume(threadId);
    if (level === "drop") {
      reportOnce(
        key,
        `broker: session ${sessionId}'s blocked alert is over its window; the message is dropped`,
      );
      return;
    }
    const mention = level === "ping" ? options.operatorId : null;
    remember(posted, key);
    try {
      const outcome = await options.alert(
        threadId,
        renderBlockedAlert({ operatorId: mention, plan }),
        mention,
      );
      if (outcome.status !== "ok") {
        posted.delete(key);
        // The slot goes back with the key: the window counts messages that reached the channel,
        // and a stamp kept for a refusal would quiet or drop the retry that finally lands.
        volume.refund(threadId);
        reportOnce(
          key,
          `broker: session ${sessionId}'s blocked alert was not written; nothing is queued, ` +
            "the next tick goes again while the block is fresh",
        );
      }
    } catch {
      posted.delete(key);
      volume.refund(threadId);
      // The message renders event-carried text, so the error detail is withheld: it can quote what
      // it failed to post.
      reportOnce(
        key,
        `broker: session ${sessionId}'s blocked alert could not be posted; ` +
          "the error detail is withheld, it can carry content",
      );
    }
  }

  function tick(): Promise<void> {
    const result = read(state);
    state = result.state;
    if (result.unreadable) {
      if (!unreadableReported) {
        unreadableReported = true;
        // The path is not named, since it is configurable to anywhere. Distinct wording from the
        // board card's line for the same file, so the log says which surface went blind.
        options.log(
          "broker: the session surface could not read the goal event stream; " +
            "blocked states and their pings lag until it reads again",
        );
      }
    } else {
      unreadableReported = false;
    }

    // The ping pass walks the kept state rather than a queue, which is what makes an episode with
    // no thread yet, or one whose post failed, retry on its own: it is still in the fold, still
    // fresh, and still unrecorded.
    const at = now();
    const posts: Promise<void>[] = [];
    for (const [sessionId, event] of state.latest) {
      if (event.event !== "goal-blocked") continue;
      if (at - event.tsMs > BLOCKED_PING_FRESH_MS) continue;
      const key = episodeKey(sessionId, event.tsMs);
      if (posted.has(key)) continue;
      // No thread yet is not a failure and records nothing: the surface opens threads on its own
      // pass, so the episode simply goes again next tick.
      const threadId = options.threadFor(sessionId);
      if (threadId === null) continue;
      posts.push(deliver(sessionId, threadId, key, event.plan));
    }
    return Promise.all(posts).then(() => undefined);
  }

  return {
    tick,
    standing: (session) => {
      const event = state.latest.get(session.sessionId);
      return (
        event !== undefined && event.event === "goal-blocked" && event.tsMs > session.lastEngagementAt
      );
    },
  };
}
