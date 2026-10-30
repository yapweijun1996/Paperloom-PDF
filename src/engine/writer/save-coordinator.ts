import type { PDFDocumentData, PDFObject } from '../types';
import { applySavedMetadataPatch, type SavedMetadataPatch } from './save-metadata';
import { pageContentModifiedKeys } from '../editor/stream-compiler';
import { registeredFontKeys } from '../fonts/font-augmentation';
import { unicodeFontModifiedKeys } from '../fonts/unicode-font-embed';
import { dehydrateDocument, sameDocumentSnapshot, type WireDocument } from '../worker/codec';
import { assertNewObjectsDoNotCollide, assertUniqueIncrementalObjectNumbers, withVerifiedDocumentXref } from './new-object-safety';
import { buildFullXref } from '../parser/xref';
import { bindXrefProvenanceWithRawDigest, trailerWithXrefRevision } from '../parser/xref-provenance';

export interface QuickSaveRequest {
  document: WireDocument;
  modifiedKeys?: Set<string>;
  newObjectKeys?: string[];
}
export interface QuickSaveOutput { bytes: Uint8Array; rawBytesAdvanced: boolean; metadata?: SavedMetadataPatch }
const queues = new WeakMap<PDFDocumentData, Promise<void>>();

/** One document's quick saves share a queue across worker and direct callers. */
export function coordinateQuickSave(
  doc: PDFDocumentData,
  modifiedKeys: Set<string> | undefined,
  newObjects: Map<string, PDFObject> | undefined,
  operation: (request: QuickSaveRequest) => Promise<QuickSaveOutput>,
): Promise<Uint8Array> {
  const keys = modifiedKeys ? new Set(modifiedKeys) : undefined;
  const added = newObjects ? new Map(newObjects) : undefined;
  const run = () => quickSaveOnce(doc, keys, added, operation);
  const previous = queues.get(doc);
  const current = previous ? previous.then(run) : run();
  const tail = current.then(() => undefined, () => undefined);
  queues.set(doc, tail);
  void tail.then(() => { if (queues.get(doc) === tail) queues.delete(doc); });
  return current;
}

