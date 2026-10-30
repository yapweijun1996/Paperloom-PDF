import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, drawObject } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 300]).drawText('Original page', { x: 30, y: 250, size: 14, font });
  const broken = pdf.addPage([300, 300]);
  const form = pdf.context.flateStream('q Q', { Type: 'XObject', Subtype: 'Form', Resources: {} });
  const name = broken.node.newXObject('Broken', pdf.context.register(form));
  broken.pushOperators(drawObject(name));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function makeDelayedFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 300]).drawText('First page', { x: 30, y: 250, size: 14, font });
  const slow = pdf.addPage([300, 300]);
  const image = await pdf.embedJpg(readFileSync(new URL('../../src/engine/__tests__/golden/fixtures/nara-amendment-24-scan.jpg', import.meta.url)));
  slow.drawImage(image, { x: 0, y: 0, width: 100, height: 100 });
  const form = pdf.context.flateStream('q Q', { Type: 'XObject', Subtype: 'Form', Resources: {} });
  slow.pushOperators(drawObject(slow.node.newXObject('Broken', pdf.context.register(form))));
  pdf.addPage([300, 300]).drawText('Third page', { x: 30, y: 250, size: 14, font });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

test('a failed page render clears stale content while preserving unsaved edits', async ({ page }) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'render-failure.pdf', mimeType: 'application/pdf', buffer: await makeFixture() });
  await expect(page).toHaveURL(/\/editor\/?$/);
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('Original');
  await page.getByPlaceholder('Replace with...').fill('Changed');
  const replace = page.getByRole('button', { name: 'Replace', exact: true });
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Unable to display this page. Your edits are preserved.')).toBeVisible();
  await expect(surface.locator('canvas.pdf-canvas')).toHaveCount(0);
  await expect(surface).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Search text in PDF...').fill('Changed');
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  // Search may navigate to its result. Return to the broken page before
  // attempting a replacement so the guard is exercised on a failed render.
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Unable to display this page. Your edits are preserved.')).toBeVisible();
  await replace.click();
  await expect(page.getByText('The current page is not available for editing.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry rendering' }).click();
  await expect(page.getByText('Unable to display this page. Your edits are preserved.')).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await expect(surface).toHaveAttribute('aria-hidden', 'false');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const directory = mkdtempSync(join(tmpdir(), 'paperloom-render-failure-'));
  try {
    const file = join(directory, 'saved.pdf');
    writeFileSync(file, readFileSync(await download.path()));
    const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
    expect(text).toContain('Changed page');
    expect(text).not.toContain('Original page');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [width, height] of [[320, 640], [390, 844], [768, 720], [1024, 768], [1280, 720]]) {
  test(`render retry remains clickable with search open at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({
      name: 'render-failure.pdf', mimeType: 'application/pdf', buffer: await makeFixture(),
    });
    await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
    await page.getByTitle('Toggle Find & Replace').click();
    const search = page.getByPlaceholder('Search text in PDF...');
    await search.fill('Original');
    await page.getByRole('button', { name: 'Next page' }).click();
    const retry = page.getByRole('button', { name: 'Retry rendering' });
    await expect(retry).toBeVisible();
    const panelBox = await page.locator('[data-theme="dark"]').filter({ has: search }).boundingBox();
    const ocrBox = await page.getByTitle('OCR recognize text').boundingBox();
    const statusBox = await retry.locator('..').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(ocrBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox.x).toBeGreaterThanOrEqual(0);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(width);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(height);
    for (const box of [panelBox, ocrBox]) {
      const overlaps = statusBox.x < box.x + box.width && statusBox.x + statusBox.width > box.x &&
        statusBox.y < box.y + box.height && statusBox.y + statusBox.height > box.y;
      expect(overlaps).toBe(false);
    }
    await retry.click({ timeout: 5_000 });
    await expect(retry).toBeVisible();
    await page.getByTitle('Close Search').click();
    await expect(search).toHaveCount(0);
    await retry.click({ timeout: 5_000 });
    await expect(retry).toBeVisible();
  });
}

test('a failed zoom render preserves the in-progress text draft for retry', async ({ page }) => {
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (window.__paperloomFailTextRender) throw new Error('Injected text rendering failure');
      return fillText.apply(this, args);
    };
  });
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'render-failure.pdf', mimeType: 'application/pdf', buffer: await makeFixture() });
  await expect(page).toHaveURL(/\/editor\/?$/);
  const surface = page.locator('[data-page-render-surface]');
  const canvas = surface.locator('canvas.pdf-canvas');
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 38, y: 50 } });
  const draft = page.getByRole('textbox', { name: 'Edit line' });
  await expect(draft).toHaveValue('Original page');
  await draft.fill('Uncommitted draft');
  await page.evaluate(() => { window.__paperloomFailTextRender = true; });
  // Dispatching the click keeps the textarea focused until rendering invalidates
  // the surface, exercising the blur path without an intentional commit.
  await page.getByRole('button', { name: 'Zoom in' }).dispatchEvent('click');
  await expect(page.getByText('Unable to display this page. Your edits are preserved.')).toBeVisible();
  await expect(surface.locator('canvas.pdf-canvas')).toHaveCount(0);
  await page.evaluate(() => { window.__paperloomFailTextRender = false; });
  await page.getByRole('button', { name: 'Retry rendering' }).click();
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await expect(draft).toHaveValue('Uncommitted draft');
});

test('a late failure from an older page cannot clear a newer rendered page', async ({ page }) => {
  await page.addInitScript(() => {
    const createBitmap = window.createImageBitmap.bind(window);
    window.__paperloomHoldBitmaps = false;
    window.__paperloomHeldBitmaps = [];
    window.createImageBitmap = async (...args) => {
      if (window.__paperloomHoldBitmaps) await new Promise(resolve => window.__paperloomHeldBitmaps.push(resolve));
      return createBitmap(...args);
    };
  });
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'late-render.pdf', mimeType: 'application/pdf', buffer: await makeDelayedFixture() });
  await expect(page).toHaveURL(/\/editor\/?$/);
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.evaluate(() => { window.__paperloomHoldBitmaps = true; });
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction(() => window.__paperloomHeldBitmaps.length > 0);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('3 / 3', { exact: true })).toBeVisible();
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.evaluate(() => {
    window.__paperloomHoldBitmaps = false;
    for (const release of window.__paperloomHeldBitmaps.splice(0)) release();
  });
  await page.waitForTimeout(500);
  await expect(page.getByText('Unable to display this page. Your edits are preserved.')).toHaveCount(0);
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await expect(surface).toHaveAttribute('aria-hidden', 'false');
});
