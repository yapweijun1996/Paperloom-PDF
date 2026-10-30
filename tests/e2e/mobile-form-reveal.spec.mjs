import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture({ multiPage = false, line = false } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  if (line) page.drawText('BODY TEXT', { x: 50, y: 330, size: 20, font: await pdf.embedFont(StandardFonts.Helvetica) });
  if (multiPage) pdf.addPage([400, 400]);
  const form = pdf.getForm();
  const text = form.createTextField('Name'); text.setText('Original');
  text.addToPage(page, { x: 50, y: 250, width: 200, height: 36 });
  const checkbox = form.createCheckBox('Agreed');
  checkbox.addToPage(page, { x: 50, y: 175, width: 24, height: 24 });
  const choice = form.createDropdown('Country'); choice.addOptions(['One', 'Two']); choice.select('One');
  choice.addToPage(page, { x: 50, y: 105, width: 160, height: 30 });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function tapPagePoint(page, point) {
  const surface = page.locator('[data-page-render-surface]');
  await surface.evaluate((element, point) => {
    const scroller = element.closest('[data-canvas-stack]');
    const rect = element.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    scroller.scrollBy(rect.left + point.x - (view.left + view.width / 2), rect.top + point.y - (view.top + view.height / 2));
  }, point);
  await surface.tap({ position: point });
}

async function inVisiblePanel(panel, control) {
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate(element => {
    const panel = element.closest('[data-keep-text-edit]'), header = panel?.querySelector('[title="Hide panel"]')?.parentElement;
    if (!panel || !header) return false;
    const outer = panel.getBoundingClientRect(), box = element.getBoundingClientRect(), top = header.getBoundingClientRect();
    return box.top >= top.bottom - 1 && box.bottom <= outer.bottom + 1 && box.top >= 0 && box.bottom <= innerHeight;
  })).toBe(true);
}

async function download(page) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').tap()]);
  return readFileSync(await file.path());
}

