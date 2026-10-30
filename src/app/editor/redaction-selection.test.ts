import { describe, expect, it } from 'vitest';
import { PDFDict, PDFNumber, type PDFPageInfo } from '@/engine/types';
import { redactionRegionFromDrag } from './redaction-selection';

function page(rotation: number): PDFPageInfo {
  return { rotate: rotation, dict: new PDFDict(), cropBox: { x: 20, y: 30, width: 200, height: 100 },
    mediaBox: { x: 0, y: 0, width: 300, height: 200 } } as PDFPageInfo;
}

describe('redaction selection geometry', () => {
  it.each([
    [0, 400, 200, { x: 25, y: 80, width: 50, height: 40 }],
    [90, 200, 400, { x: 30, y: 35, width: 40, height: 50 }],
    [180, 400, 200, { x: 165, y: 40, width: 50, height: 40 }],
    [270, 200, 400, { x: 170, y: 75, width: 40, height: 50 }],
  ])('maps rotation %i and CropBox offsets', (rotation, width, height, expected) => {
    expect(redactionRegionFromDrag(page(rotation), 2, width, height, { x: 10, y: 20 }, { x: 110, y: 100 })).toEqual(expected);
    expect(redactionRegionFromDrag(page(rotation), 2, width, height, { x: 110, y: 100 }, { x: 10, y: 20 })).toEqual(expected);
  });

  it('rejects changed viewport geometry, unsupported rotations, user units and tiny or outside drags', () => {
    const start = { x: 10, y: 20 }, end = { x: 110, y: 100 };
    expect(() => redactionRegionFromDrag(page(0), 2, 399, 198, start, end)).toThrow(/display changed/);
    expect(() => redactionRegionFromDrag(page(45), 2, 400, 200, start, end)).toThrow(/geometry/);
    expect(() => redactionRegionFromDrag(page(-90), 2, 400, 200, start, end)).toThrow(/geometry/);
    expect(() => redactionRegionFromDrag(page(450), 2, 400, 200, start, end)).toThrow(/geometry/);
    const unit = page(0); unit.dict.set('UserUnit', new PDFNumber(2));
    expect(() => redactionRegionFromDrag(unit, 2, 400, 200, start, end)).toThrow(/geometry/);
    expect(() => redactionRegionFromDrag(page(0), 2, 400, 200, start, { x: 11, y: 21 })).toThrow(/larger region/);
    expect(() => redactionRegionFromDrag(page(0), 2, 400, 200, start, { x: 401, y: 100 })).toThrow(/within the page/);
  });

  it('rejects extra pixels introduced by canvas rounding instead of selecting outside the crop', () => {
    const fractional = page(0);
    fractional.cropBox.width = 200.3;
    expect(() => redactionRegionFromDrag(fractional, 0.5, 101, 50, { x: 10, y: 10 }, { x: 100.8, y: 40 })).toThrow(/within the page/);
    expect(redactionRegionFromDrag(fractional, 0.5, 101, 50, { x: 10, y: 10 }, { x: 100.1, y: 40 }).width).toBeCloseTo(180.2);
  });
});
