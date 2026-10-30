/**
 * Metadata Security Engine — Phase 7.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';
import { collectMetadataObjectGraph } from './metadata-object-graph';
import type {
  IMetadataEngine,
  MetadataStripOptions,
  MetadataValidationResult,
} from '../types';

const INFO_KEYS = [
  'Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer',
  'CreationDate', 'ModDate', 'Trapped',
] as const;

function resolveDict(
  obj: PDFObject | undefined,
  objects: Map<string, PDFObject>,
): PDFDict | null {
  const seen = new Set<string>();
  while (obj instanceof PDFRef) {
    const key = obj.toKey();
    if (seen.has(key)) return null;
    seen.add(key);
    obj = objects.get(key);
  }
  return obj instanceof PDFDict ? obj : null;
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
    // XML metadata commonly uses either UTF-8 or UTF-16. Detect the BOM,
    // or the leading XML '<' byte pattern when a UTF-16 BOM is absent.
    let encoding = 'utf-8';
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
    else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
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
      else info.dict.set(key, PDFString.fromText(value));
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
    // XMP is XML, not a PDF byte string: truncating UTF-16 code units
    // corrupts non-Latin metadata. Honor supported XML encoding declarations.
    const declaration = /^\uFEFF?\s*<\?xml\b[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i.exec(xmpXml);
    const encoding = declaration?.[2].toLowerCase() ?? 'utf-8';
    if (!['utf-8', 'utf-16', 'utf-16le', 'utf-16be'].includes(encoding)) {
      throw new Error('XMP text must use UTF-8 or UTF-16 encoding.');
    }
    // TextEncoder replaces isolated surrogates; fail instead of silently losing data.
    for (let index = 0; index < xmpXml.length; index++) {
      const code = xmpXml.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = xmpXml.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('XMP text contains an invalid Unicode surrogate.');
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('XMP text contains an invalid Unicode surrogate.');
      }
    }
    let bytes: Uint8Array;
    if (encoding === 'utf-8') {
      bytes = new TextEncoder().encode(xmpXml);
    } else {
      const littleEndian = encoding !== 'utf-16be';
      bytes = new Uint8Array(2 + xmpXml.length * 2);
      bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
      for (let index = 0; index < xmpXml.length; index++) {
        const code = xmpXml.charCodeAt(index);
        bytes[2 + index * 2] = littleEndian ? code & 0xff : code >>> 8;
        bytes[3 + index * 2] = littleEndian ? code >>> 8 : code & 0xff;
      }
    }
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
    const info = stripInfo ? getInfoDict(doc) : null;
    const meta = stripXmp ? getMetadataStream(doc) : null;
    // Resolve both targets before modifying either one. A dangling reference
    // must not be reported as a successful metadata cleanup.
    if (stripInfo && doc.xref.trailerDict.has('Info') && !info) throw new Error('Cannot safely strip invalid Info metadata.');
    if (stripXmp && doc.catalog.has('Metadata') && !meta) throw new Error('Cannot safely strip invalid XMP metadata.');
    const keep = new Set<string>();
    if (options.preserveProducer) keep.add('Producer');
    if (options.preserveDates) {
      keep.add('CreationDate');
      keep.add('ModDate');
    }
    const removedInfoKeys = new Set(info ? [...info.dict.keys()].filter(key =>
      !keep.has(key) && (stripCustom || (INFO_KEYS as readonly string[]).includes(key))) : []);
    const willRemoveInfo = !!info && ((info.ref !== null && info.dict.size === 0) || removedInfoKeys.size > 0);
    const willRemove = willRemoveInfo || !!meta;
    if (willRemove && hasDocumentSignature(doc)) throw new SignedDocumentEditError();
    if (willRemove) {
      // Shared metadata could remain reachable, or deleting its object could
      // break other content. Refuse before changing either metadata target.
      const sensitiveRoots: PDFObject[] = meta ? [meta.stream] : [];
      if (info && willRemoveInfo) {
        for (const key of removedInfoKeys) sensitiveRoots.push(info.dict.get(key)!);
      }
      const sensitive = collectMetadataObjectGraph(sensitiveRoots, doc.objects, () => {
        throw new Error('Cannot safely inspect shared metadata references.');
      });
      const pending: PDFObject[] = [doc.xref.trailerDict];
      // The trailer Info edge is excluded below so we can check whether the
      // dictionary itself is shared. Still inspect fields explicitly retained
      // by preserveProducer, preserveDates or stripCustom=false.
      if (info && willRemoveInfo) {
        for (const [key, value] of info.dict.entries()) if (!removedInfoKeys.has(key)) pending.push(value);
      }
      const seen = new Set<PDFObject>();
      while (pending.length) {
        const object = pending.pop()!;
        if (seen.has(object)) continue;
        seen.add(object);
        if (seen.size > 100_000) throw new Error('Cannot safely inspect shared metadata references.');
        if ((willRemoveInfo && object === info?.dict) || sensitive.values.has(object) ||
            (object instanceof PDFRef && sensitive.refs.has(object.toKey()))) {
          throw new Error('Cannot safely strip shared metadata.');
        }
        if (object instanceof PDFRef) {
          const resolved = doc.objects.get(object.toKey());
          if (resolved) pending.push(resolved);
        } else if (object instanceof PDFArray) pending.push(...object.items);
        else if (object instanceof PDFStream) pending.push(object.dict);
        else if (object instanceof PDFDict) {
          for (const [key, value] of object.entries()) {
            if ((willRemoveInfo && object === doc.xref.trailerDict && key === 'Info') ||
                (meta && object === doc.catalog && key === 'Metadata')) continue;
            pending.push(value);
          }
        }
      }
      const rootRef = doc.xref.trailerDict.getRef('Root');
      if (!rootRef || doc.objects.get(rootRef.toKey()) !== doc.catalog || doc.catalog.getName('Type') !== 'Catalog') {
        throw new Error('Cannot safely strip metadata without a valid document catalog.');
      }
      // The original file can contain old Info/XMP bytes even after unlinking.
      doc.requiresFullRewrite = true;
    }

    if (stripInfo) {
      if (info) {
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
