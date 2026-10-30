import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFHexString, PDFRef, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { preparePartialGraphicsRedaction } from '../security/redaction/partial-graphics-redaction';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

async function fixture(field: string, value: PDFString | PDFHexString = new PDFString('PRIVATE_NOTE')) {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);
  const mark = redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
  (doc.objects.get(mark.toKey()) as PDFDict).set(field, value);
  return { doc, info, mark };
}

describe('redaction mark metadata', () => {
  it.each(['Contents', 'T', 'M', 'NM', 'OverlayText', 'Subj', 'CreationDate'])(
    'rejects a retained copy of /%s after loading a real PDF, without mutation', async field => {
      const { doc, info } = await fixture(field);
      info.set('Title', new PDFString('PRIVATE_NOTE'));
      const input = await serializeDocument(doc);
      const loaded = await parsePDF(input);
      const before = await serializeDocument(loaded);
      expect(() => prepareWholePageRedaction(loaded)).toThrow(/retained data contains removed annotation text/i);
      await expect(redactionEngine.applySecureRedactions(loaded)).rejects.toThrow();
      expect(await serializeDocument(loaded)).toEqual(before);
      const independentlyOpened = await PDFDocument.load(before, { updateMetadata: false });
      expect(independentlyOpened.getTitle()).toBe('PRIVATE_NOTE');
    });

  it('removes mark metadata when no copy remains, and saved PDF independently reopens', async () => {
    const { doc } = await fixture('Contents');
    const loaded = await parsePDF(await serializeDocument(doc));
    expect(prepareWholePageRedaction(loaded).commit().annotationsRemoved).toBe(1);
    const bytes = await saveQuick(loaded);
    expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE_NOTE');
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(reopened.getPage(0).node.Annots()).toBeUndefined();
  });

  it.each(['ordered', 'reordered', 'utf16'] as const)(
    'rejects retained mark text split across metadata fields (%s)', async mode => {
      const { doc, info } = await fixture('Contents');
      if (mode === 'utf16') {
        info.set('Title', new PDFHexString('FEFF0050005200490056004100540045005F'));
        info.set('Author', new PDFHexString('FEFF004E004F00540045'));
      } else {
        info.set('Title', new PDFString(mode === 'ordered' ? 'PRIVATE_' : 'NOTE'));
        info.set('Author', new PDFString(mode === 'ordered' ? 'NOTE' : 'PRIVATE_'));
      }
      const loaded = await parsePDF(await serializeDocument(doc));
      const before = await serializeDocument(loaded);
      expect(() => prepareWholePageRedaction(loaded)).toThrow(/retained data contains removed annotation text/i);
      await expect(redactionEngine.applySecureRedactions(loaded)).rejects.toThrow();
      expect(await serializeDocument(loaded)).toEqual(before);
      const reopened = await PDFDocument.load(before, { updateMetadata: false });
      expect([reopened.getTitle(), reopened.getAuthor()].sort()).toEqual(['NOTE', 'PRIVATE_'].sort());
    });

  it('rejects shared references and uninspectable mark fields before mutation', async () => {
    for (const mode of ['shared', 'utf16', 'unknown'] as const) {
      const { doc, mark } = await fixture('Contents');
      const dict = doc.objects.get(mark.toKey()) as PDFDict;
      if (mode === 'shared') {
        const ref = new PDFRef(900, 0);
        doc.objects.set(ref.toKey(), new PDFString('PRIVATE_NOTE'));
        dict.set('Contents', ref);
        doc.catalog.set('Shared', ref);
      } else if (mode === 'utf16') dict.set('Contents', new PDFHexString('FEFF0050005200490056004100540045'));
      else dict.set('RC', new PDFString('PRIVATE_NOTE'));
      const before = await serializeDocument(doc);
      expect(() => prepareWholePageRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
    }
  });

  it('cannot fall back to partial redaction when a mark contains unchecked text', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.pages[0].resources = new PDFDict();
    doc.pages[0].dict.set('Resources', doc.pages[0].resources);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('20 20 10 10 re f'), doc.objects, false);
    const mark = redactionEngine.markRegion(doc, 0, { x: 15, y: 15, width: 20, height: 20 });
    (doc.objects.get(mark.toKey()) as PDFDict).set('Contents', new PDFString('PRIVATE_NOTE'));
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', new PDFString('PRIVATE_NOTE'));
    const loaded = await parsePDF(await serializeDocument(doc));
    const before = await serializeDocument(loaded);
    expect(() => preparePartialGraphicsRedaction(loaded)).toThrow(/annotation/i);
    expect(() => prepareIsolatedTextRedaction(loaded)).toThrow();
    await expect(redactionEngine.applySecureRedactions(loaded)).rejects.toThrow();
    expect(await serializeDocument(loaded)).toEqual(before);
  });
});

