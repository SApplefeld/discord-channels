// Rendering for the two passive Discord surfaces: the thread name and the starter-message card.
//
// Everything here is pure text and every input is untrusted. A session name and a tool name come
// from a local process that may announce itself as anything at all, so neutralization happens here,
// at the render site, rather than at intake: intake owns storage safety (bounded, no control
// characters) and the renderer owns display safety. Suppressing pings is the transport's half of
// the same job, via `allowed_mentions`.
import { isInvisible, sliceCodePoints, withoutInvisible } from "../sanitize.ts";
import type { SessionView, SurfaceState } from "./state.ts";

/**
 * Glyph first, because the channel's thread list truncates hard on mobile and the actionable bit
 * has to survive truncation.
 */
const GLYPHS: Record<SurfaceState, string> = {
  working: "⚙",
  "needs you": "⏸",
  idle: "✅",
  exited: "⚠",
};

/** Separates the name from the state in a thread title. */
const SEPARATOR = "·";

/** Discord's ceiling on a thread name. */
export const MAX_THREAD_NAME_LENGTH = 100;

/**
 * The ceiling this renderer holds a card to, below Discord's 2000-character message limit. The
 * card is assembled from fields that are individually capped at intake, so this is the second
 * bound rather than the first, and it is stated here so the two caps are not a coupling that has
 * to be discovered by exceeding it.
 */
export const MAX_CARD_LENGTH = 1_900;

// Display syntax that would otherwise let a name change the shape of the card around it. The
// angle bracket is in here with the markdown because Discord's chip syntax lives inside it:
// `<t:...:R>` renders as a live relative timestamp, which would spoof the heartbeat this card
// exists to carry, and `<@id>`, `<#id>`, and `<:name:id>` render as a mention or an emoji.
const MARKDOWN = /[\\`*_~|<>#[\]()]/g;

/**
 * Strips the invisible reordering characters and collapses runs of whitespace to one space.
 *
 * For a title or a card field, which are single-line by construction. The class itself is shared
 * with the path that carries text to the model, so the two cannot come to disagree about which
 * characters are allowed to be invisible.
 */
function visible(value: string): string {
  return [...value]
    .filter((character) => !isInvisible(character.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Untrusted text for the body of a message: visible, and with markdown escaped so it renders as
 * the characters it contains rather than as syntax. `@everyone` and `@here` survive as text on
 * purpose; the transport's `allowed_mentions` is what stops them pinging anyone.
 */
export function inertText(value: string): string {
  return visible(value).replace(MARKDOWN, (character) => `\\${character}`);
}

/**
 * Untrusted text for a thread name. Thread names render no markdown, so escaping it there would
 * only put backslashes in front of ordinary characters.
 */
export function inertName(value: string): string {
  return visible(value);
}

/** Discord's ceiling on a message, less room for the cut marker this renderer adds. */
export const MAX_MESSAGE_LENGTH = 1_900;

/**
 * Untrusted text for a message posted into a thread: a reply from Claude, or a notice the broker
 * writes beside one.
 *
 * Unlike a card, this keeps markdown. A reply is prose the operator reads, code blocks and lists
 * included, and escaping it would trade the whole readability of the surface for nothing: mentions
 * are already made inert by the transport's `allowed_mentions`, and the card's other reason to
 * escape (a `<t:...:R>` chip spoofing the heartbeat) has no counterpart in a message that carries
 * no rendered state. What is still stripped is the invisible class, which can reorder or hide text
 * with no visual trace at all, and which no reply has a use for.
 *
 * Whitespace is left exactly as it arrived, apart from the trim: a reply is multi-line by nature
 * and a code block in one carries meaning in its indentation, so collapsing runs of spaces would
 * mangle the most useful thing a reply can contain.
 */
export function inertMessage(value: string): string {
  return fit(withoutInvisible(value).trim(), MAX_MESSAGE_LENGTH);
}

/**
 * Room for the two untrusted halves of a permission prompt.
 *
 * They are cut here, before the message is assembled, rather than left to the whole message's cap.
 * The cap truncates the tail, and the tail is where a long tool input would push the mention, the
 * request ID, and the instructions for answering off the end of the one message in this system
 * that exists to be answered.
 */
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PREVIEW_LENGTH = 900;

/** What a field renders as when the tool supplied nothing for it. */
const NOTHING = "(none)";

/**
 * One untrusted prompt field: neutralized, cut to its budget, and told apart from a whole one.
 *
 * The cut is named in the label rather than left to the ellipsis. A tool input is attacker
 * influenced, so it can front-load harmless content and push the part worth refusing past the cut,
 * and an operator approving from a phone would be approving a view they had no way to know was
 * partial. The cap itself stays: it is what keeps the request ID and the instructions for answering
 * inside the message at all.
 */
function promptField(label: string, value: string, limit: number): string {
  const whole = inertText(value);
  const shown = fit(whole, limit);
  if (shown === "") return `${label}: ${NOTHING}`;
  return shown === whole ? `${label}: ${shown}` : `${label} (cut): ${shown}`;
}

/**
 * The permission prompt: the one message this broker writes that deliberately mentions someone.
 *
 * The mention is composed here from the operator's own ID, and every untrusted field goes through
 * `inertText`, which escapes the angle brackets Discord's mention syntax lives inside. So the only
 * mention this message can contain is the one written on this line, and the transport names that
 * same single ID as the only one it will resolve.
 *
 * `description` and `input_preview` come from a tool call, which anything the session has read can
 * steer. They are rendered last and as inert text, because this message pings a phone and asks a
 * yes-or-no question: text that reads like an instruction, or that spoofs a second prompt, is the
 * attack this ordering and this escaping are against.
 */
export function renderPermissionRequest(input: {
  operatorId: string;
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}): string {
  const id = input.requestId;
  return [
    `<@${input.operatorId}> **Permission needed** ${SEPARATOR} \`${id}\``,
    `Reply \`y ${id}\` to allow or \`n ${id}\` to deny.`,
    promptField("Tool", input.toolName, MAX_TOOL_NAME_LENGTH),
    promptField("What", input.description, MAX_DESCRIPTION_LENGTH),
    promptField("Input", input.inputPreview, MAX_PREVIEW_LENGTH),
  ].join("\n");
}

