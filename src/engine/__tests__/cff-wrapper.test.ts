import { describe, it, expect } from 'vitest';
import { isCFFData, parseCFFMetadata, wrapCFFInOTF } from '../fonts/cff-wrapper';
import { isTrueTypeFontData, parseTTF } from '../fonts/truetype-parser';

describe('CFF wrapper', () => {
  // Construct a minimal valid CFF 1.0 byte stream
  // Header: major=1, minor=0, hdrSize=4, offSize=1
  // Name INDEX: 1 name "TestFont"
  // Top DICT INDEX: 1 dict with CharStrings offset, FontBBox
  // String INDEX: empty (count=0)
  // Global Subr INDEX: empty (count=0)
  // CharStrings INDEX: 2 glyphs (.notdef, A)
  function createSampleCFF(): Uint8Array {
    const fontName = 'EPAHMR+AlbanyWTJ';
    const nameBytes = Array.from(fontName).map(c => c.charCodeAt(0));

    // Top DICT key-value:
    // FontBBox: -100 -200 1000 800 5 (operator 5)
    // CharStrings: offset 50 17 (operator 17)
    // We'll compute offsets dynamically.

    const header = [1, 0, 4, 1];

    // Name INDEX:
    // count=1 (2 bytes: 0, 1), offSize=1, offsets=[1, 1 + nameBytes.length], data=nameBytes
    const nameIndex = [
      0, 1, // count = 1
      1,    // offSize = 1
      1, 1 + nameBytes.length, // offsets
      ...nameBytes,
    ];

    // Placeholder Top DICT bytes:
    // We will place CharStrings INDEX after Global Subrs
    // Top DICT contains:
    // -100 -200 1000 800 (FontBBox op 5)
    // CharStrings offset op 17
    // Let's build Top DICT data:
    // -100 is: 251..254 or 28 (2-byte): 28, (-100 >> 8) & 0xFF, -100 & 0xFF
    // -200 is: 28, (-200 >> 8) & 0xFF, -200 & 0xFF
    // 1000 is: 247..250 or 28: 28, (1000 >> 8) & 0xFF, 1000 & 0xFF
    // 800 is: 28, (800 >> 8) & 0xFF, 800 & 0xFF
    // op 5: 5
    const bboxData = [
      28, 0xFF, 0x9C, // -100
      28, 0xFF, 0x38, // -200
      28, 0x03, 0xE8, // 1000
      28, 0x03, 0x20, // 800
      5,              // FontBBox op
    ];

    // String INDEX: count=0 (2 bytes: 0, 0)
    const stringIndex = [0, 0];
    // Global Subr INDEX: count=0 (2 bytes: 0, 0)
    const gsubrIndex = [0, 0];

    // CharStrings INDEX: 2 glyphs (.notdef, A)
    // count=2 (2 bytes: 0, 2), offSize=1, offsets=[1, 2, 3], data=[14, 14] (14 = endchar)
    const charStringsIndex = [
      0, 2, // count = 2
      1,    // offSize = 1
      1, 2, 3, // offsets
      14, 14,  // 2 endchar glyphs
    ];

    // Calculate CharStrings offset from start of CFF:
    // header (4) + nameIndex.length + topDictIndex.length + stringIndex (2) + gsubrIndex (2)
    // Top DICT has CharStrings op (29, 4-byte offset, 17)
    // Top DICT size = bboxData.length + 6 (for 29, b1, b2, b3, b4, 17)
    const topDictDataLen = bboxData.length + 6;
    const topDictIndexLen = 2 + 1 + 2 + topDictDataLen; // count(2) + offSize(1) + offsets(2) + data

    const charStringsOffset = 4 + nameIndex.length + topDictIndexLen + stringIndex.length + gsubrIndex.length;

    const csOffsetData = [
      29,
      (charStringsOffset >> 24) & 0xFF,
      (charStringsOffset >> 16) & 0xFF,
      (charStringsOffset >> 8) & 0xFF,
      charStringsOffset & 0xFF,
      17, // CharStrings op
    ];

    const topDictData = [...bboxData, ...csOffsetData];
    const topDictIndex = [
      0, 1, // count = 1
      1,    // offSize = 1
      1, 1 + topDictData.length,
      ...topDictData,
    ];

    const cff = new Uint8Array([
      ...header,
      ...nameIndex,
      ...topDictIndex,
      ...stringIndex,
      ...gsubrIndex,
      ...charStringsIndex,
    ]);

    return cff;
  }

  it('detects CFF data correctly', () => {
    const cff = createSampleCFF();
    expect(isCFFData(cff)).toBe(true);

    expect(isCFFData(new Uint8Array([0, 1, 0, 0]))).toBe(false); // TrueType
    expect(isCFFData(new Uint8Array([0x4F, 0x54, 0x54, 0x4F]))).toBe(false); // OTTO
    expect(isCFFData(new Uint8Array([]))).toBe(false);
  });

  it('extracts metadata from CFF data', () => {
    const cff = createSampleCFF();
    const meta = parseCFFMetadata(cff);
    expect(meta.fontName).toBe('EPAHMR+AlbanyWTJ');
    expect(meta.numGlyphs).toBe(2);
    expect(meta.fontBBox).toEqual([-100, -200, 1000, 800]);
  });

  it('wraps CFF data into a valid OpenType (OTTO) font', () => {
    const cff = createSampleCFF();
    const otf = wrapCFFInOTF(cff, {
      familyName: 'Albany WT J',
      ascent: 800,
      descent: -200,
      weight: 400,
    });

    // Verify it is recognized as TrueType/OpenType sfnt
    expect(isTrueTypeFontData(otf)).toBe(true);

    // Verify sfnt magic is 'OTTO'
    const sig = (otf[0] << 24) | (otf[1] << 16) | (otf[2] << 8) | otf[3];
    expect(sig).toBe(0x4F54544F); // 'OTTO'

    // Verify parseTTF can parse the wrapped font
    const parsed = parseTTF(otf);
    expect(parsed.tables.has('CFF ')).toBe(true);
    expect(parsed.tables.has('head')).toBe(true);
    expect(parsed.tables.has('hhea')).toBe(true);
    expect(parsed.tables.has('maxp')).toBe(true);
    expect(parsed.tables.has('cmap')).toBe(true);
    expect(parsed.tables.has('name')).toBe(true);
    expect(parsed.tables.has('OS/2')).toBe(true);
    expect(parsed.tables.has('post')).toBe(true);

    expect(parsed.numGlyphs).toBe(2);
    expect(parsed.unitsPerEm).toBe(1000);
    expect(parsed.familyName).toBe('Albany WT J');
  });
});
