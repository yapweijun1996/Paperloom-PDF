import { afterEach, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';

function stream(body: string, dictionary = ''): string {
  return `<< /Length ${body.length} ${dictionary} >>\nstream\n${body}\nendstream`;
}

function fixture(form: string, alpha = 0.5, placement = '1 0 0 1 0 0'): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /F 4 0 R >> /ExtGState << /A << /ca 0.5 >> >> >> /Contents 5 0 R >>',
    stream(form, '/Type /XObject /Subtype /Form /BBox [0 0 80 80] /Group << /S /Transparency /I true >> /Resources << >>'),
    stream(`${alpha === 0.5 ? '/A gs ' : ''}${placement} cm /F Do`),
  ]);
}

afterEach(() => vi.unstubAllGlobals());

async function compare(bytes: Uint8Array, scale: number, points: [number, number][]) {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
  const directory = mkdtempSync(join(tmpdir(), 'paperloom-form-alpha-'));
  try {
    writeFileSync(join(directory, 'fixture.pdf'), bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(72 * scale), '-png', join(directory, 'fixture.pdf'), join(directory, 'expected')]);
    const image = await loadImage(readFileSync(join(directory, 'expected.png')));
    const reference = createCanvas(image.width, image.height);
    const rctx = reference.getContext('2d'); rctx.drawImage(image, 0, 0);
    const result = await renderPage(await parsePDF(bytes), 0, { scale, devicePixelRatio: 1 });
    const actx = result.canvas.getContext('2d')!;
    for (const [x, y] of points) {
      const expected = rctx.getImageData(x, y, 1, 1).data;
      const actual = actx.getImageData(x, y, 1, 1).data;
      for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i]), `${x},${y} channel ${i}`).toBeLessThanOrEqual(2);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it('allocates the isolated surface at the transformed device resolution', async () => {
  const canvases: ReturnType<typeof createCanvas>[] = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = Object.assign(createCanvas(1, 1), { style: {} });
    canvases.push(canvas);
    return canvas;
  } });
  await renderPage(await parsePDF(fixture('0 0 0 rg 20 20 1 30 re f', 1)), 0, { scale: 2, devicePixelRatio: 1 });
  expect(canvases.map(canvas => [canvas.width, canvas.height])).toContainEqual([160, 160]);
});

it('applies outer alpha once to a group after overlapping marks', async () => {
  await compare(fixture('1 0 0 rg 10 10 50 50 re f 0 0 1 rg 30 30 40 40 re f'), 1, [[20, 70], [40, 60], [65, 40]]);
});

it('renders a scaled isolated group at device resolution', async () => {
  await compare(fixture('0 0 0 rg 20 20 0.5 30 re f', 1, '2 0 0 2 0 0'), 2, [[80, 140], [81, 140], [82, 140], [83, 140]]);
});

it('composites nested isolated groups with their respective alpha exactly once', async () => {
  const bytes = rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /F 4 0 R >> /ExtGState << /A << /ca 0.5 >> >> >> /Contents 5 0 R >>',
    stream('1 0 0 rg 10 10 70 70 re f /A gs /Inner Do', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >> /Resources << /XObject << /Inner 6 0 R >> /ExtGState << /A << /ca 0.5 >> >> >>'),
    stream('/A gs /F Do'),
    stream('0 0 1 rg 20 20 40 40 re f', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >> /Resources << >>'),
  ]);
  await compare(bytes, 1, [[15, 85], [30, 70], [70, 30]]);
});

it('preserves the Form matrix and rotation when compositing a group', async () => {
  await compare(fixture('1 0 0 rg 10 10 50 30 re f', 0.5, '0 1 -1 0 90 0'), 2, [[120, 160], [100, 100], [70, 80]]);
});
