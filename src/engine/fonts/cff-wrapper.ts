/**
 * CFF (Compact Font Format) to OpenType (OTTO) Wrapper
 *
 * Wraps raw CFF streams (PDF Type1C / CIDFontType0C / FontFile3) into valid
 * OpenType (OTF / 'OTTO') font containers so that:
 * 1. The browser's FontFace API can load and render them natively.
 * 2. The TrueType / OpenType parser can extract metrics and glyph information.
 */

export interface CFFWrapOptions {
  familyName?: string | null;
  ascent?: number | null;
  descent?: number | null;
  weight?: number | null;
  italicAngle?: number | null;
  bbox?: [number, number, number, number] | null;
  widths?: Map<number, number> | null;
}

/**
 * Detect if raw bytes are standalone CFF (Compact Font Format) stream.
 * Standard CFF 1.0 starts with: major=1, minor=0, hdrSize>=4, offSize between 1 and 4.
 */
export function isCFFData(data: Uint8Array): boolean {
  if (!data || data.length < 4) return false;
  return data[0] === 1 && data[1] === 0 && data[2] >= 4 && data[3] >= 1 && data[3] <= 4;
}

/**
 * Extract basic metadata (numGlyphs, fontBBox, fontName) from a CFF table.
 */
export function parseCFFMetadata(data: Uint8Array): {
  numGlyphs: number;
  fontBBox?: [number, number, number, number];
  fontName?: string;
} {
  try {
    if (!isCFFData(data)) return { numGlyphs: 1 };

    const hdrSize = data[2];
    let pos = hdrSize;

    // 1. Name INDEX
    if (pos + 2 > data.length) return { numGlyphs: 1 };
    const nameCount = (data[pos] << 8) | data[pos + 1];
    pos += 2;

    let fontName: string | undefined;
    if (nameCount > 0) {
      const offSize = data[pos++];
      const offsetArrayStart = pos;
      const dataStart = offsetArrayStart + (nameCount + 1) * offSize;
      if (dataStart <= data.length) {
        const startOff = readCFFOffset(data, offsetArrayStart, offSize);
        const endOff = readCFFOffset(data, offsetArrayStart + offSize, offSize);
        const nameLen = endOff - startOff;
        const nameBytesPos = dataStart + startOff - 1;
        if (nameBytesPos + nameLen <= data.length) {
          let str = '';
          for (let i = 0; i < nameLen; i++) {
            str += String.fromCharCode(data[nameBytesPos + i]);
          }
          fontName = str;
        }
        const totalNameDataLen = readCFFOffset(data, offsetArrayStart + nameCount * offSize, offSize) - 1;
        pos = dataStart + totalNameDataLen;
      }
    }

    // 2. Top DICT INDEX
    if (pos + 2 > data.length) return { numGlyphs: 1, fontName };
    const topDictCount = (data[pos] << 8) | data[pos + 1];
    pos += 2;

    let charStringsOffset: number | null = null;
    let fontBBox: [number, number, number, number] | undefined;

    if (topDictCount > 0) {
      const offSize = data[pos++];
      const offsetArrayStart = pos;
      const dataStart = offsetArrayStart + (topDictCount + 1) * offSize;
      if (dataStart <= data.length) {
        const startOff = readCFFOffset(data, offsetArrayStart, offSize);
        const endOff = readCFFOffset(data, offsetArrayStart + offSize, offSize);
        const dictLen = endOff - startOff;
        const dictBytesPos = dataStart + startOff - 1;

        if (dictBytesPos + dictLen <= data.length) {
          const dictEnd = dictBytesPos + dictLen;
          let dPos = dictBytesPos;
          const stack: number[] = [];

          while (dPos < dictEnd) {
            const b0 = data[dPos++];
            if (b0 >= 32 && b0 <= 246) {
              stack.push(b0 - 139);
            } else if (b0 >= 247 && b0 <= 250) {
              const b1 = data[dPos++];
              stack.push((b0 - 247) * 256 + b1 + 108);
            } else if (b0 >= 251 && b0 <= 254) {
              const b1 = data[dPos++];
              stack.push(-(b0 - 251) * 256 - b1 - 108);
            } else if (b0 === 28) {
              const b1 = data[dPos++];
              const b2 = data[dPos++];
              let val = (b1 << 8) | b2;
              if (val >= 0x8000) val -= 0x10000;
              stack.push(val);
            } else if (b0 === 29) {
              const b1 = data[dPos++];
              const b2 = data[dPos++];
              const b3 = data[dPos++];
              const b4 = data[dPos++];
              let val = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
              if (val >= 0x80000000) val -= 0x100000000;
              stack.push(val);
            } else if (b0 === 30) {
              // Real number (BCD encoded)
              while (dPos < dictEnd) {
                const byte = data[dPos++];
                if ((byte & 0x0F) === 0x0F || ((byte >> 4) & 0x0F) === 0x0F) break;
              }
              stack.push(0); // Approximate real number placeholder
            } else if (b0 === 12) {
              // 2-byte operator
              const b1 = data[dPos++];
              // Operator 12, 36 = FDArray, 12, 37 = FDSelect, 12, 38 = FontMatrix
              stack.length = 0;
            } else {
              // 1-byte operator
              if (b0 === 17 && stack.length > 0) {
                // CharStrings offset
                charStringsOffset = stack[stack.length - 1];
              } else if (b0 === 5 && stack.length >= 4) {
                // FontBBox: [minX, minY, maxX, maxY]
                fontBBox = [
                  stack[stack.length - 4],
                  stack[stack.length - 3],
                  stack[stack.length - 2],
                  stack[stack.length - 1],
                ];
              }
              stack.length = 0;
            }
          }
        }
      }
    }

    // 3. Read numGlyphs from CharStrings INDEX
    let numGlyphs = 1;
    if (charStringsOffset != null && charStringsOffset + 2 <= data.length) {
      const csCount = (data[charStringsOffset] << 8) | data[charStringsOffset + 1];
      if (csCount > 0) numGlyphs = csCount;
    }

    return { numGlyphs, fontBBox, fontName };
  } catch {
    return { numGlyphs: 1 };
  }
}

