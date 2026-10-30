import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument, searchLatestDocument } from './search-index';

async function fixture() {
  const input = await PDFDocument.create();
  for (let i = 0; i < 3; i++) input.addPage([200, 200]);
  const doc = await parsePDF(await input.save({ useObjectStreams: false }));
  for (const page of doc.pages) page.resources.set('Font', new PDFDict([['F1', new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
  ])]]));
  const write = (page: number, content: string) => updatePageContent(doc.pages[page].contentRefs,
    new TextEncoder().encode(`BT /F1 12 Tf (${content}) Tj ET`), doc.objects, false);
  for (let i = 0; i < 3; i++) await write(i, 'Alpha');
  const ref = new PDFRef(9000, 0), image = new PDFStream(new PDFDict([['Subtype', new PDFName('Image')]]), new Uint8Array(9 * 1024 * 1024));
  doc.objects.set(ref.toKey(), image);
  doc.pages[0].resources.set('XObject', new PDFDict([['Im', ref]]));
  return { doc, write, image };
}
const immediate = async () => {};

describe('large document search dependencies', () => {
  it('yields and reuses cached pages without copying unrelated image bytes', async () => {
    const { doc, image } = await fixture();
    const interpret = vi.fn(engine.interpretPage), index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    const original = await searchDocument(doc, 'Alpha', false, 'same', index, { ...engine, interpretPage: interpret }, () => true, yieldControl, 0);
    expect(original).toHaveLength(3); expect(yieldControl).toHaveBeenCalled();
    expect(index.getCachedBytes()).toBeGreaterThan(0); expect(interpret).toHaveBeenCalledTimes(3);
    image.rawBytes[0] = 42;
    const warm = await searchDocument(doc, 'Alpha', false, 'same', index, { ...engine, interpretPage: interpret }, () => true, immediate, 0);
    expect(warm).toEqual(original); expect(interpret).toHaveBeenCalledTimes(3);
  });

  it('bounds copied document-level encryption key bytes', async () => {
    const { doc } = await fixture();
    doc.encryptionFileKey = new Uint8Array(9 * 1024 * 1024);
    const index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, yieldControl, 0)).toHaveLength(3);
    expect(yieldControl).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
  });

  it('respects the true payload size when a stream shadows its byteLength', async () => {
    const { doc, image } = await fixture();
    Object.defineProperty(image.rawBytes, 'byteLength', { value: 0 });
    const index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, yieldControl, 0)).toHaveLength(3);
    expect(yieldControl).toHaveBeenCalled(); expect(index.getCachedBytes()).toBeGreaterThan(0);
  });

  it('rejects intermediate in-place changes and never publishes or reuses their results', async () => {
    const { doc } = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const savedRaw = stream.rawBytes.slice(), savedDecoded = stream.decodedBytes?.slice() ?? null;
    const replace = (from: string, to: string) => {
      for (const bytes of [stream.rawBytes, stream.decodedBytes]) {
        if (!bytes) continue;
        const text = new TextDecoder().decode(bytes), offset = text.indexOf(from);
        if (offset >= 0) bytes.set(new TextEncoder().encode(to), offset);
      }
    };
    const index = new DocumentSearchIndex(), published = vi.fn();
    let yields = 0;
    await expect(searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {
      if (++yields === 1) replace('Alpha', 'Bravo');
      if (yields === 2) { stream.rawBytes.set(savedRaw); if (savedDecoded) stream.decodedBytes!.set(savedDecoded); }
    }, 0, published)).rejects.toThrow(/document changed/i);
    expect(published).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toEqual([]);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
  });

  it('searches the original private stream when an object is replaced and restored between yields', async () => {
    const { doc, write } = await fixture();
    const index = new DocumentSearchIndex(), published = vi.fn();
    let yields = 0;
    const matches = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {
      if (++yields === 1) await write(1, 'Bravo');
      if (yields === 2) await write(1, 'Alpha');
    }, 0, published);
    expect(matches).toEqual([]); expect(published).toHaveBeenCalledWith([]);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toEqual([]);
  });

  it('retries a permanently changed stream and invalidates warmed cache with no revision change', async () => {
    const { doc, write } = await fixture();
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
    await write(1, 'Bravo');
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(1);
    let changed = false;
    const found = await searchLatestDocument(doc, 'Delta', false, index, engine, () => 'same', () => true,
      async () => true, async () => { if (!changed) { changed = true; await write(2, 'Delta'); } }, 0);
    expect(found?.map(match => match.pageIndex)).toEqual([2]);
  });

  it('prevents overlapping scans from sharing provisional page caches', async () => {
    const { doc, write } = await fixture();
    const index = new DocumentSearchIndex();
    let resume!: () => void, suspended!: () => void;
    const paused = new Promise<void>(resolve => { suspended = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const first = searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true,
      async () => { suspended(); await gate; }, 0);
    await paused;
    await write(1, 'Bravo');
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, Infinity)).toHaveLength(1);
    await write(1, 'Alpha'); resume();
    await expect(first).rejects.toThrow(/document changed/i);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toEqual([]);
  });

  it('keeps the stream bytes of an image reused as page content in the dependency set', async () => {
    const { doc, image } = await fixture();
    const content = new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET');
    image.rawBytes = content; image.decodedBytes = null;
    const ref = new PDFRef(9000, 0);
    doc.pages[0].dict.set('Contents', ref); doc.pages[0].contentRefs = [ref];
    doc.objects.set('9001_0', new PDFStream(new PDFDict(), new Uint8Array(9 * 1024 * 1024)));
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
    image.rawBytes.set(new TextEncoder().encode('Bravo'), 'BT /F1 12 Tf ('.length);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(1);
  });

  it('tracks a stream used both as an image and as a ToUnicode font map', async () => {
    const { doc } = await fixture();
    const cmapRef = new PDFRef(9010, 0);
    const cmap = new PDFStream(new PDFDict([['Subtype', new PDFName('Image')]]), new TextEncoder().encode(
      'begincmap\n1 beginbfchar\n<41> <0058>\nendbfchar\nendcmap'));
    doc.objects.set(cmapRef.toKey(), cmap);
    const font = ((doc.pages[0].resources.get('Font') as PDFDict).get('F1') as PDFDict);
    font.set('ToUnicode', cmapRef);
    (doc.pages[0].resources.get('XObject') as PDFDict).set('Alias', cmapRef);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('BT /F1 12 Tf (A) Tj ET'), doc.objects, false);
    const index = new DocumentSearchIndex();
    expect((await searchDocument(doc, 'X', false, 'same', index, engine, () => true, immediate, 0))?.map(m => m.pageIndex)).toEqual([0]);
    const offset = new TextDecoder().decode(cmap.rawBytes).indexOf('0058');
    cmap.rawBytes.set(new TextEncoder().encode('0059'), offset);
    expect((await searchDocument(doc, 'Y', false, 'same', index, engine, () => true, immediate, 0))?.map(m => m.pageIndex)).toEqual([0]);
    expect(await searchDocument(doc, 'X', false, 'same', index, engine, () => true, immediate, 0)).toEqual([]);
  });

  it('tracks Form payloads even when another XObject aliases the same stream', async () => {
    const { doc } = await fixture();
    const ref = new PDFRef(9020, 0);
    const stream = new PDFStream(new PDFDict([['Subtype', new PDFName('Form')],
      ['BBox', new PDFArray([0, 0, 100, 100].map(value => new PDFNumber(value)))],
      ['Resources', doc.pages[0].resources]]), new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET'));
    doc.objects.set(ref.toKey(), stream);
    const objects = doc.pages[0].resources.get('XObject') as PDFDict; objects.set('Form', ref); objects.set('Alias', ref);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Form Do'), doc.objects, false);
    const index = new DocumentSearchIndex();
    expect((await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0))?.length).toBe(3);
    const offset = new TextDecoder().decode(stream.rawBytes).indexOf('Alpha');
    stream.rawBytes.set(new TextEncoder().encode('Bravo'), offset);
    expect((await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0))?.map(m => m.pageIndex)).toEqual([0]);
  });

  it('catches a content mutation through a shared ArrayBuffer view', async () => {
    const { doc, image } = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const content = stream.getBytes();
    const buffer = new ArrayBuffer(9 * 1024 * 1024); const alias = new Uint8Array(buffer, 100, content.length); alias.set(content);
    image.rawBytes = new Uint8Array(buffer); stream.rawBytes = alias; stream.decodedBytes = null;
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
    image.rawBytes.set(new TextEncoder().encode('Bravo'), 100 + 'BT /F1 12 Tf ('.length);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(1);
  });

  it('invalidates a warmed search when only decoded content changes in place', async () => {
    const { doc } = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    stream.decodedBytes = new Uint8Array(stream.getBytes());
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
    const offset = new TextDecoder().decode(stream.decodedBytes).indexOf('Alpha');
    stream.decodedBytes.set(new TextEncoder().encode('Bravo'), offset);
    expect((await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0))?.map(match => match.pageIndex)).toEqual([1]);
  });

  it('rejects a shared buffer introduced during an intermediate yield', async () => {
    const { doc } = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const index = new DocumentSearchIndex(), published = vi.fn();
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {
      const shared = new Uint8Array(new SharedArrayBuffer(stream.rawBytes.length)); shared.set(stream.rawBytes);
      stream.rawBytes = shared;
    }, 0, published)).rejects.toThrow(/safely inspect page|shared/i);
    expect(published).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
  });

  it('uses native byte-view metadata even when a Uint8Array shadows length and buffer', async () => {
    const { doc } = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const bytes = new Uint8Array(stream.getBytes());
    Object.defineProperties(bytes, { length: { value: 0 }, byteLength: { value: 0 }, buffer: { value: new ArrayBuffer(0) } });
    stream.rawBytes = bytes; stream.decodedBytes = null;
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
    const rawView = new Uint8Array(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!.call(bytes));
    rawView.set(new TextEncoder().encode('Bravo'), new TextDecoder().decode(rawView).indexOf('Alpha'));
    expect((await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, immediate, 0))?.map(match => match.pageIndex)).toEqual([1]);
  });

  it('discards provisional cache and does not publish after cancellation', async () => {
    const { doc } = await fixture();
    const index = new DocumentSearchIndex(), published = vi.fn(); let current = true;
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => current,
      async () => { current = false; }, 0, published)).toBeNull();
    expect(published).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, immediate, 0)).toHaveLength(3);
  });

  it('falls back even if a consumer swallows the lazy stream budget error', async () => {
    const { doc } = await fixture();
    const calls = vi.fn((...args: Parameters<typeof engine.interpretPage>) => {
      const page = args[1], objects = args[2];
      const category = page.resources.get('XObject');
      if (category instanceof PDFDict) {
        const ref = category.get('Im');
        if (ref instanceof PDFRef) {
          try { void (objects.get(ref.toKey()) as PDFStream).rawBytes.length; } catch { /* Consumer ignores unavailable bytes. */ }
        }
      }
      return engine.interpretPage(...args);
    });
    const index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, { ...engine, interpretPage: calls }, () => true, yieldControl, 0)).toHaveLength(3);
    expect(yieldControl).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it('falls back before yielding when too many stream dependencies are consumed', async () => {
    const { doc } = await fixture();
    const refs: PDFRef[] = [];
    for (let i = 0; i < 16_385; i++) {
      const ref = new PDFRef(20_000 + i, 0); refs.push(ref);
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict(), new Uint8Array([32])));
    }
    doc.pages[0].contentRefs = refs;
    doc.pages[0].dict.set('Contents', new PDFArray(refs));
    const index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, yieldControl, 0)).toHaveLength(2);
    expect(yieldControl).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
  }, 20_000);

  it('falls back to a synchronous scan if a consumed stream exceeds its budget', async () => {
    const { doc } = await fixture();
    const content = new Uint8Array(9 * 1024 * 1024); content.fill(32);
    content.set(new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET'));
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    stream.rawBytes = content; stream.decodedBytes = null;
    const index = new DocumentSearchIndex(), yieldControl = vi.fn(immediate);
    expect(await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, yieldControl, 0)).toHaveLength(3);
    expect(yieldControl).not.toHaveBeenCalled(); expect(index.getCachedBytes()).toBe(0);
  }, 20_000);
});
