/**
 * Text Measurement Engine — Phase 2
 *
 * Accurate width/height metrics using embedded font tables and PDF widths.
 * Feeds layout, justification, and export subsystems.
 */

import type { FontData } from './font-parser';
import { shapeText, type ShapedGlyph } from '../flow/shaping';

export interface TextMetrics {
  width: number;
  height: number;
  ascent: number;
  descent: number;
  lineHeight: number;
  glyphCount: number;
}

export function measureTextLine(
  text: string,
  fontData: FontData,
  fontSize: number,
): TextMetrics {
  const glyphs = shapeText(text, fontData, fontSize);
  let width = 0;
  for (let i = 0; i < glyphs.length; i++) {
    width += glyphs[i].kern + glyphs[i].advance;
  }

  const ascent = (fontData.ascent || fontData.ttfFont?.ascent || 800)
    / (fontData.ttfFont?.unitsPerEm || 1000) * fontSize;
  const descent = Math.abs(fontData.descent || fontData.ttfFont?.descent || -200)
    / (fontData.ttfFont?.unitsPerEm || 1000) * fontSize;
  const lineGap = (fontData.ttfFont?.lineGap || 0)
    / (fontData.ttfFont?.unitsPerEm || 1000) * fontSize;

  return {
    width,
    height: ascent + descent + lineGap,
    ascent,
    descent,
    lineHeight: ascent + descent + lineGap,
    glyphCount: glyphs.length,
  };
}

export function measureTextRange(
  text: string,
  start: number,
  end: number,
  fontData: FontData,
  fontSize: number,
): number {
  return measureTextLine(text.substring(start, end), fontData, fontSize).width;
}

export function shapedGlyphsToPositions(
  glyphs: ShapedGlyph[],
  startX: number,
): Array<{ glyph: ShapedGlyph; x: number }> {
  const out: Array<{ glyph: ShapedGlyph; x: number }> = [];
  let x = startX;
  for (let i = 0; i < glyphs.length; i++) {
    x += glyphs[i].kern;
    out.push({ glyph: glyphs[i], x });
    x += glyphs[i].advance;
  }
  return out;
}
