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
import type { InboundInteraction } from "./interactions.ts";

export type MessageSource = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type GatewayOptions = {
  token: string;
  /** The channel this host's threads live in. A message anywhere else is not this broker's. */
  channelId: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  /**
   * One component press in a thread this broker owns. Optional for the reason the routing layer's
   * other seams are optional: a broker whose questions are not answerable from the thread wires
   * none, and then interactions are classified nowhere rather than routed into a handler that
   * refuses them.
   *
   * The event needs no gateway intent of its own: interactions are delivered to the application
   * that owns the components, which is why nothing is added to the intent list below.
   */
  onInteraction?: (interaction: InboundInteraction) => Promise<void>;
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
        messageId: message.id,
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

  client.on(Events.InteractionCreate, (interaction) => {
    const onInteraction = options.onInteraction;
    if (onInteraction === undefined) return;
    // Message components only: this broker builds no commands and no modals, so anything else is
    // an event it has nothing to answer with.
    if (!interaction.isMessageComponent()) return;
    // The same two gates MessageCreate applies, for the same reason: two brokers can share a
    // guild, and a press on a message in one host's channel must not reach another host's desk.
    //
    // A null channel is the one of them a working press can land on: the library resolves it from
    // its own cache, and a thread this connection has not cached yet resolves to nothing. The press
    // is dropped, so it is logged, because the alternative is an operator whose tap reports a
    // failure with no line anywhere saying why.
    if (interaction.channel === null) {
      log(`gateway: an interaction in channel ${interaction.channelId} was dropped, it is not cached`);
      return;
    }
    if (!interaction.channel.isThread()) return;
    if (interaction.channel.parentId !== options.channelId) return;

    void onInteraction({
      interactionId: interaction.id,
      token: interaction.token,
      threadId: interaction.channelId,
      // Reported rather than checked here: the allowlist over it is a routing decision like any
      // other, and it lives in one place with the one that gates inbound messages.
      senderId: interaction.user.id,
      customId: interaction.customId,
      // A button reports no values; a string select reports every option it now has chosen.
      values: interaction.isStringSelectMenu() ? interaction.values : [],
    }).catch((error: unknown) => {
      log(`gateway: routing an interaction failed: ${describe(error)}`);
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
