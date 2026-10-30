import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory;
test.beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'paperloom-signature-widget-')); });
test.afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function fixture(mode, { rotated = false, rotation = null, transparent = false, withImage = false, largeField = false, fieldRect = null, omitModDate = false } = {}) {
  const pdf = await PDFDocument.create();
  if (omitModDate) {
    // The writer updates existing /ModDate on every save, including unchanged PDFs.
    // Remove only this volatile fixture entry so full byte comparisons stay strict.
    const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
    if (!info?.has(PDFName.of('ModDate'))) throw new Error('Fixture has no /ModDate');
    info.delete(PDFName.of('ModDate'));
  }
  const page = pdf.addPage([400, 400]);
  if (rotated || rotation !== null) {
    page.setCropBox(50, 75, 300, 250);
    page.setRotation(degrees(rotation ?? 90));
  }
  if (withImage) {
    const image = createCanvas(4, 4);
    image.getContext('2d').fillRect(0, 0, 4, 4);
    page.drawImage(await pdf.embedPng(image.toBuffer('image/png')), { x: 20, y: 340, width: 20, height: 20 });
  }
  if (mode !== 'stamp') {
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
      T: PDFString.of('Signature1'), Rect: fieldRect ?? (largeField ? [-300, -300, 700, 700] : [100, 150, 300, 230]), F: 4, P: page.ref });
    if (mode === 'native') {
      const content = `${transparent ? '/GS1 gs ' : ''}0 0 0 rg 10 10 180 60 re f`;
      const resources = transparent ? { ExtGState: { GS1: { Type: 'ExtGState', ca: 0.5 } } } : {};
      const stream = pdf.context.flateStream(content, { Type: 'XObject', Subtype: 'Form',
        BBox: [0, 0, 200, 80], Resources: resources });
      widget.set(PDFName.of('AP'), pdf.context.obj({ N: pdf.context.register(stream) }));
    }
    const ref = pdf.context.register(widget);
    page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function openPdf(page, bytes) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-page-render-surface] canvas.pdf-canvas')).toBeVisible();
}

async function pixels(bytes) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++;
  return { dark, center: Array.from(ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height * 0.525), 1, 1).data).slice(0, 3),
    width: image.width, height: image.height };
}

async function canvasPixels(page) {
  const data = await page.locator('[data-page-render-surface] canvas.pdf-canvas').evaluate(canvas => canvas.toDataURL('image/png'));
  return pixels(Buffer.from(data.split(',')[1], 'base64'));
}

async function signatureRegionDark(canvas) {
  return canvas.evaluate(element => {
    const ctx = element.getContext('2d');
    const scaleX = element.width / 400, scaleY = element.height / 400;
    const data = ctx.getImageData(Math.floor(100 * scaleX), Math.floor(170 * scaleY),
      Math.floor(200 * scaleX), Math.floor(80 * scaleY)).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++;
    return dark;
  });
}

