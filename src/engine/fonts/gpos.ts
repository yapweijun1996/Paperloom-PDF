/**
 * OpenType GPOS table parser — pair kerning and mark positioning.
 * ISO 14496-22 / OpenType spec.
 */

import type { TTFFont } from './truetype-parser';

export interface GPOSPairAdjustment {
  left: number;
  right: number;
  xAdvance: number;
  yAdvance: number;
  xPlacement: number;
  yPlacement: number;
}

export interface GPOSMarkRecord {
  markGlyphId: number;
  xOffset: number;
  yOffset: number;
}

const gposCache = new WeakMap<TTFFont, GPOSPairAdjustment[]>();
const markCache = new WeakMap<TTFFont, GPOSMarkRecord[]>();

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readI16(data: Uint8Array, offset: number): number {
  const v = readU16(data, offset);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readU32(data: Uint8Array, offset: number): number {
  return (readU16(data, offset) << 16) | readU16(data, offset + 2);
}

/** Parse GPOS pair adjustments (kern feature, lookup types 2 and 8). */
export function parseGPOSPairAdjustments(ttf: TTFFont): GPOSPairAdjustment[] {
  const cached = gposCache.get(ttf);
  if (cached) return cached;

  const pairs: GPOSPairAdjustment[] = [];
  const table = ttf.tables.get('GPOS');
  if (!table || table.offset + 10 > ttf.rawData.length) {
    gposCache.set(ttf, pairs);
    return pairs;
  }

  const data = ttf.rawData;
  const base = table.offset;
  const version = readU32(data, base);
  if (version !== 0x00010000 && version !== 0x00011000) {
    gposCache.set(ttf, pairs);
    return pairs;
  }

  const featureListOffset = readU16(data, base + 6);
  const lookupListOffset = readU16(data, base + 8);
  const lookupIndices = findKernFeatureLookups(data, base, featureListOffset);

  for (let i = 0; i < lookupIndices.length; i++) {
    parseLookup(data, base + lookupListOffset, lookupIndices[i], pairs);
  }

  gposCache.set(ttf, pairs);
  return pairs;
}

function findKernFeatureLookups(
  data: Uint8Array,
  base: number,
  featureListOffset: number,
): number[] {
  const featureList = base + featureListOffset;
  if (featureList + 2 > data.length) return [];

  const featureCount = readU16(data, featureList);
  for (let i = 0; i < featureCount; i++) {
    const rec = featureList + 2 + i * 6;
    if (rec + 6 > data.length) break;
    const tag = String.fromCharCode(data[rec], data[rec + 1], data[rec + 2], data[rec + 3]);
    if (tag !== 'kern') continue;

    const offset = readU16(data, rec + 4);
    const feature = featureList + offset;
    if (feature + 4 > data.length) return [];

    const lookupCount = readU16(data, feature + 2);
    const indices: number[] = [];
    for (let li = 0; li < lookupCount; li++) {
      indices.push(readU16(data, feature + 4 + li * 2));
    }
    return indices;
  }
  return [];
}

function parseLookup(
  data: Uint8Array,
  lookupList: number,
  lookupIndex: number,
  pairs: GPOSPairAdjustment[],
): void {
  if (lookupList + 2 > data.length) return;
  const lookupCount = readU16(data, lookupList);
  if (lookupIndex >= lookupCount) return;

  const lookupOffset = readU16(data, lookupList + 2 + lookupIndex * 2);
  const lookup = lookupList + lookupOffset;
  if (lookup + 6 > data.length) return;

  const lookupType = readU16(data, lookup);
  const subTableCount = readU16(data, lookup + 4);

  for (let st = 0; st < subTableCount; st++) {
    const subOffset = readU16(data, lookup + 6 + st * 2);
    const sub = lookup + subOffset;
    if (lookupType === 2) {
      parsePairAdjustmentSubtable(data, sub, pairs);
    } else if (lookupType === 8) {
      parsePairPosFormat2(data, sub, pairs);
    }
  }
}

function parsePairAdjustmentSubtable(
  data: Uint8Array,
  sub: number,
  pairs: GPOSPairAdjustment[],
): void {
  if (sub + 10 > data.length) return;
  const format = readU16(data, sub);
  if (format !== 1) return;

  const coverageOffset = readU16(data, sub + 2);
  const pairSetCount = readU16(data, sub + 4);
  const coverage = sub + coverageOffset;
  const glyphCount = readU16(data, coverage + 2);

  for (let ps = 0; ps < pairSetCount; ps++) {
    const setOffset = readU16(data, sub + 6 + ps * 2);
    if (setOffset === 0) continue;
    const set = sub + setOffset;
    const pairCount = readU16(data, set);
    const leftGlyph = coverageGlyphAt(data, coverage, ps, glyphCount);

    for (let pi = 0; pi < pairCount; pi++) {
      const rec = set + 2 + pi * 6;
      if (rec + 6 > data.length) break;
      const rightGlyph = readU16(data, rec);
      const value1 = readI16(data, rec + 2);
      const value2 = readI16(data, rec + 4);
      pairs.push({
        left: leftGlyph,
        right: rightGlyph,
        xAdvance: value1,
        yAdvance: value2,
        xPlacement: 0,
        yPlacement: 0,
      });
    }
  }
}

function parsePairPosFormat2(
  data: Uint8Array,
  sub: number,
  pairs: GPOSPairAdjustment[],
): void {
  if (sub + 16 > data.length) return;
  const format = readU16(data, sub);
  if (format !== 2) return;

  const classDef1 = sub + readU16(data, sub + 6);
  const classDef2 = sub + readU16(data, sub + 8);
  const class1Count = readU16(data, sub + 10);
  const class2Count = readU16(data, sub + 12);
  const recordOff = sub + readU16(data, sub + 14);

  for (let c1 = 0; c1 < class1Count; c1++) {
    for (let c2 = 0; c2 < class2Count; c2++) {
      const rec = recordOff + (c1 * class2Count + c2) * 4;
      if (rec + 4 > data.length) break;
      const value1 = readI16(data, rec);
      const value2 = readI16(data, rec + 2);
      if (value1 === 0 && value2 === 0) continue;
      pairs.push({
        left: classDef1 * 1000 + c1,
        right: classDef2 * 1000 + c2,
        xAdvance: value1,
        yAdvance: value2,
        xPlacement: 0,
        yPlacement: 0,
      });
    }
  }
}

function coverageGlyphAt(
  data: Uint8Array,
  coverage: number,
  index: number,
  glyphCount: number,
): number {
  if (index >= glyphCount) return 0;
  const format = readU16(data, coverage);
  if (format === 1) {
    return readU16(data, coverage + 4 + index * 2);
  }
  return readU16(data, coverage + 4 + index * 6);
}

/** Parse mark-to-base positioning records (lookup type 4). */
export function parseGPOSMarkRecords(ttf: TTFFont): GPOSMarkRecord[] {
  const cached = markCache.get(ttf);
  if (cached) return cached;

  const marks: GPOSMarkRecord[] = [];
  const table = ttf.tables.get('GPOS');
  if (!table) {
    markCache.set(ttf, marks);
    return marks;
  }

  const data = ttf.rawData;
  const base = table.offset;
  const lookupListOffset = readU16(data, base + 8);
  const lookupList = base + lookupListOffset;
  const lookupCount = readU16(data, lookupList);

  for (let li = 0; li < lookupCount; li++) {
    const lookupOffset = readU16(data, lookupList + 2 + li * 2);
    const lookup = lookupList + lookupOffset;
    if (readU16(data, lookup) !== 4) continue;

    const subCount = readU16(data, lookup + 4);
    for (let st = 0; st < subCount; st++) {
      const subOffset = readU16(data, lookup + 6 + st * 2);
      parseMarkToBaseSubtable(data, lookup + subOffset, marks);
    }
  }

  markCache.set(ttf, marks);
  return marks;
}

function parseMarkToBaseSubtable(
  data: Uint8Array,
  sub: number,
  marks: GPOSMarkRecord[],
): void {
  if (sub + 8 > data.length) return;
  const markCoverageOff = readU16(data, sub + 2);
  const markArrayOff = readU16(data, sub + 6);
  const markCoverage = sub + markCoverageOff;
  const markArray = sub + markArrayOff;
  const markCount = readU16(data, markArray);

  for (let mi = 0; mi < markCount; mi++) {
    const rec = markArray + 2 + mi * 4;
    const classId = readU16(data, rec);
    const anchorOff = readU16(data, rec + 2);
    const anchor = markArray + anchorOff;
    const markGlyph = coverageGlyphAt(data, markCoverage, mi, markCount);
    marks.push({
      markGlyphId: markGlyph,
      xOffset: readI16(data, anchor + 2),
      yOffset: readI16(data, anchor + 4),
    });
    void classId;
  }
}

/** Lookup GPOS pair adjustment in font units. */
export function lookupGPOSPair(
  pairs: GPOSPairAdjustment[],
  left: number,
  right: number,
): GPOSPairAdjustment | null {
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.left === left && p.right === right) return p;
  }
  return null;
}

/** Apply GPOS pair adjustments to shaped glyph advances (font units → page units). */
export function applyGPOSAdjustments(
  glyphIds: number[],
  advances: number[],
  pairs: GPOSPairAdjustment[],
  unitsPerEm: number,
  fontSize: number,
): number[] {
  if (pairs.length === 0) return advances;
  const scale = fontSize / unitsPerEm;
  const out = [...advances];

  for (let i = 0; i < glyphIds.length - 1; i++) {
    const adj = lookupGPOSPair(pairs, glyphIds[i], glyphIds[i + 1]);
    if (adj) {
      out[i] += adj.xAdvance * scale;
    }
  }

  return out;
}
