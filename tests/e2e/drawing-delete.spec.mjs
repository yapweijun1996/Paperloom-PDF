import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// Browser-printed layout: a scaling cm, a full-width background band, and a card
// painted three times on top of itself (as Chrome's PDF printer does).
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]);
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream([
    'q 0.5 0 0 0.5 0 0 cm',
    '0.95 0.93 0.85 rg 0 40 400 300 re f',
    '0.2 0.5 0.3 rg 40 40 200 200 re f 40 40 200 200 re f 40 40 200 200 re f',
    '0.9 0.1 0.1 rg 300 300 40 40 re f',
    'Q',
  ].join('\n'))));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

const pixelAt = (surface, fx, fy) => surface.evaluate((canvas, [x, y]) =>
  Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width * x), Math.round(canvas.height * y), 1, 1).data), [fx, fy]);

test('deletes a stacked drawing from a browser-printed PDF and ignores background bands', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'printed.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  const clickAt = (px, py) => page.mouse.click(box.x + box.width * px / 200, box.y + box.height * (1 - py / 200));

  // The green card (page space 20..120) is drawn three times; its centre is green.
  const green = await pixelAt(surface, 70 / 200, 1 - 70 / 200);
  expect(green[1]).toBeGreaterThan(green[0] + 40);

  // Clicking the full-width background band outside the card selects nothing.
  await clickAt(160, 100);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

  await clickAt(70, 70);
  const remove = page.getByRole('button', { name: 'Delete', exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.getByText(/Delete failed/)).toHaveCount(0);
  await expect.poll(async () => {
    const [r, g] = await pixelAt(surface, 70 / 200, 1 - 70 / 200);
    return g - r;
  }).toBeLessThan(20);
  // The red square drawn after the card keeps its own colour.
  const red = await pixelAt(surface, 160 / 200, 1 - 160 / 200);
  expect(red[0]).toBeGreaterThan(red[1] + 80);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => {
    const [r, g] = await pixelAt(surface, 70 / 200, 1 - 70 / 200);
    return g - r;
  }).toBeGreaterThan(40);
});

test('duplicates a drawing with the button and Ctrl/Cmd+D, and duplicates a text box', async ({ page }) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'printed.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  const clickAt = (px, py) => page.mouse.click(box.x + box.width * px / 200, box.y + box.height * (1 - py / 200));
  const greenAt = async (px, py) => {
    const [r, g] = await pixelAt(surface, px / 200, 1 - py / 200);
    return g - r > 40;
  };

  // Only the copies (offset 12pt right, then mirrored up near the page bottom) cover these points.
  expect(await greenAt(126, 15)).toBe(false);
  expect(await greenAt(138, 110)).toBe(false);

  await clickAt(70, 70);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByText(/Duplicate failed/)).toHaveCount(0);
  await expect.poll(() => greenAt(126, 15)).toBe(true);
  // The copy is selected, so the shortcut copies it again.
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeVisible();
  await page.keyboard.press(`${mod}+d`);
  await expect.poll(() => greenAt(138, 110)).toBe(true);

  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => greenAt(138, 110)).toBe(false);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => greenAt(126, 15)).toBe(false);
  expect(await greenAt(70, 70)).toBe(true);

  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.getByRole('button', { name: 'Add Text Box' }).click();
  await clickAt(160, 40);
  await page.getByRole('button', { name: 'Duplicate text box' }).click();
  await expect.poll(() => page.locator('textarea').evaluateAll(els => els.filter(el => el.value === 'New Text').length)).toBe(2);
});
