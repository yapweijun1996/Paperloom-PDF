import { describe, expect, it } from 'vitest';
import { PDFDocument, TextAlignment } from 'pdf-lib';
import { parsePDF, resolveRef } from '../parser/parser';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import { deletePage, extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import { inherited } from '../forms/text-appearance';

async function sourceFixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([300, 300]);
  const second = pdf.addPage([300, 300]);
  const form = pdf.getForm();
  const a = form.createTextField('Group.A');
  a.setText('first value');
  a.addToPage(first, { x: 30, y: 180, width: 150, height: 30 });
  const b = form.createTextField('Group.B');
  b.setText('second value');
  b.addToPage(second, { x: 30, y: 180, width: 150, height: 30 });
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

async function independent(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getForm();
}

function indirectFieldsAndKids(doc: PDFDocumentData): void {
  const acroValue = doc.catalog.get('AcroForm');
  const acro = acroValue instanceof PDFRef ? doc.objects.get(acroValue.toKey()) : acroValue;
  if (!(acro instanceof PDFDict)) throw new Error('Missing form');
  const fields = acro.get('Fields');
  if (!(fields instanceof PDFArray)) throw new Error('Missing fields');
  const root = doc.objects.get((fields.items[0] as PDFRef).toKey()) as PDFDict;
  const kids = root.get('Kids');
  if (!(kids instanceof PDFArray)) throw new Error('Missing kids');
  doc.objects.set('900_0', fields);
  doc.objects.set('901_0', kids);
  acro.set('Fields', new PDFRef(900, 0));
  root.set('Kids', new PDFRef(901, 0));
}

function formDictionary(doc: PDFDocumentData): PDFDict {
  const value = doc.catalog.get('AcroForm');
  const acro = value instanceof PDFRef ? doc.objects.get(value.toKey()) : value;
  if (!(acro instanceof PDFDict)) throw new Error('Missing form');
  return acro;
}

function formResources(fontName: string, baseFont: string): PDFDict {
  return new PDFDict([['Font', new PDFDict([[fontName, new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName(baseFont)],
  ])]])]]);
}

