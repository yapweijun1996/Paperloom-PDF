/**
 * PDF optimization — object reachability graph, stream deduplication,
 * and garbage collection of unreachable indirect objects.
 *
 * ISO 32000-2: orphaned objects may be removed during save optimization.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from '../types';
import type {
  DeduplicateResult,
  GarbageCollectResult,
  ObjectGraph,
  ObjectGraphEdge,
  OptimizeOptions,
  ReachabilityResult,
  StreamDuplicateGroup,
} from './types';
import { DEFAULT_OPTIMIZE_OPTIONS } from './types';
import { serializeToString } from '../editor/stream-compiler';

// ─── Object graph construction ───────────────────────────────────────────────

function refKey(ref: PDFRef): string {
  return ref.toKey();
}

const MAX_OBJECT_WALK_WORK = 1_000_000;
function collectRefs(obj: PDFObject, fromKey: string, edges: ObjectGraphEdge[], deduplicate: boolean): void {
  type Task = { kind: 'visit'; value: PDFObject; via: string } | { kind: 'leave'; value: PDFObject };
  const pending: Task[] = [{ kind: 'visit', value: obj, via: 'ref' }];
  const active = new Set<PDFObject>();
  const visited = new Set<PDFObject>();
  let scheduled = 1;
  while (pending.length) {
    const task = pending.pop()!;
    if (task.kind === 'leave') { active.delete(task.value); continue; }
    const value = task.value;
    if (value instanceof PDFRef) {
      edges.push({ from: fromKey, to: refKey(value), via: task.via });
    } else if (value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream) {
      if (active.has(value)) throw new Error('Cannot inspect a cyclic direct PDF object.');
      // Garbage collection only needs reachability; a shared direct subtree
      // contributes the same targets even if reached through multiple paths.
      if (deduplicate && visited.has(value)) continue;
      visited.add(value);
      active.add(value);
      pending.push({ kind: 'leave', value });
      if (value instanceof PDFArray) {
        if (value.length > MAX_OBJECT_WALK_WORK - scheduled) throw new Error('PDF object exceeds the reference inspection work limit.');
        scheduled += value.length;
        for (let i = value.length - 1; i >= 0; i--) {
          pending.push({ kind: 'visit', value: value.items[i], via: `[${i}]` });
        }
      } else if (value instanceof PDFDict) {
        if (value.size > MAX_OBJECT_WALK_WORK - scheduled) throw new Error('PDF object exceeds the reference inspection work limit.');
        scheduled += value.size;
        const entries = [...value.entries()];
        for (let i = entries.length - 1; i >= 0; i--) {
          pending.push({ kind: 'visit', value: entries[i][1], via: entries[i][0] });
        }
      } else {
        if (++scheduled > MAX_OBJECT_WALK_WORK) throw new Error('PDF object exceeds the reference inspection work limit.');
        pending.push({ kind: 'visit', value: value.dict, via: 'ref' });
      }
    }
  }
}

/**
 * Build a reference graph over all objects in the map, retaining the order and
 * multiplicity of edges from shared direct containers.
 */
export function buildObjectGraph(
  objects: Map<string, PDFObject>,
  roots: PDFRef[],
): ObjectGraph {
  return buildGraph(objects, roots, false);
}

function buildGraph(objects: Map<string, PDFObject>, roots: PDFRef[], deduplicate: boolean): ObjectGraph {
  const nodes = new Set(objects.keys());
  const edges: ObjectGraphEdge[] = [];
  const rootKeys = roots.map(refKey);

  for (const [key, obj] of objects.entries()) {
    collectRefs(obj, key, edges, deduplicate);
  }

  return { nodes, edges, roots: rootKeys };
}

/**
 * DFS reachability from root object keys.
 */
export function computeReachability(graph: ObjectGraph): ReachabilityResult {
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const reachable = new Set<string>();
  const stack = [...graph.roots];

  while (stack.length > 0) {
    const key = stack.pop()!;
    if (reachable.has(key)) continue;
    if (!graph.nodes.has(key)) continue;
    reachable.add(key);
    const neighbors = adj.get(key) ?? [];
    for (const n of neighbors) stack.push(n);
  }

  const unreachable = new Set<string>();
  for (const node of graph.nodes) {
    if (!reachable.has(node)) unreachable.add(node);
  }

  return { reachable, unreachable, graph };
}

/** Extract root refs from trailer dict (/Root, /Info, /Encrypt). */
export function rootsFromTrailer(trailer: PDFDict, extra: PDFRef[] = []): PDFRef[] {
  const roots: PDFRef[] = [...extra];
  for (const key of ['Root', 'Info', 'Encrypt'] as const) {
    const ref = trailer.getRef(key);
    if (ref) roots.push(ref);
  }
  return roots;
}

// ─── Stream deduplication ────────────────────────────────────────────────────

function streamBytes(obj: PDFObject): Uint8Array | null {
  if (!(obj instanceof PDFStream)) return null;
  // The writer persists raw bytes, not the optional decoded cache.
  return obj.rawBytes;
}

