import { test, expect } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="32" height="64" fill="red"/></svg>');
const svgFile = { name: 'transparent.svg', mimeType: 'image/svg+xml', buffer: svg };

function opaquePng() {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 64, 64);
  return canvas.toBuffer('image/png');
}

async function fixture(embedded) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0, 0, 1) });
  if (embedded) {
    const image = await pdf.embedPng(opaquePng());
    page.drawImage(image, { x: 168, y: 168, width: 64, height: 64 });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-page-render-surface="true"]')).toBeVisible();
}

async function uploadVia(page, button, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(file);
}

async function download(page) {
  const [result] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  return readFileSync(await result.path());
}

async function canvasPixels(page) {
  return page.locator('[data-page-render-surface="true"]').evaluate(element => {
    const canvas = element.querySelector('canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const sample = x => [...ctx.getImageData(Math.floor(canvas.width * x / 400), Math.floor(canvas.height / 2), 1, 1).data];
    return [sample(176), sample(220)];
  });
}

function popplerPixels(pdf) {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-svg-alpha-'));
  try {
    const input = join(dir, 'input.pdf'), output = join(dir, 'page');
    writeFileSync(input, pdf);
    execFileSync('pdftoppm', ['-r', '72', '-singlefile', input, output]);
    const ppm = readFileSync(`${output}.ppm`);
    const header = /^P6\s+400\s+400\s+255\s/.exec(ppm.toString('latin1'));
    if (!header) throw new Error('Unexpected Poppler image dimensions');
    return [176, 220].map(x => [...ppm.subarray(header[0].length + (200 * 400 + x) * 3, header[0].length + (200 * 400 + x) * 3 + 3)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function expectPixels(page, bytes) {
  const [red, blue] = popplerPixels(bytes);
  expect(red[0]).toBeGreaterThan(240);
  expect(red[2]).toBeLessThan(15);
  expect(blue[0]).toBeLessThan(15);
  expect(blue[2]).toBeGreaterThan(240);

  await openPdf(page, bytes);
  await expect.poll(() => canvasPixels(page)).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
}

for (const mode of ['insert', 'replace floating', 'replace embedded']) {
  test(`preserves SVG transparency after ${mode} and reopening`, async ({ page, browser }) => {
    await openPdf(page, await fixture(mode === 'replace embedded'));
    if (mode === 'replace embedded') {
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      const surface = page.locator('[data-page-render-surface="true"]');
      const box = await surface.boundingBox();
      await surface.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await uploadVia(page, page.getByRole('button', { name: 'Replace Image', exact: true }), svgFile);
      await expect.poll(() => canvasPixels(page)).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
    } else {
      await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
      await uploadVia(page, page.getByRole('button', { name: 'Add Image', exact: true }), mode === 'insert'
        ? svgFile : { name: 'opaque.png', mimeType: 'image/png', buffer: opaquePng() });
      await expect(page.getByAltText('floating')).toBeVisible();
      if (mode === 'replace floating') {
        const oldSource = await page.getByAltText('floating').getAttribute('src');
        expect(oldSource).toBe(`data:image/png;base64,${opaquePng().toString('base64')}`);
        await uploadVia(page, page.getByTitle('Replace Image'), svgFile);
        await expect.poll(() => page.getByAltText('floating').getAttribute('src')).not.toBe(oldSource);
        await expect(page.getByAltText('floating')).toHaveAttribute('src', /^data:image\/png/);
      }
    }
    const bytes = await download(page);
    const context = await browser.newContext();
    try { await expectPixels(await context.newPage(), bytes); }
    finally { await context.close(); }
  });
}

test('keeps JPEG uploads on the JPEG path through save and reopening', async ({ page, browser }) => {
  const canvas = createCanvas(64, 64);
  canvas.getContext('2d').fillRect(0, 0, 64, 64);
  await openPdf(page, await fixture(false));
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await uploadVia(page, page.getByRole('button', { name: 'Add Image', exact: true }), {
    name: 'opaque.jpg', mimeType: 'image/jpeg', buffer: canvas.toBuffer('image/jpeg'),
  });
  await expect(page.getByAltText('floating')).toHaveAttribute('src', /^data:image\/jpeg/);
  const bytes = await download(page);
  for (const pixel of popplerPixels(bytes)) expect(Math.max(...pixel)).toBeLessThan(15);
  const context = await browser.newContext();
  try {
    const reopened = await context.newPage();
    await openPdf(reopened, bytes);
    await expect.poll(() => canvasPixels(reopened)).toEqual([[0, 0, 0, 255], [0, 0, 0, 255]]);
  } finally { await context.close(); }
});
