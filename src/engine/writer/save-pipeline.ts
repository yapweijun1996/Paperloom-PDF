/**
 * Save pipeline — quick (incremental) vs optimized (GC + dedup + full serialize).
 */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';
import { PDFLexer, TokenType } from '../parser/lexer';
import { assertFullRewriteSafe, serializeDocument } from './serializer';
import { saveIncrementalPrevalidated } from './incremental-writer';
import { garbageCollect, rootsFromTrailer } from '../optimize';
import { getReencryptSaveContext } from '../security/encryption/encrypt-objects';
import { parsePDF } from '../parser/parser';
import { pageContentModifiedKeys, serializeToString } from '../editor/stream-compiler';
import { decryptDocumentObjects } from '../security/encryption/decrypt-pipeline';
import { parseFileId } from '../security/encryption/encrypt-dict';
import { unicodeFontModifiedKeys } from '../fonts/unicode-font-embed';
import { registeredFontKeys } from '../fonts/font-augmentation';
import { extractNewObjects, hydrateDocument } from '../worker/codec';
import { coordinateOptimizedSave, coordinateQuickSave } from './save-coordinator';
import { getSavedMetadataPatch, updateExistingSaveMetadata } from './save-metadata';
import { assertNewObjectsDoNotCollide, assertUniqueIncrementalObjectNumbers, withVerifiedDocumentXref } from './new-object-safety';

export class SignedDocumentEditError extends Error {
  constructor() {
    super('This document is digitally signed; edits would invalidate the signature.');
    this.name = 'SignedDocumentEditError';
  }
}

function equalObjects(a: PDFObject | undefined, b: PDFObject | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a._tag !== b._tag) return false;
  if (a instanceof PDFStream && b instanceof PDFStream) {
    // Decoded bytes are a rendering cache; writers emit the raw stream bytes.
    return equalObjects(a.dict, b.dict) &&
      a.rawBytes.length === b.rawBytes.length &&
      a.rawBytes.every((byte, i) => byte === b.rawBytes[i]);
  }
  if (a instanceof PDFDict && b instanceof PDFDict) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      if (!equalObjects(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof PDFArray && b instanceof PDFArray) {
    return a.length === b.length && a.items.every((value, i) => equalObjects(value, b.get(i)));
  }
  if (a instanceof PDFHexString && b instanceof PDFHexString) {
    return a.hex.replace(/\s/g, '').toLowerCase() === b.hex.replace(/\s/g, '').toLowerCase();
  }
  return serializeToString(a) === serializeToString(b);
}

/** Compare exportable state, not xref offsets, trailer bookkeeping or render caches. */
export async function hasDocumentEdits(doc: PDFDocumentData): Promise<boolean> {
  const original = await parsePDF(doc.rawBytes);
  const encryption = getReencryptSaveContext(doc);
  if (encryption) {
    await decryptDocumentObjects(original, {
      ...encryption,
      fileId: parseFileId(original.xref.trailerDict),
      isOwner: false,
    });
  }
  // Full serialization only writes trailer-reachable objects. Parser-only
  // object-stream and xref containers can remain in memory after that rewrite.
  const roots = rootsFromTrailer(doc.xref.trailerDict);
  const originalRoots = rootsFromTrailer(original.xref.trailerDict);
  // Comparing a signed revision must not merge distinct source objects first.
  const objects = roots.length ? garbageCollect(doc.objects, roots, { deduplicateStreams: false }).objects : doc.objects;
  const originalObjects = originalRoots.length ? garbageCollect(original.objects, originalRoots, { deduplicateStreams: false }).objects : original.objects;
  if (doc.version !== original.version || objects.size !== originalObjects.size) return true;
  for (const [key, value] of objects) {
    if (!equalObjects(value, originalObjects.get(key))) return true;
  }
  for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
    if (!equalObjects(doc.xref.trailerDict.get(key), original.xref.trailerDict.get(key))) return true;
  }
  return false;
}

