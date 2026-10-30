import { PDFDocument, PDFName } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { parsePDF } from '../parser/parser';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { renderPage } from '../render/renderer';

const ci = process.env.CI === 'true' || process.env.CI === '1';
const missingPoppler = ['pdftoppm', 'pdftocairo'].some(tool => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status !== 0);

it.skipIf(missingPoppler && !ci)('compares removed overlapping fill paths at multiple scales and renderers', async () => {
  const fixtures = [
    ['1 0 0 1 0 0 cm', { x: 5, y: 5, width: 35, height: 35 }],
    ['1.2 0 0 .75 7 3 cm', { x: 5, y: 5, width: 40, height: 30 }],
    ['.7071 .7071 -.7071 .7071 55 4 cm', { x: 35, y: 10, width: 40, height: 40 }],
    ['-1 0 0 1 190 0 cm', { x: 160, y: 5, width: 25, height: 35 }],
  ] as const;
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-multi-audit-'));
  try {
    for (const [matrix, region] of fixtures) for (const op of ['f', 'f*']) {
      const pdf = await PDFDocument.create({ updateMetadata: false }), page = pdf.addPage([200, 200]);
      const content = `q ${matrix} 1 0 0 rg 15.3 15.3 10.3 8.3 re 17.3 16.3 6.3 5.3 re ${op} 0 0 1 rg 100.3 100.3 17.3 13.3 re f Q`;
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(content)));
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
      const before = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, region);
      await redactionEngine.applySecureRedactions(doc);
      const after = await saveQuick(doc);
      for (const dpi of [12, 18, 36, 72, 150, 300]) for (const backend of ['pdftoppm', 'pdftocairo']) {
        const render = async (bytes: Uint8Array, name: string) => {
          const source = join(dir, `${name}.pdf`), dest = join(dir, name);
          writeFileSync(source, bytes);
          execFileSync(backend, ['-png', '-f', '1', '-l', '1', '-singlefile', '-r', String(dpi), source, dest]);
          const im = await loadImage(readFileSync(`${dest}.png`));
          const canvas = createCanvas(im.width, im.height); const ctx = canvas.getContext('2d'); ctx.drawImage(im, 0, 0);
          return { width: im.width, height: im.height, data: ctx.getImageData(0, 0, im.width, im.height).data };
        };
        const first = await render(before, 'before'), last = await render(after, 'after');
        let outside = 0, example = '';
        for (let y = 0; y < first.height; y++) for (let x = 0; x < first.width; x++) {
          const l = x * 72 / dpi, r = (x + 1) * 72 / dpi, t = 200 - y * 72 / dpi, b = 200 - (y + 1) * 72 / dpi;
          if (!(r <= region.x || l >= region.x + region.width || t <= region.y || b >= region.y + region.height)) continue;
          const k = (y * first.width + x) * 4;
          if (first.data[k] !== last.data[k] || first.data[k + 1] !== last.data[k + 1] || first.data[k + 2] !== last.data[k + 2]) {
            outside++; if (!example) example = `${x},${y}`;
          }
        }
        expect(outside, `${matrix} ${op} ${backend} dpi ${dpi}, ${example}`).toBe(0);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it('preserves unmarked pixels in the editor canvas at multiple scales', async () => {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
  try {
    const cases = [
      { matrix: '1 0 0 1 0 0', area: { x: 8, y: 8, width: 30, height: 30 } },
      { matrix: '0 1 -1 0 180 5', area: { x: 150, y: 15, width: 20, height: 25 } },
      { matrix: '-1 0 0 1 190 0', area: { x: 160, y: 10, width: 25, height: 20 } },
      { matrix: '1 .2 .15 .9 2 2', area: { x: 15, y: 14, width: 22, height: 20 } },
    ];
    for (const operator of ['f', 'F', 'f*']) for (const { matrix, area } of cases) {
      const pdf = await PDFDocument.create({ updateMetadata: false }), page = pdf.addPage([200, 200]);
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(`q ${matrix} cm 1.3 w .5 .3 .2 rg .5 .3 .2 RG 15.3 15.4 10.2 8.7 re 17.3 17.4 6.2 4.7 re ${operator} 0 0 1 rg 100.3 100.7 15.1 13.5 re f Q`)));
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
      const before = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, area);
      await redactionEngine.applySecureRedactions(doc);
      const after = await saveQuick(doc);
      for (const scale of [1 / 6, .25, .5, 1, 2]) {
        const left = (await renderPage(await parsePDF(before), 0, { scale, devicePixelRatio: 1 })).canvas;
        const right = (await renderPage(await parsePDF(after), 0, { scale, devicePixelRatio: 1 })).canvas;
        const original = left.getContext('2d')!.getImageData(0, 0, left.width, left.height).data;
        const result = right.getContext('2d')!.getImageData(0, 0, right.width, right.height).data;
        let outsideDifferences = 0;
        for (let y = 0; y < left.height; y++) for (let x = 0; x < left.width; x++) {
          const l = x / scale, r = (x + 1) / scale, t = 200 - y / scale, b = 200 - (y + 1) / scale;
          if (!(r <= area.x || l >= area.x + area.width || t <= area.y || b >= area.y + area.height)) continue;
          const i = (y * left.width + x) * 4;
          if (result[i] !== original[i] || result[i + 1] !== original[i + 1] ||
              result[i + 2] !== original[i + 2] || result[i + 3] !== original[i + 3]) outsideDifferences++;
        }
        expect(outsideDifferences, `${operator} ${matrix} scale ${scale}`).toBe(0);
      }
    }
  } finally { vi.unstubAllGlobals(); }
}, 30_000);

