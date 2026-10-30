import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture({ rotated = false, rotation, marked = false, signed = false, pages = 1 } = {}) {
  const pdf = await PDFDocument.create();
  pdf.context.trailerInfo.Info = undefined;
  const font = await pdf.embedFont(StandardFonts.Courier);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([500, 500]);
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font.ref } }));
    const content = `q BT 0 g /F1 10 Tf 1 0 0 1 80 100 Tm (SECRET) Tj ET Q\n` +
      `q BT 0 g /F1 10 Tf 1 0 0 1 280 300 Tm (VISIBLE) Tj ET Q\n`;
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(content)));
    if (rotated) { page.setCropBox(20, 30, 300, 350); page.setRotation(degrees(90)); }
    if (rotation !== undefined) page.setRotation(degrees(rotation));
    if (marked && i === 0) {
      const mark = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Redact', Rect: [45, 70, 230, 130] }));
      page.node.set(PDFName.of('Annots'), pdf.context.obj([mark]));
    }
  }
  if (signed) {
    const signature = pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('AB') }));
    pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: signature }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page).toHaveURL(/\/editor\/?$/);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Clean', exact: true }).click();
}

async function download(page) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const path = await file.path();
  if (!path) throw new Error('Missing download');
  return readFileSync(path);
}

function extracted(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-ui-redact-'));
  try {
    const file = join(dir, 'file.pdf'); writeFileSync(file, bytes);
    execFileSync('qpdf', ['--check', file]);
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function dragRegion(page, start, end) {
  await page.getByRole('button', { name: 'Select redaction region' }).click();
  const surface = page.locator('[data-redaction-surface="true"]');
  const box = await surface.boundingBox();
  if (!box) throw new Error('Redaction surface unavailable');
  await page.mouse.move(box.x + start[0] * box.width, box.y + start[1] * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + end[0] * box.width, box.y + end[1] * box.height, { steps: 5 });
  await page.mouse.up();
}

test('visually selects a region and downloads only the redacted content', async ({ page }) => {
  await openPdf(page, await fixture());
  await dragRegion(page, [45 / 500, 370 / 500], [230 / 500, 430 / 500]);
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'desktop-region.png') });
  await page.getByRole('button', { name: 'Apply selected region' }).click();
  await expect(page.getByText(/Redacted 1 page\(s\).*Download a new copy/)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Redacted 1 page(s)' })).toBeInViewport();
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'desktop-success.png') });
  const text = extracted(await download(page));
  expect(text).not.toContain('SECRET'); expect(text).toContain('VISIBLE');
});

test('maps a zoomed rotated CropBox selection to the displayed text', async ({ page }) => {
  await openPdf(page, await fixture({ rotated: true }));
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('[data-page-render-surface="true"]')).toBeVisible();
  await dragRegion(page, [40 / 350, 25 / 300], [100 / 350, 210 / 300]);
  await page.getByRole('button', { name: 'Apply selected region' }).click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
  const text = extracted(await download(page));
  expect(text).not.toContain('SECRET'); expect(text).toContain('VISIBLE');
});

test('rejects unsupported partial selections and retains the original content', async ({ page }) => {
  await openPdf(page, await fixture());
  await dragRegion(page, [80 / 500, 395 / 500], [95 / 500, 405 / 500]);
  await page.getByRole('button', { name: 'Apply selected region' }).click();
  await expect(page.getByText(/unavailable|unsupported/i).last()).toBeVisible();
  expect(extracted(await download(page))).toContain('SECRET');
});

