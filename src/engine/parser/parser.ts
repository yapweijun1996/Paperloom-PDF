/**
 * PDF Document Parser
 *
 * The top-level parser that:
 *   1. Reads the PDF header (version)
 *   2. Builds the cross-reference table (via xref.ts)
 *   3. Reads all indirect objects from the file
 *   4. Resolves indirect references
 *   5. Decodes streams (via filters.ts)
 *   6. Traverses the page tree to build a flat page list
 *   7. Returns a complete PDFDocumentData structure
 *
 * This is the entry point for loading any PDF file.
 */

import { PDFLexer, TokenType } from './lexer';
import { buildFullXref, parseObject as parseObjectFromXref } from './xref';
import { applyFilters, DecodeLimitError } from './filters';
import { bindPageContentRefs } from '../editor/stream-compiler';
import { inspectContentRefs } from './content-refs';
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
  type PDFDocumentData,
  type PDFDocumentInfo,
  type PDFPageInfo,
  type PDFRectangle,
  type XRefEntry,
  type XRefTable,
} from '../types';

// ─── Main parse function ────────────────────────────────────────────────────

export interface ParsePDFOptions {
  /**
   * When the PDF is encrypted, skip stream filter decoding until
   * SecurityEngine.open() decrypts the document. Default: true.
   */
  deferEncryptedFilters?: boolean;
}

/**
 * Parse a PDF file from raw bytes into a fully-resolved document structure.
 *
 * Encrypted documents are parsed structurally; call `securityEngine.open(doc, password)`
 * to authenticate and decrypt strings/streams before rendering or editing.
 *
 * @param data Raw PDF file bytes
 * @returns Parsed document with resolved objects, page tree, and metadata
 */
