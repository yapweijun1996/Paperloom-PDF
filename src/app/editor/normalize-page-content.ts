import type { PDFDocumentData, PDFPageInfo } from '@/engine/types';

type NormalizationEngine = Pick<typeof import('@/engine/browser-core'), 'getPageContentBytes' | 'explodeTJGaps' |
  'OptionalContentVisibility' | 'updatePageContent' | 'MultiStreamBoundaryError'>;

/** Optional TJ normalization must not prevent opening a page that cannot be merged safely. */
export async function normalizePageContent(doc: PDFDocumentData, page: PDFPageInfo, engine: NormalizationEngine): Promise<{ bytes: Uint8Array; warning?: string }> {
  const raw = engine.getPageContentBytes(page, doc.objects);
  const normalized = engine.explodeTJGaps(raw, page, doc.objects, new engine.OptionalContentVisibility(doc.catalog, doc.objects));
  if (normalized === raw) return { bytes: raw };
  try { await engine.updatePageContent(page.contentRefs, normalized, doc.objects); }
  catch (error) {
    if (!(error instanceof engine.MultiStreamBoundaryError)) throw error;
    return { bytes: raw, warning: error.message };
  }
  return { bytes: normalized };
}
