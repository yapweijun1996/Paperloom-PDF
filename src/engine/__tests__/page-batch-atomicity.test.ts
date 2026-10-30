import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { deletePages } from '../writer/page-operations';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from '../types';

async function fixture(pageCount: number) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) pdf.addPage([300, 300]);
  const field = pdf.getForm().createTextField('Name');
  field.setText('retained value');
  field.addToPage(pdf.getPages()[0]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('batch page deletion', () => {
  it('refuses deletion of all pages without changing the document', async () => {
    const doc = await fixture(2);
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, [0, 1])).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.pages).toHaveLength(2);
  });

  it('refuses duplicate indices instead of deleting a different page', async () => {
    const doc = await fixture(3);
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, [1, 1])).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.pages).toHaveLength(3);
  });

  it('refuses a later ambiguous form deletion without deleting any earlier page', async () => {
    const doc = await fixture(3);
    const widgets = doc.pages[0].dict.get('Annots') as PDFArray;
    const widget = doc.objects.get((widgets.items[0] as PDFRef).toKey()) as PDFDict;
    widget.set('P', doc.pages[1].ref);
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, [0, 2])).toThrow(/ambiguous AcroForm/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.pages).toHaveLength(3);
  });

  it('deletes requested pages while preserving an independently editable surviving field', async () => {
    const doc = await fixture(3);
    deletePages(doc, [1, 2]);
    const bytes = await serializeDocument(doc);
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(1);
    expect(output.getForm().getTextField('Name').getText()).toBe('retained value');
    output.getForm().getTextField('Name').setText('edited');
    const reopened = await PDFDocument.load(await output.save({ useObjectStreams: false }));
    expect(reopened.getForm().getTextField('Name').getText()).toBe('edited');
  });

  it('prunes both deleted widgets of a three-page shared field in one plan', async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage([300, 300]), source.addPage([300, 300]), source.addPage([300, 300])];
    const shared = source.getForm().createTextField('Shared');
    shared.setText('original');
    for (const page of pages) shared.addToPage(page);
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    deletePages(doc, [0, 1]);
    const output = await PDFDocument.load(await serializeDocument(doc));
    const field = output.getForm().getTextField('Shared');
    expect(output.getPageCount()).toBe(1);
    expect(field.getText()).toBe('original');
    expect(field.acroField.getWidgets()).toHaveLength(1);
    field.setText('updated');
    const reopened = await PDFDocument.load(await output.save({ useObjectStreams: false }));
    expect(reopened.getForm().getTextField('Shared').getText()).toBe('updated');
  });

  it('removes the entire shared field when all of its widgets are deleted', async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage([300, 300]), source.addPage([300, 300]), source.addPage([300, 300])];
    const form = source.getForm();
    const removed = form.createTextField('Removed');
    removed.setText('private');
    removed.addToPage(pages[0]);
    removed.addToPage(pages[1]);
    const kept = form.createTextField('Kept');
    kept.setText('still here');
    kept.addToPage(pages[2]);
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    deletePages(doc, [0, 1]);
    const output = await PDFDocument.load(await serializeDocument(doc));
    expect(output.getForm().getFields().map(field => field.getName())).toEqual(['Kept']);
    expect(output.getForm().getTextField('Kept').getText()).toBe('still here');
  });

  it.each([-1, 3, 1.5, NaN, Infinity])('rejects invalid page index %s before changing anything', async index => {
    const doc = await fixture(3);
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, [2, index])).toThrow(/invalid page index/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([{ indices: [0] }, { indices: [0, 1] }])('rejects a recursive outline before deleting pages $indices', async ({ indices }) => {
    const doc = await fixture(3);
    const rootRef = new PDFRef(900, 0), firstRef = new PDFRef(901, 0), cycleRef = new PDFRef(902, 0);
    doc.objects.set(rootRef.toKey(), new PDFDict([['Type', new PDFName('Outlines')], ['First', firstRef], ['Last', cycleRef]]));
    doc.objects.set(firstRef.toKey(), new PDFDict([['Parent', rootRef], ['Next', cycleRef], ['Count', new PDFNumber(10)]]));
    doc.objects.set(cycleRef.toKey(), new PDFDict([['Parent', rootRef], ['First', cycleRef]]));
    doc.catalog.set('Outlines', rootRef);
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, indices)).toThrow(/destination tree/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.pages).toHaveLength(3);
  });

  it('removes links to deleted pages from a shared indirect annotation array without dangling references', async () => {
    const doc = await fixture(3);
    const arrayRef = new PDFRef(910, 0), linkRef = new PDFRef(911, 0);
    const link = new PDFDict([['Subtype', new PDFName('Link')], ['Dest', new PDFArray([doc.pages[0].ref, new PDFName('Fit')])]]);
    doc.objects.set(arrayRef.toKey(), new PDFArray([linkRef]));
    doc.objects.set(linkRef.toKey(), link);
    doc.pages[1].dict.set('Annots', arrayRef);
    doc.pages[2].dict.set('Annots', arrayRef);
    deletePages(doc, [0]);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(reopened.pages).toHaveLength(2);
    for (const page of reopened.pages) expect(page.dict.has('Annots')).toBe(false);
    const independentlyOpened = await PDFDocument.load(await serializeDocument(doc));
    expect(independentlyOpened.getPageCount()).toBe(2);
  });

  it('rejects a cyclic destination name tree before changing outlines or pages', async () => {
    const doc = await fixture(3);
    const treeRef = new PDFRef(920, 0);
    const tree = new PDFDict([['Kids', new PDFArray([treeRef])]]);
    doc.objects.set(treeRef.toKey(), tree);
    doc.catalog.set('Names', new PDFDict([['Dests', treeRef]]));
    const before = await serializeDocument(doc);
    expect(() => deletePages(doc, [0, 1])).toThrow(/destination tree/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
