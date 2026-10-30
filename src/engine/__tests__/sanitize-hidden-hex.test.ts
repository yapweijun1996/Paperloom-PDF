import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, PDFString } from '../types';

const opts = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };
const secret = 'SECREP';
const hidden = (operand: string) => `/OC /Hidden BDC q BT /F1 12 Tf 1 0 0 1 20 100 Tm ${operand} Tj ET Q EMC`;
const visible = (operand: string) => `BT /F1 12 Tf 1 0 0 1 20 40 Tm ${operand} Tj ET`;

async function fixture(contents: string[]) {
  const pdf = await PDFDocument.create();
  for (const _content of contents) pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const information = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...information.keys()]) information.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  for (let i = 0; i < contents.length; i++) {
    const page = doc.pages[i];
    page.resources.set('Properties', new PDFDict([['Hidden', group]]));
    page.resources.set('Font', new PDFDict([['F1', font]]));
    page.dict.set('Resources', page.resources);
    await updatePageContent(page.contentRefs, new TextEncoder().encode(contents[i]), doc.objects, false);
  }
  return doc;
}

const poppler = ['pdftotext', 'pdftoppm'].every(name => spawnSync(name, ['-v'], { stdio: 'ignore' }).status === 0);
describe('hidden layer cleanup with hex text operands', () => {
  it.skipIf(!poppler)('removes odd-nibble hidden text and retains visible hex text after save', async () => {
    const content = `${hidden('<53\x00 45\t43\n52\f45\r5>')}\n${visible('<50 55 42 4c 49 43>')}`;
    const original = await serializeDocument(await fixture([content]));
    const doc = await parsePDF(original);
    expect((await sanitizationEngine.sanitize(doc, opts)).detail.layersRemoved).toBe(1);
    const saved = await saveQuick(doc), reopened = await parsePDF(saved);
    expect(reopened.catalog.has('OCProperties')).toBe(false);
    const stream = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream;
    const contentAfter = new TextDecoder().decode(stream.getBytes());
    expect(contentAfter).not.toContain('<53');
    expect(contentAfter).toContain('<50 55 42 4c 49 43>');
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-hex-'));
    try {
      const before = join(dir, 'before.pdf'), after = join(dir, 'after.pdf'), enabled = join(dir, 'enabled.pdf');
      writeFileSync(before, original); writeFileSync(after, saved);
      // Verify the independently rendered odd-nibble operand with its layer enabled.
      const enabledDoc = await parsePDF(original);
      const config = enabledDoc.catalog.getDict('OCProperties')!.getDict('D')!;
      config.set('OFF', new PDFArray());
      writeFileSync(enabled, await serializeDocument(enabledDoc));
      if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
        execFileSync('qpdf', ['--check', before]); execFileSync('qpdf', ['--check', after]);
      } else if (process.env.CI) throw new Error('qpdf is required for CI verification');
      const text = execFileSync('pdftotext', [after, '-'], { encoding: 'utf8' });
      expect(text).toContain('PUBLIC'); expect(text).not.toContain(secret);
      expect(execFileSync('pdftotext', [enabled, '-'], { encoding: 'utf8' })).toContain(secret);
      for (const dpi of [36, 72, 150, 300]) {
        execFileSync('pdftoppm', ['-singlefile', '-r', String(dpi), before, join(dir, `before-${dpi}`)]);
        execFileSync('pdftoppm', ['-singlefile', '-r', String(dpi), after, join(dir, `after-${dpi}`)]);
        expect(readFileSync(join(dir, `before-${dpi}.ppm`))).toEqual(readFileSync(join(dir, `after-${dpi}.ppm`)));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    ['literal text', `(SECREP)`],
    ['hex text', '<53 45 43 52 45 50>'],
  ])('rejects a retained %s copy on another page without mutation', async (_name, operand) => {
    const doc = await fixture([hidden('<53 45 43 52 45 5>'), visible(operand)]);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects joined hidden fragments retained on another page without mutation', async () => {
    const split = hidden('<53 45 43> Tj <52 45 5>');
    const doc = await fixture([split, visible('(SECREP)')]);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a UTF-16 retained copy in the trailer without mutation', async () => {
    const doc = await fixture([hidden('<53 45 43 52 45 5>'), visible('(PUBLIC)')]);
    doc.xref.trailerDict.set('ID', new PDFArray([new PDFHexString('FEFF005300450043005200450050')]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([
    ['invalid character', '<53 45 43 52 45 5G>'],
    ['comment', '<53 45 % comment\n43 52 45 50>'],
    ['comment between operands', '<53 45 43> % comment\n Tj <52 45 50>'],
    ['unterminated', '<53 45 43 52 45 50'],
    ['unsupported non-ASCII decoded byte', '<53 45 43 52 ff>'],
    ['oversized content', `<${'41'.repeat(32_768)}> `],
  ])('rejects %s without mutation', async (_name, operand) => {
    const doc = await fixture([hidden(operand)]);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
