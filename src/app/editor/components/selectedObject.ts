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

/** Find the copy of `source` that a duplicate placed at (dx, dy); null unless exactly one fits. */
export function findOffsetCopy(
  items: readonly DisplayItem[],
  source: ImageItem | PathItem,
  dx: number,
  dy: number,
): ImageItem | PathItem | null {
  // Rewriting the stream rounds coordinates, so compare with a small tolerance.
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  const copies = items.filter((item): item is ImageItem | PathItem =>
    item.type === source.type &&
    near(item.x, source.x + dx) && near(item.y, source.y + dy) &&
    near(item.width, source.width) && near(item.height, source.height) &&
    (item.type === 'image'
      ? item.name === (source as ImageItem).name
      : item.paintType === (source as PathItem).paintType));
  return copies.length === 1 ? copies[0] : null;
}

type Box = { x: number; y: number; width: number; height: number };

/** Page-space matrix taking `source` onto `box`; a flat side keeps its scale. */
export function drawingBoxMatrix(source: Box, box: Box): number[] {
  const sx = source.width > 0.5 ? box.width / source.width : 1;
  const sy = source.height > 0.5 ? box.height / source.height : 1;
  return [sx, 0, 0, sy, box.x - sx * source.x, box.y - sy * source.y];
}

export function drawingBoxResult(source: Box, matrix: number[]): Box {
  return {
    x: matrix[0] * source.x + matrix[4],
    y: matrix[3] * source.y + matrix[5],
    width: matrix[0] * source.width,
    height: matrix[3] * source.height,
  };
}

export function sameBox(a: Box, b: Box, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}
