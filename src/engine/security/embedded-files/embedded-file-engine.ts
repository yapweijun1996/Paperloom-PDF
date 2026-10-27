/**
 * Embedded File Security Engine — Phase 8.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { resolveRef } from '../../parser/parser';
import type {
  AttachmentScanResult,
  AttachmentScanner,
  AttachmentValidationResult,
  EmbeddedAttachment,
  IEmbeddedFileSecurityEngine,
} from '../types';

function asDict(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFDict | null {
  if (!obj) return null;
  const r = resolveRef(obj, objects);
  return r instanceof PDFDict ? r : null;
}

function asStream(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFStream | null {
  if (!obj) return null;
  const r = resolveRef(obj, objects);
  return r instanceof PDFStream ? r : null;
}

function nameTreeFiles(
  namesDict: PDFDict,
  objects: Map<string, PDFObject>,
): Array<{ name: string; filespec: PDFDict }> {
  const out: Array<{ name: string; filespec: PDFDict }> = [];

  const names = namesDict.get('Names');
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const nameObj = names.get(i);
      const fsObj = names.get(i + 1);
      const name =
        nameObj instanceof PDFString
          ? nameObj.value
          : nameObj instanceof PDFName
            ? nameObj.name
            : String(nameObj);
      const filespec = asDict(fsObj, objects);
      if (filespec) out.push({ name, filespec });
    }
  }

  const kids = namesDict.get('Kids');
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.length; i++) {
      const kid = asDict(kids.get(i), objects);
      if (kid) out.push(...nameTreeFiles(kid, objects));
    }
  }

  return out;
}

function filespecToAttachment(
  name: string,
  filespec: PDFDict,
  objects: Map<string, PDFObject>,
  source: EmbeddedAttachment['source'],
  pageIndex?: number,
): EmbeddedAttachment {
  const ef = asDict(filespec.get('EF'), objects);
  let stream: PDFStream | null = null;
  let streamKey: string | undefined;
  if (ef) {
    const f = ef.get('F') ?? ef.get('UF');
    if (f instanceof PDFRef) streamKey = f.toKey();
    stream = asStream(f, objects);
  }

  const desc = filespec.getString('Desc') ?? filespec.getString('Description');
  const params = stream ? asDict(stream.dict.get('Params'), objects) : null;
  const mime =
    stream?.dict.getName('Subtype') ??
    filespec.getName('Subtype') ??
    undefined;

  return {
    name: filespec.getString('UF') ?? filespec.getString('F') ?? name,
    description: desc,
    mimeType: mime,
    size: params?.getNumber('Size') ?? stream?.rawBytes.length,
    creationDate: params?.getString('CreationDate'),
    modDate: params?.getString('ModDate'),
    streamKey,
    source,
    pageIndex,
  };
}

export class EmbeddedFileSecurityEngine implements IEmbeddedFileSecurityEngine {
  listAttachments(doc: PDFDocumentData): EmbeddedAttachment[] {
    const results: EmbeddedAttachment[] = [];
    const seen = new Set<string>();

    // Catalog /Names → /EmbeddedFiles
    const names = asDict(doc.catalog.get('Names'), doc.objects);
    if (names) {
      const embedded = asDict(names.get('EmbeddedFiles'), doc.objects);
      if (embedded) {
        for (const { name, filespec } of nameTreeFiles(embedded, doc.objects)) {
          const att = filespecToAttachment(name, filespec, doc.objects, 'Names');
          if (!seen.has(att.name)) {
            seen.add(att.name);
            results.push(att);
          }
        }
      }
    }

    // FileAttachment annotations on pages
    for (const page of doc.pages) {
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        if (!(item instanceof PDFRef)) continue;
        const dict = asDict(item, doc.objects);
        if (!dict || dict.getName('Subtype') !== 'FileAttachment') continue;
        const fs = asDict(dict.get('FS'), doc.objects);
        if (!fs) continue;
        const name = dict.getString('Contents') ?? fs.getString('F') ?? `attachment-${page.index}-${i}`;
        const att = filespecToAttachment(name, fs, doc.objects, 'FileAttachment', page.index);
        if (!seen.has(att.name)) {
          seen.add(att.name);
          results.push(att);
        }
      }
    }

    return results;
  }

  getAttachmentBytes(doc: PDFDocumentData, name: string): Uint8Array | null {
    const att = this.listAttachments(doc).find((a) => a.name === name);
    if (!att?.streamKey) return null;
    const stream = doc.objects.get(att.streamKey);
    if (!(stream instanceof PDFStream)) return null;
    return stream.getBytes();
  }

  removeAttachment(doc: PDFDocumentData, name: string): boolean {
    let removed = false;

    const names = asDict(doc.catalog.get('Names'), doc.objects);
    if (names) {
      const embedded = asDict(names.get('EmbeddedFiles'), doc.objects);
      if (embedded) {
        removed = removeFromNameTree(embedded, name, doc) || removed;
        // If empty Names array, clear EmbeddedFiles
        const namesArr = embedded.get('Names');
        if (namesArr instanceof PDFArray && namesArr.length === 0) {
          names.delete('EmbeddedFiles');
        }
      }
      if ([...names.keys()].length === 0) {
        doc.catalog.delete('Names');
      }
    }

    for (const page of doc.pages) {
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
      if (!(arr instanceof PDFArray)) continue;
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr.get(i);
        if (!(item instanceof PDFRef)) continue;
        const dict = asDict(item, doc.objects);
        if (!dict || dict.getName('Subtype') !== 'FileAttachment') continue;
        const fs = asDict(dict.get('FS'), doc.objects);
        const n = dict.getString('Contents') ?? fs?.getString('F') ?? '';
        if (n === name || fs?.getString('UF') === name || fs?.getString('F') === name) {
          arr.items.splice(i, 1);
          doc.objects.delete(item.toKey());
          removed = true;
        }
      }
    }

    return removed;
  }

  removeAllAttachments(doc: PDFDocumentData): number {
    const names = this.listAttachments(doc).map((a) => a.name);
    let count = 0;
    for (const n of names) {
      if (this.removeAttachment(doc, n)) count++;
    }
    return count;
  }

  validateAttachments(doc: PDFDocumentData): AttachmentValidationResult {
    const list = this.listAttachments(doc);
    const issues: string[] = [];
    for (const att of list) {
      if (!att.streamKey) issues.push(`Attachment "${att.name}" missing embedded stream`);
      else if (!doc.objects.has(att.streamKey)) {
        issues.push(`Attachment "${att.name}" stream object missing`);
      }
      if (att.size !== undefined && att.size > 100 * 1024 * 1024) {
        issues.push(`Attachment "${att.name}" exceeds 100MB`);
      }
      const lower = att.name.toLowerCase();
      if (/\.(exe|bat|cmd|scr|js|vbs|ps1)$/.test(lower)) {
        issues.push(`Attachment "${att.name}" has a potentially dangerous extension`);
      }
    }
    return { ok: issues.length === 0, count: list.length, issues };
  }

  async scanAttachments(
    doc: PDFDocumentData,
    scanner?: AttachmentScanner,
  ): Promise<AttachmentScanResult[]> {
    const list = this.listAttachments(doc);
    const results: AttachmentScanResult[] = [];
    const defaultScanner: AttachmentScanner = async (name, bytes) => {
      // Heuristic hook — not a real AV
      const head = bytes.subarray(0, 4);
      const isMz = head[0] === 0x4d && head[1] === 0x5a;
      if (isMz) return { threat: true, detail: 'PE/MZ executable header detected' };
      if (/\.(exe|bat|cmd|scr)$/i.test(name)) {
        return { threat: true, detail: 'Dangerous file extension' };
      }
      return { threat: false };
    };
    const scan = scanner ?? defaultScanner;
    for (const att of list) {
      const bytes = this.getAttachmentBytes(doc, att.name) ?? new Uint8Array(0);
      const r = await scan(att.name, bytes);
      results.push({ name: att.name, threat: r.threat, detail: r.detail });
    }
    return results;
  }

  /** Whether extraction should be blocked under current permissions. */
  canExtract(copyAllowed: boolean): boolean {
    return copyAllowed;
  }
}

