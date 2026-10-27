import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFName, type PDFDocumentData } from '@/engine/types';
import * as parser from '@/engine/parser/parser';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { EditorDocumentOwner } from './document-owner';

function document(): PDFDocumentData {
  return { objects: new Map() } as PDFDocumentData;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

afterEach(() => vi.restoreAllMocks());

describe('editor document owner', () => {
  it('invalidates leases even when the same document is replaced again', () => {
    const owner = new EditorDocumentOwner();
    const doc = document();
    owner.replace(doc);
    const old = owner.lease(doc);
    expect(old.isCurrent()).toBe(true);
    owner.replace(null);
    owner.replace(doc);
    expect(old.isCurrent()).toBe(false);
    expect(owner.lease(doc).isCurrent()).toBe(true);
  });

  it('runs edits in order and keeps the queue usable after failure', async () => {
    const owner = new EditorDocumentOwner();
    const doc = document();
    owner.replace(doc);
    const gate = deferred();
    const order: number[] = [];
    const first = owner.enqueue(doc, () => null, async () => {
      order.push(1);
      await gate.promise;
      throw new Error('expected failure');
    });
    const second = owner.enqueue(doc, () => null, async () => { order.push(2); });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);
    gate.release();
    await expect(first).rejects.toThrow('expected failure');
    await second;
    await owner.whenIdle();
    expect(order).toEqual([1, 2]);
  });

  it('waits for work added while waiting for the queue to become idle', async () => {
    const owner = new EditorDocumentOwner();
    const doc = document();
    owner.replace(doc);
    const firstGate = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();
    const first = owner.enqueue(doc, () => null, async () => { await firstGate.promise; });
    let idle = false;
    const wait = owner.whenIdle().then(() => { idle = true; });
    const second = owner.enqueue(doc, () => null, async () => {
      secondStarted.release();
      await secondGate.promise;
    });
    firstGate.release();
    await first;
    await secondStarted.promise;
    expect(idle).toBe(false);
    secondGate.release();
    await second;
    await wait;
    expect(idle).toBe(true);
  });

  it('rejects work queued for a replaced document, including shared object maps', async () => {
    const owner = new EditorDocumentOwner();
    const doc = document();
    owner.replace(doc);
    const gate = deferred();
    const started = deferred();
    const first = owner.enqueue(doc, () => null, async () => { started.release(); await gate.promise; });
    await started.promise;
    let ran = false;
    const second = owner.enqueue(doc, () => null, async () => { ran = true; });
    owner.replace({ ...doc });
    gate.release();
    await first;
    await expect(second).rejects.toThrow('replaced');
    expect(ran).toBe(false);
    const current = { ...doc };
    owner.replace(current);
    await owner.enqueue(current, () => null, async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('detects replacement while an edit or annotation wait is pending', async () => {
    const owner = new EditorDocumentOwner();
    const doc = document();
    owner.replace(doc);
    const gate = deferred();
    let entered = false;
    const pending = owner.enqueue(doc, () => gate.promise, async () => { entered = true; });
    owner.replace(document());
    gate.release();
    await expect(pending).rejects.toThrow('replaced');
    expect(entered).toBe(false);

    owner.replace(doc);
    const operationGate = deferred();
    const started = deferred();
    const edit = owner.enqueue(doc, () => null, async isCurrent => {
      started.release();
      await operationGate.promise;
      expect(isCurrent()).toBe(false);
    });
    await started.promise;
    owner.replace(document());
    operationGate.release();
    await edit;
  });

  it('does not publish a staged PDF edit after a shallow document replacement', async () => {
    const doc = await parser.parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
    ]));
    const owner = new EditorDocumentOwner();
    owner.replace(doc);
    const gate = deferred();
    const started = deferred();
    const edit = owner.enqueue(doc, () => null, async isCurrent => {
      await new SessionDocumentEditor().edit(doc, 'test', async staged => {
        staged.catalog.set('StagedEdit', new PDFName('Pending'));
        started.release();
        await gate.promise;
      }, { isCurrent });
    });
    await started.promise;
    const replacement = { ...doc };
    owner.replace(replacement);
    gate.release();
    await expect(edit).rejects.toThrow('Document changed');
    expect(replacement.objects).toBe(doc.objects);
    expect(replacement.catalog.get('StagedEdit')).toBeUndefined();
  });

  it.each(['undo', 'redo'] as const)('does not publish %s after a document replacement during parsing', async direction => {
    const doc = await parser.parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
    ]));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'test', async staged => { staged.catalog.set('Edited', new PDFName('Yes')); });
    if (direction === 'redo') expect(await editor.undo(doc)).toBe(true);
    const owner = new EditorDocumentOwner();
    owner.replace(doc);
    const gate = deferred();
    const started = deferred();
    const originalParse = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async bytes => {
      started.release();
      await gate.promise;
      return originalParse(bytes);
    });
    const operation = owner.enqueue(doc, () => null, isCurrent => editor[direction](doc, isCurrent).then(() => {}));
    await started.promise;
    const replacement = { ...doc };
    owner.replace(replacement);
    gate.release();
    await expect(operation).rejects.toThrow('Document changed during history restoration');
    expect(replacement.catalog.getName('Edited')).toBe(direction === 'undo' ? 'Yes' : undefined);
    expect(direction === 'undo' ? editor.canUndo : editor.canRedo).toBe(true);
  });
});
