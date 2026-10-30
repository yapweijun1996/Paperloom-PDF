import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';

const area = { x: 5, y: 75, width: 520, height: 50 };
const secret = 'BT $FONT 10 Tf 40 100 Td < 5\x003\t6\n5\f6\r3 7\x002 6\t5 7\n4 > Tj ET';

async function fixture(first = secret, second = 'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET') {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) pdf.addPage([600, 500]).drawText('fixture', { font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  for (let i = 0; i < 2; i++) {
    const page = doc.pages[i], fonts = page.resources.getDict('Font')!;
    const name = [...fonts.keys()][0];
    page.resources = new PDFDict([['Font', fonts]]);
    page.dict.set('Resources', page.resources);
    page.dict.set('Contents', page.contentRefs[0]);
    const content = (i === 0 ? first : second).replaceAll('$FONT', `/${name}`) + '\n';
    await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
  }
  return parsePDF(await serializeDocument(doc));
}

async function assertRefusedUnchanged(doc: Awaited<ReturnType<typeof fixture>>, message?: RegExp) {
  redactionEngine.markRegion(doc, 0, area);
  const before = await serializeDocument(doc);
  expect(() => prepareIsolatedTextRedaction(doc)).toThrow(message);
  expect(await serializeDocument(doc)).toEqual(before);
  expect(doc.requiresFullRewrite).toBeUndefined();
}

describe('independent whitespace-hex redaction audit', () => {
  it('refuses a NUL-separated hex copy in a directly created retained annotation', async () => {
    const doc = await fixture();
    const annotation = new PDFDict([
      ['Subtype', new PDFName('Text')],
      ['Rect', new PDFArray([new PDFNumber(10), new PDFNumber(10), new PDFNumber(20), new PDFNumber(20)])],
      ['Contents', new PDFHexString('5\x0036\x0056\x0037\x0026\x0057\x004')],
    ]);
    doc.pages[1].dict.set('Annots', new PDFArray([annotation]));
    await assertRefusedUnchanged(doc, /retained data contains redacted text/);
  });

  it('refuses a mixed-encoding copy split across separate retained content streams', async () => {
    const doc = await fixture(), page = doc.pages[1];
    const name = [...page.resources.getDict('Font')!.keys()][0];
    const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
    const refs = [page.contentRefs[0], new PDFRef(next, 0)];
    const blocks = [
      `BT /${name} 10 Tf 40 300 Td < 5\x003 6\t5 6\n3 > Tj ET\n`,
      `BT /${name} 10 Tf 40 350 Td (ret) Tj ET\n`,
    ];
    blocks.forEach((text, index) => {
      const bytes = new TextEncoder().encode(text);
      doc.objects.set(refs[index].toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
    });
    page.dict.set('Contents', new PDFArray(refs));
    page.contentRefs.splice(0, page.contentRefs.length, ...refs);
    await assertRefusedUnchanged(doc, /retained data contains redacted text/);
  });

  it.each([
    ['vertical tab', '<53\x0b65 63 72 65 74> Tj'],
    ['comment between TJ items', '[<53 65 63> %comment\n <72 65 74>] TJ'],
    ['odd nibble in a TJ item', '[<53 65 6> <72 65 74>] TJ'],
  ])('refuses %s without mutating any object', async (_label, operand) => {
    await assertRefusedUnchanged(await fixture(`BT $FONT 10 Tf 40 100 Td ${operand} ET`));
  });
});

const hiddenOptions = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };

async function hiddenFixture(retained: string) {
  const pdf = await PDFDocument.create(); pdf.addPage([220, 220]);
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
  doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString(retained), new PDFHexString('01020304')]));
  return doc;
}

describe('independent retained hex checks in other cleanup paths', () => {
  it('refuses a NUL-separated metadata copy during whole-page redaction', async () => {
    const doc = await fixture('BT (SECRET) Tj ET');
    doc.pages[0].resources = new PDFDict();
    doc.pages[0].dict.set('Resources', doc.pages[0].resources);
    const information = new PDFDict([['Private', new PDFHexString('5\x0034\x0054\x0035\x0024\x0055\x004')]]);
    const infoRef = new PDFRef(990, 0);
    doc.objects.set(infoRef.toKey(), information);
    doc.xref.trailerDict.set('Info', infoRef);
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 600, height: 500 });
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/contains removed text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a NUL-separated trailer copy during hidden-layer cleanup', async () => {
    const doc = await hiddenFixture('5\x0034\x0054\x0035\x0024\x0055\x004');
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, hiddenOptions)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
