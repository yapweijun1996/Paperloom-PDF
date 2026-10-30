/**
 * Secure Redaction Engine — Phase 10.
 *
 * Full-page marks and a restricted subset of isolated graphics can be removed.
 * Unsupported cases are rejected without mutation.
 */

import {
  PDFArray,
  PDFDict,
  PDFNull,
  PDFRef,
  type PDFDocumentData,
  type PDFObject,
  type PDFRectangle,
} from '../../types';
import {
  createAnnotationDict,
  type RedactAnnotation,
} from '../../editor/annotation-engine';
import { recordPageContentModifiedKeys } from '../../editor/stream-compiler';
import { getNextObjNum } from '../../writer/serializer';
import { verifyRedaction } from './verify-redaction';
import { prepareWholePageRedaction, WholePageRedactionUnsupportedError } from './whole-page-redaction';
import { preparePartialGraphicsRedaction, PartialGraphicsRedactionUnsupportedError } from './partial-graphics-redaction';
import { prepareIsolatedTextRedaction, IsolatedTextRedactionUnsupportedError } from './isolated-text-redaction';
import { assertCompletePageTree } from '../validate-page-tree';
import type {
  IRedactionEngine,
  RedactionVerification,
  SecureRedactionOptions,
  SecureRedactionResult,
} from '../types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class UnsupportedSecureRedactionError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Secure redaction is unavailable for this document. Redaction marks and document content were not changed.');
    this.name = 'UnsupportedSecureRedactionError';
  }
}

/** Refuse malformed annotation collections too: they may hide a redaction mark. */
function containsRedactionMark(doc: PDFDocumentData): boolean {
  const resolve = (value: PDFObject): PDFObject | undefined => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key)) return undefined;
      seen.add(key);
      const target = doc.objects.get(key);
      if (!target) return undefined;
      value = target;
    }
    return value;
  };
  for (const page of doc.pages) {
    const annots = page.dict.get('Annots');
    if (!annots) continue;
    const array = resolve(annots);
    if (!(array instanceof PDFArray)) throw new UnsupportedSecureRedactionError();
    for (const item of array.items) {
      const annotation = resolve(item);
      if (!(annotation instanceof PDFDict)) throw new UnsupportedSecureRedactionError();
      const subtype = annotation.getName('Subtype');
      if (!subtype || subtype === 'Redact') return true;
    }
  }
  return false;
}

export class RedactionEngine implements IRedactionEngine {
  markRegion(
    doc: PDFDocumentData,
    pageIndex: number,
    rect: Rect,
  ): PDFRef {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.pages.length) {
      throw new Error('Cannot mark a redaction on an invalid page.');
    }
    if (![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0) {
      throw new Error('Cannot mark a redaction with an invalid rectangle.');
    }
    const page = doc.pages[pageIndex];
    if (doc.objects.get(page.ref.toKey()) !== page.dict || doc.pages.some(other => other !== page && other.dict === page.dict)) {
      throw new Error('Cannot safely identify the page for the redaction mark.');
    }
    let annots: PDFObject | undefined = page.dict.get('Annots');
    const seen = new Set<string>();
    while (annots instanceof PDFRef) {
      const key = annots.toKey();
      if (seen.has(key) || seen.size >= 128 || !doc.objects.has(key)) {
        throw new Error('Cannot safely inspect the page annotations.');
      }
      seen.add(key);
      annots = doc.objects.get(key);
    }
    if (annots !== undefined && !(annots instanceof PDFNull) && !(annots instanceof PDFArray)) {
      throw new Error('Cannot safely inspect the page annotations.');
    }
    const pdfRect: PDFRectangle = { ...rect };
    const quadPoints = [
      rect.x, rect.y + rect.height,
      rect.x + rect.width, rect.y + rect.height,
      rect.x, rect.y,
      rect.x + rect.width, rect.y,
    ];
    const annot: RedactAnnotation = {
      type: 'Redact',
      rect: pdfRect,
      color: [0, 0, 0],
      opacity: 0.3,
      quadPoints,
    };
    const objNum = getNextObjNum(doc);
    if (!Number.isSafeInteger(objNum) || objNum <= 0 || objNum > 2_147_483_647) {
      throw new Error('Cannot allocate a redaction annotation.');
    }
    const { dict } = createAnnotationDict(annot, objNum, doc.objects);
    const ref = new PDFRef(objNum, 0);
    // Annotations arrays can be shared between pages. Change only this page,
    // and never report a mark that could not be attached to its /Annots.
    const updated = new PDFArray(annots instanceof PDFArray ? [...annots.items, ref] : [ref]);
    doc.objects.set(ref.toKey(), dict);
    page.dict.set('Annots', updated);
    // Explicit incremental saves must include both the page's new /Annots
    // entry and the newly allocated annotation object.
    recordPageContentModifiedKeys(doc.objects, [page.ref.toKey(), ref.toKey()]);
    return ref;
  }

  /**
   * Clear isolated full pages or wholly covered objects in the restricted
   * graphics subset. Unsupported cases are rejected before mutation.
   */
  async applySecureRedactions(
    doc: PDFDocumentData,
    options: SecureRedactionOptions = {},
  ): Promise<SecureRedactionResult> {
    assertCompletePageTree(doc, reason => { throw new UnsupportedSecureRedactionError(`Secure redaction is unavailable: ${reason}. The document was not changed.`); });
    if (containsRedactionMark(doc)) {
      try {
        return prepareWholePageRedaction(doc, options).commit();
      } catch (error) {
        if (!(error instanceof WholePageRedactionUnsupportedError)) throw error;
        try {
          return prepareIsolatedTextRedaction(doc, options).commit();
        } catch (textError) {
          if (!(textError instanceof IsolatedTextRedactionUnsupportedError)) throw textError;
          try {
            return preparePartialGraphicsRedaction(doc, options).commit();
          } catch (partialError) {
            if (partialError instanceof PartialGraphicsRedactionUnsupportedError) throw new UnsupportedSecureRedactionError(partialError.message);
            throw partialError;
          }
        }
      }
    }
    if (options.metadata === true) throw new UnsupportedSecureRedactionError();
    return { pagesProcessed: 0, textOperatorsRemoved: 0, imageOperatorsRemoved: 0,
      pathOperatorsRemoved: 0, annotationsRemoved: 0, formFieldsRemoved: 0, metadataStripped: false };
  }

  /** Diagnostic only: a clear scan does not prove no recoverable data exists. */
  verifyRedaction(doc: PDFDocumentData, forbidden: string[]): RedactionVerification {
    return verifyRedaction(doc, forbidden);
  }
}

export const redactionEngine = new RedactionEngine();
