'use client';

import type { PDFDocumentData } from '@/engine/types';
import { detectPdfConformance } from '../pdf-conformance';
import { Notice } from '../ui';

/** The declarations are self-reported; this app does not validate conformance. */
export function PdfConformanceNotice({ doc, isDirty, announce = true }: { doc: PDFDocumentData | null; isDirty: boolean; announce?: boolean }) {
  if (!doc || !isDirty) return null;
  const result = detectPdfConformance(doc);
  if (result.status === 'none') return null;
  const message = result.status === 'claimed'
    ? `This PDF declares ${result.formats.join(' and ')} conformance. Editing or saving may invalidate that claim; Paperloom does not verify compliance.`
    : 'This PDF’s metadata could not be checked for PDF/A or PDF/UA declarations. Editing or saving may affect compliance.';
  return (
    <div className="border-b border-app bg-panel px-4 py-2">
      <Notice tone="warning" live={announce} className="text-xs">{message}</Notice>
    </div>
  );
}
