import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFString, type PDFDocumentData } from '@/engine/types';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { createVisualSignature, updateSignature } from '@/engine/signatures/visual/signature-model';
import { EditorDocumentOwner } from './document-owner';
import { runSignatureChange } from './signature-change';
import { resizeSignatureByStep, rotateSignatureByStep } from './signature-touch-steps';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('queued signature touch and keyboard steps', () => {
  it('applies rapid rotation and resize increments to the latest queued signature', async () => {
    const doc = {} as PDFDocumentData, owner = new EditorDocumentOwner();
    owner.replace(doc);
    const signature = createVisualSignature({ pageIndex: 0, x: 100, y: 100, width: 160, height: 60,
      appearanceId: 'test', appearanceType: 'typed' });
    let current = [signature];
    const publish = vi.fn();
    const enqueue = (apply: (isCurrent: () => boolean) => Promise<void>) => owner.enqueue(doc, () => null, apply);
    const gate = deferred(), started = deferred();
    const first = enqueue(async () => { started.release(); await gate.promise; });
    await started.promise;
    const run = (update: (values: typeof current) => typeof current) => runSignatureChange({
      enqueue, current: () => current, update,
      apply: async (_previous, next) => { current = next; publish(next); },
    });
    const step = { handle: 'e' as const, dx: 1, dy: 0, free: false, local: true };
    const edits = [
      run(items => updateSignature(items, signature.id, value => rotateSignatureByStep(value, 15))),
      run(items => updateSignature(items, signature.id, value => rotateSignatureByStep(value, 15))),
      run(items => updateSignature(items, signature.id, value => resizeSignatureByStep(value, step))),
      run(items => updateSignature(items, signature.id, value => resizeSignatureByStep(value, step))),
    ];
    expect(current[0]).toBe(signature);
    gate.release();
    await first;
    expect(await Promise.all(edits)).toEqual([true, true, true, true]);
    expect(current[0].rotation).toBe(30);
    expect(current[0].width).toBeCloseTo(162, 8);
    expect(current[0].height).toBeCloseTo(60, 8);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it('does not apply or publish a queued step if the latest signature is locked', async () => {
    const doc = {} as PDFDocumentData, owner = new EditorDocumentOwner();
    owner.replace(doc);
    const signature = createVisualSignature({ pageIndex: 0, x: 100, y: 100, appearanceId: 'test', appearanceType: 'typed' });
    let current = [signature];
    const gate = deferred(), started = deferred(), publish = vi.fn();
    const enqueue = (apply: (isCurrent: () => boolean) => Promise<void>) => owner.enqueue(doc, () => null, apply);
    const first = enqueue(async () => { started.release(); await gate.promise; current = [{ ...signature, locked: true }]; });
    await started.promise;
    const pending = runSignatureChange({ enqueue, current: () => current,
      update: items => updateSignature(items, signature.id, value => rotateSignatureByStep(value, 15)),
      apply: async (_previous, next) => { current = next; publish(next); } });
    gate.release();
    await first;
    expect(await pending).toBe(false);
    expect(current[0].rotation).toBe(signature.rotation);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not mutate, dirty or add history for irrelevant-axis and minimum-size steps', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Annots [5 0 R] >>',
      '<< /Type /XObject /Subtype /Form /BBox [0 0 8 16] /Resources << >> /Length 0 >>\nstream\nendstream',
      '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [96 92 104 108] /F 4 /AP << /N 4 0 R >> >>',
    ]));
    const signature = createVisualSignature({ pageIndex: 0, x: 100, y: 100, width: 8, height: 16,
      appearanceId: 'test', appearanceType: 'typed' });
    const widget = doc.objects.get('5_0') as PDFDict;
    widget.set('PaperloomSignatureId', new PDFString(signature.id));
    const before = await serializeDocument(doc), owner = new EditorDocumentOwner(), publish = vi.fn();
    owner.replace(doc);
    const current = [signature];
    const run = (handle: 'n' | 'w', dx: number) => runSignatureChange({
      enqueue: apply => owner.enqueue(doc, () => null, apply), current: () => current,
      update: items => updateSignature(items, signature.id, value => resizeSignatureByStep(value, { handle, dx, dy: 0, free: false })),
      apply: async () => { publish(); },
    });
    expect(await run('n', 1)).toBe(false);
    expect(await run('w', 1)).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(widget.getName('Subtype')).toBe('Widget');
    expect(widget.has('AP')).toBe(true);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
