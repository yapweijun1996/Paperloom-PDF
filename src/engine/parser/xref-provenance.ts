import { sha256 } from '@noble/hashes/sha2.js';
import { PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import type { XRefEntry, XRefTable } from '../types';

type Source = 'strict' | 'conservative';
type Digest = ReturnType<typeof sha256.create>;

/** Keep graph-facing trailer fields while taking xref authority from the emitted revision. */
export function trailerWithXrefRevision(current: PDFDict, emitted: PDFDict): PDFDict {
  const result = new PDFDict(Array.from(current.entries()));
  for (const key of ['Size', 'Prev', 'XRefStm']) {
    const value = emitted.get(key);
    if (value === undefined) result.delete(key);
    else result.set(key, value);
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function rejectSharedBytes(raw: Uint8Array): void {
  if (typeof SharedArrayBuffer !== 'undefined' && raw.buffer instanceof SharedArrayBuffer) {
    throw new Error('Cannot safely inspect shared PDF source bytes.');
  }
}

function metadata(hash: Digest, entries: Map<string, XRefEntry>, trailer: XRefTable['trailerDict'], source: Source): void {
  const encoder = new TextEncoder();
  const values = ['Size', 'Prev', 'XRefStm'].map(key => {
    const value = trailer.get(key);
    if (value === undefined) return [key, 'absent'];
    if (value instanceof PDFNumber) return [key, 'number', value.value];
    if (value instanceof PDFRef) return [key, 'ref', value.objNum, value.genNum];
    if (value instanceof PDFName) return [key, 'name', value.name];
    if (value instanceof PDFString) return [key, 'string', value.value];
    if (value instanceof PDFHexString) return [key, 'hex', value.hex];
    return [key, 'invalid', value.constructor.name];
  });
  hash.update(encoder.encode(JSON.stringify([source, values])));
  for (const [key, entry] of entries) {
    hash.update(encoder.encode(JSON.stringify([key, entry.objNum, entry.genNum, entry.offset,
      entry.type, entry.compressedObjNum ?? null, entry.compressedIndex ?? null])));
    hash.update(new Uint8Array([0]));
  }
}

function metadataDigest(xref: XRefTable, source: Source): string {
  const hash = sha256.create();
  metadata(hash, xref.entries, xref.trailerDict, source);
  return hex(hash.digest());
}

/** Compatibility digest for older snapshots that predate separate raw hashing. */
export function xrefProvenanceDigest(raw: Uint8Array, entries: Map<string, XRefEntry>,
  trailer: XRefTable['trailerDict'], source: Source): string {
  rejectSharedBytes(raw);
  const hash = sha256.create();
  hash.update(raw);
  metadata(hash, entries, trailer, source);
  return hex(hash.digest());
}

/** Only call with a digest computed for these exact bytes in this synchronous stack. */
export function bindXrefProvenanceWithRawDigest(xref: XRefTable, source: Source, rawDigest: string): void {
  xref.provenance = { source, digest: metadataDigest(xref, source), rawDigest };
}

export function bindXrefProvenance(raw: Uint8Array, xref: XRefTable, source: Source): void {
  rejectSharedBytes(raw);
  bindXrefProvenanceWithRawDigest(xref, source, hex(sha256(raw)));
}

function validTrailer(xref: XRefTable): void {
  for (const key of ['Size', 'Prev', 'XRefStm']) {
    const value = xref.trailerDict.get(key);
    if (value !== undefined && (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.value) || value.value < 0)) {
      throw new Error('PDF object conflicts with invalid cross-reference metadata.');
    }
  }
}

/** Older synthetic snapshots have no provenance and use conservative rules. */
export function assertXrefProvenance(raw: Uint8Array, xref: XRefTable): void {
  const proof = xref.provenance;
  if (!proof) return;
  rejectSharedBytes(raw);
  validTrailer(xref);
  const valid = proof.rawDigest !== undefined
    ? proof.rawDigest === hex(sha256(raw)) && proof.digest === metadataDigest(xref, proof.source)
    : proof.digest === xrefProvenanceDigest(raw, xref.entries, xref.trailerDict, proof.source);
  if (!valid) throw new Error('PDF object conflicts because its xref or source bytes changed.');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let i = 0;
  if (left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0) {
    const count = Math.floor(left.length / 4);
    const a = new Uint32Array(left.buffer, left.byteOffset, count);
    const b = new Uint32Array(right.buffer, right.byteOffset, count);
    for (let j = 0; j < count; j++) if (a[j] !== b[j]) return false;
    i = count * 4;
  }
  for (; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

async function nativeDigest(snapshot: Uint8Array): Promise<string> {
  const buffer = snapshot.buffer as ArrayBuffer;
  const input = snapshot.byteOffset === 0 && snapshot.byteLength === buffer.byteLength
    ? buffer : buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength);
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', input);
  return hex(new Uint8Array(bytes));
}

/** Bind after a native async hash, rejecting graph or byte changes during the await. */
export async function bindXrefProvenanceAsync(raw: Uint8Array, xref: XRefTable, source: Source,
  sourceSnapshot?: Uint8Array): Promise<void> {
  rejectSharedBytes(raw);
  const before = metadataDigest(xref, source);
  const oldProof = JSON.stringify(xref.provenance);
  // The optional snapshot is an isolated, non-escaping buffer owned by the
  // caller's parse operation. It must never alias the mutable source.
  const snapshot = sourceSnapshot ?? new Uint8Array(raw);
  rejectSharedBytes(snapshot);
  if (snapshot.buffer === raw.buffer || (sourceSnapshot && !equalBytes(raw, snapshot))) {
    throw new Error('PDF source bytes changed during parsing.');
  }
  if (!globalThis.crypto?.subtle) { bindXrefProvenance(snapshot, xref, source); return; }
  const rawDigest = await nativeDigest(snapshot);
  if (!equalBytes(raw, snapshot) || before !== metadataDigest(xref, source) || oldProof !== JSON.stringify(xref.provenance)) {
    throw new Error('PDF cross-reference or source bytes changed during validation.');
  }
  xref.provenance = { source, digest: before, rawDigest };
}

/** Returns true only after validating a proof and rechecking changes across the await. */
export async function withAssertedXrefProvenance<T>(raw: Uint8Array, xref: XRefTable,
  action: (verified: boolean) => T): Promise<T> {
  const proof = xref.provenance;
  if (!proof) return action(false);
  rejectSharedBytes(raw);
  validTrailer(xref);
  if (!proof.rawDigest || !globalThis.crypto?.subtle) { assertXrefProvenance(raw, xref); return action(true); }
  const proofBefore = JSON.stringify(proof), indexBefore = metadataDigest(xref, proof.source);
  const snapshot = new Uint8Array(raw);
  const rawDigest = await nativeDigest(snapshot);
  if (!equalBytes(raw, snapshot) || proofBefore !== JSON.stringify(xref.provenance) ||
      indexBefore !== metadataDigest(xref, proof.source) || rawDigest !== proof.rawDigest || indexBefore !== proof.digest) {
    throw new Error('PDF object conflicts because its xref or source bytes changed.');
  }
  return action(true);
}

export async function assertXrefProvenanceAsync(raw: Uint8Array, xref: XRefTable): Promise<boolean> {
  return withAssertedXrefProvenance(raw, xref, verified => verified);
}
