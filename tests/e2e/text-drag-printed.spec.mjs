import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Browser-printed PDFs draw one glyph per Tj, split kerned words into separate
// runs, and put list markers in their own text block. Dragging a line must move
// every glyph of it and nothing else.
const HTML = `<html><body style="font-family:Arial;font-size:11pt;margin:60px">
<p>TSK-32516 SI SCN Print Forms</p>
<p>For entity D Investments Pte Ltd</p>
<ol style="margin-left:80px"><li>SI: sal_inv_view004.cfm</li><li>SCN: sal_cn_view004.cfm</li></ol>
<p style="font-family:Helvetica">Total: 170.00</p>
</body></html>`;

const PAGE_W = 595.92, PAGE_H = 842.88;

function textRows(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const rows = [];
  for (const m of xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
    const word = { x: +m[1], y: +m[2], y2: +m[3], text: m[4] };
    const row = rows.find(r => Math.abs(r.y - word.y) < 2);
    if (row) row.words.push(word); else rows.push({ y: word.y, y2: word.y2, x: word.x, words: [word] });
  }
  return rows.map(r => ({ ...r, text: r.words.sort((a, b) => a.x - b.x).map(w => w.text).join(' ') }));
}

let dir, source;
test.beforeAll(async ({ browser }) => {
  dir = mkdtempSync(join(tmpdir(), 'paperloom-drag-'));
  source = join(dir, 'printed.pdf');
  const page = await browser.newPage();
  await page.setContent(HTML);
  writeFileSync(source, await page.pdf({ format: 'A4' }));
  await page.close();
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const lineText of ['TSK-32516 SI SCN Print Forms', '1. SI: sal_inv_view004.cfm', 'Total: 170.00']) {
  test(`dragging "${lineText}" moves the whole line and leaves the rest`, async ({ page }) => {
    const before = textRows(source);
    const target = before.find(row => row.text === lineText);
    expect(target, `fixture row "${lineText}"`).toBeTruthy();

    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
    await page.locator('input[type=file]').setInputFiles(source);
    const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
    await expect(surface).toBeVisible();
    const box = await surface.boundingBox();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
    await page.mouse.click(box.x + box.width * (target.x + 3) / PAGE_W, box.y + box.height * ((target.y + target.y2) / 2) / PAGE_H);
    await expect(page.getByLabel('Edit line')).toHaveValue(lineText);

    // Drag into the empty lower half of the page and commit.
    const handle = await page.getByTitle('Drag to move text').last().boundingBox();
    const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 40, hy + 250, { steps: 5 });
    await page.mouse.move(hx + 80, hy + 500, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Unsaved')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').click(),
    ]);
    const saved = join(dir, `saved-${lineText.length}.pdf`);
    await download.saveAs(saved);
    const after = textRows(saved);

    const moved = after.filter(row => row.text === lineText);
    expect(moved, 'the line appears once, whole').toHaveLength(1);
    expect(moved[0].y - target.y).toBeGreaterThan(100);
    for (const row of before) {
      if (row === target) continue;
      expect(after.some(a => Math.abs(a.y - row.y) < 2 && a.text === row.text), `"${row.text}" stays`).toBe(true);
    }
    expect(after).toHaveLength(before.length);
  });
}
