/**
 * PDF Cross-Reference Table/Stream Parser
 *
 * Handles all xref formats:
 *   - Traditional xref tables (PDF 1.0+)
 *   - Cross-reference streams (PDF 1.5+)
 *   - Incremental updates (multiple xref sections chained via /Prev)
 *   - Hybrid xref (table + stream in same file)
 *
 * The xref maps object numbers to byte offsets in the file,
 * allowing random access to any indirect object.
 */

import { PDFLexer, TokenType } from './lexer';
import {
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFBoolean,
  PDFString,
  PDFHexString,
  PDFNull,
  PDFStream,
  type PDFObject,
  type XRefEntry,
  type XRefTable,
} from '../types';
import { applyFilters, DecodeLimitError } from './filters';
import { bindXrefProvenanceAsync } from './xref-provenance';

// The parser remains permissive for damaged PDFs, but only complete,
// unambiguous sections can establish current-generation ordering.
const completeSections = new WeakSet<XRefTable>();

// The index may describe zero-byte entries, so the decoded stream length alone
// cannot bound the work or the number of objects retained in the map.
export const MAX_XREF_STREAM_ENTRIES = 250_000;
export const MAX_XREF_RANGES = 16_384;
export const MAX_XREF_WORK_BYTES = 32 * 1024 * 1024;
const MAX_XREF_DECODE_STAGE_BYTES = 16 * 1024 * 1024;
const MAX_XREF_FILTERS = 8;
class XRefEntryLimitError extends Error {}
interface XRefWorkBudget { entries: number; ranges: number; bytes: number }

function newXrefBudget(): XRefWorkBudget { return { entries: 0, ranges: 0, bytes: 0 }; }

function chargeEntries(budget: XRefWorkBudget, count: number, kind: string): void {
  if (!Number.isSafeInteger(count) || count < 0 ||
      count > MAX_XREF_STREAM_ENTRIES - budget.entries) {
    throw new XRefEntryLimitError(`${kind} exceeds the supported entry limit`);
  }
  budget.entries += count;
}

function chargeRanges(budget: XRefWorkBudget, count: number): void {
  if (count > MAX_XREF_RANGES - budget.ranges) throw new XRefEntryLimitError('Xref exceeds the supported range limit');
  budget.ranges += count;
}

function chargeBytes(budget: XRefWorkBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_XREF_WORK_BYTES - budget.bytes) {
    throw new XRefEntryLimitError('Xref stream exceeds the supported byte work limit');
  }
  budget.bytes += count;
}

// ─── Find startxref ─────────────────────────────────────────────────────────

/**
 * Find the byte offset of the most recent xref section.
 * Per PDF spec, the file ends with:
 *   startxref
 *   <offset>
 *   %%EOF
 *
 * We search backward from end of file to find "startxref".
 */
export function findStartXref(data: Uint8Array): number {
  const lexer = new PDFLexer(data);

  // Search backward from end for "startxref"
  const pos = lexer.searchBackward('startxref');
  if (pos === -1) {
    throw new Error('Cannot find startxref — file may be corrupted or not a PDF');
  }

  // Position after "startxref"
  lexer.position = pos + 'startxref'.length;
  lexer.skipWhitespaceAndComments();

  // Read the offset value
  const token = lexer.nextToken();
  if (!token || token.type !== TokenType.Integer) {
    throw new Error('Invalid startxref value');
  }

  return token.value as number;
}

// ─── Parse traditional xref table ───────────────────────────────────────────

/**
 * Parse a traditional xref table starting at the given byte offset.
 * Format:
 *   xref
 *   0 6          ← subsection: start_obj_num count
 *   0000000000 65535 f   ← offset gen type
 *   0000000009 00000 n
 *   ...
 *   trailer
 *   << /Size 6 /Root 1 0 R >>
 */
