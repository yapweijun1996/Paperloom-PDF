import { PDFArray, PDFDict, PDFNumber, PDFRef, type PDFObject, type PDFPageInfo } from '@/engine/types';

const resolve = (value: PDFObject | undefined, objects: Map<string, PDFObject>) =>
  value instanceof PDFRef ? objects.get(value.toKey()) : value;

/** Rectangles of the page's pending redaction marks, in PDF space, for review. */
export function redactionMarkRects(page: PDFPageInfo | undefined, objects: Map<string, PDFObject>) {
  const annots = page && resolve(page.dict.get('Annots'), objects);
  if (!(annots instanceof PDFArray)) return [];
  return annots.items.flatMap(item => {
    const annot = resolve(item, objects);
    if (!(annot instanceof PDFDict) || annot.getName('Subtype') !== 'Redact') return [];
    const rect = annot.get('Rect');
    if (!(rect instanceof PDFArray) || rect.length !== 4 || !rect.items.every(value => value instanceof PDFNumber)) return [];
    const [x1, y1, x2, y2] = rect.items.map(value => (value as PDFNumber).value);
    return [{ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }];
  });
}
