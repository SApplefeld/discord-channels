// Remote tool approval: a session's permission prompt becomes a message on the operator's phone,
// and their one-line answer becomes the verdict the session is waiting on.
//
// This is the only path in the system where a Discord message decides what a session is allowed to
// do, so two properties are held here rather than anywhere else.
//
// A verdict names a five-letter request ID, which Claude Code derives from a tool use and which is
// short enough to repeat across sessions on the same host. The open-request table is therefore
// keyed by the thread **and** the ID: a verdict is only ever applied to a request posted in the
// thread it was typed in, and an ID that names nothing open there is dropped rather than matched
// against whatever else is waiting. Answering consumes the entry, so the same message replayed a
// second time names nothing.
//
// An entry also leaves the table without a verdict, because a prompt can be answered where the
// broker cannot see it: Claude Code sends this desk nothing when one is resolved at the console. A
// session's `Stop` and the end of a session are the two signals that say so, and `turnEnded` and
// `sweepEnded` below are where each of them lands.
//
// The prompt's buttons need one guarantee more than a typed verdict does, because a button outlives
// the message it was read from: a press names its request from scrollback, where an answered prompt
// still sits. So each open request holds a nonce, the prompt's own components carry it, and a press
// whose nonce does not match resolves to nothing. That is what a recycled request ID cannot defeat.
//
// Nothing here consults a process token for authorization. The sender gate on the Discord user ID
// has already run by the time a verdict reaches this file, and it is the only authority for it.
import { randomBytes } from "node:crypto";
import {
  permissionControls,
  renderPermissionClosed,
  renderPermissionOutcome,
} from "../discord/permission-message.ts";
import { renderPermissionRequest } from "../discord/render.ts";
import type { Registry } from "../registry.ts";
import type { RelayHub } from "../routing/relays.ts";
import type { ThreadWriter } from "../routing/writer.ts";

/** What Claude Code asks about: one tool call waiting on an answer. */
export type PermissionRequest = {
  requestId: string;
  toolName: string;
  /** Untrusted. It is written by a tool whose input the session's own reading can steer. */
  description: string;
  /** Untrusted, for the same reason. */
  inputPreview: string;
};

export type Verdict = { requestId: string; behavior: "allow" | "deny" };

/**
 * A whole message and nothing but a verdict. Anchored at both ends on purpose: a message that
 * merely contains a verdict is prose the operator meant for Claude, and consuming it would swallow
 * the message and answer a prompt they were not answering.
 */
export const VERDICT_PATTERN = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/**
 * The alphabet Claude Code builds a request ID from, which has no `l` in it. An ID outside this
 * shape can never be typed back through the verdict pattern, so a request carrying one is
 * unanswerable through this channel.
 */
const REQUEST_ID = /^[a-km-z]{5}$/;

/** Reads a verdict out of a message, or reports that the message is not one. */
export function parseVerdict(text: string): Verdict | null {
  const matched = VERDICT_PATTERN.exec(text);
  if (matched === null) return null;
  return {
    behavior: matched[1].toLowerCase().startsWith("y") ? "allow" : "deny",
    requestId: matched[2].toLowerCase(),
  };
}

/**
 * Most requests held open at once, across every session on this host.
 *
 * Bounded by count rather than by age. A wall-clock expiry would quietly forget a request that is
 * still standing, and a forgotten request is a session parked with nobody able to answer it. At the
 * ceiling the **newest** is refused rather than the oldest evicted: the oldest is the one a session
 * has been parked on longest, so dropping it to make room answers the wrong question.
 */
export const MAX_OPEN_REQUESTS = 64;

/**
 * Distinct prompts one thread may ping with in a window, and the window.
 *
 * A permission prompt deliberately reaches a phone (the question alert is the only other write
 * that does), and the operator is trained to answer it quickly. A run of them is either a session
 * in a loop or a local process that won the pipe race authoring its own, and either way it wakes
 * the operator repeatedly for something they cannot keep up with. Past this the prompt is still
 * posted and is still answerable; it simply stops ringing. Three a minute is about what a person
 * answering from a phone can actually act on.
 */
