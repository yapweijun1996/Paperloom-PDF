import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas/node-canvas';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';

function fixture(content: string) {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe('invisible OCR text', () => {
  it.each([
    ['Tj', '(Hidden) Tj'],
    ['TJ', '[(Hid) 0 (den)] TJ'],
    ['quote', '(Hidden) \''],
    ['double quote', '0 0 (Hidden) "'],
  ])('keeps %s text searchable without painting it or changing visible text', async (_label, show) => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const visible = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm (Visible) Tj ET';
    const hidden = `BT /F1 20 Tf 3 Tr 1 0 0 1 20 70 Tm ${show} ET`;
    const baseline = await renderPage(await parsePDF(fixture(visible)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(await parsePDF(fixture(`${visible}\n${hidden}`)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.textRuns.map(run => run.text).join(' ')).toContain('Hidden');
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data)
      .toEqual(baseline.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data);
  });

  it('retains visible paint inside a mixed ActualText span while hiding its OCR run', async () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const visible = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm 0 Tr (Visible) Tj ET';
    const mixed = '/Span << /ActualText (Unified) >> BDC\nBT /F1 20 Tf 1 0 0 1 20 70 Tm 0 Tr (Visible) Tj 3 Tr 1 0 0 1 20 70 Tm (Hidden) Tj ET\nEMC';
    const baseline = await renderPage(await parsePDF(fixture(visible)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(await parsePDF(fixture(mixed)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.textRuns.map(run => run.text).join(' ')).toContain('Unified');
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data)
      .toEqual(baseline.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data);
  });

  it.each([
    ['visible first', '0 Tr (Visible) Tj 3 Tr (Hidden) Tj', [0, 3]],
    ['hidden first', '3 Tr (Hidden) Tj 0 Tr (Visible) Tj', [3, 0]],
  ] as const)('does not merge adjacent runs with different rendering modes: %s', async (_label, text, modes) => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const actual = await renderPage(await parsePDF(fixture(`BT /F1 20 Tf 1 0 0 1 20 70 Tm ${text} ET`)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.textRuns.map(run => run.renderingMode)).toEqual(modes);
  });

  it('preserves visible paint across nested mixed ActualText spans', async () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const plain = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm 0 Tr (Visible) Tj 3 Tr (Hidden) Tj 0 Tr (Tail) Tj ET';
    const nested = '/Span << /ActualText (Outer) >> BDC BT /F1 20 Tf 1 0 0 1 20 70 Tm /Span << /ActualText (Inner) >> BDC 0 Tr (Visible) Tj 3 Tr (Hidden) Tj EMC 0 Tr (Tail) Tj ET EMC';
    const baseline = await renderPage(await parsePDF(fixture(plain)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(await parsePDF(fixture(nested)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.textRuns.map(run => run.text).join(' ')).toContain('Outer');
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data)
      .toEqual(baseline.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data);
  });

  it('does not paint invisible text within a Form XObject', async () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const make = (content: string) => rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /XObject << /Fm 4 0 R >> >> /Contents 6 0 R >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> >> /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length 6 >>\nstream\n/Fm Do\nendstream',
    ]);
    const visible = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm (Visible) Tj';
    const baseline = await renderPage(await parsePDF(make(`${visible} ET`)), 0, { scale: 1, devicePixelRatio: 1 });
    const actual = await renderPage(await parsePDF(make(`${visible} 3 Tr (Hidden) Tj ET`)), 0, { scale: 1, devicePixelRatio: 1 });
    expect(actual.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data)
      .toEqual(baseline.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data);
  });

  it('inherits the page mode in forms, permits a local reset, and restores the parent mode', async () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const form = (contents: string, page: string) => rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm 4 0 R >> >> /Contents 6 0 R >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> >> /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    ]);
    const text = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm';
    const render = async (contents: string, page: string) => (await renderPage(await parsePDF(form(contents, page)), 0, { scale: 1, devicePixelRatio: 1 })).canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data;
    const white = await render('', '');
    expect(await render(`${text} (Hidden) Tj ET`, 'BT 3 Tr ET /Fm Do')).toEqual(white);
    const visible = await render(`${text} 0 Tr (Visible) Tj ET`, '/Fm Do');
    expect(visible).not.toEqual(white);
    expect(await render(`${text} 0 Tr (Visible) Tj ET`, `BT 3 Tr ET /Fm Do ${text} (StillHidden) Tj ET`)).toEqual(visible);
  });

  it('inherits invisible mode through nested Form XObjects', async () => {
    vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
    const outer = '/Inner Do', inner = 'BT /F1 20 Tf 1 0 0 1 20 70 Tm (Hidden) Tj ET', page = 'BT 3 Tr ET /Outer Do';
    const bytes = rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /XObject << /Outer 4 0 R >> >> /Contents 7 0 R >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 200 120] /Resources << /XObject << /Inner 5 0 R >> >> /Length ${outer.length} >>\nstream\n${outer}\nendstream`,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 200 120] /Resources << /Font << /F1 6 0 R >> >> /Length ${inner.length} >>\nstream\n${inner}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    ]);
    const actual = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1 });
    const pixels = actual.canvas.getContext('2d')!.getImageData(0, 0, 200, 120).data;
    expect([...pixels].filter((value, index) => index % 4 !== 3 && value < 230)).toHaveLength(0);
  });
});
