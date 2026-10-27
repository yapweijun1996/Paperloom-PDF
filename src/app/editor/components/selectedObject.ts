import type { DisplayItem, ImageItem, PathItem } from '@/engine/browser-core';
import { sameImagePlacement } from './imageSelection';

/** Reidentify a selected object after queued edits without guessing between duplicates. */
export function resolveSelectedObject(
  items: readonly DisplayItem[],
  selected: ImageItem | PathItem,
): ImageItem | PathItem | null {
  const matches = items.filter((item): item is ImageItem | PathItem => {
    if (selected.type === 'image') {
      return item.type === 'image' && sameImagePlacement(item, selected);
    }
    return item.type === 'path' &&
      item.x === selected.x && item.y === selected.y &&
      item.width === selected.width && item.height === selected.height &&
      item.paintType === selected.paintType && item.lineWidth === selected.lineWidth &&
      item.fillAlpha === selected.fillAlpha && item.strokeAlpha === selected.strokeAlpha &&
      item.blendMode === selected.blendMode &&
      JSON.stringify(item.segments) === JSON.stringify(selected.segments) &&
      JSON.stringify(item.fillColor) === JSON.stringify(selected.fillColor) &&
      JSON.stringify(item.strokeColor) === JSON.stringify(selected.strokeColor);
  });
  return matches.length === 1 ? matches[0] : null;
}