export const MAX_ALERTS_PER_WINDOW = 3;

/**
 * Prompts one thread may post at all in a window, ping or not.
 *
 * Past the ping ceiling a prompt is quiet but still costs a write, and the writes come out of the
 * same bucket the replies and the notices spend. This is the point where the volume is past
 * anything a person could answer and the only thing left to protect is the channel itself, so the
 * prompt is dropped. Kept well clear of the ping ceiling: dropping a prompt parks the session it
 * came from, which is the failure this whole project exists to prevent, so it is the last resort
 * and not the first.
 */
export const MAX_PROMPTS_PER_WINDOW = 12;

/** The window every pair of ceilings here is measured in. */
export const ALERT_WINDOW_MS = 60_000;

/**
 * Distinct question alerts one thread may ping with in a window.
 *
 * One, because a question is not answerable from the thread: the ping only sends the operator to
 * the console, a real session asks questions minutes apart and parks on each, and one ping a
 * minute is a person's reading pace for a notice they cannot act on remotely. Past it the alert
 * still lands; it stops ringing.
 */
export const MAX_QUESTION_PINGS_PER_WINDOW = 1;

/**
 * Question alerts one thread may post at all in a window, ping or not.
 *
 * Past this the volume is past anything a person could walk to a console for, and the only thing
 * left to protect is the channel and the post budget the permission prompts share, so the alert
 * is dropped. A dropped alert costs less than a dropped prompt: the question is still whole on
 * the console, which is the only place it can be answered anyway.
 */
export const MAX_QUESTION_ALERTS_PER_WINDOW = 4;

/**
 * Distinct model-change alerts one thread may ping with in a window.
 *
 * One, because a genuine forced downgrade is rare and its cost is duration, which the session
 * card's standing marker already carries: a second ping inside a minute adds nothing a person can
 * act on faster. The ceiling exists because the change is read from a transcript another program
 * writes, so a model string alternating there can report one change per poll, and with the alert
 * knob on each change is a mention-bearing write, the class whose rule is a window of its own.
 * Past it the alert still lands; it stops ringing.
 */
export const MAX_MODEL_CHANGE_PINGS_PER_WINDOW = 1;

/**
 * Model-change alerts one thread may post at all in a window, ping or not.
 *
 * Past this the volume can only be the alternating-transcript case, and what is left to protect
 * is the channel and the post budget the permission prompts share. A dropped alert costs little:
 * the change stands on the session's card either way.
 */
export const MAX_MODEL_CHANGE_ALERTS_PER_WINDOW = 4;

/**
 * Per-thread volume damping for a mention-bearing write: each call spends a slot in the thread's
 * window and answers how loudly the next message may land.
 *
 * Three outcomes rather than two, because the two hazards a run creates are different and want
 * different answers. Waking the operator for more than they can keep up with is fixed by going
 * quiet, which costs nothing: the message still lands. Filling the channel, and the post budget
 * every phone-reaching write shares, is only fixed by not writing at all, so past the post
 * ceiling the write is dropped and no slot is spent.
 *
 * A factory with an instance per caller, never shared stamps: the permission desk and the
 * question alert each hold their own window, so a flood of one class cannot spend the other's
 * slots and push it into drop, which would recreate the starvation the damping exists to prevent.
 * Stamps outside the window are re-filtered on every call, so a thread's entry holds only what
 * still counts against it.
 */
export function createAlertVolume(options: {
  now: () => number;
  /** Distinct messages a thread may ping with in a window; past it a write goes quiet. */
  pingCeiling: number;
  /** Messages a thread may post at all in a window; past it a write is dropped. */
  postCeiling: number;
  windowMs: number;
}): (threadId: string) => "ping" | "quiet" | "drop" {
  const stamps = new Map<string, number[]>();
  return (threadId) => {
    const at = options.now();
    const held = (stamps.get(threadId) ?? []).filter((when) => at - when < options.windowMs);
    if (held.length >= options.postCeiling) {
      stamps.set(threadId, held);
      return "drop";
    }
    const level = held.length >= options.pingCeiling ? "quiet" : "ping";
    held.push(at);
    stamps.set(threadId, held);
    return level;
  };
}

