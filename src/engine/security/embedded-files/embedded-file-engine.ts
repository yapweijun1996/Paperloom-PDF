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
import { associatedFileSpecs, assertAttachmentStreamsDetached, detachAssociatedFileSpecs, expandAttachmentStreams, removeAllAttachmentsSafely } from './attachment-removal';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';
import { assertCompletePageTree } from '../validate-page-tree';
import type {
  AttachmentScanResult,
  AttachmentScanner,
  AttachmentValidationResult,
  EmbeddedAttachment,
  IEmbeddedFileSecurityEngine,
} from '../types';

function resolveAttachment(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (obj instanceof PDFRef) {
    const key = obj.toKey();
    if (seen.has(key)) throw new Error('Cannot safely inspect a cyclic attachment reference.');
    seen.add(key);
    obj = objects.get(key);
    if (!obj) throw new Error('Cannot safely inspect an unresolved attachment reference.');
  }
  return obj;
}

function asDict(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFDict | null {
  const r = resolveAttachment(obj, objects);
  return r instanceof PDFDict ? r : null;
}

function asStream(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFStream | null {
  const r = resolveAttachment(obj, objects);
  return r instanceof PDFStream ? r : null;
}

function nameTreeFiles(
  namesDict: PDFDict,
  objects: Map<string, PDFObject>,
  visited = new Set<PDFDict>(),
): Array<{ name: string; filespec: PDFDict }> {
  if (visited.has(namesDict)) throw new Error('Cannot safely inspect a cyclic embedded-file name tree.');
  visited.add(namesDict);
  const out: Array<{ name: string; filespec: PDFDict }> = [];

  const namesValue = namesDict.get('Names');
  const names = resolveAttachment(namesValue, objects);
  if (namesValue && !(names instanceof PDFArray)) throw new Error('Cannot safely inspect embedded-file names.');
  if (names instanceof PDFArray) {
    if (names.length % 2 !== 0) throw new Error('Cannot safely inspect embedded-file names.');
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
      if (!filespec) throw new Error('Cannot safely inspect an embedded file specification.');
      out.push({ name, filespec });
    }
  }

  const kidsValue = namesDict.get('Kids');
  const kids = resolveAttachment(kidsValue, objects);
  if (kidsValue && !(kids instanceof PDFArray)) throw new Error('Cannot safely inspect an embedded-file name tree.');
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.length; i++) {
      const kid = asDict(kids.get(i), objects);
      if (!kid) throw new Error('Cannot safely inspect an embedded-file name tree.');
      out.push(...nameTreeFiles(kid, objects, visited));
    }
  }

  visited.delete(namesDict);
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
    const f = ef.get('F') ?? ef.get('UF') ?? ef.get('DOS') ?? ef.get('Mac') ?? ef.get('Unix');
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

/** Match the same aliases as the named removal path, including name-tree keys. */
function matchingFileSpecs(doc: PDFDocumentData, targetName: string): Set<PDFDict> {
  const result = new Set<PDFDict>();
  const matches = (spec: PDFDict, alias?: string) => alias === targetName ||
    spec.getString('F') === targetName || spec.getString('UF') === targetName;
  const names = asDict(doc.catalog.get('Names'), doc.objects);
  const tree = names ? asDict(names.get('EmbeddedFiles'), doc.objects) : null;
  if (tree) for (const { name, filespec } of nameTreeFiles(tree, doc.objects)) {
    if (matches(filespec, name)) result.add(filespec);
  }
  for (const page of doc.pages) {
    const entry = page.dict.get('Annots');
    if (!entry) continue;
    const array = resolveAttachment(entry, doc.objects);
    if (!(array instanceof PDFArray)) throw new Error('Cannot safely inspect page attachments.');
    for (const item of array.items) {
      const annot = asDict(item, doc.objects);
      if (!annot || annot.getName('Subtype') !== 'FileAttachment') continue;
      const spec = asDict(annot.get('FS'), doc.objects);
      if (annot.has('FS') && !spec) throw new Error('Cannot safely inspect an attachment annotation.');
      if (spec && matches(spec, annot.getString('Contents'))) result.add(spec);
    }
  }
  for (const spec of associatedFileSpecs(doc)) {
    if (matches(spec, spec.getString('F') ?? 'associated-file')) result.add(spec);
  }
  return result;
}

