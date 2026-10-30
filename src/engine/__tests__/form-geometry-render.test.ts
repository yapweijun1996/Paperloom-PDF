import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';

function stream(body: string, dictionary = ''): string {
  return `<< /Length ${body.length} ${dictionary} >>\nstream\n${body}\nendstream`;
}

function fixture(bbox: string | null, matrix: string | null, bboxObject = '[0 0 20 20]', matrixObject = '[1 0 0 1 30 40]', extra: string[] = []): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Resources << /XObject << /F 4 0 R >> >> /Contents 5 0 R >>',
    stream('1 0 0 rg -10 -10 40 40 re f', `/Type /XObject /Subtype /Form ${bbox === null ? '' : `/BBox ${bbox}`} ${matrix === null ? '' : `/Matrix ${matrix}`} /Resources << >>`),
    stream('/F Do'), bboxObject, matrixObject, '30', '40', '20', ...extra,
  ]);
}

function nestedFixture(indirect: boolean): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Resources << /XObject << /Outer 4 0 R >> >> /Contents 5 0 R >>',
    stream('/Inner Do', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 20] /Resources << /XObject << /Inner 6 0 R >> >>'),
    stream('/Outer Do'),
    stream('1 0 0 rg -10 -10 40 40 re f', `/Type /XObject /Subtype /Form /BBox ${indirect ? '7 0 R' : '[0 0 20 20]'} /Matrix ${indirect ? '8 0 R' : '[1 0 0 1 30 40]'} /Resources << >>`),
    '[0 0 20 20]', '[1 0 0 1 30 40]',
  ]);
}

function setupCanvas(): void {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}

async function render(bytes: Uint8Array): Promise<Uint8ClampedArray> {
  const page = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1 });
  return page.canvas.getContext('2d')!.getImageData(0, 0, 120, 120).data;
}

afterEach(() => vi.unstubAllGlobals());
const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

describe('Form geometry references', () => {
  it.each([
    ['both arrays indirect', '6 0 R', '7 0 R', '[0 0 20 20]', '[1 0 0 1 30 40]'],
    ['individual numbers indirect', '[0 0 10 0 R 10 0 R]', '[1 0 0 1 8 0 R 9 0 R]', '[0 0 20 20]', '[1 0 0 1 30 40]'],
    ['indirect arrays with indirect numbers', '6 0 R', '7 0 R', '[0 0 10 0 R 10 0 R]', '[1 0 0 1 8 0 R 9 0 R]'],
  ])('renders %s identically to direct geometry', async (_name, bbox, matrix, bboxObject, matrixObject) => {
    setupCanvas();
    const direct = await render(fixture('[0 0 20 20]', '[1 0 0 1 30 40]'));
    const indirect = await render(fixture(bbox, matrix, bboxObject, matrixObject));
    expect(Buffer.from(indirect).equals(Buffer.from(direct))).toBe(true);
    const pixel = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.slice(((119 - y) * 120 + x) * 4, ((119 - y) * 120 + x) * 4 + 4));
    expect(pixel(indirect, 35, 45)).toEqual([255, 0, 0, 255]);
    expect(pixel(indirect, 55, 45)).toEqual([255, 255, 255, 255]);
  });

  it.skipIf(!poppler).each(['single', 'nested'])(
    'matches independent Poppler rendering for %s indirect Form geometry', async kind => {
    setupCanvas();
    const bytes = kind === 'single'
      ? fixture('6 0 R', '7 0 R', '[0 0 10 0 R 10 0 R]', '[1 0 0 1 8 0 R 9 0 R]')
      : nestedFixture(true);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-form-geometry-'));
    try {
      const input = join(directory, 'input.pdf'), output = join(directory, 'reference');
      writeFileSync(input, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
      const image = await loadImage(readFileSync(`${output}.png`));
      const reference = createCanvas(120, 120); reference.getContext('2d').drawImage(image, 0, 0);
      const expected = reference.getContext('2d').getImageData(0, 0, 120, 120).data;
      const actual = await render(bytes);
      for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
        if ([29, 30, 39, 40, 49, 50, 59, 60, 79, 80].includes(x) ||
            [39, 40, 59, 60, 79, 80].includes(y)) continue;
        const i = (y * 120 + x) * 4;
        expect(Array.from(actual.slice(i, i + 3))).toEqual(Array.from(expected.slice(i, i + 3)));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );

  it('uses the identity transform when the optional Matrix is absent', async () => {
    setupCanvas();
    const actual = await render(fixture('[0 0 20 20]', null));
    const expected = await render(fixture('[0 0 20 20]', '[1 0 0 1 0 0]'));
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });

  it('keeps equivalent geometry for nested Form references', async () => {
    setupCanvas();
    const direct = await render(nestedFixture(false));
    const indirect = await render(nestedFixture(true));
    expect(Buffer.from(indirect).equals(Buffer.from(direct))).toBe(true);
    const offset = ((119 - 65) * 120 + 45) * 4;
    expect(Array.from(indirect.slice(offset, offset + 4))).toEqual([255, 0, 0, 255]);
  });

  it('normalizes BBox corner order consistently', async () => {
    setupCanvas();
    const forward = await render(fixture('[0 0 20 20]', '[1 0 0 1 30 40]'));
    const reversed = await render(fixture('[20 20 0 0]', '[1 0 0 1 30 40]'));
    expect(Buffer.from(forward).equals(Buffer.from(reversed))).toBe(true);
  });

  it('rejects excessively long Form geometry references within a bounded traversal', async () => {
    setupCanvas();
    const chain = Array.from({ length: 130 }, (_, index) => index === 129 ? '[0 0 20 20]' : `${12 + index} 0 R`);
    await expect(render(fixture('6 0 R', null, '11 0 R', undefined, chain)).then(() => 'rendered'))
      .rejects.toThrow(/Form.*BBox.*excessive/);
  });

  it.each([
    ['missing BBox', null, null, undefined, undefined],
    ['invalid BBox length', '[0 0 20]', null, undefined, undefined],
    ['unresolved BBox', '99 0 R', null, undefined, undefined],
    ['cyclic BBox', '6 0 R', null, '6 0 R', undefined],
    ['invalid BBox number', '[0 0 /Bad 20]', null, undefined, undefined],
    ['invalid Matrix length', '[0 0 20 20]', '[1 0 0]', undefined, undefined],
    ['unresolved Matrix', '[0 0 20 20]', '99 0 R', undefined, undefined],
    ['cyclic Matrix', '[0 0 20 20]', '7 0 R', undefined, '7 0 R'],
    ['zero BBox', '[0 0 0 20]', null, undefined, undefined],
    ['non-finite BBox', `[0 0 ${'9'.repeat(400)} 20]`, null, undefined, undefined],
  ])('rejects %s explicitly instead of silently painting with wrong geometry', async (_name, bbox, matrix, bboxObject, matrixObject) => {
    setupCanvas();
    await expect(render(fixture(bbox, matrix, bboxObject, matrixObject)).then(() => 'rendered'))
      .rejects.toThrow(/Form.*(?:BBox|Matrix)/);
  });
});
