import { PDFArray, PDFNull, PDFRef, PDFStream, type PDFObject } from '../types';

/** Resolve page Contents to the indirect streams that actually hold its bytes. */
export function inspectContentRefs(contents: PDFObject | undefined, objects: Map<string, PDFObject>): PDFRef[] {
  let work = 0;
  const dereference = (ref: PDFRef): { value: PDFObject; ref: PDFRef } => {
    const seen = new Set<string>();
    let current = ref;
    while (true) {
      const key = current.toKey();
      if (seen.has(key) || seen.size >= 128 || ++work > 500_000) throw new Error('Cannot inspect cyclic or excessively deep page content references.');
      seen.add(key);
      const value = objects.get(key);
      if (!value) throw new Error('Cannot inspect an unresolved page content reference.');
      if (!(value instanceof PDFRef)) return { value, ref: current };
      current = value;
    }
  };
  if (!contents || contents instanceof PDFNull) return [];
  const root = contents instanceof PDFRef ? dereference(contents) : { value: contents };
  if (root.value instanceof PDFNull) return [];
  if (root.value instanceof PDFStream && 'ref' in root) return [root.ref];
  if (!(root.value instanceof PDFArray) || root.value.length > 100_000) {
    throw new Error('Cannot inspect the page Contents structure.');
  }
  return root.value.items.map(item => {
    if (!(item instanceof PDFRef)) throw new Error('Cannot inspect a direct or invalid page content stream.');
    const resolved = dereference(item);
    if (!(resolved.value instanceof PDFStream)) throw new Error('Cannot inspect a page content stream.');
    return resolved.ref;
  });
}
