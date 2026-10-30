import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';

async function openPdf(page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]);
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({
    name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })),
  });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function preparePanel(page, tool) {
  await page.getByRole('button', { name: tool, exact: true }).tap();
  if (tool === 'Sign') {
    await page.getByRole('button', { name: 'Create signature' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Create signature' });
    await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
    await dialog.getByPlaceholder('Type your name').fill('Alex Example');
    await dialog.getByRole('button', { name: 'Save to library' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('This session only', { exact: true })).toBeVisible();
  }
}

async function scrollPanel(panel, fraction) {
  // Measure after the sheet's entry animation, when it can receive a tap.
  await panel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  return panel.evaluate((element, value) => {
    const nodes = [element, ...element.querySelectorAll('*')].filter(node => {
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    });
    for (const node of [...nodes].reverse()) node.scrollTop = (node.scrollHeight - node.clientHeight) * value;
    return nodes.map(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
  }, fraction);
}

async function checkClose(panel) {
  const state = await panel.evaluate(element => {
    const button = element.querySelector('[title="Hide panel"]');
    if (!button) throw new Error('Close control is missing');
    const outer = element.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const node = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { panelTop: outer.top, panelBottom: outer.bottom, buttonTop: box.top,
      buttonBottom: box.bottom, hit: !!node?.closest('[title="Hide panel"]') };
  });
  expect(state.buttonTop).toBeGreaterThanOrEqual(state.panelTop - 1);
  expect(state.buttonBottom).toBeLessThanOrEqual(state.panelBottom + 1);
  expect(state.hit).toBe(true);
}

for (const [width, height] of [[390, 844], [320, 568], [568, 320]]) {
  for (const tool of ['Sign', 'Watermark']) {
    test(`${tool} mobile options retain their close control at ${width}x${height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await openPdf(page);
        await preparePanel(page, tool);
        const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
        await expect(panel).toBeVisible();
        let maxScroll = 0;
        for (const fraction of [0, 0.5, 1]) {
          const positions = await scrollPanel(panel, fraction);
          maxScroll = Math.max(maxScroll, ...positions.map(position => position.max));
          if (fraction === 1) expect(positions.some(position => position.top > 0)).toBe(true);
          await checkClose(panel);
          if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `${tool}-${width}-${height}-${fraction}.png`) });
        }
        expect(maxScroll).toBeGreaterThan(0);
        const button = await panel.getByTitle('Hide panel').boundingBox();
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeGreaterThanOrEqual(44);
        if (tool === 'Watermark') {
          const scan = panel.getByRole('button', { name: 'Scan for Watermarks' });
          await expect(scan).toBeInViewport();
          await scan.tap();
          await expect(panel.getByText('no watermark found in scan process')).toBeVisible();
          const input = panel.locator('input[type=text]').first();
          await input.focus();
          await expect(input).toBeFocused();
          const activeInput = await panel.evaluate(element => {
            const field = element.querySelector('input[type=text]').getBoundingClientRect();
            const header = element.querySelector('[title=\"Hide panel\"]').parentElement.getBoundingClientRect();
            return { top: field.top, headerBottom: header.bottom, hit: document.elementFromPoint(field.x + field.width / 2, field.y + field.height / 2)?.tagName };
          });
          expect(activeInput.top).toBeGreaterThanOrEqual(activeInput.headerBottom - 1);
          expect(activeInput.hit).toBe('INPUT');
          await input.fill('Example watermark');
          await checkClose(panel);
        }
        await panel.getByTitle('Hide panel').tap();
        await expect(panel).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }
}

test('mobile close control remains opaque in dark mode and works with the keyboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page);
    await page.getByTitle('Switch to dark mode').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await preparePanel(page, 'Watermark');
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    await scrollPanel(panel, 1);
    await checkClose(panel);
    const close = panel.getByTitle('Hide panel');
    const background = await close.evaluate(element => getComputedStyle(element.parentElement).backgroundColor);
    expect(background).toBe('rgb(10, 11, 14)');
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'Watermark-390-dark.png') });
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
  } finally { await context.close(); }
});

test('desktop options retain their existing close control and keyboard behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPdf(page);
  await page.getByRole('button', { name: 'Watermark', exact: true }).click();
  const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
  const close = panel.getByTitle('Hide panel');
  await expect(close).toBeVisible();
  expect(await close.evaluate(element => getComputedStyle(element.parentElement).position)).toBe('static');
  const rect = await close.boundingBox();
  expect(rect.width).toBeLessThan(44);
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'Watermark-desktop.png') });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
});
