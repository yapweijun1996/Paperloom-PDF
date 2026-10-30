import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';

function fixture(state: string, indirect: boolean): Uint8Array {
  const red = '1 0 0 rg 0 0 40 20 re f';
  const blue = '0 0 1 rg 0 0 40 20 re f';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Annots [4 0 R] >>',
    `<< /Type /Annot /Subtype /Square /Rect [20 20 60 40] /F 4 ${state ? `/AS /${state}` : ''} /AP << /N ${indirect ? '7 0 R' : '<< /On 5 0 R /Off 6 0 R >>'} >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${red.length} >>\nstream\n${red}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${blue.length} >>\nstream\n${blue}\nendstream`,
    '<< /On 5 0 R /Off 6 0 R >>',
  ]);
}
function installCanvas() {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}
function pixel(canvas: HTMLCanvasElement) {
  return Array.from(canvas.getContext('2d')!.getImageData(30, 70, 1, 1).data).slice(0, 3);
}
afterEach(() => vi.unstubAllGlobals());
const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

describe('non-widget annotation appearance states', () => {
  it.each([
    ['On', false, [255, 0, 0]],
    ['Off', true, [0, 0, 255]],
  ] as const)('renders the %s state from the normal appearance dictionary', async (state, indirect, expected) => {
    installCanvas();
    const result = await renderPage(await parsePDF(fixture(state, indirect)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(pixel(result.canvas)).toEqual(expected);
  });

  it.each(['', 'Unknown'])('does not guess a missing or unknown state %s', async state => {
    installCanvas();
    const result = await renderPage(await parsePDF(fixture(state, false)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(pixel(result.canvas)).toEqual([255, 255, 255]);
  });

  it.skipIf(!hasPoppler).each([
    ['On', false, [255, 0, 0]],
    ['Off', false, [0, 0, 255]],
  ] as const)('matches Poppler for the %s state', async (state, indirect, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-annotation-state-'));
    try {
      const bytes = fixture(state, indirect);
      writeFileSync(join(dir, 'input.pdf'), bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'input.pdf'), join(dir, 'ref')], { stdio: 'pipe' });
      const canvas = createCanvas(100, 100);
      canvas.getContext('2d').drawImage(await loadImage(readFileSync(join(dir, 'ref.png'))), 0, 0);
      expect(Array.from(canvas.getContext('2d').getImageData(30, 70, 1, 1).data).slice(0, 3)).toEqual(expected);
      installCanvas();
      expect(pixel((await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1 })).canvas)).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
