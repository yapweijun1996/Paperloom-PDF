import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString,
  type PDFDocumentData, type PDFObject } from '../../types';
import { PDFLexer, TokenType } from '../../parser/lexer';
import { decodeZlibFully } from '../../parser/filters';
import { inspectContentRefs } from '../../parser/content-refs';
import { serializeToString } from '../../editor/stream-compiler';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { hasDocumentSignature } from '../../writer/save-pipeline';
import { assertCompletePageTree } from '../validate-page-tree';
import { decodeStrictHexString } from '../strict-hex-string';
import type { SecureRedactionOptions, SecureRedactionResult } from '../types';
import { coversRectangle, type Bounds } from './rectangle-coverage';
import { assertRedactionRewriteSafe } from './rewrite-preflight';
import { isBareRedactionMark } from './bare-redaction-mark';

/** Text outside this deliberately restricted, inspectable subset is refused. */
export class IsolatedTextRedactionUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Secure isolated text redaction is unavailable: ${reason}. The document was not changed.`);
    this.name = 'IsolatedTextRedactionUnsupportedError';
  }
}
function refuse(reason: string): never { throw new IsolatedTextRedactionUnsupportedError(reason); }
function resolve(value: PDFObject | undefined, doc: PDFDocumentData): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key) || seen.size >= 128) refuse('a reference is cyclic or too deep');
    seen.add(key);
    value = doc.objects.get(key);
    if (!value) refuse('a reference cannot be resolved');
  }
  return value;
}
function dictionary(value: PDFObject | undefined, doc: PDFDocumentData): PDFDict {
  const result = resolve(value, doc);
  if (!(result instanceof PDFDict)) refuse('a required dictionary cannot be inspected');
  return result;
}
function onlyKeys(dict: PDFDict, allowed: readonly string[]): void {
  if ([...dict.keys()].some(key => !allowed.includes(key))) refuse('a document feature is unsupported');
}
function numbers(value: PDFObject | undefined, count: number): number[] {
  if (!(value instanceof PDFArray) || value.length !== count) refuse('redaction geometry is invalid');
  return value.items.map(item => {
    if (!(item instanceof PDFNumber) || !Number.isFinite(item.value)) refuse('redaction geometry is invalid');
    return item.value;
  });
}
function bounds(values: number[]): Bounds {
  const area = { minX: Math.min(values[0], values[2]), minY: Math.min(values[1], values[3]),
    maxX: Math.max(values[0], values[2]), maxY: Math.max(values[1], values[3]) };
  if (!Object.values(area).every(Number.isFinite) || area.maxX <= area.minX || area.maxY <= area.minY) refuse('redaction geometry is empty or invalid');
  return area;
}
function markArea(mark: PDFDict): Bounds {
  const area = bounds(numbers(mark.get('Rect'), 4));
  const raw = mark.get('QuadPoints');
  if (raw !== undefined) {
    const points = numbers(raw, 8);
    const expected = [area.minX, area.maxY, area.maxX, area.maxY, area.minX, area.minY, area.maxX, area.minY];
    if (!points.every((value, i) => value === expected[i])) refuse('redaction quadrilaterals are unsupported');
  }
  return area;
}
function intersects(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}
function areaIntersects(a: Bounds, b: Bounds): boolean {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxY > b.minY && a.minY < b.maxY;
}

const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const ws = '[\\x00\\x09\\x0a\\x0c\\x0d\\x20]+';
const optWs = '[\\x00\\x09\\x0a\\x0c\\x0d\\x20]*';
// Every block selects its own font and resets the text matrix with BT. Bare
// BT/ET blocks are accepted only without color changes, so deleting one
// cannot change the graphics color inherited by a later block.
const textHeader =
  `(/(?:[A-Za-z_][A-Za-z0-9_.-]*))${ws}(${number})${ws}Tf${ws}(?:${number}${ws}TL${ws})?` +
  `(?:(?:(${number})${ws}(${number})${ws}(${number})${ws}(${number})${ws}(${number})${ws}(${number})${ws}Tm)|` +
  `(?:(${number})${ws}(${number})${ws}(?:Td|TD)))${ws}`;
const blockHeader = new RegExp(`${optWs}q${ws}BT${ws}(?:(?:(?:${number}${ws}){1}(?:g)|(?:${number}${ws}){3}rg)${ws})?${textHeader}`, 'gy');
const bareBlockHeader = new RegExp(`${optWs}BT${ws}${textHeader}`, 'gy');
// Compare exact decimal syntax, not Number(), so rounding cannot turn a
// non-identity transformation into a seemingly safe identity matrix.
const decimalOne = /^\+?0*1(?:\.0*)?$/;
const decimalZero = /^[+-]?(?:0+(?:\.0*)?|\.0+)$/;
// A closing string/array delimiter itself separates the following operator.
const showOperator = new RegExp(`${optWs}(Tj|TJ)${ws}`, 'gy');
const blockTail = new RegExp(`(?:T\\*${ws})?ET${ws}Q(?=[\\x00\\x09\\x0a\\x0c\\x0d\\x20]|$)`, 'gy');
const bareBlockTail = new RegExp(`(?:T\\*${ws})?ET(?=[\\x00\\x09\\x0a\\x0c\\x0d\\x20]|$)`, 'gy');
const literalToken = /^\((?:[^()\\\x00-\x1f]|\\(?:[()\\nrtbf]|[0-7]{1,3}))*\)$/;
const hexToken = /^<[0-9A-Fa-f\x00\x09\x0a\x0c\x0d\x20]*>$/;
const numberToken = new RegExp(`^${number}$`);
const trailingWhitespace = /^[\x00\x09\x0a\x0c\x0d\x20]*$/;
// The PDF base fonts use known metrics, unlike embedded or overridden fonts.
// Symbol and ZapfDingbats have different character mappings and are excluded.
const LATIN_BASE_FONTS = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
]);
function textBytes(token: string): Uint8Array {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/[\x00\x09\x0a\x0c\x0d\x20]/g, '');
    if (hex.length % 2) refuse('text encoding is unsupported');
    return Uint8Array.from((hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)));
  }
  const lexer = new PDFLexer(new TextEncoder().encode(token));
  const value = lexer.nextToken();
  if (!value || value.type !== TokenType.String || typeof value.value !== 'string' || !lexer.isEOF) refuse('text encoding is unsupported');
  return Uint8Array.from(Array.from(value.value, char => char.charCodeAt(0)));
}

interface Showing { bytes: Uint8Array; fragments: Uint8Array[]; adjustments: number[]; operations: number; end: number }

/** Inspect consecutive show operations without accepting intervening state changes. */
function parseShowing(data: Uint8Array, text: string, start: number, wrapped: boolean): Showing {
  const lexer = new PDFLexer(data, start);
  const whitespace = (byte: number) => [0, 9, 10, 12, 13, 32].includes(byte);
  const next = () => {
    while (whitespace(lexer.peek())) lexer.position++;
    const position = lexer.position;
    // The supported syntax excludes comments, so the lexer must not skip one.
    if (lexer.peek() === 0x25) refuse('comments in text arrays are unsupported');
    const token = lexer.nextToken();
    if (!token || token.offset !== position || lexer.position <= position || token.type === TokenType.EOF) {
      refuse('the text showing operand cannot be inspected');
    }
    return { token, raw: text.slice(position, lexer.position) };
  };
  const fragments: Uint8Array[] = [], adjustments: number[] = [];
  const addString = (raw: string) => {
    if (!literalToken.test(raw) && !hexToken.test(raw)) refuse('text encoding is unsupported');
    fragments.push(textBytes(raw));
  };
  for (let operations = 1; operations <= 1024; operations++) {
    const first = next();
    let array = false;
    if (first.token.type === TokenType.String || first.token.type === TokenType.HexString) addString(first.raw);
    else if (first.token.type === TokenType.Keyword && first.token.value === '[') {
      array = true;
      for (let count = 0; ; count++) {
        if (count > 1024) refuse('the text array exceeds the inspection limit');
        const item = next();
        if (item.token.type === TokenType.Keyword && item.token.value === ']') break;
        if (item.token.type === TokenType.String || item.token.type === TokenType.HexString) addString(item.raw);
        else if (item.token.type === TokenType.Integer || item.token.type === TokenType.Real) {
          if (!numberToken.test(item.raw) || typeof item.token.value !== 'number' || !Number.isFinite(item.token.value) ||
              Math.abs(item.token.value) > 100_000 || (!whitespace(lexer.peek()) && ![0x28, 0x3c, 0x5d].includes(lexer.peek()))) {
            refuse('text spacing is unsupported');
          }
          adjustments.push(item.token.value);
        } else refuse('text array entries are unsupported');
      }
    } else refuse('the text showing operand is unsupported');
    showOperator.lastIndex = lexer.position;
    const operator = showOperator.exec(text);
    if (!operator || operator[1] !== (array ? 'TJ' : 'Tj')) refuse('the text showing operator is unsupported');
    const endPattern = wrapped ? blockTail : bareBlockTail;
    endPattern.lastIndex = showOperator.lastIndex;
    if (endPattern.exec(text)) return { bytes: join(fragments), fragments, adjustments, operations, end: endPattern.lastIndex };
    lexer.position = showOperator.lastIndex;
  }
  return refuse('the text showing operations exceed the inspection limit');
}
function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (!needle.length || needle.length > bytes.length) return false;
  const prefix = new Uint32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j && needle[i] !== needle[j]) j = prefix[j - 1];
    if (needle[i] === needle[j]) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < bytes.length; i++) {
    while (j && bytes[i] !== needle[j]) j = prefix[j - 1];
    if (bytes[i] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}
function join(values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

/** Search both the writer's numeric spelling and its equivalent decimal form.
 * JavaScript may serialize very small or large finite numbers with an exponent. */
function numericSpellings(value: PDFNumber): string[] {
  if (!Number.isFinite(value.value)) refuse('a retained number cannot be inspected');
  const serialized = serializeToString(value);
  const canonical = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(canonical);
  if (!match) return [serialized, canonical];
  const digits = match[2] + (match[3] ?? '');
  const decimal = match[2].length + Number(match[4]);
  const expanded = decimal <= 0 ? `0.${'0'.repeat(-decimal)}${digits}`
    : decimal >= digits.length ? `${digits}${'0'.repeat(decimal - digits.length)}`
      : `${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
  return [serialized, canonical, `${match[1]}${expanded}`];
}
function retainedNumericTokens(bytes: Uint8Array): Uint8Array[] {
  const lexer = new PDFLexer(bytes), result: Uint8Array[] = [], encoder = new TextEncoder();
  while (true) {
    const token = lexer.nextToken();
    if (!token || token.type === TokenType.EOF) return result;
    if (token.type === TokenType.Integer || token.type === TokenType.Real) {
      if (typeof token.value !== 'number' || !Number.isFinite(token.value)) refuse('a retained number cannot be inspected');
      result.push(bytes.slice(token.offset, lexer.position));
      result.push(...numericSpellings(new PDFNumber(token.value)).map(spelling => encoder.encode(spelling)));
    }
  }
}
interface PageEdit { ref: PDFRef; output: Uint8Array }
interface Plan { edits: PageEdit[]; pages: number[]; removeRefs: Set<string>; annotations: number; removedText: number }

