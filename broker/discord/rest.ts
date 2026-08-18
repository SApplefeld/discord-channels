// The one file that touches discord.js. Everything above it works against `RawRequest`, so the
// surfaces, the budget, and the wire shapes are all testable without the library, a token, or a
// network.
import { DiscordAPIError, REST, RateLimitError, RequestMethod } from "discord.js";
import { usableWaitMs } from "./adapter.ts";
import type { RawRequest, RawResult } from "./adapter.ts";

/**
 * Error text safe to log. Only the message is taken: a stack or a serialized request object can
 * carry the Authorization header, and this string ends up in the broker's log file. Exported so
 * every other Discord-adjacent catch block that logs a transport error uses this instead of
 * `String(error)`, which for a discord.js error can carry the request object.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown transport error";
}

async function readBody(response: { text: () => Promise<string> }): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A request function over discord.js's REST client.
 *
 * Two things about how it is configured are load-bearing. `rejectOnRateLimit` makes the client
 * throw instead of waiting out a bucket: left at its default it would sleep and then send, turning
 * a rename this broker decided to drop into one that lands minutes late painting a state that
 * stopped being true. And `queueRequest` is used rather than the convenience verbs because it
 * returns the response itself, headers included, and the headers are the only source of truth for
 * a rename budget Discord does not document.
 */
/** The library's own verb for each verb the routes above this file name. */
const VERBS = {
  GET: RequestMethod.Get,
  POST: RequestMethod.Post,
  PUT: RequestMethod.Put,
  PATCH: RequestMethod.Patch,
  DELETE: RequestMethod.Delete,
} as const;

/**
 * What the client threw, as the result the adapter classifies. Separate from the request function
 * so it can be driven with a constructed error: the request function itself needs a real client.
 */
export function outcomeOfError(error: unknown): RawResult {
  // RateLimitError reports its wait in milliseconds. It is held to the same shape a wait read
  // off a response header is held to, because it reaches the same budget and the same retry
  // loop: the library's field is typed a number and nothing about the value behind it is this
  // process's to assume.
  if (error instanceof RateLimitError) {
    return { kind: "rate-limited", retryAfterMs: usableWaitMs(error.retryAfter) };
  }
  // The client throws on a 4xx rather than returning the response, so the status is put back
  // where the adapter classifies every other one, and Discord's parsed error body rides with it so
  // the adapter can name the reason the request was refused. A 401 is the case that matters: it is
  // the only failure no retry can fix, and the client discards the token when it sees one.
  if (error instanceof DiscordAPIError) {
    return { kind: "response", status: error.status, header: () => null, body: error.rawError };
  }
  return { kind: "failed", error: describe(error) };
}

export function createRestRequest(token: string): RawRequest {
  const rest = new REST({ version: "10", rejectOnRateLimit: () => true }).setToken(token);

  return async ({ route, method, body }) => {
    try {
      const response = await rest.queueRequest({
        fullRoute: route as `/${string}`,
        method: VERBS[method],
        // Left off the verbs that carry none rather than sent as an empty object: a body on a GET or
        // a DELETE is a request shape the route does not define.
        body,
      });
      return {
        kind: "response",
        status: response.status,
        header: (name) => response.headers.get(name),
        body: await readBody(response),
      };
    } catch (error) {
      return outcomeOfError(error);
    }
  };
}
