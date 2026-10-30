import { describe, expect, it } from 'vitest';
import { PDFDict, PDFRef, type PDFPageInfo } from '@/engine/types';
import { signatureBoxOnPage, signatureFieldBoxOnPage, signaturePagePoint } from './signature-page-geometry';
const page = (rotate: number): PDFPageInfo => ({
  index: 0, ref: new PDFRef(1, 0), dict: new PDFDict(), resources: new PDFDict(), contentRefs: [],
  mediaBox: { x: 0, y: 0, width: 400, height: 400 },
  cropBox: { x: 50, y: 75, width: 300, height: 250 }, rotate,
});
const field = { x: 100, y: 150, width: 200, height: 80 };
describe('signature geometry matches the visible rotated page', () => {
  it.each([[0,50,95,200,80],[90,75,50,80,200],[180,50,75,200,80],[270,95,50,80,200]])('maps rotation %i', (rotation,left,top,width,height) => {
    expect(signatureFieldBoxOnPage(page(rotation), field, 1)).toEqual({ left, top, width, height });
    const box = signatureBoxOnPage(page(rotation), field, 1);
    expect(box.left + box.width / 2).toBe(left + width / 2);
    expect(box.top + box.height / 2).toBe(top + height / 2);
    expect(box.width).toBe(200); expect(box.height).toBe(80);
  });
  it.each([[0,50,325],[90,50,75],[180,350,75],[270,350,325]])('intersects overhanging CropBox at %i', (rotation, x, y) => {
    const p = page(rotation);
    p.mediaBox = { x: 50, y: 75, width: 300, height: 250 };
    p.cropBox = { x: 0, y: 0, width: 400, height: 400 };
    expect(signaturePagePoint(p, { x: 0, y: 0 }, 1)).toEqual({ pdfX: x, pdfY: y });
  });
});
