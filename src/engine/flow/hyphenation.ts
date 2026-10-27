/**
 * Liang-style hyphenation patterns (English subset) in pure TypeScript.
 */

/** Common English hyphenation patterns: odd digits = break points. */
const PATTERNS: string[] = [
  'a2n', 'a2t', 'a2b', 'a2c', 'a2d', 'a2f', 'a2g', 'a2l', 'a2m', 'a2p', 'a2r', 'a2s', 'a2v',
  'e2n', 'e2r', 'e2s', 'e2d', 'e2l', 'e2m', 'e2t',
  'i2n', 'i2t', 'i2c', 'i2d', 'i2o', 'i2a',
  'o2n', 'o2p', 'o2r', 'o2u', 'o2v',
  'u2n', 'u2r', 'u2l', 'u2s',
  'tion', 'sion', 'ment', 'ness', 'able', 'ible', 'ful', 'less', 'ing', 'ed',
  '1c2h', '1s2h', '1t2h', '1p2h', '1g2h',
  '2ng1', '2ck1', '2st1', '2nd1', '2ld1', '2rd1',
  'al1ly', '1ous', '1ive', '1ize', '1ise',
  'pre1', 'pro1', 'per1', 'com1', 'con1', 'dis1', 'mis1', 'non1', 'over1', 'under1',
  're1a', 're1e', 're1i', 're1o', 're1u',
  'ex1', 'in1', 'un1', 'sub1', 'inter1', 'trans1',
];

interface CompiledPattern {
  chars: string;
  levels: number[];
}

const COMPILED: CompiledPattern[] = PATTERNS.map(p => {
  const chars: string[] = [];
  const levels: number[] = [];
  let pending = 0;
  for (const ch of p) {
    if (ch >= '0' && ch <= '9') {
      pending = ch.charCodeAt(0) - 48;
    } else {
      levels.push(pending);
      pending = 0;
      chars.push(ch);
    }
  }
  levels.push(pending);
  return { chars: chars.join(''), levels };
});

/**
 * Return character indices after which a hyphen break is allowed.
 * Never breaks within the first/last 2 characters.
 */
export function hyphenateBreaks(word: string): number[] {
  if (word.length < 5) return [];
  const lower = word.toLowerCase();
  const levels = new Array(lower.length + 1).fill(0);

  for (const pat of COMPILED) {
    let start = 0;
    while (true) {
      const idx = lower.indexOf(pat.chars, start);
      if (idx < 0) break;
      for (let i = 0; i < pat.levels.length; i++) {
        const pos = idx + i;
        if (pos < levels.length) {
          levels[pos] = Math.max(levels[pos], pat.levels[i]);
        }
      }
      start = idx + 1;
    }
  }

  // Heuristic: also allow break before common suffixes
  const suffixes = ['tion', 'sion', 'ment', 'ness', 'able', 'ible', 'ing', 'ful', 'less'];
  for (const s of suffixes) {
    if (lower.endsWith(s) && lower.length - s.length >= 3) {
      levels[lower.length - s.length] = Math.max(levels[lower.length - s.length], 1);
    }
  }

  const breaks: number[] = [];
  for (let i = 2; i <= word.length - 2; i++) {
    if (levels[i] % 2 === 1) breaks.push(i);
  }
  return breaks;
}

/** Soft-hyphen candidates: returns word pieces with hyphen on break. */
export function hyphenateWord(word: string): Array<{ left: string; right: string }> {
  return hyphenateBreaks(word).map(i => ({
    left: word.slice(0, i) + '-',
    right: word.slice(i),
  }));
}
