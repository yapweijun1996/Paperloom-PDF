import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function extracted(bytes) {
  const folder = mkdtempSync(join(tmpdir(), 'paperloom-recovery-audit-'));
  try { const file = join(folder, 'in.pdf'); writeFileSync(file, bytes); return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}

test('redacted recovery survives reload without restoring removed text', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.context.trailerInfo.Info = undefined;
  const font = await pdf.embedFont(StandardFonts.Courier); const pdfPage = pdf.addPage([500, 500]);
  pdfPage.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font.ref } }));
  pdfPage.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(
    'q BT 0 g /F1 10 Tf 1 0 0 1 80 100 Tm (SECRET) Tj ET Q\nq BT 0 g /F1 10 Tf 1 0 0 1 280 300 Tm (VISIBLE) Tj ET Q\n')));
  const original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  expect(extracted(original)).toContain('SECRET');
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'recovery.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page).toHaveURL(/\/editor\/?$/);
  const readSession = () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('pdf-files', 'readonly');
      const get = tx.objectStore('pdf-files').get('editor-session');
      get.onsuccess = () => resolve(get.result ? Array.from(new Uint8Array(get.result.bytes)) : null);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  expect(await readSession()).toBeNull();
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Clean', exact: true }).click();
  await page.getByRole('button', { name: 'Select redaction region' }).click();
  const box = await page.locator('[data-redaction-surface="true"]').boundingBox();
  if (!box) throw new Error('No selection surface');
  await page.mouse.move(box.x + box.width * 45 / 500, box.y + box.height * 370 / 500);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 230 / 500, box.y + box.height * 430 / 500, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Apply selected region' }).click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
  await expect.poll(readSession, { timeout: 15000 }).not.toBeNull();
  const recoveredBytes = Buffer.from(await readSession());
  expect(extracted(recoveredBytes)).not.toContain('SECRET');
  expect(extracted(recoveredBytes)).toContain('VISIBLE');
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.getByTitle('Download original / edited PDF (no recompression)')).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const result = readFileSync(await file.path());
  expect(extracted(result)).not.toContain('SECRET');
  expect(extracted(result)).toContain('VISIBLE');
});
