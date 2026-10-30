import { runInNewContext } from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

const alpha = new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET');
const bravo = new TextEncoder().encode('BT /F1 12 Tf (Bravo) Tj ET');
async function fixture(large = true) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i++) pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (const page of doc.pages) {
    page.resources.set('Font', new PDFDict([['F1', new PDFDict([['Type', new PDFName('Font')],
      ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]])]]));
    await updatePageContent(page.contentRefs, alpha, doc.objects, false);
  }
  if (large) doc.objects.set('9000_0', new PDFStream(new PDFDict(), new Uint8Array(9 * 1024 * 1024)));
  return doc;
}
async function find(doc: Awaited<ReturnType<typeof fixture>>, query: string) {
  const yields = vi.fn(async () => {}), index = new DocumentSearchIndex();
  const result = await searchDocument(doc, query, false, 'rev', index, engine, () => true, yields, 0);
  return { result, yields, index };
}

describe('independent snapshot object shape checks', () => {
  it.each([true, false])('rejects custom stream getBytes with large=%s', async large => {
    const doc = await fixture(large), ref = doc.pages[0].contentRefs[0];
    const stream = doc.objects.get(ref.toKey()) as PDFStream;
    stream.getBytes = () => bravo;
    await expect(find(doc, 'Bravo')).rejects.toThrow(/cannot safely inspect custom/i);
  });

  it('rejects a stream subclass with an overridden byte accessor', async () => {
    class CustomStream extends PDFStream { override getBytes(): Uint8Array { return bravo; } }
    const doc = await fixture(), ref = doc.pages[0].contentRefs[0];
    const old = doc.objects.get(ref.toKey()) as PDFStream;
    doc.objects.set(ref.toKey(), new CustomStream(old.dict, old.rawBytes, old.decodedBytes));
    await expect(find(doc, 'Bravo')).rejects.toThrow(/cannot safely inspect custom/i);
  });

  it('rejects an objects map with its own get method', async () => {
    const doc = await fixture(), ref = doc.pages[0].contentRefs[0], original = doc.objects.get.bind(doc.objects);
    const old = original(ref.toKey()) as PDFStream, replacement = new PDFStream(old.dict, bravo, bravo);
    Object.defineProperty(doc.objects, 'get', { value: (key: string) => key === ref.toKey() ? replacement : original(key) });
    await expect(find(doc, 'Bravo')).rejects.toThrow(/cannot safely inspect custom/i);
  });


  it('rejects a shared content stream even if the objects map hides values', async () => {
    const doc = await fixture(), ref = doc.pages[0].contentRefs[0];
    const stream = doc.objects.get(ref.toKey()) as PDFStream;
    const shared = new Uint8Array(new SharedArrayBuffer(alpha.length)); shared.set(alpha);
    stream.rawBytes = shared; stream.decodedBytes = null;
    Object.defineProperty(doc.objects, 'values', { value: function* () {} });
    const publish = vi.fn();
    await expect(searchDocument(doc, 'Alpha', false, 'rev', new DocumentSearchIndex(), engine, () => true,
      async () => {}, 0, publish)).rejects.toThrow(/shared|cannot safely inspect custom|unsupported/i);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a direct shared Form stream hidden by a custom resource dictionary iterator', async () => {
    const doc = await fixture();
    const shared = new Uint8Array(new SharedArrayBuffer(alpha.length)); shared.set(alpha);
    const formDict = new PDFDict([['Subtype', new PDFName('Form')], ['BBox', new PDFArray([0, 0, 100, 100].map(n => new PDFNumber(n)))], ['Resources', doc.pages[0].resources]]);
    const xObjects = new PDFDict([['Form', new PDFStream(formDict, shared)]]);
    Object.defineProperty(xObjects, 'values', { value: function* () {} });
    doc.pages[0].resources.set('XObject', xObjects);
    doc.objects.set('9002_0', new PDFString('x'.repeat(9 * 1024 * 1024)));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Form Do'), doc.objects, false);
    const publish = vi.fn();
    await expect(searchDocument(doc, 'Alpha', false, 'rev', new DocumentSearchIndex(), engine, () => true,
      async () => {}, 0, publish)).rejects.toThrow(/shared|cannot safely inspect custom|unsupported/i);
    expect(publish).not.toHaveBeenCalled();
  });


  it('rejects a shared stream returned only by a custom map get', async () => {
    const doc = await fixture(), ref = doc.pages[0].contentRefs[0];
    const original = doc.objects.get.bind(doc.objects), old = original(ref.toKey()) as PDFStream;
    const shared = new Uint8Array(new SharedArrayBuffer(alpha.length)); shared.set(alpha);
    const hidden = new PDFStream(old.dict, shared, shared);
    Object.defineProperty(doc.objects, 'get', { value: (key: string) => key === ref.toKey() ? hidden : original(key) });
    const publish = vi.fn();
    await expect(searchDocument(doc, 'Alpha', false, 'rev', new DocumentSearchIndex(), engine, () => true,
      async () => {}, 0, publish)).rejects.toThrow(/shared|safely inspect|unsupported/i);
    expect(publish).not.toHaveBeenCalled();
  });


  it('rejects a stream with an own rawBytes getter before reading it', async () => {
    const doc = await fixture(), stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    const raw = stream.rawBytes, getter = vi.fn(() => raw);
    Object.defineProperty(stream, 'rawBytes', { enumerable: true, configurable: true, get: getter });
    await expect(find(doc, 'Alpha')).rejects.toThrow(/cannot safely inspect custom/i);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects an own dictionary get override before searching', async () => {
    const doc = await fixture(), resource = doc.pages[0].resources;
    const original = resource.get.bind(resource);
    Object.defineProperty(resource, 'get', { value: (key: string) => original(key) });
    await expect(find(doc, 'Alpha')).rejects.toThrow(/cannot safely inspect custom/i);
  });

  it('rejects a dictionary subclass before searching', async () => {
    class CustomDict extends PDFDict { override get(key: string) { return super.get(key); } }
    const doc = await fixture(), current = doc.pages[0].resources;
    doc.pages[0].resources = new CustomDict(Array.from(current.entries()));
    await expect(find(doc, 'Alpha')).rejects.toThrow(/cannot safely inspect custom/i);
  });

  it('accepts a cross-realm plain Uint8Array and still supports caching and yielding', async () => {
    const doc = await fixture(), ref = doc.pages[0].contentRefs[0];
    const stream = doc.objects.get(ref.toKey()) as PDFStream;
    const cross = runInNewContext('new Uint8Array([66,84,32,47,70,49,32,49,50,32,84,102,32,40,65,108,112,104,97,41,32,84,106,32,69,84])') as Uint8Array;
    stream.rawBytes = cross; stream.decodedBytes = null;
    const { result, yields, index } = await find(doc, 'Alpha');
    expect(result?.map(match => match.pageIndex)).toEqual([0, 1]);
    expect(yields).toHaveBeenCalled(); expect(index.getCachedBytes()).toBeGreaterThan(0);
  });
});
