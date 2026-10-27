/**
 * Selection → PDF QuadPoints for text markup annotations.
 */

import type { TextLine } from './types';
import { lineXFromCaretIndex } from './hit-test';
import { visualFontSize } from './metrics';

/**
 * Tight vertical span for a line highlight/link, derived from glyph matrices
 * (not the padded hit-test `line.height`, which can be wildly oversized).
 */
function lineVisualYSpan(line: TextLine): { top: number; bottom: number; fontSize: number } {
  let top = -Infinity;
  let bottom = Infinity;
  let fontSize = line.fontSize || 12;

  for (const run of line.runs) {
    const fs = visualFontSize(run);
    if (fs > fontSize) fontSize = fs;
    if (run.glyphs.length === 0) {
      const y = run.y || line.baseline;
      top = Math.max(top, y + fs * 0.85);
      bottom = Math.min(bottom, y - fs * 0.2);
      continue;
    }
    for (const g of run.glyphs) {
      const gy = g.tRm.f;
      const gfs =
        Math.sqrt(g.tRm.c * g.tRm.c + g.tRm.d * g.tRm.d) ||
        g.fontSize ||
        fs;
      top = Math.max(top, gy + gfs * 0.85);
      bottom = Math.min(bottom, gy - gfs * 0.2);
    }
  }

  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    const fs = Math.max(4, line.fontSize || 12);
    const bl = Number.isFinite(line.baseline) ? line.baseline : (line.y || 0);
    return { top: bl + fs * 0.85, bottom: bl - fs * 0.2, fontSize: fs };
  }

  // Guard against degenerate / inverted spans
  if (top - bottom < fontSize * 0.4) {
    const mid = (top + bottom) / 2;
    top = mid + fontSize * 0.5;
    bottom = mid - fontSize * 0.25;
  }

  return { top, bottom, fontSize };
}

/**
 * Build QuadPoints for a character range on a single line.
 * Returns [] for empty selection.
 * Order: top-left, top-right, bottom-left, bottom-right (PDF y-up).
 */
export function lineSelectionToQuadPoints(
  line: TextLine,
  start: number,
  end: number,
): number[] {
  const a = Math.max(0, Math.min(start, line.text.length));
  const b = Math.max(a, Math.min(end, line.text.length));
  if (a === b) return [];

  let left = lineXFromCaretIndex(line, a);
  let right = lineXFromCaretIndex(line, b);
  if (!Number.isFinite(left)) left = line.x;
  if (!Number.isFinite(right)) right = line.rightEdge;

  // Keep horizontal span inside the line's known text bounds
  const lineLeft = Number.isFinite(line.x) ? line.x : left;
  const lineRight = Number.isFinite(line.rightEdge) ? line.rightEdge : right;
  left = Math.min(left, right);
  right = Math.max(left, right);
  // Clamp to line box with a small pad — never expand to full page width
  left = Math.max(left, lineLeft - 1);
  right = Math.min(right, Math.max(lineRight, left + 2) + 1);
  if (right - left < 2) right = left + Math.max(2, (line.fontSize || 12) * 0.5);

  const { top, bottom } = lineVisualYSpan(line);

  return [
    left, top,
    right, top,
    left, bottom,
    right, bottom,
  ];
}

/** Union bounding rect from quad points. */
export function quadPointsToRect(quadPoints: number[]): {
  x: number; y: number; width: number; height: number;
} {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < quadPoints.length; i += 2) {
    const x = quadPoints[i];
    const y = quadPoints[i + 1];
    if (Number.isFinite(x)) xs.push(x);
    if (Number.isFinite(y)) ys.push(y);
  }
  if (xs.length === 0 || ys.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/**
 * Multi-line selection: full lines between first/last, partial on ends.
 */
export function multiLineSelectionToQuadPoints(
  lines: TextLine[],
  startLineIndex: number,
  startChar: number,
  endLineIndex: number,
  endChar: number,
): number[] {
  if (lines.length === 0) return [];
  let sLi = Math.max(0, Math.min(startLineIndex, lines.length - 1));
  let eLi = Math.max(0, Math.min(endLineIndex, lines.length - 1));
  let sCh = startChar;
  let eCh = endChar;
  if (sLi > eLi || (sLi === eLi && sCh > eCh)) {
    [sLi, eLi] = [eLi, sLi];
    [sCh, eCh] = [eCh, sCh];
  }

  const quads: number[] = [];
  for (let i = sLi; i <= eLi; i++) {
    const line = lines[i];
    const from = i === sLi ? sCh : 0;
    const to = i === eLi ? eCh : line.text.length;
    quads.push(...lineSelectionToQuadPoints(line, from, to));
  }
  return quads;
}

export { caretIndexFromLineX } from './hit-test';

// Re-export highlight helper (tests import from this module)
export { addHighlightFromSelection } from '../editor/highlight';
export type { SelectionPos } from '../editor/highlight';
