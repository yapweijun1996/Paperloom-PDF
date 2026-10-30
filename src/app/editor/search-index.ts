import type { PDFDocumentData, TextRun } from '@/engine/browser-core';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFStream, PDFString, type PDFObject } from '@/engine/types';
import { dehydrateDocument, hydrateDocument, sameDocumentSnapshot, type WireDocument } from '@/engine/worker/codec';
import type { TextEdit } from '@/engine/editor/text-editor';
import { captureSearchShell, equalSearchShell, hydrateSearchShell, LazySearchBudgetExceeded, SearchScanCancelled, searchByteLength, searchRootEstimate, standardSearchObject, standardSearchRoots,
  type SearchShell, type StreamDependencies } from './lazy-search-snapshot';

type SearchEngine = Pick<typeof import('@/engine/browser-core'), 'getPageContentBytes' | 'interpretPage' | 'OptionalContentVisibility' | 'extractPageTextRuns'>;

export interface SearchMatch {
  id: string;
  pageIndex: number;
  pageKey: string;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
  matchedText: string;
  runText: string;
  runIndex: number;
  source: 'page' | 'form' | 'cross-run';
  start: number;
  end: number;
  parts?: SearchMatchPart[];
  /** False retains the navigable match without drawing an unsafe highlight. */
  highlightVisible?: boolean;
  /** Clipped highlights must not grow beyond their PDF-space rectangle. */
  highlightClipped?: boolean;
  /** Independently clipped pieces of one cross-run match, in page space. */
  highlightRects?: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface SearchMatchPart {
  source: 'page' | 'form';
  runIndex: number;
  runText: string;
  start: number;
  end: number;
}

interface SearchRun {
  source: 'page' | 'form';
  runIndex: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  positions?: Float64Array;
  /** Present only for positively oriented, unambiguous horizontal glyphs. */
  crossBaseline?: number;
  crossSize?: number;
  /** Verified rotated baselines are searchable, but cannot yet be highlighted. */
  rotatedBaseline?: { x: number; y: number; endX: number; endY: number; ux: number; uy: number; size: number };
  /** The axis-aligned run bounds cannot safely position a highlight. */
  unreliableHighlight: boolean;
  renderingMode?: number;
  highlightClip?: { x: number; y: number; width: number; height: number } | null;
}

interface CachedPage {
  runs: SearchRun[];
}
interface LazyCache { shell: SearchShell; dependencies: StreamDependencies; pages: Map<string, CachedPage>; bytes: number }
interface LazyRun { epoch: number; shell: SearchShell; dependencies: StreamDependencies; pages: Map<string, CachedPage>; bytes: number }

/** Keep only search geometry, bounded by an estimated retained-data budget. */
export class DocumentSearchIndex {
  private document: PDFDocumentData | null = null;
  private revision = '';
  private snapshot: WireDocument | null = null;
  private pages = new Map<string, CachedPage>();
  private retainedBytes = 0;
  private epoch = 0;
  private lazyCache: LazyCache | null = null;

  constructor(private readonly byteLimit = 32 * 1024 * 1024) {}

  clear(): void {
    this.epoch++;
    this.lazyCache = null;
    this.document = null;
    this.revision = '';
    this.snapshot = null;
    this.pages.clear();
    this.retainedBytes = 0;
  }

  reset(doc: PDFDocumentData, revision: string): void {
    if (this.document === doc && this.revision === revision) return;
    this.document = doc;
    this.revision = revision;
    this.lazyCache = null;
    this.snapshot = null;
    this.pages.clear();
    this.retainedBytes = 0;
  }

  /** Compare an exact, bounded graph snapshot, including decoded stream bytes. */
  begin(doc: PDFDocumentData, revision: string, isCurrent?: () => boolean): WireDocument | null {
    this.epoch++;
    this.reset(doc, revision);
    const current = searchSnapshot(doc, isCurrent);
    if (!current || (this.snapshot && !sameSearchSnapshot(this.snapshot, current))) {
      this.pages.clear();
      this.retainedBytes = 0;
    }
    this.snapshot = current;
    if (current) this.lazyCache = null;
    return current;
  }

  unchanged(doc: PDFDocumentData, baseline: WireDocument, isCurrent?: () => boolean): boolean {
    const current = searchSnapshot(doc, isCurrent);
    return !!current && sameSearchSnapshot(baseline, current);
  }

  /** A concurrent search may have replaced this index's snapshot and cache. */
  owns(snapshot: WireDocument): boolean { return this.snapshot === snapshot; }

  beginLazy(shell: SearchShell): LazyRun {
    const cached = this.lazyCache;
    const reuse = cached && equalSearchShell(cached.shell, shell, cached.dependencies) ? cached : null;
    if (!reuse) this.lazyCache = null;
    return { epoch: this.epoch, shell, dependencies: new Map(reuse?.dependencies),
      pages: new Map(reuse?.pages), bytes: reuse?.bytes ?? 0 };
  }

  ownsLazy(run: LazyRun): boolean { return this.epoch === run.epoch; }

