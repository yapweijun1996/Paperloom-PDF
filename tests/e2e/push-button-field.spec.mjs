import { test, expect } from '@playwright/test';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture({ indirectFlags = false, signature = false } = {}) {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([400, 400]);
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const push = form.createButton('Push');
  push.addToPage('Run action', pdfPage, { x: 40, y: 310, width: 160, height: 35, font });
  const widget = push.acroField.getWidgets()[0].dict;
  widget.set(PDFName.of('A'), pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("unexpected action")') }));
  // The field flags live on the parent field and may themselves be indirect.
  const flags = push.acroField.dict.get(PDFName.of('Ff'));
  if (indirectFlags) push.acroField.dict.set(PDFName.of('Ff'), pdf.context.register(flags));
  const checkbox = form.createCheckBox('Checkbox');
  checkbox.addToPage(pdfPage, { x: 40, y: 230, width: 30, height: 30 });
  const radio = form.createRadioGroup('Radio');
  radio.addOptionToPage('One', pdfPage, { x: 40, y: 155, width: 30, height: 30 });
  radio.addOptionToPage('Two', pdfPage, { x: 100, y: 155, width: 30, height: 30 });
  radio.select('One');
  if (signature) {
    const sig = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'),
      Rect: [250, 200, 350, 250], F: 4, P: pdfPage.ref });
    const ref = pdf.context.register(sig);
    pdfPage.node.addAnnot(ref);
    form.acroForm.addField(ref);
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function buttonSnapshot(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  const field = form.getButton('Push');
  const widget = field.acroField.getWidgets()[0].dict;
  const action = widget.lookup(PDFName.of('A'), PDFDict);
  const appearance = widget.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream);
  return {
    flags: field.acroField.dict.lookup(PDFName.of('Ff'), PDFNumber).asNumber(),
    actionType: action.lookup(PDFName.of('S'), PDFName).asString(),
    script: action.lookup(PDFName.of('JS'), PDFString).decodeText(),
    appearance: Buffer.from(appearance.getContents()),
    checkbox: form.getCheckBox('Checkbox').isChecked(),
    radio: form.getRadioGroup('Radio').getSelected(),
  };
}

async function open(page, bytes) {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'buttons.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function selectPoint(page, point, mobile) {
  const surface = page.locator('[data-page-render-surface]');
  if (mobile) {
    await surface.evaluate((element, p) => {
      const scroller = element.closest('[data-canvas-stack]');
      const rect = element.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      scroller.scrollBy(rect.left + p.x - (view.left + view.width / 2), rect.top + p.y - (view.top + view.height / 2));
    }, point);
    await surface.tap({ position: point });
  } else await surface.click({ position: point });
}

