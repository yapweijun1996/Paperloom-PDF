import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('PAGE MARKER', { x: 30, y: 355, size: 16, font });
  const form = pdf.getForm();
  const text = form.createTextField('Text');
  text.setText('TEXT CONTROL');
  text.addToPage(page, { x: 50, y: 280, width: 200, height: 30, font, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  const checkbox = form.createCheckBox('Checked');
  checkbox.addToPage(page, { x: 50, y: 205, width: 35, height: 35, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  checkbox.check();
  const dropdown = form.createDropdown('Choice');
  dropdown.addOptions(['ALPHA OPTION', 'BRAVO OPTION']);
  dropdown.select('BRAVO OPTION');
  dropdown.addToPage(page, { x: 50, y: 115, width: 200, height: 35, font, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

const regions = { marker: [30, 30, 200, 25], text: [50, 90, 200, 30], checkbox: [50, 160, 35, 35], choice: [50, 250, 200, 35] };
async function darkPixels(bytes, [x, y, width, height]) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(Math.floor(x * image.width / 400), Math.floor(y * image.height / 400),
    Math.floor(width * image.width / 400), Math.floor(height * image.height / 400)).data;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) count++;
  return count;
}
async function canvasBytes(page) {
  const data = await page.locator('[data-page-render-surface] canvas.pdf-canvas').evaluate(canvas => canvas.toDataURL('image/png'));
  return Buffer.from(data.split(',')[1], 'base64');
}
async function verifyRegions(bytes, context) {
  for (const [name, region] of Object.entries(regions)) {
    expect.soft(await darkPixels(bytes, region), `${context}: ${name}`).toBeGreaterThan(name === 'checkbox' ? 20 : 100);
  }
}

test('checkbox and choice appearances render on the page and in image exports', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const bytes = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-widget-oracle-'));
  try {
    writeFileSync(join(dir, 'fixture.pdf'), bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'fixture.pdf'), join(dir, 'reference')]);
    await verifyRegions(readFileSync(join(dir, 'reference.png')), 'Poppler');
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: bytes });
    await expect(page).toHaveURL(/\/editor\/?$/);
    await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
    await expect.poll(async () => darkPixels(await canvasBytes(page), regions.text)).toBeGreaterThan(100);
    await verifyRegions(await canvasBytes(page), 'canvas');
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'form-widget-canvas.png') });
    await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    for (const label of ['PNG Image', 'JPEG Image', 'SVG Image']) {
      await dialog.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: `Export as ${label}` }).click()]);
      let image = readFileSync(await download.path());
      if (label === 'SVG Image') {
        const match = image.toString().match(/data:image\/png;base64,([^"\s]+)/);
        expect(match).toBeTruthy();
        image = Buffer.from(match[1], 'base64');
      }
      await verifyRegions(image, label);
    }
    expect(errors).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkbox and dropdown edits update the canvas, undo and survive saving', async ({ page, browser }) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await expect.poll(async () => darkPixels(await canvasBytes(page), regions.checkbox)).toBeGreaterThan(20);
  await surface.click({ position: { x: 65, y: 180 } });
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'form-widget-selected.png') });
  const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
  await panel.getByRole('button', { name: 'Checked — click to uncheck' }).click();
  await expect.poll(async () => darkPixels(await canvasBytes(page), regions.checkbox)).toBe(0);
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect.poll(async () => darkPixels(await canvasBytes(page), regions.checkbox)).toBeGreaterThan(20);
  await surface.click({ position: { x: 65, y: 180 } });
  await panel.getByRole('button', { name: 'Checked — click to uncheck' }).click();
  await expect.poll(async () => darkPixels(await canvasBytes(page), regions.checkbox)).toBe(0);
  await surface.click({ position: { x: 100, y: 265 } });
  const choice = panel.getByLabel('Choice value');
  await expect(choice).toHaveValue('BRAVO OPTION');
  const before = (await canvasBytes(page)).toString('base64');
  await choice.selectOption('ALPHA OPTION');
  await expect.poll(async () => (await canvasBytes(page)).toString('base64')).not.toBe(before);
  const changed = (await canvasBytes(page)).toString('base64');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const bytes = readFileSync(await download.path());
  const form = (await PDFDocument.load(bytes)).getForm();
  expect(form.getCheckBox('Checked').isChecked()).toBe(false);
  expect(form.getDropdown('Choice').getSelected()).toEqual(['ALPHA OPTION']);
  const context = await browser.newContext();
  try {
    const reopened = await context.newPage();
    await reopened.goto('./');
    await reopened.locator('input[type=file]').setInputFiles({ name: 'saved.pdf', mimeType: 'application/pdf', buffer: bytes });
    await expect(reopened.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
    await expect.poll(async () => (await canvasBytes(reopened)).toString('base64')).toBe(changed);
    expect(await darkPixels(await canvasBytes(reopened), regions.choice)).toBeGreaterThan(100);
    expect(await darkPixels(await canvasBytes(reopened), regions.checkbox)).toBe(0);
    await reopened.locator('[data-page-render-surface]').click({ position: { x: 100, y: 265 } });
    await expect(reopened.getByLabel('Choice value')).toHaveValue('ALPHA OPTION');
  } finally { await context.close(); }
});

test('radio, push button and option list render their existing appearances', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText('PAGE MARKER', { x: 30, y: 355, size: 16, font });
  const form = pdf.getForm();
  const radio = form.createRadioGroup('Radio');
  radio.addOptionToPage('One', pdfPage, { x: 50, y: 280, width: 30, height: 30, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  radio.addOptionToPage('Two', pdfPage, { x: 100, y: 280, width: 30, height: 30, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  radio.select('One');
  const button = form.createButton('Button');
  button.addToPage('PRESS BUTTON', pdfPage, { x: 50, y: 210, width: 200, height: 35, font, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  const list = form.createOptionList('List');
  list.addOptions(['OPTION ONE', 'OPTION TWO']); list.select('OPTION TWO');
  list.addToPage(pdfPage, { x: 50, y: 90, width: 200, height: 80, font, borderWidth: 0, backgroundColor: rgb(1, 1, 1) });
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-widget-variants-'));
  try {
    writeFileSync(join(dir, 'fixture.pdf'), bytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', join(dir, 'fixture.pdf'), join(dir, 'reference')]);
    const expected = readFileSync(join(dir, 'reference.png'));
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'variants.pdf', mimeType: 'application/pdf', buffer: bytes });
    await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
    await expect.poll(async () => darkPixels(await canvasBytes(page), regions.marker)).toBeGreaterThan(100);
    const actual = await canvasBytes(page);
    const unselectedRadio = [100, 90, 30, 30];
    expect(await darkPixels(expected, unselectedRadio)).toBe(0);
    expect(await darkPixels(actual, unselectedRadio)).toBe(0);
    for (const [name, region] of Object.entries({ selectedRadio: [50, 90, 30, 30], button: [50, 155, 200, 35], list: [50, 230, 200, 80] })) {
      expect.soft(await darkPixels(expected, region), `Poppler ${name}`).toBeGreaterThan(20);
      expect.soft(await darkPixels(actual, region), `canvas ${name}`).toBeGreaterThan(20);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
