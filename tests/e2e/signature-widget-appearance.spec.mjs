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

async function fixture(mode, { rotated = false, transparent = false, withImage = false } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  if (rotated) {
    page.setCropBox(50, 75, 300, 250);
    page.setRotation(degrees(90));
  }
  if (withImage) {
    const image = createCanvas(4, 4);
    image.getContext('2d').fillRect(0, 0, 4, 4);
    page.drawImage(await pdf.embedPng(image.toBuffer('image/png')), { x: 20, y: 340, width: 20, height: 20 });
  }
  if (mode !== 'stamp') {
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
      T: PDFString.of('Signature1'), Rect: [100, 150, 300, 230], F: 4, P: page.ref });
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

async function placeVisualSignature(page) {
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
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.525);
  await expect(surface.getByAltText('Signature')).toHaveCount(1);
  await expect.poll(() => signatureRegionDark(surface.locator('canvas.pdf-canvas'))).toBe(0);
}

const expectAppearance = (result, label) => expect(result.dark, `${label} signature appearance`).toBeGreaterThan(20);
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
