import { describe, expect, it } from 'vitest';
import { PDFArray as LibArray, PDFDict as LibDict, PDFDocument, PDFName as LibName, PDFRef as LibRef } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

async function fixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([300, 300]);
  pdf.addPage([300, 300]);
  const field = pdf.getForm().createTextField('Group.Value');
  field.setText('field value');
  field.addToPage(first);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const parentRef = new PDFRef(900, 0), popupRef = new PDFRef(901, 0);
  const rect = new PDFArray([10, 10, 110, 60].map(value => new PDFNumber(value)));
  const parent = new PDFDict([
    ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')], ['Rect', rect],
    ['Contents', new PDFString('A note')], ['Popup', popupRef], ['P', doc.pages[0].ref],
  ]);
  const popup = new PDFDict([
    ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Popup')], ['Rect', rect],
    ['Parent', parentRef], ['P', doc.pages[0].ref],
  ]);
  doc.objects.set(parentRef.toKey(), parent);
  doc.objects.set(popupRef.toKey(), popup);
  doc.pages[0].dict.getArray('Annots')!.push(parentRef);
  doc.pages[0].dict.getArray('Annots')!.push(popupRef);
  return { doc, parent, popup, parentRef, popupRef };
}

async function targetFixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

async function assertReopened(bytes: Uint8Array, index: number) {
  const pdf = await PDFDocument.load(bytes);
  const annots = pdf.getPage(index).node.Annots() as LibArray;
  const entries = annots.asArray();
  const parentRef = entries.find(ref => pdf.context.lookup(ref, LibDict).get(LibName.of('Subtype')) === LibName.of('Text')) as LibRef;
  const popupRef = entries.find(ref => pdf.context.lookup(ref, LibDict).get(LibName.of('Subtype')) === LibName.of('Popup')) as LibRef;
  expect(parentRef).toBeInstanceOf(LibRef);
  expect(popupRef).toBeInstanceOf(LibRef);
  const parent = pdf.context.lookup(parentRef, LibDict), popup = pdf.context.lookup(popupRef, LibDict);
  expect(popup.get(LibName.of('Parent'))).toBe(parentRef);
  expect(parent.get(LibName.of('Popup'))).toBe(popupRef);
  expect(pdf.getForm().getTextField('Group.Value').getText()).toBe('field value');
  pdf.getForm().getTextField('Group.Value').setText('editable');
  const again = await PDFDocument.load(await pdf.save({ useObjectStreams: false }));
  expect(again.getForm().getTextField('Group.Value').getText()).toBe('editable');
}

describe('copying page popup relationships', () => {
  it('preserves popup and parent links through extraction and insertion without changing the source', async () => {
    const { doc } = await fixture();
    const before = await serializeDocument(doc);
    await assertReopened(before, 0);
    await assertReopened(await serializeDocument(extractPages(doc, [0])), 0);
    const target = await targetFixture();
    insertPagesFromDocument(target, doc, 1);
    await assertReopened(await serializeDocument(target), 1);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['foreign-page', 'missing-parent', 'mismatched-backlink', 'direct-cycle', 'deep-graph'] as const)(
    'refuses %s before either extraction or target insertion changes data', async kind => {
      const { doc, parent, popup, parentRef } = await fixture();
      if (kind === 'foreign-page') parent.set('P', doc.pages[1].ref);
      if (kind === 'missing-parent') popup.set('Parent', new PDFRef(99999, 0));
      if (kind === 'mismatched-backlink') parent.set('Popup', parentRef);
      if (kind === 'direct-cycle') {
        const cycle = new PDFDict();
        cycle.set('Self', cycle);
        popup.set('Private', cycle);
      }
      if (kind === 'deep-graph') {
        let value = new PDFDict();
        for (let i = 0; i < 140; i++) value = new PDFDict([['Child', value]]);
        popup.set('Private', value);
      }
      const target = await targetFixture();
      const targetBefore = await serializeDocument(target);
      const sourceBefore = kind === 'direct-cycle' ? undefined : await serializeDocument(doc);
      const sourceObjectCount = doc.objects.size;
      expect(() => extractPages(doc, [0])).toThrow(/popup annotation/i);
      expect(() => insertPagesFromDocument(target, doc, 1)).toThrow(/popup annotation/i);
      expect(await serializeDocument(target)).toEqual(targetBefore);
      expect(doc.objects.size).toBe(sourceObjectCount);
      if (sourceBefore) expect(await serializeDocument(doc)).toEqual(sourceBefore);
      if (kind === 'direct-cycle') expect((popup.get('Private') as PDFDict).get('Self')).toBe(popup.get('Private'));
    },
  );
});
