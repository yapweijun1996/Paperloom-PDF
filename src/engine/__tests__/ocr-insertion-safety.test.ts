import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { insertInvisibleTextLayer } from '../editor/invisible-text';
import { SessionDocumentEditor } from '../session/document-edit';
import { saveQuick } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';

const words = [{ text: 'HELLO', bbox: { x: 20, y: 60, width: 40, height: 10 } }];
function fixture(content: string, inherited = false) {
  const resources = '/Resources << /Font << /Helv << /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >> /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count 1 ${inherited ? resources : ''} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] ${inherited ? '' : resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}
const popplerAvailable = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;

describe('OCR insertion safety', () => {
  it.skipIf(!popplerAvailable)('preserves inherited resources and positions OCR despite the original CTM after incremental save', async () => {
    const input = fixture('BT /F1 10 Tf 1 0 0 1 10 90 Tm (ORIGINAL) Tj ET\n2 0 0 2 0 0 cm', true);
    const doc = await parsePDF(input);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'ocr', staged => insertInvisibleTextLayer(staged, 0, words));
    const output = await saveQuick(doc, new Set([doc.pages[0].ref.toKey()]));
    expect(output.slice(0, input.length)).toEqual(input);
    const independent = await PDFDocument.load(output);
    expect(independent.getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-ocr-safe-'));
    try {
      const path = join(dir, 'output.pdf'); writeFileSync(path, output);
      const text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
      expect(text).toContain('ORIGINAL');
      expect(text).toContain('HELLO');
      const bbox = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
      expect(bbox).toMatch(/<word xMin="20\.000000"[^>]*>HELLO<\/word>/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(await editor.undo(doc)).toBe(true);
    expect(await editor.redo(doc)).toBe(true);
  });

  it.each(['Q', 'q', 'BT', 'EMC', '/Span BMC', 'BX', '(unterminated', '123'])
    ('refuses unbalanced or incomplete content %s without changing the document', async content => {
      const doc = await parsePDF(fixture(content));
      const before = await serializeDocument(doc);
      await expect(insertInvisibleTextLayer(doc, 0, words)).rejects.toThrow(/OCR|unbalanced/i);
      expect(await serializeDocument(doc)).toEqual(before);
    });

  it('refuses unsupported Unicode before changing any resources or content', async () => {
    const doc = await parsePDF(fixture(''));
    const before = await serializeDocument(doc);
    await expect(insertInvisibleTextLayer(doc, 0, [{ ...words[0], text: 'café' }])).rejects.toThrow(/represented safely/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
