/**
 * Stream Compiler
 *
 * Recompiles modified content stream tokens back into valid PDF stream bytes.
 * Handles:
 *   - Serialization of all PDF object types
 *   - FlateDecode compression of output
 *   - Stream length calculation
 *   - Multi-stream page handling (Contents as array)
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import type { PDFDocumentData, PDFPageInfo } from '../types';
import { flateEncode } from '../parser/filters';
import { inspectContentRefs } from '../parser/content-refs';
import { assertMultiStreamMergeSafe } from './multistream-edit-safety';

// Retain page ownership even for non-empty refs, so shared streams can be
// replaced through the page rather than overwritten under a shared object key.
const contentOwners = new WeakMap<PDFRef[], Map<PDFPageInfo, PDFDocumentData | undefined>>();
const contentStructureChanges = new WeakMap<Map<string, PDFObject>, Set<string>>();

/** Register page ownership for page-local stream updates. */
export function bindPageContentRefs<T extends PDFPageInfo>(page: T, doc?: PDFDocumentData): T {
  let owners = contentOwners.get(page.contentRefs);
  if (!owners) contentOwners.set(page.contentRefs, owners = new Map());
  // A refs array has no page identity of its own. Preserve multiple bindings
  // so an ambiguous shared cache cannot silently select the last bound page.
  owners.set(page, doc ?? owners.get(page));
  return page;
}

/** Page-owned objects required by explicit incremental saves. */
export function pageContentModifiedKeys(objects: Map<string, PDFObject>): Iterable<string> {
  return contentStructureChanges.get(objects) ?? [];
}

/** Register page edits that an explicit incremental save must include. */
export function recordPageContentModifiedKeys(objects: Map<string, PDFObject>, keys: Iterable<string>): void {
  let changes = contentStructureChanges.get(objects);
  if (!changes) contentStructureChanges.set(objects, changes = new Set());
  for (const key of keys) changes.add(key);
}

/** Preserve staged page content changes when a session publishes its object map. */
export function transferPageContentModifiedKeys(source: Map<string, PDFObject>, target: Map<string, PDFObject>): void {
  const pending = contentStructureChanges.get(source);
  if (!pending?.size) return;
  recordPageContentModifiedKeys(target, pending);
}

/** A reference outside this page's /Contents can observe an in-place change. */
function contentIsShared(refs: PDFRef[], objects: Map<string, PDFObject>, owner?: PDFPageInfo,
  doc?: PDFDocumentData): boolean {
  const keys = new Set(refs.map(ref => ref.toKey()));
  if (keys.size !== refs.length) return true;
  const targetObjects = new Set(refs.map(ref => objects.get(ref.toKey())).filter((value): value is PDFObject => !!value));
  const pending: Array<{ value: PDFObject; root: boolean }> = [];
  for (const [key, value] of objects) {
    if (owner && value === owner.dict && key !== owner.ref.toKey()) {
      throw new Error('Cannot safely edit a shared page dictionary.');
    }
    pending.push({ value, root: true });
  }
  if (doc) {
    pending.push({ value: doc.catalog, root: true }, { value: doc.xref.trailerDict, root: true });
    for (const page of doc.pages) {
      pending.push({ value: page.dict, root: true }, { value: page.resources, root: true });
      if (page !== owner) for (const ref of page.contentRefs) pending.push({ value: ref, root: true });
    }
  }
  const seen = new Set<PDFObject>();
  const references = new Map<string, number>();
  while (pending.length) {
    if (seen.size > 100_000 || pending.length > 100_000) return true;
    const { value, root } = pending.pop()!;
    if (value instanceof PDFRef) {
      if (keys.has(value.toKey())) {
        if (owner) return true;
        const key = value.toKey(), count = (references.get(key) ?? 0) + 1;
        if (count > 1) return true;
        references.set(key, count);
      }
      continue;
    }
    if (!root && value === owner?.dict) throw new Error('Cannot safely edit a shared page dictionary.');
    if (!root && targetObjects.has(value)) return true;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFArray) {
      for (const child of value.items) pending.push({ value: child, root: false });
    } else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (value === owner?.dict && key === 'Contents') continue;
        pending.push({ value: child, root: false });
      }
    } else if (value instanceof PDFStream) pending.push({ value: value.dict, root: false });
  }
  if (!owner && references.size) {
    const pageUses = new Map<string, number>();
    for (const value of objects.values()) {
      if (!(value instanceof PDFDict)) continue;
      const type = value.get('Type');
      if (!(type instanceof PDFName) || type.name !== 'Page') continue;
      let pageRefs: PDFRef[];
      try { pageRefs = inspectContentRefs(value.get('Contents'), objects); } catch { return true; }
      for (const ref of pageRefs) {
        const key = ref.toKey();
        if (keys.has(key)) pageUses.set(key, (pageUses.get(key) ?? 0) + 1);
      }
    }
    for (const key of references.keys()) if (pageUses.get(key) !== 1) return true;
  }
  return false;
}

