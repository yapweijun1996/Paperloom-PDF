/**
 * OCR adapter interface — lives outside @/engine so the PDF core stays dependency-free.
 */

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface OcrAdapter {
  recognize(imageData: ImageData): Promise<OcrWord[]>;
  terminate?(): Promise<void>;
}

/** Stub adapter — returns empty or mock words (tests). */
export class StubOcrAdapter implements OcrAdapter {
  constructor(private mockWords: OcrWord[] = []) {}

  async recognize(_imageData: ImageData): Promise<OcrWord[]> {
    return this.mockWords.slice();
  }
}

/**
 * Tesseract.js adapter — real OCR in the browser.
 * Lazily loads the worker on first recognize() call.
 */
export class TesseractOcrAdapter implements OcrAdapter {
  private workerPromise: Promise<import('tesseract.js').Worker> | null = null;

  private async getWorker() {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const Tesseract = await import('tesseract.js');
        const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
        const assets = `${base}/ocr-assets`;
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: `${assets}/worker.min.js`,
          corePath: assets,
          langPath: assets,
          workerBlobURL: false,
        });
        return worker;
      })();
    }
    return this.workerPromise;
  }

  async recognize(imageData: ImageData): Promise<OcrWord[]> {
    const worker = await this.getWorker();

    // Tesseract accepts canvas / ImageData via a temporary canvas
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.putImageData(imageData, 0, 0);

    // Tesseract.js v6+ disables structured output by default and returns words
    // under blocks/paragraphs/lines rather than a top-level `data.words` array.
    const result = await worker.recognize(canvas, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of result.data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) {
            const text = word.text.trim();
            const { x0, y0, x1, y1 } = word.bbox;
            if (!text || !Number.isFinite(word.confidence) || word.confidence < 35 ||
                ![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
            words.push({ text, confidence: word.confidence / 100,
              bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
          }
        }
      }
    }

    return words;
  }

  async terminate(): Promise<void> {
    if (this.workerPromise) {
      const w = await this.workerPromise;
      await w.terminate();
      this.workerPromise = null;
    }
  }
}

/** Default production adapter. */
export function createDefaultOcrAdapter(): OcrAdapter {
  if (typeof window !== 'undefined') {
    return new TesseractOcrAdapter();
  }
  return new StubOcrAdapter();
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Map OCR pixel boxes (CSS/canvas space, y-down) to PDF user-space (y-up).
 * `scale` is the render scale used when the canvas was produced.
 * `dpr` accounts for devicePixelRatio backing-store sizing.
 */
export function mapOcrWordsToPdf(
  words: OcrWord[],
  pageHeight: number,
  scale: number,
  mediaBoxY = 0,
  dpr = 1,
): OcrWord[] {
  const s = scale * dpr;
  return words.map(w => {
    const pdfX = w.bbox.x / s;
    const pdfHeight = w.bbox.height / s;
    const topCss = w.bbox.y / s;
    const pdfY = pageHeight - topCss - pdfHeight + mediaBoxY;
    return {
      text: w.text,
      confidence: w.confidence,
      bbox: {
        x: pdfX,
        y: pdfY,
        width: w.bbox.width / s,
        height: pdfHeight,
      },
    };
  });
}
