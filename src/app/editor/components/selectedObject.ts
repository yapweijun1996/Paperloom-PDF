import type { DisplayItem, ImageItem, PathItem } from '@/engine/browser-core';
import { sameImagePlacement } from './imageSelection';

/** Every object that looks identical to the selection (position, geometry and paint). */
export function matchingObjects(
  items: readonly DisplayItem[],
  selected: ImageItem | PathItem,
): Array<ImageItem | PathItem> {
  return items.filter((item): item is ImageItem | PathItem => {
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
}

/**
 * Reidentify a selected object after queued edits without guessing between duplicates.
 * Identical stacked drawings are told apart by their content-stream position.
 */
export function resolveSelectedObject(
  items: readonly DisplayItem[],
  selected: ImageItem | PathItem,
): ImageItem | PathItem | null {
  const matches = matchingObjects(items, selected);
  if (matches.length === 1) return matches[0];
  if (selected.type !== 'path' || selected.sourceInstructionIndex == null) return null;
  const exact = matches.filter(item =>
    item.type === 'path' && item.sourceInstructionIndex === selected.sourceInstructionIndex);
  return exact.length === 1 ? exact[0] : null;
}