function readCFFOffset(data: Uint8Array, offset: number, offSize: number): number {
  let v = 0;
  for (let i = 0; i < offSize; i++) {
    v = (v << 8) | data[offset + i];
  }
  return v;
}

/**
 * Wrap a raw CFF stream into an OpenType (.otf with 'OTTO' sfntVersion) font binary.
 */
export function wrapCFFInOTF(cffData: Uint8Array, options: CFFWrapOptions = {}): Uint8Array {
  const metadata = parseCFFMetadata(cffData);
  const numGlyphs = Math.max(1, metadata.numGlyphs);
  const bbox = options.bbox || metadata.fontBBox || [-100, -200, 1000, 800];
  const ascent = Math.round(options.ascent ?? (bbox[3] > 0 ? bbox[3] : 800));
  const descent = Math.round(options.descent ?? (bbox[1] < 0 ? bbox[1] : -200));
  const familyName = options.familyName || metadata.fontName || 'EmbeddedFont';
  const weight = options.weight ?? 400;
  const isBold = weight >= 600 || /bold|black|heavy/i.test(familyName);
  const isItalic = (options.italicAngle != null && Math.abs(options.italicAngle) > 1) || /italic|oblique/i.test(familyName);

  // Build required tables for OpenType CFF ('OTTO')
  const widthsMap = options.widths || undefined;
  const cffTable = cffData;
  const headTable = buildHeadTable(bbox, isBold, isItalic);
  const hheaTable = buildHheaTable(numGlyphs, ascent, descent, widthsMap);
  const maxpTable = buildMaxpTable(numGlyphs);
  const hmtxTable = buildHmtxTable(numGlyphs, widthsMap);
  const cmapTable = buildCmapTable(numGlyphs);
  const nameTable = buildNameTable(familyName, isBold, isItalic);
  const os2Table = buildOS2Table(familyName, weight, isBold, isItalic, ascent, descent);
  const postTable = buildPostTable(options.italicAngle ?? 0);

  // Tables MUST be sorted alphabetically by ASCII tag:
  // 'CFF ', 'OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post'
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'CFF ', data: cffTable },
    { tag: 'OS/2', data: os2Table },
    { tag: 'cmap', data: cmapTable },
    { tag: 'head', data: headTable },
    { tag: 'hhea', data: hheaTable },
    { tag: 'hmtx', data: hmtxTable },
    { tag: 'maxp', data: maxpTable },
    { tag: 'name', data: nameTable },
    { tag: 'post', data: postTable },
  ];

  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;

  // Calculate offsets with 4-byte padding
  let currentOffset = headerSize;
  const tableEntries: {
    tag: string;
    checksum: number;
    offset: number;
    length: number;
    paddedData: Uint8Array;
  }[] = [];

  for (const t of tables) {
    const length = t.data.length;
    const paddedLength = (length + 3) & ~3;
    const paddedData = new Uint8Array(paddedLength);
    paddedData.set(t.data);

    const checksum = calcChecksum(paddedData);
    tableEntries.push({
      tag: t.tag,
      checksum,
      offset: currentOffset,
      length,
      paddedData,
    });
    currentOffset += paddedLength;
  }

  const totalSize = currentOffset;
  const otf = new Uint8Array(totalSize);
  const view = new DataView(otf.buffer);

  // 1. sfnt header
  view.setUint32(0, 0x4F54544F, false); // 'OTTO'
  view.setUint16(4, numTables, false);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;
  view.setUint16(6, searchRange, false);
  view.setUint16(8, entrySelector, false);
  view.setUint16(10, rangeShift, false);

  // 2. Table directory
  let dirOffset = 12;
  let headTableOffset = 0;

  for (const entry of tableEntries) {
    for (let i = 0; i < 4; i++) {
      otf[dirOffset + i] = entry.tag.charCodeAt(i);
    }
    view.setUint32(dirOffset + 4, entry.checksum, false);
    view.setUint32(dirOffset + 8, entry.offset, false);
    view.setUint32(dirOffset + 12, entry.length, false);

    if (entry.tag === 'head') {
      headTableOffset = entry.offset;
    }

    // Write table data
    otf.set(entry.paddedData, entry.offset);
    dirOffset += 16;
  }

  // 3. Compute checksumAdjustment in head table
  if (headTableOffset > 0) {
    const fileChecksum = calcChecksum(otf);
    const checksumAdjustment = (0xB1B0AFBA - fileChecksum) >>> 0;
    view.setUint32(headTableOffset + 8, checksumAdjustment, false);
  }

  return otf;
}

