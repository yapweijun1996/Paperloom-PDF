/**
 * Glyph-level secure redaction for ordinary PDFs (browser, Word and similar
 * producers): embedded simple fonts, Type0 fonts, any text or graphics matrix.
 *
 * Every glyph that touches a redaction mark is removed from its show operator
 * and replaced by a TJ advance, so the rest of the line keeps its position.
 * Drawings fully inside a mark are removed; drawings that pass through it
 * (rules, cell fills, backgrounds) are kept; any other overlap is refused.
 *
 * The rewrite is accepted only if, on a detached copy:
 * - no glyph touches a mark and every other glyph is unchanged, and
 * - the removed text (4 or more non-space characters per mark) appears
 *   nowhere else in the file: page text, strings, names, numbers, metadata
 *   or other decodable streams.
 * Otherwise the document is not changed.
 *
 * Refused: encrypted, signed or interactive-form files, optional content,
 * marks without text, marks over images, shadings or Form XObjects, other
 * annotations under a mark, ActualText spans, Type3 or vertical fonts,
 * clipping text modes, and streams whose filters cannot be fully decoded.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject, type PDFPageInfo } from '../../types';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { getPageContentBytes } from '../../parser/parser';
import { decodeZlibFully } from '../../parser/filters';
import { parseContentStream, type CSInstruction } from '../../content/operator-lexer';
import { interpretPage, type GlyphPosition, type TextRun } from '../../content/interpreter';
import { compileInstructions } from '../../editor/text-editor';
import { hasFinalizedSignature } from '../../writer/save-pipeline';
import { inspectContentRefs } from '../../parser/content-refs';
import { assertCompletePageTree } from '../validate-page-tree';
import { assertRedactionRewriteSafe } from './rewrite-preflight';
import { isBareRedactionMark } from './bare-redaction-mark';
import { hasSignatureDictionary } from './partial-graphics-redaction';
import { numericSpellings } from './isolated-text-redaction';
import type { SecureRedactionOptions, SecureRedactionResult } from '../types';

export class GlyphRedactionUnsupportedError extends Error {
  /** False when the file is outside this strategy's scope, so an earlier strategy's reason is more useful. */
  constructor(reason: string, readonly applicable = true) {
    super(`Secure redaction is unavailable: ${reason}. The document was not changed.`);
    this.name = 'GlyphRedactionUnsupportedError';
  }
}
function refuse(reason: string): never { throw new GlyphRedactionUnsupportedError(reason); }
function outOfScope(reason: string): never { throw new GlyphRedactionUnsupportedError(reason, false); }

interface Box { minX: number; minY: number; maxX: number; maxY: number }

const SHOW_OPERATORS = new Set(['Tj', 'TJ', "'", '"']);
const PATH_CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
/** Retained position drift allowed after rewriting, in points. */
const POSITION_TOLERANCE = 0.01;
/** Shorter removed text is too common to search for copies of. */
const MIN_NEEDLE_LENGTH = 4;
/** Shorter numeric needles must equal a number; longer ones may be part of one. */
const MIN_NUMERIC_SUBSTRING_LENGTH = 7;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_VISITS = 1_000_000;
const FONT_FILE_KEYS = new Set(['FontFile', 'FontFile2', 'FontFile3']);

function resolve(value: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  for (let depth = 0; value instanceof PDFRef; depth++) {
    if (depth > 32) refuse('a reference is too deep');
    value = objects.get(value.toKey());
  }
  return value;
}

function overlaps(a: Box, b: Box): boolean {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxY > b.minY && a.minY < b.maxY;
}
function inside(inner: Box, outer: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}
/** A rule, cell fill or background that runs right across the mark on one axis. */
function passesThrough(path: Box, mark: Box): boolean {
  return (path.minX < mark.minX && path.maxX > mark.maxX) || (path.minY < mark.minY && path.maxY > mark.maxY);
}