export function parseXrefTable(data: Uint8Array, offset: number, baseOffset = 0, budget: XRefWorkBudget = newXrefBudget()): XRefTable {
  const lexer = new PDFLexer(data, offset);

  // Read "xref" keyword
  lexer.skipWhitespaceAndComments();
  const xrefKeyword = lexer.nextToken();
  if (!xrefKeyword || xrefKeyword.type !== TokenType.Keyword || xrefKeyword.value !== 'xref') {
    throw new Error(`Expected 'xref' keyword at offset ${offset}, got: ${xrefKeyword?.value}`);
  }

  const entries = new Map<string, XRefEntry>();
  const objectNumbers = new Set<number>();
  let complete = true, foundTrailer = false;

  // Read subsections until we hit "trailer"
  while (true) {
    lexer.skipWhitespaceAndComments();

    // Peek to see if we've hit "trailer"
    const savedPos = lexer.position;
    const nextTok = lexer.nextToken();

    if (!nextTok || (nextTok.type === TokenType.Keyword && nextTok.value === 'trailer')) {
      foundTrailer = nextTok?.type === TokenType.Keyword && nextTok.value === 'trailer';
      break;
    }

    // This should be the start object number of a subsection
    if (nextTok.type !== TokenType.Integer) {
      // Might be something unexpected — try to recover
      complete = false;
      break;
    }

    const startObjNum = nextTok.value as number;

    // Read count
    const countTok = lexer.nextToken();
    if (!countTok || countTok.type !== TokenType.Integer) {
      throw new Error('Expected object count in xref subsection');
    }
    const count = countTok.value as number;
    if (!Number.isSafeInteger(startObjNum) || startObjNum < 0 || !Number.isSafeInteger(count) || count < 0 ||
        !Number.isSafeInteger(startObjNum + count)) throw new Error('Invalid xref table subsection');
    chargeRanges(budget, 1);
    chargeEntries(budget, count, 'Xref table');

    // Read entries
    for (let i = 0; i < count; i++) {
      lexer.skipWhitespace();

      // Each entry is exactly: "0000000009 00000 n \n" (20 bytes including EOL)
      // But we'll parse flexibly using the lexer
      const offsetTok = lexer.nextToken();
      const genTok = lexer.nextToken();
      const typeTok = lexer.nextToken();

      if (!offsetTok || !genTok || !typeTok) {
        complete = false;
        break;
      }

      const objNum = startObjNum + i;
      const byteOffset = (offsetTok.value as number) + baseOffset;
      const genNum = genTok.value as number;
      const type = (typeTok.value as string) === 'n' ? 'n' as const : 'f' as const;
      if (offsetTok.type !== TokenType.Integer || genTok.type !== TokenType.Integer ||
          !Number.isSafeInteger(offsetTok.value) || (offsetTok.value as number) < 0 ||
          !Number.isSafeInteger(genNum) || genNum < 0 || genNum > 65_535 ||
          !['n', 'f'].includes(String(typeTok.value)) || objectNumbers.has(objNum)) complete = false;
      objectNumbers.add(objNum);

      const key = `${objNum}_${genNum}`;
      // Only add if not already present (later xref sections take precedence
      // because we process them first due to /Prev chain)
      if (!entries.has(key)) {
        entries.set(key, { objNum, genNum, offset: byteOffset, type });
      }
    }
  }

  // Parse trailer dictionary
  lexer.skipWhitespaceAndComments();
  const trailerDict = parseObject(lexer) as PDFDict;

  if (!(trailerDict instanceof PDFDict)) {
    throw new Error('Expected trailer dictionary');
  }

  const table = { entries, trailerDict };
  if (complete && foundTrailer) completeSections.add(table);
  return table;
}

// ─── Parse cross-reference stream (PDF 1.5+) ───────────────────────────────

/**
 * Parse a cross-reference stream object.
 * XRef streams are indirect objects with /Type /XRef.
 * The stream data contains packed binary entries.
 */
