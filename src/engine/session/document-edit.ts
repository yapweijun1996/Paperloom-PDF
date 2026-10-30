import { clonePDFObject } from '../editing/editor-history';
import { addAnnotationToPage, createAnnotationDict, type Annotation } from '../editor/annotation-engine';
import { bindPageContentRefs, serializeToString } from '../editor/stream-compiler';
import { parsePDF } from '../parser/parser';
import { buildFullXref } from '../parser/xref';
import { assertXrefProvenance, bindXrefProvenance, bindXrefProvenanceWithRawDigest, trailerWithXrefRevision } from '../parser/xref-provenance';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';
import { extractPages } from '../writer/page-operations';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { hasDocumentSignature } from '../writer/save-pipeline';
import { getEncryptDictFromTrailer } from '../security/encryption/encrypt-dict';
import { publishDraft, runDocumentTransaction } from './document-transaction';
import { DocumentSession } from './document-session';
import type { EditTransaction } from './edit-transaction';

export interface PreparedHistoryRestore {
  commit(): void;
  cancel(): void;
}

/** Session serialization omits revision metadata, so guard it separately. */
function xrefEditSnapshot(doc: PDFDocumentData): string {
  return JSON.stringify({
    entries: Array.from(doc.xref.entries, ([key, value]) => [key, { ...value }]),
    provenance: doc.xref.provenance,
    revisionFields: ['Size', 'Prev', 'XRefStm'].map(key => {
      const value = doc.xref.trailerDict.get(key);
      return value === undefined ? null : serializeToString(value);
    }),
  });
}

/** Indirect protection entries cannot be copied safely without remapping their entire graph. */
function hasIndirectProtectionObject(value: PDFObject, seen = new Set<PDFObject>()): boolean {
  if (value instanceof PDFRef || value instanceof PDFStream) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof PDFArray) return value.items.some(item => hasIndirectProtectionObject(item, seen));
  if (value instanceof PDFDict) return [...value.values()].some(item => hasIndirectProtectionObject(item, seen));
  return false;
}

async function serializeSessionBytes(doc: PDFDocumentData): Promise<Uint8Array> {
  if (!doc.decryptedFromEncrypted) return serializeDocument(doc);
  // Internal snapshots are decrypted, like the live graph. Do not run AES's
  // random-IV export encryption when comparing document revisions.
  const trailerDict = clonePDFObject(doc.xref.trailerDict) as PDFDict;
  trailerDict.delete('Encrypt');
  return serializeDocument({
    ...doc,
    decryptedFromEncrypted: false,
    xref: { ...doc.xref, trailerDict },
  });
}

/** Probe the existing eraser/clear geometry without mutating the live graph.
 * Only the three migrated text-markup subtypes belong to a byte transaction.
 */
export function collectMarkupRemovals(
  doc: PDFDocumentData,
  pageIndex: number,
  remove: (pageDict: PDFDict, objects: Map<string, PDFObject>) => number,
): { textMarkup: PDFRef[]; legacy: PDFRef[] } {
  const annots = doc.pages[pageIndex].dict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  const textMarkup: PDFRef[] = [];
  const legacy: PDFRef[] = [];
  if (!(array instanceof PDFArray)) return { textMarkup, legacy };
  const probe = new PDFDict();
  probe.set('Annots', new PDFArray([...array.items]));
  const objects = new Map<string, PDFObject>();
  for (const item of array.items) {
    if (!(item instanceof PDFRef)) continue;
    const annotation = doc.objects.get(item.toKey());
    if (annotation) objects.set(item.toKey(), annotation);
  }
  remove(probe, objects);
  for (const item of array.items) {
    if (!(item instanceof PDFRef) || objects.has(item.toKey())) continue;
    const annotation = doc.objects.get(item.toKey());
    if (!(annotation instanceof PDFDict)) continue;
    const subtype = annotation.getName('Subtype');
    if (subtype === 'Highlight' || subtype === 'Underline' || subtype === 'StrikeOut') textMarkup.push(item);
    else legacy.push(item);
  }
  return { textMarkup, legacy };
}

/** Add native draw/shape annotations to a transaction's detached document. */
export function addDrawingAnnotations(doc: PDFDocumentData, pageIndex: number, annotations: readonly Annotation[]): void {
  for (const annotation of annotations) {
    const ref = new PDFRef(getNextObjNum(doc), 0);
    const { dict } = createAnnotationDict(annotation, ref.objNum, doc.objects);
    addAnnotationToPage(doc.pages[pageIndex].dict, dict, ref, doc.objects);
  }
}

