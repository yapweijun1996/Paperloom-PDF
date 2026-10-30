import { describe, expect, it } from 'vitest';
import { PDFArray as LibArray, PDFDict as LibDict, PDFDocument, PDFName as LibName, PDFRef as LibRef } from 'pdf-lib';
import { parsePDF, resolveRef } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocumentData } from '../types';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

async function fixture(actionTarget: 'root' | 'omitted' | 'name' = 'root') {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([300, 300]), second = pdf.addPage([300, 300]);
  const field = pdf.getForm().createTextField('Group.First');
  field.setText('first value');
  field.addToPage(first);
  const other = pdf.getForm().createTextField('Group.Second');
  other.setText('second value');
  other.addToPage(second);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const acro = resolveRef(doc.catalog.get('AcroForm')!, doc.objects) as PDFDict;
  const rootRef = (resolveRef(acro.get('Fields')!, doc.objects) as PDFArray).items[0] as PDFRef;
  const root = resolveRef(rootRef, doc.objects) as PDFDict;
  const omittedRef = root.getArray('Kids')!.items[1] as PDFRef;
  const linkRef = new PDFRef(902, 0);
  const link = new PDFDict([
    ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Link')],
    ['Rect', new PDFArray([0, 0, 100, 30].map(value => new PDFNumber(value)))],
    ['A', new PDFDict([
      ['S', new PDFName('ResetForm')],
      ['Fields', new PDFArray([actionTarget === 'name' ? new PDFString('Group.First') : actionTarget === 'omitted' ? omittedRef : rootRef])],
    ])],
  ]);
  doc.objects.set(linkRef.toKey(), link);
  doc.pages[0].dict.getArray('Annots')!.push(linkRef);
  return doc;
}

async function targetFixture(conflict = false): Promise<PDFDocumentData> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  if (conflict) pdf.getForm().createTextField('Group.Existing').addToPage(page);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

async function verify(bytes: Uint8Array, pageIndex: number, includeSecond: boolean) {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  expect(form.getTextField('Group.First').getText()).toBe('first value');
  expect(form.getFields().map(field => field.getName())).toEqual(includeSecond ? ['Group.First', 'Group.Second'] : ['Group.First']);
  const annots = pdf.getPage(pageIndex).node.Annots() as LibArray;
  const linkRef = annots.asArray().find(ref => pdf.context.lookup(ref, LibDict).get(LibName.of('Subtype')) === LibName.of('Link')) as LibRef;
  const link = pdf.context.lookup(linkRef, LibDict);
  const action = pdf.context.lookup(link.get(LibName.of('A')), LibDict);
  expect(action.get(LibName.of('S'))).toBe(LibName.of('ResetForm'));
  const fields = pdf.context.lookup(action.get(LibName.of('Fields')), LibArray);
  const acroRoots = pdf.context.lookup(pdf.catalog.lookup(LibName.of('AcroForm'), LibDict).get(LibName.of('Fields')), LibArray);
  expect(fields.get(0)).toBe(acroRoots.get(0));
  form.getTextField('Group.First').setText('edited');
  const reopened = await PDFDocument.load(await pdf.save({ useObjectStreams: false }));
  expect(reopened.getForm().getTextField('Group.First').getText()).toBe('edited');
}

describe('page action references to form fields', () => {
  it('rebuilds the referenced field tree after extracting a subset', async () => {
    const doc = await fixture(), before = await serializeDocument(doc);
    await verify(before, 0, true);
    await verify(await serializeDocument(extractPages(doc, [0])), 0, false);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rebuilds the referenced field tree after inserting all source pages', async () => {
    const doc = await fixture(), before = await serializeDocument(doc), target = await targetFixture();
    insertPagesFromDocument(target, doc, 1);
    await verify(await serializeDocument(target), 1, true);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['omitted', 'name'] as const)('rejects an action referencing %s fields before extraction', async mode => {
    const doc = await fixture(mode), before = await serializeDocument(doc);
    expect(() => extractPages(doc, [0])).toThrow(/safely/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a name conflict involving an action before insertion mutates either document', async () => {
    const doc = await fixture(), target = await targetFixture(true);
    const sourceBefore = await serializeDocument(doc), targetBefore = await serializeDocument(target);
    expect(() => insertPagesFromDocument(target, doc, 1)).toThrow(/conflicting AcroForm root names/i);
    expect(await serializeDocument(doc)).toEqual(sourceBefore);
    expect(await serializeDocument(target)).toEqual(targetBefore);
  });

  it('rejects an excessively deep unselected field branch before insertion', async () => {
    const doc = await fixture(), target = await targetFixture();
    const acro = resolveRef(doc.catalog.get('AcroForm')!, doc.objects) as PDFDict;
    const fields = resolveRef(acro.get('Fields')!, doc.objects) as PDFArray;
    const first = new PDFRef(1000, 0);
    fields.push(first);
    for (let i = 0; i < 140; i++) {
      const dict = new PDFDict();
      if (i === 0) dict.set('T', new PDFString('Deep'));
      if (i > 0) dict.set('Parent', new PDFRef(999 + i, 0));
      if (i < 139) dict.set('Kids', new PDFArray([new PDFRef(1001 + i, 0)]));
      doc.objects.set(new PDFRef(1000 + i, 0).toKey(), dict);
    }
    const before = await serializeDocument(target);
    expect(() => insertPagesFromDocument(target, doc, 1)).toThrow(/safely/);
    expect(await serializeDocument(target)).toEqual(before);
  });
});
