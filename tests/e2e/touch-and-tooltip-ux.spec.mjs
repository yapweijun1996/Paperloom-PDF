import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const shotDir = process.env.PAPERLOOM_UX_CAPTURE_DIR;
if (shotDir) mkdirSync(shotDir, { recursive: true });
const shot = (page, name) => shotDir ? page.screenshot({ path: join(shotDir, name) }) : undefined;

async function openPdf(page, pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([400, 500]);
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })),
  });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

/** The tooltip is pointer-events-none, so check it has no clipping ancestor and fits the viewport. */
async function expectUnclipped(locator) {
  const hit = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    let clipped = false;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/auto|hidden|scroll|clip/.test(getComputedStyle(node).overflow)) clipped = true;
    }
    return { clipped, width: box.width, left: box.left, right: box.right, vw: innerWidth };
  });
  expect(hit.clipped).toBe(false);
  expect(hit.width).toBeGreaterThan(20);
  expect(hit.left).toBeGreaterThanOrEqual(0);
  expect(hit.right).toBeLessThanOrEqual(hit.vw);
}

test('desktop tool rail tooltips show the tool and shortcut on hover and keyboard focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openPdf(page);
    const rail = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Draw', exact: true }) });
    await page.getByRole('button', { name: 'Draw', exact: true }).hover();
    const tooltip = page.getByRole('tooltip').filter({ hasText: 'Draw' });
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('D');
    // Rendered outside the scrolling rail and to its right.
    const railBox = await rail.boundingBox();
    const tipBox = await page.locator('[data-radix-popper-content-wrapper]').filter({ hasText: 'Draw' }).boundingBox();
    expect(tipBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
    await expect(rail.getByRole('tooltip')).toHaveCount(0);
    await expectUnclipped(page.locator('[data-radix-popper-content-wrapper]').filter({ hasText: 'Draw' }));
    await shot(page, 'desktop-1440-tool-tooltip-hover.png');

    await page.mouse.move(900, 450, { steps: 5 });
    await expect(tooltip).toHaveCount(0);
    await page.getByRole('button', { name: 'Highlight', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const focused = page.getByRole('tooltip').filter({ hasText: 'Highlight' });
    await expect(focused).toBeVisible();
    await expect(focused).toContainText('H');
    await shot(page, 'desktop-1440-tool-tooltip-focus.png');

    // Desktop keeps the anchored download dropdown inside the toolbar.
    await page.getByRole('button', { name: 'Download options' }).click();
    const menu = page.getByRole('dialog', { name: 'Download options' });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(element => !!element.closest('header'))).toBe(true);
    await shot(page, 'desktop-1440-download-dropdown.png');
  } finally {
    await context.close();
  }
});

test('mobile touch layout: prompt, toolbar targets, tool strip, download sheet and thumbnails', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('./');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.getByText('Tap to choose a PDF', { exact: true })).toBeVisible();
    await expect(page.getByText('Drop a PDF here or click to browse', { exact: true })).toBeHidden();
    await openPdf(page);

    // Toolbar: every visible header button has at least a 44px hit area.
    const sizes = await page.locator('header button').evaluateAll(buttons => buttons
      .filter(button => button.getClientRects().length > 0)
      .map(button => { const box = button.getBoundingClientRect(); return { name: button.title || button.getAttribute('aria-label'), w: box.width, h: box.height }; }));
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    for (const size of sizes) {
      expect(size.w, size.name).toBeGreaterThanOrEqual(44);
      expect(size.h, size.name).toBeGreaterThanOrEqual(44);
    }
    const header = await page.locator('header').boundingBox();
    expect(header.width).toBeLessThanOrEqual(390);

    // Tool strip: overflow is signalled, and Security is reachable.
    const strip = page.locator('[data-tool-strip]');
    await expect(page.locator('[data-strip-fade="end"]')).toBeVisible();
    await shot(page, 'mobile-390-toolbar.png');
    const security = strip.getByRole('button', { name: 'Security', exact: true });
    await security.scrollIntoViewIfNeeded();
    await expect(page.locator('[data-strip-fade="start"]')).toBeVisible();
    await security.tap();
    await expect(security).toHaveAttribute('aria-pressed', 'true');
    const securityBox = await security.boundingBox();
    expect(securityBox.height).toBeGreaterThanOrEqual(44);
    expect(securityBox.x + securityBox.width).toBeLessThanOrEqual(390);
    await shot(page, 'mobile-390-toolstrip-security.png');
    for (const name of ['Hide panel', 'Hide sidebar panel']) {
      const hide = page.getByRole('button', { name, exact: true });
      if (await hide.isVisible()) await hide.tap();
    }

    // Download options: an on-screen, scrollable bottom sheet.
    await page.getByRole('button', { name: 'Download options' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Download options' });
    await expect(sheet).toBeVisible();
    await sheet.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
    const rect = await sheet.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, vh: innerHeight, parent: element.parentElement === document.body,
        scrolls: getComputedStyle(element).overflowY };
    });
    expect(rect.parent).toBe(true);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(rect.vh + 1);
    expect(rect.scrolls).toBe('auto');
    await sheet.getByRole('button', { name: /Medium/ }).tap();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Medium/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByText('Clean up unused data')).toBeVisible();
    await shot(page, 'mobile-390-download-sheet.png');
    await page.mouse.click(195, 40);
    await expect(sheet).toHaveCount(0);

    // Thumbnails: page actions are visible without hover and are 44px targets.
    await page.getByTitle('Show page thumbnails').tap();
    const deletes = page.getByRole('button', { name: 'Delete page', exact: true });
    await expect(deletes).toHaveCount(2);
    for (const button of [deletes.nth(1), page.getByRole('button', { name: 'Rotate page 2', exact: true })]) {
      await button.scrollIntoViewIfNeeded();
      expect(Number(await button.evaluate(element => getComputedStyle(element).opacity))).toBe(1);
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: 'Rotate page 2 90° clockwise' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Rotate page 1', exact: true }).scrollIntoViewIfNeeded();
    await shot(page, 'mobile-390-thumbnails.png');
    await deletes.nth(1).tap();
    const confirmDelete = page.getByRole('dialog', { name: 'Delete page' });
    await expect(confirmDelete).toContainText('Delete page 2? You can undo this.');
    await confirmDelete.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(confirmDelete).toHaveCount(0);
    await expect(deletes).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const viewport of [{ width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
  test(`touch header with 44px targets does not cover the editor at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: true });
    try {
      const page = await context.newPage();
      await openPdf(page);
      const header = await page.locator('header').boundingBox();
      const overflow = await page.locator('header').evaluate(element => element.scrollHeight - element.clientHeight);
      expect(overflow).toBeLessThanOrEqual(1);
      const select = page.getByRole('button', { name: 'Select', exact: true });
      const selectBox = await select.boundingBox();
      expect(selectBox.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
      await select.click();
      await expect(select).toHaveAttribute('aria-pressed', 'true');
      await shot(page, `touch-${viewport.width}-header.png`);
    } finally {
      await context.close();
    }
  });
}
