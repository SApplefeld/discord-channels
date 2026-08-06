// Broker entry point. Run as source under Node's type stripping: `node broker/index.ts`.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { realpathSync } from "node:fs";
import path, { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
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

  const server = createServer(
    createHandler({ registry, maxBodyBytes: config.maxBodyBytes, log: logger }),
  );

  // The registry owns no timer of its own so that unit tests can drive it with an injected clock.
  // The sweep that turns a silent session stale lives here instead.
  const sweep = setInterval(() => {
    for (const record of registry.sweep()) {
      const message = `broker: session ${record.sessionId} (${record.name ?? "unnamed"}) is stale`;
      console.log(message);
      logger.info(message);
    }
  }, config.sweepIntervalMs);

  // The Discord surfaces are optional: with no token and no channel configured the broker is its
  // registry and its intake, which is what a local debugging run and every test wants. The refresh
  // timer lives here for the same reason the sweep does, so the surface itself is drivable by an
  // injected clock.
  const discord = loadDiscordConfig(process.env, { staleAfterMs: config.staleAfterMs });
  let refresh: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
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
    const surface = createSurface({
      transport: createDiscordTransport({
        channelId: discord.channelId,
        request: createRestRequest(discord.token),
      }),
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
      inFlight = surface.tick(registry.list().map((record) => toView(record))).catch((error: unknown) => {
        // describe() rather than String(error): a discord.js error can carry the request object,
        // and the Authorization header along with it, and this string lands in the log file.
        const message = `broker: discord refresh failed: ${describe(error)}`;
        console.error(message);
        logger.error(message);
      });
    }, discord.refreshIntervalMs);
    const message = `broker: discord surfaces on, threads open in channel ${discord.channelId}`;
    console.log(message);
    logger.info(message);
  }

  await new Promise<void>((resolve, reject) => {
    const failedToBind = (error: Error): void => {
      // A broker that never bound has no business still writing to Discord on a timer, or sweeping
      // a registry nothing can reach.
      clearInterval(sweep);
      if (refresh !== null) clearInterval(refresh);
      refresh = null;
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
    if (refresh !== null) clearInterval(refresh);
    // Clearing the timer does not cancel the pass already running, which may still be waiting on a
    // Discord call and will write the bindings file when it returns.
    await inFlight;
    // Keep-alive sockets would otherwise hold close() open until they time out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, registry, port, logger, stop };
}

/**
 * True when this module is the program Node was told to run, rather than an import.
 *
 * Compared as resolved file URLs, and case-insensitively on Windows, where the same file reaches
 * argv as `D:\...` or `d:\...` or an 8.3 short path. A plain string comparison makes
 * `node broker/index.ts` exit zero having started nothing.
 */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = resolve(entry);
  try {
    // Expands an 8.3 short path to the long form import.meta.url carries.
    real = realpathSync.native(real);
  } catch {
    // A path that cannot be resolved cannot be this module either.
  }
  const invoked = pathToFileURL(real).href;
  return process.platform === "win32"
    ? invoked.toLowerCase() === import.meta.url.toLowerCase()
    : invoked === import.meta.url;
}

if (runDirectly()) {
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
