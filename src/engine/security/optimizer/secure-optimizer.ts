/**
 * Secure Optimizer — Phase 14.
 * Shrinks PDFs while preserving encryption and security properties.
 */

import type { PDFDocumentData } from '../../types';
import { PDFRef } from '../../types';
import { garbageCollect } from '../../optimize/garbage-collect';
import type { ISecureOptimizer } from '../types';

export interface OptimizeReport {
  beforeObjects: number;
  afterObjects: number;
  removedObjects: number;
  deduplicatedStreams: number;
  preservedEncrypt: boolean;
  notes: string[];
}

export class SecureOptimizer implements ISecureOptimizer {
  async optimize(doc: PDFDocumentData): Promise<PDFDocumentData> {
    await this.optimizeWithReport(doc);
    return doc;
  }

  async optimizeWithReport(doc: PDFDocumentData): Promise<OptimizeReport> {
    const notes: string[] = [];
    const beforeObjects = doc.objects.size;
    const preservedEncrypt = doc.xref.trailerDict.has('Encrypt');

    const rootRef = doc.xref.trailerDict.getRef('Root');
    const infoRef = doc.xref.trailerDict.getRef('Info');
    const encryptRef = doc.xref.trailerDict.getRef('Encrypt');
    const roots: PDFRef[] = [];
    if (rootRef) roots.push(rootRef);
    if (infoRef) roots.push(infoRef);
    if (encryptRef) roots.push(encryptRef);

    // This optimizer does not apply a stream remapping. Keep the report honest
    // and avoid introducing shared editable streams without copy-on-write.
    const deduplicatedStreams = 0;
    notes.push('Stream deduplication skipped to preserve independent editing');

    let removedObjects = 0;
    try {
      const gc = garbageCollect(doc.objects, roots, {
        deduplicateStreams: false,
        // Never drop Encrypt
        extraRoots: encryptRef ? [encryptRef] : [],
      });
      doc.objects.clear();
      for (const [k, v] of gc.objects) doc.objects.set(k, v);
      removedObjects = gc.removedKeys.length;
      if (removedObjects > 0) notes.push(`Removed ${removedObjects} unused object(s)`);
    } catch {
      notes.push('Garbage collection skipped');
    }

    // Ensure Encrypt still present if it was
    if (preservedEncrypt && !doc.xref.trailerDict.has('Encrypt')) {
      notes.push('WARNING: Encrypt dict was lost — unexpected');
    } else if (preservedEncrypt) {
      notes.push('Preserved encryption dictionary');
    }

    if (notes.length === 0) notes.push('No further optimization opportunities');

    return {
      beforeObjects,
      afterObjects: doc.objects.size,
      removedObjects,
      deduplicatedStreams,
      preservedEncrypt,
      notes,
    };
  }
}

export const secureOptimizer = new SecureOptimizer();
