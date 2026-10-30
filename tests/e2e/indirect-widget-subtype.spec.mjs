import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  const push = form.createButton('Push');
  push.addToPage('PRESS', page, { x: 40, y: 430, width: 160, height: 30, font });
  push.acroField.getWidgets()[0].dict.set(PDFName.of('A'), pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("unexpected")') }));
  const text = form.createTextField('Text'); text.addToPage(page, { x: 40, y: 360, width: 160, height: 30, font }); text.setText('Before');
  const checkbox = form.createCheckBox('Checkbox'); checkbox.addToPage(page, { x: 40, y: 290, width: 30, height: 30 });
  const radio = form.createRadioGroup('Radio');
  radio.addOptionToPage('One', page, { x: 40, y: 220, width: 30, height: 30 });
  radio.addOptionToPage('Two', page, { x: 100, y: 220, width: 30, height: 30 }); radio.select('One');
  const choice = form.createDropdown('Choice'); choice.addOptions(['Alpha', 'Bravo']); choice.select('Alpha');
  choice.addToPage(page, { x: 40, y: 145, width: 160, height: 30, font });
  const sig = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature'),
    Rect: [40, 40, 200, 100], F: 4, P: page.ref });
  const sigRef = pdf.context.register(sig); page.node.addAnnot(sigRef); form.acroForm.addField(sigRef);
  const subtype = pdf.context.register(PDFName.of('Widget'));
  for (const field of [push, text, checkbox, radio, choice]) for (const widget of field.acroField.getWidgets()) {
    widget.dict.set(PDFName.of('Subtype'), subtype);
  }
  sig.set(PDFName.of('Subtype'), subtype);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'indirect.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function selectPoint(page, point, mobile) {
  const surface = page.locator('[data-page-render-surface]');
  if (mobile) {
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    if (await panel.isVisible()) await panel.getByTitle('Hide panel').tap();
    await surface.evaluate((element, p) => {
      const scroller = element.closest('[data-canvas-stack]');
      const rect = element.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      scroller.scrollBy(rect.left + p.x - (view.left + view.width / 2), rect.top + p.y - (view.top + view.height / 2));
    }, point);
    await surface.tap({ position: point });
  } else await surface.click({ position: point });
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} selects and edits indirect subtype widgets`, async ({ browser }) => {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await openPdf(page, await fixture());
      await selectPoint(page, { x: 100, y: 55 }, mobile);
      const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
      await expect(panel.getByText('Push button actions are not supported.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: /click to (check|uncheck)/ })).toHaveCount(0);
      expect(dialogs).toEqual([]);
      await selectPoint(page, { x: 100, y: 125 }, mobile);
      const text = panel.getByLabel('Value', { exact: true });
      await expect(text).toHaveValue('Before'); await text.fill('After'); await text.press('Enter');
      await selectPoint(page, { x: 55, y: 195 }, mobile);
      const checkbox = panel.getByRole('button', { name: 'Unchecked — click to check' });
      await expect(checkbox).toBeVisible(); await checkbox.click();
      await selectPoint(page, { x: 115, y: 265 }, mobile);
      const radio = panel.getByRole('button', { name: 'Unchecked — click to check' });
      await expect(radio).toBeVisible(); await radio.click();
      await selectPoint(page, { x: 100, y: 340 }, mobile);
      const choice = panel.getByLabel('Choice value');
      await expect(choice).toHaveValue('Alpha'); await choice.selectOption('Bravo');
      if (mobile) await panel.getByTitle('Hide panel').click();
      const [download] = await Promise.all([page.waitForEvent('download'),
        page.getByTitle('Download original / edited PDF (no recompression)').click()]);
      const bytes = readFileSync(await download.path());
      const saved = (await PDFDocument.load(bytes)).getForm();
      expect(saved.getTextField('Text').getText()).toBe('After');
      expect(saved.getCheckBox('Checkbox').isChecked()).toBe(true);
      expect(saved.getRadioGroup('Radio').getSelected()).toBe('Two');
      expect(saved.getDropdown('Choice').getSelected()).toEqual(['Bravo']);
      const push = saved.getButton('Push').acroField.getWidgets()[0].dict;
      expect(push.get(PDFName.of('Subtype'))).toBeInstanceOf(PDFRef);
      expect(push.lookup(PDFName.of('A')).get(PDFName.of('S'))).toBe(PDFName.of('JavaScript'));
      const other = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
      try {
        const reopened = await other.newPage();
        await (await other.newCDPSession(reopened)).send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await openPdf(reopened, bytes);
        await selectPoint(reopened, { x: 100, y: 125 }, mobile);
        await expect(reopened.getByLabel('Value', { exact: true })).toHaveValue('After');
      } finally { await other.close(); }
    } finally { await context.close(); }
  });
}
