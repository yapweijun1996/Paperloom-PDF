import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument, searchLatestDocument } from './search-index';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]); source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  for (const page of doc.pages) page.resources.set('Font', new PDFDict([['F1', new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
  ])]]));
  const write = (page: number, content: string) => updatePageContent(doc.pages[page].contentRefs, new TextEncoder().encode(content), doc.objects, false);
  await write(0, 'BT /F1 12 Tf 1 0 0 1 10 150 Tm (Needle needle needle) Tj ET');
  await write(1, 'BT /F1 12 Tf 1 0 0 1 10 150 Tm (needle and other) Tj ET');
  return { doc, write };
}

const noYield = async () => {};

describe('document search index', () => {
  it('searches image pages without computing image edit versions', async () => {
    const { doc, write } = await fixture();
    const page = doc.pages[0];
    const imageRef = new PDFRef(500, 0);
    doc.objects.set(imageRef.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')],
    ]), new Uint8Array([1, 2, 3])));
    page.resources.set('XObject', new PDFDict([['Image', imageRef]]));
    await write(0, 'q /Image Do Q BT /F1 12 Tf 1 0 0 1 10 150 Tm (needle) Tj ET');
    const content = engine.getPageContentBytes(page, doc.objects);
    const normal = engine.interpretPage(content, page, doc.objects);
    const textOnly = engine.interpretPage(content, page, doc.objects, undefined, 0, undefined,
      { includeImageResourceVersions: false });
    const normalImage = normal.displayList.find(item => item.type === 'image');
    const textOnlyImage = textOnly.displayList.find(item => item.type === 'image');
    expect(normalImage?.type === 'image' && normalImage.sourceImageVersion).toBeTruthy();
    expect(textOnlyImage?.type).toBe('image');
    expect(textOnlyImage?.type === 'image' && textOnlyImage.sourceImageVersion).toBeUndefined();
    expect(textOnly.textRuns.map(run => run.text)).toEqual(normal.textRuns.map(run => run.text));
    const interpret = vi.fn(engine.interpretPage);
    const matches = await searchDocument(doc, 'needle', false, '1', new DocumentSearchIndex(),
      { ...engine, interpretPage: interpret }, () => true, noYield, Infinity);
    expect(matches).toHaveLength(2);
    expect(interpret.mock.calls.every(args => args[6]?.includeImageResourceVersions === false)).toBe(true);
  });

  it('matches the existing search results and reuses parsed pages on a later query', async () => {
    const { doc } = await fixture();
    const interpret = vi.fn(engine.interpretPage);
    const wrapped = { ...engine, interpretPage: interpret };
    const index = new DocumentSearchIndex();
    const matches = await searchDocument(doc, 'needle', false, '1', index, wrapped, () => true, noYield, Infinity);
    expect(matches?.map(m => [m.pageIndex, m.matchedText, m.start, m.end])).toEqual([
      [0, 'Needle', 0, 6], [0, 'needle', 7, 13], [0, 'needle', 14, 20], [1, 'needle', 0, 6],
    ]);
    expect(interpret).toHaveBeenCalledTimes(2);
    const page = doc.pages[0];
    const run = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects,
      new engine.OptionalContentVisibility(doc.catalog, doc.objects)).textRuns[0];
    expect(matches?.[0].pdfX).toBe(run.glyphs[0].x);
    expect(matches?.[0].pdfWidth).toBe(Math.max(run.glyphs[5].x + run.glyphs[5].width - run.glyphs[0].x, 3));
    const sensitive = await searchDocument(doc, 'Needle', true, '1', index, wrapped, () => true, noYield, Infinity);
    expect(sensitive?.map(m => [m.pageIndex, m.matchedText])).toEqual([[0, 'Needle']]);
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(index.getCachedBytes()).toBeGreaterThan(0);
  });

  it('invalidates cached content after an edit and never returns hidden text', async () => {
    const { doc, write } = await fixture();
    const off = new PDFRef(300, 0);
    doc.objects.set(off.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([off])], ['D', new PDFDict([['OFF', new PDFArray([off])]])]]));
    doc.pages[0].resources.set('Properties', new PDFDict([['Hidden', off]]));
    await write(0, 'BT /F1 12 Tf /OC /Hidden BDC (secret needle) Tj EMC (public needle) Tj ET');
    const index = new DocumentSearchIndex();
    expect(await searchDocument(doc, 'secret', false, '1', index, engine, () => true, noYield, Infinity)).toEqual([]);
    await write(0, 'BT /F1 12 Tf (changed text) Tj ET');
    const result = await searchDocument(doc, 'changed', false, '2', index, engine, () => true, noYield, Infinity);
    expect(result?.map(m => m.matchedText)).toEqual(['changed']);
    expect(await searchDocument(doc, 'public', false, '2', index, engine, () => true, noYield, Infinity)).toEqual([]);
  });

  it('detects external graph and decoded-content changes without an editor revision', async () => {
    const { doc, write } = await fixture();
    const index = new DocumentSearchIndex();
    expect((await searchDocument(doc, 'needle', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(4);
    await write(0, 'BT /F1 12 Tf (new content) Tj ET');
    expect((await searchDocument(doc, 'new', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(1);
    const ref = doc.pages[0].contentRefs[0];
    const stream = doc.objects.get(ref.toKey()) as PDFStream;
    stream.decodedBytes = new TextEncoder().encode('BT /F1 12 Tf (changed cache) Tj ET');
    expect((await searchDocument(doc, 'changed', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(1);
  });

  it('invalidates on direct optional-layer and undo-style graph changes without a revision change', async () => {
    const { doc, write } = await fixture();
    const off = new PDFRef(300, 0);
    doc.objects.set(off.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
    const config = new PDFDict([['OFF', new PDFArray([off])]]);
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([off])], ['D', config]]));
    doc.pages[0].resources.set('Properties', new PDFDict([['Layer', off]]));
    await write(0, 'BT /F1 12 Tf /OC /Layer BDC (needle) Tj EMC ET');
    const index = new DocumentSearchIndex();
    expect((await searchDocument(doc, 'needle', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(1);
    config.set('OFF', new PDFArray());
    expect((await searchDocument(doc, 'needle', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(2);
    config.set('OFF', new PDFArray([off]));
    expect((await searchDocument(doc, 'needle', false, 'same', index, engine, () => true, noYield, Infinity))?.length).toBe(1);
  });

  it('rejects a document changed externally while scanning instead of publishing mixed results', async () => {
    const { doc, write } = await fixture();
    const index = new DocumentSearchIndex();
    const mutate = vi.fn(async () => { await write(0, 'BT /F1 12 Tf (new content) Tj ET'); });
    await expect(searchDocument(doc, 'needle', false, 'same', index, engine, () => true, mutate, 0))
      .rejects.toThrow(/document changed during search/i);
    expect(index.getCachedBytes()).toBe(0);
  });

  it('yields and caches large graphs when their consumed streams fit the validation budget', async () => {
    const { doc } = await fixture();
    doc.objects.set('9000_0', new PDFStream(new PDFDict(), new Uint8Array(8 * 1024 * 1024 + 1)));
    const index = new DocumentSearchIndex();
    const yieldControl = vi.fn(async () => {});
    const result = await searchDocument(doc, 'needle', false, '1', index, engine, () => true, yieldControl, 0);
    expect(result).toHaveLength(4);
    expect(index.getCachedBytes()).toBeGreaterThan(0);
    expect(yieldControl).toHaveBeenCalled();
  });

  it('yields and abandons a stale query before visiting the next page', async () => {
    const { doc } = await fixture();
    let current = true;
    const interpret = vi.fn(engine.interpretPage);
    const yieldControl = vi.fn(async () => { current = false; });
    const result = await searchDocument(doc, 'needle', false, '1', new DocumentSearchIndex(),
      { ...engine, interpretPage: interpret }, () => current, yieldControl, 0);
    expect(result).toBeNull();
    expect(yieldControl).toHaveBeenCalledOnce();
    expect(interpret).toHaveBeenCalledOnce();
  });

  it('retries against a new revision when an edit occurs during a scan', async () => {
    const { doc, write } = await fixture();
    let version = 1;
    let changed = false;
    const yieldControl = vi.fn(async () => {
      if (!changed) { changed = true; await write(0, 'BT /F1 12 Tf (latest) Tj ET'); version++; }
    });
    const result = await searchLatestDocument(doc, 'latest', false, new DocumentSearchIndex(), engine,
      () => String(version), () => true, async () => true, yieldControl, 0);
    expect(result?.map(m => m.matchedText)).toEqual(['latest']);
    expect(yieldControl).toHaveBeenCalled();
  });

  it('searches the latest graph after a form commit changes the revision', async () => {
    const { doc, write } = await fixture();
    let version = 1;
    const beforePublish = vi.fn(async () => {
      if (version === 1) { await write(0, 'BT /F1 12 Tf (needle new) Tj ET'); version++; }
      return true;
    });
    const result = await searchLatestDocument(doc, 'needle', false, new DocumentSearchIndex(), engine,
      () => String(version), () => true, beforePublish, noYield, Infinity);
    expect(result?.map(m => m.runText)).toEqual(['needle new', 'needle and other']);
    expect(beforePublish).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('searches after external graph mutation in the commit callback with large graph=%s', async large => {
    const { doc, write } = await fixture();
    if (large) doc.objects.set('9000_0', new PDFStream(new PDFDict(), new Uint8Array(8 * 1024 * 1024 + 1)));
    const index = new DocumentSearchIndex();
    const result = await searchLatestDocument(doc, 'needle', false, index, engine,
      () => 'same', () => true, async () => { await write(0, 'BT /F1 12 Tf (changed) Tj ET'); return true; }, noYield, Infinity);
    expect(result?.map(match => match.pageIndex)).toEqual([1]);
    expect(index.getCachedBytes()).toBeGreaterThan(0);
  });

  it.each([false, true])('publishes before a queued graph mutation with large graph=%s', async large => {
    const { doc } = await fixture();
    if (large) doc.objects.set('9000_0', new PDFStream(new PDFDict(), new Uint8Array(8 * 1024 * 1024 + 1)));
    const events: string[] = [];
    let queued = false;
    const interpret = (...args: Parameters<typeof engine.interpretPage>) => {
      if (!queued) {
        queued = true;
        queueMicrotask(() => { doc.catalog.set('SearchTest', new PDFName('changed')); events.push('mutation'); });
      }
      return engine.interpretPage(...args);
    };
    await searchLatestDocument(doc, 'needle', false, new DocumentSearchIndex(), { ...engine, interpretPage: interpret },
      () => 'same', () => true, async () => true, noYield, Infinity,
      matches => { expect(matches).toHaveLength(4); events.push('publish'); });
    expect(events).toEqual(['publish', 'mutation']);
  });

  it('does not publish or retry after the search is cancelled', async () => {
    const { doc } = await fixture();
    let live = true;
    const beforePublish = vi.fn(async () => true);
    const result = await searchLatestDocument(doc, 'needle', false, new DocumentSearchIndex(), engine,
      () => '1', () => live, beforePublish, async () => { live = false; }, 0);
    expect(result).toBeNull();
    expect(beforePublish).toHaveBeenCalledOnce();
  });

  it('bounds retained search data and supports literal punctuation', async () => {
    const { doc, write } = await fixture();
    await write(0, 'BT /F1 12 Tf (a.b aXb a.b) Tj ET');
    const index = new DocumentSearchIndex(1);
    const result = await searchDocument(doc, 'a.b', true, '1', index, engine, () => true, noYield, Infinity);
    expect(result?.map(m => m.matchedText)).toEqual(['a.b', 'a.b']);
    expect(index.getCachedBytes()).toBe(0);
    expect(await searchDocument(doc, '', false, '1', index, engine, () => true, noYield, Infinity)).toEqual([]);
  });
});
