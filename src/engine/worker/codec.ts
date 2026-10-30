import {
  PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber,
  PDFRef, PDFStream, PDFString,
  type PDFDocumentData, type PDFObject, type PDFPageInfo, type PDFRectangle,
  type XRefEntry,
} from '../types';
import { bindPageContentRefs } from '../editor/stream-compiler';
import { resolvePageResources } from '../parser/parser';

export type WireBytes = Uint8Array;
export type WireNode =
  | { id: number; kind: 'boolean'; value: boolean }
  | { id: number; kind: 'number'; value: number }
  | { id: number; kind: 'string'; value: string }
  | { id: number; kind: 'hex'; value: string }
  | { id: number; kind: 'name'; value: string }
  | { id: number; kind: 'null' }
  | { id: number; kind: 'ref'; objNum: number; genNum: number }
  | { id: number; kind: 'array'; items: number[] }
  | { id: number; kind: 'dict'; entries: [string, number][] }
  | { id: number; kind: 'stream'; dict: number; rawBytes: WireBytes; decodedBytes: WireBytes | null };

export interface WireDocument {
  version: string;
  nodes: WireNode[];
  objects: [string, number][];
  xref: { entries: [string, XRefEntry][]; trailerDict: number; provenance?: PDFDocumentData['xref']['provenance'] };
  catalog: number;
  pages: Array<{ index: number; dict: number; mediaBox: PDFRectangle; cropBox: PDFRectangle; rotate: number; ref: number; resources: number; contentRefs: number[]; contentInspectionComplete?: boolean }>;
  info: PDFDocumentData['info'];
  rawBytes: WireBytes | null;
  requiresFullRewrite?: PDFDocumentData['requiresFullRewrite'];
  decryptedFromEncrypted?: PDFDocumentData['decryptedFromEncrypted'];
  encryptionFileKey?: WireBytes;
  encryptionAlgorithm?: PDFDocumentData['encryptionAlgorithm'];
}

export interface DehydrateOptions {
  includeRawBytes?: boolean;
  includeDecodedBytes?: boolean;
  /** Search-only hook for recording stream identities without copying bodies. */
  streamBytes?: (stream: PDFStream, nodeId: number) => { rawBytes: Uint8Array; decodedBytes: Uint8Array | null };
}

// Node Buffer.slice() creates a shared view rather than an independent copy.
function copyBytes(bytes: Uint8Array): Uint8Array { return new Uint8Array(bytes); }

