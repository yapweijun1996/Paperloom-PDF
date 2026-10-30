import { describe, expect, it } from 'vitest';
import { getGlyphOutline, type TTFFont } from '../fonts/truetype-parser';

type Point = { x: number; y: number; on: boolean };

function syntheticGlyph(points: Point[]): TTFFont {
  const glyphLength = 14 + points.length * 5;
  const rawData = new Uint8Array(8 + glyphLength);
  const view = new DataView(rawData.buffer);
  view.setUint32(4, glyphLength);
  view.setInt16(8, 1);
  view.setUint16(18, points.length - 1);
  let offset = 22;
  for (const point of points) rawData[offset++] = point.on ? 1 : 0;
  let previous = 0;
  for (const point of points) { view.setInt16(offset, point.x - previous); offset += 2; previous = point.x; }
  previous = 0;
  for (const point of points) { view.setInt16(offset, point.y - previous); offset += 2; previous = point.y; }
  return {
    rawData, indexToLocFormat: 1, glyphCache: new Map(),
    tables: new Map([
      ['loca', { tag: 'loca', checksum: 0, offset: 0, length: 8 }],
      ['glyf', { tag: 'glyf', checksum: 0, offset: 8, length: glyphLength }],
    ]),
    advanceWidths: new Uint16Array(1), leftSideBearings: new Int16Array(1),
  } as TTFFont;
}

describe('TrueType quadratic contour traversal', () => {
  it('visits every off-curve point exactly once and returns to the implicit starting midpoint', () => {
    const font = syntheticGlyph([
      { x: 0, y: 0, on: false }, { x: 100, y: 0, on: false }, { x: 100, y: 100, on: false },
    ]);
    expect(getGlyphOutline(font, 0)?.commands).toEqual([
      { type: 'M', args: [50, 50] }, { type: 'Q', args: [0, 0, 50, 0] },
      { type: 'Q', args: [100, 0, 100, 50] }, { type: 'Q', args: [100, 100, 50, 50] },
      { type: 'Z', args: [] },
    ]);
  });

  it('consumes off-curve to on-curve pairs once, including the closing starting point', () => {
    const font = syntheticGlyph([
      { x: 0, y: 0, on: true }, { x: 50, y: 0, on: false },
      { x: 100, y: 100, on: true }, { x: 0, y: 100, on: false },
    ]);
    expect(getGlyphOutline(font, 0)?.commands).toEqual([
      { type: 'M', args: [0, 0] }, { type: 'Q', args: [50, 0, 100, 100] },
      { type: 'Q', args: [0, 100, 0, 0] }, { type: 'Z', args: [] },
    ]);
  });
});