/** Ink and text markup share an eraser transaction; other removals stay legacy. */
export function collectDrawingRemovals(
  doc: PDFDocumentData,
  pageIndex: number,
  remove: (pageDict: PDFDict, objects: Map<string, PDFObject>) => number,
): { transactional: PDFRef[]; legacy: PDFRef[] } {
  const hits = collectMarkupRemovals(doc, pageIndex, remove);
  const transactional = [...hits.textMarkup];
  const legacy: PDFRef[] = [];
  for (const ref of hits.legacy) {
    const annotation = doc.objects.get(ref.toKey());
    if (annotation instanceof PDFDict && annotation.getName('Subtype') === 'Ink') transactional.push(ref);
    else legacy.push(ref);
  }
  return { transactional, legacy };
}

/** Apply previously hit-tested references to either a draft or the legacy graph. */
export function removeMarkupReferences(doc: PDFDocumentData, pageIndex: number, refs: readonly PDFRef[]): void {
  const pageDict = doc.pages[pageIndex].dict;
  const annots = pageDict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  if (!(array instanceof PDFArray) || refs.length === 0) return;
  const removed = new Set(refs.map(ref => ref.toKey()));
  const remaining = array.items.filter(item => {
    if (!(item instanceof PDFRef) || !removed.has(item.toKey())) return true;
    doc.objects.delete(item.toKey());
    return false;
  });
  if (annots instanceof PDFRef) doc.objects.set(annots.toKey(), new PDFArray(remaining));
  else pageDict.set('Annots', new PDFArray(remaining));
}

/** Render an in-progress transactional annotation erase without publishing a partial gesture. */
export function previewMarkupRemoval(
  doc: PDFDocumentData,
  pageIndex: number,
  removed: ReadonlyMap<string, PDFRef>,
): PDFDocumentData {
  if (removed.size === 0) return doc;
  const page = doc.pages[pageIndex];
  const annots = page.dict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  if (!(array instanceof PDFArray)) return doc;
  const dict = new PDFDict([...page.dict.entries()]);
  dict.set('Annots', new PDFArray(array.items.filter(item =>
    !(item instanceof PDFRef && removed.has(item.toKey())))));
  const pages = [...doc.pages];
  pages[pageIndex] = { ...page, dict };
  return { ...doc, pages };
}

/** Stage an entire history step without creating another byte-history session. */
export async function publishHistoryDraft(
  doc: PDFDocumentData,
  apply: (staged: PDFDocumentData) => Promise<void>,
  isCurrent: () => boolean,
  commitHistory: () => void,
): Promise<void> {
  await runDocumentTransaction(doc, apply, isCurrent);
  // The callback only advances already-prepared, exclusively held history cursors.
  commitHistory();
}

/** Stages native object-graph edits without reparsing, losing decoded streams,
 * changing upload bytes, or routing edits through the export/save policy.
 * The adapter is deliberately separate from the byte-only session classes.
 */
export class SessionDocumentEditor {
  private session: DocumentSession | null = null;
  private editing = false;
  private signedBytes: { before: Uint8Array; after: Uint8Array; position: 'before' | 'after' } | null = null;

  get canUndo(): boolean {
    return !this.editing && (this.session?.canUndo ?? false);
  }

  get canRedo(): boolean {
    return !this.editing && (this.session?.canRedo ?? false);
  }

  async undo(doc: PDFDocumentData, isCurrent?: () => boolean): Promise<boolean> {
    return this.restore(doc, 'undo', isCurrent);
  }

  async redo(doc: PDFDocumentData, isCurrent?: () => boolean): Promise<boolean> {
    return this.restore(doc, 'redo', isCurrent);
  }

  /** Reapply a baked toolbar state after crossing a neighbouring session boundary. */
  async restoreCurrent(doc: PDFDocumentData, isCurrent?: () => boolean): Promise<boolean> {
    return this.restore(doc, 'current', isCurrent);
  }

