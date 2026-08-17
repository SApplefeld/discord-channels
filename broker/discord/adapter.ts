// The transport implemented against Discord's HTTP API, with the HTTP client itself injected.
//
// This file holds the wire shape: routes, request bodies, and the header parsing that turns a
// response into a rate-limit observation. It deliberately imports no Discord library, so the shape
// of every outgoing write is testable without a token, a network, or a gateway connection.
import type {
  CallOutcome,
  ChannelPins,
  DiscordTransport,
  InteractionResponder,
  RateLimitObservation,
  ThreadMessenger,
} from "./transport.ts";
import { NO_RATE_INFO } from "./transport.ts";

/** What one HTTP attempt produced. A refusal for rate limiting is its own result, never an error. */
export type RawResult =
  | {
      kind: "response";
      status: number;
      /** Case-insensitive header lookup, as a fetch Headers object provides. */
      header: (name: string) => string | null;
      /** The parsed JSON body, or null when the response had none. */
      body: unknown;
    }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "failed"; error: string };

export type RawRequest = (input: {
  route: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absent on the verbs that carry none: the pin read, the pin, and the unpin. */
  body?: Record<string, unknown>;
}) => Promise<RawResult>;

/**
 * No mention of any kind is ever resolved, on any message this bot writes.
 *
 * A session name and a tool name arrive from a local process that can announce itself as
 * `@everyone`, and the text of a card is assembled from them. An empty `parse` list is what makes
 * every such string inert: it renders as the characters it contains and pings nobody.
 */
const NO_MENTIONS = { parse: [] as string[] };

/**
 * SUPPRESS_EMBEDS. A bare URL in a session or tool name still auto-links after the renderer has
 * escaped the markdown around it, and an unfurled embed means Discord's crawler fetches whatever
 * host the name named. Suppressing embeds keeps a card from reaching out to an attacker's server.
 */
const SUPPRESS_EMBEDS = 4;

/**
 * The longest wait any layer above this file can act on.
 *
 * A wait is read for two decisions and neither one moves past this value. The router stops a run
 * rather than sit out more than `MAX_RUN_WAIT_MS` of refusals across it, and a budget holds its
 * bucket blocked for exactly as long as the wait it was handed names. So a larger number carries
 * no more information than this one and carries a hazard instead: a `blockedUntil` far enough in
 * the future is a block no clock reaches, and the bucket then refuses every write it is asked for
 * until the process restarts. On the create-message bucket that is every reply, every notice, and
 * every permission alert for the life of the broker. adapter.test.ts pins this against the router's
 * cap, because two literals with nothing holding them together are two literals that drift.
 */
export const MAX_USABLE_WAIT_MS = 60_000;

/**
 * Seconds on the wire, milliseconds everywhere above this file, bounded like every other wait here.
 *
 * The bounding happens after the multiplication rather than before it, because the multiplication
 * is itself a producer: `1e306` is a finite number of seconds and an infinite number of
 * milliseconds. Text that is not a number at all stays null, which is a different answer from a
 * wait of zero: null is what tells the budget this response said nothing about its bucket.
 */
function secondsToMs(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? usableWaitMs(seconds * 1000) : null;
}

/**
 * A reported rate-limit wait, reduced to a number the layers above can do arithmetic with:
 * milliseconds, never negative, never `NaN` or infinite, and never longer than
 * `MAX_USABLE_WAIT_MS`.
 *
 * The value arrives from Discord or from the library that speaks to it, so neither its shape nor
 * its size is this process's to assume, and both fail the same way. Folded into a budget the wait
 * becomes a `blockedUntil`, and a `blockedUntil` no clock reaches drops every later write that
 * bucket pays for until the process restarts. A non-finite value reaches that state on shape alone:
 * it passes a `> 0` test, so a blind-fallback branch does not catch it, and it fails every `>` a cap
 * is checked with, so no cap catches it either. A merely enormous one reaches it on size, with
 * nothing overflowing anywhere. Zero is the answer an absent wait already gives, and a refusal
 * naming no usable wait is sat out blind by the router.
 *
 * Exported because two other producers hand a wait to the same budgets and the same retry loop: the
 * discord.js boundary, which reports its own refusal in milliseconds, and the thread writer, whose
 * pre-flight refusal computes the wait off a bucket rather than reading it off the wire.
 */
