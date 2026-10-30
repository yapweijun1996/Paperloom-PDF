import { SessionDocumentEditor } from '@/engine/session/document-edit';
import type { PDFDocumentData, PDFPageInfo } from '@/engine/types';
import { mapOcrWordsToPdf, type OcrAdapter, type OcrWord } from '@/lib/ocr/adapter';

/** The current mapper only supports an unrotated, uncropped page with x origin zero. */
export function supportsOcrPageGeometry(page: PDFPageInfo): boolean {
  const { mediaBox: media, cropBox: crop } = page;
  return page.rotate === 0 && media.x === 0 && crop.x === media.x && crop.y === media.y &&
    crop.width === media.width && crop.height === media.height;
}

interface OcrOperation {
  doc: PDFDocumentData;
  pageKey: string;
  pageHeight: number;
  mediaBoxY: number;
  scale: number;
  dpr: number;
  image: ImageData;
  isCurrent: () => boolean;
  revision: number;
  getRevision: () => number;
  createAdapter: () => Promise<OcrAdapter>;
  enqueue: (apply: (isCurrent: () => boolean) => Promise<void>) => Promise<void>;
  insert: (doc: PDFDocumentData, page: number, words: OcrWord[]) => Promise<void>;
  committed: (editor: SessionDocumentEditor, page: number) => void;
}

/** Recognize a captured page and publish only against the unchanged document. */
export async function runOcrOperation(operation: OcrOperation): Promise<'applied' | 'empty' | 'cancelled'> {
  const { doc, isCurrent, revision, getRevision } = operation;
  let adapter: OcrAdapter | undefined;
  const isUnchanged = () => isCurrent() && getRevision() === revision;
  const assertUnchanged = () => {
    if (!isUnchanged()) throw new Error('The document changed during OCR. Run OCR again.');
  };
  try {
    adapter = await operation.createAdapter();
    if (!isCurrent()) return 'cancelled';
    assertUnchanged();
    const words = await adapter.recognize(operation.image);
    if (!isCurrent()) return 'cancelled';
    assertUnchanged();
    const mapped = mapOcrWordsToPdf(words, operation.pageHeight, operation.scale, operation.mediaBoxY, operation.dpr);
    if (!mapped.length) return 'empty';
    await operation.enqueue(async queuedCurrent => {
      assertUnchanged();
      if (!queuedCurrent()) return;
      const pageIndex = doc.pages.findIndex(page => page.ref.toKey() === operation.pageKey);
      if (pageIndex < 0) throw new Error('The OCR page is no longer available. Run OCR again.');
      const editor = new SessionDocumentEditor();
      await editor.edit(doc, 'ocr', staged => operation.insert(staged, pageIndex, mapped), {
        isCurrent: () => queuedCurrent() && isUnchanged(),
      });
      assertUnchanged();
      if (queuedCurrent()) operation.committed(editor, pageIndex);
    });
    return isCurrent() ? 'applied' : 'cancelled';
  } catch (error) {
    if (!isCurrent()) return 'cancelled';
    throw error;
  } finally {
    try { await adapter?.terminate?.(); } catch { /* Cleanup must not replace the OCR result. */ }
  }
}
