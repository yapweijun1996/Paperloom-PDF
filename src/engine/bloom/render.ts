/**
 * Bloom render — draw laid-out text to a canvas (editor source of truth).
 *
 * Only mask/draw specific blocks (usually the one being edited) so we never
 * double-paint the whole page over the PDF.
 */

import { getCSSFontFamily } from '../fonts/standard14';
import type { BloomBlock, BloomPage } from './types';

export interface BloomRenderOptions {
  mediaBox: { x: number; y: number; width: number; height: number };
  scale: number;
  dpr?: number;
}

function pdfToCanvas(
  pdfX: number,
  pdfY: number,
  mediaBox: { x: number; y: number; width: number; height: number },
  scale: number,
): { x: number; y: number } {
  return {
    x: (pdfX - mediaBox.x) * scale,
    y: (mediaBox.height - (pdfY - mediaBox.y)) * scale,
  };
}

function cssFont(block: BloomBlock, fontSizePx: number): string {
  const run = block.runs[0];
  const bold = run?.bold ? 'bold ' : '';
  const italic = run?.italic ? 'italic ' : '';
  const family = getCSSFontFamily(run?.fontName || 'Helvetica') || 'Helvetica, Arial, sans-serif';
  return `${italic}${bold}${fontSizePx}px ${family}`;
}

export function maskBloomBlocks(
  ctx: CanvasRenderingContext2D,
  blocks: BloomBlock[],
  options: BloomRenderOptions,
): void {
  const { mediaBox, scale } = options;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  for (const block of blocks) {
    const pad = Math.max(3, (block.runs[0]?.fontSize || 12) * 0.25) * scale;
    const tl = pdfToCanvas(block.box.x, block.box.y + block.box.height, mediaBox, scale);
    const br = pdfToCanvas(block.box.x + block.box.width, block.box.y, mediaBox, scale);
    ctx.fillRect(
      Math.min(tl.x, br.x) - pad,
      Math.min(tl.y, br.y) - pad,
      Math.abs(br.x - tl.x) + pad * 2,
      Math.abs(br.y - tl.y) + pad * 2,
    );
  }
  ctx.restore();
}

export function renderBloomBlocks(
  ctx: CanvasRenderingContext2D,
  blocks: BloomBlock[],
  options: BloomRenderOptions,
): void {
  const { mediaBox, scale } = options;

  for (const block of blocks) {
    for (const lb of block.lineBoxes) {
      if (!lb.text) continue;
      const runs = lb.runs.length > 0 ? lb.runs : block.runs;
      let xCursor = lb.x;

      for (const run of runs) {
        if (!run.text) continue;
        const pos = pdfToCanvas(xCursor, lb.baseline, mediaBox, scale);
        const fontSizePx = (run.fontSize || lb.fontSize) * scale;
        ctx.save();
        ctx.font = cssFont({ ...block, runs: [run] }, fontSizePx);
        const [r, g, b] = run.color;
        ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(run.text, pos.x, pos.y);

        if (run.underline) {
          const w = ctx.measureText(run.text).width;
          ctx.beginPath();
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = Math.max(1, fontSizePx * 0.06);
          ctx.moveTo(pos.x, pos.y + 2);
          ctx.lineTo(pos.x + w, pos.y + 2);
          ctx.stroke();
        }

        const advance = (run.avgCharWidth || run.fontSize * 0.5) * run.text.length;
        xCursor += advance;
        ctx.restore();
      }
    }
  }
}

/** @deprecated Prefer mask+render of edited blocks only. */
export function maskBloomTextRegions(
  ctx: CanvasRenderingContext2D,
  page: BloomPage,
  options: BloomRenderOptions,
): void {
  maskBloomBlocks(ctx, page.blocks, options);
}

/** @deprecated Prefer mask+render of edited blocks only. */
export function renderBloomPage(
  ctx: CanvasRenderingContext2D,
  page: BloomPage,
  options: BloomRenderOptions,
): void {
  renderBloomBlocks(ctx, page.blocks, options);
}

/**
 * Mask + draw only the given blocks (editing path).
 */
export function paintBloomBlocksOverPdf(
  ctx: CanvasRenderingContext2D,
  blocks: BloomBlock[],
  options: BloomRenderOptions,
): void {
  maskBloomBlocks(ctx, blocks, options);
  renderBloomBlocks(ctx, blocks, options);
}

/** Full-page paint — avoid in the editor; causes double-text. */
export function paintBloomOverPdf(
  ctx: CanvasRenderingContext2D,
  page: BloomPage,
  options: BloomRenderOptions,
): void {
  paintBloomBlocksOverPdf(ctx, page.blocks, options);
}
