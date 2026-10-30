import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, it } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { DocumentSearchIndex, searchDocument } from './search-index';

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('A', { x: 10, y: 100, size: 12, font });
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

function withSingleRun(text: string) {
  return { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
    const entry = engine.extractPageTextRuns(...args)[0];
    return [{ ...entry, run: { ...entry.run, text, glyphs: [], actualText: true } }];
  } };
}

function withAdjacentRuns(text: string) {
  return { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
    const entry = engine.extractPageTextRuns(...args)[0];
    const glyph = entry.run.glyphs[0];
    return Array.from({ length: text.length }, (_, index) => {
      const x = glyph.x + index * glyph.width;
      return { ...entry, runIndex: index, run: { ...entry.run, text: text[index], x,
        glyphs: [{ ...glyph, x, unicode: text[index] }] } };
    });
  } };
}

const literal = (query: string, sensitive: boolean) =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu');

it('matches native literal RegExp across chunk boundaries and Unicode edge cases', async () => {
  const doc = await fixture();
  const text = 'x'.repeat(8191) + '😀KſAAAAaa.*\\[𐐀𐐨\ud800z\udc00' + 'x'.repeat(8190) +
    '😀KſAAAAaa.*\\[𐐀𐐨\ud800z\udc00';
  const queries = ['😀', '😀Kſ', 'kS', 'aa', 'AAA', '.*', '\\[', '𐐨', '\ud800', '\udc00', 'x'.repeat(1024)];
  for (const query of queries) for (const sensitive of [true, false]) {
    const expected = Array.from(text.matchAll(literal(query, sensitive)), match => [match.index, match[0]]);
    const result = await searchDocument(doc, query, sensitive, 'stable', new DocumentSearchIndex(),
      withSingleRun(text), () => true, async () => {}, 0);
    expect(result?.map(match => [match.start, match.matchedText]), `${JSON.stringify(query)} ${sensitive}`).toEqual(expected);
  }
}, 30_000);

it('matches native non-overlapping results across adjacent run and chunk boundaries', async () => {
  const doc = await fixture();
  const text = 'x'.repeat(8190) + '😀KſAAAAaa😀Kſ';
  for (const query of ['😀Kſ', 'kS', 'AAA', 'aa']) for (const sensitive of [true, false]) {
    const expected = Array.from(text.matchAll(literal(query, sensitive)), match => [match.index, match[0]]);
    const result = await searchDocument(doc, query, sensitive, 'stable', new DocumentSearchIndex(),
      withAdjacentRuns(text), () => true, async () => {}, 0);
    const actual = result?.map(match => [match.parts?.[0].runIndex, match.matchedText]);
    expect(actual, `${JSON.stringify(query)} ${sensitive}`).toEqual(expected);
  }
}, 30_000);
