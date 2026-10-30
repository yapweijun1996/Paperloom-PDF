import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument } from '../writer/serializer';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from '../types';

const opts = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };

it('refuses escaped hidden graphics state without changing the document or visible pages', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([220, 220]); pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const information = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...information.keys()]) information.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  const contents = [
    '/OC /Hidden BDC q Q 1 0 0 rg q BT /F1 12 Tf 1 0 0 1 20 100 Tm (CONFIDENTIAL-729) Tj ET Q EMC\nBT /F1 12 Tf 1 0 0 1 20 40 Tm (VISIBLE-PUBLIC) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 20 40 Tm (SECOND-PAGE) Tj ET',
  ];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    page.resources.set('Properties', new PDFDict([['Hidden', group]]));
    page.resources.set('Font', new PDFDict([['F1', font]]));
    page.dict.set('Resources', page.resources);
    await updatePageContent(page.contentRefs, new TextEncoder().encode(contents[i]), doc.objects, false);
  }
  const before = await serializeDocument(doc);
  await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
  const after = await serializeDocument(doc);
  expect(after).toEqual(before);
  expect(doc.requiresFullRewrite).toBeUndefined();
  if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-color-'));
  try {
    const a = join(dir, 'before.pdf'), b = join(dir, 'after.pdf');
    writeFileSync(a, before); writeFileSync(b, after);
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', '150', a, join(dir, 'before')]);
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', '150', b, join(dir, 'after')]);
    const beforeImage = readFileSync(join(dir, 'before.ppm'));
    const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(beforeImage.toString('latin1', 0, 64));
    if (!header) throw new Error('Unexpected PPM output');
    const pixels = beforeImage.subarray(header[0].length);
    let redPixels = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] > 150 && pixels[i + 1] < 100 && pixels[i + 2] < 100) redPixels++;
    }
    expect(redPixels).toBeGreaterThan(0);
    expect(beforeImage.equals(readFileSync(join(dir, 'after.ppm')))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
