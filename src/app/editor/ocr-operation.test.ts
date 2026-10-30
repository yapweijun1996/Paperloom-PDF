import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getPageContentBytes, parsePDF } from '@/engine/parser/parser';
import { insertInvisibleTextLayer } from '@/engine/editor/invisible-text';
import type { SessionDocumentEditor } from '@/engine/session/document-edit';
import type { OcrAdapter } from '@/lib/ocr/adapter';
import { EditorDocumentOwner } from './document-owner';
import { runOcrOperation, supportsOcrPageGeometry } from './ocr-operation';

async function fixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['FIRST', 'SECOND']) pdf.addPage([200, 200]).drawText(text, { x: 20, y: 150, font });
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function content(doc: Awaited<ReturnType<typeof fixture>>, index: number) {
  return new TextDecoder().decode(getPageContentBytes(doc.pages[index], doc.objects));
}
async function setup(scale = 1, dpr = 1) {
  const doc = await fixture(), owner = new EditorDocumentOwner(), wait = gate(), started = gate();
  owner.replace(doc);
  let revision = 0, editor: SessionDocumentEditor | undefined;
  const terminate = vi.fn(async () => {});
  const image = { width: 200, height: 200 } as ImageData;
  const adapter: OcrAdapter = {
    recognize: async received => {
      expect(received).toBe(image);
      started.release();
      await wait.promise;
      return [{ text: 'RECOGNIZED', confidence: 1, bbox: { x: 20, y: 30, width: 40, height: 10 } }];
    },
    terminate,
  };
  const lease = owner.lease(doc);
  const operation = runOcrOperation({
    doc, pageKey: doc.pages[0].ref.toKey(), pageHeight: 200, mediaBoxY: 0,
    scale, dpr, image, isCurrent: lease.isCurrent, revision,
    getRevision: () => revision,
    createAdapter: async () => adapter,
    enqueue: apply => owner.enqueue(doc, () => null, apply),
    insert: insertInvisibleTextLayer,
    committed: value => { editor = value; },
  });
  await started.promise;
  return { doc, owner, wait, operation, terminate, setChanged: () => { revision++; }, getEditor: () => editor };
}

describe('OCR transaction', () => {
  it('commits the captured page and undo and redo restore its text', async () => {
    const state = await setup();
    state.wait.release();
    expect(await state.operation).toBe('applied');
    expect(content(state.doc, 0)).toContain('RECOGNIZED');
    expect(content(state.doc, 1)).not.toContain('RECOGNIZED');
    const editor = state.getEditor()!;
    expect(await editor.undo(state.doc)).toBe(true);
    expect(content(state.doc, 0)).not.toContain('RECOGNIZED');
    expect(await editor.redo(state.doc)).toBe(true);
    expect(content(state.doc, 0)).toContain('RECOGNIZED');
    expect(state.terminate).toHaveBeenCalledOnce();
  });
  it('maps pixels using the captured render scale and DPR', async () => {
    const state = await setup(1.25, 2);
    state.wait.release();
    expect(await state.operation).toBe('applied');
    expect(content(state.doc, 0)).toContain('1 0 0 1 8.00 184.00 Tm');
  });
  it('discards recognition when the document is replaced, including a shallow copy after page operations', async () => {
    const state = await setup();
    state.doc.pages.reverse();
    state.owner.replace({ ...state.doc });
    state.wait.release();
    expect(await state.operation).toBe('cancelled');
    expect(content(state.doc, 0)).not.toContain('RECOGNIZED');
    expect(content(state.doc, 1)).not.toContain('RECOGNIZED');
    expect(state.getEditor()).toBeUndefined();
    expect(state.terminate).toHaveBeenCalledOnce();
  });
  it('rejects results after an intervening edit or undo', async () => {
    const state = await setup();
    state.setChanged();
    state.wait.release();
    await expect(state.operation).rejects.toThrow('document changed during OCR');
    expect(content(state.doc, 0)).not.toContain('RECOGNIZED');
    expect(state.getEditor()).toBeUndefined();
  });
  it('rejects geometry the coordinate mapper cannot represent', async () => {
    const doc = await fixture(), page = doc.pages[0];
    expect(supportsOcrPageGeometry(page)).toBe(true);
    expect(supportsOcrPageGeometry({ ...page, rotate: 90 })).toBe(false);
    expect(supportsOcrPageGeometry({ ...page, cropBox: { ...page.cropBox, x: 1 } })).toBe(false);
    expect(supportsOcrPageGeometry({ ...page, mediaBox: { ...page.mediaBox, x: 1 } })).toBe(false);
  });
});
