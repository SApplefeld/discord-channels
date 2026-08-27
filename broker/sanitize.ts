// Normalization applied to every string the broker stores, whether it arrived over the wire or was
// read back from the state file on disk, plus the compositions built out of it that more than one
// layer needs.
//
// This module imports nothing, which is the property that lets the storage layer reach a
// composition without taking on the display layer that also draws it: `persistence.ts` and
// `discord/bindings.ts` re-admit a session title from files anything running as this user can
// rewrite, and they get the whole normalization from here rather than from the renderer.
// `import-hygiene.test.ts` pins that direction.

/** Identity and display strings are capped: they are persisted and later rendered into Discord. */
export const MAX_FIELD_LENGTH = 256;

/**
 * The most code points a name, a summary, or any other short peer-written label contributes, and
 * the same number `boundedTitle` below bounds a session's own title to.
 * Both are a short name a person typed for a surface someone reads, and giving each its own
 * constant would be two numbers nobody would remember to keep in step.
 *
 * Code points rather than UTF-16 units: one emoji costs one of this budget rather than two. Which
 * of the two counting conventions a reader takes over it is that reader's own: `peerName`
 * (`broker/tail.ts`) measures the whole and refuses over the bound, while `boundedTitle` below cuts
 * through `fit`, which holds the stricter of the code-point and the UTF-16 count.
 *
 * Held here rather than in the tailer that first needed it: the restore paths (`persistence.ts`'s
 * `PersistedRecord.title` and `bindings.ts`'s `ThreadBinding.sessionTitle`) need this number too,
 * and reaching into the tailer for one constant would put the tailer, and everything it imports,
 * on the state-file and bindings load path. `tail.ts` re-exports it under this name for its own
 * readers.
 *
 * `visible`, `fit` and `boundedTitle` sit below for the same reason and it is the stronger case:
 * the restore paths need the whole composition, not just the number, and taking it from the render
 * module would put that module and its own imports on the load path a state file is read through.
 * Every one of them needs nothing but this file, so the storage layer reaches no display module at
 * all, which `import-hygiene.test.ts` pins. `discord/render.ts` re-exports `fit` and `boundedTitle`
 * for the callers that already read them from there.
 */
export const MAX_PEER_NAME_LENGTH = 120;

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

/**
 * Whether every surrogate code unit in a string has its partner, which is what makes the string
 * encodable as the UTF-8 a JSON request body is sent as.
 *
 * Written out rather than called as `String.prototype.isWellFormed`, which exists on the Node this
 * runs on but is typed only from the `es2024` library: reaching it would mean moving the whole
 * project's compiler target for one call, which is a larger change than this reading is worth.
 *
 * Shared rather than duplicated: the tailer's `customTitle` reader refuses an ill-formed value
 * before it can reach a `PATCH /channels/{threadId}` body, and the same value re-enters from two
 * files anything running as this user can rewrite, the registry snapshot and the thread bindings,
 * where `clean`'s own UTF-16-unit cap can split an astral pair and manufacture a lone surrogate
 * that was not there. Both restore paths refuse the same way, on this one scan, so the two checks
 * cannot drift apart.
 */
export function isWellFormed(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      at += 1;
    }
  }
  return true;
}

/**
 * `clean`, refused to null instead of returned when the cap itself manufactured a lone surrogate.
 *
 * `clean`'s cap is a UTF-16-unit cut, which can fall between the halves of an astral pair; nothing
 * downstream repairs that, so a defect made here would reach a `PATCH /channels/{threadId}` body
 * that has to be valid UTF-8. Not every restored field carries this guard: `persistence.ts`'s
 * `name` and `bindings.ts`'s `name` are two fields it covers directly, and several others in each
 * file (`host`, `source`, `lastTool`, `lastToolInput`, `openingModel`, `model` in one, `title` in
 * the other) are restored through `clean` alone, a pre-existing gap this function does not close.
 * `title` and `sessionTitle` get the same check as part of `boundedTitle`, which composes it in.
 *
 * Refusing the whole value is right here and cutting is right for a title, which is the opposite
 * answer to the same defect, because the two fields fail differently. A name refused falls back to
 * the launch label or the session-ID stub, both of which the thread can already be titled with, and
 * an ill-formed name can only arrive from a tampered or truncated state file: the header path
 * cannot carry a surrogate at all, since Node decodes request headers as latin-1. A title refused
 * would silently drop the rename the operator asked for, so `boundedTitle` cuts on code points and
 * refuses only what arrived ill-formed.
 *
 * Shared between the two restore paths (`persistence.ts`, `bindings.ts`) rather than duplicated,
 * the same reason `isWellFormed` above is shared: the file each reads is one anything running as
 * this user can rewrite, and two copies of the same guard are two places to drift apart.
 */