async function exportImages(page, verify) {
  await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
  const panel = page.getByRole('dialog', { name: 'Export Document' });
  for (const format of ['PNG Image', 'JPEG Image', 'SVG Image']) {
    await panel.getByRole('button', { name: new RegExp(`^${format}`) }).click();
    const [download] = await Promise.all([page.waitForEvent('download'),
      panel.getByRole('button', { name: `Export as ${format}` }).click()]);
    let bytes = readFileSync(await download.path());
    if (format === 'SVG Image') {
      const match = bytes.toString().match(/data:image\/png;base64,([^"\s]+)/);
      if (!match) throw new Error('SVG does not contain its raster page');
      bytes = Buffer.from(match[1], 'base64');
    }
    verify(await pixels(bytes), format);
  }
  await panel.getByRole('button', { name: 'Close export panel' }).click();
}

async function downloadPdf(page, name) {
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const bytes = readFileSync(await download.path());
  writeFileSync(join(directory, `${name}.pdf`), bytes);
  return bytes;
}

async function poppler(bytes, name) {
  const path = join(directory, `${name}.pdf`);
  writeFileSync(path, bytes);
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-cropbox', '-r', '72', '-png', path, join(directory, name)]);
  return pixels(readFileSync(join(directory, `${name}.png`)));
}

async function placeVisualSignature(page, xFraction = 0.5, yFraction = 0.525) {
  await page.getByRole('button', { name: 'Sign', exact: true }).tap();
  await page.getByRole('button', { name: 'Create signature' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
  await dialog.getByPlaceholder('Type your name').fill('Alex Example');
  await dialog.getByRole('button', { name: 'Save to library' }).tap();
  await expect(dialog).toHaveCount(0);
  await page.getByTitle('Hide panel').tap();
  const surface = page.locator('[data-page-render-surface]');
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error('Missing PDF page');
  await page.touchscreen.tap(box.x + box.width * xFraction, box.y + box.height * yFraction);
  await expect(surface.getByAltText('Signature')).toHaveCount(1);
  await expect.poll(() => signatureRegionDark(surface.locator('canvas.pdf-canvas'))).toBe(0);
}

const expectAppearance = (result, label) => expect(result.dark, `${label} signature appearance`).toBeGreaterThan(20);
for (const [rotation, left, top, width, height] of [[0,50,95,200,80],[90,75,50,80,200],[180,50,75,200,80],[270,95,50,80,200]]) {
  test(`field overlay matches cropped page at ${rotation} degrees`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await openPdf(page, await fixture('field', { rotation }));
      await placeVisualSignature(page);
      const surface = page.locator('[data-page-render-surface]'), surfaceBox = await surface.boundingBox();
      const image = surface.getByAltText('Signature');
      await expect.poll(async () => {
        const box = await image.boundingBox();
        return box && [box.x - surfaceBox.x, box.y - surfaceBox.y, box.width, box.height].map(Math.round);
      }).toEqual([left, top, width, height]);
      const live = await surface.screenshot();
      await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
      const panel = page.getByRole('dialog', { name: 'Export Document' });
      await panel.getByRole('button', { name: /^PNG Image/ }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Export as PNG Image' }).click()]);
      const exported = readFileSync(await download.path());
      const raster = async bytes => {
        const bitmap = await loadImage(bytes), canvas = createCanvas(Math.round(surfaceBox.width), Math.round(surfaceBox.height));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return ctx.getImageData(left + 3, top + 3, width - 6, height - 6).data;
      };
      const actual = await raster(live), reference = await raster(exported);
      let delta = 0;
      for (let i = 0; i < actual.length; i += 4) delta += Math.abs(actual[i] - reference[i]) + Math.abs(actual[i + 1] - reference[i + 1]) + Math.abs(actual[i + 2] - reference[i + 2]);
      expect(delta / (actual.length / 4 * 3)).toBeLessThan(8);
    } finally { await context.close(); }
  });
}
test('clipped signature does not intercept clicks outside the page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field', { rotation: 0, fieldRect: [25, 150, 125, 230] }));
    await placeVisualSignature(page, 35 / 300, 135 / 250);
    const surface = page.locator('[data-page-render-surface]'), surfaceBox = await surface.boundingBox();
    await expect(surface.locator('[data-handle]')).toHaveCount(0);
    const point = { x: surfaceBox.x - 10, y: surfaceBox.y + 135 };
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-page-render-surface]'), point)).toBe(false);
    await page.mouse.click(point.x, point.y);
    await expect(surface.locator('[data-handle]')).toHaveCount(0);
    await page.mouse.click(surfaceBox.x + 35, surfaceBox.y + 135);
    await expect(surface.locator('[data-handle]')).toHaveCount(8);
  } finally { await context.close(); }
});
for (const rotation of [0, 90, 180, 270]) test(`rotated signature resize keeps its opposite corner on page ${rotation}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field', { rotation }));
    await placeVisualSignature(page);
    const surface = page.locator('[data-page-render-surface]'), image = surface.getByAltText('Signature');
    await image.locator('..').click();
    const box = await image.boundingBox(), turn = await page.getByTitle('Drag to rotate').boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(turn.x + turn.width / 2, turn.y + turn.height / 2);
    await page.mouse.down();
    await page.mouse.move(center.x + (rotation === 0 ? 150 : rotation === 180 ? -150 : 0),
      center.y + (rotation === 90 ? 150 : rotation === 270 ? -150 : 0), { steps: 5 });
    await page.mouse.up();
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.locator('..').evaluate(el => el.style.transform)).toContain(`rotate(${rotation - 270}deg)`);
    const beforePdf = await PDFDocument.load(await downloadPdf(page, `rotated-before-resize-${rotation}`));
    const beforeStamp = beforePdf.getPages()[0].node.Annots().asArray().map(ref => beforePdf.context.lookup(ref))
      .find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
    const beforeRect = beforeStamp.lookup(PDFName.of('Rect')).asArray().map(value => value.asNumber());
    const opposite = surface.locator('[data-handle="nw"]'), resize = surface.locator('[data-handle="se"]');
    const before = await opposite.boundingBox(), drag = await resize.boundingBox();
    await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
    await page.mouse.down();
    await page.mouse.move(drag.x + drag.width / 2 + 30, drag.y + drag.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => {
      const after = await opposite.boundingBox();
      return Math.hypot(after.x - before.x, after.y - before.y);
    }).toBeLessThan(1);
    const saved = await PDFDocument.load(await downloadPdf(page, `rotated-resize-${rotation}`));
    const annots = saved.getPages()[0].node.Annots().asArray().map(ref => saved.context.lookup(ref));
    const stamp = annots.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
    expect(stamp.get(PDFName.of('AP'))).toBeTruthy();
    expect(stamp.lookup(PDFName.of('Rect')).asArray().map(value => value.asNumber())).not.toEqual(beforeRect);
    await page.getByTitle('Undo (Ctrl+Z)').click();
    const undone = await PDFDocument.load(await downloadPdf(page, `rotated-resize-undo-${rotation}`));
    const restored = undone.getPages()[0].node.Annots().asArray().map(ref => undone.context.lookup(ref))
      .find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
    expect(restored.lookup(PDFName.of('Rect')).asArray().map(value => value.asNumber())).toEqual(beforeRect);
  } finally { await context.close(); }
});
test('cancelled simulated touch restores the field before a later drag', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field', { rotation: 0 }));
    await placeVisualSignature(page);
    const image = page.locator('[data-page-render-surface]').getByAltText('Signature');
    const initial = await image.boundingBox(), cdp = await context.newCDPSession(page);
    const start = { x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{x: start.x + 30, y: start.y + 10}] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect.poll(async () => (await image.boundingBox()).x).toBeCloseTo(initial.x, 0);
    const saved = await PDFDocument.load(await downloadPdf(page, 'touch-cancelled'));
    const annots = saved.getPages()[0].node.Annots().asArray().map(ref => saved.context.lookup(ref));
    expect(annots.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(0);
    expect(annots.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget')).get(PDFName.of('AP'))).toBeTruthy();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{x: start.x + 30, y: start.y + 10}] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect.poll(async () => (await image.boundingBox()).x).toBeGreaterThan(initial.x + 20);
  } finally { await context.close(); }
});
for (const mode of ['field', 'stamp']) {
  test(`${mode} signature appears before saving, after saving and after reopening`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await openPdf(page, await fixture(mode));
      await placeVisualSignature(page);
      await exportImages(page, expectAppearance);
      await expect(page.locator('[data-page-render-surface]').getByAltText('Signature')).toHaveCount(1);
      await expect.poll(() => signatureRegionDark(page.locator('[data-page-render-surface] canvas.pdf-canvas'))).toBe(0);
      const bytes = await downloadPdf(page, `${mode}-saved`);
      expectAppearance(await poppler(bytes, `${mode}-reference`), 'Poppler');
      await exportImages(page, expectAppearance);
      await expect.poll(() => signatureRegionDark(page.locator('[data-page-render-surface] canvas.pdf-canvas'))).toBe(0);
      const reopenedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      try {
        const reopened = await reopenedContext.newPage();
        await (await reopenedContext.newCDPSession(reopened)).send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await openPdf(reopened, bytes);
        await expect.poll(async () => (await canvasPixels(reopened)).dark).toBeGreaterThan(20);
        await exportImages(reopened, expectAppearance);
      } finally { await reopenedContext.close(); }
    } finally { await context.close(); }
  });
}

test('untracked native signature appearance is visible on the canvas and in image exports', async ({ page }) => {
  const bytes = await fixture('native');
  expectAppearance(await poppler(bytes, 'native-reference'), 'Poppler');
  await openPdf(page, bytes);
  await expect.poll(async () => (await canvasPixels(page)).dark).toBeGreaterThan(20);
  await exportImages(page, expectAppearance);
});

for (const mode of ['field', 'native']) {
  test(`${mode} signature field remains discoverable without a label over an appearance`, async ({ page }) => {
    await openPdf(page, await fixture(mode));
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const panel = page.locator('[data-keep-text-edit]').filter({ hasText: 'Options Panel' });
    const field = panel.getByRole('button', { name: /Signature1.*Sig/ });
    await expect(field).toBeVisible();
    const labelPixels = () => page.locator('[data-page-render-surface] canvas.absolute.top-0.left-0.z-10').evaluate(canvas => {
      const sx = canvas.width / 400, sy = canvas.height / 400;
      const data = canvas.getContext('2d').getImageData(Math.floor(103 * sx), Math.floor(172 * sy),
        Math.floor(100 * sx), Math.floor(9 * sy)).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 90 && data[i + 1] < 200 && data[i + 3] > 128) count++;
      return count;
    });
    if (mode === 'field') await expect.poll(labelPixels).toBeGreaterThan(5);
    else await expect.poll(labelPixels).toBe(0);
    await field.click();
    await expect(field).toBeVisible();
    if (mode === 'native') await expect.poll(labelPixels).toBe(0);
  });
}

for (const mode of ['field', 'native']) {
  test(`image drag preview ${mode === 'field' ? 'omits the live overlay appearance' : 'retains the native signature'}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await openPdf(page, await fixture(mode, { withImage: true }));
      if (mode === 'field') await placeVisualSignature(page);
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      const surface = page.locator('[data-page-render-surface]');
      await surface.click({ position: { x: 30, y: 50 } });
      const frame = surface.getByTitle('Replace image (keep size)').locator('..').locator('..');
      await expect(frame).toBeVisible();
      const box = await frame.boundingBox();
      if (!box) throw new Error('Missing image frame');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20);
      const background = surface.locator('div.absolute.inset-0.pointer-events-none > canvas:not(.pdf-canvas)');
      await expect(background).toHaveCount(1);
      if (mode === 'field') {
        await expect(surface.getByAltText('Signature')).toHaveCount(1);
        await expect.poll(() => signatureRegionDark(background)).toBe(0);
      } else {
        await expect.poll(() => signatureRegionDark(background)).toBeGreaterThan(20);
      }
      await page.mouse.up();
    } finally { await context.close(); }
  });
}

