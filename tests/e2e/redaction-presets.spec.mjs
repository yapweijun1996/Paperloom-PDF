import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Chrome prints text with embedded Type0 (Identity-H) fonts, one glyph per
// show operator, which the strict redaction subsets refuse.
const HTML = `<html><body style="font-family:Arial;font-size:12pt;margin:60px">
<p>Contact jane.doe@example.com for the invoice details.</p>
<p>Reception: +65 6123 4567 (weekdays only)</p>
<p>This closing line stays exactly where it is.</p>
</body></html>`;

function words(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  return [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g)]
    .map(m => ({ x: +m[1], y: +m[2], text: m[3] }));
}

let dir, source;
test.beforeAll(async ({ browser }) => {
  dir = mkdtempSync(join(tmpdir(), 'paperloom-presets-'));
  source = join(dir, 'printed.pdf');
  const page = await browser.newPage();
  await page.setContent(HTML);
  writeFileSync(source, await page.pdf({ format: 'A4' }));
  await page.close();
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('finds and securely removes an email and a phone number inside sentences', async ({ page }) => {
  const before = words(source);
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles(source);
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Clean', exact: true }).click();

  const find = page.getByLabel('Find', { exact: true });
  const marks = page.locator('[data-redaction-mark]');
  await find.selectOption('email');
  await page.getByRole('button', { name: 'Mark matches' }).click();
  await expect(page.getByText(/Marked 1 match\(es\) on 1 page\(s\)/)).toBeVisible();
  // Marks are outlined for review before anything is removed.
  await expect(marks).toHaveCount(1);
  await find.selectOption('phone');
  await page.getByRole('button', { name: 'Mark matches' }).click();
  await expect(page.getByText(/Marked 1 match\(es\) on 1 page\(s\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Apply existing redaction marks' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Apply|Redact/ }).click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
  await expect(marks).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const saved = join(dir, 'saved.pdf');
  await download.saveAs(saved);

  // Fully rewritten: the original bytes are not reused as an incremental-save prefix.
  const original = readFileSync(source), output = readFileSync(saved);
  expect(output.subarray(0, original.length).equals(original)).toBe(false);

  const after = words(saved);
  const text = after.map(word => word.text).join(' ');
  expect(text).not.toMatch(/jane|example\.com|6123|4567/);
  // Every other word is still there, at the same position.
  const secret = /jane\.doe@example\.com|^\+65$|^6123$|^4567$/;
  for (const word of before.filter(item => !secret.test(item.text))) {
    expect(after.some(other => other.text === word.text && Math.abs(other.x - word.x) < 0.5 && Math.abs(other.y - word.y) < 0.5),
      `"${word.text}" stays in place`).toBe(true);
  }
  // No copy survives in any stream either.
  const qdf = join(dir, 'qdf.pdf');
  execFileSync('qpdf', ['--qdf', '--object-streams=disable', saved, qdf]);
  expect(readFileSync(qdf, 'latin1')).not.toContain('jane.doe');
});
