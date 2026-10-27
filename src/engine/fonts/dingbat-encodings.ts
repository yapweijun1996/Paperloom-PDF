/**
 * Standard PDF encodings for Symbol and ZapfDingbats.
 *
 * PDF viewers must use these when /BaseFont is Symbol or ZapfDingbats
 * (even if /Encoding is missing or incorrectly set to WinAnsi/Standard).
 * Without this, dingbat bytes decode as Latin letters — e.g. ZapfDingbats
 * code 108 (●) becomes "l" and code 120 becomes "x".
 *
 * Embedded Symbol CID fonts (Identity-H) are different: the stream char code
 * is often a glyph ID, not a SymbolEncoding byte. Reverse the TTF cmap first,
 * then map the SymbolEncoding byte (or Microsoft Symbol PUA U+F0xx) to Unicode.
 */

/** ZapfDingbatsEncoding byte → Unicode (from Adobe / PDF.js glyph lists). */
export const ZAPF_DINGBATS_TO_UNICODE: Record<number, string> = {
  32: ' ', 33: '\u2701', 34: '\u2702', 35: '\u2703', 36: '\u2704', 37: '\u260E',
  38: '\u2706', 39: '\u2707', 40: '\u2708', 41: '\u2709', 42: '\u261B', 43: '\u261E',
  44: '\u270C', 45: '\u270D', 46: '\u270E', 47: '\u270F', 48: '\u2710', 49: '\u2711',
  50: '\u2712', 51: '\u2713', 52: '\u2714', 53: '\u2715', 54: '\u2716', 55: '\u2717',
  56: '\u2718', 57: '\u2719', 58: '\u271A', 59: '\u271B', 60: '\u271C', 61: '\u271D',
  62: '\u271E', 63: '\u271F', 64: '\u2720', 65: '\u2721', 66: '\u2722', 67: '\u2723',
  68: '\u2724', 69: '\u2725', 70: '\u2726', 71: '\u2727', 72: '\u2605', 73: '\u2729',
  74: '\u272A', 75: '\u272B', 76: '\u272C', 77: '\u272D', 78: '\u272E', 79: '\u272F',
  80: '\u2730', 81: '\u2731', 82: '\u2732', 83: '\u2733', 84: '\u2734', 85: '\u2735',
  86: '\u2736', 87: '\u2737', 88: '\u2738', 89: '\u2739', 90: '\u273A', 91: '\u273B',
  92: '\u273C', 93: '\u273D', 94: '\u273E', 95: '\u273F', 96: '\u2740', 97: '\u2741',
  98: '\u2742', 99: '\u2743', 100: '\u2744', 101: '\u2745', 102: '\u2746', 103: '\u2747',
  104: '\u2748', 105: '\u2749', 106: '\u274A', 107: '\u274B', 108: '\u25CF',
  109: '\u274D', 110: '\u25A0', 111: '\u274F', 112: '\u2750', 113: '\u2751',
  114: '\u2752', 115: '\u25B2', 116: '\u25BC', 117: '\u25C6', 118: '\u2756',
  119: '\u25D7', 120: '\u2758', 121: '\u2759', 122: '\u275A', 123: '\u275B',
  124: '\u275C', 125: '\u275D', 126: '\u275E', 161: '\u2761', 162: '\u2762',
  163: '\u2763', 164: '\u2764', 165: '\u2765', 166: '\u2766', 167: '\u2767',
  168: '\u2663', 169: '\u2666', 170: '\u2665', 171: '\u2660', 172: '\u2460',
  173: '\u2461', 174: '\u2462', 175: '\u2463', 176: '\u2464', 177: '\u2465',
  178: '\u2466', 179: '\u2467', 180: '\u2468', 181: '\u2469', 182: '\u2776',
  183: '\u2777', 184: '\u2778', 185: '\u2779', 186: '\u277A', 187: '\u277B',
  188: '\u277C', 189: '\u277D', 190: '\u277E', 191: '\u277F',
};

/** Common ZapfDingbats glyph names → Unicode (Differences arrays). */
export const ZAPF_DINGBATS_GLYPH_TO_UNICODE: Record<string, string> = {
  a71: '\u25CF', a73: '\u25A0', a75: '\u2751', a76: '\u25B2', a77: '\u25BC',
  a78: '\u25C6', a79: '\u2756', a81: '\u25D7', a82: '\u2758',
  a108: '\u2767', a109: '\u2660', a110: '\u2665', a111: '\u2666', a112: '\u2663',
  blackcircle: '\u25CF', bullet: '\u2022', filledbox: '\u25A0',
};

