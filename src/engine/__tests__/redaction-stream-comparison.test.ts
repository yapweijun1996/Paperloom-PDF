import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { preparePartialGraphicsRedaction } from '../security/redaction/partial-graphics-redaction';
import { matchingStreamBytes, streamComparisonBudget } from '../security/redaction/stream-comparison';

async function fixture(count: number, bytesPerImage: number, partial = false) {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]); pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const removed = new PDFDict(), retained = new PDFDict(), nested: PDFRef[] = [];
  for (let page = 0; page < 2; page++) for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(bytesPerImage).fill(32);
    if (bytes.length) bytes[bytes.length - 1] = page === 0 ? 33 : 34;
    const ref = new PDFRef(2_000 + page * count + i, 0);
    const dict = new PDFDict([['Length', new PDFNumber(bytes.length)]]);
    if (bytes.length) {
      dict.set('Type', new PDFName('XObject')); dict.set('Subtype', new PDFName('Image'));
      dict.set('Width', new PDFNumber(bytes.length)); dict.set('Height', new PDFNumber(1));
      dict.set('ColorSpace', new PDFName('DeviceGray')); dict.set('BitsPerComponent', new PDFNumber(8));
    }
    doc.objects.set(ref.toKey(), new PDFStream(dict, bytes));
    if (page === 0) { if (partial) nested.push(ref); else removed.set(`Im${i}`, ref); }
    else retained.set(`Im${i}`, ref);
  }
  if (partial) {
    const bytes = new Uint8Array([127]);
    const ref = new PDFRef(1_500, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(1)],
      ['Width', new PDFNumber(1)], ['Height', new PDFNumber(1)], ['ColorSpace', new PDFName('DeviceGray')],
      ['BitsPerComponent', new PDFNumber(8)], ['Private', new PDFArray(nested)],
    ]), bytes));
    removed.set('Im0', ref);
    const content = new TextEncoder().encode('q 20 0 0 20 10 10 cm /Im0 Do Q\n');
    const contentRef = new PDFRef(1_501, 0);
    doc.objects.set(contentRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(content.length)]]), content));
    doc.pages[0].dict.set('Contents', contentRef);
    doc.pages[0].contentRefs = [contentRef];
  }
  for (const [page, xobjects] of [[doc.pages[0], removed], [doc.pages[1], retained]] as const) {
    page.resources = new PDFDict([['XObject', xobjects]]);
    page.dict.set('Resources', page.resources);
  }
  return parsePDF(await serializeDocument(doc));
}

describe('secure redaction stream comparison limits', () => {
  it('keeps an in-budget saved PDF with distinct long-prefix streams usable', async () => {
    const doc = await fixture(24, 32_768);
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    expect(prepareWholePageRedaction(doc).commit()).toMatchObject({ pagesCleared: 1 });
    const saved = await saveQuick(doc);
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(2);
    expect((await parsePDF(saved)).pages[0].contentRefs).toHaveLength(0);
  }, 30_000);

  it('refuses a saved PDF whose same-length streams exceed the total byte budget before mutation', async () => {
    const doc = await fixture(48, 32_768);
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/stream comparison exceeds the inspection byte limit/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30_000);

  it.each(['whole', 'partial'] as const)('bounds %s stream-pair work even for empty streams', async mode => {
    const doc = await fixture(257, 0, mode === 'partial');
    redactionEngine.markRegion(doc, 0, mode === 'partial'
      ? { x: 5, y: 5, width: 30, height: 30 }
      : { x: 0, y: 0, width: 200, height: 200 });
    const before = await serializeDocument(doc);
    const prepare = mode === 'whole' ? prepareWholePageRedaction : preparePartialGraphicsRedaction;
    expect(() => prepare(doc)).toThrow(/stream comparison exceeds the inspection pair limit/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30_000);

  it('finds copies through raw and decoded buffers, including aliased bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const stream = (raw: Uint8Array, decoded?: Uint8Array) => new PDFStream(new PDFDict(), raw, decoded ?? null);
    const budget = streamComparisonBudget;
    const refuse = (reason: string): never => { throw new Error(reason); };
    expect(matchingStreamBytes(stream(bytes), stream(bytes), budget(), refuse)).toBe(true);
    expect(matchingStreamBytes(stream(new Uint8Array([4]), bytes), stream(bytes), budget(), refuse)).toBe(true);
    expect(matchingStreamBytes(stream(bytes), stream(new Uint8Array([4]), bytes), budget(), refuse)).toBe(true);
    expect(matchingStreamBytes(stream(new Uint8Array()), stream(new Uint8Array()), budget(), refuse)).toBe(false);
    expect(matchingStreamBytes(stream(bytes), stream(new Uint8Array([1, 2, 4])), budget(), refuse)).toBe(false);
  });

  it.each(['raw', 'decoded'] as const)('refuses %s bytes changed after preparation', async changed => {
    const doc = await fixture(1, 4);
    const retained = doc.objects.get('2001_0') as PDFStream;
    const removed = doc.objects.get('2000_0') as PDFStream;
    retained.decodedBytes = new Uint8Array(retained.rawBytes);
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    const prepared = prepareWholePageRedaction(doc);
    const bytes = changed === 'raw' ? retained.rawBytes : retained.decodedBytes!;
    bytes.set(removed.rawBytes);
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/document changed/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });
});
