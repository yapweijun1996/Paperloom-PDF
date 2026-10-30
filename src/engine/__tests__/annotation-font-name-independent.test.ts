import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';

it('rejects note fragments retained in page font names without changing the document', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);
  const page = doc.pages[0], other = doc.pages[1], note = new PDFRef(900, 0), stream = new PDFRef(901, 0);
  doc.objects.set(note.toKey(), new PDFDict([
    ['Subtype', new PDFName('Text')],
    ['Rect', new PDFArray([10, 10, 20, 20].map(n => new PDFNumber(n)))],
    ['Contents', new PDFString('ABCDEFGH')],
  ]));
  page.dict.set('Annots', new PDFArray([note]));
  const bytes = new TextEncoder().encode('BT /ABC 12 Tf 10 50 Td (JUMP) Tj /DEFGH 12 Tf (KLZZ) Tj ET');
  doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes));
  other.dict.set('Contents', stream);
  other.contentRefs.push(stream);
  const font = new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
    ['BaseFont', new PDFName('Helvetica')], ['Encoding', new PDFName('WinAnsiEncoding')],
  ]);
  other.resources.set('Font', new PDFDict([['ABC', font], ['DEFGH', font]]));
  other.dict.set('Resources', other.resources);
  redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
  const original = await serializeDocument(doc);
  expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
  expect(await serializeDocument(doc)).toEqual(original);
  const reopened = await parsePDF(original);
  const content = reopened.objects.get(reopened.pages[1].contentRefs[0].toKey()) as PDFStream;
  const raw = new TextDecoder().decode(content.rawBytes);
  expect(raw).toContain('/ABC');
  expect(raw).toContain('/DEFGH');
  if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-note-font-'));
    try {
      const path = join(dir, 'original.pdf');
      writeFileSync(path, original);
      expect(execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' })).toContain('JUMPKLZZ');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
