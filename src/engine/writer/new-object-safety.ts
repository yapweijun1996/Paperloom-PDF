import type { PDFDocumentData, PDFObject } from '../types';
import { assertXrefProvenance, withAssertedXrefProvenance } from '../parser/xref-provenance';

const activeValidations = new WeakMap<object, PDFDocumentData>();

/** Only the currently executing verified callback owns this capability. */
export function assertActiveXrefValidation(doc: PDFDocumentData, token: object): void {
  if (activeValidations.get(token) !== doc) throw new Error('Incremental xref validation is no longer active.');
}

/** Async verification is reusable only in the immediately following synchronous stack. */
export async function withVerifiedDocumentXref<T>(doc: PDFDocumentData, action: (verified: boolean, token: object) => T): Promise<T> {
  const raw = doc.rawBytes, xref = doc.xref, entries = xref.entries, trailer = xref.trailerDict, proof = xref.provenance;
  const entryIdentities = new Map(entries);
  return withAssertedXrefProvenance(raw, xref, checked => {
    if (doc.rawBytes !== raw || doc.xref !== xref || xref.entries !== entries || xref.trailerDict !== trailer || xref.provenance !== proof ||
        entries.size !== entryIdentities.size || [...entryIdentities].some(([key, value]) => entries.get(key) !== value)) {
      throw new Error('Document changed during cross-reference validation.');
    }
    const token = {};
    activeValidations.set(token, doc);
    try { return action(checked, token); }
    finally { activeValidations.delete(token); }
  });
}

/** New objects must not replace live or in-use objects, including other generations. */
export function assertNewObjectsDoNotCollide(doc: PDFDocumentData, newObjects?: Map<string, PDFObject>, alreadyVerified = false): boolean {
  if (!newObjects?.size) return false;
  if (!alreadyVerified) assertXrefProvenance(doc.rawBytes, doc.xref);
  if (doc.xref.provenance?.source === 'conservative' || (!doc.xref.provenance && doc.rawBytes.length > 0)) {
    for (const [key, value] of newObjects) {
      if (doc.xref.entries.get(key)?.type !== 'n' || !doc.objects.has(key) || doc.objects.get(key) !== value) {
        throw new Error('PDF object conflicts with an incomplete xref.');
      }
    }
  }
  const occupied = new Map<number, Set<string>>();
  const free = new Map<number, Set<number>>();
  const remember = (number: number, key: string) => {
    let keys = occupied.get(number);
    if (!keys) occupied.set(number, keys = new Set());
    keys.add(key);
  };
  for (const key of doc.objects.keys()) {
    const match = /^(\d+)_(\d+)$/.exec(key);
    if (match) remember(Number(match[1]), key);
  }
  for (const [key, entry] of doc.xref.entries) {
    // A recovered xref may be in scan order rather than revision order. Keep
    // every generation so ambiguity cannot make an older object overwrite a
    // newer live object.
    if (entry.type === 'n') remember(entry.objNum, key);
    else {
      let generations = free.get(entry.objNum);
      if (!generations) free.set(entry.objNum, generations = new Set());
      generations.add(entry.genNum);
    }
  }
  for (const [key, value] of newObjects) {
    const match = /^(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(key);
    const number = match ? Number(match[1]) : NaN;
    const generation = match ? Number(match[2]) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647 ||
        !Number.isSafeInteger(generation) || generation > 65_535) {
      throw new Error('Cannot save an invalid new PDF object reference.');
    }
    const existing = occupied.get(number);
    const freeGenerations = free.get(number);
    if ((existing && ([...existing].some(existingKey => existingKey !== key) ||
        !doc.objects.has(key) || doc.objects.get(key) !== value)) ||
        (doc.objects.has(key) && doc.objects.get(key) !== value) ||
        (freeGenerations && (freeGenerations.size !== 1 || !freeGenerations.has(generation) || generation === 65_535))) {
      throw new Error('Cannot save a new PDF object that conflicts with an existing object.');
    }
    remember(number, key);
  }
  return !!doc.xref.provenance;
}

/** A single xref revision cannot contain two generations of one object number. */
export function assertUniqueIncrementalObjectNumbers(
  doc: PDFDocumentData, modifiedKeys: Iterable<string>, newObjects?: Map<string, PDFObject>, alreadyVerified = false,
): boolean {
  const proof = doc.xref.provenance;
  if (proof && !alreadyVerified) assertXrefProvenance(doc.rawBytes, doc.xref);
  const numbers = new Map<number, string>();
  const conservative = proof?.source === 'conservative' || (!proof && doc.rawBytes.length > 0);
  const xrefByNumber = new Map<number, Array<{ key: string; type: 'n' | 'f'; genNum: number }>>();
  if (proof || conservative) for (const [key, entry] of doc.xref.entries) {
    let entries = xrefByNumber.get(entry.objNum);
    if (!entries) xrefByNumber.set(entry.objNum, entries = []);
    entries.push({ key, type: entry.type, genNum: entry.genNum });
  }
  const remember = (key: string) => {
    const match = /^(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(key);
    const number = match ? Number(match[1]) : NaN;
    const generation = match ? Number(match[2]) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647 ||
        !Number.isSafeInteger(generation) || generation > 65_535) {
      throw new Error('Cannot save an invalid PDF object reference.');
    }
    const previous = numbers.get(number);
    if (previous !== undefined && previous !== key) {
      throw new Error('Cannot save conflicting generations of a PDF object in one revision.');
    }
    if (proof || conservative) {
      const entries = xrefByNumber.get(number) ?? [];
      if ((conservative && (entries.length !== 1 || entries[0].type !== 'n' || entries[0].key !== key)) ||
          (proof?.source === 'strict' && (entries.length > 1 || (entries.length === 1 &&
            (entries[0].key !== key || (entries[0].type === 'f' && entries[0].genNum === 65_535)))))) {
        throw new Error('PDF object conflicts with the current xref entry.');
      }
    }
    numbers.set(number, key);
  };
  for (const key of modifiedKeys) if (doc.objects.has(key)) remember(key);
  if (newObjects) for (const key of newObjects.keys()) remember(key);
  return !!proof;
}