export async function parseXrefStream(
  data: Uint8Array,
  offset: number,
  baseOffset = 0,
  budget: XRefWorkBudget = newXrefBudget(),
): Promise<XRefTable> {
  if (offset > 0 && ![0, 9, 10, 12, 13, 32].includes(data[offset - 1])) {
    throw new Error('Xref stream offset does not start at an object boundary');
  }
  const lexer = new PDFLexer(data, offset);

  // Read: objNum genNum obj
  const objNumTok = lexer.nextToken();
  const genNumTok = lexer.nextToken();
  const objKeyword = lexer.nextToken();

  if (!objKeyword || objKeyword.type !== TokenType.Keyword || objKeyword.value !== 'obj') {
    throw new Error(`Expected 'obj' keyword at xref stream offset ${offset}`);
  }

  // Parse the stream object (dict + stream data)
  const streamObj = parseStreamObject(lexer, data, budget);

  if (!(streamObj instanceof PDFStream)) {
    throw new Error('XRef stream is not a stream object');
  }

  const dict = streamObj.dict;
  if (dict.getName('Type') !== 'XRef') throw new Error('Cross-reference stream missing /Type /XRef');

  // Read W array: field widths [type_width offset_width gen_width]
  const wArray = dict.getArray('W');
  if (!wArray) throw new Error('XRef stream missing /W array');
  const w = wArray.asNumbers();
  if (w.length !== 3 || w.some(width => !Number.isSafeInteger(width) || width < 0 || width > 8)) {
    throw new Error('Invalid xref stream /W field widths');
  }
  const [w0, w1, w2] = w;
  const entrySize = w0 + w1 + w2;

  // Read Index array: [start count start count ...]
  // Default: [0 Size]
  const size = dict.getNumber('Size') ?? 0;
  const indexArray = dict.getArray('Index');
  const indices: number[] = indexArray
    ? indexArray.asNumbers()
    : [0, size];

  if (indices.length % 2 !== 0) throw new Error('Invalid xref stream /Index array');
  chargeRanges(budget, indices.length / 2);
  let totalEntries = 0;
  for (let i = 0; i < indices.length; i += 2) {
    const start = indices[i];
    const count = indices[i + 1];
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0 ||
        !Number.isSafeInteger(start + count)) {
      throw new Error('Invalid xref stream /Index range');
    }
    if (count > MAX_XREF_STREAM_ENTRIES - totalEntries) throw new XRefEntryLimitError('Xref stream exceeds the supported entry limit');
    totalEntries += count;
  }
  chargeEntries(budget, totalEntries, 'Xref stream');

  const filters = streamObj.getFilters();
  const params = streamObj.getDecodeParams();
  if (filters.length > MAX_XREF_FILTERS) throw new XRefEntryLimitError('Xref stream exceeds the supported filter limit');
  const decodedData = filters.length > 0
    ? await applyFilters(streamObj.rawBytes, filters, params, {
      maxDecodedBytes: MAX_XREF_DECODE_STAGE_BYTES,
      remainingDecodedBytes: () => MAX_XREF_WORK_BYTES - budget.bytes,
      consumeDecodedBytes: length => chargeBytes(budget, length),
      consumeFailedDecodedBytes: length => chargeBytes(budget, length),
    })
    : streamObj.rawBytes;
  if (totalEntries * entrySize > decodedData.length) {
    throw new Error('Truncated xref stream entries');
  }

  const entries = new Map<string, XRefEntry>();
  const objectNumbers = new Set<number>();
  let complete = objNumTok?.type === TokenType.Integer && genNumTok?.type === TokenType.Integer;

  let dataPos = 0;
  for (let i = 0; i < indices.length; i += 2) {
    const startObj = indices[i];
    const count = indices[i + 1];

    for (let j = 0; j < count; j++) {
      // Read fields from the binary data
      const type = w0 > 0 ? readIntFromBytes(decodedData, dataPos, w0) : 1; // default type 1
      dataPos += w0;
      const field2 = readIntFromBytes(decodedData, dataPos, w1);
      dataPos += w1;
      const field3 = readIntFromBytes(decodedData, dataPos, w2);
      dataPos += w2;

      const objNum = startObj + j;
      if (objectNumbers.has(objNum) || ![0, 1, 2].includes(type) ||
          ((type === 0 || type === 1) && field3 > 65_535)) complete = false;
      objectNumbers.add(objNum);

      if (type === 0) {
        // Free object
        const key = `${objNum}_${field3}`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: field3,
            offset: field2 + baseOffset, // next free object number
            type: 'f',
          });
        }
      } else if (type === 1) {
        // Uncompressed object
        const key = `${objNum}_${field3}`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: field3,
            offset: field2 + baseOffset, // byte offset
            type: 'n',
          });
        }
      } else if (type === 2) {
        // Compressed object (in an Object Stream)
        const key = `${objNum}_0`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: 0,
            offset: 0,
            type: 'n',
            compressedObjNum: field2,  // object number of the ObjStm
            compressedIndex: field3,    // index within the ObjStm
          });
        }
      }
    }
  }

  // The stream dict IS the trailer dict for xref streams
  const table = { entries, trailerDict: dict };
  if (complete) completeSections.add(table);
  return table;
}

