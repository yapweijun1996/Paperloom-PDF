import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../../types';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';

function resolve(value: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key)) throw new Error('Cannot safely inspect a cyclic attachment reference.');
    seen.add(key);
    const next = objects.get(key);
    if (!next) throw new Error('Cannot safely inspect an unresolved attachment reference.');
    value = next;
  }
  return value;
}

/** Walk only the live graph, including page caches used by the editor. */
function liveObjects(doc: PDFDocumentData): Set<PDFObject> {
  const seen = new Set<PDFObject>();
  const refs = new Set<string>();
  const pending: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) pending.push(page.dict, page.resources, ...page.contentRefs);
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFRef) {
      if (refs.has(value.toKey())) continue;
      refs.add(value.toKey());
      const next = doc.objects.get(value.toKey());
      if (!next) throw new Error('Cannot safely inspect an unresolved document reference during attachment removal.');
      pending.push(next);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) pending.push(...value.values());
    else if (value instanceof PDFStream) pending.push(value.dict);
  }
  return seen;
}

/** Ensure no retained object would be left with a dangling reference. */
export function assertAttachmentGraphResolvable(doc: PDFDocumentData): void {
  liveObjects(doc);
}

/** A named removal must not leave the target's bytes reachable elsewhere. */
export function assertAttachmentStreamsDetached(doc: PDFDocumentData, streams: PDFStream[]): void {
  const surviving = liveObjects(doc);
  if (streams.some(stream => surviving.has(stream))) {
    throw new Error('The attachment is shared with retained document content; removal cannot be guaranteed.');
  }
}

/** A FileSpec may carry distinct F/UF/platform streams for the same attachment. */
export function expandAttachmentStreams(doc: PDFDocumentData, seeds: PDFStream[]): PDFStream[] {
  const groups: Array<{ streams: PDFStream[]; hasRelatedFiles: boolean }> = [];
  for (const value of liveObjects(doc)) {
    if (!(value instanceof PDFDict) || !value.has('EF')) continue;
    const ef = resolve(value.get('EF'), doc.objects);
    if (!(ef instanceof PDFDict)) throw new Error('Cannot safely inspect an embedded file specification.');
    const group: PDFStream[] = [];
    for (const entry of ef.values()) {
      const stream = resolve(entry, doc.objects);
      if (!(stream instanceof PDFStream)) throw new Error('Cannot safely inspect an embedded file stream.');
      group.push(stream);
    }
    groups.push({ streams: group, hasRelatedFiles: value.has('RF') });
  }
  const result = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.streams.some(stream => result.has(stream))) continue;
      if (group.hasRelatedFiles) throw new Error('Cannot safely remove related files in an attachment specification.');
      for (const stream of group.streams) {
        if (!result.has(stream)) { result.add(stream); changed = true; }
      }
    }
  }
  return [...result];
}

/** Return file specifications from standard associated-file arrays. */
export function associatedFileSpecs(doc: PDFDocumentData): PDFDict[] {
  const result = new Set<PDFDict>();
  for (const value of liveObjects(doc)) {
    if (!(value instanceof PDFDict) || !value.has('AF')) continue;
    const array = resolve(value.get('AF'), doc.objects);
    if (!(array instanceof PDFArray)) throw new Error('Cannot safely inspect associated files.');
    for (const item of array.items) {
      const spec = resolve(item, doc.objects);
      if (!(spec instanceof PDFDict)) throw new Error('Cannot safely inspect an associated file specification.');
      result.add(spec);
    }
  }
  return [...result];
}

/** Unlink selected specs from every reachable standard /AF association. */
export function detachAssociatedFileSpecs(doc: PDFDocumentData, targets: Set<PDFDict>): boolean {
  let changed = false;
  for (const value of liveObjects(doc)) {
    if (!(value instanceof PDFDict) || !value.has('AF')) continue;
    const array = resolve(value.get('AF'), doc.objects);
    if (!(array instanceof PDFArray)) throw new Error('Cannot safely inspect associated files.');
    const retained = array.items.filter(item => {
      const spec = resolve(item, doc.objects);
      if (!(spec instanceof PDFDict)) throw new Error('Cannot safely inspect an associated file specification.');
      return !targets.has(spec);
    });
    if (retained.length === array.length) continue;
    if (retained.length) value.set('AF', new PDFArray(retained));
    else value.delete('AF');
    changed = true;
  }
  return changed;
}

/** Name-tree corruption must not be reported as successful attachment removal. */
function validateEmbeddedTree(tree: PDFObject, doc: PDFDocumentData): void {
  const visited = new Set<PDFDict>();
  const active = new Set<PDFDict>();
  const visit = (value: PDFObject): void => {
    const node = resolve(value, doc.objects);
    if (!(node instanceof PDFDict)) throw new Error('Cannot safely inspect the embedded-file name tree.');
    if (active.has(node)) throw new Error('Cannot safely inspect a cyclic embedded-file name tree.');
    if (visited.has(node)) return;
    active.add(node);
    const namesValue = node.get('Names');
    const names = resolve(namesValue, doc.objects);
    if (namesValue && (!(names instanceof PDFArray) || names.length % 2 !== 0)) {
      throw new Error('Cannot safely inspect embedded-file names.');
    }
    if (names instanceof PDFArray) for (let index = 1; index < names.length; index += 2) {
      const spec = resolve(names.get(index), doc.objects);
      if (!(spec instanceof PDFDict)) {
        throw new Error('Cannot safely inspect an embedded file specification.');
      }
      if (spec.has('RF')) throw new Error('Cannot safely remove related files in an attachment specification.');
    }
    const kidsValue = node.get('Kids');
    const kids = resolve(kidsValue, doc.objects);
    if (kidsValue && !(kids instanceof PDFArray)) throw new Error('Cannot safely inspect embedded-file name tree children.');
    if (kids instanceof PDFArray) for (const kid of kids.items) visit(kid);
    active.delete(node);
    visited.add(node);
  };
  visit(tree);
}

