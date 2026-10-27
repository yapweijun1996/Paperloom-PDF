/**
 * Line breaking — greedy (fast) and Knuth-Plass (optimal) paragraph wrapping.
 */

import { hyphenateBreaks } from './hyphenation';

/** Split text into lines that each fit within maxWidth (page units). */
export function greedyWrap(
  text: string,
  maxWidth: number,
  measure: (segment: string) => number,
): string[] {
  if (!text) return [''];
  if (maxWidth <= 0) return [text];

  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [text];

  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    const width = measure(candidate);

    if (width <= maxWidth || current === '') {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

export interface KnuthPlassOptions {
  hyphenate?: boolean;
  tolerance?: number;
  hyphenPenalty?: number;
  greedyThreshold?: number;
}

/**
 * Knuth-Plass DP line breaker over words (with optional hyphenation candidates).
 * Demerits = (maxWidth − lineWidth)² + hyphen penalties.
 * Falls back to greedy for short text or on failure.
 */
export function knuthPlassWrap(
  text: string,
  maxWidth: number,
  measure: (segment: string) => number,
  options: KnuthPlassOptions = {},
): string[] {
  if (!text) return [''];
  if (maxWidth <= 0) return [text];

  const {
    hyphenate = true,
    hyphenPenalty = 50,
    greedyThreshold = 40,
  } = options;

  if (text.length < greedyThreshold) {
    return greedyWrap(text, maxWidth, measure);
  }

  try {
    // Build word list with optional hyphenation variants as break opportunities
    const rawWords = text.split(/\s+/).filter(w => w.length > 0);
    if (rawWords.length === 0) return [text];

    interface Item {
      text: string;
      width: number;
      penalty: number;
    }

    const items: Item[] = [];
    for (const word of rawWords) {
      if (hyphenate && word.length >= 6) {
        const breaks = hyphenateBreaks(word);
        if (breaks.length > 0) {
          // Use first hyphenation point as optional break: left- / right
          const b = breaks[Math.floor(breaks.length / 2)];
          items.push({
            text: word.slice(0, b) + '-',
            width: measure(word.slice(0, b) + '-'),
            penalty: hyphenPenalty,
          });
          items.push({
            text: word.slice(b),
            width: measure(word.slice(b)),
            penalty: 0,
          });
          continue;
        }
      }
      items.push({ text: word, width: measure(word), penalty: 0 });
    }

    const spaceW = measure(' ');
    const m = items.length;
    // dp[i] = min demerits to cover items[0..i)
    const dp = new Array(m + 1).fill(Infinity);
    const parent = new Array(m + 1).fill(-1);
    dp[0] = 0;

    for (let i = 0; i < m; i++) {
      if (dp[i] === Infinity) continue;
      let lineW = 0;
      for (let j = i; j < m; j++) {
        lineW += items[j].width + (j > i ? spaceW : 0);
        if (lineW > maxWidth * 1.5 && j > i) break;

        const slack = maxWidth - lineW;
        let demerits = slack * slack;
        if (lineW > maxWidth) demerits += (lineW - maxWidth) * (lineW - maxWidth) * 8;
        demerits += items[j].penalty;
        const total = dp[i] + demerits;
        if (total < dp[j + 1]) {
          dp[j + 1] = total;
          parent[j + 1] = i;
        }
      }
    }

    // Reconstruct
    if (parent[m] < 0 && dp[m] === Infinity) {
      return greedyWrap(text, maxWidth, measure);
    }

    const breaks: number[] = [];
    let cur = m;
    let guard = 0;
    while (cur > 0 && guard++ < m + 2) {
      breaks.push(cur);
      const p = parent[cur];
      if (p < 0) break;
      cur = p;
    }
    breaks.reverse();

    const lines: string[] = [];
    let start = 0;
    for (const end of breaks) {
      const slice = items.slice(start, end);
      // Join hyphenated pieces without space when previous ended with '-'
      let line = '';
      for (let k = 0; k < slice.length; k++) {
        const t = slice[k].text;
        if (k === 0) {
          line = t;
        } else if (line.endsWith('-') && slice[k - 1].penalty > 0) {
          // Soft hyphen at mid-line: drop hyphen and join
          line = line.slice(0, -1) + t;
        } else {
          line += ' ' + t;
        }
      }
      // Keep trailing hyphen only at true line end
      lines.push(line);
      start = end;
    }

    return lines.length > 0 ? lines : greedyWrap(text, maxWidth, measure);
  } catch {
    return greedyWrap(text, maxWidth, measure);
  }
}

/** Preview wrap — uses Knuth-Plass for longer text, greedy for short. */
export function previewWrap(
  text: string,
  maxWidth: number,
  measure: (segment: string) => number,
): string[] {
  if (text.length > 40) {
    return knuthPlassWrap(text, maxWidth, measure);
  }
  return greedyWrap(text, maxWidth, measure);
}
