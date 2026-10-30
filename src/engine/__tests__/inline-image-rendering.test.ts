import { PDFDocument } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tinyJPEG } from './audit-p1-fixtures';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { renderPage } from '../render/renderer';
import { interpretPage } from '../content/interpreter';
import { buildSceneGraph } from '../editing/scene-graph';
import { saveOptimized } from '../writer/save-pipeline';

const labels = vi.fn();
const pixels = vi.fn();
function ctx(canvas: unknown) {
  return new Proxy({ canvas, globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === 'fillText') return labels;
      if (key === 'putImageData') return pixels;
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 });
      if (key === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(target, key, value) { Object.assign(target, { [key]: value }); return true; },
  });
}
class Canvas {
  width = 1;
  height = 1;
  style = {};
  getContext() { return ctx(this); }
}
class Offscreen extends Canvas {
  constructor(width: number, height: number) { super(); this.width = width; this.height = height; }
}
class TestImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}
const bitmap = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));

beforeEach(() => {
  labels.mockClear(); pixels.mockClear(); bitmap.mockClear();
  vi.stubGlobal('document', { createElement: () => new Canvas() });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('HTMLCanvasElement', Canvas);
  vi.stubGlobal('OffscreenCanvas', Offscreen);
  vi.stubGlobal('ImageData', TestImageData);
  vi.stubGlobal('createImageBitmap', bitmap);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture(filter: string, data: Uint8Array) {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const prefix = new TextEncoder().encode(`q 60 0 0 60 10 10 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ${filter} ID `);
  const suffix = new TextEncoder().encode(' EI Q');
  const content = new Uint8Array(prefix.length + data.length + suffix.length);
  content.set(prefix); content.set(data, prefix.length); content.set(suffix, prefix.length + data.length);
  await updatePageContent(doc.pages[0].contentRefs, content, doc.objects, false);
  return { doc, content };
}

describe('inline image rendering', () => {
  it.each([
    { filter: '', bytes: new Uint8Array([255, 0, 0]), jpeg: false },
    { filter: '/F /DCT', bytes: tinyJPEG(), jpeg: true },
    { filter: '/F /Fl', bytes: new Uint8Array(deflateSync(new Uint8Array([255, 0, 0]))), jpeg: false },
    { filter: '/F /A85', bytes: new TextEncoder().encode('<~rr<$~>'), jpeg: false },
  ])('renders $filter image and preserves its source bytes without adding editable objects', async ({ filter, bytes, jpeg }) => {
    const { doc, content } = await fixture(filter, bytes);
    const { displayList } = interpretPage(content, doc.pages[0], doc.objects);
    await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(displayList.filter(item => item.type === 'inline-image')).toHaveLength(1);
    expect(buildSceneGraph(displayList)).toHaveLength(0);
    expect(pixels).toHaveBeenCalled();
    expect(Array.from(pixels.mock.calls.at(-1)![0].data)).toEqual([255, 0, 0, 255]);
    expect(bitmap).toHaveBeenCalledTimes(jpeg ? 1 : 0);
    expect(labels).not.toHaveBeenCalledWith(expect.stringContaining('Unsupported image'), expect.anything(), expect.anything(), expect.anything());
    const reopened = await parsePDF(await saveOptimized(doc));
    expect(await getPageContentBytes(reopened.pages[0], reopened.objects)).toEqual(content);
  });

  it('rejects a truncated unfiltered image without consuming its delimiter as pixels', async () => {
    const { doc, content } = await fixture('', new Uint8Array([255, 0]));
    expect(() => interpretPage(content, doc.pages[0], doc.objects)).toThrow(/inline image boundary/i);
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/inline image boundary/i);
    expect(pixels).not.toHaveBeenCalled();
  });

  it('does not treat a false EI inside compressed data as page instructions', async () => {
    const compressed = new Uint8Array(deflateSync(new TextEncoder().encode(' EI 1 0 0 rg 0 0 100 100 re f '), { level: 0 }));
    const { doc, content } = await fixture('/F /Fl', compressed);
    const { displayList } = interpretPage(content, doc.pages[0], doc.objects);
    expect(displayList.map(item => item.type)).toEqual(['inline-image']);
    await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 });
    expect(pixels).toHaveBeenCalled();
    expect(labels).not.toHaveBeenCalled();
    const reopened = await parsePDF(await saveOptimized(doc));
    expect(await getPageContentBytes(reopened.pages[0], reopened.objects)).toEqual(content);
  });

  it('rejects corrupted compressed image data before interpreting further bytes', async () => {
    const { doc } = await fixture('/F /Fl', new Uint8Array([1, 2, 3]));
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/inline image boundary/i);
    expect(pixels).not.toHaveBeenCalled();
  });

  it.each(['/CCF', '/JPXDecode', '/JBIG2Decode', '/LZW'])('rejects unprovable %s boundaries and preserves source bytes', async filter => {
    const { doc, content } = await fixture(`/F ${filter}`, new Uint8Array([1, 2, 3]));
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).rejects.toThrow(/inline image boundary/i);
    const { serializeDocument } = await import('../writer/serializer');
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(await getPageContentBytes(reopened.pages[0], reopened.objects)).toEqual(content);
  });
});
