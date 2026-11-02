import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const STORAGE_KEY = 'pdf-editor-theme';

// Records data-theme at the moment <body> is inserted, i.e. after the inline
// <head> boot script and before first paint or hydration.
function recordThemeAtBody() {
  window.__themeAtBody = null;
  new MutationObserver((_records, observer) => {
    if (!document.body) return;
    window.__themeAtBody = document.documentElement.dataset.theme ?? null;
    observer.disconnect();
  }).observe(document, { childList: true, subtree: true });
}

async function openPdf(page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]);
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({
    name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })),
  });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

test('follows a dark system scheme on first paint when nothing is stored', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.addInitScript(recordThemeAtBody);
    await page.goto('./');
    expect(await page.evaluate(() => window.__themeAtBody)).toBe('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    const colors = await page.locator('meta[name="theme-color"]').evaluateAll(nodes =>
      nodes.map(node => [node.getAttribute('media'), node.getAttribute('content')]));
    expect(colors).toEqual([
      ['(prefers-color-scheme: light)', '#FFFFFF'],
      ['(prefers-color-scheme: dark)', '#0A0B0E'],
    ]);
  } finally { await context.close(); }
});

test('a stored light choice wins over a dark system scheme', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.addInitScript(key => localStorage.setItem(key, 'light'), STORAGE_KEY);
    await page.addInitScript(recordThemeAtBody);
    await page.goto('./');
    expect(await page.evaluate(() => window.__themeAtBody)).toBe('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await context.close(); }
});

test('tracks system changes live until the user toggles, then keeps the choice', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await openPdf(page);
    await page.getByTitle('Switch to dark mode').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally { await context.close(); }
});
