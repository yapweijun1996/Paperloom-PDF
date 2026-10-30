import { parseContentStream } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { applyFilters, decodeZlibFully } from '../parser/filters';
import { inspectContentRefs } from '../parser/content-refs';
import { concatBytes, recordPageContentModifiedKeys, serializeToString } from '../editor/stream-compiler';
import { resolveRef } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject, type PDFPageInfo } from '../types';
import { getNextObjNum } from '../writer/serializer';
import type { AcroFormWidget } from './types';

const unsupported = (): never => { throw new Error('Widget appearance cannot be flattened safely.'); };
const resolve = (value: PDFObject | undefined, doc: PDFDocumentData): PDFObject | undefined => value ? resolveRef(value, doc.objects) : undefined;
const number = (n: number) => serializeToString(new PDFNumber(n));

/** Verify original multi-stream content without rewriting or joining its bytes. */
export function inspectFlattenMultiStreams(page: PDFPageInfo, objects: Map<string, PDFObject>): PDFRef[] {
  let refs: PDFRef[];
  try { refs = inspectContentRefs(page.dict.get('Contents'), objects); } catch { return unsupported(); }
  if (refs.length > 4096 || page.contentInspectionComplete === false || refs.length !== page.contentRefs.length ||
      refs.some((ref, index) => ref.toKey() !== page.contentRefs[index].toKey())) return unsupported();
  const limit = 16 * 1024 * 1024;
  const resolveExact = (value: PDFObject): PDFObject => {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key) || seen.size >= 128) return unsupported();
      seen.add(key);
      const resolved = objects.get(key);
      if (!resolved) return unsupported();
      value = resolved;
    }
    return value;
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const ref of refs) {
    const stream = objects.get(ref.toKey());
    if (!(stream instanceof PDFStream) || stream.rawBytes.length > limit) return unsupported();
    const rawFilter = stream.dict.get('Filter');
    let filter = rawFilter ? resolveExact(rawFilter) : undefined;
    const rawParams = stream.dict.get('DecodeParms');
    let params = rawParams ? resolveExact(rawParams) : undefined;
    if (filter instanceof PDFArray && filter.length === 1) filter = resolveExact(filter.items[0]);
    if (params instanceof PDFArray && params.length === 1) params = resolveExact(params.items[0]);
    if ((rawFilter && !filter) || (rawParams && !params) ||
        (params !== undefined && !(params instanceof PDFNull))) return unsupported();
    let bytes: Uint8Array;
    if (!filter || filter instanceof PDFNull) bytes = stream.rawBytes;
    else if (filter instanceof PDFName && ['FlateDecode', 'Fl'].includes(filter.name)) {
      try { bytes = decodeZlibFully(stream.rawBytes, limit - total); } catch { return unsupported(); }
    } else return unsupported();
    if (bytes.length > limit - total || (stream.decodedBytes &&
        (stream.decodedBytes.length !== bytes.length || stream.decodedBytes.some((value, index) => value !== bytes[index])))) return unsupported();
    total += bytes.length;
    chunks.push(bytes);
  }
  const join = (separator: boolean) => {
    const result = new Uint8Array(total + (separator ? Math.max(0, chunks.length - 1) : 0));
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (separator && i) result[offset++] = 0x20;
      result.set(chunks[i], offset); offset += chunks[i].length;
    }
    return result;
  };
  const separated = join(true);
  isolateFlattenContent(separated);
  const completeBoundary = (bytes: Uint8Array) => {
    try {
      const marker = new TextEncoder().encode('\n0 0 m\n');
      const last = parseContentStream(concatBytes(bytes, marker)).at(-1);
      return !!last && last.operator === 'm' && last.offset === bytes.length + 5 && last.operands.length === 2 &&
        last.operands.every(value => value instanceof PDFNumber && value.value === 0);
    } catch { return false; }
  };
  // If a lexical item spans a stream boundary, require both possible lexer
  // interpretations to agree about operators and all non-string operands.
  if (chunks.some(bytes => !completeBoundary(bytes))) {
    const contiguous = join(false);
    isolateFlattenContent(contiguous);
    const first = parseContentStream(separated), second = parseContentStream(contiguous);
    if (first.length !== second.length || first.some((instruction, index) => {
      const other = second[index];
      if (!other || instruction.operator === 'BI' || instruction.operator !== other.operator ||
          instruction.operands.length !== other.operands.length) return true;
      return instruction.operands.some((value, operand) => {
        const compared = other.operands[operand];
        if (value instanceof PDFString && compared instanceof PDFString) return false;
        return serializeToString(value) !== serializeToString(compared);
      });
    })) return unsupported();
  }
  return refs;
}

