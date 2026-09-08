// A copy of Claude Code's own channel-body reader classes, taken from build 2.1.263. Data only:
// no product code runs here, and nothing below is claimed to be anything but a snapshot of one
// build's tables. The bridge's own guard lives in `bridge/reader-class.ts`; this file is the
// yardstick its test measures against, so the test's oracle is the product's reader rather than the
// guard's own definition. A test whose oracle is the guard proves only that the guard matches
// itself, which is why it takes its classes from here instead.

/** The build these tables were read from. */
export const PRODUCT_BUILD = "2.1.263";

// The product's `h8t` string: the ignorable and format ranges its disarmer skips between the
// letters of a tag name.
const HIDDEN_RANGES =
  "\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160" +
  "\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164" +
  "\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}" +
  "\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}";

// The product's `w` string: the combining-mark ranges it also skips between letters.
const COMBINING_RANGES =
  "\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5" +
  "\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8" +
  "\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe20-\\ufe2f";

/**
 * The product's `L` filler class: everything its disarmer walks past between the letters of a tag.
 * `HIDDEN_RANGES` plus `COMBINING_RANGES` plus the C0/C1 control ranges and the two Unicode line
 * separators, exactly as the product assembles them.
 */
export const PRODUCT_FILLER = new RegExp(
  "[" + HIDDEN_RANGES + COMBINING_RANGES + "\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029]",
  "u",
);

/**
 * The product's `_` map: 33 bracket and slash confusables folded onto `<`, `>` and `/`. Written by
 * code point, for the same reason the guard's own copy is: a bracket confusable in source reads as
 * its ASCII neighbour.
 */
export const PRODUCT_LOOKALIKES: ReadonlyMap<string, string> = new Map(
  (
    [
      [0xff1c, "<"], [0xff1e, ">"], [0xfe64, "<"], [0xfe65, ">"],
      [0x2329, "<"], [0x232a, ">"], [0x27e8, "<"], [0x27e9, ">"],
      [0x3008, "<"], [0x3009, ">"], [0x2039, "<"], [0x203a, ">"],
      [0x02c2, "<"], [0x02c3, ">"], [0x1438, "<"], [0x1433, ">"],
      [0x276c, "<"], [0x276d, ">"], [0x276e, "<"], [0x276f, ">"],
      [0x2770, "<"], [0x2771, ">"], [0x29fc, "<"], [0x29fd, ">"],
      [0x226e, "<"], [0x226f, ">"], [0x227a, "<"], [0x227b, ">"],
      [0x22d6, "<"], [0x22d7, ">"], [0xff0f, "/"], [0x2215, "/"],
      [0x2044, "/"],
    ] as const
  ).map(([code, ascii]) => [String.fromCodePoint(code), ascii]),
);