test('transparent signature appearance is painted once', async ({ page }) => {
  const bytes = await fixture('native', { transparent: true });
  const reference = await poppler(bytes, 'transparent-reference');
  expect(reference.center[0]).toBeGreaterThan(110);
  expect(reference.center[0]).toBeLessThan(145);
  await openPdf(page, bytes);
  const check = (result, label) => {
    for (const channel of result.center) {
      expect(channel, `${label} is painted once`).toBeGreaterThan(110);
      expect(channel, `${label} is painted once`).toBeLessThan(145);
    }
  };
  check(await canvasPixels(page), 'canvas');
  await exportImages(page, check);
});

test('cropped rotated signature appearance is retained in canvas and exports', async ({ page }) => {
  const bytes = await fixture('native', { rotated: true });
  const reference = await poppler(bytes, 'rotated-reference');
  expect([reference.width, reference.height]).toEqual([250, 300]);
  expectAppearance(reference, 'Poppler');
  await openPdf(page, bytes);
  const actual = await canvasPixels(page);
  expect([actual.width, actual.height]).toEqual([250, 300]);
  expectAppearance(actual, 'canvas');
  await exportImages(page, (result, label) => {
    expect(result.width / result.height).toBeCloseTo(250 / 300, 2);
    expectAppearance(result, label);
  });
});

