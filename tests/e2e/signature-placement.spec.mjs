import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { readFileSync } from 'node:fs';

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({
    name: 'blank.pdf', mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function blankPdf({ rotated = false, field = false } = {}) {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([400, 400]);
  if (rotated) {
    pdfPage.setCropBox(50, 75, 300, 250);
    pdfPage.setRotation(degrees(90));
  }
  if (field) {
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
      T: PDFString.of('Signature1'), Rect: [100, 150, 300, 230], F: 4, P: pdfPage.ref });
    const ref = pdf.context.register(widget);
    pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function createSignature(page) {
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Alex Example');
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('This session only', { exact: true })).toBeVisible();
}

async function download(page) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click(),
  ]);
  return readFileSync(await file.path());
}

async function stamps(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const annots = pdf.getPages()[0].node.Annots();
  if (!annots) return [];
  return annots.asArray().map(ref => pdf.context.lookup(ref)).filter(dict => dict.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
}

test('mobile touch places a selected library signature and saves its appearance', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await blankPdf());
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByTitle('Hide panel').click();
    const surface = page.locator('[data-page-render-surface]');
    await surface.tap({ position: { x: 100, y: 100 } });
    await expect(surface.getByAltText('Signature')).toHaveCount(0);
    await expect(page.getByTitle('Undo (Ctrl+Z)')).toBeDisabled();
    await createSignature(page);
    await page.getByTitle('Hide panel').click();
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error('Missing PDF page');
    await page.touchscreen.tap(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await expect(surface.getByAltText('Signature')).toHaveCount(1);
    await page.getByTitle('Toggle Find & Replace').click();
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
    await page.getByTitle('Close Search').click();
    const output = await download(page);
    const annotations = await stamps(output);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].get(PDFName.of('AP'))).toBeTruthy();
    // The current editor has a live signature overlay: its saved appearance
    // must not also be painted into the underlying otherwise-blank canvas.
    await expect(surface.getByAltText('Signature')).toHaveCount(1);
    await expect.poll(() => surface.locator('canvas.pdf-canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) count++;
      return count;
    })).toBe(0);
    const reopenedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const reopened = await reopenedContext.newPage();
    await (await reopenedContext.newCDPSession(reopened)).send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await openPdf(reopened, output);
    const darkPixels = await reopened.locator('[data-page-render-surface] canvas.pdf-canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) count++;
      return count;
    });
    expect(darkPixels).toBeGreaterThan(10);
    await reopenedContext.close();
  } finally { await context.close(); }
});


test('desktop drag still places a signature and selecting it does not duplicate it', async ({ page }) => {
  await openPdf(page, await blankPdf());
  await createSignature(page);
  const surface = page.locator('[data-page-render-surface]');
  const card = page.locator('[draggable="true"]').filter({ has: page.getByText('This session only', { exact: true }) });
  await card.dragTo(surface, { targetPosition: { x: 200, y: 180 } });
  const signature = surface.getByAltText('Signature');
  await expect(signature).toHaveCount(1);
  await signature.locator('..').click();
  await expect(signature).toHaveCount(1);
  const annotations = await stamps(await download(page));
  expect(annotations).toHaveLength(1);
  expect(annotations[0].get(PDFName.of('AP'))).toBeTruthy();
});


test('touch placement uses the crop and rotation of the displayed page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await blankPdf({ rotated: true }));
    await createSignature(page);
    await page.getByTitle('Hide panel').click();
    const surface = page.locator('[data-page-render-surface]');
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error('Missing rotated PDF page');
    await page.touchscreen.tap(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await expect(surface.getByAltText('Signature')).toHaveCount(1);
    const annotations = await stamps(await download(page));
    expect(annotations).toHaveLength(1);
    const rect = annotations[0].lookup(PDFName.of('Rect')).asArray().map(n => n.asNumber());
    // Touch events can round screen coordinates to whole CSS pixels.
    expect(Math.abs((rect[0] + rect[2]) / 2 - (50 + 300 * 0.45))).toBeLessThan(1.5);
    expect(Math.abs((rect[1] + rect[3]) / 2 - (75 + 250 * 0.35))).toBeLessThan(1.5);
  } finally { await context.close(); }
});

test('tapping a signature field fills the field rather than adding a free stamp', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await blankPdf({ field: true }));
    await createSignature(page);
    await page.getByTitle('Hide panel').click();
    const surface = page.locator('[data-page-render-surface]');
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error('Missing PDF page');
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.525);
    await expect(surface.getByAltText('Signature')).toHaveCount(1);
    const output = await download(page);
    expect(await stamps(output)).toHaveLength(0);
    const pdf = await PDFDocument.load(output);
    const annotation = pdf.context.lookup(pdf.getPages()[0].node.Annots().get(0));
    expect(annotation.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
    expect(annotation.get(PDFName.of('AP'))).toBeTruthy();
  } finally { await context.close(); }
});

test('locked rotation creates no unsaved change or undo entry', async ({ page }) => {
  await openPdf(page, await blankPdf());
  await createSignature(page);
  const surface = page.locator('[data-page-render-surface]');
  const card = page.locator('[draggable="true"]').filter({ has: page.getByText('This session only', { exact: true }) });
  await card.dragTo(surface, { targetPosition: { x: 200, y: 180 } });
  const image = surface.getByAltText('Signature');
  await expect(image).toHaveCount(1);
  await image.locator('..').click();
  const rotate = page.getByRole('button', { name: 'Rotate', exact: true });
  await rotate.click();
  await expect(image.locator('..')).toHaveCSS('transform', /matrix\(0\.9659/);
  const saved = await stamps(await download(page));
  expect(saved).toHaveLength(1);
  expect(saved[0].get(PDFName.of('AP'))).toBeTruthy();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  await download(page);
  await page.getByTitle('Toggle Find & Replace').click();
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
  await rotate.click();
  // Allow the queued native edit to settle before checking that it had no effect.
  await page.waitForTimeout(500);
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
  await page.getByTitle('Close Search').click();
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await image.click();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  await expect(image.locator('..')).toHaveCSS('transform', /matrix\(0\.9659/);
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect(image.locator('..')).toHaveCSS('transform', /matrix\(1, 0, 0, 1/);
  const undone = await stamps(await download(page));
  expect(undone).toHaveLength(1);
  const width = stamp => {
    const rect = stamp.lookup(PDFName.of('Rect')).asArray().map(value => value.asNumber());
    return rect[2] - rect[0];
  };
  expect(width(saved[0])).toBeGreaterThan(width(undone[0]) + 1);
});
