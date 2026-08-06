// The inbound half of the Discord connection: a gateway client that reports messages posted in the
// threads this broker owns.
//
// This is the only file in the routing layer that imports discord.js, mirroring broker/discord/
// rest.ts. Everything above it works against `onMessage`, so the routing and its refusals are
// testable without a library, a token, or a network. It classifies and forwards; it decides
// nothing, so that every decision about an inbound message lives in one place (inbound.ts).
import { Client, Events, GatewayIntentBits } from "discord.js";
import { describe } from "../discord/rest.ts";
import type { InboundMessage } from "./inbound.ts";

export type MessageSource = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type GatewayOptions = {
  token: string;
  /** The channel this host's threads live in. A message anywhere else is not this broker's. */
  channelId: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  log?: (message: string) => void;
};

export function createGatewayMessageSource(options: GatewayOptions): MessageSource {
  const log = options.log ?? ((): void => {});
  // Guilds gives the client its channel cache, which is what makes a thread's parent readable
  // without a REST call per message. MessageContent is privileged and must be enabled on the
  // application, or every message arrives with an empty body and the channel looks silently dead.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, (message) => {
    // Threads only, and only threads opened in this host's channel. Two brokers can share a guild,
    // and a message in one host's channel must not be offered to another host's sessions.
    if (!message.channel.isThread()) return;
    if (message.channel.parentId !== options.channelId) return;

    void options
      .onMessage({
        threadId: message.channelId,
        senderId: message.author.id,
        // Reported rather than filtered here: every message this broker writes comes back over
        // this connection, and dropping it is a routing decision like any other.
        fromBot: message.author.bot,
        text: message.content,
      })
      .catch((error: unknown) => {
        log(`gateway: routing an inbound message failed: ${describe(error)}`);
      });
  });

  client.on(Events.Error, (error) => {
    log(`gateway: ${describe(error)}`);
  });

  return {
    start: async () => {
      await client.login(options.token);
      log("gateway: connected, inbound messages are being read");
    },
    stop: async () => {
      await client.destroy();
    },
  };
}
