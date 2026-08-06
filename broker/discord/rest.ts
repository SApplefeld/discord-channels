// The one file that touches discord.js. Everything above it works against `RawRequest`, so the
// surfaces, the budget, and the wire shapes are all testable without the library, a token, or a
// network.
import { DiscordAPIError, REST, RateLimitError, RequestMethod } from "discord.js";
import type { RawRequest } from "./adapter.ts";

/**
 * Error text safe to log. Only the message is taken: a stack or a serialized request object can
 * carry the Authorization header, and this string ends up in the broker's log file.
 */
function describe(error: unknown): string {
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
export function createRestRequest(token: string): RawRequest {
  const rest = new REST({ version: "10", rejectOnRateLimit: () => true }).setToken(token);

  return async ({ route, method, body }) => {
    try {
      const response = await rest.queueRequest({
        fullRoute: route as `/${string}`,
        method: method === "POST" ? RequestMethod.Post : RequestMethod.Patch,
        body,
      });
      return {
        kind: "response",
        status: response.status,
        header: (name) => response.headers.get(name),
        body: await readBody(response),
      };
    } catch (error) {
      // RateLimitError reports its wait in milliseconds.
      if (error instanceof RateLimitError) {
        return { kind: "rate-limited", retryAfterMs: error.retryAfter };
      }
      // The client throws on a 4xx rather than returning the response, so the status is put back
      // where the adapter classifies every other one. A 401 is the case that matters: it is the
      // only failure no retry can fix, and the client discards the token when it sees one.
      if (error instanceof DiscordAPIError) {
        return { kind: "response", status: error.status, header: () => null, body: null };
      }
      return { kind: "failed", error: describe(error) };
    }
  };
}
