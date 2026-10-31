import { test, expect } from '@playwright/test';
import { PDFDocument, PDFString, StandardFonts } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makePdf(pages = 1, position = { x: 50, y: 300 }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('ORIGINAL TEXT', { ...position, size: 20, font });
  if (pages > 1) pdf.addPage([400, 400]).drawText('PAGE TWO', { x: 50, y: 300, size: 20, font });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openLine(page, touch, pages = 1, position = { x: 50, y: 300 }) {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'line.pdf', mimeType: 'application/pdf', buffer: await makePdf(pages, position) });
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  const point = { x: position.x + 30, y: 400 - position.y - 5 };
  if (touch) {
    await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.evaluate((element, point) => {
      const scroller = element.closest('[data-canvas-stack]');
      const rect = element.getBoundingClientRect();
      const visible = scroller.getBoundingClientRect();
      scroller.scrollBy(rect.left + point.x - (visible.left + visible.width / 2), rect.top + point.y - (visible.top + visible.height / 2));
    }, point);
    await surface.tap({ position: point });
  } else {
    await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
    await surface.click({ position: point });
  }
  const line = page.getByRole('textbox', { name: 'Edit line' });
  await expect(line).toHaveValue('ORIGINAL TEXT');
  return line;
}

async function downloadedText(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  const file = await download.path();
  if (!file) throw new Error('Missing download');
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-line-edit-'));
  try {
    const pdf = join(dir, 'saved.pdf');
    writeFileSync(pdf, readFileSync(file));
    return execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const [width, height] of [[320, 568], [390, 844], [568, 320]]) {
  test.describe(`mobile line editing at ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });

    test('Done commits once and remains undoable', async ({ page }) => {
      const line = await openLine(page, true);
      await line.fill('CHANGED TEXT');
      const done = page.getByRole('button', { name: 'Done editing text' });
      const cancel = page.getByRole('button', { name: 'Cancel text edit' });
      await expect(done).toBeVisible();
      await expect(cancel).toBeVisible();
      for (const button of [done, cancel]) {
        const box = await button.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      const toolbar = page.getByRole('button', { name: 'Edit Text', exact: true });
      expect((await done.boundingBox()).y + (await done.boundingBox()).height).toBeLessThanOrEqual((await toolbar.boundingBox()).y);
      const groupBox = await page.getByRole('group', { name: 'Text edit actions' }).boundingBox();
      const pagesBox = await page.getByTitle('Show page thumbnails').boundingBox();
      expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(pagesBox.x);
      const viewportBox = await page.locator('[data-canvas-stack]').boundingBox();
      expect(viewportBox.y + viewportBox.height).toBeLessThanOrEqual(groupBox.y);
      const lineBox = await line.boundingBox();
      const overlapsLine = groupBox.x < lineBox.x + lineBox.width && groupBox.x + groupBox.width > lineBox.x &&
        groupBox.y < lineBox.y + lineBox.height && groupBox.y + groupBox.height > lineBox.y;
      expect(overlapsLine).toBe(false);
      if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `editing-${width}x${height}.png`) });
      if (height === 844) {
        // Simulate the visual viewport shrinking when a soft keyboard is shown.
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: window.innerHeight - 250 });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await expect.poll(async () => (await done.boundingBox()).y + (await done.boundingBox()).height).toBeLessThanOrEqual(height - 250);
        if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'editing-simulated-keyboard.png') });
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
      }
      const box = await done.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      await expect(line).toBeFocused();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await expect(line).toBeFocused();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await expect(line).toHaveCount(0);
      await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeEnabled();
      expect(await downloadedText(page)).toContain('CHANGED TEXT');
      await page.getByTitle('Undo (Ctrl+Z)').click();
      await expect.poll(async () => downloadedText(page)).toContain('ORIGINAL TEXT');
      await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
      await expect.poll(async () => downloadedText(page)).toContain('CHANGED TEXT');
    });

    test('focusing and tapping Cancel discards the draft without committing', async ({ page }) => {
      const line = await openLine(page, true);
      await line.fill('CHANGED TEXT');
      const cancel = page.getByRole('button', { name: 'Cancel text edit' });
      await expect(cancel).toBeVisible();
      await cancel.focus();
      await page.waitForTimeout(300);
      await expect(line).toHaveValue('CHANGED TEXT');
      await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeDisabled();
      await cancel.tap();
      await expect(line).toHaveCount(0);
      const saved = await downloadedText(page);
      expect(saved).toContain('ORIGINAL TEXT');
      expect(saved).not.toContain('CHANGED TEXT');
      await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeDisabled();
    });
  });
}

for (const [width, height] of [[390, 844], [568, 320]]) {
  test.describe(`mobile action clearance at ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });
    for (const position of [{ x: 250, y: 300 }, { x: 250, y: 30 }]) {
      test(`keeps a line at ${position.x},${position.y} visible`, async ({ page }) => {
        const line = await openLine(page, true, 1, position);
        const scroller = page.locator('[data-canvas-stack]');
        await expect.poll(async () => {
          const text = await line.boundingBox();
          const view = await scroller.boundingBox();
          return text.y >= view.y && text.y + text.height <= view.y + view.height;
        }).toBe(true);
        const actions = await page.getByRole('group', { name: 'Text edit actions' }).boundingBox();
        const text = await line.boundingBox();
        const overlap = actions.x < text.x + text.width && actions.x + actions.width > text.x &&
          actions.y < text.y + text.height && actions.y + actions.height > text.y;
        expect(overlap).toBe(false);
        if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `editing-${width}x${height}-${position.x}-${position.y}.png`) });
        await page.getByRole('button', { name: 'Cancel text edit' }).tap();
        await expect(line).toHaveCount(0);
      });
    }
  });
}

