/** Text helpers shared by the pipeline and the quality evaluation. */

export function norm(value: string) {
  return value
    .toLowerCase()
    .replace(/[‌‏‎]/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The quote is in the source: verbatim after normalisation, or ≥70% of its words (min. 3). */
export function isGrounded(evidence: string, corpus: string): boolean {
  const quote = norm(evidence);
  if (quote.length < 3) return false;
  const haystack = norm(corpus);
  if (haystack.includes(quote)) return true;
  const words = quote.split(" ").filter((word) => word.length > 1);
  if (words.length < 3) return false;
  const present = new Set(haystack.split(" "));
  return words.filter((word) => present.has(word)).length / words.length >= 0.7;
}

/** The significant words of a text (longer than two letters). */
export function wordSet(value: string) {
  return new Set(norm(value).split(" ").filter((word) => word.length > 2));
}

/** Jaccard overlap of two word sets. */
export function overlap(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Word-set overlap (Jaccard) of two texts. */
export function similarity(left: string, right: string) {
  return overlap(wordSet(left), wordSet(right));
}
