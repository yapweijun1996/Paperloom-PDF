/**
 * Incremental PDF Writer
 *
 * Appends only modified/new objects to the end of an existing PDF file.
 * This preserves the original file contents and adds an incremental update:
 *
 *   [original PDF bytes]
 *   [new/modified objects]
 *   xref
 *   [incremental xref table — only modified entries]
 *   trailer
 *   << /Size N /Root ref /Prev <old_xref_offset> >>
 *   startxref
 *   <new_xref_offset>
 *   %%EOF
 *
 * Phase 6: OffsetManager + RevisionManager integration; multi-revision support.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
} from '../types';
import { bindXrefProvenance, trailerWithXrefRevision } from '../parser/xref-provenance';
import { serializeIndirectObject, serializeToString, concatBytes } from '../editor/stream-compiler';
import { findStartXref } from '../parser/xref';
import { OffsetManager, type ObjectKey } from './offset-manager';
import { RevisionManager, listRevisions } from './revision-manager';
import { formatXrefEntry } from './xref-entry';
import { assertActiveXrefValidation, assertNewObjectsDoNotCollide, assertUniqueIncrementalObjectNumbers } from './new-object-safety';

export interface IncrementalWriteResult {
  /** Complete PDF bytes (original + this update). Never rewrites original prefix. */
  bytes: Uint8Array;
  /** Absolute offsets of objects written in this update. */
  writtenOffsets: Map<ObjectKey, number>;
  /** Byte offset of the new xref table. */
  xrefOffset: number;
  /** Previous xref offset stored in /Prev. */
  prevXrefOffset: number;
  /** Trailer /Size. */
  size: number;
  /** Length of the original prefix that was preserved. */
  originalLength: number;
}

export interface IncrementalWriteOptions {
  offsetManager?: OffsetManager;
  revisionManager?: RevisionManager;
}

export function assertIncrementalOutputAllowed(doc: PDFDocumentData): void {
  if (doc.requiresFullRewrite) {
    throw new Error('This document requires a full rewrite after security changes; incremental output would retain previous content.');
  }
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt')) {
    // Incremental serialization does not encrypt new objects or preserve the
    // encrypted trailer; emitting either form would expose or corrupt data.
    throw new Error('Incremental output for encrypted PDFs is not supported; save using a full encrypted rewrite.');
  }
}

// ─── Incremental save ───────────────────────────────────────────────────────

/**
 * Save a document incrementally — append only changed objects.
 * Never rewrites the original document bytes.
 */
export function saveIncremental(
  doc: PDFDocumentData,
  modifiedKeys: Set<string>,
  newObjects?: Map<string, PDFObject>,
  options?: IncrementalWriteOptions,
): Uint8Array {
  return appendIncrementalUpdate(doc, modifiedKeys, newObjects, options).bytes;
}

/**
 * Append an incremental update and return offset/revision metadata.
 */
export function appendIncrementalUpdate(
  doc: PDFDocumentData,
  modifiedKeys: Set<string>,
  newObjects?: Map<string, PDFObject>,
  options?: IncrementalWriteOptions,
): IncrementalWriteResult {
  return appendIncrementalUpdateCore(doc, modifiedKeys, newObjects, options, false);
}

/** Internal: call only immediately after the asynchronous save path verified
 * the same document and object set, with no intervening await or callback. */
export function saveIncrementalPrevalidated(doc: PDFDocumentData, modifiedKeys: Set<string>,
  newObjects: Map<string, PDFObject> | undefined, token: object): Uint8Array {
  assertActiveXrefValidation(doc, token);
  return appendIncrementalUpdateCore(doc, modifiedKeys, newObjects, undefined, true).bytes;
}