// ─── Table Builders ─────────────────────────────────────────────────────────

function buildHeadTable(
  bbox: [number, number, number, number],
  isBold: boolean,
  isItalic: boolean,
): Uint8Array {
  const buf = new Uint8Array(54);
  const view = new DataView(buf.buffer);

  view.setUint16(0, 1, false); // majorVersion
  view.setUint16(2, 0, false); // minorVersion
  view.setUint32(4, 0x00010000, false); // fontRevision
  view.setUint32(8, 0, false); // checksumAdjustment (calculated later)
  view.setUint32(12, 0x5F0F3CF5, false); // magicNumber
  view.setUint16(16, 0x0003, false); // flags (baseline at y=0, sidebearing at x=0)
  view.setUint16(18, 1000, false); // unitsPerEm (standard for CFF)
  // created (8 bytes) = 0
  // modified (8 bytes) = 0
  view.setInt16(36, bbox[0], false); // xMin
  view.setInt16(38, bbox[1], false); // yMin
  view.setInt16(40, bbox[2], false); // xMax
  view.setInt16(42, bbox[3], false); // yMax

  let macStyle = 0;
  if (isBold) macStyle |= 1;
  if (isItalic) macStyle |= 2;
  view.setUint16(44, macStyle, false); // macStyle
  view.setUint16(46, 6, false); // lowestRecPPEM
  view.setInt16(48, 2, false); // fontDirectionHint
  view.setInt16(50, 0, false); // indexToLocFormat
  view.setInt16(52, 0, false); // glyphDataFormat

  return buf;
}