/** Verify every intermediate node as well as the complete cached leaf order. */
function verifyPageTree(doc: PDFDocumentData): void {
  assertCompletePageTree(doc, refuse);
  const root = doc.catalog.get('Pages');
  if (!(root instanceof PDFRef)) refuse('the page tree root cannot be verified');
  const pending: Array<{ ref: PDFRef; parent?: PDFDict; finish?: boolean; depth: number }> = [{ ref: root, depth: 0 }];
  const seen = new Set<PDFDict>(), counts = new Map<PDFDict, number>();
  while (pending.length) {
    const { ref, parent, finish, depth } = pending.pop()!;
    const node = doc.objects.get(ref.toKey());
    if (!(node instanceof PDFDict) || depth > 128) refuse('the page tree node cannot be verified');
    if (finish) {
      const kids = resolve(node.get('Kids'), doc);
      if (!(kids instanceof PDFArray)) refuse('the page tree children cannot be verified');
      let count = 0;
      for (const child of kids.items) {
        if (!(child instanceof PDFRef)) refuse('a page tree child is invalid');
        const value = doc.objects.get(child.toKey());
        if (!(value instanceof PDFDict) || !counts.has(value)) refuse('a page tree child cannot be verified');
        count += counts.get(value)!;
      }
      if (node.getNumber('Count') !== count) refuse('a page tree count is invalid');
      counts.set(node, count);
      continue;
    }
    if (seen.has(node) || seen.size >= 4096) refuse('the page tree is duplicated or exceeds the inspection limit');
    seen.add(node);
    if (parent && resolve(node.get('Parent'), doc) !== parent) refuse('a page tree parent is invalid');
    if (node.getName('Type') === 'Page' && parent) { counts.set(node, 1); continue; }
    if (node.getName('Type') !== 'Pages') refuse('a page tree node has an invalid type');
    onlyKeys(node, parent ? ['Type', 'Parent', 'Kids', 'Count', 'MediaBox', 'CropBox', 'Rotate']
      : ['Type', 'Kids', 'Count', 'MediaBox', 'CropBox', 'Rotate']);
    const kids = resolve(node.get('Kids'), doc);
    if (!(kids instanceof PDFArray) || kids.length + seen.size + pending.length > 4096) refuse('the page tree children cannot be verified');
    pending.push({ ref, parent, finish: true, depth });
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids.items[i];
      if (!(child instanceof PDFRef)) refuse('a page tree child is invalid');
      pending.push({ ref: child, parent: node, depth: depth + 1 });
    }
  }
  const rootNode = doc.objects.get(root.toKey());
  if (!(rootNode instanceof PDFDict) || counts.get(rootNode) !== doc.pages.length) refuse('the page tree count is invalid');
}

