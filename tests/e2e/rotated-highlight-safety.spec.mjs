import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, beginText, endText, setFontAndSize, setCharacterSpacing, setTextMatrix, showText } from 'pdf-lib';

test('finds spaced rotated text without drawing an incorrectly positioned highlight', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([300, 300]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  const fontName = sheet.node.newFontDictionary('SearchFont', font.ref);
  sheet.pushOperators(beginText(), setFontAndSize(fontName, 12), setCharacterSpacing(2),
    setTextMatrix(0, 1, -1, 0, 150, 100), showText(font.encodeText('Alpha')), endText());
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'spaced-rotated.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('Alpha');
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The current match cannot be highlighted reliably because of its position or clipping.' })).toBeVisible();
  await expect(page.locator('[data-search-highlight="true"]')).toHaveCount(0);
});
