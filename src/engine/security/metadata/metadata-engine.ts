/**
 * Metadata Security Engine — Phase 7.
 */

import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { resolveRef } from '../../parser/parser';
import { getNextObjNum } from '../../writer/serializer';
import type {
  IMetadataEngine,
  MetadataStripOptions,
  MetadataValidationResult,
} from '../types';
import { stringToPdfBytes } from '../crypto/bytes';

const INFO_KEYS = [
  'Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer',
  'CreationDate', 'ModDate', 'Trapped',
] as const;

function resolveDict(
  obj: PDFObject | undefined,
  objects: Map<string, PDFObject>,
): PDFDict | null {
  if (!obj) return null;
  const r = resolveRef(obj, objects);
  return r instanceof PDFDict ? r : null;
}

function getInfoDict(doc: PDFDocumentData): { dict: PDFDict; ref: PDFRef | null } | null {
  const infoObj = doc.xref.trailerDict.get('Info');
  if (!infoObj) return null;
  if (infoObj instanceof PDFRef) {
    const dict = resolveDict(infoObj, doc.objects);
    return dict ? { dict, ref: infoObj } : null;
  }
  if (infoObj instanceof PDFDict) return { dict: infoObj, ref: null };
  return null;
}

function getMetadataStream(doc: PDFDocumentData): {
  stream: PDFStream;
  ref: PDFRef | null;
} | null {
  const meta = doc.catalog.get('Metadata');
  if (!meta) return null;
  if (meta instanceof PDFRef) {
    const obj = doc.objects.get(meta.toKey());
    if (obj instanceof PDFStream) return { stream: obj, ref: meta };
    return null;
  }
  if (meta instanceof PDFStream) return { stream: meta, ref: null };
  return null;
}

function streamToText(stream: PDFStream): string {
  const bytes = stream.getBytes();
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

export class MetadataEngine implements IMetadataEngine {
  readInfo(doc: PDFDocumentData): Record<string, string> {
    const info = getInfoDict(doc);
    if (!info) return {};
    const out: Record<string, string> = {};
    for (const [k] of info.dict.entries()) {
      const s = info.dict.getString(k);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }

  readXmp(doc: PDFDocumentData): string | null {
    const meta = getMetadataStream(doc);
    if (!meta) return null;
    const text = streamToText(meta.stream);
    return text.length > 0 ? text : null;
  }

  editInfo(doc: PDFDocumentData, patch: Record<string, string | null>): PDFDocumentData {
    let info = getInfoDict(doc);
    if (!info) {
      const dict = new PDFDict();
      const ref = new PDFRef(getNextObjNum(doc), 0);
      doc.objects.set(ref.toKey(), dict);
      doc.xref.trailerDict.set('Info', ref);
      info = { dict, ref };
    }

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) info.dict.delete(key);
      else info.dict.set(key, new PDFString(value));
    }

    doc.info = {
      title: info.dict.getString('Title'),
      author: info.dict.getString('Author'),
      subject: info.dict.getString('Subject'),
      keywords: info.dict.getString('Keywords'),
      creator: info.dict.getString('Creator'),
      producer: info.dict.getString('Producer'),
      creationDate: info.dict.getString('CreationDate'),
      modDate: info.dict.getString('ModDate'),
    };

    return doc;
  }

  serializeInfo(doc: PDFDocumentData): PDFDict {
    return getInfoDict(doc)?.dict ?? new PDFDict();
  }

  setXmp(doc: PDFDocumentData, xmpXml: string): PDFDocumentData {
    const bytes = stringToPdfBytes(xmpXml);
    const dict = new PDFDict();
    dict.set('Type', new PDFName('Metadata'));
    dict.set('Subtype', new PDFName('XML'));
    dict.set('Length', new PDFNumber(bytes.length));
    const stream = new PDFStream(dict, bytes, bytes);

    const existing = getMetadataStream(doc);
    if (existing?.ref) {
      doc.objects.set(existing.ref.toKey(), stream);
    } else {
      const ref = new PDFRef(getNextObjNum(doc), 0);
      doc.objects.set(ref.toKey(), stream);
      doc.catalog.set('Metadata', ref);
    }
    return doc;
  }

  stripMetadata(
    doc: PDFDocumentData,
    options: MetadataStripOptions = {},
  ): PDFDocumentData {
    const stripInfo = options.stripInfo !== false;
    const stripXmp = options.stripXmp !== false;
    const stripCustom = options.stripCustom !== false;

    if (stripInfo) {
      const info = getInfoDict(doc);
      if (info) {
        const keep = new Set<string>();
        if (options.preserveProducer) keep.add('Producer');
        if (options.preserveDates) {
          keep.add('CreationDate');
          keep.add('ModDate');
        }
        for (const key of [...info.dict.keys()]) {
          const isStandard = (INFO_KEYS as readonly string[]).includes(key);
          if (keep.has(key)) continue;
          if (!stripCustom && !isStandard) continue;
          info.dict.delete(key);
        }
        if (info.dict.size === 0 && info.ref) {
          doc.xref.trailerDict.delete('Info');
          doc.objects.delete(info.ref.toKey());
        }
      }
      if (!options.preserveProducer && !options.preserveDates) {
        doc.info = {};
      } else {
        doc.info = {
          producer: options.preserveProducer ? doc.info.producer : undefined,
          creationDate: options.preserveDates ? doc.info.creationDate : undefined,
          modDate: options.preserveDates ? doc.info.modDate : undefined,
        };
      }
    }

    if (stripXmp) {
      const meta = getMetadataStream(doc);
      if (meta) {
        doc.catalog.delete('Metadata');
        if (meta.ref) doc.objects.delete(meta.ref.toKey());
      }
    }

    return doc;
  }

  validateMetadata(doc: PDFDocumentData): MetadataValidationResult {
    const info = this.readInfo(doc);
    const infoKeys = Object.keys(info);
    const xmp = this.readXmp(doc);
    const issues: string[] = [];

    if (info.Author && info.Author.length > 500) {
      issues.push('Author field unusually long');
    }
    if (xmp && !xmp.includes('<')) {
      issues.push('Catalog Metadata stream does not look like XML/XMP');
    }
    if (xmp && xmp.toLowerCase().includes('<script')) {
      issues.push('XMP contains script-like content');
    }

    return {
      ok: issues.length === 0,
      hasInfo: infoKeys.length > 0,
      hasXmp: !!xmp,
      infoKeys,
      issues,
    };
  }
}

export const metadataEngine = new MetadataEngine();