/** What the operator sees when a prompt could not be put in front of them. */
export const PROMPT_UNDELIVERED_NOTICE =
  "A session asked for permission to run a tool and the request could not be posted here, so it " +
  "is waiting on an answer it cannot be given. Answer it at the keyboard.";

/** What the operator sees when a verdict named nothing this thread has open. */
export function unknownVerdictNotice(requestId: string): string {
  return (
    `No permission request \`${requestId}\` is open in this thread, so nothing was approved or ` +
    "denied. It may already have been answered, or the broker may have restarted since it was " +
    "asked. Check the session at the keyboard."
  );
}

/** What the operator sees when their answer was right but had nowhere left to go. */
export function unreachableVerdictNotice(requestId: string): string {
  return (
    `Request \`${requestId}\` was answered, but its session has no channel connected, so the ` +
    "answer was not delivered. The session is still waiting: answer it at the keyboard."
  );
}

export type PermissionDesk = {
  /**
   * Posts one request from the session currently held by this process token. Reports whether the
   * prompt actually reached the operator, because a relay told otherwise reports it to the model
   * rather than believing a prompt is outstanding when it is not.
   */
  request: (processToken: string, request: PermissionRequest) => Promise<boolean>;
  /**
   * Applies a verdict given in a thread, if that thread has a request open under that ID and the
   * nonce, when the caller has one, is that request's own. Reports whether it consumed one, and
   * writes nothing at all when it did not: a message of the verdict shape is also an ordinary
   * English sentence, so a caller with somewhere else to put one decides what an unmatched verdict
   * is before the operator is told anything about it.
   *
   * Answers without a Discord call. The lookup, the delivery to the session, and the audit line are
   * all this needs, so a caller holding an interaction open on the answer can report it inside the
   * three seconds Discord gives a callback. What the thread then shows, a notice for a verdict that
   * reached no session and the prompt rewritten into the record of it, is two round trips and runs
   * behind `settled`.
   *
   * `nonce` is the one a button press carries, and null for a typed verdict. A typed verdict is a
   * message composed now, in the thread, by the one account this broker acts for, so the ID it
   * names is the ID the operator is looking at. A press is a tap on a message that may be any age,
   * and the nonce is what ties it to the one prompt it was drawn on. Required rather than optional
   * so a caller states which of the two it is: a press whose nonce went missing would otherwise
   * lose the only control that stands between a recycled request ID and the wrong approval.
   */
  resolve: (threadId: string, verdict: Verdict, nonce: string | null) => boolean;
  /**
   * Settles when the writes an answered request leaves in the thread have been attempted. Held for
   * a caller that has to observe them, which is a test: nothing in the running broker waits on a
   * verdict's cosmetics.
   */
  settled: () => Promise<void>;
  /**
   * Tells the operator that a verdict named no open request. Called only once every other reading
   * of the message has declined it, because it is the reading that ends in a notice.
   */
  reportUnknownVerdict: (threadId: string, verdict: Verdict) => Promise<void>;
  /**
   * Clears the open requests a session had when its turn ended, which its `Stop` reports.
   *
   * A session parked awaiting a verdict cannot finish a turn, so a turn that ended is a session no
   * longer parked, and every prompt it had open has been resolved somewhere: at the console, most
   * often, which tells this broker nothing at all. Without this the entry stands forever, rendering
   * a working session as needing the operator, leaving live buttons over a request nothing holds,
   * and holding one of the host's MAX_OPEN_REQUESTS slots against every later prompt on the machine.
   *
   * `Stop` is the only event that can carry this. `PostToolUse` fires under the same process token
   * for a subagent's tool calls, so a session genuinely parked on a prompt while background agents
   * work still emits it, and clearing on that would drop a prompt the operator has yet to answer.
   * What separates the two is that hooks/settings-fragment.json declares no `SubagentStop`, so a
   * subagent finishing reaches this broker as nothing while the session's own turn ending reaches it
   * as `Stop`; hooks/settings-fragment.test.ts pins that.
   *
   * `at` is when the `Stop` arrived, and only entries opened strictly before it are cleared. A
   * prompt raised in the moment a `Stop` was in flight keeps its entry, which is the direction this
   * surface is allowed to fail in: an entry kept too long costs a wrong glyph, and one cleared too
   * early parks a session with nobody able to answer it.
   */
  turnEnded: (sessionId: string, at: number) => void;
  /**
   * Clears the open requests of every session the registry now holds as ended.
   *
   * The floor under `turnEnded`, for a session that dies without a turn ending: a prompt whose
   * session is gone can never be answered and is holding a slot until the broker restarts.
   *
   * Ended rather than stale, which is the registry's other non-live state. `ended` is terminal, and
   * `stale` is revivable: `relaySeen` puts a stale session back to live the moment its relay
   * answers, so clearing on stale would drop a genuinely open prompt from a session that had merely
   * gone quiet.
   */
  sweepEnded: () => void;
  /**
   * Sessions with a prompt the operator has not answered. This is what feeds the `needs you` state,
   * and it is the reason the state exists: a session parked on a permission prompt is doing nothing
   * and will do nothing until a person acts, which is precisely what the thread list is for.
   * Without it the surface renders such a session as idle, indistinguishable from one that is
   * simply quiet.
   */
  waiting: () => ReadonlySet<string>;
};

