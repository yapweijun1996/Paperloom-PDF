import {
  PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber,
  PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject,
} from '@/engine/types';
import { sameDocumentSnapshot } from '@/engine/worker/codec';

type WidgetAppearance = { identity: string | PDFDict; appearance: unknown; state: unknown };
export type FormThumbnailSnapshot = ReadonlyArray<{ pageKey: string; widgets: readonly WidgetAppearance[] }>;

// Bound total work across every widget in one capture. An unsafe snapshot makes
// the caller rebuild all thumbnails; it must never compromise the form edit.
const MAX_SNAPSHOT_NODES = 50_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 128;

class SnapshotBudget {
  private nodes = 0;
  private bytes = 0;

  node(depth = 0): void {
    if (depth > MAX_SNAPSHOT_DEPTH || ++this.nodes > MAX_SNAPSHOT_NODES) throw new Error('Form thumbnail snapshot too complex');
  }
  children(count: number): void {
    if (count > MAX_SNAPSHOT_NODES - this.nodes) throw new Error('Form thumbnail snapshot too complex');
  }
  data(bytes: number): void {
    if (bytes > MAX_SNAPSHOT_BYTES - this.bytes) throw new Error('Form thumbnail snapshot too large');
    this.bytes += bytes;
  }
  string(value: string): void { this.data(value.length * 2); }
}

/** Resolve annotation references under the same limits as appearance traversal. */
function resolveSnapshotRef(object: PDFObject, objects: Map<string, PDFObject>, budget: SnapshotBudget): PDFObject {
  const refs = new Set<string>();
  let current = object;
  let depth = 0;
  while (current instanceof PDFRef) {
    budget.node(depth++);
    const key = current.toKey();
    budget.string(key);
    if (refs.has(key)) throw new Error('Cyclic form thumbnail reference');
    refs.add(key);
    current = objects.get(key) ?? PDFNull.instance;
  }
  budget.node(depth);
  return current;
}

/** Copy the appearance graph: transactions can mutate existing indirect objects in place. */
function snapshotAppearance(value: PDFObject | undefined, objects: Map<string, PDFObject>, budget: SnapshotBudget): unknown {
  const visited = new Map<object, number>();
  const refs = new Set<string>();
  const visit = (object: PDFObject | undefined, depth = 0): unknown => {
    budget.node(depth);
    if (!object) return ['missing'];
    if (object instanceof PDFRef) {
      const key = object.toKey();
      budget.string(key);
      if (refs.has(key)) return ['ref-cycle', key];
      refs.add(key);
      const result = ['ref', key, visit(objects.get(key), depth + 1)];
      refs.delete(key);
      return result;
    }
    if (object instanceof PDFName) { budget.string(object.name); return ['name', object.name]; }
    if (object instanceof PDFString) { budget.string(object.value); return ['string', object.value]; }
    if (object instanceof PDFHexString) { budget.string(object.hex); return ['hex', object.hex]; }
    if (object instanceof PDFNumber) return ['number', object.value];
    if (object instanceof PDFBoolean) return ['boolean', object.value];
    if (object instanceof PDFNull) return ['null'];
    const previous = visited.get(object);
    if (previous !== undefined) return ['seen', previous];
    visited.set(object, visited.size);
    if (object instanceof PDFArray) {
      budget.children(object.items.length);
      return ['array', object.items.map(item => visit(item, depth + 1))];
    }
    if (object instanceof PDFDict) {
      budget.children(object.size);
      return ['dict', Array.from(object.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => {
        budget.string(key);
        return [key, visit(item, depth + 1)];
      })];
    }
    if (object instanceof PDFStream) {
      // Charge both buffers before copying either one.
      budget.data(object.rawBytes.byteLength + (object.decodedBytes?.byteLength ?? 0));
      return ['stream', visit(object.dict, depth + 1), object.rawBytes.slice(), object.decodedBytes?.slice() ?? null];
    }
    throw new Error('Invalid appearance object');
  };
  return visit(value);
}

/** Capture values used to render each widget, including indirect appearance objects. */
export function captureFormThumbnailSnapshot(doc: PDFDocumentData): FormThumbnailSnapshot {
  const budget = new SnapshotBudget();
  budget.children(doc.pages.length);
  return doc.pages.map(page => {
    budget.node();
    const entry = page.dict.get('Annots');
    const annots = entry ? resolveSnapshotRef(entry, doc.objects, budget) : undefined;
    if (annots !== undefined && !(annots instanceof PDFArray)) throw new Error('Invalid page annotations');
    const widgets: WidgetAppearance[] = [];
    budget.children(annots?.items.length ?? 0);
    for (const item of annots?.items ?? []) {
      budget.node();
      const annot = item instanceof PDFRef ? resolveSnapshotRef(item, doc.objects, budget) : item;
      if (annot instanceof PDFDict && annot.getName('Subtype') === 'Widget') {
        widgets.push({
          identity: item instanceof PDFRef ? item.toKey() : annot,
          appearance: snapshotAppearance(annot.get('AP'), doc.objects, budget),
          state: snapshotAppearance(annot.get('AS'), doc.objects, budget),
        });
      }
    }
    return { pageKey: page.ref.toKey(), widgets };
  });
}

/** Return changed page indices, or null if structural changes require a rebuild. */
export function changedFormThumbnailPages(before: FormThumbnailSnapshot, after: FormThumbnailSnapshot): number[] | null {
  if (before.length !== after.length || before.some((page, index) => page.pageKey !== after[index].pageKey)) return null;
  const changed: number[] = [];
  for (let index = 0; index < before.length; index++) {
    const left = before[index].widgets, right = after[index].widgets;
    if (left.length !== right.length || left.some((widget, position) => {
      const next = right[position];
      return widget.identity !== next.identity || !sameDocumentSnapshot(widget.appearance, next.appearance) || !sameDocumentSnapshot(widget.state, next.state);
    })) changed.push(index);
  }
  return changed;
}
