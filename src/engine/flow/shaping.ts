/**
 * OpenType text shaping — glyph IDs, advances, kerning, basic ligatures.
 *
 * Uses embedded TrueType tables (hmtx, kern) and PDF font widths.
 * HarfBuzz-class GSUB/GPOS for complex scripts is a future upgrade path.
 */

import type { FontData } from '../fonts/font-parser';
import {
  charCodeToGlyphId,
  getGlyphWidth,
  fontUnitsToTextSpace,
  type TTFFont,
} from '../fonts/truetype-parser';
import { parseGSUBLigatures, shapeGlyphIdsWithLigatures } from '../fonts/gsub';
import { parseGPOSPairAdjustments, lookupGPOSPair } from '../fonts/gpos';

export interface ShapedGlyph {
  unicode: string;
  glyphId: number;
  /** Advance in page units (pt). */
  advance: number;
  /** Kerning adjustment applied before this glyph (page units). */
  kern: number;
}

const LIGATURE_SEQUENCES = ['ffi', 'ffl', 'ff', 'fi', 'fl'] as const;

type KernMap = Map<number, Map<number, number>>;

const kernCache = new WeakMap<TTFFont, KernMap>();

/** Shape text into positioned glyphs with kerning. */
export function shapeText(
  text: string,
  fontData: FontData,
  fontSize: number,
): ShapedGlyph[] {
  if (!text) return [];

  if (fontData.ttfFont) {
    const rules = parseGSUBLigatures(fontData.ttfFont);
    if (rules.length > 0) {
      return shapeTextWithGSUB(text, fontData, fontSize, rules);
    }
  }

  const clusters = splitLigatureClusters(text);
  const glyphs: ShapedGlyph[] = [];
  let prevGlyphId = -1;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const glyphId = resolveGlyphId(cluster, fontData);
    const advance = glyphAdvance(glyphId, fontData, fontSize);
    let kern = 0;

    if (prevGlyphId >= 0 && fontData.ttfFont) {
      const kernFU = lookupKern(fontData.ttfFont, prevGlyphId, glyphId);
      if (kernFU !== 0) {
        kern = (kernFU / fontData.ttfFont.unitsPerEm) * fontSize;
      }
    }

    glyphs.push({ unicode: cluster, glyphId, advance, kern });
    prevGlyphId = glyphId;
  }

  applyGPOSKerning(glyphs, fontData, fontSize);
  return glyphs;
}

function applyGPOSKerning(
  glyphs: ShapedGlyph[],
  fontData: FontData,
  fontSize: number,
): void {
  if (!fontData.ttfFont || glyphs.length < 2) return;
  const pairs = parseGPOSPairAdjustments(fontData.ttfFont);
  if (pairs.length === 0) return;

  const scale = fontSize / fontData.ttfFont.unitsPerEm;
  for (let i = 0; i < glyphs.length - 1; i++) {
    const adj = lookupGPOSPair(pairs, glyphs[i].glyphId, glyphs[i + 1].glyphId);
    if (adj) {
      glyphs[i + 1].kern += adj.xAdvance * scale;
      if (adj.yAdvance !== 0) {
        glyphs[i + 1].advance += adj.yAdvance * scale * 0.01;
      }
    }
  }
}

function shapeTextWithGSUB(
  text: string,
  fontData: FontData,
  fontSize: number,
  rules: ReturnType<typeof parseGSUBLigatures>,
): ShapedGlyph[] {
  const ttf = fontData.ttfFont!;
  const glyphIds: number[] = [];
  const charUnits: string[] = [];

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const unit = String.fromCodePoint(cp);
    charUnits.push(unit);
    glyphIds.push(charCodeToGlyphId(ttf, cp));
    i += unit.length;
  }

  const shaped = shapeGlyphIdsWithLigatures(glyphIds, charUnits, rules);
  const glyphs: ShapedGlyph[] = [];
  let prevGlyphId = -1;

  for (let i = 0; i < shaped.length; i++) {
    const { glyphId, unicode } = shaped[i];
    const advance = glyphAdvance(glyphId, fontData, fontSize);
    let kern = 0;

    if (prevGlyphId >= 0) {
      const kernFU = lookupKern(ttf, prevGlyphId, glyphId);
      if (kernFU !== 0) {
        kern = (kernFU / ttf.unitsPerEm) * fontSize;
      }
    }

    glyphs.push({ unicode, glyphId, advance, kern });
    prevGlyphId = glyphId;
  }

  applyGPOSKerning(glyphs, fontData, fontSize);
  return glyphs;
}

