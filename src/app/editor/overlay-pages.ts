import type { DrawnPath, FloatingImage, FloatingText } from './types';

export interface PageOverlays {
  drawnPaths: DrawnPath[];
  floatingTexts: FloatingText[];
  floatingImages: FloatingImage[];
}

/** Older recoveries need an explicit page choice unless the document has one page. */
export function restoreOverlayPages(overlays: PageOverlays, onlyPageKey: string | null): PageOverlays {
  const restore = <T extends { pageKey: string }>(items: T[]) => items.map(item => ({
    ...item,
    pageKey: item.pageKey ?? onlyPageKey ?? '',
  }));
  return {
    drawnPaths: restore(overlays.drawnPaths),
    floatingTexts: restore(overlays.floatingTexts),
    floatingImages: restore(overlays.floatingImages),
  };
}

export function pageOverlayGroups(overlays: PageOverlays, pageKeys: string[]): Map<number, PageOverlays> {
  const groups = new Map<number, PageOverlays>();
  const add = <K extends keyof PageOverlays>(kind: K, item: PageOverlays[K][number]) => {
    if (!item.pageKey) throw new Error('Assign each recovered overlay to a page before saving.');
    const index = pageKeys.indexOf(item.pageKey);
    if (index < 0) throw new Error('An unsaved overlay belongs to a page that no longer exists.');
    let group = groups.get(index);
    if (!group) {
      group = { drawnPaths: [], floatingTexts: [], floatingImages: [] };
      groups.set(index, group);
    }
    // Each field and item come from the same array key above.
    (group[kind] as Array<PageOverlays[K][number]>).push(item);
  };
  overlays.drawnPaths.forEach(item => add('drawnPaths', item));
  overlays.floatingTexts.forEach(item => add('floatingTexts', item));
  overlays.floatingImages.forEach(item => add('floatingImages', item));
  return groups;
}

/** New edits made during an asynchronous save must remain pending. */
export function snapshotOverlayItems<T extends { id: string }>(items: T[]): (current: T[]) => boolean {
  const captured = items.map(item => ({ id: item.id, json: JSON.stringify(item) }));
  return current => captured.every(({ id, json }) => {
    const latest = current.find(item => item.id === id);
    return latest !== undefined && JSON.stringify(latest) === json;
  });
}
