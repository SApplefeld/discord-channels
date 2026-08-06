// The transport implemented against Discord's HTTP API, with the HTTP client itself injected.
//
// This file holds the wire shape: routes, request bodies, and the header parsing that turns a
// response into a rate-limit observation. It deliberately imports no Discord library, so the shape
// of every outgoing write is testable without a token, a network, or a gateway connection.
import type {
  CallOutcome,
  DiscordTransport,
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
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
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

/** Seconds on the wire, milliseconds everywhere above this file. */
function secondsToMs(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : null;
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

/** A 429's wait, preferring the body's `retry_after` and falling back to the `Retry-After` header. */
function retryAfterMs(result: {
  header: (name: string) => string | null;
  body: unknown;
}): number {
  const body = result.body;
  if (typeof body === "object" && body !== null && "retry_after" in body) {
    const seconds = Number((body as Record<string, unknown>).retry_after);
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
  }
  return secondsToMs(result.header("retry-after")) ?? 0;
}

function readId(body: unknown, field = "id"): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/** Folds one attempt into an outcome, leaving the caller to read the body of a successful one. */
function classify(result: RawResult): CallOutcome<unknown> {
  if (result.kind === "failed") {
    return { status: "failed", error: result.error, rate: NO_RATE_INFO };
  }
  if (result.kind === "rate-limited") {
    return { status: "rate-limited", rate: { ...NO_RATE_INFO, retryAfterMs: result.retryAfterMs } };
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

export type AdapterOptions = {
  /** The host's channel. Every thread this broker owns is opened in it. */
  channelId: string;
  request: RawRequest;
};

export function createDiscordTransport(
  options: AdapterOptions,
): DiscordTransport & ThreadMessenger {
  const { channelId, request } = options;

  async function write(
    route: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
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

    // The starter message lives in the parent channel, so it is edited there. It is never
    // re-posted and never pinned: pinning emits a system message, which is the churn this design
    // exists to avoid, and a starter message already renders at the top of its thread.
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
    postToThread: async ({ threadId, text }): Promise<CallOutcome<null>> => {
      const posted = await write(`/channels/${threadId}/messages`, "POST", {
        content: text,
        allowed_mentions: NO_MENTIONS,
        flags: SUPPRESS_EMBEDS,
      });
      return posted.status === "ok" ? { status: "ok", value: null, rate: posted.rate } : posted;
    },

    archiveThread: async ({ threadId }): Promise<CallOutcome<null>> => {
      const archived = await write(`/channels/${threadId}`, "PATCH", { archived: true });
      return archived.status === "ok"
        ? { status: "ok", value: null, rate: archived.rate }
        : archived;
    },
  };
}