/** Total shaped width in page units. */
export function measureText(
  text: string,
  fontData: FontData,
  fontSize: number,
): number {
  const glyphs = shapeText(text, fontData, fontSize);
  let width = 0;
  for (let i = 0; i < glyphs.length; i++) {
    width += glyphs[i].kern + glyphs[i].advance;
  }
  return width;
}

function splitLigatureClusters(text: string): string[] {
  const clusters: string[] = [];
  let i = 0;

  while (i < text.length) {
    let matched: string | null = null;
    for (let li = 0; li < LIGATURE_SEQUENCES.length; li++) {
      const seq = LIGATURE_SEQUENCES[li];
      if (text.startsWith(seq, i)) {
        matched = seq;
        break;
      }
    }

    if (matched) {
      clusters.push(matched);
      i += matched.length;
    } else {
      clusters.push(text[i]);
      i += 1;
    }
  }

  return clusters;
}

function resolveGlyphId(text: string, fontData: FontData): number {
  if (fontData.ttfFont) {
    const ligGid = ligatureGlyphId(text, fontData.ttfFont);
    if (ligGid >= 0) return ligGid;

    const code = text.codePointAt(0) ?? 0;
    const gid = charCodeToGlyphId(fontData.ttfFont, code);
    if (gid > 0) return gid;
  }

  const code = text.codePointAt(0) ?? 0;
  if (fontData.widths.has(code)) return code;
  return code;
}

function ligatureGlyphId(text: string, ttf: TTFFont): number {
  for (const [gid, name] of ttf.glyphNames) {
    if (name === text) return gid;
  }
  return -1;
}

function glyphAdvance(glyphId: number, fontData: FontData, fontSize: number): number {
  if (fontData.ttfFont) {
    const widthFU = getGlyphWidth(fontData.ttfFont, glyphId);
    const width1000 = fontUnitsToTextSpace(widthFU, fontData.ttfFont.unitsPerEm);
    return (width1000 / 1000) * fontSize;
  }

  const width1000 = fontData.widths.get(glyphId) ?? fontData.defaultWidth;
  if (width1000 > 0) {
    return (width1000 / 1000) * fontSize;
  }

  if (fontData.standardMetrics) {
    const w = fontData.standardMetrics.widths[glyphId];
    if (w) return (w / 1000) * fontSize;
  }

  return fontSize * 0.5;
}

function lookupKern(ttf: TTFFont, left: number, right: number): number {
  const table = parseKernTable(ttf);
  const rightMap = table.get(left);
  if (!rightMap) return 0;
  return rightMap.get(right) ?? 0;
}

function parseKernTable(ttf: TTFFont): KernMap {
  const cached = kernCache.get(ttf);
  if (cached) return cached;

  const result: KernMap = new Map();
  const table = ttf.tables.get('kern');
  if (!table) {
    kernCache.set(ttf, result);
    return result;
  }

  const data = ttf.rawData;
  let pos = table.offset;

  const readU8 = () => data[pos++];
  const readU16 = () => {
    const v = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    return v;
  };
  const readI16 = () => {
    const v = readU16();
    return v >= 0x8000 ? v - 0x10000 : v;
  };

  if (pos + 4 > data.length) {
    kernCache.set(ttf, result);
    return result;
  }

  readU16(); // version
  const nTables = readU16();

  for (let t = 0; t < nTables; t++) {
    if (pos + 6 > data.length) break;
    const subVersion = readU16();
    const subLength = readU16();
    const coverage = readU16();
    const subStart = pos;

    if ((coverage & 0x0001) !== 0) {
      // Horizontal kerning
      const format = coverage >> 8;
      if (format === 0 && pos + 8 <= data.length) {
        const pairCount = readU16();
        readU16(); // searchRange
        readU16(); // entrySelector
        readU16(); // rangeShift

        for (let p = 0; p < pairCount && pos + 6 <= data.length; p++) {
          const left = readU16();
          const right = readU16();
          const value = readI16();
          let rightMap = result.get(left);
          if (!rightMap) {
            rightMap = new Map();
            result.set(left, rightMap);
          }
          rightMap.set(right, value);
        }
      }
    }

    pos = subStart + subLength;
  }

  kernCache.set(ttf, result);
  return result;
}

/** Convert shaped glyphs to x positions along a baseline. */
export function layoutShapedGlyphs(
  glyphs: ShapedGlyph[],
  startX: number,
): Array<{ glyph: ShapedGlyph; x: number }> {
  const positions: Array<{ glyph: ShapedGlyph; x: number }> = [];
  let x = startX;

  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    x += g.kern;
    positions.push({ glyph: g, x });
    x += g.advance;
  }

  return positions;
}
