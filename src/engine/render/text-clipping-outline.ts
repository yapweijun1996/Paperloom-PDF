import type { ClipPathNode, PathSegment, TextRun } from '../content/interpreter';
import type { FontData } from '../fonts/font-parser';
import { getGlyphOutline, type TTFFont } from '../fonts/truetype-parser';
import { UnsupportedTextClippingError } from './text-clipping-guard';

const MAX_POINTS_PER_GLYPH = 8192;

/** Verify the PDF non-symbolic font's Windows Unicode BMP mapping directly.
 * The general parser merges fallback cmap subtables, which is useful for text
 * extraction but cannot prove which glyph a PDF viewer will paint. */
function windowsUnicodeGlyph(font: TTFFont, code: number): number | undefined {
  const table = font.tables.get('cmap'), data = font.rawData;
  if (!table || !Number.isSafeInteger(table.offset) || !Number.isSafeInteger(table.length) ||
      table.offset < 0 || table.length < 4 || table.offset + table.length > data.length) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const start = table.offset, end = start + table.length, count = view.getUint16(start + 2);
  if (count > 128 || start + 4 + count * 8 > end) return undefined;
  let matchingRecords = 0;
  for (let i = 0; i < count; i++) {
    const record = start + 4 + i * 8;
    if (view.getUint16(record) === 3 && view.getUint16(record + 2) === 1) matchingRecords++;
  }
  if (matchingRecords !== 1) return undefined;
  for (let i = 0; i < count; i++) {
    const record = start + 4 + i * 8;
    if (view.getUint16(record) !== 3 || view.getUint16(record + 2) !== 1) continue;
    const sub = start + view.getUint32(record + 4);
    if (sub + 14 > end || view.getUint16(sub) !== 4) return undefined;
    const length = view.getUint16(sub + 2), segments = view.getUint16(sub + 6) / 2;
    if (length < 16 || sub + length > end || !Number.isInteger(segments) || segments < 1 || segments > 8192 ||
        16 + segments * 8 > length) return undefined;
    const ends = sub + 14, starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2, ranges = deltas + segments * 2;
    if (view.getUint16(ends + segments * 2) !== 0) return undefined;
    let previousEnd = -1, result: number | undefined;
    for (let j = 0; j < segments; j++) {
      const first = view.getUint16(starts + j * 2), last = view.getUint16(ends + j * 2);
      if (first > last || first <= previousEnd) return undefined;
      previousEnd = last;
      if (code < first || code > last) continue;
      const delta = view.getInt16(deltas + j * 2), range = view.getUint16(ranges + j * 2);
      if (!range) { result = (code + delta) & 0xffff; continue; }
      const position = ranges + j * 2 + range + (code - first) * 2;
      if (position + 2 > sub + length) return undefined;
      const gid = view.getUint16(position);
      result = gid ? (gid + delta) & 0xffff : 0;
    }
    return previousEnd === 0xffff ? result : undefined;
  }
  return undefined;
}

/** Validate a simple TrueType glyf record before invoking the outline parser.
 * Composite glyphs are refused because their point attachment and cycles are
 * not fully supported by that parser. */
