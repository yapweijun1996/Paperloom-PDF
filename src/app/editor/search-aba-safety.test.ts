import { runInNewContext } from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument, searchLatestDocument } from './search-index';

const encoder = new TextEncoder();
const alpha = encoder.encode('BT /F1 12 Tf (Alpha) Tj ET');
const bravo = encoder.encode('BT /F1 12 Tf (Bravo) Tj ET');

async function fixture() {
  const source = await PDFDocument.create();
  for (let i = 0; i < 3; i++) source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  for (const page of doc.pages) {
    page.resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    await updatePageContent(page.contentRefs, alpha, doc.objects, false);
  }
  const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
  return { doc, stream };
}

describe('search snapshot safety across asynchronous yields', () => {
  it('searches a private snapshot when a page changes and is restored between yields', async () => {
    const { doc, stream } = await fixture();
    const original = stream.decodedBytes;
    const index = new DocumentSearchIndex();
    let yields = 0;
    const published: unknown[] = [];
    const result = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {
      if (++yields === 1) stream.decodedBytes = bravo;
      if (yields === 2) stream.decodedBytes = original;
    }, 0, matches => published.push(matches));
    expect(yields).toBe(2);
    expect(result).toEqual([]);
    expect(published).toEqual([[]]);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity)).toEqual([]);
  });

  it('does not cache an unversioned change and restore during a latest search', async () => {
    const { doc, stream } = await fixture();
    const original = stream.decodedBytes;
    const index = new DocumentSearchIndex();
    let yields = 0;
    const published: unknown[] = [];
    const result = await searchLatestDocument(doc, 'Bravo', false, index, engine, () => 'same', () => true,
      async () => true, async () => {
        if (++yields === 1) stream.decodedBytes = bravo;
        if (yields === 2) stream.decodedBytes = original;
      }, 0, matches => published.push(matches));
    expect(result).toEqual([]);
    expect(published).toEqual([[]]);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity)).toEqual([]);
  });

  it('bounds inspection of a large shared-object graph and never publishes partial results', async () => {
    const { doc } = await fixture();
    const repeated = new PDFName('Repeated');
    doc.catalog.set('SearchProbe', new PDFArray(Array(500_001).fill(repeated)));
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {}, 0,
      matches => published.push(matches))).rejects.toThrow(/inspection limit/i);
    expect(index.getCachedBytes()).toBe(0);
    expect(published).toEqual([]);
  });

  it('honors cancellation during shared-buffer inspection', async () => {
    const { doc } = await fixture();
    doc.catalog.set('SearchProbe', new PDFArray(Array(10_000).fill(new PDFName('Repeated'))));
    let checks = 0;
    const published: unknown[] = [];
    const result = await searchDocument(doc, 'Alpha', false, 'same', new DocumentSearchIndex(), engine,
      () => ++checks < 2, async () => {}, 0, matches => published.push(matches));
    expect(result).toBeNull();
    expect(published).toEqual([]);
  });

  it.each(['raw', 'decoded'] as const)('rejects %s shared buffers even in over-budget nested objects', async kind => {
    const { doc } = await fixture();
    const large = new PDFStream(new PDFDict(), new Uint8Array(8 * 1024 * 1024 + 1));
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    if (kind === 'raw') large.rawBytes = shared;
    else large.decodedBytes = shared;
    doc.catalog.set('SearchProbe', new PDFArray([new PDFDict([['Nested', large]])]));
    if (kind === 'raw') doc.objects.set('9000_0', new PDFStream(new PDFDict(), new Uint8Array(8 * 1024 * 1024 + 1)));
    const index = new DocumentSearchIndex();
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {}, 0))
      .rejects.toThrow(/shared stream buffers/i);
    expect(index.getCachedBytes()).toBe(0);
  });

  it('rejects a shared buffer introduced during a yield, including same-content replacements', async () => {
    const { doc, stream } = await fixture();
    const index = new DocumentSearchIndex();
    const publish: unknown[] = [];
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {
      const shared = new Uint8Array(new SharedArrayBuffer(stream.rawBytes.length));
      shared.set(stream.rawBytes);
      stream.rawBytes = shared;
    }, 0, matches => publish.push(matches))).rejects.toThrow(/shared stream buffers/i);
    expect(publish).toEqual([]);
    expect(index.getCachedBytes()).toBe(0);
  });

  it('detects buffers created in another JavaScript realm', async () => {
    const { doc, stream } = await fixture();
    const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(8))') as Uint8Array;
    stream.decodedBytes = shared;
    await expect(searchDocument(doc, 'Alpha', false, 'same', new DocumentSearchIndex(), engine, () => true))
      .rejects.toThrow(/shared stream buffers/i);
  });
});
