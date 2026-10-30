import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';
import { serializeDocument } from '../writer/serializer';
import { updatePageContent } from '../editor/stream-compiler';

function stream(content: string, dictionary = ''): string {
  return `<< /Length ${content.length} ${dictionary} >>\nstream\n${content}\nendstream`;
}

function fixture(off: string, offObject = '/None', scoped = false): Uint8Array {
  const content = scoped
    ? '/On gs q /Off gs 1 0 0 rg 0 0 120 120 re f Q 0 0 1 rg 0 0 120 120 re f'
    : '/On gs /Off gs 1 0 0 rg 0 0 120 120 re f';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Resources << /ExtGState << /On << /SMask << /S /Alpha /G 4 0 R >> >> /Off << /SMask ${off} >> >> >> /Contents 5 0 R >>`,
    stream('1 g 0 0 20 20 re f', '/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Group << /S /Transparency /I true /CS /DeviceRGB >>'),
    stream(content),
    offObject,
  ]);
}

const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;
afterEach(() => vi.unstubAllGlobals());

describe('soft-mask graphics-state values', () => {
  it.skipIf(!hasPoppler).each(['/None', '6 0 R'])(
    'permits %s to disable a mask under a transformed graphics state', async off => {
      vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
      const doc = await parsePDF(fixture(off));
      const content = '/On gs 0 0 1 rg 0 0 120 120 re f q 1 0 0 1 10 0 cm /Off gs 1 0 0 rg 0 0 110 120 re f Q';
      await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(content), doc.objects, false);
      const output = await serializeDocument(doc);
      const directory = mkdtempSync(join(tmpdir(), 'paperloom-softmask-transformed-none-'));
      try {
        const file = join(directory, 'fixture.pdf'), prefix = join(directory, 'reference');
        writeFileSync(file, output);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, prefix]);
        const image = await loadImage(readFileSync(`${prefix}.png`));
        const reference = createCanvas(120, 120);
        reference.getContext('2d').drawImage(image, 0, 0);
        const expected = Array.from(reference.getContext('2d').getImageData(90, 30, 1, 1).data).slice(0, 3);
        expect(expected).toEqual([255, 0, 0]);
        const rendered = await renderPage(await parsePDF(output), 0, { scale: 1, devicePixelRatio: 1 });
        expect(Array.from(rendered.canvas.getContext('2d')!.getImageData(90, 30, 1, 1).data).slice(0, 3)).toEqual(expected);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );
  it.skipIf(!hasPoppler).each([
    { label: 'direct', off: '/None' },
    { label: 'indirect', off: '6 0 R' },
  ])('restores a $label /None mask and q/Q state after save and reopen', async ({ off }) => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const doc = await parsePDF(fixture(off, '/None', true));
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-softmask-state-'));
    try {
      const file = join(directory, 'fixture.pdf'), prefix = join(directory, 'reference');
      writeFileSync(file, output);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, prefix]);
      const image = await loadImage(readFileSync(`${prefix}.png`));
      const reference = createCanvas(120, 120);
      reference.getContext('2d').drawImage(image, 0, 0);
      const actual = (await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 })).canvas.getContext('2d')!;
      for (const [x, y, expected] of [[10, 110, [0, 0, 255]], [90, 30, [255, 0, 0]]] as const) {
        const referencePixel = Array.from(reference.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3);
        expect(referencePixel).toEqual(expected);
        expect(Array.from(actual.getImageData(x, y, 1, 1).data).slice(0, 3)).toEqual(referencePixel);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    { label: 'missing', off: '999 0 R', object: '/None' },
    { label: 'cyclic', off: '6 0 R', object: '6 0 R' },
    { label: 'invalid name', off: '/Unexpected', object: '/None' },
    { label: 'invalid type', off: '6 0 R', object: '42' },
  ])('rejects a $label soft-mask value instead of retaining the previous mask', async ({ off, object }) => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const doc = await parsePDF(fixture(off, object));
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/soft-mask/i);
  });
});