export class EmbeddedFileSecurityEngine implements IEmbeddedFileSecurityEngine {
  listAttachments(doc: PDFDocumentData): EmbeddedAttachment[] {
    const results: EmbeddedAttachment[] = [];
    const seen = new Set<PDFDict>();

    // Catalog /Names → /EmbeddedFiles
    const names = asDict(doc.catalog.get('Names'), doc.objects);
    if (names) {
      const embedded = asDict(names.get('EmbeddedFiles'), doc.objects);
      if (embedded) {
        for (const { name, filespec } of nameTreeFiles(embedded, doc.objects)) {
          const att = filespecToAttachment(name, filespec, doc.objects, 'Names');
          if (!seen.has(filespec)) {
            seen.add(filespec);
            results.push(att);
          }
        }
      }
    }

    // FileAttachment annotations on pages
    for (const page of doc.pages) {
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = resolveAttachment(annots, doc.objects);
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        const dict = asDict(item, doc.objects);
        if (!dict || dict.getName('Subtype') !== 'FileAttachment') continue;
        const fs = asDict(dict.get('FS'), doc.objects);
        if (!fs) continue;
        const name = dict.getString('Contents') ?? fs.getString('F') ?? `attachment-${page.index}-${i}`;
        const att = filespecToAttachment(name, fs, doc.objects, 'FileAttachment', page.index);
        if (!seen.has(fs)) {
          seen.add(fs);
          results.push(att);
        }
      }
    }

    for (const filespec of associatedFileSpecs(doc)) {
      if (seen.has(filespec)) continue;
      seen.add(filespec);
      results.push(filespecToAttachment(filespec.getString('F') ?? 'associated-file', filespec, doc.objects, 'EF'));
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
    assertCompletePageTree(doc, reason => {
      throw new Error(`Cannot safely remove attachments: ${reason}; no changes were made.`);
    });
    const draft = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
    const streams: PDFStream[] = [];
    const targets = matchingFileSpecs(draft, name);
    if (!targets.size) return false;
    if (targets.size > 1) throw new Error('The attachment name is ambiguous; multiple files match.');
    if (hasDocumentSignature(doc)) throw new SignedDocumentEditError();
    for (const spec of targets) {
      if (spec.has('RF')) throw new Error('Cannot safely remove related files in an attachment specification.');
      const ef = asDict(spec.get('EF'), draft.objects);
      if (!ef) throw new Error('Cannot safely inspect the named attachment data.');
      for (const value of ef.values()) {
        const stream = asStream(value, draft.objects);
        if (!stream) throw new Error('Cannot safely inspect the named attachment data.');
        streams.push(stream);
      }
    }
    const allStreams = expandAttachmentStreams(draft, streams);
    if (!this.removeAttachmentInPlace(draft, targets)) return false;
    assertAttachmentStreamsDetached(draft, allStreams);
    const removed = this.removeAttachmentInPlace(doc, matchingFileSpecs(doc, name));
    if (removed) doc.requiresFullRewrite = true;
    return removed;
  }