  lazyPage(run: LazyRun, doc: PDFDocumentData, index: number, engine: SearchEngine,
    visibility: InstanceType<SearchEngine['OptionalContentVisibility']>): SearchRun[] {
    const page = doc.pages[index], key = page.ref.toKey();
    const cached = run.pages.get(key);
    if (cached) return cached.runs;
    const runs = readSearchPage(doc, index, engine, visibility);
    const size = runs.reduce((sum, value) => sum + 128 + value.text.length * 2 + (value.positions?.byteLength ?? 0), 0);
    if (size <= this.byteLimit - run.bytes) { run.pages.set(key, { runs }); run.bytes += size; }
    return runs;
  }

  commitLazy(run: LazyRun): void {
    if (!this.ownsLazy(run)) throw new SearchChangedError();
    this.lazyCache = { shell: run.shell, dependencies: run.dependencies, pages: run.pages, bytes: run.bytes };
  }

  /** Entries never outlive their owning document or edit revision. */
  page(doc: PDFDocumentData, index: number, engine: SearchEngine, visibility: InstanceType<SearchEngine['OptionalContentVisibility']>, cacheable: boolean): SearchRun[] {
    const page = doc.pages[index];
    const key = page.ref.toKey();
    const cached = cacheable ? this.pages.get(key) : undefined;
    if (cached) return cached.runs;
    const runs = readSearchPage(doc, index, engine, visibility);
    const size = runs.reduce((sum, run) => sum + 128 + run.text.length * 2 + (run.positions?.byteLength ?? 0), 0);
    if (cacheable && size <= this.byteLimit - this.retainedBytes) {
      this.pages.set(key, { runs });
      this.retainedBytes += size;
    }
    return runs;
  }

  /** Approximate index size; JavaScript object overhead varies by runtime. */
  getCachedBytes(): number { return this.lazyCache?.bytes ?? this.retainedBytes; }
}

function readSearchPage(doc: PDFDocumentData, index: number, engine: SearchEngine,
  visibility: InstanceType<SearchEngine['OptionalContentVisibility']>): SearchRun[] {
  const page = doc.pages[index];
  const bytes = engine.getPageContentBytes(page, doc.objects);
  const interpreted = engine.interpretPage(bytes, page, doc.objects, visibility, 0, undefined,
    { includeImageResourceVersions: false });
  return engine.extractPageTextRuns(page, doc.objects, visibility, interpreted)
    .map(entry => compactRun(entry.run, entry.source, entry.runIndex, entry.highlightClip));
}

// Limit the snapshots used for cache validation. Larger graphs are scanned
// synchronously without caching, avoiding unbounded copies and stale results.
const SNAPSHOT_BUDGET = 8 * 1024 * 1024;
const SHARED_SCAN_OBJECT_LIMIT = 250_000;
const SHARED_SCAN_STEP_LIMIT = 500_000;
const SHARED_SCAN_DEPTH_LIMIT = 4_096;

// Shared stream bytes can change from another thread even while JavaScript is
// scanning a page synchronously. A before/after comparison cannot detect a
// transient change, so refuse them rather than publish an inconsistent result.
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(typedArrayBuffer.call(new Uint8Array(0))), 'byteLength',
)!.get!;
function isShared(bytes: Uint8Array | null): boolean {
  if (!bytes) return false;
  let buffer: ArrayBufferLike;
  try { buffer = typedArrayBuffer.call(bytes) as ArrayBufferLike; }
  catch { throw new Error('Search cannot safely inspect stream buffers.'); }
  // The ArrayBuffer getter rejects SharedArrayBuffer, even across realms and
  // when this realm does not expose a SharedArrayBuffer constructor.
  try { arrayBufferByteLength.call(buffer); return false; } catch { return true; }
}

function assertUnsharedStreams(doc: PDFDocumentData, isCurrent: () => boolean): boolean {
  // Custom containers or PDF objects can hide buffers or synthesize bytes.
  if (!standardSearchRoots(doc, isCurrent)) throw new Error('Search cannot safely inspect custom document containers.');
  function* roots(): Generator<PDFObject> {
    yield* doc.objects.values();
    yield doc.catalog;
    yield doc.xref.trailerDict;
    for (const page of doc.pages) {
      yield page.dict;
      yield page.resources;
      yield* page.contentRefs;
    }
  }
  const seen = new WeakSet<object>();
  const pending: Iterator<PDFObject>[] = [roots()];
  let steps = 0, objects = 0;
  while (pending.length) {
    if (++steps > SHARED_SCAN_STEP_LIMIT || pending.length > SHARED_SCAN_DEPTH_LIMIT) {
      throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    }
    if ((steps & 2047) === 0 && !isCurrent()) return false;
    const next = pending[pending.length - 1].next();
    if (next.done) { pending.pop(); continue; }
    const obj = next.value;
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (++objects > SHARED_SCAN_OBJECT_LIMIT) throw new Error('Search graph exceeds the shared-buffer inspection limit.');
    if (!standardSearchObject(obj, isCurrent)) throw new Error('Search cannot safely inspect custom PDF objects.');
    if (obj instanceof PDFStream) {
      if (isShared(obj.rawBytes) || isShared(obj.decodedBytes)) {
        throw new Error('Search cannot safely inspect shared stream buffers.');
      }
      pending.push([obj.dict][Symbol.iterator]());
    } else if (obj instanceof PDFArray) pending.push(obj.items[Symbol.iterator]());
    else if (obj instanceof PDFDict) pending.push(obj.values());
  }
  return true;
}

