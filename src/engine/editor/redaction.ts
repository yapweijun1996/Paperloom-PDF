/**
 * Redaction — mark and apply irreversible content removal.
 */

import {
  PDFArray,
  PDFDict,
  PDFRef,
  type PDFDocumentData,
  type PDFObject,
  type PDFRectangle,
} from '../types';
import {
  createAnnotationDict,
  addAnnotationToPage,
  type RedactAnnotation,
} from './annotation-engine';
import { getNextObjNum } from '../writer/serializer';
import { quadPointsToRect } from '../flow/selection-quads';
import { UnsupportedSecureRedactionError } from '../security/redaction/redaction-engine';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApplyRedactionsResult {
  redactedCount: number;
  removedOperatorCount: number;
  removedRuns: number;
  appliedRects: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/**
 * Union overlapping rectangles; leave disjoint ones separate.
 * Returns an array of merged rects.
 */
export function unionRects(rects: Rect[]): Rect[] {
  if (rects.length === 0) return [];
  const result: Rect[] = rects.map(r => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (rectsOverlap(result[i], result[j])) {
          const a = result[i];
          const b = result[j];
          const minX = Math.min(a.x, b.x);
          const minY = Math.min(a.y, b.y);
          const maxX = Math.max(a.x + a.width, b.x + b.width);
          const maxY = Math.max(a.y + a.height, b.y + b.height);
          result[i] = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          result.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }
  return result;
}

/** Mark a redaction annotation on a page. */
export function markRedaction(
  doc: PDFDocumentData,
  pageIndex: number,
  quadPoints: number[],
  color: [number, number, number] = [0, 0, 0],
  overlayText?: string,
): PDFRef {
  const page = doc.pages[pageIndex];
  const bounds = quadPointsToRect(quadPoints);
  const rect: PDFRectangle = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  const annot: RedactAnnotation = {
    type: 'Redact',
    rect,
    color,
    opacity: 0.4,
    quadPoints,
    overlayText,
  };

  const objNum = getNextObjNum(doc);
  const { dict } = createAnnotationDict(annot, objNum, doc.objects);
  const ref = new PDFRef(objNum, 0);
  addAnnotationToPage(page.dict, dict, ref, doc.objects);
  return ref;
}

/**
 * Applying marks is unavailable until content removal and full-rewrite export
 * can be guaranteed. A painted rectangle alone is not secure redaction.
 */
export async function applyRedactions(
  doc: PDFDocumentData,
  pageIndex: number,
): Promise<ApplyRedactionsResult> {
  const page = doc.pages[pageIndex];
  if (hasRedactMark(page.dict, doc.objects)) {
    throw new UnsupportedSecureRedactionError();
  }
  return { redactedCount: 0, removedOperatorCount: 0, removedRuns: 0, appliedRects: 0 };
}

function hasRedactMark(pageDict: PDFDict, objects: Map<string, PDFObject>): boolean {
  const resolve = (value: PDFObject): PDFObject | undefined => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key)) return undefined;
      seen.add(key);
      const target = objects.get(key);
      if (!target) return undefined;
      value = target;
    }
    return value;
  };
  const annots = pageDict.get('Annots');
  if (!annots) return false;
  const arr = resolve(annots);
  if (!(arr instanceof PDFArray)) throw new Error('Cannot inspect page annotations safely.');
  for (const item of arr.items) {
    const dict = resolve(item);
    if (!(dict instanceof PDFDict)) throw new Error('Cannot inspect page annotations safely.');
    const subtype = dict.getName('Subtype');
    if (!subtype || subtype === 'Redact') return true;
  }
  return false;
}
