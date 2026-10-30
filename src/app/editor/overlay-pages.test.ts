import { describe, expect, it } from 'vitest';
import { pageOverlayGroups, restoreOverlayPages, snapshotOverlayItems } from './overlay-pages';
import type { DrawnPath, FloatingImage, FloatingText } from './types';

const text = (id: string, pageKey: string): FloatingText => ({ id, pageKey, pdfX: 10, pdfY: 20, text: id, fontSize: 12, fontFamily: 'Helvetica', color: '#000000' });
const image = (id: string, pageKey: string): FloatingImage => ({ id, pageKey, pdfX: 10, pdfY: 20, pdfWidth: 5, pdfHeight: 5, dataUrl: 'data:image/png;base64,AA==' });
const path = (id: string, pageKey: string): DrawnPath => ({ id, pageKey, type: 'draw', color: '#000000', size: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });

describe('page-owned overlays', () => {
  it('groups text, images and drawings by stable page reference after reordering', () => {
    const overlays = { drawnPaths: [path('stroke', 'one')], floatingTexts: [text('first', 'one'), text('second', 'two')], floatingImages: [image('image', 'one')] };
    const groups = pageOverlayGroups(overlays, ['two', 'one']);
    expect(groups.get(0)).toEqual({ drawnPaths: [], floatingTexts: [overlays.floatingTexts[1]], floatingImages: [] });
    expect(groups.get(1)).toEqual({ drawnPaths: overlays.drawnPaths, floatingTexts: [overlays.floatingTexts[0]], floatingImages: overlays.floatingImages });
  });

  it('refuses an orphaned overlay before a commit can start', () => {
    expect(() => pageOverlayGroups({ drawnPaths: [], floatingTexts: [text('lost', 'deleted')], floatingImages: [] }, ['one']))
      .toThrow(/no longer exists/);
  });

  it('retains legacy recovery data as unassigned when its original page is unknown', () => {
    const oldText = { ...text('old', 'one'), pageKey: undefined } as unknown as FloatingText;
    const restored = restoreOverlayPages({ drawnPaths: [], floatingTexts: [oldText, text('new', 'two')], floatingImages: [] }, null);
    expect(restored.floatingTexts.map(item => item.pageKey)).toEqual(['', 'two']);
    expect(restored.floatingTexts[0].text).toBe('old');
    expect(() => pageOverlayGroups(restored, ['one', 'two'])).toThrow(/assign each recovered overlay/i);
    expect(restoreOverlayPages({ drawnPaths: [], floatingTexts: [oldText], floatingImages: [] }, 'one').floatingTexts[0].pageKey).toBe('one');
  });

  it('detects concurrent edits and removals while allowing new items', () => {
    const before = [text('first', 'one')];
    const matches = snapshotOverlayItems(before);
    expect(matches([...before, text('new', 'two')])).toBe(true);
    expect(matches([{ ...before[0], text: 'edited while saving' }])).toBe(false);
    expect(matches([])).toBe(false);
  });
});
