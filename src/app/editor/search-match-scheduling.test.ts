import { PDFDocument } from 'pdf-lib';
import { expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFDict, PDFName, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, SearchChangedError, SearchResultLimitError, replaceSearchMatches, searchDocument } from './search-index';

async function fixture(lengths: number[]) {
  const source = await PDFDocument.create();
  lengths.forEach(() => source.addPage([500, 500]));
  let doc = await parsePDF(await source.save({ useObjectStreams: false }));
  for (let i = 0; i < lengths.length; i++) {
    const page = doc.pages[i];
    page.resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    await updatePageContent(page.contentRefs,
      new TextEncoder().encode(`BT /F1 12 Tf (${'A'.repeat(lengths[i])}) Tj ET`), doc.objects, false);
  }
  doc = await parsePDF(await serializeDocument(doc));
  return doc;
}

it('yields within one page while preserving every ordered match', async () => {
  const doc = await fixture([20_000]), publish = vi.fn(), yieldControl = vi.fn(async () => {});
  const result = await searchDocument(doc, 'A', true, '1', new DocumentSearchIndex(), engine,
    () => true, yieldControl, 0, publish);
  expect(yieldControl.mock.calls.length).toBeGreaterThan(1);
  expect(result).toHaveLength(20_000);
  expect(result?.map(match => match.start)).toEqual(Array.from({ length: 20_000 }, (_, index) => index));
  expect(publish).toHaveBeenCalledExactlyOnceWith(result);
}, 30_000);

it('cancels during a single page without publishing a partial result', async () => {
  const doc = await fixture([20_000]), publish = vi.fn();
  let current = true;
  const result = await searchDocument(doc, 'A', true, '1', new DocumentSearchIndex(), engine,
    () => current, async () => { current = false; }, 0, publish);
  expect(result).toBeNull();
  expect(publish).not.toHaveBeenCalled();
}, 30_000);

it('does not publish when another search takes ownership during a page', async () => {
  const doc = await fixture([20_000]), index = new DocumentSearchIndex(), publish = vi.fn();
  let started = false;
  await expect(searchDocument(doc, 'A', true, '1', index, engine, () => true, async () => {
    if (started) return;
    started = true;
    expect(await searchDocument(doc, 'B', true, '1', index, engine, () => true,
      async () => {}, Infinity)).toEqual([]);
  }, 0, publish)).rejects.toBeInstanceOf(SearchChangedError);
  expect(started).toBe(true);
  expect(publish).not.toHaveBeenCalled();
}, 30_000);

it('uses the private snapshot if page bytes change and are restored during a yield', async () => {
  const doc = await fixture([20_000]), page = doc.pages[0];
  const stream = doc.objects.get(page.contentRefs[0].toKey());
  expect(stream).toBeInstanceOf(PDFStream);
  const bytes = (stream as PDFStream).rawBytes;
  const offset = bytes.indexOf('A'.charCodeAt(0));
  expect(offset).toBeGreaterThanOrEqual(0);
  let changed = false, restored = false;
  const result = await searchDocument(doc, 'A', true, '1', new DocumentSearchIndex(), engine, () => true,
    async () => {
      if (!changed) { changed = true; bytes[offset] = 'B'.charCodeAt(0); }
      else if (!restored) { restored = true; bytes[offset] = 'A'.charCodeAt(0); }
    }, 0);
  expect(changed && restored).toBe(true);
  expect(result).toHaveLength(20_000);
  expect(result?.every(match => match.matchedText === 'A')).toBe(true);
}, 30_000);

it('retains complete results at the limit and rejects the next match across pages', async () => {
  const exact = await fixture([20_000, 15_000, 15_000]);
  const result = await searchDocument(exact, 'A', true, '1', new DocumentSearchIndex(), engine,
    () => true, async () => {}, Infinity);
  expect(result).toHaveLength(50_000);
  expect(result?.at(-1)).toMatchObject({ pageIndex: 2, start: 14_999 });

  const excessive = await fixture([20_000, 15_000, 15_001]), publish = vi.fn();
  await expect(searchDocument(excessive, 'A', true, '1', new DocumentSearchIndex(), engine,
    () => true, async () => {}, Infinity, publish)).rejects.toThrow('Search has more than 50,000 matches. Narrow the search.');
  expect(publish).not.toHaveBeenCalled();
  await expect(searchDocument(excessive, 'A', true, '1', new DocumentSearchIndex(), engine,
    () => true, async () => {}, Infinity)).rejects.toBeInstanceOf(SearchResultLimitError);
}, 30_000);


it('does not mutate any page when Replace All exceeds the result limit', async () => {
  const doc = await fixture([1, 25_000, 25_000]);
  const before = await serializeDocument(doc);
  await expect(replaceSearchMatches(doc, 'A', 'B', true, engine)).rejects.toBeInstanceOf(SearchResultLimitError);
  expect(await serializeDocument(doc)).toEqual(before);
}, 30_000);
