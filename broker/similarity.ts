// Bounded similarity sketches: "is this nearly the same text?" answered without holding the text.
//
// The broker's memory holds no conversation text past the moment it is posted, which an exact
// digest respects and a near-match comparison would ordinarily break, since "nearly" needs
// something the text can still be compared against. A sketch is the way through: the text is
// normalized, cut into overlapping word shingles, each shingle hashed to 64 bits, and only the k
// smallest hashes kept. What remains is derived hashes under a hard size bound, from which the
// words cannot be recovered and whose size does not grow with the text, so a megabyte reply and a
// one-line reply leave the same footprint.
//
// The estimate is bottom-k MinHash (a k-minimum-values sketch): the k smallest hashes of a set are
// a uniform sample of it, so the fraction of the two sketches' shared low hashes estimates the
// Jaccard similarity of the full shingle sets. The sampling is what makes the estimate honest
// across very different lengths: a short summary of a long text shares few of its shingles, and
// the estimate says so rather than rewarding the summary for being wholly contained.
import { withoutInvisible } from "./sanitize.ts";

/**
 * How many hashes a sketch keeps. The bound on memory per remembered text, and the sample size the
 * estimate is drawn from: the standard error of an estimated similarity p is roughly
 * sqrt(p * (1 - p) / k), so 128 puts a near-match estimate within a few hundredths of the truth.
 */
export const SKETCH_SIZE = 128;

/**
 * Words per shingle. Three is what separates "the same sentences" from "the same vocabulary": a
 * one-word shingle would score any two texts about the same subject as near-identical, and a long
 * shingle would score a single changed word as a wholly different text.
 */
export const SHINGLE_WORDS = 3;

/**
 * The estimated similarity at or above which two texts count as the same thing said nearly the
 * same way. The tunable knob for reply dedup, and it lives here alone: too low suppresses a second
 * message that carried content the first did not, too high ships the operator two copies of one
 * answer.
 */
export const NEAR_MATCH_THRESHOLD = 0.85;

/**
 * A text's sketch: distinct hashes in ascending order, at most `SKETCH_SIZE` of them, empty for a
 * text that normalizes to nothing. Ordering is part of the value, not an implementation detail, so
 * both the truncation and the estimate can work from the low end without re-sorting.
 */
export type Sketch = readonly bigint[];

// 64-bit FNV-1a. The offset basis and prime are the algorithm's published constants; the mask is
// what keeps the product 64-bit, since bigint multiplication is otherwise unbounded.
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SIXTY_FOUR_BITS = 0xffffffffffffffffn;

const encoder = new TextEncoder();

/** Hashes over UTF-8 bytes, so the same text hashes the same whatever it is made of. */
function hash64(value: string): bigint {
  let accumulator = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(value)) {
    accumulator = ((accumulator ^ BigInt(byte)) * FNV_PRIME) & SIXTY_FOUR_BITS;
  }
  return accumulator;
}

/** Ascending numeric order. Sort's default compares stringified values, which mis-orders bigints. */
function ascending(left: bigint, right: bigint): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * The form two texts are compared in: every run of whitespace collapsed to one space, invisible
 * characters stripped, trimmed, and case folded.
 *
 * Collapsing folds newlines into spaces, unlike `withoutInvisible` on its own, which preserves
 * them. For a sketch that is right: whether a thought was split across two lines or wrapped into
 * one paragraph is layout, not content, and a comparison that treated it as content would call a
 * reflowed copy of the same words a different text.
 *
 * Collapsing runs before the strip because the invisible class contains the whitespace characters:
 * a tab or a newline is C0, so stripping first would delete the only separator between two words
 * and weld them into one, a shingle the text never contained. Collapsing first turns every
 * separator into a plain space, leaving the strip to remove only what was genuinely invisible, the
 * zero-width family and its neighbours. It then runs again, because a stripped zero-width
 * character standing between two spaces leaves a gap behind it.
 */
export function normalizeForSketch(text: string): string {
  return withoutInvisible(text.replace(/\s+/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The bottom-k sketch of a text.
 *
 * A text with fewer words than one shingle has no shingles at all, so it sketches to a single hash
 * of its whole normalized self: short texts are then still comparable, exactly rather than nearly,
 * which is all a handful of words supports. A text that normalizes to nothing sketches to nothing.
 */
export function sketchOf(text: string): Sketch {
  const normalized = normalizeForSketch(text);
  if (normalized === "") return [];
  const words = normalized.split(" ");
  const hashes = new Set<bigint>();
  if (words.length < SHINGLE_WORDS) {
    hashes.add(hash64(normalized));
  } else {
    for (let start = 0; start + SHINGLE_WORDS <= words.length; start += 1) {
      hashes.add(hash64(words.slice(start, start + SHINGLE_WORDS).join(" ")));
    }
  }
  return [...hashes].sort(ascending).slice(0, SKETCH_SIZE);
}

/**
 * The estimated Jaccard similarity of two texts, from 0 (nothing in common) to 1 (the same
 * shingles), or 0 when either sketch is empty.
 *
 * Two empty sketches are 0 rather than 1 deliberately: they are equal, but "nothing said twice" is
 * not one thing said twice, and a caller comparing against a threshold must not read a pair of
 * blanks as a match.
 *
 * The estimate runs over the low end of the two sketches' union: merge them, take the
 * `SKETCH_SIZE` smallest distinct hashes, and answer with the share of those present in both.
 * Those hashes are a uniform sample of the union of the two full shingle sets, so the share of
 * them in the intersection estimates |intersection| / |union|, the Jaccard similarity itself.
 *
 * Only the low end is sampled because that is the range both sketches can answer for. A sketch
 * truncated at `SKETCH_SIZE` knows nothing above its own largest hash, where a shingle may have
 * existed and been cut, and counting that range would score a long text against a short one as
 * more different than it is. Taking the union's smallest `SKETCH_SIZE` stays inside the range by
 * construction: a full sketch supplies `SKETCH_SIZE` hashes at or below its own maximum on its
 * own, so the union's cut can never reach past either one's ceiling.
 */
export function similarity(a: Sketch, b: Sketch): number {
  if (a.length === 0 || b.length === 0) return 0;
  const inA = new Set(a);
  const inB = new Set(b);
  const union = [...new Set([...a, ...b])].sort(ascending).slice(0, SKETCH_SIZE);

  let common = 0;
  for (const hash of union) {
    if (inA.has(hash) && inB.has(hash)) common += 1;
  }
  return common / union.length;
}
