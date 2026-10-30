/** Reproducible synthetic search benchmark. Run with:
 * PATH=/opt/homebrew/opt/node@20/bin:$PATH node --expose-gc node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-search.ts
 * Results are local Node measurements, not browser or end-user guarantees.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as engine from '../src/engine/browser-core';
import { parsePDF } from '../src/engine/parser/parser';
import { DocumentSearchIndex, searchDocument } from '../src/app/editor/search-index';

async function fixture(pages: number, kind: 'text' | 'scan') {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const scan = kind === 'scan'
    ? readFileSync(new URL('../src/engine/__tests__/golden/fixtures/nara-amendment-24-scan.jpg', import.meta.url))
    : undefined;
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const page = pdf.addPage([612, 792]);
    if (scan) {
      // Separate image objects exercise snapshot pressure typical of scans,
      // unlike embedding one shared image reference on every page.
      const image = await pdf.embedJpg(scan);
      page.drawImage(image, { x: 320, y: 30, width: 180, height: 270 });
    }
    for (let line = 0; line < 16; line++) {
      page.drawText(`Page ${pageIndex + 1} line ${line + 1}: needle quick brown fox item ${line}`, { x: 20, y: 750 - line * 30, size: 11, font });
    }
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, doc: await parsePDF(bytes) };
}

function legacy(doc: Awaited<ReturnType<typeof parsePDF>>, query: string) {
  let count = 0;
  for (const page of doc.pages) {
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    for (const run of interpreted.textRuns) count += engine.findTextOccurrences(run.text, query).length;
  }
  return count;
}

async function measure(pages: number, kind: 'text' | 'scan') {
  const { doc, bytes } = await fixture(pages, kind);
  // Warm JIT with one page to reduce first-run compilation noise.
  legacy({ ...doc, pages: doc.pages.slice(0, 1) }, 'needle');
  const baselineStart = performance.now();
  let baselineEventDelay = 0;
  const baselineEvent = new Promise<void>(resolve => setTimeout(() => { baselineEventDelay = performance.now() - baselineStart; resolve(); }, 0));
  const baselineCount = legacy(doc, 'needle');
  const baselineMs = performance.now() - baselineStart;
  await baselineEvent;
  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const index = new DocumentSearchIndex();
  const coldStart = performance.now();
  let indexedEventDelay = 0;
  const indexedEvent = new Promise<void>(resolve => setTimeout(() => { indexedEventDelay = performance.now() - coldStart; resolve(); }, 0));
  const cold = await searchDocument(doc, 'needle', false, 'fixture', index, engine, () => true);
  const coldMs = performance.now() - coldStart;
  await indexedEvent;
  if (!cold || cold.length !== baselineCount) throw new Error(`Search mismatch on ${pages} pages`);
  global.gc?.();
  const memoryAfter = process.memoryUsage();
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = await searchDocument(doc, 'needle', false, 'fixture', index, engine, () => true);
    if (!result || result.length !== baselineCount) throw new Error('Warm result mismatch');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { kind, pages, pdfBytes: bytes.length, matches: baselineCount, legacyMs: +baselineMs.toFixed(1),
    coldIndexedMs: +coldMs.toFixed(1), warmMedianMs: +timings[2].toFixed(1),
    legacyTimerDelayMs: +baselineEventDelay.toFixed(1), indexedTimerDelayMs: +indexedEventDelay.toFixed(1),
    cacheEstimateBytes: index.getCachedBytes(),
    retainedHeapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    retainedArrayBuffersDeltaBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers };
}

for (const pages of [10, 200]) console.log(JSON.stringify(await measure(pages, 'text')));
for (const pages of [10, 40]) console.log(JSON.stringify(await measure(pages, 'scan')));