test('signed PDF stays valid and byte-identical after image exports', async ({ page }) => {
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem'), p12 = join(directory, 'identity.p12');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=Paperloom Test', '-days', '1'], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12,
    '-passout', 'pass:test-only'], { stdio: 'ignore' });
  await openPdf(page, await fixture('field'));
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Import / manage certificates' }).click();
  await page.getByLabel('P12/PFX password (optional)').fill('test-only');
  await page.locator('input[accept*=".p12"]').setInputFiles(p12);
  await expect(page.getByText('Paperloom Test', { exact: false }).first()).toBeVisible();
  rmSync(key);
  rmSync(p12);
  await page.getByRole('button', { name: 'Close certificates' }).click();
  await page.getByRole('button', { name: 'Digitally sign document' }).click();
  await expect(page.getByRole('button', { name: /Signature1 Signed/ })).toBeVisible();
  await expect.poll(async () => (await canvasPixels(page)).dark).toBeGreaterThan(20);
  const before = await downloadPdf(page, 'signed-before');
  expectAppearance(await poppler(before, 'signed-reference'), 'Poppler');
  expect(execFileSync('pdfsig', [join(directory, 'signed-before.pdf')], { encoding: 'utf8' })).toContain('Signature is Valid');
  await exportImages(page, expectAppearance);
  const after = await downloadPdf(page, 'signed-after');
  expect(after).toEqual(before);
  expect(execFileSync('pdfsig', [join(directory, 'signed-after.pdf')], { encoding: 'utf8' })).toContain('Signature is Valid');
});

