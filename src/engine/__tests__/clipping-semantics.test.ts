import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { serializeDocument } from '../writer/serializer';
import { renderPage } from '../render/renderer';

const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;
afterEach(() => vi.unstubAllGlobals());

async function renderFixture(prefix: string, suffix: string | ((raw: string) => string) = '', scale = 1, text = 'MMMMMMMM') {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([220, 140]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  page.drawText(text, { x: 20, y: 50, size: 32, font });
  const source = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const raw = getPageContentBytes(source.pages[0], source.objects);
  const tail = typeof suffix === 'function' ? suffix(new TextDecoder().decode(raw)) : suffix;
  const content = new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(raw), Buffer.from(tail)]));
  await updatePageContent(source.pages[0].contentRefs, content, source.objects, false);
  const bytes = await serializeDocument(source);
  const reopened = await parsePDF(bytes);
  const directory = mkdtempSync(join(tmpdir(), 'paperloom-clip-semantics-'));
  try {
    const path = join(directory, 'fixture.pdf'), output = join(directory, 'render');
    writeFileSync(path, bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(72 * scale), '-png', path, output]);
    const reference = await loadImage(readFileSync(`${output}.png`));
    const referenceCanvas = createCanvas(reference.width, reference.height);
    referenceCanvas.getContext('2d').drawImage(reference, 0, 0);
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    vi.stubGlobal('ImageData', ImageData);
    vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
    const actual = (await renderPage(reopened, 0, { scale, devicePixelRatio: 1 })).canvas;
    expect([actual.width, actual.height]).toEqual([reference.width, reference.height]);
    return { actual, reference: referenceCanvas };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function darkPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) count++;
  return count;
}

describe('PDF clip rendering semantics', () => {
  it.skipIf(!hasPoppler)('hides text outside a non-intersecting clip, like Poppler', async () => {
    const { actual, reference } = await renderFixture('q 0 0 4 4 re W n\n', '\nQ');
    expect(darkPixels(reference.getContext('2d').getImageData(0, 0, 220, 140).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(0, 0, 220, 140).data)).toBe(0);
  });

  it.skipIf(!hasPoppler)('keeps only the visible portion of partially clipped text', async () => {
    const { actual, reference } = await renderFixture('q 20 40 40 50 re W n\n', '\nQ');
    const visible: [number, number, number, number] = [20, 50, 40, 50];
    const hidden: [number, number, number, number] = [80, 50, 130, 50];
    expect(darkPixels(reference.getContext('2d').getImageData(...visible).data)).toBeGreaterThan(30);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...visible).data)).toBeGreaterThan(30);
    expect(darkPixels(reference.getContext('2d').getImageData(...hidden).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...hidden).data)).toBe(0);
  });

  it.skipIf(!hasPoppler)('preserves content when W has no current path, as Poppler does', async () => {
    const { actual, reference } = await renderFixture('q W n\n', '\nQ');
    expect(darkPixels(reference.getContext('2d').getImageData(0, 0, 220, 140).data)).toBeGreaterThan(200);
    expect(darkPixels(actual.getContext('2d')!.getImageData(0, 0, 220, 140).data)).toBeGreaterThan(200);
  });

  it.skipIf(!hasPoppler)('treats a zero-width clipping rectangle as an empty region', async () => {
    const { actual, reference } = await renderFixture('q 20 40 0 50 re W n\n', '\nQ');
    expect(darkPixels(reference.getContext('2d').getImageData(0, 0, 220, 140).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(0, 0, 220, 140).data)).toBe(0);
  });

  it.skipIf(!hasPoppler)('honors a clip narrower than half a user-space unit', async () => {
    const { actual, reference } = await renderFixture('q 20 40 .25 50 re W n 0 0 0 rg 0 0 220 140 re f\n', '\nQ', 8);
    const visible: [number, number, number, number] = [160, 420, 2, 340];
    const hidden: [number, number, number, number] = [200, 420, 200, 340];
    expect(darkPixels(reference.getContext('2d').getImageData(...visible).data)).toBeGreaterThan(500);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...visible).data)).toBeGreaterThan(500);
    expect(darkPixels(reference.getContext('2d').getImageData(...hidden).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...hidden).data)).toBe(0);
  });

  it.skipIf(!hasPoppler)('restores the prior clip after Q', async () => {
    const { actual, reference } = await renderFixture('q 0 0 4 4 re W n\n', raw => `\nQ\nq 1 0 0 1 0 -38 cm\n${raw}\nQ`);
    const clipped: [number, number, number, number] = [15, 50, 170, 38];
    const restored: [number, number, number, number] = [15, 94, 170, 38];
    expect(darkPixels(reference.getContext('2d').getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(reference.getContext('2d').getImageData(...restored).data)).toBeGreaterThan(200);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...restored).data)).toBeGreaterThan(200);
  });

  it.skipIf(!hasPoppler)('applies W after painting the clipping path', async () => {
    const { actual, reference } = await renderFixture('q 8 w 20 40 40 50 re W S\n', '\nQ');
    const outsideStroke: [number, number, number, number] = [16, 60, 4, 20];
    expect(darkPixels(reference.getContext('2d').getImageData(...outsideStroke).data)).toBeGreaterThan(20);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...outsideStroke).data)).toBeGreaterThan(20);
  });

  it.skipIf(!hasPoppler)('does not merge neighboring text across different q/Q clipping states', async () => {
    const { actual, reference } = await renderFixture('q 0 0 4 4 re W n\n',
      raw => `\nQ\nq 1 0 0 1 76.8 0 cm\n${raw}\nQ`, 1, 'MMMM');
    const clipped: [number, number, number, number] = [20, 50, 70, 50];
    const restored: [number, number, number, number] = [100, 50, 70, 50];
    expect(darkPixels(reference.getContext('2d').getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(reference.getContext('2d').getImageData(...restored).data)).toBeGreaterThan(100);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...restored).data)).toBeGreaterThan(100);
  });

  it.skipIf(!hasPoppler)('preserves distinct clipping states inside an ActualText span', async () => {
    const { actual, reference } = await renderFixture('/Span << /ActualText (Logical) >> BDC\nq 0 0 4 4 re W n\n',
      raw => `\nQ\nq 1 0 0 1 76.8 0 cm\n${raw}\nQ\nEMC`, 1, 'MMMM');
    const clipped: [number, number, number, number] = [20, 50, 70, 50];
    const restored: [number, number, number, number] = [100, 50, 70, 50];
    expect(darkPixels(reference.getContext('2d').getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...clipped).data)).toBe(0);
    expect(darkPixels(reference.getContext('2d').getImageData(...restored).data)).toBeGreaterThan(100);
    expect(darkPixels(actual.getContext('2d')!.getImageData(...restored).data)).toBeGreaterThan(100);
  });
});
