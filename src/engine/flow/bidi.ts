/**
 * UAX #9 bidirectional algorithm (simplified).
 * Handles common LTR/RTL mixed text for caret and display reordering.
 */

export type BidiClass =
  | 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN'
  | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON';

const RTL_RANGES: Array<[number, number]> = [
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF], // Arabic
  [0x0700, 0x074F], // Syriac
  [0x0750, 0x077F],
  [0x08A0, 0x08FF],
  [0xFB1D, 0xFB4F],
  [0xFB50, 0xFDFF],
  [0xFE70, 0xFEFF],
];

function isRtlCodePoint(cp: number): boolean {
  for (const [a, b] of RTL_RANGES) {
    if (cp >= a && cp <= b) return true;
  }
  return false;
}

function isArabic(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
    (cp >= 0x08A0 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) ||
    (cp >= 0xFE70 && cp <= 0xFEFF);
}

/** Classify a single code point into a bidi class. */
export function bidiClassOf(cp: number): BidiClass {
  if (cp === 0x0A || cp === 0x0D || cp === 0x85 || cp === 0x2029) return 'B';
  if (cp === 0x09 || cp === 0x0B || cp === 0x1F) return 'S';
  if (cp === 0x20 || cp === 0xA0) return 'WS';
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if (cp === 0x2E || cp === 0x2F) return 'ES';
  if (cp === 0x25 || cp === 0xB0 || cp === 0x2030 || cp === 0x2031) return 'ET';
  if (cp === 0x2C || cp === 0x2E || cp === 0x3A) return 'CS';
  if (isArabic(cp)) return 'AL';
  if (isRtlCodePoint(cp)) return 'R';
  if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x00C0 && cp <= 0x024F)) return 'L';
  return 'ON';
}

/**
 * Resolve paragraph embedding levels (simplified UAX #9).
 * Returns one level per UTF-16 code unit (surrogate pairs share the same level).
 */
export function resolveBidiLevels(text: string, baseLevel: 0 | 1 = 0): number[] {
  const levels: number[] = new Array(text.length).fill(baseLevel);
  const classes: BidiClass[] = [];

  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    classes[i] = bidiClassOf(cp);
    if (cp > 0xffff) {
      classes[i + 1] = classes[i];
      i++;
    }
  }

  // Detect paragraph base from first strong character
  let paraLevel: 0 | 1 = baseLevel;
  for (const c of classes) {
    if (c === 'R' || c === 'AL') { paraLevel = 1; break; }
    if (c === 'L') { paraLevel = 0; break; }
  }

  for (let i = 0; i < levels.length; i++) {
    levels[i] = paraLevel;
  }

  // Assign levels to strong/weak types
  let current = paraLevel;
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    if (c === 'R' || c === 'AL') {
      current = 1;
      levels[i] = 1;
    } else if (c === 'L') {
      current = 0;
      levels[i] = 0;
    } else if (c === 'EN' || c === 'AN') {
      levels[i] = current === 1 ? 2 : 0;
    } else if (c === 'NSM') {
      levels[i] = i > 0 ? levels[i - 1] : paraLevel;
    } else {
      levels[i] = current;
    }
  }

  return levels;
}

/** Reorder a logical string into visual display order using resolved levels. */
export function reorderForDisplay(text: string, levels?: number[]): string {
  const lv = levels ?? resolveBidiLevels(text);
  if (text.length === 0) return text;

  const maxLevel = Math.max(...lv);
  const minOdd = (() => {
    let m = Infinity;
    for (const l of lv) if (l % 2 === 1 && l < m) m = l;
    return m === Infinity ? maxLevel + 1 : m;
  })();

  const chars = text.split('');
  for (let level = maxLevel; level >= minOdd; level--) {
    let i = 0;
    while (i < chars.length) {
      if (lv[i] < level) { i++; continue; }
      let j = i;
      while (j < chars.length && lv[j] >= level) j++;
      const slice = chars.slice(i, j).reverse();
      for (let k = 0; k < slice.length; k++) chars[i + k] = slice[k];
      i = j;
    }
  }
  return chars.join('');
}

/** Map a visual index to a logical index given bidi levels. */
export function visualToLogical(text: string, visualIndex: number, levels?: number[]): number {
  const lv = levels ?? resolveBidiLevels(text);
  const n = text.length;
  if (visualIndex <= 0) return 0;
  if (visualIndex >= n) return n;

  const order = Array.from({ length: n }, (_, i) => i);
  const maxLevel = Math.max(0, ...lv);
  let minOdd = Infinity;
  for (const l of lv) if (l % 2 === 1 && l < minOdd) minOdd = l;
  if (minOdd === Infinity) minOdd = maxLevel + 1;

  for (let level = maxLevel; level >= minOdd; level--) {
    let i = 0;
    while (i < n) {
      if (lv[order[i]] < level) { i++; continue; }
      let j = i;
      while (j < n && lv[order[j]] >= level) j++;
      const slice = order.slice(i, j).reverse();
      for (let k = 0; k < slice.length; k++) order[i + k] = slice[k];
      i = j;
    }
  }
  return order[visualIndex] ?? visualIndex;
}

/** Map a logical index to a visual index. */
export function logicalToVisual(text: string, logicalIndex: number, levels?: number[]): number {
  const lv = levels ?? resolveBidiLevels(text);
  const n = text.length;
  if (logicalIndex <= 0) return 0;
  if (logicalIndex >= n) return n;

  const map = new Array(n);
  for (let v = 0; v < n; v++) {
    map[visualToLogical(text, v, lv)] = v;
  }
  return map[logicalIndex] ?? logicalIndex;
}
