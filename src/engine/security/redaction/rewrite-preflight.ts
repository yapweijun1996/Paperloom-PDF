import { garbageCollect, rootsFromTrailer } from '../../optimize/garbage-collect';
import { assertFullRewriteLayoutSafe, assertFullRewriteSafe } from '../../writer/serializer';
import type { PDFDocumentData } from '../../types';

/** Verify a staged rewrite before publishing it to the live document. */
export function assertRedactionRewriteSafe(doc: PDFDocumentData, refuse: (reason: string) => never): void {
  try {
    assertFullRewriteSafe({ ...doc, requiresFullRewrite: true });
    const roots = rootsFromTrailer(doc.xref.trailerDict);
    const reachable = garbageCollect(doc.objects, roots, { deduplicateStreams: false }).objects;
    assertFullRewriteLayoutSafe(doc, reachable);
  } catch {
    refuse('the rewritten document cannot be safely serialized');
  }
}
