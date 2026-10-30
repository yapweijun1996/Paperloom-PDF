import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../../types';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';
import { collectMetadataObjectGraph } from '../metadata/metadata-object-graph';

interface ComponentMetadata {
  owner: PDFDict;
  ref: PDFRef;
  stream: PDFStream;
}

/** Plan only verifiable indirect XMP streams. A second graph traversal excludes
 * metadata edges so shared content cannot be removed or silently retained. */
function planComponentMetadata(doc: PDFDocumentData): ComponentMetadata[] {
  const roots: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) roots.push(page.dict, page.resources, ...page.contentRefs);
  const pending = [...roots];
  const visited = new Set<PDFObject>();
  const entries: ComponentMetadata[] = [];
  const fail = (): never => {
    throw new Error('Cannot safely remove component metadata: shared metadata or unsupported document structure; no changes were made.');
  };
  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (visited.size > 100_000) fail();
    if (value instanceof PDFRef) {
      const target = doc.objects.get(value.toKey());
      if (!target) return fail();
      pending.push(target);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (key === 'Metadata' && value !== doc.catalog) {
          if (!(child instanceof PDFRef)) return fail();
          const stream = doc.objects.get(child.toKey());
          if (!(stream instanceof PDFStream) || stream.dict.getName('Type') !== 'Metadata' ||
              stream.dict.getName('Subtype') !== 'XML') return fail();
          entries.push({ owner: value, ref: child, stream });
        }
        pending.push(child);
      }
    }
  }
  const targets = new Set(entries.map(entry => entry.stream));
  // The catalog XMP is removed by metadataEngine immediately after component
  // metadata; its descendants need the same shared-data check.
  const catalogMetadata = doc.catalog.get('Metadata');
  const catalogStream = catalogMetadata instanceof PDFRef
    ? doc.objects.get(catalogMetadata.toKey()) : catalogMetadata;
  if (catalogStream instanceof PDFStream) targets.add(catalogStream);
  if (targets.size && hasDocumentSignature(doc)) throw new SignedDocumentEditError();
  const sensitive = collectMetadataObjectGraph(targets, doc.objects, fail);
  const retained = [...roots];
  visited.clear();
  while (retained.length) {
    const value = retained.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (visited.size > 100_000 || sensitive.values.has(value) ||
        (value instanceof PDFRef && sensitive.refs.has(value.toKey()))) fail();
    if (value instanceof PDFStream) {
      // A metadata stream reachable outside a supported /Metadata edge would
      // remain in the output even after all supported entries are removed.
      let type = value.dict.get('Type');
      const seenRefs = new Set<string>();
      while (type instanceof PDFRef) {
        const key = type.toKey();
        if (seenRefs.has(key) || seenRefs.size >= 128) return fail();
        seenRefs.add(key);
        type = doc.objects.get(key);
        if (!type) return fail();
      }
      if (type instanceof PDFName && type.name === 'Metadata') fail();
    }
    if (value instanceof PDFRef) {
      const target = doc.objects.get(value.toKey());
      if (!target) return fail();
      retained.push(target);
    } else if (value instanceof PDFArray) retained.push(...value.items);
    else if (value instanceof PDFStream) retained.push(value.dict);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (key !== 'Metadata') retained.push(child);
      }
    }
  }
  return entries;
}

export function assertComponentMetadataRemovable(doc: PDFDocumentData): void {
  planComponentMetadata(doc);
}

export function removeComponentMetadata(doc: PDFDocumentData): number {
  const entries = planComponentMetadata(doc);
  const catalogRef = doc.catalog.getRef('Metadata');
  for (const { owner } of entries) owner.delete('Metadata');
  for (const { ref } of entries) {
    if (ref.toKey() !== catalogRef?.toKey()) doc.objects.delete(ref.toKey());
  }
  return entries.length;
}
