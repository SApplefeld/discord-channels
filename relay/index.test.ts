// What the reply tool hands back to the model, which is the whole of this server's model-facing
// behavior. The mapping is driven on its own rather than through a running server: standing one up
// would seize stdio, which is the MCP pipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replyToolResult } from "./index.ts";
import type { ReplyStatus } from "./broker.ts";

/** The text of a result, which is all the model ever reads of it. */
function text(status: ReplyStatus): string {
  const parts = replyToolResult(status).content.map((block) =>
    block.type === "text" ? block.text : "",
  );
  return parts.join("");
}

test("a reply still going up is reported without the error flag that invites a resend", () => {
  // An error is what tells the model its message had nowhere to land, and a model told that sends
  // the answer again. This outcome means the opposite: the broker was answering right up to the
  // ceiling, so the messages may be part-way up the thread already and a second send is how the
  // operator reads the whole answer twice. `isError` is checked for absence rather than for being
  // falsy, so a later `isError: false` beside a failure would not pass for this.
  const result = replyToolResult("still-posting");

  assert.equal(Object.hasOwn(result, "isError"), false, "no error flag on a reply that may have landed");
  assert.match(text("still-posting"), /^Do not send this message again\./);
});

test("every outcome that had nowhere to land is reported as an error, and success as neither", () => {
  // The other half of the same discrimination: a status that means the message is not in the thread
  // has to reach the model as an error, or nothing ever retries it. Every failing status is listed,
  // so a status added to the wire without a word for it here is a test that has to be revisited.
  for (const status of ["no-session", "no-thread", "failed"] as const) {
    const result = replyToolResult(status);
    assert.equal(result.isError, true, `${status} must reach the model as an error`);
    assert.match(text(status), /^Not sent: /, `${status} must say the message did not land`);
  }

  const sent = replyToolResult("sent");
  assert.equal(Object.hasOwn(sent, "isError"), false);
  assert.equal(text("sent"), "Sent to the operator's thread.");
});