describe('whole-page text copied into separate metadata fields', () => {
  async function documentWithText() {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('BT (PRIVATE_NOTE) Tj ET'), doc.objects, false);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    for (const key of [...info.keys()]) info.delete(key);
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    return { doc, info };
  }

  it.each(['ordered', 'reordered', 'utf16', 'three', 'single'] as const)(
    'rejects the independently reopened input with %s split text without mutation', async mode => {
      const { doc, info } = await documentWithText();
      if (mode === 'utf16') {
        info.set('Title', new PDFHexString('FEFF0050005200490056004100540045005F'));
        info.set('Author', new PDFHexString('FEFF004E004F00540045'));
      } else if (mode === 'three') {
        info.set('Title', new PDFString('PRI'));
        info.set('Author', new PDFString('VATE_'));
        info.set('Subject', new PDFString('NOTE'));
      } else if (mode === 'single') {
        info.set('Title', new PDFString('P'));
        info.set('Author', new PDFString('RIVATE_NOTE'));
      } else {
        info.set('Title', new PDFString(mode === 'ordered' ? 'PRIVATE_' : 'NOTE'));
        info.set('Author', new PDFString(mode === 'ordered' ? 'NOTE' : 'PRIVATE_'));
      }
      const input = await serializeDocument(doc);
      const original = await PDFDocument.load(input, { updateMetadata: false });
      const pieces = [original.getTitle(), original.getAuthor(), original.getSubject()].filter(Boolean).join('');
      expect(pieces.length).toBe('PRIVATE_NOTE'.length);
      const loaded = await parsePDF(input);
      const before = await serializeDocument(loaded);
      expect(() => prepareWholePageRedaction(loaded)).toThrow(/retained data contains removed text/i);
      await expect(redactionEngine.applySecureRedactions(loaded)).rejects.toThrow();
      expect(await serializeDocument(loaded)).toEqual(before);
      const reopened = await PDFDocument.load(before, { updateMetadata: false });
      expect([reopened.getTitle(), reopened.getAuthor(), reopened.getSubject()].filter(Boolean).join('')).toBe(pieces);
    });

  it('allows unrelated metadata and reopens a successful output', async () => {
    const { doc, info } = await documentWithText();
    info.set('Title', new PDFString('UNRELATED'));
    info.set('Author', new PDFString('publisher'));
    const loaded = await parsePDF(await serializeDocument(doc));
    expect(prepareWholePageRedaction(loaded).commit().pagesCleared).toBe(1);
    const output = await saveQuick(loaded);
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    expect(reopened.getTitle()).toBe('UNRELATED');
    expect(reopened.getAuthor()).toBe('publisher');
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_NOTE');
  });

  it('rejects retained text inspection beyond the byte budget before mutation', async () => {
    const { doc, info } = await documentWithText();
    info.set('Title', new PDFString('z'.repeat(262_145)));
    const loaded = await parsePDF(await serializeDocument(doc));
    const before = await serializeDocument(loaded);
    expect(() => prepareWholePageRedaction(loaded)).toThrow(/inspection limit/i);
    expect(await serializeDocument(loaded)).toEqual(before);
  });
});
