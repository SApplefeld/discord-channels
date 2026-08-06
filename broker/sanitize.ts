// Normalization applied to every string the broker stores, whether it arrived over the wire or was
// read back from the state file on disk.

/** Identity and display strings are capped: they are persisted and later rendered into Discord. */
export const MAX_FIELD_LENGTH = 256;

// C0 and DEL. These fields reach a log line and a Discord message, where an escape sequence has no
// business being.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Strips control characters, trims, and caps length.
 *
 * This is the storage guarantee and nothing more: the result is bounded and free of escape
 * sequences, and it is still attacker-controlled text. It is not escaped for Discord, so
 * `@everyone`, `@here`, markdown, and bidirectional overrides all survive it. Rendering safety is
 * the render site's job, via `allowed_mentions` where the text reaches Discord.
 */
export function clean(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "").trim().slice(0, MAX_FIELD_LENGTH);
}

/**
 * Code points that can reorder or hide text with no visual trace.
 *
 * The class covers C0 and DEL, the soft hyphen, the bidirectional overrides and isolates, the
 * zero-width family, the word joiner, the variation selectors, the byte order mark, and the Unicode
 * tag block, which encodes a full hidden copy of ASCII that renders as nothing at all and is the
 * standard way text is smuggled past a reader. It is a class of what is invisible, not of what is
 * merely unusual: a homoglyph, a right-to-left script, and an emoji are all legible and all stay.
 *
 * Held here rather than beside any one consumer because two very different surfaces need the same
 * class and must not drift: what reaches Discord, and what reaches the model. A person reads both
 * to decide whether a session is doing what they asked, so a character that shows them two
 * different texts is the whole problem. Written as numbers rather than as a regular expression
 * because a literal control character in source is invisible to review, and an escape for one is
 * easy to get silently wrong.
 */
export function isInvisible(code: number): boolean {
  return (
    code <= 0x1f ||
    code === 0x7f ||
    // Soft hyphen: renders as nothing until a line break falls on it.
    code === 0x00ad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    // The tag block. Every printable ASCII character has a copy here that renders as nothing.
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/**
 * Strips the invisible class while keeping line structure.
 *
 * Line by line, because the newline is itself in the C0 range: one pass over the whole string would
 * silently join a multi-line message into a single line, which changes what the text says.
 */
export function withoutInvisible(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => [...line].filter((character) => !isInvisible(character.codePointAt(0) ?? 0)).join(""))
    .join("\n");
}

/**
 * Truncates to a length in code points, never in UTF-16 units. Cutting an astral-plane character in
 * half leaves a lone surrogate, which is not valid UTF-8 for a request body or a JSON-RPC frame.
 */
export function sliceCodePoints(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : characters.slice(0, limit).join("");
}
