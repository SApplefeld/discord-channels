// The one definition of the classes the envelope guard reads a hostile character through. Every
// boundary in the bridge derives from here: the attribute path replaces a member of HIDDEN, the
// body and tail paths skip a member of FILLER while spelling out a tag name, and both paths resolve
// a code point through `resolve` so the two can never disagree about what a character means.
//
// The classes are Unicode property expressions rather than enumerated ranges, so a Unicode revision
// that assigns a new ignorable or combining mark widens them with nothing to edit. The one
// enumerated table is DELIMITER_LOOKALIKES, which is a copy of the product's own map and so is
// carried as data with the build it was read from named beside it.

/**
 * What is replaced by `?` in an attribute value and refused in a workspace path: a code point that
 * hides itself or breaks a line for the reader downstream.
 *
 * `\p{Default_Ignorable_Code_Point}` carries the zero-width family, the soft hyphen, the Hangul and
 * Mongolian fillers and the tag block; `\p{Cc}` and `\p{Cf}` carry the C0/C1 controls and the
 * bidirectional and format controls; `\p{Zl}` and `\p{Zp}` carry the two Unicode line separators. A
 * combining mark (`\p{M}`) is deliberately absent: it is legitimate in a session name written in
 * Indic, Arabic or accented Latin text, and refusing it would refuse honest input.
 */
export const HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * What is skipped while spelling out a tag name: the wider class of everything Unicode does not
 * assign as a visible letter, digit, punctuation or symbol.
 *
 * Stated as its complement `[\p{Default_Ignorable_Code_Point}\p{C}\p{M}\p{Z}]` rather than as an
 * allowlist, so together with `[\p{L}\p{N}\p{P}\p{S}]` it covers the code space with no code point in
 * neither. The two are not disjoint: a default-ignorable point Unicode also assigns as a letter, the
 * Hangul filler U+3164 among them, is in both, and is skipped as a filler because the reader skips
 * it. It is a superset of HIDDEN, and it is what the reader walks past between the
 * letters of a tag: a combining mark, an ordinary space and a zero-width joiner all sit between the
 * letters of a tag without a reader taking them for letters of it.
 */
export const FILLER = /[\p{Default_Ignorable_Code_Point}\p{C}\p{M}\p{Z}]/u;

/**
 * The bracket and slash confusables Claude Code's own body disarmer folds onto `<`, `>` and `/`,
 * copied from build 2.1.263. This is the product's table rather than an independently derived list:
 * it is the set the layer above already collapses, and the guard folds the same set so the two
 * agree on which spellings read as a delimiter. NFKC alone does not reach it, since only a handful
 * of these fold under normalization, which is why the table is carried rather than computed.
 *
 * The keys are written as code points rather than as the glyphs they name: a bracket confusable in
 * source is one a reviewer cannot tell from its ASCII neighbour, and two of these differ only in a
 * mathematical variant selector.
 */
export const DELIMITER_LOOKALIKES: ReadonlyMap<string, string> = new Map(
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

/**
 * One code point as the reader resolves it, which both the attribute path and the body path go
 * through so neither can drift from the other's idea of what a character means.
 *
 * The delimiter map is applied first, because a mathematical or fullwidth bracket that no
 * normalization folds is a `<` to the reader; then NFKD splits a compatibility form into its base
 * and its marks, `\p{M}+` strips the marks so a letter carrying an accent still spells its letter,
 * NFKC recombines, and the result is lower-cased. A fold-only resolver would miss the brackets the
 * map exists for, and the map without the fold would miss a fullwidth letter, so both run.
 *
 * The argument is one code point as a string and the result is a string, because one code point can
 * resolve to several characters: a ligature is one point and two letters.
 */
export function resolve(point: string): string {
  const mapped = DELIMITER_LOOKALIKES.get(point) ?? point;
  return mapped.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC").toLowerCase();
}