/**
 * Read a big-endian integer from a byte array.
 */
function readIntFromBytes(data: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    value = value * 256 + data[offset + i];
    if (!Number.isSafeInteger(value)) throw new Error('Xref stream integer exceeds the supported range');
  }
  return value;
}

// ─── Full xref resolution (follows /Prev chain) ────────────────────────────

class XRefChainError extends Error {}
export const MAX_XREF_REVISIONS = 10_000;

/**
 * Build the complete cross-reference table by following the /Prev chain
 * through all incremental updates.
 *
 * Returns the merged xref and the most recent trailer dictionary.
 */
export async function buildFullXref(data: Uint8Array): Promise<XRefTable> {
  // Parse the same immutable snapshot that is hashed after asynchronous xref
  // stream decoding, then verify the caller's source has not changed.
  const snapshot = new Uint8Array(data);
  const startxref = findStartXref(snapshot);
  const headerOffset = findPdfHeaderOffset(snapshot);
  try {
    const { table, authoritative } = await buildStrictXref(snapshot, startxref, headerOffset);
    await bindXrefProvenanceAsync(data, table, authoritative ? 'strict' : 'conservative', snapshot);
    return table;
  } catch (strictError) {
    // Scanning cannot establish which revisions were omitted by a cycle or an
    // excessive chain, so do not silently present a potentially partial graph.
    if (strictError instanceof XRefChainError || strictError instanceof XRefEntryLimitError || strictError instanceof DecodeLimitError) throw strictError;
    try {
      const table = await rebuildXrefByScanning(snapshot, headerOffset);
      await bindXrefProvenanceAsync(data, table, 'conservative', snapshot);
      return table;
    } catch (recoveryError) {
      const detail = recoveryError instanceof Error ? recoveryError.message : String(strictError);
      throw new Error(`PDF cross-reference recovery failed: ${detail}`);
    }
  }
}

function findPdfHeaderOffset(data: Uint8Array): number {
  const limit = Math.min(data.length, 1024);
  const marker = new TextDecoder('latin1').decode(data.slice(0, limit)).indexOf('%PDF-');
  if (marker < 0) throw new Error('PDF header not found');
  return marker;
}

