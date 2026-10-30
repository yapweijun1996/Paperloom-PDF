import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

async function fixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const font = new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]);
  for (const page of doc.pages) {
    page.resources.set('Font', new PDFDict([['F1', font]]));
    await updatePageContent(page.contentRefs, new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET'), doc.objects, false);
  }
  const large = new PDFRef(9000, 0);
  doc.objects.set(large.toKey(), new PDFStream(new PDFDict([['Subtype', new PDFName('Image')]]), new Uint8Array(9 * 1024 * 1024)));
  doc.pages[1].resources.set('XObject', new PDFDict([['Im', large]]));
  return { doc, large };
}

describe('independent lazy-search adversarial checks', () => {
  it('rejects a swallowed shared-buffer failure after yielding and never publishes or caches', async () => {
    const { doc, large } = await fixture();
    const source = doc.objects.get(large.toKey()) as PDFStream;
    const run = vi.fn((...args: Parameters<typeof engine.interpretPage>) => {
      const dict = args[1].resources.get('XObject');
      if (dict instanceof PDFDict) {
        const ref = dict.get('Im');
        if (ref instanceof PDFRef) try { void (args[2].get(ref.toKey()) as PDFStream).rawBytes.length; } catch { /* deliberately swallowed */ }
      }
      return engine.interpretPage(...args);
    });
    const index = new DocumentSearchIndex(), publish = vi.fn();
    let calls = 0;
    await expect(searchDocument(doc, 'Alpha', false, 'rev', index, { ...engine, interpretPage: run }, () => true,
      async () => { if (++calls === 1) source.rawBytes = new Uint8Array(new SharedArrayBuffer(9 * 1024 * 1024)); }, 0, publish))
      .rejects.toThrow(/could not safely inspect page|shared/i);
    expect(publish).not.toHaveBeenCalled();
    expect(index.getCachedBytes()).toBe(0);
  });

  it('invalidates cached form text when the shared form stream changes without a revision change', async () => {
    const { doc } = await fixture();
    const formRef = new PDFRef(9001, 0);
    const form = new PDFStream(new PDFDict([['Subtype', new PDFName('Form')],
      ['BBox', new PDFArray([0, 0, 100, 100].map(n => new PDFNumber(n)))],
      ['Resources', doc.pages[1].resources]]), new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET'));
    doc.objects.set(formRef.toKey(), form);
    for (const page of [doc.pages[1], doc.pages[2]]) {
      page.resources.set('XObject', new PDFDict([['SharedForm', formRef]]));
      await updatePageContent(page.contentRefs, new TextEncoder().encode('/SharedForm Do'), doc.objects, false);
    }
    const index = new DocumentSearchIndex();
    const search = (query: string) => searchDocument(doc, query, false, 'same', index, engine, () => true, async () => {}, 0);
    expect((await search('Alpha'))?.map(match => match.pageIndex)).toEqual([0, 1, 2]);
    form.rawBytes.set(new TextEncoder().encode('Bravo'), new TextDecoder().decode(form.rawBytes).indexOf('Alpha'));
    expect((await search('Bravo'))?.map(match => match.pageIndex)).toEqual([1, 2]);
    expect((await search('Alpha'))?.map(match => match.pageIndex)).toEqual([0]);
  });
});