function rectBox(value: PDFObject | undefined): Box | null {
  if (!(value instanceof PDFArray) || value.length !== 4 || !value.items.every(item => item instanceof PDFNumber && Number.isFinite(item.value))) return null;
  const [x1, y1, x2, y2] = value.items.map(item => (item as PDFNumber).value);
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

function markBox(mark: PDFDict): Box {
  const box = rectBox(mark.get('Rect'));
  if (!box || box.maxX <= box.minX || box.maxY <= box.minY) refuse('a redaction mark has no valid rectangle');
  return box;
}

type Extent = [descent: number, ascent: number];
const DEFAULT_EXTENT: Extent = [-0.2, 0.8];

/** The font's vertical extent in em from its FontDescriptor, within sane bounds. */
function fontExtent(font: PDFDict | undefined, objects: Map<string, PDFObject>): Extent {
  if (!font) return DEFAULT_EXTENT;
  let descriptorOwner: PDFObject | undefined = font;
  const descendants = resolve(font.get('DescendantFonts'), objects);
  if (descendants instanceof PDFArray) descriptorOwner = resolve(descendants.get(0), objects);
  const descriptor = descriptorOwner instanceof PDFDict ? resolve(descriptorOwner.get('FontDescriptor'), objects) : undefined;
  if (!(descriptor instanceof PDFDict)) return DEFAULT_EXTENT;
  const ascent = descriptor.getNumber('Ascent'), descent = descriptor.getNumber('Descent');
  return [
    descent !== undefined && Number.isFinite(descent) ? Math.min(0, Math.max(-0.5, descent / 1000)) : DEFAULT_EXTENT[0],
    ascent !== undefined && Number.isFinite(ascent) ? Math.max(0.5, Math.min(1.2, ascent / 1000)) : DEFAULT_EXTENT[1],
  ];
}

/** The glyph's box from descent to ascent, in page space. */
export function glyphBox(glyph: GlyphPosition, [descent, ascent]: Extent = DEFAULT_EXTENT): Box {
  const { a, b, c, d, e, f } = glyph.tRm;
  const width = Math.max(glyph.textSpaceWidth, 0.1);
  const corners = [[0, descent], [width, descent], [0, ascent], [width, ascent]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  return {
    minX: Math.min(...corners.map(p => p[0])), maxX: Math.max(...corners.map(p => p[0])),
    minY: Math.min(...corners.map(p => p[1])), maxY: Math.max(...corners.map(p => p[1])),
  };
}

function formBox(name: string, ctm: { a: number; b: number; c: number; d: number; e: number; f: number }, resources: PDFDict, objects: Map<string, PDFObject>): Box | null {
  const xobjects = resolve(resources.get('XObject'), objects);
  const form = xobjects instanceof PDFDict ? resolve(xobjects.get(name), objects) : undefined;
  if (!(form instanceof PDFStream)) return null;
  const bbox = rectBox(form.dict.get('BBox'));
  const matrix = form.dict.get('Matrix');
  const m = matrix instanceof PDFArray && matrix.length === 6 ? matrix.items.map(item => item instanceof PDFNumber ? item.value : NaN) : [1, 0, 0, 1, 0, 0];
  if (!bbox || !m.every(Number.isFinite)) return null;
  const points = [[bbox.minX, bbox.minY], [bbox.maxX, bbox.minY], [bbox.minX, bbox.maxY], [bbox.maxX, bbox.maxY]].map(([x, y]) => {
    const fx = m[0] * x + m[2] * y + m[4], fy = m[1] * x + m[3] * y + m[5];
    return [ctm.a * fx + ctm.c * fy + ctm.e, ctm.b * fx + ctm.d * fy + ctm.f];
  });
  return {
    minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
    minY: Math.min(...points.map(p => p[1])), maxY: Math.max(...points.map(p => p[1])),
  };
}

function stringBytes(value: PDFObject | undefined): Uint8Array {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.toBytes();
  return refuse('a text operand cannot be inspected');
}
function hex(bytes: Uint8Array): PDFHexString {
  return new PDFHexString(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''));
}

/** Rebuild one string as TJ items: kept byte runs, and an advance for each removed glyph. */
function splitString(bytes: Uint8Array, removed: GlyphPosition[], items: PDFObject[]): void {
  const sorted = [...removed].sort((x, y) => x.source!.byteStart - y.source!.byteStart);
  let at = 0;
  const pushNumber = (value: number) => {
    const last = items[items.length - 1];
    if (last instanceof PDFNumber) items[items.length - 1] = new PDFNumber(last.value + value);
    else items.push(new PDFNumber(value));
  };
  for (const glyph of sorted) {
    const { byteStart, byteLength, advance, textFontSize } = glyph.source!;
    if (byteStart < at) refuse('glyph bytes overlap');
    if (byteStart > at) items.push(hex(bytes.subarray(at, byteStart)));
    // A TJ number moves by -n/1000·Tfs·Th; the glyph moved by advance·Th.
    pushNumber(-1000 * advance / textFontSize);
    at = byteStart + byteLength;
  }
  if (at > bytes.length) refuse('glyph bytes exceed their string');
  if (at < bytes.length) items.push(hex(bytes.subarray(at)));
}

/** Replace a show instruction with the same show minus `removed` glyphs. */
function rewriteShow(instruction: CSInstruction, removed: GlyphPosition[]): CSInstruction[] {
  const op = (operator: string, operands: PDFObject[] = []): CSInstruction => ({ operator, operands, offset: 0 });
  const byItem = new Map<number, GlyphPosition[]>();
  for (const glyph of removed) byItem.set(glyph.source!.item, [...(byItem.get(glyph.source!.item) ?? []), glyph]);
  const items: PDFObject[] = [];
  const operands = instruction.operands;
  if (instruction.operator === 'TJ') {
    const array = operands[0];
    if (!(array instanceof PDFArray)) refuse('a TJ operand cannot be inspected');
    array.items.forEach((item, index) => {
      if (item instanceof PDFNumber) {
        const last = items[items.length - 1];
        if (last instanceof PDFNumber) items[items.length - 1] = new PDFNumber(last.value + item.value);
        else items.push(item);
      } else if (byItem.has(index)) splitString(stringBytes(item), byItem.get(index)!, items);
      else items.push(item);
    });
    return [op('TJ', [new PDFArray(items)])];
  }
  if ([...byItem.keys()].some(item => item !== -1)) refuse('glyph sources do not match their operator');
  const string = instruction.operator === '"' ? operands[2] : operands[0];
  splitString(stringBytes(string), byItem.get(-1) ?? [], items);
  const show = op('TJ', [new PDFArray(items)]);
  if (instruction.operator === 'Tj') return [show];
  if (instruction.operator === "'") return [op('T*'), show];
  return [op('Tw', [operands[0]]), op('Tc', [operands[1]]), op('T*'), show];
}

/** Same multiset of glyphs: equal codes at positions within the tolerance. */
function sameGlyphs(expected: GlyphPosition[], actual: GlyphPosition[]): boolean {
  if (expected.length !== actual.length) return false;
  const byCode = new Map<number, GlyphPosition[]>();
  for (const glyph of actual) byCode.set(glyph.charCode, [...(byCode.get(glyph.charCode) ?? []), glyph]);
  for (const glyph of expected) {
    const candidates = byCode.get(glyph.charCode) ?? [];
    const at = candidates.findIndex(other => Math.abs(other.tRm.e - glyph.tRm.e) <= POSITION_TOLERANCE &&
      Math.abs(other.tRm.f - glyph.tRm.f) <= POSITION_TOLERANCE);
    if (at < 0) return false;
    candidates.splice(at, 1);
  }
  return true;
}

/** Real glyphs in content order; synthetic glyphs (no source) are skipped. */
function sourceGlyphs(runs: readonly TextRun[]): Array<{ glyph: GlyphPosition; run: TextRun }> {
  const seen = new Set<GlyphPosition>();
  const result: Array<{ glyph: GlyphPosition; run: TextRun }> = [];
  for (const run of runs) for (const glyph of run.glyphs) {
    if (seen.has(glyph) || !glyph.source) continue;
    seen.add(glyph);
    result.push({ glyph, run });
  }
  return result.sort((x, y) => x.glyph.source!.instruction - y.glyph.source!.instruction ||
    x.glyph.source!.item - y.glyph.source!.item || x.glyph.source!.byteStart - y.glyph.source!.byteStart);
}

interface PagePlan { index: number; output: Uint8Array; marks: Set<PDFDict>; glyphs: number; paths: number; needles: string[] }

function planPage(doc: PDFDocumentData, index: number, marks: PDFDict[]): PagePlan {
  const page = doc.pages[index];
  const areas = marks.map(markBox);
  const content = getPageContentBytes(page, doc.objects);
  const instructions = parseContentStream(content);
  const result = interpretPage(content, page, doc.objects);

  const fontDicts = resolve(page.resources.get('Font'), doc.objects);
  const fontDict = (name: string) => {
    const font = fontDicts instanceof PDFDict ? resolve(fontDicts.get(name), doc.objects) : undefined;
    return font instanceof PDFDict ? font : undefined;
  };
  const extents = new Map<string, Extent>();
  const extentOf = (name: string) => {
    if (!extents.has(name)) extents.set(name, fontExtent(fontDict(name), doc.objects));
    return extents.get(name)!;
  };
  // Fonts whose glyph geometry this strategy cannot trust.
  const unsafeFont = (name: string) => {
    const font = fontDict(name);
    if (!font || font.getName('Subtype') === 'Type3') return true;
    const encoding = font.get('Encoding');
    return encoding instanceof PDFName ? /-V$/.test(encoding.name) : font.getName('Subtype') === 'Type0';
  };

  const removedByInstruction = new Map<number, GlyphPosition[]>();
  const removedByMark = areas.map(() => [] as GlyphPosition[]);
  const original: GlyphPosition[] = [];
  const actualTextRanges = result.actualTextSpans ?? [];
  for (const { glyph, run } of sourceGlyphs(result.textRuns)) {
    original.push(glyph);
    const box = glyphBox(glyph, extentOf(run.fontName));
    const hits = areas.map(area => overlaps(box, area));
    if (!hits.includes(true)) continue;
    const instruction = glyph.source!.instruction;
    if (run.actualText || actualTextRanges.some(span => instruction >= span.start && instruction < span.end)) {
      refuse('text with replacement text (ActualText) under a mark is unsupported');
    }
    if (run.renderingMode !== undefined && run.renderingMode >= 4) refuse('clipping text under a mark is unsupported');
    if (unsafeFont(run.fontName)) refuse('Type3 or vertical fonts under a mark are unsupported');
    if (!(glyph.source!.textFontSize > 0) || !SHOW_OPERATORS.has(instructions[instruction]?.operator)) {
      refuse('text under a mark cannot be located');
    }
    removedByInstruction.set(instruction, [...(removedByInstruction.get(instruction) ?? []), glyph]);
    hits.forEach((hit, at) => { if (hit) removedByMark[at].push(glyph); });
  }
  if (removedByMark.some(list => list.length === 0)) outOfScope('a redaction mark does not cover any text');

  const removedPaths: Array<[number, number]> = [];
  for (const item of result.displayList) {
    if (item.type === 'image' || item.type === 'inline-image') {
      const box = { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
      if (areas.some(area => overlaps(box, area))) refuse('an image under a mark is unsupported');
    } else if (item.type === 'shading') {
      refuse('shadings on a marked page are unsupported');
    } else if (item.type === 'form') {
      const box = formBox(item.name, item.ctm, page.resources, doc.objects);
      if (!box || areas.some(area => overlaps(box, area))) refuse('a form XObject under a mark is unsupported');
    } else if (item.type === 'path' && item.paintType !== 'none' && item.sourceInstructionIndex !== undefined) {
      const box = { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
      const touched = areas.filter(area => overlaps(box, area));
      if (!touched.length) continue;
      if (touched.some(area => inside(box, area))) {
        let start = item.sourceInstructionIndex;
        while (start > 0 && PATH_CONSTRUCTION.has(instructions[start - 1].operator)) start--;
        removedPaths.push([start, item.sourceInstructionIndex]);
      } else if (!touched.every(area => passesThrough(box, area))) {
        refuse('a drawing is only partly under a mark; enlarge the mark to cover it or delete the drawing first');
      }
    }
  }

  // Rewrite from the end so earlier indices stay valid.
  const edits = [
    ...[...removedByInstruction].map(([at, glyphs]) => ({ start: at, end: at, replacement: rewriteShow(instructions[at], glyphs) })),
    ...removedPaths.map(([start, end]) => ({ start, end, replacement: [] as CSInstruction[] })),
  ].sort((x, y) => y.start - x.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].end >= edits[i - 1].start) refuse('removed operators overlap');
  for (const edit of edits) instructions.splice(edit.start, edit.end - edit.start + 1, ...edit.replacement);
  const output = compileInstructions(instructions);

  // Accept only if no glyph touches a mark and every other glyph is where it was.
  const kept: GlyphPosition[] = [];
  for (const { glyph, run } of sourceGlyphs(interpretPage(output, page, doc.objects).textRuns)) {
    if (areas.some(area => overlaps(glyphBox(glyph, extentOf(run.fontName)), area))) refuse('text under a mark survived the rewrite');
    kept.push(glyph);
  }
  const removed = new Set([...removedByInstruction.values()].flat());
  if (!sameGlyphs(original.filter(glyph => !removed.has(glyph)), kept)) {
    refuse('the rewritten page did not keep the remaining text in place');
  }

  const needles = removedByMark.map(list => list.map(glyph => glyph.unicode).join(''));
  return { index, output, marks: new Set(marks), glyphs: removed.size, paths: removedPaths.length, needles };
}

function plan(doc: PDFDocumentData, options: SecureRedactionOptions): PagePlan[] {
  if (options.metadata === true || options.text === false || options.images === false || options.vectors === false ||
      options.annotations === false || options.formFields === false) outOfScope('the requested options cannot be honored');
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt')) outOfScope('encrypted PDFs are not supported');
  if (hasFinalizedSignature(doc.rawBytes) || hasSignatureDictionary(doc.objects) || doc.catalog.has('AcroForm') || doc.catalog.has('Perms')) {
    outOfScope('signed PDFs and interactive forms are not supported');
  }
  if (doc.catalog.has('OCProperties')) outOfScope('PDFs with optional content are not supported');
  assertCompletePageTree(doc, outOfScope);
  const contentOwners = new Set<string>();
  for (const page of doc.pages) {
    for (const ref of inspectContentRefs(page.dict.get('Contents'), doc.objects)) {
      if (contentOwners.has(ref.toKey())) outOfScope('content streams are shared between pages');
      contentOwners.add(ref.toKey());
    }
  }
  const plans: PagePlan[] = [];
  doc.pages.forEach((page, index) => {
    const annots = resolve(page.dict.get('Annots'), doc.objects);
    if (annots === undefined) return;
    if (!(annots instanceof PDFArray)) refuse('page annotations cannot be inspected');
    const dicts = annots.items.map(item => resolve(item, doc.objects));
    if (dicts.some(item => !(item instanceof PDFDict))) refuse('page annotations cannot be inspected');
    const marks = (dicts as PDFDict[]).filter(item => item.getName('Subtype') === 'Redact');
    if (!marks.length) return;
    if (marks.some(item => !isBareRedactionMark(item))) outOfScope('redaction annotation metadata cannot be inspected');
    if (page.contentRefs.length === 0) outOfScope('a marked page has no content');
    const areas = marks.map(markBox);
    for (const other of dicts as PDFDict[]) {
      if (marks.includes(other)) continue;
      // Replies and popups of a mark would keep pointing at it.
      if (['IRT', 'Parent'].some(key => marks.includes(resolve(other.get(key), doc.objects) as PDFDict))) {
        refuse('a redaction mark has replies or a popup');
      }
      const box = rectBox(other.get('Rect'));
      if (!box || areas.some(area => overlaps(box, area))) refuse('an annotation or form field under a mark is unsupported');
    }
    try {
      plans.push(planPage(doc, index, marks));
    } catch (error) {
      if (error instanceof GlyphRedactionUnsupportedError) throw error;
      refuse(`page ${index + 1} could not be inspected`);
    }
  });
  if (!plans.length) outOfScope('no redaction marks were found');
  return plans;
}

function apply(doc: PDFDocumentData, plans: PagePlan[]): void {
  for (const pagePlan of plans) {
    const page = doc.pages[pagePlan.index];
    const [first, ...rest] = page.contentRefs;
    doc.objects.set(first.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(pagePlan.output.length)]]), pagePlan.output, pagePlan.output));
    for (const ref of rest) doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(0)]]), new Uint8Array(0), new Uint8Array(0)));
    const annots = resolve(page.dict.get('Annots'), doc.objects) as PDFArray;
    const keep = annots.items.filter(item => {
      const value = resolve(item, doc.objects);
      if (value instanceof PDFDict && pagePlan.marks.has(value)) {
        if (item instanceof PDFRef) doc.objects.delete(item.toKey());
        return false;
      }
      return true;
    });
    if (keep.length) page.dict.set('Annots', new PDFArray(keep));
    else page.dict.delete('Annots');
  }
  // Old stream bytes stay in the original file prefix; never save incrementally.
  doc.requiresFullRewrite = true;
}

