import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { loadPageFonts } from '../fonts/font-parser';
import { buildTextClippingOutline } from '../render/text-clipping-outline';
import { assertTextClippingSupported, UnsupportedTextClippingError } from '../render/text-clipping-guard';
import { renderPage } from '../render/renderer';
import { serializeDocument } from '../writer/serializer';

async function fixture(content: string, nestedForm = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([220, 140]);
  const data = readFileSync(new URL('../../../public/fonts/NotoSans-Regular.ttf', import.meta.url));
  const file = pdf.context.register(pdf.context.flateStream(data));
  const descriptor = pdf.context.register(pdf.context.obj({
    Type: 'FontDescriptor', FontName: 'NotoSans', Flags: 32, FontBBox: [-1000, -1000, 2000, 2000],
    ItalicAngle: 0, Ascent: 1069, Descent: -293, CapHeight: 714, StemV: 80, FontFile2: file,
  }));
  const font = pdf.context.register(pdf.context.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: 'NotoSans', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600), FontDescriptor: descriptor,
  }));
  page.node.setFontDictionary(PDFName.of('F1'), font);
  if (nestedForm) {
    const inner = pdf.context.register(pdf.context.flateStream(
      'BT /F1 48 Tf 1 0 0 1 40 50 Tm (M) Tj ET 1 0 0 rg 0 0 220 140 re f',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 220, 140], Resources: { Font: { F1: font } } },
    ));
    const outer = pdf.context.register(pdf.context.flateStream('/Inner Do', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 220, 140], Resources: { XObject: { Inner: inner } },
    }));
    page.node.setXObject(PDFName.of('Outer'), outer);
  }
  const stream = pdf.context.register(pdf.context.flateStream(content));
  page.node.set(PDFName.of('Contents'), stream);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

afterEach(() => vi.unstubAllGlobals());