/** The label a session is known by. A session launched without the wrapper carries no name. */
function displayName(view: SessionView): string {
  const named = view.name === null ? "" : inertName(view.name);
  // The session ID is a payload field from the same untrusted process as the name, so the fallback
  // is neutralized before it is cut rather than after: a slice of raw text can end mid-override.
  return named === "" ? `session ${inertName(view.sessionId).slice(0, 8)}` : named;
}

/**
 * `<glyph> <session-name> <separator> <state>`.
 *
 * The name is what gets shortened when the whole thing is too long: the glyph and the state are
 * the parts a truncating list view must not eat.
 */
export function threadName(view: SessionView, state: SurfaceState): string {
  const prefix = `${GLYPHS[state]} `;
  const suffix = ` ${SEPARATOR} ${state}`;
  const room = MAX_THREAD_NAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${fit(displayName(view), room)}${suffix}`;
}

/**
 * Truncates to a length in code points, never in UTF-16 units: cutting an astral-plane character
 * in half leaves a lone surrogate, which is not valid UTF-8 for the request body.
 */
function fit(value: string, limit: number): string {
  const characters = [...value];
  if (characters.length <= limit && value.length <= limit) return value;

  // Cut on code points, then keep dropping them until the UTF-16 length fits too. Which of the
  // two Discord counts is not worth guessing at: holding both bounds is correct either way.
  let kept = [...sliceCodePoints(value, Math.max(limit - 1, 0))];
  let fitted = `${kept.join("")}…`;
  while (fitted.length > limit && kept.length > 0) {
    kept = kept.slice(0, -1);
    fitted = `${kept.join("")}…`;
  }
  return fitted;
}

/**
 * Age in coarse buckets. Coarse on purpose: the card is only rewritten when its text changes, so a
 * heartbeat rendered to the second would spend an edit on every refresh.
 */
export function heartbeat(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The starter message: the thread's detail card, edited in place forever after. Six fields, each
 * one named, and no session field that is not one of them.
 */
export function renderCard(view: SessionView, state: SurfaceState, now: number): string {
  const since = view.endedAt ?? view.lastHookAt;
  const card = [
    `${GLYPHS[state]} **${inertText(displayName(view))}** ${SEPARATOR} ${state}`,
    `Session: ${inertText(view.sessionId)}`,
    `Host: ${inertText(view.host)}`,
    `State: ${state}`,
    `Last tool: ${view.lastTool === null ? "none yet" : inertText(view.lastTool)}`,
    `Turns: ${view.turnCount}`,
    `Heartbeat: ${heartbeat(Math.max(now - since, 0))}`,
  ].join("\n");
  return fit(card, MAX_CARD_LENGTH);
}