test.describe('rapid mobile line actions', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('repeated Done and racing Cancel do not disrupt the single commit', async ({ page }) => {
    const line = await openLine(page, true);
    await line.fill('CHANGED TEXT');
    const done = page.getByRole('button', { name: 'Done editing text' });
    await done.evaluate(button => {
      const cancel = button.parentElement.querySelector('[aria-label="Cancel text edit"]');
      button.click(); button.click(); cancel.click();
    });
    await expect(line).toHaveCount(0);
    expect(await downloadedText(page)).toContain('CHANGED TEXT');
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await expect.poll(async () => downloadedText(page)).toContain('ORIGINAL TEXT');
  });

  test('page navigation while Done is committing waits for the edit', async ({ page }) => {
    const line = await openLine(page, true, 2);
    await line.fill('CHANGED TEXT');
    await page.getByRole('button', { name: 'Done editing text' }).evaluate(button => {
      button.click();
      document.querySelector('[aria-label="Next page"]').click();
    });
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    const saved = await downloadedText(page);
    expect(saved).toContain('CHANGED TEXT');
    expect(saved).toContain('PAGE TWO');
    expect(saved).not.toContain('ORIGINAL TEXT');
  });

  test('a new document can be edited after the previous commit', async ({ page }) => {
    const first = await openLine(page, true);
    await first.fill('FIRST DOCUMENT');
    await page.getByRole('button', { name: 'Done editing text' }).tap();
    await expect(first).toHaveCount(0);
    await page.getByTitle('Close file & return home').tap();
    await page.getByRole('button', { name: 'Discard changes' }).tap();
    await expect(page).toHaveURL(/\/Paperloom-PDF\/?$/);
    const second = await openLine(page, true);
    await second.fill('SECOND DOCUMENT');
    await page.getByRole('button', { name: 'Done editing text' }).tap();
    await expect(second).toHaveCount(0);
    const saved = await downloadedText(page);
    expect(saved).toContain('SECOND DOCUMENT');
    expect(saved).not.toContain('FIRST DOCUMENT');
  });
});

test('desktop keeps Enter and Escape line editing shortcuts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let line = await openLine(page, false);
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'editing-desktop.png') });
  await expect(page.getByRole('button', { name: 'Done editing text' })).toHaveCount(0);
  await line.fill('DISCARDED TEXT');
  await line.press('Escape');
  await expect(line).toHaveCount(0);
  expect(await downloadedText(page)).toContain('ORIGINAL TEXT');
  await page.locator('[data-page-render-surface]').click({ position: { x: 80, y: 95 } });
  line = page.getByRole('textbox', { name: 'Edit line' });
  await line.fill('CHANGED TEXT');
  await line.press('Enter');
  await expect(line).toHaveCount(0);
  expect(await downloadedText(page)).toContain('CHANGED TEXT');
});

test('pending text commit blocks additional input without losing the draft', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  let release;
  try {
    const page = await context.newPage();
    const line = await openLine(page, true);
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const fontStarted = new Promise(resolve => { started = resolve; });
    await page.route('**/fonts/*.ttf', async route => { started(); await gate; await route.continue(); });
    await line.fill('CHANGED 你好');
    await page.getByRole('button', { name: 'Done editing text' }).tap();
    await Promise.race([fontStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request did not start')), 10_000))]);
    await expect(line).toHaveAttribute('readonly', '', { timeout: 3_000 });
    await expect(page.getByText('Applying text…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel text edit' })).toBeDisabled();
    await line.focus();
    await page.keyboard.insertText(' EXTRA');
    await line.dispatchEvent('paste', { bubbles: true, cancelable: true });
    await page.evaluate(() => document.execCommand('insertText', false, ' PASTED'));
    await expect(line).toHaveValue('CHANGED 你好');
    release();
    await expect(line).toHaveCount(0);
    const saved = await downloadedText(page);
    expect(saved).toContain('CHANGED 你好');
    expect(saved).not.toContain('EXTRA');
    expect(saved).not.toContain('PASTED');
  } finally { release?.(); await context.close(); }
});

