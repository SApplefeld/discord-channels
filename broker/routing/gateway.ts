// The inbound half of the Discord connection: a gateway client that reports messages posted in the
// threads this broker owns, and clears the system notices its own writes cause, the pin notices in
// the channel and the rename notices in the threads.
//
// This is the only file in the routing layer that imports discord.js, mirroring broker/discord/
// rest.ts. Everything above it works against `onMessage` and `deleteMessage`, so the routing and
// its refusals are testable without a library, a token, or a network. What it classifies it
// forwards, and every decision about a message bound for a session lives in one place
// (inbound.ts). The one decision made here is the delete, because it belongs to a message that
// reaches no session at all: it is a system message this bot wrote, and the facts it turns on are
// the library's own.
import { Client, Events, GatewayIntentBits, MessageType } from "discord.js";
import { describe } from "../discord/rest.ts";
import type { CallOutcome } from "../discord/transport.ts";
import type { InboundMessage } from "./inbound.ts";
import type { InboundInteraction } from "./interactions.ts";

export type MessageSource = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * How long a refused delete waits before the same line may be written again.
 *
 * Wide, because the refusal it reports is a standing one: a host whose bot may not delete takes it
 * on every notice its own writes cause, and the line says the same thing each time.
 */
const REFUSAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * One arriving message reduced to the facts the routing decision reads, so that decision is a
 * function of values rather than of a library object.
 */
export type MessageFacts = {
  /** Where it was posted, which for a message in a thread is that thread's own id. */
  channelId: string;
  /** The thread's parent channel, and null for a message that is in no thread. */
  parentId: string | null;
  inThread: boolean;
  /**
   * Discord's message type. `ChannelPinnedMessage` is the notice a pin writes, and
   * `ChannelNameChange` the one a rename writes.
   */
  type: MessageType;
  authorId: string;
  /** This bot's own user, and null while the connection has not identified yet. */
  selfId: string | null;
};

/**
 * What happens to one message: it is delivered to the session whose thread it landed in, deleted as
 * a system notice this bot's own write caused, or dropped.
 */
export type MessageDecision = "deliver" | "delete" | "drop" | "report";

/**
 * The single decision made about an arriving message.
 *
 * A message outside a thread is deleted or dropped, and only a message inside one is ever
 * delivered. That split is what keeps the inbound route, the sender gate, and the permission
 * verdict reader exactly as unreachable from the parent channel as they are for a broker that
 * deletes nothing: the channel's one path ends at the delete.
 *
 * Two notices are deleted, the one a pin writes into the channel and the one a rename writes into a
 * thread. Each is as narrow as the notice allows, because the delete is irreversible and the
 * channel is the operator's own: this host's channel (as the message's own for a pin notice, as the
 * thread's parent for a rename notice), Discord's type for that notice, and this bot as the author,
 * all three. A notice behind a pin or a rename the operator made by hand carries their user id and
 * is left where it is, a broker sharing the guild deletes nothing here, and no message's content is
 * read at all.
 */
export function classifyMessage(facts: MessageFacts, channelId: string): MessageDecision {
  if (!facts.inThread) {
    if (facts.channelId !== channelId) return "drop";
    if (facts.selfId === null || facts.authorId !== facts.selfId) return "drop";
    if (facts.type === MessageType.ChannelPinnedMessage) return "delete";
    // An ordinary message is this broker's own card, posted here every time a session opens, so it
    // is dropped in silence. A system message that is not the pin notice is the case worth a line:
    // the pin is issued on Discord's message-scoped route, which is newer than the notice type
    // named above, so a route that ever announced itself differently would leave this cleaner
    // deleting nothing while reporting nothing either. That is an absence indistinguishable from
    // success, and this is what tells the two apart.
    return facts.type === MessageType.Default ? "drop" : "report";
  }
  // Threads only, and only threads opened in this host's channel. Two brokers can share a guild,
  // and a message in one host's channel must not be offered to another host's sessions.
  if (facts.parentId !== channelId) return "drop";
  // The notice Discord writes into a thread each time its name changes, which for a session thread
  // is every state flip and every age tick past the dwell window. This bot's own rename is the only
  // one removed: a thread the operator renamed by hand keeps its notice.
  if (facts.type === MessageType.ChannelNameChange) {
    // Dropped rather than delivered when it is not this bot's, because a system message carries no
    // text a session could act on: what it says is drawn by Discord from the name, not written by
    // the operator.
    return facts.selfId !== null && facts.authorId === facts.selfId ? "delete" : "drop";
  }
  return "deliver";
}

/** Distinct unexpected system message types one connection names before it goes quiet. */
const MAX_REPORTED_TYPES = 16;

/**
 * Names a system message this bot caused in the channel that is not the pin notice the cleaner
 * removes, once per distinct type.
 *
 * The type is the whole of what is worth knowing, and a second line of the same one restates it, so
 * each is named once and the count is bounded. Nothing about the message's content is read.
 */
export function createUnexpectedSystemReport(log: (message: string) => void): (type: number) => void {
  const named = new Set<number>();
  return (type) => {
    if (named.has(type) || named.size >= MAX_REPORTED_TYPES) return;
    named.add(type);
    log(
      `gateway: this bot wrote a system message of type ${String(type)} in the channel, which is ` +
        "not the pin notice the cleaner removes",
    );
  };
}