/** Retain the indirect dependencies of stream dictionaries across compression. */
function snapshotStreamDependencies(streams: PDFStream[], objects: Map<string, PDFObject>) {
  const pending: PDFObject[] = streams.map(stream => stream.dict);
  const seen = new Set<PDFObject>(), seenKeys = new Set<string>();
  const snapshots: Array<{ key: string; value: PDFObject; serialized: string; raw?: Uint8Array; decoded?: Uint8Array | null }> = [];
  while (pending.length) {
    if (seen.size + seenKeys.size > 100_000 || pending.length > 100_000) throw new Error('Stream dependencies exceed the inspection limit.');
    const value = pending.pop()!;
    if (value instanceof PDFRef) {
      const key = value.toKey();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const target = objects.get(key);
      if (!target) throw new Error('Cannot inspect a stream dependency.');
      snapshots.push({ key, value: target, serialized: serializeToString(target),
        ...(target instanceof PDFStream ? { raw: new Uint8Array(target.rawBytes),
          decoded: target.decodedBytes ? new Uint8Array(target.decodedBytes) : null } : {}) });
      pending.push(target);
    } else if (!seen.has(value)) {
      seen.add(value);
      if (value instanceof PDFArray) for (const child of value.items) pending.push(child);
      else if (value instanceof PDFDict) for (const [, child] of value.entries()) pending.push(child);
      else if (value instanceof PDFStream) pending.push(value.dict);
    }
  }
  return snapshots;
}

// ─── Content stream compilation ─────────────────────────────────────────────

/**
 * Compile a content stream from raw text bytes.
 * Optionally compresses the output using FlateDecode.
 */
export async function compileContentStream(
  contentBytes: Uint8Array,
  compress: boolean = true,
): Promise<PDFStream> {
  let streamBytes: Uint8Array;
  const dict = new PDFDict();

  if (compress) {
    streamBytes = await flateEncode(contentBytes);
    dict.set('Filter', new PDFName('FlateDecode'));
  } else {
    streamBytes = contentBytes;
  }

  dict.set('Length', new PDFNumber(streamBytes.length));

  return new PDFStream(dict, streamBytes, contentBytes);
}

/**
 * Update a page's content stream with new bytes.
 * Handles single streams, arrays of streams, and registered pages without /Contents.
 *
 * @param contentRefs The page's content references, registered when the page is constructed
 * @param newContentBytes The new decoded content stream bytes
 * @param objects The document object map (will be mutated)
 * @param compress Whether to FlateDecode compress the output
 */
