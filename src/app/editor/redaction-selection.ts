import type { PDFPageInfo, PDFRectangle } from '@/engine/types';
import { canvasToPdf } from './utils';

type Point = { x: number; y: number };

/** Map an on-screen drag to PDF coordinates only when page geometry is verified. */
export function redactionRegionFromDrag(
  page: PDFPageInfo, scale: number, width: number, height: number, start: Point, end: Point,
): PDFRectangle {
  const { cropBox, mediaBox } = page;
  // The renderer currently applies transforms only for these exact values;
  // normalizing -90 or 450 here would select a different area than displayed.
  const rotation = page.rotate;
  const finite = [scale, width, height, cropBox.x, cropBox.y, cropBox.width, cropBox.height,
    mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height, start.x, start.y, end.x, end.y].every(Number.isFinite);
  if (!finite || scale <= 0 || ![0, 90, 180, 270].includes(rotation) ||
      cropBox.width <= 0 || cropBox.height <= 0 || page.dict.has('UserUnit') ||
      cropBox.x < mediaBox.x || cropBox.y < mediaBox.y ||
      cropBox.x + cropBox.width > mediaBox.x + mediaBox.width || cropBox.y + cropBox.height > mediaBox.y + mediaBox.height) {
    throw new Error('Page geometry cannot be safely mapped for redaction.');
  }
  const rotated = rotation === 90 || rotation === 270;
  const pageWidth = rotated ? cropBox.height : cropBox.width;
  const pageHeight = rotated ? cropBox.width : cropBox.height;
  if (Math.abs(width - pageWidth * scale) > 1 || Math.abs(height - pageHeight * scale) > 1) {
    throw new Error('Page display changed. Select the redaction region again.');
  }
  // Canvas dimensions are rounded up; the extra edge pixels do not represent
  // visible page coordinates and must not expand the selected PDF region.
  if ([start, end].some(p => p.x < 0 || p.y < 0 || p.x > pageWidth * scale || p.y > pageHeight * scale) ||
      Math.abs(start.x - end.x) < 3 || Math.abs(start.y - end.y) < 3) {
    throw new Error('Select a larger region within the page.');
  }
  const map = (p: Point) => canvasToPdf(p.x, p.y, scale, pageWidth, pageHeight,
    mediaBox.x, mediaBox.y, rotation, cropBox.x, cropBox.y);
  const a = map(start), b = map(end);
  return { x: Math.min(a.pdfX, b.pdfX), y: Math.min(a.pdfY, b.pdfY),
    width: Math.abs(a.pdfX - b.pdfX), height: Math.abs(a.pdfY - b.pdfY) };
}