/**
 * Which notice a delete is for: the one a pin writes into the channel, and the one a rename writes
 * into a thread. A union rather than a string, because the kind picks the line an operator reads and
 * the latch below is held per kind, so a spelling this broker does not write is a type error here
 * rather than a nonsense line in the log.
 */
export type SystemNoticeKind = "pin" | "rename";

export type SystemNoticeCleanerOptions = {
  deleteMessage: (input: { messageId: string; channelId?: string }) => Promise<CallOutcome<null>>;
  log: (message: string) => void;
  now: () => number;
};

/**
 * Deletes one system notice, once.
 *
 * A refusal costs a notice that stays where it landed, which is the surface a broker without this
 * has, so nothing is ever retried: the notice is cosmetic and the budget a retry would spend is
 * shared with the writes that reach a phone. The line reporting it is held to one per window, with
 * what it swallowed counted into the next one that gets through, and it names the kind because the
 * two notices sit behind different permissions and different routes.
 *
 * A refusal Discord marks permanent latches that kind off for the rest of the run, and only that
 * kind: the same call is refused the same way on every later pass, and a rename notice arrives on
 * every state flip and every age tick of every session thread, so an unlatched kind would spend one
 * refused request per notice forever against the invalid-request budget whose overrun is an
 * hour-long ban on this host's whole connection. That latch takes a line of its own, once for the
 * kind and past the window, because a kind that is no longer cleaned is a standing change in what
 * the channel shows and the run may write nothing else about it.
 *
 * `channelId` is where the notice lives, left out for one in the host's configured channel.
 */
export function createSystemNoticeCleaner(
  options: SystemNoticeCleanerOptions,
): (notice: { kind: SystemNoticeKind; messageId: string; channelId?: string }) => Promise<void> {
  let loggedAt: number | null = null;
  let suppressed = 0;
  const latched = new Set<SystemNoticeKind>();

  return async ({ kind, messageId, channelId }) => {
    if (latched.has(kind)) return;

    let refusal: string | null = null;
    let permanent = false;
    try {
      const outcome = await options.deleteMessage({ messageId, channelId });
      if (outcome.status === "rate-limited") refusal = "the bucket is empty";
      if (outcome.status === "failed") {
        refusal = outcome.error;
        // A 404 carries `permanent` too, because the identifier this call named will never resolve.
        // It says nothing about the next notice, though: one notice already gone, or one thread the
        // operator deleted, is not a standing refusal, and latching on it would take the cleaner
        // down for every other thread on the strength of a single vanished message.
        permanent = outcome.permanent === true && outcome.missing !== true;
      }
    } catch (error) {
      refusal = describe(error);
    }
    if (refusal === null) return;

    const at = options.now();
    if (!permanent && loggedAt !== null && at - loggedAt < REFUSAL_WINDOW_MS) {
      suppressed += 1;
      return;
    }
    const more = suppressed === 0 ? "" : ` (and ${String(suppressed)} more since the last line)`;
    const latch = permanent ? `. No ${kind} notice is cleaned for the rest of this run` : "";
    if (permanent) latched.add(kind);
    options.log(`gateway: deleting a ${kind} notice was refused: ${refusal}${more}${latch}`);
    loggedAt = at;
    suppressed = 0;
  };
}

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
  /**
   * Deletes a message in the host's channel, or in one of its threads when given that thread's id.
   * Spent on two things, both append-only where what they describe is reconciled: the system
   * message Discord writes whenever this bot pins, so the channel fills with notices about pins
   * that are no longer held, and the one it writes whenever this bot renames a thread, so the
   * thread fills with notices about names it no longer has.
   */
  deleteMessage: (input: { messageId: string; channelId?: string }) => Promise<CallOutcome<null>>;
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

  const cleanNotice = createSystemNoticeCleaner({
    deleteMessage: options.deleteMessage,
    log,
    now: Date.now,
  });
  const reportUnexpectedSystem = createUnexpectedSystemReport(log);

  client.on(Events.MessageCreate, (message) => {
    // Every message takes one decision and is then handed to what that decision names, so the paths
    // out of here are the ones `classifyMessage` allows and there is no other.
    const channel = message.channel;
    const inThread = channel.isThread();
    const decision = classifyMessage(
      {
        channelId: message.channelId,
        parentId: inThread ? channel.parentId : null,
        inThread,
        type: message.type,
        authorId: message.author.id,
        selfId: client.user?.id ?? null,
      },
      options.channelId,
    );
    if (decision === "drop") return;
    if (decision === "report") {
      reportUnexpectedSystem(message.type);
      return;
    }
    if (decision === "delete") {
      // A rename notice lives in the thread whose name it reports, so the delete is scoped to that
      // thread; a pin notice lives in the channel the route already defaults to.
      void cleanNotice(
        inThread
          ? { kind: "rename", messageId: message.id, channelId: message.channelId }
          : { kind: "pin", messageId: message.id },
      );
      return;
    }

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