/** Enclose original page content so its final CTM or clipping cannot affect the appearance. */
export function isolateFlattenContent(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 16 * 1024 * 1024) return unsupported();
  const sentinel = new TextEncoder().encode('\n0 0 m\n');
  let instructions;
  try { instructions = parseContentStream(concatBytes(bytes, sentinel)); } catch { return unsupported(); }
  const last = instructions.pop();
  if (!last || last.operator !== 'm' || last.offset !== bytes.length + 5 || last.operands.length !== 2 ||
      !last.operands.every(value => value instanceof PDFNumber && value.value === 0)) return unsupported();
  let graphics = 0, marked = 0, text = false, compatibility = 0;
  for (const { operator, operands } of instructions) {
    if (['q', 'Q', 'BT', 'ET', 'EMC', 'BX', 'EX'].includes(operator) && operands.length) return unsupported();
    if (operator === 'q') graphics++;
    else if (operator === 'Q' && --graphics < 0) return unsupported();
    else if (operator === 'BT') { if (text) return unsupported(); text = true; }
    else if (operator === 'ET') { if (!text) return unsupported(); text = false; }
    else if (operator === 'BDC' || operator === 'BMC') marked++;
    else if (operator === 'EMC' && --marked < 0) return unsupported();
    else if (operator === 'BX') compatibility++;
    else if (operator === 'EX' && --compatibility < 0) return unsupported();
  }
  if (graphics || marked || text || compatibility) return unsupported();
  return concatBytes(concatBytes(new TextEncoder().encode('q\n'), bytes), new TextEncoder().encode('\nQ\n'));
}

function numbers(value: PDFObject | undefined, doc: PDFDocumentData, count: number): number[] {
  const array = resolve(value, doc);
  if (!(array instanceof PDFArray) || array.length !== count) return unsupported();
  const parts = array.items.map(item => resolve(item, doc));
  if (!parts.every(item => item instanceof PDFNumber && Number.isFinite(item.value))) return unsupported();
  return parts.map(item => (item as PDFNumber).value);
}