function buildHheaTable(
  numGlyphs: number,
  ascent: number,
  descent: number,
  widths?: Map<number, number>,
): Uint8Array {
  const buf = new Uint8Array(36);
  const view = new DataView(buf.buffer);

  let maxWidth = 1000;
  if (widths && widths.size > 0) {
    for (const w of widths.values()) {
      if (w > maxWidth) maxWidth = Math.round(w);
    }
  }

  view.setUint16(0, 1, false); // majorVersion
  view.setUint16(2, 0, false); // minorVersion
  view.setInt16(4, ascent, false); // ascender
  view.setInt16(6, descent, false); // descender
  view.setInt16(8, 0, false); // lineGap
  view.setUint16(10, Math.min(65535, maxWidth), false); // advanceWidthMax
  view.setInt16(12, 0, false); // minLeftSideBearing
  view.setInt16(14, 0, false); // minRightSideBearing
  view.setInt16(16, Math.min(32767, maxWidth), false); // xMaxExtent
  view.setInt16(18, 1, false); // caretSlopeRise
  view.setInt16(20, 0, false); // caretSlopeRun
  view.setInt16(22, 0, false); // caretOffset
  // reserved 8 bytes = 0
  view.setInt16(32, 0, false); // metricDataFormat
  view.setUint16(34, numGlyphs, false); // numberOfHMetrics

  return buf;
}

function buildMaxpTable(numGlyphs: number): Uint8Array {
  // For CFF ('OTTO') fonts, maxp table is version 0.5 (6 bytes)
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x00005000, false); // version 0.5
  view.setUint16(4, numGlyphs, false);
  return buf;
}

function buildHmtxTable(numGlyphs: number, widths?: Map<number, number>): Uint8Array {
  const buf = new Uint8Array(numGlyphs * 4);
  const view = new DataView(buf.buffer);

  for (let i = 0; i < numGlyphs; i++) {
    const w = widths?.get(i) ?? 1000;
    view.setUint16(i * 4, Math.round(Math.max(0, Math.min(65535, w))), false);
    view.setInt16(i * 4 + 2, 0, false); // lsb
  }

  return buf;
}

function buildCmapTable(numGlyphs: number): Uint8Array {
  // Build a standard Format 4 cmap table covering Unicode BMP
  const segCount = 2;
  const segCountX2 = segCount * 2;
  const entrySelector = 1;
  const searchRange = 4;
  const rangeShift = 0;

  const subtableLength = 16 + segCount * 8; // 32 bytes
  const cmapLength = 20 + subtableLength; // Header (4) + 2 records (16) + subtable (32) = 52 bytes

  const buf = new Uint8Array(cmapLength);
  const view = new DataView(buf.buffer);

  // cmap header
  view.setUint16(0, 0, false); // version
  view.setUint16(2, 2, false); // numTables (Unicode + Windows Unicode)

  // Record 0: Platform 0 (Unicode), Encoding 3 (Unicode BMP)
  view.setUint16(4, 0, false);
  view.setUint16(6, 3, false);
  view.setUint32(8, 20, false); // offset to subtable

  // Record 1: Platform 3 (Windows), Encoding 1 (Unicode BMP)
  view.setUint16(12, 3, false);
  view.setUint16(14, 1, false);
  view.setUint32(16, 20, false); // offset to subtable

  // Format 4 Subtable at offset 20
  const sub = 20;
  view.setUint16(sub, 4, false); // format
  view.setUint16(sub + 2, subtableLength, false); // length
  view.setUint16(sub + 4, 0, false); // language
  view.setUint16(sub + 6, segCountX2, false);
  view.setUint16(sub + 8, searchRange, false);
  view.setUint16(sub + 10, entrySelector, false);
  view.setUint16(sub + 12, rangeShift, false);

  // Segment 0: 0x0000..0xFFFE -> idDelta = 0
  // Segment 1: 0xFFFF..0xFFFF -> idDelta = 1 (maps 0xFFFF to glyph 0)
  view.setUint16(sub + 14, 0xFFFE, false); // endCode[0]
  view.setUint16(sub + 16, 0xFFFF, false); // endCode[1]
  view.setUint16(sub + 18, 0, false);      // reservedPad
  view.setUint16(sub + 20, 0x0000, false); // startCode[0]
  view.setUint16(sub + 22, 0xFFFF, false); // startCode[1]
  view.setInt16(sub + 24, 0, false);       // idDelta[0]
  view.setInt16(sub + 26, 1, false);       // idDelta[1]
  view.setUint16(sub + 28, 0, false);      // idRangeOffset[0]
  view.setUint16(sub + 30, 0, false);      // idRangeOffset[1]

  return buf;
}

