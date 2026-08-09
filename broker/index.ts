// Broker entry point. Run as source under Node's type stripping: `node broker/index.ts`.
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { runDirectly } from "./entrypoint.ts";
import { RELAY_READ_TIMEOUT_MS, REPLY_HEARTBEAT_MS, loadConfig } from "./config.ts";
import type { BrokerConfig } from "./config.ts";
import { createHandler } from "./intake.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { loadSessions, saveSessions } from "./persistence.ts";
import { loadDiscordConfig } from "./discord/config.ts";
import { createDiscordTransport, createInteractionResponder } from "./discord/adapter.ts";
import { createSurface } from "./discord/surface.ts";
import { renderQuestionNotice } from "./discord/render.ts";
import type { AskedQuestion } from "./discord/render.ts";
import {
  answerableFromThread,
  renderQuestionOutcome,
  renderQuestionPrompt,
} from "./discord/question-message.ts";
import type { ActionRow } from "./discord/question-message.ts";
import { toView } from "./discord/state.ts";
import { loadBindings, saveBindings } from "./discord/bindings.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { CallOutcome, ThreadMessenger } from "./discord/transport.ts";
import {
  ALERT_WINDOW_MS,
  MAX_QUESTION_ALERTS_PER_WINDOW,
  MAX_QUESTION_PINGS_PER_WINDOW,
  createAlertVolume,
  createPermissionDesk,
} from "./security/permission.ts";
import type { PermissionDesk } from "./security/permission.ts";
import { loadSenderGate } from "./security/senders.ts";
import { createQuestionDesk } from "./question-desk.ts";
import type {
  QuestionAlert,
  QuestionEntryView,
  QuestionTerminalDetail,
  QuestionTerminalState,
} from "./question-desk.ts";
import { createEchoMemory, createTranscriptTailer, questionDigest } from "./tail.ts";
import type { TranscriptTailer } from "./tail.ts";
import { createRelayHub } from "./routing/relays.ts";
import { createInboundRouter } from "./routing/inbound.ts";
import { createInteractionRouter } from "./routing/interactions.ts";
import { createOutboundRouter } from "./routing/outbound.ts";
import type { ReplyResult } from "./routing/outbound.ts";
import { createRelayRoutes } from "./routing/http.ts";
import { createThreadWriter } from "./routing/writer.ts";
import type { ThreadWriter } from "./routing/writer.ts";
import type { MessageSource } from "./routing/gateway.ts";

export type Broker = {
  server: Server;
  registry: Registry;
  /** The port actually bound, which differs from the configured one when that port is 0. */
  port: number;
  /** The rotating-file logger this broker started with, so the caller can log a line beside it. */
  logger: Logger;
  stop: () => Promise<void>;
};

/**
 * Wraps a question delivery so the alert's own outcome settles the session's hold. The volume
 * window and the write failure live inside the delivery, which is the only place a dropped alert
 * is visible, and a hold whose alert nobody saw is a question nobody can answer: any outcome but
 * a landed alert releases, a throw included, because the throw would otherwise reach the tailer's
 * catch with the hold still standing.
 *
 * The release is checked against this ask's own digest. Both question paths, the hook's
 * emission-time alert and the tailer's resolution-time yield, share one delivery closure, so a
 * failure carries only a session id; without the digest one ask's failed delivery would release a
 * different ask's live, properly alerted hold. A throw is rethrown after the release, so the
 * tailer's own catch still reports the dropped alert.
 */
export function questionDelivery(options: {
  deliver: (sessionId: string, questions: readonly AskedQuestion[]) => Promise<ReplyResult>;
  desk: { release: (sessionId: string, digest?: string) => boolean };
}): (sessionId: string, questions: readonly AskedQuestion[]) => Promise<ReplyResult> {
  return async (sessionId, questions) => {
    const digest = questionDigest(questions);
    try {
      const outcome = await options.deliver(sessionId, questions);
      if (outcome.status !== "sent") options.desk.release(sessionId, digest);
      return outcome;
    } catch (error) {
      options.desk.release(sessionId, digest);
      throw error;
    }
  };
}

/**
 * The desk's terminal-state notifier, as the message edit it performs.
 *
 * Every trigger rewrites the ask's own thread message and strips its components, because a message
 * whose buttons answer a hold that has ended is a tap that reports a failure and changes nothing.
 * An entry whose alert never landed has no message to rewrite and edits nothing: there is no id to
 * aim at, and aiming at anything else would rewrite another message in the thread.
 *
 * Fire-and-forget by construction, because the notifier is called on the response path: the held
 * response is already answered by the time this runs, so an edit that cannot be made costs a stale
 * message rather than a stuck session, and the desk's own guard keeps a throw out of that path
 * either way.
 */
