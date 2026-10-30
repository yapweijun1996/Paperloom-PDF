import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { detectFormFieldsOnPage, listAllFormWidgets, parseAcroFormCatalog } from '../forms/detect-fields';
import { setFormFieldValue } from '../forms/apply-field';
import { serializeDocument } from '../writer/serializer';

async function fixture() {
  const source = await PDFDocument.create();
  const first = source.addPage([300, 400]);
  const second = source.addPage([300, 400]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  const form = source.getForm();
  const primary = form.createTextField('group.branch.primary');
  primary.addToPage(first, { x: 10, y: 300, width: 200, height: 20, font });
  primary.addToPage(second, { x: 10, y: 300, width: 200, height: 20, font });
  primary.setText('VALUE_PRIMARY');
  const sibling = form.createTextField('group.branch.sibling');
  sibling.addToPage(first, { x: 10, y: 250, width: 200, height: 20, font });
  sibling.setText('VALUE_SIBLING');
  const other = form.createTextField('group.other');
  other.addToPage(first, { x: 10, y: 200, width: 200, height: 20, font });
  other.setText('VALUE_OTHER');
  const solo = form.createTextField('solo');
  solo.addToPage(first, { x: 10, y: 150, width: 200, height: 20, font });
  solo.setText('VALUE_SOLO');
  return parsePDF(await source.save({ useObjectStreams: false }));
}

describe('hierarchical form widget detection', () => {
  it('enumerates each widget once across roots, siblings and shared pages', async () => {
    const doc = await fixture();
    const widgets = listAllFormWidgets(doc);
    const first = detectFormFieldsOnPage(doc, 0);
    const second = detectFormFieldsOnPage(doc, 1);
    expect(widgets).toHaveLength(5);
    expect(new Set(widgets.map(widget => widget.ref.toKey())).size).toBe(5);
    expect(first.map(widget => widget.fieldName).sort()).toEqual(['group.branch.primary', 'group.branch.sibling', 'group.other', 'solo']);
    expect(second.map(widget => widget.fieldName)).toEqual(['group.branch.primary']);
    // The catalog's root retains the accumulated widgets for its descendants.
    expect(parseAcroFormCatalog(doc)!.fields.find(field => field.fullName === 'group')!.widgets).toHaveLength(4);
  });

  it('keeps distinct radio widgets with the same field name', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([300, 300]);
    const radio = source.getForm().createRadioGroup('group.selection');
    radio.addOptionToPage('first', page, { x: 10, y: 100, width: 20, height: 20 });
    radio.addOptionToPage('second', page, { x: 40, y: 100, width: 20, height: 20 });
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets.map(widget => widget.fieldName)).toEqual(['group.selection', 'group.selection']);
    expect(new Set(widgets.map(widget => widget.ref.toKey())).size).toBe(2);
  });

  it('finds page-less widgets through each page annotation array', async () => {
    const doc = await fixture();
    const first = detectFormFieldsOnPage(doc, 0).find(widget => widget.fieldName === 'group.branch.primary')!;
    const second = detectFormFieldsOnPage(doc, 1)[0];
    first.dict.delete('P');
    second.dict.delete('P');
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(detectFormFieldsOnPage(reopened, 0).filter(widget => widget.fieldName === 'group.branch.primary').map(widget => widget.ref.toKey()))
      .toEqual([first.ref.toKey()]);
    expect(detectFormFieldsOnPage(reopened, 1).filter(widget => widget.fieldName === 'group.branch.primary').map(widget => widget.ref.toKey()))
      .toEqual([second.ref.toKey()]);
  });

  it('keeps unique widgets and field values after editing, saving and reopening', async () => {
    const doc = await fixture();
    const pageWidgets = detectFormFieldsOnPage(doc, 0);
    setFormFieldValue(doc, pageWidgets.find(widget => widget.fieldName === 'group.branch.sibling')!, 'NEWVALUE');
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    const first = detectFormFieldsOnPage(reopened, 0);
    expect(first).toHaveLength(4);
    expect(new Set(first.map(widget => widget.ref.toKey())).size).toBe(4);
    expect(first.find(widget => widget.fieldName === 'group.branch.sibling')?.value).toBe('NEWVALUE');
    expect(detectFormFieldsOnPage(reopened, 1).map(widget => widget.fieldName)).toEqual(['group.branch.primary']);
    const independent = await PDFDocument.load(output);
    expect(independent.getForm().getTextField('group.branch.primary').getText()).toBe('VALUE_PRIMARY');
    expect(independent.getForm().getTextField('group.branch.sibling').getText()).toBe('NEWVALUE');
  });
});
