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
 * Text for a message this broker composes and posts into a thread: a notice, a permission prompt,
 * or a message a caller has already neutralized.
 *
 * Unlike a card, this keeps markdown, and it keeps the chip syntax too. Both are load-bearing on
 * this path: the permission prompt is the one message here that deliberately mentions someone, and
 * escaping its `<@id>` would render the mention as characters and drop the ping a parked session is
 * waiting to be answered through. That is safe only because every string arriving here is either
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
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PREVIEW_LENGTH = 900;

/** What a field renders as when the tool supplied nothing for it. */
const NOTHING = "(none)";

/**
 * The card's room for a tool-input preview, in code points.
 *
 * Small on purpose. The preview answers one question, what the running tool is working on, and it
 * shares a line with the tool's name on a surface read at a glance on a phone. A budget large
 * enough to carry a whole command would let one tool call push the turn count and the heartbeat,
 * which is what the card exists to carry, off the bottom of a glance.
 */
export const MAX_TOOL_INPUT_PREVIEW = 100;

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
  const seen = withoutChips(withoutInvisible(text).trim());
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
  const body = withoutChips(seen);
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
 * The card's tool line: the last tool's name, and what it was called with when the input carried
 * anything previewable.
 *
 * The name comes first and the preview after the separator, because the thread list and a narrow
 * phone view truncate from the right, and the name is the part that has to survive that. The cut is
 * named rather than left to the ellipsis, on `promptField`'s reasoning: a tool input is
 * attacker-influenced text, so it can front-load the harmless part, and a reader has to be able to
 * tell a whole preview from a partial one. Whether it was cut is measured on the escaped text,
 * which is what the reader sees and what the budget is spent on.
 *
 * A preview that neutralizes to nothing renders as no preview at all, rather than as a separator
 * with nothing after it, and a session that has run no tool keeps the line it has always had.
 */
function toolLine(view: SessionView): string {
  if (view.lastTool === null) return "Last tool: none yet";
  // Cut to the same budget the permission prompt gives a tool name. A tool name is untrusted text
  // capped at MAX_FIELD_LENGTH, and escaping can double what that cap allows, so a name left whole
  // beside a bounded preview is the half of this line that can push the turn count and the
  // heartbeat past the card's own ceiling, where the final fit() would drop them.
  const name = fit(inertText(view.lastTool), MAX_TOOL_NAME_LENGTH);
  const whole = view.lastToolInput === null ? "" : inertText(view.lastToolInput);
  if (whole === "") return `Last tool: ${name}`;
  const shown = fit(whole, MAX_TOOL_INPUT_PREVIEW);
  return `Last tool: ${name} ${SEPARATOR} ${shown}${shown === whole ? "" : " (cut)"}`;
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
    toolLine(view),
    `Turns: ${view.turnCount}`,
    `Heartbeat: ${heartbeat(Math.max(now - since, 0))}`,
  ].join("\n");
  return fit(card, MAX_CARD_LENGTH);
}
