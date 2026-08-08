// Broker entry point. Run as source under Node's type stripping: `node broker/index.ts`.
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { runDirectly } from "./entrypoint.ts";
import { RELAY_READ_TIMEOUT_MS, loadConfig } from "./config.ts";
import type { BrokerConfig } from "./config.ts";
import { createHandler } from "./intake.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { loadSessions, saveSessions } from "./persistence.ts";
import { loadDiscordConfig } from "./discord/config.ts";
import { createDiscordTransport } from "./discord/adapter.ts";
import { createSurface } from "./discord/surface.ts";
import { toView } from "./discord/state.ts";
import { loadBindings, saveBindings } from "./discord/bindings.ts";
import { NO_RATE_INFO } from "./discord/transport.ts";
import type { ThreadMessenger } from "./discord/transport.ts";
import { createPermissionDesk } from "./security/permission.ts";
import type { PermissionDesk } from "./security/permission.ts";
import { loadSenderGate } from "./security/senders.ts";
import { createEchoMemory, createTranscriptTailer } from "./tail.ts";
import type { TranscriptTailer } from "./tail.ts";
import { createRelayHub } from "./routing/relays.ts";
import { createInboundRouter } from "./routing/inbound.ts";
import { createOutboundRouter } from "./routing/outbound.ts";
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
    edit: (threadId, messageId, text) => writer.edit(threadId, messageId, text),
    notice: async (threadId, text) => {
      const written = await writer.notice(threadId, text);
      if (written) outbound.endNarration(threadId);
      return written;
    },
    alert: async (threadId, text, mentionUserId) => {
      const written = await writer.alert(threadId, text, mentionUserId);
      if (written) outbound.endNarration(threadId);
      return written;
    },
  };
  let tail: TranscriptTailer | null = null;
  let tailTimer: NodeJS.Timeout | null = null;
  let tailInFlight: Promise<void> = Promise.resolve();
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
      echo,
      log: note,
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
    resolve: async () => {},
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
    log: note,
  });

  const hooks = createHandler({
    registry,
    maxBodyBytes: config.maxBodyBytes,
    log: logger,
    ...(tail === null ? {} : { tail: { learn: tail.learn, allow: tail.allow, suppress: tail.suppress } }),
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
    const transport = createDiscordTransport({
      channelId: discord.channelId,
      request: createRestRequest(discord.token),
    });
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
    const inbound = createInboundRouter({
      registry,
      relays,
      gate,
      permissions,
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