for (const mobile of [false, true]) for (const indirectFlags of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} push button with ${indirectFlags ? 'indirect' : 'direct'} inherited flags is informational`, async ({ browser }) => {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      const bytes = await fixture({ indirectFlags });
      await open(page, bytes);
      await selectPoint(page, { x: 100, y: 72 }, mobile);
      const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
      await expect(panel).toBeVisible();
      const explanation = panel.getByText('Push button actions are not supported.', { exact: true });
      await expect(explanation).toBeVisible({ timeout: 3000 });
      if (mobile) await expect.poll(() => explanation.evaluate(element => {
        const panelElement = element.closest('[data-keep-text-edit]');
        const header = panelElement?.querySelector('[data-options-header]');
        if (!panelElement || !header) return false;
        const box = element.getBoundingClientRect(), outer = panelElement.getBoundingClientRect();
        return box.top >= header.getBoundingClientRect().bottom - 1 && box.bottom <= outer.bottom + 1 && box.bottom <= innerHeight;
      })).toBe(true);
      if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR && !indirectFlags) {
        await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `push-button-${mobile ? 'mobile' : 'desktop'}.png`) });
      }
      await expect(panel.getByRole('button', { name: /click to (check|uncheck)/ })).toHaveCount(0);
      await expect(panel.getByText('Push button actions are not supported.')).not.toBeFocused();
      if (mobile) expect(await page.evaluate(() => document.activeElement?.matches('input, textarea, select'))).toBe(false);
      expect(dialogs).toEqual([]);
      await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
      if (mobile) await panel.getByTitle('Hide panel').tap();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
      expect(await buttonSnapshot(readFileSync(await download.path()))).toEqual(await buttonSnapshot(bytes));
    } finally { await context.close(); }
  });
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} checkbox and radio remain editable and undoable`, async ({ browser }) => {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await open(page, await fixture());
      const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
      await selectPoint(page, { x: 55, y: 155 }, mobile);
      await panel.getByRole('button', { name: 'Unchecked — click to check' }).click();
      await expect(panel.getByRole('button', { name: 'Checked — click to uncheck' })).toBeVisible();
      if (mobile) await panel.getByTitle('Hide panel').tap();
      await selectPoint(page, { x: 115, y: 230 }, mobile);
      await panel.getByRole('button', { name: 'Unchecked — click to check' }).click();
      await expect(panel.getByRole('button', { name: /^Checked/ })).toBeVisible();
      if (mobile) await panel.getByTitle('Hide panel').tap();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
      const saved = readFileSync(await download.path());
      const form = (await PDFDocument.load(saved)).getForm();
      expect(form.getCheckBox('Checkbox').isChecked()).toBe(true);
      expect(form.getRadioGroup('Radio').getSelected()).toBe('Two');
      const reopenedContext = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
      try {
        const reopened = await reopenedContext.newPage();
        await open(reopened, saved);
        await selectPoint(reopened, { x: 115, y: 230 }, mobile);
        await expect(reopened.getByRole('button', { name: /^Checked/ })).toBeVisible();
      } finally { await reopenedContext.close(); }
      await page.getByTitle('Undo (Ctrl+Z)').click();
      await page.getByTitle('Undo (Ctrl+Z)').click();
      const [undone] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
      const restored = (await PDFDocument.load(readFileSync(await undone.path()))).getForm();
      expect(restored.getCheckBox('Checkbox').isChecked()).toBe(false);
      expect(restored.getRadioGroup('Radio').getSelected()).toBe('One');
    } finally { await context.close(); }
  });
}


test('selecting a push button preserves a signed PDF and does not execute its action', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-push-signed-'));
  try {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), p12 = join(dir, 'identity.p12');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-subj', '/CN=Paperloom Test', '-days', '1'], { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12,
      '-passout', 'pass:test-only'], { stdio: 'ignore' });
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await open(page, await fixture({ signature: true }));
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('button', { name: 'Import / manage certificates' }).click();
    await page.getByLabel('P12/PFX password (optional)').fill('test-only');
    await page.locator('input[accept*=".p12"]').setInputFiles(p12);
    await expect(page.getByText('Paperloom Test', { exact: false }).first()).toBeVisible();
    rmSync(key); rmSync(p12);
    await page.getByRole('button', { name: 'Close certificates' }).click();
    await page.getByRole('button', { name: 'Digitally sign document' }).click();
    await expect(page.getByRole('button', { name: /Signature1 Signed/ })).toBeVisible();
    const [beforeDownload] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
    const before = readFileSync(await beforeDownload.path());
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await selectPoint(page, { x: 100, y: 72 }, false);
    await expect(page.getByText('Push button actions are not supported.', { exact: true })).toBeVisible();
    await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
    expect(dialogs).toEqual([]);
    const [afterDownload] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
    const after = readFileSync(await afterDownload.path());
    expect(after).toEqual(before);
    const path = join(dir, 'signed.pdf');
    const { writeFileSync } = await import('node:fs'); writeFileSync(path, after);
    expect(execFileSync('pdfsig', [path], { encoding: 'utf8' })).toContain('Signature is Valid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [width, height] of [[320, 568], [568, 320]]) {
  test(`push button explanation is revealed at ${width}x${height} without focusing an input`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await open(page, await fixture());
      await selectPoint(page, { x: 100, y: 72 }, true);
      const text = page.getByText('Push button actions are not supported.', { exact: true });
      await expect(text).toBeVisible();
      await expect.poll(() => text.evaluate(element => {
        const panel = element.closest('[data-keep-text-edit]'), header = panel?.querySelector('[data-options-header]');
        if (!panel || !header) return false;
        const box = element.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
        return box.top >= header.getBoundingClientRect().bottom - 1 && box.bottom <= bounds.bottom + 1 && box.bottom <= innerHeight;
      })).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.matches('input, textarea, select'))).toBe(false);
    } finally { await context.close(); }
  });
}