async function buildStrictXref(data: Uint8Array, startxref: number, baseOffset: number): Promise<{ table: XRefTable; authoritative: boolean }> {
  const mergedEntries = new Map<string, XRefEntry>();
  const currentEntries = new Map<number, [string, XRefEntry]>();
  let authoritative = true;
  const budget = newXrefBudget();
  let mainTrailer: PDFDict | null = null;

  let currentOffset: number | null = startxref + baseOffset;
  const visited = new Set<number>();

  while (currentOffset !== null) {
    if (visited.has(currentOffset)) throw new XRefChainError('Cyclic xref /Prev chain');
    if (visited.size >= MAX_XREF_REVISIONS) throw new XRefChainError('Xref /Prev chain exceeds the supported revision limit');
    if (!Number.isSafeInteger(currentOffset) || currentOffset < 0 || currentOffset >= data.length) {
      throw new Error('Invalid xref /Prev offset');
    }
    visited.add(currentOffset);

    let xrefSection: XRefTable;

    // Determine if this is a traditional xref table or an xref stream
    const isTable = isTraditionalXref(data, currentOffset);

    if (isTable) {
      xrefSection = parseXrefTable(data, currentOffset, baseOffset, budget);
    } else {
      xrefSection = await parseXrefStream(data, currentOffset, baseOffset, budget);
    }
    if (!completeSections.has(xrefSection)) authoritative = false;

    // Read supplemental entries in a hybrid revision. A conflicting table
    // entry cannot establish safe ordering across readers, so retain the
    // table's entry and downgrade provenance for the complete revision.
    let sectionEntries = xrefSection.entries;
    const hybridValue = xrefSection.trailerDict.get('XRefStm');
    if (hybridValue !== undefined) {
      if (!(hybridValue instanceof PDFNumber) || !Number.isSafeInteger(hybridValue.value) || hybridValue.value < 0 ||
          !Number.isSafeInteger(hybridValue.value + baseOffset) || hybridValue.value + baseOffset >= data.length) {
        authoritative = false;
      } else {
        try {
          const supplemental = await parseXrefStream(data, hybridValue.value + baseOffset, baseOffset, budget);
          if (!completeSections.has(supplemental)) authoritative = false;
          const byNumber = new Map<number, [string, XRefEntry]>();
          for (const [key, entry] of xrefSection.entries) byNumber.set(entry.objNum, [key, entry]);
          for (const [key, entry] of supplemental.entries) {
            const tableEntry = byNumber.get(entry.objNum);
            if (!tableEntry) byNumber.set(entry.objNum, [key, entry]);
            else if (tableEntry[0] !== key || tableEntry[1].type !== entry.type || tableEntry[1].offset !== entry.offset ||
                     tableEntry[1].compressedObjNum !== entry.compressedObjNum || tableEntry[1].compressedIndex !== entry.compressedIndex) {
              authoritative = false;
            }
          }
          sectionEntries = new Map(byNumber.values());
        } catch (error) {
          if (error instanceof XRefEntryLimitError || error instanceof DecodeLimitError) throw error;
          // Preserve opening behavior, but do not claim complete occupancy.
          authoritative = false;
        }
      }
    }

    // Merge entries (entries from later updates take precedence — 
    // since we process most recent first, only add if not already present)
    Array.from(sectionEntries.entries()).forEach(([key, entry]) => {
      if (!currentEntries.has(entry.objNum)) currentEntries.set(entry.objNum, [key, entry]);
      if (!mergedEntries.has(key)) {
        mergedEntries.set(key, entry);
      }
    });

    // Keep the first (most recent) trailer as the main trailer
    if (!mainTrailer) {
      mainTrailer = xrefSection.trailerDict;
    }

    // Follow /Prev pointer to previous xref section
    const rawPrev = xrefSection.trailerDict.get('Prev');
    const prev = xrefSection.trailerDict.getNumber('Prev');
    if (rawPrev !== undefined && (!(rawPrev instanceof PDFNumber) || !Number.isSafeInteger(prev) || prev! < 0)) {
      throw new Error('Invalid xref /Prev entry');
    }
    currentOffset = prev == null ? null : prev + baseOffset;
  }

  if (!mainTrailer) {
    throw new Error('No trailer dictionary found');
  }

  validateXrefOffsets(data, mergedEntries);
  return { table: { entries: authoritative ? new Map(currentEntries.values()) : mergedEntries, trailerDict: mainTrailer }, authoritative };
}

