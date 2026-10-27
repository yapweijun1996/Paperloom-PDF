/**
 * PDF optimization types — object graphs, deduplication, garbage collection.
 */

import type { PDFObject, PDFRef } from '../types';

/** Edge in the object reference graph. */
export interface ObjectGraphEdge {
  from: string;
  to: string;
  /** Dictionary key or array index that introduced the reference. */
  via: string;
}

/** Directed graph of indirect object reachability. */
export interface ObjectGraph {
  /** All known object keys "objNum_genNum". */
  nodes: Set<string>;
  edges: ObjectGraphEdge[];
  /** Root refs used for reachability (catalog, info, etc.). */
  roots: string[];
}

/** Result of reachability analysis from document roots. */
export interface ReachabilityResult {
  reachable: Set<string>;
  unreachable: Set<string>;
  graph: ObjectGraph;
}

/** Duplicate stream cluster sharing identical decoded bytes. */
export interface StreamDuplicateGroup {
  hash: string;
  /** Canonical keeper key. */
  keeper: string;
  /** Duplicate object keys to remap or delete. */
  duplicates: string[];
  /** Total bytes saved if duplicates removed. */
  bytesSaved: number;
}

export interface DeduplicateResult {
  groups: StreamDuplicateGroup[];
  /** Ref remap table: duplicate key → keeper key. */
  refMap: Map<string, string>;
  totalBytesSaved: number;
}

export interface GarbageCollectResult {
  beforeCount: number;
  afterCount: number;
  removedKeys: string[];
  /** Updated object map with unreachable objects removed. */
  objects: Map<string, PDFObject>;
  /** Ref replacements applied during dedup (optional). */
  refMap: Map<string, string>;
}

export interface OptimizeOptions {
  /** Run stream deduplication before GC. */
  deduplicateStreams: boolean;
  /** Hash algorithm for stream content. */
  hashFn: (bytes: Uint8Array) => string;
  /** Additional root refs beyond catalog trailer chain. */
  extraRoots: PDFRef[];
}

export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = {
  deduplicateStreams: true,
  hashFn: fnv1aHex,
  extraRoots: [],
};

/** FNV-1a 32-bit hash as hex string — fast, browser-safe. */
export function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