export function usableWaitMs(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), MAX_USABLE_WAIT_MS);
}

function count(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function observe(header: (name: string) => string | null): RateLimitObservation {
  return {
    remaining: count(header("x-ratelimit-remaining")),
    resetAfterMs: secondsToMs(header("x-ratelimit-reset-after")),
    retryAfterMs: null,
  };
}

/**
 * A 429's wait, preferring the body's `retry_after` and falling back to the `Retry-After` header.
 *
 * Every path returns a usable wait, because this is the value a 429 hands straight to the budget
 * that a reply, a notice, and a permission alert all spend. The bounding sits after the conversion
 * from seconds for the reason it does in `secondsToMs`: the conversion is where a finite number of
 * seconds becomes an infinite number of milliseconds.
 */
function retryAfterMs(result: {
  header: (name: string) => string | null;
  body: unknown;
}): number {
  const body = result.body;
  if (typeof body === "object" && body !== null && "retry_after" in body) {
    const seconds = Number((body as Record<string, unknown>).retry_after);
    if (Number.isFinite(seconds)) return usableWaitMs(seconds * 1000);
  }
  return secondsToMs(result.header("retry-after")) ?? 0;
}

function readId(body: unknown, field = "id"): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * One page of the channel's pin list, as the route answers it: `{ items, has_more }`, where each
 * item carries the pinned message under `message`. An item whose message carries no readable id is
 * dropped rather than guessed at; a body that is not a page at all is no page, which the caller
 * reports as a refusal rather than as an empty channel.
 */
function readPinPage(body: unknown): { messageIds: string[]; hasMore: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items)) return null;
  const messageIds: string[] = [];
  for (const item of page.items) {
    if (typeof item !== "object" || item === null) continue;
    const messageId = readId((item as Record<string, unknown>).message);
    if (messageId !== null) messageIds.push(messageId);
  }
  return { messageIds, hasMore: page.has_more === true };
}

