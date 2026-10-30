import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { renderPage } from '../render/renderer';
import { UnsupportedTextClippingError } from '../render/text-clipping-guard';

function stream(body: string, dictionary = ''): string {
  return `<< /Length ${body.length} ${dictionary} >>\nstream\n${body}\nendstream`;
}

function fixture(mode: number, inForm = false, inherited = false): Uint8Array {
  const text = `BT /F1 48 Tf ${inherited ? '' : `${mode} Tr`} 1 0 0 1 40 50 Tm (M) Tj ET`;
  const paint = '1 0 0 rg 0 0 220 140 re f';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 140] /Resources << /Font << /F1 4 0 R >> /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    stream(inForm ? `${inherited ? `BT ${mode} Tr ET ` : ''}/Fm Do` : `${text} ${paint}`),
    stream(`${text} ${paint}`, '/Type /XObject /Subtype /Form /BBox [0 0 220 140] /Resources << /Font << /F1 4 0 R >> >>'),
  ]);
}

function annotationFixture(): Uint8Array {
  const content = 'BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm (M) Tj ET 1 0 0 rg 0 0 220 140 re f';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 140] /Resources << /Font << /F1 4 0 R >> >> /Annots [5 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Annot /Subtype /Stamp /Rect [0 0 220 140] /AP << /N 6 0 R >> >>',
    stream(content, '/Type /XObject /Subtype /Form /BBox [0 0 220 140] /Resources << /Font << /F1 4 0 R >> >>'),
  ]);
}

function installCanvas(): void {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
}

afterEach(() => vi.unstubAllGlobals());

describe('unsupported PDF text clipping', () => {
  it.each([4, 5, 6, 7])('refuses mode %i while leaving text extraction available', async mode => {
    const doc = await parsePDF(fixture(mode));
    const page = doc.pages[0];
    const extracted = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(extracted.textRuns.map(run => run.text)).toContain('M');
    installCanvas();
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toBeInstanceOf(UnsupportedTextClippingError);
    // Text clipping affects later graphics even when callers suppress text paint.
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderText: false })).rejects.toBeInstanceOf(UnsupportedTextClippingError);
  });

  it.each([0, 1, 2, 3])('does not reject non-clipping mode %i', async mode => {
    const doc = await parsePDF(fixture(mode));
    installCanvas();
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).resolves.toBeDefined();
  });

  it('also refuses text clipping inside a nested Form', async () => {
    const doc = await parsePDF(fixture(7, true));
    installCanvas();
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toBeInstanceOf(UnsupportedTextClippingError);
  });

  it('also refuses a Form that inherits text clipping from its parent', async () => {
    const doc = await parsePDF(fixture(7, true, true));
    installCanvas();
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toBeInstanceOf(UnsupportedTextClippingError);
  });

  it('also refuses text clipping inside an annotation appearance', async () => {
    const doc = await parsePDF(annotationFixture());
    installCanvas();
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toBeInstanceOf(UnsupportedTextClippingError);
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'shows why mode 7 cannot be rendered without a glyph clip', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'paperloom-text-clip-'));
      try {
        const file = join(directory, 'fixture.pdf'), prefix = join(directory, 'page');
        writeFileSync(file, fixture(7));
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, prefix]);
        const reference = await loadImage(readFileSync(`${prefix}.png`));
        const canvas = createCanvas(reference.width, reference.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(reference, 0, 0);
        // Red paint is clipped to the glyph, not the far corner of the page.
        expect([...ctx.getImageData(5, 5, 1, 1).data]).toEqual([255, 255, 255, 255]);
        const data = ctx.getImageData(35, 40, 45, 60).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) red++;
        expect(red).toBeGreaterThan(20);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );
});
