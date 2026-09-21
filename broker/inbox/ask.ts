// The producer signal for the operator inbox: a session marks a reply as needing the operator by
// putting an `ASK:` line in it, and this module is the one reading of that mark.
//
// A mark is a line whose first non-space characters are exactly `ASK:`, uppercase with the colon,
// sitting outside a fenced code block. The rule is narrow on purpose. A reply quoting code, a log, a
// transcript or a review of another session's text carries `ASK:` lines that are not this session's
// asks, and a parser that matched them would turn every code review into an item on the operator's
// inbox. So a blockquoted `> ASK:` line, a bulleted `- ASK:` line, a lowercase `ask:` and an `ASK:`
// in the middle of a line all mark nothing, and anything inside a fence marks nothing either.
//
// It also answers a second, separate question: whether a reply carries a line the persona plugin
// reads as a worker's ask of its steward. That reading follows the sibling's matcher, not the mark
// rule above, and is described at `hasStewardAsk`.
//
// Pure and synchronous, and it logs nothing, since what it reads is session-authored text.
import { sliceCodePoints, visible } from "../sanitize.ts";

/** The longest excerpt an item carries, counted in code points so a cut never splits a pair. */
export const MAX_EXCERPT_CODE_POINTS = 200;

const MARK = "ASK:";

/**
 * A fence opener: three or more backticks or three or more tildes, at the start of the line once
 * its leading whitespace is set aside. After a backtick run, CommonMark admits an info string (such
 * as a language name) only where it carries no backtick, so a line like "```x```" is inline code
 * and opens nothing. A tilde run takes any info string.
 */
const FENCE_OPEN = /^(?:(`{3,})[^`]*$|(~{3,}))/;

/**
 * The excerpt of the reply's first `ASK:` line, or null where the reply carries no mark.
 *
 * The excerpt is the rest of that line with every run of whitespace collapsed to one space, then
 * run through `visible` (the invisible class stripped, trimmed) and cut to `MAX_EXCERPT_CODE_POINTS`.
 * The strip comes before the cut, the order every stored display string in this repo takes, so a
 * hidden character can neither reach the operator's card nor spend the excerpt's budget. A mark with
 * nothing after it still marks, and its excerpt is the empty string, so a caller tells "marked"
 * from "not marked" by null alone.
 *
 * Fences follow CommonMark's opening and closing shape: a fence closes on a later line whose first
 * non-space characters are the same fence character, at least as many as opened it, followed only by
 * whitespace. A fence that never closes runs to the end of the text, so an `ASK:` line after an
 * unclosed opener is read as quoted rather than as a mark.
 */
export function findAsk(text: string): string | null {
  let fence: { character: string; length: number } | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const content = line.trimStart();
    if (fence !== null) {
      if (closesFence(content, fence.character, fence.length)) fence = null;
      continue;
    }
    const opener = FENCE_OPEN.exec(content);
    if (opener !== null) {
      const run = opener[1] ?? opener[2] ?? "";
      fence = { character: run.charAt(0), length: run.length };
      continue;
    }
    if (content.startsWith(MARK)) {
      // Whitespace collapses before the strip: a tab is in the invisible class, and stripped first
      // it would join the two words it separated.
      const rest = content.slice(MARK.length).replace(/\s+/g, " ");
      return sliceCodePoints(visible(rest), MAX_EXCERPT_CODE_POINTS);
    }
  }
  return null;
}

/**
 * The persona plugin's own ask matcher, the regular expression copied from the `askMarkerMatch`
 * read of a worker's turn-final answer in `agent_persona`'s `hooks/index.ts`, with one addition
 * for cost. The sibling's `\s*` and the lazy capture after it can both take a whitespace run, so
 * on a long run the engine tries every split of it, which is quadratic in the run's length. The
 * `(?=\S)` lookahead pins the capture to the first non-space character. It preserves the
 * classification: any match whose capture opened on whitespace has an equivalent match with the
 * `\s*` taking that whitespace instead, so the same lines match and the same lines do not.
 */
const STEWARD_ASK = /^ASK:\s*(?=\S)(.+?\?\s*Recommend:\s*.+)$/im;

/**
 * Whether the reply carries at least one line the persona plugin reads as a worker's ask of its
 * steward: `ASK: <question>? Recommend: <choice>`. Such a line is addressed to the steward rather
 * than to the operator, and the caller that knows the session's lineage decides what that means.
 *
 * It deliberately differs from `findAsk`'s mark rule. The mark rule is the inbox's own and is
 * uppercase-only and fence-aware; this one copies the sibling's matcher as it stands, so it is
 * case-insensitive, anchored at the line's first character, and blind to fences. The regular
 * expression is the whole of what is copied (with the lookahead noted at `STEWARD_ASK`, which
 * changes its cost and not its language), so the two agree on the line's shape: where they
 * disagreed, a line the steward is answering could land on the operator's card, or the reverse.
 * The sibling then goes one step further than this reading does. It refuses a captured question
 * that still carries a template placeholder (`<...>`), so a worker echoing the template shape
 * opens no steward ask there, while the same line is steward-shaped here. A steward-shaped line
 * is still an `ASK:` mark to `findAsk`.
 */
export function hasStewardAsk(text: string): boolean {
  return STEWARD_ASK.test(text);
}

function closesFence(content: string, character: string, length: number): boolean {
  let run = 0;
  while (run < content.length && content.charAt(run) === character) run += 1;
  return run >= length && content.slice(run).trim() === "";
}