it.skipIf(process.platform !== 'darwin')('preserves unmarked pixels in CoreGraphics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-multirect-quartz-'));
  try {
    for (const operator of ['f', 'F', 'f*']) for (const nested of [false, true]) {
      const pdf = await PDFDocument.create({ updateMetadata: false }), page = pdf.addPage([200, 200]);
      const extra = nested ? '17.4 17.2 6.3 4.1 re' : '17.4 17.2 3.3 4.1 re';
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(`1 0 0 rg 15.4 15.2 10.3 8.1 re ${extra} ${operator} 0 0 1 rg 100.3 100.7 15.1 13.5 re f`)));
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false })), before = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
      await redactionEngine.applySecureRedactions(doc);
      const after = await saveQuick(doc);
      const render = async (bytes: Uint8Array, name: string) => {
        const source = join(dir, `${name}.pdf`), target = join(dir, `${name}.png`);
        writeFileSync(source, bytes);
        execFileSync('sips', ['-s', 'format', 'png', source, '--out', target], { stdio: 'pipe' });
        const image = await loadImage(readFileSync(target));
        const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
      };
      const first = await render(before, 'before'), last = await render(after, 'after');
      expect([first.width, first.height]).toEqual([200, 200]);
      let outside = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (x >= 10 && x < 30 && y >= 170 && y < 190) continue;
        const i = (y * 200 + x) * 4;
        if (first.data[i] !== last.data[i] || first.data[i + 1] !== last.data[i + 1] ||
            first.data[i + 2] !== last.data[i + 2] || first.data[i + 3] !== last.data[i + 3]) outside++;
      }
      expect(outside, `${operator}, nested=${nested}`).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status !== 0)('saves structurally valid multi-rectangle input and output', async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false }), page = pdf.addPage([200, 200]);
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream('15 15 10 8 re 17 17 6 4 re f* 100 100 15 13 re f')));
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false })), before = await serializeDocument(doc);
  redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
  await redactionEngine.applySecureRedactions(doc);
  const after = await saveQuick(doc), dir = mkdtempSync(join(tmpdir(), 'paperloom-multirect-qpdf-'));
  try {
    for (const [name, bytes] of [['before', before], ['after', after]] as const) {
      const path = join(dir, `${name}.pdf`); writeFileSync(path, bytes);
      execFileSync('qpdf', ['--check', path], { stdio: 'pipe' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(missingPoppler && !ci)('compares high and cancelling winding counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-winding-audit-'));
  try {
    for (const count of [20, 60]) for (const op of ['f', 'f*']) {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      const page = pdf.addPage([200, 200]);
      const parts = ['1 0 0 rg 15 15 10 8 re'];
      for (let i = 0; i < count + 1; i++) parts.push('16.25 16.25 7.5 5.5 re');
      for (let i = 0; i < count; i++) parts.push('23.75 16.25 -7.5 5.5 re');
      parts.push(op, '0 0 1 rg 100.25 100.25 17.5 13.5 re f');
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(parts.join(' '))));
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false })), before = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, { x: 5, y: 5, width: 35, height: 35 });
      await redactionEngine.applySecureRedactions(doc); const after = await saveQuick(doc);
      for (const dpi of [12, 36, 72, 150, 300]) {
        const render = (bytes: Uint8Array, name: string) => {
          const source = join(dir, `${name}.pdf`), dest = join(dir, name); writeFileSync(source, bytes);
          execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', String(dpi), source, dest]);
          const ppm = readFileSync(`${dest}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 100));
          if (!header) throw new Error('Invalid PPM');
          return { width: Number(header[1]), height: Number(header[2]), data: ppm.subarray(header[0].length) };
        };
        const first = render(before, 'before'), last = render(after, 'after'); let outside = 0;
        for (let y = 0; y < first.height; y++) for (let x = 0; x < first.width; x++) {
          const l = x * 72 / dpi, r = (x + 1) * 72 / dpi, t = 200 - y * 72 / dpi, b = 200 - (y + 1) * 72 / dpi;
          if (!(r <= 5 || l >= 40 || t <= 5 || b >= 40)) continue;
          const k = (y * first.width + x) * 3;
          if (first.data[k] !== last.data[k] || first.data[k + 1] !== last.data[k + 1] || first.data[k + 2] !== last.data[k + 2]) outside++;
        }
        expect(outside, `count ${count} ${op} dpi ${dpi}`).toBe(0);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
