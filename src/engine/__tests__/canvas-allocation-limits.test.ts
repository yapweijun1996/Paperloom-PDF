import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePDF } from '../parser/parser';
import { renderPageToCanvas, renderImagePreviewLayers } from '../render/renderer';
import type { ImageItem } from '../content/interpreter';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { updatePageContent } from '../editor/stream-compiler';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

function canvasHarness() {
  const dimensions: number[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_, property) => property === 'measureText' ? () => ({ width: 1 }) : () => {},
    set: () => true,
  });
  const createElement = vi.fn(() => {
    const canvas = { style: {}, getContext: () => ctx, _width: 0, _height: 0,
      set width(value: number) { dimensions.push(value); this._width = value; },
      get width() { return this._width; },
      set height(value: number) { dimensions.push(value); this._height = value; },
      get height() { return this._height; },
    };
    return canvas;
  });
  vi.stubGlobal('document', { createElement, fonts: { check: () => true, add: () => {} } });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  return { dimensions, createElement };
}

afterEach(() => vi.unstubAllGlobals());

describe('canvas allocation limits', () => {
  it.each([
    ['excessive page side', 200000, 300, 1, 1],
    ['excessive page area', 8000, 5000, 1, 1],
    ['excessive scale', 200, 300, 1000, 1],
    ['excessive pixel ratio', 200, 300, 1, 1000],
    ['non-finite scale', 200, 300, Number.POSITIVE_INFINITY, 1],
    ['negative scale', 200, 300, -1, 1],
    ['invalid pixel ratio', 200, 300, 1, 0],
  ])('rejects %s before assigning any canvas dimensions', async (_name, width, height, scale, devicePixelRatio) => {
    const doc = await fixture();
    doc.pages[0].mediaBox = { x: 0, y: 0, width, height };
    doc.pages[0].cropBox = { x: 0, y: 0, width, height };
    const harness = canvasHarness();
    await expect(renderPageToCanvas(doc.pages[0], doc.objects, { scale, devicePixelRatio })).rejects.toThrow(/canvas.*(limit|dimension|scale)/i);
    expect(harness.dimensions).toEqual([]);
  });

  it('renders a normal page at the requested pixel ratio', async () => {
    const doc = await fixture();
    const harness = canvasHarness();
    const result = await renderPageToCanvas(doc.pages[0], doc.objects, { scale: 1.5, devicePixelRatio: 2 });
    expect(result.canvas.width).toBe(600);
    expect(result.canvas.height).toBe(900);
    expect(harness.dimensions).toEqual([600, 900]);
  });

  it('rejects oversized soft-mask surfaces before allocating them', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    page.mediaBox = { ...page.mediaBox, width: 100000 };
    const groupRef = new PDFRef(500, 0);
    const group = new PDFStream(new PDFDict(), new Uint8Array(), new Uint8Array());
    doc.objects.set(groupRef.toKey(), group);
    page.resources.set('ExtGState', new PDFDict([['Mask', new PDFDict([
      ['SMask', new PDFDict([['S', new PDFName('Alpha')], ['G', groupRef]])],
    ])]]));
    await updatePageContent(page.contentRefs, new TextEncoder().encode('/Mask gs 0 0 20 20 re f'), doc.objects, false);
    const harness = canvasHarness();
    await expect(renderPageToCanvas(page, doc.objects, { scale: 1 })).rejects.toThrow(/canvas.*limit/i);
    expect(harness.dimensions).toEqual([200, 300]);
  });

  it('rejects oversized transparency group buffers before allocating them', async () => {
    const doc = await fixture();
    const ref = new PDFRef(501, 0);
    const form = new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Form')],
      ['BBox', new PDFArray([0, 0, 100000, 200].map(value => new PDFNumber(value)))],
      ['Group', new PDFDict([['S', new PDFName('Transparency')], ['I', new PDFBoolean(true)]])],
    ]), new Uint8Array(), new Uint8Array());
    doc.objects.set(ref.toKey(), form);
    doc.pages[0].resources.set('XObject', new PDFDict([['Form', ref]]));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Form Do'), doc.objects, false);
    const harness = canvasHarness();
    await expect(renderPageToCanvas(doc.pages[0], doc.objects, { scale: 1 })).rejects.toThrow(/canvas.*limit/i);
    expect(harness.dimensions).toEqual([200, 300]);
  });

  it('rejects an oversized selected-image preview before allocating the image canvas', async () => {
    const doc = await fixture();
    const harness = canvasHarness();
    const item: ImageItem = { type: 'image', name: 'Image', x: 0, y: 0, width: 100000, height: 100,
      ctm: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, fillAlpha: 1, blendMode: 'Normal', softMask: null, clipPaths: [] };
    await expect(renderImagePreviewLayers(doc.pages[0], doc.objects, item, 1)).rejects.toThrow(/canvas.*(limit|dimension|scale)/i);
    expect(harness.dimensions).toEqual([]);
  });
});
