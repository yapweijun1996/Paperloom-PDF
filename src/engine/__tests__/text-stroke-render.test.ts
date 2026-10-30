import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from './audit-p1-fixtures';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { applyTextEdits, findTextInPage } from '../editor/text-editor';
import { extractPagePlainText } from '../ai/compare';
import { updatePageContent } from '../editor/stream-compiler';
import { applyLineTextEdit } from '../flow/flow-editor';
import { buildDocumentFlow } from '../flow';
import { applyStyleToSelection } from '../flow/style-edit';
import { renderPage } from '../render/renderer';
import { serializeDocument } from '../writer/serializer';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';

function fixture(content: string): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 140] /Resources << /Font << /F1 4 0 R >> /ExtGState << /Opacity 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /ExtGState /ca 0.5 /CA 0.75 >>',
  ]);
}

function canvasSetup(): void {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}
afterEach(() => vi.unstubAllGlobals());

const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;
describe('PDF text stroke modes', () => {
  it('groups editable fill text while retaining each painted color', async () => {
    canvasSetup();
    const doc = await parsePDF(fixture('BT /F1 24 Tf 1 0 0 rg 1 0 0 1 20 60 Tm (AA) Tj 0 0 1 rg (BB) Tj ET'));
    const page = doc.pages[0];
    const interpreted = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(interpreted.textRuns.map(run => run.text)).toEqual(['AABB']);
    const painted = interpreted.displayList.filter(item => item.type === 'text');
    expect(painted.map(run => [run.text, run.fillColor])).toEqual([['AA', [1, 0, 0]], ['BB', [0, 0, 1]]]);
    const pixels = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data;
    let red = 0, blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > pixels[i + 1] + 30 && pixels[i] > pixels[i + 2] + 30) red++;
      if (pixels[i + 2] > pixels[i] + 30 && pixels[i + 2] > pixels[i + 1] + 30) blue++;
    }
    expect(red).toBeGreaterThan(20);
    expect(blue).toBeGreaterThan(20);
  });

  it('edits a color fragment without rewriting its neighbor and rejects unsafe combined edits', async () => {
    const doc = await parsePDF(fixture('BT /F1 24 Tf 1 0 0 rg 1 0 0 1 20 60 Tm (AA) Tj 0 0 1 rg (BB) Tj ET'));
    const page = doc.pages[0], bytes = getPageContentBytes(page, doc.objects);
    const original = interpretPage(bytes, page, doc.objects);
    const combined = original.textRuns[0];
    expect(() => applyTextEdits(bytes, page, doc.objects, [{ targetRun: combined, newText: 'ZZBB' }])).toThrow(/multiple paint styles/);
    const flow = buildDocumentFlow(original.textRuns), line = flow.lines[0];
    expect(line.runs.map(run => run.text)).toEqual(['AA', 'BB']);
    const edited = applyLineTextEdit(bytes, page, doc.objects, line, 'ZZBB', flow, { oldText: 'AABB', caretAfter: 2 });
    const after = interpretPage(edited.newContentBytes, page, doc.objects);
    expect(after.displayList.filter(item => item.type === 'text').map(run => [run.text, run.fillColor]))
      .toEqual([['ZZ', [1, 0, 0]], ['BB', [0, 0, 1]]]);
    const spanning = applyLineTextEdit(bytes, page, doc.objects, line, 'ZZXX', flow, { oldText: 'AABB', caretAfter: 4 });
    const afterSpanning = interpretPage(spanning.newContentBytes, page, doc.objects);
    expect(afterSpanning.displayList.filter(item => item.type === 'text').map(run => [run.text, run.fillColor]))
      .toEqual([['ZZ', [1, 0, 0]], ['XX', [0, 0, 1]]]);
    const styled = applyStyleToSelection(bytes, page, doc.objects, line, 0, 2, { fontSize: 30 });
    const afterStyle = interpretPage(styled.newContentBytes, page, doc.objects);
    expect(afterStyle.displayList.filter(item => item.type === 'text').map(run => run.fillColor))
      .toEqual([[1, 0, 0], [0, 0, 1]]);
  });

  it.skipIf(!poppler)('keeps edited and untouched fragment colors after save and reopen', async () => {
    canvasSetup();
    const doc = await parsePDF(fixture('BT /F1 24 Tf 1 0 0 rg 1 0 0 1 20 60 Tm (AA) Tj 0 0 1 rg (BB) Tj ET'));
    const page = doc.pages[0], bytes = getPageContentBytes(page, doc.objects);
    const flow = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns);
    const edited = applyLineTextEdit(bytes, page, doc.objects, flow.lines[0], 'ZZBB', flow, { oldText: 'AABB', caretAfter: 2 });
    await updatePageContent(page.contentRefs, edited.newContentBytes, doc.objects);
    const saved = await serializeDocument(doc);
    const reopened = await parsePDF(saved);
    const after = interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects);
    expect(after.displayList.filter(item => item.type === 'text').map(run => [run.text, run.fillColor]))
      .toEqual([['ZZ', [1, 0, 0]], ['BB', [0, 0, 1]]]);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-color-edit-'));
    try {
      const path = join(dir, 'edited.pdf');
      writeFileSync(path, saved);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, join(dir, 'reference')]);
      const image = await loadImage(readFileSync(join(dir, 'reference.png')));
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      const pixels = canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
      let red = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > pixels[i + 1] + 30 && pixels[i] > pixels[i + 2] + 30) red++;
        if (pixels[i + 2] > pixels[i] + 30 && pixels[i + 2] > pixels[i + 1] + 30) blue++;
      }
      expect(red).toBeGreaterThan(20);
      expect(blue).toBeGreaterThan(20);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('restores both colored fragments through undo and redo', async () => {
    const doc = await parsePDF(fixture('BT /F1 24 Tf 1 0 0 rg 1 0 0 1 20 60 Tm (AA) Tj 0 0 1 rg (BB) Tj ET'));
    const history = new SessionEditorHistory();
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    const colors = () => {
      const page = doc.pages[0];
      return interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
        .filter(item => item.type === 'text').map(run => [run.text, run.fillColor]);
    };
    history.seed(capture('initial'));
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit', async staged => {
      const page = staged.pages[0], bytes = getPageContentBytes(page, staged.objects);
      const flow = buildDocumentFlow(interpretPage(bytes, page, staged.objects).textRuns);
      const edited = applyLineTextEdit(bytes, page, staged.objects, flow.lines[0], 'ZZBB', flow, { oldText: 'AABB', caretAfter: 2 });
      await updatePageContent(page.contentRefs, edited.newContentBytes, staged.objects);
    });
    history.push(capture('edit'), editor);
    expect(colors()).toEqual([['ZZ', [1, 0, 0]], ['BB', [0, 0, 1]]]);
    for (const [direction, expected] of [['undo', 'AA'], ['redo', 'ZZ']] as const) {
      const result = await history[direction](doc);
      if (result && !result.restoredDocument) await restoreDocumentStructure(doc, result.entry, updatePageContent);
      expect(colors()).toEqual([[expected, [1, 0, 0]], ['BB', [0, 0, 1]]]);
    }
  });

  it.each([
    ['render mode', '3 Tr'],
    ['clip path', '0 0 200 140 re W n'],
  ])('does not merge editable text across a change in %s', async (_label, change) => {
    const doc = await parsePDF(fixture(`BT /F1 24 Tf 1 0 0 1 20 60 Tm (A) Tj ${change} (B) Tj ET`));
    const page = doc.pages[0];
    const result = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(result.textRuns.map(run => run.text)).toEqual(['A', 'B']);
  });

  it('keeps ActualText spans distinct from adjacent color-grouped text', async () => {
    const doc = await parsePDF(fixture('/Span << /ActualText (logical) >> BDC BT /F1 24 Tf 1 0 0 1 20 60 Tm (A) Tj 0 0 1 rg (B) Tj ET EMC'));
    const page = doc.pages[0];
    const result = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(result.actualTextSpans?.map(span => span.text)).toEqual(['logical']);
    expect(result.textRuns.map(run => run.text)).toEqual(['logical']);
    expect(result.displayList.filter(item => item.type === 'text').map(run => run.fillColor))
      .toEqual([[0, 0, 0], [0, 0, 1]]);
  });

  it('preserves text and paint on both sides of a multicolor ActualText span', async () => {
    canvasSetup();
    const prefix = 'BT /F1 24 Tf 1 0 0 1 20 60 Tm (P) Tj ';
    const inner = '(A) Tj 0 0 1 rg (B) Tj ';
    const suffix = '(C) Tj ET';
    const doc = await parsePDF(fixture(`${prefix}/Span << /ActualText (logical) >> BDC ${inner} EMC ${suffix}`));
    const page = doc.pages[0], bytes = getPageContentBytes(page, doc.objects);
    const result = interpretPage(bytes, page, doc.objects);
    expect(result.textRuns.map(run => run.text)).toEqual(['P', 'logical', 'C']);
    expect(result.displayList.filter(item => item.type === 'text').map(run => [run.text, run.fillColor]))
      .toEqual([['P', [0, 0, 0]], ['A', [0, 0, 0]], ['B', [0, 0, 1]], ['C', [0, 0, 1]]]);
    const extracted = extractPagePlainText(doc, 0);
    expect(extracted).toContain('P');
    expect(extracted).toContain('logical');
    expect(extracted).toContain('C');
    for (const text of ['P', 'logical', 'C']) {
      expect(findTextInPage(bytes, page, doc.objects, text, true).map(run => run.text)).toEqual([text]);
    }
    const noPaint = '0 0 0 0 re f ';
    const reference = await renderPage(await parsePDF(fixture(`${prefix}${noPaint}${inner}${noPaint}${suffix}`)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data)
      .toEqual(reference.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data);
  });

  it('keeps ActualText paint on its original side of intervening graphics', async () => {
    canvasSetup();
    const content = 'BT /F1 24 Tf 1 0 0 1 20 60 Tm (A) Tj ET 1 1 1 rg 0 0 240 140 re f 0 g BT /F1 24 Tf 1 0 0 1 40 60 Tm (B) Tj ET';
    const doc = await parsePDF(fixture(`/Span << /ActualText (logical) >> BDC ${content} EMC`));
    const page = doc.pages[0];
    const interpreted = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(interpreted.displayList.map(item => item.type)).toEqual(['text', 'path', 'text']);
    expect(interpreted.textRuns.map(run => run.text)).toEqual(['logical']);
    const reference = await renderPage(await parsePDF(fixture(content)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data)
      .toEqual(reference.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data);
  });

  it('retains each font within an ActualText span', async () => {
    canvasSetup();
    const content = 'BT /F1 24 Tf 1 0 0 1 20 60 Tm (A) Tj /F2 24 Tf (B) Tj ET';
    const twoFonts = (stream: string) => rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 140] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ]);
    const doc = await parsePDF(twoFonts(`/Span << /ActualText (logical) >> BDC ${content} EMC`));
    const page = doc.pages[0];
    const result = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
    expect(result.textRuns.map(run => run.text)).toEqual(['logical']);
    expect(result.displayList.filter(item => item.type === 'text').map(run => [run.text, run.fontName]))
      .toEqual([['A', 'F1'], ['B', 'F2']]);
    const reference = await renderPage(await parsePDF(twoFonts(content)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data)
      .toEqual(reference.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data);
  });

  it.skipIf(!poppler).each([1, 2])('renders text mode %s with independent stroke and fill', async mode => {
    canvasSetup();
    const content = `1 w 1 0 0 RG 0 0 1 rg BT /F1 48 Tf ${mode} Tr 1 0 0 1 20 65 Tm (MMMM) Tj ET`;
    const doc = await parsePDF(fixture(content));
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    const actual = (await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1 })).canvas;
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-stroke-'));
    try {
      const path = join(dir, 'fixture.pdf');
      writeFileSync(path, output);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, join(dir, 'reference')]);
      const reference = await loadImage(readFileSync(join(dir, 'reference.png')));
      const refCanvas = createCanvas(reference.width, reference.height);
      refCanvas.getContext('2d').drawImage(reference, 0, 0);
      const classify = (data: Uint8ClampedArray) => {
        let red = 0, blue = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > data[i + 1] + 30 && data[i] > data[i + 2] + 30) red++;
          if (data[i + 2] > data[i] + 30 && data[i + 2] > data[i + 1] + 30) blue++;
        }
        return { red, blue };
      };
      const expected = classify(refCanvas.getContext('2d').getImageData(0, 0, 240, 140).data);
      const observed = classify(actual.getContext('2d')!.getImageData(0, 0, 240, 140).data);
      expect(expected.red).toBeGreaterThan(20);
      expect(observed.red).toBeGreaterThan(20);
      if (mode === 1) { expect(expected.blue).toBe(0); expect(observed.blue).toBe(0); }
      else { expect(expected.blue).toBeGreaterThan(20); expect(observed.blue).toBeGreaterThan(20); }
      expect(observed.red / expected.red).toBeGreaterThan(0.35);
      expect(observed.red / expected.red).toBeLessThan(2.5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves each stroke state rather than merging adjacent differently styled text', async () => {
    canvasSetup();
    const doc = await parsePDF(fixture('BT /F1 24 Tf 1 Tr 1 0 0 RG 2 w 1 0 0 1 20 60 Tm (A) Tj 0 0 1 RG 5 w (B) Tj ET'));
    const result = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(result.textRuns).toHaveLength(2);
    expect(result.textRuns.map(run => [run.strokeColor, run.strokeLineWidth])).toEqual([[[1, 0, 0], 2], [[0, 0, 1], 5]]);
  });

  it('keeps stroke and fill opacities independent', async () => {
    canvasSetup();
    const doc = await parsePDF(fixture('/Opacity gs 0.5 w 1 0 0 RG 0 0 1 rg BT /F1 48 Tf 2 Tr 1 0 0 1 20 65 Tm (MMMM) Tj ET'));
    const rendered = await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(rendered.textRuns[0]).toMatchObject({ fillAlpha: 0.5, strokeAlpha: 0.75, strokeLineWidth: 0.5 });
    const pixels = rendered.canvas.getContext('2d')!.getImageData(0, 0, 240, 140).data;
    let red = false, blue = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > pixels[i + 1] + 30 && pixels[i] > pixels[i + 2] + 30) red = true;
      if (pixels[i + 2] > pixels[i] + 30 && pixels[i + 2] > pixels[i + 1] + 30) blue = true;
    }
    expect(red).toBe(true);
    expect(blue).toBe(true);
  });

  it('honors clipping and reports unsupported nonuniform text transforms', async () => {
    canvasSetup();
    const clipped = await parsePDF(fixture('0 0 60 140 re W n 2 w 1 0 0 RG BT /F1 48 Tf 1 Tr 1 0 0 1 20 65 Tm (MMMM) Tj ET'));
    const rendered = await renderPage(clipped, 0, { scale: 1, devicePixelRatio: 1 });
    const pixels = rendered.canvas.getContext('2d')!.getImageData(70, 0, 170, 140).data;
    expect([...pixels].filter((value, index) => index % 4 !== 3 && value < 240)).toHaveLength(0);
    const stretched = await parsePDF(fixture('2 w BT /F1 24 Tf 1 Tr 2 0 0 1 20 60 Tm (Text) Tj ET'));
    await expect(renderPage(stretched, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/nonuniform text transform/);
  });

  it.skipIf(!poppler).each([
    ['scaled graphics state', '2 0 0 2 0 0 cm', '1 0 0 1 15 30 Tm'],
    ['rotated text matrix', '', '0 1 -1 0 150 20 Tm'],
  ])('retains stroke under %s', async (_label, transform, matrix) => {
    canvasSetup();
    const content = `${transform} 2 w 1 0 0 RG BT /F1 20 Tf 1 Tr ${matrix} (MMMM) Tj ET`;
    const doc = await parsePDF(fixture(content));
    const output = await serializeDocument(doc);
    const actual = (await renderPage(await parsePDF(output), 0, { scale: 1, devicePixelRatio: 1 })).canvas;
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-stroke-transform-'));
    try {
      const path = join(dir, 'fixture.pdf');
      writeFileSync(path, output);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, join(dir, 'reference')]);
      const reference = await loadImage(readFileSync(join(dir, 'reference.png')));
      const refCanvas = createCanvas(reference.width, reference.height);
      refCanvas.getContext('2d').drawImage(reference, 0, 0);
      const red = (data: Uint8ClampedArray) => {
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > data[i + 1] + 30 && data[i] > data[i + 2] + 30) count++;
        return count;
      };
      const expected = red(refCanvas.getContext('2d').getImageData(0, 0, 240, 140).data);
      const observed = red(actual.getContext('2d')!.getImageData(0, 0, 240, 140).data);
      expect(expected).toBeGreaterThan(30);
      expect(observed).toBeGreaterThan(30);
      expect(observed / expected).toBeGreaterThan(0.25);
      expect(observed / expected).toBeLessThan(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
