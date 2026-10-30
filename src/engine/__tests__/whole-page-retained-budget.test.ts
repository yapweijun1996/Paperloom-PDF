import { expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFName, PDFNumber, PDFStream } from '../types';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

async function fixture(retained: number, textAt: (page: number) => string | null) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const removedFont = await pdf.embedFont(StandardFonts.Helvetica);
  const retainedFont = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([200, 200]).drawText('X', { font: removedFont });
  for (let i = 0; i < retained; i++) {
    const page = pdf.addPage([200, 200]);
    if (textAt(i) !== null) page.drawText('X', { font: retainedFont });
  }
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (let i = 0; i <= retained; i++) {
    const text = i === 0 ? 'PRIVATE_NOTE' : textAt(i - 1);
    if (text === null) continue;
    const fonts = doc.pages[i].resources.get('Font') as PDFDict;
    const font = [...fonts.keys()][0];
    const content = `BT /${font} 12 Tf ${i === 0 ? '20 20' : '30 30'} Td (${text}) Tj ET`;
    await updatePageContent(doc.pages[i].contentRefs, new TextEncoder().encode(content), doc.objects, false);
  }
  redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
  return parsePDF(await serializeDocument(doc));
}

async function expectRefusedWithoutChange(doc: Awaited<ReturnType<typeof fixture>>) {
  const before = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow();
  await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
  expect(await serializeDocument(doc)).toEqual(before);
  expect((await PDFDocument.load(before, { updateMetadata: false })).getPageCount()).toBe(doc.pages.length);
}

it('checks a copy on the 65th retained page even after empty pages', async () => {
  const doc = await fixture(65, i => i === 64 ? 'PRIVATE_NOTE' : null);
  await expectRefusedWithoutChange(doc);
});

it('refuses more than 64 retained content pages before mutation', async () => {
  const doc = await fixture(65, i => i === 64 ? 'PRIVATE_NOTE' : 'VISIBLE');
  await expectRefusedWithoutChange(doc);
});

it('allows 64 independently inspectable retained content pages without a copy', async () => {
  const doc = await fixture(64, () => 'VISIBLE');
  const result = await redactionEngine.applySecureRedactions(doc);
  expect(result.annotationsRemoved).toBe(1);
  const output = await saveQuick(doc);
  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  expect(reopened.getPageCount()).toBe(65);
  const directory = mkdtempSync(join(tmpdir(), 'retained-control-'));
  try {
    const path = join(directory, 'out.pdf');
    writeFileSync(path, output);
    const text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
    expect(text).toContain('VISIBLE');
    expect(text).not.toContain('PRIVATE_NOTE');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each(['unknown', 'broken-flate'] as const)('refuses %s retained filters', async kind => {
  const doc = await fixture(1, () => 'VISIBLE');
  const ref = doc.pages[1].contentRefs[0];
  const bytes = new Uint8Array([0, 1, 2, 3]);
  doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
    ['Length', new PDFNumber(bytes.length)], ['Filter', new PDFName(kind === 'unknown' ? 'Unknown' : 'FlateDecode')],
  ]), bytes));
  await expectRefusedWithoutChange(doc);
});

it('refuses retained content whose text objects cannot be fully inspected', async () => {
  const doc = await fixture(1, () => 'VISIBLE');
  await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode('BT (VISIBLE) Tj'), doc.objects, false);
  await expectRefusedWithoutChange(doc);
});

it('refuses retained-content inspection that exceeds the cumulative byte budget', async () => {
  const doc = await fixture(5, () => 'VISIBLE');
  for (const page of doc.pages.slice(1)) {
    const stream = doc.objects.get(page.contentRefs[0].toKey()) as PDFStream;
    const bytes = new Uint8Array(60_000 + stream.rawBytes.length);
    bytes.fill(32, 0, 60_000);
    bytes.set(stream.rawBytes, 60_000);
    doc.objects.set(page.contentRefs[0].toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
  }
  await expectRefusedWithoutChange(doc);
});
