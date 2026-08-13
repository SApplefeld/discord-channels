// Rendering for the two passive Discord surfaces: the thread name and the starter-message card.
//
// Everything here is pure text and every input is untrusted. A session name and a tool name come
// from a local process that may announce itself as anything at all, so neutralization happens here,
// at the render site, rather than at intake: intake owns storage safety (bounded, no control
// characters) and the renderer owns display safety. Suppressing pings is the transport's half of
// the same job, via `allowed_mentions`.
import { isInvisible, sliceCodePoints, withoutInvisible } from "../sanitize.ts";
import { modelRank } from "../registry.ts";
import type { BackgroundTask, ModelFallback } from "../registry.ts";
import type { SessionView, SurfaceState } from "./state.ts";

/**
 * Glyph first, because the channel's thread list truncates hard on mobile and the actionable bit
 * has to survive truncation.
 *
 * Exported because the fleet card's session rows draw the same state vocabulary as the thread
 * titles: one table, so a state cannot carry one glyph in the channel list and another on the card
 * a reader is comparing it against.
 */
export const GLYPHS: Record<SurfaceState, string> = {
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
 * Display syntax a table cell drawn outside a fence may not carry, which is `MARKDOWN` less the
 * emphasis marks.
 *
 * Emphasis is what the model wrote the cell in, and the per-row rendering is the one table shape
 * with no fence to make it inert by position, so escaping it there reaches the operator as a visible
 * asterisk in front of every bold word a comparison table contains. Every character that can draw a
 * chip, a quote bar, a spoiler, a heading, or a fence is still escaped; what is given up is that a
 * cell can compose text reading like the bold heading this rendering draws around a row. That is the
 * trade `inertMessage` already makes for mirrored prose, on its own reasoning: what the escape stops
 * is content that renders as a broker surface, not content that reads like one. A cell is the same
 * class of text as the prose around it, so it is held to the same line.
 */
const CELL_MARKDOWN = /[\\`|<>#[\]()]/g;

/**
 * Untrusted text for a table cell drawn outside a fence: visible, and escaped everywhere the shape
 * of the surface could be changed, but not where only its emphasis could.
 */
function inertCell(value: string): string {
  return visible(value).replace(CELL_MARKDOWN, (character) => `\\${character}`);
}

/**
 * Untrusted text for a thread name. Thread names render no markdown, so escaping it there would
 * only put backslashes in front of ordinary characters.
 */
export function inertName(value: string): string {
  return visible(value);
}

/**
 * Untrusted text for a message component's label or description, bounded to what that field
 * accepts.
 *
 * The third escape beside `inertText` and `inertName`, and the distinction is what the surface
 * renders. A component's label and description are plain text: Discord draws no markdown and
 * resolves no chip inside them, so the markdown escape would reach the operator as a visible
 * backslash in front of every underscore and asterisk an option label contains. What is stripped is
 * the invisible class, which can reorder or hide text with no visual trace on any surface, and the
 * length, because Discord refuses the whole message when one field is over its field limit.
 */
export function inertLabel(value: string, limit: number): string {
  return fit(visible(value), limit);
}

/**
 * Untrusted text for a line of message content, escaped and bounded.
 *
 * The pairing `inertLabel` is not: content is markdown, so a field composed into it goes through
 * the full escape, and the bound is applied to the escaped text because that is what the reader
 * sees and what the message's budget is spent on.
 */
export function inertField(value: string, limit: number): string {
  return fit(inertText(value), limit);
}

/**
 * What a backtick becomes inside a fenced block, since no escape of one holds there.
 *
 * A plain apostrophe rather than a modifier letter or a zero-width character: it renders in every
 * client and every font, it is not in the invisible class `visible` strips, and it is the closest
 * thing to a backtick that cannot be part of a fence delimiter.
 */
const BLOCK_BACKTICK = "'";

/** Every backtick, whatever it sits beside. None of them reaches a fenced body. */
const BLOCK_FENCE = /`/g;

/**
 * Untrusted text for a line inside a fenced block.
 *
 * A fence renders no markdown, resolves no chip, and honors no quote marker, so the full escape
 * would reach the operator as a visible backslash in front of every underscore and asterisk a
 * real tool name contains. `visible` is what keeps a field from composing a body line of its own:
 * the newline is in the invisible class it strips, and any whitespace run left over collapses to
 * one space.
 *
 * One character needs handling, and escaping is not what handles it.
 *
 * A fenced block honors no backslash escape, which is a property of the client rather than of
 * Markdown generally and is why nothing here escapes anything: a backslash is drawn as itself and
 * consumes nothing after it, so a Windows path reads as the path that was written, while a doubled
 * one would reach the operator doubled. That matters most on the tool input of a permission prompt,
 * where the characters on screen are the thing being approved.
 *
 * A backtick is therefore replaced rather than escaped, since an escape of one would arrive as a
 * backslash and a live backtick. Every backtick becomes the substitute above, so a fenced body
 * carries none at all, and that is the only bound here that cannot be composed around. A longer
 * opening fence is not an alternative: a block opens on exactly three backticks and reads a fourth
 * as content, so an inner triple closes a four-backtick fence too.
 */
export function inertBlock(value: string): string {
  return visible(value).replace(BLOCK_FENCE, BLOCK_BACKTICK);
}

/** The `inertField` pairing for a fenced line: block-inert, and bounded on the escaped text. */
export function inertBlockField(value: string, limit: number): string {
  return fit(inertBlock(value), limit);
}

/** Discord's ceiling on a message, less room for the cut marker this renderer adds. */
export const MAX_MESSAGE_LENGTH = 1_900;

/**
 * Text for a message this broker composes and posts into a thread: a notice, a permission prompt,
 * or a message a caller has already neutralized.
 *
 * Unlike a card, this keeps markdown, and it keeps the chip syntax too. Both are load-bearing on
 * this path: the permission prompt and the question alert deliberately mention someone, and
 * escaping their `<@id>` would render the mention as characters and drop the ping a parked session
 * is waiting to be answered through. That is safe only because every string arriving here is either
 * composed by this renderer, with each untrusted field already through `inertText`, or neutralized
 * by its caller. Text a model or a session authored reaches Discord through `renderAnswer` or
 * `renderMirror` instead, and both of those neutralize the chip and quote syntax before it gets
 * here. What is still stripped is the invisible class, which can reorder or hide text with no
 * visual trace at all, and which no message has a use for.
 *
 * Whitespace is left exactly as it arrived, apart from the trim: a reply is multi-line by nature
 * and a code block in one carries meaning in its indentation, so collapsing runs of spaces would
 * mangle the most useful thing a reply can contain.
 */
export function inertMessage(value: string): string {
  return fit(withoutInvisible(value).trim(), MAX_MESSAGE_LENGTH);
}

/**
 * What a mirrored message carries: the operator's console prompt, the turn's final assistant
 * reply, or a mid-turn chunk of assistant text the transcript tailer read while the turn is
 * still running.
 *
 * Named here rather than in the routing layer that delivers it, because the attribution and the
 * splitting below are what the distinction is for, and one definition is what keeps the router
 * asking for a kind this renderer knows how to draw.
 */
export type MirrorKind = "prompt" | "reply" | "interim";

/**
 * What every mirrored message opens with, composed here and by nothing else. It rides on every
 * message of a split reply, not only the first: a message scrolled to on a phone carries its own
 * attribution or it carries none.
 *
 * **A quoted message is the operator's text and an unquoted one is Claude's**, which is the whole
 * distinction at a scrolling glance, so the quoting is a property of the renderer rather than of
 * what the text happens to contain.
 *
 * A prompt opens with `>>>`, which quotes every line after it in the message rather than one line.
 * A single `>` would quote the body only until Discord found a reason to stop, and a blank line or a
 * code fence is such a reason, so a multi-paragraph paste would arrive half quoted. A reply's marker
 * carries no quote syntax at all, so nothing in a reply opens with a quote bar.
 *
 * The quote marker is also the one piece of syntax mirrored content cannot draw: `<` and `>` are
 * escaped out of mirrored text, so a `>` arriving in a prompt or a reply reaches Discord as `\>`,
 * the character rather than the marker. That is what stops a reply from drawing a block that reads
 * as the operator having typed something. It is the operator-attributed block that needs to be
 * unforgeable; content reproducing the reply marker inside a reply claims nothing it is not already.
 */
const ATTRIBUTION: Record<MirrorKind, string> = {
  prompt: ">>> ⌨ typed at the console\n",
  reply: "✨ Claude\n",
  // Mid-turn narration: Claude's own text like a reply, so unquoted like a reply, and marked
  // `working` so a reader scrolling later can tell narration from the turn's final word.
  interim: "✨ Claude · working\n",
};

/**
 * What a reply tool message opens with, on every message of a split one.
 *
 * Kept apart from the mirror's two kinds, and worded and glyphed apart from them, because the two
 * are different acts: a mirrored reply is the turn's final text repeated for someone away from the
 * keyboard, and this is Claude addressing the operator in the thread on purpose. A bare message with
 * no line of its own reads as a continuation of whatever sits above it.
 *
 * Unquoted, like the mirror's reply marker and for the same reason: the quoted block is what a
 * reader takes for the operator's own typing, and it is that block alone that has to be unforgeable.
 * This line is Claude-authored text opening a Claude-authored message, so content reproducing it
 * claims nothing the message does not already say.
 */
const ANSWER_ATTRIBUTION = "📣 Claude · answer\n";

// Discord's chip syntax lives inside the angle brackets: `<@id>` draws a mention pill, `<t:...:R>`
// a live relative timestamp, `<#id>` a channel link. Escaped, each renders as the characters that
// were typed. That is what stops a mirrored prompt or reply from drawing a convincing copy of a
// permission prompt or a broker notice inside the one channel the operator answers prompts in;
// `allowed_mentions` stops those chips pinging anyone but not from rendering. It is also what makes
// the attribution above unforgeable, since the quote marker is an escaped character too. Every
// other piece of markdown survives, because a reply is prose with code blocks and lists in it and
// escaping all of it would trade the whole readability of the surface away. What this does not stop
// is content writing bold text that reads like a notice; what it does stop is content that renders
// as one.
//
// The escape's contract is that it covers every character Discord can build a chip or a quote from
// outside a fenced code block, and that it leaves the inside of a fence exactly as it was written.
// Two reasons for the exemption. Discord shows a fence's contents as the characters they are, so
// text there is not the surface a chip or a quoted line can be drawn on. And an escape there would
// be visible: Discord processes no escapes inside a fence, so every arrow, generic, and comparison
// in mirrored code would carry a backslash, which is most of what a mirrored reply is made of.
//
// Where the fence is, is `scanFences` below, and it is the same reading the splitter uses to
// re-open an interrupted block. One model, deliberately: a second one beside it could disagree with
// it, and the disagreement would be an unescaped chip in a region one of them thought was code.
const CHIPS = /[<>]/g;

/**
 * The cap on a mirrored prompt, in code points. Beyond it the prompt is shortened and says so.
 *
 * The one capped mirrored surface. A prompt is frequently a paste of a log or a file, and the
 * argument against truncating protects the assistant's replies, which are written to be read, not
 * the operator's own dumps of text they already have. A reply is never cut at any length.
 */
export const MAX_MIRRORED_PROMPT_LENGTH = 16_384;

/** What a shortened prompt carries in place of the tail, so the cut is visible rather than silent. */
const SHORTENED = "(long paste shortened in mirror)";

/** The code fence delimiter, and what closing and re-opening one across a boundary costs. */
const FENCE = "```";

/**
 * How much of a fence's info string is carried across a message boundary before it is dropped.
 *
 * Derived from the message ceiling, and small: an info string is a language token, and what gets
 * re-opened on every message of a split block has to leave that message room to carry code. An
 * info string longer than this is carried as a bare fence rather than truncated, because half a
 * language name is not the language. The bound is what keeps a crafted one out of the per-message
 * overhead, where an unbounded one would leave no room for content and turn one reply into a
 * message per character.
 */
const MAX_FENCE_INFO_LENGTH = Math.floor(MAX_MESSAGE_LENGTH / 100);

/**
 * The fewest code points a hard cut takes, whatever the per-message overhead works out to.
 *
 * Unreachable as the numbers stand, since the overhead is the attribution plus two fence lines
 * against a ceiling of `MAX_MESSAGE_LENGTH`. It is here because the failure it forecloses is not
 * proportionate: an overhead that swallowed the ceiling would emit a message per code point, which
 * renders nothing and spends the event loop and the write budget doing it.
 */
const MIN_HARD_CUT = Math.floor(MAX_MESSAGE_LENGTH / 8);

/**
 * Room for the two untrusted halves of a permission prompt.
 *
 * They are cut here, before the message is assembled, rather than left to the whole message's cap.
 * The cap truncates the tail, and the tail is where a long tool input would push the mention, the
 * request ID, and the instructions for answering off the end of the one message in this system
 * that exists to be answered.
 */
export const MAX_TOOL_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;

/**
 * Room for the tool input, which is the field the operator actually reads before approving.
 *
 * Larger than the other two because it is the one carrying the thing being approved, and because it
 * is drawn in a fenced block whose lines are wrapped rather than run on. The three caps together sit
 * inside the message ceiling with the mention, the request ID, the answering instructions, and the
 * fence's own lines still in front of them, which is what the cap is for: the tail is what a message
 * truncates, and the tail is where the way to answer lives.
 */
const MAX_PREVIEW_LENGTH = 1_200;

/** What a field renders as when the tool supplied nothing for it. */
const NOTHING = "(none)";

/**
 * The card's room for a tool-input preview, in code points.
 *
 * Small on purpose. The preview answers one question, what the running tool is working on, and it
 * is drawn in a block of its own on a surface read at a glance on a phone. A budget large enough to
 * carry a whole command would spend several lines of the card on one tool call, where a real path,
 * which is what the preview usually is, fits inside this.
 */
export const MAX_TOOL_INPUT_PREVIEW = 100;

/**
 * The most of a model name this renderer carries, in code points. A real model string is a short
 * id, decorated at most the way `claude-opus-5[1m]` is, so anything longer is not a name worth
 * showing: the tailer treats one past this bound as absent rather than truncating it, because half
 * an id names nothing, and the bound is what keeps a crafted one out of the card's own ceiling,
 * where the final fit() would drop the heartbeat instead.
 *
 * Exported because the transcript reader holds transcript-sourced model strings to it: one bound in
 * one place, so what is stored and what is drawn cannot disagree about what a name is.
 */
export const MAX_MODEL_NAME_LENGTH = 64;

/**
 * The most of a downgrade record's own short words this renderer carries: the refusal category
 * (measured `cyber`) and the consent answer (measured `cancelled`). Shorter than a model name for
 * the same reason the id bound exists, and applied at the reader too, where an over-long value
 * reads as absent.
 */
export const MAX_MODEL_DETAIL_LENGTH = 32;

/**
 * True while `model` runs below the model the session opened with, which is what the card marks.
 * The rank is the registry's own, so the marker and the downgrade record the registry attaches to
 * a change cannot disagree about what a family is.
 *
 * An unrankable name on either side answers false: the direction is unknown, and a marker drawn on
 * a guess would tell the operator a session is degraded when it may have been switched up by hand.
 * Same family answers false too, which is what makes the upward direction, the operator's own
 * switch-back, render plainly.
 */
function isBelowModel(model: string, openingModel: string): boolean {
  const now = modelRank(model);
  const opened = modelRank(openingModel);
  if (now === null || opened === null) return false;
  return now > opened;
}

/**
 * A context size in thousands, which is the figure at the width the card has for it: `348k`.
 *
 * Rounded rather than exact because nothing a reader decides from this line turns on the last three
 * digits, and it is drawn in a fixed-width row. A size below a thousand is drawn as itself, since
 * there is nothing to round it to.
 */
function compactTokens(value: number): string {
  const whole = Math.max(Math.trunc(value), 0);
  return whole < 1_000 ? String(whole) : `${Math.round(whole / 1_000)}k`;
}

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
 * The tool input, drawn in a fenced block under its label.
 *
 * Monospace because this field is a command, a path, or a patch, and read at a glance before it is
 * approved. Drawn whole, on one line, and never broken here: a Discord client wraps a fenced line
 * itself rather than scrolling it sideways, and it wraps to the rendered width of the window it is
 * read in, not to any column count. There is therefore no break this renderer could insert that is
 * right for the reader, only one narrower than theirs, and it would be a break the command does not
 * have on the field whose exact characters are the thing being approved.
 *
 * Block-inert rather than markdown-inert, since the text sits inside a fence: that is the escape
 * that reaches a backtick, which is the one character a fence still gives meaning to. The cut is
 * named in the label exactly as the unfenced fields name theirs, because an operator approving from
 * a phone must not be reading a partial command without being told it is partial.
 */
function promptPreview(label: string, value: string, limit: number): string {
  const whole = inertBlock(value);
  const shown = fit(whole, limit);
  if (shown === "") return `${label}: ${NOTHING}`;
  return [shown === whole ? `${label}:` : `${label} (cut):`, fenced([shown])].join("\n");
}

/**
 * The permission prompt: one of the two messages this broker writes that deliberately mention
 * someone, the question alert below being the other.
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
    promptPreview("Input", input.inputPreview, MAX_PREVIEW_LENGTH),
  ].join("\n");
}

/**
 * The most of a task id the notice below will carry, in code points. A real id is a short token,
 * so anything longer is not an id worth showing: it is treated as absent rather than truncated,
 * because half an id identifies nothing, and the bound is what keeps a crafted pair from turning
 * the one-line notice into a message-length paste.
 */
const MAX_TASK_ID_LENGTH = 64;

/**
 * The first `<task-id>…</task-id>` pair's content in a wake prompt. Bounded lazily so the scan
 * costs one pass over the text; the length bound above is applied to what it captures.
 */
const TASK_ID = /<task-id>([\s\S]*?)<\/task-id>/;

/**
 * The one-line notice a background task's wake prompt compresses to: broker-composed text with a
 * single neutralized untrusted field, following `renderPermissionRequest`'s pattern.
 *
 * `text` is the whole injected prompt, untrusted conversation content that arrives untruncated
 * (the mirror route drops an oversized body whole rather than cutting it, so no pair here can be
 * the front half of a cut). The scan runs on the invisible-stripped text, the same reading the
 * wake recognizer matches the prompt on, so the two cannot disagree about one message: an
 * invisible character inside the tag literals would otherwise hide a pair from this scan that the
 * recognizer's reading still saw. The id is the only part of the prompt this notice repeats, and
 * it goes through `inertText` because the notice lands in the one channel the operator answers
 * permission prompts in: an id is attacker-influenceable text, and one that could draw a chip or
 * a quote would spoof exactly the surface this line exists to keep quiet. An id that is absent,
 * empty once trimmed, or over the length bound leaves the bare line, never a throw: whatever the
 * prompt carries, the notice composes.
 */
export function renderTaskNotice(text: string): string {
  const line = "📨 background task finished";
  const match = TASK_ID.exec(withoutInvisible(text));
  if (match === null) return line;
  const id = match[1].trim();
  if (id === "" || [...id].length > MAX_TASK_ID_LENGTH) return line;
  const shown = inertText(id);
  return shown === "" ? line : `${line} ${SEPARATOR} ${shown}`;
}

/**
 * Room for the untrusted parts of a question notice: the question itself, its header, and each
 * option label. Cut here, before the message is assembled, for `renderPermissionRequest`'s
 * reason: no single field may crowd out the mention and the line saying a question is open. The
 * per-field cuts alone do not hold the whole notice inside one message (four capped questions
 * compose past the ceiling); `renderQuestionNotice`'s own whole-message bound below owns that.
 * The cut is left to `fit`'s ellipsis rather than labelled, because nothing here is approved from
 * a partial view: the notice only sends the operator to the console, where the whole question is.
 */
const MAX_QUESTION_LENGTH = 500;
const MAX_QUESTION_HEADER_LENGTH = 100;
export const MAX_OPTION_LABEL_LENGTH = 100;

/**
 * Room for an option's description inside a select menu, Discord's own ceiling on that field. A
 * message carrying one field over its limit is refused whole, so the cap is a wire requirement
 * rather than a readability choice.
 *
 * It bounds the menu and nothing else. The description a reader keeps is `MAX_HELD_DESCRIPTION_LENGTH`
 * below, because the message body draws the same text with no such ceiling over it.
 */
export const MAX_OPTION_DESCRIPTION_LENGTH = 100;

/**
 * The most of an option's description the reader keeps, in code points.
 *
 * Far above the select field's own ceiling, and that gap is the point: a description is where an
 * option says what choosing it costs, so it is the field the operator actually decides on. Bounding
 * it at the menu's limit would mean the text was gone before any surface could choose to draw more,
 * and the body has room for it. An anti-abuse bound on what a held entry and the digest taken over
 * it can carry, not a layout bound, and it is set roomily enough that any field one message can
 * carry arrives whole. The reader cuts to it through `fit`, so a description this bound shortens
 * reaches every surface already marked: nothing downstream of the reader can tell a text it was
 * handed whole from one that was cut, so the cut says so itself. The real distribution of
 * `AskUserQuestion` calls runs far below it, with the longest measured description under 700 code
 * points.
 */
export const MAX_HELD_DESCRIPTION_LENGTH = 1_500;

/**
 * One option of an `AskUserQuestion` question: the label the answer is given as, and the short
 * gloss the tool wrote beside it. Both are untrusted conversation content.
 *
 * The label is held verbatim, because it is the string an answer is submitted as and Claude Code
 * matches it against the option the call declared; a bounded copy would submit an answer the picker
 * never offered. The description is bounded at the reader too, but generously, at
 * `MAX_HELD_DESCRIPTION_LENGTH` rather than at any one surface's field limit: two surfaces draw it
 * at two different widths, so the reader's bound is what keeps an unbounded one out of the held
 * entries and the digests taken over them, and each surface cuts to its own room. Null when the call
 * carried none.
 */
export type AskedOption = {
  label: string;
  description: string | null;
};

/**
 * One question an `AskUserQuestion` call is holding a session on: bounded structured data parsed
 * from the question's `PreToolUse` hook post at emission, or from the session's own transcript at
 * resolution, both through the tailer's one bounded reader, because the console's picker is
 * otherwise invisible from the thread. Defined here rather than in the tailer, the `MirrorKind`
 * pattern: this renderer owns the vocabulary it knows how to draw, and the tailer imports the
 * type alone. Every string in it is untrusted conversation content.
 */
export type AskedQuestion = {
  question: string;
  /** The tool's short topic label for the question; null when the call carried none. */
  header: string | null;
  multiSelect: boolean;
  /** The options, in the tool's order. */
  options: readonly AskedOption[];
};

/** What a cut notice ends with, naming how many questions the console holds beyond the cut. */
function moreQuestionsTail(count: number): string {
  return `(+${count} more question${count === 1 ? "" : "s"} at the console)`;
}

/**
 * The open-question alert: the second message this broker writes that deliberately mentions
 * someone, beside the permission prompt, and safe for the same reason: the mention is composed
 * here from the operator's own ID, and every untrusted field goes through `inertText`, which
 * escapes the angle brackets Discord's mention syntax lives inside. A null `operatorId` composes
 * the same notice with no mention at all: the quiet tier for a thread already pinged past a
 * person's reading pace.
 *
 * Unlike the permission prompt, this message asks for nothing in the thread: it carries enough of
 * the question for the operator to decide what to do about it, and nothing to do it with. It is
 * what every question gets first, and what a question the thread cannot answer keeps; the
 * interactive message `renderQuestionPrompt` draws replaces it by edit once the components that
 * answer the hold exist.
 *
 * The headline names no surface, because at the moment this is composed there is none to name. A
 * held `PreToolUse` hook response blinds the console for as long as it is held, so a notice
 * pointing at a console picker is untrue for exactly the window this message is the only thing in
 * the thread; and the paths that leave this notice standing all release the hold, which renders
 * that picker a moment later. Saying a question is open is true under both.
 *
 * The whole notice is bound to one message, because the per-field cuts alone cannot do that: four
 * questions at their caps compose past four thousand units, and leaving the overflow to the
 * writer's own whole-message cut would eat the tail silently. Questions are appended whole, each
 * with its lines, and the first that would not leave room for the closing tail ends the message
 * with a line naming how many the console still holds. The first question always fits by
 * arithmetic: the alert line is at most about 80 units, a Q line at most 620 (3 + a 100-unit
 * header + 2 + a 500-unit question + a 15-unit suffix), an Options line at most 418 (9 + four
 * 100-unit labels + three separators), and the tail at most 34, about 1,160 in all against the
 * 1,900 ceiling, so the notice never degenerates to a bare tail. Measured in UTF-16 units, the
 * larger of the two counts a length could mean, so holding it holds the code point count too.
 *
 * A question with no options renders without an Options line rather than as an error: the console
 * always offers a free-form "Other" answer, so an empty list is a shape this tool really
 * produces. A header or a label that neutralizes to nothing renders as absent, and an empty
 * questions array still composes the alert line: whatever the call carried, the notice composes,
 * never a throw.
 */
export function renderQuestionNotice(input: {
  operatorId: string | null;
  questions: readonly AskedQuestion[];
}): string {
  const mention = input.operatorId === null ? "" : `<@${input.operatorId}> `;
  const lines = [`${mention}❓ **Waiting on you** ${SEPARATOR} a question is open`];
  let used = lines[0].length;
  for (const [index, asked] of input.questions.entries()) {
    const header = asked.header === null ? "" : fit(inertText(asked.header), MAX_QUESTION_HEADER_LENGTH);
    const prefix = header === "" ? "" : `${header}: `;
    const suffix = asked.multiSelect ? " (multi-select)" : "";
    const held = [`Q: ${prefix}${fit(inertText(asked.question), MAX_QUESTION_LENGTH)}${suffix}`];
    const labels = asked.options
      .map((option) => fit(inertText(option.label), MAX_OPTION_LABEL_LENGTH))
      .filter((label) => label !== "");
    if (labels.length > 0) held.push(`Options: ${labels.join(` ${SEPARATOR} `)}`);
    // Each line costs its own length plus the newline that joins it. The tail's room is reserved
    // on every question, the last included: one rule with no branch to get wrong, at the price of
    // at most one tail's width of unused room on a notice that fills to the brim.
    const cost = held.reduce((sum, line) => sum + 1 + line.length, 0);
    const remaining = input.questions.length - index;
    if (used + cost + 1 + moreQuestionsTail(remaining).length > MAX_MESSAGE_LENGTH) {
      lines.push(moreQuestionsTail(remaining));
      return lines.join("\n");
    }
    lines.push(...held);
    used += cost;
  }
  return lines.join("\n");
}

/**
 * The label a session is known by. A session launched without the wrapper carries no name.
 *
 * Exported because every surface that names a session has to name it the same way: the thread
 * title, the session's own card, and the fleet card's session rows all read this one fallback, so
 * a session with no name cannot be "session 0f3c9d21" on one surface and blank on another.
 *
 * The output is stripped but not escaped, unlike the neutralizers above it: a thread name renders no
 * markdown, which is the surface this was written for. A caller composing it into message content
 * has to put it through `inertText` or `inertField` first, or a session names itself in bold.
 */
export function displayName(view: SessionView): string {
  const named = view.name === null ? "" : inertName(view.name);
  // The session ID is a payload field from the same untrusted process as the name, so the fallback
  // is neutralized before it is cut rather than after: a slice of raw text can end mid-override.
  return named === "" ? `session ${inertName(view.sessionId).slice(0, 8)}` : named;
}

/**
 * The state as a reader sees it, which for a session waiting on dispatched work is the state plus
 * how many tasks it is waiting on.
 *
 * The count rides the state rather than sitting elsewhere on the card because the four states
 * cannot express waiting on agents at all: without it a session blocked on a fan-out reads as
 * ordinary work, and the operator has no way to tell a turn that is thinking from one that is
 * waiting on eleven agents. It is counted rather than listed here so the thread title, which mobile
 * truncates hard, carries the fact in the few characters that survive. The word is "tasks" rather
 * than "agents" because the count covers both kinds the table reports, and a session waiting on
 * two backgrounded shells is not waiting on two agents.
 */
function stateLabel(view: SessionView, state: SurfaceState): string {
  const waiting = view.backgroundTasks.length;
  if (state !== "working" || waiting === 0) return state;
  return `${state} ${SEPARATOR} ${waiting} task${waiting === 1 ? "" : "s"}`;
}

/**
 * `<glyph> <session-name> <separator> <state>`.
 *
 * The name is what gets shortened when the whole thing is too long: the glyph and the state are
 * the parts a truncating list view must not eat.
 */
export function threadName(view: SessionView, state: SurfaceState): string {
  const prefix = `${GLYPHS[state]} `;
  const suffix = ` ${SEPARATOR} ${stateLabel(view, state)}`;
  const room = MAX_THREAD_NAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${fit(displayName(view), room)}${suffix}`;
}

/**
 * Truncates to a length in code points, never in UTF-16 units: cutting an astral-plane character
 * in half leaves a lone surrogate, which is not valid UTF-8 for the request body. The cut is marked
 * with an ellipsis paid for out of the limit, so what comes back is inside the bound and says it is
 * not the whole text.
 *
 * Exported because one cut is made before any renderer sees the text: the reader bounds an option's
 * description at intake, and a text arriving here already cut has nothing left to tell this function
 * it was. One implementation of the mark rather than a second beside the intake site, so the two
 * cuts cannot come to disagree about what a shortened string looks like.
 */
export function fit(value: string, limit: number): string {
  // No room is no text: the cut marker is a character of its own, and drawn where nothing fits it
  // would put the line it sits in a character past the bound that was measured for it.
  if (limit <= 0) return "";

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
 * The width a fenced card body is held to, in characters.
 *
 * A Discord client wraps a fenced line to the rendered width of the window rather than scrolling it,
 * so the cost of a line past this width is not a drag but a wrap, and a wrap is what scrambles a
 * block whose whole purpose is a column of values sitting under each other. This bound is therefore
 * set below the narrowest window a card is read in: measured on the operator's own devices the wrap
 * falls at roughly 51 columns on a folded phone, 62 unfolded, and 83 on a desktop. Both cards read
 * this one bound, so neither can be readable at a glance while the other is not.
 */
export const MAX_BLOCK_WIDTH = 46;

/**
 * The widest a label column grows, whatever sits in it.
 *
 * The column is padded to the longest label a body actually carries, and this is what keeps one
 * long label from taking the room every value on the card is drawn in: a per-model window names
 * itself out of another program's cache, at whatever length that program wrote.
 */
const MAX_LABEL_WIDTH = 10;

/**
 * One line of a fenced body: a label and the value drawn beside it, or a whole-width line of its
 * own when the label is null, which is what a heading, a note, and a session row are.
 */
export type BlockRow = { label: string | null; value: string };

/** What a fenced body costs beyond its own lines: the two delimiter lines and their newlines. */
export const FENCE_COST = 2 * (FENCE.length + 1);

/**
 * A body inside one fenced block.
 *
 * Discord renders no markdown inside one, so nothing composed into these lines may rely on any:
 * emphasis there reaches the reader as the asterisks it is written with, and a mention as its raw
 * id. What the fence buys instead is a monospace grid, which is what lets a column of values line
 * up. Untrusted text still goes through this module's escaping before it gets here, because an
 * unescaped run of backticks would close the block early and put the rest of the card outside it.
 */
export function fenced(lines: readonly string[]): string {
  return [FENCE, ...lines, FENCE].join("\n");
}

/** The room a value has beside a label column of this width. */
function valueRoom(width: number): number {
  return MAX_BLOCK_WIDTH - width - 1;
}

/** The column a body's labelled rows are padded to: the longest label present, bounded. */
export function columnWidth(rows: readonly BlockRow[]): number {
  const widths = rows.flatMap((row) => (row.label === null ? [] : [[...row.label].length]));
  return Math.min(Math.max(0, ...widths), MAX_LABEL_WIDTH);
}

/**
 * A body's rows as its lines: every label padded to the column so the values start in one place,
 * every value cut to the room the column leaves, and every whole-width line wrapped to the bound.
 *
 * No glyph is ever drawn inside the run of spaces that does the aligning. A glyph leads a value or
 * leads a whole-width line instead, because an emoji is not one column wide in a monospace font:
 * one sitting in the padding would push that line's value out of the column every other line shares,
 * which is the whole thing the fence is here to provide. Leading a line, the same glyph costs at
 * most the one column it is wider than the character count measured here.
 */
export function alignedRows(rows: readonly BlockRow[], width: number): string[] {
  const room = valueRoom(width);
  return rows.flatMap((row) => {
    if (row.label === null) return wrapped(row.value);
    const label = fit(row.label, width);
    const padded = `${label}${" ".repeat(Math.max(width - [...label].length, 0))}`;
    return [`${padded} ${fit(row.value, room)}`.trimEnd()];
  });
}

/**
 * A line of prose broken into lines that fit the block's width.
 *
 * Prose is wrapped rather than cut because none of it is decoration: the footer names why the
 * numbers above it are held, and a cut there would drop the reason rather than shorten it. Broken
 * on spaces, and mid-word for a word wider than the whole block, so that every line of a card sits
 * inside the one width its aligned rows are padded to. What this avoids is the client wrapping the
 * line where it chooses, which would put a fragment of prose under a column and read as a value.
 */
export function wrapped(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (line === "") line = word;
    else if ([...line].length + 1 + [...word].length <= MAX_BLOCK_WIDTH) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while ([...line].length > MAX_BLOCK_WIDTH) {
      lines.push(sliceCodePoints(line, MAX_BLOCK_WIDTH));
      line = [...line].slice(MAX_BLOCK_WIDTH).join("");
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * What separates two columns of a fenced table, and the whole of what a gap between them costs.
 */
const TABLE_SEPARATOR = " | ";

/**
 * The room one fenced table has, in UTF-16 units.
 *
 * A message carries an attribution line beside the block, and the widest of them is what this
 * reserves, so a table that passes here fits whichever surface mirrors it. A table over the bound
 * is left as the Markdown the model wrote rather than cut: a block cut mid-row reads as a complete
 * table that says something different from what was written, where raw text reads as raw text.
 */
const MAX_TABLE_LENGTH =
  MAX_MESSAGE_LENGTH -
  Math.max(...[ANSWER_ATTRIBUTION, ...Object.values(ATTRIBUTION)].map((line) => line.length));

/** Where a column's cells sit in their padding, as the delimiter row's markers declare it. */
type ColumnAlignment = "left" | "right" | "center";

/** A delimiter row's cell: dashes, with a colon on the side or sides the column aligns to. */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * How many lines the table transform has parsed as candidate rows, counted so a test can hold the
 * transform to a cost linear in the text it is given.
 *
 * This is the one thing here that runs over a whole reply, and a reply has no length cap, on the
 * single event loop every hook, heartbeat, and permission prompt shares. A pipe-heavy reply that
 * cost more than one parse per line would stall all of them for as long as it took. Wall clock
 * cannot express that bound in a test, since a loaded machine moves it by an order of magnitude,
 * where a parse count is the same number on any machine.
 */
export const tableParses = { count: 0 };

/**
 * How many rows the table transform has neutralized and measured for drawing, counted on the same
 * reasoning as `tableParses` and for the same kind of test.
 *
 * Reading a run cheaply is only half the bound. A run whose every line is a well-formed row clears
 * the shape checks from every one of its starts, so drawing before judging whether the result could
 * fit would spend the whole run's padding once per start no matter how few lines were ever parsed.
 */
export const tableRowsDrawn = { count: 0 };

/**
 * One row's cells, or `null` when the line is not a row at all.
 *
 * A row is recognized by carrying a pipe, and one leading and one trailing pipe are dropped, which
 * is the GFM shape with the optional outer pipes either present or absent.
 */
function tableCells(line: string): string[] | null {
  tableParses.count += 1;
  if (!line.includes("|")) return null;
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/**
 * The width each column is padded to, given what its cells want and the room they share.
 *
 * Every column that fits under a common cap keeps its natural width, and the ones past that cap are
 * held to it, so the room a narrow column does not need goes to the columns that do. A cap below
 * what a column's cells want is what routes a table out of the grid entirely, since a grid drawn
 * there would have to cut a cell.
 */
function columnCaps(widths: readonly number[], budget: number): number[] {
  let cap = Math.max(...widths);
  const spent = (limit: number): number =>
    widths.reduce((total, width) => total + Math.min(width, limit), 0);
  while (cap > 1 && spent(cap) > budget) cap -= 1;
  return widths.map((width) => Math.min(width, cap));
}

/**
 * One cell drawn in its column: padded to the column's width, and held to it. A grid is only drawn
 * where every column is as wide as its cells want, so the bound is a guard rather than a cut.
 */
function paddedCell(cell: string, width: number, alignment: ColumnAlignment): string {
  const shown = fit(cell, width);
  const room = Math.max(width - [...shown].length, 0);
  if (alignment === "right") return `${" ".repeat(room)}${shown}`;
  if (alignment === "left") return `${shown}${" ".repeat(room)}`;
  const before = Math.floor(room / 2);
  return `${" ".repeat(before)}${shown}${" ".repeat(room - before)}`;
}

/**
 * The widest a column header grows before its table is left as the text it was written as.
 *
 * A header is drawn once per body row, so its length is spent as many times as the table is tall.
 * The headers a table carries name their columns and run to about twenty characters, so a cell
 * past this one is prose rather than a column name, and a table headed by prose is not one worth
 * drawing a block per row.
 */
const MAX_ROW_LABEL_WIDTH = 40;

/**
 * How much longer than the text it replaces a per-row rendering may be.
 *
 * The shape costs text by design: a heading and a label are drawn where the source wrote a pipe,
 * which on most tables is a fraction more and on a tall one of one-character cells reaches about
 * five times the source. Past this the growth is no longer the shape's own cost, and the Markdown
 * the model wrote is what ships.
 */
const MAX_ROW_TABLE_GROWTH = 8;

/**
 * The most text one per-row rendering may draw, in UTF-16 units.
 *
 * Fifty messages is past where the shape is a reading aid, whatever made it that long, and this
 * bound holds whether or not the growth bound above is the right number.
 */
const MAX_ROW_TABLE_LENGTH = 50 * MAX_MESSAGE_LENGTH;

/**
 * The room the rows being redrawn take as Markdown: every cell, the pipe and the spaces around it
 * each cell is written between, and a newline a row. The delimiter row is not among them, and the
 * cells are read as they were written where the output is measured after the escape, so this reads
 * a little under what the model actually wrote, which holds the growth bound on the tight side
 * rather than the loose one.
 */
function tableSourceLength(rows: readonly string[][]): number {
  return rows.reduce(
    (total, row) => total + row.reduce((sum, cell) => sum + cell.length, 0) + 3 * row.length + 1,
    0,
  );
}

/**
 * A table drawn as one block per row: the row's first cell as its heading, and every other column
 * as a `label: value` line under it, the label being that column's header. `null` when the rows
 * compose nothing at all, when a header is too long to be drawn under every row, or when what they
 * compose is out of proportion to the text it replaces, each of which leaves the table as the text
 * it was written as.
 *
 * Nothing here is inert by position, because none of it is inside a fence. So nothing reaches the
 * output unneutralized, and what stops a cell drawing a mention, a quote bar, a spoiler, a heading,
 * or a fence is the same escape in both cases. The whitespace collapse is the other half of it: a
 * cell cannot compose a line of its own, so it cannot forge a label line either.
 *
 * Where the two escapes differ is emphasis, and the split is structure against content. A value is
 * content and keeps the bold or the italics the model wrote it in, through `inertCell`, because that
 * is most of what a comparison table says and it is wrapped in no markup of this rendering's. A
 * heading and every label are structure and take the full escape: the heading is composed inside
 * emphasis this rendering writes, where a surviving mark would close the wrapper early, and a label
 * is redrawn on every row, where one would flip the parity of the composed marks once per row. What
 * a value can still do is leave its own emphasis unbalanced, which re-attributes bold within the one
 * message it is in; that is the line mirrored prose already sits on, and narrower, since prose keeps
 * its spoilers and masked links live where a cell keeps neither.
 *
 * A cell that neutralizes to nothing draws no line, because a label standing on its own reads as a
 * value that went missing rather than one that was never written, and a row whose first cell is
 * empty draws no heading. A single-column table has no labels to draw, so its rows are drawn as the
 * lines of text they are, the header row among them: there is no second column for it to name.
 *
 * The heading carries its own column's header too, so a table drawn this way loses no word the
 * model wrote. Every other column names itself on its line, and a first column that named itself
 * nowhere would be the one dimension the reader had to infer, in a shape whose whole purpose is
 * that nothing is dropped.
 */
function perRowTable(rows: readonly string[][]): string | null {
  const header = rows[0] ?? [];
  // Labels take the full escape, unlike the values beside them, because a label is structure rather
  // than content: the first names the row inside the emphasis this rendering composes, and every
  // other is redrawn on every row of the table. An emphasis mark surviving in one would therefore
  // break that wrapper, or flip the parity of the composed marks once per row.
  const labels = header.map((cell) => inertText(cell));
  // Only where the labels are drawn: a single-column table names no column, so its first row is a
  // line of text like the rest and is drawn once however long it is.
  if (labels.length > 1 && labels.some((label) => [...label].length > MAX_ROW_LABEL_WIDTH)) {
    return null;
  }
  const blocks =
    labels.length <= 1
      ? rows.map((row) => inertCell(row[0] ?? ""))
      : rows.slice(1).map((row) => {
          // The one cell this rendering wraps in emphasis of its own, so the one cell that may not
          // carry any: a mark surviving here would close the wrapper early and leave the rest of the
          // heading outside the bold the row is drawn in. A value below is wrapped in nothing, which
          // is what lets it keep the emphasis the model wrote it with.
          const heading = inertText(row[0] ?? "");
          const named = labels[0] === "" || heading === "" ? heading : `${labels[0] ?? ""}: ${heading}`;
          const lines = heading === "" ? [] : [`**${named}**`];
          for (const [column, cell] of row.entries()) {
            if (column === 0) continue;
            const value = inertCell(cell);
            if (value === "") continue;
            const label = labels[column] ?? "";
            lines.push(label === "" ? value : `${label}: ${value}`);
          }
          return lines.join("\n");
        });
  const drawn = blocks.filter((block) => block !== "").join("\n\n");
  if (drawn === "") return null;
  if (drawn.length > MAX_ROW_TABLE_LENGTH) return null;
  return drawn.length > tableSourceLength(rows) * MAX_ROW_TABLE_GROWTH ? null : drawn;
}

/**
 * A run of pipe-carrying lines drawn as a table, or `null` when it is not a whole one.
 *
 * Two shapes, and which one is drawn is decided by whether the grid could carry the text: a table
 * whose columns all fit the block's width is drawn as one fenced block, and one that would have to
 * cut a cell to fit is drawn a block per row instead, or left as raw text where the rows compose
 * more than the row rendering is worth. A cut cell is the whole of what the row said gone, which is
 * the same argument the length bound below already makes for leaving an over-long table as raw
 * text: one axis refusing to lie while the other lied quietly is what the two shapes here settle.
 *
 * Whole means all of it: a header row, a delimiter row of dashes under it, at least one body row,
 * and the same cell count on every one of them. What a block is gets decided from the whole block,
 * so a ragged or half-written table is left as the text the model wrote rather than drawn as a
 * table that quietly dropped a column.
 *
 * Cells are neutralized before they are measured and padded, never after: the fence-inert form is
 * what the reader sees, so it is what the columns have to line up on, and a backslash doubled after
 * the padding would push its row a character wider than the block it sits in.
 *
 * The run arrives already parsed, and `start` names which of its rows the candidate opens on, so
 * one run judged from several starts is parsed once rather than once per start. The judge that can
 * reject on two rows runs before anything reads the rest of them, which is what keeps a long run
 * that is no table from costing more than a walk over it.
 */
function tableBlock(rows: readonly (string[] | null)[], start: number): string | null {
  if (rows.length - start < 3) return null;
  const header = rows[start];
  const delimiter = rows[start + 1];
  if (header === null || header === undefined || delimiter === null || delimiter === undefined) {
    return null;
  }
  const columns = header.length;
  if (columns === 0) return null;
  if (delimiter.length !== columns || !delimiter.every((cell) => DELIMITER_CELL.test(cell))) {
    return null;
  }
  // The smallest block these rows could possibly draw, which is enough to refuse an over-long one
  // before a character of it is padded. Every row but the delimiter is drawn, each row's cells are
  // joined by a separator whose pipe and leading space no trailing trim can reach, and the fence
  // costs its two lines plus a newline between every line. Those are ASCII, so the floor is in the
  // UTF-16 units the finished block is measured in, and anything a cell actually carries only moves
  // the real block further past it: a block refused here is one the length check below would refuse
  // too. Judging first is what keeps a long run of well-formed rows from drawing the whole of
  // itself once per candidate start and throwing all of it away.
  const height = rows.length - start - 1;
  const leastRow = Math.max(TABLE_SEPARATOR.length * (columns - 1) - 1, 0);
  if (FENCE.length * 2 + height + 1 + height * leastRow > MAX_TABLE_LENGTH) return null;

  const body = rows.slice(start + 2);
  if (body.some((row) => row === null || row.length !== columns)) return null;

  const alignments: ColumnAlignment[] = delimiter.map((cell) => {
    const leads = cell.startsWith(":");
    const trails = cell.endsWith(":");
    if (leads && trails) return "center";
    return trails ? "right" : "left";
  });
  tableRowsDrawn.count += body.length + 1;
  const cells = [header, ...body].map((row) => row ?? []);
  const drawn = cells.map((row) => row.map((cell) => inertBlock(cell)));

  // The separators are spent before the columns are: they are what makes the block read as a table
  // at all, so the cells share what is left rather than the whole width.
  const budget = MAX_BLOCK_WIDTH - (columns - 1) * TABLE_SEPARATOR.length;
  if (budget < columns) return null;
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...drawn.map((row) => [...(row[column] ?? "")].length)),
  );
  const widths = columnCaps(natural, budget);
  // A column held under what its cells want is a cell about to be cut, so the row rendering takes
  // it. Measured on the cells as they are drawn rather than as they were written, the same reading
  // the grid pads on, so what decides the shape is what a reader would have seen.
  if (widths.some((width, column) => width < (natural[column] ?? 0))) return perRowTable(cells);

  const block = fenced(
    drawn.map((row) =>
      row
        .map((cell, column) => paddedCell(cell, widths[column] ?? 0, alignments[column] ?? "left"))
        .join(TABLE_SEPARATOR)
        .trimEnd(),
    ),
  );
  return block.length > MAX_TABLE_LENGTH ? null : block;
}

/**
 * Mirrored text with every Markdown table in it redrawn as the shape its width allows: a fenced
 * aligned block where the columns fit, a block per row where they do not.
 *
 * Discord renders no Markdown table: the pipes and the dashes arrive as themselves, which is a
 * shape the operator reads with effort on a phone. A fence answers that where the table is narrow
 * enough for one: the columns line up in a monospace grid, and the cell text inside is already
 * inert. Past that width the grid could only be had by cutting cells, so the text is kept and the
 * grid is what is given up, and where keeping it a row at a time would cost far more text than the
 * table is written in, the Markdown the model wrote is what ships.
 *
 * Only text outside an existing fence is examined, on the file's one reading of where a fence is,
 * so a table the model wrote inside a code block stays exactly as it wrote it and nothing here can
 * open a fence inside one.
 */
function withTablesBlocked(value: string): string {
  return scanFences(null, value)
    .runs.map((run) => (run.fenced ? run.text : blockedTables(run.text)))
    .join("");
}

/** Every whole table in one unfenced stretch of text, redrawn; everything else left as it is. */
function blockedTables(text: string): string {
  const lines = text.split("\n");
  const drawn: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!(lines[index] ?? "").includes("|")) {
      drawn.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    // The candidate is the whole run of consecutive pipe-carrying lines, so a row the table cannot
    // account for is inside the shape being judged rather than outside it. A run that is not a
    // table gives up only its first line, and the line after it opens the next candidate: a table
    // under a line of prose that happens to carry a pipe is still a table.
    let end = index + 1;
    while (end < lines.length && (lines[end] ?? "").includes("|")) end += 1;

    // Where the run ends does not depend on which of its lines a candidate opens on, so both the
    // boundary and the parse belong to the run, are found once, and every candidate start is an
    // index view into that one parse. Redoing either per start is what would cost the square of a
    // long run's length before it was rejected.
    const rows = lines.slice(index, end).map(tableCells);
    let block: string | null = null;
    let start = index;
    while (start < end && block === null) {
      block = tableBlock(rows, start - index);
      if (block === null) {
        drawn.push(lines[start] ?? "");
        start += 1;
      }
    }
    if (block !== null) drawn.push(block);
    index = end;
  }
  return drawn.join("\n");
}

/**
 * Mirrored conversation text made ready for a thread: its tables redrawn, then its chip and quote
 * syntax neutralized.
 *
 * One seam for both the paths mirrored text reaches Discord by, the messages a run posts and the
 * merge that grows a narration block, so a table cannot draw one way when a chunk opens a message
 * and another way when it grows one. The table transform runs first because it reads and writes
 * ordinary Markdown: run after the escape, it would measure and pad cells around backslashes the
 * fence it draws renders as themselves. The escape running second is also the second cover on
 * unfenced cell text, which the table transform has already put through the unfenced escape itself.
 */
function mirrorBody(value: string): string {
  return withoutChips(withTablesBlocked(value));
}

/**
 * One mirrored prompt or reply, rendered as the ordered messages it takes to carry it whole.
 *
 * A reply is never truncated: it is among the highest-value things this system posts, and a reply
 * cut at one message is a reply the operator has to walk to a keyboard to finish reading, which is
 * the thing mirroring exists to avoid. So there is no ceiling on the count. A prompt is the one
 * capped surface, above.
 */
export function renderMirror(kind: MirrorKind, text: string): string[] {
  const seen = withoutInvisible(text).trim();
  // The cap is measured on the text as it arrived, before escaping: escaping adds a character per
  // angle bracket it neutralizes, and a cap applied after would shorten a paste by characters
  // nobody typed.
  const capped =
    kind === "prompt" && [...seen].length > MAX_MIRRORED_PROMPT_LENGTH
      ? shortened(sliceCodePoints(seen, MAX_MIRRORED_PROMPT_LENGTH))
      : seen;
  return attributed(capped, ATTRIBUTION[kind]);
}

/**
 * One reply tool message, rendered as the ordered messages it takes to carry it whole.
 *
 * The same treatment a mirrored reply gets, from the same machinery, because it is the same kind of
 * text arriving in the same thread: written by a model that has read whatever the session read, and
 * landing beside mirrored messages in the one channel the operator answers permission prompts in. A
 * second escape or a second splitter of the same shape would be two readings of where a code fence
 * is, and what a disagreement between them costs is the chip or the forged attribution one of them
 * believed it had removed.
 *
 * Uncapped at any length, like the mirror's reply: the paste cap protects the thread from the
 * operator's own log dumps and has no business touching text written to be read.
 */
export function renderAnswer(text: string): string[] {
  return attributed(withoutInvisible(text).trim(), ANSWER_ATTRIBUTION);
}

/**
 * A mid-turn chunk merged into the narration message already sitting in the thread, or `null` when
 * it will not go there.
 *
 * The router grows one narration block by editing that message in place, so a working stretch reads
 * as a single message under a single attribution rather than as a header per sentence. `existing` is
 * the exact content that message was posted with, which has been through this renderer already: it
 * is copied into the result untouched, because escaping it a second time would write a backslash in
 * front of the backslashes a reader is already looking at. `text` is the raw chunk, the same
 * untrusted class `renderMirror` receives, and it goes through the same stripping and the same
 * escape, because the attribution rule holds for text arriving by edit exactly as it does for text
 * arriving by post.
 *
 * A fence the body leaves open is closed, the way the splitter closes one at the end of a message:
 * a merged message holding a fence open renders everything posted below it as code. The body's scan
 * starts from no open fence because every message this renderer emits closes what it opened, which
 * is true of a split run's last message and of the result here, so it stays true of the next merge.
 *
 * `null` is the only refusal, and it covers both a chunk that neutralizes to nothing and a merge
 * over the ceiling. Nothing is truncated here: a chunk that does not fit whole posts as a fresh
 * message through the splitter instead, which is the same fallback either answer leads to.
 */
export function appendNarration(existing: string, text: string): string | null {
  // The cheap half of the precondition, checked rather than assumed. Everything this renderer
  // emits is trimmed and free of the invisible class, so a message that really was posted passes
  // as an identity check, and an empty, padded, or invisible-carrying base is refused: a merge
  // grown on a string Discord does not hold is a block whose remembered copy drifts from the
  // thread with every append. The rest of the precondition, that the base is renderer output and
  // not merely renderer-shaped, is the caller's provenance to keep.
  if (existing === "" || existing !== withoutInvisible(existing).trim()) return null;
  const seen = mirrorBody(withoutInvisible(text).trim());
  if (seen === "") return null;
  const closing = fenceAfter(null, seen) === null ? "" : `\n${FENCE}`;
  const merged = `${existing}\n\n${seen}${closing}`;
  // Measured in UTF-16 units, the larger of the two counts a length could mean, so holding it holds
  // the code point count too. The message is accepted whole or not at all, so there is no cut to
  // place and no half character to avoid placing it in.
  return merged.length > MAX_MESSAGE_LENGTH ? null : merged;
}

/**
 * Neutralized text, packed into the messages it takes to carry it, each one carrying `prefix`.
 *
 * The whole budget is `MAX_MESSAGE_LENGTH` and every part of a message is spent against it: the
 * attribution, the fence lines a split code block needs, and the text. That is why splitting and
 * attribution are one function rather than two: a splitter that cut to the ceiling and a caller
 * that then prefixed anything at all would post messages over it, which Discord rejects outright.
 */
function attributed(seen: string, prefix: string): string[] {
  const body = mirrorBody(seen);
  // Nothing at all to say. Reported as no messages rather than as one empty message, which Discord
  // refuses and which would read as the session having answered with silence.
  if (body === "") return [];
  return split(body, prefix);
}

/**
 * A cut paste, with the marker that says it was cut.
 *
 * A fence the cut left open is closed first: appended inside one, the marker would render as a line
 * of code, which is a cut saying nothing at all to whoever reads it.
 */
function shortened(cut: string): string {
  const closing = fenceAfter(null, cut) === null ? "" : `\n${FENCE}`;
  return `${cut}${closing}\n\n${SHORTENED}`;
}

/**
 * Where the code fences are: the text split into runs that are inside one and runs that are not,
 * and the fence still open at the end, as its info string.
 *
 * The one reading of fence structure in this file. The escape uses it to decide what to leave
 * alone, and the splitter uses it to decide what to close and re-open across a message boundary,
 * so the two cannot come to disagree about where a code block is.
 *
 * Scanned by delimiter rather than by line, so a fence opened and closed on one line toggles twice
 * and leaves nothing open. A fence the text never closes stays open to the end, which is how
 * Discord shows it: everything after an unclosed delimiter is code. The info string is the language
 * word Discord colours by, and it is carried across a boundary because a message that re-opened a
 * bare fence would render the code without its colours and one that re-opened nothing would render
 * it as prose.
 *
 * Two things this reading does not model, and both are limits rather than oversights. A run of
 * three or more backticks toggles, whatever its length, where Discord's own rule relates the length
 * of a closing run to its opening one. And a delimiter is a delimiter wherever it sits on a line,
 * including mid-line. Where either reading differs from Discord's, the cost is bounded to a chip
 * left unescaped in a region this file called code and Discord called prose, which `allowed_mentions`
 * still keeps from pinging anyone. It is bounded there because the one thing a difference must not
 * cost, a mirrored line that draws the attribution, is escaped without consulting this scanner.
 */
function scanFences(
  state: string | null,
  chunk: string,
): { open: string | null; runs: Array<{ text: string; fenced: boolean }> } {
  const runs: Array<{ text: string; fenced: boolean }> = [];
  let open = state;
  let from = 0;
  // A backslash and whatever follows it is consumed as one unit, so an escaped backtick is text
  // rather than a delimiter, and a doubled backslash leaves the backtick after it delimiting again.
  // The escape above never writes a backslash in front of a backtick, only in front of `<` and `>`,
  // which is what lets the same scanner read the text before escaping and the text after it and
  // find the fences in the same places.
  for (const match of chunk.matchAll(/\\[\s\S]|`{3,}([^\n`]*)/g)) {
    const info = match[1];
    if (info === undefined) continue;
    runs.push({ text: chunk.slice(from, match.index), fenced: open !== null });
    from = match.index + match[0].length;
    if (open !== null) {
      // A closing delimiter ends the block at the delimiter. What follows it on that line is
      // ordinary markdown to Discord, and therefore a surface a chip can be drawn on, so it goes
      // back into the escaped stream rather than riding along as part of the fence.
      runs.push({ text: match[0].slice(0, match[0].length - info.length), fenced: true });
      runs.push({ text: info, fenced: false });
      open = null;
      continue;
    }
    // An opening delimiter owns its whole line: the info string is the fence's, not content.
    runs.push({ text: match[0], fenced: true });
    const language = info.trim().split(/\s+/)[0] ?? "";
    open = language.length <= MAX_FENCE_INFO_LENGTH ? language : "";
  }
  runs.push({ text: chunk.slice(from), fenced: open !== null });
  return { open, runs };
}

/** The fence open after `chunk`, given the one open before it. */
function fenceAfter(state: string | null, chunk: string): string | null {
  return scanFences(state, chunk).open;
}

/**
 * Neutralizes the chip and quote syntax outside fenced code blocks, leaves the inside of one as it
 * was written, and neutralizes a line-leading quote marker everywhere.
 *
 * The quote marker is the exception to the fence exemption, because the attribution is a quoted
 * line and its unforgeability is the property that least deserves to rest on this file's reading of
 * where a code block is agreeing with Discord's. Escaped in both regions, a disagreement costs a
 * visible backslash in front of a line of code; escaped in one, it costs a mirrored reply that can
 * draw the line saying who wrote it.
 *
 * Run before the text is split, and safe to run there, because it only ever inserts a backslash in
 * front of `<`, `>`, so it can neither create nor destroy a delimiter: the fence structure the
 * splitter reads afterwards is the structure this read.
 */
function withoutChips(value: string): string {
  const escaped = scanFences(null, value)
    .runs.map((run) => (run.fenced ? run.text : run.text.replace(CHIPS, (character) => `\\${character}`)))
    .join("");
  // The line-leading pass runs second and over everything, where it finds only the markers the
  // first pass left inside fences: one already escaped is preceded by its backslash rather than by
  // the start of its line.
  return escaped.replace(/^([ \t]*)>/gm, "$1\\>");
}

/**
 * The longest head of `value` fitting in `limit` UTF-16 units, never cutting a character in half.
 *
 * Counted in UTF-16 units because that is the larger of the two counts a length could mean, so
 * holding it holds the code point count too, and cut on code points because half of an astral
 * character is a lone surrogate, which is not valid UTF-8 for the request body.
 */
function headFitting(value: string, limit: number): string {
  let units = 0;
  let points = 0;
  for (const character of value) {
    if (units + character.length > limit) break;
    units += character.length;
    points += 1;
  }
  return sliceCodePoints(value, points);
}

/**
 * Backs a hard cut off the three places it must not land.
 *
 * Inside a run of backticks: half a delimiter in one message and half in the next is a fence the
 * text still has and neither message can see, and the escape has already decided what to neutralize
 * on the reading where the delimiter is whole. Straight after a backslash: that is the same hazard
 * one character wide, stranding an escape from the character it makes inert, so the next message
 * would open with a live chip or a live quote marker. And inside a fence's info string: the
 * delimiter is whole on both readings there, but the language word is not, so a cut through
 * ```` ```typescript ```` leaves one message opening a block called `typ` and the next re-opening
 * that block with `escript` as its first line of code. The whole opening line moves to the next
 * message instead, which is where the code it introduces already is.
 *
 * That last pattern also matches a closing delimiter with prose after it on the same line, and
 * moving the delimiter whole is right there too: what follows it is what the fence model already
 * reads as ordinary markdown.
 *
 * The cut only ever shrinks, and never to nothing: a line of pure delimiters still has to advance,
 * and a cut that took nothing would repeat forever. So an info string longer than a whole message
 * is cut through rather than moved, and both messages read it as the same fence.
 */
function cutSafely(rest: string, head: string): string {
  const straddles = rest.length > head.length && rest[head.length] === "`";
  const backed = (straddles ? head.replace(/`+$/, "") : head).replace(/\\+$/, "");
  // Measured at the cut as it now stands: a fence opening line the rest of the text continues on
  // is in progress, where one the text ends or breaks the line after is already whole.
  const midLine = rest.length > backed.length && rest[backed.length] !== "\n";
  const whole = midLine ? backed.replace(/`{3,}[^\n`]*$/, "") : backed;
  return whole === "" ? head : whole;
}

/**
 * Packs a body into messages, each one prefixed and each one within `MAX_MESSAGE_LENGTH`.
 *
 * Paragraphs first, then lines, then a hard cut, because where a message ends is where the reader's
 * eye stops: a break between paragraphs reads as a pause, a break mid-sentence reads as damage.
 * A code fence open across a break is closed and re-opened, so both halves render as code rather
 * than the second half rendering as prose with its indentation collapsed.
 */
function split(body: string, prefix: string): string[] {
  const messages: string[] = [];
  // The fence open where the current message started, and the one open where its text currently
  // ends. The first decides whether this message must re-open a fence, the second whether it must
  // close one, and both are budget rather than decoration: every fit test below measures the
  // message as it would be sent, with those lines already on it.
  let openedAt: string | null = null;
  let open: string | null = null;
  let buffer = "";

  const overhead = (start: string | null, end: string | null): number =>
    prefix.length +
    (start === null ? 0 : FENCE.length + start.length + 1) +
    (end === null ? 0 : 1 + FENCE.length);

  const flush = (): void => {
    if (buffer === "") return;
    const opening = openedAt === null ? "" : `${FENCE}${openedAt}\n`;
    // An unterminated fence is closed here too, on the last message: the alternative leaves the
    // thread's final mirrored message holding a fence open over whatever is posted after it.
    const closing = open === null ? "" : `\n${FENCE}`;
    // Trailing whitespace goes because the writer trims before it posts, and a message that came
    // back from the transport different from the one that was measured is a message whose length
    // was measured against the wrong string.
    messages.push(`${prefix}${opening}${buffer}${closing}`.trimEnd());
    openedAt = open;
    buffer = "";
  };

  // Adds a chunk to the message being built, or reports that it does not fit. The separator is
  // dropped when the chunk starts a message: a paragraph break falling on a message boundary is
  // already said by the boundary.
  const place = (chunk: string, separator: string): boolean => {
    const candidate = buffer === "" ? chunk : `${buffer}${separator}${chunk}`;
    const end = fenceAfter(open, chunk);
    if (overhead(openedAt, end) + candidate.length > MAX_MESSAGE_LENGTH) return false;
    buffer = candidate;
    open = end;
    return true;
  };

  // Split on the exact two-newline sequence rather than on runs of them, so joining the pieces back
  // with the same sequence reproduces the text: a run of blank lines survives as itself.
  for (const [index, paragraph] of body.split("\n\n").entries()) {
    if (place(paragraph, index === 0 ? "" : "\n\n")) continue;
    flush();
    if (place(paragraph, "")) continue;

    for (const [position, line] of paragraph.split("\n").entries()) {
      if (place(line, position === 0 ? "" : "\n")) continue;
      flush();
      if (place(line, "")) continue;

      // One line longer than a whole message. Cut on code points, with room reserved for the
      // closing fence whenever one could be open at the cut: a delimiter anywhere in the line can
      // open one, and discovering that after choosing the cut would push the message over.
      let rest = line;
      while (rest !== "") {
        const end = open === null && !rest.includes(FENCE) ? null : "";
        const room = Math.max(MAX_MESSAGE_LENGTH - overhead(openedAt, end), MIN_HARD_CUT);
        // At least one code point, always: a room too small for the next character would otherwise
        // drop the rest of the line silently rather than posting it in pieces.
        const head = cutSafely(rest, headFitting(rest, room) || sliceCodePoints(rest, 1));
        buffer = head;
        open = fenceAfter(open, head);
        rest = rest.slice(head.length);
        // The tail of a line is left in the buffer rather than flushed, so whatever follows it
        // shares the message instead of starting a new one.
        if (rest !== "") flush();
      }
    }
  }
  flush();
  return messages;
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
 * The labels the status card draws, which are what its column is padded to.
 *
 * Named here as one set because the column is measured off all of them rather than off the rows a
 * given card happens to carry: a card whose values shift sideways as the model row comes and goes
 * reads at a glance as a different card.
 */
const CARD_LABELS = {
  host: "Host",
  session: "Session",
  state: "State",
  model: "Model",
  context: "Context",
  from: "Down from",
  heartbeat: "Heartbeat",
} as const;

const CARD_COLUMN = columnWidth(
  Object.values(CARD_LABELS).map((label) => ({ label, value: "" })),
);

/**
 * The card's title, drawn a second time as the largest heading Discord offers.
 *
 * The message's first line is drawn inline beside the bot's name, where it reads as chrome rather
 * than as the card's own heading, so a channel of cards scrolls as one run of text with nothing to
 * pick a card out by. Repeating the title at heading size on a line of its own is what gives each
 * card a visible top edge, and the largest size is what holds that edge at a scrolling glance.
 */
const TITLE_HEADING = "#";

/**
 * The headers over the card's optional blocks.
 *
 * Outside their fences, where Discord renders the heading, exactly as the title heading sits outside
 * the first one, and a smaller heading than that title so the card's name and its sections read as
 * different ranks rather than as the same weight. What they head is a block rather than a labelled
 * row, because each carries values a label column leaves no room for: a fan-out's tasks take two
 * rows each, a real tool path is longer than a row of this width, and a goal is a sentence the
 * operator wrote.
 *
 * A header sits directly against the block above it, with no blank line between them: Discord draws
 * its own air around a fenced block, and a blank line there is spacing on top of spacing on a
 * surface read by scrolling past several cards.
 *
 * Tool leads Tasks because a session usually has a tool and rarely has tasks, so the sparse block is
 * not the one that leads. The goal keeps the position directly under the fields, which says what the
 * session is working toward before what it is working with.
 *
 * A section with nothing to show is omitted, header and block together, rather than drawn with a
 * placeholder value. What a placeholder buys is telling an empty block apart from a renderer that
 * has stopped drawing one; what it costs is two lines saying nothing on every idle card in the
 * channel, which is every card between fan-outs, and on a scrolled surface that noise is the more
 * expensive of the two. The block's presence is itself the signal.
 */
const GOAL_HEADER = "### Goal";
const TOOL_HEADER = "### Tool";
const TASKS_HEADER = "### Tasks";

/**
 * How much of a session ID the card draws, in code points.
 *
 * The head of it, which is what a session is called everywhere else here: `displayName` falls back
 * to the same eight characters, and the block has room for a value rather than for a 36-character
 * identifier that would take the row and most of the width bound with it.
 */
const SHOWN_SESSION_ID = 8;

/** What a cut tool preview is marked with, reserved out of the room before the preview is cut. */
const CUT_MARKER = " (cut)";

/**
 * A value broken into lines that fill the block's width.
 *
 * Filled rather than broken on spaces, unlike `wrapped`, because what the tool block carries is a
 * name and a path: a path holds no space to break on, so a word-wrapper would hard-break it anyway
 * after leaving `Read ·` alone on the line above it.
 *
 * A break never lands straight after a backslash, which is `cutSafely`'s rule for the same hazard
 * at a message boundary: the escape and the character it makes inert stay on one line. Backing off
 * one always leaves the line most of its width, so the value still advances.
 */
function filled(value: string): string[] {
  const lines: string[] = [];
  let rest = [...value];
  while (rest.length > MAX_BLOCK_WIDTH) {
    const kept = rest[MAX_BLOCK_WIDTH - 1] === "\\" ? MAX_BLOCK_WIDTH - 1 : MAX_BLOCK_WIDTH;
    lines.push(rest.slice(0, kept).join(""));
    rest = rest.slice(kept);
  }
  if (rest.length > 0) lines.push(rest.join(""));
  return lines;
}

/**
 * The card's tool block: the last tool's name, and what it was called with when the input carried
 * anything previewable, across as many lines as the two take.
 *
 * A block of its own rather than a row of the field block, because what the operator opens the card
 * to read is what the session is working on: a real path is longer than a row of this width leaves
 * after a label, so in a row it was cut essentially always. Here the value wraps instead, and every
 * line of it is inside the same width bound the rest of the card holds.
 *
 * Both halves are attacker-influenceable and each is bounded on its own, so a session cannot hide
 * what its tools are called with by naming the tool long: the name is held to a line and the
 * preview keeps its own budget whatever the name spends. The cut is named rather than left to the
 * ellipsis, on `promptField`'s reasoning: a tool input can front-load the harmless part, and a
 * reader has to be able to tell a whole preview from a partial one. Whether the preview was cut is
 * measured on the escaped text, which is what the reader sees.
 *
 * A preview that neutralizes to nothing draws no separator with nothing after it, and a session
 * that has run no tool, or one whose tool name neutralizes to nothing, draws no lines at all, which
 * is what leaves the block and its header off the card.
 */
function toolLines(view: SessionView): string[] {
  const name = view.lastTool === null ? "" : inertBlockField(view.lastTool, MAX_BLOCK_WIDTH);
  if (name === "") return [];
  const whole = view.lastToolInput === null ? "" : inertBlock(view.lastToolInput);
  if (whole === "") return filled(name);
  const shown = fit(whole, MAX_TOOL_INPUT_PREVIEW);
  if (shown === whole) return filled(`${name} ${SEPARATOR} ${shown}`);
  const marked = fit(whole, Math.max(MAX_TOOL_INPUT_PREVIEW - CUT_MARKER.length, 0));
  return filled(`${name} ${SEPARATOR} ${marked}${CUT_MARKER}`);
}

/**
 * The card's goal block, as the header and the fenced line it takes, and nothing at all for a card
 * that carries no goal.
 *
 * A goal is drawn only while the session is working or waiting on a person. Idle and exited both
 * drop it, because a session that stopped working is the best evidence available that what it was
 * working toward is done: the console need write nothing when a goal completes, so there is no line
 * to read the end off, and a card that kept drawing one would be asserting something it cannot know.
 */
function goalLines(view: SessionView, state: SurfaceState): string[] {
  if (view.goal === null || state === "idle" || state === "exited") return [];
  const goal = inertBlockField(view.goal, MAX_BLOCK_WIDTH);
  return goal === "" ? [] : [GOAL_HEADER, fenced([goal])];
}

/**
 * A duration in the compact form the cards share: `44m`, `3h 44m`, `4d 6h`. Two units at most,
 * because the third never changes a decision and a card is read at a glance on a phone, and a space
 * between the two because that is what stays legible at phone width.
 *
 * Exported and read by both cards, so a duration cannot be spelled one way on a session's own card
 * and another on the fleet card a reader is comparing it against.
 */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * How many roster entries one card names before the rest are counted.
 *
 * Pathological rather than cosmetic: the operator reads every task a session is waiting on, and a
 * measured fan-out session peaked at twelve concurrent agents, so twice that is a fan-out nothing
 * here has produced. It is a backstop rather than the working bound, since the message ceiling
 * reaches a card first at every width; what it holds on its own is the work `renderCard` spends
 * fitting a card to one message, whatever count another program reports.
 */
const MAX_ROSTER_ENTRIES = 24;

/** The most of a task's own prose the card carries, on `MAX_TOOL_INPUT_PREVIEW`'s reasoning. */
const MAX_TASK_DESCRIPTION_LENGTH = 60;

/** The most of an agent type the card carries. A real one is a short id, as a model name is. */
const MAX_AGENT_TYPE_LENGTH = 32;

/**
 * One roster entry, as the two rows it takes: how long the task has been outstanding beside what is
 * running it, and the task's own description under that, indented to start where the type does.
 *
 * Two rows rather than one because at this width one row makes the age, the type and the
 * description compete for it, and a cut reaches the description first, which is the only field that
 * says what the work is. The type is the agent type where the harness reported one, since that is
 * what tells a reader which of a fan-out's agents this is, and the kind itself otherwise; a shell
 * task draws exactly like a subagent, because a long-running background command is the same class
 * of invisible work. The description is model-authored prose from another program and is
 * neutralized here like every other session-sourced field; a task whose description neutralizes to
 * nothing draws its first row alone rather than an empty second one.
 */
function rosterEntry(task: BackgroundTask, now: number): string[] {
  const age = span(now - task.since);
  const named =
    task.agentType === null ? "" : inertBlockField(task.agentType, MAX_AGENT_TYPE_LENGTH);
  const lead = `${age} ${SEPARATOR} `;
  const room = Math.max(MAX_BLOCK_WIDTH - [...lead].length, 0);
  const rows = [`${lead}${fit(named === "" ? task.kind : named, room)}`];
  const described =
    task.description === null
      ? ""
      : inertBlockField(task.description, Math.min(MAX_TASK_DESCRIPTION_LENGTH, room));
  if (described === "") return rows;
  // The same width the type is drawn at, so the description reads as the entry's second line rather
  // than as an entry of its own.
  rows.push(`${" ".repeat([...age].length)} ${SEPARATOR} ${described}`);
  return rows;
}

/**
 * The card's tasks block: every task the session is waiting on, and a count of any the cap left
 * out. No lines at all for a session waiting on nothing, which is every session between fan-outs,
 * and which is what leaves the block and its header off the card.
 *
 * Oldest first, which is the order the tasks were dispatched in, so an entry keeps its place as the
 * fan-out grows around it. Nothing is dropped at any size an operator will see: the whole reason
 * the roster has a block is that the operator reads what the fan-out is doing, and a count instead
 * of an entry says nothing about the work. The count is for the pathological fan-out alone, and it
 * counts from the newest end, which is the same policy the channel's pin ceiling holds: the older
 * work is what a reader has already been watching. How many are outstanding in total is on the
 * state row, which carries that count wherever a state is drawn.
 */
function rosterLines(tasks: readonly BackgroundTask[], now: number, count: number): string[] {
  // Keyed on the tasks themselves rather than on the count: a card whose ceiling has driven the
  // count to zero is still waiting on every one of them, and the `+N more` line below is what says
  // so, where an omitted block would report a fan-out as nothing at all.
  if (tasks.length === 0) return [];
  const named = tasks.slice(0, Math.max(count, 0));
  const lines = named.flatMap((task) => rosterEntry(task, now));
  const left = tasks.length - named.length;
  if (left > 0) lines.push(`+${String(left)} more`);
  return lines;
}

/**
 * The card's model rows: what the session is running now, the context size under it, and, while the
 * model is below what the session opened with, a row naming what it came down from.
 *
 * The context size has a row rather than riding the model's, because it is the figure that says how
 * much of a session is left and it is read on its own. It is drawn for any session that has
 * reported one, model or not: a session no transcript line has reported a model for, which is every
 * session on a host whose tailer is off and every session before its first reading, draws neither
 * of the other two rows.
 *
 * The marker stands for as long as the session is below its opening model rather than firing once
 * at the change, because the cost of a downgrade is duration: a thread that drops model at hour one
 * runs degraded for every hour after, and a field that reads normal at a glance is how that goes
 * unnoticed. The category rides the second row when the downgrade record named one, and its absence
 * is the entitlement path, which carries no category at all. Two rows rather than one sentence
 * because the block is a fixed width: what a session came down from, and why, does not fit beside
 * the model it is running, and cutting a row to fit would drop exactly the part that says a session
 * is degraded.
 */
function modelRows(view: SessionView): BlockRow[] {
  const model = view.model === null ? "" : inertBlockField(view.model, MAX_MODEL_NAME_LENGTH);
  const opening =
    view.openingModel === null ? "" : inertBlockField(view.openingModel, MAX_MODEL_NAME_LENGTH);
  const below =
    model !== "" &&
    view.model !== null &&
    view.openingModel !== null &&
    opening !== "" &&
    isBelowModel(view.model, view.openingModel);
  const category =
    view.downgrade === null || view.downgrade.category === null
      ? ""
      : inertBlockField(view.downgrade.category, MAX_MODEL_DETAIL_LENGTH);
  const rows: BlockRow[] = [];
  if (model !== "") rows.push({ label: CARD_LABELS.model, value: `${below ? "⚠ " : ""}${model}` });
  if (view.contextTokens !== null) {
    rows.push({ label: CARD_LABELS.context, value: compactTokens(view.contextTokens) });
  }
  if (below) {
    const flagged = category === "" ? "" : ` ${SEPARATOR} flagged ${category}`;
    rows.push({ label: CARD_LABELS.from, value: `${opening}${flagged}` });
  }
  return rows;
}

/**
 * The message a model change posts into the session's own thread, on the notice tier by default and
 * on the alert tier, with the mention that reaches a phone, when the operator's ID is passed.
 *
 * The mention is composed here from the operator's own ID and every untrusted field goes through
 * `inertField`, which escapes the angle brackets Discord's mention syntax lives inside, so the only
 * mention this message can contain is the one written on this line. `renderQuestionNotice`'s
 * pattern, and safe for its reason.
 *
 * What it carries is what upstream named and no more: the two models, the refusal category when the
 * record carried one, and the scope, which is the session. A change whose record the reader never
 * saw composes the same message without those clauses, because the fallback shape is upstream's and
 * may move, and a change nobody is told about is worse than one described thinly. The entitlement
 * path names the action that reverses it, since a consent that was dismissed means a session
 * running on the fallback until someone consents at the console.
 */
export function renderModelChange(input: {
  operatorId: string | null;
  from: string;
  to: string;
  downgrade: ModelFallback | null;
}): string {
  const mention = input.operatorId === null ? "" : `<@${input.operatorId}> `;
  const from = inertField(input.from, MAX_MODEL_NAME_LENGTH);
  const to = inertField(input.to, MAX_MODEL_NAME_LENGTH);
  const lines = [
    `${mention}🔀 **Model changed** ${SEPARATOR} now ${to}, was ${from} ${SEPARATOR} for this session`,
  ];
  const downgrade = input.downgrade;
  if (downgrade === null) return lines.join("\n");
  const original = inertField(downgrade.originalModel, MAX_MODEL_NAME_LENGTH);
  if (downgrade.cause === "refusal") {
    const category =
      downgrade.category === null ? "" : inertField(downgrade.category, MAX_MODEL_DETAIL_LENGTH);
    lines.push(
      category === ""
        ? "A safeguard refusal forced it."
        : `A safeguard refusal forced it ${SEPARATOR} flagged ${category}.`,
    );
    return lines.join("\n");
  }
  const choice = downgrade.choice === null ? "" : inertField(downgrade.choice, MAX_MODEL_DETAIL_LENGTH);
  lines.push(
    `The session's model requires usage credits and the consent prompt was ` +
      `${choice === "" ? "not answered" : choice} at the console; consenting there restores ` +
      `${original === "" ? "it" : original}.`,
  );
  return lines.join("\n");
}

/**
 * The starter message: the thread's detail card, edited in place forever after. Each field named,
 * and no session field that is not one of them.
 *
 * A title line, that same title again as a heading, and the field block, followed by the blocks a
 * card carries only when it has something to put in them: what the session is trying to finish, the
 * tool it is running, and the tasks it is waiting on, each under its own header. The title, the
 * heading and the headers stay outside a fence and everything else goes inside one. That split is
 * what the surfaces need: Discord renders no markdown at all inside a block, and the fields are a
 * table, for which a block is the only shape Discord gives that keeps a column of values under each
 * other. The goal, the tool and the tasks have blocks of their own because a label column leaves
 * none of them the room they are read for.
 *
 * The title is drawn twice because the two positions do different jobs. The first line is what
 * Discord draws inline beside the bot's name, and the heading under it is the card's own top edge,
 * which is what tells one card from the next when several are scrolled past.
 *
 * The goal is drawn while the session is working or waiting on a person, and dropped the moment it
 * reads idle or exited. Whether a goal has been met is not observable, since one that clears on
 * completion writes nothing, so the state is what stands in for it: a goal being met is precisely
 * what lets a session stop. The failure that avoids is a card carrying a finished goal indefinitely,
 * which is worse than no goal line at all, because it reads as current.
 *
 * The title is where the card gives way when it runs long, since every line of every block is
 * already inside the width bound: the name is the one field a session sizes for itself. Past that,
 * the roster gives way, entry by entry from the newest end, until the whole message is inside the
 * ceiling: at two rows an entry a card carries a fan-out and its fields, but a card whose every
 * field is at its cap and whose fan-out is at the roster cap is longer than one message, and a
 * message Discord refuses is a card frozen at whatever it last said.
 */
export function renderCard(view: SessionView, state: SurfaceState, now: number): string {
  const since = view.endedAt ?? view.lastHookAt;
  const label = stateLabel(view, state);
  // No roster on an exited card: the record's last report outlives the session, and a session
  // that has exited is running nothing, so drawing it would put a waiting-on entry with growing
  // ages under a header that says exited. Guarded here rather than cleared on the ended
  // transitions because the death backstop's exited is derived, never written to the record, so a
  // registry-side clear could not reach it, and a presumed-dead session that wakes gets its
  // roster back unchanged.
  const tasks =
    state === "exited" ? [] : [...view.backgroundTasks].sort((left, right) => left.since - right.since);
  const fields = fenced(
    alignedRows(
      [
        { label: CARD_LABELS.host, value: inertBlock(view.host) },
        {
          label: CARD_LABELS.session,
          // Sliced on the visible raw id, then neutralized: sliced after the escape, every escaped
          // character would spend two of the eight, and two ids differing only past the escapes
          // would draw one prefix on the surface the operator tells threads apart by.
          value: inertBlock(sliceCodePoints(inertName(view.sessionId), SHOWN_SESSION_ID)),
        },
        { label: CARD_LABELS.state, value: label },
        ...modelRows(view),
        { label: CARD_LABELS.heartbeat, value: heartbeat(Math.max(now - since, 0)) },
      ],
      CARD_COLUMN,
    ),
  );
  const tool = toolLines(view);
  // Cut to one line of the block rather than wrapped, since what the operator needs at a glance is
  // which goal is running rather than every clause of it, and neutralized as every other
  // transcript-sourced field is. A goal that neutralizes to nothing draws no block.
  const goal = goalLines(view, state);
  const title = (name: string): string => `${GLYPHS[state]} **${name}** ${SEPARATOR} ${label}`;
  const heading = (name: string): string =>
    `${TITLE_HEADING} ${GLYPHS[state]} ${name} ${SEPARATOR} ${label}`;
  const compose = (count: number): string => {
    const roster = rosterLines(tasks, now, count);
    const body = [
      fields,
      ...goal,
      ...(tool.length === 0 ? [] : [TOOL_HEADER, fenced(tool)]),
      ...(roster.length === 0 ? [] : [TASKS_HEADER, fenced(roster)]),
    ].join("\n");
    // The name is drawn twice, so what the ceiling leaves after everything that is not the name is
    // split between the two occurrences, and both are drawn from one fitted string: two cuts of
    // different lengths would put two spellings of one session on one card. The two newlines are the
    // ones the title, the heading and the body are joined with.
    const spent = title("").length + heading("").length + body.length + 2;
    const room = Math.floor(Math.max(MAX_CARD_LENGTH - spent, 0) / 2);
    const name = fit(inertText(displayName(view)), room);
    return `${title(name)}\n${heading(name)}\n${body}`;
  };
  // Measured in UTF-16 units, the larger of the two counts a length could mean, so holding it holds
  // the code point count too.
  let count = Math.min(tasks.length, MAX_ROSTER_ENTRIES);
  let card = compose(count);
  while (count > 0 && card.length > MAX_CARD_LENGTH) {
    count -= 1;
    card = compose(count);
  }
  return card;
}