/** Finalized signed bytes may be reused only when the document has no edits. */
export function hasFinalizedSignature(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length === 0) return false;
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  // PDF names may escape individual bytes, and comments are legal between
  // tokens. Searching the raw prefix also protects signatures removed from the
  // live graph after a user edit.
  const name = (value: string) => [...value].map(c => `(?:${c}|#${c.charCodeAt(0).toString(16).padStart(2, '0')})`).join('');
  const tokenAt = (offset: number) => new PDFLexer(bytes, offset);
  const byteRange = new RegExp(`/${name('ByteRange')}(?=[\\x00\\x09\\x0a\\x0c\\x0d\\x20()<>\\[\\]{}/%]|$)`, 'gi');
  let possibleRange = false;
  for (const match of text.matchAll(byteRange)) {
    const lexer = tokenAt(match.index! + match[0].length);
    const first = lexer.nextToken();
    if (first?.type === TokenType.Keyword && first.value === '[') {
      const values = Array.from({ length: 4 }, () => lexer.nextToken());
      const end = lexer.nextToken();
      if (values.every(token => token?.type === TokenType.Integer) &&
          end?.type === TokenType.Keyword && end.value === ']' &&
          values.some(token => token!.value !== 0)) {
        possibleRange = true;
        break;
      }
    } else if (first?.type === TokenType.Integer) {
      const generation = lexer.nextToken();
      const reference = lexer.nextToken();
      if (generation?.type === TokenType.Integer && reference?.type === TokenType.Keyword && reference.value === 'R') {
        possibleRange = true;
        break;
      }
    }
  }
  if (!possibleRange) return false;
  const contents = new RegExp(`/${name('Contents')}(?=[\\x00\\x09\\x0a\\x0c\\x0d\\x20()<>\\[\\]{}/%]|$)`, 'gi');
  for (const match of text.matchAll(contents)) {
    const lexer = tokenAt(match.index! + match[0].length);
    const value = lexer.nextToken();
    if (value?.type === TokenType.HexString && /[1-9a-f]/i.test(String(value.value))) return true;
    if (value?.type === TokenType.String && [...String(value.value)].some(c => c.charCodeAt(0) !== 0)) return true;
    // Indirect Contents cannot be established from raw syntax alone.
    if (value?.type === TokenType.Integer) {
      const generation = lexer.nextToken();
      const reference = lexer.nextToken();
      if (generation?.type === TokenType.Integer && reference?.type === TokenType.Keyword && reference.value === 'R') return true;
    }
  }
  return false;
}

/** Detect signature values in parsed object graphs, including indirect values. */
export function hasDocumentSignature(doc: PDFDocumentData): boolean {
  if (hasFinalizedSignature(doc.rawBytes)) return true;
  const resolve = (value: PDFObject | undefined): PDFObject | undefined => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key)) return undefined;
      seen.add(key);
      value = doc.objects.get(key);
    }
    return value;
  };
  const pending: PDFObject[] = [...doc.objects.values(), doc.catalog, doc.xref.trailerDict];
  const visited = new Set<PDFObject>();
  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (value instanceof PDFRef) {
      const resolved = resolve(value);
      if (resolved) pending.push(resolved);
    } else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      if (value.has('ByteRange') && value.has('Contents')) {
        const range = resolve(value.get('ByteRange'));
        const content = resolve(value.get('Contents'));
        const validEmptyRange = range instanceof PDFArray && range.length === 4 && range.items.every(item => {
          const number = resolve(item);
          return number instanceof PDFNumber && number.value === 0;
        });
        const validEmptyContent = (content instanceof PDFHexString || content instanceof PDFString) && content.toBytes().every(byte => byte === 0);
        // A malformed or unresolved signature value is not safe to rewrite.
        if (!validEmptyRange || !validEmptyContent) return true;
      }
      // A signature field with an unresolvable value may hide a signature.
      const fieldType = resolve(value.get('FT'));
      if (fieldType instanceof PDFName && fieldType.name === 'Sig' && value.has('V') && !resolve(value.get('V'))) return true;
      pending.push(...value.values());
    }
  }
  return false;
}

/**
 * Quick save: append only changed objects when possible.
 * Finalized signed documents preserve their bytes, or throw SignedDocumentEditError for edits.
 */
export function saveQuick(
  doc: PDFDocumentData,
  modifiedKeys?: Set<string>,
  newObjects?: Map<string, PDFObject>,
): Promise<Uint8Array> {
  return coordinateQuickSave(doc, modifiedKeys, newObjects, async request => {
    const staged = hydrateDocument(request.document);
    const before = staged.rawBytes;
    const newEntries = request.newObjectKeys ? extractNewObjects(staged, request.newObjectKeys) : undefined;
    const bytes = await saveQuickUnchecked(staged, request.modifiedKeys, newEntries);
    return { bytes, rawBytesAdvanced: staged.rawBytes === bytes && staged.rawBytes !== before, metadata: getSavedMetadataPatch(staged) };
  });
}

