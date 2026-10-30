import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function downloadPdf(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('Browser download did not produce a file');
  return readFileSync(path);
}

function readWithPoppler(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-e2e-'));
  try {
    const path = join(dir, 'output.pdf');
    writeFileSync(path, bytes);
    return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('edits and flattens a nested form while preserving values, then undoes flattening', async ({ page }) => {
  const bytes = readFileSync(join(process.cwd(), 'src/engine/__tests__/golden/fixtures/cc0-sample-form-filled.pdf'));
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'cc0-sample-form-filled.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await expect(page.getByText('Form Fields (6)', { exact: true })).toBeVisible();
  await page.getByText('applicant.name', { exact: true }).click();
  const input = page.getByLabel('Value', { exact: true });
  await expect(input).toHaveValue('Alex Sample');
  await input.fill('CHROME EXAMPLE');
  await input.press('Enter');
  await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeEnabled();
  await page.getByRole('button', { name: 'Flatten All', exact: true }).click();
  await expect(page.getByText('No AcroForm fields on this page.', { exact: false })).toBeVisible();
  const flat = await downloadPdf(page);
  const independent = await PDFDocument.load(flat);
  expect(independent.getForm().getFields()).toHaveLength(0);
  const text = readWithPoppler(flat);
  expect(text).toContain('CHROME EXAMPLE');
  expect(text).toContain('Ukraine');
  expect(text).not.toContain('Alex Sample');
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect(page.getByText('Form Fields (6)', { exact: true })).toBeVisible();
  const restored = (await PDFDocument.load(await downloadPdf(page))).getForm();
  expect(restored.getTextField('applicant.name').getText()).toBe('CHROME EXAMPLE');
  expect(restored.getCheckBox('applicant.subscribe').isChecked()).toBe(true);
  expect(restored.getRadioGroup('applicant.contact').getSelected()).toBe('email');
  expect(restored.getDropdown('applicant.country').getSelected()).toEqual(['Ukraine']);
});
