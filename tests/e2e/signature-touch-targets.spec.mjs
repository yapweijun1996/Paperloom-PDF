import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { join } from 'node:path';

async function openSignedPage(page, { field = false, captureCollapsed = false } = {}) {
  const pdf = await PDFDocument.create(); const pdfPage = pdf.addPage([400, 400]);
  if (field) {
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'),
      Rect: [100, 150, 300, 230], F: 4, P: pdfPage.ref });
    const ref = pdf.context.register(widget);
    pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
  }
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).tap();
  await page.getByRole('button', { name: 'Create signature' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
  await dialog.getByPlaceholder('Type your name').fill('Alex Example');
  await dialog.getByRole('button', { name: 'Save to library' }).tap();
  await expect(dialog).toHaveCount(0);
  await page.getByTitle('Hide panel').tap();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  const viewport = page.viewportSize();
  await page.touchscreen.tap(box.x + box.width / 2, Math.min(box.y + box.height / 2, viewport.height - 110));
  const image = surface.getByAltText('Signature');
  await expect(image).toHaveCount(1);
  await image.tap();
  await expect(page.getByRole('button', { name: 'Show signature resize and rotation controls' })).toBeVisible();
  if (captureCollapsed && process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'signature-phone-collapsed.png') });
  await page.getByRole('button', { name: 'Show signature resize and rotation controls' }).tap();
  await expect(page.locator('[data-touch-handle]')).toHaveCount(9);
  return { surface, image };
}

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['landscape', { width: 568, height: 320 }], ['tablet', { width: 768, height: 1024 }]]) {
  test(`coarse signature controls have reachable 44px targets ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const { image } = await openSignedPage(page, { captureCollapsed: name === 'phone' });
      const controls = page.locator('.signature-touch-panel');
      const panel = await controls.boundingBox(), signature = await image.boundingBox();
      const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlaps(panel, signature)).toBe(false);
      for (const target of [page.getByRole('button', { name: 'Zoom out' }), page.getByRole('button', { name: 'Sign', exact: true })]) {
        const box = await target.boundingBox();
        if (box) expect(overlaps(panel, box)).toBe(false);
      }
      const handles = controls.locator('[data-touch-handle]');
      const sizes = await handles.evaluateAll(elements => elements.map(el => ({ id: el.getAttribute('data-touch-handle'), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
      console.log(`TOUCH_TARGETS ${name} coarse=${await page.evaluate(() => matchMedia('(pointer: coarse)').matches)} handles=${JSON.stringify(sizes)}`);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      expect(sizes).toHaveLength(9);
      expect(sizes.every(item => item.w >= 44 && item.h >= 44)).toBe(true);
      for (const handle of await handles.all()) {
        const box = await handle.boundingBox(), id = await handle.getAttribute('data-touch-handle');
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        for (const dx of [3, 22, 41]) for (const dy of [3, 22, 41]) {
          const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-touch-handle]')?.getAttribute('data-touch-handle'), [box.x + dx, box.y + dy]);
          expect(hit, `${name} ${id} at ${dx},${dy}`).toBe(id);
        }
      }
      for (const button of await controls.locator('button').all()) {
        const box = await button.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, `signature-${name}.png`) });
      await page.getByRole('button', { name: 'Hide signature controls' }).tap();
      await expect(page.getByRole('button', { name: 'Show signature resize and rotation controls' })).toBeVisible();
      await expect(handles.first()).toBeHidden();
      await page.getByRole('button', { name: 'Show signature resize and rotation controls' }).tap();
      await expect(handles.first()).toBeVisible();
    } finally { await context.close(); }
  });
}

async function touchDrag(page, target, dx, dy, cancel = false) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Touch target is not visible');
  // Exercise the enlarged target away from its center.
  const x = box.x + 8, y = box.y + 8;
  const cdp = await page.context().newCDPSession(page);
  try {
    const point = (px, py) => [{ x: px, y: py, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
    for (let i = 1; i <= 4; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + dx * i / 4, y + dy * i / 4) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}

async function signaturePdf(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const { readFileSync } = await import('node:fs');
  return PDFDocument.load(readFileSync(await download.path()));
}

test('all touch resize controls work independently, cancel safely and save', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { surface, image } = await openSignedPage(page);
    const controls = page.locator('.signature-touch-panel');
    let before = await image.boundingBox();
    await touchDrag(page, controls.locator('[data-touch-handle="e"]'), 20, 0, true);
    await expect.poll(async () => (await image.boundingBox()).width).toBeCloseTo(before.width, 1);
    const directions = [['nw', -12, -12], ['n', 0, -12], ['ne', 12, -12], ['w', -12, 0],
      ['e', 12, 0], ['sw', -12, 12], ['s', 0, 12], ['se', 12, 12]];
    for (const [name, dx, dy] of directions) {
      before = await image.boundingBox();
      await touchDrag(page, controls.locator(`[data-touch-handle="${name}"]`), dx, dy);
      if (dx) await expect.poll(async () => (await image.boundingBox()).width, { message: `${name} changes width` }).toBeGreaterThan(before.width + 2);
      if (dy) await expect.poll(async () => (await image.boundingBox()).height, { message: `${name} changes height` }).toBeGreaterThan(before.height + 2);
      const after = await image.boundingBox();
      const angle = await image.locator('..').evaluate(el => {
        const matrix = new DOMMatrix(getComputedStyle(el).transform);
        return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
      });
      expect(angle, `${name} must not rotate the signature`).toBeCloseTo(0, 1);
      if (dx > 0) expect(after.x).toBeCloseTo(before.x, 0);
      if (dx < 0) expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);
      if (dy > 0) expect(after.y).toBeCloseTo(before.y, 0);
      if (dy < 0) expect(after.y + after.height).toBeCloseTo(before.y + before.height, 0);
    }
    const result = await signaturePdf(page), { PDFName } = await import('pdf-lib');
    const stamps = result.getPages()[0].node.Annots().asArray().map(ref => result.context.lookup(ref))
      .filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
    expect(stamps).toHaveLength(1);
    const rect = stamps[0].lookup(PDFName.of('Rect')).asArray().map(v => v.asNumber());
    const rendered = await image.boundingBox(), pageBox = await surface.boundingBox();
    expect(rect[2] - rect[0]).toBeCloseTo(rendered.width, 0);
    expect(rect[3] - rect[1]).toBeCloseTo(rendered.height, 0);
    expect(rect[0]).toBeCloseTo(rendered.x - pageBox.x, 0);
    expect(rect[3]).toBeCloseTo(400 - (rendered.y - pageBox.y), 0);
  } finally { await context.close(); }
});

test('touch rotation uses horizontal incremental motion and supports cancellation', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const rotation = page.locator('[data-touch-handle="rotate"]');
    const transform = () => image.locator('..').evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    });
    const before = await transform();
    await touchDrag(page, rotation, 1, 0, true);
    await expect.poll(transform).toBe(before);
    await touchDrag(page, rotation, 20, 0);
    await expect.poll(transform).toBeCloseTo(20, 0);
    await page.getByTitle('Undo (Ctrl+Z)').tap();
    await expect.poll(transform).toBeCloseTo(0, 0);
  } finally { await context.close(); }
});

test('touch controls support arrow keys, Enter and Space with undo', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const east = page.locator('[data-touch-handle="e"]');
    for (const key of ['ArrowRight', 'Enter', 'Space']) {
      const before = (await image.boundingBox()).width;
      await east.focus();
      await page.keyboard.press(key);
      await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(before + 0.5);
    }
    const before = (await image.boundingBox()).width;
    await page.getByTitle('Undo (Ctrl+Z)').tap();
    await expect.poll(async () => (await image.boundingBox()).width).toBeLessThan(before - 0.5);
  } finally { await context.close(); }
});

test('rapid keyboard increments queue against the latest signature while image decoding is delayed', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.__holdImages = false; window.__pendingImages = [];
      Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) {
        if (window.__holdImages && !this.isConnected && value.startsWith('data:image/')) {
          window.__pendingImages.push(() => descriptor.set.call(this, value));
        } else descriptor.set.call(this, value);
      } });
      window.__releaseImages = () => { window.__holdImages = false; window.__pendingImages.splice(0).forEach(fn => fn()); };
    });
    const beforeWidth = (await image.boundingBox()).width, east = page.locator('[data-touch-handle="e"]');
    await page.evaluate(() => { window.__holdImages = true; });
    await east.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__pendingImages.length)).toBe(1);
    expect((await image.boundingBox()).width).toBeCloseTo(beforeWidth, 1);
    await page.evaluate(() => window.__releaseImages());
    await expect.poll(async () => (await image.boundingBox()).width).toBeCloseTo(beforeWidth + 2, 0);
    const rotation = page.locator('[data-touch-handle="rotate"]');
    await page.evaluate(() => { window.__holdImages = true; });
    await rotation.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__pendingImages.length)).toBe(1);
    await page.evaluate(() => window.__releaseImages());
    await expect.poll(async () => image.locator('..').evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    })).toBeCloseTo(-30, 0);
  } finally { await context.close(); }
});

test('irrelevant-axis keyboard input does not dirty or convert a field signature', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page, { field: true });
    await signaturePdf(page);
    await page.getByTitle('Toggle Find & Replace').tap();
    await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
    await page.locator('[data-touch-handle="n"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
    const saved = await signaturePdf(page);
    const annots = saved.getPages()[0].node.Annots().asArray().map(ref => saved.context.lookup(ref));
    expect(annots.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(0);
    expect(annots.find(a => a.get(PDFName.of('Subtype')) === PDFName.of('Widget')).get(PDFName.of('AP'))).toBeTruthy();
    await page.getByTitle('Close Search').tap();
    await page.getByTitle('Undo (Ctrl+Z)').tap();
    await expect(image).toHaveCount(0);
  } finally { await context.close(); }
});

for (const cancelPrimary of [false, true]) test(`a second touch and click without pointerId cannot delete during ${cancelPrimary ? 'cancel' : 'drag'}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const east = page.locator('[data-touch-handle="e"]'), del = page.getByRole('button', { name: 'Delete signature' });
    const a = await east.boundingBox(), b = await del.boundingBox();
    const first = { x: a.x + 8, y: a.y + 8, id: 1 }, second = { x: b.x + 8, y: b.y + 8, id: 2 };
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
      if (cancelPrimary) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await del.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
      await expect(image).toHaveCount(1);
      if (!cancelPrimary) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [first] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
    } finally { await cdp.detach(); }
    await expect(image).toHaveCount(1);
    await del.tap();
    await expect(image).toHaveCount(0);
  } finally { await context.close(); }
});

