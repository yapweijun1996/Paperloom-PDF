/**
 * Scene graph — editable objects derived from the display list.
 */

import type { DisplayItem, ImageItem, PathItem, TextRun } from '../content/interpreter';
import { isPageBackgroundPath } from './selection';

export interface EditableObject {
  id: string;
  kind: 'image' | 'path' | 'text';
  bbox: { x: number; y: number; width: number; height: number };
  /** 6-element PDF affine matrix [a b c d e f] */
  ctm: number[];
  contentRange?: { startOp: number; endOp: number };
  source?: ImageItem | PathItem | TextRun;
}

let _id = 0;
function nextId(kind: string): string {
  return `${kind}-${++_id}`;
}

export function resetSceneIdCounter(): void {
  _id = 0;
}

/** Build a flat scene graph from interpreter display items. */
export function buildSceneGraph(
  displayList: DisplayItem[],
  pageBounds?: { x: number; y: number; width: number; height: number },
): EditableObject[] {
  resetSceneIdCounter();
  const objects: EditableObject[] = [];
  const bounds = pageBounds ?? { x: 0, y: 0, width: 612, height: 792 };

  for (const item of displayList) {
    if (item.type === 'image') {
      const img = item as ImageItem;
      objects.push({
        id: nextId('image'),
        kind: 'image',
        bbox: { x: img.x, y: img.y, width: img.width, height: img.height },
        ctm: img.ctm
          ? [img.ctm.a, img.ctm.b, img.ctm.c, img.ctm.d, img.ctm.e, img.ctm.f]
          : [img.width, 0, 0, img.height, img.x, img.y],
        source: img,
      });
    } else if (item.type === 'path') {
      const path = item as PathItem;
      if ((path.width || 0) < 2 && (path.height || 0) < 2) continue;
      if (isPageBackgroundPath(path, bounds)) continue;
      objects.push({
        id: nextId('path'),
        kind: 'path',
        bbox: { x: path.x, y: path.y, width: path.width, height: path.height },
        ctm: [1, 0, 0, 1, 0, 0],
        source: path,
      });
    } else if (item.type === 'text') {
      const run = item as TextRun;
      const indices = run.sourceInstructionIndices ?? [];
      objects.push({
        id: nextId('text'),
        kind: 'text',
        bbox: {
          x: run.x,
          y: run.y - run.fontSize * 0.2,
          width: Math.max(run.width, 1),
          height: Math.max(run.fontSize * 1.2, 1),
        },
        ctm: [1, 0, 0, 1, run.x, run.y],
        contentRange: indices.length
          ? { startOp: Math.min(...indices), endOp: Math.max(...indices) }
          : undefined,
        source: run,
      });
    }
  }

  return objects;
}

/** Hit-test scene objects (top-most first). */
export function hitTestScene(
  objects: EditableObject[],
  pdfX: number,
  pdfY: number,
): EditableObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    const { x, y, width, height } = o.bbox;
    if (pdfX >= x && pdfX <= x + width && pdfY >= y && pdfY <= y + height) {
      return o;
    }
  }
  return null;
}
