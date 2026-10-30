import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, PDFName as LibName, PDFString as LibString, StandardFonts } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { setFormFieldValue } from '../forms/apply-field';
import { setButtonFieldValue, setChoiceFieldValue } from '../forms/widget-appearances';
import { renderPage } from '../render/renderer';
import { serializeDocument } from '../writer/serializer';
import { detectSignatureFieldsOnPage } from '../signatures/fields/signature-field';
import { findVisualSignatureRefs, removeVisualSignature } from '../session/signature-edit';
import { signDocumentTransaction } from '../session/signature-transaction';
import { PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, PDFString } from '../types';
import { rawPDF } from './audit-p1-fixtures';

async function fixture(indirect = true) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  const push = form.createButton('Push'); push.addToPage('Push', page, { x: 40, y: 430, width: 160, height: 30, font });
  const text = form.createTextField('Text'); text.addToPage(page, { x: 40, y: 360, width: 160, height: 30, font }); text.setText('BEFORE');
  const checkbox = form.createCheckBox('Checkbox'); checkbox.addToPage(page, { x: 40, y: 290, width: 30, height: 30 });
  const radio = form.createRadioGroup('Radio'); radio.addOptionToPage('One', page, { x: 40, y: 220, width: 30, height: 30 });
  radio.addOptionToPage('Two', page, { x: 100, y: 220, width: 30, height: 30 }); radio.select('One');
  const choice = form.createDropdown('Choice'); choice.addOptions(['Alpha', 'Bravo']); choice.select('Alpha');
  choice.addToPage(page, { x: 40, y: 145, width: 160, height: 30, font });
  const sig = pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: LibString.of('Signature'),
    Rect: [40, 40, 200, 100], F: 4, P: page.ref, PaperloomSignatureId: LibString.of('signature-id') });
  const sigRef = pdf.context.register(sig); page.node.addAnnot(sigRef); form.acroForm.addField(sigRef);
  if (indirect) {
    const subtype = pdf.context.register(LibName.of('Widget'));
    for (const field of [push, text, checkbox, radio, choice]) {
      for (const widget of field.acroField.getWidgets()) widget.dict.set(LibName.of('Subtype'), subtype);
    }
    sig.set(LibName.of('Subtype'), subtype);
  }
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

function installCanvas() {
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
}
afterEach(() => vi.unstubAllGlobals());

