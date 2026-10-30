import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePDF } from '../../parser/parser';
import { detectFormFieldsOnPage } from '../../forms/detect-fields';
import { setFormFieldValue } from '../../forms/apply-field';
import { saveQuick } from '../../writer/save-pipeline';

const fixtures = join(process.cwd(), 'src/engine/__tests__/golden/fixtures');
const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;

describe('externally maintained CC0 form corpus', () => {
  it('reads each prefilled field and each physical widget once', async () => {
    const original = readFileSync(join(fixtures, 'cc0-sample-form-filled.pdf'));
    const doc = await parsePDF(new Uint8Array(original));
    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets).toHaveLength(6);
    expect(new Set(widgets.map(widget => widget.ref.toKey())).size).toBe(6);
    expect(widgets.find(widget => widget.fieldName === 'applicant.name')?.value).toBe('Alex Sample');
    expect(widgets.find(widget => widget.fieldName === 'applicant.notes')?.value).toBe('Generated example value.\nSecond line to prove multiline survives.');
    expect(widgets.find(widget => widget.fieldName === 'applicant.subscribe')?.appearanceState).toBe('Yes');
    expect(widgets.filter(widget => widget.fieldName === 'applicant.contact').map(widget => widget.appearanceState)).toEqual(['0', 'Off']);
    expect(widgets.find(widget => widget.fieldName === 'applicant.country')?.value).toBe('Ukraine');
  });

  it.skipIf(!hasPoppler)('edits a blank form and saves values readable by pdf-lib and Poppler', async () => {
    const original = readFileSync(join(fixtures, 'cc0-sample-form.pdf'));
    const doc = await parsePDF(new Uint8Array(original));
    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets).toHaveLength(6);
    setFormFieldValue(doc, widgets.find(widget => widget.fieldName === 'applicant.name')!, 'SYNTHETIC EXAMPLE');
    setFormFieldValue(doc, widgets.find(widget => widget.fieldName === 'applicant.notes')!, 'Line one\nLine two');
    setFormFieldValue(doc, widgets.find(widget => widget.fieldName === 'applicant.subscribe')!, true);
    setFormFieldValue(doc, widgets.filter(widget => widget.fieldName === 'applicant.contact')[1], true);
    setFormFieldValue(doc, widgets.find(widget => widget.fieldName === 'applicant.country')!, 'Germany');
    const output = await saveQuick(doc);
    const reopen = await parsePDF(output);
    expect(detectFormFieldsOnPage(reopen, 0)).toHaveLength(6);
    const independent = (await PDFDocument.load(output)).getForm();
    expect(independent.getTextField('applicant.name').getText()).toBe('SYNTHETIC EXAMPLE');
    expect(independent.getTextField('applicant.notes').getText()).toBe('Line one\nLine two');
    expect(independent.getCheckBox('applicant.subscribe').isChecked()).toBe(true);
    expect(independent.getRadioGroup('applicant.contact').getSelected()).toBe('phone');
    expect(independent.getDropdown('applicant.country').getSelected()).toEqual(['Germany']);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-cc0-form-'));
    try {
      const file = join(dir, 'saved.pdf');
      writeFileSync(file, output);
      const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
      expect(text).toContain('SYNTHETIC EXAMPLE');
      expect(text).toContain('Germany');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