/** Folds one attempt into an outcome, leaving the caller to read the body of a successful one. */
function classify(result: RawResult): CallOutcome<unknown> {
  if (result.kind === "failed") {
    return { status: "failed", error: result.error, rate: NO_RATE_INFO };
  }
  if (result.kind === "rate-limited") {
    return {
      status: "rate-limited",
      rate: { ...NO_RATE_INFO, retryAfterMs: usableWaitMs(result.retryAfterMs) },
    };
  }
  const rate = observe(result.header);
  if (result.status === 429) {
    return { status: "rate-limited", rate: { ...rate, retryAfterMs: retryAfterMs(result) } };
  }
  if (result.status === 401) {
    return { status: "failed", error: "the bot token was rejected", rate, fatal: true, permanent: true };
  }
  if (result.status >= 400 && result.status < 500) {
    // Discord refused the request, not the moment. Retrying it unchanged writes forever, and a
    // 404 says the identifier the call carried no longer names anything.
    return {
      status: "failed",
      error: `HTTP ${result.status}`,
      rate,
      permanent: true,
      missing: result.status === 404,
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return { status: "failed", error: `HTTP ${result.status}`, rate };
  }
  return { status: "ok", value: result.body, rate };
}

/**
 * Interaction callback types, from Discord's own numbering: 4 is a message the caller composes and
 * 6 acknowledges a component press leaving the message as it is.
 */
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_MESSAGE_UPDATE = 6;

/** EPHEMERAL. A message flagged with it is visible only to the user whose press provoked it. */
const EPHEMERAL = 64;

/**
 * The interaction callback route, implemented against the same injected HTTP client every other
 * write here uses.
 *
 * Separate from `createDiscordTransport` because it is a separate rate surface and its caller
 * budgets it separately: a callback and a message write report their limits independently, so a
 * budget folding them together would let one route's headroom clear the other's block. The route
 * takes the interaction's own id and token rather than a channel, and the token is a credential for
 * that one interaction, so it is never logged.
 */
export function createInteractionResponder(request: RawRequest): InteractionResponder {
  async function callback(
    interactionId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<CallOutcome<null>> {
    const answered = classify(
      await request({
        route: `/interactions/${interactionId}/${token}/callback`,
        method: "POST",
        body,
      }),
    );
    return answered.status === "ok" ? { status: "ok", value: null, rate: answered.rate } : answered;
  }

  return {
    acknowledge: ({ interactionId, token }) =>
      callback(interactionId, token, { type: DEFERRED_MESSAGE_UPDATE }),

    ephemeral: ({ interactionId, token, text }) =>
      callback(interactionId, token, {
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        // The same two suppressions every write in this file carries. The text is broker-composed,
        // but the flags are a property of the route rather than of one message's provenance.
        data: { content: text, allowed_mentions: NO_MENTIONS, flags: EPHEMERAL | SUPPRESS_EMBEDS },
      }),
  };
}

export type AdapterOptions = {
  /** The host's channel. Every thread this broker owns is opened in it. */
  channelId: string;
  request: RawRequest;
};

export function createDiscordTransport(
  options: AdapterOptions,
): DiscordTransport & ThreadMessenger & ChannelPins {
  const { channelId, request } = options;

  async function write(
    route: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<CallOutcome<unknown>> {
    return classify(await request({ route, method, body }));
  }

  return {
    postCard: async ({ card }): Promise<CallOutcome<{ messageId: string }>> => {
      const posted = await write(`/channels/${channelId}/messages`, "POST", {
        content: card,
        allowed_mentions: NO_MENTIONS,
        flags: SUPPRESS_EMBEDS,
      });
      if (posted.status !== "ok") return posted;

      const messageId = readId(posted.value);
      if (messageId === null) {
        return { status: "failed", error: "the posted message carried no id", rate: posted.rate };
      }
      return { status: "ok", value: { messageId }, rate: posted.rate };
    },

    openThread: async ({ messageId, name }): Promise<CallOutcome<{ threadId: string }>> => {
      // The auto-archive window is the longest Discord offers, in minutes, from the documented set
      // 60 / 1440 / 4320 / 10080. Left unset, a thread takes the channel's default, commonly one
      // day. Nothing this broker writes counts as thread activity, since the card is edited in the
      // parent channel, so the window runs from creation: at the default, a session running
      // overnight drops out of the active thread list that is the whole dashboard, and an archived
      // thread cannot be renamed, so its state silently stops updating.
      const opened = await write(
        `/channels/${channelId}/messages/${messageId}/threads`,
        "POST",
        { name, auto_archive_duration: 10080 },
      );
      if (opened.status !== "ok") return opened;

      const threadId = readId(opened.value);
      if (threadId === null) {
        return { status: "failed", error: "the opened thread carried no id", rate: opened.rate };
      }
      return { status: "ok", value: { threadId }, rate: opened.rate };
    },

    // The starter message lives in the parent channel, so it is edited there, and it is never
    // re-posted.
    editCard: async ({ messageId, card }): Promise<CallOutcome<null>> => {
      const edited = await write(`/channels/${channelId}/messages/${messageId}`, "PATCH", {
        content: card,
        allowed_mentions: NO_MENTIONS,
        flags: SUPPRESS_EMBEDS,
      });
      return edited.status === "ok" ? { status: "ok", value: null, rate: edited.rate } : edited;
    },

    // A channel modification carries the name alone. `allowed_mentions` is a message field: a
    // thread title resolves no mentions whatever it contains, and sending the field on a route
    // that does not define it risks a rejected rename in exchange for nothing.
    renameThread: async ({ threadId, name }): Promise<CallOutcome<null>> => {
      const renamed = await write(`/channels/${threadId}`, "PATCH", { name });
      return renamed.status === "ok" ? { status: "ok", value: null, rate: renamed.rate } : renamed;
    },

    // A thread is a channel, so a message posted into one goes to the same route the card does,
    // addressed to the thread instead of the parent. It carries the same two suppressions every
    // other write here does: the text is Claude's own output, steered by whatever arrived from
    // Discord, so it is no more trusted than a session name.
    postToThread: async ({
      threadId,
      text,
      mentionUserId,
    }): Promise<CallOutcome<{ messageId: string | null }>> => {
      const posted = await write(`/channels/${threadId}/messages`, "POST", {
        content: text,
        // The empty `parse` list still stands: no mention class is resolved from the content, so
        // `@everyone`, `@here`, a role, and any user the text happens to name all stay inert. A
        // permission prompt adds exactly one user ID to the users list, which is a whitelist and
        // not a widening: that one ID is the only mention Discord will resolve, and the renderer
        // has escaped the mention syntax out of every untrusted field, so the only mention in the
        // message is the one the broker wrote.
        allowed_mentions:
          mentionUserId === undefined ? NO_MENTIONS : { ...NO_MENTIONS, users: [mentionUserId] },
        flags: SUPPRESS_EMBEDS,
      });
      if (posted.status !== "ok") return posted;

      // Unlike postCard, a body with no readable id is not a failure: the message already landed
      // in the thread, the id only feeds the append optimization, and reporting a landed write as
      // failed is what invites the caller to resend text the operator can already see.
      return { status: "ok", value: { messageId: readId(posted.value) }, rate: posted.rate };
    },

    // The edit counterpart to postToThread: it rewrites a message this bot already posted into the
    // thread rather than posting a new one, on the same route `editCard` uses with the thread as
    // the channel. It carries the same two suppressions every write in this file does, for the same
    // reason: the text being replaced in is Claude's own output, steered by whatever arrived from
    // Discord, and no more trusted than a session name.
    editInThread: async ({ threadId, messageId, text, components }): Promise<CallOutcome<null>> => {
      const edited = await write(`/channels/${threadId}/messages/${messageId}`, "PATCH", {
        content: text,
        allowed_mentions: NO_MENTIONS,
        flags: SUPPRESS_EMBEDS,
        // Sent only when the caller named rows, an empty array included: an omitted field leaves
        // the message's existing rows alone, which is what an edit that is only rewriting text
        // means, while `[]` is what takes them off.
        ...(components === undefined ? {} : { components }),
      });
      return edited.status === "ok" ? { status: "ok", value: null, rate: edited.rate } : edited;
    },

    archiveThread: async ({ threadId }): Promise<CallOutcome<null>> => {
      const archived = await write(`/channels/${threadId}`, "PATCH", { archived: true });
      return archived.status === "ok"
        ? { status: "ok", value: null, rate: archived.rate }
        : archived;
    },

    // The pin routes are the message-scoped ones under `/messages/pins` rather than the legacy
    // `/channels/{id}/pins/{id}`. The legacy pair answers `403 Missing Permissions` to a bot holding
    // Manage Messages without Pin Messages, which names a permission the operator has granted, while
    // these accept either bit. The read needs neither.
    listPins: async (): Promise<
      CallOutcome<{ messageIds: readonly string[]; hasMore: boolean }>
    > => {
      const listed = await write(`/channels/${channelId}/messages/pins`, "GET");
      if (listed.status !== "ok") return listed;

      const page = readPinPage(listed.value);
      if (page === null) {
        // Reported permanent because the shape is the route's own: a response that is not a page is
        // one a later identical read answers the same way, and a caller that treats it as an empty
        // channel would pin messages that are already pinned, each of which writes a system message.
        return {
          status: "failed",
          error: "the pin list was not a page",
          rate: listed.rate,
          permanent: true,
        };
      }
      return { status: "ok", value: page, rate: listed.rate };
    },

    pin: async ({ messageId }): Promise<CallOutcome<null>> => {
      const pinned = await write(`/channels/${channelId}/messages/pins/${messageId}`, "PUT");
      return pinned.status === "ok" ? { status: "ok", value: null, rate: pinned.rate } : pinned;
    },

    unpin: async ({ messageId }): Promise<CallOutcome<null>> => {
      const unpinned = await write(`/channels/${channelId}/messages/pins/${messageId}`, "DELETE");
      return unpinned.status === "ok"
        ? { status: "ok", value: null, rate: unpinned.rate }
        : unpinned;
    },

    // The message route rather than the pin one: this removes the message itself, and the only
    // messages it is pointed at are the system notices this bot's own writes cause. The route is
    // scoped to where the message lives, which is the configured channel for a pin notice and the
    // thread's own id for a notice inside a thread.
    deleteMessage: async ({ messageId, channelId: from = channelId }): Promise<CallOutcome<null>> => {
      const deleted = await write(`/channels/${from}/messages/${messageId}`, "DELETE");
      return deleted.status === "ok" ? { status: "ok", value: null, rate: deleted.rate } : deleted;
    },
  };
}
