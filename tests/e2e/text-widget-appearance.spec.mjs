import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture({ shared = false, rotated = false } = {}) {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText('PAGE MARKER', { x: 50, y: 340, size: 18, font });
  const field = pdf.getForm().createTextField('Name');
  field.setText('Original Value');
  field.addToPage(pdfPage, { x: 50, y: 250, width: 200, height: 36, font,
    borderWidth: 0, backgroundColor: rgb(1, 1, 1), textColor: rgb(0, 0, 0) });
  if (rotated) {
    pdfPage.drawText('CONTROL', { x: 70, y: 120, size: 18, font });
    pdfPage.setCropBox(50, 75, 300, 250);
    pdfPage.setRotation(degrees(90));
  }
  if (shared) {
    const second = pdf.addPage([400, 400]);
    second.drawText('PAGE MARKER', { x: 50, y: 340, size: 18, font });
    field.addToPage(second, { x: 50, y: 250, width: 200, height: 36, font,
      borderWidth: 0, backgroundColor: rgb(1, 1, 1), textColor: rgb(0, 0, 0) });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

test('committing, undoing and reopening refreshes both shared field appearances', async ({ page, browser }) => {
  await openFixture(page, await fixture({ shared: true }));
  const initial = (await canvasBytes(page)).toString('base64');
  await page.locator('[data-page-render-surface]').click({ position: { x: 120, y: 132 } });
  const input = page.getByLabel('Value', { exact: true });
  await expect(input).toHaveValue('Original Value');
  await input.fill('Changed Value');
  expect((await canvasBytes(page)).toString('base64')).toBe(initial);
  await input.press('Enter');
  await expect.poll(async () => (await canvasBytes(page)).toString('base64')).not.toBe(initial);
  const changed = (await canvasBytes(page)).toString('base64');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(async () => (await canvasBytes(page)).toString('base64')).toBe(changed);
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const saved = readFileSync(await download.path());
  expect((await PDFDocument.load(saved)).getForm().getTextField('Name').getText()).toBe('Changed Value');
  const context = await browser.newContext();
  try {
    const reopened = await context.newPage();
    await openFixture(reopened, saved);
    await expect.poll(async () => (await canvasBytes(reopened)).toString('base64')).toBe(changed);
  } finally { await context.close(); }
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect.poll(async () => (await canvasBytes(page)).toString('base64')).toBe(initial);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(async () => (await canvasBytes(page)).toString('base64')).toBe(initial);
});

async function darkPixels(bytes, [x, y, width, height]) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(Math.floor(x * image.width / 400), Math.floor(y * image.height / 400),
    Math.floor(width * image.width / 400), Math.floor(height * image.height / 400)).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) dark++;
  }
  return dark;
}

const markerRegion = [48, 39, 210, 25];
const fieldRegion = [58, 117, 185, 29];

async function openFixture(page, bytes) {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function canvasBytes(page) {
  const data = await page.locator('[data-page-render-surface] canvas.pdf-canvas').evaluate(canvas => canvas.toDataURL('image/png'));
  return Buffer.from(data.split(',')[1], 'base64');
}

test('main canvas renders the existing text widget appearance', async ({ page }) => {
  const bytes = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-oracle-'));
  try {
    const path = join(dir, 'fixture.pdf');
    writeFileSync(path, bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', path, join(dir, 'page')]);
    const oracle = readFileSync(join(dir, 'page.png'));
    expect(await darkPixels(oracle, markerRegion)).toBeGreaterThan(100);
    expect(await darkPixels(oracle, fieldRegion)).toBeGreaterThan(100);
    await openFixture(page, bytes);
    await expect.poll(async () => darkPixels(await canvasBytes(page), markerRegion)).toBeGreaterThan(100);
    expect(await darkPixels(await canvasBytes(page), fieldRegion)).toBeGreaterThan(100);
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').click()]);
    const output = readFileSync(await download.path());
    expect((await PDFDocument.load(output)).getForm().getTextField('Name').getText()).toBe('Original Value');
    writeFileSync(join(dir, 'saved.pdf'), output);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'saved.pdf'), join(dir, 'saved')]);
    expect(await darkPixels(readFileSync(join(dir, 'saved.png')), fieldRegion)).toBeGreaterThan(100);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const label of ['PNG Image', 'JPEG Image', 'SVG Image']) {
  test(`${label} export includes the existing text widget appearance`, async ({ page }) => {
    await openFixture(page, await fixture());
    await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    await dialog.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: `Export as ${label}` }).click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error('No exported image');
    let image = readFileSync(path);
    if (label === 'SVG Image') {
      const match = image.toString().match(/data:image\/png;base64,([^"\s]+)/);
      if (!match) throw new Error('SVG does not contain its raster page');
      image = Buffer.from(match[1], 'base64');
    }
    expect(await darkPixels(image, markerRegion)).toBeGreaterThan(100);
    expect(await darkPixels(image, fieldRegion)).toBeGreaterThan(100);
  });
}

test('cropped rotated exports retain the rendered page dimensions and field', async ({ page }) => {
  const bytes = await fixture({ rotated: true });
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-rotated-'));
  try {
    const input = join(dir, 'form.pdf'); writeFileSync(input, bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-cropbox', '-r', '72', '-png', input, join(dir, 'page')]);
    const reference = await loadImage(readFileSync(join(dir, 'page.png')));
    expect([reference.width, reference.height]).toEqual([250, 300]);
    await openFixture(page, bytes);
    await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    for (const label of ['PNG Image', 'JPEG Image', 'SVG Image']) {
      await dialog.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      const [download] = await Promise.all([page.waitForEvent('download'),
        dialog.getByRole('button', { name: `Export as ${label}` }).click()]);
      let image = readFileSync(await download.path());
      if (label === 'SVG Image') {
        const svg = image.toString();
        expect(svg).toContain('viewBox="0 0 250 300"');
        const match = svg.match(/data:image\/png;base64,([^"\s]+)/);
        if (!match) throw new Error('SVG does not contain its raster page');
        image = Buffer.from(match[1], 'base64');
      }
      const rendered = await loadImage(image);
      expect(rendered.width / rendered.height).toBeCloseTo(reference.width / reference.height, 2);
      const canvas = createCanvas(rendered.width, rendered.height);
      const ctx = canvas.getContext('2d'); ctx.drawImage(rendered, 0, 0);
      const pixels = ctx.getImageData(Math.floor(175 * rendered.width / 250), 0,
        Math.floor(36 * rendered.width / 250), Math.floor(200 * rendered.height / 300)).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) dark++;
      expect(dark).toBeGreaterThan(100);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