  /** Split downloads transform private session bytes, not the live graph or
   * toolbar cursor. Failed extraction cannot publish a partial PDF.
   */
  async extractPages(doc: PDFDocumentData, indices: number[]): Promise<Uint8Array> {
    // A new PDF cannot preserve the byte ranges of the original signature.
    if (hasDocumentSignature(doc)) {
      throw new Error('Splitting a digitally signed PDF would invalidate its signatures.');
    }
    let protection: { dictionary: PDFDict; id?: PDFObject; fileKey: Uint8Array; algorithm: PDFDocumentData['encryptionAlgorithm'] } | undefined;
    if (doc.decryptedFromEncrypted) {
      const encryption = getEncryptDictFromTrailer(doc.xref.trailerDict, doc.objects);
      if (!encryption?.dict || !doc.encryptionFileKey?.length) {
        throw new Error('Cannot split the protected PDF without its authenticated re-encryption context.');
      }
      const id = doc.xref.trailerDict.get('ID');
      if (hasIndirectProtectionObject(encryption.dict) || (id &&
          (!(id instanceof PDFArray) || id.length < 1 ||
            id.items.some(item => !(item instanceof PDFString || item instanceof PDFHexString))))) {
        throw new Error('Cannot safely preserve this PDF’s indirect encryption settings when splitting.');
      }
      protection = {
        dictionary: clonePDFObject(encryption.dict) as PDFDict,
        id: id ? clonePDFObject(id) : undefined,
        fileKey: doc.encryptionFileKey.slice(),
        algorithm: doc.encryptionAlgorithm,
      };
    } else if (doc.xref.trailerDict.has('Encrypt')) {
      throw new Error('Unlock the protected PDF before splitting it.');
    }
    const session = new DocumentSession(await serializeSessionBytes(doc));
    const transaction = session.beginTransaction('extract-pages');
    try {
      await transaction.apply(async bytes => {
        const source = await parsePDF(bytes);
        const extracted = extractPages(source, indices);
        if (protection) {
          const encryptRef = new PDFRef(getNextObjNum(extracted), 0);
          extracted.objects.set(encryptRef.toKey(), protection.dictionary);
          extracted.xref.trailerDict.set('Encrypt', encryptRef);
          extracted.xref.trailerDict.set('Size', new PDFNumber(encryptRef.objNum + 1));
          if (protection.id) extracted.xref.trailerDict.set('ID', protection.id);
          extracted.decryptedFromEncrypted = true;
          extracted.encryptionFileKey = protection.fileKey;
          extracted.encryptionAlgorithm = protection.algorithm;
        }
        return serializeDocument(extracted);
      });
      transaction.commit();
      return session.getBytes();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  private async restore(doc: PDFDocumentData, direction: 'undo' | 'redo' | 'current', isCurrent?: () => boolean): Promise<boolean> {
    const prepared = await this.prepareRestore(doc, direction, isCurrent);
    if (!prepared) return false;
    prepared.commit();
    return true;
  }

  /** Apply a preview to a private document; move the session cursor only on commit. */
  async prepareRestore(doc: PDFDocumentData, direction: 'undo' | 'redo' | 'current', isCurrent?: () => boolean,
    options?: { discardableDraft?: boolean }): Promise<PreparedHistoryRestore | null> {
    if (this.editing) throw new Error('An edit transaction is already active');
    if (isCurrent && !isCurrent()) throw new Error('Document changed during history restoration');
    const session = this.session;
    if (!session) return null;
    this.editing = true;
    const bytes = session.preview(direction);
    if (!bytes) {
      this.editing = false;
      return null;
    }
    try {
      const originalXref = xrefEditSnapshot(doc);
      const baseline = options?.discardableDraft ? undefined : dehydrateDocument(doc);
      const restored = await parsePDF(bytes);
      if (isCurrent && !isCurrent()) throw new Error('Document changed during history restoration');
      if (xrefEditSnapshot(doc) !== originalXref) throw new Error('Document changed during history restoration');
      if (baseline && !sameDocumentSnapshot(baseline, dehydrateDocument(doc))) throw new Error('Document changed during history restoration');
      const xrefSource = doc.xref.provenance?.source;
      let xrefProofValid = false;
      if (xrefSource) {
        try { assertXrefProvenance(doc.rawBytes, doc.xref); xrefProofValid = true; }
        catch { /* A changed source must not become trusted through history. */ }
      }
      const verifiedTrailerValues = xrefProofValid && !this.signedBytes
        ? ['Size', 'Prev', 'XRefStm'].map(key => [key, doc.xref.trailerDict.get(key)] as const) : [];
      // Keep upload/save/security provenance on the live document and objects map.
      // Internal snapshots omit /Encrypt; downloads still need the original entry.
      const encryptRef = doc.xref.trailerDict.getRef('Encrypt');
      if (doc.decryptedFromEncrypted && encryptRef) {
        restored.xref.trailerDict.set('Encrypt', encryptRef);
        const encrypt = doc.objects.get(encryptRef.toKey());
        if (encrypt) restored.objects.set(encryptRef.toKey(), encrypt);
      }
      // The parser reads xref-number order, not physical snapshot order.
      // Restore file order so reinserted annotations and their /Annots arrays
      // serialize byte-identically; retain detached objects for legacy history.
      const orderedObjects = [...restored.objects].sort(([left], [right]) =>
        (restored.xref.entries.get(left)?.offset ?? Number.MAX_SAFE_INTEGER) -
        (restored.xref.entries.get(right)?.offset ?? Number.MAX_SAFE_INTEGER));
      if (!this.signedBytes) {
        for (const [key, object] of doc.objects) {
          if (!restored.objects.has(key)) orderedObjects.push([key, object]);
        }
      }
      // History serializes an intermediate full PDF, but its xref metadata is
      // not authoritative for the original bytes retained by the live graph.
      // Preserve the already verified metadata instead of trusting the draft.
      for (const [key, value] of verifiedTrailerValues) {
        if (value === undefined) restored.xref.trailerDict.delete(key);
        else restored.xref.trailerDict.set(key, value);
      }
      const nextPosition = direction === 'undo' ? 'before' : direction === 'redo' ? 'after' : this.signedBytes?.position;
      const signedBytes = this.signedBytes ? this.signedBytes[nextPosition!].slice() : undefined;
      const signedXref = signedBytes ? await buildFullXref(signedBytes) : undefined;
      if ((isCurrent && !isCurrent()) || xrefEditSnapshot(doc) !== originalXref ||
          (baseline && !sameDocumentSnapshot(baseline, dehydrateDocument(doc)))) {
        throw new Error('Document changed during history restoration');
      }
      const nextXref = { ...(signedXref ?? doc.xref), trailerDict: signedXref
        ? trailerWithXrefRevision(restored.xref.trailerDict, signedXref.trailerDict) : restored.xref.trailerDict };
      if (signedXref?.provenance?.rawDigest) {
        bindXrefProvenanceWithRawDigest(nextXref, signedXref.provenance.source, signedXref.provenance.rawDigest);
      }
      if (xrefProofValid && xrefSource && !this.signedBytes) {
        if (doc.xref.provenance?.rawDigest) bindXrefProvenanceWithRawDigest(nextXref, xrefSource, doc.xref.provenance.rawDigest);
        else bindXrefProvenance(doc.rawBytes, nextXref, xrefSource);
      }
      const publish = () => {
        doc.objects.clear();
        for (const [key, object] of orderedObjects) doc.objects.set(key, object);
        doc.catalog = restored.catalog;
        doc.pages = restored.pages;
        for (const page of doc.pages) bindPageContentRefs(page, doc);
        if (signedXref) doc.xref.entries = nextXref.entries;
        doc.xref.trailerDict = nextXref.trailerDict;
        doc.xref.provenance = nextXref.provenance;
        doc.info = restored.info;
        doc.version = restored.version;
        if (signedBytes) doc.rawBytes = signedBytes;
      };
      if (options?.discardableDraft) publish();
      let settled = false;
      return {
        commit: () => {
          if (settled) return;
          if (baseline && !sameDocumentSnapshot(baseline, dehydrateDocument(doc))) {
            settled = true; this.editing = false;
            throw new Error('Document changed during history restoration');
          }
          if (isCurrent && !isCurrent()) {
            settled = true; this.editing = false;
            throw new Error('Document changed during history restoration');
          }
          if (!options?.discardableDraft) publish();
          settled = true;
          if (direction !== 'current') session[direction]();
          if (this.signedBytes && nextPosition) this.signedBytes.position = nextPosition;
          this.editing = false;
        },
        cancel: () => {
          if (settled) return;
          settled = true; this.editing = false;
        },
      };
    } catch (error) {
      this.editing = false;
      throw error;
    }
  }

  async edit(
    doc: PDFDocumentData,
    label: string,
    apply: (staged: PDFDocumentData) => Promise<void>,
    options?: { includeRawBytes?: boolean; isCurrent?: () => boolean },
  ): Promise<void> {
    if (this.editing) throw new Error('An edit transaction is already active');
    if (this.signedBytes || (options?.includeRawBytes && this.session)) {
      throw new Error('A signed-byte transaction requires a fresh session');
    }
    this.editing = true;
    let transaction: EditTransaction | undefined;
    try {
      const originalBytes = options?.includeRawBytes ? doc.rawBytes.slice() : undefined;
      const originalKey = options?.includeRawBytes ? doc.encryptionFileKey?.slice() : undefined;
      const originalAlgorithm = doc.encryptionAlgorithm;
      const originalEncrypted = doc.decryptedFromEncrypted;
      const originalEncryptRef = doc.xref.trailerDict.getRef('Encrypt')?.toKey();
      const originalXref = xrefEditSnapshot(doc);
      const baseline = await serializeSessionBytes(doc);
      if (!this.session) this.session = new DocumentSession(baseline);
      else {
        const previous = this.session.getBytes();
        if (previous.length !== baseline.length || previous.some((byte, index) => byte !== baseline[index])) {
          this.session.snapshot('legacy-edit', baseline);
        }
      }
      transaction = this.session.beginTransaction(label);
      const seen = new Map<object, PDFObject>();
      const objects = new Map<string, PDFObject>();
      for (const [key, object] of doc.objects) objects.set(key, clonePDFObject(object, seen));
      const staged: PDFDocumentData = {
        ...doc,
        rawBytes: originalBytes?.slice() ?? doc.rawBytes,
        encryptionFileKey: originalKey?.slice() ?? doc.encryptionFileKey,
        objects,
        catalog: clonePDFObject(doc.catalog, seen) as PDFDict,
        pages: doc.pages.map(page => ({
          ...page,
          mediaBox: { ...page.mediaBox },
          cropBox: { ...page.cropBox },
          dict: clonePDFObject(page.dict, seen) as PDFDict,
          resources: clonePDFObject(page.resources, seen) as PDFDict,
          contentRefs: [...page.contentRefs],
        })),
        xref: { ...doc.xref, entries: new Map(Array.from(doc.xref.entries, ([key, entry]) => [key, { ...entry }])),
          ...(doc.xref.provenance ? { provenance: { ...doc.xref.provenance } } : {}),
          trailerDict: clonePDFObject(doc.xref.trailerDict, seen) as PDFDict },
      };
      for (const page of staged.pages) bindPageContentRefs(page, staged);
      await transaction.apply(async () => {
        await apply(staged);
        return serializeSessionBytes(staged);
      });
      // Legacy edit paths remain live. Do not overwrite their work if one ran
      // while the staged operation was awaiting image decoding/compression.
      const latest = await serializeSessionBytes(doc);
      if (baseline.length !== latest.length || baseline.some((byte, index) => byte !== latest[index])) {
        throw new Error('Document changed during the edit transaction');
      }
      if (xrefEditSnapshot(doc) !== originalXref) throw new Error('Document changed during the edit transaction');
      if (options?.isCurrent && !options.isCurrent()) throw new Error('Document changed during the edit transaction');
      if (originalBytes) {
        const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined) =>
          left === undefined ? right === undefined : right !== undefined &&
            left.length === right.length && left.every((byte, index) => byte === right[index]);
        if (!sameBytes(originalBytes, doc.rawBytes) || !sameBytes(originalKey, doc.encryptionFileKey) ||
            originalAlgorithm !== doc.encryptionAlgorithm || originalEncrypted !== doc.decryptedFromEncrypted ||
            originalEncryptRef !== doc.xref.trailerDict.getRef('Encrypt')?.toKey()) {
          throw new Error('Document changed during the edit transaction');
        }
      }
      transaction.commit();
      publishDraft(doc, staged, seen);
      if (originalBytes) {
        const after = staged.rawBytes.slice();
        this.signedBytes = { before: originalBytes, after, position: 'after' };
        doc.rawBytes = after.slice();
      }
    } catch (error) {
      transaction?.rollback();
      throw error;
    } finally {
      this.editing = false;
    }
  }
}
