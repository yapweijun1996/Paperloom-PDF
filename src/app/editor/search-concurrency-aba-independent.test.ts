import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument, searchLatestDocument, SearchChangedError } from './search-index';

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
  return doc;
}

describe('shared search index concurrency', () => {
  it('never publishes another scan’s cached intermediate document state', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const original = stream.decodedBytes;
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    let calls = 0;
    const scan = searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {
      if (calls++ !== 0) return;
      stream.decodedBytes = bravo;
      const transient = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity);
      expect(transient).toHaveLength(1);
      stream.decodedBytes = original;
    }, 0, matches => published.push(matches));
    await expect(scan).rejects.toBeInstanceOf(SearchChangedError);
    expect(published).toEqual([]);
    const retry = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity);
    expect(retry).toEqual([]);
  });

  it('retries after a competing scan without publishing its transient cache', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const original = stream.decodedBytes;
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    let firstYield = true;
    const result = await searchLatestDocument(doc, 'Bravo', false, index, engine, () => 'same', () => true,
      async () => true, async () => {
        if (!firstYield) return;
        firstYield = false;
        stream.decodedBytes = bravo;
        expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity)).toHaveLength(1);
        stream.decodedBytes = original;
      }, 0, matches => published.push(matches));
    expect(result).toEqual([]);
    expect(published).toEqual([[]]);
  });
  it('scans its original snapshot when an edit is restored after a later yield', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const original = stream.decodedBytes;
    const index = new DocumentSearchIndex();
    let yields = 0;
    const published: unknown[] = [];
    const result = await searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {
      if (++yields === 1) stream.decodedBytes = bravo;
      if (yields === 2) stream.decodedBytes = original;
    }, 0, matches => published.push(matches));
    expect(yields).toBe(2);
    expect(result).toHaveLength(3);
    expect(published).toHaveLength(1);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity)).toEqual([]);
  });

  it('rejects an unrestored in-place change and publishes nothing', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    let mutated = false;
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {
      if (!mutated) { stream.decodedBytes!.set(bravo); mutated = true; }
    }, 0, matches => published.push(matches))).rejects.toBeInstanceOf(SearchChangedError);
    expect(published).toEqual([]);
    expect(index.getCachedBytes()).toBe(0);
    const after = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity);
    expect(after).toHaveLength(1);
  });

  it('does not publish a canceled scan and does not reuse a stale page on restart', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    let live = true;
    const result = await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => live, async () => {
      stream.decodedBytes = bravo;
      live = false;
    }, 0, matches => published.push(matches));
    expect(result).toBeNull();
    expect(published).toEqual([]);
    expect(await searchDocument(doc, 'Bravo', false, 'same', index, engine, () => true, async () => {}, Infinity)).toHaveLength(1);
  });

  it('bounds deeply nested graph inspection rather than scanning indefinitely', async () => {
    const doc = await fixture();
    let nested = new PDFArray([]);
    for (let i = 0; i < 4_100; i++) nested = new PDFArray([nested]);
    doc.catalog.set('DeepSearchProbe', nested);
    const index = new DocumentSearchIndex();
    const published: unknown[] = [];
    await expect(searchDocument(doc, 'Alpha', false, 'same', index, engine, () => true, async () => {}, 0,
      matches => published.push(matches))).rejects.toThrow(/inspection limit/i);
    expect(published).toEqual([]);
    expect(index.getCachedBytes()).toBe(0);
  });

  it('rejects a SharedArrayBuffer even when a typed-array property masks its backing buffer', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    const shared = new Uint8Array(new SharedArrayBuffer(alpha.length));
    shared.set(alpha);
    Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(alpha.length) });
    stream.decodedBytes = shared;
    const published: unknown[] = [];
    await expect(searchDocument(doc, 'Alpha', false, 'same', new DocumentSearchIndex(), engine, () => true,
      async () => {}, 0, matches => published.push(matches))).rejects.toThrow(/shared stream buffers/i);
    expect(published).toEqual([]);
  });


  it('rejects cross-realm shared buffers even if the current realm has no constructor', async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 200]);
    const sourceBytes = await source.save({ useObjectStreams: false });
    const shared = new Uint8Array(new SharedArrayBuffer(alpha.length));
    shared.set(alpha);
    try {
      vi.stubGlobal('SharedArrayBuffer', undefined);
      vi.resetModules();
      const fresh = await import('./search-index');
      const freshEngine = await import('@/engine/browser-core');
      const { parsePDF: freshParse } = await import('@/engine/parser/parser');
      const doc = await freshParse(sourceBytes);
      const { updatePageContent: freshUpdate } = await import('@/engine/editor/stream-compiler');
      await freshUpdate(doc.pages[0].contentRefs, alpha, doc.objects, false);
      const contents = doc.pages[0].contentRefs[0];
      if (!contents) throw new Error('fixture has no content stream');
      const stream = doc.objects.get(contents.toKey()) as PDFStream;
      stream.decodedBytes = shared;
      await expect(fresh.searchDocument(doc, 'Alpha', false, 'same', new fresh.DocumentSearchIndex(),
        freshEngine, () => true)).rejects.toThrow(/shared stream buffers/i);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });


  it.each(['Buffer', 'Uint8Array subclass'] as const)('accepts ordinary %s-backed stream bytes', async kind => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    class CustomBytes extends Uint8Array {}
    stream.decodedBytes = kind === 'Buffer' ? Buffer.from(alpha) : new CustomBytes(alpha);
    const matches = await searchDocument(doc, 'Alpha', false, 'same', new DocumentSearchIndex(),
      engine, () => true, async () => {}, Infinity);
    expect(matches).toHaveLength(3);
  });

});
