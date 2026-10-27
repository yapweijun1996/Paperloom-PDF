/**
 * Grapheme-cluster-aware caret movement (UAX #29 subset).
 */

/** Split text into grapheme clusters. Uses Intl.Segmenter when available. */
export function graphemeClusters(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), s => s.segment);
  }
  // Fallback: code points (not full grapheme clusters, but safe)
  return Array.from(text);
}

/** Convert a UTF-16 char index to a grapheme index. */
export function graphemeIndexFromCharIndex(text: string, charIndex: number): number {
  const clusters = graphemeClusters(text);
  let offset = 0;
  for (let i = 0; i < clusters.length; i++) {
    if (offset + clusters[i].length > charIndex) return i;
    offset += clusters[i].length;
  }
  return clusters.length;
}

/** Convert a grapheme index to a UTF-16 char index. */
export function charIndexFromGraphemeIndex(text: string, graphemeIndex: number): number {
  const clusters = graphemeClusters(text);
  let offset = 0;
  const limit = Math.max(0, Math.min(graphemeIndex, clusters.length));
  for (let i = 0; i < limit; i++) offset += clusters[i].length;
  return offset;
}

/**
 * Move caret by one grapheme cluster.
 * @param direction -1 = left/back, +1 = right/forward
 */
export function moveCaret(text: string, charIndex: number, direction: -1 | 1): number {
  const g = graphemeIndexFromCharIndex(text, charIndex);
  const next = Math.max(0, Math.min(graphemeClusters(text).length, g + direction));
  return charIndexFromGraphemeIndex(text, next);
}

/** Clamp a caret index to valid grapheme boundaries. */
export function snapCaretToGrapheme(text: string, charIndex: number): number {
  const g = graphemeIndexFromCharIndex(text, Math.max(0, Math.min(text.length, charIndex)));
  return charIndexFromGraphemeIndex(text, g);
}
