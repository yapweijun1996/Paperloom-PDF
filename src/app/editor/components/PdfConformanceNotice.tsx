'use client';

import type { PDFDocumentData } from '@/engine/types';
import { detectPdfConformance } from '../pdf-conformance';

/** The declarations are self-reported; this app does not validate conformance. */
export function PdfConformanceNotice({ doc, isDirty, announce = true }: { doc: PDFDocumentData | null; isDirty: boolean; announce?: boolean }) {
  if (!doc || !isDirty) return null;
  const result = detectPdfConformance(doc);
  if (result.status === 'none') return null;
  const message = result.status === 'claimed'
    ? `This PDF declares ${result.formats.join(' and ')} conformance. Editing or saving may invalidate that claim; Paperloom does not verify compliance.`
    : 'This PDF’s metadata could not be checked for PDF/A or PDF/UA declarations. Editing or saving may affect compliance.';
  return <div role={announce ? 'status' : undefined} className="border-b border-amber-500/40 bg-amber-100 px-4 py-2 text-xs text-amber-950">{message}</div>;
}
