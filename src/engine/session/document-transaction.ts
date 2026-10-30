import { clonePDFObject } from '../editing/editor-history';
import { bindPageContentRefs, transferPageContentModifiedKeys } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

/** Reconcile the draft into existing objects, preserving stream identity and
 * the objects-map identity used by native edit/font provenance registries.
 */
export function publishDraft(doc: PDFDocumentData, staged: PDFDocumentData, clones: Map<object, PDFObject>): void {
  const originals = new Map<PDFObject, PDFObject>();
  for (const [original, clone] of clones) originals.set(clone, original as PDFObject);
  const published = new Map<PDFObject, PDFObject>();
  function adopt(object: PDFObject): PDFObject {
    const previous = published.get(object);
    if (previous) return previous;
    const target = originals.get(object) ?? object;
    published.set(object, target);
    if (object instanceof PDFDict && target instanceof PDFDict) {
      // Match the draft's insertion order as well as its values so the live
      // serialization matches the committed snapshot. New dictionaries adopt in place.
      if (target !== object) for (const key of target.keys()) target.delete(key);
      for (const [key, value] of object.entries()) target.set(key, adopt(value));
    } else if (object instanceof PDFArray && target instanceof PDFArray) {
      for (let index = 0; index < object.items.length; index++) target.items[index] = adopt(object.items[index]);
      target.items.length = object.items.length;
    } else if (object instanceof PDFStream && target instanceof PDFStream) {
      adopt(object.dict);
      target.rawBytes = object.rawBytes;
      target.decodedBytes = object.decodedBytes;
    }
    return target;
  }
  for (const key of doc.objects.keys()) if (!staged.objects.has(key)) doc.objects.delete(key);
  for (const [key, object] of staged.objects) doc.objects.set(key, adopt(object));
  const previousPages = new Map(doc.pages.map(page => [page.ref.toKey(), page]));
  const pages = staged.pages.map(draft => {
    const page = previousPages.get(draft.ref.toKey()) ?? { ...draft };
    page.index = draft.index;
    page.ref = draft.ref;
    page.dict = adopt(draft.dict) as PDFDict;
    page.resources = adopt(draft.resources) as PDFDict;
    page.mediaBox = { ...draft.mediaBox };
    page.cropBox = { ...draft.cropBox };
    page.rotate = draft.rotate;
    page.contentInspectionComplete = draft.contentInspectionComplete;
    page.contentRefs = [...draft.contentRefs];
    return bindPageContentRefs(page, doc);
  });
  doc.pages.splice(0, doc.pages.length, ...pages);
  doc.catalog = adopt(staged.catalog) as PDFDict;
  doc.xref.trailerDict = adopt(staged.xref.trailerDict) as PDFDict;
  if (!sameDocumentSnapshot([...doc.xref.entries], [...staged.xref.entries])) {
    doc.xref.entries.clear();
    for (const [key, entry] of staged.xref.entries) doc.xref.entries.set(key, { ...entry });
  }
  if (!sameDocumentSnapshot(doc.xref.provenance, staged.xref.provenance)) {
    doc.xref.provenance = staged.xref.provenance ? { ...staged.xref.provenance } : undefined;
  }
  transferPageContentModifiedKeys(staged.objects, doc.objects);
  // A staged cleanup must not lose the old-byte protection when published.
  if (staged.requiresFullRewrite) doc.requiresFullRewrite = true;
}

/** Make an isolated graph which can later be reconciled into the live document. */
export function createDocumentDraft(doc: PDFDocumentData): { staged: PDFDocumentData; seen: Map<object, PDFObject> } {
  const seen = new Map<object, PDFObject>();
  const objects = new Map<string, PDFObject>();
  for (const [key, object] of doc.objects) objects.set(key, clonePDFObject(object, seen));
  const staged: PDFDocumentData = {
    ...doc,
    rawBytes: new Uint8Array(doc.rawBytes),
    encryptionFileKey: doc.encryptionFileKey && new Uint8Array(doc.encryptionFileKey),
    objects,
    catalog: clonePDFObject(doc.catalog, seen) as PDFDict,
    pages: doc.pages.map(page => ({
      ...page,
      mediaBox: { ...page.mediaBox },
      cropBox: { ...page.cropBox },
      dict: clonePDFObject(page.dict, seen) as PDFDict,
      resources: clonePDFObject(page.resources, seen) as PDFDict,
      contentRefs: [...page.contentRefs],
    })),
    xref: { ...doc.xref, entries: new Map(Array.from(doc.xref.entries, ([key, entry]) => [key, { ...entry }])), trailerDict: clonePDFObject(doc.xref.trailerDict, seen) as PDFDict,
      ...(doc.xref.provenance ? { provenance: { ...doc.xref.provenance } } : {}) },
    info: { ...doc.info },
  };
  for (const page of staged.pages) bindPageContentRefs(page, staged);
  return { staged, seen };
}

/** Stage a document change and publish it only if the original stayed unchanged. */
export async function runDocumentTransaction<T>(
  doc: PDFDocumentData,
  apply: (staged: PDFDocumentData) => Promise<T>,
  isCurrent: () => boolean = () => true,
): Promise<T> {
  if (!isCurrent()) throw new Error('Document changed during the operation');
  const baseline = dehydrateDocument(doc);
  const { staged, seen } = createDocumentDraft(doc);
  const result = await apply(staged);
  if (!isCurrent() || !sameDocumentSnapshot(baseline, dehydrateDocument(doc))) {
    throw new Error('Document changed during the operation');
  }
  publishDraft(doc, staged, seen);
  doc.version = staged.version;
  doc.info = { ...staged.info };
  doc.rawBytes = new Uint8Array(staged.rawBytes);
  return result;
}
