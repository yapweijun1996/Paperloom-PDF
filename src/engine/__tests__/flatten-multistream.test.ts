import { PDFDocument } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { flattenFormFieldsOnPage } from '../forms/apply-field';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 && spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`;
const form = (first: string, second: string, shared = false) => rawPDF([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] >> >>',
  `<< /Type /Pages /Kids [3 0 R${shared ? ' 8 0 R' : ''}] /Count ${shared ? 2 : 1} >>`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 140] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents [4 0 R 5 0 R] /Annots [7 0 R] >>',
  stream(first), stream(second), 'null',
  '<< /Type /Annot /Subtype /Widget /P 3 0 R /F 4 /FT /Tx /T (Form) /Rect [10 10 110 30] /V (VALUE) >>',
  ...(shared ? ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 140] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents [4 0 R 5 0 R] >>'] : []),
]);
async function raster(file: string, directory: string, label: string, page: number) {
  const prefix = join(directory, label);
  execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-r', '72', '-png', file, prefix]);
  const image = await loadImage(readFileSync(`${prefix}.png`));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

describe('flatten pages with multiple content streams', () => {
  it.skipIf(!poppler)('preserves a comment that spans the stream boundary', async () => {
    const first = 'BT /F1 10 Tf 10 110 Td (FIRST) Tj ET % comment';
    const second = 'BT /F1 10 Tf 10 90 Td (SECOND) Tj ET';
    const doc = await parsePDF(form(first, second));
    const directory = mkdtempSync(join(tmpdir(), 'flatten-comment-'));
    try {
      const before = join(directory, 'before.pdf'), after = join(directory, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      const original = execFileSync('pdftotext', ['-raw', before, '-'], { encoding: 'utf8' });
      expect(original).toContain('FIRST'); expect(original).not.toContain('SECOND');
      await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
      writeFileSync(after, await serializeDocument(doc));
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(text).toContain('FIRST'); expect(text).not.toContain('SECOND'); expect(text).toContain('VALUE');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler)('preserves text when a string crosses a stream boundary', async () => {
    const first = 'BT /F1 10 Tf 10 110 Td (FIRST';
    const second = 'SECOND) Tj ET';
    const doc = await parsePDF(form(first, second));
    const directory = mkdtempSync(join(tmpdir(), 'flatten-string-'));
    try {
      const before = join(directory, 'before.pdf'), after = join(directory, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      const original = execFileSync('pdftotext', ['-raw', before, '-'], { encoding: 'utf8' });
      await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
      writeFileSync(after, await serializeDocument(doc));
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(original.trim()).toBe('FIRSTSECOND');
      expect(text).toContain('FIRSTSECOND');
      expect(text).not.toContain('FIRST SECOND');
      expect(text).toContain('VALUE');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler)('repairs an incomplete content cache before choosing multi-stream handling', async () => {
    const doc = await parsePDF(form('BT /F1 10 Tf 10 110 Td (FIRST', 'SECOND) Tj ET'));
    doc.pages[0].contentRefs.splice(0);
    doc.pages[0].contentInspectionComplete = false;
    await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
    const directory = mkdtempSync(join(tmpdir(), 'flatten-cache-'));
    try {
      const after = join(directory, 'after.pdf');
      writeFileSync(after, await serializeDocument(doc));
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(text).toContain('FIRSTSECOND');
      expect(text).not.toContain('FIRST SECOND');
      expect(text).toContain('VALUE');
      expect((await PDFDocument.load(readFileSync(after), { updateMetadata: false })).getForm().getFields()).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler)('preserves compressed content streams while saving and reopening', async () => {
    const doc = await parsePDF(form('BT /F1 10 Tf 10 110 Td (FIRST) Tj ET ', 'BT /F1 10 Tf 10 90 Td (SECOND) Tj ET'));
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey());
    if (!(stream instanceof PDFStream)) throw new Error('Expected stream');
    const decoded = stream.rawBytes;
    stream.rawBytes = new Uint8Array(deflateSync(decoded));
    stream.decodedBytes = decoded;
    stream.dict.set('Filter', new PDFName('FlateDecode'));
    stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
    const reparsed = await parsePDF(await serializeDocument(doc));
    await flattenFormFieldsOnPage(reparsed, 0, detectFormFieldsOnPage(reparsed, 0));
    const directory = mkdtempSync(join(tmpdir(), 'flatten-compressed-'));
    try {
      const after = join(directory, 'after.pdf');
      writeFileSync(after, await serializeDocument(reparsed));
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(text).toContain('FIRST'); expect(text).toContain('SECOND'); expect(text).toContain('VALUE');
      expect((await PDFDocument.load(readFileSync(after), { updateMetadata: false })).getForm().getFields()).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['unbalanced', 'unknown filter', 'missing filter', 'missing parameters', 'stale cache', 'split number', 'too many streams', 'incomplete broken cache'] as const)('refuses %s before changing document', async kind => {
    const doc = await parsePDF(form(kind === 'unbalanced' ? 'q' : kind === 'split number' ? '10' : 'q Q', kind === 'split number' ? '20 m' : 'q Q'));
    if (kind === 'unknown filter') {
      const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey());
      if (!(stream instanceof PDFStream)) throw new Error('Expected stream');
      stream.dict.set('Filter', new PDFName('Unrecognized'));
    }
    if (kind === 'missing filter' || kind === 'missing parameters') {
      const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey());
      if (!(stream instanceof PDFStream)) throw new Error('Expected stream');
      stream.dict.set(kind === 'missing filter' ? 'Filter' : 'DecodeParms', new PDFRef(9999, 0));
    }
    if (kind === 'incomplete broken cache') {
      doc.pages[0].dict.set('Contents', new PDFArray([new PDFRef(9999, 0)]));
      doc.pages[0].contentRefs.splice(0);
      doc.pages[0].contentInspectionComplete = false;
    }
    if (kind === 'stale cache') doc.pages[0].contentRefs.reverse();
    if (kind === 'too many streams') {
      const refs = Array.from({ length: 4097 }, () => doc.pages[0].contentRefs[0]);
      doc.pages[0].dict.set('Contents', new PDFArray(refs));
      doc.pages[0].contentRefs.splice(0);
      for (const ref of refs) doc.pages[0].contentRefs.push(ref);
    }
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0))).rejects.toThrow(/safely|content|appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.skipIf(!poppler)('preserves cross-stream graphics state and shared pages', async () => {
    const first = 'q 2 0 0 2 0 0 cm BT /F1 10 Tf 8 55 Td (FIRST) Tj ET';
    const second = 'BT /F1 10 Tf 8 40 Td (SECOND) Tj ET Q';
    const doc = await parsePDF(form(first, second, true));
    expect(doc.pages[0].contentRefs.length).toBe(2);
    const directory = mkdtempSync(join(tmpdir(), 'flatten-multistream-'));
    try {
      const before = join(directory, 'before.pdf'), after = join(directory, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      const beforePage1 = await raster(before, directory, 'before1', 1);
      const beforePage2 = await raster(before, directory, 'before2', 2);
      await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
      writeFileSync(after, await serializeDocument(doc));
      const afterPage1 = await raster(after, directory, 'after1', 1);
      const afterPage2 = await raster(after, directory, 'after2', 2);
      expect(afterPage2).toEqual(beforePage2);
      for (let pixel = 0; pixel < 160 * 140; pixel++) {
        const x = pixel % 160, y = Math.floor(pixel / 160);
        if (x >= 8 && x <= 112 && y >= 108 && y <= 132) continue;
        expect(afterPage1.slice(pixel * 4, pixel * 4 + 4)).toEqual(beforePage1.slice(pixel * 4, pixel * 4 + 4));
      }
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(text).toContain('FIRST'); expect(text).toContain('SECOND'); expect(text).toContain('VALUE');
      const reopened = await PDFDocument.load(readFileSync(after), { updateMetadata: false });
      expect(reopened.getPageCount()).toBe(2);
      expect(reopened.getForm().getFields()).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
});
