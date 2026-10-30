import type { PDFPageInfo, PDFRectangle } from '@/engine/types';
import { canvasToPdf, intersectPageBox, pdfToCanvas, type ViewportTransform } from '@/engine/editing/coordinates';

/** Use the renderer's effective viewport and only the rotations it renders. */
export function signaturePageRotation(page: PDFPageInfo): number {
  return [0, 90, 180, 270].includes(page.rotate) ? page.rotate : 0;
}

function viewport(page: PDFPageInfo, scale: number): ViewportTransform {
  const box = intersectPageBox(page.mediaBox, page.cropBox);
  return { scale, rotation: signaturePageRotation(page), pageX: box.x, pageY: box.y,
    pageWidth: box.width, pageHeight: box.height };
}

export function signatureBoxOnPage(page: PDFPageInfo, box: PDFRectangle, scale: number) {
  const center = pdfToCanvas(box.x + box.width / 2, box.y + box.height / 2, viewport(page, scale));
  return { left: center.x - box.width * scale / 2, top: center.y - box.height * scale / 2,
    width: box.width * scale, height: box.height * scale };
}

export function signatureFieldBoxOnPage(page: PDFPageInfo, box: PDFRectangle, scale: number) {
  const transform = viewport(page, scale);
  const points = [pdfToCanvas(box.x, box.y, transform), pdfToCanvas(box.x + box.width, box.y, transform),
    pdfToCanvas(box.x, box.y + box.height, transform), pdfToCanvas(box.x + box.width, box.y + box.height, transform)];
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  return { left, top, width: right - left, height: bottom - top };
}

export function signaturePagePoint(page: PDFPageInfo, point: { x: number; y: number }, scale: number) {
  const result = canvasToPdf(point.x, point.y, viewport(page, scale));
  return { pdfX: result.x, pdfY: result.y };
}