for (const focus of ['control', 'toolbar']) test(`keyboard input at ${focus} during a captured touch gesture cannot overwrite its resize`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const east = page.locator('[data-touch-handle="e"]'), box = await east.boundingBox();
    const original = (await image.boundingBox()).width;
    if (focus === 'control') await east.focus();
    else await page.getByTitle('Undo (Ctrl+Z)').focus();
    const cdp = await context.newCDPSession(page);
    const start = { x: box.x + 8, y: box.y + 8, id: 1 };
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await expect(page.getByRole('group', { name: 'Signature touch controls' })).toHaveAttribute('aria-busy', 'true');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+z');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: start.x + 10 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    await expect(page.getByRole('group', { name: 'Signature touch controls' })).toHaveAttribute('aria-busy', 'false');
    await expect.poll(async () => (await image.boundingBox()).width).toBeCloseTo(original + 10, 0);
  } finally { await context.close(); }
});

test('low-zoom signature at the page edge stays editable with the separate controls', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { surface, image } = await openSignedPage(page);
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 4 && await zoomOut.isEnabled(); i++) await zoomOut.tap();
    await expect(zoomOut).toBeDisabled();
    const pageBox = await surface.boundingBox(), imageBox = await image.boundingBox();
    const dx = pageBox.x + 5 - (imageBox.x + imageBox.width / 2);
    const dy = pageBox.y + 5 - (imageBox.y + imageBox.height / 2);
    await touchDrag(page, page.getByRole('button', { name: 'Move signature; drag or use arrow keys' }), dx, dy);
    await expect.poll(async () => {
      const rect = await image.boundingBox(); return rect.x + rect.width / 2;
    }).toBeCloseTo(pageBox.x + 5, 0);
    const before = (await image.boundingBox()).width;
    await touchDrag(page, page.locator('[data-touch-handle="e"]'), 12, 0);
    await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(before + 10);
    if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'signature-edge-lowzoom.png') });
    const pdf = await signaturePdf(page);
    const annots = pdf.getPages()[0].node.Annots().asArray().map(ref => pdf.context.lookup(ref));
    expect(annots.filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Stamp'))).toHaveLength(1);
  } finally { await context.close(); }
});