export async function updatePageContent(
  contentRefs: PDFRef[],
  newContentBytes: Uint8Array,
  objects: Map<string, PDFObject>,
  compress: boolean = true,
): Promise<void> {
  const activeOwners = () => {
    const bindings = contentOwners.get(contentRefs);
    return bindings ? [...bindings].filter(([page]) => page.contentRefs === contentRefs) : [];
  };
  const owners = activeOwners();
  if (owners.length > 1) throw new Error('Cannot safely edit page content with an ambiguous page owner.');
  const [owner, doc] = owners[0] ?? [];
  if (contentRefs.length === 0 && !owner) {
    throw new Error('Cannot attach content to an unregistered page');
  }
  const originalKeys = contentRefs.map(ref => ref.toKey());
  const originalPageDict = owner?.dict, originalPageRef = owner?.ref.toKey();
  const originalContents = owner?.dict.get('Contents');
  const validateOwner = () => {
    const currentOwners = activeOwners();
    if (currentOwners.length > 1 || currentOwners[0]?.[0] !== owner || currentOwners[0]?.[1] !== doc) {
      throw new Error('Page content changed during the operation or has an ambiguous page owner.');
    }
    if (!owner) return;
    if (owner.contentRefs !== contentRefs || owner.dict !== originalPageDict || owner.ref.toKey() !== originalPageRef ||
        objects.get(owner.ref.toKey()) !== owner.dict || (doc && (doc.objects !== objects || !doc.pages.includes(owner) ||
        doc.pages.some(page => page !== owner && (page.dict === owner.dict || page.ref.toKey() === originalPageRef ||
          page.contentRefs === contentRefs)))) ||
        owner.dict.get('Contents') !== originalContents) throw new Error('Page content changed during the operation.');
    const actual = inspectContentRefs(owner.dict.get('Contents'), objects);
    if (actual.length !== originalKeys.length || actual.some((ref, i) => ref.toKey() !== originalKeys[i])) {
      throw new Error('Page content references do not match the document.');
    }
  };
  validateOwner();
  const snapshots = originalKeys.map(key => {
    const stream = objects.get(key);
    if (!(stream instanceof PDFStream)) throw new Error('Cannot inspect a page content stream.');
    return { key, stream, dict: serializeToString(stream.dict), raw: new Uint8Array(stream.rawBytes),
      decoded: stream.decodedBytes ? new Uint8Array(stream.decodedBytes) : null };
  });
  const dependencies = snapshotStreamDependencies(snapshots.map(snapshot => snapshot.stream), objects);
  if (snapshots.length > 1) await assertMultiStreamMergeSafe(snapshots.map(snapshot => snapshot.stream), objects);
  const newStream = await compileContentStream(new Uint8Array(newContentBytes), compress);
  validateOwner();
  if (contentRefs.length !== originalKeys.length || contentRefs.some((ref, i) => ref.toKey() !== originalKeys[i])) {
    throw new Error('Page content changed during the operation.');
  }
  const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, i) => byte === right[i]);
  for (const snapshot of snapshots) {
    const stream = objects.get(snapshot.key);
    if (stream !== snapshot.stream || serializeToString(snapshot.stream.dict) !== snapshot.dict ||
        !sameBytes(snapshot.raw, snapshot.stream.rawBytes) ||
        (!!snapshot.decoded !== !!snapshot.stream.decodedBytes) || (snapshot.decoded &&
        (!snapshot.stream.decodedBytes || !sameBytes(snapshot.decoded, snapshot.stream.decodedBytes)))) {
      throw new Error('Page content changed during the operation.');
    }
  }
  for (const dependency of dependencies) {
    const current = objects.get(dependency.key);
    if (current !== dependency.value || serializeToString(current) !== dependency.serialized ||
        (current instanceof PDFStream && dependency.raw &&
          (!sameBytes(dependency.raw, current.rawBytes) || (!!dependency.decoded !== !!current.decodedBytes) ||
           (dependency.decoded && (!current.decodedBytes || !sameBytes(dependency.decoded, current.decodedBytes)))))) {
      throw new Error('Page content changed during the operation.');
    }
  }
  const shared = contentIsShared(contentRefs, objects, owner, doc);
  if (!owner && shared) throw new Error('Cannot safely edit shared page content without its page owner.');
  if (owner && (originalKeys.length === 0 || shared || !doc)) {
    let maxObjNum = 0;
    for (const key of objects.keys()) {
      const match = /^(\d+)_\d+$/.exec(key);
      if (!match) throw new Error('Cannot allocate a page content stream.');
      maxObjNum = Math.max(maxObjNum, Number(match[1]));
    }
    if (!Number.isSafeInteger(maxObjNum) || maxObjNum >= 2_147_483_647) throw new Error('Cannot allocate a page content stream.');
    const ref = new PDFRef(maxObjNum + 1, 0);
    objects.set(ref.toKey(), newStream);
    owner.dict.set('Contents', ref);
    contentRefs.splice(0, contentRefs.length, ref);
    owner.contentInspectionComplete = true;
    recordPageContentModifiedKeys(objects, [ref.toKey(), owner.ref.toKey()]);
    return;
  }

  const changedKeys: string[] = [];
  const replaceIfChanged = (index: number, replacement: PDFStream) => {
    const snapshot = snapshots[index];
    if (snapshot.dict === serializeToString(replacement.dict) && sameBytes(snapshot.raw, replacement.rawBytes)) {
      // Refresh an existing stale decoded cache even when serialized bytes match.
      if (snapshot.decoded && replacement.decodedBytes && !sameBytes(snapshot.decoded, replacement.decodedBytes)) {
        snapshot.stream.decodedBytes = replacement.decodedBytes;
      }
      return;
    }
    objects.set(snapshot.key, replacement);
    changedKeys.push(snapshot.key);
  };
  replaceIfChanged(0, newStream);
  // Consolidate multiple streams into the first stream and empty the rest.
  for (let i = 1; i < contentRefs.length; i++) {
    const emptyDict = new PDFDict();
    emptyDict.set('Length', new PDFNumber(0));
    replaceIfChanged(i, new PDFStream(emptyDict, new Uint8Array(0), new Uint8Array(0)));
  }
  if (changedKeys.length) recordPageContentModifiedKeys(objects, changedKeys);
  if (owner) owner.contentInspectionComplete = true;
}