for (const mobile of [false, true]) test(`live field preview matches PNG appearance ${mobile ? 'mobile' : 'desktop'}`, async ({ browser }, testInfo) => {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field'));
    await placeVisualSignature(page);
    const surface = page.locator('[data-page-render-surface]');
    await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
    const panel = page.getByRole('dialog', { name: 'Export Document' });
    await panel.getByRole('button', { name: /^PNG Image/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Export as PNG Image' }).click()]);
    const png = readFileSync(await download.path());
    const raster = async bytes => {
      const img = await loadImage(bytes); const canvas = createCanvas(400, 400); const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 400, 400); return ctx.getImageData(103, 173, 194, 74).data;
    };
    const b = await raster(png);
    await panel.getByRole('button', { name: 'Close export panel' }).click();
    await expect.poll(async () => {
      const a = await raster(await surface.screenshot()); let delta = 0;
      for (let i = 0; i < a.length; i += 4) delta += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const mean = delta / (a.length / 4 * 3); console.log('FIELD_PREVIEW_MEAN_PIXEL_DELTA', mobile, mean); return mean;
    }).toBeLessThan(8);
    const livePath = testInfo.outputPath('live.png');
    const exportPath = testInfo.outputPath('export.png');
    await surface.screenshot({ path: livePath });
    writeFileSync(exportPath, png);
    await testInfo.attach('live', { path: livePath, contentType: 'image/png' });
    await testInfo.attach('export', { path: exportPath, contentType: 'image/png' });
  } finally { await context.close(); }
});

test('field appearance follows signature editing and undo without changing the PDF field value', async ({ browser }) => {
  test.setTimeout(30000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  try {
  const page = await context.newPage();
  await openPdf(page, await fixture('field'));
  await placeVisualSignature(page);
  const surface = page.locator('[data-page-render-surface]');
  const image = surface.getByAltText('Signature');
  await expect.poll(async () => image.evaluate(el => [el.naturalWidth, el.naturalHeight])).toEqual([200, 80]);
  const initialSource = await image.evaluate(el => el.currentSrc);
  const initialBox = await image.boundingBox();
  if (!initialBox) throw new Error('Missing signature overlay');
  await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(initialBox.x + initialBox.width / 2 + 35, initialBox.y + initialBox.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())?.x).toBeGreaterThan(initialBox.x + 25);
  await expect.poll(async () => image.evaluate(el => el.currentSrc)).not.toBe(initialSource);
  const moved = await PDFDocument.load(await downloadPdf(page, 'moved'));
  const annots = moved.getPages()[0].node.Annots().asArray().map(ref => moved.context.lookup(ref));
  expect(annots.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(1);
  const field = annots.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget'));
  expect(field.get(PDFName.of('V'))).toBeUndefined();
  expect(field.get(PDFName.of('AP'))).toBeUndefined();
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect.poll(async () => (await image.boundingBox())?.x).toBeCloseTo(initialBox.x, 0);
  await expect.poll(async () => image.evaluate(el => el.currentSrc)).toBe(initialSource);
  const undone = await PDFDocument.load(await downloadPdf(page, 'undone'));
  const afterUndo = undone.getPages()[0].node.Annots().asArray().map(ref => undone.context.lookup(ref));
  expect(afterUndo.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(0);
  const restored = afterUndo.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget'));
  expect(restored.get(PDFName.of('AP'))).toBeTruthy();
  expect(restored.get(PDFName.of('V'))).toBeUndefined();
  await image.locator('..').click();
  const handle = surface.locator('[data-handle="se"]');
  const h = await handle.boundingBox();
  if (!h) throw new Error('Missing signature resize handle');
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 30, h.y + h.height / 2 + 12, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())?.width).toBeGreaterThan(initialBox.width + 20);
  await page.getByTitle('Undo (Ctrl+Z)').click();
  await expect.poll(async () => image.evaluate(el => el.currentSrc)).toBe(initialSource);
  await expect.poll(async () => (await image.boundingBox())?.width).toBeCloseTo(initialBox.width, 0);
  await image.locator('..').click();
  await page.getByTitle('Delete', { exact: true }).click();
  await expect(image).toHaveCount(0);
  const removed = await PDFDocument.load(await downloadPdf(page, 'removed'));
  const finalField = removed.getPages()[0].node.Annots().asArray().map(ref => removed.context.lookup(ref)).find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget'));
  expect(finalField.get(PDFName.of('AP'))).toBeUndefined();
  expect(finalField.get(PDFName.of('V'))).toBeUndefined();
  } finally { await context.close(); }
});


