import { test, expect } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function scanFixture() {
  const canvas = createCanvas(700, 160);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 700, 160);
  ctx.fillStyle = 'black'; ctx.font = 'bold 48px Arial'; ctx.fillText('PAPERLOOM SAMPLE', 20, 100);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([700, 160]);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 0, y: 0, width: 700, height: 160 });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

test('recognizes an image with a fresh offline OCR worker', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: await scanFixture() });
    await expect(page).toHaveURL(/\/editor\/?$/);
    await page.getByTitle('Toggle Find & Replace').click();
    await page.getByTitle('OCR recognize text').click();
    await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeEnabled({ timeout: 60_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error('Download path unavailable');
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-offline-ocr-'));
    try {
      const pdf = join(dir, 'output.pdf');
      writeFileSync(pdf, readFileSync(path));
      const text = execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8' });
      expect(text).toContain('PAPERLOOM');
      expect(text).toContain('SAMPLE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { await context.setOffline(false); }
});