  private removeAttachmentInPlace(doc: PDFDocumentData, targets: Set<PDFDict>): boolean {
    let removed = detachAssociatedFileSpecs(doc, targets);

    const names = asDict(doc.catalog.get('Names'), doc.objects);
    if (names) {
      const embedded = asDict(names.get('EmbeddedFiles'), doc.objects);
      if (embedded) {
        const pruned = removeFromNameTree(embedded, targets, doc);
        if (pruned.changed) {
          // Copy the owning dictionary and every changed path: the original
          // name tree may also be referenced by unrelated retained objects.
          const nextNames = new PDFDict([...names.entries()]);
          const namesArr = resolveAttachment(pruned.node.get('Names'), doc.objects);
          const kidsArr = resolveAttachment(pruned.node.get('Kids'), doc.objects);
          if (namesArr instanceof PDFArray && namesArr.length === 0 &&
              (!(kidsArr instanceof PDFArray) || kidsArr.length === 0)) {
            nextNames.delete('EmbeddedFiles');
          } else nextNames.set('EmbeddedFiles', pruned.node);
          if (nextNames.size) doc.catalog.set('Names', nextNames);
          else doc.catalog.delete('Names');
          removed = true;
        }
      }
    }

    for (const page of doc.pages) {
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = resolveAttachment(annots, doc.objects);
      if (!(arr instanceof PDFArray)) continue;
      const retained: PDFObject[] = [];
      for (const item of arr.items) {
        const dict = asDict(item, doc.objects);
        const fs = dict?.getName('Subtype') === 'FileAttachment' ? asDict(dict.get('FS'), doc.objects) : null;
        if (fs && targets.has(fs)) continue;
        retained.push(item);
      }
      if (retained.length !== arr.length) {
        // Do not mutate an annotation array shared with another live object.
        if (retained.length) page.dict.set('Annots', new PDFArray(retained));
        else page.dict.delete('Annots');
        removed = true;
      }
    }

    return removed;
  }

  removeAllAttachments(doc: PDFDocumentData): number {
    assertCompletePageTree(doc, reason => {
      throw new Error(`Cannot safely remove attachments: ${reason}; no changes were made.`);
    });
    return removeAllAttachmentsSafely(doc);
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
  targets: Set<PDFDict>,
  doc: PDFDocumentData,
  visited = new Set<PDFDict>(),
): { node: PDFDict; changed: boolean } {
  if (visited.has(namesDict)) throw new Error('Cannot safely inspect a cyclic embedded-file name tree.');
  visited.add(namesDict);
  let result = namesDict;
  let changed = false;
  const copy = () => {
    if (result === namesDict) result = new PDFDict([...namesDict.entries()]);
    changed = true;
    return result;
  };
  const namesValue = namesDict.get('Names');
  const names = resolveAttachment(namesValue, doc.objects);
  if (namesValue && !(names instanceof PDFArray)) throw new Error('Cannot safely inspect embedded-file names.');
  if (names instanceof PDFArray) {
    const kept: PDFObject[] = [];
    for (let i = 0; i < names.length; i += 2) {
      const fsObj = names.get(i + 1);
      const fs = asDict(fsObj, doc.objects);
      if (fs && targets.has(fs)) continue;
      kept.push(names.get(i)!, fsObj!);
    }
    if (kept.length !== names.length) copy().set('Names', new PDFArray(kept));
  }
  const kidsValue = namesDict.get('Kids');
  const kids = resolveAttachment(kidsValue, doc.objects);
  if (kidsValue && !(kids instanceof PDFArray)) throw new Error('Cannot safely inspect an embedded-file name tree.');
  if (kids instanceof PDFArray) {
    const nextKids: PDFObject[] = [];
    let kidsChanged = false;
    for (let i = 0; i < kids.length; i++) {
      const item = kids.get(i)!;
      const kid = asDict(item, doc.objects);
      if (!kid) throw new Error('Cannot safely inspect an embedded-file name tree.');
      const next = removeFromNameTree(kid, targets, doc, visited);
      nextKids.push(next.changed ? next.node : item);
      kidsChanged ||= next.changed;
    }
    if (kidsChanged) copy().set('Kids', new PDFArray(nextKids));
  }
  visited.delete(namesDict);
  return { node: result, changed };
}

export const embeddedFileSecurityEngine = new EmbeddedFileSecurityEngine();