export function questionCloseOut(options: {
  edit: (
    threadId: string,
    messageId: string,
    text: string,
    components: readonly ActionRow[],
  ) => Promise<CallOutcome<null>>;
  /**
   * The edits already on the wire for this entry's message, which this one goes behind: the prompt
   * edits that draw it live, and any earlier close-out. Both orders matter, because all three aim at
   * the one message: a prompt edit landing after would put components back on a message whose hold
   * has ended, and a close-out landing after a later one would leave the message telling the
   * operator to answer a question that has since been answered.
   */
  drawing: PromptEdits;
  log: (message: string) => void;
}): (sessionId: string, state: QuestionTerminalState, detail: QuestionTerminalDetail) => void {
  return (sessionId, state, detail) => {
    const alert = detail.alert;
    if (alert === null) return;
    const answers = detail.answers;
    const content = renderQuestionOutcome({
      state,
      questions: detail.questions,
      answers: answers !== null && answers.kind === "answers" ? answers.answers : null,
      response: answers !== null && answers.kind === "response" ? answers.response : null,
    });
    // What each state writes is composed before it takes its place in the queue, so an edit waiting
    // behind another writes what its own trigger meant rather than what the message says by the
    // time the wire is free.
    void options.drawing
      .closeOut(detail.entryId, async () => {
        const outcome = await options.edit(alert.threadId, alert.messageId, content, []);
        if (outcome.status === "ok") return;
        // The state and the transport's error class only: the message this failed to write renders
        // question text, and conversation content never appears in the broker log at any level.
        options.log(
          `broker: could not close out session ${sessionId}'s question message: ` +
            (outcome.status === "rate-limited" ? "rate limited" : outcome.error),
        );
      })
      .catch(() => {
        options.log(
          "broker: closing out a question message failed; the error detail is withheld, " +
            "it can carry content",
        );
      });
  };
}

/**
 * The edits still on the wire for a held ask's one message, and the order the writers aiming at it
 * take.
 *
 * Three writers reach that message: the edits that draw it as a live prompt, and the close-outs that
 * rewrite it as each state of the hold ends. A close-out is fire-and-forget off the response path,
 * so without an order a prompt edit issued a moment earlier lands a moment later and puts live
 * components back over a hold that has already answered its session, where every tap is a failure
 * the operator has no way to read; and a close-out issued a moment earlier lands a moment later and
 * leaves the message telling the operator to answer at a console for a question the console already
 * answered. Both edits register under the entry id, and a close-out runs behind whatever it finds
 * there, so the writes to one message are serialized in the order their triggers fired. The map
 * holds an entry only while one of those edits is in flight.
 */
export type PromptEdits = {
  /** Runs one prompt edit for an entry, registered so a close-out for it waits behind. */
  draw: <Result>(entryId: string, run: () => Promise<Result>) => Promise<Result>;
  /** Runs one close-out edit for an entry, behind every edit already writing that message. */
  closeOut: <Result>(entryId: string, run: () => Promise<Result>) => Promise<Result>;
};

export function createPromptEdits(): PromptEdits {
  const inFlight = new Map<string, Promise<unknown>>();
  /** Holds the entry's place until this edit finishes, and only while it is the last registered. */
  const register = (entryId: string, running: Promise<unknown>): void => {
    inFlight.set(entryId, running);
    const forget = (): void => {
      if (inFlight.get(entryId) === running) inFlight.delete(entryId);
    };
    running.then(forget, forget);
  };
  // A failed edit is still a finished one, and each edit reports its own refusal: a wait on one
  // carries no outcome and never rejects on its account.
  const done = (): void => {};
  return {
    draw(entryId, run) {
      // Started before it is registered, and nothing between the two lines yields: `run` reads the
      // entry and issues its edit synchronously, so a close-out firing from here on either finds
      // this edit registered or has not been provoked yet.
      const running = run();
      register(entryId, running);
      return running;
    },
    closeOut(entryId, run) {
      const ahead = inFlight.get(entryId);
      // Registered as the wait rather than after it, which is what orders two close-outs against
      // each other: a close-out arriving while this one waits finds this whole chain in the map and
      // goes behind it, where finding only the edit this one is waiting on would put the two of them
      // on the wire together.
      const running = (ahead === undefined ? Promise.resolve() : ahead.then(done, done)).then(run);
      register(entryId, running);
      return running;
    },
  };
}

/**
 * Turns the notice a question's alert landed as into the interactive message that answers it, or
 * releases the hold so the question lands on today's behavior.
 *
 * The notice is posted first and the components follow it by edit, because the entry id every
 * component is addressed by does not exist until the hold does, and the hold is created after the
 * delivery starts: the intake calls the alert seam before the hold seam, since the hold is gated on
 * whether that alert went out. What the ordering buys is that the post's own round trip is the wait
 * the hold is created in, so by the time Discord answers, the desk either holds this ask or never
 * will.
 *
 * Every branch but the upgrade releases the hold, and all of them land on today's behavior, an
 * alerted phone and a console picker: a post that came back with no message id has nothing to edit,
 * an ask this thread cannot answer faithfully would be parked behind components that never finish
 * or answer with a map the session cannot read, and a refused upgrade would leave a readable
 * message with no controls above a four-hour hold, which is the one outcome worse than no hold at
 * all. The one branch that releases nothing is the ask the desk no longer holds, where there is
 * nothing left to release.
 */
