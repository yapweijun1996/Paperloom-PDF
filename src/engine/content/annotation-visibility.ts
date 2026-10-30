import { PDFDict, PDFName, PDFNumber, PDFRef, type PDFObject } from '../types';
import { resolveRef } from '../parser/parser';

// ISO 32000 Invisible applies to nonstandard types with no handler. Known
// annotations retain their appearance unless Hidden or NoView is set.
const STANDARD_ANNOTATIONS = new Set([
  'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink',
  'Popup', 'FileAttachment', 'Sound', 'Movie', 'Widget', 'Screen', 'PrinterMark',
  'TrapNet', 'Watermark', '3D', 'Redact', 'Projection',
]);

export function isAnnotationVisible(annotation: PDFDict, objects: Map<string, PDFObject>): boolean {
  const flagsEntry = annotation.get('F');
  if (!flagsEntry) return true;
  const flagsObject = flagsEntry instanceof PDFRef ? resolveRef(flagsEntry, objects) : flagsEntry;
  if (!(flagsObject instanceof PDFNumber) || !Number.isSafeInteger(flagsObject.value) || flagsObject.value < 0) {
    throw new Error('Cannot determine annotation visibility: invalid flags');
  }
  const flags = flagsObject.value;
  if ((flags & (2 | 32)) !== 0) return false; // Hidden or NoView
  if ((flags & 1) === 0) return true;
  const subtypeEntry = annotation.get('Subtype');
  const subtype = subtypeEntry instanceof PDFRef ? resolveRef(subtypeEntry, objects) : subtypeEntry;
  return subtype instanceof PDFName && STANDARD_ANNOTATIONS.has(subtype.name);
}