/**
 * SymbolSetEncoding byte → Unicode (Adobe glyph list / PDF.js).
 * Note: byte 120 is Greek xi (ξ), not a bullet — bullets are byte 183 (•).
 */
export const SYMBOL_TO_UNICODE: Record<number, string> = {
  32: ' ', 33: '!', 34: '\u2200', 35: '#', 36: '\u2203', 37: '%', 38: '&', 39: '\u220B',
  40: '(', 41: ')', 42: '\u2217', 43: '+', 44: ',', 45: '\u2212', 46: '.', 47: '/',
  48: '0', 49: '1', 50: '2', 51: '3', 52: '4', 53: '5', 54: '6', 55: '7', 56: '8',
  57: '9', 58: ':', 59: ';', 60: '<', 61: '=', 62: '>', 63: '?', 64: '\u2245',
  65: '\u0391', 66: '\u0392', 67: '\u03A7', 68: '\u2206', 69: '\u0395', 70: '\u03A6',
  71: '\u0393', 72: '\u0397', 73: '\u0399', 74: '\u03D1', 75: '\u039A', 76: '\u039B',
  77: '\u039C', 78: '\u039D', 79: '\u039F', 80: '\u03A0', 81: '\u0398', 82: '\u03A1',
  83: '\u03A3', 84: '\u03A4', 85: '\u03A5', 86: '\u03C2', 87: '\u2126', 88: '\u039E',
  89: '\u03A8', 90: '\u0396', 91: '[', 92: '\u2234', 93: ']', 94: '\u22A5', 95: '_',
  96: '\uF8E5', 97: '\u03B1', 98: '\u03B2', 99: '\u03C7', 100: '\u03B4', 101: '\u03B5',
  102: '\u03C6', 103: '\u03B3', 104: '\u03B7', 105: '\u03B9', 106: '\u03D5',
  107: '\u03BA', 108: '\u03BB', 109: '\u00B5', 110: '\u03BD', 111: '\u03BF',
  112: '\u03C0', 113: '\u03B8', 114: '\u03C1', 115: '\u03C3', 116: '\u03C4',
  117: '\u03C5', 118: '\u03D6', 119: '\u03C9', 120: '\u03BE', 121: '\u03C8',
  122: '\u03B6', 123: '{', 124: '|', 125: '}', 126: '\u223C', 160: '\u20AC',
  161: '\u03D2', 162: '\u2032', 163: '\u2264', 164: '\u2044', 165: '\u221E',
  166: '\u0192', 167: '\u2663', 168: '\u2666', 169: '\u2665', 170: '\u2660',
  171: '\u2194', 172: '\u2190', 173: '\u2191', 174: '\u2192', 175: '\u2193',
  176: '\u00B0', 177: '\u00B1', 178: '\u2033', 179: '\u2265', 180: '\u00D7',
  181: '\u221D', 182: '\u2202', 183: '\u2022', 184: '\u00F7', 185: '\u2260',
  186: '\u2261', 187: '\u2248', 188: '\u2026', 189: '\uF8E6', 190: '\uF8E7',
  191: '\u21B5', 192: '\u2135', 193: '\u2111', 194: '\u211C', 195: '\u2118',
  196: '\u2297', 197: '\u2295', 198: '\u2205', 199: '\u2229', 200: '\u222A',
  201: '\u2283', 202: '\u2287', 203: '\u2284', 204: '\u2282', 205: '\u2286',
  206: '\u2208', 207: '\u2209', 208: '\u2220', 209: '\u2207', 210: '\uF6DA',
  211: '\uF6D9', 212: '\uF6DB', 213: '\u220F', 214: '\u221A', 215: '\u22C5',
  216: '\u00AC', 217: '\u2227', 218: '\u2228', 219: '\u21D4', 220: '\u21D0',
  221: '\u21D1', 222: '\u21D2', 223: '\u21D3', 224: '\u25CA', 225: '\u2329',
  226: '\uF8E8', 227: '\uF8E9', 228: '\uF8EA', 229: '\u2211', 230: '\uF8EB',
  231: '\uF8EC', 232: '\uF8ED', 233: '\uF8EE', 234: '\uF8EF', 235: '\uF8F0',
  236: '\uF8F1', 237: '\uF8F2', 238: '\uF8F3', 239: '\uF8F4', 241: '\u232A',
  242: '\u222B', 243: '\u2320', 244: '\uF8F5', 245: '\u2321', 246: '\uF8F6',
  247: '\uF8F7', 248: '\uF8F8', 249: '\uF8F9', 250: '\uF8FA', 251: '\uF8FB',
  252: '\uF8FC', 253: '\uF8FD', 254: '\uF8FE',
};