export type PermissionDeskOptions = {
  registry: Registry;
  relays: RelayHub;
  /** The thread bound to a session, as the Discord surface currently holds it. */
  threadFor: (sessionId: string) => string | null;
  writer: ThreadWriter;
  /** The one user this broker may mention, and the one whose verdicts have already been accepted. */
  operatorId: string;
  /** Injected so a test drives the alert ceiling without sleeping. */
  now?: () => number;
  log?: (message: string) => void;
};

/** Thread first, so the key reads the way the lookup is meant to: an ID within one thread. */
function keyFor(threadId: string, requestId: string): string {
  return `${threadId} ${requestId}`;
}

type OpenRequest = {
  processToken: string;
  sessionId: string;
  toolName: string;
  /** The two halves of this entry's own key, so a clear can address the prompt it drops. */
  threadId: string;
  requestId: string;
  /**
   * When the prompt was opened, which is what a `Stop` is ordered against: a request raised after a
   * turn ended is not one that turn's end can have resolved.
   */
  openedAt: number;
  /**
   * The prompt's own message, so answering it rewrites it. Null until the post reports an id, and
   * still null afterwards when it carried none.
   */
  messageId: string | null;
  /**
   * This one prompt's unguessable name for itself, minted per request and never reused. A press
   * carries it back and is refused unless it matches, which is what a five-letter request ID drawn
   * a second time in the same thread cannot survive.
   */
  nonce: string;
};

/**
 * Bytes behind a prompt's nonce, drawn from the platform CSPRNG.
 *
 * Six, the width the question desk mints its entry ids at: the value has to be unguessable by
 * anything that has not seen the message, and it rides inside a `custom_id` bounded at 100
 * characters alongside the request ID.
 */
const NONCE_BYTES = 6;