function buildNameTable(familyName: string, isBold: boolean, isItalic: boolean): Uint8Array {
  const cleanFamily = familyName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'EmbeddedFont';
  let subfamily = 'Regular';
  if (isBold && isItalic) subfamily = 'Bold Italic';
  else if (isBold) subfamily = 'Bold';
  else if (isItalic) subfamily = 'Italic';

  const fullName = `${cleanFamily} ${subfamily}`;
  const psName = cleanFamily.replace(/\s+/g, '') + '-' + subfamily.replace(/\s+/g, '');

  const names = [
    { id: 1, text: cleanFamily }, // Family Name
    { id: 2, text: subfamily },   // Subfamily Name
    { id: 4, text: fullName },    // Full Name
    { id: 6, text: psName },      // PostScript Name
  ];

  // Encode strings in UTF-16BE
  const encodedStrings: { id: number; data: Uint8Array; offset: number }[] = [];
  let stringStorageLen = 0;

  for (const n of names) {
    const strBytes = new Uint8Array(n.text.length * 2);
    for (let i = 0; i < n.text.length; i++) {
      const code = n.text.charCodeAt(i);
      strBytes[i * 2] = code >> 8;
      strBytes[i * 2 + 1] = code & 0xFF;
    }
    encodedStrings.push({
      id: n.id,
      data: strBytes,
      offset: stringStorageLen,
    });
    stringStorageLen += strBytes.length;
  }

  const recordCount = names.length;
  const stringOffset = 6 + recordCount * 12;
  const tableLength = stringOffset + stringStorageLen;

  const buf = new Uint8Array(tableLength);
  const view = new DataView(buf.buffer);

  view.setUint16(0, 0, false); // format
  view.setUint16(2, recordCount, false); // count
  view.setUint16(4, stringOffset, false); // stringOffset

  let rPos = 6;
  for (const s of encodedStrings) {
    view.setUint16(rPos, 3, false); // platformID: Windows
    view.setUint16(rPos + 2, 1, false); // encodingID: Unicode BMP
    view.setUint16(rPos + 4, 0x0409, false); // languageID: English US
    view.setUint16(rPos + 6, s.id, false); // nameID
    view.setUint16(rPos + 8, s.data.length, false); // length
    view.setUint16(rPos + 10, s.offset, false); // offset
    rPos += 12;

    buf.set(s.data, stringOffset + s.offset);
  }

  return buf;
}

