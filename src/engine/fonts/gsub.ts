/**
 * OpenType GSUB table parser — ligature substitution (lookup type 4).
 *
 * Native parser for common Latin ligatures (fi, fl, ff, ffi, ffl).
 * Complex-script GPOS/GSUB chains are a follow-up.
 */

import type { TTFFont } from './truetype-parser';

export interface LigatureRule {
  /** Glyph IDs forming the ligature (excluding component after first). */
  components: number[];
  /** Output ligature glyph ID. */
  ligatureGlyphId: number;
}

const gsubCache = new WeakMap<TTFFont, LigatureRule[]>();

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32(data: Uint8Array, offset: number): number {
  return (readU16(data, offset) << 16) | readU16(data, offset + 2);
}

/** Parse GSUB ligature rules from an embedded TrueType font. */
export function parseGSUBLigatures(ttf: TTFFont): LigatureRule[] {
  const cached = gsubCache.get(ttf);
  if (cached) return cached;

  const rules: LigatureRule[] = [];
  const table = ttf.tables.get('GSUB');
  if (!table || table.offset + 10 > ttf.rawData.length) {
    gsubCache.set(ttf, rules);
    return rules;
  }

  const data = ttf.rawData;
  const base = table.offset;
  const version = readU32(data, base);
  if (version !== 0x00010000 && version !== 0x00011000) {
    gsubCache.set(ttf, rules);
    return rules;
  }

  const scriptListOffset = readU16(data, base + 4);
  const featureListOffset = readU16(data, base + 6);
  const lookupListOffset = readU16(data, base + 8);

  const featureIndices = findLigaFeatureLookups(data, base, featureListOffset);
  if (featureIndices.length === 0) {
    gsubCache.set(ttf, rules);
    return rules;
  }

  for (let fi = 0; fi < featureIndices.length; fi++) {
    const lookupIndex = featureIndices[fi];
    parseLookupList(data, base, lookupListOffset, lookupIndex, rules);
  }

  gsubCache.set(ttf, rules);
  return rules;
}

function findLigaFeatureLookups(
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
    if (tag !== 'liga') continue;

    const offset = readU16(data, rec + 4);
    const feature = featureList + offset;
    if (feature + 4 > data.length) return [];

    const lookupCount = readU16(data, feature + 2);
    const indices: number[] = [];
    for (let li = 0; li < lookupCount; li++) {
      const idx = readU16(data, feature + 4 + li * 2);
      indices.push(idx);
    }
    return indices;
  }

  return [];
}

function parseLookupList(
  data: Uint8Array,
  base: number,
  lookupListOffset: number,
  lookupIndex: number,
  rules: LigatureRule[],
): void {
  const lookupList = base + lookupListOffset;
  if (lookupList + 2 > data.length) return;

  const lookupCount = readU16(data, lookupList);
  if (lookupIndex >= lookupCount) return;

  const lookupOffset = readU16(data, lookupList + 2 + lookupIndex * 2);
  const lookup = lookupList + lookupOffset;
  if (lookup + 6 > data.length) return;

  const lookupType = readU16(data, lookup);
  if (lookupType !== 4) return; // Ligature substitution

  const subTableCount = readU16(data, lookup + 4);
  for (let st = 0; st < subTableCount; st++) {
    const subOffset = readU16(data, lookup + 6 + st * 2);
    parseLigatureSubtable(data, lookup + subOffset, rules);
  }
}

function parseLigatureSubtable(
  data: Uint8Array,
  subtable: number,
  rules: LigatureRule[],
): void {
  if (subtable + 6 > data.length) return;

  const ligatureSetCount = readU16(data, subtable + 4);
  for (let ls = 0; ls < ligatureSetCount; ls++) {
    const setOffset = readU16(data, subtable + 6 + ls * 2);
    if (setOffset === 0) continue;
    const set = subtable + setOffset;
    if (set + 2 > data.length) continue;

    const ligatureCount = readU16(data, set);
    for (let li = 0; li < ligatureCount; li++) {
      const ligOffset = readU16(data, set + 2 + li * 2);
      const lig = set + ligOffset;
      if (lig + 4 > data.length) continue;

      const ligatureGlyph = readU16(data, lig);
      const compCount = data[lig + 2];
      const components: number[] = [];
      for (let c = 0; c < compCount - 1; c++) {
        components.push(readU16(data, lig + 3 + c * 2));
      }
      rules.push({ components, ligatureGlyphId: ligatureGlyph });
    }
  }
}

/**
 * Apply GSUB ligature rules to a glyph ID sequence.
 * Returns expanded glyph IDs (ligatures replace component runs).
 */
export function applyLigatures(
  glyphIds: number[],
  rules: LigatureRule[],
): number[] {
  if (rules.length === 0 || glyphIds.length === 0) return glyphIds;

  const out: number[] = [];
  let i = 0;

  while (i < glyphIds.length) {
    let matched = false;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r];
      if (rule.components.length === 0) continue;
      if (glyphIds[i + 1] !== rule.components[0]) continue;

      let ok = true;
      for (let c = 1; c < rule.components.length; c++) {
        if (glyphIds[i + 1 + c] !== rule.components[c]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      out.push(rule.ligatureGlyphId);
      i += 1 + rule.components.length;
      matched = true;
      break;
    }

    if (!matched) {
      out.push(glyphIds[i]);
      i += 1;
    }
  }

  return out;
}

/** Shape glyph IDs with ligatures, preserving source unicode spans. */
export function shapeGlyphIdsWithLigatures(
  glyphIds: number[],
  charUnits: string[],
  rules: LigatureRule[],
): Array<{ glyphId: number; unicode: string }> {
  if (rules.length === 0 || glyphIds.length === 0) {
    return glyphIds.map((id, i) => ({ glyphId: id, unicode: charUnits[i] ?? '' }));
  }

  const out: Array<{ glyphId: number; unicode: string }> = [];
  let i = 0;

  while (i < glyphIds.length) {
    let matched = false;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r];
      if (rule.components.length === 0) continue;
      if (glyphIds[i + 1] !== rule.components[0]) continue;

      let ok = true;
      for (let c = 1; c < rule.components.length; c++) {
        if (glyphIds[i + 1 + c] !== rule.components[c]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const span = 1 + rule.components.length;
      out.push({
        glyphId: rule.ligatureGlyphId,
        unicode: charUnits.slice(i, i + span).join(''),
      });
      i += span;
      matched = true;
      break;
    }

    if (!matched) {
      out.push({ glyphId: glyphIds[i], unicode: charUnits[i] ?? '' });
      i += 1;
    }
  }

  return out;
}
