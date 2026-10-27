/**
 * Phase 13 — Document Security Store (DSS) builder for LTV.
 * ISO 32000-2 §12.8.4.3 / PAdES-LT style embedding.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import { appendIncrementalUpdate } from '../../writer/incremental-writer';

export interface DssBuildInput {
  certificates?: Uint8Array[];
  ocspResponses?: Uint8Array[];
  crls?: Uint8Array[];
}

export interface DssBuildResult {
  dssRef: PDFRef;
  bytes: Uint8Array;
  certCount: number;
  ocspCount: number;
  crlCount: number;
}

function makeStream(doc: PDFDocumentData, data: Uint8Array): PDFRef {
  const ref = new PDFRef(getNextObjNum(doc), 0);
  const dict = new PDFDict();
  dict.set('Length', new PDFNumber(data.length));
  const stream = new PDFStream(dict, data);
  doc.objects.set(ref.toKey(), stream);
  return ref;
}

/**
 * Build /DSS dictionary and attach to Catalog.
 */
export function buildDocumentSecurityStore(
  doc: PDFDocumentData,
  input: DssBuildInput,
): { dssRef: PDFRef; modifiedKeys: Set<string>; newObjects: Map<string, PDFObject> } {
  const newObjects = new Map<string, PDFObject>();
  const modifiedKeys = new Set<string>();

  const certRefs: PDFRef[] = [];
  for (const der of input.certificates ?? []) {
    if (!der.length) continue;
    const ref = makeStream(doc, der);
    certRefs.push(ref);
    newObjects.set(ref.toKey(), doc.objects.get(ref.toKey())!);
  }

  const ocspRefs: PDFRef[] = [];
  for (const der of input.ocspResponses ?? []) {
    if (!der.length) continue;
    const ref = makeStream(doc, der);
    ocspRefs.push(ref);
    newObjects.set(ref.toKey(), doc.objects.get(ref.toKey())!);
  }

  const crlRefs: PDFRef[] = [];
  for (const der of input.crls ?? []) {
    if (!der.length) continue;
    const ref = makeStream(doc, der);
    crlRefs.push(ref);
    newObjects.set(ref.toKey(), doc.objects.get(ref.toKey())!);
  }

  const dss = new PDFDict();
  if (certRefs.length) dss.set('Certs', new PDFArray(certRefs));
  if (ocspRefs.length) dss.set('OCSPs', new PDFArray(ocspRefs));
  if (crlRefs.length) dss.set('CRLs', new PDFArray(crlRefs));
  dss.set('VRI', new PDFDict());

  const dssRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(dssRef.toKey(), dss);
  newObjects.set(dssRef.toKey(), dss);

  const catalog = doc.catalog;
  if (catalog instanceof PDFDict) {
    catalog.set('DSS', dssRef);
    for (const [key, obj] of doc.objects) {
      if (obj === catalog) {
        modifiedKeys.add(key);
        break;
      }
    }
    // Also try Root from trailer
    if (modifiedKeys.size === 0 && doc.xref?.trailerDict) {
      const root = doc.xref.trailerDict.get('Root');
      if (root instanceof PDFRef) modifiedKeys.add(root.toKey());
    }
  }

  void PDFName;
  return { dssRef, modifiedKeys, newObjects };
}

/**
 * Embed DSS via incremental update (preserves prior signatures).
 */
export function embedDssIncremental(
  doc: PDFDocumentData,
  input: DssBuildInput,
): DssBuildResult {
  if (!doc.rawBytes || doc.rawBytes.length === 0) {
    throw new Error('Document rawBytes required for DSS incremental embed');
  }

  const { dssRef, modifiedKeys, newObjects } = buildDocumentSecurityStore(doc, input);
  const result = appendIncrementalUpdate(doc, modifiedKeys, newObjects);
  doc.rawBytes = result.bytes;

  return {
    dssRef,
    bytes: result.bytes,
    certCount: input.certificates?.length ?? 0,
    ocspCount: input.ocspResponses?.length ?? 0,
    crlCount: input.crls?.length ?? 0,
  };
}

/**
 * Read DSS summary from catalog if present.
 */
export function readDssSummary(doc: PDFDocumentData): {
  present: boolean;
  certCount: number;
  ocspCount: number;
  crlCount: number;
} | null {
  const catalog = doc.catalog;
  if (!(catalog instanceof PDFDict)) return null;
  const dssRef = catalog.get('DSS');
  if (!(dssRef instanceof PDFRef)) {
    return { present: false, certCount: 0, ocspCount: 0, crlCount: 0 };
  }
  const dss = doc.objects.get(dssRef.toKey());
  if (!(dss instanceof PDFDict)) {
    return { present: true, certCount: 0, ocspCount: 0, crlCount: 0 };
  }

  const count = (key: string) => {
    const a = dss.get(key);
    return a instanceof PDFArray ? a.items.length : 0;
  };

  return {
    present: true,
    certCount: count('Certs'),
    ocspCount: count('OCSPs'),
    crlCount: count('CRLs'),
  };
}
