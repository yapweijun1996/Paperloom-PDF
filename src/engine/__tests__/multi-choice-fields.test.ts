import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { setChoiceFieldValue } from '../forms/widget-appearances';
import { detectFormFieldsOnPage } from '../forms/detect-fields';
import { PDFArray, PDFDict, PDFNumber, PDFStream } from '../types';
import { resolveRef } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { SessionDocumentEditor } from '../session/document-edit';

async function fixture() {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 300]);
  const field = source.getForm().createOptionList('Meals');
  field.addOptions(['Rice', 'Tea', 'Soup']);
  field.enableMultiselect();
  field.select(['Rice']);
  field.addToPage(page, { x: 20, y: 20, width: 160, height: 80, font: await source.embedFont(StandardFonts.Helvetica) });
  return parsePDF(await source.save({ useObjectStreams: false }));
}

describe('multi-select choice fields', () => {
  it('writes values and selected indices, regenerates an appearance, and round trips through pdf-lib', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    expect(widget.choiceFlags & (1 << 21)).not.toBe(0);
    setChoiceFieldValue(doc, widget, ['Soup', 'Rice']);
    const saved = await serializeDocument(doc);
    const reopened = await parsePDF(saved);
    const selected = detectFormFieldsOnPage(reopened, 0)[0];
    expect(selected.value).toEqual(['Rice', 'Soup']);
    const parent = resolveRef(selected.dict.get('Parent')!, reopened.objects) as PDFDict;
    expect((parent.get('I') as PDFArray).items.map(item => (item as PDFNumber).value)).toEqual([0, 2]);
    const ap = resolveRef(selected.dict.get('AP')!, reopened.objects) as PDFDict;
    const normal = resolveRef(ap.get('N')!, reopened.objects) as PDFStream;
    const commands = new TextDecoder().decode(normal.getBytes());
    expect(commands).toContain('(Rice)');
    expect(commands).toContain('(Tea)');
    expect(commands).toContain('(Soup)');
    expect(commands.match(/0\.2 0\.4 0\.8 rg/g)).toHaveLength(2);
    const independent = await PDFDocument.load(saved);
    expect(independent.getForm().getOptionList('Meals').getSelected()).toEqual(['Rice', 'Soup']);
  });

  it('can clear every selection and preserve an independently readable empty value', async () => {
    const doc = await fixture();
    setChoiceFieldValue(doc, detectFormFieldsOnPage(doc, 0)[0], []);
    const independent = await PDFDocument.load(await serializeDocument(doc));
    expect(independent.getForm().getOptionList('Meals').getSelected()).toEqual([]);
  });

  it('rejects an unrenderable multi-choice widget without changing its value', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.dict.set('Rect', new PDFArray([0, 0, 0, 0].map(n => new PDFNumber(n))));
    const before = await serializeDocument(doc);
    expect(() => setChoiceFieldValue(doc, widget, ['Tea'])).toThrow(/appearance cannot be generated/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects ambiguous export values without changing the field', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.choiceOptions = [{ value: 'Rice', label: 'Rice' }, { value: 'Rice', label: 'Other rice' }];
    const before = await serializeDocument(doc);
    expect(() => setChoiceFieldValue(doc, widget, ['Rice'])).toThrow(/ambiguous/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects invalid values before changing the field', async () => {
    const doc = await fixture();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    const before = await serializeDocument(doc);
    expect(() => setChoiceFieldValue(doc, widget, ['not-an-option'])).toThrow(/not a choice option/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('makes the entire multi-selection one undoable transaction', async () => {
    const doc = await fixture();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'choice', async staged => setChoiceFieldValue(staged, detectFormFieldsOnPage(staged, 0)[0], ['Tea', 'Soup']));
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toEqual(['Tea', 'Soup']);
    await editor.undo(doc);
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toBe('Rice');
    await editor.redo(doc);
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toEqual(['Tea', 'Soup']);
  });
});
