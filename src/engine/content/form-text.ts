import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, type PDFObject, type PDFPageInfo } from '../types';
import { getPageContentBytes, getResource, resolveRef } from '../parser/parser';
import { identityMatrix, multiplyMatrices, transformPoint, type Matrix } from '../render/graphics-state';
import { interpretPage, type ClipPathNode, type TextRun } from './interpreter';
import { parseContentStream } from './operator-lexer';
import type { OptionalContentVisibility } from './optional-content';

export interface ExtractedPageTextRun {
  run: TextRun;
  source: 'page' | 'form';
  runIndex: number;
  /** Page-space rectangle constraining highlights. Null means no safe highlight. */
  highlightClip?: HighlightClip;
}

export type HighlightClip = { x: number; y: number; width: number; height: number } | null;

function clipIntersection(a: HighlightClip | undefined, b: HighlightClip): HighlightClip {
  if (a === null || b === null) return null;
  if (a === undefined) return b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), top = Math.min(a.y + a.height, b.y + b.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : null;
}

/** Only axis-aligned transformed rectangles can constrain an axis-aligned highlight safely. */
function transformedRectangle(values: number[], matrix: Matrix): HighlightClip {
  if (values.length !== 4 || !values.every(Number.isFinite) || !Object.values(matrix).every(Number.isFinite) ||
      !((matrix.b === 0 && matrix.c === 0) || (matrix.a === 0 && matrix.d === 0)) ||
      matrix.a * matrix.d - matrix.b * matrix.c === 0) return null;
  const corners = [transformPoint(matrix, values[0], values[1]), transformPoint(matrix, values[0], values[3]),
    transformPoint(matrix, values[2], values[1]), transformPoint(matrix, values[2], values[3])];
  const xs = corners.map(point => point[0]), ys = corners.map(point => point[1]);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  return [width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}

function pathRectangle(path: ClipPathNode, matrix: Matrix): HighlightClip {
  const segments = path.segments;
  // A close-and-paint operator may add another close to an already closed
  // rectangle. Repeated closes do not change the clipping geometry.
  if (segments.length < 5 || segments[0].type !== 'M' || segments.slice(1, 4).some(segment => segment.type !== 'L') ||
      segments.slice(4).some(segment => segment.type !== 'Z') ||
      segments.slice(0, 4).some(segment => segment.points.length !== 2)) return null;
  const points = segments.slice(0, 4).map(segment => transformPoint(matrix, segment.points[0], segment.points[1]));
  if (points.some(point => !point.every(Number.isFinite))) return null;
  const xs = [...new Set(points.map(point => point[0]))], ys = [...new Set(points.map(point => point[1]))];
  if (xs.length !== 2 || ys.length !== 2 || new Set(points.map(point => `${point[0]},${point[1]}`)).size !== 4 ||
      points.some((point, index) => {
        const next = points[(index + 1) % 4];
        return point[0] !== next[0] && point[1] !== next[1];
      })) return null;
  const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  return [width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Preserve ambiguity when the interpreter omitted degenerate clips or merged
 * text from different clipping states. The graphics-state stack mirrors q/Q. */
function clippingStates(content: Uint8Array, indices: number[]): Map<number, string> {
  const states = new Map<number, string>(), stack: string[] = [];
  if (!indices.length) return states;
  // A Tr operator can add glyph outlines to the clipping path, even without W.
  // A byte check may have false positives in strings, but must never skip Tr.
  let mayClip = content.includes(0x57);
  for (let i = 0; !mayClip && i + 1 < content.length; i++) {
    mayClip = content[i] === 0x54 && content[i + 1] === 0x72;
  }
  if (!mayClip) {
    for (const index of indices) states.set(index, '');
    return states;
  }
  if (content.length > 8 * 1024 * 1024) return states;
  const wanted = new Set(indices);
  let state = '';
  // The current path and pending W/W* are not graphics-state properties:
  // q/Q restores committed clipping, but does not save either one.
  let hasPath = false;
  let pendingClip: number | undefined;
  let instructions: ReturnType<typeof parseContentStream>;
  try { instructions = parseContentStream(content); } catch { return states; }
  if (instructions.length > 100_000) return states;
  for (let i = 0; i < instructions.length; i++) {
    const op = instructions[i].operator;
    if (op === 'q') stack.push(state);
    else if (op === 'Q') state = stack.pop() ?? '?';
    else if (op === 'W' || op === 'W*') pendingClip = i;
    else if (['m', 'l', 'c', 'v', 'y', 'h', 're'].includes(op)) hasPath = true;
    else if (['n', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(op)) {
      // A clipping operator takes effect only when the path terminates. An
      // empty W n has no effect in Poppler; a nonempty zero-area path must
      // still count so its invisible/ambiguous highlight fails closed.
      if (pendingClip !== undefined && hasPath) {
        state = state === '?' || state.length > 512 ? '?' : `${state}/${pendingClip}`;
      }
      pendingClip = undefined;
      hasPath = false;
    }
    else if (op === 'Tr') {
      const value = instructions[i].operands[0];
      if (!(value instanceof PDFNumber) || !Number.isInteger(value.value) || value.value < 0 || value.value > 7 || value.value >= 4) state = '?';
    }
    if (wanted.has(i)) states.set(i, state);
  }
  return states;
}

function applyPaths(clip: HighlightClip | undefined, paths: ClipPathNode[], matrix: Matrix,
  states: Map<number, string>, indices: number[] | undefined): HighlightClip | undefined {
  if (clip === null) return null;
  if (!indices?.length) return null;
  const state = states.get(indices[0]);
  if (state === undefined || state === '?' || indices.some(index => states.get(index) !== state) ||
      (state.match(/\//g)?.length ?? 0) !== paths.length) return null;
  for (const path of paths) clip = clipIntersection(clip, pathRectangle(path, matrix));
  return clip;
}

function resolveGeometry(value: PDFObject, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key) || seen.size >= 128) return undefined;
    seen.add(key);
    const resolved = objects.get(key);
    if (!resolved) return undefined;
    value = resolved;
  }
  return value;
}

function bboxClip(stream: PDFStream, objects: Map<string, PDFObject>, matrix: Matrix): HighlightClip {
  const value = stream.dict.get('BBox');
  const resolved = value ? resolveGeometry(value, objects) : undefined;
  if (!(resolved instanceof PDFArray) || resolved.length !== 4) return null;
  const values = resolved.items.map(item => resolveGeometry(item, objects));
  if (values.some(item => !(item instanceof PDFNumber))) return null;
  return transformedRectangle(values.map(item => (item as PDFNumber).value), matrix);
}

/** Extract Form text without making its stream-local instruction indices editable on the page. */
export function extractPageTextRuns(
  page: PDFPageInfo, objects: Map<string, PDFObject>, visibility: OptionalContentVisibility,
  interpreted: ReturnType<typeof interpretPage>,
): ExtractedPageTextRun[] {
  const runs: ExtractedPageTextRun[] = [];
  const active = new Set<PDFStream>();
  let forms = 0;
  let bytes = 0;

  function visit(current: ReturnType<typeof interpretPage>, parent: PDFPageInfo, parentMatrix: Matrix,
    isForm: boolean, output: ExtractedPageTextRun[], content: Uint8Array,
    inheritedClip: HighlightClip | undefined): void {
    // An invocation occupies a position in its parent's stream. Insert its
    // text there instead of appending every Form after all page text. Use the
    // logical text runs rather than display text, since mixed rendering modes
    // can keep separate paint runs for a single /ActualText replacement.
    const events = [
      ...current.textRuns.map((run, runIndex) => ({
        kind: 'text' as const, run, runIndex, index: run.sourceInstructionIndices?.[0] ?? Infinity,
      })),
      ...current.displayList.filter(item => item.type === 'form').map(item => ({
        kind: 'form' as const, item, index: item.sourceInstructionIndex ?? Infinity,
      })),
    ];
    events.sort((a, b) => a.index - b.index);
    const formEvents = events.filter(event => event.kind === 'form');
    const clipIndices = events.flatMap(event => event.kind === 'form'
      ? event.item.sourceInstructionIndex === undefined ? [] : [event.item.sourceInstructionIndex]
      : isForm ? event.run.sourceInstructionIndices ?? [] : []);
    const states = clippingStates(content, clipIndices);
    const actualSpans = current.actualTextSpans ?? [];
    if (formEvents.length > 512 || (formEvents.length && actualSpans.length > 4096)) {
      throw new Error('Form text extraction exceeded its traversal budget.');
    }
    // Only spans that enclose a Form need this treatment: page-only
    // replacements are already represented by the interpreter's textRuns.
    const candidates = actualSpans.filter(span => formEvents.some(event => event.index > span.start && event.index < span.end))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const spans: typeof candidates = [];
    for (const span of candidates) {
      if (span.incomplete) throw new Error('Unterminated ActualText around a Form cannot be safely searched.');
      if (actualSpans.some(other => other !== span && other.start > span.start && other.start < span.end)) {
        // Nested replacements need separate interpretation; do not report a
        // guessed result or let replace-all edit a partially understood scope.
        throw new Error('Nested ActualText around a Form cannot be safely searched.');
      }
      spans.push(span);
    }
    let spanIndex = 0;
    let pendingSpan: typeof spans[number] | undefined;
    let pendingRuns: ExtractedPageTextRun[] = [];
    const flush = () => {
      if (pendingSpan && pendingRuns.length) {
        const first = pendingRuns[0].run;
        let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
        for (const { run } of pendingRuns) {
          x = Math.min(x, run.x); y = Math.min(y, run.y);
          right = Math.max(right, run.x + run.width); top = Math.max(top, run.y + run.height);
        }
        const firstClip = pendingRuns[0].highlightClip;
        const commonClip = pendingRuns.every(entry => {
          const clip = entry.highlightClip;
          return firstClip === undefined ? clip === undefined : firstClip !== null && clip !== null && clip !== undefined &&
            clip.x === firstClip.x && clip.y === firstClip.y && clip.width === firstClip.width && clip.height === firstClip.height;
        }) ? firstClip : null;
        output.push({ source: 'form', runIndex: -1, highlightClip: commonClip, run: { ...first, text: pendingSpan.text,
          actualText: true, actualTextLayout: undefined, glyphs: [], x, y, width: right - x, height: top - y } });
      }
      pendingSpan = undefined;
      pendingRuns = [];
    };
    for (const event of events) {
      while (spanIndex < spans.length && event.index >= spans[spanIndex].end) spanIndex++;
      const scope = spans[spanIndex] && event.index > spans[spanIndex].start && event.index < spans[spanIndex].end
        ? spans[spanIndex] : undefined;
      if (scope !== pendingSpan) { flush(); pendingSpan = scope; }
      const sink = scope ? pendingRuns : output;
      if (event.kind === 'text') {
        sink.push({ run: isForm ? transformRun(event.run, parentMatrix) : event.run,
          source: isForm ? 'form' : 'page', runIndex: isForm ? -1 : event.runIndex,
          highlightClip: isForm ? event.run.softMask ? null : applyPaths(inheritedClip, event.run.clipPaths, parentMatrix, states,
            event.run.sourceInstructionIndices) : undefined });
        continue;
      }
      const item = event.item;
      const stream = getResource(parent.resources, 'XObject', item.name, objects);
      if (!(stream instanceof PDFStream) || stream.dict.getName('Subtype') !== 'Form') continue;
      if (active.has(stream)) continue;
      if (active.size >= 32 || ++forms > 512) throw new Error('Form text extraction exceeded its traversal budget.');
      const content = stream.getBytes();
      bytes += content.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Form text extraction exceeded its byte budget.');
      // Session transactions clone raw and decoded arrays independently. Detect
      // the parser's raw-byte fallback by value as well as by object identity.
      if (stream.getFilters().length && (!stream.decodedBytes ||
        (stream.rawBytes.length === stream.decodedBytes.length &&
          stream.rawBytes.every((byte, index) => byte === stream.decodedBytes![index])))) {
        throw new Error('Form text extraction requires a decoded stream.');
      }
      const matrixObj = stream.dict.get('Matrix');
      const resolvedMatrix = matrixObj === undefined ? undefined : resolveGeometry(matrixObj, objects);
      if (matrixObj !== undefined && !(resolvedMatrix instanceof PDFArray)) throw new Error('Invalid Form matrix.');
      const matrixValues = resolvedMatrix instanceof PDFArray
        ? resolvedMatrix.items.map(item => resolveGeometry(item, objects)).map(item => item instanceof PDFNumber ? item.value : NaN)
        : [1, 0, 0, 1, 0, 0];
      if (matrixValues.length !== 6 || matrixValues.some(value => !Number.isFinite(value))) throw new Error('Invalid Form matrix.');
      const [a, b, c, d, e, f] = matrixValues;
      const matrix = multiplyMatrices(multiplyMatrices({ a, b, c, d, e, f }, item.ctm), parentMatrix);
      const itemClip = applyPaths(inheritedClip, item.clipPaths, parentMatrix, states,
        item.sourceInstructionIndex === undefined ? undefined : [item.sourceInstructionIndex]);
      const nextClip = item.softMask ? null : clipIntersection(itemClip, bboxClip(stream, objects, matrix));
      const resourcesRef = stream.dict.get('Resources');
      const resolved = resourcesRef ? resolveRef(resourcesRef, objects) : parent.resources;
      if (!(resolved instanceof PDFDict)) throw new Error('Invalid Form resources.');
      const formPage = { ...parent, resources: resolved };
      active.add(stream);
      try {
        const nested = interpretPage(content, formPage, objects, visibility, item.renderingMode ?? 0, undefined,
          { includeImageResourceVersions: false });
        const previousLength = sink.length;
        visit(nested, formPage, matrix, true, sink, content, nextClip);
        if (scope) {
          for (let i = previousLength; i < sink.length; i++) {
            if (sink[i].run.actualText) throw new Error('Nested ActualText around a Form cannot be safely searched.');
          }
        }
      } finally {
        active.delete(stream);
      }
    }
    flush();
  }
  visit(interpreted, page, identityMatrix(), false, runs, getPageContentBytes(page, objects), undefined);
  return runs;
}

function transformRun(run: TextRun, matrix: Matrix): TextRun {
  const points = [transformPoint(matrix, run.x, run.y), transformPoint(matrix, run.x + run.width, run.y),
    transformPoint(matrix, run.x, run.y + run.height), transformPoint(matrix, run.x + run.width, run.y + run.height)];
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { ...run, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y,
    textMatrix: multiplyMatrices(run.textMatrix, matrix),
    glyphs: run.glyphs.map(glyph => {
      const [gx, gy] = transformPoint(matrix, glyph.x, glyph.y);
      return { ...glyph, x: gx, y: gy, width: glyph.width * Math.hypot(matrix.a, matrix.b),
        tRm: multiplyMatrices(glyph.tRm, matrix) };
    }) };
}