export function createPermissionDesk(options: PermissionDeskOptions): PermissionDesk {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  /** Prompts the operator has been shown and has not answered, oldest first. */
  const open = new Map<string, OpenRequest>();

  /**
   * How loudly this thread may carry its next prompt, spending a slot in the window to say so.
   * This desk's own window instance, never shared with the question alert's: shared stamps would
   * let a run of one class spend the other's slots and push it into drop.
   */
  const volumeFor = createAlertVolume({
    now,
    pingCeiling: MAX_ALERTS_PER_WINDOW,
    postCeiling: MAX_PROMPTS_PER_WINDOW,
    windowMs: ALERT_WINDOW_MS,
  });

  async function notice(threadId: string, text: string): Promise<void> {
    try {
      await options.writer.notice(threadId, text);
    } catch (error) {
      log(`permission: could not post a notice into thread ${threadId}: ${String(error)}`);
    }
  }

  /**
   * The writes an answered request leaves in the thread, chained one behind the next so `settled`
   * has a single thing to wait on. One chain for the desk rather than one per thread: nothing here
   * depends on two threads' writes being ordered against each other, and a per-thread chain would
   * be state keyed by a thread with nothing to remove it.
   */
  let cosmetic: Promise<void> = Promise.resolve();

  /**
   * What the thread shows once a verdict has been applied: the notice for an answer that reached
   * no session, and the prompt rewritten into the record of what was answered, with its components
   * stripped, because a button standing over a request nothing holds is a tap that reports a
   * failure and changes nothing.
   *
   * Runs detached from the caller that applied the verdict, so nothing here throws: a rejection
   * would have nobody to report it to. Its outcome is never propagated either, and it never
   * revisits the table: the verdict was recorded and delivered before this was scheduled, so a
   * refusal here costs a stale message rather than an answer applied twice or not at all.
   */
  async function closeOut(input: {
    threadId: string;
    verdict: Verdict;
    messageId: string | null;
    toolName: string;
    delivered: boolean;
  }): Promise<void> {
    try {
      if (!input.delivered) {
        await notice(input.threadId, unreachableVerdictNotice(input.verdict.requestId));
      }
      if (input.messageId === null) return;
      const rewritten = await options.writer.edit(
        input.threadId,
        input.messageId,
        renderPermissionOutcome({
          requestId: input.verdict.requestId,
          toolName: input.toolName,
          behavior: input.verdict.behavior,
          delivered: input.delivered,
        }),
        [],
      );
      if (rewritten.status !== "ok") {
        log(
          `permission: request ${input.verdict.requestId} was answered but its prompt was not ` +
            `rewritten: ${rewritten.status === "rate-limited" ? "rate limited" : rewritten.error}`,
        );
      }
    } catch {
      // The detail is discarded unread: a serialized transport error can carry the request it was
      // made for, and this one carries the prompt, whose fields are a session's own text.
      log(
        `permission: request ${input.verdict.requestId} was answered but closing its prompt out ` +
          "threw; the error detail is withheld, it can carry content",
      );
    }
  }

  /**
   * What the thread is left showing over a request the desk stopped holding without a verdict: the
   * prompt rewritten to say it is no longer waiting, with its components stripped, because a button
   * standing over a request nothing holds is a tap that reports a failure and changes nothing.
   *
   * Runs detached from the caller that cleared the entry, so nothing here throws, and its outcome is
   * never propagated: the entry is already gone, so a refusal here costs a stale message rather than
   * a request the desk still believes is open.
   */
  async function standDown(entry: OpenRequest, messageId: string): Promise<void> {
    try {
      const rewritten = await options.writer.edit(
        entry.threadId,
        messageId,
        renderPermissionClosed({ requestId: entry.requestId, toolName: entry.toolName }),
        [],
      );
      if (rewritten.status !== "ok") {
        log(
          `permission: request ${entry.requestId} is no longer open but its prompt was not ` +
            `rewritten: ${rewritten.status === "rate-limited" ? "rate limited" : rewritten.error}`,
        );
      }
    } catch {
      // The detail is discarded unread, as the answered path discards it: the prompt this failed to
      // write carries a session's own text, and a serialized transport error can quote it.
      log(
        `permission: request ${entry.requestId} is no longer open but closing its prompt out ` +
          "threw; the error detail is withheld, it can carry content",
      );
    }
  }

  /**
   * Drops entries nobody is waiting on any more and leaves each prompt saying so.
   *
   * The table is read into a list before anything is deleted, so the caller's own predicate decides
   * membership against one snapshot. The rewrite is scheduled on the same chain an answered
   * request's is, so `settled` covers both and neither waits on Discord.
   */
  function clear(chosen: (entry: OpenRequest) => boolean, why: string): void {
    for (const [key, entry] of [...open]) {
      if (!chosen(entry)) continue;
      open.delete(key);
      log(`permission: request ${entry.requestId} in session ${entry.sessionId} is no longer open, ${why}`);
      const messageId = entry.messageId;
      if (messageId === null) continue;
      cosmetic = cosmetic.then(() => standDown(entry, messageId));
    }
  }

  return {
    settled: () => cosmetic,

    turnEnded(sessionId, at) {
      clear(
        (entry) => entry.sessionId === sessionId && entry.openedAt < at,
        "its session ended a turn",
      );
    },

    sweepEnded() {
      const ended = new Set(
        options.registry
          .list()
          .filter((record) => record.state === "ended")
          .map((record) => record.sessionId),
      );
      if (ended.size === 0) return;
      clear((entry) => ended.has(entry.sessionId), "its session has ended");
    },

    waiting() {
      const sessions = new Set<string>();
      for (const entry of open.values()) sessions.add(entry.sessionId);
      return sessions;
    },

    async request(processToken, request) {
      if (!REQUEST_ID.test(request.requestId)) {
        // Posting it would ping the operator with a prompt no reply of theirs can answer. If Claude
        // Code ever changes the alphabet it draws these from, this line is what says so.
        log(`permission: refused request id ${request.requestId}, no verdict can name it`);
        return false;
      }

      const record = options.registry.current(processToken);
      if (record === null) {
        log("permission: a request arrived for a process with no announced session");
        return false;
      }
      const threadId = options.threadFor(record.sessionId);
      if (threadId === null) {
        log(`permission: session ${record.sessionId} has no thread, so its prompt has nowhere to go`);
        return false;
      }

      const key = keyFor(threadId, request.requestId);
      // Claude Code derives the ID from the tool use, so a re-sent prompt carries the one already
      // on the operator's phone. Posting it again would ping them a second time for one decision.
      // A request is held from the moment this call commits to posting it until either the post
      // fails or the operator answers, so a re-send arriving while the first is still on the wire
      // is deduplicated against it too and a prompt whose post failed leaves nothing behind to
      // deduplicate against at all.
      if (open.has(key)) return true;

      if (open.size >= MAX_OPEN_REQUESTS) {
        log(
          `permission: refused request ${request.requestId} for session ${record.sessionId}, ` +
            `${String(MAX_OPEN_REQUESTS)} requests are already open`,
        );
        return false;
      }
      const volume = volumeFor(threadId);
      if (volume === "drop") {
        // Logged rather than answered in-thread: a notice for each suppressed prompt is the same
        // flood in a quieter voice, and it spends the bucket this refusal exists to protect.
        log(`permission: thread ${threadId} is over its prompt ceiling, dropping ${request.requestId}`);
        return false;
      }
      if (volume === "quiet") {
        log(`permission: thread ${threadId} is over its ping ceiling, posting ${request.requestId} quietly`);
      }

      const prompt = renderPermissionRequest({ ...request, operatorId: options.operatorId });
      // The table is what makes this thread and ID one request, so the entry is held from before
      // the post rather than from after the attach edit: those are two round trips, and a second
      // request for the same ID inside them would find nothing open, post a second prompt, and
      // overwrite this one's nonce, leaving the message already on the operator's phone carrying
      // buttons the desk answers to nothing. The message id is filled in once the post reports one.
      const entry: OpenRequest = {
        processToken,
        sessionId: record.sessionId,
        toolName: request.toolName,
        threadId,
        requestId: request.requestId,
        openedAt: now(),
        messageId: null,
        nonce: randomBytes(NONCE_BYTES).toString("hex"),
      };
      open.set(key, entry);
      const posted = await options.writer.alert(
        threadId,
        prompt,
        // Quiet means the message lands without a mention. It is the same prompt, answerable the
        // same way; the phone just stops ringing for a run nobody could keep up with anyway.
        volume === "ping" ? options.operatorId : null,
      );
      if (posted.status !== "ok") {
        // Nothing is left held for a prompt the operator never saw. Holding it would make this
        // request ID deduplicate against a message that does not exist, so every later attempt at
        // the same prompt would return without trying, and the session would stay parked in
        // silence. Only this call's own entry is withdrawn, never one a later request has since put
        // in its place. The operator is told, because a prompt that vanished is worth a keyboard.
        if (open.get(key) === entry) open.delete(key);
        log(`permission: request ${request.requestId} was not posted into thread ${threadId}`);
        await notice(threadId, PROMPT_UNDELIVERED_NOTICE);
        return false;
      }
      entry.messageId = posted.value.messageId;
      // Nothing is drawn on a request this thread no longer holds: a typed verdict can answer it
      // while its prompt is still being posted, and buttons attached after that would stand over a
      // request already consumed.
      if (entry.messageId !== null && open.get(key) === entry) {
        // The prompt goes up as text and grows its controls by edit, because a post carrying
        // components and a mention is one call this route does not have: the id the components are
        // addressed by is the id the post comes back with. The same text is sent again, so the
        // message reads as it did, the `y <id>` line included: an edit resolves no mention, so the
        // pill re-renders and pings nobody a second time.
        const attached = await options.writer.edit(
          threadId,
          entry.messageId,
          prompt,
          permissionControls(request.requestId, entry.nonce),
        );
        if (attached.status !== "ok") {
          // Reported as delivered anyway, and the request stays open: the operator has the whole
          // prompt in front of them and the typed verdict still answers it. Only the one tap is
          // lost.
          log(
            `permission: request ${request.requestId} kept the plain prompt, its buttons were not ` +
              `attached: ${attached.status === "rate-limited" ? "rate limited" : attached.error}`,
          );
        }
      }
      return true;
    },

    resolve(threadId, verdict, nonce) {
      const key = keyFor(threadId, verdict.requestId);
      const entry = open.get(key);
      // Stale, already answered, cleared because its session stopped waiting on it, named in the
      // wrong thread, or asked before a broker restart: this table does not survive one, and the
      // session behind it is not re-prompted. Dropped rather
      // than matched against anything else open, because a five-letter ID is short enough to repeat
      // and guessing is how a verdict approves the wrong tool. Nothing is logged or written on the
      // way out: the message is still whole and still the caller's to read another way, and only
      // the caller knows whether anything else took it.
      if (entry === undefined) return false;
      // A press naming this request with any nonce but the one minted for it: a tap on a message
      // whose own request was answered long ago and whose five-letter ID a later prompt has since
      // drawn again. Refused on the same terms as an ID nothing holds, and writing just as little,
      // because it is the same mistake seen from the other side.
      if (nonce !== null && nonce !== entry.nonce) return false;
      open.delete(key);

      const delivered = options.relays.deliver(entry.processToken, {
        type: "permission",
        requestId: verdict.requestId,
        behavior: verdict.behavior,
      });
      // Named in full, because this line is the only record of what was approved from a phone:
      // which tool, in which session, and which way.
      const what = `${verdict.behavior} for ${entry.toolName} in session ${entry.sessionId}`;
      log(
        delivered
          ? `permission: request ${verdict.requestId} answered ${what}`
          : `permission: request ${verdict.requestId} answered ${what}, but its session has no relay`,
      );
      // What the thread is left showing is scheduled rather than waited on: a caller may be holding
      // a Discord interaction open on this answer, and a callback has about three seconds while
      // those writes are two round trips. The message id is read here rather than inside, so the
      // rewrite targets the message this request was posted as and nothing that replaced it.
      cosmetic = cosmetic.then(() =>
        closeOut({
          threadId,
          verdict,
          messageId: entry.messageId,
          toolName: entry.toolName,
          delivered,
        }),
      );
      // The entry is consumed either way, so this answered the request even when its session was
      // gone. Reported as consumed for that reason: it is an answer that was applied, not a message
      // still looking for a reading.
      return true;
    },

    async reportUnknownVerdict(threadId, verdict) {
      // Answered in the thread rather than only logged, because from a phone a silent drop reads
      // exactly like an approval that worked.
      log(`permission: no request ${verdict.requestId} is open in thread ${threadId}, dropping`);
      await notice(threadId, unknownVerdictNotice(verdict.requestId));
    },
  };
}
