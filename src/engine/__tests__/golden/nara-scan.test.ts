import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF, getPageContentBytes } from '../../parser/parser';
import { renderPage } from '../../render/renderer';
import { findAndReplace } from '../../editor/text-editor';
import { updatePageContent } from '../../editor/stream-compiler';
import { rotatePageBy } from '../../writer/page-operations';
import { serializeDocument } from '../../writer/serializer';

const requiredPopplerTools = ['pdftoppm', 'pdftotext', 'pdfimages'];
const hasPoppler = requiredPopplerTools.every(tool => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status === 0);
const imagePath = new URL('./fixtures/nara-amendment-24-scan.jpg', import.meta.url);
const expectedHash = '307fbf97f16965b4b74b03272312e93ce8615b2ed3460fe1adff3d4caf8c2170';

afterEach(() => vi.unstubAllGlobals());

describe('public-domain historical scan corpus', () => {
  it.skipIf(!hasPoppler)('opens, edits, rotates and preserves the NARA scan on save', async () => {
    const imageBytes = readFileSync(imagePath);
    expect(createHash('sha256').update(imageBytes).digest('hex')).toBe(expectedHash);
    const source = await PDFDocument.create();
    const image = await source.embedJpg(imageBytes);
    expect([image.width, image.height]).toEqual([1596, 2400]);
    const page = source.addPage([399, 600]);
    page.drawImage(image, { x: 0, y: 0, width: 399, height: 600 });
    const font = await source.embedFont(StandardFonts.Helvetica);
    page.drawText('Synthetic review pending', { x: 8, y: 6, size: 8, font });
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    const content = getPageContentBytes(doc.pages[0], doc.objects);
    const edit = findAndReplace(content, doc.pages[0], doc.objects, 'pending', 'complete', true);
    expect(edit.replacedCount).toBe(1);
    await updatePageContent(doc.pages[0].contentRefs, edit.newContentBytes, doc.objects);
    rotatePageBy(doc, 0, 90);
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    expect(reopened.pages).toHaveLength(1);
    expect(reopened.pages[0].rotate).toBe(90);
    expect((await PDFDocument.load(output)).getPage(0).getRotation().angle).toBe(90);

    const directory = mkdtempSync(join(tmpdir(), 'paperloom-nara-corpus-'));
    try {
      const file = join(directory, 'scan.pdf'), prefix = join(directory, 'reference');
      writeFileSync(file, output);
      const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
      expect(text).toContain('Synthetic review complete');
      expect(text).not.toContain('Synthetic review pending');
      execFileSync('pdfimages', ['-j', file, join(directory, 'embedded')]);
      const exportedImage = readFileSync(join(directory, 'embedded-000.jpg'));
      expect(createHash('sha256').update(exportedImage).digest('hex')).toBe(expectedHash);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, prefix]);
      const reference = await loadImage(readFileSync(`${prefix}.png`));
      vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
      vi.stubGlobal('ImageData', ImageData);
      vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
      // The production JPEG decoder uses the browser's createImageBitmap API.
      // Supply its equivalent with the declared native Canvas test dependency.
      vi.stubGlobal('createImageBitmap', async (blob: Blob) =>
        Object.assign(await loadImage(Buffer.from(await blob.arrayBuffer())), { close() {} }));
      const actual = (await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 })).canvas;
      expect([actual.width, actual.height]).toEqual([reference.width, reference.height]);
      const referenceCanvas = createCanvas(reference.width, reference.height);
      referenceCanvas.getContext('2d').drawImage(reference, 0, 0);
      const actualPixels = actual.getContext('2d')!.getImageData(0, 0, actual.width, actual.height).data;
      const referencePixels = referenceCanvas.getContext('2d').getImageData(0, 0, reference.width, reference.height).data;
      let difference = 0, samples = 0, ink = 0, inkBrightness = 0;
      for (let i = 0; i < referencePixels.length; i += 16) {
        for (let c = 0; c < 3; c++) difference += Math.abs(actualPixels[i + c] - referencePixels[i + c]);
        if (referencePixels[i] < 100 && referencePixels[i + 1] < 100 && referencePixels[i + 2] < 100) {
          ink++;
          inkBrightness += (actualPixels[i] + actualPixels[i + 1] + actualPixels[i + 2]) / 3;
        }
        samples += 3;
      }
      // JPEG rasterizers may differ around edges; mean error over the entire
      // scan bounds noise without requiring identical antialiasing.
      expect(difference / samples).toBeLessThan(12);
      expect(ink).toBeGreaterThan(100);
      expect(inkBrightness / ink).toBeLessThan(160);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
