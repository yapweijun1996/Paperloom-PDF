import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, PDFName as LibPDFName, PDFString as LibPDFString, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { renderImagePreviewLayers, renderPage } from '../render/renderer';
import { interpretPage, type ImageItem } from '../content/interpreter';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { setFormFieldValue } from '../forms/apply-field';
import { serializeDocument } from '../writer/serializer';
import { findVisualSignatureRefs } from '../session/signature-edit';
import { previewMarkupRemoval } from '../session/document-edit';

const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

function widgetFixture(kind: 'text' | 'button', state: string, flags = 4, pageGeometry = ''): Uint8Array {
  const red = '1 0 0 rg 0 0 40 20 re f';
  const blue = '0 0 1 rg 0 0 40 20 re f';
  const appearance = kind === 'text' ? '5 0 R' : '<< /Yes 5 0 R /Off 6 0 R >>';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] ${pageGeometry} /Resources << >> /Annots [4 0 R] >>`,
    `<< /Type /Annot /Subtype /Widget /FT /${kind === 'text' ? 'Tx' : 'Btn'} /T (field) /Rect [20 20 60 40] /F ${flags} /P 3 0 R ${state ? `/AS /${state}` : ''} /AP << /N ${appearance} >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${red.length} >>\nstream\n${red}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Resources << >> /Length ${blue.length} >>\nstream\n${blue}\nendstream`,
  ]);
}

function installCanvas() {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('OffscreenCanvas', function(width: number, height: number) { return createCanvas(width, height); });
}
function pixel(canvas: HTMLCanvasElement, x = 30, y = 70) {
  return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data).slice(0, 3);
}
afterEach(() => vi.unstubAllGlobals());

describe('widget appearances in thumbnails', () => {
  it.skipIf(!hasPoppler)('uses inherited page resources when the appearance has no resources', async () => {
    const content = 'BT /F1 16 Tf 2 2 Td (HELLO) Tj ET';
    const resources = '/Resources << /Font << /F1 6 0 R >> >>';
    const fixture = (inherited: boolean) => rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
      `<< /Type /Pages /Kids [3 0 R] /Count 1 ${inherited ? resources : ''} >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] ${inherited ? '' : resources} /Annots [4 0 R] >>`,
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /Rect [20 20 80 40] /F 4 /P 3 0 R /AP << /N 5 0 R >> >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 60 20] /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-inherited-widget-resources-'));
    try {
      const references = [];
      for (const name of ['inherited', 'direct']) {
        writeFileSync(join(dir, `${name}.pdf`), fixture(name === 'inherited'));
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, `${name}.pdf`), join(dir, name)]);
        const image = await loadImage(readFileSync(join(dir, `${name}.png`)));
        const canvas = createCanvas(100, 100); canvas.getContext('2d').drawImage(image, 0, 0);
        references.push(canvas.toDataURL());
      }
      expect(references[0]).toBe(references[1]);
      installCanvas();
      const inherited = await renderPage(await parsePDF(fixture(true)), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
      const direct = await renderPage(await parsePDF(fixture(false)), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
      expect(inherited.canvas.toDataURL()).toBe(direct.canvas.toDataURL());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prefers explicit appearance resources to page resources', async () => {
    const content = 'BT /F1 16 Tf 2 2 Td (HELLO) Tj ET';
    const fixture = (explicit: boolean, pageFont = explicit ? 6 : 7) => rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 ${pageFont} 0 R >> >> /Annots [4 0 R] >>`,
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /Rect [20 20 80 40] /F 4 /P 3 0 R /AP << /N 5 0 R >> >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 60 20] ${explicit ? '/Resources << /Font << /F1 7 0 R >> >>' : ''} /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    ]);
    installCanvas();
    const explicit = await renderPage(await parsePDF(fixture(true)), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
    const pageFallback = await renderPage(await parsePDF(fixture(false)), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
    expect(explicit.canvas.toDataURL()).toBe(pageFallback.canvas.toDataURL());
    const differentPageFont = await renderPage(await parsePDF(fixture(false, 6)), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
    expect(explicit.canvas.toDataURL()).not.toBe(differentPageFont.canvas.toDataURL());
  });

  it('does not change serialized PDF bytes when rendering a text appearance', async () => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', ''));
    const before = await serializeDocument(doc);
    await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' });
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('renders only text widgets in text mode and respects Hidden and NoView', async () => {
    installCanvas();
    for (const flags of [2, 32]) {
      const hidden = await parsePDF(widgetFixture('text', '', flags));
      expect(pixel((await renderPage(hidden, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
    }
    const text = await parsePDF(widgetFixture('text', ''));
    expect(pixel((await renderPage(text, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 0, 0]);
    const button = await parsePDF(widgetFixture('button', 'Yes'));
    expect(pixel((await renderPage(button, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
  });

  it('finds inherited field types and skips unknown or cyclic parents', async () => {
    installCanvas();
    const bytes = widgetFixture('text', '');
    const doc = await parsePDF(bytes);
    const widget = doc.objects.get('4_0');
    expect(widget).toBeDefined();
    // The parsed fixture uses a merged field/widget; convert it to a child widget.
    const { PDFDict, PDFName, PDFRef } = await import('../types');
    expect(widget).toBeInstanceOf(PDFDict);
    const dict = widget as InstanceType<typeof PDFDict>;
    dict.delete('FT');
    const parent = new PDFDict();
    parent.set('FT', new PDFName('Tx'));
    const parentRef = new PDFRef(20, 0);
    doc.objects.set(parentRef.toKey(), parent);
    dict.set('Parent', parentRef);
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 0, 0]);
    parent.delete('FT');
    parent.set('Parent', parentRef);
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
  });

  it.each(['Btn', 'Sig'])('does not paint a %s widget with indirect Subtype in text mode', async type => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', ''));
    const { PDFDict, PDFName, PDFRef } = await import('../types');
    expect(doc.objects.get('4_0')).toBeInstanceOf(PDFDict);
    const widget = doc.objects.get('4_0') as InstanceType<typeof PDFDict>;
    const subtypeRef = new PDFRef(20, 0);
    doc.objects.set(subtypeRef.toKey(), new PDFName('Widget'));
    widget.set('Subtype', subtypeRef);
    widget.set('FT', new PDFName(type));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual([255, 0, 0]);
  });

  it('reports malformed text appearance decoding instead of silently omitting it', async () => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', ''));
    const { PDFName, PDFStream } = await import('../types');
    const stream = doc.objects.get('5_0');
    expect(stream).toBeInstanceOf(PDFStream);
    (stream as InstanceType<typeof PDFStream>).dict.set('Filter', new PDFName('FlateDecode'));
    (stream as InstanceType<typeof PDFStream>).decodedBytes = null;
    await expect(renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).rejects.toThrow();
  });

  it('does not invent an appearance when it is absent or has invalid geometry', async () => {
    installCanvas();
    const { PDFDict, PDFStream } = await import('../types');
    const missing = await parsePDF(widgetFixture('text', ''));
    expect(missing.objects.get('4_0')).toBeInstanceOf(PDFDict);
    (missing.objects.get('4_0') as InstanceType<typeof PDFDict>).delete('AP');
    expect(pixel((await renderPage(missing, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
    const invalid = await parsePDF(widgetFixture('text', ''));
    expect(invalid.objects.get('5_0')).toBeInstanceOf(PDFStream);
    (invalid.objects.get('5_0') as InstanceType<typeof PDFStream>).dict.delete('BBox');
    expect(pixel((await renderPage(invalid, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas)).toEqual([255, 255, 255]);
  });

  it('keeps text appearances in the selected image preview background', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([100, 100]);
    const field = pdf.getForm().createTextField('name');
    field.setText('Before');
    field.addToPage(page, { x: 10, y: 20, width: 80, height: 30, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const source = createCanvas(4, 4);
    source.getContext('2d').fillRect(0, 0, 4, 4);
    page.drawImage(await pdf.embedPng(source.toBuffer('image/png')), { x: 70, y: 70, width: 10, height: 10 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const item = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects)
      .displayList.find((entry): entry is ImageItem => entry.type === 'image');
    expect(item).toBeDefined();
    const preview = await renderImagePreviewLayers(doc.pages[0], doc.objects, item!, 1, doc.catalog);
    expect(pixel(preview.image, 5, 5)).toEqual([0, 0, 0]);
    expect(preview.image.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]).toBe(255);
    const withField = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, omitImage: item, renderWidgets: 'text' })).canvas;
    expect(preview.background.toDataURL()).toBe(withField.toDataURL());
    expect(preview.background.toDataURL()).not.toBe((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, omitImage: item })).canvas.toDataURL());
  });

  it('omits tracked signatures but keeps untracked signature widgets in image previews', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([100, 100]);
    const stream = pdf.context.flateStream('1 0 0 rg 0 0 40 20 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 20], Resources: {},
    });
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
      T: LibPDFString.of('signature'), Rect: [20, 20, 60, 40], F: 4, P: page.ref,
      PaperloomSignatureId: LibPDFString.of('live-signature'), AP: { N: pdf.context.register(stream) } });
    const ref = pdf.context.register(widget);
    page.node.set(LibPDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(LibPDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
    const image = createCanvas(4, 4); image.getContext('2d').fillRect(0, 0, 4, 4);
    page.drawImage(await pdf.embedPng(image.toBuffer('image/png')), { x: 70, y: 70, width: 10, height: 10 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const item = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects)
      .displayList.find((entry): entry is ImageItem => entry.type === 'image');
    expect(item).toBeDefined();
    const native = await renderImagePreviewLayers(doc.pages[0], doc.objects, item!, 1, doc.catalog);
    expect(pixel(native.background)).toEqual([255, 0, 0]);
    const refs = findVisualSignatureRefs(doc, new Set(['live-signature']));
    expect(refs.size).toBe(1);
    const hidden = new Map([...refs.values()].map(value => [value.toKey(), value]));
    const previewPage = previewMarkupRemoval(doc, 0, hidden).pages[0];
    const tracked = await renderImagePreviewLayers(previewPage, doc.objects, item!, 1, doc.catalog);
    expect(pixel(tracked.background)).toEqual([255, 255, 255]);
    expect(tracked.image.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]).toBe(255);
  });

  it.skipIf(!hasPoppler)('maps a text appearance on a cropped, rotated page like Poppler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-geometry-'));
    try {
      const bytes = widgetFixture('text', '', 4, '/CropBox [10 20 90 80] /Rotate 90');
      writeFileSync(join(dir, 'input.pdf'), bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-cropbox', '-r', '72', '-png', join(dir, 'input.pdf'), join(dir, 'reference')]);
      const reference = await loadImage(readFileSync(join(dir, 'reference.png')));
      const expected = createCanvas(reference.width, reference.height);
      expected.getContext('2d').drawImage(reference, 0, 0);
      installCanvas();
      const rendered = (await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'text' })).canvas;
      expect([rendered.width, rendered.height]).toEqual([reference.width, reference.height]);
      const redBounds = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
        const data = ctx.getImageData(0, 0, width, height).data;
        const points: [number, number][] = [];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] > 200 && data[i + 1] < 30 && data[i + 2] < 30) points.push([x, y]);
        }
        expect(points.length).toBeGreaterThan(100);
        return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
          Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
      };
      expect(redBounds(rendered.getContext('2d')!, rendered.width, rendered.height))
        .toEqual(redBounds(expected.getContext('2d') as unknown as CanvasRenderingContext2D, reference.width, reference.height));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['text stream', 'text', '', [255, 0, 0]],
    ['on state', 'button', 'Yes', [255, 0, 0]],
    ['off state', 'button', 'Off', [0, 0, 255]],
  ] as const)('renders %s only when enabled', async (_label, kind, state, expected) => {
    installCanvas();
    const doc = await parsePDF(widgetFixture(kind, state));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1 })).canvas)).toEqual([255, 255, 255]);
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual(expected);
  });

  it.each(['', 'Missing'])('does not guess missing or unknown state %s', async state => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('button', state));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual([255, 255, 255]);
  });

  it('continues to exclude hidden widgets', async () => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', '', 2));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas)).toEqual([255, 255, 255]);
  });

  it('updates thumbnail pixels after editing a real text widget', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([100, 100]);
    const field = pdf.getForm().createTextField('name');
    field.addToPage(page, { x: 10, y: 20, width: 80, height: 30, font: await pdf.embedFont(StandardFonts.Helvetica) });
    field.setText('Before');
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const before = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    const [widget] = detectFormFieldsOnPage(doc, 0);
    expect(widget).toBeDefined();
    setFormFieldValue(doc, widget, 'After');
    const after = (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    expect(after).not.toBe(before);
  });

  it('updates both page appearances for one field with widgets on two pages', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage([100, 100]), pdf.addPage([100, 100])];
    const field = pdf.getForm().createTextField('shared');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const page of pages) field.addToPage(page, { x: 10, y: 20, width: 80, height: 30, font });
    field.setText('Before');
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    installCanvas();
    const render = async (index: number) => (await renderPage(doc, index, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas.toDataURL();
    const before = await Promise.all([render(0), render(1)]);
    const [widget] = detectFormFieldsOnPage(doc, 0);
    setFormFieldValue(doc, widget, 'Changed');
    const after = await Promise.all([render(0), render(1)]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it.skipIf(!hasPoppler).each([
    ['text stream', 'text', '', [255, 0, 0]],
    ['button on', 'button', 'Yes', [255, 0, 0]],
    ['button off', 'button', 'Off', [0, 0, 255]],
  ] as const)('matches Poppler for %s', async (_label, kind, state, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-'));
    try {
      const bytes = widgetFixture(kind, state);
      writeFileSync(join(dir, 'input.pdf'), bytes);
      execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'input.pdf'), join(dir, 'reference')], { stdio: 'pipe' });
      const reference = await loadImage(readFileSync(join(dir, 'reference.png')));
      const canvas = createCanvas(100, 100); canvas.getContext('2d').drawImage(reference, 0, 0);
      expect(Array.from(canvas.getContext('2d').getImageData(30, 70, 1, 1).data).slice(0, 3)).toEqual(expected);
      installCanvas();
      const rendered = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true });
      expect(pixel(rendered.canvas)).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('non-signature form appearances in editor rendering', () => {
  it.each(['annotation', 'appearance'])('keeps a signature hidden by its %s optional-content layer', async location => {
    installCanvas();
    const content = '1 0 0 rg 0 0 40 20 re f';
    const bytes = rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Annots [4 0 R] >>',
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T (signature) /Rect [20 20 60 40] /F 4 /P 3 0 R ${location === 'annotation' ? '/OC 6 0 R' : ''} /AP << /N 5 0 R >> >>`,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] ${location === 'appearance' ? '/OC 6 0 R' : ''} /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /OCG /Name (Hidden) >>',
    ]);
    const result = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'supported' });
    expect(pixel(result.canvas)).toEqual([255, 255, 255]);
  });

  it.each([['Sig', 4, [255, 0, 0]], ['Sig', 2, [255, 255, 255]],
    ['Sig', 32, [255, 255, 255]], ['Unknown', 4, [255, 255, 255]]] as const)(
    'renders only visible supported field appearances: %s flags %i', async (type, flags, expected) => {
      installCanvas();
      const doc = await parsePDF(widgetFixture('text', '', flags));
      const { PDFDict, PDFName, PDFRef } = await import('../types');
      const widget = doc.objects.get('4_0');
      expect(widget).toBeInstanceOf(PDFDict);
      const dict = widget as InstanceType<typeof PDFDict>;
      dict.delete('FT');
      const parent = new PDFDict(), parentRef = new PDFRef(20, 0), typeRef = new PDFRef(21, 0), subtypeRef = new PDFRef(22, 0);
      parent.set('FT', typeRef); dict.set('Parent', parentRef); dict.set('Subtype', subtypeRef);
      doc.objects.set(parentRef.toKey(), parent); doc.objects.set(typeRef.toKey(), new PDFName(type));
      doc.objects.set(subtypeRef.toKey(), new PDFName('Widget'));
      expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'supported' })).canvas)).toEqual(expected);
    },
  );

  it.each([
    ['Yes', [255, 0, 0]], ['Off', [0, 0, 255]], ['', [255, 255, 255]], ['Missing', [255, 255, 255]],
  ] as const)('uses the button appearance state %s without guessing', async (state, expected) => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('button', state));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'form' })).canvas)).toEqual(expected);
  });

  it.each(['Tx', 'Btn', 'Ch', 'Sig', 'Unknown'])('classifies inherited %s without drawing signatures or unknown fields', async type => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('text', ''));
    const { PDFDict, PDFName, PDFRef } = await import('../types');
    const widget = doc.objects.get('4_0') as InstanceType<typeof PDFDict>;
    widget.delete('FT');
    const parent = new PDFDict(), parentRef = new PDFRef(20, 0), subtypeRef = new PDFRef(21, 0);
    parent.set('FT', new PDFName(type));
    widget.set('Parent', parentRef); widget.set('Subtype', subtypeRef);
    doc.objects.set(parentRef.toKey(), parent); doc.objects.set(subtypeRef.toKey(), new PDFName('Widget'));
    const expected = ['Tx', 'Btn', 'Ch'].includes(type) ? [255, 0, 0] : [255, 255, 255];
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'form' })).canvas)).toEqual(expected);
  });

  it.each([2, 32, 6, 36])('retains Hidden and NoView for non-signature widgets with flags %i', async flags => {
    installCanvas();
    const doc = await parsePDF(widgetFixture('button', 'Yes', flags));
    expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'form' })).canvas)).toEqual([255, 255, 255]);
  });
});

it.each(['annotation', 'appearance'])('keeps a form widget hidden by its %s optional-content layer', async layerOwner => {
  installCanvas();
  const red = '1 0 0 rg 0 0 40 20 re f';
  const bytes = rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [4 0 R] >>',
    `<< /Type /Annot /Subtype /Widget /FT /Btn /Rect [20 20 60 40] ${layerOwner === 'annotation' ? '/OC 6 0 R' : ''} /AP << /N 5 0 R >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] ${layerOwner === 'appearance' ? '/OC 6 0 R' : ''} /Length ${red.length} >>\nstream\n${red}\nendstream`,
    '<< /Type /OCG /Name (Hidden) >>',
  ]);
  const doc = await parsePDF(bytes);
  expect(pixel((await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'form' })).canvas)).toEqual([255, 255, 255]);
});
