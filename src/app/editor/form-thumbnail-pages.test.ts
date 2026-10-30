import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF, resolveRef } from '@/engine/parser/parser';
import { PDFArray, PDFBoolean, PDFDict, PDFRef, PDFStream } from '@/engine/types';
import { detectFormFieldsOnPage } from '@/engine/forms/detect-fields';
import { setFormFieldValue } from '@/engine/forms/apply-field';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { captureFormThumbnailSnapshot, changedFormThumbnailPages } from './form-thumbnail-pages';

async function fixture(regenerateAll = false) {
  const source = await PDFDocument.create();
  const pages = Array.from({ length: 4 }, () => source.addPage([200, 200]));
  const font = await source.embedFont(StandardFonts.Helvetica);
  const shared = source.getForm().createTextField('shared');
  shared.addToPage(pages[0], { x: 10, y: 50, width: 120, height: 30, font });
  shared.addToPage(pages[2], { x: 10, y: 50, width: 120, height: 30, font });
  shared.setText('Before');
  const other = source.getForm().createTextField('other');
  other.addToPage(pages[1], { x: 10, y: 50, width: 120, height: 30, font });
  other.setText('Other');
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  if (regenerateAll) {
    const acro = resolveRef(doc.catalog.get('AcroForm')!, doc.objects);
    if (!(acro instanceof PDFDict)) throw new Error('Missing AcroForm');
    acro.set('NeedAppearances', new PDFBoolean(true));
  }
  return doc;
}

