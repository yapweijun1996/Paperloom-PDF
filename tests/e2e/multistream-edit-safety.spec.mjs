import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('opens a cross-stream literal without changing it and refuses replacement', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 200]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdfPage.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font.ref } }));
  const first = pdf.context.register(pdf.context.stream('BT /F1 12 Tf 10 110 Td [(FIRST'));
  const second = pdf.context.register(pdf.context.stream('SECOND) -4000 (THIRD)] TJ ET'));
  pdfPage.node.set(PDFName.of('Contents'), pdf.context.obj([first, second]));
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'boundary.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await expect(page.getByTitle('Download original / edited PDF (no recompression)')).toBeVisible();
  await expect(page.getByText(/content stream boundary cannot be safely merged/i)).toBeVisible();
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('FIRST');
  await page.getByPlaceholder('Replace with...').fill('CHANGED');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByText(/content stream boundary cannot be safely merged/i)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const path = await download.path(); if (!path) throw new Error('missing download');
  const directory = mkdtempSync(join(tmpdir(),'paperloom-boundary-ui17-'));
  try {
    const file = join(directory,'output.pdf'); writeFileSync(file,readFileSync(path));
    const text = execFileSync('pdftotext',['-raw',file,'-'],{encoding:'utf8'});
    expect(text).toContain('FIRSTSECOND'); expect(text).not.toContain('CHANGED');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