describe('indirect widget subtype', () => {
  it('does not inspect unrelated malformed annotation subtypes when searching signatures', async () => {
    const doc = await fixture(false);
    const widget = detectFormFieldsOnPage(doc, 0).find(w => w.fieldName === 'Push')!;
    const cycle = new PDFRef(4002, 0);
    doc.objects.set(cycle.toKey(), cycle);
    widget.dict.set('Subtype', cycle);
    expect(findVisualSignatureRefs(doc, new Set()).size).toBe(0);
    expect(findVisualSignatureRefs(doc, new Set(['other'])).size).toBe(0);
    widget.dict.set('PaperloomSignatureId', new PDFString('matching'));
    expect(() => findVisualSignatureRefs(doc, new Set(['matching']))).toThrow(/cyclic/i);
  });

  it.each([false, true])('recognizes a signed parent value, indirect subtype=%s', async indirect => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Annots [5 0 R] >>',
      '<< /FT /Sig /T (ParentSig) /V 6 0 R /Kids [5 0 R] >>',
      `<< /Type /Annot /Subtype ${indirect ? '7 0 R' : '/Widget'} /Parent 4 0 R /Rect [50 50 250 100] /P 3 0 R /F 4 >>`,
      '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 1 2 3] /Contents <0102> >>',
      '/Widget',
    ]));
    const fields = detectSignatureFieldsOnPage(doc, 0);
    expect(fields).toHaveLength(1);
    expect(fields[0].signed).toBe(true);
    expect(fields[0].valueRef?.toKey()).toBe('6_0');
    const widget = fields[0].widget.dict;
    widget.set('V', PDFNull.instance);
    expect(detectSignatureFieldsOnPage(doc, 0)[0].valueRef?.toKey()).toBe('6_0');
    const nullRef = new PDFRef(4005, 0); doc.objects.set(nullRef.toKey(), PDFNull.instance);
    widget.set('V', nullRef);
    expect(detectSignatureFieldsOnPage(doc, 0)[0].valueRef?.toKey()).toBe('6_0');
    widget.set('V', new PDFRef(4006, 0));
    expect(() => detectSignatureFieldsOnPage(doc, 0)).toThrow(/cannot be safely inspected/i);
    const cycle = new PDFRef(4007, 0); doc.objects.set(cycle.toKey(), cycle); widget.set('V', cycle);
    expect(() => detectSignatureFieldsOnPage(doc, 0)).toThrow(/cyclic/i);
  });

  it('fails closed on malformed signature values and parent chains', async () => {
    const doc = await fixture();
    const field = detectSignatureFieldsOnPage(doc, 0)[0];
    field.widget.dict.set('V', new PDFDict([['Type', new PDFName('Sig')]]));
    expect(detectSignatureFieldsOnPage(doc, 0)[0].signed).toBe(true);
    field.widget.dict.set('V', PDFNull.instance);
    expect(detectSignatureFieldsOnPage(doc, 0)[0].signed).toBe(false);
    field.widget.dict.set('V', new PDFName('invalid'));
    expect(() => detectSignatureFieldsOnPage(doc, 0)).toThrow(/cannot be safely inspected/i);
    field.widget.dict.delete('V');
    const cycle = new PDFRef(4003, 0); doc.objects.set(cycle.toKey(), field.widget.dict);
    field.widget.dict.set('Parent', cycle);
    expect(() => detectSignatureFieldsOnPage(doc, 0)).toThrow(/cyclic/i);
    field.widget.dict.set('Parent', new PDFRef(4004, 0));
    expect(() => detectSignatureFieldsOnPage(doc, 0)).toThrow(/cannot be safely inspected/i);
  });

  it('rejects signing a read-only indirect signature field without changing the document', async () => {
    const doc = await fixture();
    const field = detectSignatureFieldsOnPage(doc, 0)[0];
    field.widget.dict.set('Ff', new PDFNumber(1));
    const before = await serializeDocument(doc);
    await expect(signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: field.id, point: { x: 100, y: 100 },
      privateKey: {} as CryptoKey, signOptions: {}, isCurrent: () => true,
    })).rejects.toThrow(/read.only/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([false, true])('discovers all field types and inherits flags, indirect=%s', async indirect => {
    const doc = await fixture(indirect);
    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets.map(w => w.fieldName).sort()).toEqual(['Checkbox', 'Choice', 'Push', 'Radio', 'Radio', 'Signature', 'Text']);
    expect(widgets.find(w => w.fieldName === 'Push')!.buttonFlags & (1 << 16)).not.toBe(0);
    expect(widgets.filter(w => w.fieldName === 'Radio')).toHaveLength(2);
    expect(detectSignatureFieldsOnPage(doc, 0).map(w => w.fieldName)).toEqual(['Signature']);
  });

  it('updates button states and text/choice appearances on indirect widgets', async () => {
    const doc = await fixture();
    const widgets = detectFormFieldsOnPage(doc, 0);
    const get = (name: string) => { const item = widgets.find(w => w.fieldName === name); expect(item).toBeDefined(); return item!; };
    installCanvas();
    const render = async () => (await renderPage(doc, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'supported' })).canvas.toDataURL();
    const beforeText = await render(); setFormFieldValue(doc, get('Text'), 'AFTER'); expect(await render()).not.toBe(beforeText);
    const beforeChoice = await render(); setChoiceFieldValue(doc, get('Choice'), 'Bravo'); expect(await render()).not.toBe(beforeChoice);
    setButtonFieldValue(doc, get('Checkbox'), true);
    const second = widgets.filter(w => w.fieldName === 'Radio')[1]; setButtonFieldValue(doc, second, true);
    const saved = await PDFDocument.load(await serializeDocument(doc));
    expect(saved.getForm().getTextField('Text').getText()).toBe('AFTER');
    expect(saved.getForm().getDropdown('Choice').getSelected()).toEqual(['Bravo']);
    expect(saved.getForm().getCheckBox('Checkbox').isChecked()).toBe(true);
    expect(saved.getForm().getRadioGroup('Radio').getSelected()).toBe('Two');
  });

  it('removes only the visual appearance from an indirect signature widget', async () => {
    const doc = await fixture();
    const field = detectFormFieldsOnPage(doc, 0).find(w => w.fieldName === 'Signature')!;
    expect(field).toBeDefined();
    field.dict.set('AP', new PDFDict());
    const value = new PDFRef(5000, 0); doc.objects.set(value.toKey(), new PDFDict([['Type', new PDFName('Sig')]]));
    field.dict.set('V', value);
    removeVisualSignature(doc, 'signature-id');
    expect(field.dict.get('V')).toBe(value);
    expect(field.dict.has('AP')).toBe(false);
    expect(detectFormFieldsOnPage(doc, 0).some(w => w.ref.toKey() === field.ref.toKey())).toBe(true);
  });

  it('skips missing and dangling subtype values, and reports a cyclic subtype', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0).find(w => w.fieldName === 'Push')!;
    expect(widget).toBeDefined();
    widget.dict.delete('Subtype');
    expect(detectFormFieldsOnPage(doc, 0).some(w => w.fieldName === 'Push')).toBe(false);
    const dangling = new PDFRef(4000, 0); widget.dict.set('Subtype', dangling);
    expect(detectFormFieldsOnPage(doc, 0).some(w => w.fieldName === 'Push')).toBe(false);
    const cycle = new PDFRef(4001, 0); doc.objects.set(cycle.toKey(), cycle); widget.dict.set('Subtype', cycle);
    expect(() => detectFormFieldsOnPage(doc, 0)).toThrow(/cyclic/i);
  });
});
