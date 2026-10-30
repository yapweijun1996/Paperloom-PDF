import { PDFDict, PDFName, type PDFObject } from '../types';
import { resolveRef } from '../parser/parser';

/** Resolve a PDF annotation's subtype without guessing missing or invalid values. */
export function annotationSubtype(annotation: PDFDict, objects: Map<string, PDFObject>): string | undefined {
  const entry = annotation.get('Subtype');
  if (!entry) return undefined;
  const value = resolveRef(entry, objects);
  return value instanceof PDFName ? value.name : undefined;
}