test('composition must finish before the draft can be submitted', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const line = await openLine(page, true, 2);
    const done = page.getByRole('button', { name: 'Done editing text' });
    await line.dispatchEvent('compositionstart', { data: '' });
    await line.fill('CHANGED 你好');
    await expect(done).toBeDisabled();
    await expect(page.getByText('Finish composing', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).tap();
    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    await expect(line).toHaveValue('CHANGED 你好');
    await line.dispatchEvent('compositionend', { data: '你好' });
    await expect(done).toBeEnabled();
    await done.tap();
    await expect(line).toHaveCount(0);
    const saved = await downloadedText(page);
    expect(saved).toContain('CHANGED 你好');
    expect(saved).not.toContain('ORIGINAL TEXT');
  } finally { await context.close(); }
});

test('font-load failure retains an editable draft for retry', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const line = await openLine(page, true);
    let rejectFonts = true;
    let markAborted;
    const fontAborted = new Promise(resolve => { markAborted = resolve; });
    await page.route('**/fonts/*.ttf', route => {
      if (!rejectFonts) return route.continue();
      markAborted();
      return route.abort('failed');
    });
    await line.fill('CHANGED 你好');
    const done = page.getByRole('button', { name: 'Done editing text' });
    await done.tap();
    await Promise.race([fontAborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request was not aborted')), 10_000))]);
    await expect(page.getByRole('status').filter({ hasText: 'These characters need an embedded font' })).toBeVisible();
    await expect(line).toBeEditable();
    await expect(line).toHaveValue('CHANGED 你好');
    await expect(done).toBeEnabled();
    await line.fill('RETRY 你好');
    rejectFonts = false;
    await done.tap();
    await expect(line).toHaveCount(0);
    expect(await downloadedText(page)).toContain('RETRY 你好');
  } finally { await context.close(); }
});

for (const changed of [false, true]) test(`selecting a form field exits the ${changed ? 'changed' : 'unchanged'} text edit`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([400, 400]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdfPage.drawText('ORIGINAL TEXT', { x: 50, y: 300, size: 20, font });
    const field = pdf.getForm().createTextField('Name');
    field.setText('Original');
    field.addToPage(pdfPage, { x: 50, y: 200, width: 200, height: 35 });
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'field.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.tap({ position: { x: 80, y: 95 } });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await expect(line).toHaveValue('ORIGINAL TEXT');
    if (changed) await line.fill('CHANGED TEXT');
    await surface.tap({ position: { x: 100, y: 182 } });
    await expect(page.getByRole('textbox', { name: 'Edit line' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Text edit actions' })).toHaveCount(0, { timeout: 3_000 });
    if (changed) {
      await page.getByTitle('Hide panel').tap();
      expect(await downloadedText(page)).toContain('CHANGED TEXT');
    }
  } finally { await context.close(); }
});

test('selecting an existing signature commits the active text edit', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'line.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).tap();
    await page.getByRole('button', { name: 'Create signature' }).tap();
    await page.getByRole('button', { name: 'Type', exact: true }).tap();
    await page.getByPlaceholder('Type your name').fill('Jane Doe');
    await page.getByRole('button', { name: 'Save to library' }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.tap({ position: { x: 200, y: 230 } });
    const signature = surface.getByAltText('Signature');
    await expect(signature).toHaveCount(1);
    await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.tap({ position: { x: 80, y: 95 } });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await line.fill('CHANGED TEXT');
    const box = await signature.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(line).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Text edit actions' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await downloadedText(page)).toContain('CHANGED TEXT');
  } finally { await context.close(); }
});

test('selecting a highlighted link commits the active text edit', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([400, 400]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdfPage.drawText('ORIGINAL TEXT', { x: 50, y: 300, size: 20, font });
    const link = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 150, 250, 190], Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of('https://example.test') } });
    pdfPage.node.addAnnot(pdf.context.register(link));
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'link.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
    await page.getByRole('button', { name: 'Scan for links' }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.tap({ position: { x: 80, y: 95 } });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await line.fill('CHANGED TEXT');
    await surface.tap({ position: { x: 100, y: 230 } });
    await expect(line).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Text edit actions' })).toHaveCount(0);
    await expect(page.locator('[data-link-popover]')).toBeVisible();
    await surface.tap({ position: { x: 300, y: 300 } });
    await expect(page.locator('[data-link-popover]')).toHaveCount(0);
    expect(await downloadedText(page)).toContain('CHANGED TEXT');
  } finally { await context.close(); }
});

