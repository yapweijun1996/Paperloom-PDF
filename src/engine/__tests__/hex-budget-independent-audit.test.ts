import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';

const hiddenOptions = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const information = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...information.keys()]) information.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  const page = doc.pages[0];
  page.resources.set('Properties', new PDFDict([['Hidden', group]]));
  page.resources.set('Font', new PDFDict([['F1', font]]));
  page.dict.set('Resources', page.resources);
  const content = 'BT /F1 12 Tf 1 0 0 1 20 160 Tm (PUBLIC) Tj ET\n/OC /Hidden BDC q BT /F1 12 Tf 1 0 0 1 20 100 Tm (SECRET) Tj ET Q EMC\n';
  await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
  return doc;
}

describe('bounded hex inspection in security cleanup', () => {
  it('accepts a small valid hex trailer during hidden layer cleanup', async () => {
    const doc = await fixture();
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString('01 02'), new PDFHexString('03 04')]));
    await expect(sanitizationEngine.sanitize(doc, hiddenOptions)).resolves.toBeDefined();
    expect(doc.catalog.has('OCProperties')).toBe(false);
  });

  it('rejects aggregate whitespace-heavy retained hex objects before hidden layer cleanup mutates', async () => {
    const doc = await fixture();
    const longHex = `01${' '.repeat(140_000)}`;
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString(longHex), new PDFHexString(longHex)]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, hiddenOptions)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects aggregate whitespace-heavy retained hex objects before whole-page redaction mutates', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([220, 220]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const longHex = `01${' '.repeat(140_000)}`;
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString(longHex), new PDFHexString(longHex)]));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 220, height: 220 });
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained hex strings cannot be inspected/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('accepts a small valid hex trailer during whole-page redaction', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([220, 220]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString('01 02'), new PDFHexString('03 04')]));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 220, height: 220 });
    expect(prepareWholePageRedaction(doc)).toBeDefined();
  });

  it.each(['010G', '01\v02'])('refuses malformed retained hex %j before whole-page redaction mutates', async value => {
    const pdf = await PDFDocument.create(); pdf.addPage([220, 220]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString(value), new PDFHexString('0102')]));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 220, height: 220 });
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained hex strings cannot be inspected/);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
