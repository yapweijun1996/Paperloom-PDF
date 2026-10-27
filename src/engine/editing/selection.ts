/**
 * Build a spatial index from interpreter display list items for selection.
 */

import type { DisplayItem, PathItem, ImageItem, TextRun } from '../content/interpreter';
import { QuadTree, type SpatialEntry, type Bounds } from './spatial-index';

export type SelectableItem = PathItem | ImageItem | TextRun;

/** Page-covering fill rects (white backgrounds) must not be selectable. */
export function isPageBackgroundPath(
  path: PathItem,
  pageBounds: Bounds,
): boolean {
  if (path.paintType === 'stroke') return false;

  const pageArea = Math.max(1, pageBounds.width * pageBounds.height);
  const pathArea = Math.max(0, path.width) * Math.max(0, path.height);
  if (pathArea / pageArea < 0.9) return false;

  // Near-full coverage of the media box (allows slight inset margins)
  const coversW = path.width >= pageBounds.width * 0.95;
  const coversH = path.height >= pageBounds.height * 0.95;
  if (!coversW || !coversH) return false;

  // Once both axes cover ≥95% and area ≥90%, treat as page background.
  // Do not require exact origin alignment — inset page fills (e.g. ~6pt
  // margins on score cards) otherwise steal every empty-area click.
  return true;
}

/** Paths/images worth putting in the selection index. */
export function isSelectableDisplayItem(
  item: DisplayItem,
  pageBounds: Bounds,
): boolean {
  if (item.type === 'image') return true;
  if (item.type !== 'path') return false;

  const path = item as PathItem;
  if ((path.width || 0) <= 20 || (path.height || 0) <= 20) return false;
  if (isPageBackgroundPath(path, pageBounds)) return false;
  return true;
}

export function buildDisplayListIndex(
  items: DisplayItem[],
  pageBounds: Bounds,
): QuadTree<SelectableItem> {
  const tree = new QuadTree<SelectableItem>(pageBounds);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'image' || item.type === 'path') {
      if (!isSelectableDisplayItem(item, pageBounds)) continue;
      tree.insert({
        id: `${item.type}-${i}`,
        bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
        data: item as SelectableItem,
      });
    } else if (item.type === 'text') {
      tree.insert({
        id: `text-${i}`,
        bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
        data: item as SelectableItem,
      });
    }
  }

  return tree;
}

/**
 * Hit-test: among all items under the point, prefer the smallest bbox
 * (most specific object) so page-sized leftovers never win.
 */
export function hitTestDisplayList(
  tree: QuadTree<SelectableItem>,
  pdfX: number,
  pdfY: number,
): SpatialEntry<SelectableItem> | null {
  const hits = tree.queryPoint(pdfX, pdfY);
  if (hits.length === 0) return null;

  let best = hits[0];
  let bestArea = best.bounds.width * best.bounds.height;
  for (let i = 1; i < hits.length; i++) {
    const area = hits[i].bounds.width * hits[i].bounds.height;
    if (area < bestArea) {
      best = hits[i];
      bestArea = area;
    }
  }
  return best;
}