export function questionUpgrade(options: {
  desk: {
    held: (sessionId: string, digest: string) => QuestionEntryView | null;
    release: (sessionId: string, digest?: string) => boolean;
    noteAlert: (sessionId: string, digest: string, alert: QuestionAlert) => string | null;
  };
  edit: (
    threadId: string,
    messageId: string,
    text: string,
    components: readonly ActionRow[],
  ) => Promise<CallOutcome<null>>;
  drawing: PromptEdits;
  operatorId: string;
  log: (message: string) => void;
}): (input: {
  sessionId: string;
  threadId: string;
  messageId: string | null;
  questions: readonly AskedQuestion[];
}) => Promise<void> {
  return async ({ sessionId, threadId, messageId, questions }) => {
    const digest = questionDigest(questions);
    const entry = options.desk.held(sessionId, digest);
    // Nothing is held for this ask, so there is nothing to upgrade and nothing to release: the
    // notice stands as the alert it is.
    if (entry === null) return;
    if (messageId === null || !answerableFromThread(entry.questions, entry.questionsInput)) {
      // Released before the alert is noted on the entry, so the terminal state has no message to
      // rewrite: the notice already in the thread carries the question whole and says it is
      // waiting at the console, which is exactly what happened.
      options.desk.release(sessionId, digest);
      return;
    }
    // The read that decides the edit is safe to make: the entry is live and carries no message yet,
    // and nothing between here and the edit yields, so the edit cannot be issued for an ask that
    // ended in between. What can end under the edit is handled by the ordering `drawing` keeps.
    const entryId = options.desk.noteAlert(sessionId, digest, { threadId, messageId });
    if (entryId === null) return;
    const prompt = renderQuestionPrompt({
      operatorId: options.operatorId,
      entryId,
      questions,
      selections: questions.map(() => []),
    });
    const upgraded = await options.drawing.draw(entryId, () =>
      options.edit(threadId, messageId, prompt.content, prompt.components),
    );
    if (upgraded.status === "ok") return;
    // The release's own terminal edit rewrites this message: the alert is on the entry by now, so
    // what the operator ends up reading is the closed-out line naming the console, not the notice
    // this edit failed to replace.
    options.desk.release(sessionId, digest);
    options.log(
      `broker: session ${sessionId}'s question kept the plain notice and released its hold: ` +
        (upgraded.status === "rate-limited" ? "rate limited" : upgraded.error),
    );
  };
}

/**
 * Redraws a held ask's own message so the operator sees the selections the desk has accumulated.
 *
 * A select reports its whole selection back to Discord, but the client rebuilds the menu from the
 * message, so an ask whose message is never rewritten shows the placeholder again after every
 * choice. Rendered with the operator's own ID whatever tier the alert was posted under, because an
 * edit resolves no mention at all: the transport names none, so the pill renders and pings nobody.
 *
 * The view arrives from a read taken before the press was acknowledged, so the entry it describes
 * can have ended since. Read again here, and the edit is issued only for an entry the desk still
 * holds under the same id: a redraw over a resolved hold is live components above a session that
 * has already moved on.
 */
export function questionRefresh(options: {
  desk: { entry: (entryId: string) => QuestionEntryView | null };
  edit: (
    threadId: string,
    messageId: string,
    text: string,
    components: readonly ActionRow[],
  ) => Promise<CallOutcome<null>>;
  drawing: PromptEdits;
  operatorId: string;
  log: (message: string) => void;
}): (entry: QuestionEntryView) => Promise<void> {
  return async (entry) => {
    const outcome = await options.drawing.draw(entry.id, async () => {
      const live = options.desk.entry(entry.id);
      if (live === null || live.alert === null) return null;
      const prompt = renderQuestionPrompt({
        operatorId: options.operatorId,
        entryId: live.id,
        questions: live.questions,
        selections: live.selections,
      });
      const { threadId, messageId } = live.alert;
      return options.edit(threadId, messageId, prompt.content, prompt.components);
    });
    if (outcome === null || outcome.status === "ok") return;
    // The state and the transport's error class only: the message this failed to write renders
    // question text, and conversation content never appears in the broker log at any level. A
    // failed redraw costs a menu showing its placeholder rather than the operator's own choice,
    // because the selection is already recorded on the desk.
    options.log(
      `broker: could not redraw session ${entry.sessionId}'s question message: ` +
        (outcome.status === "rate-limited" ? "rate limited" : outcome.error),
    );
  };
}

