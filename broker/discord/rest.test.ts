// The discord.js boundary's one testable half: what a thrown error becomes. The request function
// around it builds a real client against a token, so the mapping is exercised through the errors
// the library throws rather than through a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordAPIError, RateLimitError } from "discord.js";
import { outcomeOfError } from "./rest.ts";

const NO_BODY = { body: undefined, files: undefined };

test("a Discord refusal keeps its status and carries Discord's parsed error body", () => {
  // The body is what the adapter reads the code and message out of, so a refusal names its reason
  // in the log instead of reading as a bare status.
  const rawError = { message: "Cannot execute action on a system message", code: 50021 };
  const result = outcomeOfError(
    new DiscordAPIError(rawError, 50021, 403, "DELETE", "https://discord.com/api/v10/x", NO_BODY),
  );

  assert.equal(result.kind, "response");
  assert.equal(result.kind === "response" ? result.status : null, 403);
  assert.deepEqual(result.kind === "response" ? result.body : null, rawError);
  assert.equal(result.kind === "response" ? result.header("x") : "missing", null);
});

test("a rate-limit refusal reports its wait rather than an error", () => {
  const result = outcomeOfError(
    new RateLimitError({
      timeToReset: 5_000,
      limit: 5,
      method: "PATCH",
      hash: "hash",
      url: "https://discord.com/api/v10/x",
      route: "/channels/:id",
      majorParameter: "id",
      global: false,
      retryAfter: 5_000,
      sublimitTimeout: 0,
      scope: "user",
    }),
  );

  assert.deepEqual(result, { kind: "rate-limited", retryAfterMs: 5_000 });
});

test("anything else is a failed attempt described by its message alone", () => {
  assert.deepEqual(outcomeOfError(new Error("socket hang up")), {
    kind: "failed",
    error: "socket hang up",
  });
});
