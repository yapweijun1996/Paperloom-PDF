import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { interpretPage } from '../content/interpreter';
import { OptionalContentVisibility } from '../content/optional-content';
import { updatePageContent } from '../editor/stream-compiler';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from '../types';
import { serializeDocument } from '../writer/serializer';
import { findAndReplace, findTextInPage } from '../editor/text-editor';
import { detectFormFieldsOnPage, listAllFormWidgets } from '../forms/detect-fields';
import { explodeTJGaps } from '../content/tj-normalizer';
import { extractPagePlainText } from '../ai/compare';
import { buildDocumentFlow } from '../flow';
import { applyLineTextEdit } from '../flow/flow-editor';
import { applyStyleToSelectionOnPage } from '../flow/style-edit';
import { getPageContentBytes } from '../parser/parser';
import { isAnnotationVisible } from '../content/annotation-visibility';

async function fixture() {
  const source = await PDFDocument.create(); source.addPage([100, 100]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const off = new PDFRef(300, 0), on = new PDFRef(301, 0);
  doc.objects.set(off.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
  doc.objects.set(on.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
  doc.catalog.set('OCProperties', new PDFDict([
    ['OCGs', new PDFArray([off, on])],
    ['D', new PDFDict([['OFF', new PDFArray([off])]])],
  ]));
  doc.pages[0].resources.set('Properties', new PDFDict([['Hidden', off], ['Shown', on]]));
  return { doc, off, on };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('default optional content visibility', () => {
  it('hides nested marked content and preserves visible graphics state after a save/reopen', async () => {
    const { doc } = await fixture();
    const content = '/OC /Hidden BDC 1 0 0 rg 1 1 10 10 re f /OC /Shown BDC 2 2 10 10 re f EMC EMC 50 0 10 10 re f';
    await updatePageContent(doc.pages[0].contentRefs, bytes(content), doc.objects, false);
    const saved = await serializeDocument(doc);
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
    const reopened = await parsePDF(saved);
    const page = reopened.pages[0];
    const stream = reopened.objects.get(page.contentRefs[0].toKey()) as PDFStream;
    const result = interpretPage(stream.getBytes(), page, reopened.objects, new OptionalContentVisibility(reopened.catalog, reopened.objects));
    const paths = result.displayList.filter(item => item.type === 'path');
    expect(paths).toHaveLength(1);
    expect(paths[0].x).toBe(50);
    expect(paths[0].fillColor).toEqual([1, 0, 0]);
  });

  it('honors default ON/OFF, membership policies and nested visibility expressions', async () => {
    const { doc, off, on } = await fixture();
    const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
    expect(visibility.isVisible(off)).toBe(false);
    expect(visibility.isVisible(on)).toBe(true);
    for (const [policy, expected] of [['AnyOn', true], ['AllOn', false], ['AnyOff', true], ['AllOff', false]] as const) {
      expect(visibility.isVisible(new PDFDict([['Type', new PDFName('OCMD')], ['OCGs', new PDFArray([off, on])], ['P', new PDFName(policy)]]))).toBe(expected);
    }
    const expression = new PDFArray([new PDFName('And'), on, new PDFArray([new PDFName('Not'), off])]);
    expect(visibility.isVisible(new PDFDict([['Type', new PDFName('OCMD')], ['VE', expression]]))).toBe(true);
    expression.items[2] = off;
    expect(visibility.isVisible(new PDFDict([['Type', new PDFName('OCMD')], ['VE', expression]]))).toBe(false);
  });

  it('applies View usage rules and honors non-view intent', async () => {
    const { doc, off, on } = await fixture();
    const group = doc.objects.get(on.toKey()) as PDFDict;
    group.set('Usage', new PDFDict([['View', new PDFDict([['ViewState', new PDFName('OFF')]])]]));
    const config = (doc.catalog.getDict('OCProperties')!.getDict('D'))!;
    config.set('AS', new PDFArray([new PDFDict([['Event', new PDFName('View')], ['Category', new PDFArray([new PDFName('View')])], ['OCGs', new PDFArray([on])]])]));
    const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
    expect(visibility.isVisible(on)).toBe(false);
    (doc.objects.get(off.toKey()) as PDFDict).set('Intent', new PDFName('Design'));
    expect(visibility.isVisible(off)).toBe(true);
  });

  it('rejects malformed, unknown and cyclic visibility instead of showing it', async () => {
    const { doc, off } = await fixture();
    const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
    const expression = new PDFArray([new PDFName('Not')]); expression.items.push(expression);
    expect(() => visibility.isVisible(new PDFDict([['Type', new PDFName('OCMD')], ['VE', expression]]))).toThrow(/cyclic/i);
    expect(() => visibility.isVisible(new PDFRef(9999, 0))).toThrow(/unresolved/i);
    const unknown = new PDFDict([['Type', new PDFName('OCG')]]);
    expect(() => visibility.isVisible(unknown)).toThrow(/not registered/i);
    const badOr = new PDFArray([new PDFName('Or'), new PDFRef(301, 0), new PDFRef(9999, 0)]);
    expect(() => visibility.isVisible(new PDFDict([['Type', new PDFName('OCMD')], ['VE', badOr]]))).toThrow(/unresolved/i);
    expect(() => new OptionalContentVisibility(undefined, doc.objects).isVisible(off)).toThrow(/catalog/i);
    const d = doc.catalog.getDict('OCProperties')!.getDict('D')!;
    d.set('AS', new PDFArray([new PDFDict([['Event', new PDFName('View')], ['Category', new PDFArray([new PDFName('Zoom')])]])]));
    expect(() => new OptionalContentVisibility(doc.catalog, doc.objects)).toThrow(/unsupported.*category/i);
  });

  it('excludes hidden text from search and replacement while preserving its bytes', async () => {
    const { doc } = await fixture();
    doc.pages[0].resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    const content = bytes('BT /F1 12 Tf /OC /Hidden BDC (PRIVATE) Tj EMC (PUBLIC) Tj ET');
    const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
    expect(findTextInPage(content, doc.pages[0], doc.objects, 'PRIVATE', false, visibility)).toHaveLength(0);
    expect(findTextInPage(content, doc.pages[0], doc.objects, 'PUBLIC', false, visibility)).toHaveLength(1);
    const result = findAndReplace(content, doc.pages[0], doc.objects, 'PUBLIC', 'VISIBLE', false, undefined, visibility);
    expect(result.replacedCount).toBe(1);
    expect(new TextDecoder().decode(result.newContentBytes)).toContain('PRIVATE');
    expect(interpretPage(result.newContentBytes, doc.pages[0], doc.objects, visibility).textRuns.map(run => run.text).join('')).toBe('VISIBLE');
    await updatePageContent(doc.pages[0].contentRefs, content, doc.objects, false);
    expect(extractPagePlainText(doc, 0)).toContain('PUBLIC');
    expect(extractPagePlainText(doc, 0)).not.toContain('PRIVATE');
  });

  it('requires a document visibility context in public interpret/search/replace paths', async () => {
    const { doc } = await fixture();
    const content = bytes('/OC /Hidden BDC 1 1 10 10 re f EMC');
    expect(() => interpretPage(content, doc.pages[0], doc.objects)).toThrow(/catalog is required/i);
    expect(() => findTextInPage(content, doc.pages[0], doc.objects, 'secret')).toThrow(/catalog is required/i);
    expect(() => findAndReplace(content, doc.pages[0], doc.objects, 'secret', 'x')).toThrow(/catalog is required/i);
    const ref = new PDFRef(310, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Subtype', new PDFName('Image')], ['OC', new PDFRef(300, 0)]]), new Uint8Array()));
    doc.pages[0].resources.set('XObject', new PDFDict([['Image', ref]]));
    expect(() => interpretPage(bytes('/Image Do'), doc.pages[0], doc.objects)).toThrow(/catalog is required/i);
  });

  it('does not rewrite hidden TJ text during normalisation', async () => {
    const { doc } = await fixture();
    doc.pages[0].resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    const content = bytes('BT /F1 12 Tf /OC /Hidden BDC [(PRIVATE) -5000 (SECRET)] TJ EMC (PUBLIC) Tj ET');
    const result = explodeTJGaps(content, doc.pages[0], doc.objects, new OptionalContentVisibility(doc.catalog, doc.objects));
    expect(result).toEqual(content);
  });

  it('keeps hidden glyphs unchanged when visible text and its style are edited', async () => {
    const { doc, off } = await fixture();
    doc.pages[0].resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    const content = bytes('BT /F1 12 Tf 1 0 0 1 10 50 Tm /OC /Hidden BDC (SECRET) Tj EMC 1 0 0 1 10 50 Tm (PUBLIC) Tj ET');
    await updatePageContent(doc.pages[0].contentRefs, content, doc.objects, false);
    const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
    const flow = buildDocumentFlow(interpretPage(content, doc.pages[0], doc.objects, visibility).textRuns);
    expect(flow.lines).toHaveLength(1);
    const edited = applyLineTextEdit(content, doc.pages[0], doc.objects, flow.lines[0], 'VISIBLE', flow, { optionalContent: visibility });
    await updatePageContent(doc.pages[0].contentRefs, edited.newContentBytes, doc.objects, false);
    const freshFlow = buildDocumentFlow(interpretPage(edited.newContentBytes, doc.pages[0], doc.objects, visibility).textRuns);
    await applyStyleToSelectionOnPage(doc, 0, freshFlow.lines[0], 0, 2, { fontSize: 14 });
    const config = doc.catalog.getDict('OCProperties')!.getDict('D')!;
    config.set('OFF', new PDFArray([]));
    const allRuns = interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects,
      new OptionalContentVisibility(doc.catalog, doc.objects)).textRuns;
    const secret = allRuns.find(run => run.text.includes('SECRET'));
    expect(secret?.text).toBe('SECRET');
    expect(secret?.fontSize).toBe(12);
    expect(secret?.x).toBe(10);
    expect(off.toKey()).toBe('300_0');
  });

  it('does not expose a hidden form widget in page hit testing but retains it in the document', async () => {
    const pdf = await PDFDocument.create(); const pdfPage = pdf.addPage([100, 100]);
    const form = pdf.getForm(); const field = form.createTextField('private');
    field.addToPage(pdfPage, { x: 10, y: 10, width: 50, height: 20 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    expect(widget).toBeDefined();
    const ref = new PDFRef(300, 0); doc.objects.set(ref.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([ref])], ['D', new PDFDict([['OFF', new PDFArray([ref])]])]]));
    widget.dict.set('OC', ref);
    expect(detectFormFieldsOnPage(doc, 0)).toHaveLength(0);
    expect(listAllFormWidgets(doc)).toHaveLength(1);
    const saved = await serializeDocument(doc);
    const reopened = await parsePDF(saved);
    expect(detectFormFieldsOnPage(reopened, 0)).toHaveLength(0);
    expect(listAllFormWidgets(reopened)).toHaveLength(1);
  });

  it('honors annotation Hidden/NoView flags while retaining standard Invisible semantics', async () => {
    const { doc } = await fixture();
    const annotation = new PDFDict([['Subtype', new PDFName('Widget')]]);
    const flags = new PDFRef(310, 0); annotation.set('F', flags);
    doc.objects.set(flags.toKey(), new PDFNumber(2));
    expect(isAnnotationVisible(annotation, doc.objects)).toBe(false);
    doc.objects.set(flags.toKey(), new PDFNumber(32));
    expect(isAnnotationVisible(annotation, doc.objects)).toBe(false);
    doc.objects.set(flags.toKey(), new PDFNumber(1));
    expect(isAnnotationVisible(annotation, doc.objects)).toBe(true);
    annotation.set('Subtype', new PDFName('VendorExtension'));
    expect(isAnnotationVisible(annotation, doc.objects)).toBe(false);
    doc.objects.delete(flags.toKey());
    expect(() => isAnnotationVisible(annotation, doc.objects)).toThrow(/invalid flags/i);
  });

  it.each([2, 32])('keeps a flagged widget in the PDF while excluding it from page interaction: flag %i', async flag => {
    const pdf = await PDFDocument.create(); const pdfPage = pdf.addPage([100, 100]);
    const form = pdf.getForm(); const field = form.createTextField('private');
    field.addToPage(pdfPage, { x: 10, y: 10, width: 50, height: 20 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const widget = detectFormFieldsOnPage(doc, 0)[0]; widget.dict.set('F', new PDFNumber(flag));
    expect(detectFormFieldsOnPage(doc, 0)).toHaveLength(0);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(detectFormFieldsOnPage(reopened, 0)).toHaveLength(0);
    expect(listAllFormWidgets(reopened)[0].dict.getNumber('F')).toBe(flag);
  });

  it('bounds repeated visibility expressions without exponential traversal', async () => {
    const { doc, on } = await fixture();
    let branch: PDFObject = on;
    for (let i = 0; i < 40; i++) branch = new PDFArray([new PDFName('And'), branch, branch]);
    const membership = new PDFDict([['Type', new PDFName('OCMD')], ['VE', branch]]);
    expect(new OptionalContentVisibility(doc.catalog, doc.objects).isVisible(membership)).toBe(true);
  });

  it('honors optional visibility attached to image and form XObjects', async () => {
    const { doc, off, on } = await fixture();
    const resources = doc.pages[0].resources;
    const hidden = new PDFRef(302, 0), shown = new PDFRef(303, 0);
    const makeImage = (layer: PDFObject) => new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Width', new PDFNumber(1)], ['Height', new PDFNumber(1)], ['OC', layer],
    ]), new Uint8Array([0]));
    doc.objects.set(hidden.toKey(), makeImage(off)); doc.objects.set(shown.toKey(), makeImage(on));
    resources.set('XObject', new PDFDict([['HiddenImage', hidden], ['ShownImage', shown]]));
    const result = interpretPage(bytes('/HiddenImage Do /ShownImage Do'), doc.pages[0], doc.objects, new OptionalContentVisibility(doc.catalog, doc.objects));
    expect(result.displayList.filter(item => item.type === 'image').map(item => item.name)).toEqual(['ShownImage']);
  });
});