function validateXrefOffsets(data: Uint8Array, entries: Map<string, XRefEntry>): void {
  for (const entry of entries.values()) {
    if (entry.type !== 'n' || entry.compressedObjNum !== undefined) continue;
    const match = new TextDecoder('latin1').decode(data.slice(entry.offset, Math.min(data.length, entry.offset + 40)))
      .match(/^\s*(\d+)\s+(\d+)\s+obj\b/);
    if (!match || Number(match[1]) !== entry.objNum || Number(match[2]) !== entry.genNum) {
      throw new Error(`object ${entry.objNum} points at an invalid offset`);
    }
  }
}

/** Recover offsets and trailer metadata when startxref/xref entries are damaged. */
async function rebuildXrefByScanning(data: Uint8Array, baseOffset: number): Promise<XRefTable> {
  const text = new TextDecoder('latin1').decode(data);
  const entries = new Map<string, XRefEntry>();
  const budget = newXrefBudget();
  const objectPattern = /(?:^|[\r\n\x00\x20])([0-9]+)\s+([0-9]+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(text))) {
    chargeEntries(budget, 1, 'Xref recovery scan');
    const objNum = Number(match[1]);
    const genNum = Number(match[2]);
    const offset = match.index + (match[0].length - match[0].trimStart().length);
    entries.set(`${objNum}_${genNum}`, { objNum, genNum, offset, type: 'n' });
  }
  if (!entries.size) throw new Error('no indirect objects found');

  let trailerDict: PDFDict | null = null;
  const trailerPos = text.lastIndexOf('trailer');
  if (trailerPos >= 0) {
    const lexer = new PDFLexer(data, trailerPos + 'trailer'.length);
    const parsed = parseObject(lexer);
    if (parsed instanceof PDFDict) trailerDict = parsed;
  }

  // A damaged xref-stream startxref still leaves its object discoverable by scan.
  if (!trailerDict) {
    const candidateBudget = newXrefBudget();
    for (const entry of entries.values()) {
      try {
        const candidate = await parseXrefStream(data, entry.offset, baseOffset, candidateBudget);
        if (candidate.trailerDict.getName('Type') === 'XRef') {
          trailerDict = candidate.trailerDict;
          for (const [key, xrefEntry] of candidate.entries) entries.set(key, xrefEntry);
          break;
        }
      } catch (error) {
        if (error instanceof XRefEntryLimitError || error instanceof DecodeLimitError) throw error;
        /* ordinary indirect object */
      }
    }
  }
  if (!trailerDict) throw new Error('no trailer dictionary found');
  if (!trailerDict.has('Size')) {
    let maximum = 0;
    for (const entry of entries.values()) maximum = Math.max(maximum, entry.objNum);
    trailerDict.set('Size', new PDFNumber(maximum + 1));
  }
  return { entries, trailerDict };
}

/**
 * Check if the data at the given offset starts a traditional xref table
 * (starts with "xref" keyword) vs an xref stream (starts with object definition).
 */
export function isTraditionalXref(data: Uint8Array, offset: number): boolean {
  // Skip whitespace
  let pos = offset;
  while (pos < data.length && (data[pos] === 0x20 || data[pos] === 0x0a || data[pos] === 0x0d || data[pos] === 0x09)) {
    pos++;
  }

  // Check if it starts with "xref"
  return (
    pos + 3 < data.length &&
    data[pos] === 0x78 &&     // x
    data[pos + 1] === 0x72 && // r
    data[pos + 2] === 0x65 && // e
    data[pos + 3] === 0x66    // f
  );
}

// ─── Object parsing helpers (used by xref stream parsing) ───────────────────

/**
 * Parse a single PDF object from the lexer's current position.
 * This is a simplified version used for trailer/xref parsing.
 * The full parser in parser.ts uses this same logic but with reference resolution.
 */
