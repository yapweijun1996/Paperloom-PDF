import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';

test('cleanup explains how to apply it and the downloaded copy omits metadata', async ({ page }) => {
  const source = await PDFDocument.create();
  source.addPage([400, 400]);
  source.setTitle('PRIVATE-TITLE-FIXTURE');
  const original = Buffer.from(await source.save({ useObjectStreams: false }));
  const originalSnapshot = Buffer.from(original);
  const titleBytes = Buffer.from('FEFF0050005200490056004100540045002D005400490054004C0045002D0046004900580054005500520045');
  expect(original.includes(titleBytes)).toBe(true);

  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'private.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Clean', exact: true }).click();
  await page.getByRole('button', { name: 'Sanitize document', exact: true }).click();
  await expect(page.getByText(/Download a new copy to apply changes; the original file is unchanged\./)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('Browser download did not produce a file');
  const cleaned = readFileSync(path);
  const reopened = await PDFDocument.load(cleaned, { updateMetadata: false });
  expect(reopened.getTitle()).toBeUndefined();
  expect(cleaned.includes(titleBytes)).toBe(false);
  expect(original.equals(originalSnapshot)).toBe(true);
  expect((await PDFDocument.load(original, { updateMetadata: false })).getTitle()).toBe('PRIVATE-TITLE-FIXTURE');
});
