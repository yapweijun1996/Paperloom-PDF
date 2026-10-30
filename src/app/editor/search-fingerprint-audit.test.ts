import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { rawPDF, installPNGEnvironment, tinyPNG } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { PDFArray, PDFDict, PDFRef, PDFStream } from '@/engine/types';
import { replaceImageXObject } from '@/engine/editor/image-editor';
import { getPageContentBytes } from '@/engine/parser/parser';
import { saveQuick } from '@/engine/writer/save-pipeline';
import { DocumentSearchIndex, replaceSearchMatches, searchDocument } from './search-index';

function stream(body: string, dict = '') { return `<< /Length ${body.length} ${dict} >>\nstream\n${body}\nendstream`; }
async function fixture() {
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Image 7 0 R /Outer 4 0 R >> /Font << /F1 5 0 R >> /Properties << /Hidden 8 0 R >> >> /Contents 6 0 R >>',
    stream('BT /F1 12 Tf 1 0 0 1 10 10 Tm (Visible Form) Tj ET /Image Do /OC /Hidden BDC BT /F1 12 Tf (Secret Form) Tj ET EMC', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> /XObject << /Image 7 0 R >> /Properties << /Hidden 8 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('q 10 0 0 10 10 10 cm /Image Do Q BT /F1 12 Tf 1 0 0 1 10 150 Tm (Visible Page) Tj ET /Outer Do'),
    stream('\x10\x20\x30', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
    '<< /Type /OCG /Name (Hidden) >>',
  ]));
  const off = new PDFRef(8, 0);
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([off])], ['D', new PDFDict([['OFF', new PDFArray([off])]])]]));
  return doc;
}
const oldEngine: typeof engine = { ...engine, interpretPage: (...args) => engine.interpretPage(...args.slice(0, 6) as Parameters<typeof engine.interpretPage>) };
const scan = (doc: Awaited<ReturnType<typeof fixture>>, mode: typeof engine, query: string) => searchDocument(doc, query, false, '1', new DocumentSearchIndex(), mode, () => true, async () => {}, Infinity);
beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('independent search version audit', () => {
  it('matches existing searchable and hidden results with shared page/Form image data', async () => {
    const doc = await fixture();
    expect(await scan(doc, engine, 'Visible')).toEqual(await scan(doc, oldEngine, 'Visible'));
    expect((await scan(doc, engine, 'Visible'))?.map(m => m.source)).toEqual(['page', 'form']);
    expect(await scan(doc, engine, 'Secret')).toEqual([]);
    expect(await scan(doc, oldEngine, 'Secret')).toEqual([]);
    const config = doc.catalog.get('OCProperties') as PDFDict;
    (config.get('D') as PDFDict).set('OFF', new PDFArray());
    expect(await scan(doc, engine, 'Secret')).toEqual(await scan(doc, oldEngine, 'Secret'));
    expect((await scan(doc, engine, 'Secret'))?.length).toBe(1);
  });

  it('replaces page text and preserves the shared image, while rejecting Form text replacement', async () => {
    const doc = await fixture();
    const image = doc.objects.get('7_0') as PDFStream;
    const bytes = new Uint8Array(image.rawBytes);
    expect(await replaceSearchMatches(doc, 'Visible Page', 'Edited Page', false, engine)).toBe(1);
    expect(image.rawBytes).toEqual(bytes);
    await expect(replaceSearchMatches(doc, 'Visible Form', 'Edited Form', false, engine)).rejects.toThrow(/Form XObject/);
    const reopened = await parsePDF(await saveQuick(doc));
    expect((reopened.objects.get('7_0') as PDFStream).rawBytes).toEqual(bytes);
    expect((await scan(reopened, engine, 'Edited Page'))?.length).toBe(1);
    expect((await scan(reopened, engine, 'Visible Form'))?.length).toBe(1);
  });

  it('cannot replace with a text-only image item while ordinary image selections retain staleness checks', async () => {
    const doc = await fixture(), page = doc.pages[0];
    const content = getPageContentBytes(page, doc.objects);
    const textOnly = engine.interpretPage(content, page, doc.objects, undefined, 0, undefined, { includeImageResourceVersions: false });
    const selection = textOnly.displayList.find(item => item.type === 'image');
    if (!selection || selection.type !== 'image') throw new Error('Expected image');
    await expect(replaceImageXObject(doc, 0, selection, tinyPNG([1, 2, 3, 255]))).rejects.toThrow(/stale|ambiguous/);
    const normal = engine.interpretPage(content, page, doc.objects).displayList.find(item => item.type === 'image');
    if (!normal || normal.type !== 'image') throw new Error('Expected image');
    expect(normal.sourceImageVersion).toBeTruthy();
    const image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes[0] ^= 1;
    await expect(replaceImageXObject(doc, 0, normal, tinyPNG([1, 2, 3, 255]))).rejects.toThrow(/stale|ambiguous/);
  });

  it('still reads a stream used both as page content and image bytes for search', async () => {
    const doc = await fixture(), page = doc.pages[0];
    const image = doc.objects.get('7_0') as PDFStream;
    const bytes = new TextEncoder().encode('BT /F1 12 Tf (SharedContent) Tj ET');
    image.rawBytes = bytes; image.decodedBytes = bytes;
    page.dict.set('Contents', new PDFRef(7, 0)); page.contentRefs = [new PDFRef(7, 0)];
    expect((await scan(doc, engine, 'SharedContent'))?.length).toBe(1);
    expect(await scan(doc, engine, 'SharedContent')).toEqual(await scan(doc, oldEngine, 'SharedContent'));
  });
});
