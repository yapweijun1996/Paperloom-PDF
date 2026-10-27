import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFName } from '../types';
import * as parser from '../parser/parser';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';
import { EditorDocumentOwner } from '@/app/editor/document-owner';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function setup() {
  const doc = await parser.parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ]));
  const history = new SessionEditorHistory();
  const capture = (label: string) => captureHistoryEntry(doc, 0, parser.getPageContentBytes(doc.pages[0], doc.objects),
    { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
  const options = { isCurrent: () => true, applyLegacy: (draft: typeof doc, entry: ReturnType<typeof capture>) => restoreDocumentStructure(draft, entry, updatePageContent) };
  history.seed(capture('initial'));
  return { doc, history, capture, options };
}

describe('atomic toolbar history', () => {
  it('undoes and redoes a combined session boundary without losing graph state', async () => {
    const { doc, history, capture, options } = await setup();
    await updatePageContent(doc.pages[0].contentRefs, new Uint8Array(), doc.objects);
    history.seed(capture('initial'));
    const before = await serializeDocument(doc);
    const first = new SessionDocumentEditor();
    await first.edit(doc, 'first', async staged => { staged.catalog.set('First', new PDFName('Yes')); });
    history.push(capture('first'), first);
    const second = new SessionDocumentEditor();
    await second.edit(doc, 'second', async staged => { staged.catalog.set('Second', new PDFName('Yes')); });
    history.replace(capture('combined'), true, second);
    const after = await serializeDocument(doc);
    expect((await history.moveAtomic(doc, 'undo', options))?.entry.label).toBe('initial');
    expect(await serializeDocument(doc)).toEqual(before);
    expect((await history.moveAtomic(doc, 'redo', options))?.entry.label).toBe('combined');
    expect(await serializeDocument(doc)).toEqual(after);
  });

  it('publishes document version and information restored by a session boundary', async () => {
    const { doc, history, capture, options } = await setup();
    const originalVersion = doc.version;
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    history.push(capture('edit'), editor);
    doc.version = '1.4';
    doc.info.title = 'Transient metadata';
    await history.moveAtomic(doc, 'undo', options);
    expect(doc.version).toBe(originalVersion);
    expect(doc.info.title).toBeUndefined();
  });

  it('does not publish any part of a combined undo when the document changes during the second parse', async () => {
    const { doc, history, capture, options } = await setup();
    const first = new SessionDocumentEditor();
    await first.edit(doc, 'first', async staged => { staged.catalog.set('First', new PDFName('Yes')); });
    history.push(capture('first'), first);
    const second = new SessionDocumentEditor();
    await second.edit(doc, 'second', async staged => { staged.catalog.set('Second', new PDFName('Yes')); });
    history.replace(capture('combined'), true, second);
    const original = await serializeDocument(doc);
    const gate = deferred(), started = deferred();
    const parse = parser.parsePDF;
    let calls = 0;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => {
      if (++calls === 2) { started.release(); await gate.promise; }
      return parse(bytes);
    });
    let current = true;
    const undo = history.moveAtomic(doc, 'undo', { ...options, isCurrent: () => current });
    await started.promise;
    current = false;
    gate.release();
    await expect(undo).rejects.toThrow('Document changed');
    expect(await serializeDocument(doc)).toEqual(original);
    expect(history.peek()?.label).toBe('combined');
    expect(history.canUndo()).toBe(true);
    expect(first.canUndo).toBe(true);
    expect(second.canUndo).toBe(true);
  });

  it('restores a replaced history boundary while preserving a later redo', async () => {
    const { doc, history, capture, options } = await setup();
    await updatePageContent(doc.pages[0].contentRefs, new Uint8Array(), doc.objects);
    history.seed(capture('initial'));
    history.push(capture('legacy'));
    const later = new SessionDocumentEditor();
    await later.edit(doc, 'later', async staged => { staged.catalog.set('Later', new PDFName('Yes')); });
    history.push(capture('later'), later);
    const laterBytes = await serializeDocument(doc);
    expect((await history.moveAtomic(doc, 'undo', options))?.entry.label).toBe('legacy');
    const baked = new SessionDocumentEditor();
    await baked.edit(doc, 'baked', async staged => { staged.catalog.set('Baked', new PDFName('Yes')); });
    history.replace(capture('baked'), true, baked);
    const bakedBytes = await serializeDocument(doc);
    expect((await history.moveAtomic(doc, 'redo', options))?.entry.label).toBe('later');
    expect(await serializeDocument(doc)).toEqual(laterBytes);
    expect((await history.moveAtomic(doc, 'undo', options))?.entry.label).toBe('baked');
    expect(await serializeDocument(doc)).toEqual(bakedBytes);
  });

  it('preserves a concurrent live edit and history position', async () => {
    const { doc, history, capture, options } = await setup();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    history.push(capture('edit'), editor);
    const gate = deferred(), started = deferred();
    const parse = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => { started.release(); await gate.promise; return parse(bytes); });
    const undo = history.moveAtomic(doc, 'undo', options);
    await started.promise;
    doc.catalog.set('Concurrent', new PDFName('Present'));
    gate.release();
    await expect(undo).rejects.toThrow('Document changed');
    expect(doc.catalog.getName('Concurrent')).toBe('Present');
    expect(doc.catalog.getName('Edited')).toBe('Yes');
    expect(history.peek()?.label).toBe('edit');
    expect(editor.canUndo).toBe(true);
  });

  it.each(['raw bytes', 'security metadata'] as const)('detects a concurrent change to %s', async kind => {
    const { doc, history, capture, options } = await setup();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    history.push(capture('edit'), editor);
    const gate = deferred(), started = deferred();
    const parse = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => { started.release(); await gate.promise; return parse(bytes); });
    const undo = history.moveAtomic(doc, 'undo', options);
    await started.promise;
    if (kind === 'raw bytes') doc.rawBytes = new Uint8Array([1, 2, 3]);
    else doc.encryptionFileKey = new Uint8Array([4, 5, 6]);
    gate.release();
    await expect(undo).rejects.toThrow('Document changed');
    expect(doc.catalog.getName('Edited')).toBe('Yes');
    expect(history.peek()?.label).toBe('edit');
    expect(editor.canUndo).toBe(true);
    if (kind === 'raw bytes') expect(doc.rawBytes).toEqual(new Uint8Array([1, 2, 3]));
    else expect(doc.encryptionFileKey).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('does not consume a new history entry published during staging', async () => {
    const { doc, history, capture, options } = await setup();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    history.push(capture('edit'), editor);
    const gate = deferred(), started = deferred();
    const parse = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => { started.release(); await gate.promise; return parse(bytes); });
    const undo = history.moveAtomic(doc, 'undo', options);
    await started.promise;
    history.push(capture('concurrent'));
    gate.release();
    await expect(undo).rejects.toThrow('Document changed');
    expect(history.peek()?.label).toBe('concurrent');
    expect(doc.catalog.getName('Edited')).toBe('Yes');
    expect(editor.canUndo).toBe(true);
  });

  it('runs an edit queued during history restoration after the whole history step', async () => {
    const { doc, history, capture, options } = await setup();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    history.push(capture('edit'), editor);
    const owner = new EditorDocumentOwner();
    owner.replace(doc);
    const gate = deferred(), started = deferred();
    const parse = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => { started.release(); await gate.promise; return parse(bytes); });
    const undo = owner.enqueue(doc, () => null, async isCurrent => { await history.moveAtomic(doc, 'undo', { ...options, isCurrent }); });
    await started.promise;
    const edit = owner.enqueue(doc, () => null, async isCurrent => {
      await new SessionDocumentEditor().edit(doc, 'next', async staged => { staged.catalog.set('Next', new PDFName('Yes')); }, { isCurrent });
    });
    gate.release();
    await undo;
    await edit;
    expect(doc.catalog.getName('Edited')).toBeUndefined();
    expect(doc.catalog.getName('Next')).toBe('Yes');
    expect(history.peek()?.label).toBe('initial');
  });

  it('does not move history or publish when legacy restoration fails', async () => {
    const { doc, history, capture, options } = await setup();
    history.push(capture('legacy'));
    const before = await serializeDocument(doc);
    await expect(history.moveAtomic(doc, 'undo', {
      ...options,
      applyLegacy: async draft => { draft.catalog.set('Unpublished', new PDFName('Yes')); throw new Error('restore failed'); },
    })).rejects.toThrow('restore failed');
    expect(await serializeDocument(doc)).toEqual(before);
    expect(history.peek()?.label).toBe('legacy');
    expect(history.canUndo()).toBe(true);
  });

  it('discards a legacy restoration if its document is replaced while awaiting', async () => {
    const { doc, history, capture, options } = await setup();
    history.push(capture('legacy'));
    const before = await serializeDocument(doc);
    const gate = deferred(), started = deferred();
    let current = true;
    const undo = history.moveAtomic(doc, 'undo', {
      ...options,
      isCurrent: () => current,
      applyLegacy: async draft => {
        draft.catalog.set('Unpublished', new PDFName('Yes'));
        started.release();
        await gate.promise;
      },
    });
    await started.promise;
    current = false;
    gate.release();
    await expect(undo).rejects.toThrow('Document changed');
    expect(await serializeDocument(doc)).toEqual(before);
    expect(history.peek()?.label).toBe('legacy');
    expect(history.canUndo()).toBe(true);
  });
});