export function parseObject(lexer: PDFLexer, options: {
  /** Full object parsing recognizes streams after any completed dictionary. */
  finishDictionary?: (dict: PDFDict) => PDFObject;
  /** Full object parsing historically has no xref /Index array limit. */
  limitArrays?: boolean;
  /** Validate object-stream members without changing permissive file recovery. */
  strictBytes?: Uint8Array;
} = {}): PDFObject {
  type Frame = { kind: 'array'; value: PDFArray } | { kind: 'dict'; value: PDFDict; key?: string };
  const frames: Frame[] = [];
  const readValue = (): PDFObject | undefined => {
    lexer.skipWhitespaceAndComments();
    const token = lexer.nextToken();
    if (!token || (options.strictBytes && token.type === TokenType.EOF)) throw new Error('Unexpected end of data while parsing object');
    if (options.strictBytes && (token.type === TokenType.String || token.type === TokenType.HexString)) {
      const bytes = options.strictBytes, end = lexer.position;
      if (token.type === TokenType.HexString) {
        if (bytes[end - 1] !== 0x3e) throw new Error('Unterminated PDF hex string');
        for (let index = token.offset + 1; index < end - 1; index++) {
          const ch = bytes[index];
          if (![0, 9, 10, 12, 13, 32].includes(ch) && !(ch >= 48 && ch <= 57) &&
              !(ch >= 65 && ch <= 70) && !(ch >= 97 && ch <= 102)) throw new Error('Invalid PDF hex string');
        }
      } else {
        let depth = 0, closed = false;
        for (let index = token.offset; index < end; index++) {
          const ch = bytes[index];
          if (ch === 0x5c) { if (++index >= end) break; if (bytes[index] === 13 && bytes[index + 1] === 10) index++; }
          else if (ch === 0x28) depth++;
          else if (ch === 0x29 && --depth === 0) { closed = index === end - 1; break; }
        }
        if (!closed) throw new Error('Unterminated PDF literal string');
      }
    }
    switch (token.type) {
      case TokenType.Boolean: return new PDFBoolean(token.value as boolean);
      case TokenType.Integer:
      case TokenType.Real: {
        if (options.strictBytes && (typeof token.value !== 'number' || !Number.isFinite(token.value))) {
          throw new Error('Invalid PDF object number');
        }
        if (token.type === TokenType.Integer) {
          const savedPos = lexer.position;
          const nextTok = lexer.nextToken();
          if (nextTok && nextTok.type === TokenType.Integer) {
            const rTok = lexer.nextToken();
            if (rTok && rTok.type === TokenType.Keyword && rTok.value === 'R') return new PDFRef(token.value as number, nextTok.value as number);
          }
          lexer.position = savedPos;
        }
        return new PDFNumber(token.value as number);
      }
      case TokenType.String: return new PDFString(token.value as string);
      case TokenType.HexString: return new PDFHexString(token.value as string);
      case TokenType.Name: return new PDFName(token.value as string);
      case TokenType.Null: return PDFNull.instance;
      case TokenType.Keyword:
        if (token.value === '<<') { frames.push({ kind: 'dict', value: new PDFDict() }); return undefined; }
        if (token.value === '[') { frames.push({ kind: 'array', value: new PDFArray() }); return undefined; }
        if (options.strictBytes) throw new Error('Invalid PDF object keyword');
        return PDFNull.instance;
      default:
        if (options.strictBytes) throw new Error('Invalid PDF object token');
        return PDFNull.instance;
    }
  };
  let value = readValue();
  while (true) {
    if (value !== undefined) {
      const parent = frames[frames.length - 1];
      if (!parent) return value;
      if (parent.kind === 'array') parent.value.items.push(value);
      else { parent.value.set(parent.key!, value); parent.key = undefined; }
      value = undefined;
    }
    const frame = frames[frames.length - 1];
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) {
      if (options.strictBytes) throw new Error('Unterminated PDF object container');
      frames.pop();
      value = frame.kind === 'dict' ? (options.finishDictionary?.(frame.value) ?? frame.value) : frame.value;
      continue;
    }
    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token || (token.type === TokenType.Keyword && token.value === (frame.kind === 'dict' ? '>>' : ']'))) {
      frames.pop();
      value = frame.kind === 'dict' ? (options.finishDictionary?.(frame.value) ?? frame.value) : frame.value;
      continue;
    }
    if (frame.kind === 'dict') {
      // Preserve the parser's permissive recovery for non-name dictionary keys.
      if (token.type !== TokenType.Name) {
        if (options.strictBytes) throw new Error('Invalid PDF dictionary key');
        continue;
      }
      frame.key = token.value as string;
    } else {
      lexer.position = savedPos;
      if (options.limitArrays !== false && frame.value.length >= MAX_XREF_RANGES * 2) {
        throw new XRefEntryLimitError('Xref array exceeds the supported range limit');
      }
    }
    value = readValue();
  }
}

