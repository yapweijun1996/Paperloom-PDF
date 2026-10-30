import { annotationSubtype } from '@/engine/content/annotation-subtype';
import { PDFArray, PDFDict, type PDFDocumentData, type PDFRef } from '@/engine/types';
import type { VisualSignature } from '@/engine/browser-core';

// Field previews are optional. Bound their individual and combined raster cost.
const MAX_PREVIEW_DIMENSION = 4096;
const MAX_PREVIEW_PIXELS = 4_000_000;
const MAX_PAGE_PREVIEW_PIXELS = 16_000_000;

type PreviewRenderer = (
  doc: PDFDocumentData, pageIndex: number,
  options: { scale: number; devicePixelRatio: number; renderWidgets: 'supported'; background: string },
) => Promise<{ canvas: Pick<HTMLCanvasElement, 'toDataURL'> }>;

/** Render only tracked widget appearances without changing the document graph. */
export async function renderFieldSignaturePreviews(
  doc: PDFDocumentData, pageIndex: number, signatures: VisualSignature[],
  tracked: ReadonlyMap<string, PDFRef>, scale: number, dpr: number,
  renderPage: PreviewRenderer, isCancelled: () => boolean,
): Promise<{ previews: Record<string, string | null>; failed: boolean } | null> {
  const previews: Record<string, string | null> = {};
  let failed = false;
  let previewPixels = 0;
  const original = doc.pages[pageIndex];
  for (const sig of signatures) {
    if (isCancelled()) return null;
    const ref = tracked.get(sig.id);
    if (sig.pageIndex !== pageIndex || !ref) continue;
    const widget = doc.objects.get(ref.toKey());
    if (!(widget instanceof PDFDict)) continue;
    try {
      if (annotationSubtype(widget, doc.objects) !== 'Widget') continue;
      previews[sig.id] = null;
      const width = Math.ceil(Math.ceil(sig.width * scale) * dpr);
      const height = Math.ceil(Math.ceil(sig.height * scale) * dpr);
      const pixels = width * height;
      if (![width, height, pixels].every(Number.isSafeInteger) || width <= 0 || height <= 0 ||
          width > MAX_PREVIEW_DIMENSION || height > MAX_PREVIEW_DIMENSION ||
          pixels > MAX_PREVIEW_PIXELS || previewPixels + pixels > MAX_PAGE_PREVIEW_PIXELS) {
        failed = true;
        continue;
      }
      // Failed renders also consume the per-page work budget.
      previewPixels += pixels;
      const bounds = { x: sig.x, y: sig.y, width: sig.width, height: sig.height };
      const dict = new PDFDict([...original.dict.entries()]);
      dict.set('Annots', new PDFArray([ref]));
      const page = { ...original, dict, mediaBox: bounds, cropBox: bounds, rotate: 0,
        contentRefs: [], contentInspectionComplete: true };
      const pages = [...doc.pages];
      pages[pageIndex] = page;
      const preview = await renderPage({ ...doc, pages }, pageIndex,
        { scale, devicePixelRatio: dpr, renderWidgets: 'supported', background: 'transparent' });
      if (isCancelled()) return null;
      previews[sig.id] = preview.canvas.toDataURL('image/png');
    } catch (error) {
      if (isCancelled()) return null;
      console.error('[Editor] Signature field preview failed:', error);
      previews[sig.id] = null;
      failed = true;
    }
  }
  return isCancelled() ? null : { previews, failed };
}