export const SYMBOL_GLYPH_TO_UNICODE: Record<string, string> = {
  bullet: '\u2022', periodcentered: '\u00B7', circle: '\u25CB',
  filledcircle: '\u25CF', blackcircle: '\u25CF',
};

export function isZapfDingbatsFont(baseFont: string): boolean {
  const lower = baseFont.toLowerCase();
  return lower.includes('zapf') || lower.includes('dingbat');
}

export function isSymbolFont(baseFont: string): boolean {
  const lower = baseFont.toLowerCase().replace(/^[a-z]{6}\+/, '');
  return lower === 'symbol' || /(^|[^a-z])symbol$/i.test(lower);
}

/**
 * Map a ZapfDingbats char code to Unicode.
 * Prefer Differences glyph name when present.
 */
export function zapfDingbatsCharToUnicode(
  charCode: number,
  differences?: Map<number, string>,
): string | null {
  const diffName = differences?.get(charCode);
  if (diffName) {
    if (ZAPF_DINGBATS_GLYPH_TO_UNICODE[diffName]) {
      return ZAPF_DINGBATS_GLYPH_TO_UNICODE[diffName];
    }
  }
  return ZAPF_DINGBATS_TO_UNICODE[charCode] ?? null;
}

/**
 * Map a SymbolSetEncoding byte to Unicode.
 * Prefer Differences glyph name when present.
 */
export function symbolCharToUnicode(
  charCode: number,
  differences?: Map<number, string>,
): string | null {
  const diffName = differences?.get(charCode);
  if (diffName) {
    if (SYMBOL_GLYPH_TO_UNICODE[diffName]) return SYMBOL_GLYPH_TO_UNICODE[diffName];
    if (SYMBOL_TO_UNICODE[charCode]) return SYMBOL_TO_UNICODE[charCode];
  }
  return SYMBOL_TO_UNICODE[charCode] ?? null;
}

/**
 * True when ToUnicode produced a Latin letter/digit that is almost certainly
 * wrong for a dingbat/symbol font (e.g. bullet → "x").
 */
export function isSuspiciousDingbatToUnicode(unicode: string): boolean {
  if (!unicode || unicode.length === 0) return true;
  if (unicode.length > 2) return false;
  const cp = unicode.codePointAt(0)!;
  // Basic Latin letters/digits/punct that dingbat fonts never mean literally
  return (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39);
}

/**
 * Resolve a glyph ID to a drawable Unicode string via the font's cmap.
 *
 * For Identity-H CIDFonts, the content-stream code is typically the glyph ID.
 * Symbol subsets often only cmap Mac Roman / Microsoft Symbol PUA codes
 * (e.g. byte 183 or U+F0B7 → GID of bullet) — never U+0078 "x".
 */
export function unicodeFromGlyphId(
  glyphId: number,
  cmapEntries: Map<number, number>,
  baseFont: string,
): string | null {
  let best: number | null = null;
  for (const [code, gid] of cmapEntries) {
    if (gid !== glyphId) continue;
    if (best == null) best = code;
    // Prefer Microsoft Symbol PUA (U+F020–U+F0FF)
    if (code >= 0xF020 && code <= 0xF0FF) {
      best = code;
      break;
    }
    // Prefer printable encoding bytes over C0 controls
    if (code >= 0x20 && code <= 0xFF && (best < 0x20 || best > 0xFF)) {
      best = code;
    }
  }
  if (best == null) return null;

  if (isSymbolFont(baseFont)) {
    const byte = best >= 0xF000 && best <= 0xF0FF ? best & 0xFF : best;
    if (byte >= 0 && byte <= 255) {
      return symbolCharToUnicode(byte) ?? String.fromCodePoint(best);
    }
  }

  try {
    return String.fromCodePoint(best);
  } catch {
    return null;
  }
}