// ─── Copies of the removed text elsewhere in the file ─────────────────────────

const squeeze = (value: string) => value.replace(/\s+/g, '');
const latin1 = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join('');
function utf16(bytes: Uint8Array, littleEndian: boolean): string {
  let text = '';
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    text += String.fromCharCode(littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  }
  return text;
}

/** Decode a stream completely or refuse: a partial decode would hide a copy. */
function strictBytes(stream: PDFStream, budget: { bytes: number }): Uint8Array {
  const filters = stream.getFilters();
  let bytes: Uint8Array;
  if (!stream.dict.has('Filter')) bytes = stream.rawBytes;
  else if (filters.length === 1 && ['FlateDecode', 'Fl'].includes(filters[0]) && !stream.dict.has('DecodeParms')) {
    try { bytes = decodeZlibFully(stream.rawBytes, MAX_DECODED_BYTES - budget.bytes); }
    catch { return refuse('a stream cannot be fully decoded to check it for copies of the redacted text'); }
  } else return refuse('a stream uses a filter that cannot be checked for copies of the redacted text');
  budget.bytes += bytes.length;
  if (budget.bytes > MAX_DECODED_BYTES) refuse('the file is too large to check for copies of the redacted text');
  return bytes;
}

/** Text drawn by the content; refuses text whose font or text object cannot be inspected. */
function pageText(content: Uint8Array, page: PDFPageInfo, objects: Map<string, PDFObject>, where: string): string {
  let depth = 0;
  for (const instruction of parseContentStream(content)) {
    if (instruction.operator === 'BT') depth++;
    else if (instruction.operator === 'ET') depth--;
    if (depth < 0 || depth > 1) refuse(`text ${where} cannot be inspected`);
  }
  if (depth !== 0) refuse(`text ${where} cannot be inspected`);
  const result = interpretPage(content, page, objects);
  if (result.textRuns.some(run => !result.fonts.has(run.fontName))) refuse(`text ${where} cannot be inspected`);
  return squeeze(result.textRuns.flatMap(run => run.glyphs.map(glyph => glyph.unicode)).join(''));
}

