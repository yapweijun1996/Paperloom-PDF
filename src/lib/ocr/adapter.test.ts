import { afterEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ recognize: vi.fn(), terminate: vi.fn() }));
const createWorker = vi.hoisted(() => vi.fn());
vi.mock('tesseract.js', () => ({ createWorker }));

import { TesseractOcrAdapter } from './adapter';

const imageData = { width: 100, height: 40 } as ImageData;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Tesseract OCR adapter', () => {
  it('requests structured output and returns word text, confidence and pixel boxes', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    const putImageData = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ putImageData }) };
    vi.stubGlobal('document', { createElement: () => canvas });
    createWorker.mockResolvedValue(worker);
    worker.recognize.mockResolvedValue({ data: { blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: '  PAPERLOOM ', confidence: 93, bbox: { x0: 10, y0: 5, x1: 80, y1: 30 } },
      { text: 'LOW', confidence: 34, bbox: { x0: 1, y0: 1, x1: 10, y1: 10 } },
      { text: 'BROKEN', confidence: 99, bbox: { x0: 4, y0: 4, x1: 4, y1: 10 } },
    ] }] }] }] } });
    const adapter = new TesseractOcrAdapter();
    await expect(adapter.recognize(imageData)).resolves.toEqual([
      { text: 'PAPERLOOM', confidence: 0.93, bbox: { x: 10, y: 5, width: 70, height: 25 } },
    ]);
    expect(createWorker).toHaveBeenCalledWith('eng', 1, {
      workerPath: '/ocr-assets/worker.min.js', corePath: '/ocr-assets',
      langPath: '/ocr-assets', workerBlobURL: false,
    });
    expect(worker.recognize).toHaveBeenCalledWith(canvas, {}, { blocks: true });
    expect(putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    await adapter.terminate();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('treats an empty page as no recognized words', async () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ putImageData: vi.fn() }) }) });
    createWorker.mockResolvedValue(worker);
    worker.recognize.mockResolvedValue({ data: { blocks: null } });
    await expect(new TesseractOcrAdapter().recognize(imageData)).resolves.toEqual([]);
  });

  it('loads the worker, core and model under the configured base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/Paperloom-PDF/');
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ putImageData: vi.fn() }) }) });
    createWorker.mockResolvedValue(worker);
    worker.recognize.mockResolvedValue({ data: { blocks: null } });
    await new TesseractOcrAdapter().recognize(imageData);
    expect(createWorker).toHaveBeenCalledWith('eng', 1, {
      workerPath: '/Paperloom-PDF/ocr-assets/worker.min.js',
      corePath: '/Paperloom-PDF/ocr-assets', langPath: '/Paperloom-PDF/ocr-assets', workerBlobURL: false,
    });
  });
});