/** Internal writer for a document already isolated by the save coordinator. */
export async function saveQuickUnchecked(
  doc: PDFDocumentData,
  modifiedKeys?: Set<string>,
  newObjects?: Map<string, PDFObject>,
): Promise<Uint8Array> {
  const reencrypt = getReencryptSaveContext(doc);
  if (doc.decryptedFromEncrypted && (!reencrypt || reencrypt.fileKey.length === 0)) {
    throw new Error('Cannot save protected PDF without its authenticated re-encryption context.');
  }
  if (hasDocumentSignature(doc)) {
    if (!doc.rawBytes.length) throw new SignedDocumentEditError();
    if (doc.requiresFullRewrite || modifiedKeys?.size || newObjects?.size || await hasDocumentEdits(doc)) {
      throw new SignedDocumentEditError();
    }
    return new Uint8Array(doc.rawBytes);
  }
  if (doc.requiresFullRewrite) {
    if (newObjects?.size) {
      throw new Error('A full rewrite is required after security cleanup; add new objects to the document before saving.');
    }
    return serializeDocument(doc);
  }
  if (doc.rawBytes.length === 0) {
    return serializeDocument(doc);
  }

  // Invalid explicit changes must not fall back to a full save or mutate
  // metadata before the incremental writer reports a collision.
  if (modifiedKeys?.size || newObjects?.size) {
    await withVerifiedDocumentXref(doc, verified => {
      const checked = assertNewObjectsDoNotCollide(doc, newObjects, verified);
      assertUniqueIncrementalObjectNumbers(doc, new Set([...modifiedKeys ?? [],
        ...unicodeFontModifiedKeys(doc.objects), ...registeredFontKeys(doc.objects),
        ...pageContentModifiedKeys(doc.objects)]), newObjects, checked || verified);
    });
  }

  const encryptedObjects = doc.xref.trailerDict.has('Encrypt') && !doc.decryptedFromEncrypted;
  const hasMetadata = doc.xref.trailerDict.has('Info') || doc.catalog.has('Metadata');
  const changedMetadata = hasMetadata && !encryptedObjects && (newObjects?.size || await hasDocumentEdits(doc))
    ? updateExistingSaveMetadata(doc) : new Set<string>();

  // The original encrypted prefix cannot be combined with plaintext editor
  // objects. Rebuild a complete encrypted revision instead.
  if (reencrypt) {
    return serializeDocument(doc);
  }

  const mods = new Set(modifiedKeys);
  const hasExplicitEdits = !!(modifiedKeys?.size || newObjects?.size);
  if (hasExplicitEdits) for (const key of changedMetadata) mods.add(key);
  if (modifiedKeys?.size || newObjects?.size) {
    for (const key of unicodeFontModifiedKeys(doc.objects)) mods.add(key);
    for (const key of registeredFontKeys(doc.objects)) mods.add(key);
    for (const key of pageContentModifiedKeys(doc.objects)) mods.add(key);
  }
  if (mods.size === 0 && (!newObjects || newObjects.size === 0)) {
    return serializeDocument(doc);
  }

  return withVerifiedDocumentXref(doc, (verified, token) => {
    const checked = assertNewObjectsDoNotCollide(doc, newObjects, verified);
    assertUniqueIncrementalObjectNumbers(doc, mods, newObjects, checked || verified);
    try {
      return saveIncrementalPrevalidated(doc, mods, newObjects, token);
    } catch {
      return serializeDocument(doc);
    }
  });
}

/**
 * Optimized save: garbage-collect unreachable objects and fully serialize.
 * Signed-document edit detection compares the object graph with the finalized bytes.
 */
export function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  return coordinateOptimizedSave(doc, wire => saveOptimizedUnchecked(hydrateDocument(wire)));
}

/** Internal writer for a document already isolated by the save coordinator. */
export async function saveOptimizedUnchecked(doc: PDFDocumentData): Promise<Uint8Array> {
  assertFullRewriteSafe(doc);
  const reencrypt = getReencryptSaveContext(doc);
  if (doc.decryptedFromEncrypted && (!reencrypt || reencrypt.fileKey.length === 0)) {
    throw new Error('Cannot save protected PDF without its authenticated re-encryption context.');
  }
  if (hasDocumentSignature(doc)) {
    if (!doc.rawBytes.length) throw new SignedDocumentEditError();
    if (doc.requiresFullRewrite || await hasDocumentEdits(doc)) throw new SignedDocumentEditError();
    return new Uint8Array(doc.rawBytes);
  }
  if (!doc.requiresFullRewrite && doc.rawBytes.length &&
      (doc.xref.trailerDict.has('Info') || doc.catalog.has('Metadata')) &&
      (!doc.xref.trailerDict.has('Encrypt') || doc.decryptedFromEncrypted) &&
      await hasDocumentEdits(doc)) updateExistingSaveMetadata(doc);
  try {
    const roots = rootsFromTrailer(doc.xref.trailerDict);
    // Existing edit paths may replace a stream by reference. Sharing a newly
    // deduplicated stream would cause unrelated resources to change together.
    const gc = garbageCollect(doc.objects, roots, { deduplicateStreams: false });
    doc.objects.clear();
    for (const [k, v] of gc.objects) {
      doc.objects.set(k, v);
    }
  } catch { /* The full serializer performs its own safe reachability check. */ }
  return serializeDocument(doc);
}

export type SaveMode = 'quick' | 'optimized';

export async function saveDocument(
  doc: PDFDocumentData,
  mode: SaveMode = 'optimized',
): Promise<Uint8Array> {
  return mode === 'quick' ? saveQuick(doc) : saveOptimized(doc);
}