function buildOS2Table(
  familyName: string,
  weight: number,
  isBold: boolean,
  isItalic: boolean,
  ascent: number,
  descent: number,
): Uint8Array {
  const buf = new Uint8Array(96);
  const view = new DataView(buf.buffer);

  view.setUint16(0, 0x0003, false); // version 3
  view.setInt16(2, 500, false); // xAvgCharWidth
  view.setUint16(4, Math.max(100, Math.min(900, weight)), false); // usWeightClass
  view.setUint16(6, 5, false); // usWidthClass: Medium (normal)
  view.setUint16(8, 0, false); // fsType: Installable embedding
  view.setInt16(10, 650, false); // ySubscriptXSize
  view.setInt16(12, 600, false); // ySubscriptYSize
  view.setInt16(14, 0, false); // ySubscriptXOffset
  view.setInt16(16, 75, false); // ySubscriptYOffset
  view.setInt16(18, 650, false); // ySuperscriptXSize
  view.setInt16(20, 600, false); // ySuperscriptYSize
  view.setInt16(22, 0, false); // ySuperscriptXOffset
  view.setInt16(24, 350, false); // ySuperscriptYOffset
  view.setInt16(26, 50, false); // yStrikeoutSize
  view.setInt16(28, 300, false); // yStrikeoutPosition
  view.setInt16(30, 0, false); // sFamilyClass

  // panose (10 bytes) at offset 32 = 0
  // ulUnicodeRange1..4 at offset 42 (16 bytes)
  view.setUint32(42, 0xFFFFFFFF, false);
  view.setUint32(46, 0xFFFFFFFF, false);
  view.setUint32(50, 0xFFFFFFFF, false);
  view.setUint32(54, 0xFFFFFFFF, false);

  // achVendID at offset 58
  buf[58] = 0x4E; buf[59] = 0x4F; buf[60] = 0x4E; buf[61] = 0x45; // 'NONE'

  // fsSelection at offset 62
  let fsSelection = 0;
  if (isBold) fsSelection |= (1 << 5);
  if (isItalic) fsSelection |= (1 << 0);
  if (!isBold && !isItalic) fsSelection |= (1 << 6);
  view.setUint16(62, fsSelection, false);

  view.setUint16(64, 0x0020, false); // usFirstCharIndex
  view.setUint16(66, 0xFFFF, false); // usLastCharIndex
  view.setInt16(68, ascent, false); // sTypoAscender
  view.setInt16(70, descent, false); // sTypoDescender
  view.setInt16(72, 0, false); // sTypoLineGap
  view.setUint16(74, Math.abs(ascent) || 800, false); // usWinAscent
  view.setUint16(76, Math.abs(descent) || 200, false); // usWinDescent
  view.setUint32(78, 0x00000001, false); // ulCodePageRange1 (Latin 1)
  view.setUint32(82, 0x00000000, false); // ulCodePageRange2
  view.setInt16(86, 500, false); // sxHeight
  view.setInt16(88, 700, false); // sCapHeight
  view.setUint16(90, 0, false); // usDefaultChar
  view.setUint16(92, 32, false); // usBreakChar
  view.setUint16(94, 1, false); // usMaxContext

  return buf;
}

function buildPostTable(italicAngle: number): Uint8Array {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 0x00030000, false); // Version 3.0 (no glyph names table)
  view.setInt32(4, Math.round(italicAngle * 65536), false); // italicAngle in Fixed 16.16
  view.setInt16(8, -100, false); // underlinePosition
  view.setInt16(10, 50, false); // underlineThickness
  view.setUint32(12, 0, false); // isFixedPitch
  // minMemType42, maxMemType42, minMemType1, maxMemType1 = 0

  return buf;
}

function calcChecksum(data: Uint8Array): number {
  let sum = 0;
  const len = data.length & ~3;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let i = 0; i < len; i += 4) {
    sum = (sum + view.getUint32(i, false)) >>> 0;
  }

  // Handle trailing bytes if any
  const remaining = data.length - len;
  if (remaining > 0) {
    let last = 0;
    for (let i = 0; i < remaining; i++) {
      last |= data[len + i] << ((3 - i) * 8);
    }
    sum = (sum + (last >>> 0)) >>> 0;
  }

  return sum;
}
