import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFBoolean, PDFDict, PDFName, PDFString } from '../types';
import { parsePDF, resolveRef } from '../parser/parser';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { flattenFormFieldsOnPage } from '../forms/apply-field';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;

async function staleTextFixture(needsAppearances: boolean) {
  const input = readFileSync(join(process.cwd(), 'src/engine/__tests__/golden/fixtures/cc0-sample-form-filled.pdf'));
  const doc = await parsePDF(input);
  const widget = detectFormFieldsOnPage(doc, 0).find(field => field.fieldName === 'applicant.name')!;
  let field = widget.dict;
  while (!field.has('V')) {
    const parent = resolveRef(field.get('Parent')!, doc.objects);
    if (!(parent instanceof PDFDict)) throw new Error('Expected a field value in the fixture.');
    field = parent;
  }
  field.set('V', new PDFString('LATESTVALUE'));
  const form = resolveRef(doc.catalog.get('AcroForm')!, doc.objects);
  if (!(form instanceof PDFDict)) throw new Error('Expected an AcroForm in the fixture.');
  form.set('NeedAppearances', new PDFBoolean(needsAppearances));
  return serializeDocument(doc);
}

describe('independent flatten consistency checks', () => {
  it('refuses a viewer-generated appearance without changing the saved document', async () => {
    const before = await staleTextFixture(true);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-flatten-audit-'));
    try {
      const input = join(dir, 'input.pdf');
      writeFileSync(input, before);
      if (hasPoppler) expect(execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' })).toContain('LATESTVALUE');
      const doc = await parsePDF(before);
      const widget = detectFormFieldsOnPage(doc, 0).find(field => field.fieldName === 'applicant.name')!;
      await expect(flattenFormFieldsOnPage(doc, 0, [widget])).rejects.toThrow(/viewer-generated/i);
      expect(await serializeDocument(doc)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses stale text appearances even when viewer generation is disabled', async () => {
    const before = await staleTextFixture(false);
    const doc = await parsePDF(before);
    const widget = detectFormFieldsOnPage(doc, 0).find(field => field.fieldName === 'applicant.name')!;
    expect(widget.value).toBe('LATESTVALUE');
    await expect(flattenFormFieldsOnPage(doc, 0, [widget])).rejects.toThrow(/appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a button appearance inconsistent with its selected value', async () => {
    const input = readFileSync(join(process.cwd(), 'src/engine/__tests__/golden/fixtures/cc0-sample-form-filled.pdf'));
    const doc = await parsePDF(input);
    const widget = detectFormFieldsOnPage(doc, 0).find(field => field.fieldName === 'applicant.subscribe')!;
    expect(widget.value).toBe('Yes');
    widget.dict.set('AS', new PDFName('Off'));
    const before = await serializeDocument(doc);
    const reopened = await parsePDF(before);
    const selected = detectFormFieldsOnPage(reopened, 0).find(field => field.fieldName === 'applicant.subscribe')!;
    await expect(flattenFormFieldsOnPage(reopened, 0, [selected])).rejects.toThrow(/appearance/i);
    expect(await serializeDocument(reopened)).toEqual(before);
  });

  it('uses the current value when given an older widget view', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R /Annots [6 0 R] >>',
      '<< /Length 0 >>\nstream\nendstream',
      '<< /Fields [6 0 R] >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [10 10 100 30] /V (Before) /P 3 0 R /F 4 >>',
    ]));
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.dict.set('V', new PDFString('LATEST'));
    await flattenFormFieldsOnPage(doc, 0, [widget]);
    const output = await serializeDocument(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-flatten-audit-'));
    try {
      const file = join(dir, 'output.pdf');
      writeFileSync(file, output);
      if (hasPoppler) expect(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })).toContain('LATEST');
      expect(detectFormFieldsOnPage(await parsePDF(output), 0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
