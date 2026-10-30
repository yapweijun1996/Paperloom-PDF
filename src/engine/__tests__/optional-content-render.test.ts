import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage, renderPageToCanvas } from '../render/renderer';
import { serializeDocument } from '../writer/serializer';

function pdfFixture(annotationFlags = '/OC 5 0 R'): Uint8Array {
  const content = '/OC /Hidden BDC 1 0 0 rg 0 0 20 20 re f /OC /Shown BDC 0 0 1 rg 20 0 20 20 re f EMC EMC 0 1 0 rg 40 0 20 20 re f q 1 0 0 1 0 40 cm /Nested Do Q';
  const form = '/OC /Hidden BDC 1 0 0 rg 0 0 20 20 re f EMC 0 0 1 rg 20 0 20 20 re f';
  const appearance = '1 0 0 rg 0 0 20 20 re f';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /OFF [5 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Properties << /Hidden 5 0 R /Shown 6 0 R >> /XObject << /Nested 7 0 R >> >> /Contents 4 0 R /Annots [8 0 R] >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /OCG /Name (Hidden) >>', '<< /Type /OCG /Name (Shown) >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << /Properties << /Hidden 5 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    `<< /Type /Annot /Subtype /Square /Rect [70 0 90 20] ${annotationFlags} /AP << /N 9 0 R >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
  ]);
}
function installCanvas() {
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('document', { createElement(tag: string) { if (tag !== 'canvas') throw new Error(tag); return Object.assign(createCanvas(1, 1), { style: {} }); } });
}
afterEach(() => vi.unstubAllGlobals());
const available = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

describe('rendering default-off layers', () => {
  it('keeps nested page marks, form marks and annotation appearances hidden in saved output', async () => {
    installCanvas();
    const doc = await parsePDF(pdfFixture());
    const saved = await serializeDocument(doc);
    const reopened = await parsePDF(saved);
    const rendered = await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 });
    const ctx = rendered.canvas.getContext('2d')!;
    const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, 99 - y, 1, 1).data).slice(0, 3);
    expect(pixel(10, 10)).toEqual([255, 255, 255]);
    expect(pixel(30, 10)).toEqual([255, 255, 255]);
    expect(pixel(50, 10)).toEqual([0, 255, 0]);
    expect(pixel(10, 50)).toEqual([255, 255, 255]);
    expect(pixel(30, 50)).toEqual([0, 0, 255]);
    expect(pixel(80, 10)).toEqual([255, 255, 255]);
    await expect(renderPageToCanvas(reopened.pages[0], reopened.objects, { scale: 1 })).rejects.toThrow(/catalog is required/i);
  });

  it.each([[2, [255, 255, 255]], [32, [255, 255, 255]], [1, [255, 0, 0]]] as const)(
    'applies annotation flag %i without deleting its appearance', async (flag, expected) => {
      installCanvas();
      const doc = await parsePDF(pdfFixture(`/F ${flag}`));
      const saved = await serializeDocument(doc);
      const reopened = await parsePDF(saved);
      const result = await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 });
      expect(Array.from(result.canvas.getContext('2d')!.getImageData(80, 89, 1, 1).data).slice(0, 3)).toEqual(expected);
      expect(reopened.objects.has('9_0')).toBe(true);
    },
  );

  it.skipIf(!available).each([[2, [255, 255, 255]], [32, [255, 255, 255]], [1, [255, 0, 0]]] as const)(
    'matches independent Poppler for annotation flag %i', async (flag, expected) => {
      const directory = mkdtempSync(join(tmpdir(), 'paperloom-annot-'));
      try {
        const input = join(directory, 'annotation.pdf'); const output = join(directory, 'render');
        writeFileSync(input, pdfFixture(`/F ${flag}`));
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
        const image = await loadImage(readFileSync(`${output}.png`)); const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        expect(Array.from(ctx.getImageData(80, 89, 1, 1).data).slice(0, 3)).toEqual(expected);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );

  it.skipIf(!available)('agrees with independent Poppler pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-oc-'));
    try {
      const input = join(directory, 'layers.pdf'); const output = join(directory, 'render');
      writeFileSync(input, pdfFixture());
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
      const image = await loadImage(readFileSync(`${output}.png`)); const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, 99 - y, 1, 1).data).slice(0, 3);
      expect(pixel(10, 10)).toEqual([255, 255, 255]); expect(pixel(30, 10)).toEqual([255, 255, 255]);
      expect(pixel(50, 10)).toEqual([0, 255, 0]); expect(pixel(10, 50)).toEqual([255, 255, 255]);
      expect(pixel(30, 50)).toEqual([0, 0, 255]); expect(pixel(80, 10)).toEqual([255, 255, 255]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
