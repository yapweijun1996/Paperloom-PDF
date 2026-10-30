/**
 * Path Clipping — ISO 32000-1 §8.4.3
 *
 * Applies PDF clip paths (W / W*) to CanvasRenderingContext2D.
 * Uses even-odd rule for W* and nonzero for W.
 *
 * A constructed zero-area path remains a clipping path rather than being
 * discarded on the basis of its dimensions.
 */

import type { ClipPathNode } from './graphics-state';

export function applyClipPaths(
  ctx: CanvasRenderingContext2D,
  clipPaths: ClipPathNode[],
  /** Kept for call-site compatibility; clipping is independent of paint bounds. */
  contentBounds?: { x: number; y: number; width: number; height: number },
): void {
  void contentBounds;
  for (let p = 0; p < clipPaths.length; p++) {
    const path = clipPaths[p];
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
