/**
 * Standard 14 PDF Fonts — Built-in Metrics
 *
 * Every PDF viewer must support these 14 fonts without embedding.
 * This file contains glyph width tables (in 1/1000 units of font size)
 * for all 14 standard fonts.
 *
 * The widths are used for text layout when a PDF references these fonts
 * without embedding width information.
 */

export interface StandardFontMetrics {
  /** Font family name */
  name: string;
  /** Widths for character codes 0-255 (Latin-1) in 1/1000 units */
  widths: number[];
  /** Default width for missing characters */
  defaultWidth: number;
  /** Ascent above baseline in 1/1000 units */
  ascent: number;
  /** Descent below baseline in 1/1000 units (negative) */
  descent: number;
  /** Is this font monospaced? */
  isMonospace: boolean;
  /** Is this font serif? */
  isSerif: boolean;
  /** CSS font-family string for rendering */
  cssFamily: string;
  /** Is bold */
  isBold: boolean;
  /** Is italic */
  isItalic: boolean;
}

// ─── Helvetica widths (standard sans-serif, equivalent to Arial) ────────

const HELVETICA_WIDTHS: number[] = new Array(256).fill(278);
// Space and basic ASCII
const HW: Record<number, number> = {
  32:278, 33:278, 34:355, 35:556, 36:556, 37:889, 38:667, 39:191,
  40:333, 41:333, 42:389, 43:584, 44:278, 45:333, 46:278, 47:278,
  48:556, 49:556, 50:556, 51:556, 52:556, 53:556, 54:556, 55:556,
  56:556, 57:556, 58:278, 59:278, 60:584, 61:584, 62:584, 63:556,
  64:1015, 65:667, 66:667, 67:722, 68:722, 69:667, 70:611, 71:778,
  72:722, 73:278, 74:500, 75:667, 76:556, 77:833, 78:722, 79:778,
  80:667, 81:778, 82:722, 83:667, 84:611, 85:722, 86:667, 87:944,
  88:667, 89:667, 90:611, 91:278, 92:278, 93:278, 94:469, 95:556,
  96:333, 97:556, 98:556, 99:500, 100:556, 101:556, 102:278, 103:556,
  104:556, 105:222, 106:222, 107:500, 108:222, 109:833, 110:556, 111:556,
  112:556, 113:556, 114:333, 115:500, 116:278, 117:556, 118:500, 119:722,
  120:500, 121:500, 122:500, 123:334, 124:260, 125:334, 126:584,
};
Object.entries(HW).forEach(([k, v]) => { HELVETICA_WIDTHS[Number(k)] = v; });

// ─── Helvetica-Bold widths ──────────────────────────────────────────────

const HELVETICA_BOLD_WIDTHS: number[] = new Array(256).fill(278);
const HBW: Record<number, number> = {
  32:278, 33:333, 34:474, 35:556, 36:556, 37:889, 38:722, 39:238,
  40:333, 41:333, 42:389, 43:584, 44:278, 45:333, 46:278, 47:278,
  48:556, 49:556, 50:556, 51:556, 52:556, 53:556, 54:556, 55:556,
  56:556, 57:556, 58:333, 59:333, 60:584, 61:584, 62:584, 63:611,
  64:975, 65:722, 66:722, 67:722, 68:722, 69:667, 70:611, 71:778,
  72:722, 73:278, 74:556, 75:722, 76:611, 77:833, 78:722, 79:778,
  80:667, 81:778, 82:722, 83:667, 84:611, 85:722, 86:667, 87:944,
  88:667, 89:667, 90:611, 91:333, 92:278, 93:333, 94:584, 95:556,
  96:333, 97:556, 98:611, 99:556, 100:611, 101:556, 102:333, 103:611,
  104:611, 105:278, 106:278, 107:556, 108:278, 109:889, 110:611, 111:611,
  112:611, 113:611, 114:389, 115:556, 116:333, 117:611, 118:556, 119:778,
  120:556, 121:556, 122:500, 123:389, 124:280, 125:389, 126:584,
};
Object.entries(HBW).forEach(([k, v]) => { HELVETICA_BOLD_WIDTHS[Number(k)] = v; });

