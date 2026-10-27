/**
 * PDF Integrity Scanner — Phase 12.
 */

import {
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import type { IIntegrityScanner } from '../types';

export interface IntegrityIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  objectKey?: string;
}

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
  objectCount: number;
  pageCount: number;
  hasEncrypt: boolean;
  hasInfo: boolean;
  brokenRefs: number;
  duplicateKeys: number;
  corruptStreams: number;
  repaired: string[];
}

export class IntegrityScanner implements IIntegrityScanner {
  async scan(doc: PDFDocumentData): Promise<{ ok: boolean; issues: string[] }> {
    const report = this.inspect(doc);
    return {
      ok: report.ok,
      issues: report.issues.map((i) => `[${i.severity}] ${i.message}`),
    };
  }

  inspect(doc: PDFDocumentData, options: { repair?: boolean } = {}): IntegrityReport {
    const issues: IntegrityIssue[] = [];
    const repaired: string[] = [];
    let brokenRefs = 0;
    let corruptStreams = 0;

    if (!doc.xref.trailerDict.has('Root')) {
      issues.push({ severity: 'error', code: 'TRAILER_NO_ROOT', message: 'Trailer missing /Root' });
    }
    if (!doc.xref.trailerDict.has('Size')) {
      issues.push({ severity: 'warning', code: 'TRAILER_NO_SIZE', message: 'Trailer missing /Size' });
    }

    const rootRef = doc.xref.trailerDict.getRef('Root');
    if (rootRef && !doc.objects.has(rootRef.toKey())) {
      issues.push({
        severity: 'error',
        code: 'BROKEN_ROOT',
        message: `Catalog ref ${rootRef} not found`,
        objectKey: rootRef.toKey(),
      });
      brokenRefs++;
    }

    for (const [key, entry] of doc.xref.entries) {
      if (entry.type === 'f') continue;
      if (!doc.objects.has(key) && entry.compressedObjNum === undefined) {
        issues.push({
          severity: 'warning',
          code: 'XREF_MISSING_OBJECT',
          message: `XRef lists ${key} but object map has no entry`,
          objectKey: key,
        });
      }
    }

    const byNum = new Map<number, string[]>();
    for (const key of doc.objects.keys()) {
      const num = parseInt(key.split('_')[0], 10);
      const list = byNum.get(num) ?? [];
      list.push(key);
      byNum.set(num, list);
    }
    let duplicateKeys = 0;
    for (const [num, keys] of byNum) {
      if (keys.length > 1) {
        duplicateKeys++;
        issues.push({
          severity: 'info',
          code: 'MULTI_GEN',
          message: `Object ${num} has multiple generations: ${keys.join(', ')}`,
        });
      }
    }

    for (const [key, obj] of doc.objects) {
      for (const ref of collectRefs(obj)) {
        if (!doc.objects.has(ref.toKey()) && !isFreeInXref(doc, ref)) {
          brokenRefs++;
          issues.push({
            severity: 'warning',
            code: 'BROKEN_REF',
            message: `Broken reference ${ref} from ${key}`,
            objectKey: key,
          });
          if (options.repair) repaired.push(`Noted broken ref ${ref} in ${key}`);
        }
      }

      if (obj instanceof PDFStream) {
        const len = obj.dict.getNumber('Length');
        if (len !== undefined && len < 0) {
          corruptStreams++;
          issues.push({
            severity: 'error',
            code: 'CORRUPT_STREAM_LENGTH',
            message: `Stream ${key} has negative /Length`,
            objectKey: key,
          });
        }
        if (obj.rawBytes.length === 0 && (len ?? 0) > 0) {
          corruptStreams++;
          issues.push({
            severity: 'warning',
            code: 'EMPTY_STREAM',
            message: `Stream ${key} claims length ${len} but has empty bytes`,
            objectKey: key,
          });
          if (options.repair) {
            obj.dict.set('Length', new PDFNumber(0));
            repaired.push(`Reset Length on ${key}`);
          }
        }
      }
    }

    if (doc.pages.length === 0) {
      issues.push({ severity: 'error', code: 'NO_PAGES', message: 'Document has no pages' });
    }

    if (doc.rawBytes && doc.rawBytes.length > 0) {
      const text = new TextDecoder('latin1').decode(
        doc.rawBytes.subarray(Math.max(0, doc.rawBytes.length - 2048)),
      );
      const eofCount = (text.match(/%%EOF/g) ?? []).length;
      if (eofCount > 1) {
        issues.push({
          severity: 'info',
          code: 'INCREMENTAL',
          message: `Document appears to have ${eofCount} incremental EOF markers`,
        });
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    return {
      ok: errors === 0,
      issues,
      objectCount: doc.objects.size,
      pageCount: doc.pages.length,
      hasEncrypt: doc.xref.trailerDict.has('Encrypt'),
      hasInfo: doc.xref.trailerDict.has('Info'),
      brokenRefs,
      duplicateKeys,
      corruptStreams,
      repaired,
    };
  }
}

function collectRefs(obj: PDFObject, out: PDFRef[] = []): PDFRef[] {
  if (obj instanceof PDFRef) {
    out.push(obj);
    return out;
  }
  if (obj instanceof PDFArray) {
    for (const item of obj.items) collectRefs(item, out);
    return out;
  }
  if (obj instanceof PDFDict) {
    for (const v of obj.values()) collectRefs(v, out);
    return out;
  }
  if (obj instanceof PDFStream) collectRefs(obj.dict, out);
  return out;
}

function isFreeInXref(doc: PDFDocumentData, ref: PDFRef): boolean {
  return doc.xref.entries.get(ref.toKey())?.type === 'f';
}

export const integrityScanner = new IntegrityScanner();
