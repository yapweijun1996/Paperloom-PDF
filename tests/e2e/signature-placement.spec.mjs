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
  await expect(rotate).toBeDisabled();
  // The keyboard delete action must also leave the locked signature selected.
  await page.keyboard.press('Delete');
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
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


test('locked signature rejects delete and opacity, supports undo, redo and unlock', async ({ page }) => {
  await openPdf(page, await blankPdf());
  await createSignature(page);
  const surface = page.locator('[data-page-render-surface]');
  const card = page.locator('[draggable="true"]').filter({ has: page.getByText('This session only', { exact: true }) });
  await card.dragTo(surface, { targetPosition: { x: 200, y: 180 } });
  const image = surface.getByAltText('Signature');
  await image.click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  const unlock = page.getByRole('button', { name: 'Unlock', exact: true });
  await expect(unlock).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Signature opacity' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete signature' })).toBeDisabled();
  await expect(surface.getByTitle('Delete', { exact: true })).toBeDisabled();
  await expect(page.getByTitle('Rotate 15°')).toBeDisabled();
  const saved = await stamps(await download(page));
  expect(saved).toHaveLength(1);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(unlock).toBeVisible();
  await expect(image).toHaveCount(1);
  await page.getByTitle('Toggle Find & Replace').click();
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
  await page.getByTitle('Close Search').click();
  const after = await stamps(await download(page));
  expect(after).toHaveLength(1);
  expect(after[0].get(PDFName.of('AP'))).toBeTruthy();
  expect(after[0].get(PDFName.of('Rect')).toString()).toBe(saved[0].get(PDFName.of('Rect')).toString());
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await image.click();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
  await image.click();
  await expect(unlock).toBeVisible();
  await unlock.click();
  await expect(page.getByRole('slider', { name: 'Signature opacity' })).toBeEnabled();
  await page.getByRole('slider', { name: 'Signature opacity' }).fill('40');
  await expect.poll(() => image.locator('..').evaluate(el => getComputedStyle(el).opacity)).toBe('0.4');
  await page.getByRole('button', { name: 'Delete signature' }).click();
  await expect(image).toHaveCount(0);
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect(image).toHaveCount(1);
});

test('replacing the visual appearance of a locked field is rejected without deselecting it', async ({ page }) => {
  await openPdf(page, await blankPdf({ field: true }));
  await createSignature(page);
  await page.getByTitle('Hide panel').click();
  const surface = page.locator('[data-page-render-surface]');
  const box = await surface.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.525);
  const image = surface.getByAltText('Signature');
  await expect(image).toHaveCount(1);
  await image.click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  const before = await download(page);
  // Dispatch to the canvas at the actual field coordinates, as when a field is selected
  // from outside its overlay or through another field placement entry point.
  const currentBox = await surface.boundingBox();
  await surface.locator('canvas.pdf-canvas').dispatchEvent('click', { clientX: currentBox.x + currentBox.width * 0.5, clientY: currentBox.y + currentBox.height * 0.525 });
  await expect(page.getByText(/unlock the signature before replacing its field/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  await expect(image).toHaveCount(1);
  const after = await download(page);
  const getAnnotation = async bytes => {
    const pdf = await PDFDocument.load(bytes);
    return pdf.context.lookup(pdf.getPages()[0].node.Annots().get(0));
  };
  const first = await getAnnotation(before), second = await getAnnotation(after);
  expect(first.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
  expect(second.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
  expect(second.get(PDFName.of('V'))).toBeUndefined();
  expect(second.get(PDFName.of('AP'))).toBeTruthy();
  expect(second.get(PDFName.of('PaperloomSignatureId')).toString()).toBe(first.get(PDFName.of('PaperloomSignatureId')).toString());
});

test('recovered locked field with stale overlay coordinates cannot be replaced', async ({ page }) => {
  await openPdf(page, await blankPdf({ field: true }));
  await createSignature(page);
  await page.getByTitle('Hide panel').click();
  const surface = page.locator('[data-page-render-surface]'), initial = await surface.boundingBox();
  await page.mouse.click(initial.x + initial.width * 0.5, initial.y + initial.height * 0.525);
  const image = surface.getByAltText('Signature');
  await expect(image).toHaveCount(1);
  await image.click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  const recovery = () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('pdf-files', 'readonly');
      const get = tx.objectStore('pdf-files').get('editor-session');
      get.onsuccess = () => resolve(get.result?.overlays?.signaturesJson ?? '[]');
      get.onerror = () => reject(get.error); tx.oncomplete = () => db.close();
    };
  }));
  await expect.poll(async () => JSON.parse(await recovery())[0]?.locked, { timeout: 15000 }).toBe(true);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('pdf-files', 'readwrite'), store = tx.objectStore('pdf-files');
      const get = store.get('editor-session');
      get.onsuccess = () => {
        const session = get.result, signatures = JSON.parse(session.overlays.signaturesJson);
        signatures[0].x += 80;
        session.overlays.signaturesJson = JSON.stringify(signatures);
        store.put(session, 'editor-session');
      };
      tx.onerror = () => reject(tx.error); tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(image).toHaveCount(1);
  await image.click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Signature opacity' })).toBeDisabled();
  // A locked field must be rejected even when the session-only library was cleared.
  let rect = await surface.boundingBox();
  await surface.locator('canvas.pdf-canvas').dispatchEvent('click', { clientX: rect.x + rect.width * 0.5, clientY: rect.y + rect.height * 0.525 });
  await expect(page.getByText(/unlock the signature before replacing its field/i)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Create signature' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  await page.getByText(/unlock the signature before replacing its field/i).locator('button').click();
  await expect(page.getByText(/unlock the signature before replacing its field/i)).toHaveCount(0);
  // Session-only library entries are intentionally cleared by reload.
  await page.getByRole('button', { name: 'Create signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Second Example');
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await expect(dialog).toHaveCount(0);
  rect = await surface.boundingBox();
  await surface.locator('canvas.pdf-canvas').dispatchEvent('click', { clientX: rect.x + rect.width * 0.5, clientY: rect.y + rect.height * 0.525 });
  await expect(page.getByText(/unlock the signature before replacing its field/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  const pdf = await PDFDocument.load(await download(page));
  const field = pdf.context.lookup(pdf.getPages()[0].node.Annots().get(0));
  expect(field.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
  expect(field.get(PDFName.of('AP'))).toBeTruthy();
  expect(field.get(PDFName.of('V'))).toBeUndefined();
});

test('clicking an unsigned field with an empty library preserves the field selection', async ({ page }) => {
  await openPdf(page, await blankPdf({ field: true }));
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const surface = page.locator('[data-page-render-surface]'), box = await surface.boundingBox();
  await surface.locator('canvas.pdf-canvas').dispatchEvent('click', { clientX: box.x + box.width * 0.5, clientY: box.y + box.height * 0.525 });
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Selected Field');
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await expect(dialog).toHaveCount(0);
  const place = page.getByRole('button', { name: 'Place library signature into field' });
  await expect(place).toBeVisible();
  await place.click();
  await expect(surface.getByAltText('Signature')).toHaveCount(1);
  const pdf = await PDFDocument.load(await download(page));
  const field = pdf.context.lookup(pdf.getPages()[0].node.Annots().get(0));
  expect(field.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
  expect(field.get(PDFName.of('AP'))).toBeTruthy();
});