interface DedupDictionaryBudget { nodes: number; chars: number; exhausted: boolean }
const MAX_DEDUP_DICT_NODES = 262_144;
const MAX_DEDUP_DICT_CHARS = 8 * 1024 * 1024;

/** Bound dictionary serialization before invoking the general-purpose writer. */
function canInspectDedupDictionary(root: PDFDict, budget: DedupDictionaryBudget): boolean {
  type Task = { value: PDFObject; leave?: boolean };
  const pending: Task[] = [{ value: root }], active = new Set<PDFObject>();
  const charge = (chars: number): boolean => {
    if (!Number.isSafeInteger(chars) || chars > MAX_DEDUP_DICT_CHARS - budget.chars) {
      budget.exhausted = true;
      return false;
    }
    budget.chars += chars;
    return true;
  };
  while (pending.length) {
    const { value, leave } = pending.pop()!;
    if (leave) { active.delete(value); continue; }
    if (++budget.nodes > MAX_DEDUP_DICT_NODES || pending.length > MAX_DEDUP_DICT_NODES - budget.nodes) {
      budget.exhausted = true;
      return false;
    }
    if (value instanceof PDFString) { if (!charge(value.value.length * 8 + 2)) return false; }
    else if (value instanceof PDFHexString) { if (!charge(value.hex.length + 2)) return false; }
    else if (value instanceof PDFName) { if (!charge(value.name.length * 6 + 1)) return false; }
    else if (value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream) {
      if (active.has(value)) return false;
      active.add(value);
      pending.push({ value, leave: true });
      if (value instanceof PDFArray) {
        if (value.length > MAX_DEDUP_DICT_NODES - budget.nodes - pending.length) { budget.exhausted = true; return false; }
        for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value.items[i] });
      } else if (value instanceof PDFDict) {
        if (value.size > MAX_DEDUP_DICT_NODES - budget.nodes - pending.length) { budget.exhausted = true; return false; }
        for (const [key, child] of value.entries()) {
          if (!charge(key.length * 6 + 2)) return false;
          pending.push({ value: child });
        }
      } else pending.push({ value: value.dict });
    } else if (!charge(64)) return false;
  }
  return true;
}

/**
 * Deduplicate only streams that serialize to the same dictionary and have
 * byte-identical raw data. A content hash alone does not establish equality,
 * and identical samples may describe different images, fonts or filters.
 */
export function deduplicateStreams(
  objects: Map<string, PDFObject>,
  hashFn = DEFAULT_OPTIMIZE_OPTIONS.hashFn,
): DeduplicateResult {
  const byHash = new Map<string, string[]>();
  const refMap = new Map<string, string>();
  const groups: StreamDuplicateGroup[] = [];
  let totalBytesSaved = 0;

  for (const [key, obj] of objects.entries()) {
    const bytes = streamBytes(obj);
    if (!bytes || bytes.length === 0) continue;
    const hash = hashFn(bytes);
    const list = byHash.get(hash) ?? [];
    list.push(key);
    byHash.set(hash, list);
  }

  // A hostile or custom hash can put many distinct streams in one bucket.
  // Stop attempting deduplication once comparison work is exhausted: retaining
  // redundant objects is safe, whereas merging unverified objects is not.
  const maxComparisons = 65_536;
  const maxComparedBytes = 64 * 1024 * 1024;
  let comparisons = 0, comparedBytes = 0;
  const dictBudget: DedupDictionaryBudget = { nodes: 0, chars: 0, exhausted: false };
  for (const [hash, keys] of byHash.entries()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => {
      const [ao] = a.split('_').map(Number);
      const [bo] = b.split('_').map(Number);
      return (ao ?? 0) - (bo ?? 0);
    });
    const buckets = new Map<string, Array<{ keeper: string; bytes: Uint8Array; duplicates: string[] }>>();
    for (const key of keys) {
      if (dictBudget.exhausted) break;
      const stream = objects.get(key);
      if (!(stream instanceof PDFStream)) continue;
      if (!canInspectDedupDictionary(stream.dict, dictBudget)) continue;
      let dict: string;
      try { dict = serializeToString(stream.dict); }
      catch { continue; } // Unverifiable streams must remain separate.
      const signature = `${stream.rawBytes.length}\u0000${dict}`;
      const candidates = buckets.get(signature) ?? [];
      let found: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (comparisons >= maxComparisons || stream.rawBytes.length > maxComparedBytes - comparedBytes) break;
        comparisons++;
        comparedBytes += stream.rawBytes.length;
        if (stream.rawBytes.every((byte, index) => byte === candidate.bytes[index])) { found = candidate; break; }
      }
      if (found) found.duplicates.push(key);
      else candidates.push({ keeper: key, bytes: stream.rawBytes, duplicates: [] });
      buckets.set(signature, candidates);
    }
    for (const candidates of buckets.values()) for (const { keeper, bytes, duplicates } of candidates) {
      if (!duplicates.length) continue;
      for (const duplicate of duplicates) refMap.set(duplicate, keeper);
      const bytesSaved = bytes.length * duplicates.length;
      totalBytesSaved += bytesSaved;
      groups.push({ hash, keeper, duplicates, bytesSaved });
    }
  }

  return { groups, refMap, totalBytesSaved };
}