describe('page extraction and insertion preserve AcroForms', () => {
  it('preserves the source document default text alignment when extracting', async () => {
    const source = await sourceFixture();
    formDictionary(source).set('Q', new PDFNumber(2));
    const output = await independent(await serializeDocument(extractPages(source, [0])));
    const field = output.getTextField('Group.A');
    expect(field.getAlignment()).toBe(TextAlignment.Right);
    field.setText('edited after extraction');
    const reopened = await independent(await output.doc.save({ useObjectStreams: false }));
    expect(reopened.getTextField('Group.A').getAlignment()).toBe(TextAlignment.Right);
    expect(reopened.getTextField('Group.A').getText()).toBe('edited after extraction');
  });

  it.each([undefined, 0, 1, 2])('preserves source default alignment %s against a different target default', async sourceAlignment => {
    const source = await sourceFixture();
    if (sourceAlignment !== undefined) formDictionary(source).set('Q', new PDFNumber(sourceAlignment));
    const target = await sourceFixture();
    formDictionary(target).set('Q', new PDFNumber(2));
    const root = source.objects.get((formDictionary(source).getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    root.set('T', new PDFString('Imported'));
    insertPagesFromDocument(target, source, 1);
    const rootFieldRefs = formDictionary(target).getArray('Fields')!.items as PDFRef[];
    const importedRoot = rootFieldRefs.map(ref => target.objects.get(ref.toKey()))
      .find(value => value instanceof PDFDict && value.getString('T') === 'Imported') as PDFDict;
    const importedField = target.objects.get((importedRoot.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    expect((inherited(target, importedField, 'Q') as PDFNumber).value).toBe(sourceAlignment ?? 0);
    const form = await independent(await serializeDocument(target));
    const field = form.getTextField('Imported.A');
    expect(field.getAlignment()).toBe(sourceAlignment ?? TextAlignment.Left);
    field.setText('editable');
    expect((await independent(await form.doc.save({ useObjectStreams: false }))).getTextField('Imported.A').getText()).toBe('editable');
  });

  it.each(['extract', 'source', 'target'] as const)('rejects an XFA form before %s without changing either PDF', async mode => {
    const source = await sourceFixture();
    const target = await sourceFixture();
    if (mode === 'target') formDictionary(target).set('XFA', new PDFString('private XFA data'));
    else formDictionary(source).set('XFA', new PDFString('private XFA data'));
    if (mode !== 'extract') {
      const root = source.objects.get((formDictionary(source).getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
      root.set('T', new PDFString('Imported'));
    }
    const beforeSource = await serializeDocument(source);
    const beforeTarget = await serializeDocument(target);
    expect(() => mode === 'extract' ? extractPages(source, [0]) : insertPagesFromDocument(target, source, 1)).toThrow(/XFA|safely/);
    expect(await serializeDocument(source)).toEqual(beforeSource);
    expect(await serializeDocument(target)).toEqual(beforeTarget);
  });

  it('rejects duplicate page indices instead of writing an invalid page tree', async () => {
    const source = await sourceFixture();
    const before = await serializeDocument(source);
    expect(() => extractPages(source, [0, 0])).toThrow(/duplicate/i);
    expect(await serializeDocument(source)).toEqual(before);
  });

  it('preserves field-level alignment overrides over parent and document defaults', async () => {
    const source = await sourceFixture();
    const acro = formDictionary(source);
    acro.set('Q', new PDFNumber(2));
    const root = source.objects.get((acro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    root.set('Q', new PDFNumber(1));
    const first = source.objects.get((root.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    first.set('Q', new PDFNumber(0));
    const form = await independent(await serializeDocument(extractPages(source, [0, 1])));
    expect(form.getTextField('Group.A').getAlignment()).toBe(TextAlignment.Left);
    expect(form.getTextField('Group.B').getAlignment()).toBe(TextAlignment.Center);
  });

  it.each(['invalid-default', 'invalid-field', 'calculation-order', 'form-action', 'field-action'] as const)(
    'rejects %s before extracting or inserting form pages', async kind => {
      const source = await sourceFixture();
      const target = await sourceFixture();
      const acro = formDictionary(source);
      const rootRef = acro.getArray('Fields')!.items[0] as PDFRef;
      const root = source.objects.get(rootRef.toKey()) as PDFDict;
      root.set('T', new PDFString('Imported'));
      if (kind === 'invalid-default') acro.set('Q', new PDFString('bad'));
      if (kind === 'invalid-field') root.set('Q', new PDFNumber(3));
      if (kind === 'calculation-order') acro.set('CO', new PDFArray([rootRef]));
      if (kind === 'form-action') acro.set('AA', new PDFDict());
      if (kind === 'field-action') root.set('AA', new PDFDict());
      const beforeSource = await serializeDocument(source);
      const beforeTarget = await serializeDocument(target);
      expect(() => extractPages(source, [0])).toThrow(/safely/);
      expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/safely/);
      expect(await serializeDocument(source)).toEqual(beforeSource);
      expect(await serializeDocument(target)).toEqual(beforeTarget);
    },
  );
  it('deleting a page removes its field and widget without retaining the removed page', async () => {
    const source = await sourceFixture();
    const deletedPage = source.pages[0].ref.toKey();
    deletePage(source, 0);
    const bytes = await serializeDocument(source);
    const reopened = await parsePDF(bytes);
    expect(reopened.pages).toHaveLength(1);
    expect(reopened.objects.has(deletedPage)).toBe(false);
    const form = await independent(bytes);
    expect(form.getFields().map(field => field.getName())).toEqual(['Group.B']);
    expect(form.getTextField('Group.B').getText()).toBe('second value');
    form.getTextField('Group.B').setText('edited');
    expect((await independent(await form.doc.save({ useObjectStreams: false }))).getTextField('Group.B').getText()).toBe('edited');
  });

  it('deleting a page retains the surviving widget of a shared field', async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage([300, 300]);
    const second = pdf.addPage([300, 300]);
    const field = pdf.getForm().createTextField('Shared');
    field.setText('shared value');
    field.addToPage(first);
    field.addToPage(second);
    const source = await parsePDF(await pdf.save({ useObjectStreams: false }));
    deletePage(source, 0);
    const bytes = await serializeDocument(source);
    const output = await PDFDocument.load(bytes);
    const restored = output.getForm().getTextField('Shared');
    expect(restored.getText()).toBe('shared value');
    expect(restored.acroField.getWidgets()).toHaveLength(1);
    restored.setText('changed');
    expect((await independent(await output.save({ useObjectStreams: false }))).getTextField('Shared').getText()).toBe('changed');
  });

  it('deleting a page removes a field that is itself its widget', async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage([300, 300]);
    pdf.addPage([300, 300]);
    const field = pdf.getForm().createTextField('Single');
    field.setText('removed');
    field.addToPage(first);
    const source = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const acro = formDictionary(source);
    const fieldRef = acro.getArray('Fields')!.items[0] as PDFRef;
    const fieldDict = source.objects.get(fieldRef.toKey()) as PDFDict;
    const widgetRef = fieldDict.getArray('Kids')!.items[0] as PDFRef;
    const widget = source.objects.get(widgetRef.toKey()) as PDFDict;
    for (const [key, value] of widget.entries()) if (key !== 'Parent') fieldDict.set(key, value);
    fieldDict.delete('Kids');
    source.pages[0].dict.set('Annots', new PDFArray([fieldRef]));
    deletePage(source, 0);
    const bytes = await serializeDocument(source);
    expect((await independent(bytes)).getFields()).toHaveLength(0);
    expect((await parsePDF(bytes)).objects.has(fieldRef.toKey())).toBe(false);
  });

  it.each(['missing', 'empty'])('removes an orphan widget whose /P points to a page with %s Annots', async kind => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage([300, 300]);
    pdf.addPage([300, 300]);
    const field = pdf.getForm().createTextField('PrivateField');
    field.setText('private field value');
    field.addToPage(first);
    const source = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const deletedPage = source.pages[0].ref.toKey();
    if (kind === 'missing') source.pages[0].dict.delete('Annots');
    else source.pages[0].dict.set('Annots', new PDFArray());
    deletePage(source, 0);
    const bytes = await serializeDocument(source);
    const reopened = await parsePDF(bytes);
    expect(reopened.pages).toHaveLength(1);
    expect(reopened.objects.has(deletedPage)).toBe(false);
    expect((await independent(bytes)).getFields()).toHaveLength(0);
  });

  it('refuses an orphan widget shared with a surviving page without modifying the document', async () => {
    const source = await sourceFixture();
    const annotations = source.pages[0].dict.get('Annots') as PDFArray;
    const widget = annotations.items[0];
    source.pages[0].dict.delete('Annots');
    (source.pages[1].dict.get('Annots') as PDFArray).push(widget);
    const before = await serializeDocument(source);
    expect(() => deletePage(source, 0)).toThrow(/ambiguous AcroForm/);
    expect(await serializeDocument(source)).toEqual(before);
    expect((await parsePDF(await serializeDocument(source))).pages).toHaveLength(2);
  });

  it('removes deleted fields from an indirect calculation order and keeps the other fields', async () => {
    const source = await sourceFixture();
    indirectFieldsAndKids(source);
    const acro = formDictionary(source);
    const roots = resolveRef(acro.get('Fields')!, source.objects) as PDFArray;
    const root = source.objects.get((roots.items[0] as PDFRef).toKey()) as PDFDict;
    const kids = resolveRef(root.get('Kids')!, source.objects) as PDFArray;
    const survivingField = kids.items[1];
    source.objects.set('902_0', new PDFArray([...kids.items]));
    acro.set('CO', new PDFRef(902, 0));
    deletePage(source, 0);
    const reopened = await parsePDF(await serializeDocument(source));
    const order = resolveRef(formDictionary(reopened).get('CO')!, reopened.objects) as PDFArray;
    expect(order.items).toEqual([survivingField]);
    expect((await independent(await serializeDocument(source))).getFields().map(field => field.getName())).toEqual(['Group.B']);
  });

  it.each(['shared field', 'direct shared field', 'shared widget', 'stale widget page', 'cyclic fields', 'xfa'])('refuses %s before modifying the document', async kind => {
    const source = await sourceFixture();
    const acro = formDictionary(source);
    const rootRef = acro.getArray('Fields')!.items[0] as PDFRef;
    const root = source.objects.get(rootRef.toKey()) as PDFDict;
    const fieldRef = root.getArray('Kids')!.items[0] as PDFRef;
    const field = source.objects.get(fieldRef.toKey()) as PDFDict;
    const widgetRef = field.getArray('Kids')!.items[0] as PDFRef;
    if (kind === 'shared field') source.catalog.set('ExternalField', fieldRef);
    if (kind === 'direct shared field') source.catalog.set('ExternalField', field);
    if (kind === 'shared widget') (source.pages[1].dict.get('Annots') as PDFArray).push(widgetRef);
    if (kind === 'stale widget page') {
      const otherField = source.objects.get((root.getArray('Kids')!.items[1] as PDFRef).toKey()) as PDFDict;
      const otherWidget = source.objects.get((otherField.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
      otherWidget.set('P', source.pages[0].ref);
    }
    if (kind === 'cyclic fields') field.getArray('Kids')!.push(rootRef);
    if (kind === 'xfa') acro.set('XFA', new PDFString('data'));
    const before = await serializeDocument(source);
    expect(() => deletePage(source, 0)).toThrow(/ambiguous AcroForm/);
    expect(await serializeDocument(source)).toEqual(before);
    expect(source.pages).toHaveLength(2);
  });
  it('extracts each page with only its own inherited field and usable value', async () => {
    const source = await sourceFixture();
    for (const [page, name, value] of [[0, 'Group.A', 'first value'], [1, 'Group.B', 'second value']] as const) {
      const output = await serializeDocument(extractPages(source, [page]));
      const form = await independent(output);
      expect(form.getFields().map(field => field.getName())).toEqual([name]);
      expect(form.getTextField(name).getText()).toBe(value);
      form.getTextField(name).setText('edited');
      const reopened = await independent(await form.doc.save({ useObjectStreams: false }));
      expect(reopened.getTextField(name).getText()).toBe('edited');
    }
  });

  it('merges every nested sibling and preserves their parent relationships', async () => {
    const targetPdf = await PDFDocument.create();
    targetPdf.addPage([300, 300]);
    const target = await parsePDF(await targetPdf.save({ useObjectStreams: false }));
    const source = await sourceFixture();
    insertPagesFromDocument(target, source, 1);
    const bytes = await serializeDocument(target);
    const form = await independent(bytes);
    expect(form.getFields().map(field => field.getName()).sort()).toEqual(['Group.A', 'Group.B']);
    expect(form.getTextField('Group.A').getText()).toBe('first value');
    expect(form.getTextField('Group.B').getText()).toBe('second value');
    const reparsed = await parsePDF(bytes);
    const acro = reparsed.catalog.get('AcroForm');
    const acroDict = acro instanceof PDFRef ? reparsed.objects.get(acro.toKey()) : acro;
    const roots = (acroDict as PDFDict).get('Fields') as PDFArray;
    const group = reparsed.objects.get((roots.items[0] as PDFRef).toKey()) as PDFDict;
    expect((group.get('Kids') as PDFArray).length).toBe(2);
  });

  it('supports indirect Fields and Kids while retaining existing destination fields', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const targetField = pdf.getForm().createTextField('Existing');
    targetField.setText('already here');
    targetField.addToPage(page);
    const target = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const acroValue = target.catalog.get('AcroForm');
    const acro = (acroValue instanceof PDFRef ? target.objects.get(acroValue.toKey()) : acroValue) as PDFDict;
    const fields = acro.get('Fields') as PDFArray;
    target.objects.set('950_0', fields);
    acro.set('Fields', new PDFRef(950, 0));

    const source = await sourceFixture();
    indirectFieldsAndKids(source);
    const extracted = await independent(await serializeDocument(extractPages(source, [1])));
    expect(extracted.getFields().map(field => field.getName())).toEqual(['Group.B']);
    insertPagesFromDocument(target, source, 1);
    const result = await independent(await serializeDocument(target));
    expect(result.getFields().map(field => field.getName()).sort()).toEqual(['Existing', 'Group.A', 'Group.B']);
    expect(result.getTextField('Existing').getText()).toBe('already here');
    expect(result.getTextField('Group.B').getText()).toBe('second value');
    result.getTextField('Group.B').setText('changed');
    const reopened = await independent(await result.doc.save({ useObjectStreams: false }));
    expect(reopened.getTextField('Group.B').getText()).toBe('changed');
  });

  it('keeps only the selected widget when one field has widgets on both pages', async () => {
    const pdf = await PDFDocument.create();
    const page1 = pdf.addPage([300, 300]);
    const page2 = pdf.addPage([300, 300]);
    const field = pdf.getForm().createTextField('Shared');
    field.setText('shared value');
    field.addToPage(page1);
    field.addToPage(page2);
    const source = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const output = await PDFDocument.load(await serializeDocument(extractPages(source, [1])));
    const restored = output.getForm().getTextField('Shared');
    expect(restored.getText()).toBe('shared value');
    expect(restored.acroField.getWidgets()).toHaveLength(1);
    expect(output.getPages()).toHaveLength(1);
  });

  it('preserves a field dictionary that is itself the page widget', async () => {
    const source = await sourceFixture();
    const acroValue = source.catalog.get('AcroForm');
    const acro = (acroValue instanceof PDFRef ? source.objects.get(acroValue.toKey()) : acroValue) as PDFDict;
    const rootRef = (acro.get('Fields') as PDFArray).items[0] as PDFRef;
    const group = source.objects.get(rootRef.toKey()) as PDFDict;
    const fieldRef = (group.get('Kids') as PDFArray).items[0] as PDFRef;
    const field = source.objects.get(fieldRef.toKey()) as PDFDict;
    const widgetRef = (field.get('Kids') as PDFArray).items[0] as PDFRef;
    const widget = source.objects.get(widgetRef.toKey()) as PDFDict;
    for (const [key, value] of widget.entries()) if (key !== 'Parent') field.set(key, value);
    field.delete('Parent');
    field.delete('Kids');
    acro.set('Fields', new PDFArray([fieldRef]));
    source.pages[0].dict.set('Annots', new PDFArray([fieldRef]));

    const output = await PDFDocument.load(await serializeDocument(extractPages(source, [0])));
    expect(output.getForm().getTextField('A').getText()).toBe('first value');
    expect(output.getForm().getTextField('A').acroField.getWidgets()).toHaveLength(1);
  });

  it('merges distinct default font resources and preserves the imported default appearance', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const sourceAcro = formDictionary(source);
    const targetRoot = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    targetRoot.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('TargetFont', 'Helvetica'));
    targetAcro.set('DA', new PDFString('/TargetFont 11 Tf 0 g'));
    targetAcro.set('NeedAppearances', new PDFBoolean(false));
    sourceAcro.set('DR', formResources('SourceFont', 'Courier'));
    sourceAcro.set('DA', new PDFString('/SourceFont 10 Tf 0 g'));
    sourceAcro.set('NeedAppearances', new PDFBoolean(true));
    insertPagesFromDocument(target, source, 2);
    const reopened = await parsePDF(await serializeDocument(target));
    const mergedAcro = formDictionary(reopened);
    const resources = mergedAcro.getDict('DR')!.getDict('Font')!;
    expect([...resources.keys()].sort()).toEqual(['SourceFont', 'TargetFont']);
    expect(mergedAcro.getBool('NeedAppearances')).toBe(true);
    const roots = mergedAcro.getArray('Fields')!;
    const importedRoot = reopened.objects.get((roots.items[1] as PDFRef).toKey()) as PDFDict;
    expect(importedRoot.getString('DA')).toBe('/SourceFont 10 Tf 0 g');
  });

  it('reuses equivalent default fonts with direct and indirect resource objects', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const sourceAcro = formDictionary(source);
    const rootRef = targetAcro.getArray('Fields')!.items[0] as PDFRef;
    (target.objects.get(rootRef.toKey()) as PDFDict).set('T', new PDFString('TargetGroup'));
    const targetDR = formResources('Shared', 'Helvetica');
    const sourceDR = formResources('Shared', 'Helvetica');
    const shared = targetDR.getDict('Font')!.get('Shared');
    source.objects.set('990_0', sourceDR.getDict('Font')!.get('Shared')!);
    sourceDR.getDict('Font')!.set('Shared', new PDFRef(990, 0));
    targetAcro.set('DR', targetDR);
    targetAcro.set('DA', new PDFString('/Shared 10 Tf 0 g'));
    sourceAcro.set('DR', sourceDR);
    sourceAcro.set('DA', new PDFString('/Shared 10 Tf 0 g'));

    insertPagesFromDocument(target, source, 2);
    expect(targetDR.getDict('Font')!.get('Shared')).toBe(shared);
    const form = await independent(await serializeDocument(target));
    expect(form.getFields().map(field => field.getName()).sort())
      .toEqual(['Group.A', 'Group.B', 'TargetGroup.A', 'TargetGroup.B']);
    expect(form.getTextField('TargetGroup.A').getText()).toBe('first value');
    expect(form.getTextField('Group.B').getText()).toBe('second value');
    form.getTextField('Group.B').setText('updated');
    const reopened = await independent(await form.doc.save({ useObjectStreams: false }));
    expect(reopened.getTextField('Group.B').getText()).toBe('updated');
    expect(reopened.getTextField('TargetGroup.B').getText()).toBe('second value');
  });

  it('renames distinct conflicting fonts throughout inherited field and widget appearances', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const sourceAcro = formDictionary(source);
    const targetRoot = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    targetRoot.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('Shared', 'Helvetica'));
    targetAcro.set('DA', new PDFString('/Shared 11 Tf 0 g'));
    sourceAcro.set('DR', formResources('Shared', 'Courier'));
    sourceAcro.set('DA', new PDFString('/Sha#72ed 10 Tf 0 g'));
    const sourceRoot = source.objects.get((sourceAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    sourceRoot.set('DA', new PDFString('/Shared 12 Tf .25 g'));
    const sourceChild = source.objects.get((sourceRoot.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    sourceChild.set('DA', new PDFString('/Shared 13 Tf 0 0 0 rg'));
    const sourceWidget = source.objects.get((sourceChild.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    sourceWidget.set('DA', new PDFString('/Shared 14 Tf 0 g'));
    const beforeSource = await serializeDocument(source);

    insertPagesFromDocument(target, source, 2);
    expect(await serializeDocument(source)).toEqual(beforeSource);
    const bytes = await serializeDocument(target);
    const reopened = await parsePDF(bytes);
    const acro = formDictionary(reopened);
    const fonts = acro.getDict('DR')!.getDict('Font')!;
    expect([...fonts.keys()].sort()).toEqual(['PaperloomMergedFont1', 'Shared']);
    expect((fonts.get('Shared') as PDFDict).getName('BaseFont')).toBe('Helvetica');
    expect((fonts.get('PaperloomMergedFont1') as PDFDict).getName('BaseFont')).toBe('Courier');
    const root = reopened.objects.get((acro.getArray('Fields')!.items[1] as PDFRef).toKey()) as PDFDict;
    expect(root.getString('DA')).toBe('/PaperloomMergedFont1 12 Tf .25 g');
    const child = reopened.objects.get((root.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    expect(child.getString('DA')).toBe('/PaperloomMergedFont1 13 Tf 0 0 0 rg');
    const widget = reopened.objects.get((child.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    expect(widget.getString('DA')).toBe('/PaperloomMergedFont1 14 Tf 0 g');
    const independentForm = await independent(bytes);
    expect(independentForm.getTextField('Group.A').getText()).toBe('first value');
    expect(independentForm.getTextField('TargetGroup.A').getText()).toBe('first value');
    independentForm.getTextField('Group.A').setText('changed after merge');
    const edited = await independent(await independentForm.doc.save({ useObjectStreams: false }));
    expect(edited.getTextField('Group.A').getText()).toBe('changed after merge');
    expect(edited.getTextField('TargetGroup.A').getText()).toBe('first value');
  });

  it('retains a renamed AcroForm appearance when an imported root inherits it', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const root = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    root.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('Shared', 'Helvetica'));
    targetAcro.set('DA', new PDFString('/Shared 11 Tf 0 g'));
    const sourceAcro = formDictionary(source);
    sourceAcro.set('DR', formResources('Shared', 'Courier'));
    sourceAcro.set('DA', new PDFString('/Sha#72ed 10 Tf 0 g'));
    insertPagesFromDocument(target, source, 2);
    const bytes = await serializeDocument(target);
    const reopened = await parsePDF(bytes);
    const acro = formDictionary(reopened);
    const imported = reopened.objects.get((acro.getArray('Fields')!.items[1] as PDFRef).toKey()) as PDFDict;
    expect(imported.getString('DA')).toBe('/PaperloomMergedFont1 10 Tf 0 g');
    const form = await independent(bytes);
    expect(form.getTextField('Group.B').getText()).toBe('second value');
    form.getTextField('Group.B').setText('edited');
    expect((await independent(await form.doc.save())).getTextField('Group.B').getText()).toBe('edited');
  });

  it('rejects font renaming for an appearance without its own resources', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const targetRoot = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    targetRoot.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('Shared', 'Helvetica'));
    targetAcro.set('DA', new PDFString('/Shared 11 Tf 0 g'));
    const sourceAcro = formDictionary(source);
    sourceAcro.set('DR', formResources('Shared', 'Courier'));
    sourceAcro.set('DA', new PDFString('/Shared 10 Tf 0 g'));
    const sourceRoot = source.objects.get((sourceAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    const field = source.objects.get((sourceRoot.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    const widget = source.objects.get((field.getArray('Kids')!.items[0] as PDFRef).toKey()) as PDFDict;
    const appearance = resolveRef(widget.get('AP')!, source.objects) as PDFDict;
    const normal = resolveRef(appearance.get('N')!, source.objects) as PDFStream;
    normal.dict.delete('Resources');
    const beforeTarget = await serializeDocument(target);
    const beforeSource = await serializeDocument(source);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/widget resources/);
    expect(await serializeDocument(target)).toEqual(beforeTarget);
    expect(await serializeDocument(source)).toEqual(beforeSource);
  });

  it('rejects unsupported default appearance syntax before changing either document', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const root = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    root.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('Shared', 'Helvetica'));
    targetAcro.set('DA', new PDFString('/Shared 11 Tf 0 g'));
    const sourceAcro = formDictionary(source);
    sourceAcro.set('DR', formResources('Shared', 'Courier'));
    sourceAcro.set('DA', new PDFString('/Shared 10 Tf /Pattern cs'));
    const beforeTarget = await serializeDocument(target);
    const beforeSource = await serializeDocument(source);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/unsupported default appearance/);
    expect(await serializeDocument(target)).toEqual(beforeTarget);
    expect(await serializeDocument(source)).toEqual(beforeSource);
  });

  it('rejects equal font names with different nested encoding before mutation', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetDR = formResources('Shared', 'Helvetica');
    const sourceDR = formResources('Shared', 'Helvetica');
    (targetDR.getDict('Font')!.get('Shared') as PDFDict).set('Encoding', new PDFName('WinAnsiEncoding'));
    (sourceDR.getDict('Font')!.get('Shared') as PDFDict).set('Encoding', new PDFName('MacRomanEncoding'));
    const targetAcro = formDictionary(target);
    const targetRoot = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    targetRoot.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', targetDR);
    formDictionary(source).set('DR', sourceDR);
    // No source default appearance is available to safely rewrite.
    const before = await serializeDocument(target);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/conflicting AcroForm resource/);
    expect(await serializeDocument(target)).toEqual(before);
  });

  it.each(['unresolved', 'cyclic'])('rejects %s conflicting resources without mutation', async kind => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    formDictionary(target).set('DR', formResources('Shared', 'Helvetica'));
    const sourceDR = formResources('Shared', 'Helvetica');
    sourceDR.getDict('Font')!.set('Shared', new PDFRef(992, 0));
    if (kind === 'cyclic') source.objects.set('992_0', new PDFRef(992, 0));
    formDictionary(source).set('DR', sourceDR);
    const before = await serializeDocument(target);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/conflicting AcroForm resource/);
    expect(await serializeDocument(target)).toEqual(before);
  });

  it('rejects conflicting default resource names before mutating the target', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const targetAcro = formDictionary(target);
    const targetRoot = target.objects.get((targetAcro.getArray('Fields')!.items[0] as PDFRef).toKey()) as PDFDict;
    targetRoot.set('T', new PDFString('TargetGroup'));
    targetAcro.set('DR', formResources('Shared', 'Helvetica'));
    formDictionary(source).set('DR', formResources('Shared', 'Courier'));
    const before = await serializeDocument(target);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/conflicting AcroForm resource Font/);
    expect(await serializeDocument(target)).toEqual(before);
    expect(target.pages).toHaveLength(2);
  });

  it('renames an imported duplicate root and retains independent values and editable widgets', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const beforeSource = await serializeDocument(source);
    const renamed = insertPagesFromDocument(target, source, 1);
    expect(renamed).toEqual(expect.arrayContaining([
      { from: 'Group', to: 'Group_2' },
      { from: 'Group.A', to: 'Group_2.A' },
      { from: 'Group.B', to: 'Group_2.B' },
    ]));
    expect(await serializeDocument(source)).toEqual(beforeSource);
    const form = await independent(await serializeDocument(target));
    expect(form.getFields().map(field => field.getName()).sort()).toEqual(['Group.A', 'Group.B', 'Group_2.A', 'Group_2.B']);
    expect(form.getTextField('Group.A').getText()).toBe('first value');
    expect(form.getTextField('Group_2.A').getText()).toBe('first value');
    form.getTextField('Group_2.A').setText('independent');
    const reopened = await independent(await form.doc.save({ useObjectStreams: false }));
    expect(reopened.getTextField('Group.A').getText()).toBe('first value');
    expect(reopened.getTextField('Group_2.A').getText()).toBe('independent');
  });

  it('recognizes equivalent Unicode root names across PDF text-string encodings', async () => {
    const make = async (value: string) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([200, 200]);
      const field = pdf.getForm().createTextField('姓名.甲');
      field.setText(value);
      field.addToPage(page);
      return parsePDF(await pdf.save({ useObjectStreams: false }));
    };
    const target = await make('first');
    const source = await make('second');
    const targetRoot = formDictionary(target).getArray('Fields')!.items[0] as PDFRef;
    (target.objects.get(targetRoot.toKey()) as PDFDict).set('T', PDFString.fromText('姓名'));
    insertPagesFromDocument(target, source, 1);
    const form = await independent(await serializeDocument(target));
    expect(form.getTextField('姓名.甲').getText()).toBe('first');
    expect(form.getTextField('姓名_2.甲').getText()).toBe('second');
  });

  it('chooses an unused root name across repeated imports', async () => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    insertPagesFromDocument(target, source, 2);
    const renamed = insertPagesFromDocument(target, source, 4);
    expect(renamed).toContainEqual({ from: 'Group.A', to: 'Group_3.A' });
    const form = await independent(await serializeDocument(target));
    expect(form.getFields().map(field => field.getName())).toContain('Group_3.A');
  });

  it.each(['action', 'field-action', 'target-action', 'calculation', 'xfa', 'target-xfa', 'shared', 'shared-child'])('rejects %s references before renaming any fields', async kind => {
    const target = await sourceFixture();
    const source = await sourceFixture();
    const acro = formDictionary(source);
    const root = acro.getArray('Fields')!.items[0] as PDFRef;
    if (kind === 'field-action') (source.objects.get(root.toKey()) as PDFDict).set('AA', new PDFDict());
    if (kind === 'target-action') target.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('script')]]));
    if (kind === 'target-xfa') formDictionary(target).set('XFA', new PDFString('data'));
    if (kind === 'action') source.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('this.getField("Group.A")')]]));
    if (kind === 'calculation') acro.set('CO', new PDFArray([root]));
    if (kind === 'xfa') acro.set('XFA', new PDFString('data'));
    if (kind === 'shared') source.catalog.set('Unrelated', root);
    if (kind === 'shared-child') {
      const rootDict = source.objects.get(root.toKey()) as PDFDict;
      source.catalog.set('Unrelated', rootDict.getArray('Kids')!.items[0]);
    }
    const beforeTarget = await serializeDocument(target);
    const beforeSource = await serializeDocument(source);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/conflict|safely/i);
    expect(await serializeDocument(target)).toEqual(beforeTarget);
    expect(await serializeDocument(source)).toEqual(beforeSource);
  });
});