function searchSnapshot(doc: PDFDocumentData, isCurrent?: () => boolean): WireDocument | null {
  let estimated = searchRootEstimate(doc, isCurrent);
  if (estimated === null || estimated > SNAPSHOT_BUDGET || !standardSearchRoots(doc, isCurrent)) return null;
  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [...doc.objects.values(), doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) {
    pending.push(page.dict, page.resources, page.ref);
    for (const ref of page.contentRefs) pending.push(ref);
  }
  while (pending.length) {
    const obj = pending.pop()!;
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (!standardSearchObject(obj, isCurrent)) return null;
    estimated += 64;
    if (obj instanceof PDFStream) {
      estimated += searchByteLength(obj.rawBytes) + (obj.decodedBytes ? searchByteLength(obj.decodedBytes) : 0);
      pending.push(obj.dict);
    } else if (obj instanceof PDFArray) {
      estimated += obj.items.length * 16;
      if (estimated > SNAPSHOT_BUDGET) return null;
      for (const item of obj.items) pending.push(item);
    } else if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        estimated += key.length * 2 + 24;
        pending.push(value);
      }
    } else if (obj instanceof PDFString) estimated += obj.value.length * 2;
    else if (obj instanceof PDFHexString) estimated += obj.hex.length * 2;
    else if (obj instanceof PDFName) estimated += obj.name.length * 2;
    if (estimated > SNAPSHOT_BUDGET) return null;
  }
  try { return dehydrateDocument(doc, { includeRawBytes: false }); }
  catch { return null; } // Preserve ordinary search for graphs the snapshotter cannot represent.
}