export function cleanWellFormed(value: string): string | null {
  const cleaned = clean(value);
  return isWellFormed(cleaned) ? cleaned : null;
}

/**
 * Strips the invisible reordering characters and collapses runs of whitespace to one space.
 *
 * For a title or a card field, which are single-line by construction. The class itself is shared
 * with the path that carries text to the model, so the two cannot come to disagree about which
 * characters are allowed to be invisible.
 */
export function visible(value: string): string {
  return [...value]
    .filter((character) => !isInvisible(character.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
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
 * A short peer-written label, normalized and bounded, or null when there is nothing usable left.
 *
 * The one normalization for a value that is both rendered (the transcript reader,
 * `broker/tail.ts`'s `customTitle`) and restored (the registry snapshot, the thread binding). All
 * three call this rather than composing the same steps themselves, so the value a live read
 * produces and the value a restart restores cannot drift into two different readings of the bound.
 *
 * An ill-formed value is refused outright, ahead of every strip. A lone surrogate is in no
 * character class any of the steps below reach: `isInvisible` covers none of `0xd800` through
 * `0xdfff`, `visible` spreads by code point and keeps it whole, and `clean` strips only C0 and
 * DEL. Nothing legitimate writes one, so refusing rather than repairing keeps a surface's current
 * value rather than painting a replacement character onto it.
 *
 * Every bound sits behind every strip, and the order is the whole substance of this function.
 * `visible` runs first: it strips the invisible class and collapses runs of whitespace to one
 * space, the same normalization a thread name is drawn through at the render site. `clean` runs
 * behind it, kept for the repo-wide rule that a stored display string is cleaned before it is
 * bounded. Its two operations do different things at this position: the control-character strip
 * changes no value here, since C0 and DEL are already a strict subset of the invisible class
 * `visible` just removed, but its length cap is not covered by that argument at all. That cap is
 * a raw UTF-16-unit cut with no notion of a surrogate pair, so it can fall between the two halves of
 * one, and it is exactly why the recheck below exists. `fit` takes `limit` last, on code points
 * rather than UTF-16 units, so it is the step that actually bounds the result a caller sees.
 *
 * Checked again after `fit`, not just after the initial refusal: `clean`'s own cap is the UTF-16-unit
 * cut described above, and it can manufacture a lone surrogate that was not in the input. `fit`'s
 * own cut cannot create one, and for every `limit` this reader actually passes, it also strips one
 * `clean` already made, since the defect can only sit at the very end of `clean`'s output and a
 * `limit` under 256 always cuts past it. The recheck is what makes that a property of this function
 * rather than a fact a caller has to hold in their head about how `limit` compares to `clean`'s own
 * cap.
 *
 * What this cannot promise is that the result draws as anything. The invisible class is a class of
 * characters that render as nothing on every surface, not of every character that happens to draw
 * blank in some font: the Hangul filler and the Braille blank pattern are ordinary printable
 * characters and survive, here and at the render site alike. A value made only of those reads as
 * empty to a person and as set to this reader, which is the shared class's limit rather than a gap
 * in this gate (`docs/security-model.md`), and widening the class here would put the render site and
 * this reader out of step.
 */
export function boundedTitle(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || !isWellFormed(value)) return null;
  // A non-positive limit leaves no room for a character, the same floor `fit` itself holds; without
  // this, `fit("", limit)`'s own `""` for no room reads as `isWellFormed("")` true and this
  // function would return an empty string instead of the null every other refusal here returns.
  if (limit <= 0) return null;
  const written = clean(visible(value));
  if (written === "") return null;
  const fitted = fit(written, limit);
  return isWellFormed(fitted) ? fitted : null;
}