// ─── Times-Roman widths (standard serif) ────────────────────────────────

const TIMES_ROMAN_WIDTHS: number[] = new Array(256).fill(250);
const TRW: Record<number, number> = {
  32:250, 33:333, 34:408, 35:500, 36:500, 37:833, 38:778, 39:180,
  40:333, 41:333, 42:500, 43:564, 44:250, 45:333, 46:250, 47:278,
  48:500, 49:500, 50:500, 51:500, 52:500, 53:500, 54:500, 55:500,
  56:500, 57:500, 58:278, 59:278, 60:564, 61:564, 62:564, 63:444,
  64:921, 65:722, 66:667, 67:667, 68:722, 69:611, 70:556, 71:722,
  72:722, 73:333, 74:389, 75:722, 76:611, 77:889, 78:722, 79:722,
  80:556, 81:722, 82:667, 83:556, 84:611, 85:722, 86:722, 87:944,
  88:722, 89:722, 90:611, 91:333, 92:278, 93:333, 94:469, 95:500,
  96:333, 97:444, 98:500, 99:444, 100:500, 101:444, 102:333, 103:500,
  104:500, 105:278, 106:278, 107:500, 108:278, 109:778, 110:500, 111:500,
  112:500, 113:500, 114:333, 115:389, 116:278, 117:500, 118:500, 119:722,
  120:500, 121:500, 122:444, 123:480, 124:200, 125:480, 126:541,
};
Object.entries(TRW).forEach(([k, v]) => { TIMES_ROMAN_WIDTHS[Number(k)] = v; });

// ─── Times-Bold widths (Adobe AFM — NOT the same as Times-Roman) ────────
// Using Roman widths for Bold under-advances glyphs and leaves rivers before
// the next independently-positioned run (e.g. bold word → ", " TJ).

const TIMES_BOLD_WIDTHS: number[] = new Array(256).fill(250);
const TBW: Record<number, number> = {
  32:250, 33:333, 34:555, 35:500, 36:500, 37:1000, 38:833, 39:278,
  40:333, 41:333, 42:500, 43:570, 44:250, 45:333, 46:250, 47:278,
  48:500, 49:500, 50:500, 51:500, 52:500, 53:500, 54:500, 55:500,
  56:500, 57:500, 58:333, 59:333, 60:570, 61:570, 62:570, 63:500,
  64:930, 65:722, 66:667, 67:722, 68:722, 69:667, 70:611, 71:778,
  72:778, 73:389, 74:500, 75:778, 76:667, 77:944, 78:722, 79:778,
  80:611, 81:778, 82:722, 83:556, 84:667, 85:722, 86:722, 87:1000,
  88:722, 89:722, 90:667, 91:333, 92:278, 93:333, 94:581, 95:500,
  96:333, 97:500, 98:556, 99:444, 100:556, 101:444, 102:333, 103:500,
  104:556, 105:278, 106:333, 107:556, 108:278, 109:833, 110:556, 111:500,
  112:556, 113:556, 114:444, 115:389, 116:333, 117:556, 118:500, 119:722,
  120:500, 121:500, 122:444, 123:394, 124:220, 125:394, 126:520,
  // WinAnsi 0x80–0x9F (glyph names from Core 14 AFM)
  128:500, 130:333, 131:556, 132:500, 133:1000, 134:500, 135:1000, 136:333,
  137:1000, 138:667, 139:333, 140:1000, 142:667, 145:333, 146:333, 147:500,
  148:500, 149:350, 150:500, 151:1000, 152:333, 153:1000, 154:556, 155:333,
  156:722, 158:667, 159:722,
};
Object.entries(TBW).forEach(([k, v]) => { TIMES_BOLD_WIDTHS[Number(k)] = v; });

// ─── Times-Italic widths (Adobe AFM) ────────────────────────────────────

