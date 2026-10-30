import { PDFArray, PDFDict, PDFRef, type PDFDocumentData, type PDFObject } from '../types';

/** Ensure a redaction cannot overlook a marked page absent from the page cache. */
export function assertCompletePageTree(doc: PDFDocumentData, refuse: (reason: string) => never): void {
  const resolve = (value: PDFObject | undefined): PDFObject | undefined => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key) || seen.size >= 128) refuse('the page tree contains a cyclic or excessively deep reference');
      seen.add(key);
      value = doc.objects.get(key);
    }
    return value;
  };
  const rootRef = doc.catalog.get('Pages');
  if (!(rootRef instanceof PDFRef)) refuse('the page tree root is invalid');
  const pending: Array<{ ref: PDFRef; parent: PDFDict | null; depth: number }> = [{ ref: rootRef, parent: null, depth: 0 }];
  const seen = new Set<PDFDict>();
  let leafIndex = 0;
  while (pending.length) {
    if (seen.size >= 50_000) refuse('the page tree exceeds the inspection limit');
    const { ref, parent, depth } = pending.pop()!;
    if (depth > 128) refuse('the page tree exceeds the inspection depth');
    const node = resolve(ref);
    if (!(node instanceof PDFDict)) refuse('a page tree node cannot be resolved');
    if (seen.has(node)) refuse('the page tree contains a duplicate or cycle');
    seen.add(node);
    if (parent && resolve(node.get('Parent')) !== parent) refuse('a page tree parent is invalid');
    const type = node.getName('Type');
    if (type === 'Page' && parent) {
      const page = doc.pages[leafIndex++];
      if (!page || page.ref.toKey() !== ref.toKey() || page.dict !== node || doc.objects.get(ref.toKey()) !== node) {
        refuse('the cached pages do not match the page tree');
      }
    } else if (type === 'Pages') {
      const kids = resolve(node.get('Kids'));
      if (!(kids instanceof PDFArray) || kids.length + pending.length + seen.size > 50_000) refuse('the page tree children cannot be inspected');
      for (let i = kids.length - 1; i >= 0; i--) {
        const child = kids.items[i];
        if (!(child instanceof PDFRef)) refuse('a page tree child is not an indirect reference');
        pending.push({ ref: child, parent: node, depth: depth + 1 });
      }
    } else refuse('a page tree node has an invalid type');
  }
  if (leafIndex !== doc.pages.length) refuse('the cached pages do not match the page tree');
}