// ─── PDF Object serialization ───────────────────────────────────────────────

/**
 * Serialize a PDF object to its byte representation for writing to a file.
 * This is used by the PDF writer (serializer.ts) for full document output.
 */
export function serializeObject(obj: PDFObject): Uint8Array {
  const text = serializeToString(obj);
  return stringToBytes(text);
}

/**
 * Serialize a PDF object to its string representation.
 */
const MAX_SERIALIZED_OBJECT_CHARS = 64 * 1024 * 1024;
const MAX_SERIALIZED_OBJECT_VALUES = 1_000_000;
export function serializeToString(obj: PDFObject): string {
  type Task = { kind: 'value'; value: PDFObject } | { kind: 'text'; text: string } | { kind: 'key'; name: string; separator: boolean } |
    { kind: 'leave'; value: PDFObject };
  const pending: Task[] = [{ kind: 'value', value: obj }];
  const active = new Set<PDFObject>();
  const parts: string[] = [];
  let size = 0, scheduledValues = 1;
  const append = (text: string) => {
    if (size + text.length > MAX_SERIALIZED_OBJECT_CHARS) throw new Error('PDF object exceeds the serialization output limit.');
    size += text.length;
    parts.push(text);
  };
  while (pending.length) {
    const task = pending.pop()!;
    if (task.kind === 'text') { append(task.text); continue; }
    if (task.kind === 'key') {
      if (task.separator) append(' ');
      append(serializeName(task.name, MAX_SERIALIZED_OBJECT_CHARS - size));
      append(' ');
      continue;
    }
    if (task.kind === 'leave') { active.delete(task.value); continue; }
    const value = task.value;
    if (value instanceof PDFBoolean) append(value.value ? 'true' : 'false');
    else if (value instanceof PDFNumber) append(formatNumber(value.value));
    else if (value instanceof PDFString) {
      if (value.value.length + 2 > MAX_SERIALIZED_OBJECT_CHARS - size) throw new Error('PDF object exceeds the serialization output limit.');
      append(serializeLiteralString(value.toBytes(), MAX_SERIALIZED_OBJECT_CHARS - size));
    } else if (value instanceof PDFHexString) {
      if (value.hex.length + 2 > MAX_SERIALIZED_OBJECT_CHARS - size) throw new Error('PDF object exceeds the serialization output limit.');
      append(`<${value.hex}>`);
    } else if (value instanceof PDFName) append(serializeName(value.name, MAX_SERIALIZED_OBJECT_CHARS - size));
    else if (value instanceof PDFNull) append('null');
    else if (value instanceof PDFRef) append(`${value.objNum} ${value.genNum} R`);
    else if (value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream) {
      if (active.has(value)) throw new Error('Cannot serialize a cyclic direct PDF object.');
      active.add(value);
      pending.push({ kind: 'leave', value });
      if (value instanceof PDFArray) {
        if (value.length > MAX_SERIALIZED_OBJECT_VALUES - scheduledValues) throw new Error('PDF object exceeds the serialization work limit.');
        scheduledValues += value.length;
        append('[');
        pending.push({ kind: 'text', text: ']' });
        for (let i = value.length - 1; i >= 0; i--) {
          pending.push({ kind: 'value', value: value.items[i] });
          if (i > 0) pending.push({ kind: 'text', text: ' ' });
        }
      } else if (value instanceof PDFDict) {
        if (value.size > MAX_SERIALIZED_OBJECT_VALUES - scheduledValues) throw new Error('PDF object exceeds the serialization work limit.');
        scheduledValues += value.size;
        append('<<');
        pending.push({ kind: 'text', text: '>>' });
        const entries = [...value.entries()];
        for (let i = entries.length - 1; i >= 0; i--) {
          pending.push({ kind: 'value', value: entries[i][1] });
          pending.push({ kind: 'key', name: entries[i][0], separator: i > 0 });
        }
      } else {
        // Stream payloads are handled by serializeIndirectObject.
        if (++scheduledValues > MAX_SERIALIZED_OBJECT_VALUES) throw new Error('PDF object exceeds the serialization work limit.');
        pending.push({ kind: 'value', value: value.dict });
      }
    } else append('null');
  }
  return parts.join('');
}

