import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

// Browser-printed layout: a scaling cm and a green card with a curve, painted
// three times on top of itself as Chrome's PDF printer does.
async function drawingFixture() {
  const card = '40 40 m 160 40 l 160 160 l 100 200 40 160 40 160 c h f';
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]);
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream([
    'q 0.5 0 0 0.5 0 0 cm',
    `0.2 0.5 0.3 rg ${card} ${card} ${card}`,
    '0.9 0.1 0.1 rg 300 300 40 40 re f',
    'Q',
  ].join('\n'))));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function twoPages() {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([300, 400]).setRotation({ type: 'degrees', angle: 90 });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

const pixelAt = (surface, fx, fy) => surface.evaluate((canvas, [x, y]) =>
  Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width * x), Math.round(canvas.height * y), 1, 1).data), [fx, fy]);

async function open(page, name, buffer) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer });
  const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
  await expect(surface).toBeVisible();
  return surface;
}

test('moves and resizes a drawing by dragging, and undoes it', async ({ page }) => {
  const surface = await open(page, 'printed.pdf', await drawingFixture());
  const box = await surface.boundingBox();
  const at = (px, py) => [box.x + box.width * px / 200, box.y + box.height * (1 - py / 200)];
  const greenAt = async (px, py) => {
    const [r, g] = await pixelAt(surface, px / 200, 1 - py / 200);
    return g - r > 40;
  };

  // The card covers page space 20..80; 110,50 is empty.
  expect(await greenAt(50, 50)).toBe(true);
  expect(await greenAt(110, 50)).toBe(false);

  await page.mouse.click(...at(50, 50));
  await expect(page.getByRole('button', { name: 'Deselect drawing' })).toBeVisible();

  // Drag the frame 60pt right.
  await page.mouse.move(...at(50, 50));
  await page.mouse.down();
  await page.mouse.move(...at(80, 50), { steps: 4 });
  await page.mouse.move(...at(110, 50), { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText(/Move drawing failed/)).toHaveCount(0);
  await expect.poll(() => greenAt(110, 50)).toBe(true);
  expect(await greenAt(30, 50)).toBe(false);
  // The red square drawn after the card keeps its place and colour.
  const red = await pixelAt(surface, 160 / 200, 1 - 160 / 200);
  expect(red[0]).toBeGreaterThan(red[1] + 80);

  // Shrink it from the top-right handle; the bottom-left corner stays put.
  const frame = page.getByRole('button', { name: 'Deselect drawing' }).locator('xpath=../..');
  const handle = frame.locator('[class*="cursor-nesw-resize"]').first();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(...at(115, 55), { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/Move drawing failed/)).toHaveCount(0);
  await expect.poll(() => greenAt(132, 70)).toBe(false);
  expect(await greenAt(85, 25)).toBe(true);

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => greenAt(50, 50)).toBe(true);
  await expect.poll(() => greenAt(110, 50)).toBe(false);
});

test('adds page numbers to every page, upright on a rotated page', async ({ page }) => {
  await open(page, 'two.pdf', await twoPages());
  await page.getByRole('button', { name: /Watermark/ }).first().click();
  const panel = page.getByRole('region', { name: 'Header and footer' });
  await expect(panel.getByLabel('Footer centre')).toHaveValue('Page {page} of {total}');
  await panel.getByLabel('Header right').fill('Bates {bates}');
  await panel.getByLabel('Bates prefix').fill('PL');
  await panel.getByRole('button', { name: 'Add header & footer' }).click();
  await expect(page.getByText('Unsaved')).toBeVisible();

  const dir = mkdtempSync(join(tmpdir(), 'paperloom-hf-'));
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').click(),
    ]);
    const saved = join(dir, 'saved.pdf');
    await download.saveAs(saved);
    const pages = execFileSync('pdftotext', ['-bbox', saved, '-'], { encoding: 'utf8' }).split('<page ').slice(1);
    expect(pages).toHaveLength(2);
    const words = pages.map(xml => [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map(m => ({ x: +m[1], y: +m[2], x2: +m[3], y2: +m[4], text: m[5] })));
    const size = pages.map(xml => xml.match(/width="([\d.]+)" height="([\d.]+)"/).slice(1).map(Number));
    for (const [i, list] of words.entries()) {
      // pdftotext gives the unrotated page size but word boxes in the displayed orientation.
      const [w, h] = i === 1 ? [size[i][1], size[i][0]] : size[i];
      const text = list.map(word => word.text).join(' ');
      expect(text).toContain(`Page ${i + 1} of 2`);
      expect(text).toContain(`PL00000${i + 1}`);
      // Footer centred at the bottom, Bates number top right, on both pages.
      const footer = list.find(word => word.text === 'Page');
      expect(footer.y).toBeGreaterThan(h - 50);
      expect(Math.abs((footer.x + list.findLast(word => word.text === '2').x2) / 2 - w / 2)).toBeLessThan(5);
      const bates = list.find(word => word.text.startsWith('PL'));
      expect(bates.y2).toBeLessThan(50);
      expect(w - bates.x2).toBeLessThan(40);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prints the edited PDF through a print frame', async ({ page }) => {
  await open(page, 'printed.pdf', await drawingFixture());
  await page.getByRole('button', { name: 'Print' }).click();
  const frame = page.locator('iframe[data-print-frame]');
  await expect(frame).toHaveCount(1);
  const header = await frame.evaluate(async el => {
    const bytes = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
    return String.fromCharCode(...bytes.slice(0, 5));
  });
  expect(header).toBe('%PDF-');
  await expect(page.getByText(/Print failed/)).toHaveCount(0);
});

test('copies a diagnostic report without the file name', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'secret-name.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf at all') });
  const copy = page.getByRole('button', { name: 'Copy report' });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(page.getByRole('button', { name: 'Report copied' })).toBeVisible();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain('Paperloom diagnostic report');
  expect(report).toContain('Error:');
  expect(report).not.toContain('secret-name');
});
