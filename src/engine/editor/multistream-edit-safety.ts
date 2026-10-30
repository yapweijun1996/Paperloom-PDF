import { parseInlineImage } from '../content/operator-lexer';
import { applyFilters } from '../parser/filters';
import { PDFLexer, TokenType, type Token } from '../parser/lexer';
import { PDFArray, PDFDict, PDFName, PDFNull, PDFRef, PDFStream, type PDFObject } from '../types';

export class MultiStreamBoundaryError extends Error {
  constructor() { super('Cannot edit: a page content stream boundary cannot be safely merged.'); this.name = 'MultiStreamBoundaryError'; }
}
const fail = (): never => { throw new MultiStreamBoundaryError(); };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const whitespace = (b: number) => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const delimiter = (b: number) => b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 ||
  b === 123 || b === 125 || b === 47 || b === 37;
const digit = (b: number) => b >= 48 && b <= 57;

/** Find a token's end without allocating a string proportional to its length. */
function tokenEnd(data: Uint8Array, start: number): { end: number; type: TokenType } {
  const first = data[start];
  let end = start + 1;
  if (first === 40) {
    let depth = 1;
    while (end < data.length && depth) {
      const byte = data[end++];
      if (byte === 92 && end < data.length) {
        if (data[end++] === 13 && data[end] === 10) end++;
      } else if (byte === 40) depth++;
      else if (byte === 41) depth--;
    }
    return { end, type: TokenType.String };
  }
  if (first === 60 && data[end] !== 60) {
    while (end < data.length && data[end++] !== 62) { /* scan hex bytes */ }
    return { end, type: TokenType.HexString };
  }
  if ((first === 60 || first === 62) && data[end] === first) return { end: end + 1, type: TokenType.Keyword };
  if (delimiter(first) && first !== 47) return { end, type: TokenType.Keyword };
  if (first === 47) {
    while (end < data.length && !whitespace(data[end]) && !delimiter(data[end])) end++;
    return { end, type: TokenType.Name };
  }
  if (digit(first) || first === 43 || first === 45 || first === 46) {
    let position = start;
    if (data[position] === 43 || data[position] === 45) position++;
    const digitsStart = position;
    while (digit(data[position])) position++;
    const hadInteger = position > digitsStart;
    let hadFraction = false;
    if (data[position] === 46) {
      position++;
      const fractional = position;
      while (digit(data[position])) position++;
      hadFraction = position > fractional;
    }
    if (hadInteger || hadFraction) {
      if (data[position] === 69 || data[position] === 101) {
        let exponent = position + 1;
        if (data[exponent] === 43 || data[exponent] === 45) exponent++;
        const exponentStart = exponent;
        while (digit(data[exponent])) exponent++;
        if (exponent > exponentStart) position = exponent;
      }
      return { end: position, type: TokenType.Real };
    }
  }
  while (end < data.length && !whitespace(data[end]) && !delimiter(data[end])) end++;
  return { end, type: TokenType.Keyword };
}

/** Parse unusually long image-header numbers without building their source text. */
function longNumber(data: Uint8Array, start: number, end: number): number {
  let position = start, sign = 1;
  if (data[position] === 43 || data[position] === 45) sign = data[position++] === 45 ? -1 : 1;
  let coefficient = 0, significant = 0, exponent = 0, fractional = false, lostNonzero = false;
  while (position < end && data[position] !== 69 && data[position] !== 101) {
    const byte = data[position++];
    if (byte === 46) { fractional = true; continue; }
    const value = byte - 48;
    if (significant === 0 && value === 0) { if (fractional) exponent--; continue; }
    if (significant < 16) {
      coefficient = coefficient * 10 + value;
      significant++;
      if (fractional) exponent--;
    } else if (fractional) {
      if (value !== 0) lostNonzero = true;
    } else {
      exponent++;
      if (value !== 0) lostNonzero = true;
    }
  }
  if (lostNonzero) return Number.NaN;
  if (position < end) {
    position++;
    let exponentSign = 1, explicit = 0;
    if (data[position] === 43 || data[position] === 45) exponentSign = data[position++] === 45 ? -1 : 1;
    while (position < end) explicit = Math.min(100_000, explicit * 10 + data[position++] - 48);
    exponent += exponentSign * explicit;
  }
  if (coefficient === 0) return sign * 0;
  return sign * coefficient * 10 ** exponent;
}

