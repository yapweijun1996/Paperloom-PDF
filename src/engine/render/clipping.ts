/**
 * Path Clipping — ISO 32000-1 §8.4.3
 *
 * Applies PDF clip paths (W / W*) to CanvasRenderingContext2D.
 * Uses even-odd rule for W* and nonzero for W.
 *
 * Includes validation to skip degenerate clip paths that would
 * make all content invisible.
 */

import type { ClipPathNode } from './graphics-state';

/**
 * Compute the bounding box of a clip path's segments.
 * Returns null for paths with no valid points.
 */
function clipPathBounds(path: ClipPathNode): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;

  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i];
    for (let j = 0; j < seg.points.length; j += 2) {
      const x = seg.points[j];
      const y = seg.points[j + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      hasPoints = true;
    }
  }

  if (!hasPoints) return null;
  return { minX, minY, maxX, maxY };
}

export function applyClipPaths(
  ctx: CanvasRenderingContext2D,
  clipPaths: ClipPathNode[],
  /** Optional content bounds — skip clips that do not intersect (stale/shared clips). */
  contentBounds?: { x: number; y: number; width: number; height: number },
): void {
  for (let p = 0; p < clipPaths.length; p++) {
    const path = clipPaths[p];

    // Skip empty clip paths
    if (path.segments.length === 0) continue;

    // Skip degenerate clip paths (zero-area)
    const bounds = clipPathBounds(path);
    if (!bounds) continue;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    if (w < 0.5 || h < 0.5) continue;

    // Skip clips that clearly don't cover this content (avoids cropping text
    // when a shared/mis-associated clip from an image or other object leaks in).
    if (contentBounds && contentBounds.width > 0 && contentBounds.height > 0) {
      const pad = 1;
      const cRight = contentBounds.x + contentBounds.width;
      const cTop = contentBounds.y + contentBounds.height;
      const overlapX =
        contentBounds.x - pad < bounds.maxX && cRight + pad > bounds.minX;
      const overlapY =
        contentBounds.y - pad < bounds.maxY && cTop + pad > bounds.minY;
      if (!overlapX || !overlapY) continue;

      // Skip partial clips that would chop the left/right of a text run
      // (classic certificate bug: image clip inherited by nearby labels).
      const coverLeft = Math.max(contentBounds.x, bounds.minX);
      const coverRight = Math.min(cRight, bounds.maxX);
      const covered = Math.max(0, coverRight - coverLeft);
      if (covered < contentBounds.width * 0.85) continue;
    }

    ctx.beginPath();
    for (let i = 0; i < path.segments.length; i++) {
      const seg = path.segments[i];
      switch (seg.type) {
        case 'M':
          ctx.moveTo(seg.points[0], seg.points[1]);
          break;
        case 'L':
          ctx.lineTo(seg.points[0], seg.points[1]);
          break;
        case 'C':
          ctx.bezierCurveTo(
            seg.points[0], seg.points[1],
            seg.points[2], seg.points[3],
            seg.points[4], seg.points[5],
          );
          break;
        case 'Z':
          ctx.closePath();
          break;
      }
    }
    if (path.windingRule === 'evenodd') {
      ctx.clip('evenodd');
    } else {
      ctx.clip();
    }
  }
}