test('switching between text lines keeps both edits', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([400, 400]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdfPage.drawText('ORIGINAL TEXT', { x: 50, y: 300, size: 20, font });
    pdfPage.drawText('SECOND LINE', { x: 50, y: 250, size: 20, font });
    await page.goto('./');
    await page.locator('input[type=file]').setInputFiles({ name: 'lines.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ useObjectStreams: false })) });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
    await page.getByTitle('Hide panel').tap();
    await surface.tap({ position: { x: 80, y: 95 } });
    const line = page.getByRole('textbox', { name: 'Edit line' });
    await expect(line).toHaveValue('ORIGINAL TEXT');
    await line.fill('FIRST CHANGE');
    await surface.tap({ position: { x: 80, y: 145 } });
    await expect(line).toHaveValue('SECOND LINE');
    await line.fill('SECOND CHANGE');
    await page.getByRole('button', { name: 'Done editing text' }).tap();
    await expect(line).toHaveCount(0);
    const saved = await downloadedText(page);
    expect(saved).toContain('FIRST CHANGE');
    expect(saved).toContain('SECOND CHANGE');
  } finally { await context.close(); }
});

for (const phase of ['editing', 'submitting']) {
  test(`signature handles cannot change a signature while text is ${phase}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    let release;
    try {
      const page = await context.newPage();
      await page.goto('./');
      await page.locator('input[type=file]').setInputFiles({ name: 'line.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
      const surface = page.locator('[data-page-render-surface]');
      await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
      await page.getByRole('button', { name: 'Sign', exact: true }).tap();
      await page.getByRole('button', { name: 'Create signature' }).tap();
      await page.getByRole('button', { name: 'Type', exact: true }).tap();
      await page.getByPlaceholder('Type your name').fill('Jane Doe');
      await page.getByRole('button', { name: 'Save to library' }).tap();
      await page.getByTitle('Hide panel').tap();
      await surface.tap({ position: { x: 200, y: 230 } });
      const signature = surface.getByAltText('Signature');
      await expect(signature).toHaveCount(1);
      await page.getByRole('button', { name: 'Show signature resize and rotation controls' }).tap();
      const handle = page.locator('[data-touch-handle="se"]');
      await expect(handle).toHaveCount(1);
      const initialSignature = await signature.boundingBox();
      const offset = { x: initialSignature.width - 5, y: initialSignature.height - 5 };
      await page.getByRole('button', { name: 'Edit Text', exact: true }).tap();
      await page.getByTitle('Hide panel').tap();
      await surface.tap({ position: { x: 80, y: 95 } });
      const line = page.getByRole('textbox', { name: 'Edit line' });
      await line.fill(phase === 'submitting' ? 'DRAFT 你好' : 'DRAFT TEXT');
      if (phase === 'submitting') {
        let started;
        const fontStarted = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/fonts/*.ttf', async route => { started(); await gate; await route.continue(); });
        await page.getByRole('button', { name: 'Done editing text' }).tap();
        await Promise.race([fontStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Font request did not start')), 10_000))]);
        await expect(line).toHaveAttribute('readonly', '');
      }
      const before = await signature.boundingBox();
      const start = { x: before.x + offset.x, y: before.y + offset.y };
      await expect(handle).toHaveCount(0);
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-touch-handle]')?.getAttribute('data-touch-handle'), start);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + 40, y: start.y + 30 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await page.waitForTimeout(300);
      const after = await signature.boundingBox();
      expect(hit).not.toBe('se');
      expect(after.width).toBeCloseTo(before.width, 1);
      expect(after.height).toBeCloseTo(before.height, 1);
      await expect(line).toHaveValue(phase === 'submitting' ? 'DRAFT 你好' : 'DRAFT TEXT');
      if (phase === 'submitting') {
        release();
        await expect(line).toHaveCount(0);
        await expect(handle).toHaveCount(1);
        const box = await handle.boundingBox();
        const cdpAfter = await page.context().newCDPSession(page);
        const a = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await cdpAfter.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
        await cdpAfter.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 40, y: a.y + 30 }] });
        await cdpAfter.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdpAfter.detach();
        await expect.poll(async () => (await signature.boundingBox()).width).toBeGreaterThan(before.width + 10);
      }
    } finally { release?.(); await context.close(); }
  });
}