const TIMES_ITALIC_WIDTHS: number[] = new Array(256).fill(250);
const TIW: Record<number, number> = {
  32:250, 33:333, 34:420, 35:500, 36:500, 37:833, 38:778, 39:214,
  40:333, 41:333, 42:500, 43:675, 44:250, 45:333, 46:250, 47:278,
  48:500, 49:500, 50:500, 51:500, 52:500, 53:500, 54:500, 55:500,
  56:500, 57:500, 58:333, 59:333, 60:675, 61:675, 62:675, 63:500,
  64:920, 65:611, 66:611, 67:667, 68:722, 69:611, 70:611, 71:722,
  72:722, 73:333, 74:444, 75:667, 76:556, 77:833, 78:667, 79:722,
  80:611, 81:722, 82:611, 83:500, 84:556, 85:722, 86:611, 87:833,
  88:611, 89:556, 90:556, 91:389, 92:278, 93:389, 94:422, 95:500,
  96:333, 97:500, 98:500, 99:444, 100:500, 101:444, 102:278, 103:500,
  104:500, 105:278, 106:278, 107:444, 108:278, 109:722, 110:500, 111:500,
  112:500, 113:500, 114:389, 115:389, 116:278, 117:500, 118:444, 119:667,
  120:444, 121:444, 122:389, 123:400, 124:275, 125:400, 126:541,
  128:500, 130:333, 131:500, 132:556, 133:889, 134:500, 135:500, 136:333,
  137:1000, 138:500, 139:333, 140:944, 142:556, 145:333, 146:333, 147:556,
  148:556, 149:350, 150:500, 151:889, 152:333, 153:980, 154:389, 155:333,
  156:667, 158:389, 159:556,
};
Object.entries(TIW).forEach(([k, v]) => { TIMES_ITALIC_WIDTHS[Number(k)] = v; });

// ─── Times-BoldItalic widths (Adobe AFM) ────────────────────────────────

const TIMES_BOLDITALIC_WIDTHS: number[] = new Array(256).fill(250);
const TBIW: Record<number, number> = {
  32:250, 33:389, 34:555, 35:500, 36:500, 37:833, 38:778, 39:278,
  40:333, 41:333, 42:500, 43:570, 44:250, 45:333, 46:250, 47:278,
  48:500, 49:500, 50:500, 51:500, 52:500, 53:500, 54:500, 55:500,
  56:500, 57:500, 58:333, 59:333, 60:570, 61:570, 62:570, 63:500,
  64:832, 65:667, 66:667, 67:667, 68:722, 69:667, 70:667, 71:722,
  72:778, 73:389, 74:500, 75:667, 76:611, 77:889, 78:722, 79:722,
  80:611, 81:722, 82:667, 83:556, 84:611, 85:722, 86:667, 87:889,
  88:667, 89:611, 90:611, 91:333, 92:278, 93:333, 94:570, 95:500,
  96:333, 97:500, 98:500, 99:444, 100:500, 101:444, 102:333, 103:500,
  104:556, 105:278, 106:278, 107:500, 108:278, 109:778, 110:556, 111:500,
  112:556, 113:500, 114:389, 115:389, 116:278, 117:556, 118:444, 119:667,
  120:500, 121:444, 122:389, 123:348, 124:220, 125:348, 126:570,
  128:500, 130:333, 131:500, 132:500, 133:1000, 134:500, 135:500, 136:333,
  137:1000, 138:556, 139:333, 140:944, 142:611, 145:333, 146:333, 147:500,
  148:500, 149:350, 150:500, 151:1000, 152:333, 153:1000, 154:389, 155:333,
  156:722, 158:389, 159:611,
};
Object.entries(TBIW).forEach(([k, v]) => { TIMES_BOLDITALIC_WIDTHS[Number(k)] = v; });

// ─── Courier widths (monospace — all glyphs are 600) ────────────────────

const COURIER_WIDTHS: number[] = new Array(256).fill(600);

// ─── Standard 14 fonts registry ─────────────────────────────────────────

