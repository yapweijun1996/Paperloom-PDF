/** Synthetic history-memory baseline. Run with:
 * node --expose-gc node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-history.ts
 * The measurements are process-wide approximations, not browser heap limits.
 */
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF, getPageContentBytes } from '../src/engine/parser/parser';
import { captureHistoryEntry, EditorHistory } from '../src/engine/editing/editor-history';
import { DocumentSession } from '../src/engine/session/document-session';

async function fixture(pageCount: number, imageHeavy: boolean) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let image;
  if (imageHeavy) {
    const canvas = createCanvas(512, 512);
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(512, 512);
    let state = 123456789;
    for (let i = 0; i < pixels.data.length; i += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = state >>> 24;
      pixels.data[i + 1] = state >>> 16;
      pixels.data[i + 2] = state >>> 8;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    image = await pdf.embedPng(canvas.toBuffer('image/png'));
  }
  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage([612, 792]);
    if (image) page.drawImage(image, { x: 50, y: 150, width: 512, height: 512 });
    for (let line = 0; line < 16; line++) {
      page.drawText(`Page ${index + 1} line ${line + 1}: history baseline`, { x: 20, y: 750 - line * 30, size: 11, font });
    }
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, doc: await parsePDF(bytes) };
}

async function measure(pages: number, imageHeavy: boolean) {
  const { bytes, doc } = await fixture(pages, imageHeavy);
  const content = getPageContentBytes(doc.pages[0], doc.objects);
  const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };
  global.gc?.();
  const before = process.memoryUsage();
  const history = new EditorHistory();
  let entryContentBytes = 0;
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    const entry = captureHistoryEntry(doc, 0, content, overlays, `edit-${i}`);
    entryContentBytes += entry.contentBytes.length + (entry.pages?.reduce((sum, page) => sum + page.contentBytes.length, 0) ?? 0);
    history.push(entry);
  }
  const captureMs = performance.now() - start;
  if (!history.undo() || !history.redo()) throw new Error('History round trip failed');
  global.gc?.();
  const afterEntries = process.memoryUsage();
  const session = new DocumentSession(bytes);
  const byteStart = performance.now();
  for (let i = 0; i < 10; i++) session.snapshot(`edit-${i}`, bytes);
  const byteSnapshotMs = performance.now() - byteStart;
  const restored = session.undo();
  const redone = session.redo();
  if (!restored || !redone || Buffer.compare(restored, bytes) || Buffer.compare(redone, bytes)) throw new Error('Byte history round trip failed');
  global.gc?.();
  const afterBytes = process.memoryUsage();
  console.log(JSON.stringify({ pages, imageHeavy, pdfBytes: bytes.length, entries: 10,
    captureMs: +captureMs.toFixed(1), byteSnapshotMs: +byteSnapshotMs.toFixed(1), entryContentBytes,
    entryHeapDelta: afterEntries.heapUsed - before.heapUsed,
    entryArrayBufferDelta: afterEntries.arrayBuffers - before.arrayBuffers,
    byteHeapDelta: afterBytes.heapUsed - afterEntries.heapUsed,
    byteArrayBufferDelta: afterBytes.arrayBuffers - afterEntries.arrayBuffers }));
}

if (!global.gc) throw new Error('Run with --expose-gc for comparable measurements');
for (const [pages, imageHeavy] of [[10, false], [200, false], [10, true], [100, true]] as const) {
  await measure(pages, imageHeavy);
}
