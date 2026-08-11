// The permission prompt's controls: the two buttons that answer a held request from the thread, and
// what a press on one comes back as.
//
// The prompt posts as text and is edited to carry these, so the message the operator reads is the
// message they answer. Deny is drawn danger and Allow secondary rather than primary: the two sit
// side by side on a phone, and the button a thumb lands on by default must not be the one that
// grants.
//
// A `custom_id` here is a reference and never evidence, the rule every component in this broker
// holds. It carries the request ID, the nonce the desk minted for that one prompt, and which verdict
// the button means; the desk looks each of them up against what it holds, and a press whose nonce
// does not match the open request resolves to nothing. That is what makes a tap on an answered
// message still in scrollback harmless. A request ID is five letters and repeats across sessions on
// one host, so a later prompt in the same thread can draw the ID an older message already carries,
// and the nonce is the part of the reference that cannot repeat. Stripping the components on the
// way out is the courtesy rather than the control: the strip is a Discord edit, and an edit can be
// refused.
import { inertField, MAX_TOOL_NAME_LENGTH } from "./render.ts";
import type { ActionRow } from "./question-message.ts";

/** The opaque prefix every component this module builds is addressed by. */
const PREFIX = "pd";

/** Separates the fields of the answered line, as the card and the prompt separate theirs. */
const SEPARATOR = "·";

/** What a press means, once its `custom_id` has been resolved against the desk. */
export type PermissionReference = {
  requestId: string;
  nonce: string;
  behavior: "allow" | "deny";
};

/**
 * Reads a `custom_id` this module wrote.
 *
 * One shape: `pd:<request>:<nonce>:<y|n>`. Anything else, including a well-formed id naming a
 * request no thread has open or carrying a nonce the desk never minted, reads as null or resolves
 * to nothing. Nothing about the request is trusted off the wire; the two ids are opaque strings
 * that only mean something the desk agrees they mean.
 */
export function parsePermissionId(customId: string): PermissionReference | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, requestId, nonce, verdict] = parts;
  if (requestId === "" || nonce === "") return null;
  if (verdict !== "y" && verdict !== "n") return null;
  return { requestId, nonce, behavior: verdict === "y" ? "allow" : "deny" };
}

/**
 * The row a live permission prompt carries: Deny, then Allow.
 *
 * Deny leads and is styled danger, Allow follows and is styled secondary. Discord draws a row left
 * to right, so the granting button is neither the first one under a thumb nor the one the eye reads
 * as the recommended action.
 */
export function permissionControls(requestId: string, nonce: string): ActionRow[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Deny", custom_id: `${PREFIX}:${requestId}:${nonce}:n` },
        { type: 2, style: 2, label: "Allow", custom_id: `${PREFIX}:${requestId}:${nonce}:y` },
      ],
    },
  ];
}

/**
 * The message an answered request is rewritten to, whichever way it was answered.
 *
 * The tool name rides along because this edit replaces the only copy of the prompt the thread has,
 * and a bare verdict line would leave scrollback saying something was allowed without saying what.
 * It is the tool's own string, so it goes through `inertField` for the reason the prompt's fields
 * do: the one channel permission is granted in is the one channel a crafted field must not be able
 * to draw a mention or a quote in. A name that neutralizes to nothing is left off rather than drawn
 * as an empty field.
 *
 * `delivered` is whether the verdict reached the session, and it draws its own line rather than the
 * verdict's. An answer that was applied here and arrived nowhere leaves a session still parked, and
 * this edit replaces the loudest message in the thread: a green tick over a tool that never ran
 * would tell the operator the opposite of what is true, which is the one direction this surface is
 * never allowed to fail in.
 */
export function renderPermissionOutcome(input: {
  requestId: string;
  toolName: string;
  behavior: "allow" | "deny";
  delivered: boolean;
}): string {
  const verdict = input.behavior === "allow" ? "Allowed" : "Denied";
  const head = input.delivered
    ? `${input.behavior === "allow" ? "✅" : "⛔"} **${verdict}**`
    : `⚠️ **${verdict}, not delivered**`;
  const tool = inertField(input.toolName, MAX_TOOL_NAME_LENGTH);
  return [head, `\`${input.requestId}\``, tool].filter((part) => part !== "").join(` ${SEPARATOR} `);
}

/** What a press against a request the desk no longer holds is told. */
export const PERMISSION_CLOSED_NOTICE = "That permission request is no longer open.";