function textContents(bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'paperloom-form-reveal-'));
  try {
    const path = join(directory, 'saved.pdf');
    writeFileSync(path, bytes);
    return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [width, height] of [[390, 844], [320, 568], [568, 320]]) {
  test(`mobile page selection reveals a form editor at ${width}x${height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await openPdf(page, await fixture());
      await tapPagePoint(page, { x: 120, y: 132 });
      const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
      await expect(panel).toBeVisible({ timeout: 4_000 });
      const input = panel.getByLabel('Value', { exact: true });
      await expect(input).toHaveValue('Original');
      await inVisiblePanel(panel, input);
      await inVisiblePanel(panel, panel.getByText('Selected: Name', { exact: true }));
      await expect(input).not.toBeFocused();
      if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `form-reveal-${width}x${height}.png`) });
      await input.tap(); await input.fill('Mobile Sample');
      if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR && width === 390) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'form-active-input.png') });
      await panel.getByTitle('Hide panel').tap();
      await expect(panel).toHaveCount(0);
      await tapPagePoint(page, { x: 120, y: 132 });
      await expect(panel).toBeVisible();
      await expect(input).toHaveValue('Mobile Sample');
      await inVisiblePanel(panel, input);
      await panel.getByTitle('Hide panel').tap();
      await expect(panel).toHaveCount(0);
      const output = await download(page);
      expect((await PDFDocument.load(output)).getForm().getTextField('Name').getText()).toBe('Mobile Sample');
      const reopenedContext = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      try {
        const reopened = await reopenedContext.newPage();
        await openPdf(reopened, output);
        await tapPagePoint(reopened, { x: 120, y: 132 });
        const rePanel = reopened.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
        await expect(rePanel.getByLabel('Value', { exact: true })).toHaveValue('Mobile Sample');
      } finally { await reopenedContext.close(); }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}


test('mobile checkbox and dropdown can be revealed, changed and saved', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture());
    await tapPagePoint(page, { x: 62, y: 213 });
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const toggle = panel.getByRole('button', { name: 'Unchecked — click to check' });
    await inVisiblePanel(panel, toggle);
    await inVisiblePanel(panel, panel.getByText('Selected: Agreed', { exact: true }));
    await toggle.tap();
    await expect(panel.getByRole('button', { name: 'Checked — click to uncheck' })).toBeVisible();
    await panel.getByTitle('Hide panel').tap();
    await tapPagePoint(page, { x: 120, y: 280 });
    const choice = panel.getByLabel('Choice value');
    await expect(choice).toHaveValue('One');
    await inVisiblePanel(panel, choice);
    await inVisiblePanel(panel, panel.getByText('Selected: Country', { exact: true }));
    await expect(choice).not.toBeFocused();
    await choice.selectOption('Two');
    await panel.getByTitle('Hide panel').tap();
    const result = (await PDFDocument.load(await download(page))).getForm();
    expect(result.getCheckBox('Agreed').isChecked()).toBe(true);
    expect(result.getDropdown('Country').getSelected()).toEqual(['Two']);
  } finally { await context.close(); }
});

test('desktop closed options and focus mode remain closed on field selection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPdf(page, await fixture());
  const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
  await expect(panel).toBeVisible();
  await panel.getByTitle('Hide panel').click();
  const surface = page.locator('[data-page-render-surface]');
  await surface.click({ position: { x: 120, y: 132 } });
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(panel.getByLabel('Value', { exact: true })).toHaveValue('Original');
  await page.getByRole('button', { name: 'Focus mode' }).click();
  await expect(panel).toHaveCount(0);
  await surface.click({ position: { x: 120, y: 132 } });
  await expect(panel).toHaveCount(0);
  await expect(page.getByTitle('Exit focus mode')).toBeVisible();
});


test('composition prevents switching fields until the prior draft is safe', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await openPdf(page, await fixture());
    await tapPagePoint(page, { x: 120, y: 132 });
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const input = panel.getByLabel('Value', { exact: true });
    await expect(input).toHaveValue('Original'); await input.focus();
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.fill('Working draft');
    await panel.getByRole('button', { name: /Agreed/ }).tap();
    await expect(input).toHaveValue('Working draft');
    await expect(panel.getByRole('button', { name: /Unchecked/ })).toHaveCount(0);
    await input.dispatchEvent('compositionend', { data: 'Working draft' });
    await panel.getByRole('button', { name: /Agreed/ }).tap();
    await expect(panel.getByRole('button', { name: 'Unchecked — click to check' })).toBeVisible();
    await panel.getByTitle('Hide panel').tap();
    expect((await PDFDocument.load(await download(page))).getForm().getTextField('Name').getText()).toBe('Working draft');
  } finally { await context.close(); }
});

test('a delayed page-field selection does not reopen on the next page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  let release;
  try {
    const page = await context.newPage(); await openPdf(page, await fixture({ multiPage: true, line: true }));
    await tapPagePoint(page, { x: 80, y: 65 });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await expect(line).toHaveValue('BODY TEXT'); await line.fill('Changed 你好');
    let mark; const started = new Promise(resolve => { mark = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/fonts/*.ttf', async route => { mark(); await gate; await route.continue(); });
    await tapPagePoint(page, { x: 120, y: 132 });
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request did not start')), 10_000))]);
    await page.getByRole('button', { name: 'Next page' }).tap();
    release();
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' })).toHaveCount(0);
    await expect(page.getByLabel('Value', { exact: true })).toHaveCount(0);
  } finally { release?.(); await context.close(); }
});


test('selecting a field commits a pending text edit and keeps both edits undoable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await openPdf(page, await fixture({ line: true }));
    await tapPagePoint(page, { x: 80, y: 65 });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await expect(line).toHaveValue('BODY TEXT'); await line.fill('UPDATED BODY');
    await tapPagePoint(page, { x: 120, y: 132 });
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const input = panel.getByLabel('Value', { exact: true });
    await expect(input).toHaveValue('Original'); await inVisiblePanel(panel, input);
    await input.tap(); await input.fill('UPDATED NAME'); await panel.getByTitle('Hide panel').tap();
    let saved = await download(page);
    expect(textContents(saved)).toContain('UPDATED BODY');
    expect((await PDFDocument.load(saved)).getForm().getTextField('Name').getText()).toBe('UPDATED NAME');
    await page.getByTitle('Undo (Ctrl+Z)').tap();
    await expect.poll(async () => (await PDFDocument.load(await download(page))).getForm().getTextField('Name').getText()).toBe('Original');
    await page.getByTitle('Undo (Ctrl+Z)').tap();
    await expect.poll(async () => textContents(await download(page))).toContain('BODY TEXT');
  } finally { await context.close(); }
});

test('the last field selected during a delayed text commit wins', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  let release;
  try {
    const page = await context.newPage(); await openPdf(page, await fixture({ line: true }));
    await tapPagePoint(page, { x: 80, y: 65 });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await expect(line).toHaveValue('BODY TEXT'); await line.fill('Changed 你好');
    let mark; const started = new Promise(resolve => { mark = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route('**/fonts/*.ttf', async route => { mark(); await gate; await route.continue(); });
    await tapPagePoint(page, { x: 120, y: 132 });
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request did not start')), 10_000))]);
    await tapPagePoint(page, { x: 62, y: 213 });
    release();
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const checkbox = panel.getByRole('button', { name: 'Unchecked — click to check' });
    await inVisiblePanel(panel, checkbox);
    await expect(panel.getByLabel('Value', { exact: true })).toHaveCount(0);
  } finally { release?.(); await context.close(); }
});


test('mobile form reveal works in dark mode without taking focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await openPdf(page, await fixture());
    await page.getByTitle('Switch to dark mode').tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await tapPagePoint(page, { x: 120, y: 132 });
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const input = panel.getByLabel('Value', { exact: true });
    await inVisiblePanel(panel, input); await expect(input).not.toBeFocused();
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'form-reveal-dark.png') });
    await panel.getByTitle('Hide panel').tap(); await expect(panel).toHaveCount(0);
  } finally { await context.close(); }
});

for (const [start, finish] of [['desktop', 'mobile'], ['mobile', 'desktop']]) {
  test(`a delayed field selection respects a ${start}-to-${finish} resize`, async ({ browser }) => {
    const sizes = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
    const context = await browser.newContext({ viewport: sizes[start], hasTouch: true, serviceWorkers: 'block' });
    let release;
    try {
      await context.addInitScript(() => localStorage.setItem('paperloom.editor.panelLayout', JSON.stringify({ panel: false })));
      const page = await context.newPage(); await openPdf(page, await fixture({ line: true }));
      const surface = page.locator('[data-page-render-surface]');
      const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
      await expect(panel).toHaveCount(0);
      if (start === 'mobile') await tapPagePoint(page, { x: 80, y: 65 });
      else await surface.click({ position: { x: 80, y: 65 } });
      const line = page.getByRole('textbox', { name: 'Edit line' });
      await expect(line).toHaveValue('BODY TEXT'); await line.fill('Changed 你好');
      let mark; const started = new Promise(resolve => { mark = resolve; }), gate = new Promise(resolve => { release = resolve; });
      await page.route('**/fonts/*.ttf', async route => { mark(); await gate; await route.continue(); });
      if (start === 'mobile') await tapPagePoint(page, { x: 120, y: 132 });
      else await surface.click({ position: { x: 120, y: 132 } });
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request did not start')), 10_000))]);
      await page.setViewportSize(sizes[finish]);
      const mobileTools = page.locator('aside.fixed.bottom-0');
      if (finish === 'mobile') await expect(mobileTools).toBeVisible();
      else await expect(mobileTools).toHaveCount(0);
      release();
      await expect(line).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
      if (finish === 'mobile') {
        await expect(panel).toBeVisible();
        const input = panel.getByLabel('Value', { exact: true });
        await expect(input).toHaveValue('Original'); await inVisiblePanel(panel, input); await expect(input).not.toBeFocused();
      } else await expect(panel).toHaveCount(0);
    } finally { release?.(); await context.close(); }
  });
}


test('a signature field offers guidance and can still be filled through Sign', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const pdf = await PDFDocument.create(), pdfPage = pdf.addPage([400, 400]);
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'),
      Rect: [100, 150, 300, 230], F: 4, P: pdfPage.ref });
    const ref = pdf.context.register(widget);
    pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
    const page = await context.newPage(); await openPdf(page, Buffer.from(await pdf.save({ useObjectStreams: false })));
    await tapPagePoint(page, { x: 200, y: 210 });
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const message = panel.getByText('Use the Sign tool to manage this signature field.', { exact: true });
    await inVisiblePanel(panel, message);
    await inVisiblePanel(panel, panel.getByText('Selected: Signature1', { exact: true }));
    await panel.getByTitle('Hide panel').tap();
    const untouched = await PDFDocument.load(await download(page));
    const beforeWidget = untouched.context.lookup(untouched.getPages()[0].node.Annots().get(0));
    expect(beforeWidget.get(PDFName.of('V'))).toBeUndefined();
    expect(beforeWidget.get(PDFName.of('AP'))).toBeUndefined();
    await page.getByRole('button', { name: 'Sign', exact: true }).tap();
    await page.getByRole('button', { name: 'Create signature' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Create signature' });
    await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
    await dialog.getByPlaceholder('Type your name').fill('Alex Example');
    await dialog.getByRole('button', { name: 'Save to library' }).tap();
    await panel.getByTitle('Hide panel').tap();
    await tapPagePoint(page, { x: 200, y: 210 });
    await expect(page.locator('[data-page-render-surface]').getByAltText('Signature')).toHaveCount(1);
    const saved = await PDFDocument.load(await download(page));
    const afterWidget = saved.context.lookup(saved.getPages()[0].node.Annots().get(0));
    expect(afterWidget.get(PDFName.of('AP'))).toBeTruthy();
    expect(afterWidget.get(PDFName.of('V'))).toBeUndefined();
  } finally { await context.close(); }
});