test('horizontal rotation remains stable when the signature overlaps its control', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const rotate = page.locator('[data-touch-handle="rotate"]'), control = await rotate.boundingBox();
    const current = await image.boundingBox();
    const dx = (control.x + control.width / 2 - current.x - current.width / 2) / 2;
    const dy = (control.y + control.height / 2 - current.y - current.height / 2) / 2;
    const move = page.getByRole('button', { name: 'Move signature; drag or use arrow keys' });
    await touchDrag(page, move, dx, dy); await touchDrag(page, move, dx, dy);
    await expect.poll(async () => {
      const rect = await image.boundingBox();
      return Math.hypot(control.x + control.width / 2 - rect.x - rect.width / 2,
        control.y + control.height / 2 - rect.y - rect.height / 2);
    }).toBeLessThan(2);
    await touchDrag(page, rotate, 1, 0);
    await expect.poll(async () => image.locator('..').evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    })).toBeCloseTo(1, 0);
  } finally { await context.close(); }
});

test('touch resize of a rotated signature holds the opposite visual corner', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    await touchDrag(page, page.locator('[data-touch-handle="rotate"]'), 20, 0);
    const anchor = () => image.locator('..').evaluate(el => {
      const rect = el.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(el).transform);
      const angle = Math.atan2(matrix.b, matrix.a), w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      return { x: rect.left + rect.width / 2 - Math.cos(angle) * w / 2 + Math.sin(angle) * h / 2,
        y: rect.top + rect.height / 2 - Math.sin(angle) * w / 2 - Math.cos(angle) * h / 2 };
    });
    await expect.poll(async () => image.locator('..').evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform); return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    })).toBeCloseTo(20, 0);
    const before = await anchor(), width = (await image.boundingBox()).width;
    await touchDrag(page, page.locator('[data-touch-handle="se"]'), 20, 10);
    await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(width + 5);
    const after = await anchor();
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  } finally { await context.close(); }
});

