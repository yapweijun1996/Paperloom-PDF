import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';

async function fixture() {
  const source = await PDFDocument.create();
  const firstFont = await source.embedFont(StandardFonts.Helvetica);
  const secondFont = await source.embedFont(StandardFonts.Courier);
  source.addPage([200, 200]).drawText('PRIVATE FIRST PAGE', { x: 10, y: 100, size: 12, font: firstFont });
  source.addPage([200, 200]).drawText('PUBLIC SECOND PAGE', { x: 10, y: 100, size: 12, font: secondFont });
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const retainedContent = getPageContentBytes(doc.pages[1], doc.objects).slice();
  await updatePageContent(doc.pages[1].contentRefs, retainedContent, doc.objects, false);
  return parsePDF(await saveQuick(doc));
}

describe('public secure redaction API', () => {
  it('clears an isolated fully marked page and preserves the second page in an independent reader', async () => {
    const doc = await fixture();
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({ pagesProcessed: 1, pagesCleared: 1 });
    const bytes = await saveQuick(doc);
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('PRIVATE FIRST PAGE');
    const independent = await PDFDocument.load(bytes);
    expect(independent.getPageCount()).toBe(2);
    expect(independent.getPage(0).getSize()).toEqual({ width: 200, height: 200 });
    const folder = mkdtempSync(join(tmpdir(), 'paperloom-redact-'));
    try {
      const path = join(folder, 'output.pdf');
      const input = join(folder, 'input.pdf');
      writeFileSync(input, doc.rawBytes);
      writeFileSync(path, bytes);
      try {
        const original = execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' });
        expect(original).toContain('PRIVATE FIRST PAGE');
        const text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
        expect(text).toContain('PUBLIC SECOND PAGE');
        expect(text).not.toContain('PRIVATE FIRST PAGE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('removes covered image and vector objects while retaining disjoint graphics', async () => {
    const source = await PDFDocument.create(); source.addPage([200, 200]);
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    const image = new TextEncoder().encode('PRIVATE_IMAGE_DATA');
    const ref = new PDFRef(900, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(image.length)],
    ]), image, image));
    doc.pages[0].resources = new PDFDict([['XObject', new PDFDict([['Im0', ref]])]]);
    doc.pages[0].dict.set('Resources', doc.pages[0].resources);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(
      'q 20 0 0 20 10 10 cm /Im0 Do Q\n1 0 0 rg 15 15 5 5 re f\n0 0 1 rg 100 100 10 10 re f',
    ), doc.objects, false);
    redactionEngine.markRegion(doc, 0, { x: 5, y: 5, width: 30, height: 30 });
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({ imageOperatorsRemoved: 1, pathOperatorsRemoved: 1 });
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE_IMAGE_DATA');
    const reopened = await parsePDF(bytes);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('/Im0 Do');
    expect(content).not.toContain('15 15 5 5 re');
    expect(content).toContain('100 100 10 10 re');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
