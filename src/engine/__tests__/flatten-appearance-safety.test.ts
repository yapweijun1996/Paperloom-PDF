import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPageContentBytes, parsePDF, resolveRef } from '../parser/parser';
import { rawPDF } from './audit-p1-fixtures';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { flattenFormFieldsOnPage, setFormFieldValue } from '../forms/apply-field';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 220]);
  page.drawText('BACKGROUND', { x: 15, y: 190, size: 12, color: rgb(0, 0, 0) });
  const form = pdf.getForm();
  const field = form.createTextField('Name');
  field.addToPage(page, { x: 40, y: 130, width: 140, height: 25 });
  field.setText('CORPUSALPHA');
  const check = form.createCheckBox('Consent');
  check.addToPage(page, { x: 45, y: 75, width: 20, height: 20 });
  check.check();
  const radio = form.createRadioGroup('Choice');
  radio.addOptionToPage('A', page, { x: 100, y: 75, width: 20, height: 20 });
  radio.addOptionToPage('B', page, { x: 150, y: 75, width: 20, height: 20 });
  radio.select('B');
  form.updateFieldAppearances(await pdf.embedFont(StandardFonts.Helvetica));
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
async function render(file: string, dir: string, name: string) {
  const output = join(dir, name);
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, output], { stdio: 'pipe' });
  const image = await loadImage(readFileSync(`${output}.png`));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
}

