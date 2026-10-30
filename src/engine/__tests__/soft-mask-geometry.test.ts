import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { PDFDict } from '../types';
import { renderPage } from '../render/renderer';

function stream(body: string, dictionary = ''): string {
  return `<< /Length ${body.length} ${dictionary} >>\nstream\n${body}\nendstream`;
}

function fixture(bbox: string | null, matrix: string | null,
  bboxObject = '[0 0 20 20]', matrixObject = '[1 0 0 1 30 40]', extra: string[] = [],
  options: { subtype?: string; maskBody?: string; parentBody?: string; maskExtras?: string; groupExtras?: string; resourcesExtra?: string; pageExtras?: string; rotate?: number } = {}): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Rotate ${options.rotate ?? 0} /Resources << /ExtGState << /M << /SMask << /S /${options.subtype ?? 'Luminosity'} /G 4 0 R ${options.maskExtras ?? ''} >> >> >> ${options.resourcesExtra ?? ''} >> /Contents 5 0 R ${options.pageExtras ?? ''} >>`,
    stream(options.maskBody ?? '1 g 0 0 20 20 re f', `/Type /XObject /Subtype /Form ${bbox === null ? '' : `/BBox ${bbox}`} ${matrix === null ? '' : `/Matrix ${matrix}`} /Group << /S /Transparency /I true /CS /DeviceRGB ${options.groupExtras ?? ''} >> /Resources << /ExtGState << /Half << /ca 0.5 >> >> >>`),
    stream(options.parentBody ?? '/M gs 1 0 0 rg 0 0 120 120 re f'), bboxObject, matrixObject, '30', '40', '20', ...extra,
  ]);
}

function setupCanvas(): void {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}

async function render(bytes: Uint8Array, scale = 1): Promise<Uint8ClampedArray> {
  const page = await renderPage(await parsePDF(bytes), 0, { scale, devicePixelRatio: 1 });
  return page.canvas.getContext('2d')!.getImageData(0, 0, 120 * scale, 120 * scale).data;
}

afterEach(() => vi.unstubAllGlobals());
const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

describe('soft-mask Form geometry references', () => {
  it.each([
    ['indirect arrays', '6 0 R', '7 0 R', '[0 0 20 20]', '[1 0 0 1 30 40]'],
    ['indirect numbers', '[0 0 10 0 R 10 0 R]', '[1 0 0 1 8 0 R 9 0 R]', '[0 0 20 20]', '[1 0 0 1 30 40]'],
    ['indirect arrays and numbers', '6 0 R', '7 0 R', '[0 0 10 0 R 10 0 R]', '[1 0 0 1 8 0 R 9 0 R]'],
  ])('renders %s like the equivalent direct geometry', async (_name, bbox, matrix, bboxObject, matrixObject) => {
    setupCanvas();
    const inspected = await parsePDF(fixture(bbox, matrix, bboxObject, matrixObject));
    const page = inspected.pages[0];
    expect(interpretPage(getPageContentBytes(page, inspected.objects), page, inspected.objects).displayList[0]?.softMask).toBeInstanceOf(PDFDict);
    const direct = await render(fixture('[0 0 20 20]', '[1 0 0 1 30 40]'));
    const indirect = await render(fixture(bbox, matrix, bboxObject, matrixObject));
    expect(Buffer.from(indirect).equals(Buffer.from(direct))).toBe(true);
    const inside = ((120 - 1 - 50) * 120 + 40) * 4;
    expect(Array.from(indirect.slice(inside, inside + 3))).toEqual([255, 0, 0]);
  });

  it('applies the mask to a horizontal stroke even when the path has zero height', async () => {
    setupCanvas();
    const bytes = fixture('[0 0 20 20]', '[1 0 0 1 30 40]', undefined, undefined, [], {
      parentBody: '/M gs 4 w 1 0 0 RG 0 50 m 120 50 l S',
    });
    const actual = await render(bytes);
    const pixel = (x: number, y: number) => Array.from(actual.slice(((119 - y) * 120 + x) * 4, ((119 - y) * 120 + x) * 4 + 3));
    expect(pixel(10, 50)).toEqual([255, 255, 255]);
    expect(pixel(40, 50)).toEqual([255, 0, 0]);
    expect(pixel(70, 50)).toEqual([255, 255, 255]);
  });

  it('rejects excessive mask surface area before allocating the mask canvases', async () => {
    const doc = await parsePDF(fixture('[0 0 20 20]', null));
    doc.pages[0].mediaBox = { x: 0, y: 0, width: 3000, height: 3000 };
    const createElement = vi.fn(() => Object.assign(createCanvas(1, 1), { style: {} }));
    vi.stubGlobal('document', { createElement });
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 }).then(() => 'rendered'))
      .rejects.toThrow(/soft-mask canvas.*limit/i);
    expect(createElement).toHaveBeenCalledTimes(1);
  });

  it('rejects a soft mask established under a transformed graphics state', async () => {
    setupCanvas();
    const bytes = fixture('[0 0 20 20]', null, undefined, undefined, [], {
      parentBody: '1 0 0 1 10 0 cm /M gs 1 0 0 rg 0 0 120 120 re f',
    });
    await expect(render(bytes).then(() => 'rendered')).rejects.toThrow(/soft mask.*transformed/i);
    const restored = fixture('[0 0 20 20]', null, undefined, undefined, [], {
      parentBody: 'q 1 0 0 1 10 0 cm Q /M gs 1 0 0 rg 0 0 120 120 re f',
    });
    await expect(render(restored)).resolves.toBeInstanceOf(Uint8ClampedArray);
  });

  it('bounds cumulative temporary surfaces for repeated masked drawing', async () => {
    const repeats = Array(100).fill('0 0 10 10 re f').join(' ');
    const doc = await parsePDF(fixture('[0 0 20 20]', null, undefined, undefined, [], { parentBody: `/M gs ${repeats}` }));
    doc.pages[0].mediaBox = { x: 0, y: 0, width: 600, height: 600 };
    doc.pages[0].cropBox = { x: 0, y: 0, width: 600, height: 600 };
    const createElement = vi.fn(() => {
      const canvas = { style: {}, width: 1, height: 1, getContext: () => context };
      const context = new Proxy({ canvas } as unknown as CanvasRenderingContext2D, {
        get(target, key) {
          if (key === 'canvas') return target.canvas;
          if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
          if (key === 'getImageData' || key === 'createImageData') return () => ({ data: new Uint8ClampedArray(0) });
          if (key === 'globalAlpha') return 1;
          return () => {};
        },
        set: () => true,
      });
      return canvas;
    });
    vi.stubGlobal('document', { createElement });
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 }).then(() => 'rendered'))
      .rejects.toThrow(/soft-mask.*cumulative work limit/i);
    expect(createElement.mock.calls.length).toBeLessThan(205);
  });

  it.each([
    ['Form', '/M gs /F Do', '/XObject << /F 11 0 R >>', stream('1 0 0 rg 0 0 20 20 re f', '/Type /XObject /Subtype /Form /BBox [0 0 20 20]')],
    ['shading', '/M gs /Sh sh', '/Shading << /Sh 11 0 R >>', '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 20 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >> >>'],
  ])('rejects a soft mask applied to %s until that compositing is supported', async (_name, parentBody, resourcesExtra, object) => {
    setupCanvas();
    const bytes = fixture('[0 0 20 20]', null, undefined, undefined, [object], { parentBody, resourcesExtra });
    await expect(render(bytes).then(() => 'rendered')).rejects.toThrow(/Unsupported soft mask applied/);
  });

  it('explicitly rejects a soft mask set inside a nested Form', async () => {
    setupCanvas();
    const nested = stream('/M gs 1 0 0 rg 0 0 20 20 re f', '/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << /ExtGState << /M << /SMask << /S /Alpha /G 4 0 R >> >> >> >>');
    const bytes = fixture('[0 0 20 20]', null, undefined, undefined, [nested], {
      parentBody: '/F Do', resourcesExtra: '/XObject << /F 11 0 R >>',
    });
    await expect(render(bytes).then(() => 'rendered')).rejects.toThrow(/Unsupported nested or annotation soft mask/);
  });

  it('explicitly rejects a soft mask set inside an annotation appearance', async () => {
    setupCanvas();
    const appearance = stream('/M gs 1 0 0 rg 0 0 20 20 re f', '/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << /ExtGState << /M << /SMask << /S /Alpha /G 4 0 R >> >> >> >>');
    const bytes = fixture('[0 0 20 20]', null, undefined, undefined,
      ['null', '<< /Type /Annot /Subtype /Stamp /Rect [0 0 20 20] /AP << /N 13 0 R >> >>', appearance],
      { parentBody: '', pageExtras: '/Annots [12 0 R]' });
    await expect(render(bytes).then(() => 'rendered')).rejects.toThrow(/Unsupported nested or annotation soft mask/);
  });

  it.skipIf(!poppler)('matches Poppler for indirect soft-mask geometry', async () => {
    setupCanvas();
    const bytes = fixture('6 0 R', '7 0 R');
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-soft-mask-geometry-'));
    try {
      const input = join(directory, 'input.pdf'), output = join(directory, 'reference');
      writeFileSync(input, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
      const image = await loadImage(readFileSync(`${output}.png`));
      const reference = createCanvas(120, 120); reference.getContext('2d').drawImage(image, 0, 0);
      const expected = reference.getContext('2d').getImageData(0, 0, 120, 120).data;
      const actual = await render(bytes);
      for (let y = 2; y < 118; y += 3) for (let x = 2; x < 118; x += 3) {
        if ([29, 30, 39, 40, 49, 50, 59, 60, 79, 80].some(edge => Math.abs(x - edge) <= 2 || Math.abs(y - edge) <= 2)) continue;
        const i = (y * 120 + x) * 4;
        expect(Array.from(actual.slice(i, i + 3))).toEqual(Array.from(expected.slice(i, i + 3)));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler).each([
    { subtype: 'Alpha', maskBody: '/Half gs 1 g 0 0 20 20 re f', rotate: 0, scale: 1 },
    { subtype: 'Luminosity', maskBody: '0.5 g 0 0 20 20 re f', rotate: 0, scale: 1 },
    { subtype: 'Luminosity', maskBody: '/Half gs 1 g 0 0 20 20 re f', rotate: 90, scale: 2 },
  ])('matches Poppler $subtype transparency with background preservation at rotation $rotate', async options => {
    setupCanvas();
    const bytes = fixture('6 0 R', '7 0 R', undefined, undefined, [], {
      subtype: options.subtype, maskBody: options.maskBody, rotate: options.rotate,
      parentBody: '0 0 1 rg 0 0 120 120 re f /M gs 1 0 0 rg 0 0 120 120 re f',
    });
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-soft-mask-alpha-'));
    try {
      const input = join(directory, 'input.pdf'), output = join(directory, 'reference');
      writeFileSync(input, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(72 * options.scale), '-png', input, output], { stdio: 'pipe' });
      const image = await loadImage(readFileSync(`${output}.png`));
      const side = 120 * options.scale;
      const reference = createCanvas(side, side); reference.getContext('2d').drawImage(image, 0, 0);
      const expected = reference.getContext('2d').getImageData(0, 0, side, side).data;
      const actual = await render(bytes, options.scale);
      let checkedMixed = 0, checkedBackground = 0;
      for (let y = 3; y < side - 3; y += 5) for (let x = 3; x < side - 3; x += 5) {
        const i = (y * side + x) * 4;
        const edge = expected[i] !== 0 && expected[i] !== 255 && expected[i + 2] !== 0 && expected[i + 2] !== 255;
        if (!edge && !(expected[i] === 0 && expected[i + 2] === 255)) continue;
        if (edge && !(expected[i] >= 120 && expected[i] <= 135 && expected[i + 2] >= 120 && expected[i + 2] <= 135)) continue;
        for (let c = 0; c < 3; c++) expect(Math.abs(actual[i + c] - expected[i + c])).toBeLessThanOrEqual(2);
        if (edge) checkedMixed++; else checkedBackground++;
      }
      expect(checkedMixed).toBeGreaterThan(5);
      expect(checkedBackground).toBeGreaterThan(100);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler)('matches Poppler for an RGB luminosity mask', async () => {
    setupCanvas();
    const bytes = fixture('6 0 R', '7 0 R', undefined, undefined, [], {
      subtype: 'Luminosity', maskBody: '1 0 0 rg 0 0 20 20 re f',
      parentBody: '0 0 1 rg 0 0 120 120 re f /M gs 1 0 0 rg 0 0 120 120 re f',
    });
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-soft-mask-rgb-'));
    try {
      const input = join(directory, 'input.pdf'), output = join(directory, 'reference');
      writeFileSync(input, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', input, output], { stdio: 'pipe' });
      const image = await loadImage(readFileSync(`${output}.png`));
      const reference = createCanvas(120, 120); reference.getContext('2d').drawImage(image, 0, 0);
      const expected = reference.getContext('2d').getImageData(40, 70, 1, 1).data;
      const actual = await render(bytes);
      const i = (70 * 120 + 40) * 4;
      for (let c = 0; c < 3; c++) expect(Math.abs(actual[i + c] - expected[c])).toBeLessThanOrEqual(2);
      expect(expected[0]).toBeGreaterThan(20);
      expect(expected[2]).toBeGreaterThan(20);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    { subtype: 'Luminosity', maskExtras: '/BC [1 1 1]' },
    { subtype: 'Alpha', maskExtras: '/TR /Identity' },
    { subtype: 'Bad', maskExtras: '' },
    { subtype: 'Alpha', groupExtras: '/I false' },
    { subtype: 'Alpha', groupExtras: '/K true' },
    { subtype: 'Alpha', groupExtras: '/CS /DeviceCMYK' },
  ])('rejects unsupported mask characteristics $subtype $maskExtras $groupExtras', async options => {
    setupCanvas();
    const bytes = fixture('[0 0 20 20]', null, undefined, undefined, [], options);
    await expect(render(bytes).then(() => 'rendered')).rejects.toThrow(/Unsupported soft-mask/);
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
  ])('rejects %s rather than rendering an ambiguous mask', async (_name, bbox, matrix, bboxObject, matrixObject) => {
    setupCanvas();
    await expect(render(fixture(bbox, matrix, bboxObject, matrixObject)).then(() => 'rendered')).rejects.toThrow(/Form.*(?:BBox|Matrix)/);
  });
});
