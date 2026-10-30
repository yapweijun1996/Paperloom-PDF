import { describe, expect, it } from 'vitest';
import * as engine from '@/engine/browser-core';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { PDFArray, PDFNumber, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

function stream(body: string, dict = ''): string {
  return `<< /Length ${body.length} ${dict} >>\nstream\n${body}\nendstream`;
}
async function fixture(x: number) {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> >> /Contents 6 0 R >>',
    stream(`BT /F1 12 Tf 1 0 0 1 ${x} 20 Tm (Needle) Tj ET`, '/Type /XObject /Subtype /Form /BBox [0 0 30 40] /Resources << /Font << /F1 5 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', stream('/Outer Do'),
  ]));
}
async function crossFixture(maxX: number, pageClip = '') {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    stream('BT /F1 12 Tf 1 0 0 1 46 20 Tm (Beta) Tj ET', `/Type /XObject /Subtype /Form /BBox [0 0 ${maxX} 40] /Resources << /Font << /F1 5 0 R >> >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    stream(`${pageClip} BT /F1 12 Tf 1 0 0 1 10 20 Tm (Alpha) Tj ET /Outer Do`),
  ]));
}

describe('Form search highlighting with clipping', () => {
  it('limits a partially visible Form match to its BBox and invalidates a changed cache', async () => {
    const doc = await fixture(10), index = new DocumentSearchIndex();
    const search = () => searchDocument(doc, 'Needle', false, 'revision', index, engine, () => true);
    const first = (await search())![0];
    expect(first).toMatchObject({ highlightVisible: true, highlightClipped: true });
    expect(first.pdfX).toBeGreaterThanOrEqual(0);
    expect(first.pdfX + first.pdfWidth).toBeLessThanOrEqual(30);
    expect(first.pdfY).toBeGreaterThanOrEqual(0);
    expect(first.pdfY + first.pdfHeight).toBeLessThanOrEqual(40);
    const form = doc.objects.get(new PDFRef(4, 0).toKey()) as PDFStream;
    form.dict.set('BBox', new PDFArray([0, 0, 15, 40].map(value => new PDFNumber(value))));
    const updated = (await search())![0];
    expect(updated.pdfX + updated.pdfWidth).toBeLessThanOrEqual(15);
    expect(updated.pdfWidth).toBeLessThan(first.pdfWidth);
  });

  it('keeps a completely clipped match searchable without drawing a highlight', async () => {
    const doc = await fixture(80);
    const matches = await searchDocument(doc, 'Needle', false, 'revision', new DocumentSearchIndex(), engine, () => true);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toMatchObject({ highlightVisible: false, highlightClipped: true });
  });

  it.each([30, 55])('keeps a cross-run match searchable with a clipped Form (BBox right %s)', async maxX => {
    const doc = await crossFixture(maxX);
    const matches = await searchDocument(doc, 'AlphaBeta', false, 'revision', new DocumentSearchIndex(), engine, () => true);
    expect(matches).toHaveLength(1);
    const match = matches![0];
    expect(match).toMatchObject({ source: 'cross-run', highlightVisible: true, highlightClipped: true });
    const rectangles = match.highlightRects!;
    expect(rectangles[0].x).toBeCloseTo(10, 4);
    expect(rectangles[0].x + rectangles[0].width).toBeCloseTo(46, 4);
    if (maxX === 30) expect(rectangles).toHaveLength(1);
    else {
      expect(rectangles).toHaveLength(2);
      expect(rectangles[1].x + rectangles[1].width).toBeLessThanOrEqual(maxX);
    }
  });

  it('keeps a cross-run match with wholly unhighlightable pieces navigable', async () => {
    const doc = await crossFixture(30, '0 0 1 1 re W n');
    const matches = await searchDocument(doc, 'AlphaBeta', false, 'revision', new DocumentSearchIndex(), engine, () => true);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toMatchObject({ source: 'cross-run', highlightVisible: false, highlightClipped: true, highlightRects: [] });
  });
});