describe('flatten form appearances', () => {
  it.skipIf(!poppler)('retains text, checkbox, and radio appearances in the saved PDF', async () => {
    const doc = await fixture();
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-flatten-'));
    try {
      const before = join(dir, 'before.pdf'), after = join(dir, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      const original = await render(before, dir, 'before');
      await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
      writeFileSync(after, await serializeDocument(doc));
      const flattened = await render(after, dir, 'after');
      expect(flattened).toEqual(original);
      const text = execFileSync('pdftotext', ['-raw', after, '-'], { encoding: 'utf8' });
      expect(text).toContain('CORPUSALPHA');
      expect(text).toContain('BACKGROUND');
      expect(detectFormFieldsOnPage(await parsePDF(readFileSync(after)), 0)).toEqual([]);
      const independentlyOpened = await PDFDocument.load(readFileSync(after), { updateMetadata: false });
      expect(independentlyOpened.getForm().getFields()).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!poppler)('preserves a rotated appearance matrix with Poppler', async () => {
    const doc = await fixture();
    const name = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'Name')!;
    const ap = resolveRef(name.dict.get('AP')!, doc.objects) as PDFDict;
    const stream = resolveRef(ap.get('N')!, doc.objects);
    if (!(stream && 'dict' in stream)) throw new Error('Expected appearance stream');
    const bbox = stream.dict.getArray('BBox')!.asNumbers();
    stream.dict.set('Matrix', new PDFArray([0, 1, -1, 0, bbox[3] - bbox[1], 0].map(n => new PDFNumber(n))));
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-flatten-matrix-'));
    try {
      const before = join(dir, 'before.pdf'), after = join(dir, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      const original = await render(before, dir, 'before');
      await flattenFormFieldsOnPage(doc, 0, [name]);
      writeFileSync(after, await serializeDocument(doc));
      const actual = await render(after, dir, 'after');
      let edgeDifferences = 0;
      for (let i = 0; i < actual.length; i += 4) {
        if (actual[i] === original[i] && actual[i + 1] === original[i + 1] && actual[i + 2] === original[i + 2]) continue;
        const x = (i / 4) % 300, y = Math.floor(i / 4 / 300);
        // Poppler rounds the transformed appearance clip on the top edge;
        // all interior and surrounding pixels must remain identical.
        expect(x >= 40 && x <= 180 && (y === 64 || y === 65)).toBe(true);
        edgeDifferences++;
      }
      expect(edgeDifferences).toBeLessThanOrEqual(300);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a real signed signature field without changing its original bytes', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 10, y: 10, width: 80, height: 30 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    const widget = detectFormFieldsOnPage(reopened, 0).find(item => item.fieldName === 'Signer')!;
    await expect(flattenFormFieldsOnPage(reopened, 0, [widget])).rejects.toThrow(/signed/i);
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const validation = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(validation.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it.each([false, true])('refuses a stale text appearance when NeedAppearances is %s', async includeFalse => {
    const doc = await fixture();
    const name = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'Name')!;
    const owner = resolveRef(name.dict.get('Parent')!, doc.objects) as PDFDict;
    owner.set('V', new PDFString('LATESTVALUE'));
    const acro = resolveRef(doc.catalog.get('AcroForm')!, doc.objects) as PDFDict;
    if (includeFalse) acro.set('NeedAppearances', new PDFBoolean(false));
    else acro.delete('NeedAppearances');
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0))).rejects.toThrow(/appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a checkbox whose appearance state disagrees with its field value', async () => {
    const doc = await fixture();
    const check = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'Consent')!;
    check.dict.set('AS', new PDFName('Off'));
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0))).rejects.toThrow(/appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('does not equate different spaces in the value and appearance', async () => {
    const doc = await fixture();
    const name = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'Name')!;
    setFormFieldValue(doc, name, 'A B');
    const owner = resolveRef(name.dict.get('Parent')!, doc.objects) as PDFDict;
    owner.set('V', new PDFString('A  B'));
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0))).rejects.toThrow(/appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('does not insert field names into synthesized PDF operators', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>',
      '<< /Length 0 >>\nstream\nendstream',
      '<< /Type /Annot /Subtype /Widget /F 4 /FT /Tx /T (unsafe\\n1 0 0 rg) /Rect [10 10 90 30] /V (SAMPLE) >>',
    ]));
    await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
    const reopened = await parsePDF(await serializeDocument(doc));
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('unsafe');
    expect(content).not.toContain('1 0 0 rg');
    expect(content).toContain('(SAMPLE)');
  });

  it.skipIf(!poppler)('preserves an existing conflicting page font when synthesizing an appearance', async () => {
    const content = 'BT /PaperloomFlattenFont 12 Tf 10 60 Td (ORIGINAL) Tj ET';
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Resources << /Font << /PaperloomFlattenFont << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents 4 0 R /Annots [5 0 R] >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Annot /Subtype /Widget /F 4 /FT /Tx /T (Simple) /Rect [10 10 110 30] /V (VALUE) >>',
    ]));
    await flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0));
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-flatten-font-'));
    try {
      const file = join(dir, 'output.pdf');
      writeFileSync(file, await serializeDocument(doc));
      const text = execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' });
      expect(text).toContain('ORIGINAL');
      expect(text).toContain('VALUE');
      const reopened = await parsePDF(readFileSync(file));
      const fonts = resolveRef(reopened.pages[0].resources.get('Font')!, reopened.objects) as PDFDict;
      expect((resolveRef(fonts.get('PaperloomFlattenFont')!, reopened.objects) as PDFDict).getName('BaseFont')).toBe('Courier');
      expect((resolveRef(fonts.get('PaperloomFlattenFont1')!, reopened.objects) as PDFDict).getName('BaseFont')).toBe('Helvetica');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed geometry on a widget without an appearance', async () => {
    const doc = await fixture();
    const name = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'Name')!;
    name.dict.delete('AP');
    name.dict.delete('Rect');
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, [name])).rejects.toThrow(/geometry|appearance/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects stale effective page resources without modifying the document', async () => {
    const doc = await fixture();
    doc.pages[0].resources = new PDFDict();
    const before = await serializeDocument(doc);
    await expect(flattenFormFieldsOnPage(doc, 0, detectFormFieldsOnPage(doc, 0))).rejects.toThrow(/resources|resource cache/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['missing state', 'degenerate BBox', 'unsupported flags', 'missing print flag', 'disabled print flag', 'need appearances'] as const)(
    'rejects %s without modifying the document', async mode => {
      const doc = await fixture();
      const widgets = detectFormFieldsOnPage(doc, 0);
      const check = widgets.find(widget => widget.fieldName === 'Consent')!;
      const ap = resolveRef(check.dict.get('AP')!, doc.objects) as PDFDict;
      const states = resolveRef(ap.get('N')!, doc.objects) as PDFDict;
      if (mode === 'missing state') check.dict.set('AS', new PDFName('Missing'));
      if (mode === 'degenerate BBox') {
        const stream = resolveRef(states.get(check.appearanceState!)!, doc.objects);
        if (!(stream && 'dict' in stream)) throw new Error('Expected appearance stream');
        stream.dict.set('BBox', new PDFArray([0, 0, 0, 20].map(value => new PDFNumber(value))));
      }
      if (mode === 'unsupported flags') check.dict.set('F', new PDFNumber(12));
      if (mode === 'missing print flag') check.dict.delete('F');
      if (mode === 'disabled print flag') check.dict.set('F', new PDFNumber(0));
      if (mode === 'need appearances') {
        const acro = resolveRef(doc.catalog.get('AcroForm')!, doc.objects) as PDFDict;
        acro.set('NeedAppearances', new PDFBoolean(true));
      }
      const before = await serializeDocument(doc);
      await expect(flattenFormFieldsOnPage(doc, 0, widgets)).rejects.toThrow(/flatten|appearance/i);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );
});