const STANDARD_FONTS: Record<string, StandardFontMetrics> = {
  'Helvetica': {
    name: 'Helvetica', widths: HELVETICA_WIDTHS, defaultWidth: 278,
    ascent: 718, descent: -207, isMonospace: false, isSerif: false,
    cssFamily: 'Helvetica, Arial, sans-serif', isBold: false, isItalic: false,
  },
  'Helvetica-Bold': {
    name: 'Helvetica-Bold', widths: HELVETICA_BOLD_WIDTHS, defaultWidth: 278,
    ascent: 718, descent: -207, isMonospace: false, isSerif: false,
    cssFamily: 'Helvetica, Arial, sans-serif', isBold: true, isItalic: false,
  },
  'Helvetica-Oblique': {
    name: 'Helvetica-Oblique', widths: HELVETICA_WIDTHS, defaultWidth: 278,
    ascent: 718, descent: -207, isMonospace: false, isSerif: false,
    cssFamily: 'Helvetica, Arial, sans-serif', isBold: false, isItalic: true,
  },
  'Helvetica-BoldOblique': {
    name: 'Helvetica-BoldOblique', widths: HELVETICA_BOLD_WIDTHS, defaultWidth: 278,
    ascent: 718, descent: -207, isMonospace: false, isSerif: false,
    cssFamily: 'Helvetica, Arial, sans-serif', isBold: true, isItalic: true,
  },
  'Times-Roman': {
    name: 'Times-Roman', widths: TIMES_ROMAN_WIDTHS, defaultWidth: 250,
    ascent: 683, descent: -217, isMonospace: false, isSerif: true,
    cssFamily: '"Times New Roman", Times, serif', isBold: false, isItalic: false,
  },
  'Times-Bold': {
    name: 'Times-Bold', widths: TIMES_BOLD_WIDTHS, defaultWidth: 250,
    ascent: 683, descent: -217, isMonospace: false, isSerif: true,
    cssFamily: '"Times New Roman", Times, serif', isBold: true, isItalic: false,
  },
  'Times-Italic': {
    name: 'Times-Italic', widths: TIMES_ITALIC_WIDTHS, defaultWidth: 250,
    ascent: 683, descent: -217, isMonospace: false, isSerif: true,
    cssFamily: '"Times New Roman", Times, serif', isBold: false, isItalic: true,
  },
  'Times-BoldItalic': {
    name: 'Times-BoldItalic', widths: TIMES_BOLDITALIC_WIDTHS, defaultWidth: 250,
    ascent: 683, descent: -217, isMonospace: false, isSerif: true,
    cssFamily: '"Times New Roman", Times, serif', isBold: true, isItalic: true,
  },
  'Courier': {
    name: 'Courier', widths: COURIER_WIDTHS, defaultWidth: 600,
    ascent: 629, descent: -157, isMonospace: true, isSerif: true,
    cssFamily: '"Courier New", Courier, monospace', isBold: false, isItalic: false,
  },
  'Courier-Bold': {
    name: 'Courier-Bold', widths: COURIER_WIDTHS, defaultWidth: 600,
    ascent: 629, descent: -157, isMonospace: true, isSerif: true,
    cssFamily: '"Courier New", Courier, monospace', isBold: true, isItalic: false,
  },
  'Courier-Oblique': {
    name: 'Courier-Oblique', widths: COURIER_WIDTHS, defaultWidth: 600,
    ascent: 629, descent: -157, isMonospace: true, isSerif: true,
    cssFamily: '"Courier New", Courier, monospace', isBold: false, isItalic: true,
  },
  'Courier-BoldOblique': {
    name: 'Courier-BoldOblique', widths: COURIER_WIDTHS, defaultWidth: 600,
    ascent: 629, descent: -157, isMonospace: true, isSerif: true,
    cssFamily: '"Courier New", Courier, monospace', isBold: true, isItalic: true,
  },
  'ZapfDingbats': {
    name: 'ZapfDingbats', widths: HELVETICA_WIDTHS, defaultWidth: 278,
    ascent: 820, descent: -143, isMonospace: false, isSerif: false,
    cssFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif', isBold: false, isItalic: false,
  },
  'Symbol': {
    name: 'Symbol', widths: HELVETICA_WIDTHS, defaultWidth: 250,
    ascent: 1010, descent: -293, isMonospace: false, isSerif: false,
    cssFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif', isBold: false, isItalic: false,
  },
};

