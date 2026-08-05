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