export function dehydrateDocument(doc: PDFDocumentData, options: DehydrateOptions = {}): WireDocument {
  const nodes: WireNode[] = [];
  const ids = new Map<object, number>();
  type Frame =
    | { kind: 'array'; value: PDFArray; node: Extract<WireNode, { kind: 'array' }>; index: number }
    | { kind: 'dict'; entries: [string, PDFObject][]; node: Extract<WireNode, { kind: 'dict' }>; index: number }
    | { kind: 'stream'; value: PDFStream; node: Extract<WireNode, { kind: 'stream' }> };
  const visit = (root: PDFObject): number => {
    const pending: Frame[] = [];
    const intern = (value: PDFObject): number => {
      const existing = ids.get(value as object);
      if (existing !== undefined) return existing;
      const id = nodes.length + 1;
      ids.set(value as object, id);
      let node: WireNode;
      if (value instanceof PDFNull) node = { id, kind: 'null' };
      else if (value instanceof PDFBoolean) node = { id, kind: 'boolean', value: value.value };
      else if (value instanceof PDFNumber) node = { id, kind: 'number', value: value.value };
      else if (value instanceof PDFString) node = { id, kind: 'string', value: value.value };
      else if (value instanceof PDFHexString) node = { id, kind: 'hex', value: value.hex };
      else if (value instanceof PDFName) node = { id, kind: 'name', value: value.name };
      else if (value instanceof PDFRef) node = { id, kind: 'ref', objNum: value.objNum, genNum: value.genNum };
      else if (value instanceof PDFArray) {
        node = { id, kind: 'array', items: [] };
        pending.push({ kind: 'array', value, node, index: 0 });
      } else if (value instanceof PDFDict) {
        node = { id, kind: 'dict', entries: [] };
        pending.push({ kind: 'dict', entries: Array.from(value.entries()), node, index: 0 });
      } else if (value instanceof PDFStream) {
        const bytes = options.streamBytes?.(value, id);
        node = { id, kind: 'stream', dict: 0, rawBytes: bytes ? bytes.rawBytes : copyBytes(value.rawBytes),
          decodedBytes: bytes ? bytes.decodedBytes : options.includeDecodedBytes !== false && value.decodedBytes ? copyBytes(value.decodedBytes) : null };
        pending.push({ kind: 'stream', value, node });
      } else throw new Error(`Unsupported PDF object in worker codec: ${(value as { constructor?: { name?: string } })?.constructor?.name ?? typeof value}`);
      // Register before processing children, preserving aliases and cycles.
      nodes.push(node);
      return id;
    };
    const rootId = intern(root);
    while (pending.length) {
      const frame = pending[pending.length - 1];
      if (frame.kind === 'stream') {
        pending.pop();
        frame.node.dict = intern(frame.value.dict);
      } else if (frame.kind === 'array') {
        if (frame.index === frame.value.items.length) pending.pop();
        else frame.node.items.push(intern(frame.value.items[frame.index++]));
      } else {
        if (frame.index === frame.entries.length) pending.pop();
        else {
          const [key, value] = frame.entries[frame.index++];
          frame.node.entries.push([key, intern(value)]);
        }
      }
    }
    return rootId;
  };
  const rawBytes = options.includeRawBytes === false ? null : copyBytes(doc.rawBytes);
  return {
    version: doc.version,
    nodes,
    objects: Array.from(doc.objects, ([key, value]) => [key, visit(value)]),
    xref: { entries: Array.from(doc.xref.entries, ([key, entry]) => [key, { ...entry }]), trailerDict: visit(doc.xref.trailerDict),
      ...(doc.xref.provenance ? { provenance: { ...doc.xref.provenance } } : {}) },
    catalog: visit(doc.catalog),
    pages: doc.pages.map((page) => ({ index: page.index, dict: visit(page.dict), mediaBox: { ...page.mediaBox }, cropBox: { ...page.cropBox }, rotate: page.rotate, ref: visit(page.ref), resources: visit(page.resources === undefined ? resolvePageResources(page.dict, doc.objects) : page.resources), contentRefs: page.contentRefs.map(visit), ...(page.contentInspectionComplete === false ? { contentInspectionComplete: false } : {}) })),
    info: { ...doc.info },
    rawBytes,
    requiresFullRewrite: doc.requiresFullRewrite,
    decryptedFromEncrypted: doc.decryptedFromEncrypted,
    encryptionFileKey: doc.encryptionFileKey ? copyBytes(doc.encryptionFileKey) : undefined,
    encryptionAlgorithm: doc.encryptionAlgorithm,
  };
}

