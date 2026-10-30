/**
 * PDF Document Serializer
 *
 * Writes a complete PDF document from the in-memory object graph back
 * to valid binary output. Supports both full serialization and
 * incremental updates.
 *
 * Output format:
 *   %PDF-1.7
 *   %âãÏÓ  (binary marker)
 *   <objects>
 *   xref
 *   <cross-reference table>
 *   trailer
 *   << /Size N /Root ref /Info ref >>
 *   startxref
 *   <offset>
 *   %%EOF
 */

import {
  PDFDict,
  PDFNumber,
  PDFObject,
  PDFStream,
  type PDFDocumentData,
} from '../types';
import { serializeIndirectObject, serializeToString } from '../editor/stream-compiler';
import { concatByteChunks } from '../editor/stream-compiler';
import { packIntoObjectStreams, buildXRefStream } from '../optimize/object-streams';
import { garbageCollect, rootsFromTrailer } from '../optimize/garbage-collect';
import { getReencryptSaveContext, prepareEncryptedObjects } from '../security/encryption/encrypt-objects';
import { formatXrefEntry } from './xref-entry';

// ─── Full document serialization ────────────────────────────────────────────

/** Sensitive-data cleanup cannot fall back to writing detached objects. */
export function assertFullRewriteSafe(doc: PDFDocumentData): void {
  if (!doc.requiresFullRewrite) return;
  const ref = doc.xref.trailerDict.getRef('Root');
  const catalog = ref && doc.objects.get(ref.toKey());
  if (!(catalog instanceof PDFDict) || catalog !== doc.catalog || catalog.getName('Type') !== 'Catalog') {
    throw new Error('Cannot safely rewrite cleaned PDF: the trailer root is missing or is not the document catalog.');
  }
}

/** An xref entry identifies exactly one current generation of each object. */
export function assertSerializableObjectKeys(keys: Iterable<string>): void {
  const numbers = new Set<number>();
  for (const key of keys) {
    const match = /^([1-9]\d*)_(0|[1-9]\d*)$/.exec(key);
    if (!match) throw new Error('Cannot serialize an invalid PDF object number.');
    const objNum = Number(match[1]), genNum = Number(match[2]);
    if (!Number.isSafeInteger(objNum) || objNum > 2_147_483_647 || !Number.isSafeInteger(genNum) || genNum > 65_535 || numbers.has(objNum)) {
      throw new Error('Cannot serialize an invalid or duplicate PDF object number.');
    }
    numbers.add(objNum);
  }
}

function assertReaderSafeObjectNumber(maxObjNum: number, fileLength: number): void {
  // Some readers bound xref object numbers by the file size to avoid hostile
  // allocations and silently ignore entries above that bound. Never publish a
  // PDF whose reachable objects such readers would discard.
  if (!Number.isSafeInteger(fileLength) || maxObjNum > Math.floor(fileLength / 3)) {
    throw new Error('Cannot safely serialize sparse PDF object numbers: a reader may ignore reachable objects.');
  }
}

function outputTrailer(doc: PDFDocumentData, size: number): PDFDict {
  const trailer = new PDFDict([['Size', new PDFNumber(size)]]);
  for (const key of ['Root', 'Info', 'Encrypt', 'ID'] as const) {
    const value = doc.xref.trailerDict.get(key);
    if (value !== undefined && (key !== 'Root' || doc.xref.trailerDict.getRef('Root'))) trailer.set(key, value);
  }
  return trailer;
}

/** Check the exact unencrypted full-rewrite layout without mutating the source. */
export function assertFullRewriteLayoutSafe(doc: PDFDocumentData, reachable: Map<string, PDFObject>): void {
  assertSerializableObjectKeys(reachable.keys());
  const entries = Array.from(reachable.entries());
  const nums = new Map<string, { objNum: number; genNum: number }>();
  const offsets = new Map<string, number>();
  let nextObjNum = 1;
  let offset = `%PDF-${doc.version}\n%\xe2\xe3\xcf\xd3\n`.length;
  for (const [key, value] of entries) {
    const [objNum, genNum] = key.split('_').map(Number);
    nums.set(key, { objNum, genNum });
    nextObjNum = Math.max(nextObjNum, objNum + 1);
    offsets.set(key, offset);
    const header = `${objNum} ${genNum} obj\n`.length;
    const body = serializeToString(value);
    offset += header + body.length + (value instanceof PDFStream
      ? '\nstream\n'.length + value.rawBytes.length + '\nendstream\nendobj\n'.length
      : '\nendobj\n'.length);
    if (!Number.isSafeInteger(offset)) throw new Error('PDF output exceeds the safe serialization length.');
  }
  const xrefOffset = offset;
  offset += buildXrefTable(entries, offsets, nums).length;
  offset += `trailer\n${trailerDictToString(outputTrailer(doc, nextObjNum))}\nstartxref\n${xrefOffset}\n%%EOF\n`.length;
  assertReaderSafeObjectNumber(nextObjNum - 1, offset);
}