describe('form thumbnail page tracking', () => {
  it.each([false, true])('tracks all pages whose appearances change (NeedAppearances: %s)', async regenerateAll => {
    const doc = await fixture(regenerateAll);
    const before = captureFormThumbnailSnapshot(doc);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'form', async staged => {
      const field = detectFormFieldsOnPage(staged, 0)[0];
      setFormFieldValue(staged, field, 'After');
    });
    expect(changedFormThumbnailPages(before, captureFormThumbnailSnapshot(doc))).toEqual(regenerateAll ? [0, 1, 2] : [0, 2]);
  });

  it('requires a full rebuild after page reordering', async () => {
    const doc = await fixture();
    const before = captureFormThumbnailSnapshot(doc);
    doc.pages.reverse();
    expect(changedFormThumbnailPages(before, captureFormThumbnailSnapshot(doc))).toBeNull();
  });

  it('ignores cloned indirect appearances on unrelated widgets', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 1)[0].dict;
    const appearance = widget.get('AP')!;
    const ref = new PDFRef(9999, 0);
    doc.objects.set(ref.toKey(), appearance);
    widget.set('AP', ref);
    const before = captureFormThumbnailSnapshot(doc);
    await new SessionDocumentEditor().edit(doc, 'form', async draft => {
      setFormFieldValue(draft, detectFormFieldsOnPage(draft, 0)[0], 'After');
    });
    expect(changedFormThumbnailPages(before, captureFormThumbnailSnapshot(doc))).toEqual([0, 2]);
  });

  it('ignores a cloned appearance state on an unrelated checkbox', async () => {
    const source = await PDFDocument.create();
    const pages = Array.from({ length: 2 }, () => source.addPage([200, 200]));
    const text = source.getForm().createTextField('text');
    text.addToPage(pages[0]);
    text.setText('Before');
    const checkbox = source.getForm().createCheckBox('checkbox');
    checkbox.addToPage(pages[1]);
    checkbox.check();
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    const before = captureFormThumbnailSnapshot(doc);
    await new SessionDocumentEditor().edit(doc, 'form', async draft => {
      setFormFieldValue(draft, detectFormFieldsOnPage(draft, 0)[0], 'After');
    });
    expect(changedFormThumbnailPages(before, captureFormThumbnailSnapshot(doc))).toEqual([0]);
    const checkboxBefore = captureFormThumbnailSnapshot(doc);
    await new SessionDocumentEditor().edit(doc, 'form', async draft => {
      setFormFieldValue(draft, detectFormFieldsOnPage(draft, 1)[0], false);
    });
    expect(changedFormThumbnailPages(checkboxBefore, captureFormThumbnailSnapshot(doc))).toEqual([1]);
  });

  it('detects an in-place change to an indirectly referenced appearance stream', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 1)[0].dict;
    const appearance = resolveRef(widget.get('AP')!, doc.objects);
    if (!(appearance instanceof PDFDict)) throw new Error('Missing appearance');
    const stream = resolveRef(appearance.get('N')!, doc.objects);
    if (!(stream instanceof PDFStream)) throw new Error('Missing appearance stream');
    const before = captureFormThumbnailSnapshot(doc);
    await new SessionDocumentEditor().edit(doc, 'form', async draft => {
      const edited = detectFormFieldsOnPage(draft, 1)[0].dict;
      const ap = resolveRef(edited.get('AP')!, draft.objects) as PDFDict;
      const normal = resolveRef(ap.get('N')!, draft.objects) as PDFStream;
      normal.rawBytes = new Uint8Array([...normal.rawBytes, 0x20]);
    });
    expect(changedFormThumbnailPages(before, captureFormThumbnailSnapshot(doc))).toEqual([1]);
  });


  it('bounds bytes across widgets sharing an appearance before copying each stream', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0].dict;
    const bytes = new Uint8Array(2 * 1024 * 1024);
    const slice = vi.spyOn(bytes, 'slice');
    widget.set('AP', new PDFDict([['N', new PDFStream(new PDFDict(), bytes)]]));
    doc.pages[0].dict.set('Annots', new PDFArray(Array(100).fill(widget)));
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too large');
    expect(slice.mock.calls.length).toBeGreaterThan(0);
    expect(slice.mock.calls.length).toBeLessThanOrEqual(4);
    slice.mockRestore();
  });

  it('rejects an oversized stream before copying its bytes', async () => {
    const doc = await fixture();
    const bytes = new Uint8Array(9 * 1024 * 1024);
    const slice = vi.spyOn(bytes, 'slice');
    detectFormFieldsOnPage(doc, 0)[0].dict.set('AP', new PDFStream(new PDFDict(), bytes));
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too large');
    expect(slice).not.toHaveBeenCalled();
    slice.mockRestore();
  });

  it('rejects appearance graphs that exceed the depth or node budget', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0].dict;
    let nested = new PDFArray();
    for (let i = 0; i < 140; i++) nested = new PDFArray([nested]);
    widget.set('AP', nested);
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too complex');
    widget.set('AP', new PDFArray(Array(50_000).fill(new PDFBoolean(true))));
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too complex');
  });


  it.each(['annotations', 'widget'] as const)('rejects long %s reference chains and cycles', async target => {
    const doc = await fixture();
    const originalAnnots = doc.pages[0].dict.get('Annots')!;
    const annots = resolveRef(originalAnnots, doc.objects) as PDFArray;
    const originalWidget = annots.items[0];
    const setTarget = (value: PDFRef) => {
      if (target === 'annotations') doc.pages[0].dict.set('Annots', value);
      else annots.items[0] = value;
    };
    const final = target === 'annotations' ? originalAnnots : originalWidget;
    const first = new PDFRef(20000, 0);
    for (let i = 0; i < 130; i++) doc.objects.set(new PDFRef(20000 + i, 0).toKey(), new PDFRef(20001 + i, 0));
    doc.objects.set(new PDFRef(20130, 0).toKey(), final);
    setTarget(first);
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too complex');
    doc.objects.set(first.toKey(), new PDFRef(20001, 0));
    doc.objects.set(new PDFRef(20001, 0).toKey(), first);
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Cyclic form thumbnail reference');
  });

  it('charges repeated short widget reference chains to the shared node budget', async () => {
    const doc = await fixture();
    const annots = resolveRef(doc.pages[0].dict.get('Annots')!, doc.objects) as PDFArray;
    const final = annots.items[0];
    for (let i = 0; i < 100; i++) doc.objects.set(new PDFRef(30000 + i, 0).toKey(), new PDFRef(30001 + i, 0));
    doc.objects.set(new PDFRef(30100, 0).toKey(), final);
    doc.pages[0].dict.set('Annots', new PDFArray(Array(600).fill(new PDFRef(30000, 0))));
    expect(() => captureFormThumbnailSnapshot(doc)).toThrow('Form thumbnail snapshot too complex');
  });

});
