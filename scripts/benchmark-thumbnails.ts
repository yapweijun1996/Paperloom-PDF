/** Synthetic thumbnail baseline. Run with:
 * node node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-thumbnails.ts
 * Native canvas in Node approximates rendering work; it is not a browser benchmark.
 */
import { performance } from 'node:perf_hooks';
import { createCanvas, ImageData } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF } from '../src/engine/parser/parser';
import { renderPage } from '../src/engine/render/renderer';
import { generateThumbnails } from '../src/app/editor/thumbnail-generation';

Object.assign(globalThis, {
  ImageData,
  document: { createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
    return Object.assign(createCanvas(1, 1), { style: {} });
  } },
  OffscreenCanvas: function (width: number, height: number) { return createCanvas(width, height); },
});

async function fixture(pageCount: number, imageHeavy: boolean) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let image;
  if (imageHeavy) {
    const canvas = createCanvas(512, 512);
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(512, 512);
    let state = 123456789;
    for (let i = 0; i < pixels.data.length; i += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = state >>> 24; pixels.data[i + 1] = state >>> 16; pixels.data[i + 2] = state >>> 8; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    image = await pdf.embedPng(canvas.toBuffer('image/png'));
  }
  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage([612, 792]);
    if (image) page.drawImage(image, { x: 50, y: 150, width: 512, height: 512 });
    for (let line = 0; line < 16; line++) page.drawText(`Page ${index + 1} line ${line + 1}: thumbnail baseline`, { x: 20, y: 750 - line * 30, size: 11, font });
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, doc: await parsePDF(bytes) };
}

async function measure(pages: number, imageHeavy: boolean) {
  const { bytes, doc } = await fixture(pages, imageHeavy);
  const render = async (index: number) => {
    const result = await renderPage(doc, index, { scale: 0.15, devicePixelRatio: 1, renderText: true, renderPaths: true, renderImages: true, renderWidgets: true });
    const canvas = result.canvas as unknown as ReturnType<typeof createCanvas>;
    if (imageHeavy && index === 0) {
      const pixel = canvas.getContext('2d').getImageData(40, 70, 1, 1).data;
      if (pixel[0] > 245 && pixel[1] > 245 && pixel[2] > 245) throw new Error('Image fixture did not render');
    }
    return canvas.toDataURL('image/jpeg', 0.6);
  };
  async function run(batched: boolean) {
    const start = performance.now();
    let eventDelayMs = 0;
    const timer = new Promise<void>(resolve => setTimeout(() => { eventDelayMs = performance.now() - start; resolve(); }, 0));
    let images: string[] | null;
    if (batched) images = await generateThumbnails(pages, render, () => false);
    else {
      images = [];
      for (let index = 0; index < pages; index++) images.push(await render(index));
    }
    const elapsedMs = performance.now() - start;
    await timer;
    return { images: images!, elapsedMs: +elapsedMs.toFixed(1), timerDelayMs: +eventDelayMs.toFixed(1) };
  }
  const old = await run(false);
  const batched = await run(true);
  if (old.images.some((image, index) => image !== batched.images[index])) throw new Error('Batched thumbnails changed output');
  console.log(JSON.stringify({ pages, imageHeavy, pdfBytes: bytes.length,
    oldMs: old.elapsedMs, oldTimerDelayMs: old.timerDelayMs,
    batchedMs: batched.elapsedMs, batchedTimerDelayMs: batched.timerDelayMs,
    totalDataUrlCharacters: batched.images.reduce((sum, image) => sum + image.length, 0) }));
}

for (const [pages, imageHeavy] of [[10, false], [200, false], [10, true], [100, true]] as const) await measure(pages, imageHeavy);