export function hydrateDocument(wire: WireDocument, rawBytes?: Uint8Array,
  createStream?: (node: Extract<WireNode, { kind: 'stream' }>, dict: PDFDict) => PDFStream): PDFDocumentData {
  const byId = new Map<number, PDFObject>();
  // Allocate non-stream shells first so streams can retain the canonical dict.
  for (const node of wire.nodes) {
    let value: PDFObject | undefined;
    switch (node.kind) {
      case 'boolean': value = new PDFBoolean(node.value); break;
      case 'number': value = new PDFNumber(node.value); break;
      case 'string': value = new PDFString(node.value); break;
      case 'hex': value = new PDFHexString(node.value); break;
      case 'name': value = new PDFName(node.value); break;
      case 'null': value = PDFNull.instance; break;
      case 'ref': value = new PDFRef(node.objNum, node.genNum); break;
      case 'array': value = new PDFArray(); break;
      case 'dict': value = new PDFDict(); break;
    }
    if (value) byId.set(node.id, value);
  }
  const get = (id: number): PDFObject => {
    const value = byId.get(id);
    if (!value) throw new Error(`Invalid worker codec node ${id}`);
    return value;
  };
  for (const node of wire.nodes) {
    if (node.kind === 'stream') {
      const dict = get(node.dict) as PDFDict;
      byId.set(node.id, createStream ? createStream(node, dict) : new PDFStream(dict, copyBytes(node.rawBytes), node.decodedBytes ? copyBytes(node.decodedBytes) : null));
    }
  }
  for (const node of wire.nodes) {
    const value = get(node.id);
    if (node.kind === 'array') for (const id of node.items) (value as PDFArray).items.push(get(id));
    else if (node.kind === 'dict') for (const [key, id] of node.entries) (value as PDFDict).set(key, get(id));
  }
  const doc: PDFDocumentData = {
    version: wire.version,
    objects: new Map(wire.objects.map(([key, id]) => [key, get(id)])),
    xref: { entries: new Map(wire.xref.entries.map(([key, entry]) => [key, { ...entry }])), trailerDict: get(wire.xref.trailerDict) as PDFDict,
      ...(wire.xref.provenance ? { provenance: { ...wire.xref.provenance } } : {}) },
    catalog: get(wire.catalog) as PDFDict,
    pages: wire.pages.map((page): PDFPageInfo => bindPageContentRefs({ ...page, dict: get(page.dict) as PDFDict, ref: get(page.ref) as PDFRef, resources: get(page.resources) as PDFDict, contentRefs: page.contentRefs.map((id) => get(id) as PDFRef) })),
    info: { ...wire.info },
    rawBytes: rawBytes !== undefined ? rawBytes : wire.rawBytes ? copyBytes(wire.rawBytes) : new Uint8Array(),
    requiresFullRewrite: wire.requiresFullRewrite,
    decryptedFromEncrypted: wire.decryptedFromEncrypted,
    encryptionFileKey: wire.encryptionFileKey ? copyBytes(wire.encryptionFileKey) : undefined,
    encryptionAlgorithm: wire.encryptionAlgorithm,
  };
  for (const page of doc.pages) bindPageContentRefs(page, doc);
  return doc;
}

export function collectTransferBuffers(wire: WireDocument): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const node of wire.nodes) {
    if (node.kind === 'stream') { buffers.push(node.rawBytes.buffer as ArrayBuffer); if (node.decodedBytes) buffers.push(node.decodedBytes.buffer as ArrayBuffer); }
  }
  if (wire.rawBytes) buffers.push(wire.rawBytes.buffer as ArrayBuffer);
  return buffers;
}

export function extractNewObjects(doc: PDFDocumentData, keys: string[]): Map<string, PDFObject> {
  return new Map(keys.map((key) => {
    const value = doc.objects.get(key);
    if (!value) throw new Error(`Missing new object ${key}`);
    return [key, value] as const;
  }));
}

/** Compare private worker snapshots without serializing PDF streams. Decoded
 * stream data is a cache; only the raw stream bytes are part of the document. */
export function sameDocumentSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
    let index = 0;
    if (left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0) {
      const words = Math.floor(left.length / 4);
      const leftWords = new Uint32Array(left.buffer, left.byteOffset, words);
      const rightWords = new Uint32Array(right.buffer, right.byteOffset, words);
      for (let i = 0; i < words; i++) if (leftWords[i] !== rightWords[i]) return false;
      index = words * 4;
    }
    for (; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => sameDocumentSnapshot(item, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const skipCache = a.kind === 'stream' && b.kind === 'stream';
  const keys = Object.keys(a).filter(key => !skipCache || key !== 'decodedBytes');
  const otherKeys = Object.keys(b).filter(key => !skipCache || key !== 'decodedBytes');
  return keys.length === otherKeys.length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(b, key) && sameDocumentSnapshot(a[key], b[key]));
}