export async function parsePDF(
  data: Uint8Array,
  options: ParsePDFOptions = {},
): Promise<PDFDocumentData> {
  // 1. Read header
  const version = readHeader(data);

  // 2. Build cross-reference table
  let xref: XRefTable;
  try {
    xref = await buildFullXref(data);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse PDF: ${detail}`);
  }

  const encrypted = xref.trailerDict.has('Encrypt');
  const deferFilters = options.deferEncryptedFilters !== false && encrypted;

  // 3. Read all indirect objects (skip filter decode when encrypted)
  const objects = await readAllObjects(data, xref, { skipFilters: deferFilters });

  // 4. Create resolver function
  const resolve = (obj: PDFObject): PDFObject => resolveRef(obj, objects);

  // 5. Find catalog (root) dictionary
  const catalogRef = xref.trailerDict.getRef('Root');
  if (!catalogRef) throw new Error('Trailer missing /Root entry');
  const resolvedCatalog = resolve(catalogRef);
  // Encrypted object streams cannot be parsed until after authentication.
  // Expose only an encrypted shell until those objects can be materialized.
  const deferredObjects = deferFilters && [...xref.entries.values()].some(entry => entry.compressedObjNum !== undefined);
  const catalog = resolvedCatalog instanceof PDFDict ? resolvedCatalog : deferredObjects ? new PDFDict() : null;
  if (!catalog) throw new Error('/Root is not a dictionary');

  // 6. Build page tree
  const pages = deferredObjects ? [] : buildPageTree(catalog, objects, resolve);

  // 7. Extract document info (may contain encrypted strings — leave as-is)
  const info = deferredObjects ? {} : extractDocInfo(xref.trailerDict, resolve);

  const doc: PDFDocumentData = {
    version,
    objects,
    xref,
    catalog,
    pages,
    info,
    rawBytes: data,
  };
  for (const page of pages) bindPageContentRefs(page, doc);
  return doc;
}

// ─── Header parsing ─────────────────────────────────────────────────────────

function readHeader(data: Uint8Array): string {
  const lexer = new PDFLexer(data);
  const line = lexer.readLine();

  // Expected format: %PDF-1.7 or %PDF-2.0
  const match = line.match(/%PDF-(\d+\.\d+)/);
  if (match) return match[1];

  // Some PDFs have junk before the header — search for %PDF-
  const headerPos = lexer.searchForward('%PDF-', 0);
  if (headerPos !== -1) {
    lexer.position = headerPos;
    const headerLine = lexer.readLine();
    const m = headerLine.match(/%PDF-(\d+\.\d+)/);
    if (m) return m[1];
  }

  // Default to 1.4 if we can't find a version
  return '1.4';
}

// ─── Object reading ─────────────────────────────────────────────────────────

// Stream bytes are initially located before referenced length objects are
// necessarily available. The offsets let the object-loading pass re-slice the
// exact original bytes after resolving /Length, before decoding filters.
const streamDataOffsets = new WeakMap<PDFStream, number>();

function resolveStreamLength(
  stream: PDFStream,
  objects: Map<string, PDFObject>,
  xref: XRefTable,
): number | null {
  let value = stream.dict.get('Length');
  if (!(value instanceof PDFRef)) return null;
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key)) throw new Error('Invalid stream length: cyclic reference');
    seen.add(key);
    if (seen.size > 1024) throw new Error('Invalid stream length: reference chain is too deep');
    const next = objects.get(key);
    if (!next) {
      const entry = xref.entries.get(key);
      if (entry && entry.type !== 'f' && entry.compressedObjNum !== undefined) return null;
      throw new Error(`Invalid stream length: unresolved reference ${key}`);
    }
    value = next;
  }
  if (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.value) || value.value < 0) {
    throw new Error('Invalid stream length: expected a non-negative integer');
  }
  return value.value;
}

function restoreIndirectStreamBytes(stream: PDFStream, data: Uint8Array, length: number): void {
  const start = streamDataOffsets.get(stream);
  if (start === undefined || length > data.length - start) throw new Error('Invalid stream length: outside the file');
  const end = start + length;
  // The optional separator is one PDF EOL, not an arbitrary run of bytes.
  let marker = end;
  if (data[marker] === 0x0d) {
    marker++;
    if (data[marker] === 0x0a) marker++;
  } else if (data[marker] === 0x0a) marker++;
  const keyword = 'endstream';
  for (let i = 0; i < keyword.length; i++) {
    if (data[marker + i] !== keyword.charCodeAt(i)) throw new Error('Invalid stream length: endstream does not follow the specified bytes');
  }
  const following = data[marker + keyword.length];
  if (following !== undefined && ![0, 9, 10, 12, 13, 32, 40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(following)) {
    throw new Error('Invalid stream length: malformed endstream delimiter');
  }
  stream.rawBytes = data.slice(start, end);
  stream.decodedBytes = null;
}

/**
 * Read all indirect objects referenced in the xref table.
 * Returns a Map keyed by "objNum_genNum".
 */
async function readAllObjects(
  data: Uint8Array,
  xref: XRefTable,
  opts: { skipFilters?: boolean } = {},
): Promise<Map<string, PDFObject>> {
  const objects = new Map<string, PDFObject>();

  const xrefEntries = Array.from(xref.entries.entries());

  const pendingStreams = new Set<string>();
  const pendingCompressed = new Map<string, XRefEntry>();
  const objectStreamHeaders = new Map<PDFStream, Array<{ objNum: number; start: number; end: number }>>();
  const objectStreamBudget = { entries: 0 };

  // First pass: read uncompressed objects without decoding potentially
  // provisional stream data. A referenced length can appear later in xref.
  for (let ei = 0; ei < xrefEntries.length; ei++) {
    const [key, entry] = xrefEntries[ei];
    if (entry.type === 'f') continue; // Skip free entries
    if (entry.compressedObjNum !== undefined) continue; // Handle compressed objects later

    try {
      const obj = readIndirectObject(data, entry.offset);
      if (obj) {
        objects.set(key, obj);

        if (obj instanceof PDFStream) pendingStreams.add(key);
      }
    } catch (e) {
      // Object might be corrupted — skip it
      console.warn(`[PDF Parser] Failed to read object ${key} at offset ${entry.offset}:`, e);
    }
  }

  // Resolve stream lengths and compressed objects in dependency order: a
  // length may itself live in a different object stream.
  for (let ei = 0; ei < xrefEntries.length; ei++) {
    const [key, entry] = xrefEntries[ei];
    if (entry.type === 'f') continue;
    if (entry.compressedObjNum === undefined) continue;
    pendingCompressed.set(key, entry);
  }
  if (opts.skipFilters) pendingCompressed.clear();

  let dependencyPasses = 0;
  for (;;) {
    if (++dependencyPasses > 64) throw new Error('Invalid stream length: object-stream dependency chain is too deep');
    let progress = false;
    for (const key of [...pendingStreams]) {
      const stream = objects.get(key);
      if (!(stream instanceof PDFStream)) { pendingStreams.delete(key); continue; }
      if (stream.dict.get('Length') instanceof PDFRef) {
        const length = resolveStreamLength(stream, objects, xref);
        if (length === null) continue;
        restoreIndirectStreamBytes(stream, data, length);
      }
      if (!opts.skipFilters) await decodeStream(stream, objects);
      pendingStreams.delete(key);
      progress = true;
    }

    for (const [key, entry] of pendingCompressed) {
      const objStmKey = `${entry.compressedObjNum}_0`;
      if (pendingStreams.has(objStmKey)) continue;
      try {
        // Do not let the compressed-object fallback decode an unverified
        // stream when the container was missing from the first pass.
        const obj = objects.has(objStmKey) ? await readCompressedObject(entry, objects, data, xref, objectStreamHeaders, objectStreamBudget) : null;
        if (!obj) throw new ObjectStreamIntegrityError('Compressed object stream is missing or cannot be read.');
        if (obj) objects.set(key, obj);
      } catch (e) {
        if (e instanceof DecodeLimitError || e instanceof ObjectStreamIntegrityError) throw e;
        console.warn(`[PDF Parser] Failed to read compressed object ${key}:`, e);
      }
      pendingCompressed.delete(key);
      progress = true;
    }
    if (!progress) break;
  }
  if (pendingStreams.size && !opts.skipFilters) {
    throw new Error(`Invalid stream length: unresolved compressed reference for ${[...pendingStreams].join(', ')}`);
  }

  return objects;
}

/**
 * Read a single indirect object at the given byte offset.
 * Format: objNum genNum obj <value> endobj
 */
function readIndirectObject(data: Uint8Array, offset: number): PDFObject | null {
  if (offset >= data.length || offset < 0) return null;

  const lexer = new PDFLexer(data, offset);

  // Read: objNum genNum obj
  const objNumTok = lexer.nextToken();
  if (!objNumTok || objNumTok.type !== TokenType.Integer) return null;

  const genNumTok = lexer.nextToken();
  if (!genNumTok || genNumTok.type !== TokenType.Integer) return null;

  const objKeyword = lexer.nextToken();
  if (!objKeyword || objKeyword.type !== TokenType.Keyword || objKeyword.value !== 'obj') return null;

  // Parse the object value
  const value = parseFullObject(lexer, data);

  // Read endobj (optional — some generators omit it)
  lexer.skipWhitespaceAndComments();
  const endTok = lexer.nextToken();
  // We don't strictly require 'endobj'

  return value;
}

/**
 * Parse a PDF object, handling the possibility that a dictionary
 * might be followed by a stream.
 */
function parseFullObject(lexer: PDFLexer, fileData: Uint8Array): PDFObject {
  return parseObjectFromXref(lexer, {
    limitArrays: false,
    finishDictionary(dict) {
      // Stream detection also applies to a completed nested dictionary, as in
      // the former full parser's permissive handling of malformed input.
      lexer.skipWhitespaceAndComments();
      const savedPos = lexer.position;
      const streamTok = lexer.nextToken();
      if (streamTok && streamTok.type === TokenType.Keyword && streamTok.value === 'stream') {
        lexer.skipStreamEOL();
        return readStreamData(lexer, dict, fileData);
      }
      lexer.position = savedPos;
      return dict;
    },
  });
}

/**
 * Read stream data after 'stream' keyword + EOL has been consumed.
 */
function readStreamData(
  lexer: PDFLexer,
  dict: PDFDict,
  fileData: Uint8Array,
): PDFStream {
  const streamStart = lexer.position;

  // Try to use /Length from dictionary
  const lengthVal = dict.get('Length');
  let length = -1;

  if (lengthVal instanceof PDFNumber) {
    length = lengthVal.value;
  }

  let streamBytes: Uint8Array;

  if (length >= 0 && streamStart + length <= fileData.length) {
    // Verify that 'endstream' follows at the expected position
    let endPos = streamStart + length;
    // Skip whitespace before 'endstream'
    while (endPos < fileData.length && (fileData[endPos] === 0x0a || fileData[endPos] === 0x0d || fileData[endPos] === 0x20)) {
      endPos++;
    }

    // Check if 'endstream' is there
    const check = String.fromCharCode(
      fileData[endPos] ?? 0,
      fileData[endPos + 1] ?? 0,
      fileData[endPos + 2] ?? 0,
      fileData[endPos + 3] ?? 0,
      fileData[endPos + 4] ?? 0,
      fileData[endPos + 5] ?? 0,
      fileData[endPos + 6] ?? 0,
      fileData[endPos + 7] ?? 0,
      fileData[endPos + 8] ?? 0,
    );

    if (check.startsWith('endstream')) {
      streamBytes = fileData.slice(streamStart, streamStart + length);
      lexer.position = endPos + 9; // past 'endstream'
    } else {
      // Length was wrong — fall back to searching for 'endstream'
      streamBytes = findStreamByEndMarker(lexer, fileData, streamStart);
    }
  } else {
    // No valid length — search for 'endstream'
    streamBytes = findStreamByEndMarker(lexer, fileData, streamStart);
  }

  const stream = new PDFStream(dict, streamBytes);
  streamDataOffsets.set(stream, streamStart);
  return stream;
}

/**
 * Find stream data by searching forward for 'endstream' marker.
 * Fallback for when /Length is missing, incorrect, or an unresolved reference.
 */
function findStreamByEndMarker(
  lexer: PDFLexer,
  fileData: Uint8Array,
  streamStart: number,
): Uint8Array {
  const endPos = lexer.searchForward('endstream', streamStart);
  if (endPos !== -1) {
    // Trim only the single separator EOL, preserving earlier data bytes.
    let end = endPos;
    if (end > streamStart && fileData[end - 1] === 0x0a) {
      end--;
      if (end > streamStart && fileData[end - 1] === 0x0d) end--;
    } else if (end > streamStart && fileData[end - 1] === 0x0d) end--;
    lexer.position = endPos + 9; // past 'endstream'
    return fileData.slice(streamStart, end);
  }

  // Last resort — take everything to end of file
  lexer.position = fileData.length;
  return fileData.slice(streamStart);
}

// ─── Stream decoding ────────────────────────────────────────────────────────

/**
 * Decode a stream's data by applying its filter chain.
 * Resolves indirect /Length references if needed.
 */
async function decodeStream(
  stream: PDFStream,
  objects: Map<string, PDFObject>,
): Promise<void> {
  // Resolve /Length if it's an indirect reference
  const lengthObj = stream.dict.get('Length');
  if (lengthObj instanceof PDFRef) {
    const resolved = objects.get(lengthObj.toKey());
    if (resolved instanceof PDFNumber) {
      stream.dict.set('Length', resolved);
    }
  }

  const filters = stream.getFilters();
  if (filters.length === 0) {
    stream.decodedBytes = stream.rawBytes;
    return;
  }

  // Resolve DecodeParms if they contain indirect references
  const params = stream.getDecodeParams();
  const resolvedParams: (PDFDict | null)[] = params.map((p) => {
    if (p instanceof PDFRef) {
      const resolved = objects.get((p as unknown as PDFRef).toKey());
      return resolved instanceof PDFDict ? resolved : null;
    }
    return p;
  });

  try {
    stream.decodedBytes = await applyFilters(stream.rawBytes, filters, resolvedParams);
  } catch (e) {
    if (e instanceof DecodeLimitError) throw e;
    console.warn('[PDF Parser] Failed to decode stream:', e);
    stream.decodedBytes = stream.rawBytes;
  }
}

// ─── Compressed object reading ──────────────────────────────────────────────

class ObjectStreamIntegrityError extends Error {}

/** Object stream index ranges must contain exactly one complete PDF object. */
function parseObjectStreamMember(bytes: Uint8Array): PDFObject {
  const lexer = new PDFLexer(bytes, 0);
  try {
    const object = parseObjectFromXref(lexer, { strictBytes: bytes });
    lexer.skipWhitespaceAndComments();
    if (!lexer.isEOF) throw new Error('Additional object stream tokens');
    return object;
  } catch {
    throw new ObjectStreamIntegrityError('Invalid object stream member.');
  }
}

/**
 * Read an object that is stored inside an Object Stream (ObjStm).
 * Object streams are compressed containers that hold multiple objects.
 */
async function readCompressedObject(
  entry: XRefEntry,
  objects: Map<string, PDFObject>,
  data: Uint8Array,
  xref: XRefTable,
  headers: Map<PDFStream, Array<{ objNum: number; start: number; end: number }>>,
  budget: { entries: number },
): Promise<PDFObject | null> {
  if (entry.compressedObjNum === undefined || entry.compressedIndex === undefined) {
    return null;
  }

  const objStmKey = `${entry.compressedObjNum}_0`;
  let objStm = objects.get(objStmKey);

  // If the object stream hasn't been read yet, read it now
  if (!objStm) {
    const stmEntry = xref.entries.get(objStmKey);
    if (!stmEntry || stmEntry.type === 'f') return null;

    const rawObj = readIndirectObject(data, stmEntry.offset);
    if (rawObj && rawObj instanceof PDFStream) {
      await decodeStream(rawObj, objects);
      objects.set(objStmKey, rawObj);
      objStm = rawObj;
    } else {
      return null;
    }
  }

  if (!(objStm instanceof PDFStream)) return null;

  const streamData = objStm.getBytes();
  let header = headers.get(objStm);
  if (!header) {
    const n = objStm.dict.getNumber('N');
    const first = objStm.dict.getNumber('First');
    if (objStm.dict.getName('Type') !== 'ObjStm' || !Number.isSafeInteger(n) || n! < 0 || n! > 250_000 ||
        budget.entries + n! > 250_000 || !Number.isSafeInteger(first) || first! < 0 || first! > streamData.length) {
      throw new ObjectStreamIntegrityError('Invalid object stream header.');
    }
    budget.entries += n!;
    const headerLexer = new PDFLexer(streamData.subarray(0, first!), 0);
    const offsets: Array<{ objNum: number; start: number }> = [];
    const numbers = new Set<number>();
    for (let i = 0; i < n!; i++) {
      const obj = headerLexer.nextToken(), offset = headerLexer.nextToken();
      if (!obj || obj.type !== TokenType.Integer || !offset || offset.type !== TokenType.Integer ||
          !Number.isSafeInteger(obj.value) || (obj.value as number) <= 0 || numbers.has(obj.value as number) ||
          !Number.isSafeInteger(offset.value) || (offset.value as number) < 0 ||
          (offset.value as number) >= streamData.length - first!) {
        throw new ObjectStreamIntegrityError('Invalid object stream index.');
      }
      const start = first! + (offset.value as number);
      if (offsets.length && start <= offsets[offsets.length - 1].start) {
        throw new ObjectStreamIntegrityError('Invalid object stream offsets.');
      }
      numbers.add(obj.value as number);
      offsets.push({ objNum: obj.value as number, start });
    }
    headerLexer.skipWhitespaceAndComments();
    if (!headerLexer.isEOF) throw new ObjectStreamIntegrityError('Invalid object stream header.');
    header = offsets.map((item, index) => ({ ...item, end: offsets[index + 1]?.start ?? streamData.length }));
    headers.set(objStm, header);
  }
  const targetOffset = header[entry.compressedIndex];
  if (!targetOffset || targetOffset.objNum !== entry.objNum || targetOffset.start >= targetOffset.end) {
    throw new ObjectStreamIntegrityError('Invalid object stream reference.');
  }

  // Parse the object from the stream data
  // Objects in ObjStm are stored without 'obj'/'endobj' wrappers
  // and must occupy precisely their declared index range.
  return parseObjectStreamMember(streamData.subarray(targetOffset.start, targetOffset.end));
}

/** Materialize encrypted object streams only after their contents have been decrypted. */
export class EncryptedObjectMaterializer {
  private readonly deferred: Map<string, XRefEntry>;
  private readonly headers = new Map<PDFStream, Array<{ objNum: number; start: number; end: number }>>();
  private totalHeaderEntries = 0;

  constructor(private readonly doc: PDFDocumentData) {
    this.deferred = new Map([...doc.xref.entries.entries()].filter(([key, entry]) =>
      entry.type !== 'f' && entry.compressedObjNum !== undefined && !doc.objects.has(key)));
  }

  /** Materialize entries from streams which have already been decrypted. */
  processAvailable(): boolean {
    let progress = false;
    for (const [key, entry] of this.deferred) {
      const stream = this.doc.objects.get(`${entry.compressedObjNum}_0`);
      if (!(stream instanceof PDFStream) || stream.dict.getName('Type') !== 'ObjStm' || !stream.decodedBytes) continue;
      let header = this.headers.get(stream);
      if (!header) {
        const bytes = stream.decodedBytes;
        const count = stream.dict.getNumber('N');
        const first = stream.dict.getNumber('First');
        if (!Number.isSafeInteger(count) || count! < 0 || count! > 250_000 ||
            !Number.isSafeInteger(first) || first! < 0 || first! > bytes.length ||
            this.totalHeaderEntries + count! > 250_000) throw new Error('Invalid encrypted object stream header');
        this.totalHeaderEntries += count!;
        const lexer = new PDFLexer(bytes.subarray(0, first!), 0);
        const offsets: Array<{ objNum: number; start: number }> = [];
        for (let index = 0; index < count!; index++) {
          const obj = lexer.nextToken();
          const offset = lexer.nextToken();
          if (!obj || obj.type !== TokenType.Integer || !offset || offset.type !== TokenType.Integer ||
              !Number.isSafeInteger(obj.value) || (obj.value as number) <= 0 ||
              !Number.isSafeInteger(offset.value) || (offset.value as number) < 0 ||
              (offset.value as number) > bytes.length - first!) throw new Error('Invalid encrypted object stream index');
          const start = first! + (offset.value as number);
          if (offsets.length && start <= offsets[offsets.length - 1].start) throw new Error('Invalid encrypted object stream offsets');
          offsets.push({ objNum: obj.value as number, start });
        }
        lexer.skipWhitespaceAndComments();
        if (!lexer.isEOF) throw new Error('Invalid encrypted object stream header');
        header = offsets.map((item, index) => ({ ...item, end: offsets[index + 1]?.start ?? bytes.length }));
        this.headers.set(stream, header);
      }
      const target = header[entry.compressedIndex ?? -1];
      if (!target || target.objNum !== entry.objNum || target.start >= target.end) throw new Error('Invalid encrypted object stream reference');
      const value = parseObjectStreamMember(stream.decodedBytes.subarray(target.start, target.end));
      this.doc.objects.set(key, value);
      this.deferred.delete(key);
      progress = true;
    }
    return progress;
  }

  finish(): void {
    if (this.deferred.size) throw new Error('Invalid encrypted object stream: unresolved dependency');
    const doc = this.doc;
    const root = doc.xref.trailerDict.getRef('Root');
    const catalog = root && resolveRef(root, doc.objects);
    if (!(catalog instanceof PDFDict)) throw new Error('Invalid encrypted document catalog');
    doc.catalog = catalog;
    doc.pages = buildPageTree(catalog, doc.objects, object => resolveRef(object, doc.objects));
  }
}

function sameStreamMetadata(left: PDFObject, right: PDFObject, depth = 0): boolean {
  if (depth > 100) return false;
  if (left instanceof PDFDict && right instanceof PDFDict) {
    return left.size === right.size && [...left.entries()].every(([key, value]) => {
      const other = right.get(key);
      return other !== undefined && sameStreamMetadata(value, other, depth + 1);
    });
  }
  if (left instanceof PDFArray && right instanceof PDFArray) {
    return left.length === right.length && left.items.every((value, index) => sameStreamMetadata(value, right.items[index], depth + 1));
  }
  if (left instanceof PDFName && right instanceof PDFName) return left.name === right.name;
  if (left instanceof PDFString && right instanceof PDFString) return left.value === right.value;
  if (left instanceof PDFHexString && right instanceof PDFHexString) return left.hex === right.hex;
  if (left instanceof PDFNumber && right instanceof PDFNumber) return left.value === right.value;
  if (left instanceof PDFBoolean && right instanceof PDFBoolean) return left.value === right.value;
  if (left instanceof PDFRef && right instanceof PDFRef) return left.equals(right);
  return left instanceof PDFNull && right instanceof PDFNull;
}

/** Validate encrypted stream state and resolve indirect length after materialization. */
export function restoreEncryptedIndirectStream(doc: PDFDocumentData, key: string, stream: PDFStream): boolean {
  const entry = doc.xref.entries.get(key);
  if (!entry || entry.type === 'f' || entry.compressedObjNum !== undefined) throw new Error('Invalid stream length: missing stream entry');
  const original = readIndirectObject(doc.rawBytes, entry.offset);
  if (!(original instanceof PDFStream)) throw new Error('Invalid stream length: missing original stream');
  if (!sameStreamMetadata(original.dict, stream.dict)) throw new Error('Encrypted stream changed before length resolution');
  const provisional = original.rawBytes;
  const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
  if (!(original.dict.get('Length') instanceof PDFRef)) {
    if (!equal(provisional, stream.rawBytes)) throw new Error('Encrypted stream changed before length resolution');
    return true;
  }
  const length = resolveStreamLength(original, doc.objects, doc.xref);
  if (length === null) return false;
  restoreIndirectStreamBytes(original, doc.rawBytes, length);
  // The parser might already have resolved the length before authentication,
  // or it may have only found a provisional end marker in the ciphertext.
  if (!equal(provisional, stream.rawBytes) && !equal(original.rawBytes, stream.rawBytes)) {
    throw new Error('Encrypted stream changed before length resolution');
  }
  stream.rawBytes = original.rawBytes;
  stream.decodedBytes = null;
  return true;
}

// ─── Reference resolution ───────────────────────────────────────────────────

/**
 * Resolve an indirect reference to its actual object.
 * If the input is not a PDFRef, return it unchanged.
 */
export function resolveRef(
  obj: PDFObject,
  objects: Map<string, PDFObject>,
): PDFObject {
  const visited = new Set<string>();
  let current = obj;
  while (current instanceof PDFRef) {
    const key = current.toKey();
    if (visited.has(key)) throw new Error('Cyclic indirect reference in PDF object graph');
    if (visited.size >= 100_000) throw new Error('Indirect reference chain exceeds the supported limit');
    visited.add(key);
    const resolved = objects.get(key);
    if (!resolved) return PDFNull.instance;
    current = resolved;
  }
  return current;
}

/**
 * Deep-resolve: resolve a PDFRef and also resolve refs inside dicts/arrays.
 * Use sparingly — most of the time you want shallow resolution.
 */
export function deepResolve(
  obj: PDFObject,
  objects: Map<string, PDFObject>,
  depth: number = 0,
): PDFObject {
  if (depth > 20) return obj; // Prevent infinite recursion

  const resolved = resolveRef(obj, objects);

  if (resolved instanceof PDFDict) {
    const newDict = new PDFDict();
    const entries = Array.from(resolved.entries());
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      newDict.set(key, deepResolve(value, objects, depth + 1));
    }
    return newDict;
  }

  if (resolved instanceof PDFArray) {
    return new PDFArray(
      resolved.items.map((item) => deepResolve(item, objects, depth + 1)),
    );
  }

  return resolved;
}

/**
 * Resolve a page's own resources or the nearest ancestor's resources.
 * Initial page-tree traversal supplies its inherited value to avoid rewalking parents.
 */
export function resolvePageResources(
  page: PDFDict,
  objects: Map<string, PDFObject>,
  inherited?: PDFObject,
): PDFDict {
  const own = page.get('Resources');
  if (own !== undefined || inherited !== undefined) {
    const resources = resolveRef(own ?? inherited!, objects);
    return resources instanceof PDFDict ? resources : new PDFDict();
  }

  const visited = new Set<PDFDict>([page]);
  let node = page;
  while (true) {
    const parentObj = node.get('Parent');
    const parent = parentObj ? resolveRef(parentObj, objects) : undefined;
    if (!(parent instanceof PDFDict) || visited.has(parent)) return new PDFDict();
    visited.add(parent);
    const resourcesObj = parent.get('Resources');
    if (resourcesObj !== undefined) {
      const resources = resolveRef(resourcesObj, objects);
      return resources instanceof PDFDict ? resources : new PDFDict();
    }
    node = parent;
  }
}

// ─── Page tree traversal ────────────────────────────────────────────────────

/**
 * Build a flat array of PDFPageInfo from the document catalog's /Pages tree.
 * The page tree is a tree of /Pages (intermediate) and /Page (leaf) nodes.
 */
function buildPageTree(
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
  resolve: (obj: PDFObject) => PDFObject,
): PDFPageInfo[] {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) throw new Error('Catalog missing /Pages entry');

  const pagesObj = resolve(pagesRef);
  if (!(pagesObj instanceof PDFDict)) throw new Error('/Pages is not a dictionary');

  const pages: PDFPageInfo[] = [];
  const pending = [{ node: pagesObj, ref: pagesRef, inherited: {} as Record<string, PDFObject> }];
  const visited = new Set<PDFDict>();
  const maxPageTreeNodes = 100_000;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (visited.has(item.node)) throw new Error('Cyclic or duplicate node in PDF page tree');
    if (visited.size >= maxPageTreeNodes) throw new Error('PDF page tree exceeds the supported node limit');
    visited.add(item.node);
    collectPages(item.node, item.ref, objects, resolve, pages, item.inherited, pending, maxPageTreeNodes);
  }

  return pages;
}

/**
 * Collect a page and enqueue its children for iterative traversal.
 * Inherited properties (MediaBox, CropBox, Rotate, Resources) are propagated
 * from parent /Pages nodes to child /Page nodes.
 */
function collectPages(
  node: PDFDict,
  nodeRef: PDFRef,
  objects: Map<string, PDFObject>,
  resolve: (obj: PDFObject) => PDFObject,
  pages: PDFPageInfo[],
  inherited: Record<string, PDFObject>,
  pending: { node: PDFDict; ref: PDFRef; inherited: Record<string, PDFObject> }[],
  maxPageTreeNodes: number,
): void {
  const type = node.getName('Type');

  // Build inherited properties
  const currentInherited = { ...inherited };
  for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
    const val = node.get(key);
    if (val !== undefined) {
      currentInherited[key] = resolve(val);
    }
  }

  if (type === 'Page') {
    // Leaf node — this is an actual page
    const pageIndex = pages.length;

    // MediaBox (required, but might be inherited)
    const mediaBoxObj = node.get('MediaBox')
      ? resolve(node.get('MediaBox')!)
      : currentInherited['MediaBox'];
    const mediaBox = parseRectangle(mediaBoxObj);

    // CropBox (defaults to MediaBox)
    const cropBoxObj = node.get('CropBox')
      ? resolve(node.get('CropBox')!)
      : currentInherited['CropBox'];
    const cropBox = cropBoxObj ? parseRectangle(cropBoxObj) : mediaBox;

    // Rotate
    const rotateObj = node.get('Rotate')
      ?? currentInherited['Rotate'];
    const rotate = rotateObj instanceof PDFNumber ? rotateObj.value : 0;

    // Resources
    const resources = resolvePageResources(node, objects, currentInherited['Resources'] ?? PDFNull.instance);

    // Content streams
    const contentsObj = node.get('Contents');
    let contentRefs: PDFRef[], contentInspectionComplete = true;
    try { contentRefs = inspectContentRefs(contentsObj, objects); }
    catch {
      // Preserve the historical permissive open behavior, but do not let a
      // partial cache masquerade as a complete page during reading or editing.
      contentInspectionComplete = false;
      contentRefs = contentsObj instanceof PDFRef ? [contentsObj]
        : contentsObj instanceof PDFArray ? contentsObj.items.filter((item): item is PDFRef => item instanceof PDFRef) : [];
    }

    pages.push(bindPageContentRefs({
      index: pageIndex,
      dict: node,
      mediaBox,
      cropBox,
      rotate,
      ref: nodeRef,
      resources,
      contentRefs,
      ...(contentInspectionComplete ? {} : { contentInspectionComplete: false }),
    }));
  } else if (type === 'Pages') {
    // Intermediate node — recurse into Kids
    const kidsObj = node.get('Kids');
    const kids = resolve(kidsObj ?? PDFNull.instance);

    if (kids instanceof PDFArray) {
      if (pending.length + kids.length > maxPageTreeNodes) {
        throw new Error('PDF page tree exceeds the supported node limit');
      }
      // Stack traversal must retain the original /Kids order.
      for (let i = kids.items.length - 1; i >= 0; i--) {
        const kidRef = kids.items[i];
        const resolvedKid = resolve(kidRef);
        if (resolvedKid instanceof PDFDict) {
          const ref = kidRef instanceof PDFRef ? kidRef : new PDFRef(0, 0);
          pending.push({ node: resolvedKid, ref, inherited: currentInherited });
        }
      }
    }
  }
}

/**
 * Parse a PDF rectangle array [x1, y1, x2, y2] into a PDFRectangle.
 */
function parseRectangle(obj: PDFObject | undefined): PDFRectangle {
  if (!(obj instanceof PDFArray) || obj.length < 4) {
    // Default to US Letter size
    return { x: 0, y: 0, width: 612, height: 792 };
  }

  const nums = obj.asNumbers();
  const x1 = nums[0] ?? 0;
  const y1 = nums[1] ?? 0;
  const x2 = nums[2] ?? 612;
  const y2 = nums[3] ?? 792;

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// ─── Document info extraction ───────────────────────────────────────────────

function extractDocInfo(
  trailer: PDFDict,
  resolve: (obj: PDFObject) => PDFObject,
): PDFDocumentInfo {
  const infoRef = trailer.get('Info');
  if (!infoRef) return {};

  const infoObj = resolve(infoRef);
  if (!(infoObj instanceof PDFDict)) return {};

  return {
    title: infoObj.getString('Title'),
    author: infoObj.getString('Author'),
    subject: infoObj.getString('Subject'),
    keywords: infoObj.getString('Keywords'),
    creator: infoObj.getString('Creator'),
    producer: infoObj.getString('Producer'),
    creationDate: infoObj.getString('CreationDate'),
    modDate: infoObj.getString('ModDate'),
  };
}

// ─── Public utilities ───────────────────────────────────────────────────────

/**
 * Get the decoded bytes of a content stream for a page.
 * Handles both single and multiple content streams (concatenates them).
 */
export function getPageContentBytes(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Uint8Array {
  if (page.contentInspectionComplete === false) {
    let refs: PDFRef[];
    try { refs = inspectContentRefs(page.dict.get('Contents'), objects); }
    catch { throw new Error('Page content cannot be fully inspected.'); }
    // The damaged structure may have been repaired since opening the file.
    page.contentRefs.splice(0);
    for (const ref of refs) page.contentRefs.push(ref);
    page.contentInspectionComplete = true;
  }
  const chunks: Uint8Array[] = [];

  for (const ref of page.contentRefs) {
    const obj = objects.get(ref.toKey());
    if (obj instanceof PDFStream) {
      const bytes = obj.getBytes();
      // Add a separator only between streams. A trailing separator would
      // mutate a single stream's bytes when a history snapshot is captured.
      if (chunks.length > 0) chunks.push(new Uint8Array([0x20]));
      chunks.push(bytes);
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Resolve a resource by type and name.
 * E.g., getResource(page.resources, 'Font', 'F1', objects) → the Font dictionary
 */
export function getResource(
  resources: PDFDict,
  category: string,
  name: string,
  objects: Map<string, PDFObject>,
): PDFObject | undefined {
  const categoryObj = resources.get(category);
  if (!categoryObj) return undefined;

  const categoryDict = resolveRef(categoryObj, objects);
  if (!(categoryDict instanceof PDFDict)) return undefined;

  const resource = categoryDict.get(name);
  if (!resource) return undefined;

  return resolveRef(resource, objects);
}
