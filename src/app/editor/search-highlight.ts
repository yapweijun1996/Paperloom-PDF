import { intersectPageBox } from '@/engine/editing/coordinates';
import { pdfToCanvas } from './utils';

interface Rectangle { x: number; y: number; width: number; height: number }
interface PageGeometry { mediaBox: Rectangle; cropBox: Rectangle; rotate: number }

/** Map a PDF-space search rectangle to the same cropped, rotated canvas as the renderer. */
export function searchHighlightBounds(
  rect: Rectangle, page: PageGeometry, scale: number, alreadyClipped: boolean,
): { left: number; top: number; width: number; height: number; clipped: boolean } | null {
  const viewport = intersectPageBox(page.mediaBox, page.cropBox);
  if (![rect.x, rect.y, rect.width, rect.height, viewport.x, viewport.y, viewport.width, viewport.height, scale]
    .every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || scale <= 0) return null;
  const x = Math.max(rect.x, viewport.x), y = Math.max(rect.y, viewport.y);
  const right = Math.min(rect.x + rect.width, viewport.x + viewport.width);
  const top = Math.min(rect.y + rect.height, viewport.y + viewport.height);
  if (right <= x || top <= y) return null;
  const cropped = alreadyClipped || x !== rect.x || y !== rect.y || right !== rect.x + rect.width || top !== rect.y + rect.height;
  // Match the renderer: unsupported rotation values are drawn as 0 degrees.
  const rotation = [90, 180, 270].includes(page.rotate) ? page.rotate : 0;
  const rotated = rotation === 90 || rotation === 270;
  const pageWidth = rotated ? viewport.height : viewport.width;
  const pageHeight = rotated ? viewport.width : viewport.height;
  const corners = [[x, y], [x, top], [right, y], [right, top]].map(([px, py]) =>
    pdfToCanvas(px, py, scale, pageHeight, page.mediaBox.x, page.mediaBox.y,
      rotation, viewport.x, viewport.y, pageWidth));
  const xs = corners.map(corner => corner.cssX), ys = corners.map(corner => corner.cssY);
  const left = Math.min(...xs), upper = Math.min(...ys);
  const width = Math.max(...xs) - left, height = Math.max(...ys) - upper;
  // Active highlights add a ring, shadow and 1.04 scale; suppress those
  // decorations near a viewport edge so they cannot spill beyond CropBox.
  const padX = 32 + width * 0.02, padY = 32 + height * 0.02;
  const nearEdge = left < padX || upper < padY || pageWidth * scale - left - width < padX ||
    pageHeight * scale - upper - height < padY;
  return { left, top: upper, width, height, clipped: cropped || nearEdge };
}