/**
 * Parse a stream object (dictionary followed by stream data).
 * The lexer should be positioned just after reading the opening '<<' and
 * the full dictionary has been consumed.
 */
function parseStreamObject(lexer: PDFLexer, fileData: Uint8Array, budget: XRefWorkBudget): PDFObject {
  // Parse the dictionary first
  const obj = parseObject(lexer);
  if (!(obj instanceof PDFDict)) return obj;
  // Recovery visits ordinary indirect objects too. Do not scan or copy their
  // potentially enormous streams while looking for a cross-reference stream.
  if (obj.getName('Type') !== 'XRef') return obj;

  // Check for 'stream' keyword
  lexer.skipWhitespaceAndComments();
  const savedPos = lexer.position;
  const tok = lexer.nextToken();

  if (!tok || tok.type !== TokenType.Keyword || tok.value !== 'stream') {
    lexer.position = savedPos;
    return obj;
  }

  // Skip EOL after 'stream'
  lexer.skipStreamEOL();

  // Read stream data
  const length = obj.getNumber('Length');
  let streamBytes: Uint8Array;

  if (length !== undefined && Number.isSafeInteger(length) && length >= 0 && length <= fileData.length - lexer.position) {
    chargeBytes(budget, length);
    streamBytes = fileData.subarray(lexer.position, lexer.position + length);
    lexer.position += length;
  } else {
    // Indirect or invalid lengths require a bounded search; account for every
    // byte examined, including unsuccessful searches and repeated candidates.
    const start = lexer.position;
    const marker = 'endstream';
    const remaining = MAX_XREF_WORK_BYTES - budget.bytes;
    const last = Math.min(fileData.length - marker.length, start + remaining);
    let endPos = -1;
    let cursor = start;
    for (; cursor <= last; cursor++) {
      let j = 0;
      while (j < marker.length && fileData[cursor + j] === marker.charCodeAt(j)) j++;
      if (j === marker.length) { endPos = cursor; break; }
    }
    chargeBytes(budget, Math.min(fileData.length - start, Math.max(0, cursor - start + marker.length)));
    if (endPos < 0 && last < fileData.length - marker.length) throw new XRefEntryLimitError('Xref stream exceeds the supported byte work limit');
    if (endPos !== -1) {
      // Trim trailing whitespace before 'endstream'
      let end = endPos;
      while (end > lexer.position && (fileData[end - 1] === 0x0a || fileData[end - 1] === 0x0d)) {
        end--;
      }
      streamBytes = fileData.subarray(lexer.position, end);
      lexer.position = endPos;
    } else {
      streamBytes = new Uint8Array(0);
    }
  }

  // Skip 'endstream'
  lexer.skipWhitespaceAndComments();
  const endTok = lexer.nextToken();
  // endTok should be 'endstream' — we don't strictly enforce

  return new PDFStream(obj, streamBytes);
}