describe('embedded TrueType text clipping outlines', () => {
  it('applies a resolved glyph clip only after ET and restores q/Q state', async () => {
    const doc = await fixture('q BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm (M) Tj ET 1 0 0 rg 0 0 220 140 re f Q 0 0 10 10 re f');
    const page = doc.pages[0], fonts = loadPageFonts(page.resources, doc.objects);
    const content = getPageContentBytes(page, doc.objects);
    const result = interpretPage(content, page, doc.objects, undefined, 0, runs => buildTextClippingOutline(runs, fonts));
    const paths = result.displayList.filter(item => item.type === 'path');
    expect(result.textRuns.map(run => run.text)).toContain('M');
    expect(paths).toHaveLength(2);
    expect(paths[0].clipPaths).toHaveLength(1);
    expect(paths[0].clipPaths[0].segments.length).toBeGreaterThan(0);
    expect(paths[1].clipPaths).toHaveLength(0);
    expect(() => assertTextClippingSupported(result.displayList)).not.toThrow();
  });

  it('retains extraction and rejects when no trusted outline is available', async () => {
    const doc = await fixture('BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm (M) Tj ET');
    const result = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects);
    expect(result.textRuns.map(run => run.text)).toEqual(['M']);
    expect(() => assertTextClippingSupported(result.displayList)).toThrow(UnsupportedTextClippingError);
    expect(() => buildTextClippingOutline(result.textRuns, new Map())).toThrow(UnsupportedTextClippingError);
  });

  it('rejects overlapping glyph outlines instead of changing their union', async () => {
    const doc = await fixture('BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm (MM) Tj ET');
    const page = doc.pages[0], fonts = loadPageFonts(page.resources, doc.objects);
    const result = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(() => buildTextClippingOutline(result.textRuns, fonts)).toThrow(UnsupportedTextClippingError);
  });

  it('rejects ambiguous graphics-state changes inside a text object', async () => {
    const doc = await fixture('BT /F1 48 Tf 7 Tr q 1 0 0 1 40 50 Tm (M) Tj Q ET');
    const page = doc.pages[0], fonts = loadPageFonts(page.resources, doc.objects), bytes = getPageContentBytes(page, doc.objects);
    expect(interpretPage(bytes, page, doc.objects).textRuns.map(run => run.text)).toEqual(['M']);
    expect(() => interpretPage(bytes, page, doc.objects, undefined, 0, runs => buildTextClippingOutline(runs, fonts)))
      .toThrow(/graphics-state/);
  });

  it('keeps ActualText extraction while marking the original clipped paint run', async () => {
    const doc = await fixture('BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm /Span << /ActualText (hello) >> BDC (M) Tj EMC ET 0 0 220 140 re f');
    const page = doc.pages[0], fonts = loadPageFonts(page.resources, doc.objects);
    const result = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects, undefined, 0,
      runs => buildTextClippingOutline(runs, fonts));
    expect(result.textRuns.map(run => run.text)).toEqual(['hello']);
    expect(result.displayList.find(item => item.type === 'text')).toMatchObject({ text: 'M', textClipSupported: true });
    expect(() => assertTextClippingSupported(result.displayList)).not.toThrow();
    expect(result.displayList.find(item => item.type === 'path')?.clipPaths).toHaveLength(1);
  });

  it('rejects symbolic and malformed fonts before parsing their outlines', async () => {
    const doc = await fixture('BT /F1 48 Tf 7 Tr 1 0 0 1 40 50 Tm (M) Tj ET');
    const page = doc.pages[0], fonts = loadPageFonts(page.resources, doc.objects);
    const runs = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
    const font = fonts.get('F1')!;
    font.flags = 4;
    expect(() => buildTextClippingOutline(runs, fonts)).toThrow(UnsupportedTextClippingError);
    font.flags = 32;
    const loca = font.ttfFont!.tables.get('loca')!;
    const originalLocaOffset = loca.offset;
    loca.offset = -1;
    expect(() => buildTextClippingOutline(runs, fonts)).toThrow(UnsupportedTextClippingError);
    loca.offset = originalLocaOffset;
    const gid = font.ttfFont!.cmapEntries.get(77)!;
    font.ttfFont!.cmapEntries.set(77, gid + 1);
    expect(() => buildTextClippingOutline(runs, fonts)).toThrow(UnsupportedTextClippingError);
    font.ttfFont!.cmapEntries.set(77, gid);
    font.ttfFont!.tables.get('cmap')!.offset = -1;
    expect(() => buildTextClippingOutline(runs, fonts)).toThrow(UnsupportedTextClippingError);
  });

  it.each([1, 2, 5, 6])('rejects unsupported hairline text stroke in mode %i', async mode => {
    const doc = await fixture(`0 w 1 0 0 RG BT /F1 48 Tf ${mode} Tr 1 0 0 1 40 50 Tm (M) Tj ET`);
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    vi.stubGlobal('ImageData', ImageData);
    vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/Hairline text stroke is unsupported/);
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'preserves inherited Tr7 and confines clipping in nested forms after save and reopen', async () => {
      const doc = await fixture('BT 7 Tr ET /Outer Do 0 0 1 rg 0 0 10 10 re f', true);
      const bytes = await serializeDocument(doc), reopened = await parsePDF(bytes);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-outline-form-'));
      try {
        const path = join(dir, 'fixture.pdf'), prefix = join(dir, 'reference');
        writeFileSync(path, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, prefix]);
        const ref = await loadImage(readFileSync(`${prefix}.png`));
        const reference = createCanvas(ref.width, ref.height), refCtx = reference.getContext('2d');
        refCtx.drawImage(ref, 0, 0);
        vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
        vi.stubGlobal('ImageData', ImageData);
        vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
        const result = await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 });
        const actual = result.canvas.getContext('2d')!.getImageData(0, 0, ref.width, ref.height).data;
        const expected = refCtx.getImageData(0, 0, ref.width, ref.height).data;
        let sameRed = 0, eitherRed = 0;
        for (let i = 0; i < actual.length; i += 4) {
          const a = actual[i] > 200 && actual[i + 1] < 80 && actual[i + 2] < 80;
          const b = expected[i] > 200 && expected[i + 1] < 80 && expected[i + 2] < 80;
          if (a && b) sameRed++;
          if (a || b) eitherRed++;
        }
        expect(eitherRed).toBeGreaterThan(50);
        expect(sameRed / eitherRed).toBeGreaterThan(0.8);
        const bluePixel = ((ref.height - 5) * ref.width + 5) * 4;
        expect(Array.from(actual.slice(bluePixel, bluePixel + 3))).toEqual([0, 0, 255]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000,
  );

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0).each([
    [4, 'M', '1 0 0 1 40 50', false], [5, 'M', '1 0 0 1 40 50', false],
    [6, 'M', '1 0 0 1 40 50', false], [7, 'M', '1 0 0 1 40 50', false],
    [7, 'O', '0.8 0.4 -0.4 0.8 90 35', false], [7, 'M', '1 0 0 1 40 50', true],
  ])(
    'matches Poppler glyph-clipped paint after save and reopen in mode %i with %s', async (mode, letter, matrix, actualText) => {
      const text = actualText ? `/Span << /ActualText (hello) >> BDC (${letter}) Tj EMC` : `(${letter}) Tj`;
      const doc = await fixture(`q BT /F1 48 Tf ${mode} Tr ${matrix} Tm ${text} ET 1 0 0 rg 0 0 220 140 re f Q`);
      const bytes = await serializeDocument(doc), reopened = await parsePDF(bytes);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-outline-'));
      try {
        const path = join(dir, 'fixture.pdf'), prefix = join(dir, 'reference');
        writeFileSync(path, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, prefix]);
        const ref = await loadImage(readFileSync(`${prefix}.png`));
        const reference = createCanvas(ref.width, ref.height), refCtx = reference.getContext('2d');
        refCtx.drawImage(ref, 0, 0);
        vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
        vi.stubGlobal('ImageData', ImageData);
        vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
        const result = await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 });
        const actual = result.canvas.getContext('2d')!.getImageData(0, 0, ref.width, ref.height).data;
        const expected = refCtx.getImageData(0, 0, ref.width, ref.height).data;
        let sameRed = 0, eitherRed = 0;
        for (let i = 0; i < actual.length; i += 4) {
          const a = actual[i] > 200 && actual[i + 1] < 80 && actual[i + 2] < 80;
          const b = expected[i] > 200 && expected[i + 1] < 80 && expected[i + 2] < 80;
          if (a && b) sameRed++;
          if (a || b) eitherRed++;
        }
        expect(eitherRed).toBeGreaterThan(50);
        expect(sameRed / eitherRed).toBeGreaterThan(0.8);
        expect([actual[0], actual[1], actual[2]]).toEqual([255, 255, 255]);
        expect(result.textRuns.map(run => run.text)).toContain(actualText ? 'hello' : letter);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000,
  );
});
