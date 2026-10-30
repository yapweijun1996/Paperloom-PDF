import { PDFArray, PDFDict, PDFNumber, PDFRef } from '../../types';

/** Partial redaction cannot inspect copies of mark metadata, so admit only
 * the simple, non-textual marks produced by the editor. An isolated-text
 * edit may also remove a reference to a canonical stream it will replace. */
export function isBareRedactionMark(mark: PDFDict, editedContentRefs?: ReadonlySet<string>): boolean {
  const allowed = new Set(['Type', 'Subtype', 'Rect', 'QuadPoints', 'P', 'C', 'IC', 'CA', 'F']);
  if (mark.has('Shared')) {
    const shared = mark.get('Shared');
    if (!(shared instanceof PDFRef) || !editedContentRefs?.has(shared.toKey())) return false;
    allowed.add('Shared');
  }
  if ([...mark.keys()].some(key => !allowed.has(key)) || mark.getName('Subtype') !== 'Redact' ||
      (mark.has('Type') && mark.getName('Type') !== 'Annot')) return false;
  for (const key of ['C', 'IC']) {
    const value = mark.get(key);
    if (value === undefined) continue;
    if (!(value instanceof PDFArray) || ![0, 1, 3, 4].includes(value.length) ||
        value.items.some(item => !(item instanceof PDFNumber) || !Number.isFinite(item.value) || item.value < 0 || item.value > 1)) return false;
  }
  const opacity = mark.get('CA');
  if (opacity !== undefined && (!(opacity instanceof PDFNumber) || !Number.isFinite(opacity.value) || opacity.value < 0 || opacity.value > 1)) return false;
  const flags = mark.get('F');
  return flags === undefined || (flags instanceof PDFNumber && Number.isSafeInteger(flags.value) && flags.value >= 0);
}
