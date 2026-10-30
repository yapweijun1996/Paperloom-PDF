import {
  PDFArray, PDFBoolean, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, PDFHexString,
  type PDFDocumentData, type PDFObject, type PDFPageInfo,
} from '../../types';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { hasFinalizedSignature } from '../../writer/save-pipeline';
import { decodeStrictHexString, isStrictHexString } from '../strict-hex-string';
import { PDFLexer, TokenType } from '../../parser/lexer';
import { serializeToString } from '../../editor/stream-compiler';
import type { SecureRedactionOptions, SecureRedactionResult } from '../types';
import { assertCompletePageTree } from '../validate-page-tree';
import { coversRectangle, type Bounds } from './rectangle-coverage';
import { assertRedactionRewriteSafe } from './rewrite-preflight';
import { parseContentStream } from '../../content/operator-lexer';
import { decodeZlibFully } from '../../parser/filters';
import { inspectContentRefs } from '../../parser/content-refs';
import { matchingStreamBytes, streamComparisonBudget } from './stream-comparison';

/** A request outside the narrowly supported, whole-page case. */
export class WholePageRedactionUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Secure whole-page redaction is unavailable: ${reason}. The document was not changed.`);
    this.name = 'WholePageRedactionUnsupportedError';
  }
}

function unsupported(reason: string): never {
  throw new WholePageRedactionUnsupportedError(reason);
}

function resolve(value: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key)) return undefined;
    seen.add(key);
    value = objects.get(key);
  }
  return value;
}

interface Reachability {
  refs: Set<string>;
  values: Set<PDFObject>;
  visits: number;
}

/** The viewer reads cached references; verify they describe the saved page. */
function assertContentCacheMatches(page: PDFPageInfo, doc: PDFDocumentData): void {
  let refs: PDFRef[];
  try { refs = inspectContentRefs(page.dict.get('Contents'), doc.objects); }
  catch { return unsupported('page contents cannot be safely inspected'); }
  if (!Array.isArray(page.contentRefs) || page.contentRefs.length !== refs.length ||
      refs.some((ref, i) => !(page.contentRefs[i] instanceof PDFRef) || page.contentRefs[i].toKey() !== ref.toKey())) {
    unsupported('cached page content differs from the page contents');
  }
}

// Include both references and their target containers; cap repeated walks as
// well as a single walk so an adversarial graph cannot monopolize the editor.
const MAX_REACHABILITY_WALK = 100_000;
const MAX_REACHABILITY_VISITS = 500_000;

/** Tracks indirect references and direct data-bearing containers independently. */
function collect(
  value: PDFObject | undefined,
  objects: Map<string, PDFObject>,
  result: Reachability,
  visited = new Set<PDFObject>(),
  skipPageBackRef = false,
  verifiedAnnotations?: Set<PDFDict>,
): void {
  if (!value) return;
  const pending: Array<{ value: PDFObject; skipPageBackRef: boolean }> = [{ value, skipPageBackRef }];
  while (pending.length) {
    if (pending.length > MAX_REACHABILITY_WALK) unsupported('object references exceed the inspection limit');
    const item = pending.pop()!;
    const current = item.value;
    if (visited.has(current)) continue;
    if (visited.size >= MAX_REACHABILITY_WALK || result.visits >= MAX_REACHABILITY_VISITS) {
      unsupported('object references exceed the inspection limit');
    }
    visited.add(current);
    result.visits++;
    if (current instanceof PDFRef) {
      const key = current.toKey();
      result.refs.add(key);
      const target = objects.get(key);
      if (!target) unsupported('an indirect reference could not be resolved');
      pending.push({ value: target, skipPageBackRef: item.skipPageBackRef });
    } else if (current instanceof PDFDict) {
      result.values.add(current);
      if (current.size + pending.length > MAX_REACHABILITY_WALK) unsupported('object references exceed the inspection limit');
      const entries = [...current.entries()];
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        if (!(key === 'P' && (item.skipPageBackRef || verifiedAnnotations?.has(current)))) pending.push({ value: child, skipPageBackRef: false });
      }
    } else if (current instanceof PDFArray) {
      result.values.add(current);
      if (current.length + pending.length > MAX_REACHABILITY_WALK) unsupported('object references exceed the inspection limit');
      for (let i = current.length - 1; i >= 0; i--) {
        pending.push({ value: current.items[i], skipPageBackRef: item.skipPageBackRef });
      }
    } else if (current instanceof PDFStream) {
      result.values.add(current);
      pending.push({ value: current.dict, skipPageBackRef: false });
    } else if (current instanceof PDFString || current instanceof PDFHexString) {
      result.values.add(current);
    }
  }
}

function hasSignatureDictionary(objects: Map<string, PDFObject>): boolean {
  const seen = new Set<PDFObject>();
  const pending = [...objects.values()];
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFRef) {
      const target = objects.get(value.toKey());
      if (target) pending.push(target);
    } else if (value instanceof PDFStream) pending.push(value.dict);
    else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      if (value.getName('Type') === 'Sig' || value.getName('FT') === 'Sig' ||
          (value.has('ByteRange') && value.has('Contents'))) return true;
      pending.push(...value.values());
    }
  }
  return false;
}

function numbers(value: PDFObject | undefined, length: number): number[] | null {
  if (!(value instanceof PDFArray) || value.length !== length) return null;
  const result: number[] = [];
  for (const item of value.items) {
    if (!(item instanceof PDFNumber) || !Number.isFinite(item.value)) return null;
    result.push(item.value);
  }
  return result;
}

/** Verify the actual page-tree path, not merely cached PDFPageInfo geometry. */
function effectivePageValues(page: PDFPageInfo, doc: PDFDocumentData): { box: number[]; resources?: PDFObject } {
  const root = resolve(doc.catalog.get('Pages'), doc.objects);
  if (!(root instanceof PDFDict) || root.getName('Type') !== 'Pages') unsupported('the page tree root is invalid');
  const visited = new Set<PDFDict>();
  let node = page.dict;
  let mediaBox: PDFObject | undefined;
  let resources: PDFObject | undefined;
  while (true) {
    if (visited.has(node)) unsupported('the page tree contains a cycle');
    visited.add(node);
    if (mediaBox === undefined && node.has('MediaBox')) mediaBox = node.get('MediaBox');
    if (resources === undefined && node.has('Resources')) resources = node.get('Resources');
    if (node === root) break;
    const parent = resolve(node.get('Parent'), doc.objects);
    if (!(parent instanceof PDFDict) || parent.getName('Type') !== 'Pages') unsupported('a page parent cannot be verified');
    const children = resolve(parent.get('Kids'), doc.objects);
    if (!(children instanceof PDFArray) || !children.items.some(child => resolve(child, doc.objects) === node)) {
      unsupported('a page does not belong to its declared parent');
    }
    node = parent;
  }
  const box = numbers(resolve(mediaBox, doc.objects), 4);
  if (!box) unsupported('the effective page MediaBox is invalid');
  const [x0, y0, x1, y1] = box;
  const expected = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  if (page.mediaBox.x !== expected.x || page.mediaBox.y !== expected.y ||
      page.mediaBox.width !== expected.width || page.mediaBox.height !== expected.height) {
    unsupported('cached page geometry differs from the page tree');
  }
  const resolvedResources = resources === undefined ? undefined : resolve(resources, doc.objects);
  if (resources !== undefined && (!(resolvedResources instanceof PDFDict) || resolvedResources !== page.resources)) {
    unsupported('cached page resources differ from the page tree');
  }
  if (resources === undefined && page.resources.size !== 0) unsupported('cached page resources differ from the page tree');
  return { box, resources };
}

function rectangle(values: number[]): Bounds {
  const box = { minX: Math.min(values[0], values[2]), minY: Math.min(values[1], values[3]),
    maxX: Math.max(values[0], values[2]), maxY: Math.max(values[1], values[3]) };
  if (!Object.values(box).every(Number.isFinite) || box.minX >= box.maxX || box.minY >= box.maxY) {
    unsupported('invalid geometry cannot cover the complete page');
  }
  return box;
}

function markedRectangle(mark: PDFDict): Bounds {
  const rect = numbers(mark.get('Rect'), 4);
  if (!rect) unsupported('invalid geometry cannot cover the complete page');
  const area = rectangle(rect);
  const quad = mark.get('QuadPoints');
  if (quad === undefined) return area;
  const points = numbers(quad, 8);
  if (!points) unsupported('invalid quadrilaterals cannot cover the complete page');
  const xs = [points[0], points[2], points[4], points[6]];
  const ys = [points[1], points[3], points[5], points[7]];
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Bounding boxes alone are insufficient for tilted or self-intersecting quads.
  const canonical = [minX, maxY, maxX, maxY, minX, minY, maxX, minY];
  if (!points.every((value, index) => value === canonical[index])) {
    unsupported('non-axis-aligned quadrilaterals cannot cover the complete page');
  }
  // Only the intersection is guaranteed marked when Rect and QuadPoints differ.
  const intersection = { minX: Math.max(area.minX, minX), minY: Math.max(area.minY, minY),
    maxX: Math.min(area.maxX, maxX), maxY: Math.min(area.maxY, maxY) };
  if (intersection.minX >= intersection.maxX || intersection.minY >= intersection.maxY) {
    unsupported('quadrilaterals do not cover the complete page');
  }
  return intersection;
}

const PAGE_KEYS = new Set([
  'Type', 'Parent', 'MediaBox', 'CropBox', 'Rotate', 'Resources', 'Contents',
  'Annots', 'Tabs', 'UserUnit',
]);

interface Plan {
  pages: number[];
  annotations: number;
  removeObjects: string[];
}

// This is an additional byte-pattern check, not text extraction or a proof
// that all copies are absent. PDF fonts can map the same glyphs to different
// bytes; images, forms and unsupported streams are deliberately not inferred.
const TEXT_SCAN_LIMIT = 65_536;
const TEXT_SCAN_TOTAL = 262_144;
const TEXT_SCAN_PATTERNS = 64;
const TEXT_SCAN_PAGES = 64;

function inspectableContent(value: PDFObject | undefined, objects: Map<string, PDFObject>): Uint8Array | undefined {
  const pending = value === undefined ? [] : [value];
  const seen = new Set<PDFObject>();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next) || seen.size >= 128) return undefined;
    seen.add(next);
    if (next instanceof PDFRef) {
      const target = objects.get(next.toKey());
      if (!target) return undefined;
      pending.push(target);
    } else if (next instanceof PDFArray) {
      for (let i = next.items.length - 1; i >= 0; i--) pending.push(next.items[i]);
    } else if (next instanceof PDFStream) {
      if (next.rawBytes.length > TEXT_SCAN_LIMIT || next.dict.getNumber('Length') !== next.rawBytes.length ||
          next.dict.has('DecodeParms')) return undefined;
      const filter = next.dict.get('Filter');
      let bytes: Uint8Array;
      if (filter === undefined) bytes = next.rawBytes;
      else if (filter instanceof PDFName && ['FlateDecode', 'Fl'].includes(filter.name)) {
        try { bytes = decodeZlibFully(next.rawBytes, TEXT_SCAN_LIMIT); } catch { return undefined; }
      } else return undefined;
      if (next.decodedBytes && (next.decodedBytes.length !== bytes.length ||
          next.decodedBytes.some((byte, index) => byte !== bytes[index]))) return undefined;
      total += bytes.length;
      if (total > TEXT_SCAN_LIMIT) return undefined;
      chunks.push(bytes);
    } else return undefined;
  }
  if (!chunks.length) return undefined;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Strictly inspect a small text/graphics content subset for annotation copies.
 * Unknown syntax is rejected; this is not a general PDF text extractor. */
function strictRetainedText(bytes: Uint8Array, fonts: Set<string>): Uint8Array[] {
  if (bytes.length > TEXT_SCAN_LIMIT || bytes.some(byte => byte > 0x7e || (byte < 0x20 && ![0, 9, 10, 12, 13].includes(byte)))) {
    unsupported('retained content cannot be inspected for annotation text');
  }
  const text = new TextDecoder().decode(bytes);
  const pattern = /[\x00\x09\x0a\x0c\x0d\x20]*(\/[A-Za-z_][A-Za-z0-9_.-]*|\((?:[^()\\\x00-\x1f]|\\(?:[()\\nrtbf]|[0-7]{1,3}))*\)|<[0-9A-Fa-f\x00\x09\x0a\x0c\x0d\x20]*>|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|[A-Za-z][A-Za-z0-9]*)(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/gy;
  const whitespace = /[\x00\x09\x0a\x0c\x0d\x20]*/y;
  const operands: string[] = [], shown: Uint8Array[] = [];
  const schema: Record<string, string[]> = {
    q: [], Q: [], BT: [], ET: [], Tf: ['name', 'number'], Td: ['number', 'number'], TD: ['number', 'number'],
    Tm: ['number', 'number', 'number', 'number', 'number', 'number'], Tj: ['string'], TL: ['number'],
    Tc: ['number'], Tw: ['number'], Tz: ['number'], Ts: ['number'], Tr: ['number'],
    cm: ['number', 'number', 'number', 'number', 'number', 'number'],
    g: ['number'], rg: ['number', 'number', 'number'], k: ['number', 'number', 'number', 'number'],
  };
  let pos = 0, depth = 0, inText = false, fontSelected = false, count = 0;
  while (pos < text.length) {
    whitespace.lastIndex = pos; whitespace.exec(text);
    if (whitespace.lastIndex === text.length) break;
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (!match || ++count > 4096) unsupported('retained content syntax cannot be inspected');
    pos = pattern.lastIndex;
    const word = match[1];
    if (!Object.hasOwn(schema, word)) {
      if (word.startsWith('/') || word.startsWith('(') || word.startsWith('<') || /^[-+.\d]/.test(word)) {
        operands.push(word); continue;
      }
      unsupported('retained content syntax cannot be inspected');
    }
    const expected = schema[word];
    const kind = (v: string) => v.startsWith('/') ? 'name' : v.startsWith('(') || v.startsWith('<') ? 'string' : 'number';
    if (operands.length !== expected.length || operands.some((v, i) => kind(v) !== expected[i] || (kind(v) === 'number' && !Number.isFinite(Number(v))))) {
      unsupported('retained content operands cannot be inspected');
    }
    for (const operand of operands) {
      const operandKind = kind(operand);
      if (operandKind === 'name') shown.push(new TextEncoder().encode(operand.slice(1)));
      else if (operandKind === 'number') shown.push(new TextEncoder().encode(operand));
    }
    if (word === 'q' && ++depth > 256) unsupported('retained content graphics state cannot be inspected');
    if (word === 'Q' && (--depth < 0 || inText)) unsupported('retained content graphics state cannot be inspected');
    if (word === 'BT') { if (inText) unsupported('retained content text state cannot be inspected'); inText = true; fontSelected = false; }
    if (word === 'ET') { if (!inText) unsupported('retained content text state cannot be inspected'); inText = false; }
    if (['Tf','Td','TD','Tm','Tj','TL','Tc','Tw','Tz','Ts','Tr'].includes(word) && !inText) unsupported('retained content text state cannot be inspected');
    if (word === 'Tf') {
      if (!fonts.has(operands[0].slice(1))) unsupported('retained content font cannot be inspected');
      fontSelected = true;
    }
    if (word === 'Tj') {
      if (!fontSelected) unsupported('retained content font cannot be inspected');
      const value = operands[0];
      // Include the actual operand encoding as well as the decoded string: a
      // hex or octal escape can itself retain fragments of annotation text.
      shown.push(new TextEncoder().encode(value.slice(1, -1)));
      let decoded: Uint8Array;
      if (value.startsWith('<')) decoded = decodeStrictHexString(value.slice(1, -1)) ?? unsupported('retained text cannot be inspected');
      else {
        const lexer = new PDFLexer(new TextEncoder().encode(value));
        const token = lexer.nextToken();
        if (!token || token.type !== TokenType.String || typeof token.value !== 'string' || !lexer.isEOF) unsupported('retained text cannot be inspected');
        decoded = Uint8Array.from(Array.from(token.value, char => char.charCodeAt(0)));
      }
      shown.push(decoded);
    }
    operands.length = 0;
  }
  if (depth || inText || operands.length) unsupported('retained content syntax cannot be inspected');
  return shown;
}

function shownTextBytes(bytes: Uint8Array): Uint8Array[] | undefined {
  try {
    const instructions = parseContentStream(bytes);
    if (instructions.length > 4096) return undefined;
    const found: Uint8Array[] = [];
    let pieces: Uint8Array[] | undefined;
    let length = 0;
    const add = (object: PDFObject): boolean => {
      if (object instanceof PDFString || object instanceof PDFHexString) {
        const part = object.toBytes();
        length += part.length;
        if (length > TEXT_SCAN_LIMIT || found.length >= TEXT_SCAN_PATTERNS) return false;
        pieces!.push(part);
        found.push(part);
        return true;
      }
      return object instanceof PDFNumber;
    };
    for (const inst of instructions) {
      if (inst.operator === 'BT') {
        if (pieces) return undefined;
        pieces = []; length = 0;
      } else if (inst.operator === 'ET') {
        if (!pieces) return undefined;
        const joined = new Uint8Array(length);
        let offset = 0;
        for (const piece of pieces) { joined.set(piece, offset); offset += piece.length; }
        found.push(joined);
        if (found.length > TEXT_SCAN_PATTERNS) return undefined;
        pieces = undefined;
      } else if (pieces && ['Tj', 'TJ', "'", '"'].includes(inst.operator)) {
        const operand = inst.operands[inst.operands.length - 1];
        const parts = inst.operator === 'TJ' && operand instanceof PDFArray ? operand.items : [operand];
        if (!parts.length || parts.some(part => !part || !add(part))) return undefined;
      }
    }
    return pieces ? undefined : found;
  } catch { return undefined; }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length > haystack.length) return false;
  const prefix = new Uint32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j && needle[i] !== needle[j]) j = prefix[j - 1];
    if (needle[i] === needle[j]) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < haystack.length; i++) {
    while (j && haystack[i] !== needle[j]) j = prefix[j - 1];
    if (haystack[i] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

function planWholePageRedaction(doc: PDFDocumentData, options: SecureRedactionOptions): Plan {
  assertCompletePageTree(doc, unsupported);
  if (options.metadata === true || options.text === false || options.images === false || options.vectors === false ||
      options.annotations === false || options.formFields === false) {
    unsupported('the requested options cannot be honored while clearing a whole page');
  }
  const root = doc.xref.trailerDict.getRef('Root');
  if (!root || doc.objects.get(root.toKey()) !== doc.catalog || doc.catalog.getName('Type') !== 'Catalog') {
    unsupported('the PDF catalog cannot be verified');
  }
  const draft = hydrateDocument(dehydrateDocument(doc));
  const sensitive: Reachability = { refs: new Set(), values: new Set(), visits: 0 };
  const markedText: Uint8Array[] = [];
  const annotationText: Uint8Array[] = [];
  const markedAnnotations = new Set<PDFDict>();
  let markedScanBytes = 0;
  let markedScanPages = 0;
  const pages: number[] = [];
  let annotations = 0;
  for (let i = 0; i < draft.pages.length; i++) {
    const page = draft.pages[i];
    if (draft.objects.get(page.ref.toKey()) !== page.dict) unsupported('a page is not backed by its canonical object');
    const annots = page.dict.get('Annots');
    if (!annots) continue;
    const array = resolve(annots, draft.objects);
    if (!(array instanceof PDFArray)) unsupported('page annotations cannot be inspected');
    const marks: { ref: PDFObject; dict: PDFDict }[] = [];
    const annotationDicts = new Set<PDFDict>();
    let duplicates = false;
    for (const item of array.items) {
      const dict = resolve(item, draft.objects);
      if (!(dict instanceof PDFDict) || !dict.getName('Subtype')) unsupported('page annotations cannot be inspected');
      if (annotationDicts.has(dict)) duplicates = true;
      annotationDicts.add(dict);
      if (dict.getName('Subtype') === 'Redact') marks.push({ ref: item, dict });
    }
    if (marks.length === 0) continue;
    if (duplicates) unsupported('redaction annotations are duplicated or exceed the inspection limit');
    for (const annotation of annotationDicts) {
      if (markedAnnotations.has(annotation)) unsupported('page annotations are shared');
      markedAnnotations.add(annotation);
    }
    if (array.length > 256) unsupported('page annotations exceed the inspection limit');
    if (marks.length > 64 || new Set(marks.map(mark => mark.dict)).size !== marks.length) {
      unsupported('redaction annotations are duplicated or exceed the inspection limit');
    }
    assertContentCacheMatches(page, draft);
    const effective = effectivePageValues(page, draft);
    const pageBounds = rectangle(effective.box);
    const areas = marks.map(mark => markedRectangle(mark.dict));
    if (!coversRectangle(areas, pageBounds)) unsupported('the marks do not cover the complete page');
    const textKeys = new Set(['Type', 'Subtype', 'Rect', 'P', 'Contents', 'T', 'Name', 'Open', 'F', 'C', 'M', 'NM', 'Popup']);
    const redactKeys = new Set(['Type', 'Subtype', 'Rect', 'QuadPoints', 'P', 'Contents', 'T', 'M', 'NM', 'OverlayText', 'Subj', 'CreationDate', 'Popup', 'F', 'C', 'IC', 'CA']);
    const popupKeys = new Set(['Type', 'Subtype', 'Rect', 'P', 'Parent', 'Open', 'F']);
    for (const annotation of annotationDicts) {
      const annotationPage = annotation.get('P');
      if (annotationPage !== undefined && resolve(annotationPage, draft.objects) !== page.dict) unsupported('an annotation refers to a different page');
      const subtype = annotation.getName('Subtype');
      if (subtype !== 'Redact' && subtype !== 'Text' && subtype !== 'Popup') unsupported('a marked page contains unsupported annotations or form fields');
      const permitted = subtype === 'Redact' ? redactKeys : subtype === 'Text' ? textKeys : popupKeys;
      if ([...annotation.keys()].some(key => !permitted.has(key))) unsupported('annotation features cannot be inspected');
      const rect = numbers(resolve(annotation.get('Rect'), draft.objects), 4);
      if (!rect) unsupported('other annotations have geometry that cannot be inspected');
      const bounds = rectangle(rect);
      if (subtype !== 'Redact' && (bounds.minX < pageBounds.minX || bounds.maxX > pageBounds.maxX ||
          bounds.minY < pageBounds.minY || bounds.maxY > pageBounds.maxY)) unsupported('an annotation extends beyond the page');
      if (subtype !== 'Popup') for (const key of subtype === 'Redact'
        ? ['Contents', 'T', 'M', 'NM', 'OverlayText', 'Subj', 'CreationDate'] : ['Contents', 'T', 'M', 'NM']) {
        const raw = annotation.get(key);
        if (raw === undefined) continue;
        const value = resolve(raw, draft.objects);
        if (!(value instanceof PDFString || value instanceof PDFHexString) ||
            (value instanceof PDFHexString && !isStrictHexString(value.hex))) unsupported('annotation text cannot be inspected');
        const rawLength = value instanceof PDFString ? value.value.length : value.hex.length;
        if (rawLength > 2048) unsupported('annotation text exceeds the inspection limit');
        const bytes = value instanceof PDFHexString ? decodeStrictHexString(value.hex) ?? unsupported('annotation text cannot be inspected') : value.toBytes();
        if (bytes.length && (bytes.length < 4 || bytes.length > 512 || bytes.some(byte => byte < 32 || byte > 126 || byte === 0x27 || byte === 0x60))) {
          unsupported('annotation text encoding cannot be inspected');
        }
        if (bytes.length) {
          if (annotationText.length >= TEXT_SCAN_PATTERNS) unsupported('annotation text exceeds the inspection limit');
          annotationText.push(bytes);
        }
      }
      if (annotation.has('Type') && annotation.getName('Type') !== 'Annot') unsupported('annotation type cannot be inspected');
      if (annotation.has('Open') && !(resolve(annotation.get('Open'), draft.objects) instanceof PDFBoolean)) unsupported('annotation state cannot be inspected');
      if (annotation.has('F')) {
        const flags = resolve(annotation.get('F'), draft.objects);
        if (!(flags instanceof PDFNumber) || !Number.isSafeInteger(flags.value) || flags.value < 0) unsupported('annotation flags cannot be inspected');
      }
      if (annotation.has('Name') && !['Comment', 'Key', 'Note', 'Help', 'NewParagraph', 'Paragraph', 'Insert'].includes(annotation.getName('Name') ?? '')) {
        unsupported('annotation icon cannot be inspected');
      }
      for (const key of ['C', 'IC']) if (annotation.has(key)) {
        const color = resolve(annotation.get(key), draft.objects);
        if (!(color instanceof PDFArray) || ![0, 1, 3, 4].includes(color.length) ||
            color.items.some(component => !(component instanceof PDFNumber) || !Number.isFinite(component.value) || component.value < 0 || component.value > 1)) {
          unsupported('annotation color cannot be inspected');
        }
      }
      if (annotation.has('CA')) {
        const opacity = resolve(annotation.get('CA'), draft.objects);
        if (!(opacity instanceof PDFNumber) || !Number.isFinite(opacity.value) || opacity.value < 0 || opacity.value > 1) unsupported('annotation opacity cannot be inspected');
      }
    }
    for (const annotation of annotationDicts) {
      if (annotation.getName('Subtype') === 'Popup') {
        const parent = resolve(annotation.get('Parent'), draft.objects);
        if (!(parent instanceof PDFDict) || !annotationDicts.has(parent) ||
            !['Text', 'Redact'].includes(parent.getName('Subtype') ?? '') ||
            resolve(parent.get('Popup'), draft.objects) !== annotation) unsupported('popup annotation relationship cannot be inspected');
      }
      if (annotation.has('Popup')) {
        const popup = resolve(annotation.get('Popup'), draft.objects);
        if (!(popup instanceof PDFDict) || !annotationDicts.has(popup) || popup.getName('Subtype') !== 'Popup' ||
            resolve(popup.get('Parent'), draft.objects) !== annotation) unsupported('popup annotation relationship cannot be inspected');
      }
    }
    for (const key of page.dict.keys()) if (!PAGE_KEYS.has(key)) unsupported(`page feature /${key} is not supported`);
    if (page.dict.getName('Type') !== 'Page') unsupported('the marked object is not a page');
    const cropBox = page.dict.get('CropBox');
    if (cropBox !== undefined && !numbers(resolve(cropBox, draft.objects), 4)) unsupported('the page CropBox is invalid');
    for (const key of ['Rotate', 'UserUnit'] as const) {
      const raw = page.dict.get(key);
      if (raw === undefined) continue;
      const number = resolve(raw, draft.objects);
      if (!(number instanceof PDFNumber) || !Number.isFinite(number.value) || (key === 'UserUnit' && number.value <= 0)) {
        unsupported(`the page /${key} value is invalid`);
      }
    }
    const tabs = page.dict.get('Tabs');
    if (tabs !== undefined && !['R', 'C', 'S'].includes(page.dict.getName('Tabs') ?? '')) unsupported('the page /Tabs value is invalid');
    pages.push(i);
    annotations += array.length;
    if (++markedScanPages > TEXT_SCAN_PAGES) unsupported('marked pages exceed the text inspection limit');
    const contents = page.dict.get('Contents');
    if (contents !== undefined && page.contentRefs.length) {
      const bytes = inspectableContent(contents, draft.objects);
      if (!bytes) unsupported('marked page text cannot be inspected');
      markedScanBytes += bytes.length;
      if (markedScanBytes > TEXT_SCAN_TOTAL) unsupported('marked page text exceeds the inspection limit');
      const shown = shownTextBytes(bytes);
      if (!shown || shown.length > TEXT_SCAN_PATTERNS - markedText.length) {
        unsupported('marked page text exceeds the inspection limit or cannot be inspected');
      }
      markedText.push(...shown);
    }
    collect(page.dict.get('Contents'), draft.objects, sensitive);
    collect(page.dict.get('Resources'), draft.objects, sensitive);
    collect(effective.resources, draft.objects, sensitive);
    collect(page.resources, draft.objects, sensitive);
    collect(annots, draft.objects, sensitive, new Set(), true, annotationDicts);
    // Empty resources override inherited /Resources; removing the entire stream
    // removes all paint, text, image and vector operators without geometry guesses.
    page.dict.delete('Contents');
    page.dict.delete('Annots');
    page.dict.set('Resources', new PDFDict());
  }
  if (pages.length === 0) return { pages, annotations, removeObjects: [] };
  for (const marked of pages) {
    const page = doc.pages[marked];
    if (doc.pages.some((other, i) => i !== marked &&
        (other.dict === page.dict || other.ref.toKey() === page.ref.toKey() || other.contentRefs === page.contentRefs))) {
      unsupported('page state is shared with another page');
    }
  }
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt')) unsupported('protected PDFs are not supported');
  if (hasFinalizedSignature(doc.rawBytes) || hasSignatureDictionary(doc.objects) || doc.catalog.has('AcroForm') || doc.catalog.has('Perms')) {
    unsupported('signed PDFs and interactive forms are not supported');
  }
  if (doc.catalog.has('StructTreeRoot')) unsupported('tagged PDF structure is not supported');
  const surviving: Reachability = { refs: new Set(), values: new Set(), visits: 0 };
  for (const key of ['Root', 'Info', 'ID'] as const) collect(draft.xref.trailerDict.get(key), draft.objects, surviving);
  // Rendering and later edits also use cached content/resource pointers. Do not
  // delete objects an unmarked page still refers to, even if its cache is stale.
  for (let i = 0; i < draft.pages.length; i++) {
    if (pages.includes(i)) continue;
    collect(draft.pages[i].resources, draft.objects, surviving);
    for (const ref of draft.pages[i].contentRefs) collect(ref, draft.objects, surviving);
  }
  if ([...sensitive.refs].some(key => surviving.refs.has(key)) ||
      [...sensitive.values].some(value => surviving.values.has(value))) {
    unsupported('removed page content or resources are shared with retained data');
  }
  // The writer escapes PDF names as bytes. Non-byte characters would be
  // emitted as ambiguous multi-digit escapes and decode differently on reopen.
  let retainedNameCharacters = 0;
  const validateName = (name: string) => {
    retainedNameCharacters += name.length;
    if (retainedNameCharacters > TEXT_SCAN_TOTAL) unsupported('retained names exceed the inspection limit');
    if (/[^\x00-\xff]/.test(name)) unsupported('retained names cannot be safely serialized');
  };
  for (const key of surviving.refs) {
    const value = draft.objects.get(key);
    if (value instanceof PDFName) validateName(value.name);
  }
  for (const value of surviving.values) {
    if (value instanceof PDFDict) for (const [key, child] of value.entries()) {
      validateName(key);
      if (child instanceof PDFName) validateName(child.name);
    }
    else if (value instanceof PDFArray) for (const child of value.items) {
      if (child instanceof PDFName) validateName(child.name);
    }
  }
  const removedStreams = [...sensitive.values].filter((value): value is PDFStream => value instanceof PDFStream);
  const retainedStreams = [...surviving.values].filter((value): value is PDFStream => value instanceof PDFStream);
  if (annotationText.length) {
    const annotationVariants = annotationText.flatMap(secret => {
      const be = new Uint8Array(secret.length * 2), le = new Uint8Array(secret.length * 2);
      secret.forEach((byte, i) => { be[i * 2 + 1] = byte; le[i * 2] = byte; });
      return [secret, be, le];
    });
    let bytesScanned = 0;
    const sensitiveBytes = new Set(annotationText.flatMap(secret => Array.from(secret)));
    const retainedSensitiveBytes = new Set<number>();
    const checkCopy = (bytes: Uint8Array, fragments = true) => {
      const candidates = bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))
        ? [bytes, bytes.subarray(2)] : [bytes];
      if (annotationVariants.some(secret => candidates.some(candidate => containsBytes(candidate, secret)))) {
        unsupported('retained data contains removed annotation text');
      }
      if (fragments) for (const byte of bytes) if (sensitiveBytes.has(byte)) retainedSensitiveBytes.add(byte);
    };
    const retainedStrings: Uint8Array[] = [];
    const scan = (text: string, fragments = true) => {
      if (text.length * 3 > TEXT_SCAN_TOTAL - bytesScanned) unsupported('retained annotation copy checks exceed the inspection limit');
      bytesScanned += text.length * 3;
      const bytes = new TextEncoder().encode(text);
      checkCopy(bytes, fragments);
    };
    const scanName = (name: string, fragments = true) => {
      scan(name, fragments);
      // Every byte can expand to #xx. Check the upper bound before creating
      // the serialized spelling and exclude its fixed slash delimiter.
      if ((name.length * 3) * 3 > TEXT_SCAN_TOTAL - bytesScanned) unsupported('retained annotation copy checks exceed the inspection limit');
      scan(serializeToString(new PDFName(name)).slice(1), fragments);
    };
    const textBytes = (value: PDFString | PDFHexString): Uint8Array => {
      const rawLength = value instanceof PDFString ? value.value.length : value.hex.length;
      const upperBound = value instanceof PDFString ? rawLength * 2 + 2 : rawLength;
      if (upperBound > TEXT_SCAN_TOTAL - bytesScanned) unsupported('retained annotation copy checks exceed the inspection limit');
      bytesScanned += upperBound;
      const bytes = value instanceof PDFHexString ? decodeStrictHexString(value.hex) ?? unsupported('retained text cannot be inspected') : value.toBytes();
      const maxSpelling = value instanceof PDFHexString ? rawLength : bytes.length * 4;
      if (maxSpelling * 3 > TEXT_SCAN_TOTAL - bytesScanned) unsupported('retained annotation copy checks exceed the inspection limit');
      // The outer string delimiters are fixed syntax, not stored data.
      scan(serializeToString(value).slice(1, -1));
      return bytes;
    };
    const structuralPages = new Set<PDFDict>([draft.catalog]);
    for (const page of draft.pages) {
      let node: PDFObject | undefined = page.dict;
      const seen = new Set<PDFDict>();
      while (node instanceof PDFDict && !seen.has(node)) {
        seen.add(node); structuralPages.add(node);
        node = resolve(node.get('Parent'), draft.objects);
      }
    }
    const information = resolve(draft.xref.trailerDict.get('Info'), draft.objects);
    const structuralAnnotations = new Set<PDFDict>();
    for (let i = 0; i < draft.pages.length; i++) {
      if (pages.includes(i)) continue;
      const page = draft.pages[i], raw = page.dict.get('Annots');
      if (raw === undefined) continue;
      const annotations = resolve(raw, draft.objects);
      if (!(annotations instanceof PDFArray) || annotations.length > 256) unsupported('retained annotations cannot be inspected');
      for (const item of annotations.items) {
        const annotation = resolve(item, draft.objects);
        if (!(annotation instanceof PDFDict) || !['Text', 'Popup'].includes(annotation.getName('Subtype') ?? '') ||
            (annotation.has('P') && resolve(annotation.get('P'), draft.objects) !== page.dict)) unsupported('retained annotations cannot be inspected');
        structuralAnnotations.add(annotation);
      }
    }
    const verifiedFonts = new Set<PDFDict>(), verifiedResources = new Set<PDFDict>();
    const pageStreams = new Map<PDFStream, Array<Set<string>>>();
    const standardFonts = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
      'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic']);
    for (let i = 0; i < draft.pages.length; i++) {
      if (pages.includes(i)) continue;
      const page = draft.pages[i];
      assertContentCacheMatches(page, draft);
      effectivePageValues(page, draft);
      verifiedResources.add(page.resources);
      const fontValue = page.resources.get('Font');
      const fonts = new Set<string>();
      if (fontValue !== undefined) {
        const fontDict = resolve(fontValue, draft.objects);
        if (!(fontDict instanceof PDFDict) || fontDict.size > 64) unsupported('retained content fonts cannot be inspected');
        for (const [name, raw] of fontDict.entries()) {
          const font = resolve(raw, draft.objects);
          if (!(font instanceof PDFDict) || [...font.keys()].some(key => !['Type', 'Subtype', 'BaseFont', 'Encoding'].includes(key)) ||
              font.getName('Type') !== 'Font' || font.getName('Subtype') !== 'Type1' || !standardFonts.has(font.getName('BaseFont') ?? '') ||
              (font.has('Encoding') && font.getName('Encoding') !== 'WinAnsiEncoding')) unsupported('retained content fonts cannot be inspected');
          verifiedFonts.add(font);
          fonts.add(name);
        }
      }
      for (const ref of page.contentRefs) {
        const stream = draft.objects.get(ref.toKey());
        if (!(stream instanceof PDFStream)) unsupported('retained page content cannot be inspected');
        const contexts = pageStreams.get(stream) ?? [];
        contexts.push(fonts);
        pageStreams.set(stream, contexts);
      }
    }
    const shown: Uint8Array[] = [];
    for (const stream of retainedStreams) {
      const contexts = pageStreams.get(stream);
      if (!contexts || stream.dict.has('Filter') || stream.dict.has('DecodeParms') ||
          stream.dict.getNumber('Length') !== stream.rawBytes.length || stream.rawBytes.length > TEXT_SCAN_LIMIT ||
          (stream.decodedBytes && (stream.decodedBytes.length !== stream.rawBytes.length ||
           stream.decodedBytes.some((byte, index) => byte !== stream.rawBytes[index])))) {
        unsupported('retained streams cannot be checked for annotation text');
      }
      for (const fonts of contexts) {
        bytesScanned += stream.rawBytes.length;
        if (bytesScanned > TEXT_SCAN_TOTAL) unsupported('retained annotation copy checks exceed the inspection limit');
        checkCopy(stream.rawBytes, false);
        const values = strictRetainedText(stream.rawBytes, fonts);
        values.forEach(value => checkCopy(value));
        shown.push(...values);
      }
    }
    const joined = new Uint8Array(shown.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of shown) { joined.set(part, offset); offset += part.length; }
    checkCopy(joined);
    for (const key of surviving.refs) {
      const value = draft.objects.get(key);
      if (value instanceof PDFName) scanName(value.name);
      else if (value instanceof PDFNumber) { scan(value.toString()); scan(serializeToString(value)); }
      else if (value instanceof PDFBoolean) scan(value.value ? 'true' : 'false');
      else if (value instanceof PDFNull) scan('null');
    }
    for (const value of surviving.values) {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        const bytes = textBytes(value);
        checkCopy(bytes);
        retainedStrings.push(bytes);
      } else if (value instanceof PDFDict) for (const [key, child] of value.entries()) {
        const structuralKey = (value === draft.catalog && ['Type', 'Pages'].includes(key)) ||
          (structuralPages.has(value) && value !== draft.catalog &&
            ['Type', 'Parent', 'Kids', 'Count', 'Resources', 'MediaBox', 'CropBox', 'Rotate', 'Contents', 'Annots'].includes(key)) ||
          (verifiedFonts.has(value) && ['Type', 'Subtype', 'BaseFont', 'Encoding'].includes(key)) ||
          (verifiedResources.has(value) && key === 'Font') ||
          (value === information && ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'].includes(key)) ||
          (structuralAnnotations.has(value) && ['Type', 'Subtype', 'Rect', 'P', 'Contents', 'T', 'Name', 'Open', 'F', 'C', 'M', 'NM', 'Popup', 'Parent'].includes(key));
        scanName(key, !structuralKey);
        if (child instanceof PDFName) {
          const structural = (key === 'Type' && structuralPages.has(value) && ['Catalog', 'Pages', 'Page'].includes(child.name)) ||
            (verifiedFonts.has(value) && ['Type', 'Subtype', 'BaseFont', 'Encoding'].includes(key)) ||
            (structuralAnnotations.has(value) && ((key === 'Type' && child.name === 'Annot') || (key === 'Subtype' && ['Text', 'Popup'].includes(child.name))));
          scanName(child.name, !structural);
        }
        else if (child instanceof PDFNumber) { scan(child.toString()); scan(serializeToString(child)); }
        else if (child instanceof PDFBoolean) scan(child.value ? 'true' : 'false');
        else if (child instanceof PDFNull) scan('null');
      } else if (value instanceof PDFArray) {
        let parts: Uint8Array[] = [], length = 0;
        const checkParts = () => {
          if (!length) return;
          const joinedParts = new Uint8Array(length);
          let position = 0;
          for (const part of parts) { joinedParts.set(part, position); position += part.length; }
          checkCopy(joinedParts);
          parts = []; length = 0;
        };
        for (const child of value.items) {
          const resolved = resolve(child, draft.objects);
          if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
            const part = textBytes(resolved);
            parts.push(part); length += part.length;
          } else {
            checkParts();
            if (resolved instanceof PDFName) scanName(resolved.name);
            else if (resolved instanceof PDFNumber) { scan(resolved.toString()); scan(serializeToString(resolved)); }
            else if (resolved instanceof PDFBoolean) scan(resolved.value ? 'true' : 'false');
            else if (resolved instanceof PDFNull) scan('null');
          }
        }
        checkParts();
      }
    }
    const joinedStrings = new Uint8Array(retainedStrings.reduce((sum, part) => sum + part.length, 0));
    let joinedOffset = 0;
    for (const part of retainedStrings) { joinedStrings.set(part, joinedOffset); joinedOffset += part.length; }
    checkCopy(joinedStrings);
    // Missing a byte rules out a byte-for-byte reconstruction from the
    // inspected data-bearing values, even if their fragments are reordered.
    if (annotationText.some(secret => secret.every(byte => retainedSensitiveBytes.has(byte)))) {
      unsupported('retained data contains removed annotation text');
    }
  }
  let retainedHexCharacters = 0;
  for (const value of surviving.values) if (value instanceof PDFHexString) {
    retainedHexCharacters += value.hex.length;
    if (retainedHexCharacters > TEXT_SCAN_TOTAL || !isStrictHexString(value.hex)) {
      unsupported('retained hex strings cannot be inspected');
    }
  }
  // Cached decoded bytes do not establish what a filtered survivor will save.
  // Reject opaque streams until their filters can be independently verified.
  if (removedStreams.some(stream => stream.rawBytes.length > 0 || (stream.decodedBytes?.length ?? 0) > 0) &&
      retainedStreams.some(stream => stream.dict.has('Filter') || stream.dict.has('DecodeParms'))) {
    unsupported('retained encoded streams cannot be checked for removed data');
  }
  const comparisonBudget = streamComparisonBudget();
  if (removedStreams.some(left => retainedStreams.some(right => matchingStreamBytes(left, right, comparisonBudget, unsupported)))) {
    unsupported('a retained stream duplicates removed data');
  }
  // Only search for unambiguous ASCII byte patterns of useful length. This
  // catches some independent copies, including UTF-16 strings, without assuming
  // that any PDF font's character codes describe Unicode text.
  const patterns = markedText.filter(bytes => bytes.length >= 4 && bytes.length <= 512 &&
    bytes.every(byte => byte >= 0x20 && byte <= 0x7e));
  const variants = patterns.flatMap(bytes => {
    const be = new Uint8Array(bytes.length * 2), le = new Uint8Array(bytes.length * 2);
    bytes.forEach((byte, index) => { be[index * 2 + 1] = byte; le[index * 2] = byte; });
    return [bytes, be, le];
  });
  if (variants.length) {
    const candidates: Uint8Array[] = [];
    const retainedStringBytes = new Set<number>();
    let size = 0;
    const add = (bytes: Uint8Array) => {
      if (size + bytes.length > TEXT_SCAN_TOTAL) unsupported('retained text checks exceed the inspection limit');
      size += bytes.length; candidates.push(bytes);
    };
    for (const value of surviving.values) {
      if (!(value instanceof PDFString || value instanceof PDFHexString)) continue;
      // Do not silently skip later strings when the bounded inspection fills up:
      // those fields could hold the remaining fragments of a removed value.
      const rawLength = value instanceof PDFString ? value.value.length : Math.ceil(value.hex.length / 2);
      if (rawLength > TEXT_SCAN_TOTAL - size) unsupported('retained text checks exceed the inspection limit');
      const bytes = value.toBytes();
      if (bytes.length > TEXT_SCAN_TOTAL - size) unsupported('retained text checks exceed the inspection limit');
      add(bytes);
      for (const byte of bytes) retainedStringBytes.add(byte);
    }
    // A missing byte rules out reconstruction from the inspected strings,
    // even when fragments are separated or reordered. This conservative test
    // can reject unrelated metadata whose combined bytes cover the pattern.
    if (patterns.some(secret => secret.every(byte => retainedStringBytes.has(byte)))) {
      unsupported('retained data contains removed text bytes');
    }
    let pageBytes = 0, scannedPages = 0;
    for (let i = 0; i < draft.pages.length; i++) {
      if (pages.includes(i)) continue;
      const page = draft.pages[i];
      // Empty pages have no content to inspect and need not consume the page
      // budget. The content cache was verified when the page graph was read.
      assertContentCacheMatches(page, draft);
      if (!page.contentRefs.length) continue;
      if (scannedPages++ >= TEXT_SCAN_PAGES) unsupported('retained pages exceed the text inspection limit');
      const bytes = inspectableContent(page.dict.get('Contents'), draft.objects);
      if (!bytes) unsupported('retained page text cannot be inspected');
      pageBytes += bytes.length;
      if (pageBytes > TEXT_SCAN_TOTAL) unsupported('retained page text exceeds the inspection limit');
      add(bytes);
      const shown = shownTextBytes(bytes);
      if (!shown) unsupported('retained page text cannot be inspected');
      for (const value of shown) add(value);
    }
    if (variants.some(needle => candidates.some(candidate => containsBytes(candidate, needle)))) {
      unsupported('retained data contains removed text bytes');
    }
  }
  for (const key of sensitive.refs) draft.objects.delete(key);
  assertRedactionRewriteSafe(draft, unsupported);
  return { pages, annotations, removeObjects: [...sensitive.refs] };
}

/** Compare a frozen worker snapshot with the current graph, including stream
 * and original bytes, so a delayed commit cannot erase intervening edits. */
function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a);
  const right = Object.keys(b);
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return left.every(key => sameSnapshot(x[key], y[key]));
}

/**
 * Prepare without mutation. Commit rechecks the current document synchronously,
 * then publishes all pages together and forces future full-rewrite output.
 * This supports only a mark covering the full page; it is not area redaction.
 * It removes the marked page's associated data. Bounded checks detect some
 * independent copies, but cannot prove their absence in arbitrary PDF data.
 */
export function prepareWholePageRedaction(
  doc: PDFDocumentData,
  options: SecureRedactionOptions = {},
): { commit(): SecureRedactionResult & { pagesCleared: number } } {
  const selectedOptions = { ...options };
  planWholePageRedaction(doc, selectedOptions);
  const snapshot = dehydrateDocument(doc);
  let committed = false;
  return {
    commit() {
      if (committed) throw new Error('The whole-page redaction was already committed.');
      if (!sameSnapshot(snapshot, dehydrateDocument(doc))) {
        unsupported('the document changed after the redaction was prepared');
      }
      const plan = planWholePageRedaction(doc, selectedOptions);
      for (const index of plan.pages) {
        const page = doc.pages[index];
        page.dict.delete('Contents');
        page.dict.delete('Annots');
        const empty = new PDFDict();
        page.dict.set('Resources', empty);
        page.resources = empty;
        page.contentRefs.splice(0);
      }
      for (const key of plan.removeObjects) doc.objects.delete(key);
      if (plan.pages.length) doc.requiresFullRewrite = true;
      committed = true;
      // Streams are discarded as a whole; no claim is made about the number
      // of individual operators they previously contained.
      return { pagesProcessed: plan.pages.length, pagesCleared: plan.pages.length,
        textOperatorsRemoved: 0, imageOperatorsRemoved: 0, pathOperatorsRemoved: 0,
        annotationsRemoved: plan.annotations, formFieldsRemoved: 0, metadataStripped: false };
    },
  };
}
