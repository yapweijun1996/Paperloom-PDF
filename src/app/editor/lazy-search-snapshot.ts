import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '@/engine/types';
import { dehydrateDocument, hydrateDocument, sameDocumentSnapshot, type WireDocument } from '@/engine/worker/codec';

const SNAPSHOT_BUDGET = 8 * 1024 * 1024;
const MAX_OBJECTS = 250_000;
const MAX_ROOT_ITEMS = 500_000;
const MAX_STREAMS = 16_384;
const MAX_ARRAY_LENGTH = 100_000;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(typedArrayBuffer.call(new Uint8Array(0))), 'byteLength')!.get!;

export class LazySearchBudgetExceeded extends Error {}
export class SearchScanCancelled extends Error {}
export interface StreamBytes { raw: Uint8Array; decoded: Uint8Array | null }
export type StreamDependencies = Map<number, StreamBytes>;
export interface SearchShell { wire: WireDocument; streams: Map<number, PDFStream> }

function safeView(bytes: Uint8Array): Uint8Array {
  try {
    if (typedArrayTag.call(bytes) !== 'Uint8Array') throw new Error('Not a byte array');
    const buffer = typedArrayBuffer.call(bytes) as ArrayBuffer;
    arrayBufferByteLength.call(buffer);
    return new Uint8Array(buffer, typedArrayOffset.call(bytes), typedArrayLength.call(bytes));
  } catch { throw new Error('Search cannot safely inspect shared or invalid stream buffers.'); }
}

export function searchByteLength(bytes: Uint8Array): number { return safeView(bytes).length; }

const OBJECT_SHAPES: Array<[object, readonly string[]]> = [
    [PDFArray.prototype, ['_tag', 'items']], [PDFBoolean.prototype, ['_tag', 'value']],
    [PDFDict.prototype, ['_tag', 'map']], [PDFHexString.prototype, ['_tag', 'hex']],
    [PDFName.prototype, ['_tag', 'name']], [PDFNull.prototype, ['_tag']],
    [PDFNumber.prototype, ['_tag', 'value']], [PDFRef.prototype, ['_tag', 'objNum', 'genNum']],
    [PDFStream.prototype, ['_tag', 'dict', 'rawBytes', 'decodedBytes']], [PDFString.prototype, ['_tag', 'value']],
];

/** A private clone must not erase user-defined object behavior. */
export function standardSearchObject(value: PDFObject, isCurrent?: () => boolean): boolean {
  const shape = OBJECT_SHAPES.find(([prototype]) => Object.getPrototypeOf(value) === prototype);
  if (!shape) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== shape[1].length || keys.some(key => typeof key !== 'string' || !shape[1].includes(key))) return false;
  if (keys.some(key => !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return false;
  if (value instanceof PDFDict) {
    const map = (value as unknown as { map: Map<string, PDFObject> }).map;
    if (!(map instanceof Map) || Object.getPrototypeOf(map) !== Map.prototype || Reflect.ownKeys(map).length) return false;
  } else if (value instanceof PDFArray) {
    const items = value.items;
    if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype) return false;
    if (items.length > MAX_ARRAY_LENGTH) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if (Reflect.ownKeys(items).length !== items.length + 1) return false;
    for (let i = 0; i < items.length; i++) {
      if (i >= MAX_ARRAY_LENGTH) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
      if ((i & 2047) === 2047 && isCurrent && !isCurrent()) throw new SearchScanCancelled();
      const descriptor = Object.getOwnPropertyDescriptor(items, String(i));
      if (!descriptor || !('value' in descriptor)) return false;
    }
  }
  return true;
}

function plainRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(key => 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

function plainArray(value: unknown, isCurrent?: () => boolean): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (value.length > MAX_ARRAY_LENGTH) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (i >= MAX_ARRAY_LENGTH) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if ((i & 2047) === 2047 && isCurrent && !isCurrent()) throw new SearchScanCancelled();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) return false;
  }
  return true;
}

function plainMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map && Object.getPrototypeOf(value) === Map.prototype && Reflect.ownKeys(value).length === 0;
}

/** Check the containers before accessing their sizes or contents. */
function standardRootContainers(doc: PDFDocumentData, isCurrent?: () => boolean): boolean {
  if (!plainRecord(doc) || !plainMap(doc.objects) || !plainRecord(doc.xref) ||
      !plainMap(doc.xref.entries) || !plainArray(doc.pages, isCurrent) || !plainRecord(doc.info)) return false;
  if (doc.objects.size > MAX_OBJECTS || doc.xref.entries.size > MAX_OBJECTS) {
    throw new Error('Search graph exceeds the shared-buffer inspection limit.');
  }
  return true;
}

/** A cheap budget preflight avoids rechecking an oversized graph for each snapshot attempt. */
export function searchRootEstimate(doc: PDFDocumentData, isCurrent?: () => boolean): number | null {
  if (!standardRootContainers(doc, isCurrent)) return null;
  return doc.objects.size * 64 + doc.xref.entries.size * 64 + doc.pages.length * 256 +
    (doc.encryptionFileKey ? searchByteLength(doc.encryptionFileKey) : 0);
}

