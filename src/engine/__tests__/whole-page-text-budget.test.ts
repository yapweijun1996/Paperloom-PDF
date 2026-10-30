import { expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';

async function markedTextFixture(text: (fontName: string) => string) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  page.drawText('X', { font: await pdf.embedFont(StandardFonts.Helvetica) });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const fonts = doc.pages[0].resources.get('Font') as PDFDict;
  const fontName = [...fonts.keys()][0];
  await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(text(fontName)), doc.objects, false);
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);
  info.set('Title', new PDFString('PRIVATE_NOTE'));
  redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
  return parsePDF(await serializeDocument(doc));
}

it('refuses overflow of marked text patterns rather than skipping a retained copy', async () => {
  const doc = await markedTextFixture(font => `BT /${font} 12 Tf 20 20 Td ${Array(64).fill('(AAAA) Tj').join(' ')} (PRIVATE_NOTE) Tj ET`);
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/inspection limit/i);
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
  const reopened = await PDFDocument.load(before, { updateMetadata: false });
  expect(reopened.getTitle()).toBe('PRIVATE_NOTE');
});

it('refuses incomplete marked text parsing without changing the document', async () => {
  const doc = await markedTextFixture(font => `BT /${font} 12 Tf (PRIVATE_NOTE) Tj`);
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/cannot be inspected/i);
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
});

it('refuses excessive marked content operators without changing the document', async () => {
  const doc = await markedTextFixture(font => `${'q Q '.repeat(2048)} BT /${font} 12 Tf (PRIVATE_NOTE) Tj ET`);
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/inspection limit/i);
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
});

it('refuses an exhausted cumulative marked-content byte budget', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 5; i++) pdf.addPage([20, 20]).drawText('X');
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (let i = 0; i < 5; i++) {
    await updatePageContent(doc.pages[i].contentRefs, new TextEncoder().encode(' '.repeat(60_000)), doc.objects, false);
    redactionEngine.markRegion(doc, i, { x: 0, y: 0, width: 20, height: 20 });
  }
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/inspection limit/i);
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
});

it('refuses more marked pages than the text inspection budget without changing the document', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 65; i++) pdf.addPage([20, 20]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (let i = 0; i < 65; i++) redactionEngine.markRegion(doc, i, { x: 0, y: 0, width: 20, height: 20 });
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/inspection limit/i);
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
});
