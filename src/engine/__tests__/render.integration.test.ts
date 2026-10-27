/**
 * Browser canvas render integration test with DOM API mocks.
 */
import { describe, it, expect, beforeAll } from 'vitest';

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
});
