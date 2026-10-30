import { it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFRef } from '../types';
import { extractPages } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

it('does not create a dangling reference from a selected field to an omitted field', async () => {
  const pdf = await PDFDocument.create(), a=pdf.addPage([300,300]), b=pdf.addPage([300,300]);
  const keep=pdf.getForm().createTextField('Keep'); keep.addToPage(a);
  const omitted=pdf.getForm().createTextField('Omitted'); omitted.addToPage(b);
  const doc=await parsePDF(await pdf.save({useObjectStreams:false}));
  const acro=doc.objects.get((doc.catalog.get('AcroForm') as PDFRef).toKey()) as PDFDict;
  const roots=acro.get('Fields') as PDFArray;
  const keepRef=roots.items[0] as PDFRef, otherRef=roots.items[1] as PDFRef;
  (doc.objects.get(keepRef.toKey()) as PDFDict).set('CustomDependency',otherRef);
  const before=await serializeDocument(doc);
  let extracted: ReturnType<typeof extractPages> | undefined;
  try {
    extracted=extractPages(doc,[0]);
  } catch(e) {
    expect(String(e)).toMatch(/cannot safely|outside/i);
  }
  if (extracted) {
    const outputAcro=extracted.catalog.get('AcroForm') as PDFDict;
    const outputFields=outputAcro.get('Fields') as PDFArray;
    const outputField=extracted.objects.get((outputFields.items[0] as PDFRef).toKey()) as PDFDict;
    const dependency=outputField.get('CustomDependency') as PDFRef;
    expect(extracted.objects.has(dependency.toKey())).toBe(true);
  }
  expect(await serializeDocument(doc)).toEqual(before);
});
