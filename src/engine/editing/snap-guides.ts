/**
 * Snap guides from page geometry and sibling objects.
 */

import type { SnapGuide } from './transform-editor';
import type { EditableObject } from './scene-graph';

export type { SnapGuide };

export function buildPageGuides(
  pageWidth: number,
  pageHeight: number,
  originX = 0,
  originY = 0,
): SnapGuide[] {
  return [
    { orientation: 'v', position: originX, label: 'page-left' },
    { orientation: 'v', position: originX + pageWidth / 2, label: 'page-center-x' },
    { orientation: 'v', position: originX + pageWidth, label: 'page-right' },
    { orientation: 'h', position: originY, label: 'page-bottom' },
    { orientation: 'h', position: originY + pageHeight / 2, label: 'page-center-y' },
    { orientation: 'h', position: originY + pageHeight, label: 'page-top' },
  ];
}

export function buildObjectGuides(objects: EditableObject[], excludeId?: string): SnapGuide[] {
  const guides: SnapGuide[] = [];
  for (const o of objects) {
    if (excludeId && o.id === excludeId) continue;
    const { x, y, width, height } = o.bbox;
    const id = o.id;
    guides.push(
      { orientation: 'v', position: x, label: `${id}-left` },
      { orientation: 'v', position: x + width / 2, label: `${id}-center-x` },
      { orientation: 'v', position: x + width, label: `${id}-right` },
      { orientation: 'h', position: y, label: `${id}-bottom` },
      { orientation: 'h', position: y + height / 2, label: `${id}-center-y` },
      { orientation: 'h', position: y + height, label: `${id}-top` },
    );
  }
  return guides;
}

export function buildAllGuides(
  pageWidth: number,
  pageHeight: number,
  objects: EditableObject[],
  excludeId?: string,
  originX = 0,
  originY = 0,
): SnapGuide[] {
  return [
    ...buildPageGuides(pageWidth, pageHeight, originX, originY),
    ...buildObjectGuides(objects, excludeId),
  ];
}

export const pageGuides = buildPageGuides;
export const objectGuides = buildObjectGuides;
export const allGuides = buildAllGuides;