/**
 * Serialize a complete PDF document to bytes.
 * This writes every object — use for "Save As" or export operations.
 */
export async function serializeDocument(doc: PDFDocumentData): Promise<Uint8Array> {
  assertFullRewriteSafe(doc);
  const reencrypt = getReencryptSaveContext(doc);
  if (doc.decryptedFromEncrypted && (!reencrypt || reencrypt.fileKey.length === 0)) {
    throw new Error('Cannot save protected PDF without its authenticated re-encryption context.');
  }
  const chunks: Uint8Array[] = [];
  const offsets = new Map<string, number>(); // key → byte offset

  // 1. Write header
  const header = stringToBytes(`%PDF-${doc.version}\n%\xe2\xe3\xcf\xd3\n`);
  chunks.push(header);
  let currentOffset = header.length;

  // 2. Collect all objects to write
  // Full serialization is also the privacy boundary: never emit detached
  // page objects or their streams. Incremental saves intentionally preserve
  // old revisions, but a complete export writes only trailer-reachable data.
  const roots = rootsFromTrailer(doc.xref.trailerDict);
  // Streams can be edited in place after reopening. Merging identical streams
  // here would make an edit to one page or resource affect another.
  const reachable = roots.length > 0
    ? garbageCollect(doc.objects, roots, { deduplicateStreams: false }).objects
    : doc.objects;
  const serializedObjects = reencrypt
    ? await prepareEncryptedObjects(reachable, doc.xref.trailerDict.getRef('Encrypt')?.toKey(), reencrypt)
    : reachable;
  const objectEntries = Array.from(serializedObjects.entries());
  assertSerializableObjectKeys(serializedObjects.keys());

  // Assign sequential object numbers
  const objNumMap = new Map<string, { objNum: number; genNum: number }>();
  let nextObjNum = 1;

  for (let i = 0; i < objectEntries.length; i++) {
    const [key] = objectEntries[i];
    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);
    objNumMap.set(key, { objNum, genNum });
    if (objNum >= nextObjNum) nextObjNum = objNum + 1;
  }

  // 3. Write all objects
  for (let i = 0; i < objectEntries.length; i++) {
    const [key, obj] = objectEntries[i];
    const nums = objNumMap.get(key)!;

    // Record offset for xref
    offsets.set(key, currentOffset);

    // Serialize the object
    const objBytes = serializeIndirectObject(nums.objNum, nums.genNum, obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // 4. Write cross-reference table
  const xrefOffset = currentOffset;
  const xrefBytes = buildXrefTable(objectEntries, offsets, objNumMap);
  chunks.push(xrefBytes);
  currentOffset += xrefBytes.length;

  // 5. Write trailer. Re-encrypted saves retain the original /Encrypt and /ID.
  const trailerDict = outputTrailer(doc, nextObjNum);

  const trailerBytes = stringToBytes(
    `trailer\n${trailerDictToString(trailerDict)}\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  chunks.push(trailerBytes);

  assertReaderSafeObjectNumber(nextObjNum - 1, currentOffset + trailerBytes.length);

  return concatByteChunks(chunks);
}

// ─── Compact serialization (ObjStm + XRef stream) ──────────────────────────

/**
 * Serialize a PDF document using Object Streams and a cross-reference stream
 * for maximum compression. Requires PDF 1.5+.
 *
 * Falls back to standard serialization on failure.
 */
export async function serializeDocumentCompact(doc: PDFDocumentData): Promise<Uint8Array> {
  // Compact writing packs all objects, including detached historical data.
  if (doc.requiresFullRewrite) return serializeDocument(doc);
  // Object streams are deliberately disabled for re-encrypted output. This
  // keeps each indirect object independently encrypted and leaves xref data
  // outside the encryption boundary.
  const reencrypt = getReencryptSaveContext(doc);
  if (doc.decryptedFromEncrypted && (!reencrypt || reencrypt.fileKey.length === 0)) {
    throw new Error('Cannot save protected PDF without its authenticated re-encryption context.');
  }
  if (reencrypt || doc.xref.trailerDict.has('Encrypt')) return serializeDocument(doc);
  try {
    return await _serializeCompact(doc);
  } catch (err) {
    console.warn('[Serializer] Compact serialization failed, falling back to standard:', err);
    return serializeDocument(doc);
  }
}

async function _serializeCompact(doc: PDFDocumentData): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  // Bump version to 1.5 if needed (ObjStm requires 1.5+)
  const version = parseFloat(doc.version) >= 1.5 ? doc.version : '1.5';
  const header = stringToBytes(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  chunks.push(header);
  let currentOffset = header.length;

  // Find the max existing object number
  let nextObjNum = 1;
  for (const key of doc.objects.keys()) {
    const objNum = parseInt(key.split('_')[0], 10);
    if (objNum >= nextObjNum) nextObjNum = objNum + 1;
  }

  const catalogRef = doc.xref.trailerDict.getRef('Root');
  const encryptRef = doc.decryptedFromEncrypted
    ? undefined
    : doc.xref.trailerDict.getRef('Encrypt');

  // Pack objects into ObjStm containers
  const pack = await packIntoObjectStreams(
    doc.objects,
    nextObjNum,
    catalogRef,
    encryptRef,
  );

  // Track offsets for standalone objects
  const standaloneOffsets = new Map<number, { offset: number; genNum: number }>();

  // Write standalone objects
  for (const [, entry] of pack.standaloneObjects) {
    standaloneOffsets.set(entry.objNum, { offset: currentOffset, genNum: entry.genNum });
    const objBytes = serializeIndirectObject(entry.objNum, entry.genNum, entry.obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Write ObjStm containers
  for (const objStm of pack.objStreams) {
    standaloneOffsets.set(objStm.objNum, { offset: currentOffset, genNum: 0 });
    const objBytes = serializeIndirectObject(objStm.objNum, 0, objStm.stream);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Find max object number across all objects (standalone + ObjStm)
  let maxObjNum = 0;
  for (const [objNum] of standaloneOffsets) {
    if (objNum > maxObjNum) maxObjNum = objNum;
  }
  for (const [objNum] of pack.packMap) {
    if (objNum > maxObjNum) maxObjNum = objNum;
  }

  // XRef stream gets the next object number
  const xrefObjNum = maxObjNum + 1;

  // Build and write xref stream
  const xrefStreamOffset = currentOffset;
  const infoRef = doc.xref.trailerDict.get('Info');
  const idArr = doc.xref.trailerDict.get('ID');

  const xrefResult = await buildXRefStream(
    standaloneOffsets,
    pack.packMap,
    xrefObjNum + 1, // Size includes the xref stream itself
    xrefObjNum,
    {
      root: catalogRef,
      info: infoRef,
      encrypt: encryptRef ?? undefined,
      id: idArr ?? undefined,
      size: xrefObjNum + 1,
    },
  );

  chunks.push(xrefResult.bytes);
  currentOffset += xrefResult.bytes.length;

  // Write startxref and %%EOF
  const footer = stringToBytes(`startxref\n${xrefStreamOffset}\n%%EOF\n`);
  chunks.push(footer);

  return concatByteChunks(chunks);
}

// ─── Cross-reference table building ─────────────────────────────────────────

function buildXrefTable(
  entries: [string, PDFObject][],
  offsets: Map<string, number>,
  objNumMap: Map<string, { objNum: number; genNum: number }>,
): Uint8Array {
  // Find max object number
  let maxObjNum = 0;
  for (let i = 0; i < entries.length; i++) {
    const nums = objNumMap.get(entries[i][0])!;
    if (nums.objNum > maxObjNum) maxObjNum = nums.objNum;
  }

  // Build offset lookup by object number
  const byObjNum = new Map<number, { offset: number; genNum: number }>();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const nums = objNumMap.get(key)!;
    const offset = offsets.get(key) ?? 0;
    byObjNum.set(nums.objNum, { offset, genNum: nums.genNum });
  }

  // Keep the historical contiguous layout for ordinary files. A sparse PDF
  // can have a huge maximum object number but only a few live objects; writing
  // every missing number would allocate an unbounded cross-reference table.
  const lines: string[] = [];
  lines.push('xref');
  if (maxObjNum > 100_000 && maxObjNum > byObjNum.size * 4) {
    lines.push('0 1', formatXrefEntry(0, 65535, 'f'));
    const nums = [...byObjNum.keys()].sort((a, b) => a - b);
    for (let at = 0; at < nums.length;) {
      let end = at + 1;
      while (end < nums.length && nums[end] === nums[end - 1] + 1) end++;
      lines.push(`${nums[at]} ${end - at}`);
      for (let i = at; i < end; i++) {
        const entry = byObjNum.get(nums[i])!;
        lines.push(formatXrefEntry(entry.offset, entry.genNum, 'n'));
      }
      at = end;
    }
    return stringToBytes(lines.join('\n') + '\n');
  }
  lines.push(`0 ${maxObjNum + 1}`);

  // Entry 0: free list head
  lines.push(formatXrefEntry(0, 65535, 'f'));

  // Entries 1 to maxObjNum
  for (let n = 1; n <= maxObjNum; n++) {
    const entry = byObjNum.get(n);
    if (entry) {
      lines.push(formatXrefEntry(entry.offset, entry.genNum, 'n'));
    } else {
      // Free entry
      lines.push(formatXrefEntry(0, 0, 'f'));
    }
  }

  return stringToBytes(lines.join('\n') + '\n');
}

function trailerDictToString(dict: PDFDict): string {
  return serializeToString(dict);
}

// ─── Utility ────────────────────────────────────────────────────────────────

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Get the next available object number in the document.
 */
export function getNextObjNum(doc: PDFDocumentData): number {
  let max = 0;
  const entries = Array.from(doc.objects.keys());
  for (let i = 0; i < entries.length; i++) {
    const objNum = parseInt(entries[i].split('_')[0], 10);
    if (objNum > max) max = objNum;
  }
  return max + 1;
}