test('field appearance survives local recovery after reload', async ({ browser }) => {
  test.setTimeout(30000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field'));
    await placeVisualSignature(page);
    const surface = page.locator('[data-page-render-surface]');
    const image = surface.getByAltText('Signature');
    await expect.poll(async () => image.evaluate(el => [el.naturalWidth, el.naturalHeight])).toEqual([200, 80]);
    const appearance = await image.evaluate(el => el.currentSrc);
    const recoveredSignatures = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('pdf-editor-db');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('pdf-files', 'readonly');
        const get = tx.objectStore('pdf-files').get('editor-session');
        get.onsuccess = () => resolve(get.result?.overlays?.signaturesJson ?? null);
        get.onerror = () => reject(get.error);
        tx.oncomplete = () => db.close();
      };
    }));
    await expect.poll(async () => JSON.parse((await recoveredSignatures()) ?? '[]').length, { timeout: 15000 }).toBe(1);
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(image).toHaveCount(1);
    await expect.poll(async () => image.evaluate(el => el.currentSrc)).toBe(appearance);
    await expect.poll(() => signatureRegionDark(surface.locator('canvas.pdf-canvas'))).toBe(0);
    const recovered = await PDFDocument.load(await downloadPdf(page, 'recovered'));
    const fields = recovered.getPages()[0].node.Annots().asArray().map(ref => recovered.context.lookup(ref));
    expect(fields.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(0);
    const field = fields.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget'));
    expect(field.get(PDFName.of('AP'))).toBeTruthy();
    expect(field.get(PDFName.of('V'))).toBeUndefined();
  } finally { await context.close(); }
});

test('cancelled signature creation leaves the field and saved document unchanged', async ({ page }) => {
  const original = await fixture('field', { omitModDate: true });
  expect(original.toString('latin1')).not.toMatch(/\/ModDate\b/);
  await openPdf(page, original);
  const before = await downloadPdf(page, 'cancel-before');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Cancelled');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-page-render-surface]').getByAltText('Signature')).toHaveCount(0);
  await page.waitForTimeout(2200);
  expect(await downloadPdf(page, 'cancelled')).toEqual(before);
});


test('oversized signature field preview does not hide the page or lose the edit', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
  try {
    const page = await context.newPage();
    await openPdf(page, await fixture('field', { largeField: true }));
    await placeVisualSignature(page);
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByText(/signature field preview unavailable/i)).toBeVisible();
    const canvas = page.locator('[data-page-render-surface] canvas.pdf-canvas');
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(element => element.width)).toBe(3200);
    await expect(page.locator('[data-page-render-surface]').getByAltText('Signature')).toHaveCount(0);
    const saved = await PDFDocument.load(await downloadPdf(page, 'large-signature'));
    const annotations = saved.getPages()[0].node.Annots().asArray().map(ref => saved.context.lookup(ref));
    const field = annotations.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget'));
    expect(field.get(PDFName.of('AP'))).toBeTruthy();
    expect(field.get(PDFName.of('V'))).toBeUndefined();
    expect(annotations.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(0);
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByText(/signature field preview unavailable/i)).toHaveCount(0);
    await expect(page.locator('[data-page-render-surface]').getByAltText('Signature')).toHaveCount(1);
  } finally { await context.close(); }
});

test('a failed field appearance raster does not hide the page or fall back to the library image', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  try {
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        if (window.failFieldPreview && this.width === 250 && this.height === 100) throw new Error('Injected preview failure');
        return original.apply(this, args);
      };
    });
    const page = await context.newPage();
    const original = await fixture('field', { omitModDate: true });
    expect(original.toString('latin1')).not.toMatch(/\/ModDate\b/);
    await openPdf(page, original);
    await placeVisualSignature(page);
    const surface = page.locator('[data-page-render-surface]');
    const before = await downloadPdf(page, 'preview-failure-before');
    await page.evaluate(() => { window.failFieldPreview = true; });
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByText(/signature field preview unavailable/i)).toBeVisible();
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await expect(surface.getByAltText('Signature')).toHaveCount(0);
    await page.waitForTimeout(2200);
    expect(await downloadPdf(page, 'preview-failure-after')).toEqual(before);
    await page.evaluate(() => { window.failFieldPreview = false; });
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByText(/signature field preview unavailable/i)).toHaveCount(0);
    await expect(surface.getByAltText('Signature')).toHaveCount(1);
  } finally { await context.close(); }
});