async function quickSaveOnce(
  doc: PDFDocumentData,
  modifiedKeys: Set<string> | undefined,
  newObjects: Map<string, PDFObject> | undefined,
  operation: (request: QuickSaveRequest) => Promise<QuickSaveOutput>,
): Promise<Uint8Array> {
  // A queued save must check the graph at execution time: an earlier save
  // may have allocated the same object number while this request was waiting.
  const objectsBeforeValidation = doc.objects;
  const identitiesBeforeValidation = newObjects && new Map([...newObjects.keys()].map(key => [key, doc.objects.get(key)]));
  const combined = () => {
    const objects = new Map(doc.objects);
    if (newObjects) for (const [key, value] of newObjects) objects.set(key, value);
    return objects;
  };
  // Structural snapshots cannot detect replacement with a distinct but
  // identically valued live object. Do not overwrite such a concurrent edit
  // when publishing a new-object request that aliases a live object.
  const prepare = (verified: boolean) => {
    if (doc.objects !== objectsBeforeValidation || (identitiesBeforeValidation &&
        [...identitiesBeforeValidation].some(([key, object]) => doc.objects.get(key) !== object))) {
      throw new Error('Document changed during save; the earlier save was not applied.');
    }
    const checked = assertNewObjectsDoNotCollide(doc, newObjects, verified);
    if (modifiedKeys?.size || newObjects?.size) {
      modifiedKeys = new Set([...modifiedKeys ?? [], ...unicodeFontModifiedKeys(doc.objects),
        ...registeredFontKeys(doc.objects), ...pageContentModifiedKeys(doc.objects)]);
      assertUniqueIncrementalObjectNumbers(doc, modifiedKeys, newObjects, checked || verified);
    }
    const originalObjects = new Map<string, { present: boolean; value: PDFObject | undefined }>();
    if (newObjects) for (const key of newObjects.keys()) {
      originalObjects.set(key, { present: doc.objects.has(key), value: doc.objects.get(key) });
    }
    // A combined snapshot is only distinct when an added entry changes the
    // object map. The worker wire still owns its own independent buffers.
    let hasAdditionalObjects = false;
    if (newObjects) for (const [key, value] of newObjects) {
      if (!doc.objects.has(key) || doc.objects.get(key) !== value) {
        hasAdditionalObjects = true;
        break;
      }
    }
    return { originalMap: doc.objects, originalObjects, originalRaw: doc.rawBytes,
      originalXref: doc.xref, originalEntries: doc.xref.entries, originalTrailer: doc.xref.trailerDict,
      originalEntryValues: new Map(doc.xref.entries), originalProof: doc.xref.provenance,
      baseline: dehydrateDocument(doc, { includeDecodedBytes: false }),
      snapshot: hasAdditionalObjects ? dehydrateDocument({ ...doc, objects: combined() }, { includeDecodedBytes: false }) : undefined,
      wire: dehydrateDocument({ ...doc, objects: combined() }) };
  };
  const prepared = (modifiedKeys?.size || newObjects?.size)
    ? await withVerifiedDocumentXref(doc, prepare) : prepare(false);
  const output = await operation({ document: prepared.wire, modifiedKeys,
    newObjectKeys: newObjects ? Array.from(newObjects.keys()) : undefined });
  // Detach output held by a worker or callback before awaiting xref parsing.
  const result = { ...output, bytes: output.rawBytesAdvanced ? new Uint8Array(output.bytes) : output.bytes };
  // Worker and direct writers operate on a detached graph. Rebuild the
  // authoritative xref for an advanced incremental revision before publishing.
  const nextXref = result.rawBytesAdvanced ? await buildFullXref(result.bytes) : undefined;
  const nextProof = nextXref ? { ...doc.xref, entries: nextXref.entries,
    trailerDict: trailerWithXrefRevision(doc.xref.trailerDict, nextXref.trailerDict), provenance: undefined } : undefined;
  if (nextProof && nextXref?.provenance?.rawDigest) {
    bindXrefProvenanceWithRawDigest(nextProof, nextXref.provenance.source, nextXref.provenance.rawDigest);
  }
  if (doc.objects !== prepared.originalMap || doc.rawBytes !== prepared.originalRaw || doc.xref !== prepared.originalXref ||
      doc.xref.entries !== prepared.originalEntries || doc.xref.trailerDict !== prepared.originalTrailer ||
      doc.xref.provenance !== prepared.originalProof || doc.xref.entries.size !== prepared.originalEntryValues.size ||
      [...prepared.originalEntryValues].some(([key, entry]) => doc.xref.entries.get(key) !== entry) ||
      [...prepared.originalObjects].some(([key, original]) => doc.objects.has(key) !== original.present ||
      doc.objects.get(key) !== original.value) ||
      !sameDocumentSnapshot(prepared.baseline, dehydrateDocument(doc, { includeDecodedBytes: false })) ||
      (prepared.snapshot && !sameDocumentSnapshot(prepared.snapshot,
        dehydrateDocument({ ...doc, objects: combined() }, { includeDecodedBytes: false })))) {
    throw new Error('Document changed during save; the earlier save was not applied.');
  }
  if (newObjects) for (const [key, value] of newObjects) doc.objects.set(key, value);
  if (result.metadata) applySavedMetadataPatch(doc, result.metadata);
  if (result.rawBytesAdvanced && nextXref) {
    doc.xref.entries = nextXref.entries;
    if (nextProof) doc.xref.trailerDict = nextProof.trailerDict;
    doc.xref.provenance = nextProof?.provenance;
    doc.rawBytes = result.bytes;
  }
  return result.bytes;
}

/** Optimized saves do not publish their staging graph to the live document. */
export async function coordinateOptimizedSave(
  doc: PDFDocumentData,
  operation: (wire: WireDocument) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const baseline = dehydrateDocument(doc, { includeDecodedBytes: false });
  const bytes = await operation(dehydrateDocument(doc));
  if (!sameDocumentSnapshot(baseline, dehydrateDocument(doc, { includeDecodedBytes: false }))) {
    throw new Error('Document changed during save; the earlier save was not applied.');
  }
  return bytes;
}
