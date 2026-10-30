import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

for (const angle of [90, 30]) {
  test(`finds rotated cross-run text at ${angle} degrees and refuses replacement`, async ({ page }) => {
    const pdf = await PDFDocument.create();
    const sheet = pdf.addPage([400, 400]);
    const regular = await pdf.embedFont(StandardFonts.Courier);
    const bold = await pdf.embedFont(StandardFonts.CourierBold);
    const radians = angle * Math.PI / 180;
    const advance = regular.widthOfTextAtSize('Alpha', 18);
    sheet.drawText('Alpha', { x: 150, y: 100, size: 18, font: regular, rotate: degrees(angle) });
    sheet.drawText('Beta', { x: 150 + advance * Math.cos(radians), y: 100 + advance * Math.sin(radians),
      size: 18, font: bold, rotate: degrees(angle) });
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'rotated.pdf', mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
    await expect(page).toHaveURL(/\/editor\/?$/);
    await page.getByTitle('Toggle Find & Replace').click();
    await page.getByPlaceholder('Search text in PDF...').fill('AlphaBeta');
    await expect(page.getByText('1/1', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'The current match cannot be highlighted reliably because of its position or clipping.' })).toBeVisible();
    await expect(page.locator('[data-search-highlight="true"]')).toHaveCount(0);
    await page.getByPlaceholder('Replace with...').fill('GammaZeta');
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.getByText('Replacing rotated text spanning multiple runs is not supported.')).toBeVisible();
    await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  });
}