test('applies pre-existing marks and refuses mixing them with new selections', async ({ page }) => {
  await openPdf(page, await fixture({ marked: true }));
  await dragRegion(page, [45 / 500, 370 / 500], [230 / 500, 430 / 500]);
  await page.getByRole('button', { name: 'Apply selected region' }).click();
  await expect(page.getByText(/Existing redaction marks must be applied or removed/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply existing redaction marks' }).click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
  const text = extracted(await download(page));
  expect(text).not.toContain('SECRET'); expect(text).toContain('VISIBLE');
});

test('entire-page redaction clears the page and supports undo', async ({ page }) => {
  await openPdf(page, await fixture());
  await page.getByRole('button', { name: 'Redact entire current page' }).click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
  expect(extracted(await download(page))).not.toMatch(/SECRET|VISIBLE/);
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect(page.getByText(/Redacted 1 page\(s\)/)).toHaveCount(0);
  await expect.poll(async () => extracted(await download(page))).toContain('SECRET');
  await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
  const redone = await download(page);
  expect(extracted(redone)).not.toMatch(/SECRET|VISIBLE/);
  expect(redone.includes(Buffer.from('SECRET'))).toBe(false);
});

for (const rotation of [-90, 450]) {
  test(`refuses unsupported displayed rotation ${rotation} on a square page`, async ({ page }) => {
    await openPdf(page, await fixture({ rotation }));
    await dragRegion(page, [0.1, 0.1], [0.6, 0.6]);
    await expect(page.getByText(/Page geometry cannot be safely mapped for redaction/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply selected region' })).toHaveCount(0);
    expect(extracted(await download(page))).toContain('SECRET');
  });
}

test('invalidates a selection after a page or zoom change', async ({ page }) => {
  await openPdf(page, await fixture({ pages: 2 }));
  await dragRegion(page, [45 / 500, 370 / 500], [230 / 500, 430 / 500]);
  await expect(page.getByRole('button', { name: 'Apply selected region' })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('button', { name: 'Apply selected region' })).toHaveCount(0);
  await expect(page.locator('[data-redaction-surface="true"]')).toHaveCount(0);
  await dragRegion(page, [45 / 500, 370 / 500], [230 / 500, 430 / 500]);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByRole('button', { name: 'Apply selected region' })).toHaveCount(0);
  expect(extracted(await download(page)).match(/SECRET/g)).toHaveLength(2);
});

test('refuses signed documents without changing the original bytes', async ({ page }) => {
  const original = await fixture({ signed: true });
  await openPdf(page, original);
  await page.getByRole('button', { name: 'Redact entire current page' }).click();
  await expect(page.getByText(/Redaction is unavailable for signed or protected PDFs/)).toBeVisible();
  expect(await download(page)).toEqual(original);
});

test('refuses redaction while a floating text draft exists and preserves it', async ({ page }) => {
  await openPdf(page, await fixture());
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  await page.locator('[data-page-render-surface="true"]').click({ position: { x: 200, y: 200 } });
  const draft = page.locator('[data-floating-text-drag-handle]').locator('..').locator('textarea');
  await expect(draft).toBeVisible();
  await draft.fill('PRESERVED DRAFT');
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Clean', exact: true }).click();
  await page.getByRole('button', { name: 'Redact entire current page' }).click();
  await expect(page.getByText(/Finish or save pending text/)).toBeVisible();
  await expect(draft).toHaveValue('PRESERVED DRAFT');
  const text = extracted(await download(page));
  expect(text).toContain('SECRET'); expect(text).toContain('PRESERVED DRAFT');
});

test.describe('mobile redaction', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('opens, scrolls, closes and selects a region with touch', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await openPdf(page, await fixture());
    const panel = page.locator('div.fixed.bottom-0.left-0.right-0').filter({ hasText: 'Document Security' });
    await expect(panel).toBeVisible();
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'mobile-panel.png') });
    const scroll = panel.locator('.overflow-y-auto');
    for (const fraction of [0, 0.5, 1]) {
      await scroll.evaluate((el, value) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * value; }, fraction);
      await expect(panel.getByText('Document Security')).toBeVisible();
    }
    await panel.getByTitle('Hide sidebar panel').click();
    await expect(panel).toHaveCount(0);
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'mobile-closed.png') });
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await page.getByRole('button', { name: 'Clean', exact: true }).click();
    await page.getByRole('button', { name: 'Select redaction region' }).click();
    await expect(page.getByText('Drag on the page to select a region.')).toBeVisible();
    expect((await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'mobile-select.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select redaction region' })).toBeVisible();
    await page.getByRole('button', { name: 'Select redaction region' }).click();
    const surface = page.locator('[data-redaction-surface="true"]');
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error('Missing touch surface');
    const start = { x: box.x + box.width * 45 / 500, y: box.y + box.height * 370 / 500 };
    const end = { x: box.x + box.width * 230 / 500, y: box.y + box.height * 430 / 500 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByText('Check the selected area.')).toBeVisible();
    expect((await page.getByRole('button', { name: 'Apply selected region' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('[data-redaction-surface="true"] > div')).toBeVisible();
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'mobile-review.png') });
    await page.getByRole('button', { name: 'Apply selected region' }).click();
    await expect(page.getByText(/Redacted 1 page\(s\)/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Redacted 1 page(s)' })).toBeInViewport();
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'mobile-success.png') });
    await page.getByTitle('Hide sidebar panel').click();
    const text = extracted(await download(page));
    expect(text).not.toContain('SECRET'); expect(text).toContain('VISIBLE');
    expect(errors).toEqual([]);
  });

  test('keeps an unsupported touch selection visible until canceled', async ({ page }) => {
    await openPdf(page, await fixture());
    await page.getByRole('button', { name: 'Select redaction region' }).click();
    const surface = page.locator('[data-redaction-surface="true"]');
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error('Missing touch surface');
    const start = { x: box.x + box.width * 80 / 500, y: box.y + box.height * 395 / 500 };
    const end = { x: box.x + box.width * 95 / 500, y: box.y + box.height * 405 / 500 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByRole('button', { name: 'Apply selected region' }).click();
    await expect(page.locator('p[role="alert"]')).toContainText(/unavailable|unsupported/i);
    await expect(page.locator('[data-redaction-surface="true"] > div')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Document Security')).toBeVisible();
    await expect(page.locator('[data-redaction-surface="true"]')).toHaveCount(0);
  });
});