function assertSimpleGlyph(font: TTFFont, glyphId: number): void {
  const glyf = font.tables.get('glyf'), loca = font.tables.get('loca');
  const data = font.rawData;
  if (!glyf || !loca || !Number.isInteger(glyphId) || glyphId <= 0 || glyphId >= font.numGlyphs ||
      data.length > 16 * 1024 * 1024 || ![0, 1].includes(font.indexToLocFormat)) throw new UnsupportedTextClippingError();
  if (![glyf.offset, glyf.length, loca.offset, loca.length].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new UnsupportedTextClippingError();
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const locSize = font.indexToLocFormat ? 4 : 2;
  const locPos = loca.offset + glyphId * locSize;
  if (locPos < loca.offset || locPos + 2 * locSize > loca.offset + loca.length ||
      locPos + 2 * locSize > data.length || glyf.offset + glyf.length > data.length) throw new UnsupportedTextClippingError();
  const readLoc = (pos: number) => font.indexToLocFormat ? view.getUint32(pos) : view.getUint16(pos) * 2;
  const start = readLoc(locPos), end = readLoc(locPos + locSize);
  if (start > end || end > glyf.length) throw new UnsupportedTextClippingError();
  if (start === end) return;
  const endPos = glyf.offset + end;
  let p = glyf.offset + start;
  const need = (n: number) => { if (n < 0 || p + n > endPos) throw new UnsupportedTextClippingError(); };
  need(10);
  const contours = view.getInt16(p); p += 10;
  if (contours < 0 || contours > 256) throw new UnsupportedTextClippingError();
  need(contours * 2 + 2);
  let last = -1;
  for (let i = 0; i < contours; i++) {
    const next = view.getUint16(p); p += 2;
    if (next <= last || next >= MAX_POINTS_PER_GLYPH) throw new UnsupportedTextClippingError();
    last = next;
  }
  const instructionLength = view.getUint16(p); p += 2;
  need(instructionLength); p += instructionLength;
  const count = last + 1, flags: number[] = [];
  while (flags.length < count) {
    need(1); const flag = data[p++]; flags.push(flag);
    if (flag & 8) {
      need(1); const repeat = data[p++];
      if (flags.length + repeat > count) throw new UnsupportedTextClippingError();
      for (let i = 0; i < repeat; i++) flags.push(flag);
    }
  }
  let bytes = 0;
  for (const flag of flags) bytes += flag & 2 ? 1 : flag & 16 ? 0 : 2;
  for (const flag of flags) bytes += flag & 4 ? 1 : flag & 32 ? 0 : 2;
  need(bytes);
}


const MAX_GLYPHS = 4096;
const MAX_TOTAL_SEGMENTS = 100_000;

/** Build a single nonzero clip from non-overlapping, simple embedded TrueType
 * glyphs. Refusing unsupported glyphs keeps text extraction independent. */
export function buildTextClippingOutline(runs: readonly TextRun[], fonts: ReadonlyMap<string, FontData>): ClipPathNode {
  const segments: PathSegment[] = [];
  const boxes: Array<{ x: number; y: number; right: number; top: number }> = [];
  let glyphCount = 0;
  for (const run of runs) {
    const font = fonts.get(run.fontName);
    const ttf = font?.ttfFont;
    if (!font || !ttf || font.subtype !== 'TrueType' || font.isComposite || font.encoding !== 'WinAnsiEncoding' ||
        !((font.flags ?? 0) & 32) || ((font.flags ?? 0) & 4) ||
        font.differences.size || !Number.isFinite(ttf.unitsPerEm) || ttf.unitsPerEm <= 0) throw new UnsupportedTextClippingError();
    for (const glyph of run.glyphs) {
      if (++glyphCount > MAX_GLYPHS || !Number.isInteger(glyph.charCode) || glyph.charCode < 0x20 || glyph.charCode > 0x7e ||
          !Object.values(glyph.tRm).every(Number.isFinite)) throw new UnsupportedTextClippingError();
      const gid = ttf.cmapEntries.get(glyph.charCode);
      if (gid === undefined || windowsUnicodeGlyph(ttf, glyph.charCode) !== gid) throw new UnsupportedTextClippingError();
      assertSimpleGlyph(ttf, gid);
      let outline;
      try { outline = getGlyphOutline(ttf, gid); } catch { throw new UnsupportedTextClippingError(); }
      if (!outline) throw new UnsupportedTextClippingError();
      const matrix = glyph.tRm, factor = 1 / ttf.unitsPerEm;
      const point = (x: number, y: number): [number, number] => {
        const px = matrix.a * x * factor + matrix.c * y * factor + matrix.e;
        const py = matrix.b * x * factor + matrix.d * y * factor + matrix.f;
        if (![px, py].every(Number.isFinite) || Math.abs(px) > 1e8 || Math.abs(py) > 1e8) throw new UnsupportedTextClippingError();
        return [px, py];
      };
      let current: [number, number] | undefined;
      let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
      const track = (point: [number, number]) => {
        x = Math.min(x, point[0]); y = Math.min(y, point[1]); right = Math.max(right, point[0]); top = Math.max(top, point[1]);
        return point;
      };
      for (const command of outline.commands) {
        if (segments.length >= MAX_TOTAL_SEGMENTS) throw new UnsupportedTextClippingError();
        const p = command.args;
        if (command.type === 'M' || command.type === 'L') {
          if (p.length !== 2) throw new UnsupportedTextClippingError();
          current = track(point(p[0], p[1]));
          segments.push({ type: command.type, points: [...current] });
        } else if (command.type === 'Q') {
          if (p.length !== 4 || !current) throw new UnsupportedTextClippingError();
          const control = track(point(p[0], p[1])), end = track(point(p[2], p[3]));
          const c1 = [current[0] + 2 * (control[0] - current[0]) / 3, current[1] + 2 * (control[1] - current[1]) / 3];
          const c2 = [end[0] + 2 * (control[0] - end[0]) / 3, end[1] + 2 * (control[1] - end[1]) / 3];
          segments.push({ type: 'C', points: [...c1, ...c2, ...end] }); current = end;
        } else if (command.type === 'C') {
          if (p.length !== 6 || !current) throw new UnsupportedTextClippingError();
          const c1 = track(point(p[0], p[1])), c2 = track(point(p[2], p[3])), end = track(point(p[4], p[5]));
          segments.push({ type: 'C', points: [...c1, ...c2, ...end] }); current = end;
        } else if (command.type === 'Z') segments.push({ type: 'Z', points: [] });
        else throw new UnsupportedTextClippingError();
      }
      if (Number.isFinite(x)) {
        if (boxes.some(other => x < other.right && right > other.x && y < other.top && top > other.y)) throw new UnsupportedTextClippingError();
        boxes.push({ x, y, right, top });
      }
    }
  }
  if (!glyphCount) throw new UnsupportedTextClippingError();
  return { segments, windingRule: 'nonzero' };
}
