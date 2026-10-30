import { it, expect } from 'vitest';
import { PDFDocument, PDFName as Name, PDFDict as Dict, PDFArray as Arr, PDFRef as Ref } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from '../types';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

it('preserves widget popup and field parent links in saved extracted and inserted documents', async () => {
  const source = await PDFDocument.create(), page = source.addPage([300, 300]);
  const field = source.getForm().createTextField('Group.Value');
  field.setText('value'); field.addToPage(page);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const annots = doc.pages[0].dict.getArray('Annots')!;
  const widgetRef = annots.items[0] as PDFRef;
  const widget = doc.objects.get(widgetRef.toKey()) as PDFDict;
  const popupRef = new PDFRef(999, 0);
  widget.set('Popup', popupRef);
  doc.objects.set(popupRef.toKey(), new PDFDict([['Type', new PDFName('Annot')], ['Subtype', new PDFName('Popup')], ['Parent', widgetRef], ['P', doc.pages[0].ref], ['Rect', new PDFArray([0,0,30,30].map(x => new PDFNumber(x)))]]));
  annots.push(popupRef);
  const targetSource = await PDFDocument.create(); targetSource.addPage([300,300]);
  const target = await parsePDF(await targetSource.save({useObjectStreams:false}));
  insertPagesFromDocument(target, doc, 1);
  const copies = [await serializeDocument(extractPages(doc,[0])), await serializeDocument(target)];
  for (let i=0; i<copies.length; i++) {
    const copy = await PDFDocument.load(copies[i]);
    const refs = (copy.getPage(i).node.Annots() as Arr).asArray();
    const w = refs.find(ref => copy.context.lookup(ref, Dict).get(Name.of('Subtype')) === Name.of('Widget')) as Ref;
    const p = refs.find(ref => copy.context.lookup(ref, Dict).get(Name.of('Subtype')) === Name.of('Popup')) as Ref;
    expect(copy.context.lookup(p, Dict).get(Name.of('Parent'))).toBe(w);
    expect(copy.context.lookup(w, Dict).get(Name.of('Popup'))).toBe(p);
    expect(copy.context.lookup(w, Dict).get(Name.of('Parent'))).toBeInstanceOf(Ref);
    expect(copy.getForm().getTextField('Group.Value').getText()).toBe('value');
  }
});

it('rejects omitted page reached through popup parent without mutating source', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300,300]); pdf.addPage([300,300]);
  const doc = await parsePDF(await pdf.save({useObjectStreams:false}));
  const parentRef = new PDFRef(900, 0), popupRef = new PDFRef(901, 0);
  const parent = new PDFDict([['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')], ['Popup', popupRef], ['Dest', new PDFArray([doc.pages[1].ref])]]);
  const popup = new PDFDict([['Type',new PDFName('Annot')], ['Subtype',new PDFName('Popup')], ['Parent',parentRef]]);
  doc.objects.set(parentRef.toKey(),parent); doc.objects.set(popupRef.toKey(),popup);
  doc.pages[0].dict.set('Annots', new PDFArray([parentRef,popupRef]));
  const before = await serializeDocument(doc);
  expect(() => extractPages(doc,[0])).toThrow(/outside the extraction/i);
  expect(await serializeDocument(doc)).toEqual(before);
});

it('copies an indirect cycle reachable through popup safely', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300,300]);
  const doc = await parsePDF(await pdf.save({useObjectStreams:false}));
  const parentRef = new PDFRef(900,0), popupRef = new PDFRef(901,0), cycleRef = new PDFRef(902,0);
  const parent = new PDFDict([['Type',new PDFName('Annot')], ['Subtype',new PDFName('Text')], ['Popup', popupRef]]);
  const popup = new PDFDict([['Type',new PDFName('Annot')], ['Subtype',new PDFName('Popup')], ['Parent',parentRef], ['Private',cycleRef]]);
  const cycle = new PDFDict([['Self',cycleRef]]);
  doc.objects.set(parentRef.toKey(),parent); doc.objects.set(popupRef.toKey(),popup); doc.objects.set(cycleRef.toKey(),cycle);
  doc.pages[0].dict.set('Annots', new PDFArray([parentRef,popupRef]));
  const saved = await serializeDocument(extractPages(doc,[0]));
  const reopened = await PDFDocument.load(saved);
  const refs = (reopened.getPage(0).node.Annots() as Arr).asArray();
  const p = refs.find(ref => reopened.context.lookup(ref, Dict).get(Name.of('Subtype')) === Name.of('Popup')) as Ref;
  const copiedCycleRef = reopened.context.lookup(p,Dict).get(Name.of('Private')) as Ref;
  expect(reopened.context.lookup(copiedCycleRef,Dict).get(Name.of('Self'))).toBe(copiedCycleRef);
});
