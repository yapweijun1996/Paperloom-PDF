import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { setFormFieldValue } from '../forms/apply-field';

const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

function widgetFixture(kind: 'text' | 'button', state: string, flags = 4): Uint8Array {
  const red = '1 0 0 rg 0 0 40 20 re f';
  const blue = '0 0 1 rg 0 0 40 20 re f';
  const appearance = kind === 'text' ? '5 0 R' : '<< /Yes 5 0 R /Off 6 0 R >>';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Annots [4 0 R] >>',
    `<< /Type /Annot /Subtype /Widget /FT /${kind === 'text' ? 'Tx' : 'Btn'} /T (field) /Rect [20 20 60 40] /F ${flags} /P 3 0 R ${state ? `/AS /${state}` : ''} /AP << /N ${appearance} >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${red.length} >>\nstream\n${red}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${blue.length} >>\nstream\n${blue}\nendstream`,
  ]);
}

function installCanvas() {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}
function pixel(canvas: HTMLCanvasElement, x = 30, y = 70) {
  return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data).slice(0, 3);
}
afterEach(() => vi.unstubAllGlobals());

describe('widget appearances in thumbnails', () => {
  it.each([
    ['text stream', 'text', '', [255, 0, 0]],
    ['on state', 'button', 'Yes', [255, 0, 0]],
    ['off state', 'button', 'Off', [0, 0, 255]],
  ] as const)('renders %s only when enabled', async (_label, kind, state, expected) => {
    installCanvas();
    const doc = await parsePDF(widgetFixture(kind, state));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).canvas)).toEqual([255, 255, 255]);
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual(expected);
  });

  it.each(['', 'Missing'])('does not guess missing or unknown state %s', async state => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('button', state));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual([255, 255, 255]);
  });

  it('continues to exclude hidden widgets', async () => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', '', 2));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual([255, 255, 255]);
  });

  it('updates thumbnail pixels after editing a real text widget', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([100, 100]);
    const field = pdf.getForm().createTextField('name');
    field.addToPage(page, { x: 10, y: 20, width: 80, height: 30, font: await pdf.embedFont(StandardFonts.Helvetica) });
    field.setText('Before');
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const before = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    const [widget] = detectFormFieldsOnPage(doc, 0);
    expect(widget).toBeDefined();
    setFormFieldValue(doc, widget, 'After');
    const after = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    expect(after).not.toBe(before);
  });

  it('updates both page appearances for one field with widgets on two pages', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage([100, 100]), pdf.addPage([100, 100])];
    const field = pdf.getForm().createTextField('shared');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const page of pages) field.addToPage(page, { x: 10, y: 20, width: 80, height: 30, font });
    field.setText('Before');
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const render = async (index: number) => (await renderPage(doc, index, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    const before = await Promise.all([render(0), render(1)]);
    const [widget] = detectFormFieldsOnPage(doc, 0);
    setFormFieldValue(doc, widget, 'Changed');
    const after = await Promise.all([render(0), render(1)]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it.skipIf(!hasPoppler).each([
    ['text stream', 'text', '', [255, 0, 0]],
    ['button on', 'button', 'Yes', [255, 0, 0]],
    ['button off', 'button', 'Off', [0, 0, 255]],
  ] as const)('matches Poppler for %s', async (_label, kind, state, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-'));
    try {
      const bytes = widgetFixture(kind, state);
      writeFileSync(join(dir, 'input.pdf'), bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'input.pdf'), join(dir, 'reference')], { stdio: 'pipe' });
      const reference = await loadImage(readFileSync(join(dir, 'reference.png')));
      const canvas = createCanvas(100, 100); canvas.getContext('2d').drawImage(reference, 0, 0);
      expect(Array.from(canvas.getContext('2d').getImageData(30, 70, 1, 1).data).slice(0, 3)).toEqual(expected);
      installCanvas();
      const rendered = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true });
      expect(pixel(rendered.canvas)).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
