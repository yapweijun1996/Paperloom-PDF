import { describe, expect, it } from 'vitest';
import {
  coalesceFontSizePatches,
  cssFontFamilyFromUI,
  expandFontSizePatchesThroughSpaces,
  remapStyleRange,
} from './textStyleUtils';

describe('remapStyleRange', () => {
  it('keeps a range that ends before an insert', () => {
    expect(remapStyleRange(0, 3, 5, 2)).toEqual({ start: 0, end: 3 });
  });

  it('shifts a range that starts at or after an insert', () => {
    expect(remapStyleRange(5, 8, 5, 2)).toEqual({ start: 7, end: 10 });
  });

  it('grows a range that contains the insert point', () => {
    expect(remapStyleRange(2, 8, 5, 2)).toEqual({ start: 2, end: 10 });
  });

  it('returns null when a delete removes the whole range', () => {
    expect(remapStyleRange(3, 5, 2, -4)).toBeNull();
  });

  it('collapses points inside a deleted span to the edit position', () => {
    expect(remapStyleRange(1, 8, 3, -2)).toEqual({ start: 1, end: 6 });
  });

  it('is a no-op for delta 0', () => {
    expect(remapStyleRange(1, 4, 2, 0)).toEqual({ start: 1, end: 4 });
  });
});

describe('coalesceFontSizePatches', () => {
  const fs = (start: number, end: number, fontSize: number) => ({ start, end, patch: { fontSize } });

  it('merges same-size patches separated only by a space', () => {
    const out = coalesceFontSizePatches([fs(0, 3, 16), fs(4, 7, 16)], 'abc def');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: 0, end: 7 });
  });

  it('does not merge different sizes', () => {
    expect(coalesceFontSizePatches([fs(0, 3, 16), fs(4, 7, 12)], 'abc def')).toHaveLength(2);
  });

  it('does not merge across letters', () => {
    expect(coalesceFontSizePatches([fs(0, 3, 16), fs(5, 7, 16)], 'abcxxef')).toHaveLength(2);
  });

  it('returns a single patch unchanged', () => {
    const one = [fs(0, 3, 16)];
    expect(coalesceFontSizePatches(one, 'abc')).toBe(one);
  });
});

describe('expandFontSizePatchesThroughSpaces', () => {
  it('absorbs one separator space on each side', () => {
    const out = expandFontSizePatchesThroughSpaces([{ start: 2, end: 4, patch: { fontSize: 16 } }], 'a bc d');
    expect(out[0]).toMatchObject({ start: 1, end: 5 });
  });

  it('leaves non-fontSize patches alone', () => {
    const item = { start: 2, end: 4, patch: { bold: true } };
    expect(expandFontSizePatchesThroughSpaces([item], 'a bc d')[0]).toBe(item);
  });
});

describe('cssFontFamilyFromUI', () => {
  it('falls back to Helvetica stack for empty names', () => {
    expect(cssFontFamilyFromUI('  ')).toBe('Helvetica, Arial, sans-serif');
  });

  it('maps Times-Roman to a serif stack', () => {
    expect(cssFontFamilyFromUI('Times-Roman')).toBe('"Times New Roman", Times, serif');
  });

  it('uses a monospace fallback for mono fonts', () => {
    expect(cssFontFamilyFromUI('Roboto Mono')).toBe('"Roboto Mono", "Courier New", monospace');
  });

  it('uses a sans fallback for unknown fonts', () => {
    expect(cssFontFamilyFromUI('Inter')).toBe('"Inter", Helvetica, Arial, sans-serif');
  });
});