test('fine-pointer desktop keeps its original handles and mouse gestures', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([400, 400]);
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Alex Example');
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator('[draggable="true"]').filter({ has: page.getByText('This session only', { exact: true }) });
  await card.dragTo(surface, { targetPosition: { x: 200, y: 180 } });
  const image = surface.getByAltText('Signature');
  await image.click();
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  await expect(page.locator('.signature-touch-panel')).toBeHidden();
  await expect(surface.locator('[data-handle]')).toHaveCount(8);
  const east = surface.locator('[data-handle="e"]'), handle = await east.boundingBox(), before = await image.boundingBox();
  expect(handle.width).toBe(10); expect(handle.height).toBe(10);
  await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down();
  await page.mouse.move(handle.x + 25, handle.y + 5, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(before.width + 15);
  if (process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR) await page.screenshot({ path: join(process.env.PAPERLOOM_LAYOUT_CAPTURE_DIR, 'signature-desktop.png') });
});

test('locked signature exposes no touch edits or deletion', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    await page.getByRole('button', { name: 'Sign', exact: true }).tap();
    await page.getByRole('button', { name: 'Lock', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
    await page.getByTitle('Hide panel').tap();
    await expect(page.getByRole('button', { name: 'Move signature; drag or use arrow keys' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Rotate signature 15 degrees' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete signature' })).toBeDisabled();
    await expect(page.locator('[data-touch-handle]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deselect signature' })).toBeEnabled();
    await expect(image).toHaveCount(1);
  } finally { await context.close(); }
});

for (const method of ['mouse', 'keyboard']) test(`a cancelled multi-touch gesture does not block the next ${method} action`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const east = page.locator('[data-touch-handle="e"]'), del = page.getByRole('button', { name: 'Delete signature' });
    const a = await east.boundingBox(), b = await del.boundingBox(), cdp = await context.newCDPSession(page);
    try {
      const first = { x: a.x + 8, y: a.y + 8, id: 1 }, second = { x: b.x + 8, y: b.y + 8, id: 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } finally { await cdp.detach(); }
    await expect(image).toHaveCount(1);
    if (method === 'mouse') await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    else { await del.focus(); await page.keyboard.press('Enter'); }
    await expect(image).toHaveCount(0);
  } finally { await context.close(); }
});

for (const reason of ['lost capture', 'window blur', 'deselect']) test(`interrupted touch resize cancels on ${reason} and releases keyboard`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), { image } = await openSignedPage(page);
    const east = page.locator('[data-touch-handle="e"]'), box = await east.boundingBox();
    const original = (await image.boundingBox()).width;
    const cdp = await context.newCDPSession(page);
    const start = { x: box.x + 8, y: box.y + 8, id: 1 };
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: start.x + 20 }] });
      await expect.poll(async () => (await image.boundingBox()).width).toBeCloseTo(original + 20, 0);
      if (reason === 'lost capture') {
        await east.evaluate(el => {
          for (let id = 1; id < 20; id++) if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
        });
        // Browsers dispatch lostpointercapture when processing the next pointer event.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: start.x + 21 }] });
      }
      if (reason === 'window blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (reason === 'deselect') await page.getByTitle('Deselect', { exact: true }).first().evaluate(el => el.click());
      await expect.poll(async () => (await image.boundingBox()).width).toBeCloseTo(original, 0);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    if (reason === 'deselect') {
      await image.tap();
      if (await page.getByRole('button', { name: 'Show signature resize and rotation controls' }).isVisible())
        await page.getByRole('button', { name: 'Show signature resize and rotation controls' }).tap();
    }
    const rotate = page.getByRole('button', { name: 'Rotate signature 15 degrees' });
    await rotate.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => image.evaluate(el => el.parentElement.style.transform)).toContain('15deg');
    const current = (await image.boundingBox()).width;
    await touchDrag(page, page.locator('[data-touch-handle="e"]'), 10, 0);
    await expect.poll(async () => (await image.boundingBox()).width).not.toBeCloseTo(current, 0);
  } finally { await context.close(); }
});
