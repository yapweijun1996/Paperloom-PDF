/**
 * Soft mask (SMask) — ISO 32000-1 §11.4.4
 *
 * Resolves opacity from ext-gstate soft-mask dictionaries. Full group rendering
 * (/G XObject) is deferred; luminosity/alpha subtype metadata still adjusts alpha.
 */

import { PDFDict, PDFName, PDFNumber, PDFArray } from '../types';

export type SoftMaskSubtype = 'Alpha' | 'Luminosity' | 'None';

export interface SoftMaskInfo {
  subtype: SoftMaskSubtype;
  /** Multiplier applied to fill/stroke alpha (0–1). */
  opacity: number;
  backdrop: [number, number, number] | null;
}

/** Parse a resolved /SMask dictionary from ext-gstate. */
export function parseSoftMask(softMask: PDFDict | null): SoftMaskInfo {
  if (!softMask) {
    return { subtype: 'None', opacity: 1, backdrop: null };
  }

  const s = softMask.get('S');
  let subtype: SoftMaskSubtype = 'Alpha';
  if (s instanceof PDFName) {
    if (s.name === 'Luminosity') subtype = 'Luminosity';
    else if (s.name === 'Alpha') subtype = 'Alpha';
  }

  const bc = softMask.get('BC');
  let backdrop: [number, number, number] | null = null;
  if (bc instanceof PDFArray && bc.length >= 3) {
    const nums = bc.asNumbers();
    backdrop = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
  }

  // Without rendering /G, approximate masked content as slightly attenuated.
  const opacity = subtype === 'Luminosity' ? 0.92 : 0.96;

  return { subtype, opacity, backdrop };
}

/** Effective alpha combining constant alpha and soft mask. */
export function effectiveAlpha(
  baseAlpha: number,
  softMask: PDFDict | null,
): number {
  if (!softMask) return baseAlpha;
  const info = parseSoftMask(softMask);
  return Math.max(0, Math.min(1, baseAlpha * info.opacity));
}

/** Read /CA or /ca from an ext-gstate dict if present. */
export function readConstantAlpha(dict: PDFDict, stroke: boolean): number | null {
  const key = stroke ? 'CA' : 'ca';
  const v = dict.get(key);
  if (v instanceof PDFNumber) return v.value;
  return null;
}
