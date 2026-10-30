import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFString } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory;
test.beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'paperloom-parent-signature-')); });
test.afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** Generate a real detached CMS signature whose /V belongs to the parent field. */
async function signedParentFixture(childNull) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const subtype = pdf.context.register(PDFName.of('Widget'));
  const widget = pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [50, 50, 250, 100], P: page.ref, F: 4 });
  if (childNull === 'direct') widget.set(PDFName.of('V'), PDFNull);
  if (childNull === 'indirect') widget.set(PDFName.of('V'), pdf.context.register(PDFNull));
  const widgetRef = pdf.context.register(widget);
  const signature = pdf.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(32768)) });
  const signatureRef = pdf.context.register(signature);
  const parent = pdf.context.obj({ FT: 'Sig', T: PDFString.of('ParentSig'), V: signatureRef, Kids: [widgetRef] });
  const parentRef = pdf.context.register(parent);
  widget.set(PDFName.of('Parent'), parentRef); page.node.addAnnot(widgetRef); pdf.getForm().acroForm.addField(parentRef);
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }));
  const text = bytes.toString('latin1');
  const range = /\/ByteRange\s*\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\]/.exec(text);
  const contents = /\/Contents\s*<([0]{32768})>/.exec(text);
  if (!range || !contents) throw new Error('Signature placeholders are missing');
  const start = contents.index + contents[0].indexOf('<');
  const end = start + contents[1].length + 2;
  const replacement = `/ByteRange [ 0 ${String(start).padStart(10, '0')} ${String(end).padStart(10, '0')} ${String(bytes.length - end).padStart(10, '0')} ]`;
  if (replacement.length !== range[0].length) throw new Error('Unexpected ByteRange width');
  bytes.write(replacement, range.index, 'ascii');
  const detached = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
  const file = name => join(directory, name);
  writeFileSync(file('detached.bin'), detached);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('key.pem'),
    '-out', file('cert.pem'), '-subj', '/CN=Paperloom Parent Test', '-days', '1'], { stdio: 'ignore' });
  execFileSync('openssl', ['cms', '-sign', '-binary', '-in', file('detached.bin'), '-signer', file('cert.pem'),
    '-inkey', file('key.pem'), '-outform', 'DER', '-out', file('signature.der'), '-nosmimecap', '-md', 'sha256'], { stdio: 'ignore' });
  const cms = readFileSync(file('signature.der')).toString('hex');
  if (cms.length > contents[1].length) throw new Error('Signature exceeds reserved space');
  bytes.write(cms.padEnd(contents[1].length, '0'), start + 1, 'ascii');
  rmSync(file('key.pem'));
  return bytes;
}

function verifyCms(bytes) {
  const text = bytes.toString('latin1');
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  const contents = /\/Contents\s*<([a-fA-F0-9]+)>/.exec(text);
  if (!range || !contents) throw new Error('Signed PDF ByteRange or Contents is missing');
  const [start1, length1, start2, length2] = range.slice(1).map(Number);
  writeFileSync(join(directory, 'verify-data.bin'), Buffer.concat([
    bytes.subarray(start1, start1 + length1), bytes.subarray(start2, start2 + length2),
  ]));
  writeFileSync(join(directory, 'verify-signature.der'), Buffer.from(contents[1], 'hex'));
  execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(directory, 'verify-signature.der'),
    '-content', join(directory, 'verify-data.bin'), '-noverify', '-out', join(directory, 'verified.bin')], { stdio: 'pipe' });
}

async function readOnlyFixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const subtype = pdf.context.register(PDFName.of('Widget'));
  const widget = pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [50, 50, 250, 100], P: page.ref, F: 4 });
  const widgetRef = pdf.context.register(widget);
  const parent = pdf.context.obj({ FT: 'Sig', T: PDFString.of('ReadOnlySig'), Ff: 1, Kids: [widgetRef] });
  const parentRef = pdf.context.register(parent);
  widget.set(PDFName.of('Parent'), parentRef); page.node.addAnnot(widgetRef); pdf.getForm().acroForm.addField(parentRef);
  return Buffer.from(await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

for (const childNull of ['absent', 'direct', 'indirect']) {
test(`a signed parent field with ${childNull} child value cannot be visually replaced`, async ({ browser }) => {
  const original = await signedParentFixture(childNull);
  verifyCms(original);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
    await page.locator('input[type=file]').setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: original });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).tap();
    await expect(page.getByRole('button', { name: /ParentSig Signed/ })).toBeVisible();
    await page.getByRole('button', { name: 'Create signature' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Create signature' });
    await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
    await dialog.getByPlaceholder('Type your name').fill('Replacement');
    await dialog.getByRole('button', { name: 'Save to library' }).tap();
    await expect(dialog).toHaveCount(0);
    await page.getByTitle('Hide panel').tap();
    await surface.scrollIntoViewIfNeeded();
    await surface.tap({ position: { x: 150, y: 325 } });
    await expect(page.getByText('This signature field is already signed or read-only.', { exact: true })).toBeVisible();
    await expect(surface.getByAltText('Signature')).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').tap()]);
    const saved = readFileSync(await download.path());
    expect(saved).toEqual(original);
    verifyCms(saved);
  } finally { await context.close(); }
});
}

test('an inherited read-only signature field cannot receive a visual signature', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Open a PDF file' })).toHaveAttribute('aria-disabled', 'false');
    await page.locator('input[type=file]').setInputFiles({ name: 'readonly.pdf', mimeType: 'application/pdf', buffer: await readOnlyFixture() });
    const surface = page.locator('[data-page-render-surface]');
    await expect(surface.locator('canvas.pdf-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).tap();
    await page.getByRole('button', { name: 'Create signature' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Create signature' });
    await dialog.getByRole('button', { name: 'Type', exact: true }).tap();
    await dialog.getByPlaceholder('Type your name').fill('Replacement');
    await dialog.getByRole('button', { name: 'Save to library' }).tap();
    await expect(dialog).toHaveCount(0);
    await page.getByTitle('Hide panel').tap();
    await surface.scrollIntoViewIfNeeded();
    await surface.tap({ position: { x: 150, y: 325 } });
    await expect(page.getByText('This signature field is already signed or read-only.', { exact: true })).toBeVisible();
    await expect(surface.getByAltText('Signature')).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByTitle('Download original / edited PDF (no recompression)').tap()]);
    const saved = await PDFDocument.load(readFileSync(await download.path()));
    const parent = saved.getForm().acroForm.getFields()[0][0].dict;
    const widget = saved.context.lookup(parent.lookup(PDFName.of('Kids')).get(0));
    expect(parent.has(PDFName.of('V'))).toBe(false);
    expect(widget.has(PDFName.of('AP'))).toBe(false);
  } finally { await context.close(); }
});
