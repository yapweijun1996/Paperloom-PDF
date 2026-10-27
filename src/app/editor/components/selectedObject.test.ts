import { describe, expect, it } from 'vitest';
import { interpretPage, type ImageItem, type PathItem } from '@/engine/content/interpreter';
import { captureHistoryEntry, restoreDocumentStructure } from '@/engine/editing/editor-history';
import { applyObjectTransform, deleteObject } from '@/engine/editor/object-editor';
import { transformObject } from '@/engine/editing/transform-editor';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { getPageContentBytes, parsePDF } from '@/engine/parser/parser';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { SessionEditorHistory } from '@/engine/session/editor-history';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { resolveSelectedObject } from './selectedObject';
import { findImagePlacement } from './imageSelection';

async function documentWithObjects() {
  const content = 'q 40 0 0 40 10 20 cm /Im1 Do Q q 40 0 0 40 100 20 cm /Im1 Do Q 10 100 30 20 re f';
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream',
  ]));
}

describe('queued object selection', () => {
  it('deletes only the selected placement and restores it through history', async () => {
    const doc = await documentWithObjects();
    const display = () => interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).displayList;
    const images = display().filter((item): item is ImageItem => item.type === 'image');
    expect(images).toHaveLength(2);
    const selected = images[1];
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    const history = new SessionEditorHistory();
    history.seed(capture('initial'));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'delete-image', async staged => {
      const page = staged.pages[0];
      const items = interpretPage(getPageContentBytes(page, staged.objects), page, staged.objects).displayList;
      const target = resolveSelectedObject(items, selected) as ImageItem;
      expect(target.x).toBe(100);
      await deleteObject(staged, 0, {
        id: 'selected-image', kind: 'image', bbox: target,
        ctm: [target.ctm.a, target.ctm.b, target.ctm.c, target.ctm.d, target.ctm.e, target.ctm.f], source: target,
      });
    });
    history.push(capture('delete-image'), editor);
    expect(display().filter(item => item.type === 'image').map(item => item.x)).toEqual([10]);
    const move = (direction: 'undo' | 'redo') => history.moveAtomic(doc, direction, {
      isCurrent: () => true,
      applyLegacy: (draft, entry) => restoreDocumentStructure(draft, entry, updatePageContent),
    });
    await move('undo');
    expect(display().filter(item => item.type === 'image').map(item => item.x)).toEqual([10, 100]);
    await move('redo');
    expect(display().filter(item => item.type === 'image').map(item => item.x)).toEqual([10]);
  });

  it('rejects a stale image and ambiguous identical paths', async () => {
    const doc = await documentWithObjects();
    const page = doc.pages[0];
    const items = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList;
    const image = items.find((item): item is ImageItem => item.type === 'image')!;
    const path = items.find((item): item is PathItem => item.type === 'path')!;
    expect(resolveSelectedObject(items, { ...image, x: image.x + 1 })).toBeNull();
    expect(resolveSelectedObject([path, { ...path }], path)).toBeNull();
    expect(resolveSelectedObject(items, path)).toEqual(path);
  });

  it('deletes a drawing in a detached edit without removing neighboring images', async () => {
    const doc = await documentWithObjects();
    const page = doc.pages[0];
    const items = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList;
    const selected = items.find((item): item is PathItem => item.type === 'path')!;
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'delete-path', async staged => {
      const draftPage = staged.pages[0];
      const draftItems = interpretPage(getPageContentBytes(draftPage, staged.objects), draftPage, staged.objects).displayList;
      const target = resolveSelectedObject(draftItems, selected) as PathItem;
      await deleteObject(staged, 0, { id: 'selected-path', kind: 'path', bbox: target, ctm: [1, 0, 0, 1, 0, 0], source: target });
      const remaining = interpretPage(getPageContentBytes(draftPage, staged.objects), draftPage, staged.objects).displayList;
      expect(resolveSelectedObject(remaining, target)).toBeNull();
      expect(remaining.filter(item => item.type === 'image')).toHaveLength(2);
    });
    const remaining = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).displayList;
    expect(remaining.filter(item => item.type === 'path')).toHaveLength(0);
    expect(remaining.filter(item => item.type === 'image')).toHaveLength(2);
  });

  it('keeps successive image moves on the same placement with one history entry per move', async () => {
    const doc = await documentWithObjects();
    const display = () => interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).displayList;
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    const history = new SessionEditorHistory();
    history.seed(capture('initial'));
    let selected = display().filter((item): item is ImageItem => item.type === 'image')[1];
    for (let step = 0; step < 2; step++) {
      const editor = new SessionDocumentEditor();
      let moved: ImageItem | null = null;
      await editor.edit(doc, 'move-image', async staged => {
        const page = staged.pages[0];
        const items = interpretPage(getPageContentBytes(page, staged.objects), page, staged.objects).displayList;
        const target = resolveSelectedObject(items, selected) as ImageItem;
        const editable = { id: 'image', kind: 'image' as const, bbox: target,
          ctm: [target.ctm.a, target.ctm.b, target.ctm.c, target.ctm.d, target.ctm.e, target.ctm.f], source: target };
        await applyObjectTransform(staged, 0, editable, transformObject(editable, { dx: 5, dy: 0 }).ctm);
        const updated = interpretPage(getPageContentBytes(page, staged.objects), page, staged.objects).displayList;
        moved = findImagePlacement(updated, { name: target.name, x: target.x + 5, y: target.y, width: target.width, height: target.height });
        expect(moved).not.toBeNull();
      });
      selected = moved!;
      history.push(capture('move-image'), editor);
    }
    const positions = () => display().filter((item): item is ImageItem => item.type === 'image').map(item => item.x).sort((a, b) => a - b);
    const moveHistory = (direction: 'undo' | 'redo') => history.moveAtomic(doc, direction, {
      isCurrent: () => true, applyLegacy: (draft, entry) => restoreDocumentStructure(draft, entry, updatePageContent),
    });
    expect(positions()).toEqual([10, 110]);
    await moveHistory('undo'); expect(positions()).toEqual([10, 105]);
    await moveHistory('undo'); expect(positions()).toEqual([10, 100]);
    await moveHistory('redo'); await moveHistory('redo'); expect(positions()).toEqual([10, 110]);
  });

  it('restores image size and location after a staged resize', async () => {
    const doc = await documentWithObjects();
    const display = () => interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).displayList;
    const selected = display().filter((item): item is ImageItem => item.type === 'image')[1];
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    const history = new SessionEditorHistory();
    history.seed(capture('initial'));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'resize-image', async staged => {
      const page = staged.pages[0];
      const items = interpretPage(getPageContentBytes(page, staged.objects), page, staged.objects).displayList;
      const target = resolveSelectedObject(items, selected) as ImageItem;
      await applyObjectTransform(staged, 0, { id: 'image', kind: 'image', bbox: target,
        ctm: [target.ctm.a, target.ctm.b, target.ctm.c, target.ctm.d, target.ctm.e, target.ctm.f], source: target },
      [60, 0, 0, 70, 110, 30]);
      const updated = interpretPage(getPageContentBytes(page, staged.objects), page, staged.objects).displayList;
      expect(findImagePlacement(updated, { name: target.name, x: 110, y: 30, width: 60, height: 70 })).not.toBeNull();
    });
    history.push(capture('resize-image'), editor);
    const positions = () => display().filter((item): item is ImageItem => item.type === 'image')
      .map(item => [item.x, item.y, item.width, item.height]).sort((a, b) => a[0] - b[0]);
    const move = (direction: 'undo' | 'redo') => history.moveAtomic(doc, direction, {
      isCurrent: () => true, applyLegacy: (draft, entry) => restoreDocumentStructure(draft, entry, updatePageContent),
    });
    expect(positions()).toEqual([[10, 20, 40, 40], [110, 30, 60, 70]]);
    await move('undo'); expect(positions()).toEqual([[10, 20, 40, 40], [100, 20, 40, 40]]);
    await move('redo'); expect(positions()).toEqual([[10, 20, 40, 40], [110, 30, 60, 70]]);
  });
});