/** Reuse the selected appearance, including its resources, as a Form XObject. */
export async function addFlattenAppearance(doc: PDFDocumentData, pageIndex: number, widget: AcroFormWidget): Promise<string> {
  const page = doc.pages[pageIndex];
  const annotation = widget.dict;
  const flags = resolve(annotation.get('F'), doc);
  if (flags !== undefined && (!(flags instanceof PDFNumber) || !Number.isSafeInteger(flags.value) || flags.value < 0 || (flags.value & (2 | 8 | 16 | 32)) !== 0)) return unsupported();
  if (annotation.has('OC') || annotation.has('CA')) return unsupported();
  const ap = resolve(annotation.get('AP'), doc);
  if (!(ap instanceof PDFDict)) return unsupported();
  let selected = ap.get('N');
  const normal = resolve(selected, doc);
  if (normal instanceof PDFDict) {
    const state = resolve(annotation.get('AS'), doc);
    if (!(state instanceof PDFName)) return unsupported();
    if (widget.fieldType === 'Btn' && !(widget.buttonFlags & (1 << 16))) {
      const value = widget.value;
      let expected: string;
      if (value === null || value === false || value === 'Off') expected = 'Off';
      else if (value === true) expected = state.name === 'Off' ? '' : state.name;
      else if (typeof value === 'string' && normal.has(value)) expected = value;
      else if (typeof value === 'string' && (widget.buttonFlags & (1 << 15))) expected = 'Off';
      else return unsupported();
      if (state.name !== expected) return unsupported();
    }
    selected = normal.get(state.name);
  }
  const stream = resolve(selected, doc);
  if (!(stream instanceof PDFStream) || stream.dict.has('OC')) return unsupported();
  // Flattening destroys /V, so refuse when the preserved text appearance does
  // not represent the current field value. Complex appearances that cannot be
  // inspected safely remain editable instead of silently losing their value.
  if (widget.fieldType === 'Tx' || widget.fieldType === 'Ch') {
    let expected = typeof widget.value === 'string' ? widget.value : widget.value === null ? '' : undefined;
    if (widget.fieldType === 'Ch' && expected !== undefined) {
      expected = widget.choiceOptions?.find(option => option.value === expected)?.label ?? expected;
    }
    if (expected === undefined) return unsupported();
    const resourcesEntry = stream.dict.get('Resources');
    const resources = resourcesEntry ? resolve(resourcesEntry, doc) : page.resources;
    if (!(resources instanceof PDFDict)) return unsupported();
    let interpreted;
    try {
      const filter = stream.dict.get('Filter');
      if (stream.dict.has('DecodeParms') || (filter !== undefined &&
          (!(filter instanceof PDFName) || filter.name !== 'FlateDecode'))) return unsupported();
      const bytes = await applyFilters(stream.rawBytes, stream.getFilters(), [], { maxDecodedBytes: 1024 * 1024 });
      if (bytes.length > 1024 * 1024 || (stream.decodedBytes &&
          (stream.decodedBytes.length !== bytes.length || stream.decodedBytes.some((byte, index) => byte !== bytes[index])))) return unsupported();
      interpreted = interpretPage(bytes, { ...page, resources }, doc.objects);
    } catch { return unsupported(); }
    if (interpreted.displayList.some(item => item.type === 'form') ||
        interpreted.textRuns.some(run => (run.renderingMode ?? 0) % 4 === 3 || run.actualText)) return unsupported();
    const normalize = (value: string) => value.replace(/\r\n?/g, '\n');
    const value = normalize(expected);
    const pieces = interpreted.textRuns.map(run => normalize(run.text));
    if (pieces.length > 512 || value.length > 16384) return unsupported();
    // Runs can split a visual line or wrap a field value. Permit a single
    // original space or newline at run boundaries, never collapse whitespace.
    let offsets = new Set([0]);
    for (let i = 0; i < pieces.length; i++) {
      const next = new Set<number>();
      for (const offset of offsets) for (const separator of i ? ['', ' ', '\n'] : ['']) {
        const part = separator + pieces[i];
        if (value.startsWith(part, offset)) next.add(offset + part.length);
      }
      offsets = next;
      if (!offsets.size) return unsupported();
    }
    if (!offsets.has(value.length)) return unsupported();
  }
  const subtype = resolve(stream.dict.get('Subtype'), doc);
  if (subtype !== undefined && (!(subtype instanceof PDFName) || subtype.name !== 'Form')) return unsupported();
  const bbox = numbers(stream.dict.get('BBox'), doc, 4);
  const rect = numbers(annotation.get('Rect'), doc, 4);
  const matrix = stream.dict.has('Matrix') ? numbers(stream.dict.get('Matrix'), doc, 6) : [1, 0, 0, 1, 0, 0];
  const [x0, y0, x1, y1] = bbox;
  const points = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => [matrix[0]*x + matrix[2]*y + matrix[4], matrix[1]*x + matrix[3]*y + matrix[5]]);
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const width = maxX - minX, height = maxY - minY;
  const sx = Math.abs(rect[2] - rect[0]) / width, sy = Math.abs(rect[3] - rect[1]) / height;
  if (![minX, minY, width, height, sx, sy].every(Number.isFinite) || width <= 0 || height <= 0 || sx <= 0 || sy <= 0) return unsupported();
  const tx = Math.min(rect[0], rect[2]) - minX * sx, ty = Math.min(rect[1], rect[3]) - minY * sy;
  if (![tx, ty].every(Number.isFinite)) return unsupported();
  const resources = new PDFDict([...page.resources.entries()]);
  const originalXObjects = resolve(resources.get('XObject'), doc);
  if (originalXObjects !== undefined && !(originalXObjects instanceof PDFDict)) return unsupported();
  const xobjects = new PDFDict(originalXObjects instanceof PDFDict ? [...originalXObjects.entries()] : []);
  let index = 1, name = `PaperloomFlatten${index}`;
  while (xobjects.has(name)) { if (++index > 10000) return unsupported(); name = `PaperloomFlatten${index}`; }
  // Some AP streams omit /Subtype; clone the dictionary rather than altering a shared appearance.
  const appearanceDict = new PDFDict([...stream.dict.entries()]);
  appearanceDict.set('Type', new PDFName('XObject'));
  appearanceDict.set('Subtype', new PDFName('Form'));
  const appearance = new PDFStream(appearanceDict, new Uint8Array(stream.rawBytes), stream.decodedBytes && new Uint8Array(stream.decodedBytes));
  const ref = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), appearance);
  xobjects.set(name, ref);
  resources.set('XObject', xobjects);
  page.dict.set('Resources', resources);
  page.resources = resources;
  recordPageContentModifiedKeys(doc.objects, [ref.toKey(), page.ref.toKey()]);
  return `q ${number(sx)} 0 0 ${number(sy)} ${number(tx)} ${number(ty)} cm /${name} Do Q`;
}