export async function startBroker(config: BrokerConfig): Promise<Broker> {
  // Console output stays as it was: a broker run at a terminal, or under `npm test`, keeps seeing
  // it. The logger writes the same lines to a rotating file too, when one is configured, because a
  // scheduled task (S7) has no console for that output to land in.
  const logger = createLogger({
    file: config.logFile,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  });

  const registry = createRegistry({
    host: config.host,
    staleAfterMs: config.staleAfterMs,
    retainTerminalMs: config.retainTerminalMs,
    maxSessions: config.maxSessions,
    sessions: loadSessions(config.stateFile),
    // Persisted on every mutation rather than on a timer: a debounce window is a window in which
    // a crash loses a session announcement. A failed write is logged and survived, because the
    // sweep runs on an interval, where a throw would be an uncaught exception and end the daemon.
    onMutate: (sessions) => {
      try {
        saveSessions(config.stateFile, sessions);
      } catch (error) {
        const message = `broker: cannot write the registry state to ${config.stateFile}: ${String(error)}`;
        console.error(message);
        logger.error(message);
      }
    },
  });

  const note = (message: string): void => {
    console.log(message);
    logger.info(message);
  };

  // The Discord half of message routing is only wired when Discord is configured, but the relay
  // half is not: a session's relay attaches, holds its session out of the staleness sweep, and
  // marks it ended when its stdio closes, with or without a bot token. Until a transport is
  // installed below, a reply reports that it had nowhere to go rather than being queued.
  const relays = createRelayHub({
    registry,
    // One heartbeat of grace. The relay reconnects by design, so a pipe that closed and came back
    // is a reconnect and not a death, and `ended` is terminal: calling it the instant a socket went
    // would strand a working session as exited with no way back.
    graceMs: config.relayHeartbeatMs,
    log: note,
  });
  let threadFor: (sessionId: string) => string | null = () => null;
  let messenger: ThreadMessenger = {
    postToThread: async () => ({
      status: "failed",
      error: "discord is not configured",
      rate: NO_RATE_INFO,
    }),
    editInThread: async () => ({
      status: "failed",
      error: "discord is not configured",
      rate: NO_RATE_INFO,
    }),
  };
  const writer = createThreadWriter({
    messenger: {
      postToThread: (input) => messenger.postToThread(input),
      editInThread: (input) => messenger.editInThread(input),
    },
    now: Date.now,
    log: note,
  });
  // A second writer, and therefore a second budget bucket, for conversation volume: mirrored
  // prompts and replies, and the reply tool's answers. That volume arrives on every prompt and
  // every turn end of every wrapped session and can run many messages per post, and a writer's
  // budget blocks on what Discord reports, so one shared writer would let a block earned by
  // conversation drop the permission alerts and notices a parked session is waiting on. The split
  // creates no Discord capacity; it only keeps conversation rate-limit state from starving the
  // paths that reach a phone.
  const mirrorWriter = createThreadWriter({
    messenger: {
      postToThread: (input) => messenger.postToThread(input),
      editInThread: (input) => messenger.editInThread(input),
    },
    now: Date.now,
    log: note,
  });
  // The echo memory exists whenever the Stop mirror does: it carries the dedup between the
  // reply tool's answer and the mirrored reply, which needs no tailer, so switching interim
  // narration off must not disarm it. The tailer half of the memory only ever fills under
  // interim mirroring below, because only the tailer writes it.
  const echo = config.mirror ? createEchoMemory() : null;
  const outbound = createOutboundRouter({
    registry,
    threadFor: (sessionId) => threadFor(sessionId),
    mirrorWriter,
    taskNotifications: config.taskNotifications,
    log: note,
    ...(echo === null ? {} : { echo }),
  });
  // The steering writer's notices and permission alerts land in threads without passing the
  // outbound router, so a successful post tells the router directly that the thread's narration
  // block is over. Their only other clear is their own gateway echo, and a dropped gateway loses
  // echoes while REST keeps posting, which would let narration grow above a permission prompt.
  // Wrapped here because this is where the writer and the router both exist: the writer knows
  // nothing about routing.
  const steeringWriter: ThreadWriter = {
    reply: (threadId, text) => writer.reply(threadId, text),
    // Every argument forwarded, the components included: this wrapper only adds the narration
    // clear to the posting verbs, and a parameter dropped here would strip the rows off every
    // question message that goes through it while type-checking clean.
    edit: (threadId, messageId, text, components) =>
      writer.edit(threadId, messageId, text, components),
    notice: async (threadId, text) => {
      const written = await writer.notice(threadId, text);
      if (written) outbound.endNarration(threadId);
      return written;
    },
    alert: async (threadId, text, mentionUserId) => {
      const posted = await writer.alert(threadId, text, mentionUserId);
      if (posted.status === "ok") outbound.endNarration(threadId);
      return posted;
    },
  };
  // The question alert's doorway, mutable for the same reason `threadFor` is: the tailer is
  // constructed here, before the Discord block below decides whether a channel exists, and the
  // alert needs the sender gate's operator ID, which loads only inside that block. Until then the
  // alert has no thread to land in and no one to mention, so it drops as the routing layer drops:
  // a report of no thread, nothing queued, nothing retried.
  let deliverQuestion: (
    sessionId: string,
    questions: readonly AskedQuestion[],
  ) => Promise<ReplyResult> = async () => ({ status: "no-thread" });
  let tail: TranscriptTailer | null = null;
  let tailTimer: NodeJS.Timeout | null = null;
  let tailInFlight: Promise<void> = Promise.resolve();
  // The question desk holds a credited question post's hook response open so the answer can ride
  // back from the thread; every trigger but an answer releases with `{}` to today's behavior, the
  // console picker. Constructed unconditionally, like the relay hub: without Discord the hold is
  // created and released within the alert's own failure path, which is today's behavior reached by
  // a longer road.
  //
  // The terminal-state notifier is the message-edit seam. Every trigger rewrites the ask's own
  // thread message and strips its components, because a message whose buttons answer a hold that
  // has ended is a tap that reports a failure and changes nothing. It is fire-and-forget: the
  // response is already answered when this runs, and an edit that cannot be made costs a stale
  // message rather than a stuck session.
  const drawing = createPromptEdits();
  const questionDesk = createQuestionDesk({
    holdMs: config.questionHoldMs,
    log: note,
    onTerminal: questionCloseOut({
      edit: (threadId, messageId, text, components) =>
        steeringWriter.edit(threadId, messageId, text, components),
      drawing,
      log: note,
    }),
  });
  // The transcript tailer exists only while both mirror switches are on. Off means not
  // constructed: no transcript is ever opened, no poll timer runs, and the intake gets no seam
  // to learn a path through, so "off" is the absence of the machinery rather than a check
  // inside it.
  if (echo !== null && config.interimMirror) {
    const tailer = createTranscriptTailer({
      liveSessions: () =>
        registry
          .list()
          .filter((record) => record.state === "live")
          .map((record) => record.sessionId),
      deliver: (sessionId, text) => outbound.interim(sessionId, text),
      deliverPrompt: (sessionId, text) => outbound.interimPrompt(sessionId, text),
      // The release wrapper above. The delivery is read through a closure rather than passed
      // directly, because `deliverQuestion` is replaced further down once Discord's surfaces
      // exist, and the tailer is constructed before that.
      deliverQuestion: questionDelivery({
        deliver: (sessionId, questions) => deliverQuestion(sessionId, questions),
        desk: questionDesk,
      }),
      // The console-answer flip. A resolution line means the picker closed, and the desk holds the
      // one message that has been telling the operator to answer there; the digest is what names
      // the ask across the two modules, computed from the same bounded parse on both sides.
      answeredAtConsole: (sessionId, questions) =>
        questionDesk.answeredAtConsole(sessionId, questionDigest(questions)),
      echo,
      log: note,
      // The pass watchdog's threshold, scaled here because the tailer does not know the poll
      // interval: a pass legitimately outlasts one interval when Discord is slow, and three of
      // them is the wedge the watchdog line exists to make visible.
      passWatchdogMs: config.interimPollMs * 3,
    });
    tail = tailer;
    tailTimer = setInterval(() => {
      // A rejection out of the pass would be fatal under Node 24, taking the hook intake down
      // with the tailer, and the intake is the half that has to keep running. The pass is kept so
      // shutdown can wait for it, the way the Discord refresh's inFlight is below.
      tailInFlight = tailer.poll().catch(() => {
        // The error is discarded unread: a throw out of a read or a parse can quote transcript
        // content, and conversation content never appears in the broker log at any level.
        note("broker: a transcript poll pass failed; the error detail is withheld, it can carry content");
      });
    }, config.interimPollMs);
  }
  // Replaced below when Discord is configured. Without a channel there is no thread to ask in and
  // no operator to ask, so a prompt is reported and dropped rather than held: the session is at a
  // terminal, which is where its permission dialog already is.
  let permissions: PermissionDesk = {
    request: async () => {
      note("broker: a permission prompt arrived but discord is not configured");
      return false;
    },
    resolve: async () => false,
    reportUnknownVerdict: async () => {},
    waiting: () => new Set<string>(),
  };
  const relayRoutes = createRelayRoutes({
    relays,
    outbound,
    // The asking half only. Answering a prompt belongs to the Discord side, behind the sender
    // gate, and this layer is reachable by any local process that holds a pipe.
    permissions: { request: (processToken, request) => permissions.request(processToken, request) },
    maxBodyBytes: config.maxBodyBytes,
    streamIdleMs: RELAY_READ_TIMEOUT_MS,
    replyHeartbeatMs: REPLY_HEARTBEAT_MS,
    log: note,
  });

  const hooks = createHandler({
    registry,
    maxBodyBytes: config.maxBodyBytes,
    log: logger,
    // The question seam rides beside the other three: both question paths, this hook-fed one and
    // the tailer's own transcript yield, end in the one deliverQuestion closure below, so they
    // share one rendering, one alert tier, and one volume window, and a double path cannot
    // double-ping.
    ...(tail === null
      ? {}
      : {
          tail: {
            learn: tail.learn,
            allow: tail.allow,
            suppress: tail.suppress,
            question: tail.question,
          },
        }),
    // The hold seam. A qualifying question post's response is held open here rather than answered,
    // so the answer can ride back from the thread through the components the alert grows; every
    // post the desk refuses, and every gate ahead of it, is answered immediately exactly as a
    // broker without a desk answers it. Safe to wire because the answer route exists: the alert's
    // own delivery either upgrades the message to one that can answer the hold or releases it, and
    // the interaction route resolves it from a tap.
    questionDesk: { hold: questionDesk.hold },
    mirror: {
      enabled: config.mirror,
      maxBytes: config.mirrorMaxBytes,
      deliver: (processToken, kind, text, sessionId) =>
        outbound.mirror(processToken, kind, text, sessionId),
    },
  });
  const server = createServer((request, response) => {
    // The relay routes answer first and report whether they took the request; everything else,
    // including every route that does not exist, stays the hook intake's to answer.
    if (relayRoutes(request, response)) return;
    hooks(request, response);
  });

  const heartbeat = setInterval(() => relays.heartbeat(), config.relayHeartbeatMs);

  // The registry owns no timer of its own so that unit tests can drive it with an injected clock.
  // The sweep that turns a silent session stale lives here instead.
  const sweep = setInterval(() => {
    for (const record of registry.sweep()) {
      const message = `broker: session ${record.sessionId} (${record.name ?? "unnamed"}) is stale`;
      console.log(message);
      logger.info(message);
    }
    // The echo memory holds one small record per session and clears them as sessions retire. The
    // tailer sweeps it too on every poll, but on a mirror-only host there is no tailer, and
    // without this line the map would hold an entry for every session the broker ever mirrored.
    echo?.sweep(new Set(registry.list().map((record) => record.sessionId)));
  }, config.sweepIntervalMs);

  // The Discord surfaces are optional: with no token and no channel configured the broker is its
  // registry and its intake, which is what a local debugging run and every test wants. The refresh
  // timer lives here for the same reason the sweep does, so the surface itself is drivable by an
  // injected clock.
  const discord = loadDiscordConfig(process.env, {
    staleAfterMs: config.staleAfterMs,
    // A half-configured Discord is the one shape that looks identical to a working one from every
    // other signal: the broker starts, the registry fills, the status cards would tick. Saying so
    // once at startup is the difference between a typo and an afternoon.
    warn: (message) => {
      console.warn(message);
      logger.warn(message);
    },
  });
  let refresh: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let gateway: MessageSource | null = null;
  if (discord !== null) {
    // Imported here rather than at the top so that discord.js, the one dependency with a network
    // client in it, is loaded only by a broker that is actually configured to reach Discord.
    const { createRestRequest, describe } = await import("./discord/rest.ts");
    // Beside the registry snapshot, and for the same reason: without it a restart would open a
    // second thread for every session the registry still holds.
    const bindingsFile = path.join(path.dirname(config.stateFile), "discord-threads.json");
    const stopRefresh = (): void => {
      if (refresh !== null) clearInterval(refresh);
      refresh = null;
    };
    // One HTTP client for every Discord write this broker makes, the message routes and the
    // interaction callback alike. Sharing the client shares no budget: each surface holds its own
    // `Budget` instance, because the routes report their rate limits independently.
    const request = createRestRequest(discord.token);
    const transport = createDiscordTransport({ channelId: discord.channelId, request });
    messenger = transport;
    const surface = createSurface({
      transport,
      now: Date.now,
      dwellMs: discord.dwellMs,
      idleAfterMs: discord.idleAfterMs,
      exitedAfterMs: discord.exitedAfterMs,
      archiveOnEnd: discord.archiveOnEnd,
      bindings: loadBindings(bindingsFile),
      onBind: (bindings) => {
        try {
          saveBindings(bindingsFile, bindings);
        } catch (error) {
          const message = `broker: cannot write the thread bindings to ${bindingsFile}: ${String(error)}`;
          console.error(message);
          logger.error(message);
        }
      },
      log: (message) => {
        console.log(message);
        logger.info(message);
      },
      onFatal: (message) => {
        console.error(message);
        logger.error(message);
        stopRefresh();
      },
    });
    refresh = setInterval(() => {
      // A rejection here would be fatal to the process under Node 24, taking the hook intake down
      // with the Discord surface, and the intake is the half that has to keep running. The pass is
      // kept so that shutdown can wait for it: clearing the timer does not cancel a call already
      // on the wire, or the binding write that follows it.
      // Recomputed each pass rather than pushed, so a prompt answered between ticks stops showing
      // as waiting without anything having to remember to clear it.
      const waiting = permissions.waiting();
      inFlight = surface
        .tick(registry.list().map((record) => toView(record, waiting.has(record.sessionId))))
        .catch((error: unknown) => {
        // describe() rather than String(error): a discord.js error can carry the request object,
        // and the Authorization header along with it, and this string lands in the log file.
        const message = `broker: discord refresh failed: ${describe(error)}`;
        console.error(message);
        logger.error(message);
      });
    }, discord.refreshIntervalMs);
    threadFor = (sessionId) => surface.threadFor(sessionId);

    // Read here rather than beside the other configuration: it is only meaningful for a broker
    // that has a channel to be steered through, and it throws when it is missing, which stops a
    // broker with a Discord connection from ever running without an allowlist.
    //
    // The reason is written to the log file before the throw leaves this function. Under the
    // scheduled task there is no console for it to reach, so an unlogged refusal is a broker that
    // fails at every logon and leaves a zero-byte log saying nothing about why.
    let gate;
    try {
      gate = loadSenderGate(process.env);
    } catch (error) {
      clearInterval(sweep);
      clearInterval(heartbeat);
      stopRefresh();
      const message = `broker: refusing to start with a discord connection: ${String(error)}`;
      console.error(message);
      logger.error(message);
      throw error;
    }
    permissions = createPermissionDesk({
      registry,
      relays,
      threadFor: (sessionId) => surface.threadFor(sessionId),
      writer: steeringWriter,
      operatorId: gate.operatorId,
      now: Date.now,
      log: note,
    });
    // The question alert posts through the steering writer's alert tier, the unfloored,
    // phone-reaching write permission prompts ride, rather than the mirror writer that paces
    // conversation volume: the notice floor could swallow a question, the mirror writer's pacing
    // could hold one behind a long narration run, and a question is exactly the parked-session
    // class the alert tier exists for. `steeringWriter.alert` already ends the thread's narration
    // block on a successful write.
    //
    // Its volume rides its own window instance, never the permission desk's: shared stamps would
    // let a run of question alerts spend the prompt window's slots and push real permission
    // prompts into drop, the starvation the damping exists to prevent. Past the ping ceiling the
    // alert lands without a mention, composed and posted without one alike; past the post ceiling
    // nothing is written, and the refusal is not logged here, because the tailer logs it once,
    // rate-limited, off the result this closure reports.
    const questionVolume = createAlertVolume({
      now: Date.now,
      pingCeiling: MAX_QUESTION_PINGS_PER_WINDOW,
      postCeiling: MAX_QUESTION_ALERTS_PER_WINDOW,
      windowMs: ALERT_WINDOW_MS,
    });
    const upgrade = questionUpgrade({
      desk: questionDesk,
      edit: (threadId, messageId, text, components) =>
        steeringWriter.edit(threadId, messageId, text, components),
      drawing,
      operatorId: gate.operatorId,
      log: note,
    });
    deliverQuestion = async (sessionId, questions) => {
      const threadId = surface.threadFor(sessionId);
      if (threadId === null) return { status: "no-thread" };
      const volume = questionVolume(threadId);
      if (volume === "drop") {
        return { status: "failed", error: "question alerts are over their window" };
      }
      const mention = volume === "ping" ? gate.operatorId : null;
      const posted = await steeringWriter.alert(
        threadId,
        renderQuestionNotice({ operatorId: mention, questions }),
        mention,
      );
      if (posted.status !== "ok") return { status: "failed", error: "the alert was not written" };
      await upgrade({ sessionId, threadId, messageId: posted.value.messageId, questions });
      return { status: "sent" };
    };
    const interactions = createInteractionRouter({
      gate,
      desk: questionDesk,
      responder: createInteractionResponder(request),
      refresh: questionRefresh({
        desk: questionDesk,
        edit: (threadId, messageId, text, components) =>
          steeringWriter.edit(threadId, messageId, text, components),
        drawing,
        operatorId: gate.operatorId,
        log: note,
      }),
      now: Date.now,
      log: note,
    });
    const inbound = createInboundRouter({
      registry,
      relays,
      gate,
      permissions,
      // The typed-answer seam. A message posted while this session's question is held answers that
      // question whole, in the operator's own words, instead of reaching the model as steering it
      // could only queue against a session parked inside the tool call.
      questions: { answerTyped: questionDesk.answerTyped },
      threadFor: (sessionId) => surface.threadFor(sessionId),
      writer: steeringWriter,
      now: Date.now,
      log: note,
    });
    // Same reason the REST client is imported here: this module is the only one in the routing
    // layer that loads discord.js, and a broker with no Discord configured never touches it.
    const { createGatewayMessageSource } = await import("./routing/gateway.ts");
    gateway = createGatewayMessageSource({
      token: discord.token,
      channelId: discord.channelId,
      onMessage: (message) => {
        // Ahead of deliver, which drops bot-authored messages first: the broker's own posts are
        // most of what lands below a narration block, and the freshness gate must see exactly
        // those to know the block is no longer the thread's newest message.
        outbound.noteThreadMessage(message.threadId, message.messageId);
        return inbound.deliver(message);
      },
      onInteraction: (interaction) => interactions.deliver(interaction),
      log: note,
    });
    // Awaited: a login failure belongs to startup, where it is reported, rather than surfacing
    // later as messages that silently never arrive.
    await gateway.start();

    note(
      `broker: discord surfaces on, threads open in channel ${discord.channelId}, ` +
        `steered by user ${gate.operatorId} and nobody else`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const failedToBind = (error: Error): void => {
      // A broker that never bound has no business still writing to Discord on a timer, sweeping
      // a registry nothing can reach, or polling transcripts for it.
      clearInterval(sweep);
      clearInterval(heartbeat);
      if (tailTimer !== null) clearInterval(tailTimer);
      tailTimer = null;
      if (refresh !== null) clearInterval(refresh);
      refresh = null;
      // The gateway logs in before the listener binds, so a port conflict would otherwise leave a
      // connected bot behind in a process that is about to throw: the bot would show online, and a
      // second broker starting later would have two of them reading the same channel.
      if (gateway !== null) void gateway.stop().catch(() => {});
      // Logged here, not just rethrown: under a scheduled task there is no console to catch the
      // rejection this throws into, and a broker that never bound would otherwise leave a zero-byte
      // log with no signal that anything went wrong at all.
      const message = `broker: failed to bind 127.0.0.1:${config.port}: ${String(error)}`;
      console.error(message);
      logger.error(message);
      reject(error);
    };
    server.once("error", failedToBind);
    // Bound to loopback as well as filtered per request: an off-box connection cannot even be
    // established, and the per-request check covers anything that gets past that.
    server.listen(config.port, "127.0.0.1", () => {
      // Left attached, this listener would swallow the first error after startup against a
      // promise that has already settled, and the daemon would then die uncaught on the second.
      server.removeListener("error", failedToBind);
      server.on("error", (error) => {
        const message = `broker: server error: ${String(error)}`;
        console.error(message);
        logger.error(message);
      });
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  async function stop(): Promise<void> {
    clearInterval(sweep);
    clearInterval(heartbeat);
    if (tailTimer !== null) clearInterval(tailTimer);
    if (refresh !== null) clearInterval(refresh);
    if (gateway !== null) await gateway.stop();
    // Clearing the timer does not cancel the pass already running, which may still be waiting on a
    // Discord call and will write the bindings file when it returns. The tailer's pass is awaited
    // for the same reason: shutdown must not race a read still holding a file handle.
    await inFlight;
    await tailInFlight;
    // The broker going down is not a session dying, so the pipes are dropped without ending
    // anything. The relays reconnect; the sessions behind them keep working either way.
    relays.closeAll();
    // Every held question answers `{}` before the sockets are torn down: a destroyed connection
    // is a visible hook error inside the session, while the release lands it on the console
    // picker, which is where a question outliving its broker belongs. Awaited, because the
    // teardown below destroys sockets and would drop a body still on its way out, arriving inside
    // the session as exactly the reset the release exists to avoid; the wait is bounded inside the
    // desk, so a stuck socket delays shutdown by no more than that bound.
    await questionDesk.releaseAll();
    // Keep-alive sockets would otherwise hold close() open until they time out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, registry, port, logger, stop };
}

if (runDirectly(import.meta.url)) {
  let config: BrokerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    // No BrokerConfig exists yet to read a log path from, so this reads the same environment
    // variable directly. Under a scheduled task there is no console for the throw below to reach,
    // so a config error would otherwise leave nothing on disk explaining why the task keeps
    // restarting and failing.
    const fallback = createLogger({
      file: process.env.CHANNEL_BROKER_LOG_FILE?.trim() || null,
      maxBytes: 5 * 1024 * 1024,
      maxFiles: 5,
    });
    const message = `broker: failed to load configuration: ${String(error)}`;
    console.error(message);
    fallback.error(message);
    throw error;
  }

  // A bind or startup failure inside startBroker is already logged, through the config's own
  // logger, before it rejects; nothing more to do here except let it propagate.
  const broker = await startBroker(config);
  const message = `broker: listening on http://127.0.0.1:${broker.port} as host ${config.host}, ` +
    `state at ${config.stateFile}`;
  console.log(message);
  broker.logger.info(message);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void broker.stop().then(() => process.exit(0));
    });
  }
}
