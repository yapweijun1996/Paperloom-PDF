/**
 * Browser canvas render integration test with DOM API mocks.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

const drawnLabels = vi.fn();

function mock2dContext(canvas: { width: number; height: number }): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    font: '10px sans-serif',
    imageSmoothingEnabled: true,
  };

  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'fillText') return drawnLabels;
      if (prop === 'getImageData') {
        return () => ({
          data: new Uint8ClampedArray([255, 255, 255, 255]),
          width: 1,
          height: 1,
        });
      }
      if (prop === 'createImageData') {
        return (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h,
        });
      }
      if (prop === 'measureText') {
        return (text: string) => ({ width: text.length * 6 });
      }
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  class MockCanvas {
    width = 0;
    height = 0;
    style: Record<string, string> = {};
    getContext(type: string) {
      if (type === '2d') return mock2dContext(this);
      return null;
    }
    toDataURL() { return 'data:image/png;base64,'; }
  }

  class MockOffscreenCanvas {
    width = 0;
    height = 0;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext(type: string) {
      if (type === '2d') return mock2dContext(this);
      return null;
    }
  }

  class MockImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data;
      this.width = w;
      this.height = h;
    }
  }

  (globalThis as Record<string, unknown>).HTMLCanvasElement = MockCanvas as unknown as typeof HTMLCanvasElement;
  (globalThis as Record<string, unknown>).OffscreenCanvas = MockOffscreenCanvas as unknown as typeof OffscreenCanvas;
  (globalThis as Record<string, unknown>).ImageData = MockImageData as unknown as typeof ImageData;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return new MockCanvas();
      return {};
    },
    fonts: { check: () => false, add: () => {} },
  };
  (globalThis as Record<string, unknown>).window = {
    devicePixelRatio: 1,
    FontFace: class {
      family: string;
      constructor(family: string) { this.family = family; }
      load() { return Promise.resolve(this); }
    },
  };
});

describe('canvas render integration', () => {
  it('parse → renderPage produces canvas result', async () => {
    const { parsePDF } = await import('../parser/parser');
    const { renderPage } = await import('../render/renderer');

    const MINIMAL_PDF = new TextEncoder().encode(
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000219 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n268\n%%EOF\n',
    );

    const doc = await parsePDF(MINIMAL_PDF);
    const result = await renderPage(doc, 0, {
      scale: 1,
      renderText: true,
      renderPaths: true,
      renderImages: true,
    });

    expect(result.canvas).toBeDefined();
    expect(result.canvas.width).toBeGreaterThan(0);
    expect(result.canvas.height).toBeGreaterThan(0);
    expect(result.pageWidth).toBe(612);
    expect(result.pageHeight).toBe(792);
    expect(result.documentFlow).toBeDefined();
  });

  it.each(['CCITTFaxDecode', 'JBIG2Decode', 'JPXDecode'])('renders a labelled placeholder for %s without changing its encoded stream', async filter => {
    const { PDFDocument } = await import('pdf-lib');
    const { parsePDF } = await import('../parser/parser');
    const { updatePageContent } = await import('../editor/stream-compiler');
    const { renderPage } = await import('../render/renderer');
    const { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } = await import('../types');
    const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const ref = new PDFRef(1000, 0);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stream = new PDFStream(new PDFDict([
      ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Image')],
      ['Width', new PDFNumber(2)], ['Height', new PDFNumber(2)],
      ['Filter', new PDFName(filter)],
    ]), bytes);
    doc.objects.set(ref.toKey(), stream);
    doc.pages[0].resources.set('XObject', new PDFDict([['Scan', ref]]));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('q 60 0 0 60 10 10 cm /Scan Do Q'), doc.objects, false);
    drawnLabels.mockClear();
    await renderPage(doc, 0, { scale: 1 });
    expect(drawnLabels).toHaveBeenCalledWith(`Unsupported image: ${filter}`, 0.5, 0.5, 0.9);
    expect(stream.rawBytes).toEqual(bytes);
    const { serializeDocument } = await import('../writer/serializer');
    const saved = await serializeDocument(doc);
    const independent = await PDFDocument.load(saved);
    expect(independent.getPageCount()).toBe(1);
    const reopened = await parsePDF(saved);
    expect((reopened.objects.get(ref.toKey()) as InstanceType<typeof PDFStream>).rawBytes).toEqual(bytes);
  });

  it.each(['self', 'mutual', 'depth'] as const)('bounds %s Form XObject recursion without blocking repeated placements', async kind => {
    const { PDFDocument } = await import('pdf-lib');
    const { parsePDF } = await import('../parser/parser');
    const { updatePageContent } = await import('../editor/stream-compiler');
    const { renderPage } = await import('../render/renderer');
    const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } = await import('../types');
    const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const count = kind === 'self' ? 1 : kind === 'mutual' ? 2 : 66;
    const refs = Array.from({ length: count }, (_, index) => new PDFRef(1000 + index, 0));
    for (let index = 0; index < count; index++) {
      const next = kind === 'self' ? refs[0] : kind === 'mutual' ? refs[(index + 1) % count] : refs[index + 1];
      const bytes = new TextEncoder().encode(next ? '/Nested Do' : '0 0 5 5 re f');
      const dict = new PDFDict([
        ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Form')],
        ['BBox', new PDFArray([0, 0, 100, 100].map(value => new PDFNumber(value)))],
        ['Resources', new PDFDict([['XObject', new PDFDict(next ? [['Nested', next]] : [])]])],
      ]);
      doc.objects.set(refs[index].toKey(), new PDFStream(dict, bytes, bytes));
    }
    doc.pages[0].resources.set('XObject', new PDFDict([['First', refs[0]]]));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/First Do /First Do'), doc.objects, false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const output = await renderPage(doc, 0, { scale: 1 });
      expect(output.canvas.width).toBe(100);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toMatch(/circular or excessively nested/i);
    } finally { warn.mockRestore(); }
  }, 10000);
});