function removeFromNameTree(
  namesDict: PDFDict,
  targetName: string,
  doc: PDFDocumentData,
): boolean {
  let removed = false;
  const names = namesDict.get('Names');
  if (names instanceof PDFArray) {
    for (let i = names.length - 2; i >= 0; i -= 2) {
      const nameObj = names.get(i);
      const name =
        nameObj instanceof PDFString
          ? nameObj.value
          : nameObj instanceof PDFName
            ? nameObj.name
            : String(nameObj);
      const fsObj = names.get(i + 1);
      const fs = asDict(fsObj, doc.objects);
      const fname = fs?.getString('UF') ?? fs?.getString('F') ?? name;
      if (name === targetName || fname === targetName) {
        // Delete EF stream if present
        if (fs) {
          const ef = asDict(fs.get('EF'), doc.objects);
          const f = ef?.get('F') ?? ef?.get('UF');
          if (f instanceof PDFRef) doc.objects.delete(f.toKey());
          if (fsObj instanceof PDFRef) doc.objects.delete(fsObj.toKey());
        }
        names.items.splice(i, 2);
        removed = true;
      }
    }
  }
  const kids = namesDict.get('Kids');
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.length; i++) {
      const kid = asDict(kids.get(i), doc.objects);
      if (kid && removeFromNameTree(kid, targetName, doc)) removed = true;
    }
  }
  return removed;
}

export const embeddedFileSecurityEngine = new EmbeddedFileSecurityEngine();
