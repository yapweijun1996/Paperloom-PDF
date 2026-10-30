import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF, resolveRef } from '../parser/parser';
import { PDFArray, PDFDict, PDFNumber, PDFRef } from '../types';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { setFormFieldValue } from '../forms/apply-field';
import { setButtonFieldValue } from '../forms/widget-appearances';
import { serializeDocument } from '../writer/serializer';

async function checkboxFixture() {
  const pdf = await PDFDocument.create();
  const page1 = pdf.addPage([300, 300]);
  const page2 = pdf.addPage([300, 300]);
  const field = pdf.getForm().createCheckBox('Consent');
  field.addToPage(page1);
  field.addToPage(page2);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (let i = 0; i < 2; i++) {
    const widget = detectFormFieldsOnPage(doc, i)[0];
    const ap = resolveRef(widget.dict.get('AP')!, doc.objects) as PDFDict;
    const normal = resolveRef(ap.get('N')!, doc.objects) as PDFDict;
    const existing = [...normal.keys()].find(name => name !== 'Off')!;
    const appearance = normal.get(existing)!;
    normal.delete(existing);
    normal.set('Accepted', appearance);
  }
  return doc;
}

describe('checkbox value and appearance interoperability', () => {
  it.each([true, false])('writes the terminal field and all sibling states with a non-default on name: %s', async checked => {
    const doc = await checkboxFixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    setButtonFieldValue(doc, widget, checked);
    const bytes = await serializeDocument(doc);
    const independentlyOpened = await PDFDocument.load(bytes);
    expect(independentlyOpened.getForm().getCheckBox('Consent').isChecked()).toBe(checked);
    const reopened = await parsePDF(bytes);
    const expected = checked ? 'Accepted' : 'Off';
    for (let i = 0; i < 2; i++) {
      const result = detectFormFieldsOnPage(reopened, i)[0];
      expect(result.value).toBe(expected);
      expect(result.dict.getName('AS')).toBe(expected);
      expect(result.dict.has('V')).toBe(false);
      const parent = resolveRef(result.dict.get('Parent')!, reopened.objects) as PDFDict;
      expect(parent.getName('V')).toBe(expected);
    }
  });

  it('updates a direct field/widget through the general field setter', async () => {
    const doc = await checkboxFixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    const parentRef = widget.dict.getRef('Parent')!;
    const field = resolveRef(parentRef, doc.objects) as PDFDict;
    for (const [key, value] of widget.dict.entries()) if (key !== 'Parent') field.set(key, value);
    field.delete('Kids');
    doc.pages[0].dict.set('Annots', new PDFArray([parentRef]));
    doc.pages[1].dict.delete('Annots');
    const direct = detectFormFieldsOnPage(doc, 0)[0];
    setFormFieldValue(doc, direct, true);
    const output = await serializeDocument(doc);
    expect((await PDFDocument.load(output)).getForm().getCheckBox('Consent').isChecked()).toBe(true);
    const parsed = await parsePDF(output);
    const restored = detectFormFieldsOnPage(parsed, 0)[0];
    expect(restored.dict.getName('V')).toBe('Accepted');
    expect(restored.dict.getName('AS')).toBe('Accepted');
  });

  it('uses one field value and consistent appearances when sibling checkbox on names differ', async () => {
    const doc = await checkboxFixture();
    const second = detectFormFieldsOnPage(doc, 1)[0];
    const ap = resolveRef(second.dict.get('AP')!, doc.objects) as PDFDict;
    const normal = resolveRef(ap.get('N')!, doc.objects) as PDFDict;
    const stream = normal.get('Accepted')!;
    normal.delete('Accepted');
    normal.set('Alternate', stream);
    for (const variant of ['D', 'R']) {
      ap.set(variant, new PDFDict([['Alternate', stream], ['Off', normal.get('Off')!]]));
    }
    setButtonFieldValue(doc, second, true);
    const bytes = await serializeDocument(doc);
    expect((await PDFDocument.load(bytes)).getForm().getCheckBox('Consent').isChecked()).toBe(true);
    const reopened = await parsePDF(bytes);
    expect(detectFormFieldsOnPage(reopened, 0)[0].appearanceState).toBe('Accepted');
    expect(detectFormFieldsOnPage(reopened, 1)[0].appearanceState).toBe('Accepted');
    const restored = detectFormFieldsOnPage(reopened, 1)[0];
    const restoredAp = resolveRef(restored.dict.get('AP')!, reopened.objects) as PDFDict;
    for (const variant of ['D', 'R']) {
      const states = resolveRef(restoredAp.get(variant)!, reopened.objects) as PDFDict;
      expect(states.has('Accepted')).toBe(true);
    }
  });

  it('rejects malformed sibling appearances before changing any widget or field', async () => {
    const doc = await checkboxFixture();
    const first = detectFormFieldsOnPage(doc, 0)[0];
    const second = detectFormFieldsOnPage(doc, 1)[0];
    const loop = new PDFRef(900, 0);
    doc.objects.set(loop.toKey(), loop);
    second.dict.set('AP', loop);
    const before = await serializeDocument(doc);
    expect(() => setButtonFieldValue(doc, first, true)).toThrow(/cyclic reference/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('selects a radio option without selecting its siblings', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const radio = pdf.getForm().createRadioGroup('Answer');
    radio.addOptionToPage('A', page, { x: 10, y: 50 });
    radio.addOptionToPage('B', page, { x: 60, y: 50 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets).toHaveLength(2);
    setButtonFieldValue(doc, widgets[1], true);
    const bytes = await serializeDocument(doc);
    expect((await PDFDocument.load(bytes)).getForm().getRadioGroup('Answer').getSelected()).toBe('B');
    const reopened = await parsePDF(bytes);
    const states = detectFormFieldsOnPage(reopened, 0).map(field => field.dict.getName('AS'));
    expect(states[0]).toBe('Off');
    expect(states[1]).not.toBe('Off');
  });

  it('rejects clearing a no-toggle-to-off radio without mutating the field', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const radio = pdf.getForm().createRadioGroup('Answer');
    radio.addOptionToPage('A', page, { x: 10, y: 50 });
    radio.addOptionToPage('B', page, { x: 60, y: 50 });
    radio.select('A');
    radio.disableOffToggling();
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const [first, second] = detectFormFieldsOnPage(doc, 0);
    const before = await serializeDocument(doc);
    expect(() => setButtonFieldValue(doc, first, false)).toThrow(/does not allow clearing/i);
    expect(await serializeDocument(doc)).toEqual(before);
    setButtonFieldValue(doc, second, true);
    expect((await PDFDocument.load(await serializeDocument(doc))).getForm().getRadioGroup('Answer').getSelected()).toBe('B');
  });

  it.each([false, true])('honors radio widgets-in-unison flag: %s', async inUnison => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const radio = pdf.getForm().createRadioGroup('Answer');
    radio.addOptionToPage('A', page, { x: 10, y: 50 });
    radio.addOptionToPage('B', page, { x: 60, y: 50 });
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const widgets = detectFormFieldsOnPage(doc, 0);
    const firstAp = resolveRef(widgets[0].dict.get('AP')!, doc.objects) as PDFDict;
    const firstNormal = resolveRef(firstAp.get('N')!, doc.objects) as PDFDict;
    const firstOn = [...firstNormal.keys()].find(key => key !== 'Off')!;
    const secondAp = resolveRef(widgets[1].dict.get('AP')!, doc.objects) as PDFDict;
    const secondNormal = resolveRef(secondAp.get('N')!, doc.objects) as PDFDict;
    const secondOn = [...secondNormal.keys()].find(key => key !== 'Off')!;
    const appearance = secondNormal.get(secondOn)!;
    secondNormal.delete(secondOn);
    secondNormal.set(firstOn, appearance);
    const owner = resolveRef(widgets[0].dict.get('Parent')!, doc.objects) as PDFDict;
    const flags = widgets[0].buttonFlags | (inUnison ? (1 << 25) : 0);
    owner.set('Ff', new PDFNumber(flags));
    widgets[1].buttonFlags = flags;
    setButtonFieldValue(doc, widgets[1], true);
    const reopened = await parsePDF(await serializeDocument(doc));
    const states = detectFormFieldsOnPage(reopened, 0).map(field => field.appearanceState);
    expect(states).toEqual([inUnison ? firstOn : 'Off', firstOn]);
  });
});
