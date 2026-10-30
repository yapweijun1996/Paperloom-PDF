import { describe, expect, it } from 'vitest';
import { searchHighlightBounds } from './search-highlight';

describe('search highlight viewport mapping', () => {
  const page = { mediaBox: { x: 0, y: 0, width: 200, height: 300 },
    cropBox: { x: 0, y: 0, width: 200, height: 300 }, rotate: 0 };
  const rect = { x: 20, y: 40, width: 30, height: 10 };

  it.each([
    [0, { left: 20, top: 250, width: 30, height: 10 }],
    [90, { left: 40, top: 20, width: 10, height: 30 }],
    [180, { left: 150, top: 40, width: 30, height: 10 }],
    [270, { left: 250, top: 150, width: 10, height: 30 }],
  ])('maps all four corners at page rotation %s', (rotate, expected) => {
    expect(searchHighlightBounds(rect, { ...page, rotate }, 1, true)).toEqual({ ...expected, clipped: true });
  });

  it('clips the highlight to the intersection of CropBox and MediaBox', () => {
    const cropped = { mediaBox: { x: 10, y: 20, width: 300, height: 200 },
      cropBox: { x: 0, y: 40, width: 200, height: 100 }, rotate: 0 };
    const partlyOutside = { x: 5, y: 50, width: 20, height: 20 };
    expect(searchHighlightBounds(partlyOutside, cropped, 1, false))
      .toEqual({ left: 0, top: 70, width: 15, height: 20, clipped: true });
    expect(searchHighlightBounds(partlyOutside, { ...cropped, rotate: 90 }, 2, false))
      .toEqual({ left: 20, top: 0, width: 40, height: 30, clipped: true });
    expect(searchHighlightBounds({ x: 0, y: 0, width: 5, height: 5 }, cropped, 1, false)).toBeNull();
  });

  it('does not invent bounds for empty or invalid rectangles', () => {
    expect(searchHighlightBounds({ ...rect, width: 0 }, page, 1, false)).toBeNull();
    expect(searchHighlightBounds({ ...rect, x: Infinity }, page, 1, false)).toBeNull();
    expect(searchHighlightBounds(rect, page, 0, false)).toBeNull();
  });

  it('disables expanding decorations close to a viewport edge', () => {
    expect(searchHighlightBounds({ x: 1, y: 100, width: 10, height: 10 }, page, 1, false)?.clipped).toBe(true);
    expect(searchHighlightBounds({ x: 80, y: 140, width: 20, height: 10 }, page, 1, false)?.clipped).toBe(false);
  });
});