/** Refuse if any needle survives anywhere reachable from the trailer. */
function assertNoRetainedCopies(doc: PDFDocumentData, needles: string[]): void {
  const texts = needles.map(squeeze).filter(text => text.length >= MIN_NEEDLE_LENGTH);
  if (!texts.length) return;
  const numeric = texts.filter(text => /^[+-]?[\d.]+$/.test(text));
  const check = (haystack: string, where: string) => {
    const value = squeeze(haystack);
    if (texts.some(text => value.includes(text))) refuse(`the redacted text also appears ${where}; mark that copy too`);
  };
  const checkBytes = (bytes: Uint8Array, where: string) => {
    check(latin1(bytes), where);
    check(utf16(bytes, false), where);
    check(utf16(bytes, true), where);
  };
  const budget = { bytes: 0 };

  // Page text, read strictly so that an undecodable stream cannot hide a copy.
  const pageStreams = new Set<PDFStream>();
  doc.pages.forEach((page, index) => {
    for (const ref of page.contentRefs) {
      const stream = doc.objects.get(ref.toKey());
      if (!(stream instanceof PDFStream)) refuse(`page ${index + 1} content cannot be checked`);
      const bytes = strictBytes(stream, budget);
      const cached = stream.getBytes();
      if (bytes.length !== cached.length || bytes.some((byte, at) => byte !== cached[at])) refuse(`page ${index + 1} content cannot be checked`);
      pageStreams.add(stream);
      checkBytes(bytes, `on page ${index + 1}`);
    }
    check(pageText(getPageContentBytes(page, doc.objects), page, doc.objects, `on page ${index + 1}`), `on page ${index + 1}`);
  });

  // Every other reachable value.
  const fontFiles = new Set<PDFObject>();
  const streams: PDFStream[] = [];
  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [doc.xref.trailerDict];
  const where = 'in the document data (metadata, links, bookmarks or another object)';
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (seen.size > MAX_VISITS) refuse('the file is too large to check for copies of the redacted text');
    if (value instanceof PDFRef) {
      const target = doc.objects.get(value.toKey());
      if (target) pending.push(target);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        check(key, where);
        if (FONT_FILE_KEYS.has(key)) fontFiles.add(resolve(child, doc.objects)!);
        pending.push(child);
      }
    } else if (value instanceof PDFStream) {
      streams.push(value);
      pending.push(value.dict);
    } else if (value instanceof PDFString || value instanceof PDFHexString) checkBytes(value.toBytes(), where);
    else if (value instanceof PDFName) check(value.name, where);
    else if (value instanceof PDFNumber && numeric.length) {
      if (numericSpellings(value).some(spelling => numeric.some(text =>
        text.length >= MIN_NUMERIC_SUBSTRING_LENGTH ? spelling.includes(text) : spelling === text))) {
        refuse(`the redacted text also appears ${where}; mark that copy too`);
      }
    }
  }
  for (const stream of streams) {
    if (pageStreams.has(stream) || fontFiles.has(stream) || stream.dict.getName('Subtype') === 'Image') continue;
    const bytes = strictBytes(stream, budget);
    checkBytes(bytes, where);
    if (stream.dict.getName('Subtype') === 'Form') {
      const resources = resolve(stream.dict.get('Resources'), doc.objects);
      const host = doc.pages[0];
      const formPage = { ...host, resources: resources instanceof PDFDict ? resources : host.resources };
      check(pageText(bytes, formPage, doc.objects, where), where);
    }
  }
}

export function prepareGlyphRedaction(doc: PDFDocumentData, options: SecureRedactionOptions = {}): { commit(): SecureRedactionResult } {
  // Rehearse the whole rewrite and every check on a detached copy first.
  const rehearse = () => {
    const staged = hydrateDocument(dehydrateDocument(doc));
    const plans = plan(staged, options);
    apply(staged, plans);
    assertNoRetainedCopies(staged, plans.flatMap(item => item.needles));
    assertRedactionRewriteSafe(staged, refuse);
  };
  rehearse();
  let committed = false;
  return {
    commit() {
      if (committed) throw new Error('The glyph redaction was already committed.');
      rehearse();
      const plans = plan(doc, options);
      apply(doc, plans);
      committed = true;
      return {
        pagesProcessed: plans.length,
        textOperatorsRemoved: plans.reduce((sum, item) => sum + item.glyphs, 0),
        imageOperatorsRemoved: 0,
        pathOperatorsRemoved: plans.reduce((sum, item) => sum + item.paths, 0),
        annotationsRemoved: plans.reduce((sum, item) => sum + item.marks.size, 0),
        formFieldsRemoved: 0,
        metadataStripped: false,
      };
    },
  };
}