function sameSearchSnapshot(left: WireDocument, right: WireDocument): boolean {
  if (!sameDocumentSnapshot(left, right) || left.nodes.length !== right.nodes.length) return false;
  for (let i = 0; i < left.nodes.length; i++) {
    const a = left.nodes[i], b = right.nodes[i];
    if (a.kind !== 'stream' || b.kind !== 'stream') continue;
    const x = a.decodedBytes, y = b.decodedBytes;
    if (x === null || y === null) { if (x !== y) return false; continue; }
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

function compactRun(run: TextRun, source: 'page' | 'form', runIndex: number,
  highlightClip?: SearchRun['highlightClip']): SearchRun {
  const effectiveClip = highlightClip === undefined && run.clipPaths.length ? null : highlightClip;
  let positions: Float64Array | undefined;
  if (run.glyphs && run.glyphs.length === run.text.length) {
    positions = new Float64Array(run.glyphs.length * 2);
    for (let i = 0; i < run.glyphs.length; i++) {
      positions[i * 2] = run.glyphs[i].x;
      positions[i * 2 + 1] = run.glyphs[i].width;
    }
  }
  const glyphs = run.glyphs;
  // Run bounds and glyph.width only describe positively oriented horizontal
  // text. This check must not depend on whether glyphs form a contiguous chain:
  // rotated, spaced, clipped, Form or multi-codepoint text can still match.
  const matrices = glyphs.length ? glyphs.map(glyph => glyph.tRm) : [run.textMatrix];
  const unreliableHighlight = (run.actualText === true && glyphs.length === 0) || matrices.some(({ a, b, c, d }) =>
    ![a, b, c, d].every(Number.isFinite) || a <= 0 || d <= 0 || b !== 0 || c !== 0);
  let crossBaseline: number | undefined, crossSize: number | undefined;
  let rotatedBaseline: SearchRun['rotatedBaseline'];
  if (!run.actualText && positions && glyphs.length > 0 &&
      glyphs.every(g => g.unicode.length === 1) && glyphs.map(g => g.unicode).join('') === run.text &&
      glyphs.every(g => {
        const { a, b, c, d } = g.tRm;
        const scale = Math.max(Math.abs(a), Math.abs(d), 1);
        return [g.x, g.y, g.width, g.fontSize, a, b, c, d].every(Number.isFinite) &&
          g.width > 0 && g.fontSize > 0 && a > 0 && d > 0 &&
          Math.abs(b) <= scale * 1e-7 && Math.abs(c) <= scale * 1e-7;
      })) {
    const first = glyphs[0];
    const tolerance = Math.max(0.05, first.fontSize * 0.02);
    if (glyphs.every((g, i) => Math.abs(g.y - first.y) <= tolerance &&
        (!i || Math.abs(g.x - (glyphs[i - 1].x + glyphs[i - 1].width)) <= tolerance))) {
      crossBaseline = first.y;
      crossSize = first.fontSize;
    }
  }
  // A rotated glyph's x width and the run's axis-aligned bounds are not reliable.
  // Check each glyph advance in two dimensions, and only join unambiguous,
  // unclipped page runs. The result is deliberately not used as a highlight.
  if (!run.actualText && source === 'page' && effectiveClip === undefined && glyphs.length > 0 &&
      glyphs.length === run.text.length && glyphs.every(g => g.unicode.length === 1) &&
      glyphs.map(g => g.unicode).join('') === run.text) {
    const first = glyphs[0], m = first.tRm;
    const size = Math.hypot(m.a, m.b), vertical = Math.hypot(m.c, m.d);
    const ux = m.a / size, uy = m.b / size;
    const tolerance = Math.max(0.05, Math.min(size, vertical) * 0.02);
    const rotated = size > 0 && vertical > 0 && (Math.abs(uy) > 1e-7 || ux < 0) &&
      Math.abs(m.a * m.c + m.b * m.d) <= size * vertical * 1e-7 && m.a * m.d - m.b * m.c > 0;
    if (rotated && glyphs.every((g, i) => {
      const t = g.tRm, length = Math.hypot(t.a, t.b), height = Math.hypot(t.c, t.d);
      if (![g.x, g.y, g.textSpaceWidth, t.a, t.b, t.c, t.d, t.e, t.f, length, height].every(Number.isFinite) ||
          length <= 0 || height <= 0 || g.textSpaceWidth <= 0 ||
          Math.abs(t.a / length - ux) > 1e-7 || Math.abs(t.b / length - uy) > 1e-7 ||
          Math.abs(t.a * t.c + t.b * t.d) > length * height * 1e-7 || t.a * t.d - t.b * t.c <= 0 ||
          Math.abs(g.x - t.e) > tolerance || Math.abs(g.y - t.f) > tolerance) return false;
      if (!i) return true;
      const previous = glyphs[i - 1];
      return Math.hypot(g.x - previous.x - previous.tRm.a * previous.textSpaceWidth,
        g.y - previous.y - previous.tRm.b * previous.textSpaceWidth) <= tolerance;
    })) {
      const last = glyphs[glyphs.length - 1];
      rotatedBaseline = { x: first.x, y: first.y, endX: last.x + last.tRm.a * last.textSpaceWidth,
        endY: last.y + last.tRm.b * last.textSpaceWidth, ux, uy, size: Math.min(size, vertical) };
    }
  }
  return { source, runIndex, text: run.text, x: run.x, y: run.y, width: run.width, height: run.height,
    fontSize: run.fontSize, positions, crossBaseline, crossSize, rotatedBaseline, unreliableHighlight, renderingMode: run.renderingMode, highlightClip: effectiveClip };
}

function clipMatch(match: SearchMatch, clips: Array<SearchRun['highlightClip']>): SearchMatch {
  if (match.highlightVisible === false) return match;
  if (clips.every(clip => clip === undefined)) return match;
  if (clips.some(clip => clip === null)) return { ...match, highlightVisible: false, highlightClipped: true };
  let x = match.pdfX, y = match.pdfY, right = x + match.pdfWidth, top = y + match.pdfHeight;
  for (const clip of clips) {
    if (!clip) continue;
    x = Math.max(x, clip.x); y = Math.max(y, clip.y);
    right = Math.min(right, clip.x + clip.width); top = Math.min(top, clip.y + clip.height);
  }
  if (!(right > x && top > y)) return { ...match, highlightVisible: false, highlightClipped: true };
  return { ...match, pdfX: x, pdfY: y, pdfWidth: right - x, pdfHeight: top - y, highlightVisible: true, highlightClipped: true };
}

function clipCrossMatch(match: SearchMatch, hit: RunMatch, runs: SearchRun[]): SearchMatch {
  const involved = runs.slice(hit.first, hit.last + 1);
  if (involved.some(run => run.unreliableHighlight)) return { ...match, highlightVisible: false };
  if (involved.every(run => run.highlightClip === undefined)) return match;
  const rectangles: NonNullable<SearchMatch['highlightRects']> = [];
  for (let i = hit.first; i <= hit.last; i++) {
    const run = runs[i], start = i === hit.first ? hit.start : 0, end = i === hit.last ? hit.end : run.text.length;
    const x = run.positions![start * 2];
    const right = run.positions![(end - 1) * 2] + run.positions![(end - 1) * 2 + 1];
    const part = { ...match, pdfX: x, pdfY: run.y, pdfWidth: right - x, pdfHeight: run.height || run.fontSize || 12 };
    const safe = clipMatch(part, [run.highlightClip]);
    if (safe.highlightVisible === false) continue;
    rectangles.push({ x: safe.pdfX, y: safe.pdfY, width: safe.pdfWidth, height: safe.pdfHeight });
  }
  // Even when each piece fits its own clip, a combined rectangle can cross the
  // uncovered gap between two different clips. Keep every piece separate.
  return { ...match, highlightVisible: rectangles.length > 0, highlightClipped: true, highlightRects: rectangles };
}

interface RunMatch { first: number; last: number; start: number; end: number; text: string }

function matchParts(hit: RunMatch, runs: SearchRun[]): SearchMatchPart[] {
  return runs.slice(hit.first, hit.last + 1).map((run, index, selected) => ({
    source: run.source, runIndex: run.runIndex, runText: run.text,
    start: index === 0 ? hit.start : 0,
    end: index === selected.length - 1 ? hit.end : run.text.length,
  }));
}
const MAX_SEARCH_MATCHES = 50_000;
const CROSS_RUN_LIMIT = 50_000;
const CROSS_TEXT_LIMIT = 262_144;
const CROSS_QUERY_LIMIT = 1_024;
const CROSS_WORK_LIMIT = 16_777_216;

function adjacent(a: SearchRun, b: SearchRun): boolean {
  if (a.rotatedBaseline && b.rotatedBaseline && a.renderingMode === b.renderingMode) {
    const left = a.rotatedBaseline, right = b.rotatedBaseline;
    const tolerance = Math.max(0.05, Math.min(left.size, right.size) * 0.02);
    return Math.abs(left.ux - right.ux) <= 1e-7 && Math.abs(left.uy - right.uy) <= 1e-7 &&
      Math.hypot(right.x - left.endX, right.y - left.endY) <= tolerance;
  }
  if (a.crossBaseline === undefined || b.crossBaseline === undefined || !a.positions || !b.positions ||
      a.crossSize === undefined || b.crossSize === undefined || a.renderingMode !== b.renderingMode) return false;
  const tolerance = Math.max(0.05, Math.min(a.crossSize, b.crossSize) * 0.02);
  const end = a.positions[a.positions.length - 2] + a.positions[a.positions.length - 1];
  return Math.abs(a.crossBaseline - b.crossBaseline) <= tolerance && Math.abs(b.positions[0] - end) <= tolerance;
}

const SEARCH_TICK = Symbol('search-tick');

// Restrict each RegExp scan to a small window so even a long run with no
// matches can yield. Overlap covers a complete Unicode literal match; window
// edges never split a surrogate pair. Only matches starting before the next
// boundary are emitted, preserving the RegExp global non-overlap contract.
function* matchText(text: string, regex: RegExp, queryLength: number): Generator<RegExpMatchArray | typeof SEARCH_TICK> {
  const chunk = 8192;
  const pairBoundary = (offset: number): number => {
    if (offset > 0 && offset < text.length) {
      const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
      if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) return offset + 1;
    }
    return offset;
  };
  let position = 0;
  while (position < text.length) {
    const boundary = pairBoundary(Math.min(text.length, position + chunk));
    const end = pairBoundary(Math.min(text.length, boundary + queryLength * 2 + 2));
    let next = boundary;
    for (const match of text.slice(position, end).matchAll(regex)) {
      const start = position + match.index!;
      if (start >= boundary) break;
      match.index = start;
      next = Math.max(next, start + match[0].length);
      yield match;
    }
    position = next;
    if (position < text.length) yield SEARCH_TICK;
  }
}

/** Match each contiguous chain once, preserving non-overlap and UTF-16 offsets. */
function* findRunMatches(runs: SearchRun[], query: string, caseSensitive: boolean): Generator<RunMatch | null | typeof SEARCH_TICK> {
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  let inspectedRuns = 0, inspectedText = 0, inspectedWork = 0;
  for (let start = 0; start < runs.length;) {
    let end = start + 1;
    if (query.length > 1) while (end < runs.length && adjacent(runs[end - 1], runs[end])) {
      end++;
      if (inspectedRuns + end - start > CROSS_RUN_LIMIT) throw new Error('Cross-run search exceeds its inspection limit.');
      if ((end & 15) === 0) yield SEARCH_TICK;
    }
    if (end - start > 1) {
      inspectedRuns += end - start;
      if (inspectedRuns > CROSS_RUN_LIMIT || query.length > CROSS_QUERY_LIMIT) throw new Error('Cross-run search exceeds its inspection limit.');
      const offsets = [0];
      for (let i = start; i < end; i++) {
        offsets.push(offsets[offsets.length - 1] + runs[i].text.length);
        if (offsets[offsets.length - 1] > CROSS_TEXT_LIMIT) throw new Error('Cross-run search exceeds its inspection limit.');
        if ((i & 15) === 15) yield SEARCH_TICK;
      }
      const length = offsets[offsets.length - 1];
      inspectedText += length;
      inspectedWork += length * query.length;
      if (inspectedText > CROSS_TEXT_LIMIT || inspectedWork > CROSS_WORK_LIMIT) throw new Error('Cross-run search exceeds its inspection limit.');
      const text = runs.slice(start, end).map(run => run.text).join('');
      let first = 0, last = 0;
      for (const match of matchText(text, regex, query.length)) {
        if (match === SEARCH_TICK) { yield SEARCH_TICK; continue; }
        const from = match.index!, to = from + match[0].length;
        while (first + 1 < offsets.length && offsets[first + 1] <= from) first++;
        if (last < first) last = first;
        while (last + 1 < offsets.length && offsets[last + 1] < to) last++;
        yield { first: start + first, last: start + last,
          start: from - offsets[first], end: to - offsets[last], text: match[0] };
      }
    } else {
      for (const match of matchText(runs[start].text, regex, query.length)) {
        if (match === SEARCH_TICK) { yield SEARCH_TICK; continue; }
        yield { first: start, last: start, start: match.index!,
          end: match.index! + match[0].length, text: match[0] };
      }
    }
    start = end;
    yield null;
  }
}

/** Yield between pages to let input, painting and cancellation run. */
async function searchDocumentInternal(
  doc: PDFDocumentData,
  query: string,
  caseSensitive: boolean,
  revision: string,
  index: DocumentSearchIndex,
  engine: SearchEngine,
  isCurrent: () => boolean,
  yieldControl: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
  sliceMs = 8,
  onPublish: ((matches: SearchMatch[]) => void) | undefined,
  forceSynchronous: boolean,
): Promise<SearchMatch[] | null> {
  if (!isCurrent()) return null;
  if (!query) { onPublish?.([]); return []; }
  if (query.length > CROSS_QUERY_LIMIT) throw new Error('Search query exceeds the supported length.');
  try { if (!assertUnsharedStreams(doc, isCurrent)) return null; }
  catch (error) { if (!(error instanceof SearchScanCancelled)) index.clear(); throw error; }
  const snapshot = forceSynchronous ? null : index.begin(doc, revision, isCurrent);
  const shell = !snapshot && !forceSynchronous ? captureSearchShell(doc, isCurrent) : null;
  const lazy = shell ? index.beginLazy(shell) : null;
  // Payloads are copied only if search reads them; the final validation checks
  // every dependency against the source graph before caching or publication.
  let lazyFailure: unknown;
  const scanDoc = snapshot ? hydrateDocument(snapshot) : lazy ? hydrateSearchShell(lazy.shell, lazy.dependencies,
    error => { lazyFailure ??= error; }) : doc;
  const visibility = new engine.OptionalContentVisibility(scanDoc.catalog, scanDoc.objects);
  const matches: SearchMatch[] = [];
  let sliceStart = performance.now();
  for (let pageIndex = 0; pageIndex < scanDoc.pages.length; pageIndex++) {
    if (!isCurrent()) return null;
    if ((snapshot && !index.owns(snapshot)) || (lazy && !index.ownsLazy(lazy))) throw new SearchChangedError();
    const page = scanDoc.pages[pageIndex];
    let runs: SearchRun[];
    try {
      runs = lazy ? index.lazyPage(lazy, scanDoc, pageIndex, engine, visibility)
        : index.page(scanDoc, pageIndex, engine, visibility, !!snapshot);
      if (lazyFailure) throw lazyFailure;
    } catch (error) {
      if (error instanceof LazySearchBudgetExceeded) {
        index.clear();
        return searchDocumentInternal(doc, query, caseSensitive, revision, index, engine, isCurrent,
          yieldControl, sliceMs, onPublish, true);
      }
      throw new SearchPageError(pageIndex, error);
    }
    let work = 0;
    try {
      // A snapshot permits yielding within a page without reading transient live state.
      for (const hit of findRunMatches(runs, query, caseSensitive)) {
        if ((snapshot || lazy) && (hit === SEARCH_TICK || (++work & 127) === 0) && performance.now() - sliceStart >= sliceMs) {
          await yieldControl();
          if (!isCurrent()) return null;
          if ((snapshot && !index.owns(snapshot)) || (lazy && !index.ownsLazy(lazy))) throw new SearchChangedError();
          sliceStart = performance.now();
        }
        if (!hit || hit === SEARCH_TICK) continue;
        if (matches.length >= MAX_SEARCH_MATCHES) throw new SearchResultLimitError(pageIndex);
        if (hit.first === hit.last) {
          const run = runs[hit.first], start = hit.start, end = hit.end;
          let x = run.x;
          let width = run.width;
          if (run.source === 'page' && run.positions && end > start) {
            x = run.positions[start * 2];
            width = run.positions[(end - 1) * 2] + run.positions[(end - 1) * 2 + 1] - x;
          } else if (run.source === 'page' && run.text.length) {
            const charWidth = run.width / run.text.length;
            x += start * charWidth;
            width = (end - start) * charWidth;
          }
          matches.push(clipMatch({ id: `m-${pageIndex}-${start}-${matches.length}`, pageIndex, pageKey: page.ref.toKey(), pdfX: x,
            pdfY: run.y, pdfWidth: Math.max(width, 3), pdfHeight: run.height || run.fontSize || 12,
            matchedText: hit.text, runText: run.text, source: run.source, runIndex: run.runIndex, start, end,
            ...(run.unreliableHighlight ? { highlightVisible: false } : {}) }, [run.highlightClip]));
          continue;
        }
        const first = runs[hit.first], last = runs[hit.last];
        if (first.rotatedBaseline) {
          matches.push({ id: `m-${pageIndex}-cross-${matches.length}`, pageIndex, pageKey: page.ref.toKey(),
            pdfX: first.rotatedBaseline.x, pdfY: first.rotatedBaseline.y, pdfWidth: 0, pdfHeight: 0,
            matchedText: hit.text, runText: hit.text, source: 'cross-run', runIndex: -1, start: 0, end: hit.text.length,
            parts: matchParts(hit, runs), highlightVisible: false });
          continue;
        }
        const x = first.positions![hit.start * 2];
        const right = last.positions![(hit.end - 1) * 2] + last.positions![(hit.end - 1) * 2 + 1];
        let y = Infinity, top = -Infinity;
        for (let i = hit.first; i <= hit.last; i++) {
          y = Math.min(y, runs[i].y);
          top = Math.max(top, runs[i].y + (runs[i].height || runs[i].fontSize || 12));
        }
        matches.push(clipCrossMatch({
          id: `m-${pageIndex}-cross-${matches.length}`, pageIndex, pageKey: page.ref.toKey(),
          pdfX: x, pdfY: y, pdfWidth: Math.max(right - x, 3), pdfHeight: top - y,
          matchedText: hit.text, runText: hit.text, source: 'cross-run', runIndex: -1, start: 0, end: hit.text.length,
          parts: matchParts(hit, runs),
        }, hit, runs));
      }
    } catch (error) {
      if (error instanceof SearchChangedError || error instanceof SearchPageError || error instanceof SearchScanCancelled) throw error;
      throw new SearchPageError(pageIndex, error);
    }
    if ((snapshot || lazy) && performance.now() - sliceStart >= sliceMs && pageIndex + 1 < scanDoc.pages.length) {
      await yieldControl();
      if (!isCurrent()) return null;
      if ((snapshot && !index.owns(snapshot)) || (lazy && !index.ownsLazy(lazy))) throw new SearchChangedError();
      sliceStart = performance.now();
    }
  }
  if (!isCurrent()) return null;
  if ((snapshot && !index.owns(snapshot)) || (lazy && !index.ownsLazy(lazy))) throw new SearchChangedError();
  try { if (!assertUnsharedStreams(doc, isCurrent)) return null; }
  catch (error) { if (!(error instanceof SearchScanCancelled)) index.clear(); throw error; }
  if (snapshot && !index.unchanged(doc, snapshot, isCurrent)) {
    index.clear();
    throw new SearchChangedError();
  }
  if (lazy) {
    const current = captureSearchShell(doc, isCurrent);
    if (!current || !equalSearchShell(lazy.shell, current, lazy.dependencies)) {
      index.clear();
      throw new SearchChangedError();
    }
    index.commitLazy(lazy);
  }
  // Publish in the same turn as the final validation, including uncached scans.
  onPublish?.(matches);
  return matches;
}

export function searchDocument(
  doc: PDFDocumentData, query: string, caseSensitive: boolean, revision: string,
  index: DocumentSearchIndex, engine: SearchEngine, isCurrent: () => boolean,
  yieldControl: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
  sliceMs = 8, onPublish?: (matches: SearchMatch[]) => void,
): Promise<SearchMatch[] | null> {
  return searchDocumentInternal(doc, query, caseSensitive, revision, index, engine, isCurrent,
    yieldControl, sliceMs, onPublish, false).catch(error => {
      if (error instanceof SearchScanCancelled) return null;
      throw error;
    });
}

export class SearchPageError extends Error {
  constructor(readonly pageIndex: number, cause: unknown) {
    super(`Search could not safely inspect page ${pageIndex + 1}.`, { cause });
    this.name = 'SearchPageError';
  }
}

export class SearchResultLimitError extends SearchPageError {
  constructor(pageIndex: number) {
    super(pageIndex, undefined);
    this.name = 'SearchResultLimitError';
    this.message = `Search has more than ${MAX_SEARCH_MATCHES.toLocaleString('en-US')} matches. Narrow the search.`;
  }
}

export class SearchChangedError extends Error {
  constructor() { super('The document changed during search. Search again.'); this.name = 'SearchChangedError'; }
}

/** Form text is searchable but its source instructions are not page-editable. */
export function assertCurrentReplaceSupported(match: SearchMatch): void {
  if (match.source === 'cross-run') throw new Error('Text spanning multiple runs cannot be replaced.');
  if (match.source !== 'page' || !Number.isSafeInteger(match.runIndex) || match.runIndex < 0) {
    throw new Error('Text inside a Form XObject cannot be replaced.');
  }
}

type ReplacementEngine = SearchEngine & Pick<typeof import('@/engine/browser-core'),
  'applyTextEdits' | 'applyVerifiedCrossRunEdits' | 'updatePageContent'>;

/** Plan the complete logical search against the staged document before writing
 * any page. Cross-run edits are deliberately restricted to equal-length simple
 * page text; the engine checks the original instructions and fonts as well. */
export async function replaceSearchMatches(
  doc: PDFDocumentData, query: string, replacement: string, caseSensitive: boolean,
  engine: ReplacementEngine, selection?: SearchMatch,
): Promise<number> {
  if (!query) return 0;
  if (query.length > CROSS_QUERY_LIMIT) throw new Error('Search query exceeds the supported length.');
  const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
  const plans: Array<{ pageIndex: number; bytes: Uint8Array; edits: TextEdit[]; cross: boolean }> = [];
  let selected = false;
  let count = 0, totalHits = 0;
  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
    if (selection && selection.pageIndex !== pageIndex) continue;
    const page = doc.pages[pageIndex];
    if (selection && page.ref.toKey() !== selection.pageKey) throw new Error('The selected search match changed. Search again before replacing it.');
    const bytes = engine.getPageContentBytes(page, doc.objects);
    const interpreted = engine.interpretPage(bytes, page, doc.objects, visibility, 0, undefined,
      { includeImageResourceVersions: false });
    const entries = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    const runs = entries.map(entry => compactRun(entry.run, entry.source, entry.runIndex, entry.highlightClip));
    const hits = findRunMatches(runs, query, caseSensitive);
    const ranges = new Map<number, Array<{ start: number; end: number; text: string }>>();
    let pageCross = false;
    for (const hit of hits) {
      if (!hit || hit === SEARCH_TICK) continue;
      if (!selection && ++totalHits > MAX_SEARCH_MATCHES) throw new SearchResultLimitError(pageIndex);
      const parts = matchParts(hit, runs);
      if (selection) {
        if (selection.source !== 'cross-run' || !selection.parts || selection.matchedText !== hit.text ||
            selection.parts.length !== parts.length || !selection.parts.every((part, i) =>
              part.source === parts[i].source && part.runIndex === parts[i].runIndex && part.runText === parts[i].runText &&
              part.start === parts[i].start && part.end === parts[i].end)) continue;
        selected = true;
      }
      if (parts.some(part => part.source !== 'page' || part.runIndex < 0)) {
        throw new Error('Text inside a Form XObject cannot be replaced.');
      }
      const cross = parts.length > 1;
      if (cross && runs.slice(hit.first, hit.last + 1).some(run => run.rotatedBaseline)) {
        throw new Error('Replacing rotated text spanning multiple runs is not supported.');
      }
      if (cross && (!/^[A-Za-z0-9]+$/.test(hit.text) || !/^[A-Za-z0-9]+$/.test(replacement) ||
          hit.text.length !== replacement.length)) {
        throw new Error('Text spanning multiple runs cannot be replaced unless the replacement has the same length and uses simple letters or numbers.');
      }
      if (hit.text === replacement) continue;
      pageCross ||= cross;
      let replacementOffset = 0;
      for (const part of parts) {
        const run = interpreted.textRuns[part.runIndex];
        if (!run || run.text !== part.runText || part.start < 0 || part.end <= part.start || part.end > run.text.length) {
          throw new Error('The selected search match changed. Search again before replacing it.');
        }
        const length = part.end - part.start;
        const value = cross ? replacement.slice(replacementOffset, replacementOffset + length) : replacement;
        replacementOffset += length;
        const edits = ranges.get(part.runIndex) ?? [];
        edits.push({ start: part.start, end: part.end, text: value });
        ranges.set(part.runIndex, edits);
      }
      count++;
    }
    if (!ranges.size) continue;
    const edits = [...ranges].map(([index, replacements]) => {
      const run = interpreted.textRuns[index];
      let offset = 0, newText = '';
      for (const part of replacements.sort((a, b) => a.start - b.start)) {
        if (part.start < offset) throw new Error('Overlapping search matches cannot be replaced safely.');
        newText += run.text.slice(offset, part.start) + part.text;
        offset = part.end;
      }
      return { targetRun: run, newText: newText + run.text.slice(offset) };
    });
    edits.sort((a, b) => (a.targetRun.sourceInstructionIndices?.[0] ?? Infinity) - (b.targetRun.sourceInstructionIndices?.[0] ?? Infinity));
    plans.push({ pageIndex, bytes, edits, cross: pageCross });
  }
  if (selection && !selected) throw new Error('The selected search match changed. Search again before replacing it.');
  const outputs = plans.map(plan => {
    const page = doc.pages[plan.pageIndex];
    const result = plan.cross
      ? engine.applyVerifiedCrossRunEdits(plan.bytes, page, doc.objects, plan.edits)
      : engine.applyTextEdits(plan.bytes, page, doc.objects, plan.edits);
    return { page, bytes: result.newContentBytes };
  });
  for (const output of outputs) await engine.updatePageContent(output.page.contentRefs, output.bytes, doc.objects);
  return count;
}

/** Retry a scan invalidated by an edit, without publishing an older result. */
export async function searchLatestDocument(
  doc: PDFDocumentData,
  query: string,
  caseSensitive: boolean,
  index: DocumentSearchIndex,
  engine: SearchEngine,
  readRevision: () => string,
  isLive: () => boolean,
  beforeSearch: () => Promise<boolean> = async () => true,
  yieldControl?: () => Promise<void>,
  sliceMs?: number,
  onPublish?: (matches: SearchMatch[]) => void,
): Promise<SearchMatch[] | null> {
  if (!isLive() || !await beforeSearch()) return null;
  let graphChanges = 0;
  while (isLive()) {
    const revision = readRevision();
    const current = () => isLive() && readRevision() === revision;
    let matches: SearchMatch[] | null;
    try {
      matches = await searchDocument(doc, query, caseSensitive, revision, index, engine, current, yieldControl, sliceMs, onPublish);
    } catch (error) {
      if (!isLive()) return null;
      if (!current()) continue;
      if (error instanceof SearchChangedError && graphChanges++ < 2) continue;
      throw error;
    }
    if (!matches || !current()) continue;
    return matches;
  }
  return null;
}