/** Rewrite PDFRef targets using refMap (duplicate → keeper). */
export function applyRefMap(
  objects: Map<string, PDFObject>,
  refMap: Map<string, string>,
): Map<string, PDFObject> {
  if (refMap.size === 0) return objects;
  const memo = new Map<PDFObject, PDFObject>();

  function remap(root: PDFObject): PDFObject {
    type Task = { kind: 'visit'; value: PDFObject; assign: (value: PDFObject) => void } |
      { kind: 'leave'; value: PDFObject };
    let result: PDFObject = root;
    const pending: Task[] = [{ kind: 'visit', value: root, assign: value => { result = value; } }];
    const active = new Set<PDFObject>();
    let scheduled = 1;
    while (pending.length) {
      const task = pending.pop()!;
      if (task.kind === 'leave') { active.delete(task.value); continue; }
      const value = task.value;
      if (value instanceof PDFRef) {
        const mapped = refMap.get(refKey(value));
        if (mapped) {
          const [objNum, genNum] = mapped.split('_').map(Number);
          task.assign(new PDFRef(objNum!, genNum ?? 0));
        } else task.assign(value);
      } else if (value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream) {
        if (active.has(value)) throw new Error('Cannot remap a cyclic direct PDF object.');
        const previous = memo.get(value);
        if (previous) { task.assign(previous); continue; }
        active.add(value);
        pending.push({ kind: 'leave', value });
        if (value instanceof PDFArray) {
          if (value.length > MAX_OBJECT_WALK_WORK - scheduled) throw new Error('PDF object exceeds the reference remapping work limit.');
          scheduled += value.length;
          const target = new PDFArray();
          memo.set(value, target);
          task.assign(target);
          for (let i = value.length - 1; i >= 0; i--) {
            pending.push({ kind: 'visit', value: value.items[i], assign: item => { target.items[i] = item; } });
          }
        } else {
          const original = value instanceof PDFStream ? value.dict : value;
          const priorDict = value instanceof PDFStream ? memo.get(original) : undefined;
          if (priorDict && !(priorDict instanceof PDFDict)) throw new Error('Cannot remap a PDF stream dictionary.');
          if (value instanceof PDFStream && active.has(original)) throw new Error('Cannot remap a cyclic direct PDF object.');
          const target = priorDict instanceof PDFDict ? priorDict : new PDFDict();
          const result = value instanceof PDFStream ? new PDFStream(target, value.rawBytes, value.decodedBytes) : target;
          memo.set(value, result);
          task.assign(result);
          if (value instanceof PDFStream) {
            if (priorDict) continue;
            memo.set(original, target);
            active.add(original);
            pending.push({ kind: 'leave', value: original });
          }
          const entries = [...original.entries()];
          if (entries.length > MAX_OBJECT_WALK_WORK - scheduled) throw new Error('PDF object exceeds the reference remapping work limit.');
          scheduled += entries.length;
          for (let i = entries.length - 1; i >= 0; i--) {
            const [key, child] = entries[i];
            pending.push({ kind: 'visit', value: child, assign: item => { target.set(key, item); } });
          }
        }
      } else task.assign(value);
    }
    return result;
  }

  const out = new Map<string, PDFObject>();
  for (const [key, obj] of objects.entries()) {
    out.set(key, remap(obj));
  }
  return out;
}

// ─── Garbage collection ──────────────────────────────────────────────────────

/**
 * Remove unreachable indirect objects from the object map.
 * Optionally deduplicates streams first and remaps references.
 */
export function garbageCollect(
  objects: Map<string, PDFObject>,
  roots: PDFRef[],
  options: Partial<OptimizeOptions> = {},
): GarbageCollectResult {
  const opts = { ...DEFAULT_OPTIMIZE_OPTIONS, ...options };
  const beforeCount = objects.size;

  let working = new Map(objects);
  let refMap = new Map<string, string>();

  if (opts.deduplicateStreams) {
    const dedup = deduplicateStreams(working, opts.hashFn);
    refMap = dedup.refMap;
    if (refMap.size > 0) {
      working = applyRefMap(working, refMap);
    }
  }

  const allRoots = [...roots, ...opts.extraRoots];
  const graph = buildGraph(working, allRoots, true);
  const { unreachable } = computeReachability(graph);

  const removedKeys: string[] = [];
  for (const key of unreachable) {
    removedKeys.push(key);
    working.delete(key);
  }

  removedKeys.sort();

  return {
    beforeCount,
    afterCount: working.size,
    removedKeys,
    objects: working,
    refMap,
  };
}
