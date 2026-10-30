import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';

function fixture(matrix: string, bbox = '0 0 10 20', appearance = '1 0 0 rg 0 0 5 20 re f 0 0 1 rg 5 0 5 20 re f'): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Annots [4 0 R] >>',
    '<< /Type /Annot /Subtype /Square /Rect [20 20 60 40] /F 4 /AP << /N 5 0 R >> >>',
    `<< /Type /XObject /Subtype /Form /BBox [${bbox}] /Matrix [${matrix}] /Resources << >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
  ]);
}

afterEach(() => vi.unstubAllGlobals());
const available = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

describe('annotation appearance placement', () => {
  it.skipIf(!available).each([
    ['identity', '1 0 0 1 0 0', undefined, undefined],
    ['rotation', '0 1 -1 0 20 0', undefined, undefined],
    ['reflection', '-1 0 0 1 10 0', undefined, undefined],
    ['shear and translation', '1 0.5 0.3 1 10 -5', undefined, undefined],
    ['nonzero origin and BBox clipping', '1 0 0 1 0 0', '10 20 20 40', '1 0 0 rg 0 0 15 60 re f 0 0 1 rg 15 0 20 60 re f'],
  ])('matches Poppler for %s appearance matrices', async (_label, matrix, bbox, appearance) => {
    const bytes = fixture(matrix, bbox, appearance);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-appearance-'));
    try {
      const input = join(directory, 'input.pdf'), output = join(directory, 'reference');
      writeFileSync(input, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
      const refImage = await loadImage(readFileSync(`${output}.png`));
      const ref = createCanvas(100, 100); ref.getContext('2d').drawImage(refImage, 0, 0);
      vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
      const result = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1 });
      const actual = result.canvas.getContext('2d')!;
      // Ignore edge antialiasing, but compare interior colored and white pixels
      // independently rendered by Poppler throughout and around /Rect.
      const classify = (pixel: Uint8ClampedArray) => {
        if (pixel[0] > 245 && pixel[1] > 245 && pixel[2] > 245) return 'white';
        if (pixel[0] > 245 && pixel[1] < 10 && pixel[2] < 10) return 'red';
        if (pixel[0] < 10 && pixel[1] < 10 && pixel[2] > 245) return 'blue';
        return null;
      };
      let compared = 0;
      for (let y = 55; y <= 85; y += 2) for (let x = 15; x <= 65; x += 2) {
        const expected = classify(ref.getContext('2d').getImageData(x, y, 1, 1).data);
        const observed = classify(actual.getImageData(x, y, 1, 1).data);
        if (expected && observed) { expect(observed).toBe(expected); compared++; }
      }
      expect(compared).toBeGreaterThan(100);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('skips finite geometry whose mapping would overflow', async () => {
    const tiny = `0.${'0'.repeat(319)}1`;
    const bytes = fixture('1 0 0 1 0 0', `0 0 ${tiny} 20`);
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1 });
      expect(warning).toHaveBeenCalledWith('[Renderer] Skipping annotation with degenerate appearance geometry');
    } finally { warning.mockRestore(); }
  });
});