/** Reject behavior that serialization would erase, including container overrides. */
export function standardSearchRoots(doc: PDFDocumentData, isCurrent?: () => boolean): boolean {
  if (!standardRootContainers(doc, isCurrent)) return false;
  let items = doc.pages.length + doc.xref.entries.size;
  if (items > MAX_ROOT_ITEMS) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
  let steps = 0;
  for (const page of doc.pages) {
    if (++steps > MAX_ROOT_ITEMS) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if ((steps & 2047) === 0 && isCurrent && !isCurrent()) throw new SearchScanCancelled();
    if (!plainRecord(page) || !Array.isArray(page.contentRefs)) return false;
    items += page.contentRefs.length;
    if (items > MAX_ROOT_ITEMS) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if (!plainArray(page.contentRefs, isCurrent) || !plainRecord(page.mediaBox) || !plainRecord(page.cropBox)) return false;
  }
  for (const entry of doc.xref.entries.values()) {
    if (++steps > MAX_ROOT_ITEMS) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if ((steps & 2047) === 0) {
      if (isCurrent && !isCurrent()) throw new SearchScanCancelled();
      if (doc.xref.entries.size > MAX_OBJECTS) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    }
    if (!plainRecord(entry)) return false;
  }
  return !doc.xref.provenance || plainRecord(doc.xref.provenance);
}

/** Snapshot the graph's structure without reading any stream payload. */
export function captureSearchShell(doc: PDFDocumentData, isCurrent?: () => boolean): SearchShell | null {
  let size = searchRootEstimate(doc, isCurrent);
  if (size === null || size > SNAPSHOT_BUDGET || !standardSearchRoots(doc, isCurrent)) return null;
  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [...doc.objects.values(), doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) {
    pending.push(page.dict, page.resources, page.ref);
    for (const ref of page.contentRefs) pending.push(ref);
  }
  while (pending.length) {
    const obj = pending.pop()!;
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (seen.size > MAX_OBJECTS || !standardSearchObject(obj, isCurrent)) return null;
    size += 64;
    if (obj instanceof PDFStream) pending.push(obj.dict);
    else if (obj instanceof PDFArray) {
      size += obj.items.length * 16;
      if (size > SNAPSHOT_BUDGET) return null;
      for (const item of obj.items) pending.push(item);
    } else if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        size += key.length * 2 + 24;
        if (size > SNAPSHOT_BUDGET) return null;
        pending.push(value);
      }
    } else if (obj instanceof PDFString) size += obj.value.length * 2;
    else if (obj instanceof PDFHexString) size += obj.hex.length * 2;
    else if (obj instanceof PDFName) size += obj.name.length * 2;
    if (size > SNAPSHOT_BUDGET) return null;
  }
  const streams = new Map<number, PDFStream>();
  try {
    const wire = dehydrateDocument(doc, { includeRawBytes: false, streamBytes: (stream, id) => {
      streams.set(id, stream);
      return { rawBytes: new Uint8Array(0), decodedBytes: null };
    } });
    return { wire, streams };
  } catch { return null; }
}

/** Compare structure and all stream payloads actually read by previous scans. */
export function equalSearchShell(left: SearchShell, right: SearchShell, dependencies: StreamDependencies): boolean {
  if (!sameDocumentSnapshot(left.wire, right.wire)) return false;
  for (const [id, baseline] of dependencies) {
    const stream = right.streams.get(id);
    if (!stream) return false;
    const raw = safeView(stream.rawBytes), decoded = stream.decodedBytes ? safeView(stream.decodedBytes) : null;
    if (!sameDocumentSnapshot(baseline.raw, raw) || !sameDocumentSnapshot(baseline.decoded, decoded)) return false;
  }
  return true;
}

/** Read payloads lazily from the source and keep an immutable validation copy. */
export function hydrateSearchShell(shell: SearchShell, dependencies: StreamDependencies, onFailure: (error: unknown) => void): PDFDocumentData {
  let bytes = 0;
  for (const value of dependencies.values()) bytes += value.raw.length + (value.decoded?.length ?? 0);
  return hydrateDocument(shell.wire, undefined, (node, dict) => {
    const source = shell.streams.get(node.id);
    if (!source) throw new Error('Search stream snapshot is incomplete.');
    const stream = new PDFStream(dict, new Uint8Array(0));
    let loaded = false;
    let raw: Uint8Array = new Uint8Array(0), decoded: Uint8Array | null = null;
    const load = () => {
      if (loaded) return;
      try {
      let baseline = dependencies.get(node.id);
      if (!baseline) {
        if (dependencies.size >= MAX_STREAMS) throw new LazySearchBudgetExceeded();
        const sourceRaw = safeView(source.rawBytes), sourceDecoded = source.decodedBytes ? safeView(source.decodedBytes) : null;
        const total = sourceRaw.length + (sourceDecoded?.length ?? 0);
        if (total > SNAPSHOT_BUDGET - bytes) throw new LazySearchBudgetExceeded();
        bytes += total;
        baseline = { raw: new Uint8Array(sourceRaw), decoded: sourceDecoded ? new Uint8Array(sourceDecoded) : null };
        dependencies.set(node.id, baseline);
      }
      raw = new Uint8Array(baseline.raw);
      decoded = baseline.decoded ? new Uint8Array(baseline.decoded) : null;
      loaded = true;
      } catch (error) { onFailure(error); throw error; }
    };
    Object.defineProperties(stream, {
      rawBytes: { enumerable: true, get: () => { load(); return raw; }, set: (value: Uint8Array) => { load(); raw = value; } },
      decodedBytes: { enumerable: true, get: () => { load(); return decoded; }, set: (value: Uint8Array | null) => { load(); decoded = value; } },
    });
    return stream;
  });
}