/**
 * Serialize a complete indirect object (objNum genNum obj ... endobj).
 * Includes stream data if the object is a PDFStream.
 */
export function serializeIndirectObject(
  objNum: number,
  genNum: number,
  obj: PDFObject,
): Uint8Array {
  const header = `${objNum} ${genNum} obj\n`;

  if (obj instanceof PDFStream) {
    const dictStr = serializeToString(obj.dict);
    const streamData = obj.rawBytes;

    // header + dict + \nstream\n + data + \nendstream\nendobj\n
    const prefix = stringToBytes(`${header}${dictStr}\nstream\n`);
    const suffix = stringToBytes('\nendstream\nendobj\n');

    const result = new Uint8Array(prefix.length + streamData.length + suffix.length);
    result.set(prefix, 0);
    result.set(streamData, prefix.length);
    result.set(suffix, prefix.length + streamData.length);
    return result;
  }

  const body = serializeToString(obj);
  return stringToBytes(`${header}${body}\nendobj\n`);
}

// ─── Serialization helpers ──────────────────────────────────────────────────

/**
 * Format a number, avoiding unnecessary decimals.
 * PDF spec allows up to 5 decimal places.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();

  // Use up to 5 decimal places, stripping trailing zeros
  let str = value.toFixed(5);
  // Remove trailing zeros after decimal point
  if (str.includes('.')) {
    str = str.replace(/0+$/, '');
    str = str.replace(/\.$/, '');
  }
  return str;
}

/**
 * Serialize a PDF literal string, escaping special characters.
 */
function serializeLiteralString(value: Uint8Array, maxLength = Infinity): string {
  let escaped = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    switch (ch) {
      case 0x0a: escaped += '\\n'; break;
      case 0x0d: escaped += '\\r'; break;
      case 0x09: escaped += '\\t'; break;
      case 0x08: escaped += '\\b'; break;
      case 0x0c: escaped += '\\f'; break;
      case 0x28: escaped += '\\('; break; // (
      case 0x29: escaped += '\\)'; break; // )
      case 0x5c: escaped += '\\\\'; break; // \
      default:
        if (ch < 0x20 || ch > 0x7e) {
          // Octal escape for non-printable
          escaped += '\\' + ch.toString(8).padStart(3, '0');
        } else {
          escaped += String.fromCharCode(ch);
        }
    }
    if (escaped.length + 2 > maxLength) throw new Error('PDF object exceeds the serialization output limit.');
  }
  return `(${escaped})`;
}

/**
 * Serialize a PDF name, escaping characters that need #xx encoding.
 */
function serializeName(name: string, maxLength = Infinity): string {
  let escaped = '/';
  if (name.length + 1 > maxLength) throw new Error('PDF object exceeds the serialization output limit.');
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    // Characters that need escaping in names
    if (ch < 0x21 || ch > 0x7e || ch === 0x23 || ch === 0x28 || ch === 0x29 ||
        ch === 0x3c || ch === 0x3e || ch === 0x5b || ch === 0x5d ||
        ch === 0x7b || ch === 0x7d || ch === 0x2f || ch === 0x25) {
      escaped += '#' + ch.toString(16).padStart(2, '0');
    } else {
      escaped += name[i];
    }
    if (escaped.length > maxLength) throw new Error('PDF object exceeds the serialization output limit.');
  }
  return escaped;
}

// ─── Byte utilities ─────────────────────────────────────────────────────────

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  return concatByteChunks(arrays);
}

/** Concatenate an existing list without spreading it into function arguments. */
export function concatByteChunks(arrays: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
