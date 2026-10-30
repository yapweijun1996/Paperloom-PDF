import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { saveQuick } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';

const marked = { x: 15, y: 75, width: 210, height: 50 };

async function fixture() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([500, 500]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('fixture', { font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const pdfPage = doc.pages[0], fonts = pdfPage.resources.getDict('Font')!;
  const fontName = [...fonts.keys()][0], resources = new PDFDict([['Font', fonts]]);
  pdfPage.dict.set('Resources', resources);
  pdfPage.resources = resources;
  const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
  const refs = [pdfPage.contentRefs[0], new PDFRef(next, 0), new PDFRef(next + 1, 0)];
  ['SECRET', 'PRIVATE', 'VISIBLE'].forEach((text, index) => {
    const x = index === 2 ? 280 : 40, y = index === 2 ? 300 : 100;
    const bytes = new TextEncoder().encode(`q BT 0 g /${fontName} 10 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET Q\n`);
    doc.objects.set(refs[index].toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
  });
  pdfPage.dict.set('Contents', new PDFArray(refs));
  pdfPage.contentRefs.splice(0, pdfPage.contentRefs.length, ...refs);
  return parsePDF(await serializeDocument(doc));
}

function indirectContents(doc: Awaited<ReturnType<typeof fixture>>) {
  const page = doc.pages[0], array = page.dict.getArray('Contents')!;
  const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
  const arrayRef = new PDFRef(next, 0);
  doc.objects.set(arrayRef.toKey(), array);
  page.dict.set('Contents', arrayRef);
}

describe('redaction content-alias safety', () => {
  it.each(['middle array alias', 'stream alias', 'retained stream alias', 'retained stream'] as const)(
    'rejects %s without mutation', async mode => {
      const doc = await fixture(), page = doc.pages[0], array = page.dict.getArray('Contents')!;
      const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
      const streamAlias = new PDFRef(next, 0), arrayRef = new PDFRef(next + 1, 0), arrayAlias = new PDFRef(next + 2, 0);
      const target = mode.startsWith('retained') ? page.contentRefs[2] : page.contentRefs[0];
      doc.objects.set(streamAlias.toKey(), target);
      if (mode === 'stream alias' || mode === 'retained stream alias') {
        array.items[mode === 'retained stream alias' ? 2 : 0] = streamAlias;
      }
      doc.objects.set(arrayRef.toKey(), array);
      doc.objects.set(arrayAlias.toKey(), arrayRef);
      page.dict.set('Contents', mode === 'middle array alias' ? arrayAlias : arrayRef);
      const annotation = redactionEngine.markRegion(doc, 0, marked);
      (doc.objects.get(annotation.toKey()) as PDFDict).set('Shared',
        mode === 'middle array alias' ? arrayRef : mode === 'retained stream' ? target : streamAlias);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(mode === 'retained stream' ? /shared/ : /alias/);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('replaces an edited terminal stream referenced by a removed mark', async () => {
    const doc = await fixture(), page = doc.pages[0];
    indirectContents(doc);
    const annotation = redactionEngine.markRegion(doc, 0, marked);
    (doc.objects.get(annotation.toKey()) as PDFDict).set('Shared', page.contentRefs[0]);
    expect(prepareIsolatedTextRedaction(doc).commit().textOperatorsRemoved).toBe(2);
    const output = await saveQuick(doc), reopened = await parsePDF(output);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('VISIBLE');
    expect(Buffer.from(output).toString('latin1')).not.toMatch(/SECRET|PRIVATE/);
    expect((await PDFDocument.load(output, { updateMetadata: false })).getPageCount()).toBe(1);
  });

  it.each(['text', 'other key', 'other text'] as const)('rejects unverified mark data (%s) without mutation', async mode => {
    const doc = await fixture(), page = doc.pages[0];
    indirectContents(doc);
    const annotation = redactionEngine.markRegion(doc, 0, marked);
    const mark = doc.objects.get(annotation.toKey()) as PDFDict;
    if (mode === 'text') mark.set('Shared', new PDFString('PRIVATE_NOTE'));
    else mark.set('Other', mode === 'other key' ? page.contentRefs[0] : new PDFString('PRIVATE_NOTE'));
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/annotation metadata cannot be inspected/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects retained page data referencing an edited stream through another alias', async () => {
    const doc = await fixture(), page = doc.pages[0];
    indirectContents(doc);
    const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
    const alternate = new PDFRef(next, 0);
    doc.objects.set(alternate.toKey(), page.contentRefs[0]);
    page.dict.set('Tabs', alternate);
    redactionEngine.markRegion(doc, 0, marked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['Contents', 'Other'] as const)(
    'rejects a second mark containing %s when another mark shares edited content', async key => {
      const doc = await fixture(), page = doc.pages[0];
      const first = redactionEngine.markRegion(doc, 0, marked);
      const second = redactionEngine.markRegion(doc, 0, marked);
      (doc.objects.get(first.toKey()) as PDFDict).set('Shared', page.contentRefs[0]);
      (doc.objects.get(second.toKey()) as PDFDict).set(key, new PDFString('PRIVATE_NOTE'));
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/annotation metadata cannot be inspected/);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('safely replaces the edited streams shared by multiple marks', async () => {
    const doc = await fixture(), page = doc.pages[0];
    const first = redactionEngine.markRegion(doc, 0, marked);
    const second = redactionEngine.markRegion(doc, 0, marked);
    (doc.objects.get(first.toKey()) as PDFDict).set('Shared', page.contentRefs[0]);
    (doc.objects.get(second.toKey()) as PDFDict).set('Shared', page.contentRefs[1]);
    expect(prepareIsolatedTextRedaction(doc).commit().textOperatorsRemoved).toBe(2);
    const output = await saveQuick(doc);
    expect(Buffer.from(output).toString('latin1')).not.toMatch(/SECRET|PRIVATE/);
    expect((await PDFDocument.load(output, { updateMetadata: false })).getPageCount()).toBe(1);
  });
});
