// Broker entry point. Run as source under Node's type stripping: `node broker/index.ts`.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import type { BrokerConfig } from "./config.ts";
import { createHandler } from "./intake.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { loadSessions, saveSessions } from "./persistence.ts";

export type Broker = {
  server: Server;
  registry: Registry;
  /** The port actually bound, which differs from the configured one when that port is 0. */
  port: number;
  stop: () => Promise<void>;
};

export async function startBroker(config: BrokerConfig): Promise<Broker> {
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
        console.error(
          `broker: cannot write the registry state to ${config.stateFile}: ${String(error)}`,
        );
      }
    },
  });

  const server = createServer(createHandler({ registry, maxBodyBytes: config.maxBodyBytes }));

  // The registry owns no timer of its own so that unit tests can drive it with an injected clock.
  // The sweep that turns a silent session stale lives here instead.
  const sweep = setInterval(() => {
    for (const record of registry.sweep()) {
      console.log(`broker: session ${record.sessionId} (${record.name ?? "unnamed"}) is stale`);
    }
  }, config.sweepIntervalMs);

  await new Promise<void>((resolve, reject) => {
    const failedToBind = (error: Error): void => reject(error);
    server.once("error", failedToBind);
    // Bound to loopback as well as filtered per request: an off-box connection cannot even be
    // established, and the per-request check covers anything that gets past that.
    server.listen(config.port, "127.0.0.1", () => {
      // Left attached, this listener would swallow the first error after startup against a
      // promise that has already settled, and the daemon would then die uncaught on the second.
      server.removeListener("error", failedToBind);
      server.on("error", (error) => console.error(`broker: server error: ${String(error)}`));
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  async function stop(): Promise<void> {
    clearInterval(sweep);
    // Keep-alive sockets would otherwise hold close() open until they time out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, registry, port, stop };
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
  const config = loadConfig();
  const broker = await startBroker(config);
  console.log(
    `broker: listening on http://127.0.0.1:${broker.port} as host ${config.host}, ` +
      `state at ${config.stateFile}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void broker.stop().then(() => process.exit(0));
    });
  }
}