function plan(source: PDFDocumentData, options: SecureRedactionOptions): Plan {
  const hexBudget = { characters: 0, bytes: 0 };
  verifyPageTree(source);
  if (options.metadata === true || options.text === false || options.images === false || options.vectors === false ||
      options.annotations === false || options.formFields === false) refuse('the requested options cannot be honored');
  if (!source.pages.length || source.pages.length > 64 || source.decryptedFromEncrypted || source.xref.trailerDict.has('Encrypt') ||
      hasDocumentSignature(source)) refuse('only unsigned, unencrypted PDFs with at most 64 pages are supported');
  const doc = hydrateDocument(dehydrateDocument(source));
  const rootRef = doc.xref.trailerDict.getRef('Root');
  if (!rootRef || doc.objects.get(rootRef.toKey()) !== doc.catalog || doc.catalog.getName('Type') !== 'Catalog') refuse('the catalog cannot be verified');
  onlyKeys(doc.catalog, ['Type', 'Pages']);
  for (const key of doc.xref.trailerDict.keys()) if (!['Root', 'Info', 'ID', 'Size', 'Prev'].includes(key)) refuse('trailer data cannot be inspected');
  if (doc.xref.trailerDict.has('Info')) {
    const info = dictionary(doc.xref.trailerDict.get('Info'), doc);
    if (info.size) refuse('retained document information cannot be safely inspected');
  }
  const edits: PageEdit[] = [], pages: number[] = [], removed: Uint8Array[] = [], removedFragments: Uint8Array[] = [], survivingText: Uint8Array[] = [], survivingNumbers: Uint8Array[] = [];
  const markedPages = new Set<PDFDict>(), seenStreams = new Set<PDFStream>(), editedStreams = new Set<PDFStream>(), seenContentRefs = new Set<string>();
  const allMarks = new Set<PDFDict>(), sensitiveRefs = new Set<string>(), sensitiveValues = new Set<PDFObject>();
  // /Contents intermediates must survive annotation cleanup even when every
  // terminal stream is edited. In particular, an annotation can reference an
  // indirect array or alias that the page still needs to reach its new stream.
  const contentPathRefs = new Set<string>(), contentPathArrays = new Set<PDFArray>();
  const pendingSensitive: Array<{ value: PDFObject; isMark: boolean }> = [];
  let annotations = 0, decodedTotal = 0, blocksTotal = 0, removedOperators = 0;
  for (let index = 0; index < doc.pages.length; index++) {
    const page = doc.pages[index];
    if (doc.objects.get(page.ref.toKey()) !== page.dict || page.dict.getName('Type') !== 'Page') refuse('the page cannot be verified');
    onlyKeys(page.dict, ['Type', 'Parent', 'MediaBox', 'CropBox', 'Rotate', 'Resources', 'Contents', 'Annots', 'Tabs', 'UserUnit']);
    const rawAnnots = page.dict.get('Annots');
    const annots = rawAnnots === undefined ? undefined : resolve(rawAnnots, doc);
    if (annots !== undefined && !(annots instanceof PDFArray)) refuse('redaction annotations cannot be inspected');
    const annotationDicts = annots instanceof PDFArray ? annots.items.map(item => dictionary(item, doc)) : [];
    if (annotationDicts.some(item => !item.getName('Subtype'))) refuse('page annotations cannot be inspected');
    const marks = annotationDicts.filter(item => item.getName('Subtype') === 'Redact');
    if (marks.length) {
      if (!(annots instanceof PDFArray) || marks.length !== annots.length || marks.length > 64) refuse('only redaction annotations are supported');
      for (const mark of marks) {
        if (allMarks.has(mark) || (mark.has('P') && resolve(mark.get('P'), doc) !== page.dict)) refuse('redaction annotations are duplicated or refer to another page');
        allMarks.add(mark);
      }
      annotations += marks.length;
      markedPages.add(page.dict);
      pendingSensitive.push({ value: rawAnnots!, isMark: false });
    }
    const areas = marks.map(markArea), touched = areas.map(() => false);
    const rawContents = page.dict.get('Contents');
    if (rawContents === undefined) {
      if (marks.length || page.contentRefs.length) refuse('a marked page has no inspectable content');
      continue;
    }
    if (!page.dict.has('Resources') || resolve(page.dict.get('Resources'), doc) !== page.resources) refuse('page resources cannot be verified');
    onlyKeys(page.resources, ['Font']);
    const fonts = dictionary(page.resources.get('Font'), doc);
    if (!fonts.size || fonts.size > 64) refuse('font resources cannot be verified');
    for (const value of fonts.values()) {
      const font = dictionary(value, doc);
      onlyKeys(font, ['Type', 'Subtype', 'BaseFont', 'Encoding']);
      const baseFont = font.getName('BaseFont');
      if (font.getName('Type') !== 'Font' || font.getName('Subtype') !== 'Type1' || !baseFont || !LATIN_BASE_FONTS.has(baseFont) ||
          (font.has('Encoding') && font.getName('Encoding') !== 'WinAnsiEncoding')) refuse('only unmodified standard Latin base fonts are supported');
    }
    // Compare the cache against the resolved stream references. /Contents may
    // itself be an indirect array. References to reference objects are refused
    // because independent PDF readers do not consistently interpret them.
    let refs: PDFRef[];
    try { refs = inspectContentRefs(rawContents, doc.objects); }
    catch { return refuse('the page content references cannot be inspected'); }
    if (!refs.length || refs.length > 64 || seenContentRefs.size + refs.length > 4096 ||
        refs.length !== page.contentRefs.length || refs.some((value, i) =>
          !(page.contentRefs[i] instanceof PDFRef) || value.toKey() !== page.contentRefs[i].toKey())) {
      refuse('only independent canonical content streams are supported');
    }
    const paths: PDFObject[] = [rawContents];
    while (paths.length) {
      const value = paths.pop()!;
      if (value instanceof PDFRef) {
        const target = doc.objects.get(value.toKey());
        // inspectContentRefs already validated the complete path, including
        // cycles and missing objects, before this walk.
        if (!target) refuse('the page content references cannot be inspected');
        if (target instanceof PDFRef) refuse('indirect reference aliases in page content are unsupported');
        if (!(target instanceof PDFStream)) {
          if (contentPathRefs.has(value.toKey())) continue;
          contentPathRefs.add(value.toKey());
          if (contentPathRefs.size > 4096) refuse('content paths exceed the inspection limit');
          paths.push(target);
        }
      } else if (value instanceof PDFArray) {
        if (contentPathArrays.has(value)) continue;
        contentPathArrays.add(value);
        if (contentPathArrays.size > 4096) refuse('content paths exceed the inspection limit');
        paths.push(...value.items);
      }
    }
    let pageRemoved = 0, lastByte: number | undefined;
    for (const ref of refs) {
      if (seenContentRefs.has(ref.toKey())) refuse('content streams are shared or duplicated');
      const stream = doc.objects.get(ref.toKey());
      if (!(stream instanceof PDFStream) || stream.dict.has('DecodeParms') || seenStreams.has(stream)) refuse('the content stream cannot be inspected');
      seenContentRefs.add(ref.toKey());
      seenStreams.add(stream);
      onlyKeys(stream.dict, ['Length', 'Filter']);
      if (stream.dict.getNumber('Length') !== stream.rawBytes.length || stream.rawBytes.length > 1_048_576) refuse('the content stream length is invalid');
      const filter = stream.dict.get('Filter');
      let decoded: Uint8Array;
      if (filter === undefined) decoded = stream.rawBytes;
      else if (filter instanceof PDFName && ['FlateDecode', 'Fl'].includes(filter.name)) {
        try { decoded = decodeZlibFully(stream.rawBytes, 65_536); } catch { return refuse('compressed content cannot be verified'); }
      } else return refuse('the content filter is unsupported');
      decodedTotal += decoded.length;
      if (decoded.length > 65_536 || decodedTotal > 1_048_576 || (stream.decodedBytes &&
          (stream.decodedBytes.length !== decoded.length || stream.decodedBytes.some((value, i) => value !== decoded[i])))) refuse('content bytes differ from their cache or exceed the inspection limit');
      if (decoded.some(byte => byte > 0x7e || (byte < 0x20 && ![0, 9, 10, 12, 13].includes(byte)))) refuse('content bytes are unsupported');
      if (decoded.length) {
        const whitespace = (byte: number) => [0, 9, 10, 12, 13, 32].includes(byte);
        if (lastByte !== undefined && !whitespace(lastByte) && !whitespace(decoded[0])) refuse('content streams lack a safe boundary');
        lastByte = decoded[decoded.length - 1];
      }

      const text = new TextDecoder().decode(decoded), kept: Uint8Array[] = [];
      let position = 0, count = 0, streamRemoved = 0;
      while (position < text.length && !trailingWhitespace.test(text.slice(position))) {
        blockHeader.lastIndex = position;
        let match = blockHeader.exec(text);
        const wrapped = !!match;
        if (!match) { bareBlockHeader.lastIndex = position; match = bareBlockHeader.exec(text); }
        if (!match || ++count > 1024 || ++blocksTotal > 10_000) refuse('text operators or graphics state are unsupported');
        const showing = parseShowing(decoded, text, wrapped ? blockHeader.lastIndex : bareBlockHeader.lastIndex, wrapped);
        position = showing.end;
        if (!fonts.has(match[1].slice(1))) refuse('the text font is missing');
        if (match[3] !== undefined && (!decimalOne.test(match[3]) || !decimalZero.test(match[4]) ||
            !decimalZero.test(match[5]) || !decimalOne.test(match[6]))) refuse('text matrix transformations are unsupported');
        const size = Number(match[2]), x = Number(match[7] ?? match[9]), y = Number(match[8] ?? match[10]);
        const bytes = showing.bytes;
        if (!Number.isFinite(size) || size <= 0 || size > 1_000 || !Number.isFinite(x) || !Number.isFinite(y) ||
            Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 || !bytes.length || bytes.length > 512 ||
            bytes.some(byte => byte < 0x20 || byte > 0x7e || byte === 0x27 || byte === 0x60)) refuse('text encoding or positioning is unsupported');
        let displacement = 0, minDisplacement = 0, maxDisplacement = 0;
        for (const adjustment of showing.adjustments) {
          displacement -= adjustment * size / 1_000;
          if (!Number.isFinite(displacement) || Math.abs(displacement) > 1_000_000) refuse('text spacing exceeds the inspection limit');
          minDisplacement = Math.min(minDisplacement, displacement);
          maxDisplacement = Math.max(maxDisplacement, displacement);
        }
        // Standard-font glyphs and advances fit a 2em envelope. TJ may move
        // the origin in either direction, so account for every prefix shift.
        const target: Bounds = { minX: x + minDisplacement - 2 * size, minY: y - 2 * size,
          maxX: x + maxDisplacement + (2 * bytes.length + 2) * size, maxY: y + 2 * size };
        const overlap = areas.map((area, i) => intersects(area, target) ? i : -1).filter(i => i >= 0);
        if (overlap.length) {
          const margin = Math.max(1e-7, Math.max(...Object.values(target).map(Math.abs)) * 1e-12);
          const expanded = { minX: target.minX - margin, minY: target.minY - margin,
            maxX: target.maxX + margin, maxY: target.maxY + margin };
          if (!coversRectangle(overlap.map(i => areas[i]), expanded)) refuse('a text object only partially intersects a mark');
          for (const i of overlap) if (areaIntersects(areas[i], target)) touched[i] = true;
          if (removed.length >= 64) refuse('redacted text exceeds the inspection limit');
          removed.push(bytes);
          removedOperators += showing.operations;
          if (showing.fragments.length > 1) {
            for (const fragment of showing.fragments) if (fragment.length) {
              if (removedFragments.length >= 64) refuse('redacted text fragments exceed the inspection limit');
              removedFragments.push(fragment);
            }
          }
          pageRemoved++; streamRemoved++;
        } else {
          const retained = decoded.slice(match.index, position);
          kept.push(retained);
          survivingText.push(bytes);
          survivingNumbers.push(...retainedNumericTokens(retained));
        }
      }
      if (streamRemoved) {
        // Every replacement ends in whitespace, including an empty one, so
        // deleting blocks cannot splice neighboring stream tokens together.
        const output = join([...kept, new Uint8Array([10])]);
        sensitiveRefs.add(ref.toKey());
        sensitiveValues.add(stream);
        editedStreams.add(stream);
        edits.push({ ref, output });
        survivingNumbers.push(...numericSpellings(new PDFNumber(output.length)).map(spelling => new TextEncoder().encode(spelling)));
      } else {
        survivingNumbers.push(...numericSpellings(new PDFNumber(stream.rawBytes.length)).map(spelling => new TextEncoder().encode(spelling)));
        if (filter instanceof PDFName) survivingNumbers.push(new TextEncoder().encode(filter.name));
      }
    }
    if (marks.length) {
      if (!pageRemoved || touched.some(value => !value)) refuse('a mark does not fully cover supported text');
      pages.push(index);
    }
  }
  if (!edits.length) refuse('no supported redaction marks were found');

  // The old content and removed annotations must not be reachable elsewhere.
  while (pendingSensitive.length) {
    const { value, isMark } = pendingSensitive.pop()!;
    if (sensitiveValues.has(value)) continue;
    sensitiveValues.add(value);
    if (sensitiveValues.size > 4096) refuse('annotation data exceeds the inspection limit');
    if (value instanceof PDFRef) {
      sensitiveRefs.add(value.toKey());
      const next = doc.objects.get(value.toKey());
      if (!next) refuse('an annotation reference cannot be resolved');
      pendingSensitive.push({ value: next, isMark: allMarks.has(next as PDFDict) });
    } else if (value instanceof PDFArray) value.items.forEach(item => pendingSensitive.push({ value: item, isMark: allMarks.has(item as PDFDict) }));
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) if (!(isMark && key === 'P')) pendingSensitive.push({ value: child, isMark: allMarks.has(child as PDFDict) });
    } else if (value instanceof PDFStream) pendingSensitive.push({ value: value.dict, isMark: false });
  }
  if ([...contentPathRefs].some(ref => sensitiveRefs.has(ref)) ||
      [...contentPathArrays].some(array => sensitiveValues.has(array))) {
    refuse('removed annotation data is shared with a page content path');
  }
  const editedRefs = new Set(edits.map(edit => edit.ref.toKey()));
  if ([...seenContentRefs].some(ref => sensitiveRefs.has(ref) && !editedRefs.has(ref)) ||
      [...seenStreams].some(stream => sensitiveValues.has(stream) && !editedStreams.has(stream))) {
    refuse('removed annotation data is shared with retained content');
  }
  const comparable: Uint8Array[] = [...survivingText, join(survivingText), ...survivingNumbers];
  const pageDicts = new Set(doc.pages.map(page => page.dict));
  const seen = new Set<PDFObject>(), pending: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 4096 || sensitiveValues.has(value) || (value instanceof PDFRef && sensitiveRefs.has(value.toKey()))) refuse('removed data is shared with retained data');
    if (value instanceof PDFRef) {
      const next = doc.objects.get(value.toKey());
      if (!next) refuse('a retained reference cannot be resolved');
      pending.push(next);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        // Every page content stream has already been decoded and parsed above.
        // Annotation objects are skipped only when that page is being redacted.
        if (pageDicts.has(value) && (key === 'Contents' || (key === 'Annots' && markedPages.has(value)))) continue;
        comparable.push(new TextEncoder().encode(key));
        pending.push(child);
      }
    } else if (value instanceof PDFStream) refuse('retained streams cannot be safely inspected');
    else if (value instanceof PDFString) comparable.push(value.toBytes());
    else if (value instanceof PDFHexString) comparable.push(decodeStrictHexString(value.hex, hexBudget) ?? refuse('a retained hex string cannot be inspected'));
    else if (value instanceof PDFName) comparable.push(new TextEncoder().encode(value.name));
    else if (value instanceof PDFNumber) comparable.push(...numericSpellings(value).map(spelling => new TextEncoder().encode(spelling)));
    else if (!(value instanceof PDFBoolean)) refuse('retained data cannot be safely inspected');
  }
  const needles = [...removed, ...removedFragments, join(removed)].flatMap(secret => {
    const be = new Uint8Array(secret.length * 2), le = new Uint8Array(secret.length * 2);
    secret.forEach((byte, i) => { be[i * 2 + 1] = byte; le[i * 2] = byte; });
    return [secret, be, le];
  });
  if (comparable.reduce((length, value) => length + value.length, 0) > 131_072) refuse('retained data exceeds the inspection limit');
  comparable.push(join(comparable));
  if (needles.some(needle => comparable.some(value => contains(value, needle)))) refuse('retained data contains redacted text');
  if ([...allMarks].some(mark => !isBareRedactionMark(mark, editedRefs))) refuse('redaction annotation metadata cannot be inspected');
  for (const key of sensitiveRefs) doc.objects.delete(key);
  for (const edit of edits) {
    doc.objects.set(edit.ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(edit.output.length)]]), edit.output, edit.output));
  }
  for (const index of pages) doc.pages[index].dict.delete('Annots');
  assertRedactionRewriteSafe(doc, refuse);
  return { edits, pages, removeRefs: sensitiveRefs, annotations, removedText: removedOperators };
}

function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((value, i) => value === b[i]);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length || left.some((key, i) => key !== right[i])) return false;
  return left.every(key => sameSnapshot((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function prepareIsolatedTextRedaction(doc: PDFDocumentData, options: SecureRedactionOptions = {}): { commit(): SecureRedactionResult } {
  const selected = { ...options };
  plan(doc, selected);
  const snapshot = dehydrateDocument(doc);
  let committed = false;
  return {
    commit() {
      if (committed) throw new Error('The isolated text redaction was already committed.');
      if (!sameSnapshot(snapshot, dehydrateDocument(doc))) refuse('the document changed after redaction was prepared');
      const next = plan(doc, selected);
      for (const key of next.removeRefs) doc.objects.delete(key);
      for (const edit of next.edits) {
        doc.objects.set(edit.ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(edit.output.length)]]), edit.output, edit.output));
      }
      for (const index of next.pages) doc.pages[index].dict.delete('Annots');
      doc.requiresFullRewrite = true;
      committed = true;
      return { pagesProcessed: next.pages.length, textOperatorsRemoved: next.removedText, imageOperatorsRemoved: 0,
        pathOperatorsRemoved: 0, annotationsRemoved: next.annotations, formFieldsRemoved: 0, metadataStripped: false };
    },
  };
}