function appendIncrementalUpdateCore(doc: PDFDocumentData, modifiedKeys: Set<string>,
  newObjects: Map<string, PDFObject> | undefined, options: IncrementalWriteOptions | undefined,
  prevalidated: boolean): IncrementalWriteResult {
  let priorValid = !!doc.xref.provenance;
  if (!prevalidated) {
    const checked = assertNewObjectsDoNotCollide(doc, newObjects);
    priorValid = assertUniqueIncrementalObjectNumbers(doc, modifiedKeys, newObjects, checked);
  }
  assertIncrementalOutputAllowed(doc);
  const originalBytes = doc.rawBytes;
  if (!originalBytes || originalBytes.length === 0) {
    throw new Error('Incremental update requires doc.rawBytes (original PDF)');
  }

  const chunks: Uint8Array[] = [];
  let currentOffset = originalBytes.length;
  const originalLength = originalBytes.length;

  // Ensure the original ends cleanly (add newline if needed)
  if (originalBytes[originalBytes.length - 1] !== 0x0a) {
    chunks.push(stringToBytes('\n'));
    currentOffset += 1;
  }

  const newOffsets = new Map<ObjectKey, number>();

  // Write modified objects
  const modKeys = Array.from(modifiedKeys);
  for (let i = 0; i < modKeys.length; i++) {
    const key = modKeys[i];
    const obj = doc.objects.get(key);
    if (!obj) continue;

    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);

    newOffsets.set(key, currentOffset);
    const objBytes = serializeIndirectObject(objNum, genNum, obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Write new objects (if any)
  if (newObjects) {
    const newEntries = Array.from(newObjects.entries());
    for (let i = 0; i < newEntries.length; i++) {
      const [key, obj] = newEntries[i];
      // Skip if already written as modified
      if (newOffsets.has(key)) continue;

      const parts = key.split('_');
      const objNum = parseInt(parts[0], 10);
      const genNum = parseInt(parts[1], 10);

      newOffsets.set(key, currentOffset);
      const objBytes = serializeIndirectObject(objNum, genNum, obj);
      chunks.push(objBytes);
      currentOffset += objBytes.length;

    }
  }

  // Build incremental xref table
  const xrefOffset = currentOffset;
  const xrefBytes = buildIncrementalXref(newOffsets);
  chunks.push(xrefBytes);
  currentOffset += xrefBytes.length;

  // Build trailer
  let prevXrefOffset = 0;
  try {
    prevXrefOffset = findStartXref(originalBytes);
  } catch {
    prevXrefOffset = 0;
  }
  let maxObjectNumber = getMaxObjNum(doc);
  if (newObjects) for (const key of newObjects.keys()) maxObjectNumber = Math.max(maxObjectNumber, Number(key.split('_')[0]));
  const size = Math.max(maxObjectNumber + 1, doc.xref.trailerDict.getNumber('Size') ?? 0);

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(size));

  const root =
    doc.xref?.trailerDict?.getRef?.('Root') ??
    findCatalogRef(doc);
  if (root) trailerDict.set('Root', root);

  const info = doc.xref?.trailerDict?.get?.('Info');
  if (info) trailerDict.set('Info', info);

  // Preserve the original file identifier through each revision. In
  // particular, readers need the permanent ID to identify the document and
  // encrypted documents use its bytes when deriving their encryption key.
  const id = doc.xref?.trailerDict?.get?.('ID');
  if (id) trailerDict.set('ID', id);

  trailerDict.set('Prev', new PDFNumber(prevXrefOffset));

  const trailerStr = trailerDictToString(trailerDict);
  const trailerBytes = stringToBytes(
    `trailer\n${trailerStr}\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  chunks.push(trailerBytes);
  currentOffset += trailerBytes.length;

  const bytes = concatBytes(originalBytes, ...chunks);

  // Prepare the next xref before publishing bytes. A later save must not
  // mistake an object just written as still free in the original revision.
  const priorProof = doc.xref.provenance;
  const nextEntries = new Map(doc.xref.entries);
  for (const [key, offset] of newOffsets) {
    const [objNum, genNum] = key.split('_').map(Number);
    if (priorValid && priorProof?.source === 'strict') {
      for (const [oldKey, entry] of nextEntries) if (entry.objNum === objNum) nextEntries.delete(oldKey);
    }
    nextEntries.set(key, { objNum, genNum, offset, type: 'n' });
  }
  const nextXref = { ...doc.xref, entries: nextEntries,
    trailerDict: trailerWithXrefRevision(doc.xref.trailerDict, trailerDict) };
  // The public synchronous writer binds here. The detached async save path
  // re-parses and binds the output before publishing it to the live graph.
  if (!prevalidated && priorValid && priorProof) bindXrefProvenance(bytes, nextXref, priorProof.source);

  // Update managers only after all objects and the trailer have been encoded.
  // If a manager rejects the update, restore both manager states before the
  // live document is touched.
  const revIndex = (options?.revisionManager?.count ?? 0);
  const offsetSnapshot = options?.offsetManager?.snapshot();
  const revisionSnapshot = options?.revisionManager?.snapshot();
  try {
    options?.offsetManager?.recordBatch(newOffsets, revIndex, bytes.length);
    options?.revisionManager?.pushRevision({
      xrefOffset,
      prevOffset: prevXrefOffset,
      size,
      fileLength: bytes.length,
      root: root ?? null,
    });
  } catch (error) {
    if (offsetSnapshot) options?.offsetManager?.restore(offsetSnapshot);
    if (revisionSnapshot) options?.revisionManager?.restore(revisionSnapshot);
    throw error;
  }

  // Keep doc.rawBytes in sync for subsequent incremental appends
  if (newObjects) for (const [key, object] of newObjects) doc.objects.set(key, object);
  doc.xref.entries = nextEntries;
  doc.xref.trailerDict = nextXref.trailerDict;
  doc.xref.provenance = nextXref.provenance;
  doc.rawBytes = bytes;

  return {
    bytes,
    writtenOffsets: newOffsets,
    xrefOffset,
    prevXrefOffset,
    size,
    originalLength,
  };
}

/**
 * Session helper: tracks dirty keys and appends updates without rewriting history.
 */
export class IncrementalUpdateSession {
  readonly offsets: OffsetManager;
  readonly revisions: RevisionManager;
  private dirty = new Set<ObjectKey>();
  private created = new Map<ObjectKey, PDFObject>();

  constructor(private doc: PDFDocumentData) {
    this.offsets = new OffsetManager(doc.rawBytes?.length ?? 0);
    this.revisions = new RevisionManager(doc.rawBytes);
    if (doc.xref?.entries) {
      const seed: { key: string; offset: number; objNum: number; genNum: number }[] = [];
      for (const [key, entry] of doc.xref.entries) {
        seed.push({
          key,
          offset: entry.offset,
          objNum: entry.objNum,
          genNum: entry.genNum,
        });
      }
      this.offsets.seedFromXref(seed, 0);
    }
  }

  markModified(key: ObjectKey): void {
    this.dirty.add(key);
  }

  markModifiedRef(ref: PDFRef): void {
    this.dirty.add(ref.toKey());
  }

  addNewObject(ref: PDFRef, obj: PDFObject): void {
    const key = ref.toKey();
    assertIncrementalOutputAllowed(this.doc);
    const added = new Map([[key, obj]]);
    const checked = assertNewObjectsDoNotCollide(this.doc, added);
    assertUniqueIncrementalObjectNumbers(this.doc, this.dirty, added, checked);
    this.doc.objects.set(key, obj);
    this.created.set(key, obj);
    this.dirty.add(key);
  }

  /** Append a revision containing all dirty objects since last commit. */
  commit(): IncrementalWriteResult {
    if (!this.doc.rawBytes?.length) {
      throw new Error('Document has no rawBytes for incremental commit');
    }
    const result = appendIncrementalUpdate(
      this.doc,
      this.dirty,
      this.created,
      { offsetManager: this.offsets, revisionManager: this.revisions },
    );
    this.dirty.clear();
    this.created.clear();
    return result;
  }

  listRevisions() {
    return this.revisions.list();
  }
}

export { listRevisions, OffsetManager, RevisionManager };

// ─── Incremental xref ───────────────────────────────────────────────────────

function buildIncrementalXref(offsets: Map<string, number>): Uint8Array {
  const entries: { objNum: number; genNum: number; offset: number }[] = [];

  const offsetEntries = Array.from(offsets.entries());
  for (let i = 0; i < offsetEntries.length; i++) {
    const [key, offset] = offsetEntries[i];
    const parts = key.split('_');
    entries.push({
      objNum: parseInt(parts[0], 10),
      genNum: parseInt(parts[1], 10),
      offset,
    });
  }

  entries.sort((a, b) => a.objNum - b.objNum);

  const subsections: { start: number; entries: typeof entries }[] = [];
  let currentSub: typeof entries = [];
  let expectedNext = -1;

  for (const entry of entries) {
    if (entry.objNum !== expectedNext && currentSub.length > 0) {
      subsections.push({ start: currentSub[0].objNum, entries: [...currentSub] });
      currentSub = [];
    }
    currentSub.push(entry);
    expectedNext = entry.objNum + 1;
  }

  if (currentSub.length > 0) {
    subsections.push({ start: currentSub[0].objNum, entries: currentSub });
  }

  const lines: string[] = ['xref'];

  for (const sub of subsections) {
    lines.push(`${sub.start} ${sub.entries.length}`);
    for (const entry of sub.entries) {
      lines.push(formatXrefEntry(entry.offset, entry.genNum, 'n'));
    }
  }

  return stringToBytes(lines.join('\n') + '\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findCatalogRef(doc: PDFDocumentData): PDFRef | null {
  // Prefer trailer Root; else scan for Catalog
  for (const [key, obj] of doc.objects) {
    if (obj instanceof PDFDict) {
      const type = obj.get('Type');
      if (type instanceof PDFName && type.name === 'Catalog') {
        const parts = key.split('_');
        return new PDFRef(parseInt(parts[0], 10), parseInt(parts[1] ?? '0', 10));
      }
    }
  }
  return null;
}

function getMaxObjNum(doc: PDFDocumentData): number {
  let max = 0;
  const keys = Array.from(doc.objects.keys());
  for (let i = 0; i < keys.length; i++) {
    const objNum = parseInt(keys[i].split('_')[0], 10);
    if (objNum > max) max = objNum;
  }
  return max;
}

function trailerDictToString(dict: PDFDict): string {
  return serializeToString(dict);
}

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// Silence unused imports that may be needed by consumers re-exporting types
void PDFArray;
void PDFStream;
