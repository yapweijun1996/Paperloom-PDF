import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Corpus original', { x: 50, y: 300, size: 18, font });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await expect(page.getByTitle('Download original / edited PDF (no recompression)')).toBeVisible();
}

async function downloadPdf(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('Browser download did not produce a file');
  return readFileSync(path);
}

function pdfText(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-e2e-text-'));
  try {
    const path = join(dir, 'output.pdf');
    writeFileSync(path, bytes);
    return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('upload, replace, download, and reopen a static export', async ({ page, browser }) => {
  await openPdf(page, await makePdf());
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('original');
  await page.getByPlaceholder('Replace with...').fill('edited');
  const replace = page.getByRole('button', { name: 'Replace', exact: true });
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  const bytes = await downloadPdf(page);
  expect(pdfText(bytes)).toContain('Corpus edited');
  expect(pdfText(bytes)).not.toContain('Corpus original');
  const reopenedContext = await browser.newContext();
  try {
    const reopened = await reopenedContext.newPage();
    await openPdf(reopened, bytes);
    await reopened.getByTitle('Toggle Find & Replace').click();
    await reopened.getByPlaceholder('Search text in PDF...').fill('edited');
    await expect(reopened.getByRole('button', { name: 'Replace', exact: true })).toBeEnabled();
  } finally { await reopenedContext.close(); }
});

test('finds adjacent text runs, rejects unsafe replacements and saves a supported edit', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const docPage = pdf.addPage([400, 400]);
  const regular = await pdf.embedFont(StandardFonts.Courier);
  const bold = await pdf.embedFont(StandardFonts.CourierBold);
  const size = 18, x = 50, y = 300;
  docPage.drawText('Alpha', { x, y, size, font: regular });
  docPage.drawText('Beta', { x: x + regular.widthOfTextAtSize('Alpha', size), y, size, font: bold });
  await openPdf(page, Buffer.from(await pdf.save({ useObjectStreams: false })));
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('AlphaBeta');
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Replace with...').fill('Changed');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByText(/Text spanning multiple runs cannot be replaced unless/)).toBeVisible();
  let output = await downloadPdf(page);
  expect(pdfText(output)).toContain('AlphaBeta');
  expect(pdfText(output)).not.toContain('Changed');
  await page.getByPlaceholder('Replace with...').fill('GammaZeta');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  output = await downloadPdf(page);
  expect(pdfText(output)).toContain('GammaZeta');
  expect(pdfText(output)).not.toContain('AlphaBeta');
});

test('aligns the search highlight with text on a rotated cropped page', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText('Viewport', { x: 100, y: 200, size: 24, font });
  pdfPage.setCropBox(50, 75, 300, 250);
  pdfPage.setRotation(degrees(90));
  await openPdf(page, Buffer.from(await pdf.save({ useObjectStreams: false })));
  await page.getByTitle('Toggle Find & Replace').click();
  await page.getByPlaceholder('Search text in PDF...').fill('Viewport');
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  const highlight = page.locator('[data-search-highlight="true"]');
  await expect(highlight).toHaveCount(1);
  const result = await highlight.evaluate(element => {
    const canvas = element.parentElement?.querySelector('canvas');
    if (!canvas) throw new Error('Rendered PDF canvas is unavailable');
    const box = element.getBoundingClientRect(), canvasBox = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvasBox.width, scaleY = canvas.height / canvasBox.height;
    const x = Math.max(0, Math.floor((box.left - canvasBox.left) * scaleX));
    const y = Math.max(0, Math.floor((box.top - canvasBox.top) * scaleY));
    const right = Math.min(canvas.width, Math.ceil((box.right - canvasBox.left) * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil((box.bottom - canvasBox.top) * scaleY));
    if (right <= x || bottom <= y) return { contained: false, darkPixels: 0 };
    const pixels = canvas.getContext('2d').getImageData(x, y, right - x, bottom - y).data;
    let darkPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180) darkPixels++;
    return { contained: box.left >= canvasBox.left && box.top >= canvasBox.top &&
      box.right <= canvasBox.right && box.bottom <= canvasBox.bottom, darkPixels };
  });
  expect(result.contained).toBe(true);
  expect(result.darkPixels).toBeGreaterThan(5);
});

test('digitally signs a PDF with a temporary self-signed identity', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-e2e-sign-'));
  try {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), p12 = join(dir, 'identity.p12');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-subj', '/CN=Paperloom E2E', '-days', '1'], { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'pass:test-only'], { stdio: 'ignore' });
    await openPdf(page, await makePdf());
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('button', { name: 'Import / manage certificates' }).click();
    await page.getByLabel('P12/PFX password (optional)').fill('test-only');
    await page.locator('input[accept*=".p12"]').setInputFiles(p12);
    await expect(page.getByText('Paperloom E2E', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Close certificates' }).click();
    await page.getByRole('button', { name: 'Digitally sign document' }).click();
    await expect(page.getByRole('button', { name: /Signature1 Signed/ })).toBeVisible();
    const signed = await downloadPdf(page);
    const output = join(dir, 'signed.pdf');
    writeFileSync(output, signed);
    expect(execFileSync('pdfsig', [output], { encoding: 'utf8' })).toContain('Signature is Valid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mobile viewport opens a PDF without horizontal document overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await makePdf());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTitle('Download original / edited PDF (no recompression)')).toBeVisible();
  } finally { await context.close(); }
});
