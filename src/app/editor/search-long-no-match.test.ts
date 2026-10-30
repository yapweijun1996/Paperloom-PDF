import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { PDFDict, PDFName, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('A', { x: 10, y: 100, size: 12, font });
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

function withText(text: string) {
  return { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
    const entries = engine.extractPageTextRuns(...args);
    return [{ ...entries[0], run: { ...entries[0].run, text, glyphs: [], actualText: true } }];
  } };
}

it('yields and cancels during a long single-run scan without matches', async () => {
  const doc = await fixture(), publish = vi.fn();
  let current = true, yields = 0;
  const result = await searchDocument(doc, 'NEVER', true, 'same', new DocumentSearchIndex(), withText('A'.repeat(2_000_000)),
    () => current, async () => { yields++; current = false; }, 0, publish);
  expect(yields).toBeGreaterThan(0);
  expect(result).toBeNull();
  expect(publish).not.toHaveBeenCalled();
}, 30000);

it('preserves literal Unicode matches and global non-overlap at scan boundaries', async () => {
  const doc = await fixture();
  const prefix = 'x'.repeat(8190);
  const text = prefix + '😀ſAAaa😀Kaa' + 'x'.repeat(8192) + '😀ſAAaa';
  for (const query of ['😀ſA', 'aa', 'k', '😀', 'x'.repeat(40)]) {
    for (const sensitive of [true, false]) {
      const expected = Array.from(text.matchAll(new RegExp(query, sensitive ? 'gu' : 'giu')), m => [m.index, m[0]]);
      const result = await searchDocument(doc, query, sensitive, 'same', new DocumentSearchIndex(), withText(text),
        () => true, async () => {}, 0);
      expect(result?.map(m => [m.start, m.matchedText])).toEqual(expected);
    }
  }
}, 30000);

function withAdjacentRuns(count: number) {
  return { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
    const entry = engine.extractPageTextRuns(...args)[0];
    const glyph = entry.run.glyphs[0];
    return Array.from({ length: count }, (_, i) => {
      const x = glyph.x + i * glyph.width;
      return { ...entry, runIndex: i, run: { ...entry.run, text: 'A', x, glyphs: [{ ...glyph, x }] } };
    });
  } };
}

it('yields and cancels while examining a long adjacent-run chain', async () => {
  const doc = await fixture(), publish = vi.fn();
  let current = true, yields = 0;
  const result = await searchDocument(doc, 'ZZ', true, 'same', new DocumentSearchIndex(), withAdjacentRuns(5000),
    () => current, async () => { yields++; current = false; }, 0, publish);
  expect(yields).toBeGreaterThan(0);
  expect(result).toBeNull();
  expect(publish).not.toHaveBeenCalled();
}, 30000);

it('finds every non-overlapping match across a long adjacent-run chain', async () => {
  const doc = await fixture();
  let yields = 0;
  const matches = await searchDocument(doc, 'AA', true, 'same', new DocumentSearchIndex(), withAdjacentRuns(4097),
    () => true, async () => { yields++; }, 0);
  expect(yields).toBeGreaterThan(0);
  expect(matches).toHaveLength(2048);
  expect(matches?.map(m => m.parts?.[0].runIndex)).toEqual(Array.from({ length: 2048 }, (_, i) => i * 2));
}, 30000);

it('matches the native literal RegExp for surrogate boundaries, metacharacters and long queries', async () => {
  const doc = await fixture();
  const text = 'x'.repeat(8191) + '😀.*a+aKſ\\[İ\ud800z\udc00' + 'x'.repeat(8191) + '😀.*a+aKſ\\[İ\ud800z\udc00';
  for (const query of ['😀', '\ud83d', '\ude00', '.*', 'a+a', 'K', 's', '\\[', 'i', 'x'.repeat(1024)]) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const sensitive of [true, false]) {
      const expected = Array.from(text.matchAll(new RegExp(escaped, sensitive ? 'gu' : 'giu')), m => [m.index, m[0]]);
      const result = await searchDocument(doc, query, sensitive, 'same', new DocumentSearchIndex(), withText(text),
        () => true, async () => {}, 0);
      expect(result?.map(m => [m.start, m.matchedText]), `${JSON.stringify(query)} caseSensitive=${sensitive}`).toEqual(expected);
    }
  }
}, 30000);


it('rejects a lazy dependency read during an in-page yield if the source is restored later', async () => {
  const input = await PDFDocument.create();
  for (let i = 0; i < 2; i++) input.addPage([200, 200]);
  const doc = await parsePDF(await input.save({ useObjectStreams: false }));
  for (const page of doc.pages) {
    page.resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    await updatePageContent(page.contentRefs, new TextEncoder().encode('BT /F1 12 Tf (Alpha) Tj ET'), doc.objects, false);
  }
  const imageRef = new PDFRef(9000, 0);
  doc.objects.set(imageRef.toKey(), new PDFStream(new PDFDict([['Subtype', new PDFName('Image')]]), new Uint8Array(9 * 1024 * 1024)));
  doc.pages[0].resources.set('XObject', new PDFDict([['LargeImage', imageRef]]));
  const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
  const savedRaw = stream.rawBytes.slice(), savedDecoded = stream.decodedBytes?.slice() ?? null;
  let pagesRead = 0, changed = false, restored = false;
  const wrapped = { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
    pagesRead++;
    const entries = engine.extractPageTextRuns(...args);
    return entries.map(entry => ({ ...entry, run: { ...entry.run, text: entry.run.text.repeat(2000), glyphs: [], actualText: true } }));
  } };
  const publish = vi.fn(), index = new DocumentSearchIndex();
  await expect(searchDocument(doc, 'Bravo', false, 'same', index, wrapped, () => true, async () => {
    if (!changed && pagesRead === 1) {
      changed = true;
      for (const bytes of [stream.rawBytes, stream.decodedBytes]) {
        if (!bytes) continue;
        const offset = new TextDecoder().decode(bytes).indexOf('Alpha');
        if (offset >= 0) bytes.set(new TextEncoder().encode('Bravo'), offset);
      }
    } else if (changed && !restored && pagesRead >= 2) {
      restored = true; stream.rawBytes.set(savedRaw);
      if (savedDecoded && stream.decodedBytes) stream.decodedBytes.set(savedDecoded);
    }
  }, 0, publish)).rejects.toThrow(/document changed/i);
  expect(changed && restored).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  expect(index.getCachedBytes()).toBe(0);
}, 30000);