// ─── Lookup functions ───────────────────────────────────────────────────────

/**
 * Get metrics for a standard PDF font by name.
 * Handles common aliases and subset prefixes (e.g., "BCDEAF+Helvetica").
 */
export function getStandardFont(fontName: string): StandardFontMetrics | null {
  // Direct lookup
  if (STANDARD_FONTS[fontName]) return STANDARD_FONTS[fontName];

  // Strip subset prefix (6 uppercase letters + '+')
  const stripped = fontName.replace(/^[A-Z]{6}\+/, '');
  if (STANDARD_FONTS[stripped]) return STANDARD_FONTS[stripped];

  // Try common aliases
  const aliases: Record<string, string> = {
    'ArialMT': 'Helvetica',
    'Arial': 'Helvetica',
    'Arial-BoldMT': 'Helvetica-Bold',
    'Arial-ItalicMT': 'Helvetica-Oblique',
    'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
    'TimesNewRomanPSMT': 'Times-Roman',
    'TimesNewRomanPS-BoldMT': 'Times-Bold',
    'TimesNewRomanPS-ItalicMT': 'Times-Italic',
    'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
    'CourierNewPSMT': 'Courier',
    'CourierNewPS-BoldMT': 'Courier-Bold',
    'CourierNewPS-ItalicMT': 'Courier-Oblique',
    'CourierNewPS-BoldItalicMT': 'Courier-BoldOblique',
  };

  const aliased = aliases[stripped];
  if (aliased && STANDARD_FONTS[aliased]) return STANDARD_FONTS[aliased];

  // Fuzzy match based on font name patterns
  const lower = stripped.toLowerCase();
  if (lower.includes('courier') || lower.includes('mono')) {
    if (lower.includes('bold') && lower.includes('italic')) return STANDARD_FONTS['Courier-BoldOblique'];
    if (lower.includes('bold')) return STANDARD_FONTS['Courier-Bold'];
    if (lower.includes('italic') || lower.includes('oblique')) return STANDARD_FONTS['Courier-Oblique'];
    return STANDARD_FONTS['Courier'];
  }
  if (lower.includes('times') || lower.includes('roman')) {
    if (lower.includes('bold') && lower.includes('italic')) return STANDARD_FONTS['Times-BoldItalic'];
    if (lower.includes('bold')) return STANDARD_FONTS['Times-Bold'];
    if (lower.includes('italic')) return STANDARD_FONTS['Times-Italic'];
    return STANDARD_FONTS['Times-Roman'];
  }
  if (lower.includes('helv') || lower.includes('arial') || lower.includes('sans')) {
    if (lower.includes('bold') && (lower.includes('italic') || lower.includes('oblique'))) return STANDARD_FONTS['Helvetica-BoldOblique'];
    if (lower.includes('bold')) return STANDARD_FONTS['Helvetica-Bold'];
    if (lower.includes('italic') || lower.includes('oblique')) return STANDARD_FONTS['Helvetica-Oblique'];
    return STANDARD_FONTS['Helvetica'];
  }
  if (lower.includes('symbol')) return STANDARD_FONTS['Symbol'];
  if (lower.includes('zapf') || lower.includes('dingbat')) return STANDARD_FONTS['ZapfDingbats'];

  return null;
}

/**
 * Get the CSS font-family string that best matches a PDF font name.
 * Used by the renderer for canvas fillText.
 */
export function getCSSFontFamily(fontName: string): string {
  const std = getStandardFont(fontName);
  if (std) return std.cssFamily;

  // For unknown fonts, try to map to a reasonable CSS family
  const stripped = fontName.replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Italic|Regular|Light|Medium|Oblique)/gi, '');
  return `"${stripped}", sans-serif`;
}

/**
 * Get the width of a character in a standard font.
 * Returns width in 1/1000 units of font size.
 */
export function getStandardFontCharWidth(fontName: string, charCode: number): number {
  const std = getStandardFont(fontName);
  if (!std) return 600;
  if (charCode < 0 || charCode >= std.widths.length) return std.defaultWidth;
  return std.widths[charCode] || std.defaultWidth;
}
