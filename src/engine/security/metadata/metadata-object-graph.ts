import { PDFArray, PDFDict, PDFNull, PDFRef, PDFStream, type PDFObject } from '../../types';

/** All objects reachable through metadata, including indirect object aliases. */
export function collectMetadataObjectGraph(
  roots: Iterable<PDFObject>,
  objects: Map<string, PDFObject>,
  fail: () => never,
): { values: Set<PDFObject>; refs: Set<string> } {
  const values = new Set<PDFObject>();
  const refs = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const value = pending.pop()!;
    // PDFNull is a process-wide singleton and cannot contain private data.
    if (value instanceof PDFNull || values.has(value)) continue;
    values.add(value);
    if (values.size > 100_000) fail();
    if (value instanceof PDFRef) {
      const key = value.toKey();
      refs.add(key);
      const target = objects.get(key);
      if (!target) return fail();
      pending.push(target);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFDict) pending.push(...value.values());
  }
  return { values, refs };
}
