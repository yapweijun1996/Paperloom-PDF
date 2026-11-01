import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFileSync } from 'node:fs';

const makePdf = async field => {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([400, 400]); pdf.addPage([410, 410]); pdf.addPage([420, 420]);
  if (field) {
    const widget = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), Rect: [100,150,300,230], F: 4, P: first.ref });
    const ref = pdf.context.register(widget);
    first.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [ref] }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
};
async function save(page) {
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  return PDFDocument.load(readFileSync(await download.path()));
}
function signatures(pdf, index) {
  const annots = pdf.getPages()[index].node.Annots();
  return (annots?.asArray() ?? []).map(ref => pdf.context.lookup(ref)).filter(dict => ['Stamp','Widget'].some(type => dict.get(PDFName.of('Subtype')) === PDFName.of(type)));
}
const dimensions = pdf => pdf.getPages().map(page => page.getWidth());
async function removePage(page, index) {
  const buttons = page.getByRole('button', { name: 'Delete page', exact: true });
  await buttons.nth(index).scrollIntoViewIfNeeded();
  await buttons.nth(index).locator('..').hover();
  page.once('dialog', dialog => dialog.accept());
  await buttons.nth(index).click();
}

for (const field of [false, true]) test(`${field ? 'field' : 'stamp'}: locked page deletion is rejected, another page deletes, unlock permits deletion`, async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-three-pages.pdf', mimeType: 'application/pdf', buffer: await makePdf(field) });
  const surface = page.locator('[data-page-render-surface]');
  await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByRole('button', { name: 'Create signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByPlaceholder('Type your name').fill('Synthetic Signature');
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator('[draggable="true"]').filter({ has: page.getByText('This session only', { exact: true }) });
  if (field) await surface.locator('canvas.pdf-canvas').click({ position: { x: 200, y: 210 } });
  else await card.dragTo(surface, { targetPosition: { x: 200, y: 180 } });
  const signature = surface.getByAltText('Signature');
  await expect(signature).toHaveCount(1);
  await signature.click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  const before = await save(page);
  expect(dimensions(before)).toEqual([400,410,420]);
  expect(signatures(before, 0)).toHaveLength(1);
  const beforeRect = signatures(before,0)[0].get(PDFName.of('Rect')).toString();
  if (!field) {
    await page.getByRole('button', { name: 'Move page 1 later' }).click();
    await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
    const moved = await save(page);
    expect(dimensions(moved)).toEqual([410,400,420]);
    expect(signatures(moved,1)).toHaveLength(1);
    expect(signatures(moved,1)[0].get(PDFName.of('Rect')).toString()).toBe(beforeRect);
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await expect(page.getByText('1 / 3', { exact: true })).toBeVisible();
    const restored = await save(page);
    expect(dimensions(restored)).toEqual([400,410,420]);
    expect(signatures(restored,0)).toHaveLength(1);
    await signature.click();
    await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(3);
  await removePage(page, 0);
  await expect(page.getByText(/unlock signatures before deleting their page/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(3);
  const blocked = await save(page);
  expect(dimensions(blocked)).toEqual([400,410,420]);
  expect(signatures(blocked,0)).toHaveLength(1);
  expect(signatures(blocked,0)[0].get(PDFName.of('Rect')).toString()).toBe(beforeRect);
  expect(signatures(blocked,0)[0].get(PDFName.of('AP'))).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  await removePage(page, 1);
  await expect(page.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(2);
  const otherDeleted = await save(page);
  expect(dimensions(otherDeleted)).toEqual([400,420]);
  expect(signatures(otherDeleted,0)).toHaveLength(1);
  expect(signatures(otherDeleted,0)[0].get(PDFName.of('Rect')).toString()).toBe(beforeRect);
  const unlock = page.getByRole('button', { name: 'Unlock', exact: true });
  if (!await unlock.isVisible()) await signature.click();
  await unlock.click();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  await removePage(page, 0);
  await expect(page.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(0);
  const after = await save(page);
  expect(dimensions(after)).toEqual([420]);
  expect(signatures(after,0)).toHaveLength(0);
});
