import { describe, expect, it, vi } from 'vitest';
import { parsePDF } from '@/engine/parser/parser';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { PDFDict, PDFName, PDFRef } from '@/engine/types';
import { createVisualSignature } from '@/engine/signatures/visual/signature-model';
import { renderFieldSignaturePreviews } from './field-signature-previews';

async function fixture(count: number, size = 100) {
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ]));
  const signatures = Array.from({ length: count }, (_, index) => createVisualSignature({
    pageIndex: 0, x: 100, y: 100, width: size, height: size,
    appearanceId: `library-${index}`, appearanceType: 'typed',
  }));
  const tracked = new Map(signatures.map((sig, index) => {
    const ref = new PDFRef(100 + index, 0);
    doc.objects.set(ref.toKey(), new PDFDict([['Subtype', new PDFName('Widget')]]));
    return [sig.id, ref] as const;
  }));
  return { doc, signatures, tracked };
}

const image = { canvas: { toDataURL: () => 'data:image/png;base64,preview' } };
type Renderer = Parameters<typeof renderFieldSignaturePreviews>[6];

describe('field signature preview isolation', () => {
  it('keeps other previews when an individual renderer fails', async () => {
    const { doc, signatures, tracked } = await fixture(2);
    const render = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(image);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await renderFieldSignaturePreviews(doc, 0, signatures, tracked, 1, 1, render as Renderer, () => false);
      expect(result).toEqual({ failed: true, previews: {
        [signatures[0].id]: null, [signatures[1].id]: 'data:image/png;base64,preview',
      } });
      expect(render).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it('isolates an unresolvable preview subtype from other fields', async () => {
    const { doc, signatures, tracked } = await fixture(2);
    const widget = doc.objects.get(tracked.get(signatures[0].id)!.toKey()) as PDFDict;
    const loop = new PDFRef(333, 0);
    widget.set('Subtype', loop);
    doc.objects.set(loop.toKey(), loop);
    const render = vi.fn().mockResolvedValue(image);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await renderFieldSignaturePreviews(doc, 0, signatures, tracked, 1, 1, render as Renderer, () => false);
      expect(result?.failed).toBe(true);
      expect(result?.previews[signatures[0].id]).toBeNull();
      expect(result?.previews[signatures[1].id]).toBe('data:image/png;base64,preview');
      expect(render).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it('bounds individual and combined canvas allocation', async () => {
    const { doc, signatures, tracked } = await fixture(5, 2000);
    const render = vi.fn().mockResolvedValue(image);
    const result = await renderFieldSignaturePreviews(doc, 0, signatures, tracked, 1, 1, render as Renderer, () => false);
    expect(render).toHaveBeenCalledTimes(4);
    expect(result?.failed).toBe(true);
    expect(result?.previews[signatures[4].id]).toBeNull();
    const oversized = await fixture(1, 1000);
    const skipped = vi.fn().mockResolvedValue(image);
    expect(await renderFieldSignaturePreviews(oversized.doc, 0, oversized.signatures, oversized.tracked,
      4, 2, skipped as Renderer, () => false)).toEqual({ failed: true, previews: { [oversized.signatures[0].id]: null } });
    expect(skipped).not.toHaveBeenCalled();
    const failing = vi.fn().mockRejectedValue(new Error('failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderFieldSignaturePreviews(doc, 0, signatures, tracked, 1, 1, failing as Renderer, () => false);
      expect(failing).toHaveBeenCalledTimes(4);
    } finally { log.mockRestore(); }
  });

  it('stops after an in-flight preview when the page render is cancelled', async () => {
    const { doc, signatures, tracked } = await fixture(2);
    let finish!: (value: typeof image) => void;
    const render = vi.fn(() => new Promise<typeof image>(resolve => { finish = resolve; }));
    let cancelled = false;
    const pending = renderFieldSignaturePreviews(doc, 0, signatures, tracked, 1, 1, render as Renderer, () => cancelled);
    expect(render).toHaveBeenCalledTimes(1);
    cancelled = true;
    finish(image);
    expect(await pending).toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