/** Apply only to a private graph during preflight; caller retries on the live graph. */
function detachAttachments(doc: PDFDocumentData): { count: number; changed: boolean } {
  const live = liveObjects(doc);
  const associated = new Set(associatedFileSpecs(doc));
  const embedded = new Set<PDFStream>();
  const specs = new Set<PDFDict>();
  const associations: PDFDict[] = [];
  let fileAnnotations = 0;

  for (const value of live) {
    if (value instanceof PDFStream && value.dict.getName('Type') === 'EmbeddedFile') embedded.add(value);
    if (!(value instanceof PDFDict)) continue;
    if (value.has('RF') && (value.has('EF') || associated.has(value) || value.getName('Type') === 'Filespec')) {
      throw new Error('Cannot safely remove related files in an attachment specification.');
    }
    if (value.has('AF')) associations.push(value);
    if (!value.has('EF')) continue;
    const ef = resolve(value.get('EF'), doc.objects);
    if (!(ef instanceof PDFDict)) throw new Error('Cannot safely inspect an embedded file specification.');
    specs.add(value);
    for (const entry of ef.values()) {
      const stream = resolve(entry, doc.objects);
      if (!(stream instanceof PDFStream)) throw new Error('Cannot safely inspect an embedded file stream.');
      embedded.add(stream);
    }
  }

  const namesValue = doc.catalog.get('Names');
  const names = namesValue ? resolve(namesValue, doc.objects) : undefined;
  if (namesValue && !(names instanceof PDFDict)) throw new Error('Cannot safely inspect document attachment names.');
  const embeddedTree = names instanceof PDFDict && names.has('EmbeddedFiles')
    ? resolve(names.get('EmbeddedFiles'), doc.objects) : undefined;
  if (embeddedTree) validateEmbeddedTree(embeddedTree, doc);
  let changed = false;
  if (names instanceof PDFDict && names.has('EmbeddedFiles')) {
    const keptNames = new PDFDict([...names.entries()]);
    keptNames.delete('EmbeddedFiles');
    if (keptNames.size) doc.catalog.set('Names', keptNames);
    else doc.catalog.delete('Names');
    changed = true;
  }
  for (const dict of associations) { dict.delete('AF'); changed = true; }
  for (const page of doc.pages) {
    const entry = page.dict.get('Annots');
    if (!entry) continue;
    const array = resolve(entry, doc.objects);
    if (!(array instanceof PDFArray)) throw new Error('Cannot safely inspect page attachments.');
    const kept: PDFObject[] = [];
    for (const item of array.items) {
      const annot = resolve(item, doc.objects);
      if (!(annot instanceof PDFDict) || !annot.getName('Subtype')) throw new Error('Cannot safely inspect a page annotation.');
      if (annot.getName('Subtype') === 'FileAttachment' && annot.has('FS') &&
          !(resolve(annot.get('FS'), doc.objects) instanceof PDFDict)) {
        throw new Error('Cannot safely inspect an attachment annotation.');
      }
      const spec = annot.getName('Subtype') === 'FileAttachment' ? resolve(annot.get('FS'), doc.objects) : undefined;
      if (spec instanceof PDFDict && spec.has('RF')) throw new Error('Cannot safely remove related files in an attachment specification.');
      if (annot.getName('Subtype') === 'FileAttachment') { fileAnnotations++; continue; }
      kept.push(item);
    }
    if (kept.length !== array.length) {
      if (kept.length) page.dict.set('Annots', new PDFArray(kept));
      else page.dict.delete('Annots');
      changed = true;
    }
  }

  const surviving = liveObjects(doc);
  if (embeddedTree && surviving.has(embeddedTree)) {
    throw new Error('The embedded file directory is shared with retained document content; attachment removal cannot be guaranteed.');
  }
  if ([...specs].some(spec => surviving.has(spec))) {
    throw new Error('An embedded file specification is shared with retained document content; attachment removal cannot be guaranteed.');
  }
  if ([...embedded].some(stream => surviving.has(stream))) {
    throw new Error('Embedded file data is shared with retained document content; attachment removal cannot be guaranteed.');
  }
  // Remove detached streams from the in-memory graph too. Unrelated shared
  // streams have already been rejected instead of being deleted.
  for (const [key, value] of doc.objects) {
    if ((value instanceof PDFStream && embedded.has(value)) || (value instanceof PDFDict && specs.has(value))) {
      doc.objects.delete(key);
    }
  }
  if (changed) doc.requiresFullRewrite = true;
  return { count: specs.size || fileAnnotations || (changed ? 1 : 0), changed };
}

/** Reject before mutation if removing attachment data would affect retained content. */
export function assertAllAttachmentsRemovable(doc: PDFDocumentData): void {
  // The original byte prefix is not needed to inspect live attachment links.
  const draft = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
  detachAttachments(draft);
}

export function removeAllAttachmentsSafely(doc: PDFDocumentData): number {
  const draft = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
  const result = detachAttachments(draft);
  if (!result.changed) return result.count;
  if (hasDocumentSignature(doc)) throw new SignedDocumentEditError();
  return detachAttachments(doc).count;
}