/** Refuse merges that would inject whitespace into literal text or inline-image bytes. */
export async function assertMultiStreamMergeSafe(streams: PDFStream[], objects: Map<string, PDFObject>): Promise<void> {
  if (streams.length > 4096) return fail();
  const limit = 128 * 1024 * 1024;
  let referenceWork = 0, filterWork = 0, rawWork = 0;
  const resolve = (value: PDFObject): PDFObject => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key) || seen.size >= 128 || ++referenceWork > 65_536) return fail();
      seen.add(key);
      const next = objects.get(key);
      if (!next) return fail();
      value = next;
    }
    return value;
  };
  const chunks: Uint8Array[] = [], boundaries: number[] = [];
  let total = 0;
  for (const stream of streams) {
    rawWork += stream.rawBytes.length;
    if (rawWork > limit) return fail();
    const filterObject = stream.dict.get('Filter');
    const filter = filterObject ? resolve(filterObject) : undefined;
    if (filter instanceof PDFArray && filter.length > 32) return fail();
    const filters = filter instanceof PDFArray ? filter.items.map(resolve) : filter && !(filter instanceof PDFNull) ? [filter] : [];
    filterWork += filters.length;
    if (filterWork > 4096) return fail();
    const supportedFilters = new Set(['FlateDecode', 'Fl', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL']);
    if (!filters.every(f => f instanceof PDFName && supportedFilters.has(f.name))) return fail();
    const paramsObject = stream.dict.get('DecodeParms');
    const param = paramsObject ? resolve(paramsObject) : undefined;
    if (param instanceof PDFArray && param.length > 32) return fail();
    const params = param instanceof PDFArray ? param.items.map(resolve) : param && !(param instanceof PDFNull) ? [param] : [];
    if (!params.every(p => p instanceof PDFDict || p instanceof PDFNull)) return fail();
    let decoded: Uint8Array;
    try { decoded = await applyFilters(new Uint8Array(stream.rawBytes), filters.map(f => (f as PDFName).name),
      params.map(p => p instanceof PDFDict ? p : null), { maxDecodedBytes: limit - total }); }
    catch { return fail(); }
    if (!same(decoded, stream.getBytes()) || decoded.length > limit - total) return fail();
    if (chunks.length) { boundaries.push(total); total++; }
    if (total + decoded.length > limit) return fail();
    chunks.push(decoded); total += decoded.length;
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i) merged[pos++] = 32;
    merged.set(chunks[i], pos); pos += chunks[i].length;
  }
  const lexer = new PDFLexer(merged);
  const originalNextToken = lexer.nextToken.bind(lexer);
  let boundaryIndex = 0, steps = 0;
  const inspect = (start: number, end: number, type: TokenType) => {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= start) boundaryIndex++;
    if (type === TokenType.String && boundaryIndex < boundaries.length && boundaries[boundaryIndex] < end) return fail();
  };
  // The inline-image parser still needs real short header tokens. Oversized
  // unrecognized tokens are represented without copying their entire contents.
  lexer.nextToken = (): Token | null => {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) return originalNextToken();
    const start = lexer.position;
    const { end, type } = tokenEnd(merged, start);
    inspect(start, end, type);
    if (end - start <= 4096) return originalNextToken();
    lexer.position = end;
    if (type === TokenType.String || type === TokenType.HexString) return { type, value: '', offset: start };
    if (type === TokenType.Name) return { type, value: '__oversized_name__', offset: start };
    if (type === TokenType.Real) return { type, value: longNumber(merged, start, end), offset: start };
    return { type: TokenType.Keyword, value: '__oversized_keyword__', offset: start };
  };
  while (!lexer.isEOF) {
    if (++steps > 4_000_000) return fail();
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;
    const start = lexer.position;
    const { end, type } = tokenEnd(merged, start);
    inspect(start, end, type);
    lexer.position = end;
    if (type === TokenType.Keyword && end === start + 2 && merged[start] === 66 && merged[start + 1] === 73) {
      let image: PDFDict | null;
      try { image = parseInlineImage(lexer, merged); } catch { return fail(); }
      if (!image) return fail();
      const start = image.getNumber('__imageDataOffset'), length = image.getNumber('__imageDataSampleLength');
      if (start === undefined || length === undefined) return fail();
      while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] < start) boundaryIndex++;
      if (boundaryIndex < boundaries.length && boundaries[boundaryIndex] < start + length) return fail();
    }
  }
}
