import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString,
  type PDFDocumentData, type PDFObject, type PDFPageInfo,
} from '../../types';
import { dehydrateDocument, hydrateDocument } from '../../worker/codec';
import { hasFinalizedSignature } from '../../writer/save-pipeline';
import { getNextObjNum } from '../../writer/serializer';
import { decodeZlibFully } from '../../parser/filters';
import { coversRectangle, type Bounds } from './rectangle-coverage';
import { identityMatrix, multiplyMatrices, transformPoint, type Matrix } from '../../render/graphics-state';
import type { SecureRedactionOptions, SecureRedactionResult } from '../types';
import { assertCompletePageTree } from '../validate-page-tree';
import { assertRedactionRewriteSafe } from './rewrite-preflight';
import { matchingStreamBytes, streamComparisonBudget } from './stream-comparison';
import { isBareRedactionMark } from './bare-redaction-mark';

/** Only a small, verifiable graphics-language subset is supported. */
export class PartialGraphicsRedactionUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Secure partial graphics redaction is unavailable: ${reason}. The document was not changed.`);
    this.name = 'PartialGraphicsRedactionUnsupportedError';
  }
}
function refuse(reason: string): never { throw new PartialGraphicsRedactionUnsupportedError(reason); }
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
interface References { refs: Set<string>; values: Set<PDFObject> }
interface ReachabilityBudget { visits: number }
const MAX_REACHABILITY_WALK = 100_000;
const MAX_REACHABILITY_VISITS = 500_000;
function collect(value: PDFObject | undefined, objects: Map<string, PDFObject>, result: References,
  budget: ReachabilityBudget, skipPageBackRef = false): void {
  if (!value) return;
  const visited = new Set<PDFObject>();
  const pending: Array<{ value: PDFObject; skipPageBackRef: boolean }> = [{ value, skipPageBackRef }];
  while (pending.length) {
    if (pending.length > MAX_REACHABILITY_WALK) refuse('object references exceed the inspection limit');
    const item = pending.pop()!, current = item.value;
    if (visited.has(current)) continue;
    if (visited.size >= MAX_REACHABILITY_WALK || budget.visits >= MAX_REACHABILITY_VISITS) {
      refuse('object references exceed the inspection limit');
    }
    visited.add(current);
    budget.visits++;
    if (current instanceof PDFRef) {
      const key = current.toKey();
      result.refs.add(key);
      const target = objects.get(key);
      if (!target) refuse('an indirect reference cannot be resolved');
      pending.push({ value: target, skipPageBackRef: item.skipPageBackRef });
    } else if (current instanceof PDFDict) {
      result.values.add(current);
      if (current.size + pending.length > MAX_REACHABILITY_WALK) refuse('object references exceed the inspection limit');
      const entries = [...current.entries()];
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        if (!(item.skipPageBackRef && key === 'P')) pending.push({ value: child, skipPageBackRef: false });
      }
    } else if (current instanceof PDFArray) {
      result.values.add(current);
      if (current.length + pending.length > MAX_REACHABILITY_WALK) refuse('object references exceed the inspection limit');
      for (let i = current.length - 1; i >= 0; i--) {
        pending.push({ value: current.items[i], skipPageBackRef: item.skipPageBackRef });
      }
    } else if (current instanceof PDFStream) {
      result.values.add(current);
      pending.push({ value: current.dict, skipPageBackRef: false });
    } else if (current instanceof PDFString || current instanceof PDFHexString) result.values.add(current);
  }
}
function numericArray(value: PDFObject | undefined, count: number): number[] | null {
  if (!(value instanceof PDFArray) || value.length !== count) return null;
  const values: number[] = [];
  for (const n of value.items) {
    if (!(n instanceof PDFNumber) || !Number.isFinite(n.value)) return null;
    values.push(n.value);
  }
  return values;
}
function bounds(x0: number, y0: number, x1: number, y1: number): Bounds {
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}
function validBounds(box: Bounds): boolean {
  return Object.values(box).every(Number.isFinite) && box.maxX > box.minX && box.maxY > box.minY;
}
function markBounds(mark: PDFDict): Bounds {
  const rect = numericArray(mark.get('Rect'), 4);
  if (!rect) refuse('redaction geometry is invalid');
  const box = bounds(rect[0], rect[1], rect[2], rect[3]);
  if (!validBounds(box)) refuse('redaction geometry is empty or invalid');
  const rawQuad = mark.get('QuadPoints');
  if (rawQuad !== undefined) {
    const quad = numericArray(rawQuad, 8);
    if (!quad) refuse('redaction quadrilaterals are unsupported');
    const canonical = [box.minX, box.maxY, box.maxX, box.maxY, box.minX, box.minY, box.maxX, box.minY];
    if (!quad.every((value, index) => value === canonical[index])) refuse('redaction quadrilaterals are not axis aligned');
  }
  return box;
}
function overlaps(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}
function overlapsWithArea(a: Bounds, b: Bounds): boolean {
  return a.maxX > b.minX && b.maxX > a.minX && a.maxY > b.minY && b.maxY > a.minY;
}
function contains(a: Bounds, b: Bounds): boolean {
  // Require a margin to avoid accepting numerically ambiguous object edges.
  const margin = Math.max(1e-7, Math.max(...Object.values(b).map(Math.abs)) * 1e-12);
  return a.minX <= b.minX - margin && a.maxX >= b.maxX + margin &&
    a.minY <= b.minY - margin && a.maxY >= b.maxY + margin;
}
/** Check coverage of the entire conservative object bounds, including its
 * numerical safety margin. The annotation count is bounded by the caller. */
function unionContains(areas: Bounds[], object: Bounds): boolean {
  if (areas.some(area => contains(area, object))) return true;
  const margin = Math.max(1e-7, Math.max(...Object.values(object).map(Math.abs)) * 1e-12);
  const target = { minX: object.minX - margin, minY: object.minY - margin,
    maxX: object.maxX + margin, maxY: object.maxY + margin };
  if (!validBounds(target)) return false;
  return coversRectangle(areas, target);
}
function transformed(m: Matrix, x: number, y: number, w: number, h: number): Bounds {
  const corners = [transformPoint(m, x, y), transformPoint(m, x + w, y),
    transformPoint(m, x, y + h), transformPoint(m, x + w, y + h)];
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  if (!validBounds(box)) refuse('an object has ambiguous or degenerate coordinates');
  return box;
}
function effectivePage(page: PDFPageInfo, doc: PDFDocumentData): void {
  const root = resolve(doc.catalog.get('Pages'), doc.objects);
  if (!(root instanceof PDFDict) || root.getName('Type') !== 'Pages') refuse('the page tree root is invalid');
  let node = page.dict, media: PDFObject | undefined, resources: PDFObject | undefined;
  const seen = new Set<PDFDict>();
  while (true) {
    if (seen.has(node)) refuse('the page tree contains a cycle');
    seen.add(node);
    if (media === undefined && node.has('MediaBox')) media = node.get('MediaBox');
    if (resources === undefined && node.has('Resources')) resources = node.get('Resources');
    if (node === root) break;
    const parent = resolve(node.get('Parent'), doc.objects);
    if (!(parent instanceof PDFDict) || parent.getName('Type') !== 'Pages') refuse('a page parent cannot be verified');
    const children = resolve(parent.get('Kids'), doc.objects);
    if (!(children instanceof PDFArray) || !children.items.some(item => resolve(item, doc.objects) === node)) {
      refuse('a page does not belong to its declared parent');
    }
    node = parent;
  }
  const box = numericArray(resolve(media, doc.objects), 4);
  if (!box) refuse('the effective page MediaBox is invalid');
  const actual = bounds(box[0], box[1], box[2], box[3]);
  if (!validBounds(actual) || page.mediaBox.x !== actual.minX || page.mediaBox.y !== actual.minY ||
      page.mediaBox.width !== actual.maxX - actual.minX || page.mediaBox.height !== actual.maxY - actual.minY) {
    refuse('cached page geometry differs from the page tree');
  }
  const realResources = resources === undefined ? undefined : resolve(resources, doc.objects);
  if (resources !== undefined && (!(realResources instanceof PDFDict) || realResources !== page.resources)) {
    refuse('cached page resources differ from the page tree');
  }
  if (resources === undefined && page.resources.size !== 0) refuse('cached page resources differ from the page tree');
}
const PAGE_KEYS = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'Rotate', 'Resources', 'Contents', 'Annots', 'Tabs', 'UserUnit']);
function validatePageFeatures(page: PDFPageInfo, doc: PDFDocumentData): void {
  for (const key of page.dict.keys()) if (!PAGE_KEYS.has(key)) refuse(`page feature /${key} is not supported`);
  if (page.dict.getName('Type') !== 'Page') refuse('the marked object is not a page');
  const crop = page.dict.get('CropBox');
  if (crop !== undefined && !numericArray(resolve(crop, doc.objects), 4)) refuse('page CropBox is invalid');
  for (const key of ['Rotate', 'UserUnit'] as const) {
    const raw = page.dict.get(key);
    if (raw === undefined) continue;
    const n = resolve(raw, doc.objects);
    if (!(n instanceof PDFNumber) || !Number.isFinite(n.value) || (key === 'UserUnit' && n.value <= 0)) refuse(`page /${key} is invalid`);
  }
  const tabs = page.dict.get('Tabs');
  if (tabs !== undefined && !['R', 'C', 'S'].includes(page.dict.getName('Tabs') ?? '')) refuse('page /Tabs is invalid');
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

function rectangleSignature(inst: Instruction): string {
  const dimensions = [Math.abs(Number(inst.args[2])), Math.abs(Number(inst.args[3]))].sort((a, b) => a - b);
  return `${dimensions[0]}:${dimensions[1]}`;
}

type RectangleGeometry = [number, number, number];
function rectangleGeometry(inst: Instruction, matrix: Matrix): RectangleGeometry {
  const width = Number(inst.args[2]), height = Number(inst.args[3]);
  const x = [matrix.a * width, matrix.b * width], y = [matrix.c * height, matrix.d * height];
  const xLength = Math.hypot(...x), yLength = Math.hypot(...y);
  if (!Number.isFinite(xLength) || !Number.isFinite(yLength) || xLength <= 0 || yLength <= 0) {
    refuse('retained vector geometry cannot be checked');
  }
  const angle = Math.abs((x[0] / xLength) * (y[0] / yLength) + (x[1] / xLength) * (y[1] / yLength));
  if (!Number.isFinite(angle)) refuse('retained vector geometry cannot be checked');
  return [Math.min(xLength, yLength), Math.max(xLength, yLength), angle];
}
function sameGeometry(a: RectangleGeometry, b: RectangleGeometry): boolean {
  return a.every((value, i) => Math.abs(value - b[i]) <= 1e-9 * Math.max(1, Math.abs(value), Math.abs(b[i])));
}

interface Instruction { operator: string; args: string[] }
// Parsing is synchronous and each selected page is inspected again after its
// rewrite. Bound both a single stream and the total work of one preparation;
// otherwise a small file containing many short operators can allocate hundreds
// of megabytes or monopolize the calling thread.
const MAX_STREAM_BYTES = 1_048_576;
const MAX_TOTAL_PARSE_BYTES = 4_194_304;
const MAX_STREAM_INSTRUCTIONS = 65_536;
const MAX_TOTAL_INSTRUCTIONS = 131_072;
const MAX_GRAPHICS_STATE_DEPTH = 256;
const MAX_GEOMETRY_COMPARISONS = 1_048_576;
const MAX_PATH_RECTANGLES = 128;
interface ParseBudget { bytes: number; instructions: number }
const PAINT_RECTANGLES = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
const STROKE_RECTANGLES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const OPERANDS: Record<string, number> = {
  q: 0, Q: 0, cm: 6, w: 1, g: 1, rg: 3, k: 4, G: 1, RG: 3, K: 4,
  re: 4, f: 0, F: 0, 'f*': 0, S: 0, s: 0, B: 0, 'B*': 0, b: 0, 'b*': 0, Do: 1,
};
/** Accept a tiny unambiguous ASCII PDF grammar; do not silently skip unknown
 * tokens, trailing operands, comments, inline images, strings or arrays. */
function parseStrict(bytes: Uint8Array, budget: ParseBudget): Instruction[] {
  if (bytes.length > MAX_STREAM_BYTES || budget.bytes + bytes.length > MAX_TOTAL_PARSE_BYTES) {
    refuse('content exceeds the graphics inspection byte limit');
  }
  budget.bytes += bytes.length;
  if (bytes.some(byte => byte > 0x7e || (byte < 0x20 && ![0, 9, 10, 12, 13].includes(byte)))) refuse('content contains unsupported bytes');
  const text = new TextDecoder().decode(bytes);
  const token = /[\x00\x09\x0a\x0c\x0d\x20]*(\/[A-Za-z_][A-Za-z0-9_.-]*|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|[A-Za-z][A-Za-z0-9*]*)(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/gy;
  const whitespace = /[\x00\x09\x0a\x0c\x0d\x20]*/y;
  const instructions: Instruction[] = [], pending: string[] = [];
  let pos = 0, depth = 0;
  while (pos < text.length) {
    whitespace.lastIndex = pos;
    const end = whitespace.exec(text);
    if (end && whitespace.lastIndex === text.length) { pos = text.length; break; }
    token.lastIndex = pos;
    const match = token.exec(text);
    if (!match) refuse('content syntax is not supported');
    pos = token.lastIndex;
    const word = match[1];
    if (Object.hasOwn(OPERANDS, word)) {
      if (pending.length !== OPERANDS[word]) refuse('an operator has invalid operands');
      if (instructions.length >= MAX_STREAM_INSTRUCTIONS || budget.instructions >= MAX_TOTAL_INSTRUCTIONS) {
        refuse('content exceeds the graphics inspection instruction limit');
      }
      budget.instructions++;
      if (word === 'q' && ++depth > MAX_GRAPHICS_STATE_DEPTH) refuse('the graphics state exceeds the inspection depth');
      if (word === 'Q' && --depth < 0) refuse('the graphics state stack is unbalanced');
      if (word === 'Do') {
        if (!pending[0]?.startsWith('/')) refuse('an image name is invalid');
      } else if (pending.some(value => value.startsWith('/') || !Number.isFinite(Number(value)))) refuse('a numeric operand is invalid');
      instructions.push({ operator: word, args: pending.splice(0) });
    } else if (word.startsWith('/') || /^[-+.\d]/.test(word)) {
      if (pending.length >= 6) refuse('an operator has too many operands');
      pending.push(word);
    }
    else refuse(`operator ${word} is unsupported`);
  }
  if (pending.length !== 0) refuse('content has trailing operands');
  return instructions;
}
interface EditedPage { index: number; newRef: PDFRef; content: PDFStream; resources: PDFDict }
interface Plan { edits: EditedPage[]; removeObjects: string[]; images: number; paths: number; annotations: number }
function plan(doc: PDFDocumentData, options: SecureRedactionOptions): Plan {
  assertCompletePageTree(doc, refuse);
  if (options.metadata === true || options.text === false || options.images === false || options.vectors === false ||
      options.annotations === false || options.formFields === false) refuse('the requested options cannot be honored');
  const root = doc.xref.trailerDict.getRef('Root');
  if (!root || doc.objects.get(root.toKey()) !== doc.catalog || doc.catalog.getName('Type') !== 'Catalog') refuse('the PDF catalog cannot be verified');
  const staged = hydrateDocument(dehydrateDocument(doc));
  const sensitive: References = { refs: new Set(), values: new Set() };
  const reachabilityBudget: ReachabilityBudget = { visits: 0 };
  const edits: EditedPage[] = [];
  const allMarks: PDFDict[] = [];
  const parseBudget: ParseBudget = { bytes: 0, instructions: 0 };
  const removedRectangleShapes = new Set<string>();
  const removedRectangleGeometry: RectangleGeometry[] = [];
  let images = 0, paths = 0, annotations = 0, nextObj = getNextObjNum(staged);
  for (let index = 0; index < staged.pages.length; index++) {
    const page = staged.pages[index];
    if (staged.objects.get(page.ref.toKey()) !== page.dict) refuse('a page is not backed by its canonical object');
    const rawAnnots = page.dict.get('Annots');
    if (!rawAnnots) continue;
    const annots = resolve(rawAnnots, staged.objects);
    if (!(annots instanceof PDFArray)) refuse('page annotations cannot be inspected');
    const marks = annots.items.filter(item => {
      const dict = resolve(item, staged.objects);
      if (!(dict instanceof PDFDict) || !dict.getName('Subtype')) refuse('page annotations cannot be inspected');
      return dict.getName('Subtype') === 'Redact';
    });
    if (!marks.length) continue;
    if (marks.length > 64 || marks.length !== annots.length) refuse('only redaction annotations are supported, with at most 64 marks per page');
    const markObjects = marks.map(item => resolve(item, staged.objects) as PDFDict);
    allMarks.push(...markObjects);
    if (new Set(markObjects).size !== markObjects.length) refuse('a redaction annotation is duplicated');
    for (const mark of markObjects) {
      if (mark.has('P') && resolve(mark.get('P'), staged.objects) !== page.dict) refuse('a redaction annotation refers to a different page');
    }
    const areas = markObjects.map(markBounds);
    const touched = areas.map(() => false);
    const isCovered = (object: Bounds, kind: string) => {
      const intersections = areas.map((area, i) => overlaps(area, object) ? i : -1).filter(i => i >= 0);
      if (!intersections.length) return false;
      if (!unionContains(intersections.map(i => areas[i]), object)) refuse(`a ${kind} partially intersects the marked region`);
      // Touching an edge is conservatively checked above, but does not mean
      // a mark removed any content. Only an overlap with area satisfies it.
      for (const i of intersections) if (overlapsWithArea(areas[i], object)) touched[i] = true;
      return true;
    };
    effectivePage(page, staged);
    validatePageFeatures(page, staged);
    if (doc.pages.some((other, i) => i !== index && (other.dict === doc.pages[index].dict ||
        other.ref.toKey() === doc.pages[index].ref.toKey() || other.contentRefs === doc.pages[index].contentRefs))) refuse('page state is shared with another page');
    const contentRef = page.dict.get('Contents');
    if (!(contentRef instanceof PDFRef) || page.contentRefs.length !== 1 || page.contentRefs[0].toKey() !== contentRef.toKey()) refuse('only one canonical content stream is supported');
    const content = staged.objects.get(contentRef.toKey());
    if (!(content instanceof PDFStream) || content.dict.has('DecodeParms') ||
        [...content.dict.keys()].some(key => key !== 'Length' && key !== 'Filter')) refuse('the content stream properties are not supported');
    if (content.dict.getNumber('Length') !== content.rawBytes.length) refuse('the content stream length is invalid');
    if (content.rawBytes.length > MAX_STREAM_BYTES) refuse('content exceeds the graphics inspection byte limit');
    const filter = content.dict.get('Filter');
    let decoded = content.rawBytes;
    if (filter !== undefined) {
      if (!(filter instanceof PDFName) || !['FlateDecode', 'Fl'].includes(filter.name) || content.rawBytes.length > 1_048_576) {
        refuse('the content stream filter is not supported');
      }
      try { decoded = decodeZlibFully(content.rawBytes, 65_536); }
      catch { return refuse('the compressed content stream cannot be verified'); }
    }
    if (content.decodedBytes && (content.decodedBytes.length !== decoded.length ||
        content.decodedBytes.some((byte, i) => byte !== decoded[i]))) refuse('the content cache differs from the source stream');
    // Record independently decoded bytes on the staged object so duplicate
    // checks also catch an uncompressed copy of the removed compressed stream.
    if (filter !== undefined) content.decodedBytes = decoded;
    const instructions = parseStrict(decoded, parseBudget);
    const output: Instruction[] = [], stack: Array<{ matrix: Matrix; lineWidth: number }> = [];
    const startingImages = images, startingPaths = paths;
    let matrix = identityMatrix(), lineWidth = 1;
    const pendingRectangles: Instruction[] = [];
    const removedNames = new Set<string>(), remainingNames = new Set<string>();
    const xobjects = resolve(page.resources.get('XObject'), staged.objects);
    const imageFor = (name: string): PDFObject => {
      if (!(xobjects instanceof PDFDict)) refuse('the image resource dictionary is missing');
      const object = xobjects.get(name);
      const resolved = resolve(object, staged.objects);
      if (!(resolved instanceof PDFStream) || resolved.dict.getName('Subtype') !== 'Image') refuse('only image XObjects are supported');
      return object!;
    };
    for (const inst of instructions) {
      if (pendingRectangles.length && inst.operator !== 're' && !PAINT_RECTANGLES.has(inst.operator)) refuse('path construction is not supported');
      if (inst.operator === 'q') { stack.push({ matrix: { ...matrix }, lineWidth }); output.push(inst); }
      else if (inst.operator === 'Q') {
        const saved = stack.pop();
        if (!saved) refuse('the graphics state stack is unbalanced');
        matrix = saved.matrix; lineWidth = saved.lineWidth; output.push(inst);
      } else if (inst.operator === 'cm') {
        const n = inst.args.map(Number);
        const next = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
        matrix = multiplyMatrices(next, matrix);
        if (!Object.values(matrix).every(Number.isFinite) || !Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) ||
            Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12) refuse('the graphics transform is degenerate');
        output.push(inst);
      } else if (inst.operator === 'w') {
        lineWidth = Number(inst.args[0]);
        // A zero-width PDF hairline has device-dependent extent and cannot be
        // bounded safely in page coordinates.
        if (lineWidth <= 0) refuse('zero or negative line width is not supported');
        output.push(inst);
      } else if (['g', 'rg', 'k', 'G', 'RG', 'K'].includes(inst.operator)) {
        if (inst.args.some(value => Number(value) < 0 || Number(value) > 1)) refuse('color operands are outside the supported range');
        output.push(inst);
      } else if (inst.operator === 're') {
        if (pendingRectangles.length >= MAX_PATH_RECTANGLES) refuse('the rectangle path exceeds the inspection limit');
        pendingRectangles.push(inst);
      } else if (PAINT_RECTANGLES.has(inst.operator)) {
        if (!pendingRectangles.length) refuse('only rectangle paths are supported');
        const rectangles = pendingRectangles.map(rectangle => {
          const [x, y, width, height] = rectangle.args.map(Number);
          let paintedBox = transformed(matrix, x, y, width, height);
          if (STROKE_RECTANGLES.has(inst.operator)) {
            const half = lineWidth / 2;
            // Expand the user-space rectangle before transforming it. This
            // encloses the default miter stroke under rotation and shear.
            paintedBox = transformed(matrix, Math.min(x, x + width) - half, Math.min(y, y + height) - half,
              Math.abs(width) + lineWidth, Math.abs(height) + lineWidth);
          }
          return { rectangle, removed: isCovered(paintedBox, 'vector path') };
        });
        const removed = rectangles.filter(rectangle => rectangle.removed);
        const kept = rectangles.filter(rectangle => !rectangle.removed);
        // Even disjoint subpaths can share a renderer's rasterization path.
        // Removing only some changed pixels of retained rectangles in both
        // independent readers and the editor canvas at low zoom levels.
        if (removed.length && kept.length) refuse('partially removed rectangle paths are unsupported');
        for (const item of removed) {
          removedRectangleShapes.add(rectangleSignature(item.rectangle));
          removedRectangleGeometry.push(rectangleGeometry(item.rectangle, matrix));
          paths++;
        }
        if (kept.length) output.push(...kept.map(item => item.rectangle), inst);
        pendingRectangles.length = 0;
      } else if (inst.operator === 'Do') {
        const name = inst.args[0].slice(1);
        const obj = imageFor(name);
        const box = transformed(matrix, 0, 0, 1, 1);
        if (isCovered(box, 'image')) {
          removedNames.add(name); collect(obj, staged.objects, sensitive, reachabilityBudget); images++;
        } else { remainingNames.add(name); output.push(inst); }
      }
    }
    if (pendingRectangles.length || stack.length) refuse('the graphics state or path is incomplete');
    if (images === startingImages && paths === startingPaths) refuse('the marked region does not contain a supported object');
    if (touched.some(value => !value)) refuse('a marked region does not contain a supported object');
    for (const name of removedNames) if (remainingNames.has(name)) refuse('the same image is used outside the marked region');
    const newResources = new PDFDict([...page.resources.entries()]);
    if (removedNames.size) {
      if (!(xobjects instanceof PDFDict)) refuse('the image resources are missing');
      const nextXObjects = new PDFDict([...xobjects.entries()]);
      for (const name of removedNames) nextXObjects.delete(name);
      if (nextXObjects.size) newResources.set('XObject', nextXObjects);
      else newResources.delete('XObject');
    }
    const bytes = new TextEncoder().encode(output.map(i => [...i.args, i.operator].join(' ')).join('\n') + '\n');
    const newStream = new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes);
    const newRef = new PDFRef(nextObj++, 0);
    collect(contentRef, staged.objects, sensitive, reachabilityBudget);
    collect(rawAnnots, staged.objects, sensitive, reachabilityBudget, true);
    staged.objects.set(newRef.toKey(), newStream);
    page.dict.set('Contents', newRef);
    page.dict.set('Resources', newResources);
    page.dict.delete('Annots');
    page.contentRefs = [newRef]; page.resources = newResources;
    edits.push({ index, newRef, content: newStream, resources: newResources });
    annotations += marks.length;
  }
  if (!edits.length) return { edits, removeObjects: [], images, paths, annotations };
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt')) refuse('protected PDFs are not supported');
  if (hasFinalizedSignature(doc.rawBytes) || hasSignatureDictionary(doc.objects) || doc.catalog.has('AcroForm') || doc.catalog.has('Perms')) refuse('signed PDFs and interactive forms are not supported');
  if (doc.catalog.has('StructTreeRoot')) refuse('tagged PDF structure is not supported');
  const surviving: References = { refs: new Set(), values: new Set() };
  for (const key of ['Root', 'Info', 'ID'] as const) collect(staged.xref.trailerDict.get(key), staged.objects, surviving, reachabilityBudget);
  for (let i = 0; i < staged.pages.length; i++) {
    if (edits.some(edit => edit.index === i)) continue;
    collect(staged.pages[i].resources, staged.objects, surviving, reachabilityBudget);
    for (const ref of staged.pages[i].contentRefs) collect(ref, staged.objects, surviving, reachabilityBudget);
  }
  if ([...sensitive.refs].some(key => surviving.refs.has(key)) || [...sensitive.values].some(value => surviving.values.has(value))) {
    refuse('removed objects are shared with retained data');
  }
  if (allMarks.some(mark => !isBareRedactionMark(mark))) refuse('redaction annotation metadata cannot be inspected');
  // Distinct indirect objects can contain the same image, mask, annotation
  // appearance, or old page stream. Identity checks alone cannot detect this.
  const removedStreams = [...sensitive.values].filter((value): value is PDFStream => value instanceof PDFStream);
  const retainedStreams = [...surviving.values].filter((value): value is PDFStream => value instanceof PDFStream);
  // A cached decoded stream is not proof of the bytes that will be saved.
  // Until all filters can be independently verified, an encoded survivor may
  // conceal a second copy of any removed stream and must fail closed.
  if (removedStreams.some(stream => stream.rawBytes.length > 0 || (stream.decodedBytes?.length ?? 0) > 0) &&
      retainedStreams.some(stream => stream.dict.has('Filter') || stream.dict.has('DecodeParms'))) {
    refuse('retained encoded streams cannot be checked for removed data');
  }
  const comparisonBudget = streamComparisonBudget();
  if (removedStreams.some(removed => retainedStreams.some(retained => matchingStreamBytes(removed, retained, comparisonBudget, refuse)))) {
    refuse('a retained stream duplicates removed data');
  }
  if (removedRectangleShapes.size) {
    let geometryComparisons = 0;
    for (const stream of retainedStreams) {
      // Inspect the bytes that will actually be saved, not a possibly stale
      // decoded cache. An unparseable survivor could conceal the same geometry.
      let instructions: Instruction[];
      try { instructions = parseStrict(stream.rawBytes, parseBudget); }
      catch (error) {
        if (error instanceof PartialGraphicsRedactionUnsupportedError && error.message.includes('inspection')) throw error;
        return refuse('retained stream syntax cannot be checked for removed vector geometry');
      }
      let matrix = identityMatrix();
      const stack: Matrix[] = [];
      for (const inst of instructions) {
        if (inst.operator === 'q') stack.push({ ...matrix });
        else if (inst.operator === 'Q') {
          const saved = stack.pop();
          if (!saved) refuse('retained graphics state cannot be checked');
          matrix = saved;
        } else if (inst.operator === 'cm') {
          const [a, b, c, d, e, f] = inst.args.map(Number);
          matrix = multiplyMatrices({ a, b, c, d, e, f }, matrix);
          if (!Object.values(matrix).every(Number.isFinite) || !Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) ||
              Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12) refuse('retained graphics transform cannot be checked');
        }
        // A retained path may accumulate multiple rectangles before painting.
        if (inst.operator === 're') {
          if (removedRectangleShapes.has(rectangleSignature(inst))) refuse('a retained stream duplicates removed vector geometry');
          const geometry = rectangleGeometry(inst, matrix);
          for (const shape of removedRectangleGeometry) {
            if (++geometryComparisons > MAX_GEOMETRY_COMPARISONS) refuse('retained vector geometry exceeds the inspection comparison limit');
            if (sameGeometry(shape, geometry)) refuse('a retained stream duplicates removed vector geometry');
          }
        }
      }
      if (stack.length) refuse('retained graphics state cannot be checked');
    }
  }
  for (const key of sensitive.refs) staged.objects.delete(key);
  assertRedactionRewriteSafe(staged, refuse);
  return { edits, removeObjects: [...sensitive.refs], images, paths, annotations };
}
function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, i) => byte === b[i]);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = Object.keys(a), y = Object.keys(b);
  if (x.length !== y.length || x.some((key, i) => key !== y[i])) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return x.every(key => sameSnapshot(left[key], right[key]));
}

/** Removes only whole supported graphics wholly within a marked rectangle.
 * Partial intersections, unsupported syntax, and retained duplicates fail closed. */
export function preparePartialGraphicsRedaction(doc: PDFDocumentData, options: SecureRedactionOptions = {}): { commit(): SecureRedactionResult } {
  const chosen = { ...options };
  plan(doc, chosen);
  const snapshot = dehydrateDocument(doc);
  let committed = false;
  return {
    commit() {
      if (committed) throw new Error('The partial graphics redaction was already committed.');
      if (!sameSnapshot(snapshot, dehydrateDocument(doc))) refuse('the document changed after the redaction was prepared');
      const next = plan(doc, chosen);
      for (const edit of next.edits) {
        const page = doc.pages[edit.index];
        doc.objects.set(edit.newRef.toKey(), edit.content);
        page.dict.set('Contents', edit.newRef);
        page.dict.set('Resources', edit.resources);
        page.dict.delete('Annots');
        page.resources = edit.resources;
        page.contentRefs.splice(0, page.contentRefs.length, edit.newRef);
      }
      for (const key of next.removeObjects) doc.objects.delete(key);
      if (next.edits.length) doc.requiresFullRewrite = true;
      committed = true;
      return { pagesProcessed: next.edits.length, textOperatorsRemoved: 0, imageOperatorsRemoved: next.images,
        pathOperatorsRemoved: next.paths, annotationsRemoved: next.annotations, formFieldsRemoved: 0, metadataStripped: false };
    },
  };
}
