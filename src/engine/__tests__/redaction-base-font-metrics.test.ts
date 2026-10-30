import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { StandardFonts } from 'pdf-lib';
import { getStandardFontCharWidth } from '../fonts/standard14';

// Resolve pdf-lib's own standard-font metrics even when npm nests its dependency.
const pdfLibRequire = createRequire(require.resolve('pdf-lib'));
const { Font, Encodings } = pdfLibRequire('@pdf-lib/standard-fonts') as {
  Font: { load(name: string): { FontBBox: number[]; CharMetrics: Array<{ WX: number }>;
    getWidthOfGlyph(name: string): number | undefined } };
  Encodings: { WinAnsi: { encodeUnicodeCodePoint(code: number): { name: string } } };
};

const supportedFonts = [
  StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique,
  StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique,
  StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic,
];

describe('standard-font redaction envelope', () => {
  it.each(supportedFonts)('matches every WinAnsi ASCII glyph advance for %s', name => {
    const font = Font.load(name);
    for (let code = 0x20; code <= 0x7e; code++) {
      const glyph = Encodings.WinAnsi.encodeUnicodeCodePoint(code).name;
      const width = font.getWidthOfGlyph(glyph);
      expect(width, `Missing AFM glyph ${glyph} in ${name}`).toBeDefined();
      expect(getStandardFontCharWidth(name, code), `${name} ${glyph} (0x${code.toString(16)})`).toBe(width);
    }
  });

  it.each(supportedFonts)('contains %s standard metrics within the conservative 2em envelope', name => {
    const font = Font.load(name);
    // The redactor reserves 2em around the text origin and 2em of advance
    // for each character; glyph bounds and advances must both fit.
    expect(font.FontBBox).toHaveLength(4);
    for (const bound of font.FontBBox) {
      expect(Number.isFinite(bound)).toBe(true);
      expect(Math.abs(bound)).toBeLessThanOrEqual(2000);
    }
    expect(font.CharMetrics.length).toBeGreaterThan(0);
    for (const glyph of font.CharMetrics) {
      expect(Number.isFinite(glyph.WX)).toBe(true);
      expect(glyph.WX).toBeGreaterThanOrEqual(0);
      expect(glyph.WX).toBeLessThanOrEqual(2000);
    }
  });
});
